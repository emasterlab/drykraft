import {z} from 'zod';
import {AppError} from './model.mjs';

const name=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/).refine(v=>!['__proto__','prototype','constructor'].includes(v));
const field=z.object({type:z.enum(['string','number','boolean','object','array']),required:z.boolean().default(true),nullable:z.boolean().default(false)}).strict();
const schema=z.record(name,field).refine(v=>Object.keys(v).length<=50,'Use at most 50 fields.');
const reserved=['nodes','last','today','dueIn30Days','item','index','loop'];
export function reusableContract(data){
 const result=z.object({inputs:schema,outputs:schema}).safeParse(data);
 if(!result.success)throw new AppError(400,'Define input and output fields with type, optional required and nullable flags; use at most 50 named fields.');
 if(Object.keys(result.data.inputs).some(k=>reserved.includes(k)))throw new AppError(400,'Input names cannot use nodes, last, today, dueIn30Days, item, index or loop.');
 return result.data;
}
export function contractValue(definition,value,label='Sub-workflow input',mapping=false){
 if(!value || typeof value!=='object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value))>262144)throw new AppError(400,label+' must be a JSON object within 256 KB.');
 if(Object.keys(value).some(k=>!Object.hasOwn(definition,k)))throw new AppError(400,label+' contains an undeclared field.');
 for(const [key,rule] of Object.entries(definition)){
  if(!Object.hasOwn(value,key)){if(rule.required)throw new AppError(400,label+' needs '+key+'.');continue;}
  const v=value[key],type=Array.isArray(v)?'array':typeof v;
  if(mapping && typeof v==='string' && /^\{\{[A-Za-z0-9_.-]+\}\}$/.test(v) && !v.slice(2,-2).split('.').some(k=>['__proto__','prototype','constructor'].includes(k)))continue;
  if(v===null? !rule.nullable : type!==rule.type || rule.type==='number'&&!Number.isFinite(v))throw new AppError(400,label+' field '+key+' must be '+rule.type+(rule.nullable?' or null':'')+'.');
 }
 return value;
}
export function callSettings(raw){
 const result=z.object({workflowId:z.uuid(),versionId:z.uuid(),values:z.record(z.string(),z.unknown())}).safeParse(raw);
 if(!result.success)throw new AppError(400,'Choose a published sub-workflow version and a JSON input object.');
 if(Buffer.byteLength(JSON.stringify(result.data.values))>262144)throw new AppError(400,'Sub-workflow input mappings exceed 256 KB.');
 return result.data;
}
export async function reusableVersion(c,workflowId,versionId,{active=true}={}){
 const v=(await c.query(`SELECT v.*,w.name,w.status FROM workflow_versions v JOIN workflows w ON w.tenant_id=v.tenant_id AND w.id=v.workflow_id WHERE v.id=$1 AND w.id=$2 AND NOT EXISTS(SELECT 1 FROM outreach_campaigns o WHERE o.workflow_id=w.id) AND NOT EXISTS(SELECT 1 FROM outreach_connections o WHERE o.config->>'aiWorkflowId'=w.id::text) ${active?'FOR SHARE OF w':''}`,[versionId,workflowId])).rows[0];
 const t=v?.graph.nodes.find(n=>n.data.kind==='trigger.subworkflow');
 if(!t || active&&v.status!=='active')throw new AppError(400,'This published sub-workflow is unavailable or paused in this workspace.');
 if(v.graph.nodes.some(n=>n.data.kind.startsWith('outreach.')))throw new AppError(400,'Managed outreach workflows cannot be called here.');
 return {...v,contract:reusableContract(t.data)};
}
export async function bindWorkflowCalls(c,workflowId,graph){
 // Pin exact immutable versions. Published ancestors cannot silently follow a child's next publication.
 let visited=0;
 async function walk(g,ancestors){
  for(const node of g.nodes.filter(n=>n.data.kind==='workflow.call')){
   if(++visited>1000)throw new AppError(400,'The published sub-workflow tree exceeds 1,000 calls.');
   const d=callSettings(node.data);
   if(ancestors.includes(d.workflowId))throw new AppError(400,'Sub-workflows cannot call themselves or an ancestor.');
   if(ancestors.length>5)throw new AppError(400,'Use at most five levels of sub-workflow calls.');
   const v=await reusableVersion(c,d.workflowId,d.versionId);
   contractValue(v.contract.inputs,d.values,'Sub-workflow input mapping',true);
   if(ancestors.length===1){node.data.workflowName=v.name;node.data.versionNumber=v.version;}
   await walk(v.graph,[...ancestors,d.workflowId]);
  }
 }
 await walk(graph,[workflowId]);return graph;
}
