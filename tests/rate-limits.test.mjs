import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createClient} from 'redis';
import {RedisRateStore,consumeRateLimit} from '../server/rate-limits.mjs';

async function port(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(child){if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}}
function request(port,path,ip,method='GET',body=null){return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{host:'localhost','x-forwarded-for':ip,...(body?{'content-type':'application/json'}:{})}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(raw)}));});
  req.setTimeout(6000,()=>req.destroy(new Error('Synthetic limiter request timed out.')));req.on('error',reject);req.end(body);
});}
test('atomic Redis limits survive replica concurrency and API restart, expire correctly, and fail closed on outage',{timeout:45000},async t=>{
  // Private Redis only: never pause, scan, flush or seed the user's Redis service.
  const redisPort=await port(),children=[];
  const daemon=spawn('redis-server',['--bind','127.0.0.1','--port',String(redisPort),'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});
  let redisOutput='';daemon.stdout.on('data',b=>redisOutput+=b);daemon.stderr.resume();
  const clients=[];t.after(async()=>{for(const child of children)await stop(child);for(const client of clients)if(client.isOpen)client.destroy();await stop(daemon);});
  for(let i=0;i<200&&!redisOutput.includes('Ready to accept connections');i++){assert.equal(daemon.exitCode,null);await delay(20);}assert.match(redisOutput,/Ready to accept connections/);
  const url=`redis://127.0.0.1:${redisPort}`,client=createClient({url}),second=createClient({url});clients.push(client,second);client.on('error',()=>{});second.on('error',()=>{});await Promise.all([client.connect(),second.connect()]);
  const a=new RedisRateStore('atomic-test',client),b=new RedisRateStore('atomic-test',second);a.init({windowMs:3000});b.init({windowMs:3000});
  const counts=await Promise.all(Array.from({length:500},(_,i)=>(i%2?a:b).increment('same-client')));
  assert.deepEqual(counts.map(r=>r.totalHits).sort((a,b)=>a-b),Array.from({length:500},(_,i)=>i+1));
  assert.ok(Math.max(...counts.map(r=>+r.resetTime))-Math.min(...counts.map(r=>+r.resetTime))<100,'Concurrent requests keep the original window instead of extending it');
  assert.equal(await client.get(a.key('same-client')),'500');assert.ok(await client.pTTL(a.key('same-client'))>0);
  await a.decrement('absent');assert.equal(await client.exists(a.key('absent')),0,'Decrement cannot create immortal negative counters');
  await a.decrement('same-client');assert.equal(await client.get(a.key('same-client')),'499');await a.resetKey('same-client');assert.equal(await client.exists(a.key('same-client')),0);
  const short=new RedisRateStore('expiry-test',client);short.init({windowMs:80});assert.equal((await short.increment('client')).totalHits,1);await delay(100);assert.equal((await short.increment('client')).totalHits,1);
  await client.set(short.key('broken-ttl'),'12');assert.equal((await short.increment('broken-ttl')).totalHits,13);assert.ok(await client.pTTL(short.key('broken-ttl'))>0,'Missing TTL repairs expiry without erasing recorded attempts');
  await assert.rejects(consumeRateLimit({isReady:false},'not-ready',60000),e=>e.status===503&&e.code==='RATE_LIMIT_UNAVAILABLE');
  await assert.rejects(consumeRateLimit(client,'bad-window',0),/Invalid rate limit window/);
  assert.throws(()=>new RedisRateStore('../escape',client),/Invalid rate limit scope/);

  const namespace=randomUUID(),env={...process.env,NODE_ENV:'test',TEST_RATE_LIMIT_NAMESPACE:namespace,REDIS_URL:url,DODO_WEBHOOK_KEY:'whsec_'+Buffer.from('synthetic-private-limit-test').toString('base64')};
  async function api(){const p=await port(),child=spawn(process.execPath,['--env-file=.env','server/index.mjs'],{cwd:new URL('../',import.meta.url),env:{...env,PORT:String(p)},stdio:['ignore','pipe','pipe']});children.push(child);let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);for(let i=0;i<250&&!output.includes('API ready');i++){assert.equal(child.exitCode,null,errors);await delay(20);}assert.match(output,/API ready/);return {port:p,child,errors:()=>errors};}
  const one=await api(),two=await api(),replicas=[one,two];
  // More requests than the allowance arrive concurrently across two real API processes.
  const burst=await Promise.all(Array.from({length:360},(_,i)=>request(replicas[i%2].port,'/api/meta','198.51.100.20')));
  assert.equal(burst.filter(r=>r.status===200).length,300);assert.equal(burst.filter(r=>r.status===429).length,60);
  for(const blocked of burst.filter(r=>r.status===429)){assert.ok(Number(blocked.headers['retry-after'])>=1);assert.ok(blocked.headers.ratelimit);assert.equal(blocked.body.error.request_id,blocked.headers['x-request-id']);}
  assert.equal((await request(two.port,'/api/meta','198.51.100.21')).status,200,'Another client retains a separate allowance');
  const malformed=await Promise.all(Array.from({length:302},(_,i)=>request(replicas[i%2].port,'/api/auth/login','198.51.100.29','POST','{')));
  assert.equal(malformed.filter(r=>r.status===400).length,300);assert.equal(malformed.filter(r=>r.status===429).length,2,'Malformed JSON is limited before parsing and cannot evade the IP allowance');
  await stop(one.child);const replacement=await api();replicas[0]=replacement;
  assert.equal((await request(replacement.port,'/api/meta','198.51.100.20')).status,429,'API restart cannot reset the shared allowance');
  const auth=await Promise.all(Array.from({length:32},(_,i)=>request(replicas[i%2].port,'/api/auth/subdomain?slug=!','198.51.100.22')));
  assert.equal(auth.filter(r=>r.status===400).length,30);assert.equal(auth.filter(r=>r.status===429).length,2);
  assert.equal((await request(two.port,'/api/hooks/'+'0'.repeat(64),'198.51.100.22','POST','{}')).status,429,'Auth and generic hooks retain their shared budget');
  const booking=await Promise.all(Array.from({length:17},(_,i)=>request(replicas[i%2].port,i%2?'/api/calendar/manage/not-a-uuid':'/api/calendar/book/not-a-uuid','198.51.100.23',i%2?'PUT':'POST','{}')));
  assert.equal(booking.filter(r=>r.status===400).length,15);assert.equal(booking.filter(r=>r.status===429).length,2,'Booking and guest rescheduling share their 15-attempt budget');
  const publicReads=await Promise.all(Array.from({length:122},(_,i)=>request(replicas[i%2].port,'/api/calendar/book/not-a-uuid','198.51.100.24')));
  assert.equal(publicReads.filter(r=>r.status===400).length,120);assert.equal(publicReads.filter(r=>r.status===429).length,2);
  for(const [path,ip]of [['/api/billing/dodo/webhook','198.51.100.25'],['/api/outreach/whatsapp/not-a-uuid','198.51.100.26']]){
    const ingress=await Promise.all(Array.from({length:122},(_,i)=>request(replicas[i%2].port,path,ip,'POST','{}')));
    assert.equal(ingress.filter(r=>r.status===429).length,2);assert.ok(ingress.every(r=>[400,401,429].includes(r.status)),'Unsigned synthetic payloads cannot reach provider operations');
    assert.equal((await request(two.port,'/api/meta',ip)).status,200,'Raw provider ingress remains independent of the general API budget');
  }
  const ipv6=await Promise.all(Array.from({length:302},(_,i)=>request(replicas[i%2].port,'/api/meta',i%2?'2001:db8:aa00:1::1':'2001:db8:aa00:2::2')));
  assert.equal(ipv6.filter(r=>r.status===200).length,300);assert.equal(ipv6.filter(r=>r.status===429).length,2,'Addresses inside the same IPv6 /56 cannot evade the shared allowance');
  // A real stalled Redis command must return promptly without invoking the auth handler.
  await client.clientPause(2400,'ALL');const started=performance.now();
  const unavailable=await request(two.port,'/api/auth/signup','198.51.100.27','POST','{}');
  assert.equal(unavailable.status,503);assert.ok(performance.now()-started<2200);assert.equal(unavailable.headers['retry-after'],'5');assert.equal(unavailable.body.error.request_id,unavailable.headers['x-request-id']);assert.match(unavailable.body.error.message,/protection.*unavailable/);
  await delay(1100);assert.equal((await request(two.port,'/api/meta','198.51.100.27')).status,200,'Normal protection resumes after Redis responds');
  await client.clientPause(2400,'ALL');const cappedStart=performance.now();
  const capped=await Promise.all(Array.from({length:600},(_,i)=>consumeRateLimit(client,'synthetic-cap:'+i,60000).then(()=>({allowed:true}),error=>({status:error.status,elapsed:performance.now()-cappedStart}))));
  assert.ok(capped.every(r=>r.status===503));assert.ok(capped.filter(r=>r.elapsed<300).length>=88,'An unresolved command cap rejects excess work immediately during an outage');
  await delay(1100);assert.equal((await consumeRateLimit(client,'synthetic-recovered',60000)).totalHits,1);
  await client.clientPause(350,'ALL');let replied=false;
  const inFlight=request(two.port,'/api/meta','198.51.100.28').then(result=>{replied=true;return result;});
  await delay(50);assert.equal(replied,false,'A real Redis operation must still be in flight');const drained=once(two.child,'exit');
  two.child.kill('SIGINT');await delay(50);two.child.kill('SIGTERM');
  assert.equal((await inFlight).status,200,'Shutdown waits for Redis protection and the complete HTTP reply');assert.equal((await drained)[0],0);
  for(const replica of replicas)assert.ok(!/ERR_ERL_|ValidationError|secret|synthetic-private-limit-test/.test(replica.errors()),'No limiter configuration errors or secret diagnostics');
});
