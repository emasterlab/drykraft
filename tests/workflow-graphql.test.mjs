import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
import {validateGraph,interpolate,encryptCredential} from '../server/automation.mjs';
import {validateGraphQL,graphQLBody,graphQLResponse} from '../server/workflow-graphql.mjs';
import {safeHttp} from '../server/http-node.mjs';
const settings={url:'https://example.com/graphql',query:'query Item($id: ID!, $enabled: Boolean) { item(id: $id, enabled: $enabled) { id } }',variables:{id:'{{item.id}}',enabled:'{{enabled}}',count:'{{count}}',nullable:'{{nullable}}'},operationName:'Item',errorPolicy:'stop'};
const node=(id,kind,data={})=>({id,type:'workflow',position:{x:100,y:100},data:{kind,label:id,...data}});
const graph={nodes:[node('t','trigger.manual'),node('request','graphql',settings)],edges:[{id:'next',source:'t',target:'request'}]};
test('GraphQL prepares literal documents with typed bounded variables and rejects transport destinations before dispatch',async()=>{
 assert.equal(validateGraph(graph).nodes[1].data.kind,'graphql');
 const body=JSON.parse(graphQLBody(settings,interpolate(settings.variables,{item:{id:'sample'},enabled:false,count:2,nullable:null})));
 assert.deepEqual(body,{query:settings.query,variables:{id:'sample',enabled:false,count:2,nullable:null},operationName:'Item'});
 assert.equal(Object.hasOwn(JSON.parse(graphQLBody({...settings,operationName:''},{})),'operationName'),false);
 assert.equal(JSON.parse(graphQLBody({...settings,query:'query { value(arg: "{{literal}}") }'},{})).query,'query { value(arg: "{{literal}}") }','Document is never interpolated');
 for(const bad of [{query:''},{query:'é'.repeat(32769)},{variables:[]},{variables:null},{operationName:'Customer-name'},{errorPolicy:'ignore'},{url:'file:///etc/passwd'},{url:'https://user:pass@example.com/graphql'},{url:'https://example.com:8443/graphql'},{variables:{large:'x'.repeat(262144)}}])assert.throws(()=>validateGraphQL({...settings,...bad}));
 for(const variables of [[],null,'{}',{large:'x'.repeat(262144)}])assert.throws(()=>graphQLBody(settings,variables));
 for(const url of ['http://127.0.0.1/graphql','http://[::1]/graphql'])await assert.rejects(safeHttp(url,{method:'POST',headers:{'content-type':'application/json'},body:graphQLBody(settings,{})}),/blocked/);
 assert.throws(()=>validateGraph({...graph,nodes:graph.nodes.map(n=>n.id==='request'?{...n,data:{...n.data,credentialId:'not-a-uuid'}}:n)}));
});
test('GraphQL distinguishes HTTP-success errors, partial data and invalid envelopes without copying provider errors into failures',()=>{
 const full={status:200,body:{data:{item:{id:'sample'}},extensions:{trace:'sample'}}};assert.deepEqual(graphQLResponse(full),full);
 const partial={status:200,body:{data:{item:null},errors:[{message:'Synthetic private provider detail',path:['item']}]}};
 assert.throws(()=>graphQLResponse(partial),e=>/1 error/.test(e.message)&&!e.message.includes('Synthetic private'));
 assert.deepEqual(graphQLResponse(partial,'continue'),partial);
 for(const body of ['<html/>',[],{}, {data:[]},{errors:[]},{errors:[{}]},{data:{},errors:[{message:7}]},{data:{},extensions:[]},{errors:[{message:'No operation'}]},{data:null,errors:[{message:'No result'}]}])assert.throws(()=>graphQLResponse({status:200,body},'continue'));
 assert.deepEqual(graphQLResponse({status:200,body:{data:null}}).body,{data:null});
});
function call(path,cookie,body,method=body?'POST':'GET'){return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('GraphQL publication preserves immutable versions and current workspace credential/role boundaries for both outbound node kinds',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=tenants.map(()=>randomUUID()),tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t),credentials=tenants.map(()=>randomUUID()),admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(let i=0;i<2;i++)await tenantTransaction(tenants[i],async c=>{await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic GraphQL reviewer',users[i]+'@example.test','unused']);await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenants[i],'Synthetic GraphQL QA','graphql-'+tenants[i].slice(0,8)]);await initializeWorkspace(c,tenants[i]);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenants[i],users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenants[i]]);await c.query('INSERT INTO credentials(tenant_id,id,name,provider,ciphertext) VALUES($1,$2,$3,$4,$5)',[tenants[i],credentials[i],'Synthetic vault reference','bearer',encryptCredential(tenants[i],{value:'synthetic-never-dispatched'})]);});
  const w=(await call('/workflows',cookies[0],{name:'Synthetic GraphQL publication'})).data;
  async function save(data){return call('/workflows/'+w.id,cookies[0],{name:w.name,draft:{...graph,nodes:[graph.nodes[0],node('request',data.kind || 'graphql',data)]}},'PUT');}
  assert.equal((await save({...settings,credentialId:credentials[0]})).status,200);
  const published=await call('/workflows/'+w.id+'/publish',cookies[0],{});assert.equal(published.status,200,JSON.stringify(published.data));assert.deepEqual(published.data.graph.nodes[1].data.variables,settings.variables);
  await save({...settings,variables:'invalid JSON'});assert.equal((await call('/workflows/'+w.id+'/publish',cookies[0],{})).status,400);
  const immutable=(await call('/workflows/'+w.id+'/versions',cookies[0])).data;assert.equal(immutable.length,1);assert.equal(immutable[0].graph.nodes[1].data.query,settings.query);
  for(const kind of ['http','graphql']){
   await save({...settings,kind,method:'POST',credentialId:credentials[1]});const denied=await call('/workflows/'+w.id+'/publish',cookies[0],{});assert.equal(denied.status,400);assert.match(denied.data.error.message,/unavailable in this workspace/);
   await save({...settings,kind,method:'POST',credentialId:randomUUID()});assert.equal((await call('/workflows/'+w.id+'/publish',cookies[0],{})).status,400);
  }
  await save({...settings,credentialId:credentials[0]});await tenantTransaction(tenants[0],c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await call('/workflows/'+w.id+'/publish',cookies[0],{})).status,403);assert.equal((await save(settings)).status,403);
  assert.equal((await call('/workflows/'+w.id+'/publish',cookies[1],{})).status,404);
 }finally{
  for(const tenant of tenants){for(const table of ['executions','workflows','credentials','outbox','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();
 }
});
test.after(()=>pool.end());
