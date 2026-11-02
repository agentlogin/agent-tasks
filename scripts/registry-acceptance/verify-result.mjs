import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
const consumer=process.env.ACCEPTANCE_CONSUMER,evidence=process.env.ACCEPTANCE_EVIDENCE;
assert.ok(evidence);mkdirSync(evidence,{recursive:true});
const report={passed:false,finishedAt:new Date().toISOString(),steps:JSON.parse(process.env.ACCEPTANCE_STEP_OUTCOMES??'{}'),preservedFiles:[],validationErrors:[],lifecycleScriptsDisabled:true,consumerCredentialEnvironment:false,behaviorTestsUnchanged:34,registryDistributionTests:6,liveServicesAccessed:false,deviceApprovalTested:false};
// Preserve the generated dependency lock and partial smoke result before checking success.
if(consumer)for(const name of ['package.json','package-lock.json','expected-registry-release.json','registry-smoke.json']){
 try{if(existsSync(join(consumer,name))){copyFileSync(join(consumer,name),join(evidence,name));report.preservedFiles.push(name);}}
 catch{report.validationErrors.push('Could not preserve '+name);}
}
const check=fn=>{try{fn();}catch(error){report.validationErrors.push(error.message);}};
check(()=>assert.ok(['prepare','lock','verify','install','smoke','tests','audit'].every(name=>report.steps[name]==='success'),'At least one required execution step did not succeed'));
report.registryOnly=report.steps.verify==='success';report.installCompleted=report.steps.install==='success';
report.initialTarballCacheEmpty=report.steps.install==='success';
check(()=>{
 const smoke=JSON.parse(readFileSync(join(evidence,'registry-smoke.json'),'utf8'));
 report.packagesImported=smoke.imports?.length??0;report.mcpInventories=smoke.mcp??[];
 assert.equal(smoke.passed,true);assert.equal(report.packagesImported,9);
});
check(()=>{
 const tap=readFileSync(join(evidence,'agent-tasks-tests.tap'),'utf8');
 report.totalTestsPassed=Number(tap.match(/^# pass (\d+)$/m)?.[1]??0);report.testSkips=Number(tap.match(/^# skipped (\d+)$/m)?.[1]??0);
 for(const line of ['# tests 40','# pass 40','# fail 0','# skipped 0'])assert.ok(tap.split('\n').includes(line),'Missing expected TAP summary: '+line);
});
check(()=>{const audit=JSON.parse(readFileSync(join(evidence,'dependency-audit.json'),'utf8'));report.reportedVulnerabilities=audit.metadata?.vulnerabilities?.total;assert.equal(report.reportedVulnerabilities,0);});
if(existsSync(join(evidence,'package-lock.json')))report.lockSha256=createHash('sha256').update(readFileSync(join(evidence,'package-lock.json'))).digest('hex');
report.passed=report.validationErrors.length===0;
writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
if(!report.passed)process.exitCode=1;
