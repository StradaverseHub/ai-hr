/** Authenticate one complete interrupted DB unit without rewriting original evidence. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY,WORKFLOW_ID,validateRun,validateJobs,validateArtifacts,verifyArtifactBytes} from './release-policy.mjs';
import {requiredEvidence} from './manifest.mjs';
import {COMPILER_STATE_ARTIFACT} from './compiler-cache-protocol.mjs';
import {NEXT_APPLICATION_STATE} from './next-application-cache-protocol.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {UNIT_RECOVERY,validateInterruptedSource,validateUnitProducer,verifyUnitRecovery} from './unit-recovery-policy.mjs';
const api=p=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${p}`],{encoding:'utf8',timeout:60000,maxBuffer:128*1024**2}));
function pages(path,key){const rows=[];for(let p=1;p<=10;p++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${p}`);assert(Array.isArray(r[key]));rows.push(...r[key]);if(r[key].length<100)return rows;}throw Error('Bounded recovery API inventory exceeded');}
const metadata=id=>({run:api(`actions/runs/${id}`),jobs:pages(`actions/runs/${id}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${id}/artifacts`,'artifacts')});
const facts=m=>({run:m.run,jobs:m.jobs,artifacts:m.artifacts});
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:60000,maxBuffer:64*1024**2}).trim();
const save=(dir,name,data)=>writeFileSync(join(dir,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
export function planAt(path,controller,baseline){
 const previous=process.env.AIHR_CI_CLASSIFIER_RUNTIME;process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';
 try{const local=createPlan(path),{fingerprint,...body}={...local,controller,migrationBase:baseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'}};return {...body,fingerprint:hash(body)};}
 finally{if(previous===undefined)delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;else process.env.AIHR_CI_CLASSIFIER_RUNTIME=previous;}
}
export const CONTROLLER_PATHS=Object.freeze(['.github/ci/unit-recovery.mjs','.github/ci/unit-recovery-policy.mjs','.github/ci/unit-recovery-selection.mjs','.github/ci/unit-recovery.test.mjs','.github/ci/operator-release.mjs','.github/ci/ci-install-grant.mjs','.github/ci/focused-recovery.mjs','.github/ci/fixed-noto-bootstrap.mjs','.github/ci/system-label-fonts.test.mjs','.github/ci/staging-preflight.test.mjs','.github/workflows/alpha-staging.yml']);
export function validateUnitControllerDelta(paths){assert(paths.length>0&&new Set(paths).size===paths.length&&paths.every(p=>CONTROLLER_PATHS.includes(p)),'Recovery controller changed application, runner, PG, permissions or unrelated controls');for(const p of ['.github/ci/unit-recovery.mjs','.github/ci/unit-recovery-policy.mjs','.github/ci/unit-recovery-selection.mjs','.github/ci/unit-recovery.test.mjs','.github/workflows/alpha-staging.yml'])assert(paths.includes(p),'Incomplete recovery controller');}
export function validateExpectationDelta(paths){
 const allowed=['deploy/systemd/BANK-IMPORT.md','deploy/systemd/bank_import_worker_format.py','deploy/systemd/bank_import_worker_operation_guard_v1.py','deploy/systemd/bank_import_worker_prepared_v1.py','scripts/bank-import-worker-package.test.mjs','test/fixtures/bank-import-worker-package-tests.py','test/fixtures/bank-import-worker-prepared-tests.py'];
 assert(paths.length===allowed.length&&new Set(paths).size===allowed.length&&paths.every(p=>allowed.includes(p)),'Prior assertion expectation changed application/test/SQL/runtime sources');
}
export function validateUnitArchiveMetadata(m,allowed,producerFor){
 assert(new Set(m.artifacts.map(a=>a.name)).size===m.artifacts.length&&new Set(m.artifacts.map(a=>a.id)).size===m.artifacts.length,'Duplicate artifacts');
 for(const a of m.artifacts){const w=a.workflow_run,j=m.jobs.find(j=>j.name===producerFor(a.name));assert(allowed.has(a.name)&&w?.id===m.run.id&&w.head_sha===m.run.head_sha&&w.head_branch===m.run.head_branch&&w.repository_id===1333414856&&w.head_repository_id===1333414856&&!a.expired&&Number.isSafeInteger(a.id)&&a.id>0&&Number.isSafeInteger(a.size_in_bytes)&&a.size_in_bytes>0&&/^sha256:[a-f0-9]{64}$/.test(a.digest??''),'Artifact identity differs');assert(j&&j.conclusion==='success'&&Date.parse(a.created_at)>=Date.parse(j.started_at)&&Date.parse(a.created_at)<=Date.parse(j.completed_at)&&Date.parse(a.expires_at)>Date.now(),'Artifact outside successful producer');}
}
async function selected(m,dir,names,reuse){
 const artifacts=names.map(n=>{const a=m.artifacts.find(a=>a.name===n);assert(a,'Missing selected artifact');return a;});
 if(!reuse){mkdirSync(dir,{mode:0o700,recursive:true});await downloadCiArchives(artifacts,dir);}
 const temporary=mkdtempSync(join(tmpdir(),'aihr-unit-read-')),parsed=new Map();try{for(const a of artifacts){const path=join(dir,a.name+'.zip');verifyArtifactBytes(a,readCiArchive(a,path));const destination=join(temporary,a.name);execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),path,destination],{timeout:60000});parsed.set(a.name,new Map(readdirSync(destination).map(n=>[n,JSON.parse(readFileSync(join(destination,n),'utf8'))])));}
 return parsed;}finally{rmSync(temporary,{recursive:true,force:true});}
}
export function validateUnitHistory({source,rows,candidateBranch,unitRunId,controllerDiagnostics}){
 const titles=new Set([`Alpha CI · ${candidateBranch}`,`Focused only · ${candidateBranch}`,`Canonical build only · ${candidateBranch}`,`Complete unit recovery · ${UNIT_RECOVERY.unit} · ${candidateBranch}`]);const found=new Map();
 for(const r of rows){if(r.id===source.run.id||controllerDiagnostics.includes(r.id)||!titles.has(r.display_title))continue;if(r.status==='completed'&&Date.parse(r.updated_at)<Date.parse(source.run.created_at))continue;assert(r.id===unitRunId&&r.status==='completed'&&r.conclusion==='success'&&r.run_attempt===1,'Unaccounted, pending, failed or superseding source execution');const row={id:r.id,controller:r.head_sha,attempt:r.run_attempt,conclusion:r.conclusion,createdAt:r.created_at,updatedAt:r.updated_at};assert(!found.has(r.id)||isDeepStrictEqual(found.get(r.id),row));found.set(r.id,row);}
 assert(found.size===1&&found.has(unitRunId),'Incomplete recovery history');return {kind:'AUTHENTICATED_COMPLETE_UNIT_RECOVERY_HISTORY',sourceRunId:source.run.id,executions:[...found.values()]};
}
export async function verifyUnitRecoveredCi({candidatePath,runId,baseline,unitRunId,candidateBranch,controllerBranch,expectationPath,evidenceDirectory,reuse=false}){
 const c=UNIT_RECOVERY;candidatePath=resolve(candidatePath);expectationPath=resolve(expectationPath);runId=Number(runId);unitRunId=Number(unitRunId);
 const controller=cleanHead(controllerRoot);assert(runId===c.runId&&baseline===c.baseline&&Number.isSafeInteger(unitRunId)&&unitRunId>0&&unitRunId!==runId&&cleanHead(candidatePath)===c.source&&cleanHead(expectationPath)===c.expectationSource,'Exact frozen interrupted source/expectation required');
 assert(process.env.AIHR_UNIT_REVIEWED_CONTROLLER===controller,'Exact independently reviewed unit-recovery controller required');
 for(const b of [candidateBranch,controllerBranch])assert(/^codex\/[A-Za-z0-9._/-]+$/.test(b??'')&&!b.includes('..'),'Owned frozen branches required');
 const refs=()=>{for(const [b,s]of [[candidateBranch,c.source],[controllerBranch,controller]])assert(api('git/ref/heads/'+b.split('/').map(encodeURIComponent).join('/')).object?.sha===s,'Recovery branch moved');assert([c.baseline,c.source,c.controller].includes(api('git/ref/heads/alpha').object?.sha),'Alpha moved from original baseline/controller/candidate');};refs();
 for(const path of [candidatePath,expectationPath,controllerRoot])assert(git(path,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git');
 execFileSync('git',['merge-base','--is-ancestor',c.controller,controller],{cwd:controllerRoot});validateUnitControllerDelta(git(controllerRoot,'diff','--name-only',c.controller,controller).split('\n').filter(Boolean));
 validateExpectationDelta(git(candidatePath,'diff','--name-only',c.expectationSource,c.source).split('\n').filter(Boolean));
 const plan=planAt(candidatePath,c.controller,baseline),freshPlan=planAt(candidatePath,controller,baseline),priorPlan=planAt(expectationPath,c.expectationSource,baseline);
 const originalMetadata=metadata(runId);validateInterruptedSource({...originalMetadata,plan});
 const diagnosticId=Number(process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID);assert(Number.isSafeInteger(diagnosticId)&&diagnosticId>0);const diagnostic=metadata(diagnosticId),verificationDiagnostic=validateRecoveryControllerDiagnostic({...diagnostic,controller});
 assert(readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8').includes(' .github/ci/unit-recovery.test.mjs'),'Hosted refusal controls missing');
 const freshMetadata=metadata(unitRunId),producer=validateUnitProducer({...freshMetadata,controller,branch:controllerBranch,candidateBranch,after:originalMetadata.run.updated_at});
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`validated-unit-recovery-${runId}-${randomUUID()}`);
 const topology=requiredEvidence(plan),extras=[COMPILER_STATE_ARTIFACT,NEXT_APPLICATION_STATE];
 const producerFor=n=>n==='gate-plan'?'plan':extras.includes(n)?(n===COMPILER_STATE_ARTIFACT?'typecheck':'build'):n.startsWith('unit-')?((u)=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`)(plan.units.find(u=>'unit-'+u.id===n)):'build';
 validateUnitArchiveMetadata(originalMetadata,new Set([...topology.artifacts.filter(n=>!['gate-evidence','unit-'+c.unit].includes(n)),...extras]),producerFor);
 for(const name of topology.artifacts.filter(n=>!['gate-evidence','unit-'+c.unit].includes(n)))assert(originalMetadata.artifacts.some(a=>a.name===name),'Original retained artifact missing');
 const source=await collectRecoveryEvidence(runId,dir,{reuse,prefetchDirectory:process.env.AIHR_CI_PREFETCH_DIR||undefined,allowCancelled:true});assert(isDeepStrictEqual(originalMetadata,facts(source)));samePlan(source.parsed.get('gate-plan')?.get('ci-plan.json'),plan);
 validateUnitArchiveMetadata(freshMetadata,new Set(['gate-plan','unit-'+c.unit]),n=>n==='gate-plan'?'plan':`test (${c.unit})`);
 const packet=await selected(freshMetadata,join(dir,'replacement'),['gate-plan','unit-'+c.unit],reuse);samePlan(packet.get('gate-plan')?.get('ci-plan.json'),freshPlan);
 const expectationMetadata=metadata(c.expectationRunId);validateRun(expectationMetadata.run,{runId:c.expectationRunId,candidate:c.expectationSource,controller:c.expectationSource,baseline});validateJobs(expectationMetadata.jobs,priorPlan);validateArtifacts(expectationMetadata.artifacts,{runId:c.expectationRunId,controller:c.expectationSource,controllerBranch:'alpha'},priorPlan);
 const priorArtifacts=expectationMetadata.artifacts.filter(a=>['gate-plan','unit-'+c.unit].includes(a.name));validateUnitArchiveMetadata({...expectationMetadata,artifacts:priorArtifacts},new Set(['gate-plan','unit-'+c.unit]),n=>n==='gate-plan'?'plan':`test (${c.unit})`);
 const prior=await selected(expectationMetadata,join(dir,'expectation'),['gate-plan','unit-'+c.unit],reuse);samePlan(prior.get('gate-plan')?.get('ci-plan.json'),priorPlan);
 const unitPacket=packet.get('unit-'+c.unit);assert(unitPacket.has('noto-font-setup.json'),'Actual font proof absent');
 const recovery=verifyUnitRecovery({plan,freshPlan,source,reports:plan.units.filter(u=>u.id!==c.unit).map(u=>source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`)),fresh:{...freshMetadata,producer,report:unitPacket.get(`unit-${c.unit}.json`),font:unitPacket.get('noto-font-setup.json')},expectation:{...expectationMetadata,plan:priorPlan,report:prior.get('unit-'+c.unit).get(`unit-${c.unit}.json`)},verificationController:controller,verificationDiagnostic,producerDiagnostic:verificationDiagnostic,reviewedController:controller});
 const since=new Date(Date.parse(source.run.created_at)-86400000).toISOString(),rows=pages('actions/runs?created='+encodeURIComponent('>='+since),'workflow_runs').filter(r=>r.workflow_id===WORKFLOW_ID||r.path==='.github/workflows/alpha-focused-checks.yml');for(const status of ['queued','in_progress','waiting','requested','pending'])rows.push(...pages('actions/runs?status='+status,'workflow_runs'));
 recovery.history=validateUnitHistory({source,rows,candidateBranch,unitRunId,controllerDiagnostics:[diagnosticId]});recovery.originalArtifacts=source.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}));recovery.expectationArtifacts=priorArtifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}));recovery.originalJobConclusions=source.jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion}));
 const build=await sourceBoundBuild({candidatePath,dir,p:{candidate:c.source,controller:c.controller,baseline,runId,controllerBranch:source.run.head_branch},jobs:source.jobs});
 for(const [id,m]of [[runId,originalMetadata],[unitRunId,freshMetadata],[c.expectationRunId,expectationMetadata],[diagnosticId,diagnostic]])assert(isDeepStrictEqual(metadata(id),m),'Recovery API bytes changed');refs();assert(cleanHead(candidatePath)===c.source&&cleanHead(controllerRoot)===controller&&cleanHead(expectationPath)===c.expectationSource);
 const result={...recovery,recovery,tier:'ci',result:'PASS',fingerprint:hash(recovery),build,candidatePath,controllerBranch:source.run.head_branch,unitControllerBranch:controllerBranch,candidateBranch,unitRunId,expectationPath,evidenceDirectory:dir,verifiedAt:new Date().toISOString(),url:source.run.html_url,artifacts:recovery.originalArtifacts,installationAuthorized:false};save(dir,reuse?`revalidation-${randomUUID()}.json`:'verification.json',result);return result;
}
function samePlan(actual,expected){assert(isDeepStrictEqual(actual,expected),'Archived complete plan differs from immutable source');}
export async function revalidateUnitRecoveredCi(e){assert(cleanHead(controllerRoot)===e.verificationController);const current=await verifyUnitRecoveredCi({candidatePath:e.candidatePath,runId:e.runId,baseline:e.baseline,unitRunId:e.unitRunId,candidateBranch:e.candidateBranch,controllerBranch:e.unitControllerBranch,expectationPath:e.expectationPath,evidenceDirectory:e.evidenceDirectory,reuse:true});assert(isDeepStrictEqual(current.recovery,e.recovery)&&isDeepStrictEqual(current.build,e.build)&&isDeepStrictEqual(current.artifacts,e.artifacts),'Recovery evidence changed before installation');return true;}
