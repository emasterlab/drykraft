import pg from 'pg';
import {AppError} from './model.mjs';

export const resellerPool=process.env.RESELLER_DATABASE_URL?new pg.Pool({connectionString:process.env.RESELLER_DATABASE_URL,max:4,statement_timeout:10000,idle_in_transaction_session_timeout:15000}):null;
export function requireResellerDatabase(){if(!resellerPool)throw new AppError(503,'Reseller team access is not configured.');return resellerPool;}
export async function resellerTransaction(action){const c=await requireResellerDatabase().connect();try{await c.query('BEGIN');const value=await action(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
const tablePrivileges={
 reseller_accounts:['SELECT'],reseller_auth_challenges:['SELECT','INSERT','UPDATE','DELETE'],
 reseller_sessions:['SELECT','INSERT','DELETE'],reseller_audit:['INSERT'],
};
const columnPrivileges={reseller_accounts:{UPDATE:['name','password_hash','version','auth_version','secret_ciphertext','last_step','recovery_hashes','mfa_enabled_at','password_changed_at']},reseller_sessions:{UPDATE:['last_seen_at']}};
const functions=['reseller_staff_session_info(text)','reseller_staff_select(text,uuid)','reseller_staff_read(text,text,uuid,uuid)','reseller_staff_save_team(text,uuid,integer,jsonb,text,uuid,text)','reseller_staff_publish_plan(text,uuid,integer,text,jsonb,text,uuid)','reseller_staff_plan_history(text,uuid,integer)','reseller_staff_plan_receipt(text,uuid)','reseller_staff_member_detail(text,uuid)','reseller_staff_member_receipt(text,uuid)','reseller_staff_plan_allowance(text)','reseller_staff_customer_detail(text,uuid)','reseller_staff_customer_receipt(text,uuid)','reseller_staff_provision_customer(text,jsonb,uuid,text,uuid,text,text,jsonb)','reseller_staff_update_customer(text,uuid,integer,text,text,uuid)','reseller_staff_customer_state(text,uuid,integer,boolean,text,uuid)','reseller_staff_assign_customer_plan(text,uuid,integer,uuid,integer,text,uuid)','reseller_staff_owner_invitation(text,uuid,integer,text,text,text,text,uuid)'];
export async function validateResellerDatabase(client=resellerPool){
 if(!client)return;
 const role=(await client.query("SELECT r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS member,has_schema_privilege(current_user,'public','CREATE') AS schema_create FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
 const fail=()=>{throw Error('Reseller staff database requires its dedicated restricted role.');};
 if(role.rolname!=='drykraft_reseller'||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolbypassrls||role.member||role.schema_create)fail();
 const tables=(await client.query("SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')")).rows;
 for(const t of tables){
  if(tablePrivileges[t.relname]&&(!t.relrowsecurity||!t.relforcerowsecurity))fail();
  for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
   const allowed=tablePrivileges[t.relname]?.includes(privilege)||false;
   const actual=(await client.query('SELECT has_table_privilege(current_user,$1::oid,$2) AS permitted',[t.oid,privilege])).rows[0].permitted;
   if(actual!==allowed)fail();
  }
  const columns=(await client.query('SELECT a.attname,has_column_privilege(current_user,a.attrelid,a.attnum,\'SELECT\') AS "select",has_column_privilege(current_user,a.attrelid,a.attnum,\'INSERT\') AS "insert",has_column_privilege(current_user,a.attrelid,a.attnum,\'UPDATE\') AS "update",has_column_privilege(current_user,a.attrelid,a.attnum,\'REFERENCES\') AS "references" FROM pg_attribute a WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped',[t.oid])).rows;
  for(const column of columns)for(const privilege of ['SELECT','INSERT','UPDATE','REFERENCES']){
   const allowed=tablePrivileges[t.relname]?.includes(privilege)||columnPrivileges[t.relname]?.[privilege]?.includes(column.attname)||false;
   if(column[privilege.toLowerCase()]!==allowed)fail();
  }
 }
 const allowedOids=(await client.query('SELECT unnest($1::text[])::regprocedure::oid AS id',[functions])).rows.map(r=>Number(r.id));
 const permitted=(await client.query("SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND has_function_privilege(current_user,p.oid,'EXECUTE') AND p.prosecdef")).rows.map(r=>Number(r.oid));
 if(permitted.length!==allowedOids.length||permitted.some(id=>!allowedOids.includes(id)))fail();
}
export async function resellerDatabaseAction(action){try{return await action();}catch(e){const status={RS400:400,RS401:401,RS403:403,RS404:404,RS409:409};if(status[e.code])throw new AppError(status[e.code],e.message);if(e.code==='23505')throw new AppError(409,'This account, membership, plan key or request already exists. Refresh before saving.');throw e;}}
