import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { currencySchema,currencyDigits,workspaceCurrencies,monetaryFields } from './currency.mjs';
import { event } from './db.mjs';
import {workflowObjectAccess} from './workflow-access.mjs';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const keySchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
export const fieldSchema = z.object({
  key: keySchema, name: z.string().min(1).max(80),
  type: z.enum(['text','email','phone','number','currency','boolean','date','select','multi_select','user','relation','json']),
  required: z.boolean().default(false), options: z.array(z.string().max(80)).max(100).optional(),
  object: keySchema.optional(),
});
export const objectSchema = z.object({ key:keySchema, name:z.string().min(1).max(80), singular_name:z.string().min(1).max(80), fields:z.array(fieldSchema).min(1).max(100) }).superRefine((v,c)=>{
  if(new Set(v.fields.map(f=>f.key)).size!==v.fields.length) c.addIssue({code:'custom',message:'Field keys must be unique'});
});
const field = (key,name,type='text',extra={}) => ({key,name,type,required:false,...extra});
export const builtIns = [
  {key:'people',name:'People',singular_name:'Person',fields:[field('name','Full name','text',{required:true}),field('email','Email','email'),field('phone','Phone','phone'),field('company','Company'),field('title','Job title'),field('status','Lifecycle','select',{options:['Lead','Customer','Partner']}),field('source','Source','select',{options:['Website','Referral','Campaign','Import','Outbound']}),field('tags','Tags','multi_select'),field('owner_id','Assigned owner','user'),field('owner','Owner reference'),field('consent','Marketing consent','boolean')]},
  {key:'companies',name:'Companies',singular_name:'Company',fields:[field('name','Company name','text',{required:true}),field('domain','Website'),field('industry','Industry'),field('size','Employees','number'),field('city','City'),field('owner_id','Assigned owner','user'),field('owner','Owner reference')]},
  {key:'leads',name:'Leads',singular_name:'Lead',fields:[field('name','Lead name','text',{required:true}),field('email','Email','email'),field('consent','Marketing consent','boolean'),field('company','Company'),field('source','Source','select',{options:['Website','Referral','Campaign','Import','Outbound']}),field('status','Status','select',{options:['New','Contacted','Qualified','Unqualified','Converted']}),field('score','Lead score','number'),field('owner_id','Assigned owner','user'),field('owner','Owner reference'),field('value','Potential value','currency')]},
  {key:'deals',name:'Deals',singular_name:'Deal',fields:[field('name','Deal name','text',{required:true}),field('company','Company'),field('person_id','Contact','relation',{object:'people'}),field('value','Value','currency'),field('stage','Stage'),field('pipeline_id','Pipeline'),field('status','Status','select',{options:['Open','Won','Lost']}),field('probability','Probability','number'),field('close_date','Expected close','date'),field('owner_id','Assigned owner','user'),field('owner','Owner reference'),field('lost_reason','Lost reason')]},
  {key:'invoices',name:'Invoices',singular_name:'Invoice',fields:[field('name','Title','text',{required:true}),field('customer_name','Customer','text',{required:true}),field('customer_email','Customer email','email'),field('billing_address','Billing address'),field('contact_id','Contact','relation',{object:'people'}),field('deal_id','Deal','relation',{object:'deals'}),field('currency','Currency','text',{required:true}),field('issue_date','Invoice date','date',{required:true}),field('due_date','Due date','date',{required:true}),field('items','Line items','json',{required:true}),field('notes','Notes'),...['invoice_number','status','issued_at','void_reason'].map(k=>field(k,k.replaceAll('_',' '))),...['subtotal_minor','discount_minor','tax_minor','total_minor','paid_minor','balance_minor'].map(k=>field(k,k.replaceAll('_',' '),'number')),field('total','Total','currency'),field('balance','Balance due','currency'),field('issuer','Issuer snapshot','json')]},
  {key:'purchase_orders',name:'Purchase Orders',singular_name:'Purchase Order',fields:[field('name','Title','text',{required:true}),field('vendor','Vendor','text',{required:true}),field('vendor_email','Vendor email','email'),field('vendor_address','Vendor address'),field('currency','Currency','text',{required:true}),field('order_date','Order date','date',{required:true}),field('expected_date','Expected delivery','date'),field('items','Line items','json',{required:true}),field('notes','Notes'),field('deal_id','Deal','relation',{object:'deals'}),...['po_number','status','issued_at','cancelled_at','cancel_reason'].map(k=>field(k,k.replaceAll('_',' '))),...['subtotal_minor','discount_minor','tax_minor','total_minor'].map(k=>field(k,k.replaceAll('_',' '),'number')),field('issuer','Issuer snapshot','json')]},
  {key:'expenses',name:'Expenses',singular_name:'Expense',fields:[field('name','Title','text',{required:true}),field('vendor','Vendor','text',{required:true}),field('category','Category'),field('spent_on','Expense date','date',{required:true}),field('currency','Currency','text',{required:true}),field('amount','Amount','currency',{required:true}),field('tax','Included tax','currency'),field('receipt_url','Receipt reference'),field('notes','Notes'),field('deal_id','Deal','relation',{object:'deals'}),field('status','Status'),field('total_minor','Total minor units','number'),field('tax_minor','Tax minor units','number'),field('submitted_by','Submitted by'),field('approved_by','Approved by'),field('decision_note','Decision note')]},
  {key:'tasks',name:'Tasks',singular_name:'Task',fields:[field('name','Task','text',{required:true}),field('due_date','Due date','date'),field('status','Status','select',{options:['To do','In progress','Done']}),field('priority','Priority','select',{options:['Low','Medium','High']}),field('owner_id','Assigned owner','user'),field('owner','Owner reference'),field('record_id','Related record','relation'),field('description','Description')]},
];
for(const object of builtIns)object.fields=monetaryFields(object.fields);
export const relationshipFields = {
  people:[field('company_id','Linked company','relation',{object:'companies'})],
  leads:[field('phone','Phone','phone'),field('person_id','Linked contact','relation',{object:'people'}),field('company_id','Linked company','relation',{object:'companies'})],
  deals:[field('company_id','Linked company','relation',{object:'companies'}),field('lead_id','Source lead','relation',{object:'leads'})],
  invoices:[field('company_id','Linked company','relation',{object:'companies'})],
  purchase_orders:[field('company_id','Vendor company','relation',{object:'companies'})],
  expenses:[field('company_id','Vendor company','relation',{object:'companies'})],
};
for(const object of builtIns)object.fields.push(...(relationshipFields[object.key] || []));
export const defaultWidgets = [
  {id:'leads',title:'Total leads',object:'leads',operation:'count',display:'metric'},
  {id:'pipeline',title:'Open pipeline',object:'deals',operation:'sum',field:'value',filter:{field:'status',value:'Open'},display:'metric'},
  {id:'won',title:'Revenue won',object:'deals',operation:'sum',field:'value',filter:{field:'status',value:'Won'},display:'metric'},
  {id:'tasks',title:'Tasks to complete',object:'tasks',operation:'count',filter:{field:'status',value:'To do'},display:'metric'},
  {id:'revenue',title:'Pipeline by stage',object:'deals',operation:'sum',field:'value',group_by:'stage',display:'bar'},
  {id:'sources',title:'Where leads come from',object:'leads',operation:'count',group_by:'source',display:'donut'},
];
export const defaultStages = [
  {id:'new',name:'New',probability:10,color:'#8b94a3'}, {id:'qualified',name:'Qualified',probability:30,color:'#5897ec'},
  {id:'proposal',name:'Proposal',probability:60,color:'#b381dd'}, {id:'negotiation',name:'Negotiation',probability:80,color:'#f5a43b'},
  {id:'won',name:'Won',probability:100,color:'#459d7c'},
];
export async function initializeWorkspace(client,tenantId) {
  for (const object of builtIns) await client.query(`INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields,built_in) VALUES($1,$2,$3,$4,$5,true)`,[tenantId,object.key,object.name,object.singular_name,JSON.stringify(object.fields)]);
  const pipelineId=randomUUID();
  await client.query('INSERT INTO pipelines(tenant_id,id,name,stages) VALUES($1,$2,$3,$4)',[tenantId,pipelineId,'Sales pipeline',JSON.stringify(defaultStages)]);
  await client.query('INSERT INTO dashboards(tenant_id,id,name,widgets) VALUES($1,$2,$3,$4)',[tenantId,randomUUID(),'Business overview',JSON.stringify(defaultWidgets)]);
  return pipelineId;
}
export async function getDefinition(client,key) {
  const {rows}=await client.query('SELECT * FROM object_definitions WHERE key=$1 FOR SHARE',[key]);
  if(!rows[0]) throw new AppError(404,'This object does not exist in your workspace.');
  return rows[0];
}
export async function editDefinition(client,tenantId,actorId,key,input,fieldKey=null) {
  keySchema.parse(key);if(fieldKey)keySchema.parse(fieldKey);
  await client.query('SELECT key FROM object_definitions WHERE key=$1 FOR UPDATE',[key]);
  const definition=await getDefinition(client,key);
  let previous,next,changes;
  if(fieldKey){
    const body=z.object({field:fieldSchema,previous:fieldSchema}).strict().parse(input);
    const old=definition.fields.find(f=>f.key===fieldKey);if(!old)throw new AppError(404,'This field no longer exists. Reload the object.');
    previous=fieldSchema.parse(old);next=body.field;
    if(next.key!==fieldKey || next.type!==previous.type || next.object!==previous.object)throw new AppError(400,'Field keys, types and related objects stay fixed. Add a new field for a different data structure.');
    const managed=builtIns.find(d=>d.key===key)?.fields.some(f=>f.key===fieldKey);
    if(managed && (next.required!==previous.required || !isDeepStrictEqual(next.options,previous.options)))throw new AppError(400,'Built-in field rules are managed by DryKraft. You can change the label.');
    if(isDeepStrictEqual(previous,next))return definition;
    if(!isDeepStrictEqual(previous,body.previous))throw new AppError(409,'This field changed since you opened it. Keep your edits or reload the saved field.');
    if(next.required && !previous.required && (await client.query(`SELECT 1 FROM records WHERE object_key=$1 AND merged_into IS NULL AND (data->>$2 IS NULL OR data->>$2='') LIMIT 1`,[key,fieldKey])).rowCount)throw new AppError(409,'Some existing records have no value for this field. Fill them first, then make it required.');
    if(['select','multi_select'].includes(next.type) && next.options && !isDeepStrictEqual(next.options,previous.options)){
      // ponytail: validate choice changes in 250-row pages under the object lock; use indexed choice usage for very large objects.
      let cursor=null;
      for(;;){
        const rows=(await client.query('SELECT id,data->$2 AS value FROM records WHERE object_key=$1 AND merged_into IS NULL AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 250',[key,fieldKey,cursor])).rows;
        for(const row of rows)try{await validateData(client,{fields:[next]},{[fieldKey]:row.value});}catch(error){if(!(error instanceof AppError))throw error;throw new AppError(409,'Some existing records use choices you removed. Update those records or keep the choices.');}
        if(rows.length<250)break;cursor=rows.at(-1).id;
      }
    }
    changes={fields:definition.fields.map(f=>f.key===fieldKey?next:f)};
  }else{
    const labels=z.object({name:z.string().trim().min(1).max(80),singular_name:z.string().trim().min(1).max(80)}).strict();
    const body=labels.extend({previous:labels}).strict().parse(input);
    previous={name:definition.name,singular_name:definition.singular_name};next={name:body.name,singular_name:body.singular_name};
    if(isDeepStrictEqual(previous,next))return definition;
    if(!isDeepStrictEqual(previous,body.previous))throw new AppError(409,'This object changed since you opened it. Keep your edits or reload the saved names.');
    changes=next;
  }
  const result=(await client.query(fieldKey?'UPDATE object_definitions SET fields=$1 WHERE key=$2 RETURNING *':'UPDATE object_definitions SET name=$1,singular_name=$3 WHERE key=$2 RETURNING *',fieldKey?[JSON.stringify(changes.fields),key]:[changes.name,key,changes.singular_name])).rows[0];
  await event(client,tenantId,actorId,fieldKey?'schema.field.updated':'schema.object.updated','object',null,{object_key:key,field_key:fieldKey,previous,next});
  return result;
}
export async function resolveRecord(client,id,key=null,forUpdate=false) {
  // Alias chains are bounded by the tenant's actual records; a cycle is corruption, never a fallback to another tenant.
  const seen=new Set();
  while(!seen.has(id)) {
    seen.add(id);
    const record=(await client.query(forUpdate?'SELECT * FROM records WHERE id=$1 AND ($2::text IS NULL OR object_key=$2) FOR UPDATE':'SELECT * FROM records WHERE id=$1 AND ($2::text IS NULL OR object_key=$2) FOR KEY SHARE',[id,key])).rows[0];
    if(!record)throw new AppError(404,'Record not found in this workspace.');
    await workflowObjectAccess(client,record.object_key,'read');
    if(!record.merged_into)return record;
    id=record.merged_into;
  }
  throw new AppError(409,'This contact’s merge history needs review.');
}
export async function validateData(client,definition,data,priorData={}) {
  if(!data || typeof data!=='object' || Array.isArray(data)) throw new AppError(400,'Record values must be an object.');
  const known=new Set(definition.fields.map(f=>f.key));
  for(const key of Object.keys(data)) if(!known.has(key)) throw new AppError(400,`Unknown field: ${key}`);
  for(const f of definition.fields) {
    const v=data[f.key];
    if(v===undefined || v===null || v==='') { if(f.required) throw new AppError(400,`${f.name} is required.`); continue; }
    let valid=true;
    if(['text','email','phone','select','date','relation'].includes(f.type)) valid=typeof v==='string' && v.length<=10000;
    if(f.type==='email') valid=z.string().email().safeParse(v).success;
    if(['number','currency'].includes(f.type)) valid=typeof v==='number' && Number.isFinite(v) && Math.abs(v)<1e15;
    if(f.type==='currency'){const digits=currencyDigits(data.currency || 'USD');valid=valid && new RegExp(digits?`^-?\\d{1,15}(?:\\.\\d{1,${digits}})?$`:'^-?\\d{1,15}$').test(String(v));}
    if(f.type==='boolean') valid=typeof v==='boolean';
    if(f.type==='date') valid=typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v;
    if(f.type==='select') valid=valid && (!f.options || f.options.includes(v));
    if(f.type==='multi_select') valid=Array.isArray(v) && v.length<=100 && v.every(x=>typeof x==='string' && x.length<=80 && (!f.options || f.options.includes(x)));
    if(f.type==='user') {
      valid=z.string().uuid().safeParse(v).success;
      // The row lock serializes a new assignment with membership removal. Existing departed assignments remain history.
      if(valid && priorData[f.key]!==v)await requireAssignmentMember(client,v);
    }
    if(f.type==='relation') {
      valid=z.string().uuid().safeParse(v).success;
      if(valid) {try{data[f.key]=(await resolveRecord(client,v,f.object || null)).id;}catch(error){if(error.status!==404)throw error;valid=false;}}
    }
    if(!valid) throw new AppError(400,`Enter a valid value for ${f.name}.`);
  }
  if(JSON.stringify(data).length>100000) throw new AppError(400,'This record is too large.');
}
export async function recordUserNames(client,definition,records) {
  const fields=definition.fields.filter(f=>f.type==='user');
  if(!fields.length && ['invoices','purchase_orders','expenses'].includes(definition.key))return records;
  const ids=[...new Set(records.flatMap(r=>fields.map(f=>r.data[f.key])).filter(v=>z.string().uuid().safeParse(v).success))];
  const names=ids.length?(await client.query("SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND u.id=ANY($1::uuid[])",[ids])).rows:[];
  const byId=new Map(names.map(u=>[u.id,u.name]));
  const relations=definition.fields.filter(f=>f.type==='relation'),relatedIds=[...new Set(records.flatMap(r=>relations.map(f=>r.data[f.key])).filter(v=>z.string().uuid().safeParse(v).success))];
  const linked=relatedIds.length?(await client.query("SELECT id,object_key,data->>'name' AS name FROM records WHERE id=ANY($1::uuid[]) AND merged_into IS NULL",[relatedIds])).rows:[];
  const accessible=r=>(!client.apiPrincipal || client.apiPrincipal.permissions[r.object_key]?.includes('read')) && (!client.workflowPrincipal || client.workflowPrincipal.accounts.every(s=>s.permissions[r.object_key]?.includes('read')));
  const related=new Map(linked.filter(accessible).map(r=>[r.id,r]));
  return records.map(r=>({...r,user_names:Object.fromEntries(fields.filter(f=>r.data[f.key]).map(f=>[f.key,byId.get(r.data[f.key]) || 'Former member'])),relation_names:Object.fromEntries(relations.filter(f=>related.has(r.data[f.key])).map(f=>[f.key,related.get(r.data[f.key])]))}));
}
export async function prepareRecordData(client,tenantId,key,data,prior=null) {
  if(['invoices','purchase_orders','expenses'].includes(key))throw new AppError(400,'Use Finance to create or change financial records.');
  const definition=await getDefinition(client,key);
  if(definition.fields.some(f=>f.type==='currency')){
    const settings=(await client.query('SELECT settings FROM workspaces WHERE id=$1',[tenantId])).rows[0].settings;
    data={...data,currency:data.currency || prior?.data.currency || settings.currency || 'USD'};currencySchema.parse(data.currency);
    if(!workspaceCurrencies(settings).includes(data.currency) && prior?.data.currency!==data.currency)throw new AppError(400,'Enable this currency in Workspace settings first.');
  }
  if(key==='deals' && !data.pipeline_id){
    const pipeline=(await client.query('SELECT * FROM pipelines ORDER BY name,id LIMIT 1 FOR SHARE')).rows[0];
    if(!pipeline?.stages.length)throw new AppError(409,'Create a Sales pipeline before adding deals.');
    const stage=pipeline.stages.find(s=>data.status==='Won'?s.id==='won':s.id!=='won') || pipeline.stages[0];
    data={...data,pipeline_id:pipeline.id,stage:data.stage || stage.id,probability:data.probability ?? stage.probability,status:data.status || 'Open'};
  }
  await validateData(client,definition,data,prior?.data || {});
  if(key==='deals' && data.pipeline_id) {
    await dealStageDestination(client,data.pipeline_id,data.stage ?? '');
  }
  return data;
}
export async function saveRecord(client,tenantId,actorId,key,data,id=null,version=null,causationId=null,options={}) {
  await workflowObjectAccess(client,key,id?'update':'create');
  const prior=id?(await client.query('SELECT data,merged_into FROM records WHERE id=$1 AND object_key=$2 FOR UPDATE',[id,key])).rows[0]:null;
  if(prior?.merged_into)throw new AppError(409,'This contact was merged. Open its remaining contact before editing.');
  data=await prepareRecordData(client,tenantId,key,data,prior);
  if(['people','leads','deals'].includes(key))data=await connectCompany(client,tenantId,actorId,key,data,prior,causationId);
  if(key==='leads' && !id)data=await connectLeadContact(client,tenantId,actorId,data,causationId);
  let result;
  if(id) {
    result=await client.query('UPDATE records SET data=$1,version=version+1,updated_at=now() WHERE id=$2 AND object_key=$3 AND merged_into IS NULL AND ($4::int IS NULL OR version=$4) RETURNING *',[data,id,key,version]);
    if(!result.rows[0]) throw new AppError(409,'This record changed or was removed. Refresh before saving.');
  } else result=await client.query('INSERT INTO records(tenant_id,id,object_key,data,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[tenantId,randomUUID(),key,data,actorId]);
  const record=result.rows[0];
  if(key==='leads' && !id)await ensureLeadDeal(client,tenantId,actorId,record,causationId,options.dealValues || {});
  if(key==='leads' && prior){
    const fields=['person_id','company_id'].filter(f=>(prior.data[f] || null)!==(data[f] || null));
    if(fields.length){
      await workflowObjectAccess(client,'deals','read');
      const deals=(await client.query("SELECT * FROM records WHERE object_key='deals' AND data->>'lead_id'=$1 ORDER BY id FOR UPDATE",[record.id])).rows;
      for(const deal of deals){
        const changes=Object.fromEntries(fields.filter(f=>(deal.data[f] || null)===(prior.data[f] || null)).map(f=>[f,data[f] || null]));
        if(Object.hasOwn(changes,'company_id'))changes.company=data.company || '';
        if(Object.keys(changes).length)await saveRecord(client,tenantId,actorId,'deals',{...deal.data,...changes},deal.id,deal.version,causationId);
      }
    }
  }
  await event(client,tenantId,actorId,`crm.${key}.${id?'updated':'created'}`,key,record.id,{record},causationId);
  if(key==='deals' && (!prior || prior.data.pipeline_id!==data.pipeline_id || prior.data.stage!==data.stage)) {
    const from=prior?await stageSnapshot(client,prior.data):null,to=await stageSnapshot(client,data);
    const history=(await client.query('INSERT INTO deal_stage_history(tenant_id,id,deal_id,from_stage,to_stage,record_version,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[tenantId,randomUUID(),record.id,from,to,record.version,actorId])).rows[0];
    if(prior)await event(client,tenantId,actorId,'crm.deals.stage_changed',key,record.id,{record,from_stage:from,to_stage:to,stage_history_id:history.id},causationId);
  }
  if(key==='deals' && data.status==='Won' && prior?.data.status!=='Won')await event(client,tenantId,actorId,'crm.deals.won',key,record.id,{record},causationId);
  if(key==='people' && prior){
    const before=[...new Set(prior.data.tags || [])],after=[...new Set(data.tags || [])],added=after.filter(t=>!before.includes(t)),removed=before.filter(t=>!after.includes(t));
    if(added.length || removed.length)await event(client,tenantId,actorId,'crm.people.tags_changed',key,record.id,{record,before,after,added,removed},causationId);
  }
  if(prior){
    const definition=await getDefinition(client,key);
    for(const field of definition.fields.filter(f=>['relation','user'].includes(f.type))){
      const before=prior.data[field.key] || null,after=data[field.key] || null;
      if(before!==after)await event(client,tenantId,actorId,field.type==='user'?'crm.assignment.changed':'crm.relationship.changed',key,record.id,{record,field:field.key,before,after,...(field.type==='relation'?{target_object:field.object || null}:{})},causationId);
    }
  }
  return record;
}

// Company text remains an editable display value; the UUID is the actual relationship.
// Exact normalized names are matched only when unambiguous. No fuzzy contact/company merges.
async function connectCompany(c,tenantId,actorId,key,input,prior,causationId){
  const data={...input};
  if(data.company_id){const company=await resolveRecord(c,data.company_id,'companies');data.company_id=company.id;data.company=company.data.name;return data;}
  // Clearing a saved relationship is deliberate; do not immediately recreate it from its display text.
  if(prior?.data.company_id && !data.company_id && data.company===prior.data.company)return data;
  if(!data.company?.trim()){
    if(data.person_id){const person=await resolveRecord(c,data.person_id,'people');if(person.data.company_id){const company=await resolveRecord(c,person.data.company_id,'companies');data.company_id=company.id;data.company=company.data.name;}}
    return data;
  }
  await workflowObjectAccess(c,'companies','read');
  const name=data.company.trim();
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`company:${tenantId}:${name.toLowerCase()}`]);
  const matches=(await c.query("SELECT * FROM records WHERE object_key='companies' AND merged_into IS NULL AND lower(trim(data->>'name'))=lower($1) ORDER BY id FOR KEY SHARE",[name])).rows;
  if(matches.length>1)throw new AppError(409,'More than one company has this name. Choose a linked company before saving.');
  const company=matches[0] || await saveRecord(c,tenantId,actorId,'companies',{name},null,null,causationId);
  return {...data,company_id:company.id,company:company.data.name};
}
async function connectLeadContact(c,tenantId,actorId,input,causationId){
  const data={...input};let person;
  if(data.person_id)person=await resolveRecord(c,data.person_id,'people');
  else{
    await workflowObjectAccess(c,'people','read');
    if(data.email){
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${tenantId}:${data.email.toLowerCase()}`]);
      person=(await c.query("SELECT * FROM records WHERE object_key='people' AND merged_into IS NULL AND lower(data->>'email')=lower($1) FOR KEY SHARE",[data.email])).rows[0];
    }
    if(!person){
      const ownerId=data.owner_id && (await c.query('SELECT user_id FROM memberships WHERE user_id=$1',[data.owner_id])).rowCount?data.owner_id:undefined;
      const values=Object.fromEntries(Object.entries({name:data.name,email:data.email,phone:data.phone,company:data.company,company_id:data.company_id,source:data.source,status:'Lead',owner_id:ownerId,owner:data.owner,consent:false}).filter(([,value])=>value!==undefined));
      person=await saveRecord(c,tenantId,actorId,'people',values,null,null,causationId);
    }
  }
  data.person_id=person.id;
  if(!data.email && person.data.email)data.email=person.data.email;
  if(!data.phone && person.data.phone)data.phone=person.data.phone;
  if(!data.company_id && person.data.company_id){const company=await resolveRecord(c,person.data.company_id,'companies');data.company_id=company.id;data.company=company.data.name;}
  return data;
}
export async function ensureLeadDeal(c,tenantId,actorId,lead,causationId=null,dealValues={}){
  await workflowObjectAccess(c,'deals','read');
  // The lead row lock serializes conversion/backfill/retries; new leads already own that row.
  await c.query("SELECT id FROM records WHERE id=$1 AND object_key='leads' FOR UPDATE",[lead.id]);
  const existing=(await c.query("SELECT * FROM records WHERE object_key='deals' AND merged_into IS NULL AND data->>'lead_id'=$1 ORDER BY created_at,id LIMIT 1 FOR KEY SHARE",[lead.id])).rows[0];
  if(existing)return existing;
  if(!dealValues || typeof dealValues!=='object' || Array.isArray(dealValues))throw new AppError(400,'Sales details must be an object.');
  const definition=await getDefinition(c,'deals'),managed=new Set(builtIns.find(o=>o.key==='deals').fields.map(f=>f.key)),custom=new Set(definition.fields.filter(f=>!managed.has(f.key)).map(f=>f.key));
  for(const key of Object.keys(dealValues))if(!custom.has(key))throw new AppError(400,`Sales detail ${key} must be a custom deal field.`);
  const pipeline=(await c.query('SELECT * FROM pipelines ORDER BY name,id LIMIT 1 FOR SHARE')).rows[0];
  if(!pipeline?.stages.length)throw new AppError(409,'Create a Sales pipeline with a stage before adding leads.');
  const stage=pipeline.stages.find(s=>s.id!=='won') || pipeline.stages[0];
  const ownerId=lead.data.owner_id && (await c.query('SELECT user_id FROM memberships WHERE user_id=$1',[lead.data.owner_id])).rowCount?lead.data.owner_id:undefined;
  const data=Object.fromEntries(Object.entries({name:lead.data.name,lead_id:lead.id,person_id:lead.data.person_id,company:lead.data.company,company_id:lead.data.company_id,value:lead.data.value ?? 0,currency:lead.data.currency,pipeline_id:pipeline.id,stage:stage.id,status:'Open',probability:stage.probability,owner_id:ownerId,owner:lead.data.owner}).filter(([,value])=>value!==undefined));
  return saveRecord(c,tenantId,actorId,'deals',{...data,...dealValues},null,null,causationId);
}
export async function connectExistingLead(c,tenantId,actorId,id,convert=false){
  const lead=await resolveRecord(c,id,'leads',true);
  if(convert && lead.data.status==='Converted')throw new AppError(409,'This lead was already converted.');
  let data=await connectCompany(c,tenantId,actorId,'leads',lead.data,lead,null);
  data=await connectLeadContact(c,tenantId,actorId,data,null);
  if(convert)data.status='Converted';
  const saved=isDeepStrictEqual(data,lead.data)?lead:await saveRecord(c,tenantId,actorId,'leads',data,lead.id,lead.version);
  const deal=await ensureLeadDeal(c,tenantId,actorId,saved);
  const person=await resolveRecord(c,saved.data.person_id,'people');
  if(convert)await c.query('INSERT INTO record_links(tenant_id,source_id,target_id,relation) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenantId,lead.id,person.id,'converted_to']);
  return {lead:saved,person,deal};
}
export async function recordRelationshipField(client,key,fieldKey,operation='set') {
  keySchema.parse(key);keySchema.parse(fieldKey);z.enum(['set','clear']).parse(operation);
  if(['invoices','purchase_orders','expenses'].includes(key))throw new AppError(400,'Use Finance to change financial relationships.');
  const definition=await getDefinition(client,key),field=definition.fields.find(f=>f.key===fieldKey && f.type==='relation');
  if(!field)throw new AppError(400,'Choose a relationship field from the selected object.');
  if(operation==='clear' && field.required)throw new AppError(400,`${field.name} is required and cannot be cleared.`);
  return field;
}
export async function linkRecord(client,tenantId,actorId,key,id,fieldKey,operation,targetId=null,causationId=null) {
  await workflowObjectAccess(client,key,'update');
  z.string().uuid().parse(id);
  const field=await recordRelationshipField(client,key,fieldKey,operation),prior=await resolveRecord(client,id,key,true);
  const before=prior.data[fieldKey] || null,after=operation==='clear'?null:(await resolveRecord(client,z.string().uuid().parse(targetId),field.object || null)).id;
  const changed=before!==after,record=changed?await saveRecord(client,tenantId,actorId,key,{...prior.data,[fieldKey]:after},prior.id,prior.version,causationId):prior;
  return {record,field:fieldKey,before,after,changed};
}
export async function recordAssignmentField(client,key,fieldKey,operation='set') {
  keySchema.parse(key);keySchema.parse(fieldKey);z.enum(['set','clear']).parse(operation);
  if(['invoices','purchase_orders','expenses'].includes(key))throw new AppError(400,'Use Finance to change financial assignments.');
  const definition=await getDefinition(client,key),field=definition.fields.find(f=>f.key===fieldKey && f.type==='user');
  if(!field)throw new AppError(400,'Choose a user field from the selected object.');
  if(operation==='clear' && field.required)throw new AppError(400,`${field.name} is required and cannot be cleared.`);
  return field;
}
export async function requireAssignmentMember(client,userId) {
  z.string().uuid().parse(userId);
  if(!(await client.query("SELECT user_id FROM memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=$1 FOR KEY SHARE",[userId])).rowCount)throw new AppError(400,'Choose a current member of this workspace.');
  return userId;
}
export async function assignRecord(client,tenantId,actorId,key,id,fieldKey,operation,userId=null,causationId=null) {
  await workflowObjectAccess(client,key,'update');
  z.string().uuid().parse(id);
  await recordAssignmentField(client,key,fieldKey,operation);
  const prior=await resolveRecord(client,id,key,true),before=prior.data[fieldKey] || null,after=operation==='clear'?null:await requireAssignmentMember(client,userId);
  const changed=before!==after,record=changed?await saveRecord(client,tenantId,actorId,key,{...prior.data,[fieldKey]:after},prior.id,prior.version,causationId):prior;
  return {record,field:fieldKey,before,after,changed};
}
export async function changeContactTags(client,tenantId,actorId,id,operation,tags,causationId=null) {
  await workflowObjectAccess(client,'people','update');
  z.enum(['add','remove']).parse(operation);tags=z.array(z.string().trim().min(1).max(80)).min(1).max(100).parse(tags);
  const prior=await resolveRecord(client,id,'people',true),before=[...new Set(prior.data.tags || [])],requested=[...new Set(tags)];
  const after=operation==='add'?[...new Set([...before,...requested])]:before.filter(t=>!requested.includes(t));
  const added=after.filter(t=>!before.includes(t)),removed=before.filter(t=>!after.includes(t));
  if(after.length>100)throw new AppError(400,'A contact supports up to 100 tags. Remove some before adding more.');
  const changed=!!(added.length || removed.length),record=changed?await saveRecord(client,tenantId,actorId,'people',{...prior.data,tags:after},prior.id,prior.version,causationId):prior;
  return {record,before,after,added,removed,changed};
}
export async function dealStageDestination(client,pipelineId,stageId=null) {
  z.string().uuid().parse(pipelineId);
  const pipeline=(await client.query('SELECT * FROM pipelines WHERE id=$1 FOR SHARE',[pipelineId])).rows[0];
  if(!pipeline)throw new AppError(404,'Pipeline not found in this workspace.');
  const stage=stageId===null?null:pipeline.stages.find(s=>s.id===stageId);
  if(stageId!==null && !stage)throw new AppError(400,'Choose a stage in the selected pipeline.');
  return {pipeline,stage};
}
export async function moveDealStage(client,tenantId,actorId,id,pipelineId,stageId,status='keep',causationId=null) {
  await workflowObjectAccess(client,'deals','update');
  z.enum(['keep','Open','Won','Lost']).parse(status);z.string().regex(/^[a-z0-9_-]{1,40}$/).parse(stageId);
  const prior=await resolveRecord(client,id,'deals',true),{stage}=await dealStageDestination(client,pipelineId,stageId);
  const moved=prior.data.pipeline_id!==pipelineId || prior.data.stage!==stageId,nextStatus=status==='keep'?prior.data.status:status;
  const changed=moved || prior.data.status!==nextStatus;
  const before={...await stageSnapshot(client,prior.data),status:prior.data.status || null,probability:prior.data.probability ?? null};
  const record=changed?await saveRecord(client,tenantId,actorId,'deals',{...prior.data,pipeline_id:pipelineId,stage:stageId,...(moved?{probability:stage.probability}:{}),...(status==='keep'?{}:{status})},prior.id,prior.version,causationId):prior;
  return {record,before,after:{...await stageSnapshot(client,record.data),status:record.data.status || null,probability:record.data.probability ?? null},changed};
}
async function stageSnapshot(client,data) {
  const pipeline=data.pipeline_id?(await client.query('SELECT name,stages FROM pipelines WHERE id=$1 FOR SHARE',[data.pipeline_id])).rows[0]:null;
  return {pipeline_id:data.pipeline_id || null,pipeline_name:pipeline?.name || 'No pipeline',stage_id:data.stage || null,stage_name:pipeline?.stages.find(s=>s.id===data.stage)?.name || data.stage || 'Unassigned stage'};
}
export async function dealStageHistory(client,id,cursor=null) {
  z.string().uuid().parse(id);if(cursor)z.string().uuid().parse(cursor);
  await resolveRecord(client,id,'deals');
  const after=cursor?(await client.query('SELECT record_version FROM deal_stage_history WHERE deal_id=$1 AND id=$2',[id,cursor])).rows[0]?.record_version:null;
  if(cursor&&!after)throw new AppError(400,'This history page is unavailable. Refresh the history.');
  const rows=(await client.query(`SELECT h.*,coalesce(u.name,'Service account: '||s.name,'Workflow / system') AS actor_name FROM deal_stage_history h LEFT JOIN users u ON u.id=h.actor_id LEFT JOIN service_accounts s ON s.tenant_id=h.tenant_id AND s.id=h.service_account_id WHERE h.deal_id=$1 AND ($2::int IS NULL OR h.record_version<$2) ORDER BY h.record_version DESC LIMIT 26`,[id,after])).rows;
  return {items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null};
}
export async function deleteRecord(client,tenantId,actorId,key,id,version=null) {
  if(['invoices','purchase_orders','expenses'].includes(key))throw new AppError(400,'Financial records must be cancelled or rejected in Finance.');
  const old=(await client.query('SELECT * FROM records WHERE id=$1 AND object_key=$2 FOR UPDATE',[id,key])).rows[0];
  if(!old)throw new AppError(404,'Record not found in this workspace.');
  if(old.merged_into || (await client.query('SELECT 1 FROM records WHERE merged_into=$1 LIMIT 1',[id])).rowCount)throw new AppError(409,'This contact preserves merge history and cannot be deleted.');
  if(version!==null && old.version!==version)throw new AppError(409,'A selected record changed. Refresh before trying again.');
  // ponytail: scan JSON relation definitions on deletion; use an indexed relation registry for large datasets.
  const linked=await client.query(`SELECT r.id FROM records r JOIN object_definitions d ON d.tenant_id=r.tenant_id AND d.key=r.object_key WHERE r.id<>$1::uuid AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.fields) f WHERE f->>'type'='relation' AND r.data->>(f->>'key')=$1::text) LIMIT 1`,[id]);
  if(linked.rowCount)throw new AppError(409,'Another record links to this record. Remove that link before deleting.');
  await client.query('DELETE FROM records WHERE id=$1 AND object_key=$2',[id,key]);
  await event(client,tenantId,actorId,`crm.${key}.deleted`,key,old.id,{record:old});
}
export async function addActivity(client,tenantId,actorId,input,causationId=null) {
  const b=z.object({record_id:z.string().uuid(),body:z.string().trim().min(1).max(10000),type:z.enum(['note','call','email','meeting']).default('note')}).parse(input);
  const record=await resolveRecord(client,b.record_id);
  await workflowObjectAccess(client,record.object_key,'note');
  const activity=(await client.query('INSERT INTO activities(tenant_id,id,record_id,actor_id,type,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[tenantId,randomUUID(),record.id,actorId,b.type,b.body])).rows[0];
  await event(client,tenantId,actorId,'crm.activity.created','activity',activity.id,{activity,record},causationId);
  return activity;
}
const reportDate=z.iso.date().refine(v=>v>='0001-01-01','Choose a calendar date after year zero.');
const widgetDateRange=z.object({
  period:z.enum(['custom','today','last_7_days','last_30_days','this_month','last_month']),
  source:z.enum(['created_at','updated_at','field']),field:keySchema.optional(),from:reportDate.optional(),to:reportDate.optional(),
}).strict().superRefine((v,c)=>{
  if(v.source==='field' && !v.field)c.addIssue({code:'custom',message:'Choose a date field.'});
  if(v.period==='custom' && (!v.from || !v.to || v.from>v.to))c.addIssue({code:'custom',message:'Choose a start and end date in order.'});
  if(v.period!=='custom' && (v.from || v.to))c.addIssue({code:'custom',message:'Fixed dates belong to a custom date range.'});
});
export const widgetSchema=z.object({
  id:z.string().min(1).max(80),title:z.string().min(1).max(120),object:keySchema,
  operation:z.enum(['count','sum','avg']),field:keySchema.optional(),group_by:keySchema.optional(),
  display:z.enum(['metric','bar','donut']),currency:currencySchema.optional(),filter:z.object({field:keySchema,value:z.string().max(200)}).optional(),date_range:widgetDateRange.optional(),
});
export function resolveWidgetDates(range,timezone,now=new Date()) {
  if(!range)return null;
  if(range.period==='custom')return {from:range.from,to:range.to};
  let parts;
  try{parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);}catch{throw new AppError(400,'Choose a valid workspace timezone before querying dates.');}
  const part=k=>parts.find(p=>p.type===k).value;
  const end=new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`),start=new Date(end);
  if(range.period==='last_7_days')start.setUTCDate(start.getUTCDate()-6);
  if(range.period==='last_30_days')start.setUTCDate(start.getUTCDate()-29);
  if(range.period==='this_month')start.setUTCDate(1);
  if(range.period==='last_month'){end.setUTCDate(0);start.setUTCDate(1);start.setUTCMonth(start.getUTCMonth()-1);}
  return {from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10)};
}
export async function widgetReportContext(client,widget,now=new Date()) {
  const settings=(await client.query("SELECT settings FROM workspaces WHERE id=nullif(current_setting('app.tenant_id',true),'')::uuid")).rows[0]?.settings || {};
  const timezone=settings.timezone || 'UTC';
  return {timezone,currency:widget.filter?.field==='currency'?widget.filter.value:widget.currency || settings.currency || 'USD',dates:resolveWidgetDates(widget.date_range,timezone,now)};
}
export async function aggregate(client,widget,context=null) {
  const d=await getDefinition(client,widget.object);
  if(['invoices','purchase_orders','expenses'].includes(widget.object) && widget.operation!=='count' && !widget.currency && widget.filter?.field!=='currency')throw new AppError(400,'Choose a currency for financial totals.');
  const fields=new Map(d.fields.map(f=>[f.key,f]));
  const monetary=widget.operation!=='count' && (fields.get(widget.field)?.type==='currency' || ['invoices','purchase_orders','expenses'].includes(widget.object));
  if(widget.operation!=='count' && !['number','currency'].includes(fields.get(widget.field)?.type)) throw new AppError(400,'This KPI needs a numeric field.');
  if(widget.group_by && (!fields.has(widget.group_by) || ['json','relation','multi_select'].includes(fields.get(widget.group_by)?.type))) throw new AppError(400,'Choose a scalar grouping field.');
  if(widget.display==='metric' && widget.group_by)throw new AppError(400,'A KPI number uses one aggregate. Choose a chart to group categories.');
  if(widget.filter && !fields.has(widget.filter.field)) throw new AppError(400,'Unknown filter field.');
  if(widget.filter?.field==='currency')currencySchema.parse(widget.filter.value);
  if(widget.date_range?.source==='field' && fields.get(widget.date_range.field)?.type!=='date')throw new AppError(400,'Choose a date field from this object.');
  if(context===null)context=await widgetReportContext(client,widget);
  const params=[widget.object];
  const arg=v=>{params.push(v);return `$${params.length}`;};
  const expr=widget.operation==='count'?'count(*)':`${widget.operation}(nullif(data->>${arg(widget.field)},'')::numeric)`;
  let where=widget.filter?` AND data->>${arg(widget.filter.field)}=${arg(widget.filter.value)}`:'';
  if(monetary && widget.filter?.field!=='currency'){
    where+=` AND data->>${arg('currency')}=${arg(context.currency)}`;
  }
  // ponytail: workspace-date comparisons scan this object; use indexed UTC bounds if query plans show timestamp filtering is hot.
  if(context.dates){
    const range=widget.date_range;
    const date=range.source==='field'?`data->>${arg(range.field)}`:`(${range.source} AT TIME ZONE ${arg(context.timezone)})::date`;
    where+=` AND ${date}>=${arg(context.dates.from)}${range.source==='field'?'::text':'::date'} AND ${date}<=${arg(context.dates.to)}${range.source==='field'?'::text':'::date'}`;
  }
  const group=widget.group_by?`coalesce(nullif(data->>${arg(widget.group_by)},''),'Unspecified')`:`'Total'`;
  const {rows}=await client.query(`SELECT ${group} AS label,coalesce(${expr},0)::float8 AS value FROM records WHERE object_key=$1 AND merged_into IS NULL${where} GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 100`,params);
  return rows.length?rows:[{label:'Total',value:0}];
}
