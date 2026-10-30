/** TEST ONLY: synthetic privacy-review seam for this legacy gateway-control suite. The new
 * disclosure assertion/consumption is isolated so the original protocol, capture, source, admission,
 * spend and accounting controls below are still exercised. Actual binding/transfer/revocation and
 * provider egress dispatch remain real. Dedicated provider-privacy-request, provider-data-review-gate
 * and ai-private-analysis suites exercise the real default-block/review policy separately. This
 * fixture grants no production review status and admits no real provider data. */
vi.mock('../lib/ai/provider-privacy-request', async importActual => {
  const actual = await importActual<typeof import('../lib/ai/provider-privacy-request')>();
  return { ...actual, assertProviderPrivacyRequest: () => {}, consumeProviderPrivacyRequest: () => {} };
});

/** Actual current-config admission cases, authored UNRUN. Fake keys; mocked callbacks/transports only. */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tenantDb from '../db/client';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { disableAi, resolveActiveAiConfig, saveAiProviderConfig } from '../core/ai-config';
import { governedAiConfig } from '../core/ai-governance';
import { resolveAiProviderSnapshotTx, AI_PROVIDER_SNAPSHOT_MAX_AGE_MS } from '../core/ai-provider-snapshot';
import { generateDraft, converse } from '../lib/ai';
import { defaultModelFor } from '../lib/ai/registry';
import { openrouterAdapter } from '../lib/ai/providers/openrouter';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { activateSyntheticCandidate } from './provider-evaluation-fixture';
import { activateDirectProviderFixture } from './ai-provider-change-fixture';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => {
  vi.stubEnv('AI_CONFIG_SECRET', 'fictional-provider-snapshot-test-passphrase');
  vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENAI_API_KEY', 'fixture-platform-key');
  vi.stubEnv('GOOGLE_API_KEY', ''); vi.stubEnv('GEMINI_API_KEY', '');
  await resetDb(); base = await seedBase();
});
afterAll(async () => { await closeAll(); vi.unstubAllEnvs(); });
const routes = (provider = 'approved-a') => readOpenRouterOptions({ version: 1, routing: { allowedProviders: [provider], allowFallbacks: false, sort: 'latency' } });
const allRows = () => owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId, base.tenantId));
const rows = async () => (await allRows()).filter(row => row.featureId !== 'provider_evaluation');
async function evaluatedActivation() {
  const prior = (await allRows()).filter(row => row.featureId === 'provider_evaluation').length;
  await activateSyntheticCandidate(adminCtx(base));
  const evaluations = (await allRows()).filter(row => row.featureId === 'provider_evaluation');
  expect(evaluations.length).toBe(prior + 3);
  expect(evaluations.every(row => row.state === 'completed' && row.actualTokens === 0)).toBe(true);
  // The synthetic evaluation installs a tenant-wide USD cap for its own reviewed carrier. This file tests the
  // provider-configuration binding of a rootless pay_rule_draft, not caps: a configured cap (zero included)
  // rightly refuses that rootless call (AiSpendControlError), so remove the cap the evaluation left behind.
  await owner.db.execute(sql`delete from app.ai_spend_budget where tenant_id=${base.tenantId}::uuid`);
}

async function prepared() {
  const ctx = adminCtx(base);
  const cfg = await withTenant(ctx, tx => resolveActiveAiConfig(tx, ctx, 'pay_rule_draft'));
  if (!cfg) throw Error('Missing fixture config');
  return cfg;
}
async function configure() {
  await saveAiProviderConfig(adminCtx(base), { provider: 'openrouter', model: 'fictional/model', apiKey: 'fixture-tenant-key', providerOptions: routes() });
  await evaluatedActivation();
  return prepared();
}
const run = (cfg: Awaited<ReturnType<typeof prepared>>, invoked: () => void) => cfg.governance!.run({ operation: 'draft', reservedTokens: 10 }, async record => {
  invoked(); record({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }); return 'fictional result';
});

describe('prepared provider configuration binding', () => {
  it('admits an unchanged actual configuration with honestly reported zero usage', async () => {
    const cfg = await configure(), callback = vi.fn();
    expect(Object.isFrozen(cfg)).toBe(true);
    await expect(run(cfg, callback)).resolves.toBe('fictional result');
    expect(callback).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({ state: 'completed', actualTokens: 0 });
    expect(JSON.stringify(await rows())).not.toContain('fixture-tenant-key');
  });
  it.each(['model', 'key', 'routes', 'provider', 'disabled'] as const)('refuses a prepared %s change before callback and before creating any admission', async change => {
    const cfg = await configure(), ctx = adminCtx(base);
    if (change === 'model') await saveAiProviderConfig(ctx, { provider: 'openrouter', model: 'fictional/new-model' });
    if (change === 'key') await saveAiProviderConfig(ctx, { provider: 'openrouter', model: 'fictional/model', apiKey: 'fixture-rotated-key' });
    if (change === 'routes') await saveAiProviderConfig(ctx, { provider: 'openrouter', model: 'fictional/model', providerOptions: routes('approved-b') });
    if (['model','key','routes'].includes(change)) await evaluatedActivation();
    if (change === 'provider') await activateDirectProviderFixture(ctx, { provider: 'openai', model: 'fictional-direct-model', apiKey: 'fixture-other-key' });
    if (change === 'disabled') await disableAi(ctx);
    const callback = vi.fn();
    await expect(run(cfg, callback)).rejects.toThrow('current AI configuration');
    expect(callback).not.toHaveBeenCalled(); expect(await rows()).toEqual([]);
    // New explicit preparation uses the actual new state, not a silent retarget of cfg.
    await expect(run(await prepared(), callback)).resolves.toBe('fictional result');
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('distinguishes stored-key origin from identical environment parameters in both directions', async () => {
    const fallback = await prepared(), ctx = adminCtx(base);
    await activateDirectProviderFixture(ctx, { provider: 'openai', model: defaultModelFor('openai'), apiKey: 'fixture-platform-key' });
    const stored = await prepared(), callback = vi.fn();
    expect(stored.apiKey).toBe(fallback.apiKey); expect(stored.model).toBe(fallback.model);
    await expect(run(fallback, callback)).rejects.toThrow('current AI configuration');
    await disableAi(ctx);
    await expect(run(stored, callback)).rejects.toThrow('current AI configuration');
    expect(callback).not.toHaveBeenCalled(); expect(await rows()).toEqual([]);
  });
  it('refuses environment key rotation, expired snapshots and serialized/lookalike snapshots', async () => {
    const cfg = await prepared(), callback = vi.fn();
    vi.stubEnv('OPENAI_API_KEY', 'fixture-platform-rotated');
    await expect(run(cfg, callback)).rejects.toThrow('current AI configuration');
    const ctx = adminCtx(base), snapshot = (await withTenant(ctx, tx => resolveAiProviderSnapshotTx(tx, ctx)))!;
    expect(() => governedAiConfig(ctx, { ...snapshot }, 'pay_rule_draft')).toThrow('current AI configuration');
    const current = await prepared();
    const future = Date.now() + AI_PROVIDER_SNAPSHOT_MAX_AGE_MS + 1;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(future);
    try { await expect(run(current, callback)).rejects.toThrow('current AI configuration'); }
    finally { clock.mockRestore(); }
    expect(callback).not.toHaveBeenCalled(); expect(await rows()).toEqual([]);
  });
  it('refuses copied governance on a different outgoing key/model/route before draft or conversation transport', async () => {
    const cfg = await configure();
    const draft = vi.spyOn(openrouterAdapter, 'generate'), chat = vi.spyOn(openrouterAdapter, 'converse');
    try {
      await expect(generateDraft({ ...cfg, apiKey: 'retargeted-key' }, { system: 'fixture', prompt: 'private fixture text' })).rejects.toThrow('current AI configuration');
      await expect(converse({ ...cfg, model: 'fictional/retargeted-model' }, { system: ['fixture'], tools: [], turns: [{ role: 'user', content: 'private fixture text' }] })).rejects.toThrow('current AI configuration');
      await expect(generateDraft({ ...cfg, providerOptions: routes('approved-b') }, { system: 'fixture', prompt: 'private fixture text' })).rejects.toThrow('current AI configuration');
      expect(draft).not.toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled(); expect(await rows()).toEqual([]);
    } finally { draft.mockRestore(); chat.mockRestore(); }
  });
  it('captures the actual transport config before a retained caller mutates it during asynchronous admission', async () => {
    const cfg = await configure(), mutable = { ...cfg };
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const original = tenantDb.withTenant;
    const boundary = vi.spyOn(tenantDb, 'withTenant').mockImplementationOnce(async (ctx, fn) => { entered(); await held; return original(ctx, fn); });
    const transport = vi.spyOn(openrouterAdapter, 'generate').mockImplementation(async (actual, args) => {
      expect(actual.provider).toBe('openrouter'); expect(actual.model).toBe('fictional/model');
      expect(actual.apiKey).toBe('fixture-tenant-key'); expect(actual.providerOptions).toEqual(routes());
      expect(Object.isFrozen(actual)).toBe(true);
      args.onUsage?.({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
      return 'fictional result';
    });
    const pending = generateDraft(mutable, { system: 'fixture', prompt: 'fixture' });
    try {
      await reached;
      mutable.provider = 'openai'; mutable.model = 'retargeted'; mutable.apiKey = 'retargeted'; mutable.providerOptions = routes('approved-b');
      release(); await expect(pending).resolves.toBe('fictional result');
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { release(); await pending.catch(() => {}); boundary.mockRestore(); transport.mockRestore(); }
  });
});
