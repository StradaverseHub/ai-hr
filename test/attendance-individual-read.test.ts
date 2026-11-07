import {beforeEach,expect,it,vi} from 'vitest';
import {readIndividualAttendance} from '../app/attendance/individual/read';
import {resolveMyAttendanceRange} from '../app/attendance/my-records/range';
import {parsePageQuery} from '../lib/pagination';
const mocks=vi.hoisted(()=>({days:vi.fn(),punches:vi.fn()}));
vi.mock('../core/attendance',()=>({attendanceForEmploymentRange:mocks.days,attendancePunchesForRange:mocks.punches}));
const ctx={tenantId:'fictional-tenant',roles:['employee']},employmentId='fictional-authorized-employment';
beforeEach(()=>{
 vi.clearAllMocks();mocks.days.mockResolvedValue(Array.from({length:31},(_,i)=>({date:`2026-07-${String(i+1).padStart(2,'0')}`,attendanceId:'day-'+i})));
 mocks.punches.mockResolvedValue(new Map([['day-0',[{punchAt:'09:00',direction:'in'},{punchAt:'12:00',direction:'out'},{punchAt:'13:00',direction:'in'}]]]));
});
it.each([
 ['invalid','2026-02-30','2026-07-31'],['inverted','2026-07-31','2026-07-01'],['too_long','2020-01-01','2026-07-31'],
])('refuses %s dates before either Attendance owner runs',async(reason,from,to)=>{
 const range=resolveMyAttendanceRange({from,to},'2026-07-31',400);
 expect(range.refusal).toBe(reason);
 const result=await readIndividualAttendance(ctx,employmentId,range,parsePageQuery());
 expect(mocks.days).not.toHaveBeenCalled();expect(mocks.punches).not.toHaveBeenCalled();expect(result.total).toBe(0);
});
it.each([
 ['0','2026-07-01','2026-07-25',25],['1','2026-07-26','2026-07-31',6],
])('reads exact punch details only for visible page %s while preserving full day count',async(page,from,to,shown)=>{
 const range=resolveMyAttendanceRange({from:'2026-07-01',to:'2026-07-31'},'2026-07-31',400);
 const result=await readIndividualAttendance(ctx,employmentId,range,parsePageQuery({page,size:'25'}));
 expect(mocks.days).toHaveBeenCalledWith(ctx,employmentId,'2026-07-01','2026-07-31');
 expect(mocks.punches).toHaveBeenCalledWith(ctx,employmentId,from,to);
 expect(result.total).toBe(31);expect(result.dayPage).toHaveLength(shown);expect(result.pgState.total).toBe(31);
 expect(result.punchesByAttendance).toBe(await mocks.punches.mock.results[0].value);
});
it('does not load attendance or punches without a server-authorized selection or for an empty page',async()=>{
 const range=resolveMyAttendanceRange({from:'2026-07-01',to:'2026-07-31'},'2026-07-31',400);
 await readIndividualAttendance(ctx,undefined,range,parsePageQuery());
 expect(mocks.days).not.toHaveBeenCalled();expect(mocks.punches).not.toHaveBeenCalled();
 const result=await readIndividualAttendance(ctx,employmentId,range,parsePageQuery({page:'100'}));
 expect(mocks.days).toHaveBeenCalledOnce();expect(mocks.punches).not.toHaveBeenCalled();expect(result.total).toBe(31);expect(result.dayPage).toEqual([]);
});
