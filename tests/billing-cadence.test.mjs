import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {billingAccess,requireAvailableSeat,syncSubscription} from '../server/billing.mjs';
import {billingProduct,validateBillingProduct} from '../server/billing-products.mjs';

test('continuing checkout products reject single-cycle, discounted, changed-price and wrong-cadence configuration',()=>{
 const before=process.env.DODO_ANNUAL_PRODUCT_ID;process.env.DODO_ANNUAL_PRODUCT_ID='pdt_annual_configuration_fixture';
 try{
  const good={product_id:process.env.DODO_ANNUAL_PRODUCT_ID,is_recurring:true,price:{type:'recurring_price',price:1200,currency:'USD',tax_inclusive:false,discount_bps:0,purchasing_power_parity:false,payment_frequency_count:1,payment_frequency_interval:'Year',subscription_period_count:20,subscription_period_interval:'Year',trial_period_days:15,trial_amount:null}};
  assert.equal(validateBillingProduct(good,'annual').unit_price_minor,1200);
  for(const change of [{price:100},{currency:'INR'},{tax_inclusive:true},{discount_bps:100},{purchasing_power_parity:true},{payment_frequency_interval:'Month'},{subscription_period_count:1},{trial_amount:100},{trial_period_days:30}])assert.throws(()=>validateBillingProduct({...good,price:{...good.price,...change}},'annual'),e=>e.status===503);
  assert.throws(()=>validateBillingProduct({...good,product_id:'pdt_wrong'},'annual'),e=>e.status===503);
  assert.throws(()=>validateBillingProduct({...good,archived:true},'annual'),e=>e.status===503);
  assert.equal(billingProduct('monthly').unit_price_minor,100);
 }finally{if(before===undefined)delete process.env.DODO_ANNUAL_PRODUCT_ID;else process.env.DODO_ANNUAL_PRODUCT_ID=before;}
});

test('annual subscription binding, provider grace expiry and seat capacity preserve tenant and suspension boundaries',async()=>{
 const tenant=randomUUID(),user=randomUUID(),checkout=randomUUID(),other=randomUUID(),product='pdt_annual_'+randomUUID().replaceAll('-',''),old=process.env.DODO_ANNUAL_PRODUCT_ID;
 process.env.DODO_ANNUAL_PRODUCT_ID=product;
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  await tenantTransaction(tenant,async c=>{
   await c.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Annual fixture',$2,'unused')",[user,user+'@example.test']);
   await c.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Annual billing fixture',$2)",[tenant,'annual-'+tenant.slice(0,8)]);
   await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenant,user]);
   await c.query("UPDATE workspace_billing SET trial_ends_at=now()-interval '1 day' WHERE tenant_id=$1",[tenant]);
   await c.query("INSERT INTO billing_checkouts(tenant_id,id,seats,billing_interval,product_id) VALUES($1,$2,1,'annual',$3)",[tenant,checkout,product]);
  });
  const state={subscription_id:'sub_annual_fixture',product_id:product,status:'active',quantity:1,recurring_pre_tax_amount:1200,payment_frequency_count:1,payment_frequency_interval:'Year',tax_inclusive:false,currency:'USD',next_billing_date:new Date(Date.now()+365*86400000).toISOString(),cancel_at_next_billing_date:false,customer:{customer_id:'cus_annual_fixture'},metadata:{workspace_id:tenant,checkout_id:checkout}};
  await tenantTransaction(tenant,async c=>{
   await syncSubscription(c,tenant,state.subscription_id,async()=>state);
   let b=await billingAccess(c,tenant);assert.equal(b.access,true);assert.equal(b.billing_interval,'annual');assert.equal(b.product_id,product);
   await assert.rejects(syncSubscription(c,tenant,state.subscription_id,async()=>({...state,subscription_id:'sub_someone_else'})),e=>e.status===400);
   await assert.rejects(syncSubscription(c,tenant,state.subscription_id,async()=>({...state,metadata:{...state.metadata,workspace_id:other}})),e=>e.status===400);
   await assert.rejects(syncSubscription(c,tenant,state.subscription_id,async()=>({...state,payment_frequency_interval:'Month'})),e=>e.status===400);
   await assert.rejects(syncSubscription(c,tenant,state.subscription_id,async()=>({...state,recurring_pre_tax_amount:100})),e=>e.status===409);
   await syncSubscription(c,tenant,state.subscription_id,async()=>({...state,status:'past_due',next_billing_date:new Date(Date.now()-86400000).toISOString(),past_due_ends_at:new Date(Date.now()+86400000).toISOString()}));
   b=await billingAccess(c,tenant);assert.equal(b.grace,true);assert.equal(b.access,true);
   await assert.rejects(requireAvailableSeat(c,tenant,randomUUID()),e=>e.status===409);
   await syncSubscription(c,tenant,state.subscription_id,async()=>({...state,status:'past_due',past_due_ends_at:new Date(Date.now()-1000).toISOString()}));
   assert.equal((await billingAccess(c,tenant)).access,false,'Expired grace cannot use a future renewal date to extend access');
   await syncSubscription(c,tenant,state.subscription_id,async()=>({...state,status:'past_due'}));
   assert.equal((await billingAccess(c,tenant)).access,false,'No provider grace date grants no grace');
   await syncSubscription(c,tenant,state.subscription_id,async()=>({...state,status:'on_hold',past_due_ends_at:new Date(Date.now()+86400000).toISOString()}));
   b=await billingAccess(c,tenant);assert.equal(b.access,false);assert.equal(b.past_due_ends_at,null);
   await syncSubscription(c,tenant,state.subscription_id,async()=>state);assert.equal((await billingAccess(c,tenant)).access,true);
   const events=(await c.query("SELECT data FROM outbox WHERE type='billing.subscription.updated' ORDER BY occurred_at")).rows;assert.ok(events.length>=5);assert.ok(events.every(e=>e.data.billing_interval==='annual'&&e.data.unit_price_minor===1200));
  });
  await admin.query("INSERT INTO platform_workspace_controls(tenant_id,suspended) VALUES($1,true)",[tenant]);
  assert.equal((await tenantTransaction(tenant,c=>billingAccess(c,tenant))).access,false);
  assert.equal((await tenantTransaction(other,c=>c.query('SELECT * FROM workspace_billing'))).rowCount,0);
 }finally{
  if(old===undefined)delete process.env.DODO_ANNUAL_PRODUCT_ID;else process.env.DODO_ANNUAL_PRODUCT_ID=old;
  try{for(const table of ['platform_workspace_controls','audit_events','outbox','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);await admin.query('DELETE FROM users WHERE id=$1',[user]);}finally{await admin.end();await pool.end();}
 }
});
