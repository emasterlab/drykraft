import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';

const node=(id,kind,settings={})=>({id,type:'workflow',position:{x:0,y:0},data:{kind,label:id,...settings}});
const graph={nodes:[node('t','trigger.manual'),node('w','wait',{seconds:2}),node('c','crm.create',{object:'people',values:{name:'Synthetic authorized person'}})],edges:[{id:'tw',source:'t',target:'w'},{id:'wc',source:'w',target:'c'}]};
function call(path,cookie,body,method=body?'POST':'GET') {
 return new Promise((resolve,reject)=>{
  const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
 });
}
test('administrators manage per-version workflow authority; revocation survives Wait and blocks recovery',async()=>{
 const tenant=randomUUID(),other=randomUUID(),users=[randomUUID(),randomUUID(),randomUUID()],tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t),password='SyntheticWorkflowPass!2026';
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 const tx=fn=>tenantTransaction(tenant,fn);let foreign;
 try{
  const stored=await hashPassword(password);
  await tx(async c=>{
   await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic workflow authority','scope-'+tenant.slice(0,8)]);await initializeWorkspace(c,tenant);
   for(const [i,id]of users.entries()){
    await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,'Synthetic workflow reviewer',id+'@example.test',stored]);await c.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant,id,['owner','member','viewer'][i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),id,tenant]);
   }
  });
  await tenantTransaction(other,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[other,'Other workflow authority','scope-'+other.slice(0,8)]);await initializeWorkspace(c,other);const w=randomUUID();foreign=randomUUID();await c.query('INSERT INTO workflows(tenant_id,id,name,draft) VALUES($1,$2,$3,$4)',[other,w,'Private workflow',graph]);await c.query('INSERT INTO workflow_versions(tenant_id,id,workflow_id,version,graph) VALUES($1,$2,$3,1,$4)',[other,foreign,w,graph]);});
  assert.deepEqual((await call('/developer/workflows',cookies[0])).data.accounts,[]);
  const w=(await call('/automation/workflows',cookies[0],{name:'Synthetic reviewed authority'})).data;
  assert.equal((await call('/automation/workflows/'+w.id,cookies[0],{name:w.name,draft:graph},'PUT')).status,200);
  const published=await call('/automation/workflows/'+w.id+'/publish',cookies[0],{});assert.equal(published.status,200);const v=published.data;
  let detail=await call('/developer/workflows/'+v.id,cookies[0]);assert.equal(detail.status,200);let s=detail.data.account;
  assert.deepEqual(s.permissions,{people:['create','read'],companies:['create','read']});assert.ok(s.published);assert.deepEqual(detail.data.resources,{credentials:[],calendars:[],connections:[]});
  assert.equal((await call('/developer/accounts',cookies[0])).data.accounts.length,0,'Workflow identities do not consume the integration list or its limit');
  for(const cookie of cookies.slice(1)){
   assert.equal((await call('/developer/workflows',cookie)).status,403);
   assert.equal((await call('/developer/workflows/'+v.id,cookie)).status,403);
   assert.equal((await call('/developer/workflows/'+v.id,cookie,{version:s.version,disabled:true},'PUT')).status,403);
  }
  assert.equal((await call('/developer/workflows/'+foreign,cookies[0])).status,404);
  assert.equal((await call('/developer/workflows/'+foreign,cookies[0],{version:1,disabled:true},'PUT')).status,404);
  assert.equal((await call('/developer/accounts/'+v.id+'/keys',cookies[0])).status,404);
  assert.equal((await call('/developer/accounts/'+v.id+'/keys',cookies[0],{id:randomUUID(),name:'Forbidden workflow key',permissions:{people:['read']},days:7,account_version:s.version,password})).status,404);
  const update=body=>call('/developer/workflows/'+v.id,cookies[0],body,'PUT');
  assert.equal((await update({version:s.version,disabled:false,permissions:{people:['read','delete']},password})).status,400,'Even password approval cannot exceed the immutable published ceiling');
  assert.equal((await update({version:s.version,disabled:false,workflow_scope:{}})).status,400);
  let response=await update({version:s.version,disabled:false,permissions:{people:['read']}});assert.equal(response.status,200);s=response.data;
  assert.equal((await update({version:s.version-1,disabled:true})).status,409,'Stale edits cannot overwrite the saved identity');
  assert.equal((await update({version:s.version,disabled:false,permissions:{people:['create','read']}})).status,400);
  assert.equal((await update({version:s.version,disabled:false,permissions:{people:['create','read']},password:'IncorrectPassword!'})).status,400);
  response=await update({version:s.version,disabled:false,permissions:{people:['create','read']},password});assert.equal(response.status,200);s=response.data;
  // A real worker executes Start and Wait; reducing authority before continuation must prevent Create.
  const run=await call('/automation/workflows/'+w.id+'/run',cookies[0],{input:{}});assert.equal(run.status,202);
  async function state(id,wanted){for(let i=0;i<150;i++){const e=(await tx(c=>c.query('SELECT * FROM executions WHERE id=$1',[id]))).rows[0];if(wanted.includes(e.state))return e;await delay(100);}throw Error('Worker did not reach '+wanted.join('/'));}
  await state(run.data.id,['waiting']);
  response=await update({version:s.version,disabled:true});assert.equal(response.status,200);s=response.data;
  const stopped=await state(run.data.id,['failed']);assert.ok(stopped.error);assert.equal((await tx(c=>c.query("SELECT count(*)::int AS n FROM records WHERE object_key='people'"))).rows[0].n,0);
  assert.equal((await call('/automation/executions/'+run.data.id+'/retry',cookies[0],{id:randomUUID()})).status,403);
  assert.equal((await call('/automation/workflows/'+w.id+'/run',cookies[0],{input:{}})).status,403);
  assert.equal((await update({version:s.version,disabled:false})).status,400);
  response=await update({version:s.version,disabled:false,password});assert.equal(response.status,200);s=response.data;
  const retry=await call('/automation/executions/'+run.data.id+'/retry',cookies[0],{id:randomUUID()});assert.equal(retry.status,200);await state(run.data.id,['succeeded']);
  const person=(await tx(c=>c.query("SELECT * FROM records WHERE object_key='people'"))).rows[0];assert.equal(person.created_by_service_account_id,v.id);
  response=await update({version:s.version,disabled:true,permissions:{}});assert.equal(response.status,200,'An empty native object permission set is an intentional reduction');
  const next=await call('/automation/workflows/'+w.id+'/publish',cookies[0],{});assert.equal(next.status,200);const fresh=(await call('/developer/workflows/'+next.data.id,cookies[0])).data.account;
  assert.deepEqual(fresh.permissions,{people:['create','read'],companies:['create','read']});assert.equal(fresh.disabled,false);assert.equal((await call('/developer/workflows/'+v.id,cookies[0])).data.account.published,false);
  const missingResource=randomUUID(),pureVersion=randomUUID();
  await tx(async c=>{for(let i=0;i<26;i++)await c.query("INSERT INTO workflow_versions(tenant_id,id,workflow_id,version,graph) VALUES($1,$2,$3,$4,$5)",[tenant,i===0?pureVersion:randomUUID(),w.id,i+3,{nodes:[node('t','trigger.manual'),...(i===0?[node('h','http',{url:'https://example.com',method:'GET',credentialId:missingResource})]:[])],edges:[]}]);});
  const pure=(await call('/developer/workflows/'+pureVersion,cookies[0])).data;
  assert.deepEqual(pure.account.permissions,{});assert.deepEqual(pure.resources.credentials,[{id:missingResource,name:'Saved resource unavailable'}]);
  const page=(await call('/developer/workflows',cookies[0])).data,more=(await call('/developer/workflows?cursor='+page.next_cursor,cookies[0])).data;
  assert.equal(page.accounts.length,25);assert.equal(more.accounts.length,3);assert.equal(more.next_cursor,null);assert.equal(new Set([...page.accounts,...more.accounts].map(a=>a.id)).size,28);
  assert.equal((await call('/developer/workflows?cursor='+foreign,cookies[0])).status,400);
  assert.ok((await tx(c=>c.query("SELECT 1 FROM audit_events WHERE action='automation.workflow.access_updated' AND actor_id=$1",[users[0]]))).rowCount);
 }finally{
  // Remove only these synthetic tenants after every worker execution has reached a terminal state.
  for(const t of [tenant,other]){for(const table of ['execution_recoveries','executions','workflow_versions','workflows','activities','record_links','records','outbox','audit_events','usage_ledger','workspace_billing','object_definitions','pipelines','dashboards','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[t]);await admin.query('DELETE FROM workspaces WHERE id=$1',[t]);}
  await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();
 }
});
test.after(()=>pool.end());
