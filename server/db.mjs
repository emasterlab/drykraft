import pg from 'pg';
import { randomUUID } from 'node:crypto';

// Calendar dates must remain dates; Date conversion would shift payments across host timezones.
pg.types.setTypeParser(1082,value=>value);
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
export async function tenantTransaction(tenantId, action, heldClient = null) {
  const client = heldClient || await pool.connect();
  client.workflowPrincipal=null;
  client.apiPrincipal=null;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.workflowPrincipal=null;client.apiPrincipal=null;if (!heldClient) client.release(); }
}
export async function event(client, tenantId, actorId, type, resourceType, resourceId, data, causationId = null) {
  const id = randomUUID();
  const parent=causationId?(await client.query('SELECT depth,correlation_id FROM outbox WHERE id=$1',[causationId])).rows[0]:null;
  const depth=parent?parent.depth+1:0;
  // ponytail: cap event chains at 16; per-workflow budgets can replace this ceiling when needed.
  if(depth>16)throw new Error('Automation stopped because its event chain exceeded 16 steps. Check for a workflow loop.');
  await client.query(`INSERT INTO outbox(id,tenant_id,type,resource_type,resource_id,actor_id,correlation_id,causation_id,data,depth)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id,tenantId,type,resourceType,resourceId,actorId,parent?.correlation_id || randomUUID(),causationId,data,depth]);
  await client.query('INSERT INTO audit_events(tenant_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)', [tenantId,randomUUID(),actorId,type,resourceId]);
  return id;
}
