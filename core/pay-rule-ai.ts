/**
 * AI-assisted pay-rule drafting (Payroll Setup — configurable pay-rule engine). DRAFT-ONLY, one-shot.
 *
 * Because the rule is a CLOSED enum of discriminated kinds (not a free-text formula), the model's job
 * collapses from "generate a fragile expression string" to "classify a sentence into one of ~6 kinds +
 * extract a number". It emits ONE JSON object matching the PayRule union plus a one-line plain-English
 * explanation; we parse it and run the SAME pure validatePayRule the UI and the kernel use.
 *
 * 61bf109d — the assist covers the SINGLE-VALUE kinds only, `qty_rate` included. It deliberately does NOT
 * draft the `formula` kind or a `percent_of base:'component'` rule: both create a dependency between pay
 * items, and a model inventing an edge in the catalog's dependency graph is a class of mistake the admin
 * cannot see in a one-line explanation. Those two are built by hand in the structured editor, where the
 * referenced pay item is picked from a list rather than guessed. validatePayRule is still the backstop —
 * a model that emitted one anyway would be structurally valid but is simply never asked for.
 *
 * Mirrors generateFeedbackPlan / draftManagerReview exactly:
 *   - short read-tx to resolveActiveAiConfig (null ⇒ feature OFF when unconfigured → typed error);
 *   - a REDACTED prompt (redactPII over the admin's free-text description) — no employee PII leaves the tenant;
 *   - generateDraft OUTSIDE any tx, maxTokens ~512;
 *   - ONE shot: an invalid/unparseable model output ⇒ a single typed PayRuleDraftError (no retry, no 2nd call);
 *   - NEVER writes the component — returns the rule object for the admin to review + save via upsertPayComponent;
 *   - appends a `pay-component.ai-rule-drafted` event (actor { type: 'agent' }, PII-free payload).
 */
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent } from '../db/events';
import { generateDraft, redactPII } from '../lib/ai';
import { resolveActiveAiConfig } from './ai-config';
import { validatePayRule, PAY_RULE_KINDS, type PayRule } from './pay-rule';
import { recordProposal } from './agent-proposal';

/** Thrown when AI assist cannot produce a valid rule (unconfigured provider, unparseable output, or a model
 *  rule that fails validatePayRule). Carries a localisable reason key so the dialog shows a translated message. */
export class PayRuleDraftError extends Error {
  constructor(public readonly reason: 'not_configured' | 'invalid_output') {
    super(`pay-rule-draft:${reason}`);
    this.name = 'PayRuleDraftError';
  }
}

const SYSTEM = [
  'You configure ONE pay-component calculation rule for a Malaysian HR / payroll system. You do NOT write',
  'code or an expression — you pick exactly one rule "kind" from a fixed list and fill in its number(s).',
  'The rule kinds and their fields are EXACTLY:',
  '  - {"kind":"fixed"} — a fixed monthly amount (the component already stores the amount; no extra field).',
  '  - {"kind":"percent_of","base":"basic","pct":N} — N percent of the employee\'s BASIC salary (N is 0..1000).',
  '  - {"kind":"per_day","rate":N} — N ringgit per day worked.',
  '  - {"kind":"per_hour","rate":N} — N ringgit per hour worked (from attendance).',
  '  - {"kind":"flat_capped","value":N,"cap":M} — pay N but never more than the cap M.',
  '  - {"kind":"qty_rate","qty":N,"rate":M} — a quantity N multiplied by a rate M.',
  'There is NO "percent of gross", NO subtraction, NO division, and NO other kind — if the request does not',
  'fit one of the above, choose the closest fit. All numbers are non-negative.',
  'Respond with ONLY a single minified JSON object and nothing else, on one line, of the shape:',
  '{"rule": <one rule object above>, "explanation": "<one short plain-English sentence>"}.',
  'No markdown, no code fences, no preamble.',
].join(' ');

type DraftResult = { rule: PayRule; explanation: string };

/** Best-effort extraction of the single JSON object from a model response (tolerates stray prose / fences). */
function parseModelJson(text: string): { rule: unknown; explanation: unknown } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === 'object' ? (obj as { rule: unknown; explanation: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * Draft a pay-rule from a plain-language description. `componentProrates` is the prorates flag of the
 * component the admin is editing — passed so the proration-conflict validation matches what upsertPayComponent
 * will enforce on save (an AI-suggested per_day/per_hour rule on a prorating component is rejected here, not
 * after a green "Use this"). Returns the rule + explanation for the admin to review; NEVER writes anything.
 */
export async function draftPayRule(
  ctx: SessionContext,
  p: { description: string; componentCode?: string | null; componentProrates?: boolean },
): Promise<DraftResult> {
  // Short read-tx: resolve the tenant's active AI config. Null ⇒ the feature is OFF (unconfigured).
  const cfg = await withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx));
  if (!cfg) throw new PayRuleDraftError('not_configured');

  // Redact PII from the admin's free text before it leaves the tenant (a description could name an employee).
  const prompt = [
    'Configure a pay-component rule from this description:',
    redactPII(p.description),
    p.componentCode ? `The component code is ${p.componentCode}.` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Provider call OUTSIDE any tx.
  const raw = await generateDraft(cfg, { system: SYSTEM, prompt, maxTokens: 512 });

  const parsed = parseModelJson(raw);
  const rule = parsed?.rule as PayRule | undefined;
  const explanation = typeof parsed?.explanation === 'string' ? parsed.explanation.trim() : '';
  // One-shot: validate the model's structured output. Invalid ⇒ a single typed error (the admin re-asks).
  // No second AI call.
  const v = rule ? validatePayRule(rule, p.componentProrates ?? false) : { ok: false as const, code: 'BAD_KIND' as const };

  // ADR-0084 §2.4 — `validatePayRule` IS this surface's adjudicator; it always was, and the only thing
  // this round adds is that its verdict is now WRITTEN DOWN. The reason is specific rather than a blanket
  // "invalid": an adjudication-pass rate that cannot say WHICH check refused the output tells you the
  // model is failing without telling you at what, which is not actionable (0452 CHECK requires it).
  const reason = !parsed
    ? 'unparseable_output'
    : !rule
      ? 'no_rule_in_output'
      : !PAY_RULE_KINDS.includes(rule.kind)
        ? 'unknown_rule_kind'
        : !v.ok
          ? `validate_pay_rule:${v.code}`
          : !explanation
            ? 'no_explanation'
            : null;

  // ⚠️ RECORDED BEFORE THE THROW, and in the ledger's OWN transaction (agent-proposal property 2). A
  // rejection recorded inside the aborting path would roll back with it, and this surface's rejections
  // are the entire point — an authoring assist that silently fails half the time looks identical to one
  // that works, from the outside.
  await recordProposal(ctx, {
    type: 'pay_rule_draft',
    // No subject: nothing is written until the admin saves, so there is no row for this to be about.
    facts: { componentCode: p.componentCode ?? null, prorates: p.componentProrates ?? false },
    // The DESCRIPTION never lands here — it is the admin's free text and is redacted before it even
    // reaches the provider. Only the shape the model chose.
    proposal: { ruleKind: rule?.kind ?? null, hasExplanation: Boolean(explanation) },
    adjudication: reason === null ? { ok: true } : { ok: false, reason },
    provider: cfg.provider,
    model: cfg.model,
  });

  // The `!rule || !explanation` clauses are REDUNDANT AT RUNTIME — `reason` is already non-null in both
  // cases — and are here so the compiler keeps the narrowing the original compound guard gave it. Without
  // them `rule` stays `PayRule | undefined` below.
  if (reason !== null || !rule || !explanation) {
    throw new PayRuleDraftError('invalid_output');
  }

  // Audit the generation (draft-only). PII-free payload: provider/model + component code + rule kind only —
  // never the description. Keyed to the tenant (no component row is written; this is a pre-save draft).
  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pay-component',
      aggregateId: ctx.tenantId,
      eventType: 'pay-component.ai-rule-drafted',
      actor: { type: 'agent' }, // lowercase per db/events.ts Actor enum
      payload: { provider: cfg.provider, model: cfg.model, componentCode: p.componentCode ?? null, ruleKind: rule.kind },
    }),
  );

  return { rule, explanation };
}
