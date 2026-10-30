import {createUngovernedProbe} from '../lib/ai/governance';
/**
 * AI provider configuration service (ADR-0023). Per-tenant BYOK: an admin configures a provider with
 * an encrypted key and activates one; the gateway resolves the active config (or the platform env
 * fallback) at draft time. Security contract enforced here AND in RLS (0059):
 *
 *  - Admin-only writes (assertAdmin + RLS WITH CHECK app.is_admin()).
 *  - The plaintext key is encrypted (tenant id as AAD) before it ever touches the DB, and the
 *    ciphertext is NEVER read back by app code via a normal query — `resolveActiveAiConfig` reads it
 *    only through the SECURITY DEFINER resolver, and only the decrypted result lives in request memory.
 *  - The UI view (`getAiConfigView`) never selects the ciphertext column.
 *  - Domain events carry provider/model and a nonsecret OpenRouter route digest — never the key, ciphertext, or test result.
 *  - Fail closed: a present-but-undecryptable active config errors; it does NOT silently fall through
 *    to the shared platform env key.
 */
import { createHash } from 'node:crypto';
import { governedAiConfig } from './ai-governance';
import { resolveAiProviderSnapshotTx, resolveAiProviderCandidateSnapshotTx } from './ai-provider-snapshot';
import type { AiFeatureId } from '../lib/ai/features';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { aiProviderConfig } from '../db/schema';
import {
  envFallbackConfig,
  hasEnvFallback,
  isProvider,
  isSecretStorable,
  PROVIDER_META,
  PROVIDERS,
  validateConfig,
  type AiProvider,
  type ResolvedAiConfig,
  type ValidateResult,
} from '../lib/ai';
import { encryptSecret, keyLast4 } from '../lib/ai/crypto';
import { currentAiProviderAdminTx } from './ai-provider-authority';
import { activateOpenRouterCandidateTx, providerCandidatesTx, removeOpenRouterCandidateTx, saveOpenRouterCandidateTx } from './ai-provider-readiness';
import { readOpenRouterOptions, type OpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { readGatewayOptions } from '../lib/ai/providers/gateway-options';
import { OpenRouterModel } from '../lib/ai/providers/openrouter-transport';
import { PROVIDER_BASELINE_SUITE_DIGEST } from '../lib/ai/provider-baseline-suites';

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

const isAdminCtx = (ctx: SessionContext) =>
  (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');

function assertAdmin(ctx: SessionContext) {
  if (!isAdminCtx(ctx)) throw new AiConfigError('Only an admin can manage AI configuration.');
}

/** Tenant-wide key/routing configuration requires fresh group-wide authority, not a stale page
 * role or one company's HR grant. Existing RLS and withheld ciphertext grants still apply. */
async function assertConfigurationAdminTx(tx: Tx, ctx: SessionContext) {
  assertAdmin(ctx);
  if(!(await currentAiProviderAdminTx(tx,ctx)))throw new AiConfigError('Only a current group-wide administrator can manage AI configuration.');
}

function routingOptions(value:unknown):OpenRouterOptions {
  try{return readOpenRouterOptions(value);}catch{throw new AiConfigError('Approved AI routing configuration is required.');}
}
function providerModel(provider:AiProvider,model:string){
  if(provider==='openrouter'&&!OpenRouterModel.safeParse(model).success)throw new AiConfigError('Enter an explicit provider/model identifier.');
}

// ─────────────────────────────── reads ───────────────────────────────

export type AiProviderView = {
  provider: AiProvider;
  label: string;
  models: string[];
  defaultModel: string;
  configured: boolean; // a key is stored for this provider
  model: string;
  keyLast4: string | null;
  isActive: boolean;
  providerOptions: OpenRouterOptions | null;
  /** ai_gateway only (0661): the stored https address. */
  gatewayBaseUrl: string | null;
  candidateSaved: boolean;
  candidateId: string | null;
  candidateVersion: string | null;
  /** WP14: a direct provider has a saved change awaiting its baseline checks (never served until activated). */
  pendingSaved?: boolean;
  activeModel: string | null;
  envKeyPresent: boolean; // a platform env key exists for this provider
};

export type AiConfigView = {
  storable: boolean; // AI_CONFIG_SECRET is set → keys can be stored
  providers: AiProviderView[];
  envFallback: { provider: AiProvider; model: string } | null;
  usingEnvFallback: boolean; // no tenant config active, but an env key would be used
};

/** Admin-only. The settings-page model: one entry per provider, NEVER including the ciphertext. */
export function getAiConfigView(ctx: SessionContext): Promise<AiConfigView> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  return withTenant(ctx, async (tx) => {
    await assertConfigurationAdminTx(tx,ctx);
    // Explicit column list — the ciphertext is not even granted to the app role, but be unambiguous.
    const rows = await tx
      .select({
        provider: aiProviderConfig.provider,
        model: aiProviderConfig.model,
        keyLast4: aiProviderConfig.keyLast4,
        isActive: aiProviderConfig.isActive,
        providerOptions: aiProviderConfig.providerOptions,
      })
      .from(aiProviderConfig);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const candidate = (await providerCandidatesTx(tx, ctx))[0];
    const pending = new Map(Array.from(await tx.execute<{ provider: string; model: string; key_last4: string }>(sql`select provider,model,key_last4 from app.ai_provider_pending_view_v1()`)).map(r => [r.provider, r]));
    const providers: AiProviderView[] = PROVIDERS.map((p) => {
      const meta = PROVIDER_META[p];
      const row = byProvider.get(p), draft = p === 'openrouter' ? candidate : undefined, change = p === 'openrouter' ? undefined : pending.get(p);
      return {
        provider: p,
        label: meta.label,
        models: meta.models,
        defaultModel: meta.defaultModel,
        configured: Boolean(draft || row || change),
        model: draft?.model ?? change?.model ?? row?.model ?? meta.defaultModel,
        keyLast4: draft?.keyLast4 ?? change?.key_last4 ?? row?.keyLast4 ?? null,
        isActive: row?.isActive ?? false,
        providerOptions: draft?.providerOptions ?? (p==='openrouter'&&row?routingOptions(row.providerOptions):null),
        gatewayBaseUrl: p==='ai_gateway'&&row ? (()=>{ try { return readGatewayOptions(row.providerOptions).baseUrl; } catch { return null; } })() : null,
        candidateSaved: Boolean(draft),
        candidateId: draft?.id ?? null,
        candidateVersion: draft?.version ?? null,
        pendingSaved: Boolean(change),
        activeModel: row?.isActive ? row.model : null,
        envKeyPresent: meta.envKeyVars.some((v) => Boolean(process.env[v]?.trim())),
      };
    });
    const env = envFallbackConfig();
    const anyActive = providers.some((p) => p.isActive);
    return {
      storable: isSecretStorable(),
      providers,
      envFallback: env ? { provider: env.provider, model: env.model } : null,
      usingEnvFallback: !anyActive && Boolean(env),
    };
  });
}

/**
 * Resolve the config to use for a generation: the tenant's active provider (decrypted), else the
 * platform env fallback, else null. Used by draftManagerReview INSIDE its gather tx (decryption is CPU
 * only — the provider network call happens outside any tx). FAIL CLOSED: if an active tenant config
 * exists but cannot be decrypted, this throws rather than leaking through the shared env key.
 */
export async function resolveActiveAiConfig(tx: Tx, ctx: SessionContext, feature: AiFeatureId = 'hr_assistant'): Promise<ResolvedAiConfig | null> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  const snapshot=await resolveAiProviderSnapshotTx(tx,ctx);
  return snapshot?governedAiConfig(ctx,snapshot,feature):null;
}

/** Cheap check for gating the "Draft with AI" affordance — active tenant config OR an env key. */
export function isAiConfigured(ctx: SessionContext): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const [active] = await tx
      .select({ id: aiProviderConfig.id })
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.isActive, true))
      .limit(1);
    return active ? true : hasEnvFallback();
  });
}

// ─────────────────────────────── writes (admin) ───────────────────────────────

/**
 * Store a provider change. `apiKey` is encrypted (tenant AAD) at write time; omit it to change only the model
 * (the pending or stored key is kept — the UI shows it write-only). WP14: every change is stored PENDING and
 * never served; activation is a separate, baseline-gated step (setActiveProvider). `makeActive` is refused.
 */
export async function saveAiProviderConfig(
  ctx: SessionContext,
  p: { provider: string; model: string; apiKey?: string; makeActive?: boolean; providerOptions?: unknown },
): Promise<void> {
  p=structuredClone(p);
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if (!isProvider(p.provider)) throw new AiConfigError('Unknown AI provider.');
  const model = p.model?.trim();
  if (!model) throw new AiConfigError('A model is required.');
  providerModel(p.provider,model);
  const apiKey = p.apiKey?.trim() || undefined;

  await withTenant(ctx, async (tx) => {
    await assertConfigurationAdminTx(tx,ctx);
    const [existing] = await tx
      .select({ id: aiProviderConfig.id, providerOptions: aiProviderConfig.providerOptions })
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.provider, p.provider as AiProvider))
      .limit(1);

    if (p.provider === 'openrouter') {
      if (p.makeActive) throw new AiConfigError('Save the OpenRouter candidate first, evaluate it, then choose Use this provider.');
      const candidate = (await providerCandidatesTx(tx, ctx))[0];
      const providerOptions = routingOptions(p.providerOptions === undefined ? candidate?.providerOptions ?? existing?.providerOptions : p.providerOptions);
      const rowId = await saveOpenRouterCandidateTx(tx, ctx, { model, apiKey, providerOptions });
      await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'ai-provider-candidate', aggregateId: rowId,
        eventType: 'ai-provider-config.candidate-saved', actor: actorOf(ctx), payload: { provider: p.provider, model,
          routingVersion: 1, routingDigest: createHash('sha256').update(JSON.stringify(providerOptions)).digest('hex') } });
      return;
    }
    // WP14 (0694): a direct-provider change is stored PENDING. The live row and the gateway are untouched until
    // the baseline checks pass (or a failure is accepted) and an administrator activates the change.
    if (p.makeActive) throw new AiConfigError('Save the change, run the baseline checks, then activate it.');
    // 0661: an AI gateway stores exactly {version:1, baseUrl}; every other direct provider stores none.
    let providerOptions: Record<string, unknown> = {};
    if (p.provider === 'ai_gateway') {
      try { providerOptions = readGatewayOptions(p.providerOptions === undefined ? existing?.providerOptions : p.providerOptions); }
      catch { throw new AiConfigError('Enter the gateway\u2019s https address, for example https://router.flatkey.ai/v1. Internal addresses are not allowed.'); }
    } else if(p.providerOptions!==undefined&&JSON.stringify(p.providerOptions)!=='{}')throw new AiConfigError('Routing options are only supported for OpenRouter.');

    let cipherFields: { apiKeyCiphertext: string; keyLast4: string } | null = null;
    if (apiKey) {
      if (!isSecretStorable()) {
        throw new AiConfigError('Key storage is disabled — set AI_CONFIG_SECRET on the server to store keys.');
      }
      cipherFields = { apiKeyCiphertext: encryptSecret(apiKey, ctx.tenantId), keyLast4: keyLast4(apiKey) };
    }

    // Without a typed key the restricted owner keeps the pending key, else the stored key of this provider.
    let rowId: string;
    try {
      const [saved] = await tx.execute<{ id: string }>(sql`select app.ai_provider_pending_save_v1(${p.provider},${model},${cipherFields?.apiKeyCiphertext ?? null},
        ${cipherFields?.keyLast4 ?? null},${JSON.stringify(providerOptions)}::jsonb) as id`);
      if (!saved?.id) throw new Error('unsaved');
      rowId = saved.id;
    } catch { throw new AiConfigError(existing || apiKey ? 'The AI configuration change could not be saved.' : 'An API key is required to configure a new provider.'); }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ai-provider-pending',
      aggregateId: rowId,
      eventType: 'ai-provider-config.pending-saved',
      actor: actorOf(ctx),
      // Key/ciphertext/last4 are deliberately omitted from the (tenant-wide) event log.
      payload: { provider: p.provider, model, active: false },
    });
  });
}

const BASELINE_REQUIRED = 'A passed or accepted baseline check of this exact change is required before it can be activated.';
/** Activate a provider change. WP14: a direct provider activates only its PENDING change, and only once a baseline
 * run of that exact version has passed or had its failure accepted; OpenRouter additionally needs its existing
 * evaluated candidate receipt. Either way the gate, the switch and the live row commit together. */
export async function setActiveProvider(ctx: SessionContext, p: { provider: string; evaluationReceipt?: string; pendingVersion?: string }): Promise<void> {
  p=structuredClone(p);
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if (!isProvider(p.provider)) throw new AiConfigError('Unknown AI provider.');
  await withTenant(ctx, async (tx) => {
    await assertConfigurationAdminTx(tx,ctx);
    if (p.provider === 'openrouter') {
      const candidate = (await providerCandidatesTx(tx, ctx))[0];
      if (!candidate) throw new AiConfigError('A current evaluated OpenRouter candidate and account-policy review are required.');
      const [gate] = await tx.execute<{ id: string | null }>(sql`select app.ai_provider_baseline_gate_v1('openrouter_candidate',${candidate.id}::uuid,${candidate.version}::uuid,${PROVIDER_BASELINE_SUITE_DIGEST}) as id`);
      if (!gate?.id) throw new AiConfigError(BASELINE_REQUIRED);
      let promoted: { rowId: string; evaluationId: string };
      try { promoted = await activateOpenRouterCandidateTx(tx, ctx, p.evaluationReceipt); }
      catch { throw new AiConfigError('A current evaluated OpenRouter candidate and account-policy review are required.'); }
      // The promoted row remembers the run that admitted this exact version (0694 clears it on any later in-place change).
      await tx.update(aiProviderConfig).set({ baselineRunId: gate.id }).where(eq(aiProviderConfig.id, promoted.rowId));
      await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'ai-provider-config', aggregateId: promoted.rowId,
        eventType: 'ai-provider-config.activated', actor: actorOf(ctx), payload: { provider: p.provider, model: candidate.model, evaluationId: promoted.evaluationId,
          protocolSuiteVersion: 1, accountReviewVersion: 1, baselineRunId: gate.id } });
      return;
    }
    const [pending] = await tx.execute<{ id: string; version_token: string; model: string }>(sql`select id,version_token,model from app.ai_provider_pending_view_v1() where provider=${p.provider}`);
    if (!pending) throw new AiConfigError('Save the change, run the baseline checks, then activate it.');
    if (p.pendingVersion !== undefined && p.pendingVersion !== pending.version_token) throw new AiConfigError('This change was edited after you opened it. Review it again.');
    providerModel(p.provider as AiProvider,pending.model);
    let activated: { config_id: string; baseline_run_id: string } | undefined;
    try { [activated] = await tx.execute<{ config_id: string; baseline_run_id: string }>(sql`select config_id,baseline_run_id from app.ai_provider_pending_activate_v1(${pending.id}::uuid,${pending.version_token}::uuid,${PROVIDER_BASELINE_SUITE_DIGEST})`); }
    catch { throw new AiConfigError(BASELINE_REQUIRED); }
    if (!activated?.config_id) throw new AiConfigError(BASELINE_REQUIRED);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ai-provider-config',
      aggregateId: activated.config_id,
      eventType: 'ai-provider-config.activated',
      actor: actorOf(ctx),
      payload: { provider: p.provider, model: pending.model, baselineRunId: activated.baseline_run_id },
    });
  });
}

/** Turn AI drafting off for the tenant (deactivate all). Env fallback, if any, still applies. */
export async function disableAi(ctx: SessionContext): Promise<void> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  await withTenant(ctx, async (tx) => {
    await assertConfigurationAdminTx(tx,ctx);
    await tx.update(aiProviderConfig).set({ isActive: false }).where(eq(aiProviderConfig.isActive, true));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ai-provider-config',
      aggregateId: ctx.tenantId,
      eventType: 'ai-provider-config.disabled',
      actor: actorOf(ctx),
    });
  });
}

async function discardPendingTx(tx: Tx, ctx: SessionContext, provider: AiProvider): Promise<boolean> {
  let removed: { id: string | null } | undefined;
  try { [removed] = await tx.execute<{ id: string | null }>(sql`select app.ai_provider_pending_remove_v1(${provider}) as id`); }
  catch { throw new AiConfigError('The AI configuration change could not be discarded.'); }
  if (!removed?.id) return false;
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'ai-provider-pending', aggregateId: removed.id,
    eventType: 'ai-provider-config.pending-discarded', actor: actorOf(ctx), payload: { provider } });
  return true;
}

/** WP14: drop a direct provider's pending change. The live configuration is unchanged. */
export async function discardPendingAiProviderChange(ctx: SessionContext, p: { provider: string }): Promise<void> {
  p=structuredClone(p);
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if (!isProvider(p.provider) || p.provider === 'openrouter') throw new AiConfigError('Unknown AI provider.');
  await withTenant(ctx, async (tx) => {
    await assertConfigurationAdminTx(tx,ctx);
    if (!(await discardPendingTx(tx, ctx, p.provider as AiProvider))) throw new AiConfigError('There is no pending change for this provider.');
  });
}

/** Remove a provider's stored config + key entirely. */
export async function removeAiProviderConfig(ctx: SessionContext, p: { provider: string }): Promise<void> {
  p=structuredClone(p);
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if (!isProvider(p.provider)) throw new AiConfigError('Unknown AI provider.');
  await withTenant(ctx, async (tx) => {
    await assertConfigurationAdminTx(tx,ctx);
    if (p.provider === 'openrouter') {
      const candidateId = await removeOpenRouterCandidateTx(tx, ctx);
      if (candidateId) await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'ai-provider-candidate', aggregateId: candidateId,
        eventType: 'ai-provider-config.candidate-removed', actor: actorOf(ctx), payload: { provider: p.provider } });
    } else await discardPendingTx(tx, ctx, p.provider as AiProvider);
    const [row] = await tx
      .select({ id: aiProviderConfig.id })
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.provider, p.provider as AiProvider))
      .limit(1);
    if (!row) return;
    await tx.delete(aiProviderConfig).where(eq(aiProviderConfig.id, row.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ai-provider-config',
      aggregateId: row.id,
      eventType: 'ai-provider-config.removed',
      actor: actorOf(ctx),
      payload: { provider: p.provider },
    });
  });
}

/**
 * Admin "Test connection": validate a key+model with a cheap live probe. Tests the just-typed key if
 * given; otherwise tests the saved OpenRouter candidate, or another ACTIVE provider's key.
 * Metadata does not establish generation, tool behaviour or account privacy. Returns a GENERIC
 * reason — never raw provider text. No domain event (a read-shaped probe).
 */
export async function testConnection(
  ctx: SessionContext,
  p: { provider: string; model: string; apiKey?: string; providerOptions?: unknown },
): Promise<ValidateResult> {
  p=structuredClone(p);
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if (!isProvider(p.provider)) return { ok: false, error: 'Unknown AI provider.' };
  const model = p.model?.trim();
  if (!model) return { ok: false, error: 'A model is required.' };
  try{providerModel(p.provider,model);}catch{return {ok:false,error:'An explicit provider/model identifier is required.'};}
  const typed = p.apiKey?.trim() || undefined;

  const prepared:ResolvedAiConfig|ValidateResult=await withTenant(ctx, async (tx) => {
    await assertConfigurationAdminTx(tx,ctx);
    let cfg: ResolvedAiConfig;
    if (typed) {
      let gatewayBaseUrl: string | undefined;
      if (p.provider === 'ai_gateway') { try { gatewayBaseUrl = readGatewayOptions(p.providerOptions).baseUrl; } catch { return { ok: false, error: 'Enter a public https gateway address.' }; } }
      cfg = { provider: p.provider as AiProvider, model, apiKey: typed, ...(p.provider==='openrouter'?{providerOptions:routingOptions(p.providerOptions)}:{}), ...(gatewayBaseUrl?{gatewayBaseUrl}:{}) };
    } else {
      // Stored-key path: resolveActiveAiConfig fails closed (throws) if the ciphertext can't be
      // decrypted (e.g. AI_CONFIG_SECRET rotated). Keep the Test result a clean generic reason.
      let active: ResolvedAiConfig | null;
      try {
        active = p.provider === 'openrouter' && (await providerCandidatesTx(tx, ctx)).length
          ? (await resolveAiProviderCandidateSnapshotTx(tx, ctx, 'openrouter')).configuration
          : await resolveActiveAiConfig(tx, ctx);
      } catch {
        return { ok: false, error: 'Stored key cannot be read — re-enter the API key.' };
      }
      if (!active || active.provider !== p.provider) {
        return { ok: false, error: 'Enter the API key to test, or activate this provider first.' };
      }
      let gatewayBaseUrl = active.gatewayBaseUrl;
      if (active.provider === 'ai_gateway' && p.providerOptions !== undefined) { try { gatewayBaseUrl = readGatewayOptions(p.providerOptions).baseUrl; } catch { return { ok: false, error: 'Enter a public https gateway address.' }; } }
      cfg = { ...active, model, ...(active.provider==='openrouter'&&p.providerOptions!==undefined?{providerOptions:routingOptions(p.providerOptions)}:{}), ...(gatewayBaseUrl?{gatewayBaseUrl}:{}) };
    }
    return cfg;
  });
  if(!('provider' in prepared))return prepared;
  // Admission commits before transport. A crash retains a pending metadata-only probe record.
  const cfg=prepared;
  return validateConfig(createUngovernedProbe(cfg,async(request,call)=>{
    if(request.operation!=='probe')throw new AiConfigError('Connection check unavailable.');
    const id=await withTenant(ctx,async tx=>{
      await assertConfigurationAdminTx(tx,ctx);
      const [row]=await tx.execute<{id:string}>(sql`select app.ai_probe_start(${cfg.provider},${cfg.model}) as id`);
      if(!row?.id)throw new AiConfigError('Connection check could not be recorded.');return row.id;
    });
    let succeeded=false;
    try{const result=await call(()=>{},()=>{});succeeded=!!result&&typeof result==='object'&&'ok' in result&&result.ok===true;return result;}
    finally{await withTenant(ctx,tx=>tx.execute(sql`select app.ai_settle(${id}::uuid,${succeeded},null::bigint)`));}
  }));
}
