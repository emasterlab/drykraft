import {Router} from 'express';
import pg from 'pg';
import {z} from 'zod';
import {AppError} from './model.mjs';
import {tokenHash} from './auth.mjs';
import {consumeRateLimit} from './rate-limits.mjs';

export const resellerApiPool=process.env.RESELLER_API_DATABASE_URL?new pg.Pool({connectionString:process.env.RESELLER_API_DATABASE_URL,max:4}):null;
let redis;
export function configureResellerApi(client){redis=client;}
export async function validateResellerApiDatabase(client=resellerApiPool){
 if(!client)return;
 const role=(await client.query("SELECT r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS member,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS tables,EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE') AND p.oid NOT IN ('public.reseller_api_identity(text)'::regprocedure,'public.reseller_api_read(text,text,uuid,uuid)'::regprocedure)) AS functions,has_schema_privilege(current_user,'public','CREATE') AS schema_create FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
 if(role.rolname!=='drykraft_reseller_api'||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolbypassrls||role.member||role.tables||role.functions||role.schema_create)throw Error('Reseller API database requires its dedicated role with no table privileges.');
}
function databaseError(error){if(['DR400','DR401','DR403'].includes(error.code))throw new AppError(Number(error.code.slice(2)),error.message);throw error;}
async function query(sql,values){if(!resellerApiPool)throw new AppError(503,'Reseller API access is not configured.');try{return (await resellerApiPool.query(sql,values)).rows[0].data;}catch(e){databaseError(e);}}
export const resellerApiRouter=Router();
resellerApiRouter.use(async(req,res,next)=>{
 const domain=process.env.APP_DOMAIN||'localhost';
 res.set('Cache-Control','no-store');res.set('X-Robots-Tag','noindex, nofollow');
 if(domain==='localhost'?!['localhost','127.0.0.1','[::1]'].includes(req.hostname):req.hostname!==`app.${domain}`)throw new AppError(404,'This endpoint is unavailable on this host.');
 const header=req.get('authorization')||'',match=/^Bearer (dk_res_[a-f0-9]{64})$/.exec(header);
 if(!match)throw new AppError(401,'Use a dedicated reseller API key.');
 req.resellerKeyHash=tokenHash(match[1]);
 const identity=await query('SELECT reseller_api_identity($1) AS data',[req.resellerKeyHash]);
 const counter=await consumeRateLimit(redis,'reseller-api:'+identity.key_id,60000);
 if(counter.totalHits>120){res.set('Retry-After',String(Math.max(1,Math.ceil((counter.resetTime-Date.now())/1000))));throw new AppError(429,'Too many reseller API requests. Retry after the indicated window.');}
 next();
});
const page=z.object({cursor:z.string().uuid().optional()}).strict();
async function read(req,res,section,paged=false){const input=(paged?page:z.object({}).strict()).parse(req.query);res.json(await query('SELECT reseller_api_read($1,$2,$3,$4) AS data',[req.resellerKeyHash,section,input.cursor||null,req.requestId]));}
resellerApiRouter.get('/me',(req,res)=>read(req,res,'me'));
resellerApiRouter.get('/customers',(req,res)=>read(req,res,'customers',true));
resellerApiRouter.get('/plans',(req,res)=>read(req,res,'plans',true));
resellerApiRouter.get('/usage',(req,res)=>read(req,res,'usage'));
resellerApiRouter.use((req,res)=>res.status(404).json({error:{message:'This reseller endpoint does not exist.',request_id:req.requestId}}));
