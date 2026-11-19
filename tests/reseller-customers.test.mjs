import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool} from '../server/db.mjs';
import {platformPool} from '../server/platform-db.mjs';
import {resellerPool,validateResellerDatabase} from '../server/reseller-db.mjs';
import {resellerApiPool,validateResellerApiDatabase} from '../server/reseller-api.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {encryptCredential,decryptCredential} from '../server/automation.mjs';
import {base32} from '../server/mfa.mjs';
import {entitlementMeters,entitlementFeatures} from '../server/entitlements.mjs';

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

async function setup(f,grant={},definition={}){
 const org=await f.organization(true,grant),owner=await f.staff(org);
 const plan=await f.request('/api/reseller/plans',{method:'POST',cookie:owner.cookie,body:publication(org,{definition:retail(org,definition)})});
 assert.equal(plan.status,201,JSON.stringify(plan.data));return {org,owner,plan:plan.data};
}
const customerBody=plan=>({request_id:randomUUID(),name:'Synthetic customer',slug:'customer-'+randomUUID().slice(0,8),owner_email:randomUUID()+'@example.test',currency:'KWD',currencies:['USD','INR','KWD'],timezone:'Asia/Kolkata',retail_plan_id:plan.id,retail_plan_version:plan.version,reason:'Synthetic reviewed customer creation'});
async function provision(f,owner,plan,changes={}){
 const body={...customerBody(plan),...changes},saved=await f.request('/api/reseller/customers',{method:'POST',cookie:owner.cookie,body});
 assert.equal(saved.status,201,JSON.stringify(saved.data));return {...saved.data,input:body};
}
const control=(changes={})=>({reason:'Synthetic reviewed customer control',request_id:randomUUID(),...changes});
async function invitation(f,owner,w,operation='link'){
 const saved=await f.request('/api/reseller/customers/'+w.id+'/owner-invitation',{method:'POST',cookie:owner.cookie,body:control({version:w.invitation.version,operation})});
 assert.equal(saved.status,200,JSON.stringify(saved.data));return saved.data;
}

test('customer provisioning pins a retail version and creates configuration only with a same-actor recovery receipt',()=>fixture(async f=>{
 const {org,owner,plan}=await setup(f),body=customerBody(plan);
 const replies=await Promise.all(Array.from({length:4},()=>f.request('/api/reseller/customers',{method:'POST',cookie:owner.cookie,body})));
 assert.deepEqual(replies.map(r=>r.status).sort(),[200,200,200,201],JSON.stringify(replies));
 const saved=replies[0].data;assert.equal(new Set(replies.map(r=>r.data.id)).size,1);
 assert.equal(saved.retail_plan_version,1);assert.equal(saved.settings.currency,'KWD');assert.equal(saved.owner_joined,false);assert.equal(saved.invitation.email,body.owner_email);
 assert.equal(saved.usage.users,0);assert.equal(saved.usage.contacts,0);assert.equal(saved.usage.pipelines,1);
 assert.equal(new Date(saved.billing.trial_ends_at)-new Date(saved.billing.trial_started_at),15*86400000);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM records WHERE tenant_id=$1',[saved.id])).rows[0].n,0);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM users WHERE email=$1',[body.owner_email])).rows[0].n,0);
 assert.equal((await f.admin.query('SELECT updated_by_reseller FROM reseller_workspace_links WHERE tenant_id=$1',[saved.id])).rows[0].updated_by_reseller,owner.account_id);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM reseller_customer_operations WHERE request_id=$1',[body.request_id])).rows[0].n,1);
 assert.equal((await f.admin.query("SELECT count(*)::int n FROM reseller_audit WHERE resource_id=$1 AND action='reseller.customer.provisioned'",[saved.id])).rows[0].n,1);
 const recovered=await f.request('/api/reseller/customers/provisioning/'+body.request_id,{cookie:owner.cookie});assert.equal(recovered.status,200);assert.equal(recovered.data.id,saved.id);
 for(const data of [saved,recovered.data])assert.equal(/ciphertext|token_hash|invitation_token|password/.test(JSON.stringify(data)),false);
 assert.equal((await f.request('/api/reseller/customers',{method:'POST',cookie:owner.cookie,body:{...body,name:'Changed details'}})).status,409);
 const peer=await f.staff(org,'admin');assert.equal((await f.request('/api/reseller/customers/provisioning/'+body.request_id,{cookie:peer.cookie})).status,404);
 await f.admin.query("UPDATE reseller_organizations SET status='suspended' WHERE id=$1",[org.id]);
 assert.equal((await f.request('/api/reseller/customers/provisioning/'+body.request_id,{cookie:owner.cookie})).status,200,'Metadata-only own recovery remains possible');
 assert.equal((await f.request('/api/reseller/customers/'+saved.id,{cookie:owner.cookie})).status,403);
}));

test('customer write roles and selected organization cannot cross staff, platform, customer or key realms',()=>fixture(async f=>{
 const {org,owner,plan}=await setup(f),w=await provision(f,owner,plan),other=await setup(f);
 const support=await f.staff(org,'support'),billing=await f.staff(org,'billing'),admin=await f.staff(org,'admin');
 for(const staff of [support,billing]){
  assert.equal((await f.request('/api/reseller/customers/'+w.id,{cookie:staff.cookie})).status,200);
  for(const [path,method,body] of [['/customers','POST',customerBody(plan)],['/customers/'+w.id,'PUT',control({version:w.customer_control_version,name:'Changed name'})],['/customers/'+w.id+'/state','POST',control({version:w.customer_control_version,suspended:true})],['/customers/'+w.id+'/owner-invitation','POST',control({version:w.invitation.version,operation:'link'})]])
   assert.equal((await f.request('/api/reseller'+path,{cookie:staff.cookie,method,body})).status,403);
 }
 for(const cookie of ['',f.cookie])assert.equal((await f.request('/api/reseller/customers/'+w.id,{cookie})).status,401);
 assert.equal((await f.request('/api/reseller/customers/'+w.id,{cookie:other.owner.cookie})).status,404);
 assert.equal((await f.request('/api/reseller/customers',{method:'POST',cookie:owner.cookie,body:{...customerBody(plan),reseller_id:other.org.id}})).status,400);
 assert.equal((await f.request('/api/reseller/customers/'+w.id+'?reseller_id='+other.org.id,{cookie:owner.cookie})).status,400);
 assert.equal((await f.request('/api/reseller/customers/'+w.id+'/plan',{method:'PUT',cookie:support.cookie,body:control({version:1,retail_plan_id:plan.id,retail_plan_version:1})})).status,403);
 assert.equal((await f.request('/api/reseller/customers/'+w.id+'/plan',{method:'PUT',cookie:billing.cookie,body:control({version:1,retail_plan_id:other.plan.id,retail_plan_version:1})})).status,404);
 assert.equal((await f.request('/api/reseller/customers/'+w.id+'/owner-invitation',{method:'POST',cookie:admin.cookie,body:control({version:w.invitation.version,operation:'link'})})).status,403,'Only the actual issuer can retrieve a link');
}));

test('concurrent customer creation respects the current wholesale capacity and rolls back invalid setup',()=>fixture(async f=>{
 const {org,owner,plan}=await setup(f,{max_workspaces:1});
 const replies=await Promise.all([customerBody(plan),customerBody(plan)].map(body=>f.request('/api/reseller/customers',{method:'POST',cookie:owner.cookie,body})));
 assert.deepEqual(replies.map(r=>r.status).sort(),[201,409],JSON.stringify(replies));
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM reseller_workspace_links WHERE reseller_id=$1',[org.id])).rows[0].n,1);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM reseller_customer_operations WHERE reseller_id=$1',[org.id])).rows[0].n,1);
 const another=await setup(f),body=customerBody(another.plan);
 for(const changes of [{currencies:['USD']},{currencies:['KWD','KWD']},{timezone:'Invented/Zone'},{slug:'app'},{owner_email:'invalid'},{currency:'NOT'}])
  assert.equal((await f.request('/api/reseller/customers',{method:'POST',cookie:another.owner.cookie,body:{...body,...changes}})).status,400);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM reseller_workspace_links WHERE reseller_id=$1',[another.org.id])).rows[0].n,0);
 const saved=await provision(f,another.owner,another.plan,body);
 const collision=await f.request('/api/reseller/customers',{method:'POST',cookie:another.owner.cookie,body:{...customerBody(another.plan),slug:saved.slug}});assert.equal(collision.status,409);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM reseller_owner_invitations WHERE reseller_id=$1',[another.org.id])).rows[0].n,1);
}));

test('disabled Sales and zero pipeline packages create no hidden pipeline resources',()=>fixture(async f=>{
 const limits=Object.fromEntries(entitlementMeters.map(k=>[k,null]));limits.pipelines=0;
 const s=await setup(f,{limits}),w=await provision(f,s.owner,s.plan);assert.equal(w.usage.pipelines,0);
 const features=Object.fromEntries(entitlementFeatures.map(k=>[k,k!=='sales']));
 const x=await setup(f,{features}),q=await provision(f,x.owner,x.plan);assert.equal(q.usage.pipelines,0);
 const reduced=await setup(f,{}, {limits:{...limits,pipelines:null,users:0}});
 assert.equal((await f.request('/api/reseller/customers',{method:'POST',cookie:reduced.owner.cookie,body:customerBody(reduced.plan)})).status,409);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM reseller_customer_operations WHERE reseller_id=$1',[reduced.org.id])).rows[0].n,0);
}));

test('customer controls use optimistic versions and cannot override platform suspension or reset provider billing',()=>fixture(async f=>{
 const {org,owner,plan}=await setup(f),w=await provision(f,owner,plan),billing=await f.staff(org,'billing');
 await f.admin.query("UPDATE workspace_billing SET subscription_id='synthetic-preserved',customer_id='synthetic-customer',status='active',seats=3,next_billing_date=now()+interval '30 days' WHERE tenant_id=$1",[w.id]);
 const before=(await f.admin.query('SELECT * FROM workspace_billing WHERE tenant_id=$1',[w.id])).rows[0];
 const record=randomUUID(),data={name:'Synthetic retained private contact',email:'private-customer@example.test'};
 await f.admin.query("INSERT INTO records(tenant_id,id,object_key,data) VALUES($1,$2,'people',$3)",[w.id,record,data]);
 const renamed=await f.request('/api/reseller/customers/'+w.id,{method:'PUT',cookie:owner.cookie,body:control({version:w.customer_control_version,name:'Renamed customer'})});assert.equal(renamed.status,200,JSON.stringify(renamed.data));assert.equal(renamed.data.name,'Renamed customer');
 assert.equal((await f.request('/api/reseller/customers/'+w.id,{method:'PUT',cookie:owner.cookie,body:control({version:w.customer_control_version,name:'Stale name'})})).status,409);
 const published=await f.request('/api/reseller/plans/'+plan.id+'/versions',{method:'POST',cookie:owner.cookie,body:{version:1,definition:retail(org,{trial_days:2}),reason,request_id:randomUUID()}});assert.equal(published.status,201);
 const assigned=await f.request('/api/reseller/customers/'+w.id+'/plan',{method:'PUT',cookie:billing.cookie,body:control({version:1,retail_plan_id:plan.id,retail_plan_version:2})});assert.equal(assigned.status,200);assert.equal(assigned.data.retail_plan_version,2);
 assert.deepEqual((await f.admin.query('SELECT * FROM workspace_billing WHERE tenant_id=$1',[w.id])).rows[0],before);
 const stopped=await f.request('/api/reseller/customers/'+w.id+'/state',{method:'POST',cookie:owner.cookie,body:control({version:renamed.data.customer_control_version,suspended:true})});assert.equal(stopped.status,200);assert.equal(stopped.data.suspended,true);
 const p=await f.request('/api/sa/workspaces/'+w.id,{cookie:f.cookie});assert.equal(p.status,200);
 const state=await f.request('/api/sa/workspaces/'+w.id+'/state',{method:'POST',cookie:f.cookie,body:{version:p.data.version,suspended:true,reason}});assert.equal(state.status,200,JSON.stringify(state.data));
 const resumed=await f.request('/api/reseller/customers/'+w.id+'/state',{method:'POST',cookie:owner.cookie,body:control({version:stopped.data.customer_control_version,suspended:false})});assert.equal(resumed.status,200);assert.equal(resumed.data.customer_suspended,false);assert.equal(resumed.data.platform_suspended,true);assert.equal(resumed.data.suspended,true);
 assert.deepEqual((await f.admin.query('SELECT data FROM records WHERE id=$1',[record])).rows[0].data,data);
 assert.equal(JSON.stringify(resumed.data).includes(data.email),false,'Management metadata excludes retained private records');
}));

test('owner invitation renewal and revocation invalidate old links and current sender demotion blocks acceptance',()=>fixture(async f=>{
 const {org,owner,plan}=await setup(f),w=await provision(f,owner,plan),admin=await f.staff(org,'admin'),old=await invitation(f,owner,w);
 assert.match(old.invitation_token,/^[a-f0-9]{64}$/);assert.equal(old.ciphertext,undefined);
 const preview=await f.request('/api/auth/reseller-invitations/preview',{method:'POST',body:{token:old.invitation_token}});assert.equal(preview.status,200);
 const renewed=await invitation(f,admin,w,'renew');assert.notEqual(renewed.invitation_token,old.invitation_token);
 assert.equal((await f.request('/api/auth/reseller-invitations/preview',{method:'POST',body:{token:old.invitation_token}})).status,410);
 assert.equal((await f.request('/api/auth/platform-invitations/preview',{method:'POST',body:{token:renewed.invitation_token}})).status,410);
 const current={...w,invitation:{...w.invitation,version:renewed.version}};const newLink=await invitation(f,admin,current);assert.equal(newLink.invitation_token,renewed.invitation_token);
 const demoted=await f.request('/api/reseller/members/'+admin.id,{method:'PUT',cookie:owner.cookie,body:{role:'support',disabled:false,version:1,reason}});assert.equal(demoted.status,200);
 assert.equal((await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{token:renewed.invitation_token,mode:'signup',name:'Synthetic invited owner',password}})).status,410);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM users WHERE email=$1',[w.input.owner_email])).rows[0].n,0);
 const again=await invitation(f,owner,current,'renew');await invitation(f,owner,{...w,invitation:{...w.invitation,version:again.version}},'revoke');
 assert.equal((await f.request('/api/auth/reseller-invitations/preview',{method:'POST',body:{token:again.invitation_token}})).status,410);
}));

test('invited recipients join using their own password and cannot replay ownership after removal',()=>fixture(async f=>{
 const {owner,plan}=await setup(f),w=await provision(f,owner,plan),link=await invitation(f,owner,w);
 const body={token:link.invitation_token,mode:'signup',name:'Synthetic customer owner',password};
 const accepted=await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body});assert.equal(accepted.status,200,JSON.stringify(accepted.data));assert.match(accepted.headers['set-cookie'][0],/^drykraft_session=/);
 const u=(await f.admin.query('SELECT id FROM users WHERE email=$1',[w.input.owner_email])).rows[0];assert.ok(u);
 assert.equal((await f.admin.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[w.id,u.id])).rows[0].role,'owner');
 assert.equal((await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{...body,password:'Wrong-password-12345'}})).status,401);
 const replay=await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{...body,mode:'login'}});assert.equal(replay.status,200);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM memberships WHERE tenant_id=$1',[w.id])).rows[0].n,1);
 const detail=await f.request('/api/reseller/customers/'+w.id,{cookie:owner.cookie});assert.equal(detail.data.owner_joined,true);
 const stopped=await f.request('/api/reseller/customers/'+w.id+'/state',{method:'POST',cookie:owner.cookie,body:control({version:detail.data.customer_control_version,suspended:true})});assert.equal(stopped.status,200);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM sessions WHERE tenant_id=$1',[w.id])).rows[0].n,0);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM memberships WHERE tenant_id=$1',[w.id])).rows[0].n,1);
 await f.request('/api/reseller/customers/'+w.id+'/state',{method:'POST',cookie:owner.cookie,body:control({version:stopped.data.customer_control_version,suspended:false})});
 await f.admin.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',[w.id,u.id]);
 assert.equal((await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{...body,mode:'login'}})).status,410);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM memberships WHERE tenant_id=$1',[w.id])).rows[0].n,0);
}));

test('platform transfer retains customer data and permanently revokes the old reseller issuer',()=>fixture(async f=>{
 const s=await setup(f),w=await provision(f,s.owner,s.plan),link=await invitation(f,s.owner,w),other=await setup(f);
 const stop=await f.request('/api/reseller/customers/'+w.id+'/state',{method:'POST',cookie:s.owner.cookie,body:control({version:w.customer_control_version,suspended:true})});assert.equal(stop.status,200);
 const before=(await f.admin.query('SELECT * FROM workspace_billing WHERE tenant_id=$1',[w.id])).rows[0];
 const transfer=await f.request('/api/sa/workspaces/'+w.id+'/reseller',{method:'PUT',cookie:f.cookie,body:{version:w.version,reseller_id:other.org.id,retail_plan_id:other.plan.id,retail_plan_version:1,reason}});assert.equal(transfer.status,200,JSON.stringify(transfer.data));
 assert.equal((await f.request('/api/reseller/customers/'+w.id,{cookie:s.owner.cookie})).status,404);
 const moved=await f.request('/api/reseller/customers/'+w.id,{cookie:other.owner.cookie});assert.equal(moved.status,200);assert.equal(moved.data.customer_suspended,false);assert.equal(moved.data.invitation,null);
 assert.equal((await f.request('/api/auth/reseller-invitations/preview',{method:'POST',body:{token:link.invitation_token}})).status,410);
 const back=await f.request('/api/sa/workspaces/'+w.id+'/reseller',{method:'PUT',cookie:f.cookie,body:{version:moved.data.version,reseller_id:s.org.id,retail_plan_id:s.plan.id,retail_plan_version:1,reason}});assert.equal(back.status,200);
 assert.equal((await f.request('/api/auth/reseller-invitations/preview',{method:'POST',body:{token:link.invitation_token}})).status,410,'Returning to the original reseller must not revive a link');
 assert.deepEqual((await f.admin.query('SELECT * FROM workspace_billing WHERE tenant_id=$1',[w.id])).rows[0],before);
}));

test('restricted reseller runtime cannot read customer credentials or invoke internal/public invitation helpers',()=>fixture(async f=>{
 const s=await setup(f),w=await provision(f,s.owner,s.plan);await validateResellerDatabase(resellerPool);
 for(const table of ['reseller_owner_invitations','reseller_customer_operations','users','memberships','records','workspace_billing'])await assert.rejects(resellerPool.query('SELECT * FROM '+table+' LIMIT 1'),e=>e.code==='42501');
 for(const sql of ["SELECT reseller_customer_metadata($1)","SELECT accept_reseller_workspace_invitation('invalid',$1)"])await assert.rejects(resellerPool.query(sql,[w.id]),e=>e.code==='42501');
 await assert.rejects(f.admin.query('UPDATE reseller_customer_operations SET input_hash=input_hash WHERE tenant_id=$1',[w.id]),e=>e.code==='42501');
 await assert.rejects(f.admin.query('DELETE FROM reseller_customer_operations WHERE tenant_id=$1',[w.id]),e=>e.code==='42501');
 const stored=(await f.admin.query('SELECT token_hash,token_ciphertext FROM reseller_owner_invitations WHERE tenant_id=$1',[w.id])).rows[0];const decoded=decryptCredential('reseller-owner:'+w.invitation.id,stored.token_ciphertext);
 assert.equal(tokenHash(decoded.token),stored.token_hash);assert.equal(stored.token_ciphertext.includes(decoded.token),false);
}));

test('existing invited accounts require their own MFA and seat capacity without consuming rejected proof',()=>fixture(async f=>{
 const limits=Object.fromEntries(entitlementMeters.map(k=>[k,null]));limits.users=1;
 const s=await setup(f,{limits}),recipient=randomUUID(),occupant=randomUUID(),recovery='aaaaa-bbbbb-ccccc-ddddd',email=recipient+'@example.test';
 await f.admin.query("INSERT INTO users(id,name,email,password_hash,mfa_enabled) VALUES($1,'Synthetic existing recipient',$2,$3,true)",[recipient,email,f.hash]);
 await f.admin.query('INSERT INTO account_mfa(user_id,secret_ciphertext,enabled_at,recovery_hashes) VALUES($1,$2,now(),$3)',[recipient,encryptCredential('account-mfa:'+recipient,{secret:'JBSWY3DPEHPK3PXP'}),[tokenHash('mfa-recovery:'+recipient+':'+recovery.replaceAll('-',''))]]);
 const w=await provision(f,s.owner,s.plan,{owner_email:email}),link=await invitation(f,s.owner,w),body={token:link.invitation_token,mode:'login',password};
 assert.equal((await f.request('/api/auth/reseller-invitations/preview',{method:'POST',body:{token:link.invitation_token},headers:{host:'different.localhost'}})).status,410);
 assert.equal((await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body})).status,401);
 assert.equal((await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{...body,code:'000000'}})).status,401);
 await f.admin.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic occupied seat',$2,$3)",[occupant,occupant+'@example.test',f.hash]);
 await f.admin.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'viewer')",[w.id,occupant]);
 assert.equal((await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{...body,code:recovery}})).status,409);
 assert.equal((await f.admin.query('SELECT cardinality(recovery_hashes) n FROM account_mfa WHERE user_id=$1',[recipient])).rows[0].n,1);
 assert.equal((await f.admin.query('SELECT accepted_at FROM reseller_owner_invitations WHERE tenant_id=$1',[w.id])).rows[0].accepted_at,null);
 await f.admin.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',[w.id,occupant]);
 const accepted=await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{...body,code:recovery}});assert.equal(accepted.status,200,JSON.stringify(accepted.data));
 assert.equal((await f.admin.query('SELECT cardinality(recovery_hashes) n FROM account_mfa WHERE user_id=$1',[recipient])).rows[0].n,0);
 assert.equal((await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{...body,code:recovery}})).status,401);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM users WHERE email=$1',[email])).rows[0].n,1);
}));

test('current wholesale reductions reject stale retail provisioning and expiry never creates an account',()=>fixture(async f=>{
 const s=await setup(f),w=await provision(f,s.owner,s.plan),link=await invitation(f,s.owner,w);
 await f.admin.query("UPDATE reseller_owner_invitations SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",[w.id]);
 assert.equal((await f.request('/api/auth/reseller-invitations/accept',{method:'POST',body:{token:link.invitation_token,mode:'signup',name:'Expired recipient',password}})).status,410);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM users WHERE email=$1',[w.input.owner_email])).rows[0].n,0);
 const current={platform_plan_id:s.org.grant.platform_plan_id,platform_plan_version:s.org.grant.platform_plan_version,max_workspaces:s.org.grant.max_workspaces,trial_days_max:15,limits:{...s.org.grant.limits,contacts:1},aggregate_limits:s.org.grant.aggregate_limits,features:s.org.grant.features};
 const reduction=await f.request('/api/sa/resellers/'+s.org.id+'/grants',{method:'POST',cookie:f.cookie,body:{version:1,definition:current,reason}});assert.equal(reduction.status,201,JSON.stringify(reduction.data));
 const stale=await f.request('/api/reseller/customers',{method:'POST',cookie:s.owner.cookie,body:customerBody(s.plan)});assert.equal(stale.status,409);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM reseller_customer_operations WHERE reseller_id=$1',[s.org.id])).rows[0].n,1);
 const fresh=await f.request('/api/reseller/plans/'+s.plan.id+'/versions',{method:'POST',cookie:s.owner.cookie,body:{version:1,definition:retail(s.org,{limits:current.limits}),reason,request_id:randomUUID()}});assert.equal(fresh.status,201);
 const newCustomer=await provision(f,s.owner,{...s.plan,version:2});assert.equal(newCustomer.retail_plan_version,2);
}));
