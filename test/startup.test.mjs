import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readinessCheck } from '../src/readiness.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const script of ['server.mjs', 'migrate.mjs']) test(`${script} never prints a malformed database URL's secret-bearing input`, async () => {
  const canary = 'CONFIG_PASSWORD_CANARY_71c2';
  const env = { ...process.env, NODE_ENV: 'production', BASE_URL: 'https://tasks.sentfrom.ai', DATABASE_URL: 'postgresql://user:' + canary + '@[', STATE_SECRET: 'state-secret'.repeat(4), SESSION_SECRET: 'session-secret'.repeat(4) };
  await assert.rejects(promisify(execFile)(process.execPath, ['src/' + script], { cwd: root, env, timeout: 5000 }), error => {
    const output = error.stdout + error.stderr;
    assert.match(output, /Invalid Agent Tasks configuration/);
    assert.equal(output.includes(canary), false); assert.equal(output.includes('postgresql://'), false); assert.equal(output.includes('input:'), false);
    return true;
  });
});
test('readiness probes immediately, coalesces both schemas, and expires cache after clock rollback', async () => {
  let time = 0, appCalls = 0, callbackCalls = 0, callbackFailure = false, stopping = false;
  const ready = readinessCheck({ now: () => time, stopping: () => stopping, store: { verify: async () => { appCalls++; } }, callbacks: { verifySchema: async () => { callbackCalls++; if (callbackFailure) throw new Error('callback schema unavailable'); } } });
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => ready())), Array(20).fill(true));
  assert.equal(appCalls, 1); assert.equal(callbackCalls, 1);
  time = 1000; assert.equal(await ready(), true); assert.equal(appCalls, 1);
  callbackFailure = true; time = -1000;
  assert.equal(await ready(), false); assert.equal(appCalls, 2); assert.equal(callbackCalls, 2);
  callbackFailure = false; time = 1000;
  assert.equal(await ready(), true); assert.equal(appCalls, 3); assert.equal(callbackCalls, 3);
  stopping = true; assert.equal(await ready(), false); assert.equal(appCalls, 3);
});
test('an early readiness failure does not release coalescing while another schema query is still pending', async () => {
  let time = 0, appCalls = 0, callbackCalls = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const ready = readinessCheck({ now: () => time, store: { verify: async () => { appCalls++; throw new Error('application schema failed'); } }, callbacks: { verifySchema: async () => { callbackCalls++; await waiting; } } });
  const first = ready(); await Promise.resolve(); await Promise.resolve();
  time = 3000;
  const second = ready(); await Promise.resolve();
  assert.equal(appCalls, 1); assert.equal(callbackCalls, 1);
  release(); assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await ready(), false); assert.equal(callbackCalls, 1);
});
