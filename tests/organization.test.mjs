import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';

const origin=process.env.TEST_API_ORIGIN||'http://localhost:4000',base='/settings/organization';
function call(path,method='GET',body,cookie=''){return new Promise((resolve,reject)=>{const req=http.request(origin+'/api'+path,{method,headers:{'content-type':'application/json',...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{}),cookie}},res=>{const bytes=[];res.on('data',b=>bytes.push(b));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(bytes)),cache:res.headers['cache-control']}));});req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('Organization request timed out')));if(body)req.write(JSON.stringify(body));req.end();});}
async function fixture(fn){
 const tenants=[randomUUID(),randomUUID()],users=Array.from({length:33},()=>randomUUID()),cookies=[],admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(const [i,t]of tenants.entries())await tenantTransaction(t,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[t,'Synthetic organization checks','organization-'+t.slice(0,8)]);await initializeWorkspace(c,t);for(const j of i===0?Array.from({length:32},(_,j)=>j):[32]){await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[j],j===32?'Private outside teammate':`Sample organization member ${j}`,users[j]+'@example.test','unused']);await c.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[t,users[j],j===0||j===32?'owner':j===1?'admin':j===2?'viewer':'member']);if(j<4||j===32){const raw=randomBytes(32).toString('hex');cookies[j]='drykraft_session='+raw;await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(raw),users[j],t]);}}});
  await fn({tenants,users,cookies,admin});
 }finally{
  try{await admin.query('BEGIN');for(const t of tenants){await admin.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[t]);for(const table of ['workspace_team_members','workspace_location_members','workspace_teams','workspace_locations','records','object_definitions','pipelines','dashboards','outbox','audit_events','usage_ledger','workspace_billing','sessions','invitations','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[t]);await admin.query('DELETE FROM workspaces WHERE id=$1',[t]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}finally{await admin.end();}
 }
}
test('Organization isolates tenants, validates leadership, preserves archives and cleans up departing assignments',async()=>fixture(async({tenants,users,cookies,admin})=>{
 const request=(p,m,b,who=0)=>call(base+p,m,b,cookies[who]);
 assert.equal((await call(base+'/teams')).status,401);
 for(const who of [2,3])assert.equal((await request('/teams','POST',{name:'Forbidden'},who)).status,403);
 for(const b of [{name:'Bad',timezone:'not/a-zone'},{name:'Bad',timezone:'UTC',unknown:true},{name:'x',timezone:'UTC'}])assert.equal((await request('/locations','POST',b)).status,400);
 const made=await request('/locations','POST',{name:'Sample Mumbai office',timezone:'Asia/Kolkata',city:'Mumbai'});assert.equal(made.status,201);let office=made.data;assert.equal(made.cache,'no-store');
 const outside=(await request('/locations','POST',{name:'Private outside office',timezone:'UTC'},32)).data;
 for(const b of [{name:'Bad',location_id:outside.id},{name:'Bad',lead_id:users[32]}])assert.equal((await request('/teams','POST',b)).status,400);
 assert.equal((await request('/locations','POST',{name:'sample mumbai office',timezone:'UTC'})).status,409);
 assert.equal((await request('/teams','POST',{name:'Bad',lead_id:'invalid'})).status,400);
 let team=(await request('/teams','POST',{name:'Sample support team',location_id:office.id,lead_id:users[3]},1)).data;assert.ok(team.id);assert.equal(team.member_count,1);assert.equal(team.lead.id,users[3]);assert.equal(team.location.id,office.id);
 assert.equal((await request('/teams/'+team.id,'GET',null,32)).status,404);
 assert.equal((await request('/teams/'+team.id+'/members','GET',null,32)).status,404);
 assert.equal((await request('/teams/'+team.id,'PUT',{name:'Attack',version:team.version},32)).status,404);
 const foreignOptions=await request('/locations/options?selected='+outside.id,'GET',null,2);assert.equal(foreignOptions.data.selected,null);assert.ok(!JSON.stringify(foreignOptions.data).includes('Private outside'));
 assert.equal((await request('/teams/'+team.id+'/members/'+users[3]+'?version='+team.version,'DELETE')).status,409);
 assert.equal((await request('/teams/'+team.id+'/members','POST',{user_id:users[32],version:team.version})).status,400);
 const oldVersion=team.version;team=(await request('/teams/'+team.id+'/members','POST',{user_id:users[4],version:team.version})).data;assert.equal(team.member_count,2);assert.equal(team.version,oldVersion+1);
 assert.equal((await request('/teams/'+team.id+'/members','POST',{user_id:users[4],version:team.version})).data.version,team.version);
 assert.equal((await request('/teams/'+team.id,'PUT',{name:'Stale overwrite',version:oldVersion})).status,409);
 team=(await request('/teams/'+team.id,'PUT',{name:team.name,location_id:office.id,lead_id:users[5],version:team.version})).data;assert.equal(team.member_count,3);
 const people=(await request('/teams/'+team.id+'/members','GET',null,2)).data;assert.equal(people.total,3);assert.ok(people.items.some(p=>p.id===users[3]));
 office=(await request('/locations/'+office.id+'/members','POST',{user_id:users[5],version:office.version})).data;assert.equal(office.member_count,1);assert.equal(office.team_count,1);
 assert.equal((await request('/locations/'+office.id+'/state','POST',{version:office.version,archived:true})).status,409);
 team=(await request('/teams/'+team.id+'/state','POST',{version:team.version,archived:true})).data;assert.ok(team.archived_at);
 assert.equal((await request('/teams/'+team.id+'/members','POST',{user_id:users[6],version:team.version})).status,409);
 assert.equal((await request('/teams/'+team.id,'PUT',{name:'Archived overwrite',version:team.version})).status,409);
 assert.equal((await request('/teams?status=archived','GET',null,2)).data.total,1);assert.equal((await request('/teams?status=active')).data.total,0);
 office=(await request('/locations/'+office.id+'/state','POST',{version:office.version,archived:true})).data;
 assert.equal((await request('/teams/'+team.id+'/state','POST',{version:team.version,archived:false})).status,400);
 assert.equal((await request('/locations/options?selected='+office.id)).data.items.length,0);assert.ok((await request('/locations/options?selected='+office.id)).data.selected.archived_at);
 office=(await request('/locations/'+office.id+'/state','POST',{version:office.version,archived:false})).data;team=(await request('/teams/'+team.id+'/state','POST',{version:team.version,archived:false})).data;assert.equal(team.member_count,3);
 const beforeTeam=team.version,beforeOffice=office.version;assert.equal((await call('/settings/members/'+users[5]+'?version=1','DELETE',null,cookies[0])).status,200);
 team=(await request('/teams/'+team.id)).data;office=(await request('/locations/'+office.id)).data;assert.equal(team.lead_id,null);assert.equal(team.member_count,2);assert.equal(team.version,beforeTeam+1);assert.equal(office.member_count,0);assert.equal(office.version,beforeOffice+1);
 assert.equal((await request('/teams/'+team.id+'/members','POST',{user_id:users[5],version:team.version})).status,400);
 const events=(await admin.query("SELECT type FROM outbox WHERE tenant_id=$1 AND type LIKE 'workspace.%'",[tenants[0]])).rows.map(r=>r.type);for(const expected of ['workspace.team.created','workspace.team.updated','workspace.team.archived','workspace.team.restored','workspace.team.member_added','workspace.location.created','workspace.location.member_added','workspace.member.removed'])assert.ok(events.includes(expected),expected);
 await tenantTransaction(tenants[0],async c=>{assert.equal((await c.query('SELECT * FROM workspace_locations WHERE id=$1',[outside.id])).rowCount,0);await assert.rejects(c.query('UPDATE workspace_locations SET tenant_id=$1 WHERE id=$2',[tenants[1],office.id]),e=>e.code==='42501');});
 for(const table of ['workspace_teams','workspace_locations','workspace_team_members','workspace_location_members']){const p=(await admin.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('drykraft_worker',$1,'SELECT') AS worker FROM pg_class WHERE oid=$1::regclass",[table])).rows[0];assert.ok(p.relrowsecurity&&p.relforcerowsecurity);assert.equal(p.worker,false);}for(const table of ['workspace_teams','workspace_locations'])assert.equal((await admin.query("SELECT has_table_privilege('drykraft_app',$1,'DELETE') AS granted",[table])).rows[0].granted,false);
}));
test('Organization pagination, capacity and current-version mutations survive concurrent access changes',async()=>fixture(async({tenants,users,cookies,admin})=>{
 const request=(p,m,b,who=0)=>call(base+p,m,b,cookies[who]);
 await tenantTransaction(tenants[0],async c=>{for(let i=0;i<27;i++)await c.query("INSERT INTO workspace_locations(tenant_id,id,name,timezone,created_at) VALUES($1,$2,$3,'UTC','2026-10-03 07:00:00.123456+00'::timestamptz)",[tenants[0],randomUUID(),`Sample page office ${i}`]);});
 const first=(await request('/locations')).data,second=(await request('/locations?cursor='+first.next_cursor)).data;assert.equal(first.items.length,25);assert.equal(second.items.length,2);assert.equal(second.next_cursor,null);assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,27);
 const options=(await request('/locations/options')).data,options2=(await request('/locations/options?cursor='+options.next_cursor)).data;assert.equal(new Set([...options.items,...options2.items].map(i=>i.id)).size,27);
 assert.equal((await request('/locations?search=%25')).data.total,0);assert.equal((await request('/locations?cursor='+randomUUID())).status,400);assert.equal((await request('/locations?unknown=1')).status,400);assert.equal((await request('/bad-kind')).status,400);
 let team=(await request('/teams','POST',{name:'Sample concurrent team'})).data;
 await tenantTransaction(tenants[0],async c=>{for(const u of users.slice(1,32))await c.query('INSERT INTO workspace_team_members(tenant_id,team_id,user_id) VALUES($1,$2,$3)',[tenants[0],team.id,u]);});
 const members=(await request('/teams/'+team.id+'/members')).data,members2=(await request('/teams/'+team.id+'/members?cursor='+members.next_cursor)).data;assert.equal(members.items.length,25);assert.equal(members2.items.length,6);assert.equal(new Set([...members.items,...members2.items].map(u=>u.id)).size,31);
 const concurrent=await Promise.all([request('/teams/'+team.id+'/members','POST',{user_id:users[0],version:team.version}),request('/teams/'+team.id+'/members/'+users[4]+'?version='+team.version,'DELETE')]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);team=(await request('/teams/'+team.id)).data;assert.equal(team.version,2);
 // Hold the same workspace lock used by access changes. The request authenticates first, then must recheck the committed role.
 let lock=await pool.connect(),pending;
 try{
  await lock.query('BEGIN');await lock.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[tenants[0]]);
  pending=request('/teams','POST',{name:'Must not survive role downgrade'},1);
  let waiting=false;for(let i=0;i<100;i++){if((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM workspaces WHERE id=$1 FOR UPDATE' LIMIT 1")).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true,'Actual in-flight organization request must wait on access lock');
  await lock.query("UPDATE memberships SET role='viewer',version=version+1 WHERE tenant_id=$1 AND user_id=$2",[tenants[0],users[1]]);await lock.query('COMMIT');lock.release();lock=null;assert.equal((await pending).status,403);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM workspace_teams WHERE tenant_id=$1 AND name='Must not survive role downgrade'",[tenants[0]])).rows[0].n,0);
 }finally{if(lock){await lock.query('ROLLBACK');lock.release();}if(pending)await pending;}
 lock=await pool.connect();pending=null;
 try{
  await lock.query('BEGIN');await lock.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[tenants[0]]);
  pending=request('/teams/'+team.id+'/members','POST',{user_id:users[6],version:team.version});
  let waiting=false;for(let i=0;i<100;i++){if((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM workspaces WHERE id=$1 FOR UPDATE' LIMIT 1")).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);
  await lock.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',[tenants[0],users[6]]);await lock.query('COMMIT');lock.release();lock=null;assert.equal((await pending).status,400);
 }finally{if(lock){await lock.query('ROLLBACK');lock.release();}if(pending)await pending;}
 await admin.query("INSERT INTO workspace_locations(tenant_id,id,name,timezone) SELECT $1,gen_random_uuid(),'Sample capacity office '||n,'UTC' FROM generate_series(1,473) n",[tenants[0]]);
 assert.equal((await request('/locations','POST',{name:'Beyond capacity',timezone:'UTC'})).status,400);
 assert.equal((await request('/locations')).data.total,500);
}));
test.after(()=>pool.end());
