import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './model.mjs';
import {authorizedPlatform,platformAudit} from './platform-auth.mjs';
import {planDefinitionSchema,overridesSchema,entitlementMeters,entitlementFeatures} from './entitlements.mjs';

const uuid=z.string().uuid(),version=z.number().int().positive(),reason=z.string().trim().min(10).max(1000);
const readers=['owner','admin','billing','viewer'],writers=['owner','admin','billing'];
async function plan(c,id){const row=(await c.query('SELECT * FROM platform_plans WHERE id=$1',[id])).rows[0];if(!row)throw new AppError(404,'This plan could not be found.');return row;}
async function insertVersion(c,id,number,b,actor){return (await c.query('INSERT INTO platform_plan_versions(plan_id,version,name,kind,monthly_price_minor,annual_price_minor,limits,features,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[id,number,b.name,b.kind,b.kind==='workspace'?100:null,b.kind==='workspace'?1200:null,b.limits,b.features,actor])).rows[0];}
async function workspace(c,id){if(!(await c.query('SELECT id FROM workspaces WHERE id=$1',[id])).rowCount)throw new AppError(404,'This workspace could not be found.');}
async function entitlementDetail(c,id){
 await workspace(c,id);
 return (await c.query('SELECT platform_workspace_entitlement_detail($1) AS data',[id])).rows[0].data;
}
export function mountPlatformCommercial(router){
 router.get('/plans',async(req,res)=>{
  const q=z.object({cursor:uuid.optional(),search:z.string().trim().max(100).default('')}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,readers,async c=>{
   const rows=(await c.query('SELECT p.*,v.name,v.kind,v.monthly_price_minor,v.annual_price_minor,v.currency FROM platform_plans p JOIN platform_plan_versions v ON v.plan_id=p.id AND v.version=p.current_version WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2=\'\' OR position(lower($2) IN lower(p.key||\' \'||v.name))>0) ORDER BY p.id LIMIT 26',[q.cursor||null,q.search])).rows;
   return {items:rows.slice(0,25),next_cursor:rows.length>25?rows[24].id:null,meters:entitlementMeters,features:entitlementFeatures};
  }));
 });
 router.get('/plans/:id',async(req,res)=>{
  const id=uuid.parse(req.params.id),q=z.object({before:z.coerce.number().int().positive().optional()}).strict().parse(req.query);
  res.json(await authorizedPlatform(req,readers,async c=>{
   const header=await plan(c,id),rows=(await c.query('SELECT * FROM platform_plan_versions WHERE plan_id=$1 AND ($2::int IS NULL OR version<$2) ORDER BY version DESC LIMIT 26',[id,q.before||null])).rows;
   return {...header,versions:rows.slice(0,25),next_before:rows.length>25?rows[24].version:null};
  }));
 });
 router.post('/plans',async(req,res)=>{
  const b=z.object({key:z.string().regex(/^[a-z][a-z0-9-]{2,49}$/),definition:planDefinitionSchema,reason}).strict().parse(req.body);
  res.status(201).json(await authorizedPlatform(req,writers,async c=>{
   const id=randomUUID();await c.query('INSERT INTO platform_plans(id,key,current_version) VALUES($1,$2,1)',[id,b.key]);
   const saved=await insertVersion(c,id,1,b.definition,req.sa.id);
   await platformAudit(c,req,'platform.plan.created','plan',id,b.reason,{version:1,definition:b.definition});
   return {...await plan(c,id),definition:saved};
  }));
 });
 router.post('/plans/:id/versions',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version,definition:planDefinitionSchema,reason}).strict().parse(req.body);
  res.status(201).json(await authorizedPlatform(req,writers,async c=>{
   const previous=(await c.query('SELECT * FROM platform_plans WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!previous)throw new AppError(404,'This plan could not be found.');
   if(previous.current_version!==b.version)throw new AppError(409,'This plan changed. Reload its current version before publishing.');
   const saved=await insertVersion(c,id,b.version+1,b.definition,req.sa.id);await c.query('UPDATE platform_plans SET current_version=$2,updated_at=now() WHERE id=$1',[id,saved.version]);
   await platformAudit(c,req,'platform.plan.version_published','plan',id,b.reason,{version:saved.version,definition:b.definition});return saved;
  }));
 });
 router.get('/workspaces/:id/entitlements',async(req,res)=>{
  const id=uuid.parse(req.params.id);res.json(await authorizedPlatform(req,readers,async c=>entitlementDetail(c,id)));
 });
 router.put('/workspaces/:id/entitlements',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version,plan_id:uuid,plan_version:version,overrides:overridesSchema,agreement:z.object({reference:z.string().trim().min(3).max(200),starts_at:z.string().datetime({offset:true}),ends_at:z.string().datetime({offset:true}),seats:z.number().int().min(1).max(10000)}).strict().nullable(),reason}).strict().parse(req.body);
  if(b.agreement&&(new Date(b.agreement.ends_at)<=new Date(b.agreement.starts_at)||new Date(b.agreement.ends_at)>new Date(Date.now()+366*86400000)))throw new AppError(400,'Use an agreement ending after its start and within the next 366 days.');
  res.json(await authorizedPlatform(req,writers,async c=>{
   await workspace(c,id);
   await c.query('SELECT assign_platform_workspace_plan($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,req.sa.id,b.version,b.plan_id,b.plan_version,b.overrides,b.agreement,b.reason,req.requestId]);
   return entitlementDetail(c,id);
  }));
 });
 router.post('/workspaces/:id/trial',async(req,res)=>{
  const id=uuid.parse(req.params.id),b=z.object({version,ends_at:z.string().datetime({offset:true}),reason}).strict().parse(req.body);
  const days=(new Date(b.ends_at).getTime()-Date.now())/86400000;if(days<=0||days>90)throw new AppError(400,'Choose a trial end within the next 90 days.');
  res.json(await authorizedPlatform(req,writers,async c=>{
   await workspace(c,id);await c.query('SELECT extend_platform_workspace_trial($1,$2,$3,$4,$5,$6)',[id,req.sa.id,b.version,b.ends_at,b.reason,req.requestId]);return entitlementDetail(c,id);
  }));
 });
}
