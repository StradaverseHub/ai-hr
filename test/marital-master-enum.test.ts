/**
 * #12129e77 — Marital status options (master enum).
 *
 * The item expands the CENTRALIZED marital-status master list (core/profile.ts MARITAL_STATUSES) to add
 * divorced / widowed / separated, and de-dups the leave-eligibility validator so it draws from that same
 * list (core/admin.ts ELIGIBILITY_MARITAL_OPTIONS = MARITAL_STATUSES). This proves:
 *   1. the master list carries the three new real-world values (+ retains legacy 'single/married/other');
 *   2. the eligibility validator is provably the SAME list (consistency requirement);
 *   3. updateLeaveType accepts a 'divorced' rule and rejects a non-master value (write-path validation);
 *   4. requestLeave lets a 'divorced' employee through the gate and blocks a 'married' one — i.e. a rule
 *      for a new value actually matches a matching profile value (the item's "not a dead option" ask), and
 *      re-evaluation is live because the gate reads the current person row at request time.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType, ELIGIBILITY_MARITAL_OPTIONS } from '../core/admin';
import { MARITAL_STATUSES } from '../core/profile';
import { LeaveIneligibleError, requestLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const req = (employmentId: string, leaveTypeId: string) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId, startDate: '2026-07-01', endDate: '2026-07-01' });

async function hire(marital: string | null) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'M', primaryEmail: `m_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await owner.db.update(schema.person).set({ maritalStatus: marital }).where(eq(schema.person.id, e.personId));
  return e;
}

async function leaveType(code: string, eligibility: unknown) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code, name: code, paid: true, counting: 'calendar_days', eligibility })
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

describe('#12129e77 marital master enum', () => {
  it('master list carries the new + legacy values', () => {
    for (const v of ['single', 'married', 'divorced', 'widowed', 'separated', 'other']) {
      expect(MARITAL_STATUSES).toContain(v);
    }
  });

  it('eligibility validator is the same master list (centralized, not a divergent copy)', () => {
    expect(ELIGIBILITY_MARITAL_OPTIONS).toBe(MARITAL_STATUSES);
  });

  it('updateLeaveType accepts a divorced rule and rejects a non-master value', async () => {
    const t = await leaveType('COMPASSION', null);
    const ctx = adminCtx(b);
    await updateLeaveType(ctx, { id: t, name: 'Compassion', eligibility: { maritalStatus: 'divorced' } });
    const [row] = await owner.db
      .select({ e: schema.leaveType.eligibility })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, t));
    expect(row.e).toEqual({ maritalStatus: ['divorced'] }); // #badc5966 array shape
    // a value outside the master list is rejected
    await expect(
      updateLeaveType(ctx, { id: t, name: 'Compassion', eligibility: { maritalStatus: 'annulled' } as never }),
    ).rejects.toThrow();
  });

  it('a divorced rule matches a divorced employee and blocks a married one (live re-evaluation)', async () => {
    const t = await leaveType('DIVLEAVE', null);
    await updateLeaveType(adminCtx(b), {
      id: t,
      name: 'Div',
      eligibility: { maritalStatus: ['divorced', 'widowed', 'separated'] },
    });
    const divorced = await hire('divorced');
    const widowed = await hire('widowed');
    const married = await hire('married');
    await expect(req(divorced.employmentId, t)).resolves.toMatchObject({ days: 1 });
    await expect(req(widowed.employmentId, t)).resolves.toMatchObject({ days: 1 });
    await expect(req(married.employmentId, t)).rejects.toBeInstanceOf(LeaveIneligibleError);

    // Re-evaluation is live: flip the married person to separated and the same gate now admits them.
    await owner.db
      .update(schema.person)
      .set({ maritalStatus: 'separated' })
      .where(eq(schema.person.id, married.personId));
    await expect(req(married.employmentId, t)).resolves.toMatchObject({ days: 1 });
  });
});
