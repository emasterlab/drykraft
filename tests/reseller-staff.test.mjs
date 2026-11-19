import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {platformPool} from '../server/platform-db.mjs';
import {resellerPool,validateResellerDatabase} from '../server/reseller-db.mjs';
import {resellerApiPool,validateResellerApiDatabase} from '../server/reseller-api.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {encryptCredential,decryptCredential} from '../server/automation.mjs';
import {base32,totp} from '../server/mfa.mjs';
import {entitlementMeters,entitlementFeatures,workspaceEntitlements} from '../server/entitlements.mjs';
import {resellerHost} from '../server/reseller-auth.mjs';

after(async()=>{await pool.end();await platformPool?.end();await resellerPool?.end();await resellerApiPool?.end();});
const password='Synthetic-reseller-password-123',reason='Synthetic team access acceptance';let ip=70;
function call(path,{method='GET',body,cookie='',headers={}}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request(process.env.TEST_API_ORIGIN+path,{method,headers:{'content-type':'application/json',cookie,...headers}},res=>{
   const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks)),headers:res.headers});}catch{reject(Error('Unexpected response format'));}});
  });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Reseller check timed out')));if(body)req.write(JSON.stringify(body));req.end();
 });
}
async function fixture(action){
 const url=new URL(process.env.LOCAL_DATABASE_ADMIN_URL||'');assert.match(url.pathname,/^\/drykraft_reseller_check_[a-f0-9]+$/,'Owned disposable clone required');
 const admin=new pg.Client({connectionString:url.toString()});await admin.connect();
 const headers={'x-forwarded-for':'203.0.113.'+ip++};const request=(path,options={})=>call(path,{...options,headers:{...headers,...options.headers}});
 const platformId=randomUUID(),raw=randomBytes(32).toString('hex'),cookie='drykraft_sa_session='+raw;
 const hash=await hashPassword(password);
 await admin.query("INSERT INTO platform_accounts(id,name,email,password_hash,role,mfa_enabled_at) VALUES($1,'Synthetic platform owner',$2,$3,'owner',now())",[platformId,platformId+'@example.test',hash]);
 await admin.query("INSERT INTO platform_sessions(token_hash,account_id,auth_version,expires_at) VALUES($1,$2,1,now()+interval '1 hour')",[tokenHash(raw),platformId]);
 const limits=Object.fromEntries(entitlementMeters.map(k=>[k,null])),features=Object.fromEntries(entitlementFeatures.map(k=>[k,true]));
 const metadata={name:'Synthetic team organization',customer_access_policy:'retain_access',contract_reference:'SYNTHETIC-TEAM',billing_mode:'wholesale',contract_starts_at:new Date(Date.now()-86400000).toISOString(),contract_ends_at:new Date(Date.now()+86400000*30).toISOString()};
 async function organization(active=true,grantOverrides={}){
  const saved=await request('/api/sa/resellers',{method:'POST',cookie,body:{...metadata,key:'team-'+randomUUID().slice(0,8),reason,grant:{platform_plan_id:'00000000-0000-4000-8000-000000000001',platform_plan_version:1,max_workspaces:50,trial_days_max:15,limits,aggregate_limits:limits,features,...grantOverrides}}});assert.equal(saved.status,201,JSON.stringify(saved.data));
  if(!active)return saved.data;
  const changed=await request('/api/sa/resellers/'+saved.data.id,{method:'PUT',cookie,body:{...metadata,status:'active',version:saved.data.version,reason}});assert.equal(changed.status,200,JSON.stringify(changed.data));return changed.data;
 }
 async function create(org,role='owner',changes={}){const body={mode:'new_account',name:'Synthetic '+role,email:randomUUID()+'@example.test',initial_password:password,role,reason,request_id:randomUUID(),...changes};return {...await request('/api/sa/resellers/'+org.id+'/members',{method:'POST',cookie,body}),input:body};}
 async function staff(org,role='owner'){
  const created=await create(org,role);assert.equal(created.status,201,JSON.stringify(created.data));const a=created.data,secret=base32(randomBytes(20));
  await admin.query('UPDATE reseller_accounts SET mfa_enabled_at=now(),secret_ciphertext=$2 WHERE id=$1',[a.account_id,encryptCredential('reseller-mfa:'+a.account_id,{secret})]);
  return {...a,secret,cookie:await session(a.account_id,org.id)};
 }
 async function session(account,org=null){const token=randomBytes(32).toString('hex');await admin.query("INSERT INTO reseller_sessions(token_hash,account_id,selected_reseller_id,auth_version,expires_at) SELECT $1,id,$2,auth_version,now()+interval '1 hour' FROM reseller_accounts WHERE id=$3",[tokenHash(token),org,account]);return 'drykraft_reseller_session='+token;}
 try{await action({admin,request,cookie,platformId,organization,create,staff,session,metadata,hash});}finally{
  // Retain fixture history for isolation checks, but do not leave an enabled platform owner for another suite's last-owner test.
  await admin.query('UPDATE platform_accounts SET disabled=true,auth_version=auth_version+1 WHERE id=$1',[platformId]);
  await admin.query('DELETE FROM platform_sessions WHERE account_id=$1',[platformId]);
  await admin.end();
 }
}

const retail=(org,changes={})=>({name:'Synthetic staff retail',currency:'USD',monthly_price_minor:100,annual_price_minor:1000,setup_price_minor:0,trial_days:15,limits:org.grant.limits,features:org.grant.features,...changes});
const publication=(org,changes={})=>({key:'staff-'+randomUUID().slice(0,8),definition:retail(org),reason:'Synthetic reviewed retail publication',request_id:randomUUID(),...changes});

test('staff owners publish three distinct retail plans with their own authorship and safe replay receipts',()=>fixture(async f=>{
 const org=await f.organization(),owner=await f.staff(org),plans=[];
 for(const [name,currency,monthly]of [['Starter','USD',100],['Growth','INR',20000],['Enterprise','KWD',12345]]){
  const body=publication(org,{definition:retail(org,{name:'Synthetic '+name,currency,monthly_price_minor:monthly})});
  const saved=await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body});assert.equal(saved.status,201,JSON.stringify(saved.data));plans.push(saved.data.id);
  const retry=await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body});assert.equal(retry.status,200);assert.equal(retry.data.id,saved.data.id);assert.equal(retry.data.replayed,true);
  const receipt=await f.request('/api/reseller/plans/publications/'+body.request_id,{cookie:owner.cookie});assert.equal(receipt.status,200);assert.equal(receipt.data.id,saved.data.id);
  assert.equal((await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body:{...body,definition:{...body.definition,name:'Different request input'}}})).status,409);
  const history=await f.request('/api/reseller/plans/'+saved.data.id,{cookie:owner.cookie});assert.equal(history.status,200);assert.equal(history.data.items[0].author_name,owner.name);assert.equal(history.data.items[0].currency,currency);assert.equal(history.data.items[0].monthly_price_minor,monthly);
  const authors=(await f.admin.query('SELECT created_by,created_by_reseller_account_id FROM reseller_retail_plan_versions WHERE plan_id=$1',[saved.data.id])).rows[0];assert.equal(authors.created_by,null);assert.equal(authors.created_by_reseller_account_id,owner.account_id);
 }
 const catalog=await f.request('/api/reseller/plans',{cookie:owner.cookie});assert.equal(catalog.data.items.length,3);assert.equal(new Set(plans).size,3);
 assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM reseller_audit WHERE reseller_id=$1 AND action='reseller.retail_plan.published'",[org.id])).rows[0].n,3);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM reseller_plan_operations WHERE reseller_id=$1',[org.id])).rows[0].n,3);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM platform_audit WHERE resource_id=ANY($1::uuid[])',[plans])).rows[0].n,0,'Staff author is never disguised as a platform identity');
}));

test('retail publication and history enforce current staff roles, selected parent, contract and separate realms',()=>fixture(async f=>{
 const org=await f.organization(),other=await f.organization(),owner=await f.staff(org),admin=await f.staff(org,'admin'),support=await f.staff(org,'support'),billing=await f.staff(org,'billing'),otherOwner=await f.staff(other);
 const body=publication(org),saved=await f.request('/api/reseller/plans',{method:'POST',cookie:admin.cookie,body});assert.equal(saved.status,201);
 for(const cookie of ['',f.cookie,support.cookie,billing.cookie])assert.equal((await f.request('/api/reseller/plans',{method:'POST',cookie,body:publication(org)})).status,cookie===''||cookie===f.cookie?401:403);
 assert.equal((await f.request('/api/reseller/plans/'+saved.data.id,{cookie:billing.cookie})).status,200);assert.equal((await f.request('/api/reseller/plans/'+saved.data.id,{cookie:support.cookie})).status,403);
 for(const path of ['/plans/'+saved.data.id,'/plans/publications/'+body.request_id])assert.equal((await f.request('/api/reseller'+path,{cookie:otherOwner.cookie})).status,404);
 assert.equal((await f.request('/api/reseller/plans/publications/'+body.request_id,{cookie:owner.cookie})).status,404,'Only the original actor can retrieve the receipt');
 assert.equal((await f.request('/api/reseller/plans/'+saved.data.id+'/versions',{method:'POST',cookie:otherOwner.cookie,body:{version:1,definition:retail(other),reason,request_id:randomUUID()}})).status,404);
 assert.equal((await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body:{...publication(org),reseller_id:other.id}})).status,400,'A client cannot choose a different parent');
 const changed=await f.request('/api/reseller/members/'+admin.id,{method:'PUT',cookie:owner.cookie,body:{role:'support',disabled:false,version:1,reason}});assert.equal(changed.status,200);
 assert.equal((await f.request('/api/reseller/plans',{method:'POST',cookie:admin.cookie,body:publication(org)})).status,401);
 await f.admin.query("UPDATE reseller_organizations SET status='suspended' WHERE id=$1",[org.id]);
 for(const [path,method,requestBody]of [['/plans/'+saved.data.id,'GET'],['/plans/publications/'+body.request_id,'GET'],['/plans','POST',publication(org)]])assert.equal((await f.request('/api/reseller'+path,{method,cookie:owner.cookie,body:requestBody})).status,403);
}));

test('self-published retail definitions cannot exceed wholesale ceilings, capabilities or trial allowances',()=>fixture(async f=>{
 const limits=Object.fromEntries(entitlementMeters.map(k=>[k,null])),features=Object.fromEntries(entitlementFeatures.map(k=>[k,k!=='outreach']));limits.contacts=5;
 const org=await f.organization(true,{limits,features}),owner=await f.staff(org),body=publication(org);
 for(const definition of [retail(org,{limits:{...limits,contacts:6}}),retail(org,{limits:{...limits,contacts:null}}),retail(org,{features:{...features,outreach:true}}),retail(org,{trial_days:16})])assert.equal((await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body:{...body,definition}})).status,409);
 for(const definition of [retail(org,{currency:'NOT'}),retail(org,{monthly_price_minor:1.5}),retail(org,{setup_price_minor:-1}),retail(org,{limits:{contacts:1}}),retail(org,{features:{...features,private:true}})])assert.equal((await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body:{...body,definition}})).status,400);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM reseller_retail_plans WHERE reseller_id=$1',[org.id])).rows[0].n,0);
 const saved=await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body});assert.equal(saved.status,201,'Rejected publications do not consume the retry receipt');
 await assert.rejects(f.admin.query('UPDATE reseller_plan_operations SET result=result WHERE reseller_id=$1',[org.id]),e=>e.code==='42501');
 await assert.rejects(f.admin.query('UPDATE reseller_retail_plan_versions SET name=name WHERE plan_id=$1',[saved.data.id]),e=>e.code==='42501');
 for(const table of ['reseller_plan_operations','reseller_retail_plan_versions'])await assert.rejects(resellerPool.query('SELECT * FROM '+table+' LIMIT 1'),e=>e.code==='42501');
 await assert.rejects(resellerPool.query('SELECT reseller_save_retail_version($1,$2,$3,NULL,0,$4,$5)',[org.id,randomUUID(),f.platformId,'forged',body.definition]),e=>e.code==='42501');
 await validateResellerDatabase();
}));

test('concurrent publication retries commit once, conflicting versions fail and assigned customers retain their immutable plan',()=>fixture(async f=>{
 const org=await f.organization(),owner=await f.staff(org),body=publication(org);
 const responses=await Promise.all(Array.from({length:4},()=>f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body})));
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,200,200,201]);const plan=responses[0].data.id;
 const tenant=randomUUID();await tenantTransaction(tenant,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic pinned retail customer','retail-'+tenant.slice(0,8)]);await initializeWorkspace(c,tenant);});
 const assigned=await f.request('/api/sa/workspaces/'+tenant+'/reseller',{method:'PUT',cookie:f.cookie,body:{version:0,reseller_id:org.id,retail_plan_id:plan,retail_plan_version:1,reason}});assert.equal(assigned.status,200,JSON.stringify(assigned.data));
 const updates=await Promise.all([250,500].map(monthly=>f.request('/api/reseller/plans/'+plan+'/versions',{method:'POST',cookie:owner.cookie,body:{version:1,definition:retail(org,{monthly_price_minor:monthly}),reason,request_id:randomUUID()}})));
 assert.deepEqual(updates.map(r=>r.status).sort(),[201,409]);const history=await f.request('/api/reseller/plans/'+plan,{cookie:owner.cookie});assert.equal(history.data.current_version,2);assert.deepEqual(history.data.items.map(v=>v.version),[2,1]);
 const effective=await tenantTransaction(tenant,c=>workspaceEntitlements(c,tenant));assert.equal(effective.reseller.retail_plan_version,1);assert.equal(effective.reseller.monthly_price_minor,100);
 const pinned=(await f.admin.query('SELECT retail_plan_version,version FROM reseller_workspace_links WHERE tenant_id=$1',[tenant])).rows[0];assert.equal(pinned.retail_plan_version,1);assert.equal(pinned.version,1);
 const platformPublish=await f.request('/api/sa/resellers/'+org.id+'/plans/'+plan+'/versions',{method:'POST',cookie:f.cookie,body:{version:2,definition:retail(org,{name:'Synthetic platform revision'}),reason}});assert.equal(platformPublish.status,201,JSON.stringify(platformPublish.data));
 const final=await f.request('/api/reseller/plans/'+plan,{cookie:owner.cookie});assert.equal(final.data.current_version,3);assert.equal(final.data.items[0].author_name,'Platform administrator');assert.equal(final.data.items[1].author_name,owner.name);
 assert.equal((await f.request('/api/sa/resellers/'+org.id+'/plans/'+plan+'/versions',{method:'POST',cookie:f.cookie,body:{version:2,definition:retail(org),reason}})).status,409,'Platform optimistic conflict remains unchanged');
}));

test('wholesale reduction and staff publication serialize without escalation, while saved retries remain recoverable',()=>fixture(async f=>{
 const limits=Object.fromEntries(entitlementMeters.map(k=>[k,null]));limits.contacts=5;
 const org=await f.organization(true,{limits}),owner=await f.staff(org),body=publication(org);
 const saved=await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body});assert.equal(saved.status,201);
 const smaller={...org.grant,limits:{...limits,contacts:2}};for(const key of ['reseller_id','version','created_by','created_at'])delete smaller[key];
 const [reduction,publish]=await Promise.all([
  f.request('/api/sa/resellers/'+org.id+'/grants',{method:'POST',cookie:f.cookie,body:{version:1,definition:smaller,reason}}),
  f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body:publication(org)}),
 ]);assert.equal(reduction.status,201,JSON.stringify(reduction.data));assert.ok([201,409].includes(publish.status),JSON.stringify(publish.data));
 if(publish.status===201){const version=(await f.request('/api/reseller/plans/'+publish.data.id,{cookie:owner.cookie})).data.items[0];assert.equal(version.grant_version,1,'Only publication before the serialized reduction can retain the old cap');}
 assert.equal((await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body:publication(org)})).status,409,'New publication must use the reduced allowance');
 const replay=await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body});assert.equal(replay.status,200);assert.equal(replay.data.id,saved.data.id);
 const revised=await f.request('/api/reseller/plans/'+saved.data.id+'/versions',{method:'POST',cookie:owner.cookie,body:{version:1,definition:retail(org,{limits:{...limits,contacts:2}}),reason,request_id:randomUUID()}});assert.equal(revised.status,201);assert.equal(revised.data.grant_version,2);
}));

test('same staff request cannot cross organizations and history pagination preserves version boundaries',()=>fixture(async f=>{
 const org=await f.organization(),other=await f.organization(),owner=await f.staff(org);
 const joined=await f.request('/api/sa/resellers/'+other.id+'/members',{method:'POST',cookie:f.cookie,body:{mode:'existing_account',email:owner.email,role:'owner',reason,request_id:randomUUID()}});assert.equal(joined.status,201);
 const body=publication(org),saved=await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body});assert.equal(saved.status,201);
 assert.equal((await f.request('/api/reseller/organizations/'+other.id+'/select',{method:'POST',cookie:owner.cookie,body:{}})).status,200);
 assert.equal((await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body:{...body,definition:retail(other)}})).status,409);
 assert.equal((await f.request('/api/reseller/plans/publications/'+body.request_id,{cookie:owner.cookie})).status,404);
 await f.request('/api/reseller/organizations/'+org.id+'/select',{method:'POST',cookie:owner.cookie,body:{}});
 for(let version=1;version<27;version++){
  const next=await f.request('/api/reseller/plans/'+saved.data.id+'/versions',{method:'POST',cookie:owner.cookie,body:{version,definition:retail(org,{name:'Synthetic version '+(version+1)}),reason,request_id:randomUUID()}});assert.equal(next.status,201,JSON.stringify(next.data));
 }
 const page=await f.request('/api/reseller/plans/'+saved.data.id,{cookie:owner.cookie});assert.equal(page.data.items.length,25);assert.equal(page.data.next_before,3);
 const older=await f.request('/api/reseller/plans/'+saved.data.id+'?before='+page.data.next_before,{cookie:owner.cookie});assert.deepEqual(older.data.items.map(v=>v.version),[2,1]);assert.equal(older.data.next_before,null);
 assert.equal((await f.request('/api/reseller/plans/'+saved.data.id+'?before=0',{cookie:owner.cookie})).status,400);
}));

test('platform team creation is reasoned, idempotent and explicit about new versus existing identity',()=>fixture(async f=>{
 const org=await f.organization(false),body={mode:'new_account',name:'Synthetic organization owner',email:randomUUID()+'@example.test',initial_password:password,role:'owner',request_id:randomUUID(),reason};
 const path='/api/sa/resellers/'+org.id+'/members';
 assert.equal((await f.request(path)).status,401);assert.equal((await f.create(org,'support')).status,400,'First enabled member must be owner');
 const responses=await Promise.all([f.create(org,'owner',body),f.create(org,'owner',body)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);const a=responses.find(r=>r.status===201).data;
 assert.equal(responses.find(r=>r.status===200).data.id,a.id);assert.equal((await f.create(org,'owner',{...body,name:'Changed request'})).status,409);
 assert.equal((await f.create(org,'owner',{...body,request_id:randomUUID()})).status,409,'New account must not overwrite existing credentials');
 const other=await f.organization(),joined=await f.request('/api/sa/resellers/'+other.id+'/members',{method:'POST',cookie:f.cookie,body:{mode:'existing_account',email:body.email,role:'owner',reason,request_id:randomUUID()}});assert.equal(joined.status,201);assert.equal(joined.data.account_id,a.account_id);
 const row=(await f.admin.query('SELECT * FROM reseller_accounts WHERE id=$1',[a.account_id])).rows[0];assert.notEqual(row.password_hash,password);assert.match(row.password_hash,/^[a-f0-9]{32}:[a-f0-9]{128}$/);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM reseller_member_operations WHERE result->>\'account_id\'=$1',[a.account_id])).rows[0].n,2);
 const listed=await f.request(path,{cookie:f.cookie});assert.equal(listed.status,200);assert.equal(listed.data.items.length,1);assert.equal(listed.data.items[0].mfa_enabled,false);assert.equal(JSON.stringify(listed.data).includes(row.password_hash),false);
 const audit=await f.admin.query('SELECT data FROM reseller_audit WHERE resource_id=$1',[a.id]);assert.equal(audit.rowCount,1);assert.equal(JSON.stringify(audit.rows).includes(password),false);
 for(const role of ['support','billing','viewer']){
  const id=randomUUID(),raw=randomBytes(32).toString('hex');await f.admin.query("INSERT INTO platform_accounts(id,name,email,password_hash,role,mfa_enabled_at) VALUES($1,'Synthetic restricted platform',$2,$3,$4,now())",[id,id+'@example.test',f.hash,role]);await f.admin.query("INSERT INTO platform_sessions(token_hash,account_id,auth_version,expires_at) VALUES($1,$2,1,now()+interval '1 hour')",[tokenHash(raw),id]);
  assert.equal((await f.request(path,{method:'POST',cookie:'drykraft_sa_session='+raw,body:{...body,request_id:randomUUID()}})).status,403);
 }
}));

test('real password/MFA enrollment consumes the challenge, separates realms and returns recovery codes only once',()=>fixture(async f=>{
 const org=await f.organization(),created=await f.create(org),email=created.input.email,id=created.data.account_id;
 const login=await f.request('/api/reseller/login',{method:'POST',body:{email,password}});assert.equal(login.status,200);assert.equal(login.data.enrollment_required,true);
 assert.equal(login.headers['set-cookie'],undefined);assert.equal((await f.request('/api/reseller/session',{cookie:f.cookie})).status,401);
 assert.equal((await f.request('/api/reseller/mfa',{method:'POST',body:{challenge:login.data.challenge,code:'000000'}})).status,401);
 const setup=await f.request('/api/reseller/mfa/setup',{method:'POST',body:{challenge:login.data.challenge}});assert.equal(setup.status,200);assert.match(setup.data.qr,/^data:image\/png;base64,/);
 const step=Math.floor(Date.now()/30000),enrolled=await f.request('/api/reseller/mfa',{method:'POST',body:{challenge:login.data.challenge,code:totp(setup.data.secret,step)}});assert.equal(enrolled.status,200,JSON.stringify(enrolled.data));assert.equal(enrolled.data.recovery_codes.length,10);
 const cookie=enrolled.headers['set-cookie'][0].split(';')[0];assert.match(enrolled.headers['set-cookie'][0],/HttpOnly/);assert.match(enrolled.headers['set-cookie'][0],/SameSite=Strict/);assert.match(enrolled.headers['set-cookie'][0],/Path=\/api\/reseller/);assert.ok(!enrolled.headers['set-cookie'][0].includes('Domain='));
 assert.equal((await f.request('/api/reseller/mfa',{method:'POST',body:{challenge:login.data.challenge,code:totp(setup.data.secret,step)}})).status,401);
 const info=await f.request('/api/reseller/session',{cookie});assert.equal(info.status,200);assert.equal(info.data.account.id,id);assert.equal(info.data.organization,null);
 const stored=(await f.admin.query('SELECT * FROM reseller_accounts WHERE id=$1',[id])).rows[0];assert.equal(stored.auth_version,2);assert.equal(decryptCredential('reseller-mfa:'+id,stored.secret_ciphertext).secret,setup.data.secret);assert.throws(()=>decryptCredential('platform-mfa:'+id,stored.secret_ciphertext));
 assert.equal((await f.request('/api/reseller/organizations/'+org.id+'/select',{method:'POST',cookie,body:{}})).status,200);
 assert.equal((await f.request('/api/sa/session',{cookie})).status,401);assert.equal((await f.request('/api/v1/reseller/me',{cookie})).status,401);assert.equal((await f.request('/api/auth/session',{cookie})).status,401);
 const next=await f.request('/api/reseller/login',{method:'POST',body:{email,password}});assert.equal(next.data.mfa_required,true);
 const recovered=await f.request('/api/reseller/mfa',{method:'POST',body:{challenge:next.data.challenge,code:enrolled.data.recovery_codes[0]}});assert.equal(recovered.status,200);assert.equal(recovered.data.recovery_codes,undefined);
 const again=await f.request('/api/reseller/login',{method:'POST',body:{email,password}});assert.equal((await f.request('/api/reseller/mfa',{method:'POST',body:{challenge:again.data.challenge,code:enrolled.data.recovery_codes[0]}})).status,401);
}));

test('staff role and selected membership enforce parent isolation without granting customer CRM access',()=>fixture(async f=>{
 const org=await f.organization(),other=await f.organization(),owner=await f.staff(org),foreign=await f.staff(other);
 for(const role of ['owner','admin','support','billing']){
  const a=role==='owner'?owner:await f.staff(org,role);
  const overview=await f.request('/api/reseller/overview',{cookie:a.cookie,headers:{'x-workspace-id':other.id}});assert.equal(overview.status,200);assert.equal(overview.data.reseller_id,org.id);assert.equal(overview.data.role,role);
  assert.equal((await f.request('/api/reseller/customers',{cookie:a.cookie})).status,200);assert.equal((await f.request('/api/reseller/usage',{cookie:a.cookie})).status,200);
  assert.equal((await f.request('/api/reseller/plans',{cookie:a.cookie})).status,role==='support'?403:200);
  for(const path of ['/members','/audit'])assert.equal((await f.request('/api/reseller'+path,{cookie:a.cookie})).status,['owner','admin'].includes(role)?200:403);
  assert.equal((await f.request('/api/reseller/organizations/'+other.id+'/select',{method:'POST',cookie:a.cookie,body:{}})).status,403);
  assert.equal((await f.request('/api/reseller/members/'+foreign.id,{method:'PUT',cookie:a.cookie,body:{role:'support',disabled:false,version:1,reason}})).status,404);
  assert.equal((await f.request('/api/records/people',{cookie:a.cookie})).status,401);
 }
 const orgs=await f.request('/api/reseller/organizations',{cookie:owner.cookie});assert.equal(orgs.data.items.length,1);assert.equal(orgs.data.items[0].id,org.id);
 assert.equal((await f.request('/api/reseller/overview?reseller_id='+other.id,{cookie:owner.cookie})).status,400);
 assert.equal((await f.request('/api/reseller/overview',{cookie:owner.cookie,headers:{host:'customer.localhost'}})).status,404);
 assert.equal((await f.request('/api/reseller/members',{method:'POST',cookie:owner.cookie,body:{mode:'new_account',name:'Synthetic staff',email:randomUUID()+'@example.test',initial_password:password,role:'support',reason,request_id:randomUUID()}})).status,201);
}));

test('versioned role changes protect owners, revoke every organization session and retain customer data',()=>fixture(async f=>{
 const org=await f.organization(),other=await f.organization(),owner=await f.staff(org),admin=await f.staff(org,'admin'),support=await f.staff(org,'support');
 const path='/api/reseller/members/'+owner.id,body={role:'admin',disabled:false,version:1,reason};
 assert.equal((await f.request(path,{method:'PUT',cookie:owner.cookie,body})).status,409,'Last owner cannot be demoted');
 assert.equal((await f.request(path,{method:'PUT',cookie:admin.cookie,body:{...body,role:'owner',disabled:true}})).status,403,'Admin cannot disable an owner');
 assert.equal((await f.request('/api/reseller/members/'+support.id,{method:'PUT',cookie:admin.cookie,body:{...body,role:'owner'}})).status,403,'Admin cannot promote an owner');
 const joined=await f.request('/api/sa/resellers/'+other.id+'/members',{method:'POST',cookie:f.cookie,body:{mode:'existing_account',email:support.email,role:'owner',reason,request_id:randomUUID()}});assert.equal(joined.status,201);const otherCookie=await f.session(support.account_id,other.id);
 const before=(await f.admin.query('SELECT auth_version FROM reseller_accounts WHERE id=$1',[support.account_id])).rows[0].auth_version;
 const unchanged=await f.request('/api/reseller/members/'+support.id,{method:'PUT',cookie:owner.cookie,body:{role:'support',disabled:false,version:1,reason}});assert.equal(unchanged.status,200);assert.equal(unchanged.data.unchanged,true);
 const updated=await f.request('/api/reseller/members/'+support.id,{method:'PUT',cookie:owner.cookie,body:{role:'billing',disabled:false,version:1,reason}});assert.equal(updated.status,200);assert.equal(updated.data.version,2);
 for(const cookie of [support.cookie,otherCookie])assert.equal((await f.request('/api/reseller/session',{cookie})).status,401);
 assert.equal((await f.admin.query('SELECT auth_version FROM reseller_accounts WHERE id=$1',[support.account_id])).rows[0].auth_version,before+1);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM reseller_memberships WHERE account_id=$1',[support.account_id])).rows[0].n,2);
 assert.equal((await f.request('/api/reseller/members/'+support.id,{method:'PUT',cookie:owner.cookie,body:{role:'support',disabled:false,version:1,reason}})).status,409);
 const second=await f.staff(org);const demotions=await Promise.all([owner,second].map(a=>f.request('/api/sa/resellers/'+org.id+'/members/'+a.id,{method:'PUT',cookie:f.cookie,body:{role:'admin',disabled:false,version:1,reason}})));assert.deepEqual(demotions.map(r=>r.status).sort(),[200,409]);
 assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM reseller_memberships WHERE reseller_id=$1 AND role='owner' AND NOT disabled",[org.id])).rows[0].n,1);
}));

test('contract pause disables management while account security and other owned organizations remain available',()=>fixture(async f=>{
 const org=await f.organization(),other=await f.organization(),owner=await f.staff(org);
 await f.request('/api/sa/resellers/'+other.id+'/members',{method:'POST',cookie:f.cookie,body:{mode:'existing_account',email:owner.email,role:'owner',reason,request_id:randomUUID()}});
 const paused=await f.request('/api/sa/resellers/'+org.id,{method:'PUT',cookie:f.cookie,body:{...f.metadata,status:'suspended',version:org.version,reason}});assert.equal(paused.status,200);
 assert.equal((await f.request('/api/reseller/session',{cookie:owner.cookie})).data.organization.available,false);
 for(const path of ['/overview','/customers','/members','/usage','/plans','/audit'])assert.equal((await f.request('/api/reseller'+path,{cookie:owner.cookie})).status,403);
 assert.equal((await f.request('/api/reseller/sessions/revoke',{method:'POST',cookie:owner.cookie,body:{}})).status,200);
 assert.equal((await f.request('/api/reseller/organizations/'+other.id+'/select',{method:'POST',cookie:owner.cookie,body:{}})).status,200);
 assert.equal((await f.request('/api/reseller/overview',{cookie:owner.cookie})).data.reseller_id,other.id);
 await f.admin.query("UPDATE reseller_organizations SET contract_ends_at=now()-interval '1 second' WHERE id=$1",[other.id]);assert.equal((await f.request('/api/reseller/overview',{cookie:owner.cookie})).status,403);
 await f.admin.query('UPDATE reseller_accounts SET disabled=true WHERE id=$1',[owner.account_id]);assert.equal((await f.request('/api/reseller/session',{cookie:owner.cookie})).status,401);
}));

test('staff database exposes only its identity realm and dedicated session-bound helpers; startup rejects extra privileges',()=>fixture(async f=>{
 await validateResellerDatabase();await validateResellerApiDatabase();
 for(const table of ['records','users','credentials','platform_accounts','reseller_memberships','reseller_organizations','reseller_member_operations','reseller_audit'])await assert.rejects(resellerPool.query('SELECT * FROM '+table+' LIMIT 1'),e=>e.code==='42501');
 await assert.rejects(resellerPool.query('SELECT platform_reseller_members($1,$2,NULL)',[randomUUID(),f.platformId]),e=>e.code==='42501');
 await assert.rejects(resellerPool.query('SELECT reseller_staff_members($1,$2,NULL,NULL)',[randomUUID(),f.platformId]),e=>e.code==='42501');
 await assert.rejects(pool.query('SELECT * FROM reseller_accounts LIMIT 1'),e=>e.code==='42501');
 const tables=(await f.admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])",[['reseller_accounts','reseller_memberships','reseller_sessions','reseller_auth_challenges','reseller_audit','reseller_member_operations']])).rows;assert.equal(tables.length,6);assert.ok(tables.every(t=>t.relrowsecurity&&t.relforcerowsecurity));
 for(const grant of ['SELECT(id) ON records','SELECT ON reseller_memberships','EXECUTE ON FUNCTION platform_reseller_members(uuid,uuid,uuid)']){
  await f.admin.query('GRANT '+grant+' TO drykraft_reseller');try{await assert.rejects(validateResellerDatabase(),/dedicated restricted role/);}finally{await f.admin.query('REVOKE '+grant+' FROM drykraft_reseller');}
 }
 await validateResellerDatabase();
 const org=await f.organization();await f.staff(org);const audit=(await f.admin.query('SELECT id FROM reseller_audit WHERE reseller_id=$1 LIMIT 1',[org.id])).rows[0];await assert.rejects(f.admin.query('UPDATE reseller_audit SET reason=$2 WHERE id=$1',[audit.id,'Changed immutable audit']),e=>e.code==='42501');
}));

test('password rotation, recovery regeneration, idle expiry and logout revoke access without changing memberships',()=>fixture(async f=>{
 const org=await f.organization(),owner=await f.staff(org),other=await f.session(owner.account_id,org.id),step=Math.floor(Date.now()/30000);
 const recovery=await f.request('/api/reseller/mfa/recovery',{method:'POST',cookie:owner.cookie,body:{current_password:password,code:totp(owner.secret,step)}});assert.equal(recovery.status,200);assert.equal(recovery.data.recovery_codes.length,10);
 const changed=await f.request('/api/reseller/password',{method:'POST',cookie:owner.cookie,body:{current_password:password,new_password:password+'-rotated',code:recovery.data.recovery_codes[0]}});assert.equal(changed.status,200,JSON.stringify(changed.data));const fresh=changed.headers['set-cookie'][0].split(';')[0];
 for(const cookie of [owner.cookie,other])assert.equal((await f.request('/api/reseller/session',{cookie})).status,401);
 assert.equal((await f.request('/api/reseller/login',{method:'POST',body:{email:owner.email,password}})).status,401);
 assert.equal((await f.request('/api/reseller/session',{cookie:fresh})).status,200);
 const raw=fresh.split('=')[1];await f.admin.query("UPDATE reseller_sessions SET last_seen_at=now()-interval '16 minutes' WHERE token_hash=$1",[tokenHash(raw)]);assert.equal((await f.request('/api/reseller/session',{cookie:fresh})).status,401);
 const last=await f.session(owner.account_id,org.id);assert.equal((await f.request('/api/reseller/logout',{method:'POST',cookie:last,body:{}})).status,200);assert.equal((await f.request('/api/reseller/session',{cookie:last})).status,401);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM reseller_memberships WHERE account_id=$1',[owner.account_id])).rows[0].n,1);
 const originalEnvironment=process.env.NODE_ENV,originalDomain=process.env.APP_DOMAIN;try{
  process.env.NODE_ENV='production';process.env.APP_DOMAIN='drykraft.com';let rejection;
  resellerHost({hostname:'app.drykraft.com',method:'POST',get:k=>k==='origin'?'https://other.example':null},{set(){}},e=>rejection=e);assert.equal(rejection.status,403);
  rejection=null;resellerHost({hostname:'app.drykraft.com',method:'POST',get:k=>k==='origin'?'https://app.drykraft.com':null},{set(){}},e=>rejection=e);assert.equal(rejection,undefined);
 }finally{process.env.NODE_ENV=originalEnvironment;process.env.APP_DOMAIN=originalDomain;}
}));

test('team pagination and concurrent cross-organization changes preserve isolation and one owner',()=>fixture(async f=>{
 const first=await f.organization(),second=await f.organization(),a=await f.staff(first),b=await f.staff(second);
 const firstB=await f.request('/api/sa/resellers/'+first.id+'/members',{method:'POST',cookie:f.cookie,body:{mode:'existing_account',email:b.email,role:'admin',reason,request_id:randomUUID()}});
 const secondA=await f.request('/api/sa/resellers/'+second.id+'/members',{method:'POST',cookie:f.cookie,body:{mode:'existing_account',email:a.email,role:'admin',reason,request_id:randomUUID()}});
 const responses=await Promise.all([
  f.request('/api/reseller/members/'+firstB.data.id,{method:'PUT',cookie:a.cookie,body:{role:'support',disabled:false,version:1,reason}}),
  f.request('/api/reseller/members/'+secondA.data.id,{method:'PUT',cookie:b.cookie,body:{role:'billing',disabled:false,version:1,reason}}),
 ]);assert.ok(responses.every(r=>[200,401].includes(r.status)),JSON.stringify(responses.map(r=>r.status)));assert.ok(responses.some(r=>r.status===200),'At least one authorized change commits; the other may lose its revoked session');
 for(let i=0;i<26;i++){const id=randomUUID();await f.admin.query("INSERT INTO reseller_accounts(id,name,email,password_hash) VALUES($1,'Synthetic page member',$2,$3)",[id,id+'@example.test',f.hash]);await f.admin.query("INSERT INTO reseller_memberships(id,reseller_id,account_id,role) VALUES($1,$2,$3,'support')",[randomUUID(),first.id,id]);}
 const page=await f.request('/api/sa/resellers/'+first.id+'/members',{cookie:f.cookie});assert.equal(page.data.items.length,25);assert.ok(page.data.next_cursor);
 const all=(await f.admin.query('SELECT id FROM reseller_memberships WHERE reseller_id=$1 ORDER BY id',[first.id])).rows;
 const last=all.at(-1).id;assert.ok(!page.data.items.some(m=>m.id===last));
 const exact=await f.request('/api/sa/resellers/'+first.id+'/members/'+last,{cookie:f.cookie});assert.equal(exact.status,200);assert.equal(exact.data.id,last);
 assert.equal((await f.request('/api/sa/resellers/'+second.id+'/members/'+last,{cookie:f.cookie})).status,404);
 const fresh=await f.session(a.account_id,first.id);assert.equal((await f.request('/api/reseller/members/'+last,{cookie:fresh})).status,200);assert.equal((await f.request('/api/reseller/members/'+b.id,{cookie:fresh})).status,404);
 const more=await f.request('/api/sa/resellers/'+first.id+'/members?cursor='+page.data.next_cursor,{cookie:f.cookie});assert.equal(more.data.items.length,3);assert.equal(more.data.next_cursor,null);assert.ok(more.data.items.every(r=>!page.data.items.some(p=>p.id===r.id)));
 const restore=await f.session(a.account_id,first.id),self=await f.request('/api/reseller/members',{cookie:restore});assert.equal(self.data.items.length,25);assert.equal(self.data.next_cursor,page.data.next_cursor);
 const support=await f.staff(first,'support');assert.equal((await f.request('/api/reseller/members/'+last,{cookie:support.cookie})).status,403);
}));

test('customer/platform email credentials and reseller API keys cannot become staff login; stale challenges and proofs fail closed',()=>fixture(async f=>{
 const email=randomUUID()+'@example.test',customer=randomUUID();
 await f.admin.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic customer identity',$2,$3)",[customer,email,f.hash]);
 assert.equal((await f.request('/api/reseller/login',{method:'POST',body:{email,password}})).status,401);
 const platformEmail=(await f.admin.query('SELECT email FROM platform_accounts WHERE id=$1',[f.platformId])).rows[0].email;
 assert.equal((await f.request('/api/reseller/login',{method:'POST',body:{email:platformEmail,password}})).status,401);
 const org=await f.organization(),created=await f.create(org,'owner',{email}),id=created.data.account_id;
 assert.notEqual(id,customer);assert.equal((await f.admin.query('SELECT password_hash FROM users WHERE id=$1',[customer])).rows[0].password_hash,f.hash);
 const initial=await f.request('/api/reseller/login',{method:'POST',body:{email,password}});assert.equal(initial.status,200);
 await f.admin.query('UPDATE reseller_accounts SET auth_version=auth_version+1 WHERE id=$1',[id]);
 assert.equal((await f.request('/api/reseller/mfa/setup',{method:'POST',body:{challenge:initial.data.challenge}})).status,401);
 const next=await f.request('/api/reseller/login',{method:'POST',body:{email,password}}),setup=await f.request('/api/reseller/mfa/setup',{method:'POST',body:{challenge:next.data.challenge}});
 const step=Math.floor(Date.now()/30000),signed=await f.request('/api/reseller/mfa',{method:'POST',body:{challenge:next.data.challenge,code:totp(setup.data.secret,step)}});assert.equal(signed.status,200);
 const repeat=await f.request('/api/reseller/login',{method:'POST',body:{email,password}});
 assert.equal((await f.request('/api/reseller/mfa',{method:'POST',body:{challenge:repeat.data.challenge,code:totp(setup.data.secret,step)}})).status,401,'Same TOTP cannot sign in again');
 await f.admin.query("UPDATE reseller_auth_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[tokenHash(repeat.data.challenge)]);
 assert.equal((await f.request('/api/reseller/mfa',{method:'POST',body:{challenge:repeat.data.challenge,code:signed.data.recovery_codes[0]}})).status,401);
 assert.equal((await f.request('/api/reseller/session',{headers:{authorization:'Bearer dk_res_'+randomBytes(32).toString('hex')}})).status,401);
}));


test('current publication allowance reflects wholesale revisions and enforces selected organization and role',()=>fixture(async f=>{
 const org=await f.organization(),owner=await f.staff(org),support=await f.staff(org,'support'),billing=await f.staff(org,'billing');
 const path='/api/reseller/plans/allowance';
 const first=await f.request(path,{cookie:owner.cookie});assert.equal(first.status,200);assert.equal(first.data.reseller_id,org.id);assert.equal(first.data.grant_version,1);assert.equal(first.data.trial_days_max,15);
 assert.deepEqual(Object.keys(first.data).sort(),['features','grant_version','limits','reseller_id','trial_days_max']);assert.equal((await f.request(path,{cookie:support.cookie})).status,403);assert.equal((await f.request(path,{cookie:billing.cookie})).status,200);
 assert.equal((await f.request(path,{cookie:await f.session(owner.account_id)})).status,403);assert.equal((await f.request(path,{cookie:f.cookie})).status,401);
 const definition={...org.grant,trial_days_max:7,limits:{...org.grant.limits,contacts:5}};for(const k of ['reseller_id','version','created_by','created_at'])delete definition[k];
 const changed=await f.request('/api/sa/resellers/'+org.id+'/grants',{method:'POST',cookie:f.cookie,body:{version:1,definition,reason}});assert.equal(changed.status,201,JSON.stringify(changed.data));
 const current=await f.request(path,{cookie:owner.cookie});assert.equal(current.data.grant_version,2);assert.equal(current.data.trial_days_max,7);assert.equal(current.data.limits.contacts,5);
 assert.equal((await f.request(path+'?reseller_id='+randomUUID(),{cookie:owner.cookie})).status,400);
 await f.admin.query("UPDATE reseller_organizations SET status='suspended' WHERE id=$1",[org.id]);assert.equal((await f.request(path,{cookie:owner.cookie})).status,403);
}));

test('membership receipts recover only the original currently authorized actor and exact parent without private credentials',()=>fixture(async f=>{
 const pending=await f.organization(false),created=await f.create(pending),platformPath='/api/sa/resellers/'+pending.id+'/members/creations/'+created.input.request_id;
 const platform=await f.request(platformPath,{cookie:f.cookie});assert.equal(platform.status,200);assert.equal(platform.data.id,created.data.id);assert.equal(JSON.stringify(platform.data).includes(password),false);
 const org=await f.organization(),other=await f.organization(),owner=await f.staff(org),second=await f.staff(org),support=await f.staff(org,'support');
 assert.equal((await f.request('/api/sa/resellers/'+other.id+'/members/creations/'+created.input.request_id,{cookie:f.cookie})).status,404);
 const body={mode:'new_account',name:'Synthetic saved membership',email:randomUUID()+'@example.test',initial_password:password,role:'billing',reason,request_id:randomUUID()};
 const saved=await f.request('/api/reseller/members',{method:'POST',cookie:owner.cookie,body});assert.equal(saved.status,201);
 const path='/api/reseller/members/creations/'+body.request_id,receipt=await f.request(path,{cookie:owner.cookie});assert.equal(receipt.status,200);assert.equal(receipt.data.id,saved.data.id);assert.equal(JSON.stringify(receipt.data).includes(password),false);
 for(const [cookie,status]of [[second.cookie,404],[support.cookie,403],[f.cookie,401],['',401]])assert.equal((await f.request(path,{cookie})).status,status);
 assert.equal((await f.request('/api/sa/resellers/'+org.id+'/members/creations/'+body.request_id,{cookie:f.cookie})).status,404,'Platform actor cannot recover staff authorship');
 assert.equal((await f.request('/api/reseller/members/creations/'+created.input.request_id,{cookie:owner.cookie})).status,404,'Staff cannot recover platform authorship');
 await f.request('/api/sa/resellers/'+other.id+'/members',{method:'POST',cookie:f.cookie,body:{mode:'existing_account',email:owner.email,role:'owner',reason,request_id:randomUUID()}});
 await f.request('/api/reseller/organizations/'+other.id+'/select',{method:'POST',cookie:owner.cookie,body:{}});assert.equal((await f.request(path,{cookie:owner.cookie})).status,404);
 await f.request('/api/reseller/organizations/'+org.id+'/select',{method:'POST',cookie:owner.cookie,body:{}});assert.equal((await f.request(path,{cookie:owner.cookie})).data.id,saved.data.id);
 assert.equal((await f.request('/api/reseller/members',{method:'POST',cookie:owner.cookie,body})).data.id,saved.data.id);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM reseller_member_operations WHERE actor_id=$1 AND request_id=$2',[owner.account_id,body.request_id])).rows[0].n,1);
 await f.admin.query("UPDATE reseller_organizations SET status='suspended' WHERE id=$1",[org.id]);assert.equal((await f.request(path,{cookie:owner.cookie})).status,403);
}));
