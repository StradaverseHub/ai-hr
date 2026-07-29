/**
 * Leave Calendar performance rework (item eae550e9).
 *
 * plannedAbsences gains an optional PERSON-id scope so the dashboard loads only the viewer + direct
 * reports instead of every active employee in the company. These tests pin the four load-bearing
 * behaviours of that change:
 *  (a) the scope filters rows, and OMITTING it reproduces today's full-scope result exactly;
 *  (b) an EMPTY personIds array matches NOTHING — it must never degrade to the company-wide read
 *      (the house `xs && xs.length` idiom two lines away would; this guards the deliberate departure);
 *  (c) a person holding TWO concurrent employments keeps BOTH employments' leaves on the ONE merged
 *      row when scoped by that person's id (the regression the panel identified);
 *  (d) a fixed query round-trip budget, so a later change cannot silently reintroduce the per-leave
 *      N+1 (ee55f5fe step 2) or a second plannedAbsences call.
 * Plus: awayTodayCount (the dedicated "Team Away Today" read that replaced the second full
 * plannedAbsences projection) must agree bit-for-bit with teamAwayToday over a company-scoped,
 * today-covering plannedAbsences read — including when the strip itself shows a FUTURE week.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { decideLeave, requestLeave } from '../core/leave';
import { awayTodayCount, plannedAbsences } from '../core/read';
import { teamAwayToday } from '../lib/dashboard-cards';
import { client, type SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let manager: { personId: string; employmentId: string };
let reportA: { personId: string; employmentId: string };
let reportB: { personId: string; employmentId: string };
let outsider: { personId: string; employmentId: string };
let mgrCtx: SessionContext;

// 10–16 Aug 2026 is a Mon–Sun week (10/11/12 Aug are Mon/Tue/Wed); all dates are in the future
// relative to the real wall clock, so requestLeave's backdating gates pass.
const WINDOW = { from: '2026-08-10', to: '2026-08-16' };
const FAKE_TODAY = '2026-08-11';

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `pas_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function grantAnnual(employmentId: string, days = '20.00') {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

/** Submit + approve a full-day ANNUAL leave for an employment (as the given subject ctx). */
async function approvedLeave(
  subjectCtx: SessionContext,
  employmentId: string,
  startDate: string,
  endDate: string,
) {
  const res = await requestLeave(subjectCtx, {
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate,
    endDate,
  });
  await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
  return res.leaveRequestId;
}

async function subjectCtxFor(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { tenantId: b.tenantId, userId, personId, roles: ['employee'] };
}

/** Count real query round-trips on the app pool (excludes BEGIN/COMMIT/SAVEPOINT bookkeeping). */
async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const sqlClient = client as unknown as { options: { debug?: unknown } };
  let n = 0;
  sqlClient.options.debug = (_id: number, str: string) => {
    const s = str.trim().toLowerCase();
    if (
      s.startsWith('begin') ||
      s.startsWith('commit') ||
      s.startsWith('rollback') ||
      s.startsWith('savepoint') ||
      s.startsWith('release')
    ) {
      return;
    }
    n += 1;
  };
  try {
    const result = await fn();
    return { result, queries: n };
  } finally {
    sqlClient.options.debug = undefined;
  }
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // r79 0322 — single- vs multi-step approval is now decided by the company's resolved chain, not by
  // company.leave_multi_approval (which is gone). These cases are whole-request single-approver flows —
  // the shape the old opted-out default produced — so the company is put on an explicit ONE-step chain.
  // Without it the built-in direct_manager → hr_admin fallback applies and an approval stops at step 1.
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  manager = await hire('Manager Person');
  reportA = await hire('Report Alpha');
  reportB = await hire('Report Beta');
  outsider = await hire('Outsider Person');
  const uM = await createAppUser(b.tenantId, manager.personId, 'manager');
  mgrCtx = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
  for (const r of [reportA, reportB]) {
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: r.employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
  }
  await Promise.all([
    grantAnnual(manager.employmentId),
    grantAnnual(reportA.employmentId),
    grantAnnual(reportB.employmentId),
    grantAnnual(outsider.employmentId),
  ]);
});
afterAll(async () => {
  await closeAll();
});

describe('plannedAbsences personIds scope (eae550e9 step 1)', () => {
  it('(a) personIds returns only those persons; omitting the option reproduces the full-scope result exactly', async () => {
    const ctxA = await subjectCtxFor(reportA.personId);
    const ctxO = await subjectCtxFor(outsider.personId);
    const leaveA = await approvedLeave(ctxA, reportA.employmentId, '2026-08-10', '2026-08-12');
    const leaveO = await approvedLeave(ctxO, outsider.employmentId, '2026-08-11', '2026-08-11');

    const teamIds = [manager.personId, reportA.personId, reportB.personId];
    const full = await plannedAbsences(adminCtx(b), [b.companyId], WINDOW, FAKE_TODAY);
    const scoped = await plannedAbsences(adminCtx(b), [b.companyId], WINDOW, FAKE_TODAY, {
      personIds: teamIds,
    });

    // Full scope (option omitted) = today's behaviour: every active employee, leave-free rows included.
    expect(new Set(full.map((r) => r.id))).toEqual(
      new Set([manager.personId, reportA.personId, reportB.personId, outsider.personId]),
    );
    expect(full.find((r) => r.id === outsider.personId)!.leaves.map((l) => l.id)).toEqual([leaveO]);

    // Scoped: exactly the requested persons — including the leave-free reportB row — nobody else.
    expect(new Set(scoped.map((r) => r.id))).toEqual(new Set(teamIds));
    expect(scoped.find((r) => r.id === reportA.personId)!.leaves.map((l) => l.id)).toEqual([leaveA]);

    // Row-for-row parity: a scoped row is byte-identical to the same person's row in the full read
    // (same projection, same candidateCancelDates resolution) — the scope only FILTERS.
    for (const row of scoped) {
      expect(row).toEqual(full.find((r) => r.id === row.id));
    }
  });

  it('(b) personIds: [] returns ZERO rows — never the whole company', async () => {
    const ctxA = await subjectCtxFor(reportA.personId);
    await approvedLeave(ctxA, reportA.employmentId, '2026-08-10', '2026-08-12');

    const rows = await plannedAbsences(adminCtx(b), [b.companyId], WINDOW, FAKE_TODAY, {
      personIds: [],
    });
    expect(rows).toEqual([]);
  });

  it('(c) concurrent employments: both employments’ leaves land on the ONE merged person row', async () => {
    const subjectCtx = await subjectCtxFor(reportA.personId);
    const leave1 = await approvedLeave(subjectCtx, reportA.employmentId, '2026-08-10', '2026-08-11');

    // Second concurrent employment for the SAME person, with its own leave in the window.
    const emp2 = await hireEmployee(adminCtx(b), {
      person: { id: reportA.personId },
      companyId: b.companyId,
      departmentId: b.deptB,
      employmentType: 'full_time',
      hiredOn: '2024-06-01',
    });
    await grantAnnual(emp2.employmentId);
    const leave2 = await approvedLeave(subjectCtx, emp2.employmentId, '2026-08-13', '2026-08-14');

    const rows = await plannedAbsences(adminCtx(b), [b.companyId], WINDOW, FAKE_TODAY, {
      personIds: [reportA.personId],
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(reportA.personId);
    expect(new Set(row.employmentIds)).toEqual(new Set([reportA.employmentId, emp2.employmentId]));
    expect(new Set(row.leaves.map((l) => l.id))).toEqual(new Set([leave1, leave2]));
    // Each leave keeps its OWN employment id (no smear across concurrent jobs — ADR-0065).
    expect(row.leaves.find((l) => l.id === leave1)!.employmentId).toBe(reportA.employmentId);
    expect(row.leaves.find((l) => l.id === leave2)!.employmentId).toBe(emp2.employmentId);
  });

  it('(d) query budget: round-trips are FIXED per distinct employment and independent of leave count', async () => {
    const ctxM = await subjectCtxFor(manager.personId);
    const ctxA = await subjectCtxFor(reportA.personId);
    const ctxB = await subjectCtxFor(reportB.personId);
    await approvedLeave(ctxM, manager.employmentId, '2026-08-10', '2026-08-10');
    await approvedLeave(ctxA, reportA.employmentId, '2026-08-11', '2026-08-12');
    await approvedLeave(ctxB, reportB.employmentId, '2026-08-13', '2026-08-14');

    const teamIds = [manager.personId, reportA.personId, reportB.personId];
    const read = () =>
      plannedAbsences(adminCtx(b), [b.companyId], WINDOW, FAKE_TODAY, { personIds: teamIds });

    // Budget breakdown (per call): 4 set_config + emps + leaves + per-date rows fetch, then per DISTINCT
    // employment with eligible leave: 1 roster + 3 holiday-resolution queries (workingDatesForSpans).
    // 3 employments ⇒ 7 + 3×4 = 19. A reintroduced per-LEAVE lookup or a second plannedAbsences call
    // breaks this exact number — that is the point of pinning it.
    const first = await countQueries(read);
    expect(first.queries).toBe(19);

    // MORE leaves for the same employments must NOT change the round-trip count (the old code paid
    // 2 round-trips per LEAVE; the fix pays per EMPLOYMENT).
    await approvedLeave(ctxA, reportA.employmentId, '2026-08-13', '2026-08-14');
    await approvedLeave(ctxA, reportA.employmentId, '2026-08-16', '2026-08-16');
    const second = await countQueries(read);
    expect(second.queries).toBe(first.queries);
    // Sanity: the extra leaves are really in the result (the equal count is not an empty-read artifact).
    expect(second.result.find((r) => r.id === reportA.personId)!.leaves.length).toBeGreaterThanOrEqual(3);
  });
});

describe('awayTodayCount replaces the second plannedAbsences fetch (eae550e9 step 2)', () => {
  it('matches teamAwayToday over a company-scoped today-covering read — including with ?abs= on a FUTURE week', async () => {
    const ctxA = await subjectCtxFor(reportA.personId);
    const ctxO = await subjectCtxFor(outsider.personId);
    // reportA: approved leave straddling "today". outsider: approved leave covering today — OUTSIDE the
    // manager's team, but inside the company scope the card has always counted. reportB: pending only
    // (must not count).
    await approvedLeave(ctxA, reportA.employmentId, '2026-08-10', '2026-08-12');
    await approvedLeave(ctxO, outsider.employmentId, '2026-08-11', '2026-08-11');
    const ctxB = await subjectCtxFor(reportB.personId);
    await requestLeave(ctxB, {
      employmentId: reportB.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-11',
      endDate: '2026-08-11',
    });

    // The exact input teamAwayToday consumed before this change: company-scoped rows over a window
    // covering today. The new count must reproduce its number bit-for-bit (viewer excluded).
    const companyRows = await plannedAbsences(adminCtx(b), [b.companyId], WINDOW, FAKE_TODAY);
    const expected = teamAwayToday(companyRows, FAKE_TODAY, manager.personId);
    expect(expected).toBe(2); // reportA + outsider; pending reportB excluded

    const count = await awayTodayCount(adminCtx(b), [b.companyId], FAKE_TODAY, manager.personId);
    expect(count).toBe(expected);

    // The ?abs=FUTURE-week hazard the old second fetch existed for: the strip rows for a future window
    // cannot feed the card (the straddling leave is absent there), and the dedicated count does not care.
    const futureRows = await plannedAbsences(
      adminCtx(b),
      [b.companyId],
      { from: '2026-09-07', to: '2026-09-13' },
      FAKE_TODAY,
      { personIds: [manager.personId, reportA.personId, reportB.personId] },
    );
    expect(teamAwayToday(futureRows, FAKE_TODAY, manager.personId)).toBe(0); // wrong on purpose
    expect(await awayTodayCount(adminCtx(b), [b.companyId], FAKE_TODAY, manager.personId)).toBe(2);
  });

  it('a per-date-approval request whose TODAY date row is rejected does not count (ADR-0068 parity)', async () => {
    const ctxA = await subjectCtxFor(reportA.personId);
    const reqId = await approvedLeave(ctxA, reportA.employmentId, '2026-08-10', '2026-08-12');
    // Seed per-date rows directly: today's (11 Aug) date row REJECTED, neighbours approved. The calendar's
    // approved-run expansion drops 11 Aug, so teamAwayToday never counted this person — the count must not.
    await owner.db.insert(schema.leaveRequestDate).values(
      [
        { leaveDate: '2026-08-10', status: 'approved' as const },
        { leaveDate: '2026-08-11', status: 'rejected' as const },
        { leaveDate: '2026-08-12', status: 'approved' as const },
      ].map((d) => ({
        tenantId: b.tenantId,
        leaveRequestId: reqId,
        subjectEmploymentId: reportA.employmentId,
        leaveDate: d.leaveDate,
        days: '1.00',
        status: d.status,
      })),
    );

    const companyRows = await plannedAbsences(adminCtx(b), [b.companyId], WINDOW, FAKE_TODAY);
    const expected = teamAwayToday(companyRows, FAKE_TODAY, manager.personId);
    expect(expected).toBe(0);
    expect(await awayTodayCount(adminCtx(b), [b.companyId], FAKE_TODAY, manager.personId)).toBe(0);
  });

  it('agrees under the manager’s own RLS-trimmed session too', async () => {
    const ctxA = await subjectCtxFor(reportA.personId);
    await approvedLeave(ctxA, reportA.employmentId, '2026-08-10', '2026-08-12');

    const rows = await plannedAbsences(mgrCtx, [b.companyId], WINDOW, FAKE_TODAY);
    const expected = teamAwayToday(rows, FAKE_TODAY, manager.personId);
    expect(await awayTodayCount(mgrCtx, [b.companyId], FAKE_TODAY, manager.personId)).toBe(expected);
  });
});
