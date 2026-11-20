import assert from 'node:assert/strict';
import {test} from 'node:test';
import {originalAdvisoryAttribution,projectMixedPreflightLockWaits} from '../../scripts/performance/lock-sample-attribution.mjs';

const edge={source:'original-sample',family:'audit-chain',waiterMode:'ExclusiveLock',
 blockerMode:'ExclusiveLock',blockerState:'granted',waiterCategory:'auth-audit-append',
 blockerCategory:'audit-append',pid:12345};
const wait={phase:'preflight',at:1712345678999,
 appConnections:{waitingOnLock:1,sampledAdvisoryWaiters:1},
 firstAppLockWaitCategories:{advisory:1,relation:0,transactionid:0,tuple:0,other:0,raw:'private'},
 appAdvisoryAttribution:{phase:'browser-workflows',workloadStage:'mixed-workflows',
  edges:[edge,{...edge,source:'rechecked-sample'},{...edge,family:'private'}]},
 blockingSessions:[{query:'private'}]};

test('retains only allowed facts from the original positive preflight observation',()=>{
 assert.deepEqual(projectMixedPreflightLockWaits([
  {...wait,phase:'loaded'},
  {...wait,appConnections:{waitingOnLock:0,sampledAdvisoryWaiters:0}},
  wait,
 ]),[{
  phase:'browser-workflows',workloadStage:'mixed-workflows',activityWaiters:1,advisoryWaiters:1,
  waitKinds:{advisory:1,relation:0,transactionid:0,tuple:0,other:0},
  advisoryEdges:[{family:'audit-chain',waiterMode:'ExclusiveLock',blockerMode:'ExclusiveLock',
   blockerState:'granted',waiterCategory:'auth-audit-append',blockerCategory:'audit-append'}],
 }]);
});

test('bounds the artifact and omits unknown labels while preserving a native wait',()=>{
 const observation={...wait,appConnections:{waitingOnLock:1,sampledAdvisoryWaiters:'private'},
  appAdvisoryAttribution:{phase:'private',workloadStage:'private'},firstAppLockWaitCategories:null};
 const rows=projectMixedPreflightLockWaits(Array(7).fill(observation));
 assert.equal(rows.length,6);
 assert.deepEqual(rows[0],{phase:null,workloadStage:null,activityWaiters:1,advisoryWaiters:null,
  advisoryEdges:[],waitKinds:null});
 assert.equal(projectMixedPreflightLockWaits(null),null);
});

test('retains recognized Access statements and rejects labels from another lock family',()=>{
 const key={classid:'1',objid:'2',objsubid:1};
 const locks=[
  {...key,pid:1,blockers:[2],app_session:true,mode:'ShareLock',granted:false,category:'access-acquire-shared'},
  {...key,pid:2,blockers:null,app_session:false,mode:'ExclusiveLock',granted:true,category:'worker-transaction-end'},
 ];
 const labels=new Map([['1:2:1','access-configuration:fixture-tenant-0']]);
 const nativeEdge=originalAdvisoryAttribution(locks,labels).edges[0];
 const [projected]=projectMixedPreflightLockWaits([{...wait,appAdvisoryAttribution:{
  phase:'pilot-http',edges:[nativeEdge,{...nativeEdge,blockerCategory:'audit-append'}],
 }}]);
 assert.equal(projected.advisoryEdges[0].waiterCategory,'access-acquire-shared');
 assert.equal(projected.advisoryEdges[0].blockerCategory,'worker-transaction-end');
 assert.equal(projected.advisoryEdges[1].blockerCategory,'unknown');
});
