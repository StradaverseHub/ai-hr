/** Hosted immutable-Git selection diagnostic. It cannot issue release evidence. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {reconstructRepairImpact} from './repair-impact.mjs';

export function impactDiagnosticRequest(env) {
  assert(env.GITHUB_ACTIONS==='true'&&env.GITHUB_EVENT_NAME==='workflow_dispatch',
    'Impact selection diagnostic requires a hosted explicit dispatch');
  assert(env.AIHR_DIAGNOSTICS_ONLY==='true'&&env.AIHR_CONTROLLER_ONLY==='false'&&env.AIHR_BUILD_ONLY==='false',
    'Impact selection requires the existing runner diagnostic mode only');
  const base=env.AIHR_REPAIR_IMPACT_BASE,head=env.AIHR_CI_HEAD,controller=env.AIHR_CI_CONTROL_HEAD;
  assert([base,head,controller].every(x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x))&&base!==head,
    'Exact distinct source identities and controller required');
  assert(typeof env.GITHUB_RUN_ID==='string'&&/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID)&&env.GITHUB_RUN_ATTEMPT==='1',
    'First-attempt hosted diagnostic identity required');
  assert(typeof env.RUNNER_TEMP==='string'&&isAbsolute(env.RUNNER_TEMP),'Owned runner scratch required');
  return {base,head,controller,runId:env.GITHUB_RUN_ID,output:join(env.RUNNER_TEMP,'repair-impact-diagnostic.json')};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const request=impactDiagnosticRequest(process.env),cwd=process.cwd();
  assert(execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim()===request.head,
    'Resolved candidate checkout differs');
  assert(execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8'}).trim()==='',
    'Candidate checkout must be clean');
  const context=reconstructRepairImpact({cwd,base:request.base,head:request.head,controller:request.controller});
  writeFileSync(request.output,JSON.stringify({kind:'IMMUTABLE_GIT_REPAIR_IMPACT_DIAGNOSTIC_NOT_RELEASE',
    runId:request.runId,releaseAuthorized:false,context},null,2)+'\n',{flag:'wx'});
}
