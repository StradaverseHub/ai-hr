/** Explicit admin-controlled candidate evaluation. No HR fields, arbitrary prompts, endpoints or tools. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { encryptSecret, isSecretStorable, keyLast4 } from '../lib/ai/crypto';
import { readOpenRouterOptions, type OpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { OpenRouterModel, OpenRouterTransportConfiguration } from '../lib/ai/providers/openrouter-transport';
import { assertProviderProtocolEvaluation, runProviderProtocolEvaluation, type ProviderProtocolSummary } from '../lib/ai/provider-protocol';
import { openProviderEvaluationReceipt, sealProviderEvaluationReceipt } from '../lib/ai/provider-evaluation-receipt';
import { currentAiProviderAdminTx } from './ai-provider-authority';
import { bindStrictAiSpendRoot, governedAiConfig } from './ai-governance';
import { resolveAiProviderCandidateSnapshotTx } from './ai-provider-snapshot';

export class AiProviderReadinessError extends Error {
  constructor(readonly code: 'consent_required' | 'candidate_required' | 'probe_failed' | 'receipt_required' | 'unavailable') {
    super('The AI provider evaluation could not be confirmed.'); this.name = 'AiProviderReadinessError';
  }
}
const unavailable = (): never => { throw new AiProviderReadinessError('unavailable'); };
const captured = (ctx: SessionContext) => ({ ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) });
async function authority(tx: Tx, ctx: SessionContext) { if (!(await currentAiProviderAdminTx(tx, ctx))) return unavailable(); }
export type AiProviderCandidateView = Readonly<{ id: string; version: string; provider: 'openrouter'; model: string; keyLast4: string; providerOptions: OpenRouterOptions; updatedAt: string }>;
export async function providerCandidatesTx(tx: Tx, ctx: SessionContext): Promise<AiProviderCandidateView[]> {
  await authority(tx, ctx);
  try {
    const rows = await tx.execute<{ id: string; version_token: string; provider: string; model: string; key_last4: string; provider_options: unknown; updated_at: Date }>(sql`select * from app.ai_provider_candidate_view_v1()`);
    return rows.map(row => {
      if (row.provider !== 'openrouter' || !OpenRouterModel.safeParse(row.model).success) return unavailable();
      return Object.freeze({ id: row.id, version: row.version_token, provider: 'openrouter' as const, model: row.model, keyLast4: row.key_last4,
        providerOptions: readOpenRouterOptions(row.provider_options), updatedAt: new Date(row.updated_at).toISOString() });
    });
  } catch { return unavailable(); }
}

/** Save only a candidate; an existing live provider/key stays unchanged until explicit promotion. */
export async function saveOpenRouterCandidateTx(tx: Tx, ctx: SessionContext,
  p: { model: string; apiKey?: string; providerOptions: OpenRouterOptions }): Promise<string> {
  ctx = captured(ctx);
  const options = readOpenRouterOptions(p.providerOptions), model = p.model, apiKey = p.apiKey;
  await authority(tx, ctx);
  if (!OpenRouterModel.safeParse(model).success || apiKey && !OpenRouterTransportConfiguration.safeParse({ model, apiKey, routing: options.routing }).success) return unavailable();
  let ciphertext: string | null = null, last4: string | null = null;
  if (apiKey) {
    if (!isSecretStorable()) return unavailable();
    ciphertext = encryptSecret(apiKey, ctx.tenantId); last4 = keyLast4(apiKey);
  }
  try {
    const [row] = await tx.execute<{ id: string }>(sql`select app.ai_provider_candidate_save_v1(${model},${ciphertext},${last4},${JSON.stringify(options)}::jsonb) as id`);
    if (!row?.id) return unavailable(); return row.id;
  } catch { return unavailable(); }
}

const Consent = z.object({ provider: z.literal('openrouter'), candidateId: z.string().uuid(), candidateVersion: z.string().uuid(), review: z.object({ version: z.literal(1),
  accountDefaultsReviewed: z.literal(true), externalProcessingReviewed: z.literal(true) }).strict(), syntheticProbeConsent: z.literal(true) }).strict();
export type ProviderEvaluationConsent = z.infer<typeof Consent>;
export type ProviderEvaluationResult = Readonly<{ receipt: string; expiresAt: string; candidateId: string; candidateVersion: string; summary: ProviderProtocolSummary }>;

/** User explicitly consents to three billed synthetic requests. This owner supplies ALL prompt/tool
 * bytes and uses a candidate-purpose snapshot through canonical admission/allowance/settlement.
 * Account settings are human-attested; these probes do not prove provider privacy or all task quality.
 */
export async function evaluateProviderCandidate(ctx: SessionContext, input: ProviderEvaluationConsent): Promise<ProviderEvaluationResult> {
  ctx = captured(ctx);
  const consent = Consent.safeParse(input);
  if (!consent.success) throw new AiProviderReadinessError('consent_required');
  const snapshot = await withTenant(ctx, async tx => {
    await authority(tx, ctx);
    if (!isSecretStorable()) return unavailable();
    const candidate = await resolveAiProviderCandidateSnapshotTx(tx, ctx, consent.data.provider);
    const binding = candidate.candidate;
    if (!binding || binding.id !== consent.data.candidateId || binding.version !== consent.data.candidateVersion)
      throw new AiProviderReadinessError('candidate_required');
    return candidate;
  });
  // The validated, persisted candidate owns one lifetime allocation across all three probes,
  // reviewers and retries. A new attempt/receipt must never mint another spend allowance.
  if (!snapshot.candidate) return unavailable();
  const cfg = bindStrictAiSpendRoot(governedAiConfig(ctx, snapshot, 'provider_evaluation'),
    { rootTaskId: snapshot.candidate.id, kind: 'evaluation' });
  let summary: ProviderProtocolSummary;
  try { summary = await runProviderProtocolEvaluation(cfg); assertProviderProtocolEvaluation(summary, cfg); }
  catch { throw new AiProviderReadinessError('probe_failed'); }
  return withTenant(ctx, async tx => {
    await authority(tx, ctx);
    const current = await resolveAiProviderCandidateSnapshotTx(tx, ctx, 'openrouter');
    if (!current.candidate || current.fingerprint !== snapshot.fingerprint || current.principal !== snapshot.principal) return unavailable();
    const evaluationId = randomUUID();
    try {
      const [row] = await tx.execute<{ issued_at: Date; expires_at: Date }>(sql`select * from app.ai_provider_evaluation_record_v1(${evaluationId}::uuid,
        ${current.candidate.id}::uuid,${current.candidate.version}::uuid,${current.fingerprint},${current.principal},${JSON.stringify(summary)}::jsonb)`);
      if (!row || !ctx.userId) return unavailable();
      const expiresAt = new Date(row.expires_at).toISOString();
      const receipt = sealProviderEvaluationReceipt({ tenantId: ctx.tenantId, userId: ctx.userId }, {
        version: 1, evaluationId, candidateId: current.candidate.id, candidateVersion: current.candidate.version,
        candidateFingerprint: current.fingerprint, principalFingerprint: current.principal, suiteVersion: 1, accountReviewVersion: 1,
        issuedAt: new Date(row.issued_at).toISOString(), expiresAt,
      });
      await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'ai-provider-evaluation', aggregateId: evaluationId,
        eventType: 'ai-provider-evaluation.protocol-verified', actor: actorOf(ctx),
        payload: { provider: 'openrouter', model: cfg.model, suiteVersion: 1, accountReviewVersion: 1, summary } });
      return Object.freeze({ receipt, expiresAt, candidateId: current.candidate.id, candidateVersion: current.candidate.version, summary });
    } catch { return unavailable(); }
  });
}

/** Consume exactly one current receipt and promote in one transaction. Any failure rolls it all back. */
export async function activateOpenRouterCandidateTx(tx: Tx, ctx: SessionContext, receipt: unknown): Promise<{ rowId: string; evaluationId: string }> {
  await authority(tx, ctx);
  if (!ctx.userId) return unavailable();
  const proof = openProviderEvaluationReceipt({ tenantId: ctx.tenantId, userId: ctx.userId }, receipt);
  if (!proof) throw new AiProviderReadinessError('receipt_required');
  const current = await resolveAiProviderCandidateSnapshotTx(tx, ctx, 'openrouter');
  if (!current.candidate || proof.candidateId !== current.candidate.id || proof.candidateVersion !== current.candidate.version ||
      proof.candidateFingerprint !== current.fingerprint || proof.principalFingerprint !== current.principal) throw new AiProviderReadinessError('receipt_required');
  try {
    const [consumed] = await tx.execute<{ id: string }>(sql`select app.ai_provider_evaluation_consume_v1(${proof.evaluationId}::uuid,${current.fingerprint},${current.principal}) as id`);
    if (consumed?.id !== proof.evaluationId) return unavailable();
    const [promoted] = await tx.execute<{ id: string }>(sql`select app.ai_provider_candidate_promote_v1(${proof.evaluationId}::uuid) as id`);
    if (!promoted?.id) return unavailable();
    return { rowId: promoted.id, evaluationId: proof.evaluationId };
  } catch { return unavailable(); }
}
export async function removeOpenRouterCandidateTx(tx: Tx, ctx: SessionContext): Promise<string | null> {
  await authority(tx, ctx);
  try { const [row] = await tx.execute<{ id: string | null }>(sql`select app.ai_provider_candidate_remove_v1() as id`); return row?.id ?? null; }
  catch { return unavailable(); }
}
