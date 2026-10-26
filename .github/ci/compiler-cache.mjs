/** Authenticated graph cache only. Every invocation runs the complete current compiler. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,realpathSync,existsSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {compilerContext,assertCompilerSourceClean,createCompilerCache,runWholeCompiler} from './diagnostics/compiler-transport.mjs';
import {compilerStateIdentity,publishCompilerState,readCompilerState} from './diagnostics/compiler-state.mjs';
import {validateCompilerPhase} from './diagnostics/compiler-incremental.mjs';
import {COMPILER_STATE_ARTIFACT,COMPILER_PACKET_MEMBERS} from './compiler-cache-protocol.mjs';
import {compilerStateApplicability} from '../../scripts/ci-compiler-cache-policy.ts';
import {cacheArtifactCandidates} from './cache-artifact-discovery.mjs';

const REPO='StradaverseHub/ai-hr',REPO_ID=1333414856,WORKFLOW='.github/workflows/alpha-staging.yml',DIAGNOSTIC='.github/workflows/alpha-staging-diagnostics.yml';
const REVIEW='codex/test-suite-efficiency-review-20261025';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const CACHE_NAME=COMPILER_STATE_ARTIFACT,MAX_ZIP=64*1024**2;
const MEMBERS=COMPILER_PACKET_MEMBERS;
export const COMPILER_SEED=Object.freeze({kind:'seed',runId:40243921832,source:'067301b3596a2f6c2f483265edf6a6015e34698c',controller:'067301b3596a2f6c2f483265edf6a6015e34698c',artifactId:12617977681,digest:'sha256:e631a892d9e1826c691475ba9a5f761e3e9e865fbdf57ffc253352ed7e65c8d8'});
const CODE_PATHS=['.github/ci/cache-artifact-discovery.mjs','.github/ci/compiler-cache.mjs','.github/ci/compiler-cache-protocol.mjs','.github/ci/extract-artifact.py','.github/ci/typecheck.sh','.github/ci/prepare-runner.sh','.github/ci/runner-capacity.mjs','.github/ci/diagnostics/compiler-transport.mjs','.github/ci/diagnostics/compiler-state.mjs','.github/ci/diagnostics/compiler-incremental.mjs','scripts/ci-compiler-cache-policy.ts','.github/actions/setup-alpha/action.yml'];
const digest=b=>createHash('sha256').update(b).digest('hex');
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const id=v=>/^[1-9][0-9]{0,15}$/.test(String(v))&&Number.isSafeInteger(Number(v));
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const bounded=(path,max)=>{const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=max,'Cache member is not a bounded regular file');return readFileSync(path);};
export function assertManagedCompilerInvocation(e,event={}){
 assert(e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY===REPO&&e.GITHUB_REPOSITORY_ID===String(REPO_ID)
  &&sha(e.AIHR_CI_HEAD)&&sha(e.AIHR_CI_CONTROL_HEAD)&&sha(e.GITHUB_SHA)&&id(e.GITHUB_RUN_ID)&&e.GITHUB_RUN_ATTEMPT==='1'&&e.AIHR_COMPILER_CACHE_MODE==='whole','Managed first-attempt whole compiler required');
 const pilot=e.AIHR_COMPILER_CACHE_PILOT==='true';
 assert([undefined,'false','true'].includes(e.AIHR_COMPILER_CACHE_PILOT)&&[undefined,'false','true'].includes(e.AIHR_COMPILER_CACHE_FORCE_INVALID),'Unknown compiler cache purpose');
 if(pilot)assert(e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_WORKFLOW_REF===REPO+'/'+DIAGNOSTIC+'@refs/heads/'+REVIEW&&e.GITHUB_JOB==='compiler-cache-pilot'&&e.AIHR_CI_HEAD===e.AIHR_CI_CONTROL_HEAD&&e.GITHUB_SHA===e.AIHR_CI_CONTROL_HEAD,'Exact diagnostic pilot context required');
 else{
  assert(e.GITHUB_WORKFLOW_REF?.startsWith(REPO+'/'+WORKFLOW+'@refs/')&&e.GITHUB_JOB==='typecheck'&&['workflow_dispatch','push','pull_request'].includes(e.GITHUB_EVENT_NAME),'Actual normal compiler workflow required');
  assert(e.AIHR_COMPILER_CACHE_FORCE_INVALID!== 'true','Forced invalid state is only a diagnostic control');
  if(e.GITHUB_EVENT_NAME==='push')assert(e.GITHUB_REF==='refs/heads/alpha','Only actual alpha pushes');
  if(e.GITHUB_EVENT_NAME==='pull_request')assert(event.pull_request&&!event.pull_request.draft&&event.pull_request.base?.ref==='alpha'&&event.pull_request.head?.repo?.full_name===REPO,'Only ready same-repository PR compiler');
 }
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])assert(e[key]==='postgres://nobody:nothing@127.0.0.1:1/no_database','Whole compiler cannot reach a database');
 return {pilot,publish:pilot||e.GITHUB_EVENT_NAME!=='pull_request'};
}
export function validateCompilerOrigin(d,run,jobs,artifact){
 assert(['seed','normal','pilot'].includes(d.kind)&&id(d.runId),'Unknown compiler origin');
 const workflow=d.kind==='normal'?WORKFLOW:DIAGNOSTIC,jobName=d.kind==='seed'?'compiler-state-producer':d.kind==='normal'?'typecheck':'compiler-cache-pilot';
 assert(run.id===Number(d.runId)&&run.run_attempt===1&&run.repository?.full_name===REPO&&run.repository.id===REPO_ID&&run.head_repository?.id===REPO_ID&&run.path===workflow
  &&['workflow_dispatch','push'].includes(run.event)&&sha(run.head_sha),'Cache producer must be an authenticated non-PR managed run');
 if(d.kind!=='normal')assert(run.event==='workflow_dispatch'&&run.head_branch===REVIEW,'Exact pilot/seed origin required');
 if(run.event==='push')assert(run.head_branch==='alpha','Only alpha push cache publishers');
 assert(jobs&&jobs.total_count===jobs.jobs.length&&jobs.jobs.length<100,'Complete bounded producer job inventory required');
 const selected=jobs.jobs.filter(j=>j.name===jobName);assert(selected.length===1,'Unique compiler producer required');
 const job=selected[0];assert(job.status==='completed'&&job.conclusion==='success'&&job.run_id===run.id&&job.run_attempt===1&&job.head_sha===run.head_sha&&job.head_branch===run.head_branch,'Successful exact compiler job required');
 assert(artifact&&id(artifact.id)&&artifact.name===(d.kind==='seed'?'diagnostic-compiler-state-producer':CACHE_NAME)&&!artifact.expired
  &&artifact.workflow_run?.id===run.id&&artifact.workflow_run.repository_id===REPO_ID&&artifact.workflow_run.head_repository_id===REPO_ID&&artifact.workflow_run.head_sha===run.head_sha&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest??'')
  &&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=MAX_ZIP,'Compiler artifact identity differs');
 if(d.kind==='seed')assert(run.head_sha===d.controller&&artifact.id===d.artifactId&&artifact.digest===d.digest,'Only the exact independently verified seed may bootstrap');
 return job;
}
export function verifyCompilerPublisherTree(tree,expected){
 assert(tree&&tree.truncated===false&&Array.isArray(tree.tree),'Complete authenticated controller tree required');
 const entries=new Map(tree.tree.filter(v=>v.type==='blob').map(v=>[v.path,v.sha]));
 assert(entries.size===tree.tree.filter(v=>v.type==='blob').length,'Duplicate controller tree path');
 assert(Object.keys(expected).length>=CODE_PATHS.length,'Complete compiler implementation policy required');
 for(const [path,blob]of Object.entries(expected))assert(sha(blob)&&entries.get(path)===blob,'Producer compiler/workflow implementation differs: '+path);
 return true;
}
function expectedCode(kind,deadline){
 const paths=[...CODE_PATHS,kind==='normal'?WORKFLOW:DIAGNOSTIC],remaining=deadline-Date.now();assert(remaining>0,'Compiler publisher code lookup deadline');
 const blobs=execFileSync('git',['rev-parse',...paths.map(path=>'HEAD:'+path)],{cwd:ROOT,encoding:'utf8',timeout:Math.min(5000,remaining)}).trim().split('\n');
 assert(blobs.length===paths.length&&blobs.every(sha),'Complete compiler implementation identities required');
 return Object.fromEntries(paths.map((path,index)=>[path,blobs[index]]));
}
function metadataApi(path,deadline,maxBuffer=8*1024**2){
 const remaining=deadline-Date.now();assert(remaining>0,'Compiler cache lookup budget exhausted');
 return JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+path],{encoding:'utf8',timeout:Math.min(3000,remaining),maxBuffer}));
}
function listOrigins(e,report,deadline){
 if(e.AIHR_COMPILER_CACHE_FORCE_INVALID==='true')return [COMPILER_SEED];
 try{
  const inventory=metadataApi('actions/artifacts?name='+encodeURIComponent(CACHE_NAME)+'&per_page=3',deadline);
  return [...cacheArtifactCandidates(inventory,{name:CACHE_NAME,currentRunId:e.GITHUB_RUN_ID}).map(pointer=>({kind:'artifact',...pointer})),COMPILER_SEED];
 }catch(error){report.lookup.push({discoveryError:String(error)});return [COMPILER_SEED];}
}
async function restoreGraph(source,out,current,e,report){
 const deadline=Date.now()+20000;
 for(const selectedOrigin of listOrigins(e,report,deadline)){
  let d=selectedOrigin;
  if(Date.now()>=deadline){report.lookup.push({error:'Lookup budget exhausted; compiling cold'});break;}
  const observation={kind:d.kind,runId:d.runId};report.lookup.push(observation);
  try{
   const run=d.listed||metadataApi('actions/runs/'+d.runId,deadline);
   if(d.kind==='artifact'){
    const kind=run.path===WORKFLOW?'normal':run.path===DIAGNOSTIC?'pilot':null;assert(kind,'Graph publisher workflow differs');
    d={...d,kind};observation.kind=kind;
   }
   const jobs=metadataApi('actions/runs/'+d.runId+'/attempts/1/jobs?per_page=100',deadline);
   let artifact;
   if(d.kind==='seed')artifact=metadataApi('actions/artifacts/'+d.artifactId,deadline);
   else{
    const inventory=metadataApi('actions/runs/'+d.runId+'/artifacts?per_page=100',deadline);
    assert(inventory.total_count===inventory.artifacts.length&&inventory.artifacts.length<100,'Complete bounded artifact inventory required');
    const selected=inventory.artifacts.filter(v=>v.name===CACHE_NAME);assert(selected.length===1,'No unique eligible compiler cache artifact');artifact=selected[0];
   }
   if(d.discoveryArtifactId!==undefined)assert(artifact.id===d.discoveryArtifactId,'Compiler graph discovery pointer differs');
   const job=validateCompilerOrigin(d,run,jobs,artifact);
   let publisherTree=null,publisherCode=null;
   if(d.kind!=='seed'){
    publisherTree=metadataApi('git/trees/'+run.head_sha+'?recursive=1',deadline);publisherCode=expectedCode(d.kind,deadline);
    verifyCompilerPublisherTree(publisherTree,publisherCode);observation.publisherCodeVerified=true;
   }
   const remaining=deadline-Date.now();assert(remaining>0,'Cache download budget exhausted');
   const zip=execFileSync('gh',['api','repos/'+REPO+'/actions/artifacts/'+artifact.id+'/zip'],{timeout:Math.min(8000,remaining),maxBuffer:MAX_ZIP});
   assert(zip.length===artifact.size_in_bytes&&zip.length<=MAX_ZIP&&'sha256:'+digest(zip)===artifact.digest,'Cache ZIP bytes differ');
   const dir=join(out,'origin-'+d.kind+'-'+d.runId);mkdirSync(dir,{mode:0o700});
   writeFileSync(join(dir,'authenticated.zip'),zip,{flag:'wx',mode:0o600});
   json(join(dir,'run.json'),run);json(join(dir,'jobs.json'),jobs);json(join(dir,'artifact.json'),artifact);
   if(publisherTree){json(join(dir,'controller-tree.json'),publisherTree);json(join(dir,'expected-code.json'),publisherCode);}
   const packet=join(dir,'packet');execFileSync('python3',[join(ROOT,'.github/ci/extract-artifact.py'),join(dir,'authenticated.zip'),packet],{timeout:5000,stdio:'inherit'});
   assert(isDeepStrictEqual(readdirSync(packet).sort(),MEMBERS),'Exact bounded compiler packet required');
   const producer=JSON.parse(bounded(join(packet,'producer.json'),1024*1024)),envelope=JSON.parse(bounded(join(packet,'envelope.json'),16*1024));
   const log=JSON.parse(bounded(join(packet,'compiler-log.json'),32*1024*1024)),swap=JSON.parse(bounded(join(packet,'swap-cleanup.json'),16*1024));
   const original=compilerStateIdentity(producer.identity);
   assert(producer.source===original.source&&producer.controller===original.controller&&producer.runId===String(run.id)&&original.runId===String(run.id)&&original.attempt==='1'&&producer.attempt==='1'
    &&producer.controller===run.head_sha&&producer.exitCode===0&&producer.releaseAuthorized===false&&producer.phases.length===1
    &&producer.sourceRestored&&producer.controllerRestored&&producer.cacheRemoved,'Compiler producer is not an authentic clean completed whole compilation');
   assert(producer.kind===(d.kind==='seed'?'WHOLE_PROJECT_COMPILER_STATE_PRODUCER_NOT_RELEASE':'WHOLE_PROJECT_COMPILER_CACHE_STATE_NOT_TEST_OR_RELEASE'),'Compiler origin purpose differs');
   if(d.kind==='seed')assert(producer.source===d.source,'Seed source differs');
   else assert(producer.graphReuseSupported===true,'Producer configuration requires cold compilation');
   assert(swap.kind==='OWNED_COMPILER_SWAP_CLEANUP'&&swap.runId===String(run.id)&&swap.attempt==='1'&&swap.mode===(d.kind==='seed'?'--state-transport-producer':'--whole-cache')
    &&swap.originalCommandExit===0&&swap.cleanupExit===0&&swap.fileAbsent===true&&swap.swapAbsent===true,'Original owned compiler resources not verified');
   assert(log.kind==='RAW_WHOLE_PROJECT_COMPILER_OUTPUT'&&typeof log.text==='string'&&Buffer.byteLength(log.text)<=4*1024**2&&digest(Buffer.from(log.text))===producer.compilerLogSha256,'Compiler log bytes differ');
   const phase=validateCompilerPhase(producer.phases[0],log.text);assert(phase.files===envelope.completed.files&&Date.parse(producer.phases[0].startedAt)>=Date.parse(job.started_at)&&Date.parse(producer.phases[0].endedAt)<=Date.parse(job.completed_at),'Original whole compiler process not bound to actual job');
   const comparison=original.source===current.identity.source?null:metadataApi('compare/'+original.source+'...'+current.identity.source+'?per_page=100',deadline);
   if(comparison)json(join(dir,'source-comparison.json'),comparison);
   const applicability=compilerStateApplicability({...original,invoked:producer.invoked},{...current.identity,invoked:current.invoked},comparison);
   const snapshot=join(dir,'snapshot');mkdirSync(snapshot,{mode:0o700});
   let bytes=bounded(join(packet,'state.json'),64*1024**2);
   if(e.AIHR_COMPILER_CACHE_FORCE_INVALID==='true'){bytes=Buffer.concat([bytes,Buffer.from(' ')]);observation.forcedInvalidBytesSha256=digest(bytes);}
   writeFileSync(join(snapshot,'whole-project.tsbuildinfo'),bytes,{flag:'wx',mode:0o600});json(join(snapshot,'provenance.json'),envelope);
   const verified=readCompilerState(snapshot,original);
   assert(Date.now()<=deadline,'Compiler cache lookup deadline exceeded during local validation');
   observation.accepted=true;observation.artifactId=artifact.id;
   return {bytes:verified.bytes,origin:{kind:d.kind,source:original.source,controller:original.controller,runId:run.id,artifactId:artifact.id,artifactDigest:artifact.digest,stateSha256:digest(verified.bytes)},applicability};
  }catch(error){observation.error=String(error);}
 }
 return null;
}
export async function managedWholeCompiler(){
 const e=process.env,event=e.GITHUB_EVENT_PATH?JSON.parse(readFileSync(e.GITHUB_EVENT_PATH,'utf8')):{};
 const admission=assertManagedCompilerInvocation(e,event),source=realpathSync(process.cwd());
 assertCompilerSourceClean(source,e);
 assert(e.AIHR_CI_CAPACITY_PROFILE==='bounded-whole-compiler','Explicit validated whole-compiler capacity policy required');
 assert(lstatSync('/usr/bin/prlimit').isFile(),'Finite Linux compiler output limit required');
 const out=join(realpathSync(e.RUNNER_TEMP),'whole-compiler-cache');mkdirSync(out,{mode:0o700});
 const current=compilerContext(source,e),cache=createCompilerCache(source),tsconfig=JSON.parse(readFileSync(join(source,'tsconfig.json'),'utf8'));
 const graphReuseSupported=tsconfig.extends===undefined&&tsconfig.references===undefined;
 const report={kind:'WHOLE_PROJECT_COMPILER_CACHE_STATE_NOT_TEST_OR_RELEASE',source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD,runId:e.GITHUB_RUN_ID,attempt:e.GITHUB_RUN_ATTEMPT,
  identity:current.identity,invoked:current.invoked,startedAt:new Date().toISOString(),lookup:[],phases:[],diskSamples:[],cacheHit:false,cacheWasAbsent:!existsSync(cache.file),
  capacityProfile:e.AIHR_CI_CAPACITY_PROFILE,graphReuseSupported,perFileOutputLimitBytes:64*1024**2,cachePublishPermitted:admission.publish,forcedInvalidControl:e.AIHR_COMPILER_CACHE_FORCE_INVALID==='true',exitCode:1,releaseAuthorized:false};
 let produced;
 try{
  assert(report.cacheWasAbsent,'Never merge an existing compiler cache');
  const restoreStarted=Date.now(),restored=graphReuseSupported?await restoreGraph(source,out,current,e,report):null;report.restoreMs=Date.now()-restoreStarted;
  if(!graphReuseSupported)report.lookup.push({error:'Extended/referenced configurations retain mandatory cold compilation'});
  if(restored){
   writeFileSync(cache.file,restored.bytes,{flag:'wx',mode:0o600});
   report.cacheHit=true;report.origin=restored.origin;report.applicability=restored.applicability;report.restoredStateSha256=digest(restored.bytes);
  }else{
   assert(!existsSync(cache.file),'Cold fallback must start without compiler state');report.coldStateWasAbsent=true;
   if(report.forcedInvalidControl)assert(report.lookup.some(v=>v.forcedInvalidBytesSha256&&v.error?.includes('Compiler-state bytes differ')),'Invalid-state control did not reach authenticated graph validation');
   report.coldFallbackReason=report.forcedInvalidControl?'Forced invalid authenticated graph was refused; actual compiler runs cold':'No authenticated compatible state; actual compiler runs cold';
  }
  assertCompilerSourceClean(source,e);
  produced=await runWholeCompiler(source,cache,out,report,'whole-current-project');
  assertCompilerSourceClean(source,e);report.compilerLogSha256=digest(Buffer.from(produced.text));report.exitCode=0;
 }catch(error){
  report.error=String(error);
  const path=join(out,'whole-current-project.log');
  if(existsSync(path)){try{console.error(bounded(path,4*1024**2).toString('utf8'));report.failedCompilerOutputPrinted=true;}catch{report.failedCompilerOutputPrinted=false;}}
  throw error;
 }
 finally{
  cache.remove();report.cacheRemoved=!existsSync(cache.dir);
  try{assertCompilerSourceClean(source,e);report.sourceRestored=true;report.controllerRestored=true;}catch{report.sourceRestored=false;report.controllerRestored=false;report.exitCode=1;}
  if(!report.cacheRemoved)report.exitCode=1;
  report.endedAt=new Date().toISOString();json(join(out,'comparison.json'),report);
 }
 assert(report.exitCode===0&&produced,'Whole compiler or owned cleanup failed');
 if(admission.publish){
  const snapshot=join(out,'published-snapshot');mkdirSync(snapshot,{mode:0o700});
  const envelope=publishCompilerState(snapshot,produced.bytes,current.identity,{processExitCode:0,files:produced.row.files,completedAt:produced.row.endedAt});
  readCompilerState(snapshot,current.identity);
  const packet=join(realpathSync(e.RUNNER_TEMP),'whole-compiler-state-packet');mkdirSync(packet,{mode:0o700});
  writeFileSync(join(packet,'state.json'),produced.bytes,{flag:'wx',mode:0o600});
  json(join(packet,'envelope.json'),envelope);json(join(packet,'producer.json'),report);json(join(packet,'compiler-log.json'),{kind:'RAW_WHOLE_PROJECT_COMPILER_OUTPUT',text:produced.text});
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))managedWholeCompiler().then(v=>console.log(JSON.stringify(v))).catch(error=>{console.error(error);process.exitCode=1;});

export {CODE_PATHS as COMPILER_CODE_PATHS};
