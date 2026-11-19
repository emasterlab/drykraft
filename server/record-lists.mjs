import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { tenantTransaction,event } from './db.mjs';
import { requireWrite } from './auth.mjs';
import { AppError,getDefinition,keySchema,recordUserNames } from './model.mjs';
import { currencySchema } from './currency.mjs';
import { filterOperators } from '../src/lib/record-filter.mjs';

const conditionSchema=z.object({field:keySchema,operator:z.enum(['eq','ne','contains','not_contains','gt','gte','lt','lte','empty','not_empty']),value:z.union([z.string().max(200),z.number().finite(),z.boolean()]).optional()}).strict();
export const recordFilterSchema=z.object({match:z.enum(['all','any']),conditions:z.array(conditionSchema).min(1).max(12)}).strict();
const listSchema=z.object({name:z.string().trim().min(1).max(80),filter:recordFilterSchema});
const escapeLike=value=>value.replace(/[\\%_]/g,'\\$&');

export function validateFilter(definition,input) {
  const filter=recordFilterSchema.parse(input);
  for(const condition of filter.conditions) {
    const field=definition.fields.find(f=>f.key===condition.field),{operator,value}=condition;
    if(!filterOperators(field).includes(operator))throw new AppError(400,`Choose a supported field and rule for ${field?.name || condition.field}.`);
    if(['empty','not_empty'].includes(operator)){delete condition.value;continue;}
    let valid=typeof value==='string' && value.trim().length>0;
    if(['number','currency'].includes(field.type))valid=typeof value==='number' && Math.abs(value)<1e15;
    if(field.type==='boolean')valid=typeof value==='boolean';
    if(field.type==='date')valid=valid && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
    if(['select','multi_select'].includes(field.type) && field.options?.length)valid=valid && field.options.includes(value);
    if(field.type==='user')valid=valid && z.string().uuid().safeParse(value).success;
    if(field.key==='currency')valid=currencySchema.safeParse(value).success;
    if(!valid)throw new AppError(400,`Enter a valid filter value for ${field.name}.`);
  }
  if(filter.conditions.some(c=>definition.fields.find(f=>f.key===c.field)?.type==='currency' && !['empty','not_empty'].includes(c.operator)) && (filter.match!=='all' || !filter.conditions.some(c=>c.field==='currency' && c.operator==='eq')))
    throw new AppError(400,'Amount filters need Match all and a Currency is rule to keep currencies separate.');
  return filter;
}

export function filterSql(definition,filter,params) {
  const arg=value=>{params.push(value);return `$${params.length}`;};
  const conditions=filter.conditions.map(({field:key,operator,value})=>{
    const field=definition.fields.find(f=>f.key===key),keyArg=arg(key),json=`data->${keyArg}::text`,text=`data->>${keyArg}::text`;
    const empty=`(${json} IS NULL OR ${json} IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb))`;
    if(operator==='empty')return empty;
    if(operator==='not_empty')return `NOT ${empty}`;
    if(['contains','not_contains'].includes(operator)) {
      const clause=field.type==='multi_select'?`coalesce(${json} @> ${arg(JSON.stringify([value]))}::jsonb,false)`:`coalesce(${text},'') ILIKE ${arg(`%${escapeLike(value)}%`)}`;
      return operator==='not_contains'?`NOT (${clause})`:clause;
    }
    let clause;
    if(['number','currency','boolean'].includes(field.type)) {
      const op={eq:'=',ne:'=',gt:'>',gte:'>=',lt:'<',lte:'<='}[operator];
      clause=`coalesce((jsonb_typeof(${json})=${arg(field.type==='boolean'?'boolean':'number')} AND ${json} ${op} ${arg(JSON.stringify(value))}::jsonb),false)`;
    } else {
      const op={eq:'=',ne:'=',gt:'>',gte:'>=',lt:'<',lte:'<='}[operator];
      clause=`coalesce(lower(${text}) ${op} lower(${arg(value)}::text),false)`;
    }
    return operator==='ne'?`NOT (${clause})`:clause;
  });
  return `(${conditions.join(filter.match==='all'?' AND ':' OR ')})`;
}

export async function listRecords(client,key,input) {
  const q=z.object({search:z.string().max(200).default(''),limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().max(500).optional(),status:z.string().max(80).optional(),pipeline:z.string().uuid().optional(),list:z.string().uuid().optional(),filter:z.string().max(10000).optional()}).parse(input);
  const definition=await getDefinition(client,key),params=[key,`%${escapeLike(q.search)}%`];
  const where=[`object_key=$1`,`merged_into IS NULL`,`($2='%%' OR data->>'name' ILIKE $2 OR data->>'email' ILIKE $2 OR data->>'company' ILIKE $2 OR data->>'customer_name' ILIKE $2 OR data->>'vendor' ILIKE $2 OR data->>'invoice_number' ILIKE $2)`];
  if(q.list && q.filter)throw new AppError(400,'Choose a saved list or preview a filter, not both.');
  let filter;
  if(q.list){const saved=(await client.query('SELECT filter FROM record_lists WHERE id=$1 AND object_key=$2',[q.list,key])).rows[0];if(!saved)throw new AppError(404,'This smart list was removed or is not in your workspace.');filter=saved.filter;}
  if(q.filter){try{filter=JSON.parse(q.filter);}catch{throw new AppError(400,'The filter could not be read.');}}
  if(filter)where.push(filterSql(definition,validateFilter(definition,filter),params));
  if(q.status){params.push(q.status);where.push(`data->>'status'=$${params.length}`);}
  if(q.pipeline){if(key!=='deals')throw new AppError(400,'Pipeline filtering is available for deals.');params.push(q.pipeline);where.push(`data->>'pipeline_id'=$${params.length}`);}
  const total=(await client.query(`SELECT count(*)::int AS count FROM records WHERE ${where.join(' AND ')}`,params)).rows[0].count;
  if(q.cursor){let cursor;try{cursor=JSON.parse(Buffer.from(q.cursor,'base64url').toString());}catch{throw new AppError(400,'Invalid page cursor.');}z.object({created_at:z.string().datetime(),id:z.string().uuid()}).parse(cursor);params.push(cursor.created_at,cursor.id);where.push(`(created_at,id)<($${params.length-1}::timestamptz,$${params.length}::uuid)`);}
  params.push(q.limit+1);
  // ponytail: JSON field filters scan the selected object; add expression indexes for heavily used fields after measuring query plans.
  const rows=(await client.query(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM records WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,params)).rows;
  const items=rows.slice(0,q.limit),last=items.at(-1);
  return {items:await recordUserNames(client,definition,items.map(({cursor_time,...item})=>item)),total,next_cursor:rows.length>q.limit?Buffer.from(JSON.stringify({created_at:last.cursor_time,id:last.id})).toString('base64url'):null};
}

export const recordListsRouter=express.Router();
const tx=(req,fn)=>tenantTransaction(req.auth.workspace.id,fn);
async function listDefinition(client,key) {
  const definition=await getDefinition(client,key);
  if(['invoices','purchase_orders','expenses'].includes(key))throw new AppError(400,'Use the Finance views for financial records.');
  return definition;
}
recordListsRouter.get('/:key',async(req,res)=>res.json(await tx(req,async c=>{await listDefinition(c,req.params.key);return (await c.query('SELECT * FROM record_lists WHERE object_key=$1 ORDER BY lower(name),id',[req.params.key])).rows;})));
recordListsRouter.post('/:key',requireWrite,async(req,res)=>{
  const b=listSchema.parse(req.body);
  res.status(201).json(await tx(req,async c=>{
    await c.query('SELECT key FROM object_definitions WHERE key=$1 FOR UPDATE',[req.params.key]);
    const d=await listDefinition(c,req.params.key),filter=validateFilter(d,b.filter);
    if((await c.query('SELECT count(*)::int AS count FROM record_lists WHERE object_key=$1',[d.key])).rows[0].count>=100)throw new AppError(400,'This object has 100 smart lists. Remove an unused list before adding another.');
    const item=(await c.query('INSERT INTO record_lists(tenant_id,id,object_key,name,filter,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.auth.workspace.id,randomUUID(),d.key,b.name,filter,req.auth.user.id])).rows[0];
    await event(c,req.auth.workspace.id,req.auth.user.id,'crm.list.created','record_list',item.id,{list:item});return item;
  }));
});
recordListsRouter.put('/:key/:id',requireWrite,async(req,res)=>{
  const b=listSchema.extend({version:z.number().int().positive()}).parse(req.body),id=z.string().uuid().parse(req.params.id);
  res.json(await tx(req,async c=>{
    const d=await listDefinition(c,req.params.key),filter=validateFilter(d,b.filter);
    const item=(await c.query('UPDATE record_lists SET name=$1,filter=$2,version=version+1,updated_at=now() WHERE id=$3 AND object_key=$4 AND version=$5 RETURNING *',[b.name,filter,id,d.key,b.version])).rows[0];
    if(!item)throw new AppError(409,'This smart list changed or was removed. Close the editor and refresh before saving.');
    await event(c,req.auth.workspace.id,req.auth.user.id,'crm.list.updated','record_list',id,{list:item});return item;
  }));
});
recordListsRouter.delete('/:key/:id',requireWrite,async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id),version=z.coerce.number().int().positive().parse(req.query.version);
  await tx(req,async c=>{
    await listDefinition(c,req.params.key);
    const item=(await c.query('DELETE FROM record_lists WHERE id=$1 AND object_key=$2 AND version=$3 RETURNING *',[id,req.params.key,version])).rows[0];
    if(!item)throw new AppError(409,'This smart list changed or was removed. Refresh before trying again.');
    await event(c,req.auth.workspace.id,req.auth.user.id,'crm.list.deleted','record_list',id,{list:item});
  });res.json({ok:true});
});
