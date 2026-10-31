/** Boundary behavior with no database: a refused range must issue neither owner read. */
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {beforeEach,expect,it,vi} from 'vitest';
import {AttendanceRecordList} from '../app/(app)/attendance/my-roster/record-list';
import {resolveAttendanceCalendarState} from '../app/(app)/attendance/my-roster/attendance-links';
import {todayInKualaLumpur} from '../lib/hr-date';
const mocks=vi.hoisted(()=>({employment:vi.fn(),attendance:vi.fn(),holiday:vi.fn()}));
vi.mock('../core/read',()=>({myEmployment:mocks.employment}));
vi.mock('../app/(app)/attendance/my-roster/holiday-context',()=>({personalCalendarHolidayContext:mocks.holiday}));
vi.mock('../packs/attendance/service',()=>({ATTENDANCE_RANGE_MAX_DAYS:400,attendanceForEmploymentRange:mocks.attendance,flagOf:()=>null,personalAttendanceStatus:()=>null}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=>((key:string)=>key)}));
const ctx={tenantId:'fictional-tenant',personId:'fictional-person',roles:['employee' as const]};
beforeEach(()=>{vi.clearAllMocks();mocks.employment.mockResolvedValue({employmentId:'fictional-own-employment'});mocks.attendance.mockResolvedValue([]);mocks.holiday.mockResolvedValue({originals:[],replacements:[]});});
async function readList(from:string,to:string) {
 const state=resolveAttendanceCalendarState({tab:'list',from,to},todayInKualaLumpur());
 return AttendanceRecordList({s:ctx,state,query:{tab:'list',from,to}});
}
it.each(['invalid','inverted','too_long'])('refuses a %s range before reading either attendance or holiday owners',async(reason)=>{
 const today=todayInKualaLumpur(),past=`${Number(today.slice(0,4))-2}-01-01`;
 const from=reason==='invalid'?'not-a-date':reason==='inverted'?today:past;
 const to=reason==='inverted'?past:today;
 const html=renderToStaticMarkup(createElement(NextIntlClientProvider,{locale:'en',messages:en,children:await readList(from,to)}));
 expect(mocks.attendance).not.toHaveBeenCalled();expect(mocks.holiday).not.toHaveBeenCalled();
 expect(html).toContain(reason==='invalid'?'myCalendar.invalidRange':reason==='inverted'?'myRecords.rangeInverted':'myRecords.rangeTooLong');
 expect(html).not.toContain('noRecords');
});
it('passes the exact permitted own employment and valid range to both owners',async()=>{
 const today=todayInKualaLumpur();await readList(today,today);
 expect(mocks.employment).toHaveBeenCalledWith(ctx);
 expect(mocks.attendance).toHaveBeenCalledWith(ctx,'fictional-own-employment',today,today);
 expect(mocks.holiday).toHaveBeenCalledWith(ctx,'fictional-own-employment',today,today);
});
