import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
const origin=process.env.TEST_API_ORIGIN || 'http://localhost:4000';
function call(path,method='GET',body,cookie=''){return new Promise((resolve,reject)=>{const req=http.request(origin+'/api'+path,{method,headers:{'content-type':'application/json',...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{}),cookie}},res=>{const bytes=[];res.on('data',b=>bytes.push(b));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(bytes))}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('User fields validate tenant membership across record, CSV, bulk and Finance paths and preserve departed history',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=Array.from({length:32},()=>randomUUID()),tokens=[0,1,31].map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t);
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();let lock;
 try{
  for(const [i,t]of tenants.entries())await tenantTransaction(t,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[t,'Synthetic User field QA','userfield-'+t.slice(0,8)]);await initializeWorkspace(c,t);for(const j of i===0?Array.from({length:31},(_,j)=>j):[31]){await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[j],j===31?'Outside private name':`Synthetic teammate ${String(j).padStart(2,'0')}`,users[j]+'@example.test','unused']);await c.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[t,users[j],j===0 || j===31?'owner':j===1?'viewer':'member']);const k=[0,1,31].indexOf(j);if(k>=0)await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[k]),users[j],t]);}});
  assert.equal((await call('/settings/member-options')).status,401);
  const first=await call('/settings/member-options?selected='+users[31],'GET',null,cookies[1]);assert.equal(first.status,200);assert.equal(first.data.items.length,25);assert.equal(first.data.selected,null);assert.ok(!JSON.stringify(first.data).includes('Outside private name'));assert.deepEqual(Object.keys(first.data.items[0]).sort(),['id','name']);
  const second=await call('/settings/member-options?cursor='+first.data.next_cursor,'GET',null,cookies[0]);assert.equal(second.data.items.length,6);assert.equal(second.data.next_cursor,null);assert.equal(new Set([...first.data.items,...second.data.items].map(u=>u.id)).size,31);
  assert.equal((await call('/settings/member-options?search=%25','GET',null,cookies[0])).data.items.length,0);
  const found=await call('/settings/member-options?search=teammate%2002&selected='+users[0],'GET',null,cookies[0]);assert.equal(found.data.items[0].id,users[2]);assert.equal(found.data.selected.id,users[0]);
  assert.equal((await call('/settings/member-options?selected=not-uuid','GET',null,cookies[0])).status,400);
  const object={key:'assignments',name:'Assignments',singular_name:'Assignment',fields:[{key:'name',name:'Name',type:'text',required:true},{key:'assignee',name:'Assignee',type:'user',required:true},{key:'reviewer',name:'Reviewer',type:'user',required:false}]};
  assert.equal((await call('/objects','POST',object,cookies[1])).status,403);assert.equal((await call('/objects','POST',object,cookies[0])).status,201);
  for(const assignee of [undefined,'not-uuid','Synthetic teammate 02',users[31]])assert.equal((await call('/records/assignments','POST',{data:{name:'Invalid assignment',assignee}},cookies[0])).status,400);
  const made=await call('/records/assignments','POST',{data:{name:'Synthetic assigned item',assignee:users[2],reviewer:users[3]}},cookies[0]);assert.equal(made.status,201);let record=made.data;
  const read=await call('/records/assignments/'+record.id,'GET',null,cookies[1]);assert.equal(read.data.user_names.assignee,'Synthetic teammate 02');assert.equal(read.data.data.assignee,users[2]);
  assert.equal((await call('/records/assignments/'+record.id,'GET',null,cookies[2])).status,404);
  const filtered=await call('/records/assignments?filter='+encodeURIComponent(JSON.stringify({match:'all',conditions:[{field:'assignee',operator:'eq',value:users[2]}]})),'GET',null,cookies[0]);assert.equal(filtered.data.total,1);assert.equal(filtered.data.items[0].user_names.reviewer,'Synthetic teammate 03');
  const invalidFilter=await call('/records/assignments?filter='+encodeURIComponent(JSON.stringify({match:'all',conditions:[{field:'assignee',operator:'contains',value:users[2]}]})),'GET',null,cookies[0]);assert.equal(invalidFilter.status,400);
  let csv=`name,assignee\r\nSynthetic CSV assignment,${users[31]}\r\n`;
  assert.equal((await call('/record-tools/assignments/import/preview','POST',{csv},cookies[0])).data.can_import,false);
  assert.equal((await call('/record-tools/assignments/import/commit','POST',{csv,id:randomUUID()},cookies[0])).status,400);
  csv=`name,assignee\r\nSynthetic CSV assignment,${users[1]}\r\n`;
  assert.equal((await call('/record-tools/assignments/import/preview','POST',{csv},cookies[0])).data.can_import,true);
  assert.equal((await call('/record-tools/assignments/import/commit','POST',{csv,id:randomUUID()},cookies[0])).data.created,1);
  assert.equal((await call('/record-tools/assignments/bulk','POST',{action:'update',records:[{id:record.id,version:record.version}],data:{assignee:users[31]}},cookies[0])).status,400);
  assert.equal((await call('/record-tools/assignments/bulk','POST',{action:'update',records:[{id:record.id,version:record.version}],data:{assignee:users[1]}},cookies[0])).data.changed,1);
  record=(await call('/records/assignments/'+record.id,'GET',null,cookies[0])).data;assert.equal(record.data.assignee,users[1]);
  assert.equal((await call('/objects/invoices/fields','POST',{key:'coordinator',name:'Coordinator',type:'user'},cookies[0])).status,200);
  const invoiceData={name:'Synthetic user-field invoice',customer_name:'Synthetic customer',currency:'USD',issue_date:'2026-10-03',due_date:'2026-10-04',items:[{description:'Sample work',quantity:'1',unit_price:'1',discount:'0',tax_rate:'0'}],coordinator:users[3]};
  assert.equal((await call('/finance/invoices','POST',{data:{...invoiceData,coordinator:users[31]}},cookies[0])).status,400);
  const invoice=(await call('/finance/invoices','POST',{data:invoiceData},cookies[0])).data;assert.ok(invoice.id);
  assert.equal((await call('/settings/members/'+users[3]+'?version=1','DELETE',null,cookies[0])).status,200);
  assert.equal((await call('/settings/member-options?selected='+users[3],'GET',null,cookies[0])).data.selected,null);
  record=(await call('/records/assignments/'+record.id,'GET',null,cookies[0])).data;assert.equal(record.user_names.reviewer,'Former member');
  assert.equal((await call('/records/assignments/'+record.id,'PUT',{data:{...record.data,name:'Updated with preserved history'},version:record.version},cookies[0])).status,200);
  assert.equal((await call('/records/assignments','POST',{data:{name:'Copy former member',assignee:users[3]}},cookies[0])).status,400);
  assert.equal((await call('/finance/invoices/'+invoice.id,'PUT',{data:{...invoiceData,notes:'Preserve departed assignment'},version:invoice.version},cookies[0])).status,200);
  assert.equal((await call('/finance/invoices','POST',{data:invoiceData},cookies[0])).status,400);
  // A new assignment waits for concurrent membership removal, then rejects the departed member.
  lock=await pool.connect();await lock.query('BEGIN');await lock.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',[tenants[0],users[4]]);
  let done=false;const pending=call('/records/assignments','POST',{data:{name:'Concurrent removal',assignee:users[4]}},cookies[0]).then(r=>{done=true;return r;});
  let waiting=false;for(let i=0;i<50;i++){const r=await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT user_id FROM memberships WHERE tenant_id=%' LIMIT 1");if(r.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);assert.equal(done,false);
  await lock.query('COMMIT');lock.release();lock=null;assert.equal((await pending).status,400);
 }finally{
  if(lock){await lock.query('ROLLBACK');lock.release();}
  for(const t of tenants){for(const table of ['records','object_definitions','pipelines','dashboards','outbox','audit_events','usage_ledger','workspace_billing','record_imports','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[t]);await admin.query('DELETE FROM workspaces WHERE id=$1',[t]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();
 }
});
test.after(()=>pool.end());
