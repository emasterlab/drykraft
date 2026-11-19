import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGraph,advanceWorkflow,iterationPath,interpolate,loopInput} from '../server/automation.mjs';
import {splitPlan,mergeOutputs} from '../server/workflow-branches.mjs';

const node=(id,kind,data={})=>({id,type:'workflow',position:{x:100,y:100},data:{kind,label:id,...(kind==='set'?{values:{}}:{}),...data}});
const edge=(source,target,sourceHandle)=>({id:source+target+(sourceHandle || ''),source,target,...(sourceHandle?{sourceHandle}:{})});
const fork=node('fork','split',{branches:[{id:'first',label:'First'},{id:'second',label:'Second'}]});
const join=node('join','merge',{splitId:'fork',operation:'collect'});
const graph={nodes:[node('t','trigger.manual'),fork,node('a','set',{values:{value:'A',privateValue:true}}),node('b','set',{values:{value:'B'}}),join,node('tail','set',{values:{collected:'{{last.items}}',first:'{{nodes.a.value}}',second:'{{nodes.b.value}}'}})],edges:[edge('t','fork'),edge('fork','a','first'),edge('fork','b','second'),edge('a','join'),edge('b','join'),edge('join','tail')]};

test('Split/Merge publication enforces paired joins, complete disjoint paths, nested Loop boundaries and bounded settings',()=>{
 assert.deepEqual(validateGraph(graph),graph);
 const change=(id,data)=>({...graph,nodes:graph.nodes.map(n=>n.id===id?{...n,data:{...n.data,...data}}:n)});
 for(const bad of [change('fork',{branches:[{id:'first',label:'A'},{id:'first',label:'B'}]}),change('fork',{branches:[{id:'first',label:'A'}]}),change('join',{splitId:'a'}),change('join',{operation:'unknown'}),{...graph,edges:graph.edges.filter(e=>e.source!=='a')},{...graph,edges:graph.edges.map(e=>e.source==='b'?{...e,target:'tail'}:e)},{...graph,edges:[...graph.edges,edge('t','join')]},{...graph,edges:graph.edges.map(e=>e.source==='fork' && e.sourceHandle==='second'?{...e,target:'a'}:e)},{...graph,nodes:[...graph.nodes,node('extra','merge',{splitId:'fork',operation:'collect'})],edges:[...graph.edges,edge('tail','extra')]}])assert.throws(()=>validateGraph(bad));
 const conditional={...graph,nodes:graph.nodes.map(n=>n.id==='a'?node('a','condition',{field:'flag',operator:'exists'}):n),edges:graph.edges.map(e=>e.source==='a'?{...e,sourceHandle:'true'}:e)};
 assert.throws(()=>validateGraph(conditional),/every Condition/);
 validateGraph({...conditional,edges:[...conditional.edges,edge('a','join','false')]});
 const loop={nodes:[node('t','trigger.manual'),fork,node('each','loop',{source:'items'}),node('leaf','set',{values:{value:'{{item}}'}}),node('b','set',{values:{value:'B'}}),join],edges:[edge('t','fork'),edge('fork','each','first'),edge('fork','b','second'),edge('each','leaf','each'),edge('each','join','done'),edge('b','join')]};
 validateGraph(loop);assert.throws(()=>validateGraph({...loop,edges:[...loop.edges,edge('leaf','join')]}));
 assert.throws(()=>splitPlan(graph,{...fork,data:{...fork.data,branches:Array.from({length:11},(_,i)=>({id:'b'+i,label:'Branch'}))}}),/2-10/);
});

test('ordered durable branch scopes isolate Set values, nest with Loop, collect/append once and reuse saved completions',()=>{
 const base={items:[0,false],branch:'outside',privateValue:'base',nodes:{prior:{keep:true}}};
 let step=advanceWorkflow(graph,fork,base,{},splitPlan(graph,fork));
 assert.equal(step.entering,true);assert.equal(step.next,'a');assert.equal(iterationPath(step.runtime),'[["fork",0]]');assert.equal(step.context.branch.id,'first');
 step=advanceWorkflow(graph,graph.nodes[2],step.context,step.runtime,interpolate(graph.nodes[2].data.values,step.context));
 assert.equal(step.next,'b');assert.equal(step.context.privateValue,'base','Set values must not leak into the next branch');assert.equal(iterationPath(step.runtime),'[["fork",1]]');assert.equal(step.completions.length,0);
 // This is the exact persisted cursor a Wait/retry/replay resumes; structured cloning must preserve it.
 step=advanceWorkflow(graph,graph.nodes[3],structuredClone(step.context),structuredClone(step.runtime),{value:'B'});
 assert.equal(step.next,'join');assert.equal(iterationPath(step.runtime),'');assert.equal(step.runtime.splits.length,0);assert.equal(step.context.branch,'outside');assert.equal(step.context.privateValue,'base');assert.equal(step.completions.length,1);assert.equal(step.completions[0].node_id,'fork');assert.equal(step.completions[0].iteration_path,'');
 assert.deepEqual(step.context.nodes.fork,{branches:[{id:'first',label:'First',output:{value:'A',privateValue:true}},{id:'second',label:'Second',output:{value:'B'}}],count:2});
 const merged=mergeOutputs(join.data,step.context.nodes.fork);assert.deepEqual(merged.items,[{value:'A',privateValue:true},{value:'B'}]);
 step=advanceWorkflow(graph,join,step.context,step.runtime,merged);assert.equal(step.next,'tail');assert.equal(step.completions.length,0);
 step=advanceWorkflow(graph,graph.nodes[5],step.context,step.runtime,interpolate(graph.nodes[5].data.values,step.context));assert.equal(step.next,null);assert.equal(step.context.last.first,'A');assert.equal(step.context.last.second,'B');assert.equal(step.context.last.collected.length,2);assert.deepEqual(base.nodes,{prior:{keep:true}});
 const saved=advanceWorkflow(graph,fork,base,{},step.context.nodes.fork,undefined,true);assert.equal(saved.next,'join');assert.equal(saved.entering,false);
 assert.deepEqual(mergeOutputs({...join.data,operation:'append'},{branches:[{id:'a',output:{items:[0,false,null]}},{id:'b',output:{items:['李华',{code:'007'}]}}]}).items,[0,false,null,'李华',{code:'007'}]);
 assert.throws(()=>mergeOutputs({...join.data,operation:'append'},{branches:[{output:{items:[]}},{output:{value:1}}]}),/every branch/);
 assert.throws(()=>mergeOutputs({...join.data,operation:'append'},{branches:[{output:{items:Array(1000).fill(1)}},{output:{items:[2]}}]}),/1,000/);
 assert.throws(()=>mergeOutputs(join.data,{branches:[{output:'x'.repeat(262144)},{output:1}]}),/256 KiB/);
 assert.throws(()=>advanceWorkflow(graph,fork,{huge:'x'.repeat(1048576)}, {},{}),/1 MB/);
 let active=advanceWorkflow(graph,fork,base,{},{});assert.throws(()=>advanceWorkflow({...graph,edges:graph.edges.filter(e=>e.source!=='a')},graph.nodes[2],active.context,active.runtime,{}),/ended before/);
 const nested={nodes:[node('t','trigger.manual'),fork,node('each','loop',{source:'items'}),node('leaf','set',{values:{value:'{{item}}'}}),node('b','set'),join],edges:[edge('t','fork'),edge('fork','each','first'),edge('fork','b','second'),edge('each','leaf','each'),edge('each','join','done'),edge('b','join')]};
 active=advanceWorkflow(nested,fork,base,{},{});active=advanceWorkflow(nested,nested.nodes[2],active.context,active.runtime,loopInput({source:'items'},active.context));assert.equal(iterationPath(active.runtime),'[["fork",0],["each",0]]');
 for(let i=0;i<2;i++)active=advanceWorkflow(nested,nested.nodes[3],active.context,active.runtime,{value:active.context.item});
 assert.equal(active.next,'b');assert.equal(active.completions[0].iteration_path,'[["fork",0]]');assert.equal(iterationPath(active.runtime),'[["fork",1]]');
 active=advanceWorkflow(nested,nested.nodes[4],active.context,active.runtime,{value:'B'});assert.equal(active.next,'join');assert.deepEqual(active.context.nodes.fork.branches[0].output.items,[{value:0},{value:false}]);
 const outer={nodes:[node('t','trigger.manual'),node('outer','loop',{source:'items'}),fork,node('a','set'),node('b','set'),join],edges:[edge('t','outer'),edge('outer','fork','each'),edge('fork','a','first'),edge('fork','b','second'),edge('a','join'),edge('b','join')]};validateGraph(outer);
 active=advanceWorkflow(outer,outer.nodes[1],{items:[1]}, {},{items:[1]});active=advanceWorkflow(outer,fork,active.context,active.runtime,{});assert.equal(iterationPath(active.runtime),'[["outer",0],["fork",0]]');
 active=advanceWorkflow(outer,outer.nodes[3],active.context,active.runtime,{item:1});active=advanceWorkflow(outer,outer.nodes[4],active.context,active.runtime,{item:2});assert.equal(active.next,'join');assert.equal(active.completions[0].iteration_path,'[["outer",0]]');
 active=advanceWorkflow(outer,join,active.context,active.runtime,mergeOutputs(join.data,active.context.nodes.fork));assert.equal(active.next,null);assert.equal(active.completions[0].node_id,'outer');assert.equal(active.context.last.count,1);
});
