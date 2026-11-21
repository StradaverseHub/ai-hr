import {describe,expect,it,vi} from 'vitest';
import {drainNotificationProjection} from '../core/orchestrator-harness';
import {notificationProjectionCounters,recordCommittedProjectionBatch,notificationProjectionHealth,notificationSchedulingPrerequisite,
  NOTIFICATION_PROJECTION_JOB_KEY,type NotificationProjectionObservation} from '../lib/notification-scheduling-evidence';

const now=1_000_000,maxAge=180_000;
function completed():NotificationProjectionObservation {
 const counters=notificationProjectionCounters();counters.scopeLoaded=1;counters.scopeCompleted=1;
 return {jobKey:NOTIFICATION_PROJECTION_JOB_KEY,ranAt:new Date(now-1000),durationMs:500,outcome:'success',result:counters};
}

describe('notification projection evidence without a commissioned identity',()=>{
 it('records an empty committed pass without inventing notifications or installation evidence',async()=>{
  const counters=notificationProjectionCounters();
  const result=await drainNotificationProjection(async()=>{const batch={processed:0,created:0};recordCommittedProjectionBatch(counters,batch);return batch;});
  expect(result).toEqual({processed:0,created:0,cappedOut:false});
  expect(counters).toMatchObject({identityVerified:0,committedBatches:1,processedEvents:0,createdNotifications:0});
  expect(notificationProjectionHealth(completed(),now,maxAge)).toBe('completed');
  expect(notificationSchedulingPrerequisite(completed(),now,maxAge)).toEqual({ready:false,identity:'unverified',reason:'protectedAcceptedWorkerVerifierUnavailable',projection:'completed'});
 });
 it('retains preceding committed batches when a later transaction has an uncertain failure, without retry',async()=>{
  const counters=notificationProjectionCounters(),dispatch=vi.fn().mockResolvedValueOnce({processed:1000,created:3}).mockRejectedValue(new Error('private failure detail'));
  await expect(drainNotificationProjection(async limit=>{const batch=await dispatch(limit);recordCommittedProjectionBatch(counters,batch);return batch;})).rejects.toThrow('private failure detail');
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(counters).toMatchObject({committedBatches:1,processedEvents:1000,createdNotifications:3});
 });
 it('reports the existing bounded drain limit and does not claim it exhausted an endless stream',async()=>{
  const counters=notificationProjectionCounters(),dispatch=vi.fn(async(limit:number)=>({processed:limit,created:2}));
  const result=await drainNotificationProjection(async limit=>{const batch=await dispatch(limit);recordCommittedProjectionBatch(counters,batch);return batch;});
  expect(result).toEqual({processed:50_000,created:100,cappedOut:true});
  expect(dispatch).toHaveBeenCalledTimes(50);expect(counters).toMatchObject({committedBatches:50,processedEvents:50_000,createdNotifications:100});
  const run=completed();run.result!.cappedTenants=1;
  expect(notificationProjectionHealth(run,now,maxAge)).toBe('backlogged');
 });
 it('keeps SMTP availability separate from complete in-app projection',()=>{
  const run=completed();run.result!.emailUnavailableTenants=2;
  for(const outcome of ['success','partial','failed']){run.outcome=outcome;expect(notificationProjectionHealth(run,now,maxAge)).toBe('completed');}
  run.result!.projectionFailedTenants=1;
  expect(notificationProjectionHealth(run,now,maxAge)).toBe('failed');
 });
 it('never interprets a started or abandoned run as success',()=>{
  const run=completed();run.outcome='running';run.durationMs=null;
  expect(notificationProjectionHealth(run,now,maxAge)).toBe('running');
  expect(notificationProjectionHealth(run,now+maxAge,maxAge)).toBe('interrupted');
  expect(notificationSchedulingPrerequisite(run,now,maxAge).ready).toBe(false);
 });
 it('requires complete scope, complete backlog observation, supported capability and a fresh terminal run',()=>{
  expect(notificationProjectionHealth(null,now,maxAge)).toBe('missing');
  expect(notificationProjectionHealth(completed(),now+maxAge,maxAge)).toBe('stale');
  for(const change of [{scopeLoaded:0},{scopeCompleted:0},{capabilityVersion:99},{projectionTenants:1},{projectionBlockedTenants:1},{pendingEvents:NaN}]){
   const run=completed();Object.assign(run.result!,change);expect(notificationProjectionHealth(run,now,maxAge)).toBe('failed');
  }
  const backlog=completed();backlog.result!.pendingEvents=1;expect(notificationProjectionHealth(backlog,now,maxAge)).toBe('backlogged');
  const future=completed();future.ranAt=new Date(now+1);expect(notificationProjectionHealth(future,now,maxAge)).toBe('invalid');
  expect(notificationProjectionHealth(completed(),now,0)).toBe('invalid');
 });
 it('refuses arbitrary claimed identity metadata even on an otherwise complete fresh row',()=>{
  const run=completed();run.result!.identityVerified=1;
  Object.assign(run,{sourceSha:'a'.repeat(40),buildId:'claimed-build',accepted:true});
  expect(notificationSchedulingPrerequisite(run,now,maxAge)).toMatchObject({ready:false,identity:'unverified'});
 });
});
