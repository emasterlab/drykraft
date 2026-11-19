import test from 'node:test';
import assert from 'node:assert/strict';
import {executeCsv,validateCsv} from '../server/workflow-csv.mjs';
import {validateGraph} from '../server/automation.mjs';
import {parseCsv} from '../server/csv.mjs';

test('CSV transforms quoted Unicode, stable columns, empty lists and formula-safe exports without implicit coercion',()=>{
 const parse={operation:'parse',source:'csv'},serialize={operation:'serialize',source:'items',columns:['Name','Amount','Note']};
 const result=executeCsv(parse,'\uFEFFName,Amount,Note\r\n"Priya, Sharma",007,"Line one\nLine ""two"""\r\n李华,-12.5,Hello\r\n');
 assert.deepEqual(result,{headers:['Name','Amount','Note'],items:[{Name:'Priya, Sharma',Amount:'007',Note:'Line one\nLine "two"'},{Name:'李华',Amount:'-12.5',Note:'Hello'}],count:2});
 assert.deepEqual(executeCsv(parse,'Name,Amount\n'),{headers:['Name','Amount'],items:[],count:0});
 assert.deepEqual(executeCsv({...parse,columns:['']},'Name\nA').items,[{Name:'A'}],'Inactive creation columns do not prevent switching back to Parse CSV');
 assert.throws(()=>parseCsv('Name,Amount\n'),/no records/,'CRM imports keep rejecting headings-only content');
 const exported=executeCsv(serialize,[{Note:'  =SUM(A1:A2)',Amount:-12.5,Name:'Priya, Sharma',Ignored:'never exported'},{Name:'李华',Note:{label:'hello'},Amount:null}]);
 assert.equal(exported.count,2);assert.equal(exported.csv,'"Name","Amount","Note"\r\n"Priya, Sharma","-12.5","\'  =SUM(A1:A2)"\r\n"李华","","{""label"":""hello""}"');
 assert.equal(executeCsv(parse,exported.csv).items[0].Amount,'-12.5');assert.equal(executeCsv(parse,exported.csv).items[0].Note,"'  =SUM(A1:A2)");
 assert.deepEqual(executeCsv(serialize,[]),{csv:'"Name","Amount","Note"',headers:serialize.columns,count:0});
 const formulas=['=1+1','+SUM(A1)','-1+2','@SUM(A1)','\t=1'];
 for(const value of formulas)assert.equal(executeCsv(parse,executeCsv({...serialize,columns:['value']},[{value}]).csv).items[0].value,"'"+value);
 const many='name\n'+Array.from({length:501},(_,i)=>'Row '+i).join('\n');assert.equal(executeCsv(parse,many).count,501);assert.throws(()=>parseCsv(many),/500/);
 const node=(id,kind,data={})=>({id,type:'workflow',position:{x:0,y:0},data:{kind,label:id,...data}}),graph={nodes:[node('t','trigger.manual'),node('csv','data.csv',serialize)],edges:[{id:'e',source:'t',target:'csv'}]};
 assert.equal(validateGraph(graph).nodes[1].data.kind,'data.csv');assert.throws(()=>validateGraph({...graph,nodes:[graph.nodes[0],node('csv','data.csv',{...serialize,columns:[]})]}));
});

test('CSV rejects malformed data, unsafe configuration and bounded input/output expansion',()=>{
 const parse={operation:'parse',source:'csv'},serialize={operation:'serialize',source:'items',columns:['Name']};
 for(const csv of ['Name,name\nA,B','Name,Age\nA','Name\n"Unclosed','Name\n"Closed"text','Name\nA\0','constructor\nA','__proto__\nA','Name\n'+'x'.repeat(262145),'Name\n'+Array.from({length:1001},()=> 'A').join('\n')])assert.throws(()=>executeCsv(parse,csv));
 for(const raw of [{...parse,source:'{{csv}}'},{...parse,source:'nodes.__proto__.csv'},{...parse,operation:'invalid'},{...serialize,columns:['Name','name']},{...serialize,columns:[' Name']},{...serialize,columns:['constructor']},{...serialize,columns:['']},{...serialize,columns:Array.from({length:101},(_,i)=>'c'+i)},{...serialize,columns:undefined}])assert.throws(()=>validateCsv(raw));
 for(const value of [null,{},'text',[null],[[]],['text'],Array(1001).fill({Name:'A'}),[{Name:Infinity}]])assert.throws(()=>executeCsv(serialize,value));
 assert.throws(()=>executeCsv(parse,'Name\n'+'\\'.repeat(140000)),/output exceeds/);
 assert.throws(()=>executeCsv(serialize,[{Name:'"'.repeat(120000)}]),/output exceeds/);
 assert.throws(()=>executeCsv(parse,42),/UTF-8/);
 assert.deepEqual(executeCsv({...serialize,columns:['toString','Name']},[{Name:'A'}]).csv,'"toString","Name"\r\n"","A"');
});
