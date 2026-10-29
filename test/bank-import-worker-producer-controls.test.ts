/** Controller development controls only. No application imports, DB fixtures or release acceptance. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {closeSync,mkdtempSync,openSync,readFileSync,readSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const githubLinux=process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.platform==='linux';

// execFileSync throws on a nonzero exit, signal or timeout. Capture successful stderr too:
// Python unittest reports its executed count there, and a silent child is insufficient evidence.
function execute(file:string,args:string[]){
 const directory=mkdtempSync(join(tmpdir(),'bank-producer-controls-'));
 const stderrPath=join(directory,'stderr');
 const stderrFd=openSync(stderrPath,'wx',0o600);
 try{
  const stdout=execFileSync(file,args,{cwd:process.cwd(),encoding:'utf8',timeout:60_000,maxBuffer:4*1024**2,stdio:['ignore','pipe',stderrFd]});
  return {exitCode:0,stdout,stderr:readFileSync(stderrPath,'utf8')};
 }catch(error){
  // A redirected child stderr is absent from execFileSync's error. Preserve bounded failure
  // evidence before cleanup, then retain the original exit/signal/timeout failure unchanged.
  let reader:number|undefined;
  try{
   reader=openSync(stderrPath,'r');
   const bytes=Buffer.alloc(64*1024);
   const count=readSync(reader,bytes,0,bytes.length,0);
   if(count)console.error('Producer control child stderr (first 64 KiB):\n'+bytes.subarray(0,count).toString('utf8'));
  }catch{console.error('Producer control child stderr could not be read before cleanup.');}
  finally{if(reader!==undefined){try{closeSync(reader);}catch{/* Preserve the original child failure. */}}}
  throw error;
 }finally{closeSync(stderrFd);rmSync(directory,{recursive:true,force:true});}
}

describe.skipIf(!githubLinux)('Bank worker producer controller controls on disposable GitHub Linux',()=>{
 let executed=0;
 beforeAll(()=>{expect(githubLinux,'These child controls require actual GitHub Linux CI').toBe(true);});
 afterAll(()=>{expect(executed,'Both real child control reports must have been checked').toBe(2);});

 it('executes all four existing package, installer, recovery and variant control groups without skips',()=>{
  const result=execute(process.execPath,['--test','--test-reporter=tap','scripts/bank-import-worker-package.test.mjs']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^# tests 4\s*$/m);
  expect(result.stdout).toMatch(/^# pass 4\s*$/m);
  expect(result.stdout).toMatch(/^# fail 0\s*$/m);
  expect(result.stdout).toMatch(/^# cancelled 0\s*$/m);
  expect(result.stdout).toMatch(/^# skipped 0\s*$/m);
  expect(result.stdout).toMatch(/^# todo 0\s*$/m);
  expect(result.stdout).not.toMatch(/\b(?:SKIP|TODO)\b/);
  expect(result.stderr).toBe('');
  executed++;
 },70_000);

 it('executes all four explicit source pin and ordinary source ledger refusal controls without skips',()=>{
  const result=execute('python3',['-I','-B','scripts/ci-bank-import-worker-producer-controls.test.py']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/^Ran 4 tests in [0-9.]+s\s*$/m);
  expect(result.stderr).toMatch(/^OK\s*$/m);
  expect(result.stderr).not.toMatch(/\b(?:skipped|FAILED|ERROR|FAIL)\b/i);
  executed++;
 },70_000);
});
