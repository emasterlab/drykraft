import { Router } from 'express';
import { z } from 'zod';
import { randomUUID,randomBytes } from 'node:crypto';
import { tenantTransaction,event } from './db.mjs';
import { requireWrite,requireAdmin,tokenHash } from './auth.mjs';
import { AppError,resolveRecord,dealStageDestination,recordRelationshipField,recordAssignmentField,requireAssignmentMember } from './model.mjs';
import { graphSchema,validateGraph,validateWorkflowStage,validateWorkflowLink,validateWorkflowAssignment,encryptCredential,decryptCredential,createExecution,nextSchedule,iterationPath,iterationPathSchema } from './automation.mjs';
import { validateWorkflowSearch } from './workflow-search.mjs';
import {bindWorkflowCalls,reusableContract} from './workflow-calls.mjs';
import {bindErrorWorkflow} from './workflow-errors.mjs';
import {codeSettings} from './workflow-code.mjs';
import {workflowAccess} from './workflow-access.mjs';

export const automationRouter=Router();
const tx=(req,fn)=>tenantTransaction(req.auth.workspace.id,fn);
const managedWorkflow=async(c,id)=>(await c.query("SELECT 1 FROM outreach_campaigns WHERE workflow_id=$1 UNION ALL SELECT 1 FROM outreach_connections WHERE config->>'aiWorkflowId'=$1::text LIMIT 1",[id])).rowCount>0;
async function recover(c,req,sourceId,{id,mode,node_id=null,iteration_path=''}) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`recovery:${req.auth.workspace.id}:${id}`]);
  const source=(await c.query('SELECT * FROM executions WHERE id=$1 FOR UPDATE',[sourceId])).rows[0];
  if(!source)throw new AppError(404,'Execution not found.');
  const version=(await c.query('SELECT * FROM workflow_versions WHERE id=$1',[source.version_id])).rows[0];
  if(await managedWorkflow(c,source.workflow_id) || version.graph.nodes.some(n=>n.data.kind.startsWith('outreach.')))throw new AppError(409,'Manage this campaign or WhatsApp AI connection from Outreach.');
  const prior=(await c.query('SELECT * FROM execution_recoveries WHERE id=$1',[id])).rows[0];
  if(prior){
    if(prior.source_id!==source.id || prior.mode!==mode || prior.node_id!==node_id || prior.iteration_path!==iteration_path)throw new AppError(409,'This recovery reference belongs to a different request.');
    return (await c.query('SELECT * FROM executions WHERE id=$1',[prior.target_id])).rows[0];
  }
  await workflowAccess(c,source.id);
  let target;
  if(mode==='rerun'){
    if(source.runtime?.call)throw new AppError(409,'This run belongs to a parent workflow. Retry its failed step, or rerun the parent to create a new child.');
    if(!['succeeded','failed','cancelled'].includes(source.state))throw new AppError(409,'Wait for this execution to finish or cancel it before starting a full rerun.');
    target=await createExecution(c,req.auth.workspace.id,{id:source.workflow_id},version,source.input,null,source.runtime?.error_handler?{error_handler:source.runtime.error_handler}:{});
  }else{
    if(source.state!=='failed')throw new AppError(409,'Only a failed execution can be replayed. Refresh its details.');
    if(mode==='replay'){
      const step=(await c.query('SELECT state FROM node_executions WHERE execution_id=$1 AND node_id=$2 AND iteration_path=$3',[source.id,node_id,iteration_path])).rows[0];
      if(source.current_node!==node_id || iterationPath(source.runtime)!==iteration_path || step?.state!=='failed')throw new AppError(409,'Replay is available only for the current failed step and item. Completed steps keep their outputs.');
    }
    target=(await c.query("UPDATE executions SET state='queued',error=NULL,completed_at=NULL,resume_at=NULL,dispatch_id=gen_random_uuid() WHERE id=$1 RETURNING *",[source.id])).rows[0];
  }
  await c.query('INSERT INTO execution_recoveries(tenant_id,id,source_id,target_id,mode,node_id,actor_id,iteration_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[req.auth.workspace.id,id,source.id,target.id,mode,node_id,req.auth.user.id,iteration_path]);
  await event(c,req.auth.workspace.id,req.auth.user.id,'automation.execution.'+mode,'execution',source.id,{recovery_id:id,target_id:target.id,version_id:source.version_id,node_id,iteration_path});
  return target;
}
automationRouter.post('/schedules/preview',async(req,res)=>{
  const data=z.object({mode:z.enum(['interval','cron']).default('interval'),intervalMinutes:z.number().optional(),cron:z.string().max(120).optional(),timezone:z.string().max(80).optional()}).parse(req.body);
  const next_runs=[];let after=new Date();for(let i=0;i<5;i++){after=nextSchedule(data,after);next_runs.push(after.toISOString());}
  res.json({next_runs,timezone:data.mode==='cron'?data.timezone:'UTC'});
});
automationRouter.get('/workflows',async(req,res)=>res.json(await tx(req,async c=>(await c.query(`SELECT w.*,(SELECT count(*)::int FROM executions e WHERE e.workflow_id=w.id AND e.tenant_id=w.tenant_id) AS executions FROM workflows w WHERE NOT EXISTS(SELECT 1 FROM outreach_campaigns o WHERE o.workflow_id=w.id) AND NOT EXISTS(SELECT 1 FROM outreach_connections o WHERE o.config->>'aiWorkflowId'=w.id::text) ORDER BY updated_at DESC`)).rows)));
automationRouter.get('/subworkflows',async(req,res)=>{
 const search=z.string().trim().max(100).parse(req.query.search || '');
 res.json(await tx(req,async c=>(await c.query(`SELECT w.id AS workflow_id,w.name,v.id AS version_id,v.version,v.graph FROM workflows w JOIN workflow_versions v ON v.tenant_id=w.tenant_id AND v.id=w.published_version_id WHERE w.status='active' AND v.graph->'nodes' @> '[{"data":{"kind":"trigger.subworkflow"}}]'::jsonb AND strpos(lower(w.name),lower($1))>0 AND NOT EXISTS(SELECT 1 FROM outreach_campaigns o WHERE o.workflow_id=w.id) AND NOT EXISTS(SELECT 1 FROM outreach_connections o WHERE o.config->>'aiWorkflowId'=w.id::text) ORDER BY w.name,w.id LIMIT 200`,[search])).rows.map(({graph,...v})=>({...v,...reusableContract(graph.nodes.find(n=>n.data.kind==='trigger.subworkflow').data)}))));
});
automationRouter.get('/error-workflows',async(req,res)=>{
 const search=z.string().trim().max(100).parse(req.query.search || '');
 res.json(await tx(req,async c=>(await c.query(`SELECT w.id AS workflow_id,w.name,v.id AS version_id,v.version FROM workflows w JOIN workflow_versions v ON v.tenant_id=w.tenant_id AND v.id=w.published_version_id WHERE w.status='active' AND v.graph->'nodes' @> '[{"data":{"kind":"trigger.error"}}]'::jsonb AND strpos(lower(w.name),lower($1))>0 AND NOT EXISTS(SELECT 1 FROM outreach_campaigns o WHERE o.workflow_id=w.id) AND NOT EXISTS(SELECT 1 FROM outreach_connections o WHERE o.config->>'aiWorkflowId'=w.id::text) ORDER BY w.name,w.id LIMIT 200`,[search])).rows));
});
// Managed outreach must retain its reviewed audience, fixed steps and connection controls.
automationRouter.use('/workflows/:id',async(req,res,next)=>{
 const managed=await tx(req,c=>managedWorkflow(c,req.params.id));
 if(managed)throw new AppError(409,'Manage this campaign or WhatsApp AI connection from Outreach.');next();
});
automationRouter.post('/workflows',requireWrite,async(req,res)=>{
  const b=z.object({name:z.string().min(1).max(100),description:z.string().max(1000).default('')}).parse(req.body);
  const graph={nodes:[{id:'trigger',type:'workflow',position:{x:100,y:160},data:{kind:'trigger.manual',label:'Manual trigger'}}],edges:[]};
  res.status(201).json(await tx(req,async c=>(await c.query('INSERT INTO workflows(tenant_id,id,name,description,draft) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.auth.workspace.id,randomUUID(),b.name,b.description,graph])).rows[0]));
});
automationRouter.put('/workflows/:id',requireWrite,async(req,res)=>{
  const b=z.object({name:z.string().min(1).max(100),description:z.string().max(1000).default(''),draft:graphSchema}).parse(req.body);
  if(b.draft.nodes.some(n=>String(n.data.kind).startsWith('outreach.')))throw new AppError(400,'Configure outreach steps through a reviewed campaign or sequence.');
  res.json(await tx(req,async c=>{
    const w=(await c.query('UPDATE workflows SET name=$1,description=$2,draft=$3,updated_at=now() WHERE id=$4 RETURNING *',[b.name,b.description,b.draft,req.params.id])).rows[0];
    if(!w)throw new AppError(404,'Workflow not found.');return w;
  }));
});
automationRouter.post('/workflows/:id/publish',requireAdmin,async(req,res)=>{
  res.json(await tx(req,async c=>{
    const w=(await c.query('SELECT * FROM workflows WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(!w)throw new AppError(404,'Workflow not found.');
    const graph=await bindErrorWorkflow(c,w.id,await bindWorkflowCalls(c,w.id,validateGraph(w.draft)));
    for(const node of graph.nodes){
      if(node.data.kind==='code')for(const binding of codeSettings(node.data).secretBindings)if(!(await c.query('SELECT 1 FROM credentials WHERE id=$1',[binding.credentialId])).rowCount)throw new AppError(400,'A Code secret is unavailable in this workspace. Choose a current saved credential before publishing.');
      if(['http','graphql'].includes(node.data.kind) && node.data.credentialId && !(await c.query('SELECT 1 FROM credentials WHERE id=$1',[node.data.credentialId])).rowCount)throw new AppError(400,'The outbound credential is unavailable in this workspace. Choose a current credential before publishing.');
      if(node.data.kind==='crm.search')await validateWorkflowSearch(c,node.data);
      if(node.data.kind==='crm.note' && !node.data.recordId.startsWith('{{'))await resolveRecord(c,node.data.recordId);
      if(node.data.kind==='crm.link'){
        const settings=validateWorkflowLink(node.data),field=await recordRelationshipField(c,settings.object,settings.relationField,settings.operation);
        if(!settings.recordId.startsWith('{{'))await resolveRecord(c,settings.recordId,settings.object);
        if(settings.operation==='set' && !settings.targetId.startsWith('{{'))await resolveRecord(c,settings.targetId,field.object || null);
      }
      if(node.data.kind==='crm.assign'){
        const settings=validateWorkflowAssignment(node.data);await recordAssignmentField(c,settings.object,settings.assignmentField,settings.operation);
        if(!settings.recordId.startsWith('{{'))await resolveRecord(c,settings.recordId,settings.object);
        if(settings.operation==='set' && !settings.userId.startsWith('{{'))await requireAssignmentMember(c,settings.userId);
      }
      if(node.data.kind==='crm.stage'){
        const settings=validateWorkflowStage(node.data);
        if(!settings.recordId.startsWith('{{'))await resolveRecord(c,settings.recordId,'deals');
        if(!settings.pipelineId.startsWith('{{'))await dealStageDestination(c,settings.pipelineId,settings.stageId.startsWith('{{')?null:settings.stageId);
      }
      if(node.data.kind==='crm.tags' && !node.data.recordId.startsWith('{{'))await resolveRecord(c,node.data.recordId,'people');
    }
    const number=(await c.query('SELECT coalesce(max(version),0)+1 AS next FROM workflow_versions WHERE workflow_id=$1',[w.id])).rows[0].next;
    const v=(await c.query('INSERT INTO workflow_versions(tenant_id,id,workflow_id,version,graph) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.auth.workspace.id,randomUUID(),w.id,number,graph])).rows[0];
    const trigger=graph.nodes.find(n=>n.data.kind.startsWith('trigger.'));
    const next=trigger.data.kind==='trigger.schedule'?nextSchedule(trigger.data):null;
    await c.query("UPDATE workflows SET published_version_id=$1,status='active',next_run_at=$2,updated_at=now() WHERE id=$3",[v.id,next,w.id]);
    await event(c,req.auth.workspace.id,req.auth.user.id,'automation.workflow.published','workflow',w.id,{version:number});
    return v;
  }));
});
automationRouter.post('/workflows/:id/status',requireAdmin,async(req,res)=>{
  const b=z.object({status:z.enum(['active','paused'])}).parse(req.body);
  const w=await tx(req,async c=>{
    const saved=(await c.query('SELECT * FROM workflows WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(!saved?.published_version_id)throw new AppError(400,'Publish this workflow before activating it.');
    let next=saved.next_run_at;
    if(b.status==='active' && saved.status!=='active') {
      const version=(await c.query('SELECT graph FROM workflow_versions WHERE id=$1',[saved.published_version_id])).rows[0];
      const trigger=version.graph.nodes.find(n=>n.data.kind==='trigger.schedule');
      next=trigger?nextSchedule(trigger.data):null;
    }
    return (await c.query('UPDATE workflows SET status=$1,next_run_at=$2 WHERE id=$3 RETURNING *',[b.status,next,saved.id])).rows[0];
  });res.json(w);
});
automationRouter.get('/workflows/:id/versions',async(req,res)=>res.json(await tx(req,async c=>(await c.query('SELECT * FROM workflow_versions WHERE workflow_id=$1 ORDER BY version DESC',[req.params.id])).rows)));
automationRouter.get('/workflows/:id/webhook',requireAdmin,async(req,res)=>{
  const route=await tx(req,async c=>(await c.query('SELECT ciphertext FROM workflow_webhooks WHERE workflow_id=$1',[req.params.id])).rows[0]);
  const token=route?decryptCredential(req.auth.workspace.id,route.ciphertext).token:null;
  res.json({url:token?`${process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`}/api/hooks/${token}`:null});
});
automationRouter.post('/workflows/:id/webhook',requireAdmin,async(req,res)=>{
  const token=randomBytes(32).toString('hex');
  await tx(req,async c=>{
    const w=(await c.query('SELECT id FROM workflows WHERE id=$1',[req.params.id])).rows[0];if(!w)throw new AppError(404,'Workflow not found.');
    await c.query(`INSERT INTO workflow_webhooks(tenant_id,workflow_id,token_hash,ciphertext) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,workflow_id) DO UPDATE SET token_hash=excluded.token_hash,ciphertext=excluded.ciphertext`,[req.auth.workspace.id,w.id,tokenHash(token),encryptCredential(req.auth.workspace.id,{token})]);
  });
  res.json({url:`${process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`}/api/hooks/${token}`});
});
automationRouter.post('/workflows/:id/run',requireWrite,async(req,res)=>{
  const b=z.object({input:z.record(z.string(),z.unknown()).default({})}).parse(req.body);
  res.status(202).json(await tx(req,async c=>{
    const w=(await c.query('SELECT * FROM workflows WHERE id=$1',[req.params.id])).rows[0];
    if(!w?.published_version_id)throw new AppError(400,'Publish a version before running this workflow.');
    const v=(await c.query('SELECT * FROM workflow_versions WHERE id=$1',[w.published_version_id])).rows[0];
    return createExecution(c,req.auth.workspace.id,w,v,b.input);
  }));
});
automationRouter.get('/executions',async(req,res)=>res.json(await tx(req,async c=>(await c.query('SELECT e.*,w.name AS workflow_name FROM executions e JOIN workflows w ON w.id=e.workflow_id AND w.tenant_id=e.tenant_id ORDER BY created_at DESC LIMIT 100')).rows)));
automationRouter.get('/executions/:id',async(req,res)=>res.json(await tx(req,async c=>{
  const e=(await c.query('SELECT * FROM executions WHERE id=$1',[req.params.id])).rows[0];if(!e)throw new AppError(404,'Execution not found.');
  const version=(await c.query('SELECT graph,version FROM workflow_versions WHERE id=$1',[e.version_id])).rows[0];
  const steps=new Map((version?.graph.nodes||[]).map(n=>[n.id,n.data]));
  const workflow=(await c.query('SELECT name FROM workflows WHERE id=$1',[e.workflow_id])).rows[0];
  return {...e,current_iteration_path:iterationPath(e.runtime),workflow_name:workflow.name,version:version.version,managed:await managedWorkflow(c,e.workflow_id) || version.graph.nodes.some(n=>n.data.kind.startsWith('outreach.')),
    recoveries:(await c.query('SELECT r.*,u.name AS actor_name FROM execution_recoveries r LEFT JOIN users u ON u.id=r.actor_id WHERE r.source_id=$1 OR r.target_id=$1 ORDER BY r.created_at DESC LIMIT 50',[e.id])).rows,
    nodes:(await c.query('SELECT * FROM node_executions WHERE execution_id=$1 ORDER BY started_at,node_id,iteration_path',[e.id])).rows.map(n=>({...n,node_kind:steps.get(n.node_id)?.kind,node_label:steps.get(n.node_id)?.label||n.node_id,iteration_label:n.iteration_path?JSON.parse(n.iteration_path).map(([id,index])=>`${steps.get(id)?.label || id}: ${steps.get(id)?.kind==='split'?'branch':'item'} ${index+1}`).join(' / '):''}))};
})));
automationRouter.post('/executions/:id/cancel',requireWrite,async(req,res)=>{
  const e=await tx(req,async c=>{
    const root=(await c.query("UPDATE executions SET state='cancelled',completed_at=now() WHERE id=$1 AND state IN ('queued','running','waiting','retrying') RETURNING *",[req.params.id])).rows[0];
    if(root)await c.query("UPDATE executions SET state='cancelled',completed_at=now() WHERE runtime ? 'call' AND runtime->'call'->'ancestors' ? $1::text AND state IN ('queued','running','waiting','retrying')",[root.id]);
    return root;
  });
  if(!e)throw new AppError(409,'This execution has already finished.');res.json(e);
});
automationRouter.post('/executions/:id/retry',requireWrite,async(req,res)=>{
  res.json(await tx(req,c=>recover(c,req,req.params.id,{id:randomUUID(),mode:'retry'})));
});
automationRouter.post('/executions/:id/recover',requireWrite,async(req,res)=>{
  const b=z.object({id:z.uuid(),mode:z.enum(['rerun','replay','retry']),node_id:z.string().min(1).max(100).optional(),iteration_path:iterationPathSchema.optional()}).strict().superRefine((v,c)=>{
    if(v.mode==='replay' && !v.node_id)c.addIssue({code:'custom',message:'Choose the failed step to replay.'});
    if(v.mode!=='replay' && v.node_id)c.addIssue({code:'custom',message:'Only failed-step replay accepts a step ID.'});
    if(v.mode!=='replay' && v.iteration_path!==undefined)c.addIssue({code:'custom',message:'Only failed-step replay accepts an iteration path.'});
  }).parse(req.body);
  res.status(202).json(await tx(req,c=>recover(c,req,req.params.id,b)));
});
automationRouter.get('/credentials',requireAdmin,async(req,res)=>res.json(await tx(req,async c=>(await c.query('SELECT id,name,provider,created_at FROM credentials ORDER BY name')).rows)));
automationRouter.post('/credentials',requireAdmin,async(req,res)=>{
  const b=z.object({name:z.string().min(1).max(100),provider:z.enum(['bearer','basic','header']),value:z.string().min(1).max(5000),header:z.string().regex(/^[a-zA-Z0-9-]+$/).optional()}).parse(req.body);
  if(b.provider==='header' && !b.header)throw new AppError(400,'Specify the header name.');
  res.status(201).json(await tx(req,async c=>(await c.query('INSERT INTO credentials(tenant_id,id,name,provider,ciphertext) VALUES($1,$2,$3,$4,$5) RETURNING id,name,provider,created_at',[req.auth.workspace.id,randomUUID(),b.name,b.provider,encryptCredential(req.auth.workspace.id,{value:b.value,header:b.header})])).rows[0]));
});
automationRouter.delete('/credentials/:id',requireAdmin,async(req,res)=>{
  await tx(req,c=>c.query('DELETE FROM credentials WHERE id=$1',[req.params.id]));res.json({ok:true});
});
