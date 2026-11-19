import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer,connect } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

async function availablePort(){
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test('API drains an in-flight request once when SIGINT and SIGTERM overlap', {timeout:15000}, async t=>{
  const port=await availablePort();
  const child=spawn(process.execPath,['--env-file=.env','server/index.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
  const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
  for(let i=0;i<200 && !output.includes('API ready');i++){assert.equal(child.exitCode,null,errors);await delay(20);}
  assert.match(output,/API ready/);
  const socket=connect(port,'127.0.0.1');t.after(()=>socket.destroy());await once(socket,'connect');
  let response='';socket.on('data',chunk=>{response+=chunk;});
  // The incomplete JSON body holds a real API request open while both signals arrive.
  socket.write('POST /api/auth/signup HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{');
  await delay(50);child.kill('SIGINT');await delay(50);child.kill('SIGTERM');await delay(50);
  assert.equal(child.exitCode,null,'Shutdown must wait for the active request');
  // Keep the client waiting for its reply; a TCP half-close aborts an async HTTP response.
  const responseEnded=once(socket,'end');socket.write('}');await responseEnded;
  const [code,signal]=await exited;
  assert.match(response,/HTTP\/1\.1 400/,'The held request must finish before the API exits');
  assert.equal(signal,null);assert.equal(code,0,errors);assert.equal(errors,'');
});

test('worker drains blocked scheduler and customer webhook polls before closing its pools on repeated signals', {timeout:15000}, async t=>{
  const name='drykraft_shutdown_'+randomUUID().replaceAll('-','');
  const adminUrl=process.env.LOCAL_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/drykraft';
  const isolatedUrl=new URL(adminUrl);isolatedUrl.pathname='/'+name;
  const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
  let worker,redis,lock,created=false;
  t.after(async()=>{
    for(const child of [worker,redis])if(child && child.exitCode===null && child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}
    if(lock)await lock.end();if(created)await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();
  });
  await admin.query(`CREATE DATABASE ${name}`);created=true;
  lock=new pg.Client({connectionString:isolatedUrl.toString()});await lock.connect();
  await lock.query(`CREATE TABLE outbox(tenant_id uuid,id uuid,published_at timestamptz,occurred_at timestamptz);
    CREATE TABLE workflows(tenant_id uuid,id uuid,status text,next_run_at timestamptz);
    CREATE TABLE executions(tenant_id uuid,id uuid,dispatch_id uuid,state text,resume_at timestamptz,created_at timestamptz);
    CREATE TABLE customer_webhook_deliveries(tenant_id uuid,id uuid,state text,next_attempt_at timestamptz);`);
  await lock.query('BEGIN');await lock.query('LOCK TABLE outbox,customer_webhook_deliveries IN ACCESS EXCLUSIVE MODE');
  const port=await availablePort();
  redis=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});
  let redisOutput='';redis.stdout.on('data',chunk=>{redisOutput+=chunk;});
  for(let i=0;i<200 && !redisOutput.includes('Ready to accept connections');i++){assert.equal(redis.exitCode,null);await delay(20);}
  assert.match(redisOutput,/Ready to accept connections/);
  worker=spawn(process.execPath,['--env-file=.env','server/worker.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,DATABASE_URL:isolatedUrl.toString(),WORKER_DATABASE_URL:isolatedUrl.toString(),REDIS_URL:`redis://127.0.0.1:${port}`},stdio:['ignore','pipe','pipe']});
  let errors='';worker.stdout.resume();worker.stderr.on('data',chunk=>{errors+=chunk;});const exited=once(worker,'exit');
  let blocked=false,webhookBlocked=false;
  for(let i=0;i<200 && (!blocked||!webhookBlocked);i++){
    assert.equal(worker.exitCode,null,errors);
    blocked=(await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT tenant_id,id FROM outbox%'",[name])).rowCount>0;
    webhookBlocked=(await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT tenant_id,id FROM customer_webhook_deliveries%'",[name])).rowCount>0;
    if(!blocked||!webhookBlocked)await delay(20);
  }
  assert(blocked,'The real scheduler query must be active before shutdown');
  assert(webhookBlocked,'The real customer webhook query must be active before shutdown');
  worker.kill('SIGINT');await delay(50);worker.kill('SIGTERM');await delay(50);
  assert.equal(worker.exitCode,null,'The worker must wait for its in-flight scheduler transaction');
  await lock.query('COMMIT');
  const [code,signal]=await exited;assert.equal(signal,null);assert.equal(code,0,errors);assert.equal(errors,'');
});
