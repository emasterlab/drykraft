import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {platformPool,platformTransaction} from '../server/platform-db.mjs';
import {hashPassword} from '../server/auth.mjs';
import {pool} from '../server/db.mjs';

// Credentials enter through stdin, never command arguments or output. This is first-owner bootstrap only.
let raw='';for await(const b of process.stdin){raw+=b;if(raw.length>4096)throw Error('Bootstrap input is too large.');}
const b=z.object({email:z.string().trim().toLowerCase().email().max(200),name:z.string().trim().min(2).max(100),password:z.string().min(12).max(128)}).strict().parse(JSON.parse(raw));
try{
 const hash=await hashPassword(b.password);
 const id=await platformTransaction(async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('drykraft-platform-governance',0))");
  if((await c.query('SELECT 1 FROM platform_accounts LIMIT 1')).rowCount)throw Error('Platform accounts already exist. Sign in as an owner to manage them.');
  const id=randomUUID();await c.query("INSERT INTO platform_accounts(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,'owner')",[id,b.email,b.name,hash]);
  await c.query("INSERT INTO platform_audit(id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'platform.owner.bootstrapped','account',$2,'Initial owner explicitly designated by the product owner.')",[randomUUID(),id]);return id;
 });console.log(JSON.stringify({account_id:id,created:true,authenticator_setup_required:true}));
}finally{await platformPool?.end();await pool.end();}
