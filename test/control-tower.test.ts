/**
 * ADR-0074 — THE PAYROLL CHECKS, ROLLED UP ACROSS RUNS, WITH NO STAFFING FIGURE.
 *
 * The per-run anomaly layer already has its own tests. What is pinned here is the cross-run view the AI quality page
 * shows: every live verdict counted once, rates that are null (never 0 or 1) while their denominator is empty, and the
 * placeholder thresholds named as such.
 *
 * AI Centre restructure (owner decision 26, 4 November 2026): the view used to turn the exception count into a headcount
 * of operators (`impliedOperators`). That staffing ratio is removed, here and on every screen; the last case below proves
 * the view carries no headcount field at all, even once every condition it used to wait for holds.
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
import * as controlTower from '../core/control-tower';
import { controlTowerView } from '../core/control-tower';

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
    expect(view.checks.covered).toBe(0);
    expect(view.totals.autoClearRate).toBeNull();
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
    expect(seen, 'every live verdict is counted exactly once').toBe(view.checks.covered);
    if (view.checks.covered > 0) {
      expect(view.totals.autoClearRate).toBeCloseTo(view.totals.autoClear / view.checks.covered, 10);
    }
  });

  // ── What used to block the staffing figure, now said about the checks themselves ───────────────────
  it('with no verdicts, every rate is null, even once thresholds are tuned', async () => {
    const a = adminCtx(base);
    await tuneThresholds();
    const view = await controlTowerView(a);
    expect(view.checks.covered).toBe(0);
    expect(view.totals.autoClearRate).toBeNull();
    expect(view.totals.coverage).toBeNull();
    expect(view.checks.meetsTarget).toBeNull();
  });

  it('names the shipped placeholder thresholds', async () => {
    const a = adminCtx(base);
    await processedRun(4);
    await resolveOneFlag();
    const view = await controlTowerView(a);
    expect(view.checks.thresholdsTuned).toBe(false);
  });

  it('keeps the false-positive rate null while no human has dispositioned a flag', async () => {
    const a = adminCtx(base);
    await processedRun(4);
    await tuneThresholds();
    const view = await controlTowerView(a);
    expect(view.totals.resolvedFlagged).toBe(0);
    // NULL, not zero. "No false positives recorded" reads as "no false positives" to every reader who did not write the query.
    expect(view.totals.falsePositiveRate).toBeNull();
    expect(view.totals.mttrSeconds).toBeNull();
  });

  it('owner decision 26: no staffing figure, even when everything it used to wait for holds', async () => {
    const a = adminCtx(base);
    await processedRun(4);
    await tuneThresholds();
    const resolved = await resolveOneFlag();
    // NON-VACUITY: if this fixture ever stopped producing a flag, the case would pass having asserted nothing.
    expect(resolved, 'the fixture must produce at least one flagged verdict to resolve').toBe(true);
    const view = await controlTowerView(a);
    expect(view.checks.covered).toBeGreaterThan(0);
    expect(view.checks.thresholdsTuned).toBe(true);
    expect(view.totals.resolvedFlagged).toBeGreaterThan(0);
    expect(view.totals.falsePositiveRate).not.toBeNull();
    expect(Object.keys(view).sort()).toEqual(['checks', 'runs', 'totals']);
    expect(Object.keys(view.checks).sort()).toEqual(['covered', 'meetsTarget', 'thresholdsTuned']);
    expect(Object.keys(controlTower)).not.toContain('EXCEPTIONS_PER_OPERATOR_PER_CYCLE');
  });
});
