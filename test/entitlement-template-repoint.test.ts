/**
 * 6e9a126e — THE ENGINES AND THE THREE DATED READERS RESOLVE ENTITLEMENT THROUGH THE TEMPLATE LAYER.
 *
 * Release one shipped the storage, the resolver and the "no opinion" guard, read by NOTHING. Release two
 * re-pointed every granting engine, the projection kernel and the three PAST-DATE readers through ONE
 * composition (`composeEntitlement`, core/leave-compute.ts) and shipped the editor screens. RELEASE THREE
 * (migration 0405) then dropped `leave_policy`, `benefit_scheme` and `scheme_leave_entitlement`, leaving
 * the template layer as the only source of entitlement days there is.
 *
 * ── WHAT THIS FILE EXISTS TO PROVE, IN PRIORITY ORDER ─────────────────────────────────────────────────
 *
 * ① THE RESOLVER REALLY RUNS, AND RANKS. Release two proved this as "a tenant with no templates is
 *    byte-identical to before", because the old layers were still underneath to be identical TO. They are
 *    gone, so the claim is restated on the axis that outlived them and is sharper: an eligibility rule
 *    that reaches NOBODY must not move one number of a configured tenant's year-open, expiry sweep,
 *    reprojection or any of the three readers — and the NEGATIVE CONTROL beside it, the same rule pointed
 *    at the department the employee IS in, must win on specificity and move the figure. Without that pair,
 *    "identical" would also be satisfied by a resolver that never runs at all.
 *
 * ② THE THREE DATED READERS STILL REPRODUCE A PAST YEAR. The approved plan singles out `carryForwardReport`
 *    as the reader release three "as originally written would BREAK", and the mechanism is subtle: the
 *    report never reads entitlement DAYS, it reads the CARRY CAP. Each reader is asserted against a fixture
 *    where the closed year's answer differs from today's on BOTH dated axes at once (which template
 *    VERSION was in force, and which DEPARTMENT the employee sat in), and where the reachable wrong
 *    answers are different numbers from the right one.
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
import {
  expireCarriedLeave,
  openLeaveYear,
  reprojectEntitlementForEmployment,
  CARRY_FORFEIT_REASON_EXPIRY,
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

/**
 * The CARRY rules, on the leave TYPE — which is where 9816a5ad step 2 put every rule, and therefore where
 * the `leave_policy` row these fixtures used to create said them. Days are never set here: they come from
 * an entitlement template's band and nowhere else.
 *
 * ⚠️ SETTING ANY RULE HERE ENGAGES THE OVERLAY, which replaces the WHOLE rule set from the type — so a
 * fixture that needs a BAND's own per-range carry cap to be read must leave this alone. Which of the two
 * each block below wants is stated at the block.
 */
const annualCarryRules = (p: { carryForwardMax?: number; expiry?: { month: number; day: number } }) =>
  owner.db
    .update(schema.leaveType)
    .set({
      carryForwardMax: String(p.carryForwardMax ?? 0),
      carryForwardEnabled: true,
      carryForwardExpiryMode: 'date',
      carryForwardExpiryMonth: p.expiry?.month ?? null,
      carryForwardExpiryDay: p.expiry?.day ?? null,
    })
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));

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
// ① A RULE THAT REACHES NOBODY MOVES NOTHING; A RULE THAT REACHES SOMEBODY MOVES EVERYTHING.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

// ── RETIRED · `templateOverPolicy with no band returns THE SAME OBJECT` and `composeEntitlement with no
//    band IS applyLeaveTypeRules(resolveGradePolicy(…)) and \`scheme ?? policy\`` ────────────────────────
// Both were STRUCTURAL proofs of release two's central safety claim: that with no template configured, the
// expression each engine evaluates REDUCES to the two-layer one that was there before, rather than
// computing the same answer by a different route. They asserted reference identity through
// `templateOverPolicy` and term-for-term equality against `entitledDays(floor, scheme, policyDays)`.
//
// Release three deleted every symbol in both sentences — `templateOverPolicy`, `resolveGradePolicy`,
// `entitledDays`, the `schemeDays` parameter — because the layers they reduced TO are gone. There is
// nothing left for a template to sit over: `composeEntitlement` now takes a band and the type's rules and
// nothing else, and its arity is deliberately the mechanism that made tsc enumerate every site.
// "Byte-identical to the old layers" is not a property that can be stated any more, let alone tested.
//
// What replaced it as the thing worth proving is below, and it is the sharper half of the original pair:
// a rule that does not match must not perturb one that does, and a rule that DOES match must move the
// figure. That is a claim about the resolver actually running, and it survives the layer's removal intact.

describe('6e9a126e · an eligibility rule that reaches nobody changes not one number', () => {
  /**
   * Three runs of the identical scenario, on a freshly seeded tenant each time.
   *
   *   A — one entitlement table, assigned to EVERYONE. The configured baseline.
   *   B — the same, PLUS a second table whose rule is narrowed to a department this employee has never
   *       been in. The resolver is not short-circuited: it loads both rules, ranks them by specificity,
   *       finds this employee outside the narrower one, and must therefore change nothing at all.
   *   C — THE NEGATIVE CONTROL. Same again, but the second rule is narrowed to the department the
   *       employee IS in. It is MORE SPECIFIC than the everyone-rule, so it wins outright and the figure
   *       moves. Without C, "identical" would also be satisfied by a resolver that never runs.
   *
   * The carry cap and expiry sit on the leave TYPE, which is where every rule lives since 9816a5ad
   * step 2 — the same values the dropped `leave_policy` row carried, so the ledger arithmetic is unchanged.
   */
  const runScenario = async (extra?: { name: string; departmentId: string; days: number }) => {
    await annualCarryRules({ carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    await configureTemplate({ name: 'Everyone', bands: flat(12), validFrom: '2025-01-01' });
    if (extra) {
      await configureTemplate({
        name: extra.name,
        bands: flat(extra.days),
        validFrom: '2025-01-01',
        criteria: { departmentIds: [extra.departmentId] },
      });
    }
    const emp = await hire({ hiredOn: '2024-01-01' });
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: emp.employmentId,
      asOf: '2026-06-30',
      trigger: 'profile',
    });
    return {
      employmentId: emp.employmentId,
      ledger: await ledgerRows(emp.employmentId),
      balance: await ledgerBalance(emp.employmentId, b.annualLeaveTypeId),
      report: await reportShape(2026),
      breakdown: await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-06-30'),
    };
  };

  it('a year-open + expiry sweep + reprojection + all three readers do not move when a rule matches NOBODY', async () => {
    const a = await runScenario();
    // A run that produced nothing would make every comparison below vacuous.
    expect(a.ledger.length).toBeGreaterThan(0);
    expect(a.report.length).toBe(1);

    await resetDb();
    b = await seedBase();
    // deptB is a real department in the fixture that this employee has never been in.
    const bRun = await runScenario({ name: 'Nobody', departmentId: b.deptB, days: 30 });

    expect(bRun.ledger).toEqual(a.ledger);
    expect(bRun.balance).toBe(a.balance);
    expect(bRun.report).toEqual(a.report);
    expect(bRun.breakdown?.carriedForward).toBe(a.breakdown?.carriedForward);
    expect(bRun.breakdown?.carryForwardExpiryDate).toBe(a.breakdown?.carryForwardExpiryDate);
    expect(bRun.breakdown?.balance).toBe(a.breakdown?.balance);

    // ── THE NEGATIVE CONTROL. The SAME extra table, pointed at the department the employee is actually
    //    in. A narrower rule beats the everyone-rule on specificity, so the figure must move.
    await resetDb();
    b = await seedBase();
    const c = await runScenario({ name: 'Somebody', departmentId: b.deptA, days: 30 });
    expect(c.ledger).not.toEqual(a.ledger);
    // 30 days from the narrower table, not the 12 the everyone-rule would have given.
    expect(c.ledger.some((r) => r.entryType === 'accrual' && Number(r.days) === 30)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ② THE THREE PAST-DATE READERS. The version in force AT the date, and the department AS AT that date.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE fixture for the two BALANCE readers, in which BOTH dated axes disagree between the closed year and
 * today:
 *
 *   - the TEMPLATE has two versions — from 2024: 20 days, carry 5; from 2026: 30 days, carry 15;
 *   - the EMPLOYEE moved from Finance (deptA) to Operations (deptB) on 2025-07-01, and the eligibility
 *     rule is narrowed to Finance, so resolving with TODAY'S department matches no rule at all.
 *
 * THE LEAVE TYPE IS DELIBERATELY LEFT SILENT ON CARRY. The carry cap is a PER-BAND figure here (5 on v1,
 * 15 on v2), and it has to be, because it is the only thing that differs between the two versions and so
 * the only thing that can prove which version a reader resolved. `applyLeaveTypeRules` replaces the whole
 * rule set the moment the type states one, which would flatten both versions to the same cap and make
 * every assertion below vacuous.
 *
 * The three reachable answers are three different numbers, which is what makes each assertion worth
 * making:  5 = right (2024 version, Finance) · 15 = today's version · 0 = no rule matched at all.
 *
 * ── WHAT CHANGED FROM RELEASE TWO ────────────────────────────────────────────────────────────────────
 * The third wrong answer used to be 3: the `leave_policy` row underneath, deliberately different from both
 * template versions so a fallback would be visible rather than coincidentally right. There is no layer
 * underneath any more, so "no rule matched" resolves to nothing at all and the reader reports 0. The
 * discrimination is unchanged — 5, 15 and 0 are still three different numbers — and the guard is if
 * anything sharper, because 0 is what a SILENTLY BROKEN resolver produces too, so a passing 5 now rules
 * out both wrong answers and total failure at once.
 */
async function pastYearFixture() {
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

describe('6e9a126e · the past-date balance readers reproduce a CLOSED year', () => {
  it('carryForwardReport for a CLOSED year reads that year"s template version through that year"s department', async () => {
    const emp = await pastYearFixture();
    void emp;
    await openLeaveYear(adminCtx(b), { year: 2024 }); // 20 days, Finance, v1
    await openLeaveYear(adminCtx(b), { year: 2025 }); // carry capped at v1's 5

    const [row2025] = await reportShape(2025);
    // THE ASSERTION THIS WHOLE ITEM TURNS ON. 5 comes from the 2024 template version, resolved through a
    // rule that only matches the department the employee was in AT THAT CYCLE'S OPEN.
    //   today's template version would print 15;  today's department matches no rule and would print 0.
    expect(row2025.carried).toBe(5);
    // …and it reconciles with what the engine actually posted, so the reader and the writer agree.
    expect(row2025.forfeitedAtOpen).toBe(15);

    // The CURRENT year answers with the current facts: Operations matches no rule from 2025-07-01, so
    // nothing is configured for this employee and nothing carries — 0, not the template's 15.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const [row2026] = await reportShape(2026);
    expect(row2026.carried).toBe(0);
  });

  it('the balance breakdown at a PAST asOf reads the version and the department in force then', async () => {
    const emp = await pastYearFixture();
    await openLeaveYear(adminCtx(b), { year: 2024 });
    await openLeaveYear(adminCtx(b), { year: 2025 });

    const past = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2025-06-30');
    expect(past?.carriedForward).toBe(5);

    await openLeaveYear(adminCtx(b), { year: 2026 });
    const now = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    // In Operations since 2025-07-01 ⇒ no rule matches ⇒ nothing carried, not the template's 15.
    expect(now?.carriedForward).toBe(0);
  });

  /**
   * THE EXPIRY SWEEP NEEDS ITS OWN FIXTURE, AND WHY IS THE FINDING.
   *
   * The sweep's back-compat gate is `annualTypes.some(typeCarriesExpiry)` — the LEAVE TYPE's own expiry
   * columns (core/leave.ts, expireCarriedLeave). A carry expiry that exists only inside a band can no
   * longer open that gate, and the moment the type states one, `applyLeaveTypeRules` replaces the band's
   * carry cap with the type's too. So the fixture above — which depends on the CAP differing per version —
   * cannot be swept, and a fixture that can be swept cannot discriminate versions by their cap.
   *
   * The property under test survives; it just has to be carried by the other per-version figure. Here the
   * two versions differ in DAYS (20 then 30) with a uniform type-level cap of 25, so what the 2025 open
   * carried is decided by which version granted 2024:
   *   right (v1, 20 granted)          ⇒ carried 20 ⇒ 20 expires;
   *   today's version (v2, 30 granted) ⇒ carried min(30, 25) = 25;
   *   no rule matched                  ⇒ 0 granted, 0 carried, 0 expires.
   * Three different numbers again, and the sweep still has to reconstruct a closed year to reach the right
   * one.
   */
  it('the expiry sweep forfeits a PAST year against THAT year"s template version, not today"s', async () => {
    const emp = await hire({ hiredOn: '2020-01-01', departmentId: b.deptA, grant: false });
    await annualCarryRules({ carryForwardMax: 25, expiry: { month: 3, day: 31 } });
    const tpl = await configureTemplate({
      name: 'Finance table',
      bands: flat(20),
      validFrom: '2024-01-01',
      criteria: { departmentIds: [b.deptA] },
    });
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: tpl.lineageId,
      serviceBands: flat(30),
      validFrom: '2026-01-01',
    });

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
    // Exactly the 20 that the 2024 version granted and the 2025 open carried. Today's version (30 days,
    // carried at the cap) reconstructs 25; no matching rule reconstructs 0.
    expect(expired).toBe(20);
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
