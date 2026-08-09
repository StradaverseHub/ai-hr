/**
 * ADR-0076 §6.1 / slice 8 — the synthetic harness. A population with KNOWN PLANTED FAULTS, and the
 * assertion that the detectors find exactly those and nothing else.
 *
 * WHAT THIS PROVES, AND WHAT IT EMPHATICALLY DOES NOT. It proves the detectors WORK: every planted fault
 * is found (no false negatives against ground truth) and no clean employee is flagged (no false positives
 * against ground truth). It says NOTHING about real-world thresholds — synthetic variance is a guess
 * about the shape of a distribution, and that distribution is precisely the unknown. ADR-0076 §6 is blunt
 * that only a client's historical registers or a shadow run produces defensible thresholds, and no amount
 * of building substitutes for either. A green run here must never be quoted as an auto-clear rate.
 *
 * IT IS ALSO THE SCALE CHECK. ADR-0074's target is ~3,000 employees evaluated on a DAILY cadence, so the
 * evaluator must not issue work per employee. `gatherContext` is written as a fixed number of batched
 * reads for exactly that reason, and this file runs a population large enough that an N+1 would be
 * obvious rather than theoretical.
 *
 * TIMING IS REPORTED BUT NOT ASSERTED. A wall-clock threshold in a test suite that runs six chunks in
 * parallel on a laptop is a flake generator, and a flaky perf test gets deleted or ignored — which is
 * worse than no perf test. The durable guard against an N+1 is the CODE (one batched read per concern,
 * documented as load-bearing) plus this file's correctness-at-scale assertion; the printed duration is
 * there for a human who is looking.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { evaluateBatchAnomalies, anomalyMetrics } from '../core/payroll-anomaly';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** Big enough that a per-employee query would be plainly visible; small enough to stay a unit of a chunk. */
const POPULATION = 120;

type Planted = 'clean' | 'negative-net' | 'zero-net' | 'no-bank' | 'cash-no-bank' | 'ghost';

let b: Base;
let a: SessionContext;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
});

/**
 * Build one cycle of `POPULATION` employees with a known fault distribution.
 *
 * Returns the ground truth: employmentId -> what was planted. Everything the test asserts is checked
 * against THIS, not against what the detectors happened to say.
 */
async function buildPopulation(
  period: string,
  reuse?: Map<string, Planted>,
): Promise<{ batchId: string; truth: Map<string, Planted> }> {
  const [pp] = await owner.db
    .insert(schema.payPeriod)
    .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'open' })
    .returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      payPeriodId: pp.id,
      payPeriod: period,
      batchDate: `${period}-28`,
      status: 'processed',
    })
    .returning({ id: schema.payrollBatch.id });

  // REUSING THE SAME EMPLOYEES IS WHAT MAKES A SECOND CYCLE A SECOND CYCLE. The prior-period detectors
  // key off an employee's own previous payslip, so a "cycle two" built from fresh people has no prior
  // slip for anyone and those detectors correctly self-disable — which looks like the coverage feature
  // failing when it is actually the fixture being wrong. (It was, the first time this file ran.)
  const plan: Planted[] = [];
  if (reuse) {
    for (const kind of reuse.values()) plan.push(kind);
  } else {
    for (let i = 0; i < POPULATION; i++) {
      // A deliberate, reproducible distribution — no randomness, so a failure is always reproducible.
      if (i % 20 === 3) plan.push('negative-net');
      else if (i % 20 === 7) plan.push('zero-net');
      else if (i % 20 === 11) plan.push('no-bank');
      else if (i % 20 === 15) plan.push('cash-no-bank');
      else if (i % 20 === 19) plan.push('ghost');
      else plan.push('clean');
    }
  }

  const reusedIds = reuse ? [...reuse.keys()] : null;
  const people = reusedIds
    ? []
    : await owner.db
    .insert(schema.person)
    .values(
      plan.map((_, i) => ({
        tenantId: b.tenantId,
        fullName: `Synthetic ${String(i).padStart(4, '0')}`,
        primaryEmail: `syn${i}_${randomUUID().slice(0, 8)}@t.local`,
      })),
    )
    .returning({ id: schema.person.id });

  const employments = reusedIds
    ? reusedIds.map((id) => ({ id }))
    : await owner.db
        .insert(schema.employment)
        .values(
          plan.map((kind, i) => ({
            tenantId: b.tenantId,
            personId: people[i].id,
            companyId: b.companyId,
            hiredOn: '2020-01-01',
            paymentMethod: (kind === 'cash-no-bank' ? 'cash' : 'bank_transfer') as 'cash' | 'bank_transfer',
          })),
        )
        .returning({ id: schema.employment.id });

  // Statutory profiles for everyone EXCEPT the two no-bank cohorts, so the bank/tax detectors have
  // something real to find.
  if (!reusedIds) {
    const withProfile = plan
      .map((kind, i) => ({ kind, personId: people[i].id }))
      .filter((x) => x.kind !== 'no-bank' && x.kind !== 'cash-no-bank');
    await owner.db.insert(schema.employeeStatutoryMy).values(
      withProfile.map((x) => ({
        tenantId: b.tenantId,
        personId: x.personId,
        bankName: 'Maybank',
        bankAccountNo: '1234567890',
      })),
    );
  }

  // Attendance for everyone except the planted ghosts.
  const attendees = plan.map((kind, i) => ({ kind, id: employments[i].id })).filter((x) => x.kind !== 'ghost');
  await owner.db.insert(schema.attendance).values(
    attendees.map((x) => ({
      tenantId: b.tenantId,
      employmentId: x.id,
      attendanceDate: `${period}-04`,
      workedMinutes: 480,
    })),
  );

  const netFor = (kind: Planted) => (kind === 'negative-net' ? '-150.00' : kind === 'zero-net' ? '0.00' : '4200.00');
  const dedFor = (kind: Planted) => (kind === 'negative-net' ? '5150.00' : kind === 'zero-net' ? '5000.00' : '800.00');
  await owner.db.insert(schema.payslip).values(
    plan.map((kind, i) => ({
      tenantId: b.tenantId,
      batchId: batch.id,
      employmentId: employments[i].id,
      basicSalary: '5000.00',
      grossPay: '5000.00',
      totalDeductions: dedFor(kind),
      netPay: netFor(kind),
      employerCost: '5700.00',
      daysWorked: '31.00',
      statutory: { epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 215 },
    })),
  );

  const truth = new Map<string, Planted>();
  plan.forEach((kind, i) => truth.set(employments[i].id, kind));
  return { batchId: batch.id, truth };
}

describe('ADR-0076 §6.1 — the synthetic harness, against ground truth', () => {
  it('finds every planted fault and flags no clean employee', async () => {
    const { batchId, truth } = await buildPopulation('2026-05');

    const started = Date.now();
    const run = await evaluateBatchAnomalies(a, { batchId });
    const ms = Date.now() - started;
    console.log(`[harness] ${POPULATION} employees evaluated in ${ms}ms (reported, not asserted)`);

    expect(run.total).toBe(POPULATION);

    const rows = await owner.db
      .select({
        employmentId: schema.payrollAnomalyVerdict.employmentId,
        disposition: schema.payrollAnomalyVerdict.disposition,
        id: schema.payrollAnomalyVerdict.id,
      })
      .from(schema.payrollAnomalyVerdict)
      .where(
        and(eq(schema.payrollAnomalyVerdict.batchId, batchId), isNull(schema.payrollAnomalyVerdict.supersededAt)),
      );
    expect(rows).toHaveLength(POPULATION);

    const findings = await owner.db
      .select({
        verdictId: schema.payrollAnomalyFinding.verdictId,
        detectorId: schema.payrollAnomalyFinding.detectorId,
      })
      .from(schema.payrollAnomalyFinding);
    const detectorsByVerdict = new Map<string, string[]>();
    for (const f of findings) {
      const list = detectorsByVerdict.get(f.verdictId) ?? [];
      list.push(f.detectorId);
      detectorsByVerdict.set(f.verdictId, list);
    }

    /** What each planted fault MUST produce, and — for the two controls — must not. */
    const expected: Record<Planted, { disposition: string; must: string[]; mustNot: string[] }> = {
      clean: { disposition: 'auto_clear', must: [], mustNot: [] },
      'negative-net': { disposition: 'block', must: ['negative-net'], mustNot: [] },
      'zero-net': { disposition: 'review', must: ['zero-net-with-pay'], mustNot: ['negative-net'] },
      'no-bank': { disposition: 'block', must: ['missing-bank-profile', 'missing-tax-profile'], mustNot: [] },
      // THE CONTROL THAT MATTERS MOST: a cash-paid employee with no bank details is NOT an anomaly.
      // Without the payment-method gate this cohort would block, and on a deskless workforce that is
      // most of the population.
      'cash-no-bank': { disposition: 'review', must: ['missing-tax-profile'], mustNot: ['missing-bank-profile'] },
      ghost: { disposition: 'review', must: ['pay-without-attendance'], mustNot: [] },
    };

    const seen: Record<string, number> = {};
    for (const row of rows) {
      const kind = truth.get(row.employmentId)!;
      seen[kind] = (seen[kind] ?? 0) + 1;
      const got = detectorsByVerdict.get(row.id) ?? [];
      const want = expected[kind];
      expect(row.disposition, `${kind} disposition`).toBe(want.disposition);
      for (const d of want.must) expect(got, `${kind} must include ${d}`).toContain(d);
      for (const d of want.mustNot) expect(got, `${kind} must NOT include ${d}`).not.toContain(d);
    }

    // Every cohort was actually exercised — a distribution that silently produced zero of a kind would
    // make the assertions above vacuous for it.
    for (const kind of Object.keys(expected) as Planted[]) {
      expect(seen[kind] ?? 0, `${kind} cohort is empty`).toBeGreaterThan(0);
    }

    // And the aggregate matches the plan exactly: no clean employee was flagged.
    const cleanCount = [...truth.values()].filter((k) => k === 'clean').length;
    expect(run.autoClear).toBe(cleanCount);
    expect(run.block + run.review).toBe(POPULATION - cleanCount);
  });

  it('coverage RISES to 100% on the second cycle, once the prior-period detectors can run', async () => {
    const first = await buildPopulation('2026-04');
    const { batchId } = await buildPopulation('2026-05', first.truth);

    const run = await evaluateBatchAnomalies(a, { batchId });
    const m = await anomalyMetrics(a, { batchId });

    // Cycle two: every detector has the history it declared, so nothing is skipped. This is the coverage
    // mechanism doing its job in the direction that matters — it went UP because more checks became
    // possible, not because anything was hidden.
    expect(m.coverage).toBe(1);
    expect(run.verdicts.every((v) => v.detectorsSkipped.length === 0)).toBe(true);
  });

  it('a second identical cycle produces no prior-period noise — stability is the baseline', async () => {
    const first = await buildPopulation('2026-04');
    const { batchId, truth } = await buildPopulation('2026-05', first.truth);
    await evaluateBatchAnomalies(a, { batchId });

    const rows = await owner.db
      .select({
        id: schema.payrollAnomalyVerdict.id,
        employmentId: schema.payrollAnomalyVerdict.employmentId,
      })
      .from(schema.payrollAnomalyVerdict)
      .where(
        and(eq(schema.payrollAnomalyVerdict.batchId, batchId), isNull(schema.payrollAnomalyVerdict.supersededAt)),
      );
    const findings = await owner.db
      .select({ verdictId: schema.payrollAnomalyFinding.verdictId, detectorId: schema.payrollAnomalyFinding.detectorId })
      .from(schema.payrollAnomalyFinding);
    const byVerdict = new Map<string, string[]>();
    for (const f of findings) byVerdict.set(f.verdictId, [...(byVerdict.get(f.verdictId) ?? []), f.detectorId]);

    // The SAME people, paid the SAME figures, two cycles running. Nothing moved, so the three delta
    // detectors must find nothing — this is the false-positive floor for the prior-period family, and
    // the one that would bury an operator in noise every single month if it were wrong.
    for (const row of rows) {
      if (truth.get(row.employmentId) !== 'clean') continue;
      const got = byVerdict.get(row.id) ?? [];
      for (const noisy of ['net-swing', 'component-appeared', 'component-vanished']) {
        expect(got, `clean employee should not trip ${noisy}`).not.toContain(noisy);
      }
    }
  });
});
