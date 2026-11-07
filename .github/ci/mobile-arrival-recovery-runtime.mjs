/** Read-only lift of frozen installer contracts; NEW cleanup certificate is the only execution permission. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
export async function createCleanupReadonlyRuntime({source,selection,permission,readMetadata}){
 assert(source==='/opt/ai-hr'&&realpathSync(source)===source&&process.platform==='linux','Canonical staging only');
 const ROOT=source, BUNDLE_PYTHON_TIMEOUT_MS=600000;
 const load=name=>import(pathToFileURL(join(source,'.github/ci',name)).href);
 const {inspectCiBuildPacket}=await load('build-artifact.mjs');
 const {assertBuildRuntime,assertBuildDotenvCompileKeys,assertBuildCapacityProfile}=await load('build-production.mjs');
 const {fingerprintStagingEnvironment}=await load('staging-environment.mjs');
 const {collectMigrationLedger}=await load('staging-migration-ledger.mjs');
 const {assertServiceDescriptor}=await load('staging-build-install.mjs');
 const {installHash}=await load('ci-install-grant.mjs');
 function regular(path,max){const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&s.size>0&&s.size<=max,'Bounded owned installation file required');return readFileSync(path);}
 function privateDirectory(path){const s=lstatSync(path);assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(path)===path&&s.uid===process.getuid()&&(s.mode&0o777)===0o700,'Owned canonical0700 installation directory required');}
function runtimeContract(source,grant){
 const runtime={node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next:JSON.parse(readFileSync(join(source,'node_modules/next/package.json'))).version};
 assertBuildRuntime(runtime,process.env);assertBuildDotenvCompileKeys(source);assert(isDeepStrictEqual(runtime,grant.build.runtime),'Actual recipient runtime differs');
 assert(realpathSync(process.execPath)===realpathSync('/opt/node22/bin/node'),'Deployment and active-service Node executables must match');
 const service=execFileSync('systemctl',['show','aihr','--property=ExecStart','--value'],{encoding:'utf8',timeout:10000});
 assertServiceDescriptor(service,source);
 assert(execFileSync('systemctl',['show','aihr','--property=WorkingDirectory','--value'],{encoding:'utf8',timeout:10000}).trim()===source,'Service working directory differs');
 assert(fingerprintStagingEnvironment(source)===grant.environmentSha256,'Private deployment environment changed');
 return runtime;
}
function buildId(path){
 const value=regular(join(path,'BUILD_ID'),513).toString('utf8').trim();assert(/^[A-Za-z0-9_-]{1,512}$/.test(value),'Bounded Next build identity required');return value;
}
async function sourceContract(source,p){
 const g=p.grant,audit=p.allowCleanup&&existsSync(join(p.directory,'cleanup-authorized.json'));
 const records=audit?join(p.directory,'audit'):p.packet;
 let packet;
 if(audit){
  const authority=JSON.parse(regular(join(p.directory,'cleanup-authorized.json'),32*1024));
  assert(authority.kind==='OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL'&&authority.authorizationSha256===p.authorizationSha256
   &&authority.source===g.source&&authority.installId===g.installId&&authority.buildRecordId===g.build.buildRecordId&&authority.nextBuildId===g.build.nextBuildId,'Retained audit cleanup authority differs');
  privateDirectory(records);privateDirectory(join(records,'bytes'));
  for(const [name,key,bound]of [['system-testing.json','preparedSha256',80*1024],['successful-build.json','successfulObservationSha256',1024**2],['build-provenance.json','provenanceSha256',1024**2],['bytes/build-bundle-files.json','manifestSha256',16*1024**2]])
   assert(installHash(regular(join(records,name),bound))===g.build[key],'Retained original audit record differs: '+name);
  packet={...g.build,archiveRetained:false};
 }else{
  packet=inspectCiBuildPacket(records,{candidate:g.source,controller:g.controller,runId:g.runId,controllerBranch:g.controllerBranch,producerStartedAt:g.producerStartedAt,producerCompletedAt:g.producerCompletedAt});
  for(const key of Object.keys(g.build))assert(isDeepStrictEqual(packet[key],g.build[key]),'Authorized packet binding differs: '+key);
 }
 assert(installHash(readFileSync(join(source,'package.json')))===g.build.packageSha256&&installHash(readFileSync(join(source,'pnpm-lock.yaml')))===g.build.lockSha256,'Installed dependency inputs differ from CI');
 const imported=await import(pathToFileURL(join(source,'scripts/improve/system-testing-manifest.ts')).href),testing={...(imported.default??{}),...imported};
 const preparedBytes=regular(join(records,'system-testing.json'),80*1024),prepared=testing.parsePreparedTestingBuild(preparedBytes,{sourceRef:g.source,buildRecordId:g.build.buildRecordId});
 testing.verifyInstalledTestingBuild(prepared,source);
 return {testing,prepared,preparedBytes,packet,records};
}
function compiledContract(next,testing,prepared){
 const config=JSON.parse(regular(join(next,'required-server-files.json'),4*1024**2));
 for(const [key,value]of Object.entries(testing.systemTestingCompileEnvironment(prepared)))assert(config.config?.env?.[key]===value,'Installed compiled System Testing identity differs');
 assert(config.config.typescript.ignoreBuildErrors!==true&&config.config.experimental.useTypeScriptCli===true&&config.config.typescript.tsconfigPath==='tsconfig.build.json','CI application compiler contract differs');
}
function verifyDirectory(source,p,{active=false,records=p.packet}={}){
 const output=execFileSync('python3',[join(ROOT,'.github/ci/build-bundle.py'),active?'verify-active-directory':'verify-directory',active?join(source,'.next'):p.next,join(records,'bytes/build-bundle-files.json'),source,p.grant.build.buildSourcePath],{stdio:active?'pipe':'inherit',encoding:active?'utf8':undefined,timeout:BUNDLE_PYTHON_TIMEOUT_MS,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 if(!active)return undefined;
 const inventory=JSON.parse(output);assert(inventory.format===2,'Current compiled inventory format required');assertBuildCapacityProfile(inventory.capacityProfile);return inventory;
}
async function confirmRuntime(){
 await permission();const p=readMetadata(),g=p.grant,{source:sourceRef,installId,buildRecordId}=selection;
 const activated=JSON.parse(regular(join(p.directory,'activated.json'),1024**2));
 assert(activated.installId===installId&&activated.source===sourceRef&&activated.buildRecordId===buildRecordId&&activated.authorizationSha256===p.authorizationSha256,'Activated installation differs');
 runtimeContract(source,g);const bound=await sourceContract(source,p);
 assert(buildId(join(source,'.next'))===g.build.nextBuildId,'Active build ID differs');compiledContract(join(source,'.next'),bound.testing,bound.prepared);
 const compiledByteInventory=verifyDirectory(source,p,{active:true,records:bound.records});
 assert(activated.bootIdSha256===installHash(readFileSync('/proc/sys/kernel/random/boot_id')),'Server rebooted during installation; explicit recovery required');
 const get=property=>execFileSync('systemctl',['show','aihr','--property='+property,'--value'],{encoding:'utf8',timeout:10000}).trim();
 assert(execFileSync('systemctl',['is-active','aihr'],{encoding:'utf8',timeout:10000}).trim()==='active','Service is not active');
 const pid=get('MainPID'),started=Number(get('ExecMainStartTimestampMonotonic'));
 assert(/^[1-9][0-9]*$/.test(pid)&&Number.isSafeInteger(started)&&started>=activated.afterActivationMonotonicUs,'Service did not start after activation');
 const port=process.env.PORT??'3000';assert(/^[1-9][0-9]{0,4}$/.test(port)&&Number(port)<=65535,'Bounded service port required');
 const deadline=Date.now()+30000;let response;
 while(Date.now()<deadline){
  try{response=await fetch('http://127.0.0.1:'+port+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});if(response.status===200)break;await response.arrayBuffer();}catch{}
  await new Promise(done=>setTimeout(done,500));
 }
 assert(response?.status===200&&get('MainPID')===pid,'Restarted service health or stable PID not verified');
 const result={format:1,kind:'CI_BUILD_ACTIVE_SERVICE_VERIFIED_NOT_FULL_ARRIVAL',source:sourceRef,installId,buildRecordId,nextBuildId:g.build.nextBuildId,
  authorizationSha256:p.authorizationSha256,pid,startedMonotonicUs:started,healthStatus:200,compiledByteInventory,migrationLedger:collectMigrationLedger(source),verifiedAt:new Date().toISOString(),releaseAuthorized:false,fullSourceChecksumVerified:false,fullMigrationLedgerVerified:true};
 await permission();return result;
}

 return {audit:confirmRuntime,runtimeContract};
}
