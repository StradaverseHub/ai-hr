/** Source-only authenticated evidence reader. No grant, installer, ref movement or deployment path. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,sourceBoundBuild,controllerRoot} from './release-ci.mjs';
import {REPOSITORY,WORKFLOW_ID,verifyArtifactBytes} from './release-policy.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {bindHistoryApplications} from './v9-history-source.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {validateFocusedMetadata} from './focused-recovery-policy.mjs';
import {V9_DB_CASE as pin,assessV9DbResource,collectPages,assertStableSnapshot} from './v9-db-resource-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:60000,maxBuffer:32*1024**2}));
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:16*1024**2}).trim();
const save=(dir,name,data)=>writeFileSync(join(dir,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
/** Refuse truncation; active runs older than the lookback are collected independently too. */
function pages(path,key){return collectPages(page=>api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`),key);}
function metadata(id){assert(Number.isSafeInteger(id)&&id>0,'Positive run ID required');return {run:api(`actions/runs/${id}`),jobs:pages(`actions/runs/${id}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${id}/artifacts`,'artifacts')};}
async function collect(id,dir){const facts=metadata(id);assert(facts.run.status==='completed'&&facts.run.run_attempt===1,'Complete first attempt required');mkdirSync(dir,{mode:0o700});save(dir,'run.json',facts.run);save(dir,'jobs.json',facts.jobs);save(dir,'artifacts.json',facts.artifacts);save(dir,'downloads.json',await downloadCiArchives(facts.artifacts,dir));const archives=new Map();for(const artifact of facts.artifacts){const bytes=readCiArchive(artifact,join(dir,artifact.name+'.zip'));verifyArtifactBytes(artifact,bytes);archives.set(artifact.name,bytes);}assertStableSnapshot(facts,metadata(id));return {...facts,archives};}
function extract(dir,name){const target=join(dir,name);execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),join(dir,name+'.zip'),target],{timeout:60000,stdio:'pipe'});return new Map(readdirSync(target).map(file=>[file,JSON.parse(readFileSync(join(target,file),'utf8'))]));}
function history(source,ids){const since=new Date(Date.parse(source.run.created_at)-86400000).toISOString(),query='created='+encodeURIComponent('>='+since),rows=[];for(const id of ids)rows.push(...pages(`actions/workflows/${id}/runs?${query}`,'workflow_runs'));for(const status of ['queued','in_progress','waiting','requested','pending'])rows.push(...pages(`actions/runs?status=${status}`,'workflow_runs').filter(run=>ids.includes(run.workflow_id)));return rows;}
export async function assessV9DatabaseEvidence({candidatePath,focusedRunId,evidenceDirectory}){
 candidatePath=resolve(candidatePath);assert(cleanHead(candidatePath)===pin.candidate,'Only the frozen V9 application is supported');assert(git(candidatePath,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Foreign source repository');
 const review=cleanHead(controllerRoot),dir=evidenceDirectory??mkdtempSync(join(tmpdir(),'v9-db-resource-review-'));mkdirSync(dir,{recursive:true,mode:0o700});
 const sourceDir=join(dir,'original'),source=await collect(pin.runId,sourceDir),archivedPlan=extract(sourceDir,'gate-plan').get('ci-plan.json');
 const local=createPlan(candidatePath),{fingerprint:unused,...body}={...local,controller:pin.controller,migrationBase:pin.baseline,runtime:archivedPlan.runtime};
 const plan={...body,fingerprint:hash(body)},expected={candidate:pin.candidate,controller:pin.controller,baseline:pin.baseline,runId:pin.runId};
 const assessment=assessResumeSource({...source,expectedPlan:plan,expected});save(dir,'original-assessment.json',assessment);
 const reports=plan.units.map(unit=>extract(sourceDir,'unit-'+unit.id).get(`unit-${unit.id}.json`));
 const workflow=api('actions/workflows/alpha-focused-checks.yml'),browser=api('actions/workflows/alpha-staging-browser-checks.yml');assert(workflow.path==='.github/workflows/alpha-focused-checks.yml'&&workflow.state==='active'&&browser.path==='.github/workflows/alpha-staging-browser-checks.yml'&&browser.state==='active','Workflow registry changed');
 const focusDir=join(dir,'focused'),focused=await collect(Number(focusedRunId),focusDir),producer=validateFocusedMetadata({...focused,expected:{runId:Number(focusedRunId),controller:pin.controller,workflowId:workflow.id,after:source.run.updated_at}});
 const artifact=focused.artifacts[0],packetDir=join(focusDir,'packet');execFileSync('python3',[fileURLToPath(new URL('./v9-db-resource-extract.py',import.meta.url)),join(focusDir,artifact.name+'.zip'),packetDir],{timeout:60000,stdio:'pipe'});
 const report=JSON.parse(readFileSync(join(packetDir,'focused.json'),'utf8')),result=JSON.parse(readFileSync(join(packetDir,'db.vitest.json'),'utf8')),state=JSON.parse(readFileSync(join(packetDir,'postgres-state.json'),'utf8'));
 const log=execFileSync('gh',['api',`repos/${REPOSITORY}/actions/jobs/${producer.id}/logs`],{encoding:'utf8',timeout:60000,maxBuffer:16*1024**2});writeFileSync(join(focusDir,'producer.log'),log,{flag:'wx',mode:0o600});
 const ids=[WORKFLOW_ID,workflow.id,browser.id],historyRows=history(source,ids),bindings=bindHistoryApplications({rows:historyRows,original:source.run,focusedRunId:Number(focusedRunId),metadata,directory:dir});save(dir,'history.json',historyRows);save(dir,'history-bindings.json',[...bindings]);
 const resultProof=assessV9DbResource({plan,assessment,source,reports,focused:{...focused,report,result,state},classifierHash:hash(readFileSync(join(candidatePath,'scripts/gate-db-classify.ts'),'utf8')),selectedLog:log,history:historyRows,historyBindings:bindings,workflowIds:ids,focusedWorkflowId:workflow.id,verificationController:review});
 const buildArtifact=source.artifacts.find(a=>a.name===BUILD_ARTIFACT);assert(buildArtifact,'Original canonical build required');execFileSync('python3',[fileURLToPath(new URL('./build-transport-extract.py',import.meta.url)),join(sourceDir,BUILD_ARTIFACT+'.zip'),join(sourceDir,BUILD_ARTIFACT),buildArtifact.digest.slice(7)],{timeout:60000,stdio:'pipe'});
 const build=await sourceBoundBuild({candidatePath,dir:sourceDir,p:{...expected,controllerBranch:source.run.head_branch},jobs:source.jobs});
 assertStableSnapshot({run:source.run,jobs:source.jobs,artifacts:source.artifacts},metadata(pin.runId));assertStableSnapshot({run:focused.run,jobs:focused.jobs,artifacts:focused.artifacts},metadata(Number(focusedRunId)));
 const finalHistory=history(source,ids),finalBindings=bindHistoryApplications({rows:finalHistory,original:source.run,focusedRunId:Number(focusedRunId),metadata,directory:dir});assessV9DbResource({plan,assessment,source,reports,focused:{...focused,report,result,state},classifierHash:hash(readFileSync(join(candidatePath,'scripts/gate-db-classify.ts'),'utf8')),selectedLog:log,history:finalHistory,historyBindings:finalBindings,workflowIds:ids,focusedWorkflowId:workflow.id,verificationController:review});
 assert(cleanHead(candidatePath)===pin.candidate&&cleanHead(controllerRoot)===review,'Source changed during read-only assessment');
 const proof={...resultProof,build,installationEligible:false,releaseAuthorized:false,originalArtifacts:source.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest})),apiAndArchiveChecks:'authenticated read-only assessment; no release admission',evidenceDirectory:dir};save(dir,'review-only-assessment.json',proof);return proof;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const [candidatePath,focusedRunId,evidenceDirectory]=process.argv.slice(2);assert(candidatePath&&/^\d+$/.test(focusedRunId??''),'Usage: v9-db-resource-assessment.mjs <clean-72a-path> <focused-run-id> [private-evidence-directory]');const r=await assessV9DatabaseEvidence({candidatePath,focusedRunId:Number(focusedRunId),evidenceDirectory});console.log(JSON.stringify({kind:r.kind,candidate:r.candidate,tests:r.tests,installationEligible:false,releaseAuthorized:false,evidenceDirectory:r.evidenceDirectory}));}
