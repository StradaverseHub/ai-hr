/** Cleanup-only V1: expired installation metadata never authorizes a new operation. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
// Byte-equivalent canonical JSON/hash from the original grant protocol; no private bundle dependencies.
export function canonicalJson(value){if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';return JSON.stringify(value);}
export const CLEANUP_ONLY_POLICY='same-source-postarrival-cleanup/v1';
export const SELECTION=Object.freeze({source:'194e140e0f714bc9cf4820acdf8c4451da11988c',installId:'891348b7-8b26-4448-b4f2-6478c44d1971',buildRecordId:'6ac398b7-097b-4b87-81b1-b366e103baa0',nextBuildId:'dfIipdryKEwOTVM1qeDde',authorizationSha256:'c81e356b51052de06fd24e167611b7e4d9ce5daa47b6d9ce288507d89f85d601',batch:'5742055b-4419-4657-84c4-ba331a8e33cc',epoch:12});
export const ORIGIN=Object.freeze({runId:41208438562,controller:SELECTION.source,artifactId:13045407420,artifactDigest:'sha256:50337aa4f4c3f03a1b2e4e0f711c036c685568e6f9ef78ec1b1517285619b891',witnessFingerprint:'b24e69daed9b653f22ba132cdd47c87683973d744dc34c4652f9efa943b91197'});
export const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonicalJson(value)).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const exact=(v,keys)=>assert(v&&typeof v==='object'&&!Array.isArray(v)&&isDeepStrictEqual(Object.keys(v).sort(),keys.split(' ').sort()),'Exact cleanup-only fields required');
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
 assert(value.source===SELECTION.source&&value.alpha===SELECTION.source&&value.main===SELECTION.source&&hex(value.metadataSha256),'Actual source/ref/metadata identity differs');
 const at=Date.parse(value.verifiedAt);assert(Number.isFinite(at)&&at<=now&&now-at<=(issuing?120000:900000),'Fresh authenticated original CI required');return value;
}
export function validateCleanupCertificate(cert,{controller,toolSha256,now=Date.now()}={}){
 exact(cert,'format kind policy purpose selection certificateId controller toolSha256 humanEvidenceSha256 reauthentication fencesSha256 runtimeSha256 issuedAt expiresAt');
 assert(cert.format===1&&cert.kind==='EXPLICIT_POSTARRIVAL_CLEANUP_ONLY_V1'&&cert.policy===CLEANUP_ONLY_POLICY&&cert.purpose==='remove-owned-retained-next-and-consumed-packet-only'&&isDeepStrictEqual(cert.selection,SELECTION),'Cleanup-only purpose/selection required');
 assert(hex(cert.certificateId)&&sha(controller)&&cert.controller===controller&&hex(toolSha256)&&cert.toolSha256===toolSha256&&hex(cert.humanEvidenceSha256)&&hex(cert.fencesSha256)&&hex(cert.runtimeSha256),'Reviewed controller/tool/owner-evidence/fences required');
 const issued=Date.parse(cert.issuedAt),end=Date.parse(cert.expiresAt);assert(Number.isFinite(issued)&&Number.isFinite(end)&&issued<=now&&end>now&&end-issued===900000,'Independent fifteen-minute cleanup-only certificate expired');
 validateReauthentication(cert.reauthentication,{now:issued,issuing:true});assert(Date.parse(cert.reauthentication.verifiedAt)<=issued&&issued-Date.parse(cert.reauthentication.verifiedAt)<=120000,'Certificate requires fresh reauthentication at issuance');return cert;
}
export function validateCleanupFences(f){
 exact(f,'source installId authorizationSha256 lease pid started boot environment active retained packet directory sourceMetadata compiledMetadata records ledger');
 assert(f.source===SELECTION.source&&f.installId===SELECTION.installId&&f.authorizationSha256===SELECTION.authorizationSha256,'Exact current installation fences required');
 exact(f.lease,'batch epoch');assert(f.lease.batch===SELECTION.batch&&f.lease.epoch==='12'&&/^[1-9][0-9]*$/.test(f.pid)&&/^[1-9][0-9]*$/.test(f.started),'Actual current process/lease required');
 for(const key of ['boot','environment','sourceMetadata','compiledMetadata'])assert(hex(f[key]),'Complete current fence digest required');
 for(const key of ['active','retained','packet','directory']){exact(f[key],'device inode');assert(Object.values(f[key]).every(n=>Number.isSafeInteger(n)&&n>0),'Positive actual directory identity required');}
 assert(new Set(['active','retained','packet','directory'].map(k=>f[k].device+':'+f[k].inode)).size===4,'Active and removable directories must be distinct');
 exact(f.ledger,'format kind rows expectedSha256 actualSha256 releaseAuthorized');assert(f.ledger.format===1&&f.ledger.kind==='READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE'&&f.ledger.rows===636&&f.ledger.releaseAuthorized===false&&hex(f.ledger.expectedSha256)&&hex(f.ledger.actualSha256),'Complete current636 ledger required');
 const names=['authorization.json','store.json','verified.json','activated.json','audit/system-testing.json','audit/successful-build.json','audit/build-provenance.json','audit/bytes/build-bundle-files.json'];
 assert(Array.isArray(f.records)&&f.records.length===names.length&&f.records.every((r,i)=>Array.isArray(r)&&r.length===3&&r[0]===names[i]&&hex(r[1])&&Array.isArray(r[2])&&r[2].length>=8),'All original record metadata fences required');return f;
}
export function runtimeBinding(runtime){const body={...runtime,migrationLedger:{...runtime.migrationLedger}};delete body.verifiedAt;delete body.migrationLedger.verifiedAt;return body;}
export function issueCleanupCertificate({controller,toolSha256,humanEvidenceSha256,reauthentication,fences,runtime,certificateId,now=Date.now()}){
 validateReauthentication(reauthentication,{now,issuing:true});validateCleanupFences(fences);
 assert(runtime?.source===SELECTION.source&&runtime.installId===SELECTION.installId&&runtime.buildRecordId===SELECTION.buildRecordId&&runtime.nextBuildId===SELECTION.nextBuildId&&runtime.healthStatus===200&&runtime.fullMigrationLedgerVerified===true&&runtime.migrationLedger?.rows===636,'Actual current full runtime/636 proof required');
 assert(fences?.source===SELECTION.source&&fences.lease?.batch===SELECTION.batch&&fences.lease.epoch==='12'&&fences.installId===SELECTION.installId&&fences.ledger?.rows===636&&fences.pid===runtime.pid,'Actual same-lease/process fences required');
 const cert={format:1,kind:'EXPLICIT_POSTARRIVAL_CLEANUP_ONLY_V1',policy:CLEANUP_ONLY_POLICY,purpose:'remove-owned-retained-next-and-consumed-packet-only',selection:SELECTION,certificateId,controller,toolSha256,humanEvidenceSha256,reauthentication,fencesSha256:digest(fences),runtimeSha256:digest(runtimeBinding(runtime)),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+900000).toISOString()};
 return validateCleanupCertificate(cert,{controller,toolSha256,now});
}
export function validateCleanupReady(ready,cert,context){
 validateCleanupCertificate(cert,context);exact(ready,'format kind selection certificateSha256 nonce fencesSha256 readyAt');
 assert(ready.format===1&&ready.kind==='CLEANUP_ONLY_V1_READY'&&isDeepStrictEqual(ready.selection,SELECTION)&&ready.certificateSha256===digest(cert)&&hex(ready.nonce)&&ready.fencesSha256===cert.fencesSha256,'Exact certificate-bound READY required');
 const at=Date.parse(ready.readyAt),now=context.now??Date.now();assert(Number.isFinite(at)&&at>=Date.parse(cert.issuedAt)&&at<=now&&now-at<=180000,'Cleanup READY expired');return ready;
}
export function validateCleanupCommit(commit,ready,cert,context){
 validateCleanupReady(ready,cert,context);exact(commit,'format kind selection readySha256 certificateSha256 nonce sourceProof');
 assert(commit.format===1&&commit.kind==='CLEANUP_ONLY_V1_COMMIT'&&isDeepStrictEqual(commit.selection,SELECTION)&&commit.readySha256===digest(ready)&&commit.certificateSha256===digest(cert)&&commit.nonce===ready.nonce,'Exact cleanup-only COMMIT required');
 exact(commit.sourceProof,'checkedAt outputSha256');const at=Date.parse(commit.sourceProof.checkedAt),now=context.now??Date.now();assert(Number.isFinite(at)&&at>=Date.parse(ready.readyAt)&&at<=now&&now-at<=60000&&commit.sourceProof.outputSha256===digest(''),'Fresh actual zero source checksum within60 seconds required');return commit;
}
export function createCleanupCommit(ready,cert,{output,checkedAt},context){
 assert(output==='','Actual canonical checksum must be empty');return validateCleanupCommit({format:1,kind:'CLEANUP_ONLY_V1_COMMIT',selection:SELECTION,readySha256:digest(ready),certificateSha256:digest(cert),nonce:ready.nonce,sourceProof:{checkedAt,outputSha256:digest(output)}},ready,cert,context);
}

/** Executable CLI boundary only: caller must await all owned operations/receipt/lock work.
 * Flush the complete terminal frame before explicitly exiting despite unrelated live handles.
 * Importing this module or calling exported service operations never exits the process.
 */
export async function finishCleanupCli(operation){
 try{const value=await operation();await new Promise((done,reject)=>process.stdout.write(JSON.stringify(value)+'\n',error=>error?reject(error):done()));process.exit(0);}
 catch{await new Promise(done=>process.stderr.write('Cleanup-only recovery refused; preserve all records and lease; reconcile before any retry.\n',()=>done()));process.exit(1);}
}
