/** Actual workspace principal/grant/history custody cases, authored UNRUN. No provider requests. */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiWorkspace } from '../core/ai-workspace';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { ASSISTANT_TOOLS } from '../core/assistant-tools';
import { AI_WORKSPACE_TASKS } from '../lib/ai/workspace-tasks';
import { MODULE_CATALOG } from '../packs/catalog';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'assistant', 'active'); });
afterAll(closeAll);
async function grant() { const ctx = adminCtx(base); await grantAssistant(ctx, { appUserId: ctx.userId! }); return ctx; }
const exchange = (tenantId: string, appUserId: string, text: string) => owner.db.insert(schema.assistantExchange)
  .values({ tenantId, appUserId, question: text, answer: text, stop: 'end' }).returning({ id: schema.assistantExchange.id });

describe('actual AI workspace source read', () => {
  it('keeps personal history separate from broad HR visibility and other tenants', async () => {
    const ctx = await grant();
    const other = await seedBase();
    const [otherUser] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: 'fictional-workspace-other' }).returning({ id: schema.appUser.id });
    await exchange(base.tenantId, otherUser.id, 'OTHER_USER_PRIVATE_SENTINEL');
    await exchange(other.tenantId, other.adminUserId, 'OTHER_TENANT_PRIVATE_SENTINEL');
    const [mine] = await exchange(base.tenantId, ctx.userId!, 'MY_OWN_EXCHANGE');
    const workspace = await loadAiWorkspace(ctx);
    expect(workspace.access).toEqual({ allowed: true });
    expect(workspace.history.map(item => item.id)).toEqual([mine.id]);
    expect(JSON.stringify(workspace)).not.toContain('OTHER_');
    expect(workspace).not.toHaveProperty('apiKey');
    expect(workspace).not.toHaveProperty('providerOptions');
  });
  it('bounds personal history to ten records in a stable newest-first order', async () => {
    const ctx = await grant();
    const ids: string[] = [];
    for (let index = 0; index < 12; index++) {
      const [row] = await owner.db.insert(schema.assistantExchange).values({ tenantId: base.tenantId,
        appUserId: ctx.userId!, question: `Own ${index}`, askedAt: new Date(Date.UTC(2026, 0, index + 1)) }).returning({ id: schema.assistantExchange.id });
      ids.push(row.id);
    }
    expect((await loadAiWorkspace(ctx)).history.map(row => row.id)).toEqual(ids.slice(2).reverse());
  });
  it('resolves actual current modules, not a retained snapshot, before advertising jobs', async () => {
    await setModule(base.tenantId, 'claims', 'active'); await setModule(base.tenantId, 'payroll', 'active');
    const ctx = await grant();
    expect((await loadAiWorkspace(ctx)).taskIds).toContain('claim_statuses');
    expect((await loadAiWorkspace(ctx)).taskIds).toContain('payslip');
    await setModule(base.tenantId, 'claims', null); await setModule(base.tenantId, 'payroll', null);
    const fresh = await loadAiWorkspace(ctx);
    expect(fresh.taskIds).not.toContain('claim_statuses'); expect(fresh.taskIds).not.toContain('payslip');
    expect(fresh.taskIds).not.toContain('pay_change'); expect(fresh.taskIds).toContain('leave_available');
    await setModule(base.tenantId, 'assistant', null);
    const disabled = await loadAiWorkspace(ctx);
    expect(disabled).toEqual({ access: { allowed: false, reason: 'module_off' }, taskIds: [], history: [] });
  });
  it('returns neither tasks nor history after a grant revocation or without a login', async () => {
    const ctx = await grant(); await exchange(base.tenantId, ctx.userId!, 'OWN_PRIVATE_SENTINEL');
    await revokeAssistant(ctx, { appUserId: ctx.userId! });
    expect(await loadAiWorkspace(ctx)).toEqual({ access: { allowed: false, reason: 'no_grant' }, taskIds: [], history: [] });
    expect(await loadAiWorkspace({ ...ctx, userId: undefined })).toEqual({ access: { allowed: false, reason: 'no_user' }, taskIds: [], history: [] });
  });
  it('refuses archived/stale actual principals before reading personal history', async () => {
    const ctx = await grant(); await exchange(base.tenantId, ctx.userId!, 'OWN_PRIVATE_SENTINEL');
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, ctx.userId!));
    await expect(loadAiWorkspace(ctx)).rejects.toThrow('Current AI calling authority');
    await owner.db.update(schema.appUser).set({ archivedAt: null }).where(eq(schema.appUser.id, ctx.userId!));
    await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, ctx.userId!));
    await expect(loadAiWorkspace(ctx)).rejects.toThrow('Current AI calling authority');
  });
  it('binds each advertised job to real read services and a known owning module', () => {
    const modules = new Set(MODULE_CATALOG.map(module => module.code));
    for (const task of AI_WORKSPACE_TASKS) {
      expect(modules.has(task.module)).toBe(true);
      for (const name of task.requiredTools) expect(ASSISTANT_TOOLS.find(tool => tool.spec.name === name)).toBeTruthy();
      expect(task.requiredTools.some(name => ASSISTANT_TOOLS.find(tool => tool.spec.name === name)?.module === task.module)).toBe(true);
    }
  });
});
