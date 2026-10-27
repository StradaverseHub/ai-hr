/** Operator-observed source checksum authorizes owned cleanup only; server rechecks live runtime/ledger. */
import assert from 'node:assert/strict';
import {installJson,installHash,validateInstallGrant} from './ci-install-grant.mjs';
/** This observation cannot authorize deletion: the server must first establish actual arrival. */
export function createSourceChecksumObservation(grant,{output,checkedAt}){
 assert(output==='','Zero-line actual checksum rsync required before arrival observation');
 const value={format:1,kind:'OPERATOR_SOURCE_CHECKSUM_OBSERVATION_NOT_CLEANUP_AUTHORITY',source:grant.source,installId:grant.installId,
  buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,authorizationSha256:installHash(Buffer.from(installJson(grant)+'\n')),
  witnessFingerprint:grant.witnessFingerprint,outputSha256:installHash(''),checkedAt};
 return validateSourceChecksumObservation(value,grant);
}
export function validateSourceChecksumObservation(value,grant,options){
 assert(value&&Object.hasOwn(value,'kind')&&value.kind==='OPERATOR_SOURCE_CHECKSUM_OBSERVATION_NOT_CLEANUP_AUTHORITY','Only a source checksum observation is accepted');
 // Reuse the complete existing tuple/shape/grant/freshness boundary without making
 // an observation itself acceptable to the legacy destructive cleanup command.
 validateCleanupRequest({...value,kind:'OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP'},grant,options);
 return value;
}
export function createCleanupRequest(grant,{output,checkedAt,arrival}){
 assert(output==='','Zero-line actual checksum rsync required before owned cleanup');
 assert(arrival?.source===grant.source&&arrival.installId===grant.installId&&arrival.buildRecordId===grant.build.buildRecordId&&arrival.nextBuildId===grant.build.nextBuildId&&arrival.healthStatus===200,'Verified actual arrival tuple required');
 return validateCleanupRequest({format:1,kind:'OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP',source:grant.source,installId:grant.installId,
  buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,authorizationSha256:installHash(Buffer.from(installJson(grant)+'\n')),
  witnessFingerprint:grant.witnessFingerprint,outputSha256:installHash(''),checkedAt},grant);
}
export function validateCleanupRequest(value,grant,{now=Date.now()}={}){
 validateInstallGrant(grant,{now});
 const keys=['format','kind','source','installId','buildRecordId','nextBuildId','authorizationSha256','witnessFingerprint','outputSha256','checkedAt'];
 assert(value&&Object.keys(value).sort().join(',')===keys.sort().join(',')&&value.format===1&&value.kind==='OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP'
  &&value.source===grant.source&&value.installId===grant.installId&&value.buildRecordId===grant.build.buildRecordId&&value.nextBuildId===grant.build.nextBuildId
  &&value.authorizationSha256===installHash(Buffer.from(installJson(grant)+'\n'))&&value.witnessFingerprint===grant.witnessFingerprint&&value.outputSha256===installHash(''),'Exact operator-observed checksum authority required');
 const at=Date.parse(value.checkedAt);assert(Number.isFinite(at)&&at<=now+60000&&now-at<=60000,'Fresh actual source checksum required for owned cleanup');
 return value;
}
