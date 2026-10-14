import { describe, expect, it } from 'vitest';
import { checkedAttendanceHistoryFilter,attendanceHistoryDate,attendanceHistoryReturn } from '../lib/attendance-history-filter';
import { removalPreservesSequence } from '../lib/attendance-removal';
describe('Attendance History filter/date/return contracts',()=>{
  it('keeps attendance dates distinct from submitted dates and refuses impossible or reversed ranges',()=>{
    expect(checkedAttendanceHistoryFilter({attendanceFrom:'2026-10-01',attendanceTo:'2026-10-14',submittedFrom:'2026-09-01',submittedTo:'2026-10-15',requestKind:'short_hours'})).toMatchObject({attendanceFrom:'2026-10-01',submittedFrom:'2026-09-01',requestKind:'short_hours'});
    expect(()=>checkedAttendanceHistoryFilter({attendanceFrom:'2026-02-30'})).toThrow();
    expect(()=>checkedAttendanceHistoryFilter({attendanceFrom:'2026-10-14',attendanceTo:'2026-10-01'})).toThrow();
    expect(()=>checkedAttendanceHistoryFilter({employmentId:'bad'})).toThrow();
  });
  it('formats date-only values without a timezone conversion',()=>{expect(attendanceHistoryDate('2026-10-01')).toBe('01-Oct-2026');expect(attendanceHistoryDate('2026-01-31')).toBe('31-Jan-2026');});
  it('only retains supported list parameters, never an arbitrary redirect',()=>{
    expect(attendanceHistoryReturn('https://evil.test')).toBe('/attendance/application-history');
    expect(attendanceHistoryReturn('/attendance/application-history/../../evil')).toBe('/attendance/application-history');
    expect(attendanceHistoryReturn('/attendance/application-history?status=pending&page=2&returnTo=https://evil.test')).toBe('/attendance/application-history?status=pending&page=2');
  });
});
describe('Narrow punch removal sequence',()=>{
  const rows=(directions:('in'|'out')[])=>directions.map((direction,id)=>({id:String(id),direction}));
  it('refuses leaving an out without its previously matched in',()=>expect(removalPreservesSequence(rows(['in','out']),'0')).toBe(false));
  it('allows an accidental trailing out to reopen an in and a lone in to be removed',()=>{expect(removalPreservesSequence(rows(['in','out']),'1')).toBe(true);expect(removalPreservesSequence(rows(['in']),'0')).toBe(true);});
  it('retains supported out-first evidence without introducing another orphan',()=>{expect(removalPreservesSequence(rows(['out','in','out']),'0')).toBe(true);expect(removalPreservesSequence(rows(['out','in','out']),'1')).toBe(false);});
  it('supports repeated directions without removing a second record',()=>expect(removalPreservesSequence(rows(['in','in','out']),'0')).toBe(true));
});
