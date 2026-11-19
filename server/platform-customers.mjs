import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError,builtIns,defaultStages,defaultWidgets} from './model.mjs';
import {tokenHash} from './auth.mjs';
import {currencySchema} from './currency.mjs';
import {authorizedPlatform,platformAudit} from './platform-auth.mjs';
import {encryptCredential} from './automation.mjs';
import {platformInvitationToken} from './platform-mail.mjs';

const all=['owner','admin','support','billing','viewer'],administrators=['owner','admin'];
const uuid=z.string().uuid(),reason=z.string().trim().min(10).max(1000);
const reserved=new Set(['www','app','api','admin','auth','support','mail','assets','status','demo']);
const timezone=z.string().max(80).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return /[A-Za-z]/.test(value);}catch{return false;}},'Choose a named IANA timezone.');
const provisionBody=z.object({request_id:uuid,name:z.string().trim().min(2).max(100),slug:z.string().regex(/^[a-z][a-z0-9-]{2,39}$/).refine(v=>!reserved.has(v),'This workspace address is reserved.'),owner_email:z.string().trim().toLowerCase().email().max(200),currency:currencySchema,currencies:z.array(currencySchema).min(1).max(180),timezone,reason}).strict().superRefine((b,c)=>{
 if(!b.currencies.includes(b.currency)||new Set(b.currencies).size!==b.currencies.length)c.addIssue({code:'custom',message:'Enabled currencies must be unique and include the default currency.'});
});
async function customer(c,id){const user=(await c.query('SELECT platform_customer_management($1) AS data',[id])).rows[0].data;if(!user)throw new AppError(404,'This customer account could not be found.');return user;}
const scope=id=>'platform-provision:'+id;
async function provisionResult(c,operation){
 const invite=(await c.query('SELECT id,issued_by,version,token_ciphertext,email,expires_at,accepted_at,revoked_at FROM platform_workspace_invitations WHERE id=$1',[operation.invitation_id])).rows[0];
 const pending=invite.issued_by===operation.actor_id&&!invite.accepted_at&&!invite.revoked_at&&new Date(invite.expires_at)>new Date();
 return {id:operation.tenant_id,invitation_id:operation.invitation_id,version:invite.version,owner_email:invite.email,expires_at:invite.expires_at,owner_joined:!!invite.accepted_at,invitation_token:pending?await platformInvitationToken(c,invite):null};
}
export function mountPlatformCustomers(router){
 router.get('/users/:id',async(req,res)=>{
  const id=uuid.parse(req.params.id);res.json(await authorizedPlatform(req,all,async c=>{
   const user=await customer(c,id);await platformAudit(c,req,'platform.user.viewed','user',id);return user;
  }));
 });
 router.get('/users/:id/workspaces',async(req,res)=>{
  const id=uuid.parse(req.params.id),q=z.object({cursor:uuid.optional()}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,all,async c=>{
   await customer(c,id);
   const rows=(await c.query('SELECT w.id,w.name,w.slug,m.role,coalesce(p.suspended,false) AS suspended FROM memberships m JOIN workspaces w ON w.id=m.tenant_id LEFT JOIN platform_workspace_controls p ON p.tenant_id=w.id WHERE m.user_id=$1 AND ($2::uuid IS NULL OR w.id>$2) ORDER BY w.id LIMIT 26',[id,q.cursor||null])).rows;
   return {items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null};
  }));
 });
 router.post('/users/:id/state',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({disabled:z.boolean(),version:z.number().int().positive(),reason}).strict().parse(req.body);
  res.json(await authorizedPlatform(req,administrators,async c=>{
   await customer(c,id);
   const after=(await c.query('SELECT set_platform_customer_state($1,$2,$3,$4,$5) AS data',[id,req.sa.id,b.disabled,b.version,b.reason])).rows[0].data;
   return after;
  }));
 });
 router.post('/workspaces',async(req,res)=>{
  const b=provisionBody.parse(req.body),{request_id,...input}=b,requestHash=tokenHash(JSON.stringify(input));
  const result=await authorizedPlatform(req,administrators,async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['platform-provision:'+request_id]);
   const previous=(await c.query('SELECT * FROM platform_provisioning_operations WHERE id=$1',[request_id])).rows[0];
   if(previous){if(previous.actor_id!==req.sa.id||previous.request_hash!==requestHash)throw new AppError(409,'This provisioning request has different saved details. Reload before trying again.');return {...await provisionResult(c,previous),reused:true};}
   const tenantId=randomUUID(),invitationId=randomUUID(),raw=randomBytes(32).toString('hex');
   await c.query('SELECT provision_platform_workspace($1,$2,$3,$4,$5,$6)',[req.sa.id,tenantId,invitationId,tokenHash(raw),{name:b.name,slug:b.slug,owner_email:b.owner_email,settings:{currency:b.currency,currencies:b.currencies,timezone:b.timezone}},{definitions:builtIns,stages:defaultStages,widgets:defaultWidgets}]);
   const operation=(await c.query('INSERT INTO platform_provisioning_operations(id,actor_id,request_hash,tenant_id,invitation_id,invitation_ciphertext) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[request_id,req.sa.id,requestHash,tenantId,invitationId,encryptCredential(scope(request_id),{token:raw})])).rows[0];
   await platformAudit(c,req,'platform.workspace.provisioned','workspace',tenantId,b.reason,{owner_email:b.owner_email,invitation_id:invitationId});
   return {...await provisionResult(c,operation),reused:false};
  });
  res.status(result.reused?200:201).json(result);
 });
 router.get('/workspaces/provisioning/:requestId',async(req,res)=>{
  const id=uuid.parse(req.params.requestId);res.json(await authorizedPlatform(req,administrators,async c=>{
   const operation=(await c.query('SELECT * FROM platform_provisioning_operations WHERE id=$1 AND actor_id=$2',[id,req.sa.id])).rows[0];
   if(!operation)throw new AppError(404,'This provisioning request has no saved workspace for your account.');
   await platformAudit(c,req,'platform.workspace.provisioning_result_viewed','workspace',operation.tenant_id);
   return {...await provisionResult(c,operation),reused:true};
  }));
 });
 router.get('/workspaces/:id/owner-invitation',async(req,res)=>{
  const id=uuid.parse(req.params.id);res.json(await authorizedPlatform(req,all,async c=>{
   if(!(await c.query('SELECT id FROM workspaces WHERE id=$1',[id])).rowCount)throw new AppError(404,'This workspace could not be found.');
   const invite=(await c.query('SELECT id,email,version,issued_by,expires_at,accepted_at,revoked_at,created_at FROM platform_workspace_invitations WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[id])).rows[0];
   if(!invite)return null;
   const state=(await c.query('SELECT coalesce((SELECT suspended FROM platform_workspace_controls WHERE tenant_id=$1),false) AS suspended,EXISTS(SELECT 1 FROM memberships WHERE tenant_id=$1 AND role=\'owner\') AS owned',[id])).rows[0];
   return {...invite,can_access_link:administrators.includes(req.sa.role)&&invite.issued_by===req.sa.id&&!invite.accepted_at&&!invite.revoked_at&&new Date(invite.expires_at)>new Date()&&!state.suspended&&!state.owned,can_renew:administrators.includes(req.sa.role)&&!invite.accepted_at&&!state.suspended&&!state.owned};
  }));
 });
}
