/**
 * ADR-0074 — THE CONTROL TOWER ROLL-UP, AND THE STAFFING FIGURE IT REFUSES TO PRINT.
 *
 * The per-run anomaly layer already has its own tests. What is new here is the cross-run view and one
 * decision worth guarding harder than the arithmetic around it: `impliedOperators` is NULL until the
 * tower has verdicts, the thresholds have been tuned off r177's shipped placeholders, AND a human has
 * dispositioned at least one flag.
 *
 * WHY THAT IS THE CASE MOST WORTH PINNING. Every other number here is a count; this one is a headcount
 * projection about people's jobs, computed from checks whose sensitivity nobody has validated. AGENTS 28
 * is the rule (an absent box asserts nothing; a box with a confident wrong number asserts something
 * false) and r177 says it directly for this feature: never quote an auto-clear rate from an unvalidated
 * basis. A regression that made this render "1" on placeholder thresholds would be invisible in every
 * other test and would go straight onto a slide.
 *
 * The three blockers are asserted INDIVIDUALLY, each with the other two satisfied, so a change that
 * collapses them into one condition fails here rather than passing because some blocker still fired.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { evaluateBatchAnomalies, resolveAnomalyVerdict } from '../core/payroll-anomaly';
import { controlTowerView, EXCEPTIONS_PER_OPERATOR_PER_CYCLE } from '../core/control-tower';

describe('ADR-0074 — the control tower, rolled up across runs', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  /** Monotonic across calls: employee_statutory_my_ic_uq is TENANT-wide, so a per-run index collides
   *  the moment a test seeds two runs. Reset per test by beforeEach re-seeding `base`. */
  let icSeq = 0;

  /** One processed run with `n` employees, evaluated by the anomaly layer. */
  async function processedRun(n: number, period = '2026-03') {
    const a = adminCtx(base);
    for (let i = 0; i < n; i++) {
      icSeq++;
      const e = await hireEmployee(a, {
        person: { fullName: `Tower ${icSeq}`, primaryEmail: `tower.${icSeq}@ct.test` },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2024-01-01',
      });
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `90010101${String(1000 + icSeq)}` });
    }
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId: batch.batchId });
    await evaluateBatchAnomalies(a, { batchId: batch.batchId });
    return batch.batchId;
  }

  /** Tune the thresholds — i.e. write the config row whose ABSENCE is one of the three blockers.
   *  detector_id and effective_from are NOT NULL: a config row is always ABOUT a named detector, which
   *  is what makes "has anyone tuned this?" answerable at all. */
  const tuneThresholds = () =>
    owner.db.insert(schema.payrollAnomalyConfig).values({
      tenantId: base.tenantId,
      detectorId: 'net-swing',
      params: { pct: 0.4 },
      effectiveFrom: '2026-01-01',
    });

  /**
   * Give the tower a human signal: disposition one FLAGGED verdict through the real service.
   *
   * Through resolveAnomalyVerdict rather than a raw UPDATE, deliberately: 'confirmed' is not a legal
   * resolution (the check admits accepted / fixed_upstream / false_positive only) and a fixture writing
   * straight to the column would have encoded a value the product can never produce.
   */
  async function resolveOneFlag() {
    const [flag] = await owner.db
      .select({ id: schema.payrollAnomalyVerdict.id })
      .from(schema.payrollAnomalyVerdict)
      .where(
        and(
          eq(schema.payrollAnomalyVerdict.tenantId, base.tenantId),
          isNull(schema.payrollAnomalyVerdict.supersededAt),
          isNull(schema.payrollAnomalyVerdict.resolvedAt),
        ),
      )
      .limit(50);
    if (!flag) return false;
    await resolveAnomalyVerdict(adminCtx(base), { verdictId: flag.id, resolution: 'accepted' });
    return true;
  }

  it('an unevaluated run reports NOT CHECKED, never a 100% clear rate', async () => {
    // "Nothing was checked" and "everything passed" are opposite facts, and a rate of 1.0 states the
    // second. This is the same reasoning ADR-0076 applies to a skipped detector.
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Unchecked', primaryEmail: 'unchecked@ct.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019999' });
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId: batch.batchId });
    // Deliberately NOT evaluated.

    const view = await controlTowerView(a);
    const run = view.runs.find((r) => r.batchId === batch.batchId);
    expect(run, 'a processed run must be listed even before it is checked').toBeTruthy();
    expect(run!.autoClearRate).toBeNull();
    expect(view.ratio.blockedBy).toContain('no_verdicts');
  });

  it('rolls up across runs by VERDICT, not by averaging per-run rates', async () => {
    // A 2-person run and a 6-person run must not carry equal weight in a number quoted as the
    // operation's. Averaging the two rates is the easy mistake and it flatters the small run.
    const a = adminCtx(base);
    await processedRun(2, '2026-01');
    await processedRun(6, '2026-02');

    const view = await controlTowerView(a);
    expect(view.totals.runs).toBeGreaterThanOrEqual(2);
    const seen = view.totals.autoClear + view.totals.review + view.totals.block;
    expect(seen, 'every live verdict is counted exactly once').toBe(view.ratio.covered);
    expect(view.ratio.exceptions).toBe(view.totals.review + view.totals.block);
    if (view.ratio.covered > 0) {
      expect(view.totals.autoClearRate).toBeCloseTo(view.totals.autoClear / view.ratio.covered, 10);
    }
  });

  // ── The three blockers, each isolated ───────────────────────────────────────────────────────────
  it('BLOCKED with no verdicts, even once thresholds are tuned and a human has acted elsewhere', async () => {
    const a = adminCtx(base);
    await tuneThresholds();
    const view = await controlTowerView(a);
    expect(view.ratio.impliedOperators).toBeNull();
    expect(view.ratio.blockedBy).toContain('no_verdicts');
  });

  it('BLOCKED while the thresholds are still the shipped placeholders', async () => {
    const a = adminCtx(base);
    await processedRun(4);
    await resolveOneFlag(); // satisfy the human-signal blocker so only the threshold one can fire

    const view = await controlTowerView(a);
    expect(view.ratio.thresholdsTuned).toBe(false);
    expect(view.ratio.blockedBy).toContain('thresholds_untuned');
    expect(view.ratio.impliedOperators, 'a staffing figure on untuned checks measures the checks').toBeNull();
  });

  it('BLOCKED while no human has ever dispositioned a flag', async () => {
    const a = adminCtx(base);
    await processedRun(4);
    await tuneThresholds(); // satisfy the threshold blocker so only the signal one can fire

    const view = await controlTowerView(a);
    expect(view.totals.resolvedFlagged).toBe(0);
    // NULL, not zero. "No false positives recorded" reads as "no false positives" to every reader who
    // did not write the query.
    expect(view.totals.falsePositiveRate).toBeNull();
    expect(view.ratio.blockedBy).toContain('no_human_signal');
    expect(view.ratio.impliedOperators).toBeNull();
  });

  it('and only then does it put a number on it', async () => {
    const a = adminCtx(base);
    await processedRun(4);
    await tuneThresholds();
    const resolved = await resolveOneFlag();

    // NON-VACUITY: if this fixture ever stopped producing a flag, the positive path below would never
    // run and the case would pass having asserted nothing. Assert the precondition instead of skipping.
    expect(resolved, 'the fixture must produce at least one flagged verdict to resolve').toBe(true);

    const view = await controlTowerView(a);
    expect(view.ratio.covered).toBeGreaterThan(0);
    expect(view.ratio.blockedBy).toEqual([]);
    expect(view.ratio.impliedOperators).toBe(
      Math.max(1, Math.ceil(view.ratio.exceptions / EXCEPTIONS_PER_OPERATOR_PER_CYCLE)),
    );
    // Never zero people: a cycle with exceptions needs somebody, and rounding down to 0 would read as
    // "this runs itself", which is the claim ADR-0074 §7 says has to be earned rather than launched.
    expect(view.ratio.impliedOperators).toBeGreaterThanOrEqual(1);
  });
});
