import express from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { tenantTransaction } from './db.mjs';
import { requireWrite,requireAdmin } from './auth.mjs';
import { mergeSchema,mergeCommitSchema,previewMerge,commitMerge } from './contact-merges.mjs';
import { AppError,getDefinition,prepareRecordData,saveRecord,deleteRecord,keySchema } from './model.mjs';
import { parseCsv,csvValue } from './csv.mjs';

export const recordToolsRouter=express.Router();
recordToolsRouter.post('/people/merge/preview',requireAdmin,async(req,res)=>{
  const b=mergeSchema.parse(req.body);res.json(await tenantTransaction(req.auth.workspace.id,c=>previewMerge(c,req.auth.workspace.id,b)));
});
recordToolsRouter.post('/people/merge/commit',requireAdmin,async(req,res)=>{
  const b=mergeCommitSchema.parse(req.body);res.json(await tenantTransaction(req.auth.workspace.id,c=>commitMerge(c,req.auth.workspace.id,req.auth.user.id,b)));
});
const input=z.object({csv:z.string().max(300000),mapping:z.array(keySchema.nullable()).max(100).optional(),duplicates:z.enum(['skip','update','error']).default('skip')});
async function planImport(client,tenantId,key,body){
  if(['invoices','purchase_orders','expenses'].includes(key))throw new AppError(400,'Use Finance to create financial records.');
  const definition=await getDefinition(client,key),{headers,rows}=parseCsv(body.csv),fields=new Map(definition.fields.map(f=>[f.key,f]));
  const used=new Set(),mapping=body.mapping || headers.map(h=>{const f=definition.fields.find(f=>(f.key.toLowerCase()===h.toLowerCase() || f.name.toLowerCase()===h.toLowerCase()) && !used.has(f.key));if(f)used.add(f.key);return f?.key || null;});
  if(mapping.length!==headers.length || mapping.some(k=>k && !fields.has(k)) || new Set(mapping.filter(Boolean)).size!==mapping.filter(Boolean).length)throw new AppError(400,'Map each field once using this object’s current fields.');
  if(!mapping.some(Boolean))return {plan:[],report:{headers,mapping,rows:rows.length,created:0,updated:0,skipped:0,error_count:1,errors:[{line:1,message:'Map at least one CSV column to a record field.'}],preview:[],can_import:false}};
  const emails=key==='people' && mapping.includes('email')?rows.map(r=>r.values[mapping.indexOf('email')].trim().toLowerCase()).filter(Boolean):[];
  const existing=emails.length?(await client.query("SELECT * FROM records WHERE object_key='people' AND merged_into IS NULL AND lower(data->>'email')=ANY($1::text[]) ORDER BY id",[emails])).rows:[];
  const byEmail=new Map(existing.map(r=>[r.data.email.toLowerCase(),r])),seen=new Set(),plan=[],errors=[];
  for(const row of rows){
    try{
      const values=Object.fromEntries(mapping.flatMap((key,i)=>key && row.values[i].trim()!==''?[[key,csvValue(fields.get(key),row.values[i])]]:[]));
      const email=key==='people'?values.email:null,prior=email?byEmail.get(email):null;
      if(email && (seen.has(email) || prior) && body.duplicates==='skip'){plan.push({line:row.line,action:'skip',data:values});continue;}
      if(email && seen.has(email))throw new AppError(400,'This email occurs more than once in the CSV. Keep one row per person.');
      if(prior && body.duplicates==='error')throw new AppError(400,'A person with this email already exists. Choose skip or update duplicates.');
      const data=await prepareRecordData(client,tenantId,key,{...(prior?.data || {}),...values},prior);
      if(email)seen.add(email);plan.push({line:row.line,action:prior?'update':'create',data,prior});
    }catch(error){if(!(error instanceof AppError) && !(error instanceof z.ZodError))throw error;errors.push({line:row.line,message:error instanceof z.ZodError?error.issues.map(i=>i.message).join(' '):error.message});}
  }
  return {plan,report:{headers,mapping,rows:rows.length,created:plan.filter(r=>r.action==='create').length,updated:plan.filter(r=>r.action==='update').length,skipped:plan.filter(r=>r.action==='skip').length,error_count:errors.length,errors:errors.slice(0,20),preview:plan.slice(0,5).map(({line,action,data})=>({line,action,data})),can_import:errors.length===0}};
}
recordToolsRouter.post('/:key/import/preview',requireWrite,async(req,res)=>{
  const body=input.parse(req.body),key=keySchema.parse(req.params.key);
  res.json(await tenantTransaction(req.auth.workspace.id,async c=>(await planImport(c,req.auth.workspace.id,key,body)).report));
});
recordToolsRouter.post('/:key/import/commit',requireWrite,async(req,res)=>{
  const body=input.extend({id:z.string().uuid()}).parse(req.body),key=keySchema.parse(req.params.key),tenant=req.auth.workspace.id;
  const hash=createHash('sha256').update(JSON.stringify([key,body.csv,body.mapping || null,body.duplicates])).digest('hex');
  res.json(await tenantTransaction(tenant,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`import:${tenant}:${body.id}`]);
    const previous=(await c.query('SELECT * FROM record_imports WHERE id=$1',[body.id])).rows[0];
    if(previous){if(previous.payload_hash!==hash)throw new AppError(409,'This import reference was used for a different file or mapping. Start a new import.');return previous.result;}
    const {plan,report}=await planImport(c,tenant,key,body);
    if(report.error_count)throw new AppError(400,`Fix ${report.error_count} CSV row${report.error_count===1?'':'s'} before importing.`);
    // Lock updated records in a stable order; optimistic versions reject changes since planning.
    const ids=plan.filter(r=>r.prior).map(r=>r.prior.id);if(ids.length)await c.query('SELECT id FROM records WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
    for(const row of plan)if(row.action!=='skip')await saveRecord(c,tenant,req.auth.user.id,key,row.data,row.prior?.id || null,row.prior?.version || null);
    const result={id:body.id,created:report.created,updated:report.updated,skipped:report.skipped,rows:report.rows};
    await c.query('INSERT INTO record_imports(tenant_id,id,object_key,payload_hash,result,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[tenant,body.id,key,hash,result,req.auth.user.id]);
    return result;
  }));
});
recordToolsRouter.post('/:key/bulk',requireWrite,async(req,res)=>{
  const body=z.object({records:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive()})).min(1).max(100),action:z.enum(['update','delete']),data:z.record(z.string(),z.unknown()).optional()}).parse(req.body);
  const key=keySchema.parse(req.params.key),tenant=req.auth.workspace.id;
  if(['invoices','purchase_orders','expenses'].includes(key))throw new AppError(400,'Use Finance to change financial records.');
  if(new Set(body.records.map(r=>r.id)).size!==body.records.length)throw new AppError(400,'Select each record only once.');
  if(body.action==='update' && (!body.data || !Object.keys(body.data).length))throw new AppError(400,'Choose a field and value to update.');
  res.json(await tenantTransaction(tenant,async c=>{
    await getDefinition(c,key);
    const rows=(await c.query('SELECT * FROM records WHERE object_key=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[key,body.records.map(r=>r.id)])).rows;
    if(rows.length!==body.records.length || rows.some(r=>r.version!==body.records.find(v=>v.id===r.id).version))throw new AppError(409,'A selected record changed or is unavailable. Refresh and select the records again.');
    for(const r of rows)if(body.action==='delete')await deleteRecord(c,tenant,req.auth.user.id,key,r.id,r.version);else await saveRecord(c,tenant,req.auth.user.id,key,{...r.data,...body.data},r.id,r.version);
    return {changed:rows.length};
  }));
});
