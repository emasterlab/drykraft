import {z} from 'zod';
import {limitsSchema,featuresSchema} from './entitlements.mjs';
import {currencySchema} from './currency.mjs';
import {resellerTransaction,resellerDatabaseAction} from './reseller-db.mjs';

const uuid=z.string().uuid(),price=z.number().int().min(0).max(1_000_000_000);
export const retailDefinitionSchema=z.object({name:z.string().trim().min(2).max(100),currency:currencySchema,monthly_price_minor:price,annual_price_minor:price,setup_price_minor:price,trial_days:z.number().int().min(0).max(90),limits:limitsSchema,features:featuresSchema}).strict();
const publication={definition:retailDefinitionSchema,reason:z.string().trim().min(10).max(1000),request_id:uuid};
const action=fn=>resellerDatabaseAction(()=>resellerTransaction(fn));
export function mountResellerPlans(staffPlansRouter){
 staffPlansRouter.get('/plans/allowance',async(req,res)=>{
  z.object({}).strict().parse(req.query);
  res.json(await action(async c=>(await c.query('SELECT reseller_staff_plan_allowance($1) AS data',[req.rs.session_hash])).rows[0].data));
 });
 staffPlansRouter.get('/plans/publications/:requestId',async(req,res)=>{
  const id=uuid.parse(req.params.requestId);z.object({}).strict().parse(req.query);
  res.json(await action(async c=>(await c.query('SELECT reseller_staff_plan_receipt($1,$2) AS data',[req.rs.session_hash,id])).rows[0].data));
 });
 staffPlansRouter.get('/plans/:id',async(req,res)=>{
  const id=uuid.parse(req.params.id),q=z.object({before:z.coerce.number().int().positive().optional()}).strict().parse(req.query);
  const data=await action(async c=>(await c.query('SELECT reseller_staff_plan_history($1,$2,$3) AS data',[req.rs.session_hash,id,q.before||null])).rows[0].data);
  res.json({...data,items:data.items.slice(0,25),next_before:data.items.length>25?data.items[24].version:null});
 });
 staffPlansRouter.post('/plans',async(req,res)=>{
  const b=z.object({...publication,key:z.string().regex(/^[a-z][a-z0-9-]{2,49}$/)}).strict().parse(req.body);
  const saved=await action(async c=>(await c.query('SELECT reseller_staff_publish_plan($1,NULL,0,$2,$3,$4,$5) AS data',[req.rs.session_hash,b.key,b.definition,b.reason,b.request_id])).rows[0].data);
  res.status(saved.replayed?200:201).json(saved);
 });
 staffPlansRouter.post('/plans/:id/versions',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({...publication,version:z.number().int().positive()}).strict().parse(req.body);
  const saved=await action(async c=>(await c.query('SELECT reseller_staff_publish_plan($1,$2,$3,NULL,$4,$5,$6) AS data',[req.rs.session_hash,id,b.version,b.definition,b.reason,b.request_id])).rows[0].data);
  res.status(saved.replayed?200:201).json(saved);
 });
}
