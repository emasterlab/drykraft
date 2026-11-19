import {z} from 'zod';
import {AppError} from './model.mjs';

const variablesSchema=z.record(z.string(),z.unknown());
const settingsSchema=z.object({url:z.string().max(2048).url(),query:z.string().trim().min(1).max(65536),variables:variablesSchema.default({}),operationName:z.string().max(100).regex(/^$|^[_A-Za-z][_0-9A-Za-z]*$/).default(''),errorPolicy:z.enum(['stop','continue']).default('stop')});
export function validateGraphQL(raw) {
  const parsed=settingsSchema.safeParse(raw);
  if(!parsed.success)throw new AppError(400,'GraphQL needs an endpoint, a nonempty document (up to 64 KB), a Variables JSON object and a valid operation name/error policy.');
  const d=parsed.data,url=new URL(d.url);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port && !['80','443'].includes(url.port))throw new AppError(400,'GraphQL requires a public HTTP or HTTPS endpoint on port 80 or 443 without embedded credentials.');
  if(Buffer.byteLength(d.query)>65536)throw new AppError(400,'Keep the GraphQL document within 64 KB.');
  if(Buffer.byteLength(JSON.stringify(d.variables))>262144)throw new AppError(400,'Keep GraphQL variables within 256 KB.');
  return d;
}
export function graphQLBody(raw,variables) {
  const d=validateGraphQL(raw);
  if(!variablesSchema.safeParse(variables).success)throw new AppError(400,'GraphQL variables must resolve to a JSON object.');
  if(Buffer.byteLength(JSON.stringify(variables))>262144)throw new AppError(400,'Resolved GraphQL variables exceed 256 KB. Send only needed fields.');
  // Keep the document literal: pass context values as variables, never inject them into GraphQL syntax.
  return JSON.stringify({query:d.query,variables,...(d.operationName?{operationName:d.operationName}:{})});
}
export function graphQLResponse(response,errorPolicy='stop') {
  const b=response.body,object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
  if(!object(b) || !Object.hasOwn(b,'data') && !Object.hasOwn(b,'errors') || Object.hasOwn(b,'data') && b.data!==null && !object(b.data) || Object.hasOwn(b,'errors') && (!Array.isArray(b.errors) || !b.errors.length || b.errors.some(e=>!object(e)||typeof e.message!=='string')) || Object.hasOwn(b,'extensions') && !object(b.extensions))throw new AppError(502,'The endpoint did not return a valid GraphQL JSON response. Check its endpoint and document.');
  if(b.errors?.length && (errorPolicy!=='continue' || !object(b.data)))throw new AppError(502,`GraphQL returned ${b.errors.length} error(s). Check the document and variables; review the destination before retrying a mutation.`);
  return response;
}
