/** Two-phase cleanup with an original live grant or a separately scoped arrival authority. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateInstallGrant,installHash,installJson} from './ci-install-grant.mjs';
import {validateCleanupRequest} from './staging-cleanup-protocol.mjs';
import {cleanupInstallSelection,requireArrivalCleanupRunway,validateArrivalCleanupAuthority,validateArrivalCleanupFences} from './arrival-cleanup-authority.mjs';
export const READY_KIND='NORMAL_VALID_GRANT_CLEANUP_READY';
export const RESULT_KIND='NORMAL_VALID_GRANT_CLEANUP_RESULT';
const keys=(v,n)=>assert(v&&Object.keys(v).sort().join(',')===n.split(' ').sort().join(','),'Exact cleanup session fields required');
export function selection(grant,authority){
 const installation=cleanupInstallSelection(grant);
 return authority?{...installation,cleanupAuthoritySha256:installHash(installJson(authority))}:installation;
}
function validateAuthority(grant,authority,now){
 if(authority)validateArrivalCleanupAuthority(authority,grant,{now});else validateInstallGrant(grant,{now});
}
export function validateReady(value,grant,{now=Date.now(),authority}={}){
 validateAuthority(grant,authority,now);keys(value,'format kind selection nonce fencesSha256 readyAt');
 assert(value.format===1&&value.kind===READY_KIND&&isDeepStrictEqual(value.selection,selection(grant,authority))&&/^[a-f0-9]{64}$/.test(value.nonce)&&/^[a-f0-9]{64}$/.test(value.fencesSha256),'Exact valid-grant cleanup READY required');
 const at=Date.parse(value.readyAt);assert(Number.isFinite(at)&&at<=now&&now-at<=180000,'Cleanup READY expired');return value;
}
export function validateCommit(value,ready,grant,{now=Date.now(),authority}={}){
 validateReady(ready,grant,{now,authority});keys(value,'format kind readySha256 nonce proof');
 assert(value.format===1&&value.kind==='NORMAL_VALID_GRANT_CLEANUP_COMMIT'&&value.nonce===ready.nonce&&value.readySha256===installHash(installJson(ready)),'Exact cleanup challenge required');
 validateCleanupRequest(value.proof,grant,{now,authority});assert(Date.parse(value.proof.checkedAt)>=Date.parse(ready.readyAt),'Source checksum must follow READY');return value;
}
export function createCommit(ready,proof,grant,options){return validateCommit({format:1,kind:'NORMAL_VALID_GRANT_CLEANUP_COMMIT',nonce:ready.nonce,readySha256:installHash(installJson(ready)),proof},ready,grant,options);}
/** Ports are the same orchestration exercised by actual installer and hosted IPC fixtures. */
export async function runNormalCleanupSession({grant,authority,audit,retainAudit,fences,persist,consume,authorize,removeOwned,io,now=()=>Date.now(),nonce=()=>randomBytes(32).toString('hex')}){
 const options=()=>({now:now(),authority});
 const snapshotFences=async()=>{const value=await fences();return authority?validateArrivalCleanupFences(authority,grant,value):value;};
 validateAuthority(grant,authority,now());await retainAudit();const before=await snapshotFences();await audit();const snapshot=await snapshotFences();
 assert(isDeepStrictEqual(before,snapshot),'Cleanup state drift during full preparation');
 if(authority)requireArrivalCleanupRunway(authority,grant,now(),{beforeReady:true});
 else validateInstallGrant(grant,{now:now()});
 const ready={format:1,kind:READY_KIND,selection:selection(grant,authority),nonce:nonce(),fencesSha256:installHash(installJson(snapshot)),readyAt:new Date(now()).toISOString()};
 await persist('ready',ready);validateReady(ready,grant,options());await io.ready(ready);
 const commit=await io.commit();validateCommit(commit,ready,grant,options());assert(isDeepStrictEqual(await snapshotFences(),snapshot),'Cleanup state drift after READY');
 await persist('commit',commit);await authorize(commit.proof);await consume(ready);
 // Durable writes and all fast fences precede the final age/expiry check, not the other way around.
 assert(isDeepStrictEqual(await snapshotFences(),snapshot),'Cleanup state drift before deletion');validateCommit(commit,ready,grant,options());
 if(authority)requireArrivalCleanupRunway(authority,grant,now());
 const cleanup=await removeOwned();await persist('owned-cleanup',cleanup);const runtime=await audit();
 validateAuthority(grant,authority,now());return {cleanup,runtime};
}
