import {randomBytes,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import QRCode from 'qrcode';
import {pool} from './db.mjs';
import {AppError} from './model.mjs';
import {tokenHash,checkPassword,insertSession,setSessionCookie,slugFromHost} from './auth.mjs';
import {encryptCredential,decryptCredential} from './automation.mjs';
import {consumeRateLimit} from './rate-limits.mjs';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes){let bits=0,value=0,out='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){bits-=5;out+=alphabet[(value>>>bits)&31];}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function decode32(text){let bits=0,value=0,out=[];for(const ch of text){const i=alphabet.indexOf(ch);if(i<0)throw Error('Invalid authenticator secret');value=(value<<5)|i;bits+=5;if(bits>=8){bits-=8;out.push((value>>>bits)&255);}}return Buffer.from(out);}
// RFC6238/HOTP dynamic truncation; counter is 64-bit, not a 32-bit timestamp.
export function totp(secret,step,digits=6){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const h=createHmac('sha1',decode32(secret)).update(counter).digest(),offset=h[h.length-1]&15;return String((h.readUInt32BE(offset)&0x7fffffff)%10**digits).padStart(digits,'0');}
export function matchingStep(secret,code,last=-1,now=Date.now()){if(!/^\d{6}$/.test(code))return null;const step=Math.floor(now/30000);for(const n of [step,step-1,step+1])if(n>=0&&n>Number(last)&&timingSafeEqual(Buffer.from(totp(secret,n)),Buffer.from(code)))return n;return null;}
const secretScope=id=>'account-mfa:'+id;
const seal=(id,secret)=>encryptCredential(secretScope(id),{secret});
const unseal=(id,cipher)=>decryptCredential(secretScope(id),cipher).secret;
const normalizeRecovery=code=>code.toLowerCase().replaceAll('-','');
const recoveryHash=(id,code)=>tokenHash('mfa-recovery:'+id+':'+normalizeRecovery(code));
function newRecovery(id){const codes=Array.from({length:10},()=>randomBytes(10).toString('hex').match(/.{5}/g).join('-'));return {codes,hashes:codes.map(code=>recoveryHash(id,code))};}
let redis;
export function configureMfa(client){redis=client;}
export async function limitMfa(req,res,id){const r=await consumeRateLimit(redis,'account-mfa:'+id,900000);if(r.totalHits>10){res.set('Retry-After',String(Math.max(1,Math.ceil((r.resetTime-Date.now())/1000))));throw new AppError(429,'Too many authenticator attempts. Wait 15 minutes and try again.');}}
async function context(c,id){await c.query("SELECT set_config('app.user_id',$1,true)",[id]);}
export async function verifyMfaProof(c,user,code){
 await context(c,user.id);const state=(await c.query('SELECT * FROM account_mfa WHERE user_id=$1 FOR UPDATE',[user.id])).rows[0];if(!state?.enabled_at||!user.mfa_enabled)return false;
 const step=matchingStep(unseal(user.id,state.secret_ciphertext),code,state.last_step);
 if(step!==null){await c.query('UPDATE account_mfa SET last_step=$2 WHERE user_id=$1',[user.id,step]);return true;}
 if(!/^(?:[a-fA-F0-9]{5}-){3}[a-fA-F0-9]{5}$|^[a-fA-F0-9]{20}$/.test(code))return false;
 const hash=recoveryHash(user.id,code),found=state.recovery_hashes.some(h=>timingSafeEqual(Buffer.from(h),Buffer.from(hash)));
 if(!found)return false;
 await c.query('UPDATE account_mfa SET recovery_hashes=array_remove(recovery_hashes,$2) WHERE user_id=$1',[user.id,hash]);
 await c.query("INSERT INTO account_security_events(user_id,action,count) VALUES($1,'mfa.recovery.used',1)",[user.id]);return true;
}
export async function beginMfaLogin(req,res,userId,tenantId,verifiedHash){
 const c=await pool.connect();let response,session;
 try{await c.query('BEGIN');await context(c,userId);const user=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];if(!user||user.password_hash!==verifiedHash)throw new AppError(401,'Your sign-in details changed. Sign in again.');if((await c.query('SELECT platform_user_disabled($1) AS disabled',[userId])).rows[0].disabled)throw new AppError(401,'Email or password is incorrect.');
  if(!user.mfa_enabled){session=await insertSession(c,req,userId,tenantId,verifiedHash);response={ok:true};}
  else{const token=randomBytes(32).toString('hex');await c.query('DELETE FROM auth_mfa_challenges WHERE user_id=$1',[userId]);await c.query("INSERT INTO auth_mfa_challenges(token_hash,user_id,tenant_id,auth_version,verified_password_hash,host_slug,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')",[tokenHash(token),userId,tenantId,user.auth_version,verifiedHash,slugFromHost(req.hostname)]);response={mfa_required:true,challenge:token,expires_in:300};}
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 if(session)setSessionCookie(res,session);res.set('Cache-Control','no-store');return response;
}
export async function completeMfaLogin(req,res){
 const b=z.object({challenge:z.string().regex(/^[a-f0-9]{64}$/),code:z.string().trim().min(1).max(40)}).strict().parse(req.body),hash=tokenHash(b.challenge);
 const id=(await pool.query('SELECT resolve_mfa_challenge($1) AS id',[hash])).rows[0]?.id;if(!id)throw new AppError(401,'This sign-in expired or was used. Sign in again.');
 await limitMfa(req,res,id);const c=await pool.connect();let result,session;
 try{await c.query('BEGIN');await context(c,id);const user=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];const challenge=(await c.query('SELECT *,expires_at>now() AS valid FROM auth_mfa_challenges WHERE token_hash=$1 FOR UPDATE',[hash])).rows[0];
  if(!user||!challenge?.valid||challenge.attempts>=5||!user.mfa_enabled||user.auth_version!==challenge.auth_version||user.password_hash!==challenge.verified_password_hash||slugFromHost(req.hostname)!==challenge.host_slug)throw new AppError(401,'This sign-in expired or changed. Sign in again.');
  if(challenge.tenant_id&&!(await c.query('SELECT 1 FROM memberships m JOIN workspaces w ON w.id=m.tenant_id WHERE m.user_id=$1 AND w.id=$2 AND ($3::text IS NULL OR w.slug=$3)',[id,challenge.tenant_id,challenge.host_slug])).rowCount)throw new AppError(403,'You no longer have access to this workspace.');
  if(!await verifyMfaProof(c,user,b.code)){await c.query('UPDATE auth_mfa_challenges SET attempts=attempts+1 WHERE token_hash=$1',[hash]);result={invalid:true};}
  else{await c.query('DELETE FROM auth_mfa_challenges WHERE token_hash=$1',[hash]);session=await insertSession(c,req,id,challenge.tenant_id,challenge.verified_password_hash,user.auth_version);result={ok:true};}
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 if(result.invalid)throw new AppError(401,'Code is incorrect or already used. Try a new authenticator code or an unused recovery code.');setSessionCookie(res,session);return result;
}
const password=z.string().min(10).max(128),proof=z.string().trim().min(1).max(40);
async function passwordApproval(user,value){if(user.email==='demo@drykraft.local')throw new AppError(403,'Authenticator setup is unavailable in the shared sample account.');if(!await checkPassword(value,user.password_hash))throw new AppError(400,'Your current password is incorrect.');}
async function rotate(c,req,user,current){const version=(await c.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1 RETURNING auth_version',[user.id])).rows[0].auth_version;await c.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);await c.query('DELETE FROM auth_mfa_challenges WHERE user_id=$1',[user.id]);return insertSession(c,req,user.id,current.tenant_id,user.password_hash,version);}
export function mountMfaAccount(router,transaction){
 router.post('/mfa/cancel',async(req,res)=>{const b=z.object({setup_id:z.string().uuid()}).strict().parse(req.body);await transaction(req,async(c,user)=>{await c.query('UPDATE account_mfa SET pending_ciphertext=NULL,pending_id=NULL,pending_expires_at=NULL WHERE user_id=$1 AND pending_id=$2 AND enabled_at IS NULL',[user.id,b.setup_id]);});res.json({ok:true});});
 router.use('/mfa',async(req,res,next)=>{await limitMfa(req,res,req.account.user_id);next();});
 router.post('/mfa/setup',async(req,res)=>{const b=z.object({password}).strict().parse(req.body);const data=await transaction(req,async(c,user)=>{await passwordApproval(user,b.password);if(user.mfa_enabled)throw new AppError(409,'Two-step verification is already enabled. Refresh account security.');const secret=base32(randomBytes(20)),id=randomUUID();
  const state=(await c.query("INSERT INTO account_mfa(user_id,pending_ciphertext,pending_id,pending_expires_at) VALUES($1,$2,$3,now()+interval '10 minutes') ON CONFLICT(user_id) DO UPDATE SET pending_ciphertext=excluded.pending_ciphertext,pending_id=excluded.pending_id,pending_expires_at=excluded.pending_expires_at RETURNING pending_expires_at",[user.id,seal(user.id,secret),id])).rows[0];
  const uri='otpauth://totp/'+encodeURIComponent('DryKraft:'+user.email)+'?secret='+secret+'&issuer=DryKraft&algorithm=SHA1&digits=6&period=30';return {setup_id:id,secret,qr:await QRCode.toDataURL(uri,{width:220,margin:4}),expires_at:state.pending_expires_at};});res.json(data);});
 router.post('/mfa/enable',async(req,res)=>{const b=z.object({setup_id:z.string().uuid(),code:proof}).strict().parse(req.body);const result=await transaction(req,async(c,user,current)=>{if(user.mfa_enabled)throw new AppError(409,'Two-step verification already changed. Refresh account security.');const state=(await c.query('SELECT *,pending_expires_at>now() AS valid FROM account_mfa WHERE user_id=$1 FOR UPDATE',[user.id])).rows[0];if(!state?.valid||state.pending_id!==b.setup_id)throw new AppError(409,'Authenticator setup expired or changed. Start setup again.');
  const secret=unseal(user.id,state.pending_ciphertext),step=matchingStep(secret,b.code);if(step===null)throw new AppError(400,'Enter the current six-digit code from the authenticator you just added.');const recovery=newRecovery(user.id);
  await c.query('UPDATE account_mfa SET secret_ciphertext=pending_ciphertext,enabled_at=now(),last_step=$2,recovery_hashes=$3,pending_ciphertext=NULL,pending_id=NULL,pending_expires_at=NULL WHERE user_id=$1',[user.id,step,recovery.hashes]);await c.query('UPDATE users SET mfa_enabled=true WHERE id=$1',[user.id]);
  const session=await rotate(c,req,user,current);await c.query("INSERT INTO account_security_events(user_id,action,count) VALUES($1,'mfa.enabled',1)",[user.id]);return {session,codes:recovery.codes};});setSessionCookie(res,result.session);res.json({recovery_codes:result.codes});});
 const managementPaths=['/mfa/disable','/mfa/recovery'];
 router.post(managementPaths,async(req,res)=>{const action=req.path.endsWith('/disable')?'disable':'recovery';const b=z.object({password,code:proof}).strict().parse(req.body);const result=await transaction(req,async(c,user,current)=>{await passwordApproval(user,b.password);if(!user.mfa_enabled)throw new AppError(409,'Two-step verification is not enabled. Refresh account security.');if(!await verifyMfaProof(c,user,b.code))throw new AppError(400,'Code is incorrect or already used. Try a new authenticator code or an unused recovery code.');let codes;
  if(action==='disable'){await c.query('UPDATE users SET mfa_enabled=false WHERE id=$1',[user.id]);await c.query('DELETE FROM account_mfa WHERE user_id=$1',[user.id]);}
  else{const recovery=newRecovery(user.id);codes=recovery.codes;await c.query('UPDATE account_mfa SET recovery_hashes=$2 WHERE user_id=$1',[user.id,recovery.hashes]);}
  const session=await rotate(c,req,user,current);await c.query('INSERT INTO account_security_events(user_id,action,count) VALUES($1,$2,1)',[user.id,action==='disable'?'mfa.disabled':'mfa.recovery.regenerated']);return {session,codes};});setSessionCookie(res,result.session);res.json(result.codes?{recovery_codes:result.codes}:{ok:true});});
}
