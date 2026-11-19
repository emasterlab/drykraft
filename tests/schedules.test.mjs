import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import http from 'node:http';
import {pool,tenantTransaction} from '../server/db.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {nextSchedule,validateGraph,dispatchSchedule} from '../server/automation.mjs';

const schedule=(data)=>({nodes:[{id:'start',type:'workflow',position:{x:0,y:0},data:{kind:'trigger.schedule',label:'Schedule',...data}}],edges:[]});
test('calendar schedules validate five fields, named zones, DST and legacy elapsed intervals',()=>{
 const after=new Date('2026-10-02T00:00:00Z'),cron={mode:'cron',cron:'30 9 * * 1-5',timezone:'Asia/Kolkata'};
 assert.equal(nextSchedule(cron,after).toISOString(),'2026-10-02T04:00:00.000Z');
 assert.equal(nextSchedule(cron,new Date('2026-10-02T04:00:00Z')).toISOString(),'2026-10-05T04:00:00.000Z');
 assert.equal(nextSchedule({intervalMinutes:60},after).toISOString(),'2026-10-02T01:00:00.000Z');
 assert.equal(nextSchedule({mode:'cron',cron:'0 9 * * *',timezone:'America/New_York'},new Date('2026-03-07T14:00:00Z')).toISOString(),'2026-03-08T13:00:00.000Z');
 assert.equal(nextSchedule({mode:'cron',cron:'30 2 * * *',timezone:'America/New_York'},new Date('2026-03-07T08:00:00Z')).toISOString(),'2026-03-08T07:30:00.000Z');
 assert.equal(nextSchedule({mode:'cron',cron:'30 1 * * *',timezone:'America/New_York'},new Date('2026-11-01T05:30:00Z')).toISOString(),'2026-11-02T06:30:00.000Z');
 assert.equal(nextSchedule({mode:'cron',cron:'0 9 29 2 *',timezone:'UTC'},after).toISOString(),'2028-02-29T09:00:00.000Z');
 for(const bad of [{...cron,cron:'* * * * * *'},{...cron,cron:'H * * * *'},{...cron,cron:'90 9 * * *'},{...cron,cron:'0 9 31 2 *'},{...cron,timezone:'Mars/Station'},{...cron,timezone:''},{intervalMinutes:0},{intervalMinutes:1.5},{intervalMinutes:525601},{...cron,mode:'random'}])assert.throws(()=>nextSchedule(bad,after));
 assert.equal(validateGraph(schedule(cron)).nodes[0].data.timezone,'Asia/Kolkata');
 assert.throws(()=>validateGraph(schedule({...cron,cron:'invalid'})));
});

function call(path,cookie,body,method=body?'POST':'GET') {
 return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});
}
test('published schedule, atomic dispatch, pause/resume, billing and preview share one tenant-bound contract',async()=>{
 const tenant=randomUUID(),other=randomUUID(),user=randomUUID(),token=randomBytes(32).toString('hex'),cookie='drykraft_session='+token;
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 const tx=fn=>tenantTransaction(tenant,fn);let lock;
 try {
  await admin.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,'Synthetic schedule owner',user+'@example.test',await hashPassword('SyntheticSchedulePass!2026')]);
  for(const id of [tenant,other])await admin.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[id,'Synthetic schedule QA','schedule-'+id.slice(0,8)]);
  await tx(async c=>{await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenant,user]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[tokenHash(token),user,tenant]);});
  assert.equal((await call('/schedules/preview',null,{intervalMinutes:60})).status,401);
  const data={mode:'cron',cron:'0 9 * * 1-5',timezone:'Asia/Kolkata'},graph=schedule(data);
  const preview=await call('/schedules/preview',cookie,data);assert.equal(preview.status,200);assert.equal(preview.data.next_runs.length,5);assert.equal(preview.data.timezone,data.timezone);
  assert.equal((await call('/schedules/preview',cookie,{...data,timezone:'Invalid/Zone'})).status,400);
  const w=(await call('/workflows',cookie,{name:'Synthetic calendar workflow'})).data;
  assert.equal((await call('/workflows/'+w.id,cookie,{name:w.name,draft:graph},'PUT')).status,200);
  const published=await call('/workflows/'+w.id+'/publish',cookie,{});assert.equal(published.status,200);
  let saved=(await tx(c=>c.query('SELECT * FROM workflows WHERE id=$1',[w.id]))).rows[0];
  assert.equal(new Intl.DateTimeFormat('en',{timeZone:data.timezone,hour:'numeric',hourCycle:'h23'}).format(saved.next_run_at),'09');
  await call('/workflows/'+w.id+'/status',cookie,{status:'paused'});
  const overdue=new Date('2028-03-01T04:00:00Z'),now=new Date('2028-03-03T06:00:00Z');
  await tx(c=>c.query('UPDATE workflows SET next_run_at=$1 WHERE id=$2',[overdue,w.id]));
  assert.equal(await tx(c=>dispatchSchedule(c,tenant,w.id,now)),null,'Paused workflows cannot dispatch after discovery');
  assert.equal((await call('/workflows/'+w.id+'/status',cookie,{status:'active'})).status,200);
  saved=(await tx(c=>c.query('SELECT * FROM workflows WHERE id=$1',[w.id]))).rows[0];assert.ok(saved.next_run_at>new Date());assert.notEqual(saved.next_run_at.toISOString(),overdue.toISOString());
  // A draft edit and later workspace-zone change do not mutate the immutable published calendar.
  await call('/workflows/'+w.id,cookie,{name:w.name,draft:schedule({intervalMinutes:1})},'PUT');
  await tx(async c=>{await c.query("UPDATE workspaces SET settings=jsonb_build_object('timezone','America/New_York') WHERE id=$1",[tenant]);await c.query("UPDATE workflows SET next_run_at=$1 WHERE id=$2",[overdue,w.id]);});
  assert.equal(await tenantTransaction(other,c=>dispatchSchedule(c,other,w.id,now)),null);
  lock=await pool.connect();await lock.query('BEGIN');await lock.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);await lock.query('SELECT id FROM workflows WHERE id=$1 FOR UPDATE',[w.id]);
  assert.equal(await tx(c=>dispatchSchedule(c,tenant,w.id,now)),null,'Competing worker skips the locked schedule');
  const execution=await dispatchSchedule(lock,tenant,w.id,now);await lock.query('COMMIT');lock.release();lock=null;
  assert.equal(execution.version_id,published.data.id);assert.equal(new Date(execution.input.scheduled_at).toISOString(),overdue.toISOString());
  assert.equal(await tx(c=>dispatchSchedule(c,tenant,w.id,now)),null,'The same overdue occurrence is not queued twice');
  saved=(await tx(c=>c.query('SELECT * FROM workflows WHERE id=$1',[w.id]))).rows[0];assert.equal(saved.next_run_at.toISOString(),'2028-03-06T03:30:00.000Z');
  assert.equal((await tx(c=>c.query('SELECT * FROM executions WHERE workflow_id=$1',[w.id]))).rowCount,1);
  await tx(c=>c.query("UPDATE workspace_billing SET trial_ends_at=now()-interval '1 day' WHERE tenant_id=$1",[tenant]));
  await tx(c=>c.query('UPDATE workflows SET next_run_at=$1 WHERE id=$2',[overdue,w.id]));
  assert.equal(await tx(c=>dispatchSchedule(c,tenant,w.id,now)),null);assert.equal((await tx(c=>c.query('SELECT * FROM executions WHERE workflow_id=$1',[w.id]))).rowCount,1);
  assert.equal((await tx(c=>c.query('SELECT next_run_at FROM workflows WHERE id=$1',[w.id]))).rows[0].next_run_at.toISOString(),new Date(now.getTime()+300000).toISOString());
 } finally {
  if(lock){await lock.query('ROLLBACK');lock.release();}
  for(const id of [tenant,other]){for(const table of ['node_executions','executions','workflow_versions','workflows','audit_events','outbox','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[id]);await admin.query('DELETE FROM workspaces WHERE id=$1',[id]);}
  await admin.query('DELETE FROM users WHERE id=$1',[user]);await admin.end();await pool.end();
 }
});
