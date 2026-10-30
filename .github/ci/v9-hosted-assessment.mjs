/** Isolated hosted read-only wrapper; the reader and APP are physically pinned separately. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.env.GITHUB_WORKSPACE),temp=resolve(process.env.RUNNER_TEMP);
const reader=join(root,'reader'),source=join(root,'source'),wrapper=join(root,'wrapper');
const output=join(temp,'v9-review-public'),evidence=join(temp,'v9-review-private');
mkdirSync(output,{mode:0o700});
const sha=p=>execFileSync('git',['rev-parse','HEAD'],{cwd:p,encoding:'utf8'}).trim();
const clean=p=>assert(!execFileSync('git',['status','--porcelain'],{cwd:p,encoding:'utf8'}),'Exact clean checkout required');
const identity={kind:'V9_HOSTED_READ_ONLY_ASSESSMENT',wrapper:sha(wrapper),reader:sha(reader),candidate:sha(source),originalRunId:41039154492,focusedRunId:41042016086,installationEligible:false,releaseAuthorized:false};
assert(process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.GITHUB_RUN_ATTEMPT==='1','First-attempt same-repository manual diagnostic required');
assert(identity.wrapper===process.env.V9_WRAPPER_SHA&&identity.reader==='281d2fff8d8eac0f61dce84689f2b1636d6f166f'&&identity.candidate==='72a2673af354f382502ecc7799316fac3c19b1ac','Frozen identities differ');
[source,reader,wrapper].forEach(clean);
// actions/checkout omits the optional .git suffix; normalize only the verified canonical URL.
const origin=execFileSync('git',['remote','get-url','origin'],{cwd:source,encoding:'utf8'}).trim();
assert(/^https:\/\/github\.com\/stradaversehub\/ai-hr(?:\.git)?$/i.test(origin),'Foreign checkout origin');
execFileSync('git',['remote','set-url','origin','https://github.com/StradaverseHub/ai-hr.git'],{cwd:source});
writeFileSync(join(output,'identity.json'),JSON.stringify(identity,null,2)+'\n',{mode:0o600,flag:'wx'});
const result=spawnSync(process.execPath,['--import',join(source,'node_modules/tsx/dist/loader.mjs'),join(reader,'.github/ci/v9-db-resource-assessment.mjs'),source,'41042016086',evidence],{cwd:reader,encoding:'utf8',timeout:50*60*1000,maxBuffer:8*1024**2,env:{...process.env,AIHR_CI_HEAD:identity.candidate}});
[source,reader,wrapper].forEach(clean);
// No build binaries, raw archives, private paths, configuration or operator credentials are uploaded.
const refusal={...identity,exitCode:result.status,signal:result.signal,error:result.error?.code??null,assessmentProduced:existsSync(join(evidence,'review-only-assessment.json'))};
if(refusal.assessmentProduced){const proof=JSON.parse(readFileSync(join(evidence,'review-only-assessment.json'),'utf8'));assert(proof.installationEligible===false&&proof.releaseAuthorized===false,'Noninstallable boundary required');refusal.assessment={kind:proof.kind,candidate:proof.candidate,tests:proof.tests,history:proof.history};}
else {
 const text=result.stderr??'';
 refusal.reason=['Unresolved','Incomplete','Foreign','changed','differs','exceeded','Expired','Missing','timed out'].find(code=>text.includes(code))??'ASSESSMENT_REFUSED';
 refusal.diagnosticSha256=createHash('sha256').update(text).digest('hex');
 const bindingsPath=join(evidence,'history-bindings.json');
 if(existsSync(bindingsPath)){
  const bound=new Set(JSON.parse(readFileSync(bindingsPath,'utf8')).map(([runId])=>runId));
  const rows=JSON.parse(readFileSync(join(evidence,'history.json'),'utf8'));
  const original=JSON.parse(readFileSync(join(evidence,'original/run.json'),'utf8'));
  refusal.unresolvedRunIds=rows.filter(row=>![41039154492,41042016086].includes(row.id)&&!bound.has(row.id)&&(row.status!=='completed'||Date.parse(row.updated_at)>=Date.parse(original.updated_at))).map(row=>row.id);
 }
}
writeFileSync(join(output,'result.json'),JSON.stringify(refusal,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify(refusal));
if(result.status!==0||!refusal.assessmentProduced)process.exitCode=1;
