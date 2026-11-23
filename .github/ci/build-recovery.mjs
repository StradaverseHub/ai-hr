/** aihr-build-capacity-recovery/v1 operator adapter. Authenticates the original failed gate and one replacement
 * build-only run through the GitHub API and archive digests; the pure decision lives in build-recovery-policy.mjs. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY,WORKFLOW_ID} from './release-policy.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {NEXT_APPLICATION_STATE,NEXT_APPLICATION_FAILURE,NEXT_APPLICATION_MEMBERS,inspectNextStatePacket} from './next-application-cache-protocol.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {validateRepairArchiveInventory} from './repair-recovery.mjs';
import {BROWSER_WORKFLOW_ID} from './browser-recovery-policy.mjs';
import {verifyBuildRecovery,validateBuildRecoveryHistory,BUILD_FAILURE_MEMBERS} from './build-recovery-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
function pages(path,key){const rows=[];for(let p=1;p<=10;p++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${p}`);assert(Array.isArray(r[key]),'Missing API inventory');rows.push(...r[key]);if(r[key].length<100)return rows;}throw Error('Build recovery API inventory exceeds bound');}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2,timeout:60000}).trim();
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const metadata=id=>({run:api(`actions/runs/${id}`),jobs:pages(`actions/runs/${id}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${id}/artifacts`,'artifacts')});
const facts=m=>({run:m.run,jobs:m.jobs,artifacts:m.artifacts});
const branchRef=b=>'git/ref/heads/'+b.split('/').map(encodeURIComponent).join('/');
function history({source,candidateBranch,buildRunId}){
 const focused=api('actions/workflows/alpha-focused-checks.yml');assert(focused.path==='.github/workflows/alpha-focused-checks.yml','Focused workflow registry differs');
 const workflows=[WORKFLOW_ID,focused.id,BROWSER_WORKFLOW_ID],since=new Date(Date.parse(source.run.created_at)-86400000).toISOString(),query='created='+encodeURIComponent('>='+since);
 const rows=workflows.flatMap(w=>pages(`actions/workflows/${w}/runs?${query}`,'workflow_runs'));
 // Active executions must not disappear merely because they were queued before the lookback.
 for(const status of ['queued','in_progress','waiting','requested','pending'])rows.push(...pages(`actions/runs?status=${status}`,'workflow_runs').filter(r=>workflows.includes(r.workflow_id)));
 return validateBuildRecoveryHistory({source,rows,candidateBranch,buildRunId});
}
export async function verifyBuildRecoveredCi({candidatePath,runId,baseline,buildRunId,candidateBranch,evidenceDirectory,reuse=false}){
 candidatePath=resolve(candidatePath);runId=Number(runId);buildRunId=Number(buildRunId);
 assert(Number.isSafeInteger(runId)&&runId>0&&Number.isSafeInteger(buildRunId)&&buildRunId>0&&buildRunId!==runId&&/^[a-f0-9]{40}$/.test(baseline??''),'Exact original/build/baseline identities required');
 assert(typeof candidateBranch==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidateBranch)&&!candidateBranch.includes('..'),'Exact candidate branch required');
 const candidate=cleanHead(candidatePath),controller=cleanHead(controllerRoot),p={candidate,controller,baseline,runId};
 assert(git(candidatePath,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Unexpected repository origin');
 execFileSync('git',['merge-base','--is-ancestor',baseline,candidate],{cwd:candidatePath,stdio:'ignore'});
 assert(readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8').includes(' .github/ci/build-recovery.test.mjs'),'Hosted integrity suite must execute build recovery refusal controls');
 const checkRefs=()=>{assert(api(branchRef(candidateBranch)).object?.sha===candidate,'Candidate branch moved; source changed');assert([baseline,candidate].includes(api('git/ref/heads/alpha').object?.sha),'Alpha moved away from exact staging baseline/candidate');};
 checkRefs();
 const originalMetadata=metadata(runId);
 assert(originalMetadata.run.status==='completed'&&originalMetadata.run.conclusion==='failure'&&originalMetadata.run.run_attempt===1,'Original gate must be a completed failed first attempt');
 assert(originalMetadata.run.head_sha===controller,'Verify from the exact original gate controller checkout');
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`validated-build-recovery-${runId}-${randomUUID()}`),sourceDir=join(dir,'original');
 const source=await collectRecoveryEvidence(runId,sourceDir,{reuse,buildFailure:true,prefetchDirectory:process.env.AIHR_BUILD_RECOVERY_ORIGINAL_PREFETCH_DIR||undefined});
 assert(isDeepStrictEqual(originalMetadata,facts(source)),'Original metadata changed during download');
 const plan=source.parsed.get('gate-plan')?.get('ci-plan.json');assert(plan,'Original archived plan missing');
 // Same expected plan as the normal verifier: the candidate's own classifier, this controller, this baseline.
 const local=createPlan(candidatePath),{fingerprint:unused,...body}={...local,controller,migrationBase:baseline,runtime:plan.runtime},expectedPlan={...body,fingerprint:hash(body)};
 const failureArtifact=source.artifacts.find(a=>a.name===NEXT_APPLICATION_FAILURE),failureFiles=source.parsed.get(NEXT_APPLICATION_FAILURE);
 assert(failureArtifact&&failureFiles&&isDeepStrictEqual([...failureFiles.keys()].sort(),BUILD_FAILURE_MEMBERS),'Exact original build failure diagnostic required');
 // The shared assessor admits only a JSON-only failure diagnostic; the policy authenticates this namespace itself.
 const assessed=source.artifacts.filter(a=>a!==failureArtifact),archives=new Map([...source.archives].filter(([name])=>name!==NEXT_APPLICATION_FAILURE));
 const assessment=assessResumeSource({...source,artifacts:assessed,archives,expectedPlan,expected:p});
 const reports=plan.units.map(u=>source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`));
 const bm=metadata(buildRunId);
 validateRepairArchiveInventory(bm,new Set([BUILD_ARTIFACT,NEXT_APPLICATION_STATE]),()=>'build');assert(bm.artifacts.some(a=>a.name===BUILD_ARTIFACT),'Mandatory replacement canonical build packet missing');
 // The main evidence directory names the replacement build's real producer, as the installer grant expects.
 const built=await collectRecoveryEvidence(buildRunId,dir,{reuse,includeRaw:true,prefetchDirectory:process.env.AIHR_BUILD_RECOVERY_BUILD_PREFETCH_DIR||undefined});
 assert(isDeepStrictEqual(bm,facts(built)),'Replacement build metadata changed during download');
 if(built.parsed.has(NEXT_APPLICATION_STATE)){const files=built.rawParsed.get(NEXT_APPLICATION_STATE);assert(isDeepStrictEqual([...files.keys()].sort(),NEXT_APPLICATION_MEMBERS),'Application cache packet differs');
  const state=inspectNextStatePacket({files,run:built.run,job:built.jobs.find(j=>j.name==='build')});assert(state.producer.source===candidate&&state.producer.controller===controller,'Supplemental state source/controller differs');}
 const build=await sourceBoundBuild({candidatePath,dir,p:{candidate,controller,baseline,runId:buildRunId,controllerBranch:built.run.head_branch},jobs:built.jobs});
 const recovery=verifyBuildRecovery({expectedPlan,p,plan,sourceRun:source.run,sourceJobs:source.jobs,sourceArtifacts:source.artifacts,reports,assessment,
  failure:{report:failureFiles.get('comparison.json'),buildLog:failureFiles.get('canonical-build.log'),typegenLog:failureFiles.get('application-typegen.log')},
  buildRun:built.run,buildJobs:built.jobs,build,history:history({source,candidateBranch,buildRunId}),candidateBranch,verificationController:controller});
 assert(isDeepStrictEqual(originalMetadata,metadata(runId))&&isDeepStrictEqual(bm,metadata(buildRunId)),'Recovery API evidence changed before admission');
 assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===controller,'Source/controller changed while verifying');checkRefs();
 const result={...recovery,recovery,tier:'ci',result:'PASS',fingerprint:hash(recovery),build,candidatePath,candidateBranch,originalRunId:runId,buildRunId,controllerBranch:built.run.head_branch,
  evidenceDirectory:dir,verifiedAt:new Date().toISOString(),url:built.run.html_url,originalUrl:source.run.html_url,artifacts:built.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))};
 save(dir,reuse?`revalidation-${randomUUID()}.json`:'verification.json',result);return result;
}
export function assertBuildRecoveryRevalidation(evidence,current){
 assert(isDeepStrictEqual(current.recovery,evidence.recovery)&&isDeepStrictEqual(current.build,evidence.build)&&isDeepStrictEqual(current.artifacts,evidence.artifacts),'Build recovery evidence changed before launch');return true;
}
export async function revalidateBuildRecoveredCi(evidence){
 assert(cleanHead(controllerRoot)===evidence.verificationController,'Build recovery verification controller changed');
 const current=await verifyBuildRecoveredCi({candidatePath:evidence.candidatePath,runId:evidence.originalRunId,baseline:evidence.baseline,buildRunId:evidence.buildRunId,candidateBranch:evidence.candidateBranch,evidenceDirectory:evidence.evidenceDirectory,reuse:true});
 return assertBuildRecoveryRevalidation(evidence,current);
}
