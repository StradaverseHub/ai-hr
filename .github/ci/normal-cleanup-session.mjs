/** Normal valid-grant two-phase cleanup. No installation or post-expiry authority. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateInstallGrant,installHash,installJson} from './ci-install-grant.mjs';
import {validateCleanupRequest} from './staging-cleanup-protocol.mjs';
export const READY_KIND='NORMAL_VALID_GRANT_CLEANUP_READY';
export const RESULT_KIND='NORMAL_VALID_GRANT_CLEANUP_RESULT';
const keys=(v,n)=>assert(v&&Object.keys(v).sort().join(',')===n.split(' ').sort().join(','),'Exact cleanup session fields required');
export function selection(grant){return {source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,authorizationSha256:installHash(Buffer.from(installJson(grant)+'\n'))};}
export function validateReady(value,grant,{now=Date.now()}={}){
 validateInstallGrant(grant,{now});keys(value,'format kind selection nonce fencesSha256 readyAt');
 assert(value.format===1&&value.kind===READY_KIND&&isDeepStrictEqual(value.selection,selection(grant))&&/^[a-f0-9]{64}$/.test(value.nonce)&&/^[a-f0-9]{64}$/.test(value.fencesSha256),'Exact valid-grant cleanup READY required');
 const at=Date.parse(value.readyAt);assert(Number.isFinite(at)&&at<=now&&now-at<=180000,'Cleanup READY expired');return value;
}
export function validateCommit(value,ready,grant,{now=Date.now()}={}){
 validateReady(ready,grant,{now});keys(value,'format kind readySha256 nonce proof');
 assert(value.format===1&&value.kind==='NORMAL_VALID_GRANT_CLEANUP_COMMIT'&&value.nonce===ready.nonce&&value.readySha256===installHash(installJson(ready)),'Exact cleanup challenge required');
 validateCleanupRequest(value.proof,grant,{now});assert(Date.parse(value.proof.checkedAt)>=Date.parse(ready.readyAt),'Source checksum must follow READY');return value;
}
export function createCommit(ready,proof,grant,options){return validateCommit({format:1,kind:'NORMAL_VALID_GRANT_CLEANUP_COMMIT',nonce:ready.nonce,readySha256:installHash(installJson(ready)),proof},ready,grant,options);}
/** Ports are the same orchestration exercised by actual installer and hosted IPC fixtures. */
export async function runNormalCleanupSession({grant,audit,retainAudit,fences,persist,consume,authorize,removeOwned,io,now=()=>Date.now(),nonce=()=>randomBytes(32).toString('hex')}){
 validateInstallGrant(grant,{now:now()});await retainAudit();const before=await fences();await audit();const snapshot=await fences();
 assert(isDeepStrictEqual(before,snapshot),'Cleanup state drift during full preparation');validateInstallGrant(grant,{now:now()});
 const ready={format:1,kind:READY_KIND,selection:selection(grant),nonce:nonce(),fencesSha256:installHash(installJson(snapshot)),readyAt:new Date(now()).toISOString()};
 await persist('ready',ready);validateReady(ready,grant,{now:now()});await io.ready(ready);
 const commit=await io.commit();validateCommit(commit,ready,grant,{now:now()});assert(isDeepStrictEqual(await fences(),snapshot),'Cleanup state drift after READY');
 await persist('commit',commit);await authorize(commit.proof);await consume(ready);
 // Durable writes and all fast fences precede the final age/expiry check, not the other way around.
 assert(isDeepStrictEqual(await fences(),snapshot),'Cleanup state drift before deletion');validateCommit(commit,ready,grant,{now:now()});
 const cleanup=await removeOwned();await persist('owned-cleanup',cleanup);const runtime=await audit();
 validateInstallGrant(grant,{now:now()});return {cleanup,runtime};
}
