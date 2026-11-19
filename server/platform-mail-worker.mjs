import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {mkdir,lstat,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {decryptCredential} from './automation.mjs';
import {smtpTransport} from './outreach-providers.mjs';

// This role can only claim and finish platform mail; it cannot read customer or platform tables.
export async function validateMailDatabase(database){
 const role=(await database.query(`SELECT r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,
 EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS member,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND
 (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS table_access,
 has_function_privilege(current_user,'claim_platform_mail(uuid)','EXECUTE') AS claim,
 has_function_privilege(current_user,'finish_platform_mail(uuid,uuid,text,text)','EXECUTE') AS finish
 FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
 if(!role||role.rolname!=='drykraft_mail'||role.rolsuper||role.rolinherit||role.rolcreaterole||role.rolcreatedb||role.rolbypassrls||role.member||role.table_access||!role.claim||!role.finish)throw Error('Platform mail requires its dedicated restricted database role.');
}
export function mailFailure(error){
 if(Number(error?.responseCode)>=400&&Number(error?.responseCode)<600)return {state:'failed',code:'smtp_rejected'};
 if(['EAUTH','EENVELOPE','ESECURITY'].includes(error?.code))return {state:'failed',code:error.code==='EAUTH'?'smtp_authentication':'smtp_recipient_rejected'};
 if(['CONN','EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(error?.command))return {state:'failed',code:'smtp_connection_failed'};
 return {state:'unknown',code:'smtp_outcome_unknown'};
}
async function previewTransport(){
 const sink=process.env.PLATFORM_MAIL_PREVIEW_SINK;
 if(process.env.NODE_ENV!=='test'||!isAbsolute(sink||''))throw Error('Mail preview requires an absolute private test directory.');
 await mkdir(sink,{recursive:true,mode:0o700});const stat=await lstat(sink);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw Error('Mail preview directory must be private and owned by the test process.');
 return {async sendMail(message){
  const id=message.messageId?.match(/^<([a-f0-9-]{36})@[^>]+>$/)?.[1];if(!id)throw Error('Invalid preview message identifier.');
  await writeFile(resolve(sink,id+'.json'),JSON.stringify({preview:true,...message},null,2)+'\n',{mode:0o600,flag:'wx'});
  return {accepted:[message.to]};
 },close(){}};
}
export async function processPlatformMail(database,createTransport=smtpTransport){
 const lease=randomUUID(),job=(await database.query('SELECT claim_platform_mail($1) AS job',[lease])).rows[0].job;if(!job)return null;
 let outcome,transport,message,settings;
 try{message=decryptCredential('platform-mail:'+job.id,job.payload_ciphertext);settings=decryptCredential('platform-mail-transport',job.transport_ciphertext);}
 catch{outcome={state:'failed',code:'invalid_saved_message'};}
 if(!outcome){
  try{transport=process.env.PLATFORM_MAIL_PREVIEW_SINK?await previewTransport():await createTransport(settings);}
  catch{outcome={state:'failed',code:'smtp_configuration'};}
 }
 if(!outcome){
  try{
   const result=await transport.sendMail({to:message.to,from:message.from,replyTo:message.replyTo,subject:message.subject,text:message.text,html:message.html,messageId:message.messageId,disableFileAccess:true,disableUrlAccess:true});
   const accepted=result.accepted?.some(address=>String(address).toLowerCase()===message.to.toLowerCase());
   outcome=accepted?{state:'accepted',code:null}:result.rejected?.some(address=>String(address).toLowerCase()===message.to.toLowerCase())?{state:'failed',code:'smtp_recipient_rejected'}:{state:'unknown',code:'smtp_outcome_unknown'};
  }catch(error){outcome=mailFailure(error);}finally{transport?.close();}
 }
 // Completion failures leave the lease to expire to unknown. Never submit the message again.
 const finished=(await database.query('SELECT finish_platform_mail($1,$2,$3,$4) AS finished',[job.id,lease,outcome.state,outcome.code])).rows[0].finished;
 return {id:job.id,state:outcome.state,recorded:finished};
}
async function main(){
 if(!process.env.MAIL_DATABASE_URL)throw Error('MAIL_DATABASE_URL is required for platform mail.');
 if(process.env.PLATFORM_MAIL_PREVIEW_SINK&&process.env.NODE_ENV!=='test')throw Error('Platform mail preview is forbidden outside test mode.');
 const database=new pg.Pool({connectionString:process.env.MAIL_DATABASE_URL,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
 database.on('error',()=>console.error('Platform mail database connection failed.'));
 let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;});
 try{
  await validateMailDatabase(database);console.log('DryKraft platform mail ready');
  while(!stopping){
   try{const result=await processPlatformMail(database);if(result){console.log(JSON.stringify({mail_id:result.id,state:result.state,recorded:result.recorded}));continue;}}
   catch{console.error('Platform mail processing failed; unresolved leases will be marked unknown.');}
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
 }finally{await database.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Platform mail startup failed. Check the private database role and test-mode configuration.');process.exitCode=1;});
