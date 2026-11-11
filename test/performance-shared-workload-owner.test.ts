import {expect,it} from 'vitest';
import {spawnClosedTextSync,type ClosedChildEnvironment} from './helpers/closed-child-process.mjs';
import {mkdtempSync,mkdirSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fullDevelopmentBrowserRouteCourse} from '../scripts/performance/development-browser-route-course.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const tsx=createRequire(import.meta.url).resolve('tsx');
const courses=[
 {name:'fixture',owner:'system-fixture-owner.mjs',entry:'system-fixture.mjs',exportName:'runDevelopmentSystemFixture'},
 {name:'load',owner:'system-load-owner.mjs',entry:'system-load.mjs',exportName:'runDevelopmentSystemLoad'},
]as const;
type Course=typeof courses[number];
const developmentUrl='postgres://performance_guard_never_provisioned@127.0.0.1:5433/ai_hr_dev';
const nativeUrl='postgres://performance_guard_never_provisioned@127.0.0.1:5433/ai_hr_test_w1';

function withScratch(run:(paths:{privateDir:string;evidenceDir:string;env:ClosedChildEnvironment})=>void){
 const scratch=mkdtempSync(join(tmpdir(),'aihr-workload-entry-'));
 const privateDir=join(scratch,'private'),evidenceDir=join(scratch,'evidence');
 mkdirSync(privateDir);mkdirSync(evidenceDir);
 // No inherited DB/auth/Node options or browser credentials. Invalid entry controls must
 // stop before dynamic application imports; audit=false and absent fixture.json also
 // prevent these no-DB controls from ever entering a valid development workload.
 const env:ClosedChildEnvironment={PATH:process.env.PATH??'',HOME:scratch,TMPDIR:scratch,TMP:scratch,TEMP:scratch,LANG:'C',TZ:'UTC',
  GITHUB_ACTIONS:'true',AUTH_PROVIDER:'internal',DATABASE_URL:developmentUrl,MIGRATION_DATABASE_URL:developmentUrl,
  AUDIT_HASH_CHAIN_ENABLED:'false',PERF_PRIVATE_DIR:privateDir,PERF_EVIDENCE_DIR:evidenceDir};
 try{run({privateDir,evidenceDir,env});}finally{rmSync(scratch,{recursive:true,force:true});}
}
function child(source:string,env:ClosedChildEnvironment){
 return spawnClosedTextSync(process.execPath,['--import',tsx,'--input-type=module','-e',source],{
  cwd:root,env,encoding:'utf8',timeout:10000,maxBuffer:256*1024,
 });
}
function entryGuard(course:Course,env:ClosedChildEnvironment){
 const url=new URL('../scripts/performance/'+course.entry,import.meta.url).href;
 // Import the real fixed legacy entry, which actually invokes its owner. Preserve the
 // native assertion fields and stderr, with a distinct bounded failed-child status.
 return child(`try{await import(${JSON.stringify(url)});throw Error('Development workload unexpectedly completed');}
 catch(error){if(error?.code!=='ERR_ASSERTION')throw error;console.error(error.stack);
 console.log(JSON.stringify({code:error.code,actual:error.actual,expected:error.expected,operator:error.operator}));process.exitCode=19;}`,env);
}
function expectGuard(course:Course,env:ClosedChildEnvironment,actual:string,expected:string){
 const result=entryGuard(course,env);
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(19);
 expect(JSON.parse(result.stdout.trim())).toEqual({code:'ERR_ASSERTION',actual,expected,operator:'strictEqual'});
 expect(result.stderr).toContain('AssertionError');expect(result.stderr).toContain(course.owner);
}

it.each(courses)('imports the $name development owner without invoking the workload or creating artifacts',course=>{
 withScratch(({privateDir,evidenceDir,env})=>{
  const url=new URL('../scripts/performance/'+course.owner,import.meta.url).href;
  // If import invokes the workload, the unchanged first CI guard rejects. No test
  // replaces a DB/principal/browser/command owner or submits real workload data.
  const result=child(`import assert from 'node:assert/strict';const loaded=await import(${JSON.stringify(url)});
 assert.deepEqual(Object.keys(loaded),[${JSON.stringify(course.exportName)}]);
 assert.equal(typeof loaded[${JSON.stringify(course.exportName)}],'function');
 assert.equal(loaded[${JSON.stringify(course.exportName)}].length,0);console.log('IMPORTED_WITHOUT_WORKLOAD');`,{...env,GITHUB_ACTIONS:'false'});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(0);
  expect(result.stderr).toBe('');expect(result.stdout.trim()).toBe('IMPORTED_WITHOUT_WORKLOAD');
  expect(readdirSync(privateDir)).toEqual([]);expect(readdirSync(evidenceDir)).toEqual([]);
 });
},15000);

it('loads the Rewards draft fixture with the React server condition',()=>{
 withScratch(({privateDir,evidenceDir,env})=>{
  const url=new URL('../scripts/performance/reward-draft-fixture.mjs',import.meta.url).href;
  const result=spawnClosedTextSync(process.execPath,[
   '--conditions=react-server','--import',tsx,'--input-type=module','-e',
   `import assert from 'node:assert/strict';const fixture=await import(${JSON.stringify(url)});
 assert.equal(typeof fixture.prepareRewardDraftFixture,'function');console.log('REWARDS_DRAFT_FIXTURE_IMPORTED');`,
  ],{cwd:root,env,encoding:'utf8',timeout:10000,maxBuffer:256*1024});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(0);
  expect(result.stderr).toBe('');expect(result.stdout.trim()).toBe('REWARDS_DRAFT_FIXTURE_IMPORTED');
  expect(readdirSync(privateDir)).toEqual([]);expect(readdirSync(evidenceDir)).toEqual([]);
 });
},15000);

it.each(courses)('refuses the real $name legacy entry outside GitHub before dynamic application work',course=>{
 withScratch(({privateDir,evidenceDir,env})=>{
  expectGuard(course,{...env,GITHUB_ACTIONS:'false'},'false','true');
  expect(readdirSync(privateDir)).toEqual([]);expect(readdirSync(evidenceDir)).toEqual([]);
 });
},15000);

it('cannot select the native rendered course through public development arguments or environment',()=>{
 withScratch(({privateDir,evidenceDir,env})=>{
  writeFileSync(join(privateDir,'fixture.json'),'{}',{flag:'wx',mode:0o600});
  const url=new URL('../scripts/performance/system-load-owner.mjs',import.meta.url).href;
  const result=child(`import assert from 'node:assert/strict';const owner=await import(${JSON.stringify(url)});
   assert.deepEqual(Object.keys(owner),['runDevelopmentSystemLoad']);
   try{await owner.runDevelopmentSystemLoad({deadline:performance.now()+60000});throw Error('Unexpected workload');}
   catch(error){assert.equal(error.code,'ERR_ASSERTION');assert.match(error.message,/includes\\(suite\\)/);}
   console.log('DEVELOPMENT_SUITE_REFUSED');`,{...env,PERF_HTTP_SUITE:'native-rendered-preflight',AIHR_NATIVE_PREFLIGHT:'true'});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(0);
  expect(result.stderr).toBe('');expect(result.stdout.trim()).toBe('DEVELOPMENT_SUITE_REFUSED');
  expect(readdirSync(privateDir)).toEqual(['fixture.json']);expect(readdirSync(evidenceDir)).toEqual([]);
 });
},15000);

it.each([
 {name:'fixture hostname',course:courses[0],key:'DATABASE_URL',url:'postgres://performance_guard_never_provisioned@example.invalid:5433/ai_hr_dev',actual:'example.invalid',expected:'127.0.0.1'},
 {name:'fixture port',course:courses[0],key:'DATABASE_URL',url:'postgres://performance_guard_never_provisioned@127.0.0.1:1/ai_hr_dev',actual:'1',expected:'5433'},
 {name:'fixture application native realm',course:courses[0],key:'DATABASE_URL',url:nativeUrl,actual:'/ai_hr_test_w1',expected:'/ai_hr_dev'},
 {name:'fixture migration native realm',course:courses[0],key:'MIGRATION_DATABASE_URL',url:nativeUrl,actual:'/ai_hr_test_w1',expected:'/ai_hr_dev'},
 {name:'load native realm',course:courses[1],key:'DATABASE_URL',url:nativeUrl,actual:'/ai_hr_test_w1',expected:'/ai_hr_dev'},
])('retains the exact $name refusal without DB work or workload artifacts',({course,key,url,actual,expected})=>{
 withScratch(({privateDir,evidenceDir,env})=>{
  expectGuard(course,{...env,[key]:url},actual,expected);
  expect(readdirSync(privateDir)).toEqual([]);expect(readdirSync(evidenceDir)).toEqual([]);
 });
},15000);


it('admits only the exact self-source development event and never a steady or ordinary route selection',()=>{
 withScratch(({privateDir})=>{
  const repository='StradaverseHub/ai-hr',branch='claude/worker-compare-main-20261111';
  const ref='refs/heads/'+branch,sha='a'.repeat(40),temp=realpathSync(privateDir);
  const eventDir=join(temp,'_github_workflow'),eventPath=join(eventDir,'event.json');
  mkdirSync(eventDir);
  const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',
   GITHUB_REPOSITORY:repository,GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',
   GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_JOB:'selected-tests',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'1234',
   GITHUB_REF:ref,GITHUB_REF_NAME:branch,GITHUB_WORKFLOW_REF:repository+'/.github/workflows/alpha-focused-checks.yml@'+ref,
   GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,AIHR_CI_CONTROL_HEAD:sha,AIHR_CI_HEAD:sha,
   RUNNER_TEMP:temp,GITHUB_EVENT_PATH:eventPath,PERF_HTTP_SUITE:'workflow-preflight',AIHR_MEASURED_BROWSER_COURSE:'preflight-2',
   PERF_APP_WORKERS:'2',PERF_APP_POOL_CONNECTIONS:'16',PERF_APP_TOTAL_HEAP_MIB:'4096',PERF_ATTENDANCE_DAYS:'180',
   PERF_HTTP_THINK_MS:'1000',PERF_HTTP_HOLD_MS:'30000'};
  const inputs={candidate_ref:branch,expected_sha:sha,selected_tests:'[]',architecture_browser_development_preflight:'false',measured_browser_course:'preflight-2',
   employee_ascii_qualification:'off',qualify_restricted_port_prerequisites:'false',profile_database:'false',duration_order:'false',
   run_typecheck:'false',run_native_typecheck:'false',run_native_swift_models:'false',run_native_bundle:'false',
   run_build:'false',eval_budget_usd:'20'};
  const repo={id:1333414856,full_name:repository,private:false,fork:false,default_branch:'main'};
  const event={ref:branch,repository:repo,inputs};
  const write=(value:unknown)=>writeFileSync(eventPath,JSON.stringify(value),{mode:0o600});
  write(event);
  expect(fullDevelopmentBrowserRouteCourse(env)).toBe(true);
  write({...event,inputs:{...inputs,model_eval:'',eval_allowed_providers:''}});
  expect(fullDevelopmentBrowserRouteCourse(env)).toBe(true);
  for(const suite of ['claims-heavy','whole-system','native-rendered-preflight'])
   expect(fullDevelopmentBrowserRouteCourse({...env,PERF_HTTP_SUITE:suite})).toBe(false);
  expect(fullDevelopmentBrowserRouteCourse({...env,GITHUB_REF:'refs/heads/main',GITHUB_REF_NAME:'main'})).toBe(false);
  expect(fullDevelopmentBrowserRouteCourse({...env,AIHR_MEASURED_BROWSER_COURSE:'off'})).toBe(false);
  for(const wrong of [{GITHUB_JOB:'resolve'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_RUN_ID:'0'},{AIHR_CI_HEAD:'b'.repeat(40)},
   {GITHUB_REF:'refs/tags/other'},{PERF_APP_WORKERS:'4'},{PERF_APP_POOL_CONNECTIONS:'32'},{PERF_HTTP_HOLD_MS:'60000'}])
   expect(()=>fullDevelopmentBrowserRouteCourse({...env,...wrong})).toThrow(/hosted identity refused/);
  for(const wrong of [{model_eval:'preview'},{eval_allowed_providers:null},{selected_tests:'["test/wrong.test.ts"]'},
   {run_build:true},{expected_sha:'b'.repeat(40)},{unknown:'false'}]){
   write({...event,inputs:{...inputs,...wrong}});
   expect(()=>fullDevelopmentBrowserRouteCourse(env)).toThrow(/dispatch inputs refused/);
  }
  const {run_typecheck:_required,...omitted}=inputs;
  write({...event,inputs:omitted});
  expect(()=>fullDevelopmentBrowserRouteCourse(env)).toThrow(/dispatch inputs refused/);
  write({...event,repository:{...repo,private:true}});
  expect(()=>fullDevelopmentBrowserRouteCourse(env)).toThrow(/event refused/);
  write(event);const alternate=join(eventDir,'alternate.json');symlinkSync(eventPath,alternate);
  expect(()=>fullDevelopmentBrowserRouteCourse({...env,GITHUB_EVENT_PATH:alternate})).toThrow(/event path refused/);
  rmSync(eventPath);symlinkSync(alternate,eventPath);
  rmSync(alternate);writeFileSync(alternate,JSON.stringify(event),{mode:0o600});
  expect(()=>fullDevelopmentBrowserRouteCourse(env)).toThrow(/event path refused/);
 });
});
