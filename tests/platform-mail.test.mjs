import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool} from '../server/db.mjs';
import {platformPool} from '../server/platform-db.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {encryptCredential,decryptCredential} from '../server/automation.mjs';
import {totp} from '../server/mfa.mjs';
import {processPlatformMail,validateMailDatabase,mailFailure} from '../server/platform-mail-worker.mjs';

const origin=process.env.TEST_API_ORIGIN||'http://localhost:4000';
const reason='Synthetic invitation mail acceptance';
function call(path,method='GET',body,cookie=''){return new Promise((resolve,reject)=>{
 const req=http.request(origin+'/api'+path,{method,headers:{'content-type':'application/json',cookie}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks)),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]})}catch{reject(Error('Expected JSON response'))}});});
 req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Private mail check timed out')));if(body)req.write(JSON.stringify(body));req.end();
});}
after(async()=>{await pool.end();await platformPool?.end();});
async function fixture(fn){
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL});await admin.connect();
 const ids=[],tenants=[],users=[],senders=[];
 const originalTransport=(await admin.query('SELECT * FROM platform_mail_transport WHERE id=true')).rows[0];
 const originalTemplate=(await admin.query("SELECT * FROM platform_mail_templates WHERE key='owner_invitation'")).rows[0];
 async function account(role='owner'){
  const id=randomUUID(),email=id+'@example.test',password='Synthetic-'+randomBytes(12).toString('hex');ids.push(id);
  await admin.query('INSERT INTO platform_accounts(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[id,email,'Synthetic '+role,await hashPassword(password),role]);
  const login=await call('/sa/login','POST',{email,password});assert.equal(login.status,200);
  const setup=await call('/sa/mfa/setup','POST',{challenge:login.data.challenge});assert.equal(setup.status,200);
  const done=await call('/sa/mfa','POST',{challenge:login.data.challenge,code:totp(setup.data.secret,Math.floor(Date.now()/30000))});assert.equal(done.status,200);
  return {id,cookie:done.cookie};
 }
 async function provision(actor){
  const input={request_id:randomUUID(),name:'Synthetic email workspace',slug:'mail-'+randomBytes(6).toString('hex'),owner_email:randomUUID()+'@example.test',currency:'USD',currencies:['USD','INR'],timezone:'Asia/Kolkata',reason};
  const response=await call('/sa/workspaces','POST',input,actor.cookie);assert.equal(response.status,201);tenants.push(response.data.id);return {...response.data,input};
 }
 async function sender(){const c=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL});await c.connect();await c.query('SET ROLE drykraft_mail');senders.push(c);return c;}
 async function configure(){
  // A private injected transport tests persistence and worker behavior. No public SMTP provider is contacted.
  const secret={email:'no-reply@example.test',from_name:'Synthetic DryKraft',host:'smtp.example.test',port:587,user:'fixture',password:'private-synthetic-password'};
  await admin.query('UPDATE platform_mail_transport SET version=version+1,metadata=$1,ciphertext=$2,enabled=true,verified_at=now(),updated_by=NULL WHERE id=true',[{...secret,password:undefined},encryptCredential('platform-mail-transport',secret)]);
 }
 const command=(w,version=w.version)=>({request_id:randomUUID(),invitation_id:w.invitation_id,version,reason});
 async function emailCommand(w,actor){const transport=(await call('/sa/email/transport','GET',null,actor.cookie)).data,template=(await call('/sa/email/templates/owner_invitation','GET',null,actor.cookie)).data;const review=await call('/sa/workspaces/'+w.id+'/owner-invitation/email-preview','POST',{invitation_id:w.invitation_id,version:w.version,reason},actor.cookie);return {...command(w),template_version:template.version,transport_version:transport.version,preview_hash:review.data.preview_hash||'0'.repeat(64)};}
 const route=(w,action)=>'/sa/workspaces/'+w.id+'/owner-invitation/'+action;
 try{await fn({admin,account,provision,sender,configure,command,emailCommand,route,users});}
 finally{
  for(const c of senders)await c.end();
  try{
   await admin.query('BEGIN');
   await admin.query('UPDATE platform_mail_transport SET version=$1,metadata=$2,ciphertext=$3,enabled=$4,verified_at=$5,updated_by=$6,updated_at=$7 WHERE id=true',[originalTransport.version,originalTransport.metadata,originalTransport.ciphertext,originalTransport.enabled,originalTransport.verified_at,originalTransport.updated_by,originalTransport.updated_at]);
   await admin.query("UPDATE platform_mail_templates SET version=$1,subject=$2,body=$3,updated_by=$4,updated_at=$5 WHERE key='owner_invitation'",[originalTemplate.version,originalTemplate.subject,originalTemplate.body,originalTemplate.updated_by,originalTemplate.updated_at]);
   await admin.query('DELETE FROM platform_mail_jobs WHERE tenant_id=ANY($1::uuid[])',[tenants]);
   await admin.query('DELETE FROM platform_invitation_operations WHERE actor_id=ANY($1::uuid[])',[ids]);
   await admin.query('DELETE FROM platform_mail_template_versions WHERE created_by=ANY($1::uuid[])',[ids]);
   await admin.query('DELETE FROM platform_audit WHERE actor_id=ANY($1::uuid[]) OR resource_id=ANY($2::uuid[])',[ids,tenants]);
   await admin.query('DELETE FROM platform_provisioning_operations WHERE tenant_id=ANY($1::uuid[])',[tenants]);
   await admin.query('DELETE FROM platform_workspace_invitations WHERE tenant_id=ANY($1::uuid[])',[tenants]);
   await admin.query('DELETE FROM platform_workspace_controls WHERE tenant_id=ANY($1::uuid[])',[tenants]);
   await admin.query('DELETE FROM platform_sessions WHERE account_id=ANY($1::uuid[])',[ids]);
   await admin.query('DELETE FROM platform_auth_challenges WHERE account_id=ANY($1::uuid[])',[ids]);
   await admin.query('DELETE FROM platform_accounts WHERE id=ANY($1::uuid[])',[ids]);
   for(const table of ['platform_workspace_entitlements','outbox','audit_events','usage_ledger','workspace_billing','records','pipelines','dashboards','object_definitions','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,[tenants]);
   await admin.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[tenants]);await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.query('COMMIT');
  }catch(e){await admin.query('ROLLBACK');throw e;}finally{await admin.end();}
 }
}
test('owner invitation renewal/revocation serialize, invalidate links and replay without secret disclosure',()=>fixture(async({admin,account,provision,command,route})=>{
 const owner=await account(),other=await account('admin'),support=await account('support'),w=await provision(owner),original=w.invitation_token;
 assert.equal((await call('/auth/platform-invitations/preview','POST',{token:original})).status,200);
 assert.equal((await call(route(w,'renew'),'POST',command(w),support.cookie)).status,403);
 const body=command(w),renewed=await call(route(w,'renew'),'POST',body,other.cookie);assert.equal(renewed.status,200);assert.equal(renewed.data.version,2);assert.ok(!JSON.stringify(renewed.data).includes('invitation_token'));
 assert.equal((await call('/auth/platform-invitations/preview','POST',{token:original})).status,410);
 const replay=await call(route(w,'renew'),'POST',body,other.cookie);assert.equal(replay.data.reused,true);assert.equal(replay.data.version,2);
 assert.equal((await call(route(w,'renew'),'POST',{...body,reason:reason+' changed'},other.cookie)).status,409);
 const recovered=await call('/sa/workspaces/provisioning/'+w.input.request_id,'GET',null,owner.cookie);assert.equal(recovered.status,200);assert.equal(recovered.data.invitation_token,null,'Prior issuer cannot recover another administrator’s replacement token');
 const reveal={invitation_id:w.invitation_id,version:2,reason};
 assert.equal((await call(route(w,'link'),'POST',reveal,owner.cookie)).status,403);
 const fresh=await call(route(w,'link'),'POST',reveal,other.cookie);assert.equal(fresh.status,200);assert.notEqual(fresh.data.invitation_token,original);
 const stale=command(w,2);const races=await Promise.all([call(route(w,'renew'),'POST',stale,other.cookie),call(route(w,'revoke'),'POST',{...stale,request_id:randomUUID()},other.cookie)]);assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
 assert.equal((await call('/auth/platform-invitations/preview','POST',{token:fresh.data.invitation_token})).status,410);
 const current=(await call('/sa/workspaces/'+w.id+'/owner-invitation','GET',null,other.cookie)).data;
 if(!current.revoked_at){const revoked=await call(route(w,'revoke'),'POST',command(w,current.version),other.cookie);assert.equal(revoked.status,200);}
 const state=(await call('/sa/workspaces/'+w.id+'/owner-invitation','GET',null,other.cookie)).data;assert.ok(state.revoked_at);assert.equal(state.can_access_link,false);assert.equal(state.can_renew,true);
 const audit=(await admin.query("SELECT data FROM platform_audit WHERE resource_id=$1 AND action='platform.workspace.invitation.renew'",[w.id])).rows;assert.ok(audit.length);assert.ok(!JSON.stringify(audit).includes(original));
}));
test('accepted ownership and suspended workspaces prevent renewal; revoked tokens cannot create accounts',()=>fixture(async({admin,account,provision,command,route,users})=>{
 const owner=await account(),w=await provision(owner),user=randomUUID(),password='Synthetic-customer-password';users.push(user);
 await admin.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[user,w.owner_email,'Synthetic recipient',await hashPassword(password)]);
 const accept=await call('/auth/platform-invitations/accept','POST',{token:w.invitation_token,password,mode:'login'});assert.equal(accept.status,200);
 for(const action of ['renew','revoke'])assert.equal((await call(route(w,action),'POST',command(w),owner.cookie)).status,409);
 const second=await provision(owner);await admin.query('INSERT INTO platform_workspace_controls(tenant_id,suspended) VALUES($1,true)',[second.id]);
 assert.equal((await call(route(second,'renew'),'POST',command(second),owner.cookie)).status,409);
 assert.equal((await call(route(second,'revoke'),'POST',command(second),owner.cookie)).status,200);
 const declined=await call('/auth/platform-invitations/accept','POST',{token:second.invitation_token,password:'Synthetic-new-user-password',name:'Synthetic unused recipient',mode:'signup'});assert.equal(declined.status,410);
 assert.equal((await admin.query('SELECT id FROM users WHERE email=$1',[second.owner_email])).rowCount,0);
}));
test('platform mail templates validate placeholders, pin immutable versions and protect SMTP secrets and role boundaries',()=>fixture(async({account,admin,provision,configure,command,emailCommand,route,sender})=>{
 const owner=await account(),support=await account('support');const template=(await call('/sa/email/templates/owner_invitation','GET',null,support.cookie)).data;
 const content={subject:'Invitation for {{workspace_name}}',body:'Join {{product_name}} using this link:\n{{invite_url}}\nHelp: {{support_email}}'};
 const preview=await call('/sa/email/templates/owner_invitation/preview','POST',content,support.cookie);assert.equal(preview.status,200);assert.match(preview.data.text,/sample-invitation/);
 for(const body of [content.body.replace('{{invite_url}}','missing'),content.body+' {{unknown}}',content.body+' {{unfinished'])assert.equal((await call('/sa/email/templates/owner_invitation/preview','POST',{...content,body},owner.cookie)).status,400);
 assert.equal((await call('/sa/email/templates/owner_invitation','PUT',{...content,version:template.version,reason},support.cookie)).status,403);
 const saved=await call('/sa/email/templates/owner_invitation','PUT',{...content,version:template.version,reason},owner.cookie);assert.equal(saved.status,200);assert.equal(saved.data.version,template.version+1);
 assert.equal((await call('/sa/email/templates/owner_invitation','PUT',{...content,version:template.version,reason},owner.cookie)).status,409);
 await configure();const transport=await call('/sa/email/transport','GET',null,owner.cookie);assert.equal(transport.status,200);assert.equal(transport.data.has_credentials,true);assert.ok(!JSON.stringify(transport.data).includes('private-synthetic-password'));
 assert.equal((await call('/sa/email/transport','GET',null,support.cookie)).status,403);
 const connection={version:transport.data.version,reason,enabled:false,email:'sender@example.test',from_name:'Synthetic sender',host:'smtp.example.test',port:587,user:'fixture'};
 assert.equal((await call('/sa/email/transport','PUT',connection,support.cookie)).status,403);
 const disabled=await call('/sa/email/transport','PUT',connection,owner.cookie);assert.equal(disabled.status,200);assert.equal(disabled.data.enabled,false);
 assert.equal((await call('/sa/email/transport','PUT',connection,owner.cookie)).status,409);
 await configure();const w=await provision(owner),queued=await call(route(w,'email'),'POST',await emailCommand(w,owner),owner.cookie);assert.equal(queued.status,202);
 const row=(await admin.query('SELECT * FROM platform_mail_jobs WHERE id=$1',[queued.data.mail_id])).rows[0];assert.equal(row.template_version,saved.data.version);assert.ok(!row.payload_ciphertext.includes(w.invitation_token));
 const payload=decryptCredential('platform-mail:'+row.id,row.payload_ciphertext);assert.match(payload.text,new RegExp(w.invitation_token));assert.match(payload.subject,/Synthetic email workspace/);
 await call('/sa/email/templates/owner_invitation','PUT',{...content,subject:'Replacement invitation subject',version:saved.data.version,reason},owner.cookie);
 assert.equal(decryptCredential('platform-mail:'+row.id,(await admin.query('SELECT payload_ciphertext FROM platform_mail_jobs WHERE id=$1',[row.id])).rows[0].payload_ciphertext).subject,payload.subject);
 for(const sql of ['UPDATE platform_mail_template_versions SET subject=subject','DELETE FROM platform_mail_template_versions','UPDATE platform_mail_jobs SET state=state'])await assert.rejects(platformPool.query(sql),e=>e.code==='42501');
 for(const table of ['platform_mail_transport','platform_mail_jobs','platform_mail_templates','platform_mail_template_versions','platform_invitation_operations']){
  await assert.rejects(pool.query('SELECT * FROM '+table),e=>e.code==='42501');const flags=(await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0];assert.ok(flags.relrowsecurity&&flags.relforcerowsecurity);
 }
 const restricted=await sender();await validateMailDatabase(restricted);for(const sql of ['SELECT * FROM records','SELECT password_hash FROM users','SELECT * FROM platform_mail_jobs','SELECT * FROM platform_accounts','SELECT * FROM credentials'])await assert.rejects(restricted.query(sql),e=>e.code==='42501');
 await assert.rejects(platformPool.query('SELECT claim_platform_mail($1)',[randomUUID()]),e=>e.code==='42501');await assert.rejects(validateMailDatabase(admin),/dedicated restricted/);
}));
test('mail queue retries commit once, worker claims once and ambiguous acceptance is never resent',()=>fixture(async({account,admin,provision,configure,command,emailCommand,route,sender})=>{
 const owner=await account(),w=await provision(owner);assert.equal((await call(route(w,'email'),'POST',await emailCommand(w,owner),owner.cookie)).status,409);await configure();
 const body=await emailCommand(w,owner),results=await Promise.all([call(route(w,'email'),'POST',body,owner.cookie),call(route(w,'email'),'POST',body,owner.cookie)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,202]);assert.equal(results[0].data.mail_id,results[1].data.mail_id);
 assert.equal((await call(route(w,'email'),'POST',await emailCommand(w,owner),owner.cookie)).status,409);
 const one=await sender(),two=await sender();let deliveries=0;
 const acceptedTransport=async()=>({async sendMail(message){deliveries++;assert.equal(message.disableFileAccess,true);assert.equal(message.to,w.owner_email);return {accepted:[message.to]};},close(){}});
 const processed=await Promise.all([processPlatformMail(one,acceptedTransport),processPlatformMail(two,acceptedTransport)]);assert.equal(processed.filter(Boolean).length,1);assert.equal(deliveries,1);
 assert.equal((await admin.query('SELECT state FROM platform_mail_jobs WHERE tenant_id=$1',[w.id])).rows[0].state,'accepted');
 const history=await call('/sa/email/deliveries?workspace_id='+w.id,'GET',null,owner.cookie);assert.equal(history.status,200);assert.equal(history.data.items[0].state,'accepted');assert.ok(!JSON.stringify(history.data).includes(w.invitation_token));
 const second=await provision(owner);await call(route(second,'email'),'POST',await emailCommand(second,owner),owner.cookie);
 const unknown=await processPlatformMail(one,async()=>({async sendMail(){deliveries++;throw Object.assign(Error('Private provider response'),{code:'ETIMEDOUT',command:'DATA'});},close(){}}));assert.equal(unknown.state,'unknown');assert.equal(await processPlatformMail(one,acceptedTransport),null);assert.equal(deliveries,2);
 assert.equal((await admin.query('SELECT error_code FROM platform_mail_jobs WHERE id=$1',[unknown.id])).rows[0].error_code,'smtp_outcome_unknown');
 assert.ok((await admin.query("SELECT 1 FROM platform_audit WHERE resource_id=$1 AND action='platform.mail.unknown'",[second.id])).rowCount);
}));
test('revoked or expired invitation, changed transport or issuer rights cancel queued mail; stale leases cannot overwrite results',()=>fixture(async({admin,account,provision,configure,command,emailCommand,route,sender})=>{
 const owner=await account();await configure();const c=await sender();let sends=0;const transport=async()=>({async sendMail(m){sends++;return {accepted:[m.to]};},close(){}});
 const cancelled=await provision(owner);const queued=await call(route(cancelled,'email'),'POST',await emailCommand(cancelled,owner),owner.cookie);await call(route(cancelled,'revoke'),'POST',command(cancelled),owner.cookie);assert.equal(await processPlatformMail(c,transport),null);assert.equal((await admin.query('SELECT state FROM platform_mail_jobs WHERE id=$1',[queued.data.mail_id])).rows[0].state,'cancelled');
 const expired=await provision(owner);await call(route(expired,'email'),'POST',await emailCommand(expired,owner),owner.cookie);await admin.query("UPDATE platform_workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.invitation_id]);assert.equal(await processPlatformMail(c,transport),null);
 const changed=await provision(owner);await call(route(changed,'email'),'POST',await emailCommand(changed,owner),owner.cookie);await configure();assert.equal(await processPlatformMail(c,transport),null);assert.equal((await admin.query('SELECT error_code FROM platform_mail_jobs WHERE tenant_id=$1',[changed.id])).rows[0].error_code,'transport_changed');
 const leased=await provision(owner);await call(route(leased,'email'),'POST',await emailCommand(leased,owner),owner.cookie);const lease=randomUUID(),job=(await c.query('SELECT claim_platform_mail($1) AS job',[lease])).rows[0].job;assert.ok(job);
 assert.equal((await c.query("SELECT finish_platform_mail($1,$2,'accepted',NULL) AS finished",[job.id,randomUUID()])).rows[0].finished,false);
 await admin.query("UPDATE platform_mail_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[job.id]);assert.equal(await processPlatformMail(c,transport),null);
 assert.equal((await admin.query('SELECT state,error_code FROM platform_mail_jobs WHERE id=$1',[job.id])).rows[0].state,'unknown');assert.equal((await c.query("SELECT finish_platform_mail($1,$2,'accepted',NULL) AS finished",[job.id,lease])).rows[0].finished,false);
 const retired=await provision(owner);await call(route(retired,'email'),'POST',await emailCommand(retired,owner),owner.cookie);await admin.query("UPDATE platform_accounts SET role='viewer',auth_version=auth_version+1 WHERE id=$1",[owner.id]);assert.equal(await processPlatformMail(c,transport),null);assert.equal(sends,0);
}));
test('reviewed invitation content cannot be queued after recipient context, template or transport changes',()=>fixture(async({admin,account,provision,configure,emailCommand,route})=>{
 const owner=await account();await configure();const w=await provision(owner);
 const reviewed=await emailCommand(w,owner);await admin.query('UPDATE workspaces SET name=$1 WHERE id=$2',['Changed synthetic workspace',w.id]);
 const changed=await call(route(w,'email'),'POST',reviewed,owner.cookie);assert.equal(changed.status,409);assert.match(changed.data.error.message,/content changed/i);
 assert.equal((await admin.query('SELECT id FROM platform_mail_jobs WHERE tenant_id=$1',[w.id])).rowCount,0);
 const fresh=await emailCommand(w,owner);const template=(await call('/sa/email/templates/owner_invitation','GET',null,owner.cookie)).data;assert.equal((await call('/sa/email/templates/owner_invitation','PUT',{subject:template.subject,body:template.body+'\nUpdated synthetic wording.',version:template.version,reason},owner.cookie)).status,200);
 assert.equal((await call(route(w,'email'),'POST',fresh,owner.cookie)).status,409);
 const newest=await emailCommand(w,owner);await configure();assert.equal((await call(route(w,'email'),'POST',newest,owner.cookie)).status,409);
 const ready=await emailCommand(w,owner);assert.equal((await call(route(w,'email'),'POST',ready,owner.cookie)).status,202);
}));
test('SMTP outcome classification distinguishes explicit rejection from uncertain DATA/network outcomes',()=>{
 assert.deepEqual(mailFailure({responseCode:550}),{state:'failed',code:'smtp_rejected'});
 assert.equal(mailFailure({code:'EAUTH'}).state,'failed');assert.equal(mailFailure({command:'RCPT TO'}).state,'failed');
 assert.equal(mailFailure({code:'ECONNECTION',command:'DATA'}).state,'unknown');assert.equal(mailFailure({}).state,'unknown');
});
