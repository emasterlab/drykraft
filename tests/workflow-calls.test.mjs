import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
import {validateGraph,interpolate} from '../server/automation.mjs';
import {reusableContract,contractValue,callSettings} from '../server/workflow-calls.mjs';
const node=(id,kind,data={})=>({id,type:'workflow',position:{x:100,y:100},data:{kind,label:id,...data}});
const inputs={name:{type:'string'},amount:{type:'number'},enabled:{type:'boolean'},detail:{type:'object',nullable:true,required:false},items:{type:'array',required:false}},outputs={message:{type:'string'},amount:{type:'number'}};
const reusable={nodes:[node('t','trigger.subworkflow',{inputs,outputs}),node('r','workflow.return',{values:{message:'Hi {{name}}',amount:'{{amount}}'}})],edges:[{id:'next',source:'t',target:'r'}]};
test('reusable workflows enforce typed bounded closed contracts and complete return paths',()=>{
 const c=reusableContract({inputs,outputs});const data={name:'Sample',amount:2,enabled:false,detail:null,items:[]};assert.deepEqual(contractValue(c.inputs,data),data);
 assert.deepEqual(interpolate({amount:'{{amount}}',enabled:'{{enabled}}'},data),{amount:2,enabled:false});assert.equal(validateGraph(reusable).nodes[1].data.kind,'workflow.return');
 for(const bad of [{...data,amount:'2'},{...data,enabled:0},{name:'Missing'},{...data,extra:true},{...data,detail:[]},{...data,items:{}},{...data,name:null},{...data,name:'x'.repeat(262144)}])assert.throws(()=>contractValue(c.inputs,bad));
 for(const bad of [{inputs:{nodes:{type:'object'}},outputs:{}},{inputs:{name:{type:'unknown'}},outputs:{}},{inputs:{name:{type:'string',typo:true}},outputs:{}},{inputs:[],outputs:{}},{inputs:{},outputs:null}])assert.throws(()=>reusableContract(bad));
 assert.throws(()=>validateGraph({...reusable,nodes:[reusable.nodes[0],node('r','set',{values:{}})]}));assert.throws(()=>validateGraph({...reusable,edges:[...reusable.edges,{id:'back',source:'r',target:'t'}]}));
 assert.throws(()=>callSettings({workflowId:randomUUID(),versionId:randomUUID(),values:[]}));
 const cond={nodes:[reusable.nodes[0],node('c','condition',{field:'enabled',operator:'eq',value:true}),reusable.nodes[1]],edges:[{id:'a',source:'t',target:'c'},{id:'b',source:'c',target:'r',sourceHandle:'true'}]};assert.throws(()=>validateGraph(cond));
 assert.doesNotThrow(()=>validateGraph({...cond,edges:[...cond.edges,{id:'c',source:'c',target:'r',sourceHandle:'false'}]}));
});
function call(path,cookie,body,method=body?'POST':'GET'){return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('sub-workflow publication pins immutable versions and rejects foreign, paused, recursive and invalid typed mappings',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=tenants.map(()=>randomUUID()),tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t),admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(let i=0;i<2;i++)await tenantTransaction(tenants[i],async c=>{await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic sub-workflow tester',users[i]+'@example.test','unused']);await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenants[i],'Synthetic sub-workflow QA','calls-'+tenants[i].slice(0,8)]);await initializeWorkspace(c,tenants[i]);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenants[i],users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenants[i]]);});
  const child=(await call('/workflows',cookies[0],{name:'Synthetic reusable calculation'})).data;
  async function save(w,graph,cookie=cookies[0]){return call('/workflows/'+w.id,cookie,{name:w.name,draft:graph},'PUT');}
  assert.equal((await save(child,reusable)).status,200);const v1=(await call('/workflows/'+child.id+'/publish',cookies[0],{})).data;assert.equal(v1.version,1);
  const choices=await call('/subworkflows',cookies[0]);assert.equal(choices.status,200);assert.ok(choices.data.some(v=>v.version_id===v1.id));assert.equal((await call('/subworkflows',cookies[1])).data.length,0);
  const parent=(await call('/workflows',cookies[0],{name:'Synthetic caller'})).data,mapping={name:'{{name}}',amount:'{{amount}}',enabled:false},caller={nodes:[node('t','trigger.manual'),node('c','workflow.call',{workflowId:child.id,versionId:v1.id,values:mapping})],edges:[{id:'next',source:'t',target:'c'}]};
  await save(parent,caller);const p1=await call('/workflows/'+parent.id+'/publish',cookies[0],{});assert.equal(p1.status,200,JSON.stringify(p1.data));assert.equal(p1.data.graph.nodes[1].data.versionNumber,1);
  await save(child,{...reusable,nodes:[reusable.nodes[0],node('r','workflow.return',{values:{message:'Changed {{name}}',amount:'{{amount}}'}})]});const v2=(await call('/workflows/'+child.id+'/publish',cookies[0],{})).data;assert.equal(v2.version,2);assert.equal((await call('/workflows/'+parent.id+'/versions',cookies[0])).data[0].graph.nodes[1].data.versionId,v1.id);
  const denied=await call('/workflows/'+parent.id+'/publish',cookies[1],{});assert.equal(denied.status,404);
  await call('/workflows/'+child.id+'/status',cookies[0],{status:'paused'});assert.equal((await call('/workflows/'+parent.id+'/publish',cookies[0],{})).status,400);await call('/workflows/'+child.id+'/status',cookies[0],{status:'active'});
  await save(parent,{...caller,nodes:[caller.nodes[0],node('c','workflow.call',{workflowId:child.id,versionId:v1.id,values:{...mapping,amount:'bad literal'}})]});assert.equal((await call('/workflows/'+parent.id+'/publish',cookies[0],{})).status,400);
  await save(child,{nodes:[reusable.nodes[0],node('c','workflow.call',{workflowId:child.id,versionId:v1.id,values:mapping}),reusable.nodes[1]],edges:[{id:'a',source:'t',target:'c'},{id:'b',source:'c',target:'r'}]});assert.equal((await call('/workflows/'+child.id+'/publish',cookies[0],{})).status,400);
  const badInput=await call('/workflows/'+child.id+'/run',cookies[0],{input:{name:'Sample',amount:'2',enabled:false}});assert.equal(badInput.status,400);assert.match(badInput.data.error.message,/amount/);
  const foreign=(await call('/workflows',cookies[1],{name:'Synthetic foreign reusable child'})).data;await save(foreign,reusable,cookies[1]);const foreignVersion=(await call('/workflows/'+foreign.id+'/publish',cookies[1],{})).data;
  await save(parent,{...caller,nodes:[caller.nodes[0],node('c','workflow.call',{workflowId:foreign.id,versionId:foreignVersion.id,values:mapping})]});assert.equal((await call('/workflows/'+parent.id+'/publish',cookies[0],{})).status,400);
  const rootId=randomUUID(),childId=randomUUID(),foreignId=randomUUID();
  await admin.query("INSERT INTO executions(tenant_id,id,workflow_id,version_id,current_node,state) VALUES($1,$2,$3,$4,'t','waiting')",[tenants[0],rootId,parent.id,p1.data.id]);
  for(const [tenant,id,w,v]of [[tenants[0],childId,parent.id,p1.data.id],[tenants[1],foreignId,foreign.id,foreignVersion.id]])await admin.query("INSERT INTO executions(tenant_id,id,workflow_id,version_id,current_node,state,runtime) VALUES($1,$2,$3,$4,'t','waiting',$5)",[tenant,id,w,v,{call:{parent_id:rootId,root_id:rootId,ancestors:[rootId],workflow_ids:[parent.id],node_id:'c',iteration_path:''}}]);
  assert.equal((await call('/executions/'+rootId+'/cancel',cookies[0],{})).status,200);
  assert.equal((await admin.query('SELECT state FROM executions WHERE id=$1',[childId])).rows[0].state,'cancelled');assert.equal((await admin.query('SELECT state FROM executions WHERE id=$1',[foreignId])).rows[0].state,'waiting','Tenant cancellation cannot follow a forged foreign ancestry');
  assert.equal((await call('/executions/'+childId+'/recover',cookies[0],{id:randomUUID(),mode:'rerun'})).status,409,'Child full reruns must start at the parent');
  await tenantTransaction(tenants[0],c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await save(parent,caller)).status,403);assert.equal((await call('/workflows/'+parent.id+'/publish',cookies[0],{})).status,403);
 }finally{
  for(const tenant of tenants){for(const table of ['executions','workflows','outbox','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();
 }
});
test.after(()=>pool.end());
