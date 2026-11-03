import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { consumerPackage } from './consumer-package.mjs';

const read = relative => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const source = read('../../package.json');
const expected = read('./expected-release.json');

test('new registry release replaces existing runtime and development pins only in the disposable manifest', () => {
  const before = structuredClone(source);
  const result = consumerPackage(source, expected.packages);
  assert.deepEqual(source, before, 'source package must not be mutated');
  for (const pin of expected.packages) {
    assert.equal(result.dependencies[pin.name] ?? result.devDependencies[pin.name], pin.version);
  }
  for (const name of ['@agentlogin/rp', '@agentlogin/rp-store-postgres']) {
    assert.equal(result.dependencies[name], '0.2.0-beta.2', 'existing runtime pins must not retain beta.1');
    assert.equal(result.devDependencies[name], undefined, 'preserve production dependency classification');
  }
  assert.equal(result.devDependencies['@agentlogin/issuer'], '0.2.0-beta.2');
  assert.equal(result.dependencies['@agentlogin/issuer'], undefined);
  assert.equal(result.devDependencies['sentfromai-mcp'], '0.5.0-beta.2');
  assert.equal(result.dependencies.pg, source.dependencies.pg);
  assert.deepEqual(result.scripts, source.scripts);
});

test('a duplicate dependency declaration cannot retain a different release version', () => {
  const duplicate = structuredClone(source);
  duplicate.devDependencies['@agentlogin/rp'] = '0.2.0-beta.1';
  const result = consumerPackage(duplicate, expected.packages);
  assert.equal(result.dependencies['@agentlogin/rp'], '0.2.0-beta.2');
  assert.equal(result.devDependencies['@agentlogin/rp'], '0.2.0-beta.2');
});

test('duplicate release package identities are refused', () => {
  assert.throws(() => consumerPackage(source, [...expected.packages, expected.packages[0]]), /Duplicate release package/);
});

test('preparation refuses non-manual or unconfirmed execution before creating a consumer', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-tasks-acceptance-gate-'));
  try {
    for (const [event, confirmed] of [['pull_request', 'true'], ['workflow_dispatch', 'false']]) {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare.mjs', import.meta.url))], {
        env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: event, PUBLICATION_CONFIRMED: confirmed,
          RUNNER_TEMP: scratch, GITHUB_OUTPUT: join(scratch, 'outputs') }, encoding: 'utf8', timeout: 5_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      assert.match(child.stderr, /AssertionError/);
      assert.deepEqual(readdirSync(scratch), []);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
