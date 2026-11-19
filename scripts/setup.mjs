import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

if(!existsSync('.env')) {
  const appPassword=randomBytes(24).toString('hex');
  const workerPassword=randomBytes(24).toString('hex');
  writeFileSync('.env',`DATABASE_URL=postgresql://drykraft_app:${appPassword}@localhost:5432/drykraft\nWORKER_DATABASE_URL=postgresql://drykraft_worker:${workerPassword}@localhost:5432/drykraft\nREDIS_URL=redis://localhost:6379/0\nENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nAPP_DOMAIN=localhost\nPORT=4000\nNODE_ENV=development\nDEMO_ENABLED=true\n`,{mode:0o600});
}
process.loadEnvFile('.env');
if(!process.env.PLATFORM_DATABASE_URL){
  const platformUrl=new URL(process.env.DATABASE_URL);platformUrl.username='drykraft_platform';platformUrl.password=randomBytes(24).toString('hex');
  appendFileSync('.env',`\nPLATFORM_DATABASE_URL=${platformUrl}\n`);process.env.PLATFORM_DATABASE_URL=platformUrl.toString();
}
if(!process.env.MAIL_DATABASE_URL){
  const mailUrl=new URL(process.env.DATABASE_URL);mailUrl.username='drykraft_mail';mailUrl.password=randomBytes(24).toString('hex');
  appendFileSync('.env',`\nMAIL_DATABASE_URL=${mailUrl}\n`);process.env.MAIL_DATABASE_URL=mailUrl.toString();
}
if(!process.env.RESELLER_API_DATABASE_URL){
  const apiUrl=new URL(process.env.DATABASE_URL);apiUrl.username='drykraft_reseller_api';apiUrl.password=randomBytes(24).toString('hex');
  appendFileSync('.env',`\nRESELLER_API_DATABASE_URL=${apiUrl}\n`);process.env.RESELLER_API_DATABASE_URL=apiUrl.toString();
}
if(!process.env.RESELLER_DATABASE_URL){
  const staffUrl=new URL(process.env.DATABASE_URL);staffUrl.username='drykraft_reseller';staffUrl.password=randomBytes(24).toString('hex');
  appendFileSync('.env',`\nRESELLER_DATABASE_URL=${staffUrl}\n`);process.env.RESELLER_DATABASE_URL=staffUrl.toString();
}
const adminUrl=process.env.LOCAL_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const admin=new pg.Client({connectionString:adminUrl});
await admin.connect();
if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='drykraft'")).rowCount) await admin.query('CREATE DATABASE drykraft');
for(const [name,env] of [['drykraft_app','DATABASE_URL'],['drykraft_worker','WORKER_DATABASE_URL'],['drykraft_platform','PLATFORM_DATABASE_URL'],['drykraft_mail','MAIL_DATABASE_URL'],['drykraft_reseller_api','RESELLER_API_DATABASE_URL'],['drykraft_reseller','RESELLER_DATABASE_URL']]) {
  const password=new URL(process.env[env]).password;
  if(!/^[a-f0-9]{48}$/.test(password)) throw new Error('Use the generated local application credentials for initial setup.');
  if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount) await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' ${name==='drykraft_worker'?'BYPASSRLS':['drykraft_platform','drykraft_mail','drykraft_reseller_api','drykraft_reseller'].includes(name)?'NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS':''}`);
  else await admin.query(`ALTER ROLE ${name} LOGIN PASSWORD '${password}'`);
}
await admin.end();
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/drykraft';
const migration=new pg.Client({connectionString:databaseUrl.toString()});
await migration.connect();
await migration.query(readFileSync('server/schema.sql','utf8'));
for(const file of readdirSync('server/migrations').filter(f=>f.endsWith('.sql')).sort())await migration.query(readFileSync(`server/migrations/${file}`,'utf8'));
const tenantTables=['finance_counters','finance_entries','object_definitions','records','record_links','activities','pipelines','dashboards','workflows','workflow_versions','workflow_webhooks','executions','node_executions','credentials','outbox','audit_events','usage_ledger'];
for(const table of tenantTables) {
  await migration.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  if(!(await migration.query('SELECT 1 FROM pg_policies WHERE tablename=$1 AND policyname=\'tenant_isolation\'',[table])).rowCount) {
    await migration.query(`CREATE POLICY tenant_isolation ON ${table} USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)`);
  }
}
await migration.query(`GRANT USAGE ON SCHEMA public TO drykraft_app,drykraft_worker;
  GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO drykraft_app;
  REVOKE UPDATE,DELETE ON workflow_versions,audit_events,account_security_events,billing_webhook_events,usage_ledger,finance_entries,record_imports,record_merges,api_mutations,api_request_logs,deal_stage_history,execution_recoveries,customer_webhook_deliveries,customer_webhook_attempts,customer_webhook_operations,appointment_changes,schema_migrations FROM drykraft_app;
  GRANT UPDATE(state,attempts,cycle_attempts,version,next_attempt_at,last_status,last_error,completed_at) ON customer_webhook_deliveries TO drykraft_app;
  REVOKE DELETE ON workspace_billing,billing_checkouts FROM drykraft_app;
  REVOKE DELETE ON invitations FROM drykraft_app;
  REVOKE DELETE ON workspace_teams,workspace_locations FROM drykraft_app;
  REVOKE ALL ON platform_accounts,platform_auth_challenges,platform_sessions,platform_audit,platform_workspace_controls,platform_settings,platform_user_controls,platform_workspace_invitations,platform_provisioning_operations,platform_plans,platform_plan_versions,platform_workspace_entitlements,platform_invitation_operations,platform_mail_transport,platform_mail_templates,platform_mail_template_versions,platform_mail_jobs,account_password_reset_mail_jobs,reseller_organizations,reseller_grant_versions,reseller_retail_plans,reseller_retail_plan_versions,reseller_workspace_links,reseller_api_keys,reseller_api_requests,reseller_accounts,reseller_memberships,reseller_auth_challenges,reseller_sessions,reseller_audit,reseller_member_operations,reseller_plan_operations FROM drykraft_app,drykraft_worker;
  REVOKE DELETE ON calendars,appointments,calendar_reminders,calendar_connections,calendar_exports FROM drykraft_app;
  GRANT EXECUTE ON FUNCTION resolve_calendar_booking(uuid),resolve_appointment_management(uuid) TO drykraft_app;
  GRANT SELECT ON calendar_connections,calendar_reminders TO drykraft_worker;
  REVOKE DELETE ON service_accounts,api_keys,customer_webhooks FROM drykraft_app;
  REVOKE UPDATE ON service_accounts FROM drykraft_app;
  GRANT UPDATE(name,permissions,disabled,version,updated_at) ON service_accounts TO drykraft_app;
  GRANT EXECUTE ON FUNCTION resolve_workflow_webhook(text) TO drykraft_app;
  GRANT EXECUTE ON FUNCTION resolve_mfa_challenge(text) TO drykraft_app;
  GRANT SELECT ON workspaces,outbox,executions,workflows,workflow_versions,customer_webhook_deliveries TO drykraft_worker;`);
await migration.end();
const {pool,tenantTransaction}=await import('../server/db.mjs');
const {monetaryFields}=await import('../server/currency.mjs');
const {initializeWorkspace,saveRecord,builtIns}=await import('../server/model.mjs');
const {hashPassword}=await import('../server/auth.mjs');
if(process.env.DEMO_ENABLED==='true' && !(await pool.query("SELECT 1 FROM workspaces WHERE slug='demo'")).rowCount) {
  const tenantId=randomUUID(),userId=randomUUID();
  const password=await hashPassword(randomBytes(32).toString('hex'));
  await tenantTransaction(tenantId,async client=>{
    await client.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,'demo@drykraft.local','Alex Morgan',password]);
    await client.query('INSERT INTO workspaces(id,name,slug,settings) VALUES($1,$2,$3,$4)',[tenantId,'DryKraft demo','demo',{currency:'USD',timezone:'Asia/Kolkata',demo:true}]);
    await client.query('INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,$3)',[userId,tenantId,'owner']);
    const pipeline=await initializeWorkspace(client,tenantId);
    const companies=['Acme Studio','Northstar Labs','Orbit Ventures','Bloom & Co','Vertex Digital','Sonder Group','Linear Works','Atlas Partners'];
    for(const [i,name] of companies.entries()) await saveRecord(client,tenantId,userId,'companies',{name,domain:`${name.toLowerCase().replace(/[^a-z]/g,'')}.example`,industry:['Technology','Design','Consulting','Retail'][i%4],size:10+i*14,city:['Bengaluru','Mumbai','London','New York'][i%4],owner:'Alex Morgan'});
    const names=['Olivia Chen','James Wilson','Priya Sharma','Noah Williams','Emma Thompson','Arjun Patel','Sophia Lee','Lucas Martin','Isabella Garcia','Liam Anderson','Zara Ahmed','Ethan Scott','Mia Robinson','Leo Bennett','Ava Johnson','Rohan Mehta','Chloe Davis','Oscar Taylor','Amelia Brown','Daniel Kim','Nina Kapoor','Mason White','Harper Lewis','Sofia Rossi'];
    const sources=['Website','Referral','Campaign','Outbound','Website'];
    const people=[];
    for(const [i,name] of names.entries()) {
      people.push(await saveRecord(client,tenantId,userId,'people',{name,email:`${name.toLowerCase().replace(' ','.')}@example.com`,company:companies[i%8],title:['Founder','Head of Sales','Director','Marketing Lead'][i%4],status:i%5===0?'Customer':'Lead',source:sources[i%5],tags:i%3===0?['Priority']:[],owner:['Alex Morgan','Jordan Ellis'][i%2],consent:i%3!==0}));
      if(i<20) await saveRecord(client,tenantId,userId,'leads',{name,company:companies[i%8],email:`${name.toLowerCase().replace(' ','.')}@example.com`,source:sources[i%5],status:['New','Qualified','Contacted'][i%3],score:40+i*3,owner:'Alex Morgan',value:2500+i*450});
    }
    const titles=['Annual partnership','Enterprise rollout','Brand refresh','Growth subscription','Platform expansion','Team onboarding','Services agreement','Pilot program','Regional launch','Operations suite','Customer success','Product licensing','Sales enablement','Strategic account','Workspace migration','Automation package'];
    const stages=['new','qualified','proposal','negotiation','won'];
    for(const [i,name] of titles.entries()) await saveRecord(client,tenantId,userId,'deals',{name,company:companies[i%8],person_id:people[i].id,value:[12000,8500,6400,18000,4200,9600,25000,5600][i%8],pipeline_id:pipeline,stage:stages[i%5],status:i%5===4?'Won':'Open',probability:[10,30,60,80,100][i%5],close_date:new Date(Date.now()+(7+i)*86400000).toISOString().slice(0,10),owner:['Alex Morgan','Jordan Ellis'][i%2]});
    for(const [i,name] of ['Send proposal to Northstar','Follow up with Olivia Chen','Prepare product walkthrough','Review the Acme contract','Qualify inbound enquiries','Update quarterly forecast'].entries()) {
      await saveRecord(client,tenantId,userId,'tasks',{name,status:i===4?'Done':'To do',priority:i%2===0?'High':'Medium',due_date:new Date(Date.now()+i*86400000).toISOString().slice(0,10),owner:'Alex Morgan',record_id:people[i].id});
      await client.query('INSERT INTO activities(tenant_id,id,record_id,actor_id,type,body) VALUES($1,$2,$3,$4,$5,$6)',[tenantId,randomUUID(),people[i].id,userId,'note',['Initial discovery call completed.','Interested in the enterprise plan.','Proposal sent for review.'][i%3]]);
    }
    const graph={nodes:[
      {id:'trigger',type:'workflow',position:{x:100,y:140},data:{kind:'trigger.event',label:'New lead',event:'crm.leads.created'}},
      {id:'condition',type:'workflow',position:{x:440,y:140},data:{kind:'condition',label:'Check lead score',field:'record.data.score',operator:'gte',value:60}},
      {id:'task',type:'workflow',position:{x:780,y:60},data:{kind:'crm.create',label:'Create follow-up task',object:'tasks',values:{name:'Follow up with {{record.data.name}}',status:'To do',priority:'High',owner:'Alex Morgan'}}},
      {id:'wait',type:'workflow',position:{x:780,y:280},data:{kind:'wait',label:'Wait 1 minute',seconds:60}},
    ],edges:[{id:'e1',source:'trigger',target:'condition'},{id:'e2',source:'condition',target:'task',sourceHandle:'true',label:'Qualified'},{id:'e3',source:'condition',target:'wait',sourceHandle:'false',label:'Nurture'}]};
    await client.query('INSERT INTO workflows(tenant_id,id,name,description,draft) VALUES($1,$2,$3,$4,$5)',[tenantId,randomUUID(),'Welcome a new lead','Qualify new leads and create a follow-up task.',graph]);
    // Seed events are historical samples; publishing a workflow must not replay them.
    await client.query('UPDATE outbox SET published_at=now() WHERE tenant_id=$1',[tenantId]);
  });
  console.log('Created the clearly labelled sample workspace.');
}
// Install new built-in objects without replacing fields customized by existing workspaces.
for(const {id,settings} of (await pool.query('SELECT id,settings FROM workspaces')).rows)await tenantTransaction(id,async c=>{
  if(!settings.currencies)await c.query("UPDATE workspaces SET settings=settings || jsonb_build_object('currencies',$1::jsonb) WHERE id=$2",[JSON.stringify([...new Set([settings.currency || 'USD','USD','INR','EUR','KWD','GBP','AUD','CAD','JPY'])]),id]);
  for(const d of (await c.query('SELECT * FROM object_definitions')).rows){
    const fields=monetaryFields(d.fields);if(fields.length!==d.fields.length)await c.query('UPDATE object_definitions SET fields=$1 WHERE key=$2',[JSON.stringify(fields),d.key]);
    if(fields.some(f=>f.type==='currency'))await c.query("UPDATE records SET data=data || jsonb_build_object('currency',$1::text) WHERE object_key=$2 AND data->>'currency' IS NULL",[settings.currency || 'USD',d.key]);
  }
  for(const o of builtIns.filter(o=>['invoices','purchase_orders','expenses'].includes(o.key)))await c.query('INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields,built_in) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING',[id,o.key,o.name,o.singular_name,JSON.stringify(o.fields)]);
});
await pool.end();
mkdirSync('.runtime',{recursive:true});
console.log('DryKraft database, least-privilege roles, and tenant policies are ready.');
