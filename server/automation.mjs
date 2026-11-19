import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { billingAccess } from './billing.mjs';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { AppError,keySchema } from './model.mjs';
import {validateDateTime} from './workflow-date-time.mjs';
import { workflowSearchSchema } from './workflow-search.mjs';
import {validateGraphQL} from './workflow-graphql.mjs';
import {reusableContract,contractValue,callSettings} from './workflow-calls.mjs';
import {errorWorkflowSettings} from './workflow-errors.mjs';
import {validateCsv} from './workflow-csv.mjs';
import {validateXml} from './workflow-xml.mjs';
import {splitSettings,mergeSettings,splitPlan,validateBranches} from './workflow-branches.mjs';
import {codeSettings} from './workflow-code.mjs';
import {publishedWorkflowAccess,requireWorkflowObject,requireWorkflowStep} from './workflow-access.mjs';

export const listKinds=['list.filter','list.map','list.sort','list.limit','list.deduplicate','list.aggregate'];
const supportedKinds=['trigger.manual','trigger.event','trigger.schedule','trigger.webhook','trigger.subworkflow','trigger.error','workflow.call','workflow.return','condition','switch','loop','split','merge',...listKinds,'data.csv','data.xml','code','date.time','wait','set','crm.search','crm.note','crm.tags','crm.stage','crm.link','crm.assign','crm.create','crm.update','finance.create','calendar.create','http','graphql','log','outreach.send','outreach.reply'];
const logicPath=z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/).refine(v=>!v.split('.').some(k=>['__proto__','prototype','constructor'].includes(k)),'Use a plain context path.');
export const workflowNoteSchema=z.object({recordId:z.union([z.string().uuid(),z.string().regex(/^\{\{[a-zA-Z0-9_.-]+\}\}$/).refine(v=>logicPath.safeParse(v.slice(2,-2)).success,'Use a plain context path.')]),note:z.string().trim().min(1).max(10000)});
export function validateWorkflowNote(raw,resolved=false) {
  const result=workflowNoteSchema.safeParse(raw);
  if(!result.success)throw new AppError(400,result.error.issues[0].path[0]==='recordId'?'Add note needs a record UUID or an exact context expression with a plain path.':'Add note needs nonempty plain text of at most 10,000 characters.');
  if(resolved && !z.string().uuid().safeParse(result.data.recordId).success)throw new AppError(400,'The Add note Record ID must resolve to a record UUID.');
  return result.data;
}
export function validateWorkflowTags(raw,resolved=false) {
  const target=workflowNoteSchema.shape.recordId.safeParse(raw.recordId);
  if(!target.success || resolved && !z.string().uuid().safeParse(raw.recordId).success)throw new AppError(400,'Contact ID must be a record UUID or an exact context expression that resolves to one.');
  if(!['add','remove'].includes(raw.operation))throw new AppError(400,'Choose Add tags or Remove tags.');
  let tags=raw.tags;
  if(!resolved && typeof tags==='string'){
    if(tags.length>10000)throw new AppError(400,'Keep the tag input within 10,000 characters.');
    const source=tags.trim();
    if(/^\{\{[a-zA-Z0-9_.-]+\}\}$/.test(source)){
      if(!logicPath.safeParse(source.slice(2,-2)).success)throw new AppError(400,'Use a plain context path for the tag list.');
      return {recordId:target.data,operation:raw.operation,tags:source};
    }
    tags=source.split(/\r?\n/).filter(t=>t.trim());
  }
  const list=z.array(z.string().trim().min(1).max(resolved?80:500)).min(1).max(100).safeParse(tags);
  if(!list.success)throw new AppError(400,resolved?'Tags must resolve to 1-100 nonempty text values, each at most 80 characters.':'Enter 1-100 tags, one per line, or an exact context expression for an array.');
  return {recordId:target.data,operation:raw.operation,tags:list.data};
}
export function validateWorkflowStage(raw,resolved=false) {
  const values={};
  for(const key of ['recordId','pipelineId','stageId']) {
    const literal=key==='stageId'?z.string().regex(/^[a-z0-9_-]{1,40}$/):z.string().uuid();
    const schema=resolved?literal:z.union([literal,workflowNoteSchema.shape.recordId.options[1]]);
    const result=schema.safeParse(raw[key]);
    if(!result.success)throw new AppError(400,key==='stageId'?'Stage must be a stage ID or exact context expression resolving to one.':'Deal and pipeline IDs must be UUIDs or exact context expressions resolving to UUIDs.');
    values[key]=result.data;
  }
  if(!['keep','Open','Won','Lost'].includes(raw.status ?? 'keep'))throw new AppError(400,'Choose Keep current status, Open, Won or Lost.');
  return {...values,status:raw.status ?? 'keep'};
}
export function validateWorkflowLink(raw,resolved=false) {
  const object=keySchema.safeParse(raw.object),field=keySchema.safeParse(raw.relationField);
  if(!object.success || !field.success)throw new AppError(400,'Choose an object and its relationship field.');
  if(!['set','clear'].includes(raw.operation))throw new AppError(400,'Choose Set relationship or Clear relationship.');
  const ids={};
  for(const key of raw.operation==='clear'?['recordId']:['recordId','targetId']){
    const result=(resolved?z.string().uuid():workflowNoteSchema.shape.recordId).safeParse(raw[key]);
    if(!result.success)throw new AppError(400,'Record IDs must be UUIDs or exact context expressions resolving to UUIDs.');
    ids[key]=result.data;
  }
  return {object:object.data,relationField:field.data,operation:raw.operation,...ids};
}
export function validateWorkflowAssignment(raw,resolved=false) {
  const object=keySchema.safeParse(raw.object),field=keySchema.safeParse(raw.assignmentField);
  if(!object.success || !field.success)throw new AppError(400,'Choose an object and its user field.');
  if(!['set','clear'].includes(raw.operation))throw new AppError(400,'Choose Assign member or Clear assignment.');
  const ids={};
  for(const key of raw.operation==='clear'?['recordId']:['recordId','userId']){
    const result=(resolved?z.string().uuid():workflowNoteSchema.shape.recordId).safeParse(raw[key]);
    if(!result.success)throw new AppError(400,'Record and member IDs must be UUIDs or exact context expressions resolving to UUIDs.');
    ids[key]=result.data;
  }
  return {object:object.data,assignmentField:field.data,operation:raw.operation,...ids};
}
const comparison=z.object({field:logicPath,operator:z.enum(['eq','neq','gte','gt','lte','lt','contains','exists']),value:z.unknown().optional()}).superRefine((d,c)=>{if(d.operator!=='exists' && !Object.hasOwn(d,'value'))c.addIssue({code:'custom',message:'Supply a comparison value.'});});
const switchCase=comparison.safeExtend({id:z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).refine(v=>v!=='default'),label:z.string().trim().min(1).max(60)});
export function validateLogic(d) {
  if(d.kind==='loop' && !logicPath.safeParse(d.source).success)throw new AppError(400,'Enter a plain Loop List source such as items or last.items, without expression braces or prototype segments.');
  if(d.kind==='switch'){
    const cases=z.array(switchCase).min(1).max(10).parse(d.cases);
    if(new Set(cases.map(c=>c.id)).size!==cases.length)throw new AppError(400,'Switch case IDs must be unique.');
  }
  if(!listKinds.includes(d.kind))return;
  logicPath.parse(d.source);
  if(d.kind==='list.filter')comparison.parse(d);
  if(d.kind==='list.map')z.record(z.string(),z.unknown()).parse(d.values);
  if(d.kind==='list.sort'){logicPath.parse(d.field);z.enum(['asc','desc']).parse(d.direction);}
  if(d.kind==='list.limit'){z.number().int().min(0).max(1000).parse(d.offset);z.number().int().min(1).max(1000).parse(d.limit);}
  if(d.kind==='list.deduplicate')logicPath.parse(d.field);
  if(d.kind==='list.aggregate'){
    z.enum(['count','sum','avg','min','max']).parse(d.operation);
    if(d.operation!=='count')logicPath.parse(d.field);
    if(d.groupBy)logicPath.parse(d.groupBy);
  }
}
export function switchBranch(d,context) {return d.cases.find(c=>evaluateCondition(c,context))?.id || 'default';}
export const graphSchema=z.object({
  nodes:z.array(z.object({id:z.string().min(1).max(80),type:z.literal('workflow'),position:z.object({x:z.number(),y:z.number()}),data:z.object({kind:z.enum(supportedKinds),label:z.string().min(1).max(100)}).passthrough()})).min(1).max(100),
  edges:z.array(z.object({id:z.string(),source:z.string(),target:z.string(),sourceHandle:z.string().nullish(),targetHandle:z.string().nullish(),label:z.string().optional()})).max(150),
  groups:z.array(z.object({id:z.string().regex(/^group:[a-zA-Z0-9-]{1,80}$/),label:z.string().trim().min(1).max(100),nodes:z.array(z.string().min(1).max(80)).min(1).max(100)})).max(50).optional(),
}).superRefine((graph,ctx)=>{
  const nodes=new Set(graph.nodes.map(n=>n.id)),groups=new Set(),members=new Set();
  for(const group of graph.groups || []){
    if(nodes.has(group.id)||groups.has(group.id))ctx.addIssue({code:'custom',message:'Use a unique group ID.'});groups.add(group.id);
    for(const id of group.nodes){if(!nodes.has(id)||members.has(id))ctx.addIssue({code:'custom',message:'Every group member must be an existing step in only one group.'});members.add(id);}
  }
});
export function validateGraph(raw) {
  const graph=graphSchema.parse(raw);
  const ids=new Set(graph.nodes.map(n=>n.id));
  if(ids.size!==graph.nodes.length)throw new AppError(400,'Node IDs must be unique.');
  const triggers=graph.nodes.filter(n=>n.data.kind.startsWith('trigger.'));
  if(triggers.length!==1)throw new AppError(400,'A workflow needs exactly one trigger.');
  for(const e of graph.edges)if(!ids.has(e.source)||!ids.has(e.target))throw new AppError(400,'Connect every edge to an existing node.');
  const seen=new Set(),active=new Set();
  function visit(id){
    if(active.has(id))throw new AppError(400,'Use a loop node for repetition. Direct cycles cannot be published.');
    if(seen.has(id))return;
    active.add(id);
    for(const e of graph.edges.filter(e=>e.source===id))visit(e.target);
    active.delete(id);seen.add(id);
  }
  visit(triggers[0].id);
  if(seen.size!==ids.size)throw new AppError(400,'Connect every node to the trigger.');
  for(const n of graph.nodes){
    const d=n.data,out=graph.edges.filter(e=>e.source===n.id);
    if(d.errorWorkflow && !d.kind.startsWith('trigger.'))throw new AppError(400,'Configure the error workflow on the trigger only.');
    if(d.kind.startsWith('trigger.'))errorWorkflowSettings(d);
    validateLogic(d);
    if(d.kind==='split')splitSettings(d);
    if(d.kind==='merge')mergeSettings(d);
    if(!['condition','switch','loop','split'].includes(d.kind) && out.length>1)throw new AppError(400,'Use Condition, Switch or Loop to route multiple paths.');
    if(d.kind==='loop' && (!out.some(e=>e.sourceHandle==='each') || out.some(e=>!['each','done'].includes(e.sourceHandle)) || new Set(out.map(e=>e.sourceHandle)).size!==out.length))throw new AppError(400,'Loop needs one Each item path and at most one Completed path.');
    if(d.kind==='condition' && (out.some(e=>!['true','false'].includes(e.sourceHandle)) || new Set(out.map(e=>e.sourceHandle)).size!==out.length))throw new AppError(400,'Connect one path to each condition output.');
    if(d.kind==='switch' && (out.some(e=>!['default',...d.cases.map(c=>c.id)].includes(e.sourceHandle)) || new Set(out.map(e=>e.sourceHandle)).size!==out.length))throw new AppError(400,'Connect at most one path to each current Switch case or default output.');
    if(d.kind==='trigger.event')z.string().min(1).max(100).parse(d.event);
    if(d.kind==='trigger.subworkflow')reusableContract(d);
    if(d.kind==='workflow.call')callSettings(d);
    if(d.kind==='workflow.return'){
      if(triggers[0].data.kind!=='trigger.subworkflow' || out.length)throw new AppError(400,'Return values must end a reusable sub-workflow path.');
      z.record(z.string(),z.unknown()).parse(d.values);
      if(Buffer.byteLength(JSON.stringify(d.values))>262144)throw new AppError(400,'Return mappings exceed 256 KB.');
      contractValue(reusableContract(triggers[0].data).outputs,d.values,'Sub-workflow return mapping',true);
    }
    if(d.kind==='trigger.schedule')nextSchedule(d);
    if(d.kind==='wait')z.number().int().min(1).max(2592000).parse(d.seconds);
    if(d.kind==='crm.search')workflowSearchSchema.parse(d);
    if(d.kind==='crm.note')validateWorkflowNote(d);
    if(d.kind==='crm.tags')validateWorkflowTags(d);
    if(d.kind==='crm.stage')validateWorkflowStage(d);
    if(d.kind==='crm.link')validateWorkflowLink(d);
    if(d.kind==='crm.assign')validateWorkflowAssignment(d);
    if(d.kind==='date.time')validateDateTime(d);
    if(d.kind==='data.csv')validateCsv(d);
    if(d.kind==='data.xml')validateXml(d);
    if(d.kind==='code')codeSettings(d);
    if(['crm.create','crm.update'].includes(d.kind)){z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).parse(d.object);z.record(z.string(),z.unknown()).parse(d.values);}
    if(d.kind==='calendar.create'){z.string().uuid().parse(d.calendarId);z.record(z.string(),z.unknown()).parse(d.values);}
    if(d.kind==='finance.create'){z.enum(['invoices','purchase_orders','expenses']).parse(d.object);z.record(z.string(),z.unknown()).parse(d.values);}
    if(d.kind==='crm.update')z.string().min(1).parse(d.recordId);
    if(d.kind==='condition'){z.string().min(1).max(100).parse(d.field);z.enum(['eq','neq','gte','gt','lte','lt','contains','exists']).parse(d.operator);}
    if(d.kind==='set')z.record(z.string(),z.unknown()).parse(d.values);
    if(d.kind==='http'){z.string().url().parse(d.url);z.enum(['GET','POST','PUT','PATCH','DELETE']).parse(d.method || 'GET');}
    if(d.kind==='graphql')validateGraphQL(d);
    if(['http','graphql'].includes(d.kind) && d.credentialId)z.string().uuid().parse(d.credentialId);
    if(d.kind.startsWith('outreach.'))z.string().uuid().parse(d.connectionId);
  }
  // Body paths end the current item. They must not join the once-only Completed path or be entered from outside.
  const reachable=id=>{const found=new Set();function walk(key){if(!key || found.has(key))return;found.add(key);for(const e of graph.edges.filter(e=>e.source===key))walk(e.target);}walk(id);return found;};
  const bodies=[];
  for(const n of graph.nodes.filter(n=>n.data.kind==='loop')){
    const each=graph.edges.find(e=>e.source===n.id && e.sourceHandle==='each'),done=graph.edges.find(e=>e.source===n.id && e.sourceHandle==='done'),body=reachable(each.target),after=reachable(done?.target);
    if([...body].some(id=>after.has(id)))throw new AppError(400,'Keep Loop item steps separate from its Completed path. End each item path without connecting it back to the Loop.');
    if(graph.edges.some(e=>body.has(e.target) && !body.has(e.source) && e!==each))throw new AppError(400,'Enter Loop item steps only through their Each item path.');
    bodies.push(body);
  }
  const branchBodies=validateBranches(graph);
  if(graph.nodes.some(n=>[...bodies,...branchBodies].filter(body=>body.has(n.id)).length>5))throw new AppError(400,'Workflows support at most five nested Loops or Splits.');
  if(triggers[0].data.kind==='trigger.subworkflow'){
    for(const n of graph.nodes){
      const out=graph.edges.filter(e=>e.source===n.id),inItem=bodies.some(body=>body.has(n.id));
      if(n.data.kind==='workflow.return' && inItem)throw new AppError(400,'Return values belong after the Loop Completed path, outside item steps.');
      if(inItem)continue;
      if(!out.length && n.data.kind!=='workflow.return' || n.data.kind==='loop'&&!out.some(e=>e.sourceHandle==='done'))throw new AppError(400,'Every reusable workflow path must end with Return values.');
      if(n.data.kind==='condition' && out.length!==2 || n.data.kind==='switch'&&out.length!==n.data.cases.length+1)throw new AppError(400,'Connect every condition or Switch path in a reusable workflow.');
    }
  }
  return graph;
}
export function iterationPath(runtime) {
 const scopes=runtime?.scopes || (runtime?.loops || []).map(f=>({kind:'loop',node_id:f.node_id}));
 return scopes.length?JSON.stringify(scopes.map(s=>{const f=runtime[s.kind==='split'?'splits':'loops'].find(f=>f.node_id===s.node_id);return [f.node_id,f.index];})):'';
}
export const iterationPathSchema=z.string().max(1024).refine(v=>{
  if(v==='')return true;
  try {const parsed=z.array(z.tuple([z.string().min(1).max(80),z.number().int().min(0).max(999)])).min(1).max(5).parse(JSON.parse(v));return JSON.stringify(parsed)===v;}catch{return false;}
},'Use the saved iteration path from execution details.');
export function loopInput(d,context) {
  validateLogic({kind:'loop',source:d.source});const items=resolvePath(context,d.source);
  if(!Array.isArray(items))throw new AppError(400,`The Loop source ${d.source} must contain an array.`);
  if(items.length>1000)throw new AppError(400,'Loop supports up to 1,000 items. Limit or split the source before running it.');
  if(Buffer.byteLength(JSON.stringify(items))>262144)throw new AppError(400,'Loop input exceeds 256 KB. Map only the fields each item needs.');
  return {items,input_count:items.length};
}
function loopContext(frame) {
  const {base,items,index,node_id}=frame,loop={index,number:index+1,total:items.length,first:index===0,last:index===items.length-1};
  return {...base,item:items[index],index,loop,nodes:{...(base.nodes || {}),[node_id]:{input_count:items.length,index}},last:{item:items[index],index}};
}
function splitContext(frame) {
 const b=frame.branches[frame.index];
 return {...frame.base,branch:{id:b.id,label:b.label,index:frame.index,number:frame.index+1,total:frame.branches.length}};
}
export function advanceWorkflow(graph,node,context,runtime,output,branch,completed=false) {
 // Control state is server-owned, never trigger input or Set values. Old Loop cursors remain compatible.
 const state=structuredClone(runtime || {});state.loops ||= [];state.splits ||= [];
 state.scopes ||= state.loops.map(f=>({kind:'loop',node_id:f.node_id}));state.steps=(state.steps || 0)+1;
 if(state.steps>10000)throw new AppError(400,'Workflow exceeded 10,000 visited steps. Narrow its input or shorten branch and item paths.');
 const completions=[],edge=(id,handle)=>graph.edges.find(e=>e.source===id && (handle===undefined || e.sourceHandle===handle));
 const put=(base,id,value)=>({...base,nodes:{...(base.nodes || {}),[id]:value},last:value});
 let next,entering=false;
 if(!completed && (node.data.kind==='split' || node.data.kind==='loop' && output.items.length)){
  if(state.scopes.length>=5)throw new AppError(400,'Workflows support at most five nested Loops or Splits.');
  const frame=node.data.kind==='split'?{node_id:node.id,index:0,...splitPlan(graph,node),results:[],base:context}:{node_id:node.id,index:0,items:output.items,results:[],base:context};
  state.scopes.push({kind:node.data.kind,node_id:node.id});state[node.data.kind==='split'?'splits':'loops'].push(frame);
  context=node.data.kind==='split'?splitContext(frame):loopContext(frame);
  next=node.data.kind==='split'?frame.branches[0].target:edge(node.id,'each')?.target;entering=true;
  if(!next)throw new AppError(400,'Loop needs a connected Each item path.');
  output=node.data.kind==='split'?{branch_count:frame.branches.length,completed_count:0}:{input_count:frame.items.length,completed_count:0};
 }else{
  if(node.data.kind==='loop' && !completed)output={items:[],count:0,input_count:0};
  context=put(node.data.kind==='set'?{...context,...output}:context,node.id,output);
  next=node.data.kind==='split'?splitPlan(graph,node).merge_id:edge(node.id,node.data.kind==='loop'?'done':['condition','switch'].includes(node.data.kind)?branch:undefined)?.target;
 }
 while(state.scopes.length){
  const scope=state.scopes.at(-1),split=scope.kind==='split',frames=state[split?'splits':'loops'],frame=frames.at(-1);
  if(split?next!==frame.merge_id:!!next){if(split && !next)throw new AppError(400,'A Split path ended before its paired Merge.');break;}
  if(split){
   const b=frame.branches[frame.index],nodes=Object.fromEntries(Object.entries(context.nodes || {}).filter(([id])=>!Object.hasOwn(frame.base.nodes || {},id)));
   frame.results.push({id:b.id,label:b.label,output:context.last,nodes});
  }else frame.results.push(context.last);
  if(Buffer.byteLength(JSON.stringify(frame.results))>262144)throw new AppError(400,split?'Split collected output exceeds 256 KiB. End paths with only needed fields. Completed actions remain saved.':'Loop collected output exceeds 256 KB. End its item path with Map or Set values containing only needed fields. Completed actions remain saved.');
  frame.index++;
  if(frame.index<(split?frame.branches.length:frame.items.length)){
   context=split?splitContext(frame):loopContext(frame);next=split?frame.branches[frame.index].target:edge(frame.node_id,'each').target;continue;
  }
  frames.pop();state.scopes.pop();
  const result=split?{branches:frame.results.map(({nodes,...b})=>b),count:frame.results.length}:{items:frame.results,count:frame.results.length,input_count:frame.items.length};
  const base=split?{...frame.base,nodes:{...(frame.base.nodes || {}),...Object.assign({},...frame.results.map(b=>b.nodes))}}:frame.base;
  context=put(base,frame.node_id,result);completions.push({node_id:frame.node_id,iteration_path:iterationPath(state),output:result});
  next=split?frame.merge_id:edge(frame.node_id,'done')?.target;
 }
 // ponytail: bounded JSON cursors under one execution lease; parallel branches and object storage can replace ordered traversal when throughput requires them.
 if(Buffer.byteLength(JSON.stringify(state))>1048576)throw new AppError(400,'Loop or Split control state exceeds 1 MB. Narrow input and collected outputs.');
 return {context,runtime:state,output,next:next || null,entering,completions};
}
export function resolvePath(value,path) {return path.split('.').reduce((v,key)=>v!=null && !['__proto__','prototype','constructor'].includes(key) && Object.hasOwn(Object(v),key)?v[key]:undefined,value);}
export function interpolate(value,context,budget=null) {
  const charge=text=>{if(budget && (budget.bytes+=Buffer.byteLength(text))>262144)throw new AppError(400,'List output exceeds 256 KB. Map only the fields the next step needs.');};
  if(typeof value==='string'){
    const exact=value.match(/^\{\{([a-zA-Z0-9_.-]+)\}\}$/);
    const resolved=exact?resolvePath(context,exact[1]):undefined;
    const result=exact?(resolved===undefined?'':resolved):value.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g,(_,p)=>String(resolvePath(context,p) ?? ''));
    if(budget)charge(JSON.stringify(result));return result;
  }
  if(Array.isArray(value)){charge('[]'+','.repeat(Math.max(0,value.length-1)));return value.map(v=>interpolate(v,context,budget));}
  if(value && typeof value==='object'){charge('{}');return Object.fromEntries(Object.entries(value).filter(([k])=>!['__proto__','constructor','prototype'].includes(k)).map(([k,v])=>{charge(JSON.stringify(k)+':,');return [k,interpolate(v,context,budget)];}));}
  if(budget)charge(JSON.stringify(value));
  return value;
}
export function evaluateCondition(d,context) {
  const a=resolvePath(context,d.field),b=interpolate(d.value,context);
  return ({eq:()=>a===b,neq:()=>a!==b,gte:()=>Number(a)>=Number(b),gt:()=>Number(a)>Number(b),lte:()=>Number(a)<=Number(b),lt:()=>Number(a)<Number(b),contains:()=>typeof a==='string' && a.includes(String(b)),exists:()=>a!==undefined && a!==null && a!==''})[d.operator]();
}
function listScalar(value) {
  if(value===undefined || value===null)return null;
  if(!['string','boolean','number'].includes(typeof value) || typeof value==='number' && !Number.isFinite(value))throw new AppError(400,'List keys and sort fields must contain finite numbers, text, booleans or empty values.');
  return value;
}
export function executeList(d,context) {
  if(!listKinds.includes(d.kind))throw new AppError(400,'Choose a supported list step.');
  validateLogic(d);
  const input=resolvePath(context,d.source);
  if(!Array.isArray(input))throw new AppError(400,`The list source ${d.source} must contain an array.`);
  if(input.length>1000)throw new AppError(400,'List steps support up to 1,000 items. Split the source before processing it.');
  const itemContext=(item,index)=>({...context,item,index});
  let items;
  if(d.kind==='list.filter')items=input.filter((item,index)=>evaluateCondition(d,itemContext(item,index)));
  if(d.kind==='list.map'){const budget={bytes:0};items=input.map((item,index)=>interpolate(d.values,itemContext(item,index),budget));}
  if(d.kind==='list.limit')items=input.slice(d.offset,d.offset+d.limit);
  if(d.kind==='list.sort'){
    const keyed=input.map((item,index)=>({item,key:listScalar(resolvePath(itemContext(item,index),d.field))}));
    const types=new Set(keyed.filter(v=>v.key!==null).map(v=>typeof v.key));
    if(types.size>1)throw new AppError(400,'Use one value type for a list sort field.');
    items=keyed.sort((a,b)=>a.key===null?b.key===null?0:1:b.key===null?-1:(a.key<b.key?-1:a.key>b.key?1:0)*(d.direction==='desc'?-1:1)).map(v=>v.item);
  }
  if(d.kind==='list.deduplicate'){
    const seen=new Set();items=input.filter((item,index)=>{const key=JSON.stringify(listScalar(resolvePath(itemContext(item,index),d.field)));if(seen.has(key))return false;seen.add(key);return true;});
  }
  if(d.kind==='list.aggregate'){
    const groups=new Map();
    if(!d.groupBy)groups.set('null',{group:null,count:0,sum:0,min:null,max:null});
    for(const [index,item]of input.entries()){
      const ctx=itemContext(item,index),group=d.groupBy?listScalar(resolvePath(ctx,d.groupBy)):null,key=JSON.stringify(group);
      if(!groups.has(key))groups.set(key,{group,count:0,sum:0,min:null,max:null});
      if(groups.size>100)throw new AppError(400,'List aggregation supports up to 100 groups.');
      const g=groups.get(key);g.count++;
      if(d.operation!=='count'){
        const value=resolvePath(ctx,d.field);
        if(typeof value!=='number' || !Number.isFinite(value))throw new AppError(400,`Item ${index+1} needs a finite number at ${d.field}.`);
        g.sum+=value;g.min=g.min===null?value:Math.min(g.min,value);g.max=g.max===null?value:Math.max(g.max,value);
        if(!Number.isFinite(g.sum))throw new AppError(400,'List aggregate exceeds the supported numeric range.');
      }
    }
    items=[...groups.values()].map(g=>({group:g.group,count:g.count,value:d.operation==='count'?g.count:d.operation==='sum'?g.sum:d.operation==='avg'?g.count?g.sum/g.count:null:g[d.operation]}));
  }
  const output={items,count:items.length,input_count:input.length};
  // ponytail: bounded in-memory JSON lists; object storage/batched jobs when larger datasets are required.
  if(Buffer.byteLength(JSON.stringify(output))>262144)throw new AppError(400,'List output exceeds 256 KB. Map only the fields the next step needs.');
  return output;
}
function encryptionKey(){const key=Buffer.from(process.env.ENCRYPTION_KEY || '','hex');if(key.length!==32)throw new Error('Configure a 32-byte encryption key.');return key;}
export function encryptCredential(tenantId,value){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  cipher.setAAD(Buffer.from(tenantId));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),ciphertext].map(v=>v.toString('base64')).join('.');
}
export function decryptCredential(tenantId,encrypted){
  const [iv,tag,value]=encrypted.split('.').map(v=>Buffer.from(v,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),iv);decipher.setAAD(Buffer.from(tenantId));decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(value),decipher.final()]).toString('utf8'));
}
export function redact(value,secrets=[]){
  let result=JSON.stringify(value);
  for(const secret of secrets.filter(v=>typeof v==='string' && v.length>0))result=result.split(JSON.stringify(secret).slice(1,-1)).join('[REDACTED]');
  return JSON.parse(result);
}
export async function createExecution(client,tenantId,workflow,version,input={},eventId=null,runtime={}){
  const id=randomUUID(),trigger=version.graph.nodes.find(n=>n.data.kind.startsWith('trigger.'));
  const access=await publishedWorkflowAccess(client,version.id);requireWorkflowStep(access,trigger.data.kind);
  if(input.record?.object_key)requireWorkflowObject(access,input.record.object_key,'read');
  if(trigger.data.kind==='trigger.error' && !runtime.error_handler)throw new AppError(400,'Error workflows start automatically from a failed run. Test the source workflow instead.');
  if(trigger.data.kind==='trigger.subworkflow')contractValue(reusableContract(trigger.data).inputs,input);
  const {rows}=await client.query(`INSERT INTO executions(tenant_id,id,workflow_id,version_id,input,context,current_node,event_id,runtime)
    VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8) ON CONFLICT(tenant_id,workflow_id,event_id) DO NOTHING RETURNING *`,[tenantId,id,workflow.id,version.id,input,trigger.id,eventId,runtime]);
  if(rows[0])return rows[0];
  const existing=(await client.query('SELECT *,input=$1::jsonb AS same_input FROM executions WHERE workflow_id=$2 AND event_id=$3',[input,workflow.id,eventId])).rows[0];
  if(!existing?.same_input)throw new AppError(409,'This idempotency key was already used with a different payload.');
  return existing;
}

// One shared calculation keeps previews, published versions and worker dispatch aligned.
export function nextSchedule(data,after=new Date()) {
  const mode=z.enum(['interval','cron']).parse(data.mode ?? 'interval');
  if(mode==='interval')return new Date(after.getTime()+z.number().int().min(1).max(525600).parse(data.intervalMinutes)*60000);
  const expression=z.string().trim().min(1).max(120).parse(data.cron),timezone=z.string().min(1).max(80).parse(data.timezone);
  if(expression.split(/\s+/).length!==5 || /\bH(?:\(|\/|\s|$)/.test(expression))throw new AppError(400,'Use five cron fields: minute, hour, day of month, month and weekday. Hashed fields are not supported.');
  try {
    if(!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(timezone))throw new Error();
    new Intl.DateTimeFormat('en',{timeZone:timezone});
  } catch {throw new AppError(400,'Choose a valid IANA timezone, such as Asia/Kolkata.');}
  try {return CronExpressionParser.parse(expression,{currentDate:after,tz:timezone}).next().toDate();}
  catch {throw new AppError(400,'This cron schedule has no valid next run. Check its five fields.');}
}
export async function dispatchSchedule(client,tenantId,id,now=new Date()) {
  const w=(await client.query("SELECT * FROM workflows WHERE id=$1 AND status='active' AND next_run_at<=$2 FOR UPDATE SKIP LOCKED",[id,now])).rows[0];
  if(!w)return null;
  if(!(await billingAccess(client,tenantId,'automation')).access){await client.query("UPDATE workflows SET next_run_at=$1 WHERE id=$2",[new Date(now.getTime()+300000),id]);return null;}
  const v=(await client.query('SELECT * FROM workflow_versions WHERE id=$1',[w.published_version_id])).rows[0];
  const trigger=v.graph.nodes.find(n=>n.data.kind==='trigger.schedule');if(!trigger)return null;
  // ponytail: run one overdue occurrence, then skip to the next future time; explicit catch-up policies can extend this.
  let execution;
  try{execution=await createExecution(client,tenantId,w,v,{scheduled_at:w.next_run_at});}catch(error){if(!error.workflowAccessDenied)throw error;}
  await client.query('UPDATE workflows SET next_run_at=$1 WHERE id=$2',[nextSchedule(trigger.data,now),id]);
  return execution;
}
