/** Staging-only private CI build installer. Invoked by the deployment owner, never by a web route. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,lstatSync,readFileSync,writeFileSync,realpathSync,existsSync,openSync,closeSync,fsyncSync,statfsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {brotliDecompressSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {collectMigrationLedger} from './staging-migration-ledger.mjs';
import {fingerprintStagingEnvironment} from './staging-environment.mjs';
import {runNormalCleanupSession,RESULT_KIND} from './normal-cleanup-session.mjs';
import {durableCleanupRecord,acquireNormalCleanupLock,readSingleCleanupCommit} from './normal-cleanup-io.mjs';
import {captureNormalCleanupFences,canonicalSourceExclusions} from './normal-cleanup-fences.mjs';
import {validateCleanupRequest} from './staging-cleanup-protocol.mjs';
import {validateInstallGrant,installJson,installHash} from './ci-install-grant.mjs';
import {inspectCiBuildPacket} from './build-artifact.mjs';
import {assertBuildRuntime,assertBuildDotenvCompileKeys} from './build-production.mjs';
import {guardServerCli,COORDINATOR} from '../../scripts/staging/lease.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
// Hashing or unpacking the ~850 MB build bundle on the 4 GB staging host exceeded 120 s under host load (wave 1b,
// 29 Oct 2026). Each call stays well inside release.ts's 60-minute deploy deadline, even across the three verifications.
export const BUNDLE_PYTHON_TIMEOUT_MS=600000;
const id=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const identity=st=>({device:st.dev,inode:st.ino});
function privateDirectory(path,create=false){
 if(create&&!existsSync(path))mkdirSync(path,{mode:0o700});
 const st=lstatSync(path);
 assert(st.isDirectory()&&!st.isSymbolicLink()&&realpathSync(path)===path&&st.uid===process.getuid()&&(st.mode&0o777)===0o700,'Owned canonical0700 installation directory required');
 return st;
}
function regular(path,max){
 const st=lstatSync(path);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&st.size>0&&st.size<=max,'Bounded owned installation file required');
 return readFileSync(path);
}
function publish(path,bytes){
 const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
const save=(path,value)=>publish(path,Buffer.from(installJson(value)+'\n'));
function locations(installId,home=homedir()){
 assert(id(installId),'Exact installation UUID required');
 const parent=join(realpathSync(home),'.aihr-ci-builds'),directory=join(parent,installId);
 return {parent,directory,packet:join(directory,'packet'),next:join(directory,'next')};
}
/** Initialization is independently testable on private fixtures. CLI always binds the live staging root. */
export function initializePrivateInstall(grant,{home=homedir()}={}){
 validateInstallGrant(grant);
 const p=locations(grant.installId,home);privateDirectory(p.parent,true);
 // A fresh attempt has a fresh installId while retaining the original baked buildRecordId.
 mkdirSync(p.directory,{mode:0o700});const st=privateDirectory(p.directory);
 save(join(p.directory,'authorization.json'),grant);
 mkdirSync(p.packet,{mode:0o700});
 save(join(p.directory,'store.json'),{format:1,installId:grant.installId,directory:identity(st),packetDirectory:identity(lstatSync(p.packet))});
 return {installId:grant.installId,packetDirectory:p.packet,authorizationSha256:installHash(Buffer.from(installJson(grant)+'\n')),releaseAuthorized:false};
}
export function readPrivateInstall(installId,{home=homedir(),allowExpired=false,allowCleanup=false}={}){
 const p=locations(installId,home);privateDirectory(p.parent);const st=privateDirectory(p.directory);
 const bytes=regular(join(p.directory,'authorization.json'),32*1024),grant=validateInstallGrant(JSON.parse(bytes),{allowExpired});
 assert(bytes.equals(Buffer.from(installJson(grant)+'\n'))&&grant.installId===installId,'Immutable canonical installation grant differs');
 const store=JSON.parse(regular(join(p.directory,'store.json'),4096));
 assert(store.installId===installId&&isDeepStrictEqual(store.directory,identity(st)),'Installation directory identity changed');
 let packetStat;try{packetStat=lstatSync(p.packet);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(packetStat){privateDirectory(p.packet);assert(isDeepStrictEqual(store.packetDirectory,identity(packetStat)),'Private packet directory identity changed');}
 else{assert(allowCleanup,'Original packet missing before authorized cleanup');const authority=JSON.parse(regular(join(p.directory,'cleanup-authorized.json'),32*1024));assert(authority.kind==='OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL'&&authority.authorizationSha256===installHash(bytes)&&authority.installId===installId&&authority.source===grant.source&&authority.buildRecordId===grant.build.buildRecordId&&authority.nextBuildId===grant.build.nextBuildId&&isDeepStrictEqual(authority.directory,identity(st)),'Missing packet has no matching cleanup authority');}
 return {...p,grant,authorizationSha256:installHash(bytes),allowCleanup};
}
function targetRoot(source=ROOT){
 source=resolve(source);assert(source==='/opt/ai-hr'&&realpathSync(source)===source&&process.platform==='linux','Installer is restricted to the existing Linux alpha/staging source');
 return source;
}
function selected(installId,sourceRef,buildRecordId,{allowCleanup=false}={}){
 const p=readPrivateInstall(installId,{allowCleanup});
 assert(p.grant.source===sourceRef&&p.grant.build.buildRecordId===buildRecordId,'Selected source/record differs from installation grant');
 return p;
}
export function assertServiceDescriptor(text,source){
 const paths=[...text.matchAll(/(?:^|[;{])\s*path=([^;]+?)\s*;/g)].map(m=>m[1]);
 const argv=[...text.matchAll(/argv\[\]=([^;]+?)\s*;/g)].map(m=>m[1]);
 assert(paths.length===1&&paths[0]==='/opt/node22/bin/node'&&argv.length===1
  &&argv[0].startsWith('/opt/node22/bin/node '+source+'/node_modules/next/dist/bin/next start '),'Active service runtime/start command differs from the build contract');
 return true;
}
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
 return active?JSON.parse(output):undefined;
}
async function nativeContract(source,p){
 const require=createRequire(join(source,'package.json')),manifest=JSON.parse(regular(join(p.packet,'bytes/build-bundle-files.json'),16*1024**2));
 const alias=name=>join(p.next,manifest.aliases.find(a=>a.package===name).path);
 const sharp=require(alias('sharp')),fontkit=require(alias('fontkit'));
 const pixels=Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
 const png=await sharp(pixels,{raw:{width:2,height:2,channels:4}}).png().toBuffer();
 const webp=await sharp(png).webp({lossless:true}).toBuffer(),decoded=await sharp(webp).ensureAlpha().raw().toBuffer();
 assert(decoded.equals(pixels),'Recipient native Sharp codec roundtrip differs');
 const face=fontkit.create(brotliDecompressSync(readFileSync(join(source,'assets/fonts/NotoSansSC-Regular.otf.br'))));
 for(const ch of '实发工资 Aisyah Rahman 實發工資')if(ch!==' ')assert(face.glyphForCodePoint(ch.codePointAt(0)).id!==0,'Recipient CJK glyph missing');
 return {sharp:sharp.versions.sharp,vips:sharp.versions.vips,pngSha256:installHash(png),webpSha256:installHash(webp),losslessPixels:true,cjkGlyphsPresent:true};
}
async function preserveOriginalRecord(p,{testing,prepared,preparedBytes}){
 const directory=testing.systemTestingBuildDirectory('remote');testing.ensurePrivateReleaseDirectory(directory);
 const buildDirectory=join(directory,p.grant.build.buildRecordId);
 if(!existsSync(buildDirectory))testing.publishSystemTestingBuild(prepared,directory);
 const existing=testing.readPublishedTestingBuild(directory,{sourceRef:p.grant.source,buildRecordId:p.grant.build.buildRecordId});
 assert(existing.bytes.equals(preparedBytes),'Existing owned build record differs from CI');
 const observation=regular(join(p.packet,'successful-build.json'),1024**2),path=join(buildDirectory,'successful-build.json');
 // Retain ORIGINAL CI observation bytes/timestamps; never fabricate a new server build.
 if(existsSync(path))assert(regular(path,1024**2).equals(observation),'Existing successful observation differs from CI');else publish(path,observation);
 const origin=join(buildDirectory,'ci-build-origin.json');
 const bytes=regular(join(p.packet,'build-provenance.json'),1024**2);
 if(existsSync(origin))assert(regular(origin,1024**2).equals(bytes),'Existing CI build origin differs');else publish(origin,bytes);
}
export async function stageCiBuild(sourceRef,installId,buildRecordId){
 const source=targetRoot(),p=selected(installId,sourceRef,buildRecordId),g=p.grant;
 runtimeContract(source,g);
 assert(buildId(join(source,'.next'))===g.baselineBuildId,'Staging baseline build moved');
 assert(lstatSync(p.directory).dev===lstatSync(source).dev,'Private stage and runtime must share a filesystem');
 // Permission query only. Refuse before migration/activation if restart is not authorized.
 execFileSync('sudo',['-n','-l','/usr/bin/systemctl','restart','aihr'],{stdio:'pipe',timeout:10000});
 const bound=await sourceContract(source,p);
 const manifest=JSON.parse(regular(join(p.packet,'bytes/build-bundle-files.json'),16*1024**2)),space=statfsSync(p.directory);
 assert(Number.isSafeInteger(manifest.unpackedBytes)&&manifest.unpackedBytes>0&&manifest.unpackedBytes<=2*1024**3&&space.bavail*space.bsize>=manifest.unpackedBytes+2*1024**3,'Insufficient actual same-filesystem staging headroom');
 execFileSync('python3',[join(ROOT,'.github/ci/build-bundle.py'),'unpack-with-origin',join(p.packet,'bytes/build-bundle.tar.gz'),join(p.packet,'bytes/build-bundle-files.json'),p.next,source,g.build.buildSourcePath],{stdio:'inherit',timeout:BUNDLE_PYTHON_TIMEOUT_MS,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert(buildId(p.next)===g.build.nextBuildId,'Unpacked Next build identity differs');
 compiledContract(p.next,bound.testing,bound.prepared);
 const native=await nativeContract(source,p);
 verifyDirectory(source,p);runtimeContract(source,g);await sourceContract(source,p);
 await preserveOriginalRecord(p,bound);
 const result={format:1,kind:'CI_BUILD_STAGED_AND_VERIFIED_NOT_ACTIVE',source:g.source,installId,buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256:p.authorizationSha256,
  stagedDirectory:identity(lstatSync(p.next)),native,verifiedAt:new Date().toISOString(),releaseAuthorized:false,activeServiceVerified:false};
 save(join(p.directory,'verified.json'),result);return result;
}
export async function activateCiBuild(sourceRef,installId,buildRecordId){
 const source=targetRoot(),p=selected(installId,sourceRef,buildRecordId),g=p.grant;
 const verified=JSON.parse(regular(join(p.directory,'verified.json'),1024**2));
 assert(verified.source===g.source&&verified.installId===installId&&verified.buildRecordId===buildRecordId&&verified.nextBuildId===g.build.nextBuildId
  &&verified.authorizationSha256===p.authorizationSha256&&isDeepStrictEqual(verified.stagedDirectory,identity(lstatSync(p.next))),'Verified staged directory changed');
 runtimeContract(source,g);const bound=await sourceContract(source,p);
 assert(buildId(join(source,'.next'))===g.baselineBuildId&&buildId(p.next)===g.build.nextBuildId,'Expected baseline/new build moved');
 verifyDirectory(source,p);compiledContract(p.next,bound.testing,bound.prepared);
 const migrationLedger=collectMigrationLedger(source);
 const before=Number(readFileSync('/proc/uptime','utf8').split(' ')[0])*1000000;
 const text=execFileSync('python3',[join(ROOT,'.github/ci/build-activate.py'),'activate',p.next,source,g.build.nextBuildId,g.baselineBuildId],{encoding:'utf8',timeout:15000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 const activation=JSON.parse(text);
 assert(activation.activeBuildId===g.build.nextBuildId&&activation.retainedBuildId===g.baselineBuildId,'Atomic exchange result differs');
 const result={format:1,kind:'CI_BUILD_BYTES_ACTIVATED_NOT_FULL_ARRIVAL',source:g.source,installId,buildRecordId,nextBuildId:g.build.nextBuildId,
  authorizationSha256:p.authorizationSha256,activation,migrationLedger,afterActivationMonotonicUs:Math.max(before,Number(readFileSync('/proc/uptime','utf8').split(' ')[0])*1000000),
  bootIdSha256:installHash(readFileSync('/proc/sys/kernel/random/boot_id')),activatedAt:new Date().toISOString(),releaseAuthorized:false,activeServiceVerified:false};
 save(join(p.directory,'activated.json'),result);return result;
}
async function confirmRuntime(sourceRef,installId,buildRecordId,{persist=true,allowCleanup=false}={}){
 const source=targetRoot(),p=selected(installId,sourceRef,buildRecordId,{allowCleanup}),g=p.grant;
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
 if(persist)save(join(p.directory,'runtime.json'),result);return result;
}
async function readStatus(sourceRef,installId,buildRecordId){
 targetRoot();const p=selected(installId,sourceRef,buildRecordId,{allowCleanup:true});
 return {authorizationSha256:p.authorizationSha256,verified:JSON.parse(regular(join(p.directory,'verified.json'),1024**2)),
  activated:JSON.parse(regular(join(p.directory,'activated.json'),1024**2)),runtime:await confirmRuntime(sourceRef,installId,buildRecordId,{persist:false,allowCleanup:true}),releaseAuthorized:false};
}
export async function withNormalCleanupLock(directory,selection,operation){
 const release=acquireNormalCleanupLock(join(directory,'normal-cleanup.lock'),selection);
 try{return await operation();}finally{release();}
}
export async function cleanupCiBuild(sourceRef,installId,buildRecordId,request){
 const p=selected(installId,sourceRef,buildRecordId,{allowCleanup:true});
 return withNormalCleanupLock(p.directory,{source:sourceRef,installId,pid:process.pid},async()=>{
  assert(!['ready','commit','consumed'].some(name=>existsSync(join(p.directory,'normal-cleanup-'+name+'.json'))),'Interrupted normal session requires explicit recovery');
  return cleanupCiBuildLocked(sourceRef,installId,buildRecordId,request);
 });
}
async function cleanupCiBuildLocked(sourceRef,installId,buildRecordId,request){
 const source=targetRoot(),p=selected(installId,sourceRef,buildRecordId,{allowCleanup:true}),g=p.grant;
 validateCleanupRequest(request,g);
 await confirmRuntime(sourceRef,installId,buildRecordId,{persist:false,allowCleanup:true});
 const activated=JSON.parse(regular(join(p.directory,'activated.json'),1024**2));
 retainNormalCleanupAudit(p,activated);
 const authorityPath=join(p.directory,'cleanup-authorized.json');
 if(!existsSync(authorityPath))durableCleanupRecord(authorityPath,normalCleanupAuthority(source,p,activated,request));
 // Reopen every retained digest before deletion (also covers an interrupted audit copy or retry).
 await sourceContract(source,p);validateCleanupRequest(request,g);
 const cleanup=JSON.parse(execFileSync('python3',[join(ROOT,'.github/ci/cleanup-install.py'),p.directory],{encoding:'utf8',timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
 assert(cleanup.kind==='OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED'&&cleanup.authorizationSha256===p.authorizationSha256
  &&cleanup.installId===installId&&cleanup.source===sourceRef&&cleanup.nextBuildId===g.build.nextBuildId&&isDeepStrictEqual(cleanup.verifiedAbsent,['next','packet']),'Owned cleanup result differs');
 // This rechecks the real active compiled inventory, environment, service PID, health and ledger
 // after the old bytes are gone. Original CI origin is read from the retained audit, never relabelled.
 const after=await confirmRuntime(sourceRef,installId,buildRecordId,{persist:false,allowCleanup:true});
 return {format:1,kind:'CI_INSTALL_OWNED_CLEANUP_AND_FINAL_RUNTIME_VERIFIED',source:sourceRef,installId,buildRecordId,nextBuildId:g.build.nextBuildId,
  authorizationSha256:p.authorizationSha256,cleanup,runtime:after,ownedResourceCleanupVerified:true,releaseHandbackVerified:false};
}


function normalCleanupAuthority(source,p,activated,request){
 const g=p.grant;return {format:1,kind:'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL',sourceDirectory:source,source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,
  authorizationSha256:p.authorizationSha256,witnessFingerprint:g.witnessFingerprint,directory:identity(lstatSync(p.directory)),activeDirectory:activated.activation.activeDirectory,
  retainedDirectory:activated.activation.retainedDirectory,packetDirectory:identity(lstatSync(p.packet)),sourceProof:request,sourceProofSha256:installHash(installJson(request)),authorizedAt:new Date().toISOString()};
}
export function retainNormalCleanupAudit(p,activated){
 const g=p.grant;
 const audit=join(p.directory,'audit');if(!existsSync(audit))mkdirSync(audit,{mode:0o700});privateDirectory(audit);
 if(!existsSync(join(audit,'bytes')))mkdirSync(join(audit,'bytes'),{mode:0o700});privateDirectory(join(audit,'bytes'));
 if(!existsSync(join(p.directory,'cleanup-authorized.json'))){
  // Both original trees must be present on first authorization. Retry audit state is enabled only
  // by this immutable record, after every original audit byte has been retained.
  privateDirectory(p.packet);
  assert(isDeepStrictEqual(identity(lstatSync(p.next)),activated.activation.retainedDirectory)&&buildId(p.next)===g.baselineBuildId,'Expected owned previous build required before cleanup authorization');
  for(const [name,bound]of [['system-testing.json',80*1024],['successful-build.json',1024**2],['build-provenance.json',1024**2],['bytes/build-bundle-files.json',16*1024**2]]){
   const bytes=regular(join(p.packet,name),bound),path=join(audit,name);
   if(existsSync(path))assert(regular(path,bound).equals(bytes),'Existing original audit record differs');else{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}const directory=openSync(join(path,'..'),'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
  }
 }
 for(const folder of [join(p.directory,'audit/bytes'),join(p.directory,'audit'),p.directory]){const fd=openSync(folder,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
}

export async function cleanupCiBuildSession(sourceRef,installId,buildRecordId){
 const source=targetRoot(),p=selected(installId,sourceRef,buildRecordId),g=p.grant;
 assert(!existsSync(join(p.directory,'cleanup-authorized.json'))&&!existsSync(join(p.directory,'normal-cleanup-consumed.json')),'Prior cleanup attempt requires explicit recovery');
 return withNormalCleanupLock(p.directory,{source:sourceRef,installId,pid:process.pid},async()=>{
  assert(!existsSync(join(p.directory,'cleanup-authorized.json'))&&!existsSync(join(p.directory,'normal-cleanup-consumed.json')),'Concurrent cleanup attempt requires explicit recovery');
  const activated=JSON.parse(regular(join(p.directory,'activated.json'),1024**2));
  const official=await import(pathToFileURL(join(source,'scripts/improve/release.ts')).href),exclude=canonicalSourceExclusions((official.deploymentRsyncArgs??official.default?.deploymentRsyncArgs)(source));
  let expectedAuthority=null;
  const recordNames=['authorization.json','store.json','verified.json','activated.json','audit/system-testing.json','audit/successful-build.json','audit/build-provenance.json','audit/bytes/build-bundle-files.json'];
  const show=name=>execFileSync('systemctl',['show','aihr','--property='+name,'--value'],{encoding:'utf8',timeout:3000}).trim();
  const fences=()=>captureNormalCleanupFences({source,p,activated,exclude,recordNames,ports:{
   authority:async()=>{const current=selected(installId,sourceRef,buildRecordId);assert(current.authorizationSha256===p.authorizationSha256,'Original grant changed');if(expectedAuthority)assert(regular(join(p.directory,'cleanup-authorized.json'),32768).equals(Buffer.from(installJson(expectedAuthority)+'\n')),'Cleanup authority changed');},
   lease:async()=>guardServerCli(sourceRef),leaseIdentity:async()=>({batch:process.env.AIHR_STAGING_BATCH,epoch:process.env.AIHR_STAGING_EPOCH}),
   runtime:async()=>{runtimeContract(source,g);assert(buildId(join(source,'.next'))===g.build.nextBuildId,'Active build changed');},
   service:async()=>({pid:show('MainPID'),started:show('ExecMainStartTimestampMonotonic'),active:execFileSync('systemctl',['is-active','aihr'],{encoding:'utf8',timeout:3000}).trim()==='active'}),
   boot:async()=>installHash(readFileSync('/proc/sys/kernel/random/boot_id')),environment:async()=>fingerprintStagingEnvironment(source),ledger:async()=>collectMigrationLedger(source),
   health:async()=>{const response=await fetch('http://127.0.0.1:'+(process.env.PORT??'3000')+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});await response.arrayBuffer();return response.status;}
  }});
  const {cleanup,runtime}=await runNormalCleanupSession({grant:g,
   retainAudit:async()=>{retainNormalCleanupAudit(p,activated);for(const folder of [join(p.directory,'audit/bytes'),join(p.directory,'audit'),p.directory]){const fd=openSync(folder,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}},
   audit:()=>confirmRuntime(sourceRef,installId,buildRecordId,{persist:false,allowCleanup:true}),fences,
   persist:async(name,value)=>durableCleanupRecord(join(p.directory,'normal-cleanup-'+name+'.json'),value),
   consume:async ready=>durableCleanupRecord(join(p.directory,'normal-cleanup-consumed.json'),{kind:'NORMAL_CLEANUP_NONCE_CONSUMED',readySha256:installHash(installJson(ready))}),
   authorize:async request=>{
 const authority=normalCleanupAuthority(source,p,activated,request);
 durableCleanupRecord(join(p.directory,'cleanup-authorized.json'),authority);expectedAuthority=authority;
   },
   removeOwned:async()=>JSON.parse(execFileSync('python3',[join(ROOT,'.github/ci/cleanup-install.py'),p.directory],{encoding:'utf8',timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})),
   io:{ready:async ready=>{process.stdout.write(installJson(ready)+'\n');},commit:()=>readSingleCleanupCommit(process.stdin)}});
  assert(cleanup.kind==='OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED'&&cleanup.authorizationSha256===p.authorizationSha256&&cleanup.source===sourceRef&&cleanup.installId===installId&&cleanup.nextBuildId===g.build.nextBuildId&&cleanup.auditEvidenceRetained===true&&isDeepStrictEqual(cleanup.verifiedAbsent,['next','packet']),'Owned cleanup result differs');
  return {format:1,kind:RESULT_KIND,result:{format:1,kind:'CI_INSTALL_OWNED_CLEANUP_AND_FINAL_RUNTIME_VERIFIED',source:sourceRef,installId,buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256:p.authorizationSha256,cleanup,runtime,ownedResourceCleanupVerified:true,releaseHandbackVerified:false}};
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,sourceRef,installId,buildRecordId]=process.argv.slice(2);
 guardServerCli(mode==='initialize'?process.env.AIHR_STAGING_CANDIDATE:sourceRef);
 (async()=>{
  targetRoot();
  if(mode==='initialize'){
   assert(process.argv.length===3,'Initialization takes only bounded stdin');
   const chunks=[];let total=0;for await(const chunk of process.stdin){total+=chunk.length;assert(total<=32*1024,'Installation grant exceeds bound');chunks.push(chunk);}
   const grant=JSON.parse(Buffer.concat(chunks));
   if(existsSync(COORDINATOR))assert(grant.source===process.env.AIHR_STAGING_CANDIDATE,'Installation source differs from lease');
   return initializePrivateInstall(grant);
  }
  assert(process.argv.length===6&&['stage','activate','confirm-runtime','status','cleanup','cleanup-session'].includes(mode),'Exact installer mode/source/install/build record required');
  if(mode==='cleanup-session')return cleanupCiBuildSession(sourceRef,installId,buildRecordId);
  if(mode==='cleanup'){const chunks=[];let total=0;for await(const chunk of process.stdin){total+=chunk.length;assert(total<=32*1024,'Cleanup proof exceeds bound');chunks.push(chunk);}return cleanupCiBuild(sourceRef,installId,buildRecordId,JSON.parse(Buffer.concat(chunks)));}
  return mode==='stage'?stageCiBuild(sourceRef,installId,buildRecordId):mode==='activate'?activateCiBuild(sourceRef,installId,buildRecordId):mode==='confirm-runtime'?confirmRuntime(sourceRef,installId,buildRecordId):readStatus(sourceRef,installId,buildRecordId);
 })().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
}
