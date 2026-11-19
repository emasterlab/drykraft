import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHmac } from 'node:crypto';
import pg from 'pg';
import http from 'node:http';
import { pool,tenantTransaction } from '../server/db.mjs';
import { tokenHash,hashPassword } from '../server/auth.mjs';
import { initializeWorkspace } from '../server/model.mjs';
import { verifyDodoWebhook,providerLink,billingAccess,requireBillingAccess,requireAvailableSeat,syncSubscription } from '../server/billing.mjs';

const base=(process.env.TEST_API_ORIGIN || 'http://127.0.0.1:4000')+'/api';
async function api(path,method='GET',body,cookie='',headers={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(base+path,{method,headers:{'Content-Type':'application/json',...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{}),cookie,...headers}},res=>{
      const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(parts).toString())});}catch(error){reject(error);}});
    });req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
  });
}
test('Dodo raw signature verification rejects altered, missing and replayed requests',()=>{
  const key='whsec_'+randomBytes(32).toString('base64'),body=Buffer.from('{ "type": "subscription.active" }'),id='evt_example',timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',Buffer.from(key.slice(6),'base64')).update(`${id}.${timestamp}.`).update(body).digest('base64');
  const headers={'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v2,invalid v1,${signature}`};
  assert.equal(verifyDodoWebhook(body,headers,key),id);
  assert.throws(()=>verifyDodoWebhook(Buffer.from('{}'),headers,key),e=>e.status===401);
  assert.throws(()=>verifyDodoWebhook(body,headers,key,(Number(timestamp)+301)*1000),e=>e.status===401);
  assert.throws(()=>verifyDodoWebhook(body,{...headers,'webhook-signature':'v1,short'},key),e=>e.status===401);
  assert.throws(()=>verifyDodoWebhook(body,{},key),e=>e.status===401);
  assert.equal(providerLink('https://checkout.dodopayments.com/session/example'),'https://checkout.dodopayments.com/session/example');
  assert.throws(()=>providerLink('https://dodopayments.com.evil.test/checkout'));assert.throws(()=>providerLink('http://checkout.dodopayments.com'));
});
test('workspace trials, billing ownership, canonical subscriptions, seats and expired access',async()=>{
  const tenant=randomUUID(),other=randomUUID(),user=randomUUID(),member=randomUUID(),token=randomBytes(32).toString('hex'),memberToken=randomBytes(32).toString('hex'),checkout=randomUUID();
  const cookie='drykraft_session='+token,memberCookie='drykraft_session='+memberToken;
  const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
  try {
    await tenantTransaction(tenant,async c=>{
      for(const [id,name] of [[user,'Billing owner'],[member,'Billing member']])await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,name,`${id}@example.test`,await hashPassword(randomBytes(24).toString('hex'))]);
      await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Billing check',`bill-${tenant.slice(0,8)}`]);
      await initializeWorkspace(c,tenant);
      await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[tenant,user,member]);
      for(const [id,raw] of [[user,token],[member,memberToken]])await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(raw),id,tenant]);
      await c.query('INSERT INTO billing_checkouts(tenant_id,id,seats) VALUES($1,$2,2)',[tenant,checkout]);
    });
    const initial=await api('/billing','GET',null,cookie);assert.equal(initial.status,200,JSON.stringify(initial.data));const b=initial.data;
    assert.equal(b.members,2);assert.equal(b.trial,true);assert.equal(b.access,true);assert.equal((new Date(b.trial_ends_at)-new Date(b.trial_started_at))/86400000,15);
    assert.equal((await api('/billing/checkout','POST',{seats:2},memberCookie)).status,403);
    assert.equal((await api('/billing/checkout','POST',{seats:1},cookie)).status,400);
    assert.equal((await api('/billing/checkout','POST',{seats:1.5},cookie)).status,400);
    const ambiguous=await api('/billing/checkout','POST',{seats:2},cookie);
    assert.equal(ambiguous.status,503);assert.match(ambiguous.data.error.message,/Checkout creation could not be confirmed/);
    assert.equal((await api('/billing/enterprise','POST',{requirements:'Our team needs a staged enterprise rollout.'},cookie)).status,200);
    assert.ok((await api('/billing','GET',null,cookie)).data.enterprise_requested_at);
    assert.equal((await pool.query('SELECT * FROM workspace_billing')).rowCount,0);
    assert.equal((await tenantTransaction(other,c=>c.query('SELECT * FROM workspace_billing'))).rowCount,0);
    const state={subscription_id:'sub_owned_fixture',product_id:process.env.DODO_PRODUCT_ID || 'pdt_fixture',status:'active',quantity:2,recurring_pre_tax_amount:200,payment_frequency_count:1,payment_frequency_interval:'Month',tax_inclusive:false,currency:'USD',next_billing_date:new Date(Date.now()+86400000).toISOString(),cancel_at_next_billing_date:false,customer:{customer_id:'cus_owned_fixture'},metadata:{workspace_id:tenant,checkout_id:checkout}};
    const priorProduct=process.env.DODO_PRODUCT_ID;process.env.DODO_PRODUCT_ID=state.product_id;
    try {
      await tenantTransaction(tenant,async c=>{
        await c.query("UPDATE workspace_billing SET trial_ends_at=now()-interval '1 second' WHERE tenant_id=$1",[tenant]);
        await assert.rejects(requireBillingAccess(c,tenant),e=>e.status===402);
        await syncSubscription(c,tenant,state.subscription_id,async()=>state);
        assert.equal((await billingAccess(c,tenant)).access,true);
        await assert.rejects(requireAvailableSeat(c,tenant,randomUUID()),e=>e.status===409);
        await requireAvailableSeat(c,tenant,user);
        await syncSubscription(c,tenant,state.subscription_id,async()=>({...state,status:'on_hold'}));
        assert.equal((await billingAccess(c,tenant)).access,false);
        await syncSubscription(c,tenant,state.subscription_id,async()=>({...state,quantity:3,recurring_pre_tax_amount:300}));
        await requireAvailableSeat(c,tenant,randomUUID());
        await assert.rejects(syncSubscription(c,tenant,state.subscription_id,async()=>({...state,metadata:{...state.metadata,workspace_id:other}})),e=>e.status===400);
        await assert.rejects(syncSubscription(c,tenant,state.subscription_id,async()=>({...state,recurring_pre_tax_amount:500})),e=>e.status===409);
        await syncSubscription(c,tenant,state.subscription_id,async()=>({...state,next_billing_date:new Date(Date.now()-1000).toISOString()}));
        assert.equal((await billingAccess(c,tenant)).access,false,'Stale active status cannot grant access beyond the last verified paid period');
      });
    }finally{if(priorProduct===undefined)delete process.env.DODO_PRODUCT_ID;else process.env.DODO_PRODUCT_ID=priorProduct;}
    assert.equal((await api('/records/people','POST',{data:{name:'Blocked after trial'}},cookie)).status,402);
    assert.equal((await api('/records/people','GET',null,cookie)).status,200);
    assert.equal((await api('/analytics/query','POST',{widgets:[]},cookie)).status,200);
    assert.equal((await api('/billing','GET',null,cookie)).status,200);
    assert.equal((await api('/account/security','GET',null,cookie)).status,200);
    assert.equal((await api('/billing/dodo/webhook','POST',{type:'subscription.active',data:{}})).status,401);
    const raw={type:'payment.succeeded',data:{product_id:'unrelated_product'}},id='evt_'+randomUUID(),timestamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',Buffer.from(process.env.DODO_WEBHOOK_KEY.replace(/^whsec_/,''),'base64')).update(`${id}.${timestamp}.${JSON.stringify(raw)}`).digest('base64');
    assert.equal((await api('/billing/dodo/webhook','POST',raw,'',{'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+signature})).status,200,'Signed unrelated product is acknowledged without access changes');
    assert.equal((await api('/billing','GET',null,cookie)).data.access,false);
    await assert.rejects(tenantTransaction(tenant,c=>c.query('DELETE FROM billing_webhook_events')),e=>e.code==='42501');
  } finally {
    for(const table of ['activities','records','object_definitions','pipelines','dashboards','audit_events','outbox','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);
    await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);
    await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[user,member]]);
    await admin.end();await pool.end();
  }
});
