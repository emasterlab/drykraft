import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../server/db.mjs';
import {initializeWorkspace,saveRecord,connectExistingLead,recordUserNames,getDefinition} from '../server/model.mjs';
import {relatedRecords,invoiceContext} from '../server/relationships.mjs';
import {financeDraft} from '../server/finance.mjs';
import {listRecords} from '../server/record-lists.mjs';
import {linkExistingRecords} from '../scripts/link-existing-records.mjs';
import pg from 'pg';

after(()=>pool.end());
async function fixture(fn){
 const c=await pool.connect(),tenant=randomUUID(),actor=randomUUID();
 try{
  await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
  await c.query('INSERT INTO workspaces(id,name,slug,settings) VALUES($1,$2,$3,$4)',[tenant,'Synthetic connected workspace','links-'+tenant.slice(0,8),{currency:'USD',currencies:['USD','INR','KWD']}]);
  await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[actor,'Synthetic owner',actor+'@example.test','unused']);
  await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenant,actor]);
  const pipeline=await initializeWorkspace(c,tenant);
  await fn(c,tenant,actor,pipeline);
 }finally{await c.query('ROLLBACK');c.workflowPrincipal=null;c.apiPrincipal=null;c.release();}
}

test('new lead immediately has one Sales deal, contact and company in the same transaction',()=>fixture(async(c,tenant,actor,pipeline)=>{
 const lead=await saveRecord(c,tenant,actor,'leads',{name:'Synthetic customer',email:'customer@example.test',phone:'+919999000001',company:'Synthetic company',value:1250,currency:'INR',owner_id:actor});
 const contact=(await c.query('SELECT * FROM records WHERE id=$1',[lead.data.person_id])).rows[0];
 const company=(await c.query('SELECT * FROM records WHERE id=$1',[lead.data.company_id])).rows[0];
 const deals=(await c.query("SELECT * FROM records WHERE object_key='deals' AND data->>'lead_id'=$1",[lead.id])).rows;
 assert.equal(deals.length,1);assert.equal(deals[0].data.pipeline_id,pipeline);assert.equal(deals[0].data.stage,'new');assert.equal(deals[0].data.status,'Open');assert.equal(deals[0].data.value,1250);assert.equal(deals[0].data.currency,'INR');assert.equal(deals[0].data.owner_id,actor);assert.equal(deals[0].data.person_id,contact.id);assert.equal(deals[0].data.company_id,company.id);
 assert.equal(contact.data.phone,lead.data.phone);assert.equal(contact.data.consent,false,'Creating a lead never authorizes outreach');assert.equal(contact.data.company_id,company.id);
 const event=(await c.query("SELECT data FROM outbox WHERE type='crm.leads.created' AND resource_id=$1",[lead.id])).rows[0];assert.equal(event.data.record.data.person_id,contact.id);
 const converted=await connectExistingLead(c,tenant,actor,lead.id,true);assert.equal(converted.person.id,contact.id);assert.equal(converted.deal.id,deals[0].id);assert.equal(converted.lead.data.status,'Converted');assert.equal((await c.query("SELECT count(*)::int AS count FROM records WHERE object_key='deals'")).rows[0].count,1);
 await assert.rejects(connectExistingLead(c,tenant,actor,lead.id,true),/already converted/);
 const retry=await connectExistingLead(c,tenant,actor,lead.id);assert.equal(retry.deal.id,deals[0].id);
}));

test('existing contact and company are reused without overwriting their details or consent',()=>fixture(async(c,tenant,actor)=>{
 const company=await saveRecord(c,tenant,actor,'companies',{name:'Example company',industry:'Existing industry'});
 const contact=await saveRecord(c,tenant,actor,'people',{name:'Existing name',email:'known@example.test',company_id:company.id,phone:'+919999000002',consent:true,status:'Customer',title:'Existing title'});
 const lead=await saveRecord(c,tenant,actor,'leads',{name:'New opportunity',email:'KNOWN@example.test',company:' example company ',value:12.345,currency:'KWD'});
 assert.equal(lead.data.person_id,contact.id);assert.equal(lead.data.company_id,company.id);assert.equal(lead.data.company,'Example company');assert.equal(lead.data.phone,contact.data.phone);
 assert.deepEqual((await c.query('SELECT data FROM records WHERE id=$1',[contact.id])).rows[0].data,contact.data);
 assert.deepEqual((await c.query('SELECT data FROM records WHERE id=$1',[company.id])).rows[0].data,company.data);
 const alias=await saveRecord(c,tenant,actor,'people',{name:'Merged alias'});await c.query('UPDATE records SET merged_into=$1 WHERE id=$2',[contact.id,alias.id]);
 const fromAlias=await saveRecord(c,tenant,actor,'leads',{name:'Another opportunity',person_id:alias.id});assert.equal(fromAlias.data.person_id,contact.id);assert.equal(fromAlias.data.email,contact.data.email);assert.equal(fromAlias.data.company_id,company.id);
}));

test('ambiguous company names and invalid related IDs fail with no partial lead/contact/deal',()=>fixture(async(c,tenant,actor)=>{
 await saveRecord(c,tenant,actor,'companies',{name:'Duplicate company'});await saveRecord(c,tenant,actor,'companies',{name:'duplicate company'});
 await assert.rejects(saveRecord(c,tenant,actor,'leads',{name:'Unlinked lead',company:'Duplicate company'}),/More than one company/);
 assert.equal((await c.query("SELECT count(*)::int AS count FROM records WHERE object_key IN ('leads','people','deals')")).rows[0].count,0);
 await assert.rejects(saveRecord(c,tenant,actor,'leads',{name:'Invalid relation',person_id:randomUUID()}),/valid value/);
 await c.query("UPDATE object_definitions SET fields=fields || '[{\"key\":\"project_code\",\"name\":\"Project code\",\"type\":\"text\",\"required\":true}]'::jsonb WHERE key='deals'");
 await c.query('SAVEPOINT rejected');await assert.rejects(saveRecord(c,tenant,actor,'leads',{name:'Required deal field',company:'Rollback company'}),/Project code is required/);await c.query('ROLLBACK TO SAVEPOINT rejected');
 assert.equal((await c.query("SELECT count(*)::int AS count FROM records WHERE object_key IN ('leads','people','deals')")).rows[0].count,0);assert.equal((await c.query("SELECT id FROM records WHERE data->>'name'='Rollback company'")).rowCount,0);
}));

test('related view connects Finance and follow-ups through the actual lead/deal/contact',()=>fixture(async(c,tenant,actor)=>{
 const lead=await saveRecord(c,tenant,actor,'leads',{name:'Invoice opportunity',email:'invoice@example.test',company:'Invoice company',value:75});
 const {deal,person}=await connectExistingLead(c,tenant,actor,lead.id),context=await invoiceContext(c,'leads',lead.id);
 assert.equal(context.deal_id,deal.id);assert.equal(context.contact_id,person.id);assert.equal(context.company_id,lead.data.company_id);assert.equal(context.customer_email,person.data.email);assert.equal(context.items[0].unit_price,'75');
 const invoice=await financeDraft(c,tenant,actor,'invoices',{...context,currency:'USD',issue_date:'2026-10-04',due_date:'2026-11-04'});
 const expense=await financeDraft(c,tenant,actor,'expenses',{name:'Linked cost',vendor:'Supplier',deal_id:deal.id,currency:'USD',spent_on:'2026-10-04',amount:'5'});
 assert.equal(expense.data.company_id,undefined,'A deal customer is never assumed to be the expense vendor');
 const task=await saveRecord(c,tenant,actor,'tasks',{name:'Invoice follow-up',record_id:invoice.id});
 const page=await relatedRecords(c,'leads',lead.id,{limit:50});
 for(const id of [deal.id,person.id,lead.data.company_id,invoice.id,expense.id])assert.ok(page.items.some(r=>r.id===id),`Lead shows ${id}`);
 assert.ok((await relatedRecords(c,'invoices',invoice.id)).items.some(r=>r.id===task.id));
 assert.ok((await relatedRecords(c,'companies',lead.data.company_id)).items.some(r=>r.id===invoice.id));
 const first=await relatedRecords(c,'leads',lead.id,{limit:2});assert.equal(first.items.length,2);assert.equal(first.next_offset,2);const next=await relatedRecords(c,'leads',lead.id,{limit:2,offset:first.next_offset});assert.ok(next.items.every(r=>!first.items.some(v=>v.id===r.id)));
 await saveRecord(c,tenant,actor,'people',{...person.data,email:'changed@example.test'},person.id,person.version);assert.equal((await c.query('SELECT data FROM records WHERE id=$1',[invoice.id])).rows[0].data.customer_email,'invoice@example.test','Saved invoice customer snapshot is retained');
 const unrelated=await saveRecord(c,tenant,actor,'people',{name:'Unrelated person'});assert.equal((await relatedRecords(c,'people',unrelated.id)).total,0);
 const survivor=await saveRecord(c,tenant,actor,'people',{name:'Remaining contact',email:'remaining@example.test'});await c.query('UPDATE records SET merged_into=$1 WHERE id=$2',[survivor.id,person.id]);
 assert.ok((await relatedRecords(c,'people',survivor.id)).items.some(r=>r.id===invoice.id),'Frozen financial alias appears on the remaining contact');
 assert.ok((await relatedRecords(c,'invoices',invoice.id)).items.some(r=>r.id===survivor.id),'Frozen invoice opens the remaining contact');
}));

test('lead contact/company edits follow the linked deal while negotiated Sales values are preserved',()=>fixture(async(c,tenant,actor)=>{
 const lead=await saveRecord(c,tenant,actor,'leads',{name:'Connected edits',company:'First company',value:50});const original=(await connectExistingLead(c,tenant,actor,lead.id)).deal;
 const company=await saveRecord(c,tenant,actor,'companies',{name:'Second company'}),person=await saveRecord(c,tenant,actor,'people',{name:'Second contact',company_id:company.id});
 await saveRecord(c,tenant,actor,'deals',{...original.data,value:75},original.id,original.version);
 const updated=await saveRecord(c,tenant,actor,'leads',{...lead.data,person_id:person.id,company_id:company.id,value:100},lead.id,lead.version);
 const linked=(await connectExistingLead(c,tenant,actor,updated.id)).deal;assert.equal(linked.data.person_id,person.id);assert.equal(linked.data.company_id,company.id);assert.equal(linked.data.value,75);
 const independent=await saveRecord(c,tenant,actor,'people',{name:'Independently selected contact'});const ownDeal=await saveRecord(c,tenant,actor,'deals',{...linked.data,person_id:independent.id},linked.id,linked.version);
 await saveRecord(c,tenant,actor,'leads',{...updated.data,person_id:lead.data.person_id},updated.id,updated.version);assert.equal((await c.query('SELECT data FROM records WHERE id=$1',[ownDeal.id])).rows[0].data.person_id,independent.id);
}));

test('required custom Sales details are accepted atomically without overriding protected deal fields',()=>fixture(async(c,tenant,actor)=>{
 await c.query("UPDATE object_definitions SET fields=fields || '[{\"key\":\"project_code\",\"name\":\"Project code\",\"type\":\"text\",\"required\":true}]'::jsonb WHERE key='deals'");
 const lead=await saveRecord(c,tenant,actor,'leads',{name:'Customizable lead'},null,null,null,{dealValues:{project_code:'REVIEWED-123'}});const deal=(await connectExistingLead(c,tenant,actor,lead.id)).deal;assert.equal(deal.data.project_code,'REVIEWED-123');
 await c.query('SAVEPOINT protected');await assert.rejects(saveRecord(c,tenant,actor,'leads',{name:'Unapproved Sales override'},null,null,null,{dealValues:{stage:'won'}}),/must be a custom deal field/);await c.query('ROLLBACK TO SAVEPOINT protected');
 assert.equal((await c.query("SELECT id FROM records WHERE object_key='leads'")).rowCount,1);
}));

test('historical repair is idempotent, places existing leads/deals in Sales and retains financial snapshots',()=>fixture(async(c,tenant,actor)=>{
 const person=randomUUID(),lead=randomUUID(),deal=randomUUID();
 for(const [id,key,data] of [[person,'people',{name:'Legacy person',email:'legacy@example.test',company:'Legacy company',consent:true}],[lead,'leads',{name:'Legacy lead',email:'legacy@example.test',company:'Legacy company',currency:'USD',value:50}],[deal,'deals',{name:'Existing manual opportunity',person_id:person,company:'Legacy company',currency:'USD',value:75,status:'Open'}]])await c.query('INSERT INTO records(tenant_id,id,object_key,data,created_by) VALUES($1,$2,$3,$4,$5)',[tenant,id,key,data,actor]);
 const draft=await financeDraft(c,tenant,actor,'invoices',{name:'Frozen invoice',customer_name:'Original customer snapshot',customer_email:'original@example.test',contact_id:person,deal_id:deal,currency:'USD',issue_date:'2026-10-04',due_date:'2026-11-04',items:[{description:'Original line',quantity:'1',unit_price:'75'}]});
 const frozen=(await c.query("UPDATE records SET data=data || '{\"status\":\"Issued\",\"invoice_number\":\"LEGACY-001\"}'::jsonb WHERE id=$1 RETURNING *",[draft.id])).rows[0];
 await c.query('UPDATE outbox SET published_at=now() WHERE tenant_id=$1',[tenant]);
 await c.query('COMMIT');
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  const first=await linkExistingRecords({workspaceId:tenant});assert.equal(first.skipped.length,0);assert.equal(first.updated.people,1);assert.equal(first.updated.leads,1);assert.equal(first.updated.deals,1);assert.equal(first.updated.finance,1);
  const second=await linkExistingRecords({workspaceId:tenant});assert.deepEqual(second.updated,{people:0,leads:0,deals:0,finance:0});
  assert.equal((await admin.query("SELECT id FROM records WHERE tenant_id=$1 AND object_key='deals' AND data->>'lead_id'=$2",[tenant,lead])).rowCount,1);
  assert.deepEqual((await admin.query('SELECT * FROM records WHERE tenant_id=$1 AND id=$2',[tenant,frozen.id])).rows[0],frozen);
  assert.equal((await admin.query('SELECT id FROM outbox WHERE tenant_id=$1 AND published_at IS NULL',[tenant])).rowCount,0,'Historical repair never replays the customer automations');
 }finally{
  for(const table of ['outbox','activities','finance_entries','record_links','records','dashboards','pipelines','object_definitions','audit_events','usage_ledger','workspace_billing','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);await admin.query('DELETE FROM users WHERE id=$1',[actor]);await admin.end();
 }
}));

test('connected context includes saved appointments, campaign enrollments and workflow runs without sending',()=>fixture(async(c,tenant,actor)=>{
 const lead=await saveRecord(c,tenant,actor,'leads',{name:'Engagement lead',email:'engagement@example.test'}),person=lead.data.person_id;
 const calendar=randomUUID(),appointment=randomUUID();await c.query('INSERT INTO calendars(tenant_id,id,name,config) VALUES($1,$2,$3,$4)',[tenant,calendar,'Synthetic calendar',{}]);
 await c.query("INSERT INTO appointments(tenant_id,id,calendar_id,title,guest_name,guest_email,record_id,host_ids,starts_at,ends_at,blocked_start,blocked_end,timezone,source,create_hash) VALUES($1,$2,$3,'Synthetic appointment','Synthetic guest','engagement@example.test',$4,$5,'2026-10-05T10:00Z','2026-10-05T10:30Z','2026-10-05T10:00Z','2026-10-05T10:30Z','UTC','workspace','synthetic')",[tenant,appointment,calendar,person,[actor]]);
 const workflow=randomUUID(),version=randomUUID(),execution=randomUUID(),connection=randomUUID(),campaign=randomUUID();const graph={nodes:[{id:'t',type:'workflow',position:{x:0,y:0},data:{kind:'trigger.manual',label:'Synthetic trigger'}}],edges:[]};
 await c.query('INSERT INTO workflows(tenant_id,id,name,draft) VALUES($1,$2,$3,$4)',[tenant,workflow,'Synthetic workflow',graph]);await c.query('INSERT INTO workflow_versions(tenant_id,id,workflow_id,version,graph) VALUES($1,$2,$3,1,$4)',[tenant,version,workflow,graph]);
 await c.query("INSERT INTO executions(tenant_id,id,workflow_id,version_id,context,state) VALUES($1,$2,$3,$4,$5,'succeeded')",[tenant,execution,workflow,version,{record:{id:person}}]);
 await c.query("INSERT INTO outreach_connections(tenant_id,id,name,channel,provider,config,ciphertext) VALUES($1,$2,'Synthetic SMTP','email','smtp','{}','synthetic-unsent')",[tenant,connection]);
 await c.query("INSERT INTO outreach_campaigns(tenant_id,id,name,kind,channel,object_key,connection_id,steps,workflow_id) VALUES($1,$2,'Synthetic campaign','campaign','email','people',$3,'[]',$4)",[tenant,campaign,connection,workflow]);
 await c.query("INSERT INTO outreach_enrollments(tenant_id,id,campaign_id,record_id,execution_id,recipient,unsubscribe_hash) VALUES($1,$2,$3,$4,$5,'engagement@example.test',$6)",[tenant,randomUUID(),campaign,person,execution,randomUUID()]);
 assert.equal((await relatedRecords(c,'leads',lead.id,{section:'appointments'})).items[0].id,appointment);assert.equal((await relatedRecords(c,'leads',lead.id,{section:'outreach'})).items[0].campaign_id,campaign);assert.equal((await relatedRecords(c,'leads',lead.id,{section:'workflows'})).items[0].id,execution);
}));

test('restricted integration/workflow permissions cannot silently create related objects',()=>fixture(async(c,tenant,actor)=>{
 c.apiPrincipal={permissions:{leads:['read','create']}};await assert.rejects(saveRecord(c,tenant,null,'leads',{name:'Restricted API lead'}),/read access to people/);c.apiPrincipal=null;
 c.workflowPrincipal={accounts:[{permissions:{leads:['read','create'],people:['read','create']}}]};await c.query('SAVEPOINT rights');await assert.rejects(saveRecord(c,tenant,null,'leads',{name:'Restricted workflow lead'}),/read on deals/);await c.query('ROLLBACK TO SAVEPOINT rights');c.workflowPrincipal=null;
 assert.equal((await c.query("SELECT id FROM records WHERE object_key IN ('leads','people','deals')")).rowCount,0);
 const graph={nodes:[{data:{kind:'crm.create',object:'leads'}}],edges:[]};const policy=(await c.query('SELECT workflow_identity_scope($1,$2,$3) AS policy',[tenant,randomUUID(),graph])).rows[0].policy;
 for(const key of ['leads','people','companies','deals'])assert.ok(policy.permissions[key].includes('create'));
 c.workflowPrincipal={accounts:[{permissions:policy.permissions}]};const lead=await saveRecord(c,tenant,null,'leads',{name:'Authorized workflow lead',company:'Authorized company'});assert.ok(lead.data.person_id);c.workflowPrincipal=null;
 c.apiPrincipal={permissions:{leads:['read']}};const decorated=(await recordUserNames(c,await getDefinition(c,'leads'),[lead]))[0];assert.deepEqual(decorated.relation_names,{});c.apiPrincipal=null;
}));

test('pipeline filtering happens before pagination so another pipeline cannot hide new leads',()=>fixture(async(c,tenant,actor,pipeline)=>{
 const other=randomUUID();await c.query("INSERT INTO pipelines(tenant_id,id,name,stages) VALUES($1,$2,'Z Other',$3)",[tenant,other,JSON.stringify([{id:'other',name:'Other',probability:10,color:'#888888'}])]);
 await saveRecord(c,tenant,actor,'deals',{name:'Other pipeline deal',pipeline_id:other,stage:'other'});
 const lead=await saveRecord(c,tenant,actor,'leads',{name:'Visible immediately'}),page=await listRecords(c,'deals',{pipeline,limit:1});
 assert.equal(page.total,1);assert.equal(page.items[0].data.lead_id,lead.id);assert.equal(page.next_cursor,null);
}));

test('another workspace cannot be linked, looked up or queried through Related',()=>fixture(async(c,tenant,actor)=>{
 const lead=await saveRecord(c,tenant,actor,'leads',{name:'Private lead'}),other=randomUUID();await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[other,'Other synthetic workspace','other-'+other.slice(0,8)]);
 await c.query("SELECT set_config('app.tenant_id',$1,true)",[other]);await initializeWorkspace(c,other);
 await assert.rejects(relatedRecords(c,'leads',lead.id),/not found/);await assert.rejects(invoiceContext(c,'leads',lead.id),/not found/);await assert.rejects(saveRecord(c,other,actor,'leads',{name:'Foreign reference',person_id:lead.data.person_id}),/valid value/);
 await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);assert.equal((await relatedRecords(c,'leads',lead.id)).items.filter(r=>r.object_key==='deals').length,1);
}));
