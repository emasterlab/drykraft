import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace,saveRecord,widgetSchema,resolveWidgetDates} from '../server/model.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
function call(path,cookie,body,method=body?'POST':'GET') {return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(raw)})}catch(e){reject(e)}})});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
const base={id:'dated',title:'Synthetic date report',object:'deals',operation:'count',display:'metric'};
test('rolling report dates use workspace calendar boundaries and validate real inclusive custom dates',()=>{
 const now=new Date('2024-03-01T03:00:00Z'),range=period=>resolveWidgetDates({period},'America/New_York',now);
 assert.deepEqual(range('today'),{from:'2024-02-29',to:'2024-02-29'});
 assert.deepEqual(range('last_7_days'),{from:'2024-02-23',to:'2024-02-29'});
 assert.deepEqual(range('last_30_days'),{from:'2024-01-31',to:'2024-02-29'});
 assert.deepEqual(range('this_month'),{from:'2024-02-01',to:'2024-02-29'});
 assert.deepEqual(range('last_month'),{from:'2024-01-01',to:'2024-01-31'});
 assert.deepEqual(resolveWidgetDates({period:'last_month'},'UTC',new Date('2024-03-01T03:00:00Z')),{from:'2024-02-01',to:'2024-02-29'});
 assert.deepEqual(resolveWidgetDates({period:'last_month'},'UTC',new Date('2026-01-04T00:00:00Z')),{from:'2025-12-01',to:'2025-12-31'});
 for(const dates of [['2026-02-30','2026-03-01'],['2026-03-09','2026-03-08'],['0000-01-01','2026-03-08']])assert.equal(widgetSchema.safeParse({...base,date_range:{period:'custom',source:'created_at',from:dates[0],to:dates[1]}}).success,false);
 assert.equal(widgetSchema.safeParse({...base,date_range:{period:'today',source:'created_at',from:'2026-03-08'}}).success,false);
 assert.equal(widgetSchema.safeParse({...base,date_range:{period:'today',source:'field'}}).success,false);
 assert.throws(()=>range('today')&&resolveWidgetDates({period:'today'},'Invalid/Zone',now),/valid workspace timezone/);
});
test('saved reports preserve dates, exact results, currency and version/tenant/read-only boundaries with safe CSV',async()=>{
 const tenants=[randomUUID(),randomUUID()],user=randomUUID(),token=randomBytes(32).toString('hex'),cookie='drykraft_session='+token;
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 const tx=fn=>tenantTransaction(tenants[0],fn);
 try{
  await admin.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,'Synthetic report QA',user+'@example.test',await hashPassword('SyntheticReportPass!2026')]);
  for(const t of tenants)await tenantTransaction(t,async c=>{await c.query('INSERT INTO workspaces(id,name,slug,settings) VALUES($1,$2,$3,$4)',[t,'Synthetic report workspace','report-'+t.slice(0,8),{currency:'KWD',currencies:['KWD','USD'],timezone:'America/New_York'}]);await initializeWorkspace(c,t);});
  await tx(async c=>{await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenants[0],user]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(token),user,tenants[0]]);
   const times=['2026-03-08T04:59:59.999999Z','2026-03-08T05:00:00Z','2026-03-09T03:59:59.999999Z','2026-03-09T04:00:00Z'];
   for(let i=0;i<4;i++){const r=await saveRecord(c,tenants[0],user,'deals',{name:'Synthetic report deal '+i,company:i===1?'=SUM(1)':'Synthetic '+i,value:[10,12.345,2.655,99][i],currency:i===0?'USD':'KWD',close_date:i===0?'2026-03-07':i===3?'2026-03-09':'2026-03-08',stage:'new'});await c.query('UPDATE records SET created_at=$1,updated_at=$2 WHERE id=$3',[times[i],i===0?'2026-03-08T12:00:00Z':'2026-03-10T12:00:00Z',r.id]);}
  });
  const dates={period:'custom',source:'created_at',from:'2026-03-08',to:'2026-03-08'};
  const query=async widgets=>call('/analytics/query',cookie,{widgets});
  assert.equal((await query([{...base,date_range:dates}])).data.dated[0].value,2,'A23-hour DST day includes both exact boundaries');
  assert.equal((await query([{...base,date_range:{...dates,source:'updated_at'}}])).data.dated[0].value,1);
  assert.equal((await query([{...base,date_range:{...dates,source:'field',field:'close_date'}}])).data.dated[0].value,2);
  assert.equal((await query([{...base,date_range:{...dates,source:'field',field:'company'}}])).status,400);
  assert.equal((await query([{...base,date_range:{...dates,source:'created_at);DROP TABLE records;--'}}])).status,400);
  assert.equal((await query([{...base,group_by:'company'}])).status,400,'A KPI cannot sum group averages');
  const monetary={...base,id:'kwd',operation:'sum',field:'value',currency:'KWD',date_range:dates};
  assert.equal((await query([monetary])).data.kwd[0].value,15);
  await tx(async c=>{await saveRecord(c,tenants[0],user,'leads',{name:'Numeric USD score',score:3,currency:'USD'});await saveRecord(c,tenants[0],user,'leads',{name:'Numeric KWD score',score:5,currency:'KWD'});});
  assert.equal((await query([{...base,object:'leads',operation:'avg',field:'score'}])).data.dated[0].value,4,'Pure numbers are not filtered by an unrelated currency field');
  assert.equal((await query([{...monetary,filter:{field:'company',value:'=SUM(1)'}}])).data.kwd[0].value,12.345);
  let dashboard=(await call('/dashboards',cookie,{name:'Synthetic report dashboard'})).data;
  const widgets=[monetary,{...monetary,id:'groups',title:'=Formula-safe title',display:'bar',group_by:'company'},{...base,id:'empty',date_range:{...dates,from:'2026-03-11',to:'2026-03-11'}}];
  let r=await call('/dashboards/'+dashboard.id,cookie,{name:dashboard.name,widgets,version:dashboard.version},'PUT');assert.equal(r.status,200);dashboard=r.data;
  assert.deepEqual((await call('/dashboards',cookie)).data.find(d=>d.id===dashboard.id).widgets[0].date_range,dates);
  let exported=await call('/analytics/export',cookie,{dashboard_id:dashboard.id,version:dashboard.version});assert.equal(exported.status,200);assert.equal(exported.data.rows,4);assert.equal(exported.data.group_limit,100);assert.ok(exported.data.csv.startsWith('\uFEFF"Dashboard"'));assert.ok(exported.data.csv.includes('"Group label"'));assert.ok(exported.data.csv.includes('"15","KWD"'));assert.ok(exported.data.csv.includes('"2026-03-08","2026-03-08","America/New_York"'));assert.ok(exported.data.csv.includes('"\'=Formula-safe title"'));assert.ok(exported.data.csv.includes('"\'=SUM(1)"'));
  const stale=dashboard.version;widgets[0]={...monetary,title:'Edited report',operation:'avg'};
  r=await call('/dashboards/'+dashboard.id,cookie,{name:dashboard.name,widgets,version:dashboard.version},'PUT');assert.equal(r.status,200);dashboard=r.data;assert.equal(dashboard.widgets[0].id,'kwd');assert.equal((await query([dashboard.widgets[0]])).data.kwd[0].value,7.5);
  assert.equal((await call('/analytics/export',cookie,{dashboard_id:dashboard.id,version:stale})).status,409);
  assert.equal((await call('/dashboards/'+dashboard.id,cookie,{name:dashboard.name,widgets,version:stale},'PUT')).status,409);
  const foreign=(await tenantTransaction(tenants[1],c=>c.query('SELECT id,version FROM dashboards'))).rows[0];assert.equal((await call('/analytics/export',cookie,{dashboard_id:foreign.id,version:foreign.version})).status,404);
  await tx(c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[user]));
  assert.equal((await call('/analytics/export',cookie,{dashboard_id:dashboard.id,version:dashboard.version})).status,200);
  assert.equal((await call('/dashboards/'+dashboard.id,cookie,{name:dashboard.name,widgets,version:dashboard.version},'PUT')).status,403);
  const empty=(await tx(c=>c.query('INSERT INTO dashboards(tenant_id,id,name,widgets) VALUES($1,$2,$3,$4) RETURNING *',[tenants[0],randomUUID(),'Empty report','[]']))).rows[0];exported=await call('/analytics/export',cookie,{dashboard_id:empty.id,version:empty.version});assert.equal(exported.data.rows,0);assert.equal(exported.data.csv.split('\r\n').length,1);
  await tx(async c=>{for(let i=0;i<105;i++)await saveRecord(c,tenants[0],user,'companies',{name:'Synthetic company '+i,industry:String(i).padStart(3,'0')});});
  assert.equal((await query([{...base,object:'companies',display:'bar',group_by:'industry'}])).data.dated.length,100,'Group limit is explicit and deterministic');
 }finally{
  await admin.query('BEGIN');try{for(const t of tenants){for(const table of ['records','activities','outbox','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[t]);await admin.query('DELETE FROM workspaces WHERE id=$1',[t]);}await admin.query('DELETE FROM users WHERE id=$1',[user]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}
  await admin.end();await pool.end();
 }
});
