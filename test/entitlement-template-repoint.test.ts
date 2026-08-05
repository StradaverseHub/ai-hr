/**
 * 6e9a126e RELEASE TWO — THE ENGINES AND THE THREE DATED READERS NOW READ `template ?? scheme ?? policy`.
 *
 * Release one shipped the storage, the resolver and the "no opinion" guard, read by NOTHING. This release
 * re-points every granting engine, the projection kernel and the three PAST-DATE readers through ONE
 * composition (`composeEntitlement`, core/leave-compute.ts), and ships the editor screens.
 *
 * ── WHAT THIS FILE EXISTS TO PROVE, IN PRIORITY ORDER ─────────────────────────────────────────────────
 *
 * ① A TENANT WITH NO TEMPLATES IS BYTE-IDENTICAL TO BEFORE. Not a nicety — the entire production case.
 *    Both new tables hold ZERO rows on production (26 employments: 9 resolve through a benefit scheme, 17
 *    fall through to leave_policy), so every figure this release ships must still come out of the old two
 *    layers exactly as it did yesterday. Proved twice over:
 *      - STRUCTURALLY, at the composition itself: with no band `templateOverPolicy` returns the SAME
 *        OBJECT it was given (reference identity, not deep equality), so the expression each engine now
 *        evaluates REDUCES to the one that was there before rather than computing the same answer by a
 *        different route;
 *      - END-TO-END, by running a real year-open, a real expiry sweep, a real reprojection and all three
 *        readers against a tenant with empty template tables, then repeating the identical run while a
 *        template exists that matches NOBODY — the resolver runs for real and must move not one number.
 *    The NEGATIVE CONTROL sits beside it: a template that DOES match moves the figure. Without that pair,
 *    "identical" would also be satisfied by a resolver that never runs at all.
 *
 * ② THE THREE DATED READERS STILL REPRODUCE A PAST YEAR. The approved plan singles out `carryForwardReport`
 *    as the reader release three "as originally written would BREAK", and the mechanism is subtle: the
 *    report never reads entitlement DAYS, it reads the CARRY CAP — and `applyLeaveTypeRules(null, rules)`
 *    returns NULL, so the day leave_policy goes the carrier vanishes and a closed year prints as
 *    "everything forfeited". Each reader is asserted against a fixture where the closed year's answer
 *    differs from today's on BOTH dated axes at once (which template VERSION was in force, and which
 *    DEPARTMENT the employee sat in), and where the three possible wrong answers — today's version,
 *    today's department, the leave_policy fallback — are three DIFFERENT numbers.
 *
 * ③ THE GUARD STILL HOLDS WITH THE NEW LAYER IN THE COMPOSITION. "Nothing configured" is still no opinion
 *    (delta exactly 0, never a clawback); a template that resolves is now an opinion.
 *
 * ── WATCHED FAIL ──────────────────────────────────────────────────────────────────────────────────────
 * Each guard here was watched to fail by breaking the CODE, not the test. The mutations and what each one
 * produced are recorded in the round's commit message.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee, setEmploymentAssignment } from '../core/org';
import { createLeavePolicy } from '../core/admin';
import {
  applyLeaveTypeRules,
  composeEntitlement,
  entitledDays,
  expireCarriedLeave,
  openLeaveYear,
  reprojectEntitlementForEmployment,
  resolveGradePolicy,
  templateOverPolicy,
  CARRY_FORFEIT_REASON_EXPIRY,
  type GradePolicyRow,
  type ResolvedPolicy,
  type ServiceBand,
} from '../core/leave';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  updateEntitlementTemplate,
} from '../core/entitlement-template';
import { carryForwardReport } from '../core/analytics';
import { leaveEntitlementBreakdown } from '../core/read';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

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

const flat = (days: number, carry?: number): ServiceBand[] => [
  { fromYears: 0, toYears: null, days, ...(carry == null ? {} : { carryForwardDays: carry }) },
];

const hire = (p: { hiredOn: string; departmentId?: string; grant?: boolean }) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Repoint', primaryEmail: `rp_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: p.departmentId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: p.hiredOn,
    gradeId: null,
    grantLeaveTypes: p.grant === false ? [] : [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

const annualPolicy = (p: {
  annualDays: number;
  carryForwardMax?: number;
  from: string;
  expiry?: { month: number; day: number };
}) =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays,
    carryForwardMax: p.carryForwardMax ?? 0,
    carryForwardExpiryMonth: p.expiry?.month ?? null,
    carryForwardExpiryDay: p.expiry?.day ?? null,
    validFrom: p.from,
  });

/** A named table plus the rule that assigns it — the two writes the reporter's two screens make. */
async function configureTemplate(p: {
  name: string;
  bands: ServiceBand[];
  validFrom: string;
  criteria?: Record<string, unknown>;
}) {
  const tpl = await createEntitlementTemplate(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    name: p.name,
    serviceBands: p.bands,
    validFrom: p.validFrom,
  });
  await createEligibilityRule(adminCtx(b), {
    name: `${p.name} rule`,
    templateLineageId: tpl.lineageId,
    // An EMPTY criteria object is legal and means EVERYONE — core/org-criteria.ts's own semantics.
    criteria: (p.criteria ?? {}) as never,
    validFrom: p.validFrom,
  });
  return tpl;
}

/** Every ledger row for an employment, with the tenant-specific ids stripped so two RUNS can be compared. */
const ledgerRows = (employmentId: string) =>
  owner.db
    .select({
      entryType: schema.leaveLedger.entryType,
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
      reason: schema.leaveLedger.reason,
    })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.employmentId, employmentId))
    .orderBy(schema.leaveLedger.effectiveOn, schema.leaveLedger.entryType, schema.leaveLedger.days);

/** The report, minus the row identity that necessarily differs between two freshly seeded tenants. */
const reportShape = async (year: number) =>
  (await carryForwardReport(adminCtx(b), undefined, { year })).map(
    ({ employmentId: _id, ...rest }) => rest,
  );

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ① NO TEMPLATES ⇒ BYTE-IDENTICAL. The production case.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

describe('6e9a126e release two · a tenant with NO templates resolves exactly as before', () => {
  const base: ResolvedPolicy = {
    days: 12,
    carryMax: 5,
    method: 'earned_monthly',
    carryExpiry: { month: 3, day: 31 },
    maxBalanceDays: 20,
  };

  it('templateOverPolicy with no band returns THE SAME OBJECT — the expression reduces, it does not recompute', () => {
    // Reference identity, deliberately, not toEqual. Deep equality would also pass for a rebuilt copy, and
    // a rebuilt copy is where a future edit silently drops a field nobody notices for a release.
    expect(templateOverPolicy(base, null)).toBe(base);
    expect(templateOverPolicy(null, null)).toBeNull();
  });

  it('composeEntitlement with no band IS applyLeaveTypeRules(resolveGradePolicy(…)) and `scheme ?? policy`', () => {
    const rows: GradePolicyRow[] = [
      { gradeId: null, companyId: null, accrual: { annualDays: 12, carryForwardMax: 5 } },
    ];
    // A leave type step 1 never backfilled — applyLeaveTypeRules passes the policy straight through.
    const rules = null;
    for (const schemeDays of [null, 0, 15]) {
      const gradePolicy = resolveGradePolicy(rows, null, null, 3);
      const composed = composeEntitlement({ floorDays: 8, templateBand: null, schemeDays, gradePolicy, rules });
      // The carrier is IDENTICALLY what every engine in this codebase computed before this release.
      expect(composed.policy).toEqual(applyLeaveTypeRules(gradePolicy, rules));
      // …and the days are the pre-existing two-layer composition, term for term.
      expect(composed.days).toBe(entitledDays(8, null, schemeDays, gradePolicy?.days ?? 0).days);
      expect(composed.days).toBe(schemeDays ?? 12);
      expect(composed.noOpinion).toBe(false);
    }
  });

  it('a year-open + expiry sweep + reprojection + all three readers do not move when a template matches NOBODY', async () => {
    // ── RUN A: nothing in the new tables at all. This is production, exactly.
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, from: '2025-01-01', expiry: { month: 3, day: 31 } });
    const a = await hire({ hiredOn: '2024-01-01' });
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: a.employmentId,
      asOf: '2026-06-30',
      trigger: 'profile',
    });
    const ledgerA = await ledgerRows(a.employmentId);
    const balA = await ledgerBalance(a.employmentId, b.annualLeaveTypeId);
    const reportA = await reportShape(2026);
    const breakdownA = await leaveEntitlementBreakdown(adminCtx(b), a.employmentId, b.annualLeaveTypeId, '2026-06-30');
    // A run that produced nothing would make every comparison below vacuous.
    expect(ledgerA.length).toBeGreaterThan(0);
    expect(reportA.length).toBe(1);

    // ── RUN B: same tenant shape, same dates, PLUS a template + rule that reach nobody. The resolver is no
    //    longer short-circuited on "no templates at all": it loads, ranks and matches for real, finds this
    //    employee outside the rule, and must therefore change not one number.
    await resetDb();
    b = await seedBase();
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, from: '2025-01-01', expiry: { month: 3, day: 31 } });
    const bEmp = await hire({ hiredOn: '2024-01-01' });
    await configureTemplate({
      name: 'Nobody',
      bands: flat(30, 30),
      validFrom: '2025-01-01',
      // deptB is a real department in the fixture that this employee has never been in.
      criteria: { departmentIds: [b.deptB] },
    });
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: bEmp.employmentId,
      asOf: '2026-06-30',
      trigger: 'profile',
    });

    expect(await ledgerRows(bEmp.employmentId)).toEqual(ledgerA);
    expect(await ledgerBalance(bEmp.employmentId, b.annualLeaveTypeId)).toBe(balA);
    expect(await reportShape(2026)).toEqual(reportA);
    const breakdownB = await leaveEntitlementBreakdown(
      adminCtx(b),
      bEmp.employmentId,
      b.annualLeaveTypeId,
      '2026-06-30',
    );
    expect(breakdownB?.carriedForward).toBe(breakdownA?.carriedForward);
    expect(breakdownB?.carryForwardExpiryDate).toBe(breakdownA?.carryForwardExpiryDate);
    expect(breakdownB?.balance).toBe(breakdownA?.balance);

    // ── THE NEGATIVE CONTROL. Without it, "identical" is also satisfied by a resolver that never runs.
    await resetDb();
    b = await seedBase();
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, from: '2025-01-01', expiry: { month: 3, day: 31 } });
    const cEmp = await hire({ hiredOn: '2024-01-01' });
    await configureTemplate({ name: 'Everybody', bands: flat(30, 30), validFrom: '2025-01-01' });
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const ledgerC = await ledgerRows(cEmp.employmentId);
    expect(ledgerC).not.toEqual(ledgerA);
    // 30 days from the template, not 12 from the policy underneath it.
    expect(ledgerC.some((r) => r.entryType === 'accrual' && Number(r.days) === 30)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ② THE THREE PAST-DATE READERS. The version in force AT the date, and the department AS AT that date.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE fixture for all three, in which BOTH dated axes disagree between the closed year and today:
 *
 *   - the TEMPLATE has two versions — from 2024: 20 days, carry 5; from 2026: 30 days, carry 15;
 *   - the EMPLOYEE moved from Finance (deptA) to Operations (deptB) on 2025-07-01, and the eligibility
 *     rule is narrowed to Finance, so resolving with TODAY'S department matches no rule at all.
 *
 * The three reachable wrong answers are three different numbers, which is what makes each assertion worth
 * making:  5 = right (2024 version, Finance) · 15 = today's version · 3 = no rule matched, leave_policy.
 */
async function pastYearFixture() {
  // The policy underneath, deliberately different from BOTH template versions so a fallback is visible
  // rather than coincidentally right.
  await annualPolicy({ annualDays: 12, carryForwardMax: 3, from: '2023-01-01', expiry: { month: 3, day: 31 } });
  const emp = await hire({ hiredOn: '2020-01-01', departmentId: b.deptA, grant: false });
  const tpl = await configureTemplate({
    name: 'Finance table',
    bands: flat(20, 5),
    validFrom: '2024-01-01',
    criteria: { departmentIds: [b.deptA] },
  });
  // Edit the table for 2026 — close-then-insert, so 2024/2025 keep their own figures.
  await updateEntitlementTemplate(adminCtx(b), {
    lineageId: tpl.lineageId,
    serviceBands: flat(30, 15),
    validFrom: '2026-01-01',
  });
  // …and move the employee out of Finance mid-2025, well clear of any year boundary so the assertion can
  // never be satisfied by an off-by-one on the assignment window.
  await setEmploymentAssignment(adminCtx(b), {
    employmentId: emp.employmentId,
    effectiveDate: '2025-07-01',
    departmentId: b.deptB,
  });
  return emp;
}

describe('6e9a126e release two · the three past-date readers reproduce a CLOSED year', () => {
  it('carryForwardReport for a CLOSED year reads that year"s template version through that year"s department', async () => {
    const emp = await pastYearFixture();
    await openLeaveYear(adminCtx(b), { year: 2024 }); // 20 days, Finance, v1
    await openLeaveYear(adminCtx(b), { year: 2025 }); // carry capped at v1's 5

    const [row2025] = await reportShape(2025);
    // THE ASSERTION THIS WHOLE ITEM TURNS ON. 5 comes from the 2024 template version, resolved through a
    // rule that only matches the department the employee was in AT THAT CYCLE'S OPEN.
    //   today's template version would print 15;  today's department matches no rule and would print 3.
    expect(row2025.carried).toBe(5);
    // …and it reconciles with what the engine actually posted, so the reader and the writer agree.
    expect(row2025.forfeitedAtOpen).toBe(15);

    // The CURRENT year answers with the current facts: Operations matches no rule from 2025-07-01, so the
    // leave_policy cap is the honest answer — 3, not the template's 15.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const [row2026] = await reportShape(2026);
    expect(row2026.carried).toBe(3);
  });

  it('the balance breakdown at a PAST asOf reads the version and the department in force then', async () => {
    const emp = await pastYearFixture();
    await openLeaveYear(adminCtx(b), { year: 2024 });
    await openLeaveYear(adminCtx(b), { year: 2025 });

    const past = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2025-06-30');
    expect(past?.carriedForward).toBe(5);

    await openLeaveYear(adminCtx(b), { year: 2026 });
    const now = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    // In Operations since 2025-07-01 ⇒ no rule matches ⇒ the policy's cap, not the template's 15.
    expect(now?.carriedForward).toBe(3);
  });

  it('the expiry sweep forfeits a PAST year against THAT year"s template version, not today"s', async () => {
    const emp = await pastYearFixture();
    await openLeaveYear(adminCtx(b), { year: 2024 });
    await openLeaveYear(adminCtx(b), { year: 2025 });

    // The sweep walks every year from the earliest configured boundary up to `today`, reconstructing what
    // each year's open carried. 2025 must be reconstructed with the version in force on 2025-01-01.
    await expireCarriedLeave(adminCtx(b), { today: '2025-03-31' });
    const rows = await owner.db
      .select({ days: schema.leaveLedger.days, reason: schema.leaveLedger.reason })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.employmentId, emp.employmentId));
    const expired = rows
      .filter((r) => r.reason === CARRY_FORFEIT_REASON_EXPIRY)
      .reduce((n, r) => n + Math.abs(Number(r.days)), 0);
    // Exactly the 5 that the 2024 version let carry. Today's version (15) reconstructs 15; the policy
    // fallback (3) reconstructs 3.
    expect(expired).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ③ THE "NO OPINION" GUARD, with the template layer now inside the composition.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

describe('6e9a126e release two · the guard survives the new layer', () => {
  /** A grant the engine did not compute — the balance people already hold, which a clawback would take. */
  const seedHeldBalance = (employmentId: string, days: string) =>
    owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days,
      effectiveOn: '2026-01-01',
    });

  it('nothing configured is still NO OPINION — a profile reproject posts exactly 0, never a clawback', async () => {
    const emp = await hire({ hiredOn: '2024-01-01', grant: false });
    await seedHeldBalance(emp.employmentId, '14.00');
    const before = await ledgerBalance(emp.employmentId, b.annualLeaveTypeId);
    const res = await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: emp.employmentId,
      asOf: '2026-06-30',
      trigger: 'profile',
    });
    expect(res.totalDelta).toBe(0);
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(before);
  });

  it('a template that resolves IS an opinion — the projection corrects toward the template figure', async () => {
    const emp = await hire({ hiredOn: '2024-01-01', grant: false });
    await seedHeldBalance(emp.employmentId, '14.00');
    await configureTemplate({ name: 'Everyone', bands: flat(20), validFrom: '2026-01-01' });
    const res = await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: emp.employmentId,
      asOf: '2026-06-30',
      trigger: 'profile',
    });
    // 20 expected against 14 already posted ⇒ +6. The guard did not swallow a real opinion.
    expect(res.totalDelta).toBe(6);
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(20);
  });
});
