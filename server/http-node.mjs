import { lookup } from 'node:dns/promises';
import { Agent,request } from 'undici';
import ipaddr from 'ipaddr.js';
import { AppError } from './model.mjs';

export async function publicAddress(hostname) {
  hostname=hostname.replace(/^\[|\]$/g,'');
  const addresses=ipaddr.isValid(hostname)?[{address:hostname,family:ipaddr.parse(hostname).kind()==='ipv4'?4:6}]:await lookup(hostname,{all:true});
  if(!addresses.length || addresses.some(a=>ipaddr.process(a.address).range()!=='unicast'))throw new AppError(400,'Private, local, and reserved network addresses are blocked.');
  return addresses[0];
}
export function providerHttpError(url,status,body){
  const error=new AppError(502,`The provider returned HTTP ${status}.`);
  error.providerStatus=status;
  if(url.hostname==='graph.facebook.com'&&[401,403].includes(status)){
    error.providerService='whatsapp';
    if(body?.error?.code===190){
      error.providerReason='INVALID_ACCESS_TOKEN';
      error.message='The WhatsApp access token is invalid or expired. Open this connection, choose Replace credentials, and save a valid Meta system user token.';
    }else if([10,200].includes(body?.error?.code)){
      error.providerReason='INSUFFICIENT_PERMISSIONS';
      error.message='Meta did not grant the required WhatsApp permissions. Check the system user token and its access to this WhatsApp Business account.';
    }
    return error;
  }
  if(!url.hostname.endsWith('.googleapis.com')||status!==403)return error;
  const details=Array.isArray(body?.error?.details)?body.error.details:[];
  const entries=Array.isArray(body?.error?.errors)?body.error.errors:[];
  const reasons=new Set([...details,...entries].map(value=>value?.reason));
  const calendar=url.pathname.startsWith('/calendar/v3/')||details.some(value=>value?.metadata?.service==='calendar-json.googleapis.com');
  const gmail=url.hostname==='gmail.googleapis.com'||details.some(value=>value?.metadata?.service==='gmail.googleapis.com');
  const service=calendar?'Google Calendar':gmail?'Gmail':null;
  if(!service)return error;
  error.providerService=calendar?'calendar-json.googleapis.com':'gmail.googleapis.com';
  if(reasons.has('SERVICE_DISABLED')||reasons.has('accessNotConfigured')){
    const consumer=details.map(value=>value?.metadata?.consumer).find(value=>typeof value==='string'&&/^projects\/\d{1,20}$/.test(value));
    const project=consumer?.slice(9);
    error.providerReason='SERVICE_DISABLED';
    error.message=`${service} API is disabled for this app's Google Cloud project${project?' '+project:''}. Enable the ${service} API in Google Cloud, then try again.`;
  }else if(reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT')||reasons.has('insufficientPermissions')){
    error.providerReason='ACCESS_TOKEN_SCOPE_INSUFFICIENT';
    error.message=`Google did not grant the required ${service} permissions. Connect the account again and approve the requested access.`;
  }
  return error;
}
export async function safeHttp(url,options={}) {
  const parsed=new URL(url);
  if(!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password)throw new AppError(400,'HTTP nodes require a public HTTP or HTTPS URL without embedded credentials.');
  if(parsed.port && !['80','443'].includes(parsed.port))throw new AppError(400,'HTTP nodes use standard ports 80 and 443.');
  const resolved=await publicAddress(parsed.hostname);
  const dispatcher=new Agent({connect:{lookup:(host,opt,callback)=>callback(null,resolved.address,resolved.family),autoSelectFamily:false}});
  try {
    const response=await request(parsed,{dispatcher,method:options.method || 'GET',headers:options.headers,body:options.body,maxRedirections:0,headersTimeout:15000,bodyTimeout:15000,signal:AbortSignal.timeout(20000)});
    if(response.statusCode>=300 && response.statusCode<400){await response.body.dump();throw new AppError(400,'Redirects are blocked. Enter the final URL.');}
    let length=0,parts=[];
    for await(const chunk of response.body){length+=chunk.length;if(length>1024*1024){response.body.destroy();throw new AppError(400,'HTTP response exceeds 1 MB.');}parts.push(chunk);}
    const text=Buffer.concat(parts).toString('utf8');let body=text;
    try{body=JSON.parse(text);}catch{}
    if(response.statusCode>=400)throw providerHttpError(parsed,response.statusCode,body);
    return {status:response.statusCode,body};
  } finally {await dispatcher.close();}
}
