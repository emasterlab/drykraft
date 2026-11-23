import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.mjs';
import { AppError } from './model.mjs';
import { authenticateAccount,tokenHash,workspaceAuth } from './auth.mjs';
import { mcpOperationForRequest } from './mcp-operations.mjs';

const ttl=8*60*60;
const active=hash=>'drykraft:mcp:session:'+hash;
const grant=hash=>'drykraft:mcp:token:'+hash;

export function mountMcpAccess(app,redis){
  app.use('/api',async(req,res,next)=>{
    const authorization=req.get('authorization')||'';
    if(!/^Bearer dk_mcp_/i.test(authorization))return next();
    res.set('Cache-Control','no-store');
    const match=/^Bearer (dk_mcp_[A-Za-z0-9_-]{43})$/i.exec(authorization);
    if(!match)throw new AppError(401,'Invalid MCP token.');
    const operation=mcpOperationForRequest(req.method,'/api'+req.path);
    if(!operation)throw new AppError(403,'This operation is not available through MCP.');
    const hash=tokenHash(match[1]);
    const raw=await redis.get(grant(hash));
    if(!raw)throw new AppError(401,'MCP token expired or revoked. Create a new one in Account security.');
    const binding=JSON.parse(raw);
    if(await redis.get(active(binding.sessionHash))!==hash)throw new AppError(401,'MCP token expired or revoked.');
    if(!operation.readOnly&&binding.mode!=='write')throw new AppError(403,'This MCP token only allows reading.');
    const session=(await pool.query(
      'SELECT s.*,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.auth_version=u.auth_version AND NOT platform_user_disabled(s.user_id)',[binding.sessionHash]
    )).rows[0];
    if(!session)throw new AppError(401,'Sign in and create a new MCP token.');
    if(req.headers['x-workspace-id']&&req.headers['x-workspace-id']!==binding.workspaceId)
      throw new AppError(403,'This MCP token belongs to another workspace.');
    req.headers['x-workspace-id']=binding.workspaceId;
    const auth=await workspaceAuth(req,session);
    if(!operation.readOnly&&auth.role==='viewer')throw new AppError(403,'Your current workspace role only allows reading.');
    req.mcpSession=session;
    req.mcpMode=binding.mode;
    next();
  });

  app.post('/api/account/mcp-access',authenticateAccount,async(req,res)=>{
    const {mode}=z.object({mode:z.enum(['read','write']).default('read')}).parse(req.body);
    const {workspace,role}=await workspaceAuth(req,req.account);
    if(workspace.settings?.demo)throw new AppError(403,'Create a workspace to use MCP access.');
    if(mode==='write'&&role==='viewer')throw new AppError(403,'Your workspace role only allows reading.');
    const token='dk_mcp_'+randomBytes(32).toString('base64url');
    const hash=tokenHash(token),sessionHash=req.account.token_hash;
    const remaining=Math.min(ttl,Math.floor((new Date(req.account.expires_at).getTime()-Date.now())/1000));
    if(remaining<1)throw new AppError(401,'Sign in again to create an MCP token.');
    await redis.multi()
      .set(grant(hash),JSON.stringify({sessionHash,workspaceId:workspace.id,mode}),{EX:remaining})
      .set(active(sessionHash),hash,{EX:remaining}).exec();
    res.set('Cache-Control','no-store').status(201).json({token,mode,expires_at:new Date(Date.now()+remaining*1000).toISOString()});
  });
  app.delete('/api/account/mcp-access',authenticateAccount,async(req,res)=>{
    await redis.del(active(req.account.token_hash));
    res.set('Cache-Control','no-store').json({ok:true});
  });
}
