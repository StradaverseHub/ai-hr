/**
 * r302 hand-fix after the SECOND verification of 6c9802c9 (My Leave dashboard). Each arm is the verifier's
 * reproduction (red on 58679218) turned into the invariant it broke:
 *   1. a day given back after a per-date approval reads CANCELLED on every row of the application — also for a
 *      split made before r302, whose per-date rows stayed on the root;
 *   2. the Details column adds up (Total − Taken − Pending − Forfeited = Available) when the card's Balance also
 *      counts rows dated after the leave year, and the two Availables differ by exactly that amount;
 *   3. the Year selector offers the selections whose cycles hold rows under the cards' own mapping, and a leave
 *      year that ended before the employee joined is neither offered nor shown;
 *   4. a split with no recorded lineage prints no Applied date (the page, pinned by source).
 * Dates derive from todayInKualaLumpur().
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { decideLeaveCancellation, decideLeaveDates, requestLeave, requestLeaveCancellation } from '../core/leave';
import { leaveEntitlementBreakdown, leaveRequestDateBreakdown, listLeaveRequestsPage } from '../core/read';
import { myLeaveDashboard, ownLeaveApprovalTrails } from '../core/my-leave';
import { applicationDateOutcomeRows, approvalProgress, isPartiallyApproved, type HistoryLineDeps } from '../lib/my-leave-history';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const TODAY = todayInKualaLumpur();
const YEAR = Number(TODAY.slice(0, 4));
const MONTH = Number(TODAY.slice(5, 7));
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nextMonday = (from: string) => {
  let d = from;
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
};
const mm = (n: number) => String(n).padStart(2, '0');
const r2 = (n: number) => Math.round(n * 100) / 100;

async function person(name: string, role: 'employee' | 'manager' | 'hr_admin', hiredOn = '2019-01-01') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `r302hf_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  const ctx: SessionContext = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, e.personId, role), personId: e.personId, roles: [role] };
  return { ...e, ctx };
}
type P = Awaited<ReturnType<typeof person>>;
const ledger = (employmentId: string, leaveTypeId: string, entryType: 'accrual' | 'debit' | 'adjustment' | 'in_lieu_accrual', days: number, effectiveOn: string, sourceRequestId?: string) =>
  owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId, leaveTypeId, entryType, days: days.toFixed(2), effectiveOn, sourceRequestId: sourceRequestId ?? null } as never);
const approvedReq = async (emp: P, T: string, start: string, end: string, days: number) => {
  const [r] = await owner.db
    .insert(schema.leaveRequest)
    .values({ tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: T, startDate: start, endDate: end, days: days.toFixed(2), status: 'approved' })
    .returning({ id: schema.leaveRequest.id });
  await ledger(emp.employmentId, T, 'debit', -days, start, r.id);
  return r.id;
};
const newType = async (over: Record<string, unknown> = {}) => {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code: `HF_${randomUUID().slice(0, 6).toUpperCase()}`, name: `Type ${randomUUID().slice(0, 4)}`, paid: true, counting: 'calendar_days', visibleToEmployee: true, ...over } as never)
    .returning({ id: schema.leaveType.id });
  return lt.id as string;
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

const deps: HistoryLineDeps = {
  t: (key, values) => (values ? `${key}${JSON.stringify(values)}` : key),
  kindLabel: (kind) => (kind ? `KIND:${kind}` : null),
  fmtInstant: (d) => (d ? `T:${d.toISOString()}` : null),
  listNames: (n) => n.join('|'),
};


const deps: HistoryLineDeps = {
  t: (key, values) => (values ? `${key}${JSON.stringify(values)}` : key),
  kindLabel: (kind) => (kind ? `KIND:${kind}` : null),
  fmtInstant: (d) => (d ? `T:${d.toISOString()}` : null),
  listNames: (n) => n.join('|'),
};
const LOG = (_k: string, _v: unknown) => {};
async function world() {
  const emp = await person('Nadia Employee', 'employee');
  const mgr = await person('Marcus Manager', 'manager');
  const { setReportingLine } = await import('../core/org');
  await setReportingLine(adminCtx(b), { subordinateEmploymentId: emp.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2019-01-01' });
  await ledger(emp.employmentId, b.annualLeaveTypeId, 'accrual', 30, `${YEAR}-01-01`);
  return { emp, mgr };
}

describe('1 · a given-back day reads Cancelled on every row of the application', () => {
  it('per-date MON..FRI, WED rejected; MON given back, then TUE given back on the survivor', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
    await owner.db.update(schema.leaveType).set({ counting: 'working_days', perDateApproval: true, employeeCancelApproved: true } as never).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const { emp, mgr } = await world();
    const MON = nextMonday(addDays(TODAY, 14));
    const [TUE, WED, THU, FRI] = [1, 2, 3, 4].map((n) => addDays(MON, n));
    const { leaveRequestId: A } = await requestLeave(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: FRI, today: TODAY });
    await decideLeaveDates(mgr.ctx, {
      leaveRequestId: A,
      deciderEmploymentId: mgr.employmentId,
      decisions: [
        { leaveDate: MON, decision: 'approved' },
        { leaveDate: TUE, decision: 'approved' },
        { leaveDate: WED, decision: 'rejected', rejectReason: 'Audit week; see memo, v2' },
        { leaveDate: THU, decision: 'approved' },
        { leaveDate: FRI, decision: 'approved' },
      ],
    });
    // The application was submitted days ago (so a split's own creation cannot pass for it).
    const [aRow] = await owner.db.select({ createdAt: schema.leaveRequest.createdAt }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, A));
    const submitted = new Date(aRow.createdAt.getTime() - 3 * 86_400_000);
    await owner.db.update(schema.leaveRequest).set({ createdAt: submitted }).where(eq(schema.leaveRequest.id, A));

    const c1 = await requestLeaveCancellation(emp.ctx, { leaveRequestId: A, cancelDates: [MON], reason: 'one', today: TODAY });
    await decideLeaveCancellation(mgr.ctx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved', deciderEmploymentId: mgr.employmentId });
    let rows = (await listLeaveRequestsPage(emp.ctx, { employmentIds: [emp.employmentId], sort: 'start', dir: 'asc', limit: 10, offset: 0 })).rows;
    const B = rows.find((r) => r.status === 'approved' && r.id !== A)!.id;
    const c2 = await requestLeaveCancellation(emp.ctx, { leaveRequestId: B, cancelDates: [TUE], reason: 'two', today: TODAY });
    await decideLeaveCancellation(mgr.ctx, { cancellationRequestId: c2.cancellationRequestId, decision: 'approved', deciderEmploymentId: mgr.employmentId });
    rows = (await listLeaveRequestsPage(emp.ctx, { employmentIds: [emp.employmentId], sort: 'start', dir: 'asc', limit: 10, offset: 0 })).rows;
    const trails = await ownLeaveApprovalTrails(emp.ctx, rows.map((r) => r.id));
    const breakdowns = new Map(await Promise.all(rows.map(async (r) => [r.id, await leaveRequestDateBreakdown(emp.ctx, r.id)] as const)));

    // What app/leave/page.tsx shows as each row's per-date list (its own expression, pinned by source).
    const page = readFileSync(path.resolve(__dirname, '../app/leave/page.tsx'), 'utf8');
    expect(page).toContain('const dateRows = applicationOutcome ? applicationDateOutcomeRows(applicationOutcome) : (requestDateBreakdowns.get(r.id) ?? []);');
    const shown = (id: string) => {
      const o = trails.get(id)?.perDateOutcome ?? null;
      return (o ? applicationDateOutcomeRows(o) : (breakdowns.get(id) ?? [])).map((d) => `${d.leaveDate}:${d.status}`);
    };
    const view = rows.map((r) => ({
      row: r.id === A ? 'A' : r.id === B ? 'B' : 'C',
      status: r.status,
      span: `${r.startDate}..${r.endDate}`,
      lineage: trails.get(r.id)?.lineage,
      submittedAt: trails.get(r.id)?.submittedAt?.toISOString() ?? null,
      appliedOnPage: todayInKualaLumpur(trails.get(r.id)?.submittedAt ?? new Date(r.appliedOn)),
      partial: isPartiallyApproved(r, trails.get(r.id)),
      progress: approvalProgress(r, trails.get(r.id), undefined, deps).map((s) => `${s.state}:${s.label}:${s.detail}`),
      ownDates: (breakdowns.get(r.id) ?? []).map((d) => `${d.leaveDate}:${d.status}`),
      pageDates: shown(r.id),
    }));
    LOG('SPLIT2', view);
    const C = rows.find((r) => r.id !== A && r.id !== B)!;
    expect(rows.length).toBe(3);
    // Split of a split: C → B → A.
    for (const id of [B, C.id]) {
      const t = trails.get(id)!;
      expect(t.lineage, 'split rows read the root').toBe('root');
      expect(t.submittedAt?.toISOString(), 'Submitted = the application’s submission, every generation').toBe(submitted.toISOString());
      expect(t.perDateOutcome).toEqual({ approved: [MON, TUE, THU, FRI], rejected: [{ date: WED, reason: 'Audit week; see memo, v2' }] });
    }
    expect(todayInKualaLumpur(trails.get(C.id)!.submittedAt!)).toBe(todayInKualaLumpur(submitted));
    // THE GIVEN-BACK DAYS. The hand-fix marks MON and TUE 'cancelled' on their own date rows; the page's per-date
    // list for every row of the application is the approval event's, which knows nothing of the give-backs.
    const ownAll = new Map(rows.flatMap((r) => (breakdowns.get(r.id) ?? []).map((d) => [d.leaveDate, d.status] as const)));
    expect([ownAll.get(MON), ownAll.get(TUE)], 'the date rows say the given-back days are cancelled').toEqual(['cancelled', 'cancelled']);
    for (const r of rows) {
      const list = shown(r.id);
      expect(list.filter((s) => s.startsWith(MON) || s.startsWith(TUE)), `row ${r.status} ${r.startDate}: a given-back day never reads Approved`).not.toContain(`${MON}:approved`);
    }
  });

    // Every row's list: MON and TUE Cancelled, WED Rejected, THU and FRI Approved.
    for (const r of rows) {
      expect(shown(r.id).filter((x) => !x.startsWith(WED)), `row ${r.status} ${r.startDate}`).toEqual([`${MON}:cancelled`, `${TUE}:cancelled`, `${THU}:approved`, `${FRI}:approved`]);
      expect(shown(r.id)).toContain(`${WED}:rejected`);
    }

    // A split made BEFORE r302 left every per-date row on the root, still 'approved'. Put them back that way.
    await owner.db.update(schema.leaveRequestDate).set({ leaveRequestId: A, status: 'approved' }).where(and(eq(schema.leaveRequestDate.subjectEmploymentId, emp.employmentId), eq(schema.leaveRequestDate.status, 'cancelled')));
    await owner.db.update(schema.leaveRequestDate).set({ leaveRequestId: A }).where(eq(schema.leaveRequestDate.subjectEmploymentId, emp.employmentId));
    const legacy = await ownLeaveApprovalTrails(emp.ctx, rows.map((r) => r.id));
    for (const r of rows) {
      const o = legacy.get(r.id)?.perDateOutcome ?? null;
      const list = (o ? applicationDateOutcomeRows(o) : []).map((d) => `${d.leaveDate}:${d.status}`);
      expect(list, `legacy row ${r.status} ${r.startDate}`).toEqual([`${MON}:cancelled`, `${TUE}:cancelled`, `${WED}:rejected`, `${THU}:approved`, `${FRI}:approved`]);
    }
  });
});

describe('2 · the Details column adds up when the card also counts rows after the leave year', () => {
  it('next year granted early + leave booked next year + a pending request this year', async () => {
    const { emp, mgr } = await world();
    void mgr;
    const T = b.annualLeaveTypeId;
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR + 1}-01-01`);
    await approvedReq(emp, T, `${YEAR + 1}-02-02`, `${YEAR + 1}-02-03`, 2);
    const MON = nextMonday(addDays(TODAY, 7));
    if (MON.slice(0, 4) !== String(YEAR)) return; // late December: no pending day left in this leave year
    await requestLeave(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: T, startDate: MON, endDate: MON, today: TODAY });
    const card = (await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY })).cards.find((c) => c.leaveTypeId === T)!;
    const bd = card.breakdown!;
    expect(card.balanceIncludesLater, 'the card counts rows after the year').not.toBeNull();
    expect(r2(bd.totalEntitlement - bd.takenThisCycle - bd.pendingApproval - bd.forfeitedThisCycle), 'the column closes on its Available').toBe(bd.totalAvailable);
    expect(bd.pendingApproval, 'Pending is the card’s').toBe(card.pending);
    const thisYear = (await leaveEntitlementBreakdown(emp.ctx, emp.employmentId, T, card.cycleEnd))!;
    expect(r2(card.canApplyFor! - bd.totalAvailable), 'the two Availables differ by exactly the rows after the year').toBe(r2(card.balance! - thisYear.balance));
    expect(r2(card.canApplyFor! - bd.totalAvailable)).toBe(12);
  });
});

describe('3 · the Year selector and the cycles it maps to', () => {
  it('Oct–Sep-style type, rows only in one old cycle: that cycle is offered and shown', async () => {
    if (MONTH === 12) return;
    const hm = mm(MONTH + 1);
    const emp = await person('Gap Year', 'employee', `${YEAR - 8}-${hm}-01`);
    const T = await newType({ name: 'Anniv gap', yearCycleOverride: 'a2a' });
    const rowOn = `${YEAR - 4}-${hm}-01`;
    await ledger(emp.employmentId, T, 'accrual', 9, rowOn);
    const d = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY });
    const shown: { year: number; cycle: [string, string] }[] = [];
    for (const y of d.years) {
      const c = (await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY, year: y === YEAR ? undefined : String(y) })).cards.find((x) => x.leaveTypeId === T)!;
      shown.push({ year: y, cycle: [c.cycleStart, c.cycleEnd] });
    }
    expect(shown.some((s) => s.cycle[0] <= rowOn && rowOn <= s.cycle[1] && s.year !== YEAR), JSON.stringify({ years: d.years, shown })).toBe(true);
    // No offered earlier selection maps this type to a cycle without rows.
    expect(shown.filter((s) => s.year !== YEAR).every((s) => s.cycle[0] <= rowOn && rowOn <= s.cycle[1]), JSON.stringify(shown)).toBe(true);
  });

  it('a leave year that ended before the employee joined is neither offered for it nor shown', async () => {
    if (MONTH === 12) return;
    const hm = mm(MONTH + 1);
    const hiredOn = `${YEAR - 1}-${hm}-15`;
    const emp = await person('New Joiner', 'employee', hiredOn);
    const T = await newType({ name: 'Anniv joiner', yearCycleOverride: 'a2a' });
    const CAL = b.annualLeaveTypeId;
    await ledger(emp.employmentId, T, 'accrual', 8, hiredOn);
    await ledger(emp.employmentId, CAL, 'accrual', 4, hiredOn);
    const d = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY });
    expect(d.years).toContain(YEAR - 1); // the calendar type holds rows last calendar year
    const prev = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY, year: String(YEAR - 1) });
    expect(prev.cards.find((c) => c.leaveTypeId === CAL), 'the calendar year the employee joined in is shown').toBeTruthy();
    const anniv = prev.cards.find((c) => c.leaveTypeId === T);
    expect(anniv == null || anniv.cycleEnd >= hiredOn, `no card for a leave year ending before ${hiredOn}: ${anniv?.cycleStart}..${anniv?.cycleEnd}`).toBe(true);
  });
});

describe('4 · a split with no recorded lineage prints no Applied date', () => {
  it('the page sets appliedOn to null for lineage "unrecorded"', () => {
    const page = readFileSync(path.resolve(__dirname, '../app/leave/page.tsx'), 'utf8');
    expect(page).toContain("appliedOn: trail?.lineage === 'unrecorded' ? null : todayInKualaLumpur(trail?.submittedAt ?? new Date(r.appliedOn)),");
  });
});
