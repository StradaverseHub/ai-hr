/**
 * Leave Calendar Week/Month views (item ee55f5fe).
 *
 * 8a–8d: the pure range/preference/re-anchor resolvers (lib/leave-calendar-range.ts), no DB.
 * 8b also pins the month-picker FORMAT CONTRACT: the page anchor is uniformly YYYY-MM-DD while
 *     <input type="month"> speaks YYYY-MM — the slice/append mapping is a hard bug if missed
 *     (blank picker + a silently rejected anchor + a vanished "Today" escape hatch).
 * 8e: i18n parity for the new keys across all six locales, the REMOVAL of the old
 *     components.plannedAbsences.viewAll, and — the positive half of the guard — that
 *     dashboard.viewAll is still present (it drives two unrelated dashboard cards).
 * 8f: source assertions on components/planned-absences.tsx (multi-namespace file, so the i18n
 *     coverage test's check C skips it outright — a leftover t('viewAll') would render a raw key
 *     with a green suite; the ArrowUpRight half keeps lint's no-unused-vars clean).
 * 8g: DB — the workingDatesForSpans batching (core/leave.ts) must produce candidateCancelDates
 *     IDENTICAL to the old per-leave workingDatesForSpan path, including for a leave straddling
 *     the visible window edge (the union range is the leaves' own spans, never the window).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { decideLeave, requestLeave, workingDatesForSpan } from '../core/leave';
import { plannedAbsences } from '../core/read';
import type { SessionContext, Tx } from '../db/client';
import {
  mondayOfIso,
  parseCalendarView,
  reanchorForView,
  resolveCalendarRange,
  resolveViewPreference,
  shiftMonthIso,
} from '../lib/leave-calendar-range';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const loadLocale = (loc: string) =>
  JSON.parse(fs.readFileSync(path.join(root, 'messages', `${loc}.json`), 'utf8'));

// Copied from app/page.tsx — the anchor validation the month picker's writes must satisfy.
const PAGE_ANCHOR_RE = /^\d{4}-\d{2}-\d{2}$/;

describe('8a. resolveCalendarRange / parseCalendarView (pure)', () => {
  const todayIso = '2026-07-21';

  it('week: a Sunday anchor Monday-aligns BACK and spans 7 days', () => {
    expect(mondayOfIso('2026-08-16')).toBe('2026-08-10'); // Sun → its own week's Monday
    expect(resolveCalendarRange({ view: 'week', anchorIso: '2026-08-16', todayIso })).toEqual({
      from: '2026-08-10',
      to: '2026-08-16',
      days: 7,
    });
    // A Monday anchor stays put.
    expect(resolveCalendarRange({ view: 'week', anchorIso: '2026-08-10', todayIso }).from).toBe('2026-08-10');
  });

  it('month: a mid-month anchor resolves 1st..last with the right day count', () => {
    expect(resolveCalendarRange({ view: 'month', anchorIso: '2026-07-15', todayIso })).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
      days: 31,
    });
    expect(resolveCalendarRange({ view: 'month', anchorIso: '2026-09-10', todayIso }).days).toBe(30);
    expect(resolveCalendarRange({ view: 'month', anchorIso: '2027-02-14', todayIso })).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
      days: 28,
    });
    expect(resolveCalendarRange({ view: 'month', anchorIso: '2028-02-14', todayIso }).days).toBe(29); // leap
  });

  it('no anchor falls back to today', () => {
    expect(resolveCalendarRange({ view: 'month', anchorIso: null, todayIso }).from).toBe('2026-07-01');
    expect(resolveCalendarRange({ view: 'week', anchorIso: undefined, todayIso }).from).toBe(
      mondayOfIso(todayIso),
    );
  });

  it("parseCalendarView: 'month' only on the exact string", () => {
    expect(parseCalendarView(undefined)).toBe('week');
    expect(parseCalendarView('')).toBe('week');
    expect(parseCalendarView('garbage')).toBe('week');
    expect(parseCalendarView('Month')).toBe('week');
    expect(parseCalendarView('month')).toBe('month');
  });
});

describe('8b. month stepping + the picker format contract', () => {
  it('shiftMonthIso never drifts on short months', () => {
    expect(shiftMonthIso('2026-01-31', 1)).toBe('2026-02-01'); // not 31 Feb / 2 Mar
    expect(shiftMonthIso('2026-03-01', -1)).toBe('2026-02-01');
    expect(shiftMonthIso('2026-12-15', 1)).toBe('2027-01-01');
  });

  it('picker round-trip: renders YYYY-MM, writes back YYYY-MM-DD that the page regex accepts', () => {
    const { from } = resolveCalendarRange({ view: 'month', anchorIso: '2026-07-15', todayIso: '2026-07-21' });
    const pickerValue = from.slice(0, 7); // what <input type="month"> receives
    expect(pickerValue).toMatch(/^\d{4}-\d{2}$/);
    const writtenBack = `${pickerValue}-01`; // what onChange pushes into ?abs=
    expect(writtenBack).toMatch(PAGE_ANCHOR_RE);
    // And the resolved month window itself is expressed in full page-regex-valid anchors.
    expect(from).toMatch(PAGE_ANCHOR_RE);
  });

  it('timeline-nav implements exactly that mapping (source drift guard)', () => {
    const src = read('components/timeline-nav.tsx');
    expect(src).toContain('from.slice(0, 7)');
    expect(src).toContain('go(`${v}-01`)');
    expect(src).toContain("type=\"month\"");
  });
});

describe('8c. resolveViewPreference precedence', () => {
  it('param beats cookie in BOTH directions (a shared link wins over the viewer cookie)', () => {
    expect(resolveViewPreference({ param: 'month', cookie: 'week' })).toBe('month');
    expect(resolveViewPreference({ param: 'week', cookie: 'month' })).toBe('week');
  });
  it('cookie decides when the param is absent', () => {
    expect(resolveViewPreference({ param: undefined, cookie: 'month' })).toBe('month');
    expect(resolveViewPreference({ param: undefined, cookie: 'week' })).toBe('week');
  });
  it('garbage cookie / both absent fall back to week', () => {
    expect(resolveViewPreference({ param: undefined, cookie: 'sideways' })).toBe('week');
    expect(resolveViewPreference({ param: undefined, cookie: undefined })).toBe('week');
  });
  it('backward compatibility: a bookmarked /?abs=…&view=team with no cal param resolves to week', () => {
    // sp.cal is undefined on such a URL and no cookie exists on a fresh browser — today's behaviour.
    expect(resolveViewPreference({ param: undefined, cookie: undefined })).toBe('week');
  });
});

describe('8d. reanchorForView (the month→week→month drift fix)', () => {
  const todayIso = '2026-07-21';

  it('a window containing today drops the anchor entirely (null)', () => {
    expect(
      reanchorForView({ fromView: 'month', toView: 'week', from: '2026-07-01', to: '2026-07-31', todayIso }),
    ).toBeNull();
  });

  it('a window NOT containing today re-anchors to its midpoint', () => {
    expect(
      reanchorForView({ fromView: 'month', toView: 'week', from: '2026-09-01', to: '2026-09-30', todayIso }),
    ).toBe('2026-09-15');
  });

  it('month → week → month lands back in the SAME month it started in', () => {
    // Start: Month View of September (entered from a mid-month anchor).
    const month = resolveCalendarRange({ view: 'month', anchorIso: '2026-09-18', todayIso });
    // Switch to week: re-anchor by the month window, then resolve the week.
    const weekAnchor = reanchorForView({ fromView: 'month', toView: 'week', ...month, todayIso })!;
    const week = resolveCalendarRange({ view: 'week', anchorIso: weekAnchor, todayIso });
    // Switch back to month: re-anchor by the WEEK window.
    const monthAnchor = reanchorForView({ fromView: 'week', toView: 'month', ...week, todayIso })!;
    const roundTrip = resolveCalendarRange({ view: 'month', anchorIso: monthAnchor, todayIso });
    expect(roundTrip.from).toBe('2026-09-01'); // same September, no drift into August
  });
});

describe('8e. i18n parity across all six locales', () => {
  it('carries the new keys, DROPS plannedAbsences.viewAll, and KEEPS dashboard.viewAll', () => {
    for (const loc of LOCALES) {
      const d = loadLocale(loc);
      const pa = d.components.plannedAbsences;
      for (const key of ['viewWeek', 'viewMonth', 'rangeSwitchLabel']) {
        expect(pa[key], `${loc} components.plannedAbsences.${key}`).toBeTruthy();
      }
      expect(d.components.timelineNav.unitMonth, `${loc} timelineNav.unitMonth`).toBeTruthy();
      // The old top-right "View all" link is gone — its key must not linger in any locale…
      expect(pa.viewAll, `${loc} components.plannedAbsences.viewAll must be REMOVED`).toBeUndefined();
      // …while the UNRELATED dashboard.viewAll (Recently Joined / Recent Activity cards) must survive.
      expect(d.dashboard.viewAll, `${loc} dashboard.viewAll must remain`).toBeTruthy();
    }
  });
});

describe('8f. source guards on components/planned-absences.tsx', () => {
  it("no longer references 'viewAll' and no longer imports ArrowUpRight", () => {
    const src = read('components/planned-absences.tsx');
    expect(src.includes('viewAll')).toBe(false);
    expect(src.includes('ArrowUpRight')).toBe(false);
  });
});

// ───────────────────────────── 8g. DB — memoization correctness ─────────────────────────────

let b: Base;
let subject: { personId: string; employmentId: string };
let edge: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let edgeCtx: SessionContext;

// Month window: August 2026. `today` (tenant-local, passed explicitly) is late July so the
// straddling leave's JULY working dates survive the strictly-after-today cut.
const MONTH_WINDOW = { from: '2026-08-01', to: '2026-08-31' };
const FAKE_TODAY = '2026-07-25';

async function grantAnnual(employmentId: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days: '30.00',
    effectiveOn: '2026-01-01',
  });
}

async function approvedLeave(ctx: SessionContext, employmentId: string, startDate: string, endDate: string) {
  const res = await requestLeave(ctx, {
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate,
    endDate,
  });
  await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
  return res.leaveRequestId;
}

/** The OLD per-leave path, verbatim: workingDatesForSpan over the leave's own span, strictly after today. */
async function oldPathCandidates(employmentId: string, start: string, end: string) {
  const dates = await workingDatesForSpan(owner.db as unknown as Tx, employmentId, start, end);
  return dates.filter((d) => d > FAKE_TODAY);
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const mk = async (name: string) =>
    hireEmployee(adminCtx(b), {
      person: { fullName: name, primaryEmail: `wm_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
  subject = await mk('Batch Subject');
  edge = await mk('Edge Straddler');
  subjectCtx = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, subject.personId, 'employee'),
    personId: subject.personId,
    roles: ['employee'],
  };
  edgeCtx = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, edge.personId, 'employee'),
    personId: edge.personId,
    roles: ['employee'],
  };
  await grantAnnual(subject.employmentId);
  await grantAnnual(edge.employmentId);
});
afterAll(async () => {
  await closeAll();
});

describe('8g. workingDatesForSpans batching matches the old per-leave path', () => {
  it('three separate leaves in one month: every candidateCancelDates is identical to the per-leave path', async () => {
    const l1 = await approvedLeave(subjectCtx, subject.employmentId, '2026-08-03', '2026-08-04');
    const l2 = await approvedLeave(subjectCtx, subject.employmentId, '2026-08-12', '2026-08-13');
    const l3 = await approvedLeave(subjectCtx, subject.employmentId, '2026-08-24', '2026-08-25');

    const rows = await plannedAbsences(adminCtx(b), [b.companyId], MONTH_WINDOW, FAKE_TODAY, {
      personIds: [subject.personId],
    });
    const mine = rows.find((r) => r.id === subject.personId)!;
    for (const [id, start, end] of [
      [l1, '2026-08-03', '2026-08-04'],
      [l2, '2026-08-12', '2026-08-13'],
      [l3, '2026-08-24', '2026-08-25'],
    ] as const) {
      const pill = mine.leaves.find((l) => l.id === id)!;
      const expected = await oldPathCandidates(subject.employmentId, start, end);
      expect(expected.length).toBeGreaterThan(0);
      expect(pill.candidateCancelDates).toEqual(expected);
    }
  });

  it('a leave straddling the window edge is NOT clipped by the union-range optimisation', async () => {
    // Starts before the month window opens and a second one ends after it closes.
    const before = await approvedLeave(edgeCtx, edge.employmentId, '2026-07-29', '2026-08-04');
    const after = await approvedLeave(edgeCtx, edge.employmentId, '2026-08-28', '2026-09-02');

    const rows = await plannedAbsences(adminCtx(b), [b.companyId], MONTH_WINDOW, FAKE_TODAY, {
      personIds: [edge.personId],
    });
    const mine = rows.find((r) => r.id === edge.personId)!;

    const pillBefore = mine.leaves.find((l) => l.id === before)!;
    const expectedBefore = await oldPathCandidates(edge.employmentId, '2026-07-29', '2026-08-04');
    expect(pillBefore.candidateCancelDates).toEqual(expectedBefore);
    // The July working dates BEFORE the visible window are present — the span was not clipped to `from`.
    expect(pillBefore.candidateCancelDates).toContain('2026-07-29');

    const pillAfter = mine.leaves.find((l) => l.id === after)!;
    const expectedAfter = await oldPathCandidates(edge.employmentId, '2026-08-28', '2026-09-02');
    expect(pillAfter.candidateCancelDates).toEqual(expectedAfter);
    // And the September dates AFTER the window are present — not clipped to `to`.
    expect(pillAfter.candidateCancelDates).toContain('2026-09-02');
  });
});
