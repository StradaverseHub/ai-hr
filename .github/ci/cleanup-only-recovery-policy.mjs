/** Cleanup-only V2: expired installation metadata never authorizes a new operation. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
// Byte-equivalent canonical JSON/hash from the original grant protocol; no private bundle dependencies.
export function canonicalJson(value){if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';return JSON.stringify(value);}
export const CLEANUP_ONLY_POLICY='onehr-same-source-postarrival-cleanup/v2';
export const SELECTION=Object.freeze({source:'a02845ba82a530ddd264f6eff1466bc106704052',installId:'9e4a0e74-943b-4d1c-aafe-8ba8b44e55fe',buildRecordId:'c987456c-c54d-4266-82c4-ab6ac834c2ad',nextBuildId:'_mO7q1sjrE7AbCuIlJjRY',authorizationSha256:'bb93a2d63e529b28804f92a484f99acecbbc6e6626a037b217e6b197a547d67e',batch:'58e10be2-f4f1-493d-bcd9-aac93700f8ec',epoch:30});
export const BASELINE='dfbcf85b1f03e6e3266df6244694079a98e17dc9';
export const ORIGIN=Object.freeze({runId:41526503926,controller:SELECTION.source,artifactId:13180656015,artifactDigest:'sha256:14e1a8425ac0aa183be17008eb90ddaa15b924be753eef034dd592b66326d1e4',witnessFingerprint:'22b76ab2d1637ded36b26fc190c3aef460b5b977db455107e1e747b55ec85891'});
export const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonicalJson(value)).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const exact=(v,keys)=>assert(v&&typeof v==='object'&&!Array.isArray(v)&&isDeepStrictEqual(Object.keys(v).sort(),keys.split(' ').sort()),'Exact cleanup-only fields required');
// Original epoch25 was explicitly recovered failed. A separately claimed owned same-source lease is mandatory.
export function validateRecoveryLease(lease){exact(lease,'batch epoch');assert(typeof lease.batch==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(lease.batch)&&lease.batch!==SELECTION.batch&&typeof lease.epoch==='string'&&/^[1-9][0-9]*$/.test(lease.epoch)&&Number.isSafeInteger(Number(lease.epoch))&&Number(lease.epoch)>SELECTION.epoch,'Fresh claimed recovery lease required; original recovered lease is metadata only');return lease;}
export function historicalInstallMetadata(bytes,{now=Date.now(),validateOriginal}={}){
 assert(Buffer.isBuffer(bytes)&&digest(bytes)===SELECTION.authorizationSha256,'Original immutable authorization bytes differ');
 assert(typeof validateOriginal==='function','Frozen original structural validator required for metadata');const grant=validateOriginal(JSON.parse(bytes),{allowExpired:true,now}); // Structural/historical validation ONLY.
 assert(bytes.equals(Buffer.from(canonicalJson(grant)+'\n'))&&Date.parse(grant.expiresAt)<=now,'Only the actually expired canonical original is metadata');
 assert(grant.source===SELECTION.source&&grant.installId===SELECTION.installId&&grant.build.buildRecordId===SELECTION.buildRecordId&&grant.build.nextBuildId===SELECTION.nextBuildId&&grant.runId===ORIGIN.runId,'Historical selection differs');
 return Object.freeze({kind:'EXPIRED_INSTALLATION_METADATA_NOT_EXECUTION_AUTHORITY',authorizationSha256:SELECTION.authorizationSha256,grant});
}
export function validateReauthentication(value,{now=Date.now(),issuing=false}={}){
 exact(value,'runId controller artifactId artifactDigest witnessFingerprint source alpha main metadataSha256 verifiedAt');
 for(const [key,wanted]of Object.entries(ORIGIN))assert(value[key]===wanted,'Original CI/artifact origin differs');
 assert(value.source===SELECTION.source&&value.main===SELECTION.source&&[BASELINE,SELECTION.source].includes(value.alpha)&&hex(value.metadataSha256),'Actual source/ref/metadata identity differs');
 const at=Date.parse(value.verifiedAt);assert(Number.isFinite(at)&&at<=now&&now-at<=(issuing?120000:900000),'Fresh authenticated original CI required');return value;
}
export function validateCleanupCertificate(cert,{controller,toolSha256,lease,reconciliationSha256,now=Date.now()}={}){
 exact(cert,'format kind policy purpose selection lease certificateId controller toolSha256 humanEvidenceSha256 reauthentication fencesSha256 runtimeSha256 reconciliationSha256 issuedAt expiresAt');
 assert(cert.format===1&&cert.kind==='EXPLICIT_POSTARRIVAL_CLEANUP_ONLY_V2'&&cert.policy===CLEANUP_ONLY_POLICY&&cert.purpose==='remove-owned-retained-next-and-consumed-packet-only'&&isDeepStrictEqual(cert.selection,SELECTION),'Cleanup-only purpose/selection required');
 assert(hex(cert.reconciliationSha256)&&(!reconciliationSha256||cert.reconciliationSha256===reconciliationSha256),'Exact reviewed reconciliation digest required');
 validateRecoveryLease(cert.lease);if(lease)assert(isDeepStrictEqual(cert.lease,lease),'Cleanup certificate belongs to another active lease');
 assert(hex(cert.certificateId)&&sha(controller)&&cert.controller===controller&&hex(toolSha256)&&cert.toolSha256===toolSha256&&hex(cert.humanEvidenceSha256)&&hex(cert.fencesSha256)&&hex(cert.runtimeSha256),'Reviewed controller/tool/owner-evidence/fences required');
 const issued=Date.parse(cert.issuedAt),end=Date.parse(cert.expiresAt);assert(Number.isFinite(issued)&&Number.isFinite(end)&&issued<=now&&end>now&&end-issued===900000,'Independent fifteen-minute cleanup-only certificate expired');
 validateReauthentication(cert.reauthentication,{now:issued,issuing:true});assert(Date.parse(cert.reauthentication.verifiedAt)<=issued&&issued-Date.parse(cert.reauthentication.verifiedAt)<=120000,'Certificate requires fresh reauthentication at issuance');return cert;
}
export function validateCleanupFences(f){
 exact(f,'source installId authorizationSha256 lease pid started boot environment active retained packet directory sourceMetadata compiledMetadata records ledger');
 assert(f.source===SELECTION.source&&f.installId===SELECTION.installId&&f.authorizationSha256===SELECTION.authorizationSha256,'Exact current installation fences required');
 validateRecoveryLease(f.lease);assert(/^[1-9][0-9]*$/.test(f.pid)&&/^[1-9][0-9]*$/.test(f.started),'Actual current process/lease required');
 for(const key of ['boot','environment','sourceMetadata','compiledMetadata'])assert(hex(f[key]),'Complete current fence digest required');
 for(const key of ['active','retained','packet','directory']){exact(f[key],'device inode');assert(Object.values(f[key]).every(n=>Number.isSafeInteger(n)&&n>0),'Positive actual directory identity required');}
 assert(new Set(['active','retained','packet','directory'].map(k=>f[k].device+':'+f[k].inode)).size===4,'Active and removable directories must be distinct');
 exact(f.ledger,'format kind rows expectedSha256 actualSha256 releaseAuthorized');assert(f.ledger.format===1&&f.ledger.kind==='READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE'&&f.ledger.rows===650&&f.ledger.releaseAuthorized===false&&hex(f.ledger.expectedSha256)&&hex(f.ledger.actualSha256),'Complete current650 ledger required');
 const names=['authorization.json','store.json','verified.json','activated.json','normal-cleanup-ready.json','audit/system-testing.json','audit/successful-build.json','audit/build-provenance.json','audit/bytes/build-bundle-files.json'];
 assert(Array.isArray(f.records)&&f.records.length===names.length&&f.records.every((r,i)=>Array.isArray(r)&&r.length===3&&r[0]===names[i]&&hex(r[1])&&Array.isArray(r[2])&&r[2].length>=8),'All original record metadata fences required');return f;
}
export function runtimeBinding(runtime){const body={...runtime,migrationLedger:{...runtime.migrationLedger}};delete body.verifiedAt;delete body.migrationLedger.verifiedAt;return body;}
export function issueCleanupCertificate({controller,toolSha256,humanEvidenceSha256,reauthentication,fences,runtime,reconciliationSha256,certificateId,now=Date.now()}){
 validateReauthentication(reauthentication,{now,issuing:true});validateCleanupFences(fences);
 assert(runtime?.source===SELECTION.source&&runtime.installId===SELECTION.installId&&runtime.buildRecordId===SELECTION.buildRecordId&&runtime.nextBuildId===SELECTION.nextBuildId&&runtime.healthStatus===200&&runtime.fullMigrationLedgerVerified===true&&runtime.migrationLedger?.rows===650,'Actual current full runtime/650 proof required');
 assert(fences?.source===SELECTION.source&&fences.lease&&fences.installId===SELECTION.installId&&fences.ledger?.rows===650&&fences.pid===runtime.pid,'Actual same-lease/process fences required');
 const cert={format:1,kind:'EXPLICIT_POSTARRIVAL_CLEANUP_ONLY_V2',policy:CLEANUP_ONLY_POLICY,purpose:'remove-owned-retained-next-and-consumed-packet-only',selection:SELECTION,lease:fences.lease,certificateId,controller,toolSha256,humanEvidenceSha256,reauthentication,fencesSha256:digest(fences),runtimeSha256:digest(runtimeBinding(runtime)),reconciliationSha256,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+900000).toISOString()};
 return validateCleanupCertificate(cert,{controller,toolSha256,lease:fences.lease,now});
}
export function validateCleanupReady(ready,cert,context){
 validateCleanupCertificate(cert,context);exact(ready,'format kind selection certificateSha256 nonce fencesSha256 readyAt');
 assert(ready.format===1&&ready.kind==='CLEANUP_ONLY_V2_READY'&&isDeepStrictEqual(ready.selection,SELECTION)&&ready.certificateSha256===digest(cert)&&hex(ready.nonce)&&ready.fencesSha256===cert.fencesSha256,'Exact certificate-bound READY required');
 const at=Date.parse(ready.readyAt),now=context.now??Date.now();assert(Number.isFinite(at)&&at>=Date.parse(cert.issuedAt)&&at<=now&&now-at<=180000,'Cleanup READY expired');return ready;
}
export function validateCleanupCommit(commit,ready,cert,context){
 validateCleanupReady(ready,cert,context);exact(commit,'format kind selection readySha256 certificateSha256 nonce sourceProof');
 assert(commit.format===1&&commit.kind==='CLEANUP_ONLY_V2_COMMIT'&&isDeepStrictEqual(commit.selection,SELECTION)&&commit.readySha256===digest(ready)&&commit.certificateSha256===digest(cert)&&commit.nonce===ready.nonce,'Exact cleanup-only COMMIT required');
 exact(commit.sourceProof,'checkedAt outputSha256');const at=Date.parse(commit.sourceProof.checkedAt),now=context.now??Date.now();assert(Number.isFinite(at)&&at>=Date.parse(ready.readyAt)&&at<=now&&now-at<=60000&&commit.sourceProof.outputSha256===digest(''),'Fresh actual zero source checksum within60 seconds required');return commit;
}
export function createCleanupCommit(ready,cert,{output,checkedAt},context){
 assert(output==='','Actual canonical checksum must be empty');return validateCleanupCommit({format:1,kind:'CLEANUP_ONLY_V2_COMMIT',selection:SELECTION,readySha256:digest(ready),certificateSha256:digest(cert),nonce:ready.nonce,sourceProof:{checkedAt,outputSha256:digest(output)}},ready,cert,context);
}

export const ORIGINAL_FILES=Object.freeze(['activate-intent.json','activate-result.json','activated.json','authorization.json','normal-cleanup-ready.json','runtime.json','store.json','verified.json']);
export function validateReconciliation(value){
 exact(value,'format kind source installId buildRecordId nextBuildId authorizationSha256 originalQueue files priorDiagnostics ownedTrees originalInstallerProcessPresent localIncompleteSha256 localStdoutSha256 localStderrSha256 observedAt');
 assert(value.format===2&&value.kind==='ONEHR_ORIGINAL_INSTALL_INTERRUPTION_RECONCILIATION','Exact V2 reconciliation required');
 for(const key of ['source','installId','buildRecordId','nextBuildId','authorizationSha256'])assert(value[key]===SELECTION[key],'Original interruption selection differs');
 exact(value.originalQueue,'batch epoch state resultSha256');assert(value.originalQueue.batch===SELECTION.batch&&value.originalQueue.epoch===SELECTION.epoch&&value.originalQueue.state==='failed'&&hex(value.originalQueue.resultSha256),'Original recovered window disposition required');
 assert(value.files&&isDeepStrictEqual(Object.keys(value.files).sort(),ORIGINAL_FILES),'Complete exact original file inventory required');
 for(const file of Object.values(value.files)){exact(file,'inode device bytes sha256 base64');assert([file.inode,file.device,file.bytes].every(n=>Number.isSafeInteger(n)&&n>0)&&file.bytes<=1024*1024&&hex(file.sha256)&&typeof file.base64==='string','Bounded original record identity required');const bytes=Buffer.from(file.base64,'base64');assert(bytes.length===file.bytes&&bytes.toString('base64')===file.base64&&digest(bytes)===file.sha256,'Exact original record bytes required');}
 assert(Array.isArray(value.priorDiagnostics)&&value.priorDiagnostics.length===0,'Observed original attempt had no cleanup session diagnostics');exact(value.ownedTrees,'next packet');assert(value.ownedTrees.next===true&&value.ownedTrees.packet===true&&value.originalInstallerProcessPresent===false,'Original owned trees and absent operation required');
 for(const key of ['localIncompleteSha256','localStdoutSha256','localStderrSha256'])assert(hex(value[key]),'Complete original local failure bytes required');assert(Number.isFinite(Date.parse(value.observedAt)),'Actual observation time required');return value;
}
/** Executable CLI boundary only: caller must await all owned operations/receipt/lock work.
 * Flush the complete terminal frame before explicitly exiting despite unrelated live handles.
 * Importing this module or calling exported service operations never exits the process.
 */
export async function finishCleanupCli(operation){
 try{const value=await operation();await new Promise((done,reject)=>process.stdout.write(JSON.stringify(value)+'\n',error=>error?reject(error):done()));process.exit(0);}
 catch{await new Promise(done=>process.stderr.write('Cleanup-only recovery refused; preserve all records and lease; reconcile before any retry.\n',()=>done()));process.exit(1);}
}
