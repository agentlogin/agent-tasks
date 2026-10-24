#!/usr/bin/env node
// Linux CI only: runs the production dependency image against a disposable loopback test database.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';

assert.equal(process.platform, 'linux', 'Container smoke uses Linux host networking');
assert.equal(process.argv[2], '--image');
const image = process.argv[3];
assert.match(image ?? '', /^[a-z0-9][a-z0-9._:/-]{0,180}$/);
const database = new URL(process.env.TEST_DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && !database.search && !database.hash, 'Only an explicit disposable loopback test database is allowed');
assert.equal(process.env.REQUIRE_POSTGRES_TESTS, '1');
const run = promisify(execFile);
const docker = (args, options = {}) => run('docker', args, { timeout: 60_000, maxBuffer: 256 * 1024, ...options });
const temp = await mkdtemp(join(tmpdir(), 'agent-tasks-container-'));
const suffix = randomBytes(6).toString('hex');
const appSchema = 'tasks_container_' + suffix, callbackSchema = appSchema + '_cb', role = appSchema + '_runtime';
const container = 'agent-tasks-test-' + suffix;
const pool = new Pool({ connectionString: database.href, max: 1, connectionTimeoutMillis: 3000 });
pool.on('error', () => {});
const report = { sourceCommit: process.env.GITHUB_SHA ?? null, image, passed: false, productionDeployment: false, databaseScope: 'disposable loopback PostgreSQL', tlsTerminationExercised: false };
let roleCreated = false, containerCreated = false;
const envFile = async (name, values) => {
  const path = join(temp, name);
  const data = Object.entries(values).map(([key, value]) => { assert.ok(!/[\r\n]/.test(value)); return key + '=' + value; }).join('\n') + '\n';
  await writeFile(path, data, { mode: 0o600 }); return path;
};
try {
  const inspection = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
  assert.equal(inspection.Config.User, 'node'); report.imageId = inspection.Id;
  report.baseImage = (await readFile('Dockerfile', 'utf8')).match(/^FROM (\S+)$/m)?.[1];
  assert.match(report.baseImage, /@sha256:[a-f0-9]{64}$/);
  assert.notEqual((await docker(['run', '--rm', '--entrypoint', 'id', image, '-u'])).stdout.trim(), '0');
  report.nonroot = true;
  report.node = (await docker(['run', '--rm', '--entrypoint', 'node', image, '--version'])).stdout.trim();
  assert.equal(report.node, 'v22.23.4');
  await assert.rejects(docker(['run', '--rm', image]), error => {
    assert.match(error.stderr, /Invalid Agent Tasks configuration/); return true;
  });
  report.missingProductionConfigurationRejected = true;
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  // This test-only override is explicit. A production BASE_URL cannot select loopback transport.
  const common = { NODE_ENV: 'test', BASE_URL: base, ISSUER: 'https://identity.sentfrom.ai', PORT: String(port), DATABASE_TRANSPORT: 'loopback-test', STATE_SECRET: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex'), APP_DATABASE_SCHEMA: appSchema, CALLBACK_DATABASE_SCHEMA: callbackSchema };
  const migrationEnv = await envFile('migration.env', { ...common, DATABASE_URL: database.href });
  await docker(['run', '--rm', '--network', 'host', '--env-file', migrationEnv, image, 'node', 'src/migrate.mjs']);
  const password = randomBytes(32).toString('hex');
  await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`); roleCreated = true;
  await pool.query(`GRANT USAGE ON SCHEMA "${appSchema}","${callbackSchema}" TO "${role}";
    GRANT SELECT ON "${appSchema}".schema_version TO "${role}";
    GRANT SELECT,INSERT,UPDATE ON "${appSchema}".accounts,"${appSchema}".tasks TO "${role}";
    GRANT SELECT,INSERT,UPDATE,DELETE ON "${appSchema}".sessions,"${callbackSchema}".callback_states TO "${role}";
    GRANT SELECT ON "${callbackSchema}".schema_migrations TO "${role}";
    GRANT EXECUTE ON FUNCTION "${appSchema}".app_now(),"${callbackSchema}".app_now_ms() TO "${role}";`);
  const restricted = new URL(database); restricted.username = role; restricted.password = password;
  const runtimeEnv = await envFile('runtime.env', { ...common, DATABASE_URL: restricted.href });
  await docker(['run', '--detach', '--name', container, '--network', 'host', '--env-file', runtimeEnv, image]); containerCreated = true;
  const request = path => fetch(base + path, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  const deadline = performance.now() + 30_000;
  let ready = false;
  while (!ready && performance.now() < deadline) {
    try { ready = (await fetch(base + '/readyz', { signal: AbortSignal.timeout(2000), redirect: 'error' })).status === 200; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(ready, true, 'Container did not become ready under its restricted runtime role');
  assert.deepEqual(await (await request('/healthz')).json(), { status: 'alive' });
  assert.equal((await request('/tasks')).status, 401);
  const metadata = await (await request('/client-metadata.json')).json();
  assert.equal(metadata.client_name, 'Agent Tasks'); assert.equal(metadata.client_id, base + '/client-metadata.json');
  report.restrictedRuntimeReady = true; report.unauthenticatedTasksDenied = true; report.metadataBinding = true;
  // The frozen image must not start with administrative DDL privileges at runtime.
  await assert.rejects(docker(['run', '--rm', '--network', 'host', '--env-file', runtimeEnv, image, 'node', 'src/migrate.mjs']), error => { assert.match(error.stderr, /migration_failed/); return true; });
  report.runtimeMigrationDenied = true;
  await docker(['stop', '--time', '20', container]);
  assert.equal(JSON.parse((await docker(['inspect', container])).stdout)[0].State.ExitCode, 0);
  report.gracefulShutdown = true;
  report.lockSha256 = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  report.passed = true;
} catch (error) {
  report.failure = error?.code ?? error?.name ?? 'Error'; process.exitCode = 1;
} finally {
  if (containerCreated) await docker(['rm', '--force', container]).catch(() => {});
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${appSchema}","${callbackSchema}" CASCADE`);
    if (roleCreated) await pool.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    report.cleanupComplete = true;
  } catch { report.cleanupComplete = false; report.passed = false; process.exitCode = 1; }
  await pool.end(); await rm(temp, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile('container-smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
