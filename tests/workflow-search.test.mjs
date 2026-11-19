import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace,saveRecord} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
import {validateGraph,interpolate} from '../server/automation.mjs';
import {validateWorkflowSearch,searchWorkflowRecords} from '../server/workflow-search.mjs';
const node=(id,kind,data={})=>({id,type:'workflow',position:{x:0,y:0},data:{kind,label:id,...data}});
const graph=data=>({nodes:[node('t','trigger.manual'),node('search','crm.search',data)],edges:[{id:'e',source:'t',target:'search'}]});
function call(path,cookie,body,method=body?'POST':'GET'){return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('native search validates settings before publication and resolved typed filters against current tenant records',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=[randomUUID(),randomUUID()],tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t);
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(const [i,tenant]of tenants.entries())await tenantTransaction(tenant,async c=>{
   await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic workflow search QA','search-'+tenant.slice(0,8)]);await initializeWorkspace(c,tenant);
   await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic search member',users[i]+'@example.test','unused']);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenant,users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenant]);
   await c.query('INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields) VALUES($1,$2,$3,$4,$5)',[tenant,'projects','Projects','Project',JSON.stringify([{key:'name',name:'Name',type:'text',required:true},{key:'score',name:'Score',type:'number'},{key:'active',name:'Active',type:'boolean'},{key:'payload',name:'Payload',type:'json'}])]);
   for(let j=0;j<6;j++)await saveRecord(c,tenant,users[i],'projects',{name:j===0?'Literal %_ project':i?'Outside project':'Sample project '+j,score:j,active:j%2===0});
  });
  const filter={match:'all',conditions:[{field:'score',operator:'gte',value:'{{minimum}}'},{field:'active',operator:'eq',value:'{{active}}'}]},settings={object:'projects',search:'',limit:1,filter};
  assert.equal(validateGraph(graph(settings)).nodes.length,2);
  for(const limit of [0,101,1.5,'2'])assert.throws(()=>validateGraph(graph({...settings,limit})));
  assert.throws(()=>validateGraph(graph({...settings,list:randomUUID()})),/smart list or field rules/);
  await tenantTransaction(tenants[0],async c=>{
   await validateWorkflowSearch(c,settings);
   const uuidStep=randomUUID(),uuidRules={...filter,conditions:[{field:'score',operator:'gte',value:'{{nodes.'+uuidStep+'.minimum}}'}]};await validateWorkflowSearch(c,{...settings,filter:uuidRules});assert.equal((await searchWorkflowRecords(c,{...settings,filter:interpolate(uuidRules,{nodes:{[uuidStep]:{minimum:2}}})})).total,4);
   for(const rule of [{field:'gone',operator:'eq',value:'x'},{field:'score',operator:'contains',value:'3'},{field:'score',operator:'eq',value:'Score {{minimum}}'}])await assert.rejects(validateWorkflowSearch(c,{object:'projects',filter:{match:'all',conditions:[rule]}}));
   const resolved={...settings,filter:interpolate(filter,{minimum:2,active:true})};
   const first=await searchWorkflowRecords(c,resolved),second=await searchWorkflowRecords(c,{...resolved,cursor:first.next_cursor});assert.equal(first.total,2);assert.equal(first.count,1);assert.ok(first.next_cursor);assert.equal(second.count,1);assert.equal(second.next_cursor,null);assert.notEqual(first.items[0].id,second.items[0].id);assert.ok([...first.items,...second.items].every(r=>r.tenant_id===tenants[0]&&typeof r.data.score==='number'));
   assert.equal((await searchWorkflowRecords(c,{object:'projects',search:'Outside'})).count,0);
   assert.equal((await searchWorkflowRecords(c,{object:'projects',search:'%_'})).count,1,'SQL wildcards must remain literal');
   const ownList=randomUUID();await c.query('INSERT INTO record_lists(tenant_id,id,object_key,name,filter) VALUES($1,$2,$3,$4,$5)',[tenants[0],ownList,'projects','Active samples',{match:'all',conditions:[{field:'active',operator:'eq',value:true}]}]);await validateWorkflowSearch(c,{object:'projects',list:ownList});assert.equal((await searchWorkflowRecords(c,{object:'projects',list:ownList})).count,3);
   await c.query('UPDATE record_lists SET filter=$1 WHERE id=$2',[{match:'all',conditions:[{field:'score',operator:'gt',value:3}]},ownList]);assert.equal((await searchWorkflowRecords(c,{object:'projects',list:ownList})).count,2);assert.equal((await searchWorkflowRecords(c,{object:'projects',list:ownList,search:'%_'})).count,0,'Current saved rules intersect search');
   assert.equal((await searchWorkflowRecords(c,{object:'projects',search:'No such project'})).next_cursor,null);
   await assert.rejects(searchWorkflowRecords(c,{...settings,filter:interpolate(filter,{minimum:'2',active:true})}),/valid filter value/);
   await assert.rejects(searchWorkflowRecords(c,{object:'projects',cursor:'not a cursor'}));
   const a=await saveRecord(c,tenants[0],users[0],'people',{name:'Remaining sample'}),b=await saveRecord(c,tenants[0],users[0],'people',{name:'Merged sample'});await c.query('UPDATE records SET merged_into=$1 WHERE id=$2',[a.id,b.id]);assert.equal((await searchWorkflowRecords(c,{object:'people'})).count,1);
   for(let j=0;j<6;j++)await saveRecord(c,tenants[0],users[0],'projects',{name:'Large sample '+j,payload:'x'.repeat(60000)});
   await assert.rejects(searchWorkflowRecords(c,{object:'projects',search:'Large',limit:6}),/256 KB/);assert.equal((await searchWorkflowRecords(c,{object:'projects',search:'Large',limit:1})).count,1);
  });
  const list=randomUUID();await tenantTransaction(tenants[1],c=>c.query('INSERT INTO record_lists(tenant_id,id,object_key,name,filter) VALUES($1,$2,$3,$4,$5)',[tenants[1],list,'projects','Outside list',{match:'all',conditions:[{field:'score',operator:'gte',value:2}]}]));
  const w=(await call('/workflows',cookies[0],{name:'Synthetic search publication'})).data;
  async function publish(data){assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:graph(data)},'PUT')).status,200);return call('/workflows/'+w.id+'/publish',cookies[0],{});}
  assert.equal((await publish(settings)).status,200);assert.equal((await publish({object:'projects',list})).status,400);assert.equal((await publish({object:'outside_object'})).status,404);assert.equal((await publish({object:'projects',filter:{match:'all',conditions:[{field:'gone',operator:'eq',value:'x'}]}})).status,400);
  await tenantTransaction(tenants[0],c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await call('/workflows/'+w.id+'/publish',cookies[0],{})).status,403);assert.equal((await call('/workflows/'+w.id+'/versions',cookies[1])).data.length,0);
 }finally{
  for(const tenant of tenants){for(const table of ['outbox','executions','workflows','records','record_lists','activities','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();await pool.end();
 }
});
