/**
 * ADR-0084 §2.7 / §3 item 4 — INPUT-SIDE TRIAGE. The largest untouched surface in the product.
 *
 * ═══ WHY THIS IS THE ITEM THAT MATTERS ═══
 *
 * **Every payroll error is born upstream** — in a claim, a timesheet, an overtime entry, a change request.
 * That is the highest-volume judgment work in HR and until this file it was 100% human and 0% assisted.
 * r238 put a second opinion on the OUTPUT of payroll; this puts one on the INPUT, which is the only end
 * where an error can still be cheap.
 *
 * ⚠️ **AND IT DELIBERATELY DOES NOT ADDRESS THE APPROVER.** Telling an approver "look at this one" makes a
 * faster human, and ADR-0084 §1 is blunt that a faster human is the ceiling that leaves headcount where it
 * was. The query goes to **the person who filed the claim**, because they are the only one who can still
 * withdraw it — `cancelClaim` lets the claimant cancel their own pending claim, and nobody else's screen
 * can un-file it. Same discipline as r237's routing table: address the person who can actually act, read
 * out of the product rather than assumed.
 *
 * ═══ WHAT A RULE ALREADY CATCHES, AND IS THEREFORE NOT THIS FILE'S BUSINESS ═══
 *
 * `priceAndCheckClaimTx` already refuses, at submit, in the caller's transaction: an unknown or archived
 * type, a missing or foreign item, a receipt date in the future or outside the backdating window, a
 * mileage claim priced against the wrong band table, a required custom field left blank, and every
 * per-grade limit and block window. **A claim reaching this file has passed all of that.** So triage looks
 * only at what those checks cannot see, which is one thing: whether the DESCRIPTION and the claim agree.
 *
 * ═══ THE INVARIANT §2.7 STATES AND THIS FILE MAKES STRUCTURAL ═══
 *
 * **It never rejects anything.** There is no `reject` in the output vocabulary, no code path from here to
 * `claim_request.status`, and nothing in this file writes to a claim. The strongest thing it can do is
 * raise a question with the person who wrote the claim, which they are free to ignore.
 *
 * ═══ THE ONE THING TO KNOW BEFORE SWITCHING IT ON ═══
 *
 * ⚠️ **THIS IS THE FIRST SURFACE IN THE PRODUCT THAT SENDS EMPLOYEE-AUTHORED FREE TEXT TO A PROVIDER.**
 * `report-ai.ts`'s posture is *schema out, never data*, and the narrator sends only a bag of numbers. Here
 * the description IS the thing being read, so it cannot be withheld. What is withheld: the employee's
 * name, their employment id, their company, and anything `redactPII` can find (email, IC, phone). What is
 * sent: the claim type, the item, the amount, two dates and the redacted description. It is the tenant's
 * own key (ADR-0023), and the switch below is off until they say otherwise.
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent } from '../db/events';
import * as schema from '../db/schema';
import { generateDraft, redactPII } from '../lib/ai';
import { digestOf, recordProposal, type Adjudication } from './agent-proposal';
import { resolveActiveAiConfig } from './ai-config';
import { settingEnabled } from './entitlements';
import { narrationIsFaithful } from './payroll-anomaly-narrate';

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The closed policy catalogue (§2.7)
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE CATALOGUE. §2.7 requires the `policyRuleId` to exist in a closed set; this is that set, and every
 * member is something an approver genuinely queries and no deterministic check can reach.
 *
 * Each carries a `holds` predicate — a NECESSARY condition, re-derived from the claim row at adjudication.
 * As in r238, necessary is not sufficient: several hold at once on most claims, and choosing between them
 * is the model's whole contribution. What the predicate stops is a claim being labelled with a rule whose
 * precondition is plainly absent — a `date_inconsistent` on a description that names no date at all.
 */
export const TRIAGE_RULES = [
  /** The description describes something the chosen type or item does not cover. Miscategorisation is the
   *  most common claim error there is, and the type check at submit only proves the type EXISTS. */
  'claim.category_mismatch',
  /** The description gives no basis for the amount — nothing to check the figure against. */
  'claim.amount_unexplained',
  /** The description names a period the receipt date contradicts. */
  'claim.date_inconsistent',
  /** The description reads as somebody else's expense. */
  'claim.subject_not_self',
  /** Too little written down to decide at all. The one rule whose precondition nearly settles it. */
  'claim.detail_insufficient',
] as const;
export type TriageRuleId = (typeof TRIAGE_RULES)[number];

/** Not a rule: the model saying the claim reads fine. Valid output, and the expected majority answer. */
export const VERDICT_OK = 'ok';

/** Below this many characters a description cannot support a decision, whatever it says. */
export const THIN_DESCRIPTION_CHARS = 12;

/** The longest question worth putting in a notification. A query that needs scrolling is not a query. */
const MAX_REASON_CHARS = 200;

/** Month names and year/numeric-date shapes, in the six locales' Latin scripts plus the obvious digits. */
const DATE_TOKEN =
  /\b(jan|feb|mac|mar|apr|mei|may|jun|jul|ogo|aug|sep|okt|oct|nov|dis|dec)[a-z]*\b|\b(19|20)\d{2}\b|\b\d{1,2}[/-]\d{1,2}\b/i;

/** What the adjudicator re-derives against. Assembled from the claim row, never from the model. */
export type ClaimFacts = {
  claimId: string;
  type: string;
  item: string | null;
  amount: number;
  incurredOn: string;
  submittedOn: string;
  description: string;
};

const CLAIM_RULES: Record<TriageRuleId, (f: ClaimFacts) => boolean> = {
  // Nothing to mismatch against without both a description and a category.
  'claim.category_mismatch': (f) => f.description.length > 0 && f.type.length > 0,
  // An amount of zero explains itself, and an empty description is `detail_insufficient`, not this.
  'claim.amount_unexplained': (f) => f.amount > 0 && f.description.length > 0,
  // ⚠️ THE ONE PREDICATE THAT REALLY BITES. A claim whose description names no date, month or year cannot
  // contradict its receipt date, so this rule is unavailable however confident the model sounds.
  'claim.date_inconsistent': (f) => DATE_TOKEN.test(f.description),
  'claim.subject_not_self': (f) => f.description.length > 0,
  // Its precondition IS its subject matter: a description long enough to work with cannot be too thin.
  'claim.detail_insufficient': (f) => f.description.trim().length < THIN_DESCRIPTION_CHARS,
};

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The adjudicator (§2.4, §2.7)
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

export type TriageProposal = { verdict: string; policyRuleId?: string | null; reason?: string | null };

/**
 * §2.7 — "the `policyRuleId` must exist in the closed policy catalogue and any referenced figure must
 * match the source record."
 *
 * ⚠️ **THE FIGURE CHECK IS `narrationIsFaithful`, THE THIRD SURFACE TO USE IT UNCHANGED.** The narrator
 * discards prose naming a number its facts do not support; a claim query is the same problem with a
 * different noun, and re-implementing it here is how the two would come to disagree about what "supported"
 * means. §2.4 asked for one contract with several implementations — this is the contract borrowing an
 * implementation, which is better.
 *
 * Every refusal is named separately: a pass rate that cannot say WHICH check refused the output tells you
 * the model is failing without telling you at what.
 */
export function adjudicateTriage(p: TriageProposal, f: ClaimFacts): Adjudication {
  if (p.verdict === VERDICT_OK) {
    // A clean verdict that also raises a rule is not a clean verdict; it is output that ignored the shape.
    return p.policyRuleId ? { ok: false, reason: 'rule_on_ok_verdict' } : { ok: true };
  }
  if (p.verdict !== 'query') return { ok: false, reason: 'unknown_verdict' };

  const rule = p.policyRuleId ?? '';
  if (!(TRIAGE_RULES as readonly string[]).includes(rule)) return { ok: false, reason: `unknown_rule:${rule}` };

  const reason = (p.reason ?? '').trim();
  if (!reason) return { ok: false, reason: 'no_reason' };
  if (reason.length > MAX_REASON_CHARS) return { ok: false, reason: 'reason_too_long' };
  // An unresolved placeholder or a hand-written link — neither survives being stored verbatim.
  if (/[{}<>]|https?:\/\//.test(reason)) return { ok: false, reason: 'reason_not_plain_text' };

  // THE FIGURE CHECK. Every number the question puts in front of an employee must be one their own claim
  // supports — otherwise the query itself is the error it claims to be finding.
  if (!narrationIsFaithful(reason, factsForFigures(f))) return { ok: false, reason: 'unsupported_figure' };

  if (!CLAIM_RULES[rule as TriageRuleId](f)) return { ok: false, reason: `rule_unsupported:${rule}` };
  return { ok: true };
}

/**
 * The numbers a query may legitimately name.
 *
 * The DESCRIPTION is in here deliberately: the employee wrote it, so a figure they themselves put in it
 * ("RM 60 taxi") is by definition supported by the source record and a question quoting it back is fair.
 */
const factsForFigures = (f: ClaimFacts): Record<string, string | number> => ({
  amount: f.amount,
  incurredOn: f.incurredOn,
  submittedOn: f.submittedOn,
  description: f.description,
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The run — I/O, the provider call, the ledger and the question
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The tenant switch, OFF by default. Third of its kind and for the third reason: this one puts a question
 * in front of a real employee about their own money, unprompted, on a schedule.
 *
 * ⚠️ THE `settingEnabled` CALL BELOW PASSES THE STRING LITERAL, not this constant, and the duplication is
 * deliberate — `test/module-catalog-drift.test.ts` scans call sites for a literal key, and a call through
 * a variable is invisible to it. An uncatalogued key is a 500, not a disabled feature.
 */
export const TRIAGE_SETTING_KEY = 'claims.input_triage_enabled';

/** Blast radius per tenant per pass. It REFUSES rather than truncating silently: `cappedOut` says so. */
export const MAX_TRIAGE_PER_RUN = 40;

/**
 * How far back a pending claim is still worth asking about.
 *
 * A claim filed three months ago and still pending is an APPROVER problem, not an input problem, and a
 * question to the employee about it would be the wrong message to the wrong person. It also stops the
 * first run on an existing tenant turning a year of backlog into a mailshot.
 */
export const TRIAGE_WINDOW_DAYS = 14;

/** One label, one rule id and one short sentence. There is no essay in the output to bound. */
const MAX_TOKENS = 200;

const SYSTEM = [
  'You read ONE expense claim an employee has filed and decide whether anything about it needs asking.',
  'You are given the claim type, the sub-item, the amount, the receipt date, the date it was filed, and',
  'the employee’s own description. You never see their name.',
  'Answer "ok" unless something in the DESCRIPTION does not fit the rest of the claim. "ok" IS THE RIGHT',
  'ANSWER MOST OF THE TIME — an ordinary claim with an ordinary description is ok.',
  'If something does not fit, choose exactly ONE reason from this fixed list:',
  '  claim.category_mismatch — the description describes something this claim type or item does not cover.',
  '  claim.amount_unexplained — the description gives no basis for the amount.',
  '  claim.date_inconsistent — the description names a period the receipt date contradicts.',
  '  claim.subject_not_self — the description reads as somebody else’s expense.',
  '  claim.detail_insufficient — there is too little written down to decide at all.',
  'Then write ONE short question, under 200 characters, addressed to the employee, plainly and without',
  'accusation. You may quote a number ONLY if it already appears in the claim you were given.',
  'Never say the claim is wrong, never say it will be refused, and never tell them what to do.',
  'Respond with ONLY one minified JSON object and nothing else:',
  '{"verdict":"ok"} or {"verdict":"query","policyRuleId":"<one id above>","reason":"<the question>"}.',
  'No markdown, no code fences, no preamble.',
].join(' ');

/** What the model is shown. No name, no employment id, no company — and the description is redacted. */
const claimAsText = (f: ClaimFacts) =>
  [
    `Claim type: ${f.type}`,
    f.item ? `Item: ${f.item}` : null,
    `Amount: ${f.amount}`,
    `Receipt date: ${f.incurredOn}`,
    `Filed on: ${f.submittedOn}`,
    `Description: ${f.description || '(none)'}`,
  ]
    .filter(Boolean)
    .join('\n');

/** Best-effort extraction of the one JSON object, tolerating fences and stray prose. */
function parseTriage(text: string): TriageProposal | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof o?.verdict !== 'string') return null;
    return {
      verdict: o.verdict.trim(),
      policyRuleId: typeof o.policyRuleId === 'string' ? o.policyRuleId.trim() : null,
      reason: typeof o.reason === 'string' ? o.reason.trim() : null,
    };
  } catch {
    return null;
  }
}

export type TriageRun = {
  /** The tenant has not switched it on. Everything else is zero and nothing was spent. */
  disabled: boolean;
  /** No AI provider configured. Nothing is recorded — nothing was proposed. */
  notConfigured: boolean;
  /** Pending claims inside the window that have not been triaged before. */
  candidates: number;
  /** Provider calls actually made. */
  asked: number;
  /** Questions raised with the employee who filed the claim. */
  queried: number;
  /** The model read the claim and found nothing to ask. Valid, accepted, and the expected majority. */
  cleared: number;
  /** Output that failed adjudication and was discarded silently. */
  rejected: number;
  /** The run stopped at MAX_TRIAGE_PER_RUN with candidates left. */
  cappedOut: boolean;
};

const EMPTY: TriageRun = {
  disabled: false,
  notConfigured: false,
  candidates: 0,
  asked: 0,
  queried: 0,
  cleared: 0,
  rejected: 0,
  cappedOut: false,
};

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/**
 * One tenant's triage pass over the claims filed since the last one.
 *
 * ⚠️ **ONCE PER CLAIM, EVER — AND THE LEDGER IS WHAT REMEMBERS.** A claim is a one-shot object: its
 * description cannot change while it is pending, so a second look at the same row would ask the same
 * question of the same person about the same words. The `agent_proposal` subject is the claim, so
 * "already triaged" is a read of the ledger rather than a column on `claim_request`, and there is nothing
 * to migrate or to keep in step.
 */
export async function triagePendingClaims(ctx: SessionContext): Promise<TriageRun> {
  // The literal, not TRIAGE_SETTING_KEY — see that constant's note.
  if (!settingEnabled(ctx, 'claims.input_triage_enabled')) return { ...EMPTY, disabled: true };

  const since = daysAgo(TRIAGE_WINDOW_DAYS);
  const claims = await withTenant(ctx, (tx) =>
    tx
      .select({
        id: schema.claimRequest.id,
        employmentId: schema.claimRequest.employmentId,
        amount: schema.claimRequest.amount,
        incurredOn: schema.claimRequest.incurredOn,
        createdAt: schema.claimRequest.createdAt,
        description: schema.claimRequest.description,
        type: schema.claimType.name,
        item: schema.claimItem.name,
      })
      .from(schema.claimRequest)
      .innerJoin(schema.claimType, eq(schema.claimType.id, schema.claimRequest.claimTypeId))
      // LEFT: a type with no items, and every claim filed before items existed, must still be seen.
      .leftJoin(schema.claimItem, eq(schema.claimItem.id, schema.claimRequest.claimItemId))
      .where(and(eq(schema.claimRequest.status, 'pending'), gte(schema.claimRequest.createdAt, since)))
      .orderBy(desc(schema.claimRequest.createdAt))
      .limit(500),
  );
  if (claims.length === 0) return { ...EMPTY };

  // ONE read for "which of these have been looked at already", rather than one per claim: this has to
  // open for a tenant that files hundreds of claims a fortnight.
  const seenRows = await withTenant(ctx, (tx) =>
    tx
      .select({ subjectId: schema.agentProposal.subjectId })
      .from(schema.agentProposal)
      .where(
        and(
          eq(schema.agentProposal.proposalType, 'input_triage'),
          inArray(
            schema.agentProposal.subjectId,
            claims.map((c) => c.id),
          ),
        ),
      ),
  );
  const seen = new Set(seenRows.map((r) => r.subjectId));

  const todo = claims.filter((c) => !seen.has(c.id));
  const out: TriageRun = { ...EMPTY, candidates: todo.length };
  if (todo.length === 0) return out;

  // Resolved ONCE, and only when there is something to ask about.
  const cfg = await withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx)).catch(() => null);
  // NOT an error, and nothing is recorded: a tenant with no provider proposed nothing, and counting that
  // as a model failure would drag the pass rate down measuring the absence of a subscription.
  if (!cfg) return { ...out, notConfigured: true };

  let looked = 0;
  for (const c of todo) {
    if (looked >= MAX_TRIAGE_PER_RUN) {
      out.cappedOut = true;
      break;
    }
    looked++;

    const facts: ClaimFacts = {
      claimId: c.id,
      type: c.type,
      item: c.item,
      amount: Number(c.amount),
      incurredOn: c.incurredOn,
      submittedOn: c.createdAt.toISOString().slice(0, 10),
      // The employee's own words, minus anything `redactPII` can find. See the file header on why the
      // description itself cannot be withheld and what that costs.
      description: redactPII(c.description ?? ''),
    };

    let raw = '';
    try {
      raw = await generateDraft(cfg, { system: SYSTEM, prompt: claimAsText(facts), maxTokens: MAX_TOKENS });
    } catch {
      // Provider down, timed out, refused. Nothing proposed, nothing recorded; the next pass re-asks
      // because no ledger row was written for this claim.
      continue;
    }
    out.asked++;

    const parsed = parseTriage(raw);
    const adjudication: Adjudication = parsed
      ? adjudicateTriage(parsed, facts)
      : { ok: false, reason: 'unparseable_output' };

    await recordProposal(ctx, {
      type: 'input_triage',
      subject: { type: 'claim_request', id: c.id },
      // The DESCRIPTION is hashed into the digest and then dropped, like every other proposer's facts.
      facts,
      // Kept whatever the verdict: a question that named a figure the claim does not carry is exactly what
      // you want to read back when asking why the pass rate moved after a model change.
      proposal: {
        verdict: parsed?.verdict ?? null,
        policyRuleId: parsed?.policyRuleId ?? null,
        reason: parsed?.reason ?? null,
      },
      adjudication,
      provider: cfg.provider,
      model: cfg.model,
    });

    if (!adjudication.ok) {
      // DISCARDED SILENTLY (§2.2). No screen ever says "the AI suggested something we could not verify" —
      // and here that matters twice over, because the reader would be the employee being questioned.
      out.rejected++;
      continue;
    }
    if (parsed!.verdict === VERDICT_OK) {
      out.cleared++;
      continue;
    }

    await withTenant(ctx, (tx) =>
      appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.triage-queried',
        // No userId on a sweep context. `agent` is the truth: nobody pressed send.
        actor: { type: 'agent' },
        subjectEmploymentId: c.employmentId,
        // The QUESTION travels on the event because the notification registry renders from the payload
        // and stores the result (ADR-0034). The rule id rides along so the notification can be traced
        // back to the catalogue entry that produced it.
        payload: { policyRuleId: parsed!.policyRuleId, reason: parsed!.reason },
      }),
    );
    out.queried++;
  }

  return out;
}
