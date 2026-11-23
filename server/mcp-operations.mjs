import { apiOperations,apiSchemas } from './api-documentation.mjs';

const groups=new Set(['records','imports-lists','sales-dashboards','workspace','team','templates','finance','calendar','calendar-connections','automation','outreach-connections','outreach-campaigns','billing','customer-webhooks']);
const excluded=/^\/api\/(?:settings\/(?:invitations|members\/)|automation\/(?:credentials|workflows\/\{id\}\/webhook)|outreach\/(?:oauth|connections\/\{id\}\/(?:webhook|reconnect|subscribe))|calendar\/oauth)/;
const readPosts=new Set(['/api/analytics/query','/api/analytics/export','/api/templates/invoice-preview','/api/automation/schedules/preview','/api/calendar/local-times','/api/record-tools/{key}/import/preview','/api/record-tools/people/merge/preview','/api/outreach/campaigns/{id}/preview']);
const segment=/^[a-zA-Z0-9_-]{1,128}$/;

const warmup='/api/outreach/connections/{id}/warmup';
const additional=[
  {id:'get-outreach-connection-warmup',group:'outreach-connections',method:'GET',path:warmup,title:'Read email warmup',description:'Read mailbox allowance, usage and warmup progress.',access:'Workspace member'},
  {id:'put-outreach-connection-warmup',group:'outreach-connections',method:'PUT',path:warmup,title:'Configure email warmup',description:'Set the starting allowance, daily increase and target for an email connection.',access:'Owner or admin',body:{type:'object',properties:{startDaily:{type:'integer'},dailyIncrease:{type:'integer'},targetDaily:{type:'integer'},restart:{type:'boolean'}},required:['startDaily','dailyIncrease','targetDaily']}},
  {id:'post-outreach-connection-warmup-status',group:'outreach-connections',method:'POST',path:warmup+'/status',title:'Pause, resume or disable email warmup',access:'Owner or admin',body:{type:'object',properties:{status:{enum:['active','paused','disabled']}},required:['status']}}
];

function exposed(op){
  if(op.path==='/api/session')return op.method==='GET';
  if(!groups.has(op.group)||excluded.test(op.path))return false;
  if(op.group==='billing'||op.group==='customer-webhooks')return op.method==='GET';
  if(op.path==='/api/outreach/connections'&&op.method==='POST')return false;
  if(op.path==='/api/outreach/connections/{id}'&&op.method!=='GET')return false;
  return true;
}

export const mcpOperations=[...apiOperations.filter(exposed),...additional].map(operation=>{
  const path=operation.path.replace(/\/$/,'');
  const parts=path.split('/');
  const parameters=parts.filter(p=>p.startsWith('{')).map(p=>p.slice(1,-1));
  return {...operation,path,parts,parameters,readOnly:operation.method==='GET'||readPosts.has(path)};
});
const denied=apiOperations.filter(op=>!exposed(op)).map(op=>({...op,parts:op.path.replace(/\/$/,'').split('/')}));

function matches(operation,method,parts){
  return operation.method===method&&operation.parts.length===parts.length&&
    operation.parts.every((part,i)=>part.startsWith('{')?segment.test(parts[i]):part.toLowerCase()===parts[i].toLowerCase());
}
export function mcpOperationForRequest(method,path){
  const parts=path.replace(/\/$/,'').split('/');
  if(denied.some(op=>matches(op,method,parts)))return undefined;
  return mcpOperations.find(op=>matches(op,method,parts));
}
export function operationPath(operation,parameters){
  if(Object.keys(parameters).length!==operation.parameters.length)throw Error('Provide the listed path parameters.');
  return operation.parts.map(part=>{
    if(!part.startsWith('{'))return part;
    const value=parameters[part.slice(1,-1)];
    if(typeof value!=='string'||!segment.test(value))throw Error('Invalid or missing path parameter '+part+'.');
    return value;
  }).join('/');
}

export function describeMcpOperation({id,title,description,group,access,method,path,parameters,query,queryRequired,body,readOnly}){
  const definitions={};
  function collect(value){
    if(!value||typeof value!=='object')return;
    if(typeof value.$ref==='string'){
      const key=value.$ref.split('/').at(-1);
      if(apiSchemas[key]&&!Object.hasOwn(definitions,key)){
        definitions[key]=apiSchemas[key];
        collect(apiSchemas[key]);
      }
    }
    for(const child of Object.values(value))collect(child);
  }
  collect(body);collect(query);
  return {id,title,description,group,access,method,path,parameters,query,queryRequired,body,readOnly,...(Object.keys(definitions).length?{schemas:definitions}:{})};
}
