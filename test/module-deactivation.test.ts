/**
 * ADR-0077 slice 5 — two-phase deactivation, and the disabled-module contract (D-6).
 *
 * TURNING A MODULE OFF WHILE WORK IS IN FLIGHT STRANDS IT. An open review cycle whose module disappears
 * cannot be closed; a draft payroll batch cannot be processed; banked TOIL cannot be re-tuned. So the
 * runner enumerates what would be stranded and REFUSES until the operator has recorded a decision for
 * each. It is not a veto — a customer who stopped paying is entitled to stop paying — it makes the
 * decision informed and auditable instead of something discovered later by whoever finds the wreckage.
 *
 * D-6 IS MOSTLY ALREADY TRUE and these tests exist to keep it that way. `isModuleEnabled` resolves a
 * 'disabled' row as OFF (core/entitlements.ts: `status IN ('active','trial')`), so every gated WRITE
 * already refuses. What must not regress is the other half: history stays readable, and obligations
 * already incurred keep executing (D4).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { Tx } from '../db/client';
import { deactivationBlockers, unansweredBlockers } from '../core/module-deactivation';
import { applyModuleChange, ModuleChangeRefused } from '../scripts/module-change-runner';
import { listToilPolicies } from '../core/toil';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await owner.db.insert(schema.subscriptionLine).values({ tenantId: b.tenantId, moduleCode: 'toil' });
});
afterAll(async () => {
  await closeAll();
});

const req = (o: Partial<typeof schema.moduleChangeRequest.$inferSelect>) =>
  ({
    id: randomUUID(),
    tenantId: b.tenantId,
    moduleCode: 'toil',
    companyId: null,
    action: 'activate',
    status: 'pending',
    currentStep: null,
    error: null,
    claimedAt: null,
    requestedBy: 'operator@stradaverse.test',
    disposition: null,
    createdAt: new Date(),
    decidedAt: null,
    ...o,
  }) as typeof schema.moduleChangeRequest.$inferSelect;

const run = (r: ReturnType<typeof req>) => owner.db.transaction((tx) => applyModuleChange(tx as unknown as Tx, r));

/** A banked, still-active TOIL credit — the thing deactivation would strand. */
async function bankToil() {
  // seedBase() creates the company but no people, so the accrual needs an employment of its own.
  const emp = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Banked', primaryEmail: `banked_${randomUUID().slice(0, 8)}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await owner.db.insert(schema.toilAccrual).values({
    tenantId: b.tenantId,
    employmentId: emp.employmentId,
    workedDate: '2026-06-01',
    // A rest day is the shape TOIL is actually banked from — a plain workday is not eligible.
    dayType: 'rest_day',
    otMinutes: 480,
    daysCredited: '1.00',
    accrualBasis: 'hours_worked',
    expiresOn: '2026-09-01',
    status: 'active',
  });
}

describe('deactivation refuses until the operator has decided', () => {
  it('proceeds with no disposition when nothing is in flight', async () => {
    await run(req({}));
    await expect(run(req({ action: 'deactivate' }))).resolves.toBeTruthy();
  });

  it('refuses when banked TOIL would be stranded, and NAMES what it found', async () => {
    await run(req({}));
    await bankToil();
    const err = await run(req({ action: 'deactivate' })).catch((e) => e);
    expect(err).toBeInstanceOf(ModuleChangeRefused);
    expect((err as ModuleChangeRefused).step).toBe('disposition');
    expect((err as Error).message).toMatch(/active_toil_accrual/);
    // The operator is told what the number MEANS, not just that a count was non-zero.
    expect((err as Error).message).toMatch(/earned time the employee has not taken or been paid for/);
  });

  it('proceeds once a disposition is recorded, and records it on the outcome', async () => {
    await run(req({}));
    await bankToil();
    const out = await run(
      req({ action: 'deactivate', disposition: { active_toil_accrual: 'convert to pay in the June run' } }),
    );
    expect(out.detail.join(' ')).toMatch(/convert to pay in the June run/);
  });

  // A blank answer is what an unfilled form field sends — it must not count as a decision.
  it('treats a blank disposition as unanswered', async () => {
    await run(req({}));
    await bankToil();
    await expect(
      run(req({ action: 'deactivate', disposition: { active_toil_accrual: '   ' } })),
    ).rejects.toThrow(/disposition/);
  });

  it('does not report blockers belonging to other modules', async () => {
    await owner.db.transaction(async (tx) => {
      const blockers = await deactivationBlockers({
        tx: tx as unknown as Tx,
        tenantId: b.tenantId,
        moduleCode: 'toil',
        companyId: null,
      });
      // Only TOIL's own kind is ever considered for TOIL — noise in a confirmation screen is how
      // operators learn to click through them.
      expect(blockers.every((x) => x.kind === 'active_toil_accrual')).toBe(true);
    });
  });
});

describe('D-6 — disabled means writes refused, history readable', () => {
  it('leaves the data in place and says so', async () => {
    await run(req({}));
    await bankToil();
    const out = await run(
      req({ action: 'deactivate', disposition: { active_toil_accrual: 'pay out' } }),
    );
    expect(out.detail.join(' ')).toMatch(/no data removed/);
    const accruals = await owner.db.select().from(schema.toilAccrual);
    expect(accruals, 'disabling is not deleting').toHaveLength(1);
  });

  /**
   * The half that could silently regress. `listToilPolicies` is a READ and is deliberately NOT gated —
   * core/toil.ts's own comment explains why: winding down needs the ledger, and the entitlement governs
   * FUTURE accrual, not access to what already happened.
   */
  it('keeps history readable after the module is disabled', async () => {
    await run(req({}));
    await run(req({ action: 'deactivate' }));
    const policies = await listToilPolicies(adminCtx(b), [b.companyId]);
    expect(policies.length, 'a disabled module must not hide what it already recorded').toBeGreaterThan(0);
  });

  it('records that obligations already incurred keep running', async () => {
    await run(req({}));
    const out = await run(req({ action: 'deactivate' }));
    expect(out.detail.join(' ')).toMatch(/obligations already incurred continue/);
  });
});

describe('unansweredBlockers', () => {
  const blocker = { kind: 'active_toil_accrual' as const, count: 1, detail: 'x' };
  it('treats a null disposition as nothing answered', () => {
    expect(unansweredBlockers([blocker], null)).toHaveLength(1);
  });
  it('accepts a real answer', () => {
    expect(unansweredBlockers([blocker], { active_toil_accrual: 'pay out' })).toHaveLength(0);
  });
  it('ignores an answer to a different blocker', () => {
    expect(unansweredBlockers([blocker], { draft_payroll_batch: 'whatever' })).toHaveLength(1);
  });
});
