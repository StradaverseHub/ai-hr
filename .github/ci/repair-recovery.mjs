/** Separately versioned repair operator. Original archives and source identities remain immutable. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {requiredEvidence} from './manifest.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {NEXT_APPLICATION_STATE,NEXT_APPLICATION_FAILURE,NEXT_APPLICATION_MEMBERS,inspectNextStatePacket} from './next-application-cache-protocol.mjs';
import {COMPILER_STATE_ARTIFACT} from './compiler-cache-protocol.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {reconstructRepairImpact} from './repair-impact.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {verifyRepairRecovery,repairDisposition,validateRepairFocusedMetadata,validateRepairBuildMetadata} from './repair-recovery-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
function pages(path,key){const rows=[];for(let page=1;page<=10;page++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);assert(Array.isArray(r[key]),'Missing complete API inventory');rows.push(...r[key]);if(r[key].length<100)return rows;}throw Error('Repair API inventory exceeds bound');}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2,timeout:60000}).trim();
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
function metadata(runId){return {run:api(`actions/runs/${runId}`),jobs:pages(`actions/runs/${runId}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${runId}/artifacts`,'artifacts')};}
export function validateRepairArchiveInventory(m,allowed,producerFor,now=Date.now()){
 assert(m.run.repository?.id===REPOSITORY_ID&&m.run.head_repository?.id===REPOSITORY_ID,'Foreign artifact owner');
 assert(m.artifacts.length>0&&new Set(m.artifacts.map(a=>a.name)).size===m.artifacts.length&&new Set(m.artifacts.map(a=>a.id)).size===m.artifacts.length,'Incomplete/duplicate artifact inventory');
 for(const a of m.artifacts){const w=a.workflow_run,j=m.jobs.find(j=>j.name===producerFor(a.name));
  assert(allowed.has(a.name)&&j&&j.conclusion!=='skipped'&&w?.id===m.run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===m.run.head_sha&&w.head_branch===m.run.head_branch,'Unknown or foreign repair artifact');
  assert(Date.parse(a.created_at)>=Date.parse(j.started_at)&&Date.parse(a.created_at)<=Date.parse(j.completed_at)&&Date.parse(a.expires_at)>now,'Artifact outside original producing job');
 }
}
function planAt(path,{controller,baseline,runtime}){
 // Native classification parses tracked source; it executes no application, tests or compiler.
 const previous=process.env.AIHR_CI_CLASSIFIER_RUNTIME;process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';
 try{const local=createPlan(path),{fingerprint,...body}={...local,controller,migrationBase:baseline,runtime};return {...body,fingerprint:hash(body)};}
 finally{if(previous===undefined)delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;else process.env.AIHR_CI_CLASSIFIER_RUNTIME=previous;}
}
export function validateRepairDelta({cwd,original,candidate,repairKind='product'}){
 assert(['product','test-fixtures'].includes(repairKind),'Unknown repair kind');
 execFileSync('git',['merge-base','--is-ancestor',original,candidate],{cwd,stdio:'ignore'});
 const records=git(cwd,'diff','--name-status','--no-renames',original,candidate).split('\n').filter(Boolean);
 assert(records.length>0&&records.length<=(repairKind==='test-fixtures'?8:64),'Bounded nonempty repair delta required');
 const changed=records.map(line=>{const [status,path,...extra]=line.split('\t');assert(status==='M'&&extra.length===0,'Only modified existing repair inputs supported');
  if(repairKind==='test-fixtures'){
   assert(/^test\/[A-Za-z0-9_-]+(?:\.dom)?\.test\.(?:ts|tsx)$/.test(path),'Only existing flat Node/DOM test files supported');
   for(const ref of [original,candidate])assert(/^100644 blob /.test(git(cwd,'ls-tree',ref,'--',path)),'Regular nonexecutable test source required');
   return path;
  }
  assert(/^(app|components|core|lib|packs)\/[A-Za-z0-9_./()\[\]-]+\.(ts|tsx)$/.test(path),'Only existing product TypeScript repairs supported');
  assert(!/^lib\/(identity\/|permissions\.|authz\.|session\.|scope\.|request-origin\.)/.test(path)&&!/^core\/(auth|admin|permissions|tenant)(\.|-|s\/)/.test(path),'Security-owner repair needs broader independent coverage');return path;}).sort();
 // Product mode retains its old boundary. Fixture mode changes no application, helper, SQL,
 // classifier, runtime, workflow or package bytes; complete original cases are checked later.
 return {repairKind,changed,baseTree:git(cwd,'rev-parse',original+'^{tree}'),headTree:git(cwd,'rev-parse',candidate+'^{tree}'),diffSha256:hash(git(cwd,'diff','--binary','--no-ext-diff',original,candidate))};
}
export function validateFixtureReview({cwd,original,candidate,delta,review=null}){
 if(delta.repairKind==='product'){assert(review===null,'Fixture review cannot change product-repair authority');return null;}
 if(review===null)return null; // Read-only diagnostics remain noninstallable until actual independent review.
 const keys=(value,names)=>assert(value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),names.slice().sort()),'Closed fixture review record required');
 keys(review,['format','kind','original','candidate','diffSha256','reviewedBy','evidence','files','attestations']);
 assert(review.format===1&&review.kind==='INDEPENDENT_FIXTURE_REVIEW'&&review.original===original&&review.candidate===candidate&&review.diffSha256===delta.diffSha256,'Fixture review source/diff differs');
 assert(Array.isArray(review.reviewedBy)&&review.reviewedBy.length===2&&new Set(review.reviewedBy).size===2&&review.reviewedBy.every(x=>typeof x==='string'&&x.length>=8&&x.length<=160),'Two identified independent fixture reviewers required');
 assert(typeof review.evidence==='string'&&review.evidence.length>=20&&review.evidence.length<=2000,'Original private review evidence required');
 const guarantees=['caseRegistrationsPreserved','assertionsNotWeakened','isolationAndPermissionsPreserved','noSkipsOrTimeoutRelaxation'];
 keys(review.attestations,guarantees);assert(guarantees.every(name=>review.attestations[name]===true),'Fixture review must preserve substantive checks and authority');
 assert(Array.isArray(review.files)&&isDeepStrictEqual(review.files.map(x=>x.path).sort(),delta.changed),'Complete reviewed fixture inventory required');
 for(const file of review.files){
  keys(file,['path','beforeBlob','afterBlob','reason']);
  assert(file.beforeBlob===git(cwd,'rev-parse',original+':'+file.path)&&file.afterBlob===git(cwd,'rev-parse',candidate+':'+file.path),'Reviewed fixture blob differs');
  assert(typeof file.reason==='string'&&file.reason.trim().length>=25&&file.reason.length<=2000,'Concrete fixture correction reason required');
 }
 return structuredClone(review);
}
export function validateLatestRepairHistory({source,rows,candidateBranch,focusedRunIds,buildRunId}){
 const after=source.run.updated_at,known=new Set([...focusedRunIds,buildRunId]);
 assert(Number.isFinite(Date.parse(after))&&Array.isArray(rows)&&rows.length<=8000,'Invalid or unbounded repair history');
 assert(source.run.display_title?.startsWith('Alpha CI · '),'Original workflow title must identify its frozen branch');
 const titles=new Set([source.run.display_title,`Alpha CI · ${candidateBranch}`,`Canonical build only · ${candidateBranch}`,`Focused only · ${candidateBranch}`]);
 // An overlapping run may start before the original completes and fail afterwards. Creation-time
 // filtering alone would silently discard that later failure. Bind completion/update history too.
 const matching=new Map();
 for(const r of rows){if(r.id===source.run.id||!titles.has(r.display_title))continue;
  assert(Number.isSafeInteger(r.id)&&r.id>0&&Number.isFinite(Date.parse(r.created_at))&&Number.isFinite(Date.parse(r.updated_at))&&Date.parse(r.updated_at)>=Date.parse(r.created_at)&&['queued','in_progress','waiting','requested','pending','completed'].includes(r.status),'Malformed relevant history execution');
  const record={id:r.id,display_title:r.display_title,controller:r.head_sha,status:r.status,conclusion:r.conclusion,attempt:r.run_attempt,createdAt:r.created_at,updatedAt:r.updated_at};
  assert(!matching.has(r.id)||isDeepStrictEqual(matching.get(r.id),record),'Conflicting history API snapshots; retry after stabilization');matching.set(r.id,record);
 }
 const relevant=[...matching.values()].filter(r=>r.status!=='completed'||Date.parse(r.updatedAt)>=Date.parse(after));
 assert(relevant.length===known.size&&relevant.every(r=>known.has(r.id)&&r.status==='completed'&&r.conclusion==='success'&&r.attempt===1),'Unaccounted, pending, failed or superseding repair execution');
 return {kind:'AUTHENTICATED_COMPLETE_REPAIR_HISTORY',sourceRunId:source.run.id,after,runIds:relevant.map(r=>r.id).sort((a,b)=>a-b),metadataFingerprint:hash(relevant.sort((a,b)=>a.id-b.id))};
}
function latestHistory({source,focusedWorkflowId,candidateBranch,focusedRunIds,buildRunId}){
 const since=new Date(Date.parse(source.run.created_at)-86400000).toISOString(),query='created='+encodeURIComponent('>='+since);
 const rows=[...pages(`actions/workflows/${WORKFLOW_ID}/runs?${query}`,'workflow_runs'),...pages(`actions/workflows/${focusedWorkflowId}/runs?${query}`,'workflow_runs')];
 // Active executions must not disappear merely because they were queued before the lookback.
 for(const status of ['queued','in_progress','waiting','requested','pending'])rows.push(...pages(`actions/runs?status=${status}`,'workflow_runs').filter(r=>[WORKFLOW_ID,focusedWorkflowId].includes(r.workflow_id)));
 return validateLatestRepairHistory({source,rows,candidateBranch,focusedRunIds,buildRunId});
}
export async function verifyRepairedCi({candidatePath,originalPath,runId,baseline,focusedRunIds,buildRunId,candidateBranch,evidenceDirectory,reuse=false,repairKind='product',fixtureReview=null}){
 candidatePath=resolve(candidatePath);originalPath=resolve(originalPath);runId=Number(runId);buildRunId=Number(buildRunId);
 assert(/^[a-f0-9]{40}$/.test(baseline??'')&&Number.isSafeInteger(runId)&&runId>0&&Number.isSafeInteger(buildRunId)&&buildRunId>0&&buildRunId!==runId,'Exact original/build/baseline identities required');
 assert(Array.isArray(focusedRunIds)&&focusedRunIds.length>0&&focusedRunIds.length<=64&&focusedRunIds.every(n=>Number.isSafeInteger(n)&&n>0&&! [runId,buildRunId].includes(n))&&new Set(focusedRunIds).size===focusedRunIds.length,'Distinct bounded replacement executions required');
 assert(typeof candidateBranch==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidateBranch)&&!candidateBranch.includes('..'),'Exact repaired source branch required');
 const candidate=cleanHead(candidatePath),original=cleanHead(originalPath),verificationController=cleanHead(controllerRoot);
 const reviewedController=process.env.AIHR_REPAIR_REVIEWED_CONTROLLER??null;assert(reviewedController===null||reviewedController===verificationController,'Reviewed verifier identity changed');
 for(const path of [candidatePath,originalPath])assert(git(path,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Unexpected source repository');
 assert(api('git/ref/heads/'+candidateBranch.split('/').map(encodeURIComponent).join('/')).object?.sha===candidate,'Repaired candidate branch moved');
 execFileSync('git',['merge-base','--is-ancestor',baseline,original],{cwd:candidatePath,stdio:'ignore'});
 const delta=validateRepairDelta({cwd:candidatePath,original,candidate,repairKind});
 fixtureReview=validateFixtureReview({cwd:candidatePath,original,candidate,delta,review:fixtureReview});
 const diagnosticId=Number(process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID);assert(Number.isSafeInteger(diagnosticId)&&diagnosticId>0,'Reviewed verifier controller diagnostic required');
 assert(readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8').includes(' .github/ci/repair-recovery.test.mjs'),'Hosted integrity suite must execute current refusal controls');
 const dm=metadata(diagnosticId),verificationDiagnostic=validateRecoveryControllerDiagnostic({...dm,controller:verificationController});
 const originalMetadata=metadata(runId),controller=originalMetadata.run.head_sha;
 assert(originalMetadata.run.status==='completed'&&originalMetadata.run.conclusion==='failure'&&originalMetadata.run.run_attempt===1,'Wait for all planned original jobs to finish');
 const preliminary=planAt(originalPath,{controller,baseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'}}),topology=requiredEvidence(preliminary);
 const allowed=new Set([...topology.artifacts,COMPILER_STATE_ARTIFACT,NEXT_APPLICATION_STATE,NEXT_APPLICATION_FAILURE]);
 const producerFor=name=>name==='gate-plan'?'plan':name==='gate-evidence'?'verify':name===COMPILER_STATE_ARTIFACT?'typecheck':name.startsWith('unit-')?((u)=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`)(preliminary.units.find(u=>'unit-'+u.id===name)):'build';
 validateRepairArchiveInventory(originalMetadata,allowed,producerFor);
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`validated-repair-${runId}-${randomUUID()}`),sourceDir=join(dir,'original');
 const source=await collectRecoveryEvidence(runId,sourceDir,{reuse,prefetchDirectory:process.env.AIHR_REPAIR_ORIGINAL_PREFETCH_DIR||undefined});
 assert(isDeepStrictEqual(originalMetadata,facts(source)),'Original metadata changed during download');
 const archived=source.parsed.get('gate-plan')?.get('ci-plan.json');assert(archived,'Original full plan missing');
 const sourcePlan=planAt(originalPath,{controller,baseline,runtime:archived.runtime}),expected={candidate:original,controller,baseline,runId};
 const assessment=assessResumeSource({...source,expectedPlan:sourcePlan,expected});
 for(const name of ['migrations','controller-tests','deployment-hold'])assert(source.jobs.find(j=>j.name===name)?.conclusion==='success','Unsupported failed prerequisite: '+name);
 assert(source.jobs.find(j=>j.name==='verify')?.conclusion==='failure','Original dependent verifier must remain failed');
 const plan=planAt(candidatePath,{controller,baseline,runtime:archived.runtime}),impactContext=reconstructRepairImpact({cwd:candidatePath,base:original,head:candidate,controller:verificationController});
 assert(isDeepStrictEqual(delta.changed,impactContext.plan.changed),'Reconstructed impact omitted repair paths');
 const disposition=repairDisposition({sourcePlan,plan,assessment,impactContext,verificationController});
 assert(plan.units.filter(u=>disposition.fresh.includes(u.id)).every(u=>u.kind==='nodb'||u.kind==='db'),'Affected browser coverage needs a validated replacement route; cannot retain it');
 assert(plan.units.filter(u=>disposition.fresh.includes(u.id)).every(u=>!u.pdfTools),'Affected PDF tooling unit needs its full source-bound environment proof');
 const workflow=api('actions/workflows/alpha-focused-checks.yml');assert(workflow.path==='.github/workflows/alpha-focused-checks.yml'&&workflow.state==='active','Focused workflow registry differs');
 const focused=[];
 for(const id of focusedRunIds.slice().sort((a,b)=>a-b)){
  const m=metadata(id),authenticated=validateRepairFocusedMetadata({...m,expected:{runId:id,controller,workflowId:workflow.id,after:source.run.updated_at}});
  const f=await collectRecoveryEvidence(id,join(dir,'focused-'+id),{reuse,repairPackets:true}),artifact=f.artifacts[0],packet=f.parsed.get(artifact.name);
  assert(isDeepStrictEqual(m,facts(f)),'Focused metadata changed during download');
  const report=packet.get('focused.json'),database=report?.groups?.DB?.length>0,resultName=database?'db.vitest.json':'nodb.vitest.json';
  assert(isDeepStrictEqual([...packet.keys()].sort(),[resultName,'focused.json'].sort()),'Exact homogeneous focused packet required');
  focused.push({...f,...authenticated,artifact,report,result:packet.get(resultName)});
 }
 const bm=metadata(buildRunId);validateRepairBuildMetadata({...bm,expected:{runId:buildRunId,controller,after:source.run.updated_at,candidateBranch}});
 validateRepairArchiveInventory(bm,new Set([BUILD_ARTIFACT,NEXT_APPLICATION_STATE]),()=> 'build');assert(bm.artifacts.some(a=>a.name===BUILD_ARTIFACT),'Mandatory fresh canonical build packet missing');
 // Main evidence directory names the replacement build's real producer, as the installer expects.
 const built=await collectRecoveryEvidence(buildRunId,dir,{reuse,includeRaw:true,prefetchDirectory:process.env.AIHR_REPAIR_BUILD_PREFETCH_DIR||undefined});assert(isDeepStrictEqual(bm,facts(built)),'Build metadata changed during download');
 if(built.parsed.has(NEXT_APPLICATION_STATE)){const files=built.rawParsed.get(NEXT_APPLICATION_STATE);assert(isDeepStrictEqual([...files.keys()].sort(),NEXT_APPLICATION_MEMBERS),'Application cache packet differs');
  const state=inspectNextStatePacket({files,run:built.run,job:built.jobs.find(j=>j.name==='build')});assert(state.producer.source===candidate&&state.producer.controller===controller,'Supplemental state source/controller differs');
 }
 const p={candidate,controller,baseline,runId:buildRunId,controllerBranch:built.run.head_branch},build=await sourceBoundBuild({candidatePath,dir,p,jobs:built.jobs});
 const history=latestHistory({source,focusedWorkflowId:workflow.id,candidateBranch,focusedRunIds,buildRunId});
 const reports=sourcePlan.units.map(u=>source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`));
 const recovery=verifyRepairRecovery({sourcePlan,plan,assessment,sourceRun:source.run,reports,focused,impactContext,classifierHash:hash(readFileSync(join(candidatePath,'scripts/gate-db-classify.ts'),'utf8')),verificationController,verificationDiagnostic,reviewedController,buildRun:built.run,build,history});
 recovery.delta={...delta,fixtureReview};recovery.pendingFixtureReview=repairKind==='test-fixtures'&&fixtureReview===null;recovery.pendingReview ||= recovery.pendingFixtureReview;
 recovery.originalArtifacts=source.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}));recovery.originalJobConclusions=source.jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion}));
 assert(cleanHead(candidatePath)===candidate&&cleanHead(originalPath)===original&&cleanHead(controllerRoot)===verificationController,'Source/controller changed while verifying');
 assert([baseline,candidate].includes(api('git/ref/heads/alpha').object?.sha),'Alpha moved away from exact staging baseline/candidate');
 const result={...recovery,recovery,result:recovery.pendingReview?'DIAGNOSTIC_NONINSTALLABLE':'PASS',tier:recovery.pendingReview?'diagnostic':'ci',installationEligible:!recovery.pendingReview,fingerprint:hash(recovery),build,candidatePath,originalPath,originalRunId:runId,candidateBranch,repairKind,fixtureReview,focusedRunIds:focusedRunIds.slice().sort((a,b)=>a-b),buildRunId,controllerBranch:built.run.head_branch,evidenceDirectory:dir,verifiedAt:new Date().toISOString(),url:built.run.html_url,artifacts:built.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))};
 save(dir,reuse?`revalidation-${randomUUID()}.json`:'verification.json',result);return result;
}
function facts(f){return {run:f.run,jobs:f.jobs,artifacts:f.artifacts};}
export function assertRepairRevalidation(evidence,current){
 assert(isDeepStrictEqual(current.recovery,evidence.recovery)&&isDeepStrictEqual(current.build,evidence.build)&&isDeepStrictEqual(current.artifacts,evidence.artifacts),'Repair evidence changed before launch');return true;
}
export async function revalidateRepairedCi(evidence){
 assert(cleanHead(controllerRoot)===evidence.verificationController,'Verification controller changed');
 const current=await verifyRepairedCi({...evidence,runId:evidence.originalRunId,evidenceDirectory:evidence.evidenceDirectory,reuse:true});
 return assertRepairRevalidation(evidence,current);
}
