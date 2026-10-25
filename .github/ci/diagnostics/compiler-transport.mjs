/** Real whole-project compilation across two hosted VMs; state is never a PASS or release witness. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,lstatSync,realpathSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {compilerStateIdentity,publishCompilerState,readCompilerState} from './compiler-state.mjs';
import {measuredCommand,validateCompilerPhase} from './compiler-incremental.mjs';

const REPO='StradaverseHub/ai-hr',WORKFLOW='.github/workflows/alpha-staging-diagnostics.yml';
const REF=REPO+'/'+WORKFLOW+'@refs/heads/codex/test-suite-efficiency-review-20261025';
const CONTROLLER=fileURLToPath(new URL('../../../',import.meta.url));
const CACHE_RELATIVE='.next/cache/compiler-transport/whole-project.tsbuildinfo';
const MEMBERS=['compiler-log.json','envelope.json','producer.json','state.json','swap-cleanup.json'];
const MAX_ZIP=96*1024*1024,MAX_LOG=4*1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}).trim();
const api=p=>JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+p],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024}));
const regular=(path,max)=>{const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=max,'Bounded regular compiler evidence required');return readFileSync(path);};
const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/.test(v)&&Number.isSafeInteger(Number(v));
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);

export function assertCompilerTransportInvocation(e,mode){
 assert(['producer','consumer'].includes(mode)&&e.AIHR_COMPILER_TRANSPORT===mode,'Explicit compiler-state purpose required');
 assert(e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY===REPO
  &&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_WORKFLOW_REF===REF
  &&e.GITHUB_RUN_ATTEMPT==='1'&&id(e.GITHUB_RUN_ID)&&sha(e.AIHR_CI_HEAD)&&sha(e.AIHR_CI_CONTROL_HEAD)
  &&e.GITHUB_SHA===e.AIHR_CI_CONTROL_HEAD&&typeof e.RUNNER_NAME==='string'&&e.RUNNER_NAME.length>0,'Managed manual compiler context required');
 const origin=e.AIHR_COMPILER_ORIGIN_RUN_ID;
 if(origin){
  assert(mode==='consumer'&&id(origin)&&origin!==e.GITHUB_RUN_ID&&e.AIHR_COMPILER_ORIGIN_CONTROLLER===e.AIHR_CI_HEAD,'Explicit retained compiler origin required');
 }else assert(e.AIHR_CI_HEAD===e.AIHR_CI_CONTROL_HEAD,'Initial producer/source/controller must match');
 return true;
}
const originRun=e=>e.AIHR_COMPILER_ORIGIN_RUN_ID||e.GITHUB_RUN_ID;
const originController=e=>e.AIHR_COMPILER_ORIGIN_CONTROLLER||e.AIHR_CI_CONTROL_HEAD;
export function validateCompilerArtifact({run,jobs,artifact},e){
 assert(id(e.AIHR_COMPILER_ARTIFACT_ID),'Exact compiler artifact ID required');
 assert(run.id===Number(originRun(e))&&run.run_attempt===1&&run.event==='workflow_dispatch'&&run.head_sha===e.AIHR_CI_HEAD
  &&run.path===WORKFLOW&&run.head_branch==='codex/test-suite-efficiency-review-20261025'&&run.repository?.full_name===REPO&&run.repository.id===1333414856,'Authenticated compiler origin differs');
 const selected=jobs.filter(j=>j.name==='compiler-state-producer');assert.equal(selected.length,1,'Unique compiler producer required');
 const job=selected[0];assert(job.run_id===run.id&&job.run_attempt===1&&job.head_sha===run.head_sha&&job.status==='completed'&&job.conclusion==='success','Completed compiler producer required');
 assert(artifact.id===Number(e.AIHR_COMPILER_ARTIFACT_ID)&&artifact.name==='diagnostic-compiler-state-producer'&&!artifact.expired
  &&artifact.workflow_run?.id===run.id&&artifact.workflow_run.head_sha===run.head_sha
  &&/^[a-f0-9]{64}$/.test(e.AIHR_COMPILER_ARTIFACT_DIGEST??'')&&artifact.digest==='sha256:'+e.AIHR_COMPILER_ARTIFACT_DIGEST
  &&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=MAX_ZIP,'Authenticated compiler artifact differs');
 return job;
}
export function assertIndependentCompilerVm(producer,current){
 assert(typeof producer?.name==='string'&&producer.name!==current.name&&/^[a-f0-9]{64}$/.test(producer.bootSha256??'')
  &&producer.bootSha256!==current.bootSha256&&producer.sourcePath===current.sourcePath,'Fresh VM at the same logical compiler path required');
 return true;
}
function directory(path){
 const st=lstatSync(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&realpathSync(path)===path,'Canonical compiler directory required');return st;
}
function sourceClean(source,e){
 assert(git(source,'rev-parse','HEAD')===e.AIHR_CI_HEAD&&git(source,'status','--porcelain','--untracked-files=all')==='','Exact clean compiler source required');
 assert(git(CONTROLLER,'rev-parse','HEAD')===e.AIHR_CI_CONTROL_HEAD&&git(CONTROLLER,'status','--porcelain','--untracked-files=all')==='','Exact clean compiler controller required');
}
function generatedTypes(source){
 const root=join(source,'.next/types'),rows=[];
 function walk(dir){
  directory(dir);
  for(const name of readdirSync(dir).sort()){
   const path=join(dir,name),s=lstatSync(path);assert(!s.isSymbolicLink(),'Generated types must not be links');
   if(s.isDirectory())walk(path);else{assert(s.isFile()&&s.size<=16*1024*1024&&rows.length<10000,'Generated types exceed bounds');rows.push({path:path.slice(root.length+1),bytes:s.size,sha256:hash(readFileSync(path))});}
  }
 }
 walk(root);assert(rows.length>0,'Run real Next typegen first');return rows;
}
function context(source,e){
 const next=JSON.parse(regular(join(source,'node_modules/next/package.json'),256*1024)).version;
 const typescript=JSON.parse(regular(join(source,'node_modules/typescript/package.json'),256*1024)).version;
 const runtime={node:process.versions.node,typescript,next,platform:process.platform,arch:process.arch};
 assert(process.platform==='linux'&&process.arch==='x64'&&process.versions.node==='22.23.3','Pinned hosted compiler tuple required');
 assert.equal(JSON.parse(regular(join(source,'tsconfig.json'),1024*1024)).compilerOptions.incremental,true);
 const generated=generatedTypes(source);
 const options=['--noEmit','--pretty','false','--extendedDiagnostics','--tsBuildInfoFile',CACHE_RELATIVE];
 const invoked={options,nodeOptions:'--max-old-space-size=8192',sourcePath:source,generatedTypes:generated,
  actualCompiler:Object.fromEntries(['package.json','lib/tsc.js','lib/_tsc.js','lib/typescript.js'].map(n=>[n,hash(regular(join(source,'node_modules/typescript',n),32*1024*1024))])),
  sourceInvocation:hash(regular(join(source,'.github/ci/typecheck.sh'),1024*1024)),
  mobileInputs:Object.fromEntries(['mobile/package.json','mobile/package-lock.json'].map(n=>[n,hash(regular(join(source,n),16*1024*1024))]))};
 const identity=compilerStateIdentity({source:e.AIHR_CI_HEAD,controller:originController(e),runId:originRun(e),attempt:'1',runtime,inputs:{
  tsconfig:hash(regular(join(source,'tsconfig.json'),1024*1024)),lockfile:hash(regular(join(source,'pnpm-lock.yaml'),16*1024*1024)),
  package:hash(regular(join(source,'package.json'),1024*1024)),workspace:hash(regular(join(source,'pnpm-workspace.yaml'),1024*1024)),
  nextConfig:hash(regular(join(source,'next.config.ts'),1024*1024)),compilerCli:hash(Buffer.from(JSON.stringify(invoked)))}});
 return {identity,invoked};
}
function createCache(source){
 let parent=source;
 for(const name of ['.next','cache']){parent=join(parent,name);if(!existsSync(parent))mkdirSync(parent,{mode:0o700});directory(parent);}
 const dir=join(parent,'compiler-transport');mkdirSync(dir,{mode:0o700});const pinned=directory(dir);
 return {dir,file:join(source,CACHE_RELATIVE),remove(){const now=directory(dir);assert(now.ino===pinned.ino&&now.dev===pinned.dev,'Owned compiler cache replaced');rmSync(dir,{recursive:true});}};
}
const runner=source=>({name:process.env.RUNNER_NAME,sourcePath:source,bootSha256:hash(readFileSync('/proc/sys/kernel/random/boot_id'))});
async function compile(source,cache,out,report,name,expectedErrorPath=null){
 const row={name,startedAt:new Date().toISOString(),expectedErrorPath,processExitCode:null};report.phases.push(row);
 const log=join(out,name+'.log');
 const args=['-v',process.execPath,join(source,'node_modules/typescript/lib/tsc.js'),'--noEmit','--pretty','false','--extendedDiagnostics','--tsBuildInfoFile',cache.file];
 const result=await measuredCommand('/usr/bin/time',args,{cwd:source,env:{...process.env,NODE_OPTIONS:'--max-old-space-size=8192'},log});
 Object.assign(row,result,{processExitCode:result.code,endedAt:new Date().toISOString()});
 const text=regular(log,MAX_LOG).toString('utf8');Object.assign(row,validateCompilerPhase(result,text,expectedErrorPath));
 const bytes=regular(cache.file,64*1024*1024);row.cache={bytes:bytes.length,sha256:hash(bytes)};
 return {row,bytes,text};
}
function validateCurrentRun(run,e){
 assert(run.id===Number(e.GITHUB_RUN_ID)&&run.run_attempt===1&&run.event==='workflow_dispatch'&&run.head_sha===e.AIHR_CI_CONTROL_HEAD
  &&run.path===WORKFLOW&&run.head_branch==='codex/test-suite-efficiency-review-20261025'&&run.repository?.full_name===REPO&&run.repository.id===1333414856,'Authenticated executing controller differs');
}
async function receive(source,out,identity,e,currentRunner){
 const run=api('actions/runs/'+originRun(e)),jobs=api('actions/runs/'+originRun(e)+'/attempts/1/jobs?per_page=100');
 assert(jobs.total_count===jobs.jobs.length&&jobs.jobs.length<100,'Complete bounded compiler jobs inventory required');
 const artifact=api('actions/artifacts/'+e.AIHR_COMPILER_ARTIFACT_ID),job=validateCompilerArtifact({run,jobs:jobs.jobs,artifact},e);
 const currentRun=api('actions/runs/'+e.GITHUB_RUN_ID);validateCurrentRun(currentRun,e);
 for(const [name,value]of Object.entries({run,jobs,artifact,currentRun}))save(join(out,name+'.json'),value);
 const zip=execFileSync('gh',['api','repos/'+REPO+'/actions/artifacts/'+artifact.id+'/zip'],{maxBuffer:MAX_ZIP,timeout:90000});
 assert(zip.length<=MAX_ZIP&&'sha256:'+hash(zip)===artifact.digest,'Compiler ZIP bytes differ');writeFileSync(join(out,'authenticated.zip'),zip,{flag:'wx',mode:0o600});
 const packet=join(out,'packet');execFileSync('python3',[join(CONTROLLER,'.github/ci/extract-artifact.py'),join(out,'authenticated.zip'),packet],{stdio:'inherit'});
 assert(isDeepStrictEqual(readdirSync(packet).sort(),MEMBERS),'Exact five JSON compiler members required');
 const bytes=regular(join(packet,'state.json'),64*1024*1024),envelope=JSON.parse(regular(join(packet,'envelope.json'),16*1024));
 const producer=JSON.parse(regular(join(packet,'producer.json'),1024*1024)),log=JSON.parse(regular(join(packet,'compiler-log.json'),32*1024*1024));
 const swap=JSON.parse(regular(join(packet,'swap-cleanup.json'),16*1024));
 assert(swap.kind==='OWNED_COMPILER_SWAP_CLEANUP'&&swap.runId===originRun(e)&&swap.attempt==='1'&&swap.mode==='--state-transport-producer'&&swap.swapAbsent===true&&swap.fileAbsent===true&&swap.originalCommandExit===0&&swap.cleanupExit===0,'Original compiler swap cleanup not verified');
 assert(producer.kind==='WHOLE_PROJECT_COMPILER_STATE_PRODUCER_NOT_RELEASE'&&producer.releaseAuthorized===false&&producer.exitCode===0
  &&producer.source===e.AIHR_CI_HEAD&&producer.controller===originController(e)&&producer.runId===originRun(e)&&producer.attempt==='1'
  &&producer.cacheRelative===CACHE_RELATIVE&&isDeepStrictEqual(producer.identity,identity)&&producer.phases.length===1
  &&producer.sourceRestored&&producer.controllerRestored&&producer.cacheRemoved,'Producer compiler evidence differs');
 assertIndependentCompilerVm(producer.runner,currentRunner);
 assert(log.kind==='RAW_WHOLE_PROJECT_COMPILER_OUTPUT'&&typeof log.text==='string'&&Buffer.byteLength(log.text)<=MAX_LOG
  &&hash(Buffer.from(log.text))===producer.compilerLogSha256,'Raw compiler log binding differs');
 const checked=validateCompilerPhase(producer.phases[0],log.text);assert.equal(checked.files,envelope.completed.files);
 assert(Date.parse(producer.phases[0].startedAt)>=Date.parse(job.started_at)&&Date.parse(producer.phases[0].endedAt)<=Date.parse(job.completed_at),'Compiler time outside original job');
 const snapshot=join(out,'snapshot');mkdirSync(snapshot,{mode:0o700});
 writeFileSync(join(snapshot,'provenance.json'),JSON.stringify(envelope)+'\n',{flag:'wx',mode:0o600});
 writeFileSync(join(snapshot,'whole-project.tsbuildinfo'),bytes,{flag:'wx',mode:0o600});
 const verified=readCompilerState(snapshot,identity);
 return {bytes:verified.bytes,envelope,producer,artifact:{id:artifact.id,digest:artifact.digest},snapshot};
}
export async function compilerTransport(mode){
 const e=process.env;assertCompilerTransportInvocation(e,mode);
 const source=realpathSync(process.cwd());sourceClean(source,e);
 const out=join(realpathSync(e.RUNNER_TEMP),'diagnostic-compiler-transport-'+mode);mkdirSync(out,{mode:0o700});
 const {identity,invoked}=context(source,e),currentRunner=runner(source),cache=createCache(source);
 const report={kind:mode==='producer'?'WHOLE_PROJECT_COMPILER_STATE_PRODUCER_NOT_RELEASE':'WHOLE_PROJECT_CROSS_VM_COMPILER_STATE_NOT_RELEASE',
  source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD,runId:e.GITHUB_RUN_ID,attempt:'1',identity,invoked,runner:currentRunner,cacheRelative:CACHE_RELATIVE,
  startedAt:new Date().toISOString(),cacheWasAbsent:!existsSync(cache.file),phases:[],exitCode:1,releaseAuthorized:false};
 let fixture=null,produced;
 try{
  assert(report.cacheWasAbsent,'Never merge an existing compiler state');
  if(mode==='producer'){
   produced=await compile(source,cache,out,report,'cold');report.compilerLogSha256=hash(Buffer.from(produced.text));
   sourceClean(source,e);
  }else{
   const started=Date.now(),origin=await receive(source,out,identity,e,currentRunner);report.restoreMs=Date.now()-started;
   report.originalArtifact=origin.artifact;report.producerRunner=origin.producer.runner;report.producerSource=identity.source;report.producerController=identity.controller;report.producerRunId=identity.runId;
   writeFileSync(cache.file,origin.bytes,{flag:'wx',mode:0o600});report.restoredStateSha256=hash(origin.bytes);
   const base=await compile(source,cache,out,report,'restored-on-fresh-vm');assert.equal(base.row.files,origin.envelope.completed.files,'Restored compiler omitted original files');
   sourceClean(source,e);
   const relative='aihr-compiler-transport-'+randomUUID();fixture=join(source,relative);mkdirSync(fixture,{mode:0o700});
   const contract=join(fixture,'contract.ts'),consumer=join(fixture,'consumer.ts'),valid='export const value: string = "fixture";\n',consumerBytes='import {value} from "./contract";\nexport const consumed: string = value;\n';
   writeFileSync(contract,valid,{flag:'wx'});writeFileSync(consumer,consumerBytes,{flag:'wx'});
   const added=await compile(source,cache,out,report,'added-valid-dependency');assert.equal(added.row.files,base.row.files+2);
   writeFileSync(contract,'export const value: number = 1;\n');assert.equal(readFileSync(consumer,'utf8'),consumerBytes);
   const transitive=await compile(source,cache,out,report,'changed-dependency-refused',relative+'/consumer.ts');assert.equal(transitive.row.files,added.row.files);
   writeFileSync(contract,valid);writeFileSync(join(fixture,'new-root.ts'),'export const invalid: string = 1;\n',{flag:'wx'});
   const newRoot=await compile(source,cache,out,report,'new-root-refused',relative+'/new-root.ts');assert.equal(newRoot.row.files,base.row.files+3);
   rmSync(fixture,{recursive:true});fixture=null;
   const restored=await compile(source,cache,out,report,'restored-source');assert.equal(restored.row.files,base.row.files);
   sourceClean(source,e);
  }
  report.exitCode=0;
 }catch(error){report.error=String(error);throw error;}
 finally{
  if(fixture){rmSync(fixture,{recursive:true});fixture=null;}
  report.fixtureRemoved=true;
  cache.remove();report.cacheRemoved=!existsSync(cache.dir);
  report.sourceRestored=git(source,'rev-parse','HEAD')===e.AIHR_CI_HEAD&&git(source,'status','--porcelain','--untracked-files=all')==='';
  report.controllerRestored=git(CONTROLLER,'rev-parse','HEAD')===e.AIHR_CI_CONTROL_HEAD&&git(CONTROLLER,'status','--porcelain','--untracked-files=all')==='';
  if(!report.sourceRestored||!report.controllerRestored||!report.cacheRemoved)report.exitCode=1;
  report.endedAt=new Date().toISOString();save(join(out,'comparison.json'),report);
 }
 assert.equal(report.exitCode,0,'Compiler transport or owned cleanup failed');
 if(mode==='producer'){
  const snapshot=join(out,'snapshot');mkdirSync(snapshot,{mode:0o700});
  const envelope=publishCompilerState(snapshot,produced.bytes,identity,{processExitCode:0,files:produced.row.files,completedAt:produced.row.endedAt});
  readCompilerState(snapshot,identity);
  report.compilerLogSha256=hash(Buffer.from(produced.text));
  const packet=join(realpathSync(e.RUNNER_TEMP),'diagnostic-compiler-state-packet');mkdirSync(packet,{mode:0o700});
  writeFileSync(join(packet,'state.json'),produced.bytes,{flag:'wx',mode:0o600});
  save(join(packet,'envelope.json'),envelope);save(join(packet,'producer.json'),report);
  save(join(packet,'compiler-log.json'),{kind:'RAW_WHOLE_PROJECT_COMPILER_OUTPUT',text:produced.text});
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))compilerTransport(process.argv[2]).then(v=>console.log(JSON.stringify(v))).catch(error=>{console.error(error);process.exitCode=1;});
