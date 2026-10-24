#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** The semver manifest is portable; only the lock selects these public, integrity-pinned release archives. */
export function verifyLock(pkg, lock, distribution) {
  assert.equal(lock.lockfileVersion, 3, 'A reviewed lockfile v3 is required');
  assert.equal(lock.name, pkg.name); assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  assert.equal(distribution.channel, 'official-github-release');
  assert.equal(distribution.npmRegistryPublication, false);
  const pins = new Map(distribution.packages.map(entry => [entry.name, entry]));
  assert.equal(pins.size, 4);
  let officialArchives = 0, registryPackages = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.ok(path.startsWith('node_modules/') && !path.includes('..') && !entry.link, 'Workspace links or escaping dependency paths are forbidden');
    const url = new URL(entry.resolved);
    assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Dependency sources must be public HTTPS URLs without credentials');
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Every archive needs SHA-512 integrity');
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const pin = pins.get(name);
    if (pin) {
      assert.equal(path, 'node_modules/' + name, 'Official packages must not be silently duplicated');
      assert.equal(entry.version, pin.version); assert.equal(entry.resolved, pin.url); assert.equal(entry.integrity, pin.integrity);
      assert.ok(pin.url.startsWith('https://github.com/agentlogin/reference/releases/download/v0.2.0-beta.1/'));
      officialArchives++;
    } else {
      assert.equal(url.hostname, 'registry.npmjs.org', 'Unreviewed dependency host');
      registryPackages++;
    }
  }
  assert.equal(officialArchives, pins.size);
  assert.equal(lock.packages['node_modules/@agentlogin/issuer'].dev, true, 'The synthetic Issuer must remain development-only');
  return { officialArchives, registryPackages, localPaths: false, workspaceLinks: false, npmRegistryPublication: false };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const json = async name => JSON.parse(await readFile(new URL('../' + name, import.meta.url), 'utf8'));
  try { console.log(JSON.stringify(verifyLock(await json('package.json'), await json('package-lock.json'), await json('distribution.json')))); }
  catch { console.error('Dependency lock verification failed'); process.exitCode = 1; }
}
