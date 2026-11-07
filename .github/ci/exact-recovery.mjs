/** Unchanged-source recovery v3: independently authenticate complete failed DB/Node processes.
 * Original app source, producer, successful build and failures keep their own exact identities.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY} from './release-policy.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {validateFocusedMetadata,validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {verifyExactRecovery,requireReviewedExactController,validateExactRecoveryHistory} from './exact-recovery-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
function pages(path,key){const rows=[];for(let page=1;page<=10;page++){const d=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);assert(Array.isArray(d[key]),'Missing API inventory');rows.push(...d[key]);if(d[key].length<100)return rows;}throw Error('Recovery API inventory exceeds bound');}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2}).trim();
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
function planAt(path){const previous=process.env.AIHR_CI_CLASSIFIER_RUNTIME;process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';try{return createPlan(path);}finally{if(previous===undefined)delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;else process.env.AIHR_CI_CLASSIFIER_RUNTIME=previous;}}
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
 const p={candidate,controller,baseline,runId};
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`validated-exact-recovery-${runId}-${randomUUID()}`);
 const source=await collectRecoveryEvidence(runId,dir,{reuse,prefetchDirectory:process.env.AIHR_CI_PREFETCH_DIR||undefined});
 const plan=source.parsed.get('gate-plan')?.get('ci-plan.json'),local=planAt(candidatePath);assert(plan,'Missing original archived plan');
 const {fingerprint:unused,...body}={...local,controller,migrationBase:baseline,runtime:plan.runtime};
 const expectedPlan={...body,fingerprint:hash(body)};
 const assessment=assessResumeSource({...source,expectedPlan,expected:p});
 const workflow=api('actions/workflows/alpha-focused-checks.yml');
 assert(workflow.path==='.github/workflows/alpha-focused-checks.yml'&&workflow.state==='active','Focused workflow registry differs');
 const focused=[];
 for(const id of focusedRunIds.slice().sort((a,b)=>a-b)){
  const sub=join(dir,`focused-${id}`),prefetch=process.env.AIHR_CI_PREFETCH_DIR?join(process.env.AIHR_CI_PREFETCH_DIR,`focused-${id}`):null;
  const f=await collectRecoveryEvidence(id,sub,{reuse,repairPackets:true,prefetchDirectory:prefetch&&existsSync(prefetch)?prefetch:undefined});
  const producer=validateFocusedMetadata({...f,expected:{runId:id,controller,workflowId:workflow.id,after:source.run.updated_at}});
  const artifact=f.artifacts[0],packet=f.parsed.get(artifact.name);
  const report=packet.get('focused.json'),resultName=report?.groups?.DB?.length>0?'db.vitest.json':'nodb.vitest.json';
  assert(isDeepStrictEqual([...packet.keys()].sort(),['focused.json',resultName].sort()),'Exact homogeneous focused packet members required');
  focused.push({...f,producer,artifact,report,result:packet.get(resultName)});
 }
 const reports=plan.units.map(u=>source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`));
 const recovery=verifyExactRecovery({plan:expectedPlan,assessment,run:source.run,jobs:source.jobs,reports,focused,classifierHash:hash(readFileSync(join(candidatePath,'scripts/gate-db-classify.ts'),'utf8')),verificationController});
 const candidateBranch=source.run.display_title?.slice('Alpha CI · '.length);
 assert(typeof candidateBranch==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidateBranch)&&!candidateBranch.includes('..'),'Exact frozen candidate branch required');
 assert(api('git/ref/heads/'+candidateBranch.split('/').map(encodeURIComponent).join('/')).object?.sha===candidate,'Candidate branch moved');
 const since=new Date(Date.parse(source.run.created_at)-86400000).toISOString(),query='created='+encodeURIComponent('>='+since);
 const rows=[...pages(`actions/workflows/${source.run.workflow_id}/runs?${query}`,'workflow_runs'),...pages(`actions/workflows/${workflow.id}/runs?${query}`,'workflow_runs')];
 for(const status of ['queued','in_progress','waiting','requested','pending'])rows.push(...pages(`actions/runs?status=${status}`,'workflow_runs').filter(r=>[source.run.workflow_id,workflow.id].includes(r.workflow_id)));
 recovery.history=validateExactRecoveryHistory({sourceRun:source.run,rows,candidateBranch,focusedRunIds});
 recovery.verificationDiagnostic=verificationDiagnostic;recovery.reviewedController=verificationController;
 const build=await sourceBoundBuild({candidatePath,dir,p:{...p,controllerBranch:source.run.head_branch},jobs:source.jobs});
 assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===verificationController,'Recovery source/controller changed');
 const alpha=api('git/ref/heads/alpha');assert([baseline,candidate].includes(alpha.object?.sha),'Canonical alpha moved away from recovery source');
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
