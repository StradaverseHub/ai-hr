/** CI consumer development controls only. No application imports, DB or full-save acceptance. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {closeSync,mkdtempSync,openSync,readSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const githubLinux=process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.platform==='linux';

function controls(){
 const directory=mkdtempSync(join(tmpdir(),'bank-throughput-controls-'));
 const stderrPath=join(directory,'stderr');
 const stderrFd=openSync(stderrPath,'wx',0o600);
 const boundedStderr=()=>{
  let reader:number|undefined;
  try{
   reader=openSync(stderrPath,'r');
   const bytes=Buffer.alloc(64*1024+1),count=readSync(reader,bytes,0,bytes.length,0);
   return {text:bytes.subarray(0,Math.min(count,64*1024)).toString('utf8'),truncated:count>64*1024};
  }finally{if(reader!==undefined){try{closeSync(reader);}catch{/* Retain the original child result. */}}}
 };
 try{
  const stdout=execFileSync('python3',['-I','-B','scripts/ci-bank-import-worker-throughput-controls.test.py'],{cwd:process.cwd(),encoding:'utf8',timeout:60_000,maxBuffer:1024**2,stdio:['ignore','pipe',stderrFd]});
  return {exitCode:0,stdout,...boundedStderr()};
 }catch(error){
  try{const stderr=boundedStderr();if(stderr.text)console.error('Consumer control child stderr (first 64 KiB):\n'+stderr.text);}
  catch{console.error('Consumer control child stderr could not be read before cleanup.');}
  throw error;
 }finally{
  // Cleanup cannot replace an exit/signal/timeout failure or its original stderr.
  try{closeSync(stderrFd);}catch{/* Best effort after the child is reaped. */}
  try{rmSync(directory,{recursive:true,force:true});}catch{/* Preserve the original result. */}
 }
}

describe.skipIf(!githubLinux)('Bank worker throughput consumer refusal controls on disposable GitHub Linux',()=>{
 let executed=false;
 beforeAll(()=>{expect(githubLinux,'Actual GitHub Linux CI is required').toBe(true);});
 afterAll(()=>{expect(executed,'The real twelve-group child report must be checked').toBe(true);});
 it('executes all twelve pure refusal, lifecycle, private-download and log-retention groups without skips',()=>{
  const result=controls();
  expect(result.exitCode).toBe(0);expect(result.stdout).toBe('');expect(result.truncated).toBe(false);
  expect(result.text).toMatch(/^Ran 12 tests in [0-9.]+s\s*$/m);
  expect(result.text).toMatch(/^OK\s*$/m);
  expect(result.text).not.toMatch(/\b(?:skipped|FAILED|ERROR|FAIL)\b/i);
  executed=true;
 },70_000);
});
