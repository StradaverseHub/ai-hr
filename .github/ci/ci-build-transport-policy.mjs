/** Explicit CI-byte transport qualification only. Never a release or DB admission. */
import {isDeepStrictEqual} from 'node:util';
import {assertBuildRuntime,assertBuildCapacityProfile,BUILD_CAPACITY_PROFILE} from './build-production.mjs';
export const CI_TRANSPORT_WORKFLOW='.github/workflows/ci-build-transport-qualification.yml';
const REPO='StradaverseHub/ai-hr',PRODUCER_WORKFLOW='.github/workflows/alpha-staging.yml';
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ok=(value,message)=>{if(!value)throw Error('CI build transport qualification refused: '+message);};
const id=value=>/^[1-9][0-9]{0,15}$/.test(value??'')&&Number.isSafeInteger(Number(value));
const branch=value=>typeof value==='string'&&/^codex\/[A-Za-z0-9][A-Za-z0-9/_-]{0,180}$/.test(value)&&!value.endsWith('/')&&!value.includes('//');
const absolute=value=>typeof value==='string'&&value.startsWith('/')&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value)&&!value.split('/').some(p=>p==='.'||p==='..');
const repo=value=>value?.id===1333414856&&value.full_name===REPO;
export function assertCiTransportInvocation(e){
 ok(e.AIHR_CI_BUILD_TRANSPORT==='consumer'&&e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'
  &&e.RUNNER_OS==='Linux'&&e.RUNNER_ARCH==='X64'&&e.ImageOS==='ubuntu24'&&e.GITHUB_REPOSITORY===REPO&&e.GITHUB_REPOSITORY_ID==='1333414856'
  &&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_RUN_ATTEMPT==='1'&&e.GITHUB_JOB==='build-consumer','actual first-attempt hosted consumer context');
 ok(SHA.test(e.AIHR_CI_HEAD??'')&&SHA.test(e.AIHR_CI_CONTROL_HEAD??'')&&SHA.test(e.AIHR_BUILD_PRODUCER_CONTROL_HEAD??'')
  &&e.GITHUB_SHA===e.AIHR_CI_CONTROL_HEAD&&e.GITHUB_WORKFLOW_SHA===e.AIHR_CI_CONTROL_HEAD,'actual immutable source/controller');
 ok(branch(e.AIHR_BUILD_SOURCE_BRANCH)&&(branch(e.AIHR_BUILD_PRODUCER_BRANCH)||['main','alpha'].includes(e.AIHR_BUILD_PRODUCER_BRANCH))&&branch(e.GITHUB_REF_NAME)
  &&e.GITHUB_REF==='refs/heads/'+e.GITHUB_REF_NAME&&e.GITHUB_WORKFLOW_REF===REPO+'/'+CI_TRANSPORT_WORKFLOW+'@'+e.GITHUB_REF,'owned branch/workflow binding');
 ok(id(e.GITHUB_RUN_ID)&&id(e.AIHR_BUILD_PRODUCER_RUN_ID)&&e.GITHUB_RUN_ID!==e.AIHR_BUILD_PRODUCER_RUN_ID
  &&id(e.AIHR_BUILD_ARTIFACT_ID)&&DIGEST.test(e.AIHR_BUILD_ARTIFACT_DIGEST??''),'exact run/artifact selectors');
 ok(typeof e.RUNNER_NAME==='string'&&e.RUNNER_NAME.length>0&&e.RUNNER_NAME.length<=200&&!/[\x00-\x1f\x7f]/.test(e.RUNNER_NAME),'actual consumer runner');
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])
  ok(e[key]==='postgres://nobody:nothing@127.0.0.1:1/no_database','database URLs must stay closed');
 ok(e.AIHR_BUILD_DIAGNOSTIC===undefined,'diagnostic context cannot be relabelled');
 return true;
}
export function validateCiTransportRefs(refs,e){
 assertCiTransportInvocation(e);
 for(const [key,name,sha]of [['source',e.AIHR_BUILD_SOURCE_BRANCH,e.AIHR_CI_HEAD],['producer',e.AIHR_BUILD_PRODUCER_BRANCH,e.AIHR_BUILD_PRODUCER_CONTROL_HEAD],['consumer',e.GITHUB_REF_NAME,e.AIHR_CI_CONTROL_HEAD]])
  ok(refs[key]?.ref==='refs/heads/'+name&&refs[key].object?.type==='commit'&&refs[key].object.sha===sha,'immutable '+key+' branch moved or differs');
 return true;
}
export function validateCiTransportConsumerRun(run,e){
 assertCiTransportInvocation(e);
 ok(run?.id===Number(e.GITHUB_RUN_ID)&&run.run_attempt===1&&run.event==='workflow_dispatch'&&run.head_sha===e.AIHR_CI_CONTROL_HEAD
  &&run.path===CI_TRANSPORT_WORKFLOW&&run.head_branch===e.GITHUB_REF_NAME&&repo(run.repository)&&repo(run.head_repository),'authenticated actual consumer run');
 return true;
}
export function validateCiTransportMetadata({run,jobs,artifact,artifacts},e,{now=Date.now()}={}){
 ok(Number.isSafeInteger(now)&&now>0&&now<=8640000000000000,'bounded actual observation time');
 assertCiTransportInvocation(e);const runId=Number(e.AIHR_BUILD_PRODUCER_RUN_ID),controller=e.AIHR_BUILD_PRODUCER_CONTROL_HEAD;
 const manual=run?.event==='workflow_dispatch'&&branch(e.AIHR_BUILD_PRODUCER_BRANCH);
 const publishedDispatch=run?.event==='workflow_dispatch'&&['main','alpha'].includes(e.AIHR_BUILD_PRODUCER_BRANCH);
 const alphaPush=run?.event==='push'&&e.AIHR_BUILD_PRODUCER_BRANCH==='alpha'&&run.head_branch==='alpha'&&run.head_sha===e.AIHR_CI_HEAD&&e.AIHR_CI_HEAD===controller;
 ok(run?.id===runId&&run.workflow_id===395777276&&run.run_attempt===1&&(manual||publishedDispatch||alphaPush)&&run.head_sha===controller
  &&run.path===PRODUCER_WORKFLOW&&run.head_branch===e.AIHR_BUILD_PRODUCER_BRANCH&&repo(run.repository)&&repo(run.head_repository)
  &&Number.isFinite(Date.parse(run.run_started_at)),'authenticated CI producer run');
 ok(Array.isArray(jobs)&&jobs.length>0&&jobs.length<100,'bounded producer jobs');
 if(publishedDispatch){
  const names=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'];
  const success=['resolve','build','deployment-hold'];
  ok(run.status==='completed'&&run.conclusion==='success'
   &&run.display_title==='Canonical build only · '+e.AIHR_BUILD_SOURCE_BRANCH
   &&Number.isFinite(Date.parse(run.created_at))&&Number.isFinite(Date.parse(run.updated_at))
   &&Date.parse(run.created_at)<=Date.parse(run.run_started_at)&&Date.parse(run.updated_at)>=Date.parse(run.run_started_at)
   &&Date.parse(run.updated_at)<=now,'completed published canonical build-only run');
  ok(jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length
   &&new Set(jobs.map(j=>j.id)).size===names.length,'exact published build-only job inventory');
  for(const j of jobs){
   ok(names.includes(j.name)&&Number.isSafeInteger(j.id)&&j.id>0&&j.run_id===runId&&j.run_attempt===1
    &&j.head_sha===controller&&j.head_branch===run.head_branch&&j.status==='completed'
    &&j.conclusion===(success.includes(j.name)?'success':'skipped'),'published build-only job identity/topology');
   if(success.includes(j.name))ok(Number.isFinite(Date.parse(j.started_at))&&Number.isFinite(Date.parse(j.completed_at))
    &&Date.parse(j.started_at)>=Date.parse(run.created_at)&&Date.parse(j.completed_at)>=Date.parse(j.started_at)
    &&Date.parse(j.completed_at)<=Date.parse(run.updated_at),'published build-only successful job times');
  }
 }
 const producers=jobs.filter(j=>j.name==='build');ok(producers.length===1,'unique CI build producer');const producer=producers[0];
 ok(Number.isSafeInteger(producer.id)&&producer.id>0&&producer.head_branch===e.AIHR_BUILD_PRODUCER_BRANCH
  &&typeof producer.runner_name==='string'&&producer.runner_name.length>0&&producer.runner_name.length<=200&&!/[\x00-\x1f\x7f]/.test(producer.runner_name)
  &&producer.run_id===runId&&producer.run_attempt===1&&producer.head_sha===controller&&producer.status==='completed'&&producer.conclusion==='success'
  &&Number.isFinite(Date.parse(producer.started_at))&&Number.isFinite(Date.parse(producer.completed_at))
  &&Date.parse(producer.started_at)>=Date.parse(run.run_started_at)&&Date.parse(producer.completed_at)>=Date.parse(producer.started_at)&&Date.parse(producer.completed_at)<=now,'actual successful CI build job/times');
 ok(Array.isArray(artifacts)&&artifacts.length<100&&artifacts.filter(a=>a.name==='production-build-v1').length===1
  &&isDeepStrictEqual(artifacts.find(a=>a.name==='production-build-v1'),artifact),'unique authenticated producer artifact inventory');
 ok(artifact?.id===Number(e.AIHR_BUILD_ARTIFACT_ID)&&artifact.name==='production-build-v1'&&artifact.expired===false
  &&artifact.workflow_run?.id===runId&&artifact.workflow_run.head_sha===controller
  &&artifact.workflow_run.repository_id===1333414856&&artifact.workflow_run.head_repository_id===1333414856
  &&artifact.workflow_run.head_branch===e.AIHR_BUILD_PRODUCER_BRANCH
  &&Number.isFinite(Date.parse(artifact.created_at))&&Number.isFinite(Date.parse(artifact.expires_at))
  &&Date.parse(artifact.created_at)>=Date.parse(producer.started_at)&&Date.parse(artifact.created_at)<=Date.parse(producer.completed_at)
  &&Date.parse(artifact.expires_at)>now&&Date.parse(artifact.expires_at)>Date.parse(artifact.created_at)
  &&artifact.digest==='sha256:'+e.AIHR_BUILD_ARTIFACT_DIGEST&&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0
  &&artifact.size_in_bytes<=BUILD_CAPACITY_PROFILE.zipMaxBytes,'actual CI artifact identity/digest/bound');
 return producer;
}
export function validateCiTransportProvenance(p,e,runtime,localRunner,producerJob,producerRun){
 assertCiTransportInvocation(e);assertBuildRuntime(runtime,e);assertBuildCapacityProfile(p?.capacityProfile);
 ok(producerRun?.id===Number(e.AIHR_BUILD_PRODUCER_RUN_ID)&&producerRun.workflow_id===395777276
  &&producerRun.run_attempt===1&&producerRun.head_sha===e.AIHR_BUILD_PRODUCER_CONTROL_HEAD
  &&producerRun.path===PRODUCER_WORKFLOW&&producerRun.head_branch===e.AIHR_BUILD_PRODUCER_BRANCH
  &&repo(producerRun.repository)&&repo(producerRun.head_repository)
  &&(producerRun.event==='workflow_dispatch'||(producerRun.event==='push'&&producerRun.head_branch==='alpha'
   &&e.AIHR_CI_HEAD===e.AIHR_BUILD_PRODUCER_CONTROL_HEAD)),'authenticated producer event/ref');
 ok(p?.format===2&&p.kind==='ci-system-testing-build-candidate'&&p.releaseAuthorized===false&&p.source===e.AIHR_CI_HEAD
  &&p.controller===e.AIHR_BUILD_PRODUCER_CONTROL_HEAD&&p.runId===Number(e.AIHR_BUILD_PRODUCER_RUN_ID)&&p.runAttempt===1
  &&p.repository===REPO&&p.repositoryId===1333414856&&p.workflowRef===REPO+'/'+PRODUCER_WORKFLOW+'@refs/heads/'+e.AIHR_BUILD_PRODUCER_BRANCH
  &&p.producerEvent===producerRun.event&&p.producerRef==='refs/heads/'+producerRun.head_branch
  &&(producerRun.event!=='push'||p.source===p.controller)
  &&isDeepStrictEqual(p.runtime,runtime)&&UUID.test(p.buildRecordId??'')&&/^[A-Za-z0-9_-]{1,512}$/.test(p.nextBuildId??'')
  &&Number.isSafeInteger(p.archiveBytes)&&p.archiveBytes>0&&p.archiveBytes<=BUILD_CAPACITY_PROFILE.archiveMaxBytes,'actual CI provenance');
 for(const k of ['lockSha256','packageSha256','preparedSha256','successfulObservationSha256','manifestSha256','archiveSha256'])ok(DIGEST.test(p[k]??''),'bound provenance digest');
 ok(p.diagnosticRunner===undefined&&p.diagnosticDurations===undefined,'diagnostic provenance cannot be reused');
 const origin=p.producerRunner;
 ok(origin&&isDeepStrictEqual(Object.keys(origin).sort(),['bootSha256','name','sourcePath'])
  &&typeof origin.name==='string'&&origin.name.length>0&&origin.name.length<=200&&!/[\x00-\x1f\x7f]/.test(origin.name)
  &&producerJob?.runner_name===origin.name
  &&absolute(origin.sourcePath)&&origin.sourcePath===p.buildSourcePath&&DIGEST.test(origin.bootSha256??'')
  &&absolute(localRunner?.sourcePath)&&localRunner.name===e.RUNNER_NAME&&DIGEST.test(localRunner.bootSha256??'')
  &&origin.name!==localRunner.name&&origin.sourcePath!==localRunner.sourcePath&&origin.bootSha256!==localRunner.bootSha256,'real fresh VM and relocation identities');
 return true;
}
