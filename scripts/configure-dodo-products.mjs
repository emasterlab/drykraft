import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dodoRequest} from '../server/billing.mjs';
import {validateBillingProduct} from '../server/billing-products.mjs';

// Creates catalog definitions only. It never starts checkout or charges a customer.
const run=randomUUID(),marker='drykraft-continuing-v2',receipt={run_id:run,started_at:new Date().toISOString(),environment:process.env.DODO_ENVIRONMENT,customer_charges_created:false,production_application_changed:false,products:[]};
await mkdir('.runtime',{recursive:true});
try{
 const products=[];
 for(let page=0;page<20;page++){
  const response=await dodoRequest('/products?page_size=100&page_number='+page+'&archived=false');
  if(!Array.isArray(response.items))throw Error('Product listing returned an unexpected format.');
  products.push(...response.items);if(response.items.length<100)break;if(page===19)throw Error('Product listing exceeded the inspection bound.');
 }
 for(const interval of ['monthly','annual']){
  const candidates=products.filter(p=>p.metadata?.application==='drykraft'&&p.metadata?.pricing_schema===marker&&p.metadata?.billing_interval===interval);
  if(candidates.length>1)throw Error('Duplicate continuing products need merchant review.');
  let product=candidates[0]?await dodoRequest('/products/'+candidates[0].product_id):null;
  const reused=!!product;
  if(!product)product=await dodoRequest('/products',{name:'DryKraft Workspace - '+(interval==='annual'?'Annual':'Monthly'),description:'DryKraft workspace subscription, priced per user. '+(interval==='annual'?'USD 12 per user per year.':'USD 1 per user per month.')+' 15-day free trial.',tax_category:'saas',metadata:{application:'drykraft',plan:'workspace',pricing_schema:marker,billing_interval:interval},price:{type:'recurring_price',price:interval==='annual'?1200:100,currency:'USD',tax_inclusive:false,discount_bps:0,purchasing_power_parity:false,payment_frequency_count:1,payment_frequency_interval:interval==='annual'?'Year':'Month',subscription_period_count:20,subscription_period_interval:'Year',trial_period_days:15,trial_amount:null}});
  process.env[interval==='annual'?'DODO_ANNUAL_PRODUCT_ID':'DODO_MONTHLY_PRODUCT_ID']=product.product_id;
  validateBillingProduct(product,interval);
  receipt.products.push({interval,product_id:product.product_id,reused,unit_price_minor:product.price.price,currency:product.price.currency,payment_frequency_count:product.price.payment_frequency_count,payment_frequency_interval:product.price.payment_frequency_interval,subscription_period_count:product.price.subscription_period_count,subscription_period_interval:product.price.subscription_period_interval,trial_period_days:product.price.trial_period_days});
 }
 const old=await readFile('.env','utf8');await writeFile('.runtime/dodo-catalog-env-backup-'+run,old,{mode:0o600,flag:'wx'});
 let updated=old;
 for(const key of ['DODO_MONTHLY_PRODUCT_ID','DODO_ANNUAL_PRODUCT_ID']){if(updated.match(new RegExp('^'+key+'=','m')))updated=updated.replace(new RegExp('^'+key+'=.*$','m'),key+'='+process.env[key]);else updated=updated.replace(/\n*$/,'')+'\n'+key+'='+process.env[key]+'\n';}
 const temp='.env.dodo-catalog-'+run;await writeFile(temp,updated,{mode:0o600,flag:'wx'});await rename(temp,'.env');await chmod('.env',0o600);receipt.local_private_configuration_updated=true;receipt.status='configured';
}catch(e){receipt.status='failed';receipt.error=e.message;process.exitCode=1;}
receipt.completed_at=new Date().toISOString();await writeFile('.runtime/dodo-catalog-configuration.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
