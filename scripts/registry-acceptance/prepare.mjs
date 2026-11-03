// Manual CI only. This changes a disposable consumer, never the source checkout or release archives.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync,copyFileSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,join,relative,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerPackage } from './consumer-package.mjs';
const source=fileURLToPath(new URL('../..',import.meta.url));
assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
assert.equal(process.env.PUBLICATION_CONFIRMED,'true');
assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_OUTPUT);
const scratch=mkdtempSync(join(process.env.RUNNER_TEMP,'agentlogin-npm-acceptance-'));
const consumer=join(scratch,'consumer'),cache=join(scratch,'cache'),globalConfig=join(scratch,'global.npmrc');
const evidence=join(source,'evidence/npm-registry-acceptance');
for(const dir of [consumer,cache,evidence])mkdirSync(dir,{recursive:true,mode:0o700});
writeFileSync(globalConfig,'',{mode:0o600});
const expected=JSON.parse(readFileSync(new URL('./expected-release.json',import.meta.url),'utf8'));
const sources=[
 ['agentlogin','https://github.com/agentlogin/reference/releases/download/v0.2.0-beta.2/release.json'],
 ['sentfromMcp','https://github.com/sentfromai/sentfromai-mcp/releases/download/v0.5.0-beta.2/release.json'],
];
const hash=data=>createHash('sha256').update(data).digest('hex');
async function publicManifest(url){
 let current=new URL(url);
 const allowed=new Set(['github.com','release-assets.githubusercontent.com']);
 for(let hop=0;hop<4;hop++){
  assert.equal(current.protocol,'https:');assert.ok(allowed.has(current.hostname));assert.ok(!current.username&&!current.password&&!current.port);
  const response=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(20000)});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');assert.ok(location);await response.body?.cancel();current=new URL(location,current);continue;
  }
  assert.equal(response.status,200,'Public release manifest unavailable');
  assert.ok(response.body);const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;assert.ok(bytes<=1024*1024,'Manifest exceeds bound');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks);
 }
 throw new Error('Too many public release redirects');
}
const published=[];
for(const [name,url] of sources){
 const bytes=await publicManifest(url);assert.equal(hash(bytes),expected.sourceManifestSha256[name],'Original public manifest changed');
 const manifest=JSON.parse(bytes);published.push(...(name==='agentlogin'?manifest.packages:[manifest]));
}
assert.equal(published.length,9);
for(const pin of expected.packages){
 const entry=published.find(p=>p.name===pin.name);assert.ok(entry);
 for(const field of ['name','version','integrity','sha256','filename'])assert.equal(entry[field],pin[field]);
}
const tracked=execFileSync('git',['ls-files','-z'],{cwd:source,encoding:'utf8'}).split('\0').filter(Boolean);
assert.ok(!tracked.includes('.npmrc'),'Consumer must not inherit project npm credentials');
for(const name of tracked){
 if(name==='package-lock.json'||name.startsWith('.github/'))continue;
 const from=resolve(source,name),to=resolve(consumer,name);
 assert.ok(!relative(source,from).startsWith('..')&&!relative(consumer,to).startsWith('..'));
 assert.ok(lstatSync(from).isFile(),'Only ordinary tracked files are copied');mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);
}
const pkg=consumerPackage(JSON.parse(readFileSync(join(consumer,'package.json'),'utf8')),expected.packages);
writeFileSync(join(consumer,'package.json'),JSON.stringify(pkg,null,2)+'\n');
writeFileSync(join(consumer,'expected-registry-release.json'),JSON.stringify(expected,null,2)+'\n');
for(const [from,to] of [['smoke.mjs','registry-smoke.mjs'],['verify-lock.mjs','scripts/verify-lock.mjs'],['distribution.test.mjs','test/distribution.test.mjs']])copyFileSync(new URL(from,import.meta.url),join(consumer,to));
const unchangedTests=tracked.filter(name=>/^test\/.*\.test\.mjs$/.test(name)&&name!=='test/distribution.test.mjs');
for(const name of unchangedTests)assert.equal(hash(readFileSync(join(source,name))),hash(readFileSync(join(consumer,name))));
const report={preparedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),sourceManifestSha256:expected.sourceManifestSha256,originalPublicManifestsVerified:true,initialCacheEmpty:true,packageCount:9,unchangedBehaviorTestFiles:unchangedTests,testAdaptation:'34 unchanged behavior/HTTP/PostgreSQL tests plus6 equivalent npm-registry distribution checks in the disposable consumer. The source runtime and original distribution tests remain unchanged.'};
writeFileSync(join(evidence,'preparation.json'),JSON.stringify(report,null,2)+'\n');
for(const [name,value] of Object.entries({consumer,cache,globalConfig,evidence})){assert.ok(!/[\r\n]/.test(value));appendFileSync(process.env.GITHUB_OUTPUT,`${name}=${value}\n`);}
console.log(JSON.stringify(report));
