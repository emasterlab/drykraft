// This supervisor never evaluates customer code. Only the fixed interpreter inside runsc does.
// Install a root-owned copy: normal API/workers must not have access to Docker's socket.
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,chmodSync,existsSync,unlinkSync} from 'node:fs';
import {once} from 'node:events';

const socket=process.env.CODE_SANDBOX_SOCKET||'/run/drykraft-code/runner.sock';
const images=JSON.parse(readFileSync(process.env.CODE_SANDBOX_IMAGES||'/opt/drykraft-sandbox/images.json','utf8'));
for(const [language,repo]of [['javascript','node'],['python','python']])if(!new RegExp('^'+repo+'@sha256:[a-f0-9]{64}$').test(images[language]))throw Error('Use fixed official interpreter image digests.');
const docker='/usr/bin/docker',label='com.drykraft.code-sandbox',instance=createHash('sha256').update(socket).digest('hex').slice(0,16),active=new Map(),tenants=new Set();let closing=false,stopping=false;
const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8'};
const command=(args)=>{const r=spawnSync(docker,args,{env,encoding:'utf8',timeout:10000,maxBuffer:65536});if(r.status!==0)throw Error('Sandbox platform unavailable');return r.stdout;};
const info=JSON.parse(command(['info','--format','{{json .}}']));if(!info.Runtimes?.runsc||info.CgroupVersion!=='2')throw Error('runsc and cgroup v2 are required; there is no host execution fallback.');
// Delete only this service's orphaned sandboxes, never another application's containers.
for(const id of command(['ps','-aq','--filter','label='+label+'='+instance]).trim().split('\n').filter(Boolean))command(['rm','-f',id]);
if(existsSync(socket))throw Error('Socket already exists; refuse to replace another runner.');
const js=String.raw`const fs=require('node:fs');(async()=>{try{const j=JSON.parse(fs.readFileSync(0,'utf8'));const output=await(new(Object.getPrototypeOf(async function(){}).constructor)('input','secrets',j.code))(j.input,j.secrets);const check=(v,n=0)=>{if(n>40)throw Error();if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;if(Array.isArray(v)){for(const a of v)check(a,n+1);return;}if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype){for(const a of Object.values(v))check(a,n+1);return;}throw Error();};check(output);const text=JSON.stringify({ok:true,output});process.stdout.write(text,()=>process.exit(0));}catch{process.stdout.write(JSON.stringify({ok:false,error:'Code failed. Check its syntax and return a JSON value.'}),()=>process.exit(1));}})();`;
const python=String.raw`import json,sys
try:
 j=json.load(sys.stdin)
 scope={}
 exec(compile("def main(input,secrets):\n"+"\n".join("    "+line for line in j['code'].splitlines()),"<workflow>","exec"),scope)
 output=scope['main'](j['input'],j['secrets'])
 sys.stdout.write(json.dumps({'ok':True,'output':output},allow_nan=False,separators=(',',':')))
except BaseException:
 sys.stdout.write(json.dumps({'ok':False,'error':'Code failed. Check its syntax and return a JSON value.'}))
 sys.exit(1)
`;
function validate(j){
 if(!j||typeof j!=='object'||Array.isArray(j)||Object.keys(j).sort().join(',')!=='code,input,language,secrets,tenantId,timeoutSeconds'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(j.tenantId)||!['javascript','python'].includes(j.language)||typeof j.code!=='string'||!j.code.trim()||Buffer.byteLength(j.code)>65536||!Number.isInteger(j.timeoutSeconds)||j.timeoutSeconds<1||j.timeoutSeconds>10)throw Error('Invalid code job.');
 jsonValue(j.input);
 if(!j.secrets||Array.isArray(j.secrets)||typeof j.secrets!=='object'||Object.keys(j.secrets).length>8||Buffer.byteLength(JSON.stringify(j.secrets))>65536||Object.entries(j.secrets).some(([k,v])=>!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)||['constructor','prototype','__proto__'].includes(k)||typeof v!=='string'||v.length>8192))throw Error('Invalid code input or secrets.');
}
function jsonValue(value){
 const walk=(v,depth=0)=>{if(depth>40)throw Error('Code JSON exceeds 40 levels.');if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;if(Array.isArray(v)){for(const a of v)walk(a,depth+1);return;}if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype){for(const [k,a]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))throw Error('Code JSON contains a reserved key.');walk(a,depth+1);}return;}throw Error('Code must return JSON with finite numbers.');};
 walk(value);if(Buffer.byteLength(JSON.stringify(value))>262144)throw Error('Code JSON exceeds 256 KiB.');
}
function control(args){return new Promise((resolve,reject)=>{const p=spawn(docker,args,{env,stdio:['ignore','pipe','ignore']});let text='';p.stdout.on('data',b=>{text+=b;if(text.length>65536)p.kill('SIGKILL');});const timer=setTimeout(()=>p.kill('SIGKILL'),10000);p.once('error',()=>{clearTimeout(timer);reject(Error('Sandbox platform unavailable.'));});p.once('close',code=>{clearTimeout(timer);resolve({code,text});});});}
async function execute(job,signal){
 const name='drykraft-code-'+randomUUID();let child,reason='',chunks=[],bytes=0;
 const remove=async()=>{await control(['rm','-f',name]);const r=await control(['ps','-aq','--filter','name=^/'+name+'$']);if(r.code!==0||r.text.trim()){closing=true;for(const c of active.keys())c.abort();throw Error('Sandbox cleanup failed. The runner is disabled until repaired.');}};
 const kill=why=>{if(reason)return;reason=why;child?.kill('SIGKILL');};
 const aborted=()=>kill('Code execution cancelled.');signal.addEventListener('abort',aborted,{once:true});
 try{
  const args=['create','--rm','--pull=never','--name',name,'--label',label+'='+instance,'--runtime=runsc','--network=none','--read-only','--user=65534:65534','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=32','--memory=256m','--memory-swap=256m','--cpus=0.5','--ulimit=nofile=64:64','--ulimit=core=0:0','--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777','--shm-size=1m','--log-driver=none','--workdir=/tmp','-i',images[job.language],...(job.language==='javascript'?['node','--max-old-space-size=64','-e',js]:['python','-I','-B','-c',python])];
  if(signal.aborted)throw Error('Code execution cancelled.');
  const started=Date.now(),created=await control(args);
  if(created.code!==0)throw Error('Sandbox platform unavailable.');
  if(signal.aborted)throw Error('Code execution cancelled.');
  const remaining=job.timeoutSeconds*1000-(Date.now()-started);if(remaining<=0)throw Error('Code exceeded its time limit.');
  // Create first: every cancellation has a known container to remove before releasing its slot.
  child=spawn(docker,['start','--attach','--interactive',name],{env,stdio:['pipe','pipe','pipe']});const ended=once(child,'close');
  child.stdin.on('error',()=>{});child.stdout.on('data',b=>{bytes+=b.length;if(bytes>266240)kill('Code output exceeds 256 KiB.');else chunks.push(b);});child.stderr.on('data',()=>{});
  const timer=setTimeout(()=>kill('Code exceeded its time limit.'),remaining);
  let code;try{child.stdin.end(JSON.stringify(job));[code]=await ended;}finally{clearTimeout(timer);}
  if(reason)throw Error(reason);
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('Code must return JSON. Console output is not supported.');}
  if(code!==0||result.ok!==true||!Object.hasOwn(result,'output'))throw Error('Code failed. Check its syntax, memory limit and JSON return value.');
  jsonValue(result.output);return result.output;
 }finally{signal.removeEventListener('abort',aborted);await remove();}
}
const server=createServer(async(req,res)=>{
 const reply=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
 if(req.url==='/health'&&req.method==='GET')return reply(200,{ready:!closing,runtime:'runsc',languages:['javascript','python']});
 if(closing||req.url!=='/run'||req.method!=='POST')return reply(404,{ok:false,error:'Code runner route unavailable.'});
 if(req.headers['content-type']!=='application/json')return reply(400,{ok:false,error:'Send a JSON code job.'});
 let job;try{let bytes=0,chunks=[];for await(const b of req){bytes+=b.length;if(bytes>524288)throw Error('Code job exceeds 512 KiB.');chunks.push(b);}job=JSON.parse(Buffer.concat(chunks).toString());validate(job);}catch{return reply(400,{ok:false,error:'Invalid or oversized code job.'});}
 if(active.size>=2||tenants.has(job.tenantId))return reply(429,{ok:false,error:'Code runner busy. Retry this step shortly.'});
 // ponytail: two local slots, one per workspace; add an independently placed fleet and durable tenant-fair queue when measured throughput requires it.
 const controller=new AbortController();tenants.add(job.tenantId);res.on('close',()=>{if(!res.writableFinished)controller.abort();});
 const task=execute(job,controller.signal);active.set(controller,task);
 try{reply(200,{ok:true,output:await task});}catch(e){reply(400,{ok:false,error:e.message});}finally{active.delete(controller);tenants.delete(job.tenantId);}
});
server.requestTimeout=3000;server.headersTimeout=3000;server.maxConnections=16;
server.listen(socket,()=>{chmodSync(socket,0o660);console.log('Isolated code runner ready.');});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{if(stopping)return;stopping=true;closing=true;server.close();for(const controller of active.keys())controller.abort();await Promise.allSettled(active.values());server.closeAllConnections();if(existsSync(socket))unlinkSync(socket);});
