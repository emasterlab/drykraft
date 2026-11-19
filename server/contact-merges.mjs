import { z } from 'zod';
import { createHash } from 'node:crypto';
import { event } from './db.mjs';
import { AppError,getDefinition,prepareRecordData,saveRecord } from './model.mjs';

export const mergeSchema=z.object({
  contacts:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive()}).strict()).length(2),
  target_id:z.string().uuid(),take_source:z.array(z.string()).max(100).default([]),
}).strict().superRefine((b,c)=>{
  if(b.contacts[0].id===b.contacts[1].id || !b.contacts.some(r=>r.id===b.target_id) || new Set(b.take_source).size!==b.take_source.length)c.addIssue({code:'custom',message:'Choose two different contacts, one remaining contact and each field once.'});
});
export const mergeCommitSchema=mergeSchema.safeExtend({id:z.string().uuid(),review_token:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty=value=>value===null || value===undefined || value==='' || Array.isArray(value)&&!value.length;
const financial=r=>['invoices','purchase_orders','expenses'].includes(r.object_key);
const frozen=r=>financial(r)&&r.data.status!=='Draft';

async function review(client,tenantId,input) {
  // Holding the definition and contacts also gates new relationships and notes through resolveRecord.
  const definitions=(await client.query('SELECT key,fields FROM object_definitions ORDER BY key FOR SHARE')).rows;
  const definition=await getDefinition(client,'people');
  const contacts=(await client.query("SELECT * FROM records WHERE id=ANY($1::uuid[]) AND object_key='people' ORDER BY id FOR UPDATE",[input.contacts.map(r=>r.id)])).rows;
  if(contacts.length!==2)throw new AppError(404,'Choose two contacts from this workspace.');
  if(contacts.some(r=>r.merged_into || r.version!==input.contacts.find(v=>v.id===r.id).version))throw new AppError(409,'A contact changed or was merged. Close this review and select the contacts again.');
  const target=contacts.find(r=>r.id===input.target_id),source=contacts.find(r=>r.id!==input.target_id);
  if(input.take_source.some(key=>!definition.fields.some(f=>f.key===key)||['consent','tags'].includes(key)))throw new AppError(400,'Choose current contact fields. Consent and tags follow the merge rules.');
  const data={...target.data};
  for(const f of definition.fields)if(input.take_source.includes(f.key) || empty(data[f.key])) {
    if(source.data[f.key]!==undefined)data[f.key]=source.data[f.key];else delete data[f.key];
  }
  data.consent=source.data.consent===true && target.data.consent===true;
  if(definition.fields.some(f=>f.key==='tags'))data.tags=[...new Set([...(target.data.tags || []),...(source.data.tags || [])])];
  // Currency amounts have meaning only with their original currency. Never combine unlike denominations.
  if(definition.fields.some(f=>f.type==='currency') && target.data.currency && source.data.currency && target.data.currency!==source.data.currency)throw new AppError(400,'These contacts use different currencies in custom amount fields. Align those values and currencies before merging.');
  const prepared=await prepareRecordData(client,tenantId,'people',data,target);
  // ponytail: scan declared JSON relations; use an indexed relation registry once measured tenant sizes require it.
  const related=(await client.query(`SELECT r.* FROM records r JOIN object_definitions d ON d.tenant_id=r.tenant_id AND d.key=r.object_key WHERE r.merged_into IS NULL AND r.id<>ALL($2::uuid[]) AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.fields) f WHERE f->>'type'='relation' AND r.data->>(f->>'key')=$1::text) ORDER BY r.id FOR UPDATE OF r`,[source.id,contacts.map(r=>r.id)])).rows;
  const activities=(await client.query('SELECT id,record_id FROM activities WHERE record_id=ANY($1::uuid[]) ORDER BY id',[contacts.map(r=>r.id)])).rows;
  const links=(await client.query('SELECT source_id,target_id,relation FROM record_links WHERE source_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[]) ORDER BY source_id,target_id,relation',[contacts.map(r=>r.id)])).rows;
  const enrollments=(await client.query("SELECT id,execution_id FROM outreach_enrollments WHERE record_id=$1 AND status='active' ORDER BY id FOR UPDATE",[source.id])).rows;
  const effects={notes:activities.filter(a=>a.record_id===source.id).length,relationships:related.filter(r=>!frozen(r)).length,financial_history:related.filter(frozen).length,links:links.filter(l=>l.source_id===source.id || l.target_id===source.id).length,stopped_sequences:enrollments.length};
  const review_token=hash([definitions,contacts,prepared,related,activities,links,enrollments]);
  return {target,source,definition,related,activities,links,enrollments,data:prepared,effects,review_token};
}
export async function previewMerge(client,tenantId,input) {
  const r=await review(client,tenantId,input);
  return {contacts:[r.target,r.source],data:r.data,effects:r.effects,review_token:r.review_token};
}
export async function commitMerge(client,tenantId,actorId,input) {
  const payload_hash=hash([input.contacts.slice().sort((a,b)=>a.id.localeCompare(b.id)),input.target_id,input.take_source.slice().sort(),input.review_token]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`merge:${tenantId}:${input.id}`]);
  const previous=(await client.query('SELECT payload_hash,result FROM record_merges WHERE id=$1',[input.id])).rows[0];
  if(previous){if(previous.payload_hash!==payload_hash)throw new AppError(409,'This merge reference was used for another review. Start a new merge.');return previous.result;}
  const r=await review(client,tenantId,input);
  if(r.review_token!==input.review_token)throw new AppError(409,'The contacts, notes, relationships or outreach changed. Review the merge again before confirming.');
  await client.query('UPDATE records SET merged_into=$1,version=version+1,updated_at=now() WHERE id=$2',[r.target.id,r.source.id]);
  // Normalize any self/contact relation after the source becomes an alias.
  const record=await saveRecord(client,tenantId,actorId,'people',r.data,r.target.id,r.target.version);
  for(const old of r.related) {
    if(frozen(old))continue;
    const definition=await getDefinition(client,old.object_key),data={...old.data};
    for(const field of definition.fields)if(field.type==='relation' && data[field.key]===r.source.id)data[field.key]=record.id;
    if(financial(old)) {
      const changed=(await client.query('UPDATE records SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *',[data,old.id])).rows[0];
      await event(client,tenantId,actorId,`finance.${old.object_key==='invoices'?'invoice':'expense'}.updated`,old.object_key,old.id,{record:changed,mergeId:input.id});
    }else await saveRecord(client,tenantId,actorId,old.object_key,data,old.id,old.version);
  }
  await client.query('UPDATE activities SET record_id=$1 WHERE record_id=$2',[record.id,r.source.id]);
  await client.query('DELETE FROM record_links WHERE source_id=$1 OR target_id=$1',[r.source.id]);
  for(const link of r.links)if(link.source_id===r.source.id || link.target_id===r.source.id) {
    const source=link.source_id===r.source.id?record.id:link.source_id,target=link.target_id===r.source.id?record.id:link.target_id;
    if(source!==target)await client.query('INSERT INTO record_links(tenant_id,source_id,target_id,relation) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenantId,source,target,link.relation]);
  }
  await client.query("UPDATE outreach_enrollments SET status='cancelled' WHERE record_id=$1 AND status='active'",[r.source.id]);
  if(r.enrollments.length)await client.query("UPDATE executions SET state='cancelled',completed_at=now() WHERE id=ANY($1::uuid[]) AND state IN ('queued','running','waiting','retrying')",[r.enrollments.map(e=>e.execution_id)]);
  const result={record,merged_id:r.source.id,effects:r.effects,merge_id:input.id};
  await client.query('INSERT INTO record_merges(tenant_id,id,payload_hash,before_records,result,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[tenantId,input.id,payload_hash,JSON.stringify([r.target,r.source]),result,actorId]);
  await event(client,tenantId,actorId,'crm.people.merged','people',record.id,{record,mergeId:input.id,sourceId:r.source.id,targetId:record.id,effects:r.effects});
  return result;
}
