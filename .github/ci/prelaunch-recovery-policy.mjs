/** A new installation attempt after an authenticated, unlaunched transport failure. Never renews a grant. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
export const PRELAUNCH_POLICY='aihr-prelaunch-recovery/v1';
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const REQUEST_KEYS=['policy','source','baseline','verifier','witnessFingerprint','qualificationRunId','oldInstallId','baselineInstallId','oldAuthorizationSha256','baselineAuthorizationSha256','currentSha256','lastOkSha256','oldPreflightSha256','oldAcknowledgementSha256','failureSha256','bundleOwnerSha256','lease'];
export function validatePrelaunchRequest(r){
 assert(r&&isDeepStrictEqual(Object.keys(r).sort(),REQUEST_KEYS.slice().sort()),'Closed prelaunch request required');
 assert(r.policy===PRELAUNCH_POLICY&&[r.source,r.baseline,r.verifier].every(sha)&&r.source!==r.baseline,'Exact source, baseline and independent verifier required');
 assert([r.oldInstallId,r.baselineInstallId].every(uuid)&&r.oldInstallId!==r.baselineInstallId,'Distinct original installations required');
 for(const k of REQUEST_KEYS.filter(k=>k.endsWith('Sha256')||k==='witnessFingerprint'))assert(digest(r[k]),'Exact private proof hash required: '+k);
 assert(Number.isSafeInteger(r.qualificationRunId)&&r.qualificationRunId>0,'Actual operator qualification required');
 assert(r.lease&&Object.keys(r.lease).sort().join(',')==='batch,epoch'&&uuid(r.lease.batch)&&Number.isSafeInteger(r.lease.epoch)&&r.lease.epoch>0,'Exact held lease identity required');
 return r;
}
export function validatePrelaunchObservation(o,r){
 validatePrelaunchRequest(r);
 assert(o?.policy===PRELAUNCH_POLICY&&o.source===r.source&&o.baseline===r.baseline&&o.oldInstallId===r.oldInstallId
  &&o.oldAuthorizationSha256===r.oldAuthorizationSha256&&o.baselineAuthorizationSha256===r.baselineAuthorizationSha256
  &&o.currentSha256===r.currentSha256&&o.lastOkSha256===r.lastOkSha256&&isDeepStrictEqual(o.lease,r.lease),'Original attempt/baseline/lease changed');
 assert(o.noNativeBegin===true&&o.noNativeProcess===true&&o.oldUnlaunched===true&&o.pending===r.source&&o.oldGrantNotRevoked===true,'Only an actually unlaunched source-pending attempt is eligible');
 for(const k of ['compiledMetadataSha256','packetSha256','baselineManifestSha256','environmentSha256'])assert(digest(o[k]),'Complete native byte/fence proof required: '+k);
 assert(o.compiledBytesVerified===true&&o.releaseAuthorized===false,'Canonical baseline compiled-byte verification required');
 return o;
}
export function validateNewAttempt(grant,old,r){
 assert(uuid(grant.installId)&&grant.installId!==old.installId&&grant.installId!==r.baselineInstallId,'Fresh independent installation UUID required');
 for(const key of ['source','controller','controllerBranch','baseline','baselineBuildId','environmentSha256','runId','runAttempt','runCreatedAt','producerStartedAt','producerCompletedAt','witnessFingerprint','artifact','build'])
  assert(isDeepStrictEqual(grant[key],old[key]),'Original authenticated build identity changed: '+key);
 assert(grant.source===r.source&&grant.baseline===r.baseline&&grant.witnessFingerprint===r.witnessFingerprint&&Date.parse(grant.issuedAt)>Date.parse(old.issuedAt),'New authority must retain the original witness and build');
 return grant;
}
/** All expensive reauthentication precedes fresh authority. No retries after link or launch uncertainty. */
export async function recoverPrelaunch({request,oldGrant,ports}){
 validatePrelaunchRequest(request);await ports.frozen();await ports.proveLocalFailure();
 const before=validatePrelaunchObservation(await ports.observe(),request);
 const evidence=await ports.reauthenticate();
 assert(evidence.sha===request.source&&evidence.baseline===request.baseline&&evidence.fingerprint===request.witnessFingerprint
  &&evidence.verificationController===request.verifier&&evidence.result==='PASS','Canonical existing verifier/witness required');
 await ports.frozen();await ports.cheapFence(before);
 const grant=validateNewAttempt(await ports.newGrant(evidence),oldGrant,request);
 const linked=await ports.linkAndCopy({grant,before,evidence});
 assert(linked.installId===grant.installId&&linked.oldInstallId===request.oldInstallId&&linked.copyVerified===true&&linked.releaseAuthorized===false,'Durable single new-attempt link and authenticated copy required');
 await ports.frozen();await ports.cheapFence(before);
 // reserveAndLaunch MUST atomically reserve once before invoking the canonical launcher. Any error is terminal.
 const launch=await ports.reserveAndLaunch({grant,before,linked});
 assert(launch.installId===grant.installId&&launch.launchReserved===true,'Canonical single launch acknowledgement required');
 return ports.arrive({grant,evidence,launch});
}
