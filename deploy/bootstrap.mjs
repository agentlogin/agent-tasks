// One-time initialization of a NEW dedicated database, never an existing issuer/mail database.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { TaskStore } from '../src/store.mjs';
import { PostgresCallbackStateStore } from '@agentlogin/rp-store-postgres';
import { configuration } from '../src/config.mjs';

const connections = [];
const connect = config => { const pool = new Pool({ ...config, max: 1 }); pool.on('error', () => {}); connections.push(pool); return pool; };
try {
  assert.equal(process.env.BOOTSTRAP_NEW_AGENT_TASKS_DATABASE, 'yes');
  const config = configuration();
  const adminUrl = new URL(config.database.connectionString);
  assert.equal(adminUrl.pathname, '/agent_tasks');
  assert.equal(adminUrl.username, 'postgres');
  assert.equal(config.appSchema, 'agent_tasks'); assert.equal(config.callbackSchema, 'agent_tasks_callbacks');
  const roles = ['agent_tasks_migrator', 'agent_tasks_runtime'];
  const passwords = [process.env.MIGRATION_PASSWORD, process.env.RUNTIME_PASSWORD];
  for (const password of passwords) assert.match(password ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(passwords[0], passwords[1]);
  const admin = connect(config.database);
  const preflight = (await admin.query(`SELECT current_database() AS database,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS administrator,
    (SELECT count(*)::int FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema')) AS extra_schemas,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') AS public_objects,
    (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('agent_tasks_migrator','agent_tasks_runtime')) AS existing_roles`)).rows[0];
  assert.deepEqual(preflight, { database: 'agent_tasks', administrator: true, extra_schemas: 0, public_objects: 0, existing_roles: 0 });
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    // Values are independently generated hex-only secrets; never print statements or database errors.
    for (let i=0; i<roles.length; i++) await client.query(`CREATE ROLE ${roles[i]} LOGIN PASSWORD '${passwords[i]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await client.query(`REVOKE ALL ON DATABASE agent_tasks FROM PUBLIC;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE agent_tasks TO agent_tasks_migrator,agent_tasks_runtime;
      GRANT CREATE ON DATABASE agent_tasks TO agent_tasks_migrator;
      ALTER DEFAULT PRIVILEGES FOR ROLE agent_tasks_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      ALTER ROLE agent_tasks_runtime SET statement_timeout='5s';
      ALTER ROLE agent_tasks_runtime SET lock_timeout='3s';
      ALTER ROLE agent_tasks_runtime SET idle_in_transaction_session_timeout='10s';
      ALTER ROLE agent_tasks_runtime CONNECTION LIMIT 24;
      ALTER ROLE agent_tasks_migrator CONNECTION LIMIT 2;`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  const forRole = index => { const url = new URL(adminUrl); url.username=roles[index]; url.password=passwords[index]; return connect({ ...config.database, connectionString:url.href }); };
  const migration = forRole(0);
  const storeOptions = { schema: config.appSchema, namespace: config.base, secret: config.sessionSecret };
  const migrator = new TaskStore({ pool:migration, ...storeOptions });
  const callbackMigrator = new PostgresCallbackStateStore({ pool:migration, schema:config.callbackSchema });
  await migrator.migrate(); await callbackMigrator.migrate(); await callbackMigrator.close();
  await migration.query(`REVOKE ALL ON SCHEMA agent_tasks,agent_tasks_callbacks FROM PUBLIC;
    GRANT USAGE ON SCHEMA agent_tasks,agent_tasks_callbacks TO agent_tasks_runtime;
    GRANT SELECT ON agent_tasks.schema_version,agent_tasks_callbacks.schema_migrations TO agent_tasks_runtime;
    GRANT SELECT,INSERT,UPDATE ON agent_tasks.accounts,agent_tasks.tasks TO agent_tasks_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON agent_tasks.sessions,agent_tasks_callbacks.callback_states TO agent_tasks_runtime;
    GRANT EXECUTE ON FUNCTION agent_tasks.app_now(),agent_tasks_callbacks.app_now_ms() TO agent_tasks_runtime;`);
  const runtime = forRole(1), store = new TaskStore({ pool:runtime, ...storeOptions });
  const callbacks = new PostgresCallbackStateStore({ pool:runtime, schema:config.callbackSchema });
  await store.verify(); await callbacks.verifySchema(); await callbacks.close();
  await assert.rejects(store.migrate(), error => error.code === '42501');
  const permissions = (await runtime.query(`SELECT current_user AS role,
    has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
    has_schema_privilege(current_user,'public','CREATE') AS public_create,
    has_schema_privilege(current_user,'agent_tasks','CREATE') AS app_create,
    rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.deepEqual(permissions, { role:'agent_tasks_runtime', database_create:false, public_create:false, app_create:false, rolsuper:false, rolcreatedb:false, rolcreaterole:false, rolreplication:false, rolbypassrls:false });
  console.log(JSON.stringify({ event:'agent_tasks_bootstrap_complete', freshDatabase:true, separateMigrator:true, runtimeMigrationDenied:true, schemasReady:true, runtimePrivileges:permissions }));
} catch {
  process.exitCode=1; console.error('agent_tasks_bootstrap_failed');
} finally { await Promise.allSettled(connections.map(pool => pool.end())); }
