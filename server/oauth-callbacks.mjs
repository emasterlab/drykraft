// Explicit Google callbacks can be shared by Calendar and Outreach.
// Keep the existing separate callbacks when no override is configured.
export function oauthCallback(provider,area){
 const origin=(process.env.APP_ORIGIN||'http://localhost:4000').replace(/\/+$/,'');
 const configured=provider==='google'?(area==='calendar'?process.env.GOOGLE_CALENDAR_REDIRECT_URI||process.env.GOOGLE_OAUTH_REDIRECT_URI:process.env.GOOGLE_OAUTH_REDIRECT_URI):null;
 const callback=configured||`${origin}/api/${area}/oauth/${provider}/callback`;
 let url;try{url=new URL(callback);}catch{throw configurationError('Configure a valid OAuth callback URL.');}
 const paths=[`/api/${area}/oauth/${provider}/callback`,...(area==='calendar'?['/api/outreach/oauth/'+provider+'/callback']:[])];
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!paths.includes(url.pathname))throw configurationError('The OAuth callback must use the DryKraft Calendar or Outreach callback endpoint.');
 return callback;
}
function configurationError(message){return Object.assign(new Error(message),{status:503});}

// Google returns to one registered callback; the signed-in workspace selects
// the final destination stored privately alongside the single-use OAuth state.
export function oauthReturnOrigin(req){
 const app=new URL(process.env.APP_ORIGIN||'http://localhost:5173');
 const domain=process.env.APP_DOMAIN||'localhost',slug=req.auth?.workspace?.slug;
 if(domain!=='localhost'&&typeof slug==='string'&&/^[a-z][a-z0-9-]{2,39}$/.test(slug)&&req.hostname===`${slug}.${domain}`)app.hostname=`${slug}.${domain}`;
 return app.origin;
}

export function requireOAuthSessionHost(req,callback){
 if((process.env.APP_DOMAIN||'localhost')!=='localhost')return;
 const host=new URL(callback).hostname;
 if(req.hostname===host)return;
 const app=new URL(process.env.APP_ORIGIN||'http://localhost:5173');app.hostname=host;
 throw Object.assign(new Error(`To keep your sign-in session, open ${app.origin}, sign in there, and connect again.`),{status:409});
}

export function forwardCalendarOAuth(redis,complete){
 return async(req,res,next)=>{
  const state=req.query.state;
  // Only server-held Calendar state selects this handler. It still verifies
  // the original account, session, provider and single-use state itself.
  if(req.params.provider==='google'&&typeof state==='string'&&/^[a-f0-9]{64}$/.test(state)&&await redis.get('drykraft:calendar:oauth:'+state))return complete(req,res);
  next();
 };
}
