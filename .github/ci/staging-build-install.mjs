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
import {validateInstallGrant,installJson,installHash} from './ci-install-grant.mjs';
import {inspectCiBuildPacket} from './build-artifact.mjs';
import {assertBuildRuntime,assertBuildDotenvCompileKeys} from './build-production.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
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
 save(join(p.directory,'store.json'),{format:1,installId:grant.installId,directory:identity(st)});
 mkdirSync(p.packet,{mode:0o700});
 return {installId:grant.installId,packetDirectory:p.packet,authorizationSha256:installHash(Buffer.from(installJson(grant)+'\n')),releaseAuthorized:false};
}
export function readPrivateInstall(installId,{home=homedir(),allowExpired=false}={}){
 const p=locations(installId,home);privateDirectory(p.parent);const st=privateDirectory(p.directory);
 const bytes=regular(join(p.directory,'authorization.json'),32*1024),grant=validateInstallGrant(JSON.parse(bytes),{allowExpired});
 assert(bytes.equals(Buffer.from(installJson(grant)+'\n'))&&grant.installId===installId,'Immutable canonical installation grant differs');
 const store=JSON.parse(regular(join(p.directory,'store.json'),4096));
 assert(store.installId===installId&&isDeepStrictEqual(store.directory,identity(st)),'Installation directory identity changed');
 privateDirectory(p.packet);
 return {...p,grant,authorizationSha256:installHash(bytes)};
}
function targetRoot(source=ROOT){
 source=resolve(source);assert(source==='/opt/ai-hr'&&realpathSync(source)===source&&process.platform==='linux','Installer is restricted to the existing Linux alpha/staging source');
 return source;
}
function selected(installId,sourceRef,buildRecordId){
 const p=readPrivateInstall(installId);
 assert(p.grant.source===sourceRef&&p.grant.build.buildRecordId===buildRecordId,'Selected source/record differs from installation grant');
 return p;
}
export function assertServiceDescriptor(text,source){
 const paths=[...text.matchAll(/(?:^|[;{])\s*path=([^;]+?)\s*;/g)].map(m=>m[1]);
 const argv=[...text.matchAll(/argv\[\]=([^;]+?)\s*;/g)].map(m=>m[1]);
 assert(paths.length===1&&paths[0]==='/opt/node20/bin/node'&&argv.length===1
  &&argv[0].startsWith('/opt/node20/bin/node '+source+'/node_modules/next/dist/bin/next start '),'Active service runtime/start command differs from the build contract');
 return true;
}
function runtimeContract(source,grant){
 const runtime={node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next:JSON.parse(readFileSync(join(source,'node_modules/next/package.json'))).version};
 assertBuildRuntime(runtime,process.env);assertBuildDotenvCompileKeys(source);assert(isDeepStrictEqual(runtime,grant.build.runtime),'Actual recipient runtime differs');
 assert(realpathSync(process.execPath)===realpathSync('/opt/node20/bin/node'),'Deployment and active-service Node executables must match');
 const service=execFileSync('systemctl',['show','aihr','--property=ExecStart','--value'],{encoding:'utf8',timeout:10000});
 assertServiceDescriptor(service,source);
 assert(execFileSync('systemctl',['show','aihr','--property=WorkingDirectory','--value'],{encoding:'utf8',timeout:10000}).trim()===source,'Service working directory differs');
 assert(installHash(readFileSync(join(source,'.env.production')))===grant.environmentSha256,'Private deployment environment changed');
 return runtime;
}
function buildId(path){
 const value=regular(join(path,'BUILD_ID'),513).toString('utf8').trim();assert(/^[A-Za-z0-9_-]{1,512}$/.test(value),'Bounded Next build identity required');return value;
}
async function sourceContract(source,p){
 const g=p.grant,packet=inspectCiBuildPacket(p.packet,{candidate:g.source,controller:g.controller,runId:g.runId,controllerBranch:g.controllerBranch,producerStartedAt:g.producerStartedAt,producerCompletedAt:g.producerCompletedAt});
 for(const key of Object.keys(g.build))assert(isDeepStrictEqual(packet[key],g.build[key]),'Authorized packet binding differs: '+key);
 assert(installHash(readFileSync(join(source,'package.json')))===g.build.packageSha256&&installHash(readFileSync(join(source,'pnpm-lock.yaml')))===g.build.lockSha256,'Installed dependency inputs differ from CI');
 const imported=await import(pathToFileURL(join(source,'scripts/improve/system-testing-manifest.ts')).href),testing={...(imported.default??{}),...imported};
 const preparedBytes=regular(join(p.packet,'system-testing.json'),80*1024),prepared=testing.parsePreparedTestingBuild(preparedBytes,{sourceRef:g.source,buildRecordId:g.build.buildRecordId});
 testing.verifyInstalledTestingBuild(prepared,source);
 return {testing,prepared,preparedBytes,packet};
}
function compiledContract(next,testing,prepared){
 const config=JSON.parse(regular(join(next,'required-server-files.json'),4*1024**2));
 for(const [key,value]of Object.entries(testing.systemTestingCompileEnvironment(prepared)))assert(config.config?.env?.[key]===value,'Installed compiled System Testing identity differs');
 assert(config.config.typescript.ignoreBuildErrors!==true&&config.config.experimental.useTypeScriptCli===true&&config.config.typescript.tsconfigPath==='tsconfig.build.json','CI application compiler contract differs');
}
function verifyDirectory(source,p){
 execFileSync('python3',[join(ROOT,'.github/ci/build-bundle.py'),'verify-directory',p.next,join(p.packet,'bytes/build-bundle-files.json'),source,p.grant.build.buildSourcePath],{stdio:'inherit',timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
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
 execFileSync('python3',[join(ROOT,'.github/ci/build-bundle.py'),'unpack-with-origin',join(p.packet,'bytes/build-bundle.tar.gz'),join(p.packet,'bytes/build-bundle-files.json'),p.next,source,g.build.buildSourcePath],{stdio:'inherit',timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
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
async function confirmRuntime(sourceRef,installId,buildRecordId,{persist=true}={}){
 const source=targetRoot(),p=selected(installId,sourceRef,buildRecordId),g=p.grant;
 const activated=JSON.parse(regular(join(p.directory,'activated.json'),1024**2));
 assert(activated.installId===installId&&activated.source===sourceRef&&activated.buildRecordId===buildRecordId&&activated.authorizationSha256===p.authorizationSha256,'Activated installation differs');
 runtimeContract(source,g);const bound=await sourceContract(source,p);
 assert(buildId(join(source,'.next'))===g.build.nextBuildId,'Active build ID differs');compiledContract(join(source,'.next'),bound.testing,bound.prepared);
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
  authorizationSha256:p.authorizationSha256,pid,startedMonotonicUs:started,healthStatus:200,migrationLedger:collectMigrationLedger(source),verifiedAt:new Date().toISOString(),releaseAuthorized:false,fullSourceChecksumVerified:false,fullMigrationLedgerVerified:true};
 if(persist)save(join(p.directory,'runtime.json'),result);return result;
}
async function readStatus(sourceRef,installId,buildRecordId){
 targetRoot();const p=selected(installId,sourceRef,buildRecordId);
 return {authorizationSha256:p.authorizationSha256,verified:JSON.parse(regular(join(p.directory,'verified.json'),1024**2)),
  activated:JSON.parse(regular(join(p.directory,'activated.json'),1024**2)),runtime:await confirmRuntime(sourceRef,installId,buildRecordId,{persist:false}),releaseAuthorized:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,sourceRef,installId,buildRecordId]=process.argv.slice(2);
 (async()=>{
  targetRoot();
  if(mode==='initialize'){
   assert(process.argv.length===3,'Initialization takes only bounded stdin');
   const chunks=[];let total=0;for await(const chunk of process.stdin){total+=chunk.length;assert(total<=32*1024,'Installation grant exceeds bound');chunks.push(chunk);}
   return initializePrivateInstall(JSON.parse(Buffer.concat(chunks)));
  }
  assert(process.argv.length===6&&['stage','activate','confirm-runtime','status'].includes(mode),'Exact installer mode/source/install/build record required');
  return mode==='stage'?stageCiBuild(sourceRef,installId,buildRecordId):mode==='activate'?activateCiBuild(sourceRef,installId,buildRecordId):mode==='confirm-runtime'?confirmRuntime(sourceRef,installId,buildRecordId):readStatus(sourceRef,installId,buildRecordId);
 })().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
}
