import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  session: { personId: 'manager-person' },
  myEmployment: vi.fn(), request: vi.fn(), revalidate: vi.fn(),
}));
vi.mock('../lib/scope', () => ({ scopedSession: async () => ({ s: state.session }) }));
vi.mock('../core/read', () => ({ myEmployment: state.myEmployment }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: state.revalidate }));
vi.mock('../packs/attendance/service', () => ({
  requestAttendanceCorrection: state.request,
  AttendanceCorrectionFutureDateError: class extends Error {},
  AttendanceCorrectionPendingError: class extends Error {},
}));
import { requestOwnAttendanceDayAction } from '../app/attendance/my-records/[date]/actions';
import { AttendanceCorrectionFutureDateError, AttendanceCorrectionPendingError } from '../packs/attendance/service';
const form = () => {
  const data = new FormData();
  Object.entries({ date: '2025-06-04', checkIn: '09:00', checkOut: '18:00', reason: 'Forgot to punch', from: '2025-06-01', to: '2025-06-30', employmentId: 'report-employment' })
    .forEach(([key, value]) => data.set(key, value));
  return data;
};
beforeEach(() => {
  vi.clearAllMocks();
  state.myEmployment.mockResolvedValue({ employmentId: 'manager-own-employment' });
  state.request.mockResolvedValue({ correctionId: 'request' });
});
describe('employee attendance day action', () => {
  it('a manager cannot use the posted employee id to correct a report through the self route', async () => {
    await expect(requestOwnAttendanceDayAction(form())).rejects.toThrow('corrected=1');
    expect(state.myEmployment).toHaveBeenCalledWith(state.session);
    expect(state.request).toHaveBeenCalledWith(state.session, {
      employmentId: 'manager-own-employment', date: '2025-06-04', checkIn: '09:00', checkOut: '18:00', reason: 'Forgot to punch',
    });
    expect(state.revalidate).toHaveBeenCalledWith('/attendance/my-records/2025-06-04');
  });
  it.each([
    ['reason', '', 'correctionReasonRequired'],
    ['date', '2025-02-30', 'correctionBadDate'],
    ['checkOut', '08:00', 'myDayBadTimes'],
    ['checkIn', '25:00', 'myDayBadTimes'],
  ])('refuses invalid %s before creating a request', async (key, value, message) => {
    const data = form(); data.set(key, value);
    await expect(requestOwnAttendanceDayAction(data)).rejects.toThrow(`error=${message}`);
    expect(state.request).not.toHaveBeenCalled();
  });
  it.each([
    [AttendanceCorrectionPendingError, 'myDayPending'],
    [AttendanceCorrectionFutureDateError, 'myDayFuture'],
  ])('translates the typed kernel refusal while retaining the list range', async (ErrorType, message) => {
    state.request.mockRejectedValue(new ErrorType());
    await expect(requestOwnAttendanceDayAction(form())).rejects.toThrow(`from=2025-06-01&to=2025-06-30&error=${message}`);
    expect(state.revalidate).not.toHaveBeenCalled();
  });
});
