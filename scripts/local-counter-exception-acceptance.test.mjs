import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateCounterRepairProof,validateBrowserResult,validateWalkthrough} from './local-counter-exception-acceptance.mjs';
import {COUNTER_REPAIR,boundedReader} from './local-counter-exception-evidence.mjs';
import {sha256} from './local-counter-exception.mjs';
const copy=v=>JSON.parse(JSON.stringify(v));
const context={candidatePath:'/private/candidate',runDirectory:'/private/candidate/scratchpad/ai-local-20261026-final-02',counterRoot:'/private/counter'};
const result={kind:'PURE_COUNTER_REGRESSIONS_ONLY',checks:21,passed:true,rawLogIncluded:true,originalRedIncluded:true,applicationTestsRun:0,databaseCommands:0};
const log=JSON.stringify(result)+'\n';
const proof={kind:'PURE_COUNTER_REPAIR_VERIFICATION_NOT_RELEASE_RECEIPT',source:COUNTER_REPAIR.source,exitCode:0,result,
 command:['node',context.counterRoot+'/scripts/gate-counted-output.test.mjs',context.runDirectory+'/fullgate/nodb.log',context.candidatePath+'/scripts/gate-chunked.sh'],sourceHashes:COUNTER_REPAIR.files,
 rawLogSha256:'3bbd19cb0bd5f3124f12507668b167292d3b725778d9bef8f0916b2cd9ed08ea',originalScriptSha256:'8b6285c7e933fce064e87a73f056f4a8ced71a3f63f54a9f09a14d9b7d92e6ca',checksLogSha256:sha256(log),originalVitestExitRemainsUnknown:true,noApplicationOrDatabaseRuntime:true};
test('repair proof binds exact source, command, raw report, results and exit limitation',()=>{
 assert.equal(validateCounterRepairProof(proof,log,context).checks,21);
 for(const edit of [p=>p.exitCode=1,p=>p.source='0'.repeat(40),p=>p.command[2]='/other/report',p=>p.originalVitestExitRemainsUnknown=false,p=>p.checksLogSha256='0'.repeat(64),p=>p.result.checks=20]){const p=copy(proof);edit(p);assert.throws(()=>validateCounterRepairProof(p,log,context));}
});
const names=Array.from({length:16},(_,i)=>`/private/candidate/test/browser${i}.browser.test.tsx`);
const browser={success:true,numTotalTests:251,numPassedTests:251,numFailedTests:0,numPendingTests:0,numTodoTests:0,
 testResults:names.map((name,i)=>({name,status:'passed',assertionResults:Array.from({length:i===15?26:15},()=>({status:'passed'}))}))};
test('all three-engine file/case inputs must be complete, unique and passed',()=>{
 assert.deepEqual(validateBrowserResult(browser,names),{files:16,cases:251});
 for(const edit of [p=>p.numPendingTests=1,p=>p.testResults.pop(),p=>p.testResults[0].name=names[1],p=>p.testResults[0].assertionResults[0].status='failed',p=>p.testResults[0].assertionResults.pop()]){const p=copy(browser);edit(p);assert.throws(()=>validateBrowserResult(p,names));}
});
function base(journey){return {kind:'LOCAL_PRODUCTION_RENDERER_DEVELOPMENT_ONLY',releaseEligible:false,terminal:true,exitCode:0,sha:'fdc1e59866328280a16bb19d7e26da097a49ddf2',controller:'acb01a1a18c9a3e494781cabe971213bdd27d045',buildId:'GfqOhcLCVZVMLEwPRih3X',journey,databaseEvidenceValid:true,databaseEvidenceKind:'LOCAL_NATIVE_NO_CGROUP_CAP_CLAIM',ownedDatabaseDropped:true,browserErrors:[],consoleErrors:[],serverErrors:[],modelRunsBefore:0,modelRunsAfter:0,visits:[],plannedVisits:0};}
const queue=base('queue');queue.plannedVisits=64;
for(const actor of ['group-admin','Empty-hr','A-hr','B-hr','A-employee','B-employee'])for(const locale of (['group-admin','Empty-hr'].includes(actor)?['en','ms','zh','vi','th','ta']:['en']))for(const viewport of ['desktop','mobile'])for(const route of ['/control-tower','/control-tower/agents'])queue.visits.push({actor,locale,viewport,route});
queue.scenarios=['legacy','malformed','unsupported','failed','current'].map(scenario=>({scenario,outcome:['legacy','malformed','unsupported'].includes(scenario)?'unknown':scenario==='failed'?'failed':'succeeded',steps:['legacy','malformed'].includes(scenario)?Array(4).fill('unknown'):scenario==='failed'?['succeeded','succeeded','failed','succeeded']:Array(4).fill('succeeded'),incomplete:['legacy','malformed','unsupported'].includes(scenario)}));
test('queue requires every unique scope/locale/view/route and truthful receipt state',()=>{
 validateWalkthrough(queue,'queue');
 for(const edit of [p=>p.visits[0]=p.visits[1],p=>p.scenarios[0].outcome='succeeded',p=>p.modelRunsAfter=1,p=>p.ownedDatabaseDropped=false,p=>p.releaseEligible=true,p=>p.sha='0'.repeat(40)]){const p=copy(queue);edit(p);assert.throws(()=>validateWalkthrough(p,'queue'));}
});
const correction=base('correction');correction.fixture={actors:[{key:'A-hr',userId:'actual-human'}]};
const before={id:'same-case',employmentId:'same-employment',companyId:'same-company',paymentMethod:null,state:'needs_input',verifiedAt:null,reopenCount:0};
correction.correction={complete:true,before,closed:{...before,paymentMethod:'cash',state:'verified',verifiedAt:'2026-10-26T00:00:00+08:00'},reopened:{...before,reopenCount:1},writes:'ACTUAL_HR_FORM_AND_REFRESH_ACTIONS_ONLY',images:['a','b','c','d','e'],audit:['employment.payment-method.changed','orchestrator.case-verified','employment.payment-method.changed','orchestrator.case-reopened'].map((event_type,i)=>({event_type,actor_type:'user',actor_id:'actual-human',payload:i===0?{before:null,after:'cash'}:i===2?{before:'cash',after:null}:{}}))};
test('correction binds real human, same case, saved values and exactly one reopen',()=>{
 validateWalkthrough(correction,'correction');
 for(const edit of [p=>p.correction.reopened.id='another-case',p=>p.correction.closed.paymentMethod=null,p=>p.correction.reopened.reopenCount=2,p=>p.correction.audit[0].actor_id='another-user',p=>p.correction.audit.pop()]){const p=copy(correction);edit(p);assert.throws(()=>validateWalkthrough(p,'correction'));}
});
test('artifact reader preserves raw hashes and refuses traversal and symlinks',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-exception-reader-'))),artifacts=[];
 try{writeFileSync(join(root,'raw.log'),'\x1b[32moriginal\x1b[0m\n');mkdirSync(join(root,'sub'));symlinkSync(join(root,'raw.log'),join(root,'link'));symlinkSync(join(root,'sub'),join(root,'linked-dir'));
 const read=boundedReader(root,'test',artifacts);assert.equal(read('raw.log'),'\x1b[32moriginal\x1b[0m\n');assert.equal(artifacts[0].sha256,sha256('\x1b[32moriginal\x1b[0m\n'));
 for(const path of ['../raw.log','sub/../raw.log','/raw.log','link','linked-dir/missing'])assert.throws(()=>read(path));
 }finally{rmSync(root,{recursive:true,force:true});}
});
