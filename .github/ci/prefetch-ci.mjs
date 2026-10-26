/** Immutable byte staging only. No receipt, extraction, SSH, source publication or release acceptance. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,renameSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlan} from './plan.mjs';
import {requiredEvidence} from './manifest.mjs';
import {cleanHead,controllerRoot} from './release-ci.mjs';
import {downloadCiArchives} from './archive-downloads.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX} from './build-artifact.mjs';
import {COMPILER_STATE_ARTIFACT} from './compiler-cache-protocol.mjs';
import {NEXT_APPLICATION_STATE} from './next-application-cache-protocol.mjs';

export function inspectPrefetchSnapshot({run,artifacts,binding,allowedNames,previous=[]}){
 assert(run.id===binding.runId&&run.repository?.id===REPOSITORY_ID&&run.repository?.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign prefetch run');
 assert(run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.head_sha===binding.controller&&run.head_branch===binding.controllerBranch&&run.run_attempt===1,'Prefetch workflow identity changed');
 assert(run.event==='workflow_dispatch'||(run.event==='push'&&run.head_branch==='alpha'),'Unsupported byte producer event');
 assert(['queued','in_progress','pending','waiting','requested','completed'].includes(run.status),'Unknown run state');
 assert(Array.isArray(artifacts)&&artifacts.length<=allowedNames.length&&new Set(allowedNames).size===allowedNames.length,'Unbounded byte inventory');
 const current=new Map(),ids=new Set();
 for(const a of artifacts){
  assert(allowedNames.includes(a.name)&&!current.has(a.name)&&Number.isSafeInteger(a.id)&&a.id>0&&!ids.has(a.id),'Unexpected or duplicate artifact');
  assert(a.expired===false&&Number.isSafeInteger(a.size_in_bytes)&&a.size_in_bytes>0&&a.size_in_bytes<=(a.name===BUILD_ARTIFACT?BUILD_ZIP_MAX:64*1024**2)&&/^sha256:[a-f0-9]{64}$/.test(a.digest??''),'Invalid immutable byte boundary');
  const w=a.workflow_run;assert(w?.id===binding.runId&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===binding.controller&&w.head_branch===binding.controllerBranch,'Foreign artifact provenance');
  current.set(a.name,a);ids.add(a.id);
 }
 for(const a of previous){const fresh=current.get(a.name);assert(fresh,'Previously staged artifact removed');for(const key of ['id','digest','size_in_bytes'])assert(fresh[key]===a[key],'Previously staged artifact changed');}
 return {kind:'PREFETCH_SNAPSHOT_BYTES_ONLY',fresh:artifacts.filter(a=>!previous.some(old=>old.name===a.name)),terminal:run.status==='completed',releaseAuthorized:false};
}
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:30000,maxBuffer:8*1024**2}));
function artifactInventory(runId){
 const all=[];let total;
 for(let page=1;page<=6;page++){
  const response=api(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
  assert(Number.isSafeInteger(response.total_count)&&response.total_count<=512&&Array.isArray(response.artifacts),'Invalid bounded API inventory');
  total??=response.total_count;assert(response.total_count===total,'Inventory changed across pages; retry observation');all.push(...response.artifacts);
  if(all.length===total)return all;
  assert(all.length<total&&response.artifacts.length===100,'Incomplete API page');
 }
 throw Error('Artifact inventory exceeded bound');
}
export async function prefetchCi({candidatePath,runId,baseline,directory}){
 candidatePath=resolve(candidatePath);runId=Number(runId);assert(Number.isSafeInteger(runId)&&runId>0&&/^[a-f0-9]{40}$/.test(baseline??''),'Invalid run/baseline');
 const candidate=cleanHead(candidatePath),controller=cleanHead(controllerRoot),first=api(`actions/runs/${runId}`);
 const binding={runId,candidate,controller,baseline,controllerBranch:first.head_branch};
 assert(execFileSync('git',['remote','get-url','origin'],{cwd:candidatePath,encoding:'utf8'}).trim().toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Foreign source repository');
 execFileSync('git',['merge-base','--is-ancestor',baseline,candidate],{cwd:candidatePath,stdio:'ignore'});
 const plan=createPlan(candidatePath),required=requiredEvidence(plan).artifacts,allowedNames=[...required,COMPILER_STATE_ARTIFACT,NEXT_APPLICATION_STATE];
 // Validate the run before creating an output directory or opening any download child.
 inspectPrefetchSnapshot({run:first,artifacts:[],binding,allowedNames});
 const dir=resolve(directory);mkdirSync(dir,{mode:0o700});assert.equal(realpathSync(dir),dir);
 const save=(name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 const started=Date.now();save('binding.json',{...binding,kind:'PREFETCH_BYTES_NOT_RELEASE_ACCEPTANCE',startedAt:new Date(started).toISOString(),requiredNames:required,releaseAuthorized:false});
 let previous=[],iteration=0;
 while(Date.now()-started<45*60*1000){
  assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===controller,'Frozen prefetch source changed');
  const run=iteration===0?first:api(`actions/runs/${runId}`),artifacts=artifactInventory(runId);
  const observation=inspectPrefetchSnapshot({run,artifacts,binding,allowedNames,previous});iteration++;
  save(`snapshot-${iteration}.json`,{observedAt:new Date().toISOString(),run,artifacts});
  if(observation.fresh.length){
   const batch=join(dir,`batch-${iteration}`);mkdirSync(batch,{mode:0o700});
   try{
    const result=await downloadCiArchives(observation.fresh,batch);save(`download-${iteration}.json`,result);
    for(const a of observation.fresh){const destination=join(dir,a.name+'.zip');assert(!existsSync(destination),'Staged destination exists');renameSync(join(batch,a.name+'.zip'),destination);}
   }catch(error){save(`download-failed-${iteration}.json`,error.report??{error:String(error),releaseAuthorized:false});throw error;}
   previous=artifacts;
  }
  assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===controller,'Source changed during byte staging');
  if(observation.terminal){
   const result={...binding,kind:'PREFETCH_TERMINAL_BYTES_NOT_ACCEPTANCE',conclusion:run.conclusion,startedAt:new Date(started).toISOString(),observedTerminalAt:new Date().toISOString(),stagedArtifacts:previous,allRequiredNamesPresent:required.every(name=>previous.some(a=>a.name===name)),releaseAuthorized:false};save('terminal.json',result);return result;
  }
  await new Promise(resolve=>setTimeout(resolve,10000));
 }
 throw Error('Byte observation deadline reached; partial evidence retained, CI was not cancelled');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [candidatePath,runId,baseline,directory]=process.argv.slice(2);
 assert(candidatePath&&runId&&baseline&&directory&&process.argv.length===6,'Usage: node prefetch-ci.mjs <candidate> <run-id> <baseline-sha> <new-private-directory>');
 prefetchCi({candidatePath,runId,baseline,directory}).then(r=>console.log(JSON.stringify({runId:r.runId,conclusion:r.conclusion,staged:r.stagedArtifacts.length,allRequiredNamesPresent:r.allRequiredNamesPresent,releaseAuthorized:false}))).catch(e=>{console.error(e);process.exitCode=1;});
}
