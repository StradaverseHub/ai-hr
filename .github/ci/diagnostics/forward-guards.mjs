import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';

export function validateFailedContext(report,oldGrant,{announced=false}={}) {
 const s=report.status;
 assert(report.kind==='FAILED_UNACTIVATED_STAGING_SNAPSHOT','Explicit failed context required');
 assert(s.state===(announced?'incomplete':'failed')&&s.ref===oldGrant.source&&s.phase==='ci-build-verify'
  &&s.exit_code==='1'&&s.pid==='3354827'&&s.stale_build==='1','Original failed verification context moved');
 assert(s.built_ref===oldGrant.baseline&&s.built_build_id===oldGrant.baselineBuildId&&s.build_id===oldGrant.baselineBuildId,'Original active build moved');
 assert(report.current.ref===oldGrant.source&&report.current.result==='failed'&&report.current.phase==='ci-build-verify'
  &&report.current.pid===s.pid&&report.current.log===s.log&&report.current.exit_code==='1','Actual failed record required; no invented ready baseline');
 assert(report.pendingPresent===announced&&(!announced||report.pendingRef===oldGrant.source),'Actual pending marker differs');
 assert(report.originalGrantEqual===true&&report.originalGrantSha256.match(/^[a-f0-9]{64}$/),'Historical immutable authorization differs');
 assert(isDeepStrictEqual(report.originalEntries,['authorization.json','packet','store.json'])&&report.absentOwnedOutputs===true,'Original attempt has stage/activation/unknown outputs');
 assert(report.deployPidAlive===false&&report.service==='active'&&report.servicePid==='3327801'&&report.healthStatus===200,'Original service/dead deploy context moved');
 assert(report.environmentSha256===oldGrant.environmentSha256&&report.lockMarker===oldGrant.build.lockSha256,'Environment or completed dependency installation changed');
 assert(report.packageSha256===oldGrant.build.packageSha256&&report.lockSha256===oldGrant.build.lockSha256,'Installed source dependency inputs changed');
 assert(report.logContainsExactSharpFailure===true,'Original exact package failure required');
 for(const key of ['currentSha256','lastOkSha256','originalGrantSha256','oldLogSha256','bootIdSha256'])assert(/^[a-f0-9]{64}$/.test(report[key]??''),'Snapshot digest missing: '+key);
 return report;
}
export function failedContextAnchor(report) {
 return Object.fromEntries(['currentSha256','lastOkSha256','originalGrantSha256','oldLogSha256','bootIdSha256','oldDirectory','activeDirectory','servicePid'].map(key=>[key,report[key]]));
}
export function requireSameFailedContext(before,after) {
 assert(isDeepStrictEqual(failedContextAnchor(before),failedContextAnchor(after)),'Original failed attempt or active service changed during recovery');
}
export function validateRenewal(oldGrant,newGrant) {
 const old={...oldGrant},fresh={...newGrant};
 for(const key of ['installId','issuedAt','expiresAt']){delete old[key];delete fresh[key];}
 assert(isDeepStrictEqual(old,fresh),'Fresh authority may change only instance UUID and issue/expiry times');
 assert(newGrant.installId!==oldGrant.installId&&Date.parse(newGrant.issuedAt)>Date.parse(oldGrant.issuedAt),'Distinct fresh authorization required');
 assert(Date.parse(newGrant.expiresAt)>Date.now()&&Date.parse(newGrant.expiresAt)<=Date.parse(newGrant.issuedAt)+1800000,'Fresh bounded authority required');
 return newGrant;
}
