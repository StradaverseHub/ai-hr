import { expect, it } from 'vitest';
import { personalAttendanceStatus, statusOf } from '../core/attendance-derive';
const today='2026-10-22';
const planned={date:'2026-10-23',attendanceId:null,status:null,context:null,isRosterRest:false,exceptionExempt:false};
it('withholds an unrecorded future working-day absence only on personal views',()=>{
  expect(statusOf(planned)).toBe('absent');
  expect(personalAttendanceStatus(planned,today)).toBeNull();
  expect(personalAttendanceStatus({...planned,date:today},today)).toBe('absent');
});
it('keeps recorded absence, future leave, rest, holiday and exemptions',()=>{
  expect(personalAttendanceStatus({...planned,attendanceId:'record',status:'absent'},today)).toBe('absent');
  expect(personalAttendanceStatus({...planned,context:'on_leave'},today)).toBe('on_leave');
  expect(personalAttendanceStatus({...planned,context:'rest_day',isRosterRest:true},today)).toBe('rest');
  expect(personalAttendanceStatus({...planned,context:'holiday'},today)).toBe('ph');
  expect(personalAttendanceStatus({...planned,exceptionExempt:true},today)).toBe('exempt');
});
