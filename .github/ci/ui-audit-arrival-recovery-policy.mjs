/** Purpose-limited recovery of the interrupted UI audit temporary-build cleanup. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
export const selection=Object.freeze({source:'4a5a9de8c7c4c7a92dcce5d55a14b736336a87e7',installId:'6b18d867-94db-42e9-895c-3808a043d184',buildRecordId:'8b8ace1b-bc98-4fdc-b0b1-741d9f9f064b',nextBuildId:'T1zBIDei7Grrkj7LmjnrV',authorizationSha256:'1c7e24cd58c4a972cf8ca3b27d2ade363820157df09fcc376806934d588d10a4',batch:'5e71c78d-6c55-4800-8ab9-2958c101fe41',epoch:59});
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const runtimeBinding=r=>{const x=structuredClone(r);delete x.verifiedAt;delete x.migrationLedger.verifiedAt;return x;};
export function validateCertificate(c,tool,now=Date.now()){
 assert(c&&same(Object.keys(c).sort(),'kind selection tool ownerEvidence reauthenticatedAt ciIdentity inspection issuedAt expiresAt'.split(' ').sort()),'Exact certificate fields');
 assert(c.kind==='UI_AUDIT_REAUTHENTICATED_ARRIVAL_CLEANUP_ONLY_V1'&&same(c.selection,selection)&&c.tool===tool&&hex(tool)&&hex(c.ownerEvidence),'Exact reviewed purpose/source/tool/owner');
 assert(same(Object.keys(c.inspection).sort(),['fences','originals','runtime'])&&Object.values(c.inspection).every(hex),'Full inspection bindings');
 assert(c.ciIdentity.run===42367684288&&c.ciIdentity.source===selection.source&&c.ciIdentity.controller==='2b90f2e45ecafd732e9e772d8edc243ee98b09bc'&&c.ciIdentity.artifact===13572741570&&hex(c.ciIdentity.metadata),'Authenticated original CI identity');
 const start=Date.parse(c.issuedAt),end=Date.parse(c.expiresAt),auth=Date.parse(c.reauthenticatedAt);
 assert([start,end,auth,now].every(Number.isFinite)&&start<=now&&end>now&&end-start===900000&&auth<=start&&start-auth<=120000,'Fresh independent fifteen-minute cleanup permission');return c;
}
export function validateCommit(v,ready,cert,tool,now=Date.now()){
 validateCertificate(cert,tool,now);
 assert(v&&same(Object.keys(v).sort(),['certificate','kind','nonce','outputSha256','checkedAt'].sort())&&v.kind==='UI_AUDIT_CLEANUP_COMMIT'&&v.certificate===digest(cert)&&v.nonce===ready.nonce&&hex(ready.nonce),'Exact one-use commit');
 const at=Date.parse(v.checkedAt),r=Date.parse(ready.readyAt);
 assert(Number.isFinite(at)&&Number.isFinite(r)&&r>=Date.parse(cert.issuedAt)&&r<=at&&at<=now&&now-at<=60000&&now-r<=180000&&v.outputSha256===digest(''),'Fresh actual empty canonical checksum');return v;
}
/** One real systemd response supplies the same three service fields as separate queries. */
export function parseServiceSnapshot(text){
 const rows=text.trim().split('\n').map(line=>line.split('='));
 assert(rows.every(r=>r.length===2)&&rows.length===3,'Exact service snapshot lines');
 const p=Object.fromEntries(rows);assert(same(Object.keys(p).sort(),['ActiveState','ExecMainStartTimestampMonotonic','MainPID']),'Exact distinct service fields');
 assert(/^[1-9][0-9]*$/.test(p.MainPID)&&/^[1-9][0-9]*$/.test(p.ExecMainStartTimestampMonotonic),'Live process and start required');
 return {pid:p.MainPID,started:p.ExecMainStartTimestampMonotonic,active:p.ActiveState==='active'};
}

/** Fresh authority applies only to the already activated exact installation; never renews its grant. */
export function createCleanupAuthority({grant:g,authorizationSha256,directory,packetDirectory,activated,certificate,commit,ready,tool,now=Date.now()}){
 validateCommit(commit,ready,certificate,tool,now);
 assert(g.source===selection.source&&g.installId===selection.installId&&g.build.buildRecordId===selection.buildRecordId&&g.build.nextBuildId===selection.nextBuildId&&digest(Buffer.from(canonical(g)+'\n'))===authorizationSha256&&authorizationSha256===selection.authorizationSha256,'Original grant byte identity required');
 assert(Date.parse(g.expiresAt)<now,'Only expired original installation permission is recovered');
 for(const key of ['source','installId','buildRecordId','nextBuildId','authorizationSha256'])assert(activated[key]===selection[key],'Original activated tuple required');
 for(const value of [directory,packetDirectory,activated.activation.activeDirectory,activated.activation.retainedDirectory])assert(value&&same(Object.keys(value).sort(),['device','inode'])&&Object.values(value).every(v=>Number.isSafeInteger(v)&&v>0),'Exact real directory identities required');
 assert(!same(activated.activation.activeDirectory,activated.activation.retainedDirectory)&&!same(directory,packetDirectory),'Distinct owned directory identities required');
 const request={certificate:digest(certificate),commit,inspection:certificate.inspection};
 return {format:1,kind:'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL',sourceDirectory:'/opt/ai-hr',source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256,witnessFingerprint:g.witnessFingerprint,directory,activeDirectory:activated.activation.activeDirectory,retainedDirectory:activated.activation.retainedDirectory,packetDirectory,sourceProof:request,sourceProofSha256:digest(request),authorizedAt:new Date(now).toISOString()};
}
