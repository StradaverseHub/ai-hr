/**
 * ADR-0084 Phase 3 item 5 — AGREEMENT MEASUREMENT, AND THE ZERO IT MUST NEVER PRINT.
 *
 * `proposalRates` already returns null for every rate whose denominator is zero, and its header says a
 * caller "must render the null as 'not measured yet', not as a zero". `agreementView` is that caller's
 * source, so the case worth guarding hardest is not the arithmetic — it is that a null survives the trip
 * to the screen intact.
 *
 * WHY THAT IS THE CASE MOST WORTH PINNING, in the same terms test/control-tower.test.ts uses for
 * `impliedOperators`: "0% agreement" is a claim that the AI is wrong every single time. It would be read
 * as a measurement, it is really an empty denominator, and the difference is invisible in any test that
 * only checks the number rendered. The ADR names this exact failure — "a rate rendered before there is
 * data to render is the 'tune the thresholds' mistake in a new coat".
 *
 * The blockers are asserted individually, each with the others satisfied where that is possible, so a
 * change that collapses them into one condition fails here rather than passing because some other
 * blocker still fired.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { recordDecision, recordProposal } from '../core/agent-proposal';
import { agreementView } from '../core/control-tower';

describe('ADR-0084 item 5 — agreement measurement', () => {
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

  /** One accepted proposal of a given type. Returns the ledger id so a decision can be stamped on it. */
  const propose = (b: Base, type: 'pay_rule_draft' | 'report_spec', facts: Record<string, unknown>) =>
    recordProposal(adminCtx(b), {
      type,
      facts,
      proposal: { shape: 'whatever' },
      adjudication: { ok: true },
    });

  it('refuses to measure, and names every reason, on a tenant where nothing is switched on', async () => {
    const v = await agreementView(adminCtx(base));

    expect(v.rates).toEqual([]);
    expect(v.proposals).toBe(0);
    // The seeded tenant has no AI provider row and no agent setting, which is production's state too.
    expect(v.blockedBy).toContain('no_provider');
    expect(v.blockedBy).toContain('no_agent_on');
    expect(v.blockedBy).toContain('nothing_proposed');
    // Causal order: a tenant with no provider also has no proposals, and telling them "nothing proposed"
    // first sends them looking in the wrong place.
    expect(v.blockedBy.indexOf('no_provider')).toBeLessThan(v.blockedBy.indexOf('nothing_proposed'));
  });

  it('reports a NULL agreement rate — never 0 — while proposals exist that nobody has decided', async () => {
    await propose(base, 'pay_rule_draft', { a: 1 });
    await propose(base, 'pay_rule_draft', { a: 2 });

    const v = await agreementView(adminCtx(base));
    const row = v.rates.find((r) => r.type === 'pay_rule_draft');

    expect(row).toBeDefined();
    expect(row!.total).toBe(2);
    // THE ASSERTION THIS FILE EXISTS FOR. Two proposals, zero decisions: agreement is UNMEASURED.
    // `toBeNull` rather than `toBeFalsy` on purpose — 0 is falsy and 0 is the bug.
    expect(row!.agreementRate).toBeNull();
    expect(row!.reversalRate).toBeNull();
    // Adjudication, by contrast, IS measured: both were accepted, so this one is a real 1.
    expect(row!.adjudicationPassRate).toBe(1);

    // And the view says which gap this is. "Nothing proposed" and "nothing decided" are different
    // states — the proposers are working in the second one — and they get different sentences.
    expect(v.proposals).toBe(2);
    expect(v.blockedBy).not.toContain('nothing_proposed');
    expect(v.blockedBy).toContain('nothing_decided');
  });

  it('starts measuring agreement once a human decides, and still blanks reversal for a type with no writer', async () => {
    const approved = await propose(base, 'pay_rule_draft', { a: 1 });
    const declined = await propose(base, 'pay_rule_draft', { a: 2 });
    await propose(base, 'pay_rule_draft', { a: 3 }); // undecided — must not count either way

    await recordDecision(adminCtx(base), { proposalId: approved, decision: 'approved' });
    await recordDecision(adminCtx(base), { proposalId: declined, decision: 'declined' });

    const v = await agreementView(adminCtx(base));
    const row = v.rates.find((r) => r.type === 'pay_rule_draft')!;

    expect(row.total).toBe(3);
    // approved ÷ (approved + declined) — the undecided one is NOT in the denominator. Counting it would
    // dilute agreement with proposals nobody has looked at yet.
    expect(row.agreementRate).toBe(0.5);
    // ⚠️ NULL, AND THIS ONE IS NOT THE EMPTY-DENOMINATOR CASE. One proposal IS approved, so
    // `proposalRates` computes a real 0 here; the view blanks it. r249 gave reversals a writer
    // (core/recurrence-mining.ts) but ONLY for `close_fixed_upstream` — a `pay_rule_draft` reversal is
    // still structurally impossible, so a 0 here would still mean "every approval stuck" when it really
    // means "nothing can notice that one did not". Blanking is per type for exactly this reason.
    expect(row.reversalRate).toBeNull();
    expect(v.blockedBy).not.toContain('nothing_decided');
  });

  it('keeps the rates per proposal type rather than pooling them', async () => {
    // §2.8's autonomy criterion is per proposal type. A pooled rate would let a chatty accurate type
    // carry a rare inaccurate one over the line.
    const a = await propose(base, 'pay_rule_draft', { a: 1 });
    await recordDecision(adminCtx(base), { proposalId: a, decision: 'approved' });
    await propose(base, 'report_spec', { b: 1 });

    const v = await agreementView(adminCtx(base));

    expect(v.rates.map((r) => r.type).sort()).toEqual(['pay_rule_draft', 'report_spec']);
    expect(v.rates.find((r) => r.type === 'pay_rule_draft')!.agreementRate).toBe(1);
    // The second type has a proposal but no decision, so it is unmeasured while the first is measured.
    expect(v.rates.find((r) => r.type === 'report_spec')!.agreementRate).toBeNull();
  });
});
