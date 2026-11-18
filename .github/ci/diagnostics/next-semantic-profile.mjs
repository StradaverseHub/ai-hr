/** Frozen-origin ONE semantic profile. Trace overhead and partial failures never authorize a release. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,lstatSync,readdirSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {admitBuildHeap,BUILD_HEAP_NODE_OPTIONS} from '../build-heap.mjs';

const ORIGIN='56a33b3eee49a28125eaaed9a7836a308873f417';
const WORKFLOW='StradaverseHub/ai-hr/.github/workflows/next-semantic-profile.yml@refs/heads/codex/resignation-next-semantic-profile-20261118';
const controller=realpathSync(fileURLToPath(new URL('../../../',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(dir,...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',timeout:10000,maxBuffer:8*1024**2}).trim();
const put=(path,value)=>writeFileSync(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const source=realpathSync(process.cwd()),env=process.env;
assert(process.platform==='linux'&&env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856');
assert(['workflow_dispatch','push'].includes(env.GITHUB_EVENT_NAME)&&env.GITHUB_WORKFLOW_REF===WORKFLOW&&env.GITHUB_JOB==='inventory');
assert(env.GITHUB_WORKFLOW==='next-semantic-profile'&&env.AIHR_DIAG_SOURCE_SHA===ORIGIN);
assert(/^[a-f0-9]{40}$/.test(env.AIHR_DIAG_CONTROLLER_SHA??'')&&env.GITHUB_SHA===env.AIHR_DIAG_CONTROLLER_SHA&&env.AIHR_CI_CONTROL_HEAD===env.AIHR_DIAG_CONTROLLER_SHA);
assert(git(source,'rev-parse','HEAD')===ORIGIN&&git(controller,'rev-parse','HEAD')===env.AIHR_DIAG_CONTROLLER_SHA);
git(controller,'merge-base','--is-ancestor',ORIGIN,env.AIHR_DIAG_CONTROLLER_SHA);
assert.deepStrictEqual(git(controller,'diff','--name-only',ORIGIN,env.AIHR_DIAG_CONTROLLER_SHA).split('\n'),[
  '.github/ci/diagnostics/next-semantic-profile.mjs','.github/workflows/next-semantic-profile.yml',
],'Diagnostic controller may differ from origin only in its two reviewed files');
assert(git(source,'status','--porcelain','--untracked-files=all')===''&&git(controller,'status','--porcelain','--untracked-files=all')==='');
assert(source===join(realpathSync(env.GITHUB_WORKSPACE),'source')&&controller===join(realpathSync(env.GITHUB_WORKSPACE),'automation'));
const event=JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
assert(!event.pull_request&&event.repository?.full_name===env.GITHUB_REPOSITORY&&event.repository?.id===1333414856);
if(env.GITHUB_EVENT_NAME==='workflow_dispatch')assert(event.inputs?.source_sha===ORIGIN&&event.inputs?.controller_sha===env.AIHR_DIAG_CONTROLLER_SHA);
else assert(event.ref==='refs/heads/codex/resignation-next-semantic-profile-20261118'&&event.after===env.AIHR_DIAG_CONTROLLER_SHA&&event.deleted!==true);
assert(!existsSync(join(source,'.next')),'Cold generated types/cache required');
assert(!Object.keys(env).some(key=>(key.startsWith('AIHR_SYSTEM_TESTING_')||key.startsWith('AIHR_NEXT_BUILD_')||key==='AUTH_SESSION_KEY'||key==='MIGRATION_DATABASE_URL')&&env[key]));

const temp=realpathSync(env.RUNNER_TEMP),out=resolve(process.argv[2]??'');
assert(out===join(temp,'next-semantic-profile-56a')&&!existsSync(out));
mkdirSync(out,{mode:0o700});
const admission=admitBuildHeap({...env,AIHR_CI_BUILD_HEAP_MB:'8192'},readFileSync('/proc/meminfo','utf8'));
assert(readFileSync(join(source,'.github/ci/build-heap.mjs')).equals(readFileSync(join(controller,'.github/ci/build-heap.mjs'))),'Original memory guard bytes must be unchanged');
const closed='postgres://ai_hr_app@127.0.0.1:1/no_database';
const childEnv={...env,NODE_ENV:'production',NODE_OPTIONS:BUILD_HEAP_NODE_OPTIONS,AIHR_CI_HEAD:ORIGIN,
  AIHR_CI_BUILD_HEAP_PROFILE:admission.profile,AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:String(admission.memTotalKiB),
  NEXT_TELEMETRY_DISABLED:'1',DATABASE_URL:closed,MIGRATION_DATABASE_URL:closed,TEST_DATABASE_URL:closed,TEST_MIGRATION_DATABASE_URL:closed};
const require=createRequire(join(source,'package.json'));
const nextPackage=require('next/package.json'),tsPackage=require('typescript/package.json');
assert(nextPackage.version==='16.4.1'&&process.versions.node==='20.20.2');
const nextBin=require.resolve('next/dist/bin/next'),tsc=require.resolve('typescript/lib/tsc.js');
const report={kind:'NEXT_ONE_SEMANTIC_PROFILE_NOT_RELEASE',releaseEligible:false,source:ORIGIN,controller:env.AIHR_DIAG_CONTROLLER_SHA,
  run:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,runtime:{node:process.versions.node,next:nextPackage.version,typescript:tsPackage.version,platform:process.platform,arch:process.arch},
  admission,stages:[],generatedTypes:[],semanticInvocationAttempted:false,semanticCheckSucceeded:false,traceOverhead:true,memoryAcceptanceComparable:false,exitCode:1};
const started=Date.now(),TOTAL_MS=900000,PHASE_MS=180000;
let activeGroup=null,deadlineExpired=false,globalCleanup=Promise.resolve(),artifactCleanup=Promise.resolve();
function stopGroup(pid){
  if(pid)try{process.kill(-pid,'SIGTERM');}catch{}
  // Complete the owned-group hard kill before the independent outer 10s kill-after backstop.
  return new Promise(done=>setTimeout(()=>{if(pid)try{process.kill(-pid,'SIGKILL');}catch{}done();},5000));
}
function deadline(){
  if(deadlineExpired)return;deadlineExpired=true;report.exitCode=1;report.error='Diagnostic global deadline exceeded';
  put(join(out,'deadline.json'),{source:ORIGIN,controller:report.controller,elapsedMs:Date.now()-started,activeGroup,releaseEligible:false});
  globalCleanup=stopGroup(activeGroup);globalCleanup.then(()=>process.exit(124));
}
process.once('SIGTERM',deadline);
const globalTimer=setTimeout(deadline,TOTAL_MS);
function files(dir){return readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  assert(!deadlineExpired&&Date.now()-started<TOTAL_MS,'Diagnostic global deadline exhausted');
  const p=join(dir,entry.name);assert(!entry.isSymbolicLink(),'Generated symlinks refused');return entry.isDirectory()?files(p):[p];
});}
async function run(label,args,{timeoutMs=PHASE_MS,allowFailure=false}={}){
  assert(!deadlineExpired&&timeoutMs>0&&timeoutMs<=TOTAL_MS-(Date.now()-started),'Diagnostic remaining duration exhausted');
  const phaseStarted=Date.now();
  const log=join(out,label+'.log'),fd=openSync(log,'wx',0o600),memory=join(out,label+'-memory');
  const argv=[join(controller,'.github/ci/build-heap.mjs'),'measure',memory,'--','/usr/bin/prlimit','--fsize=67108864','--',process.execPath,...args];
  const child=spawn(process.execPath,argv,{cwd:source,env:childEnv,stdio:['ignore',fd,fd],detached:true});
  activeGroup=child.pid;let timedOut=false,killDone=Promise.resolve();
  const timer=setTimeout(()=>{timedOut=true;killDone=stopGroup(child.pid);},timeoutMs);
  let exit;
  try{exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});}
  finally{clearTimeout(timer);await killDone;await globalCleanup;await artifactCleanup;activeGroup=null;closeSync(fd);}
  const item={label,args,exit,timedOut,startedAt:new Date(phaseStarted).toISOString(),elapsedMs:Date.now()-phaseStarted,totalElapsedMs:Date.now()-started,log:relative(out,log),logSha256:sha(readFileSync(log))};report.stages.push(item);
  if(existsSync(join(memory,'build-memory.json')))item.memory=JSON.parse(readFileSync(join(memory,'build-memory.json'),'utf8'));
  item.observationSucceeded=!deadlineExpired&&!timedOut&&exit.code===0&&exit.signal===null&&!!item.memory&&item.memory.verdict!=='fail'&&item.memory.verdict!==null;
  if(!allowFailure)assert(item.observationSucceeded,label+' failed; partial evidence retained, never PASS');
  return item;
}
const inputPaths=['tsconfig.json','tsconfig.build.json','package.json','pnpm-lock.yaml','next.config.ts'];
report.inputs=Object.fromEntries(inputPaths.map(p=>[p,sha(readFileSync(join(source,p)))]));
report.compiler=Object.fromEntries(['typescript/lib/tsc.js','typescript/lib/_tsc.js','next/dist/lib/typescript/runTypeCheckCli.js','next/dist/lib/typescript/runTypeScriptCli.js','next/dist/cli/next-typegen.js'].map(p=>[p,sha(readFileSync(require.resolve(p)))]));
const FILE_CAP=64*1024**2,ARTIFACT_CAP=256*1024**2;
const expectedGenerated={
  'cache-life.d.ts':'87384ad5954f65285fc17ba8ed39d010a8ef111edba114e493b0431d677e5faa',
  'root-params.d.ts':'f3387dd7800eec3c34273f7a8efad13e864598c7e8f788d321e407390989bb59',
  'routes.d.ts':'cebf607819c9bb091e0de6d9ef379479340d1ef8757939a70dfa6597a3a5791a',
  'validator.ts':'68597e9738201646fa7a66fe59200937874fac5e0fba1cf8034b7084190ebc7b',
};

/** Parse only genuine complete elements of an array prefix. Never append a fictitious closing bracket. */
function arrayPrefix(path,visit){
  const bytes=readFileSync(path);assert(bytes.length<=FILE_CAP,'Trace file exceeds extraction bound');
  const text=bytes.toString('utf8');let p=0,count=0,last=0,complete=false,reason=null;
  const ws=()=>{while(p<text.length&&/[\x20\t\r\n]/.test(text[p]))p++;};
  ws();if(text[p++]!=='[')return{bytes:bytes.length,sha256:sha(bytes),complete:false,count:0,lastValidByteOffset:0,reason:'not_array'};
  while(p<text.length){
    assert(!deadlineExpired&&Date.now()-started<TOTAL_MS,'Extraction deadline exceeded');ws();
    if(text[p]===']'){p++;ws();complete=p===text.length;reason=complete?null:'data_after_array';break;}
    if(count){if(text[p]!==','){reason='missing_separator';break;}p++;ws();}
    if(text[p]!=='{'){reason=p>=text.length?'incomplete_tail':'invalid_element_start';break;}
    const begin=p,stack=[];let quoted=false,escaped=false,end=-1;
    for(;p<text.length;p++){
      if((p&65535)===0)assert(!deadlineExpired&&Date.now()-started<TOTAL_MS,'Extraction deadline exceeded');
      const c=text[p];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"'){quoted=true;continue;}
      if(c==='{'||c==='[')stack.push(c);
      else if(c==='}'||c===']'){
        const open=stack.pop();if((c==='}'&&open!=='{')||(c===']'&&open!=='[')){reason='invalid_nesting';break;}
        if(!stack.length){end=p+1;break;}
      }
    }
    if(end<0){reason??='incomplete_element';break;}
    let value;try{value=JSON.parse(text.slice(begin,end));}catch{reason='invalid_complete_element';break;}
    if(!value||Array.isArray(value)||typeof value!=='object'){reason='non_object_element';break;}
    count++;last=end;p=end;visit(value,count);
  }
  if(!complete&&!reason)reason='missing_array_closure';
  return{bytes:bytes.length,sha256:sha(bytes),complete,count,lastValidByteOffset:Buffer.byteLength(text.slice(0,last)),reason,fileCapReached:bytes.length===FILE_CAP};
}
function parserControls(){
  const dir=join(out,'synthetic-parser-controls');mkdirSync(dir,{mode:0o700});
  const cases=[
    {name:'complete',text:JSON.stringify([{name:'checkSourceFile',args:{path:'a{b}.ts',quote:'"\\'}},{name:'relation'}]),names:['checkSourceFile','relation'],complete:true},
    {name:'partial',text:'[{"name":"first"},{"name":"second"},{"name":',names:['first','second'],complete:false},
    {name:'malformed-middle',text:'[{"name":"first"},{bad},{"name":"not trusted"}]',names:['first'],complete:false},
  ];
  for(const sample of cases){const path=join(dir,sample.name+'.json');put(path,sample.text);const values=[];const result=arrayPrefix(path,value=>values.push(value));assert.equal(result.count,sample.names.length);assert.deepStrictEqual(values.map(v=>v.name),sample.names);assert.equal(result.complete,sample.complete);put(join(dir,sample.name+'-result.json'),result);}
  report.parserControls='passed_synthetic_only';
}
function summarizeTrace(){
  const dir=join(out,'trace');if(!existsSync(dir))return{available:false,reason:'compiler_did_not_create_trace',semanticPass:false};
  const traceFiles=files(dir).filter(p=>/^trace(?:\.[0-9-]+)?\.json$/.test(p.split('/').at(-1)));
  if(traceFiles.length!==1)return{available:false,reason:'expected_exactly_one_trace',traceFiles:traceFiles.map(p=>relative(out,p)),semanticPass:false};
  const stack=new Map(),durations=new Map(),relations=[],unmatchedEnds=[];let relationCount=0,lastTimestamp=null,maxTimestamp=null;
  const trace=arrayPrefix(traceFiles[0],event=>{
    if(!Number.isFinite(event.ts)||typeof event.name!=='string'||typeof event.ph!=='string')return;
    lastTimestamp=event.ts;maxTimestamp=maxTimestamp===null?event.ts:Math.max(maxTimestamp,event.ts);const key=String(event.pid)+':'+String(event.tid),frames=stack.get(key)??[];
    if(event.name==='checkSourceFile'||event.name==='checkSourceFileNodes'){
      if(event.ph==='B'&&typeof event.args?.path==='string'){frames.push({name:event.name,path:event.args.path,ts:event.ts});stack.set(key,frames);}
      else if(event.ph==='E'){
        const top=frames.at(-1);if(!top||top.name!==event.name||top.path!==event.args?.path){unmatchedEnds.push({name:event.name,path:event.args?.path,ts:event.ts});return;}
        frames.pop();const duration=event.ts-top.ts;if(duration>=0){const row=durations.get(top.path)??{path:top.path,completedChecks:0,totalMicroseconds:0,maxMicroseconds:0};row.completedChecks++;row.totalMicroseconds+=duration;row.maxMicroseconds=Math.max(row.maxMicroseconds,duration);durations.set(top.path,row);}
      }
    }
    if(event.cat==='checkTypes'&&event.ph==='X'&&Number.isFinite(event.dur)&&event.dur>=0){
      relationCount++;const ids={};for(const k of ['sourceId','targetId'])if(Number.isSafeInteger(event.args?.[k]))ids[k]=event.args[k];
      relations.push({name:event.name,ts:event.ts,durationMicroseconds:event.dur,observedOpenFileContext:frames.at(-1)?.path??null,...ids});relations.sort((a,b)=>b.durationMicroseconds-a.durationMicroseconds);if(relations.length>100)relations.pop();
    }
  });
  const needed=new Set(relations.flatMap(r=>[r.sourceId,r.targetId]).filter(Number.isSafeInteger)),typeRows=[];
  const catalogPath=join(dir,'types'+traceFiles[0].split('/').at(-1).slice('trace'.length));
  let catalog={available:false,reason:'types_catalog_not_flushed; type IDs remain unresolved'};
  if(existsSync(catalogPath)){
    const parsed=arrayPrefix(catalogPath,type=>{if(needed.has(type.id)){const display=typeof type.display==='string'?type.display:undefined;typeRows.push({id:type.id,symbolName:type.symbolName,flags:type.flags,firstDeclaration:type.firstDeclaration,display:display?.slice(0,2000),displayTruncated:!!display&&display.length>2000});}});
    catalog={available:true,...parsed,matchedTypes:typeRows,unresolvedTypeIds:[...needed].filter(id=>!typeRows.some(type=>type.id===id))};
  }
  return{available:true,tracePath:relative(out,traceFiles[0]),trace,completedSourceFiles:durations.size,totalCompletedSourceFileChecks:[...durations.values()].reduce((n,row)=>n+row.completedChecks,0),
    topObservedCompletedFiles:[...durations.values()].sort((a,b)=>b.totalMicroseconds-a.totalMicroseconds).slice(0,100),
    observedOpenFileFrames:[...stack].flatMap(([thread,frames])=>frames.map(frame=>({thread,...frame}))),lastRecordTimestamp:lastTimestamp,maxObservedTimestamp:maxTimestamp,
    unmatchedEnds:unmatchedEnds.slice(0,100),unmatchedEndCount:unmatchedEnds.length,relationEventCount:relationCount,topObservedRelations:relations,catalog,
    limitations:['Summary covers only genuine parseable prefix events; raw trace is unchanged.','Open-file context and long relations localize work, but do not alone prove an allocation culprit.','Absent/incomplete types catalog cannot resolve every relation ID.','Trace instrumentation changes resource cost; this is never build-memory acceptance.']};
}

let artifactLimit=false,artifactMonitor;
try{
  parserControls();
  await run('actual-next-typegen',[nextBin,'typegen']);
  put(join(out,'source-after-typegen.diff'),git(source,'diff')+'\n');assert(git(source,'diff','--name-only')==='','Next changed tracked source/config');
  const generated=join(source,'.next/types');assert(existsSync(generated));
  for(const p of files(generated)){
    const name=relative(generated,p),bytes=readFileSync(p);assert(expectedGenerated[name]===sha(bytes),'Generated route inputs differ from verified 56a inventory');
    const target=join(out,'generated-types',name);mkdirSync(resolve(target,'..'),{recursive:true,mode:0o700});copyFileSync(p,target);report.generatedTypes.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
  }
  assert(report.generatedTypes.length===Object.keys(expectedGenerated).length);copyFileSync(join(source,'next-env.d.ts'),join(out,'next-env.d.ts'));
  const raw=require('next/dist/server/config'),load=raw.default??raw,before=env.NODE_ENV;env.NODE_ENV='production';
  const config=await load(require('next/dist/shared/lib/constants').PHASE_PRODUCTION_BUILD,source);if(before===undefined)delete env.NODE_ENV;else env.NODE_ENV=before;
  assert(config.typescript?.tsconfigPath==='tsconfig.build.json'&&config.typescript.ignoreBuildErrors!==true&&config.experimental.useTypeScriptCli===true&&config.distDir==='.next');
  const ts=require('typescript'),host={...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{throw Error('Configuration parsing refused');}};
  const parsed=ts.getParsedCommandLineOfConfigFile(join(source,'tsconfig.build.json'),{},host);assert(parsed&&!parsed.errors.length&&parsed.options.strict===true&&parsed.options.noCheck!==true&&parsed.options.noEmit===true);
  const {configFile,configFilePath,...options}=parsed.options;
  put(join(out,'original-effective-options.json'),options);put(join(out,'original-effective-roots.json'),parsed.fileNames.map(p=>relative(source,p)));
  put(join(out,'ambient-types.json'),{roots:ts.getEffectiveTypeRoots(parsed.options,host),automatic:ts.getAutomaticTypeDirectiveNames(parsed.options,host).sort()});
  assert(!existsSync(join(source,'.next/cache/.tsbuildinfo')),'One COLD semantic program required');
  const trace=join(out,'trace'),args=[tsc,'--project','tsconfig.build.json','--noEmit','--declarationMap','false','--emitDeclarationOnly','false','--tsBuildInfoFile',join(source,'.next/cache/.tsbuildinfo'),'--generateTrace',trace,'--extendedDiagnostics','--pretty','false'];
  report.semanticInvocationAttempted=true;report.semanticArgs=args;report.traceBaselineInventory={run:'44278414933',source:ORIGIN,generatedHashesMatched:true};
  put(join(out,'semantic-invocation.json'),report);
  const stopForArtifact=()=>{if(!artifactLimit){artifactLimit=true;artifactCleanup=stopGroup(activeGroup);}};
  artifactMonitor=setInterval(()=>{try{const total=files(out).reduce((sum,p)=>sum+lstatSync(p).size,0);if(total>ARTIFACT_CAP)stopForArtifact();}catch(error){report.artifactMonitorError=String(error);stopForArtifact();}},1000);
  const remaining=TOTAL_MS-(Date.now()-started)-20000;assert(remaining>0,'No semantic time remains within original deadline');
  const result=await run('one-cold-strict-semantic-profile',args,{timeoutMs:remaining,allowFailure:true});
  clearInterval(artifactMonitor);artifactMonitor=null;
  report.semanticCheckSucceeded=result.observationSucceeded&&result.memory?.exitCode===0&&!artifactLimit;
  report.semanticOutcome=report.semanticCheckSucceeded?'COMPLETED_DIAGNOSTIC_ONLY':'FAILED_OR_CONFOUNDED_DIAGNOSTIC';
  report.artifactLimit=artifactLimit;report.compilerLog=relative(out,join(out,'one-cold-strict-semantic-profile.log'));
  report.fileLimitMayHaveConfounded=result.memory?.exitCode===153||result.memory?.signal==='SIGXFSZ'||/File size limit|SIGXFSZ|EFBIG/.test(readFileSync(join(out,report.compilerLog),'utf8'))||files(out).some(p=>lstatSync(p).size>=FILE_CAP);
  if(report.fileLimitMayHaveConfounded){report.semanticCheckSucceeded=false;report.semanticOutcome='FAILED_OR_CONFOUNDED_DIAGNOSTIC';}
  assert(git(source,'diff','--name-only')==='','Semantic profile changed tracked source/config');
  for(const [p,digest]of Object.entries(report.inputs))assert(sha(readFileSync(join(source,p)))===digest,'Input changed: '+p);
  for(const row of report.generatedTypes)assert(sha(readFileSync(join(generated,row.path)))===row.sha256,'Generated input changed');
  if(!report.semanticCheckSucceeded)report.error='Original compiler exit/timeout/memory/artifact refusal retained; never relabel as semantic PASS';
  report.exitCode=report.semanticCheckSucceeded?0:1;
}catch(error){report.error=error instanceof Error?error.message:String(error);}
finally{
  if(artifactMonitor)clearInterval(artifactMonitor);
  try{
    report.traceSummary=summarizeTrace();put(join(out,'trace-summary.json'),report.traceSummary);
    report.profileEvidenceComplete=!!report.traceSummary.available&&report.traceSummary.trace.complete&&report.traceSummary.catalog.available&&report.traceSummary.catalog.complete&&report.traceSummary.unmatchedEndCount===0&&report.traceSummary.observedOpenFileFrames.length===0;
    if(report.semanticCheckSucceeded&&!report.profileEvidenceComplete){report.error='Compiler completed but profile evidence is missing/incomplete; diagnostic refused';report.exitCode=1;}
  }catch(error){report.traceExtractionError=String(error);report.exitCode=1;}
  clearTimeout(globalTimer);process.removeListener('SIGTERM',deadline);await globalCleanup;
  report.elapsedMs=Date.now()-started;report.sourceAfter=git(source,'rev-parse','HEAD');report.sourceDiffAfter=git(source,'diff','--name-only');
  report.resourceComparability='INSTRUMENTED_DIAGNOSTIC_ONLY_NOT_ACCEPTANCE';
  put(join(out,'report.json'),report);console.log(JSON.stringify({kind:report.kind,source:report.source,exitCode:report.exitCode,error:report.error,semanticOutcome:report.semanticOutcome,traceComplete:report.traceSummary?.trace?.complete}));
}
process.exitCode=report.exitCode;
