import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './model.mjs';
import {authorizedPlatform} from './platform-auth.mjs';
import {limitsSchema,featuresSchema} from './entitlements.mjs';
import {currencySchema} from './currency.mjs';
import {mountPlatformResellerKeys} from './platform-reseller-keys.mjs';
import {mountPlatformResellerTeam} from './reseller-team.mjs';

const uuid=z.string().uuid(),version=z.number().int().positive(),reason=z.string().trim().min(10).max(1000);
const readers=['owner','admin','billing','viewer'],administrators=['owner','admin'],commercial=['owner','admin','billing'];
const key=z.string().regex(/^[a-z][a-z0-9-]{2,49}$/),page=z.object({cursor:uuid.optional()}).strict();
const metadata={name:z.string().trim().min(2).max(100),customer_access_policy:z.enum(['retain_access','suspend_access']),contract_reference:z.string().trim().min(3).max(200),billing_mode:z.enum(['wholesale','managed_rebilling']),contract_starts_at:z.string().datetime({offset:true}),contract_ends_at:z.string().datetime({offset:true})};
const contract=schema=>schema.refine(b=>new Date(b.contract_ends_at)>new Date(b.contract_starts_at),'The contract end must follow its start.');
const grantSchema=z.object({platform_plan_id:uuid,platform_plan_version:version,max_workspaces:z.number().int().min(0).max(1_000_000_000).nullable(),trial_days_max:z.number().int().min(0).max(90),limits:limitsSchema,aggregate_limits:limitsSchema,features:featuresSchema}).strict();
const price=z.number().int().min(0).max(1_000_000_000);
const retailSchema=z.object({name:z.string().trim().min(2).max(100),currency:currencySchema,monthly_price_minor:price,annual_price_minor:price,setup_price_minor:price,trial_days:z.number().int().min(0).max(90),limits:limitsSchema,features:featuresSchema}).strict();
const paginated=rows=>({items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null});
async function organization(c,id){const row=(await c.query('SELECT * FROM reseller_organizations WHERE id=$1',[id])).rows[0];if(!row)throw new AppError(404,'This reseller could not be found.');return row;}
async function detail(c,id){
 const saved=await organization(c,id);
 const grant=(await c.query('SELECT * FROM reseller_grant_versions WHERE reseller_id=$1 AND version=$2',[id,saved.grant_version])).rows[0];
 const customer_count=(await c.query('SELECT count(*)::int AS total FROM reseller_workspace_links WHERE reseller_id=$1',[id])).rows[0].total;
 return {...saved,grant,customer_count,usage:(await c.query('SELECT reseller_resource_gauges($1) AS data',[id])).rows[0].data,collection_configured:false};
}
export function mountPlatformResellers(router){
 mountPlatformResellerKeys(router);
 mountPlatformResellerTeam(router);
 router.get('/resellers',async(req,res)=>{
  const q=page.extend({search:z.string().trim().max(100).default(''),status:z.enum(['all','pending','active','suspended']).default('all')}).parse(req.query);
  res.json(await authorizedPlatform(req,readers,async c=>paginated((await c.query("SELECT r.*,(SELECT count(*)::int FROM reseller_workspace_links WHERE reseller_id=r.id) AS customer_count FROM reseller_organizations r WHERE ($1::uuid IS NULL OR r.id>$1) AND ($2='' OR position(lower($2) IN lower(r.name||' '||r.key))>0) AND ($3='all' OR r.status=$3) ORDER BY r.id LIMIT 26",[q.cursor||null,q.search,q.status])).rows)));
 });
 router.get('/resellers/:id',async(req,res)=>{
  const id=uuid.parse(req.params.id);res.json(await authorizedPlatform(req,readers,c=>detail(c,id)));
 });
 router.post('/resellers',async(req,res)=>{
  const b=contract(z.object({key,...metadata,grant:grantSchema,reason}).strict()).parse(req.body),{grant,reason:why,...input}=b,id=randomUUID();
  res.status(201).json(await authorizedPlatform(req,administrators,async c=>{
   await c.query('SELECT platform_create_reseller($1,$2,$3,$4,$5,$6)',[id,req.sa.id,input,grant,why,req.requestId]);return detail(c,id);
  }));
 });
 router.put('/resellers/:id',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=contract(z.object({...metadata,status:z.enum(['pending','active','suspended']),version,reason}).strict()).parse(req.body),{version:expected,reason:why,...input}=b;
  res.json(await authorizedPlatform(req,administrators,async c=>{
   await organization(c,id);await c.query('SELECT platform_update_reseller($1,$2,$3,$4,$5,$6)',[id,req.sa.id,expected,input,why,req.requestId]);return detail(c,id);
  }));
 });
 router.get('/resellers/:id/grants',async(req,res)=>{
  const id=uuid.parse(req.params.id),q=z.object({before:z.coerce.number().int().positive().optional()}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,readers,async c=>{
   const saved=await organization(c,id),rows=(await c.query('SELECT * FROM reseller_grant_versions WHERE reseller_id=$1 AND ($2::int IS NULL OR version<$2) ORDER BY version DESC LIMIT 26',[id,q.before||null])).rows;
   return {current_version:saved.grant_version,items:rows.slice(0,25),next_before:rows.length>25?rows[24].version:null};
  }));
 });
 router.post('/resellers/:id/grants',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version,definition:grantSchema,reason}).strict().parse(req.body);
  res.status(201).json(await authorizedPlatform(req,commercial,async c=>{
   await organization(c,id);await c.query('SELECT platform_publish_reseller_grant($1,$2,$3,$4,$5,$6)',[id,req.sa.id,b.version,b.definition,b.reason,req.requestId]);return detail(c,id);
  }));
 });
 router.get('/resellers/:id/plans',async(req,res)=>{
  const id=uuid.parse(req.params.id),q=page.parse(req.query);
  res.json(await authorizedPlatform(req,readers,async c=>{
   await organization(c,id);return paginated((await c.query('SELECT p.*,v.name,v.currency,v.monthly_price_minor,v.annual_price_minor,v.setup_price_minor,v.trial_days FROM reseller_retail_plans p JOIN reseller_retail_plan_versions v ON v.plan_id=p.id AND v.version=p.current_version WHERE p.reseller_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT 26',[id,q.cursor||null])).rows);
  }));
 });
 router.get('/resellers/:id/plans/:planId',async(req,res)=>{
  const id=uuid.parse(req.params.id),planId=uuid.parse(req.params.planId),q=z.object({before:z.coerce.number().int().positive().optional()}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,readers,async c=>{
   const saved=(await c.query('SELECT * FROM reseller_retail_plans WHERE id=$1 AND reseller_id=$2',[planId,id])).rows[0];if(!saved)throw new AppError(404,'This retail plan could not be found.');
   const rows=(await c.query('SELECT * FROM reseller_retail_plan_versions WHERE plan_id=$1 AND ($2::int IS NULL OR version<$2) ORDER BY version DESC LIMIT 26',[planId,q.before||null])).rows;
   return {...saved,versions:rows.slice(0,25),next_before:rows.length>25?rows[24].version:null};
  }));
 });
 router.post('/resellers/:id/plans',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({key,definition:retailSchema,reason}).strict().parse(req.body),planId=randomUUID();
  res.status(201).json(await authorizedPlatform(req,commercial,async c=>{
   await organization(c,id);await c.query('SELECT platform_publish_retail_plan($1,$2,$3,0,$4,$5,$6,$7)',[id,planId,req.sa.id,b.key,b.definition,b.reason,req.requestId]);return {id:planId,reseller_id:id,current_version:1};
  }));
 });
 router.post('/resellers/:id/plans/:planId/versions',async(req,res)=>{
  const id=uuid.parse(req.params.id),planId=uuid.parse(req.params.planId),b=z.object({version,definition:retailSchema,reason}).strict().parse(req.body);
  res.status(201).json(await authorizedPlatform(req,commercial,async c=>{
   const saved=(await c.query('SELECT platform_publish_retail_plan($1,$2,$3,$4,NULL,$5,$6,$7) AS version',[id,planId,req.sa.id,b.version,b.definition,b.reason,req.requestId])).rows[0];return {id:planId,reseller_id:id,current_version:saved.version};
  }));
 });
 router.get('/resellers/:id/customers',async(req,res)=>{
  const id=uuid.parse(req.params.id),q=page.parse(req.query);
  res.json(await authorizedPlatform(req,readers,async c=>{
   await organization(c,id);return paginated((await c.query('SELECT w.id,w.name,w.slug,l.version,l.retail_plan_id,l.retail_plan_version,l.updated_at FROM reseller_workspace_links l JOIN workspaces w ON w.id=l.tenant_id WHERE l.reseller_id=$1 AND ($2::uuid IS NULL OR w.id>$2) ORDER BY w.id LIMIT 26',[id,q.cursor||null])).rows);
  }));
 });
 router.get('/workspaces/:id/reseller',async(req,res)=>{
  const id=uuid.parse(req.params.id);res.json(await authorizedPlatform(req,readers,async c=>{
   if(!(await c.query('SELECT id FROM workspaces WHERE id=$1',[id])).rowCount)throw new AppError(404,'This workspace could not be found.');
   return (await c.query('SELECT l.*,r.name AS reseller_name FROM reseller_workspace_links l LEFT JOIN reseller_organizations r ON r.id=l.reseller_id WHERE l.tenant_id=$1',[id])).rows[0]||{tenant_id:id,reseller_id:null,retail_plan_id:null,retail_plan_version:null,version:0};
  }));
 });
 router.put('/workspaces/:id/reseller',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version:z.number().int().min(0),reseller_id:uuid.nullable(),retail_plan_id:uuid.nullable(),retail_plan_version:version.nullable(),reason}).strict().refine(b=>b.reseller_id===null?b.retail_plan_id===null&&b.retail_plan_version===null:b.retail_plan_id!==null&&b.retail_plan_version!==null,'Choose a reseller and retail plan together, or clear all three.').parse(req.body);
  res.json(await authorizedPlatform(req,administrators,async c=>{
   await c.query('SELECT platform_assign_reseller_workspace($1,$2,$3,$4,$5,$6,$7,$8)',[id,req.sa.id,b.version,b.reseller_id,b.retail_plan_id,b.retail_plan_version,b.reason,req.requestId]);
   return (await c.query('SELECT * FROM reseller_workspace_links WHERE tenant_id=$1',[id])).rows[0];
  }));
 });
}
