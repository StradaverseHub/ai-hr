/** Authenticated same-run build transfer for actual Next verification only.
 * No release, installation, alternate-origin or packet-supplied authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,realpathSync,lstatSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX,inspectCiNativeBuildPacket} from './build-artifact.mjs';
import {downloadCiArchives} from './archive-downloads.mjs';
import {nativeNextUnit,validateNativeBuildPrerequisite} from './singleton-protocol.mjs';
const REPOSITORY='StradaverseHub/ai-hr',REPOSITORY_ID=1333414856,WORKFLOW_ID=395777276;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const stamp=value=>typeof value==='string'?Date.parse(value):NaN;
const repo=value=>value?.id===REPOSITORY_ID&&value.full_name===REPOSITORY;
const branch=value=>['main','alpha'].includes(value)||typeof value==='string'&&/^codex\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value);
export function validateNativeBuildMetadata({run,jobs,artifacts},expected,now=Date.now()){
 assert(positive(expected?.runId)&&/^[a-f0-9]{40}$/.test(expected.source)&&/^[a-f0-9]{40}$/.test(expected.controller));
 assert(Number.isFinite(now)&&branch(expected.controllerBranch));
 assert(run?.id===expected.runId&&run.run_attempt===1&&repo(run.repository)&&repo(run.head_repository));
 assert.equal(run.head_sha,expected.controller);assert.equal(run.head_branch,expected.controllerBranch);
 assert.equal(run.workflow_id,WORKFLOW_ID);assert.equal(run.path,'.github/workflows/alpha-staging.yml');
 // The producer is terminal; this consuming job means the whole run is still
 // in progress. This contract intentionally cannot satisfy validateRun/release.
 assert(['in_progress','completed'].includes(run.status));
 assert(run.event==='workflow_dispatch'||run.event==='push'&&run.head_branch==='alpha'&&expected.source===expected.controller);
 const created=stamp(run.created_at);assert(Number.isFinite(created)&&created<=now&&now-created<=86400000);
 assert(Array.isArray(jobs)&&jobs.length>0&&jobs.length<=512);
 const seen=new Set();for(const job of jobs){
  assert(positive(job?.id)&&!seen.has(job.id));seen.add(job.id);
  assert.equal(job.run_id,run.id);assert.equal(job.run_attempt,1);assert.equal(job.head_sha,expected.controller);assert.equal(job.head_branch,run.head_branch);
 }
 const producers=jobs.filter(job=>job.name==='build');assert.equal(producers.length,1);
 const producer=producers[0],started=stamp(producer.started_at),completed=stamp(producer.completed_at);
 assert.equal(producer.status,'completed');assert.equal(producer.conclusion,'success');
 assert(Number.isFinite(started)&&Number.isFinite(completed)&&created<=started&&started<=completed&&completed<=now);
 assert(Array.isArray(artifacts)&&artifacts.length>0&&artifacts.length<=512);
 const matches=artifacts.filter(value=>value.name===BUILD_ARTIFACT);assert.equal(matches.length,1);
 const artifact=matches[0],when=stamp(artifact.created_at),expires=stamp(artifact.expires_at),origin=artifact.workflow_run;
 assert(positive(artifact.id)&&positive(artifact.size_in_bytes)&&artifact.size_in_bytes<=BUILD_ZIP_MAX&&artifact.expired===false);
 assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest??''));
 assert.equal(origin?.id,run.id);assert.equal(origin.repository_id,REPOSITORY_ID);assert.equal(origin.head_repository_id,REPOSITORY_ID);
 assert.equal(origin.head_sha,expected.controller);assert.equal(origin.head_branch,run.head_branch);
 assert(Number.isFinite(when)&&Number.isFinite(expires)&&started<=when&&when<=completed&&expires>now);
 return {artifact,producer,expected:{candidate:expected.source,controller:expected.controller,runId:run.id,controllerBranch:run.head_branch,
  producerStartedAt:producer.started_at,producerCompletedAt:producer.completed_at}};
}
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:60000,maxBuffer:16*1024**2}));
function pages(path,key){
 const result=[];for(let page=1;page<=6;page++){
  const data=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
  assert(Array.isArray(data[key]));result.push(...data[key]);assert(result.length<=512,'Native build API inventory exceeds bound');
  if(data[key].length<100)return result;
 }
 throw Error('Native build API inventory is incomplete');
}
/** Called by the authenticated full-CI unit owner before any application child.
 * Actual singleton host/plan admission remains a separate mandatory operation. */
export async function provisionNativeNextBuild(plan,unit,directory,env=process.env){
 assert(nativeNextUnit(unit),'Actual registered hybrid unit required');
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:REPOSITORY,GITHUB_REPOSITORY_ID:String(REPOSITORY_ID),GITHUB_JOB:'native-test',GITHUB_RUN_ATTEMPT:'1'}))assert.equal(env[key],value);
 assert.equal(env.AIHR_CI_HEAD,plan.sha);assert.equal(env.AIHR_CI_CONTROL_HEAD,plan.controller);assert.equal(env.GITHUB_SHA,plan.controller);
 const runId=Number(env.GITHUB_RUN_ID);assert(positive(runId));
 assert.equal(env.GITHUB_REF,'refs/heads/'+env.GITHUB_REF_NAME);
 assert.equal(env.GITHUB_WORKFLOW_REF,REPOSITORY+'/.github/workflows/alpha-staging.yml@'+env.GITHUB_REF);
 assert(branch(env.GITHUB_REF_NAME));assert.equal(realpathSync(directory),directory);
 const parent=lstatSync(directory);assert(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===process.getuid());
 // This tree is deliberately OUTSIDE the uploaded unit-evidence directory.
 const temporary=realpathSync(env.RUNNER_TEMP);assert.equal(directory,join(temporary,'aihr-ci'));
 const root=join(temporary,unit.id+'-native-build-private');mkdirSync(root,{mode:0o700});
 const downloads=join(root,'archives');mkdirSync(downloads,{mode:0o700});
 const metadata=validateNativeBuildMetadata({run:api(`actions/runs/${runId}`),jobs:pages(`actions/runs/${runId}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${runId}/artifacts`,'artifacts')},
  {source:plan.sha,controller:plan.controller,runId,controllerBranch:env.GITHUB_REF_NAME});
 const transfer=await downloadCiArchives([metadata.artifact],downloads,{concurrency:1});
 assert.equal(transfer.artifacts.length,1);assert.equal(transfer.artifacts[0].status,'verified');
 const packetDirectory=join(root,'packet');
 execFileSync('python3',['-I','-B',fileURLToPath(new URL('./build-transport-extract.py',import.meta.url)),transfer.artifacts[0].path,packetDirectory,metadata.artifact.digest.slice(7)],{timeout:60000,maxBuffer:1048576});
 assert.equal(realpathSync(packetDirectory),packetDirectory);assert.equal(lstatSync(packetDirectory).mode&0o777,0o700);
 const packet=inspectCiNativeBuildPacket(packetDirectory,metadata.expected);
 const prerequisite={kind:'same-run-canonical-next-build',source:plan.sha,controller:plan.controller,runId:String(runId),attempt:'1',
  artifactId:String(metadata.artifact.id),artifactDigest:metadata.artifact.digest,producerJobId:String(metadata.producer.id),nextBuildId:packet.nextBuildId,
  archiveSha256:packet.archiveSha256,manifestSha256:packet.manifestSha256,provenanceSha256:packet.provenanceSha256};
 validateNativeBuildPrerequisite(prerequisite,{source:plan.sha,controller:plan.controller,runId:String(runId),attempt:'1'});
 const bindingPath=join(root,'build-binding.json');
 writeFileSync(bindingPath,JSON.stringify({schemaVersion:1,kind:'AUTHENTICATED_SAME_RUN_NATIVE_NEXT_BUILD_NOT_RELEASE',expected:metadata.expected,
  artifact:{id:metadata.artifact.id,digest:metadata.artifact.digest,runId},producerJob:{id:metadata.producer.id,name:'build'},
  packet:{archiveSha256:packet.archiveSha256,manifestSha256:packet.manifestSha256,provenanceSha256:packet.provenanceSha256,nextBuildId:packet.nextBuildId},releaseAuthorized:false},null,2)+'\n',{flag:'wx',mode:0o600});
 return {prerequisite,packetDirectory,bindingPath};
}
