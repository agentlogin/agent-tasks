import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { AgentLogin, MemoryCookieJar, MemoryKeystore } from 'agentlogin';
import { createIssuer } from '@agentlogin/issuer';
import { PostgresCallbackStateStore } from '@agentlogin/rp-store-postgres';
import { TaskStore } from '../src/store.mjs';
import { createApplication } from '../src/app.mjs';
import { httpServer } from '../src/http.mjs';
import { fixture, skip } from './helpers.mjs';
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function listen(t, base, handler) {
  const server = httpServer(base, handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(base).port), '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}

test('installed packages sign in over real HTTP: cross-instance callback, private action, restart, replay, logout and revocation', { skip, timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const issuerOrigin = `http://127.0.0.1:${await port()}`, base = `http://127.0.0.1:${await port()}`;
  const issuer = await createIssuer({ issuer: issuerOrigin, handleDomains: ['example.com'], allowInsecureClients: true, adminToken: 'disposable-test-bootstrap' });
  let exchanges = 0;
  await listen(t, issuerOrigin, request => { if (new URL(request.url).pathname === '/token') exchanges++; return issuer.app.fetch(request); });
  const schema = f.schema + '_cb';
  const callbackA = new PostgresCallbackStateStore({ pool: f.pool, schema }), callbackB = new PostgresCallbackStateStore({ pool: f.peerPool, schema });
  await callbackA.migrate();
  t.after(async () => { await Promise.all([callbackA.close(), callbackB.close()]); });
  const options = { base, issuer: issuerOrigin, stateSecret: 'standalone-e2e-state-secret'.repeat(3), allowLoopback: true, testHandleDomains: ['example.com'] };
  const a = createApplication({ ...options, store: f.store, callbackStore: callbackA });
  const b = createApplication({ ...options, store: f.peer, callbackStore: callbackB });
  let route = a;
  await listen(t, base, request => route.fetch(request));
  const admin = async (path, body) => {
    const response = await fetch(issuerOrigin + path, { method: 'POST', headers: { authorization: 'Bearer disposable-test-bootstrap', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok); return response.json();
  };
  const owner = await admin('/admin/owners', { email: 'synthetic-owner@example.com', name: 'Synthetic Owner' });
  await admin('/admin/agents', { handle: 'synthetic@example.com', owner_id: owner.owner_id, name: 'Synthetic' });
  const cookies = new MemoryCookieJar();
  const client = new AgentLogin({ handle: 'synthetic@example.com', issuer: issuerOrigin, allowInsecure: true, keystore: new MemoryKeystore(), cookies });
  const enrolled = await client.enroll({ credential: owner.credential });
  const signIn = () => client.signInAt(base + '/auth/agent/login', { onReview: tx => tx.client.client_id === base + '/client-metadata.json' && tx.requested_scopes.every(scope => ['openid', 'email'].includes(scope)) ? 'allow' : 'deny' });
  // Core 5.8 requires form-encoded POST initiation as well as the ordinary GET login link.
  const initiated = await client.fetch(base + '/auth/agent/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ iss: issuerOrigin, login_hint: 'synthetic@example.com' }).toString() });
  assert.equal(initiated.status, 302);
  const result = await client.signIn({ authorizationUrl: initiated.headers.get('location'), expectedHost: new URL(base).host, acceptDisclosure: false, onReview: tx => tx.client.client_id === base + '/client-metadata.json' && tx.requested_scopes.every(scope => ['openid', 'email'].includes(scope)) ? 'allow' : 'deny' });
  const callbackCookie = await cookies.header(new URL(result.redirectUrl));
  route = b;
  assert.equal((await client.follow(result)).status, 200);
  assert.equal(exchanges, 1);
  const me = await (await client.fetch(base + '/me')).json();
  assert.equal(me.iss, issuerOrigin); assert.equal(me.handle, 'synthetic@example.com');
  route = a;
  assert.equal((await fetch(result.redirectUrl, { headers: { cookie: callbackCookie }, redirect: 'manual' })).status, 400);
  assert.equal(exchanges, 1, 'second handler must not exchange an already consumed callback');
  const write = (path, body) => client.fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const task = { id: 'real-http-task-0001', title: '<script>Untrusted title remains text</script>' };
  assert.equal((await write('/tasks', task)).status, 200);
  assert.equal((await write('/tasks', task)).status, 200);
  assert.equal((await (await client.fetch(base + '/tasks')).json()).tasks.length, 1);
  const restarted = new TaskStore({ pool: f.peerPool, ...f.options });
  route = createApplication({ ...options, store: restarted, callbackStore: callbackB });
  assert.equal((await (await client.fetch(base + '/tasks')).json()).tasks[0].title, task.title);
  assert.equal((await write('/tasks/complete', { id: task.id })).status, 200);
  const oldCookie = await cookies.header(new URL(base));
  assert.equal((await write('/logout', {})).status, 200);
  for (const replica of [a, b, route]) {
    const response = await replica.fetch(new Request(base + '/me', { headers: { cookie: oldCookie } }));
    assert.equal(response.status, 401);
  }
  assert.equal((await client.follow(await signIn())).status, 200);
  assert.equal((await (await client.fetch(base + '/me')).json()).sub, me.sub);
  assert.equal((await (await client.fetch(base + '/tasks')).json()).tasks[0].completed, true);
  const revoked = await fetch(`${issuerOrigin}/agents/${encodeURIComponent('synthetic@example.com')}/keys`, { method: 'DELETE', headers: { authorization: `Bearer ${owner.credential}` } });
  assert.equal(revoked.status, 204);
  const denied = await write('/tasks', { id: 'after-revoke-001', title: 'Denied' });
  assert.equal(denied.status, 401); assert.equal((await denied.json()).error, 'revoked');
  assert.equal((await client.fetch(base + '/me')).status, 401);
  assert.ok(enrolled.kid);
  // Callback fixture schema is independent; remove it before the shared test pool closes.
  await f.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
});
