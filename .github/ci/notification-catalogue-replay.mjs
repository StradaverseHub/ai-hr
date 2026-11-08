/** Closed development replay metadata only. No token, DDL, SQL, flags or authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const files=Object.freeze({
 'test/notification-final-catalogue-baseline.test.ts':'baseline',
 'test/notification-final-catalogue-oid-shift.test.ts':'oid-shift',
});
export const CATALOGUE_REPLAY_SOURCES=Object.freeze({
 ownerSha256:'test/fixtures/notification-worker/final-catalogue-replay-prerequisite.ts',
 contractSha256:'.github/ci/notification-catalogue-replay.mjs',
});
const keys=(value,wanted)=>{assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...wanted].sort());};
const sha=value=>assert(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value));
export function catalogueReplayRoleHash(roles){
 const canonical=value=>{
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'){assert(Number.isFinite(value));return JSON.stringify(value);}
  if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';
  assert(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype);
  return'{'+Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 };
 return createHash('sha256').update(canonical(roles)).digest('hex');
}
/** @param {readonly string[]} selected @returns {'baseline'|'oid-shift'|null} */
export function catalogueReplayMode(selected){
 assert(Array.isArray(selected));const found=selected.filter(file=>Object.hasOwn(files,file));
 if(!found.length)return null;assert.equal(selected.length,1,'Catalogue replay requires an exact sole unit');
 return files[found[0]];
}
/** A source-bound observation, never authentication. The caller must first use
 * actual controller admission and supply independently observed source hashes. */
export function validateCatalogueReplayReceipt(receipt,binding,sourceHashes){
 const mode=catalogueReplayMode(binding.batchFiles);assert(mode,'Unregistered catalogue replay');
 keys(sourceHashes,Object.keys(CATALOGUE_REPLAY_SOURCES));for(const value of Object.values(sourceHashes))sha(value);
 keys(receipt,['version','kind','mode','candidate','controller','runId','attempt','unit','planFingerprint','sourceHashes','session','roleCatalogSha256','allocation','objectsAbsent','quiescence','releaseAuthorized']);
 assert.equal(receipt.version,1);assert.equal(receipt.kind,'NATIVE_CATALOGUE_REPLAY_PREREQUISITE_NOT_PROFILE');assert.equal(receipt.mode,mode);
 for(const key of ['candidate','controller','runId','attempt','unit','planFingerprint'])assert.equal(receipt[key],binding[key]);
 assert.deepEqual(receipt.sourceHashes,sourceHashes);sha(receipt.roleCatalogSha256);assert.equal(receipt.objectsAbsent,true);assert.equal(receipt.releaseAuthorized,false);
 const s=receipt.session;keys(s,['database','pid','backendStart','postmasterStart','versionNumber','versionText','session','current','loopback']);
 assert.equal(s.database,'postgres');assert(Number.isSafeInteger(s.pid)&&s.pid>0);assert(typeof s.backendStart==='string'&&s.backendStart.length>0&&s.backendStart.length<=128);
 assert(typeof s.postmasterStart==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(s.postmasterStart));
 assert(Number.isSafeInteger(s.versionNumber)&&s.versionNumber>=160000&&s.versionNumber<170000);assert(typeof s.versionText==='string'&&/^PostgreSQL 16\./.test(s.versionText));
 assert.equal(s.session,'postgres');assert.equal(s.current,'postgres');assert.equal(s.loopback,true);
 const q=receipt.quiescence;keys(q,['sameCluster','ownedPresent','observerPid','observerStart','observedAt','postmasterStart']);
 assert.equal(q.sameCluster,true);assert.equal(q.ownedPresent,false);assert.equal(q.postmasterStart,s.postmasterStart);
 assert(Number.isSafeInteger(q.observerPid)&&q.observerPid>0);for(const key of ['observerStart','observedAt'])assert(typeof q[key]==='string'&&q[key].length>0&&q[key].length<=128);
 if(mode==='baseline')assert.equal(receipt.allocation,null);
 else{
  const a=receipt.allocation;keys(a,['namespaceOid','enumOid','enumArrayOid','heapOid','rowTypeOid','rowArrayOid','nativeRowsSha256','dependenciesSha256','facts']);
  const oids=['namespaceOid','enumOid','enumArrayOid','heapOid','rowTypeOid','rowArrayOid'].map(key=>a[key]);
  assert(oids.every(value=>Number.isSafeInteger(value)&&value>=16384&&value<=4294967295));assert.equal(new Set(oids).size,6);
  sha(a.nativeRowsSha256);sha(a.dependenciesSha256);
  keys(a.facts,['objects','dependencies','shared']);
  assert(Array.isArray(a.facts.objects)&&a.facts.objects.length>0&&a.facts.objects.length<=32);
  assert(Array.isArray(a.facts.dependencies)&&a.facts.dependencies.length>0&&a.facts.dependencies.length<=128);
  assert(Array.isArray(a.facts.shared)&&a.facts.shared.length<=32);
  assert(Buffer.byteLength(JSON.stringify(a.facts))<=24576,'Complete allocation witness exceeds its unchanged prerequisite member bound');
  assert.equal(catalogueReplayRoleHash(a.facts.objects),a.nativeRowsSha256);
  assert.equal(catalogueReplayRoleHash({dependencies:a.facts.dependencies,shared:a.facts.shared}),a.dependenciesSha256);
 }
 return receipt;
}
