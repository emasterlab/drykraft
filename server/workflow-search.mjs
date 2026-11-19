import { z } from 'zod';
import { AppError,getDefinition,keySchema } from './model.mjs';
import { recordFilterSchema,validateFilter,listRecords } from './record-lists.mjs';
import {workflowObjectAccess} from './workflow-access.mjs';

export const workflowSearchSchema=z.object({object:keySchema,search:z.string().max(200).default(''),limit:z.number().int().min(1).max(100).default(25),cursor:z.string().max(500).default(''),list:z.union([z.string().uuid(),z.literal('')]).default(''),filter:recordFilterSchema.optional()}).superRefine((d,c)=>{if(d.list && d.filter)c.addIssue({code:'custom',message:'Choose a smart list or field rules, not both.'});});
export async function validateWorkflowSearch(client,raw) {
  const d=workflowSearchSchema.parse(raw),definition=await getDefinition(client,d.object);
  let filter=d.filter;
  if(d.list){filter=(await client.query('SELECT filter FROM record_lists WHERE id=$1 AND object_key=$2',[d.list,d.object])).rows[0]?.filter;if(!filter)throw new AppError(400,'Choose a current smart list for this object in your workspace.');}
  if(filter){
    // Validate field/operator structure now; exact expression types are checked again after resolution in the worker.
    const probe=structuredClone(filter);
    for(const rule of probe.conditions)if(typeof rule.value==='string' && /\{\{[a-zA-Z0-9_.-]+\}\}/.test(rule.value)){
      const field=definition.fields.find(f=>f.key===rule.field);
      const typed=['number','currency','boolean','date','select','user'].includes(field?.type);
      if(typed && !/^\{\{[a-zA-Z0-9_.-]+\}\}$/.test(rule.value))throw new AppError(400,'Use an exact context expression for a typed filter value.');
      rule.value=field?.key==='currency'?'USD':['number','currency'].includes(field?.type)?1:field?.type==='boolean'?true:field?.type==='date'?'2000-01-01':field?.type==='user'?'00000000-0000-4000-8000-000000000001':field?.options?.[0] || 'sample';
    }
    validateFilter(definition,probe);
  }
  return d;
}
export async function searchWorkflowRecords(client,raw) {
  await workflowObjectAccess(client,raw.object,'read');
  const d=workflowSearchSchema.parse({...raw,cursor:raw.cursor ?? ''}),page=await listRecords(client,d.object,{search:d.search,limit:d.limit,...(d.cursor?{cursor:d.cursor}:{}),...(d.list?{list:d.list}:{}),...(d.filter?{filter:JSON.stringify(d.filter)}:{})});
  const output={...page,count:page.items.length};
  // ponytail: one bounded page in execution JSON; larger result sets need explicit paging or streamed jobs.
  if(Buffer.byteLength(JSON.stringify(output))>262144)throw new AppError(400,'Search output exceeds 256 KB. Reduce Maximum records before running again.');
  return output;
}
