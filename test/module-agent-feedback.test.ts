/** Actual own-user feedback custody/erasure tests, authored UNRUN; draft migration required. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { recordOwnAgentFeedback, eraseOwnAgentFeedback, purgeExpiredAgentFeedback } from '../core/module-agent-feedback';
import { hireEmployee } from '../core/org';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'assistant', 'active'); });
afterAll(closeAll);
async function fixture() {
  const admin = adminCtx(base);
  const hired = await hireEmployee(admin, { person: { fullName: 'Fictional Feedback Owner', primaryEmail: `${randomUUID()}@fixture.test` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  const userId = await createAppUser(base.tenantId, hired.personId, 'employee');
  await grantAssistant(admin, { appUserId: userId }); await grantAssistant(admin, { appUserId: base.adminUserId });
  const ctx: SessionContext = { ...await entitledCtx(base, ['employee']), userId, personId: hired.personId,
    roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  const [exchange] = await owner.db.insert(schema.assistantExchange).values({ tenantId: base.tenantId,
    appUserId: userId, question: 'Fictional private question', answer: 'Fictional private answer' }).returning({ id: schema.assistantExchange.id });
  return { admin, ctx, userId, exchangeId: exchange.id };
}
async function rows() { return Array.from(await owner.db.execute<{ user_id: string; outcome: string; consented: boolean }>(sql`select user_id,outcome,consented from public.ai_agent_feedback`)); }
describe('private feedback remains opinion and explicit own-user custody', () => {
  it('saves only closed consented metadata and revises the same own exchange without duplication', async () => {
    const { ctx, userId, exchangeId } = await fixture();
    await recordOwnAgentFeedback(ctx, { exchangeId, outcome: 'helpful', consented: true });
    await recordOwnAgentFeedback(ctx, { exchangeId, outcome: 'needs_correction', consented: true });
    expect(await rows()).toEqual([{ user_id: userId, outcome: 'needs_correction', consented: true }]);
    const [columns] = await owner.db.execute<{ unsafe: boolean }>(sql`select exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='ai_agent_feedback' and column_name in ('prompt','answer','body','feedback_text','employee_id')) as unsafe`);
    expect(columns.unsafe).toBe(false);
  });
  it('refuses another user exchange even for a tenant administrator and requires explicit consent', async () => {
    const { admin, ctx, exchangeId } = await fixture();
    await expect(recordOwnAgentFeedback(admin, { exchangeId, outcome: 'helpful', consented: true })).rejects.toThrow();
    await expect(recordOwnAgentFeedback(ctx, { exchangeId, outcome: 'helpful', consented: false } as never)).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });
  it('purges only expired metadata under the actual current group administrator and a bounded batch', async () => {
    const { admin, ctx, exchangeId } = await fixture();
    await recordOwnAgentFeedback(ctx, { exchangeId, outcome: 'helpful', consented: true });
    await owner.db.execute(sql`update public.ai_agent_feedback set created_at=now()-interval '31 days',expires_at=now()-interval '1 day'`);
    await expect(purgeExpiredAgentFeedback(ctx, 1)).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
    const [principal]=await owner.db.execute<{grants:{role:string;companyId:string|null}[]}>(sql`select grants from app.principal(${base.adminUserId}::uuid) where tenant_id=${base.tenantId}::uuid`);
    expect(principal.grants).toEqual([{role:'hr_admin',companyId:null}]);
    // Use the actual group grant rather than adminCtx's legacy role-only snapshot. No role is added.
    const groupAdmin:SessionContext={...admin,grants:principal.grants};
    expect(await purgeExpiredAgentFeedback(groupAdmin, 1)).toEqual({removed:1});
    expect(await rows()).toEqual([]);
    await expect(purgeExpiredAgentFeedback(groupAdmin, 101)).rejects.toThrow();
  });
  it('removes only the current owner feedback and permits erasure after grant revocation', async () => {
    const { admin, ctx, userId, exchangeId } = await fixture();
    await recordOwnAgentFeedback(ctx, { exchangeId, outcome: 'incorrect', consented: true });
    await eraseOwnAgentFeedback(admin); expect(await rows()).toHaveLength(1);
    await revokeAssistant(admin, { appUserId: userId });
    await expect(recordOwnAgentFeedback(ctx, { exchangeId, outcome: 'helpful', consented: true })).rejects.toThrow();
    await eraseOwnAgentFeedback(ctx); expect(await rows()).toEqual([]);
  });
});
