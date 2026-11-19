// Shared by the campaign preview and every email provider. Message text and
// CRM values are always escaped; users do not need to write HTML.
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const linkStyle='color:#2563eb;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;';
function webUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
function inline(value){
 const source=String(value),pattern=/https?:\/\/[^\s<>"']+/gu;let rendered='',cursor=0;
 for(const match of source.matchAll(pattern)){
  const raw=match[0],suffix=raw.match(/[.,!?;:)\]}]+$/)?.[0]||'',label=suffix?raw.slice(0,-suffix.length):raw,url=webUrl(label);
  rendered+=escape(source.slice(cursor,match.index))+(url?`<a href="${escape(url)}" style="${linkStyle}">${escape(label)}</a>`:escape(label))+escape(suffix);cursor=match.index+raw.length;
 }
 return rendered+escape(source.slice(cursor));
}
function messageHtml(body){
 return String(body).replace(/\r\n?/g,'\n').trim().split(/\n[\t ]*\n+/).filter(Boolean).map(block=>{
  const lines=block.split('\n'),items=lines.map(line=>line.match(/^\s*[-*•]\s+(.+)$/));
  if(items.every(Boolean))return `<ul style="margin:0 0 22px;padding-left:22px;">${items.map(item=>`<li style="margin:0 0 8px;">${inline(item[1])}</li>`).join('')}</ul>`;
  return `<p style="margin:0 0 22px;">${lines.map(inline).join('<br>')}</p>`;
 }).join('');
}
export function campaignEmail({subject='',body='',senderName='',senderEmail='',unsubscribeUrl=''}){
 const brand=String(senderName||senderEmail||'Your team'),unsubscribe=webUrl(unsubscribeUrl),preview=String(body).replace(/\s+/g,' ').trim().slice(0,160);
 const footer=unsubscribe?`<p style="margin:14px 0 0;font-size:12px;line-height:20px;"><a href="${escape(unsubscribe)}" style="color:#64748b;text-decoration:underline;">Unsubscribe from these emails</a></p>`:'';
 const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title><style>@media only screen and (max-width:600px){.email-outer{padding:16px 8px!important}.email-content{padding:26px 22px!important}.email-title{font-size:24px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f3f5f8;color:#334155;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;font-size:1px;line-height:1px;color:#f3f5f8;max-height:0;max-width:0;overflow:hidden;mso-hide:all;">${escape(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f5f8;"><tr><td class="email-outer" align="center" style="padding:36px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:10px;">
<tr><td class="email-content" style="padding:28px 36px;border-top:4px solid #2563eb;border-bottom:1px solid #e2e8f0;font-size:15px;line-height:24px;font-weight:bold;color:#0f172a;overflow-wrap:anywhere;">${escape(brand)}</td></tr>
<tr><td class="email-content" style="padding:36px;font-size:16px;line-height:28px;overflow-wrap:anywhere;word-break:break-word;">
<h1 class="email-title" style="margin:0 0 26px;font-size:28px;line-height:1.3;font-weight:bold;color:#0f172a;">${escape(subject)}</h1>
${messageHtml(body)}
</td></tr>
<tr><td class="email-content" style="padding:24px 36px;background-color:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:20px;color:#64748b;overflow-wrap:anywhere;">
<p style="margin:0;">${escape(brand)}${senderEmail?`<br>${escape(senderEmail)}`:''}</p>${footer}
</td></tr>
</table></td></tr></table></body></html>`;
 return {html,text:String(body)+(unsubscribe?'\n\nUnsubscribe: '+unsubscribe:'')};
}
