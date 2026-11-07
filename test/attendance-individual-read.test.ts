import {beforeEach,expect,it,vi} from 'vitest';
import {readIndividualAttendance} from '../app/attendance/individual/read';
import {resolveMyAttendanceRange} from '../app/attendance/my-records/range';
import {pageState,parsePageQuery} from '../lib/pagination';
const mocks=vi.hoisted(()=>({page:vi.fn()}));
vi.mock('../packs/attendance/service',()=>({attendanceEmploymentRangePage:mocks.page}));
const ctx={tenantId:'fictional-tenant',roles:['employee']},employmentId='fictional-authorized-employment';
beforeEach(()=>{vi.clearAllMocks();mocks.page.mockResolvedValue({dayPage:[{date:'2026-07-01'}],pgState:pageState(parsePageQuery(),31,1),total:31,punchesByAttendance:new Map()});});
it.each([
 ['invalid','2026-02-30','2026-07-31'],['inverted','2026-07-31','2026-07-01'],['too_long','2020-01-01','2026-07-31'],
])('refuses %s dates before the native Attendance owner runs',async(reason,from,to)=>{
 const range=resolveMyAttendanceRange({from,to},'2026-07-31',400);expect(range.refusal).toBe(reason);
 const result=await readIndividualAttendance(ctx,employmentId,range,parsePageQuery());
 expect(mocks.page).not.toHaveBeenCalled();expect(result.total).toBe(0);expect(result.dayPage).toEqual([]);
});
it('passes the exact server-authorized selection, range and pager to one native composition',async()=>{
 const range=resolveMyAttendanceRange({from:'2026-07-01',to:'2026-07-31'},'2026-07-31',400),page=parsePageQuery({page:'1',size:'25'});
 const result=await readIndividualAttendance(ctx,employmentId,range,page);
 expect(mocks.page).toHaveBeenCalledExactlyOnceWith(ctx,employmentId,range.from,range.to,page);
 expect(result).toBe(await mocks.page.mock.results[0].value);
});
it('does not read without a server-authorized selection',async()=>{
 const range=resolveMyAttendanceRange({from:'2026-07-01',to:'2026-07-31'},'2026-07-31',400);
 expect(await readIndividualAttendance(ctx,undefined,range,parsePageQuery())).toMatchObject({total:0,dayPage:[]});
 expect(mocks.page).not.toHaveBeenCalled();
});
