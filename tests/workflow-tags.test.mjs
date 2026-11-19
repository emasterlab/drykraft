import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace,saveRecord,changeContactTags} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
import {validateGraph,validateWorkflowTags,interpolate} from '../server/automation.mjs';
const node=(id,kind,data={})=>({id,type:'workflow',position:{x:0,y:0},data:{kind,label:id,...data}});
const graph=data=>({nodes:[node('t','trigger.manual'),node('tags','crm.tags',data)],edges:[{id:'e',source:'t',target:'tags'}]});
function call(path,cookie,body,method=body?'POST':'GET'){return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('contact tag actions preserve concurrent changes, emit shared deltas only for changes and enforce publication boundaries',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=[randomUUID(),randomUUID()],tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t),records=[];
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(const [i,tenant]of tenants.entries())await tenantTransaction(tenant,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic workflow tag QA','tags-'+tenant.slice(0,8)]);await initializeWorkspace(c,tenant);await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic tag member',users[i]+'@example.test','unused']);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenant,users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenant]);records.push(await saveRecord(c,tenant,users[i],'people',{name:'Synthetic tag contact',tags:['Keep']}));});
  const tx=fn=>tenantTransaction(tenants[0],fn),data={recordId:'{{record.id}}',operation:'add',tags:'Interested\nFollow-up'};
  assert.equal(validateGraph(graph(data)).nodes.length,2);assert.deepEqual(validateWorkflowTags(data).tags,['Interested','Follow-up']);
  for(const bad of [{...data,recordId:'invalid'},{...data,recordId:'{{record.__proto__.id}}'},{...data,operation:'replace'},{...data,tags:''},{...data,tags:['']},{...data,tags:Array(101).fill('Tag')},{...data,tags:'{{constructor.tags}}'}])assert.throws(()=>validateGraph(graph(bad)));
  for(const tags of [[],[' '],[123],['a'.repeat(81)],'Tag',{}])assert.throws(()=>validateWorkflowTags({...data,recordId:records[0].id,tags},true));
  const step=randomUUID(),source='{{nodes.'+step+'.tags}}';assert.equal(validateWorkflowTags({...data,tags:source}).tags,source);assert.deepEqual(validateWorkflowTags({...data,recordId:records[0].id,tags:interpolate(source,{nodes:{[step]:{tags:['Typed array']}}})},true).tags,['Typed array']);
  const first=await tx(c=>changeContactTags(c,tenants[0],users[0],records[0].id,'add',[' Interested ','Interested','Follow-up']));assert.deepEqual(first.after,['Keep','Interested','Follow-up']);assert.deepEqual(first.added,['Interested','Follow-up']);assert.equal(first.changed,true);
  const unchanged=await tx(c=>changeContactTags(c,tenants[0],null,records[0].id,'add',['Interested']));assert.equal(unchanged.changed,false);assert.equal(unchanged.record.version,first.record.version);
  await tx(c=>changeContactTags(c,tenants[0],null,records[0].id,'remove',['Missing']));
  const removed=await tx(c=>changeContactTags(c,tenants[0],null,records[0].id,'remove',['Interested']));assert.deepEqual(removed.after,['Keep','Follow-up']);assert.deepEqual(removed.removed,['Interested']);
  await Promise.all(['Concurrent A','Concurrent B'].map(tag=>tx(c=>changeContactTags(c,tenants[0],null,records[0].id,'add',[tag]))));
  const current=(await tx(c=>c.query('SELECT * FROM records WHERE id=$1',[records[0].id]))).rows[0];assert.deepEqual(new Set(current.data.tags),new Set(['Keep','Follow-up','Concurrent A','Concurrent B']));
  const events=(await tx(c=>c.query("SELECT * FROM outbox WHERE type='crm.people.tags_changed' ORDER BY occurred_at"))).rows;assert.equal(events.length,4);assert.deepEqual(events[0].data.added,['Interested','Follow-up']);assert.equal(events[0].actor_id,users[0]);assert.deepEqual(events[1].data.removed,['Interested']);
  const reordered=await tx(c=>saveRecord(c,tenants[0],null,'people',{...current.data,tags:[...current.data.tags].reverse()},current.id,current.version));assert.equal((await tx(c=>c.query("SELECT count(*)::int AS n FROM outbox WHERE type='crm.people.tags_changed'"))).rows[0].n,4,'Reordering tags is not a membership change');
  await tx(c=>saveRecord(c,tenants[0],null,'people',{...reordered.data,tags:['Normal edit']},current.id,reordered.version));assert.equal((await tx(c=>c.query("SELECT count(*)::int AS n FROM outbox WHERE type='crm.people.tags_changed'"))).rows[0].n,5,'Normal record writes share tag events');
  await assert.rejects(tx(async c=>{await changeContactTags(c,tenants[0],null,records[0].id,'add',['Rollback']);throw new Error('Synthetic rollback');}),/Synthetic rollback/);assert.equal((await tx(c=>c.query("SELECT count(*)::int AS n FROM outbox WHERE type='crm.people.tags_changed'"))).rows[0].n,5);
  await assert.rejects(tx(c=>changeContactTags(c,tenants[0],null,records[1].id,'add',['Foreign'])),/not found/);
  const task=await tx(c=>saveRecord(c,tenants[0],null,'tasks',{name:'Not a contact'}));await assert.rejects(tx(c=>changeContactTags(c,tenants[0],null,task.id,'add',['Invalid'])),/not found/);
  const full=await tx(c=>saveRecord(c,tenants[0],null,'people',{name:'Full tag contact',tags:Array.from({length:100},(_,i)=>'Tag '+i)}));await assert.rejects(tx(c=>changeContactTags(c,tenants[0],null,full.id,'add',['Overflow'])),/100 tags/);assert.equal((await tx(c=>changeContactTags(c,tenants[0],null,full.id,'add',['Tag 0']))).changed,false);
  const alias=await tx(async c=>{const r=await saveRecord(c,tenants[0],null,'people',{name:'Merged tag alias'});await c.query('UPDATE records SET merged_into=$1 WHERE id=$2',[records[0].id,r.id]);return r;});assert.equal((await tx(c=>changeContactTags(c,tenants[0],null,alias.id,'add',['Canonical']))).record.id,records[0].id);
  const w=(await call('/workflows',cookies[0],{name:'Synthetic tag publication'})).data;
  async function publish(settings){assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:graph(settings)},'PUT')).status,200);return call('/workflows/'+w.id+'/publish',cookies[0],{});}
  assert.equal((await publish({...data,recordId:records[0].id})).status,200);assert.equal((await publish({...data,recordId:alias.id})).status,200);assert.equal((await publish({...data,recordId:records[1].id})).status,404);assert.equal((await publish({...data,recordId:task.id})).status,404);assert.equal((await publish({...data,tags:''})).status,400);assert.equal((await publish(data)).status,200);
  await tx(c=>c.query("UPDATE memberships SET role='member' WHERE user_id=$1",[users[0]]));assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:graph(data)},'PUT')).status,200);assert.equal((await call('/workflows/'+w.id+'/publish',cookies[0],{})).status,403);
  await tx(c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:graph(data)},'PUT')).status,403);assert.equal((await call('/workflows/'+w.id+'/versions',cookies[1])).data.length,0);
 }finally{
  for(const tenant of tenants){for(const table of ['outbox','executions','workflows','activities','record_links','records','record_lists','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();await pool.end();
 }
});
