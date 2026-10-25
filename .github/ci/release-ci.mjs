/** Authenticate and revalidate a complete CI witness against the unchanged source. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createPlan,hash} from './plan.mjs';
import {REPOSITORY,validateRun,validateJobs,validateArtifacts,verifyArtifactBytes,validateProof} from './release-policy.mjs';
export const controllerRoot=fileURLToPath(new URL('../../',import.meta.url));
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024}).trim();
export function cleanHead(cwd){const sha=git(cwd,'rev-parse','HEAD');if(!/^[0-9a-f]{40}$/.test(sha)||git(cwd,'status','--porcelain'))throw Error('CI release requires exact clean source: '+cwd);return sha;}
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000}));
function pages(path,key){const all=[];for(let page=1;page<=10;page++){const data=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);if(!Array.isArray(data[key]))throw Error('Missing API inventory');all.push(...data[key]);if(data[key].length<100)return all;}throw Error('API inventory exceeded bound');}
export function verifyCi({candidatePath,runId,baseline}){
 candidatePath=resolve(candidatePath);runId=Number(runId);
 if(!Number.isSafeInteger(runId)||runId<1||!/^[0-9a-f]{40}$/.test(baseline??''))throw Error('Invalid CI run or staging baseline');
 const controller=cleanHead(controllerRoot),candidate=cleanHead(candidatePath),p={controller,candidate,runId,baseline};
 if(git(candidatePath,'remote','get-url','origin').toLowerCase()!=='https://github.com/stradaversehub/ai-hr.git')throw Error('Unexpected repository origin');
 execFileSync('git',['merge-base','--is-ancestor',baseline,candidate],{cwd:candidatePath,stdio:'ignore'});
 const run=api(`actions/runs/${runId}`);validateRun(run,p);p.controllerBranch=run.head_branch;
 const local=createPlan(candidatePath);
 const jobs=pages(`actions/runs/${runId}/jobs?filter=all`,'jobs');validateJobs(jobs,local);
 const artifacts=pages(`actions/runs/${runId}/artifacts`,'artifacts');validateArtifacts(artifacts,p,local);
 const dir=join(controllerRoot,'scratchpad',`validated-ci-${runId}-${randomUUID()}`);mkdirSync(dir,{recursive:true,mode:0o700});
 const save=(name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 save('run.json',run);save('jobs.json',jobs);save('artifacts.json',artifacts);
 for(const artifact of artifacts){
  const bytes=execFileSync('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`],{maxBuffer:128*1024*1024,timeout:120000});
  verifyArtifactBytes(artifact,bytes);
  const path=join(dir,artifact.name+'.zip');writeFileSync(path,bytes,{flag:'wx',mode:0o600});
  execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),path,join(dir,artifact.name)],{stdio:'inherit',timeout:60000});
 }
 const json=(name,file)=>JSON.parse(readFileSync(join(dir,name,file),'utf8'));
 const plan=json('gate-plan','ci-plan.json'),receipt=json('gate-evidence','ci-receipt.json');
 const reports=local.units.map(({id})=>json(`unit-${id}`,`unit-${id}.json`));
 const {fingerprint:unused,...body}={...local,controller,migrationBase:baseline,runtime:plan.runtime};
 const expectedPlan={...body,fingerprint:hash(body)};
 const verified=validateProof({plan,reports,receipt,expectedPlan,p});
 if(cleanHead(controllerRoot)!==controller||cleanHead(candidatePath)!==candidate)throw Error('Source changed during CI verification');
 const alpha=api('git/ref/heads/alpha');if(![baseline,candidate].includes(alpha.object?.sha))throw Error('Alpha no longer matches the deployed staging baseline');
 const result={...verified,candidatePath,controllerBranch:run.head_branch,verifiedAt:new Date().toISOString(),url:run.html_url,evidenceDirectory:dir,artifacts:artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))};
 save('verification.json',result);
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [candidatePath,runId,baseline]=process.argv.slice(2);
 console.log(JSON.stringify(verifyCi({candidatePath,runId,baseline}),null,2));
}

export function revalidateCi(evidence){
 const local=createPlan(evidence.candidatePath);
 if(cleanHead(controllerRoot)!==evidence.controller||cleanHead(evidence.candidatePath)!==evidence.sha)throw Error('Source changed after CI verification');
 const p={controller:evidence.controller,candidate:evidence.sha,runId:evidence.runId,baseline:evidence.baseline,controllerBranch:evidence.controllerBranch};
 validateRun(api(`actions/runs/${p.runId}`),p);
 validateJobs(pages(`actions/runs/${p.runId}/jobs?filter=all`,'jobs'),local);
 const artifacts=pages(`actions/runs/${p.runId}/artifacts`,'artifacts');validateArtifacts(artifacts,p,local);
 const identity=a=>JSON.stringify(a.map(x=>({id:x.id,name:x.name,digest:x.digest})).sort((a,b)=>a.name.localeCompare(b.name)));
 if(identity(artifacts)!==identity(evidence.artifacts)||![p.baseline,p.candidate].includes(api('git/ref/heads/alpha').object?.sha))throw Error('CI evidence or alpha moved after verification');
 return true;
}
