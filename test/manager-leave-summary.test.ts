/**
 * Manager Leave Summary on the Personnel profile (item 726ac8c2).
 *
 * The part of this item with a confidentiality consequence is the reporting-hierarchy restriction, and
 * it is asserted here against the DATA (subordinateLeaveSummary), not against the rendered section — a
 * UI-only check would let a manager read another manager's reports' balances by editing the employment
 * id in the address bar, and a test that only asserted "the section is hidden" would pass anyway.
 *
 * The pure half (the calendar deep link + the strings and CSS the highlight depends on) follows the
 * convention of test/approvals-calendar-deeplink.test.ts: there is no component-render harness in this
 * repo, so readFileSync drift guards carry the weight. Renaming the focus param or the highlight class
 * would otherwise degrade the feature into a silent no-op that the grid's "row not found" branch eats.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { leaveBalances, subordinateLeaveSummary } from '../core/read';
import {
  CALENDAR_FOCUS_MS,
  CALENDAR_FOCUS_PARAM,
  buildCalendarFocusHref,
  parseCalendarFocus,
} from '../lib/calendar-focus';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

// ── Pure: the deep link + its drift guards ────────────────────────────────────────────────────────

describe('calendar focus deep link', () => {
  const id = '11111111-2222-3333-4444-555555555555';

  it('builds a team-view href that lands on the Leave Calendar', () => {
    // a00c4f64 — the destination moved from the dashboard (with a '#planned-absences' anchor jump to the
    // card) to the Team Leave Tracker, which IS the calendar and needs no fragment.
    const href = buildCalendarFocusHref(id);
    expect(href).toBe(`/leave/tracker?view=team&${CALENDAR_FOCUS_PARAM}=${id}`);
  });

  it('round-trips through the parser', () => {
    const qs = new URLSearchParams(buildCalendarFocusHref(id).split('?')[1]);
    expect(parseCalendarFocus(qs.get(CALENDAR_FOCUS_PARAM) ?? undefined)).toBe(id);
  });

  it('drops anything that is not a uuid rather than passing it to the client', () => {
    expect(parseCalendarFocus(undefined)).toBeNull();
    expect(parseCalendarFocus('')).toBeNull();
    expect(parseCalendarFocus('../../etc/passwd')).toBeNull();
    expect(parseCalendarFocus('<script>alert(1)</script>')).toBeNull();
    expect(parseCalendarFocus(['not-a-uuid'])).toBeNull();
  });

  it('holds the highlight to the 3 seconds the reporter asked for', () => {
    expect(CALENDAR_FOCUS_MS).toBe(3000);
  });
});

describe('726ac8c2 drift guards', () => {
  it('the profile builds the calendar href from the shared builder, never by hand', () => {
    const page = read('app/personnel/[employmentId]/page.tsx');
    expect(page).toContain('buildCalendarFocusHref');
    expect(page).toContain('subordinateLeaveSummary');
  });

  it('the calendar page validates ?focus= and passes it to the calendar', () => {
    // a00c4f64: the page that reads ?focus= is the Team Leave Tracker now, not the dashboard. Both halves
    // are asserted — the tracker DOES read it, and the dashboard no longer pretends to.
    const page = read('app/leave/tracker/page.tsx');
    expect(page).toContain('parseCalendarFocus');
    expect(page).toContain('focusPersonId={absFocusPersonId}');
    expect(read('app/page.tsx')).not.toContain('parseCalendarFocus');
  });

  it('the grid paints the highlight class and expires it on the shared timeout', () => {
    const grid = read('components/planned-absences-grid.tsx');
    expect(grid).toContain('calendar-focus-attention');
    expect(grid).toContain('CALENDAR_FOCUS_MS');
    // The row may sit past the collapsed cap; the grid must open the roster or the deep link misses.
    expect(grid).toContain('useState(focusIdx >= COLLAPSED_ROWS)');
  });

  it('the highlight class exists and keeps a STATIC base outside every reduce-motion block', () => {
    const css = read('app/globals.css');
    const decl = css.slice(css.indexOf('.calendar-focus-attention'));
    const body = decl.slice(0, decl.indexOf('}'));
    expect(body).toContain('animation: shake');
    // The still highlight promised to reduced-motion users: a base the global reset cannot collapse.
    expect(body).toContain('outline:');
    expect(body).toContain('background-color:');
    // Reduce-motion must NOT carry a rule for this class (the global reset already collapses the shake);
    // adding one would take the static base away too.
    for (const block of css.split('@media (prefers-reduced-motion: reduce)').slice(1)) {
      expect(block.slice(0, block.indexOf('\n}\n'))).not.toContain('calendar-focus-attention');
    }
  });

  it('every locale carries the Leave Summary strings', () => {
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as {
        people: { detail: { leaveSummary?: Record<string, string> } };
      };
      const summary = m.people.detail.leaveSummary;
      expect(summary, loc).toBeDefined();
      for (const key of ['title', 'viewCalendar', 'colType', 'colBalance', 'colPending', 'colUpcoming', 'days']) {
        expect(summary?.[key], `${loc}.${key}`).toBeTruthy();
      }
      expect(summary?.days, loc).toContain('{days}');
    }
  });
});

// ── Data: the hierarchy restriction + the figures ─────────────────────────────────────────────────

let b: Base;
const A = () => adminCtx(b);
const TODAY = '2026-06-01';

async function hire(name: string) {
  return hireEmployee(A(), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

async function adminLine(subordinate: string, manager: string) {
  return setReportingLine(A(), {
    subordinateEmploymentId: subordinate,
    managerEmploymentId: manager,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
}

async function userCtx(personId: string, role: 'employee' | 'manager'): Promise<SessionContext> {
  const uid = await createAppUser(b.tenantId, personId, role);
  return { tenantId: b.tenantId, userId: uid, roles: [role], personId };
}

const leaveRow = (
  employmentId: string,
  status: 'pending' | 'approved' | 'rejected' | 'cancelled',
  startDate: string,
  endDate: string,
  days: string,
) => ({
  tenantId: b.tenantId,
  employmentId,
  leaveTypeId: b.annualLeaveTypeId,
  startDate,
  endDate,
  days,
  status,
});

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('subordinateLeaveSummary — who may read it', () => {
  it('a direct manager reads their report; an unrelated manager gets null even with the employment id', async () => {
    const report = await hire('Report');
    const boss = await hire('Boss');
    const stranger = await hire('OtherBoss');
    const strangerReport = await hire('OtherReport');
    await adminLine(report.employmentId, boss.employmentId);
    await adminLine(strangerReport.employmentId, stranger.employmentId);

    const bossCtx = await userCtx(boss.personId, 'manager');
    expect(await subordinateLeaveSummary(bossCtx, report.employmentId, TODAY)).not.toBeNull();

    // The URL-editing case: a manager who holds the `manager` role, but not over THIS employment.
    const strangerCtx = await userCtx(stranger.personId, 'manager');
    expect(await subordinateLeaveSummary(strangerCtx, report.employmentId, TODAY)).toBeNull();
  });

  it('reaches indirect reports — the recursive administrative graph, matching RLS', async () => {
    const top = await hire('Top');
    const mid = await hire('Mid');
    const leaf = await hire('Leaf');
    await adminLine(mid.employmentId, top.employmentId);
    await adminLine(leaf.employmentId, mid.employmentId);

    const topCtx = await userCtx(top.personId, 'manager');
    expect(await subordinateLeaveSummary(topCtx, leaf.employmentId, TODAY)).not.toBeNull();
  });

  it('is a manager affordance: the employee themselves and a plain HR admin both get null', async () => {
    const report = await hire('Report');
    const boss = await hire('Boss');
    await adminLine(report.employmentId, boss.employmentId);

    const selfCtx = await userCtx(report.personId, 'employee');
    expect(await subordinateLeaveSummary(selfCtx, report.employmentId, TODAY)).toBeNull();
    // The admin has the full balance card on /admin/personnel; this thinner copy is not for them.
    expect(await subordinateLeaveSummary(A(), report.employmentId, TODAY)).toBeNull();
  });
});

describe('subordinateLeaveSummary — the figures', () => {
  it('balance is the SAME number leaveBalances gives the employee on their own Leave page', async () => {
    const report = await hire('Report');
    const boss = await hire('Boss');
    await adminLine(report.employmentId, boss.employmentId);
    await owner.db.insert(schema.leaveLedger).values([
      { tenantId: b.tenantId, employmentId: report.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '14.00', effectiveOn: '2026-01-01' },
      { tenantId: b.tenantId, employmentId: report.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'debit', days: '-1.50', effectiveOn: '2026-02-01' },
    ]);

    const bossCtx = await userCtx(boss.personId, 'manager');
    const summary = await subordinateLeaveSummary(bossCtx, report.employmentId, TODAY);
    const selfCtx = await userCtx(report.personId, 'employee');
    const own = await leaveBalances(selfCtx, report.employmentId);

    const annual = summary?.find((r) => r.leaveTypeId === b.annualLeaveTypeId);
    const ownAnnual = own.find((r) => r.leaveTypeId === b.annualLeaveTypeId);
    expect(annual?.balance).toBe(12.5);
    expect(annual?.balance).toBe(ownAnnual?.balance);
  });

  it('pending is a COUNT OF REQUESTS, not a sum of days', async () => {
    const report = await hire('Report');
    const boss = await hire('Boss');
    await adminLine(report.employmentId, boss.employmentId);
    await owner.db.insert(schema.leaveRequest).values([
      leaveRow(report.employmentId, 'pending', '2026-07-01', '2026-07-03', '3.00'),
      leaveRow(report.employmentId, 'pending', '2026-08-10', '2026-08-10', '1.00'),
      leaveRow(report.employmentId, 'approved', '2026-09-01', '2026-09-01', '1.00'),
    ]);

    const bossCtx = await userCtx(boss.personId, 'manager');
    const summary = await subordinateLeaveSummary(bossCtx, report.employmentId, TODAY);
    // Two requests awaiting a decision — 4 days between them, which is NOT what this column says.
    expect(summary?.find((r) => r.leaveTypeId === b.annualLeaveTypeId)?.pendingCount).toBe(2);
  });

  it('upcoming is the earliest approved leave that has not finished; past and pending leave never show', async () => {
    const report = await hire('Report');
    const boss = await hire('Boss');
    await adminLine(report.employmentId, boss.employmentId);
    await owner.db.insert(schema.leaveRequest).values([
      leaveRow(report.employmentId, 'approved', '2026-01-05', '2026-01-06', '2.00'), // finished
      leaveRow(report.employmentId, 'approved', '2026-08-12', '2026-08-14', '3.00'), // the answer
      leaveRow(report.employmentId, 'approved', '2026-09-01', '2026-09-02', '2.00'), // later
      leaveRow(report.employmentId, 'pending', '2026-06-15', '2026-06-15', '1.00'), // not approved
    ]);

    const bossCtx = await userCtx(boss.personId, 'manager');
    const summary = await subordinateLeaveSummary(bossCtx, report.employmentId, TODAY);
    const annual = summary?.find((r) => r.leaveTypeId === b.annualLeaveTypeId);
    expect(annual?.upcomingFrom).toBe('2026-08-12');
    expect(annual?.upcomingTo).toBe('2026-08-14');
  });

  it('a partially-approved span advertises only the dates that were actually approved', async () => {
    const report = await hire('Report');
    const boss = await hire('Boss');
    await adminLine(report.employmentId, boss.employmentId);
    const [lr] = await owner.db
      .insert(schema.leaveRequest)
      .values(leaveRow(report.employmentId, 'approved', '2026-08-12', '2026-08-14', '3.00'))
      .returning({ id: schema.leaveRequest.id });
    await owner.db.insert(schema.leaveRequestDate).values([
      { tenantId: b.tenantId, leaveRequestId: lr.id, subjectEmploymentId: report.employmentId, leaveDate: '2026-08-12', days: '1.00', status: 'rejected' as const },
      { tenantId: b.tenantId, leaveRequestId: lr.id, subjectEmploymentId: report.employmentId, leaveDate: '2026-08-13', days: '1.00', status: 'approved' as const },
      { tenantId: b.tenantId, leaveRequestId: lr.id, subjectEmploymentId: report.employmentId, leaveDate: '2026-08-14', days: '1.00', status: 'approved' as const },
    ]);

    const bossCtx = await userCtx(boss.personId, 'manager');
    const summary = await subordinateLeaveSummary(bossCtx, report.employmentId, TODAY);
    const annual = summary?.find((r) => r.leaveTypeId === b.annualLeaveTypeId);
    expect(annual?.upcomingFrom).toBe('2026-08-13');
    expect(annual?.upcomingTo).toBe('2026-08-14');
  });
});
