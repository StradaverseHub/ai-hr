import { describe, expect, it, vi } from 'vitest';
import { todayInKualaLumpur } from '../lib/hr-date';
const state = vi.hoisted(() => ({ date: '', range: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: async () => ({}) }));
vi.mock('../core/read', () => ({ myEmployment: async () => ({ employmentId: 'own-employment' }) }));
vi.mock('../core/attendance-clock-read', () => ({ ownClockToday: async () => ({ date: state.date, shift: { code: 'NIGHT', start: '22:00', end: '06:00' } }) }));
vi.mock('../core/attendance', () => ({ attendanceForEmploymentRange: (...args: unknown[]) => state.range(...args), isoWeekday: () => 1 }));
vi.mock('../core/roster', () => ({ listShiftsForTenant: async () => [
  { code: 'NIGHT', name: 'Overnight shift', startTime: '22:00', endTime: '06:00', weeklyPattern: [], halfPattern: [], offPattern: [] },
  { code: 'DAY', name: 'Following day shift', startTime: '09:00', endTime: '17:00', weeklyPattern: [], halfPattern: [], offPattern: [] },
] }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
import Page from '../app/attendance/clock/page';
describe('r378 overnight clock page identity', () => {
  it('resolves the shift caption for the authoritative open attendance date rather than the wall date', async () => {
    const wallDate = todayInKualaLumpur();
    state.date = new Date(Date.parse(wallDate + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    state.range.mockImplementation(async (_ctx, _employment, from) => [{ shiftCode: from === state.date ? 'NIGHT' : 'DAY' }]);
    const page = await Page();
    expect(state.date).not.toBe(wallDate);
    expect(state.range).toHaveBeenCalledWith(expect.anything(), 'own-employment', state.date, state.date);
    expect(page.props.children.props.initial.shift).toEqual({ code: 'NIGHT', start: '22:00', end: '06:00' });
    expect(page.props.children.props.shiftName).toBe('Overnight shift');
    expect(page.props.children.props.shiftName).not.toBe('Following day shift');
  });
});
