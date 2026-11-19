import { Worker,Queue,DelayedError } from 'bullmq';
import { createClient } from 'redis';
import pg from 'pg';
import { randomUUID,createHash } from 'node:crypto';
import { pool,tenantTransaction } from './db.mjs';
import { financeDraft } from './finance.mjs';
import { saveRecord,addActivity,changeContactTags,moveDealStage,linkRecord,assignRecord } from './model.mjs';
import {executeDateTime} from './workflow-date-time.mjs';
import { searchWorkflowRecords,workflowSearchSchema } from './workflow-search.mjs';
import { createExecution,validateWorkflowNote,validateWorkflowTags,validateWorkflowStage,validateWorkflowLink,validateWorkflowAssignment,evaluateCondition,interpolate,decryptCredential,redact,dispatchSchedule,switchBranch,executeList,listKinds,iterationPath,loopInput,advanceWorkflow } from './automation.mjs';
import { safeHttp } from './http-node.mjs';
import {graphQLBody,graphQLResponse} from './workflow-graphql.mjs';
import {callSettings,reusableVersion,reusableContract,contractValue} from './workflow-calls.mjs';
import {failExecution} from './workflow-errors.mjs';
import {executeCsv} from './workflow-csv.mjs';
import {executeXml} from './workflow-xml.mjs';
import {codeSettings,runCode} from './workflow-code.mjs';
import {workflowTransactionContext,requireWorkflowResource,requireWorkflowStep} from './workflow-access.mjs';
import {splitPlan,mergeOutputs} from './workflow-branches.mjs';
import {resolvePath} from './automation.mjs';
import { billingAccess,requireBillingAccess } from './billing.mjs';
import { executeOutreach,outreachExecutionGate } from './outreach.mjs';
import { pollMailboxReplies } from './outreach-replies.mjs';
import {createAppointment,pollAppointmentReminders} from './calendar.mjs';
import {pollCalendarConnections} from './calendar-providers.mjs';
import { pollCustomerWebhooks } from './customer-webhooks.mjs';

const connection=createClient({url:process.env.REDIS_URL || 'redis://localhost:6379'});
connection.on('error',error=>console.error('Workflow Redis:',error.message));
await connection.connect();
const discovery=new pg.Pool({connectionString:process.env.WORKER_DATABASE_URL,max:3});
const queue=new Queue('drykraft-workflows',{connection,defaultJobOptions:{attempts:3,backoff:{type:'exponential',delay:2000},removeOnComplete:500,removeOnFail:500}});
async function callWorkflow(c,tenantId,execution,node,path,context){
 const d=callSettings(node.data),ancestors=[...(execution.runtime?.call?.ancestors || []),execution.id],workflowIds=[...(execution.runtime?.call?.workflow_ids || []),execution.workflow_id],root=execution.runtime?.call?.root_id || execution.id;
 if(ancestors.length>5 || workflowIds.includes(d.workflowId))throw new Error('Sub-workflows support five levels and cannot call an ancestor.');
 // Serialize the root budget and parent cancellation with atomic child creation/binding.
 const rootRow=(await c.query('SELECT state FROM executions WHERE id=$1 FOR UPDATE',[root])).rows[0];
 const parent=root===execution.id?rootRow:(await c.query('SELECT state FROM executions WHERE id=$1 FOR UPDATE',[execution.id])).rows[0];
 if(!parent || parent.state==='cancelled' || rootRow?.state==='cancelled')return {defer:true};
 const saved=(await c.query('SELECT output FROM node_executions WHERE execution_id=$1 AND node_id=$2 AND iteration_path=$3',[execution.id,node.id,path])).rows[0]?.output;
 let child;
 const v=await reusableVersion(c,d.workflowId,d.versionId,{active:!saved?.execution_id});
 if(saved?.execution_id){
  child=(await c.query('SELECT * FROM executions WHERE id=$1 AND workflow_id=$2 AND version_id=$3',[saved.execution_id,d.workflowId,d.versionId])).rows[0];
  if(!child || child.runtime?.call?.parent_id!==execution.id || child.runtime.call.node_id!==node.id || child.runtime.call.iteration_path!==path)throw new Error('The saved sub-workflow binding is unavailable.');
 }else{
  if(Number((await c.query("SELECT count(*) FROM executions WHERE runtime ? 'call' AND runtime->'call'->>'root_id'=$1",[root])).rows[0].count)>=1000)throw new Error('This root workflow reached its 1,000 sub-workflow run limit.');
  child=await createExecution(c,tenantId,{id:d.workflowId},v,contractValue(v.contract.inputs,interpolate(d.values,context)),null,execution.runtime?.error_handler?{error_handler:execution.runtime.error_handler}:{});
  const call={parent_id:execution.id,node_id:node.id,iteration_path:path,root_id:root,ancestors,workflow_ids:workflowIds};
  await c.query('UPDATE executions SET runtime=$1 WHERE id=$2',[{...child.runtime,call},child.id]);
 }
 if(child.state==='succeeded'){
  const output={execution_id:child.id,workflow_id:d.workflowId,version_id:v.id,version:v.version,output:contractValue(v.contract.outputs,child.context.last,'Sub-workflow output')};
  await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=coalesce(completed_at,now()) WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[output,execution.id,node.id,path]);return output;
 }
 if(['failed','cancelled'].includes(child.state))throw new Error('Sub-workflow '+child.id+' '+child.state+'. Review that run; retrying this step reuses it.');
 await c.query("UPDATE node_executions SET state='waiting',output=$1 WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[{execution_id:child.id,workflow_id:d.workflowId,version_id:v.id,version:v.version},execution.id,node.id,path]);
 await c.query("UPDATE executions SET state='waiting',resume_at=now()+interval '2 seconds',dispatch_id=gen_random_uuid() WHERE id=$1 AND state<>'cancelled'",[execution.id]);
 return {defer:true};
}
async function runExecution(tenantId,id,dispatchId) {
  const client=await pool.connect(),lockKey=`drykraft:execution:${tenantId}:${id}`;
  let acquired,discard=false;
  try {
  // Keep the lease and business transactions on one session: connection loss rolls back its active CRM effect.
  // ponytail: requires direct/session PostgreSQL pooling; use fenced leases if transaction pooling is introduced.
  acquired=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[lockKey])).rows[0].acquired;
  if(!acquired)return false;
  let guarded=false;
  const tx=(fn,authorize=guarded)=>tenantTransaction(tenantId,async c=>{if(authorize)await workflowTransactionContext(c,id);return fn(c);},client);
  let secrets=[];
  const execution=await tx(async c=>{
    const e=(await c.query('SELECT * FROM executions WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!e || e.dispatch_id!==dispatchId || ['cancelled','succeeded','failed'].includes(e.state))return null;
    if(!(await outreachExecutionGate(c,id)))return null;
    if(!(await billingAccess(c,tenantId,'automation')).access){await failExecution(c,tenantId,id,dispatchId,'Workspace plan inactive. Activate billing, then retry this execution.');return null;}
    if(e.state==='waiting' && e.resume_at && e.resume_at.getTime()>Date.now())return null;
    await c.query("UPDATE executions SET state='running',attempts=attempts+1,started_at=coalesce(started_at,now()),resume_at=NULL WHERE id=$1",[id]);
    const v=(await c.query('SELECT graph FROM workflow_versions WHERE id=$1',[e.version_id])).rows[0];
    return {...e,graph:v.graph};
  });
  if(!execution)return;
  guarded=true;
  const zone=(await client.query('SELECT settings FROM workspaces WHERE id=$1',[tenantId])).rows[0]?.settings.timezone || 'UTC';
  const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
  let context={today:localDate.format(new Date()),dueIn30Days:localDate.format(new Date(Date.now()+30*86400000)),...execution.context},nodeId=execution.current_node,runtime=execution.runtime || {},path='';
  try {
    for(let steps=0;nodeId && steps<100;steps++){
      const current=await tx(async c=>(await c.query('SELECT state FROM executions WHERE id=$1',[id])).rows[0]);
      if(current.state==='cancelled')return;
      if(execution.runtime?.call && await tx(async c=>(await c.query("SELECT 1 FROM executions WHERE id=ANY($1::uuid[]) AND state='cancelled' LIMIT 1",[execution.runtime.call.ancestors])).rowCount)){
        await tx(c=>c.query("UPDATE executions SET state='cancelled',completed_at=now() WHERE id=$1",[id]));return;
      }
      if(!(await tx(c=>outreachExecutionGate(c,id))))return;
      await tx(c=>requireBillingAccess(c,tenantId,'automation'));
      if((runtime.steps || 0)>=10000)throw new Error('Workflow exceeded 10,000 visited steps. Narrow the Loop source or shorten its item path.');
      const node=execution.graph.nodes.find(n=>n.id===nodeId);if(!node)throw new Error('The saved workflow step is unavailable.');const d=node.data;path=iterationPath(runtime);
      await tx(c=>requireWorkflowStep(c.workflowPrincipal,d.kind));
      const prior=await tx(async c=>(await c.query('SELECT * FROM node_executions WHERE execution_id=$1 AND node_id=$2 AND iteration_path=$3',[id,nodeId,path])).rows[0]);
      let output,branch;
      if(prior?.state==='succeeded') {
        output=prior.output;
        if(d.kind==='condition')branch=output.result?'true':'false';
        if(d.kind==='switch')branch=output.branch;
      } else if(d.kind==='wait' && prior?.state==='waiting') {
        output={waited_seconds:d.seconds};
      } else {
        await tx(c=>c.query(`INSERT INTO node_executions(tenant_id,execution_id,node_id,state,input,iteration_path) VALUES($1,$2,$3,'running',$4,$5)
          ON CONFLICT(tenant_id,execution_id,node_id,iteration_path) DO UPDATE SET state='running',error=NULL`,[tenantId,id,nodeId,redact(context,secrets),path]));
        if(d.kind==='wait') {
          const resume=new Date(Date.now()+d.seconds*1000);
          await tx(async c=>{
            await c.query("UPDATE node_executions SET state='waiting' WHERE execution_id=$1 AND node_id=$2 AND iteration_path=$3",[id,nodeId,path]);
            await c.query("UPDATE executions SET state='waiting',resume_at=$1,dispatch_id=gen_random_uuid() WHERE id=$2 AND state<>'cancelled'",[resume,id]);
          });
          return;
        }
        if(d.kind.startsWith('trigger.'))output=d.kind==='trigger.subworkflow'?contractValue(reusableContract(d).inputs,execution.input):execution.input;
        else if(d.kind==='workflow.call'){
          output=await tx(c=>callWorkflow(c,tenantId,execution,node,path,context));if(output.defer)return;
        }
        else if(d.kind==='workflow.return')output=contractValue(reusableContract(execution.graph.nodes.find(n=>n.data.kind==='trigger.subworkflow').data).outputs,interpolate(d.values,context),'Sub-workflow output');
        else if(d.kind==='condition'){const result=evaluateCondition(d,context);output={result};branch=result?'true':'false';}
        else if(d.kind==='switch'){branch=switchBranch(d,context);output={branch,matched:branch!=='default'};}
        else if(d.kind==='split')output=splitPlan(execution.graph,node);
        else if(d.kind==='merge')output=mergeOutputs(d,context.nodes?.[d.splitId]);
        else if(d.kind==='loop')output=loopInput(d,context);
        else if(listKinds.includes(d.kind))output=executeList(d,context);
        else if(d.kind==='data.csv')output=executeCsv(d,resolvePath(context,d.source));
        else if(d.kind==='data.xml')output=executeXml(d,resolvePath(context,d.source));
        else if(d.kind==='code'){
          const settings=codeSettings(d),values={};
          for(const binding of settings.secretBindings){
            const credential=await tx(async c=>{requireWorkflowResource(c.workflowPrincipal,'credentials',binding.credentialId);return (await c.query('SELECT ciphertext FROM credentials WHERE id=$1',[binding.credentialId])).rows[0];});
            if(!credential)throw new Error('A Code secret is unavailable in this workspace.');
            values[binding.name]=decryptCredential(tenantId,credential.ciphertext).value;secrets.push(values[binding.name]);
          }
          const controller=new AbortController();let pending=null,accessError=null;
          // Keep cancellation polling serialized on the execution lease's PostgreSQL session.
          const timer=setInterval(()=>{if(pending)return;pending=tx(async c=>{
            const cancelled=(await c.query("SELECT 1 FROM executions WHERE id=ANY($1::uuid[]) AND state='cancelled' LIMIT 1",[[id,...(execution.runtime?.call?.ancestors || [])]])).rowCount;
            if(cancelled)controller.abort();
          }).catch(error=>{if(error.workflowAccessDenied)accessError=error;controller.abort();}).finally(()=>{pending=null;});},250);
          try{output=redact(await runCode(settings,resolvePath(context,settings.source),{tenantId,secrets:values,signal:controller.signal}),secrets);}
          catch(error){throw accessError || error;}
          finally{clearInterval(timer);if(pending)await pending;}
          if(accessError)throw accessError;
          if(controller.signal.aborted)throw new Error('Code execution cancelled.');
        }
        else if(d.kind==='date.time')output=executeDateTime({...d,date:interpolate(d.date||'',context),otherDate:interpolate(d.otherDate||'',context),amount:interpolate(d.amount??1,context)});
        else if(d.kind==='set')output=interpolate(d.values,context);
        else if(d.kind==='log')output={message:interpolate(d.message || 'Workflow step completed',context)};
        else if(d.kind==='crm.search')output=await tx(async c=>{
          const query=workflowSearchSchema.parse(d),page=await searchWorkflowRecords(c,{...query,search:interpolate(query.search,context),cursor:interpolate(query.cursor,context),...(query.filter?{filter:interpolate(query.filter,context)}:{})});
          // Persist the read snapshot with step completion; recovery reuses it instead of searching changed records.
          await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=now() WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[page,id,nodeId,path]);return page;
        });
        else if(d.kind==='crm.link')output=await tx(async c=>{
          const settings=validateWorkflowLink(d),input=validateWorkflowLink({...settings,recordId:interpolate(settings.recordId,context),targetId:interpolate(settings.targetId,context)},true);
          const result=await linkRecord(c,tenantId,null,input.object,input.recordId,input.relationField,input.operation,input.targetId,execution.event_id);
          await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=now() WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[result,id,nodeId,path]);return result;
        });
        else if(d.kind==='crm.assign')output=await tx(async c=>{
          const settings=validateWorkflowAssignment(d),input=validateWorkflowAssignment({...settings,recordId:interpolate(settings.recordId,context),userId:interpolate(settings.userId,context)},true);
          const result=await assignRecord(c,tenantId,null,input.object,input.recordId,input.assignmentField,input.operation,input.userId,execution.event_id);
          await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=now() WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[result,id,nodeId,path]);return result;
        });
        else if(d.kind==='crm.stage')output=await tx(async c=>{
          const settings=validateWorkflowStage(d),input=validateWorkflowStage({...settings,recordId:interpolate(settings.recordId,context),pipelineId:interpolate(settings.pipelineId,context),stageId:interpolate(settings.stageId,context)},true);
          const result=await moveDealStage(c,tenantId,null,input.recordId,input.pipelineId,input.stageId,input.status,execution.event_id);
          await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=now() WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[result,id,nodeId,path]);return result;
        });
        else if(d.kind==='crm.tags')output=await tx(async c=>{
          const settings=validateWorkflowTags(d),input=validateWorkflowTags({...settings,recordId:interpolate(settings.recordId,context),tags:interpolate(settings.tags,context)},true);
          const result=await changeContactTags(c,tenantId,null,input.recordId,input.operation,input.tags,execution.event_id);
          await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=now() WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[result,id,nodeId,path]);return result;
        });
        else if(d.kind==='crm.note')output=await tx(async c=>{
          const input=validateWorkflowNote({recordId:interpolate(d.recordId,context),note:interpolate(d.note,context)},true),activity=await addActivity(c,tenantId,null,{record_id:input.recordId,body:input.note},execution.event_id);
          // The note and its completion commit together; completed output is reused on recovery.
          await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=now() WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[activity,id,nodeId,path]);return activity;
        });
        else if(['crm.create','crm.update','finance.create'].includes(d.kind)) {
          output=await tx(async c=>{
            const existing=d.kind==='crm.update'?(await c.query('SELECT * FROM records WHERE id=$1 AND object_key=$2',[interpolate(d.recordId,context),d.object])).rows[0]:null;
            if(d.kind==='crm.update' && !existing)throw new Error('The CRM record does not exist in this workspace.');
            const save=d.kind==='finance.create'?financeDraft:saveRecord;
            const record=await save(c,tenantId,null,d.object,{...(existing?.data || {}),...interpolate(d.values,context)},existing?.id || null,existing?.version || null,execution.event_id);
            // CRM mutation and node completion share a transaction, preventing duplicated records on retries.
            await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=now() WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[record,id,nodeId,path]);
            return record;
          });
        } else if(d.kind==='calendar.create'){
          output=await tx(async c=>{requireWorkflowResource(c.workflowPrincipal,'calendars',d.calendarId);const {manage_key,create_hash,...a}=await createAppointment(c,tenantId,null,{record_id:null,notes:'',outside_hours:false,...interpolate(d.values,context),id:randomUUID(),calendar_id:d.calendarId},'workflow',execution.event_id);await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=now() WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[a,id,nodeId,path]);return a;});
        } else if(d.kind.startsWith('outreach.')) {
          output=await executeOutreach(tenantId,execution,{...d,id:path?nodeId+':'+path:nodeId},context);
          if(output.defer){await tx(async c=>{await c.query("UPDATE node_executions SET state='waiting' WHERE execution_id=$1 AND node_id=$2 AND iteration_path=$3",[id,nodeId,path]);await c.query("UPDATE executions SET state='waiting',resume_at=now()+interval '1 minute',dispatch_id=gen_random_uuid() WHERE id=$1 AND state<>'cancelled'",[id]);});return;}
        } else if(['http','graphql'].includes(d.kind)) {
          const idempotencyKey=`${id}-${nodeId}${path?'-'+createHash('sha256').update(path).digest('hex'):''}`,headers={'content-type':'application/json','idempotency-key':idempotencyKey};
          if(d.credentialId) {
            const credential=await tx(async c=>{requireWorkflowResource(c.workflowPrincipal,'credentials',d.credentialId);return (await c.query('SELECT provider,ciphertext FROM credentials WHERE id=$1',[d.credentialId])).rows[0];});
            if(!credential)throw new Error('The credential is unavailable in this workspace.');
            const secret=decryptCredential(tenantId,credential.ciphertext);secrets.push(secret.value);
            if(credential.provider==='bearer')headers.authorization=`Bearer ${secret.value}`;
            else if(credential.provider==='basic'){const encoded=Buffer.from(secret.value).toString('base64');secrets.push(encoded);headers.authorization=`Basic ${encoded}`;}
            else headers[secret.header]=secret.value;
          }
          await tx(c=>requireWorkflowStep(c.workflowPrincipal,d.kind));
          let response;
          if(d.kind==='graphql'){
            const body=graphQLBody(d,interpolate(d.variables ?? {},context));
            response=graphQLResponse(await safeHttp(d.url,{method:'POST',headers:{...headers,'content-type':'application/json','idempotency-key':idempotencyKey,accept:'application/graphql-response+json, application/json'},body}),d.errorPolicy);
          }else response=await safeHttp(interpolate(d.url,context),{method:d.method || 'GET',headers,body:d.body?JSON.stringify(interpolate(d.body,context)):undefined});
          output=redact(response,secrets);
        }
      }
      const next=advanceWorkflow(execution.graph,node,context,runtime,output,branch,prior?.state==='succeeded');
      await tx(async c=>{
        await c.query("UPDATE node_executions SET state=$1,output=$2,completed_at=CASE WHEN $1='succeeded' THEN coalesce(completed_at,now()) ELSE NULL END WHERE execution_id=$3 AND node_id=$4 AND iteration_path=$5",[next.entering?'running':'succeeded',redact(next.output,secrets),id,nodeId,path]);
        for(const loop of next.completions)await c.query("UPDATE node_executions SET state='succeeded',output=$1,completed_at=coalesce(completed_at,now()) WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4",[redact(loop.output,secrets),id,loop.node_id,loop.iteration_path]);
        await c.query("UPDATE executions SET context=$1,runtime=$2,current_node=$3 WHERE id=$4 AND state<>'cancelled'",[redact(next.context,secrets),redact(next.runtime,secrets),next.next,id]);
      });
      context=next.context;runtime=next.runtime;nodeId=next.next;
    }
    if(nodeId){
      // Yield the execution lease after a bounded slice; its next cursor is already committed.
      await tx(c=>c.query("UPDATE executions SET state='queued',dispatch_id=gen_random_uuid() WHERE id=$1 AND state<>'cancelled'",[id]));return;
    }
    await tx(async c=>{
      await c.query("UPDATE executions SET state='succeeded',completed_at=now() WHERE id=$1 AND state<>'cancelled'",[id]);
      await c.query('INSERT INTO usage_ledger(tenant_id,id,metric,amount,reference_id) VALUES($1,$2,$3,1,$4) ON CONFLICT DO NOTHING',[tenantId,randomUUID(),'workflow_executions',id]);
    });
  } catch(error) {
    const message=redact(error.message,secrets);
    await tx(async c=>{
      if(nodeId)await c.query("UPDATE node_executions SET state='failed',error=$1 WHERE execution_id=$2 AND node_id=$3 AND iteration_path=$4 AND state<>'succeeded'",[message,id,nodeId,path]);
      if(error.workflowAccessDenied)await failExecution(c,tenantId,id,dispatchId,message);
      else await c.query("UPDATE executions SET state='retrying',error=$1 WHERE id=$2 AND state<>'cancelled'",[message,id]);
    },false);
    if(error.workflowAccessDenied)return;
    throw new Error(message);
  }
  } finally {
    try {if(acquired)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]);else if(acquired!==false)discard=true;}catch{discard=true;}
    client.release(discard);
  }
}
const dispatchForJob=job=>job.data.dispatchId || job.id.slice(job.data.id.length+1);
const worker=new Worker('drykraft-workflows',async(job,token)=>{
  if(await runExecution(job.data.tenantId,job.data.id,dispatchForJob(job))===false){
    // Keep contended work durable without consuming failure attempts or occupying a worker slot.
    await job.moveToDelayed(Date.now()+1000,token);throw new DelayedError();
  }
},{connection,concurrency:4,limiter:{max:60,duration:1000}});
const failedWrites=new Set();
worker.on('failed',(job,error)=>{
  if(!job || job.attemptsMade<3)return;
  const write=tenantTransaction(job.data.tenantId,async c=>{
    const owned=(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS owned',[`drykraft:execution:${job.data.tenantId}:${job.data.id}`])).rows[0].owned;
    if(owned)await failExecution(c,job.data.tenantId,job.data.id,dispatchForJob(job),error.message);
  }).catch(()=>console.error('Workflow failure state could not be saved.'));
  failedWrites.add(write);void write.finally(()=>failedWrites.delete(write));
});
worker.on('error',error=>console.error('Workflow queue:',error.message));
let closing=false,polling=null;
function poll(){
  if(closing || polling)return polling;
  polling=discover().finally(()=>{polling=null;});return polling;
}
async function discover(){
  try {
    const events=(await discovery.query('SELECT tenant_id,id FROM outbox WHERE published_at IS NULL ORDER BY occurred_at LIMIT 100')).rows;
    for(const item of events)await tenantTransaction(item.tenant_id,async c=>{
      const e=(await c.query('SELECT * FROM outbox WHERE id=$1 AND published_at IS NULL FOR UPDATE SKIP LOCKED',[item.id])).rows[0];if(!e)return;
      if(!(await billingAccess(c,item.tenant_id,'automation')).access){await c.query('UPDATE outbox SET published_at=now() WHERE id=$1',[e.id]);return;}
      const workflows=(await c.query("SELECT w.*,v.graph,v.id AS version_id FROM workflows w JOIN workflow_versions v ON v.id=w.published_version_id AND v.tenant_id=w.tenant_id WHERE w.status='active'")).rows;
      for(const w of workflows){
        const t=w.graph.nodes.find(n=>n.data.kind==='trigger.event');
        if(t?.data.event===e.type)try{await createExecution(c,item.tenant_id,w,{id:w.version_id,graph:w.graph},e.data,e.id);}catch(error){if(!error.workflowAccessDenied)throw error;}
      }
      await c.query('UPDATE outbox SET published_at=now() WHERE id=$1',[e.id]);
    });
    const scheduled=(await discovery.query("SELECT tenant_id,id FROM workflows WHERE status='active' AND next_run_at<=now() LIMIT 100")).rows;
    for(const item of scheduled)await tenantTransaction(item.tenant_id,c=>dispatchSchedule(c,item.tenant_id,item.id));
    const ready=(await discovery.query("SELECT tenant_id,id,dispatch_id FROM executions WHERE state IN ('queued','retrying','running') OR (state='waiting' AND resume_at<=now()) ORDER BY created_at LIMIT 100")).rows;
    for(const e of ready){
      const jobId=`${e.id}-${e.dispatch_id}`;
      if(!(await queue.getJob(jobId)))await queue.add('execute',{tenantId:e.tenant_id,id:e.id,dispatchId:e.dispatch_id},{jobId});
    }
  } catch(error){console.error('Workflow scheduler:',error.message);}
}
const timer=setInterval(poll,1000);
let replyPolling=null;
const replyTimer=setInterval(()=>{
  if(closing || replyPolling)return;
  replyPolling=pollMailboxReplies(discovery).catch(()=>console.error('Outreach mailbox sync could not run.')).finally(()=>{replyPolling=null;});
},60000);
let webhookPolling=null;
const webhookTimer=setInterval(()=>{
  if(closing || webhookPolling)return;
  webhookPolling=pollCustomerWebhooks(discovery,()=>closing).catch(()=>console.error('Customer webhook dispatch could not run.')).finally(()=>{webhookPolling=null;});
},1000);
let calendarPolling=null;
const calendarTimer=setInterval(()=>{if(closing||calendarPolling)return;calendarPolling=(async()=>{await pollAppointmentReminders(discovery,()=>closing);await pollCalendarConnections(discovery,()=>closing);})().catch(()=>console.error('Calendar scheduling could not run.')).finally(()=>{calendarPolling=null;});},60000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{
  if(closing)return;closing=true;clearInterval(timer);clearInterval(replyTimer);clearInterval(webhookTimer);clearInterval(calendarTimer);
  const deadline=setTimeout(()=>{console.error('Worker shutdown exceeded 25 seconds; unfinished work remains durable.');process.exit(1);},25000);deadline.unref();
  try{
    await Promise.all([worker.close(),polling,replyPolling,webhookPolling,calendarPolling]);await Promise.all([...failedWrites]);
    await queue.close();await connection.quit();await pool.end();await discovery.end();clearTimeout(deadline);process.exit(0);
  }catch{console.error('Worker shutdown could not complete; unfinished work remains durable.');process.exit(1);}
});
await poll();if(!closing)console.log('DryKraft workflow worker and durable scheduler are ready.');
