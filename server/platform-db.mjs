import pg from 'pg';
import {AppError} from './model.mjs';

// The customer runtime pool never receives platform privileges.
export const platformPool=process.env.PLATFORM_DATABASE_URL?new pg.Pool({connectionString:process.env.PLATFORM_DATABASE_URL,max:4}):null;
export function requirePlatformDatabase(){if(!platformPool)throw new AppError(503,'Platform administration is not configured.');return platformPool;}
export async function validatePlatformDatabase(){
 if(!platformPool)return;
 const role=(await platformPool.query("SELECT r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS member,has_table_privilege(current_user,'records','SELECT') AS customer_records,has_table_privilege(current_user,'credentials','SELECT') AS customer_credentials,has_column_privilege(current_user,'users','password_hash','SELECT') AS customer_passwords FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
 if(role.rolname!=='drykraft_platform'||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolbypassrls||role.member||role.customer_records||role.customer_credentials||role.customer_passwords)throw Error('Platform database requires its dedicated restricted role.');
}
export async function platformTransaction(action){const c=await requirePlatformDatabase().connect();try{await c.query('BEGIN');const r=await action(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
