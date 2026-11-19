import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {tokenHash} from '../server/auth.mjs';
import {validateGraph,loopInput,advanceWorkflow,iterationPath,iterationPathSchema,interpolate} from '../server/automation.mjs';
const node=(id,kind,data={})=>({id,type:'workflow',position:{x:100,y:100},data:{kind,label:id,...data}});
const edge=(source,target,sourceHandle)=>({id:source+target,source,target,...(sourceHandle?{sourceHandle}:{})});
const graph={nodes:[node('t','trigger.manual'),node('each','loop',{source:'items'}),node('body','set',{values:{value:'{{item}}',index:'{{index}}'}}),node('done','log',{message:'Processed {{last.count}}'})],edges:[edge('t','each'),edge('each','body','each'),edge('each','done','done')]};
test('Loop validates isolated DAG bodies, typed bounded snapshots, scoped items, nested results and server-owned durable control',()=>{
 assert.equal(validateGraph(graph).nodes.length,4);
 for(const edges of [graph.edges.filter(e=>e.sourceHandle!=='each'),[...graph.edges,edge('each','body','each')],[...graph.edges,edge('body','done')],[...graph.edges,edge('body','each')],[...graph.edges,edge('t','body')]])assert.throws(()=>validateGraph({...graph,edges}));
 assert.throws(()=>validateGraph({...graph,nodes:graph.nodes.map(n=>n.id==='each'?{...n,data:{...n.data,source:'items.__proto__'}}:n)}),/plain Loop List source/);
 const deepNodes=[node('t','trigger.manual'),...Array.from({length:6},(_,i)=>node('l'+i,'loop',{source:'items'})),node('body','log')];assert.throws(()=>validateGraph({nodes:deepNodes,edges:deepNodes.slice(1).map((n,i)=>edge(deepNodes[i].id,n.id,i?'each':undefined))}),/five nested/);
 assert.throws(()=>loopInput({source:'items'},{items:{}}),/must contain an array/);
 assert.throws(()=>loopInput({source:'items'},{items:Array(1001).fill(0)}),/1,000/);
 assert.throws(()=>loopInput({source:'items'},{items:['x'.repeat(262144)]}),/256 KB/);
 const base={items:[0,false,null],item:'outside',index:7,loop:'outside-loop',runtime:{steps:99999},nodes:{previous:{keep:true}}};
 let step=advanceWorkflow(graph,graph.nodes[1],base,{},loopInput({source:'items'},base));
 assert.equal(step.entering,true);assert.equal(step.context.item,0);assert.equal(step.context.loop.number,1);assert.equal(step.context.loop.first,true);assert.equal(iterationPath(step.runtime),'[["each",0]]');assert.equal(step.runtime.steps,1,'Input runtime cannot set the control counter');
 for(let i=0;i<3;i++){
  assert.equal(step.context.item,base.items[i]);assert.equal(step.context.index,i);assert.equal(step.context.loop.last,i===2);assert.equal(step.context.value,undefined,'Set values from an earlier item do not leak');
  const output=interpolate(graph.nodes[2].data.values,step.context);step=advanceWorkflow(graph,graph.nodes[2],step.context,step.runtime,output);
 }
 assert.equal(step.next,'done');assert.equal(step.context.item,'outside');assert.equal(step.context.index,7);assert.equal(step.context.loop,'outside-loop');assert.equal(step.context.value,undefined);assert.equal(step.runtime.loops.length,0);assert.equal(iterationPath(step.runtime),'');
 assert.deepEqual(step.context.nodes.each,{items:[{value:0,index:0},{value:false,index:1},{value:null,index:2}],count:3,input_count:3});assert.equal(step.completions[0].iteration_path,'');assert.deepEqual(base.nodes,{previous:{keep:true}});
 const empty=advanceWorkflow(graph,graph.nodes[1],{items:[]},{},loopInput({source:'items'},{items:[]}));assert.equal(empty.next,'done');assert.equal(empty.entering,false);assert.deepEqual(empty.output,{items:[],count:0,input_count:0});
 const saved=advanceWorkflow(graph,graph.nodes[1],base,{},step.context.nodes.each,undefined,true);assert.equal(saved.next,'done');assert.deepEqual(saved.output,step.context.nodes.each,'Completed Loop recovery must not enter its item path again');
 assert.throws(()=>advanceWorkflow(graph,graph.nodes[2],base,{steps:10000},{value:1}),/10,000/);
 assert.equal(iterationPathSchema.parse('[["each",0]]'),'[["each",0]]');for(const path of ['[["each",-1]]','[["each",1000]]','[ ["each",0] ]','{}','constructor'])assert.throws(()=>iterationPathSchema.parse(path));
 const deep={loops:Array.from({length:5},(_,i)=>({node_id:'l'+i,index:0,items:[1],results:[],base:{}}))};assert.throws(()=>advanceWorkflow(graph,graph.nodes[1],base,deep,loopInput({source:'items'},base)),/five nested/);
 const huge={...base,large:'x'.repeat(1048576)};assert.throws(()=>advanceWorkflow(graph,graph.nodes[1],huge,{},loopInput({source:'items'},huge)),/1 MB/);
 step=advanceWorkflow(graph,graph.nodes[1],{items:[1]}, {},{items:[1],input_count:1});assert.throws(()=>advanceWorkflow(graph,graph.nodes[2],step.context,step.runtime,{large:'x'.repeat(262144)}),/collected output/);
 const nested={nodes:[node('t','trigger.manual'),node('outer','loop',{source:'items'}),node('inner','loop',{source:'item.children'}),node('leaf','set',{values:{child:'{{item}}'}}),node('result','set',{values:{name:'{{item.name}}',children:'{{nodes.inner.items}}'}})],edges:[edge('t','outer'),edge('outer','inner','each'),edge('inner','leaf','each'),edge('inner','result','done')]};validateGraph(nested);
 step=advanceWorkflow(nested,nested.nodes[1],{items:[{name:'A',children:[1,2]}]}, {},{items:[{name:'A',children:[1,2]}]});
 step=advanceWorkflow(nested,nested.nodes[2],step.context,step.runtime,loopInput({source:'item.children'},step.context));assert.equal(iterationPath(step.runtime),'[["outer",0],["inner",0]]');
 for(let i=0;i<2;i++)step=advanceWorkflow(nested,nested.nodes[3],step.context,step.runtime,interpolate(nested.nodes[3].data.values,step.context));
 assert.equal(step.context.item.name,'A');assert.equal(step.next,'result');assert.equal(step.completions[0].iteration_path,'[["outer",0]]');
 step=advanceWorkflow(nested,nested.nodes[4],step.context,step.runtime,interpolate(nested.nodes[4].data.values,step.context));assert.equal(step.next,null);assert.deepEqual(step.context.last.items,[{name:'A',children:[{child:1},{child:2}]}]);
});
function call(path,cookie,body,method=body?'POST':'GET'){return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('published Loop versions and per-item replay retain current iteration, immutable receipts and workspace/role boundaries',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=tenants.map(()=>randomUUID()),tokens=users.map(()=>randomBytes(32).toString('hex')),cookies=tokens.map(t=>'drykraft_session='+t),admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(let i=0;i<2;i++)await tenantTransaction(tenants[i],async c=>{await c.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic Loop reviewer',users[i]+'@example.test','unused']);await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenants[i],'Synthetic Loop QA','loop-'+tenants[i].slice(0,8)]);await initializeWorkspace(c,tenants[i]);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenants[i],users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenants[i]]);});
  const w=(await call('/workflows',cookies[0],{name:'Synthetic Loop publication'})).data;
  assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:graph},'PUT')).status,200);
  const published=await call('/workflows/'+w.id+'/publish',cookies[0],{});assert.equal(published.status,200,JSON.stringify(published.data));
  const invalid={...graph,edges:[...graph.edges,edge('body','done')]};await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:invalid},'PUT');assert.equal((await call('/workflows/'+w.id+'/publish',cookies[0],{})).status,400);assert.equal((await call('/workflows/'+w.id+'/versions',cookies[0])).data[0].graph.edges.length,3);
  const id=randomUUID(),input={items:[1,2]},entered=advanceWorkflow(graph,graph.nodes[1],input,{},loopInput({source:'items'},input)),first=advanceWorkflow(graph,graph.nodes[2],entered.context,entered.runtime,{value:1,index:0});
  await tenantTransaction(tenants[0],async c=>{await c.query("INSERT INTO executions(tenant_id,id,workflow_id,version_id,state,input,context,runtime,current_node) VALUES($1,$2,$3,$4,'failed',$5,$6,$7,'body')",[tenants[0],id,w.id,published.data.id,input,first.context,first.runtime]);for(const [index,state]of [[0,'succeeded'],[1,'failed']])await c.query('INSERT INTO node_executions(tenant_id,execution_id,node_id,iteration_path,state,output) VALUES($1,$2,$3,$4,$5,$6)',[tenants[0],id,'body',JSON.stringify([['each',index]]),state,{value:index+1,index}]);});
  const detail=(await call('/executions/'+id,cookies[0])).data;assert.equal(detail.current_iteration_path,'[["each",1]]');assert.deepEqual(detail.nodes.map(n=>n.iteration_label),['each: item 1','each: item 2']);
  const replay={id:randomUUID(),mode:'replay',node_id:'body',iteration_path:'[["each",1]]'};
  assert.equal((await call('/executions/'+id+'/recover',cookies[0],{...replay,iteration_path:'[["each",0]]'})).status,409);assert.equal((await call('/executions/'+id+'/recover',cookies[0],{...replay,iteration_path:undefined})).status,409);assert.equal((await call('/executions/'+id+'/recover',cookies[1],replay)).status,404);
  await tenantTransaction(tenants[0],c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await call('/executions/'+id+'/recover',cookies[0],replay)).status,403);await tenantTransaction(tenants[0],c=>c.query("UPDATE memberships SET role='owner' WHERE user_id=$1",[users[0]]));
  const responses=await Promise.all([call('/executions/'+id+'/recover',cookies[0],replay),call('/executions/'+id+'/recover',cookies[0],replay)]);assert.ok(responses.every(r=>r.status===202));assert.deepEqual(responses[0].data.runtime,first.runtime);assert.equal((await call('/executions/'+id+'/recover',cookies[0],{...replay,iteration_path:'[["each",0]]'})).status,409);
  const receipt=(await tenantTransaction(tenants[0],c=>c.query('SELECT * FROM execution_recoveries WHERE source_id=$1',[id]))).rows;assert.equal(receipt.length,1);assert.equal(receipt[0].iteration_path,replay.iteration_path);
  assert.equal((await call('/executions/'+id+'/recover',cookies[0],{id:randomUUID(),mode:'retry',iteration_path:''})).status,400);assert.equal((await call('/executions/'+id+'/recover',cookies[0],{...replay,id:randomUUID(),iteration_path:'[ ["each",1] ]'})).status,400);
 }finally{
  for(const tenant of tenants){for(const table of ['executions','workflows','outbox','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await admin.end();
 }
});
test.after(()=>pool.end());
