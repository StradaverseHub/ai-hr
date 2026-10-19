/**
 * r570 — OpenRouter is OFF per tenant until a group admin allows it (`ai.openrouter_enabled`), and the
 * service enforces that against the database, not the request's cached snapshot:
 *   - off → save, activate and test are refused; an active OpenRouter row FAILS CLOSED in
 *     resolveActiveAiConfig (no fall-through to the platform env key) and reads as "not configured";
 *   - turning it off deactivates an active OpenRouter config in the same transaction;
 *   - tenant isolation: one tenant's opt-in and key are invisible and unusable for another;
 *   - a governed OpenRouter call writes an ai_model_run row tagged 'openrouter', and with no provider
 *     usage the reservation stays held (actual_tokens null) rather than settling a fake zero.
 * Transport is a stubbed globalThis.fetch; no network, no real key.
 */
process.env.AI_CONFIG_SECRET = 'ai-hr-test-master-passphrase-0123456789';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.AI_DRAFT_MODEL;

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import {
  AiConfigError,
  getAiConfigView,
  isAiConfigured,
  resolveActiveAiConfig,
  saveAiProviderConfig,
  setActiveProvider,
  setOpenRouterEnabled,
  testConnection,
} from '../core/ai-config';
import { aiManagementView } from '../core/ai-management';
import { generateDraft } from '../lib/ai';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setSetting, type Base } from './harness';

const KEY_A = 'sk-or-v1-TENANTA-0001';
const MODEL = 'anthropic/claude-sonnet-5.5';
let base: Base, group: SessionContext;
const groupOf = (b: Base): SessionContext => ({ ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] });

const fetchMock = vi.fn();
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  group = groupOf(base);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error('unexpected network call');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(closeAll);

const resolve = (ctx: SessionContext, feature?: Parameters<typeof resolveActiveAiConfig>[2]) => withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx, feature));
const events = (tenantId: string) =>
  owner.db.select({ type: schema.domainEvent.eventType, payload: schema.domainEvent.payload }).from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, tenantId)).orderBy(schema.domainEvent.occurredAt, schema.domainEvent.id);
const rows = (tenantId: string) =>
  owner.db.select({ provider: schema.aiProviderConfig.provider, isActive: schema.aiProviderConfig.isActive }).from(schema.aiProviderConfig).where(eq(schema.aiProviderConfig.tenantId, tenantId)).orderBy(schema.aiProviderConfig.provider);

async function enableAndActivate(ctx: SessionContext) {
  await setOpenRouterEnabled(ctx, true);
  await saveAiProviderConfig(ctx, { provider: 'openrouter', model: MODEL, apiKey: KEY_A, makeActive: true });
}

describe('OpenRouter is off by default', () => {
  it('refuses save, activate and test while the tenant has not allowed it', async () => {
    const view = await getAiConfigView(group);
    expect(view.openRouterEnabled).toBe(false);
    expect(view.mayToggleOpenRouter).toBe(true);
    const or = view.providers.find((p) => p.provider === 'openrouter')!;
    expect(or).toMatchObject({ optIn: true, imageReading: false, envKeyPresent: false, configured: false, keyLast4: null });
    expect(view.providers.find((p) => p.provider === 'anthropic')).toMatchObject({ optIn: false, imageReading: true });

    await expect(saveAiProviderConfig(group, { provider: 'openrouter', model: MODEL, apiKey: KEY_A, makeActive: true })).rejects.toBeInstanceOf(AiConfigError);
    await expect(setActiveProvider(group, { provider: 'openrouter' })).rejects.toBeInstanceOf(AiConfigError);
    await expect(testConnection(group, { provider: 'openrouter', model: MODEL, apiKey: KEY_A })).resolves.toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rows(base.tenantId)).toEqual([]);
  });

  it('only a GROUP admin may allow it', async () => {
    const companyAdmin = adminCtx(base); // hr_admin with no group-wide grant
    expect((await getAiConfigView(companyAdmin)).mayToggleOpenRouter).toBe(false);
    await expect(setOpenRouterEnabled(companyAdmin, true)).rejects.toBeInstanceOf(AiConfigError);
    expect((await getAiConfigView(group)).openRouterEnabled).toBe(false);
  });
});

describe('allowing, using and disallowing', () => {
  it('stores and resolves an OpenRouter key once allowed, and audits the switch', async () => {
    await enableAndActivate(group);
    expect((await getAiConfigView(group)).openRouterEnabled).toBe(true);
    expect(await resolve(group)).toMatchObject({ provider: 'openrouter', model: MODEL, apiKey: KEY_A });
    expect(await isAiConfigured(group)).toBe(true);
    const types = (await events(base.tenantId)).map((e) => e.type);
    expect(types).toContain('tenant-setting.changed');
    expect(types).toContain('ai-provider-config.saved');
    expect(JSON.stringify(await events(base.tenantId))).not.toContain(KEY_A);
    const mgmt = await aiManagementView(group);
    expect(mgmt.provider).toEqual({ provider: 'openrouter', model: MODEL });
  });

  it('turning it off deactivates the active OpenRouter config in the same step and keeps the key unusable', async () => {
    await saveAiProviderConfig(group, { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-ant-tenant-1111' });
    await enableAndActivate(group);
    await setOpenRouterEnabled(group, false);
    expect(await rows(base.tenantId)).toEqual([
      { provider: 'anthropic', isActive: false },
      { provider: 'openrouter', isActive: false },
    ]);
    const disabled = (await events(base.tenantId)).filter((e) => e.type === 'ai-provider-config.disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0].payload).toEqual({ provider: 'openrouter', reason: 'openrouter_disallowed' });
    await expect(setActiveProvider(group, { provider: 'openrouter' })).rejects.toThrow('not allowed');
    await expect(saveAiProviderConfig(group, { provider: 'openrouter', model: MODEL })).rejects.toThrow('not allowed');
    // Other providers are untouched by the switch.
    await setActiveProvider(group, { provider: 'anthropic' });
    expect((await resolve(group))?.provider).toBe('anthropic');
  });

  it('an active OpenRouter row whose setting is off FAILS CLOSED, even with a platform env key present', async () => {
    await enableAndActivate(group);
    // The setting flips without passing through setOpenRouterEnabled (a platform write, or a race with an
    // activation that read it as on). The row is still active.
    await setSetting(base.tenantId, 'ai.openrouter_enabled', false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-platform-env';
    expect((await rows(base.tenantId)).find((r) => r.provider === 'openrouter')?.isActive).toBe(true);
    await expect(resolve(group)).rejects.toBeInstanceOf(AiConfigError);
    await expect(resolve(group, 'pay_rule_draft')).rejects.toBeInstanceOf(AiConfigError);
    expect(await isAiConfigured(group)).toBe(false);
    await expect(testConnection(group, { provider: 'openrouter', model: MODEL })).resolves.toMatchObject({ ok: false });
    const mgmt = await aiManagementView(group);
    expect(mgmt.provider).toBeNull();
    expect(mgmt.features.find((f) => f.id === 'report_insight')?.state).toBe('provider');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tenant isolation', () => {
  it("one tenant's opt-in and key are invisible and unusable to another", async () => {
    await enableAndActivate(group);
    const other = await seedBase();
    const groupB = groupOf(other);

    const viewB = await getAiConfigView(groupB);
    expect(viewB.openRouterEnabled).toBe(false);
    expect(viewB.providers.find((p) => p.provider === 'openrouter')).toMatchObject({ configured: false, keyLast4: null, isActive: false });
    expect(JSON.stringify(viewB)).not.toContain('0001');
    expect(await resolve(groupB)).toBeNull();
    expect(await isAiConfigured(groupB)).toBe(false);
    await expect(saveAiProviderConfig(groupB, { provider: 'openrouter', model: MODEL, apiKey: 'sk-or-v1-TENANTB', makeActive: true })).rejects.toBeInstanceOf(AiConfigError);
    await expect(setActiveProvider(groupB, { provider: 'openrouter' })).rejects.toBeInstanceOf(AiConfigError);
    expect(await rows(other.tenantId)).toEqual([]);

    // B turning its own switch on and off does not touch A.
    await setOpenRouterEnabled(groupB, true);
    await setOpenRouterEnabled(groupB, false);
    expect(await resolve(group)).toMatchObject({ provider: 'openrouter', apiKey: KEY_A });
  });
});

describe('governed OpenRouter call', () => {
  const runs = () =>
    owner.db.select().from(schema.aiModelRun).where(and(eq(schema.aiModelRun.tenantId, base.tenantId), eq(schema.aiModelRun.provider, 'openrouter'))).orderBy(schema.aiModelRun.startedAt, schema.aiModelRun.id);
  const reply = (usage: unknown) =>
    new Response(JSON.stringify({ id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'A draft.' }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('records the run as openrouter and holds the reservation when usage is absent', async () => {
    await enableAndActivate(group);
    const cfg = (await resolve(group, 'pay_rule_draft'))!;
    expect(cfg.governance).toBeDefined();

    fetchMock.mockImplementationOnce(async () => reply(null));
    await expect(generateDraft(cfg, { system: 's', prompt: 'p' })).resolves.toBe('A draft.');
    fetchMock.mockImplementationOnce(async () => reply({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } }));
    await expect(generateDraft(cfg, { system: 's', prompt: 'p' })).resolves.toBe('A draft.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/chat/completions');

    const all = await runs();
    expect(all).toHaveLength(2);
    const held = all.find((r) => r.actualTokens === null)!;
    const settled = all.find((r) => r.actualTokens !== null)!;
    expect(held).toMatchObject({ provider: 'openrouter', model: MODEL, state: 'completed', actualTokens: null });
    expect(held.reservedTokens).toBeGreaterThan(0);
    expect(settled).toMatchObject({ provider: 'openrouter', state: 'completed', actualTokens: 120 });
    expect(JSON.stringify(await runs())).not.toContain(KEY_A);
  });
});
