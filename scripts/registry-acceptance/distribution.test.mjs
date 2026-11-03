// Six distribution checks adapted only in this disposable copy from GitHub archives to npm.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifyLock } from '../scripts/verify-lock.mjs';
const read=name=>JSON.parse(readFileSync(new URL('../'+name,import.meta.url),'utf8'));
const pkg=read('package.json'),lock=read('package-lock.json'),expected=read('expected-registry-release.json');
test('npm registry-only lock pins all nine original release artifact integrities',()=>{assert.equal(verifyLock(pkg,lock,expected).officialPackages,9);});
for(const [name,alter] of [
 ['local tarball',entry=>{entry.resolved='file:/private/tmp/hidden.tgz';}],
 ['workspace link',entry=>{entry.link=true;}],
 ['credential-bearing URL',entry=>{entry.resolved='https://user:canary@registry.npmjs.org/anything.tgz';}],
 ['wrong integrity',entry=>{entry.integrity='sha512-WRONG';}],
 ['non-registry archive',entry=>{entry.resolved='https://github.com/agentlogin/reference/releases/download/v0.2.0-beta.2/agentlogin-rp-0.2.0-beta.2.tgz';}],
])test(`registry acceptance rejects ${name}`,()=>{const changed=structuredClone(lock);alter(changed.packages['node_modules/@agentlogin/rp']);assert.throws(()=>verifyLock(pkg,changed,expected));});
