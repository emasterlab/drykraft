import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === '--apply';
if (args.length > 0 && !apply && !(args.length === 1 && args[0] === '--plan')) {
  throw new Error('Usage: npm run db:migrate [-- --plan|--apply]');
}

const connectionString = process.env.DATABASE_MIGRATION_URL;
if (!connectionString) {
  throw new Error('Set DATABASE_MIGRATION_URL to a privileged connection for the drykraft database.');
}

const files = readdirSync('server/migrations')
  .filter((file) => /^\d{3}-.+\.sql$/.test(file))
  .sort();
const migrations = files.map((file) => {
  const version = Number(file.slice(0, 3));
  const sql = readFileSync(`server/migrations/${file}`, 'utf8');
  if (!/^\s*BEGIN\s*;/i.test(sql) || !/COMMIT\s*;\s*$/i.test(sql)) {
    throw new Error(`Migration ${file} must run in its own transaction.`);
  }
  if (!new RegExp(`INSERT\\s+INTO\\s+schema_migrations\\s*\\(version\\)\\s*VALUES\\s*\\(\\s*${version}\\s*\\)`, 'i').test(sql)) {
    throw new Error(`Migration ${file} does not record version ${version}.`);
  }
  return { file, version, sql };
});

for (let index = 0; index < migrations.length; index += 1) {
  if (migrations[index].version !== index + 2) {
    throw new Error(`Migration files must be consecutive from 002. Found ${migrations[index].file}.`);
  }
}

const client = new pg.Client({
  connectionString,
  application_name: 'drykraft-schema-migrations',
  connectionTimeoutMillis: 8000,
  query_timeout: 300000,
});
const lockId = 714203201;
let locked = false;

try {
  await client.connect();
  const target = await client.query('SELECT current_database() AS name');
  if (target.rows[0]?.name !== 'drykraft') {
    throw new Error('DATABASE_MIGRATION_URL must connect directly to the drykraft database.');
  }

  if (apply) {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    locked = true;
  }

  const baseline = await client.query("SELECT to_regclass('public.schema_migrations') AS table_name");
  if (!baseline.rows[0]?.table_name) {
    throw new Error('The base schema is missing. Initialize the database before applying migrations.');
  }

  const result = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  const applied = result.rows.map((row) => Number(row.version));
  if (applied[0] !== 1 || applied.some((version, index) => version !== index + 1)) {
    throw new Error('Database migration history is not a consecutive sequence starting at 1.');
  }

  const latestApplied = applied.at(-1);
  const pending = migrations.filter(({ version }) => version > latestApplied);
  if (pending.some(({ version }, index) => version !== latestApplied + index + 1)) {
    throw new Error('The database is missing an earlier migration. Restore its migration history before continuing.');
  }

  console.log(`Database: drykraft (migration ${latestApplied})`);
  console.log(pending.length ? `Pending: ${pending.map(({ file }) => file).join(', ')}` : 'Pending: none');
  if (!apply || pending.length === 0) {
    console.log(apply ? 'Database is already current.' : 'Plan only. Add --apply to run these migrations.');
  } else {
    for (const migration of pending) {
      try {
        await client.query(migration.sql);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${migration.file} failed: ${error.message}`, { cause: error });
      }
      console.log(`Applied ${migration.file}`);
    }
    console.log('Database migrations are current.');
  }
} finally {
  if (locked) await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
  await client.end().catch(() => {});
}
