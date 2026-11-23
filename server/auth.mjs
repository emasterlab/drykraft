import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from './db.mjs';
import { AppError } from './model.mjs';

const scrypt=promisify(scryptCallback);
export const tokenHash=token=>createHash('sha256').update(token).digest('hex');
export async function hashPassword(password) {
  const salt=randomBytes(16).toString('hex');
  const hash=await scrypt(password,salt,64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function checkPassword(password,stored) {
  const [salt,hash]=stored.split(':');
  const computed=await scrypt(password,salt,64);
  return timingSafeEqual(Buffer.from(hash,'hex'),computed);
}
export function setSessionCookie(res,token) {
  res.cookie('drykraft_session',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:7*86400000,...(process.env.APP_DOMAIN!=='localhost'?{domain:process.env.APP_DOMAIN}:{})});
}
export function clearSessionCookie(res) {
  res.clearCookie('drykraft_session',{path:'/',...(process.env.APP_DOMAIN!=='localhost'?{domain:process.env.APP_DOMAIN}:{})});
}
export async function insertSession(client,req,userId,tenantId,verifiedHash,verifiedAuthVersion=null) {
  // Serialize issuance with password changes; an earlier password check cannot mint a later session.
  const user=(await client.query('SELECT password_hash,auth_version,mfa_enabled FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
  if((await client.query('SELECT platform_user_disabled($1) AS disabled',[userId])).rows[0].disabled)throw new AppError(401,'This account cannot sign in. Contact DryKraft support for assistance.');
  if(!user || !verifiedHash || user.password_hash!==verifiedHash)throw new AppError(401,'Your sign-in details changed. Sign in again.');
  if(user.mfa_enabled && verifiedAuthVersion!==user.auth_version)throw new AppError(401,'Authenticator verification is required. Sign in again.');
  const token=randomBytes(32).toString('hex');
  await client.query('DELETE FROM sessions WHERE user_id=$1 AND expires_at<=now()',[userId]);
  await client.query('INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,user_agent,auth_version) VALUES($1,$2,$3,now()+interval \'7 days\',$4,$5)',[tokenHash(token),userId,tenantId,(req.get('user-agent') || '').slice(0,500) || null,user.auth_version]);
  return token;
}
export async function createSession(req,res,userId,tenantId,verifiedHash) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const token=await insertSession(client,req,userId,tenantId,verifiedHash);
    await client.query('COMMIT');setSessionCookie(res,token);
  } catch(error) { await client.query('ROLLBACK');throw error; }
  finally { client.release(); }
}
export function slugFromHost(hostname) {
  const domain=process.env.APP_DOMAIN || 'localhost';
  const host=hostname.toLowerCase();
  if([domain,`app.${domain}`,`www.${domain}`].includes(host) || (domain==='localhost' && ['127.0.0.1','[::1]'].includes(host))) return null;
  if(!host.endsWith(`.${domain}`)) throw new AppError(400,'This application host is not configured.');
  const slug=host.slice(0,-domain.length-1);
  if(!/^[a-z][a-z0-9-]{2,39}$/.test(slug)) throw new AppError(400,'Invalid workspace address.');
  return slug;
}
async function accountSession(req) {
  if(req.mcpSession)return req.mcpSession;
  const token=req.cookies.drykraft_session;
  if(!token) throw new AppError(401,'Sign in to continue.');
  const session=(await pool.query(`SELECT s.*,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now() AND s.auth_version=u.auth_version AND NOT platform_user_disabled(s.user_id)`,[tokenHash(token)])).rows[0];
  if(!session) throw new AppError(401,'Your session expired. Sign in again.');
  await pool.query("UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND (last_seen_at IS NULL OR last_seen_at<now()-interval '5 minutes')",[session.token_hash]);
  // Another signed-in device may already have completed onboarding.
  if(!session.tenant_id) {
    const membership=(await pool.query('SELECT m.tenant_id FROM memberships m JOIN workspaces w ON w.id=m.tenant_id WHERE m.user_id=$1 ORDER BY w.created_at LIMIT 1',[session.user_id])).rows[0];
    if(membership) { session.tenant_id=membership.tenant_id; await pool.query('UPDATE sessions SET tenant_id=$1 WHERE token_hash=$2',[membership.tenant_id,session.token_hash]); }
  }
  return session;
}
export const accountUser = session => ({id:session.user_id,name:session.name,email:session.email});
export async function workspaceAuth(req,session) {
  const hostSlug=slugFromHost(req.hostname);
  const requestedTenant=req.headers['x-workspace-id'] || session.tenant_id;
  if(!requestedTenant) throw new AppError(409,'Finish setting up your workspace to continue.');
  const workspace=(await pool.query(`SELECT w.*,m.role FROM workspaces w JOIN memberships m ON m.tenant_id=w.id WHERE m.user_id=$1 AND w.id=$2`,[session.user_id,requestedTenant])).rows[0];
  if(!workspace || (hostSlug && workspace.slug!==hostSlug)) throw new AppError(403,'You do not have access to this workspace.');
  if((await pool.query('SELECT platform_workspace_suspended($1) AS suspended',[workspace.id])).rows[0].suspended)throw new AppError(403,'This workspace is suspended. Contact DryKraft support for assistance.');
  return {user:accountUser(session),workspace,role:workspace.role};
}
export async function authenticateAccount(req,res,next) {
  try { req.account=await accountSession(req); next(); } catch(error) {next(error);}
}
export async function authenticate(req,res,next) {
  try { req.auth=await workspaceAuth(req,await accountSession(req)); next(); } catch(error) {next(error);}
}
export function requireWrite(req,res,next) {
  if(req.auth.role==='viewer') return next(new AppError(403,'Your role has read-only access.'));
  next();
}
export function requireAdmin(req,res,next) {
  if(!['owner','admin'].includes(req.auth.role)) return next(new AppError(403,'Workspace administrator access is required.'));
  next();
}
