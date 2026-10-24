import { Pool } from 'pg';
import { PostgresCallbackStateStore } from '@agentlogin/rp-store-postgres';
import { configuration } from './config.mjs';
import { TaskStore } from './store.mjs';
const config = configuration();
const pool = new Pool({ ...config.database, max: 1 });
pool.on('error', () => console.error('migration_connection_failed'));
const callbacks = new PostgresCallbackStateStore({ pool, schema: config.callbackSchema });
const store = new TaskStore({ pool, schema: config.appSchema, namespace: config.base, secret: config.sessionSecret });
try { await store.migrate(); await callbacks.migrate(); console.log('agent_tasks_schema_ready'); }
catch { process.exitCode = 1; console.error('migration_failed'); }
finally { await callbacks.close(); await pool.end(); }
