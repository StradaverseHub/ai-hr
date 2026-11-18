/** Frozen-origin configuration/program inventory only. Never checks types or authorizes a release. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,lstatSync,readdirSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {admitBuildHeap,BUILD_HEAP_NODE_OPTIONS} from '../build-heap.mjs';

const ORIGIN='56a33b3eee49a28125eaaed9a7836a308873f417';
const WORKFLOW='StradaverseHub/ai-hr/.github/workflows/next-program-inventory.yml@refs/heads/codex/resignation-build-program-diagnosis-20261118';
const controller=realpathSync(fileURLToPath(new URL('../../../',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(dir,...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',timeout:10000,maxBuffer:8*1024**2}).trim();
const put=(path,value)=>writeFileSync(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const source=realpathSync(process.cwd()),env=process.env;
assert(process.platform==='linux'&&env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856');
assert(['workflow_dispatch','push'].includes(env.GITHUB_EVENT_NAME)&&env.GITHUB_WORKFLOW_REF===WORKFLOW&&env.GITHUB_JOB==='inventory');
assert(env.GITHUB_WORKFLOW==='next-program-inventory'&&env.AIHR_DIAG_SOURCE_SHA===ORIGIN);
assert(/^[a-f0-9]{40}$/.test(env.AIHR_DIAG_CONTROLLER_SHA??'')&&env.GITHUB_SHA===env.AIHR_DIAG_CONTROLLER_SHA&&env.AIHR_CI_CONTROL_HEAD===env.AIHR_DIAG_CONTROLLER_SHA);
assert(git(source,'rev-parse','HEAD')===ORIGIN&&git(controller,'rev-parse','HEAD')===env.AIHR_DIAG_CONTROLLER_SHA);
git(controller,'merge-base','--is-ancestor',ORIGIN,env.AIHR_DIAG_CONTROLLER_SHA);
assert.deepStrictEqual(git(controller,'diff','--name-only',ORIGIN,env.AIHR_DIAG_CONTROLLER_SHA).split('\n'),[
  '.github/ci/diagnostics/next-program-inventory.mjs','.github/workflows/next-program-inventory.yml',
],'Diagnostic controller may differ from origin only in its two reviewed files');
assert(git(source,'status','--porcelain','--untracked-files=all')===''&&git(controller,'status','--porcelain','--untracked-files=all')==='');
assert(source===join(realpathSync(env.GITHUB_WORKSPACE),'source')&&controller===join(realpathSync(env.GITHUB_WORKSPACE),'automation'));
const event=JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
assert(!event.pull_request&&event.repository?.full_name===env.GITHUB_REPOSITORY&&event.repository?.id===1333414856);
if(env.GITHUB_EVENT_NAME==='workflow_dispatch')assert(event.inputs?.source_sha===ORIGIN&&event.inputs?.controller_sha===env.AIHR_DIAG_CONTROLLER_SHA);
else assert(event.ref==='refs/heads/codex/resignation-build-program-diagnosis-20261118'&&event.after===env.AIHR_DIAG_CONTROLLER_SHA&&event.deleted!==true);
assert(!existsSync(join(source,'.next')),'Cold generated types/cache required');
assert(!Object.keys(env).some(key=>(key.startsWith('AIHR_SYSTEM_TESTING_')||key.startsWith('AIHR_NEXT_BUILD_')||key==='AUTH_SESSION_KEY'||key==='MIGRATION_DATABASE_URL')&&env[key]));

const temp=realpathSync(env.RUNNER_TEMP),out=resolve(process.argv[2]??'');
assert(out===join(temp,'next-program-inventory-56a')&&!existsSync(out));
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
const report={kind:'NEXT_PROGRAM_INVENTORY_ONLY_NO_SEMANTIC_CHECK',releaseEligible:false,source:ORIGIN,controller:env.AIHR_DIAG_CONTROLLER_SHA,
  run:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,runtime:{node:process.versions.node,next:nextPackage.version,typescript:tsPackage.version,platform:process.platform,arch:process.arch},
  admission,stages:[],generatedTypes:[],semanticChecksRun:0,proposalApplied:false,exitCode:1};
const started=Date.now(),TOTAL_MS=900000,PHASE_MS=180000;
let activeGroup=null,deadlineExpired=false,globalCleanup=Promise.resolve();
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
async function run(label,args){
  assert(Date.now()-started<TOTAL_MS-PHASE_MS,'Diagnostic total duration exhausted');
  const phaseStarted=Date.now();
  const log=join(out,label+'.log'),fd=openSync(log,'wx',0o600),memory=join(out,label+'-memory');
  const argv=[join(controller,'.github/ci/build-heap.mjs'),'measure',memory,'--','/usr/bin/prlimit','--fsize=67108864','--',process.execPath,...args];
  const child=spawn(process.execPath,argv,{cwd:source,env:childEnv,stdio:['ignore',fd,fd],detached:true});
  activeGroup=child.pid;let timedOut=false,killDone=Promise.resolve();
  const timer=setTimeout(()=>{timedOut=true;killDone=stopGroup(child.pid);},PHASE_MS);
  let exit;
  try{exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});}
  finally{clearTimeout(timer);await killDone;await globalCleanup;activeGroup=null;closeSync(fd);}
  const item={label,args,exit,timedOut,startedAt:new Date(phaseStarted).toISOString(),elapsedMs:Date.now()-phaseStarted,totalElapsedMs:Date.now()-started,log:relative(out,log),logSha256:sha(readFileSync(log))};report.stages.push(item);
  if(existsSync(join(memory,'build-memory.json')))item.memory=JSON.parse(readFileSync(join(memory,'build-memory.json'),'utf8'));
  assert(!deadlineExpired&&!timedOut&&exit.code===0&&exit.signal===null,label+' failed; partial evidence retained, never PASS');
  assert(item.memory&&item.memory.verdict!=='fail'&&item.memory.verdict!==null,label+' memory evidence refused');
  return readFileSync(log,'utf8');
}
const inputPaths=['tsconfig.json','tsconfig.build.json','package.json','pnpm-lock.yaml','next.config.ts'];
report.inputs=Object.fromEntries(inputPaths.map(p=>[p,sha(readFileSync(join(source,p)))]));
report.compiler=Object.fromEntries(['typescript/lib/tsc.js','typescript/lib/_tsc.js','next/dist/lib/typescript/runTypeCheckCli.js','next/dist/lib/typescript/runTypeScriptCli.js','next/dist/cli/next-typegen.js'].map(p=>[p,sha(readFileSync(require.resolve(p)))]));
try{
  await run('actual-next-typegen',[nextBin,'typegen']);
  const changes=git(source,'diff','--name-only');put(join(out,'source-after-typegen.diff'),git(source,'diff')+'\n');
  assert(changes==='','Next unexpectedly changed tracked source/config; inspect retained diff before continuing');
  const generated=join(source,'.next/types');assert(existsSync(join(generated,'routes.d.ts'))&&existsSync(join(generated,'validator.ts')));
  let generatedBytes=0;
  for(const file of files(generated)){
    const rel=relative(generated,file),bytes=readFileSync(file);assert(bytes.length<=64*1024**2);
    generatedBytes+=bytes.length;assert(generatedBytes<=64*1024**2,'Generated diagnostic evidence exceeds bound');
    const copy=join(out,'generated-types',rel);mkdirSync(resolve(copy,'..'),{recursive:true,mode:0o700});copyFileSync(file,copy);
    report.generatedTypes.push({path:rel,bytes:bytes.length,sha256:sha(bytes)});
  }
  assert(existsSync(join(source,'next-env.d.ts')));copyFileSync(join(source,'next-env.d.ts'),join(out,'next-env.d.ts'));
  const nextConfigRaw=require('next/dist/server/config'),load=nextConfigRaw.default??nextConfigRaw;
  // Loading the same installed configuration path is not an application request or semantic type check.
  const beforeEnv=env.NODE_ENV;env.NODE_ENV='production';
  const config=await load(require('next/dist/shared/lib/constants').PHASE_PRODUCTION_BUILD,source);
  if(beforeEnv===undefined)delete env.NODE_ENV;else env.NODE_ENV=beforeEnv;
  assert(config.typescript?.tsconfigPath==='tsconfig.build.json'&&config.typescript.ignoreBuildErrors!==true&&config.experimental.useTypeScriptCli===true&&config.distDir==='.next');
  report.nextCompilerContract={tsconfigPath:config.typescript.tsconfigPath,ignoreBuildErrors:false,useTypeScriptCli:true,typedRoutes:!!config.typedRoutes,strictRouteTypes:!!config.experimental.strictRouteTypes};
  const baseArgs=['--noEmit','--declarationMap','false','--emitDeclarationOnly','false','--tsBuildInfoFile',join(source,'.next/cache/.tsbuildinfo')];
  const inventoryArgs=['--listFilesOnly','--explainFiles','--pretty','false'];
  const proposed=join(out,'UNADOPTED-web-entry.tsconfig.json');
  const ts=require('typescript'),host={...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{throw Error('Configuration parsing refused');}};
  const options=project=>{
    const parsed=ts.getParsedCommandLineOfConfigFile(resolve(source,project),{},host);assert(parsed&&!parsed.errors.length);
    assert(parsed.options.strict===true&&parsed.options.noCheck!==true&&parsed.options.noEmit===true);
    return parsed.options;
  };
  const currentOptions=options('tsconfig.build.json');
  // A temporary config must not silently move implicit @types discovery to RUNNER_TEMP ancestors.
  const currentTypeRoots=ts.getEffectiveTypeRoots(currentOptions,host)??[];
  const currentAutomaticTypes=ts.getAutomaticTypeDirectiveNames(currentOptions,host).sort();
  put(proposed,{extends:join(source,'tsconfig.build.json'),compilerOptions:{typeRoots:currentTypeRoots},include:['next-env.d.ts','app/**/*.ts','app/**/*.tsx','components/**/*.ts','components/**/*.tsx','i18n/**/*.ts','packs/**/*.ts','localization/**/*.ts','types/**/*.d.ts','middleware.ts','instrumentation.ts','instrumentation-client.ts','next.config.ts','.next/types/**/*.ts'].map(p=>join(source,p))});
  const proposedOptions=options(proposed),proposedTypeRoots=ts.getEffectiveTypeRoots(proposedOptions,host)??[];
  const proposedAutomaticTypes=ts.getAutomaticTypeDirectiveNames(proposedOptions,host).sort();
  assert.deepStrictEqual(proposedTypeRoots,currentTypeRoots,'Temporary config changed effective ambient type roots');
  assert.deepStrictEqual(proposedAutomaticTypes,currentAutomaticTypes,'Temporary config changed automatic ambient types');
  const normalize=(value,typeRoots)=>{const {configFile,configFilePath,...semantic}=value;return {...semantic,typeRoots};};
  const normalizedCurrent=normalize(currentOptions,currentTypeRoots),normalizedProposed=normalize(proposedOptions,proposedTypeRoots);
  assert.deepStrictEqual(normalizedProposed,normalizedCurrent,'The temporary proposal changed compiler semantics or path resolution');
  put(join(out,'effective-type-directives.json'),{currentTypeRoots,proposedTypeRoots,currentAutomaticTypes,proposedAutomaticTypes});
  put(join(out,'effective-compiler-options.json'),normalizedCurrent);report.compilerOptionsSha256=sha(readFileSync(join(out,'effective-compiler-options.json')));
  const inventories={};
  for(const [name,project] of [['current','tsconfig.build.json'],['proposed',proposed]]){
    assert(!existsSync(join(source,'.next/cache/.tsbuildinfo')),'Inventory must not consume successful compiler state');
    const text=await run(name+'-resolved-program',[tsc,'--project',project,...baseArgs,...inventoryArgs]);
    const paths=[];
    for(const line of text.split(/\r?\n/)){
      if(!line||/^\s/.test(line))continue;
      const file=resolve(source,line);if(!existsSync(file)||!lstatSync(file).isFile())continue;
      assert(file.startsWith(source+'/'),'Compiler returned an unexpected file outside the source checkout');paths.push(file);
    }
    assert(paths.length>0&&new Set(paths).size===paths.length,'Missing or duplicated compiler inventory');
    const rows=paths.sort().map(p=>({path:relative(source,p),bytes:lstatSync(p).size,sha256:sha(readFileSync(p))}));
    assert(rows.some(p=>p.path==='.next/types/validator.ts')&&rows.some(p=>p.path==='.next/types/routes.d.ts'),'Generated route checking inputs absent');
    inventories[name]=rows;put(join(out,name+'-resolved-program.json'),rows);
  }
  const current=new Set(inventories.current.map(f=>f.path)),proposedPaths=new Set(inventories.proposed.map(f=>f.path));
  const removed=[...current].filter(p=>!proposedPaths.has(p)),added=[...proposedPaths].filter(p=>!current.has(p));
  const protectedFile=p=>/^(app|components|i18n|packs|localization|types)\//.test(p)||p.startsWith('.next/types/')||['next-env.d.ts','middleware.ts','instrumentation.ts','instrumentation-client.ts','next.config.ts'].includes(p);
  report.comparison={current:current.size,proposed:proposedPaths.size,removed,added,removedProtected:removed.filter(protectedFile),identical:removed.length===0&&added.length===0,
    adoption:'UNADOPTED_REQUIRES_OWNER_REVIEW',memoryReductionProven:false,actualApplicationSemanticCoverageProven:false};
  if(report.comparison.identical)report.comparison.adoption='REJECT_IDENTICAL_CLOSURE_PROFILE_NEXT';
  if(report.comparison.removedProtected.length)report.comparison.adoption='REJECT_LOST_WEB_OR_GENERATED_COVERAGE';
  assert(git(source,'diff','--name-only')==='','Diagnostic changed tracked source');
  for(const [p,digest]of Object.entries(report.inputs))assert(sha(readFileSync(join(source,p)))===digest,'Input changed: '+p);
  for(const row of report.generatedTypes)assert(sha(readFileSync(join(generated,row.path)))===row.sha256,'Generated input changed between programs');
  assert(!deadlineExpired&&Date.now()-started<TOTAL_MS,'Diagnostic global deadline exceeded');report.exitCode=0;
}catch(error){report.error=error instanceof Error?error.message:String(error);}
finally{
  clearTimeout(globalTimer);process.removeListener('SIGTERM',deadline);await globalCleanup;
  report.elapsedMs=Date.now()-started;report.sourceAfter=git(source,'rev-parse','HEAD');report.sourceDiffAfter=git(source,'diff','--name-only');
  put(join(out,'report.json'),report);console.log(JSON.stringify({kind:report.kind,source:report.source,exitCode:report.exitCode,error:report.error,comparison:report.comparison}));
}
process.exitCode=report.exitCode;
