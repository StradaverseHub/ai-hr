import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  session: { personId: 'manager-person', userId:'manager-user' },
  myEmployment: vi.fn(), own:vi.fn(), request: vi.fn(), revalidate: vi.fn(),
}));
vi.mock('../lib/scope', () => ({ scopedSession: async () => ({ s: state.session }) }));
vi.mock('../core/read', () => ({ myEmployment: state.myEmployment,myOwnEmploymentSubjects:state.own }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: state.revalidate }));
vi.mock('../packs/attendance/service', () => ({
  requestAttendanceCorrection: state.request,
  AttendanceCorrectionFutureDateError: class extends Error {},
  AttendanceCorrectionPendingError: class extends Error {},
  AttendancePayrollClosedError: class extends Error {},
  AttendanceWorkflowError: class extends Error { constructor(public code:string){super(code);} },
}));
import { requestOwnAttendanceDayAction } from '../app/(app)/attendance/my-records/[date]/actions';
import { AttendanceCorrectionFutureDateError, AttendanceCorrectionPendingError, AttendancePayrollClosedError, AttendanceWorkflowError } from '../packs/attendance/service';
const form = () => {
  const data = new FormData();
  Object.entries({ date: '2025-06-04', checkIn: '09:00', checkOut: '18:00', reason: 'Forgot to punch', from: '2025-06-01', to: '2025-06-30' })
    .forEach(([key, value]) => data.set(key, value));
  return data;
};
beforeEach(() => {
  vi.clearAllMocks();
  state.own.mockResolvedValue([{employmentId:'8cfa58c2-dd92-4eb6-8f8c-ab19406115fd',personName:'Own second'}]);
  state.myEmployment.mockResolvedValue({ employmentId: 'manager-own-employment' });
  state.request.mockResolvedValue({ correctionId: 'request' });
});
describe('employee attendance day action', () => {
  it.each(['noMatch','tie','unresolved'] as const)('keeps the %s refusal as a page-owned localized message',async code=>{
    state.request.mockRejectedValue(new AttendanceWorkflowError(code,'Fictional routing refusal'));
    await expect(requestOwnAttendanceDayAction(form())).rejects.toThrow('correctionError=myDayWorkflowUnavailable');
    expect(state.revalidate).not.toHaveBeenCalled();
  });
  it('retains safe calendar coordinates through submission and refreshes the calendar', async () => {
    const data = form();
    for (const [key, value] of Object.entries({ calendar: '1', calendarView: 'week', calendarMonth: '2025-06', calendarDate: '2025-06-02', returnTo: 'https://untrusted.invalid' })) data.set(key,value);
    await expect(requestOwnAttendanceDayAction(data)).rejects.toThrow('calendar=1&calendarView=week&calendarMonth=2025-06&calendarDate=2025-06-02&calendarPage=0&calendarSize=25&corrected=1');
    expect(state.revalidate).toHaveBeenCalledWith('/attendance/my-roster');
    expect(state.request).toHaveBeenCalledWith(state.session, expect.objectContaining({ employmentId: 'manager-own-employment' }));
  });
  it('keeps the established subject when no selector is supplied', async () => {
    await expect(requestOwnAttendanceDayAction(form())).rejects.toThrow('corrected=1');
    expect(state.myEmployment).toHaveBeenCalledWith(state.session);
    expect(state.request).toHaveBeenCalledWith(state.session, {
      employmentId: 'manager-own-employment', date: '2025-06-04', checkIn: '09:00', checkOut: '18:00', reason: 'Forgot to punch',
    });
    expect(state.revalidate).toHaveBeenCalledWith('/attendance/my-records/2025-06-04');
  });
  it('uses the selected second own subject and preserves Home through the successful write',async()=>{
    const data=form();data.set('employmentId','8cfa58c2-dd92-4eb6-8f8c-ab19406115fd');data.set('home','1');
    await expect(requestOwnAttendanceDayAction(data)).rejects.toThrow('employmentId=8cfa58c2-dd92-4eb6-8f8c-ab19406115fd&home=1&corrected=1');
    expect(state.myEmployment).not.toHaveBeenCalled();expect(state.request).toHaveBeenCalledWith(state.session,expect.objectContaining({employmentId:'8cfa58c2-dd92-4eb6-8f8c-ab19406115fd'}));
  });
  it.each(['','report-employment','bfd90e63-c78c-4a10-8c51-56e878f42722'])('refuses explicit unavailable selector %s without falling back',async id=>{
    const data=form();data.set('employmentId',id);
    await expect(requestOwnAttendanceDayAction(data)).rejects.toThrow('correctionError=correctionForbidden');
    expect(state.myEmployment).not.toHaveBeenCalled();expect(state.request).not.toHaveBeenCalled();
  });
  it('refuses duplicate selectors before writes',async()=>{
    const data=form();data.append('employmentId','8cfa58c2-dd92-4eb6-8f8c-ab19406115fd');data.append('employmentId','8cfa58c2-dd92-4eb6-8f8c-ab19406115fd');
    await expect(requestOwnAttendanceDayAction(data)).rejects.toThrow('correctionError=correctionForbidden');expect(state.request).not.toHaveBeenCalled();
  });
  it.each([
    ['reason', '', 'correctionReasonRequired'],
    ['date', '2025-02-30', 'correctionBadDate'],
    ['checkOut', '08:00', 'myDayBadTimes'],
    ['checkIn', '25:00', 'myDayBadTimes'],
  ])('refuses invalid %s before creating a request', async (key, value, message) => {
    const data = form(); data.set(key, value);
    await expect(requestOwnAttendanceDayAction(data)).rejects.toThrow(`correctionError=${message}`);
    expect(state.request).not.toHaveBeenCalled();
  });
  it.each([
    [AttendanceCorrectionPendingError, 'myDayPending'],
    [AttendanceCorrectionFutureDateError, 'myDayFuture'],
    [AttendancePayrollClosedError, 'clockDataPayrollClosed'],
  ])('translates the typed kernel refusal while retaining the list range', async (ErrorType, message) => {
    state.request.mockRejectedValue(new ErrorType());
    await expect(requestOwnAttendanceDayAction(form())).rejects.toThrow(`from=2025-06-01&to=2025-06-30&correctionError=${message}`);
    expect(state.revalidate).not.toHaveBeenCalled();
  });
});
