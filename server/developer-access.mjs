import { Router } from 'express';
import { z } from 'zod';
import { randomUUID,randomBytes } from 'node:crypto';
import { tenantTransaction,event } from './db.mjs';
import { AppError,keySchema,getDefinition } from './model.mjs';
import { requireAdmin,tokenHash,checkPassword } from './auth.mjs';
import {consumeRateLimit} from './rate-limits.mjs';

export const permissionsSchema=z.record(keySchema,z.array(z.enum(['read','create','update','delete','note'])).min(1).max(5)).superRefine((value,ctx)=>{
 if(!Object.keys(value).length || Object.keys(value).length>100)ctx.addIssue({code:'custom',message:'Choose permissions for 1 to 100 current objects.'});
 for(const [key,actions]of Object.entries(value))if(new Set(actions).size!==actions.length || !actions.includes('read') || ['invoices','expenses'].includes(key)&&actions.some(a=>!['read','note'].includes(a)))ctx.addIssue({code:'custom',message:'Include Read once for each object. Financial objects support only Read and Add notes here.'});
});
export const capPermissions=(requested,ceiling)=>Object.fromEntries(Object.entries(requested).flatMap(([key,actions])=>{
 const allowed=Object.hasOwn(ceiling,key)?actions.filter(a=>ceiling[key].includes(a)):[];return allowed.includes('read')?[[key,allowed]]:[];
}));
const name=z.string().trim().min(2).max(100),version=z.number().int().positive(),password=z.string().min(10).max(128);
let redis;
export function configureDeveloperAccess(client){redis=client;}
const normalize=permissions=>Object.fromEntries(Object.entries(permissions).sort(([a],[b])=>a.localeCompare(b)).map(([key,actions])=>[key,[...actions].sort()]));
const workflowPermissions=z.record(keySchema,z.array(z.enum(['read','create','update','delete','note'])).min(1).max(5)).superRefine((value,ctx)=>{
 for(const actions of Object.values(value))if(!actions.includes('read') || new Set(actions).size!==actions.length)ctx.addIssue({code:'custom',message:'Include Read once for each permitted object.'});
});
async function workflowAccount(c,id,lock=false){
 const item=(await c.query(`SELECT s.id,s.name,s.permissions,s.disabled,s.version,s.workflow_scope,s.created_at,s.updated_at,
  w.id AS workflow_id,w.name AS workflow_name,v.version AS workflow_version,(w.published_version_id=v.id) AS published,
  (SELECT o.id FROM outreach_campaigns o WHERE o.workflow_id=w.id LIMIT 1) AS campaign_id,
  (SELECT o.id FROM outreach_connections o WHERE o.config->>'aiWorkflowId'=w.id::text LIMIT 1) AS ai_connection_id
  FROM service_accounts s JOIN workflow_versions v ON v.tenant_id=s.tenant_id AND v.id=s.id JOIN workflows w ON w.tenant_id=v.tenant_id AND w.id=v.workflow_id
  WHERE s.id=$1 AND s.purpose='workflow' ${lock?'FOR UPDATE OF s':''}`,[z.uuid().parse(id)])).rows[0];
 if(!item)throw new AppError(404,'Workflow access not found in this workspace.');return item;
}
async function workflowResources(c,s){
 const resources={};
 for(const [key,table]of [['credentials','credentials'],['calendars','calendars'],['connections','outreach_connections']]){
  const ids=s.workflow_scope[key] || [],names=new Map((await c.query(`SELECT id,name FROM ${table} WHERE id=ANY($1::uuid[])`,[ids])).rows.map(r=>[r.id,r.name]));
  resources[key]=ids.map(id=>({id,name:names.get(id) || 'Saved resource unavailable'}));
 }
 return resources;
}
async function validatePermissions(c,permissions){for(const key of Object.keys(permissions))await getDefinition(c,key);}
const publicKey=k=>({id:k.id,service_account_id:k.service_account_id,name:k.name,prefix:k.prefix,permissions:k.permissions,expires_at:k.expires_at,revoked_at:k.revoked_at,version:k.version,rotated_from:k.rotated_from,created_at:k.created_at});
export async function developerTransaction(req,fn) {
 return tenantTransaction(req.auth.workspace.id,async c=>{
  // Workspace first matches invitation issuance; the user lock also serializes approval with password changes.
  await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[req.auth.workspace.id]);
  const user=(await c.query('SELECT id,password_hash FROM users WHERE id=$1 FOR SHARE',[req.auth.user.id])).rows[0];
  const role=(await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[req.auth.workspace.id,req.auth.user.id])).rows[0]?.role;
  const current=(await c.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',[tokenHash(req.cookies.drykraft_session || ''),req.auth.user.id])).rowCount;
  if(!user || !current)throw new AppError(401,'Your session expired. Sign in again.');
  if(!['owner','admin'].includes(role))throw new AppError(403,'Workspace administrator access is required.');
  const approve=async value=>{
   const attempts=await consumeRateLimit(redis,`developer-approval:${user.id}`,900000);
   if(attempts.totalHits>30){req.res.set('Retry-After',String(Math.max(1,Math.ceil((attempts.resetTime-Date.now())/1000))));throw new AppError(429,'Too many access approval attempts. Wait 15 minutes before trying again.');}
   if(!value || !await checkPassword(value,user.password_hash))throw new AppError(400,'Enter your current password to approve this access.');
  };
  return fn(c,approve);
 });
}
async function account(c,id,expected=null) {
 const s=(await c.query("SELECT * FROM service_accounts WHERE id=$1 AND purpose='integration' FOR UPDATE",[z.string().uuid().parse(id)])).rows[0];
 if(!s)throw new AppError(404,'Service account not found in this workspace.');
 if(expected!==null && s.version!==expected)throw new AppError(409,'This service account changed. Refresh before trying again.');return s;
}
async function activeLimit(c) {
 if((await c.query("SELECT count(*)::int AS n FROM service_accounts WHERE purpose='integration' AND NOT disabled")).rows[0].n>=100)throw new AppError(400,'This workspace has 100 active service accounts. Disable an unused account first.');
}
export const developerRouter=Router();
developerRouter.use(requireAdmin,(req,res,next)=>{res.set('Cache-Control','no-store');next();});
developerRouter.get('/workflows',async(req,res)=>res.json(await developerTransaction(req,async c=>{
 const cursor=req.query.cursor?z.uuid().parse(req.query.cursor):null;
 const after=cursor?(await c.query("SELECT created_at::text AS time FROM service_accounts WHERE id=$1 AND purpose='workflow'",[cursor])).rows[0]?.time:null;
 if(cursor&&!after)throw new AppError(400,'This workflow access page changed. Refresh the list.');
 const rows=(await c.query(`SELECT s.id,s.name,s.disabled,s.version,s.created_at,w.name AS workflow_name,v.version AS workflow_version,
  (w.published_version_id=v.id) AS published,(SELECT count(*)::int FROM jsonb_object_keys(s.permissions)) AS object_count
  FROM service_accounts s JOIN workflow_versions v ON v.tenant_id=s.tenant_id AND v.id=s.id JOIN workflows w ON w.tenant_id=v.tenant_id AND w.id=v.workflow_id
  WHERE s.purpose='workflow' AND ($1::timestamptz IS NULL OR (s.created_at,s.id)<($1,$2::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT 26`,[after,cursor])).rows;
 return {accounts:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null};
})));
developerRouter.get('/workflows/:id',async(req,res)=>res.json(await developerTransaction(req,async c=>{const account=await workflowAccount(c,req.params.id);return {account,resources:await workflowResources(c,account)};})));
developerRouter.put('/workflows/:id',async(req,res)=>{
 const b=z.object({version,disabled:z.boolean(),permissions:workflowPermissions.optional(),password:password.optional()}).strict().parse(req.body);
 res.json(await developerTransaction(req,async(c,approve)=>{
  const s=await workflowAccount(c,req.params.id,true);if(s.version!==b.version)throw new AppError(409,'Workflow access changed. Refresh saved settings before trying again.');
  const permissions=b.permissions ?? s.permissions,ceiling=s.workflow_scope.permissions;
  if(JSON.stringify(normalize(capPermissions(permissions,ceiling)))!==JSON.stringify(normalize(permissions)))throw new AppError(400,'Access must fit within this published version’s original permissions. Publish a reviewed version for different actions.');
  const expanded=Object.entries(permissions).some(([key,actions])=>!Object.hasOwn(s.permissions,key) || actions.some(a=>!s.permissions[key].includes(a)));
  if(expanded || s.disabled&&!b.disabled)await approve(b.password);
  await c.query('UPDATE service_accounts SET permissions=$1,disabled=$2,version=version+1,updated_at=now() WHERE id=$3',[permissions,b.disabled,s.id]);
  await event(c,req.auth.workspace.id,req.auth.user.id,'automation.workflow.access_updated','service_account',s.id,{identity_id:s.id,workflow_id:s.workflow_id,workflow_version:s.workflow_version,disabled:b.disabled});
  return workflowAccount(c,s.id);
 }));
});
developerRouter.get('/accounts',async(req,res)=>res.json(await developerTransaction(req,async c=>{
 const cursor=req.query.cursor?z.string().uuid().parse(req.query.cursor):null;
 const after=cursor?(await c.query("SELECT created_at::text AS time FROM service_accounts WHERE id=$1 AND purpose='integration'",[cursor])).rows[0]?.time:null;
 if(cursor&&!after)throw new AppError(400,'This account page changed. Refresh the list.');
 const rows=(await c.query("SELECT id,name,permissions,disabled,version,created_at,updated_at FROM service_accounts WHERE purpose='integration' AND ($1::timestamptz IS NULL OR (created_at,id)<($1,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 26",[after,cursor])).rows;
 return {accounts:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null};
})));
developerRouter.post('/accounts',async(req,res)=>{
 const b=z.object({id:z.string().uuid(),name,permissions:permissionsSchema,password}).strict().parse(req.body);
 const result=await developerTransaction(req,async(c,approve)=>{
  await approve(b.password);await validatePermissions(c,b.permissions);
  const prior=(await c.query('SELECT * FROM service_accounts WHERE id=$1',[b.id])).rows[0];
  if(prior){if(prior.purpose!=='integration' || prior.name!==b.name || JSON.stringify(normalize(prior.permissions))!==JSON.stringify(normalize(b.permissions)))throw new AppError(409,'This account reference already exists with different settings.');return {item:prior,created:false};}
  await activeLimit(c);
  const item=(await c.query('INSERT INTO service_accounts(tenant_id,id,name,permissions,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.auth.workspace.id,b.id,b.name,b.permissions,req.auth.user.id])).rows[0];
  await event(c,req.auth.workspace.id,req.auth.user.id,'developer.service_account.created','service_account',b.id,{id:b.id,name:b.name});return {item,created:true};
 });res.status(result.created?201:200).json(result.item);
});
developerRouter.put('/accounts/:id',async(req,res)=>{
 const b=z.object({name,permissions:permissionsSchema,disabled:z.boolean(),version,password:password.optional()}).strict().parse(req.body);
 res.json(await developerTransaction(req,async(c,approve)=>{
  const s=await account(c,req.params.id,b.version);await validatePermissions(c,b.permissions);
  const expanded=Object.entries(b.permissions).some(([key,actions])=>!Object.hasOwn(s.permissions,key) || actions.some(a=>!s.permissions[key].includes(a)));
  if(expanded || s.disabled&&!b.disabled)await approve(b.password);
  if(s.disabled&&!b.disabled)await activeLimit(c);
  // Reductions permanently narrow existing keys; a later account expansion cannot silently restore their old access.
  for(const k of (await c.query('SELECT * FROM api_keys WHERE service_account_id=$1 AND revoked_at IS NULL ORDER BY id FOR UPDATE',[s.id])).rows) {
   const permissions=capPermissions(k.permissions,b.permissions);
   if(JSON.stringify(normalize(permissions))!==JSON.stringify(normalize(k.permissions)))await c.query('UPDATE api_keys SET permissions=$1,revoked_at=CASE WHEN $2 THEN now() ELSE revoked_at END,version=version+1 WHERE id=$3',[permissions,!Object.keys(permissions).length,k.id]);
  }
  const item=(await c.query('UPDATE service_accounts SET name=$1,permissions=$2,disabled=$3,version=version+1,updated_at=now() WHERE id=$4 RETURNING *',[b.name,b.permissions,b.disabled,s.id])).rows[0];
  await event(c,req.auth.workspace.id,req.auth.user.id,'developer.service_account.updated','service_account',s.id,{id:s.id,name:item.name,disabled:item.disabled});return item;
 }));
});
developerRouter.get('/accounts/:id/keys',async(req,res)=>res.json(await developerTransaction(req,async c=>{
 const s=await account(c,req.params.id),cursor=req.query.cursor?z.string().uuid().parse(req.query.cursor):null;
 const after=cursor?(await c.query('SELECT created_at::text AS time FROM api_keys WHERE id=$1 AND service_account_id=$2',[cursor,s.id])).rows[0]?.time:null;if(cursor&&!after)throw new AppError(400,'This key page changed. Refresh the list.');
 const rows=(await c.query('SELECT * FROM api_keys WHERE service_account_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 26',[s.id,after,cursor])).rows;
 return {account:s,keys:rows.slice(0,25).map(publicKey),next_cursor:rows.length>25?rows[24].id:null};
})));
const keyInput=z.object({id:z.string().uuid(),name,permissions:permissionsSchema,days:z.number().int().min(1).max(365),account_version:version,password}).strict();
async function issueKey(c,req,s,b,rotatedFrom=null) {
 if(s.disabled)throw new AppError(409,'This service account is disabled.');
 const permissions=capPermissions(b.permissions,s.permissions);
 if(JSON.stringify(normalize(permissions))!==JSON.stringify(normalize(b.permissions)))throw new AppError(400,'Key permissions must fit within this service account’s current permissions.');
 const payload=tokenHash(JSON.stringify([s.id,b.name,normalize(b.permissions),b.days,rotatedFrom]));
 const previous=(await c.query('SELECT * FROM api_keys WHERE id=$1',[b.id])).rows[0];
 if(previous){if(previous.payload_hash!==payload)throw new AppError(409,'This key reference was used for different settings.');return {key:publicKey(previous),secret:null};}
 if(s.version!==b.account_version)throw new AppError(409,'This service account changed. Refresh before creating a key.');
 if((await c.query('SELECT count(*)::int AS n FROM api_keys WHERE service_account_id=$1 AND revoked_at IS NULL AND expires_at>now()',[s.id])).rows[0].n>=10 && !rotatedFrom)throw new AppError(400,'This account has 10 active keys. Revoke an unused key first.');
 const secret=`dk_v1_${b.id}_${randomBytes(32).toString('base64url')}`,prefix=`dk_v1_${b.id.slice(0,8)}`;
 const key=(await c.query("INSERT INTO api_keys(tenant_id,id,service_account_id,name,token_hash,prefix,permissions,payload_hash,expires_at,created_by,rotated_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 day',$10,$11) RETURNING *",[req.auth.workspace.id,b.id,s.id,b.name,tokenHash(secret),prefix,permissions,payload,b.days,req.auth.user.id,rotatedFrom])).rows[0];
 await event(c,req.auth.workspace.id,req.auth.user.id,'developer.api_key.created','api_key',key.id,{id:key.id,serviceAccountId:s.id});return {key:publicKey(key),secret};
}
developerRouter.post('/accounts/:id/keys',async(req,res)=>{
 const b=keyInput.parse(req.body),result=await developerTransaction(req,async(c,approve)=>{await approve(b.password);const s=await account(c,req.params.id);return issueKey(c,req,s,b);});res.status(result.secret?201:200).json(result);
});
developerRouter.post('/accounts/:id/keys/:keyId/rotate',async(req,res)=>{
 const b=z.object({id:z.string().uuid(),version,account_version:version,days:z.number().int().min(1).max(365),password}).strict().parse(req.body);
 const result=await developerTransaction(req,async(c,approve)=>{
  await approve(b.password);const s=await account(c,req.params.id),keyId=z.string().uuid().parse(req.params.keyId);
  const old=(await c.query('SELECT * FROM api_keys WHERE id=$1 AND service_account_id=$2 FOR UPDATE',[keyId,s.id])).rows[0];if(!old)throw new AppError(404,'API key not found in this workspace.');
  const previous=(await c.query('SELECT * FROM api_keys WHERE id=$1',[b.id])).rows[0];
  if(previous){const hash=tokenHash(JSON.stringify([s.id,old.name,normalize(previous.permissions),b.days,old.id]));if(previous.rotated_from!==old.id || previous.payload_hash!==hash)throw new AppError(409,'This rotation reference was used for different settings.');return {key:publicKey(previous),secret:null};}
  if(old.revoked_at || old.version!==b.version)throw new AppError(409,'This key changed or was revoked. Refresh the list.');
  const permissions=capPermissions(old.permissions,s.permissions);if(!Object.keys(permissions).length)throw new AppError(400,'Choose a new key with current service-account permissions.');
  const result=await issueKey(c,req,s,{...b,name:old.name,permissions},old.id);
  await c.query('UPDATE api_keys SET revoked_at=now(),version=version+1 WHERE id=$1',[old.id]);
  await event(c,req.auth.workspace.id,req.auth.user.id,'developer.api_key.rotated','api_key',old.id,{id:old.id,replacementId:result.key.id,serviceAccountId:s.id});return result;
 });res.status(result.secret?201:200).json(result);
});
developerRouter.post('/accounts/:id/keys/:keyId/revoke',async(req,res)=>{
 const b=z.object({version}).strict().parse(req.body);res.json(await developerTransaction(req,async c=>{
  const s=await account(c,req.params.id),id=z.string().uuid().parse(req.params.keyId);
  const old=(await c.query('SELECT * FROM api_keys WHERE id=$1 AND service_account_id=$2 FOR UPDATE',[id,s.id])).rows[0];if(!old)throw new AppError(404,'API key not found in this workspace.');
  if(old.revoked_at)return publicKey(old);if(old.version!==b.version)throw new AppError(409,'This key changed. Refresh the list.');
  const key=(await c.query('UPDATE api_keys SET revoked_at=now(),version=version+1 WHERE id=$1 RETURNING *',[id])).rows[0];await event(c,req.auth.workspace.id,req.auth.user.id,'developer.api_key.revoked','api_key',id,{id,serviceAccountId:s.id});return publicKey(key);
 }));
});
developerRouter.get('/requests',async(req,res)=>res.json(await developerTransaction(req,async c=>{
 const cursor=req.query.cursor?z.string().uuid().parse(req.query.cursor):null;
 const after=cursor?(await c.query('SELECT created_at::text AS time FROM api_request_logs WHERE id=$1',[cursor])).rows[0]?.time:null;
 if(cursor&&!after)throw new AppError(400,'This request page changed. Refresh the list.');
 const rows=(await c.query('SELECT l.*,s.name AS account_name,k.name AS key_name FROM api_request_logs l JOIN service_accounts s ON s.tenant_id=l.tenant_id AND s.id=l.service_account_id JOIN api_keys k ON k.tenant_id=l.tenant_id AND k.id=l.key_id WHERE ($1::timestamptz IS NULL OR (l.created_at,l.id)<($1,$2::uuid)) ORDER BY l.created_at DESC,l.id DESC LIMIT 26',[after,cursor])).rows;
 return {items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null};
})));
