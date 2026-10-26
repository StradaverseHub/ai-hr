/** Tiny controller/file fixtures only; no application or PostgreSQL runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compareCases,ownedCommand,benchmark} from './attendance-split-benchmark.mjs';
const result=names=>({testResults:[{assertionResults:names.map(fullName=>({fullName}))}]});
test('comparison preserves the complete case multiset including repeated names',()=>{
 assert.equal(compareCases(result(['a','b','a']),result(['b','a','a'])),true);
 for(const names of [['a','b'],['a','b','c'],['a','b','b']])assert.throws(()=>compareCases(result(['a','b','a']),result(names)));
});
test('owned tiny process success records zero; failure refuses before another phase',async()=>{
 const p=realpathSync(mkdtempSync(join(tmpdir(),'attendance-command-')));
 try{
  assert.equal((await ownedCommand(process.execPath,['-e','process.exit(0)'],{cwd:p,env:process.env,log:join(p,'pass.log'),timeoutMs:3000})).code,0);
  await assert.rejects(ownedCommand(process.execPath,['-e','process.exit(7)'],{cwd:p,env:process.env,log:join(p,'fail.log'),timeoutMs:3000}),/failed\/timed out/);
 }finally{rmSync(p,{recursive:true,force:true});}
});
test('owned tiny process timeout refuses with bounded termination',async()=>{
 const p=realpathSync(mkdtempSync(join(tmpdir(),'attendance-timeout-')));
 try{await assert.rejects(ownedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:p,env:process.env,log:join(p,'timeout.log'),timeoutMs:40,graceMs:20}),/failed\/timed out/);}
 finally{rmSync(p,{recursive:true,force:true});}
});
test('application benchmark refuses outside a managed runner before source or database access',async()=>{
 const previous=process.env.GITHUB_ACTIONS;
 try{process.env.GITHUB_ACTIONS='false';await assert.rejects(benchmark());}
 finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}
});
