/** Two-phase cleanup session; adapters must hold the queue guard and per-install lock throughout. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {installJson} from './ci-install-grant.mjs';
import {digest,historicalCleanupSelection,validateCleanupExecutionApproval,createCleanupPreparation,validateCleanupCommit} from './post-arrival-cleanup-policy.mjs';

export async function completeOwnedCleanup({grantBytes,authorityBytes,...options}){
 const now=options.now??(()=>Date.now());
 const {grant,authority}=historicalCleanupSelection(grantBytes,authorityBytes,{now:now()});
 return runAuthorizedCleanupSession({...options,grant,authority});
}
/** Adapter orchestration seam for hosted refusal tests; the live CLI always enters via completeOwnedCleanup. */
export async function runAuthorizedCleanupSession({grant,authority,approval,controller,toolSha256,io,audit,fences,persist,consume,removeOwned,now=()=>Date.now(),nonce=()=>randomBytes(32).toString('hex')}){
 validateCleanupExecutionApproval(approval,{controller,now:now()});
 assert(approval.toolSha256===toolSha256,'Approval must bind the reviewed tool bytes');
 const approvalSha256=digest(installJson(approval));
 const before=await fences();
 const runtime=await audit(); // All slow complete byte, environment and ledger checks precede READY.
 const after=await fences();
 assert(isDeepStrictEqual(before,after),'State changed during complete runtime preparation');
 validateCleanupExecutionApproval(approval,{controller,now:now()});
 const preparation=createCleanupPreparation({nonce:nonce(),fences:after,runtime,approvalSha256,toolSha256,now:now()});
 await persist('preparation',preparation);
 await io.ready(preparation); // Private IPC only; never surface the nonce in operator summaries.
 const request=await io.commit(); // EOF, oversized input and deadline must reject in the adapter.
 validateCleanupExecutionApproval(approval,{controller,now:now()});
 validateCleanupCommit(request,preparation,{fences:await fences(),approvalSha256,toolSha256,now:now()});
 await persist('commit',request);
 await consume(preparation); // Exclusive immutable create before any removal; replay fails closed.
 validateCleanupExecutionApproval(approval,{controller,now:now()});
 validateCleanupCommit(request,preparation,{fences:await fences(),approvalSha256,toolSha256,now:now()}); // Slow durable writes cannot age a proof past its bound.
 const cleanup=await removeOwned({grant,authority});
 assert(cleanup?.kind==='OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED'&&cleanup.authorizationSha256===preparation.selection.authorizationSha256
  &&cleanup.installId===grant.installId&&cleanup.source===grant.source&&cleanup.nextBuildId===grant.build.nextBuildId
  &&isDeepStrictEqual(cleanup.verifiedAbsent,['next','packet'])&&cleanup.auditEvidenceRetained===true,'Owned removal result differs');
 await persist('owned-cleanup',cleanup);
 const finalRuntime=await audit(); // Complete runtime, immutable bytes and ledger again after deletion.
 assert(finalRuntime.source===grant.source&&finalRuntime.installId===grant.installId&&finalRuntime.buildRecordId===grant.build.buildRecordId
  &&finalRuntime.nextBuildId===grant.build.nextBuildId&&finalRuntime.pid===preparation.fences.pid&&finalRuntime.healthStatus===200&&finalRuntime.fullMigrationLedgerVerified===true,'Final actual runtime differs');
 const result={format:1,kind:'POST_EXPIRY_OWNED_CLEANUP_COMPLETE_NOT_HAND_BACK',source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,
  nextBuildId:grant.build.nextBuildId,authorizationSha256:preparation.selection.authorizationSha256,authoritySha256:preparation.selection.authoritySha256,
  approvalSha256,toolSha256,cleanup,runtime:finalRuntime,ownedResourceCleanupVerified:true,fullSourceChecksumVerified:false,releaseHandbackVerified:false,releaseAuthorized:false};
 await persist('result',result);return result; // Operator still must obtain a complete post-cleanup zero rsync.
}
