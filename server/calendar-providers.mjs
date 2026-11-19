import {z} from 'zod';
import {safeHttp} from './http-node.mjs';
import {oauth,oauthTokens} from './outreach-providers.mjs';
import {encryptCredential,decryptCredential} from './automation.mjs';
import {tenantTransaction} from './db.mjs';
import {calendarLock,startOfLocalDate} from './calendar.mjs';
import {AppError} from './model.mjs';
import {billingAccess} from './billing.mjs';
import {oauthCallback} from './oauth-callbacks.mjs';

export const calendarScopes={google:'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',microsoft:'offline_access User.Read Calendars.ReadWrite'};
export const calendarRedirect=provider=>oauthCallback(provider,'calendar');
const bases={google:'https://www.googleapis.com/calendar/v3',microsoft:'https://graph.microsoft.com/v1.0'};
const text=z.string().min(1).max(2000);
export async function calendarProfile(provider,secret,request=safeHttp){const url=provider==='google'?'https://openidconnect.googleapis.com/v1/userinfo':'https://graph.microsoft.com/v1.0/me';const body=(await request(url,{headers:{Authorization:`Bearer ${secret.accessToken}`}})).body;return z.email().max(200).parse(body.email||body.mail||body.userPrincipalName);}
async function requestCalendar(connection,secret,path,options={},request=safeHttp){const url=new URL(path.startsWith('https://')?path:bases[connection.provider]+path);if(url.origin!==new URL(bases[connection.provider]).origin||url.username||url.password)throw new AppError(502,'The calendar provider returned an invalid continuation.');return request(url.href,{...options,headers:{Authorization:`Bearer ${secret.accessToken}`,'content-type':'application/json',...(connection.provider==='microsoft'?{Prefer:'outlook.timezone="UTC", IdType="ImmutableId"'}:{}),...options.headers}});}
export async function calendarChoices(connection,secret,request=safeHttp){
 const body=(await requestCalendar(connection,secret,connection.provider==='google'?'/users/me/calendarList?maxResults=250':'/me/calendars?$top=100',{},request)).body;
 if(body.nextPageToken||body['@odata.nextLink'])throw new AppError(502,'This account has too many calendars for the current picker.');
 const rows=connection.provider==='google'?body.items:body.value;if(!Array.isArray(rows))throw new AppError(502,'The provider did not return a calendar list.');
 return rows.filter(v=>connection.provider==='google'?['owner','writer'].includes(v.accessRole):v.canEdit===true).map(v=>({id:text.parse(v.id),name:z.string().max(1000).parse(v.summary||v.name||'Calendar')}));
}
const eventPath=c=>c.provider==='google'?'/calendars/'+encodeURIComponent(c.calendar_id)+'/events':'/me/calendars/'+encodeURIComponent(c.calendar_id)+'/events';
function eventTime(value,provider,zone){if(provider==='google'){if(value?.dateTime)return new Date(value.dateTime);if(value?.date)return startOfLocalDate(value.date,zone);}else if(value?.dateTime&&value.timeZone==='UTC')return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value.dateTime)?value.dateTime:value.dateTime+'Z');return new Date(NaN);}
export async function providerEvents(connection,secret,from,to,request=safeHttp){
 const query=connection.provider==='google'?new URLSearchParams({timeMin:from.toISOString(),timeMax:to.toISOString(),singleEvents:'true',showDeleted:'false',maxResults:'250'}):new URLSearchParams({startDateTime:from.toISOString(),endDateTime:to.toISOString(),'$top':'250'});
 const initial=connection.provider==='google'?eventPath(connection)+'?'+query:'/me/calendars/'+encodeURIComponent(connection.calendar_id)+'/calendarView?'+query;
 let path=initial,rows=[];
 for(let page=0;page<8;page++){
  const body=(await requestCalendar(connection,secret,path,{},request)).body,items=connection.provider==='google'?body.items:body.value;if(!Array.isArray(items))throw new AppError(502,'The calendar provider returned an unsupported event list.');
  for(const v of items){
   const start=eventTime(v.start,connection.provider,body.timeZone),end=eventTime(v.end,connection.provider,body.timeZone);
   if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)throw new AppError(502,'A provider event has an unsupported timezone or time range.');
   const available=connection.provider==='google'?v.status==='cancelled'||v.transparency==='transparent':v.isCancelled||v.showAs==='free';
   rows.push({id:text.parse(v.id),starts_at:start,ends_at:end,busy:!available,marker:connection.provider==='google'?v.extendedProperties?.private?.drykraftExport:v.transactionId,etag:v.etag||v['@odata.etag']||null});
  }
  const next=connection.provider==='google'?body.nextPageToken:body['@odata.nextLink'];if(!next)return rows;
  path=connection.provider==='google'?initial+'&pageToken='+encodeURIComponent(next):next;
 }
 throw new AppError(502,'Calendar sync exceeds 2000 events. Booking stays blocked until the busy range can be verified.');
}
function exportBody(c,a,id){
 const booked=a.state==='booked'&&(!c.user_id||a.host_ids.includes(c.user_id));
 const iso=d=>new Date(d).toISOString(),description='DryKraft appointment. Edit or cancel it in DryKraft.';
 // Export has no attendee list; invitations are not requested by DryKraft.
 return c.provider==='google'?{summary:a.title,description,location:a.location,start:{dateTime:iso(a.starts_at)},end:{dateTime:iso(a.ends_at)},extendedProperties:{private:{drykraftExport:id}},transparency:booked?'opaque':'transparent',reminders:{useDefault:false}}:{subject:a.title,body:{contentType:'text',content:description},location:{displayName:a.location},start:{dateTime:iso(a.starts_at),timeZone:'UTC'},end:{dateTime:iso(a.ends_at),timeZone:'UTC'},showAs:booked?'busy':'free'};
}
export async function exportEvent(c,secret,a,receipt,request=safeHttp){
 const body=exportBody(c,a,receipt.id);let path=eventPath(c),method='POST';
 if(receipt.provider_id){path+='/'+encodeURIComponent(receipt.provider_id);method='PATCH';}
 else if(c.provider==='google')body.id=receipt.id.replaceAll('-','');else body.transactionId=receipt.id;
 if(c.provider==='google')path+='?sendUpdates=none';
 const r=await requestCalendar(c,secret,path,{method,headers:receipt.provider_id&&receipt.remote_etag?{'If-Match':receipt.remote_etag}:{},body:JSON.stringify(body)},request);
 return {id:text.parse(r.body.id),etag:r.body.etag||r.body['@odata.etag']||null};
}
export async function calendarSecret(c,tenant,connection,request=safeHttp){let s=decryptCredential(tenant,connection.ciphertext);if(s.expiresAt<Date.now()+60000){s={...s,...await oauthTokens(connection.provider,{grant_type:'refresh_token',refresh_token:s.refreshToken,scope:calendarScopes[connection.provider]},request)};await c.query('UPDATE calendar_connections SET ciphertext=$1 WHERE id=$2',[encryptCredential(tenant,s),connection.id]);}return s;}
export async function syncCalendarConnection(tenant,id,request=safeHttp){
 let secret,connection,events;
 try{
  const result=await tenantTransaction(tenant,async c=>{
   await calendarLock(c,tenant);connection=(await c.query('SELECT * FROM calendar_connections WHERE id=$1 AND enabled FOR UPDATE',[id])).rows[0];if(!connection)return {skipped:true};
   if(!(await billingAccess(c,tenant)).access)return {skipped:true};secret=await calendarSecret(c,tenant,connection,request);
   const now=new Date(),from=new Date(now.getTime()-31*86400000),to=new Date(now.getTime()+92*86400000);events=await providerEvents(connection,secret,from,to,request);
   const exports=(await c.query('SELECT * FROM calendar_exports WHERE connection_id=$1',[id])).rows;
   const mapped=new Map(exports.map(v=>[v.id,v]));
   const local=(await c.query('SELECT id,starts_at,ends_at,state FROM appointments WHERE id=ANY($1::uuid[])',[exports.map(v=>v.appointment_id)])).rows;const appointments=new Map(local.map(v=>[v.id,v]));
   for(const receipt of exports){const a=appointments.get(receipt.appointment_id);if(receipt.state==='synced'&&receipt.provider_id&&a?.starts_at>=from&&a.ends_at<=to&&!events.some(v=>v.marker===receipt.id||v.id===receipt.provider_id))await c.query("UPDATE calendar_exports SET state='conflict',last_error='The connected event is missing or moved outside the verified range. Restore it in your provider calendar before continuing sync.' WHERE id=$1",[receipt.id]);}
   await c.query('DELETE FROM calendar_busy WHERE connection_id=$1',[id]);
   for(const v of events){const receipt=mapped.get(v.marker)||exports.find(e=>e.provider_id===v.id),a=appointments.get(receipt?.appointment_id),changed=receipt?.remote_etag&&receipt.remote_etag!==v.etag,own=receipt&&!changed&&a?.starts_at.getTime()===v.starts_at.getTime()&&a.ends_at.getTime()===v.ends_at.getTime()?receipt.appointment_id:null;
    if(receipt){
     if(['sending','unknown'].includes(receipt.state))await c.query("UPDATE calendar_exports SET provider_id=$1,remote_etag=$2,state='synced',last_error=NULL WHERE id=$3",[v.id,v.etag,receipt.id]);
     else if(receipt.provider_id&&receipt.remote_etag&&receipt.remote_etag!==v.etag)await c.query("UPDATE calendar_exports SET state='conflict',remote_etag=$2,last_error='This event changed in the connected calendar. Review it before continuing sync.' WHERE id=$1",[receipt.id,v.etag]);
    }
    if(v.busy)await c.query('INSERT INTO calendar_busy(tenant_id,connection_id,remote_id,starts_at,ends_at,appointment_id) VALUES($1,$2,$3,$4,$5,$6)',[tenant,id,v.id,v.starts_at,v.ends_at,own||null]);
   }
   await c.query('UPDATE calendar_connections SET synced_at=clock_timestamp(),range_start=$1,range_end=$2,next_sync_at=now()+interval \'5 minutes\',last_error=NULL WHERE id=$3',[from,to,id]);
   if(connection.export_enabled){
    await c.query(`INSERT INTO calendar_exports(tenant_id,id,connection_id,appointment_id) SELECT $1,gen_random_uuid(),$2,a.id FROM appointments a WHERE $3::uuid=ANY(a.host_ids) AND a.starts_at>=now()-interval '31 days' AND a.starts_at<now()+interval '92 days' AND a.state='booked' ON CONFLICT(tenant_id,connection_id,appointment_id) DO NOTHING`,[tenant,id,connection.user_id]);
    await c.query(`UPDATE calendar_exports e SET state='pending' FROM appointments a WHERE e.appointment_id=a.id AND e.tenant_id=a.tenant_id AND e.connection_id=$1 AND e.state='synced' AND e.synced_version<>a.version`,[id]);
   }
   return {synced:true};
  });if(result.skipped)return result;
  if(connection.export_enabled)for(let i=0;i<20;i++){
   // Commit the request reservation before the external write. An interrupted create is never blindly resent.
   const work=await tenantTransaction(tenant,async c=>{await calendarLock(c,tenant);const current=(await c.query('SELECT * FROM calendar_connections WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!current?.enabled||!current.export_enabled||!(await billingAccess(c,tenant)).access)return null;const receipt=(await c.query("SELECT * FROM calendar_exports WHERE connection_id=$1 AND state='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",[id])).rows[0];if(!receipt)return null;const a=(await c.query('SELECT * FROM appointments WHERE id=$1',[receipt.appointment_id])).rows[0];await c.query("UPDATE calendar_exports SET state='sending',synced_version=$1 WHERE id=$2",[a.version,receipt.id]);return {a,receipt,current};});if(!work)break;
   try{const remote=await exportEvent(work.current,secret,work.a,work.receipt,request);await tenantTransaction(tenant,async c=>{await calendarLock(c,tenant);await c.query("UPDATE calendar_exports SET provider_id=$1,remote_etag=$2,state='synced',last_error=NULL WHERE id=$3 AND state='sending'",[remote.id,remote.etag,work.receipt.id]);});}
   catch{await tenantTransaction(tenant,c=>c.query("UPDATE calendar_exports SET state='unknown',last_error='Provider acceptance is uncertain. Sync can recover a matching event; no new create will be retried automatically.' WHERE id=$1 AND state='sending'",[work.receipt.id]));}
  }
  return {synced:true};
 }catch{await tenantTransaction(tenant,c=>c.query("UPDATE calendar_connections SET last_error='Calendar sync failed. Check account permissions or reconnect; booking is blocked when cached availability expires.',next_sync_at=now()+interval '5 minutes' WHERE id=$1",[id]));throw new AppError(502,'Calendar sync failed. Check permissions or reconnect.');}
}
export async function pollCalendarConnections(discovery,stopping=()=>false){const rows=(await discovery.query('SELECT tenant_id,id FROM calendar_connections WHERE enabled AND next_sync_at<=now() ORDER BY next_sync_at LIMIT 10')).rows;for(const row of rows){if(stopping())break;try{await syncCalendarConnection(row.tenant_id,row.id);}catch{ /* Private provider failures remain in the connection's sanitized status. */ }}}
