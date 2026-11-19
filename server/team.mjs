import { Router } from 'express';
import { z } from 'zod';
import { randomBytes,randomUUID } from 'node:crypto';
import { pool,tenantTransaction,event } from './db.mjs';
import { AppError } from './model.mjs';
import { tokenHash,hashPassword,checkPassword,insertSession,setSessionCookie,requireAdmin,slugFromHost } from './auth.mjs';
import { requireAvailableSeat } from './billing.mjs';
import {limitMfa,verifyMfaProof} from './mfa.mjs';

const role=z.enum(['admin','member','viewer']);
const email=z.string().trim().toLowerCase().email().max(200);
const token=z.string().regex(/^[a-f0-9]{64}$/);
const password=z.string().min(10).max(128);
// The workspace lock serializes membership grants, revocation and invite acceptance.
async function administrator(c,tenantId,userId){
  await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[tenantId]);
  const member=(await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId])).rows[0];
  if(!member || !['owner','admin'].includes(member.role))throw new AppError(403,'Workspace administrator access is required.');
  return member.role;
}
function grantAllowed(actorRole,targetRole,newRole){
  if(targetRole==='owner')throw new AppError(403,'The workspace owner cannot be changed or removed here.');
  if(actorRole!=='owner' && (targetRole==='admin' || newRole==='admin'))throw new AppError(403,'Only the workspace owner can manage administrator access.');
}
async function invitation(raw,hostname){
  const i=(await pool.query('SELECT * FROM resolve_invitation($1)',[tokenHash(raw)])).rows[0];
  const slug=slugFromHost(hostname);
  if(!i || i.revoked_at || new Date(i.expires_at)<=new Date() || (slug && slug!==i.workspace_slug))throw new AppError(410,'This invitation is unavailable or expired. Ask your workspace administrator for a new link.');
  return i;
}
export const invitationRouter=Router();
invitationRouter.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
invitationRouter.post('/preview',async(req,res)=>{
  const b=z.object({token}).parse(req.body),i=await invitation(b.token,req.hostname);
  res.json({email:i.email,role:i.role,expires_at:i.expires_at,accepted:!!i.accepted_at,workspace:{name:i.workspace_name,slug:i.workspace_slug}});
});
invitationRouter.post('/accept',async(req,res)=>{
  const b=z.object({token,password,mode:z.enum(['login','signup']),name:z.string().trim().min(2).max(100).optional(),code:z.string().trim().min(1).max(40).optional()}).parse(req.body);
  const i=await invitation(b.token,req.hostname);
  const existing=(await pool.query('SELECT id,password_hash FROM users WHERE email=$1',[i.email])).rows[0];
  let userId=existing?.id,hash=null;
  if(existing){if(!await checkPassword(b.password,existing.password_hash))throw new AppError(401,'Email or password is incorrect. Sign in with the invited account.');}
  else if(b.mode==='login'){await hashPassword(b.password);throw new AppError(401,'Email or password is incorrect. Create an account if you are new to DryKraft.');}
  else {if(!b.name)throw new AppError(400,'Enter your name to create an account.');userId=randomUUID();hash=await hashPassword(b.password);}
  const inviteSession=async(c)=>{
    const user=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
    if(user.mfa_enabled){await limitMfa(req,res,userId);if(!b.code)throw new AppError(401,'Enter your authenticator or recovery code to accept this invitation.');if(!await verifyMfaProof(c,user,b.code))throw new AppError(401,'Code is incorrect or already used. Enter a new authenticator code or unused recovery code.');}
    return insertSession(c,req,userId,i.tenant_id,hash || existing.password_hash,user.mfa_enabled?user.auth_version:null);
  };
  const sessionToken=await tenantTransaction(i.tenant_id,async c=>{
    await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[i.tenant_id]);
    const current=(await c.query('SELECT *,expires_at>now() AS valid FROM invitations WHERE id=$1 FOR UPDATE',[i.id])).rows[0];
    if(!current || current.revoked_at || !current.valid)throw new AppError(410,'This invitation is unavailable or expired. Ask for a new link.');
    if(current.accepted_at){
      if(current.accepted_by!==userId || !(await c.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2',[i.tenant_id,userId])).rowCount)throw new AppError(410,'This invitation has already been used. Ask for a new link.');
      return inviteSession(c);
    }
    const inviter=(await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[i.tenant_id,current.invited_by])).rows[0];
    if(!inviter || !['owner','admin'].includes(inviter.role) || (current.role==='admin' && inviter.role!=='owner'))throw new AppError(410,'The sender can no longer grant this access. Ask for a new invitation.');
    await requireAvailableSeat(c,i.tenant_id,userId);
    if(hash)await c.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,current.email,b.name,hash]);
    const session=await inviteSession(c);
    const added=await c.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',[i.tenant_id,userId,current.role]);
    await c.query('UPDATE invitations SET accepted_at=now(),accepted_by=$1 WHERE id=$2',[userId,current.id]);
    if(added.rowCount)await event(c,i.tenant_id,userId,'workspace.member.joined','member',userId,{role:current.role,invitation_id:current.id});
    return session;
  });
  setSessionCookie(res,sessionToken);res.json({ok:true});
});

export const teamRouter=Router();
teamRouter.get('/member-options',async(req,res)=>{
  const q=z.object({search:z.string().trim().max(100).default(''),cursor:z.string().uuid().optional(),selected:z.string().uuid().optional()}).strict().parse(req.query),tenantId=req.auth.workspace.id;
  const search='%'+q.search.replace(/[\\%_]/g,'\\$&')+'%';
  const rows=(await pool.query('SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.name ILIKE $2 AND ($3::uuid IS NULL OR u.id>$3) ORDER BY u.id LIMIT 26',[tenantId,search,q.cursor || null])).rows;
  const selected=q.selected?(await pool.query('SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.id=$2',[tenantId,q.selected])).rows[0] || null:null;
  res.set('Cache-Control','no-store').json({items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null,selected});
});
teamRouter.get('/members',async(req,res)=>{
  const q=z.object({cursor:email.optional()}).parse(req.query),tenantId=req.auth.workspace.id;
  const rows=(await pool.query('SELECT u.id,u.name,u.email,m.role,m.version FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND ($2::text IS NULL OR u.email>$2) ORDER BY u.email LIMIT 26',[tenantId,q.cursor || null])).rows;
  const total=(await pool.query('SELECT count(*)::int AS count FROM memberships WHERE tenant_id=$1',[tenantId])).rows[0].count;
  res.json({items:rows.slice(0,25),total,next_cursor:rows.length>25?rows[24].email:null});
});
teamRouter.put('/members/:id',requireAdmin,async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id),b=z.object({role,version:z.number().int().positive()}).parse(req.body),tenantId=req.auth.workspace.id;
  await tenantTransaction(tenantId,async c=>{
    const actorRole=await administrator(c,tenantId,req.auth.user.id);
    const target=(await c.query('SELECT role,version FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[tenantId,id])).rows[0];
    if(!target)throw new AppError(404,'This member does not belong to your workspace.');
    grantAllowed(actorRole,target.role,b.role);
    if(target.version!==b.version)throw new AppError(409,'This member changed. Refresh your team before updating access.');
    if(target.role===b.role)return;
    await c.query('UPDATE memberships SET role=$1,version=version+1 WHERE tenant_id=$2 AND user_id=$3',[b.role,tenantId,id]);
    await event(c,tenantId,req.auth.user.id,'workspace.member.role_changed','member',id,{from:target.role,to:b.role});
  });res.json({ok:true});
});
teamRouter.delete('/members/:id',requireAdmin,async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id),version=z.coerce.number().int().positive().parse(req.query.version),tenantId=req.auth.workspace.id;
  await tenantTransaction(tenantId,async c=>{
    const actorRole=await administrator(c,tenantId,req.auth.user.id);
    const target=(await c.query('SELECT role,version FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[tenantId,id])).rows[0];
    if(!target)throw new AppError(404,'This member does not belong to your workspace.');
    grantAllowed(actorRole,target.role);
    if(target.version!==version)throw new AppError(409,'This member changed. Refresh your team before removing access.');
    await c.query('UPDATE workspace_teams t SET version=version+1,updated_at=now() WHERE t.lead_id=$1 OR EXISTS(SELECT 1 FROM workspace_team_members g WHERE g.tenant_id=t.tenant_id AND g.team_id=t.id AND g.user_id=$1)',[id]);
    await c.query('UPDATE workspace_locations l SET version=version+1,updated_at=now() WHERE EXISTS(SELECT 1 FROM workspace_location_members g WHERE g.tenant_id=l.tenant_id AND g.location_id=l.id AND g.user_id=$1)',[id]);
    await c.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',[tenantId,id]);
    await c.query('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2',[tenantId,id]);
    await c.query('UPDATE invitations SET revoked_at=now() WHERE invited_by=$1 AND accepted_at IS NULL AND revoked_at IS NULL',[id]);
    await event(c,tenantId,req.auth.user.id,'workspace.member.removed','member',id,{role:target.role});
  });res.json({ok:true});
});
teamRouter.get('/invitations',requireAdmin,async(req,res)=>{
  const cursor=req.query.cursor?z.string().uuid().parse(req.query.cursor):null;
  res.json(await tenantTransaction(req.auth.workspace.id,async c=>{
    let after=null;
    // Preserve database microseconds; a JavaScript Date can skip rows sharing a timestamp.
    if(cursor){after=(await c.query('SELECT created_at::text AS created_at FROM invitations WHERE id=$1',[cursor])).rows[0]?.created_at;if(!after)throw new AppError(400,'Invalid invitation page.');}
    const rows=(await c.query('SELECT id,email,role,created_at,expires_at,expires_at>now() AS active FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND ($1::timestamptz IS NULL OR (created_at,id)<($1,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 26',[after,cursor])).rows;
    const total=(await c.query('SELECT count(*)::int AS count FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL')).rows[0].count;
    return {items:rows.slice(0,25),total,next_cursor:rows.length>25?rows[24].id:null};
  }));
});
teamRouter.post('/invitations',requireAdmin,async(req,res)=>{
  const b=z.object({email,role}).parse(req.body),tenantId=req.auth.workspace.id,raw=randomBytes(32).toString('hex'),id=randomUUID();
  const result=await tenantTransaction(tenantId,async c=>{
    const actorRole=await administrator(c,tenantId,req.auth.user.id);
    const pending=(await c.query('SELECT role FROM invitations WHERE email=$1 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE',[b.email])).rows[0];
    grantAllowed(actorRole,pending?.role,b.role);
    if((await c.query('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.email=$2',[tenantId,b.email])).rowCount)throw new AppError(409,'This person is already a member of your workspace.');
    await c.query('UPDATE invitations SET revoked_at=now() WHERE email=$1 AND accepted_at IS NULL AND revoked_at IS NULL',[b.email]);
    const item=(await c.query("INSERT INTO invitations(tenant_id,id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days') RETURNING id,email,role,expires_at",[tenantId,id,b.email,b.role,tokenHash(raw),req.auth.user.id])).rows[0];
    await event(c,tenantId,req.auth.user.id,'workspace.invitation.created','invitation',id,{email:b.email,role:b.role});return item;
  });res.set('Cache-Control','no-store').status(201).json({...result,token:raw});
});
teamRouter.delete('/invitations/:id',requireAdmin,async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id),tenantId=req.auth.workspace.id;
  await tenantTransaction(tenantId,async c=>{
    const actorRole=await administrator(c,tenantId,req.auth.user.id);
    const i=(await c.query('SELECT * FROM invitations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!i)throw new AppError(404,'Invitation not found in your workspace.');
    grantAllowed(actorRole,null,i.role);
    if(i.accepted_at)throw new AppError(409,'This invitation was accepted. Manage the member’s access instead.');
    if(i.revoked_at)return;
    await c.query('UPDATE invitations SET revoked_at=now() WHERE id=$1',[id]);
    await event(c,tenantId,req.auth.user.id,'workspace.invitation.revoked','invitation',id,{});
  });res.json({ok:true});
});
