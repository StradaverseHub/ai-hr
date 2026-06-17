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
 *  - Domain events carry {provider, model} only — never the key, ciphertext, or test result.
 *  - Fail closed: a present-but-undecryptable active config errors; it does NOT silently fall through
 *    to the shared platform env key.
 */
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
import { decryptSecret, encryptSecret, keyLast4 } from '../lib/ai/crypto';

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
  return withTenant(ctx, async (tx) => {
    assertAdmin(ctx);
    // Explicit column list — the ciphertext is not even granted to the app role, but be unambiguous.
    const rows = await tx
      .select({
        provider: aiProviderConfig.provider,
        model: aiProviderConfig.model,
        keyLast4: aiProviderConfig.keyLast4,
        isActive: aiProviderConfig.isActive,
      })
      .from(aiProviderConfig);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const providers: AiProviderView[] = PROVIDERS.map((p) => {
      const meta = PROVIDER_META[p];
      const row = byProvider.get(p);
      return {
        provider: p,
        label: meta.label,
        models: meta.models,
        defaultModel: meta.defaultModel,
        configured: Boolean(row),
        model: row?.model ?? meta.defaultModel,
        keyLast4: row?.keyLast4 ?? null,
        isActive: row?.isActive ?? false,
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
export async function resolveActiveAiConfig(tx: Tx, ctx: SessionContext): Promise<ResolvedAiConfig | null> {
  const rows = (await tx.execute(
    sql`select provider, model, api_key_ciphertext from app.ai_active_provider_config()`,
  )) as unknown as { provider: string; model: string; api_key_ciphertext: string }[];
  const row = rows[0];
  if (row) {
    if (!isProvider(row.provider)) throw new AiConfigError('Stored AI provider is unknown.');
    const apiKey = decryptSecret(row.api_key_ciphertext, ctx.tenantId); // throws on failure → fail closed
    return { provider: row.provider, model: row.model, apiKey };
  }
  return envFallbackConfig();
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

/** Deactivate every config for the tenant, then activate `provider`. One tx → the one-active partial
 *  unique index is never violated. Caller must have verified the provider row exists. */
async function activateTx(tx: Tx, provider: AiProvider) {
  await tx.update(aiProviderConfig).set({ isActive: false }).where(eq(aiProviderConfig.isActive, true));
  await tx.update(aiProviderConfig).set({ isActive: true, updatedAt: sql`now()` }).where(eq(aiProviderConfig.provider, provider));
}

/**
 * Store/update a provider config. `apiKey` is encrypted (tenant AAD) at write time; omit it to change
 * only the model on an existing provider (the stored key is kept — the UI shows it write-only).
 * `makeActive` activates this provider in the same tx.
 */
export async function saveAiProviderConfig(
  ctx: SessionContext,
  p: { provider: string; model: string; apiKey?: string; makeActive?: boolean },
): Promise<void> {
  if (!isProvider(p.provider)) throw new AiConfigError('Unknown AI provider.');
  const model = p.model?.trim();
  if (!model) throw new AiConfigError('A model is required.');
  const apiKey = p.apiKey?.trim() || undefined;

  await withTenant(ctx, async (tx) => {
    assertAdmin(ctx);
    const [existing] = await tx
      .select({ id: aiProviderConfig.id })
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.provider, p.provider as AiProvider))
      .limit(1);

    let cipherFields: { apiKeyCiphertext: string; keyLast4: string } | null = null;
    if (apiKey) {
      if (!isSecretStorable()) {
        throw new AiConfigError('Key storage is disabled — set AI_CONFIG_SECRET on the server to store keys.');
      }
      cipherFields = { apiKeyCiphertext: encryptSecret(apiKey, ctx.tenantId), keyLast4: keyLast4(apiKey) };
    } else if (!existing) {
      throw new AiConfigError('An API key is required to configure a new provider.');
    }

    let rowId: string;
    if (existing) {
      await tx
        .update(aiProviderConfig)
        .set({ model, ...(cipherFields ?? {}), updatedByUserId: ctx.userId ?? null, updatedAt: sql`now()` })
        .where(eq(aiProviderConfig.id, existing.id));
      rowId = existing.id;
    } else {
      const [ins] = await tx
        .insert(aiProviderConfig)
        .values({
          tenantId: ctx.tenantId,
          provider: p.provider as AiProvider,
          model,
          apiKeyCiphertext: cipherFields!.apiKeyCiphertext,
          keyLast4: cipherFields!.keyLast4,
          createdByUserId: ctx.userId ?? null,
        })
        .returning({ id: aiProviderConfig.id });
      rowId = ins.id;
    }

    if (p.makeActive) await activateTx(tx, p.provider as AiProvider);

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ai-provider-config',
      aggregateId: rowId,
      eventType: 'ai-provider-config.saved',
      actor: actorOf(ctx),
      // Key/ciphertext/last4 are deliberately omitted from the (tenant-wide) event log.
      payload: { provider: p.provider, model, active: Boolean(p.makeActive) },
    });
  });
}

/** Make an already-configured provider the active one. */
export async function setActiveProvider(ctx: SessionContext, p: { provider: string }): Promise<void> {
  if (!isProvider(p.provider)) throw new AiConfigError('Unknown AI provider.');
  await withTenant(ctx, async (tx) => {
    assertAdmin(ctx);
    const [row] = await tx
      .select({ id: aiProviderConfig.id })
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.provider, p.provider as AiProvider))
      .limit(1);
    if (!row) throw new AiConfigError('Configure this provider with a key before activating it.');
    await activateTx(tx, p.provider as AiProvider);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ai-provider-config',
      aggregateId: row.id,
      eventType: 'ai-provider-config.activated',
      actor: actorOf(ctx),
      payload: { provider: p.provider },
    });
  });
}

/** Turn AI drafting off for the tenant (deactivate all). Env fallback, if any, still applies. */
export async function disableAi(ctx: SessionContext): Promise<void> {
  await withTenant(ctx, async (tx) => {
    assertAdmin(ctx);
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

/** Remove a provider's stored config + key entirely. */
export async function removeAiProviderConfig(ctx: SessionContext, p: { provider: string }): Promise<void> {
  if (!isProvider(p.provider)) throw new AiConfigError('Unknown AI provider.');
  await withTenant(ctx, async (tx) => {
    assertAdmin(ctx);
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
 * given; otherwise tests the ACTIVE provider's stored key (a write-only stored key for an INACTIVE
 * provider can't be re-read, so re-enter it or activate first). Returns only ok/false + a GENERIC
 * reason — never raw provider text. No domain event (a read-shaped probe).
 */
export async function testConnection(
  ctx: SessionContext,
  p: { provider: string; model: string; apiKey?: string },
): Promise<ValidateResult> {
  if (!isProvider(p.provider)) return { ok: false, error: 'Unknown AI provider.' };
  const model = p.model?.trim();
  if (!model) return { ok: false, error: 'A model is required.' };
  const typed = p.apiKey?.trim() || undefined;

  return withTenant(ctx, async (tx) => {
    assertAdmin(ctx);
    let cfg: ResolvedAiConfig;
    if (typed) {
      cfg = { provider: p.provider as AiProvider, model, apiKey: typed };
    } else {
      // Stored-key path: resolveActiveAiConfig fails closed (throws) if the ciphertext can't be
      // decrypted (e.g. AI_CONFIG_SECRET rotated). Keep the Test result a clean generic reason.
      let active: ResolvedAiConfig | null;
      try {
        active = await resolveActiveAiConfig(tx, ctx);
      } catch {
        return { ok: false, error: 'Stored key cannot be read — re-enter the API key.' };
      }
      if (!active || active.provider !== p.provider) {
        return { ok: false, error: 'Enter the API key to test, or activate this provider first.' };
      }
      cfg = { provider: active.provider, model, apiKey: active.apiKey };
    }
    return validateConfig(cfg);
  });
}
