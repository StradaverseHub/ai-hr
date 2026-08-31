/**
 * ADR-0084 §2.5 / §3 item 2 — THE NUDGE AGENT. The first thing in this product that contacts a person
 * without a human pressing send.
 *
 * ═══ WHY THIS IS THE HEADCOUNT ITEM ═══
 *
 * r234 gave the system perfect knowledge of who has an incomplete record. It changed nothing on its own:
 * a human still had to open the screen, read the list, and go and chase people. **Chasing people is where
 * payroll headcount actually goes** — not verifying runs, which is a minority of the hours (ADR-0083 §1).
 * This closes that loop, and it is deliberately ~90% deterministic. The model's contribution here is
 * narrow and bounded, and pretending otherwise would be the AI-decoration this whole ADR was written
 * against.
 *
 * ═══ THE DIVISION OF LABOUR (§2.5) ═══
 *
 * **Deterministic code decides WHO and WHETHER** — which gap, whose record, who can act on it, whether
 * the cooldown allows it, whether the tenant switched this on at all. None of that is a model's decision.
 * **The model decides only HOW IT READS**, once per gap per run, and its draft is adjudicated before use.
 *
 * ⚠️ **THE ROUTING TABLE BELOW IS THE MOST IMPORTANT THING IN THIS FILE.** Nudging somebody about
 * something they cannot fix is worse than not nudging them: it trains them to ignore the channel, and the
 * record still does not get fixed. So the audience is derived from what the product ACTUALLY LETS EACH
 * PERSON DO, read out of `app/me/actions.ts`, not from what would be convenient.
 *
 * ⚠️ **IT IS OFF BY DEFAULT AND THAT IS THE KILL SWITCH.** `notifications.readiness_nudge_enabled`
 * defaults to `false`. ADR-0083 §2.5's kill switch was deliberately deferred for the action layer because
 * every execution there is a human pressing a button — **here there is no button**, so the switch is
 * load-bearing and ships with the feature. A tenant that has not opted in sends nothing.
 */
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent } from '../db/events';
import * as schema from '../db/schema';
import { settingEnabled } from './entitlements';
import { hrAdminsForCompany } from './notifications';
import { recordReadiness, type ReadinessGapId } from './record-readiness';
import { recordDecision, recordProposal } from './agent-proposal';
import { resolveActiveAiConfig } from './ai-config';
import { generateDraft } from '../lib/ai';

/** Who can actually act on a gap. */
export type NudgeAudience = 'employee' | 'hr';

/**
 * WHICH GAPS THE PERSON THEMSELVES CAN FIX, read out of what the product actually offers.
 *
 * `app/me/actions.ts`'s `myRequestProfileChange` carries exactly four statutory-ish fields —
 * `bankName`, `bankAccountNo`, `taxCategory`, `numChildren` — plus three identity ones, and routes them
 * through an APPROVAL. Of the six readiness gaps, only the bank account has a self-service path.
 * **Everything else is HR's to key in**, so telling the employee about it would be telling somebody about
 * a screen they do not have.
 *
 * If ESS ever grows a field, this table moves with it — and it is the ONE thing to re-check when it does.
 */
export const NUDGE_AUDIENCE: Record<ReadinessGapId, NudgeAudience> = {
  // `/me` → Request a change → bank details. A real, reachable self-service path.
  no_bank_account: 'employee',
  // Tax/EPF/SOCSO numbers, identity documents and compensation are all admin-only writers.
  no_tax_number: 'hr',
  no_epf_number: 'hr',
  no_socso_number: 'hr',
  no_identity: 'hr',
  no_compensation: 'hr',
};

/** The tenant switch. Default `false` — see the header: here there is no button, so this is the button. */
export const NUDGE_SETTING_KEY = 'notifications.readiness_nudge_enabled';

/** One nudge per person per gap per fortnight. A chaser that arrives daily is a chaser people filter. */
export const NUDGE_COOLDOWN_DAYS = 14;

/**
 * How long a nudge is given before its outcome is judged. Longer than the cooldown ON PURPOSE: judging at
 * the cooldown would mark a nudge "ignored" at the same moment it becomes eligible to be sent again, so
 * every second nudge would score as a failure regardless of what anybody did.
 */
export const NUDGE_SETTLE_DAYS = 21;

/** Blast radius. A first run on a 3,000-person tenant must not become 3,000 messages in one night. */
export const MAX_NUDGES_PER_RUN = 100;

/** Longest body a nudge may carry. A chaser that needs scrolling is not a chaser. */
const MAX_BODY_CHARS = 240;

/**
 * The deterministic body for every gap — the FALLBACK, and the thing that guarantees the loop closes even
 * with no provider configured, a provider outage, or a draft that fails adjudication.
 *
 * English only, matching the notification registry's convention (`core/notifications.ts` — a body is
 * rendered once and STORED, so it cannot be re-rendered per reader's locale without changing the engine;
 * see the ADR as-built note).
 */
export const NUDGE_TEMPLATE: Record<ReadinessGapId, string> = {
  no_bank_account:
    'We have no bank account on file for you, so your pay cannot be transferred. Add it from your profile and it goes to HR for approval.',
  no_tax_number: 'This employee has no tax number on file, so PCB cannot be filed against them.',
  no_epf_number: 'This employee has no EPF number on file, so the KWSP contribution file cannot name them.',
  no_socso_number: 'This employee has no SOCSO number on file, so the PERKESO file cannot name them.',
  no_identity: 'This employee has neither an IC nor a passport on file, so they cannot appear on any statutory return.',
  no_compensation: 'This employee has no salary record, so payroll cannot compute anything for them.',
};

/** A word the body must contain for the gap it is about — the cheap half of adjudication. */
const REQUIRED_WORD: Record<ReadinessGapId, string> = {
  no_bank_account: 'bank',
  no_tax_number: 'tax',
  no_epf_number: 'epf',
  no_socso_number: 'socso',
  no_identity: 'ic',
  no_compensation: 'salary',
};

/**
 * ADR-0084 §2.4 — THE ADJUDICATOR for a drafted nudge body, and a direct descendant of
 * `narrationIsFaithful`.
 *
 * ⚠️ **NO DIGITS AT ALL, ANYWHERE.** Not "digits that match the facts" — none. A nudge carries no figures
 * by design, so any number in one is necessarily invented, and there is nothing to check it against. This
 * is the strongest form the faithfulness check can take and the cheapest to be sure of.
 *
 * The rest are shape checks: it must be about the gap it claims to be about, it must fit on a bell
 * notification, and it must not smuggle in a placeholder or a link the engine never resolves.
 */
export function nudgeIsFaithful(body: string, gap: ReadinessGapId): boolean {
  const b = body.trim();
  if (b.length === 0 || b.length > MAX_BODY_CHARS) return false;
  if (/\d/.test(b)) return false;
  // An unresolved template placeholder or a hand-written URL — neither survives being stored verbatim.
  if (/[{}<>]|https?:\/\/|@/.test(b)) return false;
  return b.toLowerCase().includes(REQUIRED_WORD[gap]);
}

const SYSTEM = [
  'You write one short internal reminder for an HR system. Rules, all absolute:',
  'Never write any digit or number. Never invent a name, a date or an amount.',
  'One or two sentences, under 240 characters. Plain, warm, direct. No greeting, no sign-off.',
  'Say what is missing and what it stops. Output the sentence only.',
].join(' ');

/**
 * Draft one body for one gap. ONE call per gap per run, not per person — the same message goes to
 * everyone with that gap, which is cheaper, reviewable, and fairer than personalising a chaser.
 *
 * Returns the template on ANY failure (no provider, outage, unfaithful draft), so the caller cannot end
 * up with nothing to send. The ledger row records which of those happened.
 */
async function draftBody(
  ctx: SessionContext,
  gap: ReadinessGapId,
  audience: NudgeAudience,
): Promise<string> {
  const cfg = await withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx)).catch(() => null);
  // No provider is not a failure — it is the ordinary state of a tenant that has not bought one, and the
  // deterministic body is a perfectly good chaser. Nothing is recorded, because nothing was proposed.
  if (!cfg) return NUDGE_TEMPLATE[gap];

  let draft = '';
  try {
    draft = (
      await generateDraft(cfg, {
        system: SYSTEM,
        prompt:
          `Missing from the record: ${gap.replace(/_/g, ' ')}. ` +
          `The reader is ${audience === 'employee' ? 'the employee themselves' : 'an HR administrator'}.`,
        maxTokens: 160,
      })
    ).trim();
  } catch {
    // Provider down or refused. Same outcome as no provider: the template goes out.
    return NUDGE_TEMPLATE[gap];
  }

  const ok = nudgeIsFaithful(draft, gap);
  await recordProposal(ctx, {
    type: 'readiness_nudge',
    facts: { gap, audience },
    // The draft is kept either way: an unfaithful one is exactly what you want to read back when asking
    // why a model keeps putting numbers in a message that must not contain any.
    proposal: { gap, audience, body: draft },
    adjudication: ok ? { ok: true } : { ok: false, reason: 'unfaithful_nudge_body' },
    provider: cfg.provider,
    model: cfg.model,
  });
  return ok ? draft : NUDGE_TEMPLATE[gap];
}

export type NudgeSweepResult = {
  /** Nudges actually raised. */
  sent: number;
  /** In cooldown, so deliberately not raised again. */
  cooled: number;
  /** Known gaps with nobody to tell — recorded, not sent. See the sweep body. */
  orphaned: number;
  /** Earlier nudges whose outcome this run judged. */
  settled: number;
  /** True when the tenant has not switched nudging on. Everything else is zero. */
  disabled: boolean;
  /** True when the run stopped at MAX_NUDGES_PER_RUN with work left. */
  cappedOut: boolean;
};

/**
 * Judge the outcome of nudges old enough to have been acted on (§2.5, "effectiveness is measured, not
 * assumed").
 *
 * ⚠️ **THIS IS THE ONLY PROPOSAL TYPE IN THE PRODUCT WITH A REAL AGREEMENT RATE**, and it is worth saying
 * why. `close_fixed_upstream`'s is structurally 1.0 because an operator who does not press the button
 * leaves no trace (r236). A nudge is different: the human's verdict is observable in the record itself —
 * **the gap either closed or it did not.** That makes this the first place the ledger measures something
 * that could come back unflattering, which is the whole point of building it.
 */
async function settleOutcomes(ctx: SessionContext, openGapKeys: Set<string>): Promise<number> {
  const cutoff = new Date(Date.now() - NUDGE_SETTLE_DAYS * 24 * 60 * 60 * 1000);
  const due = await withTenant(ctx, (tx) =>
    tx
      .select({
        id: schema.agentProposal.id,
        subjectId: schema.agentProposal.subjectId,
        gap: sql<string>`${schema.agentProposal.proposal} ->> 'gap'`,
      })
      .from(schema.agentProposal)
      .where(
        and(
          eq(schema.agentProposal.proposalType, 'readiness_fix'),
          eq(schema.agentProposal.adjudication, 'accepted'),
          isNull(schema.agentProposal.decision),
          // `lt`, not a raw sql`` fragment: the template form binds the Date as an untyped parameter and
          // the driver refuses it ("Received an instance of Date"). The typed operator knows the column.
          lt(schema.agentProposal.proposedAt, cutoff),
        ),
      )
      .limit(500),
  );

  let settled = 0;
  for (const row of due) {
    // Outside the transaction above — `recordDecision` opens its own (agent-proposal property 2).
    const stillOpen = openGapKeys.has(`${row.subjectId}:${row.gap}`);
    await recordDecision(ctx, { proposalId: row.id, decision: stillOpen ? 'declined' : 'approved' });
    settled++;
  }
  return settled;
}

/**
 * One tenant's nudge pass.
 *
 * Ordering matters: outcomes are settled FIRST, against the readiness read this run already needs, so a
 * gap fixed since the last run is credited before anything new is raised.
 */
export async function sweepReadinessNudges(ctx: SessionContext): Promise<NudgeSweepResult> {
  const empty: NudgeSweepResult = {
    sent: 0,
    cooled: 0,
    orphaned: 0,
    settled: 0,
    disabled: false,
    cappedOut: false,
  };
  if (!settingEnabled(ctx, NUDGE_SETTING_KEY)) return { ...empty, disabled: true };

  // UNCAPPED, deliberately. `recordReadiness`'s default trims each gap to 25 names so a screen stays
  // readable; iterating that list would chase only the first 25 people per gap and report a clean run.
  // The blast-radius cap below is the ONLY thing that bounds this sweep, and it says so when it bites.
  const view = await recordReadiness(ctx, { peopleLimit: Number.POSITIVE_INFINITY });
  const openGapKeys = new Set<string>();
  for (const g of view.gaps) for (const p of g.people) openGapKeys.add(`${p.employmentId}:${g.id}`);

  const settled = await settleOutcomes(ctx, openGapKeys);

  // Who has been nudged recently, for which gap. ONE query rather than one per person: this has to open
  // for a 3,000-person tenant.
  const since = new Date(Date.now() - NUDGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const recent = await withTenant(ctx, (tx) =>
    tx
      .select({
        subjectId: schema.agentProposal.subjectId,
        gap: sql<string>`${schema.agentProposal.proposal} ->> 'gap'`,
      })
      .from(schema.agentProposal)
      .where(
        and(
          eq(schema.agentProposal.proposalType, 'readiness_fix'),
          gte(schema.agentProposal.proposedAt, since),
        ),
      ),
  );
  const cooling = new Set(recent.map((r) => `${r.subjectId}:${r.gap}`));

  let sent = 0;
  let cooled = 0;
  let orphaned = 0;
  let cappedOut = false;

  for (const gap of view.gaps) {
    const audience = NUDGE_AUDIENCE[gap.id];
    // Drafted ONCE per gap, and only when this gap actually has somebody to nudge — a provider call for a
    // gap whose every subject is in cooldown is spend with no message at the end of it.
    let body: string | null = null;

    for (const person of gap.people) {
      if (sent >= MAX_NUDGES_PER_RUN) {
        cappedOut = true;
        break;
      }
      if (cooling.has(`${person.employmentId}:${gap.id}`)) {
        cooled++;
        continue;
      }

      // WHO can act on this. For an HR gap that is the company's admins; resolving it per person rather
      // than per company because an employment's company is the thing that decides, and the readiness
      // view is already grouped by gap rather than by company.
      const recipients =
        audience === 'employee'
          ? [person.employmentId]
          : await withTenant(ctx, (tx) => hrAdminsForCompany(tx, person.employmentId));

      if (recipients.length === 0) {
        // ⚠️ A KNOWN GAP WITH NOBODY TO TELL. Recorded as a REJECTED proposal rather than skipped in
        // silence: "this company has no HR admin to chase" is a real operational fact that is otherwise
        // invisible, and the adjudication-pass rate for this type is exactly the measure of it.
        await recordProposal(ctx, {
          type: 'readiness_fix',
          subject: { type: 'employment', id: person.employmentId },
          facts: { gap: gap.id, audience },
          proposal: { gap: gap.id, audience },
          adjudication: { ok: false, reason: 'no_recipient' },
        });
        orphaned++;
        continue;
      }

      if (body === null) body = await draftBody(ctx, gap.id, audience);

      await withTenant(ctx, (tx) =>
        appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'employment',
          aggregateId: person.employmentId,
          eventType: 'readiness.nudge-raised',
          // No userId on a sweep context, so `actorOf` records this as `system` — which is the truth:
          // nobody pressed send.
          actor: { type: 'agent' },
          subjectEmploymentId: person.employmentId,
          // The BODY travels on the event because the notification registry renders from the payload and
          // stores the result. `audience` is what the registry's recipient resolver branches on.
          payload: { gap: gap.id, audience, body, recipients },
        }),
      );

      await recordProposal(ctx, {
        type: 'readiness_fix',
        subject: { type: 'employment', id: person.employmentId },
        facts: { gap: gap.id, audience, recipientCount: recipients.length },
        proposal: { gap: gap.id, audience },
        // The deterministic precondition held: this person has this gap, and somebody can act on it.
        adjudication: { ok: true },
      });
      sent++;
    }
    if (cappedOut) break;
  }

  return { sent, cooled, orphaned, settled, disabled: false, cappedOut };
}
