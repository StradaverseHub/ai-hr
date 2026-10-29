/** WP14 / R19 against the real database: a provider or model change is pending until its baseline holdout suites
 * pass (or a group administrator accepts a failure with a reason), and per-feature caps are enforced by ai_admit.
 * Real services, SQL owners, RLS and governed admission; ONLY the provider transport (adapter) is mocked. */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { AiConfigError, discardPendingAiProviderChange, getAiConfigView, resolveActiveAiConfig, saveAiProviderConfig, setActiveProvider } from '../core/ai-config';
import { acceptProviderBaselineFailure, getAiProviderChangeView, runProviderBaseline } from '../core/ai-provider-baseline';
import { AiControlError, setAiAllowance, setAiFeature, setAiFeatureCap } from '../core/ai-management';
import { generateDraft } from '../lib/ai';
import { anthropicAdapter } from '../lib/ai/providers/anthropic';
import { openaiAdapter } from '../lib/ai/providers/openai';
import { PROVIDER_BASELINE_SUITES, PROVIDER_BASELINE_SUITE_DIGEST, PROVIDER_BASELINE_REQUEST_LIMIT } from '../lib/ai/provider-baseline-suites';
import { activateDirectProviderFixture, acceptBaselineFixture, startBaselineRunFixture } from './ai-provider-change-fixture';
import { activateSyntheticCandidate } from './provider-evaluation-fixture';
import { encryptSecret } from '../lib/ai/crypto';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => {
  vi.stubEnv('AI_CONFIG_SECRET', 'fictional-provider-change-gate-passphrase');
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AI_DRAFT_MODEL']) vi.stubEnv(key, '');
  await resetDb(); base = await seedBase();
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { vi.unstubAllEnvs(); await closeAll(); });

const zero = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
const expected = new Map(Object.values(PROVIDER_BASELINE_SUITES).flat().map(row => [row.prompt, JSON.stringify({ decision: row.decision, modules: [...row.modules] })]));
/** A provider that answers every fixed baseline case as the independent expectation says (or always wrongly). */
function transport(adapter: typeof anthropicAdapter, mode: 'correct' | 'wrong' = 'correct') {
  return vi.spyOn(adapter, 'generate').mockImplementation(async (_cfg, args) => {
    args.onUsage?.(zero);
    const answer = expected.get(args.prompt);
    if (!answer) throw Error('Unexpected prompt outside the fixed baseline suites');
    return mode === 'correct' ? answer : JSON.stringify({ decision: 'read', modules: ['payroll', 'claims', 'leave', 'org'] });
  });
}
const live = () => withTenant(adminCtx(base), tx => resolveActiveAiConfig(tx, adminCtx(base)));
const pendingRows = () => owner.db.execute<{ id: string; tenant_id: string; provider: string; model: string; version_token: string }>(sql`select id,tenant_id,provider,model,version_token from public.ai_provider_pending_config order by provider`);
const runRow = async (id: string) => (await owner.db.execute<{ state: string; accepted_reason: string | null; accepted_by_user_id: string | null; suites: Record<string, { next: number; failed: number }> }>(sql`select state,accepted_reason,accepted_by_user_id,suites from public.ai_provider_baseline_run where id=${id}::uuid`))[0];
const events = (type: string) => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.eventType, type)));
async function companyHr(): Promise<SessionContext> {
  const [user] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: 'fixture-company-hr-' + randomUUID(), personId: null }).returning();
  await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: user.id, companyId: base.companyId, role: 'hr_admin' });
  return { ...adminCtx(base), userId: user.id, grants: [{ role: 'hr_admin', companyId: base.companyId }] };
}
const pendingTarget = async (ctx: SessionContext, provider: string) => {
  const view = await getAiProviderChangeView(ctx), target = view.targets.find(t => t.kind === 'pending' && t.provider === provider);
  if (!target) throw Error('Missing pending target');
  return target;
};

describe('provider and model change gate (WP14)', () => {
  it('stores a change as pending; the gateway keeps serving the active configuration', async () => {
    const ctx = adminCtx(base);
    await activateDirectProviderFixture(ctx, { provider: 'openai', model: 'fictional-live-model', apiKey: 'fixture-live-key' });
    await saveAiProviderConfig(ctx, { provider: 'openai', model: 'fictional-next-model', apiKey: 'fixture-next-key' });
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'fixture-anthropic-key' });
    await expect(saveAiProviderConfig(ctx, { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'fixture-google-key', makeActive: true })).rejects.toBeInstanceOf(AiConfigError);
    expect(await live()).toMatchObject({ provider: 'openai', model: 'fictional-live-model', apiKey: 'fixture-live-key' });
    // An actual governed generation reaches the live key and model, never the pending ones.
    const openai = vi.spyOn(openaiAdapter, 'generate').mockImplementation(async (_cfg, args) => { args.onUsage?.(zero); return 'fictional'; });
    const anthropic = vi.spyOn(anthropicAdapter, 'generate');
    const cfg = await withTenant(ctx, tx => resolveActiveAiConfig(tx, ctx, 'pay_rule_draft'));
    await expect(generateDraft(cfg!, { system: 'Synthetic fixture.', prompt: 'No HR data.', maxTokens: 8 })).resolves.toBe('fictional');
    expect(openai.mock.calls[0][0]).toMatchObject({ model: 'fictional-live-model', apiKey: 'fixture-live-key' });
    expect(anthropic).not.toHaveBeenCalled();
    expect((await pendingRows()).map(r => [r.provider, r.model])).toEqual([['anthropic', 'claude-sonnet-4-6'], ['openai', 'fictional-next-model']]);
    const view = await getAiProviderChangeView(ctx);
    expect(view.targets.map(t => [t.kind, t.provider, t.status])).toEqual([['pending', 'anthropic', 'pending'], ['pending', 'openai', 'pending']]);
    expect(JSON.stringify(view)).not.toContain('fixture-');
    const card = (await getAiConfigView(ctx)).providers.find(p => p.provider === 'openai')!;
    expect(card).toMatchObject({ isActive: true, activeModel: 'fictional-live-model', model: 'fictional-next-model', pendingSaved: true });
    // Pending storage and its ciphertext are withheld from the ordinary application role.
    await expect(withTenant(ctx, tx => tx.execute(sql`select * from public.ai_provider_pending_config`))).rejects.toThrow();
    await discardPendingAiProviderChange(ctx, { provider: 'openai' });
    expect((await pendingRows()).map(r => r.provider)).toEqual(['anthropic']);
    expect(await live()).toMatchObject({ provider: 'openai', model: 'fictional-live-model' });
  });

  it('refuses activation until a run of the exact current version has passed, then promotes it atomically', async () => {
    const ctx = adminCtx(base);
    await activateDirectProviderFixture(ctx, { provider: 'openai', model: 'fictional-live-model', apiKey: 'fixture-live-key' });
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'fixture-anthropic-key' });
    await expect(setActiveProvider(ctx, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    await startBaselineRunFixture(ctx, { kind: 'pending', provider: 'anthropic' });
    await expect(setActiveProvider(ctx, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    // A failing case stops the run at once: one billed request, state failed, activation still refused.
    let target = await pendingTarget(ctx, 'anthropic');
    const wrong = transport(anthropicAdapter, 'wrong');
    const failed = await runProviderBaseline(ctx, { kind: 'pending', provider: 'anthropic', targetId: target.targetId, targetVersion: target.targetVersion, consent: true });
    expect(failed).toMatchObject({ state: 'failed', attempted: 1, interrupted: false });
    expect(wrong).toHaveBeenCalledTimes(1); expect(wrong.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-4-6', apiKey: 'fixture-anthropic-key' });
    await expect(setActiveProvider(ctx, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    expect(await live()).toMatchObject({ provider: 'openai', model: 'fictional-live-model' });
    wrong.mockRestore();
    // A correct provider passes every fixed case across batches; each batch is bounded and resumes where it stopped.
    const right = transport(anthropicAdapter, 'correct');
    const total = Object.values(PROVIDER_BASELINE_SUITES).reduce((n, rows) => n + rows.length, 0);
    let result = await runProviderBaseline(ctx, { kind: 'pending', provider: 'anthropic', targetId: target.targetId, targetVersion: target.targetVersion, consent: true });
    const runId = result.runId; let batches = 1;
    expect(result.attempted).toBe(PROVIDER_BASELINE_REQUEST_LIMIT); expect(result.state).toBe('evaluating');
    expect((await getAiProviderChangeView(ctx)).targets[0]).toMatchObject({ status: 'evaluating', activatable: false });
    await expect(setActiveProvider(ctx, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    while (result.state === 'evaluating' && batches < 20) { result = await runProviderBaseline(ctx, { kind: 'pending', provider: 'anthropic', targetId: target.targetId, targetVersion: target.targetVersion, consent: true }); batches++; expect(result.runId).toBe(runId); }
    expect(result.state).toBe('passed'); expect(right).toHaveBeenCalledTimes(total);
    expect(batches).toBe(Math.ceil(total / PROVIDER_BASELINE_REQUEST_LIMIT));
    const runs = await owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId, base.tenantId));
    const evaluation = runs.filter(r => r.featureId === 'provider_evaluation');
    expect(evaluation).toHaveLength(total + 1); expect(evaluation.every(r => r.userId === base.adminUserId && r.provider === 'anthropic')).toBe(true);
    const roots = await owner.db.execute<{ root_id: string }>(sql`select distinct root_id from app.ai_spend_admission_scope where tenant_id=${base.tenantId}::uuid and feature_id='provider_evaluation'`);
    expect(roots.map(r => r.root_id).sort()).toEqual([failed.runId, runId].sort());
    target = await pendingTarget(ctx, 'anthropic');
    expect(target).toMatchObject({ status: 'passed', activatable: true });
    expect(target.run!.suites.map(s => [s.id, s.passed, s.failed, s.state])).toEqual(Object.entries(PROVIDER_BASELINE_SUITES).map(([id, rows]) => [id, rows.length, 0, 'passed']));
    // A re-save mints a new version: the earlier pass no longer admits activation.
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-haiku-4-5' });
    await expect(setActiveProvider(ctx, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-6' });
    await expect(setActiveProvider(ctx, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    await acceptBaselineFixture(ctx, { kind: 'pending', provider: 'anthropic' });
    await expect(setActiveProvider(ctx, { provider: 'anthropic', pendingVersion: randomUUID() })).rejects.toThrow(AiConfigError);
    await setActiveProvider(ctx, { provider: 'anthropic' });
    expect(await live()).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'fixture-anthropic-key' });
    expect(await pendingRows()).toEqual([]);
    const active = await owner.db.select().from(schema.aiProviderConfig).where(and(eq(schema.aiProviderConfig.tenantId, base.tenantId), eq(schema.aiProviderConfig.isActive, true)));
    expect(active.map(r => r.provider)).toEqual(['anthropic']);
    expect((await events('ai-provider-config.activated')).map(e => e.payload)).toContainEqual(expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-4-6' }));
  }, 180_000);

  it('accepts a failure only for a group administrator with a reason, audits it, and only for that version', async () => {
    const ctx = adminCtx(base), hr = await companyHr();
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'fixture-anthropic-key' });
    const target = await pendingTarget(ctx, 'anthropic');
    transport(anthropicAdapter, 'wrong');
    const { runId } = await runProviderBaseline(ctx, { kind: 'pending', provider: 'anthropic', targetId: target.targetId, targetVersion: target.targetVersion, consent: true });
    expect((await runRow(runId)).state).toBe('failed');
    await expect(acceptProviderBaselineFailure(hr, { runId, reason: 'A company administrator tries to accept this.' })).rejects.toThrow();
    await expect(acceptProviderBaselineFailure(ctx, { runId, reason: 'too short' })).rejects.toMatchObject({ code: 'reason_required' });
    expect((await runRow(runId)).state).toBe('failed'); expect(await events('ai-control.provider-baseline-accepted')).toEqual([]);
    await expect(setActiveProvider(ctx, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    const reason = 'Known formatting difference on one refusal case; reviewed by the group administrator.';
    await acceptProviderBaselineFailure(ctx, { runId, reason });
    expect(await runRow(runId)).toMatchObject({ state: 'accepted', accepted_reason: reason, accepted_by_user_id: base.adminUserId });
    const [audit] = await events('ai-control.provider-baseline-accepted');
    expect(audit).toMatchObject({ aggregateType: 'ai-control', aggregateId: runId, payload: { target: 'pending', provider: 'anthropic', model: 'claude-sonnet-4-6', previousState: 'failed', reason } });
    await expect(acceptProviderBaselineFailure(ctx, { runId, reason })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await pendingTarget(ctx, 'anthropic')).run).toMatchObject({ state: 'accepted', acceptedReason: reason });
    // A run of a superseded version cannot be accepted, and its acceptance does not carry over.
    const second = await startBaselineRunFixture(ctx, { kind: 'pending', provider: 'anthropic' });
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-haiku-4-5' });
    await expect(acceptProviderBaselineFailure(ctx, { runId: second, reason })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(setActiveProvider(ctx, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    await acceptBaselineFixture(ctx, { kind: 'pending', provider: 'anthropic' });
    await setActiveProvider(ctx, { provider: 'anthropic' });
    expect(await live()).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('runs baseline spend under the administrator’s own allowance and stops a batch on refusal', async () => {
    const ctx = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] } as SessionContext;
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'fixture-anthropic-key' });
    await setAiAllowance(ctx, { kind: 'user', subjectId: base.adminUserId, dailyRequests: 2, monthlyTokens: null, maxConcurrent: null, enabled: true });
    const right = transport(anthropicAdapter, 'correct'), target = await pendingTarget(ctx, 'anthropic');
    const result = await runProviderBaseline(ctx, { kind: 'pending', provider: 'anthropic', targetId: target.targetId, targetVersion: target.targetVersion, consent: true });
    expect(result).toMatchObject({ state: 'evaluating', attempted: 3, interrupted: true });
    expect(right).toHaveBeenCalledTimes(2);
    expect((await runRow(result.runId)).suites.read_plan).toMatchObject({ next: 2, failed: 0 });
    const blocked = (await owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId, base.tenantId))).filter(r => r.state === 'blocked');
    expect(blocked).toHaveLength(1); expect(blocked[0]).toMatchObject({ featureId: 'provider_evaluation', reason: 'daily_limit', userId: base.adminUserId });
    await expect(runProviderBaseline(ctx, { kind: 'pending', provider: 'anthropic', targetId: target.targetId, targetVersion: target.targetVersion, consent: false })).rejects.toMatchObject({ code: 'consent_required' });
    await expect(runProviderBaseline(ctx, { kind: 'pending', provider: 'anthropic', targetId: target.targetId, targetVersion: randomUUID(), consent: true })).rejects.toMatchObject({ code: 'stale' });
    expect(right).toHaveBeenCalledTimes(2);
  });

  it('keeps company HR administrators out of provider changes and feature caps', async () => {
    const ctx = adminCtx(base), hr = await companyHr();
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'fixture-anthropic-key' });
    const target = await pendingTarget(ctx, 'anthropic'), mock = transport(anthropicAdapter);
    await expect(saveAiProviderConfig(hr, { provider: 'openai', model: 'gpt-5.5', apiKey: 'fixture-hr-key' })).rejects.toThrow();
    await expect(setActiveProvider(hr, { provider: 'anthropic' })).rejects.toThrow();
    await expect(discardPendingAiProviderChange(hr, { provider: 'anthropic' })).rejects.toThrow();
    await expect(getAiProviderChangeView(hr)).rejects.toThrow();
    await expect(runProviderBaseline(hr, { kind: 'pending', provider: 'anthropic', targetId: target.targetId, targetVersion: target.targetVersion, consent: true })).rejects.toThrow();
    await expect(setAiFeatureCap(hr, { feature: 'pay_rule_draft', dailyRequests: 1, monthlyTokens: null })).rejects.toBeInstanceOf(AiControlError);
    expect(mock).not.toHaveBeenCalled();
    expect((await pendingRows()).map(r => [r.provider, r.model])).toEqual([['anthropic', 'claude-sonnet-4-6']]);
    expect(await owner.db.select().from(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.tenantId, base.tenantId))).toEqual([]);
    expect(await owner.db.execute(sql`select id from public.ai_provider_baseline_run where tenant_id=${base.tenantId}::uuid`)).toHaveLength(0);
  });

  it('isolates pending changes and runs by tenant', async () => {
    const ctx = adminCtx(base);
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'fixture-anthropic-key' });
    const runId = await startBaselineRunFixture(ctx, { kind: 'pending', provider: 'anthropic' });
    const [mine] = await pendingRows();
    const other = await seedBase(), foreign = adminCtx(other);
    expect((await getAiProviderChangeView(foreign)).targets).toEqual([]);
    expect((await getAiConfigView(foreign)).providers.find(p => p.provider === 'anthropic')).toMatchObject({ configured: false, pendingSaved: false });
    await expect(setActiveProvider(foreign, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    await expect(acceptProviderBaselineFailure(foreign, { runId, reason: 'Another tenant tries to accept this run.' })).rejects.toThrow();
    await expect(withTenant(foreign, tx => tx.execute(sql`select * from app.ai_provider_pending_activate_v1(${mine.id}::uuid,${mine.version_token}::uuid,${PROVIDER_BASELINE_SUITE_DIGEST})`))).rejects.toThrow();
    expect(await withTenant(foreign, tx => tx.execute(sql`select id from app.ai_provider_pending_resolve_v1('anthropic')`))).toHaveLength(0);
    expect(await withTenant(foreign, tx => tx.execute(sql`select id from public.ai_provider_baseline_run`))).toHaveLength(0);
    await expect(discardPendingAiProviderChange(foreign, { provider: 'anthropic' })).rejects.toThrow(AiConfigError);
    expect(await withTenant(foreign, tx => resolveActiveAiConfig(tx, foreign))).toBeNull();
    expect((await pendingRows()).map(r => [r.tenant_id, r.provider])).toEqual([[base.tenantId, 'anthropic']]);
    expect((await runRow(runId)).state).toBe('evaluating');
  });

  it('flags an active configuration that no passed or accepted baseline admitted, and never blocks it', async () => {
    const ctx = adminCtx(base);
    // A configuration activated before 0694 has no admitting run: flagged, still serving.
    await owner.db.insert(schema.aiProviderConfig).values({ tenantId: base.tenantId, provider: 'openai', model: 'fictional-legacy-model',
      apiKeyCiphertext: encryptSecret('fixture-legacy-key', base.tenantId), keyLast4: '-key', isActive: true });
    expect((await getAiProviderChangeView(ctx)).active).toEqual({ provider: 'openai', label: 'OpenAI', model: 'fictional-legacy-model', evaluated: false });
    expect(await live()).toMatchObject({ provider: 'openai', model: 'fictional-legacy-model', apiKey: 'fixture-legacy-key' });
    // Gated activation records the admitting run for that exact version.
    await activateDirectProviderFixture(ctx, { provider: 'openai', model: 'fictional-evaluated-model' });
    expect((await getAiProviderChangeView(ctx)).active).toMatchObject({ model: 'fictional-evaluated-model', evaluated: true });
    const row = async () => (await owner.db.select().from(schema.aiProviderConfig).where(and(eq(schema.aiProviderConfig.tenantId, base.tenantId), eq(schema.aiProviderConfig.isActive, true))))[0];
    expect((await row()).baselineRunId).toMatch(/^[0-9a-f-]{36}$/);
    // Any in-place change that names no new run clears it (0694 trigger); the configuration keeps serving.
    await owner.db.update(schema.aiProviderConfig).set({ model: 'fictional-edited-in-place' }).where(eq(schema.aiProviderConfig.tenantId, base.tenantId));
    expect((await row()).baselineRunId).toBeNull();
    expect((await getAiProviderChangeView(ctx)).active).toMatchObject({ model: 'fictional-edited-in-place', evaluated: false });
    expect(await live()).toMatchObject({ provider: 'openai', model: 'fictional-edited-in-place' });
    await owner.db.update(schema.aiProviderConfig).set({ isActive: false }).where(eq(schema.aiProviderConfig.tenantId, base.tenantId));
    // OpenRouter promotion records its admitting run too.
    await saveAiProviderConfig(ctx, { provider: 'openrouter', model: 'fictional/model', apiKey: 'fixture-openrouter-key',
      providerOptions: readOpenRouterOptions({ version: 1, routing: { allowedProviders: ['approved-a'], allowFallbacks: false, sort: 'latency' } }) });
    await activateSyntheticCandidate(ctx);
    expect((await getAiProviderChangeView(ctx)).active).toMatchObject({ provider: 'openrouter', model: 'fictional/model', evaluated: true });
  });

  it('fingerprints the platform default model and says when it has not been re-evaluated', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-platform-key'); vi.stubEnv('AI_DRAFT_MODEL', 'fictional-platform-model-a');
    const ctx = adminCtx(base);
    let view = await getAiProviderChangeView(ctx);
    expect(view.platform).toMatchObject({ provider: 'anthropic', model: 'fictional-platform-model-a', evaluated: false });
    transport(anthropicAdapter, 'wrong');
    const { runId, state } = await runProviderBaseline(ctx, { kind: 'environment', consent: true });
    expect(state).toBe('failed');
    await acceptProviderBaselineFailure(ctx, { runId, reason: 'Platform model reviewed by the group administrator.' });
    expect((await getAiProviderChangeView(ctx)).platform).toMatchObject({ evaluated: true });
    vi.stubEnv('AI_DRAFT_MODEL', 'fictional-platform-model-b');
    view = await getAiProviderChangeView(ctx);
    expect(view.platform).toMatchObject({ model: 'fictional-platform-model-b', evaluated: false });
    expect(view.targets.find(t => t.kind === 'environment')).toMatchObject({ status: 'pending', run: null });
    // While the tenant runs its own configuration, the platform default is not in use and cannot be run here.
    await activateDirectProviderFixture(ctx, { provider: 'openai', model: 'fictional-live-model', apiKey: 'fixture-live-key' });
    expect((await getAiProviderChangeView(ctx)).platform).toBeNull();
    await expect(runProviderBaseline(ctx, { kind: 'environment', consent: true })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('per-feature caps (WP14)', () => {
  const admit = (ctx: SessionContext, feature: string, reserve = 100) => withTenant(ctx, async tx => (await tx.execute<{ run_id: string; allowed: boolean; blocked_reason: string | null }>(sql`select * from app.ai_admit(${feature},'draft','openai','fixture',${reserve}::bigint)`))[0]);
  const settle = (ctx: SessionContext, run: string, tokens: number) => withTenant(ctx, tx => tx.execute(sql`select app.ai_settle(${run}::uuid,true,${tokens}::bigint)`));

  it('lets a group administrator cap one feature for the whole tenant and ai_admit enforces it', async () => {
    const ctx = { ...await entitledCtx(base), grants: [{ role: 'hr_admin', companyId: null }] } as SessionContext;
    await setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: 1, monthlyTokens: null, maxConcurrent: null });
    const first = await admit(ctx, 'pay_rule_draft');
    expect(first).toMatchObject({ allowed: true, blocked_reason: null });
    await settle(ctx, first.run_id, 10);
    expect(await admit(ctx, 'pay_rule_draft')).toMatchObject({ allowed: false, blocked_reason: 'daily_limit' });
    expect(await admit(ctx, 'payroll_explanation')).toMatchObject({ allowed: true });
    // Tokens: recorded plus the new reservation must stay within the monthly feature cap.
    await setAiFeatureCap(ctx, { feature: 'report_insight', dailyRequests: null, monthlyTokens: 150 });
    const used = await admit(ctx, 'report_insight', 100); await settle(ctx, used.run_id, 100);
    expect(await admit(ctx, 'report_insight', 60)).toMatchObject({ allowed: false, blocked_reason: 'monthly_limit' });
    expect(await admit(ctx, 'report_insight', 40)).toMatchObject({ allowed: true });
    const [policy] = await owner.db.select().from(schema.aiControlPolicy).where(and(eq(schema.aiControlPolicy.tenantId, base.tenantId), eq(schema.aiControlPolicy.scopeKey, 'feature:pay_rule_draft')));
    expect(policy).toMatchObject({ kind: 'feature', featureId: 'pay_rule_draft', subjectId: null, dailyRequests: 1, monthlyTokens: null, enabled: true });
    const changes = (await events('ai-control.feature-cap-changed')).map(e => e.payload);
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(expect.arrayContaining([
      { feature: 'pay_rule_draft', dailyRequests: 1, monthlyTokens: null, maxConcurrent: null },
      { feature: 'report_insight', dailyRequests: null, monthlyTokens: 150, maxConcurrent: null }]));
  });

  it('counts every login’s runs of the feature and keeps the feature switch separate from its cap', async () => {
    const ctx = { ...await entitledCtx(base), grants: [{ role: 'hr_admin', companyId: null }] } as SessionContext;
    const [someone] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: 'fixture-other-login-' + randomUUID(), personId: null }).returning();
    await owner.db.insert(schema.aiModelRun).values({ tenantId: base.tenantId, userId: someone.id, featureId: 'pay_rule_draft', operation: 'draft', provider: 'openai', model: 'fixture', state: 'completed', reservedTokens: 10, actualTokens: 10 });
    await setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: 1, monthlyTokens: null });
    expect(await admit(ctx, 'pay_rule_draft')).toMatchObject({ allowed: false, blocked_reason: 'daily_limit' });
    await setAiFeature(ctx, 'pay_rule_draft', false);
    await setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: 5, monthlyTokens: 1000, maxConcurrent: 2 });
    const scope = () => owner.db.select().from(schema.aiControlPolicy).where(and(eq(schema.aiControlPolicy.tenantId, base.tenantId), eq(schema.aiControlPolicy.scopeKey, 'feature:pay_rule_draft')));
    expect((await scope())[0]).toMatchObject({ enabled: false, dailyRequests: 5, monthlyTokens: 1000, maxConcurrent: 2 });
    expect(await admit(ctx, 'pay_rule_draft')).toMatchObject({ allowed: false, blocked_reason: 'paused' });
    await setAiFeature(ctx, 'pay_rule_draft', true);
    expect((await scope())[0]).toMatchObject({ enabled: true, dailyRequests: 5, monthlyTokens: 1000, maxConcurrent: 2 });
    expect(await admit(ctx, 'pay_rule_draft')).toMatchObject({ allowed: true });
    await setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: null, monthlyTokens: null, maxConcurrent: null });
    expect((await scope())[0]).toMatchObject({ enabled: true, dailyRequests: null, monthlyTokens: null, maxConcurrent: null });
  });

  it('refuses invalid values and features governed by a module setting, without a write', async () => {
    const ctx = { ...await entitledCtx(base), grants: [{ role: 'hr_admin', companyId: null }] } as SessionContext;
    for (const bad of [-1, 0.5, 1000001]) await expect(setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: bad, monthlyTokens: null })).rejects.toBeInstanceOf(AiControlError);
    for (const feature of ['claims_triage', 'performance_review', 'feedback_planning', 'not_a_feature']) await expect(setAiFeatureCap(ctx, { feature, dailyRequests: 1, monthlyTokens: null })).rejects.toBeInstanceOf(AiControlError);
    expect(await owner.db.select().from(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.tenantId, base.tenantId))).toEqual([]);
    // 0694 relaxed the constraint only for the caps of a well-formed feature row.
    await expect(owner.db.insert(schema.aiControlPolicy).values({ tenantId: base.tenantId, scopeKey: 'feature:report_insight', kind: 'feature', featureId: 'report_insight', subjectId: base.companyId, dailyRequests: 1 })).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
