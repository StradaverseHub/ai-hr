/** WP14 test fixtures ONLY. A provider or model change is pending until a baseline run of its exact version has
 * passed or been accepted. These fixtures record a run through the real restricted SQL owner and accept it through
 * the real service (no provider call), so a test that only needs an ACTIVE configuration still goes through the
 * production gate rather than writing ai_provider_config directly. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { saveAiProviderConfig, setActiveProvider } from '../core/ai-config';
import { acceptProviderBaselineFailure } from '../core/ai-provider-baseline';
import { PROVIDER_BASELINE_SUITE_DIGEST, initialProviderBaselineProgress } from '../lib/ai/provider-baseline-suites';

const FIXTURE_FINGERPRINT = 'f'.repeat(64);
const FIXTURE_REASON = 'Fixture-only acceptance: this test makes no provider call.';

/** Starts an (unfinished) baseline run for the current target version and returns its id. */
export async function startBaselineRunFixture(ctx: SessionContext, target: { kind: 'pending'; provider: string } | { kind: 'openrouter_candidate' }): Promise<string> {
  return withTenant(ctx, async tx => {
    const [row] = target.kind === 'pending'
      ? await tx.execute<{ id: string; version_token: string; provider: string; model: string }>(sql`select id,version_token,provider,model from app.ai_provider_pending_view_v1() where provider=${target.provider}`)
      : await tx.execute<{ id: string; version_token: string; provider: string; model: string }>(sql`select id,version_token,provider,model from app.ai_provider_candidate_view_v1()`);
    if (!row) throw Error('Missing fixture target');
    const [run] = await tx.execute<{ id: string }>(sql`select app.ai_provider_baseline_start_v1(${target.kind},${row.id}::uuid,${row.version_token}::uuid,${row.provider},${row.model},
      ${FIXTURE_FINGERPRINT},${PROVIDER_BASELINE_SUITE_DIGEST},${JSON.stringify(initialProviderBaselineProgress())}::jsonb) as id`);
    return run.id;
  });
}
/** An accepted baseline for the current pending change of `provider`, or the saved OpenRouter candidate. */
export async function acceptBaselineFixture(ctx: SessionContext, target: { kind: 'pending'; provider: string } | { kind: 'openrouter_candidate' }): Promise<string> {
  const runId = await startBaselineRunFixture(ctx, target);
  await acceptProviderBaselineFailure(ctx, { runId, reason: FIXTURE_REASON });
  return runId;
}
/** Saves a direct-provider change, accepts its baseline and activates it through the gated owner. */
export async function activateDirectProviderFixture(ctx: SessionContext, p: { provider: 'anthropic' | 'openai' | 'google' | 'ai_gateway'; model: string; apiKey?: string; providerOptions?: unknown }): Promise<void> {
  await saveAiProviderConfig(ctx, p);
  await acceptBaselineFixture(ctx, { kind: 'pending', provider: p.provider });
  await setActiveProvider(ctx, { provider: p.provider });
}
