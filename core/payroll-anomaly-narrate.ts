/**
 * ADR-0076 §2.6 — THE ANOMALY NARRATOR. The only place an LLM touches the payroll control tower.
 *
 * The queue has been showing operators a detector id and a row of `key=value` in monospace since r177.
 * That is evidence, and it is the right thing to keep — but it is written for whoever built the detector,
 * not for the person who has to decide what to do about it. This turns
 *
 *     ot-spike   delta=820  hours=14  priorHours=0
 *
 * into "Overtime is RM820 higher than last month; 14 approved OT hours were recorded this cycle versus
 * none last cycle." Same facts, same classification, readable by the person holding the decision.
 *
 * ═══ THE FOUR PROPERTIES THAT MAKE AN LLM ACCEPTABLE ON A PAYROLL SCREEN ═══
 *
 *  1. IT CANNOT CHANGE A CLASSIFICATION. Disposition and severity are computed by pure detectors and
 *     written before this runs; narrate() only ever writes the `narrative` COLUMN. There is no code path
 *     from here back to a verdict.
 *  2. IT CANNOT PRODUCE A FIGURE, AND THAT IS ENFORCED RATHER THAN REQUESTED. §2.6 says "every number in
 *     the prose is interpolated from `facts`". A prompt asking for that is a hope; `narrationIsFaithful`
 *     below CHECKS it, and prose containing any number the facts do not support is DISCARDED. This is the
 *     difference between a model that must not hallucinate a ringgit figure and one that cannot ship one.
 *  3. IT IS NEVER ON THE CRITICAL PATH. No provider configured, provider down, timeout, unfaithful output
 *     — every one of them returns null and the screen renders exactly what it renders today. Nothing
 *     about evaluating, blocking or closing a run depends on this file.
 *  4. IT NEVER SEES A PERSON. The prompt carries a detector id and a bag of numbers. No name, no employee
 *     code, no employment id, no company. There is nothing in it to leak and nothing to inject with.
 *
 * WHY ON DEMAND AND NOT IN THE SWEEP. The nightly sweep supersedes verdicts, so narrating there would
 * re-spend on every finding every night for prose nobody may ever read — on the tenant's own BYOK key
 * (ADR-0023). Generated when an operator asks, then persisted, so it is paid for once per finding and
 * only for findings someone actually opened.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { generateDraft } from '../lib/ai';
import { recordProposal } from './agent-proposal';
import { resolveActiveAiConfig } from './ai-config';

/** Bounded hard: this is prose over at most a handful of numbers, never an essay. */
const MAX_TOKENS = 160;

/**
 * Every digit-run the facts can legitimately support.
 *
 * Both forms are collected, and the second is why: a fact value of "2026-08" must license the prose token
 * "2026", or a narrative that names the month gets discarded for being unfaithful when it is not. Splitting
 * on non-digits gives the parts; the normalised whole covers "820" against a stored 820.00.
 */
function supportedNumbers(facts: Record<string, string | number>): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t) return;
    out.add(t);
    // 820.00 → 820, 1,234 → 1234. Both spellings are the same figure to a reader and must be to us.
    const n = Number(t.replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(String(n));
  };
  for (const v of Object.values(facts)) {
    const s = String(v);
    add(s);
    add(s.replace(/,/g, ''));
    for (const run of s.match(/\d+(?:\.\d+)?/g) ?? []) add(run);
  }
  return out;
}

/**
 * THE GUARD. True when every number in `prose` is one the facts support.
 *
 * Deliberately strict in the direction that costs nothing: a false rejection degrades to the structured
 * facts the operator already had, while a false acceptance puts a figure nobody can trace onto a payroll
 * screen. AGENTS 28 — a confident wrong number is worse than a terse right one.
 *
 * Exported because it is the property worth testing directly, without a provider.
 */
export function narrationIsFaithful(prose: string, facts: Record<string, string | number>): boolean {
  const supported = supportedNumbers(facts);
  for (const tok of prose.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    const bare = tok.replace(/[.,]+$/, '');
    const norm = String(Number(bare.replace(/,/g, '')));
    if (supported.has(bare) || supported.has(norm) || supported.has(tok)) continue;
    return false;
  }
  return true;
}

/**
 * The instruction. Stable — it is the whole prompt prefix and nothing tenant-shaped is interpolated.
 *
 * "Do not introduce any number that is not in the list" is stated even though it is also ENFORCED, because
 * a model told the rule fails the check far less often than one left to guess it, and every failure costs
 * a call.
 */
const SYSTEM = [
  'You explain one payroll exception to a payroll officer, in one or two plain sentences of British English.',
  'You are given a check name and the numbers that triggered it. Say what the numbers mean, plainly.',
  'Do not introduce any number that is not in the list you are given — not a total, not a percentage, not a rounding.',
  'Do not recommend an action, do not judge whether it is acceptable, and do not mention employees by name.',
  'If the numbers do not support a sentence, say only what they show.',
].join(' ');

/** `{ delta: 820, hours: 14 }` → "delta: 820, hours: 14". The model gets nothing else. */
const factsAsText = (facts: Record<string, string | number>) =>
  Object.entries(facts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

export type NarrateOutcome = {
  narrated: number;
  /** Findings whose prose was discarded for naming a figure the facts do not support. */
  rejected: number;
  /** True when no provider is configured — the screen says so rather than showing a silent nothing. */
  notConfigured: boolean;
};

/**
 * Narrate every not-yet-narrated finding on one verdict, and persist what survives the guard.
 *
 * Returns counts rather than the prose: the caller re-reads the queue, so a second source of the same
 * sentence cannot drift from the stored one.
 */
export async function narrateVerdict(
  ctx: SessionContext,
  p: { verdictId: string },
): Promise<NarrateOutcome> {
  const findings = await withTenant(ctx, (tx) =>
    tx
      .select({
        id: schema.payrollAnomalyFinding.id,
        detectorId: schema.payrollAnomalyFinding.detectorId,
        facts: schema.payrollAnomalyFinding.facts,
      })
      .from(schema.payrollAnomalyFinding)
      .where(
        and(
          eq(schema.payrollAnomalyFinding.verdictId, p.verdictId),
          isNull(schema.payrollAnomalyFinding.narrative),
        ),
      ),
  );
  if (findings.length === 0) return { narrated: 0, rejected: 0, notConfigured: false };

  const cfg = await withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx));
  // NOT an error. A tenant with no provider gets the queue it has always had, which is a working queue.
  if (!cfg) return { narrated: 0, rejected: 0, notConfigured: true };

  let narrated = 0;
  let rejected = 0;
  const writes: { id: string; narrative: string }[] = [];

  for (const f of findings) {
    let prose: string;
    try {
      prose = (
        await generateDraft(cfg, {
          system: SYSTEM,
          prompt: `Check: ${f.detectorId}\nNumbers: ${factsAsText(f.facts)}`,
          maxTokens: MAX_TOKENS,
        })
      ).trim();
    } catch {
      // Provider down, timed out, refused. The finding keeps its facts and can be asked again later.
      continue;
    }
    if (!prose) continue;

    // ADR-0084 §2.4 — `narrationIsFaithful` IS this surface's adjudicator, and this loop is the reason it
    // was the first thing retro-fitted onto the ledger: it already produced BOTH outcomes and threw both
    // away. `rejected` was a number on a toast that nobody could aggregate; now every discarded figure is
    // a row, and the adjudication-pass rate for `anomaly_narration` becomes a real quantity.
    //
    // THERE IS NO HUMAN DECISION ON THIS TYPE, EVER — nobody approves prose. So `agreementRate` stays
    // null for it by construction, and the measurable property is the pass rate alone. A screen must not
    // read that null as a zero (see `proposalRates`).
    const faithful = narrationIsFaithful(prose, f.facts);
    await recordProposal(ctx, {
      type: 'anomaly_narration',
      subject: { type: 'payroll_anomaly_finding', id: f.id },
      facts: f.facts,
      // The prose is the proposal. It is safe to keep ONLY because it just passed (or failed) the check
      // that every number in it traces to `facts` — an unfaithful one is exactly what we want to read
      // back later when asking why a model keeps inventing figures.
      proposal: { detectorId: f.detectorId, prose },
      adjudication: faithful ? { ok: true } : { ok: false, reason: 'unsupported_figure' },
      provider: cfg.provider,
      model: cfg.model,
    });

    if (!faithful) {
      // The model named a figure the facts do not support. Discard it — do NOT store it flagged, do NOT
      // show it caveated. There is no honest way to render a number we cannot trace on a payroll screen.
      rejected++;
      continue;
    }
    writes.push({ id: f.id, narrative: prose });
    narrated++;
  }

  if (writes.length) {
    await withTenant(ctx, async (tx) => {
      for (const w of writes) {
        // Only the narrative column, and only where it is still null: a concurrent narration must not
        // overwrite prose an operator is already reading.
        await tx
          .update(schema.payrollAnomalyFinding)
          .set({ narrative: w.narrative })
          .where(
            and(
              eq(schema.payrollAnomalyFinding.id, w.id),
              isNull(schema.payrollAnomalyFinding.narrative),
            ),
          );
      }
    });
  }
  return { narrated, rejected, notConfigured: false };
}
