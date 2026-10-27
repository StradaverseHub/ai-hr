import test from 'node:test';import assert from 'node:assert/strict';
import {inspectRetainedInventory} from './retained-units.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
function fixture(){
 const candidate='a'.repeat(40),controller='b'.repeat(40),baseline='c'.repeat(40),runId=99;
 const plan={sha:candidate,controller,migrationBase:baseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'},units:[{id:'nodb-example',kind:'nodb',files:['test/example.test.ts']}]};
 const started='2026-10-27T00:00:00Z',ended='2026-10-27T00:05:00Z';
 const run={id:runId,repository:{id:REPOSITORY_ID,full_name:REPOSITORY},head_repository:{id:REPOSITORY_ID},workflow_id:WORKFLOW_ID,path:WORKFLOW_PATH,head_branch:'main',head_sha:controller,event:'workflow_dispatch',status:'completed',conclusion:'failure',run_attempt:1,created_at:started,updated_at:ended};
 const jobs=['resolve','plan','controller-tests','migrations','typecheck','build','test (nodb-example)','verify','deployment-hold'].map((name,i)=>({id:i+1,name,run_id:runId,run_attempt:1,head_sha:controller,head_branch:'main',status:'completed',conclusion:name==='verify'?'failure':'success',started_at:started,completed_at:ended}));
 const artifacts=['gate-plan','unit-nodb-example'].map((name,i)=>({id:i+10,name,expired:false,size_in_bytes:42,digest:'sha256:'+'d'.repeat(64),created_at:'2026-10-27T00:04:00Z',expires_at:'2026-10-28T00:00:00Z',workflow_run:{id:runId,repository_id:REPOSITORY_ID,head_repository_id:REPOSITORY_ID,head_sha:controller,head_branch:'main'}}));
 return {plan,expected:{candidate,controller,baseline,runId},run,jobs,artifacts,now:Date.parse(ended)};
}
test('terminal failed whole run can retain authentic individual unit origins',()=>{const r=inspectRetainedInventory(fixture());assert.equal(r.selected.length,2);assert.equal(r.byName.get('verify').conclusion,'failure');});
for(const [name,mutate] of [
 ['foreign repository',f=>f.run.head_repository.id=1],
 ['rerun attempt',f=>f.run.run_attempt=2],
 ['unfinished job',f=>f.jobs[6].status='in_progress'],
 ['omitted job',f=>f.jobs.splice(4,1)],
 ['duplicate job',f=>f.jobs.push({...f.jobs[6]})],
 ['foreign artifact revision',f=>f.artifacts[1].workflow_run.head_sha='e'.repeat(40)],
 ['archive outside producing job',f=>f.jobs[6].started_at='2026-10-27T00:04:30Z'],
 ['expired artifact',f=>f.artifacts[1].expired=true],
 ['unknown artifact',f=>f.artifacts[1].name='unit-foreign'],
 ['missing API digest',f=>delete f.artifacts[1].digest],
 ['stale original run',f=>f.now+=86400001],
 ['success contradicts original failure',f=>f.run.conclusion='success'],
 ['changed expected candidate',f=>f.expected.candidate='f'.repeat(40)],
])test('refuses '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>inspectRetainedInventory(f));});
