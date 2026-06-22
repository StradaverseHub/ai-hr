/**
 * ADR-0038 2C (#18) — state-specific holidays. A working-day leave count excludes national holidays plus
 * the holidays of the employee's effective work state (employment.work_state, falling back to the
 * company default, then national-only). So two employees taking the same dates can lawfully get
 * different day counts — the bug #18 was about.
 *
 * Window: Mon 2026-07-20 → Fri 2026-07-24 = 5 working days. A national holiday (Tue 21st) applies to
 * everyone; a Sarawak holiday (Wed 22nd) applies only to Sarawak.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let wdTypeId: string;

const hire = async (workState: string | null) => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'WS', primaryEmail: `ws_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  if (workState) await owner.db.update(schema.employment).set({ workState }).where(eq(schema.employment.id, e.employmentId));
  return e;
};
const daysFor = async (employmentId: string) =>
  (await requestLeave(adminCtx(b), { employmentId, leaveTypeId: wdTypeId, startDate: '2026-07-20', endDate: '2026-07-24' })).days;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code: 'WD', name: 'Working-day leave', paid: true, counting: 'working_days' })
    .returning({ id: schema.leaveType.id });
  wdTypeId = lt.id;
  await owner.db.insert(schema.holiday).values([
    { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: '2026-07-21', name: 'National Holiday' },
    { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: '2026-07-22', name: 'Sarawak Day' },
  ]);
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0038 2C — state-specific holidays', () => {
  it('excludes the state holiday only for employees working in that state', async () => {
    const sarawak = await hire('Sarawak');
    const selangor = await hire('Selangor');
    expect(await daysFor(sarawak.employmentId)).toBe(3); // 5 − national − Sarawak
    expect(await daysFor(selangor.employmentId)).toBe(4); // 5 − national only
  });

  it('falls back to the company default work state when the employee has none', async () => {
    const emp = await hire(null);
    await owner.db.update(schema.company).set({ defaultWorkState: 'Sarawak' }).where(eq(schema.company.id, b.companyId));
    expect(await daysFor(emp.employmentId)).toBe(3); // inherits Sarawak via the company default
  });

  it('applies national holidays only when neither work state nor company default is set', async () => {
    const emp = await hire(null);
    await owner.db.update(schema.company).set({ defaultWorkState: null }).where(eq(schema.company.id, b.companyId));
    expect(await daysFor(emp.employmentId)).toBe(4); // national only
  });
});
