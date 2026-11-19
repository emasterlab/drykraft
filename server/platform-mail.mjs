import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './model.mjs';
import {tokenHash} from './auth.mjs';
import {authorizedPlatform,platformAudit} from './platform-auth.mjs';
import {encryptCredential,decryptCredential} from './automation.mjs';
import {smtpTransport} from './outreach-providers.mjs';
import {requirePlatformDatabase} from './platform-db.mjs';

const administrators=['owner','admin'],readers=['owner','admin','support','billing','viewer'];
const uuid=z.string().uuid(),version=z.number().int().positive(),reason=z.string().trim().min(10).max(1000);
const command=z.object({request_id:uuid,invitation_id:uuid,version,reason}).strict();
const emailCommand=command.extend({template_version:version,transport_version:version,preview_hash:z.string().regex(/^[a-f0-9]{64}$/)});
const transportScope='platform-mail-transport',invitationScope=(id,v)=>`platform-invitation:${id}:${v}`;
const variables=['workspace_name','product_name','invite_url','expires_at','owner_email','support_email'];
const templateContent=z.object({subject:z.string().trim().min(5).max(200).regex(/^[^\r\n]+$/),body:z.string().trim().min(20).max(10000)}).strict();
function validateTemplate(b,c){
 for(const value of [b.subject,b.body]){
  for(const match of value.matchAll(/\{\{([^}]*)\}\}/g))if(!variables.includes(match[1].trim()))c.addIssue({code:'custom',message:`Unsupported placeholder: ${match[1]}`});
  if(value.replace(/\{\{\s*(workspace_name|product_name|invite_url|expires_at|owner_email|support_email)\s*\}\}/g,'').includes('{{'))c.addIssue({code:'custom',message:'Use the listed placeholders with two closing braces.'});
 }
 if(!/\{\{\s*invite_url\s*\}\}/.test(b.body))c.addIssue({code:'custom',message:'The invitation body must contain {{invite_url}}.'});
}
const templateBody=templateContent.extend({version,reason}).superRefine(validateTemplate);
const templatePreview=templateContent.superRefine(validateTemplate);
const transportBody=z.object({version,reason,enabled:z.boolean(),email:z.string().trim().toLowerCase().email().max(200),from_name:z.string().trim().min(2).max(100).regex(/^[^\r\n]+$/),host:z.string().trim().min(3).max(253).regex(/^[a-zA-Z0-9.-]+$/),port:z.union([z.literal(465),z.literal(587)]),user:z.string().trim().min(1).max(200),password:z.string().min(1).max(1000).optional()}).strict();
export function platformMailPreview(){return process.env.NODE_ENV==='test'&&!!process.env.PLATFORM_MAIL_PREVIEW_SINK;}
export function renderPlatformMail(template,values){
 const replace=value=>value.replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(_,key)=>String(values[key]??''));
 return {subject:replace(template.subject).replace(/[\r\n]+/g,' ').slice(0,500),text:replace(template.body)};
}
export async function platformInvitationToken(c,invite){
 if(invite.token_ciphertext)return decryptCredential(invitationScope(invite.id,invite.version),invite.token_ciphertext).token;
 const operation=(await c.query('SELECT id,invitation_ciphertext FROM platform_provisioning_operations WHERE invitation_id=$1',[invite.id])).rows[0];
 if(!operation||invite.version!==1)throw new AppError(409,'Renew this invitation before sharing or emailing its link.');
 return decryptCredential('platform-provision:'+operation.id,operation.invitation_ciphertext).token;
}
function origin(){const domain=process.env.APP_DOMAIN||'localhost';return domain==='localhost'?process.env.PLATFORM_INVITATION_ORIGIN||'http://localhost:5173':`https://app.${domain}`;}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
export async function queuePasswordResetEmail(email,resetUrl){
 const database=requirePlatformDatabase(),result=await database.query('SELECT version,metadata,ciphertext,enabled,verified_at FROM platform_mail_transport WHERE id=true');
 const transport=result.rows[0];if(!transport?.enabled||!transport.verified_at||!transport.ciphertext)throw new AppError(503,'Password reset email is not available.');
 const link=new URL(resetUrl),app=new URL(origin());if(link.origin!==app.origin||link.pathname!=='/reset-password')throw new AppError(400,'Invalid password reset address.');
 const mailId=randomUUID(),settings=(await database.query('SELECT data FROM platform_settings WHERE id=true')).rows[0]?.data||{};
 const to=z.string().email().max(200).parse(email),from={name:transport.metadata.from_name,address:transport.metadata.email},support=settings.support_email||transport.metadata.email;
 const subject='Reset your DryKraft password';
 const text=`We received a request to reset the password for your DryKraft account.\n\nChoose a new password: ${link.href}\n\nThis link expires in 15 minutes and can only be used once. If you did not request this change, you can ignore this email. Your password will stay the same.\n\nFor help, contact ${support}.`;
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f7f8fa;color:#303c49;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f8fa;padding:40px 16px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px"><tr><td style="padding:0 0 22px"><img src="${escapeHtml(app.origin)}/logo-ui.png" alt="DryKraft" width="150" style="display:block;width:150px;height:auto;border:0"></td></tr><tr><td style="background:#fff;border:1px solid #e7ebf0;border-radius:12px;padding:36px 38px"><div style="display:inline-block;padding:6px 10px;border-radius:20px;background:#f8f1ec;color:#92634a;font-size:12px;font-weight:600;letter-spacing:.04em">ACCOUNT SECURITY</div><h1 style="margin:20px 0 12px;color:#25313d;font-size:25px;line-height:1.3;font-weight:600;letter-spacing:-.03em">Reset your password</h1><p style="margin:0 0 24px;color:#667384;font-size:15px;line-height:1.75">We received a request to reset the password for your DryKraft account. Use the button below to choose a new password.</p><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:7px;background:#92634a"><a href="${escapeHtml(link.href)}" style="display:inline-block;padding:13px 20px;color:#fff;text-decoration:none;font-size:14px;font-weight:600">Choose a new password</a></td></tr></table><p style="margin:24px 0 8px;color:#667384;font-size:13px;line-height:1.7">This link expires in <strong style="color:#3e4b59">15 minutes</strong> and can only be used once.</p><p style="margin:0;color:#667384;font-size:13px;line-height:1.7">If you did not request this change, you can ignore this email. Your password will stay the same.</p><hr style="border:0;border-top:1px solid #edf0f3;margin:26px 0 18px"><p style="margin:0;color:#8792a0;font-size:12px;line-height:1.7">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(link.href)}" style="color:#80583f;word-break:break-all">${escapeHtml(link.href)}</a></p></td></tr><tr><td style="padding:20px 4px;color:#8792a0;font-size:12px;line-height:1.7">DryKraft · Built around your business.<br>Need help? <a href="mailto:${escapeHtml(support)}" style="color:#80583f;text-decoration:none">${escapeHtml(support)}</a></td></tr></table></td></tr></table></body></html>`;
 const payload={to,from,replyTo:support,subject,text,html,messageId:`<${mailId}@${process.env.APP_DOMAIN||'drykraft.com'}>`};
 await database.query('INSERT INTO account_password_reset_mail_jobs(id,recipient,transport_version,payload_ciphertext) VALUES($1,$2,$3,$4)',[mailId,to,transport.version,encryptCredential('platform-mail:'+mailId,payload)]);
 return {queued:true};
}
async function invitedWorkspace(c,id){
 const w=(await c.query('SELECT id,name FROM workspaces WHERE id=$1',[id])).rows[0];if(!w)throw new AppError(404,'This workspace could not be found.');return w;
}
async function inviteById(c,workspace,id,expected,actor){
 if(!(await c.query('SELECT lock_platform_owner_invitation($1,$2,$3) AS locked',[actor,workspace,id])).rows[0].locked)throw new AppError(404,'This owner invitation could not be found.');
 const i=(await c.query('SELECT * FROM platform_workspace_invitations WHERE tenant_id=$1 AND id=$2',[workspace,id])).rows[0];
 if(!i)throw new AppError(404,'This owner invitation could not be found.');if(i.version!==expected)throw new AppError(409,'This invitation changed. Reload and review its current status.');return i;
}
async function activeInvitation(c,i,actor){
 if(i.issued_by!==actor)throw new AppError(403,'Renew the invitation to generate a link under your own platform account.');
 if(i.accepted_at||i.revoked_at||new Date(i.expires_at)<=new Date())throw new AppError(409,'Renew an available, unaccepted invitation before sharing or emailing it.');
 const state=(await c.query('SELECT coalesce((SELECT suspended FROM platform_workspace_controls WHERE tenant_id=$1),false) AS suspended,EXISTS(SELECT 1 FROM memberships WHERE tenant_id=$1 AND role=\'owner\') AS owned',[i.tenant_id])).rows[0];
 if(state.suspended)throw new AppError(409,'Restore the workspace before sharing an owner invitation.');
 if(state.owned)throw new AppError(409,'Workspace ownership changed. Reload before continuing.');
}
async function safeTransport(c){const t=(await c.query('SELECT version,metadata,enabled,verified_at,updated_at,ciphertext IS NOT NULL AS has_credentials FROM platform_mail_transport WHERE id=true')).rows[0];return {...t,preview:platformMailPreview()};}
function invitationExpiry(value){return new Intl.DateTimeFormat('en-US',{dateStyle:'long',timeStyle:'short',timeZone:'UTC'}).format(new Date(value))+' UTC';}
async function invitationMessage(c,workspace,i,t,template,mailId){
 const raw=await platformInvitationToken(c,i);if(tokenHash(raw)!==i.token_hash)throw new AppError(409,'Renew this invitation before emailing it.');
 const settings=(await c.query('SELECT data FROM platform_settings WHERE id=true')).rows[0].data;
 const content=renderPlatformMail(template,{workspace_name:workspace.name,product_name:'DryKraft',invite_url:origin()+'/invite?platform=1#'+raw,expires_at:invitationExpiry(i.expires_at),owner_email:i.email,support_email:settings.support_email});
 return {to:i.email,from:{name:t.metadata.from_name,address:t.metadata.email},replyTo:settings.support_email,...content,messageId:`<${mailId}@${process.env.APP_DOMAIN||'localhost'}>`};
}
function messageHash({messageId,...content}){return tokenHash(JSON.stringify(content));}
export function mountPlatformMail(router){
 router.get('/email/transport',async(req,res)=>res.json(await authorizedPlatform(req,administrators,safeTransport)));
 router.put('/email/transport',async(req,res)=>{
  const b=transportBody.parse(req.body);res.json(await authorizedPlatform(req,['owner'],async c=>{
   const previous=(await c.query('SELECT * FROM platform_mail_transport WHERE id=true FOR UPDATE')).rows[0];if(previous.version!==b.version)throw new AppError(409,'Email configuration changed. Reload before saving.');
   const old=previous.ciphertext?decryptCredential(transportScope,previous.ciphertext):null;
   const password=b.password||old?.password;if(!password)throw new AppError(400,'Enter the SMTP password for the first connection.');
   const secret={email:b.email,from_name:b.from_name,host:b.host,port:b.port,user:b.user,password};
   if(b.enabled&&!platformMailPreview()){
    let transport;try{transport=await smtpTransport(secret);await transport.verify();}catch{throw new AppError(502,'SMTP access could not be verified. Check the host, TLS port and account credentials.');}finally{transport?.close();}
   }
   const metadata={email:b.email,from_name:b.from_name,host:b.host,port:b.port,user:b.user};
   await c.query('UPDATE platform_mail_transport SET version=version+1,metadata=$1,ciphertext=$2,enabled=$3,verified_at=CASE WHEN $3 THEN now() ELSE NULL END,updated_by=$4,updated_at=now() WHERE id=true',[metadata,encryptCredential(transportScope,secret),b.enabled,req.sa.id]);
   await platformAudit(c,req,'platform.email.transport_updated','settings',null,b.reason,{enabled:b.enabled,metadata});return safeTransport(c);
  }));
 });
 router.get('/email/templates/owner_invitation',async(req,res)=>res.json(await authorizedPlatform(req,readers,async c=>({... (await c.query("SELECT key,version,subject,body,updated_at FROM platform_mail_templates WHERE key='owner_invitation'")).rows[0],variables}))));
 router.put('/email/templates/owner_invitation',async(req,res)=>{
  const b=templateBody.parse(req.body);res.json(await authorizedPlatform(req,administrators,async c=>{
   const previous=(await c.query("SELECT * FROM platform_mail_templates WHERE key='owner_invitation' FOR UPDATE")).rows[0];if(previous.version!==b.version)throw new AppError(409,'This email template changed. Your input is retained; reload the saved version before replacing it.');
   const t=(await c.query("UPDATE platform_mail_templates SET version=version+1,subject=$1,body=$2,updated_by=$3,updated_at=now() WHERE key='owner_invitation' RETURNING key,version,subject,body,updated_at",[b.subject,b.body,req.sa.id])).rows[0];
   await c.query('INSERT INTO platform_mail_template_versions(key,version,subject,body,created_by) VALUES($1,$2,$3,$4,$5)',[t.key,t.version,t.subject,t.body,req.sa.id]);
   await platformAudit(c,req,'platform.email.template_updated','template',null,b.reason,{key:t.key,version:t.version});return {...t,variables};
  }));
 });
 router.post('/email/templates/owner_invitation/preview',async(req,res)=>{
  const b=templatePreview.parse(req.body);res.json(await authorizedPlatform(req,readers,async()=>renderPlatformMail(b,{workspace_name:'Sample workspace',product_name:'DryKraft',invite_url:origin()+'/invite?platform=1#sample-invitation',expires_at:invitationExpiry(Date.now()+7*24*60*60*1000),owner_email:'owner@example.test',support_email:'support@drykraft.com'})));
 });
 router.get('/email/deliveries',async(req,res)=>{
  const q=z.object({cursor:uuid.optional(),workspace_id:uuid.optional()}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,readers,async c=>{
   const after=q.cursor?(await c.query('SELECT created_at::text AS at FROM platform_mail_jobs WHERE id=$1 AND ($2::uuid IS NULL OR tenant_id=$2)',[q.cursor,q.workspace_id||null])).rows[0]?.at:null;if(q.cursor&&!after)throw new AppError(400,'This delivery page is unavailable. Return to the first page.');
   const rows=(await c.query('SELECT j.id,j.tenant_id,w.name AS workspace_name,j.invitation_id,j.invitation_version,j.recipient,j.state,j.template_version,j.created_at,j.accepted_at,j.finished_at,j.error_code FROM platform_mail_jobs j JOIN workspaces w ON w.id=j.tenant_id WHERE ($1::uuid IS NULL OR j.tenant_id=$1) AND ($2::timestamptz IS NULL OR (j.created_at,j.id)<($2,$3::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT 26',[q.workspace_id||null,after,q.cursor||null])).rows;
   return {items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null,preview:platformMailPreview()};
  }));
 });
 router.post('/workspaces/:id/owner-invitation/link',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=command.omit({request_id:true}).parse(req.body);res.json(await authorizedPlatform(req,administrators,async c=>{
   await invitedWorkspace(c,id);const i=await inviteById(c,id,b.invitation_id,b.version,req.sa.id);await activeInvitation(c,i,req.sa.id);const raw=await platformInvitationToken(c,i);
   if(tokenHash(raw)!==i.token_hash)throw new AppError(409,'This invitation changed. Renew it before sharing.');
   await platformAudit(c,req,'platform.workspace.invitation.link_viewed','workspace',id,b.reason,{invitation_id:i.id,version:i.version});return {invitation_token:raw,version:i.version,expires_at:i.expires_at};
  }));
 });
 router.post('/workspaces/:id/owner-invitation/email-preview',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=command.omit({request_id:true}).parse(req.body);
  res.json(await authorizedPlatform(req,administrators,async c=>{
   const i=await inviteById(c,id,b.invitation_id,b.version,req.sa.id);await activeInvitation(c,i,req.sa.id);
   const t=(await c.query('SELECT * FROM platform_mail_transport WHERE id=true FOR SHARE')).rows[0];
   if(!t.enabled||!t.verified_at||!t.ciphertext)throw new AppError(409,'Configure and verify platform SMTP in Email before sending an invitation.');
   const template=(await c.query("SELECT * FROM platform_mail_templates WHERE key='owner_invitation' FOR SHARE")).rows[0];
   const message=await invitationMessage(c,await invitedWorkspace(c,id),i,t,template,randomUUID());
   await platformAudit(c,req,'platform.workspace.invitation.email_previewed','workspace',id,b.reason,{invitation_id:i.id,version:i.version,template_version:template.version,transport_version:t.version});
   const {messageId,...content}=message;return {...content,preview_hash:messageHash(message),template_version:template.version,transport_version:t.version,preview:platformMailPreview()};
  }));
 });
 const invitationCommands=['/workspaces/:id/owner-invitation/renew','/workspaces/:id/owner-invitation/revoke','/workspaces/:id/owner-invitation/email'];
 router.post(invitationCommands,async(req,res)=>{
  const action=req.path.split('/').at(-1);
  const id=uuid.parse(req.params.id),b=(action==='email'?emailCommand:command).parse(req.body),requestHash=tokenHash(JSON.stringify({workspace_id:id,action,...b}));
  const result=await authorizedPlatform(req,administrators,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['platform-invitation-op:'+b.request_id]);
   const previous=(await c.query('SELECT * FROM platform_invitation_operations WHERE id=$1',[b.request_id])).rows[0];
   if(previous){if(previous.actor_id!==req.sa.id||previous.request_hash!==requestHash)throw new AppError(409,'This request has different saved details. Keep the original request or reload before trying again.');return {...previous.result,reused:true};}
   const i=await inviteById(c,id,b.invitation_id,b.version,req.sa.id),workspace=await invitedWorkspace(c,id);let saved;
   if(action==='renew'||action==='revoke'){
    if(i.accepted_at)throw new AppError(409,'This invitation was accepted. Workspace ownership must be managed separately.');
    if(action==='renew'){
     const state=(await c.query('SELECT coalesce((SELECT suspended FROM platform_workspace_controls WHERE tenant_id=$1),false) AS suspended,EXISTS(SELECT 1 FROM memberships WHERE tenant_id=$1 AND role=\'owner\') AS owned',[id])).rows[0];
     if(state.suspended||state.owned)throw new AppError(409,'Workspace ownership or access changed. Restore access or review ownership before renewing.');
    }
    const raw=action==='renew'?randomBytes(32).toString('hex'):null;
    saved=(await c.query('SELECT manage_platform_workspace_invitation($1,$2,$3,$4,$5,$6,$7,$8) AS data',[req.sa.id,id,i.id,i.version,action,raw?tokenHash(raw):null,raw?encryptCredential(invitationScope(i.id,i.version+1),{token:raw}):null,b.reason])).rows[0].data;
   }else{
    await activeInvitation(c,i,req.sa.id);const t=(await c.query('SELECT * FROM platform_mail_transport WHERE id=true FOR SHARE')).rows[0];if(!t.enabled||!t.verified_at||!t.ciphertext)throw new AppError(409,'Configure and verify platform SMTP in Email before sending an invitation.');
    if(t.version!==b.transport_version)throw new AppError(409,'The email connection changed. Preview the invitation again before sending.');
    if((await c.query("SELECT 1 FROM platform_mail_jobs WHERE invitation_id=$1 AND invitation_version=$2 AND (state IN ('queued','sending') OR created_at>now()-interval '10 minutes') LIMIT 1",[i.id,i.version])).rowCount)throw new AppError(409,'This invitation already has a recent delivery. Review its status before sending another email.');
    if((await c.query("SELECT count(*)::int AS count FROM platform_mail_jobs WHERE tenant_id=$1 AND created_at>now()-interval '1 hour'",[id])).rows[0].count>=3)throw new AppError(429,'Up to three owner invitation emails can be queued for a workspace each hour.');
    const template=(await c.query("SELECT * FROM platform_mail_templates WHERE key='owner_invitation' FOR SHARE")).rows[0],mailId=randomUUID();
    if(template.version!==b.template_version)throw new AppError(409,'The email template changed. Preview the invitation again before sending.');
    const payload=await invitationMessage(c,workspace,i,t,template,mailId);
    if(messageHash(payload)!==b.preview_hash)throw new AppError(409,'The invitation content changed. Preview it again before sending.');
    await c.query('INSERT INTO platform_mail_jobs(id,tenant_id,invitation_id,invitation_version,actor_id,template_version,transport_version,recipient,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[mailId,id,i.id,i.version,req.sa.id,template.version,t.version,i.email,encryptCredential('platform-mail:'+mailId,payload)]);
    await platformAudit(c,req,'platform.workspace.invitation.email_queued','workspace',id,b.reason,{invitation_id:i.id,mail_id:mailId,template_version:template.version});saved={invitation_id:i.id,version:i.version,mail_id:mailId,state:'queued'};
   }
   await c.query('INSERT INTO platform_invitation_operations(id,actor_id,invitation_id,action,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',[b.request_id,req.sa.id,i.id,action,requestHash,saved]);return {...saved,reused:false};
  });res.status(result.reused?200:action==='email'?202:200).json(result);
 });
}
