import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeMixedResponsePhases} from '../../scripts/performance/mixed-response-phases.mjs';

test('projects matched response phases from steady starts and omits private or invalid observations',()=>{
 const base={role:'employee',route:'/claims',method:'GET',startedMs:10,status:200,ttfbMs:100,durationMs:150,privateValue:'omit'};
 const samples=[
  base,{...base,ttfbMs:30,durationMs:500,startedMs:29},
  {...base,method:'POST',status:303,ttfbMs:200,durationMs:400},
  {...base,role:'groupHR',ttfbMs:5,durationMs:10},
  {...base,startedMs:9},{...base,startedMs:30},{...base,durationMs:99},
  {...base,status:503},{...base,route:'/claims/private-record'},{...base,role:'anonymous'},
 ];
 const window={steadyStartPerformanceMs:10,steadyUntilPerformanceMs:30};
 assert.deepEqual(summarizeMixedResponsePhases(samples,window,new Set(['/claims'])),[
  {role:'employee',route:'/claims',method:'GET',samples:2,headersP95Ms:100,afterHeadersP95Ms:470,completionP95Ms:500},
  {role:'employee',route:'/claims',method:'POST',samples:1,headersP95Ms:200,afterHeadersP95Ms:200,completionP95Ms:400},
  {role:'groupHR',route:'/claims',method:'GET',samples:1,headersP95Ms:5,afterHeadersP95Ms:5,completionP95Ms:10},
 ]);
 assert.deepEqual(summarizeMixedResponsePhases(samples,undefined,new Set(['/claims'])),[]);
});
