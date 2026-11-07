import {describe,it,expect} from 'vitest';
import {selection,digest,validateCertificate,validateCommit} from '../.github/ci/pr229-cleanup-policy.mjs';
const now=1900000000000,tool='a'.repeat(64);
const certificate=()=>({kind:'PR229_EXISTING_AUTHORITY_CLEANUP_ONLY_V1',selection:structuredClone(selection),tool,ownerEvidence:'b'.repeat(64),reauthenticatedAt:new Date(now-1000).toISOString(),ciIdentity:{run:42352389468,source:selection.source,controller:'eb9411f24f74dc3ce02d1e3fa6a834c7e0ac2d6c',artifact:13566356394,metadata:'c'.repeat(64)},inspection:{fences:'d'.repeat(64),originals:'e'.repeat(64),runtime:'f'.repeat(64)},issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+900000).toISOString()});
describe('PR229 cleanup permission limits',()=>{
 it('admits only the exact original installation with independent finite permission',()=>expect(validateCertificate(certificate(),tool,now)).toEqual(certificate()));
 for(const key of ['source','installId','buildRecordId','nextBuildId','authorizationSha256','batch','epoch'])it('refuses changed selection '+key,()=>{const c=certificate();(c.selection as any)[key]='wrong';expect(()=>validateCertificate(c,tool,now)).toThrow();});
 for(const key of ['tool','ownerEvidence','inspection','ciIdentity','kind','expiresAt','reauthenticatedAt'])it('refuses absent binding '+key,()=>{const c=certificate();delete (c as any)[key];expect(()=>validateCertificate(c,tool,now)).toThrow();});
 it('refuses expired permission and old CI authentication',()=>{expect(()=>validateCertificate(certificate(),tool,now+900000)).toThrow();const c=certificate();c.reauthenticatedAt=new Date(now-120001).toISOString();expect(()=>validateCertificate(c,tool,now)).toThrow();});
 it('refuses other tool bytes or extended lifetime',()=>{expect(()=>validateCertificate(certificate(),'0'.repeat(64),now)).toThrow();const c=certificate();c.expiresAt=new Date(now+900001).toISOString();expect(()=>validateCertificate(c,tool,now)).toThrow();});
 it('requires fresh empty checksum, exact certificate and one-use challenge',()=>{const c=certificate(),ready={nonce:'1'.repeat(64),readyAt:new Date(now).toISOString()},commit={kind:'PR229_CLEANUP_COMMIT',certificate:digest(c),nonce:ready.nonce,outputSha256:digest(''),checkedAt:new Date(now).toISOString()};expect(validateCommit(commit,ready,c,tool,now)).toEqual(commit);for(const field of ['nonce','certificate','outputSha256','kind'])expect(()=>validateCommit({...commit,[field]:'wrong'},ready,c,tool,now)).toThrow();expect(()=>validateCommit(commit,ready,c,tool,now+60001)).toThrow();expect(()=>validateCommit({...commit,checkedAt:new Date(now+1).toISOString()},ready,c,tool,now)).toThrow();});
});

import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanupTreeFence as frozenFence} from '../.github/ci/normal-cleanup-fences.mjs';
import {cleanupTreeFence as oneStatFence} from '../.github/ci/pr229-cleanup-fences.mjs';
describe('complete metadata identity with one stat per entry',()=>{
 it('matches the frozen full metadata oracle including links, directories, and empty files',()=>{const r=mkdtempSync(join(tmpdir(),'cleanup-fence-'));try{mkdirSync(join(r,'nested'));writeFileSync(join(r,'nested','file'),'original');writeFileSync(join(r,'empty'),'');symlinkSync('nested/file',join(r,'link'));expect(oneStatFence(r,()=>false)).toBe(frozenFence(r,()=>false));}finally{rmSync(r,{recursive:true});}});
 it('retains exact exclusions and detects an included byte or mode/size metadata change',()=>{const r=mkdtempSync(join(tmpdir(),'cleanup-fence-'));try{mkdirSync(join(r,'cache'));writeFileSync(join(r,'cache','runtime'),'a');writeFileSync(join(r,'compiled'),'original');const exclude=(p:string)=>p==='cache';const before=oneStatFence(r,exclude);writeFileSync(join(r,'cache','runtime'),'different');expect(oneStatFence(r,exclude)).toBe(before);expect(oneStatFence(r,exclude)).toBe(frozenFence(r,exclude));writeFileSync(join(r,'compiled'),'changed bytes');expect(oneStatFence(r,exclude)).not.toBe(before);expect(oneStatFence(r,exclude)).toBe(frozenFence(r,exclude));}finally{rmSync(r,{recursive:true});}});
});

import {parseServiceSnapshot} from '../.github/ci/pr229-cleanup-policy.mjs';
describe('complete single-response systemd snapshot',()=>{
 it('preserves the exact PID/start/active fields for both health fences',()=>{expect(parseServiceSnapshot('MainPID=1234\nExecMainStartTimestampMonotonic=998877\nActiveState=active\n')).toEqual({pid:'1234',started:'998877',active:true});expect(parseServiceSnapshot('ActiveState=failed\nMainPID=1234\nExecMainStartTimestampMonotonic=998877\n').active).toBe(false);});
 it('refuses missing, duplicate, unknown or inactive-process fields',()=>{for(const s of ['MainPID=1\nMainPID=2\nActiveState=active','MainPID=0\nExecMainStartTimestampMonotonic=1\nActiveState=active','MainPID=1\nExecMainStartTimestampMonotonic=1','MainPID=1\nExecMainStartTimestampMonotonic=1\nOther=active'])expect(()=>parseServiceSnapshot(s)).toThrow();});
});
