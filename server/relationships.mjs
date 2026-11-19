import {z} from 'zod';
import {AppError,getDefinition,resolveRecord} from './model.mjs';

const query=z.object({section:z.enum(['records','appointments','outreach','workflows']).default('records'),offset:z.coerce.number().int().min(0).max(100000).default(0),limit:z.coerce.number().int().min(1).max(50).default(12)});
// Follow declared relationships, never matching a customer's name or arbitrary JSON text.
// Context includes the current record, its contact/source lead/deal, and those explicitly
// attached to a Person or Company. This lets a lead show the invoice booked against its deal.
const contextSql=`WITH RECURSIVE context_raw AS (
 SELECT id FROM records WHERE id=$1
 UNION SELECT id FROM records WHERE id=ANY($3::uuid[]) AND object_key IN ('people','leads','deals')
 UNION SELECT r.id FROM record_links l JOIN records r ON (l.source_id=$1 AND l.target_id=r.id) OR (l.target_id=$1 AND l.source_id=r.id) WHERE r.object_key IN ('people','leads','deals')
 UNION SELECT source.id FROM records source
 WHERE source.merged_into IS NULL AND (
  ($2='leads' AND source.object_key='deals' AND source.data->>'lead_id'=$1::text)
  OR ($2='people' AND source.object_key IN ('leads','deals') AND source.data->>'person_id'=$1::text)
  OR ($2='companies' AND source.object_key IN ('people','leads','deals') AND source.data->>'company_id'=$1::text)
 )
), context_ids AS (
 SELECT id FROM context_raw
 UNION SELECT alias.id FROM records alias JOIN context_ids target ON alias.merged_into=target.id
)`;
export async function relatedRecords(c,key,id,input={}){
 z.string().uuid().parse(id);const definition=await getDefinition(c,key),record=await resolveRecord(c,id,key),q=query.parse(input),forward=[];
 for(const field of definition.fields.filter(f=>f.type==='relation'))if(z.string().uuid().safeParse(record.data[field.key]).success){try{forward.push((await resolveRecord(c,record.data[field.key],field.object || null)).id);}catch(error){if(error.status!==404)throw error;}}
 let candidates,projection;
 if(q.section==='records'){
  candidates=`SELECT DISTINCT r.id,r.object_key,r.data,r.created_at FROM records r
   WHERE r.id<>$1 AND r.merged_into IS NULL AND (
    EXISTS(SELECT 1 FROM object_definitions d CROSS JOIN LATERAL jsonb_array_elements(d.fields) f
     JOIN context_ids ctx ON r.data->> (f->>'key')=ctx.id::text
     JOIN records target ON target.id=ctx.id
     WHERE d.key=r.object_key AND f->>'type'='relation' AND (f->>'object' IS NULL OR f->>'object'=target.object_key))
    OR r.id=ANY($3::uuid[])
    OR EXISTS(SELECT 1 FROM record_links l WHERE (l.source_id=$1 AND l.target_id=r.id) OR (l.target_id=$1 AND l.source_id=r.id))
   )`;
  projection="id,object_key,coalesce(data->>'name','Untitled record') AS name,data->>'status' AS status,created_at";
 }else if(q.section==='appointments'){
  candidates='SELECT a.id,a.title AS name,a.state AS status,a.starts_at,a.created_at FROM appointments a JOIN context_ids ctx ON ctx.id=a.record_id';
  projection='id,name,status,starts_at,created_at';
 }else if(q.section==='outreach'){
  candidates='SELECT e.id,e.campaign_id,e.status,e.created_at,c.name,c.channel FROM outreach_enrollments e JOIN context_ids ctx ON ctx.id=e.record_id JOIN outreach_campaigns c ON c.id=e.campaign_id AND c.tenant_id=e.tenant_id';
  projection='id,campaign_id,name,channel,status,created_at';
 }else{
  candidates="SELECT e.id,w.name,e.state AS status,e.created_at FROM executions e JOIN workflows w ON w.id=e.workflow_id AND w.tenant_id=e.tenant_id WHERE EXISTS(SELECT 1 FROM context_ids ctx WHERE e.context->'record'->>'id'=ctx.id::text)";
  projection='id,name,status,created_at';
 }
 const params=[record.id,record.object_key,forward],base=`${contextSql}, candidates AS (${candidates})`;
 const total=Number((await c.query(`${base} SELECT count(*) AS total FROM candidates`,params)).rows[0].total);
 const items=(await c.query(`${base} SELECT ${projection} FROM candidates ORDER BY created_at DESC,id DESC OFFSET $4 LIMIT $5`,[...params,q.offset,q.limit])).rows;
 return {section:q.section,items,total,next_offset:q.offset+items.length<total?q.offset+items.length:null};
}

export async function invoiceContext(c,key,id){
 const source=await resolveRecord(c,id,key);
 if(!['people','companies','leads','deals'].includes(key))throw new AppError(400,'Choose a contact, company, lead or deal for an invoice.');
 let deal=key==='deals'?source:null;
 if(key==='leads')deal=(await c.query("SELECT * FROM records WHERE object_key='deals' AND data->>'lead_id'=$1 ORDER BY created_at,id LIMIT 1",[source.id])).rows[0];
 const contactId=key==='people'?source.id:deal?.data.person_id || source.data.person_id;
 const contact=contactId?await resolveRecord(c,contactId,'people'):null;
 const companyId=key==='companies'?source.id:deal?.data.company_id || source.data.company_id || contact?.data.company_id;
 const company=companyId?await resolveRecord(c,companyId,'companies'):null;
 return {name:deal?.data.name || source.data.name,customer_name:company?.data.name || contact?.data.company || contact?.data.name || source.data.name,customer_email:contact?.data.email || source.data.email || '',...(contact?{contact_id:contact.id}:{}),...(company?{company_id:company.id}:{}),...(deal?{deal_id:deal.id,currency:deal.data.currency,items:[{description:deal.data.name,quantity:'1',unit_price:String(deal.data.value ?? 0),discount:'0',tax_rate:'0'}]}:{})};
}
