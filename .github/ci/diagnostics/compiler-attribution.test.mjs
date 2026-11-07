/** Pure controller boundaries only; the real compiler runs solely in the opt-in hosted job. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compilerArguments,lastCheckedSource,actualCompilerResult,attributeCompiler,ATTRIBUTION_SOURCE,validateAttributionSelection} from './compiler-attribution.mjs';

test('selection admits only the exact source and no other diagnostics or transport',()=>{
 const inputs={expected_sha:ATTRIBUTION_SOURCE,compiler_probe:true,nodb_probe:false,layout_probe:false,next_build_cache_phase:'disabled',
  ...Object.fromEntries(['transport_origin_run','transport_origin_sha','transport_origin_artifact','transport_origin_digest','compiler_origin_run','compiler_origin_sha','compiler_origin_artifact','compiler_origin_digest'].map(key=>[key,'']))};
 assert.doesNotThrow(()=>validateAttributionSelection(inputs));
 for(const changed of [{expected_sha:'0'.repeat(40)},{compiler_probe:false},{nodb_probe:true},{layout_probe:true},{run_build:true},{next_build_cache_phase:'cold'},{compiler_origin_run:'123'},{transport_origin_run:'123'}])assert.throws(()=>validateAttributionSelection({...inputs,...changed}));
});

test('actual GitHub input shape may omit only empty known transport origins',()=>{
 const inputs=JSON.parse('{"candidate_ref":"codex/architecture-combined-compiler-ci-20261108","expected_sha":"fe26d003b9750478e4d434cc9dd22b59092ae830","filesystem_activation_probe":false,"installer_fixture_phase":"full","plan_probe":false,"build_transport_probe":false,"compiler_transport_probe":false,"next_build_cache_phase":"disabled","managed_compiler_probe":false,"managed_compiler_force_invalid":false,"compiler_compatible_probe":false,"compiler_probe":true,"statutory_probe":false,"nodb_probe":false,"instrument_copies":false,"layout_probe":false}');
 assert.doesNotThrow(()=>validateAttributionSelection(inputs));
 for(const key of ['transport_origin_run','transport_origin_sha','transport_origin_artifact','transport_origin_digest','compiler_origin_run','compiler_origin_sha','compiler_origin_artifact','compiler_origin_digest']){
  for(const absent of [undefined,''])assert.doesNotThrow(()=>validateAttributionSelection({...inputs,[key]:absent}));
  for(const malformed of [null,false,true,0,[],{},' ','123'])assert.throws(()=>validateAttributionSelection({...inputs,[key]:malformed}));
 }
 for(const changed of [{expected_sha:'0'.repeat(40)},{compiler_probe:false},{nodb_probe:true},{layout_probe:true},{instrument_copies:true},{build_transport_probe:true},{compiler_transport_probe:true},{next_build_cache_phase:'cold'}])assert.throws(()=>validateAttributionSelection({...inputs,...changed}));
});

test('attribution retains whole-project config and a fresh owned graph without weakening coverage',()=>{
 const args=compilerArguments('/source','/owned');
 assert.deepEqual(args,['/source/node_modules/typescript/lib/tsc.js','--noEmit','--pretty','false','--tsBuildInfoFile','/owned/whole-project.tsbuildinfo','--extendedDiagnostics','--generateTrace','/owned/trace']);
 assert.deepEqual(compilerArguments('/source','/owned',true),['/source/node_modules/typescript/lib/tsc.js','--noEmit','--pretty','false','--tsBuildInfoFile','/owned/inventory.tsbuildinfo','--listFilesOnly']);
 assert.equal(ATTRIBUTION_SOURCE,'fe26d003b9750478e4d434cc9dd22b59092ae830');
});
test('the final complete begin event survives incomplete or truncated trace tails',()=>{
 const begin=path=>JSON.stringify({name:'checkSourceFile',ph:'B',args:{path}});
 assert.equal(lastCheckedSource('truncated\n,'+begin('first.ts')+'\n,{"name":"checkSourceFile","ph":"E"}\n,'+begin('second.ts')+'\n,{"name":'), 'second.ts');
 assert.equal(lastCheckedSource('[]\n{"name":"other","ph":"B","args":{"path":"ignored"}}'),null);
});
test('zero exit, complete file inventory and no diagnostic/limit are all required',()=>{
 const ok={code:0,signal:null,stoppedBecause:null},log='Files: 12345\n';
 assert.equal(actualCompilerResult(ok,log).compilerCompleted,true);
 for(const result of [{...ok,code:2},{...ok,code:null,signal:'SIGABRT'},{...ok,stoppedBecause:'diagnostic-timeout'}])assert.equal(actualCompilerResult(result,log).compilerCompleted,false);
 for(const text of ['', 'Files: 0\n',log+'file.ts(1,1): error TS2322: bad\n'])assert.equal(actualCompilerResult(ok,text).compilerCompleted,false);
 const oom=actualCompilerResult({code:null,signal:'SIGABRT',stoppedBecause:null},'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n');
 assert.equal(oom.v8HeapFailure,true);assert.equal(oom.compilerCompleted,false);assert.equal(oom.signal,'SIGABRT');
});
test('existing selector stays within25 inputs and reserves only the pinned source for attribution',()=>{
 const workflow=readFileSync(new URL('../../workflows/alpha-staging-diagnostics.yml',import.meta.url),'utf8');
 const inputBlock=workflow.slice(workflow.indexOf('    inputs:\n'),workflow.indexOf('\npermissions:'));
 const inputs=[...inputBlock.matchAll(/^      ([a-z_]+):$/gm)].map(row=>row[1]);
 assert.equal(inputs.length,25);assert.equal(new Set(inputs).size,25);assert(!inputs.includes('compiler_attribution_probe'));
 assert.match(workflow,/compiler_probe:[\s\S]*?default: false/);
 const attribution=workflow.slice(workflow.indexOf('\n  compiler-attribution:'),workflow.indexOf('\n  compiler-incremental:'));
 const incremental=workflow.slice(workflow.indexOf('\n  compiler-incremental:'),workflow.indexOf('\n  build-transport-producer:'));
 assert(attribution.includes("if: ${{ inputs.compiler_probe && inputs.expected_sha == '"+ATTRIBUTION_SOURCE+"' }}"));
 assert(incremental.includes("if: ${{ inputs.compiler_probe && inputs.expected_sha != '"+ATTRIBUTION_SOURCE+"' }}"));
 assert.match(workflow,/compiler-attribution:[\s\S]*?runs-on: ubuntu-24.04[\s\S]*?timeout-minutes: 20/);
 assert.match(workflow,/name: diagnostic-compiler-attribution\n\s+path: \$\{\{ runner.temp \}\}\/diagnostic-compiler-attribution\//);
});
test('non-hosted invocation refuses before reading candidate files',async()=>{
 const previous=process.env.GITHUB_ACTIONS;
 try{process.env.GITHUB_ACTIONS='false';await assert.rejects(attributeCompiler(),/Managed company runner/);}
 finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}
});
