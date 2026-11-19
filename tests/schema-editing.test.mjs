import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace,editDefinition,saveRecord,getDefinition} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
const origin=process.env.TEST_API_ORIGIN || 'http://localhost:4000';
function call(path,method='GET',body,cookie=''){return new Promise((resolve,reject)=>{const req=http.request(origin+'/api'+path,{method,headers:{'content-type':'application/json',...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{}),cookie}},res=>{const bytes=[];res.on('data',b=>bytes.push(b));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(bytes))}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('schema edits preserve data, enforce current rules, isolate tenants and serialize record writes',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=[randomUUID(),randomUUID(),randomUUID()],tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t);
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 const tx=fn=>tenantTransaction(tenants[0],fn);let lock;
 try{
  for(const [i,t]of tenants.entries())await tenantTransaction(t,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[t,'Synthetic schema editing','schema-'+t.slice(0,8)]);await initializeWorkspace(c,t);for(const j of i===0?[0,1]:[2]){await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[j],'Synthetic schema user',users[j]+'@example.test','unused']);await c.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[t,users[j],j===1?'viewer':'owner']);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[j]),users[j],t]);}});
  const object={key:'projects',name:'Projects',singular_name:'Project',fields:[{key:'name',name:'Name',type:'text',required:true},{key:'phase',name:'Phase',type:'select',required:false,options:['New','Active']},{key:'tags',name:'Project tags',type:'multi_select',required:false,options:['A','B']}]};
  assert.equal((await call('/objects','POST',object,cookies[0])).status,201);
  const edit={name:'Client projects',singular_name:'Client project',previous:{name:object.name,singular_name:object.singular_name}};
  assert.equal((await call('/objects/projects','PUT',edit)).status,401);
  assert.equal((await call('/objects/projects','PUT',edit,cookies[1])).status,403);
  assert.equal((await call('/objects/projects','PUT',edit,cookies[2])).status,404);
  assert.equal((await call('/objects/projects','PUT',edit,cookies[0])).data.name,'Client projects');
  assert.equal((await call('/objects/projects','PUT',edit,cookies[0])).status,200);
  assert.equal((await call('/objects/projects','PUT',{...edit,name:'Stale overwrite'},cookies[0])).status,409);
  const field=object.fields[1],required={...field,name:'Delivery phase',required:true};
  const record=(await call('/records/projects','POST',{data:{name:'Synthetic project',tags:['A','B']}},cookies[0])).data;
  assert.equal((await call('/objects/projects/fields/phase','PUT',{field:required,previous:field},cookies[0])).status,409);
  assert.equal((await call('/records/projects/'+record.id,'PUT',{data:{...record.data,phase:'Active'},version:record.version},cookies[0])).status,200);
  assert.equal((await call('/objects/projects/fields/phase','PUT',{field:required,previous:field},cookies[0])).status,200);
  assert.equal((await call('/records/projects','POST',{data:{name:'Missing phase'}},cookies[0])).status,400);
  assert.equal((await call('/objects/projects/fields/phase','PUT',{field:{...required,options:['New']},previous:required},cookies[0])).status,409);
  const narrowed={...required,options:['Active','Complete']};
  assert.equal((await call('/objects/projects/fields/phase','PUT',{field:narrowed,previous:required},cookies[0])).status,200);
  assert.equal((await call('/objects/projects/fields/phase','PUT',{field:{...required,name:'Old edit'},previous:required},cookies[0])).status,409);
  assert.equal((await call('/objects/projects/fields/phase','PUT',{field:{...narrowed,type:'number'},previous:narrowed},cookies[0])).status,400);
  assert.equal((await call('/objects/projects/fields/tags','PUT',{field:{...object.fields[2],options:['A']},previous:object.fields[2]},cookies[0])).status,409);
  const defs=(await call('/objects','GET',undefined,cookies[0])).data,people=defs.find(d=>d.key==='people'),name=people.fields.find(f=>f.key==='name');assert.ok(people.managed_field_keys.includes('name'));
  assert.equal((await call('/objects/people/fields/name','PUT',{field:{...name,name:'Customer name'},previous:name},cookies[0])).status,200);
  assert.equal((await call('/objects/people/fields/name','PUT',{field:{...name,name:'Customer name',required:false},previous:{...name,name:'Customer name'}},cookies[0])).status,400);
  assert.equal((await call('/objects/invoices/fields','POST',{key:'document_template',name:'Collision',type:'json'},cookies[0])).status,400);
  const saved=(await call('/records/projects/'+record.id,'GET',undefined,cookies[0])).data;assert.deepEqual(saved.data,{name:'Synthetic project',tags:['A','B'],phase:'Active'});assert.equal(saved.version,2);
  // An old schema cannot authorize a record while the rule change commits.
  lock=await pool.connect();await lock.query('BEGIN');await lock.query("SELECT set_config('app.tenant_id',$1,true)",[tenants[0]]);await lock.query("SELECT key FROM object_definitions WHERE key='projects' FOR UPDATE");
  let done=false;const pending=tx(c=>saveRecord(c,tenants[0],users[0],'projects',{name:'Old option',phase:'Complete'})).then(()=>{done=true;return null;},error=>{done=true;return error;});
  let waiting=false;for(let i=0;i<30;i++){const result=await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM object_definitions WHERE key=%' LIMIT 1");if(result.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);assert.equal(done,false);
  await editDefinition(lock,tenants[0],users[0],'projects',{field:{...narrowed,options:['Active']},previous:narrowed},'phase');
  await lock.query('COMMIT');lock.release();lock=null;assert.equal((await pending).status,400);
  const audit=await tx(c=>c.query("SELECT action FROM audit_events WHERE action LIKE 'schema.%'"));assert.equal(audit.rowCount,5);
  assert.equal((await tenantTransaction(tenants[1],c=>getDefinition(c,'people'))).fields.find(f=>f.key==='name').name,'Full name');
 }finally{
  if(lock){await lock.query('ROLLBACK');lock.release();}
  for(const t of tenants){for(const table of ['records','object_definitions','pipelines','dashboards','outbox','audit_events','usage_ledger','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[t]);await admin.query('DELETE FROM workspaces WHERE id=$1',[t]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();
 }
});
test.after(()=>pool.end());
