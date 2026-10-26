/** Real canonical application build, authenticated graph transport and actual Next error refusal. Never release authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,realpathSync,existsSync,rmSync,statfsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {NEXT_STATE_NAME,NEXT_STATE_MEMBERS,hash,assertNextCacheInvocation,parseNextCacheOrigin,validateNextOrigin,validateNextContext,validateNextState,assertNextAncestry} from './next-build-cache-policy.mjs';
import {measuredCommand} from './diagnostics/compiler-incremental.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:4*1024**2}).trim();
const api=p=>JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/'+p],{timeout:3000,maxBuffer:8*1024**2,encoding:'utf8'}));
function regular(p,max=32*1024**2){const s=lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=max);return readFileSync(p);}
function owned(p){const s=lstatSync(p);assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(p)===p&&s.uid===process.getuid());return s;}
function unchanged(source,e){assert(git(source,'rev-parse','HEAD')===e.AIHR_CI_HEAD&&git(ROOT,'rev-parse','HEAD')===e.AIHR_CI_CONTROL_HEAD
 &&git(source,'status','--porcelain','--untracked-files=all')===''&&git(ROOT,'status','--porcelain','--untracked-files=all')==='','Exact clean application source/controller required');}
const CODE=['.github/ci/next-build-cache.mjs','.github/ci/next-build-cache-policy.mjs','.github/ci/next-app-typecheck-probe.mjs','.github/ci/build-production.mjs','.github/ci/build-bundle.py','.github/ci/runner-capacity.mjs','.github/ci/prepare-runner.sh','.github/ci/extract-artifact.py','.github/ci/diagnostics/compiler-incremental.mjs','.github/actions/setup-alpha/action.yml','.github/workflows/alpha-staging-diagnostics.yml'];
function context(source){
 const root=JSON.parse(regular(join(source,'tsconfig.json'))),build=JSON.parse(regular(join(source,'tsconfig.build.json')));
 assert(root.compilerOptions?.incremental===true&&root.extends===undefined&&root.references===undefined&&build.extends==='./tsconfig.json'&&build.references===undefined,'Reviewed exact application config chain required');
 const generated=[],base=join(source,'.next/types');
 function walk(p){owned(p);for(const name of readdirSync(p).sort()){const f=join(p,name),s=lstatSync(f);assert(!s.isSymbolicLink());if(s.isDirectory())walk(f);else generated.push({path:f.slice(base.length+1),bytes:s.size,sha256:hash(regular(f))});}}
 walk(base);
 const inputs=Object.fromEntries(['tsconfig.json','tsconfig.build.json','pnpm-lock.yaml','package.json','pnpm-workspace.yaml','next.config.ts','deploy/css-cache-guard.sh'].map(p=>[p,hash(regular(join(source,p)))]));
 inputs.cssInputs=execFileSync('bash',['-c','. deploy/css-cache-guard.sh; aihr_css_inputs_hash'],{cwd:source,encoding:'utf8',timeout:15000}).trim();
 const runtime={node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next:JSON.parse(regular(join(source,'node_modules/next/package.json'))).version,typescript:JSON.parse(regular(join(source,'node_modules/typescript/package.json'))).version};
 const compiler=Object.fromEntries(['typescript/package.json','typescript/lib/tsc.js','typescript/lib/_tsc.js','typescript/lib/typescript.js','next/dist/lib/typescript/runTypeCheckCli.js','next/dist/lib/typescript/runTypeScriptCli.js','next/dist/lib/typescript/runTypeCheck.js','next/dist/build/type-check.js'].map(p=>[p,hash(regular(join(source,'node_modules',p)))]));
 return validateNextContext({runtime,sourcePath:source,nodeOptions:process.env.NODE_OPTIONS,inputs,compiler,generatedTypes:generated});
}
function restore(source,out,e,c,currentRunner){
 const origin=parseNextCacheOrigin(e.AIHR_NEXT_BUILD_ORIGIN);assert(String(origin.runId)!==e.GITHUB_RUN_ID,'Original successful run must be separate');
 const run=api('actions/runs/'+origin.runId),jobs=api('actions/runs/'+origin.runId+'/attempts/1/jobs?per_page=100'),artifact=api('actions/artifacts/'+origin.artifactId);
 const job=validateNextOrigin(origin,run,jobs,artifact);
 const tree=api('git/trees/'+origin.sha+'?recursive=1');assert(tree.truncated===false);
 const expected=Object.fromEntries(CODE.map(p=>[p,git(ROOT,'rev-parse','HEAD:'+p)]));
 const entries=new Map(tree.tree.filter(t=>t.type==='blob').map(t=>[t.path,t.sha]));
 for(const [p,sha]of Object.entries(expected))assert(entries.get(p)===sha,'Original actual controller code differs: '+p);
 const bytes=execFileSync('gh',['api','repos/StradaverseHub/ai-hr/actions/artifacts/'+origin.artifactId+'/zip'],{timeout:10000,maxBuffer:64*1024**2});
 assert(bytes.length===artifact.size_in_bytes&&hash(bytes)===origin.digest);
 const dir=join(out,'origin');mkdirSync(dir,{mode:0o700});writeFileSync(join(dir,'authenticated.zip'),bytes,{flag:'wx',mode:0o600});
 for(const [n,v]of Object.entries({run,jobs,artifact,tree,expected}))save(join(dir,n+'.json'),v);
 execFileSync('python3',[join(ROOT,'.github/ci/extract-artifact.py'),join(dir,'authenticated.zip'),join(dir,'packet')],{timeout:15000,stdio:'inherit'});
 const p=join(dir,'packet');assert(isDeepStrictEqual(readdirSync(p).sort(),NEXT_STATE_MEMBERS));
 const read=n=>JSON.parse(regular(join(p,n)));
 const envelope=read('envelope.json'),old=read('producer.json'),build=read('build-provenance.json'),prepared=read('system-testing.json'),successful=read('successful-build.json'),log=read('build-log.json');
 assert(old.exitCode===0&&old.sourceRestored&&old.controllerRestored&&old.ownedBuildRemoved&&old.ownedRecordsRemoved&&old.source===origin.sha&&old.controller===origin.sha&&old.runId===String(origin.runId)&&old.actualCanonicalBuild.code===0
  &&old.kind==='ACTUAL_NEXT_BUILD_CACHE_DIAGNOSTIC_NOT_RELEASE'&&old.releaseAuthorized===false,'Original completed command and cleanup required');
 assert(old.runner.name!==currentRunner.name&&old.runner.bootSha256!==currentRunner.bootSha256&&old.runner.sourcePath===currentRunner.sourcePath,'Fresh VM at the same application path required');
 assert(build.kind==='diagnostic-system-testing-build-not-release'&&build.releaseAuthorized===false&&build.source===origin.sha&&build.controller===origin.sha&&build.runId===Number(origin.runId)&&build.runAttempt===1
  &&build.preparedSha256===hash(regular(join(p,'system-testing.json')))&&build.successfulObservationSha256===hash(regular(join(p,'successful-build.json'))),'Original canonical build bytes differ');
 assert(isDeepStrictEqual(prepared.identity,successful.identity)&&prepared.identity.sourceRef===origin.sha&&successful.nextBuildId===build.nextBuildId&&successful.preparedRecordSha256===build.preparedSha256
  &&successful.kind==='successful-system-testing-build'&&successful.activeServiceVerified===false&&successful.manualExecutionVerified===false,'Actual successful build identity differs');
 assert(log.kind==='RAW_CANONICAL_NEXT_BUILD_OUTPUT'&&hash(Buffer.from(log.text))===old.buildLogSha256&&/\bCompiled successfully in /.test(log.text)&&/Finished TypeScript in /.test(log.text)&&!/Skipping validation of types|Finished TypeScript config validation|\berror TS\d+:/.test(log.text),'Actual canonical compiler/build output required');
 assert(Date.parse(old.actualCanonicalBuild.startedAt)>=Date.parse(job.started_at)&&Date.parse(old.actualCanonicalBuild.endedAt)<=Date.parse(job.completed_at),'Original build outside job');
 assert(envelope.controller===origin.sha&&envelope.runId===String(origin.runId)&&envelope.nextBuildId===build.nextBuildId&&envelope.buildRecordId===build.buildRecordId);
 const comparison=origin.sha===e.AIHR_CI_HEAD?null:api('compare/'+origin.sha+'...'+e.AIHR_CI_HEAD+'?per_page=100');
 const changedFiles=assertNextAncestry(origin.sha,e.AIHR_CI_HEAD,comparison);save(join(dir,'comparison.json'),comparison);
 const state=regular(join(p,'state.json'),64*1024**2);validateNextState(state,envelope,origin.sha,c);
 const cache=join(source,'.next/cache');if(!existsSync(cache))mkdirSync(cache,{mode:0o700});owned(cache);assert(!existsSync(join(cache,'.tsbuildinfo')));
 writeFileSync(join(cache,'.tsbuildinfo'),state,{flag:'wx',mode:0o600});
 return {origin,oldBuildId:build.nextBuildId,oldBuildRecordId:build.buildRecordId,originalStateSha256:hash(state),changedFiles,originalRunner:old.runner,mandatoryCanonicalBuild:true,releaseAuthorized:false};
}
async function main(){
 const e=process.env;assertNextCacheInvocation(e);
 assert(e.AIHR_CI_CAPACITY_PROFILE==='bounded-next-build-diagnostic');
 const source=realpathSync(process.cwd()),out=join(realpathSync(e.RUNNER_TEMP),'diagnostic-next-build-cache'),packet=join(realpathSync(e.RUNNER_TEMP),'next-app-state-packet');
 unchanged(source,e);assert(!existsSync(join(source,'.next/BUILD_ID'))&&!existsSync(join(source,'.next/cache/.tsbuildinfo')),'Fresh build and graph absence required');
 mkdirSync(out,{mode:0o700});
 const nextDir=join(source,'.next'),nextIdentity=owned(nextDir),recordDir=join(homedir(),'.aihr-system-testing-builds');assert(!existsSync(recordDir),'Fresh private record namespace required');
 const runner={name:e.RUNNER_NAME,bootSha256:hash(readFileSync('/proc/sys/kernel/random/boot_id')),sourcePath:source};
 const report={kind:'ACTUAL_NEXT_BUILD_CACHE_DIAGNOSTIC_NOT_RELEASE',source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD,runId:e.GITHUB_RUN_ID,attempt:'1',mode:e.AIHR_NEXT_BUILD_CACHE_MODE,runner,startedAt:new Date().toISOString(),phases:[],diskSamples:[],exitCode:1,releaseAuthorized:false};
 let timer,fixture,recordIdentity,buildResult,stateBytes,stateEnvelope,buildLog;
 const sample=label=>{const volumes=[source,e.RUNNER_TEMP,homedir()].map(p=>{const s=statfsSync(p);return {path:p,availableBytes:s.bavail*s.bsize,totalBytes:s.blocks*s.bsize};});assert(volumes.every(v=>Number.isSafeInteger(v.availableBytes)&&v.availableBytes>=0));
  report.diskSamples.push({label,at:new Date().toISOString(),volumes});return Math.min(...volumes.map(v=>v.availableBytes));};
 const command=async(name,bin,args,timeoutMs)=>{const row={name,startedAt:new Date().toISOString()};report.phases.push(row);const log=join(out,name+'.log');Object.assign(row,await measuredCommand('/usr/bin/time',['-v','/usr/bin/prlimit','--fsize=1073741824','--',bin,...args],{cwd:source,env:e,log,timeoutMs}),{endedAt:new Date().toISOString()});return {row,text:regular(log,4*1024**2).toString('utf8')};};
 try{
  assert(sample('before')>=8*1024**3,'At least8GiB actual pre-build headroom required');timer=setInterval(()=>{try{sample('during');}catch(error){report.diskSamplingError=String(error);}},5000);
  const c=context(source);report.context=c;
  if(e.AIHR_NEXT_BUILD_CACHE_MODE==='warm'){const started=Date.now();report.restored=restore(source,out,e,c,runner);report.restoreMs=Date.now()-started;}
  else assert(!e.AIHR_NEXT_BUILD_ORIGIN,'Cold phase cannot select an origin');
  report.graphAbsentBeforeCold=!existsSync(join(source,'.next/cache/.tsbuildinfo'));
  assert(report.mode==='warm'?!report.graphAbsentBeforeCold:report.graphAbsentBeforeCold);
  const output=join(out,'canonical-build');
  const result=await command('canonical-build','pnpm',['exec','tsx',join(ROOT,'.github/ci/build-production.mjs'),'--diagnostic',output],660000);
  report.actualCanonicalBuild=result.row;buildLog=result.text;
  assert(result.row.code===0&&result.row.signal===null&&!result.row.timedOut,'Actual canonical build failed');
  assert(/\bCompiled successfully in /.test(buildLog)&&/Finished TypeScript in /.test(buildLog)&&!/Skipping validation of types|Finished TypeScript config validation|\berror TS\d+:/.test(buildLog),'Required production compiler did not run successfully');
  report.buildLogSha256=hash(Buffer.from(buildLog));
  recordIdentity=owned(recordDir);
  buildResult=JSON.parse(regular(join(output,'build-provenance.json')));
  const prepared=JSON.parse(regular(join(output,'system-testing.json'))),config=JSON.parse(regular(join(source,'.next/required-server-files.json')));
  const imported=await import(pathToFileURL(join(source,'scripts/improve/system-testing-manifest.ts')).href),testing={...(imported.default??{}),...imported};
  for(const [k,v]of Object.entries(testing.systemTestingCompileEnvironment(prepared)))assert(config.config.env[k]===v,'Fresh compiled System Testing identity differs');
  assert(config.config.typescript.ignoreBuildErrors!==true&&config.config.experimental.useTypeScriptCli===true&&config.config.typescript.tsconfigPath==='tsconfig.build.json');
  if(report.restored)assert(buildResult.nextBuildId!==report.restored.oldBuildId&&buildResult.buildRecordId!==report.restored.oldBuildRecordId,'A fresh build/owned record is mandatory after restore');
  assert(isDeepStrictEqual(context(source),c),'Compiler generated/config inputs changed during canonical build');
  stateBytes=regular(join(source,'.next/cache/.tsbuildinfo'),64*1024**2);const state=JSON.parse(stateBytes);
  stateEnvelope={kind:'NEXT_APPLICATION_COMPILER_STATE_BUILD_MUST_RUN',source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD,runId:e.GITHUB_RUN_ID,attempt:'1',context:c,actualCanonicalBuildExit:0,completedAt:result.row.endedAt,bytes:stateBytes.length,sha256:hash(stateBytes),files:state.fileNames.length,nextBuildId:buildResult.nextBuildId,buildRecordId:buildResult.buildRecordId,releaseAuthorized:false};
  validateNextState(stateBytes,stateEnvelope,e.AIHR_CI_HEAD,c);report.graph={files:state.fileNames.length,bytes:stateBytes.length,sha256:hash(stateBytes)};
  if(report.mode==='warm'){
   fixture=join(source,'lib/aihr-next-cache-control-'+randomUUID());mkdirSync(fixture,{mode:0o700});const rel=fixture.slice(source.length+1);
   const contract=join(fixture,'contract.ts'),consumer=join(fixture,'consumer.ts'),valid='export const value: string = "fixture";\n',consumerText='import {value} from "./contract";\nexport const consumed: string = value;\n';
   writeFileSync(contract,valid,{flag:'wx'});writeFileSync(consumer,consumerText,{flag:'wx'});
   const control=async(name,errorPath,expectedFiles)=>{const p=await command(name,process.execPath,[join(ROOT,'.github/ci/next-app-typecheck-probe.mjs')],180000);
    assert(!p.row.timedOut&&p.row.signal===null);const errors=[...p.text.matchAll(/^([^\r\n]+)\(\d+,\d+\): error TS(\d+):[^\r\n]*$/gm)];
    assert.equal([...p.text.matchAll(/\berror TS\d+:/g)].length,errors.length);
    if(errorPath){assert(p.row.code===1&&errors.length===1&&errors[0][1]===errorPath&&errors[0][2]==='2322','Exact actual Next type-error refusal required');}
    else assert(p.row.code===0&&errors.length===0&&p.text.includes('ACTUAL_NEXT_APPLICATION_TYPECHECK_COMPLETED'));
    const graph=JSON.parse(regular(join(source,'.next/cache/.tsbuildinfo'),64*1024**2));assert(graph.fileNames.length===expectedFiles,'Application graph omitted or retained unexpected roots');p.row.files=graph.fileNames.length;p.row.expectedErrorPath=errorPath;};
   await control('added-valid-dependency',null,state.fileNames.length+2);
   writeFileSync(contract,'export const value: number = 1;\n');assert(readFileSync(consumer,'utf8')===consumerText);
   await control('unchanged-consumer-type-error',rel+'/consumer.ts',state.fileNames.length+2);
   writeFileSync(contract,valid);writeFileSync(join(fixture,'new-root.ts'),'export const invalid: string = 1;\n',{flag:'wx'});
   await control('new-root-type-error',rel+'/new-root.ts',state.fileNames.length+3);
   rmSync(fixture,{recursive:true});fixture=null;
   await control('restored-application-source',null,state.fileNames.length);
  }
  unchanged(source,e);report.exitCode=0;
 }catch(error){report.error=String(error);console.error(error);throw error;}
 finally{
  clearInterval(timer);sample('after');
  if(fixture){const s=owned(fixture);assert(s.uid===process.getuid());rmSync(fixture,{recursive:true});}
  if(existsSync(recordDir)){const s=owned(recordDir);assert(!recordIdentity||(s.ino===recordIdentity.ino&&s.dev===recordIdentity.dev));rmSync(recordDir,{recursive:true});}
  const now=owned(nextDir);assert(now.ino===nextIdentity.ino&&now.dev===nextIdentity.dev);rmSync(nextDir,{recursive:true});
  report.ownedBuildRemoved=!existsSync(nextDir);report.ownedRecordsRemoved=!existsSync(recordDir);
  try{unchanged(source,e);report.sourceRestored=true;report.controllerRestored=true;}catch(error){report.cleanupError=String(error);report.exitCode=1;}
  if(report.diskSamplingError||Math.min(...report.diskSamples.flatMap(s=>s.volumes.map(v=>v.availableBytes)))<2*1024**3){report.diskFloorFailed=true;report.exitCode=1;}
  report.endedAt=new Date().toISOString();save(join(out,'comparison.json'),report);
 }
 assert(report.exitCode===0);
 mkdirSync(packet,{mode:0o700});
 writeFileSync(join(packet,'state.json'),stateBytes,{flag:'wx',mode:0o600});save(join(packet,'envelope.json'),stateEnvelope);save(join(packet,'producer.json'),report);save(join(packet,'build-log.json'),{kind:'RAW_CANONICAL_NEXT_BUILD_OUTPUT',text:buildLog});
 for(const name of ['build-provenance.json','system-testing.json','successful-build.json'])writeFileSync(join(packet,name),regular(join(out,'canonical-build',name)),{flag:'wx',mode:0o600});
 rmSync(join(out,'canonical-build/bytes/build-bundle.tar.gz'));
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(v=>console.log(JSON.stringify(v))).catch(error=>{console.error(error);process.exitCode=1;});
