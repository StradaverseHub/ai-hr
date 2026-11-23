import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY,WORKFLOW_ID,verifyArtifactBytes} from './release-policy.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {NEXT_APPLICATION_FAILURE,NEXT_APPLICATION_STATE,NEXT_APPLICATION_MEMBERS,inspectNextStatePacket} from './next-application-cache-protocol.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {validateRepairBuildMetadata} from './repair-recovery-policy.mjs';
import {validateRepairArchiveInventory} from './repair-recovery.mjs';
import {validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {POLICY,SOURCE,BASELINE,BRANCH,TEST_RUN,BUILD_RUN,BUILD_ID,BUILD_DIGEST,FAILURE_DIGEST,checkTestCoverage,requireReview} from './payroll-replay-recovery-policy.mjs';

function pages(path){
 return JSON.parse(execFileSync('gh',['api','--paginate','--slurp','repos/'+REPOSITORY+'/'+path],
  {encoding:'utf8',maxBuffer:32*1024**2,timeout:60000}));
}
function metadata(id){
 return {run:pages('actions/runs/'+id)[0],
  jobs:pages('actions/runs/'+id+'/jobs?per_page=100&filter=all').flatMap(page=>page.jobs),
  artifacts:pages('actions/runs/'+id+'/artifacts?per_page=100').flatMap(page=>page.artifacts)};
}
function requireFrozenHistory(start){
 const prefix='actions/workflows/'+WORKFLOW_ID+'/runs?per_page=100';
 const since=encodeURIComponent('>='+start);
 const activeStates=['queued','in_progress','waiting','pending','requested'];
 const relevant=['main','alpha'].flatMap(branch=>pages(prefix+'&branch='+branch+'&created='+since).flatMap(page=>page.workflow_runs));
 const active=activeStates.flatMap(status=>pages(prefix+'&status='+status).flatMap(page=>page.workflow_runs)
  .filter(run=>['main','alpha'].includes(run.head_branch)));
 for(const run of [...relevant,...active]){
  if(!['Alpha CI','Canonical build only'].some(title=>run.display_title===title+' · '+BRANCH))continue;
  assert([TEST_RUN,BUILD_RUN].includes(run.id)&&run.status==='completed'&&run.run_attempt===1,
   'Unreviewed canonical execution for frozen payroll candidate');
 }
 for(const [ref,sha] of [['main',BASELINE],['alpha',BASELINE],[BRANCH,SOURCE]]){
  assert(pages('git/ref/heads/'+ref)[0].object?.sha===sha,'Published ref moved: '+ref);
 }
}
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export async function verifyPayrollReplayRecovery({candidatePath,runId,baseline,evidenceDirectory,reuse=false}){
 candidatePath=resolve(candidatePath);
 assert(Number(runId)===TEST_RUN&&baseline===BASELINE&&cleanHead(candidatePath)===SOURCE,'Exact payroll staging baseline and source required');
 const verificationController=cleanHead(controllerRoot);
 const reviewed=process.env.AIHR_PAYROLL_REPLAY_REVIEWED_CONTROLLER??null;
 if(reviewed!==null)requireReview(verificationController,reviewed);
 const diagnosticId=Number(process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID);
 assert(Number.isSafeInteger(diagnosticId)&&diagnosticId>0,'Hosted verifier diagnostics required');
 const verificationDiagnostic=validateRecoveryControllerDiagnostic({...metadata(diagnosticId),controller:verificationController});
 const original=metadata(TEST_RUN);
 const publishedBuild=metadata(BUILD_RUN);
 assert(original.run.head_branch==='main'&&original.run.event==='workflow_dispatch'&&
  original.run.display_title==='Alpha CI · '+BRANCH&&
  Date.parse(publishedBuild.run.updated_at)<Date.parse(original.run.created_at),'Frozen test/build executions differ');
 requireFrozenHistory(publishedBuild.run.created_at);

 const dir=evidenceDirectory??join(controllerRoot,'scratchpad','verified-payroll-replay-'+randomUUID());
 const originalDir=join(dir,'original');
 if(!reuse){
  mkdirSync(originalDir,{recursive:true,mode:0o700});
  save(originalDir,'github.json',original);
  const note=await downloadCiArchives(original.artifacts,originalDir,{prefetchDirectory:process.env.AIHR_PAYROLL_TEST_PREFETCH_DIR});
  save(originalDir,'download.json',note);
 }
 const diagnostic=original.artifacts.filter(a=>a.name===NEXT_APPLICATION_FAILURE);
 assert(diagnostic.length===1&&diagnostic[0].digest===FAILURE_DIGEST,'Exact original failure archive required');
 validateRepairArchiveInventory({...original,artifacts:diagnostic},new Set([NEXT_APPLICATION_FAILURE]),()=> 'build');
 const failurePath=join(originalDir,NEXT_APPLICATION_FAILURE+'.zip');
 verifyArtifactBytes(diagnostic[0],readCiArchive(diagnostic[0],failurePath));
 // This pinned archive also contains compiler logs. Only its small JSON observation is relevant.
 const failure=JSON.parse(execFileSync('/usr/bin/unzip',['-p',failurePath,'comparison.json'],{timeout:5000,maxBuffer:128*1024}));
 assert(failure.kind==='CANONICAL_CI_APPLICATION_COMPILER_STATE_NOT_RELEASE'&&failure.releaseAuthorized===false&&
  failure.source===SOURCE&&failure.controller===BASELINE&&failure.runId===String(TEST_RUN)&&failure.attempt==='1'&&
  failure.phases.find(p=>p.name==='canonical-build')?.code===0&&failure.memory.availableMemoryVerdict==='fail'&&
  failure.memory.minMemAvailableKiB===1291200&&failure.memory.minMemAvailableBudgetKiB===1572864,
  'Original canonical compiler and memory outcome differ');
 const artifacts=original.artifacts.filter(a=>a.name!==NEXT_APPLICATION_FAILURE);
 assert(!artifacts.some(a=>[BUILD_ARTIFACT,'gate-evidence'].includes(a.name)),'Unexpected installable proof in failed run');
 const archives=new Map(artifacts.map(a=>[a.name,readCiArchive(a,join(originalDir,a.name+'.zip'))]));
 const prior=process.env.AIHR_CI_CLASSIFIER_RUNTIME;
 process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';
 let plan;
 try{
  const {fingerprint,...body}={...createPlan(candidatePath),controller:BASELINE,migrationBase:BASELINE,
   runtime:{node:'22.23.3',platform:'linux',arch:'x64'}};
  plan={...body,fingerprint:hash(body)};
 }finally{
  if(prior===undefined)delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;
  else process.env.AIHR_CI_CLASSIFIER_RUNTIME=prior;
 }
 const assessment=assessResumeSource({...original,artifacts,archives,expectedPlan:plan,
  expected:{candidate:SOURCE,controller:BASELINE,baseline:BASELINE,runId:TEST_RUN}});
 checkTestCoverage({plan,jobs:original.jobs,assessment});

 assert(publishedBuild.run.head_branch==='main','Published canonical build must use main');
 validateRepairBuildMetadata({...publishedBuild,expected:{runId:BUILD_RUN,controller:BASELINE,candidateBranch:BRANCH,after:publishedBuild.run.created_at}});
 validateRepairArchiveInventory(publishedBuild,new Set([BUILD_ARTIFACT,NEXT_APPLICATION_STATE]),()=> 'build');
 const archive=publishedBuild.artifacts.find(a=>a.name===BUILD_ARTIFACT);
 assert(archive?.id===14772602180&&archive.digest===BUILD_DIGEST,'Canonical build archive changed');
 const built=await collectRecoveryEvidence(BUILD_RUN,dir,{reuse,includeRaw:true,prefetchDirectory:process.env.AIHR_PAYROLL_BUILD_PREFETCH_DIR});
 assert(isDeepStrictEqual(publishedBuild,{run:built.run,jobs:built.jobs,artifacts:built.artifacts}),'Build metadata changed');
 if(built.parsed.has(NEXT_APPLICATION_STATE)){
  const files=built.rawParsed.get(NEXT_APPLICATION_STATE);
  assert(isDeepStrictEqual([...files.keys()].sort(),NEXT_APPLICATION_MEMBERS),'Unexpected supplemental build files');
  const state=inspectNextStatePacket({files,run:built.run,job:built.jobs.find(j=>j.name==='build')});
  assert(state.producer.source===SOURCE&&state.producer.controller===BASELINE,'Foreign supplemental build state');
 }
 const build=await sourceBoundBuild({candidatePath,dir,p:{candidate:SOURCE,controller:BASELINE,baseline:BASELINE,
  runId:BUILD_RUN,controllerBranch:'main'},jobs:built.jobs});
 assert(build.nextBuildId===BUILD_ID&&cleanHead(candidatePath)===SOURCE&&cleanHead(controllerRoot)===verificationController,
  'Build or verifier changed');
 requireFrozenHistory(publishedBuild.run.created_at);
 assert(isDeepStrictEqual(original,metadata(TEST_RUN)),'Test metadata changed during verification');
 const recovery={recoveryPolicy:POLICY,sha:SOURCE,baseline:BASELINE,controller:BASELINE,verificationController,
  verificationDiagnostic,pendingReview:reviewed===null,testRun:TEST_RUN,buildRun:BUILD_RUN,
  testUnits:102,assertions:55383,buildArchiveDigest:BUILD_DIGEST,failureArchiveDigest:FAILURE_DIGEST,
  planFingerprint:plan.fingerprint,testJobs:original.jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion})).sort((a,b)=>a.id-b.id),
  testArchives:original.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest})).sort((a,b)=>a.id-b.id)};
 const evidence={...recovery,policyVersion:CI_POLICY,tier:reviewed===null?'diagnostic':'ci',
  result:reviewed===null?'DIAGNOSTIC_NONINSTALLABLE':'PASS',installationEligible:reviewed!==null,
  recovery,fingerprint:hash(recovery),build,candidatePath,runId:BUILD_RUN,controllerBranch:'main',
  evidenceDirectory:dir,verifiedAt:new Date().toISOString(),url:built.run.html_url,
  artifacts:built.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))};
 save(dir,reuse?'revalidation-'+randomUUID()+'.json':'verification.json',evidence);
 return evidence;
}

export async function revalidatePayrollReplayRecovery(evidence){
 const fresh=await verifyPayrollReplayRecovery({...evidence,runId:TEST_RUN,reuse:true});
 assert(isDeepStrictEqual(fresh.recovery,evidence.recovery)&&isDeepStrictEqual(fresh.build,evidence.build)&&
  isDeepStrictEqual(fresh.artifacts,evidence.artifacts),'Payroll replay evidence changed before installation');
}
