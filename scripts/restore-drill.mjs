import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,readdirSync,readlinkSync,rmSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import path from 'node:path';
import pg from 'pg';
import {encryptCredential,decryptCredential} from '../server/automation.mjs';

// Run explicitly with the existing private runtime .env and LOCAL_DATABASE_ADMIN_URL.
// Never starts an API/worker, writes to the source database or restores over it.
process.umask(0o077);
const root=process.cwd(),runId=randomUUID(),clone='drykraft_restore_'+runId.replaceAll('-','').slice(0,16);
const marker='drykraft-restore-drill:'+runId,started=Date.now();
const bundle=path.join(root,'.runtime','restore-drills',new Date().toISOString().replaceAll(':','-')+'_'+runId);
const sourceUrl=new URL(process.env.DATABASE_URL),adminUrl=new URL(process.env.LOCAL_DATABASE_ADMIN_URL);
assert.equal(sourceUrl.pathname,'/drykraft');assert.equal(adminUrl.hostname,sourceUrl.hostname);
assert.equal(adminUrl.port||'5432',sourceUrl.port||'5432');assert.equal(decodeURIComponent(sourceUrl.username),'drykraft_app');
adminUrl.pathname='/postgres';
const sourceAdmin=new URL(adminUrl);sourceAdmin.pathname='/drykraft';
const cloneAdmin=new URL(adminUrl);cloneAdmin.pathname='/'+clone;
const cloneApp=new URL(sourceUrl);cloneApp.pathname='/'+clone;
const qi=v=>'"'+v.replaceAll('"','""')+'"',ql=v=>"'"+v.replaceAll("'","''")+"'";
const hash=v=>createHash('sha256').update(v).digest('hex');
async function hashFile(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
const archivePaths=['server','src','scripts','public','dist','deploy','package.json','package-lock.json','index.html','tsconfig.json','vite.config.ts'];
function sourceFiles(base){const files=[];function walk(p){const s=lstatSync(path.join(base,p));if(s.isDirectory())for(const child of readdirSync(path.join(base,p)).sort())walk(p+'/'+child);else files.push({path:p,sha256:hash(s.isSymbolicLink()?'link:'+readlinkSync(path.join(base,p)):readFileSync(path.join(base,p)))});}for(const p of archivePaths)walk(p);return files;}
function tool(binary,args,postgres=false){
 const r=spawnSync(binary,args,{cwd:root,env:{...process.env,...(postgres?{PGPASSWORD:decodeURIComponent(adminUrl.password)}:{})},encoding:'utf8',timeout:300000,maxBuffer:1048576});
 // Do not echo provider secrets or record values from PostgreSQL diagnostic output.
 assert.equal(r.status,0,binary+' failed; no raw diagnostics emitted.');
 return r.stdout.trim();
}
const connectionArgs=['-h',adminUrl.hostname,'-p',adminUrl.port||'5432','-U',decodeURIComponent(adminUrl.username)];
const catalogQueries={
 relations:`SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,ARRAY(SELECT unnest(c.relacl::text[]) ORDER BY 1) AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') ORDER BY c.relname`,
 columns:`SELECT c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
 constraints:`SELECT c.relname,k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,k.conname`,
 indexes:`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
 functions:`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition,pg_get_userbyid(p.proowner) AS owner,ARRAY(SELECT unnest(p.proacl::text[]) ORDER BY 1) AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,arguments`,
 triggers:`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
 policies:`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`,
 sequences:`SELECT c.relname,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname`,
 extensions:`SELECT extname,extversion FROM pg_extension ORDER BY extname`
};
async function sequenceValues(c){const result={};for(const s of (await c.query(catalogQueries.sequences)).rows)result[s.relname]=(await c.query('SELECT last_value::text,is_called FROM public.'+qi(s.relname))).rows[0];return result;}
async function fingerprint(c){
 await c.query("SET TIME ZONE 'UTC'");
 const catalog={};for(const [key,sql] of Object.entries(catalogQueries))catalog[key]=(await c.query(sql)).rows;
 const tables=[];
 // ponytail: sorted row hashes use ~64 bytes/row plus sort space per table; use streaming external merge for multi-million-row drills.
 for(const table of catalog.relations.filter(t=>['r','p','m'].includes(t.relkind))){
  const result=(await c.query(`SELECT count(*)::text AS rows,encode(sha256(convert_to(coalesce(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS sha256 FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS row_hash FROM public.${qi(table.relname)} t) x`)).rows[0];
  tables.push({table:table.relname,...result});
 }
 return {catalog_sha256:hash(JSON.stringify(catalog)),tables,sequences:await sequenceValues(c)};
}
const admin=new pg.Client({connectionString:adminUrl.toString()}),source=new pg.Client({connectionString:sourceAdmin.toString()});
let restored,app,created=false,stage='preflight',snapshotOpen=false,report;
try {
 await admin.connect();await source.connect();
 assert.equal((await source.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname<>'public' AND nspname<>'information_schema' AND nspname NOT LIKE 'pg_%'")).rows[0].n,0,'Add verification for other application schemas before drilling this database.');
 assert.equal((await source.query('SELECT count(*)::int AS n FROM pg_largeobject_metadata')).rows[0].n,0,'Add large-object verification before drilling this database.');
 const role=(await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='drykraft_app'")).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
 const database=(await source.query('SELECT encoding,datcollate,datctype,datlocprovider FROM pg_database WHERE datname=current_database()')).rows[0];assert.equal(database.datlocprovider,'c','This drill currently requires a libc database locale.');
 mkdirSync(bundle,{recursive:true,mode:0o700});assert.equal(lstatSync(bundle).mode&0o777,0o700);
 stage='snapshot';await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');snapshotOpen=true;
 const snapshot=(await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
 const expected=await fingerprint(source),files=sourceFiles(root);
 const probeTenant=randomUUID(),probePlaintext={test:randomUUID()},probeCiphertext=encryptCredential(probeTenant,probePlaintext);
 const runtime=readFileSync(path.join(root,'.env'),'utf8'),savedEnv=parseEnv(runtime);assert.equal(savedEnv.DATABASE_URL,process.env.DATABASE_URL);assert.equal(savedEnv.ENCRYPTION_KEY,process.env.ENCRYPTION_KEY);assert.match(savedEnv.ENCRYPTION_KEY,/^[a-f0-9]{64}$/i);
 writeFileSync(path.join(bundle,'runtime.env'),runtime,{mode:0o600,flag:'wx'});
 stage='backup';
 const dump=path.join(bundle,'database.dump'),archive=path.join(bundle,'application.tar.gz');
 const dumpVersion=tool(process.env.PG_DUMP_BIN||'pg_dump',['--version']);
 tool(process.env.PG_DUMP_BIN||'pg_dump',[...connectionArgs,'-d','drykraft','-Fc','--lock-wait-timeout=5s','--snapshot='+snapshot,'-f',dump],true);
 assert.deepEqual(await sequenceValues(source),expected.sequences,'Sequence changed during the dump; rerun in a quiet window.');
 await source.query('ROLLBACK');snapshotOpen=false;
 tool('tar',['-czf',archive,...archivePaths]);assert.deepEqual(sourceFiles(root),files,'Source changed during backup; rerun after the release settles.');assert.equal(readFileSync(path.join(root,'.env'),'utf8'),runtime,'Runtime configuration changed during backup.');
 for(const f of [dump,archive]){chmodSync(f,0o600);assert.ok(lstatSync(f).size>0);}
 const backupHashes={database:await hashFile(dump),application:await hashFile(archive),runtime:await hashFile(path.join(bundle,'runtime.env'))};
 writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify({run_id:runId,created_at:new Date().toISOString(),dump_version:dumpVersion,database,expected,files,backup_sha256:backupHashes,synthetic_key_probe:{tenant_id:probeTenant,ciphertext:probeCiphertext,plaintext_sha256:hash(JSON.stringify(probePlaintext))}},null,2)+'\n',{mode:0o600,flag:'wx'});
 stage='restore';const restoreStarted=Date.now();
 await admin.query(`CREATE DATABASE ${qi(clone)} TEMPLATE template0 ENCODING ${ql((await source.query('SHOW server_encoding')).rows[0].server_encoding)} LC_COLLATE ${ql(database.datcollate)} LC_CTYPE ${ql(database.datctype)} ALLOW_CONNECTIONS false`);created=true;
 await admin.query(`COMMENT ON DATABASE ${qi(clone)} IS ${ql(marker)}`);
 await admin.query(`REVOKE CONNECT ON DATABASE ${qi(clone)} FROM PUBLIC; GRANT CONNECT ON DATABASE ${qi(clone)} TO drykraft_app; ALTER DATABASE ${qi(clone)} ALLOW_CONNECTIONS true`);
 assert.equal(await hashFile(dump),backupHashes.database);
 tool(process.env.PG_RESTORE_BIN||'pg_restore',[...connectionArgs,'-d',clone,'--single-transaction',dump],true);
 restored=new pg.Client({connectionString:cloneAdmin.toString()});await restored.connect();
 assert.deepEqual(await fingerprint(restored),expected,'Restored tables or schema do not match the exported snapshot.');
 // Prove the verifier rejects security drift, then restore the clone's original rule.
 await restored.query('ALTER TABLE records DISABLE ROW LEVEL SECURITY');
 assert.notEqual((await fingerprint(restored)).catalog_sha256,expected.catalog_sha256);
 await restored.query('ALTER TABLE records ENABLE ROW LEVEL SECURITY');
 assert.deepEqual(await fingerprint(restored),expected);
 assert.equal(await hashFile(archive),backupHashes.application);
 const extracted=path.join(bundle,'extracted');mkdirSync(extracted,{mode:0o700});tool('tar',['-xzf',archive,'-C',extracted]);assert.deepEqual(sourceFiles(extracted),files);rmSync(extracted,{recursive:true});
 stage='isolation';
 const critical=['records','workflows','workflow_versions','executions','node_executions','credentials','outbox','usage_ledger','execution_recoveries','customer_webhooks','customer_webhook_deliveries','customer_webhook_attempts','customer_webhook_operations','account_mfa','auth_mfa_challenges','account_security_events','workspace_teams','workspace_locations','workspace_team_members','workspace_location_members'];
 const secured=(await restored.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])",[critical])).rows;
 assert.equal(secured.length,critical.length);assert.ok(secured.every(t=>t.relrowsecurity&&t.relforcerowsecurity));
 const immutable=['workflow_versions','audit_events','account_security_events','billing_webhook_events','usage_ledger','finance_entries','record_imports','record_merges','api_mutations','api_request_logs','deal_stage_history','execution_recoveries','customer_webhook_attempts','customer_webhook_operations','appointment_changes','schema_migrations'];
 for(const name of immutable)assert.equal((await restored.query('SELECT has_table_privilege($1,$2,$3) AS allowed',['drykraft_app','public.'+name,'UPDATE,DELETE'])).rows[0].allowed,false,'Append-only grants widened after restore.');
 for(const column of ['tenant_id','endpoint_id','event_id','event_type','body','destination'])assert.equal((await restored.query('SELECT has_column_privilege($1,$2,$3,$4) AS allowed',['drykraft_app','public.customer_webhook_deliveries',column,'UPDATE'])).rows[0].allowed,false,'Immutable webhook envelope grant widened after restore.');
 const tenants=[probeTenant,randomUUID()],records=[randomUUID(),randomUUID()];
 for(let i=0;i<2;i++){
  await restored.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenants[i],'Synthetic restore drill','restore-'+randomUUID().slice(0,8)]);
  await restored.query("INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields) VALUES($1,'drill','Drill','Drill','[]')",[tenants[i]]);
  await restored.query("INSERT INTO records(tenant_id,id,object_key,data) VALUES($1,$2,'drill','{}')",[tenants[i],records[i]]);
 }
 app=new pg.Client({connectionString:cloneApp.toString()});await app.connect();
 assert.equal((await app.query('SELECT count(*)::int AS n FROM records')).rows[0].n,0);
 for(let i=0;i<2;i++){
  await app.query('BEGIN');await app.query("SELECT set_config('app.tenant_id',$1,true)",[tenants[i]]);
  assert.deepEqual((await app.query('SELECT id FROM records')).rows.map(r=>r.id),[records[i]]);
  await assert.rejects(app.query("INSERT INTO records(tenant_id,id,object_key,data) VALUES($1,$2,'drill','{}')",[tenants[1-i],randomUUID()]),e=>e.code==='42501');await app.query('ROLLBACK');
 }
 stage='vault';assert.equal(await hashFile(path.join(bundle,'runtime.env')),backupHashes.runtime);process.env.ENCRYPTION_KEY=parseEnv(readFileSync(path.join(bundle,'runtime.env'),'utf8')).ENCRYPTION_KEY;
 let ciphertexts=0;
 for(const table of ['credentials','workflow_webhooks','outreach_connections','customer_webhooks','calendar_connections'])for(const row of (await restored.query('SELECT tenant_id,ciphertext FROM '+qi(table))).rows){decryptCredential(row.tenant_id,row.ciphertext);ciphertexts++;}
 let mfaCiphertexts=0;
 for(const row of (await restored.query('SELECT user_id,secret_ciphertext,pending_ciphertext FROM account_mfa')).rows)for(const cipher of [row.secret_ciphertext,row.pending_ciphertext])if(cipher){const data=decryptCredential('account-mfa:'+row.user_id,cipher);assert.match(data.secret,/^[A-Z2-7]{32}$/);mfaCiphertexts++;}
 const mfaUsers=[randomUUID(),randomUUID()],mfaSecret={secret:'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'};
 for(const id of mfaUsers){await restored.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,'Synthetic MFA restore probe',id+'@example.test','not-used-by-authentication']);await restored.query('INSERT INTO account_mfa(user_id,secret_ciphertext,enabled_at) VALUES($1,$2,now())',[id,encryptCredential('account-mfa:'+id,mfaSecret)]);}
 assert.equal((await app.query('SELECT count(*)::int AS n FROM account_mfa')).rows[0].n,0);
 for(const id of mfaUsers){await app.query('BEGIN');try{await app.query("SELECT set_config('app.user_id',$1,true)",[id]);assert.deepEqual((await app.query('SELECT user_id FROM account_mfa')).rows.map(r=>r.user_id),[id]);}finally{await app.query('ROLLBACK');}}
 const mfaCipher=(await restored.query('SELECT secret_ciphertext FROM account_mfa WHERE user_id=$1',[mfaUsers[0]])).rows[0].secret_ciphertext;
 assert.deepEqual(decryptCredential('account-mfa:'+mfaUsers[0],mfaCipher),mfaSecret);assert.throws(()=>decryptCredential('account-mfa:'+mfaUsers[1],mfaCipher));
 const secret=probePlaintext,encrypted=JSON.parse(readFileSync(path.join(bundle,'manifest.json'),'utf8')).synthetic_key_probe.ciphertext;
 await restored.query("INSERT INTO credentials(tenant_id,id,name,provider,ciphertext) VALUES($1,$2,'Synthetic restore key probe','drill',$3)",[tenants[0],randomUUID(),encrypted]);
 assert.deepEqual(decryptCredential(tenants[0],(await restored.query("SELECT ciphertext FROM credentials WHERE tenant_id=$1 AND provider='drill'",[tenants[0]])).rows[0].ciphertext),secret);
 assert.throws(()=>decryptCredential(tenants[1],encrypted));
 process.env.ENCRYPTION_KEY='00'.repeat(32);assert.throws(()=>decryptCredential(tenants[0],encrypted));process.env.ENCRYPTION_KEY=savedEnv.ENCRYPTION_KEY;
 report={status:'verified',run_id:runId,tables:expected.tables.length,rows:expected.tables.reduce((n,t)=>n+Number(t.rows),0),source_files:files.length,restored_original_ciphertexts:ciphertexts,restored_original_mfa_ciphertexts:mfaCiphertexts,synthetic_mfa_key_roundtrip:true,account_mfa_isolation:true,synthetic_key_roundtrip:true,schema_tamper_detection:true,tenant_isolation:true,append_only_tables:immutable.length,restore_verification_ms:Date.now()-restoreStarted,elapsed_ms:Date.now()-started,bundle:path.relative(root,bundle),scope:'same-server PostgreSQL/schema/source/private-env drill; no worker, provider dispatch or cross-host failover'};
} catch(error){report={status:'failed',run_id:runId,stage,error_code:error.code||'CHECK_FAILED',bundle:path.relative(root,bundle)};process.exitCode=1;}
finally {
 if(app)await app.end();if(restored)await restored.end();if(snapshotOpen)await source.query('ROLLBACK');await source.end();
 if(created){const own=(await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[clone])).rows[0];assert.equal(own?.marker,marker);assert.match(clone,/^drykraft_restore_[a-f0-9]{16}$/);await admin.query('DROP DATABASE '+qi(clone)+' WITH (FORCE)');}
 await admin.end();report.clone_removed=created;
 if(lstatSync(bundle,{throwIfNoEntry:false}))writeFileSync(path.join(bundle,'verification.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(report));
}
