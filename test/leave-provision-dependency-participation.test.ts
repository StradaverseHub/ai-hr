/** Owner bootstrap/configuration and read-only reset guard cases authored UNRUN. Never runs seed.ts,
 * never truncates, and never deletes fixture/canonical custody data to simulate an empty database. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as s from '../db/schema';
import { seedTenantCatalogs } from '../db/provision';
import { lockOwnerTenantCatalogsTx } from '../db/provision-ownership';
import { assertAiCustodyResetAllowed, AI_CUSTODY_RESET_REFUSAL } from '../db/seed-ai-custody-guard';
import { hireEmployee } from '../core/org';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);
async function state() { return {
  types: await owner.db.select().from(s.leaveType).where(eq(s.leaveType.tenantId, b.tenantId)).orderBy(s.leaveType.id),
  holidays: await owner.db.select().from(s.holiday).where(eq(s.holiday.tenantId, b.tenantId)).orderBy(s.holiday.id),
  events: await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId, b.tenantId)).orderBy(s.domainEvent.id),
}; }
describe('injected owner catalog bootstrap interval', () => {
  it('refuses before catalog effects during a real employee interval, rolls back, then seeds after release', async () => {
    const subject = await hireEmployee(adminCtx(b), { person: { fullName: 'Fictional Bootstrap Subject', primaryEmail: randomUUID()+'@fixture.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
    await owner.db.update(s.leaveType).set({ code: 'FIXTURE_BASE_ANNUAL' }).where(eq(s.leaveType.id, b.annualLeaveTypeId));
    let ready!: () => void, fail!: (e: unknown) => void, release!: () => void;
    const start = new Promise<void>((yes,no) => { ready=yes; fail=no; });
    const finish = new Promise<void>(yes => { release=yes; });
    const timer = setTimeout(() => { fail(Error('bootstrap interval handshake timed out')); release(); }, 10000);
    const held = withTenant(adminCtx(b), async tx => { await lockLeaveDependenciesTx(tx,b.tenantId,[subject.employmentId]); ready(); await finish; }); void held.catch(fail);
    try {
      await start; const before = await state();
      await expect(owner.db.transaction(tx => seedTenantCatalogs(tx,b.tenantId))).rejects.toThrow('Tenant catalogs are busy or unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(timer); await held; }
    const ids = await owner.db.transaction(tx => seedTenantCatalogs(tx,b.tenantId));
    expect(ids.ANNUAL).toBeTruthy();
    const after = await state(); expect(after.types.some(row => row.id === ids.ANNUAL && row.code === 'ANNUAL')).toBe(true);
    expect(after.holidays.length).toBeGreaterThan(0);
  });
  it('retains generated uncommitted tenant bootstrap without an invented app principal', async () => {
    await owner.db.transaction(async tx => {
      const [tenant] = await tx.insert(s.tenant).values({name:'Fictional Uncommitted Bootstrap',workosOrgId:'org_fixture_'+randomUUID()}).returning({id:s.tenant.id});
      const ids = await seedTenantCatalogs(tx,tenant.id);
      expect(ids.ANNUAL).toBeTruthy();
    });
  });
  it('rejects an ordinary app role even when it knows the tenant UUID', async () => {
    await expect(withTenant(adminCtx(b), tx => lockOwnerTenantCatalogsTx(tx,b.tenantId))).rejects.toThrow('Tenant catalogs are busy or unavailable');
  });
  it('refuses an existing application tenant when custody storage exists, without touching it', async () => {
    const rollback = Error('rollback synthetic custody schema only');
    await expect(owner.db.transaction(async tx => {
      // The canonical migration may already supply this table; otherwise this test creates only an
      // empty schema sentinel inside a transaction which is deliberately rolled back.
      await tx.execute(sql`create table if not exists app.assistant_own_leave_review (fixture_marker boolean)`);
      const before = await tx.select().from(s.tenant).orderBy(s.tenant.id);
      await expect(assertAiCustodyResetAllowed(tx)).rejects.toThrow(AI_CUSTODY_RESET_REFUSAL);
      expect(await tx.select().from(s.tenant).orderBy(s.tenant.id)).toEqual(before);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
