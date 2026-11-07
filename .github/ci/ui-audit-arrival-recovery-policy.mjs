/** Purpose-limited recovery of the interrupted UI audit temporary-build cleanup. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
export const selection=Object.freeze({source:'09f4fcb9482dca79177df93fea29039611c40550',installId:'db6f9642-b3be-4d03-bb9f-84da6a4f3d6d',buildRecordId:'928f6b3f-e167-4d39-adcd-cfd67dee6f0e',nextBuildId:'Q3Pmy99yco3QjWlBO5FE2',authorizationSha256:'7a0d720925a49ae2b8a17894a4127ecc594e36fdec25230494a725faaaa4d3d4',batch:'2de10646-5ea9-4e6e-a9fa-525c89a7650f',epoch:58});
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const runtimeBinding=r=>{const x=structuredClone(r);delete x.verifiedAt;delete x.migrationLedger.verifiedAt;return x;};
export function validateCertificate(c,tool,now=Date.now()){
 assert(c&&same(Object.keys(c).sort(),'kind selection tool ownerEvidence reauthenticatedAt ciIdentity inspection issuedAt expiresAt'.split(' ').sort()),'Exact certificate fields');
 assert(c.kind==='UI_AUDIT_REAUTHENTICATED_ARRIVAL_CLEANUP_ONLY_V1'&&same(c.selection,selection)&&c.tool===tool&&hex(tool)&&hex(c.ownerEvidence),'Exact reviewed purpose/source/tool/owner');
 assert(same(Object.keys(c.inspection).sort(),['fences','originals','runtime'])&&Object.values(c.inspection).every(hex),'Full inspection bindings');
 assert(c.ciIdentity.run===42360223365&&c.ciIdentity.source===selection.source&&c.ciIdentity.controller==='2b90f2e45ecafd732e9e772d8edc243ee98b09bc'&&c.ciIdentity.artifact===13569776347&&hex(c.ciIdentity.metadata),'Authenticated original CI identity');
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
