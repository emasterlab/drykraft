import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnvFile } from 'node:process';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDryKraftMcp } from '../server/mcp-tools.mjs';

if(process.env.DRYKRAFT_MCP_ENV_FILE)loadEnvFile(process.env.DRYKRAFT_MCP_ENV_FILE);
const token=process.env.DRYKRAFT_MCP_TOKEN;
const base=new URL(process.env.DRYKRAFT_MCP_URL||'https://app.drykraft.com');
const local=['localhost','127.0.0.1','[::1]'].includes(base.hostname)||base.hostname.endsWith('.localhost');
if((base.protocol!=='https:'&&!(local&&base.protocol==='http:'))||
   base.username||base.password||base.pathname!=='/'||base.search||base.hash)
  throw Error('DRYKRAFT_MCP_URL must be the HTTPS workspace origin or a local HTTP origin.');

const server=createDryKraftMcp({token,base,exportResult:async({content,type,ext})=>{
  const folder=await mkdtemp(path.join(tmpdir(),'drykraft-mcp-'));
  const file=path.join(folder,'result.'+(ext||(type==='application/json'?'json':'txt')));
  await writeFile(file,content,{mode:0o600});
  return {content:[{type:'text',text:JSON.stringify({file,bytes:content.length,contentType:type})}]};
}});
await server.connect(new StdioServerTransport());
