/** Actual workspace principal/grant/history custody cases, authored UNRUN. No provider requests. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAiWorkspace } from '../core/ai-workspace';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { ASSISTANT_TOOLS } from '../core/assistant-tools';
import { assistantSourceDigest, sealAssistantDisclosure } from '../lib/ai/assistant-disclosure';
import { hireEmployee } from '../core/org';
import { AI_WORKSPACE_TASKS } from '../lib/ai/workspace-tasks';
import { MODULE_CATALOG } from '../packs/catalog';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { vi.stubEnv('AI_CONFIG_SECRET', 'fictional-workspace-disclosure-only'); await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'assistant', 'active'); });
afterAll(async () => { vi.unstubAllEnvs(); await closeAll(); });
async function grant() { const ctx = adminCtx(base); await grantAssistant(ctx, { appUserId: ctx.userId! }); return ctx; }
const exchange = (tenantId: string, appUserId: string, text: string) => owner.db.insert(schema.assistantExchange)
  .values({ tenantId, appUserId, question: text, answer: text, stop: 'end' }).returning({ id: schema.assistantExchange.id });

async function profileReceipt() {
  const admin = await grant();
  const make = (name: string) => hireEmployee(admin, { person: { fullName: name, primaryEmail: `${randomUUID()}@fixture.test` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  const mine = await make('Fictional Caller'), peer = await make('HISTORICAL_PEER_PRIVATE_SENTINEL');
  const userId = await createAppUser(base.tenantId, mine.personId, 'hr_admin');
  await grantAssistant(admin, { appUserId: userId });
  const ctx = { ...await entitledCtx(base), userId, personId: mine.personId };
  const input = { employment_id: peer.employmentId };
  const tool = ASSISTANT_TOOLS.find(tool => tool.spec.name === 'employee_profile')!;
  const outcome = await tool.run(ctx, input); expect(outcome.ok).toBe(true);
  const id = randomUUID(), question = 'What is this employee profile?', answer = 'HISTORICAL_PEER_PRIVATE_SENTINEL';
  const receipt = sealAssistantDisclosure({ tenantId: base.tenantId, userId, exchangeId: id, question, answer },
    [{ name: tool.spec.name, input, digest: assistantSourceDigest(outcome) }]);
  expect(receipt).toBeTruthy();
  await owner.db.insert(schema.assistantExchange).values({ id, tenantId: base.tenantId, appUserId: userId, question, answer,
    disclosureReceipt: receipt, stop: 'end', toolCalls: [{ name: tool.spec.name, input, rowCount: 1 }] });
  return { ctx, peer, id, receipt, tool };
}

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
  it('withholds legacy answer bodies without deleting or fabricating their audit evidence', async () => {
    const ctx = await grant();
    const [row] = await owner.db.insert(schema.assistantExchange).values({ tenantId: base.tenantId, appUserId: ctx.userId!,
      question: 'Old question', answer: 'LEGACY_PRIVATE_ANSWER_SENTINEL', stop: 'end' }).returning({ id: schema.assistantExchange.id });
    const workspace = await loadAiWorkspace(ctx);
    expect(workspace.history).toMatchObject([{ id: row.id, answer: null, answerVisibility: 'unavailable' }]);
    expect(JSON.stringify(workspace)).not.toContain('LEGACY_PRIVATE_ANSWER_SENTINEL');
    const [retained] = await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.id, row.id));
    expect(retained.answer).toBe('LEGACY_PRIVATE_ANSWER_SENTINEL');
  });
  it('replays actual canonical fields and returns neither receipt nor lookup inputs in page props', async () => {
    const { ctx, id, receipt, peer } = await profileReceipt();
    const workspace = await loadAiWorkspace(ctx);
    expect(workspace.history).toMatchObject([{ id, answer: 'HISTORICAL_PEER_PRIVATE_SENTINEL', answerVisibility: 'current' }]);
    expect(JSON.stringify(workspace)).not.toContain(receipt!);
    expect(JSON.stringify(workspace)).not.toContain(peer.employmentId);
    expect(workspace.history[0]).not.toHaveProperty('disclosureReceipt');
    expect(workspace.history[0].toolCalls).toEqual([{ name: 'employee_profile' }]);
  });
  it('withholds an unchanged stored peer answer after actual role scope is reduced', async () => {
    const { ctx, id } = await profileReceipt();
    expect((await loadAiWorkspace(ctx)).history[0].answer).toBe('HISTORICAL_PEER_PRIVATE_SENTINEL');
    await owner.db.update(schema.roleAssignment).set({ role: 'employee' }).where(eq(schema.roleAssignment.appUserId, ctx.userId!));
    const reduced = { ...ctx, roles: ['employee'] };
    const workspace = await loadAiWorkspace(reduced);
    expect(workspace.history).toMatchObject([{ id, answer: null, answerVisibility: 'unavailable' }]);
    expect(JSON.stringify(workspace)).not.toContain('HISTORICAL_PEER_PRIVATE_SENTINEL');
  });
  it('withholds answers when canonical facts drift or the exact stored answer is swapped', async () => {
    const { ctx, peer, id } = await profileReceipt();
    await owner.db.update(schema.person).set({ fullName: 'Changed canonical name' }).where(eq(schema.person.id, peer.personId));
    expect((await loadAiWorkspace(ctx)).history[0]).toMatchObject({ answer: null, answerVisibility: 'unavailable' });
    await owner.db.update(schema.person).set({ fullName: 'HISTORICAL_PEER_PRIVATE_SENTINEL' }).where(eq(schema.person.id, peer.personId));
    expect((await loadAiWorkspace(ctx)).history[0].answer).toBe('HISTORICAL_PEER_PRIVATE_SENTINEL');
    await owner.db.update(schema.assistantExchange).set({ answer: 'FORGED_REPLACEMENT_SENTINEL' }).where(eq(schema.assistantExchange.id, id));
    const workspace = await loadAiWorkspace(ctx);
    expect(workspace.history[0].answerVisibility).toBe('unavailable');
    expect(JSON.stringify(workspace)).not.toContain('FORGED_REPLACEMENT_SENTINEL');
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
