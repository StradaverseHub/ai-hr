/**
 * ADR-0083 §2.5 — THE ACTION LAYER, the first place an agent writes.
 *
 * Everything before this round is read-only. This file guards the properties that decide whether letting
 * an agent write is defensible, and every one of them fails in the direction of doing too much rather
 * than too little — which is why each is asserted in BOTH directions, not just the safe one.
 *
 *  1. THE PRECONDITION IS RE-CHECKED AT EXECUTION. A proposal is evidence about the moment a page
 *     rendered. Between rendering and clicking, somebody may have changed the record — or undone the fix.
 *     An action that trusts its own proposal is replaying a stale fact into a write.
 *  2. NOTHING ACTS ON ITS OWN. `autonomy` is a union with ONE member, so granting autonomy is a change to
 *     the source, not to a setting somebody can flip.
 *  3. BLAST RADIUS IS A GATE. Over the cap the whole call is REFUSED, never truncated: doing half of what
 *     was approved while reporting success is worse than doing nothing.
 *  4. ONLY RECORD-FACT CAUSES ARE CLOSEABLE. `net-swing` can never be closed this way — "their pay moved
 *     40%" does not stop being true when somebody edits a field, and closing it would assert a judgement
 *     the agent has not made.
 *  5. THE PREDICATE IS SHARED WITH READINESS. Two definitions of "has a bank account" would drift, and
 *     the drift would be invisible: the action layer closing findings the readiness screen still lists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { resolveAnomalyVerdict } from '../core/payroll-anomaly';
import {
  AGENT_ACTION_TYPES,
  AgentActionError,
  actionTypeById,
  executeAction,
  proposeActions,
} from '../core/agent-actions';

describe('ADR-0083 §2.5 — the action layer', () => {
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

  /** An employee with an OPEN `missing-bank-profile` verdict against them. */
  async function flagged(opts: { withBank: boolean; detector?: string } = { withBank: false }) {
    const a = adminCtx(base);
    seq++;
    const e = await hireEmployee(a, {
      person: { fullName: `Acted ${seq}`, primaryEmail: `acted.${seq}@aa.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      paymentMethod: 'bank_transfer',
    } as never);
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: `90010101${String(4000 + seq)}`,
      taxNumber: `SG${4000 + seq}`,
      ...(opts.withBank ? { bankName: 'Maybank', bankAccountNo: `999${4000 + seq}` } : {}),
    } as never);

    const [batch] = await owner.db
      .select({ id: schema.payrollBatch.id })
      .from(schema.payrollBatch)
      .limit(1);
    const batchId = batch?.id ?? (await seedBatch());

    const [v] = await owner.db
      .insert(schema.payrollAnomalyVerdict)
      .values({
        tenantId: base.tenantId,
        batchId,
        employmentId: e.employmentId,
        disposition: 'block',
        detectorsRun: ['missing-bank-profile'],
        detectorsSkipped: [],
      } as never)
      .returning({ id: schema.payrollAnomalyVerdict.id });
    await owner.db.insert(schema.payrollAnomalyFinding).values({
      tenantId: base.tenantId,
      verdictId: v!.id,
      detectorId: opts.detector ?? 'missing-bank-profile',
      severity: 'block',
      facts: {},
      sourceEventIds: [],
      suggestedAction: 'anomaly.action.missingBankProfile',
    } as never);
    return { employmentId: e.employmentId, personId: e.personId, verdictId: v!.id };
  }

  /** A batch to hang verdicts from. The action layer never reads it; the FK requires it. */
  async function seedBatch() {
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: base.tenantId, companyId: base.companyId, period: '2026-05', status: 'open' } as never)
      .returning({ id: schema.payPeriod.id });
    const [b] = await owner.db
      .insert(schema.payrollBatch)
      .values({
        tenantId: base.tenantId,
        companyId: base.companyId,
        payPeriodId: pp!.id,
        payPeriod: '2026-05',
        batchDate: '2026-05-31',
        status: 'processed',
        employeeCount: 1,
      } as never)
      .returning({ id: schema.payrollBatch.id });
    return b!.id;
  }

  it('proposes nothing while the cause is still broken', async () => {
    // The non-vacuity anchor for everything below: if it proposed here, every other case would pass for
    // the wrong reason.
    await flagged({ withBank: false });
    expect(await proposeActions(adminCtx(base))).toEqual([]);
  });

  it('proposes closing once the cause is fixed, naming the cause', async () => {
    const f = await flagged({ withBank: false });
    // Somebody fills in the bank account — the fix the readiness screen asked for.
    await owner.db
      .update(schema.employeeStatutoryMy)
      .set({ bankName: 'Maybank', bankAccountNo: '9990001' })
      .where(eq(schema.employeeStatutoryMy.personId, f.personId));

    const [p] = await proposeActions(adminCtx(base));
    expect(p, 'a fixed cause must become a proposal').toBeTruthy();
    expect(p!.subjects.map((s) => s.verdictId)).toContain(f.verdictId);
    // The reasoning is shown, not just the conclusion — a human approving this has to be able to check it.
    expect(p!.subjects[0]!.cause).toBe('no_bank_account');
    expect(p!.type.autonomy).toBe('propose_only');
  });

  it('REFUSES to close a verdict whose cause came back between proposal and click', async () => {
    // Property (1), and the reason a proposal is not a promise. The ids are approved for a REASON; if the
    // reason evaporates the ids are worthless.
    const f = await flagged({ withBank: true });
    const [p] = await proposeActions(adminCtx(base));
    expect(p!.subjects.map((s) => s.verdictId)).toContain(f.verdictId);

    // The fix is undone after the page rendered.
    await owner.db
      .update(schema.employeeStatutoryMy)
      .set({ bankAccountNo: null })
      .where(eq(schema.employeeStatutoryMy.personId, f.personId));

    const res = await executeAction(adminCtx(base), {
      typeId: 'close_fixed_upstream',
      verdictIds: [f.verdictId],
    });
    expect(res.closed).toBe(0);
    expect(res.stale).toBe(1);
    const [row] = await owner.db
      .select({ resolvedAt: schema.payrollAnomalyVerdict.resolvedAt })
      .from(schema.payrollAnomalyVerdict)
      .where(eq(schema.payrollAnomalyVerdict.id, f.verdictId));
    expect(row!.resolvedAt, 'nothing may be written when the precondition fails').toBeNull();
  });

  it('closes it as fixed_upstream when the cause really is gone', async () => {
    const f = await flagged({ withBank: true });
    const res = await executeAction(adminCtx(base), {
      typeId: 'close_fixed_upstream',
      verdictIds: [f.verdictId],
    });
    expect(res.closed).toBe(1);
    expect(res.stale).toBe(0);

    const [row] = await owner.db
      .select({
        resolvedAt: schema.payrollAnomalyVerdict.resolvedAt,
        resolution: schema.payrollAnomalyVerdict.resolution,
      })
      .from(schema.payrollAnomalyVerdict)
      .where(eq(schema.payrollAnomalyVerdict.id, f.verdictId));
    // `fixed_upstream` and not `false_positive`: the finding was RIGHT when it was raised. Recording it
    // as a false positive would corrupt the accuracy metric this layer exists to start populating.
    expect(row!.resolution).toBe('fixed_upstream');
    expect(row!.resolvedAt).not.toBeNull();
  });

  it('will NOT touch a detector whose cause is not a record fact', async () => {
    // Property (4). "Their pay moved 40%" does not stop being true when somebody edits a field.
    await flagged({ withBank: true, detector: 'net-swing' });
    expect(await proposeActions(adminCtx(base))).toEqual([]);
  });

  it('REFUSES an approval over the blast-radius cap rather than truncating it', async () => {
    // Property (3). Doing half of what was approved while reporting success is the worse failure.
    const type = actionTypeById('close_fixed_upstream')!;
    const ids = Array.from({ length: type.blastRadiusCap + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(
      executeAction(adminCtx(base), { typeId: 'close_fixed_upstream', verdictIds: ids }),
    ).rejects.toThrow(AgentActionError);
  });

  it('refuses an unknown action type and an empty approval', async () => {
    const a = adminCtx(base);
    await expect(executeAction(a, { typeId: 'delete_everything', verdictIds: ['x'] })).rejects.toThrow(
      AgentActionError,
    );
    await expect(executeAction(a, { typeId: 'close_fixed_upstream', verdictIds: [] })).rejects.toThrow(
      AgentActionError,
    );
  });

  it('one verdict already dealt with by hand does NOT cost the rest of the batch', async () => {
    // The realistic race: two proposals on screen, somebody resolves one by hand, the operator approves
    // both. The batch must still close the other — losing an approved batch to one row is the mirror of
    // the truncation property (3) refuses, and just as misleading.
    const a = await flagged({ withBank: true });
    const b = await flagged({ withBank: true });
    await resolveAnomalyVerdict(adminCtx(base), { verdictId: a.verdictId, resolution: 'accepted' });

    const res = await executeAction(adminCtx(base), {
      typeId: 'close_fixed_upstream',
      verdictIds: [a.verdictId, b.verdictId],
    });
    expect(res.closed).toBe(1);
    expect(res.stale).toBe(1);

    const [row] = await owner.db
      .select({ resolution: schema.payrollAnomalyVerdict.resolution })
      .from(schema.payrollAnomalyVerdict)
      .where(eq(schema.payrollAnomalyVerdict.id, a.verdictId));
    // And the hand decision is untouched — not overwritten with `fixed_upstream`.
    expect(row!.resolution).toBe('accepted');
  });

  it('the execution loop catches PER VERDICT, so one refusal cannot discard committed work', () => {
    // A SOURCE-SHAPE ASSERTION, and deliberately so: the case above reaches the pre-filter rather than
    // the catch, and the only thing that reaches the catch is a genuine race inside a single call — the
    // service refusing between the re-check and the write. That cannot be staged deterministically, and
    // a behavioural test that silently exercises a different path would claim coverage it does not have.
    // What matters is checkable here: each resolve is its own transaction, so a throw escaping the loop
    // would report total failure over verdicts that had already COMMITTED.
    const src = fs.readFileSync(path.resolve(__dirname, '../core/agent-actions.ts'), 'utf8');
    const loop = src.slice(src.indexOf('for (const id of ids)'));
    expect(loop).toContain('try {');
    expect(loop).toContain('await resolveAnomalyVerdict(');
    expect(loop.indexOf('try {')).toBeLessThan(loop.indexOf('await resolveAnomalyVerdict('));
    expect(loop).toMatch(/\}\s*catch\b/);
  });

  it('every action type is reversible and propose-only — the invariant, not a description', () => {
    // Property (2). An irreversible action type cannot exist here yet, and autonomy cannot be granted by
    // configuration. Both are asserted so widening either requires editing this file too.
    for (const t of AGENT_ACTION_TYPES) {
      expect(t.autonomy, `${t.id} must be propose_only`).toBe('propose_only');
      expect(t.reversibility, `${t.id} must be reversible while autonomy is unearned`).toBe('reversible');
      expect(t.blastRadiusCap).toBeGreaterThan(0);
    }
  });
});
