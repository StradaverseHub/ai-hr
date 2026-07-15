/**
 * Unlock closed payroll — single confirm, MANDATORY reason (feedback 2108c01f; simplified in 62e85140).
 *
 * The unlock feature (unlockClosedBatch) reverses the 0011 closed-immutability freeze: admin-only
 * (payroll.unlock defaults to hr_admin + super_admin), Closed → Processed, the parent pay_period
 * reopened, audited in payroll_status_history
 * + a payroll-batch.unlocked event. Feedback 62e85140 REMOVED the step-up (OTP) confirmation-code step —
 * the on-screen gate is now a single confirm dialog — so the service signature is just
 * unlockClosedBatch(ctx, { batchId, reason? }) with no `code`. The REASON stays mandatory (a typed
 * UnlockReasonRequiredError thrown BEFORE any status flip) so the audit log always explains WHY a
 * finalised run was reopened, and the permission gate is unchanged.
 *
 * Tests:
 *   a. A blank / whitespace-only (and an undefined) reason is rejected with UnlockReasonRequiredError
 *      before anything mutates — the batch stays closed, no history row and no event are written.
 *   b. A non-blank reason succeeds (no code): Closed → Processed, the parent pay_period is reopened, a
 *      payroll_status_history 'unlock' row is written (from/to/actor/trimmed-reason), and both the
 *      payroll-batch.unlocked and pay-period.reopened events carry the reason.
 *   c. A caller WITHOUT the payroll.unlock permission (a payroll_partner — payroll-capable, so it can
 *      read the closed batch and reach the gate, but NOT hr_admin/super_admin) is blocked with
 *      PayrollPermissionDeniedError — the batch stays closed and nothing is audited.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  PayrollPermissionDeniedError,
  UnlockReasonRequiredError,
  closeBatch,
  createBatch,
  generatePayslips,
  unlockClosedBatch,
} from '../core/payroll';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let icSeq = 0;
const nextIc = () => `9104040${String(10000 + icSeq++).slice(-5)}`;

let base: Base;

/** payroll.unlock defaults to hr_admin + super_admin — a plain hr_admin now suffices. The unlock runs
 *  with both admin roles (same user id so the audited actor stays base.adminUserId). */
const superCtx = () => ({ ...adminCtx(base), roles: ['hr_admin', 'super_admin'] });

async function hire(name: string, basic = 5000) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

const batchRow = async (batchId: string) => {
  const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  return b;
};

const unlockHistoryRows = async (batchId: string) =>
  owner.db
    .select()
    .from(schema.payrollStatusHistory)
    .where(and(eq(schema.payrollStatusHistory.batchId, batchId), eq(schema.payrollStatusHistory.action, 'unlock')));

/** Drive a batch all the way to CLOSED (single run ⇒ the pay_period cascades closed too). */
async function closedBatch(period: string) {
  const a = adminCtx(base);
  await hire(`Unlock ${period}`);
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(a, { batchId }); // → processed
  await closeBatch(a, { batchId }); // → closed
  expect((await batchRow(batchId)).status).toBe('closed');
  return batchId;
}

/** Read the parent pay_period status for a batch (proves the real reopen path, migration 0202). */
async function periodStatusOf(batchId: string): Promise<string> {
  const b = await batchRow(batchId);
  const [p] = await owner.db
    .select({ status: schema.payPeriod.status })
    .from(schema.payPeriod)
    .where(eq(schema.payPeriod.id, b.payPeriodId))
    .limit(1);
  return p!.status;
}

describe('Unlock closed payroll — single confirm, mandatory reason (unlockClosedBatch)', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    process.env.PAYROLL_UNLOCK_ENABLED = 'true';
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    delete process.env.PAYROLL_UNLOCK_ENABLED; // don't leak the gate into other test files (shared worker)
    await closeAll();
  });

  it('a. a blank / undefined reason is rejected before the flip; batch stays closed, nothing audited', async () => {
    const batchId = await closedBatch('2026-05');
    const su = superCtx();

    // Whitespace-only reason → typed error, thrown BEFORE the status flip.
    await expect(unlockClosedBatch(su, { batchId, reason: '   ' })).rejects.toBeInstanceOf(UnlockReasonRequiredError);
    // An undefined reason is likewise rejected.
    await expect(unlockClosedBatch(su, { batchId } as { batchId: string })).rejects.toBeInstanceOf(
      UnlockReasonRequiredError,
    );

    // Nothing changed: still closed, no unlock history, no unlocked event.
    expect((await batchRow(batchId)).status).toBe('closed');
    expect(await unlockHistoryRows(batchId)).toHaveLength(0);
    expect(await eventTypesFor(base.tenantId, batchId)).not.toContain('payroll-batch.unlocked');
  });

  it('b. a non-blank reason succeeds (no code): Closed → Processed, period reopened, history row + events carry the trimmed reason', async () => {
    const batchId = await closedBatch('2026-06');
    const su = superCtx();

    // The single-run month cascaded its pay_period closed; the unlock reopens it through the
    // app.unlock_pay_period escape hatch (migration 0202) — no OTP, just a mandatory reason.
    expect(await periodStatusOf(batchId)).toBe('closed');
    await unlockClosedBatch(su, { batchId, reason: '  fix keyed OT  ' });

    // Status flipped, and the parent period was reopened by the unlock itself.
    expect((await batchRow(batchId)).status).toBe('processed');
    expect(await periodStatusOf(batchId)).toBe('open');

    // Exactly one audited 'unlock' history row with the trimmed reason + the real actor.
    const rows = await unlockHistoryRows(batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromStatus).toBe('closed');
    expect(rows[0].toStatus).toBe('processed');
    expect(rows[0].reason).toBe('fix keyed OT');
    expect(rows[0].actorType).toBe('user');
    expect(rows[0].actorId).toBe(base.adminUserId);

    // The domain event carries the reason too.
    expect(await eventTypesFor(base.tenantId, batchId)).toContain('payroll-batch.unlocked');
    const payload = (await latestEventPayload(base.tenantId, batchId, 'payroll-batch.unlocked')) as { reason: string };
    expect(payload.reason).toBe('fix keyed OT');

    // …and the real period-reopen (migration 0202 escape hatch) emitted its own pay-period.reopened event
    // against the period aggregate — proof the reopen happened through the guarded path, not a bypass.
    const { payPeriodId } = await batchRow(batchId);
    expect(await eventTypesFor(base.tenantId, payPeriodId)).toContain('pay-period.reopened');
  });

  it('c. a caller without payroll.unlock is blocked; batch stays closed, nothing audited', async () => {
    const batchId = await closedBatch('2026-07');
    // payroll.unlock now defaults to hr_admin + super_admin — but NOT to every payroll-capable role.
    // payroll_partner can see the closed batch (its payroll_batch RLS read is can_admin_payroll_for, which
    // the partner satisfies) so it genuinely REACHES the permission gate — and is still denied unlock,
    // proving the default only widened to the two admin roles, not to specialist/ordinary roles. (A plain
    // manager/employee can't even read the batch under RLS, so it never reaches — and can't exercise —
    // the payroll.unlock gate.)
    const notPermitted = { ...adminCtx(base), roles: ['payroll_partner'] };

    await expect(unlockClosedBatch(notPermitted, { batchId, reason: 'nope' })).rejects.toBeInstanceOf(
      PayrollPermissionDeniedError,
    );

    expect((await batchRow(batchId)).status).toBe('closed');
    expect(await unlockHistoryRows(batchId)).toHaveLength(0);
    expect(await eventTypesFor(base.tenantId, batchId)).not.toContain('payroll-batch.unlocked');
  });
});
