/**
 * 03877e — A TRANSFER DATED BEFORE THE CURRENT SALARY RECORD IS REFUSED WITH THAT DATE.
 *
 * Production, 5 Nov 2026: HR recorded a Transfer with a pay change effective 1 Jan 2024 for an employee whose
 * open salary record started later. setCompensation tried to end that record before it began, Postgres
 * refused the inverted daterange, and HR saw "One of the values entered is not allowed here" six times.
 * The service now refuses first, naming the day the current salary starts, and the whole movement rolls
 * back — no leg of it is half-applied.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { SalaryBeforeCurrentRecordError, setCompensation } from '../core/comp';
import { createMovementEvent } from '../core/movement';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

async function hiredWithSalaryFrom(salaryFrom: string) {
  const hire = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Backdated Transfer', primaryEmail: `bt_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2023-01-01',
  });
  await setCompensation(adminCtx(b), { employmentId: hire.employmentId, basicSalary: 4000, effectiveFrom: salaryFrom });
  return hire.employmentId;
}

const openSalary = async (employmentId: string) =>
  owner.db
    .select()
    .from(schema.compensation)
    .where(
      and(
        eq(schema.compensation.employmentId, employmentId),
        isNull(schema.compensation.validTo),
        isNull(schema.compensation.supersededAt),
      ),
    );

const openDepartment = async (employmentId: string) => {
  const [row] = await owner.db
    .select({ departmentId: schema.assignment.departmentId })
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    );
  return row?.departmentId;
};

describe('03877e — backdated pay change against a later salary record', () => {
  it('a Transfer with a pay change before the current salary starts is refused with that start date, and nothing is applied', async () => {
    const employmentId = await hiredWithSalaryFrom('2025-06-01');

    const attempt = createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: '2024-01-01',
      departmentId: b.deptB,
      basicSalary: 4500,
      remarks: 'Backdated transfer',
    });
    await expect(attempt).rejects.toBeInstanceOf(SalaryBeforeCurrentRecordError);
    await expect(attempt).rejects.toMatchObject({ currentStart: '2025-06-01' });

    const open = await openSalary(employmentId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ validFrom: '2025-06-01', validTo: null });
    expect(Number(open[0].basicSalary)).toBe(4000);
    // The department leg ran before the salary leg; the refusal rolled it back with everything else.
    expect(await openDepartment(employmentId)).toBe(b.deptA);
  });

  it('the same Transfer dated on or after the current salary start still saves', async () => {
    const employmentId = await hiredWithSalaryFrom('2025-06-01');
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: '2025-07-01',
      departmentId: b.deptB,
      basicSalary: 4500,
      remarks: 'Transfer after the salary start',
    });
    const open = await openSalary(employmentId);
    expect(open).toHaveLength(1);
    expect(open[0].validFrom).toBe('2025-07-01');
    expect(Number(open[0].basicSalary)).toBe(4500);
    expect(await openDepartment(employmentId)).toBe(b.deptB);
  });

  it('setCompensation itself refuses a start before the open record, before touching the database row', async () => {
    const employmentId = await hiredWithSalaryFrom('2025-06-01');
    await expect(
      setCompensation(adminCtx(b), { employmentId, basicSalary: 5000, effectiveFrom: '2025-05-31' }),
    ).rejects.toMatchObject({ name: 'SalaryBeforeCurrentRecordError', currentStart: '2025-06-01' });
    expect(await openSalary(employmentId)).toMatchObject([{ validFrom: '2025-06-01', validTo: null }]);
  });
});
