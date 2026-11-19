import {request} from 'node:http';
import {z} from 'zod';
import {AppError} from './model.mjs';

const name=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).refine(v=>!['constructor','prototype','__proto__'].includes(v));
const settings=z.object({language:z.enum(['javascript','python']).default('javascript'),source:z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/).refine(v=>!v.split('.').some(k=>['constructor','prototype','__proto__'].includes(k))),code:z.string().min(1).max(65536).refine(v=>v.trim().length>0&&Buffer.byteLength(v)<=65536),timeoutSeconds:z.number().int().min(1).max(10).default(5),secretBindings:z.array(z.object({name,credentialId:z.string().uuid()}).strict()).max(8).default([])}).superRefine((d,c)=>{if(new Set(d.secretBindings.map(b=>b.name)).size!==d.secretBindings.length)c.addIssue({code:'custom',message:'Use a unique name for each secret.'});});
export function codeSettings(raw){const r=settings.safeParse(raw);if(!r.success)throw new AppError(400,'Code needs JavaScript or Python, a plain input path, 1-65,536 UTF-8 bytes, a 1-10 second deadline and up to eight uniquely named saved credentials.');return r.data;}
export function codeJson(value,label='Code input'){
 const walk=(v,depth=0)=>{if(depth>40)throw new AppError(400,label+' exceeds 40 JSON levels.');if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'&&Number.isFinite(v))return;if(Array.isArray(v)){for(const a of v)walk(a,depth+1);return;}if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype){for(const [k,a]of Object.entries(v)){if(['constructor','prototype','__proto__'].includes(k))throw new AppError(400,label+' contains a reserved key.');walk(a,depth+1);}return;}throw new AppError(400,label+' must be JSON with finite numbers.');};
 walk(value);const text=JSON.stringify(value);if(Buffer.byteLength(text)>262144)throw new AppError(400,label+' exceeds 256 KiB.');return text;
}
export async function runCode(raw,input,{tenantId,secrets={},signal,socketPath=process.env.CODE_SANDBOX_SOCKET||'/run/drykraft-code/runner.sock'}={}){
 const d=codeSettings(raw);z.string().uuid().parse(tenantId);codeJson(input);const values=z.record(name,z.string().max(8192)).parse(secrets);if(Object.keys(values).length>8||Buffer.byteLength(JSON.stringify(values))>65536)throw new AppError(400,'Code secrets exceed their limit.');
 const body=JSON.stringify({tenantId,language:d.language,code:d.code,timeoutSeconds:d.timeoutSeconds,input,secrets:values});
 return new Promise((resolve,reject)=>{
  const req=request({socketPath,path:'/run',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},signal},res=>{
   let chunks=[],bytes=0;res.on('data',b=>{bytes+=b.length;if(bytes>266240){req.destroy();reject(new AppError(502,'Code runner returned too much output.'));}else chunks.push(b);});
   res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200||result.ok!==true)throw new AppError(res.statusCode===429?429:400,typeof result.error==='string'?result.error.slice(0,300):'Code could not return a result.');codeJson(result.output,'Code output');resolve(result.output);}catch(e){reject(e instanceof AppError?e:new AppError(502,'Code runner returned invalid JSON.'));}});res.on('error',()=>reject(new AppError(503,'Code runner unavailable. Check its service, then retry.')));
  });
  req.on('error',()=>reject(new AppError(signal?.aborted?409:503,signal?.aborted?'Code execution cancelled.':'Code runner unavailable. Check its service, then retry.')));req.setTimeout((d.timeoutSeconds+10)*1000,()=>req.destroy());req.end(body);
 });
}
