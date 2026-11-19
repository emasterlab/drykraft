import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {pool,tenantTransaction,event} from '../server/db.mjs';
import {initializeWorkspace,saveRecord} from '../server/model.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {workflowAccess,workflowTransactionContext,requireWorkflowObject,requireWorkflowResource,requireWorkflowStep} from '../server/workflow-access.mjs';

const graph=(steps,trigger='trigger.manual')=>({nodes:[{id:'trigger',type:'workflow',position:{x:0,y:0},data:{kind:trigger,label:'Start'}},...steps.map((data,i)=>({id:'step'+i,type:'workflow',position:{x:(i+1)*300,y:0},data:{label:'Step',...data}}))],edges:[]});
async function version(c,tenant,g){
 const workflow=randomUUID(),id=randomUUID();
 await c.query('INSERT INTO workflows(tenant_id,id,name,draft) VALUES($1,$2,$3,$4)',[tenant,workflow,'Synthetic access workflow',g]);
 await c.query('INSERT INTO workflow_versions(tenant_id,id,workflow_id,version,graph) VALUES($1,$2,$3,1,$4)',[tenant,id,workflow,g]);return {id,workflow};
}
async function execution(c,tenant,v,runtime={}){
 const id=randomUUID();await c.query('INSERT INTO executions(tenant_id,id,workflow_id,version_id,runtime) VALUES($1,$2,$3,$4,$5)',[tenant,id,v.workflow,v.id,runtime]);return id;
}
test('published identities are tenant-scoped, narrowly derived and cannot acquire API access',async()=>{
 const tenant=randomUUID(),other=randomUUID();
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(const id of [tenant,other])await tenantTransaction(id,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[id,'Synthetic workflow access','access-'+id.slice(0,8)]);await initializeWorkspace(c,id);});
  const credential=randomUUID(),calendar=randomUUID(),connection=randomUUID();let child,parent,handler,source,childRun,parentRun,sourceRun,errorRun,foreign;
  await tenantTransaction(tenant,async c=>{
   child=await version(c,tenant,graph([{kind:'crm.create',object:'people',values:{name:'Sample'}},{kind:'code',secretBindings:[{name:'sample',credentialId:credential}]}],'trigger.subworkflow'));
   handler=await version(c,tenant,graph([{kind:'crm.note',recordId:'{{failure.record_id}}',note:'Failed'}],'trigger.error'));
   const unused=await version(c,tenant,graph([{kind:'log',credentialId:credential,secretBindings:[{credentialId:credential}],errorWorkflow:{versionId:handler.id}}]));
   const unusedScope=(await c.query('SELECT workflow_scope FROM service_accounts WHERE id=$1',[unused.id])).rows[0].workflow_scope;
   assert.deepEqual(unusedScope.credentials,[]);assert.deepEqual(unusedScope.versions,[unused.id]);assert.deepEqual(unusedScope.permissions,{});
   parent=await version(c,tenant,graph([{kind:'workflow.call',workflowId:child.workflow,versionId:child.id},{kind:'calendar.create',calendarId:calendar},{kind:'outreach.send',connectionId:connection}]));
   const sourceGraph=graph([]);sourceGraph.nodes[0].data.errorWorkflow={workflowId:handler.workflow,versionId:handler.id};source=await version(c,tenant,sourceGraph);
   parentRun=await execution(c,tenant,parent);childRun=await execution(c,tenant,child,{call:{parent_id:parentRun}});sourceRun=await execution(c,tenant,source);errorRun=await execution(c,tenant,handler,{error_handler:{source_id:sourceRun}});
   const account=(await c.query('SELECT * FROM service_accounts WHERE id=$1',[child.id])).rows[0];assert.equal(account.purpose,'workflow');assert.deepEqual(account.permissions.people,['create','read']);assert.equal(account.permissions.deals,undefined);
   const access=await workflowTransactionContext(c,childRun,'crm.create');requireWorkflowObject(access,'people','create');requireWorkflowResource(access,'credentials',credential);
   assert.throws(()=>requireWorkflowObject(access,'people','delete'),e=>e.status===403);assert.throws(()=>requireWorkflowObject(access,'deals','read'),e=>e.status===403);assert.throws(()=>requireWorkflowResource(access,'credentials',randomUUID()),e=>e.status===403);assert.throws(()=>requireWorkflowStep(access,'http'),e=>e.status===403);
   await event(c,tenant,null,'workflow.access.synthetic','workflow',child.workflow,{});
   assert.equal((await c.query("SELECT service_account_id FROM audit_events WHERE action='workflow.access.synthetic'")).rows[0].service_account_id,child.id);
   const key=randomUUID();await c.query("INSERT INTO api_keys(tenant_id,id,service_account_id,name,token_hash,prefix,permissions,payload_hash,expires_at) VALUES($1,$2::uuid,$3,'Synthetic','synthetic-'||$2::uuid::text,'synthetic',$4,'synthetic',now()+interval '1 hour')",[tenant,key,child.id,{people:['read']}]);
   assert.equal((await c.query('SELECT * FROM resolve_api_key($1)',['synthetic-'+key])).rowCount,0);
  });
  await tenantTransaction(other,async c=>{const v=await version(c,other,graph([{kind:'crm.search',object:'people'}]));foreign=await execution(c,other,v);assert.equal((await c.query('SELECT 1 FROM service_accounts WHERE id=$1',[child.id])).rowCount,0);});
  await assert.rejects(tenantTransaction(other,c=>workflowAccess(c,childRun)),e=>e.status===403);
  await assert.rejects(tenantTransaction(tenant,c=>c.query("UPDATE service_accounts SET workflow_scope='{}' WHERE id=$1",[child.id])),e=>e.code==='42501');
  await assert.rejects(tenantTransaction(tenant,c=>c.query("UPDATE service_accounts SET purpose='integration' WHERE id=$1",[child.id])),e=>e.code==='42501');
  // Observe the actual lock wait: revocation cannot overtake an authorized native write.
  const locked=await tenantTransaction(tenant,async c=>{const v=await version(c,tenant,graph([{kind:'crm.create',object:'people'}]));return {v,run:await execution(c,tenant,v)};});
  const updater=new pg.Client({connectionString:process.env.DATABASE_URL});await updater.connect();
  let release,entered,writerPid,saved,write;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  const held=tenantTransaction(tenant,async c=>{await workflowTransactionContext(c,locked.run,'crm.create');writerPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;entered();await gate;saved=await saveRecord(c,tenant,null,'people',{name:'Authorized before revocation'});});
  try{
   await ready;await updater.query('BEGIN');await updater.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);await updater.query("SET LOCAL lock_timeout='3000'");
   const updaterPid=(await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   write=updater.query('UPDATE service_accounts SET disabled=true WHERE id=$1',[locked.v.id]);
   let blockers=[];for(let i=0;i<50;i++){blockers=(await admin.query('SELECT pg_blocking_pids($1) AS blockers',[updaterPid])).rows[0].blockers;if(blockers.includes(writerPid))break;await delay(10);}
   assert.ok(blockers.includes(writerPid),'The administrator waits for the in-flight identity transaction');release();await held;await write;await updater.query('COMMIT');
   assert.equal(saved.created_by_service_account_id,locked.v.id);
   await assert.rejects(tenantTransaction(tenant,async c=>{await workflowTransactionContext(c,locked.run);await saveRecord(c,tenant,null,'people',{name:'Denied after revocation'});}),e=>e.status===403);
   const ordinary=await tenantTransaction(tenant,c=>saveRecord(c,tenant,null,'people',{name:'Ordinary user write'}));assert.equal(ordinary.created_by_service_account_id,null,'Transaction-local identity cannot leak to the next borrower');
  }finally{release();await held;try{if(write)await write;}finally{await updater.query('ROLLBACK');await updater.end();}}
  // Parent reduction also constrains a separately published, more privileged child.
  await tenantTransaction(tenant,c=>c.query("UPDATE service_accounts SET permissions=jsonb_set(permissions,'{people}','[\"read\"]') WHERE id=$1",[parent.id]));
  await tenantTransaction(tenant,async c=>{const access=await workflowTransactionContext(c,childRun);assert.throws(()=>requireWorkflowObject(access,'people','create'),e=>e.status===403);await assert.rejects(saveRecord(c,tenant,null,'people',{name:'Denied child mutation'}),e=>e.status===403);});
  await tenantTransaction(tenant,c=>c.query('UPDATE service_accounts SET disabled=true WHERE id=$1',[parent.id]));
  await assert.rejects(tenantTransaction(tenant,c=>workflowAccess(c,childRun)),e=>e.status===403);
  await tenantTransaction(tenant,async c=>{requireWorkflowObject(await workflowAccess(c,errorRun),'people','note');await c.query("UPDATE service_accounts SET permissions='{}' WHERE id=$1",[source.id]);});
  await tenantTransaction(tenant,async c=>{const access=await workflowAccess(c,errorRun);assert.throws(()=>requireWorkflowObject(access,'people','note'),e=>e.status===403);});
  await tenantTransaction(tenant,async c=>{
   await c.query("INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields) VALUES($1,'future_object','Future','Future','[]')",[tenant]);
   assert.equal((await c.query('SELECT permissions FROM service_accounts WHERE id=$1',[handler.id])).rows[0].permissions.future_object,undefined);
   const forged=await execution(c,tenant,child,{call:{parent_id:randomUUID()}});await assert.rejects(workflowAccess(c,forged),e=>e.status===403);
   const cyclic=await execution(c,tenant,child);await c.query('UPDATE executions SET runtime=$1 WHERE id=$2',[{call:{parent_id:cyclic}},cyclic]);await assert.rejects(workflowAccess(c,cyclic),e=>e.status===403);
   const crossing=await execution(c,tenant,child,{call:{parent_id:foreign}});await assert.rejects(workflowAccess(c,crossing),e=>e.status===403);
  });
 }finally{
  for(const tenantId of [tenant,other]){for(const table of ['executions','workflow_versions','workflows','record_links','activities','records','finance_counters','object_definitions','pipelines','dashboards','outbox','audit_events','usage_ledger','workspace_billing','api_keys'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenantId]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenantId]);}
  await admin.end();
 }
});
test.after(()=>pool.end());
