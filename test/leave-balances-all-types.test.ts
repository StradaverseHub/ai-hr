/**
 * ADR-0038 2F-1 (R18) — leaveBalances lists every active leave type the employee is ELIGIBLE for, even
 * with no accrual or request yet (so the balance list is the full menu, not just types with activity),
 * while excluding types they're not eligible for (e.g. maternity for a male). Tracked types still carry
 * their ledger balance.
 */
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
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

/**
 * Feedback 994a5287 — "Automatically Display All Eligible Leave Types".
 *
 * REPRODUCTION FIRST, and it changed the fix. The item's plan located the root cause in `leaveBalances`
 * selecting only FROM leave_ledger, so that a type with no ledger row could not produce a row. That is NOT
 * true and has not been true since R18: the eligible-no-activity tail above is exactly that behaviour, and
 * the suite has pinned it ever since. Seeding an eligible type with no ledger entry and no request produced
 * a 0.00 row on the admin screen straight away.
 *
 * What DID reproduce is narrower and was not in the ticket: a leave type HR had hidden from EMPLOYEE
 * self-service (7b11f1c1, `visible_to_employee = false`) was ALSO missing from the two ADMIN screens, because
 * both read `leaveBalances` and the gate applied to every caller. The code comment on that gate asserted the
 * opposite — that only /me reached it — which is how it went unnoticed. Hiding a type from employees is a
 * statement about what THEY see; it was never meant to remove the type from HR's own balances screen.
 *
 * These tests pin both halves: the admin read shows the hidden type, and self-service still does not.
 */
describe('994a5287 — a type hidden from self-service still appears on the ADMIN balances read', () => {
  async function hiddenTypeSetup() {
    const emp = await hire('female', 'married');
    await owner.db
      .insert(schema.leaveType)
      .values({
        tenantId: b.tenantId,
        code: 'T_HID',
        name: 'T_HID',
        paid: true,
        counting: 'calendar_days',
        visibleToEmployee: false,
      });
    return emp;
  }

  it('ADMIN (includeHidden) sees the hidden type; self-service does not', async () => {
    const emp = await hiddenTypeSetup();

    const adminNames = new Set(
      (await leaveBalances(adminCtx(b), emp.employmentId, undefined, { includeHidden: true })).map((r) => r.leaveType),
    );
    expect(adminNames.has('T_HID')).toBe(true);
    // The eligible-but-inactive tail keeps working alongside it — this is the part that was already built.
    expect(adminNames.has('T_ANN')).toBe(true);

    // Self-service is UNCHANGED: the default still hides it, so 7b11f1c1 is not weakened.
    const essNames = new Set((await leaveBalances(adminCtx(b), emp.employmentId)).map((r) => r.leaveType));
    expect(essNames.has('T_HID')).toBe(false);
    expect(essNames.has('T_ANN')).toBe(true);
  });

  it('includeHidden does NOT loosen the ELIGIBILITY gate — an ineligible type stays out either way', async () => {
    // The plan is explicit that this is a visibility fix and not an eligibility one: `listEligibleLeaveTypesFor`
    // and `assertEligible` keep their strict-equality contract, under which an employee whose gated attribute
    // is NULL is EXCLUDED (the lawful conservative default). Showing everything to admins must not become a
    // back door around that.
    const male = await hire('male', 'married');
    const names = new Set(
      (await leaveBalances(adminCtx(b), male.employmentId, undefined, { includeHidden: true })).map((r) => r.leaveType),
    );
    expect(names.has('T_MAT')).toBe(false); // female-only type, male employee — still excluded
    expect(names.has('T_PAT')).toBe(true);
  });

  it('a hidden type with NO activity still lists at zero (the two tails compose)', async () => {
    const emp = await hiddenTypeSetup();
    const row = (await leaveBalances(adminCtx(b), emp.employmentId, undefined, { includeHidden: true })).find(
      (r) => r.leaveType === 'T_HID',
    );
    expect(row).toBeDefined();
    expect(row!.balance).toBe(0);
    expect(row!.accrued).toBe(0);
    expect(row!.taken).toBe(0);
    expect(row!.pending).toBe(0);
    expect(row!.available).toBe(0);
  });

  it('the two ADMIN surfaces both opt in, so they cannot tell different stories', () => {
    // Employee Balances and the Personnel profile card are the screens HR uses to answer "what is this
    // person entitled to". One passing includeHidden and the other not would be worse than neither.
    const rows = readFileSync(new URL('../app/leave/employee-balances/rows.ts', import.meta.url), 'utf8');
    const personnel = readFileSync(
      new URL('../app/admin/personnel/[employmentId]/page.tsx', import.meta.url),
      'utf8',
    );
    expect(rows.includes('includeHidden: true')).toBe(true);
    expect(personnel.includes('includeHidden: true')).toBe(true);
    // …and the self-service page must NOT, or hiding a leave type would stop meaning anything.
    const leavePage = readFileSync(new URL('../app/leave/page.tsx', import.meta.url), 'utf8');
    expect(leavePage.includes('includeHidden')).toBe(false);
  });
});
