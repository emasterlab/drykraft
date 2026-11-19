import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdfkit';
import path from 'node:path';
import { invoiceTemplateSchema } from './template-content.mjs';
import { currencySchema,currencyDigits as precision,workspaceCurrencies } from './currency.mjs';
import { pool,tenantTransaction,event } from './db.mjs';
import { requireWrite,requireAdmin } from './auth.mjs';
import { AppError,getDefinition,validateData,resolveRecord } from './model.mjs';
import {workflowObjectAccess} from './workflow-access.mjs';

export function currencyDigits(currency){return precision(currency);}
function decimal(value,digits,label){
  const text=String(value ?? '0');
  if(!new RegExp(`^\\d{1,12}(?:\\.\\d{1,${digits || 1}})?$`).test(text) || (!digits && text.includes('.')))throw new AppError(400,`${label} must have at most ${digits} decimal places.`);
  const [whole,fraction='']=text.split('.');return BigInt(whole)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0') || '0');
}
function bounded(amount){if(amount<0n || amount>1000000000000n)throw new AppError(400,'Amount is outside the supported range.');return Number(amount);}
export function minor(value,currency){return bounded(decimal(value,currencyDigits(currency),'Amount'));}
const round=(value,denominator)=>(value+denominator/2n)/denominator;
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v,'Enter a valid date.');
const text=z.string().trim().max(2000);
export const profileSchema=z.object({business_name:z.string().trim().min(1).max(160),email:z.union([z.string().email(),z.literal('')]).default(''),address:text.default(''),tax_id:z.string().max(100).default(''),payment_instructions:text.default(''),invoice_prefix:z.string().regex(/^[A-Z0-9-]{1,12}$/).default('INV'),purchase_order_prefix:z.string().regex(/^[A-Z0-9-]{1,12}$/).default('PO')});
const invoiceKeys=['name','customer_name','customer_email','billing_address','contact_id','company_id','deal_id','currency','issue_date','due_date','items','notes','document_template'];
const purchaseOrderKeys=['name','vendor','vendor_email','vendor_address','company_id','deal_id','currency','order_date','expected_date','items','notes'];
const expenseKeys=['name','vendor','company_id','category','spent_on','currency','amount','tax','receipt_url','notes','deal_id'];
const derivedKeys=new Set(['invoice_number','po_number','status','issued_at','cancelled_at','cancel_reason','void_reason','subtotal_minor','discount_minor','tax_minor','total_minor','paid_minor','balance_minor','total','balance','issuer','submitted_by','approved_by','decision_note']);

export function invoiceTotals(items,currency){
  z.array(z.object({description:z.string().trim().min(1).max(500),quantity:z.union([z.string(),z.number()]),unit_price:z.union([z.string(),z.number()]),discount:z.union([z.string(),z.number()]).optional(),tax_rate:z.union([z.string(),z.number()]).optional()}).strict()).min(1).max(100).parse(items);
  let subtotal=0n,discount=0n,tax=0n;
  const lines=items.map(item=>{
    const quantity=decimal(item.quantity,3,'Quantity');if(quantity<=0n || quantity>1000000000n)throw new AppError(400,'Quantity must be positive and at most 1,000,000.');
    const rate=BigInt(minor(item.unit_price,currency)),gross=round(rate*quantity,1000n),off=BigInt(minor(item.discount || 0,currency));
    if(off>gross)throw new AppError(400,'A line discount cannot exceed its amount.');
    const basis=decimal(item.tax_rate || 0,2,'Tax rate');if(basis>10000n)throw new AppError(400,'Tax rate cannot exceed 100%.');
    const lineTax=round((gross-off)*basis,10000n);subtotal+=gross;discount+=off;tax+=lineTax;
    return {...item,description:item.description.trim(),quantity:String(item.quantity),unit_price:String(item.unit_price),discount:String(item.discount || 0),tax_rate:String(item.tax_rate || 0),net_minor:bounded(gross-off),tax_minor:bounded(lineTax),total_minor:bounded(gross-off+lineTax)};
  });
  return {items:lines,subtotal_minor:bounded(subtotal),discount_minor:bounded(discount),tax_minor:bounded(tax),total_minor:bounded(subtotal-discount+tax)};
}
export async function financeDraft(c,tenantId,actorId,key,raw,id=null,version=null,causationId=null){
  await workflowObjectAccess(c,key,id?'update':'create');
  if(!['invoices','purchase_orders','expenses'].includes(key))throw new AppError(400,'Choose invoices, purchase orders, or expenses.');
  const d=await getDefinition(c,key),editable=new Set(key==='invoices'?invoiceKeys:key==='purchase_orders'?purchaseOrderKeys:expenseKeys);
  for(const f of d.fields)if(!derivedKeys.has(f.key))editable.add(f.key);
  if(!raw || typeof raw!=='object' || Array.isArray(raw))throw new AppError(400,'Financial values must be an object.');
  for(const k of Object.keys(raw))if(!editable.has(k))throw new AppError(400,`The field ${k} is managed by Finance.`);
  const old=id?await getFinance(c,key,id):null;
  if(old && (old.data.status!=='Draft' || old.version!==version))throw new AppError(409,'Only the current draft can be edited. Refresh before saving.');
  const data={...raw,status:'Draft'},digits=currencyDigits(data.currency);
  if(data.deal_id){
    const deal=await resolveRecord(c,data.deal_id,'deals');
    if(['invoices','purchase_orders'].includes(key) && !data.company_id && deal.data.company_id)data.company_id=deal.data.company_id;
    if(key==='invoices' && !data.contact_id && deal.data.person_id)data.contact_id=deal.data.person_id;
  }
  if(key==='invoices' && data.contact_id){
    const contact=await resolveRecord(c,data.contact_id,'people');
    if(!data.company_id && contact.data.company_id)data.company_id=contact.data.company_id;
    if(!data.customer_name)data.customer_name=contact.data.company || contact.data.name;
    if(!data.customer_email && contact.data.email)data.customer_email=contact.data.email;
  }
  if(data.company_id){const company=await resolveRecord(c,data.company_id,'companies');if(key==='invoices' && !data.customer_name)data.customer_name=company.data.name;if(['expenses','purchase_orders'].includes(key) && !data.vendor)data.vendor=company.data.name;if(key==='purchase_orders'){if(!data.vendor_email&&company.data.email)data.vendor_email=company.data.email;if(!data.vendor_address&&company.data.address)data.vendor_address=company.data.address;}}
  const settings=(await c.query('SELECT settings FROM workspaces WHERE id=$1',[tenantId])).rows[0].settings;
  if(!workspaceCurrencies(settings).includes(data.currency) && old?.data.currency!==data.currency)throw new AppError(400,'Enable this currency in Workspace settings first.');
  if(key==='invoices'){
    date.parse(data.issue_date);date.parse(data.due_date);if(data.due_date<data.issue_date)throw new AppError(400,'Due date cannot be before the invoice date.');
    Object.assign(data,invoiceTotals(data.items,data.currency));data.paid_minor=0;data.balance_minor=data.total_minor;data.total=data.total_minor/10**digits;data.balance=data.total;
  }else if(key==='purchase_orders'){
    date.parse(data.order_date);if(data.expected_date){date.parse(data.expected_date);if(data.expected_date<data.order_date)throw new AppError(400,'Expected delivery cannot be before the order date.');}
    Object.assign(data,invoiceTotals(data.items,data.currency));
  }else{
    const amount=minor(data.amount,data.currency),tax=minor(data.tax || 0,data.currency);
    if(!amount || tax>amount)throw new AppError(400,'Expense must be positive, with included tax no greater than its total.');
    if(data.receipt_url){const u=z.string().url().parse(data.receipt_url);if(!['https:','http:'].includes(new URL(u).protocol))throw new AppError(400,'Use a web address for the receipt.');}
    Object.assign(data,{amount:amount/10**digits,tax:tax/10**digits,total_minor:amount,tax_minor:tax});
  }
  const documentTemplate=key==='invoices' && data.document_template!==undefined?invoiceTemplateSchema.parse(data.document_template):undefined;
  delete data.document_template;
  await validateData(c,d,data,old?.data || {});
  if(documentTemplate)data.document_template=documentTemplate;
  if(JSON.stringify(data).length>100000)throw new AppError(400,'This record is too large.');
  const record=(await c.query(id?'UPDATE records SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *':'INSERT INTO records(data,id,tenant_id,object_key,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[data,id || randomUUID(),...(!id?[tenantId,key,actorId]:[])])).rows[0];
  const resource=key==='invoices'?'invoice':key==='purchase_orders'?'purchase_order':'expense';
  await event(c,tenantId,actorId,`finance.${resource}.${id?'updated':'created'}`,key,record.id,{record},causationId);return record;
}
async function getFinance(c,key,id){z.string().uuid().parse(id);const r=(await c.query('SELECT * FROM records WHERE id=$1 AND object_key=$2 FOR UPDATE',[id,key])).rows[0];if(!r)throw new AppError(404,'Financial record not found in this workspace.');return r;}
async function change(c,tenantId,actorId,r,data,action){const record=(await c.query('UPDATE records SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *',[data,r.id])).rows[0],resource=r.object_key==='invoices'?'invoice':r.object_key==='purchase_orders'?'purchase_order':'expense';await event(c,tenantId,actorId,`finance.${resource}.${action}`,r.object_key,r.id,{record});return record;}
export const financeRouter=Router();
const tx=(req,fn)=>tenantTransaction(req.auth.workspace.id,fn);
financeRouter.get('/profile',(req,res)=>res.json({...{business_name:req.auth.workspace.name,email:'',address:'',tax_id:'',payment_instructions:'',invoice_prefix:'INV',purchase_order_prefix:'PO'},...(req.auth.workspace.settings.finance||{})}));
financeRouter.put('/profile',requireAdmin,async(req,res)=>{const b=profileSchema.parse(req.body);await pool.query("UPDATE workspaces SET settings=settings || jsonb_build_object('finance',$1::jsonb) WHERE id=$2",[JSON.stringify(b),req.auth.workspace.id]);res.json(b);});
financeRouter.get('/summary',async(req,res)=>res.json(await tx(req,async c=>{
  const timezone=req.auth.workspace.settings.timezone || 'UTC';
  return (await c.query(`SELECT data->>'currency' AS currency,
    coalesce(sum((data->>'balance_minor')::numeric) FILTER(WHERE object_key='invoices' AND data->>'status' IN ('Issued','Partially paid')),0)::text AS outstanding,
    coalesce(sum((data->>'paid_minor')::numeric) FILTER(WHERE object_key='invoices' AND data->>'status'<>'Void'),0)::text AS collected,
    coalesce(sum((data->>'balance_minor')::numeric) FILTER(WHERE object_key='invoices' AND data->>'status' IN ('Issued','Partially paid') AND data->>'due_date'<timezone($1,now())::date::text),0)::text AS overdue,
    coalesce(sum((data->>'total_minor')::numeric) FILTER(WHERE object_key='expenses' AND data->>'status'='Paid'),0)::text AS expenses,
    count(*) FILTER(WHERE object_key='expenses' AND data->>'status'='Submitted')::int AS approvals
    FROM records WHERE object_key IN ('invoices','expenses') GROUP BY 1 ORDER BY 1`,[timezone])).rows;
})));
financeRouter.post('/templates/:name',requireWrite,async(req,res)=>{
  const step=(id,kind,label,values={})=>({id,type:'workflow',position:{x:100+(['start','task'].indexOf(id))*340,y:160},data:{kind,label,...values}});
  const templates={
    'won-deal':{name:'Create an invoice when a deal is won',description:'Creates a draft for review; no invoice is issued automatically.',nodes:[step('start','trigger.event','Deal won',{event:'crm.deals.won'}),step('task','finance.create','Create draft invoice',{object:'invoices',values:{name:'{{record.data.name}}',customer_name:'{{record.data.company}}',contact_id:'{{record.data.person_id}}',deal_id:'{{record.id}}',currency:'{{record.data.currency}}',issue_date:'{{today}}',due_date:'{{dueIn30Days}}',items:[{description:'{{record.data.name}}',quantity:'1',unit_price:'{{record.data.value}}',tax_rate:'0'}]}})]},
    'expense-approval':{name:'Request an expense review',description:'Creates a linked review task when an expense is submitted.',nodes:[step('start','trigger.event','Expense submitted',{event:'finance.expense.submitted'}),step('task','crm.create','Create approval task',{object:'tasks',values:{name:'Review expense: {{record.data.name}}',status:'To do',priority:'High',record_id:'{{record.id}}'}})]},
    'invoice-paid':{name:'Follow up on a paid invoice',description:'Creates a task to confirm payment with the customer.',nodes:[step('start','trigger.event','Invoice paid',{event:'finance.invoice.paid'}),step('task','crm.create','Create confirmation task',{object:'tasks',values:{name:'Confirm payment: {{record.data.customer_name}}',status:'To do',record_id:'{{record.id}}'}})]},
  };
  const t=templates[req.params.name];if(!t)throw new AppError(404,'Template not found.');
  const draft={nodes:t.nodes,edges:[{id:'e1',source:'start',target:'task'}]};
  const w=await tx(req,async c=>(await c.query('INSERT INTO workflows(tenant_id,id,name,description,draft) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.auth.workspace.id,randomUUID(),t.name,t.description,draft])).rows[0]);res.status(201).json(w);
});
financeRouter.post('/:key',requireWrite,async(req,res)=>res.status(201).json(await tx(req,c=>financeDraft(c,req.auth.workspace.id,req.auth.user.id,req.params.key,req.body.data))));
financeRouter.put('/:key/:id',requireWrite,async(req,res)=>{const b=z.object({data:z.record(z.string(),z.unknown()),version:z.number().int().positive()}).parse(req.body);res.json(await tx(req,c=>financeDraft(c,req.auth.workspace.id,req.auth.user.id,req.params.key,b.data,req.params.id,b.version)));});
financeRouter.get('/:key/:id/entries',async(req,res)=>res.json(await tx(req,async c=>{await getFinance(c,req.params.key,req.params.id);return (await c.query('SELECT e.*,u.name AS actor_name FROM finance_entries e LEFT JOIN users u ON u.id=e.actor_id WHERE record_id=$1 ORDER BY created_at DESC',[req.params.id])).rows;})));
financeRouter.post('/:key/:id/action',requireWrite,async(req,res)=>{
  const b=z.object({action:z.enum(['issue','void','submit','approve','reject','reopen','cancel']),version:z.number().int().positive(),note:z.string().trim().max(2000).default('')}).parse(req.body);
  if(['approve','reject','void'].includes(b.action) && !['owner','admin'].includes(req.auth.role))throw new AppError(403,'An administrator must perform this action.');
  res.json(await tx(req,async c=>{
    const r=await getFinance(c,req.params.key,req.params.id),data={...r.data};
    if(r.version!==b.version)throw new AppError(409,'This record changed. Refresh before continuing.');
    if(r.object_key==='invoices' && b.action==='issue' && data.status==='Draft'){
      if(!data.total_minor)throw new AppError(400,'An invoice must have a positive total.');
      const year=Number(data.issue_date.slice(0,4));
      const seq=(await c.query("INSERT INTO finance_counters(tenant_id,year,kind,value) VALUES($1,$2,'invoice',1) ON CONFLICT(tenant_id,year,kind) DO UPDATE SET value=finance_counters.value+1 RETURNING value",[req.auth.workspace.id,year])).rows[0].value;
      const issuer=profileSchema.parse(req.auth.workspace.settings.finance || {business_name:req.auth.workspace.name});
      Object.assign(data,{status:'Issued',invoice_number:`${issuer.invoice_prefix}-${year}-${String(seq).padStart(5,'0')}`,issuer,issued_at:new Date().toISOString()});
    }else if(r.object_key==='invoices' && b.action==='void' && ['Draft','Issued'].includes(data.status) && !data.paid_minor){
      if(!b.note)throw new AppError(400,'Enter a reason for voiding this invoice.');Object.assign(data,{status:'Void',void_reason:b.note,balance_minor:0,balance:0});
    }else if(r.object_key==='purchase_orders' && b.action==='issue' && data.status==='Draft'){
      if(!data.total_minor)throw new AppError(400,'A purchase order must have a positive total.');
      const year=Number(data.order_date.slice(0,4));
      const seq=(await c.query("INSERT INTO finance_counters(tenant_id,year,kind,value) VALUES($1,$2,'purchase_order',1) ON CONFLICT(tenant_id,year,kind) DO UPDATE SET value=finance_counters.value+1 RETURNING value",[req.auth.workspace.id,year])).rows[0].value;
      const issuer=profileSchema.parse(req.auth.workspace.settings.finance || {business_name:req.auth.workspace.name});
      Object.assign(data,{status:'Issued',po_number:`${issuer.purchase_order_prefix}-${year}-${String(seq).padStart(5,'0')}`,issuer,issued_at:new Date().toISOString()});
    }else if(r.object_key==='purchase_orders' && b.action==='cancel' && ['Draft','Issued'].includes(data.status)){
      if(data.status==='Issued' && !['owner','admin'].includes(req.auth.role))throw new AppError(403,'An administrator must cancel an issued purchase order.');
      if(!b.note)throw new AppError(400,'Enter a reason for cancelling this purchase order.');
      Object.assign(data,{status:'Cancelled',cancel_reason:b.note,cancelled_at:new Date().toISOString()});
    }else if(r.object_key==='expenses'){
      const transitions={submit:['Draft','Submitted'],approve:['Submitted','Approved'],reject:['Submitted','Rejected'],reopen:['Rejected','Draft']},t=transitions[b.action];
      if(!t || data.status!==t[0])throw new AppError(409,'This action is not available for the current expense status.');
      if(b.action==='reject' && !b.note)throw new AppError(400,'Enter a reason for rejecting this expense.');
      data.status=t[1];if(b.action==='submit')data.submitted_by=req.auth.user.id;if(['approve','reject'].includes(b.action)){data.approved_by=req.auth.user.id;data.decision_note=b.note;}
    }else throw new AppError(409,'This action is not available for the current invoice status.');
    return change(c,req.auth.workspace.id,req.auth.user.id,r,data,{issue:'issued',void:'voided',submit:'submitted',approve:'approved',reject:'rejected',reopen:'reopened',cancel:'cancelled'}[b.action]);
  }));
});
financeRouter.post('/:key/:id/payments',requireWrite,async(req,res)=>{
  const b=z.object({id:z.string().uuid(),version:z.number().int().positive(),amount:z.union([z.string(),z.number()]),paid_on:date,method:z.enum(['Bank transfer','Cash','Card','Other']),reference:z.string().trim().min(1).max(200)}).parse(req.body);
  if(req.params.key==='expenses' && !['owner','admin'].includes(req.auth.role))throw new AppError(403,'An administrator must record an expense payment.');
  res.json(await tx(req,async c=>{
    const r=await getFinance(c,req.params.key,req.params.id),data={...r.data},amount=minor(b.amount,data.currency);
    const existing=(await c.query('SELECT * FROM finance_entries WHERE id=$1',[b.id])).rows[0];
    if(existing){if(existing.record_id!==r.id || Number(existing.amount_minor)!==amount || existing.method!==b.method || existing.reference!==b.reference || String(existing.paid_on).slice(0,10)!==b.paid_on)throw new AppError(409,'This payment key was used for a different entry.');return r;}
    if(r.version!==b.version)throw new AppError(409,'This record changed. Refresh before recording payment.');
    if(!amount)throw new AppError(400,'Payment must be greater than zero.');
    if(b.paid_on>new Date().toISOString().slice(0,10))throw new AppError(400,'Record a payment only after it has been received or paid.');
    if(r.object_key==='invoices'){
      if(!['Issued','Partially paid'].includes(data.status) || amount>data.balance_minor)throw new AppError(409,'Payment exceeds the balance or this invoice cannot receive payments.');
      data.paid_minor+=amount;data.balance_minor-=amount;data.balance=data.balance_minor/10**currencyDigits(data.currency);data.status=data.balance_minor?'Partially paid':'Paid';
    }else if(r.object_key==='expenses'){
      if(data.status!=='Approved' || amount!==data.total_minor)throw new AppError(409,'Only approved expenses can be paid, for their full amount.');data.status='Paid';
    }else throw new AppError(400,'Choose a financial record.');
    await c.query('INSERT INTO finance_entries(tenant_id,id,record_id,kind,amount_minor,currency,paid_on,method,reference,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[req.auth.workspace.id,b.id,r.id,r.object_key==='invoices'?'invoice_payment':'expense_payment',amount,data.currency,b.paid_on,b.method,b.reference,req.auth.user.id]);
    return change(c,req.auth.workspace.id,req.auth.user.id,r,data,r.object_key==='invoices'?(data.status==='Paid'?'paid':'payment_recorded'):'paid');
  }));
});

export function invoicePdf(data,profile){
  const doc=new PDFDocument({size:'A4',margins:{top:44,left:44,right:44,bottom:90},bufferPages:true,info:{Title:`Invoice ${data.invoice_number || 'Draft'}`,Author:profile.business_name}});
  const chunks=[];const output=new Promise((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const template=invoiceTemplateSchema.parse(data.document_template || {});
  const currency=data.currency,digits=currencyDigits(currency),format=n=>`${currency} ${(Number(n)/10**digits).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits})}`;
  const write=(value,x,y,width=507,size=10,bold=false,align='left')=>{doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor('#22252a').text(String(value || ''),x,y,{width,align,lineGap:3});return doc.y;};
  doc.image(path.resolve('public/logo.png'),420,44,{width:130});
  let y=write(profile.business_name,44,45,350,20,true)+12;
  y=write([profile.address,profile.email,profile.tax_id?`Tax ID: ${profile.tax_id}`:''].filter(Boolean).join('\n'),44,y,340)+20;
  y=write(`${data.status==='Draft'?'DRAFT ':data.status==='Void'?'VOID ':''}${template.title}`,44,y,300,24,true)+8;
  y=write(data.invoice_number || 'Draft - no number assigned',44,y,350,11)+24;
  let start=y;
  write(template.bill_to_label,44,y,270,9,true);y=write(data.customer_name,44,y+18,270,12,true)+5;
  y=write([data.billing_address,data.customer_email].filter(Boolean).join('\n'),44,y,270);
  const right=write(`Invoice date: ${data.issue_date}\nDue date: ${data.due_date}\nStatus: ${data.status}`,340,start+18,210,10);
  y=Math.max(y,right)+24;doc.moveTo(44,y-12).lineTo(551,y-12).strokeColor(template.accent).stroke();
  function tableHeader(){doc.rect(44,y,507,27).fill('#f0f1f3');write('DESCRIPTION',52,y+8,240,9,true);write('QTY',296,y+8,46,9,true,'right');write('UNIT PRICE',348,y+8,85,9,true,'right');write('TOTAL',442,y+8,101,9,true,'right');y+=35;}
  const nextPage=()=>{doc.addPage();y=44;write(data.invoice_number || 'Draft invoice',44,y,507,12,true);y+=28;};
  if(y>560)nextPage();tableHeader();
  for(const line of data.items){
    const detail=`${line.description}${Number(line.discount)?`\nDiscount: ${line.discount}`:''}${Number(line.tax_rate)?`\nTax: ${line.tax_rate}%`:''}`;
    doc.font('Helvetica').fontSize(10);const height=Math.max(32,doc.heightOfString(detail,{width:236,lineGap:3})+15);
    if(y+height>735){nextPage();tableHeader();}
    write(detail,52,y,236);write(line.quantity,296,y,46,10,false,'right');write(`${currency} ${line.unit_price}`,348,y,85,10,false,'right');write(format(line.total_minor),442,y,101,10,false,'right');
    y+=height;doc.moveTo(44,y-7).lineTo(551,y-7).strokeColor('#e5e7eb').stroke();
  }
  if(y+160>735)nextPage();
  for(const [label,value] of [['Subtotal',data.subtotal_minor],['Discount',data.discount_minor],['Tax',data.tax_minor],['Total',data.total_minor],['Paid',data.paid_minor],['Balance due',data.balance_minor]]){write(label,315,y,105,11,label==='Total');write(format(value),415,y,128,11,label==='Total', 'right');y+=23;}
  for(const [label,value] of [[template.payment_label,template.payment_instructions || profile.payment_instructions],[template.notes_label,data.notes],['Void reason',data.void_reason]])if(value){
    doc.font('Helvetica').fontSize(10);const height=doc.heightOfString(value,{width:507,lineGap:3})+35;
    if(y+height>735)nextPage();y=write(label,44,y+15,507,10,true)+6;y=write(value,44,y,507,10)+8;
  }
  const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){doc.switchToPage(i);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0;if(template.footer)write(template.footer,44,755,507,8);write(`Generated with DryKraft  |  Page ${i+1} of ${pages.count}`,44,780,507,8,false,'right');doc.page.margins.bottom=bottom;}
  doc.end();return output;
}
export function purchaseOrderPdf(data,profile){
  const doc=new PDFDocument({size:'A4',margins:{top:44,left:44,right:44,bottom:80},bufferPages:true,info:{Title:`Purchase Order ${data.po_number||'Draft'}`,Author:profile.business_name}});
  const chunks=[];const output=new Promise((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const digits=currencyDigits(data.currency),format=n=>`${data.currency} ${(Number(n||0)/10**digits).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits})}`;
  const write=(value,x,y,width=507,size=10,bold=false,align='left')=>{doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor('#27323e').text(String(value||''),x,y,{width,align,lineGap:3});return doc.y;};
  doc.image(path.resolve('public/logo.png'),420,44,{width:130});
  let y=write(profile.business_name,44,45,350,20,true)+12;
  y=write([profile.address,profile.email,profile.tax_id?`Tax ID: ${profile.tax_id}`:''].filter(Boolean).join('\n'),44,y,340)+24;
  y=write(data.status==='Draft'?'PURCHASE ORDER · DRAFT':data.status==='Cancelled'?'PURCHASE ORDER · CANCELLED':'PURCHASE ORDER',44,y,350,22,true)+8;
  y=write(data.po_number||'Draft - no number assigned',44,y,350,12)+8;
  y=write(`Order date: ${data.order_date}\nExpected delivery: ${data.expected_date||'Not specified'}\nStatus: ${data.status}`,44,y,280,10)+18;
  doc.moveTo(44,y).lineTo(551,y).strokeColor('#e5e7eb').stroke();y+=18;
  write('SUPPLIER',44,y,220,9,true);write('ORDERED BY',330,y,220,9,true);y+=16;
  const vendor=write(data.vendor,44,y,240,13,true),issuer=write(profile.business_name,330,y,220,13,true);y=Math.max(vendor,issuer)+6;
  const vendorInfo=write([data.vendor_email,data.vendor_address].filter(Boolean).join('\n'),44,y,240),issuerInfo=write([profile.address,profile.email].filter(Boolean).join('\n'),330,y,220);y=Math.max(vendorInfo,issuerInfo)+22;
  function tableHeader(){doc.rect(44,y,507,27).fill('#f0f1f3');write('ITEM',52,y+8,235,9,true);write('QTY',292,y+8,48,9,true,'right');write('UNIT PRICE',348,y+8,84,9,true,'right');write('TOTAL',442,y+8,101,9,true,'right');y+=35;}
  const nextPage=()=>{doc.addPage();y=44;write(data.po_number||'Purchase order draft',44,y,507,12,true);y+=28;};
  if(y>620)nextPage();tableHeader();
  for(const line of data.items||[]){
    const detail=`${line.description}${Number(line.discount)?`\nDiscount: ${line.discount}`:''}${Number(line.tax_rate)?`\nTax: ${line.tax_rate}%`:''}`;
    doc.font('Helvetica').fontSize(10);const height=Math.max(32,doc.heightOfString(detail,{width:230,lineGap:3})+15);if(y+height>735){nextPage();tableHeader();}
    write(detail,52,y,230);write(line.quantity,292,y,48,10,false,'right');write(`${data.currency} ${line.unit_price}`,348,y,84,10,false,'right');write(format(line.total_minor),442,y,101,10,false,'right');
    y+=height;doc.moveTo(44,y-7).lineTo(551,y-7).strokeColor('#e5e7eb').stroke();
  }
  if(y+130>735)nextPage();
  for(const [label,value] of [['Subtotal',data.subtotal_minor],['Discount',data.discount_minor],['Tax',data.tax_minor],['Order total',data.total_minor]]){write(label,315,y,105,11,label==='Order total');write(format(value),415,y,128,11,label==='Order total','right');y+=23;}
  for(const [label,value] of [['Notes',data.notes],['Cancellation reason',data.cancel_reason]])if(value){doc.font('Helvetica').fontSize(10);const height=doc.heightOfString(value,{width:507,lineGap:3})+35;if(y+height>735)nextPage();y=write(label,44,y+15,507,10,true)+6;y=write(value,44,y,507,10)+8;}
  const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){doc.switchToPage(i);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0;write(`Generated with DryKraft  |  Page ${i+1} of ${pages.count}`,44,780,507,8,false,'right');doc.page.margins.bottom=bottom;}
  doc.end();return output;
}
financeRouter.get('/invoices/:id/pdf',async(req,res)=>{
  const data=await tx(req,async c=>(await getFinance(c,'invoices',req.params.id)).data);
  const profile=data.issuer || req.auth.workspace.settings.finance || {business_name:req.auth.workspace.name};
  const pdf=await invoicePdf(data,profile);res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${data.invoice_number || 'invoice-draft'}.pdf"`,'Cache-Control':'private, no-store'}).send(pdf);
});
financeRouter.get('/purchase-orders/:id/pdf',async(req,res)=>{
  const data=await tx(req,async c=>(await getFinance(c,'purchase_orders',req.params.id)).data);
  const profile=data.issuer||req.auth.workspace.settings.finance||{business_name:req.auth.workspace.name};
  const pdf=await purchaseOrderPdf(data,profile),fileName=data.po_number||`purchase-order-draft-${req.params.id.slice(0,8)}`;
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${fileName}.pdf"`,'Cache-Control':'private, no-store'}).send(pdf);
});
