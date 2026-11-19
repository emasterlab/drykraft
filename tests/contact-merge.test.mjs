import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { pool,tenantTransaction } from '../server/db.mjs';
import { initializeWorkspace,saveRecord,resolveRecord,deleteRecord,aggregate } from '../server/model.mjs';
import { mergeSchema,mergeCommitSchema,previewMerge,commitMerge } from '../server/contact-merges.mjs';
import { tokenHash } from '../server/auth.mjs';
import { encryptCredential,createExecution } from '../server/automation.mjs';
import { audience,executeOutreach,campaignGraph } from '../server/outreach.mjs';

const origin=process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000';
function call(path,body,cookie,method=body?'POST':'GET') {
  return new Promise((resolve,reject)=>{const req=http.request(origin+'/api'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});
}
test('reviewed contact merges preserve history, reject stale work, isolate tenants and stop source outreach without repeated sends',async()=>{
  const tenant=randomUUID(),other=randomUUID(),users=[randomUUID(),randomUUID(),randomUUID()],tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(v=>'drykraft_session='+v);
  const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
  const tx=fn=>tenantTransaction(tenant,fn);let source,target,deal,task,connection,campaign,execution;
  try {
    await tx(async c=>{
      await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic contact merge','merge-'+tenant.slice(0,8)]);await initializeWorkspace(c,tenant);
      for(const [i,id]of users.entries()) {
        await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,'Synthetic merge user',id+'@example.test','synthetic-session-only']);
        await c.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant,id,['owner','member','viewer'][i]]);
        await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),id,tenant]);
      }
      target=await saveRecord(c,tenant,users[0],'people',{name:'Asha Patel',email:'asha-current@example.test',tags:['Customer'],consent:false});
      source=await saveRecord(c,tenant,users[0],'people',{name:'Asha P.',email:'asha-source@example.test',phone:'+919876543210',tags:['Customer','Priority'],consent:true});
      deal=await saveRecord(c,tenant,users[0],'deals',{name:'Synthetic proposal',person_id:source.id});task=await saveRecord(c,tenant,users[0],'tasks',{name:'Synthetic follow-up',record_id:source.id});
      await c.query('INSERT INTO activities(tenant_id,id,record_id,actor_id,type,body) VALUES($1,$2,$3,$4,$5,$6)',[tenant,randomUUID(),source.id,users[0],'note','Original source note']);
      await c.query('INSERT INTO record_links(tenant_id,source_id,target_id,relation) VALUES($1,$2,$3,$4),($1,$2,$5,$4)',[tenant,task.id,source.id,'fixture',target.id]);
      connection=randomUUID();await c.query("INSERT INTO outreach_connections(tenant_id,id,name,channel,provider,ciphertext,verified_at) VALUES($1,$2,'Synthetic connection','sms','curl',$3,now())",[tenant,connection,encryptCredential(tenant,{url:'https://example.test/send',headers:{},body:{to:'{{recipient}}',message:'{{message}}'}})]);
      campaign={id:randomUUID(),name:'Synthetic stopped sequence',kind:'sequence',channel:'sms',object_key:'people',list_id:null,connection_id:connection,workflow_id:randomUUID(),steps:[{body:'Synthetic',waitHours:720}],status:'active',version:1};
      const graph=campaignGraph(campaign),version=randomUUID();await c.query('INSERT INTO workflows(tenant_id,id,name,draft) VALUES($1,$2,$3,$4)',[tenant,campaign.workflow_id,campaign.name,graph]);
      await c.query('INSERT INTO workflow_versions(tenant_id,id,workflow_id,version,graph) VALUES($1,$2,$3,1,$4)',[tenant,version,campaign.workflow_id,graph]);
      await c.query('INSERT INTO outreach_campaigns(tenant_id,id,name,kind,channel,object_key,connection_id,workflow_id,steps,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[tenant,campaign.id,campaign.name,campaign.kind,campaign.channel,campaign.object_key,connection,campaign.workflow_id,JSON.stringify(campaign.steps),'active']);
      execution=await createExecution(c,tenant,{id:campaign.workflow_id},{id:version,graph},{record:source});await c.query("UPDATE executions SET state='waiting',resume_at=now()+interval '365 days' WHERE id=$1",[execution.id]);
      await c.query('INSERT INTO outreach_enrollments(tenant_id,id,campaign_id,record_id,execution_id,recipient,unsubscribe_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenant,randomUUID(),campaign.id,source.id,execution.id,source.data.phone,tokenHash(randomBytes(32).toString('hex'))]);
    });
    const invoice=await call('/finance/invoices',{data:{name:'Synthetic history',customer_name:'Original Asha P.',customer_email:source.data.email,contact_id:source.id,currency:'USD',issue_date:'2026-10-02',due_date:'2026-10-30',items:[{description:'Synthetic service',quantity:'1',unit_price:'1'}]}},cookies[0]);assert.equal(invoice.status,201);
    const issued=await call('/finance/invoices/'+invoice.data.id+'/action',{action:'issue',version:invoice.data.version},cookies[0]);assert.equal(issued.status,200);
    const draft=await call('/finance/invoices',{data:{name:'Synthetic draft',customer_name:'Original Asha P.',contact_id:source.id,currency:'USD',issue_date:'2026-10-02',due_date:'2026-10-30',items:[{description:'Synthetic service',quantity:'1',unit_price:'2'}]}},cookies[0]);assert.equal(draft.status,201);
    const input=mergeSchema.parse({contacts:[{id:target.id,version:target.version},{id:source.id,version:source.version}],target_id:target.id,take_source:['email']});
    assert.throws(()=>mergeCommitSchema.parse({...input,id:randomUUID(),review_token:'a'.repeat(64),confirmed:false}));
    for(const cookie of cookies.slice(1))assert.equal((await call('/record-tools/people/merge/preview',input,cookie)).status,403);
    await assert.rejects(tx(c=>previewMerge(c,tenant,{...input,take_source:['consent']})),e=>e.status===400);
    await assert.rejects(tx(c=>previewMerge(c,tenant,{...input,contacts:input.contacts.map(r=>({...r,version:r.version+1}))})),e=>e.status===409);
    await assert.rejects(tenantTransaction(other,c=>previewMerge(c,other,input)),e=>e.status===404);
    let preview=await tx(c=>previewMerge(c,tenant,input));assert.equal(preview.data.consent,false);assert.deepEqual(preview.data.tags,['Customer','Priority']);assert.equal(preview.data.phone,source.data.phone);assert.equal(preview.effects.financial_history,1);assert.equal(preview.effects.relationships,3);assert.equal(preview.effects.stopped_sequences,1);
    await call('/activities',{record_id:source.id,body:'Arrived after review'},cookies[0]);
    let commit=mergeCommitSchema.parse({...input,id:randomUUID(),review_token:preview.review_token,confirmed:true});
    assert.equal((await call('/record-tools/people/merge/commit',commit,cookies[0])).status,409,'Notes changed after review');
    assert.equal((await tx(c=>c.query('SELECT merged_into FROM records WHERE id=$1',[source.id]))).rows[0].merged_into,null);
    preview=await tx(c=>previewMerge(c,tenant,input));commit={...commit,review_token:preview.review_token};
    await tx(c=>saveRecord(c,tenant,users[0],'tasks',{...task.data,description:'Changed after relationship review'},task.id,task.version));
    await assert.rejects(tx(c=>commitMerge(c,tenant,users[0],commit)),e=>e.status===409,'A related record changed after review');
    for(const cookie of cookies.slice(1))assert.equal((await call('/record-tools/people/merge/commit',commit,cookie)).status,403);
    // A writer holding the shared contact lock can finish its note; merge then sees that change and rejects the old review.
    preview=await tx(c=>previewMerge(c,tenant,input));commit={...commit,review_token:preview.review_token};
    const writer=await pool.connect();let pending;
    try {
      await writer.query('BEGIN');await writer.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);await resolveRecord(writer,source.id);
      pending=tx(c=>commitMerge(c,tenant,users[0],commit));pending.catch(()=>{});
      await writer.query('INSERT INTO activities(tenant_id,id,record_id,actor_id,type,body) VALUES($1,$2,$3,$4,$5,$6)',[tenant,randomUUID(),source.id,users[0],'note','Concurrent note is preserved']);
      await writer.query('COMMIT');await assert.rejects(pending,e=>e.status===409);
    }finally{await writer.query('ROLLBACK');writer.release();}
    preview=await tx(c=>previewMerge(c,tenant,input));commit={...commit,review_token:preview.review_token};
    const results=await Promise.all([tx(c=>commitMerge(c,tenant,users[0],commit)),tx(c=>commitMerge(c,tenant,users[0],commit))]);
    // Either concurrent caller can receive the fresh Date fields or their cached JSON representation.
    assert.deepEqual(...results.map(result=>JSON.parse(JSON.stringify(result))),'Simultaneous identical retries return one committed response');
    const remaining=results[0].record;assert.equal(remaining.data.email,source.data.email);assert.equal(remaining.data.consent,false);assert.equal(remaining.version,2);
    assert.equal((await tx(c=>c.query('SELECT count(*)::int AS n FROM record_merges'))).rows[0].n,1);
    const mergedEvent=(await tx(c=>c.query("SELECT data FROM outbox WHERE type='crm.people.merged' AND resource_id=$1",[target.id]))).rows;
    assert.equal(mergedEvent.length,1);assert.equal(mergedEvent[0].data.record.id,target.id);assert.equal(mergedEvent[0].data.sourceId,source.id);assert.deepEqual(mergedEvent[0].data.effects,results[0].effects);
    await assert.rejects(tx(c=>commitMerge(c,tenant,users[0],{...commit,take_source:[]})),e=>e.status===409);
    const alias=await tx(c=>resolveRecord(c,source.id,'people'));assert.equal(alias.id,target.id);
    assert.equal((await call('/records/people/'+source.id,undefined,cookies[0])).data.id,target.id);
    assert.equal((await call('/records/people?limit=100',undefined,cookies[0])).data.total,1);
    assert.equal((await tx(c=>aggregate(c,{object:'people',operation:'count'})))[0].value,1);
    assert.equal((await tx(c=>audience(c,campaign))).total,1);
    await assert.rejects(tx(c=>saveRecord(c,tenant,users[0],'people',source.data,source.id,source.version)),e=>e.status===409);
    await assert.rejects(tx(c=>deleteRecord(c,tenant,users[0],'people',target.id,remaining.version)),e=>e.status===409);
    await assert.rejects(tx(c=>deleteRecord(c,tenant,users[0],'people',source.id,source.version)),e=>e.status===409);
    assert.equal((await call('/records/deals/'+deal.id,undefined,cookies[0])).data.data.person_id,target.id);
    assert.equal((await call('/records/tasks/'+task.id,undefined,cookies[0])).data.data.record_id,target.id);
    const currentDraft=(await call('/records/invoices/'+draft.data.id,undefined,cookies[0])).data;assert.equal(currentDraft.data.contact_id,target.id);assert.equal(currentDraft.data.customer_name,draft.data.data.customer_name);assert.equal(currentDraft.data.total_minor,draft.data.data.total_minor);
    assert.equal((await tx(c=>c.query("SELECT count(*)::int AS n FROM outbox WHERE type='finance.invoice.updated' AND resource_id=$1",[draft.data.id]))).rows[0].n,1,'Draft relationship change uses the shared finance event');
    assert.deepEqual((await call('/records/invoices/'+issued.data.id,undefined,cookies[0])).data,issued.data,'Issued invoice, number, issuer and original contact snapshot are unchanged');
    assert.equal((await call('/activities?record_id='+source.id,undefined,cookies[0])).data.length,3);
    assert.equal((await call('/activities',{record_id:source.id,body:'Note using old address'},cookies[0])).data.record_id,target.id);
    const related=await tx(c=>saveRecord(c,tenant,users[0],'tasks',{name:'Alias task',record_id:source.id}));assert.equal(related.data.record_id,target.id);
    assert.equal((await tx(c=>c.query('SELECT count(*)::int AS n FROM record_links WHERE target_id=$1',[target.id]))).rows[0].n,1,'Duplicate graph links collapse');
    assert.equal((await tx(c=>c.query('SELECT state FROM executions WHERE id=$1',[execution.id]))).rows[0].state,'cancelled');
    let sends=0;const delivery=await executeOutreach(tenant,execution,{id:'late-send',kind:'outreach.send',connectionId:connection,recordId:source.id,body:'Synthetic'}, {},async()=>{sends++;return {id:'never'};});assert.equal(delivery.status,'skipped');assert.equal(sends,0);
    assert.equal((await tenantTransaction(other,c=>c.query('SELECT * FROM record_merges'))).rowCount,0);assert.equal((await pool.query('SELECT * FROM record_merges')).rowCount,0);
    await assert.rejects(tx(c=>c.query('UPDATE record_merges SET result=$1',[{}])),e=>e.code==='42501');
    await assert.rejects(tx(c=>c.query('DELETE FROM record_merges')),e=>e.code==='42501');
    // A second merge follows alias chains without modifying the first archived snapshot.
    const final=await tx(c=>saveRecord(c,tenant,users[0],'people',{name:'Asha final',consent:true}));
    const next=mergeSchema.parse({contacts:[{id:remaining.id,version:remaining.version},{id:final.id,version:final.version}],target_id:final.id});const reviewed=await tx(c=>previewMerge(c,tenant,next));
    const last=await tx(c=>commitMerge(c,tenant,users[0],mergeCommitSchema.parse({...next,id:randomUUID(),review_token:reviewed.review_token,confirmed:true})));assert.equal(last.record.data.consent,false);assert.equal((await tx(c=>resolveRecord(c,source.id))).id,final.id);
    assert.deepEqual((await tx(c=>c.query('SELECT data FROM records WHERE id=$1',[source.id]))).rows[0].data,source.data);
  }finally {
    for(const table of ['record_merges','finance_entries','finance_counters','outreach_receipts','outreach_messages','outreach_deliveries','outreach_enrollments','outreach_campaigns','outreach_suppressions','outreach_connections','node_executions','executions','workflow_webhooks','workflow_versions','workflows','activities','record_links'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);
    await admin.query('DELETE FROM records WHERE tenant_id=$1',[tenant]);
    for(const table of ['object_definitions','pipelines','dashboards','outbox','audit_events','usage_ledger','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);
    await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();await pool.end();
  }
});
