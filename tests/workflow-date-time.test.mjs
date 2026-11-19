import test from 'node:test';
import assert from 'node:assert/strict';
import {executeDateTime,validateDateTime,parseWorkflowDate} from '../server/workflow-date-time.mjs';
import {interpolate,validateGraph} from '../server/automation.mjs';

test('Date/Time validates ISO instants and performs explicit calendar, duration and display operations',()=>{
  const base={operation:'format',date:'2024-01-31T09:15:20.123Z',timezone:'Asia/Kolkata',locale:'en-GB',format:'full'};
  const local=executeDateTime(base);assert.equal(local.iso,base.date);assert.equal(local.date,'2024-01-31');assert.equal(local.time,'14:45:20');assert.equal(local.timestamp,Date.parse(base.date));assert.match(local.formatted,/14:45:20/);
  assert.equal(executeDateTime({...base,date:'2024-02-01T00:15:00+05:30'}).iso,'2024-01-31T18:45:00.000Z');
  assert.equal(executeDateTime({...base,date:'2024-01-31',format:'iso'}).formatted,'2024-01-31T00:00:00.000Z');
  for(const date of ['2023-02-29','2024-02-30','2024-13-01','2024-00-01','2024-01-00','2024-01-31T09:00:00','2024-01-31T24:00:00Z','2024-01-31T09:60:00Z','2024-01-31T09:00:60Z','2024-01-31T09:00:00+24:00','01/31/2024','0000-01-01','',null,123])assert.throws(()=>parseWorkflowDate(date));
  assert.equal(parseWorkflowDate('0099-01-01').getUTCFullYear(),99);assert.equal(parseWorkflowDate('2000-02-29').getUTCDate(),29);assert.throws(()=>parseWorkflowDate('1900-02-29'));
  const shift={...base,operation:'shift',amount:1,unit:'months'};
  assert.equal(executeDateTime(shift).iso,'2024-02-29T09:15:20.123Z');assert.equal(executeDateTime({...shift,date:'2023-01-31'}).date,'2023-02-28');assert.equal(executeDateTime({...shift,date:'2024-02-29',unit:'years'}).date,'2025-02-28');assert.equal(executeDateTime({...shift,date:'2024-03-31',amount:-1}).date,'2024-02-29');
  assert.equal(executeDateTime({...shift,amount:1.5,unit:'hours'}).iso,'2024-01-31T10:45:20.123Z');
  const dst={...base,date:'2026-03-08T01:30:00-05:00',timezone:'America/New_York'};assert.equal(executeDateTime({...dst,operation:'shift',amount:1,unit:'days'}).time,'02:30:00');
  const diff={operation:'difference',date:'2026-03-08T01:30:00-05:00',otherDate:'2026-03-09T01:30:00-04:00',unit:'hours'};assert.equal(executeDateTime(diff).difference,23);assert.equal(executeDateTime({...diff,date:diff.otherDate,otherDate:diff.date}).difference,-23);
  for(const bad of [{...base,timezone:'Bad/Zone'},{...base,locale:'invalid_locale'},{...shift,amount:'1'},{...shift,amount:0.5},{...diff,unit:'months'},{...shift,amount:Infinity},{...shift,date:'9999-12-31'},{...base,date:'0001-01-01',timezone:'America/New_York'}])assert.throws(()=>executeDateTime(bad));
  assert.equal(executeDateTime({...base,operation:'now'},new Date(base.date)).iso,base.date);
  const dynamic={...shift,date:'{{inputDate}}',amount:'{{amount}}'};validateDateTime(dynamic);assert.equal(executeDateTime({...dynamic,date:interpolate(dynamic.date,{inputDate:'2024-01-31'}),amount:interpolate(dynamic.amount,{amount:1})}).date,'2024-02-29');assert.throws(()=>executeDateTime({...dynamic,date:'2024-01-31',amount:'1'}));
  const uuidStep='de5ea362-1891-41af-a6b4-70d3e5eb276d',uuidAmount='{{nodes.'+uuidStep+'.amount}}';validateDateTime({...shift,amount:uuidAmount});assert.equal(executeDateTime({...shift,amount:interpolate(uuidAmount,{nodes:{[uuidStep]:{amount:1}}})}).date,'2024-02-29');
  const node=(id,kind,data={})=>({id,type:'workflow',position:{x:0,y:0},data:{kind,label:id,...data}}),graph={nodes:[node('t','trigger.manual'),node('date','date.time',dynamic)],edges:[{id:'e',source:'t',target:'date'}]};assert.equal(validateGraph(graph).nodes.length,2);assert.throws(()=>validateGraph({...graph,nodes:[graph.nodes[0],node('date','date.time',{...base,date:'2024-02-30'})]}));
});
