import {z} from 'zod';
import {AppError} from './model.mjs';
import {parseCsv} from './csv.mjs';
import {csvCell} from '../src/lib/csv.mjs';

const reserved=['__proto__','prototype','constructor'];
const column=z.string().min(1).max(100).refine(v=>v===v.trim() && !reserved.includes(v),'Use a nonempty column name without surrounding spaces or prototype keys.');
const columns=z.array(column).min(1).max(100).refine(v=>new Set(v.map(s=>s.toLowerCase())).size===v.length,'Use distinct column names.');
const path=z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/).refine(v=>!v.split('.').some(s=>reserved.includes(s)));
export function validateCsv(raw){
 const result=z.object({operation:z.enum(['parse','serialize']),source:path}).safeParse(raw);
 if(!result.success)throw new AppError(400,'CSV needs Parse CSV or Create CSV, a plain source path, and 1-100 distinct column names for Create CSV.');
 if(result.data.operation==='parse')return result.data;
 const selected=columns.safeParse(raw.columns);
 if(!selected.success)throw new AppError(400,'Choose 1-100 distinct CSV columns without surrounding spaces or prototype keys, in their output order.');
 return {...result.data,columns:selected.data};
}
export function executeCsv(raw,value){
 const d=validateCsv(raw);let output;
 if(d.operation==='parse'){
  const parsed=parseCsv(value,{maxRows:1000,maxBytes:262144,allowEmpty:true});
  if(!columns.safeParse(parsed.headers).success)throw new AppError(400,'CSV headings must be distinct nonempty names without prototype keys.');
  output={headers:parsed.headers,items:parsed.rows.map(row=>Object.fromEntries(parsed.headers.map((key,i)=>[key,row.values[i]]))),count:parsed.rows.length};
 }else{
  if(!Array.isArray(value) || value.length>1000)throw new AppError(400,'The Create CSV source must contain an array of up to 1,000 records.');
  if(Buffer.byteLength(JSON.stringify(value))>262144)throw new AppError(400,'CSV input exceeds 256 KiB. Map only the fields you need first.');
  const rows=[d.columns.map(csvCell).join(',')];let bytes=Buffer.byteLength(rows[0]);
  for(const record of value){
   if(!record || typeof record!=='object' || Array.isArray(record))throw new AppError(400,'Each Create CSV item must be a JSON object.');
   const row=d.columns.map(key=>{
    const cell=Object.hasOwn(record,key)?record[key]:null;
    if(typeof cell==='number' && !Number.isFinite(cell))throw new AppError(400,'CSV numbers must be finite.');
    return csvCell(cell);
   }).join(',');
   bytes+=Buffer.byteLength(row)+2;if(bytes>262144)throw new AppError(400,'CSV output exceeds 256 KiB. Choose fewer rows or columns.');rows.push(row);
  }
  output={csv:rows.join('\r\n'),headers:d.columns,count:value.length};
 }
 // ponytail: bounded in-memory CSV in the shared worker; use object storage and streamed jobs for larger files.
 if(Buffer.byteLength(JSON.stringify(output))>262144)throw new AppError(400,'CSV output exceeds 256 KiB. Choose fewer rows or columns.');
 return output;
}
