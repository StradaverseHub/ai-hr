/**
 * ADR-0084 §2.4 / Phase 3 item 6 — RECURRENCE MINING.
 *
 * Two things here are worth more than the arithmetic, and both are ways of being WRONG that would look
 * like success on the Control Tower:
 *
 *  1. **A recurrence must reverse a CLOSURE and never a HYPOTHESIS.** A closure claimed the cause was
 *     gone, so the finding coming back falsifies it. A hypothesis claimed there might be a problem, so
 *     the problem coming back CONFIRMS it. Reversing the second would record a correct model as wrong,
 *     and §2.8 reads these rates to decide autonomy — so the bug would teach the system to stop raising
 *     hypotheses that were true. Nothing else in the suite would notice.
 *
 *  2. **"Not yet testable" must never be counted as "held".** A closure whose employee has not been paid
 *     since proves nothing. Folding those into the success column is the flattering direction, and it is
 *     the same failure r248 caught in the reversal rate itself.
 *
 * The fixtures are built with direct inserts rather than by running payroll: this module reads verdicts,
 * findings, batches and proposals, and constructing those directly is what makes "the detector came back
 * in the NEXT cycle but not the one after" expressible at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { recordProposal } from '../core/agent-proposal';
import { classifyClosures, mineClosureRecurrences } from '../core/recurrence-mining';

describe('ADR-0084 item 6 — recurrence mining', () => {
  let base: Base;
  let seq = 0;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    seq = 0;
  });
  afterAll(async () => {
    await closeAll();
  });

  /** A processed batch for one pay period. */
  async function batchFor(period: string): Promise<string> {
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: base.tenantId, companyId: base.companyId, period, status: 'open' } as never)
      .returning({ id: schema.payPeriod.id });
    const [b] = await owner.db
      .insert(schema.payrollBatch)
      .values({
        tenantId: base.tenantId,
        companyId: base.companyId,
        payPeriodId: pp!.id,
        payPeriod: period,
        batchDate: `${period}-28`,
        status: 'processed',
        employeeCount: 1,
      } as never)
      .returning({ id: schema.payrollBatch.id });
    return b!.id;
  }

  async function anEmployee(): Promise<string> {
    seq++;
    const e = await hireEmployee(adminCtx(base), {
      person: { fullName: `Recur ${seq}`, primaryEmail: `recur.${seq}@aa.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      paymentMethod: 'bank_transfer',
    } as never);
    return e.employmentId;
  }

  /** A live verdict with `detectors` findings on it. `detectors: []` is a clean run. */
  async function verdict(batchId: string, employmentId: string, detectors: string[]): Promise<string> {
    const [v] = await owner.db
      .insert(schema.payrollAnomalyVerdict)
      .values({
        tenantId: base.tenantId,
        batchId,
        employmentId,
        disposition: detectors.length ? 'block' : 'auto_clear',
        detectorsRun: detectors,
        detectorsSkipped: [],
      } as never)
      .returning({ id: schema.payrollAnomalyVerdict.id });
    for (const d of detectors) {
      await owner.db.insert(schema.payrollAnomalyFinding).values({
        tenantId: base.tenantId,
        verdictId: v!.id,
        detectorId: d,
        severity: 'block',
        facts: {},
        sourceEventIds: [],
        suggestedAction: 'anomaly.action.missingBankProfile',
      } as never);
    }
    return v!.id;
  }

  /** An APPROVED close_fixed_upstream proposal against a verdict — what the action layer writes. */
  const closure = (verdictId: string) =>
    recordProposal(adminCtx(base), {
      type: 'close_fixed_upstream',
      subject: { type: 'payroll_anomaly_verdict', id: verdictId },
      facts: { verdictId },
      proposal: { action: 'close_fixed_upstream' },
      adjudication: { ok: true },
      decision: 'approved',
    });

  const reversalOf = async (proposalId: string) => {
    const [row] = await owner.db
      .select({
        reversedAt: schema.agentProposal.reversedAt,
        reason: schema.agentProposal.reversalReason,
      })
      .from(schema.agentProposal)
      .where(eq(schema.agentProposal.id, proposalId));
    return row;
  };

  it('reverses a closure whose finding came back at the next payroll, and says which one', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const jun = await batchFor('2026-06');

    const closed = await verdict(may, emp, ['missing-bank-profile']);
    const proposalId = (await closure(closed))!;
    await verdict(jun, emp, ['missing-bank-profile']); // came straight back

    const r = await mineClosureRecurrences(adminCtx(base));

    expect(r).toMatchObject({ checked: 1, reversed: 1, held: 0, pending: 0 });
    const row = await reversalOf(proposalId);
    expect(row!.reversedAt).not.toBeNull();
    // The reason has to carry WHICH check and WHEN — a bare "reversed" is not actionable.
    expect(row!.reason).toBe('recurred_at_2026-06:missing-bank-profile');
  });

  it('leaves a closure alone when the next payroll was clean — silence is the record of a fix that worked', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const jun = await batchFor('2026-06');

    const closed = await verdict(may, emp, ['missing-bank-profile']);
    const proposalId = (await closure(closed))!;
    await verdict(jun, emp, []); // clean

    const r = await mineClosureRecurrences(adminCtx(base));

    expect(r).toMatchObject({ checked: 1, reversed: 0, held: 1, pending: 0 });
    expect((await reversalOf(proposalId))!.reversedAt).toBeNull();
  });

  it('counts a closure whose employee has not been paid since as PENDING, never as held', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const closed = await verdict(may, emp, ['missing-bank-profile']);
    const proposalId = (await closure(closed))!;

    const r = await mineClosureRecurrences(adminCtx(base));

    // THE ASSERTION THAT KEEPS THE REVERSAL RATE HONEST. A fix nobody has tested is not a fix that
    // worked, and `held` is what the Control Tower reads to decide the rate has a real denominator.
    expect(r).toMatchObject({ checked: 1, reversed: 0, held: 0, pending: 1 });
    expect((await reversalOf(proposalId))!.reversedAt).toBeNull();
  });

  it('judges the NEXT appearance only — a clean next cycle is a fix that held, even if it breaks later', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const jun = await batchFor('2026-06');
    const jul = await batchFor('2026-07');

    const closed = await verdict(may, emp, ['missing-bank-profile']);
    const proposalId = (await closure(closed))!;
    await verdict(jun, emp, []); // held
    await verdict(jul, emp, ['missing-bank-profile']); // a LATER regression, not a failed fix

    const r = await mineClosureRecurrences(adminCtx(base));

    expect(r).toMatchObject({ reversed: 0, held: 1 });
    expect((await reversalOf(proposalId))!.reversedAt).toBeNull();
  });

  it('ignores a DIFFERENT detector firing next cycle — that is a new problem, not the same one', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const jun = await batchFor('2026-06');

    const closed = await verdict(may, emp, ['missing-bank-profile']);
    const proposalId = (await closure(closed))!;
    await verdict(jun, emp, ['missing-tax-profile']);

    const r = await mineClosureRecurrences(adminCtx(base));

    expect(r).toMatchObject({ reversed: 0, held: 1 });
    expect((await reversalOf(proposalId))!.reversedAt).toBeNull();
  });

  it('NEVER reverses a hypothesis whose problem recurred — recurrence confirms it, it does not falsify it', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const jun = await batchFor('2026-06');

    const flagged = await verdict(may, emp, ['pay-without-attendance']);
    // A hypothesis proposal against the same verdict, approved by an operator who agreed it was real.
    const hypothesisId = (await recordProposal(adminCtx(base), {
      type: 'anomaly_hypothesis',
      subject: { type: 'payroll_anomaly_verdict', id: flagged },
      facts: { verdictId: flagged },
      proposal: { detector: 'pay-without-attendance' },
      adjudication: { ok: true },
      decision: 'approved',
    }))!;
    await verdict(jun, emp, ['pay-without-attendance']); // the problem came back

    const r = await mineClosureRecurrences(adminCtx(base));

    // Nothing to check: the only candidate type is close_fixed_upstream.
    expect(r).toMatchObject({ checked: 0, reversed: 0 });
    expect((await reversalOf(hypothesisId))!.reversedAt).toBeNull();
  });

  it('is idempotent — a second pass writes nothing, because a reversed closure leaves the candidate set', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const jun = await batchFor('2026-06');
    const closed = await verdict(may, emp, ['missing-bank-profile']);
    await closure(closed);
    await verdict(jun, emp, ['missing-bank-profile']);

    const first = await mineClosureRecurrences(adminCtx(base));
    const second = await mineClosureRecurrences(adminCtx(base));

    expect(first.reversed).toBe(1);
    expect(second).toMatchObject({ checked: 0, reversed: 0 });
  });

  it('skips a closure whose verdict was superseded — a re-run makes the closure moot, not wrong', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const jun = await batchFor('2026-06');
    const closed = await verdict(may, emp, ['missing-bank-profile']);
    const proposalId = (await closure(closed))!;
    await verdict(jun, emp, ['missing-bank-profile']);

    await owner.db
      .update(schema.payrollAnomalyVerdict)
      .set({ supersededAt: new Date() })
      .where(eq(schema.payrollAnomalyVerdict.id, closed));

    const r = await mineClosureRecurrences(adminCtx(base));

    expect(r).toMatchObject({ checked: 0, reversed: 0 });
    expect((await reversalOf(proposalId))!.reversedAt).toBeNull();
  });

  it('classifyClosures reads without writing — the sweep is the only writer', async () => {
    const emp = await anEmployee();
    const may = await batchFor('2026-05');
    const jun = await batchFor('2026-06');
    const closed = await verdict(may, emp, ['missing-bank-profile']);
    const proposalId = (await closure(closed))!;
    await verdict(jun, emp, ['missing-bank-profile']);

    const outcomes = await classifyClosures(adminCtx(base));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'recurred', nextPeriod: '2026-06' });
    // The Control Tower calls this on every page render. If it wrote, viewing the screen would change
    // the data it reports.
    expect((await reversalOf(proposalId))!.reversedAt).toBeNull();
  });
});
