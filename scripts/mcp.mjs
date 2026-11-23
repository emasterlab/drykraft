import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadEnvFile } from 'node:process';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcpOperations,describeMcpOperation,operationPath } from '../server/mcp-operations.mjs';

if(process.env.DRYKRAFT_MCP_ENV_FILE)loadEnvFile(process.env.DRYKRAFT_MCP_ENV_FILE);
const token=process.env.DRYKRAFT_MCP_TOKEN;
const base=new URL(process.env.DRYKRAFT_MCP_URL||'https://app.drykraft.com');
const local=['localhost','127.0.0.1','[::1]'].includes(base.hostname)||base.hostname.endsWith('.localhost');
if((base.protocol!=='https:'&&!(local&&base.protocol==='http:'))||
   base.username||base.password||base.pathname!=='/'||base.search||base.hash)
  throw Error('DRYKRAFT_MCP_URL must be the HTTPS workspace origin or a local HTTP origin.');

const ops=new Map(mcpOperations.map(op=>[op.id,op]));
const object=z.record(z.string(),z.unknown());
const result=value=>({content:[{type:'text',text:JSON.stringify(value,null,2)}]});
const failure=error=>({isError:true,content:[{type:'text',text:error.message}]});
const server=new McpServer({name:'drykraft',version:'1.0.0'},{instructions:
  'Discover operations with drykraft_find_operations and inspect their schemas with drykraft_describe_operation. Use the exact operation ID and parameters. Ask the user before making changes, running a workflow or sending outreach. A confirmed write can affect the real workspace. The server never retries writes automatically.'});

server.registerTool('drykraft_find_operations',{
  description:'Find DryKraft operations for CRM, sales, finance and purchase orders, outreach and email warmup, calendar, automation, templates, reports, teams and settings.',
  inputSchema:{query:z.string().max(120).optional(),group:z.string().max(80).optional(),offset:z.number().int().min(0).optional()},
  annotations:{readOnlyHint:true}
},({query='',group,offset=0})=>{
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches=mcpOperations.filter(op=>(!group||op.group===group)&&words.every(word=>
    (op.title+' '+op.id+' '+op.group+' '+(op.description||'')).toLowerCase().includes(word)));
  return result({total:matches.length,groups:[...new Set(mcpOperations.map(op=>op.group))],nextOffset:offset+20<matches.length?offset+20:null,
    operations:matches.slice(offset,offset+20).map(({id,group,title,readOnly,access})=>({id,group,title,readOnly,access}))});
});

server.registerTool('drykraft_describe_operation',{
  description:'Read the inputs and role requirements of one DryKraft operation before calling it.',
  inputSchema:{id:z.string().max(120)},
  annotations:{readOnlyHint:true}
},({id})=>ops.has(id)?result(describeMcpOperation(ops.get(id))):failure(Error('Unknown operation. Search the catalog first.')));

async function call(args,readOnly){
 try{
  const op=ops.get(args.id);
  if(!op||op.readOnly!==readOnly)throw Error('Find an operation and use the matching read or write tool.');
  if(!token||!/^dk_mcp_[A-Za-z0-9_-]{43}$/.test(token))throw Error('Set DRYKRAFT_MCP_TOKEN to a token from DryKraft Account security.');
  if(!readOnly&&args.confirmed!==true)throw Error('Ask the user to confirm this change before calling the write tool.');
  const url=new URL(operationPath(op,args.parameters||{}),base);
  const query=args.query||{};
  for(const [key,value] of Object.entries(query)){
    if(!Object.hasOwn(op.query||{},key))throw Error('Unknown query parameter '+key+'.');
    url.searchParams.set(key,typeof value==='object'?JSON.stringify(value):String(value));
  }
  for(const key of op.queryRequired||[])if(!url.searchParams.has(key))throw Error('Missing query parameter '+key+'.');
  if(op.body&&args.body===undefined)throw Error('This operation requires a JSON body. Inspect its schema first.');
  if(!op.body&&args.body!==undefined)throw Error('This operation does not accept a body.');
  const response=await fetch(url,{
    method:op.method,redirect:'error',signal:AbortSignal.timeout(25000),
    headers:{Authorization:'Bearer '+token,...(op.body?{'Content-Type':'application/json'}:{})},
    ...(op.body?{body:JSON.stringify(args.body)}:{})
  });
  const type=(response.headers.get('content-type')||'').split(';')[0];
  const reader=response.body?.getReader();
  const chunks=[];let bytes=0;
  if(reader)for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    bytes+=value.byteLength;
    if(bytes>16*1024*1024){await reader.cancel();throw Error('DryKraft response is too large. Use a smaller page or download it in the browser.');}
    chunks.push(value);
  }
  const content=Buffer.concat(chunks);
  if(!response.ok){
    let message;
    try{message=JSON.parse(content.toString()).error?.message;}catch{}
    throw Error('DryKraft HTTP '+response.status+': '+(message||'Request could not be completed.'));
  }
  const ext=({'application/pdf':'pdf','text/csv':'csv','text/calendar':'ics'})[type];
  if(ext||content.length>24000){
    const folder=await mkdtemp(path.join(tmpdir(),'drykraft-mcp-'));
    const file=path.join(folder,'result.'+(ext||(type==='application/json'?'json':'txt')));
    await writeFile(file,content,{mode:0o600});
    return result({file,bytes:content.length,contentType:type});
  }
  return result(content.length?(type==='application/json'?JSON.parse(content.toString()):content.toString()):{ok:true});
 }catch(error){return failure(error);}
}
const input={id:z.string().max(120),parameters:object.optional(),query:object.optional(),body:object.optional()};
server.registerTool('drykraft_read',{
  description:'Read or preview DryKraft workspace data. Find and describe the operation first.',
  inputSchema:input,annotations:{readOnlyHint:true}
},args=>call(args,true));
server.registerTool('drykraft_write',{
  description:'Make a confirmed change in the real workspace, such as creating records or launching reviewed outreach. Requires a write token and user confirmation.',
  inputSchema:{...input,confirmed:z.literal(true)},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false}
},args=>call(args,false));
await server.connect(new StdioServerTransport());
