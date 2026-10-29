/** Real canonical-reader authorization cases, authored UNRUN. Namespace aip_agents. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { withAssistantRead, type AssistantReadSession } from '../core/assistant-read-session';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { hireEmployee } from '../core/org';
import * as canonical from '../core/read';
import { runModuleReadPlan } from './module-read-plan';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, resetDb, seedBase, setModule, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'assistant', 'active'); });
afterAll(closeAll);
async function fixture() {
  const admin = adminCtx(base);
  const make = (name: string) => hireEmployee(admin, { person: { fullName: name, primaryEmail: `${randomUUID()}@fixture.test` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  const mine = await make('Fictional Module Owner'), peer = await make('Never Disclose Peer');
  const userId = await createAppUser(base.tenantId, mine.personId, 'employee');
  await grantAssistant(admin, { appUserId: userId });
  const ctx: SessionContext = { ...await entitledCtx(base, ['employee']), userId, personId: mine.personId,
    roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  return { admin, ctx, mine, peer };
}
describe('canonical module agents use the existing closed Assistant carrier', () => {
  it('reads own profiles and readiness through one real readonly backend without disclosing peers or identifiers', async () => {
    const { ctx, mine, peer } = await fixture();
    const original = canonical.myOwnEmploymentSubjectsTx;
    const backends: number[] = [];
    const source = vi.spyOn(canonical, 'myOwnEmploymentSubjectsTx').mockImplementation(async (tx, current, ...args) => {
      const [carrier] = await tx.execute<{ pid: number; mode: string; actor: string }>(sql`select pg_backend_pid() as pid,
        current_setting('transaction_read_only') as mode,app.current_user_id() as actor`);
      expect(carrier.mode).toBe('on'); expect(carrier.actor).toBe(ctx.userId); backends.push(carrier.pid);
      return original(tx, current, ...args);
    });
    try {
      const result = await runModuleReadPlan(ctx, { version: 1, modules: ['employees', 'ess'] });
      const text = JSON.stringify(result);
      expect(text).toContain(mine.employmentId); expect(text).not.toContain(peer.employmentId);
      expect(text).not.toContain('Never Disclose Peer'); expect(text).not.toMatch(/icNumber|passport|bankAccount|primaryEmail/);
      expect(new Set(backends).size).toBe(1); expect(backends.length).toBeGreaterThanOrEqual(2);
    } finally { source.mockRestore(); }
  });
  it('rejects forged principals, escaped readers and revoked Assistant authority', async () => {
    const { admin, ctx } = await fixture();
    let escaped: AssistantReadSession | undefined;
    await withAssistantRead(ctx, null, async read => { escaped = read; await read.moduleWork('employees'); });
    await expect(escaped!.moduleWork('employees')).rejects.toThrow('data access');
    await expect(runModuleReadPlan({ ...ctx, personId: randomUUID() }, { version: 1, modules: ['employees'] })).rejects.toThrow('data access');
    await revokeAssistant(admin, { appUserId: ctx.userId! });
    await expect(runModuleReadPlan(ctx, { version: 1, modules: ['employees'] })).rejects.toThrow();
  });
  it('checks the requested module freshly rather than trusting the offered generic tool', async () => {
    const { ctx } = await fixture();
    await setModule(base.tenantId, 'attendance', 'disabled');
    await expect(runModuleReadPlan(ctx, { version: 1, modules: ['attendance'] })).rejects.toThrow();
  });
});
