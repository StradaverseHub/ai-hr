/**
 * Feedback c4339f4c — "My Leave → Leave History only displays Annual Leave applications."
 *
 * REPRODUCTION ATTEMPT. This file is the check the plan asked for before any change: the two candidate causes
 * (a genuine leave-type predicate in the read, versus an employee who has only ever applied for Annual Leave)
 * need opposite fixes, and three earlier reports on this product turned out to be correct code.
 *
 * The self-service Leave History on /leave reads core/read.ts `listLeaveRequests`, keeps the rows whose
 * personId is the viewer's, and sorts them by start date. There is no leave-type predicate anywhere on that
 * path — so this seeds ONE employee with SIX different leave types and asserts all six come back. It passes
 * as written, which is the finding: the read is not filtered, and a history showing only Annual Leave is a
 * statement about that employee's applications, not about this code.
 *
 * Kept rather than deleted, because "no type filter" is the property that was reported broken and nothing
 * else pins it: a future filter added to listLeaveRequests (a default, a leftover predicate from the admin
 * paginated read) would silently reproduce the report, and this fails the moment it does.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { listLeaveRequests } from '../core/read';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hireEmployeeCtx(name: string): Promise<{ ctx: SessionContext; employmentId: string; personId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `hist_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId, personId };
}

/** Calendar-counted so every request is a plain one-day row — the question here is which ROWS come back. */
async function leaveType(code: string, name: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `${code}_${randomUUID().slice(0, 6).toUpperCase().replace(/-/g, '')}`,
      name,
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true, // no ledger seeded — the read under test does not care about balances
      visibleToEmployee: true,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

// The reporter's list: "Annual Leave, Medical Leave, Emergency Leave, Compassionate Leave, Maternity Leave,
// Hospitalization Leave, Marriage Leave, Examination Leave, etc." EMERGENCY is deliberately NOT among them —
// it decomposes into ANNUAL/UNPAID children (0106) and is a separate, already-documented display rule.
const TYPES = [
  ['ANN', 'Annual Leave'],
  ['MED', 'Medical Leave'],
  ['COMP', 'Compassionate Leave'],
  ['HOSP', 'Hospitalization Leave'],
  ['MARR', 'Marriage Leave'],
  ['EXAM', 'Examination Leave'],
] as const;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('c4339f4c · self-service Leave History is not filtered by leave type', () => {
  it('returns every type the employee applied for, not just Annual Leave', async () => {
    const { ctx, employmentId, personId } = await hireEmployeeCtx('History');
    const created: { id: string; name: string; startDate: string }[] = [];
    for (const [i, [code, name]] of TYPES.entries()) {
      const typeId = await leaveType(code, name);
      const day = `2026-06-0${i + 1}`;
      await requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: day, endDate: day });
      created.push({ id: typeId, name, startDate: day });
    }

    // Exactly what app/leave/page.tsx does on the self-service branch: the unfiltered read, narrowed to the
    // viewer's own rows, newest first by start date.
    const rows = (await listLeaveRequests(ctx, [b.companyId])).filter((r) => r.personId === personId);
    const mine = [...rows].sort((a, c) => c.startDate.localeCompare(a.startDate));

    expect(mine).toHaveLength(TYPES.length);
    expect(new Set(mine.map((r) => r.leaveType))).toEqual(new Set(created.map((c) => c.name)));
    // Chronological, newest first — the ordering the item asks for alongside the completeness.
    expect(mine.map((r) => r.startDate)).toEqual([...created].reverse().map((c) => c.startDate));
  });

  it('an employee who only applied for Annual Leave sees only Annual Leave — the OTHER explanation', async () => {
    // The same read, same page, one applicant: a single-type history is a fact about the applications, not a
    // filter. Pinned so the two causes stay distinguishable if this is reported again.
    const { ctx, employmentId, personId } = await hireEmployeeCtx('AnnualOnly');
    const annual = await leaveType('ANN', 'Annual Leave');
    await leaveType('MED', 'Medical Leave'); // exists in the catalog, never applied for
    await requestLeave(ctx, { employmentId, leaveTypeId: annual, startDate: '2026-06-01', endDate: '2026-06-01' });

    const mine = (await listLeaveRequests(ctx, [b.companyId])).filter((r) => r.personId === personId);
    expect(mine.map((r) => r.leaveType)).toEqual(['Annual Leave']);
  });
});
