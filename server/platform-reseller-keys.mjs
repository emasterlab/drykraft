import {randomUUID,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './model.mjs';
import {tokenHash} from './auth.mjs';
import {authorizedPlatform,platformAudit} from './platform-auth.mjs';

const uuid=z.string().uuid(),reason=z.string().trim().min(10).max(1000);
export const resellerApiScopes=['reseller.customers.read','reseller.plans.read','reseller.usage.read'];
const input=z.object({name:z.string().trim().min(2).max(100),scopes:z.array(z.enum(resellerApiScopes)).min(1).max(3).refine(v=>new Set(v).size===v.length,'Choose each scope once.'),expires_at:z.string().datetime({offset:true}),request_id:uuid,reason}).strict();
const safeColumns='id,reseller_id,name,prefix,scopes,expires_at,revoked_at,version,created_by,created_at';
async function parent(c,id,actor,active=false){
 const saved=(await c.query('SELECT platform_reseller_key_parent($1,$2) AS data',[id,actor])).rows[0].data;
 if(!saved)throw new AppError(404,'This reseller could not be found.');
 if(active&&!saved.available)throw new AppError(403,'API keys require an approved reseller with an active contract.');return saved;
}
export function mountPlatformResellerKeys(router){
 router.get('/resellers/:id/api-keys',async(req,res)=>{
  const id=uuid.parse(req.params.id),q=z.object({cursor:uuid.optional()}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,['owner','admin','viewer'],async c=>{
   await parent(c,id,req.sa.id);const rows=(await c.query(`SELECT ${safeColumns} FROM reseller_api_keys WHERE reseller_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 26`,[id,q.cursor||null])).rows;
   return {items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null,available_scopes:resellerApiScopes};
  }));
 });
 router.get('/resellers/:id/api-keys/creations/:requestId',async(req,res)=>{
  const id=uuid.parse(req.params.id),requestId=uuid.parse(req.params.requestId);z.object({}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,['owner','admin'],async c=>{
   await parent(c,id,req.sa.id);
   const key=(await c.query(`SELECT ${safeColumns} FROM reseller_api_keys WHERE reseller_id=$1 AND created_by=$2 AND request_id=$3`,[id,req.sa.id,requestId])).rows[0];
   if(!key)throw new AppError(404,'No saved API key was found for this request.');
   return {key,secret:null,replayed:true};
  }));
 });
 router.get('/resellers/:id/api-keys/:keyId',async(req,res)=>{
  const id=uuid.parse(req.params.id),keyId=uuid.parse(req.params.keyId);z.object({}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,['owner','admin','viewer'],async c=>{
   await parent(c,id,req.sa.id);
   const key=(await c.query(`SELECT ${safeColumns} FROM reseller_api_keys WHERE reseller_id=$1 AND id=$2`,[id,keyId])).rows[0];
   if(!key)throw new AppError(404,'This reseller API key could not be found.');
   return key;
  }));
 });
 router.post('/resellers/:id/api-keys',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=input.parse(req.body);b.scopes.sort();
  const hash=tokenHash(JSON.stringify({reseller_id:id,...b}));
  const result=await authorizedPlatform(req,['owner','admin'],async c=>{
   await parent(c,id,req.sa.id);
   const previous=(await c.query(`SELECT ${safeColumns},input_hash FROM reseller_api_keys WHERE created_by=$1 AND request_id=$2`,[req.sa.id,b.request_id])).rows[0];
   if(previous){if(previous.input_hash!==hash)throw new AppError(409,'This request ID belongs to a different key setup. Use a new request ID.');const {input_hash,...key}=previous;return {key,secret:null,replayed:true};}
   await parent(c,id,req.sa.id,true);
   const valid=(await c.query("SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=now()+interval '90 days' AS valid",[b.expires_at])).rows[0].valid;
   if(!valid)throw new AppError(400,'Choose a future expiry within 90 days.');
   const secret='dk_res_'+randomBytes(32).toString('hex'),keyId=randomUUID();
   const key=(await c.query(`INSERT INTO reseller_api_keys(id,reseller_id,name,token_hash,prefix,scopes,expires_at,created_by,request_id,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${safeColumns}`,[keyId,id,b.name,tokenHash(secret),secret.slice(0,15),b.scopes,b.expires_at,req.sa.id,b.request_id,hash])).rows[0];
   await platformAudit(c,req,'reseller.api_key.created','reseller',id,b.reason,{key_id:keyId,name:b.name,scopes:b.scopes,expires_at:b.expires_at});
   return {key,secret,replayed:false};
  });res.status(result.replayed?200:201).json(result);
 });
 router.put('/resellers/:id/api-keys/:keyId',async(req,res)=>{
  const id=uuid.parse(req.params.id),keyId=uuid.parse(req.params.keyId),b=z.object({version:z.number().int().positive(),reason}).strict().parse(req.body);
  res.json(await authorizedPlatform(req,['owner','admin'],async c=>{
   await parent(c,id,req.sa.id);const saved=(await c.query(`SELECT ${safeColumns} FROM reseller_api_keys WHERE reseller_id=$1 AND id=$2 FOR UPDATE`,[id,keyId])).rows[0];
   if(!saved)throw new AppError(404,'This reseller API key could not be found.');
   if(saved.version!==b.version||saved.revoked_at)throw new AppError(409,'This key changed or was already revoked. Refresh its saved state.');
   const updated=(await c.query(`UPDATE reseller_api_keys SET revoked_at=now(),version=version+1 WHERE id=$1 RETURNING ${safeColumns}`,[keyId])).rows[0];
   await platformAudit(c,req,'reseller.api_key.revoked','reseller',id,b.reason,{key_id:keyId,prefix:saved.prefix});return updated;
  }));
 });
}
