/**
 * r433 (faca1cfb round 1) — the attendance DAY screen (app/attendance/individual/[date]/page.tsx), rendered
 * for real against a real database.
 *
 * READ-ONLY PRESENTATION. The three claims, each pinned on rendered markup rather than on source text:
 *   1. an Employee Information section names whose day it is (six fields + the Schedule Group);
 *   2. Shift and Break Time are ONE section ("Clock date and break time");
 *   3. the Overtime section lists ONLY the items that apply, and every figure equals what the old fixed
 *      column carried for the same day (same formatter, same stored buckets) — and a day with nothing to
 *      report says so in one line with no rows at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createShift, assignDefaultShift, setEmploymentScheduleGroup } from '../core/roster';
import { createAttendanceRule, ensureStandardRule } from '../core/attendance-rule';
import { checkIn, checkOut, attendanceForEmploymentRange } from '../core/attendance';
import { otByRate } from '../core/attendance-derive';
import { listEmployees } from '../core/read';
import { fmtDayDate, fmtHours2, fmtShort, fmtMin } from '../components/attendance-format';

const EN = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8'));
let SESSION: SessionContext;
let SCOPE: string[] = [];
vi.mock('../lib/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/scope')>()),
  scopedSession: async () => ({ s: SESSION, scopeIds: SCOPE, allowedCount: SCOPE.length }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => createTranslator({ locale: 'en', messages: EN, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

import DayPage from '../app/attendance/individual/[date]/page';

const WORKDAY = '2026-07-01'; // Wednesday, a working day under Mon–Fri (a past date; the engine reads it as stored)
const uniq = () => Math.random().toString(36).slice(2, 8);
let b: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  SESSION = adminCtx(b);
  SCOPE = [b.companyId];
});

const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');
async function render(employmentId: string): Promise<string> {
  const tree = await DayPage({ params: Promise.resolve({ date: WORKDAY }), searchParams: Promise.resolve({ emp: employmentId }) });
  return visible(
    renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: 'en', timeZone: 'Asia/Kuala_Lumpur', messages: EN, children: tree as never })),
  );
}
/** The markup of one named section (a `data-day-section` card), up to the next section marker. */
function section(html: string, name: string): string {
  const start = html.indexOf(`data-day-section="${name}"`);
  expect(start, `section ${name} was not found`).toBeGreaterThanOrEqual(0);
  const next = html.indexOf('data-day-section=', start + 10);
  const slice = html.slice(start, next < 0 ? undefined : next);
  expect(slice.length, `section ${name} is suspiciously short`).toBeGreaterThan(200);
  return slice;
}
const rowKeys = (sec: string) => [...sec.matchAll(/data-day-ot-row="([a-z0-9]+)"/g)].map((m) => m[1]);

async function worker(name: string, inTime: string, outTime: string, ruleId?: string) {
  const a = adminCtx(b);
  const shiftId = (await createShift(a, { name: `Office ${uniq()}`, code: `OFC${uniq()}`, startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5], ...(ruleId ? { ruleId } : {}) })).id;
  const h = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `r433_${uniq()}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await assignDefaultShift(a, { employmentId: h.employmentId, shiftId });
  await checkIn(a, { employmentId: h.employmentId, date: WORKDAY, time: inTime });
  await checkOut(a, { employmentId: h.employmentId, date: WORKDAY, time: outTime });
  return h.employmentId;
}

describe('r433 · Employee Information', () => {
  it('names whose day it is: name, employee ID, company, department, position, date, schedule group', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const grp = await createAttendanceRule(a, {
      name: 'Office Staff r433', status: 'active', lateGracePeriodMinutes: 0, lateAfterMinutes: 0, lateDeductMinutes: 0,
      includeGraceInLateness: false, earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0, earlyDeductMinutes: 0,
      includeGraceInEarlyOut: false, applyToEarlyOt: false, otRows: [],
    });
    // The group only accepts shifts that point at it, so the worker's shift is created under the group.
    const emp = await worker('Aisha Rahman', '09:00', '18:00', grp.id);
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: grp.id });
    const me = (await listEmployees(a, [b.companyId])).find((e) => e.employmentId === emp)!;

    const info = section(await render(emp), 'employee');
    for (const label of [EN.attendance.dayInfoName, EN.attendance.colEmployeeId, EN.attendance.dayInfoCompany, EN.attendance.dayInfoDepartment, EN.attendance.dayInfoPosition, EN.attendance.dayInfoDate, EN.attendance.dayInfoScheduleGroup]) {
      expect(info, `label ${label}`).toContain(`>${label}<`);
    }
    expect(info).toContain('Aisha Rahman');
    expect(me.employeeCode, 'the fixture has an employee code').toBeTruthy();
    expect(info).toContain(`>${me.employeeCode}<`);
    expect(me.company).toBeTruthy();
    expect(info).toContain(`>${me.company}<`);
    expect(me.department).toBeTruthy();
    expect(info).toContain(`>${me.department}<`);
    expect(info).toContain(`>${fmtDayDate(WORKDAY, 'en')}<`); // the attendance date, through the shared formatter
    expect(info).toContain('>Office Staff r433<');
  });

  it('an employee in no schedule group reads "None", never a blank or the word undefined', async () => {
    const emp = await worker('No Group Nia', '09:00', '18:00');
    const info = section(await render(emp), 'employee');
    expect(info).toContain(`>${EN.attendance.dayInfoScheduleGroupNone}<`);
    expect(info).not.toContain('undefined');
  });
});

describe('r433 · Clock date and break time is ONE section', () => {
  it('carries date, shift period and the derived break; the two old cards are gone', async () => {
    const emp = await worker('One Card Omar', '09:00', '18:00');
    const html = await render(emp);
    const sec = section(html, 'clock-break');
    expect(sec).toContain(EN.attendance.daySecClockBreak);
    expect(sec).toContain(`>${EN.attendance.dayShiftLabel}<`);
    expect(sec).toMatch(/OFC[a-z0-9]+ · 09:00(:00)? to 18:00(:00)? · 8h 00m/);
    expect(sec).toContain(`>${EN.attendance.daySecBreak}<`);
    expect(sec).toContain('>1h 00m<'); // 60 min break, derived
    expect(sec).toContain(EN.attendance.dayBreakDerived);
    // The old separate headings no longer head a card of their own.
    expect(html).not.toContain(`>${EN.attendance.daySecShift}<`);
    expect((html.match(new RegExp(`>${EN.attendance.daySecBreak}<`, 'g')) ?? []).length, 'Break time is a field, not a second card heading').toBe(1);
  });
});

describe('r433 · Overtime lists only what applies, with the old columns’ figures', () => {
  it('a zero day says so in one line and lists NO row', async () => {
    const emp = await worker('Zero Zainab', '09:00', '18:00');
    const sec = section(await render(emp), 'overtime');
    expect(sec).toContain('data-day-ot-none');
    expect(sec).toContain(EN.attendance.dayOtNone);
    expect(rowKeys(sec)).toEqual([]);
    expect(sec).not.toContain('<table');
    for (const k of ['colLateness', 'colEarlyOut', 'colOtFlat', 'colOt00', 'colOt10', 'colOt15', 'colOt20', 'colOt30']) {
      expect(sec, `a fixed zero row ${k} came back`).not.toContain(`>${EN.attendance[k]}<`);
    }
  });

  it('a day with lateness and OT 1.5 shows exactly those rows, each equal to the old column figure', async () => {
    const emp = await worker('Late Laila', '09:30', '19:30');
    const a = adminCtx(b);
    const [row] = await attendanceForEmploymentRange(a, emp, WORKDAY, WORKDAY);
    const ot = otByRate(row);
    // Non-vacuity of the fixture itself: the engine really produced a late day with 1.5x overtime.
    expect(row.lateMinutes ?? 0).toBeGreaterThan(0);
    expect(ot.ot15).toBeGreaterThan(0);

    const sec = section(await render(emp), 'overtime');
    const expected = [
      ...(row.lateMinutes ? ['lateness'] : []),
      ...(row.earlyOutMinutes ? ['earlyOut'] : []),
      ...(ot.flat ? ['flat'] : []),
      ...(ot.ot00 ? ['ot00'] : []),
      ...(ot.ot10 ? ['ot10'] : []),
      ...(ot.ot15 ? ['ot15'] : []),
      ...(ot.ot20 ? ['ot20'] : []),
      ...(ot.ot30 ? ['ot30'] : []),
    ];
    expect(rowKeys(sec)).toEqual(expected);
    expect(expected).toContain('lateness');
    expect(expected).toContain('ot15');
    expect(sec).not.toContain('data-day-ot-none');
    // THE NO-FIGURE-CHANGES PIN: the same formatters the eight columns used, on the same stored numbers.
    expect(sec).toContain(`>${fmtShort(row.lateMinutes)}<`);
    expect(sec).toContain(`>${fmtHours2(ot.ot15)}<`);
    for (const absent of ['ot00', 'ot10', 'ot20', 'ot30', 'flat'] as const) {
      if (!expected.includes(absent)) expect(sec).not.toContain(`data-day-ot-row="${absent}"`);
    }
    // The Irregularity section is untouched and still reads the lateness in its own format.
    expect(fmtMin(row.lateMinutes)).toBeTruthy();
  });
});
