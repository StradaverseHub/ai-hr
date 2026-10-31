/** Purpose-specific session. Never accepts or renews an installation grant as permission. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {SELECTION,digest,validateCleanupCertificate,validateCleanupReady,validateCleanupCommit,validateCleanupFences,runtimeBinding} from './cleanup-only-recovery-policy.mjs';
export async function runCleanupOnlySession({certificate,controller,toolSha256,retainAudit,fences,audit,persist,authorize,consume,removeOwned,io,now=()=>Date.now(),nonce=()=>randomBytes(32).toString('hex')}){
 const context=()=>({controller,toolSha256,now:now()});validateCleanupCertificate(certificate,context());await retainAudit();
 const before=validateCleanupFences(await fences());assert(digest(before)===certificate.fencesSha256,'State differs from independently issued cleanup certificate');
 const prepared=await audit();assert(prepared?.source===SELECTION.source&&prepared.installId===SELECTION.installId&&prepared.buildRecordId===SELECTION.buildRecordId&&prepared.nextBuildId===SELECTION.nextBuildId&&prepared.pid===before.pid&&prepared.healthStatus===200&&prepared.fullMigrationLedgerVerified===true&&prepared.migrationLedger?.rows===636,'Full pre-cleanup audit differs');assert(digest(runtimeBinding(prepared))===certificate.runtimeSha256,'Prepared actual runtime binding drift');const snapshot=validateCleanupFences(await fences());assert(isDeepStrictEqual(before,snapshot),'State drift during full preparation');validateCleanupCertificate(certificate,context());
 const ready={format:1,kind:'CLEANUP_ONLY_V1_READY',selection:SELECTION,certificateSha256:digest(certificate),nonce:nonce(),fencesSha256:digest(snapshot),readyAt:new Date(now()).toISOString()};
 await persist('ready',ready);validateCleanupReady(ready,certificate,context());await io.ready(ready);
 const commit=await io.commit();validateCleanupCommit(commit,ready,certificate,context());assert(isDeepStrictEqual(await fences(),snapshot),'State drift after READY');
 await persist('commit',commit);await authorize(commit,ready);await consume(ready);
 assert(isDeepStrictEqual(await fences(),snapshot),'State drift before removal');validateCleanupCommit(commit,ready,certificate,context());
 const cleanup=await removeOwned();await persist('owned-cleanup',cleanup);const runtime=await audit();validateCleanupCertificate(certificate,context());
 assert(cleanup?.kind==='OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED'&&cleanup.authorizationSha256===SELECTION.authorizationSha256&&cleanup.installId===SELECTION.installId&&cleanup.nextBuildId===SELECTION.nextBuildId&&cleanup.auditEvidenceRetained===true&&isDeepStrictEqual(cleanup.verifiedAbsent,['next','packet']),'Exact unchanged-engine result required');
 assert(runtime.source===SELECTION.source&&runtime.installId===SELECTION.installId&&runtime.nextBuildId===SELECTION.nextBuildId&&runtime.buildRecordId===SELECTION.buildRecordId&&runtime.pid===snapshot.pid&&runtime.healthStatus===200&&runtime.fullMigrationLedgerVerified===true&&runtime.migrationLedger.rows===636,'Final full runtime/ledger proof differs');assert(digest(runtimeBinding(runtime))===certificate.runtimeSha256,'Final actual runtime binding drift');
 const result={format:1,kind:'CLEANUP_ONLY_V1_COMPLETE_NOT_HAND_BACK',selection:SELECTION,certificateSha256:digest(certificate),cleanup,runtime,ownedResourceCleanupVerified:true,fullSourceChecksumVerified:false,releaseHandbackVerified:false,releaseAuthorized:false};await persist('result',result);return result;
}
