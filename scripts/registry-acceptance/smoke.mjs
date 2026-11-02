import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,lstatSync,realpathSync,mkdirSync } from 'node:fs';
import { execFileSync,spawn } from 'node:child_process';
import { join,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyLock } from './scripts/verify-lock.mjs';
const cwd=process.cwd(),read=p=>JSON.parse(readFileSync(join(cwd,p),'utf8'));
const expected=read('expected-registry-release.json'),lock=read('package-lock.json'),pkg=read('package.json');
const report={startedAt:new Date().toISOString(),passed:false,distribution:verifyLock(pkg,lock,expected),imports:[],cliHelp:[],mcp:[],liveExternalCredentialsUsed:false};
const minimalEnv={PATH:dirname(process.execPath)+':/usr/bin:/bin'};
const identityToolNames=['agentlogin_inventory','agentlogin_catalog','agentlogin_enroll','agentlogin_enrollment_status','agentlogin_sign_in','agentlogin_status','agentlogin_review','agentlogin_request','agentlogin_logout'].sort();
const mailToolNames=['create_inbox','list_inboxes','delete_inbox','send_message','reply_to_message','forward_message','get_message','search_messages','list_threads','get_thread','create_draft','send_draft','list_drafts','add_domain','get_domain','create_webhook','list_webhooks','delete_webhook','add_address_rule','list_address_rules','delete_address_rule'].sort();
const agentIdToolNames=['agentid_inventory','agentid_list_apps','agentid_get_app','agentid_connect','agentid_key_status','agentid_accounts'].sort();
function resultData(result){assert.ok(Array.isArray(result.content)&&result.content[0]?.type==='text');const data=JSON.parse(result.content[0].text);if(result.structuredContent!==undefined)assert.deepEqual(data,result.structuredContent);return data;}
function command(entry,args=[],env={}){return execFileSync(process.execPath,[entry,...args],{cwd,env:{...minimalEnv,...env},encoding:'utf8',timeout:15000,maxBuffer:512000,stdio:['ignore','pipe','pipe']});}
async function inspect(entry,env,{protocolVersion='2025-06-18',call}={}){
 const modern=protocolVersion==='2026-07-28';
 const child=spawn(process.execPath,[entry],{cwd,env:{...minimalEnv,...env},stdio:['pipe','pipe','pipe']});
 let stderr='',pending='',bytes=0,resolveDone,rejectDone;const results=new Map();
 const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
 const timer=setTimeout(()=>rejectDone(new Error('MCP handshake timed out')),12000);
 const send=message=>{
  if(modern)message={...message,params:{...message.params,_meta:{'io.modelcontextprotocol/protocolVersion':protocolVersion,'io.modelcontextprotocol/clientInfo':{name:'npm-registry-acceptance',version:'1.0.0'},'io.modelcontextprotocol/clientCapabilities':{}}}};
  child.stdin.write(JSON.stringify(message)+'\n');
 };
 child.stderr.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>65536)rejectDone(new Error('MCP stderr exceeded bound'));});
 child.on('error',rejectDone);child.on('exit',code=>{if(!results.has(call?3:2))rejectDone(new Error('MCP exited before response '+code));});
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024){rejectDone(new Error('MCP output exceeded bound'));return;}pending+=chunk;let newline;
  while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);
   try{const message=JSON.parse(line);if(!message.id)continue;assert.equal(message.error,undefined);if(modern)assert.equal(message.result.resultType,'complete');results.set(message.id,message.result);
    if(message.id===1){
     if(modern){assert.ok(message.result.supportedVersions.includes(protocolVersion));results.set(1,{protocolVersion,serverInfo:message.result._meta['io.modelcontextprotocol/serverInfo'],modernDiscovery:true});}
     else{assert.equal(message.result.protocolVersion,protocolVersion);send({jsonrpc:'2.0',method:'notifications/initialized'});}
     send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
    }
    else if(message.id===2&&call)send({jsonrpc:'2.0',id:3,method:'tools/call',params:call});
    else resolveDone({initialized:results.get(1),tools:results.get(2).tools,called:results.get(3),stderr});
   }catch(error){rejectDone(error);}
  }
 });
 if(modern)send({jsonrpc:'2.0',id:1,method:'server/discover',params:{}});
 else send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion,capabilities:{},clientInfo:{name:'npm-registry-acceptance',version:'1.0.0'}}});
 try{return await done;}finally{clearTimeout(timer);child.stdin.end();child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),2000);await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));clearTimeout(kill);}
}
try{
 for(const pin of expected.packages){
  const path=join(cwd,'node_modules',pin.name);assert.ok(!lstatSync(path).isSymbolicLink());assert.ok(realpathSync(path).startsWith(join(cwd,'node_modules')+'/'));
  const installed=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));assert.equal(installed.version,pin.version);
  await import(pin.name);report.imports.push({name:pin.name,version:installed.version,integrityMatched:true});
  if(pin.name!=='sentfromai-mcp')for(const [name,file] of Object.entries(installed.bin??{})){assert.match(command(join(path,file),['--help']),/usage|agentlogin|agentid/i);report.cliHelp.push(name);}
 }
 const state=join(cwd,'synthetic-private-state');mkdirSync(state,{mode:0o700});
 const config=read('node_modules/@agentlogin/mcp/examples/config.json');config.stateDirectory=state;
 const configPath=join(cwd,'synthetic-agentlogin.json');writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
 const mail=await inspect(join(cwd,'node_modules/sentfromai-mcp/server.js'),{SENTFROMAI_API_KEY:'registry-acceptance-secret-canary',SENTFROMAI_BASE_URL:'http://127.0.0.1:9'},{call:{name:'list_inboxes',arguments:{}}});
 assert.deepEqual(mail.tools.map(t=>t.name).sort(),mailToolNames);assert.equal(mail.initialized.serverInfo.version,'0.5.0-beta.1');assert.equal(mail.called.isError,true);assert.ok(!JSON.stringify(mail).includes('registry-acceptance-secret-canary'));
 report.mcp.push({entry:'sentfromai-mcp',tools:21,protocol:mail.initialized.protocolVersion,unreachableLoopbackFailureDoesNotExposeCredential:true,httpUnauthorizedResponseTested:false});
 for(const protocolVersion of ['2025-06-18','2026-07-28']){
  const identity=await inspect(join(cwd,'node_modules/sentfromai-mcp/identity-server.js'),{AGENTLOGIN_MCP_CONFIG:configPath},{protocolVersion,call:{name:'agentlogin_inventory',arguments:{}}});
  assert.deepEqual(identity.tools.map(t=>t.name).sort(),identityToolNames);assert.equal(identity.initialized.serverInfo.version,'0.2.0-beta.1');assert.equal(identity.initialized.protocolVersion,protocolVersion);assert.notEqual(identity.called.isError,true);
  const inventory=resultData(identity.called);assert.deepEqual(inventory.identities,[{id:'scout',handle:'scout@example.com',enrollmentAvailable:true}]);assert.equal(inventory.applications.length,1);assert.equal(inventory.applications[0].id,'notes');assert.equal(inventory.applications[0].origin,'https://notes.example');assert.deepEqual(inventory.applications[0].operations.map(o=>o.name).sort(),['list_notes','save_note']);assert.equal(inventory.sessionLocation,'local_helper');assert.equal(inventory.browserSession,false);
  assert.ok(!/privateJwk|polling_token/.test(JSON.stringify(identity.called)));report.mcp.push({entry:'sentfromai-mcp identity wrapper',tools:9,protocol:protocolVersion,wireMode:identity.initialized.modernDiscovery?'modern-request-metadata':'legacy-initialize',syntheticInventory:true});
 }
 const idConfig=join(cwd,'synthetic-agentid.json');writeFileSync(idConfig,JSON.stringify(read('node_modules/@agentlogin/agentid-mcp/examples/config.json')),{mode:0o600});
 const agentid=await inspect(join(cwd,'node_modules/@agentlogin/agentid-mcp/bin/agentid-signin-mcp.js'),{AGENTID_MCP_CONFIG:idConfig},{protocolVersion:'2026-07-28',call:{name:'agentid_inventory',arguments:{}}});
 assert.deepEqual(agentid.tools.map(t=>t.name).sort(),agentIdToolNames);assert.notEqual(agentid.called.isError,true);const agentIdInventory=resultData(agentid.called);assert.equal(agentIdInventory.inbox,'your-agent@agentmail.to');assert.deepEqual(agentIdInventory.applications,[]);assert.equal(agentIdInventory.provider,'AgentID by AgentMail');assert.equal(agentIdInventory.protocol,'agentid_oidc');assert.equal(agentIdInventory.completedApplicationLogin,false);assert.equal(agentIdInventory.browserCompletionRequired,true);report.mcp.push({entry:'@agentlogin/agentid-mcp',tools:6,protocol:agentid.initialized.protocolVersion,wireMode:'modern-request-metadata',syntheticInventory:true,liveAgentMailSignIn:false});
 report.lockSha256=createHash('sha256').update(readFileSync(join(cwd,'package-lock.json'))).digest('hex');report.passed=true;
}catch(error){report.errorType=error.name;report.error=error.message;process.exitCode=1;}
report.finishedAt=new Date().toISOString();writeFileSync(join(cwd,'registry-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
