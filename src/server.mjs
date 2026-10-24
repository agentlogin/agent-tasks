import { Pool } from 'pg';
import { PostgresCallbackStateStore } from '@agentlogin/rp-store-postgres';
import { configuration } from './config.mjs';
import { TaskStore } from './store.mjs';
import { createApplication } from './app.mjs';
import { httpServer } from './http.mjs';
import { readinessCheck } from './readiness.mjs';

const config = configuration();
const pool = new Pool(config.database);
pool.on('error', () => console.error('database_connection_failed'));
const store = new TaskStore({ pool, schema: config.appSchema, secret: config.sessionSecret, namespace: config.base });
const callbacks = new PostgresCallbackStateStore({ pool, schema: config.callbackSchema });
let stopping = false, cleaning;
try { await Promise.all([store.verify(), callbacks.verifySchema()]); }
catch { await callbacks.close(); await pool.end(); throw new Error('Database schema verification failed; run the separate migration job'); }
const ready = readinessCheck({ store, callbacks, stopping: () => stopping });
const app = createApplication({ base: config.base, issuer: config.issuer, stateSecret: config.stateSecret, allowLoopback: config.dev, store, callbackStore: callbacks, ready });
const server = httpServer(config.base, app.fetch);
const cleanupTimer = setInterval(() => {
  if (cleaning || stopping) return;
  cleaning = Promise.all([store.cleanup(), callbacks.cleanup(500)]).catch(() => console.error('cleanup_failed')).finally(() => { cleaning = undefined; });
}, 60_000);
cleanupTimer.unref();
server.listen(config.port, config.dev ? '127.0.0.1' : '0.0.0.0', () => console.log('agent_tasks_listening'));
async function shutdown() {
  if (stopping) return;
  stopping = true; clearInterval(cleanupTimer);
  const timeout = setTimeout(() => server.closeAllConnections(), 15_000); timeout.unref();
  await new Promise(resolve => server.close(resolve)); clearTimeout(timeout);
  await cleaning; await callbacks.close(); await pool.end();
}
process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
