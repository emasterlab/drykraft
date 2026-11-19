import { z } from 'zod';
import { createHmac,timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapFlow } from 'imapflow';
import { safeHttp,publicAddress } from './http-node.mjs';
import { AppError } from './model.mjs';
import { interpolate } from './automation.mjs';
import {oauthCallback} from './oauth-callbacks.mjs';
import {campaignEmail} from '../src/lib/campaign-email.mjs';

const text=z.string().trim().min(1).max(10000);
const host=z.string().regex(/^[a-zA-Z0-9.-]{1,253}$/);
export const connectionSchema=z.object({name:z.string().trim().min(1).max(100),provider:z.enum(['smtp','curl','qcall','whatsapp']),daily_limit:z.number().int().min(1).max(10000).default(100),hourly_limit:z.number().int().min(1).max(2000).default(20),secret:z.record(z.string(),z.unknown())});
export function connectionData(provider,input){
 if(provider==='smtp')return z.object({email:z.string().email().max(200),host,port:z.union([z.literal(465),z.literal(587)]),user:text,password:text,imap:z.object({host,user:text,password:text}).optional()}).parse(input);
 if(provider==='qcall')return z.object({apiKey:text}).parse(input);
 if(provider==='whatsapp')return z.object({accessToken:text,appSecret:text,wabaId:z.string().regex(/^\d{5,40}$/),phoneId:z.string().regex(/^\d{5,40}$/),version:z.string().regex(/^v\d{2}\.0$/).default('v23.0')}).parse(input);
 const s=z.object({curl:z.string().min(10).max(50000),recipientPath:z.string().min(1).max(150),messagePath:z.string().max(150).optional()}).parse(input);
 const parsed=parseCurl(s.curl);setBodyPath(parsed.body,s.recipientPath,'{{recipient}}');if(s.messagePath)setBodyPath(parsed.body,s.messagePath,'{{message}}');return parsed;
}
// Parse a deliberately small cURL grammar. Nothing is executed, expanded, read from disk or followed.
export function parseCurl(source){
 if(/[\x00`]/.test(source)||source.includes('$('))throw new AppError(400,'Remove shell expressions from the cURL example.');
 const tokens=[];let value='',quote=null,started=false;
 for(let i=0;i<source.length;i++){
  const c=source[i];
  if(c==='\\'&&quote!=="'"){if(source[i+1]==='\n'){i++;continue;}if(i+1>=source.length)throw new AppError(400,'Incomplete cURL escape.');value+=source[++i];started=true;continue;}
  if(quote){if(c===quote)quote=null;else value+=c;started=true;continue;}
  if(c==='"'||c==="'"){quote=c;started=true;continue;}
  if(/[;|&<>]/.test(c))throw new AppError(400,'Paste a single cURL request without shell operators.');
  if(/\s/.test(c)){if(started){tokens.push(value);value='';started=false;}}else{value+=c;started=true;}
 }
 if(quote)throw new AppError(400,'Close every quote in the cURL example.');if(started)tokens.push(value);
 if(tokens.shift()!=='curl')throw new AppError(400,'Start the example with curl.');
 let url,method='POST',body;const headers={};
 while(tokens.length){const flag=tokens.shift();if(['-X','--request','--url','-H','--header','-d','--data','--data-raw','--data-binary'].includes(flag)){
  const v=tokens.shift();if(!v||v.startsWith('@'))throw new AppError(400,'Use literal URL, headers and JSON; file input is blocked.');
  if(flag==='--url'){if(url)throw new AppError(400,'Use one URL.');url=v;}
  else if(['-X','--request'].includes(flag))method=v.toUpperCase();
  else if(['-H','--header'].includes(flag)){const p=v.indexOf(':');if(p<1)throw new AppError(400,'Use header: value syntax.');const k=v.slice(0,p).toLowerCase(),s=v.slice(p+1).trim();if(!/^[a-z0-9-]+$/.test(k)||/[\r\n]/.test(s)||['host','content-length','connection','transfer-encoding','proxy-authorization'].includes(k))throw new AppError(400,'This header is not supported.');headers[k]=s;}
  else{if(body!==undefined)throw new AppError(400,'Use one JSON body.');try{body=JSON.parse(v);}catch{throw new AppError(400,'Use a valid JSON body.');}}
 }else if(/^https:\/\//.test(flag)&&!url)url=flag;else throw new AppError(400,'Supported options: request, URL, headers and a JSON body.');}
 let parsed;try{parsed=new URL(url);}catch{throw new AppError(400,'Enter a valid HTTPS provider URL.');}
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||!['','443'].includes(parsed.port)||method!=='POST'||!body||typeof body!=='object'||Array.isArray(body))throw new AppError(400,'SMS connections require one HTTPS POST and a JSON object body.');
 headers['content-type']='application/json';return {url:parsed.href,method,headers,body};
}
export function setBodyPath(body,path,value){
 const parts=path.split('.');if(parts.some(p=>!p||['__proto__','constructor','prototype'].includes(p)))throw new AppError(400,'Choose a valid existing body parameter path.');
 const key=parts.pop();let target=body;for(const p of parts){if(!target||typeof target!=='object'||!Object.hasOwn(target,p))throw new AppError(400,'This parameter path is missing from the JSON body.');if(Array.isArray(target)&&target.length!==1)throw new AppError(400,'Use a cURL example with exactly one recipient.');target=target[p];}
 if(!target||typeof target!=='object'||!Object.hasOwn(target,key)||typeof target[key]==='object')throw new AppError(400,'Choose an existing text or number parameter in the JSON body.');target[key]=value;
}
export function curlParameters(source){
 const s=parseCurl(source),parameters=[],pending=[{value:s.body,path:'',depth:0}];
 while(pending.length){const {value,path,depth}=pending.pop();if(depth>10||parameters.length+pending.length>200)throw new AppError(400,'Use a smaller provider body with at most 200 parameters and 10 levels.');
  if(value&&typeof value==='object')for(const [key,v]of Object.entries(value))pending.push({value:v,path:path?path+'.'+key:key,depth:depth+1});else parameters.push(path);
 }
 return {host:new URL(s.url).hostname,parameters:parameters.sort(),recipientPath:parameters.find(p=>/(^|\.)(to|mobiles?|phone|recipient)$/i.test(p))||'',messagePath:parameters.find(p=>/(^|\.)(message|body|text)$/i.test(p))||''};
}
export function normalizeRecipient(channel,value){
 if(channel==='email')return z.string().email().max(200).parse(String(value||'').trim().toLowerCase());
 const v=String(value||'').replace(/[ ()-]/g,'');if(!/^\+[1-9]\d{7,14}$/.test(v))throw new AppError(400,'Phone numbers need a country code, for example +919876543210.');return v;
}
async function pinnedHost(hostname){return (await publicAddress(hostname)).address;}
export async function smtpTransport(s){return nodemailer.createTransport({host:await pinnedHost(s.host),port:s.port,secure:s.port===465,requireTLS:true,auth:{user:s.user,pass:s.password},tls:{servername:s.host,rejectUnauthorized:true},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,logger:false,debug:false});}
export async function imapClient(s){return new ImapFlow({host:await pinnedHost(s.host),port:993,secure:true,tls:{servername:s.host,rejectUnauthorized:true},auth:{user:s.user,pass:s.password},logger:false,disableAutoIdle:true,connectionTimeout:10000,socketTimeout:15000});}
export async function providerJson(url,secret,body,request=safeHttp){return (await request(url,{headers:{'content-type':'application/json',...(secret?{'x-api-key':secret}:{})},method:body?'POST':'GET',body:body?JSON.stringify(body):undefined})).body;}
export function qcallData(response){if(response?.success===false)throw new AppError(502,'QCall could not accept this request. Review the connection.');return response?.data??response;}
export async function qcallOptions(s,request=safeHttp){const [a,d]=await Promise.all(['/user/listAssistant','/dialer/list'].map(p=>providerJson('https://api.qcall.ai/api/v1'+p,s.apiKey,undefined,request).then(qcallData)));if(!Array.isArray(a)||!Array.isArray(d))throw new AppError(502,'QCall returned an unsupported account response.');return {assistants:a.map(v=>({id:String(v.id),name:String(v.name||'Assistant')})),dialers:d.map(v=>({id:String(v.id),name:String(v.name||v.dialer_name||'Dialer')}))};}
export async function whatsappRequest(s,path,body,request=safeHttp){return (await request(`https://graph.facebook.com/${s.version}/${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${s.accessToken}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined})).body;}
export async function whatsappTemplates(s,request=safeHttp){const r=await whatsappRequest(s,`${s.wabaId}/message_templates?limit=100`,undefined,request);return (r.data||[]).filter(t=>t.status==='APPROVED').map(t=>({name:t.name,language:t.language,components:t.components}));}
export function validMetaSignature(raw,signature,secret){if(!Buffer.isBuffer(raw)||!/^sha256=[a-f0-9]{64}$/.test(signature||''))return false;const actual=Buffer.from(signature.slice(7),'hex'),expected=createHmac('sha256',secret).update(raw).digest();return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export async function qcallText(instructions,message,request=safeHttp){
 const r=await request('https://llm.qcall.ai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:process.env.QCALL_LLM_MODEL||'',messages:[{role:'system',content:'Write a short, accurate WhatsApp reply using only the business instructions. Do not invent prices, appointments, transactions or access. Do not include links unless supplied. Plain text only. Business instructions: '+String(instructions).slice(0,8000)},{role:'user',content:String(message).slice(0,4000)}],temperature:0.3,max_tokens:600,stream:true,chat_template_kwargs:{enable_thinking:false}})});
 let output='',finished=false;for(const line of String(r.body).split('\n')){if(!line.startsWith('data: '))continue;const t=line.slice(6);if(t==='[DONE]')continue;let event;try{event=JSON.parse(t);}catch{continue;}output+=event.choices?.[0]?.delta?.content||'';if(event.choices?.[0]?.finish_reason==='stop')finished=true;}
 output=output.trim();if(!finished||!output||output.length>3000)throw new AppError(502,'QCall could not finish a reply. Review the conversation and try again.');return output;
}
export const oauth={
 google:{prefix:'GOOGLE_OAUTH',authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scope:'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email'},
 microsoft:{prefix:'MS_OAUTH',authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token',scope:'Mail.Send Mail.Read offline_access User.Read'},
};
export function oauthReady(provider){const p=oauth[provider];return !!(p&&process.env[p.prefix+'_CLIENT_ID']&&process.env[p.prefix+'_CLIENT_SECRET']);}
export function oauthRedirect(provider){return oauthCallback(provider,'outreach');}
export async function oauthTokens(provider,fields,request=safeHttp){const p=oauth[provider];const r=await request(p.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env[p.prefix+'_CLIENT_ID'],client_secret:process.env[p.prefix+'_CLIENT_SECRET'],...fields}).toString()});const t=z.object({access_token:text,refresh_token:text.optional(),expires_in:z.number().positive()}).parse(r.body);return {accessToken:t.access_token,refreshToken:t.refresh_token||fields.refresh_token,expiresAt:Date.now()+t.expires_in*1000};}
export async function emailProfile(provider,s,request=safeHttp){const url=provider==='google'?'https://gmail.googleapis.com/gmail/v1/users/me/profile':'https://graph.microsoft.com/v1.0/me';const r=(await request(url,{headers:{Authorization:`Bearer ${s.accessToken}`}})).body;return z.string().email().parse(provider==='google'?r.emailAddress:r.mail||r.userPrincipalName);}
export async function sendProvider(connection,s,recipient,step,context,id,request=safeHttp){
 const message=interpolate(step.body||'',context),subject=interpolate(step.subject||'',context);
 if(connection.channel==='email'){
  const unsubscribe=context.unsubscribeUrl,content=campaignEmail({subject,body:message,senderName:context.workspace?.name||connection.name,senderEmail:s.email,unsubscribeUrl:unsubscribe});
  const options={from:s.email,to:recipient,subject,...content,messageId:`<${id}@${process.env.APP_DOMAIN||'drykraft.com'}>`,headers:unsubscribe?{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}:{}};
  if(connection.provider==='smtp'){const t=await smtpTransport(s);try{const r=await t.sendMail(options);if(!r.accepted?.length)throw new AppError(502,'The mail server did not accept the recipient.');return {id:options.messageId};}finally{t.close();}}
  const mime=await new MailComposer(options).compile().build();
  if(connection.provider==='google'){const r=await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:`Bearer ${s.accessToken}`,'content-type':'application/json'},body:JSON.stringify({raw:mime.toString('base64url')})});return {id:options.messageId,remoteId:r.body.id};}
  await request('https://graph.microsoft.com/v1.0/me/sendMail',{method:'POST',headers:{Authorization:`Bearer ${s.accessToken}`,'content-type':'text/plain'},body:mime.toString('base64')});return {id:options.messageId};
 }
 if(connection.channel==='sms'){const r=await request(s.url,{method:'POST',headers:s.headers,body:JSON.stringify(interpolate(s.body,{...context,recipient:recipient.slice(1),message,variables:interpolate(step.variables||{},context)}))});if(r.body?.type==='error'||r.body?.success===false)throw new AppError(502,'The SMS provider did not accept this message.');return {id:String(r.body?.request_id||r.body?.message_id||r.body?.id||id)};}
 if(connection.channel==='whatsapp'){
  const parameters=interpolate(step.parameters||[],context).map(v=>({type:'text',text:String(v)}));
  const r=await whatsappRequest(s,`${s.phoneId}/messages`,{messaging_product:'whatsapp',to:recipient.slice(1),type:'template',template:{name:step.template,language:{code:step.language},...(parameters.length?{components:[{type:'body',parameters}]}:{})}},request);
  if(!r.messages?.[0]?.id)throw new AppError(502,'WhatsApp did not confirm acceptance.');return {id:r.messages[0].id};
 }
 // One contact per provider tag keeps the shared runtime's per-recipient sequence ordering.
 const name='DryKraft '+id,tag=qcallData(await providerJson('https://api.qcall.ai/api/v1/tag/create',s.apiKey,{name,description:'DryKraft outreach step'},request));
 let tagId=tag?.id||tag?.tag?.id;
 if(!tagId){const tags=qcallData(await providerJson('https://api.qcall.ai/api/v1/tag/list',s.apiKey,undefined,request));const matches=Array.isArray(tags)?tags.filter(t=>t.name===name):[];if(matches.length===1)tagId=matches[0].id;}
 if(!tagId)throw new AppError(502,'QCall did not confirm the new tag ID.');
 const [first,...last]=String(context.record?.data?.name||'Contact').split(' ');
 qcallData(await providerJson('https://api.qcall.ai/api/v1/tag/contact/create?id='+encodeURIComponent(tagId),s.apiKey,{first_name:first,last_name:last.join(' ')||first,phone:recipient,email:context.record?.data?.email||''},request));
 const campaign=qcallData(await providerJson('https://api.qcall.ai/api/v1/campaign/create',s.apiKey,{campaigns_name:'DryKraft '+id,assistant_id:step.assistantId,segment_id:tagId,dialer_id:step.dialerId,is_automation:true},request));
 return {id:String(campaign?.id||campaign?.campaign?.id||id),tagId};
}
