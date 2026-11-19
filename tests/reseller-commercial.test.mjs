import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {platformPool} from '../server/platform-db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {encryptCredential} from '../server/automation.mjs';
import {base32} from '../server/mfa.mjs';
import {entitlementMeters,entitlementFeatures,workspaceEntitlements} from '../server/entitlements.mjs';

const origin=process.env.TEST_API_ORIGIN;
const limits=Object.fromEntries(entitlementMeters.map(k=>[k,null])),features=Object.fromEntries(entitlementFeatures.map(k=>[k,true]));
const reason='Synthetic reseller commercial acceptance';
function call(path,method='GET',body,cookie='',headers={}){return new Promise((resolve,reject)=>{
 const req=http.request(origin+'/api/sa'+path,{method,headers:{'content-type':'application/json',cookie,...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks)),cache:res.headers['cache-control']});}catch{reject(Error('Invalid reseller API response'));}});});
 req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Reseller check timed out')));if(body)req.write(JSON.stringify(body));req.end();
});}
async function fixture(action){
 const url=new URL(process.env.LOCAL_DATABASE_ADMIN_URL||'');assert.match(url.pathname,/^\/drykraft_reseller_check_[a-f0-9]+$/,'Reseller fixtures require the owned disposable clone');
 const admin=new pg.Client({connectionString:url.toString()});await admin.connect();
 const accounts=[],workspaces=[],organizations=[],plans=[],users=[];
 async function account(role='owner'){
  const id=randomUUID(),raw=randomBytes(32).toString('hex');accounts.push(id);
  await admin.query("INSERT INTO platform_accounts(id,name,email,password_hash,role,mfa_enabled_at,secret_ciphertext) VALUES($1,'Synthetic reseller operator',$2,$3,$4,now(),$5)",[id,id+'@example.test',await hashPassword('Synthetic-platform-password-123'),role,encryptCredential('platform-mfa:'+id,{secret:base32(randomBytes(20))})]);
  await admin.query("INSERT INTO platform_sessions(token_hash,account_id,auth_version,expires_at) VALUES($1,$2,1,now()+interval '1 hour')",[tokenHash(raw),id]);return {id,cookie:'drykraft_sa_session='+raw};
 }
 const owner=await account();
 const metadata={name:'Synthetic reseller',customer_access_policy:'retain_access',contract_reference:'TEST-CONTRACT',billing_mode:'wholesale',contract_starts_at:new Date(Date.now()-86400000).toISOString(),contract_ends_at:new Date(Date.now()+30*86400000).toISOString()};
 const grant={platform_plan_id:'00000000-0000-4000-8000-000000000001',platform_plan_version:1,max_workspaces:10,trial_days_max:15,limits,aggregate_limits:limits,features};
 async function reseller(overrides={}){
  const result=await call('/resellers','POST',{key:'test-'+randomUUID().slice(0,8),...metadata,grant:{...grant,...overrides},reason},owner.cookie);assert.equal(result.status,201,JSON.stringify(result.data));organizations.push(result.data.id);return result.data;
 }
 async function update(r,overrides={}){const result=await call('/resellers/'+r.id,'PUT',{...metadata,status:'active',version:r.version,...overrides,reason},owner.cookie);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
 async function workspace(){const id=randomUUID();workspaces.push(id);await tenantTransaction(id,async c=>{await c.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Synthetic reseller customer',$2)",[id,'reseller-'+id.slice(0,8)]);await initializeWorkspace(c,id);});return id;}
 async function plan(r,changes={}){
  const definition={name:'Synthetic retail',currency:'USD',monthly_price_minor:150,annual_price_minor:1500,setup_price_minor:0,trial_days:15,limits:r.grant.limits,features:r.grant.features,...changes};
  const result=await call('/resellers/'+r.id+'/plans','POST',{key:'retail-'+randomUUID().slice(0,8),definition,reason},owner.cookie);assert.equal(result.status,201,JSON.stringify(result.data));return {...result.data,definition};
 }
 async function assign(w,r,p,version=0){const result=await call('/workspaces/'+w+'/reseller','PUT',{version,reseller_id:r?.id||null,retail_plan_id:p?.id||null,retail_plan_version:p?.current_version||null,reason},owner.cookie);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
 async function person(w){return tenantTransaction(w,c=>c.query("INSERT INTO records(id,tenant_id,object_key,data) VALUES($1,$2,'people','{\"name\":\"Synthetic contact\"}')",[randomUUID(),w]));}
 async function customerUser(){const id=randomUUID();users.push(id);await admin.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic gauge user',$2,$3)",[id,id+'@example.test',await hashPassword('Synthetic-customer-password-123')]);return id;}
 try{await action({admin,owner,account,reseller,update,workspace,plan,assign,person,metadata,grant,organizations,plans,customerUser});}
 finally{
  try{
   await admin.query('BEGIN');
   await admin.query('DELETE FROM reseller_workspace_links WHERE tenant_id=ANY($1::uuid[])',[workspaces]);
   // Only fixture-owned immutable definitions are removed by the clone administrator, never the application role.
   await admin.query('ALTER TABLE reseller_retail_plan_versions DISABLE TRIGGER immutable_version');
   await admin.query('ALTER TABLE reseller_grant_versions DISABLE TRIGGER immutable_version');
   await admin.query('DELETE FROM reseller_retail_plan_versions WHERE reseller_id=ANY($1::uuid[])',[organizations]);
   await admin.query('DELETE FROM reseller_retail_plans WHERE reseller_id=ANY($1::uuid[])',[organizations]);
   await admin.query('DELETE FROM reseller_grant_versions WHERE reseller_id=ANY($1::uuid[])',[organizations]);
   await admin.query('DELETE FROM reseller_organizations WHERE id=ANY($1::uuid[])',[organizations]);
   for(const table of ['platform_workspace_entitlements','workflows','credentials','calendars','memberships','records','object_definitions','pipelines','dashboards','outbox','audit_events','workspace_billing'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,[workspaces]);
   await admin.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[workspaces]);
   await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
   await admin.query('DELETE FROM platform_audit WHERE actor_id=ANY($1::uuid[])',[accounts]);
   await admin.query('DELETE FROM platform_sessions WHERE account_id=ANY($1::uuid[])',[accounts]);
   await admin.query('DELETE FROM platform_accounts WHERE id=ANY($1::uuid[])',[accounts]);
   // Extra platform definitions belong to this fixture and have no assignment after cleanup.
   for(const id of plans){await admin.query('DELETE FROM platform_plan_versions WHERE plan_id=$1',[id]);await admin.query('DELETE FROM platform_plans WHERE id=$1',[id]);}
   await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
   await admin.query('ALTER TABLE reseller_retail_plan_versions ENABLE TRIGGER immutable_version');
   await admin.query('ALTER TABLE reseller_grant_versions ENABLE TRIGGER immutable_version');
   await admin.query('COMMIT');
  }catch(e){await admin.query('ROLLBACK');throw e;}finally{await admin.end();}
 }
}
test('Reseller APIs require platform MFA authority, pending approval, strict schemas and private table boundaries',async()=>fixture(async({admin,owner,account,reseller,metadata})=>{
 assert.equal((await call('/resellers')).status,401);const support=await account('support'),viewer=await account('viewer');
 assert.equal((await call('/resellers','GET',null,support.cookie)).status,403);assert.equal((await call('/resellers','GET',null,viewer.cookie)).status,200);
 assert.equal((await call('/resellers','GET',null,owner.cookie,{host:'another.localhost'})).status,404);
 const r=await reseller();assert.equal(r.status,'pending');assert.equal(r.grant.version,1);assert.equal(r.collection_configured,false);
 assert.equal((await call('/resellers/'+r.id+'/plans','POST',{key:'blocked',definition:{name:'Pending retail',currency:'USD',monthly_price_minor:100,annual_price_minor:1200,setup_price_minor:0,trial_days:15,limits,features},reason},owner.cookie)).status,409);
 assert.equal((await call('/resellers/'+r.id,'PUT',{...metadata,status:'active',version:1,reason},viewer.cookie)).status,403);
 assert.equal((await call('/resellers/'+r.id+'/grants','POST',{version:1,definition:{...r.grant,secret:'forbidden'},reason},owner.cookie)).status,400);
 for(const table of ['reseller_organizations','reseller_grant_versions','reseller_retail_plans','reseller_retail_plan_versions','reseller_workspace_links']){
  const flags=(await admin.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('drykraft_app',$1,'SELECT') AS app,has_table_privilege('drykraft_worker',$1,'SELECT') AS worker,has_table_privilege('drykraft_platform',$1,'UPDATE') AS write FROM pg_class WHERE oid=$1::regclass",[table])).rows[0];assert.ok(flags.relrowsecurity&&flags.relforcerowsecurity);assert.equal(flags.app,false);assert.equal(flags.worker,false);assert.equal(flags.write,false);
 }
 for(const sql of ['SELECT * FROM records','SELECT * FROM credentials','SELECT password_hash FROM users','SELECT reseller_save_grant(NULL,NULL,0,NULL)','DELETE FROM reseller_organizations'])await assert.rejects(platformPool.query(sql),e=>e.code==='42501');
 await assert.rejects(pool.query('SELECT reseller_resource_gauges($1)',[r.id]),e=>e.code==='42501');
}));
test('Wholesale and three retail packages preserve immutable prices, reject upstream escalation and pin assigned versions',async()=>fixture(async({admin,owner,reseller,update,workspace,plan,assign,plans,grant})=>{
 const platformId=randomUUID();plans.push(platformId);
 await admin.query('BEGIN');await admin.query('INSERT INTO platform_plans(id,key,current_version) VALUES($1,$2,1)',[platformId,'upstream-'+platformId.slice(0,8)]);
 await admin.query("INSERT INTO platform_plan_versions(plan_id,version,name,kind,monthly_price_minor,annual_price_minor,limits,features) VALUES($1,1,'Bounded upstream','workspace',100,1200,$2,$3)",[platformId,{...limits,contacts:8},{...features,outreach:false}]);await admin.query('COMMIT');
 const upstreamHistory=await call('/plans/'+platformId+'?before=2','GET',null,owner.cookie);assert.equal(upstreamHistory.status,200);assert.equal(upstreamHistory.data.versions[0].version,1);
 const r=await update(await reseller({platform_plan_id:platformId,limits:{...limits,contacts:7},features:{...features,outreach:false}}));
 const definitions=[{name:'Starter',currency:'USD',limits:{...limits,contacts:2},monthly_price_minor:100},{name:'Growth',currency:'INR',limits:{...limits,contacts:4},monthly_price_minor:200},{name:'Scale',currency:'KWD',limits:{...limits,contacts:7},monthly_price_minor:300}];
 const packages=[];for(const d of definitions)packages.push(await plan(r,d));assert.equal((await call('/resellers/'+r.id+'/plans','GET',null,owner.cookie)).data.items.length,3);
 const create=d=>call('/resellers/'+r.id+'/plans','POST',{key:'reject-'+randomUUID().slice(0,8),definition:{...packages[0].definition,...d},reason},owner.cookie);
 for(const d of [{limits:{...limits,contacts:8}},{limits:{...limits,contacts:null}},{features},{trial_days:16}])assert.equal((await create(d)).status,409);
 const publish=g=>call('/resellers/'+r.id+'/grants','POST',{version:r.grant_version,definition:{...grant,platform_plan_id:platformId,limits:r.grant.limits,features:r.grant.features,...g},reason},owner.cookie);
 assert.equal((await publish({limits:{...limits,contacts:9}})).status,409);assert.equal((await publish({features})).status,409);
 const w=await workspace();await assign(w,r,packages[0]);await tenantTransaction(w,async c=>assert.equal((await workspaceEntitlements(c,w)).limits.contacts,2));
 const revised=await call('/resellers/'+r.id+'/plans/'+packages[0].id+'/versions','POST',{version:1,definition:{...packages[0].definition,monthly_price_minor:999,limits:{...limits,contacts:3}},reason},owner.cookie);assert.equal(revised.status,201);
 const entitlements=await tenantTransaction(w,c=>workspaceEntitlements(c,w));assert.equal(entitlements.reseller.retail_plan_version,1);assert.equal(entitlements.reseller.monthly_price_minor,100);assert.equal(entitlements.monthly_price_minor,100);assert.equal(entitlements.currency,'USD');
 assert.equal((await call('/resellers/'+r.id+'/plans/'+packages[0].id+'?before=2','GET',null,owner.cookie)).data.versions.length,1);
 for(const table of ['reseller_retail_plan_versions','reseller_grant_versions'])await assert.rejects(admin.query('UPDATE '+table+' SET version=version'),e=>e.code==='42501');
}));
test('Effective entitlements intersect every upstream layer while grant reductions retain existing records and block growth',async()=>fixture(async({admin,owner,reseller,update,workspace,plan,assign,person,grant})=>{
 let r=await update(await reseller({limits:{...limits,contacts:5}}));const p=await plan(r,{limits:{...limits,contacts:4}}),w=await workspace(),direct=await workspace();await assign(w,r,p);
 await person(w);await person(w);await person(w);
 const changed=await call('/resellers/'+r.id+'/grants','POST',{version:1,definition:{...grant,limits:{...limits,contacts:2},features:{...features,outreach:false}},reason},owner.cookie);assert.equal(changed.status,201);r=changed.data;
 const e=await tenantTransaction(w,c=>workspaceEntitlements(c,w));assert.equal(e.limits.contacts,2);assert.equal(e.features.outreach,false);assert.equal(e.reseller.grant_version,2);assert.equal(e.reseller.retail_plan_version,1);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM records WHERE tenant_id=$1 AND object_key='people'",[w])).rows[0].n,3);await assert.rejects(person(w),err=>err.code==='DK001');
 const before=await tenantTransaction(direct,c=>workspaceEntitlements(c,direct));assert.equal(before.limits.contacts,null);assert.equal(before.features.outreach,true);assert.equal(before.reseller,undefined);await person(direct);
 assert.equal((await call('/workspaces/'+w+'/entitlements','PUT',{version:1,plan_id:grant.platform_plan_id,plan_version:1,overrides:{limits:{contacts:1},features:{finance:false}},agreement:null,reason},owner.cookie)).status,200);
 const reducedWorkspace=await tenantTransaction(w,c=>workspaceEntitlements(c,w));assert.equal(reducedWorkspace.limits.contacts,1);assert.equal(reducedWorkspace.features.finance,false);
 await assert.rejects(tenantTransaction(direct,c=>workspaceEntitlements(c,w)),err=>err.code==='42501');
 assert.equal((await call('/workspaces/'+w+'/reseller','PUT',{version:1,reseller_id:r.id,retail_plan_id:p.id,retail_plan_version:1,reason},owner.cookie)).status,409);
 const reduced=await plan(r,{limits:{...limits,contacts:2},features:{...features,outreach:false}});await assign(w,r,reduced,1);
 assert.equal((await call('/resellers/'+r.id,'GET',null,owner.cookie)).data.usage.contacts,3);
 assert.ok((await admin.query("SELECT 1 FROM outbox WHERE tenant_id=$1 AND type='reseller.customer.plan_changed' AND data->>'schema_version'='1' AND data->>'reseller_id'=$2",[w,r.id])).rowCount);
}));
test('Shared quotas serialize cross-workspace growth and simultaneous customer assignment',async()=>fixture(async({owner,account,reseller,update,workspace,plan,assign,person})=>{
 const r=await update(await reseller({aggregate_limits:{...limits,contacts:1},max_workspaces:2})),p=await plan(r),a=await workspace(),b=await workspace();await assign(a,r,p);await assign(b,r,p);
 await assert.rejects(tenantTransaction(a,c=>c.query("INSERT INTO records(id,tenant_id,object_key,data) VALUES($1,$3,'people','{}'),($2,$3,'people','{}')",[randomUUID(),randomUUID(),a])),e=>e.code==='DK001','A batch cannot exceed the shared ceiling or retain a partially inserted contact');
 const attempts=await Promise.allSettled([person(a),person(b)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.find(x=>x.status==='rejected').reason.code,'DK001');
 assert.equal((await call('/resellers/'+r.id,'GET',null,owner.cookie)).data.usage.contacts,1);
 const one=await update(await reseller({max_workspaces:1})),onePlan=await plan(one),x=await workspace(),y=await workspace();
 const body={version:0,reseller_id:one.id,retail_plan_id:onePlan.id,retail_plan_version:1,reason};
 const secondOwner=await account();
 const responses=await Promise.all([call('/workspaces/'+x+'/reseller','PUT',body,owner.cookie),call('/workspaces/'+y+'/reseller','PUT',body,secondOwner.cookie)]);assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);
}));
test('All eight aggregate gauges enforce growth while paused workflows and disabled calendars can retire safely',async()=>fixture(async({owner,reseller,update,workspace,plan,assign,person,customerUser})=>{
 const aggregate_limits=Object.fromEntries(entitlementMeters.map(k=>[k,0]));aggregate_limits.pipelines=2;aggregate_limits.workflows=1;
 const r=await update(await reseller({aggregate_limits})),p=await plan(r),a=await workspace(),b=await workspace();await assign(a,r,p);await assign(b,r,p);
 const user=await customerUser(),workflow=randomUUID();
 await tenantTransaction(a,async c=>{
  await c.query("INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields) VALUES($1,'assets','Assets','Asset','[]')",[a]);
  await c.query("INSERT INTO workflows(tenant_id,id,name,draft,status) VALUES($1,$2,'Paused workflow','{}','paused')",[a,workflow]);
 });
 const blocked=[
  ['INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,\'member\')',[b,user]],
  ['INSERT INTO pipelines(tenant_id,id,name,stages) VALUES($1,$2,\'Extra pipeline\',\'[]\')',[b,randomUUID()]],
  ['INSERT INTO records(tenant_id,id,object_key,data) VALUES($1,$2,\'assets\',\'{}\')',[a,randomUUID()]],
  ['INSERT INTO workflows(tenant_id,id,name,draft) VALUES($1,$2,\'Extra workflow\',\'{}\')',[b,randomUUID()]],
  ['UPDATE workflows SET status=\'active\' WHERE tenant_id=$1 AND id=$2',[a,workflow]],
  ['INSERT INTO credentials(tenant_id,id,name,provider,ciphertext) VALUES($1,$2,\'Synthetic integration\',\'smtp\',\'synthetic\')',[b,randomUUID()]],
  ['INSERT INTO calendars(tenant_id,id,name,config) VALUES($1,$2,\'Synthetic calendar\',\'{}\')',[b,randomUUID()]]
 ];
 await assert.rejects(person(a),e=>e.code==='DK001');for(const [sql,args]of blocked)await assert.rejects(tenantTransaction(args[0],c=>c.query(sql,args)),e=>e.code==='DK001');
 await tenantTransaction(a,async c=>{await c.query("UPDATE workflows SET status='paused' WHERE tenant_id=$1 AND id=$2",[a,workflow]);await c.query("INSERT INTO calendars(tenant_id,id,name,config,enabled) VALUES($1,$2,'Disabled calendar','{}',false)",[a,randomUUID()]);});
 const saved=(await call('/resellers/'+r.id,'GET',null,owner.cookie)).data;assert.deepEqual(saved.usage,{users:0,contacts:0,custom_records:0,pipelines:2,workflows:1,active_workflows:0,integrations:0,calendars:0});
}));
test('A direct-to-reseller transfer racing a guarded write forces a retry under the new commercial limits',async()=>fixture(async({admin,owner,reseller,update,workspace,plan,person})=>{
 const r=await update(await reseller()),p=await plan(r,{limits:{...limits,contacts:0}}),w=await workspace();
 async function blocked(prefix){
  for(let n=0;n<100;n++){
   await admin.query('SELECT pg_stat_clear_snapshot()');
   if((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE $1",[prefix+'%'])).rowCount)return;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('The controlled commercial race did not reach its lock boundary');
 }
 await admin.query('BEGIN');await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['workspace-entitlements:'+w]);
 let transfer,growth;
 try{
  transfer=call('/workspaces/'+w+'/reseller','PUT',{version:0,reseller_id:r.id,retail_plan_id:p.id,retail_plan_version:1,reason},owner.cookie);
  await blocked('SELECT platform_assign_reseller_workspace');
  growth=person(w).then(()=>({ok:true}),error=>({ok:false,code:error.code}));await blocked('INSERT INTO records');
 }finally{await admin.query('COMMIT');}
 assert.equal((await transfer).status,200);assert.deepEqual(await growth,{ok:false,code:'40001'});await assert.rejects(person(w),e=>e.code==='DK001');
}));
test('Transfers preserve customer data and provider state, prevent stale replay and enforce target allowances',async()=>fixture(async({admin,owner,reseller,update,workspace,plan,assign,person})=>{
 const a=await update(await reseller()),b=await update(await reseller({aggregate_limits:{...limits,contacts:0}})),p=await plan(a),q=await plan(b),w=await workspace();await person(w);await assign(w,a,p);
 const providerBefore=(await admin.query('SELECT to_jsonb(b) AS data FROM workspace_billing b WHERE tenant_id=$1',[w])).rows[0].data;
 const body={version:1,reseller_id:b.id,retail_plan_id:q.id,retail_plan_version:1,reason};assert.equal((await call('/workspaces/'+w+'/reseller','PUT',body,owner.cookie)).status,409);
 assert.equal((await call('/workspaces/'+w+'/reseller','PUT',{...body,retail_plan_id:p.id},owner.cookie)).status,400);
 const detach=await assign(w,null,null,1);assert.equal(detach.version,2);assert.equal(detach.reseller_id,null);
 assert.equal((await call('/workspaces/'+w+'/reseller','PUT',{version:0,reseller_id:a.id,retail_plan_id:p.id,retail_plan_version:1,reason},owner.cookie)).status,409);
 await assign(w,a,p,2);assert.deepEqual((await admin.query('SELECT to_jsonb(b) AS data FROM workspace_billing b WHERE tenant_id=$1',[w])).rows[0].data,providerBefore);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM records WHERE tenant_id=$1',[w])).rows[0].n,1);assert.equal((await call('/resellers/'+a.id+'/customers','GET',null,owner.cookie)).data.items[0].id,w);
}));
test('Transfers wait before commercial locks when Calendar or team holds the workspace row',async()=>fixture(async({admin,owner,reseller,update,workspace,plan})=>{
 const r=await update(await reseller()),p=await plan(r),w=await workspace();
 await admin.query('BEGIN');await admin.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[w]);
 const transfer=call('/workspaces/'+w+'/reseller','PUT',{version:0,reseller_id:r.id,retail_plan_id:p.id,retail_plan_version:1,reason},owner.cookie);
 try{
  let blocked=false;
  for(let n=0;n<100;n++){await admin.query('SELECT pg_stat_clear_snapshot()');blocked=!!(await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT platform_assign_reseller_workspace%'")).rowCount;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.ok(blocked,'Transfer reached the held workspace row');
  await admin.query("SET LOCAL lock_timeout='2s'");
  await admin.query("SELECT set_config('app.tenant_id',$1,true)",[w]);
  await admin.query("INSERT INTO records(id,tenant_id,object_key,data) VALUES($1,$2,'people','{}')",[randomUUID(),w]);
 }finally{await admin.query('COMMIT');}
 assert.equal((await transfer).status,200,'Holding the workspace row does not leave the transfer owning commercial locks needed by this action');
}));
test('Suspension and contract expiry obey the explicit customer access policy and block new reseller administration',async()=>fixture(async({admin,owner,reseller,update,workspace,plan,assign,person})=>{
 let r=await update(await reseller()),p=await plan(r),w=await workspace();await assign(w,r,p);
 r=await update(r,{status:'suspended'});assert.equal((await admin.query('SELECT platform_workspace_suspended($1) AS state',[w])).rows[0].state,false);await person(w);
 const create={key:'paused',definition:p.definition,reason};assert.equal((await call('/resellers/'+r.id+'/plans','POST',create,owner.cookie)).status,409);
 r=await update(r,{status:'suspended',customer_access_policy:'suspend_access'});assert.equal((await admin.query('SELECT platform_workspace_suspended($1) AS state',[w])).rows[0].state,true);await assert.rejects(person(w),err=>err.code==='DK002');
 const workspaceDetail=await call('/workspaces/'+w,'GET',null,owner.cookie);assert.equal(workspaceDetail.data.suspended,false);assert.equal(workspaceDetail.data.access_suspended,true,'Platform-local control remains separate from effective reseller suspension');
 r=await update(r);await person(w);
 r=await update(r,{contract_starts_at:new Date(Date.now()-2*86400000).toISOString(),contract_ends_at:new Date(Date.now()-86400000).toISOString(),customer_access_policy:'suspend_access'});
 assert.equal((await admin.query('SELECT platform_workspace_suspended($1) AS state',[w])).rows[0].state,true);assert.equal((await call('/resellers/'+r.id+'/plans','POST',create,owner.cookie)).status,409);
 assert.equal((await call('/resellers/'+r.id,'PUT',{name:r.name,status:'active',customer_access_policy:r.customer_access_policy,contract_reference:r.contract_reference,billing_mode:r.billing_mode,contract_starts_at:r.contract_starts_at,contract_ends_at:r.contract_ends_at,version:1,reason},owner.cookie)).status,409);
}));
test.after(async()=>{await pool.end();if(platformPool)await platformPool.end();});
