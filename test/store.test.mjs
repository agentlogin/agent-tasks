import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { TaskStore, UncertainCommitError, validateTask } from '../src/store.mjs';
import { fixture, skip, sid, identity, live, eventually, connectionString } from './helpers.mjs';
const options = { skip, timeout: 15_000 };

test('tasks and durable logout work across independent pools and account identity excludes handles', options, async t => {
  const f = await fixture(t), a = sid(), b = sid(), c = sid();
  await f.store.create(a, identity(), live(f.now()));
  await f.store.create(b, identity('agent-b'), live(f.now(), 'agent-b'));
  await f.store.create(c, identity('agent-a', 'https://other.example'), live(f.now(), 'agent-a', 'https://other.example'));
  await f.store.write(a, { id: 'private-task-0001', title: 'Only Agent A sees this' });
  assert.equal((await f.peer.list(a)).length, 1);
  assert.deepEqual(await f.peer.list(b), []); assert.deepEqual(await f.peer.list(c), []);
  await assert.rejects(f.peer.write(b, { id: 'private-task-0001' }, true), e => e.status === 404);
  assert.equal((await f.peer.write(a, { id: 'private-task-0001' }, true)).completed, true);
  await f.peer.logout(a);
  assert.equal(await f.store.get(a), undefined);
  await assert.rejects(f.store.write(a, { id: 'private-task-0002', title: 'Denied' }), e => e.status === 401);
  assert.ok(await f.store.get(b));
});
test('session and token plaintext are absent, ciphertext binds to identity/session and rotation fails closed', options, async t => {
  const f = await fixture(t), a = sid(), b = sid();
  await f.store.create(a, identity(), live(f.now())); await f.store.create(b, identity(), live(f.now()));
  const rows = (await f.pool.query(`SELECT * FROM "${f.schema}".sessions`)).rows;
  assert.equal(JSON.stringify(rows).includes(a), false); assert.equal(JSON.stringify(rows).includes(live(f.now()).accessToken), false);
  assert.equal(rows[0].live_ciphertext.equals(rows[1].live_ciphertext), false);
  await f.pool.query(`UPDATE "${f.schema}".sessions SET live_ciphertext=$2 WHERE key=$1`, [f.store.key(b), rows.find(row => row.key === f.store.key(a)).live_ciphertext]);
  await assert.rejects(f.peer.get(b)); assert.ok(await f.peer.get(a));
  const rotated = new TaskStore({ pool: f.peerPool, ...f.options, secret: 'rotated-test-secret'.repeat(4) });
  assert.equal(await rotated.get(a), undefined);
});
test('idempotency preserves task title and concurrent account task limit is enforced', options, async t => {
  const f = await fixture(t), a = sid(), b = sid();
  await f.store.create(a, identity(), live(f.now())); await f.store.create(b, identity(), live(f.now()));
  const task = { id: 'idempotent-task-001', title: 'Exactly one task' };
  const saved = await Promise.all([f.store.write(a, task), f.peer.write(b, task)]);
  assert.deepEqual(saved[0], saved[1]); assert.equal((await f.store.list(a)).length, 1);
  await assert.rejects(f.store.write(a, { ...task, title: 'Changed' }), e => e.code === 'idempotency_conflict');
  await f.pool.query(`INSERT INTO "${f.schema}".tasks(issuer,subject,id,title,created_at) SELECT $1,$2,'seed-task-number-'||n,'Synthetic',$3 FROM generate_series(1,98) n`, [identity().iss, identity().sub, f.now()]);
  const final = await Promise.allSettled([f.store.write(a, { id: 'last-task-0000001', title: 'One' }), f.peer.write(b, { id: 'last-task-0000002', title: 'Two' })]);
  assert.equal(final.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await f.peer.list(a)).length, 100);
});
test('expiry after account-lock contention rolls back the business write', options, async t => {
  const f = await fixture(t), cookie = sid(); await f.store.create(cookie, identity(), { ...live(f.now()), accessTokenExpiresAt: f.now() + 1 });
  const lock = await f.pool.connect();
  try {
    await lock.query('BEGIN'); await lock.query(`SELECT * FROM "${f.schema}".accounts FOR UPDATE`);
    const writing = f.peer.write(cookie, { id: 'waiting-task-0001', title: 'Cannot outlive proof' });
    const rejected = assert.rejects(writing, e => e.code === 'reauthentication_required');
    await eventually(async () => Number((await f.pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1", ['%' + f.schema + '%'])).rows[0].count) > 0);
    await f.advance(2); await lock.query('COMMIT'); await rejected;
    assert.deepEqual(await f.store.list(cookie), []);
  } finally { await lock.query('ROLLBACK'); lock.release(); }
});
test('expiry immediately before commit rolls back a written task', options, async t => {
  let f, armed = false;
  f = await fixture(t, async event => { if (armed && event.operation === 'createTask' && event.phase === 'before-commit') { armed = false; await f.advance(601); } });
  const cookie = sid(); await f.store.create(cookie, identity(), live(f.now())); armed = true;
  await assert.rejects(f.store.write(cookie, { id: 'final-gate-task-1', title: 'Must roll back' }), e => e.code === 'reauthentication_required');
  assert.deepEqual(await f.peer.list(cookie), []);
});
test('uncertain commit is reported as uncertain and an explicit same-ID retry is idempotent', options, async t => {
  let armed = false;
  const f = await fixture(t, event => { if (armed && event.operation === 'createTask' && event.phase === 'after-commit') { armed = false; throw new Error('acknowledgement lost'); } });
  const cookie = sid(); await f.store.create(cookie, identity(), live(f.now())); armed = true;
  const task = { id: 'uncertain-task-01', title: 'Persisted despite lost reply' };
  await assert.rejects(f.store.write(cookie, task), UncertainCommitError);
  assert.equal((await f.peer.list(cookie)).length, 1);
  assert.equal((await f.peer.write(cookie, task)).title, task.title);
  assert.equal((await f.peer.list(cookie)).length, 1);
});
test('cleanup removes expired credential ciphertext before the session expires; reads do not extend expiry', options, async t => {
  const f = await fixture(t), cookie = sid(); await f.store.create(cookie, identity(), live(f.now()));
  const original = await f.store.get(cookie); await f.advance(601); await f.store.cleanup();
  assert.equal((await f.peer.get(cookie)).live, undefined);
  assert.equal((await f.peer.get(cookie)).expiresAt, original.expiresAt);
  assert.equal((await f.pool.query(`SELECT live_ciphertext FROM "${f.schema}".sessions`)).rows[0].live_ciphertext, null);
  await f.advance(3000); await f.store.cleanup(); assert.equal(await f.peer.get(cookie), undefined);
});
test('schema verification rejects unknown versions and concurrent migrations are idempotent', options, async t => {
  const f = await fixture(t); await Promise.all([f.store.migrate(), f.peer.migrate()]); await f.store.verify();
  await f.pool.query(`UPDATE "${f.schema}".schema_version SET version=2`);
  await assert.rejects(f.peer.verify(), /Unsupported/); await assert.rejects(f.peer.migrate(), /Unsupported/);
});
test('runtime uses only documented DML grants and cannot run schema migrations', options, async t => {
  const f = await fixture(t), role = f.schema + '_role';
  await f.pool.query(`CREATE OR REPLACE FUNCTION "${f.schema}".app_now() RETURNS bigint LANGUAGE sql VOLATILE SET search_path=pg_catalog AS 'SELECT floor(extract(epoch FROM clock_timestamp()))::bigint'`);
  await f.pool.query(`CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA "${f.schema}" TO "${role}";
    GRANT SELECT ON "${f.schema}".schema_version TO "${role}";
    GRANT SELECT,INSERT,UPDATE ON "${f.schema}".accounts,"${f.schema}".tasks TO "${role}";
    GRANT SELECT,INSERT,UPDATE,DELETE ON "${f.schema}".sessions TO "${role}";
    GRANT EXECUTE ON FUNCTION "${f.schema}".app_now() TO "${role}"`);
  const restrictedPool = new Pool({ connectionString, max: 1 }); restrictedPool.on('error', () => {});
  try {
    await restrictedPool.query(`SET ROLE "${role}"`);
    const runtime = new TaskStore({ pool: restrictedPool, ...f.options }), cookie = sid();
    await runtime.verify(); await runtime.create(cookie, identity(), live(f.now()));
    await runtime.write(cookie, { id: 'restricted-role-01', title: 'Runtime task' });
    assert.equal((await runtime.list(cookie)).length, 1);
    await runtime.logout(cookie); assert.equal(await runtime.get(cookie), undefined);
    await assert.rejects(runtime.migrate(), e => e.code === '42501');
  } finally { await restrictedPool.end(); await f.pool.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); }
});
test('checked-out connection loss fails closed and the pool replaces the terminated connection', options, async t => {
  let armed = false, f;
  f = await fixture(t, async ({ operation, phase, client }) => {
    if (armed && operation === 'createTask' && phase === 'before-commit') {
      armed = false;
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const ended = new Promise(resolve => client.once('end', resolve));
      await f.peerPool.query('SELECT pg_terminate_backend($1)', [pid]); await ended;
    }
  });
  const cookie = sid(); await f.store.create(cookie, identity(), live(f.now())); armed = true;
  await assert.rejects(f.store.write(cookie, { id: 'terminated-task-01', title: 'Not committed' }));
  assert.deepEqual(await f.store.list(cookie), []);
  assert.ok(await f.store.get(cookie));
});
test('task validation rejects oversized, ambiguous and unexpected writes', () => {
  for (const input of [null, [], {}, { id: 'tiny', title: 'Task' }, { id: 'valid-task-id-0001', title: '' }, { id: 'valid-task-id-0001', title: 'a\n' }, { id: 'valid-task-id-0001', title: 'a'.repeat(201) }, { id: 'valid-task-id-0001', title: 'okay', owner: 'other' }]) assert.throws(() => validateTask(input));
});
