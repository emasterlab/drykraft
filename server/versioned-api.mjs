import { Router } from 'express';
import { z } from 'zod';
import { pool,tenantTransaction } from './db.mjs';
import { AppError,keySchema,saveRecord,deleteRecord,resolveRecord,addActivity,dealStageHistory } from './model.mjs';
import { tokenHash,slugFromHost } from './auth.mjs';
import { capPermissions } from './developer-access.mjs';
import { listRecords } from './record-lists.mjs';
import { requireBillingAccess } from './billing.mjs';
import {consumeRateLimit} from './rate-limits.mjs';

export const versionedApiRouter=Router();
let redis;
export function configureVersionedApi(client){redis=client;}
export async function apiTransaction(credential,action) {
 return tenantTransaction(credential.tenant_id,async c=>{
  const found=(await c.query('SELECT service_account_id FROM api_keys WHERE id=$1 AND token_hash=$2',[credential.id,credential.hash])).rows[0];
  if(!found)throw new AppError(401,'API key is invalid, expired, revoked or disabled.');
  // Shared locks stay until the business transaction commits; disable/revoke waits for in-flight work.
  const account=(await c.query('SELECT * FROM service_accounts WHERE id=$1 FOR SHARE',[found.service_account_id])).rows[0];
  const key=(await c.query('SELECT * FROM api_keys WHERE id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[credential.id,credential.hash])).rows[0];
  if(!account || account.purpose!=='integration' || account.disabled || !key)throw new AppError(401,'API key is invalid, expired, revoked or disabled.');
  await c.query("SELECT set_config('app.service_account_id',$1,true)",[account.id]);
  const principal={account,key,permissions:capPermissions(key.permissions,account.permissions)};
  c.apiPrincipal=principal;
  return action(c,principal);
 });
}
versionedApiRouter.use(async(req,res,next)=>{
 res.set('Cache-Control','no-store');
 const match=/^Bearer (dk_v1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization || '');
 if(!match)throw new AppError(401,'Use an API key in the Authorization: Bearer header.');
 const hash=tokenHash(match[1]),found=(await pool.query('SELECT * FROM resolve_api_key($1)',[hash])).rows[0];
 if(!found)throw new AppError(401,'API key is invalid, expired, revoked or disabled.');
 const credential={...found,hash};req.apiCredential=credential;
 await apiTransaction(credential,async(c,{account,key})=>{
  const workspace=(await c.query('SELECT id,slug FROM workspaces WHERE id=$1',[found.tenant_id])).rows[0],slug=slugFromHost(req.hostname);
  if(!workspace || slug&&workspace.slug!==slug || req.headers['x-workspace-id']&&req.headers['x-workspace-id']!==workspace.id)throw new AppError(403,'This API key belongs to another workspace.');
  req.apiAccountId=account.id;req.apiKeyId=key.id;
  await c.query("INSERT INTO usage_ledger(tenant_id,id,metric,amount,reference_id) VALUES($1,$2,'api_requests',1,$2) ON CONFLICT DO NOTHING",[found.tenant_id,req.requestId]);
 });
 let recorded=false;
 const log=()=>{
  if(recorded)return;recorded=true;
  // No bodies, query strings, raw URLs, addresses or authorization values enter request history.
  void tenantTransaction(found.tenant_id,c=>c.query('INSERT INTO api_request_logs(tenant_id,id,service_account_id,key_id,operation,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[found.tenant_id,req.requestId,req.apiAccountId,req.apiKeyId,req.apiOperation || 'unmatched',res.writableFinished?res.statusCode:499])).catch(error=>console.error('API request history write failed:',error.code || 'unavailable'));
 };
 res.once('finish',log);res.once('close',log);
 const allowance=await consumeRateLimit(redis,`developer-api:${found.tenant_id}:${found.id}`,60000);
 if(allowance.totalHits>120){res.set('Retry-After',String(Math.max(1,Math.ceil((allowance.resetTime-Date.now())/1000))));throw new AppError(429,'This API key reached 120 requests per minute. Wait a minute before retrying.');}
 next();
});
function authorize(principal,key,action) {
 if(!Object.hasOwn(principal.permissions,key) || !principal.permissions[key].includes(action))throw new AppError(403,`This API key does not allow ${action} access to this object.`);
}
const resources={contacts:'people',companies:'companies',leads:'leads',opportunities:'deals',tasks:'tasks'};
function objectKey(req) {
 if(req.params.key)return keySchema.parse(req.params.key);
 if(!Object.hasOwn(resources,req.params.resource))throw new AppError(404,'API resource not found.');return resources[req.params.resource];
}
function operation(req,verb,suffix=''){req.apiOperation=`${verb} /api/v1/${req.params.key?'records/:key':':resource'}${suffix}`;}
async function mutate(req,key,action,input,fn) {
 const id=z.string().uuid().parse(req.headers['idempotency-key']);
 const payload=tokenHash(JSON.stringify([req.method,req.path,input]));
 return apiTransaction(req.apiCredential,async(c,p)=>{
  authorize(p,key,action);await requireBillingAccess(c,req.apiCredential.tenant_id);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`api:${req.apiCredential.tenant_id}:${p.account.id}:${id}`]);
  const previous=(await c.query('SELECT * FROM api_mutations WHERE service_account_id=$1 AND id=$2',[p.account.id,id])).rows[0];
  if(previous){if(previous.payload_hash!==payload)throw new AppError(409,'This Idempotency-Key was used for a different request.');return {status:previous.status,result:previous.result,replayed:true};}
  const result=await fn(c),status=action==='create' || action==='note'?201:200;
  await c.query('INSERT INTO api_mutations(tenant_id,id,service_account_id,payload_hash,status,result) VALUES($1,$2,$3,$4,$5,$6)',[req.apiCredential.tenant_id,id,p.account.id,payload,status,result]);return {status,result,replayed:false};
 });
}
function reply(res,value){res.set('Idempotency-Replayed',String(value.replayed));res.status(value.status).json(value.result);}
versionedApiRouter.get('/me',async(req,res)=>{
 req.apiOperation='GET /api/v1/me';res.json(await apiTransaction(req.apiCredential,async(c,p)=>({workspace_id:req.apiCredential.tenant_id,service_account:{id:p.account.id,name:p.account.name},key_id:p.key.id,permissions:p.permissions,expires_at:p.key.expires_at})));
});
versionedApiRouter.get('/objects',async(req,res)=>{
 req.apiOperation='GET /api/v1/objects';res.json(await apiTransaction(req.apiCredential,async(c,p)=>(await c.query('SELECT key,name,singular_name,fields,built_in FROM object_definitions WHERE key=ANY($1::text[]) ORDER BY key',[Object.keys(p.permissions)])).rows));
});
const collections=['/records/:key','/:resource'],items=['/records/:key/:id','/:resource/:id'],notes=['/records/:key/:id/activities','/:resource/:id/activities'];
versionedApiRouter.get(collections,async(req,res)=>{
 const key=objectKey(req);operation(req,'GET');res.json(await apiTransaction(req.apiCredential,async(c,p)=>{authorize(p,key,'read');return listRecords(c,key,req.query);}));
});
versionedApiRouter.get(items,async(req,res)=>{
 const key=objectKey(req),id=z.string().uuid().parse(req.params.id);operation(req,'GET','/:id');res.json(await apiTransaction(req.apiCredential,async(c,p)=>{authorize(p,key,'read');return resolveRecord(c,id,key);}));
});
versionedApiRouter.post(collections,async(req,res)=>{
 const key=objectKey(req),b=z.object({data:z.record(z.string(),z.unknown()),sales_data:z.record(z.string(),z.unknown()).optional()}).strict().parse(req.body);if(b.sales_data && key!=='leads')throw new AppError(400,'Sales details are available only when creating a lead.');operation(req,'POST');reply(res,await mutate(req,key,'create',b,c=>saveRecord(c,req.apiCredential.tenant_id,null,key,b.data,null,null,null,{dealValues:b.sales_data})));
});
versionedApiRouter.patch(items,async(req,res)=>{
 const key=objectKey(req),id=z.string().uuid().parse(req.params.id),b=z.object({data:z.record(z.string(),z.unknown()),version:z.number().int().positive()}).strict().parse(req.body);operation(req,'PATCH','/:id');
 reply(res,await mutate(req,key,'update',b,async c=>{
  const old=(await c.query('SELECT * FROM records WHERE id=$1 AND object_key=$2 FOR UPDATE',[id,key])).rows[0];if(!old)throw new AppError(404,'Record not found in this workspace.');
  return saveRecord(c,req.apiCredential.tenant_id,null,key,{...old.data,...b.data},id,b.version);
 }));
});
versionedApiRouter.delete(items,async(req,res)=>{
 const key=objectKey(req),id=z.string().uuid().parse(req.params.id),b=z.object({version:z.number().int().positive()}).strict().parse(req.body);operation(req,'DELETE','/:id');
 reply(res,await mutate(req,key,'delete',b,async c=>{await deleteRecord(c,req.apiCredential.tenant_id,null,key,id,b.version);return {ok:true};}));
});
versionedApiRouter.get(notes,async(req,res)=>{
 const key=objectKey(req),id=z.string().uuid().parse(req.params.id),cursor=req.query.cursor?z.string().uuid().parse(req.query.cursor):null;operation(req,'GET','/:id/activities');
 res.json(await apiTransaction(req.apiCredential,async(c,p)=>{
  authorize(p,key,'read');const record=await resolveRecord(c,id,key);
  const after=cursor?(await c.query('SELECT created_at::text AS time FROM activities WHERE record_id=$1 AND id=$2',[record.id,cursor])).rows[0]?.time:null;if(cursor&&!after)throw new AppError(400,'This activity page changed. Refresh the list.');
  const rows=(await c.query('SELECT id,record_id,actor_id,service_account_id,type,body,created_at FROM activities WHERE record_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 26',[record.id,after,cursor])).rows;
  return {items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null};
 }));
});
versionedApiRouter.post(notes,async(req,res)=>{
 const key=objectKey(req),id=z.string().uuid().parse(req.params.id),b=z.object({body:z.string().trim().min(1).max(10000)}).strict().parse(req.body);operation(req,'POST','/:id/activities');
 reply(res,await mutate(req,key,'note',b,async c=>{await resolveRecord(c,id,key);return addActivity(c,req.apiCredential.tenant_id,null,{record_id:id,body:b.body,type:'note'});}));
});
const stageHistories=['/records/:key/:id/stage-history','/:resource/:id/stage-history'];
versionedApiRouter.get(stageHistories,async(req,res)=>{
 const key=objectKey(req);operation(req,'GET','/:id/stage-history');
 res.json(await apiTransaction(req.apiCredential,async(c,p)=>{authorize(p,key,'read');if(key!=='deals')throw new AppError(404,'Stage history is available only for deals.');return dealStageHistory(c,req.params.id,req.query.cursor || null);}));
});
versionedApiRouter.use((req,res,next)=>next(new AppError(404,'Versioned API route not found.')));
