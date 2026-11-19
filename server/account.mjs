import { Router } from 'express';
import { z } from 'zod';
import { pool } from './db.mjs';
import { AppError } from './model.mjs';
import { checkPassword,hashPassword,insertSession,setSessionCookie,clearSessionCookie } from './auth.mjs';
import {mountMfaAccount} from './mfa.mjs';

const password=z.string().min(10).max(128);
function device(agent='') {
  const browser=/Edg\//.test(agent)?'Edge':/Firefox\//.test(agent)?'Firefox':/Chrome\//.test(agent)?'Chrome':/Safari\//.test(agent)?'Safari':null;
  const os=/Android/.test(agent)?'Android':/iPhone|iPad/.test(agent)?'iOS':/Windows/.test(agent)?'Windows':/Macintosh/.test(agent)?'macOS':/Linux/.test(agent)?'Linux':null;
  return browser && os?`${browser} on ${os}`:browser || os || 'Unknown device';
}
const publicSession=s=>({id:s.id,device:device(s.user_agent || ''),created_at:s.created_at,last_seen_at:s.last_seen_at,expires_at:s.expires_at});
async function accountTransaction(req,fn) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.user_id',$1,true)",[req.account.user_id]);
    const user=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.account.user_id])).rows[0];
    const current=(await c.query('SELECT * FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()',[req.account.user_id,req.account.token_hash])).rows[0];
    if(!user || !current || current.auth_version!==user.auth_version)throw new AppError(401,'Your session expired. Sign in again.');
    const result=await fn(c,user,current);await c.query('COMMIT');return result;
  } catch(error) { await c.query('ROLLBACK');throw error; }
  finally { c.release(); }
}
export const accountRouter=Router();
mountMfaAccount(accountRouter,accountTransaction);
accountRouter.get('/security',async(req,res)=>{
  const cursor=req.query.cursor?z.string().uuid().parse(req.query.cursor):null;
  res.json(await accountTransaction(req,async(c,user,current)=>{
    let after=null;
    if(cursor) {
      after=(await c.query("SELECT coalesce(created_at,'-infinity')::text AS time FROM sessions WHERE user_id=$1 AND id=$2 AND token_hash<>$3 AND expires_at>now()",[user.id,cursor,current.token_hash])).rows[0]?.time;
      if(!after)throw new AppError(400,'This session page changed. Refresh the list.');
    }
    const other=(await c.query("SELECT * FROM sessions WHERE user_id=$1 AND token_hash<>$2 AND expires_at>now() AND ($3::timestamptz IS NULL OR (coalesce(created_at,'-infinity'),id)<($3,$4::uuid)) ORDER BY coalesce(created_at,'-infinity') DESC,id DESC LIMIT 26",[user.id,current.token_hash,after,cursor])).rows;
    const total=(await c.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND token_hash<>$2 AND expires_at>now()',[user.id,current.token_hash])).rows[0].n;
    const history=(await c.query('SELECT id,action,count,created_at FROM account_security_events WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',[user.id])).rows;
    const mfa=(await c.query('SELECT enabled_at,cardinality(recovery_hashes) AS recovery_codes_remaining FROM account_mfa WHERE user_id=$1',[user.id])).rows[0];
    return {current:publicSession(current),others:{items:other.slice(0,25).map(publicSession),total,next_cursor:other.length>25?other[24].id:null},password_changed_at:user.password_changed_at,shared_demo:user.email==='demo@drykraft.local',mfa:{enabled:user.mfa_enabled,enabled_at:mfa?.enabled_at||null,recovery_codes_remaining:user.mfa_enabled?mfa?.recovery_codes_remaining||0:0},history};
  }));
});
accountRouter.delete('/sessions',async(req,res)=>{
  const count=await accountTransaction(req,async(c,user,current)=>{
    const result=await c.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2 AND expires_at>now()',[user.id,current.token_hash]);
    if(result.rowCount)await c.query("INSERT INTO account_security_events(user_id,action,count) VALUES($1,'sessions.ended',$2)",[user.id,result.rowCount]);
    return result.rowCount;
  });res.json({count});
});
accountRouter.delete('/sessions/:id',async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);
  const current=await accountTransaction(req,async(c,user,session)=>{
    if(!(await c.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>now()',[id,user.id])).rowCount)throw new AppError(404,'This session has already ended or is unavailable. Refresh the list.');
    await c.query("INSERT INTO account_security_events(user_id,action,count) VALUES($1,'session.ended',1)",[user.id]);
    return session.id===id;
  });if(current)clearSessionCookie(res);res.json({current});
});
accountRouter.post('/password',async(req,res)=>{
  const b=z.object({current_password:password,new_password:password,confirm_password:password}).parse(req.body);
  if(b.new_password!==b.confirm_password)throw new AppError(400,'The new passwords do not match.');
  if(b.current_password===b.new_password)throw new AppError(400,'Choose a different password.');
  const newHash=await hashPassword(b.new_password);
  const token=await accountTransaction(req,async(c,user,current)=>{
    if(user.email==='demo@drykraft.local')throw new AppError(403,'Password changes are unavailable in the shared sample account.');
    if(!await checkPassword(b.current_password,user.password_hash))throw new AppError(400,'Your current password is incorrect.');
    const updated=(await c.query('UPDATE users SET password_hash=$1,password_changed_at=now(),auth_version=auth_version+1 WHERE id=$2 RETURNING auth_version',[newHash,user.id])).rows[0];
    await c.query('DELETE FROM auth_mfa_challenges WHERE user_id=$1',[user.id]);
    const removed=(await c.query('WITH removed AS (DELETE FROM sessions WHERE user_id=$1 RETURNING expires_at) SELECT count(*)::int AS n FROM removed WHERE expires_at>now()',[user.id])).rows[0].n;
    const token=await insertSession(c,req,user.id,current.tenant_id,newHash,updated.auth_version);
    await c.query("INSERT INTO account_security_events(user_id,action,count) VALUES($1,'password.changed',$2)",[user.id,Math.max(0,removed-1)]);
    return token;
  });setSessionCookie(res,token);res.json({ok:true});
});
