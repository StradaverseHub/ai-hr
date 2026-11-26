/** aihr-db-unit-recovery/v1 operator adapter. Original failed run, reports and build stay immutable. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,verifyArtifactBytes} from './release-policy.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {BROWSER_WORKFLOW_ID} from './browser-recovery-policy.mjs';
import {validateDbFocusedMetadata,validateDbUnitHistory,verifyDbUnitRecovery,dbUnitOwnerDecision} from './db-unit-recovery-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
function pages(path,key){const rows=[];for(let p=1;p<=10;p++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${p}`);assert(Array.isArray(r[key]),'Missing API inventory');rows.push(...r[key]);if(r[key].length<100)return rows;}throw Error('API inventory exceeds bounded recovery');}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2,timeout:60000}).trim();
const metadata=n=>({run:api(`actions/runs/${n}`),jobs:pages(`actions/runs/${n}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${n}/artifacts`,'artifacts')});
const facts=m=>({run:m.run,jobs:m.jobs,artifacts:m.artifacts});
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const positive=n=>Number.isSafeInteger(n)&&n>0;
function planAt(path,{controller,baseline,runtime}){
 const previous=process.env.AIHR_CI_CLASSIFIER_RUNTIME;process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';
 try{const local=createPlan(path),{fingerprint,...body}={...local,controller,migrationBase:baseline,runtime};return {...body,fingerprint:hash(body)};}
 finally{if(previous===undefined)delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;else process.env.AIHR_CI_CLASSIFIER_RUNTIME=previous;}
}
/** Download one digest-authenticated artifact and extract only the named JSON members with a bounded extractor. */
async function authenticatedMembers(artifact,sub,reuse,extractor,members){
 if(!reuse){mkdirSync(sub,{recursive:true,mode:0o700});await downloadCiArchives([artifact],sub);}
 const zip=join(sub,artifact.name+'.zip'),bytes=readCiArchive(artifact,zip);verifyArtifactBytes(artifact,bytes);
 const out=join(sub,'extracted-'+randomUUID());
 execFileSync('python3',[fileURLToPath(new URL(extractor,import.meta.url)),zip,out],{timeout:60000,stdio:'pipe'});
 assert(isDeepStrictEqual(readdirSync(out).sort(),members),'Unexpected extracted members: '+artifact.name);
 return new Map(members.map(name=>[name,JSON.parse(readFileSync(join(out,name),'utf8'))]));
}
/** The digest-authenticated gate-plan of a later same-branch gate (its source SHA) and its complete job conclusions. */
async function laterGatePlan(row,dir,reuse){
 const jobs=pages(`actions/runs/${row.id}/jobs?filter=all`,'jobs').map(j=>({name:j.name,status:j.status,conclusion:j.conclusion,attempt:j.run_attempt,runId:j.run_id}));
 assert(jobs.every(j=>j.runId===row.id),'Foreign later gate job');
 const artifacts=pages(`actions/runs/${row.id}/artifacts`,'artifacts').filter(a=>a.name==='gate-plan');
 assert(artifacts.length===1,'Later gate has no unique gate-plan to prove its source: '+row.id);
 const a=artifacts[0],w=a.workflow_run;assert(w?.id===row.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===row.head_sha&&/^sha256:[a-f0-9]{64}$/.test(a.digest),'Foreign later gate-plan artifact');
 const plan=(await authenticatedMembers(a,join(dir,'later-gate-'+row.id),reuse,'./extract-artifact.py',['ci-plan.json'])).get('ci-plan.json');
 return {sha:plan.sha,controller:plan.controller,migrationBase:plan.migrationBase,fingerprint:plan.fingerprint,artifactId:a.id,digest:a.digest,jobs};
}
export async function verifyDbUnitRecoveredCi({candidatePath,runId,baseline,focusedRunIds,candidateBranch,ownerApproval,evidenceDirectory,reuse=false}){
 candidatePath=resolve(candidatePath);runId=Number(runId);
 assert(positive(runId)&&/^[a-f0-9]{40}$/.test(baseline??''),'Exact original run and baseline required');
 assert(Array.isArray(focusedRunIds)&&focusedRunIds.length>0&&focusedRunIds.length<=16&&focusedRunIds.every(n=>positive(n)&&n!==runId)&&new Set(focusedRunIds).size===focusedRunIds.length,'Distinct bounded focused run inventory required');
 assert(typeof candidateBranch==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidateBranch)&&!candidateBranch.includes('..'),'Exact candidate branch required');
 const candidate=cleanHead(candidatePath),verificationController=cleanHead(controllerRoot);
 assert(git(candidatePath,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Unexpected repository');
 execFileSync('git',['merge-base','--is-ancestor',baseline,candidate],{cwd:candidatePath,stdio:'ignore'});
 const checkRefs=()=>{
  assert(api('git/ref/heads/'+candidateBranch.split('/').map(encodeURIComponent).join('/')).object?.sha===candidate,'Candidate branch moved away from the verified source');
  assert([baseline,candidate].includes(api('git/ref/heads/alpha').object?.sha),'Canonical alpha moved away from recovery source');
 };checkRefs();
 assert(readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8').includes(' .github/ci/db-unit-recovery.test.mjs'),'Hosted integrity suite must include DB-unit recovery refusal tests');
 const diagnosticId=Number(process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID);assert(positive(diagnosticId),'AIHR_RECOVERY_CONTROLLER_RUN_ID must identify the frozen verifier controller-only validation');
 const verificationDiagnostic=validateRecoveryControllerDiagnostic({...metadata(diagnosticId),controller:verificationController});
 const originalMetadata=metadata(runId),controller=originalMetadata.run.head_sha;
 assert(originalMetadata.run.status==='completed'&&originalMetadata.run.conclusion==='failure'&&originalMetadata.run.run_attempt===1,'Original gate must be a completed failed first attempt');
 // Review 2026-11-24: the former path allowlist admitted unreviewed edits to operator-release, the grant and the workflow.
 assert(controller===verificationController,'Verify from the exact original gate controller checkout');
 const ownerDecision=dbUnitOwnerDecision({approval:ownerApproval,runId,candidate});
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`validated-db-unit-recovery-${runId}-${randomUUID()}`);
 const source=await collectRecoveryEvidence(runId,dir,{reuse,prefetchDirectory:process.env.AIHR_CI_PREFETCH_DIR||undefined});
 assert(isDeepStrictEqual(originalMetadata,facts(source)),'Original metadata changed during collection');
 const archived=source.parsed.get('gate-plan')?.get('ci-plan.json');assert(archived,'Missing original archived plan');
 const plan=planAt(candidatePath,{controller,baseline,runtime:archived.runtime});
 const assessment=assessResumeSource({...source,expectedPlan:plan,expected:{candidate,controller,baseline,runId}});
 const workflow=api('actions/workflows/alpha-focused-checks.yml');assert(workflow.path==='.github/workflows/alpha-focused-checks.yml'&&workflow.state==='active','Focused workflow registry differs');
 const focused=[],focusedMetadata=new Map();
 for(const n of focusedRunIds.slice().sort((a,b)=>a-b)){
  const m=metadata(n),producer=validateDbFocusedMetadata({...m,expected:{runId:n,controller,controllerBranch:source.run.head_branch,workflowId:workflow.id,candidateBranch,after:source.run.updated_at}});
  const sub=join(dir,'focused-'+n),artifact=m.artifacts[0];if(!reuse){mkdirSync(sub,{recursive:true,mode:0o700});for(const [k,v] of Object.entries(facts(m)))save(sub,k+'.json',v);}
  const packet=await authenticatedMembers(artifact,sub,reuse,'./db-unit-recovery-extract.py',['db.vitest.json','focused.json']);
  focusedMetadata.set(n,m);focused.push({...facts(m),producer,artifact,report:packet.get('focused.json'),result:packet.get('db.vitest.json')});
 }
 const since=new Date(Date.parse(source.run.created_at)-86400000).toISOString(),query='created='+encodeURIComponent('>='+since);
 // Review 2026-11-24: include the browser-tooling workflow, whose `Tooling transport only` title the history already names.
 const workflows=[WORKFLOW_ID,workflow.id,BROWSER_WORKFLOW_ID],rows=workflows.flatMap(w=>pages(`actions/workflows/${w}/runs?${query}`,'workflow_runs'));
 for(const status of ['queued','in_progress','waiting','requested','pending'])rows.push(...pages(`actions/runs?status=${status}`,'workflow_runs').filter(r=>workflows.includes(r.workflow_id)));
 const laterGatePlans=new Map();
 for(const r of rows)if(r.display_title===`Alpha CI · ${candidateBranch}`&&r.id!==runId&&r.status==='completed'&&r.conclusion==='cancelled'&&Date.parse(r.updated_at)>=Date.parse(source.run.updated_at)&&!laterGatePlans.has(r.id))laterGatePlans.set(r.id,await laterGatePlan(r,dir,reuse));
 const history=validateDbUnitHistory({source,rows,candidate,candidateBranch,focusedRunIds,laterGatePlans});
 const reports=plan.units.map(u=>source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`));
 const recovery=verifyDbUnitRecovery({plan,assessment,run:source.run,jobs:source.jobs,reports,focused,classifierHash:hash(readFileSync(join(candidatePath,'scripts/gate-db-classify.ts'),'utf8')),verificationController,verificationDiagnostic,history,ownerDecision});
 const build=await sourceBoundBuild({candidatePath,dir,p:{candidate,controller,baseline,runId,controllerBranch:source.run.head_branch},jobs:source.jobs});
 assert(isDeepStrictEqual(originalMetadata,metadata(runId))&&[...focusedMetadata].every(([n,m])=>isDeepStrictEqual(m,metadata(n))),'Recovery API evidence changed before admission');
 assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===verificationController,'Recovery source/controller changed');checkRefs();
 const result={...recovery,tier:'ci',result:'PASS',resultKind:'OWNER_APPROVED_DB_UNIT_RECOVERY_EXCEPTION',recovery,fingerprint:hash(recovery),build,candidatePath,candidateBranch,...(ownerApproval===undefined?{}:{ownerApproval}),controllerBranch:source.run.head_branch,focusedRunIds:focusedRunIds.slice().sort((a,b)=>a-b),verifiedAt:new Date().toISOString(),url:source.run.html_url,evidenceDirectory:dir,artifacts:source.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))};
 save(dir,reuse?`revalidation-${randomUUID()}.json`:'verification.json',result);return result;
}
export async function revalidateDbUnitRecoveredCi(evidence){
 assert(evidence.verificationController===cleanHead(controllerRoot),'DB-unit recovery verification controller changed');
 assert(existsSync(evidence.evidenceDirectory),'Recovery evidence directory missing');
 const current=await verifyDbUnitRecoveredCi({candidatePath:evidence.candidatePath,runId:evidence.runId,baseline:evidence.baseline,focusedRunIds:evidence.focusedRunIds,candidateBranch:evidence.candidateBranch,ownerApproval:evidence.ownerApproval,evidenceDirectory:evidence.evidenceDirectory,reuse:true});
 assert(isDeepStrictEqual(current.recovery,evidence.recovery)&&isDeepStrictEqual(current.build,evidence.build)&&isDeepStrictEqual(current.artifacts,evidence.artifacts),'DB-unit recovery evidence changed before installation');return true;
}
