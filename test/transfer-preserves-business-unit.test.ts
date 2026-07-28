/**
 * transferEmployee dropped the employee's Business Unit on every write.
 *
 * The path is CLOSE+INSERT: the open assignment row is closed and a new dated version inserted. That
 * INSERT carried department, position, cost centre and location forward — but not business_unit_id, so
 * the new version was written with NULL. Nothing surfaced it: no error, no event, no changed label. The
 * value was simply gone from the next version onwards.
 *
 * Both live callers are on the Employment tab (app/admin/personnel/[employmentId]/actions.ts), and
 * neither has any reason to touch a business unit:
 *   setLocationAction  — names ONLY a location
 *   transferAction     — names ONLY a department
 * So an admin changing an employee's office silently unassigned them from their business unit.
 *
 * Found while routing 08913328's Movement work through this writer, which is why the Movement module
 * had stopped using it. Fixed here rather than filed, because the loss is silent and the write is on a
 * screen in daily use — every day it stays unfixed produces more assignment versions to reconcile.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee, transferEmployee } from '../core/org';
import { createBusinessUnit } from '../core/admin';
import { createLocation } from '../core/location';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
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

/** The employment's single open assignment version — what every downstream read resolves against. */
async function openAssignment(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

describe('transferEmployee preserves the business unit it was never asked to change', () => {
  async function employeeWithBusinessUnit() {
    // Through the real service, not a raw insert: the row an admin actually creates is the row whose
    // survival is in question, and a hand-built one could skip a constraint the service applies.
    const bu = await createBusinessUnit(adminCtx(base), {
      companyId: base.companyId,
      code: `BU${randomUUID().slice(0, 4).toUpperCase()}`,
      name: `Business Unit ${randomUUID().slice(0, 6)}`,
    });
    const emp = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Transferee', primaryEmail: `t_${randomUUID().slice(0, 6)}@t.local` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    // Set it directly on the open version: the point of the test is what a LATER transfer does to a
    // stored value, not how it got there.
    await owner.db
      .update(schema.assignment)
      .set({ businessUnitId: bu.id })
      .where(eq(schema.assignment.employmentId, emp.employmentId));
    return { emp, buId: bu.id };
  }

  it('a location change keeps the business unit (the setLocationAction path)', async () => {
    const { emp, buId } = await employeeWithBusinessUnit();
    const loc = await createLocation(adminCtx(base), {
      companyId: base.companyId,
      code: `HQA${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'HQ Annexe',
      country: 'MY',
      state: 'Selangor',
    });

    await transferEmployee(adminCtx(base), {
      employmentId: emp.employmentId,
      effectiveDate: '2026-04-01',
      locationId: loc.id,
    });

    const after = await openAssignment(emp.employmentId);
    expect(after.locationId, 'the requested change took effect').toBe(loc.id);
    expect(after.businessUnitId, 'the business unit was NOT collateral damage').toBe(buId);
  });

  it('a department transfer keeps the business unit (the transferAction path)', async () => {
    const { emp, buId } = await employeeWithBusinessUnit();

    await transferEmployee(adminCtx(base), {
      employmentId: emp.employmentId,
      effectiveDate: '2026-04-01',
      departmentId: base.deptB,
    });

    const after = await openAssignment(emp.employmentId);
    expect(after.departmentId, 'the requested change took effect').toBe(base.deptB);
    expect(after.businessUnitId, 'the business unit was NOT collateral damage').toBe(buId);
  });

  it('survives repeated transfers — the value is carried, not restored once', async () => {
    const { emp, buId } = await employeeWithBusinessUnit();
    for (const [i, date] of ['2026-04-01', '2026-05-01', '2026-06-01'].entries()) {
      await transferEmployee(adminCtx(base), {
        employmentId: emp.employmentId,
        effectiveDate: date,
        departmentId: i % 2 === 0 ? base.deptB : base.deptA,
      });
    }
    expect((await openAssignment(emp.employmentId)).businessUnitId).toBe(buId);
  });

  it('an employee with no business unit still ends up with none — no value invented', async () => {
    const emp = await hireEmployee(adminCtx(base), {
      person: { fullName: 'No BU', primaryEmail: `n_${randomUUID().slice(0, 6)}@t.local` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await transferEmployee(adminCtx(base), {
      employmentId: emp.employmentId,
      effectiveDate: '2026-04-01',
      departmentId: base.deptB,
    });
    expect((await openAssignment(emp.employmentId)).businessUnitId).toBeNull();
  });
});
