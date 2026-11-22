/** Unchanged-source recovery v5: independently authenticate complete failed DB/Node processes.
 * Original app source, producer, successful build and failures keep their own exact identities.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {downloadCiArchives} from './archive-downloads.mjs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY,REPOSITORY_ID,verifyArtifactBytes} from './release-policy.mjs';
import {proveCanonicalRefs} from './canonical-docs-advance.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {validateFocusedMetadata,validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {verifyExactRecovery,requireReviewedExactController,validateExactRecoveryHistory,exactRecoveryBranch,PAYROLL_UPLOAD_LOSS,validatePayrollUploadLoss} from './exact-recovery-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
function pages(path,key){const rows=[];for(let page=1;page<=10;page++){const d=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);assert(Array.isArray(d[key]),'Missing API inventory');rows.push(...d[key]);if(d[key].length<100)return rows;}throw Error('Recovery API inventory exceeds bound');}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2}).trim();
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
function planAt(path){const previous=process.env.AIHR_CI_CLASSIFIER_RUNTIME;process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';try{return createPlan(path);}finally{if(previous===undefined)delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;else process.env.AIHR_CI_CLASSIFIER_RUNTIME=previous;}}
export function validateExactControllerDelta(paths){
 const allowed=['.github/ci/exact-recovery-policy.mjs','.github/ci/exact-recovery.mjs','.github/ci/exact-recovery.test.mjs','.github/ci/exact-recovery-adapter.test.mjs',
  '.github/ci/exact-recovery-extract.py','.github/ci/exact-recovery-extract.test.py','.github/ci/canonical-docs-advance.mjs',
  '.github/ci/canonical-docs-advance.test.mjs','.github/ci/focused-recovery.mjs','.github/ci/ci-install-grant.mjs',
  '.github/ci/staging-preflight.test.mjs','.github/ci/operator-release.mjs','.github/workflows/alpha-staging.yml','docs/CI-EXACT-SOURCE-RECOVERY-V4.md'];
 assert(Array.isArray(paths)&&paths.length===allowed.length&&new Set(paths).size===paths.length
  &&isDeepStrictEqual(paths.slice().sort(),allowed.sort()),'Exact independently reviewed recovery-only controller delta required');
 return true;
}
async function readPayrollUploadLoss({source,plan,assessment,candidatePath,dir,reuse}){
 const pin=PAYROLL_UPLOAD_LOSS,observation=assessment.observations.find(o=>o.id===pin.unit);
 if(source.run.id!==pin.originalRun||observation?.artifact!==null)return null;
 assert(plan.sha===pin.candidate,'Exact reviewed upload-loss application source required');
 const delta=git(candidatePath,'diff','--name-status','--no-renames',pin.priorSource,pin.candidate);
 assert(delta===pin.changedTests.map(path=>'M\t'+path).join('\n')&&!plan.units.find(u=>u.id===pin.unit).files.some(file=>pin.changedTests.includes(file)),
  'Earlier case inventory differs beyond the two reviewed out-of-unit test files');
 const job=source.jobs.find(j=>j.id===pin.jobId);
 const log=execFileSync('gh',['api',`repos/${REPOSITORY}/actions/jobs/${pin.jobId}/logs`],{encoding:'utf8',timeout:60000,maxBuffer:32*1024**2});
 const proof=validatePayrollUploadLoss({run:source.run,plan,job,observation,log});
 const prior=api(`actions/runs/${pin.priorRun}`);
 assert(prior.id===pin.priorRun&&prior.repository?.id===REPOSITORY_ID&&prior.head_repository?.id===REPOSITORY_ID&&
  prior.head_sha===plan.controller&&prior.head_branch===source.run.head_branch&&prior.workflow_id===source.run.workflow_id&&prior.path===source.run.path&&
  prior.event==='workflow_dispatch'&&prior.status==='completed'&&prior.run_attempt===1&&Date.parse(prior.created_at)<Date.parse(source.run.created_at),
  'Preceding complete case-inventory run differs');
 const priorJobs=pages(`actions/runs/${prior.id}/jobs?filter=all`,'jobs');
 const names=['gate-plan','unit-'+pin.unit];
 const artifacts=pages(`actions/runs/${prior.id}/artifacts`,'artifacts').filter(a=>names.includes(a.name));
 assert(artifacts.length===2&&new Set(artifacts.map(a=>a.name)).size===2,'Prior case-inventory artifacts missing or duplicate');
 const sub=join(dir,'prior-case-inventory');
 if(!reuse){mkdirSync(sub,{mode:0o700});await downloadCiArchives(artifacts,sub);writeFileSync(join(sub,'original-upload-loss.log'),log,{flag:'wx',mode:0o600});}
 const meta=[];
 const read=(name,jobName,filename)=>{
  const artifact=artifacts.find(a=>a.name===name),w=artifact.workflow_run;
  const producing=priorJobs.filter(j=>j.name===jobName);
  assert(producing.length===1,'Prior evidence producing job not unique');
  const entry=producing[0];
  assert(entry.status==='completed'&&entry.conclusion==='success'&&entry.run_id===prior.id&&entry.run_attempt===1&&
   entry.head_sha===prior.head_sha&&artifact.expired===false&&w?.id===prior.id&&w.head_sha===prior.head_sha&&w.head_branch===prior.head_branch&&
   w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&Date.parse(artifact.created_at)>=Date.parse(entry.started_at)&&
   Date.parse(artifact.created_at)<=Date.parse(entry.completed_at),'Prior case-inventory artifact provenance differs');
  const archive=join(sub,name+'.zip');
  verifyArtifactBytes(artifact,readFileSync(archive));
  const destination=join(sub,name);
  if(!reuse)execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),archive,destination],{timeout:60000,stdio:'pipe'});
  meta.push({id:artifact.id,name,digest:artifact.digest,jobId:entry.id});
  return JSON.parse(readFileSync(join(destination,filename),'utf8'));
 };
 const priorPlan=read('gate-plan','plan','ci-plan.json');
 const unitArtifact='unit-'+pin.unit;
 const report=read(unitArtifact,`test (${pin.unit})`,unitArtifact+'.json');
 return {plan:priorPlan,report,proof:{...proof,priorRunId:prior.id,priorSource:priorPlan.sha,priorArtifacts:meta,expectedCasesOnly:true}};
}

export async function verifyExactRecoveredCi({candidatePath,runId,baseline,focusedRunIds,evidenceDirectory,reuse=false}){
 candidatePath=resolve(candidatePath);runId=Number(runId);
 assert(Number.isSafeInteger(runId)&&runId>0&&/^[a-f0-9]{40}$/.test(baseline??''),'Exact recovery source required');
 assert(Array.isArray(focusedRunIds)&&focusedRunIds.length>0&&focusedRunIds.length<=64&&focusedRunIds.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(focusedRunIds).size===focusedRunIds.length&&!focusedRunIds.includes(runId),'Distinct bounded focused run inventory required');
 const candidate=cleanHead(candidatePath),verificationController=cleanHead(controllerRoot);
 requireReviewedExactController({controller:verificationController,reviewedController:process.env.AIHR_EXACT_RECOVERY_REVIEWED_CONTROLLER});
 const diagnosticId=Number(process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID);assert(Number.isSafeInteger(diagnosticId)&&diagnosticId>0,'AIHR_RECOVERY_CONTROLLER_RUN_ID must identify the frozen verifier controller-only validation');
 assert(readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8').includes(' .github/ci/exact-recovery.test.mjs'),'Controller integrity suite must include focused recovery refusal tests');
 const verificationDiagnostic=validateRecoveryControllerDiagnostic({run:api(`actions/runs/${diagnosticId}`),jobs:pages(`actions/runs/${diagnosticId}/jobs?filter=all`,'jobs'),controller:verificationController});
 assert(git(candidatePath,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Unexpected repository');
 execFileSync('git',['merge-base','--is-ancestor',baseline,candidate],{cwd:candidatePath,stdio:'ignore'});
 // Preserve the actual published build/test producer separately from this reviewed verifier.
 const producer=api(`actions/runs/${runId}`),controller=producer.head_sha;
 assert(/^[a-f0-9]{40}$/.test(controller??'')&&['main','alpha'].includes(producer.head_branch),'Published original producer required');
 const canonical=()=>proveCanonicalRefs({cwd:candidatePath,originalController:controller,baseline,candidate,main:api('git/ref/heads/main').object?.sha,alpha:api('git/ref/heads/alpha').object?.sha,approvedDocsHead:process.env.AIHR_EXACT_RECOVERY_DOCS_HEAD});
 const canonicalAdvance=canonical(),focusedController=canonicalAdvance.focusedController;
 execFileSync('git',['merge-base','--is-ancestor',canonicalAdvance.head,verificationController],{cwd:controllerRoot,stdio:'ignore'});
 validateExactControllerDelta(git(controllerRoot,'diff','--name-only',canonicalAdvance.head,verificationController).split('\n').filter(Boolean));
 const workflowText=readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8');
 const restoredWorkflow=workflowText.replace(' .github/ci/exact-recovery.test.mjs .github/ci/exact-recovery-adapter.test.mjs .github/ci/canonical-docs-advance.test.mjs','')
  .replace('          PYTHONDONTWRITEBYTECODE=1 python3 .github/ci/exact-recovery-extract.test.py\n','');
 assert(restoredWorkflow===execFileSync('git',['show',canonicalAdvance.head+':.github/workflows/alpha-staging.yml'],{cwd:controllerRoot,encoding:'utf8',maxBuffer:1024**2}),'Recovery may add integrity controls only; execution/coverage policy must remain unchanged');
 for(const path of ['.github/ci/ci-install-grant.mjs','.github/ci/staging-build-install.mjs','.github/ci/policy-version.mjs'])
  assert(readFileSync(join(candidatePath,path),'utf8')===execFileSync('git',['show',controller+':'+path],{cwd:candidatePath,encoding:'utf8',maxBuffer:1024**2}),'Candidate receiver or policy changed: '+path);
 const p={candidate,controller,baseline,runId};
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`validated-exact-recovery-${runId}-${randomUUID()}`);
 const source=await collectRecoveryEvidence(runId,dir,{reuse,prefetchDirectory:process.env.AIHR_CI_PREFETCH_DIR||undefined});
 const plan=source.parsed.get('gate-plan')?.get('ci-plan.json'),local=planAt(candidatePath);assert(plan,'Missing original archived plan');
 const {fingerprint:unused,...body}={...local,controller,migrationBase:baseline,runtime:plan.runtime};
 const expectedPlan={...body,fingerprint:hash(body)};
 const assessment=assessResumeSource({...source,expectedPlan,expected:p});
 const workflow=api('actions/workflows/alpha-focused-checks.yml');
 assert(workflow.path==='.github/workflows/alpha-focused-checks.yml'&&workflow.state==='active','Focused workflow registry differs');
 const candidateBranch=source.run.display_title?.slice('Alpha CI · '.length);
 assert(typeof candidateBranch==='string'&&source.run.display_title===`Alpha CI · ${candidateBranch}`&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidateBranch)&&!candidateBranch.includes('..'),'Exact frozen candidate branch required');
 const assertSourceRef=ref=>assert(api('git/ref/heads/'+ref.split('/').map(encodeURIComponent).join('/')).object?.sha===candidate,'Candidate or recovery branch moved');
 assertSourceRef(candidateBranch);
 const focused=[];
 for(const id of focusedRunIds.slice().sort((a,b)=>a-b)){
  const sub=join(dir,`focused-${id}`),prefetch=process.env.AIHR_CI_PREFETCH_DIR?join(process.env.AIHR_CI_PREFETCH_DIR,`focused-${id}`):null;
  const f=await collectRecoveryEvidence(id,sub,{reuse,exactPackets:true,prefetchDirectory:prefetch&&existsSync(prefetch)?prefetch:undefined});
  const producer=validateFocusedMetadata({...f,expected:{runId:id,controller:focusedController,workflowId:workflow.id,after:source.run.updated_at}});
  const branch=typeof f.run.display_title==='string'?f.run.display_title.match(/^Focused only · (.+)$/)?.[1]:null;
  assert(exactRecoveryBranch(candidateBranch,runId,branch),'Focused run title does not identify a bound candidate or recovery branch');
  if(branch!==candidateBranch)assertSourceRef(branch);
  const artifact=f.artifacts[0],packet=f.parsed.get(artifact.name);
  const report=packet.get('focused.json'),resultName=report?.groups?.DB?.length>0?'db.vitest.json':'nodb.vitest.json';
  assert(isDeepStrictEqual([...packet.keys()].sort(),['focused.json',resultName].sort()),'Exact homogeneous focused packet members required');
  focused.push({...f,producer,artifact,report,result:packet.get(resultName)});
 }
 const uploadLoss=await readPayrollUploadLoss({source,plan,assessment,candidatePath,dir,reuse});
 const reports=plan.units.flatMap(u=>{
  const report=source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`);
  return !report&&u.id===uploadLoss?.proof.unitId?[]:[report];
 });
 const recovery=verifyExactRecovery({plan:expectedPlan,assessment,run:source.run,jobs:source.jobs,reports,focused,uploadLoss,classifierHash:hash(readFileSync(join(candidatePath,'scripts/gate-db-classify.ts'),'utf8')),verificationController,canonicalAdvance});
 const since=new Date(Date.parse(source.run.created_at)-86400000).toISOString(),query='created='+encodeURIComponent('>='+since);
 const rows=[...pages(`actions/workflows/${source.run.workflow_id}/runs?${query}`,'workflow_runs'),...pages(`actions/workflows/${workflow.id}/runs?${query}`,'workflow_runs')];
 for(const status of ['queued','in_progress','waiting','requested','pending'])rows.push(...pages(`actions/runs?status=${status}`,'workflow_runs').filter(r=>[source.run.workflow_id,workflow.id].includes(r.workflow_id)));
 recovery.history=validateExactRecoveryHistory({sourceRun:source.run,rows,candidateBranch,focusedRunIds,focusedController});
 recovery.verificationDiagnostic=verificationDiagnostic;recovery.reviewedController=verificationController;
 const build=await sourceBoundBuild({candidatePath,dir,p:{...p,controllerBranch:source.run.head_branch},jobs:source.jobs});
 assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===verificationController,'Recovery source/controller changed');
 assert(isDeepStrictEqual(canonical(),canonicalAdvance),'Canonical refs or reviewed documentation bytes changed during verification');
 const result={...recovery,tier:'ci',result:'PASS',recovery,fingerprint:hash(recovery),build,candidatePath,controllerBranch:source.run.head_branch,focusedRunIds:focusedRunIds.slice().sort((a,b)=>a-b),verifiedAt:new Date().toISOString(),url:source.run.html_url,evidenceDirectory:dir,artifacts:source.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))};
 save(dir,reuse?`revalidation-${randomUUID()}.json`:'verification.json',result);
 return result;
}
export async function revalidateExactRecoveredCi(evidence){
 assert(evidence.verificationController===cleanHead(controllerRoot),'Recovery verification controller changed');
 const current=await verifyExactRecoveredCi({candidatePath:evidence.candidatePath,runId:evidence.runId,baseline:evidence.baseline,focusedRunIds:evidence.focusedRunIds,evidenceDirectory:evidence.evidenceDirectory,reuse:true});
 assert(isDeepStrictEqual(current.recovery,evidence.recovery)&&isDeepStrictEqual(current.build,evidence.build)&&isDeepStrictEqual(current.artifacts,evidence.artifacts),'Recovered evidence changed before installation');
 return true;
}
