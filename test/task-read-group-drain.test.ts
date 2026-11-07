import {expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {createBackgroundReadAdmission} from '../db/background-read-admission';
import {pendingTaskSummary} from '../core/approvals-inbox';

const io=vi.hoisted(()=>({manager:vi.fn(),calibration:vi.fn(),assessment:vi.fn()}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,read:(tx:unknown)=>unknown)=>read({execute:async()=>[{has_candidates:false}]})}));
vi.mock('../core/approvals',()=>({assertAssignedWorkPrincipalTx:async()=>{}}));
vi.mock('../core/module-gate',()=>({withPerformanceTenant:async(_ctx:unknown,read:(tx:unknown)=>unknown)=>read({select:()=>io.assessment()})}));
vi.mock('../core/performance',()=>({managerPendingReviews:io.manager}));
vi.mock('../packs/performance/onehr/calibration-list',()=>({pendingCalibrationTasks:io.calibration}));
vi.mock('../packs/performance/service',async()=>({pendingPerformanceTasks:(await import('../packs/performance/onehr/tasks')).pendingPerformanceTasks}));
vi.mock('../packs/rewards/service',()=>({pendingRewardTasks:async()=>[]}));
vi.mock('../packs/leave/service',()=>({pendingLeaveTaskMetadata:async()=>[],pendingLeaveCancellationTaskMetadata:async()=>[],pendingLeaveCancellationCandidatesExistSql:()=>false,listPendingReplacementLeaveTasks:async()=>[]}));
vi.mock('../packs/claims/service',()=>({countPendingClaimTasks:async()=>0,pendingClaimTaskMetadata:async()=>[],pendingClaimTaskSummary:async()=>({items:[],total:0})}));
vi.mock('../packs/attendance/service',()=>({pendingAttendanceTaskMetadata:async()=>[]}));
vi.mock('../core/profile',()=>({pendingProfileTaskMetadata:async()=>[]}));
vi.mock('../core/offboarding',()=>({pendingResignationCandidatesExistSql:()=>false,pendingResignationTaskMetadata:async()=>[]}));
vi.mock('../core/notice',()=>({pendingNoticeAcknowledgementTasks:async()=>[]}));
vi.mock('../core/employment-review',()=>({pendingReviewCandidatesExistSql:()=>false,pendingReviewTaskMetadata:async()=>[]}));

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function query<T>(result:Promise<T>){const value={from:()=>value,where:()=>value,innerJoin:()=>value,orderBy:()=>value,then:result.then.bind(result)};return value;}

it('keeps the real inbox and Performance provider inside one logical lease through a later assessment query',async()=>{
 const manager=deferred<never[]>(),calibration=deferred<never[]>(),own=deferred<{id:string}[]>(),assessment=deferred<never[]>();
 io.manager.mockReturnValue(manager.promise);io.calibration.mockReturnValue(calibration.promise);
 io.assessment.mockReturnValueOnce(query(own.promise)).mockReturnValueOnce(query(assessment.promise));
 const gate=createBackgroundReadAdmission({capacity:1,maxWaiting:2,waitMs:1000});
 const ctx={tenantId:'fictional-tenant',personId:'fictional-person'} as SessionContext;
 let finished=false,nextEntered=false;const original=new Error('manager owner failed');
 const first=gate.run(ctx.tenantId,()=>pendingTaskSummary(ctx,undefined,{attendance:false,claims:false,performance:true,rewards:false}));
 const observed=first.then(()=>{finished=true;return null;},error=>{finished=true;return error;});
 const next=gate.run('another-tenant',async()=>{nextEntered=true;});
 await vi.waitFor(()=>{expect(io.manager).toHaveBeenCalledTimes(1);expect(io.calibration).toHaveBeenCalledTimes(1);expect(io.assessment).toHaveBeenCalledTimes(1);});
 manager.reject(original);await Promise.resolve();expect(finished).toBe(false);expect(nextEntered).toBe(false);
 own.resolve([{id:'fictional-employment'}]);await vi.waitFor(()=>expect(io.assessment).toHaveBeenCalledTimes(2));
 calibration.resolve([]);await Promise.resolve();expect(finished).toBe(false);
 expect(gate.snapshot()).toMatchObject({active:1,waiting:1});
 assessment.resolve([]);expect(await observed).toBe(original);await next;
 expect(nextEntered).toBe(true);expect(gate.snapshot()).toMatchObject({active:0,waiting:0});
});
