import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {createClient} from 'redis';
import {base32,totp,matchingStep} from '../server/mfa.mjs';
import {pool,tenantTransaction} from '../server/db.mjs';
import {hashPassword,tokenHash,insertSession} from '../server/auth.mjs';
import {initializeWorkspace} from '../server/model.mjs';

test('RFC6238 SHA1 vectors, 64-bit time, bounded skew and single-use counters',()=>{
 const secret=base32(Buffer.from('12345678901234567890'));
 for(const [seconds,expected] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(totp(secret,Math.floor(seconds/30),8),expected);
 const time=1234567890000,step=Math.floor(time/30000),code=totp(secret,step);
 assert.equal(matchingStep(secret,code,step-1,time),step);assert.equal(matchingStep(secret,code,step,time),null);
 assert.equal(matchingStep(secret,totp(secret,step+2),-1,time),null);assert.equal(matchingStep(secret,'12345',-1,time),null);
});
function call(path,cookie='',body,method=body?'POST':'GET'){
 return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw),headers:res.headers,cookie:res.headers['set-cookie']?.[0].split(';')[0]||''}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});
}
test('MFA session boundary, encrypted setup, recovery races, invitation proof and rate limits',async()=>{
 const users=[randomUUID(),randomUUID()],tenants=[randomUUID(),randomUUID()],rawTokens=users.map(()=>randomBytes(32).toString('hex')),cookies=rawTokens.map(v=>'drykraft_session='+v),password='SyntheticAuthenticatorPass!2026',emails=users.map(v=>v+'@example.test');
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'}),redis=createClient({url:process.env.REDIS_URL});redis.on('error',()=>{});await admin.connect();await redis.connect();
 const reset=()=>redis.del('account-mfa:'+users[0]);const login=()=>call('/auth/login','',{email:emails[0],password});let enabledCookie;
 try{
  const stored=await hashPassword(password);
  for(let i=0;i<2;i++)await tenantTransaction(tenants[i],async c=>{await c.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[users[i],emails[i],'Synthetic authenticator reviewer',stored]);await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenants[i],'Synthetic authenticator workspace','mfa-'+tenants[i].slice(0,8)]);await initializeWorkspace(c,tenants[i]);await c.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,$3)",[users[i],tenants[i],i===0?'viewer':'owner']);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(rawTokens[i]),users[i],tenants[i]]);});
  assert.equal((await call('/account/mfa/setup','',{password})).status,401);
  assert.equal((await call('/account/mfa/setup',cookies[0],{password:'IncorrectPassword!'})).status,400);
  let setup=await call('/account/mfa/setup',cookies[0],{password});assert.equal(setup.status,200);assert.equal(setup.headers['cache-control'],'no-store');assert.match(setup.data.secret,/^[A-Z2-7]{32}$/);assert.match(setup.data.qr,/^data:image\/png;base64,/);
  const canceled=setup.data.setup_id;assert.equal((await call('/account/mfa/cancel',cookies[0],{setup_id:canceled})).status,200);assert.equal((await call('/account/mfa/enable',cookies[0],{setup_id:canceled,code:'000000'})).status,409);
  setup=await call('/account/mfa/setup',cookies[0],{password});await admin.query("UPDATE account_mfa SET pending_expires_at=now()-interval '1 second' WHERE user_id=$1",[users[0]]);assert.equal((await call('/account/mfa/enable',cookies[0],{setup_id:setup.data.setup_id,code:'000000'})).status,409);
  setup=await call('/account/mfa/setup',cookies[0],{password});assert.equal((await call('/account/mfa/cancel',cookies[0],{setup_id:canceled})).status,200,'Old cancellation cannot clear newer setup');
  const saved=(await admin.query('SELECT * FROM account_mfa WHERE user_id=$1',[users[0]])).rows[0];assert.ok(!saved.pending_ciphertext.includes(setup.data.secret));assert.equal(saved.secret_ciphertext,null);
  assert.equal((await pool.query('SELECT * FROM account_mfa')).rowCount,0,'Secrets require account RLS');
  assert.equal((await tenantTransaction(tenants[1],async c=>{await c.query("SELECT set_config('app.user_id',$1,true)",[users[1]]);return c.query('SELECT * FROM account_mfa WHERE user_id=$1',[users[0]]);})).rowCount,0);
  assert.equal((await call('/account/mfa/enable',cookies[1],{setup_id:setup.data.setup_id,code:'000000'})).status,409,'Another account cannot confirm setup');
  const setupCode=totp(setup.data.secret,Math.floor(Date.now()/30000));const enabled=await call('/account/mfa/enable',cookies[0],{setup_id:setup.data.setup_id,code:setupCode});assert.equal(enabled.status,200);enabledCookie=enabled.cookie;assert.equal(enabled.data.recovery_codes.length,10);
  assert.equal((await call('/session',cookies[0])).status,401,'Setup invalidates old devices');assert.equal((await call('/session',enabledCookie)).status,200);
  const status=await call('/account/security',enabledCookie);assert.equal(status.data.mfa.enabled,true);assert.equal(status.data.mfa.recovery_codes_remaining,10);assert.ok(!JSON.stringify(status.data).includes(setup.data.secret));assert.ok(!JSON.stringify(status.data).includes(enabled.data.recovery_codes[0]));
  await assert.rejects(tenantTransaction(tenants[0],c=>insertSession(c,{get:()=>null},users[0],tenants[0],stored)),/Authenticator verification/,'Internal session issuance cannot bypass MFA');
  let challenge=await login();assert.equal(challenge.status,200);assert.equal(challenge.data.mfa_required,true);assert.equal(challenge.cookie,'');
  assert.equal((await call('/auth/mfa','',{challenge:challenge.data.challenge,code:setupCode})).status,401,'Setup code cannot be replayed');
  await reset();
  // Competing requests for the same challenge/recovery proof serialize on the user lock.
  const race=await Promise.all([0,1].map(()=>call('/auth/mfa','',{challenge:challenge.data.challenge,code:enabled.data.recovery_codes[0]})));assert.deepEqual(race.map(r=>r.status).sort(),[200,401]);const signed=race.find(r=>r.status===200);assert.equal((await call('/session',signed.cookie)).status,200);
  challenge=await login();assert.equal((await call('/auth/mfa','',{challenge:challenge.data.challenge,code:enabled.data.recovery_codes[0]})).status,401,'Recovery code is consumed globally');
  await admin.query("UPDATE auth_mfa_challenges SET expires_at=now()-interval '1 second' WHERE user_id=$1",[users[0]]);assert.equal((await call('/auth/mfa','',{challenge:challenge.data.challenge,code:enabled.data.recovery_codes[1]})).status,401);
  challenge=await login();for(let i=0;i<5;i++)assert.equal((await call('/auth/mfa','',{challenge:challenge.data.challenge,code:'wrong'})).status,401);assert.equal((await call('/auth/mfa','',{challenge:challenge.data.challenge,code:enabled.data.recovery_codes[1]})).status,401,'Five failures exhaust the challenge');
  await reset();
  const invitation=await call('/settings/invitations',cookies[1],{email:emails[0],role:'member'});assert.equal(invitation.status,201);
  const accept={token:invitation.data.token,mode:'login',password};assert.equal((await call('/auth/invitations/accept','',accept)).status,401,'Invitation cannot issue a password-only session');
  assert.equal((await admin.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2',[tenants[1],users[0]])).rowCount,0,'Missing MFA does not accept or grant an invitation');
  const accepted=await call('/auth/invitations/accept','',{...accept,code:enabled.data.recovery_codes[1]});assert.equal(accepted.status,200);assert.equal((await call('/session',accepted.cookie)).status,200);
  challenge=await login();const regenerated=await call('/account/mfa/recovery',signed.cookie,{password,code:enabled.data.recovery_codes[2]});assert.equal(regenerated.status,200);assert.equal(regenerated.data.recovery_codes.length,10);
  assert.equal((await call('/session',signed.cookie)).status,401);assert.equal((await call('/session',accepted.cookie)).status,401);assert.equal((await call('/auth/mfa','',{challenge:challenge.data.challenge,code:enabled.data.recovery_codes[3]})).status,401,'Credential-management rotation invalidates outstanding challenges');
  challenge=await login();assert.equal((await call('/auth/mfa','',{challenge:challenge.data.challenge,code:enabled.data.recovery_codes[3]})).status,401,'Regeneration invalidates old recovery codes');
  const freshLogin=await call('/auth/mfa','',{challenge:challenge.data.challenge,code:regenerated.data.recovery_codes[0]});assert.equal(freshLogin.status,200);
  await reset();
  const passwordChanged=await call('/account/password',freshLogin.cookie,{current_password:password,new_password:'SyntheticChangedPass!2026',confirm_password:'SyntheticChangedPass!2026'});assert.equal(passwordChanged.status,200,'Password rotation preserves enabled MFA on its new session');assert.equal((await call('/session',passwordChanged.cookie)).status,200);
  const disabled=await call('/account/mfa/disable',passwordChanged.cookie,{password:'SyntheticChangedPass!2026',code:regenerated.data.recovery_codes[1]});assert.equal(disabled.status,200);assert.equal((await call('/session',passwordChanged.cookie)).status,401);
  const normal=await call('/auth/login','',{email:emails[0],password:'SyntheticChangedPass!2026'});assert.equal(normal.status,200);assert.equal(normal.data.ok,true);assert.ok(normal.cookie);
  assert.equal((await admin.query('SELECT 1 FROM account_mfa WHERE user_id=$1',[users[0]])).rowCount,0,'Disable removes the encrypted secret');
  const events=(await admin.query('SELECT action FROM account_security_events WHERE user_id=$1',[users[0]])).rows.map(r=>r.action);for(const action of ['mfa.enabled','mfa.recovery.used','mfa.recovery.regenerated','mfa.disabled'])assert.ok(events.includes(action));
  const pendingBeforeLimits=await call('/account/mfa/setup',normal.cookie,{password:'SyntheticChangedPass!2026'});assert.equal(pendingBeforeLimits.status,200);await reset();for(let i=0;i<10;i++)assert.equal((await call('/account/mfa/setup',normal.cookie,{password:'IncorrectPassword!'})).status,400);const limited=await call('/account/mfa/setup',normal.cookie,{password:'IncorrectPassword!'});assert.equal(limited.status,429);assert.ok(Number(limited.headers['retry-after'])>0);assert.equal((await call('/account/mfa/cancel',normal.cookie,{setup_id:pendingBeforeLimits.data.setup_id})).status,200,'Safe cancellation remains available after the proof budget is exhausted');assert.equal((await admin.query('SELECT pending_id FROM account_mfa WHERE user_id=$1',[users[0]])).rows[0].pending_id,null);
 }finally{try{await redis.del('account-mfa:'+users[0],'account-mfa:'+users[1]);for(const table of ['invitations','sessions','memberships','outbox','audit_events','workspace_billing','object_definitions','pipelines','dashboards'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,[tenants]);await admin.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[tenants]);await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);}finally{redis.destroy();await admin.end();await pool.end();}}
});
