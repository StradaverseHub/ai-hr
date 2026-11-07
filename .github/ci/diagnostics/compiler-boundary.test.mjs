/** Controller tests only. Real semantic/emit/negative contracts run in the hosted diagnostic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BOUNDARY_SOURCE,BOUNDARY_LIMITS,admitBoundaryInputs,remainingCompilerMs,stronglyConnected,planBoundary,assertDeclarationBytes,sha256,
 validateDeclarationCoverage,contractSource,NEGATIVE_CONTRACTS,expectContractRefusals} from './compiler-boundary-policy.mjs';
import {exactCoverage,validatePhase,boundaryArguments,experiment} from './compiler-boundary.mjs';
import {boundaryWorker} from './compiler-boundary-worker.mjs';

const selection={candidate_ref:'codex/compiler-proven-message-boundaries-20261108',expected_sha:BOUNDARY_SOURCE,
 compiler_probe:true,installer_fixture_phase:'compiler-boundary',next_build_cache_phase:'disabled',nodb_probe:false,layout_probe:false,instrument_copies:false};
test('new closed intent admits only exact source, no concurrent probes or transported state',()=>{
 assert.doesNotThrow(()=>admitBoundaryInputs(selection));
 for(const change of [{candidate_ref:'main'},{expected_sha:'0'.repeat(40)},{compiler_probe:false},{installer_fixture_phase:'full'},
  {next_build_cache_phase:'cold'},{filesystem_activation_probe:true},{nodb_probe:true},{layout_probe:true},{instrument_copies:true},
  {managed_compiler_probe:true},{compiler_transport_probe:true},{next_build_cache_origin:'{}'},{compiler_origin_run:'123'}])
  assert.throws(()=>admitBoundaryInputs({...selection,...change}));
 for(const key of ['transport_origin_run','transport_origin_sha','transport_origin_artifact','transport_origin_digest',
  'compiler_origin_run','compiler_origin_sha','compiler_origin_artifact','compiler_origin_digest','next_build_cache_origin'])
  for(const value of [null,false,0,{},[],' '])assert.throws(()=>admitBoundaryInputs({...selection,[key]:value}));
});
test('compiler time is one aggregate720s budget, inventory retains a separate120s bound',()=>{
 assert.equal(BOUNDARY_LIMITS.heapMiB,12288);assert.equal(BOUNDARY_LIMITS.inventoryMs,120000);
 assert.equal(remainingCompilerMs([{mode:'inventory',elapsedMs:120000}]),720000);
 assert.equal(remainingCompilerMs([{mode:'producer',elapsedMs:400000},{mode:'consumer',elapsedMs:300000}]),20000);
 assert.equal(remainingCompilerMs([{mode:'producer',elapsedMs:720001}]),0);
 assert.deepEqual(boundaryArguments('/controller/worker.mjs','/owned','consumer',3),['/controller/worker.mjs','consumer','/owned','3']);
});
function graph(){
 return {roots:['app.ts','core.ts','global.ts','test-a.ts','test-b.ts'],buildRoots:['app.ts','core.ts','global.ts'],
  files:['app.ts','core.ts','global.ts','test-a.ts','test-b.ts','dep.d.ts'].map(id=>({id,external:id==='dep.d.ts',declaration:id.endsWith('.d.ts'),ambient:id==='global.ts'||id==='dep.d.ts',json:false})),
  edges:[{from:'app.ts',to:'core.ts'},{from:'core.ts',to:'app.ts'},{from:'test-a.ts',to:'core.ts'},{from:'test-a.ts',to:'test-b.ts'},{from:'test-b.ts',to:'test-a.ts'}]};
}
test('native dependency SCCs stay whole and every original root receives exactly one owner',()=>{
 const input=graph(),plan=planBoundary(input);
 assert.deepEqual(stronglyConnected(['a','b','c'],[{from:'a',to:'b'},{from:'b',to:'a'},{from:'c',to:'b'}]).map(group=>group.join()).sort(),['a,b','c']);
 assert.deepEqual(plan.producerRoots,['app.ts','core.ts','global.ts']);assert.equal(plan.consumers.length,1);
 assert.deepEqual(plan.consumers[0].roots,['test-a.ts','test-b.ts']);assert.deepEqual(new Set(plan.consumers[0].sourceIds),new Set(['test-a.ts','test-b.ts']));
 input.edges.push({from:'core.ts',to:'test-a.ts'});assert.deepEqual(planBoundary(input).producerRoots,input.roots);
 for(const malformed of [{...graph(),roots:['app.ts','app.ts']},{...graph(),buildRoots:['missing.ts']},{...graph(),files:[]}])assert.throws(()=>planBoundary(malformed));
});
test('declaration provenance refuses missing, duplicate and foreign outputs',()=>{
 const inventory=graph(),plan=planBoundary(inventory),good=plan.producerSourceIds.map(source=>({source,virtual:source.replace(/\.ts$/,'.d.ts'),output:'emitted/'+source.replace(/\.ts$/,'.d.ts'),sha256:'a'.repeat(64)}));
 assert.doesNotThrow(()=>validateDeclarationCoverage(plan,inventory,good));
 for(const bad of [good.slice(1),[...good,good[0]],[...good,{source:'foreign.ts'}]])assert.throws(()=>validateDeclarationCoverage(plan,inventory,bad));
 for(const changed of [{virtual:'foreign.d.ts'},{output:'../foreign.d.ts'},{sha256:'invalid'}])assert.throws(()=>validateDeclarationCoverage(plan,inventory,[{...good[0],...changed},...good.slice(1)]));
 const bytes=Buffer.from('export declare const value: string;'),row={sha256:sha256(bytes)};
 assert.doesNotThrow(()=>assertDeclarationBytes(row,bytes));assert.throws(()=>assertDeclarationBytes(row,Buffer.concat([bytes,Buffer.from('\nforeign')])));
});
test('native API contracts require exact distinct diagnostic codes, positions and owning file',()=>{
 const text=contractSource()+NEGATIVE_CONTRACTS.map(row=>row.line).join('\n')+'\n',file='__aihr_boundary_contract__.ts';
 const errors=NEGATIVE_CONTRACTS.map(row=>({code:row.code,line:text.slice(0,text.indexOf(row.line)).split('\n').length,file}));
 assert.doesNotThrow(()=>expectContractRefusals(errors,text,file));
 for(const bad of [errors.slice(1),[...errors,errors[0]],errors.map(row=>({...row,code:9999})),errors.map(row=>({...row,file:'unrelated.ts'}))])
  assert.throws(()=>expectContractRefusals(bad,text,file));
 assert(!/\bany\b|@ts-ignore|@ts-expect-error/.test(text));
});
test('no exit, missing native report, omitted root or unobserved transitive file becomes complete',()=>{
 for(const row of [{code:1,signal:null,stoppedBecause:null},{code:null,signal:'SIGABRT',stoppedBecause:null},
  {code:0,signal:null,stoppedBecause:'aggregate-time-budget'},{code:0,signal:null,stoppedBecause:null,monitorError:'failure'}])assert.throws(()=>validatePhase(row));
 const inventory=graph(),plan=planBoundary(inventory),names=['producer','declarations','source-negative','declaration-negative','consumer'];
 const phases=names.map(mode=>({mode,index:mode==='consumer'?0:undefined,complete:true,observedOriginalIds:inventory.files.map(row=>row.id)}));
 assert.equal(exactCoverage(inventory,plan,phases).originalResolvedFiles,6);
 assert.throws(()=>exactCoverage(inventory,plan,phases.slice(1)));
 assert.throws(()=>exactCoverage(inventory,plan,phases.map(row=>({...row,observedOriginalIds:row.observedOriginalIds.slice(1)}))));
 assert.throws(()=>exactCoverage(inventory,{...plan,producerRoots:plan.producerRoots.slice(1)},phases));
});
test('workflow keeps25 inputs, old attributionfull-only and every other job outside boundary intent',()=>{
 const workflow=readFileSync(new URL('../../workflows/alpha-staging-diagnostics.yml',import.meta.url),'utf8');
 const inputBlock=workflow.slice(workflow.indexOf('    inputs:\n'),workflow.indexOf('\npermissions:'));
 assert.equal([...inputBlock.matchAll(/^      ([a-z_]+):$/gm)].length,25);assert(inputBlock.includes('normal-cleanup, compiler-boundary]'));
 const jobs=[...workflow.matchAll(/^  ([a-z][a-z-]*):\n    if: (.+)$/gm)];
 assert(jobs.length>15);for(const [,name,condition]of jobs){
  if(name==='resolve'){assert(condition.includes("inputs.installer_fixture_phase == 'compiler-boundary'"));continue;}
  if(name==='compiler-boundary'){assert(condition.includes("inputs.installer_fixture_phase == 'compiler-boundary'"));assert(condition.includes(BOUNDARY_SOURCE));continue;}
  assert(condition.includes("inputs.installer_fixture_phase != 'compiler-boundary'"),name);
  if(name==='compiler-attribution')assert(condition.includes("inputs.installer_fixture_phase == 'full'"));
 }
 assert.match(workflow,/compiler-boundary:[\s\S]*?timeout-minutes: 20/);
 assert.match(workflow,/name: diagnostic-compiler-boundary\n/);
 const worker=readFileSync(new URL('compiler-boundary-worker.mjs',import.meta.url),'utf8');
 assert(worker.includes('program.getSemanticDiagnostics(file)'));assert(worker.includes('options.skipLibCheck=false'));
 assert(worker.includes('Consumer fell back to runtime implementation source'));
});
test('both executable paths refuse outside hosted route before loading TypeScript or candidate sources',async()=>{
 const previous=process.env.GITHUB_ACTIONS;try{process.env.GITHUB_ACTIONS='false';await assert.rejects(experiment(),/Managed diagnostic/);
  await assert.rejects(boundaryWorker('inventory','/foreign'),/Hosted diagnostic/);
 }finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}
});
