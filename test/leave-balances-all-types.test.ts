/**
 * ADR-0038 2F-1 (R18) — leaveBalances lists every active leave type the employee is ELIGIBLE for, even
 * with no accrual or request yet (so the balance list is the full menu, not just types with activity),
 * while excluding types they're not eligible for (e.g. maternity for a male). Tracked types still carry
 * their ledger balance.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { leaveBalances } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

async function hire(gender: string, marital: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Bal', primaryEmail: `bal_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01', // ≥12 months service by "today"
  });
  await owner.db.update(schema.person).set({ gender, maritalStatus: marital }).where(eq(schema.person.id, e.personId));
  return e;
}
async function leaveType(code: string, eligibility: unknown) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code, name: code, paid: true, counting: 'calendar_days', eligibility })
    .returning({ id: schema.leaveType.id });
  return row.id;
}
const namesFor = async (employmentId: string) =>
  new Set((await leaveBalances(adminCtx(b), employmentId)).map((r) => r.leaveType));

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await leaveType('T_ANN', null);
  await leaveType('T_MAT', { gender: 'female' });
  await leaveType('T_PAT', { gender: 'male', maritalStatus: 'married', minServiceMonths: 12 });
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0038 2F-1 (R18) — all entitled leave types in the balance list', () => {
  it('lists eligible types with no activity, and excludes ineligible ones', async () => {
    const female = await hire('female', 'married');
    const names = await namesFor(female.employmentId);
    expect(names.has('T_ANN')).toBe(true); // open to all, no activity
    expect(names.has('T_MAT')).toBe(true); // female-eligible
    expect(names.has('T_PAT')).toBe(false); // male-only → excluded
  });

  it('shows the opposite gender gate for a male employee', async () => {
    const male = await hire('male', 'married');
    const names = await namesFor(male.employmentId);
    expect(names.has('T_PAT')).toBe(true); // married male, ≥12mo service
    expect(names.has('T_MAT')).toBe(false); // female-only → excluded
  });

  it('still reflects the ledger balance for a type with activity', async () => {
    const emp = await hire('female', 'single');
    const annual = (await owner.db.select({ id: schema.leaveType.id }).from(schema.leaveType).where(eq(schema.leaveType.code, 'T_ANN')))[0].id;
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: annual,
      entryType: 'accrual',
      days: '12.00',
      effectiveOn: '2026-01-01',
    });
    const rows = await leaveBalances(adminCtx(b), emp.employmentId);
    const annualRow = rows.find((r) => r.leaveType === 'T_ANN');
    expect(annualRow?.accrued).toBe(12);
    expect(annualRow?.available).toBe(12);
  });
});
