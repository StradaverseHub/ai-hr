import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeMixedErrorStatuses,summarizeMixedResponsePhases} from '../../scripts/performance/mixed-response-phases.mjs';

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

test('aggregates completed load HTTP errors without emitting fixture record paths or request data',()=>{
 const base={role:'employee',route:'/claims',method:'GET',startedMs:20,status:503,cookie:'omit'};
 const samples=[base,base,{...base,startedMs:19},{...base,status:200},{...base,role:'unknown'},
  {...base,route:'/claims/private-record',status:404},{...base,route:'/claims/another-record',status:404},
  {...base,method:'POST',status:403},{...base,status:600}];
 assert.deepEqual(summarizeMixedErrorStatuses(samples,{startPerformanceMs:20},new Set(['/claims'])),{
  total:5,omittedGroups:0,rows:[
   {role:'employee',route:null,method:'GET',status:404,count:2},
   {role:'employee',route:'/claims',method:'GET',status:503,count:2},
   {role:'employee',route:'/claims',method:'POST',status:403,count:1},
  ],
 });
 assert.equal(summarizeMixedErrorStatuses(samples,undefined,new Set(['/claims'])),null);
});
