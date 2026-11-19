import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {request} from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import {oauthCallback,oauthReturnOrigin,requireOAuthSessionHost} from '../server/oauth-callbacks.mjs';
import {oauthTokens,emailProfile} from '../server/outreach-providers.mjs';
import {pool} from '../server/db.mjs';
import {tokenHash} from '../server/auth.mjs';
import {calendarRouter,configureCalendarOAuth} from '../server/routes-calendar.mjs';
import {outreachRouter,outreachPublicRouter,configureOutreachOAuth} from '../server/routes-outreach.mjs';

const callback='http://127.0.0.1:4000/api/outreach/oauth/google/callback';
const environmentKeys=['APP_ORIGIN','APP_DOMAIN','GOOGLE_OAUTH_REDIRECT_URI','GOOGLE_CALENDAR_REDIRECT_URI','GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET','MS_OAUTH_CLIENT_ID','MS_OAUTH_CLIENT_SECRET'];
function environment(t,values){
 const before=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
 for(const key of environmentKeys)delete process.env[key];
 Object.assign(process.env,values);
 t.after(()=>{for(const key of environmentKeys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}});
}

test('registered Google override is shared without changing default or Microsoft callbacks',t=>{
 environment(t,{APP_ORIGIN:'https://app.example.com/'});
 assert.equal(oauthCallback('google','calendar'),'https://app.example.com/api/calendar/oauth/google/callback');
 process.env.GOOGLE_OAUTH_REDIRECT_URI=callback;
 assert.equal(oauthCallback('google','outreach'),callback);
 assert.equal(oauthCallback('google','calendar'),callback);
 assert.equal(oauthCallback('microsoft','calendar'),'https://app.example.com/api/calendar/oauth/microsoft/callback');
 process.env.GOOGLE_CALENDAR_REDIRECT_URI='https://app.example.com/api/calendar/oauth/google/callback';
 assert.equal(oauthCallback('google','calendar'),process.env.GOOGLE_CALENDAR_REDIRECT_URI);
 for(const invalid of ['https://example.com/other','https://example.com/api/outreach/oauth/google/callback?extra=1','https://user:secret@example.com/api/outreach/oauth/google/callback']){
  process.env.GOOGLE_OAUTH_REDIRECT_URI=invalid;
  assert.throws(()=>oauthCallback('google','outreach'),e=>e.status===503);
 }
});

test('local sign-in prevents a callback to another cookie host',t=>{
 environment(t,{APP_DOMAIN:'localhost',APP_ORIGIN:'http://127.0.0.1:5173'});
 assert.doesNotThrow(()=>requireOAuthSessionHost({hostname:'127.0.0.1'},callback));
 assert.throws(()=>requireOAuthSessionHost({hostname:'localhost'},callback),e=>e.status===409&&e.message.includes('http://127.0.0.1:5173'));
 process.env.APP_DOMAIN='example.com';
 assert.doesNotThrow(()=>requireOAuthSessionHost({hostname:'workspace.example.com'},'https://app.example.com/api/outreach/oauth/google/callback'));
});

test('OAuth returns only to the initiating authenticated workspace or configured app origin',t=>{
 environment(t,{APP_DOMAIN:'drykraft.com',APP_ORIGIN:'https://app.drykraft.com/'});
 const req=(hostname,slug='drykraftnew')=>({hostname,auth:{workspace:{slug}}});
 assert.equal(oauthReturnOrigin(req('drykraftnew.drykraft.com')),'https://drykraftnew.drykraft.com');
 assert.equal(oauthReturnOrigin(req('another-team.drykraft.com','another-team')),'https://another-team.drykraft.com');
 for(const request of [req('app.drykraft.com'),req('other.drykraft.com'),req('drykraftnew.drykraft.com.evil.example'),req('evil.example'),req('evil.example','//evil.example'),{hostname:'drykraftnew.drykraft.com'}]){
  assert.equal(oauthReturnOrigin(request),'https://app.drykraft.com');
 }
 process.env.APP_DOMAIN='localhost';process.env.APP_ORIGIN='http://127.0.0.1:5173';
 assert.equal(oauthReturnOrigin(req('workspace.localhost','workspace')),'http://127.0.0.1:5173');
});

test('real OAuth routes share the registered callback and preserve scopes, session binding and single-use state',async t=>{
 environment(t,{APP_DOMAIN:'localhost',APP_ORIGIN:'http://127.0.0.1:5173',GOOGLE_OAUTH_REDIRECT_URI:callback,GOOGLE_OAUTH_CLIENT_ID:'synthetic-client',GOOGLE_OAUTH_CLIENT_SECRET:'synthetic-secret',MS_OAUTH_CLIENT_ID:'synthetic-ms-client',MS_OAUTH_CLIENT_SECRET:'synthetic-ms-secret'});
 const stateStore=new Map(),token=randomBytes(32).toString('hex'),otherToken=randomBytes(32).toString('hex'),tenantId=randomUUID(),userId=randomUUID();
 const redis={
  async set(key,value,options){assert.equal(options.EX,600);stateStore.set(key,value);},
  async get(key){return stateStore.get(key)||null;},
  async getDel(key){const value=stateStore.get(key)||null;stateStore.delete(key);return value;}
 };
 // Exercise authentication through the real callback middleware with synthetic
 // session rows; no database, Redis service or provider account is contacted.
 t.mock.method(pool,'query',async(sql,params)=>{
  if(sql.startsWith('SELECT s.*'))return {rows:[{user_id:userId,tenant_id:tenantId,token_hash:params[0],name:'Synthetic user',email:'synthetic@example.test'}]};
  if(sql.startsWith('UPDATE sessions'))return {rows:[]};
  throw Error('Unexpected database query in OAuth routing check.');
 });
 configureCalendarOAuth(redis);configureOutreachOAuth(redis);
 const app=express();app.use(express.json(),cookieParser());
 app.use((req,res,next)=>{req.auth={user:{id:userId},workspace:{id:tenantId,slug:req.get('x-workspace-slug')||'workspace',settings:{}},role:req.get('x-role')||'owner'};next();});
 app.use('/api/calendar',calendarRouter);
 app.use('/api/outreach',outreachPublicRouter,outreachRouter);
 app.use((error,req,res,next)=>res.status(error.status||400).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port;
 async function call(path,{method='GET',session=token,headers={}}={}){
  if(headers.host)return new Promise((resolve,reject)=>{
   const req=request(origin+path,{method,headers:{cookie:'drykraft_session='+session,...headers}},res=>{let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve(new Response(body,{status:res.statusCode,headers:res.headers})));});
   req.on('error',reject);req.end();
  });
  return fetch(origin+path,{method,redirect:'manual',headers:{cookie:'drykraft_session='+session,...headers}});
 }
 async function start(area,options={}){
  const response=await call('/api/'+area+'/oauth/google',{method:'POST',...options});assert.equal(response.status,200);
  const url=new URL((await response.json()).url);assert.equal(url.searchParams.get('redirect_uri'),callback);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const state=url.searchParams.get('state'),saved=JSON.parse(stateStore.get('drykraft:'+area+':oauth:'+state));
  assert.equal(saved.redirectUri,callback);assert.equal(saved.sessionHash,tokenHash(token));assert.equal(saved.returnOrigin,'http://127.0.0.1:5173');
  assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(saved.verifier).digest('base64url'));
  return {url,state};
 }
 const calendar=await start('calendar',{headers:{'x-role':'member'}});
 assert.ok(calendar.url.searchParams.get('scope').includes('/auth/calendar.events'));
 assert.ok(!calendar.url.searchParams.get('scope').includes('/auth/gmail'));
 const returned='/api/outreach/oauth/google/callback?state='+calendar.state+'&error=access_denied';
 assert.equal((await call(returned.replace('/google/','/microsoft/'))).status,400,'Another provider cannot use the shared Google callback state');
 assert.ok(stateStore.has('drykraft:calendar:oauth:'+calendar.state));
 assert.equal((await call(returned,{session:otherToken})).status,403,'A different signed-in session cannot consume Calendar state');
 assert.ok(stateStore.has('drykraft:calendar:oauth:'+calendar.state));
 const cancelled=await call(returned);assert.equal(cancelled.status,302);
 assert.equal(cancelled.headers.get('location'),'http://127.0.0.1:5173/calendar/connections?oauth=cancelled');
 assert.equal((await call(returned)).status,400,'Shared Calendar callback cannot be replayed');
 const email=await start('outreach');assert.ok(email.url.searchParams.get('scope').includes('/auth/gmail.send'));
 const emailCancel=await call('/api/outreach/oauth/google/callback?state='+email.state+'&error=access_denied');
 assert.equal(emailCancel.headers.get('location'),'http://127.0.0.1:5173/outreach/connections?oauth=cancelled');
 const microsoft=await call('/api/outreach/oauth/microsoft/callback?state='+email.state+'&error=access_denied');assert.equal(microsoft.status,400);
 const outlookResponse=await call('/api/outreach/oauth/microsoft',{method:'POST'});assert.equal(outlookResponse.status,200);
 const outlookUrl=new URL((await outlookResponse.json()).url),outlookState=outlookUrl.searchParams.get('state'),outlookSaved=JSON.parse(stateStore.get('drykraft:outreach:oauth:'+outlookState));
 assert.equal(outlookUrl.origin,'https://login.microsoftonline.com');assert.equal(outlookUrl.pathname,'/common/oauth2/v2.0/authorize');
 assert.equal(outlookUrl.searchParams.get('redirect_uri'),'http://127.0.0.1:5173/api/outreach/oauth/microsoft/callback');
 assert.equal(outlookUrl.searchParams.get('client_id'),'synthetic-ms-client');assert.equal(outlookUrl.searchParams.get('response_mode'),'query');
 assert.deepEqual(new Set(outlookUrl.searchParams.get('scope').split(' ')),new Set(['Mail.Send','Mail.Read','offline_access','User.Read']));
 assert.equal(outlookUrl.searchParams.get('code_challenge_method'),'S256');assert.equal(outlookUrl.searchParams.get('code_challenge'),createHash('sha256').update(outlookSaved.verifier).digest('base64url'));
 const outlookReturn='/api/outreach/oauth/microsoft/callback?state='+outlookState+'&error=access_denied';
 assert.equal((await call(outlookReturn,{session:otherToken})).status,403);assert.ok(stateStore.has('drykraft:outreach:oauth:'+outlookState));
 assert.equal((await call(outlookReturn.replace('/microsoft/','/google/'))).status,403);assert.ok(stateStore.has('drykraft:outreach:oauth:'+outlookState));
 assert.equal((await call(outlookReturn)).headers.get('location'),'http://127.0.0.1:5173/outreach/connections?oauth=cancelled');
 assert.equal((await call(outlookReturn)).status,400,'Outlook callback cannot be replayed');
 assert.equal((await call('/api/outreach/oauth/microsoft',{method:'POST',headers:{'x-role':'member'}})).status,403);
 delete process.env.MS_OAUTH_CLIENT_SECRET;
 assert.equal((await call('/api/outreach/oauth/microsoft',{method:'POST'})).status,503,'Outlook cannot start without server app credentials');
 const before=stateStore.size;
 const wrongHost=await new Promise((resolve,reject)=>{
  const req=request(origin+'/api/calendar/oauth/google',{method:'POST',headers:{host:'localhost',cookie:'drykraft_session='+token}},res=>{let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});
  req.on('error',reject);req.end();
 });
 assert.equal(wrongHost.status,409);assert.ok(wrongHost.body.error.includes('http://127.0.0.1:5173'));assert.equal(stateStore.size,before);
 assert.equal((await call('/api/calendar/oauth/google',{method:'POST',headers:{'x-role':'viewer'}})).status,403);
 assert.equal((await call('/api/outreach/oauth/google',{method:'POST',headers:{'x-role':'member'}})).status,403);
 // Workspace origins vary while Google's registered callback stays identical.
 process.env.APP_DOMAIN='drykraft.com';process.env.APP_ORIGIN='https://app.drykraft.com';
 const registered='https://app.drykraft.com/api/outreach/oauth/google/callback';
 process.env.GOOGLE_OAUTH_REDIRECT_URI=registered;process.env.MS_OAUTH_CLIENT_SECRET='synthetic-ms-secret';
 for(const slug of ['drykraftnew','another-team'])for(const [area,provider] of [['outreach','google'],['calendar','google'],['outreach','microsoft']]){
  const host=slug+'.drykraft.com';
  const started=await call('/api/'+area+'/oauth/'+provider,{method:'POST',headers:{host,'x-workspace-slug':slug}});assert.equal(started.status,200);
  const url=new URL((await started.json()).url),state=url.searchParams.get('state'),key='drykraft:'+area+':oauth:'+state,saved=JSON.parse(stateStore.get(key));
  const expectedCallback=provider==='google'?registered:'https://app.drykraft.com/api/outreach/oauth/microsoft/callback';
  assert.equal(url.searchParams.get('redirect_uri'),expectedCallback);assert.equal(saved.returnOrigin,'https://'+host);
  const callbackPath=new URL(expectedCallback).pathname+'?state='+state+'&error=access_denied&returnOrigin=https://evil.example';
  assert.equal((await call(callbackPath,{session:otherToken,headers:{host:'app.drykraft.com'}})).status,403);
  assert.ok(stateStore.has(key),'Wrong session cannot consume workspace return state');
  const cancelled=await call(callbackPath,{headers:{host:'app.drykraft.com'}});assert.equal(cancelled.status,302);
  assert.equal(cancelled.headers.get('location'),'https://'+host+'/'+area+'/connections?oauth=cancelled');
  assert.equal((await call(callbackPath,{headers:{host:'app.drykraft.com'}})).status,400,'Workspace return state cannot be replayed');
 }
 // Grants begun before this release retain their original app-origin fallback.
 const legacy=await call('/api/outreach/oauth/google',{method:'POST'}),legacyUrl=new URL((await legacy.json()).url),legacyState=legacyUrl.searchParams.get('state'),legacyKey='drykraft:outreach:oauth:'+legacyState,legacySaved=JSON.parse(stateStore.get(legacyKey));
 delete legacySaved.returnOrigin;stateStore.set(legacyKey,JSON.stringify(legacySaved));
 assert.equal((await call('/api/outreach/oauth/google/callback?state='+legacyState+'&error=access_denied')).headers.get('location'),'https://app.drykraft.com/outreach/connections?oauth=cancelled');
});

test('Outlook exchanges its registered callback, refreshes tokens and identifies the connected mailbox',async t=>{
 environment(t,{MS_OAUTH_CLIENT_ID:'synthetic-ms-client',MS_OAUTH_CLIENT_SECRET:'synthetic-ms-secret'});
 const redirect='http://127.0.0.1:5173/api/outreach/oauth/microsoft/callback';
 const tokens=await oauthTokens('microsoft',{grant_type:'authorization_code',code:'synthetic-code',redirect_uri:redirect,code_verifier:'synthetic-verifier'},async(url,options)=>{
  assert.equal(url,'https://login.microsoftonline.com/common/oauth2/v2.0/token');assert.equal(options.method,'POST');
  const fields=new URLSearchParams(options.body);
  assert.equal(fields.get('client_id'),'synthetic-ms-client');assert.equal(fields.get('client_secret'),'synthetic-ms-secret');assert.equal(fields.get('redirect_uri'),redirect);assert.equal(fields.get('code_verifier'),'synthetic-verifier');
  return {body:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600}};
 });
 assert.equal(tokens.refreshToken,'synthetic-refresh');assert.ok(tokens.expiresAt>Date.now());
 const refreshed=await oauthTokens('microsoft',{grant_type:'refresh_token',refresh_token:tokens.refreshToken},async(url,options)=>{
  const fields=new URLSearchParams(options.body);assert.equal(fields.get('grant_type'),'refresh_token');assert.equal(fields.get('refresh_token'),'synthetic-refresh');
  return {body:{access_token:'synthetic-renewed',expires_in:3600}};
 });
 assert.equal(refreshed.refreshToken,'synthetic-refresh');
 for(const body of [{mail:'sender@outlook.com'},{mail:null,userPrincipalName:'sender@outlook.com'}]){
  assert.equal(await emailProfile('microsoft',refreshed,async(url,options)=>{
   assert.equal(url,'https://graph.microsoft.com/v1.0/me');assert.equal(options.headers.Authorization,'Bearer synthetic-renewed');return {body};
  }),'sender@outlook.com');
 }
});
