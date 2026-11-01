/** Operator controller. No install/deploy/role/DB mutation: only inspected cleanup certificate/channel. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {SELECTION,ORIGIN,digest,canonicalJson,validateCleanupCertificate,validateCleanupReady,createCleanupCommit,finishCleanupCli} from './cleanup-only-recovery-policy.mjs';
import {TOOL_FILES,toolDigest,privateBytes,savePrivate} from './cleanup-only-recovery-admission.mjs';
export async function waitForRealReadyClock(ready,{now=()=>Date.now(),sleep=ms=>new Promise(done=>setTimeout(done,ms))}={}){
 const at=Date.parse(ready?.readyAt),start=now();assert(Number.isFinite(at)&&at-start<=2000,'Cross-host clock gap exceeds bounded real wait');
 while(now()<at){assert(now()-start<=2100,'Real clock wait exceeded bound');await sleep(Math.min(10,Math.max(1,at-now())));} // No synthetic now/backdating/TTL changes.
}
export async function driveCleanupOnly({channel,certificate,controller,toolSha256,checksum,frozen,save,now=()=>Date.now(),wait=waitForRealReadyClock}){
 const context=()=>({controller,toolSha256,now:now()});
 try{validateCleanupCertificate(certificate,context());const raw=await channel.frames.next();await wait(raw);const ready=validateCleanupReady(raw,certificate,context());save('fresh-ready.json',ready);frozen();
  const output=await checksum(),checkedAt=new Date(now()).toISOString();save('fresh-source-checksum.json',{source:SELECTION.source,checkedAt,output,checksum:true});frozen();
  const commit=createCleanupCommit(ready,certificate,{output,checkedAt},context());save('fresh-commit.json',commit);channel.stdin.end(JSON.stringify(commit)+'\n');
  const result=await channel.frames.next();assert(result?.kind==='CLEANUP_ONLY_V1_COMPLETE_NOT_HAND_BACK'&&result.certificateSha256===digest(certificate)&&result.ownedResourceCleanupVerified===true&&result.releaseAuthorized===false&&result.releaseHandbackVerified===false,'Purpose-specific terminal cleanup result required');
  await channel.success();validateCleanupCertificate(certificate,context());save('actual-cleanup-result.json',result);save('transport-stderr.json',channel.stderr());frozen();return result;
 }catch{channel.stdin.end();save('cleanup-only-incomplete.json',{retainLease:true,reconcileRemoteBeforeRetry:true,originalFailuresUnchanged:true,error:'Cleanup-only protocol refused or incomplete'});throw Error('Cleanup-only protocol refused; retain lease and reconcile; never automatically retry');}
}
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
export function validateInterruptedObservation(value,originalEvidence){
 assert(value?.kind==='INTERRUPTED_OPERATOR_EXIT_UNKNOWN'&&value.source===SELECTION.source&&value.originalSessionId===27283&&value.originalOperatorExit===null&&value.originalOperatorPass===false&&value.canonicalEvidence===originalEvidence,'Actual observed unknown operator exit required');
 assert(JSON.stringify(Object.keys(value.presentEvidence??{}).sort())===JSON.stringify(['installed-arrival.json','remote-build-result.json','source-arrival.json'])&&Object.values(value.presentEvidence).every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)),'Complete observed original arrival hashes required');
 assert(JSON.stringify(Object.keys(value.outputFiles??{}).sort())===JSON.stringify(['deploy.stderr.log','deploy.stdout.json'])&&Object.values(value.outputFiles).every(v=>Number.isSafeInteger(v.bytes)&&v.bytes>=0&&v.bytes<=16*1024**2&&/^[a-f0-9]{64}$/.test(v.sha256)),'Complete observed output hashes required');
 assert(JSON.stringify(value.absentTerminalEvidence)===JSON.stringify(['owned-cleanup.json','final-source-arrival.json','cleanup-session-incomplete.json'])&&/^[a-f0-9]{64}$/.test(value.reconciliationSha256),'Exact observed missing terminal set required');return value;
}
export async function operate(mode,configPath){
 assert(['inspect','custody','cleanup'].includes(mode));const c=JSON.parse(privateBytes(configPath));
 const {frozen,controller,remoteToolDirectory,remoteReconciliation,reconciliationPath,reconciliationSha256,attemptName,out,certificatePath,remoteCertificate,humanEvidencePath,originalEvidence}=c;
 assert(/^[a-f0-9]{40}$/.test(controller)&&/^cleanup-only-v1-[a-z0-9_-]{3,60}$/.test(attemptName));
 for(const p of [remoteToolDirectory,remoteReconciliation,...(mode!=='inspect'?[remoteCertificate]:[])])assert(typeof p==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(p)&&!p.split('/').some(v=>v==='.'||v==='..'),'Canonical private remote paths required');
 const load=name=>import(pathToFileURL(join(frozen,name)).href),{cleanHead}=await load('.github/ci/release-ci.mjs');
 const immutable=()=>assert(cleanHead(frozen)===SELECTION.source&&cleanHead(resolve(dirname(fileURLToPath(import.meta.url)),'../..'))===controller,'Original source or reviewed controller changed');immutable();
 const {readLease,guardCommand,guardedRsync,leasePrefix}=await load('scripts/staging/lease.mjs'),lease=readLease(SELECTION.source);assert(lease.batch===SELECTION.batch&&lease.epoch===SELECTION.epoch,'Exact original active lease required');
 const {stagingTransport}=await load('.github/ci/staging-transport.mjs'),transport=stagingTransport(frozen,process.env),{openNormalCleanupChannel}=await load('.github/ci/normal-cleanup-operator.mjs');
 assert(realpathSync(dirname(resolve(out)))===dirname(resolve(out)),'Canonical existing output parent required');mkdirSync(out,{mode:0o700});const save=(name,value)=>savePrivate(join(out,name),value);
 const reconciliationBytes=privateBytes(reconciliationPath);assert(digest(reconciliationBytes)===reconciliationSha256);const reconciliation=JSON.parse(reconciliationBytes);
 const remoteFiles=[...TOOL_FILES.map(name=>join(remoteToolDirectory,name)),remoteReconciliation],expected=[...TOOL_FILES.map(name=>digest(readFileSync(new URL(name,import.meta.url)))),reconciliationSha256];
 if(mode!=='inspect'){remoteFiles.push(remoteCertificate);expected.push(digest(privateBytes(certificatePath)));}
 const ssh=command=>execFileSync('ssh',transport.sshArgs(guardCommand(lease,command)),{encoding:'utf8',timeout:600000,maxBuffer:64*1024**2});
 const hashes=ssh('sha256sum -- '+remoteFiles.map(quote).join(' ')).trim().split('\n').map(v=>v.split(/\s+/)[0]);assert(JSON.stringify(hashes)===JSON.stringify(expected),'Actual reviewed remote bytes differ');
 const source='/opt/ai-hr',command='cd '+quote(source)+' && /opt/node22/bin/node --env-file=.env.production --import tsx '+quote(join(remoteToolDirectory,'cleanup-only-recovery-server.mjs'))+' '+[mode,source,controller,remoteReconciliation,reconciliationSha256,attemptName,...(mode==='cleanup'?[remoteCertificate]:[])].map(quote).join(' ');
 if(mode==='inspect'){const value=JSON.parse(ssh(command));assert(value.controller===controller&&value.toolSha256===toolDigest());save('inspection.json',value);return value;}
 const certificate=JSON.parse(privateBytes(certificatePath));validateCleanupCertificate(certificate,{controller,toolSha256:toolDigest()});assert(certificate.humanEvidenceSha256===digest(privateBytes(humanEvidencePath)),'Existing explicit staging/cleanup owner evidence changed');
 if(mode==='custody'){
  // No outer shared guard: the exact private helper takes the ACTUAL queue EX lock nonblocking.
  const custodyCommand='cd /opt/ai-hr && '+leasePrefix(lease)+' python3 '+quote(join(remoteToolDirectory,'cleanup-only-recovery-custody.py'))+' '+['custody',controller,remoteReconciliation,reconciliationSha256,attemptName,remoteCertificate].map(quote).join(' ');
  const result=JSON.parse(execFileSync('ssh',transport.sshArgs(custodyCommand),{encoding:'utf8',timeout:600000,maxBuffer:1024**2}));
  assert(result.kind==='DEAD_LOCK_CUSTODY_COMPLETE'&&result.certificateSha256===digest(certificate)&&result.reconciliationSha256===reconciliationSha256&&result.custodySha256===certificate.custodySha256&&result.originalLockAbsent===true&&result.readyPreserved===true,'Exact completed custody required');immutable();save('actual-custody-result.json',result);return result;
 }
 const grant=JSON.parse(privateBytes(join(originalEvidence,'installation-grant.json')));
 const {historicalInstallMetadata}=await import('./cleanup-only-recovery-policy.mjs');const {validateInstallGrant}=await load('.github/ci/ci-install-grant.mjs');historicalInstallMetadata(Buffer.from(canonicalJson(grant)+'\n'),{validateOriginal:validateInstallGrant});
 const originalInterrupted=privateBytes(c.interruptionPath),interruption=JSON.parse(originalInterrupted),originalArrival=privateBytes(join(originalEvidence,'installed-arrival.json'));
 assert(digest(originalInterrupted)===reconciliation.interruptionSha256,'Actual ROOT interruption observation differs');validateInterruptedObservation(interruption,originalEvidence);
 for(const [name,wanted]of Object.entries(interruption.presentEvidence)){assert(['remote-build-result.json','source-arrival.json','installed-arrival.json'].includes(name)&&digest(privateBytes(join(originalEvidence,name)))===wanted,'Original arrival evidence changed');}
 assert(JSON.stringify(interruption.absentTerminalEvidence)===JSON.stringify(['owned-cleanup.json','final-source-arrival.json','cleanup-session-incomplete.json'])&&interruption.absentTerminalEvidence.every(name=>!existsSync(join(originalEvidence,name))),'Original missing terminal state changed');
 for(const [name,wanted]of Object.entries(interruption.outputFiles)){assert(['deploy.stdout.json','deploy.stderr.log'].includes(name));const bytes=readFileSync(join(c.originalOutputDirectory,name));assert(bytes.length===wanted.bytes&&digest(bytes)===wanted.sha256,'Observed original output changed');}
 const earlier=JSON.parse(originalArrival);assert(earlier.source===SELECTION.source&&earlier.installId===SELECTION.installId&&earlier.buildRecordId===SELECTION.buildRecordId&&earlier.nextBuildId===SELECTION.nextBuildId&&earlier.healthStatus===200&&earlier.fullSourceChecksumVerified===true&&earlier.migrationLedger?.rows===636,'Actual original source/build arrival required');
 const remoteBuild=JSON.parse(privateBytes(join(originalEvidence,'remote-build-result.json')));assert(remoteBuild.built_ref===SELECTION.source&&remoteBuild.built_build_id===SELECTION.nextBuildId&&remoteBuild.stale_build==='0','Original actual source/build arrival differs');
 const {validateFinalCleanup}=await load('.github/ci/staging-ci-promotion.mjs'),{expectedMigrationLedger}=await load('.github/ci/staging-migration-ledger.mjs');
 const expectedLedger=expectedMigrationLedger(frozen);assert(expectedLedger.length===636,'Actual original full636 source required');
 const installed={authorizationSha256:SELECTION.authorizationSha256,verified:JSON.parse(Buffer.from(reconciliation.files['verified.json'].base64,'base64')),activated:JSON.parse(Buffer.from(reconciliation.files['activated.json'].base64,'base64')),releaseAuthorized:false};
 for(const record of [installed.verified,installed.activated])assert(record.source===SELECTION.source&&record.installId===SELECTION.installId&&record.buildRecordId===SELECTION.buildRecordId&&record.nextBuildId===SELECTION.nextBuildId&&record.authorizationSha256===SELECTION.authorizationSha256,'Retained original installation tuple differs');
 const imported=await load('scripts/improve/release.ts'),official={...(imported.default??{}),...imported};const checksum=()=>execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...guardedRsync(lease,transport.rsyncArgs(official,frozen))],{encoding:'utf8',timeout:120000,maxBuffer:16*1024**2});
 const channel=openNormalCleanupChannel(transport.sshArgs(guardCommand(lease,command))),result=await driveCleanupOnly({channel,certificate,controller,toolSha256:toolDigest(),checksum,frozen:immutable,save});
 const arrival=validateFinalCleanup({...result,kind:'CI_INSTALL_OWNED_CLEANUP_AND_FINAL_RUNTIME_VERIFIED',source:SELECTION.source,installId:SELECTION.installId,buildRecordId:SELECTION.buildRecordId,nextBuildId:SELECTION.nextBuildId,authorizationSha256:SELECTION.authorizationSha256},{grant,installed,expectedLedger});
 const finalOutput=checksum();save('final-source-checksum.json',{source:SELECTION.source,output:finalOutput,checkedAt:new Date().toISOString(),checksum:true});assert(finalOutput==='','Final actual source checksum differs');validateCleanupCertificate(certificate,{controller,toolSha256:toolDigest()});immutable();

 assert(privateBytes(c.interruptionPath).equals(originalInterrupted)&&privateBytes(join(originalEvidence,'installed-arrival.json')).equals(originalArrival),'Original interruption/arrival evidence changed');
 const composed={kind:'RECOVERED_STAGING_INSTALLATION_ARRIVAL_AND_OWNED_CLEANUP',sha:SELECTION.source,remoteBuild,arrival,arrivalVerified:true,ownedResourceCleanupVerified:true,releaseHandbackVerified:false,originalOperatorExit:null,originalOperatorPass:false,originalInterruptionObservationSha256:digest(originalInterrupted),originalInstalledArrivalSha256:digest(originalArrival),originalCiSource:SELECTION.source,originalCiRun:ORIGIN.runId,recovery:{kind:'NEW_EXPLICIT_CLEANUP_ONLY_V1',expiredInstallationGrantIsMetadataOnly:true,cleanupCertificateSha256:digest(certificate),controller,toolSha256:toolDigest(),reconciliationSha256,originalFailuresPreserved:true,newAttempt:attemptName,finalCanonicalSourceChecksumEmpty:true,batch:lease.batch,epoch:lease.epoch},leasePhaseAndHandbackStillRootOwned:true};save('recovered-arrival.json',composed);return composed;
}
export {finishCleanupCli as finishCleanupOperatorCli} from './cleanup-only-recovery-policy.mjs';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const[mode,path]=process.argv.slice(2);await finishCleanupCli(()=>operate(mode,path));}
