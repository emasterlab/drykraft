import express from 'express';
import { randomBytes } from 'node:crypto';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticateAccount,tokenHash,workspaceAuth } from './auth.mjs';
import { pool } from './db.mjs';
import { AppError } from './model.mjs';
import { createDryKraftMcp } from './mcp-tools.mjs';
import { lookupMcpAccess,mcpActive,mcpBrowserSession,mcpGrant,mcpTtl } from './mcp-access.mjs';
import { sharedRateLimit } from './rate-limits.mjs';

const random=()=>randomBytes(32).toString('base64url');
const key=(kind,id)=>'drykraft:mcp:oauth:'+kind+':'+tokenHash(id);
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export const mcpConsentPath='/mcp-connect';
const remaining=session=>Math.floor((new Date(session.expires_at).getTime()-Date.now())/1000);

export function mountHostedMcp(app,redis){
  const domain=process.env.APP_DOMAIN||'localhost';
  const apiOrigin=new URL('http://127.0.0.1:'+(process.env.PORT||4000));
  const issuer=domain==='localhost'?apiOrigin:new URL('https://app.'+domain);
  const docs=new URL('/mcp',domain==='localhost'?issuer:'https://'+domain);
  const resource=new URL('/api/mcp',issuer);
  const router=express.Router();
  const metadataUrl=getOAuthProtectedResourceMetadataUrl(resource);
  const load=async(kind,id)=>JSON.parse(await redis.get(key(kind,id))||'null');
  const save=(kind,id,value,ttl)=>redis.set(key(kind,id),JSON.stringify(value),{EX:ttl});

  function checkResource(requested){
    if(requested&&requested.href!==resource.href)throw new InvalidTargetError('Use the DryKraft MCP resource URL.');
  }
  async function codeFor(client,code){
    const grant=opaque(code)&&await load('code',code);
    if(!grant||grant.clientId!==client.client_id)throw new InvalidGrantError('Authorization code expired or was already used.');
    return grant;
  }
  async function grantSession(binding){
    const session=await mcpBrowserSession(binding.sessionHash);
    if(!session||remaining(session)<1)throw new InvalidGrantError('Sign in to DryKraft and reconnect.');
    return session;
  }
  async function tokens(binding,session){
    const lifetime=remaining(session);
    if(lifetime<1)throw new InvalidGrantError('Sign in to DryKraft and reconnect.');
    const access='dk_mcp_'+random(),refresh=random(),expires=Math.min(mcpTtl,lifetime);
    await redis.multi()
      .set(mcpGrant(tokenHash(access)),JSON.stringify(binding),{EX:expires})
      .set(key('refresh',refresh),JSON.stringify(binding),{EX:lifetime}).exec();
    return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:expires};
  }

  const provider={
    clientsStore:{
      getClient:id=>load('client',id),
      async registerClient(client){
        if(client.redirect_uris.length<1||client.redirect_uris.length>8||client.redirect_uris.some(uri=>{
          const url=new URL(uri);
          return url.username||url.password||url.hash||!(/^[a-z0-9.-]+$/.test(url.hostname)||url.hostname==='[::1]')||
            !(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)));
        }))throw new InvalidClientMetadataError('Provide HTTPS or local loopback redirect URLs.');
        await save('client',client.client_id,client,90*86400);
        return client;
      }
    },
    async authorize(client,params,res){
      checkResource(params.resource);
      if(!opaque(params.codeChallenge))throw new InvalidGrantError('Use a SHA-256 PKCE challenge.');
      const id=random();
      await save('pending',id,{clientId:client.client_id,challenge:params.codeChallenge,redirect:params.redirectUri,state:params.state},600);
      res.redirect(303,mcpConsentPath+'?request='+id);
    },
    async challengeForAuthorizationCode(client,code){
      return (await codeFor(client,code)).challenge;
    },
    async exchangeAuthorizationCode(client,code,_verifier,redirect,requestedResource){
      checkResource(requestedResource);
      const authorization=await codeFor(client,code);
      if(authorization.redirect!==redirect)throw new InvalidGrantError('Redirect URL does not match.');
      const {binding}=authorization;
      const session=await grantSession(binding);
      if(!await redis.getDel(key('code',code)))throw new InvalidGrantError('Authorization code was already used.');
      await redis.set(mcpActive(binding.sessionHash),binding.family,{EX:Math.max(1,remaining(session))});
      return tokens(binding,session);
    },
    async exchangeRefreshToken(client,refresh,scopes,requestedResource){
      checkResource(requestedResource);
      const binding=opaque(refresh)&&await load('refresh',refresh);
      if(scopes?.length||!binding||binding.clientId!==client.client_id||await redis.get(mcpActive(binding.sessionHash))!==binding.family)
        throw new InvalidGrantError('This connection has expired. Reconnect to DryKraft.');
      const session=await grantSession(binding);
      if(!await redis.getDel(key('refresh',refresh)))throw new InvalidGrantError('Refresh token was already used.');
      return tokens(binding,session);
    },
    async verifyAccessToken(token){
      if(!/^dk_mcp_[A-Za-z0-9_-]{43}$/.test(token))throw new InvalidTokenError('Connect a DryKraft workspace.');
      try{
        const {binding,session}=await lookupMcpAccess(redis,token);
        const auth=await workspaceAuth({hostname:issuer.hostname,headers:{'x-workspace-id':binding.workspaceId}},session);
        const ttl=await redis.ttl(mcpGrant(tokenHash(token)));
        if(ttl<0)throw new InvalidTokenError('Connect a DryKraft workspace.');
        return {token,clientId:binding.clientId||'drykraft',scopes:[],resource,expiresAt:Date.now()/1000+ttl,extra:{mode:binding.mode,role:auth.role}};
      }catch(error){
        if(error instanceof AppError)throw new InvalidTokenError('Connect a DryKraft workspace.');
        throw error;
      }
    },
    async revokeToken(client,{token}){
      const binding=opaque(token)?await load('refresh',token):await loadAccess(token);
      if(binding?.clientId!==client.client_id)return;
      await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end",
        {keys:[mcpActive(binding.sessionHash)],arguments:[binding.family]});
    }
  };
  async function loadAccess(token){
    try{return (await lookupMcpAccess(redis,token)).binding;}
    catch(error){if(!(error instanceof AppError))throw error;return null;}
  }

  router.use(mcpAuthRouter({provider,issuerUrl:issuer,resourceServerUrl:resource,serviceDocumentationUrl:docs,resourceName:'DryKraft workspace'}));
  router.use(mcpConsentPath,sharedRateLimit('mcp-consent',{windowMs:60000,limit:40}),express.urlencoded({extended:false,limit:'4kb'}));
  const authenticateConsent=(req,res,next)=>authenticateAccount(req,res,error=>{
    if(error?.status===401&&req.method==='GET'&&opaque(req.query.request)){
      return res.redirect(303,'/login?mcp_request='+req.query.request);
    }
    next(error);
  });
  router.get(mcpConsentPath,authenticateConsent,async(req,res)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});
    const id=req.query.request;
    const pending=opaque(id)&&await load('pending',id);
    if(!pending)return res.status(400).type('html').send(consentPage('Connection request expired','<p>Return to your AI client and start the connection again.</p>'));
    const workspaces=(await pool.query(`SELECT w.id,w.name,w.slug FROM workspaces w JOIN memberships m ON m.tenant_id=w.id
      WHERE m.user_id=$1 AND COALESCE(w.settings->>'demo','false')<>'true' AND NOT platform_workspace_suspended(w.id) ORDER BY w.name`,[req.account.user_id])).rows;
    if(!workspaces.length)return res.status(403).type('html').send(consentPage('Set up a workspace','<p>Create a DryKraft workspace to connect your AI client.</p><p><a href="/login">Open DryKraft</a></p>'));
    const csrf=random();
    await save('form',csrf,{id,sessionHash:req.account.token_hash},600);
    const callback=new URL(pending.redirect);
    // Browsers apply the form's CSP to the OAuth callback after the same-origin POST.
    res.set('Content-Security-Policy',`default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self' ${callback.origin}`);
    res.type('html').send(consentPage('Connect a workspace',`<p>This connection will return to <strong>${escape(callback.hostname)}</strong>. You’re signed in as ${escape(req.account.email)}.</p>
      <form method="post" action="${mcpConsentPath}">
        <input type="hidden" name="csrf" value="${csrf}">
        <label for="workspace">Workspace</label>
        <select name="workspace" id="workspace">${workspaces.map(w=>`<option value="${escape(w.id)}"${w.id===req.account.tenant_id?' selected':''}>${escape(w.name)} · ${escape(w.slug)}</option>`).join('')}</select>
        <label for="mode">Access</label>
        <select name="mode" id="mode"><option value="read">Read only</option><option value="write">Read and write</option></select>
        <p>Your workspace permissions still apply. You can revoke the connection from Account security.</p>
        <div><button class="button primary" type="submit" name="choice" value="approve">Connect workspace</button>
        <button class="button" type="submit" name="choice" value="deny">Cancel</button></div>
      </form>`));
  });
  router.post(mcpConsentPath,authenticateConsent,async(req,res)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
    const {csrf,workspace,mode,choice}=req.body||{};
    const form=opaque(csrf)&&await load('form',csrf);
    const pending=form&&form.sessionHash===req.account.token_hash&&await load('pending',form.id);
    if(!pending||!await redis.getDel(key('form',csrf)))throw new AppError(400,'Return to your AI client and start the connection again.');
    const redirect=new URL(pending.redirect);
    if(pending.state)redirect.searchParams.set('state',pending.state);
    if(choice==='deny'){
      await redis.del(key('pending',form.id));
      redirect.searchParams.set('error','access_denied');
      return res.redirect(303,redirect.href);
    }
    if(choice!=='approve'||!['read','write'].includes(mode)||typeof workspace!=='string'||!/^[0-9a-f-]{36}$/.test(workspace))throw new AppError(400,'Select a workspace and access level.');
    const auth=await workspaceAuth({hostname:issuer.hostname,headers:{'x-workspace-id':workspace}},req.account);
    if(auth.workspace.settings?.demo||(mode==='write'&&auth.role==='viewer'))throw new AppError(403,'Your workspace role does not allow this connection.');
    if(!await redis.getDel(key('pending',form.id)))throw new AppError(400,'This connection request was already used.');
    const code=random();
    await save('code',code,{...pending,binding:{clientId:pending.clientId,workspaceId:workspace,mode,sessionHash:req.account.token_hash,family:random()}},120);
    redirect.searchParams.set('code',code);
    res.redirect(303,redirect.href);
  });

  router.all(resource.pathname,(req,res,next)=>{res.set('Cache-Control','no-store');next();},
    requireBearerAuth({verifier:provider,resourceMetadataUrl:metadataUrl,expectedResource:resource}),
    async(req,res)=>{
      if(req.method!=='POST')return res.status(405).set('Allow','POST').end();
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      const server=createDryKraftMcp({
        token:req.auth.token,base:apiOrigin,requestHost:issuer.host,accessMode:req.auth.extra.role==='viewer'?'read':req.auth.extra.mode,
        exportResult:({content,type,ext,operation})=>hostedExport(content,type,ext,operation)
      });
      res.once('close',()=>{void server.close();});
      await server.connect(transport);
      await transport.handleRequest(req,res,req.body);
    });
  app.use((req,res,next)=>req.get('host')?.split(':')[0]===issuer.hostname||(domain==='localhost'&&req.get('host')?.split(':')[0]==='localhost')?router(req,res,next):next());
}

function hostedExport(content,type,ext,operation){
  const limit=ext==='pdf'?1024*1024:ext?100000:24000;
  if(content.length>limit){
    throw Error('This result is too large to return over MCP. Narrow the request or download it in DryKraft.');
  }
  if(ext!=='pdf')return {content:[{type:'text',text:content.toString('utf8')}]};
  return {content:[{type:'resource',resource:{uri:'urn:drykraft:export:'+operation,mimeType:type,blob:content.toString('base64')}}]};
}

function consentPage(title,content){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | DryKraft</title><link rel="stylesheet" href="/website.css"><link rel="stylesheet" href="/project.css"></head><body><main class="mcp-consent"><a href="/"><img src="/logo-ui.png" width="131" height="51" alt="DryKraft"></a><h1>${title}</h1>${content}</main></body></html>`;
}
