/** Resolve only an existing same-repository branch; no user text is evaluated as shell. */
import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const repository='StradaverseHub/ai-hr';
export function candidateRequest(event,inputs={}) {
  if(event.repository?.full_name?.toLowerCase()!==repository.toLowerCase())throw Error('Unexpected repository');
  if(event.pull_request){
    if(event.pull_request.draft || event.pull_request.base.ref!=='alpha' || event.pull_request.head.repo?.full_name?.toLowerCase()!==repository.toLowerCase())throw Error('Only ready same-repository PRs targeting alpha');
    return {branch:event.pull_request.head.ref,expected:event.pull_request.head.sha,base:event.pull_request.base.sha};
  }
  const branch=event.ref?.startsWith('refs/heads/')?event.ref.slice(11):inputs.candidate_ref||'alpha';
  // workflow_dispatch's event.ref names the controller branch, not the candidate.
  const target=event.inputs ? inputs.candidate_ref||'alpha':branch;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(target)||target.includes('..')||target.includes('//')||target.endsWith('/')||target.endsWith('.'))throw Error('Invalid candidate branch');
  if(!event.inputs && event.ref && target!=='alpha')throw Error('Only alpha pushes trigger CI');
  if(inputs.expected_sha && !/^[0-9a-f]{40}$/.test(inputs.expected_sha))throw Error('Invalid expected SHA');
  return {branch:target,expected:inputs.expected_sha||null,base:inputs.migration_base||null};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const inputs={...event.inputs,migration_base:process.env.STAGING_BASE_SHA};
  const requested=candidateRequest(event,inputs);
  const path=requested.branch.split('/').map(encodeURIComponent).join('/');
  const ref=JSON.parse(execFileSync('gh',['api',`repos/${repository}/git/ref/heads/${path}`],{encoding:'utf8'}));
  const sha=ref.object?.sha;
  if(!/^[0-9a-f]{40}$/.test(sha)||requested.expected&&sha!==requested.expected)throw Error('Branch moved or invalid candidate');
  if(!/^[0-9a-f]{40}$/.test(requested.base||''))throw Error('A verified staging migration baseline is required');
  appendFileSync(process.env.GITHUB_OUTPUT,`sha=${sha}\nbranch=${requested.branch}\nbase=${requested.base}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Exact CI candidate\n- Repository: ${repository}\n- Branch: ${requested.branch}\n- SHA: ${sha}\n- Migration baseline: ${requested.base}\n- Controller: ${process.env.GITHUB_SHA}\n- Deployment: HELD pending Board 3 handoff; no server credentials in this workflow.\n`);
}
