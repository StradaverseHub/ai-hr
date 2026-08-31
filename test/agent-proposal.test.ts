/**
 * ADR-0084 §2.3 / §2.4 — THE PROPOSAL LEDGER.
 *
 * This table exists to make the system's own accuracy a measurable quantity, so the properties worth
 * pinning are the ones whose failure would make the MEASUREMENT wrong while everything still looked fine:
 *
 *  1. **THE THREE VERDICTS CANNOT BE COLLAPSED.** `adjudication` (machine), `decision` (human) and
 *     `reversedAt` (later reality) are three different truths, and 0452's CHECKs make the ordering
 *     structural rather than a convention. A rejected proposal never reached a human, so it may not carry
 *     a decision; a reversal is meaningless on something never approved. Asserted against the real
 *     database, because a TypeScript type cannot stop a hand-written backfill.
 *  2. **RECORDING SURVIVES THE CALLER'S FAILURE.** A rejection almost always happens inside an operation
 *     that then aborts. If the row rolled back with it, the ledger would contain successes only and the
 *     adjudication-pass rate would be structurally 100% — the exact opposite of what it is for.
 *  3. **RECORDING NEVER THROWS INTO THE CALLER.** Measurement is never worth breaking the feature it
 *     measures.
 *  4. **A RATE WITH NO DENOMINATOR IS `null`, NEVER 0.** Printing "0% agreement" because nothing has been
 *     decided is a lie about accuracy — the same discipline `impliedOperators` applies in the tower.
 *  5. **READ IS ADMIN-ONLY, INSERT IS NOT.** The split is the design (0452): a tenant-wide read would let
 *     any employee enumerate what the system proposes about colleagues, and an admin-only INSERT would
 *     silently match zero rows for the system and employee-session proposers ADR-0084 §2.5/§2.7 bring.
 *  6. **`DELETE` IS REVOKED.** An accuracy figure whose unflattering rows can be tidied away is not an
 *     accuracy figure. Nothing but this file catches a dropped REVOKE — every cluster bootstrapped via
 *     `deploy/bootstrap-db.sql` grants ai_hr_app full CRUD by default (0451's lesson).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import {
  digestOf,
  proposalRates,
  recordDecision,
  recordProposal,
  recordReversal,
} from '../core/agent-proposal';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('ADR-0084 — the proposal ledger', () => {
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

  const rowsOf = () =>
    owner.db
      .select({
        id: schema.agentProposal.id,
        type: schema.agentProposal.proposalType,
        adjudication: schema.agentProposal.adjudication,
        reason: schema.agentProposal.adjudicationReason,
        decision: schema.agentProposal.decision,
        digest: schema.agentProposal.inputDigest,
        provider: schema.agentProposal.provider,
      })
      .from(schema.agentProposal);

  it('digests the facts order-independently, and never stores them', async () => {
    // The digest is what makes identical inputs comparable across time and model versions. Key order is
    // an artefact of how an object was built and must not change the answer.
    expect(digestOf({ a: 1, b: { c: 2, d: 3 } })).toBe(digestOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));

    await recordProposal(adminCtx(base), {
      type: 'pay_rule_draft',
      facts: { secret: 'employee-name-that-must-not-be-stored' },
      proposal: { ruleKind: 'fixed' },
      adjudication: { ok: true },
    });
    const [row] = await rowsOf();
    expect(row!.digest).not.toContain('employee-name');
    expect(row!.digest).toHaveLength(32);
  });

  it('records an accepted proposal with no decision and no reason', async () => {
    await recordProposal(adminCtx(base), {
      type: 'anomaly_narration',
      facts: { delta: 820 },
      proposal: { prose: 'Pay moved by 820.' },
      adjudication: { ok: true },
      provider: 'anthropic',
      model: 'claude-x',
    });
    const [row] = await rowsOf();
    expect(row).toMatchObject({
      type: 'anomaly_narration',
      adjudication: 'accepted',
      reason: null,
      // Nobody approves prose — this type can never carry a human decision (see proposalRates below).
      decision: null,
      provider: 'anthropic',
    });
  });

  it('records a REJECTION, which is the half that makes the pass rate mean anything', async () => {
    await recordProposal(adminCtx(base), {
      type: 'anomaly_narration',
      facts: { delta: 820 },
      proposal: { prose: 'Pay moved by 999.' },
      adjudication: { ok: false, reason: 'unsupported_figure' },
    });
    const [row] = await rowsOf();
    expect(row).toMatchObject({ adjudication: 'rejected', reason: 'unsupported_figure', decision: null });
  });

  it('DROPS a decision on a rejected proposal rather than writing an impossible row', async () => {
    // Property 1. A rejected proposal was never shown to anybody. Passing a decision anyway is a caller
    // bug, and the module must not turn it into a row the CHECK would refuse (or worse, one it would not).
    const id = await recordProposal(adminCtx(base), {
      type: 'close_fixed_upstream',
      facts: {},
      proposal: {},
      adjudication: { ok: false, reason: 'precondition_no_longer_holds' },
      decision: 'approved',
    });
    expect(id).not.toBeNull();
    const [row] = await rowsOf();
    expect(row!.decision).toBeNull();
  });

  it('the database REFUSES the three impossible verdict combinations', async () => {
    // Property 1, at the only level that survives a hand-written backfill. Written as the OWNER, which
    // bypasses RLS but not CHECK constraints — which is exactly the threat being modelled.
    const insert = (v: Record<string, unknown>) =>
      owner.db.insert(schema.agentProposal).values({
        tenantId: base.tenantId,
        proposalType: 'close_fixed_upstream',
        inputDigest: 'd',
        adjudication: 'accepted',
        ...v,
      } as never);

    // A rejection must say WHICH check refused it, or the pass rate is unactionable.
    await expect(insert({ adjudication: 'rejected', adjudicationReason: null })).rejects.toThrow();
    // A rejected proposal never reached a human.
    await expect(
      insert({ adjudication: 'rejected', adjudicationReason: 'r', decision: 'approved', decidedAt: new Date() }),
    ).rejects.toThrow();
    // A reversal is meaningless on something nobody approved.
    await expect(insert({ reversedAt: new Date() })).rejects.toThrow();
    // The decision and its timestamp travel together.
    await expect(insert({ decision: 'approved', decidedAt: null })).rejects.toThrow();
    // …and the sound version of the same row is accepted, so the four cases above are not passing
    // because the insert is simply broken.
    await expect(insert({ decision: 'approved', decidedAt: new Date() })).resolves.toBeDefined();
  });

  it("SURVIVES the caller's transaction rolling back — the rejections are the measurement", async () => {
    // Property 2, and the reason recordProposal opens its own transaction. Simulates the real shape: a
    // proposal is refused, it is recorded, and then the operation it belonged to aborts.
    const ctx = adminCtx(base);
    await expect(
      withTenant(ctx, async (tx) => {
        await tx.execute(sql`select 1`);
        await recordProposal(ctx, {
          type: 'report_spec',
          facts: {},
          proposal: {},
          adjudication: { ok: false, reason: 'unparseable_output' },
        });
        throw new Error('the caller fails after adjudicating');
      }),
    ).rejects.toThrow('the caller fails');

    const rows = await rowsOf();
    expect(rows, 'a rejection lost to the caller rollback would make the pass rate structurally 100%')
      .toHaveLength(1);
    expect(rows[0]!.adjudication).toBe('rejected');
  });

  it('NEVER throws into the caller, and returns null when it could not record', async () => {
    // Property 3. A ledger outage is a lost data point, not a broken narration.
    const bad = { ...adminCtx(base), tenantId: '00000000-0000-4000-8000-000000000000' };
    const id = await recordProposal(bad, {
      type: 'anomaly_narration',
      facts: {},
      proposal: {},
      adjudication: { ok: true },
    });
    expect(id, 'a tenant FK that does not exist must surface as null, not as a throw').toBeNull();
    // The stamps are equally forgiving, including on a null id from a failed record above.
    await expect(recordDecision(adminCtx(base), { proposalId: null, decision: 'approved' })).resolves.toBeUndefined();
    await expect(recordReversal(adminCtx(base), { proposalId: null, reason: 'x' })).resolves.toBeUndefined();
  });

  it('stamps a later decision and a later reversal onto an earlier proposal', async () => {
    const ctx = adminCtx(base);
    const id = await recordProposal(ctx, {
      type: 'pay_rule_draft',
      facts: {},
      proposal: {},
      adjudication: { ok: true },
    });
    await recordDecision(ctx, { proposalId: id, decision: 'approved' });
    await recordReversal(ctx, { proposalId: id, reason: 'finding re-fired next cycle' });

    const [row] = await owner.db
      .select({
        decision: schema.agentProposal.decision,
        decidedAt: schema.agentProposal.decidedAt,
        reversedAt: schema.agentProposal.reversedAt,
        reversalReason: schema.agentProposal.reversalReason,
      })
      .from(schema.agentProposal)
      .where(eq(schema.agentProposal.id, id!));
    expect(row!.decision).toBe('approved');
    expect(row!.decidedAt).not.toBeNull();
    expect(row!.reversedAt).not.toBeNull();
    expect(row!.reversalReason).toContain('re-fired');
  });

  it('reports a rate with no denominator as null, NEVER as zero', async () => {
    // Property 4. `anomaly_narration` can never carry a human decision, so its agreement rate has no
    // denominator for ever — and rendering that as 0% would report the narrator as universally rejected.
    const ctx = adminCtx(base);
    await recordProposal(ctx, { type: 'anomaly_narration', facts: {}, proposal: {}, adjudication: { ok: true } });

    const [r] = await proposalRates(ctx);
    expect(r).toMatchObject({ type: 'anomaly_narration', total: 1, accepted: 1 });
    expect(r!.adjudicationPassRate).toBe(1);
    expect(r!.agreementRate, 'no human has decided anything, so agreement is UNMEASURED').toBeNull();
    expect(r!.reversalRate, 'nothing approved, so reversal is UNMEASURED').toBeNull();
  });

  it('computes the three rates independently of one another', async () => {
    const ctx = adminCtx(base);
    const mk = (adj: boolean, decision?: 'approved' | 'declined') =>
      recordProposal(ctx, {
        type: 'close_fixed_upstream',
        facts: { n: Math.random() },
        proposal: {},
        adjudication: adj ? { ok: true } : { ok: false, reason: 'precondition_no_longer_holds' },
        ...(decision ? { decision } : {}),
      });

    await mk(false); // rejected by the machine
    await mk(true, 'approved');
    await mk(true, 'approved');
    const reversedId = await mk(true, 'approved');
    await mk(true, 'declined');
    await recordReversal(ctx, { proposalId: reversedId, reason: 're-fired' });

    const [r] = await proposalRates(ctx);
    expect({ total: r!.total, accepted: r!.accepted, rejected: r!.rejected }).toEqual({
      total: 5,
      accepted: 4,
      rejected: 1,
    });
    expect(r!.adjudicationPassRate).toBeCloseTo(4 / 5);
    expect(r!.agreementRate).toBeCloseTo(3 / 4);
    // THE ONE THAT MATTERS: 75% agreement alongside a third of approvals reversed is not a success, and
    // only a separate denominator can say so.
    expect(r!.reversalRate).toBeCloseTo(1 / 3);
  });

  it('lets a NON-ADMIN session insert but not read — the split is the design', async () => {
    // Property 5. An admin-only INSERT would silently match zero rows for ADR-0084 §2.5's system-context
    // nudge sweep and §2.7's triage in an employee's own session, and the ledger would quietly stop
    // recording the very surfaces it was built to measure.
    const employee = await entitledCtx(base, ['employee']);
    const id = await recordProposal(employee, {
      type: 'report_spec',
      facts: {},
      proposal: {},
      adjudication: { ok: true },
    });
    expect(id, 'an employee-session proposer must be able to record').not.toBeNull();
    expect(await rowsOf(), 'and the row really is there, read as the owner').toHaveLength(1);

    // …but the same session must not be able to read what the system proposes about colleagues.
    const visible = await withTenant(employee, (tx) =>
      tx.select({ id: schema.agentProposal.id }).from(schema.agentProposal),
    );
    expect(visible, 'a tenant-wide read is the surveillance surface ADR-0082 §2.7 refuses').toHaveLength(0);

    // The admin CAN read it, so the case above is not passing because the row is missing.
    const asAdmin = await withTenant(adminCtx(base), (tx) =>
      tx.select({ id: schema.agentProposal.id }).from(schema.agentProposal),
    );
    expect(asAdmin).toHaveLength(1);
  });

  it('REVOKES delete from ai_hr_app while keeping select/insert/update', async () => {
    // Property 6, and nothing else in the suite catches a dropped REVOKE: bootstrap-db.sql's ALTER
    // DEFAULT PRIVILEGES hands ai_hr_app full CRUD on every owner-created table, so the omission is
    // invisible until somebody deletes a measurement in production.
    const [row] = (await owner.db.execute<{ d: boolean; s: boolean; i: boolean; u: boolean }>(sql`
      SELECT has_table_privilege('ai_hr_app', 'agent_proposal', 'DELETE') AS d,
             has_table_privilege('ai_hr_app', 'agent_proposal', 'SELECT') AS s,
             has_table_privilege('ai_hr_app', 'agent_proposal', 'INSERT') AS i,
             has_table_privilege('ai_hr_app', 'agent_proposal', 'UPDATE') AS u
    `)) as unknown as { d: boolean; s: boolean; i: boolean; u: boolean }[];
    // The three positives are the counterpart: a REVOKE that also took SELECT or INSERT would make every
    // other case in this file pass for entirely the wrong reason.
    expect(row).toEqual({ d: false, s: true, i: true, u: true });
  });
});
