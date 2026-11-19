import {createHash} from 'node:crypto';
import {rateLimit} from 'express-rate-limit';
import {AppError} from './model.mjs';

let redis,pending=0;
export function configureRateLimits(client){redis=client;}
const incrementScript=`local n=redis.call('INCR',KEYS[1]); local ttl=redis.call('PTTL',KEYS[1]);
if ttl<0 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); ttl=tonumber(ARGV[1]) end; return {n,ttl}`;
async function command(client,script,key,args=[]) {
  let timer;
  try {
    // ponytail: at most 512 unresolved protection commands per API process; tune from load metrics.
    if(!client?.isReady||pending>=512)throw new Error('Unavailable');
    const operation=client.withCommandOptions({timeout:1500}).eval(script,{keys:[key],arguments:args});
    pending++;operation.then(()=>pending--,()=>pending--);
    // Redis client's command timeout covers enqueueing, not an already sent command's response.
    return await Promise.race([operation,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Protection deadline exceeded')),1500);})]);
  } catch {
    // A timed-out increment may still count; no business handler runs on an uncertain allowance.
    const error=new AppError(503,'Request protection is temporarily unavailable. Try again shortly.');
    error.code='RATE_LIMIT_UNAVAILABLE';throw error;
  } finally {clearTimeout(timer);}
}
export async function consumeRateLimit(client,key,windowMs) {
  if(!Number.isSafeInteger(windowMs)||windowMs<1||windowMs>86400000)throw new Error('Invalid rate limit window.');
  const [totalHits,ttl]=await command(client,incrementScript,key,[String(windowMs)]);
  return {totalHits,resetTime:new Date(Date.now()+ttl)};
}
export class RedisRateStore {
  localKeys=false;
  constructor(scope,client=null) {
    if(!/^[a-z][a-z-]{0,39}$/.test(scope))throw new Error('Invalid rate limit scope.');
    const test=process.env.NODE_ENV==='test'?process.env.TEST_RATE_LIMIT_NAMESPACE:null;
    if(test&&!/^[0-9a-f-]{36}$/.test(test))throw new Error('Invalid test rate limit namespace.');
    this.prefix=`drykraft:rate:${test?'test:'+test:'v1'}:${scope}:`;this.client=client;
  }
  init({windowMs}){this.windowMs=windowMs;}
  key(key){return this.prefix+createHash('sha256').update(key).digest('hex');}
  increment(key){return consumeRateLimit(this.client||redis,this.key(key),this.windowMs);}
  async decrement(key){await command(this.client||redis,"local n=tonumber(redis.call('GET',KEYS[1])); if n and n>0 then redis.call('DECR',KEYS[1]) end; return 0",this.key(key));}
  async resetKey(key){await command(this.client||redis,"return redis.call('DEL',KEYS[1])",this.key(key));}
}
export function sharedRateLimit(scope,options) {
  return rateLimit({...options,standardHeaders:'draft-8',legacyHeaders:false,passOnStoreError:false,store:new RedisRateStore(scope),handler:(req,res,next,config)=>res.status(429).json({error:{message:config.message.error.message,request_id:req.requestId}})});
}
