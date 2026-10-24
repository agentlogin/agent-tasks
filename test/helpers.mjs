import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { TaskStore } from '../src/store.mjs';
export const connectionString = process.env.TEST_DATABASE_URL;
export const skip = !connectionString && process.env.REQUIRE_POSTGRES_TESTS !== '1' ? 'TEST_DATABASE_URL is not configured' : false;
export const secret = 'task-store-test-secret'.repeat(3);
export const base = 'https://tasks.example';
export const sid = () => randomBytes(32).toString('base64url');
export const identity = (subject = 'agent-a', issuer = 'https://issuer.example') => ({ iss: issuer, sub: subject, handle: 'same-handle@example.com', scopes: ['openid', 'email'] });
export const live = (now, subject = 'agent-a', issuer = 'https://issuer.example') => ({ issuer, sub: subject, accessToken: 'private-test-access-token-' + subject, accessTokenExpiresAt: now + 600 });
export async function fixture(t, checkpoint) {
  assert.ok(connectionString, 'REQUIRE_POSTGRES_TESTS needs TEST_DATABASE_URL');
  const schema = 'tasks_test_' + randomUUID().replaceAll('-', '');
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 3000 });
  const peerPool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {}); peerPool.on('error', () => {});
  const options = { schema, namespace: base, secret };
  const store = new TaskStore({ pool, ...options, checkpoint }), peer = new TaskStore({ pool: peerPool, ...options });
  await store.migrate();
  let time = Math.floor(Date.now() / 1000);
  await pool.query(`CREATE SEQUENCE "${schema}".test_clock START WITH ${time}; CREATE OR REPLACE FUNCTION "${schema}".app_now() RETURNS bigint LANGUAGE sql VOLATILE SET search_path=pg_catalog AS 'SELECT last_value FROM "${schema}".test_clock'`);
  t.after(async () => { await peerPool.end(); try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } });
  return { store, peer, pool, peerPool, schema, options, now: () => time, advance: async seconds => { time += seconds; await pool.query('SELECT setval($1::regclass,$2,true)', [schema + '.test_clock', time]); } };
}
export async function eventually(predicate) { const end = Date.now() + 3000; while (!await predicate()) { assert.ok(Date.now() < end, 'expected lock wait'); await new Promise(r => setTimeout(r, 10)); } }
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
