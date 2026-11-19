import {Router} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,tenantTransaction} from './db.mjs';
import {AppError} from './model.mjs';
import {tokenHash,hashPassword,checkPassword,insertSession,setSessionCookie,slugFromHost} from './auth.mjs';
import {requireAvailableSeat} from './billing.mjs';
import {limitMfa,verifyMfaProof} from './mfa.mjs';

const token=z.string().regex(/^[a-f0-9]{64}$/);
// Only these fixed internal function names can be used; no request supplies SQL identifiers.
const gateways={platform:{resolve:'resolve_platform_workspace_invitation',lock:'lock_platform_invitation_sender',accept:'accept_platform_workspace_invitation'},reseller:{resolve:'resolve_reseller_workspace_invitation',lock:'lock_reseller_invitation_sender',accept:'accept_reseller_workspace_invitation'}};
function ownerInvitationRouter(kind){
 const functions=gateways[kind],router=Router();
async function invitation(raw,hostname){
 const invite=(await pool.query(`SELECT ${functions.resolve}($1) AS data`,[tokenHash(raw)])).rows[0].data,slug=slugFromHost(hostname);
 if(!invite||invite.revoked||!invite.sender_valid||new Date(invite.expires_at)<=new Date()||(slug&&slug!==invite.workspace_slug))throw new AppError(410,'This owner invitation is unavailable or expired. Ask DryKraft support for assistance.');
 return invite;
}
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.post('/preview',async(req,res)=>{
 const b=z.object({token}).strict().parse(req.body),i=await invitation(b.token,req.hostname);
 res.json({email:i.email,role:'owner',expires_at:i.expires_at,accepted:i.accepted,workspace:{name:i.workspace_name,slug:i.workspace_slug}});
});
router.post('/accept',async(req,res)=>{
 const b=z.object({token,password:z.string().min(10).max(128),mode:z.enum(['login','signup']),name:z.string().trim().min(2).max(100).optional(),code:z.string().trim().min(1).max(40).optional()}).strict().parse(req.body);
 const i=await invitation(b.token,req.hostname),hash=tokenHash(b.token);
 const existing=(await pool.query('SELECT id,password_hash FROM users WHERE email=$1',[i.email])).rows[0];
 let userId=existing?.id,newHash=null;
 if(existing){if(!await checkPassword(b.password,existing.password_hash))throw new AppError(401,'Email or password is incorrect. Sign in with the invited account.');}
 else if(b.mode==='login'){await hashPassword(b.password);throw new AppError(401,'Email or password is incorrect. Create an account if you are new to DryKraft.');}
 else{if(!b.name)throw new AppError(400,'Enter your name to create an account.');userId=randomUUID();newHash=await hashPassword(b.password);}
 const session=await tenantTransaction(i.tenant_id,async c=>{
  if(!(await c.query(`SELECT ${functions.lock}($1) AS valid`,[hash])).rows[0].valid)throw new AppError(410,'This invitation is unavailable or its sender changed. Ask for a new link.');
  await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[i.tenant_id]);
  await requireAvailableSeat(c,i.tenant_id,userId);
  if(newHash)await c.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,i.email,b.name,newHash]);
  const user=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
  if(!user||user.password_hash!==(newHash||existing.password_hash))throw new AppError(401,'Your sign-in details changed. Sign in again.');
  if((await c.query('SELECT platform_user_disabled($1) AS disabled',[userId])).rows[0].disabled)throw new AppError(401,'This account cannot sign in. Contact DryKraft support for assistance.');
  if(user.mfa_enabled){await limitMfa(req,res,userId);if(!b.code)throw new AppError(401,'Enter your authenticator or recovery code to accept this invitation.');if(!await verifyMfaProof(c,user,b.code))throw new AppError(401,'Code is incorrect or already used. Enter a new authenticator code or unused recovery code.');}
  try{await c.query(`SELECT ${functions.accept}($1,$2)`,[hash,userId]);}
  catch(error){if(['22023','42501'].includes(error.code))throw new AppError(410,'This invitation is unavailable or has already been used. Ask DryKraft support for assistance.');throw error;}
  return insertSession(c,req,userId,i.tenant_id,user.password_hash,user.mfa_enabled?user.auth_version:null);
 });
 setSessionCookie(res,session);res.json({ok:true});
});

 return router;
}
export const platformInvitationRouter=ownerInvitationRouter('platform');
export const resellerInvitationRouter=ownerInvitationRouter('reseller');
