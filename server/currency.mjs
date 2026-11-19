import { z } from 'zod';

const names=new Intl.DisplayNames('en',{type:'currency'});
export const currencyOptions=Intl.supportedValuesOf('currency').map(code=>{
  const format=new Intl.NumberFormat('en',{style:'currency',currency:code});
  return {code,name:names.of(code).replace(/\p{Dash_Punctuation}/gu,'-'),symbol:format.formatToParts(0).find(p=>p.type==='currency').value,digits:format.resolvedOptions().maximumFractionDigits};
});
const codes=new Set(currencyOptions.map(c=>c.code));
export const currencySchema=z.string().refine(c=>codes.has(c),'Choose a supported currency code.');
export const currencySettingsSchema=z.object({currency:currencySchema.default('USD'),currencies:z.array(currencySchema).min(1).max(180).optional()}).superRefine((v,c)=>{
  if(v.currencies && (!v.currencies.includes(v.currency) || new Set(v.currencies).size!==v.currencies.length))c.addIssue({code:'custom',message:'Enabled currencies must be unique and include the default currency.'});
});
export function currencyDigits(code){currencySchema.parse(code);return currencyOptions.find(c=>c.code===code).digits;}
export const workspaceCurrencies=settings=>settings.currencies || ['USD','INR','EUR','GBP','AUD','CAD','JPY','KWD'];
export function monetaryFields(fields){
  if(!fields.some(f=>f.type==='currency'))return fields;
  const currency=fields.find(f=>f.key==='currency');
  if(currency && currency.type!=='text')throw Object.assign(new Error('The currency field must hold a currency code.'),{status:400});
  return currency?fields:[...fields,{key:'currency',name:'Currency',type:'text',required:false}];
}
