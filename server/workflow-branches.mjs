import {z} from 'zod';
import {AppError} from './model.mjs';

const branch=z.object({id:z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).refine(v=>!['constructor','prototype','__proto__'].includes(v)),label:z.string().trim().min(1).max(60)}).strict();
export function splitSettings(raw){
 const result=z.array(branch).min(2).max(10).safeParse(raw.branches);
 if(!result.success || new Set(result.data.map(b=>b.id)).size!==result.data.length)throw new AppError(400,'Split needs 2-10 named branches with unique IDs.');
 return result.data;
}
export function mergeSettings(raw){
 const result=z.object({splitId:z.string().min(1).max(80),operation:z.enum(['collect','append'])}).safeParse(raw);
 if(!result.success)throw new AppError(400,'Merge needs a paired Split and Collect outputs or Append lists.');
 return result.data;
}
export function splitPlan(graph,node){
 const branches=splitSettings(node.data),merges=graph.nodes.filter(n=>n.data.kind==='merge' && n.data.splitId===node.id);
 if(merges.length!==1)throw new AppError(400,'Each Split needs exactly one paired Merge.');
 return {merge_id:merges[0].id,branches:branches.map(b=>{
  const edges=graph.edges.filter(e=>e.source===node.id && e.sourceHandle===b.id);
  if(edges.length!==1)throw new AppError(400,'Connect every Split branch exactly once.');
  return {...b,target:edges[0].target};
 })};
}
export function validateBranches(graph){
 const regions=[];
 for(const merge of graph.nodes.filter(n=>n.data.kind==='merge')){
  const settings=mergeSettings(merge.data);
  if(!graph.nodes.some(n=>n.id===settings.splitId && n.data.kind==='split'))throw new AppError(400,'Choose an existing Split for each Merge.');
 }
 for(const node of graph.nodes.filter(n=>n.data.kind==='split')){
  const plan=splitPlan(graph,node),body=new Set(),parts=[];
  if(graph.edges.some(e=>e.source===node.id && !plan.branches.some(b=>b.id===e.sourceHandle)))throw new AppError(400,'Use only the current named Split outputs.');
  for(const branch of plan.branches){
   const part=new Set();
   function walk(id,itemBody=false){
    if(id===plan.merge_id){if(itemBody)throw new AppError(400,'Finish Loop items before reaching Merge.');return;}
    if(part.has(id))return;part.add(id);
    const n=graph.nodes.find(n=>n.id===id),out=graph.edges.filter(e=>e.source===id);
    if(n.data.kind==='workflow.return')throw new AppError(400,'Return values belong after Merge, outside Split paths.');
    if(n.data.kind==='condition' && out.length!==2 || n.data.kind==='switch' && out.length!==n.data.cases.length+1)throw new AppError(400,'Connect every Condition and Switch output inside a Split path.');
    if(!out.length && !itemBody || n.data.kind==='loop' && !itemBody && !out.some(e=>e.sourceHandle==='done'))throw new AppError(400,'Every Split path must reach its paired Merge.');
    for(const e of out)walk(e.target,itemBody || n.data.kind==='loop' && e.sourceHandle==='each');
   }
   walk(branch.target);
   if(parts.some(p=>[...part].some(id=>p.has(id))))throw new AppError(400,'Keep Split branch steps separate until their paired Merge.');
   parts.push(part);for(const id of part)body.add(id);
   const entry=graph.edges.find(e=>e.source===node.id && e.sourceHandle===branch.id);
   if(graph.edges.some(e=>part.has(e.target) && !part.has(e.source) && e!==entry))throw new AppError(400,'Enter Split branch steps only through their named output.');
  }
  if(graph.edges.some(e=>e.target===plan.merge_id && !body.has(e.source) && e.source!==node.id))throw new AppError(400,'Enter Merge only from its paired Split paths.');
  regions.push(body);
 }
 return regions;
}
export function mergeOutputs(raw,completed){
 const settings=mergeSettings(raw);
 if(!completed || !Array.isArray(completed.branches) || completed.branches.length<2 || completed.branches.length>10)throw new AppError(400,'Merge requires completed outputs from its paired Split.');
 let items;
 if(settings.operation==='collect')items=completed.branches.map(b=>b.output);
 else{
  items=[];
  for(const b of completed.branches){
   if(!Array.isArray(b.output?.items))throw new AppError(400,'Append lists needs last.items from every branch. End each branch with a list or Set values containing items.');
   if(items.length+b.output.items.length>1000)throw new AppError(400,'Merge supports up to 1,000 appended items. Limit each branch first.');
   items.push(...b.output.items);
  }
 }
 const output={items,count:items.length,branches:completed.branches};
 if(Buffer.byteLength(JSON.stringify(output))>262144)throw new AppError(400,'Merge output exceeds 256 KiB. Collect only needed fields at the end of each branch.');
 return output;
}
