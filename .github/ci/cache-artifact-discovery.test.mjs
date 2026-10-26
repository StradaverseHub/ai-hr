import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheArtifactCandidates} from './cache-artifact-discovery.mjs';
const name='whole-compiler-state-v1',options={name,currentRunId:'999'};
const artifact=(id,run=id)=>({id,name,expired:false,workflow_run:{id:run,repository_id:1333414856,head_repository_id:1333414856,head_sha:'a'.repeat(40)}});
test('exact artifact discovery finds publishers irrespective of more recent nonpublishing workflow runs',()=>{
 // The old three-workflow-run window can contain only diagnostics; their absence of a graph is not a cache miss.
 const recentNonpublishers=[103,102,101],publisher=artifact(20,100);
 assert(!recentNonpublishers.includes(publisher.workflow_run.id));
 assert.deepEqual(cacheArtifactCandidates({total_count:40,artifacts:[publisher]},options),[{runId:100,discoveryArtifactId:20}]);
});
test('bounded advisory discovery skips current run and expired packets without accepting graph bytes or PASS',()=>{
 assert.deepEqual(cacheArtifactCandidates({total_count:3,artifacts:[artifact(1,999),{...artifact(2),expired:true},artifact(3)]},options),[{runId:3,discoveryArtifactId:3}]);
 assert.deepEqual(cacheArtifactCandidates({total_count:0,artifacts:[]},options),[]);
});
test('foreign repositories, wrong names, duplicates and oversized discovery responses refuse',()=>{
 for(const value of [
  {total_count:4,artifacts:[1,2,3,4].map(id=>artifact(id))},
  {total_count:1,artifacts:[{...artifact(1),name:'gate-evidence'}]},
  {total_count:2,artifacts:[artifact(1),artifact(1)]},
  {total_count:2,artifacts:[artifact(1,10),artifact(2,10)]},
  {total_count:1,artifacts:[{...artifact(1),workflow_run:{...artifact(1).workflow_run,repository_id:1}}]},
  {total_count:1,artifacts:[{...artifact(1),workflow_run:{...artifact(1).workflow_run,head_sha:'bad'}}]},
  {total_count:0,artifacts:[artifact(1)]},
 ])assert.throws(()=>cacheArtifactCandidates(value,options));
 assert.throws(()=>cacheArtifactCandidates({total_count:0,artifacts:[]},{...options,name:'other'}));
});
