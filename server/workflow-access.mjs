import {AppError} from './model.mjs';

function denied(message='Workflow access was disabled or reduced. Ask a workspace administrator to review this version’s access.'){
 const error=new AppError(403,message);error.workflowAccessDenied=true;return error;
}
const uuid=/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Read the real lineage, not caller-supplied input or a cached permission snapshot.
export async function workflowAccess(c,executionId){
 const pending=[{id:executionId,path:[]}],seen=new Set(),executions=[];
 while(pending.length){
  const {id,path}=pending.pop();if(path.includes(id))throw denied('The workflow access lineage contains a cycle.');if(seen.has(id))continue;
  if(!uuid.test(id) || seen.size>=16)throw denied('The workflow access lineage is unavailable or exceeds 16 runs.');
  seen.add(id);
  const e=(await c.query('SELECT id,version_id,runtime FROM executions WHERE id=$1',[id])).rows[0];
  if(!e)throw denied('A parent workflow is unavailable in this workspace.');
  executions.push(e);
  for(const parent of [e.runtime?.call?.parent_id,e.runtime?.error_handler?.source_id])if(parent)pending.push({id:parent,path:[...path,id]});
 }
 const versionIds=[...new Set(executions.map(e=>e.version_id))].sort();
 // Hold the account locks through the business effect; revocation waits for a committed effect, then wins the next check.
 const rows=(await c.query("SELECT id,name,permissions,workflow_scope,disabled FROM service_accounts WHERE id=ANY($1::uuid[]) AND purpose='workflow' ORDER BY id FOR SHARE",[versionIds])).rows;
 if(rows.length!==versionIds.length || rows.some(s=>s.disabled))throw denied();
 const current=executions[0];
 if(rows.some(s=>!s.workflow_scope.versions?.includes(current.version_id)))throw denied('A parent workflow does not allow this published version.');
 await c.query("SELECT set_config('app.service_account_id',$1,true)",[current.version_id]);
 return {id:current.version_id,accounts:rows};
}

export function requireWorkflowObject(access,object,action){
 if(access.accounts.some(s=>!Object.hasOwn(s.permissions,object) || !s.permissions[object].includes('read') || !s.permissions[object].includes(action)))throw denied(`Workflow access does not allow ${action} on ${object}.`);
}
export function requireWorkflowResource(access,type,id){
 if(access.accounts.some(s=>!s.workflow_scope[type]?.includes(id)))throw denied('Workflow access does not allow this saved resource.');
}
export function requireWorkflowStep(access,kind){
 if(access.accounts.some(s=>!s.workflow_scope.kinds?.includes(kind)))throw denied('Workflow access does not allow this step.');
}

// Native model helpers share this context, including relationship reads inside Finance/CRM validation.
export async function workflowObjectAccess(c,object,action){
 if(c.workflowPrincipal)requireWorkflowObject(c.workflowPrincipal,object,action);
 if(c.apiPrincipal && (!Object.hasOwn(c.apiPrincipal.permissions,object) || !c.apiPrincipal.permissions[object].includes('read') || !c.apiPrincipal.permissions[object].includes(action)))throw new AppError(403,`This API key does not allow ${action} access to ${object}.`);
}
export async function workflowTransactionContext(c,executionId,kind=null){
 const access=await workflowAccess(c,executionId);
 if(kind)requireWorkflowStep(access,kind);
 c.workflowPrincipal=access;
 return access;
}
export async function publishedWorkflowAccess(c,versionId){
 const s=(await c.query("SELECT id,name,permissions,workflow_scope,disabled FROM service_accounts WHERE id=$1 AND purpose='workflow' FOR SHARE",[versionId])).rows[0];
 if(!s || s.disabled || !s.workflow_scope.versions?.includes(versionId))throw denied();
 return {id:versionId,accounts:[s]};
}
