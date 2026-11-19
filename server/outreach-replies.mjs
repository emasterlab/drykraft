import { tenantTransaction } from './db.mjs';
import { connectionSecret,stopRecipient } from './outreach.mjs';
import { safeHttp } from './http-node.mjs';
import { imapClient } from './outreach-providers.mjs';
import { AppError } from './model.mjs';
import addressParser from 'nodemailer/lib/addressparser/index.js';

export function matchesReply(header,delivery){return (header.reference.match(/<[^<>\s]+>/g)||[]).includes(delivery.provider_id)&&addressParser(header.sender).some(v=>v.address?.toLowerCase()===delivery.recipient);}

export async function syncMailbox(tenantId,id,force=false){
 return tenantTransaction(tenantId,async c=>{
  const v=(await c.query("SELECT * FROM outreach_connections WHERE id=$1 AND channel='email' AND enabled FOR UPDATE",[id])).rows[0];if(!v)throw new AppError(404,'Active mailbox not found.');
  if(!force&&Number(v.config.replySyncAt||0)>Date.now()-5*60000)return {checked:0};
  const s=await connectionSecret(c,tenantId,v),headers=[];
  // ponytail: inspect the latest 50 messages per sync; add provider change cursors for high-volume mailboxes.
  if(v.provider==='smtp'){
   if(!s.imap)throw new AppError(400,'Add IMAP credentials to detect replies.');const i=await imapClient(s.imap);
   try{await i.connect();const lock=await i.getMailboxLock('INBOX');try{if(i.mailbox.exists)for await(const m of i.fetch(`${Math.max(1,i.mailbox.exists-49)}:*`,{envelope:true})){headers.push({reference:m.envelope?.inReplyTo||'',sender:m.envelope?.from?.[0]?.address||''});}}finally{lock.release();}}finally{await i.logout().catch(()=>{});}
  }else{
   const request=async url=>(await safeHttp(url,{headers:{Authorization:`Bearer ${s.accessToken}`}})).body;
   if(v.provider==='google'){const list=await request('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q='+encodeURIComponent('in:inbox newer_than:7d'));
    for(const m of list.messages||[]){const r=await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(m.id)+'?format=metadata&metadataHeaders=In-Reply-To&metadataHeaders=References&metadataHeaders=From');const h=r.payload?.headers||[];headers.push({reference:h.filter(v=>['in-reply-to','references'].includes(v.name.toLowerCase())).map(v=>v.value).join(' '),sender:h.find(v=>v.name.toLowerCase()==='from')?.value||''});}
   }else{const r=await request('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=50&$select=from,internetMessageHeaders&$orderby=receivedDateTime%20desc');for(const m of r.value||[])headers.push({reference:(m.internetMessageHeaders||[]).filter(v=>['in-reply-to','references'].includes(v.name.toLowerCase())).map(v=>v.value).join(' '),sender:m.from?.emailAddress?.address||''});}
  }
  const deliveries=(await c.query("SELECT id,provider_id,recipient FROM outreach_deliveries WHERE connection_id=$1 AND status IN ('accepted','delivered','read') AND created_at>now()-interval '30 days'",[id])).rows;
  let replies=0;for(const d of deliveries){if(headers.some(h=>matchesReply(h,d))){await stopRecipient(c,tenantId,'email',d.recipient,'reply');await c.query("UPDATE outreach_deliveries SET status='replied',updated_at=now() WHERE id=$1",[d.id]);replies++;}}
  await c.query("UPDATE outreach_connections SET config=config||$1::jsonb,last_error=NULL WHERE id=$2",[{replySyncAt:Date.now()},id]);return {checked:headers.length,replies};
 });
}
export async function pollMailboxReplies(discovery){
 const rows=(await discovery.query("SELECT tenant_id,id FROM outreach_connections WHERE channel='email' AND enabled AND (provider<>'smtp' OR config->>'imap'='true') AND coalesce((config->>'replySyncAt')::bigint,0)<$1 ORDER BY coalesce((config->>'replySyncAt')::bigint,0) LIMIT 10",[Date.now()-5*60000])).rows;
 for(const v of rows)try{await syncMailbox(v.tenant_id,v.id);}catch{await tenantTransaction(v.tenant_id,c=>c.query("UPDATE outreach_connections SET last_error='Reply sync failed. Reconnect or check mailbox access.',config=config||$1::jsonb WHERE id=$2",[{replySyncAt:Date.now()},v.id]));}
}
