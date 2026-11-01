import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, withTenant } from '../db/client';
import * as schema from '../db/schema';
import { readSessionPolicyEditor, saveSessionPolicy } from '../core/session-policy';
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from '../lib/session-policy';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); afterAll(closeAll); beforeEach(async () => { await resetDb(); b = await seedBase(); });
const groupCtx = () => ({ ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] });
const limitFor = async (tenantId: string) =>
  Number((await client.unsafe('select app.session_idle_timeout_minutes($1::uuid) as minutes', [tenantId]))[0].minutes);

describe('ADR-0171 idle sign-out policy, owned by the group administrator', () => {
  it('defaults to 15 minutes, saves, reopens, exposes only the limit and audits the change', async () => {
    const ctx = groupCtx();
    expect(await readSessionPolicyEditor(ctx)).toEqual({ revision: 0, idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES });
    expect(await limitFor(b.tenantId)).toBe(15);
    expect(await saveSessionPolicy(ctx, '30', 0)).toEqual({ revision: 1, idleTimeoutMinutes: 30 });
    expect(await readSessionPolicyEditor(ctx)).toEqual({ revision: 1, idleTimeoutMinutes: 30 });
    expect(await limitFor(b.tenantId)).toBe(30);
    const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId, b.tenantId)).orderBy(schema.domainEvent.sequence);
    expect(events.find(event => event.eventType === 'session-policy.updated'))
      .toMatchObject({ actorId: ctx.userId, payload: { revision: 1, idleTimeoutMinutes: 30, previousIdleTimeoutMinutes: 15 } });
  });

  it('accepts exactly 5 to 480 whole minutes and has no way to switch the limit off', async () => {
    const ctx = groupCtx();
    for (const value of [4, 481, 0, -1, 15.5, '', 'off', null, '1e2', ' 20x']) await expect(saveSessionPolicy(ctx, value, 0)).rejects.toThrow('invalid');
    await saveSessionPolicy(ctx, 5, 0);
    await saveSessionPolicy(ctx, 480, 1);
    expect((await readSessionPolicyEditor(ctx)).idleTimeoutMinutes).toBe(480);
    // The table refuses out-of-range values even from the owner role.
    await expect(owner.db.update(schema.sessionPolicy).set({ idleTimeoutMinutes: 0 }).where(eq(schema.sessionPolicy.tenantId, b.tenantId))).rejects.toThrow();
  });

  it('refuses ordinary and company-scoped administrators, forged grants and a revoked group grant', async () => {
    const [person] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional idle viewer', primaryEmail: 'fictional.idle@example.test' }).returning();
    const employeeId = await createAppUser(b.tenantId, person.id, 'employee');
    const employee = { ...adminCtx(b), userId: employeeId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await expect(saveSessionPolicy(employee, 30, 0)).rejects.toThrow('forbidden');
    await expect(readSessionPolicyEditor(employee)).rejects.toThrow('forbidden');
    await expect(saveSessionPolicy({ ...employee, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: b.companyId }] }, 30, 0)).rejects.toThrow('forbidden');
    await expect(saveSessionPolicy({ ...employee, roles: ['super_admin'], grants: [{ role: 'super_admin', companyId: null }] }, 30, 0)).rejects.toThrow('forbidden');
    const ctx = groupCtx();
    await owner.db.update(schema.roleAssignment).set({ role: 'employee' }).where(eq(schema.roleAssignment.appUserId, ctx.userId!));
    await expect(saveSessionPolicy(ctx, 30, 0)).rejects.toThrow('forbidden');
    expect(await limitFor(b.tenantId)).toBe(15);
  });

  it('prevents stale overwrites and any read or write of another organization', async () => {
    const ctx = groupCtx();
    await saveSessionPolicy(ctx, 20, 0);
    await expect(saveSessionPolicy(ctx, 25, 0)).rejects.toThrow('conflict');
    const [foreign] = await owner.db.insert(schema.tenant).values({ workosOrgId: 'org_session_policy_foreign', name: 'Fictional foreign tenant' }).returning();
    expect(await withTenant(ctx, tx => tx.select().from(schema.sessionPolicy).where(eq(schema.sessionPolicy.tenantId, foreign.id)))).toEqual([]);
    await expect(withTenant(ctx, tx => tx.insert(schema.sessionPolicy).values({ tenantId: foreign.id, idleTimeoutMinutes: 480, revision: 1 }))).rejects.toThrow();
    expect(await limitFor(foreign.id)).toBe(15);
    expect(await limitFor(b.tenantId)).toBe(20);
  });
});
