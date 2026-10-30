/** Single-install cleanup completion. Never an installation grant or source-transfer authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {installJson,validateInstallGrant} from './ci-install-grant.mjs';

export const CLEANUP_SELECTION=Object.freeze({
 source:'f2ca511f4ded441399fd30437bb75553bb92efbb',
 installId:'777914fb-0a46-4252-8449-6d145be6522d',
 buildRecordId:'11dc0078-124c-4168-ade0-14cab716eecb',
 nextBuildId:'7N7c7Fk5tpJmI7C-5QGwf',
 authorizationSha256:'affa0f3cd646d96aa5ed1423aa061763d071ae51a2cf609c4b73feece0d2af71',
 authoritySha256:'b82d5ed921b45171b486f3ee5d766b59cb7cb63aba6759a9f543bee2acfe1f3e',
 batch:'34ff2c4d-7c25-481a-b078-68a07a139d2c',epoch:7,
});
export const digest=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>assert(value&&isDeepStrictEqual(Object.keys(value).sort(),keys.slice().sort()),'Exact cleanup-only shape required');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function stableCleanupLedger(ledger){
 assert(ledger?.kind==='READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE'&&ledger.releaseAuthorized===false&&ledger.rows===581
  &&hex(ledger.expectedSha256)&&hex(ledger.actualSha256),'Complete validated installed 581-row ledger required');
 return {kind:ledger.kind,rows:ledger.rows,expectedSha256:ledger.expectedSha256,actualSha256:ledger.actualSha256,releaseAuthorized:false};
}
export function validateCleanupFences(value){
 exact(value,['source','batch','epoch','pid','bootIdSha256','environmentSha256','ledgerSha256','sourceStatSha256','compiledStatSha256','originalRecordsSha256','nextBuildId','activeDirectory','retainedDirectory','packetDirectory']);
 assert(value.source===CLEANUP_SELECTION.source&&value.batch===CLEANUP_SELECTION.batch&&value.epoch===CLEANUP_SELECTION.epoch
  &&value.nextBuildId===CLEANUP_SELECTION.nextBuildId&&/^[1-9][0-9]*$/.test(value.pid),'Exact source, build, process and lease fences required');
 for(const key of ['bootIdSha256','environmentSha256','ledgerSha256','sourceStatSha256','compiledStatSha256','originalRecordsSha256'])assert(hex(value[key]),'Complete digest fence required: '+key);
 for(const key of ['activeDirectory','retainedDirectory','packetDirectory']){
  exact(value[key],['device','inode']);assert(Object.values(value[key]).every(n=>Number.isSafeInteger(n)&&n>0),'Positive safe owned directory identity required');
 }
 assert(new Set(['activeDirectory','retainedDirectory','packetDirectory'].map(k=>value[k].device+':'+value[k].inode)).size===3,'Active and owned trees must be distinct');
 return value;
}
export function historicalCleanupSelection(grantBytes,authorityBytes,{now=Date.now()}={}){
 assert(digest(grantBytes)===CLEANUP_SELECTION.authorizationSha256&&digest(authorityBytes)===CLEANUP_SELECTION.authoritySha256,'Original immutable cleanup records differ');
 const grant=validateInstallGrant(JSON.parse(grantBytes),{allowExpired:true,now}),authority=JSON.parse(authorityBytes);
 assert(grantBytes.toString()===installJson(grant)+'\n','Original canonical grant bytes required');
 for(const key of ['source','installId'])assert(grant[key]===CLEANUP_SELECTION[key],'Wrong historical installation');
 for(const key of ['buildRecordId','nextBuildId'])assert(grant.build[key]===CLEANUP_SELECTION[key],'Wrong historical build');
 assert(Date.parse(grant.expiresAt)<now,'This route only completes an expired, already activated installation');
 assert(authority.kind==='OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL'&&authority.authorizationSha256===CLEANUP_SELECTION.authorizationSha256
  &&authority.source===grant.source&&authority.installId===grant.installId&&authority.buildRecordId===grant.build.buildRecordId&&authority.nextBuildId===grant.build.nextBuildId
  &&Date.parse(authority.authorizedAt)<=Date.parse(grant.expiresAt),'Pre-expiry immutable cleanup authority required');
 return {grant,authority}; // Historical inspection does not authorize execution.
}
export function validateCleanupExecutionApproval(value,{controller,now=Date.now()}={}){
 exact(value,['format','kind','selection','controller','toolSha256','approvedAt','expiresAt','humanEvidenceSha256']);
 assert(value.format===1&&value.kind==='EXPLICIT_SINGLE_POST_EXPIRY_OWNED_CLEANUP'
  &&isDeepStrictEqual(value.selection,CLEANUP_SELECTION)&&/^[a-f0-9]{40}$/.test(controller??'')&&value.controller===controller
  &&hex(value.humanEvidenceSha256)&&hex(value.toolSha256),'Separately approved exact cleanup-only execution required');
 const at=Date.parse(value.approvedAt),end=Date.parse(value.expiresAt);
 assert(Number.isFinite(at)&&Number.isFinite(end)&&at<=now&&now<=end&&end-at<=30*60*1000,'Fresh bounded cleanup-only approval required');
 return value;
}
export function createCleanupPreparation({nonce,fences,runtime,approvalSha256,toolSha256,now=Date.now()}){
 assert(hex(nonce)&&hex(approvalSha256)&&hex(toolSha256),'Bounded nonce and reviewed authority/tool digests required');
 assert(runtime?.source===CLEANUP_SELECTION.source&&runtime.installId===CLEANUP_SELECTION.installId
  &&runtime.buildRecordId===CLEANUP_SELECTION.buildRecordId&&runtime.nextBuildId===CLEANUP_SELECTION.nextBuildId
  &&runtime.healthStatus===200&&runtime.fullMigrationLedgerVerified===true,'Complete actual runtime audit required');
 validateCleanupFences(fences);
 return {format:1,kind:'CLEANUP_PREPARED_NOT_COMMITTED',selection:CLEANUP_SELECTION,nonce,fences,
  runtimeSha256:digest(installJson(runtime)),approvalSha256,toolSha256,preparedAt:new Date(now).toISOString(),expiresAt:new Date(now+180000).toISOString()};
}
export function validateCleanupCommit(request,preparation,{fences,approvalSha256,toolSha256,now=Date.now()}={}){
 exact(request,['format','kind','selection','nonce','preparationSha256','approvalSha256','toolSha256','checksumCheckedAt','checksumOutputSha256']);
 assert(preparation?.kind==='CLEANUP_PREPARED_NOT_COMMITTED'&&isDeepStrictEqual(preparation.selection,CLEANUP_SELECTION)
  &&request.format===1&&request.kind==='COMMIT_SINGLE_POST_ARRIVAL_OWNED_CLEANUP'&&isDeepStrictEqual(request.selection,CLEANUP_SELECTION)
  &&request.nonce===preparation.nonce&&hex(request.nonce)&&request.preparationSha256===digest(installJson(preparation))
  &&request.approvalSha256===approvalSha256&&approvalSha256===preparation.approvalSha256
  &&request.toolSha256===toolSha256&&toolSha256===preparation.toolSha256,'Cleanup challenge or authority differs');
 const prepared=Date.parse(preparation.preparedAt),end=Date.parse(preparation.expiresAt),observed=Date.parse(request.checksumCheckedAt);
 assert(Number.isFinite(prepared)&&Number.isFinite(end)&&end-prepared===180000&&now>=prepared&&now<=end,'Cleanup preparation expired');
 assert(Number.isFinite(observed)&&observed>=prepared&&observed<=now&&now-observed<=60000&&request.checksumOutputSha256===digest(''),'New actual zero source checksum within 60 seconds required');
 validateCleanupFences(fences);validateCleanupFences(preparation.fences);
 assert(isDeepStrictEqual(fences,preparation.fences),'Active runtime, owned resources or staging lease changed');
 return request;
}
