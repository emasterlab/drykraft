import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {transformWithOxc} from 'vite';
import pg from 'pg';
import http from 'node:http';
import {pool,tenantTransaction} from '../server/db.mjs';
import {hashPassword,tokenHash} from '../server/auth.mjs';
import {graphSchema,validateGraph} from '../server/automation.mjs';
const {code}=await transformWithOxc(readFileSync(new URL('../src/lib/workflow-draft.ts',import.meta.url),'utf8'),'workflow-draft.ts');
const {draftHistory,draftReducer,snapshot,fingerprint,copySteps,pasteSteps,moveGroup,groupBounds}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const node=(id,kind='log',x=100)=>({id,type:'workflow',position:{x,y:100},data:{kind,label:id,message:'Synthetic editor message'}});
const base=()=>({name:'Synthetic editor',description:'',nodes:[node('t','trigger.manual'),node('a','condition',400),node('b','log',700),node('c','log',1000)],edges:[{id:'ta',source:'t',target:'a'},{id:'ab',source:'a',target:'b',sourceHandle:'true'},{id:'ac',source:'a',target:'c',sourceHandle:'false'}],groups:[{id:'group:first',label:'Actions',nodes:['a','b','c']}]});

test('draft undo/redo preserves saved-state truth, coalesces gestures and atomically removes dependent layout',()=>{
 let state=draftHistory(base()),saved=fingerprint(state.present);
 state=draftReducer(state,{type:'edit',update:v=>({...v,nodes:v.nodes.map(n=>({...n,selected:true,measured:{width:235,height:80}}))})});
 assert.equal(state.past.length,0);assert.equal(fingerprint(state.present),saved,'Selection and measurement are not edits');
 for(const name of ['S','Sy','Synthetic renamed'])state=draftReducer(state,{type:'edit',key:'name',update:v=>({...v,name})});
 assert.equal(state.past.length,1);state=draftReducer(state,{type:'undo'});assert.equal(fingerprint(state.present),saved);
 state=draftReducer(state,{type:'redo'});assert.equal(state.present.name,'Synthetic renamed');saved=fingerprint(state.present);
 state=draftReducer(state,{type:'boundary'});
 state=draftReducer(state,{type:'edit',update:v=>({...v,nodes:v.nodes.filter(n=>n.id!=='b')})});
 assert.equal(state.present.edges.length,2);assert.deepEqual(state.present.groups[0].nodes,['a','c']);
 state=draftReducer(state,{type:'undo'});assert.equal(fingerprint(state.present),saved);assert.equal(state.present.edges.length,3);
 state=draftReducer(state,{type:'edit',update:v=>({...v,description:'New branch'})});assert.equal(state.future.length,0);
 for(let i=0;i<60;i++)state=draftReducer(state,{type:'edit',update:v=>({...v,description:String(i)})});assert.equal(state.past.length,50);
 const before=snapshot(state.present),bounds=groupBounds(before.groups[0],before.nodes);
 for(let i=1;i<=4;i++)state=draftReducer(state,{type:'edit',key:'drag',update:v=>moveGroup(v,'group:first',{x:bounds.x+i*10,y:bounds.y+i*5})});
 state=draftReducer(state,{type:'undo'});assert.deepEqual(state.present,before,'One undo reverses the complete multi-step drag');
});

test('copy/paste preserves internal branches and groups with fresh IDs, excludes triggers and enforces graph bounds',()=>{
 const draft=base(),copied=copySteps(draft,['t','a','b','c']);assert.equal(copied.nodes.length,3);assert.equal(copied.edges.length,2);
 let i=0;const pasted=pasteSteps(draft,copied,()=>String(++i));assert.equal(pasted.nodes.filter(n=>n.data.kind.startsWith('trigger.')).length,1);
 assert.deepEqual(pasted.edges.slice(3).map(e=>[e.source,e.target,e.sourceHandle]),[['1','2','true'],['1','3','false']]);
 assert.deepEqual(pasted.groups[1].nodes,['1','2','3']);assert.equal(pasted.groups[1].id,'group:6');
 const beforeBounds=groupBounds(draft.groups[0],draft.nodes),afterBounds=groupBounds(pasted.groups[1],pasted.nodes);assert.ok(afterBounds.y>=beforeBounds.y+beforeBounds.height+80);
 const repeated=pasteSteps(pasted,copied,()=>String(++i)),repeatBounds=groupBounds(repeated.groups[2],repeated.nodes);assert.ok(repeatBounds.y>=afterBounds.y+afterBounds.height+80,'Repeated paste reserves a new clear row');
 assert.equal(pasted.nodes[5].position.x-pasted.nodes[4].position.x,draft.nodes[2].position.x-draft.nodes[1].position.x,'Internal geometry is preserved');
 pasted.nodes.at(-1).data.message='Changed';assert.equal(copied.nodes.at(-1).data.message,'Synthetic editor message');
 assert.throws(()=>pasteSteps(draft,copySteps(draft,['t'])),/one trigger/);
 assert.throws(()=>pasteSteps({...draft,nodes:Array.from({length:98},(_,i)=>node('n'+i))},copied),/100 steps/);
 const branchDraft={...draft,nodes:[node('t','trigger.manual'),{...node('s','split'),data:{kind:'split',label:'Split',branches:[{id:'a',label:'A'},{id:'b',label:'B'}]}},{...node('m','merge'),data:{kind:'merge',label:'Merge',splitId:'s',operation:'collect'}}],edges:[],groups:[]};
 const branchCopy=pasteSteps(branchDraft,copySteps(branchDraft,['s','m']),()=>String(++i));assert.equal(branchCopy.nodes.at(-1).data.splitId,branchCopy.nodes.at(-2).id);
 const mergeCopy=pasteSteps(branchDraft,copySteps(branchDraft,['m']),()=>String(++i));assert.equal(mergeCopy.nodes.at(-1).data.splitId,'','A lone copied Merge must choose a new pair before publication');
 const moved=moveGroup(draft,'group:first',{x:groupBounds(draft.groups[0],draft.nodes).x+15,y:groupBounds(draft.groups[0],draft.nodes).y+20});
 assert.deepEqual(moved.nodes[0],draft.nodes[0]);assert.equal(moved.nodes[1].position.x,415);assert.equal(moved.nodes[1].position.y,120);assert.deepEqual(moved.edges,draft.edges);
 const graph=base();graph.nodes[1].data={...graph.nodes[1].data,field:'score',operator:'gte',value:10};assert.equal(validateGraph(graph).nodes.length,4);
 for(const groups of [[{id:'group:first',label:'A',nodes:['missing']}],[{id:'group:first',label:'A',nodes:['a','a']}],[{id:'group:first',label:'A',nodes:['a']},{id:'group:other',label:'B',nodes:['a']}],[{id:'group:first',label:'',nodes:['a']}]])assert.equal(graphSchema.safeParse({...graph,groups}).success,false);
});

function call(path,cookie,body,method=body?'POST':'GET') {return new Promise((resolve,reject)=>{const req=http.request((process.env.TEST_API_ORIGIN||'http://127.0.0.1:4000')+'/api/automation'+path,{method,headers:{'content-type':'application/json',cookie,...(process.env.TEST_API_HOST?{host:process.env.TEST_API_HOST}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
test('group metadata persists through draft and immutable publication with legacy compatibility and viewer denial',async()=>{
 const tenant=randomUUID(),user=randomUUID(),token=randomBytes(32).toString('hex'),cookie='drykraft_session='+token;
 const admin=new pg.Client({connectionString:process.env.LOCAL_DATABASE_ADMIN_URL||'postgresql://postgres:postgres@localhost:5432/drykraft'});await admin.connect();
 try {
  await admin.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,'Synthetic editor owner',user+'@example.test',await hashPassword('SyntheticEditorPass!2026')]);
  await admin.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[tenant,'Synthetic editor QA','editor-'+tenant.slice(0,8)]);
  await tenantTransaction(tenant,async c=>{await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenant,user]);await c.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[tokenHash(token),user,tenant]);});
  const w=(await call('/workflows',cookie,{name:'Synthetic grouped workflow'})).data;assert.equal(w.draft.groups,undefined);
  const draft={nodes:[node('t','trigger.manual'),node('a')],edges:[{id:'ta',source:'t',target:'a'}],groups:[{id:'group:first',label:'Review',nodes:['t','a']}]};
  assert.equal((await call('/workflows/'+w.id,cookie,{name:w.name,draft},'PUT')).status,200);
  const published=await call('/workflows/'+w.id+'/publish',cookie,{});assert.equal(published.status,200);assert.deepEqual(published.data.graph.groups,draft.groups);
  const invalid=await call('/workflows/'+w.id,cookie,{name:w.name,draft:{...draft,groups:[{...draft.groups[0],nodes:['foreign-step']}] }},'PUT');assert.equal(invalid.status,400);
  draft.groups[0].label='Changed draft';assert.equal((await call('/workflows/'+w.id,cookie,{name:w.name,draft},'PUT')).status,200);
  assert.equal((await call('/workflows/'+w.id+'/versions',cookie)).data[0].graph.groups[0].label,'Review');
  assert.equal((await call('/workflows',cookie)).data.find(x=>x.id===w.id).draft.groups[0].label,'Changed draft');
  await tenantTransaction(tenant,c=>c.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[user]));
  assert.equal((await call('/workflows/'+w.id,cookie,{name:w.name,draft},'PUT')).status,403);
 } finally {
  for(const table of ['executions','workflows','outbox','audit_events','sessions','memberships'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);
  await admin.query('DELETE FROM workspaces WHERE id=$1',[tenant]);await admin.query('DELETE FROM users WHERE id=$1',[user]);await admin.end();await pool.end();
 }
});
