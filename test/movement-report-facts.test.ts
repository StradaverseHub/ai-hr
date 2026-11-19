import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../db/client';
import { domainEvent } from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createMovementEvent, movementHistory, movementReportFactsTx, reverseMovementEvent } from '../core/movement';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);
const day = (offset: number) => new Date(Date.parse(todayInKualaLumpur() + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
async function hire(code: string) {
  const ctx = adminCtx(b);
  const { employmentId } = await hireEmployee(ctx, {
    person: { fullName: 'Fictional report ' + code, primaryEmail: `${randomUUID()}@fixture.test` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: day(-60), employeeCode: code,
  });
  await setCompensation(ctx, { employmentId, basicSalary: 3000, effectiveFrom: day(-60) });
  return employmentId;
}
const visibleFacts = (row: { id: string; kind: string; effectiveDate: string; endDate: string | null; status: string; remarks: string | null }) => ({
  id: row.id, kind: row.kind, effectiveDate: row.effectiveDate, endDate: row.endDate, status: row.status, remarks: row.remarks,
});
describe('batched report lifecycle facts reuse Employment History', () => {
  it('matches applied, pending and reversed rows for multiple employments with bounded query count and no writes', async () => {
    const ctx = adminCtx(b), first = await hire('REPORT-ONE'), second = await hire('REPORT-TWO');
    await createMovementEvent(ctx, { employmentId: first, kind: 'increment', effectiveDate: day(-5), basicSalary: 3100, remarks: 'Recorded increase' });
    const applied = (await movementHistory(ctx, first)).find(row => row.kind === 'increment')!;
    await reverseMovementEvent(ctx, { employmentId: first, movementId: applied.id, reason: 'Fictional reversal' });
    await createMovementEvent(ctx, { employmentId: second, kind: 'promotion', effectiveDate: day(5), basicSalary: 3200, remarks: 'Pending increase' });
    const before = await owner.db.select().from(domainEvent).where(eq(domainEvent.tenantId, b.tenantId));
    const expected = await Promise.all([first, second].map(async id => ({ employmentId: id, rows: (await movementHistory(ctx, id)).map(visibleFacts) })));
    const actual = await withTenant(ctx, async tx => {
      const spy = vi.spyOn(tx, 'select');
      try {
        const facts = await movementReportFactsTx(tx, ctx.tenantId, [first, second, first]);
        expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
        return facts;
      } finally { spy.mockRestore(); }
    }, { readOnlySnapshot: true });
    for (const expectedEmployee of expected) {
      const actualEmployee = actual.find(employee => employee.employmentId === expectedEmployee.employmentId)!;
      expect(actualEmployee.rows.map(visibleFacts)).toEqual(expectedEmployee.rows);
    }
    expect(actual.find(employee => employee.employmentId === first)?.rows.find(row => row.kind === 'increment')?.status).toBe('reversed');
    expect(actual.find(employee => employee.employmentId === second)?.rows.find(row => row.kind === 'promotion')?.status).toBe('pending');
    expect(await owner.db.select().from(domainEvent).where(eq(domainEvent.tenantId, b.tenantId))).toEqual(before);
  });
  it('returns no facts for an empty scope and refuses an excessive scope before querying', async () => {
    await withTenant(adminCtx(b), async tx => {
      const spy = vi.spyOn(tx, 'select');
      try {
        expect(await movementReportFactsTx(tx, b.tenantId, [])).toEqual([]);
        await expect(movementReportFactsTx(tx, b.tenantId, Array.from({ length: 10001 }, () => randomUUID()))).rejects.toThrow(/10000/);
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });
  });
});
