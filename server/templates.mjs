import { Router } from 'express';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { tenantTransaction,event } from './db.mjs';
import { requireWrite } from './auth.mjs';
import { AppError } from './model.mjs';
import { invoicePdf,invoiceTotals } from './finance.mjs';
import { templateInputSchema,invoiceTemplateSchema } from './template-content.mjs';

export const templatesRouter=Router();
const tx=(req,fn)=>tenantTransaction(req.auth.workspace.id,fn);
async function library(c,id,lock=false){return (await c.query(`SELECT settings->'templates' AS templates FROM workspaces WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0]?.templates || [];}
templatesRouter.get('/',async(req,res)=>res.json(await tx(req,c=>library(c,req.auth.workspace.id))));
templatesRouter.get('/:id',async(req,res)=>{z.string().uuid().parse(req.params.id);const item=(await tx(req,c=>library(c,req.auth.workspace.id))).find(v=>v.id===req.params.id);if(!item)throw new AppError(404,'Template not found in this workspace.');res.json(item);});
templatesRouter.post('/invoice-preview',async(req,res)=>{
  const content=invoiceTemplateSchema.parse(req.body),currency=req.auth.workspace.settings.currency || 'USD',totals=invoiceTotals([{description:'Sample service',quantity:'1',unit_price:'100',tax_rate:'0'}],currency);
  const pdf=await invoicePdf({status:'Draft',customer_name:'Sample customer',customer_email:'sample@example.test',currency,issue_date:'2026-10-02',due_date:'2026-11-01',...totals,paid_minor:0,balance_minor:totals.total_minor,notes:content.notes,document_template:content},req.auth.workspace.settings.finance || {business_name:req.auth.workspace.name});
  res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="sample-invoice.pdf"','Cache-Control':'private, no-store'}).send(pdf);
});
async function save(req,update){
  const {id,version,...raw}=req.body || {};z.string().uuid().parse(update?req.params.id:id);
  const input=templateInputSchema.parse(raw);if(update)z.number().int().positive().parse(version);else if(version!==undefined)throw new AppError(400,'Do not supply a version when creating a template.');
  return tx(req,async c=>{
    const tenant=req.auth.workspace.id,items=await library(c,tenant,true),key=update?req.params.id:id,index=items.findIndex(v=>v.id===key),old=items[index];
    if(update&&!old)throw new AppError(404,'Template not found in this workspace.');
    if(!update&&old){if(isDeepStrictEqual({name:old.name,kind:old.kind,content:old.content,archived:old.archived},input))return old;throw new AppError(409,'This creation ID was used for another template.');}
    if(update&&(old.version!==version||old.kind!==input.kind))throw new AppError(409,'The template changed. Reload the saved version before editing. Template types cannot be changed.');
    // ponytail: a bounded workspace JSON library; move to indexed rows if more than100 templates per workspace are needed.
    if(!update&&items.length>=100)throw new AppError(400,'This workspace has100 templates. Reuse or edit an existing template.');
    const timestamp=new Date().toISOString(),item={id:key,...input,version:(old?.version || 0)+1,created_at:old?.created_at || timestamp,updated_at:timestamp};
    if(update)items[index]=item;else items.push(item);
    if(Buffer.byteLength(JSON.stringify(items))>2097152)throw new AppError(400,'The template library exceeds2 MB. Shorten existing templates before adding more.');
    await c.query("UPDATE workspaces SET settings=jsonb_set(settings,'{templates}',$1::jsonb) WHERE id=$2",[JSON.stringify(items),tenant]);
    await event(c,tenant,req.auth.user.id,`workspace.template.${update?'updated':'created'}`,'template',key,{templateId:key,kind:item.kind,version:item.version,archived:item.archived});return item;
  });
}
templatesRouter.post('/',requireWrite,async(req,res)=>res.status(201).json(await save(req,false)));
templatesRouter.put('/:id',requireWrite,async(req,res)=>res.json(await save(req,true)));
