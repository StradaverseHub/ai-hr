import {beforeEach,describe,expect,it,vi} from 'vitest';
import {todayInKualaLumpur} from '../lib/hr-date';
import {liveClockSeconds} from '../lib/clock-elapsed';
import {validateEmployeeHomeToday,type EmployeeHomeToday} from '../lib/employee-home-today';
const state=vi.hoisted(()=>({subject:vi.fn(),enabled:vi.fn(),clock:vi.fn(),kind:vi.fn(),locations:vi.fn(),leave:vi.fn(),payroll:vi.fn()}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,read:(tx:unknown)=>unknown)=>read({})}));
vi.mock('../core/employee-home',()=>({requireOwnHomeSubject:state.subject}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:state.enabled}));
vi.mock('../packs/attendance/service',()=>({ownClockTodaySummary:state.clock,workedDayKindForTx:state.kind,employeeClockingLocationLabels:state.locations}));
vi.mock('../packs/leave/service',()=>({approvedLeavePresenceByEmploymentTx:state.leave}));
vi.mock('../packs/payroll/service',()=>({readOwnPayrollHomeMetadata:state.payroll}));
import {readEmployeeHomeToday} from '../core/employee-home-today';
const now=new Date().toISOString(),date=todayInKualaLumpur(new Date(now)),ctx={tenantId:'tenant',personId:'person',userId:'login',roles:['employee']} as Parameters<typeof readEmployeeHomeToday>[0];
export function todayData():EmployeeHomeToday{return {version:1,employmentId:'own',serverNow:now,businessDate:date,attendanceEnabled:true,payrollEnabled:true,clock:{date,clockedIn:false,openSince:null,workedSeconds:300,crossesMidnight:false,shift:{code:'SF',start:'09:00',end:'18:00'},geofencingRequired:false,photoRequired:false},dayKind:'workday',leavePresence:null,workLocations:{total:1,names:['Fictional HQ']},payday:{date,daysAway:0}};}
beforeEach(()=>{vi.clearAllMocks();state.subject.mockResolvedValue({employmentId:'own'});state.enabled.mockReturnValue(true);state.clock.mockResolvedValue({...todayData().clock,serverNow:now,attendancePhotoSetting:'not_required',captureGPS:'private'});state.kind.mockResolvedValue('workday');state.locations.mockResolvedValue({total:1,names:['Fictional HQ']});state.leave.mockResolvedValue(new Map());state.payroll.mockResolvedValue({nextPayment:{date,amount:'private'}});});
describe('Your Day independent own metadata',()=>{
 it('uses canonical owners and sends only the small clock and recorded payment facts',async()=>{
  const value=await readEmployeeHomeToday(ctx,'own');expect(validateEmployeeHomeToday(value,'own')).toEqual(todayData());
  expect(state.subject).toHaveBeenCalledWith(ctx,'own');expect(state.clock).toHaveBeenCalledWith(ctx,'own');expect(state.payroll).toHaveBeenCalledWith(ctx,'own');
  expect(JSON.stringify(value)).not.toMatch(/private|amount|captureGPS/);
 });
 it('does not read disabled attendance or payroll owners',async()=>{
  state.enabled.mockReturnValue(false);const value=await readEmployeeHomeToday(ctx,'own');
  expect(validateEmployeeHomeToday(value,'own')).toMatchObject({clock:null,dayKind:null,payday:null,workLocations:{total:0,names:[]}});
  for(const reader of [state.clock,state.kind,state.locations,state.leave,state.payroll])expect(reader).not.toHaveBeenCalled();
 });
 it('unavailable own identity stops all domain reads',async()=>{
  state.subject.mockRejectedValue(Error('unavailable'));await expect(readEmployeeHomeToday(ctx,'foreign')).rejects.toThrow('unavailable');expect(state.clock).not.toHaveBeenCalled();
 });
 it('does not turn an owner failure into a false empty day',async()=>{state.clock.mockRejectedValue(Error('offline'));await expect(readEmployeeHomeToday(ctx,'own')).rejects.toThrow('offline');});
 it('retains approved part-day presence and an open overnight date',async()=>{
  state.leave.mockResolvedValue(new Map([['own',new Map([[date,'part_day']])]]));state.clock.mockResolvedValue({...todayData().clock,serverNow:now,clockedIn:true,openSince:now,crossesMidnight:true,attendancePhotoSetting:'required'});
  expect(await readEmployeeHomeToday(ctx,'own')).toMatchObject({leavePresence:'part_day',clock:{clockedIn:true,crossesMidnight:true,photoRequired:true}});
 });
 it.each([
  (v:EmployeeHomeToday)=>({...v,employmentId:'foreign'}),
  (v:EmployeeHomeToday)=>({...v,businessDate:'2025-02-30'}),
  (v:EmployeeHomeToday)=>({...v,clock:{...v.clock!,workedSeconds:-1}}),
  (v:EmployeeHomeToday)=>({...v,clock:{...v.clock!,clockedIn:true,openSince:null}}),
  (v:EmployeeHomeToday)=>({...v,payrollEnabled:false}),
  (v:EmployeeHomeToday)=>({...v,workLocations:{total:1,names:['A','B']}}),
 ])('refuses incoherent transport instead of rendering success',mutate=>{expect(()=>validateEmployeeHomeToday(mutate(todayData()),'own')).toThrow('unavailable');});
 it('counts only time after both the snapshot and a future clock-in, and keeps closed totals',()=>{
  const snapshot={serverNow:now,clockedIn:true,openSince:new Date(Date.parse(now)+60000).toISOString(),workedSeconds:300};
  expect(liveClockSeconds(snapshot,Date.parse(now)+30000)).toBe(300);expect(liveClockSeconds(snapshot,Date.parse(now)+90000)).toBe(330);
  expect(liveClockSeconds({...snapshot,clockedIn:false},Date.parse(now)+90000)).toBe(300);expect(liveClockSeconds(snapshot,Date.parse(now)-30000)).toBe(300);
 });
});
