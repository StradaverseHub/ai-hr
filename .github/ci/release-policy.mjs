/** Versioned CI authority; it never creates or relabels a local gate receipt. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {verifyReports} from './verify-shards.mjs';
import {CI_POLICY} from './policy-version.mjs';
export {CI_POLICY};
export const REPOSITORY='StradaverseHub/ai-hr';
export const REPOSITORY_ID=1333414856;
export const WORKFLOW_ID=395777276;
export const WORKFLOW_PATH='.github/workflows/alpha-staging.yml';
import {requiredEvidence} from './manifest.mjs';
import {COMPILER_STATE_ARTIFACT} from './compiler-cache-protocol.mjs';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX} from './build-artifact.mjs';
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
const reject=message=>{throw Error('CI release refused: '+message);};
export const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export function validateRun(run,p){
 if(!sha(p.controller)||!sha(p.candidate)||!sha(p.baseline))reject('invalid expected identity');
 if(run.id!==p.runId||run.repository?.id!==REPOSITORY_ID||run.repository?.full_name!==REPOSITORY||run.head_repository?.id!==REPOSITORY_ID)reject('foreign run/repository');
 const allowedEvent=run.event==='workflow_dispatch'||(run.event==='push'&&run.head_branch==='alpha'&&run.head_sha===p.candidate&&p.controller===p.candidate);
 if(run.workflow_id!==WORKFLOW_ID||run.path!==WORKFLOW_PATH||!allowedEvent||!['main','alpha'].includes(run.head_branch)||run.head_sha!==p.controller)reject('untrusted workflow/controller');
 if(run.status!=='completed'||run.conclusion!=='success'||run.run_attempt!==1)reject('run is not a complete fresh successful attempt');
 const age=(p.now??Date.now())-Date.parse(run.created_at);
 if(!Number.isFinite(age)||age< -60000||age>24*60*60*1000)reject('expired or invalid run time');
 return true;
}
export function validateJobs(jobs,expectedPlan){
 const REQUIRED_JOBS=requiredEvidence(expectedPlan).jobs;
 if(!Array.isArray(jobs))reject('missing job inventory');
 const found=new Map();
 for(const job of jobs){
  if(found.has(job.name))reject('duplicated job identity');
  found.set(job.name,job);
  if(!REQUIRED_JOBS.includes(job.name)&&!(job.name==='runner-diagnostics'&&job.status==='completed'&&job.conclusion==='skipped'))reject('unexpected job');
 }
 for(const name of REQUIRED_JOBS){const j=found.get(name);if(!j||j.status!=='completed'||j.conclusion!=='success'||j.run_attempt!==1)reject('missing, skipped, failed or rerun job '+name);}
 return true;
}
export function validateArtifacts(artifacts,p,expectedPlan){
 const REQUIRED_ARTIFACTS=requiredEvidence(expectedPlan).artifacts;
 if(!Array.isArray(artifacts)||artifacts.length<REQUIRED_ARTIFACTS.length||artifacts.length>REQUIRED_ARTIFACTS.length+1)reject('artifact set is incomplete or unexpected');
 const names=new Set();
 for(const a of artifacts){
  const w=a.workflow_run;
  if((!REQUIRED_ARTIFACTS.includes(a.name)&&a.name!==COMPILER_STATE_ARTIFACT)||names.has(a.name)||!Number.isSafeInteger(a.id)||a.id<1||a.expired||!Number.isSafeInteger(a.size_in_bytes)||a.size_in_bytes<1||a.size_in_bytes>(a.name===BUILD_ARTIFACT?BUILD_ZIP_MAX:64*1024*1024)||!/^sha256:[0-9a-f]{64}$/.test(a.digest??''))reject('invalid, duplicated or expired artifact');
  if(w?.id!==p.runId||w.repository_id!==REPOSITORY_ID||w.head_repository_id!==REPOSITORY_ID||w.head_sha!==p.controller||w.head_branch!==(p.controllerBranch??'main'))reject('artifact provenance mismatch');
  names.add(a.name);
 }
 if(REQUIRED_ARTIFACTS.some(name=>!names.has(name)))reject('required artifact missing');
 return true;
}
export function verifyArtifactBytes(artifact,bytes){if(digest(bytes)!==artifact.digest)reject('artifact archive digest mismatch: '+artifact.name);return true;}
export function validateProof({plan,reports,receipt,expectedPlan,p}){
 if(plan.policyVersion!==CI_POLICY||plan.sha!==p.candidate||plan.controller!==p.controller||plan.migrationBase!==p.baseline)reject('plan policy/candidate/controller/baseline mismatch');
 if(plan.runtime?.platform!=='linux'||plan.runtime?.arch!=='x64'||!/^22\./.test(plan.runtime?.node??''))reject('unexpected verification environment');
 if(!isDeepStrictEqual(plan,expectedPlan))reject('candidate classifier/manifest changed');
 requiredEvidence(expectedPlan);
 const verified=verifyReports(plan,reports);
 if(!isDeepStrictEqual(verified,receipt)||receipt.policyVersion!==CI_POLICY||receipt.migrationBase!==p.baseline)reject('receipt differs from complete executed evidence');
 return {policyVersion:CI_POLICY,tier:'ci',result:'PASS',sha:p.candidate,controller:p.controller,baseline:p.baseline,runId:p.runId,suiteFiles:receipt.suiteFiles,browserFiles:receipt.browserFiles,tests:receipt.tests,fingerprint:receipt.fingerprint};
}
