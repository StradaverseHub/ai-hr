/** Isolated fixture and optional Next artifact diagnostic. No worker admission or deploy path. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdirSync,mkdtempSync,openSync,readdirSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const exact='f5bb48cf8e8b3e92e87467881aa02d9e8d7d966d';
const branch='codex/architecture-worker-build-custody-forensic-20261110';
const repo='StradaverseHub/ai-hr';
const workflow=repo+'/.github/workflows/alpha-focused-checks.yml@refs/heads/'+branch;
const env=process.env;
const mode=process.argv[2];
const root=process.cwd();
const {GITHUB_WORKSPACE:workspace,RUNNER_TEMP:temp}=env;
const git=(cwd,...args)=>execFileSync('/usr/bin/git',args,{cwd,encoding:'utf8',maxBuffer:262144,timeout:10000}).trim();
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const emit=row=>console.log(JSON.stringify(row));
const refusal=new Map([
 ['Worker build directory or ancestor is a link or unsupported','directory-kind'],
 ['Worker build directory changed during open','directory-race'],
 ['Worker build contains an unsupported link, owner, mode or file kind','member-policy'],
 ['Worker build ID size refused','build-id-size'],
 ['Worker build ID refused','build-id-format'],
 ['Worker build byte ceiling exceeded','byte-ceiling'],
 ['Worker build member ceiling exceeded','member-ceiling'],
 ['Worker build snapshot work budget exhausted','snapshot-budget'],
 ['Worker build fresh directory ownership refused','new-owner'],
 ['Worker build requires an absent pre-build .next','preexisting-build'],
 ['Worker build origin or copy inode refused','copy-inode'],
]);
function safeReason(error){
 return refusal.get(error?.message)??({ENOENT:'missing',EACCES:'access',EPERM:'permission',ELOOP:'link',EEXIST:'occupied'}[error?.code])??'unclassified';
}
function modeBits(path){return (lstatSync(path).mode&0o7777).toString(8).padStart(4,'0');}
function clean(){
 assert.equal(git(root,'rev-parse','HEAD'),exact);
 assert.equal(git(root,'status','--porcelain','--untracked-files=all'),'');
 assert.equal(git(root,'remote','get-url','origin').replace(/\.git$/,''),'https://github.com/'+repo);
}
assert(process.argv.length===3&&['fast','actual'].includes(mode));
assert(process.platform==='linux'&&process.arch==='x64'&&process.version==='v24.22.1'&&os.availableParallelism()===4
 &&os.totalmem()>=15*1024**3&&os.totalmem()<=17*1024**3&&process.getuid()>0);
assert(root===workspace+'/source'&&realpathSync(root)===root&&realpathSync(temp)===temp);
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'
 &&env.RUNNER_OS==='Linux'&&env.RUNNER_ARCH==='X64'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'
 &&env.GITHUB_REPOSITORY===repo&&env.GITHUB_REPOSITORY_ID==='1333414856'&&env.GITHUB_WORKFLOW==='alpha-focused-checks'
 &&env.GITHUB_RUN_ATTEMPT==='1'&&env.GITHUB_JOB==='worker-build-custody-diagnostic'
 &&env.GITHUB_REF==='refs/heads/'+branch&&env.GITHUB_WORKFLOW_REF===workflow
 &&/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)&&env.GITHUB_SHA===env.GITHUB_WORKFLOW_SHA
 &&git(workspace+'/automation','rev-parse','HEAD')===env.GITHUB_SHA
 &&git(workspace+'/automation','status','--porcelain')===''&&env.STAGING_ENABLED==='false'&&env.PRODUCTION_ENABLED==='false');
assert(['GH_TOKEN','GITHUB_TOKEN','AIHR_EVAL_OPENROUTER_KEY','AIHR_WORKER_COMPARISON_ADMISSION_SHA256',
 'AIHR_WORKER_COMPARISON_FAMILY_FD','NODE_OPTIONS','NODE_PATH'].every(key=>!env[key]));
clean();
const snapshotPath=join(root,'scripts/performance/worker-comparison-build.mjs');
assert.equal(digest(readFileSync(snapshotPath)),process.env.EXPECTED_SNAPSHOT_SHA256);
const {holdDevelopmentBuildSnapshot}=await import(pathToFileURL(snapshotPath));
const privateRoot=mkdtempSync(join(temp,'worker-build-custody-diagnostic-'));
assert.equal(modeBits(privateRoot),'0700');
// These model-only fields reach only the pure snapshot owner, never process.env,
// a hosted admission, a deployment or a comparison entry point.
function fixtureEnvironment(base,artifactWorkspace,artifactTemp){
 return {...base,GITHUB_JOB:'selected-tests',GITHUB_WORKSPACE:artifactWorkspace,RUNNER_TEMP:artifactTemp,
  GITHUB_SHA:exact,GITHUB_WORKFLOW_SHA:exact,AIHR_CI_HEAD:exact,AIHR_CI_CONTROL_HEAD:exact};
}
function attempt(snapshot){
 try{snapshot.capture();return 'accepted';}catch(error){return safeReason(error);}
}
function syntheticArm(name,requestedUmask,aliases=false){
 const inherited=process.umask();
 const base=join(privateRoot,name),sourceWorkspace=join(base,'workspace'),source=join(sourceWorkspace,'source'),scratch=join(base,'temp');
 for(const directory of [base,sourceWorkspace,source,scratch])mkdirSync(directory,{mode:0o700});
 const snapshot=holdDevelopmentBuildSnapshot(fixtureEnvironment(env,sourceWorkspace,scratch));
 try{
  process.umask(requestedUmask);
  const build=join(source,'.next');
  mkdirSync(build);writeFileSync(join(build,'BUILD_ID'),'fictional-next-build');
  if(aliases){
   const aliasesDir=join(build,'node_modules');mkdirSync(aliasesDir);
   const dependencies=join(source,'node_modules');mkdirSync(dependencies);
   for(const [name,hash] of [['fontkit','11111111'],['sharp','22222222']]){
    mkdirSync(join(dependencies,name));
    symlinkSync('../../node_modules/'+name,join(aliasesDir,name+'-'+hash),'dir');
   }
  }
  const result=attempt(snapshot);
  if(aliases)assert.equal(result,'member-policy');
  else if(name==='controlled-0022')assert.equal(result,'accepted');
  else assert(['accepted','member-policy'].includes(result));
  emit({kind:'synthetic-build-policy',arm:name,inheritedUmask:inherited.toString(8).padStart(4,'0'),
   effectiveUmask:process.umask().toString(8).padStart(4,'0'),nextMode:modeBits(build),buildIdMode:modeBits(join(build,'BUILD_ID')),
   controlledRuntimeAliasCount:aliases?2:0,result});
 }finally{process.umask(inherited);snapshot.close();}
}


function memberPolicyCensus(build){
 const counts={knownRuntimeAlias:0,unexpectedSymlink:0,foreignOwner:0,foreignDevice:0,unsafeMode:0,regularHardLink:0,unsupportedKind:0};
 const owner=BigInt(process.getuid()),device=lstatSync(build,{bigint:true}).dev,stop=performance.now()+12000;
 let first=null,visited=0;
 const bounds=Error('member-census-bound');
 function note(category){
  first??=category;
  counts[category]++;
 }
 function visit(relative,depth){
  if(++visited>100000||depth>48||performance.now()>=stop)throw bounds;
  const path=relative?join(build,relative):build,stat=lstatSync(path,{bigint:true});
  if(stat.dev!==device)note('foreignDevice');
  else if(stat.uid!==owner)note('foreignOwner');
  else if(stat.isSymbolicLink())note(/^node_modules\/(fontkit|sharp)-[a-f0-9]{8,64}$/.test(relative)?'knownRuntimeAlias':'unexpectedSymlink');
  else if((stat.mode&0o7022n)!==0n)note('unsafeMode');
  else if(stat.isFile()&&stat.nlink!==1n)note('regularHardLink');
  else if(!stat.isDirectory()&&!stat.isFile())note('unsupportedKind');
  if(stat.isDirectory()){
   // Native diagnosis only. No link targets or relative names leave this process.
   for(const name of readdirSync(path).sort())visit(relative?relative+'/'+name:name,depth+1);
  }
 }
 try{visit('',0);return {state:'complete',visited,first,counts};}
 catch(error){return {state:error===bounds?'bounded':'unavailable',visited:Math.min(visited,100000),first,counts};}
}

function actualBuild(){
 assert(!existsSync(join(root,'.next')));
 const snapshot=holdDevelopmentBuildSnapshot(fixtureEnvironment(env,workspace,temp));
 const buildEnvInput=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TZ','PNPM_HOME','COREPACK_HOME',
  'GITHUB_ACTIONS','CI','RUNNER_ENVIRONMENT','RUNNER_OS','RUNNER_ARCH','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT',
  'GITHUB_WORKFLOW','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID','GITHUB_JOB']
  .filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
 const {buildEnv}=buildEnvironment({...buildEnvInput,AIHR_CI_HEAD:exact,AIHR_CI_CONTROL_HEAD:env.GITHUB_WORKFLOW_SHA,
  NEXT_TELEMETRY_DISABLED:'1'},readFileSync('/proc/meminfo','utf8'));
 const log=openSync(join(privateRoot,'canonical-build.log'),'wx',0o600);
 try{
  const result=spawnSync(process.execPath,['.github/ci/build-heap.mjs','measure',join(privateRoot,'build-memory'),'--','pnpm','build'],
   {cwd:root,env:buildEnv,stdio:['ignore',log,log],timeout:900000,killSignal:'SIGKILL'});
  const canonicalBuildExit=Number.isInteger(result.status)?result.status:null;
  if(canonicalBuildExit!==0){
   emit({kind:'actual-next-artifact',canonicalBuildExit,timedOut:result.error?.code==='ETIMEDOUT',result:'build-refused'});
   return;
  }
  clean();
  const build=join(root,'.next');
  const resultCode=attempt(snapshot);
  const nativeMemberCensus=memberPolicyCensus(build);
  // Use the actual release inventory reader only for a closed read-only census.
  // Do not write a package, an archive or a reusable worker prerequisite.
  const check=spawnSync('/usr/bin/python3',['-I','-B','-c',[
   'import importlib.util,json,sys',
   'from pathlib import Path',
   "s=importlib.util.spec_from_file_location('native_build_bundle',Path('.github/ci/build-bundle.py'))",
   'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
   'files,dirs,aliases=m.scan(Path.cwd())',
   "print(json.dumps({'files':len(files),'directories':len(dirs),'runtimeAliases':sorted(a['package'] for a in aliases)}))",
  ].join('\n')],{cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},encoding:'utf8',timeout:180000,maxBuffer:16384});
  let census=null;
  if(check.status===0){
   const value=JSON.parse(check.stdout);
   if(Object.keys(value).sort().join(',')==='directories,files,runtimeAliases'&&Number.isSafeInteger(value.files)
    &&value.files>0&&value.files<=40000&&Number.isSafeInteger(value.directories)&&value.directories>=1&&value.directories<=40000
    &&JSON.stringify(value.runtimeAliases)==='["fontkit","sharp"]')census=value;
  }
  emit({kind:'actual-next-artifact',canonicalBuildExit,timedOut:false,umask:process.umask().toString(8).padStart(4,'0'),
   nextMode:modeBits(build),buildIdMode:modeBits(join(build,'BUILD_ID')),result:resultCode,nativeMemberCensus,canonicalInventory:census});
 }finally{closeSync(log);snapshot.close();}
}

let buildEnvironment;
if(mode==='fast'){
 syntheticArm('runner-default',process.umask());
 syntheticArm('controlled-0022',0o022);
 syntheticArm('controlled-0022-runtime-aliases',0o022,true);
}else{
 ({systemBuildEnvironment:buildEnvironment}=await import(pathToFileURL(join(root,'scripts/performance/build-environment.mjs'))));
 actualBuild();
}
