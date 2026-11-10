/** A build-only filesystem proof. No worker, database, provider or release authority. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdtempSync,opendirSync,openSync,readFileSync,realpathSync} from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const exact='79d9a52e92f6d39551b0f52b504d52715cdc7601';
const tree='0844a7b9eb057c13c728251da042c3f3b5c07bb5';
const branch='codex/architecture-worker-build-custody-positive-20261110';
const repo='StradaverseHub/ai-hr';
const workflow=repo+'/.github/workflows/alpha-focused-checks.yml@refs/heads/'+branch;
const env=process.env,root=process.cwd();
const {GITHUB_WORKSPACE:workspace,RUNNER_TEMP:temp}=env;
const git=(cwd,...args)=>execFileSync('/usr/bin/git',args,{cwd,encoding:'utf8',maxBuffer:262144,timeout:10000}).trim();
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const emit=row=>console.log(JSON.stringify(row));
const timings={};
let stage='identity';

function clean(){
 assert.equal(git(root,'rev-parse','HEAD'),exact);
 assert.equal(git(root,'rev-parse','HEAD^{tree}'),tree);
 assert.equal(git(root,'status','--porcelain','--untracked-files=all'),'');
 assert.equal(git(root,'remote','get-url','origin').replace(/\.git$/,''),'https://github.com/'+repo);
}
function requireExactRunner(){
 assert(process.argv.length===2&&/^[a-f0-9]{40}$/.test(exact)&&/^[a-f0-9]{40}$/.test(tree));
 assert(process.platform==='linux'&&process.arch==='x64'&&process.version==='v24.22.1'&&os.availableParallelism()===4
  &&os.totalmem()>=15*1024**3&&os.totalmem()<=17*1024**3&&process.getuid()>0&&process.umask()===0o077);
 assert(root===workspace+'/source'&&realpathSync(root)===root&&realpathSync(temp)===temp);
 assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'
  &&env.RUNNER_OS==='Linux'&&env.RUNNER_ARCH==='X64'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'
  &&env.GITHUB_REPOSITORY===repo&&env.GITHUB_REPOSITORY_ID==='1333414856'&&env.GITHUB_WORKFLOW==='alpha-focused-checks'
  &&env.GITHUB_RUN_ATTEMPT==='1'&&env.GITHUB_JOB==='worker-build-custody-proof'
  &&env.GITHUB_REF==='refs/heads/'+branch&&env.GITHUB_WORKFLOW_REF===workflow
  &&/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)&&env.GITHUB_SHA===env.GITHUB_WORKFLOW_SHA
  &&git(workspace+'/automation','rev-parse','HEAD')===env.GITHUB_SHA
  &&git(workspace+'/automation','status','--porcelain')===''&&env.STAGING_ENABLED==='false'&&env.PRODUCTION_ENABLED==='false');
 assert(['GH_TOKEN','GITHUB_TOKEN','AIHR_EVAL_OPENROUTER_KEY','AIHR_WORKER_COMPARISON_ADMISSION_SHA256',
  'AIHR_WORKER_COMPARISON_FAMILY_FD','NODE_OPTIONS','NODE_PATH'].every(key=>!env[key]));
 clean();
}
function exactModule(name,expected){
 const path=join(root,name);
 assert(/^[a-f0-9]{64}$/.test(expected)&&digest(readFileSync(path))===expected);
 return import(pathToFileURL(path));
}

function census(build){
 const categories={knownRuntimeAlias:0,unexpectedSymlink:0,foreignOwner:0,foreignDevice:0,unsafeMode:0,regularHardLink:0,unsupportedKind:0};
 const histogram={directory:{},file:{}};
 const owner=BigInt(process.getuid()),device=lstatSync(build,{bigint:true}).dev,stop=performance.now()+15000;
 let first=null,visited=0;
 function note(category){first??=category;categories[category]++;}
 function visit(relative,depth){
  assert(++visited<=100000&&depth<=48&&performance.now()<stop);
  const path=relative?join(build,relative):build,stat=lstatSync(path,{bigint:true});
  if(stat.dev!==device)note('foreignDevice');
  else if(stat.uid!==owner)note('foreignOwner');
  else if(stat.isSymbolicLink())note(/^node_modules\/(fontkit|sharp)-[a-f0-9]{8,64}$/.test(relative)?'knownRuntimeAlias':'unexpectedSymlink');
  else if((stat.mode&0o7022n)!==0n)note('unsafeMode');
  else if(stat.isFile()&&stat.nlink!==1n)note('regularHardLink');
  else if(!stat.isDirectory()&&!stat.isFile())note('unsupportedKind');
  const histogramKind=stat.isDirectory()?'directory':stat.isFile()?'file':null;
  if(histogramKind){
   const modes=histogram[histogramKind],mode=(stat.mode&0o7777n).toString(8).padStart(4,'0');
   assert(Object.hasOwn(modes,mode)||Object.keys(modes).length<32);
   modes[mode]=(modes[mode]??0)+1;
  }
  if(stat.isDirectory()){
   const children=[],dir=opendirSync(path);
   try{
    for(let entry;(entry=dir.readSync())!==null;){
     assert(children.length<100000-visited&&performance.now()<stop);
     children.push(entry.name);
    }
   }finally{dir.closeSync();}
   for(const name of children.sort())visit(relative?relative+'/'+name:name,depth+1);
  }
 }
 visit('',0);
 return {visited,first,categories,histogram};
}
function cleanRuntime(census){
 assert.equal(census.categories.knownRuntimeAlias,2);
 assert(Object.entries(census.categories).every(([key,count])=>key==='knownRuntimeAlias'||count===0));
}
function canonicalInventory(){
 const check=spawnSync('/usr/bin/python3',['-I','-B','-c',[
  'import importlib.util,json',
  'from pathlib import Path',
  "s=importlib.util.spec_from_file_location('native_build_bundle',Path('.github/ci/build-bundle.py'))",
  'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
  'files,dirs,aliases=m.scan(Path.cwd())',
  "print(json.dumps({'files':len(files),'directories':len(dirs),'runtimeAliases':sorted(a['package'] for a in aliases)}))",
 ].join('\n')],{cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},encoding:'utf8',timeout:180000,maxBuffer:16384});
 assert.equal(check.status,0);
 const value=JSON.parse(check.stdout);
 assert.equal(Object.keys(value).sort().join(','),'directories,files,runtimeAliases');
 assert(Number.isSafeInteger(value.files)&&value.files>0&&value.files<=40000
  &&Number.isSafeInteger(value.directories)&&value.directories>=1&&value.directories<=40000);
 assert.deepEqual(value.runtimeAliases,['fontkit','sharp']);
 return value;
}
function oneBuild(prepareBuild,privateRoot){
 const allowed=['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TZ','PNPM_HOME','COREPACK_HOME',
  'GITHUB_ACTIONS','CI','RUNNER_ENVIRONMENT','RUNNER_OS','RUNNER_ARCH','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT',
  'GITHUB_WORKFLOW','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID','GITHUB_JOB'];
 const input=Object.fromEntries(allowed.filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
 const {buildEnv}=prepareBuild({...input,AIHR_CI_HEAD:exact,AIHR_CI_CONTROL_HEAD:env.GITHUB_WORKFLOW_SHA,
  NEXT_TELEMETRY_DISABLED:'1'},readFileSync('/proc/meminfo','utf8'));
 const log=openSync(join(privateRoot,'canonical-build.log'),'wx',0o600);
 try{
  const result=spawnSync(process.execPath,['.github/ci/build-heap.mjs','measure',join(privateRoot,'build-memory'),'--','pnpm','build'],
   {cwd:root,env:buildEnv,stdio:['ignore',log,log],timeout:900000,killSignal:'SIGKILL'});
  assert(result.status===0&&result.signal===null&&!result.error);
 }finally{closeSync(log);}
}

function at(label,fn){
 stage=label;
 const started=performance.now();
 const result=fn();
 timings[label]=Math.round(performance.now()-started);
 return result;
}
function assertSeal(seal){
 assert.equal(Object.keys(seal).sort().join(','),'buildId,bytes,entries,sha256');
 assert(typeof seal.buildId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(seal.buildId)
  &&Number.isSafeInteger(seal.bytes)&&seal.bytes>0&&seal.bytes<=3*1024**3
  &&Number.isSafeInteger(seal.entries)&&seal.entries>0&&seal.entries<=100000&&/^[a-f0-9]{64}$/.test(seal.sha256));
}
function birth(view){
 assert(typeof view.directory.device==='string'&&/^\d{1,20}$/.test(view.directory.device)
  &&typeof view.directory.inode==='string'&&/^[1-9][0-9]{0,19}$/.test(view.directory.inode));
 return view.directory.device+':'+view.directory.inode;
}
async function prove(){
 requireExactRunner();
 stage='owners';
 const {holdDevelopmentBuildSnapshot}=await exactModule('scripts/performance/worker-comparison-build.mjs','94a73085138afa1b2c36232a1216ec7f432553f714f03c397d856beec8bda9bc');
 const {holdWorkerComparisonFiles,comparisonClock}=await exactModule('scripts/performance/worker-comparison-custody.mjs','b3e163f212277fc81ad1aec7aad401680b7b96d964fe4f1b52b47dcc51dad7c3');
 const {systemBuildEnvironment}=await exactModule('scripts/performance/build-environment.mjs','6aebde4d9696c17697f31f3231aae9880f1f6480266698167c8f90d98bcf7a73');
 const privateRoot=mkdtempSync(join(temp,'worker-build-custody-positive-')),build=join(root,'.next');
 assert(!existsSync(build));
 // This projection reaches only the artifact owner under test. No process sees
 // fabricated worker or release authority, and the actual build uses real job identity.
 const fixtureEnv={...env,GITHUB_JOB:'selected-tests',GITHUB_SHA:exact,GITHUB_WORKFLOW_SHA:exact,AIHR_CI_HEAD:exact,AIHR_CI_CONTROL_HEAD:exact};
 const files=holdWorkerComparisonFiles(fixtureEnv);
 let snapshot;
 try{
  snapshot=holdDevelopmentBuildSnapshot(fixtureEnv);
  files.holdSeed();
  files.openCell({ordinal:1,name:'diagnostic-original'});
  at('canonical-build',()=>oneBuild(systemBuildEnvironment,privateRoot));
  clean();
  const before=at('before-census',()=>census(build));
  emit({kind:'build-custody-before',source:exact,umask:'0077',before});
  const deadline=comparisonClock()+300000;
  const original=at('capture',()=>snapshot.capture(deadline));
  files.holdBuild(1,original);
  assertSeal(original.seal);
  const observedBirths=new Set([birth(original)]);
  const after=at('after-census',()=>census(build));
  cleanRuntime(after);
  const canonical=at('canonical-inventory',canonicalInventory);
  assert.deepEqual(at('verify-original',()=>snapshot.verify(deadline)),original.seal);
  at('retire-original',()=>files.retireCell(1,deadline));
  assert(!existsSync(build));
  for(const ordinal of [2,3]){
   const label=ordinal===2?'second':'third';
   files.openCell({ordinal,name:'diagnostic-'+label});
   const copy=at('install-'+label,()=>snapshot.install(deadline));
   files.holdBuild(ordinal,copy);
   assert.deepEqual(copy.identity,original.identity);
   assert.deepEqual(copy.seal,original.seal);
   const currentBirth=birth(copy);
   assert(!observedBirths.has(currentBirth));
   observedBirths.add(currentBirth);
   assert.deepEqual(at('census-'+label,()=>census(build)),after);
   assert.deepEqual(at('verify-'+label,()=>snapshot.verify(deadline)),original.seal);
   at('retire-'+label,()=>files.retireCell(ordinal,deadline));
   assert(!existsSync(build));
  }
  snapshot.close();
  at('retire-seed',()=>files.retireSeed(deadline));
  clean();
  emit({kind:'build-custody-success',source:exact,runAttempt:1,umask:'0077',canonicalBuildExit:0,
   sameSeals:true,distinctRuntimeInodes:observedBirths.size,verifiedInstalls:2,ownedRetirements:3,seedRetired:true,
   seal:{sha256:original.seal.sha256,entries:original.seal.entries,bytes:original.seal.bytes},after,canonicalInventory:canonical,timings,
   workerRun:false,releaseEligible:false});
 }finally{try{snapshot?.close();}finally{files.close();}}
}

try{await prove();}
catch(error){
 const reason=error?.code==='ENOENT'?'missing':error?.code==='EACCES'||error?.code==='EPERM'?'access':
  error?.code==='EEXIST'?'occupied':error?.name==='AssertionError'?'assertion':'other';
 emit({kind:'build-custody-failure',source:exact,stage,reason,releaseEligible:false,timings});
 process.exitCode=1;
}
