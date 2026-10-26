/** Normal canonical build with optional authenticated application graph input. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,realpathSync,existsSync,rmSync,statfsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {nextBuildContext,assertNextBuildSource} from './next-build-cache.mjs';
import {hash,assertNextAncestry,validateNextState} from './next-build-cache-policy.mjs';
import {NEXT_APPLICATION_STATE,NEXT_APPLICATION_MEMBERS,NEXT_APPLICATION_SEED,NEXT_APPLICATION_CODE,assertManagedNextInvocation,validateManagedNextOrigin,verifyNextPublisherTree,inspectNextStatePacket} from './next-application-cache-protocol.mjs';
import {measuredCommand} from './diagnostics/compiler-incremental.mjs';
import {cacheArtifactCandidates} from './cache-artifact-discovery.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const REPO='StradaverseHub/ai-hr';
const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const bounded=(path,max=4*1024**2)=>{const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size>0&&s.size<=max,'Bounded regular compiler evidence required');return readFileSync(path);};
const owned=path=>{const s=lstatSync(path);assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(path)===path&&s.uid===process.getuid(),'Owned real directory required');return s;};
const same=(path,before)=>{const now=owned(path);assert(now.ino===before.ino&&now.dev===before.dev,'Owned directory identity changed');};
function api(path,deadline){
 const left=deadline-Date.now();assert(left>0,'Application cache lookup budget exhausted');
 return JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+path],{encoding:'utf8',timeout:Math.min(3000,left),maxBuffer:8*1024**2}));
}
function codeIdentity(deadline){
 const remaining=deadline-Date.now();assert(remaining>0,'Publisher code lookup deadline');
 const blobs=execFileSync('git',['rev-parse',...NEXT_APPLICATION_CODE.map(path=>'HEAD:'+path)],{cwd:ROOT,encoding:'utf8',timeout:Math.min(5000,remaining)}).trim().split('\n');
 assert(blobs.length===NEXT_APPLICATION_CODE.length&&blobs.every(sha=>/^[a-f0-9]{40}$/.test(sha)),'Complete publisher Git blob identities required');
 return Object.fromEntries(NEXT_APPLICATION_CODE.map((path,index)=>[path,blobs[index]]));
}
function origins(e,report,deadline){
 try{
  const inventory=api('actions/artifacts?name='+encodeURIComponent(NEXT_APPLICATION_STATE)+'&per_page=3',deadline);
  return [...cacheArtifactCandidates(inventory,{name:NEXT_APPLICATION_STATE,currentRunId:e.GITHUB_RUN_ID}).map(pointer=>({kind:'normal',...pointer})),NEXT_APPLICATION_SEED];
 }catch(error){report.lookup.push({discoveryError:String(error)});return [NEXT_APPLICATION_SEED];}
}
export function restoreManagedNextState({source,out,e,context,report}){
 const deadline=Date.now()+20000;
 for(const selected of origins(e,report,deadline)){
  if(Date.now()>=deadline){report.lookup.push({error:'Lookup budget exhausted; canonical build runs cold'});break;}
  const observation={kind:selected.kind,runId:selected.runId};report.lookup.push(observation);
  try{
   const origin=selected.kind==='seed'?NEXT_APPLICATION_SEED:{kind:'normal',runId:selected.runId};
   const run=selected.listed??api('actions/runs/'+origin.runId,deadline);
   const jobs=api('actions/runs/'+origin.runId+'/attempts/1/jobs?per_page=100',deadline);
   let artifact;
   if(origin.kind==='seed')artifact=api('actions/artifacts/'+origin.artifactId,deadline);
   else{
    const artifacts=api('actions/runs/'+origin.runId+'/artifacts?per_page=100',deadline);
    assert(artifacts.total_count===artifacts.artifacts.length&&artifacts.artifacts.length<100,'Complete bounded application artifact inventory');
    const matches=artifacts.artifacts.filter(a=>a.name===NEXT_APPLICATION_STATE);assert(matches.length===1,'Unique application state artifact required');artifact=matches[0];
   }
   if(selected.discoveryArtifactId!==undefined)assert(artifact.id===selected.discoveryArtifactId,'Application graph discovery pointer differs');
   const job=validateManagedNextOrigin(origin,run,jobs,artifact);
   let tree,expected;
   if(origin.kind==='normal'){
    tree=api('git/trees/'+run.head_sha+'?recursive=1',deadline);expected=codeIdentity(deadline);verifyNextPublisherTree(tree,expected);observation.actualPublisherCodeVerified=true;
   }
   // The sole bootstrap exception is pinned to an independently verified real
   // controller/run/artifact/state tuple, never an arbitrary old implementation.
   const left=deadline-Date.now();assert(left>0,'Application artifact transfer deadline');
   const zip=execFileSync('gh',['api','repos/'+REPO+'/actions/artifacts/'+artifact.id+'/zip'],{timeout:Math.min(left,8000),maxBuffer:64*1024**2});
   assert(zip.length===artifact.size_in_bytes&&'sha256:'+hash(zip)===artifact.digest,'Application ZIP digest/size differs');
   const originDir=join(out,'origin-'+origin.kind+'-'+origin.runId);mkdirSync(originDir,{mode:0o700});
   writeFileSync(join(originDir,'authenticated.zip'),zip,{flag:'wx',mode:0o600});
   for(const [name,value]of Object.entries({run,jobs,artifact,...(tree?{tree,expected}: {})}))save(join(originDir,name+'.json'),value);
   const packet=join(originDir,'packet');const extractionLeft=deadline-Date.now();assert(extractionLeft>0,'Application extraction deadline');execFileSync('python3',[join(ROOT,'.github/ci/extract-artifact.py'),join(originDir,'authenticated.zip'),packet],{timeout:Math.min(5000,extractionLeft),stdio:'pipe'});
   assert(isDeepStrictEqual(readdirSync(packet).sort(),NEXT_APPLICATION_MEMBERS),'Exact application state packet');
   const files=new Map(NEXT_APPLICATION_MEMBERS.map(name=>[name,bounded(join(packet,name),name==='state.json'?64*1024**2:8*1024**2)]));
   const verified=inspectNextStatePacket({files,run,job,seed:origin.kind==='seed',currentContext:context});
   const comparison=verified.producer.source===e.AIHR_CI_HEAD?null:api('compare/'+verified.producer.source+'...'+e.AIHR_CI_HEAD+'?per_page=100',deadline);
   const changedFiles=assertNextAncestry(verified.producer.source,e.AIHR_CI_HEAD,comparison);save(join(originDir,'comparison.json'),comparison);
   assert(Date.now()<=deadline,'Application lookup deadline exceeded during local validation');
   observation.accepted=true;
   return {bytes:verified.bytes,origin:{kind:origin.kind,source:verified.producer.source,controller:run.head_sha,runId:run.id,artifactId:artifact.id,artifactDigest:artifact.digest,
    stateSha256:hash(verified.bytes),nextBuildId:verified.build.nextBuildId,buildRecordId:verified.build.buildRecordId},changedFiles};
  }catch(error){observation.error=String(error);}
 }
 return null;
}
export async function managedApplicationBuild(){
 const e=process.env,event=e.GITHUB_EVENT_PATH?JSON.parse(readFileSync(e.GITHUB_EVENT_PATH,'utf8')):{};
 const admission=assertManagedNextInvocation(e,event),source=realpathSync(process.cwd());
 assertNextBuildSource(source,e);
 const temp=realpathSync(e.RUNNER_TEMP),out=join(temp,'normal-next-application-cache'),output=join(temp,'production-build');
 mkdirSync(out,{mode:0o700});
 const graph=join(source,'.next/cache/.tsbuildinfo'),recordDir=join(homedir(),'.aihr-system-testing-builds');
 assert(!existsSync(join(source,'.next/BUILD_ID'))&&!existsSync(graph)&&!existsSync(recordDir),'Fresh build, compiler graph and owned-record namespace required');
 assert(lstatSync('/usr/bin/prlimit').isFile(),'Bounded Linux canonical build required');
 const report={kind:'CANONICAL_CI_APPLICATION_COMPILER_STATE_NOT_RELEASE',releaseAuthorized:false,source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD,
  runId:e.GITHUB_RUN_ID,attempt:'1',startedAt:new Date().toISOString(),cachePublishPermitted:admission.publish,lookup:[],phases:[],diskSamples:[],
  cacheHit:false,exitCode:1,capacityProfile:e.AIHR_CI_CAPACITY_PROFILE,buildOutputRetainedForOptionalCompilerCache:true};
 let timer,recordIdentity,nextIdentity,stateBytes,envelope,logText,build,context;
 const sample=label=>{
  const volumes=[source,temp,homedir()].map(path=>{const s=statfsSync(path);return {path,availableBytes:s.bavail*s.bsize};});
  assert(volumes.every(v=>Number.isSafeInteger(v.availableBytes)&&v.availableBytes>=0),'Actual filesystem sample required');
  report.diskSamples.push({label,at:new Date().toISOString(),volumes});return Math.min(...volumes.map(v=>v.availableBytes));
 };
 const command=async(name,bin,args,timeoutMs)=>{
  const row={name,startedAt:new Date().toISOString()};report.phases.push(row);
  const log=join(out,name+'.log');
  Object.assign(row,await measuredCommand('/usr/bin/time',['-v','/usr/bin/prlimit','--fsize=1073741824','--',bin,...args],{cwd:source,env:e,log,timeoutMs}),{endedAt:new Date().toISOString()});
  const text=bounded(log).toString('utf8');
  assert(row.code===0&&row.signal===null&&!row.timedOut,'Actual '+name+' failed');
  return {row,text};
 };
 try{
  assert(sample('before')>=8*1024**3,'At least8GiB post-dependency build headroom');
  timer=setInterval(()=>{try{sample('during');}catch(error){report.diskSamplingError=String(error);}},5000);
  // Real generated types are part of applicability, not a substitute for compilation.
  await command('application-typegen','pnpm',['exec','next','typegen'],120000);
  nextIdentity=owned(join(source,'.next'));
  try{context=nextBuildContext(source);}catch(error){report.unsupportedCacheContext=String(error);}
  if(context){
   report.context=context;
   const start=Date.now(),restored=restoreManagedNextState({source,out,e,context,report});report.restoreMs=Date.now()-start;
   if(restored){
    const cache=join(source,'.next/cache');if(!existsSync(cache))mkdirSync(cache,{mode:0o700});owned(cache);
    writeFileSync(graph,restored.bytes,{flag:'wx',mode:0o600});report.cacheHit=true;report.origin=restored.origin;report.changedFiles=restored.changedFiles;
   }else assert(!existsSync(graph),'Cold fallback must begin without application graph');
  }
  assertNextBuildSource(source,e);
  const actual=await command('canonical-build','pnpm',['exec','tsx',join(ROOT,'.github/ci/build-production.mjs'),'--ci',output],720000);
  report.actualCanonicalBuild=actual.row;logText=actual.text;
  assert(/\bCompiled successfully in /.test(logText)&&/Finished TypeScript in /.test(logText)
   &&!/Skipping validation of types|Finished TypeScript config validation|\berror TS\d+:/.test(logText),'Actual canonical application compiler must run');
  report.buildLogSha256=hash(Buffer.from(logText));recordIdentity=owned(recordDir);
  build=JSON.parse(bounded(join(output,'build-provenance.json')));
  const prepared=JSON.parse(bounded(join(output,'system-testing.json'))),config=JSON.parse(bounded(join(source,'.next/required-server-files.json')));
  const imported=await import(pathToFileURL(join(source,'scripts/improve/system-testing-manifest.ts')).href),testing={...(imported.default??{}),...imported};
  for(const [key,value]of Object.entries(testing.systemTestingCompileEnvironment(prepared)))assert(config.config?.env?.[key]===value,'Fresh compiled System Testing identity differs');
  assert(config.config.typescript.ignoreBuildErrors!==true&&config.config.experimental.useTypeScriptCli===true&&config.config.typescript.tsconfigPath==='tsconfig.build.json','Production application compiler contract differs');
  if(report.origin)assert(build.nextBuildId!==report.origin.nextBuildId&&build.buildRecordId!==report.origin.buildRecordId,'A new build and owned record remain mandatory');
  if(context){
   assert(isDeepStrictEqual(nextBuildContext(source),context),'Application compiler context changed during build');
   stateBytes=bounded(graph,64*1024**2);const state=JSON.parse(stateBytes);
   envelope={kind:'NEXT_APPLICATION_COMPILER_STATE_BUILD_MUST_RUN',releaseAuthorized:false,source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD,runId:e.GITHUB_RUN_ID,attempt:'1',context,
    completedCommand:'canonical-build',completedCommandExit:0,completedAt:actual.row.endedAt,bytes:stateBytes.length,sha256:hash(stateBytes),files:state.fileNames.length,nextBuildId:build.nextBuildId,buildRecordId:build.buildRecordId};
   validateNextState(stateBytes,envelope,e.AIHR_CI_HEAD,context);report.graph={files:state.fileNames.length,bytes:stateBytes.length,sha256:hash(stateBytes)};
  }
  assertNextBuildSource(source,e);report.exitCode=0;
 }catch(error){report.error=String(error);console.error(error);throw error;}
 finally{
  clearInterval(timer);
  try{sample('after');}catch(error){report.diskSamplingError=String(error);report.exitCode=1;}
  if(existsSync(recordDir)){if(recordIdentity)same(recordDir,recordIdentity);else owned(recordDir);rmSync(recordDir,{recursive:true});}
  report.ownedRecordsRemoved=!existsSync(recordDir);
  if(existsSync(graph)){const s=lstatSync(graph);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'Owned regular application graph cleanup');rmSync(graph);}
  report.workingStateRemoved=!existsSync(graph);
  if(nextIdentity)same(join(source,'.next'),nextIdentity);
  try{assertNextBuildSource(source,e);report.sourceRestored=true;report.controllerRestored=true;}catch(error){report.cleanupError=String(error);report.exitCode=1;}
  if(report.diskSamplingError||report.diskSamples.length===0||Math.min(...report.diskSamples.flatMap(s=>s.volumes.map(v=>v.availableBytes)))<2*1024**3)report.exitCode=1;
  report.endedAt=new Date().toISOString();save(join(out,'comparison.json'),report);
 }
 assert(report.exitCode===0,'Canonical build or owned cleanup failed');
 if(admission.publish&&stateBytes){
  const packet=join(temp,'next-application-state-packet');mkdirSync(packet,{mode:0o700});
  writeFileSync(join(packet,'state.json'),stateBytes,{flag:'wx',mode:0o600});save(join(packet,'envelope.json'),envelope);save(join(packet,'producer.json'),report);save(join(packet,'build-log.json'),{kind:'RAW_CANONICAL_NEXT_BUILD_OUTPUT',text:logText});
  for(const name of ['build-provenance.json','system-testing.json','successful-build.json'])writeFileSync(join(packet,name),bounded(join(output,name)),{flag:'wx',mode:0o600});
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))managedApplicationBuild().then(v=>console.log(JSON.stringify(v))).catch(error=>{console.error(error);process.exitCode=1;});
