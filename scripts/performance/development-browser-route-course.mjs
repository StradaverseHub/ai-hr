/** Fixed hosted development route coverage. This predicate grants no launch capability. */
import assert from 'node:assert/strict';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {join} from 'node:path';

const branch='codex/architecture-five-item-browser-convergence-20261109';
const ref='refs/heads/'+branch;
const repository='StradaverseHub/ai-hr';
const workflow=repository+'/.github/workflows/alpha-focused-checks.yml@'+ref;
const identity=(left,right)=>['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(key=>left[key]===right[key]);
const eventLimit=64*1024;

function readEvent(temp,named){
 const path=join(temp,'_github_workflow','event.json');
 assert(path===named&&realpathSync(temp)===temp&&realpathSync(path)===path,'Full development browser event path refused');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd,{bigint:true});
  assert(before.isFile()&&before.uid===BigInt(process.getuid())&&before.nlink===1n&&(before.mode&0o022n)===0n
   &&before.size>0n&&before.size<=BigInt(eventLimit)&&identity(before,lstatSync(path,{bigint:true})),
   'Full development browser event identity refused');
  const raw=Buffer.alloc(Number(before.size)+1);
  let size=0;
  while(size<raw.length){
   const count=readSync(fd,raw,size,raw.length-size,null);
   if(count===0)break;
   size+=count;
  }
  assert(BigInt(size)===before.size&&identity(before,fstatSync(fd,{bigint:true}))&&identity(before,lstatSync(path,{bigint:true}))
   &&realpathSync(path)===path,'Full development browser event changed');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(0,size)));}
  catch{throw Error('Full development browser event encoding refused');}
 }finally{closeSync(fd);}
}

export function fullDevelopmentBrowserRouteCourse(env){
 if(env.PERF_HTTP_SUITE!=='workflow-preflight'||(env.GITHUB_REF!==ref&&env.GITHUB_REF_NAME!==branch))return false;
 const sha=env.GITHUB_WORKFLOW_SHA;
 const required={
  GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',
  GITHUB_REPOSITORY:repository,GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_JOB:'selected-tests',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_REF:ref,GITHUB_REF_NAME:branch,GITHUB_WORKFLOW_REF:workflow,GITHUB_SHA:sha,AIHR_CI_CONTROL_HEAD:sha,AIHR_CI_HEAD:sha,
  PERF_APP_WORKERS:'2',PERF_APP_POOL_CONNECTIONS:'16',PERF_APP_TOTAL_HEAP_MIB:'4096',PERF_ATTENDANCE_DAYS:'180',
  PERF_HTTP_THINK_MS:'1000',PERF_HTTP_HOLD_MS:'30000',
 };
 assert(typeof sha==='string'&&/^[a-f0-9]{40}(?![\s\S])/.test(sha)
  &&Object.entries(required).every(([key,value])=>env[key]===value)
  &&typeof env.GITHUB_RUN_ID==='string'&&/^[1-9][0-9]{0,15}(?![\s\S])/.test(env.GITHUB_RUN_ID)
  &&Number.isSafeInteger(Number(env.GITHUB_RUN_ID)),'Full development browser hosted identity refused');
 const event=readEvent(env.RUNNER_TEMP,env.GITHUB_EVENT_PATH);
 assert(event&&(event.ref===branch||event.ref===ref)&&event.repository?.id===1333414856
  &&event.repository.full_name===repository&&event.repository.private===false&&event.repository.fork===false
  &&event.repository.default_branch==='main'&&event.inputs&&Object.getPrototypeOf(event.inputs)===Object.prototype,
  'Full development browser event refused');
 const inputs={model_eval:'',eval_allowed_providers:'',...event.inputs};
 const expected={
  candidate_ref:branch,expected_sha:sha,selected_tests:'[]',architecture_browser_development_preflight:'true',
  employee_ascii_qualification:'off',qualify_restricted_port_prerequisites:'false',profile_database:'false',duration_order:'false',
  run_typecheck:'false',run_native_typecheck:'false',run_native_swift_models:'false',run_native_bundle:'false',
  run_build:'false',model_eval:'',eval_budget_usd:'20',eval_allowed_providers:'',
 };
 assert(Object.keys(inputs).length===Object.keys(expected).length&&Object.entries(expected).every(([key,value])=>inputs[key]===value),
  'Full development browser dispatch inputs refused');
 return true;
}
