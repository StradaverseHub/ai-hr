/** Optional application compiler input; never build/test/deployment authority. */
import assert from 'node:assert/strict';
import {assertCiCandidateBuildInvocation} from './build-production.mjs';
import {NEXT_STATE_MEMBERS,validateNextContext,validateNextState,hash} from './next-build-cache-policy.mjs';
export const NEXT_APPLICATION_STATE='next-application-state-v1';
export const NEXT_APPLICATION_FAILURE='next-application-build-failure';
export const NEXT_APPLICATION_MEMBERS=NEXT_STATE_MEMBERS;
export const NEXT_APPLICATION_SEED=Object.freeze({kind:'seed',runId:40251838329,controller:'62704177c4045a187d6a787e5ab13e39599b8410',source:'62704177c4045a187d6a787e5ab13e39599b8410',artifactId:12621207674,digest:'sha256:2c6d5c29ee248d9b2832f0e3eaddd21358d32baba2bab63d923c34ae80a410d0',stateSha256:'a4089facf276e6ca95af79cbc85a746de7232aea4fc06887fa06af1780ab9372'});
export const NEXT_APPLICATION_CODE=[
 '.github/ci/next-application-cache.mjs','.github/ci/next-application-cache-protocol.mjs','.github/ci/next-build-cache.mjs','.github/ci/next-build-cache-policy.mjs',
 '.github/ci/build-production.mjs','.github/ci/build-bundle.py','.github/ci/runner-capacity.mjs','.github/ci/prepare-runner.sh',
 '.github/ci/extract-artifact.py','.github/ci/diagnostics/compiler-incremental.mjs','.github/actions/setup-alpha/action.yml','.github/workflows/alpha-staging.yml'
];
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const id=v=>Number.isSafeInteger(v)&&v>0;
export function assertManagedNextInvocation(e,event={}){
 assertCiCandidateBuildInvocation(e);
 assert(e.AIHR_CI_CAPACITY_PROFILE==='bounded-canonical-build'&&e.NODE_OPTIONS==='--max-old-space-size=6144','Exact normal build capacity/heap required');
 if(e.GITHUB_EVENT_NAME==='pull_request')assert(event.pull_request&&!event.pull_request.draft&&event.pull_request.base?.ref==='alpha'
  &&event.pull_request.head?.repo?.full_name==='StradaverseHub/ai-hr','Only ready same-repository PR builds');
 return {publish:e.GITHUB_EVENT_NAME!=='pull_request'};
}
/** A completed build job can seed compiler inputs even when another required job failed.
 * The whole run never becomes a release witness through this check.
 */
export function validateManagedNextOrigin(origin,run,jobs,artifact){
 assert(['seed','normal'].includes(origin.kind)&&id(origin.runId),'Unknown application state origin');
 const seed=origin.kind==='seed';
 if(seed)assert(JSON.stringify(origin)===JSON.stringify(NEXT_APPLICATION_SEED),'Only independently verified immutable application seed');
 assert(run.id===origin.runId&&run.run_attempt===1&&sha(run.head_sha)&&run.repository?.full_name==='StradaverseHub/ai-hr'
  &&run.repository.id===1333414856&&run.head_repository?.id===1333414856&&['workflow_dispatch','push'].includes(run.event),'Authenticated first-attempt non-PR origin required');
 assert(run.path===(seed?'.github/workflows/alpha-staging-diagnostics.yml':'.github/workflows/alpha-staging.yml'),'Application publisher workflow differs');
 if(seed)assert(run.head_sha===origin.controller&&run.head_branch==='codex/test-suite-efficiency-review-20261025'&&run.event==='workflow_dispatch','Exact seed controller required');
 if(run.event==='push')assert(run.head_branch==='alpha','Only alpha push publishers');
 assert(jobs?.total_count===jobs.jobs?.length&&jobs.jobs.length<100,'Complete bounded application publisher jobs required');
 const selected=jobs.jobs.filter(j=>j.name===(seed?'next-build-cache':'build'));assert(selected.length===1,'Unique application publisher job required');
 const job=selected[0];
 assert(job.run_id===run.id&&job.run_attempt===1&&job.head_sha===run.head_sha&&job.status==='completed'&&job.conclusion==='success'
  &&Number.isFinite(Date.parse(job.started_at))&&Number.isFinite(Date.parse(job.completed_at)),'Actual successful application build required');
 assert(artifact&&id(artifact.id)&&artifact.name===(seed?'diagnostic-next-app-compiler-state':NEXT_APPLICATION_STATE)&&artifact.expired===false
  &&artifact.workflow_run?.id===run.id&&artifact.workflow_run.head_sha===run.head_sha
  &&artifact.workflow_run.repository_id===1333414856&&artifact.workflow_run.head_repository_id===1333414856
  &&/^sha256:[a-f0-9]{64}$/.test(artifact.digest??'')&&id(artifact.size_in_bytes)&&artifact.size_in_bytes<=64*1024**2,'Application state artifact identity differs');
 if(seed)assert(artifact.id===origin.artifactId&&artifact.digest===origin.digest,'Immutable seed artifact differs');
 const created=Date.parse(artifact.created_at);
 assert(Number.isFinite(created)&&created>=Date.parse(job.started_at)&&created<=Date.parse(job.completed_at),'State artifact outside producing job');
 return job;
}
export function verifyNextPublisherTree(tree,expected){
 assert(tree?.truncated===false&&Array.isArray(tree.tree)&&Object.keys(expected).length===NEXT_APPLICATION_CODE.length,'Complete actual application publisher code required');
 const blobs=tree.tree.filter(t=>t.type==='blob'),entries=new Map(blobs.map(t=>[t.path,t.sha]));assert(entries.size===blobs.length,'Duplicate publisher tree path');
 for(const path of NEXT_APPLICATION_CODE)assert(sha(expected[path])&&entries.get(path)===expected[path],'Actual application publisher code differs: '+path);
 return true;
}
export function inspectNextStatePacket({files,run,job,seed=false,currentContext=null,now=Date.now()}){
 assert(files instanceof Map&&files.size===NEXT_APPLICATION_MEMBERS.length&&NEXT_APPLICATION_MEMBERS.every(name=>files.has(name)),'Exact application state packet inventory');
 const read=name=>JSON.parse(files.get(name)),p=read('producer.json'),envelope=read('envelope.json'),build=read('build-provenance.json'),prepared=read('system-testing.json'),success=read('successful-build.json'),log=read('build-log.json'),state=files.get('state.json');
 assert(p.kind===(seed?'ACTUAL_NEXT_BUILD_CACHE_DIAGNOSTIC_NOT_RELEASE':'CANONICAL_CI_APPLICATION_COMPILER_STATE_NOT_RELEASE')
  &&p.releaseAuthorized===false&&p.exitCode===0&&p.source===envelope.source&&p.controller===run.head_sha
  &&p.runId===String(run.id)&&p.attempt==='1'&&p.sourceRestored===true&&p.controllerRestored===true&&p.ownedRecordsRemoved===true,'Actual completed clean application state producer required');
 if(seed)assert(p.source===NEXT_APPLICATION_SEED.source&&p.ownedBuildRemoved===true&&hash(state)===NEXT_APPLICATION_SEED.stateSha256,'Verified seed state/cleanup differs');
 else assert(p.workingStateRemoved===true&&p.cachePublishPermitted===true,'Normal application graph cleanup/publication differs');
 const phase=p.actualCanonicalBuild;
 assert(phase?.code===0&&phase.signal===null&&phase.timedOut===false&&Date.parse(phase.startedAt)>=Date.parse(job.started_at)
  &&Date.parse(phase.endedAt)<=Date.parse(job.completed_at)&&Date.parse(phase.endedAt)>=Date.parse(phase.startedAt),'Actual canonical phase outside successful job');
 assert(build.kind===(seed?'diagnostic-system-testing-build-not-release':'ci-system-testing-build-candidate')&&build.releaseAuthorized===false
  &&build.source===p.source&&build.controller===p.controller&&build.runId===run.id&&build.runAttempt===1
  &&build.preparedSha256===hash(files.get('system-testing.json'))&&build.successfulObservationSha256===hash(files.get('successful-build.json')),'Bound canonical source/build differs');
 assert(log.kind==='RAW_CANONICAL_NEXT_BUILD_OUTPUT'&&typeof log.text==='string'&&Buffer.byteLength(log.text)<=4*1024**2
  &&hash(Buffer.from(log.text))===p.buildLogSha256&&/\bCompiled successfully in /.test(log.text)&&/Finished TypeScript in /.test(log.text)
  &&!/Skipping validation of types|Finished TypeScript config validation|\berror TS\d+:/.test(log.text),'Actual application compiler/build log required');
 assert(prepared.identity?.sourceRef===p.source&&JSON.stringify(prepared.identity)===JSON.stringify(success.identity)
  &&success.kind==='successful-system-testing-build'&&success.preparedRecordSha256===build.preparedSha256
  &&success.nextBuildId===build.nextBuildId&&envelope.nextBuildId===build.nextBuildId&&envelope.buildRecordId===build.buildRecordId,'Canonical build and graph identity differ');
 assert(envelope.controller===p.controller&&envelope.runId===String(run.id)&&envelope.completedCommand==='canonical-build'&&envelope.completedAt===phase.endedAt,'Completed graph phase differs');
 validateNextState(state,envelope,p.source,currentContext??validateNextContext(envelope.context),{now});
 return {producer:p,envelope,bytes:state,build};
}
