import {z} from 'zod';
import {AppError} from './model.mjs';

const expression=/^\{\{[a-zA-Z0-9_.-]+\}\}$/;
const duration={milliseconds:1,seconds:1000,minutes:60000,hours:3600000,days:86400000,weeks:604800000};
export const dateTimeSchema=z.object({
  operation:z.enum(['now','format','shift','difference']),
  date:z.string().max(500).default(''),otherDate:z.string().max(500).default(''),
  amount:z.union([z.number().finite().min(-1000000).max(1000000),z.string().regex(expression)]).default(1),
  unit:z.enum([...Object.keys(duration),'months','years']).default('days'),
  timezone:z.string().min(1).max(80).default('UTC'),locale:z.string().min(2).max(80).default('en-GB'),
  format:z.enum(['iso','date','time','full']).default('full'),
});
function checked(date){
  if(!Number.isFinite(date.getTime()) || date.getUTCFullYear()<1 || date.getUTCFullYear()>9999)throw new AppError(400,'Date/Time supports years 0001 through 9999. Reduce the date shift.');
  return date;
}
export function parseWorkflowDate(value){
  if(typeof value!=='string')throw new AppError(400,'Use an ISO date or timestamp with Z or an explicit offset.');
  const m=value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/);
  if(!m)throw new AppError(400,'Use YYYY-MM-DD or an ISO timestamp with Z or an explicit offset, such as 2026-01-31T09:00:00Z.');
  const [year,month,day]=m.slice(1,4).map(Number),lastDay=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
  if(year<1||month<1||month>12||day<1||day>lastDay||Number(m[4])>23||Number(m[5])>59||Number(m[6])>59||m[8]&&m[8]!=='Z'&&(Number(m[8].slice(1,3))>23||Number(m[8].slice(4))>59))throw new AppError(400,'This date or time does not exist. Check the day, time and offset.');
  return checked(new Date(m[4]?value:value+'T00:00:00Z'));
}
export function validateDateTime(raw,resolved=false){
  const d=dateTimeSchema.parse(raw);
  try{
    if(!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(d.timezone))throw new Error();
    if(!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(d.locale)||!Intl.DateTimeFormat.supportedLocalesOf(d.locale).length)throw new Error();
    new Intl.DateTimeFormat(d.locale,{timeZone:d.timezone});
  }catch{throw new AppError(400,'Choose a supported language code and IANA timezone, such as en-GB and Asia/Kolkata.');}
  for(const field of d.operation==='difference'?['date','otherDate']:d.operation==='now'?[]:['date']){
    if(!d[field])throw new AppError(400,'Supply the date for this Date/Time operation.');
    if(resolved||!d[field].includes('{{'))parseWorkflowDate(d[field]);
  }
  if(d.operation==='shift'&&(resolved||typeof d.amount==='number')){
    if(typeof d.amount!=='number')throw new AppError(400,'Date shift amount must resolve to a number, not text.');
    if(['months','years'].includes(d.unit)&&!Number.isInteger(d.amount))throw new AppError(400,'Month and year shifts need a whole number.');
  }
  if(d.operation==='difference'&&!Object.hasOwn(duration,d.unit))throw new AppError(400,'Choose an elapsed unit for a difference; months and years have variable lengths.');
  return d;
}
export function executeDateTime(raw,now=new Date()){
  const d=validateDateTime(raw,true);
  let date=d.operation==='now'?checked(new Date(now)):parseWorkflowDate(d.date);
  if(d.operation==='difference'){
    const end=parseWorkflowDate(d.otherDate);
    return {difference:(end-date)/duration[d.unit],unit:d.unit,start_iso:date.toISOString(),end_iso:end.toISOString()};
  }
  if(d.operation==='shift'){
    if(Object.hasOwn(duration,d.unit))date=checked(new Date(date.getTime()+d.amount*duration[d.unit]));
    else{
      const day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+d.amount*(d.unit==='years'?12:1));checked(date);
      const end=new Date(date);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);date.setUTCDate(Math.min(day,end.getUTCDate()));
    }
  }
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:d.timezone,calendar:'gregory',numberingSystem:'latn',era:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  const localDate=`${parts.year.padStart(4,'0')}-${parts.month}-${parts.day}`,time=`${parts.hour}:${parts.minute}:${parts.second}`,iso=date.toISOString();
  if(parts.era!=='AD'||Number(parts.year)<1||Number(parts.year)>9999)throw new AppError(400,'The formatted date is outside years 0001 through 9999 in this timezone.');
  const formatted=d.format==='iso'?iso:new Intl.DateTimeFormat(d.locale,{timeZone:d.timezone,calendar:'gregory',...(d.format==='time'?{timeStyle:'medium'}:d.format==='date'?{dateStyle:'long'}:{dateStyle:'long',timeStyle:'long'})}).format(date);
  return {iso,date:localDate,time,formatted,timezone:d.timezone,locale:d.locale,timestamp:date.getTime()};
}
