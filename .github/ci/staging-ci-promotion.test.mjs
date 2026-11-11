/** Private promotion transport seams only. Never authenticate fabricated evidence against GitHub. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILD_CAPACITY_PROFILE} from './build-production.mjs';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {stagingInstallerCommand,validateInstallAcknowledgement,transferAndLaunchCiBuild,validateInstalledArrival,validatePrelaunchState} from './staging-ci-promotion.mjs';
const ack=g=>({installId:g.installId,packetDirectory:'/home/fixture/.aihr-ci-builds/'+g.installId+'/packet',authorizationSha256:installHash(Buffer.from(installJson(g)+'\n')),releaseAuthorized:false});
function seams(){
 const f=installationFixture(),grant=f.grant,evidence={...f.evidence,evidenceDirectory:'/private/original-ci-evidence'},events=[],saved={};
 const options={grant,evidence,official:{buildLaunchCommand:(source,dir,state,baked,attempt)=>'detached --testing-build-record='+baked+' --ci-build='+attempt},
  ssh:(command,args)=>{events.push(command==='ANNOUNCE'?'pending':command.endsWith(' initialize')?'initialize':'launch');return command.endsWith(' initialize')?JSON.stringify(ack(grant)):'started';},
  transferSource:()=>events.push('source'),transferPacket:(from,to)=>events.push(['packet',from,to]),
  frozen:()=>events.push('frozen'),revalidate:async state=>events.push(state?.announced?'revalidate-pending':'revalidate-ready'),
  save:(name,value)=>{assert(!(name in saved));saved[name]=value;},pendingCommand:'ANNOUNCE'};
 return {f,grant,events,saved,options};
}
test('promotion announces, copies source, privately initializes/transfers ORIGINAL packet, revalidates and launches exact baked identity',async()=>{
 const s=seams();const result=await transferAndLaunchCiBuild(s.options);
 assert.equal(result.grant,s.grant);assert.equal(s.saved['launch.json'].testingBuildRecordId,s.grant.build.buildRecordId);
 assert.notEqual(s.grant.installId,s.grant.build.buildRecordId);
 assert.deepEqual(s.events.filter(x=>x!=='frozen'),['revalidate-ready','pending','source','initialize',['packet','/private/original-ci-evidence/production-build-v1',ack(s.grant).packetDirectory],'revalidate-pending','launch']);
 assert.deepEqual(s.saved['installation-grant.json'],s.grant);
});
test('foreign, forged, non-private or traversal acknowledgement never transfers bytes or launches',async()=>{
 for(const mutate of [a=>a.installId='other',a=>a.authorizationSha256='a'.repeat(64),a=>a.releaseAuthorized=true,a=>a.packetDirectory='/opt/ai-hr/.next',a=>a.packetDirectory='/home/../fixture/.aihr-ci-builds/'+seams().grant.installId+'/packet',a=>a.extra=true]){
  const s=seams();s.options.ssh=command=>{s.events.push(command==='ANNOUNCE'?'pending':'initialize');const value=ack(s.grant);mutate(value);return JSON.stringify(value);};
  await assert.rejects(transferAndLaunchCiBuild(s.options));assert(!s.events.some(x=>Array.isArray(x)));assert(!s.events.includes('launch'));
 }
});
test('source/packet failures and second evidence refusal never launch or create completed arrival',async()=>{
 for(const stage of ['source','packet','second-validation']){
  const s=seams();let checks=0;
  if(stage==='source')s.options.transferSource=()=>{throw Error(stage);};
  if(stage==='packet')s.options.transferPacket=()=>{throw Error(stage);};
  if(stage==='second-validation')s.options.revalidate=async()=>{if(++checks===2)throw Error(stage);};
  await assert.rejects(transferAndLaunchCiBuild(s.options),new RegExp(stage));
  assert(!s.events.includes('launch'));assert.equal(s.saved['installed-arrival.json'],undefined);
 }
});
test('a legacy launcher silently ignoring the new installation parameter refuses before any detached job',async()=>{
 const s=seams();s.options.official.buildLaunchCommand=(source,dir,state,baked)=>'legacy --testing-build-record='+baked;
 await assert.rejects(transferAndLaunchCiBuild(s.options),/ORIGINAL/);assert(!s.events.includes('launch'));
});
test('ready and pending deployment facts remain distinct without relaxing baseline byte identity',()=>{
 const s=seams(),base={state:'ok',ref:s.grant.baseline,built_ref:s.grant.baseline,build_id:s.grant.baselineBuildId,built_build_id:s.grant.baselineBuildId,stale_build:'0'};
 const expected={baseline:s.grant.baseline,baselineBuildId:s.grant.baselineBuildId,candidate:s.grant.source};
 assert.equal(validatePrelaunchState(base,expected),base);
 const pending={...base,state:'incomplete',ref:s.grant.source,stale_build:'1'};
 assert.equal(validatePrelaunchState(pending,{...expected,announced:true}),pending);
 assert.throws(()=>validatePrelaunchState(pending,expected));assert.throws(()=>validatePrelaunchState(base,{...expected,announced:true}));
 for(const patch of [{built_ref:'e'.repeat(40)},{build_id:'different'},{built_build_id:'different'},{ref:'e'.repeat(40)},{state:'running'}])assert.throws(()=>validatePrelaunchState({...pending,...patch},{...expected,announced:true}));
});
test('fresh actual build/service/source/ledger tuple is mandatory; a health200 alone is insufficient',()=>{
 const {grant}=seams(),expected=[{tag:'001_fixture',hash:'f'.repeat(64),created_at:'1'}],base={source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,authorizationSha256:ack(grant).authorizationSha256};
 const value={releaseAuthorized:false,authorizationSha256:base.authorizationSha256,verified:{...base},activated:{...base,afterActivationMonotonicUs:100},
  runtime:{...base,healthStatus:200,compiledByteInventory:{format:2,capacityProfile:{...BUILD_CAPACITY_PROFILE},kind:'next-build-byte-bundle',files:4,releaseAuthorized:false,runtimeCacheExcluded:true},pid:'123',startedMonotonicUs:101,verifiedAt:new Date().toISOString(),migrationLedger:{kind:'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE',releaseAuthorized:false,rows:1,expectedSha256:installHash(installJson(expected)),actualSha256:'a'.repeat(64)}}};
 assert.equal(validateInstalledArrival(value,grant,expected).nextBuildId,grant.build.nextBuildId);
 for(const mutate of [v=>v.runtime.nextBuildId='other',v=>v.runtime.healthStatus=401,v=>v.runtime.pid='0',v=>v.runtime.startedMonotonicUs=99,
  v=>v.runtime.verifiedAt=new Date(Date.now()-61000).toISOString(),v=>v.runtime.migrationLedger.rows=0,v=>v.runtime.migrationLedger.expectedSha256='b'.repeat(64),
  v=>v.authorizationSha256='b'.repeat(64),v=>v.activated.buildRecordId=grant.installId,
  v=>v.runtime.compiledByteInventory.format=1,v=>delete v.runtime.compiledByteInventory.capacityProfile,
  v=>v.runtime.compiledByteInventory.capacityProfile.archiveMaxBytes=268435456,v=>v.runtime.compiledByteInventory.capacityProfile.zipMaxBytes++]){
  const copy=structuredClone(value);mutate(copy);assert.throws(()=>validateInstalledArrival(copy,grant,expected));
 }
});
test('operator commands cannot request stage/activate or interpolate unknown identifiers',()=>{
 const {grant}=seams();assert.match(stagingInstallerCommand('initialize'),/node .* initialize$/);
 assert.match(stagingInstallerCommand('status',grant.source,grant.installId,grant.build.buildRecordId),/node --env-file=.env.production --import tsx/);
 assert.match(stagingInstallerCommand('cleanup',grant.source,grant.installId,grant.build.buildRecordId),/staging-build-install.mjs cleanup /);
 for(const mode of ['stage','activate','other'])assert.throws(()=>stagingInstallerCommand(mode,grant.source,grant.installId,grant.build.buildRecordId));
 assert.throws(()=>stagingInstallerCommand('status',';exit',grant.installId,grant.build.buildRecordId));
});
