/** Private staging reconciliation receiver. Read-only inspection or one cleanup-only session. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {readPrivateInstall,auditSelectedRuntime,retainNormalCleanupAudit,withNormalCleanupLock} from './staging-build-install.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {validateReconciliationAuthority,validateReconciliationFences,runReconciliationSession,RESULT_KIND} from './post-arrival-reconciliation-policy.mjs';
import {captureNormalCleanupFences,canonicalSourceExclusions,cleanupTreeFence} from './normal-cleanup-fences.mjs';
import {durableCleanupRecord,readSingleCleanupCommit} from './normal-cleanup-io.mjs';
import {collectMigrationLedger} from './staging-migration-ledger.mjs';
import {fingerprintStagingEnvironment} from './staging-environment.mjs';
import {assertControllerInventory} from './reconciliation-controller-inventory.mjs';
import {guardServerCli} from '../../scripts/staging/lease.mjs';
const ROOT='/opt/ai-hr',controllerRoot=fileURLToPath(new URL('../../',import.meta.url));
function record(path,bound=1024**2){
 const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&s.size>0&&s.size<=bound,'Bounded owned reconciliation record required');return JSON.parse(readFileSync(path));
}
function selected(source,installId,buildRecordId){
 assert(process.platform==='linux'&&resolve(process.cwd())===ROOT&&realpathSync(ROOT)===ROOT,'Confirmed Linux staging working directory required');
 const p=readPrivateInstall(installId,{allowExpired:true,allowCleanup:true});
 assert(p.grant.source===source&&p.grant.build.buildRecordId===buildRecordId,'Original installation selection differs');return p;
}
function controllerCheck(expectedSha256){const m=record(join(controllerRoot,'controller-inventory.json'),1024**2);return assertControllerInventory(controllerRoot,m,{expectedSha256});}
export async function inspectExpiredArrival(source,installId,buildRecordId){
 const p=selected(source,installId,buildRecordId);
 return {authorizationSha256:p.authorizationSha256,verified:record(join(p.directory,'verified.json')),activated:record(join(p.directory,'activated.json')),
  runtime:await auditSelectedRuntime(ROOT,p,{beforeVerifyDirectory:()=>controllerCheck()}),releaseAuthorized:false};
}
export async function reconcileExpiredArrival(source,installId,buildRecordId,authorityPath){
 const p=selected(source,installId,buildRecordId),g=p.grant;
 assert(authorityPath===join(p.directory,'post-arrival-reconciliation-authority.json'),'One exact private authority path required');
 const a=validateReconciliationAuthority(record(authorityPath,32768),g);
 controllerCheck(a.controllerInventorySha256);
 const controller=record(join(controllerRoot,'reconciliation-controller.json'),4096);
 assert(controller.source===a.reconciliationController&&controller.kind==='PRIVATE_REVIEWED_RECONCILIATION_CONTROLLER','Private reviewed controller differs');
 for(const name of ['cleanup-authorized.json','normal-cleanup-ready.json','normal-cleanup-commit.json','normal-cleanup-consumed.json','reconciliation-v1-ready.json','reconciliation-v1-consumed.json'])assert(!existsSync(join(p.directory,name)),'Prior uncertain cleanup requires separate reconciliation; no automatic retry');
 return withNormalCleanupLock(p.directory,{source,installId,pid:process.pid,policy:a.policy},async()=>{
  const activated=record(join(p.directory,'activated.json'));
  const official=await import(pathToFileURL(join(ROOT,'scripts/improve/release.ts')).href);
  const exclude=canonicalSourceExclusions((official.deploymentRsyncArgs??official.default?.deploymentRsyncArgs)(ROOT));
  const recordNames=['authorization.json','store.json','verified.json','activated.json','runtime.json','post-arrival-reconciliation-authority.json','audit/system-testing.json','audit/successful-build.json','audit/build-provenance.json','audit/bytes/build-bundle-files.json'];
  const show=name=>execFileSync('systemctl',['show','aihr','--property='+name,'--value'],{encoding:'utf8',timeout:3000}).trim();
  let expectedCleanupAuthority=null;
  const authority=()=>{
   validateReconciliationAuthority(a,g);controllerCheck(a.controllerInventorySha256);
   assert(isDeepStrictEqual(record(authorityPath,32768),a),'Reconciliation authority changed');
   const current=selected(source,installId,buildRecordId);assert(current.authorizationSha256===p.authorizationSha256,'Original immutable grant changed');
   if(expectedCleanupAuthority)assert(isDeepStrictEqual(record(join(p.directory,'cleanup-authorized.json'),32768),expectedCleanupAuthority),'Cleanup authority changed');
  };
  const fences=async()=>validateReconciliationFences(a,{...await captureNormalCleanupFences({source:ROOT,p,activated,exclude,recordNames,ports:{
   authority:async()=>authority(),lease:async()=>guardServerCli(source),leaseIdentity:async()=>({batch:process.env.AIHR_STAGING_BATCH,epoch:Number(process.env.AIHR_STAGING_EPOCH),candidate:process.env.AIHR_STAGING_CANDIDATE}),
   runtime:async()=>{assert(fingerprintStagingEnvironment(ROOT)===g.environmentSha256,'Private environment changed');assert(readFileSync(join(ROOT,'.next/BUILD_ID'),'utf8').trim()===g.build.nextBuildId,'Active build changed');},
   service:async()=>({pid:show('MainPID'),started:Number(show('ExecMainStartTimestampMonotonic')),active:execFileSync('systemctl',['is-active','aihr'],{encoding:'utf8',timeout:3000}).trim()==='active'}),
   boot:async()=>installHash(readFileSync('/proc/sys/kernel/random/boot_id')),environment:async()=>fingerprintStagingEnvironment(ROOT),ledger:async()=>collectMigrationLedger(ROOT),
   health:async()=>{const r=await fetch('http://127.0.0.1:'+(process.env.PORT??'3000')+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});await r.arrayBuffer();return r.status;}
  }}),controllerMetadata:controllerCheck(a.controllerInventorySha256),healthStatus:200});
  const {cleanup,runtime}=await runReconciliationSession({authority:a,grant:g,
   retainAudit:async()=>retainNormalCleanupAudit(p,activated),audit:()=>auditSelectedRuntime(ROOT,p,{beforeVerifyDirectory:()=>controllerCheck(a.controllerInventorySha256)}),fences,
   postFences:async()=>{authority();guardServerCli(source);const response=await fetch('http://127.0.0.1:'+(process.env.PORT??'3000')+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});await response.arrayBuffer();const current=selected(source,installId,buildRecordId),ledger={...collectMigrationLedger(ROOT)};delete ledger.verifiedAt;
    return {source,installId,authorizationSha256:current.authorizationSha256,lease:{batch:process.env.AIHR_STAGING_BATCH,epoch:Number(process.env.AIHR_STAGING_EPOCH),candidate:process.env.AIHR_STAGING_CANDIDATE},
     environment:fingerprintStagingEnvironment(ROOT),active:{device:lstatSync(join(ROOT,'.next')).dev,inode:lstatSync(join(ROOT,'.next')).ino},pid:show('MainPID'),started:Number(show('ExecMainStartTimestampMonotonic')),boot:installHash(readFileSync('/proc/sys/kernel/random/boot_id')),ledger,
     sourceMetadata:cleanupTreeFence(ROOT,exclude),compiledMetadata:cleanupTreeFence(join(ROOT,'.next'),r=>r==='cache'),controllerMetadata:controllerCheck(a.controllerInventorySha256),healthStatus:response.status};},
   persist:async(name,value)=>durableCleanupRecord(join(p.directory,'reconciliation-v1-'+name+'.json'),value),
   consume:async ready=>durableCleanupRecord(join(p.directory,'reconciliation-v1-consumed.json'),{kind:'POST_ARRIVAL_RECONCILIATION_NONCE_CONSUMED',authoritySha256:installHash(installJson(a)),readySha256:installHash(installJson(ready))}),
   authorize:async commit=>{
    expectedCleanupAuthority={format:1,kind:'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL',sourceDirectory:ROOT,source:g.source,installId,buildRecordId,nextBuildId:g.build.nextBuildId,
     authorizationSha256:p.authorizationSha256,witnessFingerprint:g.witnessFingerprint,directory:{device:lstatSync(p.directory).dev,inode:lstatSync(p.directory).ino},activeDirectory:activated.activation.activeDirectory,
     retainedDirectory:activated.activation.retainedDirectory,packetDirectory:{device:lstatSync(p.packet).dev,inode:lstatSync(p.packet).ino},sourceProof:commit,sourceProofSha256:installHash(installJson(commit)),authorizedAt:new Date().toISOString(),
     reconciliationPolicy:a.policy,reconciliationAuthoritySha256:installHash(installJson(a))};
    durableCleanupRecord(join(p.directory,'cleanup-authorized.json'),expectedCleanupAuthority);
   },
   removeOwned:async()=>{controllerCheck(a.controllerInventorySha256);return JSON.parse(execFileSync('python3',[join(controllerRoot,'.github/ci/cleanup-install.py'),p.directory],{encoding:'utf8',timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));},
   io:{ready:async r=>process.stdout.write(installJson(r)+'\n'),commit:()=>readSingleCleanupCommit(process.stdin)}});
  return {format:1,kind:RESULT_KIND,result:{format:1,kind:'CI_INSTALL_OWNED_CLEANUP_AND_FINAL_RUNTIME_VERIFIED',source,installId,buildRecordId,nextBuildId:g.build.nextBuildId,
   authorizationSha256:p.authorizationSha256,cleanup,runtime,ownedResourceCleanupVerified:true,releaseHandbackVerified:false,reconciliation:{policy:a.policy,authoritySha256:installHash(installJson(a)),controller:a.reconciliationController,diagnosticsRunId:a.diagnosticsRunId}}};
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,source,installId,buildRecordId,authorityPath]=process.argv.slice(2);
 assert(['inspect','publish','cleanup'].includes(mode)&&process.argv.length===(mode==='cleanup'?7:6),'Exact reconciliation-only command required');guardServerCli(source);
 (mode==='inspect'?inspectExpiredArrival(source,installId,buildRecordId):mode==='publish'?(async()=>{const p=selected(source,installId,buildRecordId),a=validateReconciliationAuthority(await readSingleCleanupCommit(process.stdin),p.grant);controllerCheck(a.controllerInventorySha256);durableCleanupRecord(join(p.directory,'post-arrival-reconciliation-authority.json'),a);return {published:true,authoritySha256:installHash(installJson(a))};})():reconcileExpiredArrival(source,installId,buildRecordId,authorityPath)).then(r=>console.log(installJson(r))).catch(()=>{console.error('Post-arrival reconciliation refused; preserve lease and original installation records.');process.exitCode=1;});
}
