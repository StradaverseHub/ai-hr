/** Resolve only an existing same-repository branch; no user text is evaluated as shell. */
import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const repository='StradaverseHub/ai-hr';
const commitSha=value=>typeof value==='string'&&value.length===40&&/^[0-9a-f]{40}$/.test(value);
/** An expected baseline prequalifies migration compatibility; it never declares an installed release. */
export function selectMigrationBaseline({eventName,workflow,workflowRef,installed,override}) {
  if(override===undefined||override==='') {
    if(!commitSha(installed))throw Error('A verified staging migration baseline is required');
    return {base:installed,explicit:false};
  }
  if(!commitSha(override))throw Error('Expected migration baseline must be a full 40-character SHA');
  if(eventName!=='workflow_dispatch'||workflow!=='alpha-staging-ci'||typeof workflowRef!=='string'||!workflowRef.startsWith(repository+'/.github/workflows/alpha-staging.yml@refs/heads/'))throw Error('Expected migration baseline is only allowed for manual alpha-staging-ci');
  return {base:override,explicit:true};
}
/** Authenticate the requested immutable ancestor, not merely a comparison's ahead/behind label. */
export function validateMigrationBaseComparison(comparison,{base,candidate}) {
  if(!commitSha(base)||!commitSha(candidate)||!comparison||typeof comparison!=='object'||!['ahead','identical'].includes(comparison.status)||comparison.base_commit?.sha!==base||comparison.merge_base_commit?.sha!==base||comparison.status==='identical'&&candidate!==base||comparison.status==='ahead'&&candidate===base)throw Error('Expected migration baseline must be an ancestor of the exact candidate');
  return true;
}
export function candidateRequest(event,inputs={}) {
  if(event.repository?.full_name?.toLowerCase()!==repository.toLowerCase())throw Error('Unexpected repository');
  if(event.pull_request){
    if(event.pull_request.draft || event.pull_request.base.ref!=='alpha' || event.pull_request.head.repo?.full_name?.toLowerCase()!==repository.toLowerCase())throw Error('Only ready same-repository PRs targeting alpha');
    return {branch:event.pull_request.head.ref,expected:event.pull_request.head.sha,base:inputs.migration_base||event.pull_request.base.sha};
  }
  const branch=event.ref?.startsWith('refs/heads/')?event.ref.slice(11):inputs.candidate_ref||'alpha';
  // workflow_dispatch's event.ref names the controller branch, not the candidate.
  const target=event.inputs ? inputs.candidate_ref||'alpha':branch;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(target)||target.includes('..')||target.includes('//')||target.endsWith('/')||target.endsWith('.'))throw Error('Invalid candidate branch');
  if(!event.inputs && event.ref && target!=='alpha')throw Error('Only alpha pushes trigger CI');
  if(inputs.expected_sha && !/^[0-9a-f]{40}$/.test(inputs.expected_sha))throw Error('Invalid expected SHA');
  return {branch:target,expected:inputs.expected_sha||event.after||null,base:inputs.migration_base||null};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const baseline=selectMigrationBaseline({eventName:process.env.GITHUB_EVENT_NAME,workflow:process.env.GITHUB_WORKFLOW,workflowRef:process.env.GITHUB_WORKFLOW_REF,installed:process.env.STAGING_BASE_SHA,override:event.inputs?.migration_base});
  const inputs={...event.inputs,migration_base:baseline.base};
  const requested=candidateRequest(event,inputs);
  const path=requested.branch.split('/').map(encodeURIComponent).join('/');
  const ref=JSON.parse(execFileSync('gh',['api',`repos/${repository}/git/ref/heads/${path}`],{encoding:'utf8'}));
  const sha=ref.object?.sha;
  if(!/^[0-9a-f]{40}$/.test(sha)||requested.expected&&sha!==requested.expected)throw Error('Branch moved or invalid candidate');
  if(baseline.explicit){
    const comparison=JSON.parse(execFileSync('gh',['api',`repos/${repository}/compare/${requested.base}...${sha}`],{encoding:'utf8'}));
    validateMigrationBaseComparison(comparison,{base:requested.base,candidate:sha});
  }
  appendFileSync(process.env.GITHUB_OUTPUT,`sha=${sha}\nbranch=${requested.branch}\nbase=${requested.base}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Exact CI candidate\n- Repository: ${repository}\n- Branch: ${requested.branch}\n- SHA: ${sha}\n- ${baseline.explicit?'Expected migration baseline (explicit prequalification; not a claim it is installed)':'Migration baseline (configured installed source)'}: ${requested.base}\n- Controller: ${process.env.GITHUB_SHA}\n- Deployment: HELD pending Board 3 handoff; no server credentials in this workflow.\n`);
}
