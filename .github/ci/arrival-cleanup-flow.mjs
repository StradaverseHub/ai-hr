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
 const beforeCleanupValidatedAt=new Date().toISOString();
 const request=createCleanupRequest(grant,{output:'',checkedAt:observation.checkedAt,arrival:initialArrival});
 // Production supplies only the private continuation immediately after the fresh
 // full runtime proof above. There is no CLI flag or exported installer API to skip it.
 const cleaned=await cleanupAfterFreshArrival(request);
 assert(installJson(grant)===grantBytes&&installJson(observation)===observationBytes,'Authority changed during owned cleanup');
 validateFinalCleanup(cleaned,{grant,installed,expectedLedger});
 return {format:1,kind:'CI_ARRIVAL_AND_OWNED_CLEANUP_COMPLETED',beforeCleanupValidatedAt,sourceObservationSha256:installHash(observationBytes),
  installed,cleaned,releaseAuthorized:false};
}
export function validateArrivalAndCleanupResult(value,{grant,observation,expectedLedger}){
 assert(value&&Object.keys(value).sort().join(',')==='beforeCleanupValidatedAt,cleaned,format,installed,kind,releaseAuthorized,sourceObservationSha256'
  &&value.format===1&&value.kind==='CI_ARRIVAL_AND_OWNED_CLEANUP_COMPLETED'&&value.releaseAuthorized===false
  &&value.sourceObservationSha256===installHash(installJson(observation)),'Exact combined arrival/cleanup observation required');
 // The before-proof must have been fresh WHEN USED to authorize cleanup, not
 // relabelled as a new current observation after an arbitrarily long disk cleanup.
 // The after-proof below still has the ordinary current-time freshness requirement.
 const used=Date.parse(value.beforeCleanupValidatedAt),after=Date.parse(value.cleaned?.runtime?.verifiedAt);
 assert(Number.isFinite(used)&&Number.isFinite(after)&&used<=after&&used<=Date.now()+60000,'Ordered actual before/after cleanup observations required');
 validateSourceChecksumObservation(observation,grant,{now:used});
 const initialArrival=validateInstalledArrival(value.installed,grant,expectedLedger,{now:used});
 const arrival=validateFinalCleanup(value.cleaned,{grant,installed:value.installed,expectedLedger});
 return {initialArrival,arrival};
}
