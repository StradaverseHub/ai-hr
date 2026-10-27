import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {createRuntimeInstallGrant} from './runtime-install-grant.mjs';
import {inspectBuildOnlySnapshot,inspectRuntimeRepairBuildOnlySnapshot} from './build-only-evidence.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {RUNTIME_REPAIR as refs} from './runtime-repair-source.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
function fixture(){
 const f=installationFixture(),run={...f.run,head_sha:refs.alpha,repository:{id:REPOSITORY_ID,full_name:REPOSITORY},workflow_id:WORKFLOW_ID,path:WORKFLOW_PATH,head_branch:'alpha',event:'workflow_dispatch',updated_at:new Date(f.now-500).toISOString()};
 const active=['resolve','build','deployment-hold'],skipped=['typecheck','migrations','runner-diagnostics','controller-tests','plan','test','browser','verify'];
 const jobs=[...active,...skipped].map((name,i)=>({id:200+i,name,run_id:run.id,run_attempt:1,head_sha:refs.alpha,head_branch:'alpha',status:'completed',conclusion:active.includes(name)?'success':'skipped',started_at:f.producer.started_at,completed_at:f.producer.completed_at,steps:name==='resolve'?[{name:'Refuse invalid build-only execution',conclusion:'success'}]:name==='build'?[{name:'Canonical System Testing production build and byte bundle',conclusion:'success'},{name:'Publish mandatory canonical build packet',conclusion:'success'}]:[]}));
 const artifact={id:456,name:BUILD_ARTIFACT,digest:'sha256:'+'f'.repeat(64),expired:false,size_in_bytes:100,created_at:f.producer.completed_at,expires_at:new Date(f.now+86400000).toISOString(),workflow_run:{id:run.id,repository_id:REPOSITORY_ID,head_repository_id:REPOSITORY_ID,head_sha:refs.alpha,head_branch:'alpha'}};
 const pass=(path,engine)=>({path,engine,state:'PASSED',passingAssertions:1,failedAssertions:0});
 const body={kind:'COMBINED_REQUIRED_COVERAGE_WITH_OWNER_RUNTIME_EXCEPTION',policy:'runtime-owner-exception/v1',result:'ACCEPTED_WITH_OWNER_EXCEPTION',candidate:refs.candidate,sourceProofSha256:'a'.repeat(64),
  fullGatePassCreated:false,createsNewFullPassBaseline:false,releaseAuthorized:false,originalFailedRun:{runId:40444007805,conclusion:'failure'},actualImpact:{base:refs.staging,head:refs.candidate,plan:{tier:'full',risk:'unknown',reasons:['CSS','browser']}},wholeCompiler:{runId:40475176478,conclusion:'success'},postDeployAcceptanceRequired:true,
  ordinaryFiles:Array.from({length:2037},(_,i)=>pass('test/file-'+i+'.test.ts')),browserFiles:['chromium','firefox','webkit'].flatMap(e=>Array.from({length:19},(_,i)=>pass('test/browser-'+i+'.browser.test.tsx',e)))};
 const boundary={kind:'FORWARD_STAGING_BASELINE_SOURCE_PREFIX_NOT_CI_RECEIPT',candidate:refs.candidate,ciBaseline:refs.ciBaseline,deploymentBaseline:refs.staging,deploymentMigrationCount:503,candidateMigrationCount:503,originalCiBaselinePreserved:true,releaseAuthorized:false};
 return {snapshot:{run,jobs,artifacts:[artifact]},now:f.now,baselineBuildId:f.baselineBuildId,environmentSha256:f.environmentSha256,
  acceptance:{...body,acceptanceSha256:installHash(installJson(body))},evidence:{kind:'AUTHENTICATED_RUNTIME_OWNER_EXCEPTION_AND_CANONICAL_BUILD',sha:refs.candidate,controller:refs.alpha,controllerBranch:'alpha',baseline:refs.ciBaseline,deploymentBaseline:refs.staging,
   build:{...f.evidence.build,source:refs.candidate,controller:refs.alpha},runId:run.id,artifact:{id:artifact.id,digest:artifact.digest},baselineAdvance:{...boundary,proofSha256:installHash(installJson(boundary))}}};
}
test('runtime exception creates a scoped standard byte grant while normal build-only admission remains strict',()=>{
 const f=fixture(),expected={candidate:refs.candidate,controller:refs.alpha,runId:f.snapshot.run.id};
 assert.throws(()=>inspectBuildOnlySnapshot({...f.snapshot,expected,now:f.now}));
 assert(inspectRuntimeRepairBuildOnlySnapshot({...f.snapshot,expected,now:f.now}));
 const grant=createRuntimeInstallGrant(f);assert.equal(grant.source,refs.candidate);assert.equal(grant.controller,refs.alpha);assert.equal(grant.baseline,refs.staging);assert.equal(grant.result,undefined);assert.equal(f.acceptance.fullGatePassCreated,false);
});
for(const [name,change] of [
 ['ordinary omission',f=>f.acceptance.ordinaryFiles.pop()],['duplicate ordinary file',f=>f.acceptance.ordinaryFiles[1]=f.acceptance.ordinaryFiles[0]],['ordinary failure',f=>f.acceptance.ordinaryFiles[0].failedAssertions=1],
 ['browser omission',f=>f.acceptance.browserFiles.pop()],['duplicate browser engine file',f=>f.acceptance.browserFiles[1]=f.acceptance.browserFiles[0]],['fake full baseline',f=>f.acceptance.createsNewFullPassBaseline=true],
 ['wrong source',f=>f.evidence.sha=refs.wave],['wrong controller',f=>f.evidence.controller=refs.staging],['wrong ledger',f=>f.evidence.baselineAdvance.candidateMigrationCount=504],
 ['altered packet',f=>f.evidence.artifact.id=999],['foreign build branch',f=>f.snapshot.run.head_branch='feature'],['skipped actual build',f=>f.snapshot.jobs.find(j=>j.name==='build').conclusion='skipped']
])test('runtime grant refuses '+name,()=>{const f=fixture();change(f);const {acceptanceSha256,...body}=f.acceptance;f.acceptance.acceptanceSha256=installHash(installJson(body));assert.throws(()=>createRuntimeInstallGrant(f));});
