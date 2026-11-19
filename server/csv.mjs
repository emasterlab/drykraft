import { AppError } from './model.mjs';

// ponytail: synchronous files are capped at 500 records/300KB; queue larger imports when required.
export function parseCsv(input,{maxRows=500,maxBytes=300000,allowEmpty=false}={}) {
  if(typeof input!=='string' || Buffer.byteLength(input)>maxBytes || input.includes('\0'))throw new AppError(400,`Choose UTF-8 CSV content up to ${maxBytes===300000?'300 KB':'256 KiB'}.`);
  const source=input.replace(/^\uFEFF/,''),rows=[];
  let value='',cells=[],quoted=false,closed=false,line=1,start=1;
  const row=()=>{cells.push(value);if(cells.some(c=>c.trim()!=='')){rows.push({line:start,values:cells});if(rows.length>maxRows+1)throw new AppError(400,`Process up to ${maxRows} records at a time.`);}cells=[];value='';closed=false;};
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(quoted){if(c==='"'){if(source[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else{value+=c;if(c==='\n' || (c==='\r' && source[i+1]!=='\n'))line++;}continue;}
    if(c===','){cells.push(value);value='';closed=false;}
    else if(c==='\r' || c==='\n'){row();if(c==='\r' && source[i+1]==='\n')i++;line++;start=line;}
    else if(c==='"'){if(value || closed)throw new AppError(400,`Unexpected quote on CSV line ${line}.`);quoted=true;}
    else {if(closed)throw new AppError(400,`Unexpected text after a quoted value on CSV line ${line}.`);value+=c;}
  }
  if(quoted)throw new AppError(400,`A quoted value starting near line ${start} is not closed.`);
  row();
  const headers=rows.shift()?.values.map(h=>h.trim());
  if(!headers?.length || headers.length>100 || headers.some(h=>!h || h.length>100) || new Set(headers.map(h=>h.toLowerCase())).size!==headers.length)throw new AppError(400,'Use 1–100 distinct, non-empty column headings.');
  for(const r of rows)if(r.values.length!==headers.length)throw new AppError(400,`CSV line ${r.line} has ${r.values.length} values; expected ${headers.length}.`);
  if(!rows.length && !allowEmpty)throw new AppError(400,'The CSV contains headings but no records.');
  return {headers,rows};
}
export function csvValue(field,raw) {
  const value=raw.trim();if(!value)return undefined;
  if(['number','currency'].includes(field.type)){if(!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))throw new AppError(400,`Use a plain number for ${field.name}, without currency symbols or thousands separators.`);return Number(value);}
  if(field.type==='boolean'){if(/^(true|yes|1)$/i.test(value))return true;if(/^(false|no|0)$/i.test(value))return false;throw new AppError(400,`Use true/false or yes/no for ${field.name}.`);}
  if(field.type==='json' || (field.type==='multi_select' && value.startsWith('['))){try{return JSON.parse(value);}catch{throw new AppError(400,`Enter valid JSON for ${field.name}.`);}}
  if(field.type==='multi_select')return value.split(';').map(v=>v.trim()).filter(Boolean);
  return field.type==='email'?value.toLowerCase():value;
}
