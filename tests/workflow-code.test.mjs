import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {request} from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {codeSettings,codeJson,runCode} from '../server/workflow-code.mjs';
import {validateGraph,encryptCredential} from '../server/automation.mjs';

const settings={language:'javascript',source:'last',code:'return input;',timeoutSeconds:5,secretBindings:[]};
test('Code publication and JSON boundaries reject invalid paths, source bytes, credentials and non-JSON data',()=>{
 const graph={nodes:[{id:'t',type:'workflow',position:{x:0,y:0},data:{kind:'trigger.manual',label:'Start'}},{id:'code',type:'workflow',position:{x:0,y:1},data:{kind:'code',label:'Code',...settings}}],edges:[{id:'tc',source:'t',target:'code'}]};assert.deepEqual(validateGraph(graph),graph);
 for(const bad of [{source:'last.__proto__'},{source:'{{last}}'},{language:'ruby'},{code:' '},{code:'李'.repeat(22000)},{timeoutSeconds:0},{timeoutSeconds:11},{secretBindings:[{name:'constructor',credentialId:randomUUID()}]},{secretBindings:[{name:'api',credentialId:randomUUID()},{name:'api',credentialId:randomUUID()}]}])assert.throws(()=>codeSettings({...settings,...bad}));
 for(const bad of [undefined,Infinity,NaN,new Date(),{a:undefined},JSON.parse('{"__proto__":{}}'),'x'.repeat(262144)])assert.throws(()=>codeJson(bad));
 let deep=null;for(let i=0;i<42;i++)deep={next:deep};assert.throws(()=>codeJson(deep));const circular={};circular.a=circular;assert.throws(()=>codeJson(circular));assert.equal(codeJson([0,false,null,'李华']),JSON.stringify([0,false,null,'李华']));
});

test('real runsc JavaScript/Python jobs are isolated, bounded, cancelled and tenant-limited', {timeout:90000},async()=>{
 const tenantId=randomUUID(),invoke=(code,language='javascript',input={name:'李华',amount:3},extra={})=>runCode({...settings,language,code,...extra},input,{tenantId});
 assert.deepEqual(await invoke('await new Promise(r=>setTimeout(r,10)); return {name:input.name,total:input.amount*2,zero:0,enabled:false,empty:null};'),{name:'李华',total:6,zero:0,enabled:false,empty:null});
 assert.deepEqual(await invoke('return {"name": input["name"], "total": input["amount"] * 2, "enabled": False}','python'),{name:'李华',total:6,enabled:false});
 assert.deepEqual(await invoke("const fs=require('node:fs');let outside=false;try{fs.readFileSync('/home/ubuntu/cozyHRMS/.env')}catch{outside=true}let write=false;try{fs.writeFileSync('/root-write-test','x')}catch{write=true}let network=false;try{await fetch('http://169.254.169.254',{signal:AbortSignal.timeout(150)})}catch{network=true}fs.writeFileSync('/tmp/ephemeral-check','ok');return {outside,write,network,uid:process.getuid(),privateEnv:process.env.DATABASE_URL!==undefined};"),{outside:true,write:true,network:true,uid:65534,privateEnv:false});
 assert.equal(await invoke("return require('node:fs').existsSync('/tmp/ephemeral-check');"),false);
 assert.deepEqual(await runCode({...settings,code:'return {value:secrets.sample,keys:Object.keys(secrets)};'},{},{tenantId,secrets:{sample:'fictional-only-secret'}}),{value:'fictional-only-secret',keys:['sample']});
 for(const code of ['return NaN;','return undefined;','console.log("noise"); return 1;','return "x".repeat(300000);','throw Error("private details must be discarded");'])await assert.rejects(invoke(code),e=>e.status===400&&!e.message.includes('private details'));
 await assert.rejects(invoke('while True:\n pass','python',{}, {timeoutSeconds:1}),/time limit/);
 await assert.rejects(invoke('while(true){}','javascript',{}, {timeoutSeconds:1}),/time limit/);
 const controller=new AbortController(),running=runCode({...settings,code:'await new Promise(r=>setTimeout(r,3000));return 1;',timeoutSeconds:5},{},{tenantId,signal:controller.signal});running.catch(()=>{});await delay(300);
 await assert.rejects(invoke('return 2;'),e=>e.status===429);controller.abort();await assert.rejects(running,e=>e.status===409);
 let recovered=false;for(let i=0;i<20;i++){try{assert.equal(await invoke('return 2;'),2);recovered=true;break;}catch(e){if(e.status!==429)throw e;await delay(100);}}assert.ok(recovered,'Cancellation must remove the container and free this tenant slot.');
 const other=new AbortController(),first=new AbortController(),jobs=[runCode({...settings,code:'await new Promise(r=>setTimeout(r,3000));return 1;',timeoutSeconds:5},{},{tenantId:randomUUID(),signal:other.signal}),runCode({...settings,code:'await new Promise(r=>setTimeout(r,3000));return 1;',timeoutSeconds:5},{},{tenantId:randomUUID(),signal:first.signal})];for(const j of jobs)j.catch(()=>{});await delay(300);await assert.rejects(invoke('return 3;'),e=>e.status===429);other.abort();first.abort();await Promise.all(jobs.map(j=>assert.rejects(j,e=>e.status===409)));
 await assert.rejects(runCode(settings,{},{tenantId,socketPath:'/nonexistent-drykraft-code.sock'}),e=>e.status===503);
});

test('Code publication pins settings and requires current-workspace credentials and administrator permission',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=tenants.map(()=>randomUUID()),tokens=users.map(()=>randomBytes(32).toString('hex')),credentials=tenants.map(()=>randomUUID()),admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 const call=(path,body,method=body?'POST':'GET',index=0)=>new Promise((resolve,reject)=>{const req=request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie:'drykraft_session='+tokens[index],...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(s)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 try{
  for(let i=0;i<2;i++)await tenantTransaction(tenants[i],async c=>{await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic Code reviewer',users[i]+'@example.test','unused']);await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenants[i],'Synthetic Code QA','code-'+tenants[i].slice(0,8)]);await initializeWorkspace(c,tenants[i]);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenants[i],users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenants[i]]);await c.query('INSERT INTO credentials(tenant_id,id,name,provider,ciphertext) VALUES($1,$2,$3,$4,$5)',[tenants[i],credentials[i],'Synthetic Code reference','bearer',encryptCredential(tenants[i],{value:'synthetic-never-dispatched'})]);});
  const w=(await call('/workflows',{name:'Synthetic Code publication'})).data;
  const save=data=>call('/workflows/'+w.id,{name:w.name,draft:{nodes:[{id:'t',type:'workflow',position:{x:0,y:0},data:{kind:'trigger.manual',label:'Start'}},{id:'code',type:'workflow',position:{x:1,y:0},data:{kind:'code',label:'Code',...settings,...data}}],edges:[{id:'tc',source:'t',target:'code'}]}},'PUT');
  await save({secretBindings:[{name:'sample',credentialId:credentials[0]}]});const published=await call('/workflows/'+w.id+'/publish',{});assert.equal(published.status,200);assert.equal(published.data.graph.nodes[1].data.code,settings.code);
  for(const id of [credentials[1],randomUUID()]){await save({secretBindings:[{name:'sample',credentialId:id}]});assert.equal((await call('/workflows/'+w.id+'/publish',{})).status,400);}
  await save({timeoutSeconds:11});assert.equal((await call('/workflows/'+w.id+'/publish',{})).status,400);assert.equal((await call('/workflows/'+w.id+'/versions')).data.length,1);
  await tenantTransaction(tenants[0],c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await save(settings)).status,403);assert.equal((await call('/workflows/'+w.id+'/publish',{})).status,403);assert.equal((await call('/workflows/'+w.id+'/publish',{},'POST',1)).status,404);
 }finally{for(const tenant of tenants){for(const table of ['executions','workflows','credentials','outbox','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();}
});
test.after(()=>pool.end());
