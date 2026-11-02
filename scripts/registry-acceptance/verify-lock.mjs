// Disposable acceptance copy only: validates the newly published registry distribution.
import assert from 'node:assert/strict';
export function verifyLock(pkg, lock, distribution) {
  assert.equal(lock.lockfileVersion,3); assert.equal(lock.name,pkg.name); assert.equal(lock.version,pkg.version);
  assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);assert.deepEqual(lock.packages[''].devDependencies,pkg.devDependencies);
  const pins=new Map(distribution.packages.map(p=>[p.name,p]));assert.equal(pins.size,9);
  let officialPackages=0,transitivePackages=0;
  for(const [path,entry] of Object.entries(lock.packages)){
    if(!path)continue;
    assert.ok(path.startsWith('node_modules/')&&!path.includes('..')&&!entry.link);
    const url=new URL(entry.resolved);assert.equal(url.protocol,'https:');assert.equal(url.hostname,'registry.npmjs.org');
    assert.ok(!url.username&&!url.password&&!url.port&&!url.search&&!url.hash);assert.ok(url.pathname.endsWith('.tgz'));
    assert.match(entry.integrity,/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const name=path.slice(path.lastIndexOf('node_modules/')+'node_modules/'.length),pin=pins.get(name);
    if(pin){assert.equal(path,'node_modules/'+name);assert.equal(entry.version,pin.version);assert.equal(entry.integrity,pin.integrity);officialPackages++;}
    else transitivePackages++;
  }
  assert.equal(officialPackages,9);assert.equal(lock.packages['node_modules/@agentlogin/issuer'].dev,true);
  return{officialPackages,transitivePackages,registryOnly:true,localPaths:false,workspaceLinks:false};
}
