/**
 * Leave Type Expiry Field (fec49317) — age-from-earning expiry for a leave type.
 *
 * Covers the OPTIONAL per-type `expiry_value`/`expiry_unit` pair and the expireAgedLeave sweep, which reuses
 * the TOIL expires-on / oldest-first pattern (not the carry-forward reconstruction). Each `accrual` portion
 * lapses `expiry_value expiry_unit` after its effective_on; the still-unconsumed remainder is forfeited as a
 * dated negative `adjustment` stamped AGED_FORFEIT_REASON. Because leaveBalance is a plain ledger sum, the
 * forfeit leaves the balance (and the manual encashment advisory) while staying a real ledger row (visible in
 * reports). SCOPE: ANNUAL is excluded (it has its own carry-forward expiry) — proven below.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { AGED_FORFEIT_REASON, agedExpiryDate, expireAgedLeave } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

/** Insert a leave_type by code with an optional age-expiry pair. */
const addType = async (
  code: string,
  name: string,
  expiry?: { value: number; unit: 'months' | 'days' },
) => {
  const [t] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code,
      name,
      paid: true,
      expiryValue: expiry?.value ?? null,
      expiryUnit: expiry?.unit ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return t.id;
};

/** Set the expiry pair on an existing type (owner role bypasses RLS). */
const setExpiry = (leaveTypeId: string, value: number | null, unit: 'months' | 'days' | null) =>
  owner.db.update(schema.leaveType).set({ expiryValue: value, expiryUnit: unit }).where(eq(schema.leaveType.id, leaveTypeId));

/** Post a raw ledger row (owner role, bypasses RLS) for precise scenario construction. */
const post = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'debit' | 'adjustment',
  days: number,
  effectiveOn: string,
) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
  });

/** Aged-forfeit adjustment rows for an (emp, type), newest arithmetic aside — proves the sweep + idempotency. */
const agedForfeits = async (employmentId: string, leaveTypeId: string) => {
  const rows = await owner.db
    .select({ days: schema.leaveLedger.days, effectiveOn: schema.leaveLedger.effectiveOn })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, leaveTypeId),
        eq(schema.leaveLedger.entryType, 'adjustment'),
        eq(schema.leaveLedger.reason, AGED_FORFEIT_REASON),
      ),
    );
  return rows.map((r) => ({ days: Number(r.days), effectiveOn: r.effectiveOn }));
};

const hire = async (hiredOn: string): Promise<{ id: string }> => {
  const r = await hireEmployee(adminCtx(b), {
    person: { fullName: 'AX', primaryEmail: `ax_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId: null,
    grantLeaveTypes: [],
  });
  return { id: r.employmentId };
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('agedExpiryDate (pure helper)', () => {
  it('adds whole months, keeping the day where valid', () => {
    expect(agedExpiryDate('2026-01-15', 3, 'months')).toBe('2026-04-15');
    expect(agedExpiryDate('2026-11-10', 3, 'months')).toBe('2027-02-10'); // rolls into next year
  });
  it('clamps a month-overflow day to the target month last day (leap-correct)', () => {
    expect(agedExpiryDate('2026-01-31', 1, 'months')).toBe('2026-02-28'); // 2026 common year
    expect(agedExpiryDate('2028-01-31', 1, 'months')).toBe('2028-02-29'); // 2028 leap year
    expect(agedExpiryDate('2026-01-31', 3, 'months')).toBe('2026-04-30'); // April has 30
  });
  it('adds calendar days across month/year boundaries', () => {
    expect(agedExpiryDate('2026-01-20', 30, 'days')).toBe('2026-02-19');
    expect(agedExpiryDate('2026-12-25', 10, 'days')).toBe('2027-01-04');
  });
});

describe('expireAgedLeave — sweep', () => {
  it('forfeits an unused aged batch and removes it from the balance', async () => {
    const emp = await hire('2024-01-01');
    const sick = await addType('SICK', 'Sick', { value: 3, unit: 'months' });
    await post(emp.id, sick, 'accrual', 5, '2026-01-10'); // expires 2026-04-10
    expect(await ledgerBalance(emp.id, sick)).toBe(5);

    const res = await expireAgedLeave(adminCtx(b), { today: '2026-05-01' });
    expect(res.swept).toBe(1);
    expect(res.forfeited).toBe(5);
    expect(await ledgerBalance(emp.id, sick)).toBe(0);
    const forfeits = await agedForfeits(emp.id, sick);
    expect(forfeits).toEqual([{ days: -5, effectiveOn: '2026-04-10' }]);
  });

  it('does not forfeit a batch whose expiry has not yet arrived', async () => {
    const emp = await hire('2024-01-01');
    const sick = await addType('SICK', 'Sick', { value: 6, unit: 'months' });
    await post(emp.id, sick, 'accrual', 4, '2026-01-10'); // expires 2026-07-10
    const res = await expireAgedLeave(adminCtx(b), { today: '2026-05-01' });
    expect(res.swept).toBe(0);
    expect(await ledgerBalance(emp.id, sick)).toBe(4);
  });

  it('never forfeits days that were actually taken (debits protect the oldest batch first)', async () => {
    const emp = await hire('2024-01-01');
    const sick = await addType('SICK', 'Sick', { value: 3, unit: 'months' });
    await post(emp.id, sick, 'accrual', 5, '2026-01-10'); // expires 2026-04-10
    await post(emp.id, sick, 'debit', -3, '2026-02-01'); // used 3 of the batch → only 2 can lapse
    const res = await expireAgedLeave(adminCtx(b), { today: '2026-05-01' });
    expect(res.forfeited).toBe(2);
    expect(await ledgerBalance(emp.id, sick)).toBe(0);
  });

  it('caps the forfeit at the live balance (never drives it negative across batches)', async () => {
    const emp = await hire('2024-01-01');
    const sick = await addType('SICK', 'Sick', { value: 3, unit: 'months' });
    await post(emp.id, sick, 'accrual', 3, '2026-01-10'); // expires 2026-04-10
    await post(emp.id, sick, 'accrual', 3, '2026-02-10'); // expires 2026-05-10
    await post(emp.id, sick, 'debit', -5, '2026-03-01'); // balance now 1
    const res = await expireAgedLeave(adminCtx(b), { today: '2026-06-01' });
    // 5 debits consume the whole first batch (3) + 2 of the second; only 1 remains and can lapse.
    expect(res.forfeited).toBe(1);
    expect(await ledgerBalance(emp.id, sick)).toBe(0);
  });

  it('excludes ANNUAL (owned by the carry-forward expiry engine) even if a pair is set', async () => {
    const emp = await hire('2024-01-01');
    // The seed's ANNUAL type; force an expiry pair onto it — the sweep must still ignore it.
    await setExpiry(b.annualLeaveTypeId, 3, 'months');
    await post(emp.id, b.annualLeaveTypeId, 'accrual', 8, '2026-01-10');
    const res = await expireAgedLeave(adminCtx(b), { today: '2026-06-01' });
    expect(res.swept).toBe(0);
    expect(await ledgerBalance(emp.id, b.annualLeaveTypeId)).toBe(8);
  });

  it('ignores festive adjustment grants and only ages accrual rows', async () => {
    const emp = await hire('2024-01-01');
    const sick = await addType('SICK', 'Sick', { value: 3, unit: 'months' });
    await post(emp.id, sick, 'adjustment', 4, '2026-01-10'); // festive-style grant, NOT an accrual
    const res = await expireAgedLeave(adminCtx(b), { today: '2026-06-01' });
    expect(res.swept).toBe(0);
    expect(await ledgerBalance(emp.id, sick)).toBe(4);
  });

  it('is idempotent — a re-run forfeits nothing more', async () => {
    const emp = await hire('2024-01-01');
    const sick = await addType('SICK', 'Sick', { value: 3, unit: 'months' });
    await post(emp.id, sick, 'accrual', 5, '2026-01-10');
    await expireAgedLeave(adminCtx(b), { today: '2026-05-01' });
    const balAfterFirst = await ledgerBalance(emp.id, sick);
    const res2 = await expireAgedLeave(adminCtx(b), { today: '2026-05-02' });
    expect(res2.swept).toBe(0);
    expect(res2.forfeited).toBe(0);
    expect(await ledgerBalance(emp.id, sick)).toBe(balAfterFirst);
    expect(await agedForfeits(emp.id, sick)).toHaveLength(1);
  });

  it('does nothing for a type with no expiry configured', async () => {
    const emp = await hire('2024-01-01');
    const sick = await addType('SICK', 'Sick'); // no expiry
    await post(emp.id, sick, 'accrual', 5, '2024-01-10');
    const res = await expireAgedLeave(adminCtx(b), { today: '2026-05-01' });
    expect(res.swept).toBe(0);
    expect(await ledgerBalance(emp.id, sick)).toBe(5);
  });
});

describe('leaveEntitlementBreakdown — aged forfeits visible in reports', () => {
  it('folds the aged lapse into `forfeited` and keeps the component reconciliation with balance', async () => {
    const emp = await hire('2024-01-01');
    const sick = await addType('SICK', 'Sick', { value: 3, unit: 'months' });
    await post(emp.id, sick, 'accrual', 5, '2026-01-10'); // expires 2026-04-10
    await expireAgedLeave(adminCtx(b), { today: '2026-05-01' });

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.id, sick, '2026-05-01');
    expect(bd).not.toBeNull();
    expect(bd!.forfeited).toBe(5);
    expect(bd!.totalAvailable).toBe(0);
    // The forfeit row is still present in the transaction list (expired days visible in reports).
    const hasForfeitRow = bd!.transactions.some((r) => r.entryType === 'adjustment' && r.days === -5);
    expect(hasForfeitRow).toBe(true);
  });
});
