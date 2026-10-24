import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCallbackStateStore, RelyingPartyError } from '@agentlogin/rp';
import { createApplication, bodyJson } from '../src/app.mjs';
import { configuration } from '../src/config.mjs';
import { fixture, skip, sid, identity, live, base, deferred } from './helpers.mjs';
const options = { skip, timeout: 15_000 };
const stateSecret = 'application-state-secret'.repeat(3);
const application = (store, recheck = async () => {}) => createApplication({ base, issuer: 'https://issuer.example', stateSecret, store, callbackStore: new MemoryCallbackStateStore(), recheck });
const req = (path, { cookie, method = 'GET', origin = base, body, headers = {} } = {}) => new Request(base + path, { method, headers: { ...(cookie ? { cookie: `__Host-agent_tasks_sid=${cookie}` } : {}), ...(origin === undefined ? {} : { origin }), ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('all browser/API surfaces keep privacy, CSP and cache headers without CORS', options, async t => {
  const f = await fixture(t), app = application(f.store);
  for (const path of ['/', '/tasks-board', '/me', '/tasks', '/privacy', '/terms', '/client-metadata.json', '/healthz', '/readyz', '/not-found']) {
    const response = await app.fetch(req(path));
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const doc = await (await app.fetch(req('/client-metadata.json'))).json();
  assert.equal(doc.client_name, 'Agent Tasks'); assert.equal(doc.client_id, base + '/client-metadata.json');
  assert.deepEqual(doc.redirect_uris, [base + '/auth/agent/callback']);
});
test('missing/null/foreign/sibling Origin and cross-site browser metadata cannot create tasks or logout', options, async t => {
  const f = await fixture(t), cookie = sid(); await f.store.create(cookie, identity(), live(f.now()));
  let checks = 0; const app = application(f.store, async () => { checks++; });
  for (const origin of [null, 'null', 'https://evil.example', 'https://sibling.tasks.example', base + '/', 'http://tasks.example', base + ', https://evil.example']) {
    for (const path of ['/tasks', '/tasks/complete', '/logout']) {
      const request = req(path, { cookie, method: 'POST', origin, body: { id: 'csrf-test-task-001', title: 'Denied' } });
      if (origin === null) request.headers.delete('origin');
      assert.equal((await app.fetch(request)).status, 403);
    }
  }
  assert.equal((await app.fetch(req('/logout', { cookie, method: 'POST', headers: { 'sec-fetch-site': 'same-site' } }))).status, 403);
  assert.equal(checks, 0); assert.deepEqual(await f.store.list(cookie), []); assert.ok(await f.store.get(cookie));
});
test('logout during a successful UserInfo request prevents the later business write on another host', options, async t => {
  const f = await fixture(t), cookie = sid(); await f.store.create(cookie, identity(), live(f.now()));
  const started = deferred(), resume = deferred();
  const a = application(f.store, async () => { started.resolve(); await resume.promise; }), b = application(f.peer);
  const writing = a.fetch(req('/tasks', { cookie, method: 'POST', body: { id: 'racing-logout-01', title: 'Too late' } }));
  await started.promise;
  assert.equal((await b.fetch(req('/logout', { cookie, method: 'POST' }))).status, 200);
  resume.resolve();
  assert.equal((await writing).status, 401);
  assert.equal((await a.fetch(req('/me', { cookie }))).status, 401);
  assert.equal((await f.pool.query(`SELECT count(*) FROM "${f.schema}".tasks`)).rows[0].count, '0');
});
test('Issuer outage denies writes without deleting a valid read-only session; explicit revocation deletes it', options, async t => {
  const f = await fixture(t), cookie = sid(); await f.store.create(cookie, identity(), live(f.now()));
  const request = () => req('/tasks', { cookie, method: 'POST', body: { id: 'issuer-outage-01', title: 'Deferred' } });
  const outage = application(f.store, async () => { throw new Error('network unavailable'); });
  assert.equal((await outage.fetch(request())).status, 503); assert.ok(await f.store.get(cookie)); assert.deepEqual(await f.store.list(cookie), []);
  const revoked = application(f.peer, async () => { throw new RelyingPartyError('revoked', 'revoked'); });
  assert.equal((await revoked.fetch(request())).status, 401); assert.equal(await f.store.get(cookie), undefined);
});
test('expired access credentials allow session reads but cannot authorize lasting actions', options, async t => {
  const f = await fixture(t), cookie = sid(); await f.store.create(cookie, identity(), live(f.now())); await f.advance(601);
  let checks = 0; const app = application(f.store, async () => { checks++; });
  assert.equal((await app.fetch(req('/me', { cookie }))).status, 200);
  assert.equal((await app.fetch(req('/tasks', { cookie }))).status, 200);
  assert.equal((await app.fetch(req('/tasks', { cookie, method: 'POST', body: { id: 'expired-live-001', title: 'Denied' } }))).status, 401);
  assert.equal(checks, 0);
});
test('duplicate same-name cookies fail closed and logout failures never claim success or erase the cookie', options, async t => {
  const f = await fixture(t), cookie = sid(); await f.store.create(cookie, identity(), live(f.now()));
  const app = application(f.store);
  const duplicate = req('/me', { cookie }); duplicate.headers.append('cookie', `__Host-agent_tasks_sid=${sid()}`);
  assert.equal((await app.fetch(duplicate)).status, 401);
  const broken = application({ ...f.store, logout: async () => { throw new Error('not committed'); } });
  const response = await broken.fetch(req('/logout', { cookie, method: 'POST' }));
  assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null); assert.ok(await f.store.get(cookie));
});
test('public configuration refuses unsafe origins, transport and secret reuse', () => {
  const env = { NODE_ENV: 'production', BASE_URL: 'https://tasks.sentfrom.ai', DATABASE_URL: 'postgresql://test:dummy@db.example/test', STATE_SECRET: stateSecret, SESSION_SECRET: 'session-secret'.repeat(4) };
  const good = configuration(env); assert.equal(good.database.ssl.rejectUnauthorized, true); assert.equal(good.database.max, 8);
  for (const overrides of [{ BASE_URL: 'http://localhost:4010' }, { BASE_URL: 'https://tasks.sentfrom.ai/' }, { DATABASE_URL: env.DATABASE_URL + '?sslmode=disable' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { SESSION_SECRET: stateSecret }, { DATABASE_TRANSPORT: 'loopback-test' }, { DATABASE_TRANSPORT: 'railway-private' }, { ISSUER: 'https://unapproved.example' }]) assert.throws(() => configuration({ ...env, ...overrides }));
});
test('streamed JSON parsing enforces content type and byte limit', async () => {
  await assert.rejects(bodyJson(new Request(base, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })), e => e.status === 415);
  await assert.rejects(bodyJson(new Request(base, { method: 'POST', body: JSON.stringify({ title: 'x'.repeat(9000) }), headers: { 'content-type': 'application/json' } })), e => e.status === 413);
});
