/** Exact-candidate scheduling assessment only. Does not authenticate archives or authorize release. */
import {CI_POLICY} from './policy-version.mjs';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export function assessResumeCoverage({expectedPlan:plan,reports,expected}) {
  if(!plan||!expected||!['candidate','controller','baseline'].every(k=>sha(expected[k])))throw Error('Exact candidate/controller/baseline required');
  const {fingerprint,...body}=plan;
  if(plan.schemaVersion!==2||plan.policyVersion!==CI_POLICY||fingerprint!==hash(body))throw Error('Invalid complete expected plan');
  if(plan.sha!==expected.candidate||plan.controller!==expected.controller||plan.migrationBase!==expected.baseline)throw Error('Changed candidate/controller/baseline; no cross-commit reuse');
  if(plan.runtime?.platform!=='linux'||plan.runtime?.arch!=='x64'||!/^22\./.test(plan.runtime?.node??''))throw Error('Unexpected verification environment');
  const topology=requiredEvidence(plan);
  if(!Array.isArray(reports))throw Error('Missing report inventory');
  const supplied=new Map();
  for(const report of reports) {
    if(!report||!topology.units.includes(report.id)||supplied.has(report.id))throw Error('Foreign or duplicate report');
    if(report.sha!==plan.sha||report.fingerprint!==fingerprint)throw Error('Report belongs to another candidate/environment/coverage');
    supplied.set(report.id,report);
  }
  const reusable=[],rerun=[];
  for(const unit of plan.units) {
    const report=supplied.get(unit.id);
    if(!report){rerun.push({id:unit.id,reason:'Missing completed evidence'});continue;}
    try {const verified=verifyUnitReport(plan,report);reusable.push({id:unit.id,reportHash:hash(report),files:verified.files,tests:verified.tests});}
    catch(error){rerun.push({id:unit.id,reason:String(error.message??error)});}
  }
  if(reusable.length+rerun.length!==topology.units.length)throw Error('Incomplete assessment');
  return {kind:'EXACT_CANDIDATE_RESUME_ASSESSMENT_NOT_RELEASE_EVIDENCE',releaseAuthorized:false,
    requiresAuthenticatedArchives:true,requiresVersionedResumeWorkflowAndIndependentReleaseValidation:true,
    sha:plan.sha,controller:plan.controller,baseline:plan.migrationBase,fingerprint,
    completeRequiredUnits:topology.units,reusable,rerun,
    freshPrerequisites:topology.jobs.filter(name=>!name.startsWith('test (')&&!name.startsWith('browser (')&&!['verify','deployment-hold'].includes(name)),
    finalVerificationRequired:true,retainedFailuresMustRemainVisible:true};
}
