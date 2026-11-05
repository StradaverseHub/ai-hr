/** A distinct, bounded cleanup-only authority. Never renews an installation grant. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {randomBytes} from 'node:crypto';
import {validateInstallGrant,installHash,installJson} from './ci-install-grant.mjs';
import {selection} from './normal-cleanup-session.mjs';
export const RECONCILIATION_POLICY='aihr-post-arrival-reconciliation/v1';
export const READY_KIND='POST_ARRIVAL_RECONCILIATION_CLEANUP_READY';
export const RESULT_KIND='POST_ARRIVAL_RECONCILIATION_CLEANUP_RESULT';
const exact=(v,keys)=>assert(v&&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' '),'Exact reconciliation fields required');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
export function validateReconciliationAuthority(a,g,{now=Date.now()}={}){
 validateInstallGrant(g,{now,allowExpired:true});
 exact(a,'format kind policy selection originalGrantExpiresAt originalCi reconciliationController diagnosticsRunId controllerInventorySha256 lease environmentSha256 activeDirectory pid startedMonotonicUs bootIdSha256 ledger sourceChecksum issuedAt expiresAt releaseAuthorized');
 assert(a.format===1&&a.kind==='POST_ARRIVAL_RECONCILIATION_CLEANUP_ONLY'&&a.policy===RECONCILIATION_POLICY&&a.releaseAuthorized===false,'Distinct cleanup-only reconciliation authority required');
 same(a.selection,selection(g),'Original immutable installation selection differs');
 assert(a.originalGrantExpiresAt===g.expiresAt&&Date.parse(g.expiresAt)<=Date.parse(a.issuedAt),'Reconciliation is only for an already expired original installation grant');
 exact(a.originalCi,'runId controller baseline witnessFingerprint buildRecordId archiveSha256 revalidatedAt');
 for(const [k,v]of Object.entries({runId:g.runId,controller:g.controller,baseline:g.baseline,witnessFingerprint:g.witnessFingerprint,buildRecordId:g.build.buildRecordId,archiveSha256:g.build.archiveSha256}))same(a.originalCi[k],v,'Original authenticated CI identity differs: '+k);
 assert(digest(a.controllerInventorySha256)&&sha(a.reconciliationController)&&Number.isSafeInteger(a.diagnosticsRunId)&&a.diagnosticsRunId>0,'Reviewed reconciliation controller and hosted diagnostics required');
 exact(a.lease,'batch epoch candidate');assert(/^[a-f0-9-]{36}$/.test(a.lease.batch)&&Number.isSafeInteger(a.lease.epoch)&&a.lease.epoch>0&&a.lease.candidate===g.source,'Exact retained staging lease required');
 same(a.environmentSha256,g.environmentSha256,'Private staging environment differs');
 exact(a.activeDirectory,'device inode');assert(Number.isSafeInteger(a.activeDirectory.device)&&Number.isSafeInteger(a.activeDirectory.inode)&&a.activeDirectory.inode>0,'Exact active directory identity required');
 assert(/^[1-9][0-9]*$/.test(a.pid)&&Number.isSafeInteger(a.startedMonotonicUs)&&a.startedMonotonicUs>0&&digest(a.bootIdSha256),'Exact active runtime identity required');
 exact(a.ledger,'rows expectedSha256 actualSha256');assert(Number.isSafeInteger(a.ledger.rows)&&a.ledger.rows>0&&digest(a.ledger.expectedSha256)&&digest(a.ledger.actualSha256),'Complete exact ordered migration ledger required');
 exact(a.sourceChecksum,'outputSha256 checkedAt');assert(a.sourceChecksum.outputSha256===installHash(''),'Actual zero-line source checksum required');
 const issued=Date.parse(a.issuedAt),expires=Date.parse(a.expiresAt),verified=Date.parse(a.originalCi.revalidatedAt),checked=Date.parse(a.sourceChecksum.checkedAt),created=Date.parse(g.runCreatedAt);
 assert([now,issued,expires,verified,checked,created].every(Number.isFinite)&&issued<=now+60000&&expires>now&&expires>issued&&expires<=issued+60*60000&&expires<=created+86400000,'Bounded live reconciliation authority required');
 assert(verified<=issued&&issued-verified<=5*60000&&checked<=issued&&issued-checked<=60000,'Fresh independent original-CI and actual source checks required');return a;
}
export function createReconciliationAuthority({grant:g,evidence:e,controller,diagnosticsRunId,controllerInventorySha256,lease,installed,output,checkedAt,ciRevalidatedAt,now=Date.now()}){
 assert(e?.result==='PASS'&&e.tier==='ci'&&e.sha===g.source&&e.controller===g.controller&&e.baseline===g.baseline&&e.runId===g.runId&&e.fingerprint===g.witnessFingerprint,'Fresh independently authenticated full original CI required');
 for(const key of ['buildRecordId','nextBuildId','archiveSha256','manifestSha256','preparedSha256','successfulObservationSha256','provenanceSha256'])same(e.build?.[key],g.build[key],'Original authenticated build differs: '+key);
 assert(e.build.canonicalCandidateInputsVerified===true&&output==='','Canonical candidate binding and actual zero-line source checksum required');
 const runtime=installed.runtime,activation=installed.activated;
 for(const record of [installed.verified,activation,runtime])assert(record?.source===g.source&&record.installId===g.installId&&record.buildRecordId===g.build.buildRecordId&&record.nextBuildId===g.build.nextBuildId&&record.authorizationSha256===selection(g).authorizationSha256,'Actual installed tuple differs');
 assert(runtime.healthStatus===200&&runtime.startedMonotonicUs>=activation.afterActivationMonotonicUs&&Date.parse(runtime.verifiedAt)<=now&&now-Date.parse(runtime.verifiedAt)<=5*60000,'Fresh actual post-activation runtime required');
 const ledger=runtime.migrationLedger;
 return validateReconciliationAuthority({format:1,kind:'POST_ARRIVAL_RECONCILIATION_CLEANUP_ONLY',policy:RECONCILIATION_POLICY,selection:selection(g),originalGrantExpiresAt:g.expiresAt,
  originalCi:{runId:g.runId,controller:g.controller,baseline:g.baseline,witnessFingerprint:g.witnessFingerprint,buildRecordId:g.build.buildRecordId,archiveSha256:g.build.archiveSha256,revalidatedAt:ciRevalidatedAt},
  reconciliationController:controller,diagnosticsRunId,controllerInventorySha256,lease:{batch:lease.batch,epoch:lease.epoch,candidate:lease.candidate},environmentSha256:g.environmentSha256,
  activeDirectory:activation.activation.activeDirectory,pid:runtime.pid,startedMonotonicUs:runtime.startedMonotonicUs,bootIdSha256:activation.bootIdSha256,
  ledger:{rows:ledger.rows,expectedSha256:ledger.expectedSha256,actualSha256:ledger.actualSha256},sourceChecksum:{outputSha256:installHash(output),checkedAt},
  issuedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+60*60000,Date.parse(g.runCreatedAt)+86400000)).toISOString(),releaseAuthorized:false},g,{now});
}
export function validateReconciliationFences(a,f){
 assert(f.healthStatus===200&&digest(f.controllerMetadata),'Reviewed controller metadata fence required');same(f.source,a.selection.source,'Live source changed');same(f.installId,a.selection.installId,'Live installation changed');same(f.authorizationSha256,a.selection.authorizationSha256,'Original grant changed');
 same(f.lease,a.lease,'Retained staging lease changed');same(f.environment,a.environmentSha256,'Environment changed');same(f.active,a.activeDirectory,'Active inode changed');same(f.pid,a.pid,'Active PID changed');same(f.started,a.startedMonotonicUs,'Service restart changed');same(f.boot,a.bootIdSha256,'Server boot changed');
 for(const k of ['rows','expectedSha256','actualSha256'])same(f.ledger[k],a.ledger[k],'Ordered migration ledger changed: '+k);
 return f;
}
export function validateReconciliationReady(r,a,g,{now=Date.now()}={}){
 validateReconciliationAuthority(a,g,{now});exact(r,'format kind authoritySha256 selection nonce fencesSha256 readyAt');
 assert(r.format===1&&r.kind===READY_KIND&&r.authoritySha256===installHash(installJson(a))&&digest(r.nonce)&&digest(r.fencesSha256),'Exact reconciliation READY required');same(r.selection,selection(g),'READY selection differs');
 const at=Date.parse(r.readyAt);assert(Number.isFinite(at)&&at<=now&&now-at<=180000,'Reconciliation READY expired');return r;
}
export function createReconciliationCommit(r,a,g,{output,checkedAt,ciRevalidatedAt,now=Date.now()}){
 assert(output==='','Actual post-READY zero-line source checksum required');
 return validateReconciliationCommit({format:1,kind:'POST_ARRIVAL_RECONCILIATION_CLEANUP_COMMIT',authoritySha256:installHash(installJson(a)),readySha256:installHash(installJson(r)),nonce:r.nonce,outputSha256:installHash(output),checkedAt},r,a,g,{now});
}
export function validateReconciliationCommit(c,r,a,g,{now=Date.now()}={}){
 validateReconciliationReady(r,a,g,{now});exact(c,'format kind authoritySha256 readySha256 nonce outputSha256 checkedAt');
 assert(c.format===1&&c.kind==='POST_ARRIVAL_RECONCILIATION_CLEANUP_COMMIT'&&c.authoritySha256===r.authoritySha256&&c.readySha256===installHash(installJson(r))&&c.nonce===r.nonce&&c.outputSha256===installHash(''),'Exact same-channel reconciliation checksum commitment required');
 const at=Date.parse(c.checkedAt);assert(Number.isFinite(at)&&at>=Date.parse(r.readyAt)&&at<=now+60000&&now-at<=60000,'Fresh post-READY checksum required');return c;
}
export async function runReconciliationSession({authority:a,grant:g,retainAudit,audit,fences,persist,consume,authorize,removeOwned,postFences,io,now=()=>Date.now(),nonce=()=>randomBytes(32).toString('hex')}){
 validateReconciliationAuthority(a,g,{now:now()});await retainAudit();const before=validateReconciliationFences(a,await fences());await audit();const snapshot=validateReconciliationFences(a,await fences());same(before,snapshot,'Reconciliation state drift during full preparation');
 const ready={format:1,kind:READY_KIND,authoritySha256:installHash(installJson(a)),selection:selection(g),nonce:nonce(),fencesSha256:installHash(installJson(snapshot)),readyAt:new Date(now()).toISOString()};
 validateReconciliationReady(ready,a,g,{now:now()});await persist('ready',ready);await io.ready(ready);
 const commit=await io.commit();validateReconciliationCommit(commit,ready,a,g,{now:now()});same(validateReconciliationFences(a,await fences()),snapshot,'Reconciliation state drift after READY');
 await persist('commit',commit);await authorize(commit);await consume(ready);
 same(validateReconciliationFences(a,await fences()),snapshot,'Reconciliation state drift before deletion');validateReconciliationCommit(commit,ready,a,g,{now:now()});
 const cleanup=await removeOwned();await persist('owned-cleanup',cleanup);const runtime=await audit();validateReconciliationAuthority(a,g,{now:now()});
 assert(runtime?.source===g.source&&runtime.installId===g.installId&&runtime.buildRecordId===g.build.buildRecordId&&runtime.nextBuildId===g.build.nextBuildId&&runtime.authorizationSha256===a.selection.authorizationSha256&&runtime.pid===a.pid&&runtime.startedMonotonicUs===a.startedMonotonicUs&&runtime.healthStatus===200,'Final runtime drift from cleanup-only authority');
 for(const k of ['rows','expectedSha256','actualSha256'])same(runtime.migrationLedger?.[k],a.ledger[k],'Final runtime migration ledger drift: '+k);
 const postStarted=now(),post=validateReconciliationFences(a,await postFences());
 assert(now()-postStarted<=30000,'Final reconciliation fences exceeded deadline');validateReconciliationAuthority(a,g,{now:now()});
 for(const k of ['sourceMetadata','compiledMetadata','controllerMetadata'])same(post[k],snapshot[k],'Reconciliation state changed after deletion: '+k);
 return {cleanup,runtime};
}
