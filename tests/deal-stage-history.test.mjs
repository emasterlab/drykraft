import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import http from 'node:http';
import {createClient} from 'redis';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace,saveRecord,dealStageHistory} from '../server/model.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
function call(path,{body,cookie,bearer,method=body?'POST':'GET',idempotency}={}) {return new Promise((resolve,reject)=>{
 const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api'+path,{method,headers:{'content-type':'application/json',...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{}),...(cookie?{cookie}:{}),...(bearer?{authorization:'Bearer '+bearer}:{}),...(idempotency?{'idempotency-key':idempotency}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(raw)})}catch(e){reject(e)}})});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
});}
test('deal history records shared mutations atomically, snapshots names, orders exact pages and enforces tenant/API roles',async()=>{
 const tenants=[randomUUID(),randomUUID()],user=randomUUID(),token=randomBytes(32).toString('hex'),cookie='drykraft_session='+token,password='SyntheticStagePass!2026';
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 const redis=createClient({url:process.env.REDIS_URL});await redis.connect();const tx=fn=>tenantTransaction(tenants[0],fn);let pipeline,deal,foreign,account;const keys=[];
 try {
  await admin.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,'Synthetic stage reviewer',user+'@example.test',await hashPassword(password)]);
  for(const tenant of tenants)await tenantTransaction(tenant,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic stage QA','stage-'+tenant.slice(0,8)]);const p=await initializeWorkspace(c,tenant);if(tenant===tenants[0])pipeline=p;else foreign=await saveRecord(c,tenant,user,'deals',{name:'Foreign deal',pipeline_id:p,stage:'new'});});
  await tx(async c=>{await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenants[0],user]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(token),user,tenants[0]]);});
  let response=await call('/records/deals',{cookie,body:{data:{name:'Synthetic stage deal',pipeline_id:pipeline,stage:'new',status:'Open'}}});assert.equal(response.status,201);deal=response.data;
  const history=()=>call('/records/deals/'+deal.id+'/stage-history',{cookie});
  let rows=(await history()).data.items;assert.equal(rows.length,1);assert.equal(rows[0].from_stage,null);assert.equal(rows[0].to_stage.stage_name,'New');assert.equal(rows[0].actor_name,'Synthetic stage reviewer');
  response=await call('/records/deals/'+deal.id,{cookie,method:'PUT',body:{version:deal.version,data:{...deal.data,name:'Renamed deal'}}});assert.equal(response.status,200);deal=response.data;assert.equal((await history()).data.items.length,1,'Other field edits are not moves');
  const prior=deal;
  const concurrent=await Promise.all(['qualified','proposal'].map(stage=>call('/records/deals/'+deal.id,{cookie,method:'PUT',body:{version:prior.version,data:{...prior.data,stage}}})));
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);deal=concurrent.find(r=>r.status===200).data;rows=(await history()).data.items;assert.equal(rows.length,2);assert.equal(rows[0].from_stage.stage_id,'new');assert.equal(rows[0].to_stage.stage_id,deal.data.stage);
  assert.equal((await call('/records/deals/'+deal.id,{cookie,method:'PUT',body:{version:deal.version,data:{...deal.data,stage:'invalid'}}})).status,400);assert.equal((await history()).data.items.length,2);
  await assert.rejects(tx(async c=>{await saveRecord(c,tenants[0],user,'deals',{...deal.data,stage:'negotiation'},deal.id,deal.version);throw new Error('Synthetic rollback');}),/Synthetic rollback/);assert.equal((await history()).data.items.length,2);
  const originalPipeline=(await tx(c=>c.query('SELECT * FROM pipelines WHERE id=$1',[pipeline]))).rows[0];
  await tx(c=>c.query('UPDATE pipelines SET name=$1,stages=$2 WHERE id=$3',['Renamed pipeline',JSON.stringify(originalPipeline.stages.map(s=>({...s,name:'Renamed '+s.name}))),pipeline]));
  rows=(await history()).data.items;assert.equal(rows[0].to_stage.pipeline_name,'Sales pipeline');assert.ok(!rows[0].to_stage.stage_name.startsWith('Renamed'));
  response=await call('/record-tools/deals/bulk',{cookie,body:{records:[{id:deal.id,version:deal.version}],action:'update',data:{stage:'negotiation'}}});assert.equal(response.status,200);
  deal=(await call('/records/deals/'+deal.id,{cookie})).data;rows=(await history()).data.items;assert.equal(rows.length,3);assert.equal(rows[0].to_stage.stage_name,'Renamed Negotiation');
  const imported={id:randomUUID(),csv:'Name,Pipeline,Stage\nSynthetic imported deal,'+pipeline+',new',mapping:['name','pipeline_id','stage']};
  assert.equal((await call('/record-tools/deals/import/commit',{cookie,body:imported})).status,200);assert.equal((await call('/record-tools/deals/import/commit',{cookie,body:imported})).status,200);
  const importedDeal=(await tx(c=>c.query("SELECT id FROM records WHERE data->>'name'='Synthetic imported deal'"))).rows[0];assert.equal((await tx(c=>dealStageHistory(c,importedDeal.id))).items.length,1,'Retried import creates one initial entry');
  response=await call('/developer/accounts',{cookie,body:{id:randomUUID(),name:'Synthetic stage integration',permissions:{deals:['read','update'],people:['read']},password}});assert.equal(response.status,201);account=response.data;
  async function key(permissions){const id=randomUUID();keys.push(id);const r=await call('/developer/accounts/'+account.id+'/keys',{cookie,body:{id,name:'Synthetic stage key',permissions,days:1,account_version:account.version,password}});assert.equal(r.status,201);return r.data.secret;}
  const bearer=await key({deals:['read','update']}),ungranted=await key({people:['read']});
  assert.equal((await call('/v1/opportunities/'+deal.id+'/stage-history',{bearer:ungranted})).status,403);assert.equal((await call('/v1/contacts/'+deal.id+'/stage-history',{bearer:ungranted})).status,404);assert.equal((await call('/v1/opportunities/'+foreign.id+'/stage-history',{bearer})).status,404);
  const mutation={bearer,method:'PATCH',idempotency:randomUUID(),body:{version:deal.version,data:{stage:'won',status:'Won'}}};response=await call('/v1/opportunities/'+deal.id,mutation);assert.equal(response.status,200);deal=response.data;
  assert.equal((await call('/v1/opportunities/'+deal.id,mutation)).status,200);rows=(await call('/v1/records/deals/'+deal.id+'/stage-history',{bearer})).data.items;assert.equal(rows.length,4);assert.equal(rows[0].service_account_id,account.id);assert.equal(rows[0].actor_name,'Service account: Synthetic stage integration');
  const events=(await tx(c=>c.query("SELECT data,service_account_id FROM outbox WHERE resource_id=$1 AND type='crm.deals.stage_changed' ORDER BY occurred_at DESC",[deal.id]))).rows;assert.equal(events.length,3);assert.ok(events.some(e=>e.service_account_id===account.id && e.data.from_stage.stage_id==='negotiation' && e.data.to_stage.stage_id==='won' && e.data.stage_history_id));
  assert.equal((await call('/records/deals/'+foreign.id+'/stage-history',{cookie})).status,404);assert.equal((await pool.query('SELECT * FROM deal_stage_history')).rowCount,0);assert.equal((await tenantTransaction(tenants[1],c=>c.query('SELECT * FROM deal_stage_history WHERE deal_id=$1',[deal.id]))).rowCount,0);
  for(const sql of ['UPDATE deal_stage_history SET record_version=99','DELETE FROM deal_stage_history'])await assert.rejects(tx(c=>c.query(sql)),e=>e.code==='42501');
  await tx(async c=>{for(let i=0;i<30;i++)deal=await saveRecord(c,tenants[0],user,'deals',{...deal.data,stage:i%2?'proposal':'qualified'},deal.id,deal.version);});
  const first=(await history()).data;assert.equal(first.items.length,25);assert.ok(first.next_cursor);
  const second=(await call('/records/deals/'+deal.id+'/stage-history?cursor='+first.next_cursor,{cookie})).data;assert.equal(second.items.length,9);assert.equal(second.next_cursor,null);const all=[...first.items,...second.items];assert.equal(new Set(all.map(r=>r.id)).size,34);assert.ok(all.every((v,i)=>i===0||all[i-1].record_version>v.record_version),'Same-transaction timestamps retain exact transition order');
  assert.equal((await call('/records/deals/'+importedDeal.id+'/stage-history?cursor='+first.next_cursor,{cookie})).status,400);
  await tx(c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[user]));assert.equal((await history()).status,200);assert.equal((await call('/records/deals/'+deal.id,{cookie,method:'PUT',body:{version:deal.version,data:{...deal.data,stage:'new'}}})).status,403);
  await tx(c=>c.query("UPDATE memberships SET role='owner' WHERE user_id=$1",[user]));assert.equal((await call('/records/deals/'+importedDeal.id+'?version=1',{cookie,method:'DELETE'})).status,200);assert.equal((await tx(c=>c.query('SELECT * FROM deal_stage_history WHERE deal_id=$1',[importedDeal.id]))).rowCount,0,'Deleting a deal also removes its history');
 } finally {
  await new Promise(r=>setImmediate(r));await admin.query('BEGIN');
  try {for(const tenant of tenants){for(const table of ['api_request_logs','api_mutations','activities','records','record_imports','outbox','audit_events','usage_ledger','api_keys','service_accounts','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=$1',[user]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}
  await redis.del('developer-approval:'+user);for(const id of keys)await redis.del(`developer-api:${tenants[0]}:${id}`);await redis.quit();await admin.end();await pool.end();
 }
});
