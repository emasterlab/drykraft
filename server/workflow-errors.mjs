import {z} from 'zod';
import {AppError} from './model.mjs';
import {createExecution,iterationPath} from './automation.mjs';
import {billingAccess} from './billing.mjs';
import {workflowAccess,publishedWorkflowAccess} from './workflow-access.mjs';

export function errorWorkflowSettings(data){
 if(data.errorWorkflow===undefined || data.errorWorkflow===null)return null;
 const result=z.object({workflowId:z.uuid(),versionId:z.uuid(),workflowName:z.string().max(100).optional(),versionNumber:z.number().int().positive().optional()}).strict().safeParse(data.errorWorkflow);
 if(!result.success)throw new AppError(400,'Choose an exact published error workflow version.');
 if(data.kind==='trigger.error')throw new AppError(400,'Error workflows cannot configure another automatic error handler.');
 return result.data;
}
async function handlerVersion(c,settings){
 const v=(await c.query(`SELECT v.*,w.name,w.status FROM workflow_versions v JOIN workflows w ON w.tenant_id=v.tenant_id AND w.id=v.workflow_id WHERE v.id=$1 AND w.id=$2 AND NOT EXISTS(SELECT 1 FROM outreach_campaigns o WHERE o.workflow_id=w.id) AND NOT EXISTS(SELECT 1 FROM outreach_connections o WHERE o.config->>'aiWorkflowId'=w.id::text) FOR SHARE OF w`,[settings.versionId,settings.workflowId])).rows[0];
 return v?.status==='active' && v.graph.nodes.some(n=>n.data.kind==='trigger.error') && !v.graph.nodes.some(n=>n.data.kind.startsWith('outreach.') || n.data.errorWorkflow)?v:null;
}
export async function bindErrorWorkflow(c,workflowId,graph){
 const trigger=graph.nodes.find(n=>n.data.kind.startsWith('trigger.')),settings=errorWorkflowSettings(trigger.data);
 if(!settings)return graph;
 if(settings.workflowId===workflowId)throw new AppError(400,'A workflow cannot handle its own failure.');
 const v=await handlerVersion(c,settings);
 if(!v)throw new AppError(400,'The error workflow is unavailable, paused or does not have an Error trigger in this workspace.');
 trigger.data.errorWorkflow={workflowId:v.workflow_id,versionId:v.id,workflowName:v.name,versionNumber:v.version};return graph;
}
export async function failExecution(c,tenantId,id,dispatchId,message){
 const source=(await c.query("SELECT e.*,v.graph FROM executions e JOIN workflow_versions v ON v.tenant_id=e.tenant_id AND v.id=e.version_id WHERE e.id=$1 AND e.dispatch_id=$2 AND e.state IN ('queued','running','retrying','waiting') FOR UPDATE OF e",[id,dispatchId])).rows[0];
 if(!source)return null;
 await c.query("UPDATE executions SET state='failed',completed_at=now(),resume_at=NULL,error=$1 WHERE id=$2",[message,id]);
 // One automatic handler per source run. Retry keeps the binding; full rerun gets a new run ID.
 if(source.runtime?.error_handler || source.runtime?.error_workflow)return source;
 const settings=errorWorkflowSettings(source.graph.nodes.find(n=>n.data.kind.startsWith('trigger.')).data);
 if(!settings)return source;
 const v=await handlerVersion(c,settings);
 let binding={state:'skipped',reason:v?'workspace_plan_inactive':'handler_unavailable_or_paused'};
 if(v && (await billingAccess(c,tenantId)).access){
  try{
   await workflowAccess(c,id);await publishedWorkflowAccess(c,v.id);
   const input={failure:{execution_id:id,workflow_id:source.workflow_id,version_id:source.version_id,node_id:source.current_node,iteration_path:iterationPath(source.runtime),attempts:source.attempts,message:String(message).slice(0,2000),failed_at:new Date().toISOString()}};
   const handler=await createExecution(c,tenantId,{id:v.workflow_id},v,input,null,{error_handler:{source_id:id}});
   binding={state:'queued',execution_id:handler.id,workflow_id:v.workflow_id,version_id:v.id,version:v.version};
  }catch(error){if(!error.workflowAccessDenied)throw error;binding={state:'skipped',reason:'workflow_access_disabled_or_reduced'};}
 }
 await c.query("UPDATE executions SET runtime=jsonb_set(runtime,'{error_workflow}',$1::jsonb) WHERE id=$2",[JSON.stringify(binding),id]);return {...source,state:'failed',error_workflow:binding};
}
