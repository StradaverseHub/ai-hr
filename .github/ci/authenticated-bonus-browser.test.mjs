import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectBonusBrowserInventory} from './authenticated-bonus-browser.mjs';
function fixture(){
 const engines=['chromium','firefox','webkit'],sha='dc74b804fcecb4bab3207e82c9b9f099b9bf13be',id=40512563694,start='2026-10-27T00:00:00Z',end='2026-10-27T00:10:00Z';
 const run={id,repository:{id:1333414856,full_name:'StradaverseHub/ai-hr'},head_repository:{id:1333414856},head_sha:sha,head_branch:'alpha',workflow_id:395862646,path:'.github/workflows/alpha-staging-browser-checks.yml',event:'workflow_dispatch',run_attempt:1,status:'completed',conclusion:'success',created_at:start,updated_at:end};
 const names=['resolve','tooling','operator-transport',...engines.map(e=>'browser-image ('+e+')')];
 const jobs=names.map((name,i)=>({id:i+1,name,run_id:id,head_sha:sha,head_branch:'alpha',run_attempt:1,status:'completed',conclusion:name==='resolve'?'success':['tooling','operator-transport'].includes(name)?'skipped':'success',started_at:start,completed_at:end,steps:[{name:'Bind source and exact preinstalled Playwright runtime',status:'completed',conclusion:'success'},{name:'Complete original browser unit in pinned image',status:'completed',conclusion:'success'}]}));
 const artifacts=engines.flatMap((e,i)=>['diagnostic-browser-image-'+e,'diagnostic-complete-image-browser-'+e].map((name,j)=>({id:i*2+j+1,name,expired:false,created_at:'2026-10-27T00:05:00Z',workflow_run:{id,repository_id:1333414856,head_repository_id:1333414856,head_sha:sha,head_branch:'alpha'}})));
 return {snapshot:{run,jobs,artifacts},now:Date.parse(end)};
}
test('authenticates exact fresh Bonus browser coverage without release authority',()=>{const f=fixture();assert.equal(inspectBonusBrowserInventory(f.snapshot,f.now).length,3);assert.equal(f.snapshot.run.conclusion,'success');});
for(const [name,change] of [
 ['foreign repository',s=>s.run.repository.id=0],['wrong controller',s=>s.run.head_sha='0'.repeat(40)],['untrusted workflow',s=>s.run.workflow_id=0],['rerun',s=>s.run.run_attempt=2],
 ['missing job',s=>s.jobs.pop()],['duplicate job',s=>s.jobs[1]=s.jobs[0]],['missing archive',s=>s.artifacts.pop()],['duplicate archive',s=>s.artifacts[1]=s.artifacts[0]],
 ['foreign archive',s=>s.artifacts[1].workflow_run.head_repository_id=0],['changed outcome',s=>s.jobs[3].conclusion='failure'],['missing real execution',s=>s.jobs[3].steps.pop()],['stale archive',s=>s.artifacts[1].expired=true]
])test('refuses '+name,()=>{const f=fixture();change(f.snapshot);assert.throws(()=>inspectBonusBrowserInventory(f.snapshot,f.now));});
