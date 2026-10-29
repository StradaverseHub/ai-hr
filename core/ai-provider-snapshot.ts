/** Server-only request authority. A sealed evaluation receipt may retain its fingerprint solely as
 * historical tested-configuration evidence; fresh issued snapshots remain mandatory for authority.
 * No plaintext persisted fingerprint/key or client capability. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { AiGatewayError, type ResolvedAiConfig } from '../lib/ai/types';
import { decryptSecret } from '../lib/ai/crypto';
import { envFallbackConfig, isProvider } from '../lib/ai/registry';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { readGatewayOptions } from '../lib/ai/providers/gateway-options';
import { OpenRouterTransportConfiguration } from '../lib/ai/providers/openrouter-transport';
import { assertAiPrincipalTx } from './ai-principal';
import { currentAiProviderAdminTx } from './ai-provider-authority';

const issued = new WeakSet<object>();
export const AI_PROVIDER_SNAPSHOT_MAX_AGE_MS = 300_000;
/** WP14: what a baseline holdout run evaluates — a pending direct-provider change, the saved OpenRouter
 * candidate, or the platform default (environment key and AI_DRAFT_MODEL) while the tenant uses it. */
export type AiProviderBaselineTarget = Readonly<{ kind: 'pending'; provider: 'anthropic' | 'openai' | 'google' | 'ai_gateway' } | { kind: 'openrouter_candidate' } | { kind: 'environment' }>;
export type AiProviderSnapshot = Readonly<{
  configuration: ResolvedAiConfig;
  purpose: 'active' | 'provider_evaluation';
  candidate?: Readonly<{ id: string; version: string }>;
  baseline?: AiProviderBaselineTarget;
  fingerprint: string;
  principal: string;
  preparedAt: number;
}>;
const refuse = (): never => { throw new AiGatewayError('The current AI configuration could not be confirmed.'); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: string, b: string) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const principal = (ctx: SessionContext) => digest([ctx.tenantId, ctx.userId, ctx.personId ?? null, ctx.roles ?? null, ctx.grants ?? null]);
const parameters = (cfg: ResolvedAiConfig) => digest([
  cfg.provider, cfg.model, cfg.apiKey,
  cfg.provider === 'openrouter' ? readOpenRouterOptions(cfg.providerOptions) : cfg.providerOptions ?? null,
  cfg.gatewayBaseUrl ?? null,
]);

/** Fresh actual login and v2 resolver checks precede decryption or environment fallback. Resolver
 * failure never falls through to an environment key. Origin/ciphertext/options changes invalidate
 * a prepared binding even when a fallback happens to use the same plaintext key and model.
 */
export async function resolveAiProviderSnapshotTx(tx: Tx, ctx: SessionContext): Promise<AiProviderSnapshot | null> {
  await assertAiPrincipalTx(tx, ctx);
  let rows: { provider: string; model: string; api_key_ciphertext: string; provider_options: unknown }[];
  try { rows = await tx.execute(sql`select provider, model, api_key_ciphertext, provider_options from app.ai_active_provider_config_v2()`) as unknown as typeof rows; }
  catch { return refuse(); }
  if (rows.length > 1) return refuse();
  const row = rows[0];
  let configuration: ResolvedAiConfig;
  let fingerprint: string;
  if (row) {
    if (!isProvider(row.provider) || typeof row.model !== 'string' || !row.model.trim() || row.model !== row.model.trim()) return refuse();
    let providerOptions: ResolvedAiConfig['providerOptions'];
    try {
      let gatewayBaseUrl: string | undefined;
      if (row.provider === 'openrouter') providerOptions = readOpenRouterOptions(row.provider_options);
      // 0661: the gateway's address is its only option; it is re-validated on read and before every call.
      else if (row.provider === 'ai_gateway') gatewayBaseUrl = readGatewayOptions(row.provider_options).baseUrl;
      else if (!row.provider_options || typeof row.provider_options !== 'object' || Array.isArray(row.provider_options) || Object.keys(row.provider_options).length) return refuse();
      const apiKey = decryptSecret(row.api_key_ciphertext, ctx.tenantId);
      if (row.provider === 'openrouter' && !OpenRouterTransportConfiguration.safeParse({ model: row.model, apiKey, routing: providerOptions!.routing }).success) return refuse();
      configuration = Object.freeze({ provider: row.provider, model: row.model, apiKey, ...(providerOptions ? { providerOptions } : {}), ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}) });
      fingerprint = digest(['stored-v1', ctx.tenantId, row.provider, row.model, row.api_key_ciphertext, providerOptions ?? gatewayBaseUrl ?? {}]);
    } catch { return refuse(); }
  } else {
    const fallback = envFallbackConfig();
    if (!fallback) return null;
    configuration = Object.freeze({ ...fallback });
    fingerprint = digest(['environment-v1', ctx.tenantId, parameters(configuration)]);
  }
  const snapshot = Object.freeze({ configuration, purpose: 'active' as const, fingerprint, principal: principal(ctx), preparedAt: Date.now() });
  issued.add(snapshot);
  return snapshot;
}

/** Explicit candidate preparation is group-admin-only even if the selected provider is already active.
 * The restricted resolver exposes no key to ordinary SELECT and never changes provider activation.
 */
export async function resolveAiProviderCandidateSnapshotTx(tx: Tx, ctx: SessionContext, provider: 'openrouter'): Promise<AiProviderSnapshot> {
  if (!(await currentAiProviderAdminTx(tx, ctx))) return refuse();
  let rows: { id: string; version_token: string; provider: string; model: string; api_key_ciphertext: string; provider_options: unknown }[];
  try {
    rows = await tx.execute(sql`select id, version_token, provider, model, api_key_ciphertext, provider_options from app.ai_provider_evaluation_candidate_v1(${provider})`) as unknown as typeof rows;
  } catch { return refuse(); }
  if (rows.length !== 1 || rows[0].provider !== provider) return refuse();
  const row = rows[0];
  let configuration: ResolvedAiConfig, fingerprint: string;
  try {
    const providerOptions = readOpenRouterOptions(row.provider_options), apiKey = decryptSecret(row.api_key_ciphertext, ctx.tenantId);
    if (!OpenRouterTransportConfiguration.safeParse({ model: row.model, apiKey, routing: providerOptions.routing }).success) return refuse();
    configuration = Object.freeze({ provider, model: row.model, apiKey, providerOptions });
    fingerprint = digest(['candidate-v1', ctx.tenantId, row.id, row.version_token, row.provider, row.model, row.api_key_ciphertext, providerOptions]);
  } catch { return refuse(); }
  const snapshot = Object.freeze({ configuration, purpose: 'provider_evaluation' as const, candidate: Object.freeze({ id: row.id, version: row.version_token }), fingerprint, principal: principal(ctx), preparedAt: Date.now() });
  issued.add(snapshot);
  return snapshot;
}

/** WP14: a provider_evaluation snapshot of a baseline target. Group-admin only, like candidate custody. A pending
 * change is read only through its restricted resolver and never becomes the active configuration here. The
 * environment target exists only while the tenant has no active configuration of its own. */
export async function resolveAiProviderBaselineSnapshotTx(tx: Tx, ctx: SessionContext, target: AiProviderBaselineTarget): Promise<AiProviderSnapshot> {
  if (!target || typeof target !== 'object') return refuse();
  if (target.kind === 'openrouter_candidate') return resolveAiProviderCandidateSnapshotTx(tx, ctx, 'openrouter');
  if (!(await currentAiProviderAdminTx(tx, ctx))) return refuse();
  let configuration: ResolvedAiConfig, fingerprint: string, candidate: Readonly<{ id: string; version: string }> | undefined;
  if (target.kind === 'pending') {
    if (!['anthropic', 'openai', 'google', 'ai_gateway'].includes(target.provider)) return refuse();
    let rows: { id: string; version_token: string; provider: string; model: string; api_key_ciphertext: string; provider_options: unknown }[];
    try { rows = await tx.execute(sql`select id, version_token, provider, model, api_key_ciphertext, provider_options from app.ai_provider_pending_resolve_v1(${target.provider})`) as unknown as typeof rows; }
    catch { return refuse(); }
    if (rows.length !== 1 || rows[0].provider !== target.provider) return refuse();
    const row = rows[0];
    if (typeof row.model !== 'string' || !row.model.trim() || row.model !== row.model.trim()) return refuse();
    try {
      let gatewayBaseUrl: string | undefined;
      if (row.provider === 'ai_gateway') gatewayBaseUrl = readGatewayOptions(row.provider_options).baseUrl;
      else if (!row.provider_options || typeof row.provider_options !== 'object' || Array.isArray(row.provider_options) || Object.keys(row.provider_options).length) return refuse();
      const apiKey = decryptSecret(row.api_key_ciphertext, ctx.tenantId);
      configuration = Object.freeze({ provider: target.provider, model: row.model, apiKey, ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}) });
      fingerprint = digest(['pending-v1', ctx.tenantId, row.id, row.version_token, row.provider, row.model, row.api_key_ciphertext, gatewayBaseUrl ?? {}]);
      candidate = Object.freeze({ id: row.id, version: row.version_token });
    } catch { return refuse(); }
  } else if (target.kind === 'environment') {
    let active: { active: boolean }[];
    try { active = await tx.execute(sql`select exists(select 1 from public.ai_provider_config where is_active) as active`) as unknown as typeof active; }
    catch { return refuse(); }
    if (active[0]?.active !== false) return refuse();
    const fallback = envFallbackConfig();
    if (!fallback) return refuse();
    configuration = Object.freeze({ ...fallback });
    fingerprint = digest(['environment-baseline-v1', ctx.tenantId, parameters(configuration)]);
  } else return refuse();
  const snapshot = Object.freeze({ configuration, purpose: 'provider_evaluation' as const, ...(candidate ? { candidate } : {}),
    baseline: Object.freeze({ ...target }) as AiProviderBaselineTarget, fingerprint, principal: principal(ctx), preparedAt: Date.now() });
  issued.add(snapshot);
  return snapshot;
}

/** A candidate snapshot cannot be repurposed for HR generation; evaluation cannot use an ordinary
 * active/environment snapshot as a substitute for the explicitly reviewed stored candidate.
 */
export function assertAiProviderSnapshotFeature(snapshot: AiProviderSnapshot, feature: string): void {
  if (!issued.has(snapshot) || (snapshot.purpose === 'provider_evaluation') !== (feature === 'provider_evaluation')) return refuse();
}

/** A structural lookalike, serialized copy, changed principal or expired request is not a snapshot. */
export function assertAiProviderSnapshot(snapshot: AiProviderSnapshot, ctx: SessionContext): void {
  if (!snapshot || !issued.has(snapshot)) return refuse();
  const age = Date.now() - snapshot.preparedAt;
  if (!Number.isFinite(age) || age < 0 || age > AI_PROVIDER_SNAPSHOT_MAX_AGE_MS || !same(snapshot.principal, principal(ctx))) return refuse();
}

/** Runs inside the actual admission transaction under fresh Access ownership. The gateway also
 * passes its actual outgoing config so copying a governance object onto a retargeted key/model/route
 * does not validate only the original closure. This is not source-field/disclosure authorization.
 */
export async function assertCurrentAiProviderSnapshotTx(tx: Tx, ctx: SessionContext, prepared: AiProviderSnapshot, outgoing: ResolvedAiConfig): Promise<void> {
  assertAiProviderSnapshot(prepared, ctx);
  if (!Object.isFrozen(outgoing)) return refuse();
  try { if (!same(parameters(prepared.configuration), parameters(outgoing))) return refuse(); }
  catch { return refuse(); }
  const current = prepared.purpose === 'provider_evaluation'
    ? prepared.baseline ? await resolveAiProviderBaselineSnapshotTx(tx, ctx, prepared.baseline) : await resolveAiProviderCandidateSnapshotTx(tx, ctx, 'openrouter')
    : await resolveAiProviderSnapshotTx(tx, ctx);
  // Access ownership may have waited. Recheck request lifetime after that wait, too.
  assertAiProviderSnapshot(prepared, ctx);
  if (!current || !same(prepared.fingerprint, current.fingerprint)) return refuse();
}
