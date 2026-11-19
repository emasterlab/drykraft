import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {pool,tenantTransaction} from '../server/db.mjs';
import {initializeWorkspace} from '../server/model.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {validateGraph,executeList,switchBranch,resolvePath} from '../server/automation.mjs';
const node=(id,kind,data={})=>({id,type:'workflow',position:{x:100,y:100},data:{kind,label:id,...data}});
const cases=[{id:'high',label:'High score',field:'score',operator:'gte',value:60},{id:'medium',label:'Medium score',field:'score',operator:'gte',value:50}];
const list=(kind,data,items)=>executeList({kind,source:'items',...data},{items});
test('ordered Switch and bounded list logic preserve types, stable order, meaningful empties and safe paths',()=>{
 assert.equal(switchBranch({cases},{score:80}),'high');assert.equal(switchBranch({cases},{score:55}),'medium');assert.equal(switchBranch({cases},{score:0}),'default');
 const graph={nodes:[node('t','trigger.manual'),node('s','switch',{cases}),node('a','log'),node('b','log'),node('c','log')],edges:[{id:'ts',source:'t',target:'s'},...['high','medium','default'].map((sourceHandle,i)=>({id:'e'+i,source:'s',target:['a','b','c'][i],sourceHandle}))]};
 assert.equal(validateGraph(graph).nodes.length,5);
 assert.throws(()=>validateGraph({...graph,edges:[...graph.edges,{id:'extra',source:'s',target:'b',sourceHandle:'high'}]}),/one path/);
 assert.throws(()=>validateGraph({...graph,edges:graph.edges.map(e=>e.sourceHandle==='high'?{...e,sourceHandle:'gone'}:e)}),/current Switch/);
 assert.throws(()=>validateGraph({...graph,nodes:graph.nodes.map(n=>n.id==='s'?{...n,data:{...n.data,cases:[cases[0],cases[0]]}}:n)}),/unique/);
 assert.throws(()=>validateGraph({...graph,nodes:graph.nodes.map(n=>n.id==='s'?{...n,data:{...n.data,cases:[{id:'c',label:'C',field:'score',operator:'eq'}]}}:n)}),/comparison value/);
 assert.equal(resolvePath(Object.create({hidden:5}),'hidden'),undefined);assert.equal(resolvePath({a:1},'constructor.name'),undefined);
 const items=[{name:'भारत',score:90},{name:'A',score:70},{name:'भारत',score:80},{name:'B',score:20},{name:'A',score:70}];
 assert.equal(list('list.filter',{field:'item.score',operator:'gte',value:60},items).count,4);
 assert.deepEqual(list('list.map',{values:{name:'{{item.name}}',score:'{{item.score}}',position:'{{index}}'}},items).items[0],{name:'भारत',score:90,position:0});
 const sorted=list('list.sort',{field:'item.score',direction:'desc'},items).items;
 assert.deepEqual(sorted.map(i=>i.score),[90,80,70,70,20]);assert.equal(sorted[2],items[1],'Stable ties retain original identity/order');assert.deepEqual(items.map(i=>i.score),[90,70,80,20,70]);
 assert.deepEqual(list('list.deduplicate',{field:'item.name'},sorted).items.map(i=>i.name),['भारत','A','B']);
 assert.deepEqual(list('list.limit',{offset:1,limit:2},items).items,items.slice(1,3));
 assert.deepEqual(list('list.aggregate',{operation:'avg',field:'item.score'},items).items,[{group:null,count:5,value:66}]);
 assert.deepEqual(list('list.aggregate',{operation:'sum',field:'item.score',groupBy:'item.name'},items).items,[{group:'भारत',count:2,value:170},{group:'A',count:2,value:140},{group:'B',count:1,value:20}]);
 for(const [operation,value]of [['count',0],['sum',0],['avg',null],['min',null],['max',null]])assert.deepEqual(list('list.aggregate',{operation,field:'item'},[]).items,[{group:null,count:0,value}]);
 assert.deepEqual(list('list.aggregate',{operation:'count',groupBy:'item'},[1,'1',null]).items.map(g=>g.group),[1,'1',null]);
 assert.deepEqual(list('list.sort',{field:'item.key',direction:'desc'},[{key:null},{key:2},{key:1},{}]).items.map(i=>i.key),[2,1,null,undefined]);
 assert.throws(()=>list('list.sort',{field:'item',direction:'asc'},[1,'2']),/one value type/);
 assert.throws(()=>list('list.deduplicate',{field:'item'},[{}]),/scalar|finite/);
 assert.throws(()=>list('list.aggregate',{operation:'sum',field:'item'},['1']),/finite number/);
 assert.throws(()=>list('list.aggregate',{operation:'sum',field:'item'},[Number.MAX_VALUE,Number.MAX_VALUE]),/numeric range/);
 assert.throws(()=>executeList({kind:'list.map',source:'constructor',values:{}},{}),/plain context path/);
 assert.throws(()=>executeList({kind:'list.map',source:'items',values:{}},{items:{}}),/must contain an array/);
 assert.throws(()=>list('list.limit',{offset:0,limit:1},Array(1001).fill(0)),/1,000/);
 assert.throws(()=>list('list.aggregate',{operation:'count',groupBy:'item'},Array.from({length:101},(_,i)=>i)),/100 groups/);
 assert.throws(()=>list('list.map',{values:{large:'x'.repeat(1000)}},Array(300).fill(0)),/256 KB/);
 assert.throws(()=>list('list.map',{values:{a:'{{items}}',b:'{{items}}'}},Array(300).fill('x'.repeat(1000))),/256 KB/);
});
function call(path,cookie,body,method=body?'POST':'GET'){return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
async function done(cookie,id){const deadline=Date.now()+20000;while(Date.now()<deadline){const r=await call('/executions/'+id,cookie);assert.equal(r.status,200);if(['succeeded','failed','cancelled'].includes(r.data.state))return r.data;await new Promise(r=>setTimeout(r,1000));}throw new Error('The real worker did not finish this synthetic run in 20 seconds.');}
test('published list/Switch nodes use the real shared worker, persisted branch recovery, immutable versions and tenant/viewer controls',async()=>{
 const tenants=[randomUUID(),randomUUID()],users=[randomUUID(),randomUUID()],tokens=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')],cookies=tokens.map(t=>'drykraft_session='+t);
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try{
  for(let i=0;i<2;i++){await admin.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[users[i],'Synthetic logic QA',users[i]+'@example.test',await hashPassword('SyntheticLogicPass!2026')]);await tenantTransaction(tenants[i],async c=>{await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenants[i],'Synthetic logic QA','logic-'+tenants[i].slice(0,8)]);await initializeWorkspace(c,tenants[i]);await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenants[i],users[i]]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenHash(tokens[i]),users[i],tenants[i]]);});}
  const w=(await call('/workflows',cookies[0],{name:'Synthetic shared logic run'})).data;
  const nodes=[node('t','trigger.manual'),node('route','switch',{cases}),node('filter','list.filter',{source:'items',field:'item.score',operator:'gte',value:60}),node('map','list.map',{source:'last.items',values:{name:'{{item.name}}',score:'{{item.score}}'}}),node('sort','list.sort',{source:'last.items',field:'item.score',direction:'desc'}),node('dedup','list.deduplicate',{source:'last.items',field:'item.name'}),node('limit','list.limit',{source:'last.items',offset:0,limit:2}),node('aggregate','list.aggregate',{source:'last.items',operation:'avg',field:'item.score'}),node('wait','wait',{seconds:1}),node('result','log',{message:'Average {{nodes.aggregate.items.0.value}}'}),node('medium','log',{message:'Synthetic medium'}),node('default','log',{message:'Synthetic default'})];
  const edges=[{id:'tr',source:'t',target:'route'},...['high','medium','default'].map(h=>({id:'r'+h,source:'route',target:h==='high'?'filter':h,sourceHandle:h})),...['filter','map','sort','dedup','limit','aggregate','wait'].map((source,i)=>({id:'l'+i,source,target:['map','sort','dedup','limit','aggregate','wait','result'][i]}))];
  const draft={nodes,edges};assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft},'PUT')).status,200);
  const v=await call('/workflows/'+w.id+'/publish',cookies[0],{});assert.equal(v.status,200);assert.deepEqual(v.data.graph.nodes[1].data.cases,cases);
  const input={score:75,items:[{name:'भारत',score:90},{name:'A',score:70},{name:'भारत',score:80},{name:'B',score:20},{name:'A',score:70}]};
  const run=(await call('/workflows/'+w.id+'/run',cookies[0],{input})).data;let e=await done(cookies[0],run.id);assert.equal(e.state,'succeeded',e.error);assert.equal(e.context.nodes.route.branch,'high');assert.equal(e.context.nodes.result.message,'Average 80');assert.deepEqual(e.context.nodes.aggregate.items,[{group:null,count:2,value:80}]);assert.ok(!e.nodes.some(n=>['medium','default'].includes(n.node_id)));
  // Simulate a recovery at an already completed router: saved output, not changed input, owns the selected path.
  await tenantTransaction(tenants[0],c=>c.query("UPDATE executions SET state='failed',current_node='route',context=jsonb_set(context,'{score}','0') WHERE id=$1",[run.id]));
  assert.equal((await call('/executions/'+run.id+'/retry',cookies[0],{})).status,200);e=await done(cookies[0],run.id);assert.equal(e.state,'succeeded');assert.equal(e.context.nodes.route.branch,'high');assert.ok(!e.nodes.some(n=>n.node_id==='default'));
  const fallback=(await call('/workflows/'+w.id+'/run',cookies[0],{input:{score:0,items:[]}})).data;e=await done(cookies[0],fallback.id);assert.equal(e.state,'succeeded');assert.equal(e.context.nodes.route.branch,'default');assert.equal(e.context.nodes.default.message,'Synthetic default');assert.ok(!e.nodes.some(n=>n.node_id==='filter'));
  const invalid=(await call('/workflows/'+w.id+'/run',cookies[0],{input:{score:75,items:{bad:true}}})).data;e=await done(cookies[0],invalid.id);assert.equal(e.state,'failed');assert.match(e.error,/must contain an array/);assert.ok(!e.nodes.some(n=>n.node_id==='map'));
  const changed=structuredClone(draft);changed.nodes[1].data.cases[0].value=999;changed.nodes[7].data.label='Changed draft label';assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:changed},'PUT')).status,200);assert.equal((await call('/workflows/'+w.id+'/versions',cookies[0])).data[0].graph.nodes[1].data.cases[0].value,60);assert.equal((await call('/executions/'+run.id,cookies[0])).data.nodes.find(n=>n.node_id==='aggregate').node_label,'aggregate');
  changed.nodes[2].data.source='items.__proto__';await call('/workflows/'+w.id,cookies[0],{name:w.name,draft:changed},'PUT');assert.equal((await call('/workflows/'+w.id+'/publish',cookies[0],{})).status,400);
  assert.equal((await call('/executions/'+run.id,cookies[1])).status,404);assert.equal((await call('/workflows/'+w.id+'/run',cookies[1],{input})).status,400);
  await tenantTransaction(tenants[0],c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[users[0]]));assert.equal((await call('/workflows/'+w.id,cookies[0],{name:w.name,draft},'PUT')).status,403);assert.equal((await call('/workflows/'+w.id+'/run',cookies[0],{input})).status,403);assert.equal((await call('/executions/'+run.id,cookies[0])).status,200);
 }finally{await admin.query('BEGIN');try{for(const tenant of tenants){for(const table of ['outbox','executions','workflows','records','activities','audit_events','usage_ledger','object_definitions','pipelines','dashboards','workspace_billing','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);}for(const user of users)await admin.query('DELETE FROM users WHERE id=$1',[user]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}await admin.end();await pool.end();}
});
