import {Router} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './model.mjs';
import {hashPassword} from './auth.mjs';
import {platformHost,mountPlatformAuth,authorizedPlatform,platformAccount,platformAudit} from './platform-auth.mjs';
import {platformTransaction} from './platform-db.mjs';
import {mountPlatformCustomers} from './platform-customers.mjs';
import {mountPlatformCommercial} from './platform-commercial.mjs';
import {mountPlatformMail} from './platform-mail.mjs';
import {mountPlatformResellers} from './platform-resellers.mjs';

export const platformRouter=Router();
platformRouter.use(platformHost);
mountPlatformAuth(platformRouter);
mountPlatformCustomers(platformRouter);
mountPlatformCommercial(platformRouter);
mountPlatformMail(platformRouter);
mountPlatformResellers(platformRouter);
const all=['owner','admin','support','billing','viewer'],administrators=['owner','admin'];
const reason=z.string().trim().min(10).max(1000),version=z.number().int().positive(),uuid=z.string().uuid();
const pageQuery=z.object({search:z.string().trim().max(100).default(''),cursor:uuid.optional()}).strict();
const roles=z.enum(['owner','admin','support','billing','viewer']);
async function page(c,table,query){
 let after=null;if(query.cursor){after=(await c.query(`SELECT created_at::text AS at FROM ${table} WHERE id=$1`,[query.cursor])).rows[0]?.at;if(!after)throw new AppError(400,'This page is unavailable. Return to the first page.');}
 return [query.search.toLowerCase(),after,query.cursor||null];
}
function paginated(rows){return {items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null};}
async function workspace(c,id){
 const w=(await c.query(`SELECT w.id,w.name,w.slug,w.created_at,coalesce(p.suspended,false) AS suspended,platform_workspace_suspended(w.id) AS access_suspended,coalesce(p.version,1) AS version,coalesce(p.reason,'') AS suspension_reason,p.updated_at,(SELECT count(*)::int FROM memberships WHERE tenant_id=w.id) AS members FROM workspaces w LEFT JOIN platform_workspace_controls p ON p.tenant_id=w.id WHERE w.id=$1`,[id])).rows[0];
 if(!w)throw new AppError(404,'This workspace could not be found.');return w;
}
platformRouter.get('/overview',async(req,res)=>res.json(await authorizedPlatform(req,all,async c=>{
 const w=(await c.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE coalesce(p.suspended,false))::int AS suspended FROM workspaces w LEFT JOIN platform_workspace_controls p ON p.tenant_id=w.id')).rows[0];
 const users=(await c.query('SELECT count(*)::int AS total FROM users')).rows[0].total;
 const b=(await c.query("SELECT count(*) FILTER(WHERE status='active' AND next_billing_date>now())::int AS active_subscriptions,count(*) FILTER(WHERE trial_ends_at>now() AND coalesce(status,'')<>'active')::int AS trial_workspaces FROM workspace_billing")).rows[0];
 return {workspaces:w.total,suspended_workspaces:w.suspended,users,...b};
})));
platformRouter.get('/workspaces',async(req,res)=>{
 const q=pageQuery.extend({status:z.enum(['all','active','suspended']).default('all')}).parse(req.query);
 res.json(await authorizedPlatform(req,all,async c=>{
  const args=await page(c,'workspaces',q);args.push(q.status);
  const rows=(await c.query(`SELECT w.id,w.name,w.slug,w.created_at,coalesce(p.suspended,false) AS suspended,platform_workspace_suspended(w.id) AS access_suspended,coalesce(p.version,1) AS version,(SELECT count(*)::int FROM memberships WHERE tenant_id=w.id) AS members,b.status AS billing_status,b.trial_ends_at FROM workspaces w LEFT JOIN platform_workspace_controls p ON p.tenant_id=w.id LEFT JOIN workspace_billing b ON b.tenant_id=w.id WHERE ($1='' OR position($1 IN lower(w.name||' '||w.slug))>0) AND ($2::timestamptz IS NULL OR (w.created_at,w.id)<($2,$3::uuid)) AND ($4='all' OR ($4='suspended')=coalesce(p.suspended,false)) ORDER BY w.created_at DESC,w.id DESC LIMIT 26`,args)).rows;
  return paginated(rows);
 }));
});
platformRouter.get('/workspaces/:id',async(req,res)=>{
 const id=uuid.parse(req.params.id);res.json(await authorizedPlatform(req,all,async c=>{
  const w=await workspace(c,id);
  const members=(await c.query('SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name,u.id LIMIT 25',[id])).rows;
  const billing=(await c.query('SELECT status,seats,trial_started_at,trial_ends_at,next_billing_date,cancel_at_next_billing_date,synced_at,billing_interval,past_due_ends_at FROM workspace_billing WHERE tenant_id=$1',[id])).rows[0]||null;
  await platformAudit(c,req,'platform.workspace.viewed','workspace',id);
  return {...w,members_preview:members,billing};
 }));
});
platformRouter.post('/workspaces/:id/state',async(req,res)=>{
 const id=uuid.parse(req.params.id),b=z.object({suspended:z.boolean(),version,reason}).strict().parse(req.body);
 res.json(await authorizedPlatform(req,administrators,async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['platform-workspace:'+id]);
  const before=await workspace(c,id);if(before.version!==b.version)throw new AppError(409,'This workspace changed. Reload its saved status before trying again.');
  if(before.suspended===b.suspended)return before;
  await c.query('INSERT INTO platform_workspace_controls(tenant_id,suspended,reason,version,updated_by,event_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET suspended=excluded.suspended,reason=excluded.reason,version=excluded.version,updated_by=excluded.updated_by,event_id=excluded.event_id,updated_at=now()',[id,b.suspended,b.reason,before.version+1,req.sa.id,randomUUID()]);
  const action=b.suspended?'platform.workspace.suspended':'platform.workspace.restored';
  await platformAudit(c,req,action,'workspace',id,b.reason,{before:before.suspended,after:b.suspended});
  await c.query('SELECT publish_platform_workspace_state($1,$2)',[id,req.sa.id]);
  return workspace(c,id);
 }));
});
platformRouter.get('/users',async(req,res)=>{
 const q=pageQuery.parse(req.query);res.json(await authorizedPlatform(req,all,async c=>{
  const args=await page(c,'users',q);
  return paginated((await c.query("SELECT u.id,u.name,u.email,u.created_at,(SELECT count(*)::int FROM memberships m WHERE m.user_id=u.id) AS workspaces FROM users u WHERE ($1='' OR position($1 IN lower(u.name||' '||u.email))>0) AND ($2::timestamptz IS NULL OR (u.created_at,u.id)<($2,$3::uuid)) ORDER BY u.created_at DESC,u.id DESC LIMIT 26",args)).rows);
 }));
});
platformRouter.get('/billing',async(req,res)=>{
 const q=pageQuery.parse(req.query);res.json(await authorizedPlatform(req,['owner','admin','billing','viewer'],async c=>{
  const args=await page(c,'workspaces',q);
  return paginated((await c.query("SELECT w.id,w.name,w.slug,w.created_at,b.status,b.seats,b.trial_ends_at,b.next_billing_date,b.cancel_at_next_billing_date,b.synced_at,b.billing_interval,b.past_due_ends_at FROM workspaces w JOIN workspace_billing b ON b.tenant_id=w.id WHERE ($1='' OR position($1 IN lower(w.name||' '||w.slug))>0) AND ($2::timestamptz IS NULL OR (w.created_at,w.id)<($2,$3::uuid)) ORDER BY w.created_at DESC,w.id DESC LIMIT 26",args)).rows);
 }));
});
platformRouter.get('/accounts',async(req,res)=>{
 const q=pageQuery.parse(req.query);res.json(await authorizedPlatform(req,['owner'],async c=>{
  const args=await page(c,'platform_accounts',q);return paginated((await c.query("SELECT id,name,email,role,disabled,version,mfa_enabled_at,created_at,password_changed_at FROM platform_accounts WHERE ($1='' OR position($1 IN lower(name||' '||email))>0) AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 26",args)).rows.map(platformAccount));
 }));
});
platformRouter.get('/accounts/:id',async(req,res)=>{
 const id=uuid.parse(req.params.id);res.json(await authorizedPlatform(req,['owner'],async c=>{
  const a=(await c.query('SELECT id,name,email,role,disabled,version,mfa_enabled_at,created_at,password_changed_at FROM platform_accounts WHERE id=$1',[id])).rows[0];
  if(!a)throw new AppError(404,'This platform account could not be found.');return platformAccount(a);
 }));
});
platformRouter.post('/accounts',async(req,res)=>{
 const b=z.object({name:z.string().trim().min(2).max(100),email:z.string().trim().toLowerCase().email().max(200),password:z.string().min(12).max(128),role:roles,reason}).strict().parse(req.body);
 const password=await hashPassword(b.password);res.status(201).json(await authorizedPlatform(req,['owner'],async c=>{
  const id=randomUUID();const a=(await c.query('INSERT INTO platform_accounts(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,disabled,version,mfa_enabled_at,created_at,password_changed_at',[id,b.name,b.email,password,b.role])).rows[0];
  await platformAudit(c,req,'platform.account.created','account',id,b.reason,{role:b.role});return platformAccount(a);
 }));
});
platformRouter.put('/accounts/:id',async(req,res)=>{
 const id=uuid.parse(req.params.id),b=z.object({name:z.string().trim().min(2).max(100),role:roles,disabled:z.boolean(),version,reason}).strict().parse(req.body);
 // Acquire the governance lock before the actor lock so two owners cannot deadlock while editing one another.
 res.json(await platformTransaction(async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('drykraft-platform-governance',0))");
  const actor=(await c.query('SELECT * FROM platform_accounts WHERE id=$1 FOR UPDATE',[req.sa.id])).rows[0];
  const session=(await c.query("SELECT 1 FROM platform_sessions WHERE token_hash=$1 AND account_id=$2 AND auth_version=$3 AND expires_at>now() AND last_seen_at>now()-interval '15 minutes'",[req.sa.session_hash,req.sa.id,actor?.auth_version])).rowCount;
  if(!session||actor?.disabled||actor?.auth_version!==req.sa.auth_version)throw new AppError(401,'Your platform access changed. Sign in again.');
  if(actor.role!=='owner')throw new AppError(403,'Only a platform owner can manage platform accounts.');
  const target=(await c.query('SELECT * FROM platform_accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!target)throw new AppError(404,'This platform account could not be found.');
  if(target.version!==b.version)throw new AppError(409,'This account changed. Reload before trying again.');
  if(target.role==='owner'&&!target.disabled&&(b.role!=='owner'||b.disabled)&&(await c.query("SELECT count(*)::int AS n FROM platform_accounts WHERE role='owner' AND disabled=false")).rows[0].n<=1)throw new AppError(409,'Keep at least one active platform owner.');
  const changed=target.role!==b.role||target.disabled!==b.disabled;
  const updated=(await c.query('UPDATE platform_accounts SET name=$2,role=$3,disabled=$4,version=version+1,auth_version=auth_version+$5 WHERE id=$1 RETURNING id,name,email,role,disabled,version,mfa_enabled_at,created_at,password_changed_at',[id,b.name,b.role,b.disabled,changed?1:0])).rows[0];
  if(changed){await c.query('DELETE FROM platform_sessions WHERE account_id=$1',[id]);await c.query('DELETE FROM platform_auth_challenges WHERE account_id=$1',[id]);}
  await platformAudit(c,req,'platform.account.updated','account',id,b.reason,{before:{role:target.role,disabled:target.disabled},after:{role:b.role,disabled:b.disabled}});return platformAccount(updated);
 }));
});
platformRouter.get('/settings',async(req,res)=>res.json(await authorizedPlatform(req,administrators,async c=>(await c.query('SELECT version,data,updated_at FROM platform_settings WHERE id=true')).rows[0])));
platformRouter.put('/settings',async(req,res)=>{
 const b=z.object({version,reason,data:z.object({signup_enabled:z.boolean(),support_email:z.string().email().max(200),maintenance_message:z.string().trim().max(300)}).strict()}).strict().parse(req.body);
 res.json(await authorizedPlatform(req,['owner'],async c=>{
  const previous=(await c.query('SELECT version,data FROM platform_settings WHERE id=true FOR UPDATE')).rows[0];if(previous.version!==b.version)throw new AppError(409,'Platform settings changed. Reload before saving.');
  const row=(await c.query('UPDATE platform_settings SET data=$1,version=version+1,updated_by=$2,updated_at=now() WHERE id=true RETURNING version,data,updated_at',[b.data,req.sa.id])).rows[0];
  await platformAudit(c,req,'platform.settings.updated','settings',null,b.reason,{before:previous.data,after:b.data});return row;
 }));
});
platformRouter.get('/audit',async(req,res)=>{
 const q=z.object({cursor:uuid.optional(),resource_id:uuid.optional(),action:z.string().max(100).optional()}).strict().parse(req.query);
 res.json(await authorizedPlatform(req,['owner','admin'],async c=>{
  const after=q.cursor?(await c.query('SELECT created_at::text AS at FROM platform_audit WHERE id=$1',[q.cursor])).rows[0]?.at:null;
  if(q.cursor&&!after)throw new AppError(400,'This audit page is unavailable. Return to the first page.');
  return paginated((await c.query('SELECT e.id,e.actor_id,a.name AS actor_name,e.action,e.resource_type,e.resource_id,e.reason,e.data,e.created_at FROM platform_audit e LEFT JOIN platform_accounts a ON a.id=e.actor_id WHERE ($1::timestamptz IS NULL OR (e.created_at,e.id)<($1,$2::uuid)) AND ($3::uuid IS NULL OR e.resource_id=$3) AND ($4::text IS NULL OR e.action=$4) ORDER BY e.created_at DESC,e.id DESC LIMIT 26',[after,q.cursor||null,q.resource_id||null,q.action||null])).rows);
 }));
});
platformRouter.use((req,res)=>res.status(404).json({error:{message:'This platform endpoint does not exist.',request_id:req.requestId}}));
