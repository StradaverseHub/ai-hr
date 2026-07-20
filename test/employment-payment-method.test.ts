/**
 * Payroll tab — Payment Method (R46 79eb7151).
 *
 * Payment Method (bank_transfer | cheque | cash) is the ONE genuinely new field of this item: an exhaustive
 * grep before the build found zero per-employee payment_method / pay_mode / payment_term columns. Pay Mode
 * and Payment Term were NOT added — they already exist as payroll_policy.policy_type and
 * PayrollPolicyConfig.frequency and are only surfaced read-only, so there is nothing new to test for them.
 *
 * Covered here:
 *   - the additive employment.payment_method column round-trips through the service;
 *   - the bank-transfer invariant (both bank name AND account number required) is enforced SERVER-side,
 *     including the half-filled case, which is the one a client-side check would wave through;
 *   - substrate discipline: `employment.payment-method.changed` is appended with a before/after payload,
 *     and a no-op re-set appends nothing;
 *   - the payment-summary CSV carries the method, appended strictly last so existing column indexes hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type SessionContext } from '../db/client';
import {
  hireEmployee,
  setEmploymentPaymentMethod,
  MissingBankForTransferError,
} from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips, paymentSummaryForBatch } from '../core/payroll';
import { setStatutoryProfileMY, setBankProfileMY } from '../localization/my/statutory';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';

describe('Personnel — Payment Method (R46 79eb7151)', () => {
  let base: Base;
  const hire = (ctx: SessionContext, name: string) =>
    hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

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

  it('defaults to null and round-trips cheque / cash / cleared', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Pay Method');

    // Every pre-existing row reads as "not specified" — the column is additive and nullable.
    const first = await setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'cheque' });
    expect(first.changed).toBe(true);
    expect(first.paymentMethod).toBe('cheque');

    const toCash = await setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'cash' });
    expect(toCash.paymentMethod).toBe('cash');

    const cleared = await setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: null });
    expect(cleared.changed).toBe(true);
    expect(cleared.paymentMethod).toBeNull();
  });

  it('bank_transfer REQUIRES both a bank name and an account number', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Pay Transfer');

    // No statutory row at all — nowhere to send the money.
    await expect(
      setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'bank_transfer' }),
    ).rejects.toThrow(MissingBankForTransferError);

    // Half a destination is still not payable — the case a client-side "is anything filled in?" check misses.
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015023' });
    await setBankProfileMY(a, { personId: e.personId, bankName: 'Maybank', bankAccountNo: '' });
    await expect(
      setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'bank_transfer' }),
    ).rejects.toThrow(MissingBankForTransferError);

    // Complete destination ⇒ accepted.
    await setBankProfileMY(a, { personId: e.personId, bankName: 'Maybank', bankAccountNo: '111122223333' });
    const ok = await setEmploymentPaymentMethod(a, {
      employmentId: e.employmentId,
      paymentMethod: 'bank_transfer',
    });
    expect(ok.paymentMethod).toBe('bank_transfer');

    // Cheque and cash carry no such requirement — they are settled outside the bank file.
    const chq = await setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'cheque' });
    expect(chq.changed).toBe(true);
  });

  it('substrate: appends employment.payment-method.changed with before/after, and no event on a no-op', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Pay Event');

    await setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'cash' });
    expect(await eventTypesFor(base.tenantId, e.employmentId)).toContain('employment.payment-method.changed');

    const payload = await latestEventPayload(
      base.tenantId,
      e.employmentId,
      'employment.payment-method.changed',
    );
    expect(payload?.before).toBeNull();
    expect(payload?.after).toBe('cash');

    await setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'cheque' });
    const after = await latestEventPayload(
      base.tenantId,
      e.employmentId,
      'employment.payment-method.changed',
    );
    expect(after?.before).toBe('cash');
    expect(after?.after).toBe('cheque');

    // Idempotent: re-setting the same value writes nothing and appends nothing.
    const countBefore = (await eventTypesFor(base.tenantId, e.employmentId)).filter(
      (t) => t === 'employment.payment-method.changed',
    ).length;
    const noop = await setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'cheque' });
    expect(noop.changed).toBe(false);
    const countAfter = (await eventTypesFor(base.tenantId, e.employmentId)).filter(
      (t) => t === 'employment.payment-method.changed',
    ).length;
    expect(countAfter).toBe(countBefore);
  });

  it('the payment-summary CSV carries Payment Method, appended strictly last', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Pay Csv');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015023' });
    await setBankProfileMY(a, { personId: e.personId, bankName: 'Maybank', bankAccountNo: '111122223333' });
    await setEmploymentPaymentMethod(a, { employmentId: e.employmentId, paymentMethod: 'bank_transfer' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const file = await paymentSummaryForBatch(a, batchId);

    // The CSV is CRLF-terminated (bank-upload convention) — strip the \r before comparing cells.
    const header = file.content
      .split('\n')[0]
      .split(',')
      .map((h) => h.trim().replace(/^"|"$/g, ''));
    // Strictly last: anything parsing this CSV positionally (including on Net Pay) is unaffected.
    expect(header[header.length - 1]).toBe('Payment Method');
    expect(header[header.length - 2]).toBe('Net Pay (RM)');

    const row = file.content.split('\n').find((l) => l.includes('Pay Csv'))!;
    expect(row).toContain('bank_transfer');
  });
});
