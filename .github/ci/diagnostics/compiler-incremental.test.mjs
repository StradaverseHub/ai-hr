/** Controller boundaries and tiny owned Node processes only; never execute TypeScript. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateCompilerPhase,measuredCommand,compilerBenchmark} from './compiler-incremental.mjs';
const ok={code:0,signal:null,timedOut:false},bad={code:2,signal:null,timedOut:false},count='Files: 12500\n';
test('whole compiler needs actual zero exit and positive complete inventory',()=>{
 assert.equal(validateCompilerPhase(ok,count).files,12500);
 for(const result of [{...ok,code:1},{...ok,code:null},{...ok,signal:'SIGTERM'},{...ok,timedOut:true}])assert.throws(()=>validateCompilerPhase(result,count));
 for(const text of ['', 'Files: 0\n', 'x.ts(1,1): error TS2322: bad\n'+count])assert.throws(()=>validateCompilerPhase(ok,text));
});
test('negative controls require exactly the owned TS2322 and diagnostic exit',()=>{
 const path='owned/consumer.ts',text=path+'(2,14): error TS2322: incompatible types\n'+count;
 assert.equal(validateCompilerPhase(bad,text,path).expectedError,true);
 for(const [result,log]of [[ok,text],[{...bad,code:137},text],[{...bad,signal:'SIGKILL'},text],[{...bad,timedOut:true},text],[bad,text.replace('2322','2307')],[bad,text.replace('owned/consumer.ts','foreign.ts')],[bad,text+text],[bad,text+'error TS2688: foreign global error\n'],[bad,count]])assert.throws(()=>validateCompilerPhase(result,log,path));
});
test('tiny owned command retains success and nonzero exit, bounds its own timeout',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'compiler-command-')));
 try{
  const run=(code,name)=>measuredCommand(process.execPath,['-e',code],{cwd:dir,env:process.env,log:join(dir,name),timeoutMs:3000});
  assert.equal((await run('process.exit(0)','success')).code,0);
  assert.equal((await run('process.exit(7)','failure')).code,7);
  const timed=await measuredCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,env:process.env,log:join(dir,'timeout'),timeoutMs:40,graceMs:20});
  assert.equal(timed.timedOut,true);assert.notEqual(timed.code,0);
 }finally{rmSync(dir,{recursive:true});}
});
test('compiler diagnostic refuses non-runner invocation before source access',async()=>{
 const previous=process.env.GITHUB_ACTIONS;
 try{process.env.GITHUB_ACTIONS='false';await assert.rejects(compilerBenchmark(),/Managed company runner/);}
 finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}
});
