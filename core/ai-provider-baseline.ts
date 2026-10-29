/** WP14 / R19 — a provider or model change is a release.
 *
 * A direct-provider change is stored PENDING (app.ai_provider_pending_config, 0694); the OpenRouter candidate is
 * already pending by construction. A current group administrator runs the fixed baseline holdout suites against
 * the pending configuration from AI management. The spend is that administrator's own, under feature
 * provider_evaluation and that administrator's ordinary allowances, rooted on the run row; the scheduled agent
 * principal never runs these (owner decision 2). Activation is refused until a run of the exact current version
 * has passed, or a group administrator has accepted a failure with a recorded reason (audited as ai-control.*).
 * The active configuration keeps serving throughout. The platform default (environment key and AI_DRAFT_MODEL)
 * is fingerprinted by provider and model, so a changed platform model shows as not re-evaluated until a run of
 * that model passes or is accepted.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { generateDraft } from '../lib/ai';
import { envFallbackConfig, PROVIDER_META, isProvider } from '../lib/ai/registry';
import {
  PROVIDER_BASELINE_REQUEST_LIMIT, PROVIDER_BASELINE_SUITE_DIGEST, PROVIDER_BASELINE_SUITE_IDS, PROVIDER_BASELINE_SUITES, PROVIDER_BASELINE_SYSTEM,
  captureProviderBaselineProgress, initialProviderBaselineProgress, providerBaselineCasePassed,
  type ProviderBaselineProgress, type ProviderBaselineSuiteId,
} from '../lib/ai/provider-baseline-suites';
import { currentAiProviderAdminTx } from './ai-provider-authority';
import { resolveAiProviderBaselineSnapshotTx, type AiProviderBaselineTarget, type AiProviderSnapshot } from './ai-provider-snapshot';
import { bindStrictAiSpendRoot, governedAiConfig } from './ai-governance';
import { providerCandidatesTx } from './ai-provider-readiness';

export class AiProviderBaselineError extends Error {
  constructor(readonly code: 'not_admin' | 'stale' | 'consent_required' | 'reason_required' | 'unavailable') {
    super('The AI baseline check could not be confirmed.'); this.name = 'AiProviderBaselineError';
  }
}
const captured = (ctx: SessionContext) => ({ ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DIRECT_PROVIDERS = Object.freeze(['anthropic', 'openai', 'google', 'ai_gateway'] as const);
export type DirectProvider = typeof DIRECT_PROVIDERS[number];
export const isDirectProvider = (value: unknown): value is DirectProvider => typeof value === 'string' && (DIRECT_PROVIDERS as readonly string[]).includes(value);

/** The platform default is identified by provider and model only: rotating the platform key is not a model change. */
export function environmentModelFingerprint(provider: string, model: string): string {
  return createHash('sha256').update(JSON.stringify(['environment-model-v1', provider, model])).digest('hex');
}
async function adminTx(tx: Tx, ctx: SessionContext) { if (!(await currentAiProviderAdminTx(tx, ctx))) throw new AiProviderBaselineError('not_admin'); }

export type BaselineStatus = 'pending' | 'evaluating' | 'passed' | 'failed' | 'accepted';
export type BaselineSuiteView = Readonly<{ id: ProviderBaselineSuiteId; total: number; passed: number; failed: number; next: number; state: 'evaluating' | 'passed' | 'failed' }>;
export type BaselineRunView = Readonly<{ id: string; state: Exclude<BaselineStatus, 'pending'>; suites: readonly BaselineSuiteView[]; acceptedReason: string | null; acceptedAt: string | null; updatedAt: string; ownRun: boolean }>;
export type BaselineTargetView = Readonly<{
  key: string; kind: AiProviderBaselineTarget['kind']; provider: string; label: string; model: string;
  targetId: string | null; targetVersion: string | null; keyLast4: string | null; status: BaselineStatus; run: BaselineRunView | null;
  /** True when a passed or accepted run of this exact version admits activation. */
  activatable: boolean;
}>;
export type AiProviderChangeView = Readonly<{
  targets: readonly BaselineTargetView[];
  /** Present only while the tenant runs on the platform default. */
  platform: Readonly<{ provider: string; label: string; model: string; fingerprint: string; evaluated: boolean }> | null;
  /** The tenant's own active configuration. `evaluated` is false when no passed or accepted run admitted its exact
   * current version (every configuration activated before 0694, or one changed in place since). It keeps serving. */
  active: Readonly<{ provider: string; label: string; model: string; evaluated: boolean }> | null;
}>;
type RunRow = { id: string; target_kind: string; target_id: string | null; target_version: string | null; config_fingerprint: string; suite_digest: string;
  state: string; suites: unknown; started_by_user_id: string; updated_at: Date | string; accepted_reason: string | null; accepted_at: Date | string | null };
const iso = (value: Date | string | null) => value == null ? null : new Date(value).toISOString();

function runView(row: RunRow, userId: string | undefined): BaselineRunView | null {
  let progress: ProviderBaselineProgress;
  try { progress = captureProviderBaselineProgress(row.suites); } catch { return null; }
  if (!['evaluating', 'passed', 'failed', 'accepted'].includes(row.state)) return null;
  return Object.freeze({
    id: row.id, state: row.state as BaselineRunView['state'],
    suites: Object.freeze(PROVIDER_BASELINE_SUITE_IDS.map(id => { const c = progress[id]; return Object.freeze({ id, ...c, state: c.failed > 0 ? 'failed' as const : c.next >= c.total ? 'passed' as const : 'evaluating' as const }); })),
    acceptedReason: row.accepted_reason, acceptedAt: iso(row.accepted_at), updatedAt: iso(row.updated_at)!, ownRun: row.started_by_user_id === userId,
  });
}
/** A passed or accepted run of the current suites decides; otherwise the latest run of the current suites. */
function bestRun(rows: readonly RunRow[], userId: string | undefined): BaselineRunView | null {
  const current = rows.filter(row => row.suite_digest === PROVIDER_BASELINE_SUITE_DIGEST);
  const decided = current.find(row => row.state === 'passed' || row.state === 'accepted');
  const chosen = decided ?? current[0];
  return chosen ? runView(chosen, userId) : null;
}

/** Group-admin only. Nothing secret: key suffixes, models and run counts. */
export function getAiProviderChangeView(ctx: SessionContext): Promise<AiProviderChangeView> {
  ctx = captured(ctx);
  return withTenant(ctx, async tx => {
    await adminTx(tx, ctx);
    const pending = await tx.execute<{ id: string; version_token: string; provider: string; model: string; key_last4: string }>(sql`select id,version_token,provider,model,key_last4 from app.ai_provider_pending_view_v1()`);
    const candidates = await providerCandidatesTx(tx, ctx);
    const [current] = await tx.execute<{ provider: string; model: string; evaluated: boolean }>(sql`select c.provider::text as provider,c.model,
      exists(select 1 from public.ai_provider_baseline_run r where r.id=c.baseline_run_id and r.tenant_id=c.tenant_id and r.state in ('passed','accepted')
       and r.provider=c.provider::text and r.model=c.model) as evaluated
      from public.ai_provider_config c where c.tenant_id=${ctx.tenantId}::uuid and c.is_active limit 1`);
    const env = current ? null : envFallbackConfig();
    const rows = Array.from(await tx.execute<RunRow>(sql`select id,target_kind,target_id,target_version,config_fingerprint,suite_digest,state,suites,started_by_user_id,updated_at,accepted_reason,accepted_at
      from public.ai_provider_baseline_run where tenant_id=${ctx.tenantId}::uuid order by updated_at desc,id limit 200`));
    const label = (provider: string) => isProvider(provider) ? PROVIDER_META[provider].label : provider;
    const target = (kind: AiProviderBaselineTarget['kind'], provider: string, model: string, id: string | null, version: string | null, keyLast4: string | null, matches: (row: RunRow) => boolean): BaselineTargetView => {
      const run = bestRun(rows.filter(row => row.target_kind === kind && matches(row)), ctx.userId);
      const status: BaselineStatus = run?.state ?? 'pending';
      return Object.freeze({ key: kind + ':' + (id ?? provider), kind, provider, label: label(provider), model, targetId: id, targetVersion: version, keyLast4, status, run,
        activatable: status === 'passed' || status === 'accepted' });
    };
    const targets: BaselineTargetView[] = [
      ...Array.from(pending).filter(row => isDirectProvider(row.provider)).map(row => target('pending', row.provider, row.model, row.id, row.version_token, row.key_last4,
        run => run.target_id === row.id && run.target_version === row.version_token)),
      ...candidates.map(row => target('openrouter_candidate', 'openrouter', row.model, row.id, row.version, row.keyLast4,
        run => run.target_id === row.id && run.target_version === row.version)),
    ];
    let platform: AiProviderChangeView['platform'] = null;
    if (env) {
      const fingerprint = environmentModelFingerprint(env.provider, env.model);
      const view = target('environment', env.provider, env.model, null, null, null, run => run.config_fingerprint === fingerprint);
      targets.push(view);
      platform = Object.freeze({ provider: env.provider, label: label(env.provider), model: env.model, fingerprint, evaluated: view.activatable });
    }
    const active = current ? Object.freeze({ provider: current.provider, label: label(current.provider), model: current.model, evaluated: current.evaluated === true }) : null;
    return Object.freeze({ targets: Object.freeze(targets), platform, active });
  });
}

export type BaselineRunInput = Readonly<{ kind: AiProviderBaselineTarget['kind']; provider?: string; targetId?: string | null; targetVersion?: string | null; consent: boolean }>;
function captureTarget(input: BaselineRunInput): AiProviderBaselineTarget {
  if (!input || typeof input !== 'object') throw new AiProviderBaselineError('unavailable');
  if (input.kind === 'pending' && isDirectProvider(input.provider)) return Object.freeze({ kind: 'pending', provider: input.provider });
  if (input.kind === 'openrouter_candidate') return Object.freeze({ kind: 'openrouter_candidate' });
  if (input.kind === 'environment') return Object.freeze({ kind: 'environment' });
  throw new AiProviderBaselineError('unavailable');
}

export type BaselineRunResult = Readonly<{ runId: string; state: 'evaluating' | 'passed' | 'failed'; attempted: number; interrupted: boolean; progress: ProviderBaselineProgress }>;

/** Runs (or continues) the baseline suites against one pending target, up to PROVIDER_BASELINE_REQUEST_LIMIT
 * provider requests. Stops at the first failed case: one failure already fails the run, and later cases would only
 * add spend. A provider or allowance refusal stops the batch and leaves the run evaluating, to be continued. */
export async function runProviderBaseline(ctx: SessionContext, input: BaselineRunInput): Promise<BaselineRunResult> {
  ctx = captured(ctx);
  if (input?.consent !== true) throw new AiProviderBaselineError('consent_required');
  const target = captureTarget(input);
  if (target.kind !== 'environment' && (!UUID.test(String(input.targetId ?? '')) || !UUID.test(String(input.targetVersion ?? '')))) throw new AiProviderBaselineError('stale');
  const prepared = await withTenant(ctx, async tx => {
    await adminTx(tx, ctx);
    let snapshot: AiProviderSnapshot;
    try { snapshot = await resolveAiProviderBaselineSnapshotTx(tx, ctx, target); } catch { throw new AiProviderBaselineError('unavailable'); }
    const binding = target.kind === 'environment' ? null : snapshot.candidate ?? null;
    if (target.kind !== 'environment' && (!binding || binding.id !== String(input.targetId).toLowerCase() || binding.version !== String(input.targetVersion).toLowerCase())) throw new AiProviderBaselineError('stale');
    const { provider, model } = snapshot.configuration;
    const fingerprint = target.kind === 'environment' ? environmentModelFingerprint(provider, model) : snapshot.fingerprint;
    // Continue this administrator's own unfinished run of the exact same target and suites; never re-spend a recorded case.
    const [existing] = await tx.execute<{ id: string; suites: unknown }>(sql`select id,suites from public.ai_provider_baseline_run
      where tenant_id=${ctx.tenantId}::uuid and target_kind=${target.kind} and target_id is not distinct from ${binding?.id ?? null}::uuid
      and target_version is not distinct from ${binding?.version ?? null}::uuid and config_fingerprint=${fingerprint} and suite_digest=${PROVIDER_BASELINE_SUITE_DIGEST}
      and state='evaluating' and started_by_user_id=${ctx.userId ?? null}::uuid order by updated_at desc,id limit 1`);
    let runId: string, progress: ProviderBaselineProgress;
    if (existing) {
      runId = existing.id;
      try { progress = captureProviderBaselineProgress(existing.suites); } catch { throw new AiProviderBaselineError('unavailable'); }
    } else {
      progress = initialProviderBaselineProgress();
      let row: { id: string } | undefined;
      try {
        [row] = await tx.execute<{ id: string }>(sql`select app.ai_provider_baseline_start_v1(${target.kind},${binding?.id ?? null}::uuid,${binding?.version ?? null}::uuid,
          ${provider},${model},${fingerprint},${PROVIDER_BASELINE_SUITE_DIGEST},${JSON.stringify(progress)}::jsonb) as id`);
      } catch { throw new AiProviderBaselineError('unavailable'); }
      if (!row?.id) throw new AiProviderBaselineError('unavailable');
      runId = row.id;
      await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'ai-control', aggregateId: runId, eventType: 'ai-control.provider-baseline-started', actor: actorOf(ctx),
        payload: { target: target.kind, provider, model, suiteDigest: PROVIDER_BASELINE_SUITE_DIGEST } });
    }
    // The run row is the spend root; admission re-resolves this exact target version before every request.
    const cfg = bindStrictAiSpendRoot(governedAiConfig(ctx, snapshot, 'provider_evaluation'), { rootTaskId: runId, kind: 'evaluation' });
    return { runId, progress, cfg, provider, model };
  });
  const progress = structuredClone(prepared.progress);
  let attempted = 0, interrupted = false;
  outer: for (const suite of PROVIDER_BASELINE_SUITE_IDS) {
    const counts = progress[suite];
    if (counts.failed > 0) break;
    while (counts.next < counts.total) {
      if (attempted >= PROVIDER_BASELINE_REQUEST_LIMIT) break outer;
      const fixture = PROVIDER_BASELINE_SUITES[suite][counts.next];
      attempted++;
      let text: string;
      try { text = await generateDraft(prepared.cfg, { system: PROVIDER_BASELINE_SYSTEM, prompt: fixture.prompt, maxTokens: 384, timeoutMs: 15000 }); }
      catch { interrupted = true; break outer; }
      counts.next++;
      if (providerBaselineCasePassed(fixture, text)) counts.passed++;
      else { counts.failed++; break outer; }
    }
  }
  const state = await withTenant(ctx, async tx => {
    await adminTx(tx, ctx);
    let row: { state: string } | undefined;
    try { [row] = await tx.execute<{ state: string }>(sql`select app.ai_provider_baseline_record_v1(${prepared.runId}::uuid,${JSON.stringify(progress)}::jsonb) as state`); }
    catch { throw new AiProviderBaselineError('unavailable'); }
    const recorded = row?.state;
    if (recorded !== 'evaluating' && recorded !== 'passed' && recorded !== 'failed') throw new AiProviderBaselineError('unavailable');
    if (recorded !== 'evaluating') await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'ai-control', aggregateId: prepared.runId,
      eventType: 'ai-control.provider-baseline-completed', actor: actorOf(ctx),
      payload: { provider: prepared.provider, model: prepared.model, state: recorded, suites: progress, suiteDigest: PROVIDER_BASELINE_SUITE_DIGEST } });
    return recorded;
  });
  return Object.freeze({ runId: prepared.runId, state, attempted, interrupted, progress });
}

/** A group administrator accepts a failed or unfinished run of the CURRENT target version. The reason is recorded
 * on the run and in the audit stream; activation is then admitted for that exact version only. */
export async function acceptProviderBaselineFailure(ctx: SessionContext, input: { runId: string; reason: string }): Promise<void> {
  ctx = captured(ctx);
  const runId = String(input?.runId ?? ''), reason = String(input?.reason ?? '').trim();
  if (!UUID.test(runId)) throw new AiProviderBaselineError('unavailable');
  if (reason.length < 10 || reason.length > 1000) throw new AiProviderBaselineError('reason_required');
  await withTenant(ctx, async tx => {
    await adminTx(tx, ctx);
    const [run] = await tx.execute<{ target_kind: string; provider: string; model: string; state: string }>(sql`select target_kind,provider,model,state from public.ai_provider_baseline_run
      where id=${runId}::uuid and tenant_id=${ctx.tenantId}::uuid`);
    if (!run) throw new AiProviderBaselineError('unavailable');
    try { await tx.execute(sql`select app.ai_provider_baseline_accept_v1(${runId}::uuid,${reason})`); }
    catch { throw new AiProviderBaselineError('unavailable'); }
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'ai-control', aggregateId: runId, eventType: 'ai-control.provider-baseline-accepted', actor: actorOf(ctx),
      payload: { target: run.target_kind, provider: run.provider, model: run.model, previousState: run.state, reason } });
  });
}
