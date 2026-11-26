import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,now,time} from './resume-test-fixtures.mjs';
import {hash} from './manifest.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {WORKFLOW_ID} from './release-policy.mjs';
import {verifyDbUnitRecovery,validateDbFocusedMetadata,validateDbUnitHistory,validateDbUnitGrantEvidence,validateDbUnitOwnerDecision,dbUnitOwnerDecision,DB_UNIT_OWNER_DECISION,DB_UNIT_RECOVERY_POLICY,DB_UNIT_RECORDED_APPROVAL} from './db-unit-recovery-policy.mjs';
import {dbUnitRecoveryOptions,requireOneRecoveryRoute} from './operator-release.mjs';
import {RECOVERY_POLICY} from './focused-recovery-policy.mjs';
import {BROWSER_RECOVERY_POLICY} from './browser-recovery-policy.mjs';
import {REPAIR_RECOVERY_POLICY} from './repair-recovery-policy.mjs';
import {BUILD_RECOVERY_POLICY} from './build-recovery-policy.mjs';
import {createInstallGrant} from './ci-install-grant.mjs';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const branch='claude/combined-board';
function input(){
 const f=fixture(),plan=f.expectedPlan,unit=plan.units.find(u=>u.kind==='db');
 for(const r of f.reports)for(const b of r.batches)for(const file of b.result.testResults)for(const a of file.assertionResults)a.fullName='original behavioral case: '+file.name;
 const failed=f.reports.find(r=>r.id===unit.id);failed.exitCode=1;failed.batches[0].exitCode=1;failed.batches[0].result.success=false;failed.batches[0].result.testResults[0].status='failed';failed.batches[0].result.testResults[0].assertionResults[0].status='failed';
 f.jobs.find(j=>j.name===`test (${unit.id})`).conclusion='failure';
 f.run.display_title=`Alpha CI · ${branch}`;
 const assessment={...assessResumeCoverage({expectedPlan:plan,expected:f.expected,reports:f.reports}),sourceRun:{id:f.run.id},observations:[{id:unit.id,conclusion:'failure'}]};
 for(const r of assessment.reusable)r.source={runId:f.run.id,jobId:123,artifactId:456,digest:'sha256:'+'a'.repeat(64)};
 // Dispatched with --ref main: head_sha is the ORIGINAL gate controller (c…), never the candidate (a…).
 const run={...f.run,id:200,workflow_id:999,path:'.github/workflows/alpha-focused-checks.yml',display_title:`Focused only · ${branch}`,conclusion:'success',created_at:time(4),updated_at:time(1)};
 const names=['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-swift-models','native-bundle'];
 const jobs=names.map((name,i)=>({id:300+i,name,run_id:run.id,run_attempt:1,head_sha:run.head_sha,head_branch:run.head_branch,status:'completed',conclusion:i<2?'success':'skipped',started_at:time(3),completed_at:time(2)}));
 const artifact={id:400,name:'focused-development-evidence',size_in_bytes:100,digest:'sha256:'+'b'.repeat(64),expired:false,created_at:time(2.5),expires_at:time(-60),workflow_run:{id:run.id,repository_id:1333414856,head_repository_id:1333414856,head_sha:run.head_sha,head_branch:run.head_branch}};
 const report={kind:'FOCUSED_ONLY',releaseEligible:false,schemaVersion:1,sha:plan.sha,controller:plan.controller,runId:String(run.id),attempt:'1',runtime:plan.runtime,files:unit.files,groups:{NODB:[],DB:unit.files},manifestHash:hash(JSON.stringify(unit.files)),classifierHash:'classifier',startedAt:time(2.9),endedAt:time(2.1),exitCode:0,healthBefore:{ok:true},healthAfter:{ok:true},
  batches:[{kind:'DB',files:unit.files,exitCode:0,processExitCode:0,signal:null,assertions:1,startedAt:time(2.9)}],databaseTerminalEvidence:{...structuredClone(failed.databaseTerminalEvidence),name:'aihr-ci-200-1-db-1',capturedAt:time(2.2)}};
 const result={success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numFailedTestSuites:0,testResults:[{name:'/home/runner/work/ai-hr/ai-hr/source/'+unit.files[0],status:'passed',assertionResults:[{status:'passed',fullName:'original behavioral case: /candidate/'+unit.files[0]}]}]};
 const verificationController=plan.controller,approval={date:'2026-11-24',quotes:['Fixture owner approval for this gate only']};
 return {plan,assessment,run:f.run,jobs:f.jobs,reports:f.reports,focused:[{run,jobs,artifact,producer:jobs[1],report,result}],classifierHash:'classifier',verificationController,verificationDiagnostic:{runId:501,controller:verificationController},history:{kind:'AUTHENTICATED_COMPLETE_DB_UNIT_RECOVERY_HISTORY',sourceRunId:f.run.id},ownerDecision:dbUnitOwnerDecision({approval,runId:f.run.id,candidate:plan.sha})};
}
test('DB-unit recovery retains every other unit, preserves the original failure and is labelled as an owner exception',()=>{
 const f=input(),before=structuredClone(f.reports),c=verifyDbUnitRecovery(f);
 assert.deepEqual(f.reports,before);assert.equal(f.run.conclusion,'failure');assert.equal(c.recoveryPolicy,DB_UNIT_RECOVERY_POLICY);assert.equal(c.fullGatePass,false);assert.equal(c.originalConclusion,'failure');
 assert.equal(c.units.filter(u=>u.kind==='db-unit-recovery').length,1);assert.equal(c.units.length,f.plan.units.length);assert.notEqual(c.sha,c.controller);assert.equal(c.focusedSources[0].controller,c.controller);
 assert.equal(c.ownerDecision.provenance,DB_UNIT_RECORDED_APPROVAL);assert.equal(c.ownerDecision.originalRunId,f.run.id);assert.equal(c.verificationController,c.controller);
});
for(const [name,mutate] of [
 ['missing focused coverage',f=>f.focused=[]],['duplicate focused coverage',f=>f.focused.push(structuredClone(f.focused[0]))],
 ['foreign candidate',f=>f.focused[0].report.sha='f'.repeat(40)],['foreign controller',f=>f.focused[0].report.controller='f'.repeat(40)],
 ['failed process',f=>f.focused[0].report.batches[0].processExitCode=1],['process signal',f=>f.focused[0].report.batches[0].signal='SIGTERM'],
 ['failed result',f=>f.focused[0].result.success=false],['skipped assertion',f=>f.focused[0].result.testResults[0].assertionResults[0].status='pending'],
 ['pending test',f=>f.focused[0].result.numPendingTests=1],['changed case name',f=>f.focused[0].result.testResults[0].assertionResults[0].fullName='different case'],
 ['count mismatch',f=>f.focused[0].result.numTotalTests++],['summary mismatch',f=>f.focused[0].report.batches[0].assertions++],
 ['NODB partition',f=>f.focused[0].report.groups={NODB:f.focused[0].report.files,DB:[]}],['mixed partition',f=>f.focused[0].report.groups.NODB=['test/plain.test.ts']],
 ['wrong batch kind',f=>f.focused[0].report.batches[0].kind='NODB'],['unaffected file rerun',f=>{const r=f.focused[0].report;r.files=['test/plain.test.ts'];r.groups={NODB:[],DB:r.files};r.batches[0].files=r.files;r.manifestHash=hash(JSON.stringify(r.files));}],
 ['missing DB evidence',f=>delete f.focused[0].report.databaseTerminalEvidence],['foreign DB owner',f=>f.focused[0].report.databaseTerminalEvidence.name='aihr-ci-999-1-db-1'],
 ['DB OOM',f=>f.focused[0].report.databaseTerminalEvidence.memoryEvents.oom_kill=1],['PG patch drift',f=>f.focused[0].report.databaseTerminalEvidence.settings.serverVersionNum='160099'],
 ['DB capture outside producer',f=>f.focused[0].report.databaseTerminalEvidence.capturedAt=time(10)],['unhealthy runner',f=>f.focused[0].report.healthAfter.ok=false],
 ['changed runtime',f=>f.focused[0].report.runtime={...f.plan.runtime,node:'24.0.0'}],['changed classifier',f=>f.focused[0].report.classifierHash='other'],
 ['focused rerun',f=>f.focused[0].report.attempt='2'],['wrong focused run identity',f=>f.focused[0].report.runId='201'],
 ['failed build',f=>f.jobs.find(j=>j.name==='build').conclusion='failure'],['failed compiler',f=>f.jobs.find(j=>j.name==='typecheck').conclusion='failure'],
 ['failed migrations',f=>f.jobs.find(j=>j.name==='migrations').conclusion='failure'],['failed browser',f=>f.jobs.find(j=>j.name.startsWith('browser (')).conclusion='failure'],
 ['other failed no-DB unit',f=>f.jobs.find(j=>j.name.startsWith('test (nodb')).conclusion='failure'],['passing verifier relabelled',f=>f.jobs.find(j=>j.name==='verify').conclusion='success'],
 ['relabelled original success',f=>f.run.conclusion='success'],['original rerun',f=>f.run.run_attempt=2],['wrong fingerprint',f=>f.assessment.fingerprint='x'],
 ['controller is not the original gate controller',f=>f.plan.controller=f.plan.sha],['changed retained report',f=>f.reports.find(r=>r.exitCode===0).cwd='/changed'],
 ['partially passing original unit',f=>f.reports.find(r=>r.exitCode===1).batches[0].result.testResults[0].status='passed'],
 ['failed case inventory missing',f=>f.reports.find(r=>r.exitCode===1).batches[0].result.testResults=[]],
 ['PDF tooling unit',f=>f.plan.units.find(u=>u.kind==='db').pdfTools=true],
 ['missing verifier diagnostic',f=>f.verificationDiagnostic=null],['other verifier',f=>f.verificationDiagnostic.controller='d'.repeat(40)],
 ['missing history',f=>f.history=null],['altered owner decision',f=>f.ownerDecision={...DB_UNIT_OWNER_DECISION,quotes:['approve']}],
 // Review 2026-11-24 refusals.
 ['23 November decision reused for another gate',f=>f.ownerDecision=DB_UNIT_OWNER_DECISION],['approval recorded for another gate',f=>f.ownerDecision.originalRunId=45191515984],
 ['approval for another candidate',f=>f.ownerDecision.candidate='d'.repeat(40)],['approval without words',f=>f.ownerDecision.quotes=[]],['approval relabelled as bound source',f=>f.ownerDecision.provenance='OWNER_WORDS_BOUND_IN_REVIEWED_SOURCE_FOR_ONE_GATE'],
 ['missing owner decision',f=>f.ownerDecision=undefined],
 ['verifier differs from the original gate controller',f=>{f.verificationController='e'.repeat(40);f.verificationDiagnostic.controller='e'.repeat(40);}],
])test('DB-unit recovery refuses '+name,()=>{const f=input();mutate(f);assert.throws(()=>verifyDbUnitRecovery(f));});
function metadata(){const f=input(),a=f.focused[0];return {run:a.run,jobs:a.jobs,artifacts:[a.artifact],expected:{runId:a.run.id,controller:f.plan.controller,controllerBranch:'main',workflowId:999,candidateBranch:branch,after:time(5)},now};}
test('Focused metadata accepts a run dispatched with --ref main on the original gate controller',()=>assert.equal(validateDbFocusedMetadata(metadata()).name,'selected-tests'));
for(const [name,mutate] of [
 ['candidate as head (not the gate controller)',f=>f.run.head_sha='a'.repeat(40)],['other branch',f=>f.run.head_branch='alpha'],['fork',f=>f.run.head_repository.id=1],
 ['other workflow',f=>f.run.workflow_id=1],['other candidate branch',f=>f.run.display_title='Focused only · other'],['PR trigger',f=>f.run.event='pull_request'],
 ['failed focused run',f=>f.run.conclusion='failure'],['focused rerun',f=>f.run.run_attempt=2],['old evidence',f=>f.now+=86400001],['before original completed',f=>f.run.created_at=time(6)],
 ['missing job',f=>f.jobs.pop()],['job rerun',f=>f.jobs[1].run_attempt=2],['failed producing job',f=>f.jobs[1].conclusion='failure'],['unexpected build job',f=>f.jobs[3].conclusion='success'],
 ['foreign artifact',f=>f.artifacts[0].workflow_run.id=1],['duplicate artifact',f=>f.artifacts.push(f.artifacts[0])],['expired artifact',f=>f.artifacts[0].expired=true],['artifact outside producer',f=>f.artifacts[0].created_at=time(4)],
])test('Focused DB admission refuses '+name,()=>{const f=metadata();mutate(f);assert.throws(()=>validateDbFocusedMetadata(f));});
function history(){
 const f=input(),c='c'.repeat(40),row=(id,title,extra)=>({id,workflow_id:WORKFLOW_ID,display_title:title,head_sha:c,status:'completed',conclusion:'success',run_attempt:1,created_at:time(4),updated_at:time(1),...extra});
 return {source:{run:f.run},candidate:'a'.repeat(40),candidateBranch:branch,focusedRunIds:[200],rows:[row(200,`Focused only · ${branch}`,{workflow_id:999}),row(300,`Alpha CI · ${branch}`,{conclusion:'cancelled'}),row(90,`Alpha CI · ${branch}`,{conclusion:'failure',created_at:time(30),updated_at:time(10)})],
  laterGatePlans:new Map([[300,{sha:'a'.repeat(40),controller:c,fingerprint:'x',jobs:[{name:'resolve',status:'completed',conclusion:'success',attempt:1},{name:'test (db-1)',status:'completed',conclusion:'cancelled',attempt:1},{name:'verify',status:'completed',conclusion:'failure',attempt:1}]}]])};
}
test('History records the later same-source cancelled gate and an overlapping earlier gate honestly',()=>{
 const h=validateDbUnitHistory(history());assert.deepEqual(h.executions.map(e=>[e.id,e.disposition]),[[200,'FOCUSED_DB_UNIT_RECOVERY'],[300,'LATER_SAME_SOURCE_GATE_CANCELLED_BY_OWNER_NOT_EVIDENCE']]);assert.deepEqual(h.overlapping.map(e=>e.id),[90]);
});
for(const [name,change] of [
 ['missing focused run',f=>f.rows.shift()],['pending focused run',f=>f.rows[0].status='in_progress'],['failed focused run',f=>f.rows[0].conclusion='failure'],
 ['later gate on a different source',f=>f.laterGatePlans.get(300).sha='d'.repeat(40)],['later gate source unproven',f=>f.laterGatePlans.delete(300)],
 ['later gate still running',f=>f.rows[1].status='in_progress'],['later gate failed',f=>f.rows[1].conclusion='failure'],['later gate succeeded unaccounted',f=>f.rows[1].conclusion='success'],
 ['later gate on another controller',f=>f.rows[1].head_sha='d'.repeat(40)],['unaccounted later focused run',f=>f.rows.push({...f.rows[0],id:201})],['unaccounted build-only run',f=>f.rows.push({...f.rows[0],id:202,display_title:`Canonical build only · ${branch}`})],
 ['conflicting snapshots',f=>f.rows.push({...f.rows[0],conclusion:'failure'})],['other source branch title',f=>f.source.run.display_title='Alpha CI · other'],
 // Review 2026-11-24: contrary evidence on the identical source, and the browser-tooling workflow.
 ['later same-source gate with a failed unit',f=>f.laterGatePlans.get(300).jobs[1].conclusion='failure'],['later same-source gate timed out',f=>f.laterGatePlans.get(300).jobs[1].conclusion='timed_out'],
 ['later same-source gate with a failed build',f=>f.laterGatePlans.get(300).jobs.push({name:'build',status:'completed',conclusion:'failure',attempt:1})],
 ['later same-source gate job inventory missing',f=>f.laterGatePlans.get(300).jobs=[]],['later same-source gate job rerun',f=>f.laterGatePlans.get(300).jobs[0].attempt=2],
 ['later browser-tooling run',f=>f.rows.push({...f.rows[0],id:203,workflow_id:395862646,display_title:`Tooling transport only · ${branch}`})],
])test('History refuses '+name,()=>{const f=history();change(f);assert.throws(()=>validateDbUnitHistory(f));});
test('The 23 November decision binds only its own gate; any other gate needs a recorded per-gate approval',()=>{
 const own={runId:45191515984,candidate:'9336682460ff8bad3c6b745d7cf8029c2b7e918f'};
 assert.equal(dbUnitOwnerDecision(own),DB_UNIT_OWNER_DECISION);validateDbUnitOwnerDecision(DB_UNIT_OWNER_DECISION,own);
 assert.throws(()=>dbUnitOwnerDecision({...own,candidate:'d'.repeat(40)}));assert.throws(()=>dbUnitOwnerDecision({...own,approval:{date:'2026-11-24',quotes:['x']}}));
 assert.throws(()=>validateDbUnitOwnerDecision(DB_UNIT_OWNER_DECISION,{runId:1,candidate:own.candidate}));
 assert.throws(()=>dbUnitOwnerDecision({runId:1,candidate:'a'.repeat(40)}),/per-gate owner approval/);
 for(const approval of [{date:'2026-11-24',quotes:[]},{date:'yesterday',quotes:['x']},{date:'2026-11-24',quotes:['  ']},{date:'2026-11-24',quotes:['x'],runId:1},['x']])assert.throws(()=>dbUnitOwnerDecision({approval,runId:1,candidate:'a'.repeat(40)}));
 const recorded=dbUnitOwnerDecision({approval:{date:'2026-11-24',quotes:['Approve this gate']},runId:1,candidate:'a'.repeat(40)});
 assert.equal(recorded.provenance,DB_UNIT_RECORDED_APPROVAL);validateDbUnitOwnerDecision(recorded,{runId:1,candidate:'a'.repeat(40)});assert.throws(()=>validateDbUnitOwnerDecision(recorded,{runId:2,candidate:'a'.repeat(40)}));
});
test('Operator options are exactly the focused runs, candidate branch and optional per-gate approval; one route per invocation',()=>{
 assert.deepEqual(dbUnitRecoveryOptions({focusedRunIds:[5],candidateBranch:branch}),{focusedRunIds:[5],candidateBranch:branch});
 assert.deepEqual(dbUnitRecoveryOptions({focusedRunIds:[5],candidateBranch:branch,ownerApproval:{date:'2026-11-24',quotes:['x']}}).ownerApproval.quotes,['x']);
 for(const bad of [null,[],{focusedRunIds:[5]},{focusedRunIds:[5],candidateBranch:branch,reuse:true},{focusedRunIds:[5],candidateBranch:branch,evidenceDirectory:'/tmp/x'},{focusedRunIds:['5'],candidateBranch:branch},{focusedRunIds:5,candidateBranch:branch}])assert.throws(()=>dbUnitRecoveryOptions(bad));
 requireOneRecoveryRoute({dbUnitRecovery:{}});requireOneRecoveryRoute({buildRecovery:{}});requireOneRecoveryRoute({});
 for(const mixed of [{dbUnitRecovery:{},buildRecovery:{}},{dbUnitRecovery:{},browserRecovery:{}},{dbUnitRecovery:{},repair:{}},{dbUnitRecovery:{},recoveryRunIds:[1]},{buildRecovery:{},recoveryRunIds:[1]},{browserRecovery:{},repair:{}}])assert.throws(()=>requireOneRecoveryRoute(mixed),/one explicitly versioned/);
});
test('A distinct DB-unit certificate grants the original successful build without relabelling the failed run',()=>{
 const f=input(),c=verifyDbUnitRecovery(f),g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,source:c.sha,controller:c.controller,runId:c.runId}};
 const run={...g.run,id:c.runId,head_sha:c.controller,conclusion:'failure'},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 assert.equal(validateDbUnitGrantEvidence(e,run),true);const grant=createInstallGrant({...g,evidence:e,run,producer});assert.equal(grant.runId,c.runId);assert.equal(grant.controller,c.controller);assert.equal(grant.witnessFingerprint,hash(c));
 for(const change of [x=>x.recovery.tests++,x=>x.recovery.fullGatePass=true,x=>x.recovery.ownerDecision={date:'x',quotes:[]},x=>x.recovery.ownerDecision=DB_UNIT_OWNER_DECISION,x=>x.recovery.verificationController='e'.repeat(40),x=>delete x.recovery.verificationDiagnostic,x=>x.recovery.originalConclusion='success',x=>x.recovery.focusedSources[0].controller='a'.repeat(40),x=>delete x.recovery.history]){
  const altered=structuredClone(e);change(altered);altered.fingerprint=hash(altered.recovery);assert.throws(()=>createInstallGrant({...g,evidence:altered,run,producer}));
 }
 assert.throws(()=>createInstallGrant({...g,evidence:e,run:{...run,conclusion:'success'},producer}));
 // Review 2026-11-24: a DB-unit certificate cannot reach another policy's grant validator, nor an unknown one.
 for(const policy of [RECOVERY_POLICY,BROWSER_RECOVERY_POLICY,REPAIR_RECOVERY_POLICY,BUILD_RECOVERY_POLICY,'aihr-db-unit-recovery/v2',undefined]){
  const relabelled=structuredClone(e);relabelled.recovery.recoveryPolicy=policy;relabelled.fingerprint=hash(relabelled.recovery);
  for(const conclusion of ['failure','success'])assert.throws(()=>createInstallGrant({...g,evidence:relabelled,run:{...run,conclusion},producer}),undefined,String(policy));
 }
});
function extract(entries){
 const dir=mkdtempSync(join(tmpdir(),'aihr-db-unit-extract-')),zip=join(dir,'p.zip'),out=join(dir,'out');
 execFileSync('python3',['-c','import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close()',zip],{input:JSON.stringify(entries)});
 try{execFileSync('python3',[fileURLToPath(new URL('./db-unit-recovery-extract.py',import.meta.url)),zip,out],{stdio:'pipe'});return readdirSync(out).sort();}finally{rmSync(dir,{recursive:true,force:true});}
}
const packet=()=>({'focused.json':JSON.stringify({groups:{NODB:[],DB:['test/a.test.ts']}}),'db.vitest.json':'{}','postgres.log':'x','postgres-state.json':'{}','postgres-stats.txt':'x','operational-today-desktop.png':'x','operational-preview-heap/heap-12.json':'{}','operational-preview.log':'x'});
test('DB packet extractor keeps diagnostics in the ZIP and extracts only the result pair',()=>{
 assert.deepEqual(extract(packet()),['db.vitest.json','focused.json']);
 for(const change of [p=>delete p['postgres.log'],p=>delete p['db.vitest.json'],p=>p['nodb.vitest.json']='{}',p=>p['../escape.json']='{}',p=>p['nested/dir/x.png']='x',p=>p['run.sh']='x',p=>p['focused.json']=JSON.stringify({groups:{NODB:['test/b.test.ts'],DB:['test/a.test.ts']}})]){
  const p=packet();change(p);assert.throws(()=>extract(p));
 }
});
