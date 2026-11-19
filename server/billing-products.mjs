import {z} from 'zod';
import {AppError} from './model.mjs';

export const billingInterval=z.enum(['monthly','annual']);
export function billingProduct(interval){
 const cadence=billingInterval.parse(interval);
 return {interval:cadence,product_id:cadence==='annual'?process.env.DODO_ANNUAL_PRODUCT_ID:process.env.DODO_MONTHLY_PRODUCT_ID||process.env.DODO_PRODUCT_ID,unit_price_minor:cadence==='annual'?1200:100,frequency:cadence==='annual'?'Year':'Month'};
}
export function configuredProductInterval(id){
 if(id&&id===process.env.DODO_ANNUAL_PRODUCT_ID)return 'annual';
 if(id&&(id===process.env.DODO_MONTHLY_PRODUCT_ID||id===process.env.DODO_PRODUCT_ID))return 'monthly';
 return null;
}
export function validateBillingProduct(product,interval){
 const expected=billingProduct(interval),p=product?.price;
 if(product?.product_id!==expected.product_id||!product?.is_recurring||p?.type!=='recurring_price'||p.price!==expected.unit_price_minor||p.currency!=='USD'||p.payment_frequency_count!==1||p.payment_frequency_interval!==expected.frequency||p.subscription_period_interval!=='Year'||p.subscription_period_count!==20||p.tax_inclusive!==false||Number(p.discount_bps??p.discount??0)!==0||p.purchasing_power_parity===true||Number(p.trial_amount??0)!==0||Number(p.trial_period_days)!==15||product.archived===true){
  throw new AppError(503,'This billing product needs configuration review. Contact DryKraft before starting checkout.');
 }
 return expected;
}
