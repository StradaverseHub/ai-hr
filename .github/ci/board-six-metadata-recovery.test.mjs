import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {SIX_METADATA_PROFILE as P,validateSixMetadataDelta,validateSixMetadataContext,validateSixQueueOnlyCancellation,SIX_QUEUE_ONLY_IDS,METADATA_RECOVERY_POLICY,validateSixMetadataCertificate} from './board-six-metadata-recovery.mjs';
import {repairDisposition} from './repair-recovery-policy.mjs';
import {hash} from './manifest.mjs';
const facts=()=>{const {seeds,...f}=P;return structuredClone(f);};
const binding=()=>validateSixMetadataDelta(facts());
test('metadata recovery admits one exact immutable Git source pair and six paths only',()=>{
 assert.equal(binding().fingerprint,hash(P));assert.equal(P.changed.length,6);assert.equal(P.seeds.length,18);
 assert(P.seeds.includes('test/ai-centre-controls.test.ts'));assert(P.seeds.includes('test/approved-board-populated-upgrade.test.ts'));
});
for(const key of ['kind','original','candidate','baseTree','headTree','diffSha256','changed'])test('metadata delta refuses altered '+key,()=>{const f=facts();f[key]=key==='changed'?f[key].slice(1):'altered';assert.throws(()=>validateSixMetadataDelta(f));});
test('metadata delta refuses extra paths or arbitrary SQL/test repairs',()=>{const f=facts();f.changed.push('db/migrations/0000.sql');assert.throws(()=>validateSixMetadataDelta(f));f.changed=P.changed;f.extra=true;assert.throws(()=>validateSixMetadataDelta(f));});
function context(){return {profile:binding(),sourcePlan:{sha:P.original},plan:{sha:P.candidate,suite:P.seeds},impactContext:{base:P.original,head:P.candidate,baseTree:P.baseTree,headTree:P.headTree,plan:{changed:P.changed}}};}
test('closed metadata coverage contains every pinned populated-upgrade consumer and the catalogue/guidance owners',()=>assert.deepEqual(validateSixMetadataContext(context()),P.seeds));
for(const [name,change] of [['wrong candidate',x=>x.plan.sha='a'.repeat(40)],['missing native check',x=>x.plan.suite=x.plan.suite.slice(1)],['other Git tree',x=>x.impactContext.headTree='b'.repeat(40)],['other changed path',x=>x.impactContext.plan.changed=['test/other.test.ts']],['weakened seeds',x=>x.profile.seeds=[]],['foreign fingerprint',x=>x.profile.fingerprint='a'.repeat(64)]])test('metadata coverage refuses '+name,()=>{const x=structuredClone(context());change(x);assert.throws(()=>validateSixMetadataContext(x));});
function cancellation(){return {run:{id:SIX_QUEUE_ONLY_IDS[0],head_sha:P.original,head_branch:'alpha',event:'workflow_dispatch',run_attempt:1,status:'completed',conclusion:'cancelled',display_title:'Focused only · codex/board-six-recovery-20261109-1',repository:{id:1333414856},head_repository:{id:1333414856}},jobs:[]};}
test('six observed queue cancellations remain cancelled with independently authenticated zero-job inventories',()=>assert.equal(validateSixQueueOnlyCancellation(cancellation()).executedJobs,0));
for(const [name,change] of [['executed job',x=>x.jobs=[{name:'selected-tests'}]],['unlisted run',x=>x.run.id=1],['real failed process',x=>x.run.conclusion='failure'],['rerun',x=>x.run.run_attempt=2],['foreign repository',x=>x.run.repository.id=1],['wrong controller',x=>x.run.head_sha='a'.repeat(40)]])test('queue observation refuses '+name,()=>{const x=cancellation();change(x);assert.throws(()=>validateSixQueueOnlyCancellation(x));});
test('metadata grant certificate cannot omit queue failures or substitute another source',()=>{
 const c={recoveryPolicy:METADATA_RECOVERY_POLICY,originalSha:P.original,sha:P.candidate,disposition:{metadataProfile:binding()},history:{queueOnlyCancellations:SIX_QUEUE_ONLY_IDS.map(runId=>({runId,conclusion:'cancelled',executedJobs:0,metadataFingerprint:'a'.repeat(64)}))}};
 assert.doesNotThrow(()=>validateSixMetadataCertificate(c));for(const change of [x=>x.sha='f'.repeat(40),x=>x.history.queueOnlyCancellations.pop(),x=>x.history.queueOnlyCancellations[0].executedJobs=1,x=>x.disposition.metadataProfile.seeds=[]]){const x=structuredClone(c);change(x);assert.throws(()=>validateSixMetadataCertificate(x));}
});
import {buildUnits,CI_EXECUTION} from './manifest.mjs';
import {validateRepairDelta,validateLatestRepairHistory} from './repair-recovery.mjs';
test('separately versioned disposition preserves raw full impact and retains only unchanged units',()=>{
 const suite=[...P.seeds,'test/unaffected.test.ts'].sort(),units=buildUnits(suite,{nodb:P.seeds,db:['test/unaffected.test.ts']},['test/ui.browser.test.tsx']);
 const body={schemaVersion:2,policyVersion:'aihr-staging-ci/v17',sha:P.original,controller:P.original,migrationBase:'4ae7953eb0283abcba914c29ecef719887ad6fca',runtime:{node:'22.23.3',platform:'linux',arch:'x64'},execution:CI_EXECUTION,suite,units};
 const sourcePlan={...body,fingerprint:hash(body)},next={...body,sha:P.candidate},plan={...next,fingerprint:hash(next)};
 const impact={policyVersion:3,tier:'full',risk:'unknown',changed:P.changed,classifications:P.changed.map(path=>({path,risk:'unknown',uncertainties:['SQL invalidation']})),reasons:['SQL change'],run:suite,browser:true};
 const controller='e'.repeat(40),impactContext={base:P.original,head:P.candidate,controller,baseTree:P.baseTree,headTree:P.headTree,plan:{...impact,fingerprint:hash(impact)},snapshotSource:'IMMUTABLE_GIT_OBJECTS',sourceInputsFingerprint:hash({baseTree:P.baseTree,headTree:P.headTree,controller,impactPolicy:3}),metadataProfile:binding()};
 const db=units.find(u=>u.kind==='db'),assessment={reusable:units.filter(u=>u.id!==db.id)};
 const input={sourcePlan,plan,assessment,impactContext,verificationController:controller};
 const d=repairDisposition(input);assert.equal(d.fresh.length,2);assert.equal(d.retained.length,3);assert(d.fresh.includes(db.id));assert.equal(impactContext.plan.tier,'full');assert.equal(d.metadataProfile.fingerprint,hash(P));
 const generic=structuredClone(input);delete generic.impactContext.metadataProfile;assert.equal(repairDisposition(generic).fresh.length,5);
 const tampered=structuredClone(input);tampered.impactContext.metadataProfile.seeds=[];assert.throws(()=>repairDisposition(tampered));
});
if(process.env.AIHR_SIX_METADATA_GIT_AUDIT==='1')test('actual committed six-file delta matches the closed profile, including every unchanged file',()=>{
 const d=validateRepairDelta({cwd:process.cwd(),original:P.original,candidate:P.candidate});assert.deepEqual(d.metadataProfile,binding());
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8'});
 const sql='db/migrations/3703_attendance_formula_versions.sql',old=git('show',P.original+':'+sql),current=git('show',P.candidate+':'+sql);
 const oldInsert="VALUES('read:operation_attendance_formula_draft',true);",replacement="VALUES('read:operation_attendance_formula_draft',true),\n ('read:attendance_formula_library_guidance',true),\n ('read:attendance_formula_authoring_guidance',true),\n ('read:reward_reviews_guidance',true);";
 assert.equal(old.replace(oldInsert,replacement),current,'SQL must only add three public literal catalogue rows');
 assert.equal(git('diff',P.original,P.candidate,'--','app','components','core','lib','packs','package.json','pnpm-lock.yaml','.github','db/schema','db/migrations/meta'),'','Runtime, schema, journal and CI inputs must remain unchanged');
 const modified=git('diff','--name-only',P.original,P.candidate,'--','db/migrations').trim().split('\n');assert.deepEqual(modified,[sql]);
});
