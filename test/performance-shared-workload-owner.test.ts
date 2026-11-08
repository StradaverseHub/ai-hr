import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const tsx=createRequire(import.meta.url).resolve('tsx');
const courses=[
 {name:'fixture',owner:'system-fixture-owner.mjs',entry:'system-fixture.mjs',exportName:'runDevelopmentSystemFixture'},
 {name:'load',owner:'system-load-owner.mjs',entry:'system-load.mjs',exportName:'runDevelopmentSystemLoad'},
]as const;
type Course=typeof courses[number];
const developmentUrl='postgres://performance_guard_never_provisioned@127.0.0.1:5433/ai_hr_dev';
const nativeUrl='postgres://performance_guard_never_provisioned@127.0.0.1:5433/ai_hr_test_w1';

function withScratch(run:(paths:{privateDir:string;evidenceDir:string;env:NodeJS.ProcessEnv})=>void){
 const scratch=mkdtempSync(join(tmpdir(),'aihr-workload-entry-'));
 const privateDir=join(scratch,'private'),evidenceDir=join(scratch,'evidence');
 mkdirSync(privateDir);mkdirSync(evidenceDir);
 // No inherited DB/auth/Node options or browser credentials. Invalid entry controls must
 // stop before dynamic application imports; audit=false and absent fixture.json also
 // prevent these no-DB controls from ever entering a valid development workload.
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'',HOME:scratch,TMPDIR:scratch,TMP:scratch,TEMP:scratch,LANG:'C',TZ:'UTC',
  GITHUB_ACTIONS:'true',AUTH_PROVIDER:'internal',DATABASE_URL:developmentUrl,MIGRATION_DATABASE_URL:developmentUrl,
  AUDIT_HASH_CHAIN_ENABLED:'false',PERF_PRIVATE_DIR:privateDir,PERF_EVIDENCE_DIR:evidenceDir};
 try{run({privateDir,evidenceDir,env});}finally{rmSync(scratch,{recursive:true,force:true});}
}
function child(source:string,env:NodeJS.ProcessEnv){
 return spawnSync(process.execPath,['--import',tsx,'--input-type=module','-e',source],{
  cwd:root,env,encoding:'utf8',timeout:10000,maxBuffer:256*1024,
 });
}
function entryGuard(course:Course,env:NodeJS.ProcessEnv){
 const url=new URL('../scripts/performance/'+course.entry,import.meta.url).href;
 // Import the real fixed legacy entry, which actually invokes its owner. Preserve the
 // native assertion fields and stderr, with a distinct bounded failed-child status.
 return child(`try{await import(${JSON.stringify(url)});throw Error('Development workload unexpectedly completed');}
 catch(error){if(error?.code!=='ERR_ASSERTION')throw error;console.error(error.stack);
 console.log(JSON.stringify({code:error.code,actual:error.actual,expected:error.expected,operator:error.operator}));process.exitCode=19;}`,env);
}
function expectGuard(course:Course,env:NodeJS.ProcessEnv,actual:string,expected:string){
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

it.each(courses)('refuses the real $name legacy entry outside GitHub before dynamic application work',course=>{
 withScratch(({privateDir,evidenceDir,env})=>{
  expectGuard(course,{...env,GITHUB_ACTIONS:'false'},'false','true');
  expect(readdirSync(privateDir)).toEqual([]);expect(readdirSync(evidenceDir)).toEqual([]);
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
