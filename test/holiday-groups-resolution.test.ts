/**
 * Holiday grouping — resolution correctness. A working-day leave count excludes national holidays plus
 * the holidays of the employee's effective STATE SET. The set is the assigned group's member states (a
 * NAMED bundle), else a single work_state, else the company default, else national-only.
 *
 * This is the correctness proof the over-counting bug needed:
 *  (a) a group CONTAINING Sarawak excludes Sarawak Day; a group NOT containing it does not;
 *  (c) the group path and the state path resolve IDENTICALLY for the same calendar (they feed one
 *      predicate and cannot diverge);
 *  + the XOR invariant (service nulls the other column; the DB CHECK rejects a direct both-set write).
 *
 * Window: Mon 2026-07-20 → Fri 2026-07-24 = 5 working days. National holiday (Tue 21st) applies to
 * everyone; a Sarawak holiday (Wed 22nd) applies only to Sarawak.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createHolidayGroup } from '../core/admin';
import { hireEmployee, setEmploymentHolidayCalendar } from '../core/org';
import { requestLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let wdTypeId: string;

const hire = async () => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'R', primaryEmail: `r_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
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
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'WD', name: 'Working-day leave', paid: true, counting: 'working_days' })
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

describe('holiday-group resolution', () => {
  it('(a) a group CONTAINING the state excludes its holiday; one NOT containing it does not', async () => {
    const east = await createHolidayGroup(adminCtx(b), { name: 'East MY', states: ['Sabah', 'Sarawak', 'Labuan'] });
    const peninsular = await createHolidayGroup(adminCtx(b), { name: 'Peninsular', states: ['Selangor', 'Johor'] });

    const inSarawak = await hire();
    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: inSarawak, selection: { kind: 'group', groupId: east.id } });
    const notSarawak = await hire();
    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: notSarawak, selection: { kind: 'group', groupId: peninsular.id } });

    expect(await daysFor(inSarawak)).toBe(3); // 5 − national − Sarawak Day
    expect(await daysFor(notSarawak)).toBe(4); // 5 − national only (Sarawak Day still a working day)
  });

  it('(c) the group path and the state path resolve IDENTICALLY for the same calendar', async () => {
    const onlySarawak = await createHolidayGroup(adminCtx(b), { name: 'Just Sarawak', states: ['Sarawak'] });
    const viaGroup = await hire();
    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: viaGroup, selection: { kind: 'group', groupId: onlySarawak.id } });
    const viaState = await hire();
    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: viaState, selection: { kind: 'state', state: 'Sarawak' } });

    const g = await daysFor(viaGroup);
    const s = await daysFor(viaState);
    expect(g).toBe(s); // one predicate, cannot diverge
    expect(g).toBe(3);
  });

  it('(d) an employee with neither group nor work-state (and no company default) resolves national-only', async () => {
    const emp = await hire();
    await owner.db.update(schema.company).set({ defaultWorkState: null }).where(eq(schema.company.id, b.companyId));
    expect(await daysFor(emp)).toBe(4); // national only
  });
});

describe('holiday-group XOR invariant', () => {
  it('selecting a group nulls work_state, and vice-versa', async () => {
    const g = await createHolidayGroup(adminCtx(b), { name: 'East', states: ['Sabah', 'Sarawak'] });
    const emp = await hire();

    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: emp, selection: { kind: 'state', state: 'Sarawak' } });
    let [row] = await owner.db
      .select({ ws: schema.employment.workState, hg: schema.employment.holidayGroupId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    expect(row.ws).toBe('Sarawak');
    expect(row.hg).toBeNull();

    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: emp, selection: { kind: 'group', groupId: g.id } });
    [row] = await owner.db
      .select({ ws: schema.employment.workState, hg: schema.employment.holidayGroupId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    expect(row.ws).toBeNull();
    expect(row.hg).toBe(g.id);

    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: emp, selection: { kind: 'none' } });
    [row] = await owner.db
      .select({ ws: schema.employment.workState, hg: schema.employment.holidayGroupId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    expect(row.ws).toBeNull();
    expect(row.hg).toBeNull();
  });

  it('the DB CHECK rejects a direct owner.db write that sets BOTH work_state and holiday_group_id', async () => {
    const g = await createHolidayGroup(adminCtx(b), { name: 'East', states: ['Sabah'] });
    const emp = await hire();
    await expect(
      owner.db
        .update(schema.employment)
        .set({ workState: 'Sarawak', holidayGroupId: g.id })
        .where(eq(schema.employment.id, emp)),
    ).rejects.toThrow();
  });
});
