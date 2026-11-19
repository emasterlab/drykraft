import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace,saveRecord,addActivity} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
import {validateGraph,interpolate,workflowNoteSchema,validateWorkflowNote} from '../server/automation.mjs';
const node=(id,kind,data={})=>({id,type:'workflow',position:{x:0,y:0},data:{kind,label:id,...data}});
const graph=data=>({nodes:[node('t','trigger.manual'),node('note','crm.note',data)],edges:[{id:'e',source:'t',target:'note'}]});
function call(path,cookie,body,method=body?'POST':'GET'){return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('native notes validate publication, resolved text, workspace ownership, aliases and transactional activity events',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=[randomUUID(),randomUUID()],tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t);
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();const records=[];
 try{
  for(const [i,tenant]of tenants.entries())await tenantTransaction(tenant,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic workflow note QA','note-'+tenant.slice(0,8)]);await initializeWorkspace(c,tenant);await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic note member',users[i]+'@example.test','unused']);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenant,users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenant]);records.push(await saveRecord(c,tenant,users[i],'people',{name:i?'Outside note contact':'Sample note contact'}));});
  const data={recordId:'{{record.id}}',note:'Follow up with {{record.data.name}}'};assert.equal(validateGraph(graph(data)).nodes.length,2);
  for(const bad of [{...data,recordId:'not a uuid'},{...data,recordId:'prefix {{record.id}}'},{...data,recordId:'{{constructor.id}}'},{...data,recordId:'{{record.__proto__.id}}'},{...data,note:'   '},{...data,note:'x'.repeat(10001)},{...data,note:123}])assert.throws(()=>validateGraph(graph(bad)));
  assert.throws(()=>validateWorkflowNote({...data,recordId:'bad'}),/record UUID or an exact context expression/);assert.throws(()=>validateWorkflowNote({...data,note:' '}),/nonempty plain text/);assert.throws(()=>validateWorkflowNote(data,true),/must resolve to a record UUID/);assert.throws(()=>validateWorkflowNote({...data,recordId:records[0].id,note:interpolate('{{value}}',{value:42})},true),/nonempty plain text/);
  const uuidStep=randomUUID(),uuidContext={nodes:{[uuidStep]:{id:records[0].id,name:'Sample UUID step'}}},uuidExpression='{{nodes.'+uuidStep+'.id}}';assert.equal(validateGraph(graph({...data,recordId:uuidExpression})).nodes.length,2);assert.equal(interpolate(uuidExpression,uuidContext),records[0].id);assert.equal(interpolate('Note for {{nodes.'+uuidStep+'.name}}',uuidContext),'Note for Sample UUID step');assert.equal(interpolate('{{nodes.__proto__.id}}',uuidContext),'');
  assert.equal(workflowNoteSchema.parse({...data,recordId:records[0].id}).recordId,records[0].id);
  const tx=fn=>tenantTransaction(tenants[0],fn);
  const note=await tx(c=>addActivity(c,tenants[0],null,{record_id:interpolate(data.recordId,{record:records[0]}),body:interpolate(data.note,{record:records[0]})}));assert.equal(note.record_id,records[0].id);assert.equal(note.type,'note');assert.equal(note.body,'Follow up with Sample note contact');assert.equal(note.actor_id,null);
  assert.equal((await tx(c=>c.query("SELECT count(*)::int AS n FROM outbox WHERE type='crm.activity.created' AND data->'activity'->>'id'=$1",[note.id]))).rows[0].n,1);
  for(const body of ['', '   ', 'x'.repeat(10001), 123, {text:'wrong type'}])await assert.rejects(tx(c=>addActivity(c,tenants[0],null,{record_id:records[0].id,body})));
  await assert.rejects(tx(c=>addActivity(c,tenants[0],null,{record_id:records[1].id,body:'Must not leak'})),/not found/);
  await assert.rejects(tx(c=>addActivity(c,tenants[0],null,{record_id:randomUUID(),body:'Missing target'})),/not found/);
  await assert.rejects(tx(async c=>{await addActivity(c,tenants[0],null,{record_id:records[0].id,body:'Rolled back note'});throw new Error('Synthetic rollback');}),/Synthetic rollback/);
  assert.equal((await tx(c=>c.query('SELECT count(*)::int AS n FROM activities'))).rows[0].n,1,'Rejected and rolled-back notes create no activity');
  assert.equal((await tx(c=>c.query("SELECT count(*)::int AS n FROM outbox WHERE type='crm.activity.created'"))).rows[0].n,1,'Rolled-back note event is absent');
  const alias=await tx(async c=>{const r=await saveRecord(c,tenants[0],users[0],'people',{name:'Merged sample note contact'});await c.query('UPDATE records SET merged_into=$1 WHERE id=$2',[records[0].id,r.id]);return r;});const merged=await tx(c=>addActivity(c,tenants[0],null,{record_id:alias.id,body:'  Canonical internal note  '}));assert.equal(merged.record_id,records[0].id);assert.equal(merged.body,'Canonical internal note');
  const w=(await call('/workflows',cookies[0],{name:'Synthetic note publication'})).data;
  async function publish(settings){assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:graph(settings)},'PUT')).status,200);return call('/workflows/'+w.id+'/publish',cookies[0],{});}
  assert.equal((await publish({...data,recordId:records[0].id})).status,200);assert.equal((await publish({...data,recordId:alias.id})).status,200);assert.equal((await publish({...data,recordId:records[1].id})).status,404);assert.equal((await publish({...data,recordId:randomUUID()})).status,404);assert.equal((await publish({...data,note:' '})).status,400);assert.equal((await publish(data)).status,200);
  await tx(c=>c.query("UPDATE memberships SET role='member' WHERE user_id=$1",[users[0]]));assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:graph(data)},'PUT')).status,200);assert.equal((await call('/workflows/'+w.id+'/publish',cookies[0],{})).status,403);
  await tx(c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:graph(data)},'PUT')).status,403);assert.equal((await call('/workflows/'+w.id+'/versions',cookies[1])).data.length,0);
 }finally{
  for(const tenant of tenants){for(const table of ['outbox','executions','workflows','activities','record_links','records','record_lists','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();await pool.end();
 }
});
