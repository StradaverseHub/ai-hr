/**
 * ADR-0038 2A-1 (#25) — leave eligibility. A leave type's eligibility { gender?, maritalStatus?,
 * minServiceMonths? } gates requestLeave: maternity is female-only (EA s.37), paternity needs a married
 * male with ≥12 months service (EA s.60FA). A type with no eligibility is open to everyone — the gate
 * only mirrors what the Act restricts, so it never blocks a lawful entitlement.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { LeaveIneligibleError, requestLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const req = (employmentId: string, leaveTypeId: string) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId, startDate: '2026-07-01', endDate: '2026-07-01' });

async function hire(gender: string, marital: string, hiredOn: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Elig', primaryEmail: `elig_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await owner.db.update(schema.person).set({ gender, maritalStatus: marital }).where(eq(schema.person.id, e.personId));
  return e;
}
async function leaveType(code: string, eligibility: unknown) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: code, paid: true, counting: 'calendar_days', eligibility })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

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

describe('ADR-0038 2A-1 — leave eligibility', () => {
  it('maternity is female-only', async () => {
    const maternity = await leaveType('MATERNITY', { gender: 'female' });
    const female = await hire('female', 'married', '2024-01-01');
    const male = await hire('male', 'married', '2024-01-01');
    await expect(req(female.employmentId, maternity)).resolves.toMatchObject({ days: 1 });
    await expect(req(male.employmentId, maternity)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('paternity needs a married male with ≥12 months service', async () => {
    const pat = await leaveType('PATERNITY', { gender: 'male', maritalStatus: 'married', minServiceMonths: 12 });
    const eligible = await hire('male', 'married', '2024-01-01'); // 30 months by Jul 2026
    const unmarried = await hire('male', 'single', '2024-01-01');
    const female = await hire('female', 'married', '2024-01-01');
    const junior = await hire('male', 'married', '2026-06-01'); // 1 month
    await expect(req(eligible.employmentId, pat)).resolves.toMatchObject({ days: 1 });
    await expect(req(unmarried.employmentId, pat)).rejects.toBeInstanceOf(LeaveIneligibleError);
    await expect(req(female.employmentId, pat)).rejects.toBeInstanceOf(LeaveIneligibleError);
    await expect(req(junior.employmentId, pat)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('a type with no eligibility is open to everyone', async () => {
    const open = await leaveType('OPEN', null);
    const anyone = await hire('male', 'single', '2026-06-01');
    await expect(req(anyone.employmentId, open)).resolves.toMatchObject({ days: 1 });
  });
});
