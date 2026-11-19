import { Router } from 'express';
import { z } from 'zod';
import { randomUUID,randomBytes,createHmac } from 'node:crypto';
import { tenantTransaction,event } from './db.mjs';
import { AppError } from './model.mjs';
import { requireAdmin,tokenHash } from './auth.mjs';
import { developerTransaction } from './developer-access.mjs';
import { billingAccess,requireBillingAccess } from './billing.mjs';
import { encryptCredential,decryptCredential } from './automation.mjs';
import { publicAddress,safeHttp } from './http-node.mjs';

const uuid=z.string().uuid(),version=z.number().int().positive(),password=z.string().min(10).max(128);
const settings=z.object({name:z.string().trim().min(2).max(100),url:z.string().max(2048),events:z.array(z.string().max(120)).min(1).max(100)}).strict();
const specialEvents=[...['created','updated','rescheduled','cancelled','completed','no_show','reminder_due'].map(v=>'calendar.appointment.'+v),'crm.people.merged','crm.people.tags_changed','crm.relationship.changed','crm.assignment.changed','crm.activity.created','crm.deals.won','crm.deals.stage_changed',
 ...['created','updated','issued','voided','paid','payment_recorded'].map(v=>'finance.invoice.'+v),
 ...['created','updated','submitted','approved','rejected','reopened','paid'].map(v=>'finance.expense.'+v),
 ...['joined','role_changed','removed'].map(v=>'workspace.member.'+v),
 ...['created','revoked'].map(v=>'workspace.invitation.'+v),
 ...['created','launched','active','paused','cancelled'].map(v=>'outreach.campaign.'+v),
 'outreach.message.accepted','outreach.whatsapp.received','billing.subscription.updated','billing.enterprise.requested'];
export async function webhookEventTypes(c){
 const objects=(await c.query("SELECT key FROM object_definitions WHERE key NOT IN ('invoices','purchase_orders','expenses') ORDER BY key")).rows;
 return [...new Set([...objects.flatMap(o=>['created','updated','deleted'].map(v=>`crm.${o.key}.${v}`)),...specialEvents])].sort();
}
export function webhookUrl(value){
 let u;try{u=new URL(value);}catch{throw new AppError(400,'Enter a public HTTPS webhook URL.');}
 if(u.protocol!=='https:' || u.username || u.password || u.hash || u.search || u.port && u.port!=='443')throw new AppError(400,'Webhooks require HTTPS on port 443, without credentials, query parameters or fragments.');
 return u.href;
}
async function validateSettings(c,b,checkAddress=true){
 const url=webhookUrl(b.url);if(checkAddress)await publicAddress(new URL(url).hostname);
 const available=new Set(await webhookEventTypes(c));
 if(new Set(b.events).size!==b.events.length || b.events.some(t=>!available.has(t)))throw new AppError(400,'Choose each supported event once. Refresh the event catalogue if an object changed.');
 return {...b,url,events:[...b.events].sort()};
}
const endpointPublic=w=>({id:w.id,name:w.name,url:w.url,events:w.events,enabled:w.enabled,version:w.version,secret_version:w.secret_version,disabled_reason:w.disabled_reason,created_at:w.created_at,updated_at:w.updated_at});
const deliveryPublic=d=>({id:d.id,endpoint_id:d.endpoint_id,event_id:d.event_id,event_type:d.event_type,state:d.state,attempts:d.attempts,cycle_attempts:d.cycle_attempts,version:d.version,next_attempt_at:d.next_attempt_at,last_status:d.last_status,last_error:d.last_error,created_at:d.created_at,completed_at:d.completed_at});
async function endpoint(c,id,expected=null){
 const w=(await c.query('SELECT * FROM customer_webhooks WHERE id=$1 FOR UPDATE',[uuid.parse(id)])).rows[0];
 if(!w)throw new AppError(404,'Webhook not found in this workspace.');
 if(expected!==null && w.version!==expected)throw new AppError(409,'This webhook changed. Refresh before trying again.');return w;
}
async function page(c,table,cursor,endpointId=null){
 const after=cursor?(await c.query(`SELECT created_at::text AS time FROM ${table} WHERE id=$1 ${endpointId?'AND endpoint_id=$2':''}`,[uuid.parse(cursor),...(endpointId?[endpointId]:[])])).rows[0]?.time:null;
 if(cursor&&!after)throw new AppError(400,'This page changed. Refresh the list.');
 const rows=(await c.query(`SELECT * FROM ${table} WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1,$2::uuid)) ${endpointId?'AND endpoint_id=$3':''} ORDER BY created_at DESC,id DESC LIMIT 26`,[after,cursor||null,...(endpointId?[endpointId]:[])])).rows;
 return {items:rows.slice(0,25).map(endpointId?deliveryPublic:endpointPublic),next_cursor:rows.length>25?rows[24].id:null};
}
const freshSecret=()=>'dkwh_'+randomBytes(32).toString('base64url');
const operationHash=(kind,endpointId,b)=>tokenHash(JSON.stringify([kind,endpointId,b]));
async function previousOperation(c,id,hash){
 const row=(await c.query('SELECT * FROM customer_webhook_operations WHERE id=$1',[id])).rows[0];
 if(row&&row.payload_hash!==hash)throw new AppError(409,'This operation reference was used for different settings.');return row;
}
export const customerWebhookRouter=Router();
customerWebhookRouter.use(requireAdmin,(req,res,next)=>{res.set('Cache-Control','no-store');next();});
customerWebhookRouter.get('/events',async(req,res)=>res.json(await developerTransaction(req,async c=>({events:await webhookEventTypes(c)}))));
customerWebhookRouter.get('/',async(req,res)=>res.json(await developerTransaction(req,c=>page(c,'customer_webhooks',req.query.cursor))));
customerWebhookRouter.post('/',async(req,res)=>{
 const b=settings.extend({id:uuid,password}).parse(req.body);
 const result=await developerTransaction(req,async(c,approve)=>{
  await approve(b.password);await requireBillingAccess(c,req.auth.workspace.id);
  const normalized=await validateSettings(c,{name:b.name,url:b.url,events:b.events}),hash=tokenHash(JSON.stringify(normalized));
  const prior=(await c.query('SELECT * FROM customer_webhooks WHERE id=$1',[b.id])).rows[0];
  if(prior){if(prior.create_hash!==hash)throw new AppError(409,'This webhook reference was used for different settings.');return {webhook:endpointPublic(prior),secret:null};}
  if((await c.query('SELECT count(*)::int AS n FROM customer_webhooks')).rows[0].n>=50)throw new AppError(400,'This workspace has reached its limit of 50 webhooks.');
  const secret=freshSecret(),w=(await c.query('INSERT INTO customer_webhooks(tenant_id,id,name,url,events,ciphertext,create_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[req.auth.workspace.id,b.id,normalized.name,normalized.url,normalized.events,encryptCredential(req.auth.workspace.id,{value:secret}),hash,req.auth.user.id])).rows[0];
  await event(c,req.auth.workspace.id,req.auth.user.id,'developer.webhook.created','customer_webhook',w.id,{id:w.id});
  return {webhook:endpointPublic(w),secret};
 });res.status(result.secret?201:200).json(result);
});
customerWebhookRouter.put('/:id',async(req,res)=>{
 const b=settings.extend({version,enabled:z.boolean(),password:password.optional()}).parse(req.body);
 res.json(await developerTransaction(req,async(c,approve)=>{
  const w=await endpoint(c,req.params.id,b.version),normalized=await validateSettings(c,{name:b.name,url:b.url,events:b.events},b.enabled||webhookUrl(b.url)!==w.url);
  if(normalized.url!==w.url || b.enabled&&!w.enabled || normalized.events.some(t=>!w.events.includes(t)))await approve(b.password);
  if(b.enabled)await requireBillingAccess(c,req.auth.workspace.id);
  const saved=(await c.query("UPDATE customer_webhooks SET name=$1,url=$2,events=$3,enabled=$4,disabled_reason=CASE WHEN $4 THEN NULL ELSE 'Disabled by administrator.' END,version=version+1,updated_at=now() WHERE id=$5 RETURNING *",[normalized.name,normalized.url,normalized.events,b.enabled,w.id])).rows[0];
  await c.query("UPDATE customer_webhook_deliveries SET state='cancelled',last_error='Webhook disabled, destination changed or event subscription removed.',completed_at=now(),version=version+1 WHERE endpoint_id=$1 AND state IN ('queued','retrying') AND ($2=false OR destination<>$3 OR NOT(event_type=ANY($4::text[])))",[w.id,b.enabled,saved.url,saved.events]);
  await event(c,req.auth.workspace.id,req.auth.user.id,'developer.webhook.updated','customer_webhook',w.id,{id:w.id,enabled:saved.enabled});return endpointPublic(saved);
 }));
});
customerWebhookRouter.post('/:id/rotate',async(req,res)=>{
 const b=z.object({id:uuid,version,password}).strict().parse(req.body),id=uuid.parse(req.params.id),hash=operationHash('rotate',id,{id:b.id,version:b.version});
 const result=await developerTransaction(req,async(c,approve)=>{
  await approve(b.password);await requireBillingAccess(c,req.auth.workspace.id);
  const w=await endpoint(c,id),previous=await previousOperation(c,b.id,hash);if(previous)return {webhook:previous.result,secret:null};
  if(w.version!==b.version)throw new AppError(409,'This webhook changed. Refresh before rotating its secret.');
  const secret=freshSecret(),updated=(await c.query('UPDATE customer_webhooks SET ciphertext=$1,secret_version=secret_version+1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *',[encryptCredential(req.auth.workspace.id,{value:secret}),w.id])).rows[0],result=endpointPublic(updated);
  await c.query("INSERT INTO customer_webhook_operations(tenant_id,id,endpoint_id,payload_hash,kind,result,actor_id) VALUES($1,$2,$3,$4,'rotate',$5,$6)",[req.auth.workspace.id,b.id,w.id,hash,result,req.auth.user.id]);
  await event(c,req.auth.workspace.id,req.auth.user.id,'developer.webhook.rotated','customer_webhook',w.id,{id:w.id,secret_version:updated.secret_version});return {webhook:result,secret};
 });res.status(result.secret?201:200).json(result);
});
customerWebhookRouter.get('/:id/deliveries',async(req,res)=>res.json(await developerTransaction(req,async c=>{const w=await endpoint(c,req.params.id);return {webhook:endpointPublic(w),...await page(c,'customer_webhook_deliveries',req.query.cursor,w.id)};})));
customerWebhookRouter.get('/:id/deliveries/:deliveryId',async(req,res)=>res.json(await developerTransaction(req,async c=>{
 const w=await endpoint(c,req.params.id),d=(await c.query('SELECT * FROM customer_webhook_deliveries WHERE endpoint_id=$1 AND id=$2',[w.id,uuid.parse(req.params.deliveryId)])).rows[0];
 if(!d)throw new AppError(404,'Delivery not found in this workspace.');
 return {...deliveryPublic(d),payload:JSON.parse(d.body),attempt_history:(await c.query('SELECT id,attempt,secret_version,status,error,started_at,completed_at FROM customer_webhook_attempts WHERE delivery_id=$1 ORDER BY attempt DESC LIMIT 50',[d.id])).rows};
})));
customerWebhookRouter.post('/:id/deliveries/:deliveryId/replay',async(req,res)=>{
 const b=z.object({id:uuid,version,acknowledge_duplicate:z.literal(true)}).strict().parse(req.body),id=uuid.parse(req.params.id),deliveryId=uuid.parse(req.params.deliveryId),hash=operationHash('replay',id,{...b,deliveryId});
 res.json(await developerTransaction(req,async c=>{
  await requireBillingAccess(c,req.auth.workspace.id);const w=await endpoint(c,id),previous=await previousOperation(c,b.id,hash);if(previous)return previous.result;
  const d=(await c.query('SELECT * FROM customer_webhook_deliveries WHERE endpoint_id=$1 AND id=$2 FOR UPDATE',[w.id,deliveryId])).rows[0];
  if(!d)throw new AppError(404,'Delivery not found in this workspace.');
  if(!w.enabled || w.url!==d.destination || !w.events.includes(d.event_type))throw new AppError(409,'Restore this delivery’s original destination and event subscription before replaying.');
  if(d.state!=='failed' || d.version!==b.version)throw new AppError(409,'Only a current failed delivery can be replayed. Refresh its history.');
  const updated=(await c.query("UPDATE customer_webhook_deliveries SET state='queued',cycle_attempts=0,next_attempt_at=now(),completed_at=NULL,last_error=NULL,last_status=NULL,version=version+1 WHERE id=$1 RETURNING *",[d.id])).rows[0],result=deliveryPublic(updated);
  await c.query("INSERT INTO customer_webhook_operations(tenant_id,id,endpoint_id,payload_hash,kind,result,actor_id) VALUES($1,$2,$3,$4,'replay',$5,$6)",[req.auth.workspace.id,b.id,w.id,hash,result,req.auth.user.id]);
  await event(c,req.auth.workspace.id,req.auth.user.id,'developer.webhook.replayed','customer_webhook',w.id,{id:w.id,delivery_id:d.id});return result;
 }));
});

export function webhookHeaders(secret,deliveryId,body,now=Date.now()){
 const timestamp=String(Math.floor(now/1000)),signature=createHmac('sha256',secret).update(`${deliveryId}.${timestamp}.`).update(body).digest('hex');
 return {'content-type':'application/json','drykraft-webhook-id':deliveryId,'drykraft-webhook-timestamp':timestamp,'drykraft-webhook-signature':'v1='+signature,'idempotency-key':deliveryId};
}
const retrySeconds=[60,300,1800,7200];
// At-least-once: a process can stop after recipient acceptance but before commit. Receivers must deduplicate the delivery ID.
export async function deliverCustomerWebhook(tenantId,id,send=safeHttp){
 return tenantTransaction(tenantId,async c=>{
  await c.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[tenantId]);
  const reference=(await c.query('SELECT endpoint_id FROM customer_webhook_deliveries WHERE id=$1',[id])).rows[0];if(!reference)return null;
  const w=(await c.query('SELECT * FROM customer_webhooks WHERE id=$1 FOR UPDATE SKIP LOCKED',[reference.endpoint_id])).rows[0];if(!w)return null;
  const d=(await c.query("SELECT * FROM customer_webhook_deliveries WHERE id=$1 AND state IN ('queued','retrying') AND next_attempt_at<=now() FOR UPDATE SKIP LOCKED",[id])).rows[0];if(!d)return null;
  if(!w.enabled || w.url!==d.destination || !w.events.includes(d.event_type)){
   await c.query("UPDATE customer_webhook_deliveries SET state='cancelled',last_error='Webhook configuration no longer permits this delivery.',completed_at=now(),version=version+1 WHERE id=$1",[id]);return {state:'cancelled'};
  }
  if(!(await billingAccess(c,tenantId)).access){await c.query("UPDATE customer_webhook_deliveries SET next_attempt_at=now()+interval '15 minutes',version=version+1 WHERE id=$1",[id]);return {state:d.state,deferred:true};}
  const started=new Date(),attempt=d.attempts+1,cycle=d.cycle_attempts+1;
  let status=null,error=null;
  try{
   const url=webhookUrl(d.destination),secret=decryptCredential(tenantId,w.ciphertext).value;
   const response=await send(url,{method:'POST',headers:webhookHeaders(secret,d.id,d.body),body:d.body});status=response.status;
   if(!Number.isInteger(status) || status<200 || status>599){status=null;error='Webhook response was invalid.';}
   else if(status<200 || status>=300)error=`Recipient returned HTTP ${status}.`;
  }catch(e){
   // Do not save provider responses, network URLs, signing headers, or arbitrary exception text.
   const match=/^The provider returned HTTP (\d{3})\.$/.exec(e.message);status=match?Number(match[1]):null;
   error=status?`Recipient returned HTTP ${status}.`:'Webhook request failed or its acceptance could not be confirmed.';
  }
  const state=!error?'succeeded':cycle>=5?'failed':'retrying';
  await c.query('INSERT INTO customer_webhook_attempts(tenant_id,id,delivery_id,attempt,secret_version,status,error,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[tenantId,randomUUID(),d.id,attempt,w.secret_version,status,error,started]);
  await c.query("UPDATE customer_webhook_deliveries SET state=$1,attempts=$2,cycle_attempts=$3,last_status=$4,last_error=$5,next_attempt_at=clock_timestamp()+$6*interval '1 second',completed_at=CASE WHEN $1 IN ('succeeded','failed') THEN clock_timestamp() ELSE NULL END,version=version+1 WHERE id=$7",[state,attempt,cycle,status,error,retrySeconds[cycle-1]||0,d.id]);
  if(state==='failed'){
   await c.query("UPDATE customer_webhooks SET enabled=false,disabled_reason='Disabled after five failed attempts for one delivery.',version=version+1,updated_at=now() WHERE id=$1",[w.id]);
   await c.query("UPDATE customer_webhook_deliveries SET state='cancelled',last_error='Webhook disabled after persistent delivery failure.',completed_at=now(),version=version+1 WHERE endpoint_id=$1 AND state IN ('queued','retrying')",[w.id]);
   await event(c,tenantId,null,'developer.webhook.disabled','customer_webhook',w.id,{id:w.id,delivery_id:d.id});
  }
  return {state,status,attempt};
 });
}
export async function pollCustomerWebhooks(discovery,stopping=()=>false){
 // ponytail: one serial batch per process; use a dedicated bounded worker pool when webhook volume warrants it.
 const due=(await discovery.query("SELECT tenant_id,id FROM customer_webhook_deliveries WHERE state IN ('queued','retrying') AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT 25")).rows;
 for(const row of due){if(stopping())break;await deliverCustomerWebhook(row.tenant_id,row.id);}
}
