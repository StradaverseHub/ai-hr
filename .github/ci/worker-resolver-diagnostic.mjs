/** Historical, read-only replay. No worker prerequisite handle or workflow output is produced. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository='StradaverseHub/ai-hr';
const repositoryId=1333414856;
const workflowId=395862645;
const workflowPath='.github/workflows/alpha-focused-checks.yml';
const branch='codex/architecture-61067-worker-resolver-diagnostic-20261110';
const ref='refs/heads/'+branch;
const originalBranch='codex/architecture-five-item-browser-convergence-20261109';
const source='61067d5b8b15f81e378088c9aff0b7a3b9f67987';
const ancestry='f919bef2deff9bfc56448a63fb5d17d8bd42ec2a';
const upstreamRun=42716409189;
const failedRun=42719214369;
const failedJob=129508572860;
const failedStart='2026-11-09T23:17:17Z';
const artifactId=13718813875;
const archiveBytes=12217;
const archiveSha='d52d2d6c96e5e48ccbb396f029606aab4594c2375ba4b1e12318902ab2378dd8';
const environment=Object.freeze({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});
const deadline=performance.now()+150000;
const json=raw=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
const statKeys=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
const sameStat=(a,b)=>statKeys.every(key=>a[key]===b[key]);
let stage='entry';

function phase(name,fn){
 stage=name;
 const result=fn();
 console.log('worker-resolver-diagnostic passed '+name);
 return result;
}
function left(limit=15000){
 const wait=Math.min(limit,Math.floor(deadline-performance.now()));
 assert(wait>0);
 return wait;
}
function run(file,args,env=environment){
 return execFileSync(file,args,{env,timeout:left(),killSignal:'SIGKILL',maxBuffer:1024**2,stdio:['ignore','pipe','pipe']});
}
function heldEvent(path){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd,{bigint:true});
  assert(before.isFile()&&before.uid===BigInt(process.getuid())&&before.nlink===1n&&!(before.mode&0o022n)
   &&before.size>0n&&before.size<=65536n&&sameStat(before,lstatSync(path,{bigint:true})));
  const bytes=Buffer.alloc(Number(before.size)+1);
  let size=0;
  while(size<bytes.length){
   const count=readSync(fd,bytes,size,bytes.length-size,null);
   if(!count)break;
   size+=count;
  }
  assert(BigInt(size)===before.size&&sameStat(before,fstatSync(fd,{bigint:true}))
   &&sameStat(before,lstatSync(path,{bigint:true}))&&realpathSync(path)===path);
  return bytes.subarray(0,size);
 }finally{closeSync(fd);}
}
const sameRepo=row=>row?.id===repositoryId&&row.full_name===repository;

try{
 const env=process.env;
 const controller=env.GITHUB_WORKFLOW_SHA;
 phase('diagnostic-event-environment',()=>{
  const expected={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',
   GITHUB_REPOSITORY:repository,GITHUB_REPOSITORY_ID:String(repositoryId),GITHUB_EVENT_NAME:'workflow_dispatch',
   GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_JOB:'worker-resolver-diagnostic',GITHUB_RUN_ATTEMPT:'1',
   GITHUB_REF:ref,GITHUB_WORKFLOW_REF:repository+'/'+workflowPath+'@'+ref,GITHUB_SHA:controller,
   AIHR_CI_CONTROL_HEAD:controller,STAGING_ENABLED:'false',PRODUCTION_ENABLED:'false'};
  assert(/^[a-f0-9]{40}$/.test(controller)&&controller!==source&&/^[1-9][0-9]{0,15}$/.test(env.GITHUB_RUN_ID));
  assert(Object.entries(expected).every(([key,value])=>env[key]===value));
 });
 const temp=phase('runner-temp',()=>{
  const dir=env.RUNNER_TEMP;
  assert(typeof dir==='string'&&realpathSync(dir)===dir&&lstatSync(dir).isDirectory()&&lstatSync(dir).uid===process.getuid());
  return dir;
 });
 const eventPath=phase('event-path',()=>{
  const path=join(temp,'_github_workflow','event.json');
  assert(env.GITHUB_EVENT_PATH===path&&realpathSync(path)===path);
  return path;
 });
 const eventBytes=phase('event-owner-mode-custody',()=>heldEvent(eventPath));
 phase('diagnostic-event-payload',()=>{
  const event=json(eventBytes);
  assert(sameRepo(event.repository)&&event.repository.private===false&&event.repository.fork===false&&event.repository.default_branch==='main');
  assert(event.ref===branch||event.ref===ref);
  assert.deepEqual({model_eval:'',eval_allowed_providers:'',measured_browser_preflight_run:'',...event.inputs},{
   candidate_ref:branch,expected_sha:source,selected_tests:'[]',architecture_browser_development_preflight:'false',
   measured_browser_course:'off',measured_browser_preflight_run:'',employee_ascii_qualification:'off',
   qualify_restricted_port_prerequisites:'false',profile_database:'false',duration_order:'false',
   run_typecheck:'false',run_native_typecheck:'false',run_native_swift_models:'false',run_native_bundle:'false',
   run_build:'false',model_eval:'',eval_budget_usd:'20',eval_allowed_providers:''});
 });
 const workspace=env.GITHUB_WORKSPACE;
 const automation=join(workspace,'automation');
 const checkout=join(workspace,'source');
 const git=(root,...args)=>run('/usr/bin/git',['--no-optional-locks','-C',root,...args]).toString('utf8').trim();
 phase('checkout-path-head',()=>{
  assert(realpathSync(workspace)===workspace&&realpathSync(automation)===automation&&realpathSync(checkout)===checkout);
  assert(git(automation,'rev-parse','HEAD')===controller&&git(checkout,'rev-parse','HEAD')===source);
 });
 phase('checkout-origin-status',()=>{
  for(const root of [automation,checkout]){
   assert(git(root,'status','--porcelain')==='');
   assert(['https://github.com/'+repository,'https://github.com/'+repository+'.git'].includes(git(root,'remote','get-url','origin')));
  }
 });
 phase('checkout-ancestry',()=>git(checkout,'merge-base','--is-ancestor',ancestry,source));
 const token=phase('action-read-credential',()=>{
  const value=env.GH_TOKEN;
  assert(typeof value==='string'&&value.length>0&&value.length<=4096);
  return value;
 });
 delete env.GH_TOKEN;
 const privateDirectory=phase('private-archive-directory',()=>{
  const directory=mkdtempSync(join(temp,'measured-preflight-archive-'));
  const stat=lstatSync(directory);
  assert(realpathSync(directory)===directory&&stat.isDirectory()&&stat.uid===process.getuid()&&(stat.mode&0o777)===0o700);
  mkdirSync(join(directory,'gh'),{mode:0o700});
  return directory;
 });
 const github={...environment,GH_TOKEN:token,GH_CONFIG_DIR:join(privateDirectory,'gh'),GH_PROMPT_DISABLED:'1',
  GH_NO_UPDATE_NOTIFIER:'1',GH_NO_EXTENSION_UPDATE_NOTIFIER:'1'};
 const root='repos/'+repository;
 const args=suffix=>['api','--hostname','github.com','--method','GET',root+suffix];
 const get=(label,suffix)=>phase(label,()=>json(run('/usr/bin/gh',args(suffix),github)));
 const historical=get('get-failed-worker-run','/actions/runs/'+failedRun);
 phase('failed-worker-historical-identity',()=>{
  assert(historical.id===failedRun&&sameRepo(historical.repository)&&sameRepo(historical.head_repository)
   &&historical.workflow_id===workflowId&&historical.path===workflowPath&&historical.head_sha===source
   &&historical.head_branch===originalBranch&&historical.event==='workflow_dispatch'&&historical.run_attempt===1
   &&historical.status==='completed'&&historical.conclusion==='failure'&&historical.run_started_at===failedStart);
 });
 const failed=get('get-failed-worker-resolve','/actions/jobs/'+failedJob);
 phase('failed-worker-resolve-identity',()=>{
  assert(failed.id===failedJob&&failed.run_id===failedRun&&failed.head_sha===source&&failed.run_attempt===1
   &&failed.name==='resolve'&&failed.status==='completed'&&failed.conclusion==='failure');
  const step=failed.steps.filter(row=>row.name==='Authenticate same-source full browser preflight for the worker comparison');
  assert(step.length===1&&step[0].status==='completed'&&step[0].conclusion==='failure');
 });
 const upstream='/actions/runs/'+upstreamRun;
 const metadata={
  repository:get('get-repository',''),workflow:get('get-workflow','/actions/workflows/'+workflowId),
  run:get('get-browser-run',upstream),jobInventory:get('get-browser-jobs',upstream+'/jobs?filter=all&per_page=8&page=1'),
  artifactInventory:get('get-browser-artifact-inventory',upstream+'/artifacts?per_page=2&page=1'),
 };
 stage='import-exact-source-models';
 const load=name=>import(pathToFileURL(join(checkout,'.github','ci',name)).href);
 const {inspectMeasuredPreflightProviderMetadata}=await load('measured-browser-worker-contract.mjs');
 const {inspectMeasuredPreflightArchiveBytes}=await load('measured-browser-preflight-archive.mjs');
 const {downloadCiArchives,readCiArchive}=await load('archive-downloads.mjs');
 console.log('worker-resolver-diagnostic passed '+stage);
 const identity=phase('browser-metadata-historical',()=>{
  const verified=inspectMeasuredPreflightProviderMetadata(metadata,{source,upstreamRunId:upstreamRun,
   currentRunId:failedRun,currentRunStartedAt:failedStart,nowMs:Date.parse(failedStart)});
  assert(verified.artifactId===artifactId&&verified.archiveBytes===archiveBytes&&verified.archiveSha256===archiveSha);
  return verified;
 });
 const artifact=metadata.artifactInventory.artifacts[0];
 stage='authenticated-archive-transfer';
 await downloadCiArchives([artifact],privateDirectory,{concurrency:1,timeoutMs:left(100000),
  start:()=>spawn('/usr/bin/gh',args('/actions/artifacts/'+identity.artifactId+'/zip'),{env:github,stdio:['ignore','pipe','pipe']})});
 console.log('worker-resolver-diagnostic passed '+stage);
 const bytes=phase('independent-archive-digest',()=>{
  const bytes=readCiArchive(artifact,join(privateDirectory,artifact.name+'.zip'));
  assert(bytes.length===archiveBytes&&createHash('sha256').update(bytes).digest('hex')===archiveSha);
  return bytes;
 });
 phase('exact-browser-archive-parser',()=>inspectMeasuredPreflightArchiveBytes(bytes,{source,runId:upstreamRun},left()));
 phase('checkout-final-status',()=>{
  assert(git(checkout,'rev-parse','HEAD')===source&&git(checkout,'status','--porcelain')==='');
  assert(git(automation,'rev-parse','HEAD')===controller&&git(automation,'status','--porcelain')==='');
 });
 console.log('worker-resolver-diagnostic historical-replay-complete');
}catch{
 process.stderr.write('worker-resolver-diagnostic refused '+stage+'\n');
 process.exitCode=1;
}finally{delete process.env.GH_TOKEN;}
