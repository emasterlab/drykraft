import {Router} from 'express';
import {z} from 'zod';
import {AppError} from './model.mjs';
import {resellerHost,mountResellerAuth} from './reseller-auth.mjs';
import {resellerTransaction,resellerDatabaseAction} from './reseller-db.mjs';
import {mountResellerTeam,memberPageSchema,memberPage} from './reseller-team.mjs';
import {mountResellerPlans} from './reseller-plans.mjs';
import {mountResellerCustomers} from './reseller-customers.mjs';

export const resellerRouter=Router();
resellerRouter.use(resellerHost);
mountResellerAuth(resellerRouter);
const readPaths=['/organizations','/overview','/customers','/plans','/usage','/members','/audit'];
resellerRouter.get(readPaths,async(req,res)=>{
  const section=req.path.slice(1);
  const q=memberPageSchema.parse(req.query);
  if(['overview','usage'].includes(section)&&q.cursor)throw new AppError(400,'This page does not use pagination.');
  const data=await resellerDatabaseAction(()=>resellerTransaction(async c=>(await c.query('SELECT reseller_staff_read($1,$2,$3,NULL) AS data',[req.rs.session_hash,section,q.cursor||null])).rows[0].data));
  res.json(['overview','usage'].includes(section)?data:memberPage(data));
 });
resellerRouter.post('/organizations/:id/select',async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);z.object({}).strict().parse(req.body);
 res.json(await resellerDatabaseAction(()=>resellerTransaction(async c=>(await c.query('SELECT reseller_staff_select($1,$2) AS data',[req.rs.session_hash,id])).rows[0].data)));
});
mountResellerTeam(resellerRouter);
mountResellerPlans(resellerRouter);
mountResellerCustomers(resellerRouter);
resellerRouter.use((req,res,next)=>next(new AppError(404,'This reseller endpoint could not be found.')));
resellerRouter.use((error,req,res,next)=>{
 const status={RS400:400,RS401:401,RS403:403,RS404:404,RS409:409}[error.code];
 next(status?new AppError(status,error.message):error);
});
