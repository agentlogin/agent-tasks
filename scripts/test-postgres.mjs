#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'agent-tasks-test-')), data = join(work, 'data');
const bin = name => process.env.PG_BIN ? join(process.env.PG_BIN, name) : name;
let started = false, child;
const stop = () => child?.kill('SIGTERM');
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  await run(bin('initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8']);
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  await run(bin('pg_ctl'), ['-D', data, '-l', join(work, 'pg.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${work}`, '-w', 'start']); started = true;
  const { readdir } = await import('node:fs/promises');
  const tests = (await readdir(join(root, 'test'))).filter(file => file.endsWith('.test.mjs')).map(file => 'test/' + file);
  child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: root, env: { ...process.env, REQUIRE_POSTGRES_TESTS: '1', TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres` }, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 300_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout); process.exitCode = code ?? 1;
} finally {
  if (started) await run(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']);
  await rm(work, { recursive: true, force: true });
}
