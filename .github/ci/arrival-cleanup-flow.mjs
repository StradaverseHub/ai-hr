/** One fresh arrival proof feeds owned cleanup; before/after checks and original evidence remain. */
import assert from 'node:assert/strict';
import {installJson,installHash} from './ci-install-grant.mjs';
import {createCleanupRequest,validateSourceChecksumObservation} from './staging-cleanup-protocol.mjs';
import {validateInstalledArrival,validateFinalCleanup} from './staging-ci-promotion.mjs';

export async function completeArrivalAndCleanup({grant,observation,expectedLedger},{observe,cleanupAfterFreshArrival}){
 validateSourceChecksumObservation(observation,grant);
 const observationBytes=installJson(observation),grantBytes=installJson(grant);
 const installed=await observe();
 assert(installJson(grant)===grantBytes&&installJson(observation)===observationBytes,'Authority changed during actual arrival observation');
 const initialArrival=validateInstalledArrival(installed,grant,expectedLedger);
 validateSourceChecksumObservation(observation,grant); // Refuse expiry during the complete scan.
 const request=createCleanupRequest(grant,{output:'',checkedAt:observation.checkedAt,arrival:initialArrival});
 // Production supplies only the private continuation immediately after the fresh
 // full runtime proof above. There is no CLI flag or exported installer API to skip it.
 const cleaned=await cleanupAfterFreshArrival(request);
 assert(installJson(grant)===grantBytes&&installJson(observation)===observationBytes,'Authority changed during owned cleanup');
 validateFinalCleanup(cleaned,{grant,installed,expectedLedger});
 return {format:1,kind:'CI_ARRIVAL_AND_OWNED_CLEANUP_COMPLETED',sourceObservationSha256:installHash(observationBytes),
  installed,cleaned,releaseAuthorized:false};
}
export function validateArrivalAndCleanupResult(value,{grant,observation,expectedLedger}){
 assert(value&&Object.keys(value).sort().join(',')==='cleaned,format,installed,kind,releaseAuthorized,sourceObservationSha256'
  &&value.format===1&&value.kind==='CI_ARRIVAL_AND_OWNED_CLEANUP_COMPLETED'&&value.releaseAuthorized===false
  &&value.sourceObservationSha256===installHash(installJson(observation)),'Exact combined arrival/cleanup observation required');
 // The parent independently checks both results with unchanged validators. A slow
 // response whose initial observation is no longer fresh refuses, never becomes PASS.
 const initialArrival=validateInstalledArrival(value.installed,grant,expectedLedger);
 const arrival=validateFinalCleanup(value.cleaned,{grant,installed:value.installed,expectedLedger});
 return {initialArrival,arrival};
}
