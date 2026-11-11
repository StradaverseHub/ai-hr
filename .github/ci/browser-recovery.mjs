/** Authenticated exact-source recovery; producer and reviewed operator identities remain distinct. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY,WORKFLOW_ID} from './release-policy.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {validateBrowserMetadata,verifyBrowserRecovery,BROWSER_WORKFLOW_ID} from './browser-recovery-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
function pages(path,key){const rows=[];for(let p=1;p<=10;p++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${p}`);assert(Array.isArray(r[key]),'Missing API inventory');rows.push(...r[key]);if(r[key].length<100)return rows;}throw Error('API inventory exceeds bounded recovery');}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2,timeout:60000}).trim();
const facts=m=>({run:m.run,jobs:m.jobs,artifacts:m.artifacts});
const metadata=id=>({run:api(`actions/runs/${id}`),jobs:pages(`actions/runs/${id}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${id}/artifacts`,'artifacts')});
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export function validateBrowserControllerDelta(records){
 const allowed=new Set(['.github/ci/browser-recovery.mjs','.github/ci/browser-recovery-policy.mjs','.github/ci/browser-recovery.test.mjs','.github/ci/operator-release.mjs','.github/ci/staging-preflight.test.mjs','.github/ci/ci-install-grant.mjs','.github/workflows/alpha-staging.yml','.github/workflows/alpha-staging-browser-checks.yml','docs/BROWSER-CAPACITY-RECOVERY.md']);
 assert(records.length>0&&records.every(p=>allowed.has(p)),'Recovery producer changed application, runtime, unit runner or unrelated controls');
 for(const p of ['.github/ci/browser-recovery.mjs','.github/ci/browser-recovery-policy.mjs','.github/ci/browser-recovery.test.mjs','.github/workflows/alpha-staging-browser-checks.yml'])assert(records.includes(p),'Incomplete recovery controller');
}
export function validateBrowserHistory({source,rows,candidateBranch,browserRunId,auxiliaryRunIds}){
 const titles=new Set([`Alpha CI · ${candidateBranch}`,`Focused only · ${candidateBranch}`,`Tooling transport only · ${candidateBranch}`,`Canonical build only · ${candidateBranch}`]);
 assert(source.run.display_title===`Alpha CI · ${candidateBranch}`&&Array.isArray(rows)&&rows.length<=8000,'Frozen source branch/history required');
 const known=new Set([browserRunId,...auxiliaryRunIds]),found=new Map();
 for(const r of rows){if(r.id===source.run.id||!titles.has(r.display_title))continue;
  assert(positiveId(r.id)&&Number.isFinite(Date.parse(r.created_at))&&Number.isFinite(Date.parse(r.updated_at))&&Date.parse(r.updated_at)>=Date.parse(r.created_at),'Malformed relevant history');
  if(r.status==='completed'&&Date.parse(r.updated_at)<Date.parse(source.run.created_at))continue;
  assert(known.has(r.id)&&r.status==='completed'&&r.conclusion==='success'&&r.run_attempt===1,'Unaccounted, pending, failed or superseding source execution');
  const record={id:r.id,workflowId:r.workflow_id,title:r.display_title,controller:r.head_sha,conclusion:r.conclusion,attempt:r.run_attempt,createdAt:r.created_at,updatedAt:r.updated_at};
  assert(!found.has(r.id)||isDeepStrictEqual(found.get(r.id),record),'Conflicting relevant history');found.set(r.id,record);
 }
 assert(found.size===known.size&&[...known].every(id=>found.has(id)),'Incomplete recovery/auxiliary history');
 for(const id of auxiliaryRunIds)assert(found.get(id).title===`Focused only · ${candidateBranch}`&&found.get(id).controller===source.run.head_sha,'Only successful unchanged-controller focused auxiliary checks allowed');
 return {kind:'AUTHENTICATED_BROWSER_RECOVERY_HISTORY',sourceRunId:source.run.id,executions:[...found.values()].sort((a,b)=>a.id-b.id)};
}
const positiveId=n=>Number.isSafeInteger(n)&&n>0;
function planAt(candidatePath,controller,baseline){
 const previous=process.env.AIHR_CI_CLASSIFIER_RUNTIME;process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';
 try{const local=createPlan(candidatePath),{fingerprint,...body}={...local,controller,migrationBase:baseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'}};return {...body,fingerprint:hash(body)};}
 finally{if(previous===undefined)delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;else process.env.AIHR_CI_CLASSIFIER_RUNTIME=previous;}
}
export async function verifyBrowserRecoveredCi({candidatePath,runId,baseline,browserRunId,candidateBranch,controllerBranch,browserProducerController,browserProducerBranch,producerDiagnosticRunId,auxiliaryRunIds=[],evidenceDirectory,reuse=false}){
 candidatePath=resolve(candidatePath);runId=Number(runId);browserRunId=Number(browserRunId);
 assert(positiveId(runId)&&positiveId(browserRunId)&&runId!==browserRunId&&/^[a-f0-9]{40}$/.test(baseline??''),'Exact original/browser/baseline required');
 for(const branch of [candidateBranch,controllerBranch,browserProducerBranch])assert(/^codex\/[A-Za-z0-9._/-]+$/.test(branch??'')&&!branch.includes('..'),'Exact owned source/controller branches required');
 assert(auxiliaryRunIds.length<=16&&auxiliaryRunIds.every(id=>positiveId(id)&&![runId,browserRunId].includes(id))&&new Set(auxiliaryRunIds).size===auxiliaryRunIds.length,'Distinct bounded auxiliary run IDs required');
 const candidate=cleanHead(candidatePath),verificationController=cleanHead(controllerRoot);
 assert(/^[a-f0-9]{40}$/.test(browserProducerController??'')&&positiveId(producerDiagnosticRunId),'Exact original browser producer and hosted diagnostic required');
 const reviewedController=process.env.AIHR_BROWSER_REVIEWED_CONTROLLER??null;assert(reviewedController===null||reviewedController===verificationController,'Reviewed browser verifier changed');
 assert(git(candidatePath,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Foreign source origin');
 execFileSync('git',['merge-base','--is-ancestor',baseline,candidate],{cwd:candidatePath,stdio:'ignore'});
 const checkRefs=()=>{
  for(const [b,s] of [[candidateBranch,candidate],[controllerBranch,verificationController],[browserProducerBranch,browserProducerController]])assert(api('git/ref/heads/'+b.split('/').map(encodeURIComponent).join('/')).object?.sha===s,'Frozen recovery branch moved');
  for(const b of ['main','alpha'])assert([baseline,candidate].includes(api('git/ref/heads/'+b).object?.sha),'Canonical baseline moved');
 };checkRefs();
 const originalMetadata=metadata(runId),controller=originalMetadata.run.head_sha;
 assert(originalMetadata.run.status==='completed'&&originalMetadata.run.conclusion==='failure'&&originalMetadata.run.run_attempt===1,'Wait for every original gate chunk to finish');
 execFileSync('git',['merge-base','--is-ancestor',controller,verificationController],{cwd:controllerRoot,stdio:'ignore'});
 validateBrowserControllerDelta(git(controllerRoot,'diff','--name-only',controller,verificationController).split('\n').filter(Boolean));
 execFileSync('git',['merge-base','--is-ancestor',controller,browserProducerController],{cwd:controllerRoot,stdio:'ignore'});
 validateBrowserControllerDelta(git(controllerRoot,'diff','--name-only',controller,browserProducerController).split('\n').filter(Boolean));
 assert(readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8').includes(' .github/ci/browser-recovery.test.mjs'),'Hosted integrity must include recovery refusal tests');
 const diagnosticId=Number(process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID);assert(positiveId(diagnosticId),'Frozen verifier controller-only run required');
 const verificationDiagnostic=validateRecoveryControllerDiagnostic({...metadata(diagnosticId),controller:verificationController});
 const producerDiagnostic=validateRecoveryControllerDiagnostic({...metadata(producerDiagnosticRunId),controller:browserProducerController});
 const workflow=api('actions/workflows/alpha-staging-browser-checks.yml');assert(workflow.id===BROWSER_WORKFLOW_ID&&workflow.path==='.github/workflows/alpha-staging-browser-checks.yml'&&workflow.state==='active','Browser workflow registry differs');
 const browserMetadata=metadata(browserRunId),producer=validateBrowserMetadata({...browserMetadata,expected:{runId:browserRunId,controller:browserProducerController,branch:browserProducerBranch,candidateBranch,after:originalMetadata.run.updated_at}});
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`validated-browser-recovery-${runId}-${randomUUID()}`);
 const source=await collectRecoveryEvidence(runId,dir,{reuse,prefetchDirectory:process.env.AIHR_CI_PREFETCH_DIR||undefined});
 assert(isDeepStrictEqual(originalMetadata,facts(source)),'Original metadata changed during collection');
 const plan=planAt(candidatePath,controller,baseline),freshPlan=planAt(candidatePath,browserProducerController,baseline);
 const assessment=assessResumeSource({...source,expectedPlan:plan,expected:{candidate,controller,baseline,runId}});
 const fresh=await collectRecoveryEvidence(browserRunId,join(dir,'browser-'+browserRunId),{reuse});assert(isDeepStrictEqual(browserMetadata,facts(fresh)),'Browser metadata changed during collection');
 const packet=fresh.parsed.get('diagnostic-complete-image-browser-firefox'),binding=fresh.parsed.get('browser-recovery-runtime-firefox');
 assert(binding?.size===1&&binding.has('image-binding.json'),'Exact runtime binding packet required');
 assert(packet?.has('unit-browser-firefox.json')&&[...packet.keys()].every(n=>/^(unit-browser-firefox|health-before-browser-firefox|browser-firefox-batch-\d+)\.json$/.test(n)),'Unexpected Firefox packet member');
 const recovery=verifyBrowserRecovery({plan,freshPlan,assessment,run:source.run,jobs:source.jobs,reports:plan.units.map(u=>source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`)),fresh:{...fresh,producer,binding:binding.get('image-binding.json'),report:packet.get('unit-browser-firefox.json')},verificationController,verificationDiagnostic,producerDiagnostic,reviewedController,lockSha256:createHash('sha256').update(readFileSync(join(candidatePath,'pnpm-lock.yaml'))).digest('hex')});
 const since=new Date(Date.parse(source.run.created_at)-86400000).toISOString(),rows=pages('actions/runs?created='+encodeURIComponent('>='+since),'workflow_runs').filter(r=>[WORKFLOW_ID,BROWSER_WORKFLOW_ID].includes(r.workflow_id)||r.path==='.github/workflows/alpha-focused-checks.yml');
 for(const status of ['queued','in_progress','waiting','requested','pending'])rows.push(...pages('actions/runs?status='+status,'workflow_runs'));
 recovery.history=validateBrowserHistory({source,rows,candidateBranch,browserRunId,auxiliaryRunIds});
 const build=await sourceBoundBuild({candidatePath,dir,p:{candidate,controller,baseline,runId,controllerBranch:source.run.head_branch},jobs:source.jobs});
 assert(isDeepStrictEqual(originalMetadata,metadata(runId))&&isDeepStrictEqual(browserMetadata,metadata(browserRunId)),'Recovery API evidence changed before admission');
 assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===verificationController,'Recovery source/controller changed');checkRefs();
 const result={...recovery,tier:'ci',result:'PASS',recovery,fingerprint:hash(recovery),build,candidatePath,controllerBranch:source.run.head_branch,browserControllerBranch:controllerBranch,browserProducerController,browserProducerBranch,producerDiagnosticRunId,candidateBranch,auxiliaryRunIds,browserRunId,verifiedAt:new Date().toISOString(),url:source.run.html_url,evidenceDirectory:dir,artifacts:source.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest})),installationAuthorized:false};
 save(dir,reuse?`revalidation-${randomUUID()}.json`:'verification.json',result);return result;
}

export async function revalidateBrowserRecoveredCi(evidence){
 assert(evidence.verificationController===cleanHead(controllerRoot),'Browser recovery verification controller changed');
 const current=await verifyBrowserRecoveredCi({candidatePath:evidence.candidatePath,runId:evidence.runId,baseline:evidence.baseline,browserRunId:evidence.browserRunId,candidateBranch:evidence.candidateBranch,controllerBranch:evidence.browserControllerBranch,browserProducerController:evidence.browserProducerController,browserProducerBranch:evidence.browserProducerBranch,producerDiagnosticRunId:evidence.producerDiagnosticRunId,auxiliaryRunIds:evidence.auxiliaryRunIds,evidenceDirectory:evidence.evidenceDirectory,reuse:true});
 assert(isDeepStrictEqual(current.recovery,evidence.recovery)&&isDeepStrictEqual(current.build,evidence.build)&&isDeepStrictEqual(current.artifacts,evidence.artifacts),'Browser recovery changed before installation');return true;
}
