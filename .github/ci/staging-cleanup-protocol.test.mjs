/** Pure cleanup authority/result refusal fixtures. No resource deletion occurs here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {createCleanupRequest,validateCleanupRequest} from './staging-cleanup-protocol.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {validateFinalCleanup} from './staging-ci-promotion.mjs';
function fixture(){
 const {grant}=installationFixture(),authorizationSha256=installHash(Buffer.from(installJson(grant)+'\n'));
 const arrival={source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,healthStatus:200};
 const input={output:'',checkedAt:new Date().toISOString(),arrival};
 return {grant,authorizationSha256,arrival,input,request:createCleanupRequest(grant,input)};
}
test('owned cleanup requires the actual empty checksum output, fresh observation and exact original build tuple',()=>{
 const f=fixture();assert.equal(validateCleanupRequest(f.request,f.grant),f.request);
 for(const change of [{output:'>f.. sourcechanged\n'},{arrival:{...f.arrival,nextBuildId:'another'}},{checkedAt:new Date(Date.now()-61000).toISOString()}])assert.throws(()=>createCleanupRequest(f.grant,{...f.input,...change}));
 for(const mutate of [r=>r.installId=f.grant.build.buildRecordId,r=>r.source='e'.repeat(40),r=>r.witnessFingerprint='f'.repeat(64),r=>r.outputSha256=installHash('nonempty'),r=>r.extra=true,r=>r.authorizationSha256='f'.repeat(64)]){
  const r=structuredClone(f.request);mutate(r);assert.throws(()=>validateCleanupRequest(r,f.grant));
 }
});
test('cleanup result cannot replace fresh actual byte/health/ledger proof or claim missing resource cleanup',()=>{
 const f=fixture(),g=f.grant,expected=[{tag:'001_fixture',hash:'f'.repeat(64),created_at:'1'}];
 const base={...f.arrival,authorizationSha256:f.authorizationSha256};
 const installed={authorizationSha256:f.authorizationSha256,releaseAuthorized:false,verified:{...base},activated:{...base,afterActivationMonotonicUs:100,activation:{activeDirectory:{device:1,inode:2}}},
  runtime:{...base,pid:'123',startedMonotonicUs:101,verifiedAt:new Date().toISOString(),compiledByteInventory:{format:2,capacityProfile:{...g.build.capacityProfile},kind:'next-build-byte-bundle',releaseAuthorized:false,runtimeCacheExcluded:true,files:4},
   migrationLedger:{kind:'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE',releaseAuthorized:false,rows:1,expectedSha256:installHash(installJson(expected)),actualSha256:'a'.repeat(64)}}};
 const result={...base,kind:'CI_INSTALL_OWNED_CLEANUP_AND_FINAL_RUNTIME_VERIFIED',ownedResourceCleanupVerified:true,releaseHandbackVerified:false,runtime:installed.runtime,
  cleanup:{kind:'OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED',source:g.source,installId:g.installId,nextBuildId:g.build.nextBuildId,authorizationSha256:f.authorizationSha256,verifiedAbsent:['next','packet'],auditEvidenceRetained:true,activeDirectory:{device:1,inode:2}}};
 assert.equal(validateFinalCleanup(result,{grant:g,installed,expectedLedger:expected}).nextBuildId,g.build.nextBuildId);
 for(const mutate of [r=>r.ownedResourceCleanupVerified=false,r=>r.cleanup.verifiedAbsent=['next'],r=>r.cleanup.auditEvidenceRetained=false,r=>r.cleanup.activeDirectory.inode=3,
  r=>r.runtime.healthStatus=500,r=>r.runtime.compiledByteInventory.files=0,r=>r.runtime.migrationLedger.rows=0,r=>r.runtime.verifiedAt=new Date(Date.now()-61000).toISOString()]){
  const r=structuredClone(result);mutate(r);assert.throws(()=>validateFinalCleanup(r,{grant:g,installed,expectedLedger:expected}));
 }
});
