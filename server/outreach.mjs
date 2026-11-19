import { z } from 'zod';
import { randomUUID,randomBytes } from 'node:crypto';
import { tenantTransaction,event } from './db.mjs';
import { AppError,getDefinition } from './model.mjs';
import { filterSql,validateFilter } from './record-lists.mjs';
import { encryptCredential,decryptCredential,interpolate,createExecution,validateGraph } from './automation.mjs';
import { tokenHash } from './auth.mjs';
import { requireBillingAccess } from './billing.mjs';
import { warmupState } from './email-warmup.mjs';
import { normalizeRecipient,oauthTokens,sendProvider,outreachLlmText,whatsappRequest } from './outreach-providers.mjs';
import {workflowTransactionContext,requireWorkflowResource,requireWorkflowObject} from './workflow-access.mjs';

export const channels=['email','sms','voice','whatsapp'];
export async function applyWhatsAppReceipt(client,connectionId,providerId){
 const r=(await client.query('SELECT status FROM outreach_receipts WHERE connection_id=$1 AND provider_id=$2',[connectionId,providerId])).rows[0];if(!r)return;
 await client.query(`UPDATE outreach_deliveries SET status=$1,updated_at=now(),error=CASE WHEN $1='failed' THEN 'WhatsApp reported delivery failure.' ELSE error END WHERE connection_id=$2 AND provider_id=$3 AND (status IN ('sending','accepted','unknown') OR (status='delivered' AND $1='read') OR (status='failed' AND $1 IN ('delivered','read')))`,[r.status,connectionId,providerId]);
}
export async function aiReplyWorkflow(client,tenantId,connection){
 if(connection.config.aiWorkflowId)return connection.config.aiWorkflowId;
 const id=randomUUID(),versionId=randomUUID(),graph={nodes:[{id:'trigger',type:'workflow',position:{x:0,y:0},data:{kind:'trigger.manual',label:'WhatsApp received'}},{id:'reply',type:'workflow',position:{x:300,y:0},data:{kind:'outreach.reply',label:'QCall AI reply',connectionId:connection.id}}],edges:[{id:'reply-path',source:'trigger',target:'reply'}]};
 await client.query('INSERT INTO workflows(tenant_id,id,name,draft,status,published_version_id) VALUES($1,$2,$3,$4,\'active\',$5)',[tenantId,id,'WhatsApp AI - '+connection.name,graph,versionId]);await client.query('INSERT INTO workflow_versions(tenant_id,id,workflow_id,version,graph) VALUES($1,$2,$3,1,$4)',[tenantId,versionId,id,graph]);return id;
}
export const stepSchema=z.object({waitHours:z.number().int().min(0).max(720).default(0),subject:z.string().max(300).default(''),body:z.string().max(10000).default(''),variables:z.record(z.string().regex(/^[a-zA-Z0-9_]{1,40}$/),z.string().max(1000)).default({}),template:z.string().max(100).default(''),language:z.string().max(20).default('en'),parameters:z.array(z.string().max(1000)).max(20).default([]),assistantId:z.string().max(100).default(''),dialerId:z.string().max(100).default('')});
function stepProblem(channel,s){if(channel==='email'&&(!s.subject.trim()||!s.body.trim()))return 'Email steps need a subject and message.';if(channel==='sms'&&!s.body.trim()&&!Object.keys(s.variables).length)return 'SMS steps need a message or template variables.';if(channel==='voice'&&(!s.assistantId||!s.dialerId))return 'Choose a QCall assistant and dialer.';if(channel==='whatsapp'&&(!s.template||!s.language))return 'Choose an approved WhatsApp template and language.';}
export const campaignSchema=z.object({name:z.string().trim().min(1).max(100),kind:z.enum(['campaign','sequence']),channel:z.enum(channels),object_key:z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).default('people'),list_id:z.string().uuid().nullable().default(null),connection_id:z.string().uuid(),steps:z.array(stepSchema).min(1).max(20)}).superRefine((v,c)=>{
 if(v.kind==='campaign'&&v.steps.length!==1)c.addIssue({code:'custom',message:'Campaigns send once. Use a sequence for multiple steps.'});
 for(const s of v.steps){const message=stepProblem(v.channel,s);if(message)c.addIssue({code:'custom',message});}
});
export function campaignGraph(campaign){
 const nodes=[{id:'trigger',type:'workflow',position:{x:100,y:100},data:{kind:'trigger.manual',label:campaign.name}}],edges=[];
 for(const [index,step]of campaign.steps.entries()){
  if(step.waitHours){const id='wait-'+index;edges.push({id:'to-'+id,source:nodes.at(-1).id,target:id});nodes.push({id,type:'workflow',position:{x:100+(nodes.length*300),y:100},data:{kind:'wait',label:`Wait ${step.waitHours} hours`,seconds:step.waitHours*3600}});}
  const id='send-'+index;edges.push({id:'to-'+id,source:nodes.at(-1).id,target:id});nodes.push({id,type:'workflow',position:{x:100+(nodes.length*300),y:100},data:{kind:'outreach.send',label:`${campaign.channel} step ${index+1}`,connectionId:campaign.connection_id,campaignId:campaign.id,...step}});
 }
 return validateGraph({nodes,edges});
}
export async function audience(client,campaign){
 const definition=await getDefinition(client,campaign.object_key),params=[campaign.object_key],where=['object_key=$1','merged_into IS NULL'];
 if(['invoices','expenses'].includes(definition.key))throw new AppError(400,'Choose a CRM contact object for outreach.');
 if(campaign.list_id){const list=(await client.query('SELECT filter FROM record_lists WHERE id=$1 AND object_key=$2',[campaign.list_id,definition.key])).rows[0];if(!list)throw new AppError(404,'This audience list is unavailable. Choose another list.');where.push(filterSql(definition,validateFilter(definition,list.filter),params));}
 const records=(await client.query(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY id LIMIT 501 FOR KEY SHARE`,params)).rows;
 if(records.length>500)throw new AppError(400,'This audience exceeds 500 contacts. Use a narrower smart list.');
 const suppressed=new Set((await client.query('SELECT recipient FROM outreach_suppressions WHERE channel=$1',[campaign.channel])).rows.map(v=>v.recipient));
 const seen=new Set(),eligible=[],skipped=[];
 for(const r of records){let recipient,reason;if(r.data.consent!==true)reason='Marketing consent missing';else try{recipient=normalizeRecipient(campaign.channel,campaign.channel==='email'?r.data.email:r.data.phone);}catch{reason='Email or international phone missing';}
  if(!reason&&suppressed.has(recipient))reason='Unsubscribed or suppressed';if(!reason&&seen.has(recipient))reason='Duplicate contact address';
  if(reason)skipped.push({id:r.id,name:r.data.name||'Contact',reason});else{seen.add(recipient);eligible.push({record:r,recipient});}
 }
 return {eligible,skipped,total:records.length};
}
export async function stopRecipient(client,tenantId,channel,recipient,reason,suppress=false){
 if(suppress)await client.query('INSERT INTO outreach_suppressions(tenant_id,channel,recipient,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenantId,channel,recipient,reason]);
 const rows=(await client.query(`UPDATE outreach_enrollments e SET status=$1 FROM outreach_campaigns c WHERE e.campaign_id=c.id AND e.tenant_id=c.tenant_id AND c.channel=$2 AND e.recipient=$3 AND e.status='active' RETURNING e.execution_id`,[suppress?'unsubscribed':'replied',channel,recipient])).rows;
 for(const r of rows)await client.query("UPDATE executions SET state='cancelled',completed_at=now() WHERE id=$1 AND state IN ('queued','running','waiting','retrying')",[r.execution_id]);
}
export async function outreachExecutionGate(client,id){
 const e=(await client.query('SELECT c.status,e.status AS contact_status FROM outreach_enrollments e JOIN outreach_campaigns c ON c.id=e.campaign_id AND c.tenant_id=e.tenant_id WHERE e.execution_id=$1',[id])).rows[0];
 if(!e)return true;
 if(e.status==='paused'){await client.query("UPDATE executions SET state='waiting',resume_at=now()+interval '1 minute',dispatch_id=gen_random_uuid() WHERE id=$1 AND state<>'cancelled'",[id]);return false;}
 if(e.status!=='active'||e.contact_status!=='active'){await client.query("UPDATE executions SET state='cancelled',completed_at=now() WHERE id=$1",[id]);return false;}return true;
}
export async function launchCampaign(client,tenantId,actorId,campaign,previewVersion,reviewedAudience){
 if(campaign.version!==previewVersion)throw new AppError(409,'The campaign changed. Review its audience again.');
 if(campaign.status!=='draft')throw new AppError(409,'This campaign has already launched. Resume it from its status controls.');
 const connection=(await client.query('SELECT * FROM outreach_connections WHERE id=$1 AND enabled FOR UPDATE',[campaign.connection_id])).rows[0];
 if(!connection?.verified_at)throw new AppError(400,'Verify the connection before launching.');
 const a=reviewedAudience||await audience(client,campaign);if(!a.eligible.length)throw new AppError(400,'No eligible contacts. Add marketing consent and a valid contact address.');
 const graph=campaignGraph(campaign),versionId=randomUUID();
 await client.query('INSERT INTO workflow_versions(tenant_id,id,workflow_id,version,graph) VALUES($1,$2,$3,1,$4)',[tenantId,versionId,campaign.workflow_id,graph]);
 await client.query("UPDATE workflows SET status='active',published_version_id=$1,draft=$2 WHERE id=$3",[versionId,graph,campaign.workflow_id]);
 for(const v of a.eligible){const token=randomBytes(32).toString('hex'),id=randomUUID(),unsubscribeUrl=`${process.env.APP_ORIGIN||'http://localhost:4000'}/api/outreach/unsubscribe/${token}`;
  const execution=await createExecution(client,tenantId,{id:campaign.workflow_id},{id:versionId,graph},{record:v.record,campaignId:campaign.id,enrollmentId:id,recipient:v.recipient,unsubscribeUrl});
  await client.query('INSERT INTO outreach_enrollments(tenant_id,id,campaign_id,record_id,execution_id,recipient,unsubscribe_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenantId,id,campaign.id,v.record.id,execution.id,v.recipient,tokenHash(token)]);
 }
 await client.query("UPDATE outreach_campaigns SET status='active',version=version+1,updated_at=now() WHERE id=$1",[campaign.id]);
 await event(client,tenantId,actorId,'outreach.campaign.launched','outreach_campaign',campaign.id,{campaignId:campaign.id,channel:campaign.channel,enrolled:a.eligible.length});return {enrolled:a.eligible.length,skipped:a.skipped.length};
}
export async function connectionSecret(client,tenantId,connection){
 let s=decryptCredential(tenantId,connection.ciphertext);
 if(['google','microsoft'].includes(connection.provider)&&s.expiresAt<Date.now()+60000){s={...s,...await oauthTokens(connection.provider,{grant_type:'refresh_token',refresh_token:s.refreshToken})};await client.query('UPDATE outreach_connections SET ciphertext=$1 WHERE id=$2',[encryptCredential(tenantId,s),connection.id]);}return s;
}
export async function executeOutreach(tenantId,execution,node,context,send=sendProvider){
 let principal;
 const tx=(fn,authorize=true)=>tenantTransaction(tenantId,async c=>{
  if(authorize){principal=await workflowTransactionContext(c,execution.id,node.kind);requireWorkflowResource(principal,'connections',node.connectionId);}
  else await c.query("SELECT set_config('app.service_account_id',$1,true)",[principal.id]);
  return fn(c);
 });
 const prepared=await tx(async c=>{
  await requireBillingAccess(c,tenantId,'outreach');
  const connection=(await c.query('SELECT * FROM outreach_connections WHERE id=$1 AND enabled FOR UPDATE',[node.connectionId])).rows[0];if(!connection?.verified_at)throw new AppError(400,'The outreach connection is disabled or unverified.');
  if(node.kind!=='outreach.reply'){node={...node,...stepSchema.parse(node)};const problem=stepProblem(connection.channel,node);if(problem)throw new AppError(400,problem);}
  const old=(await c.query('SELECT * FROM outreach_deliveries WHERE execution_id=$1 AND node_id=$2',[execution.id,node.id])).rows[0];
  if(old){if(['sending','unknown','failed'].includes(old.status))throw new AppError(409,'Sending could not be confirmed. Check the provider before creating another outreach attempt.');return {existing:{deliveryId:old.id,status:old.status}};}
  let recipient,record,skip;
  if(node.kind==='outreach.reply'){
   const inbound=(await c.query('SELECT * FROM outreach_messages WHERE connection_id=$1 AND provider_id=$2',[connection.id,context.inboundId])).rows[0];
   if(!inbound||inbound.execution_id!==execution.id||inbound.received_at.getTime()<Date.now()-24*3600000||!connection.config.aiEnabled)throw new AppError(400,'This WhatsApp reply is outside the active conversation window or AI replies are disabled.');recipient=normalizeRecipient('whatsapp',inbound.sender);record=inbound;
  }else{
   const enrollment=(await c.query('SELECT * FROM outreach_enrollments WHERE execution_id=$1',[execution.id])).rows[0];
   if(node.campaignId&&!enrollment)throw new AppError(400,'Campaign steps must run through a reviewed audience enrollment.');
   if(enrollment){const campaign=(await c.query('SELECT status FROM outreach_campaigns WHERE id=$1 FOR SHARE',[enrollment.campaign_id])).rows[0];if(campaign?.status!=='active')throw new AppError(409,'The campaign is paused or cancelled.');}
   const recordId=enrollment?.record_id||interpolate(node.recordId||'{{record.id}}',context);z.string().uuid().parse(recordId);
   record=(await c.query('SELECT * FROM records WHERE id=$1 FOR KEY SHARE',[recordId])).rows[0];
   if(record)requireWorkflowObject(c.workflowPrincipal,record.object_key,'read');
   if(!record||record.merged_into||record.data.consent!==true)skip='Contact is missing, merged or marketing consent was removed';
   else recipient=normalizeRecipient(connection.channel,connection.channel==='email'?record.data.email:record.data.phone);
   if(enrollment&&(enrollment.status!=='active'||recipient!==enrollment.recipient))skip='Contact stopped or its address changed';
  }
  if(recipient&&(await c.query('SELECT 1 FROM outreach_suppressions WHERE channel=$1 AND recipient=$2',[connection.channel,recipient])).rowCount)skip='Contact unsubscribed or suppressed';
  const count=(await c.query("SELECT count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS daily,count(*) FILTER(WHERE created_at>now()-interval '1 hour')::int AS hourly FROM outreach_deliveries WHERE connection_id=$1 AND status<>'skipped'",[connection.id])).rows[0];
  const limits=warmupState(connection);
  if(!skip&&(count.daily>=limits.dailyLimit||count.hourly>=limits.hourlyLimit))return {defer:true};
  const secret=await connectionSecret(c,tenantId,connection),id=randomUUID();
  if(node.kind==='outreach.reply')context={...context,reply:await outreachLlmText(connection.config.aiInstructions,record.body)};
  const status=skip?'skipped':'sending';
  await c.query('INSERT INTO outreach_deliveries(tenant_id,id,execution_id,node_id,connection_id,channel,recipient,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[tenantId,id,execution.id,node.id,connection.id,connection.channel,recipient||'',status,skip||null]);
  const workspace=connection.channel==='email'?(await c.query('SELECT name FROM workspaces WHERE id=$1',[tenantId])).rows[0]:undefined;
  return {id,connection,secret,recipient,context:{...context,...(record?.data?{record}:{}),...(workspace?{workspace}:{})},skip};
 });
 if(prepared.defer)return {defer:true};if(prepared.existing)return prepared.existing;if(prepared.skip)return {deliveryId:prepared.id,status:'skipped'};
 // An accepted provider request cannot be recalled. Recheck immediately before sending; always record its outcome afterward.
 try{await tx(async()=>{});}catch(error){if(!error.workflowAccessDenied)throw error;await tx(c=>c.query("UPDATE outreach_deliveries SET status='skipped',error='Workflow access was revoked before sending.',updated_at=now() WHERE id=$1 AND status='sending'",[prepared.id]),false);throw error;}
 try{
  let result;if(node.kind==='outreach.reply'){const r=await whatsappRequest(prepared.secret,`${prepared.secret.phoneId}/messages`,{messaging_product:'whatsapp',to:prepared.recipient.slice(1),type:'text',text:{body:prepared.context.reply}});if(!r.messages?.[0]?.id)throw new AppError(502,'WhatsApp did not confirm reply acceptance.');result={id:r.messages[0].id};}
  else result=await send(prepared.connection,prepared.secret,prepared.recipient,node,prepared.context,prepared.id);
  await tx(async c=>{await c.query("UPDATE outreach_deliveries SET status=CASE WHEN status='sending' THEN 'accepted' ELSE status END,provider_id=$1,detail=$2,updated_at=now() WHERE id=$3",[String(result.id).slice(0,300),{...(result.tagId?{tagId:result.tagId}:{}),...(result.remoteId?{remoteId:result.remoteId}:{})},prepared.id]);if(prepared.connection.channel==='whatsapp')await applyWhatsAppReceipt(c,prepared.connection.id,result.id);await event(c,tenantId,null,'outreach.message.accepted','outreach_delivery',prepared.id,{deliveryId:prepared.id,channel:prepared.connection.channel});},false);
  return {deliveryId:prepared.id,status:'accepted'};
 }catch{
  // A timeout can follow provider acceptance. Never send twice automatically, even on workflow replay.
  await tx(c=>c.query("UPDATE outreach_deliveries SET status='unknown',error='Provider acceptance could not be confirmed. Check the provider before sending again.',updated_at=now() WHERE id=$1 AND status='sending'",[prepared.id]),false);
  throw new AppError(502,'Provider acceptance could not be confirmed. This step will not send again automatically.');
 }
}
