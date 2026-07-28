/**
 * Reporting & Analytics — visual dashboards aggregation layer. Asserts the panel's exact failure cases:
 *  - person-level dimensions (gender/marital/age) sum to total headcount INCLUDING the Unknown bucket
 *    (NULL-DOB/NULL-gender employee) and the Unassigned bucket (employee with no current assignment);
 *  - demographicsByNationality counts DISTINCT person (concurrent-employment counted once), maps a
 *    no-statutory-row person to Unknown (not dropped, not defaulted to citizen), and is admin-gated;
 *  - byEmploymentStatus returns the DERIVED Employee Status (9cbf5e0d) — the same five buckets Personnel
 *    shows — and NEVER the retired stored assignment.status values (on_leave / offboarding / terminated);
 *  - the manager filter uses the open-line predicate (a superseded reporting line is NOT matched);
 *  - leaveUtilisation separates granted vs taken; leaveBalancesSummary equals core/leave.ts#leaveBalance;
 *    sickLeaveTrend returns "not configured" when no sick-coded type exists;
 *  - every filter narrows (AND-composition); compensation never appears in any new payload.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { assignment, employeeStatutoryMy, leaveLedger, leaveType, person, reportingLine } from '../db/schema';
import { hireEmployee, setEmploymentInfo, setReportingLine, terminateEmployment } from '../core/org';
import { leaveBalance } from '../core/leave';
import {
  demographicsByNationality,
  leaveBalancesSummary,
  leaveUtilisation,
  movementByMonth,
  sickLeaveTrend,
  turnoverRateFiltered,
  workforceDemographics,
  UNASSIGNED_BUCKET,
  UNKNOWN_BUCKET,
  type DimensionCount,
} from '../core/analytics';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ASOF = '2026-06-30';
const sumCounts = (rows: DimensionCount[]) => rows.reduce((s, r) => s + r.count, 0);
const countFor = (rows: DimensionCount[], name: string) => rows.find((r) => r.name === name)?.count ?? 0;

describe('Reporting & Analytics — dashboards aggregation', () => {
  let base: Base;
  let a: SessionContext;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    a = adminCtx(base);
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (name: string, opts: { dept?: string; type?: 'full_time' | 'part_time' | 'contract' | 'intern' } = {}) =>
    hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
      companyId: base.companyId,
      departmentId: opts.dept ?? base.deptA,
      employmentType: opts.type ?? 'full_time',
      hiredOn: '2026-01-10',
    });

  const setPerson = (personId: string, vals: Partial<{ gender: string; maritalStatus: string; dateOfBirth: string }>) =>
    owner.db.update(person).set(vals).where(eq(person.id, personId));

  const setStatutory = (personId: string, citizenship: 'citizen' | 'pr' | 'non_citizen', ic: string) =>
    owner.db.insert(employeeStatutoryMy).values({ tenantId: base.tenantId, personId, icNumber: ic, epfCitizenship: citizenship });

  const setStatus = (employmentId: string, status: 'on_leave' | 'probation' | 'offboarding') =>
    owner.db.update(assignment).set({ status }).where(eq(assignment.employmentId, employmentId));

  it('person-level dimensions sum to total headcount, including Unknown and Unassigned buckets', async () => {
    const ann = await hire('Ann'); // full data
    await setPerson(ann.personId, { gender: 'female', maritalStatus: 'married', dateOfBirth: '1990-05-01' });
    const bob = await hire('Bob');
    await setPerson(bob.personId, { gender: 'male', maritalStatus: 'single', dateOfBirth: '1965-01-01' }); // 55+
    const cara = await hire('Cara'); // NULL gender / NULL DOB → Unknown bucket
    void cara;
    // Dan: full person data but NO current assignment (close his open assignment) → Unassigned bucket
    // for the assignment-derived dims, while his gender/age still land in real buckets.
    const dan = await hire('Dan');
    await setPerson(dan.personId, { gender: 'male', maritalStatus: 'single', dateOfBirth: '1995-06-01' });
    await owner.db.update(assignment).set({ validTo: '2026-02-01' }).where(eq(assignment.employmentId, dan.employmentId));

    const d = await workforceDemographics(a, undefined, { asOf: ASOF });
    expect(d.total).toBe(4);
    // person-level dims sum to the full headcount (Unknown included)
    expect(sumCounts(d.byGender)).toBe(4);
    expect(sumCounts(d.byMarital)).toBe(4);
    expect(sumCounts(d.byAgeBand)).toBe(4);
    expect(countFor(d.byGender, UNKNOWN_BUCKET)).toBe(1); // Cara
    expect(countFor(d.byAgeBand, UNKNOWN_BUCKET)).toBe(1); // Cara (NULL DOB)
    expect(countFor(d.byAgeBand, '55+')).toBe(1); // Bob
    // assignment-derived dims also sum to total, with Dan folded into Unassigned
    expect(sumCounts(d.byDepartment)).toBe(4);
    expect(countFor(d.byDepartment, UNASSIGNED_BUCKET)).toBe(1); // Dan
    expect(sumCounts(d.byEmploymentStatus)).toBe(4);
  });

  // 9cbf5e0d — this used to assert the stored 5-way assignment.status (on_leave / probation). The dashboard
  // now shows the ONE derived Employee Status, so the vectors are driven by the employment LIFECYCLE and the
  // retired stored values must not survive into the tally even when a legacy row still carries them.
  it('byEmploymentStatus returns the derived Employee Status, never the retired stored values', async () => {
    const active = await hire('Active One');
    const stale = await hire('Leave Two');
    const prob = await hire('Prob Three');
    // A legacy row still carrying the retired stored status — it must derive to 'active', not 'on_leave'.
    await setStatus(stale.employmentId, 'on_leave');
    await setStatus(prob.employmentId, 'probation');
    // Probation is a LIFECYCLE fact now: a confirmation date still ahead of asOf.
    await setEmploymentInfo(a, { employmentId: prob.employmentId, confirmationDate: '2026-12-01' });
    void active;

    const d = await workforceDemographics(a, undefined, { asOf: ASOF });
    expect(countFor(d.byEmploymentStatus, 'active')).toBe(2);
    expect(countFor(d.byEmploymentStatus, 'probation')).toBe(1);
    expect(countFor(d.byEmploymentStatus, 'on_leave')).toBe(0);
    expect(d.byEmploymentStatus.map((r) => r.name).sort()).toEqual(['active', 'probation']);
  });

  it('the Employee Status filter narrows on the derived bucket, not the stored enum', async () => {
    await hire('Filter Active');
    const prob = await hire('Filter Probation');
    await setEmploymentInfo(a, { employmentId: prob.employmentId, confirmationDate: '2026-12-01' });

    const onlyProbation = await workforceDemographics(a, undefined, {
      asOf: ASOF,
      filters: { assignmentStatus: 'probation' },
    });
    expect(onlyProbation.total).toBe(1);
    expect(countFor(onlyProbation.byEmploymentStatus, 'probation')).toBe(1);
    // A retired value can no longer select anybody.
    const retired = await workforceDemographics(a, undefined, {
      asOf: ASOF,
      filters: { assignmentStatus: 'on_leave' },
    });
    expect(retired.total).toBe(0);
  });

  it('demographicsByNationality: distinct person, Unknown for no-statutory-row, admin-gated', async () => {
    // Multi: one person, two concurrent employments — must count ONCE, not per employment.
    const multi = await hire('Multi Holder');
    await hireEmployee(a, {
      person: { id: multi.personId },
      companyId: base.companyId,
      departmentId: base.deptB,
      employmentType: 'part_time',
      hiredOn: '2026-03-01',
    });
    await setStatutory(multi.personId, 'pr', 'IC-MULTI');
    // No-statutory-row person → Unknown (not dropped, not defaulted to citizen).
    await hire('Nobody Stat');
    // A real citizen with a statutory row.
    const cit = await hire('Cit Izen');
    await setStatutory(cit.personId, 'citizen', 'IC-CIT');

    const rows = await demographicsByNationality(a, undefined, { asOf: ASOF });
    expect(rows).not.toBeNull();
    expect(countFor(rows!, 'pr')).toBe(1); // Multi counted once despite two employments
    expect(countFor(rows!, 'citizen')).toBe(1); // Cit Izen
    expect(countFor(rows!, UNKNOWN_BUCKET)).toBe(1); // Nobody Stat — not silently citizen
    expect(sumCounts(rows!)).toBe(3); // 3 distinct persons

    // Admin-gated: a non-admin (manager) gets null (UI omits the card).
    const mgrCtx: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['manager'] };
    expect(await demographicsByNationality(mgrCtx, undefined, { asOf: ASOF })).toBeNull();
  });

  it('manager filter uses the open-line predicate — a superseded reporting line is NOT matched', async () => {
    const mgr = await hire('Manager M');
    const sub = await hire('Sub S');
    await setReportingLine(a, {
      subordinateEmploymentId: sub.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-15',
    });
    // Sanity: the open line matches.
    const open = await workforceDemographics(a, undefined, { asOf: ASOF, filters: { managerEmploymentId: mgr.employmentId } });
    expect(open.total).toBe(1);

    // Supersede the line (correction tombstone) — it must no longer match.
    await owner.db.update(reportingLine).set({ supersededAt: new Date() }).where(eq(reportingLine.managerEmploymentId, mgr.employmentId));
    const superseded = await workforceDemographics(a, undefined, { asOf: ASOF, filters: { managerEmploymentId: mgr.employmentId } });
    expect(superseded.total).toBe(0);
  });

  it('leaveUtilisation separates granted vs taken; leaveBalancesSummary equals core/leave.ts#leaveBalance', async () => {
    const e = await hire('Leave Taker');
    const lt = base.annualLeaveTypeId;
    // accrual +14, debit -3, positive adjustment +1, negative adjustment -2 → balance = 10.
    await owner.db.insert(leaveLedger).values([
      { tenantId: base.tenantId, employmentId: e.employmentId, leaveTypeId: lt, entryType: 'accrual', days: '14.00', effectiveOn: '2026-01-10' },
      { tenantId: base.tenantId, employmentId: e.employmentId, leaveTypeId: lt, entryType: 'debit', days: '-3.00', effectiveOn: '2026-03-01' },
      { tenantId: base.tenantId, employmentId: e.employmentId, leaveTypeId: lt, entryType: 'adjustment', days: '1.00', effectiveOn: '2026-04-01' },
      { tenantId: base.tenantId, employmentId: e.employmentId, leaveTypeId: lt, entryType: 'adjustment', days: '-2.00', effectiveOn: '2026-05-01' },
    ]);

    const util = await leaveUtilisation(a, undefined);
    const annual = util.find((r) => r.name === 'Annual Leave');
    expect(annual).toBeDefined();
    expect(annual!.granted).toBe(15); // 14 accrual + 1 positive adjustment (negative adjustment excluded)
    expect(annual!.taken).toBe(3); // magnitude of the debit

    const balances = await leaveBalancesSummary(a, undefined);
    const annualBal = balances.find((r) => r.name === 'Annual Leave');
    expect(annualBal!.balance).toBe(10); // full-history signed sum

    // Parity: equals the canonical leaveBalance for the same employee + type.
    const canonical = await withTenant(a, (tx) => leaveBalance(tx, e.employmentId, lt));
    expect(annualBal!.balance).toBe(canonical);
  });

  it('sickLeaveTrend returns "not configured" when no sick-coded leave type exists', async () => {
    await hire('Anyone'); // base tenant has only ANNUAL — no sick-coded type.
    const trend = await sickLeaveTrend(a, undefined, { from: '2026-01-01', to: ASOF });
    expect(trend.configured).toBe(false);
    expect(trend.series).toEqual([]);

    // Add a sick-coded type + a debit, and it resolves to a configured trend.
    const [sick] = await owner.db
      .insert(leaveType)
      .values({ tenantId: base.tenantId, code: 'SICK', name: 'Sick Leave', paid: true })
      .returning({ id: leaveType.id });
    const e = await hire('Sick Person');
    await owner.db.insert(leaveLedger).values({
      tenantId: base.tenantId,
      employmentId: e.employmentId,
      leaveTypeId: sick.id,
      entryType: 'debit',
      days: '-2.00',
      effectiveOn: '2026-04-15',
    });
    const configured = await sickLeaveTrend(a, undefined, { from: '2026-01-01', to: ASOF });
    expect(configured.configured).toBe(true);
    expect(configured.series).toEqual([{ month: '2026-04', days: 2 }]);
  });

  it('movement + turnover honour the company filter (AND-composition)', async () => {
    await hire('Mover One'); // hired 2026-01-10
    const leaver = await hire('Mover Two');
    await terminateEmployment(a, { employmentId: leaver.employmentId, terminationDate: '2026-05-20', terminationType: 'voluntary' });

    const movement = await movementByMonth(a, undefined, { from: '2026-01-01', to: ASOF });
    const jan = movement.find((m) => m.month === '2026-01');
    const may = movement.find((m) => m.month === '2026-05');
    expect(jan?.hires).toBe(2);
    expect(may?.leavers).toBe(1);
    expect(may?.netChange).toBe(-1);

    // A bogus company filter narrows everything away.
    const empty = await movementByMonth(a, undefined, { from: '2026-01-01', to: ASOF, filters: { companyId: '00000000-0000-0000-0000-000000000000' } });
    expect(empty).toEqual([]);

    const turnover = await turnoverRateFiltered(a, undefined, { from: '2026-05-01', to: '2026-05-31' });
    expect(turnover.leavers).toBe(1);
  });

  it('RLS-scoped (non-admin) manager: leave + demographic queries run under the app role and return the viewer-scoped subset; nationality is withheld', async () => {
    // Manager sees their direct report (+ self) via the open admin reporting line; an unrelated employee
    // is invisible to them under RLS (can_see_employment). This catches a missing app-role GRANT/policy
    // on leave_ledger / employee_statutory_my that the admin-ctx tests can't.
    // ADR-0052: the manager is now also an HOD of THEIR OWN current department (the recursive can_see
    // rewrite added a department-tree branch). The manager sits in deptB here (same dept as the sub) so
    // the HOD branch covers exactly {mgr, sub}; the outsider is placed in deptA — a department the
    // manager does not head — so they stay invisible, preserving this test's "unrelated → hidden" intent.
    const mgr = await hire('Scoped Mgr', { dept: base.deptB });
    const sub = await hire('Scoped Sub', { dept: base.deptB });
    const outsider = await hire('Outsider', { dept: base.deptA });
    await setReportingLine(a, {
      subordinateEmploymentId: sub.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-10',
    });
    // Leave ledger entries for both the visible sub and the invisible outsider.
    const lt = base.annualLeaveTypeId;
    await owner.db.insert(leaveLedger).values([
      { tenantId: base.tenantId, employmentId: sub.employmentId, leaveTypeId: lt, entryType: 'accrual', days: '8.00', effectiveOn: '2026-01-10' },
      { tenantId: base.tenantId, employmentId: outsider.employmentId, leaveTypeId: lt, entryType: 'accrual', days: '99.00', effectiveOn: '2026-01-10' },
    ]);

    const uM = await createAppUser(base.tenantId, mgr.personId, 'manager');
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: mgr.personId };

    // Leave aggregations execute under the app role (no GRANT/policy error) and exclude the outsider's
    // 99 days — the scoped manager sees only themselves + the visible subordinate.
    const bal = await leaveBalancesSummary(mCtx, undefined);
    const annual = bal.find((r) => r.name === 'Annual Leave');
    expect(annual?.balance).toBe(8); // sub's 8 only; outsider's 99 is filtered by RLS
    const util = await leaveUtilisation(mCtx, undefined);
    expect(util.find((r) => r.name === 'Annual Leave')?.granted).toBe(8);

    // The (non-nationality) demographics query also runs under the app role and is viewer-scoped.
    const demo = await workforceDemographics(mCtx, undefined, { asOf: ASOF });
    expect(demo.total).toBe(2); // mgr + sub, not the outsider
    expect(demo.total).toBeLessThan(3);

    // Nationality is withheld for non-admins (no error — just omitted, so the UI hides the card).
    expect(await demographicsByNationality(mCtx, undefined, { asOf: ASOF })).toBeNull();
  });

  it('no new payload exposes a compensation column', async () => {
    const e = await hire('Comp Free');
    await setPerson(e.personId, { gender: 'male' });
    const d = await workforceDemographics(a, undefined, { asOf: ASOF });
    const nat = await demographicsByNationality(a, undefined, { asOf: ASOF });
    const util = await leaveUtilisation(a, undefined);
    const bal = await leaveBalancesSummary(a, undefined);
    const json = JSON.stringify({ d, nat, util, bal });
    for (const k of ['basicSalary', 'monthlyAllowance', 'salary', 'compensation', 'currency']) {
      expect(json.toLowerCase().includes(k.toLowerCase())).toBe(false);
    }
  });
});
