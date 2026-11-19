import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool} from '../server/db.mjs';
import {platformPool} from '../server/platform-db.mjs';
import {resellerApiPool,validateResellerApiDatabase} from '../server/reseller-api.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {encryptCredential} from '../server/automation.mjs';
import {base32} from '../server/mfa.mjs';
import {entitlementMeters,entitlementFeatures} from '../server/entitlements.mjs';

after(async()=>{await pool.end();await platformPool?.end();await resellerApiPool?.end();});
const origin=process.env.TEST_API_ORIGIN,reason='Synthetic reseller API acceptance';
const scopes=['reseller.customers.read','reseller.plans.read','reseller.usage.read'];
let address=10;
function call(path,{method='GET',body,cookie='',secret='',headers={}}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request(origin+path,{method,headers:{'content-type':'application/json',cookie,...(secret?{authorization:'Bearer '+secret}:{}),...headers}},res=>{
   const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks)),headers:res.headers});}catch{reject(Error('Invalid reseller response'));}});
  });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Reseller request timed out')));if(body)req.write(JSON.stringify(body));req.end();
 });
}
async function fixture(action){
 const url=new URL(process.env.LOCAL_DATABASE_ADMIN_URL||'');assert.match(url.pathname,/^\/drykraft_reseller_check_[a-f0-9]+$/,'Owned disposable clone required');
 const admin=new pg.Client({connectionString:url.toString()});await admin.connect();
 const headers={'x-forwarded-for':'203.0.113.'+address++};
 const request=(path,options={})=>call(path,{...options,headers:{...headers,...options.headers}});
 async function actor(role='owner'){
  const id=randomUUID(),session=randomBytes(32).toString('hex');
  await admin.query("INSERT INTO platform_accounts(id,name,email,password_hash,role,mfa_enabled_at,secret_ciphertext) VALUES($1,'Synthetic key administrator',$2,$3,$4,now(),$5)",[id,id+'@example.test',await hashPassword('Synthetic-platform-password-123'),role,encryptCredential('platform-mfa:'+id,{secret:base32(randomBytes(20))})]);
  await admin.query("INSERT INTO platform_sessions(token_hash,account_id,auth_version,expires_at) VALUES($1,$2,1,now()+interval '1 hour')",[tokenHash(session),id]);return {id,cookie:'drykraft_sa_session='+session};
 }
 const owner=await actor();
 const metadata={name:'Synthetic API reseller',customer_access_policy:'retain_access',contract_reference:'SYNTHETIC-API',billing_mode:'wholesale',contract_starts_at:new Date(Date.now()-86400000).toISOString(),contract_ends_at:new Date(Date.now()+30*86400000).toISOString()};
 const limits=Object.fromEntries(entitlementMeters.map(k=>[k,null])),features=Object.fromEntries(entitlementFeatures.map(k=>[k,true]));
 async function reseller(){
  const created=await request('/api/sa/resellers',{method:'POST',cookie:owner.cookie,body:{key:'api-'+randomUUID().slice(0,8),...metadata,reason,grant:{platform_plan_id:'00000000-0000-4000-8000-000000000001',platform_plan_version:1,max_workspaces:40,trial_days_max:15,limits,aggregate_limits:limits,features}}});
  assert.equal(created.status,201,JSON.stringify(created.data));return created.data;
 }
 async function update(r,status='active'){
  const saved=await request('/api/sa/resellers/'+r.id,{method:'PUT',cookie:owner.cookie,body:{...metadata,status,version:r.version,reason}});assert.equal(saved.status,200,JSON.stringify(saved.data));return saved.data;
 }
 async function issue(r,changes={},who=owner){
  const body={name:'Synthetic integration',scopes,expires_at:new Date(Date.now()+86400000).toISOString(),request_id:randomUUID(),reason,...changes};
  const saved=await request('/api/sa/resellers/'+r.id+'/api-keys',{method:'POST',cookie:who.cookie,body});return {...saved,input:body};
 }
 try{await action({admin,owner,actor,request,reseller,update,issue,metadata,limits,features});}finally{await admin.end();}
}

test('platform key administration enforces host, MFA session and separate owner/admin roles',()=>fixture(async f=>{
 const r=await f.reseller(),path='/api/sa/resellers/'+r.id+'/api-keys';
 assert.equal((await f.request(path)).status,401);
 assert.equal((await f.request(path,{cookie:f.owner.cookie,headers:{host:'other.localhost'}})).status,404);
 for(const role of ['support','billing','viewer']){
  const a=await f.actor(role);assert.equal((await f.issue(r,{},a)).status,403);
  assert.equal((await f.request(path,{cookie:a.cookie})).status,role==='viewer'?200:403);
 }
 assert.equal((await f.issue(r)).status,403,'Pending reseller cannot receive a key');
 const active=await f.update(r),a=await f.actor('admin'),created=await f.issue(active,{},a);assert.equal(created.status,201);
 await f.admin.query('UPDATE platform_accounts SET disabled=true,auth_version=auth_version+1 WHERE id=$1',[a.id]);
 assert.equal((await f.issue(active,{},a)).status,401);
}));

test('one-time key issuance retries and concurrent requests create one digest, immutable scopes and audited result',()=>fixture(async f=>{
 const r=await f.update(await f.reseller()),requestId=randomUUID(),expires=new Date(Date.now()+86400000).toISOString();
 const [a,b]=await Promise.all([f.issue(r,{request_id:requestId,expires_at:expires}),f.issue(r,{request_id:requestId,expires_at:expires})]);
 assert.deepEqual([a.status,b.status].sort(),[200,201]);const first=a.status===201?a:b,replay=a.status===200?a:b;
 assert.match(first.data.secret,/^dk_res_[a-f0-9]{64}$/);assert.equal(replay.data.secret,null);assert.equal(first.data.key.id,replay.data.key.id);
 const row=(await f.admin.query('SELECT * FROM reseller_api_keys WHERE id=$1',[first.data.key.id])).rows[0];assert.equal(row.token_hash,tokenHash(first.data.secret));assert.equal(JSON.stringify(row).includes(first.data.secret),false);
 assert.equal((await f.issue(r,{...first.input,name:'Changed input'})).status,409);
 for(const changes of [{scopes:['records.read']},{scopes:[scopes[0],scopes[0]]},{scopes:[]},{expires_at:new Date(Date.now()-1000).toISOString()},{expires_at:new Date(Date.now()+91*86400000).toISOString()}])assert.equal((await f.issue(r,changes)).status,400);
 const listed=await f.request('/api/sa/resellers/'+r.id+'/api-keys',{cookie:f.owner.cookie});assert.equal(listed.data.items.length,1);assert.equal('token_hash' in listed.data.items[0],false);assert.equal('input_hash' in listed.data.items[0],false);
 assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM platform_audit WHERE resource_id=$1 AND action='reseller.api_key.created'",[r.id])).rows[0].n,1);
 await assert.rejects(f.admin.query('UPDATE reseller_api_keys SET scopes=$2 WHERE id=$1',[row.id,[scopes[0]]]),e=>e.code==='42501');
}));

test('reseller Bearer scope cannot select another parent or become a customer/platform credential',()=>fixture(async f=>{
 const r=await f.update(await f.reseller()),other=await f.update(await f.reseller()),key=await f.issue(r,{scopes:[scopes[2]]}),secret=key.data.secret;
 for(const path of ['/api/v1/reseller/me','/api/v1/reseller/usage']){
  const response=await f.request(path,{secret,headers:{'x-workspace-id':other.id}});assert.equal(response.status,200);assert.equal(response.data.reseller_id,r.id);assert.equal(response.headers['cache-control'],'no-store');
 }
 assert.equal((await f.request('/api/v1/reseller/customers',{secret})).status,403);
 assert.equal((await f.request('/api/v1/reseller/plans',{secret})).status,403);
 assert.equal((await f.request('/api/v1/reseller/usage?reseller_id='+other.id,{secret})).status,400);
 assert.equal((await f.request('/api/v1/reseller/me',{secret,headers:{host:'customer.localhost'}})).status,404);
 assert.equal((await f.request('/api/v1/reseller/me',{cookie:f.owner.cookie})).status,401);
 assert.equal((await f.request('/api/v1/reseller/me',{secret:'dk_fake_'+randomBytes(32).toString('hex')})).status,401);
 assert.equal((await f.request('/api/v1/me',{secret})).status,401);
 assert.equal((await f.request('/api/sa/session',{secret})).status,401);
 assert.equal((await f.request('/api/v1/reseller/customers/'+other.id,{secret})).status,404);
 assert.equal((await f.request('/api/v1/reseller/customers',{secret,method:'POST',body:{name:'Attempted write'}})).status,404);
}));

test('customer and retail pagination are bounded to the current parent and reflect transfers',()=>fixture(async f=>{
 const r=await f.update(await f.reseller()),other=await f.update(await f.reseller());
 const definition={name:'Synthetic catalog',currency:'KWD',monthly_price_minor:12345,annual_price_minor:123450,setup_price_minor:0,trial_days:15,limits:f.limits,features:f.features};
 const ownPlans=[],customers=[];
 for(let i=0;i<26;i++){
  const plan=randomUUID();ownPlans.push(plan);
  await f.admin.query('SELECT platform_publish_retail_plan($1,$2,$3,0,$4,$5,$6,$7)',[r.id,plan,f.owner.id,'plan-'+plan.slice(0,8),definition,reason,randomUUID()]);
  const workspace=randomUUID();customers.push(workspace);
  await f.admin.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Synthetic API customer',$2)",[workspace,'api-'+workspace.slice(0,8)]);
  await f.admin.query('SELECT platform_assign_reseller_workspace($1,$2,0,$3,$4,1,$5,$6)',[workspace,f.owner.id,r.id,plan,reason,randomUUID()]);
 }
 const otherPlan=randomUUID();await f.admin.query('SELECT platform_publish_retail_plan($1,$2,$3,0,$4,$5,$6,$7)',[other.id,otherPlan,f.owner.id,'other-'+otherPlan.slice(0,8),definition,reason,randomUUID()]);
 const key=await f.issue(r),secret=key.data.secret;
 for(const [path,ids] of [['customers',customers],['plans',ownPlans]]){
  const first=await f.request('/api/v1/reseller/'+path,{secret});assert.equal(first.status,200);assert.equal(first.data.items.length,25);assert.ok(first.data.next_cursor);
  const next=await f.request('/api/v1/reseller/'+path+'?cursor='+first.data.next_cursor,{secret});assert.equal(next.data.items.length,1);assert.equal(next.data.next_cursor,null);
  assert.deepEqual([...first.data.items,...next.data.items].map(v=>v.id).sort(),ids.sort());
 }
 const catalog=await f.request('/api/v1/reseller/plans',{secret});assert.equal(catalog.data.items[0].monthly_price_minor,12345);assert.equal(catalog.data.items[0].currency,'KWD');
 await f.admin.query('SELECT platform_assign_reseller_workspace($1,$2,1,$3,$4,1,$5,$6)',[customers[0],f.owner.id,other.id,otherPlan,reason,randomUUID()]);
 const remaining=await f.request('/api/v1/reseller/customers',{secret});assert.equal(remaining.data.items.length,25);assert.equal(remaining.data.next_cursor,null);assert.ok(remaining.data.items.every(v=>v.id!==customers[0]));
 assert.equal((await f.request('/api/v1/reseller/usage',{secret})).data.customer_count,25);
}));

test('contract suspension and expiry stop reseller keys even when customers retain access',()=>fixture(async f=>{
 let r=await f.update(await f.reseller());const key=await f.issue(r),secret=key.data.secret;
 r=await f.update(r,'suspended');assert.equal((await f.request('/api/v1/reseller/me',{secret})).status,403);
 const replay=await f.issue(r,key.input);assert.equal(replay.status,200);assert.equal(replay.data.secret,null);
 r=await f.update(r);assert.equal((await f.request('/api/v1/reseller/me',{secret})).status,200);
 await f.admin.query("UPDATE reseller_organizations SET contract_ends_at=now()-interval '1 minute' WHERE id=$1",[r.id]);
 assert.equal((await f.request('/api/v1/reseller/me',{secret})).status,403);
 const revoked=await f.request('/api/sa/resellers/'+r.id+'/api-keys/'+key.data.key.id,{method:'PUT',cookie:f.owner.cookie,body:{version:1,reason}});assert.equal(revoked.status,200,'Expired contract does not prevent revocation');
 assert.equal((await f.request('/api/v1/reseller/me',{secret})).status,401);
}));

test('dedicated database role has function-only authority, forced RLS and no token digest or CRM reads',()=>fixture(async f=>{
 await validateResellerApiDatabase();
 for(const table of ['records','users','memberships','credentials','platform_accounts','reseller_organizations','reseller_api_keys','reseller_api_requests'])await assert.rejects(resellerApiPool.query('SELECT * FROM '+table),e=>e.code==='42501');
 await assert.rejects(resellerApiPool.query('SELECT reseller_api_authorize($1,NULL)',[tokenHash('unavailable')]),e=>e.code==='42501');
 await assert.rejects(pool.query('SELECT reseller_api_identity($1)',[tokenHash('unavailable')]),e=>e.code==='42501');
 const c=await resellerApiPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.reseller_id',$1,true)",[randomUUID()]);await assert.rejects(c.query('SELECT reseller_api_read($1,\'usage\',NULL,$2)',[tokenHash('unavailable'),randomUUID()]),e=>e.code==='DR401');}finally{await c.query('ROLLBACK');c.release();}
 const policies=(await f.admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('reseller_api_keys','reseller_api_requests')")).rows;assert.equal(policies.length,2);assert.ok(policies.every(p=>p.relrowsecurity&&p.relforcerowsecurity));
 await f.admin.query('GRANT SELECT ON records TO drykraft_reseller_api');try{await assert.rejects(validateResellerApiDatabase(),/dedicated role/);}finally{await f.admin.query('REVOKE SELECT ON records FROM drykraft_reseller_api');}await validateResellerApiDatabase();
 await f.admin.query('GRANT EXECUTE ON FUNCTION reseller_api_authorize(text,text) TO drykraft_reseller_api');try{await assert.rejects(validateResellerApiDatabase(),/dedicated role/);}finally{await f.admin.query('REVOKE EXECUTE ON FUNCTION reseller_api_authorize(text,text) FROM drykraft_reseller_api');}await validateResellerApiDatabase();
 await f.admin.query('GRANT SELECT(password_hash) ON users TO drykraft_reseller_api');try{await assert.rejects(validateResellerApiDatabase(),/dedicated role/);}finally{await f.admin.query('REVOKE SELECT(password_hash) ON users FROM drykraft_reseller_api');}await validateResellerApiDatabase();
 const r=await f.update(await f.reseller());
 for(const invalid of [[],['records.read'],[scopes[0],scopes[1],scopes[2],scopes[0]]])await assert.rejects(f.admin.query("INSERT INTO reseller_api_keys(id,reseller_id,name,token_hash,prefix,scopes,expires_at,created_by,request_id,input_hash) VALUES($1,$2,'Invalid scope probe',$3,'dk_res_12345678',$4,now()+interval '1 day',$5,$6,$7)",[randomUUID(),r.id,tokenHash(randomUUID()),invalid,f.owner.id,randomUUID(),tokenHash('synthetic-invalid-scope')]),e=>e.code==='23514');
}));

test('revocation serializes with accepted database reads and retains immutable metadata audit',()=>fixture(async f=>{
 const r=await f.update(await f.reseller()),key=await f.issue(r),secret=key.data.secret,c=await resellerApiPool.connect();
 let pending,settled=false;
 try{
  await c.query('BEGIN');await c.query('SELECT reseller_api_read($1,\'me\',NULL,$2)',[tokenHash(secret),randomUUID()]);
  pending=f.request('/api/sa/resellers/'+r.id+'/api-keys/'+key.data.key.id,{method:'PUT',cookie:f.owner.cookie,body:{version:1,reason}}).then(v=>{settled=true;return v;});
  let blocked=false;for(let i=0;i<30;i++){blocked=(await f.admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%FROM reseller_api_keys%FOR UPDATE%') AS found")).rows[0].found;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(blocked,true);assert.equal(settled,false);await c.query('COMMIT');assert.equal((await pending).status,200);
 }finally{await c.query('ROLLBACK');c.release();if(pending)await pending;}
 assert.equal((await f.request('/api/v1/reseller/me',{secret})).status,401);
 assert.equal((await f.request('/api/sa/resellers/'+r.id+'/api-keys/'+key.data.key.id,{method:'PUT',cookie:f.owner.cookie,body:{version:1,reason}})).status,409);
 const audit=(await f.admin.query('SELECT * FROM reseller_api_requests WHERE key_id=$1',[key.data.key.id])).rows;assert.equal(audit.length,1);assert.deepEqual(Object.keys(audit[0]).sort(),['action','created_at','id','key_id','reseller_id']);assert.equal(JSON.stringify(audit).includes(secret),false);
 await assert.rejects(f.admin.query('DELETE FROM reseller_api_requests WHERE key_id=$1',[key.data.key.id]),e=>e.code==='42501');
 await assert.rejects(f.admin.query('UPDATE reseller_api_keys SET revoked_at=NULL,version=version+1 WHERE id=$1',[key.data.key.id]),e=>e.code==='42501');
}));

test('expired credentials fail and the shared per-key request ceiling survives IP changes',()=>fixture(async f=>{
 const r=await f.update(await f.reseller()),expiredSecret='dk_res_'+randomBytes(32).toString('hex');
 await f.admin.query("INSERT INTO reseller_api_keys(id,reseller_id,name,token_hash,prefix,scopes,expires_at,created_by,request_id,input_hash,created_at) VALUES($1,$2,'Expired synthetic key',$3,$4,$5,now()-interval '1 minute',$6,$7,$8,now()-interval '1 day')",[randomUUID(),r.id,tokenHash(expiredSecret),expiredSecret.slice(0,15),scopes,f.owner.id,randomUUID(),tokenHash('expired-input')]);
 assert.equal((await f.request('/api/v1/reseller/me',{secret:expiredSecret})).status,401);
 const key=await f.issue(r),secret=key.data.secret;
 for(let i=0;i<120;i++)assert.equal((await f.request('/api/v1/reseller/me',{secret,headers:{'x-forwarded-for':i%2?'198.51.100.20':'198.51.100.21'}})).status,200);
 const limited=await f.request('/api/v1/reseller/me',{secret});assert.equal(limited.status,429);assert.ok(Number(limited.headers['retry-after'])>0);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM reseller_api_requests WHERE key_id=$1',[key.data.key.id])).rows[0].n,120,'Rejected requests never reach the metadata reader');
}));

test('exact key detail and creation recovery preserve original-actor, parent and realm boundaries',()=>fixture(async f=>{
 const r=await f.update(await f.reseller()),other=await f.update(await f.reseller()),issued=await f.issue(r),base='/api/sa/resellers/'+r.id+'/api-keys',detail=base+'/'+issued.data.key.id,receipt=base+'/creations/'+issued.input.request_id;
 for(const role of ['owner','admin','viewer']){const a=await f.actor(role),result=await f.request(detail,{cookie:a.cookie});assert.equal(result.status,200);assert.deepEqual(result.data,issued.data.key);assert.equal(JSON.stringify(result.data).includes(issued.data.secret),false);for(const hidden of ['token_hash','input_hash','request_id','secret'])assert.equal(hidden in result.data,false);assert.equal((await f.request(receipt,{cookie:a.cookie})).status,role==='viewer'?403:404);}
 for(const role of ['support','billing']){const a=await f.actor(role);for(const path of [detail,receipt])assert.equal((await f.request(path,{cookie:a.cookie})).status,403);}
 for(const path of [detail,receipt]){assert.equal((await f.request(path)).status,401);assert.equal((await f.request(path,{secret:issued.data.secret})).status,401);assert.equal((await f.request(path,{cookie:f.owner.cookie,headers:{host:'customer.localhost'}})).status,404);assert.equal((await f.request(path+'?reseller_id='+other.id,{cookie:f.owner.cookie})).status,400);}
 assert.equal((await f.request('/api/sa/resellers/'+other.id+'/api-keys/'+issued.data.key.id,{cookie:f.owner.cookie})).status,404);
 assert.equal((await f.request('/api/sa/resellers/'+other.id+'/api-keys/creations/'+issued.input.request_id,{cookie:f.owner.cookie})).status,404);
 const recovered=await f.request(receipt,{cookie:f.owner.cookie});assert.equal(recovered.status,200);assert.deepEqual(recovered.data,{key:issued.data.key,secret:null,replayed:true});assert.equal(recovered.headers['cache-control'],'no-store');
 assert.equal((await f.request(base+'/creations/'+randomUUID(),{cookie:f.owner.cookie})).status,404);
}));

test('saved key detail remains recoverable after contract pause and returns current revoked metadata',()=>fixture(async f=>{
 let r=await f.update(await f.reseller());const issued=await f.issue(r),base='/api/sa/resellers/'+r.id+'/api-keys',detail=base+'/'+issued.data.key.id,receipt=base+'/creations/'+issued.input.request_id;
 r=await f.update(r,'suspended');assert.equal((await f.request(receipt,{cookie:f.owner.cookie})).status,200);assert.equal((await f.request(detail,{cookie:f.owner.cookie})).status,200);assert.equal((await f.issue(r)).status,403);
 const revoked=await f.request(detail,{method:'PUT',cookie:f.owner.cookie,body:{version:1,reason}});assert.equal(revoked.status,200);assert.ok(revoked.data.revoked_at);assert.equal(revoked.data.version,2);
 const recovered=await f.request(receipt,{cookie:f.owner.cookie});assert.deepEqual(recovered.data,{key:revoked.data,secret:null,replayed:true});assert.deepEqual((await f.request(detail,{cookie:f.owner.cookie})).data,revoked.data);
 const replay=await f.issue(r,issued.input);assert.equal(replay.status,200);assert.equal(replay.data.key.revoked_at,revoked.data.revoked_at);assert.equal(replay.data.secret,null);
 assert.equal((await f.request('/api/v1/reseller/me',{secret:issued.data.secret})).status,401);
 await f.admin.query('UPDATE platform_accounts SET disabled=true,auth_version=auth_version+1 WHERE id=$1',[f.owner.id]);for(const path of [detail,receipt])assert.equal((await f.request(path,{cookie:f.owner.cookie})).status,401);
}));

test('simultaneous setup retries reveal one secret and exact recovery works beyond a directory page',()=>fixture(async f=>{
 const r=await f.update(await f.reseller()),other=await f.update(await f.reseller()),input={request_id:randomUUID(),expires_at:new Date(Date.now()+86400000).toISOString()},results=await Promise.all(Array.from({length:6},()=>f.issue(r,input)));
 assert.deepEqual(results.map(v=>v.status).sort(),[200,200,200,200,200,201]);assert.equal(results.filter(v=>!!v.data.secret).length,1);const key=results[0].data.key,receipt='/api/sa/resellers/'+r.id+'/api-keys/creations/'+input.request_id;
 assert.equal(new Set(results.map(v=>v.data.key.id)).size,1);assert.equal((await f.request(receipt,{cookie:f.owner.cookie})).data.key.id,key.id);assert.equal((await f.issue(other,input)).status,409);
 for(let i=0;i<25;i++)assert.equal((await f.issue(r,{name:'Synthetic paged key '+i})).status,201);
 const listed=await f.request('/api/sa/resellers/'+r.id+'/api-keys',{cookie:f.owner.cookie});assert.equal(listed.data.items.length,25);assert.ok(listed.data.next_cursor);assert.equal((await f.request('/api/sa/resellers/'+r.id+'/api-keys/'+key.id,{cookie:f.owner.cookie})).data.id,key.id);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM reseller_api_keys WHERE created_by=$1 AND request_id=$2',[f.owner.id,input.request_id])).rows[0].n,1);
}));
