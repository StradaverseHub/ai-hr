/** Pure acceptance/data/transport checks. No application, compiler, browser or database execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLocaleComposition,verifyFreshMergedResult,MERGED_EXCEPTION as P,ACCEPTANCE_TIER} from './local-counter-merged-acceptance.mjs';
import {counterExceptionFlow,validateMergedLedger} from './local-counter-merged-operator.mjs';
import {validateWalkthrough} from './local-counter-exception-acceptance.mjs';
test('disjoint locale merge preserves all original values and genuine removals; collisions refuse',()=>{
  const base=Object.fromEntries(Array.from({length:61},(_,i)=>['key'+i,'old'+i])),h={...base},peer={...base};
  for(let i=0;i<17;i++)h['key'+i]='H'+i;
  for(let i=17;i<60;i++)peer['key'+i]='peer'+i;
  delete peer.key17;
  const merged={...base,...h,...peer};for(let i=0;i<17;i++)merged['key'+i]=h['key'+i];delete merged.key17;
  assert.equal(verifyLocaleComposition(base,h,peer,merged).allOtherValuesPreserved,true);
  assert.throws(()=>verifyLocaleComposition(base,h,{...peer,key0:'collision'},merged));
  assert.throws(()=>verifyLocaleComposition(base,h,peer,{...merged,key60:'unrelated'}));
  assert.throws(()=>verifyLocaleComposition(base,h,peer,{...merged,key17:'resurrected'}));
});
test('new walkthrough pins preserve exact old outcome/correction assertions and reject old attribution',()=>{
  const expected={source:P.final,controller:'29ee93b38c3647d2c066e53189f15e106bd5049c',buildId:P.buildId};
  for(const journey of ['queue','correction']){
    const value={kind:'LOCAL_PRODUCTION_RENDERER_DEVELOPMENT_ONLY',releaseEligible:false,terminal:true,exitCode:0,sha:expected.source,controller:expected.controller,buildId:expected.buildId,journey,databaseEvidenceValid:true,databaseEvidenceKind:'LOCAL_NATIVE_NO_CGROUP_CAP_CLAIM',ownedDatabaseDropped:true,browserErrors:[],consoleErrors:[],serverErrors:[],modelRunsBefore:0,modelRunsAfter:0,visits:[],plannedVisits:journey==='queue'?64:0};
    if(journey==='queue'){
      for(const actor of ['group-admin','Empty-hr','A-hr','B-hr','A-employee','B-employee'])for(const locale of (['group-admin','Empty-hr'].includes(actor)?['en','ms','zh','vi','th','ta']:['en']))for(const viewport of ['desktop','mobile'])for(const route of ['/control-tower','/control-tower/agents'])value.visits.push({actor,locale,viewport,route});
      value.scenarios=['legacy','malformed','unsupported','failed','current'].map(scenario=>({scenario,outcome:['legacy','malformed','unsupported'].includes(scenario)?'unknown':scenario==='failed'?'failed':'succeeded',steps:['legacy','malformed'].includes(scenario)?Array(4).fill('unknown'):scenario==='failed'?['succeeded','succeeded','failed','succeeded']:Array(4).fill('succeeded'),incomplete:['legacy','malformed','unsupported'].includes(scenario)}));
    }else{
      const before={id:'case',employmentId:'employment',companyId:'company',paymentMethod:null,state:'needs_input',verifiedAt:null,reopenCount:0};
      value.fixture={actors:[{key:'A-hr',userId:'human'}]};
      value.correction={complete:true,before,closed:{...before,paymentMethod:'cash',state:'verified',verifiedAt:'2026-10-26T00:00:00+08:00'},reopened:{...before,reopenCount:1},writes:'ACTUAL_HR_FORM_AND_REFRESH_ACTIONS_ONLY',images:['a','b','c','d','e'],audit:['employment.payment-method.changed','orchestrator.case-verified','employment.payment-method.changed','orchestrator.case-reopened'].map((event_type,i)=>({event_type,actor_type:'user',actor_id:'human',payload:i===0?{before:null,after:'cash'}:i===2?{before:'cash',after:null}:{}}))};
    }
    assert.equal(validateWalkthrough(value,journey,expected).observedSource,P.final);
    assert.throws(()=>validateWalkthrough(value,journey));
    assert.throws(()=>validateWalkthrough({...value,sha:P.candidate},journey,expected));
    if(journey==='queue'){const changed=structuredClone(value);changed.scenarios[0].steps[0]='succeeded';assert.throws(()=>validateWalkthrough(changed,journey,expected));}
    else {const changed=structuredClone(value);changed.correction.reopened.reopenCount=changed.correction.before.reopenCount;assert.throws(()=>validateWalkthrough(changed,journey,expected));}
  }
});
test('ledger retains every original tuple, ordering and exact496 total',()=>{
  const expected=Array.from({length:496},(_,i)=>({id:i+1,hash:'a'.repeat(64),created_at:String(1000+i)}));
  assert.equal(validateMergedLedger(structuredClone(expected),expected),true);
  for(const rows of [expected.slice(1),[...expected,expected[0]],expected.slice().reverse()])assert.throws(()=>validateMergedLedger(rows,expected));
  const altered=structuredClone(expected);altered[0].hash='b'.repeat(64);assert.throws(()=>validateMergedLedger(altered,expected));
});
test('fresh seam requires every real assertion and refuses pending or extra source attribution',()=>{
  const result={success:true,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numPendingTestSuites:0,numTodoTests:0,numTotalTests:16,numPassedTests:16,testResults:[{name:'/candidate/test/hr-orchestrator.test.ts',status:'passed',assertionResults:Array.from({length:16},()=>({status:'passed'}))}]};
  const verify=value=>verifyFreshMergedResult(value,['test/hr-orchestrator.test.ts'],'/candidate',16);
  assert.equal(verify(result),16);
  for(const changes of [{numPendingTests:1},{numPendingTestSuites:1},{numTodoTests:1},{numPassedTests:15},{numFailedTests:1}])assert.throws(()=>verify({...result,...changes}));
  const foreign=structuredClone(result);foreign.testResults[0].name='/other/test/hr-orchestrator.test.ts';assert.throws(()=>verify(foreign));
});
test('merged operator retains cancelled/unknown provenance and refuses baseline movement before transport',()=>{
  const evidence={tier:ACCEPTANCE_TIER,result:'ACCEPTED_WITH_OWNER_EXCEPTION',stagingBuildAuthorized:true,canonicalResult:'INCOMPLETE_CANCELLED',composedFromCancelledPrefix:true,controller:{partialOriginalBatch9Excluded:true},originalCandidate:P.candidate,rawVitestExit:'UNKNOWN_NOT_SEPARATELY_RECORDED',sourceBoundary:{counterRepairApplied:true},candidate:P.final,candidatePath:'/candidate'};
  const calls=[],args={evidence,official:{isSuccessState:state=>state==='ok',buildPendingCommand:()=>'',buildTestingRecordCommand:()=>'',buildLaunchCommand:()=>'',buildFollowCommand:()=>'',followDeploy:()=>({state:'ok',ref:P.final,built_ref:P.final,stale_build:'0',built_build_id:'built'})},testingBuild:{identity:{buildRecordId:'owned'}},stableTestingJson:()=>'',revalidate:()=>{},assertBuildFrozen:()=>{},transport:{ssh:()=>{calls.push('ssh');return '';},transfer:()=>calls.push('transfer')},save:()=>{}};
  assert.equal(counterExceptionFlow(args).ref,P.final);assert(calls.includes('transfer'));calls.length=0;
  assert.throws(()=>counterExceptionFlow({...args,revalidate:()=>{throw Error('baseline moved');}}));assert.equal(calls.length,0);
  for(const replacement of [{canonicalResult:'PASS'},{rawVitestExit:'0'},{originalCandidate:P.final},{tier:'ci'}])assert.throws(()=>counterExceptionFlow({...args,evidence:{...evidence,...replacement}}));
});
