/** Authenticate and revalidate a complete CI witness against the unchanged source. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX,inspectCiBuildPacket,bindCiBuildSource} from './build-artifact.mjs';
import {NEXT_APPLICATION_STATE,NEXT_APPLICATION_MEMBERS,inspectNextStatePacket} from './next-application-cache-protocol.mjs';
import {randomUUID} from 'node:crypto';
import {createPlan,hash} from './plan.mjs';
import {REPOSITORY,validateRun,validateJobs,validateArtifacts,verifyArtifactBytes,validateProof} from './release-policy.mjs';
export const controllerRoot=fileURLToPath(new URL('../../',import.meta.url));
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024}).trim();
export function cleanHead(cwd){const sha=git(cwd,'rev-parse','HEAD');if(!/^[0-9a-f]{40}$/.test(sha)||git(cwd,'status','--porcelain'))throw Error('CI release requires exact clean source: '+cwd);return sha;}
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000}));
function pages(path,key){const all=[];for(let page=1;page<=10;page++){const data=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);if(!Array.isArray(data[key]))throw Error('Missing API inventory');all.push(...data[key]);if(data[key].length<100)return all;}throw Error('API inventory exceeded bound');}
export async function sourceBoundBuild({candidatePath,dir,p,jobs}){
 const producers=jobs.filter(j=>j.name==='build');
 if(producers.length!==1||producers[0].run_id!==p.runId||producers[0].head_sha!==p.controller)throw Error('Build producing job identity differs');
 const job=producers[0],packet=inspectCiBuildPacket(join(dir,BUILD_ARTIFACT),{...p,producerStartedAt:job.started_at,producerCompletedAt:job.completed_at});
 const raw=await import(pathToFileURL(join(candidatePath,'scripts/improve/system-testing-manifest.ts')).href);
 const testing={...(raw.default??{}),...raw};
 const hashing=await import(pathToFileURL(join(candidatePath,'lib/system-testing/hash.ts')).href);
 const stableTestingJson=hashing.stableTestingJson??hashing.default?.stableTestingJson;
 const prepared=testing.prepareSystemTestingBuild({worktree:candidatePath,candidate:p.candidate,buildRecordId:packet.buildRecordId});
 return bindCiBuildSource(packet,{lockBytes:readFileSync(join(candidatePath,'pnpm-lock.yaml')),packageBytes:readFileSync(join(candidatePath,'package.json')),preparedBytes:Buffer.from(stableTestingJson(prepared)+'\n')});
}
export async function verifyCi({candidatePath,runId,baseline}){
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
  const bytes=execFileSync('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`],{maxBuffer:artifact.name===BUILD_ARTIFACT?BUILD_ZIP_MAX:64*1024*1024,timeout:120000});
  verifyArtifactBytes(artifact,bytes);
  const path=join(dir,artifact.name+'.zip');writeFileSync(path,bytes,{flag:'wx',mode:0o600});
  if(bytes.length!==artifact.size_in_bytes)throw Error('Artifact API/archive byte size differs');
  const binary=artifact.name===BUILD_ARTIFACT;
  execFileSync('python3',[fileURLToPath(new URL(binary?'./build-transport-extract.py':'./extract-artifact.py',import.meta.url)),path,join(dir,artifact.name),...(binary?[artifact.digest.slice(7)]:[])],{stdio:'inherit',timeout:60000});
 }
 if(artifacts.some(a=>a.name===NEXT_APPLICATION_STATE)){
  if(!isDeepStrictEqual(readdirSync(join(dir,NEXT_APPLICATION_STATE)).sort(),NEXT_APPLICATION_MEMBERS))throw Error('Application state packet inventory differs');
  const job=jobs.find(j=>j.name==='build');
  const files=new Map(NEXT_APPLICATION_MEMBERS.map(name=>[name,readFileSync(join(dir,NEXT_APPLICATION_STATE,name))]));
  const state=inspectNextStatePacket({files,run,job});
  if(state.producer.source!==candidate||state.producer.controller!==controller)throw Error('Supplemental application state candidate differs');
 }
 const json=(name,file)=>JSON.parse(readFileSync(join(dir,name,file),'utf8'));
 const plan=json('gate-plan','ci-plan.json'),receipt=json('gate-evidence','ci-receipt.json');
 const reports=local.units.map(({id})=>json(`unit-${id}`,`unit-${id}.json`));
 const {fingerprint:unused,...body}={...local,controller,migrationBase:baseline,runtime:plan.runtime};
 const expectedPlan={...body,fingerprint:hash(body)};
 const verified=validateProof({plan,reports,receipt,expectedPlan,p});
 const build=await sourceBoundBuild({candidatePath,dir,p,jobs});
 if(cleanHead(controllerRoot)!==controller||cleanHead(candidatePath)!==candidate)throw Error('Source changed during CI verification');
 const alpha=api('git/ref/heads/alpha');if(![baseline,candidate].includes(alpha.object?.sha))throw Error('Alpha no longer matches the deployed staging baseline');
 const result={...verified,build,candidatePath,controllerBranch:run.head_branch,verifiedAt:new Date().toISOString(),url:run.html_url,evidenceDirectory:dir,artifacts:artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))};
 save('verification.json',result);
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [candidatePath,runId,baseline]=process.argv.slice(2);
 verifyCi({candidatePath,runId,baseline}).then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}

export async function revalidateCi(evidence){
 const local=createPlan(evidence.candidatePath);
 if(cleanHead(controllerRoot)!==evidence.controller||cleanHead(evidence.candidatePath)!==evidence.sha)throw Error('Source changed after CI verification');
 const p={controller:evidence.controller,candidate:evidence.sha,runId:evidence.runId,baseline:evidence.baseline,controllerBranch:evidence.controllerBranch};
 validateRun(api(`actions/runs/${p.runId}`),p);
 const jobs=pages(`actions/runs/${p.runId}/jobs?filter=all`,'jobs');validateJobs(jobs,local);
 const artifacts=pages(`actions/runs/${p.runId}/artifacts`,'artifacts');validateArtifacts(artifacts,p,local);
 const identity=a=>JSON.stringify(a.map(x=>({id:x.id,name:x.name,digest:x.digest})).sort((a,b)=>a.name.localeCompare(b.name)));
 if(identity(artifacts)!==identity(evidence.artifacts)||![p.baseline,p.candidate].includes(api('git/ref/heads/alpha').object?.sha))throw Error('CI evidence or alpha moved after verification');
 const build=await sourceBoundBuild({candidatePath:evidence.candidatePath,dir:evidence.evidenceDirectory,p,jobs});
 if(!isDeepStrictEqual(build,evidence.build)||cleanHead(controllerRoot)!==p.controller||cleanHead(evidence.candidatePath)!==p.candidate)throw Error('Validated build bytes or canonical source changed');
 return true;
}
