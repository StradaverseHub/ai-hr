/** Partial API observations are byte hints only; final release policy remains independent. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX} from './build-artifact.mjs';
import {inspectPrefetchSnapshot} from './prefetch-ci.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
const binding={runId:42,controller:'c'.repeat(40),candidate:'a'.repeat(40),baseline:'b'.repeat(40),controllerBranch:'alpha'};
const run={id:42,repository:{id:REPOSITORY_ID,full_name:REPOSITORY},head_repository:{id:REPOSITORY_ID},workflow_id:WORKFLOW_ID,path:WORKFLOW_PATH,head_sha:binding.controller,head_branch:'alpha',run_attempt:1,event:'workflow_dispatch',status:'in_progress'};
const artifact=(id=1)=>({id,name:'unit-fixture-'+id,size_in_bytes:12,digest:'sha256:'+'d'.repeat(64),expired:false,workflow_run:{id:42,repository_id:REPOSITORY_ID,head_repository_id:REPOSITORY_ID,head_sha:binding.controller,head_branch:'alpha'}});
const input=()=>({run:structuredClone(run),binding,allowedNames:['unit-fixture-1','unit-fixture-2'],artifacts:[artifact()],previous:[]});
test('partial inventory stages fresh immutable bytes without acceptance or invented completeness',()=>{
 const first=inspectPrefetchSnapshot(input());assert.equal(first.releaseAuthorized,false);assert.equal(first.terminal,false);assert.equal(first.fresh.length,1);
 const next=inspectPrefetchSnapshot({...input(),artifacts:[artifact(),artifact(2)],previous:[artifact()]});assert.deepEqual(next.fresh.map(a=>a.id),[2]);
 const terminal=inspectPrefetchSnapshot({...input(),run:{...run,status:'completed',conclusion:'failure'}});assert.equal(terminal.terminal,true);assert.equal(terminal.releaseAuthorized,false);
});
for(const [name,change] of [
 ['foreign run',x=>x.run.id++],['foreign repository',x=>x.run.repository.id++],['fork source',x=>x.run.head_repository.id++],['wrong workflow',x=>x.run.workflow_id++],['rerun',x=>x.run.run_attempt++],['PR event',x=>x.run.event='pull_request'],['wrong controller',x=>x.run.head_sha='e'.repeat(40)],['branch moved',x=>x.run.head_branch='main'],['unknown status',x=>x.run.status='invented'],['foreign artifact',x=>x.artifacts[0].workflow_run.id++],['expired artifact',x=>x.artifacts[0].expired=true],['missing digest',x=>delete x.artifacts[0].digest],['unexpected artifact',x=>x.artifacts[0].name='unexpected'],['duplicate identity',x=>x.artifacts.push(artifact())],['duplicate id',x=>{x.artifacts.push(artifact(2));x.artifacts[1].id=1;}],['removed staged bytes',x=>x.previous=[artifact(2)]],['replaced staged bytes',x=>{x.previous=[artifact()];x.artifacts[0].digest='sha256:'+'e'.repeat(64);}]
])test('refuse '+name,()=>{const x=input();change(x);assert.throws(()=>inspectPrefetchSnapshot(x));});


test('prefetch uses the unchanged280MiB binary limit only for the closed build namespace',()=>{
 assert.equal(BUILD_ZIP_MAX,293601280);
 const a={...artifact(),name:BUILD_ARTIFACT,size_in_bytes:BUILD_ZIP_MAX},value={...input(),allowedNames:[BUILD_ARTIFACT],artifacts:[a]};
 const admitted=inspectPrefetchSnapshot(value);assert.equal(admitted.releaseAuthorized,false);assert.equal(admitted.fresh[0].size_in_bytes,BUILD_ZIP_MAX);
 assert.throws(()=>inspectPrefetchSnapshot({...value,artifacts:[{...a,size_in_bytes:BUILD_ZIP_MAX+1}]}));
 assert.throws(()=>inspectPrefetchSnapshot({...input(),artifacts:[{...artifact(),size_in_bytes:64*1024**2+1}]}));
 assert.throws(()=>inspectPrefetchSnapshot({...value,artifacts:[{...a,name:'diagnostic-build-transport-producer'}]}));
});
