import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import pg from 'pg';
import http from 'node:http';
import { createClient } from 'redis';
import { pool,tenantTransaction } from '../server/db.mjs';
import { initializeWorkspace,saveRecord } from '../server/model.mjs';
import { hashPassword,tokenHash } from '../server/auth.mjs';
import { apiTransaction } from '../server/versioned-api.mjs';

const origin=process.env.TEST_API_ORIGIN || 'http://127.0.0.1:4000';
function call(path,{body,method=body?'POST':'GET',cookie,bearer,idempotency,headers={}}={}) {
 return new Promise((resolve,reject)=>{
  const req=http.request(origin+'/api'+path,{method,headers:{'content-type':'application/json',...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{}),...(cookie?{cookie}:{}),...(bearer?{authorization:'Bearer '+bearer}:{}),...(idempotency?{'idempotency-key':idempotency}:{}),...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString())}));});
  req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
 });
}
test('service accounts and versioned API preserve scoped access, audit principals, retries and immediate revocation',async()=>{
 const tenant=randomUUID(),other=randomUUID(),users=[randomUUID(),randomUUID(),randomUUID()],tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t),password='SyntheticDeveloperPass!2026';
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 const redis=createClient({url:process.env.REDIS_URL});await redis.connect();
 const tx=fn=>tenantTransaction(tenant,fn),keyIds=[];let s,secret,key,record,foreign;
 try {
  const stored=await hashPassword(password);
  await tx(async c=>{
   await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic developer access','api-'+tenant.slice(0,8)]);await initializeWorkspace(c,tenant);
   for(const [i,id]of users.entries()){
    await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,'Synthetic API reviewer',id+'@example.test',stored]);await c.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant,id,['owner','member','viewer'][i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),id,tenant]);
   }
  });
  await tenantTransaction(other,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[other,'Synthetic other API','api-'+other.slice(0,8)]);await initializeWorkspace(c,other);foreign=await saveRecord(c,other,null,'people',{name:'Other private person'});});
  const perms={people:['read','create','update','delete','note'],tasks:['read','create'],invoices:['read']},accountInput={id:randomUUID(),name:'Synthetic inventory connector',permissions:perms,password};
  assert.equal((await call('/v1/me',{cookie:cookies[0]})).status,401,'Browser session cannot substitute for a service credential');
  for(const cookie of cookies.slice(1))assert.equal((await call('/developer/accounts',{body:accountInput,cookie})).status,403);
  assert.equal((await call('/developer/accounts',{body:{...accountInput,password:'IncorrectPassword!'},cookie:cookies[0]})).status,400);
  assert.equal((await call('/developer/accounts',{body:{...accountInput,permissions:{invoices:['read','create']}},cookie:cookies[0]})).status,400);
  let response=await call('/developer/accounts',{body:accountInput,cookie:cookies[0]});assert.equal(response.status,201);s=response.data;
  assert.equal((await call('/developer/accounts',{body:accountInput,cookie:cookies[0]})).status,200,'Account creation retry creates no additional account');
  assert.equal((await call('/developer/accounts/'+s.id,{method:'PUT',cookie:cookies[0],body:{name:s.name,permissions:s.permissions,disabled:false,version:s.version+1}})).status,409,'Stale account approvals are rejected');
  await redis.set(`developer-approval:${users[0]}`,'30',{EX:900});
  assert.equal((await call('/developer/accounts',{cookie:cookies[0],body:{...accountInput,id:randomUUID(),name:'Rate limited identity'}})).status,429);
  await redis.del(`developer-approval:${users[0]}`);
  const createKey={id:randomUUID(),name:'Synthetic import key',permissions:{people:perms.people,tasks:['read']},days:7,account_version:s.version,password};keyIds.push(createKey.id);
  assert.equal((await call(`/developer/accounts/${s.id}/keys`,{cookie:cookies[0],body:{...createKey,permissions:{companies:['read']}}})).status,400);
  response=await call(`/developer/accounts/${s.id}/keys`,{cookie:cookies[0],body:createKey});assert.equal(response.status,201);({key,secret}=response.data);assert.ok(secret.startsWith('dk_v1_'+key.id+'_'));assert.equal(response.headers['cache-control'],'no-store');
  const repeated=await call(`/developer/accounts/${s.id}/keys`,{cookie:cookies[0],body:createKey});assert.equal(repeated.status,200);assert.equal(repeated.data.secret,null,'A key secret is shown only once');
  assert.equal((await tx(c=>c.query('SELECT token_hash FROM api_keys WHERE id=$1',[key.id]))).rows[0].token_hash,tokenHash(secret));
  assert.equal((await call(`/developer/accounts/${s.id}/keys/${key.id}/revoke`,{cookie:cookies[0],body:{version:key.version+1}})).status,409,'Stale key decisions are rejected');
  const metadata=await call(`/developer/accounts/${s.id}/keys`,{cookie:cookies[0]});assert.ok(!JSON.stringify(metadata.data).includes(secret));assert.ok(!JSON.stringify(metadata.data).includes(tokenHash(secret)));
  assert.equal((await call('/session',{bearer:secret})).status,401,'API key cannot sign into browser/account endpoints');
  assert.equal((await call('/v1/me',{bearer:secret.slice(0,-1)+(secret.endsWith('x')?'y':'x')})).status,401);
  assert.equal((await call('/v1/me',{bearer:secret,headers:{'x-workspace-id':other}})).status,403);
  const wrongHost='api-'+other.slice(0,8)+'.'+(process.env.APP_DOMAIN||'localhost');assert.equal((await call('/v1/me',{bearer:secret,headers:{host:wrongHost}})).status,403);
  const identity=await call('/v1/me',{bearer:secret});assert.equal(identity.status,200);assert.equal(identity.data.workspace_id,tenant);assert.equal(identity.data.service_account.id,s.id);
  const objects=await call('/v1/objects',{bearer:secret});assert.deepEqual(objects.data.map(o=>o.key).sort(),['people','tasks']);
  assert.equal((await call('/v1/companies',{bearer:secret})).status,403);
  assert.equal((await call('/v1/contacts/'+foreign.id,{bearer:secret})).status,404);
  assert.equal((await call('/v1/contacts',{bearer:secret,body:{data:{name:'Needs idempotency'}}})).status,400);
  const idempotency=randomUUID(),body={data:{name:'Synthetic API contact',email:'synthetic-api@example.test',tags:['Customer'],consent:false}};
  const pair=await Promise.all([call('/v1/contacts',{bearer:secret,body,idempotency}),call('/v1/contacts',{bearer:secret,body,idempotency})]);assert.equal(pair[0].status,201);assert.equal(pair[1].status,201);assert.deepEqual(pair[0].data,pair[1].data);assert.deepEqual(pair.map(r=>r.headers['idempotency-replayed']).sort(),['false','true']);record=pair[0].data;
  assert.equal(record.created_by,null);assert.equal(record.created_by_service_account_id,s.id);assert.equal((await tx(c=>c.query('SELECT count(*)::int AS n FROM records WHERE object_key=$1',['people']))).rows[0].n,1);
  assert.equal((await call('/v1/contacts',{bearer:secret,body:{data:{name:'Changed retry'}},idempotency})).status,409);
  assert.equal((await call('/v1/contacts/'+record.id,{bearer:secret})).data.id,record.id);assert.equal((await call('/v1/records/people',{bearer:secret})).data.total,1);
  response=await call('/v1/contacts/'+record.id,{method:'PATCH',bearer:secret,idempotency:randomUUID(),body:{version:record.version,data:{phone:'+919876543210'}}});assert.equal(response.status,200);record=response.data;assert.equal(record.data.email,body.data.email,'PATCH preserves omitted fields');
  assert.equal((await call('/v1/contacts/'+record.id,{method:'PATCH',bearer:secret,idempotency:randomUUID(),body:{version:1,data:{name:'Stale edit'}}})).status,409);
  assert.equal((await call('/v1/records/invoices',{bearer:secret,body:{data:{name:'Bypass finance'}},idempotency:randomUUID()})).status,403);
  const noteKey=randomUUID(),note={body:'Synthetic internal note'};response=await call('/v1/contacts/'+record.id+'/activities',{bearer:secret,body:note,idempotency:noteKey});assert.equal(response.status,201);assert.equal(response.data.service_account_id,s.id);
  assert.equal((await call('/v1/contacts/'+record.id+'/activities',{bearer:secret,body:note,idempotency:noteKey})).data.id,response.data.id);
  assert.equal((await call('/v1/contacts/'+record.id+'/activities',{bearer:secret})).data.items.length,1);
  const events=(await tx(c=>c.query("SELECT * FROM outbox WHERE type IN ('crm.people.created','crm.activity.created') ORDER BY occurred_at"))).rows;assert.equal(events.length,2);assert.ok(events.every(e=>e.service_account_id===s.id && e.actor_id===null));
  const audit=await call('/settings/audit',{cookie:cookies[0]});assert.ok(audit.data.some(a=>a.service_account_id===s.id && a.actor_name==='Service account: '+s.name));
  assert.equal((await tenantTransaction(other,c=>c.query('SELECT * FROM api_keys'))).rowCount,0);assert.equal((await pool.query('SELECT * FROM api_keys')).rowCount,0);
  await assert.rejects(tx(c=>c.query('UPDATE api_mutations SET result=$1',[{}])),e=>e.code==='42501');await assert.rejects(tx(c=>c.query('DELETE FROM api_request_logs')),e=>e.code==='42501');
  await tx(c=>c.query("INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields,built_in) VALUES($1,'constructor','Custom constructor objects','Custom constructor object',$2,false)",[tenant,JSON.stringify([{key:'name',name:'Name',type:'text',required:true}])]));
  response=await call('/developer/accounts/'+s.id,{method:'PUT',cookie:cookies[0],body:{name:s.name,permissions:{...s.permissions,constructor:['read']},disabled:false,version:s.version,password}});assert.equal(response.status,200,'Own custom object keys cannot collide with prototype properties');s=response.data;
  const reduced={name:s.name,permissions:{people:['read'],tasks:['read'],invoices:['read']},disabled:false,version:s.version};response=await call('/developer/accounts/'+s.id,{method:'PUT',cookie:cookies[0],body:reduced});assert.equal(response.status,200);s=response.data;
  assert.equal((await call('/v1/contacts',{bearer:secret,body,idempotency})).status,403,'Permission checks precede replay');
  response=await call('/developer/accounts/'+s.id,{method:'PUT',cookie:cookies[0],body:{...reduced,permissions:perms,version:s.version,password}});assert.equal(response.status,200);s=response.data;
  assert.equal((await call('/v1/contacts',{bearer:secret,body:{data:{name:'No silent restoration'}},idempotency:randomUUID()})).status,403);
  key=(await call(`/developer/accounts/${s.id}/keys`,{cookie:cookies[0]})).data.keys.find(k=>k.id===key.id);assert.deepEqual(key.permissions.people,['read']);
  const rotation={id:randomUUID(),version:key.version,account_version:s.version,days:30,password};keyIds.push(rotation.id);response=await call(`/developer/accounts/${s.id}/keys/${key.id}/rotate`,{cookie:cookies[0],body:rotation});assert.equal(response.status,201);const rotated=response.data;
  assert.equal((await call('/v1/me',{bearer:secret})).status,401);assert.equal((await call('/v1/me',{bearer:rotated.secret})).status,200);
  assert.equal((await call(`/developer/accounts/${s.id}/keys/${key.id}/rotate`,{cookie:cookies[0],body:rotation})).data.secret,null);
  await redis.set(`developer-api:${tenant}:${rotated.key.id}`,'120',{EX:60});response=await call('/v1/me',{bearer:rotated.secret});assert.equal(response.status,429);assert.equal(response.headers['retry-after'],'60');await redis.del(`developer-api:${tenant}:${rotated.key.id}`);
  let release,ready;const held=new Promise(r=>release=r),locked=new Promise(r=>ready=r);
  const inflight=apiTransaction({tenant_id:tenant,id:rotated.key.id,hash:tokenHash(rotated.secret)},async()=>{ready();await held;return 'completed before disable';});await locked;
  const disabling=call('/developer/accounts/'+s.id,{method:'PUT',cookie:cookies[0],body:{name:s.name,permissions:s.permissions,disabled:true,version:s.version}});release();assert.equal(await inflight,'completed before disable');response=await disabling;assert.equal(response.status,200);s=response.data;assert.equal((await call('/v1/me',{bearer:rotated.secret})).status,401);
  assert.equal((await call('/developer/accounts/'+s.id,{method:'PUT',cookie:cookies[0],body:{name:s.name,permissions:s.permissions,disabled:false,version:s.version}})).status,400,'Reactivation needs fresh password approval');
  response=await call('/developer/accounts/'+s.id,{method:'PUT',cookie:cookies[0],body:{name:s.name,permissions:s.permissions,disabled:false,version:s.version,password}});assert.equal(response.status,200);s=response.data;
  assert.equal((await call(`/developer/accounts/${s.id}/keys/${rotated.key.id}/revoke`,{cookie:cookies[0],body:{version:rotated.key.version}})).status,200);assert.equal((await call('/v1/me',{bearer:rotated.secret})).status,401);
  const finalKey={...createKey,id:randomUUID(),account_version:s.version};keyIds.push(finalKey.id);const fresh=(await call(`/developer/accounts/${s.id}/keys`,{cookie:cookies[0],body:finalKey})).data;
  await tx(c=>c.query("UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1",[fresh.key.id]));assert.equal((await call('/v1/me',{bearer:fresh.secret})).status,401);
  await tx(async c=>{for(let i=0;i<26;i++)await c.query("INSERT INTO service_accounts(tenant_id,id,name,permissions,created_at) VALUES($1,$2,$3,$4,'2026-10-02 01:00:00.123456+00')",[tenant,randomUUID(),'Synthetic paginated '+i,{people:['read']}]);});
  const firstPage=await call('/developer/accounts',{cookie:cookies[0]});assert.equal(firstPage.data.accounts.length,25);assert.ok(firstPage.data.next_cursor);
  const lastPage=await call('/developer/accounts?cursor='+firstPage.data.next_cursor,{cookie:cookies[0]});assert.equal(lastPage.data.accounts.length,2);assert.equal(lastPage.data.next_cursor,null);assert.equal(new Set([...firstPage.data.accounts,...lastPage.data.accounts].map(a=>a.id)).size,27,'Exact PostgreSQL cursor precision neither skips nor repeats identities');
  const logs=await call('/developer/requests',{cookie:cookies[0]});assert.ok(logs.data.items.length);assert.ok(logs.data.items.some(l=>l.status===429));assert.ok(!JSON.stringify(logs.data).includes(secret));assert.ok(logs.data.items.every(l=>!l.operation.includes('synthetic-api')));
  assert.ok((await tx(c=>c.query("SELECT count(*)::int AS n FROM usage_ledger WHERE metric='api_requests' AND service_account_id=$1",[s.id]))).rows[0].n>10);
 } finally {
  // Let already-finished HTTP callbacks persist their append-only history before removing this exact synthetic tenant.
  await new Promise(r=>setImmediate(r));
  await admin.query('BEGIN');
  try {
   for(const t of [tenant,other]) {
    for(const table of ['api_request_logs','api_mutations','activities','record_links','records','outbox','audit_events','usage_ledger','api_keys','service_accounts','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[t]);await admin.query('DELETE FROM workspaces WHERE id=$1',[t]);
   }
   await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.query('COMMIT');
  }catch(e){await admin.query('ROLLBACK');throw e;}
  await redis.del(`developer-approval:${users[0]}`);
  for(const id of keyIds)await redis.del(`developer-api:${tenant}:${id}`);await redis.quit();await admin.end();await pool.end();
 }
});
