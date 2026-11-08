/** Source/stdlib models only. Never a native compiler execution or release witness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync,symlinkSync,linkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {BOUNDARY_SOURCE,BOUNDARY_REF,CONSUMER_TRACE_INTENT,TRACED_CONSUMERS,admitConsumerTraceInputs,admitBoundaryInputs,boundarySchedule} from './compiler-boundary-policy.mjs';
import {boundaryArguments} from './compiler-boundary.mjs';
import {boundaryWorker} from './compiler-boundary-worker.mjs';
import {scanNativeArray,traceAccumulator,sourceOwnerMapper,analyzeConsumerTrace,TRACE_PARSE_LIMITS} from './compiler-consumer-trace.mjs';
const selection={candidate_ref:BOUNDARY_REF,expected_sha:BOUNDARY_SOURCE,installer_fixture_phase:CONSUMER_TRACE_INTENT,compiler_probe:true,next_build_cache_phase:'disabled'};
test('trace intent admits only exact f2 and the existing25 inputs, with no alternate probe, cache, indices or path',()=>{
 assert.doesNotThrow(()=>admitConsumerTraceInputs(selection));assert.throws(()=>admitBoundaryInputs(selection));
 for(const change of [{installer_fixture_phase:'compiler-boundary'},{expected_sha:'0'.repeat(40)},{candidate_ref:'main'},{compiler_probe:false},{layout_probe:true},{layout_probe:'true'},{managed_compiler_probe:0},{next_build_cache_phase:'warm'},{compiler_origin_run:'1'},{traceConsumers:[0]},{traceDirectory:'/caller'},{arbitrary:false}])assert.throws(()=>admitConsumerTraceInputs({...selection,...change}));
});
test('fixed diagnostic schedule retains checked producer/declarations, selects7/8/9 and cannot silently choose other partitions',async()=>{
 const plan={consumers:Array.from({length:10},(_,id)=>({id}))};
 assert.deepEqual(TRACED_CONSUMERS,[7,8,9]);assert.deepEqual(boundarySchedule(plan,true),[{mode:'producer'},{mode:'declarations'},...TRACED_CONSUMERS.map(index=>({mode:'consumer',index}))]);assert.equal(boundarySchedule(plan).length,14);
 assert.throws(()=>boundarySchedule({consumers:plan.consumers.slice(0,9)},true));assert.throws(()=>boundarySchedule({consumers:[{id:1},{id:0}]},true));
 assert.deepEqual(boundaryArguments('/fixed/worker','/owned','consumer',8,true),['/fixed/worker','consumer','/owned','8','--trace-consumer']);
 assert.throws(()=>boundaryArguments('/fixed/worker','/owned','consumer',0,true));
 await assert.rejects(boundaryWorker('consumer','/caller',0,true),/Only fixed/); // BEFORE compiler require or hosted guard.
});
const inventory={options:{configFilePath:'/source/tsconfig.json'},files:[{id:'test/hot.tsx',real:'test/hot.tsx',external:false},{id:'core/owner.ts',real:'core/owner.ts',external:false},{id:'node_modules/types.d.ts',real:'node_modules/types.d.ts',external:true}]};
const declarations=[{source:'core/owner.ts',virtual:'core/owner.d.ts'}];
const event=(ph,ts,args={path:'/source/test/hot.tsx'})=>({pid:1,tid:1,name:'checkSourceFile',ph,ts,args});
const hot={pid:1,tid:1,name:'structuredTypeRelatedTo',ph:'X',ts:2000,dur:50000,args:{sourceId:12,targetId:13}};
const nativeArray=rows=>'[\n'+rows.map(row=>JSON.stringify(row)).join(',\n')+'\n]\n';
function temporary(){const path=mkdtempSync(join(tmpdir(),'aihr-trace-model-'));return{path,close:()=>rmSync(path,{recursive:true,force:true})};}
test('native completed spans and hot type IDs retain original owners without adding inclusive times or inventing source lines',async()=>{
 const folder=temporary();try{
  const out=join(folder.path,'trace-consumer-7');mkdirSync(out);const raw=nativeArray([event('B',1000),hot,event('E',101000)]);writeFileSync(join(out,'trace.json'),raw);
  writeFileSync(join(out,'types.json'),nativeArray([{id:12,symbolName:'ActualAlias',flags:['Object'],firstDeclaration:{path:'/source/core/owner.d.ts',start:{line:99,character:2}}},{id:13,symbolName:'External',flags:[],firstDeclaration:{path:'/source/node_modules/types.d.ts',start:{line:1,character:1}}}]));
  const result=await analyzeConsumerTrace(folder.path,7,inventory,declarations,Date.now()+30000);
  assert.equal(result.traceComplete,true);assert.equal(result.completeSuite,false);assert.equal(result.rawCapture.sha256,createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.completedFiles[0].inclusiveMs,100);assert.equal(result.hotSpans[0].durationMs,50);assert.equal(result.types[0].owner.originalSourceId,'core/owner.ts');assert.equal(result.types[0].owner.kind,'owned-declaration');assert.equal(result.types[0].firstDeclaration.line,99);assert(result.types[0].owner.lineScope.includes('file-level'));
 }finally{folder.close();}
});
test('partial native tails retain raw SHA and open-frame uncertainty; absent type dumps cannot become resolved witnesses',async()=>{
 const folder=temporary();try{
  const out=join(folder.path,'trace-consumer-8');mkdirSync(out);const raw='[\n'+JSON.stringify(event('B',1000))+',\n'+JSON.stringify(hot)+',\n{"name":"checkSourceFile","ph":';writeFileSync(join(out,'trace.json'),raw);
  const result=await analyzeConsumerTrace(folder.path,8,inventory,declarations,Date.now()+30000);
  assert.equal(result.rawCapture.sha256,createHash('sha256').update(raw).digest('hex'));assert.equal(result.rawCapture.partialTail,true);assert.equal(result.traceComplete,false);assert.equal(result.typesAvailable,false);assert.equal(result.completedFiles.length,0);assert.equal(result.incompleteSpans,1);assert.deepEqual(result.unresolvedHotTypeIds,[12,13]);
  assert.equal((await analyzeConsumerTrace(folder.path,9,inventory,declarations,Date.now()+30000)).traceAvailable,false);
 }finally{folder.close();}
});
test('native compact type-array boundaries and malformed complete records retain exact capture hashes and uncertainty',async()=>{
 const folder=temporary();try{
  const path=join(folder.path,'types.json'),rows=[{id:1,display:'λ'},{id:2,display:'value'}],raw='['+rows.map(row=>JSON.stringify(row)).join(',\n')+']';writeFileSync(path,raw);
  const observed=[],complete=await scanNativeArray(path,row=>observed.push(row));assert.deepEqual(observed,rows);assert.equal(complete.completeArray,true);assert.equal(complete.sha256,createHash('sha256').update(raw).digest('hex'));
  const broken='[\n'+JSON.stringify(rows[0])+',\n{"id":bad},\n]\n';writeFileSync(path,broken);const invalid=await scanNativeArray(path,()=>{});assert.equal(invalid.invalidLines,1);assert.equal(invalid.completeArray,false);assert.equal(invalid.sha256,createHash('sha256').update(broken).digest('hex'));
 }finally{folder.close();}
});
test('wrong end frames and unregistered source paths do not manufacture completed native file work',()=>{
 const result=traceAccumulator(sourceOwnerMapper(inventory,declarations));result.visit(event('B',1,{path:'/outside/foreign.ts'}));result.visit(event('E',2));const summary=result.result();assert.equal(summary.completedFiles.length,0);assert.equal(summary.incompleteSpans,1);assert.equal(summary.unregisteredPaths,1);
});
test('native array reader refuses links, hardlinks, closed-array trailing records and deadline exhaustion',async()=>{
 const folder=temporary();try{
  const path=join(folder.path,'trace.json');writeFileSync(path,nativeArray([hot]));symlinkSync(path,join(folder.path,'link'));await assert.rejects(scanNativeArray(join(folder.path,'link'),()=>{}),/Unsafe/);
  linkSync(path,join(folder.path,'hard'));await assert.rejects(scanNativeArray(path,()=>{}),/Unsafe/);unlinkSync(join(folder.path,'hard'));
  await assert.rejects(scanNativeArray(path,()=>{},Date.now()-1),/deadline/);writeFileSync(path,nativeArray([hot])+JSON.stringify(hot)+'\n');await assert.rejects(scanNativeArray(path,()=>{}),/closure/);
  writeFileSync(path,'[\n'+JSON.stringify({display:'x'.repeat(TRACE_PARSE_LIMITS.lineBytes)})+'\n]');await assert.rejects(scanNativeArray(path,()=>{}),/line bound/);
 }finally{folder.close();}
});
test('new intent has one isolated hosted job and retains native trace finalization inside the original phase budget',()=>{
 const workflow=readFileSync(new URL('../../workflows/alpha-staging-diagnostics.yml',import.meta.url),'utf8');assert(workflow.includes('compiler-consumer-trace:'));assert(workflow.includes('compiler-boundary.mjs --trace-consumers'));assert(workflow.includes('name: diagnostic-compiler-consumer-trace'));
 const worker=readFileSync(new URL('./compiler-boundary-worker.mjs',import.meta.url),'utf8');assert(worker.includes("ts.startTracing('project'"));assert(worker.includes('tracing.stopTracing()'));assert(worker.includes('result.trace.finalizeElapsedMs'));assert(worker.includes('3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675'));
});
test('frozen trace request binds the exact reviewed source footprint, fixed25 inputs and explicit incomplete scope',()=>{
 const request=JSON.parse(readFileSync(new URL('../../../docs/qualification/compiler-roster-attribution-controller-context-20261108.json',import.meta.url),'utf8'));
 const historical=readFileSync(new URL('../../../docs/qualification/compiler-selected-consumer-trace-request-20261108.json',import.meta.url));
 assert.equal(createHash('sha256').update(historical).digest('hex'),'c34cea1ff7a042b6a9cb59b68490d49cac6dba42c922fac871f687dc27549f38');
 assert.equal(request.historicalRequestSha256,'c34cea1ff7a042b6a9cb59b68490d49cac6dba42c922fac871f687dc27549f38');
 assert.equal(request.source,BOUNDARY_SOURCE);assert.equal(request.sourceRef,BOUNDARY_REF);assert.equal(Object.keys(request.inputs).length,25);assert.doesNotThrow(()=>admitConsumerTraceInputs(request.inputs));assert.deepEqual(request.traceContract.fixedConsumers,TRACED_CONSUMERS);
 assert.deepEqual(request.expectedJobs,['resolve','compiler-consumer-trace']);assert.equal(request.completeSuite,false);assert.equal(request.ordinaryCompilerQualified,false);assert.equal(request.releaseAuthorized,false);
 assert(Object.keys(request.sourceSha256).length>=10);for(const [name,hash]of Object.entries(request.sourceSha256))assert.equal(createHash('sha256').update(readFileSync(new URL('../../../'+name,import.meta.url))).digest('hex'),hash,name);
});
