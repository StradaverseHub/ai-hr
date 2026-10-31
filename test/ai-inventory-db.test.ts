/** WP12 (R8, R20, R21) against the migrated database: who may see the AI inventory, the per-action pause key
 *  `hr_assistant:<actionId>` (0696) enforced in the owning transaction, run history paging and date range, the
 *  alert thresholds and drift, and tenant isolation. Fictional fixtures only; no model is called. */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { aiManagementView, AiControlError } from '../core/ai-management';
import { aiInventoryView, aiManagementAlerts, aiRunHistory, setAgentActionPause } from '../core/ai-inventory';
import { aiAlertExitCode, aiAlertSweep } from '../core/ai-alert-sweep';
import {withAgentActionGuard} from '../core/assistant-actions/agent-action-guard';
import {grantAssistant} from '../core/assistant-grant';
import { assertAiActionUnpausedTx } from '../core/ai-governance';
import { withAgentActionPauseScope } from '../core/agent-action-pause-scope';
import { AiAllowanceError } from '../lib/ai/types';
import { AI_RUN_PAGE_SIZE } from '../lib/ai/ai-inventory';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base, group: SessionContext, companyHr: SessionContext, employee: SessionContext;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  group = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
  // A company-scoped claim on the same login: narrower than its actual grant, so the principal snapshot holds,
  // and app.is_group_admin() is false.
  companyHr = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: base.companyId }] };
  employee = { ...adminCtx(base), roles: ['employee'], grants: [{ role: 'employee', companyId: base.companyId }] };
});
afterAll(closeAll);

const foreignTenant = async () => {
  const [t] = await owner.db.insert(schema.tenant).values({ workosOrgId: `org_wp12_foreign_${Date.now()}`, name: 'Fictional foreign tenant' }).returning();
  return t.id;
};
const runs = (tenantId: string, rows: { minutesAgo: number; state?: string; userId?: string | null; feature?: string }[]) =>
  owner.db.execute(sql`insert into ai_model_run(tenant_id,user_id,feature_id,operation,provider,model,state,reason,reserved_tokens,actual_tokens,started_at)
    select ${tenantId}::uuid,(r->>'userId')::uuid,coalesce(r->>'feature','hr_assistant'),'conversation','fixture','never-sent',r->>'state',
      case when r->>'state'='blocked' then 'paused' end,10,case when r->>'state'='completed' then 7 end,now()-((r->>'minutesAgo')::int*interval '1 minute')
    from jsonb_array_elements(${JSON.stringify(rows.map(r => ({ state: 'completed', userId: base.adminUserId, ...r })))}::jsonb) r`);
const pauseCheck = (ctx: SessionContext) => withTenant(ctx, tx => assertAiActionUnpausedTx(tx, ctx, 'hr_assistant'));

describe('AI inventory access (ADR-0151 §4.7)', () => {
  it('gives the group administrator the full inventory, company HR the read-only registry, and refuses others', async () => {
    const full = await aiInventoryView(group, await aiManagementView(group));
    expect(full.scope).toBe('full');
    if (full.scope !== 'full') throw Error('unreachable');
    expect(full.rows.length).toBeGreaterThan(40);
    const chat = full.rows.find(r => r.key === 'chat:hr_assistant')!;
    expect(chat.runtime.use30).toEqual({ runs: 0, failed: 0, blocked: 0, tokens: 0, reportedCredits: null });
    expect(full.register.map(r => r.featureId)).toContain('hr_assistant');

    const registry = await aiInventoryView(companyHr, await aiManagementView(companyHr));
    expect(registry.scope).toBe('registry');
    expect(registry.rows.length).toBe(full.rows.length);
    for (const row of registry.rows) {
      expect(row).not.toHaveProperty('runtime');
      expect(Object.keys(row).sort()).toEqual(['actionPaused', 'category', 'id', 'key', 'kind', 'module', 'outOfBand', 'pauseKey', 'tier']);
    }
    expect(registry).not.toHaveProperty('register');
    expect(registry).not.toHaveProperty('alerts');

    await expect(aiInventoryView(employee, await aiManagementView(group))).rejects.toBeInstanceOf(AiControlError);
    await expect(aiRunHistory(companyHr, {})).rejects.toBeInstanceOf(AiControlError);
    await expect(aiRunHistory(employee, {})).rejects.toBeInstanceOf(AiControlError);
  });

  it('never shows another tenant’s runs or pauses', async () => {
    const other = await foreignTenant();
    await owner.db.execute(sql`insert into app.ai_agent_action_pause(tenant_id,action_id,paused) values(${other}::uuid,'leave.edit',true)`);
    await runs(other, Array.from({ length: 7 }, (_, i) => ({ minutesAgo: i + 1, userId: null, state: 'failed' })));
    const full = await aiInventoryView(group, await aiManagementView(group));
    if (full.scope !== 'full') throw Error('expected full scope');
    expect(full.rows.find(r => r.key === 'action:leave.edit')!.runtime.actionPaused).toBe(false);
    expect(full.rows.find(r => r.key === 'chat:hr_assistant')!.runtime.use30!.runs).toBe(0);
    expect(full.alerts).toEqual([]);
    expect((await aiRunHistory(group, {})).rows).toEqual([]);
    const registry = await aiInventoryView(companyHr, await aiManagementView(companyHr));
    if (registry.scope !== 'registry') throw Error('expected registry scope');
    expect(registry.rows.find(r => r.key === 'action:leave.edit')!.actionPaused).toBe(false);
    // The table itself is tenant-scoped under RLS.
    const visible = await withTenant(group, tx => tx.execute(sql`select tenant_id from app.ai_agent_action_pause`));
    expect(Array.from(visible)).toEqual([]);
  });
});

describe('per-action pause key hr_assistant:<actionId> (0696)', () => {
  it('enforces a direct shared source guard pause without relying on browser request scope',async()=>{
    await setModule(base.tenantId,'assistant','active');await grantAssistant(group,{appUserId:group.userId!});
    const check=()=>withTenant(group,tx=>withAgentActionGuard(tx,group,'leave.cancel'));
    await expect(check()).resolves.toMatchObject({userId:group.userId});
    await setAgentActionPause(group,'leave.cancel',true);await expect(check()).rejects.toBeInstanceOf(AiAllowanceError);
    await setAgentActionPause(group,'leave.cancel',false);await expect(check()).resolves.toMatchObject({userId:group.userId});
  });
  it('pauses one action inside the owning transaction, leaves others and unscoped checks running, and records it', async () => {
    await expect(withAgentActionPauseScope('leave.cancel', () => pauseCheck(group))).resolves.toBeUndefined();
    await setAgentActionPause(group, 'leave.cancel', true);
    await expect(withAgentActionPauseScope('leave.cancel', () => pauseCheck(group))).rejects.toBeInstanceOf(AiAllowanceError);
    await expect(withAgentActionPauseScope('leave.edit', () => pauseCheck(group))).resolves.toBeUndefined();
    await expect(pauseCheck(group)).resolves.toBeUndefined();
    expect(await eventTypesFor(base.tenantId, base.tenantId)).toContain('ai-control.action-pause-changed');
    const full = await aiInventoryView(group, await aiManagementView(group));
    if (full.scope !== 'full') throw Error('expected full scope');
    const row = full.rows.find(r => r.key === 'action:leave.cancel')!;
    expect(row.pauseKey).toBe('hr_assistant:leave.cancel');
    expect(row.runtime.actionPaused).toBe(true);
    expect(row.runtime.audit.count).toBe(1);
    const registry = await aiInventoryView(companyHr, await aiManagementView(companyHr));
    if (registry.scope !== 'registry') throw Error('expected registry scope');
    expect(registry.rows.find(r => r.key === 'action:leave.cancel')!.actionPaused).toBe(true);
    await setAgentActionPause(group, 'leave.cancel', false);
    await expect(withAgentActionPauseScope('leave.cancel', () => pauseCheck(group))).resolves.toBeUndefined();
  });

  it('keeps the module pause above every action pause', async () => {
    await withTenant(group, tx => tx.insert(schema.aiControlPolicy).values({ tenantId: base.tenantId, kind: 'feature', scopeKey: 'feature:hr_assistant', featureId: 'hr_assistant', enabled: false }));
    await expect(withAgentActionPauseScope('leave.edit', () => pauseCheck(group))).rejects.toBeInstanceOf(AiAllowanceError);
    await expect(pauseCheck(group)).rejects.toBeInstanceOf(AiAllowanceError);
  });

  it('refuses a pause from company HR, from a direct table write, for an unknown action, and an unknown scope', async () => {
    await expect(setAgentActionPause(companyHr, 'leave.cancel', true)).rejects.toBeInstanceOf(AiControlError);
    await expect(withTenant(companyHr, tx => tx.execute(sql`select app.ai_agent_action_pause_set('leave.cancel',true)`)))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining('Only a group administrator') } });
    await expect(withTenant(group, tx => tx.execute(sql`insert into app.ai_agent_action_pause(tenant_id,action_id,paused) values(${base.tenantId}::uuid,'leave.cancel',true)`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(setAgentActionPause(group, 'not.an_action', true)).rejects.toBeInstanceOf(AiControlError);
    await expect(withTenant(group, tx => tx.execute(sql`select app.ai_agent_action_pause_set('not.an_action',true)`)))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining('Unknown agent action') } });
    await expect(withAgentActionPauseScope('not.an_action', () => pauseCheck(group))).rejects.toThrow('Unknown agent action');
    expect(Array.from(await owner.db.execute(sql`select * from app.ai_agent_action_pause`))).toEqual([]);
  });
});

describe('review fixes: stale principal, narrow pause view, fail-closed scope', () => {
  it('refuses a pause from a stale principal claim, in core and in the SQL writer', async () => {
    // A login whose STORED grant is company-scoped, presenting a group-wide claim: app.is_group_admin() alone would
    // accept the claim; the principal snapshot does not.
    const [u] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: `user_wp12_stale_${Date.now()}` }).returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: base.companyId, role: 'hr_admin' });
    const stale: SessionContext = { ...adminCtx(base), userId: u.id, grants: [{ role: 'hr_admin', companyId: null }] };
    await expect(setAgentActionPause(stale, 'leave.cancel', true)).rejects.toThrow();
    await expect(withTenant(stale, tx => tx.execute(sql`select app.ai_agent_action_pause_set('leave.cancel',true)`)))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining('Current principal could not be confirmed') } });
    // The same login with its true (company-scoped) claim is a company HR administrator: registry view only.
    const current: SessionContext = { ...adminCtx(base), userId: u.id, grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    expect((await aiInventoryView(current, await aiManagementView(current))).scope).toBe('registry');
    expect(Array.from(await owner.db.execute(sql`select * from app.ai_agent_action_pause`))).toEqual([]);
  });

  it('shows non-admins only (action_id, paused); the full row stays with group administrators', async () => {
    await setAgentActionPause(group, 'leave.cancel', true);
    expect(Array.from(await withTenant(companyHr, tx => tx.execute(sql`select * from app.ai_agent_action_pause`)))).toEqual([]);
    const narrow = Array.from(await withTenant(companyHr, tx => tx.execute(sql`select * from app.ai_agent_action_pauses()`)));
    expect(narrow).toEqual([{ action_id: 'leave.cancel', paused: true }]);
    const fullRows = Array.from(await withTenant(group, tx => tx.execute<{ action_id: string; updated_by_user_id: string }>(sql`select action_id,updated_by_user_id from app.ai_agent_action_pause`)));
    expect(fullRows).toEqual([{ action_id: 'leave.cancel', updated_by_user_id: base.adminUserId }]);
  });

  it('fails closed when a review-route command cannot name its action', async () => {
    await expect(withAgentActionPauseScope(null, () => pauseCheck(group))).rejects.toBeInstanceOf(AiAllowanceError);
    await expect(pauseCheck(group)).resolves.toBeUndefined();
  });
});

describe('run history paging and date range', () => {
  it('pages 50 newest-first within the default 30 days and widens to an explicit range', async () => {
    await runs(base.tenantId, [
      ...Array.from({ length: 120 }, (_, i) => ({ minutesAgo: 60 * 25 + i })),
      ...Array.from({ length: 3 }, (_, i) => ({ minutesAgo: 60 * 24 * 40 + i })),
    ]);
    const first = await aiRunHistory(group, {});
    expect(first.rows.length).toBe(AI_RUN_PAGE_SIZE); expect(first.hasMore).toBe(true);
    expect(first.range.page).toBe(1); expect(first.range.to).toBe(todayInKualaLumpur());
    const times = first.rows.map(r => r.startedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const third = await aiRunHistory(group, { page: '3' });
    expect(third.rows.length).toBe(20); expect(third.hasMore).toBe(false);
    const all = [...first.rows, ...(await aiRunHistory(group, { page: '2' })).rows, ...third.rows];
    expect(new Set(all.map(r => r.id)).size).toBe(120);
    const from = new Date(Date.now() - 45 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    const wide = await aiRunHistory(group, { from, page: '3' });
    expect(wide.rows.length).toBe(23);
    const to = new Date(Date.now() - 35 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    const old = await aiRunHistory(group, { from, to });
    expect(old.rows.length).toBe(3); expect(old.hasMore).toBe(false);
    expect((await aiRunHistory(group, { from, to }, { state: 'failed' })).rows).toEqual([]);
  });
});

describe('alerts and drift (R20)', () => {
  it('raises failure rate, principal refusal and switch drift on the screen and in the cron sweep', async () => {
    const quiet = await aiAlertSweep(owner.db);
    expect(quiet.alerts).toEqual([]); expect(aiAlertExitCode(quiet)).toBe(0);
    // 4 of 10 admitted calls failed in 24 hours (40%: warning); one blocked call with no login (the agent principal).
    await runs(base.tenantId, [...Array.from({ length: 6 }, (_, i) => ({ minutesAgo: i + 1 })), ...Array.from({ length: 4 }, (_, i) => ({ minutesAgo: i + 10, state: 'failed' })),
      { minutesAgo: 30, state: 'blocked', userId: null }]);
    // A stale `feature:` row for a setting-backed feature that disagrees with its setting (ignored since 0692).
    await owner.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(schema.aiControlPolicy).values({ tenantId: base.tenantId, kind: 'feature', scopeKey: 'feature:performance_pm', featureId: 'performance_pm', enabled: true });
    });
    // A stale row that AGREES with its switch (performance_tc defaults off) is not drift, on either surface.
    await owner.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(schema.aiControlPolicy).values({ tenantId: base.tenantId, kind: 'feature', scopeKey: 'feature:performance_tc', featureId: 'performance_tc', enabled: false });
    });
    // Older than the 30 Kuala Lumpur days: outside the 30-day use.
    await runs(base.tenantId, [{ minutesAgo: 60 * 24 * 32 }]);
    const view = await aiInventoryView(group, await aiManagementView(group));
    if (view.scope !== 'full') throw Error('expected full scope');
    expect(view.alerts.map(a => [a.kind, a.level, a.count])).toEqual([['failure_rate', 'warning', 4], ['principal_refusals', 'critical', 1], ['switch_drift', 'warning', 1]]);
    // 30-day use counts actual tokens only (6 completed x 7); failed and blocked reservations are not cost.
    expect(view.rows.find(r => r.key === 'chat:hr_assistant')!.runtime.use30).toMatchObject({ runs: 10, failed: 4, blocked: 1, tokens: 42 });
    expect(await aiManagementAlerts(group, await aiManagementView(group))).toMatchObject({ status: 'ok', alerts: view.alerts });
    expect(await aiManagementAlerts(companyHr, await aiManagementView(companyHr))).toEqual({ status: 'not_shown' });
    expect(view.alerts.find(a => a.kind === 'switch_drift')!.detail).toBe('performance_pm');
    const sweep = await aiAlertSweep(owner.db);
    expect(sweep.alerts.filter(a => a.tenantId === base.tenantId).map(a => a.alert.kind)).toEqual(['failure_rate', 'principal_refusals', 'switch_drift']);
    expect(aiAlertExitCode(sweep)).toBe(3);
    // Company HR sees no alert inputs at all.
    const registry = await aiInventoryView(companyHr, await aiManagementView(companyHr));
    expect(registry).not.toHaveProperty('alerts');
  });
});
