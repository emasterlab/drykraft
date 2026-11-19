import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {platformPool} from '../server/platform-db.mjs';
import {initializeWorkspace,builtIns,defaultStages,defaultWidgets} from '../server/model.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {totp} from '../server/mfa.mjs';
import {billingAccess,requireBillingAccess} from '../server/billing.mjs';
import {encryptCredential} from '../server/automation.mjs';
import {entitlementMeters,entitlementFeatures,workspaceEntitlements} from '../server/entitlements.mjs';

const origin=process.env.TEST_API_ORIGIN||'http://localhost:4000';
function call(path,method='GET',body,cookie='',headers={}){return new Promise((resolve,reject)=>{
 const req=http.request(origin+'/api'+path,{method,headers:{'content-type':'application/json',cookie,...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks)),cookie:res.headers['set-cookie']?.[0],cache:res.headers['cache-control']})}catch{reject(Error('Platform endpoint returned an invalid JSON response.'))}});});
 req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Platform check timed out')));if(body)req.write(JSON.stringify(body));req.end();
});}
async function fixture(fn){
 const ids=[],tenants=[],users=[],admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 const originalSettings=(await admin.query('SELECT version,data FROM platform_settings WHERE id=true')).rows[0];
 async function account(role='owner'){
  const id=randomUUID(),email=id+'@example.test',password='Sample-platform-'+randomBytes(12).toString('hex');ids.push(id);
  await admin.query('INSERT INTO platform_accounts(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[id,email,'Sample platform '+role,await hashPassword(password),role]);
  const challenge=(await call('/sa/login','POST',{email,password})).data;
  assert.equal(challenge.enrollment_required,true);
  assert.equal((await call('/sa/session')).status,401);
  const setup=(await call('/sa/mfa/setup','POST',{challenge:challenge.challenge})).data;
  assert.ok(setup.secret);assert.ok(setup.qr.startsWith('data:image/png;'));
  const confirmed=await call('/sa/mfa','POST',{challenge:challenge.challenge,code:totp(setup.secret,Math.floor(Date.now()/30000))});assert.equal(confirmed.status,200);
  assert.equal(confirmed.data.recovery_codes.length,10);
  return {id,email,password,secret:setup.secret,codes:confirmed.data.recovery_codes,cookie:confirmed.cookie.split(';')[0],cookieHeader:confirmed.cookie,challenge:challenge.challenge};
 }
 async function workspace(){
  const id=randomUUID(),user=randomUUID(),raw=randomBytes(32).toString('hex'),password='Sample-customer-password-123',stored=await hashPassword(password);tenants.push(id);users.push(user);
  await tenantTransaction(id,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[id,'Sample platform checks','sa-'+id.slice(0,8)]);await initializeWorkspace(c,id);await c.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[user,user+'@example.test','Sample customer owner',stored]);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[id,user]);await c.query("INSERT INTO sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(raw),id,user]);});return {id,userId:user,email:user+'@example.test',password,cookie:'drykraft_session='+raw};
 }
 try{await fn({account,workspace,admin,ids,tenants,users});}
 finally{
  try{await admin.query('BEGIN');await admin.query('UPDATE platform_settings SET version=$1,data=$2,updated_by=NULL WHERE id=true AND updated_by=ANY($3::uuid[])',[originalSettings.version,originalSettings.data,ids]);await admin.query('DELETE FROM platform_audit WHERE actor_id=ANY($1::uuid[]) OR resource_id=ANY($1::uuid[])',[ids]);await admin.query('DELETE FROM platform_user_controls WHERE user_id=ANY($1::uuid[])',[users]);await admin.query('DELETE FROM platform_provisioning_operations WHERE tenant_id=ANY($1::uuid[])',[tenants]);await admin.query('DELETE FROM platform_workspace_invitations WHERE tenant_id=ANY($1::uuid[])',[tenants]);await admin.query('DELETE FROM platform_workspace_controls WHERE tenant_id=ANY($1::uuid[])',[tenants]);await admin.query('DELETE FROM platform_auth_challenges WHERE account_id=ANY($1::uuid[])',[ids]);await admin.query('DELETE FROM platform_sessions WHERE account_id=ANY($1::uuid[])',[ids]);await admin.query('DELETE FROM platform_workspace_entitlements WHERE tenant_id=ANY($1::uuid[])',[tenants]);await admin.query('DELETE FROM platform_plan_versions WHERE created_by=ANY($1::uuid[])',[ids]);await admin.query('DELETE FROM platform_plans WHERE id<>$1 AND NOT EXISTS(SELECT 1 FROM platform_plan_versions v WHERE v.plan_id=platform_plans.id)',['00000000-0000-4000-8000-000000000001']);await admin.query('DELETE FROM platform_accounts WHERE id=ANY($1::uuid[])',[ids]);for(const id of tenants){for(const table of ['executions','workflow_versions','service_accounts','workflows','outreach_connections','calendar_connections','customer_webhooks','credentials','calendars','records','object_definitions','pipelines','dashboards','outbox','audit_events','usage_ledger','workspace_billing','sessions','invitations','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[id]);await admin.query('DELETE FROM workspaces WHERE id=$1',[id]);}for(const table of ['auth_mfa_challenges','account_mfa','account_security_events'])await admin.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[users]);await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}finally{await admin.end();}
 }
}
test('Platform sign-in enforces separate credentials, mandatory MFA, one-use recovery, short sessions and host boundaries',async()=>fixture(async({account,workspace,admin})=>{
 const customer=await workspace();assert.equal((await call('/sa/overview','GET',null,customer.cookie)).status,401);
 const owner=await account();const session=await call('/sa/session','GET',null,owner.cookie);assert.equal(session.status,200);assert.equal(session.cache,'no-store');assert.equal(session.data.account.mfa_enabled,true);assert.equal(session.data.idle_timeout_seconds,900);
 assert.match(owner.cookieHeader,/HttpOnly/);assert.match(owner.cookieHeader,/Path=\/api\/sa/);assert.match(owner.cookieHeader,/SameSite=Strict/);assert.ok(!owner.cookieHeader.includes('Domain='));
 assert.equal((await call('/session','GET',null,owner.cookie)).status,401);
 assert.equal((await call('/sa/overview','GET',null,owner.cookie,{host:'untrusted.localhost'})).status,404);
 assert.equal((await call('/sa/logout','POST',{},owner.cookie,{origin:'http://outside.example'})).status,403);
 assert.equal((await call('/sa/mfa','POST',{challenge:owner.challenge,code:owner.codes[0]})).status,401);
 const login=await call('/sa/login','POST',{email:owner.email,password:owner.password});assert.equal(login.data.mfa_required,true);
 assert.equal((await call('/sa/mfa/setup','POST',{challenge:login.data.challenge})).status,409);
 // Enrollment's current TOTP is already consumed. Recovery authorizes this challenge exactly once.
 const step=(await admin.query('SELECT last_step FROM platform_accounts WHERE id=$1',[owner.id])).rows[0].last_step;
 assert.equal((await call('/sa/mfa','POST',{challenge:login.data.challenge,code:totp(owner.secret,Number(step))})).status,401);
 let done=await call('/sa/mfa','POST',{challenge:login.data.challenge,code:owner.codes[0]});assert.equal(done.status,200);const renewed=done.cookie.split(';')[0];
 assert.equal((await admin.query('SELECT cardinality(recovery_hashes) AS n FROM platform_accounts WHERE id=$1',[owner.id])).rows[0].n,9);
 const again=(await call('/sa/login','POST',{email:owner.email,password:owner.password})).data;
 assert.equal((await call('/sa/mfa','POST',{challenge:again.challenge,code:owner.codes[0]})).status,401);
 await admin.query("UPDATE platform_sessions SET last_seen_at=now()-interval '16 minutes' WHERE account_id=$1",[owner.id]);assert.equal((await call('/sa/session','GET',null,renewed)).status,401);
 await admin.query("UPDATE platform_auth_challenges SET expires_at=now()-interval '1 second' WHERE account_id=$1",[owner.id]);assert.equal((await call('/sa/mfa','POST',{challenge:again.challenge,code:owner.codes[1]})).status,401);
 assert.equal((await call('/sa/login','POST',{email:owner.email,password:'Wrong-password'})).status,401);
}));
test('Platform management isolates customer data, protects immutable audit, serializes state and enforces suspension in shared access checks',async()=>fixture(async({account,workspace,admin})=>{
 const owner=await account(),support=await account('support'),w=await workspace();
 assert.equal((await call('/sa/overview','GET',null,owner.cookie)).data.trial_workspaces,1);
 assert.equal((await call('/sa/workspaces','GET',null,support.cookie)).status,200);
 assert.equal((await call('/sa/accounts','GET',null,support.cookie)).status,403);
 assert.equal((await call('/sa/billing','GET',null,support.cookie)).status,403);
 assert.equal((await call('/sa/workspaces/'+w.id+'/state','POST',{version:1,suspended:true,reason:'Synthetic suspension checks'},support.cookie)).status,403);
 const details=await call('/sa/workspaces/'+w.id,'GET',null,owner.cookie);assert.equal(details.status,200);assert.equal(details.data.members,1);assert.equal(details.data.version,1);assert.equal(details.data.suspended,false);
 const changes=await Promise.all([call('/sa/workspaces/'+w.id+'/state','POST',{version:1,suspended:true,reason:'Synthetic parallel suspension one'},owner.cookie),call('/sa/workspaces/'+w.id+'/state','POST',{version:1,suspended:true,reason:'Synthetic parallel suspension two'},owner.cookie)]);assert.deepEqual(changes.map(r=>r.status).sort(),[200,409]);
 assert.equal((await call('/session','GET',null,w.cookie)).status,403);
 await tenantTransaction(w.id,async c=>{assert.equal((await billingAccess(c,w.id)).access,false);await assert.rejects(requireBillingAccess(c,w.id),e=>e.status===403);});
 assert.equal((await call('/sa/workspaces/'+w.id+'/state','POST',{version:1,suspended:false,reason:'Synthetic stale restore attempt'},owner.cookie)).status,409);
 assert.equal((await call('/sa/workspaces/'+w.id+'/state','POST',{version:2,suspended:false,reason:'Synthetic accepted restore check'},owner.cookie)).status,200);
 assert.equal((await call('/session','GET',null,w.cookie)).status,200);
 await platformPool.query('SELECT publish_platform_workspace_state($1,$2)',[w.id,owner.id]);await platformPool.query('SELECT publish_platform_workspace_state($1,$2)',[w.id,owner.id]);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM outbox WHERE tenant_id=$1 AND type IN ('platform.workspace.suspended','platform.workspace.restored')",[w.id])).rows[0].n,2);
 await tenantTransaction(w.id,async c=>assert.equal((await billingAccess(c,w.id)).access,true));
 const events=(await admin.query('SELECT type FROM outbox WHERE tenant_id=$1',[w.id])).rows.map(x=>x.type);assert.ok(events.includes('platform.workspace.suspended'));assert.ok(events.includes('platform.workspace.restored'));
 const audit=await call('/sa/audit?resource_id='+w.id,'GET',null,owner.cookie);assert.equal(audit.status,200);assert.ok(audit.data.items.some(x=>x.action==='platform.workspace.suspended'));assert.ok(!JSON.stringify(audit.data).includes(owner.password));
 for(const t of ['platform_accounts','platform_sessions','platform_auth_challenges','platform_audit','platform_settings','platform_workspace_controls']){
  const flags=(await admin.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('drykraft_app',$1,'SELECT') AS app,has_table_privilege('drykraft_worker',$1,'SELECT') AS worker FROM pg_class WHERE oid=$1::regclass",[t])).rows[0];assert.ok(flags.relrowsecurity&&flags.relforcerowsecurity);assert.equal(flags.app,false);assert.equal(flags.worker,false);
 }
 for(const sql of ['SELECT password_hash FROM users','SELECT * FROM records','SELECT * FROM credentials','UPDATE platform_audit SET reason=reason','DELETE FROM platform_audit'])await assert.rejects(platformPool.query(sql),e=>e.code==='42501');
 const role=(await admin.query("SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname='drykraft_platform'")).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false,rolcreaterole:false});
}));
test('Platform owner changes revoke sessions and retain an owner under concurrent governance changes',async()=>fixture(async({account,admin})=>{
 const one=await account(),two=await account();
 const body=(a)=>({name:'Sample former owner',role:'viewer',disabled:false,version:1,reason:'Synthetic concurrent governance checks'});
 const changed=await Promise.all([call('/sa/accounts/'+two.id,'PUT',body(two),one.cookie),call('/sa/accounts/'+one.id,'PUT',body(one),two.cookie)]);
 assert.ok(changed.some(r=>r.status===200));assert.ok(changed.some(r=>[401,409].includes(r.status)));
 const current=(await admin.query('SELECT id,role,version FROM platform_accounts WHERE id=ANY($1::uuid[])',[[one.id,two.id]])).rows;
 assert.equal(current.filter(a=>a.role==='owner').length,1);
 const kept=current.find(a=>a.role==='owner'),keptCookie=kept.id===one.id?one.cookie:two.cookie;
 const downgraded=current.find(a=>a.role==='viewer'),oldCookie=downgraded.id===one.id?one.cookie:two.cookie;
 assert.equal((await call('/sa/session','GET',null,oldCookie)).status,401);
 assert.equal((await call('/sa/accounts/'+kept.id,'PUT',{...body(kept),version:kept.version},keptCookie)).status,409);
 const created=await call('/sa/accounts','POST',{name:'Sample billing operator',email:randomUUID()+'@example.test',password:'Sample-billing-password-123',role:'billing',reason:'Synthetic managed platform account'},keptCookie);assert.equal(created.status,201);
 // This extra account belongs to this fixture as well.
 await admin.query('DELETE FROM platform_audit WHERE resource_id=$1',[created.data.id]);await admin.query('DELETE FROM platform_accounts WHERE id=$1',[created.data.id]);
 assert.equal((await call('/sa/settings','PUT',{version:1,reason:'Invalid unknown settings injection',data:{signup_enabled:true,support_email:'support@example.test',maintenance_message:'',credential:'forbidden'}},keptCookie)).status,400);
}));
test('Platform settings affect registration and public notices while password rotation invalidates other sessions',async()=>fixture(async({account,admin})=>{
 const owner=await account();
 const settings=(await call('/sa/settings','GET',null,owner.cookie)).data;
 const changed=await call('/sa/settings','PUT',{version:settings.version,reason:'Synthetic registration and notice checks',data:{signup_enabled:false,support_email:'support@example.test',maintenance_message:'Sample maintenance notice'}},owner.cookie);assert.equal(changed.status,200);
 const meta=(await call('/meta')).data;assert.equal(meta.platform.maintenance_message,'Sample maintenance notice');assert.equal(meta.platform.support_email,'support@example.test');assert.deepEqual(Object.keys(meta.platform).sort(),['maintenance_message','support_email']);
 assert.equal((await call('/auth/signup','POST',{email:randomUUID()+'@example.test',name:'Blocked sample signup',password:'Sample-password-123456'})).status,403);
 assert.equal((await call('/sa/settings','PUT',{version:settings.version,reason:'Synthetic stale settings update',data:settings.data},owner.cookie)).status,409);
 const challenge=(await call('/sa/login','POST',{email:owner.email,password:owner.password})).data.challenge;
 const signed=await call('/sa/mfa','POST',{challenge,code:owner.codes[0]});assert.equal(signed.status,200);const other=signed.cookie.split(';')[0];
 const rotated=await call('/sa/password','POST',{current_password:owner.password,new_password:'Sample-next-password-123456',code:owner.codes[1]},owner.cookie);assert.equal(rotated.status,200);
 assert.equal((await call('/sa/session','GET',null,other)).status,401);assert.equal((await call('/sa/session','GET',null,owner.cookie)).status,401);assert.equal((await call('/sa/session','GET',null,rotated.cookie.split(';')[0])).status,200);
 assert.equal((await admin.query('SELECT auth_version FROM platform_accounts WHERE id=$1',[owner.id])).rows[0].auth_version,2);
 assert.equal((await call('/sa/login','POST',{email:owner.email,password:owner.password})).status,401);
}));
test('Customer account disable serializes with sign-in, removes sessions and challenges, preserves history and requires fresh sign-in after restore',async()=>fixture(async({account,workspace,admin})=>{
 const owner=await account(),support=await account('support'),w=await workspace();
 const before=(await admin.query('SELECT password_hash,auth_version,mfa_enabled FROM users WHERE id=$1',[w.userId])).rows[0];
 const detail=await call('/sa/users/'+w.userId,'GET',null,support.cookie);assert.equal(detail.status,200);assert.equal(detail.data.active_sessions,1);assert.equal(detail.data.workspace_count,1);assert.equal(detail.data.mfa_enabled,false);assert.ok(!JSON.stringify(detail.data).includes(before.password_hash));
 assert.equal((await call('/sa/users/'+w.userId+'/workspaces','GET',null,support.cookie)).data.items[0].id,w.id);
 const change={disabled:true,version:1,reason:'Sample account access investigation'};
 assert.equal((await call('/sa/users/'+w.userId+'/state','POST',change,support.cookie)).status,403);
 // Hold the exact customer lock to prove status waits instead of crossing session issuance.
 const lock=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL});await lock.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[w.userId]);
 const pending=call('/sa/users/'+w.userId+'/state','POST',change,owner.cookie);
 let waiting=false;try{for(let n=0;n<100;n++){waiting=!!(await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='drykraft_platform' AND wait_event_type='Lock' AND query LIKE 'SELECT set_platform_customer_state%'")).rowCount;if(waiting)break;await new Promise(r=>setTimeout(r,10));}assert.ok(waiting,'Customer status waits for the customer row lock');}finally{await lock.query('COMMIT');await lock.end();}
 const disabled=await pending;assert.equal(disabled.status,200);assert.equal(disabled.data.disabled,true);assert.equal(disabled.data.active_sessions,0);assert.equal(disabled.data.version,2);
 assert.equal((await call('/session','GET',null,w.cookie)).status,401);
 assert.equal((await call('/auth/login','POST',{email:w.email,password:w.password})).status,401);
 const after=(await admin.query('SELECT password_hash,auth_version,mfa_enabled FROM users WHERE id=$1',[w.userId])).rows[0];assert.equal(after.password_hash,before.password_hash);assert.equal(after.mfa_enabled,before.mfa_enabled);assert.equal(after.auth_version,before.auth_version+1);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM memberships WHERE user_id=$1',[w.userId])).rows[0].n,1);
 assert.equal((await call('/sa/users/'+w.userId+'/state','POST',{...change,disabled:false},owner.cookie)).status,409);
 const races=await Promise.all([0,1].map(()=>call('/sa/users/'+w.userId+'/state','POST',{...change,disabled:false,version:2},owner.cookie)));assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
 assert.equal((await call('/session','GET',null,w.cookie)).status,401);
 const login=await call('/auth/login','POST',{email:w.email,password:w.password});assert.equal(login.status,200);assert.equal((await call('/session','GET',null,login.cookie.split(';')[0])).status,200);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM outbox WHERE tenant_id=$1 AND type IN ('platform.user.suspended','platform.user.restored')",[w.id])).rows[0].n,2);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM platform_audit WHERE resource_id=$1 AND action IN ('platform.user.suspended','platform.user.restored') AND length(reason)>=10",[w.userId])).rows[0].n,2);
 for(const t of ['platform_user_controls','platform_workspace_invitations','platform_provisioning_operations']){
  const flags=(await admin.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('drykraft_app',$1,'SELECT') AS app,has_table_privilege('drykraft_worker',$1,'SELECT') AS worker FROM pg_class WHERE oid=$1::regclass",[t])).rows[0];assert.ok(flags.relrowsecurity&&flags.relforcerowsecurity);assert.equal(flags.app,false);assert.equal(flags.worker,false);
 }
 await assert.rejects(pool.query('SELECT set_platform_customer_state($1,$2,true,3,$3)',[w.userId,owner.id,change.reason]),e=>e.code==='42501');
 await assert.rejects(platformPool.query('UPDATE platform_provisioning_operations SET request_hash=request_hash'),e=>e.code==='42501');
}));
test('Workspace provisioning validates configuration, commits once on retries and grants owner access only after verified invitation acceptance',async()=>fixture(async({account,workspace,admin,tenants,users})=>{
 const owner=await account(),support=await account('support'),existing=await workspace();
 const body={request_id:randomUUID(),name:'Sample provisioned workspace',slug:'provision-'+randomBytes(5).toString('hex'),owner_email:existing.email,currency:'KWD',currencies:['KWD','USD','INR','EUR'],timezone:'Asia/Kolkata',reason:'Sample workspace provisioning checks'};
 assert.equal((await call('/sa/workspaces','POST',body,support.cookie)).status,403);
 for(const invalid of [{slug:'app'},{currencies:['USD']},{currencies:['KWD','KWD']},{timezone:'invalid/not-real'},{currency:'BAD'},{secret:'forbidden'}])assert.equal((await call('/sa/workspaces','POST',{...body,...invalid},owner.cookie)).status,400);
 const responses=await Promise.all([0,1].map(()=>call('/sa/workspaces','POST',body,owner.cookie)));assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
 const result=responses[0].data;assert.equal(result.id,responses[1].data.id);assert.equal(result.invitation_token,responses[1].data.invitation_token);tenants.push(result.id);
 const recovered=await call('/sa/workspaces/provisioning/'+body.request_id,'GET',null,owner.cookie);assert.equal(recovered.status,200);assert.equal(recovered.data.invitation_token,result.invitation_token);
 assert.equal((await call('/sa/workspaces/provisioning/'+body.request_id,'GET',null,support.cookie)).status,403);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM memberships WHERE tenant_id=$1',[result.id])).rows[0].n,0);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM records WHERE tenant_id=$1',[result.id])).rows[0].n,0);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM object_definitions WHERE tenant_id=$1',[result.id])).rows[0].n,builtIns.length);
 assert.deepEqual((await admin.query('SELECT stages FROM pipelines WHERE tenant_id=$1',[result.id])).rows[0].stages,defaultStages);assert.deepEqual((await admin.query('SELECT widgets FROM dashboards WHERE tenant_id=$1',[result.id])).rows[0].widgets,defaultWidgets);
 const saved=(await admin.query('SELECT settings FROM workspaces WHERE id=$1',[result.id])).rows[0].settings;assert.deepEqual(saved,{currency:body.currency,currencies:body.currencies,timezone:body.timezone});
 assert.equal((await admin.query('SELECT extract(epoch FROM trial_ends_at-trial_started_at)/86400 AS days FROM workspace_billing WHERE tenant_id=$1',[result.id])).rows[0].days,'15.0000000000000000');
 assert.equal((await call('/sa/workspaces','POST',{...body,name:'Changed request'},owner.cookie)).status,409);
 const secondOwner=await account();assert.equal((await call('/sa/workspaces','POST',body,secondOwner.cookie)).status,409);
 assert.equal((await call('/sa/workspaces/provisioning/'+body.request_id,'GET',null,secondOwner.cookie)).status,404);
 const preview=await call('/auth/platform-invitations/preview','POST',{token:result.invitation_token});assert.equal(preview.status,200);assert.equal(preview.data.role,'owner');assert.equal(preview.cache,'no-store');
 assert.equal((await call('/auth/platform-invitations/preview','POST',{token:result.invitation_token},'',{host:'different.localhost'})).status,410);
 const accept={token:result.invitation_token,mode:'login',password:existing.password};
 assert.equal((await call('/auth/platform-invitations/accept','POST',{...accept,password:'Wrong-password-123'})).status,401);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM memberships WHERE tenant_id=$1',[result.id])).rows[0].n,0);
 const accepted=await call('/auth/platform-invitations/accept','POST',accept);assert.equal(accepted.status,200);assert.equal((await call('/session','GET',null,accepted.cookie.split(';')[0])).data.workspace.id,result.id);
 assert.equal((await admin.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[result.id,existing.userId])).rows[0].role,'owner');
 assert.equal((await call('/auth/platform-invitations/accept','POST',accept)).status,200);
 const reused=await call('/sa/workspaces','POST',body,owner.cookie);assert.equal(reused.data.owner_joined,true);assert.equal(reused.data.invitation_token,null);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM platform_audit WHERE resource_id=$1 AND action='platform.workspace.owner_joined'",[result.id])).rows[0].n,1);
 await admin.query('DELETE FROM memberships WHERE tenant_id=$1',[result.id]);assert.equal((await call('/auth/platform-invitations/accept','POST',accept)).status,410);
 // Failed provisioning cannot leave a partial workspace, invitation or operation.
 const rollback=await call('/sa/workspaces','POST',{...body,request_id:randomUUID()},owner.cookie);assert.equal(rollback.status,409);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM platform_provisioning_operations WHERE tenant_id=$1',[result.id])).rows[0].n,1);
 // A new recipient can create their account only when accepting, without overwriting existing identities.
 const freshBody={...body,request_id:randomUUID(),slug:'fresh-'+randomBytes(5).toString('hex'),owner_email:randomUUID()+'@example.test'};
 const fresh=await call('/sa/workspaces','POST',freshBody,owner.cookie);assert.equal(fresh.status,201);tenants.push(fresh.data.id);
 const joined=await call('/auth/platform-invitations/accept','POST',{token:fresh.data.invitation_token,mode:'signup',name:'Sample new owner',password:'Sample-new-owner-password-123'});assert.equal(joined.status,200);
 const newUser=(await admin.query('SELECT id FROM users WHERE email=$1',[freshBody.owner_email])).rows[0];users.push(newUser.id);assert.equal((await call('/session','GET',null,joined.cookie.split(';')[0])).data.role,'owner');
 // Unaccepted invitations lose authority when their issuer is downgraded.
 const pending=await call('/sa/workspaces','POST',{...body,request_id:randomUUID(),slug:'pending-'+randomBytes(5).toString('hex')},owner.cookie);assert.equal(pending.status,201);tenants.push(pending.data.id);
 assert.equal((await call('/sa/accounts/'+owner.id,'PUT',{name:'Sample downgraded issuer',role:'viewer',disabled:false,version:1,reason:'Sample invitation authority revocation'},secondOwner.cookie)).status,200);
 assert.equal((await call('/auth/platform-invitations/accept','POST',{...accept,token:pending.data.invitation_token})).status,410);
}));
test('Owner invitation respects account MFA and disabled status without consuming rejected proofs or recreating revoked sessions',async()=>fixture(async({account,workspace,admin,tenants})=>{
 const owner=await account(),w=await workspace(),secret='JBSWY3DPEHPK3PXP',recovery='aaaaa-bbbbb-ccccc-ddddd';
 await admin.query('UPDATE users SET mfa_enabled=true WHERE id=$1',[w.userId]);
 await admin.query('INSERT INTO account_mfa(user_id,secret_ciphertext,enabled_at,recovery_hashes) VALUES($1,$2,now(),$3)',[w.userId,encryptCredential('account-mfa:'+w.userId,{secret}),[tokenHash('mfa-recovery:'+w.userId+':'+recovery.replaceAll('-',''))]]);
 const body={request_id:randomUUID(),name:'Sample MFA owner workspace',slug:'mfaowner-'+randomBytes(5).toString('hex'),owner_email:w.email,currency:'USD',currencies:['USD'],timezone:'UTC',reason:'Sample owner MFA acceptance checks'};
 const provision=await call('/sa/workspaces','POST',body,owner.cookie);assert.equal(provision.status,201);tenants.push(provision.data.id);
 const accept={token:provision.data.invitation_token,mode:'login',password:w.password};assert.equal((await call('/auth/platform-invitations/accept','POST',accept)).status,401);assert.equal((await call('/auth/platform-invitations/accept','POST',{...accept,code:'000000'})).status,401);
 const challenge=await call('/auth/login','POST',{email:w.email,password:w.password});assert.equal(challenge.data.mfa_required,true);
 assert.equal((await call('/sa/users/'+w.userId+'/state','POST',{disabled:true,version:1,reason:'Sample suspended account MFA checks'},owner.cookie)).status,200);
 assert.equal((await call('/auth/platform-invitations/accept','POST',{...accept,code:recovery})).status,401);assert.equal((await call('/auth/mfa','POST',{challenge:challenge.data.challenge,code:recovery})).status,401);
 assert.equal((await admin.query('SELECT cardinality(recovery_hashes) AS n FROM account_mfa WHERE user_id=$1',[w.userId])).rows[0].n,1);
 assert.equal((await call('/sa/users/'+w.userId+'/state','POST',{disabled:false,version:2,reason:'Sample restored account MFA checks'},owner.cookie)).status,200);
 const accepted=await call('/auth/platform-invitations/accept','POST',{...accept,code:recovery});assert.equal(accepted.status,200);assert.equal((await admin.query('SELECT cardinality(recovery_hashes) AS n FROM account_mfa WHERE user_id=$1',[w.userId])).rows[0].n,0);
 assert.equal((await call('/auth/platform-invitations/accept','POST',{...accept,code:recovery})).status,401);
}));
const definition=(limits={},features={},kind='workspace')=>({name:'Sample governed plan',kind,limits:Object.fromEntries(entitlementMeters.map(k=>[k,limits[k]??null])),features:Object.fromEntries(entitlementFeatures.map(k=>[k,features[k]??true]))});
test('Versioned plans enforce concurrent resource growth, isolate tenants, pin versions and only allow reduced customer grants',async()=>fixture(async({account,workspace,admin,users})=>{
 const owner=await account(),reader=await account('viewer'),w=await workspace(),other=await workspace();
 const request={key:'sample-'+randomBytes(5).toString('hex'),definition:definition({users:1,contacts:1,pipelines:1,custom_records:1,workflows:1,active_workflows:1,integrations:1,calendars:1}),reason:'Sample governed plan publication'};
 assert.equal((await call('/sa/plans','POST',request,reader.cookie)).status,403);
 assert.equal((await call('/sa/plans','POST',{...request,definition:{...request.definition,limits:{...request.definition.limits,sms:1}}},owner.cookie)).status,400,'Unimplemented consumed meters cannot masquerade as enforced ceilings');
 const created=await call('/sa/plans','POST',request,owner.cookie);assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.id;
 assert.equal(created.data.definition.monthly_price_minor,100);assert.equal(created.data.definition.annual_price_minor,1200);
 const saved={version:1,plan_id:id,plan_version:1,overrides:{limits:{},features:{}},agreement:null,reason:'Sample workspace plan assignment'};
 assert.equal((await call('/sa/workspaces/'+w.id+'/entitlements','PUT',saved,reader.cookie)).status,403);
 const assigned=await call('/sa/workspaces/'+w.id+'/entitlements','PUT',saved,owner.cookie);assert.equal(assigned.status,200,JSON.stringify(assigned.data));assert.equal(assigned.data.version,2);assert.equal(assigned.data.usage.users,1);assert.equal(assigned.data.usage.pipelines,1);
 assert.equal((await call('/sa/workspaces/'+w.id+'/entitlements','PUT',saved,owner.cookie)).status,409);
 assert.equal((await call('/sa/workspaces/'+w.id+'/entitlements','PUT',{...saved,version:2,overrides:{limits:{contacts:2},features:{}}},owner.cookie)).status,409);
 assert.equal((await call('/sa/workspaces/'+w.id+'/entitlements','PUT',{...saved,version:2,overrides:{limits:{contacts:null},features:{}}},owner.cookie)).status,409);
 const competing=await Promise.all(['First contact','Second contact'].map(name=>call('/records/people','POST',{data:{name}},w.cookie)));assert.deepEqual(competing.map(x=>x.status).sort(),[201,409]);
 const person=competing.find(x=>x.status===201).data;assert.ok(person.id);
 assert.equal((await call('/records/people','POST',{data:{name:'Other workspace contact'}},other.cookie)).status,201);
 await tenantTransaction(w.id,c=>c.query("UPDATE records SET data=data||'{\"title\":\"Retained edit\"}'::jsonb WHERE id=$1",[person.id]));
 const user=randomUUID();users.push(user);await admin.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,'Sample extra member',user+'@example.test',await hashPassword('Sample-user-password-123')]);
 await assert.rejects(tenantTransaction(w.id,c=>c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",[w.id,user])),e=>e.code==='DK001');
 await assert.rejects(tenantTransaction(w.id,c=>c.query('INSERT INTO pipelines(tenant_id,id,name,stages) VALUES($1,$2,$3,$4)',[w.id,randomUUID(),'Blocked pipeline',[]])),e=>e.code==='DK001');
 await tenantTransaction(w.id,async c=>{
  await c.query('INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields) VALUES($1,$2,$3,$4,$5)',[w.id,'assets','Assets','Asset',[]]);
  await c.query('INSERT INTO records(tenant_id,id,object_key,data) VALUES($1,$2,$3,$4)',[w.id,randomUUID(),'assets',{name:'Sample asset'}]);
 });
 await assert.rejects(tenantTransaction(w.id,c=>c.query('INSERT INTO records(tenant_id,id,object_key,data) VALUES($1,$2,$3,$4)',[w.id,randomUUID(),'assets',{name:'Over limit asset'}])),e=>e.code==='DK001');
 const wf=randomUUID();await tenantTransaction(w.id,c=>c.query('INSERT INTO workflows(tenant_id,id,name,draft,status) VALUES($1,$2,$3,$4,$5)',[w.id,wf,'Sample workflow',{nodes:[],edges:[]},'active']));
 await assert.rejects(tenantTransaction(w.id,c=>c.query('INSERT INTO workflows(tenant_id,id,name,draft) VALUES($1,$2,$3,$4)',[w.id,randomUUID(),'Extra workflow',{nodes:[],edges:[]}])),e=>e.code==='DK001');
 await tenantTransaction(w.id,c=>c.query("INSERT INTO outreach_connections(tenant_id,id,name,channel,provider,ciphertext,enabled) VALUES($1,$2,'Sample connection','email','smtp','not-a-real-secret',true)",[w.id,randomUUID()]));
 await assert.rejects(tenantTransaction(w.id,c=>c.query('INSERT INTO credentials(tenant_id,id,name,provider,ciphertext) VALUES($1,$2,$3,$4,$5)',[w.id,randomUUID(),'Second integration','smtp','not-a-real-secret'])),e=>e.code==='DK001');
 const cal=randomUUID();await tenantTransaction(w.id,c=>c.query('INSERT INTO calendars(tenant_id,id,name,config) VALUES($1,$2,$3,$4)',[w.id,cal,'Sample calendar',{}]));
 await assert.rejects(tenantTransaction(w.id,c=>c.query('INSERT INTO calendars(tenant_id,id,name,config) VALUES($1,$2,$3,$4)',[w.id,randomUUID(),'Extra calendar',{}])),e=>e.code==='DK001');
 await tenantTransaction(w.id,async c=>{await c.query('UPDATE calendars SET enabled=false WHERE id=$1',[cal]);await c.query('INSERT INTO calendars(tenant_id,id,name,config) VALUES($1,$2,$3,$4)',[w.id,randomUUID(),'Replacement calendar',{}]);});
 await assert.rejects(tenantTransaction(w.id,c=>c.query('UPDATE calendars SET enabled=true WHERE id=$1',[cal])),e=>e.code==='DK001');
 const changes=await Promise.all([0,1].map(()=>call('/sa/plans/'+id+'/versions','POST',{version:1,definition:definition({contacts:10,active_workflows:0},{finance:false}),reason:'Sample concurrent new plan version'},owner.cookie)));assert.deepEqual(changes.map(x=>x.status).sort(),[201,409]);
 const detail=await call('/sa/plans/'+id,'GET',null,reader.cookie);assert.equal(detail.data.current_version,2);assert.equal(detail.data.versions.length,2);
 assert.equal((await call('/sa/workspaces/'+w.id+'/entitlements','GET',null,reader.cookie)).data.plan_version,1,'Publishing does not alter pinned workspaces');
 await assert.rejects(platformPool.query('UPDATE platform_plan_versions SET name=name'),e=>e.code==='42501');await assert.rejects(platformPool.query('DELETE FROM platform_plan_versions'),e=>e.code==='42501');
 const lower=await call('/sa/workspaces/'+w.id+'/entitlements','PUT',{...saved,version:2,plan_version:2,overrides:{limits:{contacts:0},features:{crm:false}}},owner.cookie);assert.equal(lower.status,200);assert.equal(lower.data.usage.contacts,1,'Lowering limits retains existing records');
 assert.equal((await call('/records/people','GET',null,w.cookie)).status,200);
 assert.equal((await call('/records/people','POST',{data:{name:'Module disabled'}},w.cookie)).status,403);
 assert.equal((await call('/sa/workspaces/'+w.id+'/entitlements','PUT',{...saved,version:3,plan_version:2,overrides:{limits:{},features:{finance:true}}},owner.cookie)).status,409,'Customer overrides cannot enable a disabled plan capability');
 await tenantTransaction(w.id,c=>c.query("UPDATE workflows SET status='paused' WHERE id=$1",[wf]));
 await assert.rejects(tenantTransaction(w.id,c=>c.query("UPDATE workflows SET status='active' WHERE id=$1",[wf])),e=>e.code==='DK001');
 for(const t of ['platform_plans','platform_plan_versions','platform_workspace_entitlements']){
  const flags=(await admin.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('drykraft_app',$1,'SELECT') AS app,has_table_privilege('drykraft_worker',$1,'SELECT') AS worker FROM pg_class WHERE oid=$1::regclass",[t])).rows[0];assert.ok(flags.relrowsecurity&&flags.relforcerowsecurity);assert.equal(flags.app,false);assert.equal(flags.worker,false);
 }
 await assert.rejects(tenantTransaction(w.id,c=>workspaceEntitlements(c,other.id)),e=>e.code==='42501');
 assert.equal((await call('/billing','GET',null,w.cookie)).data.entitlements.plan_version,2);
}));
test('Audited trial extensions and time-bounded enterprise agreements grant actual access without editing provider payment state',async()=>fixture(async({account,workspace,admin})=>{
 const owner=await account('billing'),w=await workspace();
 await admin.query("UPDATE workspace_billing SET trial_ends_at=now()-interval '1 day' WHERE tenant_id=$1",[w.id]);
 assert.equal((await call('/records/people','POST',{data:{name:'Expired trial'}},w.cookie)).status,402);
 const extended=await call('/sa/workspaces/'+w.id+'/trial','POST',{version:1,ends_at:new Date(Date.now()+20*86400000).toISOString(),reason:'Sample agreed trial evaluation extension'},owner.cookie);assert.equal(extended.status,200,JSON.stringify(extended.data));assert.equal(extended.data.version,2);
 assert.equal((await call('/billing','GET',null,w.cookie)).data.access,true);
 assert.equal((await call('/sa/workspaces/'+w.id+'/trial','POST',{version:2,ends_at:new Date(Date.now()+10*86400000).toISOString(),reason:'Sample invalid trial shortening'},owner.cookie)).status,409);
 const enterprise=await call('/sa/plans','POST',{key:'enterprise-'+randomBytes(5).toString('hex'),definition:definition({users:2}, {},'enterprise'),reason:'Sample enterprise plan creation'},owner.cookie);assert.equal(enterprise.status,201);
 const input={version:2,plan_id:enterprise.data.id,plan_version:1,overrides:{limits:{},features:{}},agreement:{reference:'SAMPLE-CONTRACT-2026',starts_at:new Date(Date.now()-60000).toISOString(),ends_at:new Date(Date.now()+30*86400000).toISOString(),seats:2},reason:'Sample signed enterprise agreement'};
 assert.equal((await call('/sa/workspaces/'+w.id+'/entitlements','PUT',input,owner.cookie)).status,200);
 await admin.query("UPDATE workspace_billing SET trial_ends_at=now()-interval '1 day' WHERE tenant_id=$1",[w.id]);
 const state=await call('/billing','GET',null,w.cookie);assert.equal(state.data.agreement,true);assert.equal(state.data.access,true);assert.equal(state.data.status,null);assert.equal(state.data.subscribed,false,'Agreement is never represented as a provider subscription');
 assert.equal((await call('/records/people','POST',{data:{name:'Enterprise granted'}},w.cookie)).status,201);
 await admin.query("UPDATE platform_workspace_entitlements SET agreement=jsonb_set(agreement,'{ends_at}',to_jsonb((now()-interval '1 second')::text)) WHERE tenant_id=$1",[w.id]);
 assert.equal((await call('/records/people','POST',{data:{name:'Expired agreement'}},w.cookie)).status,402);
 assert.equal((await call('/sa/workspaces/'+w.id+'/entitlements','PUT',{...input,version:3,agreement:null,overrides:{limits:{},features:{automation:false,calendar:false,outreach:false}}},owner.cookie)).status,200);
 await tenantTransaction(w.id,async c=>{await assert.rejects(requireBillingAccess(c,w.id,'automation'),e=>e.status===403);await assert.rejects(requireBillingAccess(c,w.id,'calendar'),e=>e.status===403);await assert.rejects(requireBillingAccess(c,w.id,'outreach'),e=>e.status===403);});
 const events=(await admin.query('SELECT type FROM outbox WHERE tenant_id=$1',[w.id])).rows.map(x=>x.type);assert.ok(events.includes('billing.entitlements.updated'));assert.ok(events.includes('billing.trial.extended'));
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM platform_audit WHERE resource_id=$1 AND action='platform.workspace.trial_extended'",[w.id])).rows[0].n,1);
}));
test.after(async()=>{await pool.end();await platformPool?.end();});
