import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { pool,tenantTransaction } from '../server/db.mjs';
import { initializeWorkspace } from '../server/model.mjs';
import { tokenHash } from '../server/auth.mjs';
import { templateInputSchema,invoiceTemplateSchema } from '../server/template-content.mjs';
import { encryptCredential } from '../server/automation.mjs';
import { sendProvider } from '../server/outreach-providers.mjs';

const origin=process.env.TEST_API_ORIGIN || 'http://localhost:4000';
function call(path,method='GET',body,cookie=''){return new Promise((resolve,reject)=>{
 const req=http.request(origin+'/api'+path,{method,headers:{'content-type':'application/json',...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{}),cookie}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>{const raw=Buffer.concat(parts);resolve({status:res.statusCode,data:String(res.headers['content-type']).includes('application/pdf')?raw:JSON.parse(raw)});});});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
});}
test('template content is typed, bounded and never bypasses email unsubscribe rendering',async()=>{
 assert.throws(()=>invoiceTemplateSchema.parse({accent:'url(https://example.test)'}));
 assert.throws(()=>invoiceTemplateSchema.parse({title:'Invoice\nPaid'}));
 assert.throws(()=>invoiceTemplateSchema.parse({html:'<script>bad</script>'}));
 assert.throws(()=>templateInputSchema.parse({kind:'email',name:'Blank',content:{subject:'',body:'Message'}}));
 assert.throws(()=>templateInputSchema.parse({kind:'sms',name:'Large',content:{variables:Object.fromEntries(Array.from({length:41},(_,i)=>['v'+i,'x']))}}));
 assert.throws(()=>templateInputSchema.parse({kind:'whatsapp',name:'Bad',content:{template:'approved',parameters:Array(21).fill('x')}}));
 const email=templateInputSchema.parse({name:'Follow-up',kind:'email',content:{subject:'Hello {{record.data.name}}',body:'Thank you, {{record.data.name}}.'}});
 let mime;await sendProvider({channel:'email',provider:'google'},{email:'sender@example.test',accessToken:'synthetic'},'recipient@example.test',email.content,{record:{data:{name:'Sample person'}},unsubscribeUrl:'https://example.test/unsubscribe'},randomUUID(),async(url,options)=>{mime=Buffer.from(JSON.parse(options.body).raw,'base64url').toString();return {body:{id:'synthetic'}};});
 assert.match(mime,/Subject: Hello Sample person/);assert.match(mime,/Thank you, Sample person/);assert.match(mime,/List-Unsubscribe:/);assert.match(mime,/https:\/\/example.test\/unsubscribe/);
});
test('workspace templates support safe retries, concurrent edits, role boundaries and immutable invoice/campaign copies',async()=>{
 const tenant=randomUUID(),other=randomUUID(),ids=[randomUUID(),randomUUID(),randomUUID()],tokens=ids.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(v=>'drykraft_session='+v);
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(const [i,w]of [tenant,other].entries())await tenantTransaction(w,async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[w,'Synthetic templates','tpl-'+w.slice(0,8)]);await initializeWorkspace(c,w);
   for(const index of i===0?[0,1]:[2]){await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[ids[index],'Synthetic template user',ids[index]+'@example.test','unused-test-password-hash']);await c.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[w,ids[index],index===1?'viewer':'owner']);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[index]),ids[index],w]);}
  });
  assert.equal((await call('/templates')).status,401);
  const input={id:randomUUID(),name:'Invoice design',kind:'invoice',content:{title:'Service invoice',footer:'Thank you for your business.',payment_instructions:'Pay by bank transfer.',notes:'Work completed.'}};
  const created=await call('/templates/','POST',input,cookies[0]);assert.equal(created.status,201,JSON.stringify(created.data));let item=created.data;
  assert.equal((await call('/templates/','POST',input,cookies[0])).data.version,1);
  assert.equal((await call('/templates/','POST',{...input,name:'Different'},cookies[0])).status,409);
  assert.deepEqual((await call('/templates/', 'GET',undefined,cookies[2])).data,[]);
  assert.equal((await call('/templates/'+item.id,'GET',undefined,cookies[2])).status,404);
  assert.equal((await call('/templates/'+item.id,'PUT',{name:item.name,kind:item.kind,content:item.content,version:1},cookies[1])).status,403);
  const fields={name:'Synthetic invoice',customer_name:'Synthetic customer',currency:'USD',issue_date:'2026-10-02',due_date:'2026-11-01',items:[{description:'Service',quantity:'1',unit_price:'12.34'}],notes:item.content.notes,document_template:item.content};
  const draft=await call('/finance/invoices','POST',{data:fields},cookies[0]);assert.equal(draft.status,201,JSON.stringify(draft.data));assert.equal(draft.data.data.total_minor,1234);assert.deepEqual(draft.data.data.document_template,item.content);
  const issued=await call('/finance/invoices/'+draft.data.id+'/action','POST',{action:'issue',version:draft.data.version},cookies[0]);assert.equal(issued.status,200);
  const update={name:item.name,kind:item.kind,content:{...item.content,title:'New title',footer:'Changed footer'},version:1,archived:true};
  const saved=await call('/templates/'+item.id,'PUT',update,cookies[0]);assert.equal(saved.status,200);assert.equal(saved.data.version,2);assert.equal(saved.data.archived,true);
  assert.equal((await call('/templates/'+item.id,'PUT',update,cookies[0])).status,409);
  const frozen=(await call('/records/invoices/'+draft.data.id,'GET',undefined,cookies[0])).data;assert.equal(frozen.data.document_template.title,'Service invoice');assert.equal(frozen.data.document_template.footer,item.content.footer);
  assert.equal((await call('/finance/invoices/'+draft.data.id,'PUT',{data:fields,version:issued.data.version},cookies[0])).status,409);
  const pdf=await call('/finance/invoices/'+draft.data.id+'/pdf','GET',undefined,cookies[1]);assert.equal(pdf.status,200);assert.equal(pdf.data.subarray(0,4).toString(),'%PDF');
  const sample=await call('/templates/invoice-preview','POST',item.content,cookies[1]);assert.equal(sample.status,200);assert.equal(sample.data.subarray(0,4).toString(),'%PDF');
  assert.equal((await call('/templates/'+item.id,'PUT',{...update,version:2,archived:false},cookies[0])).data.archived,false);
  const emailInput={id:randomUUID(),name:'Email draft',kind:'email',content:{subject:'Hello {{record.data.name}}',body:'Original email'}};
  const email=(await call('/templates/','POST',emailInput,cookies[0])).data;
  const connection=randomUUID();await tenantTransaction(tenant,c=>c.query("INSERT INTO outreach_connections(tenant_id,id,name,channel,provider,ciphertext,verified_at) VALUES($1,$2,'Synthetic Google','email','google',$3,now())",[tenant,connection,encryptCredential(tenant,{email:'sender@example.test',accessToken:'synthetic',refreshToken:'synthetic',expiresAt:Date.now()+3600000})]));
  const campaign=await call('/outreach/campaigns','POST',{name:'Template copy',channel:'email',kind:'campaign',connection_id:connection,steps:[email.content]},cookies[0]);assert.equal(campaign.status,201,JSON.stringify(campaign.data));
  assert.equal((await call('/templates/'+email.id,'PUT',{name:email.name,kind:'email',content:{subject:'Changed',body:'Changed email'},version:1},cookies[0])).status,200);
  assert.equal((await call('/outreach/campaigns/'+campaign.data.id,'GET',undefined,cookies[0])).data.steps[0].body,'Original email');
  for(const [kind,content]of [['expense',{vendor:'Sample vendor',category:'Travel'}],['sms',{variables:{var:'{{record.data.name}}'}}],['voice',{assistantId:'sample-assistant',dialerId:'sample-dialer'}],['whatsapp',{template:'approved_sample',language:'en',parameters:['{{record.data.name}}']} ]])assert.equal((await call('/templates/','POST',{id:randomUUID(),name:kind,kind,content},cookies[0])).status,201);
  const audit=await tenantTransaction(tenant,c=>c.query("SELECT action FROM audit_events WHERE action LIKE 'workspace.template.%'"));assert.ok(audit.rowCount>=9);
 }finally{
  for(const w of [tenant,other]){for(const table of ['outreach_campaigns','outreach_connections','workflow_versions','workflows','finance_entries','finance_counters','record_links','activities','records','object_definitions','pipelines','dashboards','outbox','audit_events','usage_ledger','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[w]);await admin.query('DELETE FROM workspaces WHERE id=$1',[w]);}
  await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);await admin.end();
 }
});
test.after(()=>pool.end());
