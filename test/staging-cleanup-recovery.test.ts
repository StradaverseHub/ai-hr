/** Synthetic pure fixtures only. No installation, service, GitHub, database or SSH access. */
import {describe,it,expect} from 'vitest';
import {realpathSync,mkdtempSync,rmSync,chmodSync,symlinkSync,linkSync,writeFileSync,readFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installationFixture} from '../.github/ci/staging-install-test-fixture.mjs';
import {issueRecoveryCapability} from '../scripts/improve/issue-cleanup-recovery.mjs';
import {installJson,installHash,validateInstallGrant} from '../.github/ci/ci-install-grant.mjs';
import {assertFreshObservation,validateRecoveryAuthorization,validateRecoveryCommit,executeRecoveryCommit,publishRecoveryRecord,readPrivateRecoveryRecord,stableLedger,validateRecoveredChildren,validateOriginalCleanupAuthority} from '../scripts/improve/staging-cleanup-recovery.mjs';
const NOW=Date.parse('2026-10-29T16:55:00Z'),iso=(delta=0)=>new Date(NOW+delta).toISOString();
function fixture(){
 const g=installationFixture(NOW-3600000).grant;
 const ci={result:'PASS',tier:'ci',source:g.source,controller:g.controller,runId:g.runId,fingerprint:g.witnessFingerprint,createdAt:g.runCreatedAt,revalidatedAt:iso()};
 const a={format:1,kind:'OWNER_AUTHORIZED_COMPLETED_INSTALL_CLEANUP_RECOVERY',policy:'aihr-owned-cleanup-recovery/v1',scope:'original-next-and-packet-only',source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,grantSha256:installHash(installJson(g)+'\n'),helperSource:'f'.repeat(40),helperSha256:'d'.repeat(64),originalCi:ci,helperCi:{...ci,source:'f'.repeat(40),runId:124},issuedAt:iso(),expiresAt:iso(1800000)};
 const ledger={format:1,kind:'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE',rows:566,expectedSha256:'1'.repeat(64),actualSha256:'2'.repeat(64),releaseAuthorized:false,verifiedAt:iso(-2000)};
 const p={kind:'FULL_RUNTIME_PREPARED_FOR_OWNED_CLEANUP_RECOVERY',nonce:'00000000-0000-4000-8000-000000000002',authorizationSha256:installHash(installJson(a)),grantSha256:a.grantSha256,source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,status:{runtime:{pid:'123',startedMonotonicUs:456,healthStatus:200,compiledByteInventory:{files:16626},migrationLedger:ledger,verifiedAt:iso(-1000)}}};
 const proof={kind:'ACTUAL_CANONICAL_RSYNC_ZERO_CHECKSUM',source:g.source,output:'',checkedAt:iso()};
 const authority={activeDirectory:{device:1,inode:123}};
 const cleanup={kind:'OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED',source:g.source,installId:g.installId,nextBuildId:g.build.nextBuildId,authorizationSha256:a.grantSha256,activeDirectory:authority.activeDirectory,verifiedAbsent:['next','packet'],auditEvidenceRetained:true};
 const events:string[]=[];
 const ops={now:()=>NOW,authority,runtime:async()=>({pid:'123',startedMonotonicUs:456}),ledger:async()=>({...ledger,verifiedAt:iso()}),intent:()=>{events.push('durable intent');},cleanup:async()=>{events.push('delete');return cleanup;}};
 return {g,a,p,proof,cleanup,authority,events,ops};
}
describe('bounded original-install cleanup recovery',()=>{
 it('does not renew the expired installation grant or mutate its bytes',()=>{
  const {g,a}=fixture(),before=installJson(g);expect(()=>validateInstallGrant(g,{now:NOW})).toThrow();
  expect(validateRecoveryAuthorization(a,g,{now:NOW,initial:true})).toBe(a);expect(installJson(g)).toBe(before);
 });
 const authorizationMutations: Record<string, (a: any) => void> = {
  scope: (a): void => { a.scope = 'install'; },
  policy: (a): void => { a.policy = 'other'; },
  source: (a): void => { a.source = 'b'.repeat(40); },
  grant: (a): void => { a.grantSha256 = '0'.repeat(64); },
  helper: (a): void => { a.helperCi.source = 'a'.repeat(40); },
  originalRun: (a): void => { a.originalCi.runId++; },
  failed: (a): void => { a.helperCi.result = 'FAIL'; },
  partial: (a): void => { a.helperCi.tier = 'focused'; },
  expired: (a): void => { a.expiresAt = iso(); },
  overlong: (a): void => { a.expiresAt = iso(1800001); },
  stale: (a): void => { a.originalCi.revalidatedAt = iso(-60001); },
  extra: (a): void => { a.extra = true; },
 };
 for(const [label,mutate] of Object.entries(authorizationMutations)){
  it('refuses '+label+' authorization',()=>{const {g,a}=fixture();mutate(a);expect(()=>validateRecoveryAuthorization(a,g,{now:NOW,initial:true})).toThrow();});
 }
 it.each([-60001,60001])('refuses observation outside the unchanged 60-second bound (%s)',delta=>expect(()=>assertFreshObservation(iso(delta),NOW)).toThrow());
 it('accepts unchanged full ledger with genuinely different observation times',async()=>{
  const f=fixture();const result=await executeRecoveryCommit(f.a,f.g,f.p,f.proof,f.ops);expect(result.cleanup).toBe(f.cleanup);expect(f.events).toEqual(['durable intent','delete']);expect(result.checkpoint.releaseAuthorized).toBe(false);
 });
 it.each(['rows','actualSha256','expectedSha256','kind','releaseAuthorized'])('refuses changed ledger %s before deletion',async key=>{
  const f=fixture();f.ops.ledger=async()=>({...f.p.status.runtime.migrationLedger,[key]:key==='rows'?567:key==='releaseAuthorized'?true:'f'.repeat(64),verifiedAt:iso()});
  await expect(executeRecoveryCommit(f.a,f.g,f.p,f.proof,f.ops)).rejects.toThrow();expect(f.events).toEqual([]);
 });
 it('refuses expiry during final actual probes without creating intent',async()=>{
  const f=fixture();let now=NOW;f.ops.now=()=>now;f.ops.ledger=async()=>{now+=60001;return {...f.p.status.runtime.migrationLedger,verifiedAt:new Date(now).toISOString()};};
  await expect(executeRecoveryCommit(f.a,f.g,f.p,f.proof,f.ops)).rejects.toThrow();expect(f.events).toEqual([]);
 });
 it('refuses changed PID or restart identity',async()=>{
  for(const runtime of [{pid:'999',startedMonotonicUs:456},{pid:'123',startedMonotonicUs:457}]){const f=fixture();f.ops.runtime=async()=>runtime;await expect(executeRecoveryCommit(f.a,f.g,f.p,f.proof,f.ops)).rejects.toThrow();expect(f.events).toEqual([]);}
 });
 it('never deletes when durable intent publication fails',async()=>{
  const f=fixture();f.ops.intent=()=>{throw Error('fsync failure');};await expect(executeRecoveryCommit(f.a,f.g,f.p,f.proof,f.ops)).rejects.toThrow('fsync failure');expect(f.events).toEqual([]);
 });
 it('refuses partial native deletion and altered active inode',()=>{
  const f=fixture();expect(()=>validateRecoveredChildren({...f.cleanup,verifiedAbsent:['next']},f.g,f.authority)).toThrow();expect(()=>validateRecoveredChildren({...f.cleanup,activeDirectory:{device:1,inode:124}},f.g,f.authority)).toThrow();
 });
 it('refuses nonzero source checksum and a foreign prepared token',()=>{
  const f=fixture();expect(()=>validateRecoveryCommit(f.a,f.g,f.p,{...f.proof,output:'changed file'},{now:NOW})).toThrow();expect(()=>validateRecoveryCommit(f.a,f.g,{...f.p,installId:'foreign'},f.proof,{now:NOW})).toThrow();
 });
});
describe('private durable recovery evidence',()=>{
 it('writes once, fsyncs file then directory, preserves original and refuses replay',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'cleanup-test-')));chmodSync(dir,0o700);const p=join(dir,'record.json'),calls:string[]=[];
  try{publishRecoveryRecord(p,{intent:true},{openSync,writeFileSync,closeSync,fsyncSync:(fd:number)=>{calls.push('sync');fsyncSync(fd);}});expect(calls).toEqual(['sync','sync']);const before=readFileSync(p);expect(()=>publishRecoveryRecord(p,{intent:false})).toThrow();expect(readFileSync(p)).toEqual(before);expect(JSON.parse(readPrivateRecoveryRecord(p).toString())).toEqual({intent:true});}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('refuses symlink, hardlink, oversized and shared records',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'cleanup-test-')));chmodSync(dir,0o700);const p=join(dir,'record'),other=join(dir,'other');
  try{writeFileSync(p,'{}',{mode:0o600});symlinkSync(p,other);expect(()=>readPrivateRecoveryRecord(other)).toThrow();rmSync(other);linkSync(p,other);expect(()=>readPrivateRecoveryRecord(p)).toThrow();rmSync(other);expect(()=>readPrivateRecoveryRecord(p,1)).toThrow();chmodSync(p,0o644);expect(()=>readPrivateRecoveryRecord(p)).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it.each([1,2])('propagates fsync failure %s to stop the destructive caller',failAt=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'cleanup-test-')));chmodSync(dir,0o700);let calls=0;
  try{expect(()=>publishRecoveryRecord(join(dir,'intent'),{}, {openSync,writeFileSync,closeSync,fsyncSync:(fd:number)=>{if(++calls===failAt)throw Error('disk failure');fsyncSync(fd);}})).toThrow('disk failure');}finally{rmSync(dir,{recursive:true,force:true});}
 });
});

describe('authenticated cleanup issuer',()=>{
 function issuerFixture(){
  const f=fixture();const events:string[]=[];
  const evidence=(ci:any)=>({result:'PASS',tier:'ci',sha:ci.source,controller:ci.controller,runId:ci.runId,fingerprint:ci.fingerprint,build:{canonicalCandidateInputsVerified:true},evidenceDirectory:'/private/synthetic'});
  const verifier=(name:string,ci:any)=>({verify:async()=>{events.push('full '+name);return evidence(ci);},revalidate:async()=>{events.push('revalidate '+name);return true;},run:()=>({created_at:ci.createdAt})});
  return {...f,events,original:verifier('original',f.a.originalCi),helper:verifier('helper',f.a.helperCi)};
 }
 it('reconstructs both whole gates then refreshes both before issuing a cleanup-only capability',async()=>{
  const f=issuerFixture();const result=await issueRecoveryCapability({grant:f.g,helperSource:f.a.helperSource,helperBytes:Buffer.from('synthetic helper'),original:f.original,helper:f.helper,now:()=>NOW});
  expect(f.events).toEqual(['full original','full helper','revalidate original','revalidate helper']);expect(result.authorization.helperSha256).toBe(installHash('synthetic helper'));expect(result.authorization.scope).toBe('original-next-and-packet-only');expect(result.releaseAuthorized).toBe(false);
 });
 it.each(['original','helper'])('refuses missing or unauthenticated %s witness',async key=>{
  const f=issuerFixture();(key==='original'?f.original:f.helper).verify=async()=>{throw Error('API or artifact digest refused');};await expect(issueRecoveryCapability({grant:f.g,helperSource:f.a.helperSource,helperBytes:Buffer.from('test'),original:f.original,helper:f.helper,now:()=>NOW})).rejects.toThrow('API or artifact digest refused');expect(f.events.some(e=>e.startsWith('revalidate'))).toBe(false);
 });
 it('refuses a gate revoked during final authenticated refresh',async()=>{
  const f=issuerFixture();f.helper.revalidate=async()=>{throw Error('artifact identity changed');};await expect(issueRecoveryCapability({grant:f.g,helperSource:f.a.helperSource,helperBytes:Buffer.from('test'),original:f.original,helper:f.helper,now:()=>NOW})).rejects.toThrow('artifact identity changed');
 });
});

describe('original authority is retained historical evidence',()=>{
 function originalFixture(){
  const f=fixture(),g=f.g,h=f.a.grantSha256;
  const activatedAt=new Date(Date.parse(g.issuedAt)+1000).toISOString();
  const sourceProof={format:1,kind:'OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP',source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256:h,witnessFingerprint:g.witnessFingerprint,outputSha256:installHash(''),checkedAt:activatedAt};
  const directory={device:1,inode:99},activeDirectory={device:1,inode:100},retainedDirectory={device:1,inode:101};
  const activated={format:1,kind:'CI_BUILD_BYTES_ACTIVATED_NOT_FULL_ARRIVAL',source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256:h,activation:{activeDirectory,retainedDirectory},activatedAt};
  const authority={format:1,kind:'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL',sourceDirectory:'/opt/ai-hr',source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256:h,witnessFingerprint:g.witnessFingerprint,directory,activeDirectory,retainedDirectory,packetDirectory:{device:1,inode:102},sourceProof,sourceProofSha256:installHash(installJson(sourceProof)),authorizedAt:new Date(Date.parse(g.issuedAt)+2000).toISOString()};
  return {...f,activated,authority,directory};
 }
 it('accepts genuine original activation/authority within the original expired grant without renewing it',()=>{
  const f=originalFixture();expect(validateOriginalCleanupAuthority(f.authority,f.activated,f.g,f.a.grantSha256,f.directory)).toBe(f.authority);expect(()=>validateInstallGrant(f.g,{now:NOW})).toThrow();
 });
 it.each(['lateAuthority','foreignActivation','changedInode','rewrittenProof'])('refuses %s historical authority',key=>{
  const f=originalFixture();if(key==='lateAuthority')f.authority.authorizedAt=new Date(Date.parse(f.g.expiresAt)+1).toISOString();if(key==='foreignActivation')f.activated.source='f'.repeat(40);if(key==='changedInode')f.authority.retainedDirectory={device:1,inode:999};if(key==='rewrittenProof')f.authority.sourceProof.checkedAt=iso();
  expect(()=>validateOriginalCleanupAuthority(f.authority,f.activated,f.g,f.a.grantSha256,f.directory)).toThrow();
 });
});
