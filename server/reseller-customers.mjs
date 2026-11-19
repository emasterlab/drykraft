import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {builtIns,defaultStages,defaultWidgets} from './model.mjs';
import {tokenHash} from './auth.mjs';
import {currencySchema} from './currency.mjs';
import {encryptCredential,decryptCredential} from './automation.mjs';
import {resellerTransaction,resellerDatabaseAction} from './reseller-db.mjs';

const uuid=z.string().uuid(),reason=z.string().trim().min(10).max(1000),version=z.number().int().positive();
const reserved=new Set(['www','app','api','admin','auth','support','mail','assets','status','demo']);
const timezone=z.string().max(80).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return /[A-Za-z]/.test(value);}catch{return false;}},'Choose a named IANA timezone.');
const name=z.string().trim().min(2).max(100);
const provision=z.object({request_id:uuid,name,slug:z.string().regex(/^[a-z][a-z0-9-]{2,39}$/).refine(v=>!reserved.has(v),'This workspace address is reserved.'),owner_email:z.string().trim().toLowerCase().email().max(200),currency:currencySchema,currencies:z.array(currencySchema).min(1).max(180),timezone,retail_plan_id:uuid,retail_plan_version:version,reason}).strict().superRefine((b,c)=>{
 if(!b.currencies.includes(b.currency)||new Set(b.currencies).size!==b.currencies.length)c.addIssue({code:'custom',message:'Enabled currencies must be unique and include the default currency.'});
});
const action=fn=>resellerDatabaseAction(()=>resellerTransaction(fn));
const scope=id=>'reseller-owner:'+id;
const noQuery=req=>z.object({}).strict().parse(req.query);
export function mountResellerCustomers(customerRouter){
 customerRouter.post('/customers',async(req,res)=>{
  const b=provision.parse(req.body),{request_id,currency,currencies,timezone,...details}=b;
  const input={...details,settings:{currency,currencies,timezone}},id=randomUUID(),raw=randomBytes(32).toString('hex');
  const saved=await action(async c=>(await c.query('SELECT reseller_staff_provision_customer($1,$2,$3,$4,$5,$6,$7,$8) AS data',[
   req.rs.session_hash,input,request_id,tokenHash(JSON.stringify(input)),id,tokenHash(raw),encryptCredential(scope(id),{token:raw}),{definitions:builtIns,stages:defaultStages,widgets:defaultWidgets},
  ])).rows[0].data);
  res.status(saved.replayed?200:201).json(saved);
 });
 customerRouter.get('/customers/provisioning/:requestId',async(req,res)=>{
  noQuery(req);const id=uuid.parse(req.params.requestId);
  res.json(await action(async c=>(await c.query('SELECT reseller_staff_customer_receipt($1,$2) AS data',[req.rs.session_hash,id])).rows[0].data));
 });
 customerRouter.get('/customers/:id',async(req,res)=>{
  noQuery(req);const id=uuid.parse(req.params.id);
  res.json(await action(async c=>(await c.query('SELECT reseller_staff_customer_detail($1,$2) AS data',[req.rs.session_hash,id])).rows[0].data));
 });
 customerRouter.put('/customers/:id',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version,name,reason,request_id:uuid}).strict().parse(req.body);
  res.json(await action(async c=>(await c.query('SELECT reseller_staff_update_customer($1,$2,$3,$4,$5,$6) AS data',[req.rs.session_hash,id,b.version,b.name,b.reason,b.request_id])).rows[0].data));
 });
 customerRouter.post('/customers/:id/state',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version,suspended:z.boolean(),reason,request_id:uuid}).strict().parse(req.body);
  res.json(await action(async c=>(await c.query('SELECT reseller_staff_customer_state($1,$2,$3,$4,$5,$6) AS data',[req.rs.session_hash,id,b.version,b.suspended,b.reason,b.request_id])).rows[0].data));
 });
 customerRouter.put('/customers/:id/plan',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version,retail_plan_id:uuid,retail_plan_version:version,reason,request_id:uuid}).strict().parse(req.body);
  res.json(await action(async c=>(await c.query('SELECT reseller_staff_assign_customer_plan($1,$2,$3,$4,$5,$6,$7) AS data',[req.rs.session_hash,id,b.version,b.retail_plan_id,b.retail_plan_version,b.reason,b.request_id])).rows[0].data));
 });
 customerRouter.post('/customers/:id/owner-invitation',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version,operation:z.enum(['link','renew','revoke']),reason,request_id:uuid}).strict().parse(req.body);
  const raw=b.operation==='renew'?randomBytes(32).toString('hex'):null;
  // Release read locks before taking workspace/commercial write locks. The write gateway checks the invitation version again.
  const current=raw?await action(async c=>(await c.query('SELECT reseller_staff_customer_detail($1,$2) AS data',[req.rs.session_hash,id])).rows[0].data):null;
  const ciphertext=raw&&current?.invitation?encryptCredential(scope(current.invitation.id),{token:raw}):null;
  const result=await action(async c=>{
   const saved=(await c.query('SELECT reseller_staff_owner_invitation($1,$2,$3,$4,$5,$6,$7,$8) AS data',[req.rs.session_hash,id,b.version,b.operation,raw?tokenHash(raw):null,ciphertext,b.reason,b.request_id])).rows[0].data;
   const {ciphertext:privateCipher,...metadata}=saved;
   return {...metadata,invitation_token:privateCipher?decryptCredential(scope(saved.id),privateCipher).token:raw};
  });
  res.json(result);
 });
}
