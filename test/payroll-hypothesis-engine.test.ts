/**
 * ADR-0084 §2.6 — the hypothesis layer against a real database. The pure half (features, materiality,
 * adjudication, the ceiling) is in `test/payroll-hypothesis.test.ts` with no database at all.
 *
 * NO PROVIDER IS CONFIGURED IN ANY TEST HERE, AND THAT IS THE POINT RATHER THAN A LIMITATION. Everything
 * this file proves is a property of the DETERMINISTIC half — who is a candidate, what is written, what is
 * NOT written, and what a human's answer does to the ledger — and every one of those must hold whatever a
 * model says. The one path that needs an answer from a model is exercised by seeding the ledger with the
 * answer, which is also how the layer behaves on the second night: `input_digest` is the identity, so a
 * pre-existing row for the same figures IS the model's answer.
 *
 * THE FIXTURE IS THE WHOLE ARGUMENT FOR THIS LAYER EXISTING. Twelve people move up 6% together and one
 * stays flat. Not one of the eleven detectors says a word — `net-swing` wants 30%, and every other check
 * is a presence test that passes. The run auto-clears 13 of 13, and the thirteenth is the miss.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { digestOf } from '../core/agent-proposal';
import { evaluateBatchAnomalies, loadBatchContexts, resolveAnomalyVerdict } from '../core/payroll-anomaly';
import { HYPOTHESIS_DETECTOR_ID } from '../core/payroll-anomaly-detectors';
import { MAX_HYPOTHESES_PER_RUN, buildFeatures, proposeHypotheses } from '../core/payroll-hypothesis';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setSetting, type Base } from './harness';
import type { SessionContext } from '../db/client';

const PRIOR = '2026-04';
const PERIOD = '2026-05';
/** Twelve peers plus the odd one out — comfortably over MIN_COHORT, and enough for a real median. */
const PEERS = 12;

let b: Base;
let a: SessionContext;

async function makeEmp(name: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({
      tenantId: b.tenantId,
      personId: p.id,
      companyId: b.companyId,
      hiredOn: '2020-01-01',
      paymentMethod: 'bank_transfer',
    })
    .returning({ id: schema.employment.id });
  // A complete statutory profile, so `missing-bank-profile` and `missing-tax-profile` stay silent and
  // the verdict really is an AUTO-CLEAR rather than a flag this layer would then skip.
  await owner.db.insert(schema.employeeStatutoryMy).values({
    tenantId: b.tenantId,
    personId: p.id,
    bankName: 'Maybank',
    bankAccountNo: '1234567890',
  });
  return e.id;
}

async function makeBatch(period: string) {
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
  return batch.id;
}

/**
 * One clean payslip, scaled by `k` from a 5,000 baseline.
 *
 * EVERY COMPONENT SCALES TOGETHER, deliberately. If deductions or the statutory blob held still while
 * gross moved, their SHARES would move too and the odd one out would become material on four features
 * instead of one — the test would still pass and would no longer be testing what it says it tests.
 */
async function addPayslip(batchId: string, employmentId: string, period: string, k: number) {
  const days = period === PRIOR ? '30.00' : '31.00';
  await owner.db.insert(schema.attendance).values({
    tenantId: b.tenantId,
    employmentId,
    attendanceDate: `${period}-04`,
    workedMinutes: 480,
  });
  const m = (n: number) => (n * k).toFixed(2);
  await owner.db.insert(schema.payslip).values({
    tenantId: b.tenantId,
    batchId,
    employmentId,
    basicSalary: m(5000),
    grossPay: m(5000),
    totalDeductions: m(800),
    netPay: m(4200),
    employerCost: m(5700),
    daysWorked: days,
    statutory: { epfEmployee: 550 * k, socsoEmployee: 24.75 * k, eisEmployee: 9.9 * k, pcb: 215 * k },
  });
}

/** The run this whole layer exists for: everybody up 6%, one person flat, and no rule says anything. */
async function seedRun(): Promise<{ batchId: string; oddId: string; peerId: string }> {
  const prior = await makeBatch(PRIOR);
  const current = await makeBatch(PERIOD);
  const ids: string[] = [];
  for (let i = 0; i < PEERS; i++) ids.push(await makeEmp(`peer${i}`));
  const oddId = await makeEmp('odd');
  for (const id of ids) {
    await addPayslip(prior, id, PRIOR, 1);
    await addPayslip(current, id, PERIOD, 1.06);
  }
  await addPayslip(prior, oddId, PRIOR, 1);
  await addPayslip(current, oddId, PERIOD, 1);
  return { batchId: current, oddId, peerId: ids[0] };
}

/**
 * The same run, built in BULK, for the one case that needs a crowd: the blast-radius cap.
 *
 * ⚠️ THE PROPORTIONS ARE NOT ARBITRARY AND CANNOT BE TIGHTENED. A robust z-score is scale-invariant, so
 * how FAR the outliers moved changes nothing — only how MANY of them there are. With k outliers in n
 * people the outlier's z is about sqrt(n/k), so clearing `Z_MATERIAL` (1.5) needs n ≥ 2.25k. Twenty-six
 * candidates therefore need a run of eighty, not of thirty. That is a property of the statistic and it is
 * worth knowing before writing any other fixture for this layer.
 */
async function seedCrowd(flat: number, movers: number) {
  const prior = await makeBatch(PRIOR);
  const current = await makeBatch(PERIOD);
  const n = flat + movers;
  const people = await owner.db
    .insert(schema.person)
    .values(
      Array.from({ length: n }, (_, i) => ({
        tenantId: b.tenantId,
        fullName: `crowd${i}`,
        primaryEmail: `crowd${i}_${randomUUID()}@t.local`,
      })),
    )
    .returning({ id: schema.person.id });
  const emps = await owner.db
    .insert(schema.employment)
    .values(
      people.map((p) => ({
        tenantId: b.tenantId,
        personId: p.id,
        companyId: b.companyId,
        hiredOn: '2020-01-01',
        paymentMethod: 'bank_transfer' as const,
      })),
    )
    .returning({ id: schema.employment.id });
  await owner.db.insert(schema.employeeStatutoryMy).values(
    people.map((p) => ({ tenantId: b.tenantId, personId: p.id, bankName: 'Maybank', bankAccountNo: '1234567890' })),
  );

  const slip = (batchId: string, employmentId: string, period: string, k: number) => {
    const m = (x: number) => (x * k).toFixed(2);
    return {
      tenantId: b.tenantId,
      batchId,
      employmentId,
      basicSalary: m(5000),
      grossPay: m(5000),
      totalDeductions: m(800),
      netPay: m(4200),
      employerCost: m(5700),
      daysWorked: period === PRIOR ? '30.00' : '31.00',
      statutory: { epfEmployee: 550 * k, socsoEmployee: 24.75 * k, eisEmployee: 9.9 * k, pcb: 215 * k },
    };
  };
  await owner.db.insert(schema.attendance).values(
    emps.flatMap((e) => [PRIOR, PERIOD].map((period) => ({
      tenantId: b.tenantId,
      employmentId: e.id,
      attendanceDate: `${period}-04`,
      workedMinutes: 480,
    }))),
  );
  await owner.db.insert(schema.payslip).values([
    ...emps.map((e) => slip(prior, e.id, PRIOR, 1)),
    ...emps.map((e, i) => slip(current, e.id, PERIOD, i < flat ? 1 : 1.06)),
  ]);
  return { batchId: current, flatIds: emps.slice(0, flat).map((e) => e.id) };
}

const findingsOn = (verdictId: string) =>
  owner.db
    .select()
    .from(schema.payrollAnomalyFinding)
    .where(eq(schema.payrollAnomalyFinding.verdictId, verdictId));

const liveVerdict = async (batchId: string, employmentId: string) => {
  const [v] = await owner.db
    .select()
    .from(schema.payrollAnomalyVerdict)
    .where(
      and(
        eq(schema.payrollAnomalyVerdict.batchId, batchId),
        eq(schema.payrollAnomalyVerdict.employmentId, employmentId),
        isNull(schema.payrollAnomalyVerdict.supersededAt),
      ),
    );
  return v;
};

const proposals = () => owner.db.select().from(schema.agentProposal);

/** The digest the layer will compute for one person — the ledger's definition of "the same question". */
async function digestFor(batchId: string, employmentId: string) {
  const contexts = (await loadBatchContexts(a, { batchId }))!;
  const f = buildFeatures(contexts).get(employmentId)!;
  return digestOf({ employmentId, values: f.values, cohort: f.cohort });
}

/** Seed the ledger with an answer, which is exactly what the second night's run finds waiting. */
async function seedAnswer(
  employmentId: string,
  digest: string,
  over: Partial<typeof schema.agentProposal.$inferInsert> = {},
) {
  const [row] = await owner.db
    .insert(schema.agentProposal)
    .values({
      tenantId: b.tenantId,
      proposalType: 'anomaly_hypothesis',
      subjectType: 'employment',
      subjectId: employmentId,
      inputDigest: digest,
      proposal: { claim: 'missed_increment', evidence: ['netChangePctZ'] },
      adjudication: 'accepted',
      provider: 'anthropic',
      model: 'test-model',
      ...over,
    })
    .returning({ id: schema.agentProposal.id });
  return row.id;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
});

describe('the deterministic pass really is silent on this run', () => {
  it('auto-clears all thirteen — which is the miss this layer exists to catch', async () => {
    const { batchId } = await seedRun();
    const run = await evaluateBatchAnomalies(a, { batchId });
    expect(run.total).toBe(PEERS + 1);
    expect(run.autoClear, 'a rule that fires here would invalidate every case below').toBe(PEERS + 1);
    expect(run.review).toBe(0);
    expect(run.block).toBe(0);
  });
});

describe('the tenant switch is the kill switch', () => {
  it('does nothing at all when the tenant has not switched it on', async () => {
    const { batchId } = await seedRun();
    await evaluateBatchAnomalies(a, { batchId });

    const run = await proposeHypotheses(a, { batchId });
    expect(run.disabled).toBe(true);
    expect(run.candidates).toBe(0);
    // Nothing proposed, nothing recorded, nothing spent. A default-off agent leaves no trace.
    expect(await proposals()).toHaveLength(0);
  });

  it('refuses a run too small to have a peer group, rather than reporting it clean', async () => {
    await setSetting(b.tenantId, 'payroll.anomaly_hypotheses_enabled', true);
    a = await entitledCtx(b);
    const prior = await makeBatch(PRIOR);
    const current = await makeBatch(PERIOD);
    for (let i = 0; i < 4; i++) {
      const id = await makeEmp(`few${i}`);
      await addPayslip(prior, id, PRIOR, 1);
      await addPayslip(current, id, PERIOD, 1);
    }
    await evaluateBatchAnomalies(a, { batchId: current });

    const run = await proposeHypotheses(a, { batchId: current });
    expect(run.cohortTooSmall).toBe(true);
    expect(run.candidates).toBe(0);
    expect(await proposals()).toHaveLength(0);
  });
});

describe('candidate selection is deterministic and needs no model', () => {
  beforeEach(async () => {
    await setSetting(b.tenantId, 'payroll.anomaly_hypotheses_enabled', true);
    a = await entitledCtx(b);
  });

  it('finds the one person out of step, records nothing without a provider, and writes no finding', async () => {
    const { batchId } = await seedRun();
    await evaluateBatchAnomalies(a, { batchId });

    const run = await proposeHypotheses(a, { batchId });
    expect(run.candidates, 'exactly the one who did not move').toBe(1);
    expect(run.notConfigured).toBe(true);
    expect(run.raised).toBe(0);
    // ⚠️ A TENANT WITH NO PROVIDER PROPOSED NOTHING, so nothing is recorded. Counting this as a model
    // failure would drag the adjudication-pass rate down while measuring the absence of a subscription.
    expect(await proposals()).toHaveLength(0);
  });

  it('never looks at somebody the rules already flagged — attribution depends on it', async () => {
    const { batchId, oddId } = await seedRun();
    await evaluateBatchAnomalies(a, { batchId });
    // Flag the odd one out by hand, exactly as a re-evaluation would.
    const v = await liveVerdict(batchId, oddId);
    await owner.db
      .update(schema.payrollAnomalyVerdict)
      .set({ disposition: 'review' })
      .where(eq(schema.payrollAnomalyVerdict.id, v.id));

    expect((await proposeHypotheses(a, { batchId })).candidates).toBe(0);
  });
});

describe('the ledger is the memory, and it is what makes a nightly re-ask free', () => {
  beforeEach(async () => {
    await setSetting(b.tenantId, 'payroll.anomaly_hypotheses_enabled', true);
    a = await entitledCtx(b);
  });

  it('re-materialises an earlier answer with no provider, and moves the verdict with the finding', async () => {
    const { batchId, oddId } = await seedRun();
    await evaluateBatchAnomalies(a, { batchId });
    const proposalId = await seedAnswer(oddId, await digestFor(batchId, oddId));

    const run = await proposeHypotheses(a, { batchId });
    expect(run.cached).toBe(1);
    expect(run.asked, 'an identical question must not be paid for twice').toBe(0);
    expect(run.raised).toBe(1);
    // No SECOND ledger row: it is the same proposal, re-used, not a new one.
    expect(await proposals()).toHaveLength(1);

    const v = await liveVerdict(batchId, oddId);
    // `resolveDisposition` says any review finding makes the verdict a review. A row left at auto_clear
    // while carrying one would be invisible on the queue, which splits on disposition.
    expect(v.disposition).toBe('review');
    const [finding] = await findingsOn(v.id);
    expect(finding.detectorId).toBe(HYPOTHESIS_DETECTOR_ID);
    expect(finding.severity, 'the ceiling — ADR-0084 §2.2').toBe('review');
    expect(finding.proposalId).toBe(proposalId);
    expect((finding.facts as Record<string, unknown>).claim).toBe('missed_increment');
  });

  it('does not raise the same hypothesis again once a human has called it a false positive', async () => {
    const { batchId, oddId } = await seedRun();
    await evaluateBatchAnomalies(a, { batchId });
    await seedAnswer(oddId, await digestFor(batchId, oddId), {
      decision: 'declined',
      decidedAt: new Date(),
    });

    const run = await proposeHypotheses(a, { batchId });
    expect(run.suppressed).toBe(1);
    expect(run.raised).toBe(0);
    expect((await liveVerdict(batchId, oddId)).disposition).toBe('auto_clear');
  });

  it('REFUSES at the blast-radius cap rather than truncating quietly', async () => {
    // Twenty-six candidates against a cap of twenty-five, every one of them answerable from the ledger so
    // the run is not stopped by the absence of a provider first. ADR-0083 §2.5: a blast-radius limit must
    // refuse and SAY SO — a pass that silently looks at a subset and reports a clean run is the
    // sample-treated-as-a-total failure r237's nudge sweep shipped a bug for.
    const { batchId, flatIds } = await seedCrowd(MAX_HYPOTHESES_PER_RUN + 1, 54);
    await evaluateBatchAnomalies(a, { batchId });

    const contexts = (await loadBatchContexts(a, { batchId }))!;
    const features = buildFeatures(contexts);
    for (const id of flatIds) {
      const f = features.get(id)!;
      await seedAnswer(id, digestOf({ employmentId: id, values: f.values, cohort: f.cohort }));
    }

    const run = await proposeHypotheses(a, { batchId });
    expect(run.candidates).toBe(MAX_HYPOTHESES_PER_RUN + 1);
    expect(run.cappedOut, 'the cap bit and the run says so').toBe(true);
    // Exactly the cap, not half of it: the counter is per CANDIDATE, and the overlapping outcome
    // counters (a cache hit that becomes a finding is both) must not be summed to decide it.
    expect(run.raised).toBe(MAX_HYPOTHESES_PER_RUN);
  });

  it('is idempotent within a night — a second pass adds no second finding', async () => {
    const { batchId, oddId } = await seedRun();
    await evaluateBatchAnomalies(a, { batchId });
    await seedAnswer(oddId, await digestFor(batchId, oddId));

    await proposeHypotheses(a, { batchId });
    const second = await proposeHypotheses(a, { batchId });
    expect(second.candidates, 'the verdict is a review now, so it is no longer a candidate').toBe(0);
    expect(await findingsOn((await liveVerdict(batchId, oddId)).id)).toHaveLength(1);
  });
});

describe("the human's verdict lands on the right ledger row", () => {
  beforeEach(async () => {
    await setSetting(b.tenantId, 'payroll.anomaly_hypotheses_enabled', true);
    a = await entitledCtx(b);
  });

  const raise = async () => {
    const { batchId, oddId } = await seedRun();
    await evaluateBatchAnomalies(a, { batchId });
    const proposalId = await seedAnswer(oddId, await digestFor(batchId, oddId));
    await proposeHypotheses(a, { batchId });
    return { batchId, oddId, proposalId, verdictId: (await liveVerdict(batchId, oddId)).id };
  };

  const decisionOf = async (id: string) => {
    const [row] = await owner.db.select().from(schema.agentProposal).where(eq(schema.agentProposal.id, id));
    return row.decision;
  };

  it('"not a real problem" is the model being wrong, and is recorded as declined', async () => {
    const { batchId, verdictId, proposalId } = await raise();
    await resolveAnomalyVerdict(a, { verdictId, resolution: 'false_positive' });
    expect(await decisionOf(proposalId)).toBe('declined');
    expect(batchId).toBeTruthy();
  });

  it('"fixed at the source" is the model being right, and is recorded as approved', async () => {
    const { verdictId, proposalId } = await raise();
    await resolveAnomalyVerdict(a, { verdictId, resolution: 'fixed_upstream' });
    expect(await decisionOf(proposalId)).toBe('approved');
  });

  it('refuses to attribute a resolution when the verdict also carries a rule finding', async () => {
    const { verdictId, proposalId } = await raise();
    // A second finding from a deterministic detector on the same verdict. Now "not a real problem" says
    // nothing about WHICH of the two the operator meant, and a misattributed agreement rate is worse
    // than a missing one — it is the number ADR-0084 §2.8 would grant autonomy on.
    await owner.db.insert(schema.payrollAnomalyFinding).values({
      tenantId: b.tenantId,
      verdictId,
      detectorId: 'net-swing',
      severity: 'review',
      facts: { movementPct: 40 },
      sourceEventIds: [],
      suggestedAction: 'anomaly.action.netSwing',
    });

    await resolveAnomalyVerdict(a, { verdictId, resolution: 'false_positive' });
    expect(await decisionOf(proposalId), 'left undecided rather than guessed').toBeNull();
  });

  it('the first human answer is the one that counts', async () => {
    const { verdictId, proposalId } = await raise();
    await resolveAnomalyVerdict(a, { verdictId, resolution: 'false_positive' });
    // A verdict cannot be resolved twice through the UI, but a re-materialised copy on a later run can
    // be — and the ledger row must keep the answer it already has.
    await owner.db
      .update(schema.payrollAnomalyVerdict)
      .set({ resolvedAt: null, resolution: null })
      .where(eq(schema.payrollAnomalyVerdict.id, verdictId));
    await resolveAnomalyVerdict(a, { verdictId, resolution: 'accepted' });
    expect(await decisionOf(proposalId)).toBe('declined');
  });
});
