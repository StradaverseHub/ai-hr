/** Bounded protocol/refusal fixtures; no SSH, service, database or real resource deletion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {createSourceChecksumObservation,validateSourceChecksumObservation,validateCleanupRequest} from './staging-cleanup-protocol.mjs';
import {completeArrivalAndCleanup,validateArrivalAndCleanupResult} from './arrival-cleanup-flow.mjs';

function fixture(){
 const {grant}=installationFixture(),authorizationSha256=installHash(installJson(grant)+'\n');
 const expectedLedger=[{tag:'001_fixture',hash:'f'.repeat(64),created_at:'1'}];
 const base={source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,authorizationSha256};
 const runtime={...base,healthStatus:200,pid:'123',startedMonotonicUs:101,verifiedAt:new Date().toISOString(),
  compiledByteInventory:{kind:'next-build-byte-bundle',releaseAuthorized:false,runtimeCacheExcluded:true,files:4},
  migrationLedger:{kind:'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE',releaseAuthorized:false,rows:1,expectedSha256:installHash(installJson(expectedLedger)),actualSha256:'a'.repeat(64)}};
 const activeDirectory={device:1,inode:2};
 const installed={authorizationSha256,releaseAuthorized:false,verified:{...base},activated:{...base,afterActivationMonotonicUs:100,activation:{activeDirectory}},runtime};
 const cleaned={...base,kind:'CI_INSTALL_OWNED_CLEANUP_AND_FINAL_RUNTIME_VERIFIED',ownedResourceCleanupVerified:true,releaseHandbackVerified:false,runtime:structuredClone(runtime),
  cleanup:{kind:'OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED',source:grant.source,installId:grant.installId,nextBuildId:grant.build.nextBuildId,authorizationSha256,verifiedAbsent:['next','packet'],auditEvidenceRetained:true,activeDirectory}};
 const observation=createSourceChecksumObservation(grant,{output:'',checkedAt:new Date().toISOString()});
 const events=[],input={grant,observation,expectedLedger};
 const operations={observe:async()=>{events.push('full-before');return installed;},cleanupAfterFreshArrival:async request=>{
  validateCleanupRequest(request,grant);events.push('owned-cleanup-and-full-after');cleaned.runtime.verifiedAt=new Date().toISOString();return cleaned;
 }};
 return {grant,observation,expectedLedger,installed,cleaned,events,input,operations};
}
test('source observation is not legacy deletion authority and retains exact source/build/grant/freshness requirements',()=>{
 const f=fixture();assert.equal(validateSourceChecksumObservation(f.observation,f.grant),f.observation);
 assert.throws(()=>validateCleanupRequest(f.observation,f.grant));
 assert.throws(()=>createSourceChecksumObservation(f.grant,{output:'>f changed\n',checkedAt:new Date().toISOString()}));
 for(const mutate of [v=>v.kind='OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP',v=>v.source='e'.repeat(40),v=>v.installId=f.grant.build.buildRecordId,
  v=>v.buildRecordId=f.grant.installId,v=>v.nextBuildId='other',v=>v.authorizationSha256='e'.repeat(64),v=>v.witnessFingerprint='f'.repeat(64),
  v=>v.outputSha256=installHash('changed'),v=>v.extra=true,v=>v.checkedAt=new Date(Date.now()-61000).toISOString()]){
  const value=structuredClone(f.observation);mutate(value);assert.notDeepEqual(value,f.observation,'Refusal control must actually change the observation');assert.throws(()=>validateSourceChecksumObservation(value,f.grant));
 }
});
test('one complete fresh arrival proof feeds cleanup, retains both results and cannot claim deployment authority',async()=>{
 const f=fixture(),value=await completeArrivalAndCleanup(f.input,f.operations);
 assert.deepEqual(f.events,['full-before','owned-cleanup-and-full-after']);
 assert.equal(value.installed,f.installed);assert.equal(value.cleaned,f.cleaned);assert.equal(value.releaseAuthorized,false);
 const checked=validateArrivalAndCleanupResult(value,f.input);
 assert.equal(checked.initialArrival.nextBuildId,f.grant.build.nextBuildId);assert.equal(checked.arrival.nextBuildId,f.grant.build.nextBuildId);
});
test('invalid source proof or expired grant refuses before observing or invoking any destructive continuation',async()=>{
 for(const kind of ['source','grant']){
  const f=fixture();if(kind==='source')f.observation.outputSha256=installHash('changed');else f.grant.expiresAt=new Date(Date.now()-1).toISOString();
  await assert.rejects(completeArrivalAndCleanup(f.input,f.operations));assert.deepEqual(f.events,[]);
 }
});
test('foreign, unhealthy, stale, partial-byte or incorrect-ledger before proof never reaches deletion',async()=>{
 for(const mutate of [v=>v.authorizationSha256='e'.repeat(64),v=>v.activated.buildRecordId='wrong',v=>v.runtime.nextBuildId='wrong',
  v=>v.runtime.healthStatus=500,v=>v.runtime.pid='0',v=>v.runtime.startedMonotonicUs=99,v=>v.runtime.compiledByteInventory.files=0,
  v=>v.runtime.compiledByteInventory.runtimeCacheExcluded=false,v=>v.runtime.migrationLedger.rows=0,v=>v.runtime.migrationLedger.expectedSha256='e'.repeat(64),
  v=>v.runtime.verifiedAt=new Date(Date.now()-61000).toISOString()]){
  const f=fixture();mutate(f.installed);await assert.rejects(completeArrivalAndCleanup(f.input,f.operations));assert.deepEqual(f.events,['full-before']);
 }
});
test('a failed complete scan or authority mutation during that scan never reaches deletion',async()=>{
 for(const change of ['scan-failure','observation','grant']){
  const f=fixture();f.operations.observe=async()=>{
   f.events.push('full-before');if(change==='scan-failure')throw Error('actual inventory refusal');
   if(change==='observation')f.observation.checkedAt=new Date(Date.now()-61000).toISOString();else f.grant.source='e'.repeat(40);
   return f.installed;
  };
  await assert.rejects(completeArrivalAndCleanup(f.input,f.operations));assert.deepEqual(f.events,['full-before']);
 }
});
test('failed cleanup or missing final integrity/health/audit proof cannot return combined success',async()=>{
 for(const change of ['throw','bytes','health','ledger','audit','missing-owned-resource','active-inode']){
  const f=fixture();
  if(change==='throw')f.operations.cleanupAfterFreshArrival=async()=>{throw Error('owned cleanup refused');};
  if(change==='bytes')f.cleaned.runtime.compiledByteInventory.files=0;
  if(change==='health')f.cleaned.runtime.healthStatus=500;
  if(change==='ledger')f.cleaned.runtime.migrationLedger.rows=0;
  if(change==='audit')f.cleaned.cleanup.auditEvidenceRetained=false;
  if(change==='missing-owned-resource')f.cleaned.cleanup.verifiedAbsent=['next'];
  if(change==='active-inode')f.cleaned.cleanup.activeDirectory={device:1,inode:3};
  await assert.rejects(completeArrivalAndCleanup(f.input,f.operations));
 }
});
test('parent independently refuses replayed request bindings, altered results and stale initial/final observations',async()=>{
 const f=fixture(),value=await completeArrivalAndCleanup(f.input,f.operations);
 for(const mutate of [v=>v.extra=true,v=>v.releaseAuthorized=true,v=>v.sourceObservationSha256='e'.repeat(64),v=>v.installed.runtime.healthStatus=500,
  v=>v.installed.runtime.verifiedAt=new Date(Date.now()-61000).toISOString(),v=>v.cleaned.runtime.verifiedAt=new Date(Date.now()-61000).toISOString(),
  v=>v.cleaned.cleanup.verifiedAbsent=['packet'],v=>v.cleaned.runtime.nextBuildId='foreign']){
  const copy=structuredClone(value);mutate(copy);assert.throws(()=>validateArrivalAndCleanupResult(copy,f.input));
 }
 const another=structuredClone(f.observation);another.checkedAt=new Date(Date.now()+1).toISOString();
 assert.throws(()=>validateArrivalAndCleanupResult(value,{...f.input,observation:another}));
});
test('before proof stays historical after long cleanup: fresh when used, ordered, source-bound; after proof must be fresh now',async()=>{
 const f=fixture(),value=await completeArrivalAndCleanup(f.input,f.operations);
 // Retained phase evidence is deliberately older than one minute at response time.
 // Its grant was already valid at that phase, and the final proof is still current.
 const {grant}=installationFixture(Date.now()-180000),used=Date.now()-120000;
 const historical=structuredClone(value),observation=structuredClone(f.observation);
 const authorizationSha256=installHash(installJson(grant)+'\n');
 observation.installId=grant.installId;observation.authorizationSha256=authorizationSha256;observation.checkedAt=new Date(used-1000).toISOString();
 for(const status of [historical.installed.verified,historical.installed.activated,historical.installed.runtime,historical.cleaned,historical.cleaned.runtime,historical.cleaned.cleanup]){
  status.installId=grant.installId;status.authorizationSha256=authorizationSha256;
 }
 historical.installed.authorizationSha256=authorizationSha256;
 historical.beforeCleanupValidatedAt=new Date(used).toISOString();historical.installed.runtime.verifiedAt=new Date(used-200).toISOString();
 historical.sourceObservationSha256=installHash(installJson(observation));
 const input={grant,observation,expectedLedger:f.expectedLedger};
 assert.equal(validateArrivalAndCleanupResult(historical,input).arrival.nextBuildId,grant.build.nextBuildId);
 for(const mutate of [v=>v.beforeCleanupValidatedAt='invalid',v=>v.beforeCleanupValidatedAt=new Date(Date.now()+61000).toISOString(),
  v=>v.installed.runtime.verifiedAt=new Date(used-61000).toISOString(),v=>v.cleaned.runtime.verifiedAt=new Date(Date.now()-61000).toISOString()]){
  const bad=structuredClone(historical);mutate(bad);assert.throws(()=>validateArrivalAndCleanupResult(bad,input));
 }
 const oldChecksum={...observation,checkedAt:new Date(used-61000).toISOString()},bad=structuredClone(historical);
 bad.sourceObservationSha256=installHash(installJson(oldChecksum));assert.throws(()=>validateArrivalAndCleanupResult(bad,{...input,observation:oldChecksum}));
});
