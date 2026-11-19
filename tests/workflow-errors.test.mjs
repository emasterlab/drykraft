import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
import {validateGraph,iterationPath} from '../server/automation.mjs';
import {errorWorkflowSettings,failExecution} from '../server/workflow-errors.mjs';
const node=(id,kind,data={})=>({id,type:'workflow',position:{x:100,y:100},data:{kind,label:id,...data}});
const handler={nodes:[node('t','trigger.error'),node('s','set',{values:{source:'{{failure.execution_id}}'}})],edges:[{id:'next',source:'t',target:'s'}]};
test('error handlers validate pinned references and prohibit automatic handler recursion',()=>{
 assert.equal(validateGraph(handler).nodes[0].data.kind,'trigger.error');
 const settings={workflowId:randomUUID(),versionId:randomUUID()};assert.deepEqual(errorWorkflowSettings({kind:'trigger.manual',errorWorkflow:settings}),settings);
 for(const value of [{},false,[],{...settings,versionId:'bad'},{...settings,extra:true}])assert.throws(()=>errorWorkflowSettings({kind:'trigger.manual',errorWorkflow:value}));
 assert.throws(()=>validateGraph({...handler,nodes:[node('t','trigger.error',{errorWorkflow:settings}),handler.nodes[1]]}));
 assert.throws(()=>validateGraph({...handler,nodes:[handler.nodes[0],node('s','set',{values:{},errorWorkflow:settings})]}));
});
function call(path,cookie,body,method=body?'POST':'GET'){return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('published handlers enforce tenancy, pin versions and bind once atomically at final failure',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=tenants.map(()=>randomUUID()),tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t),admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(let i=0;i<2;i++)await tenantTransaction(tenants[i],async c=>{await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic error-workflow tester',users[i]+'@example.test','unused']);await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenants[i],'Synthetic error workflow QA','errors-'+tenants[i].slice(0,8)]);await initializeWorkspace(c,tenants[i]);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenants[i],users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenants[i]]);});
  async function save(w,graph,cookie=cookies[0]){return call('/workflows/'+w.id,cookie,{name:w.name,draft:graph},'PUT');}
  const h=(await call('/workflows',cookies[0],{name:'Synthetic error handler'})).data;assert.equal((await save(h,handler)).status,200);const v1=(await call('/workflows/'+h.id+'/publish',cookies[0],{})).data;
  assert.equal((await call('/workflows/'+h.id+'/run',cookies[0],{input:{failure:{execution_id:randomUUID()}}})).status,400,'Manual requests cannot impersonate automatic failure dispatch');
  assert.ok((await call('/error-workflows',cookies[0])).data.some(v=>v.version_id===v1.id));assert.deepEqual((await call('/error-workflows',cookies[1])).data,[]);
  const source=(await call('/workflows',cookies[0],{name:'Synthetic source'})).data,settings={workflowId:h.id,versionId:v1.id},graph={nodes:[node('t','trigger.manual',{errorWorkflow:{...settings,workflowName:'Forged label',versionNumber:999}})],edges:[]};await save(source,graph);const published=await call('/workflows/'+source.id+'/publish',cookies[0],{});assert.equal(published.status,200);assert.equal(published.data.graph.nodes[0].data.errorWorkflow.workflowName,h.name);assert.equal(published.data.graph.nodes[0].data.errorWorkflow.versionNumber,1);
  await save(h,{...handler,nodes:[handler.nodes[0],node('s','set',{values:{newer:true}})]});const v2=(await call('/workflows/'+h.id+'/publish',cookies[0],{})).data;assert.equal(v2.version,2);assert.equal((await call('/workflows/'+source.id+'/versions',cookies[0])).data[0].graph.nodes[0].data.errorWorkflow.versionId,v1.id);
  const input={password:'synthetic source-only marker'},runId=randomUUID(),dispatch=randomUUID(),runtime={loops:[{node_id:'loop',index:1}]};
  await admin.query("INSERT INTO executions(tenant_id,id,workflow_id,version_id,current_node,state,dispatch_id,input,context,runtime,resume_at) VALUES($1,$2,$3,$4,'t','waiting',$5,$6,$6,$7,now()+interval '1 hour')",[tenants[0],runId,source.id,published.data.id,dispatch,input,runtime]);
  assert.equal(await tenantTransaction(tenants[1],c=>failExecution(c,tenants[1],runId,dispatch,'Synthetic failure')),null);
  assert.equal(await tenantTransaction(tenants[0],c=>failExecution(c,tenants[0],runId,randomUUID(),'Obsolete delivery')),null);
  await Promise.all([0,1].map(()=>tenantTransaction(tenants[0],c=>failExecution(c,tenants[0],runId,dispatch,'Synthetic failure'))));
  const failed=(await admin.query('SELECT * FROM executions WHERE id=$1',[runId])).rows[0],binding=failed.runtime.error_workflow;assert.equal(binding.state,'queued');assert.deepEqual(failed.runtime.loops,runtime.loops);
  const errorRun=(await admin.query('SELECT * FROM executions WHERE id=$1',[binding.execution_id])).rows[0];assert.equal(errorRun.version_id,v1.id);assert.equal(errorRun.runtime.error_handler.source_id,runId);assert.equal(errorRun.input.failure.iteration_path,iterationPath(runtime));assert.equal(errorRun.input.failure.message,'Synthetic failure');assert.ok(!JSON.stringify(errorRun.input).includes(input.password));assert.equal((await admin.query("SELECT 1 FROM executions WHERE runtime->'error_handler'->>'source_id'=$1",[runId])).rowCount,1);
  assert.equal((await call('/executions/'+errorRun.id,cookies[1])).status,404);assert.equal((await call('/executions/'+runId,cookies[0])).data.runtime.error_workflow.execution_id,errorRun.id);
  await admin.query("UPDATE executions SET state='waiting',resume_at=now()+interval '1 hour' WHERE id=$1",[runId]);await tenantTransaction(tenants[0],c=>failExecution(c,tenants[0],runId,dispatch,'Second failure'));assert.equal((await admin.query("SELECT 1 FROM executions WHERE runtime->'error_handler'->>'source_id'=$1",[runId])).rowCount,1);
  const foreign=(await call('/workflows',cookies[1],{name:'Synthetic foreign handler'})).data;await save(foreign,handler,cookies[1]);const fv=(await call('/workflows/'+foreign.id+'/publish',cookies[1],{})).data;await save(source,{...graph,nodes:[node('t','trigger.manual',{errorWorkflow:{workflowId:foreign.id,versionId:fv.id}})]});assert.equal((await call('/workflows/'+source.id+'/publish',cookies[0],{})).status,400);
  await call('/workflows/'+h.id+'/status',cookies[0],{status:'paused'});await save(source,graph);assert.equal((await call('/workflows/'+source.id+'/publish',cookies[0],{})).status,400);
  await save(h,{nodes:[node('t','trigger.error',{errorWorkflow:settings})],edges:[]});assert.equal((await call('/workflows/'+h.id+'/publish',cookies[0],{})).status,400);
  await tenantTransaction(tenants[0],c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await save(source,graph)).status,403);assert.equal((await call('/workflows/'+source.id+'/publish',cookies[0],{})).status,403);
 }finally{
  for(const tenant of tenants){for(const table of ['executions','workflows','outbox','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();
 }
});
test.after(()=>pool.end());
