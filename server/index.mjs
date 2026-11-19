import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { sharedRateLimit,configureRateLimits,consumeRateLimit } from './rate-limits.mjs';
import { z } from 'zod';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pool,tenantTransaction,event } from './db.mjs';
import { authenticate,authenticateAccount,accountUser,workspaceAuth,createSession,hashPassword,checkPassword,tokenHash,clearSessionCookie,requireWrite,requireAdmin,slugFromHost } from './auth.mjs';
import { AppError,builtIns,recordUserNames,initializeWorkspace,getDefinition,objectSchema,fieldSchema,editDefinition,saveRecord,deleteRecord,widgetSchema,aggregate,widgetReportContext,resolveRecord,addActivity,dealStageHistory,connectExistingLead } from './model.mjs';
import {relatedRecords,invoiceContext} from './relationships.mjs';
import { csvCell } from '../src/lib/csv.mjs';
import { currencyOptions,currencySettingsSchema,workspaceCurrencies,monetaryFields } from './currency.mjs';
import { financeRouter } from './finance.mjs';
import { templatesRouter } from './templates.mjs';
import { automationRouter } from './routes-automation.mjs';
import { createExecution } from './automation.mjs';
import { websitePages } from './website.mjs';
import { renderNotFound } from './not-found.mjs';
import { recordToolsRouter } from './record-tools.mjs';
import { recordListsRouter,listRecords } from './record-lists.mjs';
import { invitationRouter,teamRouter } from './team.mjs';
import { organizationRouter } from './organization.mjs';
import { accountRouter } from './account.mjs';
import {configureMfa,beginMfaLogin,completeMfaLogin} from './mfa.mjs';
import { developerRouter,configureDeveloperAccess } from './developer-access.mjs';
import { calendarRouter,calendarPublicRouter,configureCalendarOAuth } from './routes-calendar.mjs';
import { customerWebhookRouter } from './customer-webhooks.mjs';
import { versionedApiRouter,configureVersionedApi } from './versioned-api.mjs';
import { billingRouter,dodoWebhook,requireBillingAccess } from './billing.mjs';
import { outreachRouter,outreachPublicRouter,configureOutreachOAuth,whatsappWebhook } from './routes-outreach.mjs';
import {platformRouter} from './platform.mjs';
import {platformInvitationRouter,resellerInvitationRouter} from './platform-invitations.mjs';
import {configurePlatformAuth} from './platform-auth.mjs';
import {platformPool,validatePlatformDatabase} from './platform-db.mjs';
import {resellerApiRouter,resellerApiPool,configureResellerApi,validateResellerApiDatabase} from './reseller-api.mjs';
import {resellerRouter} from './reseller.mjs';
import {resellerPool,validateResellerDatabase} from './reseller-db.mjs';
import {configureResellerAuth} from './reseller-auth.mjs';
import {queuePasswordResetEmail} from './platform-mail.mjs';

const app=express();
app.disable('x-powered-by');
app.set('trust proxy','loopback');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:"],connectSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"]}},crossOriginEmbedderPolicy:false}));
app.use((req,res,next)=>{req.requestId=randomUUID();res.setHeader('X-Request-ID',req.requestId);next();});
app.post('/api/billing/dodo/webhook',sharedRateLimit('dodo-ingress',{windowMs:60000,limit:120,message:{error:{message:'Too many payment notifications. Retry after the indicated window.'}}}),express.raw({type:'application/json',limit:'512kb'}),dodoWebhook);
app.post('/api/outreach/whatsapp/:id',sharedRateLimit('whatsapp-ingress',{windowMs:60000,limit:120,message:{error:{message:'Too many message notifications. Retry after the indicated window.'}}}),express.raw({type:'application/json',limit:'512kb'}),whatsappWebhook);
app.use('/api',sharedRateLimit('api',{windowMs:60000,limit:300,message:{error:{message:'Too many requests. Wait a minute and try again.'}}}));
app.use(express.json({limit:'512kb'}),cookieParser());
app.use((req,res,next)=>{
  if(!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin && !req.path.startsWith('/api/hooks/')) {
    const origin=new URL(req.headers.origin);
    if(origin.host!==req.headers.host) return next(new AppError(403,'This request came from another origin.'));
  }
  next();
});
const redis=createClient({url:process.env.REDIS_URL});
redis.on('error',error=>console.error('Redis connection:',error.message));
await redis.connect();
configureRateLimits(redis);
configureOutreachOAuth(redis);
configureCalendarOAuth(redis);
configureVersionedApi(redis);
configureDeveloperAccess(redis);
configureMfa(redis);
configurePlatformAuth(redis);
configureResellerApi(redis);
configureResellerAuth(redis);
await validatePlatformDatabase();
await validateResellerApiDatabase();
await validateResellerDatabase();
app.use('/api/sa',platformRouter);
app.use('/api/reseller',resellerRouter);
app.use('/api/v1/reseller',resellerApiRouter);
app.use('/api/v1',versionedApiRouter);
app.use('/api/outreach',outreachPublicRouter);
app.use('/api/calendar',calendarPublicRouter);
app.get('/api/health',async(req,res)=>{
  await pool.query('SELECT 1');await redis.ping();res.json({status:'ok',database:'connected',redis:'connected'});
});
app.get('/api/meta',async(req,res)=>res.json({name:'DryKraft',domain:process.env.APP_DOMAIN || 'localhost',currency_options:currencyOptions,demo:process.env.DEMO_ENABLED==='true' && process.env.NODE_ENV!=='production',platform:(await pool.query('SELECT public_platform_settings() AS data')).rows[0].data}));
const authLimit=sharedRateLimit('auth-hooks',{windowMs:15*60000,limit:30,message:{error:{message:'Too many sign-in or setup attempts. Wait 15 minutes and try again.'}}});
const passwordResetLimit=sharedRateLimit('password-reset',{windowMs:15*60000,limit:6,message:{error:{message:'Too many password reset attempts. Wait a little and try again.'}}});
app.use('/api/auth/invitations',authLimit,invitationRouter);
app.use('/api/auth/platform-invitations',authLimit,platformInvitationRouter);
app.use('/api/auth/reseller-invitations',authLimit,resellerInvitationRouter);
const authBody=z.object({email:z.string().email().max(200).transform(v=>v.toLowerCase().trim()),password:z.string().min(10).max(128)});
const passwordResetOrigin=()=>{const domain=process.env.APP_DOMAIN||'localhost';return domain==='localhost'?(process.env.APP_ORIGIN||'http://localhost:5173').replace(/\/$/,''):`https://app.${domain}`;};
app.post('/api/auth/forgot-password',passwordResetLimit,async(req,res)=>{
 const {email}=z.object({email:z.string().email().max(200).transform(value=>value.toLowerCase().trim())}).strict().parse(req.body);
 const emailKey='drykraft:auth:password-reset-email:'+createHash('sha256').update(email).digest('hex');
 const requests=await redis.incr(emailKey);if(requests===1)await redis.expire(emailKey,3600);
 if(requests<=3){
  const user=(await pool.query('SELECT id,auth_version FROM users WHERE email=$1 AND NOT platform_user_disabled(id)',[email])).rows[0];
  if(user&&email!=='demo@drykraft.local'){
   const token=randomBytes(32).toString('base64url'),key='drykraft:auth:password-reset:'+createHash('sha256').update(token).digest('hex');
   await redis.set(key,JSON.stringify({user_id:user.id,auth_version:user.auth_version}),{EX:900,NX:true});
   try{await queuePasswordResetEmail(email,`${passwordResetOrigin()}/reset-password#${token}`);}
   catch{await redis.del(key);console.error('Password reset email could not be queued.',req.requestId);}
  }
 }
 res.status(202).json({ok:true,message:'If an account exists for that email, a password reset link has been sent. The link expires in 15 minutes.'});
});
app.post('/api/auth/reset-password',authLimit,async(req,res)=>{
 const body=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),password:z.string().min(10).max(128),confirm_password:z.string().min(10).max(128)}).strict().parse(req.body);
 if(body.password!==body.confirm_password)throw new AppError(400,'The new passwords do not match.');
 const key='drykraft:auth:password-reset:'+createHash('sha256').update(body.token).digest('hex'),saved=await redis.getDel(key);
 if(!saved)throw new AppError(400,'This reset link has expired or already been used. Request a new one.');
 let reset;try{reset=JSON.parse(saved);}catch{throw new AppError(400,'This reset link has expired or already been used. Request a new one.');}
 const passwordHash=await hashPassword(body.password),client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.user_id',$1,true)",[reset.user_id]);
  const user=(await client.query('SELECT id,auth_version FROM users WHERE id=$1 FOR UPDATE',[reset.user_id])).rows[0];
  if(!user||user.auth_version!==reset.auth_version)throw new AppError(400,'This reset link has expired or already been used. Request a new one.');
  await client.query('UPDATE users SET password_hash=$1,password_changed_at=now(),auth_version=auth_version+1 WHERE id=$2',[passwordHash,user.id]);
  await client.query('DELETE FROM auth_mfa_challenges WHERE user_id=$1',[user.id]);
  const revoked=await client.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
  await client.query("INSERT INTO account_security_events(user_id,action,count) VALUES($1,'password.changed',$2)",[user.id,revoked.rowCount]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 clearSessionCookie(res);res.json({ok:true});
});
app.get('/api/auth/subdomain',authLimit,async(req,res)=>{
  const slug=z.string().regex(/^[a-z][a-z0-9-]{2,39}$/).parse(req.query.slug);
  const reserved=['www','app','api','admin','auth','support','mail','assets','status','demo'];
  const exists=(await pool.query('SELECT 1 FROM workspaces WHERE slug=$1',[slug])).rowCount>0;
  res.json({available:!reserved.includes(slug) && !exists});
});
app.post('/api/auth/signup',authLimit,async(req,res)=>{
  const body=authBody.extend({name:z.string().trim().min(2).max(100)}).parse(req.body);
  if(slugFromHost(req.hostname)) throw new AppError(400,'Create your account from the main application address.');
  if(!(await pool.query('SELECT platform_signup_enabled() AS enabled')).rows[0].enabled)throw new AppError(403,'New account registration is temporarily closed. Contact support for assistance.');
  const userId=randomUUID(),password=await hashPassword(body.password);
  await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,body.email,body.name,password]);
  await createSession(req,res,userId,null,password);res.status(201).json({id:userId,onboarding:true});
});
app.post('/api/auth/onboarding',authLimit,authenticateAccount,async(req,res)=>{
  const body=currencySettingsSchema.extend({workspace:z.string().trim().min(2).max(100),slug:z.string().regex(/^[a-z][a-z0-9-]{2,39}$/)}).parse(req.body);
  if(['www','app','api','admin','auth','support','mail','assets','status','demo'].includes(body.slug)) throw new AppError(400,'This workspace address is reserved.');
  if(slugFromHost(req.hostname)) throw new AppError(400,'Set up your workspace from the main application address.');
  const tenantId=randomUUID();
  const id=await tenantTransaction(tenantId,async client=>{
    // Serialize first-workspace creation per account; retries reuse the completed workspace.
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.account.user_id]);
    const existing=(await client.query('SELECT m.tenant_id FROM memberships m JOIN workspaces w ON w.id=m.tenant_id WHERE m.user_id=$1 ORDER BY w.created_at LIMIT 1',[req.account.user_id])).rows[0];
    const selected=existing?.tenant_id || tenantId;
    if(!existing) {
      await client.query('INSERT INTO workspaces(id,name,slug,settings) VALUES($1,$2,$3,$4)',[tenantId,body.workspace,body.slug,{currency:body.currency,currencies:body.currencies || [body.currency],timezone:'Asia/Kolkata'}]);
      await client.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'owner')",[req.account.user_id,tenantId]);
      await initializeWorkspace(client,tenantId);
    }
    await client.query('UPDATE sessions SET tenant_id=$1 WHERE user_id=$2 AND tenant_id IS NULL',[selected,req.account.user_id]);
    return selected;
  });
  res.status(201).json({id});
});
app.post('/api/auth/login',authLimit,async(req,res)=>{
  const body=authBody.parse(req.body);
  const user=(await pool.query('SELECT * FROM users WHERE email=$1',[body.email])).rows[0];
  const valid=user?await checkPassword(body.password,user.password_hash):(await hashPassword(body.password),false);
  if(!valid) throw new AppError(401,'Email or password is incorrect.');
  const slug=slugFromHost(req.hostname);
  const workspace=(await pool.query(`SELECT w.id FROM workspaces w JOIN memberships m ON m.tenant_id=w.id WHERE m.user_id=$1 AND ($2::text IS NULL OR w.slug=$2) ORDER BY w.created_at LIMIT 1`,[user.id,slug])).rows[0];
  if(!workspace && slug) throw new AppError(403,'You do not have access to this workspace.');
  res.json(await beginMfaLogin(req,res,user.id,workspace?.id || null,user.password_hash));
});
app.post('/api/auth/mfa',authLimit,async(req,res)=>{res.set('Cache-Control','no-store');res.json(await completeMfaLogin(req,res));});
app.post('/api/auth/demo',authLimit,async(req,res)=>{
  if(process.env.DEMO_ENABLED!=='true' || process.env.NODE_ENV==='production') throw new AppError(404,'Demo access is disabled.');
  const demo=(await pool.query("SELECT m.user_id,w.id,u.password_hash FROM workspaces w JOIN memberships m ON m.tenant_id=w.id JOIN users u ON u.id=m.user_id WHERE w.slug='demo' AND m.role='owner' LIMIT 1")).rows[0];
  if(!demo) throw new AppError(503,'Run the local setup to create the demo workspace.');
  await createSession(req,res,demo.user_id,demo.id,demo.password_hash);res.json({ok:true});
});
app.post('/api/auth/logout',async(req,res)=>{
  if(req.cookies.drykraft_session) await pool.query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(req.cookies.drykraft_session)]);
  clearSessionCookie(res);res.json({ok:true});
});
app.use('/api/account',authenticateAccount,async(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(req.method==='POST' && req.path==='/password') {
    const attempts=await consumeRateLimit(redis,`account-password:${req.account.user_id}`,900000);
    if(attempts.totalHits>10){res.set('Retry-After',String(Math.max(1,Math.ceil((attempts.resetTime-Date.now())/1000))));throw new AppError(429,'Too many password change attempts. Wait 15 minutes and try again.');}
  }
  next();
},accountRouter);
app.post('/api/hooks/:token',authLimit,async(req,res)=>{
  const token=z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.token);
  const route=(await pool.query('SELECT * FROM resolve_workflow_webhook($1)',[tokenHash(token)])).rows[0];
  if(!route)throw new AppError(404,'Webhook not found.');
  const input=z.record(z.string(),z.unknown()).parse(req.body);
  const execution=await tenantTransaction(route.tenant_id,async c=>{
    await requireBillingAccess(c,route.tenant_id);
    const w=(await c.query("SELECT * FROM workflows WHERE id=$1 AND status='active'",[route.workflow_id])).rows[0];
    if(!w?.published_version_id)throw new AppError(409,'This workflow is not active.');
    const v=(await c.query('SELECT * FROM workflow_versions WHERE id=$1',[w.published_version_id])).rows[0];
    if(!v.graph.nodes.some(n=>n.data.kind==='trigger.webhook'))throw new AppError(409,'This workflow does not have a webhook trigger.');
    const key=req.headers['idempotency-key'];
    let eventId=null;
    if(key){
      z.string().min(1).max(200).parse(key);
      const hash=tokenHash(`${route.tenant_id}:${w.id}:${key}`).slice(0,32);
      eventId=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
    }
    return createExecution(c,route.tenant_id,w,v,input,eventId);
  });
  res.status(202).json({execution_id:execution.id,state:execution.state});
});
app.get('/api/session',authenticateAccount,async(req,res)=>{
  const workspaces=(await pool.query('SELECT w.id,w.name,w.slug,m.role FROM workspaces w JOIN memberships m ON m.tenant_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at',[req.account.user_id])).rows;
  if(!req.account.tenant_id && (slugFromHost(req.hostname) || req.headers['x-workspace-id'])) throw new AppError(403,'You do not have access to this workspace.');
  const auth=req.account.tenant_id?await workspaceAuth(req,req.account):{user:accountUser(req.account),workspace:null,role:null};
  res.json({...auth,workspaces,currency_options:currencyOptions,domain:process.env.APP_DOMAIN || 'localhost',subdomain_routing:process.env.WORKSPACE_SUBDOMAINS_ENABLED==='true',platform:(await pool.query('SELECT public_platform_settings() AS data')).rows[0].data});
});
app.use('/api',authenticate);
app.use('/api/billing',billingRouter);
app.use('/api/developer',developerRouter);
app.use('/api/developer/webhooks',customerWebhookRouter);
app.use('/api',async(req,res,next)=>{
  if(!['GET','HEAD','OPTIONS'].includes(req.method) && !['/session/workspace','/analytics/query'].includes(req.path) && !(req.method==='DELETE' && req.path.startsWith('/settings/members/')) && !(req.method==='POST' && /^\/calendar\/connections\/[0-9a-f-]{36}\/disable$/.test(req.path)) && !(req.method==='PUT' && /^\/calendar\/appointments\/[0-9a-f-]{36}$/.test(req.path) && req.body?.state==='cancelled'))await tenantTransaction(req.auth.workspace.id,c=>requireBillingAccess(c,req.auth.workspace.id));
  next();
});
app.use('/api/calendar',calendarRouter);
app.use('/api/templates',templatesRouter);
const tx=(req,fn)=>tenantTransaction(req.auth.workspace.id,fn);
app.post('/api/session/workspace',async(req,res)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.body);
  if(!(await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND tenant_id=$2',[req.auth.user.id,id])).rowCount) throw new AppError(403,'Workspace access denied.');
  await pool.query('UPDATE sessions SET tenant_id=$1 WHERE token_hash=$2',[id,tokenHash(req.cookies.drykraft_session)]);res.json({ok:true});
});
app.get('/api/objects',async(req,res)=>res.json(await tx(req,async c=>(await c.query('SELECT * FROM object_definitions ORDER BY built_in DESC,created_at')).rows.map(d=>({...d,managed_field_keys:builtIns.find(b=>b.key===d.key)?.fields.map(f=>f.key) || []})))));
app.post('/api/objects',requireAdmin,async(req,res)=>{
  const b=objectSchema.parse(req.body);b.fields=monetaryFields(b.fields);if(b.fields.length>100)throw new AppError(400,'Reserve one field for the object currency.');
  const item=await tx(req,async c=>(await c.query('INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.auth.workspace.id,b.key,b.name,b.singular_name,JSON.stringify(b.fields)])).rows[0]);
  res.status(201).json(item);
});
app.post('/api/objects/:key/fields',requireAdmin,async(req,res)=>{
  const f=fieldSchema.parse(req.body);
  res.json(await tx(req,async c=>{
    await c.query('SELECT key FROM object_definitions WHERE key=$1 FOR UPDATE',[req.params.key]);
    const d=await getDefinition(c,req.params.key);
    if(d.key==='invoices' && f.key==='document_template')throw new AppError(400,'This field key is reserved for invoice document settings.');
    if(d.fields.some(existing=>existing.key===f.key)) throw new AppError(409,'This field key already exists.');
    if(d.fields.length>=100) throw new AppError(400,'This object has reached the field limit.');
    if(f.required && (await c.query('SELECT 1 FROM records WHERE object_key=$1 LIMIT 1',[d.key])).rowCount) throw new AppError(400,'Add an optional field first, fill existing records, then make it required.');
    const fields=monetaryFields([...d.fields,f]);if(fields.length>100)throw new AppError(400,'Reserve one field for the object currency.');
    return (await c.query('UPDATE object_definitions SET fields=$1 WHERE key=$2 RETURNING *',[JSON.stringify(fields),d.key])).rows[0];
  }));
});
app.put('/api/objects/:key',requireAdmin,async(req,res)=>res.json(await tx(req,c=>editDefinition(c,req.auth.workspace.id,req.auth.user.id,req.params.key,req.body))));
app.put('/api/objects/:key/fields/:field',requireAdmin,async(req,res)=>res.json(await tx(req,c=>editDefinition(c,req.auth.workspace.id,req.auth.user.id,req.params.key,req.body,req.params.field))));
app.get('/api/records/:key',async(req,res)=>res.json(await tx(req,c=>listRecords(c,req.params.key,req.query))));
app.get('/api/record-options',async(req,res)=>res.json(await tx(req,async c=>{
  const q=z.object({object:z.string().optional(),selected:z.string().uuid().optional(),search:z.string().max(200).default(''),cursor:z.string().max(500).optional()}).parse(req.query);
  const selected=q.selected?await resolveRecord(c,q.selected,q.object || null):null,key=q.object || selected?.object_key || 'people';
  const page=await listRecords(c,key,{search:q.search,cursor:q.cursor,limit:25});
  return {...page,object:key,selected};
})));
app.get('/api/records/:key/:id/related',async(req,res)=>res.json(await tx(req,c=>relatedRecords(c,req.params.key,req.params.id,req.query))));
app.get('/api/records/:key/:id/invoice-context',async(req,res)=>res.json(await tx(req,c=>invoiceContext(c,req.params.key,req.params.id))));
app.post('/api/records/:key',requireWrite,async(req,res)=>res.status(201).json(await tx(req,c=>saveRecord(c,req.auth.workspace.id,req.auth.user.id,req.params.key,req.body.data,null,null,null,{dealValues:req.body.sales_data}))));
app.get('/api/records/:key/:id',async(req,res)=>{
  z.string().uuid().parse(req.params.id);
  const record=await tx(req,async c=>{const definition=await getDefinition(c,req.params.key);return (await recordUserNames(c,definition,[await resolveRecord(c,req.params.id,req.params.key)]))[0];});
  if(!record)throw new AppError(404,'Record not found in this workspace.');res.json(record);
});
app.put('/api/records/:key/:id',requireWrite,async(req,res)=>{
  const b=z.object({data:z.record(z.string(),z.unknown()),version:z.number().int().positive()}).parse(req.body);
  z.string().uuid().parse(req.params.id);
  res.json(await tx(req,c=>saveRecord(c,req.auth.workspace.id,req.auth.user.id,req.params.key,b.data,req.params.id,b.version)));
});
app.delete('/api/records/:key/:id',requireWrite,async(req,res)=>{
  z.string().uuid().parse(req.params.id);
  const version=req.query.version===undefined?null:z.coerce.number().int().positive().parse(req.query.version);
  await tx(req,c=>deleteRecord(c,req.auth.workspace.id,req.auth.user.id,req.params.key,req.params.id,version));res.json({ok:true});
});
app.post('/api/leads/:id/convert',requireWrite,async(req,res)=>{
  z.string().uuid().parse(req.params.id);
  res.json(await tx(req,c=>connectExistingLead(c,req.auth.workspace.id,req.auth.user.id,req.params.id,true)));
});
app.get('/api/records/deals/:id/stage-history',async(req,res)=>res.json(await tx(req,c=>dealStageHistory(c,req.params.id,req.query.cursor || null))));
app.get('/api/activities',async(req,res)=>{
  const recordId=req.query.record_id?z.string().uuid().parse(req.query.record_id):null;
  res.json(await tx(req,async c=>{const canonical=recordId?(await resolveRecord(c,recordId)).id:null;return (await c.query(`SELECT a.*,coalesce(u.name,'Service account: '||s.name) AS actor_name,r.data->>'name' AS record_name,r.object_key FROM activities a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN service_accounts s ON s.tenant_id=a.tenant_id AND s.id=a.service_account_id LEFT JOIN records r ON r.id=a.record_id AND r.tenant_id=a.tenant_id WHERE ($1::uuid IS NULL OR a.record_id=$1) ORDER BY a.created_at DESC LIMIT 50`,[canonical])).rows;}));
});
app.post('/api/activities',requireWrite,async(req,res)=>{
  const b=z.object({record_id:z.string().uuid(),body:z.string().trim().min(1).max(10000),type:z.enum(['note','call','email','meeting']).default('note')}).parse(req.body);
  res.status(201).json(await tx(req,c=>addActivity(c,req.auth.workspace.id,req.auth.user.id,b)));
});
app.get('/api/pipelines',async(req,res)=>res.json(await tx(req,async c=>(await c.query('SELECT * FROM pipelines ORDER BY name')).rows)));
const pipelineBody=z.object({name:z.string().min(1).max(100),stages:z.array(z.object({id:z.string().regex(/^[a-z0-9_-]{1,40}$/),name:z.string().min(1).max(80),probability:z.number().min(0).max(100),color:z.string().regex(/^#[0-9a-fA-F]{6}$/)})).min(1).max(30)}).superRefine((v,c)=>{if(new Set(v.stages.map(s=>s.id)).size!==v.stages.length)c.addIssue({code:'custom',message:'Stage IDs must be unique.'});});
app.post('/api/pipelines',requireAdmin,async(req,res)=>{
  const b=pipelineBody.parse(req.body);res.status(201).json(await tx(req,async c=>(await c.query('INSERT INTO pipelines(tenant_id,id,name,stages) VALUES($1,$2,$3,$4) RETURNING *',[req.auth.workspace.id,randomUUID(),b.name,JSON.stringify(b.stages)])).rows[0]));
});
app.put('/api/pipelines/:id',requireAdmin,async(req,res)=>{
  const b=pipelineBody.parse(req.body);
  res.json(await tx(req,async c=>{
    if(!(await c.query('SELECT id FROM pipelines WHERE id=$1 FOR UPDATE',[req.params.id])).rowCount)throw new AppError(404,'Pipeline not found.');
    const used=(await c.query("SELECT DISTINCT data->>'stage' AS stage FROM records WHERE object_key='deals' AND data->>'pipeline_id'=$1",[req.params.id])).rows;
    if(used.some(v=>!b.stages.some(s=>s.id===v.stage))) throw new AppError(400,'Move deals before removing a stage that they use.');
    const item=(await c.query('UPDATE pipelines SET name=$1,stages=$2 WHERE id=$3 RETURNING *',[b.name,JSON.stringify(b.stages),req.params.id])).rows[0];
    if(!item)throw new AppError(404,'Pipeline not found.');return item;
  }));
});
app.get('/api/dashboards',async(req,res)=>res.json(await tx(req,async c=>(await c.query('SELECT * FROM dashboards ORDER BY created_at')).rows)));
app.post('/api/dashboards',requireWrite,async(req,res)=>{
  const b=z.object({name:z.string().min(1).max(100)}).parse(req.body);
  res.status(201).json(await tx(req,async c=>(await c.query('INSERT INTO dashboards(tenant_id,id,name) VALUES($1,$2,$3) RETURNING *',[req.auth.workspace.id,randomUUID(),b.name])).rows[0]));
});
app.put('/api/dashboards/:id',requireWrite,async(req,res)=>{
  const b=z.object({name:z.string().min(1).max(100),widgets:z.array(widgetSchema).max(30),version:z.number().int().positive()}).parse(req.body);
  if(new Set(b.widgets.map(w=>w.id)).size!==b.widgets.length)throw new AppError(400,'Widget IDs must be unique.');
  res.json(await tx(req,async c=>{
    for(const widget of b.widgets) await aggregate(c,widget);
    const item=(await c.query('UPDATE dashboards SET name=$1,widgets=$2,version=version+1 WHERE id=$3 AND version=$4 RETURNING *',[b.name,JSON.stringify(b.widgets),req.params.id,b.version])).rows[0];
    if(!item)throw new AppError(409,'Dashboard changed. Refresh before saving.');return item;
  }));
});
app.post('/api/analytics/query',async(req,res)=>{
  const b=z.object({widgets:z.array(widgetSchema).max(30)}).parse(req.body);
  res.json(await tx(req,async c=>{
    const result=Object.create(null),now=new Date();for(const w of b.widgets)result[w.id]=await aggregate(c,w,await widgetReportContext(c,w,now));return result;
  }));
});
app.post('/api/analytics/export',async(req,res)=>{
  const b=z.object({dashboard_id:z.string().uuid(),version:z.number().int().positive()}).parse(req.body);
  res.set('Cache-Control','private, no-store');
  res.json(await tx(req,async c=>{
    const dashboard=(await c.query('SELECT * FROM dashboards WHERE id=$1 FOR SHARE',[b.dashboard_id])).rows[0];
    if(!dashboard)throw new AppError(404,'Dashboard not found.');
    if(dashboard.version!==b.version)throw new AppError(409,'Dashboard changed. Refresh before downloading its report.');
    const widgets=z.array(widgetSchema).max(30).parse(dashboard.widgets),now=new Date(),rows=[['Dashboard','Widget','Object','Calculation','Numeric field','Group field','Group','Group label','Value','Currency','Filter field','Filter equals','Date source','From','Through','Timezone','Generated at']];
    const stageNames=new Map((await c.query('SELECT stages FROM pipelines ORDER BY name')).rows.flatMap(p=>p.stages.map(s=>[s.id,s.name])));
    for(const w of widgets){
      const context=await widgetReportContext(c,w,now),definition=await getDefinition(c,w.object);
      const monetary=w.operation!=='count' && (definition.fields.find(f=>f.key===w.field)?.type==='currency' || ['invoices','purchase_orders','expenses'].includes(w.object));
      for(const row of await aggregate(c,w,context))rows.push([dashboard.name,w.title,w.object,w.operation,w.field || '',w.group_by || '',row.label,w.object==='deals' && w.group_by==='stage'?stageNames.get(row.label) || row.label:row.label,row.value,monetary?context.currency:'',w.filter?.field || '',w.filter?.value || '',w.date_range?.source==='field'?`field:${w.date_range.field}`:w.date_range?.source || '',context.dates?.from || '',context.dates?.to || '',context.timezone,now.toISOString()]);
    }
    return {filename:`drykraft-report-${dashboard.id}.csv`,csv:'\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'),generated_at:now.toISOString(),rows:rows.length-1,group_limit:100};
  }));
});
app.get('/api/search',async(req,res)=>{
  const q=z.string().min(1).max(100).parse(req.query.q);
  res.json(await tx(req,async c=>(await c.query("SELECT id,object_key,data->>'name' AS name,data->>'email' AS email FROM records WHERE merged_into IS NULL AND data->>'name' ILIKE $1 ORDER BY updated_at DESC LIMIT 20",[`%${q.replace(/[\\%_]/g,'\\$&')}%`])).rows));
});
app.use('/api/settings',teamRouter);
app.use('/api/settings/organization',organizationRouter);
app.put('/api/settings/workspace',requireAdmin,async(req,res)=>{
  const b=z.object({name:z.string().min(2).max(100),timezone:z.string().max(80)}).extend(currencySettingsSchema.shape).parse(req.body);currencySettingsSchema.parse(b);
  try{new Intl.DateTimeFormat('en',{timeZone:b.timezone});}catch{throw new AppError(400,'Choose a valid timezone.');}
  res.json((await pool.query("UPDATE workspaces SET name=$1,settings=settings || $2::jsonb WHERE id=$3 RETURNING *",[b.name,{currency:b.currency,currencies:b.currencies || [...new Set([...workspaceCurrencies(req.auth.workspace.settings),b.currency])],timezone:b.timezone},req.auth.workspace.id])).rows[0]);
});
app.get('/api/settings/audit',requireAdmin,async(req,res)=>res.json(await tx(req,async c=>(await c.query("SELECT a.*,coalesce(u.name,'Service account: '||s.name) AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN service_accounts s ON s.tenant_id=a.tenant_id AND s.id=a.service_account_id ORDER BY a.created_at DESC LIMIT 100")).rows)));
app.use('/api/finance',financeRouter);
app.use('/api/record-tools',recordToolsRouter);
app.use('/api/record-lists',recordListsRouter);
app.use('/api/automation',automationRouter);
app.use('/api/outreach',outreachRouter);
app.use('/api',(req,res)=>res.status(404).json({error:{message:'This endpoint does not exist.',request_id:req.requestId}}));
if(existsSync('dist/index.html')) {
  app.get('/',(req,res)=>{
    const domain=process.env.APP_DOMAIN || 'localhost';
    const website=req.hostname!==`app.${domain}` && !slugFromHost(req.hostname);
    res.sendFile(path.resolve(website && existsSync('dist/site/index.html')?'dist/site/index.html':'dist/index.html'));
  });
  for(const page of websitePages.filter(p=>p.path!=='/'))app.get(page.path,(req,res)=>res.sendFile(path.resolve(`dist/site${page.path}/index.html`)));
  app.use(express.static(path.resolve('dist'),{index:false}));
  app.get(/^\/(login|signup|forgot-password|reset-password|invite|crm|sales|finance|outreach|calendar|book|booking|automation|settings|sa|reseller)(\/.*)?$/,(req,res)=>{if(/^\/(sa|reseller)(?:\/|$)/.test(req.path))res.set('X-Robots-Tag','noindex, nofollow');res.sendFile(path.resolve('dist/index.html'));});
  app.use((req,res)=>{
    const domain=process.env.APP_DOMAIN || 'localhost';
    const workspaceHost=req.hostname.endsWith(`.${domain}`) && req.hostname!==`www.${domain}`;
    res.status(404).type('html').send(renderNotFound({workspaceHost}));
  });
}
app.use((error,req,res,next)=>{
  if(error.code==='RATE_LIMIT_UNAVAILABLE')res.set('Retry-After','5');
  if(error instanceof z.ZodError) return res.status(400).json({error:{message:error.issues.map(i=>i.message).join(' '),request_id:req.requestId}});
  const commercialLimit=['DK001','DK003'].includes(error.code),capabilityDenied=error.code==='DK002';
  const concurrent=['40P01','40001'].includes(error.code);
  const status=error.status || (capabilityDenied?403:commercialLimit?409:concurrent || error.code==='23505'?409:error.code==='23503'?400:500);
  const organizationDuplicate=['workspace_teams_name','workspace_locations_name'].includes(error.constraint);
  const message=organizationDuplicate?`A ${error.constraint==='workspace_teams_name'?'team':'location'} with this name already exists. Choose another name.`:concurrent?'Another change overlapped this action. Refresh and review before trying again.':error.code==='23505'?(error.constraint==='record_lists_name'?'A smart list with this name already exists for this object. Choose another name.':'This email, address, or key is already in use.'):error.code==='23503'?'The related record does not exist or is still in use.':status>=500 && !(error instanceof AppError)?'Something went wrong. Try again.':error.message;
  if(status>=500) console.error(JSON.stringify({request_id:req.requestId,error:error.message}));
  res.status(status).json({error:{message,request_id:req.requestId}});
});
const server=app.listen(Number(process.env.PORT || 4000),'127.0.0.1',()=>console.log('DryKraft API ready on port '+(process.env.PORT || 4000)));
let closing=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  if(closing)return;closing=true;
  const deadline=setTimeout(()=>{console.error('API shutdown exceeded 25 seconds.');process.exit(1);},25000);deadline.unref();
  server.close(async error=>{
    try{if(error)throw error;await pool.end();await platformPool?.end();await resellerApiPool?.end();await resellerPool?.end();await redis.quit();clearTimeout(deadline);process.exit(0);}
    catch{console.error('API shutdown could not complete.');process.exit(1);}
  });
});
