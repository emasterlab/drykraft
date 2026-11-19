import test from 'node:test';
import assert from 'node:assert/strict';
import {executeXml,validateXml} from '../server/workflow-xml.mjs';
import {validateGraph} from '../server/automation.mjs';

const parse={operation:'parse',source:'xml'},create={operation:'serialize',source:'last.document'};
const element=(name='sample',children=[],attributes=[])=>({type:'element',name,attributes,children});
const document=(children)=>({type:'document',children});
test('XML ordered trees preserve namespaced mixed content, repeated children, text types and normalized round trips',()=>{
 const input='\uFEFF<?xml version="1.0" encoding="utf-8" standalone="yes"?><!--sample--><?guide preview?><customers xmlns="urn:sample" xmlns:p="urn:detail" count="007">Before <p:person code="A&amp;B">李华</p:person> after<p:person code="2"><![CDATA[a < b & c]]></p:person>\r\n</customers>';
 const a=executeXml(parse,input);assert.equal(a.root,'customers');assert.equal(a.elements,3);assert.equal(a.document.standalone,true);
 const root=a.document.children[2];assert.deepEqual(root.attributes,[{name:'xmlns',value:'urn:sample'},{name:'xmlns:p',value:'urn:detail'},{name:'count',value:'007'}]);
 assert.deepEqual(root.children.map(c=>c.type),['text','element','text','element','text']);assert.equal(root.children[1].attributes[0].value,'A&B');assert.equal(root.children[1].children[0].value,'李华');assert.equal(root.children[3].children[0].value,'a < b & c');assert.equal(root.children[4].value,'\n');
 const b=executeXml(create,a.document);assert.match(b.xml,/encoding="UTF-8" standalone="yes"/);assert.deepEqual(executeXml(parse,b.xml),a);
 const edited=document([element('客户',[{type:'text',value:'007 & < > \r'},{type:'cdata',value:'contains ]]> safely'}],[{name:'note',value:'"\t\n\r<&'}])]);
 const c=executeXml(parse,executeXml(create,edited).xml);assert.equal(c.document.children[0].attributes[0].value,'"\t\n\r<&');assert.equal(c.document.children[0].children[0].value,'007 & < > \r');assert.equal(c.document.children[0].children[1].value,'contains ]]> safely');
 const deep='<a>'.repeat(32)+'value'+'</a>'.repeat(32);assert.deepEqual(executeXml(parse,executeXml(create,executeXml(parse,deep).document).xml),executeXml(parse,deep));
 assert.equal(executeXml(parse,'<a>'+'<b/>'.repeat(999)+'</a>').elements,1000);
 assert.deepEqual(executeXml(parse,'<constructor __proto__="ordinary attribute"/>').document.children[0].attributes,[{name:'__proto__',value:'ordinary attribute'}]);assert.equal({}.polluted,undefined);
 const node=(id,kind,data={})=>({id,type:'workflow',position:{x:0,y:0},data:{kind,label:id,...data}});
 const graph={nodes:[node('t','trigger.manual'),node('p','data.xml',parse),node('c','data.xml',create)],edges:[{id:'tp',source:'t',target:'p'},{id:'pc',source:'p',target:'c'}]};assert.deepEqual(validateGraph(graph),graph);
 assert.throws(()=>validateGraph({...graph,nodes:graph.nodes.map(n=>n.id==='p'?{...n,data:{...n.data,source:'constructor.secret'}}:n)}),/XML needs/);
});

test('XML rejects malformed or unsafe documents, markup injection, invalid trees and excessive work before downstream actions',()=>{
 for(const input of ['',null,{},'<a>','<a/><b/>','outside<a/>','<p:a/>','<a x="1" x="2"/>','<a>&missing;</a>','<a>\0</a>','<a>&#0;</a>','<?xml version="1.1"?><a/>','<?xml version="1.0" encoding="UTF-16"?><a/>'])assert.throws(()=>executeXml(parse,input));
 for(const input of ['<!DOCTYPE a SYSTEM "file:///private/example"><a/>','<!DOCTYPE a [<!ENTITY x "secret">]><a>&x;</a>','<!DOCTYPE a [<!ENTITY x SYSTEM "https://example.test/private">]><a/>'])assert.throws(()=>executeXml(parse,input),/DTD/);
 assert.throws(()=>executeXml(parse,'<a>'.repeat(33)+'</a>'.repeat(33)),/32/);
 assert.throws(()=>executeXml(parse,'<a>'+'<b/>'.repeat(1000)+'</a>'),/1,000/);
 assert.equal(executeXml(parse,'<a>'+'<!--x-->'.repeat(4999)+'</a>').elements,1);
 assert.throws(()=>executeXml(parse,'<a>'+'<!--x-->'.repeat(5000)+'</a>'),/5,000/);
 assert.throws(()=>executeXml(parse,'<a>'+'x'.repeat(262144)+'</a>'),/256/);
 assert.throws(()=>executeXml(parse,'<a>'+'"'.repeat(140000)+'</a>'),/output exceeds/);
 assert.throws(()=>executeXml(parse,'<a '+Array.from({length:101},(_,i)=>`v${i}="x"`).join(' ')+'/>'),/100 attributes/);
 for(const tree of [document([]),document([element('a'),element('b')]),document([{type:'text',value:'outside'},element()]),document([element('p:a')]),document([element('a',[],[{name:'x',value:'1'},{name:'x',value:'2'}])]),document([element('a',[],[{name:'x="injected" extra',value:'1'}])]),document([element('a',[{type:'text',value:1}])]),document([element('a',[{type:'comment',value:'x--><injected/><!--y'}])]),document([element('a',[{type:'instruction',name:'sample',value:'x?><injected/><?sample y'}])]),document([element('a',[{type:'comment',value:'end-'}])]),document([element('a',[{type:'text',value:'\uD800'}])])])assert.throws(()=>executeXml(create,tree));
 const cycle=element();cycle.children.push(cycle);assert.throws(()=>executeXml(create,document([cycle])),/32/);
 assert.throws(()=>executeXml(create,document([element('a',[{type:'text',value:'&'.repeat(60000)}])])),/output exceeds/);
 for(const settings of [{operation:'other',source:'xml'},{operation:'parse',source:'{{xml}}'},{operation:'parse',source:'a.__proto__.b'}])assert.throws(()=>validateXml(settings),/XML needs/);
});
