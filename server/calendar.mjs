import {z} from 'zod';
import {randomUUID,createHash} from 'node:crypto';
import {tenantTransaction,event} from './db.mjs';
import {AppError,resolveRecord} from './model.mjs';
import {requireBillingAccess,billingAccess} from './billing.mjs';

export const timezone=z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Choose a valid timezone.');
const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const minutes=v=>Number(v.slice(0,2))*60+Number(v.slice(3));
const window=z.object({start:clock,end:clock}).strict().refine(v=>v.start!=='24:00'&&minutes(v.end)>minutes(v.start),'Working hours must end after they start.');
const hours=z.array(window).max(4).refine(v=>v.every((w,i)=>!v.some((other,j)=>j<i&&minutes(w.start)<minutes(other.end)&&minutes(w.end)>minutes(other.start))),'Working hours cannot overlap.');
export const calendarConfig=z.object({
 kind:z.enum(['personal','team','service']),timezone,duration:z.number().int().min(15).max(240).multipleOf(15),
 buffer_before:z.number().int().min(0).max(120),buffer_after:z.number().int().min(0).max(120),notice_minutes:z.number().int().min(0).max(10080),horizon_days:z.number().int().min(1).max(90),
 hosts:z.array(z.string().uuid()).min(1).max(20),assignment:z.enum(['round_robin','all']),
 availability:z.array(z.object({day:z.number().int().min(0).max(6),windows:hours}).strict()).length(7),
 exceptions:z.array(z.object({date:z.iso.date(),windows:hours}).strict()).max(100),location:z.string().trim().max(500),description:z.string().trim().max(2000),reminder_minutes:z.array(z.number().int().min(1).max(10080)).max(3),
}).strict().superRefine((v,c)=>{
 if(new Set(v.hosts).size!==v.hosts.length)c.addIssue({code:'custom',message:'Choose each host once.'});
 if(v.kind==='personal'&&v.hosts.length!==1)c.addIssue({code:'custom',message:'A personal calendar has one host.'});
 if(new Set(v.availability.map(d=>d.day)).size!==7)c.addIssue({code:'custom',message:'Configure each weekday once.'});
 if(new Set(v.exceptions.map(d=>d.date)).size!==v.exceptions.length)c.addIssue({code:'custom',message:'Configure each date override once.'});
 if(new Set(v.reminder_minutes).size!==v.reminder_minutes.length)c.addIssue({code:'custom',message:'Choose each reminder once.'});
});
export const calendarInput=z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(120),config:calendarConfig,enabled:z.boolean(),public_enabled:z.boolean()}).strict();
export const appointmentInput=z.object({id:z.string().uuid(),calendar_id:z.string().uuid(),title:z.string().trim().min(1).max(160),guest_name:z.string().trim().min(1).max(120),guest_email:z.email().max(200).transform(v=>v.toLowerCase()),record_id:z.string().uuid().nullable(),starts_at:z.iso.datetime({offset:true}),timezone,notes:z.string().trim().max(4000),outside_hours:z.boolean().default(false)}).strict();
const formatters=new Map();
export function localParts(value,zone){
 let f=formatters.get(zone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(formatters.size>=200)formatters.clear();formatters.set(zone,f);}
 const p=Object.fromEntries(f.formatToParts(new Date(value)).map(v=>[v.type,v.value]));return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute),day:new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay()};
}
export function inWorkingHours(config,start,end){
 const s=localParts(start,config.timezone),e=localParts(end,config.timezone);
 const windows=config.exceptions.find(d=>d.date===s.date)?.windows??config.availability.find(d=>d.day===s.day)?.windows??[];
 const nextDay=new Date(`${s.date}T00:00:00Z`);nextDay.setUTCDate(nextDay.getUTCDate()+1);
 return windows.some(w=>{if(!(s.minute>=minutes(w.start)&&(e.date===s.date?e.minute<=minutes(w.end):e.date===nextDay.toISOString().slice(0,10)&&e.minute===0&&w.end==='24:00')))return false;
  if(e.date===s.date&&e.minute-s.minute!==(end-start)/60000)for(let ts=+start;ts<+end;ts+=60000){const p=localParts(ts,config.timezone);if(p.date!==s.date||p.minute<minutes(w.start)||p.minute>=minutes(w.end))return false;}return true;});
}
const dateStarts=new Map();
export function startOfLocalDate(date,zone){
 const key=date+'@'+zone;if(dateStarts.has(key))return new Date(dateStarts.get(key));
 z.iso.date().parse(date);timezone.parse(zone);const anchor=new Date(date+'T00:00:00Z').getTime();
 for(let ts=anchor-14*3600000;ts<anchor+38*3600000;ts+=60000)if(localParts(ts,zone).date===date){if(dateStarts.size>=500)dateStarts.clear();dateStarts.set(key,ts);return new Date(ts);}
 throw new AppError(400,'This calendar date does not exist in the selected timezone.');
}
export function resolveLocalTime(date,time,zone){
 z.iso.date().parse(date);z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).parse(time);timezone.parse(zone);const anchor=Date.parse(date+'T00:00:00Z'),target=minutes(time),choices=[];
 for(let ts=anchor-14*3600000;ts<anchor+38*3600000;ts+=60000){const p=localParts(ts,zone);if(p.date===date&&p.minute===target)choices.push(new Date(ts).toISOString());}return choices;
}
export async function calendarLock(c,tenant){
 // ponytail: serialize workspace scheduling for cross-calendar host conflicts; replace with ordered per-host locks when throughput warrants it.
 await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[tenant]);
}
export async function getCalendar(c,id,lock=false){const v=(await c.query('SELECT * FROM calendars WHERE id=$1'+(lock?' FOR UPDATE':''),[z.string().uuid().parse(id)])).rows[0];if(!v)throw new AppError(404,'Calendar not found in this workspace.');return v;}
export async function getAppointment(c,id,lock=false){const v=(await c.query('SELECT * FROM appointments WHERE id=$1'+(lock?' FOR UPDATE':''),[z.string().uuid().parse(id)])).rows[0];if(!v)throw new AppError(404,'Appointment not found in this workspace.');return v;}
export const publicAppointment=a=>({id:a.id,title:a.title,guest_name:a.guest_name,guest_email:a.guest_email,starts_at:a.starts_at,ends_at:a.ends_at,timezone:a.timezone,location:a.location,state:a.state,version:a.version,manage_key:a.manage_key,calendar_id:a.calendar_id});
export async function saveCalendar(c,tenant,actor,input,version=null){
 const b=calendarInput.parse(input);await calendarLock(c,tenant);await requireBillingAccess(c,tenant,'calendar');
 const hosts=(await c.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=ANY($2::uuid[])',[tenant,b.config.hosts])).rows;if(hosts.length!==b.config.hosts.length)throw new AppError(400,'Choose hosts who are current workspace members.');
 const prior=(await c.query('SELECT * FROM calendars WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
 if(version!==null&&(!prior||prior.version!==version))throw new AppError(409,'This calendar changed. Refresh before saving.');
 if(version===null&&prior)throw new AppError(409,'This calendar already exists. Refresh before editing.');
 if(!prior&&(await c.query('SELECT count(*)::int AS n FROM calendars')).rows[0].n>=100)throw new AppError(400,'This workspace has reached its 100-calendar limit.');
 const item=(await c.query(prior?'UPDATE calendars SET name=$1,config=$2,enabled=$3,public_enabled=$4,version=version+1,updated_at=now() WHERE id=$5 RETURNING *':'INSERT INTO calendars(name,config,enabled,public_enabled,id,tenant_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',prior?[b.name,b.config,b.enabled,b.public_enabled,b.id]:[b.name,b.config,b.enabled,b.public_enabled,b.id,tenant,actor])).rows[0];
 await event(c,tenant,actor,'calendar.'+(prior?'updated':'created'),'calendar',item.id,{calendar_id:item.id});return item;
}
async function schedulingContext(c,cal,start,end,exclude=null,now=new Date()){
 const active=(await c.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=ANY($2::uuid[])',[cal.tenant_id,cal.config.hosts])).rows.map(r=>r.user_id);
 const connections=(await c.query('SELECT id,user_id,synced_at,range_start,range_end FROM calendar_connections WHERE enabled AND user_id=ANY($1::uuid[])',[active])).rows;
 const stale=new Set(connections.filter(v=>!v.synced_at||!v.range_start||!v.range_end||v.synced_at.getTime()<now.getTime()-600000||v.range_start>start||v.range_end<end).map(v=>v.user_id));
 const bookings=(await c.query("SELECT host_ids,blocked_start AS starts_at,blocked_end AS ends_at FROM appointments WHERE state='booked' AND host_ids && $1::uuid[] AND blocked_start<$3 AND blocked_end>$2 AND ($4::uuid IS NULL OR id<>$4)",[active,start,end,exclude])).rows;
 const busy=(await c.query('SELECT co.user_id,b.starts_at,b.ends_at FROM calendar_busy b JOIN calendar_connections co ON co.tenant_id=b.tenant_id AND co.id=b.connection_id WHERE co.enabled AND co.user_id=ANY($1::uuid[]) AND b.starts_at<$3 AND b.ends_at>$2 AND ($4::uuid IS NULL OR b.appointment_id IS NULL OR b.appointment_id<>$4)',[active,start,end,exclude])).rows;
 return {active,stale,bookings,busy};
}
function freeHosts(context,start,end){return context.active.filter(id=>!context.stale.has(id)&&!context.bookings.some(a=>a.host_ids.includes(id)&&a.starts_at<end&&a.ends_at>start)&&!context.busy.some(a=>a.user_id===id&&a.starts_at<end&&a.ends_at>start));}
export async function availableSlots(c,cal,{date,timezone:zone,exclude=null},now=new Date()){
 z.iso.date().parse(date);timezone.parse(zone);if(!cal.enabled)return {slots:[],unavailable:false};
 const anchor=new Date(`${date}T00:00:00Z`),from=new Date(anchor.getTime()-14*3600000),to=new Date(anchor.getTime()+38*3600000);
 const context=await schedulingContext(c,cal,new Date(from.getTime()-cal.config.buffer_before*60000),new Date(to.getTime()+cal.config.buffer_after*60000),exclude,now),slots=[];
 for(let ts=Math.ceil(from.getTime()/900000)*900000;ts<to.getTime();ts+=900000){
  const start=new Date(ts),end=new Date(ts+cal.config.duration*60000),local=localParts(start,zone);
  if(local.date!==date||ts<now.getTime()+cal.config.notice_minutes*60000||ts>now.getTime()+cal.config.horizon_days*86400000||!inWorkingHours(cal.config,start,end))continue;
  const available=freeHosts(context,new Date(ts-cal.config.buffer_before*60000),new Date(end.getTime()+cal.config.buffer_after*60000));
  if(cal.config.assignment==='all'?available.length===cal.config.hosts.length:available.length>0)slots.push({starts_at:start.toISOString(),ends_at:end.toISOString()});
 }
 return {slots,unavailable:context.stale.size>0};
}
async function chooseHosts(c,cal,start,end,exclude,outside,now){
 const cfg=cal.config;if(!cal.enabled)throw new AppError(409,'This calendar is not accepting appointments.');
 if(!outside&&(start.getTime()%900000!==0||!inWorkingHours(cfg,start,end)||start<new Date(now.getTime()+cfg.notice_minutes*60000)||start>new Date(now.getTime()+cfg.horizon_days*86400000)))throw new AppError(409,'This time is outside the current booking availability. Choose another slot.');
 const context=await schedulingContext(c,cal,new Date(start.getTime()-cfg.buffer_before*60000),new Date(end.getTime()+cfg.buffer_after*60000),exclude,now),free=freeHosts(context,new Date(start.getTime()-cfg.buffer_before*60000),new Date(end.getTime()+cfg.buffer_after*60000));
 if(cfg.assignment==='all'){if(free.length!==cfg.hosts.length)throw new AppError(409,'A host is unavailable or calendar sync needs attention. Choose another time.');return cfg.hosts;}
 for(let i=0;i<cfg.hosts.length;i++){const id=cfg.hosts[(cal.next_host+i)%cfg.hosts.length];if(free.includes(id)){await c.query('UPDATE calendars SET next_host=$1 WHERE id=$2',[(cal.next_host+i+1)%cfg.hosts.length,cal.id]);return [id];}}
 throw new AppError(409,'This time is no longer available, or calendar sync needs attention. Choose another slot.');
}
async function recordChange(c,tenant,actor,a,kind,causation=null){
 const {manage_key,create_hash,...snapshot}=a;await c.query('INSERT INTO appointment_changes(tenant_id,id,appointment_id,version,kind,actor_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenant,randomUUID(),a.id,a.version,kind,actor,snapshot]);
 if(a.record_id)await c.query('INSERT INTO activities(tenant_id,id,record_id,actor_id,type,body) VALUES($1,$2,$3,$4,$5,$6)',[tenant,randomUUID(),a.record_id,actor,'meeting',a.title+' - '+kind+' - '+a.starts_at.toISOString()]);
 await event(c,tenant,actor,'calendar.appointment.'+kind,'appointment',a.id,{appointment:snapshot},causation);
 if(kind==='updated'){await c.query("UPDATE calendar_reminders SET appointment_version=$1 WHERE appointment_id=$2 AND state='pending'",[a.version,a.id]);return;}
 await c.query("UPDATE calendar_reminders SET state='cancelled' WHERE appointment_id=$1 AND state='pending'",[a.id]);
 const cfg=(await getCalendar(c,a.calendar_id)).config;
 if(a.state==='booked')for(const n of cfg.reminder_minutes)await c.query('INSERT INTO calendar_reminders(tenant_id,id,appointment_id,appointment_version,minutes,due_at) VALUES($1,$2,$3,$4,$5,$6)',[tenant,randomUUID(),a.id,a.version,n,new Date(a.starts_at.getTime()-n*60000)]);
}
export async function createAppointment(c,tenant,actor,input,source='workspace',causation=null,now=new Date()){
 const b=appointmentInput.parse(input);await calendarLock(c,tenant);await requireBillingAccess(c,tenant,'calendar');const digest=createHash('sha256').update(JSON.stringify({...b,source})).digest('hex');
 const prior=(await c.query('SELECT * FROM appointments WHERE id=$1',[b.id])).rows[0];if(prior){if(prior.create_hash!==digest)throw new AppError(409,'This appointment request was already used with different details.');return prior;}
 if(source==='public'&&b.outside_hours)throw new AppError(400,'Public bookings must follow working hours.');
 const cal=await getCalendar(c,b.calendar_id,true);if(source==='public'&&!cal.public_enabled)throw new AppError(409,'This booking link is disabled.');
 if(b.record_id){const r=await resolveRecord(c,b.record_id);b.record_id=r.id;}
 const start=new Date(b.starts_at),end=new Date(start.getTime()+cal.config.duration*60000);if(!Number.isFinite(start.getTime())||start<now||start>new Date(now.getTime()+366*86400000))throw new AppError(400,'Choose a future time within the next year.');
 const hosts=await chooseHosts(c,cal,start,end,null,b.outside_hours,now);
 const a=(await c.query(`INSERT INTO appointments(tenant_id,id,calendar_id,title,guest_name,guest_email,record_id,host_ids,starts_at,ends_at,blocked_start,blocked_end,timezone,location,notes,source,create_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,[tenant,b.id,cal.id,b.title,b.guest_name,b.guest_email,b.record_id,hosts,start,end,new Date(start.getTime()-cal.config.buffer_before*60000),new Date(end.getTime()+cal.config.buffer_after*60000),b.timezone,cal.config.location,b.notes,source,digest,actor])).rows[0];
 await recordChange(c,tenant,actor,a,'created',causation);return a;
}
export async function changeAppointment(c,tenant,actor,id,input,publicChange=false,now=new Date()){
 const b=z.object({version:z.number().int().positive(),state:z.enum(['booked','cancelled','completed','no_show']),starts_at:z.iso.datetime({offset:true}).optional(),timezone:timezone.optional(),notes:z.string().trim().max(4000).optional(),outside_hours:z.boolean().default(false)}).strict().parse(input);
 await calendarLock(c,tenant);if(b.state!=='cancelled')await requireBillingAccess(c,tenant,'calendar');const old=await getAppointment(c,id,true);if(old.version!==b.version)throw new AppError(409,'This appointment changed. Refresh before trying again.');if(old.state!=='booked')throw new AppError(409,'This appointment is already closed.');
 if(publicChange&&(old.source!=='public'||!['booked','cancelled'].includes(b.state)||b.notes!==undefined||b.outside_hours))throw new AppError(403,'This booking link only allows rescheduling or cancellation.');
 if(['completed','no_show'].includes(b.state)&&old.starts_at>now)throw new AppError(400,'Mark attendance after the appointment starts.');
 let start=old.starts_at,end=old.ends_at,hosts=old.host_ids,blockedStart=old.blocked_start,blockedEnd=old.blocked_end;let kind=b.state;
 if(b.starts_at!==undefined){if(b.state!=='booked')throw new AppError(400,'Reschedule a booked appointment.');const cal=await getCalendar(c,old.calendar_id,true);if(publicChange&&!cal.public_enabled)throw new AppError(409,'This calendar is not accepting reschedules.');start=new Date(b.starts_at);end=new Date(start.getTime()+cal.config.duration*60000);if(start<now||start>new Date(now.getTime()+366*86400000))throw new AppError(400,'Choose a future time within the next year.');hosts=await chooseHosts(c,cal,start,end,old.id,b.outside_hours,now);blockedStart=new Date(start.getTime()-cal.config.buffer_before*60000);blockedEnd=new Date(end.getTime()+cal.config.buffer_after*60000);kind='rescheduled';}
 else if(b.state==='booked')kind='updated';
 const a=(await c.query('UPDATE appointments SET starts_at=$1,ends_at=$2,blocked_start=$3,blocked_end=$4,host_ids=$5,state=$6,timezone=$7,notes=$8,version=version+1,updated_at=now() WHERE id=$9 RETURNING *',[start,end,blockedStart,blockedEnd,hosts,b.state,b.timezone??old.timezone,b.notes??old.notes,old.id])).rows[0];await recordChange(c,tenant,actor,a,kind);return a;
}
export async function pollAppointmentReminders(discovery,stopping=()=>false){
 const due=(await discovery.query("SELECT tenant_id,id FROM calendar_reminders WHERE state='pending' AND due_at<=now() ORDER BY due_at LIMIT 50")).rows;
 for(const row of due){if(stopping())break;await tenantTransaction(row.tenant_id,async c=>{await calendarLock(c,row.tenant_id);const r=(await c.query("SELECT * FROM calendar_reminders WHERE id=$1 AND state='pending' AND due_at<=now() FOR UPDATE SKIP LOCKED",[row.id])).rows[0];if(!r)return;const a=await getAppointment(c,r.appointment_id);if(a.state!=='booked'||a.version!==r.appointment_version||a.starts_at<=new Date()||!(await billingAccess(c,row.tenant_id,'calendar')).access){await c.query("UPDATE calendar_reminders SET state='cancelled' WHERE id=$1",[r.id]);return;}const {manage_key,create_hash,...snapshot}=a;await event(c,row.tenant_id,null,'calendar.appointment.reminder_due','appointment',a.id,{appointment:snapshot,minutes:r.minutes});await c.query("UPDATE calendar_reminders SET state='emitted' WHERE id=$1",[r.id]);});}
}
export function appointmentIcs(a){
 const esc=s=>String(s).replace(/\\/g,'\\\\').replace(/\r\n|[\r\n]/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;'),stamp=d=>new Date(d).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//DryKraft//Calendar//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT',`UID:${a.id}@drykraft.com`,`DTSTAMP:${stamp(a.updated_at||new Date())}`,`DTSTART:${stamp(a.starts_at)}`,`DTEND:${stamp(a.ends_at)}`,`SUMMARY:${esc(a.title)}`,`LOCATION:${esc(a.location)}`,`STATUS:${a.state==='cancelled'?'CANCELLED':'CONFIRMED'}`,`SEQUENCE:${a.version}`,'END:VEVENT','END:VCALENDAR'];
 // Fold UTF-8 bytes without splitting characters, as required by RFC5545.
 return lines.map(line=>{let out='',part='';for(const char of line){if(Buffer.byteLength(part+char)>74){out+=part+'\r\n';part=' ';}part+=char;}return out+part;}).join('\r\n')+'\r\n';
}
