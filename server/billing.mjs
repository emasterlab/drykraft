import { Router } from 'express';
import { createHmac,timingSafeEqual,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tenantTransaction,event } from './db.mjs';
import { AppError } from './model.mjs';
import {workspaceEntitlements} from './entitlements.mjs';
import {billingInterval,billingProduct,configuredProductInterval,validateBillingProduct} from './billing-products.mjs';

export const unitPrice=100,trialDays=15;
const uuid=z.string().uuid(),providerId=z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/),seats=z.number().int().min(1).max(10000);
const states=z.enum(['pending','active','on_hold','paused','cancelled','failed','expired','past_due']);
export function verifyDodoWebhook(body,headers,key=process.env.DODO_WEBHOOK_KEY,now=Date.now()) {
  const id=headers['webhook-id'],timestamp=headers['webhook-timestamp'],signature=headers['webhook-signature'];
  if(!key)throw new AppError(503,'Subscription updates are not configured.');
  if(!Buffer.isBuffer(body) || typeof id!=='string' || !id || id.length>200 || typeof timestamp!=='string' || !/^\d{1,12}$/.test(timestamp) || Math.abs(now/1000-Number(timestamp))>300 || typeof signature!=='string')throw new AppError(401,'Invalid webhook signature.');
  const secret=Buffer.from(key.replace(/^whsec_/,''),'base64');
  const expected=createHmac('sha256',secret).update(`${id}.${timestamp}.`).update(body).digest();
  const valid=signature.split(' ').some(s=>{const [v,value]=s.split(',');if(v!=='v1' || !value)return false;const supplied=Buffer.from(value,'base64');return supplied.length===expected.length && timingSafeEqual(supplied,expected);});
  if(!valid)throw new AppError(401,'Invalid webhook signature.');
  return id;
}
export async function dodoRequest(path,body,method=body?'POST':'GET') {
  if(!process.env.DODO_API_KEY || !['live_mode','test_mode'].includes(process.env.DODO_ENVIRONMENT))throw new AppError(503,'Billing is unavailable. Please try again later.');
  const origin=process.env.DODO_ENVIRONMENT==='live_mode'?'https://live.dodopayments.com':'https://test.dodopayments.com';
  let response;
  try {response=await fetch(origin+path,{method,headers:{Authorization:`Bearer ${process.env.DODO_API_KEY}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}
  catch {throw new AppError(503,'Dodo Payments could not be reached. Refresh billing and try again.');}
  if(!response.ok)throw new AppError(502,'Dodo Payments could not complete this request. Refresh billing before trying again.');
  return response.json();
}
export function providerLink(value) {
  const url=new URL(value);
  if(url.protocol!=='https:' || !(url.hostname==='dodopayments.com' || url.hostname.endsWith('.dodopayments.com')) || url.username || url.password)throw new AppError(502,'Dodo Payments returned an invalid link.');
  return url.href;
}
export async function billingAccess(c,tenantId,feature=null) {
  const suspended=(await c.query('SELECT platform_workspace_suspended($1) AS suspended',[tenantId])).rows[0].suspended;
  const row=(await c.query(`SELECT b.*,w.settings->>'demo'='true' AS demo,(SELECT count(*)::int FROM memberships WHERE tenant_id=$1) AS members FROM workspace_billing b JOIN workspaces w ON w.id=b.tenant_id WHERE b.tenant_id=$1`,[tenantId])).rows[0];
  if(!row)throw new AppError(503,'Workspace billing is unavailable.');
  const entitlements=await workspaceEntitlements(c,tenantId);
  const capability_enabled=feature===null || entitlements.features[feature]===true;
  const agreement=entitlements.agreement_active && entitlements.agreement_seats>=row.members;
  const trial=new Date(row.trial_ends_at).getTime()>Date.now();
  const grace=row.status==='past_due' && new Date(row.past_due_ends_at).getTime()>Date.now();
  const paid=(row.status==='active' && new Date(row.next_billing_date).getTime()>Date.now() || grace) && row.seats>=row.members;
  return {...row,entitlements,agreement,capability_enabled,access:!suspended && capability_enabled && (!!row.demo || trial || paid || agreement),trial,grace,suspended};
}
export async function requireBillingAccess(c,tenantId,feature=null) {
  const state=await billingAccess(c,tenantId,feature);
  if(state.suspended)throw new AppError(403,'This workspace is suspended. Contact DryKraft support for assistance.');
  if(!state.capability_enabled)throw new AppError(403,`The workspace plan does not enable ${feature}. Ask the owner to review the plan.`);
  if(!state.access)throw new AppError(402,'Your workspace needs an active plan. The owner can manage it in Settings - Billing. Your records remain available to read.');
}
export async function requireAvailableSeat(c,tenantId,userId) {
  if((await c.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId])).rowCount)return;
  const b=await billingAccess(c,tenantId);
  if(!b.access)throw new AppError(402,'Ask the workspace owner to activate a plan before joining.');
  const limit=b.entitlements.limits.users;
  if(limit!==null && b.members>=limit)throw new AppError(409,'The workspace user limit is in use. Ask the owner to review the plan.');
  if(b.entitlements.agreement_active && b.members>=b.entitlements.agreement_seats)throw new AppError(409,'All enterprise seats are in use. Ask the owner to review the agreement.');
  if(!b.agreement && b.subscription_id && ['active','past_due'].includes(b.status) && b.members>=b.seats)throw new AppError(409,'All paid seats are in use. Ask the workspace owner to add a seat in Settings - Billing.');
}
async function lock(c,tenantId) {
  await c.query("SET LOCAL lock_timeout='5s'");
  await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[tenantId]);
}
async function owner(c,tenantId,userId) {
  await lock(c,tenantId);
  if((await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId])).rows[0]?.role!=='owner')throw new AppError(403,'Only the workspace owner can manage billing.');
}
const snapshot=z.object({subscription_id:providerId,product_id:providerId,status:states,quantity:seats,next_billing_date:z.string().datetime({offset:true}),cancel_at_next_billing_date:z.boolean(),currency:z.literal('USD'),customer:z.object({customer_id:providerId}),metadata:z.object({workspace_id:uuid,checkout_id:uuid}),recurring_pre_tax_amount:z.number().int().nonnegative(),payment_frequency_count:z.literal(1),payment_frequency_interval:z.enum(['Month','Year']),tax_inclusive:z.literal(false),past_due_ends_at:z.string().datetime({offset:true}).nullable().optional(),trial_amount:z.number().int().nonnegative().nullable().optional()});
// Fetch current provider state while holding the workspace lock: delayed events cannot restore old access.
export async function syncSubscription(c,tenantId,subscriptionId,request=dodoRequest) {
  const current=(await c.query('SELECT * FROM workspace_billing WHERE tenant_id=$1',[tenantId])).rows[0];
  const s=snapshot.parse(await request(`/subscriptions/${providerId.parse(subscriptionId)}`));
  if(s.subscription_id!==subscriptionId || s.metadata.workspace_id!==tenantId)throw new AppError(400,'This subscription does not belong to this workspace.');
  const checkout=(await c.query('SELECT id,seats,billing_interval,product_id FROM billing_checkouts ORDER BY created_at DESC LIMIT 1')).rows[0];
  if(!checkout || checkout.id!==s.metadata.checkout_id || (!current.subscription_id && checkout.seats!==s.quantity))throw new AppError(400,'This subscription does not match a workspace checkout.');
  if(current.subscription_id && current.subscription_id!==s.subscription_id)throw new AppError(409,'This workspace already has another subscription.');
  const cadence=checkout.billing_interval,price=billingProduct(cadence),expectedProduct=current.subscription_id?(current.product_id||process.env.DODO_PRODUCT_ID):(checkout.product_id||process.env.DODO_PRODUCT_ID);
  if(s.product_id!==expectedProduct || (!current.subscription_id && configuredProductInterval(s.product_id)!==cadence) || s.payment_frequency_interval!==price.frequency)throw new AppError(400,'This subscription product or billing interval does not match its saved checkout.');
  // A provider grace window grants bounded access, never a locally invented extension.
  const grace=s.status==='past_due'?s.past_due_ends_at||null:null;
  if(s.recurring_pre_tax_amount!==s.quantity*price.unit_price_minor || Number(s.trial_amount??0)!==0)throw new AppError(409,'The subscription price needs review. Contact DryKraft before changing billing.');
  const changed=current.billing_interval!==cadence || new Date(current.past_due_ends_at).getTime()!==new Date(grace).getTime() || current.status!==s.status || current.seats!==s.quantity || current.cancel_at_next_billing_date!==s.cancel_at_next_billing_date || new Date(current.next_billing_date).getTime()!==new Date(s.next_billing_date).getTime();
  await c.query('UPDATE workspace_billing SET subscription_id=$1,customer_id=$2,status=$3,seats=$4,next_billing_date=$5,cancel_at_next_billing_date=$6,synced_at=now(),billing_interval=$8,product_id=$9,past_due_ends_at=$10 WHERE tenant_id=$7',[s.subscription_id,s.customer.customer_id,s.status,s.quantity,s.next_billing_date,s.cancel_at_next_billing_date,tenantId,cadence,s.product_id,grace]);
  if(changed)await event(c,tenantId,null,'billing.subscription.updated','workspace',tenantId,{status:s.status,seats:s.quantity,currency:'USD',billing_interval:cadence,unit_price_minor:price.unit_price_minor,past_due_ends_at:grace,next_billing_date:s.next_billing_date,cancel_at_next_billing_date:s.cancel_at_next_billing_date});
  return s;
}
export async function dodoWebhook(req,res) {
  const id=verifyDodoWebhook(req.body,req.headers);
  let raw;try{raw=JSON.parse(req.body.toString('utf8'));}catch{throw new AppError(400,'Invalid webhook payload.');}
  const payload=z.object({type:z.string().max(100),data:z.record(z.string(),z.unknown())}).parse(raw);
  if(!payload.type.startsWith('subscription.') || !configuredProductInterval(payload.data.product_id))return res.json({received:true});
  const tenantId=uuid.parse(payload.data.metadata?.workspace_id),subscriptionId=providerId.parse(payload.data.subscription_id);
  await tenantTransaction(tenantId,async c=>{
    await lock(c,tenantId);
    if(!(await c.query('SELECT 1 FROM workspace_billing WHERE tenant_id=$1',[tenantId])).rowCount)return;
    if((await c.query('SELECT 1 FROM billing_webhook_events WHERE id=$1',[id])).rowCount)return;
    const latest=(await c.query('SELECT id FROM billing_checkouts ORDER BY created_at DESC LIMIT 1')).rows[0];
    if(latest?.id!==payload.data.metadata?.checkout_id)return;
    await syncSubscription(c,tenantId,subscriptionId);
    await c.query('INSERT INTO billing_webhook_events(tenant_id,id,type) VALUES($1,$2,$3)',[tenantId,id,payload.type]);
  });
  res.json({received:true});
}
export const billingRouter=Router();
billingRouter.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
billingRouter.get('/',async(req,res)=>res.json(await tenantTransaction(req.auth.workspace.id,async c=>{
  const b=await billingAccess(c,req.auth.workspace.id);
  const open=(await c.query('SELECT seats,expires_at,billing_interval FROM billing_checkouts WHERE expires_at>now() ORDER BY created_at DESC LIMIT 1')).rows[0];
  return {entitlements:b.entitlements,agreement:b.agreement,plan:b.demo?'sample':'workspace',access:b.access,trial:b.trial,trial_started_at:b.trial_started_at,trial_ends_at:b.trial_ends_at,grace:b.grace,past_due_ends_at:b.past_due_ends_at,billing_interval:b.billing_interval,status:b.status,seats:b.seats,members:b.members,unit_price_minor:billingProduct(b.billing_interval).unit_price_minor,currency:'USD',next_billing_date:b.next_billing_date,cancel_at_next_billing_date:b.cancel_at_next_billing_date,synced_at:b.synced_at,subscribed:!!b.subscription_id,checkout:!b.subscription_id && open?open:null,intervals:['monthly','annual'].map(interval=>({interval,unit_price_minor:billingProduct(interval).unit_price_minor,ready:!!billingProduct(interval).product_id&&!!process.env.DODO_API_KEY&&!!process.env.DODO_WEBHOOK_KEY})),ready:!!billingProduct('monthly').product_id && !!process.env.DODO_API_KEY && !!process.env.DODO_WEBHOOK_KEY,enterprise_email:process.env.ENTERPRISE_EMAIL || null,enterprise_requested_at:b.enterprise_requested_at};
})));
billingRouter.post('/checkout',async(req,res)=>{
  const body=z.object({seats,billing_interval:billingInterval.default('monthly')}).strict().parse(req.body),quantity=body.seats,cadence=body.billing_interval,price=billingProduct(cadence),tenantId=req.auth.workspace.id;
  const result=await tenantTransaction(tenantId,async c=>{
    await owner(c,tenantId,req.auth.user.id);
    const b=await billingAccess(c,tenantId);
    if(b.demo)throw new AppError(403,'Sample workspaces cannot subscribe.');
    if(b.subscription_id){
      const s=await syncSubscription(c,tenantId,b.subscription_id);
      if(!['cancelled','failed','expired'].includes(s.status))throw new AppError(409,'This workspace already has a subscription. Manage it in billing.');
      await c.query('UPDATE workspace_billing SET subscription_id=NULL,status=NULL,seats=NULL,next_billing_date=NULL,cancel_at_next_billing_date=false,product_id=NULL,past_due_ends_at=NULL WHERE tenant_id=$1',[tenantId]);
      await c.query('UPDATE billing_checkouts SET expires_at=now() WHERE expires_at>now()');
    }
    if(quantity<b.members)throw new AppError(400,`Choose at least ${b.members} seats for your current members.`);
    if(!price.product_id)throw new AppError(503,'Checkout is not configured. Please try again later.');
    const open=(await c.query('SELECT * FROM billing_checkouts WHERE expires_at>now() ORDER BY created_at DESC LIMIT 1')).rows[0];
    if(open){if(open.seats!==quantity||open.billing_interval!==cadence)throw new AppError(409,`An open checkout is for ${open.seats} seats. Complete it or wait until it expires before choosing another seat count or billing interval.`);if(open.checkout_url)return {url:providerLink(open.checkout_url)};throw new AppError(503,'Checkout creation could not be confirmed. Contact DryKraft or retry after the open checkout expires.');}
    validateBillingProduct(await dodoRequest('/products/'+providerId.parse(price.product_id)),cadence);
    const id=open?.id || randomUUID();
    if(!open)await c.query('INSERT INTO billing_checkouts(tenant_id,id,seats,billing_interval,product_id) VALUES($1,$2,$3,$4,$5)',[tenantId,id,quantity,cadence,price.product_id]);
    const origin=process.env.APP_ORIGIN || 'http://localhost:5173';
    let session;
    try{session=await dodoRequest('/checkouts',{product_cart:[{product_id:price.product_id,quantity}],billing_currency:'USD',customer:{email:req.auth.user.email,name:req.auth.user.name},metadata:{workspace_id:tenantId,checkout_id:id},subscription_data:{trial_period_days:Math.max(0,Math.min(trialDays,Math.ceil((new Date(b.trial_ends_at).getTime()-Date.now())/86400000)))},return_url:`${origin}/settings/billing?checkout=${id}`,cancel_url:`${origin}/settings/billing`,feature_flags:{allow_discount_code:false,allow_currency_selection:false}});}
    // ponytail: freeze an ambiguous checkout for its 24-hour lifetime; a provider reconciliation job can shorten this recovery window.
    catch(error){return {error};}
    const url=providerLink(session.checkout_url);providerId.parse(session.session_id);
    await c.query('UPDATE billing_checkouts SET session_id=$1,checkout_url=$2 WHERE id=$3',[session.session_id,url,id]);
    return {url};
  });if(result.error)throw result.error;res.json(result);
});
billingRouter.post('/refresh',async(req,res)=>{
  const tenantId=req.auth.workspace.id;
  await tenantTransaction(tenantId,async c=>{
    await owner(c,tenantId,req.auth.user.id);
    const b=await billingAccess(c,tenantId);
    if(b.subscription_id){await syncSubscription(c,tenantId,b.subscription_id);return;}
    const id=req.body.checkout?uuid.parse(req.body.checkout):null;
    const checkout=(await c.query('SELECT session_id FROM billing_checkouts WHERE ($1::uuid IS NULL OR id=$1) ORDER BY created_at DESC LIMIT 1',[id])).rows[0];
    if(!checkout?.session_id)return;
    const session=await dodoRequest(`/checkouts/${providerId.parse(checkout.session_id)}`);
    // Return-query status is never trusted. Provider payment detail identifies the actual subscription.
    if(session.payment_id){const payment=await dodoRequest(`/payments/${providerId.parse(session.payment_id)}`);if(payment.subscription_id)await syncSubscription(c,tenantId,payment.subscription_id);}
  });res.json({ok:true});
});
billingRouter.post('/portal',async(req,res)=>{
  const tenantId=req.auth.workspace.id;
  res.json(await tenantTransaction(tenantId,async c=>{
    await owner(c,tenantId,req.auth.user.id);
    const b=await billingAccess(c,tenantId);if(!b.customer_id)throw new AppError(409,'Complete checkout before opening the billing portal.');
    const portal=await dodoRequest(`/customers/${providerId.parse(b.customer_id)}/customer-portal/session?send_email=false&return_url=${encodeURIComponent((process.env.APP_ORIGIN || 'http://localhost:5173')+'/settings/billing')}`,{},'POST');
    return {url:providerLink(portal.link)};
  }));
});
billingRouter.post('/seats',async(req,res)=>{
  const quantity=seats.parse(req.body.seats),tenantId=req.auth.workspace.id;
  await tenantTransaction(tenantId,async c=>{
    await owner(c,tenantId,req.auth.user.id);const b=await billingAccess(c,tenantId);
    if(!b.subscription_id || b.status!=='active')throw new AppError(409,'Refresh billing and activate your subscription before changing seats.');
    if(quantity<b.members)throw new AppError(400,`Choose at least ${b.members} seats, or remove members first.`);
    if(quantity===b.seats)return;
    await dodoRequest(`/subscriptions/${providerId.parse(b.subscription_id)}/change-plan`,{product_id:b.product_id||process.env.DODO_PRODUCT_ID,quantity,proration_billing_mode:'do_not_bill'});
    await syncSubscription(c,tenantId,b.subscription_id);
  });res.json({ok:true});
});
billingRouter.post('/enterprise',async(req,res)=>{
  const requirements=z.string().trim().min(20).max(3000).parse(req.body.requirements),tenantId=req.auth.workspace.id;
  await tenantTransaction(tenantId,async c=>{
    await owner(c,tenantId,req.auth.user.id);
    await c.query('UPDATE workspace_billing SET enterprise_requested_at=now(),enterprise_requirements=$1 WHERE tenant_id=$2',[requirements,tenantId]);
    await event(c,tenantId,req.auth.user.id,'billing.enterprise.requested','workspace',tenantId,{});
  });res.json({ok:true});
});
