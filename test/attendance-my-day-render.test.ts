import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
const state = vi.hoisted(() => ({ locale: 'en', own: vi.fn(), rows: vi.fn(), punches: vi.fn(), requests: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => state.locale,
  getTranslations: async () => createTranslator({ locale: state.locale, namespace: 'attendance', messages: JSON.parse(readFileSync(new URL(`../messages/${state.locale}.json`, import.meta.url), 'utf8')) }),
}));
vi.mock('../lib/scope', () => ({ scopedSession: async () => ({ s: { personId: 'manager' } }) }));
vi.mock('../lib/authz', () => ({ requireModule: async () => undefined }));
vi.mock('../core/read', () => ({ myEmployment: state.own }));
vi.mock('../app/attendance/my-records/[date]/actions', () => ({ requestOwnAttendanceDayAction: () => undefined }));
vi.mock('../components/attendance-figure-cells', () => ({ AttendanceFigureCells: () => createElement('td', { colSpan: 8 }, 'figures') }));
vi.mock('../packs/attendance/service', async () => ({
  attendanceForEmploymentRange: state.rows,
  attendancePunchesForRange: state.punches,
  myAttendanceCorrections: state.requests,
  ...(await import('../core/attendance-derive')),
  ...(await import('../core/attendance-explain')),
}));
import Page from '../app/attendance/my-records/[date]/page';
beforeEach(() => {
  vi.clearAllMocks(); state.locale = 'en';
  state.own.mockResolvedValue({ employmentId: 'manager-own', name: 'Own day' });
  state.rows.mockResolvedValue([{ date: '2025-06-04', attendanceId: 'own-row', status: 'present', context: null, dayType: 'workday', shiftCode: 'AM01', shiftStart: '09:00', shiftEnd: '18:00', scheduledMinutes: 480, workedMinutes: 480, checkInAt: '09:00', checkOutAt: '18:00', lateMinutes: 0, earlyOutMinutes: 0, otMinutes: 0, calcTrace: null }]);
  state.punches.mockResolvedValue(new Map()); state.requests.mockResolvedValue([]);
});
const render = async (extra = {}) => {
  const page = await Page({ params: Promise.resolve({ date: '2025-06-04' }), searchParams: Promise.resolve({ from: '2025-06-01', to: '2025-06-30', ...extra }) });
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: state.locale, messages: JSON.parse(readFileSync(new URL(`../messages/${state.locale}.json`, import.meta.url), 'utf8')) }, page));
};
describe('employee day render', () => {
  it('a manager sees their own day even when the URL asks for their report', async () => {
    const html = await render({ emp: 'report-employment' });
    expect(state.rows).toHaveBeenCalledWith(expect.anything(), 'manager-own', '2025-06-04', '2025-06-04');
    expect(state.punches).toHaveBeenCalledWith(expect.anything(), 'manager-own', '2025-06-04', '2025-06-04');
    expect(html).toContain('Own day');
    expect(html).not.toContain('report-employment');
    expect(html).toContain('/attendance/my-records?from=2025-06-01&amp;to=2025-06-30');
  });
  it.each(['en', 'ms', 'zh', 'ta', 'th', 'vi'])('renders pending state and all five sections in %s', async (locale) => {
    state.locale = locale; state.requests.mockResolvedValue([{ id: 'pending' }]);
    const html = await render();
    expect(html).toContain('<fieldset disabled=""');
    expect(html).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
    expect(html).toContain('AM01');
    const catalogue = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')).attendance;
    for (const key of ['daySecShift', 'daySecBreak', 'daySecClock', 'daySecIrregular', 'myDayPending']) expect(html).toContain(catalogue[key]);
  });
  it('an invalid calendar date is refused before attendance reads', async () => {
    await Page({ params: Promise.resolve({ date: '2025-02-30' }), searchParams: Promise.resolve({}) });
    expect(state.rows).not.toHaveBeenCalled();
  });
});
