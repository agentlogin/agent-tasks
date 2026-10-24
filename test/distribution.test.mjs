import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifyLock } from '../scripts/verify-lock.mjs';
const read = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const pkg = read('package.json'), lock = read('package-lock.json'), distribution = read('distribution.json');
test('portable lock pins official public release archives and ordinary registry dependencies', () => {
  assert.equal(verifyLock(pkg, lock, distribution).officialArchives, 4);
});
for (const [name, alter] of [
  ['local tarball', entry => { entry.resolved = 'file:/private/tmp/hidden.tgz'; }],
  ['workspace link', entry => { entry.link = true; }],
  ['different archive', entry => { entry.resolved += '?replacement=yes'; }],
  ['wrong integrity', entry => { entry.integrity = 'sha512-WRONG'; }],
  ['unpublished npm substitution', entry => { entry.resolved = 'https://registry.npmjs.org/@agentlogin/rp/-/rp-0.2.0-beta.1.tgz'; }],
]) test(`portable lock rejects ${name}`, () => {
  const changed = structuredClone(lock); alter(changed.packages['node_modules/@agentlogin/rp']);
  assert.throws(() => verifyLock(pkg, changed, distribution));
});
