/** Purpose-limited recovery of the interrupted PR229 temporary-build cleanup. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
export const selection=Object.freeze({source:'2b90f2e45ecafd732e9e772d8edc243ee98b09bc',installId:'3e68c5c9-127c-40e4-bb5e-24c8e17d55d0',buildRecordId:'9a128af9-b807-4908-95e3-c6ec86a6eef1',nextBuildId:'85235qhAOdS9nGKFCT5AT',authorizationSha256:'6da196b0e55779101a9df7c77a72ebc9984f6eba3998e9f4ad6973574d82f270',batch:'6839c177-a602-45bc-8b04-91b8e7be79d6',epoch:57});
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const runtimeBinding=r=>{const x=structuredClone(r);delete x.verifiedAt;delete x.migrationLedger.verifiedAt;return x;};
export function validateCertificate(c,tool,now=Date.now()){
 assert(c&&same(Object.keys(c).sort(),'kind selection tool ownerEvidence reauthenticatedAt ciIdentity inspection issuedAt expiresAt'.split(' ').sort()),'Exact certificate fields');
 assert(c.kind==='PR229_EXISTING_AUTHORITY_CLEANUP_ONLY_V1'&&same(c.selection,selection)&&c.tool===tool&&hex(tool)&&hex(c.ownerEvidence),'Exact reviewed purpose/source/tool/owner');
 assert(same(Object.keys(c.inspection).sort(),['fences','originals','runtime'])&&Object.values(c.inspection).every(hex),'Full inspection bindings');
 assert(c.ciIdentity.run===42352389468&&c.ciIdentity.source===selection.source&&c.ciIdentity.controller==='eb9411f24f74dc3ce02d1e3fa6a834c7e0ac2d6c'&&c.ciIdentity.artifact===13566356394&&hex(c.ciIdentity.metadata),'Authenticated original CI identity');
 const start=Date.parse(c.issuedAt),end=Date.parse(c.expiresAt),auth=Date.parse(c.reauthenticatedAt);
 assert([start,end,auth,now].every(Number.isFinite)&&start<=now&&end>now&&end-start===900000&&auth<=start&&start-auth<=120000,'Fresh independent fifteen-minute cleanup permission');return c;
}
export function validateCommit(v,ready,cert,tool,now=Date.now()){
 validateCertificate(cert,tool,now);
 assert(v&&same(Object.keys(v).sort(),['certificate','kind','nonce','outputSha256','checkedAt'].sort())&&v.kind==='PR229_CLEANUP_COMMIT'&&v.certificate===digest(cert)&&v.nonce===ready.nonce&&hex(ready.nonce),'Exact one-use commit');
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
