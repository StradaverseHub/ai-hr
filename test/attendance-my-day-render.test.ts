import { Children, cloneElement, createElement, isValidElement } from 'react';
import { AttendanceRequestHistory } from '../components/attendance-request-history';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
const state = vi.hoisted(() => ({ locale: 'en', own: vi.fn(), selected:vi.fn(), rows: vi.fn(), punches: vi.fn(), requests: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => state.locale,
  getTranslations: async (namespace: string = 'attendance') => createTranslator({ locale: state.locale, namespace, messages: JSON.parse(readFileSync(new URL(`../messages/${state.locale}.json`, import.meta.url), 'utf8')) }),
}));
vi.mock('../lib/scope', () => ({ scopedSession: async () => ({ s: { personId: 'manager',userId:'user' } }) }));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('notFound');}}));
vi.mock('../lib/authz', () => ({ requireModule: async () => undefined }));
vi.mock('../core/read', () => ({ myEmployment: state.own,myOwnEmploymentSubjects:state.selected }));
vi.mock('../app/(app)/attendance/my-records/[date]/actions', () => ({ requestOwnAttendanceDayAction: () => undefined }));
vi.mock('../components/attendance-figure-cells', () => ({ AttendanceFigureCells: () => createElement('td', { colSpan: 8 }, 'figures') }));
vi.mock('../packs/attendance/service', async () => ({
  attendanceForEmploymentRange: state.rows,
  attendancePunchesForRange: state.punches,
  myAttendanceCorrections: state.requests,
  ...(await import('../core/attendance-derive')),
  ...(await import('../core/attendance-explain')),
}));
import Page from '../app/(app)/attendance/my-records/[date]/page';
beforeEach(() => {
  vi.clearAllMocks(); state.locale = 'en';
  state.selected.mockResolvedValue([{employmentId:'8cfa58c2-dd92-4eb6-8f8c-ab19406115fd',personName:'Own second',company:'Fictional second employer',employeeCode:'SECOND'}]);
  state.own.mockResolvedValue({ employmentId: 'manager-own', name: 'Own day' });
  state.rows.mockResolvedValue([{ date: '2025-06-04', attendanceId: 'own-row', status: 'present', context: null, dayType: 'workday', shiftCode: 'AM01', shiftStart: '09:00', shiftEnd: '18:00', scheduledMinutes: 480, workedMinutes: 480, checkInAt: '09:00', checkOutAt: '18:00', lateMinutes: 0, earlyOutMinutes: 0, otMinutes: 0, calcTrace: null }]);
  state.punches.mockResolvedValue(new Map()); state.requests.mockResolvedValue([]);
});
const render = async (extra = {}) => {
  const page = await Page({ params: Promise.resolve({ date: '2025-06-04' }), searchParams: Promise.resolve({ from: '2025-06-01', to: '2025-06-30', ...extra }) });
  // Next resolves this async server child; legacy static markup cannot await it itself.
  const children = await Promise.all(Children.toArray(page.props.children).map(child =>
    isValidElement(child) && child.type === AttendanceRequestHistory
      ? AttendanceRequestHistory(child.props as Parameters<typeof AttendanceRequestHistory>[0])
      : child));
  const resolved = cloneElement(page, undefined, ...children);
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: state.locale, messages: JSON.parse(readFileSync(new URL(`../messages/${state.locale}.json`, import.meta.url), 'utf8')), children: resolved }));
};
describe('employee day render', () => {
  it.each(['en','ms','zh','ta','th','vi'])('retains translated workflow refusal in %s after the global toast query consumer',async locale=>{
    state.locale=locale;const html=await render({correctionError:'myDayWorkflowUnavailable'});
    const catalogue=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8')).attendance;
    expect(html).toContain(catalogue.myDayWorkflowUnavailable);
    expect(html).not.toContain('correctionError=myDayWorkflowUnavailable');
    expect(html).not.toContain(catalogue.myDaySubmitted);
  });
  it('a manager sees their own day even when the URL asks for their report', async () => {
    const html = await render({ emp: 'report-employment' });
    expect(state.rows).toHaveBeenCalledWith(expect.anything(), 'manager-own', '2025-06-04', '2025-06-04');
    expect(state.punches).toHaveBeenCalledWith(expect.anything(), 'manager-own', '2025-06-04', '2025-06-04');
    expect(state.requests).toHaveBeenCalledWith(expect.anything(), 'manager-own', { date: '2025-06-04', limit: 100 });
    expect(html).toContain('Own day');
    expect(html).not.toContain('report-employment');
    const back=new URL(/href="([^"]*\/attendance\/my-roster[^"]*)"/.exec(html)![1].replaceAll('&amp;','&'),'https://local.invalid');
    expect(Object.fromEntries(back.searchParams)).toMatchObject({tab:'calendar',view:'month',month:'2025-06',selected:'2025-06-04',page:'0',size:'25'});
  });
  it('retains the selected own subject in reads, Home return and correction form',async()=>{
    const html=await render({employmentId:'8cfa58c2-dd92-4eb6-8f8c-ab19406115fd',home:'1'});
    expect(state.rows).toHaveBeenCalledWith(expect.anything(),'8cfa58c2-dd92-4eb6-8f8c-ab19406115fd','2025-06-04','2025-06-04');expect(state.own).not.toHaveBeenCalled();
    expect(html).toContain('Fictional second employer');expect(html).toContain('SECOND');
    expect(html).toContain('/?employmentId=8cfa58c2-dd92-4eb6-8f8c-ab19406115fd');expect(html).toContain('name="employmentId" value="8cfa58c2-dd92-4eb6-8f8c-ab19406115fd"');
  });
  it.each(['', 'bfd90e63-c78c-4a10-8c51-56e878f42722', ['8cfa58c2-dd92-4eb6-8f8c-ab19406115fd']])('unavailable explicit selector is not a first-subject fallback: %s',async employmentId=>{
    await expect(render({employmentId})).rejects.toThrow('notFound');expect(state.rows).not.toHaveBeenCalled();expect(state.own).not.toHaveBeenCalled();
  });
  it('returns to the original weekly window and retains it through a correction form', async () => {
    const html = await render({ calendar: '1', calendarView: 'week', calendarMonth: '2025-06', calendarDate: '2025-06-02' });
    const back=new URL(/href="([^"]*\/attendance\/my-roster[^"]*)"/.exec(html)![1].replaceAll('&amp;','&'),'https://local.invalid');
    expect(Object.fromEntries(back.searchParams)).toMatchObject({tab:'calendar',view:'week',date:'2025-06-02',selected:'2025-06-04',page:'0',size:'25'});
    expect(html).toContain('name="calendarView" value="week"');
    expect(html).toContain('name="calendarDate" value="2025-06-02"');
  });
  it.each(['en', 'ms', 'zh', 'ta', 'th', 'vi'])('renders pending state and all five sections in %s', async (locale) => {
    state.locale = locale; state.requests.mockResolvedValue([{ id: 'pending', status: 'pending', createdAt: new Date('2025-06-04T01:00:00Z'), proposedCheckIn: '09:00', proposedCheckOut: '18:00', originalClockSnapshot: null, reason: 'Fixture correction', rejectReason: null, decidedAt: null }]);
    const html = await render();
    expect(html).toContain('<fieldset disabled=""');
    expect(html).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
    expect(html).toContain('AM01');
    expect(html).not.toContain('Fixture correction'); // Request history belongs to Application History.
    expect(html).toContain('name="checkIn" value="09:00"');
    expect(html).toContain('name="checkOut" value="18:00"');
    const catalogue = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')).attendance;
    for (const key of ['daySecShift', 'daySecBreak', 'daySecClock', 'daySecOt', 'daySecIrregular', 'myDayPending']) expect(html).toContain(catalogue[key]);
  });
  it('an invalid calendar date is refused before attendance reads', async () => {
    await Page({ params: Promise.resolve({ date: '2025-02-30' }), searchParams: Promise.resolve({}) });
    expect(state.rows).not.toHaveBeenCalled();
  });
});
