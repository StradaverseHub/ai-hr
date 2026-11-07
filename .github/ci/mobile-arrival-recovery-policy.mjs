/** Purpose-limited recovery of the interrupted Mobile temporary-build cleanup. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
export const selection=Object.freeze({source:'109a046ef38f90514f1da458056aa09e015a47a4',installId:'5706f199-c1bb-431d-8f2e-76e9f7d44859',buildRecordId:'49afb208-faf6-453e-91c7-39f73c6d5429',nextBuildId:'7-2g6g9Ut1jO5_JQ4XqZi',authorizationSha256:'8d40322d03c1f06c1bbfa531ea48e64e4279ec62076cdec84b1b19c03e3db30f',batch:'031c4cf9-1bae-46b0-b960-7b630fc4e097',epoch:60});
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const runtimeBinding=r=>{const x=structuredClone(r);delete x.verifiedAt;delete x.migrationLedger.verifiedAt;return x;};
export function validateCertificate(c,tool,now=Date.now()){
 assert(c&&same(Object.keys(c).sort(),'kind selection tool ownerEvidence reauthenticatedAt ciIdentity inspection issuedAt expiresAt'.split(' ').sort()),'Exact certificate fields');
 assert(c.kind==='MOBILE_REAUTHENTICATED_ARRIVAL_CLEANUP_ONLY_V1'&&same(c.selection,selection)&&c.tool===tool&&hex(tool)&&hex(c.ownerEvidence),'Exact reviewed purpose/source/tool/owner');
 assert(same(Object.keys(c.inspection).sort(),['fences','originals','runtime'])&&Object.values(c.inspection).every(hex),'Full inspection bindings');
 assert(c.ciIdentity.run===42373066980&&c.ciIdentity.source===selection.source&&c.ciIdentity.controller==='4a5a9de8c7c4c7a92dcce5d55a14b736336a87e7'&&c.ciIdentity.artifact===13574652165&&hex(c.ciIdentity.metadata),'Authenticated original CI identity');
 const start=Date.parse(c.issuedAt),end=Date.parse(c.expiresAt),auth=Date.parse(c.reauthenticatedAt);
 assert([start,end,auth,now].every(Number.isFinite)&&start<=now&&end>now&&end-start===900000&&auth<=start&&start-auth<=120000,'Fresh independent fifteen-minute cleanup permission');return c;
}
export function validateCommit(v,ready,cert,tool,now=Date.now()){
 validateCertificate(cert,tool,now);
 assert(v&&same(Object.keys(v).sort(),['certificate','kind','nonce','outputSha256','checkedAt'].sort())&&v.kind==='MOBILE_CLEANUP_COMMIT'&&v.certificate===digest(cert)&&v.nonce===ready.nonce&&hex(ready.nonce),'Exact one-use commit');
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
