/** Short-lived deletion authority for an independently verified, already active CI installation. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {installHash,installJson,validateInstallGrant} from './ci-install-grant.mjs';

export const ARRIVAL_CLEANUP_WINDOW_MS=30*60000;
// The deletion engine has two minutes and the final compiled audit has ten.
const AFTER_COMMIT_RESERVE_MS=13*60000;
const PREPARATION_RESERVE_MS=26*60000;
// Revalidation completes before the bounded ten-minute live audit and two-minute checksum.
const MAX_CI_TO_AUTHORITY_MS=13*60000;
const MAX_ARRIVAL_TO_AUTHORITY_MS=3*60000;
const exact=(value,keys)=>assert(value&&Object.keys(value).sort().join(' ')===keys.split(' ').sort().join(' '),'Exact arrival cleanup fields required');
const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const identity=value=>{
 exact(value,'device inode');
 assert(Number.isSafeInteger(value.device)&&value.device>=0&&Number.isSafeInteger(value.inode)&&value.inode>0,'Exact cleanup inode required');
};
export const cleanupInstallSelection=grant=>({source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,
 nextBuildId:grant.build.nextBuildId,authorizationSha256:installHash(installJson(grant)+'\n')});
const originalCi=grant=>({controller:grant.controller,baseline:grant.baseline,runId:grant.runId,
 witnessFingerprint:grant.witnessFingerprint,artifactSha256:grant.artifact.digest,archiveSha256:grant.build.archiveSha256});
const leaseIdentity=lease=>({batch:lease.batch,epoch:lease.epoch,candidate:lease.candidate});
export function validateCleanupLease(lease,source){
 exact(lease,'batch epoch candidate');
 assert(/^[a-f0-9-]{36}$/.test(lease.batch)&&Number.isSafeInteger(lease.epoch)&&lease.epoch>0&&lease.candidate===source,'Exact retained staging lease required');
 return lease;
}
const ledgerIdentity=ledger=>({rows:ledger.rows,expectedSha256:ledger.expectedSha256,actualSha256:ledger.actualSha256});

export function validateArrivalCleanupAuthority(authority,grant,{now=Date.now(),reserve=0,freshSource=false}={}){
 validateInstallGrant(grant,{now,allowExpired:true});
 exact(authority,'format kind selection ci lease runtime ledger custody checksum issuedAt expiresAt releaseAuthorized');
 assert(authority.format===1&&authority.kind==='OPERATOR_AUTHORIZED_ARRIVAL_CLEANUP_ONLY'&&authority.releaseAuthorized===false,'Distinct cleanup-only authority required');
 same(authority.selection,cleanupInstallSelection(grant),'Original immutable installation differs');
 const {revalidatedAt,...ci}=authority.ci;
 same(ci,originalCi(grant),'Original authenticated CI identity differs');
 validateCleanupLease(authority.lease,grant.source);
 exact(authority.runtime,'bootIdSha256 pid startedMonotonicUs environmentSha256 activeDirectory');
 const runtime=authority.runtime;
 assert(digest(runtime.bootIdSha256)&&/^[1-9][0-9]*$/.test(runtime.pid)&&Number.isSafeInteger(runtime.startedMonotonicUs)&&runtime.startedMonotonicUs>0
  &&runtime.environmentSha256===grant.environmentSha256,'Exact active runtime and environment required');
 identity(runtime.activeDirectory);
 exact(authority.ledger,'rows expectedSha256 actualSha256');
 assert(Number.isSafeInteger(authority.ledger.rows)&&authority.ledger.rows>0&&digest(authority.ledger.expectedSha256)&&digest(authority.ledger.actualSha256),'Exact ordered migration ledger required');
 exact(authority.custody,'directory retained packet');
 for(const value of Object.values(authority.custody))identity(value);
 exact(authority.checksum,'outputSha256 checkedAt');
 assert(authority.checksum.outputSha256===installHash(''),'Actual zero-line source checksum required');
 const issued=Date.parse(authority.issuedAt),expires=Date.parse(authority.expiresAt),checked=Date.parse(authority.checksum.checkedAt),verified=Date.parse(revalidatedAt);
 assert([issued,expires,checked,verified].every(Number.isFinite)&&issued>=Date.parse(grant.issuedAt)&&issued<=now+60000
  &&expires>issued&&expires>now+reserve&&expires<=issued+ARRIVAL_CLEANUP_WINDOW_MS&&expires<=Date.parse(grant.runCreatedAt)+86400000,'Live arrival cleanup authority and execution reserve required');
 assert(verified<=checked&&checked<=issued&&issued-verified<=MAX_CI_TO_AUTHORITY_MS&&issued-checked<=60000,'Fresh CI and source verification required before authority');
 if(freshSource)assert(checked<=now+60000&&now-checked<=60000,'Fresh actual source verification required when publishing authority');
 return authority;
}
export function createArrivalCleanupAuthority({grant,evidence,lease,installed,output,checkedAt,revalidatedAt,now=Date.now()}){
 assert(evidence?.result==='PASS'&&evidence.tier==='ci'&&evidence.sha===grant.source&&evidence.controller===grant.controller&&evidence.baseline===grant.baseline
  &&evidence.runId===grant.runId&&evidence.fingerprint===grant.witnessFingerprint&&evidence.build?.canonicalCandidateInputsVerified===true,'Original authenticated CI witness required');
 for(const key of ['buildRecordId','nextBuildId','archiveSha256','manifestSha256','preparedSha256','successfulObservationSha256','provenanceSha256'])
  same(evidence.build[key],grant.build[key],'Original CI build binding differs: '+key);
 assert(evidence.artifacts.some(artifact=>artifact.id===grant.artifact.id&&artifact.digest===grant.artifact.digest),'Original authenticated CI artifact required');
 const selection=cleanupInstallSelection(grant),runtime=installed.runtime,activated=installed.activated;
 for(const record of [installed.verified,activated,runtime])for(const [key,value] of Object.entries(selection))
  same(record?.[key],value,'Actual installed tuple differs: '+key);
 const observed=Date.parse(runtime.verifiedAt);
 assert(output===''&&runtime.healthStatus===200&&runtime.startedMonotonicUs>=activated.afterActivationMonotonicUs
  &&observed+60000>=Date.parse(revalidatedAt)&&observed<=Date.parse(checkedAt)+60000&&now-observed<=MAX_ARRIVAL_TO_AUTHORITY_MS,
 'Fresh exact live installation and source checksum required');
 const authority={format:1,kind:'OPERATOR_AUTHORIZED_ARRIVAL_CLEANUP_ONLY',selection,ci:{...originalCi(grant),revalidatedAt},lease:leaseIdentity(lease),
  runtime:{bootIdSha256:activated.bootIdSha256,pid:runtime.pid,startedMonotonicUs:runtime.startedMonotonicUs,environmentSha256:grant.environmentSha256,activeDirectory:activated.activation.activeDirectory},
  ledger:ledgerIdentity(runtime.migrationLedger),custody:installed.cleanupCustody,checksum:{outputSha256:installHash(output),checkedAt},
  issuedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+ARRIVAL_CLEANUP_WINDOW_MS,Date.parse(grant.runCreatedAt)+86400000)).toISOString(),releaseAuthorized:false};
 return validateArrivalCleanupAuthority(authority,grant,{now,reserve:PREPARATION_RESERVE_MS});
}

export function validateArrivalCleanupFences(authority,grant,fences){
 same({source:fences.source,installId:fences.installId,authorizationSha256:fences.authorizationSha256},
  {source:grant.source,installId:grant.installId,authorizationSha256:authority.selection.authorizationSha256},'Original live installation differs');
 same(fences.lease,authority.lease,'Retained staging lease differs');
 same({bootIdSha256:fences.boot,pid:fences.pid,startedMonotonicUs:fences.started,environmentSha256:fences.environment,activeDirectory:fences.active},authority.runtime,'Live cleanup runtime changed');
 same(ledgerIdentity(fences.ledger),authority.ledger,'Live ordered migration ledger changed');
 same({directory:fences.directory,retained:fences.retained,packet:fences.packet},authority.custody,'Selected owned cleanup inodes changed');
 return fences;
}
export function validateArrivalCleanupRuntime(authority,runtime,live){
 for(const [key,value] of Object.entries(authority.selection))same(runtime[key],value,'Final installed tuple changed: '+key);
 assert(runtime.healthStatus===200,'Exact live health required');
 same({...live,pid:runtime.pid,startedMonotonicUs:runtime.startedMonotonicUs},authority.runtime,'Live cleanup runtime changed');
 same(ledgerIdentity(runtime.migrationLedger),authority.ledger,'Live ordered migration ledger changed');
 return runtime;
}
export function requireArrivalCleanupRunway(authority,grant,now,{beforeReady=false}={}){
 return validateArrivalCleanupAuthority(authority,grant,{now,reserve:AFTER_COMMIT_RESERVE_MS+(beforeReady?3*60000:0)});
}
