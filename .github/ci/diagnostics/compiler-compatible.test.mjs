/** Pure typed cache policy fixtures; no TypeScript compiler, tests, build or database is started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compatibleCompilerState} from '../../../scripts/ci-compiler-cache-policy.ts';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const originSha='a'.repeat(40),head='b'.repeat(40),d='c'.repeat(64);
const invoked=()=>({options:['--noEmit','--pretty','false','--extendedDiagnostics','--tsBuildInfoFile','.next/cache/compiler-transport/whole-project.tsbuildinfo'],
 nodeOptions:'--max-old-space-size=8192',sourcePath:'/home/runner/work/ai-hr/ai-hr/source',generatedTypes:[{path:'validator.ts',bytes:100,sha256:d}],
 actualCompiler:Object.fromEntries(['package.json','lib/tsc.js','lib/_tsc.js','lib/typescript.js'].map(k=>[k,d])),sourceInvocation:d,
 mobileInputs:{'mobile/package.json':d,'mobile/package-lock.json':d}});
const identity=source=>{const value=invoked();return {source,controller:originSha,runId:'123',attempt:'1',
 runtime:{node:'22.23.3',typescript:'5.9.3',next:'16.3.8',platform:'linux',arch:'x64'},
 inputs:{...Object.fromEntries(['tsconfig','lockfile','package','workspace','nextConfig'].map(k=>[k,d])),compilerCli:hash(value)},invoked:value};};
const comparison=()=>({status:'ahead',ahead_by:1,behind_by:0,total_commits:1,base_commit:{sha:originSha},merge_base_commit:{sha:originSha},
 commits:[{sha:head}],files:[{filename:'scripts/ci-compiler-cache-policy.ts',status:'added'}]});
test('actual child candidate may reuse authenticated compatible graph while full compiler remains mandatory',()=>{
 const v=compatibleCompilerState(identity(originSha),identity(head),comparison());
 assert.equal(v.mandatoryWholeCompiler,true);assert.equal(v.releaseAuthorized,false);
 assert.equal(v.originSource,originSha);assert.equal(v.candidateSource,head);
 const current=identity(head);current.invoked.sourceInvocation='d'.repeat(64);current.inputs.compilerCli=hash(current.invoked);
 assert(compatibleCompilerState(identity(originSha),current,comparison()));
});
test('runtime/configuration/lockfile/native inputs and actual CLI changes require cold compilation',()=>{
 for(const field of ['tsconfig','lockfile','package','workspace','nextConfig']){
  const v=identity(head);v.inputs[field]='d'.repeat(64);assert.throws(()=>compatibleCompilerState(identity(originSha),v,comparison()));
 }
 for(const field of ['node','typescript','next','platform','arch']){
  const v=identity(head);v.runtime[field]='changed';assert.throws(()=>compatibleCompilerState(identity(originSha),v,comparison()));
 }
 for(const mutate of [v=>v.invoked.options.push('--skipLibCheck'),v=>v.invoked.nodeOptions='--max-old-space-size=4096',
  v=>v.invoked.generatedTypes[0].sha256='d'.repeat(64),v=>v.invoked.actualCompiler['lib/tsc.js']='d'.repeat(64),
  v=>v.invoked.mobileInputs['mobile/package.json']='d'.repeat(64),v=>v.invoked.sourcePath='/another/source']){
  const v=identity(head);mutate(v);v.inputs.compilerCli=hash(v.invoked);assert.throws(()=>compatibleCompilerState(identity(originSha),v,comparison()));
 }
});
test('unbound invocation and relabelled cache provenance are rejected',()=>{
 for(const change of [{source:originSha},{controller:head},{runId:'999'},{attempt:'2'}])assert.throws(()=>compatibleCompilerState(identity(originSha),{...identity(head),...change},comparison()));
 const v=identity(head);v.invoked.sourceInvocation='d'.repeat(64);assert.throws(()=>compatibleCompilerState(identity(originSha),v,comparison()));
});
test('diverged/missing/foreign/paginated ancestry and incomplete changed-file inventories are rejected',()=>{
 for(const change of [{status:'diverged'},{behind_by:1},{ahead_by:33},{total_commits:2},{base_commit:{sha:head}},
  {merge_base_commit:{sha:head}},{commits:[]},{commits:[{sha:originSha}]},{files:[]},
  {files:Array.from({length:300},(_,i)=>({filename:'f'+i+'.ts',status:'added'}))},{files:[{filename:'../foreign.ts',status:'added'}]}])
  assert.throws(()=>compatibleCompilerState(identity(originSha),identity(head),{...comparison(),...change}));
});
