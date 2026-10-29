/** Human-operated cleanup recovery only. Never installs, builds, migrates, restarts or changes source.
 * A completed installation's expired grant remains immutable historical evidence. A separately
 * authenticated, short-lived cleanup capability permits only its original next/packet children.
 * Expensive full observations happen before the fresh 60-second deletion checkpoint and again after.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,realpathSync,existsSync,openSync,closeSync,fsyncSync,constants} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validateCleanupRequest} from '../../.github/ci/staging-cleanup-protocol.mjs';
import {validateInstallGrant,installHash,installJson} from '../../.github/ci/ci-install-grant.mjs';

const SOURCE='/opt/ai-hr';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>assert(v&&isDeepStrictEqual(Object.keys(v).sort(),keys.slice().sort()),'Exact recovery record shape required');
const time=v=>{const n=Date.parse(v);assert(Number.isFinite(n),'Finite observation time required');return n;};
export function assertFreshObservation(value,now=Date.now()){
 const at=time(value);assert(at<=now+60000&&now-at<=60000,'Genuine observation must be fresh at deletion');return at;
}
export function validateRecoveryAuthorization(a,g,{now=Date.now(),initial=false}={}){
 // This does NOT renew a grant or make it valid for installation. Its original bounded metadata
 // is checked, including its original 30-minute expiry. Recovery has a distinct cleanup-only scope.
 validateInstallGrant(g,{now,allowExpired:true});
 exact(a,['format','kind','policy','scope','source','installId','buildRecordId','nextBuildId','grantSha256','helperSource','helperSha256','originalCi','helperCi','issuedAt','expiresAt']);
 assert(a.format===1&&a.kind==='OWNER_AUTHORIZED_COMPLETED_INSTALL_CLEANUP_RECOVERY'&&a.policy==='aihr-owned-cleanup-recovery/v1'&&a.scope==='original-next-and-packet-only','Cleanup-only owner authority required');
 assert(a.source===g.source&&a.installId===g.installId&&a.buildRecordId===g.build.buildRecordId&&a.nextBuildId===g.build.nextBuildId&&a.grantSha256===installHash(Buffer.from(installJson(g)+'\n')),'Original installation tuple differs');
 assert(sha(a.helperSource)&&digest(a.helperSha256),'Reviewed helper identity required');
 for(const c of [a.originalCi,a.helperCi]){
  exact(c,['result','tier','source','controller','runId','fingerprint','createdAt','revalidatedAt']);
  assert(c.result==='PASS'&&c.tier==='ci'&&sha(c.source)&&sha(c.controller)&&Number.isSafeInteger(c.runId)&&c.runId>0&&digest(c.fingerprint),'Authenticated complete CI evidence required');
  const created=time(c.createdAt),checked=time(c.revalidatedAt);assert(created<=checked&&checked<=now+60000&&now-created<=86400000,'Original and helper CI must remain within their 24-hour lifetime');
  if(initial)assertFreshObservation(c.revalidatedAt,now);
 }
 assert(a.originalCi.source===g.source&&a.originalCi.controller===g.controller&&a.originalCi.runId===g.runId&&a.originalCi.fingerprint===g.witnessFingerprint&&a.originalCi.createdAt===g.runCreatedAt,'Original CI cannot be relabelled');
 assert(a.helperCi.source===a.helperSource,'Helper gate must identify its actual source');
 const issued=time(a.issuedAt),expires=time(a.expiresAt);
 assert(issued<=now+60000&&expires>now&&expires>issued&&expires<=issued+30*60000&&expires<=time(a.originalCi.createdAt)+86400000&&expires<=time(a.helperCi.createdAt)+86400000,'Bounded recovery capability required');
 for(const c of [a.originalCi,a.helperCi])assert(Math.abs(time(c.revalidatedAt)-issued)<=60000,'Recovery must be issued from newly revalidated CI');
 return a;
}
export function validateRecoveryCommit(a,g,prepared,proof,{now=Date.now()}={}){
 validateRecoveryAuthorization(a,g,{now});
 exact(proof,['kind','source','output','checkedAt']);
 assert(proof.kind==='ACTUAL_CANONICAL_RSYNC_ZERO_CHECKSUM'&&proof.source===g.source&&proof.output==='','Actual zero-output canonical checksum required');
 assert(prepared?.kind==='FULL_RUNTIME_PREPARED_FOR_OWNED_CLEANUP_RECOVERY'&&uuid(prepared.nonce)&&prepared.authorizationSha256===installHash(installJson(a))&&prepared.grantSha256===a.grantSha256,'Bounded original prepare token required');
 assert(prepared.source===g.source&&prepared.installId===g.installId&&prepared.buildRecordId===g.build.buildRecordId&&prepared.nextBuildId===g.build.nextBuildId,'Prepared identity differs');
 assertFreshObservation(proof.checkedAt,now);assertFreshObservation(prepared.status.runtime.verifiedAt,now);
 assert(prepared.status.runtime.healthStatus===200&&prepared.status.runtime.compiledByteInventory.files>0&&prepared.status.runtime.migrationLedger.rows>0,'Full successful runtime/compiled/ledger observation required');
 return {kind:'FRESH_TWO_PHASE_CLEANUP_CHECKPOINT',source:g.source,installId:g.installId,nonce:prepared.nonce,checkedAt:new Date(now).toISOString(),releaseAuthorized:false};
}
export function validateRecoveredChildren(cleanup,g,authority){
 assert(cleanup?.kind==='OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED'&&cleanup.source===g.source&&cleanup.installId===g.installId&&cleanup.nextBuildId===g.build.nextBuildId&&cleanup.authorizationSha256===installHash(Buffer.from(installJson(g)+'\n')),'Original native cleanup result required');
 assert(isDeepStrictEqual(cleanup.verifiedAbsent,['next','packet'])&&cleanup.auditEvidenceRetained===true&&isDeepStrictEqual(cleanup.activeDirectory,authority.activeDirectory),'Exact owned absence, active identity and retained audit required');return cleanup;
}
export function validateOriginalCleanupAuthority(authority,activated,g,grantSha256,directory){
 assert(authority.format===1&&authority.kind==='OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL'&&authority.sourceDirectory===SOURCE&&authority.source===g.source&&authority.installId===g.installId&&authority.buildRecordId===g.build.buildRecordId&&authority.nextBuildId===g.build.nextBuildId&&authority.authorizationSha256===grantSha256&&authority.witnessFingerprint===g.witnessFingerprint,'Original immutable cleanup authority required');
 assert(activated.format===1&&activated.kind==='CI_BUILD_BYTES_ACTIVATED_NOT_FULL_ARRIVAL'&&activated.source===g.source&&activated.installId===g.installId&&activated.buildRecordId===g.build.buildRecordId&&activated.nextBuildId===g.build.nextBuildId&&activated.authorizationSha256===grantSha256,'Exact original activation required');
 assert(isDeepStrictEqual(authority.directory,directory)&&isDeepStrictEqual(authority.activeDirectory,activated.activation.activeDirectory)&&isDeepStrictEqual(authority.retainedDirectory,activated.activation.retainedDirectory),'Original owned identities differ');
 for(const value of [authority.directory,authority.activeDirectory,authority.retainedDirectory,authority.packetDirectory])assert(value&&Number.isSafeInteger(value.device)&&value.device>=0&&Number.isSafeInteger(value.inode)&&value.inode>0,'Actual directory identity required');
 assert(time(activated.activatedAt)>=time(g.issuedAt)&&time(activated.activatedAt)<=time(authority.authorizedAt)&&time(authority.authorizedAt)<=time(g.expiresAt),'Installation and original authority must have completed under the original valid grant');
 assert(authority.sourceProofSha256===installHash(installJson(authority.sourceProof)),'Original checksum evidence changed');
 // Validate the historical proof at its genuine observation time, never relabel it as fresh.
 const observed=time(authority.sourceProof.checkedAt);
 assert(observed>=time(g.issuedAt)&&observed<=time(authority.authorizedAt),'Original checksum chronology changed');
 validateCleanupRequest(authority.sourceProof,g,{now:observed});
 return authority;
}
/** Narrow orchestration seam for refusal tests; live CLI supplies only actual collectors/native cleanup. */
export async function executeRecoveryCommit(a,g,prepared,proof,operations){
 validateRecoveryCommit(a,g,prepared,proof,{now:operations.now()});
 const runtime=await operations.runtime();
 assert(runtime.pid===prepared.status.runtime.pid&&runtime.startedMonotonicUs===prepared.status.runtime.startedMonotonicUs,'Service changed since full observation');
 const ledger=await operations.ledger();
 assertFreshObservation(ledger.verifiedAt,operations.now());
 assert(isDeepStrictEqual(stableLedger(ledger),stableLedger(prepared.status.runtime.migrationLedger)),'Applied history changed since full observation');
 const checkpoint=validateRecoveryCommit(a,g,prepared,proof,{now:operations.now()});
 // The exclusive intent is durable before deletion. A failed or partial attempt is never replayed.
 operations.intent(checkpoint);
 return {checkpoint,cleanup:validateRecoveredChildren(await operations.cleanup(),g,operations.authority)};
}
export function stableLedger(ledger){
 exact(ledger,['format','kind','rows','expectedSha256','actualSha256','releaseAuthorized','verifiedAt']);
 assert(ledger.format===1&&ledger.kind==='READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE'&&Number.isSafeInteger(ledger.rows)&&ledger.rows>0&&digest(ledger.expectedSha256)&&digest(ledger.actualSha256)&&ledger.releaseAuthorized===false,'Complete actual ordered ledger required');
 const {verifiedAt,...stable}=ledger;time(verifiedAt);return stable;
}
/** Exclusive durable record; a sync failure refuses before the caller can delete anything. */
export function publishRecoveryRecord(path,value,io={openSync,writeFileSync,fsyncSync,closeSync}){
 const parent=dirname(path),st=lstatSync(parent);
 assert(st.isDirectory()&&!st.isSymbolicLink()&&realpathSync(parent)===parent&&st.uid===process.getuid()&&(st.mode&0o777)===0o700,'Owned canonical private record directory required');
 const fd=io.openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{io.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');io.fsyncSync(fd);}finally{io.closeSync(fd);}
 const directory=io.openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{io.fsyncSync(directory);}finally{io.closeSync(directory);}
}
export function readPrivateRecoveryRecord(path,bound=1024**2){
 const before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.uid===process.getuid()&&before.nlink===1&&before.size>0&&before.size<=bound&&(before.mode&0o077)===0,'Bounded private owned record required');
 const bytes=readFileSync(path),after=lstatSync(path);assert(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'Record changed while reading');return bytes;
}
const regular=readPrivateRecoveryRecord;
const json=(path,bound)=>JSON.parse(regular(path,bound));
const identity=st=>({device:st.dev,inode:st.ino});
const write=publishRecoveryRecord;
const system=key=>execFileSync('/usr/bin/systemctl',['show','aihr','--property='+key,'--value'],{encoding:'utf8',timeout:10000}).trim();
async function context(a,{initial=false}={}){
 assert(process.platform==='linux'&&realpathSync(SOURCE)===SOURCE,'Only the canonical existing staging source is allowed');
 const installer=await import(pathToFileURL(join(SOURCE,'.github/ci/staging-build-install.mjs')).href);
 const p=installer.readPrivateInstall(a.installId,{allowExpired:true,allowCleanup:true}),g=p.grant;validateRecoveryAuthorization(a,g,{initial});
 assert(installHash(readFileSync(fileURLToPath(import.meta.url)))===a.helperSha256,'Executing helper differs from reviewed source');
 const authority=json(join(p.directory,'cleanup-authorized.json'),64*1024),activated=json(join(p.directory,'activated.json'));
 validateOriginalCleanupAuthority(authority,activated,g,p.authorizationSha256,identity(lstatSync(p.directory)));
 const audit=join(p.directory,'audit');
 for(const [name,key,bound]of [['system-testing.json','preparedSha256',80*1024],['successful-build.json','successfulObservationSha256',1024**2],['build-provenance.json','provenanceSha256',1024**2],['bytes/build-bundle-files.json','manifestSha256',16*1024**2]])assert(installHash(regular(join(audit,name),bound))===g.build[key],'Original audit bytes changed');
 return {...p,g,authority,activated,audit,installer};
}
async function cheapRuntime(c){
 const {g,authority,installer}=c;
 const {assertBuildRuntime,assertBuildDotenvCompileKeys}=await import(pathToFileURL(join(SOURCE,'.github/ci/build-production.mjs')).href);
 const {fingerprintStagingEnvironment}=await import(pathToFileURL(join(SOURCE,'.github/ci/staging-environment.mjs')).href);
 const runtime={node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next:JSON.parse(readFileSync(join(SOURCE,'node_modules/next/package.json'))).version};
 assertBuildRuntime(runtime,process.env);assertBuildDotenvCompileKeys(SOURCE);assert(isDeepStrictEqual(runtime,g.build.runtime),'Runtime differs from original artifact');
 assert(realpathSync(process.execPath)===realpathSync('/opt/node22/bin/node'),'Pinned service Node required');installer.assertServiceDescriptor(system('ExecStart'),SOURCE);assert(system('WorkingDirectory')===SOURCE,'Service directory changed');
 assert(fingerprintStagingEnvironment(SOURCE)===g.environmentSha256,'Private environment changed');
 const active=lstatSync(join(SOURCE,'.next'));assert(active.isDirectory()&&!active.isSymbolicLink()&&isDeepStrictEqual(identity(active),authority.activeDirectory),'Active build directory changed');
 assert(readFileSync(join(SOURCE,'.next/BUILD_ID'),'utf8').trim()===g.build.nextBuildId,'Active BUILD_ID changed');
 assert(installHash(readFileSync('/proc/sys/kernel/random/boot_id'))===c.activated.bootIdSha256,'Server reboot requires separate recovery');
 assert(execFileSync('/usr/bin/systemctl',['is-active','aihr'],{encoding:'utf8',timeout:10000}).trim()==='active','Service inactive');
 const pid=system('MainPID'),startedMonotonicUs=Number(system('ExecMainStartTimestampMonotonic'));assert(/^[1-9][0-9]*$/.test(pid)&&Number.isSafeInteger(startedMonotonicUs)&&startedMonotonicUs>=c.activated.afterActivationMonotonicUs,'Post-activation service identity required');
 const port=process.env.PORT??'3000';assert(/^[1-9][0-9]{0,4}$/.test(port)&&Number(port)<=65535,'Bounded health port required');
 const response=await fetch('http://127.0.0.1:'+port+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});assert(response.status===200&&system('MainPID')===pid,'Stable live HTTP200 required');await response.arrayBuffer();
 return {pid,startedMonotonicUs,healthStatus:200};
}
async function observe(c){
 const {g,audit}=c;assert(installHash(readFileSync(join(SOURCE,'package.json')))===g.build.packageSha256&&installHash(readFileSync(join(SOURCE,'pnpm-lock.yaml')))===g.build.lockSha256,'Dependency inputs changed');
 const imported=await import(pathToFileURL(join(SOURCE,'scripts/improve/system-testing-manifest.ts')).href),testing={...(imported.default??{}),...imported};
 const prepared=testing.parsePreparedTestingBuild(regular(join(audit,'system-testing.json'),80*1024),{sourceRef:g.source,buildRecordId:g.build.buildRecordId});testing.verifyInstalledTestingBuild(prepared,SOURCE);
 const config=JSON.parse(readFileSync(join(SOURCE,'.next/required-server-files.json')));
 for(const [key,value]of Object.entries(testing.systemTestingCompileEnvironment(prepared)))assert(config.config?.env?.[key]===value,'Original compiled testing identity changed');
 assert(config.config.typescript.ignoreBuildErrors!==true&&config.config.experimental.useTypeScriptCli===true&&config.config.typescript.tsconfigPath==='tsconfig.build.json','Compiler contract changed');
 const compiledByteInventory=JSON.parse(execFileSync('python3',[join(SOURCE,'.github/ci/build-bundle.py'),'verify-active-directory',join(SOURCE,'.next'),join(audit,'bytes/build-bundle-files.json'),SOURCE,g.build.buildSourcePath],{encoding:'utf8',timeout:600000,maxBuffer:1024**2,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
 const runtime=await cheapRuntime(c),{collectMigrationLedger}=await import(pathToFileURL(join(SOURCE,'.github/ci/staging-migration-ledger.mjs')).href);
 const observed={kind:'CLEANUP_RECOVERY_ACTUAL_FULL_RUNTIME_OBSERVATION',source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256:c.authorizationSha256,...runtime,compiledByteInventory,migrationLedger:collectMigrationLedger(SOURCE),verifiedAt:new Date().toISOString(),releaseAuthorized:false};
 return {authorizationSha256:c.authorizationSha256,verified:json(join(c.directory,'verified.json')),activated:c.activated,runtime:observed,releaseAuthorized:false};
}
async function run(mode,input){
 exact(input,mode==='commit'?['authorization','nonce','preparedSha256','sourceProof']:['authorization']);
 const a=input.authorization,c=await context(a,{initial:mode!=='commit'}),g=c.g;
 if(mode==='observe')return {kind:'READ_ONLY_FULL_CLEANUP_RECOVERY_OBSERVATION',status:await observe(c),releaseAuthorized:false};
 if(mode==='prepare'){
  const status=await observe(c);validateRecoveryAuthorization(a,g);
  const prepared={kind:'FULL_RUNTIME_PREPARED_FOR_OWNED_CLEANUP_RECOVERY',nonce:randomUUID(),authorizationSha256:installHash(installJson(a)),grantSha256:a.grantSha256,source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,originalAuthoritySha256:installHash(regular(join(c.directory,'cleanup-authorized.json'),64*1024)),status};
  write(join(c.directory,'cleanup-recovery-'+prepared.nonce+'.json'),prepared);return {kind:'CLEANUP_RECOVERY_PREPARED_NO_DELETION',nonce:prepared.nonce,preparedSha256:installHash(Buffer.from(JSON.stringify(prepared,null,2)+'\n')),status,releaseAuthorized:false};
 }
 assert(mode==='commit'&&uuid(input.nonce)&&digest(input.preparedSha256),'Exact prepared recovery selection required');
 assert(!existsSync(join(c.directory,'cleanup-recovery-used-'+input.nonce+'.json')),'Prepared capability already consumed; inspect retained evidence before a new prepare');
 const bytes=regular(join(c.directory,'cleanup-recovery-'+input.nonce+'.json'),128*1024);assert(installHash(bytes)===input.preparedSha256,'Prepared observation changed');const prepared=JSON.parse(bytes);
 assert(prepared.nonce===input.nonce&&prepared.originalAuthoritySha256===installHash(regular(join(c.directory,'cleanup-authorized.json'),64*1024)),'Original authority or nonce changed');
 const {collectMigrationLedger}=await import(pathToFileURL(join(SOURCE,'.github/ci/staging-migration-ledger.mjs')).href);
 const {checkpoint,cleanup}=await executeRecoveryCommit(a,g,prepared,input.sourceProof,{
  now:()=>Date.now(),authority:c.authority,runtime:()=>cheapRuntime(c),ledger:()=>collectMigrationLedger(SOURCE),
  intent:checkpoint=>write(join(c.directory,'cleanup-recovery-used-'+input.nonce+'.json'),{kind:'CLEANUP_RECOVERY_COMMIT_INTENT_NOT_RESULT',checkpoint,sourceProof:input.sourceProof,preparedSha256:input.preparedSha256}),
  cleanup:()=>JSON.parse(execFileSync('python3',[join(SOURCE,'.github/ci/cleanup-install.py'),c.directory],{encoding:'utf8',timeout:120000,maxBuffer:1024**2,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}))
 });
 const after=await observe(await context(a));
 const result={kind:'TWO_PHASE_OWNED_CI_CLEANUP_RECOVERY_VERIFIED',source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,originalGrantSha256:a.grantSha256,helperSource:a.helperSource,helperSha256:a.helperSha256,checkpoint,cleanup,status:after,ownedResourceCleanupVerified:true,releaseHandbackVerified:false,releaseAuthorized:false};
 write(join(c.directory,'cleanup-recovery-result-'+input.nonce+'.json'),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 (async()=>{assert(process.argv.length===3&&['prepare','commit','observe'].includes(process.argv[2]),'Usage: pinned-helper <prepare|commit|observe>, bounded JSON on stdin');const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;assert(size<=128*1024,'Recovery input exceeds bound');chunks.push(chunk);}return run(process.argv[2],JSON.parse(Buffer.concat(chunks)));})().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});
}
