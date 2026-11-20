import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPreflightRequestTimeline,originalAdvisoryAttribution,projectMixedPreflightLockWaits} from '../../scripts/performance/lock-sample-attribution.mjs';
import {projectMixedBrowserVisitFailure,projectMixedLoadedTable} from '../../scripts/performance/worker-comparison-failure.mjs';

test('retains visible rows during a document timeout without exposing route data',()=>{
 const row={phase:'loaded',role:'companyHR',path:'/admin/personnel',visitStage:'navigation',errorType:'TimeoutError',
  elapsedMs:90000,tableNavigation:{responseMs:217,firstVisibleRowMs:647,documentParsedMs:null,text:'private'}};
 const expected={role:'companyHR',route:'/admin/personnel',responseMs:217,firstVisibleRowMs:647,documentParsedMs:null};
 assert.deepEqual(projectMixedLoadedTable(row),expected);
 assert.deepEqual(projectMixedBrowserVisitFailure(row).tableNavigation,expected);
 assert.equal(projectMixedLoadedTable({...row,path:'/admin/personnel/private-id'}),null);
 assert.equal(projectMixedLoadedTable({...row,tableNavigation:{...row.tableNavigation,responseMs:null}}),null);
 assert.equal(projectMixedLoadedTable({...row,tableNavigation:{...row.tableNavigation,firstVisibleRowMs:216}}),null);
});

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

test('reports only allowed request categories overlapping the original sample',()=>{
 const timeline=createPreflightRequestTimeline();
 const actor={role:'groupHR',channel:'browser'};
 timeline.begin({...actor,path:'/login/api/mfa',method:'POST'},100)(130);
 timeline.begin({...actor,path:'/admin/personnel/e69c7759-ff36-4209-9b03-d088da89e602?search=private',method:'GET'},132)(151);
 timeline.begin({...actor,path:'/admin/personnel?employeeCode=private',method:'GET'},154);
 timeline.begin({...actor,path:'/unknown/private',method:'GET'},134);
 const overlap=timeline.overlapping(136,148);
 assert.deepEqual(overlap,[{...actor,route:'/admin/personnel/[employmentId]',method:'GET'}]);
 const [projection]=projectMixedPreflightLockWaits([{...wait,preflightRequestOverlap:[...overlap,
  {...actor,route:'/unknown/private',method:'GET'},
 ]}]);
 assert.deepEqual(projection.requestOverlap,overlap);
});
