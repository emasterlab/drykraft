import {createHmac} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './model.mjs';
import {hashPassword} from './auth.mjs';
import {authorizedPlatform} from './platform-auth.mjs';
import {resellerDatabaseAction,resellerTransaction} from './reseller-db.mjs';

const uuid=z.string().uuid(),reason=z.string().trim().min(10).max(1000),role=z.enum(['owner','admin','support','billing']);
const common={email:z.string().trim().toLowerCase().email().max(200),role,request_id:uuid,reason};
export const memberCreateSchema=z.discriminatedUnion('mode',[
 z.object({...common,mode:z.literal('new_account'),name:z.string().trim().min(2).max(100),initial_password:z.string().min(12).max(128)}).strict(),
 z.object({...common,mode:z.literal('existing_account')}).strict(),
]);
export const memberUpdateSchema=z.object({role,disabled:z.boolean(),version:z.number().int().positive(),reason}).strict();
export const memberPageSchema=z.object({cursor:uuid.optional()}).strict();
export function memberPage(data){return {items:data.items.slice(0,25),next_cursor:data.items.length>25?data.items[24].id:null};}
export async function memberCreation(body){
 const key=process.env.ENCRYPTION_KEY;
 if(!key||!/^[a-f0-9]{64}$/.test(key))throw new AppError(503,'Secure account setup is not configured.');
 // A private purpose-bound MAC permits retry comparison without persisting a fast password digest.
 const fingerprint=createHmac('sha256',Buffer.from(key,'hex')).update('drykraft-reseller-member-v1\0').update(JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
 const input={mode:body.mode,email:body.email,role:body.role,...(body.mode==='new_account'?{name:body.name,password_hash:await hashPassword(body.initial_password)}:{})};
 return {input,fingerprint};
}
export function mountPlatformResellerTeam(platformTeamRouter){
 platformTeamRouter.get('/resellers/:id/members/creations/:requestId',async(req,res)=>{
  const id=uuid.parse(req.params.id),request=uuid.parse(req.params.requestId);z.object({}).strict().parse(req.query);
  res.json(await resellerDatabaseAction(()=>authorizedPlatform(req,['owner','admin'],async(c,a)=>(await c.query('SELECT platform_reseller_member_receipt($1,$2,$3) AS data',[id,a.id,request])).rows[0].data)));
 });
 platformTeamRouter.get('/resellers/:id/members/:memberId',async(req,res)=>{
  const id=uuid.parse(req.params.id),member=uuid.parse(req.params.memberId);z.object({}).strict().parse(req.query);
  res.json(await resellerDatabaseAction(()=>authorizedPlatform(req,['owner','admin','viewer'],async(c,a)=>(await c.query('SELECT platform_reseller_member_detail($1,$2,$3) AS data',[id,a.id,member])).rows[0].data)));
 });
 platformTeamRouter.get('/resellers/:id/members',async(req,res)=>{
  const id=uuid.parse(req.params.id),q=memberPageSchema.parse(req.query);
  res.json(await resellerDatabaseAction(()=>authorizedPlatform(req,['owner','admin','viewer'],async(c,a)=>memberPage((await c.query('SELECT platform_reseller_members($1,$2,$3) AS data',[id,a.id,q.cursor||null])).rows[0].data))));
 });
 platformTeamRouter.post('/resellers/:id/members',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=memberCreateSchema.parse(req.body);
  const saved=await resellerDatabaseAction(()=>authorizedPlatform(req,['owner','admin'],async(c,a)=>{
   const {input,fingerprint}=await memberCreation(b);
   return (await c.query('SELECT platform_save_reseller_member($1,$2,NULL,NULL,$3,$4,$5,$6) AS data',[id,a.id,input,b.reason,b.request_id,fingerprint])).rows[0].data;
  }));res.status(saved.replayed?200:201).json(saved);
 });
 platformTeamRouter.put('/resellers/:id/members/:memberId',async(req,res)=>{
  const id=uuid.parse(req.params.id),member=uuid.parse(req.params.memberId),b=memberUpdateSchema.parse(req.body);
  res.json(await resellerDatabaseAction(()=>authorizedPlatform(req,['owner','admin'],async(c,a)=>(await c.query('SELECT platform_save_reseller_member($1,$2,$3,$4,$5,$6,$7,NULL) AS data',[id,a.id,member,b.version,{role:b.role,disabled:b.disabled},b.reason,req.requestId])).rows[0].data)));
 });
}
export function mountResellerTeam(staffTeamRouter){
 staffTeamRouter.get('/members/creations/:requestId',async(req,res)=>{
  const id=uuid.parse(req.params.requestId);z.object({}).strict().parse(req.query);
  res.json(await resellerDatabaseAction(()=>resellerTransaction(async c=>(await c.query('SELECT reseller_staff_member_receipt($1,$2) AS data',[req.rs.session_hash,id])).rows[0].data)));
 });
 staffTeamRouter.get('/members/:id',async(req,res)=>{
  const id=uuid.parse(req.params.id);z.object({}).strict().parse(req.query);
  res.json(await resellerDatabaseAction(()=>resellerTransaction(async c=>(await c.query('SELECT reseller_staff_member_detail($1,$2) AS data',[req.rs.session_hash,id])).rows[0].data)));
 });
 staffTeamRouter.post('/members',async(req,res)=>{
  const b=memberCreateSchema.parse(req.body);
  // Release the preliminary read locks before the write takes parent and sorted account locks.
  await resellerDatabaseAction(()=>resellerTransaction(c=>c.query("SELECT reseller_staff_read($1,'members',NULL,NULL)",[req.rs.session_hash])));
  const {input,fingerprint}=await memberCreation(b);
  const saved=await resellerDatabaseAction(()=>resellerTransaction(async c=>(await c.query('SELECT reseller_staff_save_team($1,NULL,NULL,$2,$3,$4,$5) AS data',[req.rs.session_hash,input,b.reason,b.request_id,fingerprint])).rows[0].data));
  res.status(saved.replayed?200:201).json(saved);
 });
 staffTeamRouter.put('/members/:id',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=memberUpdateSchema.parse(req.body);
  res.json(await resellerDatabaseAction(()=>resellerTransaction(async c=>(await c.query('SELECT reseller_staff_save_team($1,$2,$3,$4,$5,$6,NULL) AS data',[req.rs.session_hash,id,b.version,{role:b.role,disabled:b.disabled},b.reason,req.requestId])).rows[0].data)));
 });
}
