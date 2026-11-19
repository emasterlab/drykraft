import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import QRCode from 'qrcode';
import {AppError} from './model.mjs';
import {hashPassword,checkPassword,tokenHash} from './auth.mjs';
import {encryptCredential,decryptCredential} from './automation.mjs';
import {base32,matchingStep} from './mfa.mjs';
import {platformTransaction,requirePlatformDatabase} from './platform-db.mjs';
import {consumeRateLimit} from './rate-limits.mjs';

const cookieName='drykraft_sa_session';
const cookieOptions={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/api/sa'};
const hashRecovery=(id,code)=>tokenHash('platform-recovery:'+id+':'+code.toLowerCase().replaceAll('-',''));
const scope=id=>'platform-mfa:'+id;
const seal=(id,secret)=>encryptCredential(scope(id),{secret});
const unseal=(id,cipher)=>decryptCredential(scope(id),cipher).secret;
const challengeSchema=z.object({challenge:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
let redis;
export function configurePlatformAuth(client){redis=client;}
export function platformAccount(a){return {id:a.id,email:a.email,name:a.name,role:a.role,disabled:a.disabled,version:a.version,mfa_enabled:!!(a.mfa_enabled_at||a.mfa_enabled),created_at:a.created_at,password_changed_at:a.password_changed_at};}
export async function platformAudit(c,req,action,type,id,reason='',data={}){await c.query('INSERT INTO platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),req.sa?.id||null,action,type,id,reason,data,req.requestId||null]);}
async function limit(req,res,key,max=10){const r=await consumeRateLimit(redis,'platform-auth:'+key,900000);if(r.totalHits>max){res.set('Retry-After',String(Math.max(1,Math.ceil((r.resetTime-Date.now())/1000))));throw new AppError(429,'Too many platform sign-in attempts. Wait 15 minutes and try again.');}}
export function platformHost(req,res,next){
 const domain=process.env.APP_DOMAIN||'localhost';
 if(domain==='localhost'?!['localhost','127.0.0.1','[::1]'].includes(req.hostname):req.hostname!==`app.${domain}`)return next(new AppError(404,'This endpoint is unavailable on this host.'));
 res.set('Cache-Control','no-store');res.set('X-Robots-Tag','noindex, nofollow');
 if(!['GET','HEAD','OPTIONS'].includes(req.method)&&process.env.NODE_ENV==='production'){
  if(req.get('origin')!==`https://app.${domain}`||req.get('sec-fetch-site')==='cross-site')return next(new AppError(403,'Open platform administration on the main application address.'));
 }
 next();
}
async function challenge(c,raw){
 const hash=tokenHash(raw),found=(await c.query('SELECT account_id FROM platform_auth_challenges WHERE token_hash=$1',[hash])).rows[0];
 if(!found)throw new AppError(401,'This sign-in expired or was used. Sign in again.');
 const a=(await c.query('SELECT * FROM platform_accounts WHERE id=$1 FOR UPDATE',[found.account_id])).rows[0];
 const ch=(await c.query('SELECT *,expires_at>now() AS valid FROM platform_auth_challenges WHERE token_hash=$1 FOR UPDATE',[hash])).rows[0];
 if(!ch?.valid||ch.attempts>=10||a.disabled||a.auth_version!==ch.auth_version||a.password_hash!==ch.verified_password_hash)throw new AppError(401,'This sign-in expired or changed. Sign in again.');
 return {a,ch,hash};
}
async function issueSession(c,req,a){
 const raw=randomBytes(32).toString('hex');
 await c.query('DELETE FROM platform_sessions WHERE account_id=$1 AND (expires_at<=now() OR last_seen_at<=now()-interval \'15 minutes\')',[a.id]);
 await c.query("INSERT INTO platform_sessions(token_hash,account_id,auth_version,expires_at,user_agent) VALUES($1,$2,$3,now()+interval '4 hours',$4)",[tokenHash(raw),a.id,a.auth_version,(req.get('user-agent')||'').slice(0,500)]);
 return raw;
}
function cookie(res,raw){res.cookie(cookieName,raw,{...cookieOptions,maxAge:4*3600000});}
export async function authenticatePlatform(req,res,next){
 try{
  const raw=req.cookies[cookieName];if(!raw||!/^[a-f0-9]{64}$/.test(raw))throw new AppError(401,'Sign in to platform administration.');
  const hash=tokenHash(raw);
  const result=await platformTransaction(async c=>{
   const found=(await c.query('SELECT account_id FROM platform_sessions WHERE token_hash=$1',[hash])).rows[0];if(!found)throw new AppError(401,'Your platform session expired. Sign in again.');
   const a=(await c.query('SELECT * FROM platform_accounts WHERE id=$1 FOR UPDATE',[found.account_id])).rows[0];
   const s=(await c.query("UPDATE platform_sessions SET last_seen_at=now() WHERE token_hash=$1 AND auth_version=$2 AND expires_at>now() AND last_seen_at>now()-interval '15 minutes' RETURNING expires_at",[hash,a.auth_version])).rows[0];
   if(!s||a.disabled||!a.mfa_enabled_at)throw new AppError(401,'Your platform session expired or changed. Sign in again.');
   return {...platformAccount(a),auth_version:a.auth_version,session_hash:hash,expires_at:s.expires_at};
  });req.sa=result;next();
 }catch(e){next(e);}
}
export async function authorizedPlatform(req,roles,action){return platformTransaction(async c=>{
 const a=(await c.query('SELECT * FROM platform_accounts WHERE id=$1 FOR UPDATE',[req.sa.id])).rows[0];
 const s=(await c.query("SELECT 1 FROM platform_sessions WHERE token_hash=$1 AND account_id=$2 AND auth_version=$3 AND expires_at>now() AND last_seen_at>now()-interval '15 minutes'",[req.sa.session_hash,req.sa.id,a?.auth_version])).rowCount;
 if(!a||a.disabled||!a.mfa_enabled_at||a.auth_version!==req.sa.auth_version||!s)throw new AppError(401,'Your platform access changed. Sign in again.');
 if(!roles.includes(a.role))throw new AppError(403,'Your platform role cannot perform this action.');
 return action(c,a);
});}
async function proof(c,a,code){
 const step=matchingStep(unseal(a.id,a.secret_ciphertext),code,a.last_step);
 if(step!==null){await c.query('UPDATE platform_accounts SET last_step=$2 WHERE id=$1',[a.id,step]);return true;}
 if(!/^(?:[a-fA-F0-9]{5}-){3}[a-fA-F0-9]{5}$|^[a-fA-F0-9]{20}$/.test(code))return false;
 const hash=hashRecovery(a.id,code);if(!a.recovery_hashes.some(h=>timingSafeEqual(Buffer.from(h),Buffer.from(hash))))return false;
 await c.query('UPDATE platform_accounts SET recovery_hashes=array_remove(recovery_hashes,$2) WHERE id=$1',[a.id,hash]);return true;
}
export function mountPlatformAuth(router){
 router.post('/login',async(req,res)=>{
  const b=z.object({email:z.string().trim().toLowerCase().email().max(200),password:z.string().min(1).max(128)}).strict().parse(req.body);
  await limit(req,res,'ip:'+req.ip,30);await limit(req,res,'email:'+tokenHash(b.email));
  const pool=requirePlatformDatabase(),a=(await pool.query('SELECT * FROM platform_accounts WHERE email=$1',[b.email])).rows[0];
  const valid=a?await checkPassword(b.password,a.password_hash):(await hashPassword(b.password),false);
  if(!valid||a.disabled)throw new AppError(401,'Email or password is incorrect.');
  const raw=randomBytes(32).toString('hex');
  const result=await platformTransaction(async c=>{
   const current=(await c.query('SELECT * FROM platform_accounts WHERE id=$1 FOR UPDATE',[a.id])).rows[0];
   if(current.disabled||current.password_hash!==a.password_hash)throw new AppError(401,'Your sign-in details changed. Sign in again.');
   await c.query('DELETE FROM platform_auth_challenges WHERE account_id=$1',[a.id]);
   await c.query("INSERT INTO platform_auth_challenges(token_hash,account_id,auth_version,verified_password_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')",[tokenHash(raw),a.id,current.auth_version,current.password_hash]);
   return {challenge:raw,mfa_required:!!current.mfa_enabled_at,enrollment_required:!current.mfa_enabled_at,expires_in:300};
  });res.json(result);
 });
 router.post('/mfa/setup',async(req,res)=>{
  const b=challengeSchema.parse(req.body);await limit(req,res,'setup:'+tokenHash(b.challenge));
  const result=await platformTransaction(async c=>{
   const {a,ch,hash}=await challenge(c,b.challenge);if(a.mfa_enabled_at)throw new AppError(409,'An authenticator is already configured. Enter its current code.');
   const secret=ch.pending_ciphertext?unseal(a.id+':'+hash,ch.pending_ciphertext):base32(randomBytes(20));
   if(!ch.pending_ciphertext)await c.query('UPDATE platform_auth_challenges SET pending_ciphertext=$2 WHERE token_hash=$1',[hash,seal(a.id+':'+hash,secret)]);
   const uri='otpauth://totp/'+encodeURIComponent('DryKraft platform:'+a.email)+'?secret='+secret+'&issuer=DryKraft%20platform&algorithm=SHA1&digits=6&period=30';
   return {secret,qr:await QRCode.toDataURL(uri,{width:220,margin:4}),expires_at:ch.expires_at};
  });res.json(result);
 });
 router.post('/mfa',async(req,res)=>{
  const b=challengeSchema.extend({code:z.string().trim().min(1).max(40)}).parse(req.body);await limit(req,res,'proof:'+tokenHash(b.challenge));
  const result=await platformTransaction(async c=>{
   const {a,ch,hash}=await challenge(c,b.challenge);let codes;
   if(!a.mfa_enabled_at){
    const secret=ch.pending_ciphertext?unseal(a.id+':'+hash,ch.pending_ciphertext):null,step=secret?matchingStep(secret,b.code):null;
    if(step!==null){codes=Array.from({length:10},()=>randomBytes(10).toString('hex').match(/.{5}/g).join('-'));await c.query('UPDATE platform_accounts SET secret_ciphertext=$2,last_step=$3,recovery_hashes=$4,mfa_enabled_at=now() WHERE id=$1',[a.id,seal(a.id,secret),step,codes.map(code=>hashRecovery(a.id,code))]);}
    else codes=null;
    if(!codes){await c.query('UPDATE platform_auth_challenges SET attempts=attempts+1 WHERE token_hash=$1',[hash]);return {invalid:true};}
   }else if(!await proof(c,a,b.code)){await c.query('UPDATE platform_auth_challenges SET attempts=attempts+1 WHERE token_hash=$1',[hash]);return {invalid:true};}
   await c.query('DELETE FROM platform_auth_challenges WHERE account_id=$1',[a.id]);
   const raw=await issueSession(c,req,a);req.sa={id:a.id};await platformAudit(c,req,codes?'platform.mfa.enrolled':'platform.session.created','account',a.id);
   return {raw,codes};
  });if(result.invalid)throw new AppError(401,'Code is incorrect or already used. Enter a new authenticator code or an unused recovery code.');
  cookie(res,result.raw);res.json({ok:true,...(result.codes?{recovery_codes:result.codes}:{})});
 });
 router.post('/logout',async(req,res)=>{
  const raw=req.cookies[cookieName];if(raw&&/^[a-f0-9]{64}$/.test(raw))await platformTransaction(async c=>{const s=(await c.query('DELETE FROM platform_sessions WHERE token_hash=$1 RETURNING account_id',[tokenHash(raw)])).rows[0];if(s){req.sa={id:s.account_id};await platformAudit(c,req,'platform.session.ended','account',s.account_id);}});
  res.clearCookie(cookieName,cookieOptions);res.json({ok:true});
 });
 router.use(authenticatePlatform);
 router.get('/session',(req,res)=>res.json({account:platformAccount(req.sa),expires_at:req.sa.expires_at,idle_timeout_seconds:900}));
 router.post('/password',async(req,res)=>{
  const b=z.object({current_password:z.string().min(1).max(128),new_password:z.string().min(12).max(128),code:z.string().trim().min(1).max(40)}).strict().parse(req.body);await limit(req,res,'change:'+req.sa.id);
  if(b.current_password===b.new_password)throw new AppError(400,'Choose a different password.');const nextHash=await hashPassword(b.new_password);
  const raw=await authorizedPlatform(req,['owner','admin','support','billing','viewer'],async(c,a)=>{
   if(!await checkPassword(b.current_password,a.password_hash)||!await proof(c,a,b.code))throw new AppError(400,'Your current password or authenticator code is incorrect.');
   const updated=(await c.query('UPDATE platform_accounts SET password_hash=$2,auth_version=auth_version+1,version=version+1,password_changed_at=now() WHERE id=$1 RETURNING auth_version',[a.id,nextHash])).rows[0];
   await c.query('DELETE FROM platform_sessions WHERE account_id=$1',[a.id]);await c.query('DELETE FROM platform_auth_challenges WHERE account_id=$1',[a.id]);
   await platformAudit(c,req,'platform.password.changed','account',a.id);return issueSession(c,req,{...a,...updated});
  });cookie(res,raw);res.json({ok:true});
 });
}
