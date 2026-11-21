import {beforeEach,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {employment,rosterAssignment} from '../db/schema';
const state=vi.hoisted(()=>({holiday:vi.fn(),leave:vi.fn()}));
vi.mock('../core/read',()=>({listEmployees:vi.fn(),listEmployeesPage:vi.fn(),myEmployment:vi.fn(),ownReportingManagersTx:vi.fn()}));
vi.mock('../core/attendance',()=>({isWorkingDayKind:vi.fn(),netScheduledMinutes:vi.fn(),shiftDayKindFor:vi.fn(),shiftSpan:vi.fn(),weekLookupTx:async()=>()=>({pattern:[]})}));
vi.mock('../packs/attendance/service',()=>({workingShiftSchedule:vi.fn(),rotationLookupTx:async()=>({versions:[],shifts:[]}),assertRotationPoolWriteTx:vi.fn()}));
vi.mock('../core/holidays',()=>({holidayCalendarFactsByEmployment:state.holiday}));
vi.mock('../packs/leave/service',()=>({approvedLeavePresenceByEmploymentTx:state.leave,lockLeaveDependenciesTx:vi.fn(),lockLeaveDependencyReadConfigurationTx:vi.fn(),lockLeaveDependencyConfigurationTx:vi.fn(),LeaveDependencyUnavailable:Error}));
import {hydrateRosterWindow} from '../core/roster';
const ctx={tenantId:'tenant',userId:'user'} as SessionContext;
const input={from:'2027-01-04',to:'2027-01-04',dates:['2027-01-04'],employees:[{employmentId:'e1',name:'Employee',code:null,department:null,departmentId:null,businessUnit:null,businessUnitId:null,occupation:null,company:null,companyId:null}],allEmployees:[],shiftRows:[]};
beforeEach(()=>{vi.clearAllMocks();});
function transaction(failRoster:Error|undefined,started:unknown[]){
 return {select:()=>{
  let table:unknown;
  const chain={from:(next:unknown)=>{table=next;started.push(next);return chain;},where:()=>chain,leftJoin:()=>chain,orderBy:()=>chain,
   then:(resolve:(rows:unknown[])=>unknown,reject:(reason:unknown)=>unknown)=>Promise.resolve().then(()=>{if(table===rosterAssignment&&failRoster)throw failRoster;return [];}).then(resolve,reject)};
  return chain;
 }} as unknown as Tx;
}
it('propagates the original roster failure before starting another borrowed multi-query reader',async()=>{
 const failure=Error('controlled roster failure'),started:unknown[]=[];
 await expect(hydrateRosterWindow(ctx,input,transaction(failure,started))).rejects.toBe(failure);
 expect(started).toEqual([rosterAssignment]);expect(started).not.toContain(employment);expect(state.holiday).not.toHaveBeenCalled();expect(state.leave).not.toHaveBeenCalled();
});
it('does not leave a pending approved-leave sibling after holiday hydration fails',async()=>{
 const failure=Error('controlled calendar failure'),started:unknown[]=[];
 state.holiday.mockRejectedValueOnce(failure);state.leave.mockImplementation(()=>new Promise(()=>{}));
 await expect(hydrateRosterWindow(ctx,input,transaction(undefined,started))).rejects.toBe(failure);
 expect(state.holiday).toHaveBeenCalledTimes(1);expect(state.leave).not.toHaveBeenCalled();
});
