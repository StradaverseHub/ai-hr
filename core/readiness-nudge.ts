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
 * **The model decides only HOW IT READS**, once per gap and audience per run, and its draft is adjudicated before use.
 *
 * ⚠️ **THE SHARED ACTION CATALOGUE GOVERNS ROUTING.** Nudging somebody about
 * something they cannot fix is worse than not nudging them: it trains them to ignore the channel, and the
 * record still does not get fixed. So the audience is derived from what the product ACTUALLY LETS EACH
 * PERSON DO, derived from the existing request declaration, tenant permissions and pending submissions.
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
import { agentReadinessSnapshot, GAP_BLOCKS, readinessSnapshot, type ReadinessGapId } from './record-readiness';
import { agentActor, agentHolds, agentSpecialistCurrentTx, agentStamp, isAgentContext } from './agent-principal';
import { loadReadinessActions } from './readiness-actions';
import { resolveEntitlementsTx } from './entitlements';
import { recordDecision, recordProposal } from './agent-proposal';
import { resolveActiveAiConfig } from './ai-config';
import {bindAiSpendTaskTx} from './ai-spend-task';
import { generateDraft } from '../lib/ai';
import {preparePrivateAiTask} from './ai-governance';
import type {GenerateArgs} from '../lib/ai/types';

/** The audience is resolved from current request permissions and pending submissions (ADR-0111). */
export type NudgeAudience = 'employee' | 'hr';

/**
 * The tenant switch. Default `false` — see the header: here there is no button, so this is the button.
 *
 * ⚠️ EXPORTED FOR CALLERS THAT NEED TO NAME IT (tests, docs) — but the `settingEnabled` call below passes
 * the STRING LITERAL, not this constant, and that duplication is deliberate.
 * `test/module-catalog-drift.test.ts` scans call sites for a literal key and asserts every one is
 * catalogued; a call through a variable is invisible to it, so "tidying" the literal away here would
 * quietly punch a hole in the guard that catches an uncatalogued key (which is a 500, not a disabled
 * feature — `getSetting` throws a bare Error for an unknown key).
 */
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

export const EMPLOYEE_NUDGE_TEMPLATE: Partial<Record<ReadinessGapId, string>> = {
  no_bank_account: NUDGE_TEMPLATE.no_bank_account,
  no_identity: 'Your record has no IC or passport. Request an identity correction from My Profile for HR approval.',
  no_tax_number: 'Your record has no tax number. Request a correction from Bank & Statutory in My Profile for HR approval.',
  no_epf_number: 'Your record has no EPF number. Request a correction from Bank & Statutory in My Profile for HR approval.',
  no_socso_number: 'Your record has no SOCSO number. Request a correction from Bank & Statutory in My Profile for HR approval.',
};

const fallbackBody = (gap: ReadinessGapId, audience: NudgeAudience) => audience === 'employee'
  ? EMPLOYEE_NUDGE_TEMPLATE[gap] ?? NUDGE_TEMPLATE[gap]
  : gap === 'no_bank_account' ? 'This employee has no bank account on file. Review the employee record to complete the payment details.'
    : NUDGE_TEMPLATE[gap];

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
 * Draft one body for one gap and audience. ONE call per gap/audience per run, not per person — the same message goes to
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
  // ADR-0151 §4.5: the agent principal is not admitted to model spend (no login, no allowance subject), so
  // it does not attempt a provider call at all. The fixed template is the reminder it sends.
  if (isAgentContext(ctx)) return fallbackBody(gap, audience);
  const cfg = await withTenant(ctx,async tx=>{const resolved=await resolveActiveAiConfig(tx,ctx,'readiness_reminders');return resolved?bindAiSpendTaskTx(tx,ctx,resolved,{kind:'readiness_template',gap,audience}):null;}).catch(()=>null);
  // No provider is not a failure — it is the ordinary state of a tenant that has not bought one, and the
  // deterministic body is a perfectly good chaser. Nothing is recorded, because nothing was proposed.
  if (!cfg) return fallbackBody(gap, audience);

  let draft = '';
  try {
    const task=await preparePrivateAiTask(cfg,'readiness_message_v1',async()=>({gap,audience}));
    try{
      if(task.operation!=='draft')throw Error('Protected reminder operation unavailable.');
      const selected:unknown=JSON.parse(await generateDraft(task.configuration,task.args as GenerateArgs));
      if(!selected||typeof selected!=='object'||Array.isArray(selected)||Object.keys(selected).join(',')!=='tone'||!['direct','supportive'].includes(String((selected as {tone:unknown}).tone)))throw Error('Protected reminder choice unavailable.');
      // Model-selected tone never becomes model-authored HR text. Both variants retain the native
      // missing-gap/action wording and the employee's requirement for human review.
      draft=fallbackBody(gap,audience);
      if((selected as {tone:string}).tone==='supportive')draft='Please '+draft.charAt(0).toLowerCase()+draft.slice(1);
    }finally{task.dispose();}
  } catch {
    // Provider down or refused. Same outcome as no provider: the template goes out.
    return fallbackBody(gap, audience);
  }

  const ok = nudgeIsFaithful(draft, gap) &&
    (audience !== 'employee' || (/approval/i.test(draft) && !/(without|no).{0,20}approval|already.{0,20}(fixed|approved)/i.test(draft)));
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
  return ok ? draft : fallbackBody(gap, audience);
}

export type NudgeSweepResult = {
  /** A relevant correction is already awaiting the existing approval workflow. */
  awaitingReview: number;
  /** Source facts or permissions changed before an effect could be committed. */
  changed: number;
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
async function settleOutcomes(ctx: SessionContext, openGapKeys: Set<string>, activeEmploymentIds: Set<string>): Promise<number> {
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
    // A leaver, invisible record or unsupported gap is not evidence that a reminder worked.
    if (!row.subjectId || !activeEmploymentIds.has(row.subjectId) || !Object.hasOwn(GAP_BLOCKS, row.gap)) continue;
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
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
  const empty: NudgeSweepResult = {
    awaitingReview: 0,
    changed: 0,
    sent: 0,
    cooled: 0,
    orphaned: 0,
    settled: 0,
    disabled: false,
    cappedOut: false,
  };
  // The literal, not NUDGE_SETTING_KEY — see that constant's note.
  if (!settingEnabled(ctx, 'notifications.readiness_nudge_enabled')) return { ...empty, disabled: true };
  // Under the agent principal it runs only behind an administrator's attributed switch-on.
  if (isAgentContext(ctx) && !agentHolds(ctx, 'readiness_reminders')) return { ...empty, disabled: true };

  // UNCAPPED, deliberately. `recordReadiness`'s default trims each gap to 25 names so a screen stays
  // readable; iterating that list would chase only the first 25 people per gap and report a clean run.
  // The blast-radius cap below is the ONLY thing that bounds this sweep, and it says so when it bites.
  const { view, activeEmploymentIds, actions } = await withTenant(ctx, async tx => {
    const snapshot = isAgentContext(ctx) ? await agentReadinessSnapshot(tx, Number.POSITIVE_INFINITY)
      : await readinessSnapshot(tx, Number.POSITIVE_INFINITY);
    return { ...snapshot, actions: await loadReadinessActions(tx, ctx, snapshot.activeEmploymentIds) };
  });
  const openGapKeys = new Set<string>();
  for (const g of view.gaps) for (const p of g.people) openGapKeys.add(`${p.employmentId}:${g.id}`);

  const settled = await settleOutcomes(ctx, openGapKeys, new Set(activeEmploymentIds));

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
  let awaitingReview = 0;
  let changed = 0;

  for (const gap of view.gaps) {
    // Drafted ONCE per gap, and only when this gap actually has somebody to nudge — a provider call for a
    // gap whose every subject is in cooldown is spend with no message at the end of it.
    const bodies = new Map<NudgeAudience, string>();

    for (const person of gap.people) {
      const action = actions.get(`${person.employmentId}:${gap.id}`);
      if (!action) { changed++; continue; }
      if (action.type === 'review_submission') { awaitingReview++; continue; }
      const audience = action.audience;
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

      if (!bodies.has(audience)) bodies.set(audience, await draftBody(ctx, gap.id, audience));
      const body = bodies.get(audience)!;

      const emitted = await withTenant(ctx, async (tx) => {
        // The event is the durable effect receipt. A best-effort proposal ledger cannot deduplicate it.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId}), hashtext(${person.employmentId + ':' + gap.id}))`);
        // Provider calls run outside the transaction. Re-read facts, submissions and the kill switch.
        const entitlements = await resolveEntitlementsTx(tx, ctx.tenantId);
        const fresh = { ...ctx, entitlements, entitlementsExempt: undefined };
        if (!settingEnabled(fresh, 'notifications.readiness_nudge_enabled')) return 'changed';
        // The switch-on this run relies on must still be the current one (switched off and on again ends it).
        if (isAgentContext(fresh) && !(await agentSpecialistCurrentTx(tx, fresh, 'readiness_reminders'))) return 'changed';
        const snapshot = isAgentContext(fresh) ? await agentReadinessSnapshot(tx, Number.POSITIVE_INFINITY, [person.employmentId])
          : await readinessSnapshot(tx, Number.POSITIVE_INFINITY, false, { employmentIds: [person.employmentId] });
        if (!snapshot.view.gaps.some(g => g.id === gap.id)) return 'changed';
        const nowAction = (await loadReadinessActions(tx, fresh, snapshot.activeEmploymentIds))
          .get(`${person.employmentId}:${gap.id}`);
        if (nowAction?.type !== action.type || nowAction.audience !== audience) return 'changed';
        const [alreadySent] = await tx.select({ id: schema.domainEvent.id }).from(schema.domainEvent)
          .where(and(eq(schema.domainEvent.eventType, 'readiness.nudge-raised'),
            eq(schema.domainEvent.subjectEmploymentId, person.employmentId),
            gte(schema.domainEvent.occurredAt, since),
            sql`${schema.domainEvent.payload} ->> 'gap' = ${gap.id}`)).limit(1);
        if (alreadySent) return 'cooled';
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'employment',
          aggregateId: person.employmentId,
          eventType: 'readiness.nudge-raised',
          // Nobody pressed send. Under the agent principal the actor is the principal, and the payload names
          // the administrator whose switch-on this reminder relies on (0672 refuses the event otherwise).
          actor: agentActor(ctx),
          subjectEmploymentId: person.employmentId,
          // The BODY travels on the event because the notification registry renders from the payload and
          // stores the result. `audience` is what the registry's recipient resolver branches on.
          payload: { gap: gap.id, audience, action: action.type, body, recipients, ...agentStamp(ctx, ['readiness_reminders']) },
        });
        return 'sent';
      });
      if (emitted === 'changed') { changed++; continue; }
      if (emitted === 'cooled') { cooled++; continue; }

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

  return { sent, cooled, orphaned, settled, disabled: false, cappedOut, awaitingReview, changed };
}
