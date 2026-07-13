/**
 * Unlock closed payroll — MANDATORY reason (feedback 2108c01f).
 *
 * The unlock feature (unlockClosedBatch) already reverses the 0011 closed-immutability freeze:
 * super_admin-only (payroll.unlock) + a step-up OTP, Closed → Processed, audited in
 * payroll_status_history + a payroll-batch.unlocked event. This item makes the REASON mandatory so
 * the audit log always explains WHY a finalised run was reopened — the guard is a typed
 * UnlockReasonRequiredError thrown BEFORE any status flip and BEFORE the OTP is consumed.
 *
 * Tests:
 *   a. A blank / whitespace-only (and an undefined) reason is rejected with UnlockReasonRequiredError
 *      before anything mutates — the batch stays closed, no history row and no event are written, and
 *      the step-up challenge is NOT consumed (the reason guard fires before the OTP check).
 *   b. A non-blank reason succeeds: Closed → Processed, a payroll_status_history 'unlock' row is
 *      written (from/to/actor/trimmed-reason), and the payroll-batch.unlocked event carries the reason.
 *
 * Scope note: a single-run month cascades its pay_period to 'closed' on closeBatch. Reopening it is
 * guarded independently (migration 0067's pay_period_immutable_when_closed); migration 0202 adds the
 * app.unlock_pay_period escape hatch so unlockClosedBatch reopens the period itself. Test (b) exercises
 * the mandatory-reason + status-flip + real period-reopen + audit path in
 * isolation.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  UnlockReasonRequiredError,
  closeBatch,
  createBatch,
  generatePayslips,
  requestUnlockChallenge,
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

/** payroll.unlock defaults to super_admin only — the unlock steps run as a super_admin (same user id so
 *  the step-up challenge issued here can be consumed here, and the audited actor stays base.adminUserId). */
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

const unconsumedChallenges = async (batchId: string) =>
  owner.db
    .select()
    .from(schema.payrollStepUpChallenge)
    .where(and(eq(schema.payrollStepUpChallenge.batchId, batchId), isNull(schema.payrollStepUpChallenge.consumedAt)));

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

describe('Unlock closed payroll — mandatory reason (unlockClosedBatch)', () => {
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

  it('a. a blank / undefined reason is rejected before the flip; batch stays closed, nothing audited, OTP not consumed', async () => {
    const batchId = await closedBatch('2026-05');
    const su = superCtx();
    const { code } = await requestUnlockChallenge(su, { batchId });

    // Whitespace-only reason → typed error, thrown BEFORE the status flip and BEFORE the OTP is consumed.
    await expect(unlockClosedBatch(su, { batchId, reason: '   ', code })).rejects.toBeInstanceOf(UnlockReasonRequiredError);
    // An undefined reason is likewise rejected.
    await expect(unlockClosedBatch(su, { batchId, code } as { batchId: string; code: string })).rejects.toBeInstanceOf(
      UnlockReasonRequiredError,
    );

    // Nothing changed: still closed, no unlock history, no unlocked event…
    expect((await batchRow(batchId)).status).toBe('closed');
    expect(await unlockHistoryRows(batchId)).toHaveLength(0);
    expect(await eventTypesFor(base.tenantId, batchId)).not.toContain('payroll-batch.unlocked');
    // …and the step-up challenge is still live (the reason guard fires before verifyStepUp consumes it).
    expect(await unconsumedChallenges(batchId)).toHaveLength(1);
  });

  it('b. a non-blank reason succeeds: Closed → Processed, history row + event carry the trimmed reason', async () => {
    const batchId = await closedBatch('2026-06');
    const su = superCtx();
    const { code } = await requestUnlockChallenge(su, { batchId });

    // The single-run month cascaded its pay_period closed; the real unlock reopens it through the
    // app.unlock_pay_period escape hatch (migration 0202) — no out-of-band trigger suspension needed.
    expect(await periodStatusOf(batchId)).toBe('closed');
    await unlockClosedBatch(su, { batchId, reason: '  fix keyed OT  ', code });

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
  });
});
