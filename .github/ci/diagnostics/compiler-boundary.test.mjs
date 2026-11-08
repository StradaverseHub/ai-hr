/** Controller tests only. Real semantic/emit/negative contracts run in the hosted diagnostic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {BOUNDARY_SOURCE,BOUNDARY_REF,FULL_BOUNDARY_SOURCE,FULL_BOUNDARY_REF,boundaryExecutionSource,BOUNDARY_LIMITS,admitBoundaryInputs,remainingCompilerMs,stronglyConnected,planBoundary,ambientEntries,orderedBoundaryRoots,resolutionLeafTargets,assertResolutionLeafBytes,assertDeclarationBytes,sha256,
 validateDeclarationCoverage,contractSource,NEGATIVE_CONTRACTS,expectContractRefusals} from './compiler-boundary-policy.mjs';
import {exactCoverage,validatePhase,boundaryArguments,runIndependentPhases,blockedUnstartedPhases,experiment} from './compiler-boundary.mjs';
import {boundaryWorker,emitDeclarationSources} from './compiler-boundary-worker.mjs';

test('every distinct implementation emission retains its own native skipped/diagnostic refusal',()=>{
 const files=[{fileName:'first.ts',isDeclarationFile:false},{fileName:'second.tsx',isDeclarationFile:false}],seen=[];
 emitDeclarationSources({emit:file=>{seen.push(file);return{emitSkipped:false,diagnostics:[]};}},files,()=>{});
 assert.deepEqual(seen,files);
 for(const result of [{emitSkipped:true,diagnostics:[]},{emitSkipped:false,diagnostics:[{code:2304}]}]){
  const attempted=[];assert.throws(()=>emitDeclarationSources({emit:file=>{attempted.push(file);return result;}},files,()=>{}));assert.deepEqual(attempted,[files[0]]);
 }
 for(const invalid of [[],[files[0],files[0]],[{fileName:'data.json',isDeclarationFile:false}],[{fileName:'owned.d.ts',isDeclarationFile:true}]]){
  assert.throws(()=>emitDeclarationSources({emit:()=>{throw Error('Invalid sources must not reach native emit');}},invalid,()=>{}));
 }
});

const selection={candidate_ref:FULL_BOUNDARY_REF,expected_sha:FULL_BOUNDARY_SOURCE,
 compiler_probe:true,installer_fixture_phase:'compiler-boundary',next_build_cache_phase:'disabled',nodb_probe:false,layout_probe:false,instrument_copies:false};
test('new closed intent admits only exact source, no concurrent probes or transported state',()=>{
 assert.doesNotThrow(()=>admitBoundaryInputs(selection));
 for(const change of [{candidate_ref:'main'},{expected_sha:'0'.repeat(40)},{candidate_ref:'codex/compiler-proven-message-boundaries-20261108',expected_sha:'38b047c9f465990e3f26295c035ab9f69b3001d7'},{compiler_probe:false},{installer_fixture_phase:'full'},
  {next_build_cache_phase:'cold'},{filesystem_activation_probe:true},{nodb_probe:true},{layout_probe:true},{instrument_copies:true},
  {managed_compiler_probe:true},{compiler_transport_probe:true},{next_build_cache_origin:'{}'},{compiler_origin_run:'123'}])
  assert.throws(()=>admitBoundaryInputs({...selection,...change}));
 for(const key of ['transport_origin_run','transport_origin_sha','transport_origin_artifact','transport_origin_digest',
  'compiler_origin_run','compiler_origin_sha','compiler_origin_artifact','compiler_origin_digest','next_build_cache_origin'])
  for(const value of [null,false,0,{},[],' '])assert.throws(()=>admitBoundaryInputs({...selection,[key]:value}));
});
test('compiler time is one aggregate720s budget, inventory retains a separate120s bound',()=>{
 assert.equal(BOUNDARY_LIMITS.heapMiB,12288);assert.equal(BOUNDARY_LIMITS.inventoryMs,120000);
 assert.equal(BOUNDARY_LIMITS.consumerRoots,400);assert.equal(BOUNDARY_LIMITS.consumerClosure,600);
 assert.equal(remainingCompilerMs([{mode:'inventory',elapsedMs:120000}]),720000);
 assert.equal(remainingCompilerMs([{mode:'producer',elapsedMs:400000},{mode:'consumer',elapsedMs:300000}]),20000);
 assert.equal(remainingCompilerMs([{mode:'producer',elapsedMs:720001}]),0);
 assert.deepEqual(boundaryArguments('/controller/worker.mjs','/owned','consumer',3),['/controller/worker.mjs','consumer','/owned','3']);
});
test('independent native consumer failures settle sequentially without hiding later failures or successes',async()=>{
 const attempted=[],blocked=[];let active=0,peak=0;
 const outcome=await runIndependentPhases([{mode:'consumer',index:0},{mode:'consumer',index:1},{mode:'consumer',index:2}],async(mode,index)=>{
  assert.equal(mode,'consumer');active++;peak=Math.max(peak,active);attempted.push(index);
  try{await Promise.resolve();if(index!==1)throw Error('Native consumer '+index+' refused');return{mode,index,complete:true};}finally{active--;}
 },()=>70000,row=>blocked.push(row));
 assert.deepEqual(attempted,[0,1,2]);assert.equal(peak,1);assert.deepEqual(outcome.results,[{mode:'consumer',index:1,complete:true}]);
 assert.deepEqual(outcome.failures.map(row=>row.index),[0,2]);assert.equal(outcome.failures[0].error,'Error: Native consumer 0 refused');assert.deepEqual(blocked,[]);
});
test('a failed source negative control cannot block declaration negative or later native consumers',async()=>{
 const attempted=[],blocked=[];let active=0,peak=0;
 const planned=[{mode:'source-negative'},{mode:'declaration-negative'},{mode:'consumer',index:0},{mode:'consumer',index:1}];
 const outcome=await runIndependentPhases(planned,async(mode,index)=>{
  active++;peak=Math.max(peak,active);attempted.push({mode,...(index===undefined?{}:{index})});
  try{await Promise.resolve();if(mode==='source-negative'||index===0)throw Error('Actual independent '+mode+' refusal');return{mode,index,complete:true};}finally{active--;}
 },()=>70000,row=>blocked.push(row));
 assert.deepEqual(attempted,planned);assert.equal(peak,1);assert.deepEqual(outcome.failures.map(({mode,index})=>({mode,...(index===undefined?{}:{index})})),[planned[0],planned[2]]);
 assert.deepEqual(outcome.results,[{mode:'declaration-negative',index:undefined,complete:true},{mode:'consumer',index:1,complete:true}]);assert.deepEqual(blocked,[]);
 // No checked declaration input was produced by either failed independent check.
 assert.deepEqual(blockedUnstartedPhases(planned,[{mode:'source-negative',status:'failed'}],70000).map(row=>row.blockedReason),['orchestration-failure','orchestration-failure','orchestration-failure']);
});
test('negative-control budget exhaustion blocks each remaining control/consumer without substituting a pass',async()=>{
 const planned=[{mode:'source-negative'},{mode:'declaration-negative'},{mode:'consumer',index:0}],attempted=[],blocked=[];let remaining=1;
 const outcome=await runIndependentPhases(planned,async(mode)=>{attempted.push(mode);remaining=0;throw Error('Actual negative-control deadline');},()=>remaining,row=>blocked.push(row));
 assert.deepEqual(attempted,['source-negative']);assert.deepEqual(outcome.failures.map(row=>row.mode),['source-negative']);assert.deepEqual(outcome.results,[]);
 assert.deepEqual(blocked.map(({mode,index})=>({mode,...(index===undefined?{}:{index})})),planned.slice(1));
 assert(blocked.every(row=>row.status==='blocked'&&row.code===null&&row.elapsedMs===0&&row.blockedReason==='aggregate-time-budget'));
 for(const invalid of [[{mode:'producer'}],[{mode:'source-negative',index:0}],[{mode:'consumer'}],[{mode:'consumer',index:-1}],[{mode:'declaration-negative',extra:true}]])
  await assert.rejects(runIndependentPhases(invalid,()=>{throw Error('Invalid plan must not execute');},()=>1,()=>{}));
});
test('aggregate exhaustion records every unstarted consumer as blocked and executes no substitute phase',async()=>{
 const attempted=[],blocked=[];let remaining=1;
 const outcome=await runIndependentPhases([{mode:'consumer',index:0},{mode:'consumer',index:1},{mode:'consumer',index:2}],async(_mode,index)=>{attempted.push(index);remaining=0;throw Error('Actual deadline failure');},()=>remaining,row=>blocked.push(row));
 assert.deepEqual(attempted,[0]);assert.deepEqual(outcome.results,[]);assert.equal(outcome.failures.length,1);
 assert.deepEqual(blocked.map(row=>row.index),[1,2]);for(const row of blocked)assert.deepEqual({status:row.status,reason:row.blockedReason,code:row.code,elapsed:row.elapsedMs},{status:'blocked',reason:'aggregate-time-budget',code:null,elapsed:0});
 await assert.rejects(runIndependentPhases([{mode:'consumer',index:1},{mode:'consumer',index:1}],()=>{throw Error('No invalid phase may run');},()=>1,()=>{}));
});
test('failed prerequisites and unavailable inventory produce explicit dependent block records, never empty passes',()=>{
 const planned=[{mode:'producer'},{mode:'declarations'},{mode:'consumer',index:0},{mode:'consumer',index:1}],prior=[{mode:'producer',status:'failed',elapsedMs:20,code:1}];
 const blocked=blockedUnstartedPhases(planned,prior,700000);assert.deepEqual(blocked.map(row=>row.mode+(row.index===undefined?'':'-'+row.index)),['declarations','consumer-0','consumer-1']);
 for(const row of blocked){assert.equal(row.status,'blocked');assert.equal(row.blockedReason,'failed-prerequisite');assert.equal(row.blockedBy,'producer');assert.equal(row.code,null);}
 assert.equal(blockedUnstartedPhases(planned,[],0).length,4);assert.equal(blockedUnstartedPhases(planned,[],1)[0].blockedBy,'inventory-or-plan');
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
test('400-root packing preserves every ordered root and whole native SCC without changing closure refusal',()=>{
 const base=graph(),roots=Array.from({length:901},(_,i)=>'consumer-'+String(i).padStart(4,'0')+'.ts');
 const input={roots:[...base.roots.slice(0,3),...roots],buildRoots:base.buildRoots,files:[...base.files.slice(0,3),...roots.map(id=>({id,external:false,declaration:false,ambient:false,json:false}))],edges:base.edges.filter(edge=>!edge.from.startsWith('test-'))};
 const plan=planBoundary(input);assert.deepEqual(plan.consumers.map(batch=>batch.roots.length),[400,400,101]);assert.deepEqual(plan.consumers.flatMap(batch=>batch.roots),roots);
 input.edges.push({from:roots[399],to:roots[400]},{from:roots[400],to:roots[399]});const cyclic=planBoundary(input);
 assert(cyclic.consumers.some(batch=>batch.roots.includes(roots[399])&&batch.roots.includes(roots[400])));assert.deepEqual(cyclic.consumers.flatMap(batch=>batch.roots),roots);
 const dependencies=Array.from({length:202},(_,i)=>'dependency-'+i+'.mjs');input.files.push(...dependencies.map(id=>({id,external:false,declaration:false,ambient:false,json:false})));
 input.edges.push(...dependencies.map(to=>({from:roots[0],to})));assert.throws(()=>planBoundary(input),/dependency closure exceeds/);
});
test('original configured-root order and native external SCC entry survive context composition',()=>{
 const inventory={roots:['next-env.d.ts','app.ts','test.ts','global.d.ts'],buildRoots:['next-env.d.ts','app.ts','global.d.ts'],
  files:[{id:'lib.d.ts',external:true,declaration:true,ambient:true,defaultLibrary:true},
   {id:'external-leaf.d.ts',external:true,declaration:true,ambient:true},{id:'external-entry.d.ts',external:true,declaration:true,ambient:true},
   ...['next-env.d.ts','app.ts','test.ts','global.d.ts'].map(id=>({id,external:false,declaration:id.endsWith('.d.ts'),ambient:id.endsWith('.d.ts')}))],
  firstLoads:['next-env.d.ts','app.ts','test.ts','external-entry.d.ts','external-leaf.d.ts','global.d.ts','lib.d.ts'],
  edges:[{from:'test.ts',to:'external-entry.d.ts'},{from:'test.ts',to:'external-leaf.d.ts'},{from:'external-entry.d.ts',to:'external-leaf.d.ts'},{from:'external-leaf.d.ts',to:'external-entry.d.ts'}]};
 const entries=ambientEntries(inventory);assert.deepEqual(entries,[{root:'test.ts',targets:['external-entry.d.ts'],ambient:['external-leaf.d.ts','external-entry.d.ts']}]);
 const plan=planBoundary(inventory),sidecar=entry=>'context:'+entry.root;
 assert.deepEqual(orderedBoundaryRoots(inventory,plan,plan.producerRoots,plan.producerRoots,sidecar,id=>id),['next-env.d.ts','app.ts','context:test.ts','global.d.ts']);
 assert.deepEqual(orderedBoundaryRoots(inventory,plan,['test.ts'],[],sidecar,id=>id),['next-env.d.ts','context:test.ts','test.ts','global.d.ts']);
 assert(!entries.some(entry=>entry.targets.includes('lib.d.ts')));
 assert.throws(()=>ambientEntries({...inventory,edges:[...inventory.edges,{from:'external-entry.d.ts',to:'app.ts'}]}));
});
test('declaration provenance refuses missing, duplicate and foreign outputs',()=>{
 const inventory=graph(),plan=planBoundary(inventory),good=plan.producerSourceIds.map(source=>({source,virtual:source.replace(/\.ts$/,'.d.ts'),output:'emitted/'+source.replace(/\.ts$/,'.d.ts'),sha256:'a'.repeat(64)}));
 assert.doesNotThrow(()=>validateDeclarationCoverage(plan,inventory,good));
 for(const bad of [good.slice(1),[...good,good[0]],[...good,{source:'foreign.ts'}]])assert.throws(()=>validateDeclarationCoverage(plan,inventory,bad));
 for(const changed of [{virtual:'foreign.d.ts'},{output:'../foreign.d.ts'},{sha256:'invalid'}])assert.throws(()=>validateDeclarationCoverage(plan,inventory,[{...good[0],...changed},...good.slice(1)]));
 const bytes=Buffer.from('export declare const value: string;'),row={sha256:sha256(bytes)};
 assert.doesNotThrow(()=>assertDeclarationBytes(row,bytes));assert.throws(()=>assertDeclarationBytes(row,Buffer.concat([bytes,Buffer.from('\nforeign')])));
});
test('opaque native resolution targets retain distinct identity and never become checked sources',()=>{
 const files=[{id:'checked.d.ts'}],edges=[{kind:'import',from:'checked.d.ts',to:'opaque.js',extension:'.js',packageId:{name:'opaque',version:'1'}},
  {kind:'import',from:'checked.d.ts',to:'checked.d.ts',extension:'.d.ts'},
  {kind:'import',from:'checked.d.ts',to:'opaque.js',extension:'.js',packageId:{name:'opaque',version:'1'}}];
 const leaves=resolutionLeafTargets(files,edges,['checked.d.ts']);
 assert.deepEqual(leaves,[{id:'opaque.js',extensions:['.js'],resolutionKinds:['import'],packageIds:[{name:'opaque',version:'1'}],checkedByOriginalProgram:false,nativeSourceParsed:false}]);
 assert.throws(()=>resolutionLeafTargets(files,edges,['checked.d.ts','opaque.js']));
 const bytes=Buffer.from('module.exports = Object.freeze({});'),row={sha256:sha256(bytes)};
 assert.doesNotThrow(()=>assertResolutionLeafBytes(row,bytes));assert.throws(()=>assertResolutionLeafBytes(row,Buffer.concat([bytes,Buffer.from('\nchanged')])));
 assert.equal(files.length,1);assert(!files.some(file=>file.id==='opaque.js'));
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
 assert.equal([...inputBlock.matchAll(/^      ([a-z_]+):$/gm)].length,25);assert(inputBlock.includes('normal-cleanup, compiler-boundary, compiler-consumer-trace]'));
 const jobs=[...workflow.matchAll(/^  ([a-z][a-z-]*):\n    if: (.+)$/gm)];
 assert(jobs.length>15);for(const [,name,condition]of jobs){
  if(name==='resolve'){for(const intent of ['compiler-boundary','compiler-consumer-trace'])assert(condition.includes(`inputs.installer_fixture_phase == '${intent}'`));continue;}
  if(name==='compiler-boundary'){assert(condition.includes("inputs.installer_fixture_phase == 'compiler-boundary'"));assert(condition.includes(FULL_BOUNDARY_SOURCE));continue;}
  if(name==='compiler-consumer-trace'){assert(condition.includes("inputs.installer_fixture_phase == 'compiler-consumer-trace'"));assert(condition.includes(BOUNDARY_SOURCE));continue;}
  assert(condition.includes("inputs.installer_fixture_phase != 'compiler-boundary'"),name);
  assert(condition.includes("inputs.installer_fixture_phase != 'compiler-consumer-trace'"),name);
  if(name==='compiler-attribution')assert(condition.includes("inputs.installer_fixture_phase == 'full'"));
 }
 assert.match(workflow,/compiler-boundary:[\s\S]*?timeout-minutes: 20/);
 assert.match(workflow,/name: diagnostic-compiler-boundary\n/);
 const worker=readFileSync(new URL('compiler-boundary-worker.mjs',import.meta.url),'utf8');
 assert(worker.includes('program.getSemanticDiagnostics(file)'));assert(worker.includes('options.skipLibCheck=false'));
 assert(worker.includes('Consumer fell back to runtime implementation source'));
 assert(worker.includes('Native reversed merge/overload ordering must actually refuse'));
 assert(worker.includes('Original external module/package/resolution mode changed'));
 assert(worker.includes('A resolution-only opaque leaf cannot become a checked SourceFile'));
});
test('both executable paths refuse outside hosted route before loading TypeScript or candidate sources',async()=>{
 const previous=process.env.GITHUB_ACTIONS;try{process.env.GITHUB_ACTIONS='false';await assert.rejects(experiment(),/Managed diagnostic/);
  await assert.rejects(boundaryWorker('inventory','/foreign'),/Hosted diagnostic/);
 }finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}
});

test('complete13d and historical selected-f2 schedules cannot exchange sources or worker intent',()=>{
 assert.equal(boundaryExecutionSource('full'),FULL_BOUNDARY_SOURCE);assert.equal(boundaryExecutionSource('selected-trace'),BOUNDARY_SOURCE);
 for(const value of [undefined,null,false,0,'','full ','selected','caller'])assert.throws(()=>boundaryExecutionSource(value));
 assert.throws(()=>admitBoundaryInputs({...selection,candidate_ref:BOUNDARY_REF,expected_sha:BOUNDARY_SOURCE}));
 assert.throws(()=>admitBoundaryInputs({...selection},true));
 const worker=readFileSync(new URL('compiler-boundary-worker.mjs',import.meta.url),'utf8'),parent=readFileSync(new URL('compiler-boundary.mjs',import.meta.url),'utf8');
 assert(worker.includes('source=boundaryExecutionSource(schedule)'));assert(worker.includes("if(traceConsumer)assert.equal(schedule,'selected-trace'"));
 assert(parent.includes('AIHR_COMPILER_BOUNDARY_SCHEDULE:schedule'));
});

test('new complete request pins13d and every current controller byte without adopting diagnostic success as release proof',()=>{
 const request=JSON.parse(readFileSync(new URL('../../../docs/qualification/compiler-roster-attribution-controller-context-20261108.json',import.meta.url),'utf8')).completeBoundary;
 const historical=readFileSync(new URL('../../../docs/qualification/compiler-post-translator-complete-boundary-request-20261108.json',import.meta.url));
 assert.equal(createHash('sha256').update(historical).digest('hex'),'2eacde993f3682779709423a0123e40e3e5e64d4b1ff09b1206b4e3796a074ed');
 assert.equal(request.historicalRequestSha256,'2eacde993f3682779709423a0123e40e3e5e64d4b1ff09b1206b4e3796a074ed');
 assert.equal(request.source,FULL_BOUNDARY_SOURCE);assert.equal(request.sourceRef,FULL_BOUNDARY_REF);assert.equal(Object.keys(request.inputs).length,25);admitBoundaryInputs(request.inputs);
 assert.deepEqual(request.expectedJobs,['resolve','compiler-boundary']);assert.equal(request.requiredScope,'ALL_ORIGINAL_ROOTS_AND_RESOLVED_IDENTITIES');
 assert.equal(request.ordinaryCompilerQualified,false);assert.equal(request.releaseAuthorized,false);
 for(const [name,hash]of Object.entries(request.sourceSha256))assert.equal(createHash('sha256').update(readFileSync(new URL('../../../'+name,import.meta.url))).digest('hex'),hash,name);
});
