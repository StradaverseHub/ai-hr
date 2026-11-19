/** New release authority: complete scoped facts + original canonical build, independent of staging SHA. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createDeliveryPlan} from './plan.ts';
import {controllerDigestAt} from './source.mjs';
import {POLICY,REPOSITORY,REPOSITORY_ID,exact,hash,sha,verifyCoverage} from './protocol.mjs';
import {api,authenticateEvidence} from './github.mjs';
import {authenticateFocused,unchangedInputs} from './legacy-evidence.mjs';
import {authenticateFullUnit,admittedFullRun,readArtifactJson} from './full-evidence.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from '../../.github/ci/release-ci.mjs';
import {downloadCiArchives,readCiArchive} from '../../.github/ci/archive-downloads.mjs';
import {BUILD_ARTIFACT} from '../../.github/ci/build-artifact.mjs';
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
function adoption(plan,path){
 assert(path&&resolve(path)===path&&!path.startsWith(resolve(process.cwd())+'/'),'Operator adoption file must be outside candidate source');
 const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o777)===0o600,'Private operator adoption record required');
 const a=JSON.parse(readFileSync(path));exact(a,['policy','policyDigest','qualificationRun','wholeWitnessRun','owner','recordedAt','profiles']);
 assert(a.policy===POLICY&&a.policyDigest===plan.policyDigest&&typeof a.owner==='string'&&a.owner.length>0&&Number.isFinite(Date.parse(a.recordedAt)));
 assert(Array.isArray(a.profiles)&&a.profiles.includes(plan.profile),'Change class not yet adopted; qualify it instead of overriding risk');
 const qualified=api(`actions/runs/${a.qualificationRun}`),broad=api(`actions/runs/${a.wholeWitnessRun}`);
 for(const r of [qualified,broad])assert(r.repository?.id===REPOSITORY_ID&&r.head_repository?.id===REPOSITORY_ID&&r.status==='completed'&&r.conclusion==='success'&&r.run_attempt===1);
 assert(qualified.path==='.github/workflows/delivery-qualification.yml'&&controllerDigestAt(controllerRoot,qualified.head_sha)===plan.policyDigest,'Qualification used different delivery code');
 assert(broad.path==='.github/workflows/alpha-staging.yml','Original complete policy witness required for adoption');return a;
}
async function stageObservation(ref,plan,{candidatePath,directory,policyDigestAt}){
 const run=admittedFullRun(api(`actions/runs/${ref.runId}`));assert(await policyDigestAt(run.head_sha)===plan.policyDigest);
 const job=api(`actions/jobs/${ref.jobId}`),artifact=api(`actions/artifacts/${ref.planArtifactId}`);assert(artifact.name==='gate-plan'&&artifact.workflow_run?.id===run.id&&artifact.workflow_run?.head_sha===run.head_sha);
 assert(job.run_id===run.id&&job.head_sha===run.head_sha&&job.run_attempt===1&&job.status==='completed'&&job.conclusion==='success');
 const names={compiler:'typecheck',migration:'migrations',controller:'controller-tests'};assert(job.name===names[ref.kind]);
 const original=await readArtifactJson(artifact,'ci-plan.json',join(directory,'stage-'+job.id));assert(original.controller===run.head_sha);
 const check=plan.checks.find(c=>c.kind===ref.kind);assert(check&&unchangedInputs(plan,check,original.sha,candidatePath));
 return {report:{policy:POLICY,candidate:original.sha,controller:run.head_sha,policyDigest:plan.policyDigest,check:check.id,key:check.key,inputDigest:check.inputs,result:'passed',files:check.files,assertions:1,skipped:0},verifiedAt:Date.now(),producer:{runId:run.id,jobId:job.id,artifactId:artifact.id,archiveDigest:artifact.digest,originalRunConclusion:run.conclusion}};
}
export async function verifyDeliveryCi({candidatePath,reference,baseline,adoptionFile=process.env.AIHR_DELIVERY_ADOPTION_FILE}){
 candidatePath=resolve(candidatePath);const candidate=cleanHead(candidatePath),verificationController=cleanHead(controllerRoot);
 exact(reference,['base','observations','stages','build']);assert(sha(reference.base)&&sha(baseline));
 assert(execFileSync('git',['remote','get-url','origin'],{cwd:candidatePath,encoding:'utf8'}).trim()==='https://github.com/StradaverseHub/ai-hr.git');
 const plan=createDeliveryPlan({candidatePath,controllerPath:controllerRoot,base:reference.base});adoption(plan,adoptionFile);
 const dir=join(controllerRoot,'scratchpad','validated-delivery-'+randomUUID());mkdirSync(dir,{recursive:true,mode:0o700});save(dir,'delivery-plan.json',plan);save(dir,'delivery-reference.json',reference);
 const context={candidatePath,directory:dir,policyDigestAt:sha=>controllerDigestAt(controllerRoot,sha)},observations=[];
 assert(Array.isArray(reference.observations)&&reference.observations.length<=512&&Array.isArray(reference.stages)&&reference.stages.length<=3);
 for(const r of reference.observations){
  assert(['focused','full-unit','delivery'].includes(r.kind));
  observations.push(...(r.kind==='focused'?await authenticateFocused(r,plan,context):r.kind==='full-unit'?await authenticateFullUnit(r,plan,context):authenticateEvidence(r,plan)));
 }
 for(const r of reference.stages)observations.push(await stageObservation(r,plan,context));
 const br=api(`actions/runs/${reference.build.runId}`),artifact=api(`actions/artifacts/${reference.build.artifactId}`);
 // The canonical producer's workflow/run metadata is independently authenticated here, not inferred from a filename.
 assert(br.repository?.id===REPOSITORY_ID&&br.head_repository?.id===REPOSITORY_ID&&br.workflow_id===395777276&&br.path==='.github/workflows/alpha-staging.yml'&&br.head_branch==='main'&&br.event==='workflow_dispatch'&&br.status==='completed'&&br.conclusion==='success'&&br.run_attempt===1&&Date.now()-Date.parse(br.created_at)<86400000);
 assert(await context.policyDigestAt(br.head_sha)===plan.policyDigest&&artifact.name===BUILD_ARTIFACT&&artifact.workflow_run?.id===br.id&&artifact.workflow_run?.head_sha===br.head_sha&&artifact.workflow_run?.repository_id===REPOSITORY_ID&&!artifact.expired);
 const inventory=api(`actions/runs/${br.id}/jobs?per_page=100&filter=all`);assert(inventory.total_count===inventory.jobs.length,'Complete producing job inventory required');const jobs=inventory.jobs;
 const producer=jobs.find(j=>j.name==='build');assert(producer&&producer.run_id===br.id&&producer.head_sha===br.head_sha&&producer.run_attempt===1&&producer.status==='completed'&&producer.conclusion==='success');
 await downloadCiArchives([artifact],dir);const zip=join(dir,artifact.name+'.zip');readCiArchive(artifact,zip);
 execFileSync('python3',[new URL('../../.github/ci/build-transport-extract.py',import.meta.url).pathname,zip,join(dir,BUILD_ARTIFACT),artifact.digest.slice(7)],{stdio:'pipe',timeout:60000});
 const build=await sourceBoundBuild({candidatePath,dir,p:{controller:br.head_sha,candidate,runId:br.id,baseline},jobs});
 const check=plan.checks.find(c=>c.kind==='build');observations.push({report:{policy:POLICY,candidate,controller:br.head_sha,policyDigest:plan.policyDigest,check:check.id,key:check.key,inputDigest:check.inputs,result:'passed',files:check.files,assertions:1,skipped:0},verifiedAt:Date.now(),producer:{runId:br.id,jobId:producer.id,artifactId:artifact.id,archiveDigest:artifact.digest}});
 // Duplicates can be selected as cache hints, but every required claim gets exactly one current input owner.
 const chosen=plan.checks.map(c=>{const matches=observations.filter(o=>o.report.check===c.id&&o.report.key===c.key);assert(matches.length,'Missing evidence: '+c.id);return matches.sort((a,b)=>b.verifiedAt-a.verifiedAt)[0];});
 const coverage=verifyCoverage(plan,chosen);save(dir,'delivery-observations.json',chosen);save(dir,'delivery-coverage.json',coverage);
 const body={policy:POLICY,candidate,policyDigest:plan.policyDigest,planDigest:plan.fingerprint,coverageDigest:hash(coverage),checks:chosen.length,producersDigest:hash(chosen.map(o=>o.producer)),buildRunId:br.id,buildArtifactId:artifact.id,buildArtifactDigest:artifact.digest,verifiedAt:new Date().toISOString()};
 const delivery={...body,fingerprint:hash(body)};const evidence={policyVersion:POLICY,tier:'ci',result:'PASS',sha:candidate,controller:br.head_sha,verificationController,controllerBranch:'main',baseline,runId:br.id,fingerprint:delivery.fingerprint,build,delivery,candidatePath,evidenceDirectory:dir,artifacts:[{id:artifact.id,name:artifact.name,digest:artifact.digest}],reference,adoptionFile};
 save(dir,'run.json',br);save(dir,'jobs.json',jobs);save(dir,'artifacts.json',[artifact]);save(dir,'verification.json',evidence);
 assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===verificationController);return evidence;
}
export async function revalidateDeliveryCi(evidence){
 assert(cleanHead(evidence.candidatePath)===evidence.sha&&cleanHead(controllerRoot)===evidence.verificationController,'Frozen source changed');
 const observations=JSON.parse(readFileSync(join(evidence.evidenceDirectory,'delivery-observations.json')));
 assert(hash(observations.map(o=>o.producer))===evidence.delivery.producersDigest,'Private original evidence inventory changed');
 const runs=new Map();for(const o of observations){const p=o.producer;if(!runs.has(p.runId))runs.set(p.runId,[]);runs.get(p.runId).push(o);}
 for(const [id,items] of runs){
  const run=api(`actions/runs/${id}`);assert(run.status==='completed'&&run.run_attempt===1&&run.repository?.id===REPOSITORY_ID&&run.head_repository?.id===REPOSITORY_ID&&Date.now()-Date.parse(run.created_at)<86400000);
  const jobs=[],artifacts=[];for(let page=1;page<=10;page++){const js=api(`actions/runs/${id}/jobs?filter=all&per_page=100&page=${page}`);jobs.push(...js.jobs);if(js.jobs.length<100)break;assert(page<10);}
  for(let page=1;page<=10;page++){const as=api(`actions/runs/${id}/artifacts?per_page=100&page=${page}`);artifacts.push(...as.artifacts);if(as.artifacts.length<100)break;assert(page<10);}
  for(const o of items){
   const job=jobs.find(j=>j.id===o.producer.jobId),artifact=artifacts.find(a=>a.id===o.producer.artifactId);
   assert(job?.run_id===id&&job?.head_sha===o.report.controller&&job?.run_attempt===1&&job?.status==='completed'&&job?.conclusion==='success');
   assert(artifact&&!artifact.expired&&artifact.digest===o.producer.archiveDigest&&artifact.workflow_run?.id===id);
   if(o.producer.planArtifactId){const p=artifacts.find(a=>a.id===o.producer.planArtifactId);assert(p&&!p.expired&&p.digest===o.producer.planArchiveDigest);}
  }
 }
 // GitHub artifact IDs are immutable. Reauthenticate metadata and retain the already authenticated
 // private packet, rather than downloading/unpacking every successful shard during cutover.
 return true;
}
