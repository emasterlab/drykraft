import {z} from 'zod';
import {AppError} from './model.mjs';

// These are live-resource gauges. Consumed usage and prices belong to separate ledgers.
export const entitlementMeters=['users','contacts','custom_records','pipelines','workflows','active_workflows','integrations','calendars'];
export const entitlementFeatures=['crm','sales','finance','automation','outreach','calendar'];
const ceiling=z.number().int().min(0).max(1_000_000_000).nullable();
export const limitsSchema=z.object(Object.fromEntries(entitlementMeters.map(key=>[key,ceiling]))).strict();
export const featuresSchema=z.object(Object.fromEntries(entitlementFeatures.map(key=>[key,z.boolean()]))).strict();
export const overridesSchema=z.object({limits:limitsSchema.partial(),features:featuresSchema.partial()}).strict();
export const planDefinitionSchema=z.object({name:z.string().trim().min(2).max(100),kind:z.enum(['workspace','enterprise']),limits:limitsSchema,features:featuresSchema}).strict();
export async function workspaceEntitlements(c,tenantId){
 const saved=(await c.query('SELECT workspace_entitlements($1) AS data',[tenantId])).rows[0].data;
 if(!saved)throw new AppError(503,'Workspace entitlements are unavailable.');return saved;
}
export async function requireFeature(c,tenantId,feature){
 if(!entitlementFeatures.includes(feature))throw Error('Unknown workspace capability.');
 const saved=await workspaceEntitlements(c,tenantId);
 if(!saved.features[feature])throw new AppError(403,`The workspace plan does not enable ${feature}. Ask the owner to review the plan.`);
}
