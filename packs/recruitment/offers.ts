/**
 * Recruitment slice 3 — offers with an ordered approval flow, and the hire hand-off. Reached from outside the pack
 * ONLY through ./service.
 *
 *   - One current offer per application. Its details are values of the company offer-field set. Money is an amount
 *     and a currency a PERSON enters, stored as a decimal; nothing here computes pay, and no model is involved.
 *   - Private values are visible only to recruitment administrators, the job's recruiter and the offer's creator
 *     (4403 row security); everyone else never receives them, so a screen cannot leak them.
 *   - Approval: the company flow is copied into a round at submission; approvers act in order, only on their own
 *     pending step, never on an offer they created; a rejection returns the offer to Draft with the comment; Withdraw
 *     is available while pending; a change to a field that needs approval re-runs approval from step 1.
 *   - "Mark as sent" and the candidate's decision are recorded by a person. Nothing is emailed or texted.
 *   - Hire hand-off: the server reads the pre-fill from the application; the employee draft is created by the
 *     existing personnel writer when HR saves, and only then linked here. Recruitment never creates a person,
 *     employee or employment.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { RecruitmentError, isUuid, planMoveForward, moveEvent, rejectEvent, type ApplicationState } from './model';
import {
  OFFER_DECLINED_REASON, OFFER_FIELD_TYPES, OFFER_SEND_CHANNELS, approvalFieldsChanged, approvalSteps, decideApproval, hireHandoffEligible,
  offerExpiresOn, offerLabel, startApproval, validateOfferValues, withdrawApproval,
  type ApprovalStepView, type CandidateDecision, type OfferFieldDef, type OfferFieldType, type OfferLabel, type OfferStatus, type OfferValue,
  type OfferValueInput,
} from './hiring-model';
import {
  recruitmentApplication, recruitmentApplicationEvent, recruitmentApprovalStep, recruitmentArchiveReason, recruitmentCompanySetting, recruitmentHireHandoff,
  recruitmentOffer, recruitmentOfferApproval, recruitmentOfferField, recruitmentOfferValue,
} from './schema';
import { actorId, assertCompanyTx, assertJobLevelTx, assertNoReviewMarkTx, ensureRecruitmentDefaultsTx, jobLevelTx, processStagesTx, reviewRefusal, userLabelsTx } from './data';
import { applicationRowTx, companySettingsTx } from './interviews';

const offerEvent = (tx: Tx, s: SessionContext, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-offer', aggregateId, eventType, actor: actorOf(s), payload });

export async function offerFieldsTx(tx: Tx, companyId: string): Promise<OfferFieldDef[]> {
  const rows = await tx.select().from(recruitmentOfferField).where(eq(recruitmentOfferField.companyId, companyId))
    .orderBy(asc(recruitmentOfferField.position), asc(recruitmentOfferField.label));
  return rows.map((f) => ({ id: f.id, label: f.label, type: f.fieldType, choices: f.choices, required: f.required, needsApproval: f.needsApproval, private: f.private, enabled: f.enabled }));
}

type ValueRow = typeof recruitmentOfferValue.$inferSelect;
const toValue = (r: ValueRow): OfferValue =>
  r.valueAmount != null ? { kind: 'money', amount: r.valueAmount, currency: r.currency ?? '' }
    : r.valueNumber != null ? { kind: 'number', number: r.valueNumber }
      : r.valueDate != null ? { kind: 'date', date: r.valueDate } : { kind: 'text', text: r.valueText ?? '' };
const columns = (v: OfferValue) => ({
  valueText: v.kind === 'text' ? v.text : null, valueNumber: v.kind === 'number' ? v.number : null, valueDate: v.kind === 'date' ? v.date : null,
  valueAmount: v.kind === 'money' ? v.amount : null, currency: v.kind === 'money' ? v.currency : null,
});

/** Values of the offer that row security lets the caller read (private ones only for those allowed). */
async function visibleValuesTx(tx: Tx, offerId: string): Promise<Map<string, OfferValue>> {
  const rows = await tx.select().from(recruitmentOfferValue).where(eq(recruitmentOfferValue.offerId, offerId));
  return new Map(rows.map((r) => [r.fieldId, toValue(r)]));
}
/** May the caller see (and therefore write) private values of this offer? The same predicate the 4403 policy uses. */
async function seesPrivateTx(tx: Tx, companyId: string, jobId: string, offerId: string | null): Promise<boolean> {
  const [row] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_recruitment_for(${companyId}::uuid)
    or app.recruitment_has_job_role(${jobId}::uuid, array['recruiter'])
    or ${offerId ? sql`exists (select 1 from recruitment_offer o where o.id = ${offerId}::uuid and o.created_by_user_id = app.current_user_id())` : sql`true`} as ok`);
  return row?.ok === true;
}

async function decisionsTx(tx: Tx, offerId: string, round: number) {
  return tx.select().from(recruitmentOfferApproval)
    .where(and(eq(recruitmentOfferApproval.offerId, offerId), eq(recruitmentOfferApproval.round, round))).orderBy(asc(recruitmentOfferApproval.position));
}
const roundOf = (o: { approverUserIds: string[]; pendingPosition: number | null }) => ({ approvers: o.approverUserIds, pendingPosition: o.pendingPosition ?? null });
export async function approvalFlowTx(tx: Tx, companyId: string, kind: 'offer' | 'requisition'): Promise<string[]> {
  const rows = await tx.select({ approver: recruitmentApprovalStep.approverUserId }).from(recruitmentApprovalStep)
    .where(and(eq(recruitmentApprovalStep.companyId, companyId), eq(recruitmentApprovalStep.flowKind, kind))).orderBy(asc(recruitmentApprovalStep.position));
  return rows.map((r) => r.approver);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────

export type OfferView = {
  applicationId: string; candidateName: string; jobTitle: string; companyId: string; applicationState: ApplicationState;
  offer: null | {
    id: string; status: OfferStatus; label: OfferLabel; round: number; lastRejectionComment: string | null; createdBy: string | null; isCreator: boolean;
    sentAt: string | null; sentChannel: string | null; expiresOn: string | null; decision: CandidateDecision; decidedAt: string | null;
  };
  fields: (OfferFieldDef & { value: OfferValue | null; hidden: boolean })[];
  steps: { position: number; approverName: string | null; state: ApprovalStepView['state']; comment: string | null; actedAt: string | null; isViewer: boolean }[];
  can: { edit: boolean; submit: boolean; withdraw: boolean; decide: boolean; markSent: boolean; recordDecision: boolean };
  validDays: number;
};

/** The application's Offer tab. Readers: the job's reviewers, administrators, the offer's creator and its approvers. */
export async function applicationOffer(s: SessionContext, applicationId: string): Promise<OfferView> {
  const today = todayInKualaLumpur();
  return withRecruitmentTenant(s, async (tx) => {
    const app = await applicationRowTx(tx, s, applicationId);
    const access = await jobLevelTx(tx, app.company_id, app.job_id, app.id);
    const [offer] = await tx.select().from(recruitmentOffer).where(eq(recruitmentOffer.applicationId, app.id));
    if (!access.review && !offer) throw new RecruitmentError('not_found');
    const fields = (await offerFieldsTx(tx, app.company_id)).filter((f) => f.enabled);
    const values = offer ? await visibleValuesTx(tx, offer.id) : new Map<string, OfferValue>();
    const seesPrivate = await seesPrivateTx(tx, app.company_id, app.job_id, offer?.id ?? null);
    const labels = await userLabelsTx(tx, app.company_id);
    const decisions = offer && offer.approvalRound > 0 ? await decisionsTx(tx, offer.id, offer.approvalRound) : [];
    const steps = offer ? approvalSteps(roundOf(offer), decisions) : [];
    const settings = await companySettingsTx(tx, app.company_id);
    const sentOn = offer?.sentAt ? todayInKualaLumpur(offer.sentAt) : null;
    const open = !!offer && offer.candidateDecision === 'pending';
    const myPending = steps.some((st) => st.state === 'pending' && st.approverUserId === s.userId);
    return {
      applicationId: app.id, candidateName: app.candidate_name, jobTitle: app.job_title, companyId: app.company_id, applicationState: app.state,
      offer: offer ? {
        id: offer.id, status: offer.status, round: offer.approvalRound, lastRejectionComment: offer.lastRejectionComment ?? null,
        label: offerLabel({ status: offer.status, sentOnKl: sentOn, validDays: offer.validDays, decision: offer.candidateDecision }, today),
        createdBy: labels.get(offer.createdByUserId)?.name ?? null, isCreator: offer.createdByUserId === s.userId,
        sentAt: offer.sentAt?.toISOString() ?? null, sentChannel: offer.sentChannel ?? null,
        expiresOn: sentOn && offer.validDays ? offerExpiresOn(sentOn, offer.validDays) : null,
        decision: offer.candidateDecision, decidedAt: offer.decidedAt?.toISOString() ?? null,
      } : null,
      fields: fields.map((f) => ({ ...f, value: values.get(f.id) ?? null, hidden: f.private && !seesPrivate })),
      steps: steps.map((st) => {
        const d = decisions.find((x) => x.position === st.position);
        return { position: st.position, approverName: labels.get(st.approverUserId)?.name ?? null, state: st.state, comment: d?.comment ?? null, actedAt: d?.actedAt.toISOString() ?? null, isViewer: st.approverUserId === s.userId };
      }),
      can: {
        edit: access.operate && app.state === 'active' && (!offer || open),
        submit: access.operate && !!offer && offer.status === 'draft' && open,
        withdraw: access.operate && !!offer && offer.status === 'pending',
        decide: myPending && offer?.status === 'pending' && offer.createdByUserId !== s.userId,
        markSent: access.operate && !!offer && offer.status === 'approved' && !offer.sentAt && open,
        recordDecision: access.operate && !!offer && !!offer.sentAt && open,
      },
      validDays: settings.offerValidDays,
    };
  });
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────────────

async function lockOfferTx(tx: Tx, s: SessionContext, offerId: unknown) {
  if (!isUuid(offerId)) throw new RecruitmentError('not_found');
  const [offer] = await tx.select().from(recruitmentOffer).where(and(eq(recruitmentOffer.id, offerId), eq(recruitmentOffer.tenantId, s.tenantId))).for('update');
  if (!offer) throw new RecruitmentError('not_found');
  return offer;
}

/** A new approval round from the company flow (step 1 pending), or 'approved' at once when the flow is empty. */
async function startRoundTx(tx: Tx, offer: typeof recruitmentOffer.$inferSelect, user: string): Promise<OfferStatus> {
  const round = startApproval(await approvalFlowTx(tx, offer.companyId, 'offer'), offer.createdByUserId);
  if (round.pendingPosition == null) {
    await tx.update(recruitmentOffer).set({ status: 'approved', approverUserIds: [], pendingPosition: null, updatedByUserId: user }).where(eq(recruitmentOffer.id, offer.id))
      .catch(reviewRefusal);
    return 'approved';
  }
  await tx.update(recruitmentOffer).set({
    status: 'pending', approvalRound: offer.approvalRound + 1, approverUserIds: round.approvers, pendingPosition: 1, updatedByUserId: user,
  }).where(eq(recruitmentOffer.id, offer.id)).catch(reviewRefusal);
  return 'pending';
}

/**
 * Create the offer (as a Draft) or change its values. Only the job's operators. The caller writes only the fields it
 * may see: a private field the caller cannot see keeps its stored value. After approval, a change to a field that
 * needs approval re-runs approval from step 1; a sent offer that changes is re-issued (it must be marked sent again).
 */
export async function saveOffer(s: SessionContext, applicationId: unknown, input: OfferValueInput): Promise<{ id: string; reapproval: boolean }> {
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const app = await applicationRowTx(tx, s, applicationId);
    await assertJobLevelTx(tx, app.company_id, app.job_id, 'operate', app.id);
    if (app.state !== 'active') throw new RecruitmentError('application_closed');
    let [offer] = await tx.select().from(recruitmentOffer).where(eq(recruitmentOffer.applicationId, app.id)).for('update');
    if (offer && offer.candidateDecision !== 'pending') throw new RecruitmentError('offer_closed');
    // Slice 13: no offer for an application that needs an administrator's review (4413 refuses the insert too).
    if (!offer) await assertNoReviewMarkTx(tx, app.id);
    const allFields = await offerFieldsTx(tx, app.company_id);
    const seesPrivate = await seesPrivateTx(tx, app.company_id, app.job_id, offer?.id ?? null);
    const writable = allFields.filter((f) => f.enabled && (!f.private || seesPrivate));
    const valid = validateOfferValues(writable, input);
    if (!valid.ok) throw new RecruitmentError(valid.code, valid.fields);
    const created = !offer;
    if (!offer) {
      [offer] = await tx.insert(recruitmentOffer).values({
        tenantId: s.tenantId, companyId: app.company_id, jobId: app.job_id, applicationId: app.id, createdByUserId: user, updatedByUserId: user,
      }).returning().catch(reviewRefusal);
    }
    const before = await visibleValuesTx(tx, offer.id);
    for (const f of writable) {
      const next = valid.values.get(f.id);
      const prior = before.get(f.id);
      if (next && JSON.stringify(next) === JSON.stringify(prior)) continue;
      if (!next) {
        if (prior) await tx.delete(recruitmentOfferValue).where(and(eq(recruitmentOfferValue.offerId, offer.id), eq(recruitmentOfferValue.fieldId, f.id)));
        continue;
      }
      if (prior) await tx.update(recruitmentOfferValue).set({ ...columns(next), updatedByUserId: user }).where(and(eq(recruitmentOfferValue.offerId, offer.id), eq(recruitmentOfferValue.fieldId, f.id)));
      else await tx.insert(recruitmentOfferValue).values({ tenantId: s.tenantId, companyId: app.company_id, jobId: app.job_id, offerId: offer.id, fieldId: f.id, ...columns(next), updatedByUserId: user });
    }
    const after = new Map(before);
    for (const f of writable) { const v = valid.values.get(f.id); if (v) after.set(f.id, v); else after.delete(f.id); }
    const changed = writable.some((f) => JSON.stringify(before.get(f.id) ?? null) !== JSON.stringify(after.get(f.id) ?? null));
    const reapproval = !created && offer.status !== 'draft' && approvalFieldsChanged(writable, before, after);
    if (reapproval) {
      // Reinitiate: the current round ends and approval runs again from step 1; a sent offer must be sent again.
      await tx.update(recruitmentOffer).set({ status: 'draft', pendingPosition: null, sentAt: null, sentChannel: null, sentByUserId: null, validDays: null, updatedByUserId: user })
        .where(eq(recruitmentOffer.id, offer.id));
      await startRoundTx(tx, offer, user);
    } else if (changed && offer.sentAt) {
      await tx.update(recruitmentOffer).set({ sentAt: null, sentChannel: null, sentByUserId: null, validDays: null, updatedByUserId: user }).where(eq(recruitmentOffer.id, offer.id));
    } else if (changed) {
      await tx.update(recruitmentOffer).set({ updatedByUserId: user }).where(eq(recruitmentOffer.id, offer.id));
    }
    // The payload names which fields changed, never their values (a value may be private).
    await offerEvent(tx, s, offer.id, created ? 'recruitment-offer.created' : 'recruitment-offer.updated', {
      companyId: app.company_id, applicationId: app.id, fields: writable.filter((f) => JSON.stringify(before.get(f.id) ?? null) !== JSON.stringify(after.get(f.id) ?? null)).map((f) => f.id), reapproval,
    });
    return { id: offer.id, reapproval };
  });
}

/** Submit a Draft: required values must be present; approval starts at step 1 (an empty flow approves at once). */
export async function submitOffer(s: SessionContext, offerId: unknown): Promise<OfferStatus> {
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const offer = await lockOfferTx(tx, s, offerId);
    await assertJobLevelTx(tx, offer.companyId, offer.jobId, 'operate', offer.applicationId);
    if (offer.candidateDecision !== 'pending') throw new RecruitmentError('offer_closed');
    if (offer.status !== 'draft') throw new RecruitmentError('offer_state');
    await assertNoReviewMarkTx(tx, offer.applicationId);
    const fields = (await offerFieldsTx(tx, offer.companyId)).filter((f) => f.enabled);
    // Required values are checked as STORED. A private value the submitter may not see is invisible to them under
    // row security too, so it is not counted as missing here; whoever entered it (recruiter or creator) saw it.
    const seesPrivate = await seesPrivateTx(tx, offer.companyId, offer.jobId, offer.id);
    const values = await visibleValuesTx(tx, offer.id);
    const missing = fields.filter((f) => f.required && (!f.private || seesPrivate) && !values.has(f.id)).map((f) => f.id);
    if (missing.length) throw new RecruitmentError('missing_fields', missing);
    await tx.update(recruitmentOffer).set({ lastRejectionComment: null, updatedByUserId: user }).where(eq(recruitmentOffer.id, offer.id));
    const status = await startRoundTx(tx, offer, user);
    await offerEvent(tx, s, offer.id, 'recruitment-offer.submitted', { companyId: offer.companyId, applicationId: offer.applicationId, status });
    return status;
  });
}

/** Withdraw while pending: open steps are withdrawn and the offer returns to Draft. */
export async function withdrawOffer(s: SessionContext, offerId: unknown): Promise<void> {
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const offer = await lockOfferTx(tx, s, offerId);
    await assertJobLevelTx(tx, offer.companyId, offer.jobId, 'operate', offer.applicationId);
    if (offer.status !== 'pending') throw new RecruitmentError('offer_state');
    withdrawApproval(roundOf(offer));
    await tx.update(recruitmentOffer).set({ status: 'draft', pendingPosition: null, updatedByUserId: user }).where(eq(recruitmentOffer.id, offer.id));
    await offerEvent(tx, s, offer.id, 'recruitment-offer.withdrawn', { companyId: offer.companyId, applicationId: offer.applicationId, round: offer.approvalRound });
  });
}

/**
 * An approver's decision on their OWN pending step. Approve: the next step becomes pending, or the offer is
 * approved after the last. Reject (a comment is required): the offer returns to Draft with the comment.
 */
export async function decideOffer(s: SessionContext, offerId: unknown, decision: unknown, comment?: unknown): Promise<'pending' | 'approved' | 'rejected'> {
  if (decision !== 'approve' && decision !== 'reject') throw new RecruitmentError('invalid_input', ['decision']);
  const note = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 2000) : null;
  if (decision === 'reject' && !note) throw new RecruitmentError('missing_fields', ['comment']);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    // Read first (an approver of the round may read it) so an out-of-turn approver is told so; then lock it, which
    // only the pending step's approver — or an operator — can.
    if (!isUuid(offerId)) throw new RecruitmentError('not_found');
    const [seen] = await tx.select().from(recruitmentOffer).where(and(eq(recruitmentOffer.id, offerId), eq(recruitmentOffer.tenantId, s.tenantId)));
    if (!seen) throw new RecruitmentError('not_found');
    if (seen.status !== 'pending') throw new RecruitmentError('offer_state');
    decideApproval(roundOf(seen), user, seen.createdByUserId, decision);
    const offer = await lockOfferTx(tx, s, offerId);
    if (offer.status !== 'pending') throw new RecruitmentError('offer_state');
    const plan = decideApproval(roundOf(offer), user, offer.createdByUserId, decision);
    // The decision is logged first (by its own approver); the offer then moves on, and the 4403 guard checks both.
    await tx.insert(recruitmentOfferApproval).values({
      tenantId: s.tenantId, companyId: offer.companyId, jobId: offer.jobId, offerId: offer.id, round: offer.approvalRound, position: plan.position,
      approverUserId: user, decision: plan.decision, comment: note,
    });
    await tx.update(recruitmentOffer).set({
      status: plan.outcome === 'approved' ? 'approved' : plan.outcome === 'rejected' ? 'draft' : 'pending', pendingPosition: plan.pendingPosition,
      lastRejectionComment: plan.outcome === 'rejected' ? note : offer.lastRejectionComment, updatedByUserId: user,
    }).where(eq(recruitmentOffer.id, offer.id)).catch(reviewRefusal);
    await offerEvent(tx, s, offer.id, decision === 'approve' ? 'recruitment-offer.step-approved' : 'recruitment-offer.step-rejected', {
      companyId: offer.companyId, applicationId: offer.applicationId, round: offer.approvalRound, position: plan.position, outcome: plan.outcome,
    });
    return plan.outcome;
  });
}

/** "Mark as sent": a person records the channel, the time and themself. Only an approved offer. Nothing is sent. */
export async function markOfferSent(s: SessionContext, offerId: unknown, channel: unknown): Promise<void> {
  if (!(OFFER_SEND_CHANNELS as readonly unknown[]).includes(channel)) throw new RecruitmentError('invalid_input', ['channel']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const offer = await lockOfferTx(tx, s, offerId);
    await assertJobLevelTx(tx, offer.companyId, offer.jobId, 'operate', offer.applicationId);
    if (offer.candidateDecision !== 'pending') throw new RecruitmentError('offer_closed');
    if (offer.status !== 'approved' || offer.sentAt) throw new RecruitmentError('offer_state');
    await assertNoReviewMarkTx(tx, offer.applicationId);
    const settings = await companySettingsTx(tx, offer.companyId);
    await tx.update(recruitmentOffer).set({ sentAt: sql`now()`, sentChannel: channel as 'email', sentByUserId: user, validDays: settings.offerValidDays, updatedByUserId: user })
      .where(eq(recruitmentOffer.id, offer.id)).catch(reviewRefusal);
    await offerEvent(tx, s, offer.id, 'recruitment-offer.marked-sent', { companyId: offer.companyId, applicationId: offer.applicationId, channel, validDays: settings.offerValidDays });
  });
}

/**
 * The candidate's decision, recorded by a person. With the company automation on (off by default): Accepted moves
 * the application to its next stage; Declined archives it to the talent pool with "Candidate declined the offer".
 */
export async function recordOfferDecision(s: SessionContext, offerId: unknown, decision: unknown): Promise<{ moved: boolean; archived: boolean }> {
  if (decision !== 'accepted' && decision !== 'declined') throw new RecruitmentError('invalid_input', ['decision']);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const offer = await lockOfferTx(tx, s, offerId);
    await assertJobLevelTx(tx, offer.companyId, offer.jobId, 'operate', offer.applicationId);
    if (offer.candidateDecision !== 'pending') throw new RecruitmentError('offer_closed');
    if (!offer.sentAt) throw new RecruitmentError('offer_state');
    // Slice 13: while the application needs an administrator's review, an acceptance is held; a decline can be recorded (and the
    // optional automation may archive the application — rejecting stays possible), but nothing moves the application forward.
    if (decision === 'accepted') await assertNoReviewMarkTx(tx, offer.applicationId);
    await tx.update(recruitmentOffer).set({ candidateDecision: decision, decidedAt: sql`now()`, decidedByUserId: user, updatedByUserId: user }).where(eq(recruitmentOffer.id, offer.id))
      .catch(reviewRefusal);
    const settings = await companySettingsTx(tx, offer.companyId);
    let moved = false; let archived = false;
    const [app] = await tx.select().from(recruitmentApplication).where(eq(recruitmentApplication.id, offer.applicationId)).for('update');
    if (app?.state === 'active' && decision === 'accepted' && settings.offerAcceptMovesForward) {
      const [job] = await tx.execute<{ process_id: string }>(sql`select process_id from recruitment_job_opening where id = ${offer.jobId}::uuid`);
      const plan = planMoveForward(await processStagesTx(tx, job.process_id), app.currentStageId);
      if (plan.kind === 'hired') await tx.update(recruitmentApplication).set({ state: 'hired', updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentApplication.id, app.id)).catch(reviewRefusal);
      else await tx.update(recruitmentApplication).set({ currentStageId: plan.to, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentApplication.id, app.id)).catch(reviewRefusal);
      await tx.insert(recruitmentApplicationEvent).values({ tenantId: s.tenantId, companyId: app.companyId, applicationId: app.id, actorUserId: user, ...moveEvent(plan) });
      moved = true;
    }
    if (app?.state === 'active' && decision === 'declined' && settings.offerDeclineArchives) {
      const [reason] = await tx.select({ id: recruitmentArchiveReason.id }).from(recruitmentArchiveReason)
        .where(and(eq(recruitmentArchiveReason.companyId, offer.companyId), eq(recruitmentArchiveReason.seedKey, OFFER_DECLINED_REASON.seedKey)));
      if (reason) {
        await tx.update(recruitmentApplication).set({ state: 'archived', archiveReasonId: reason.id, stageLeftAtArchive: app.currentStageId, updatedAt: sql`now()`, updatedByUserId: user })
          .where(eq(recruitmentApplication.id, app.id));
        await tx.insert(recruitmentApplicationEvent).values({ tenantId: s.tenantId, companyId: app.companyId, applicationId: app.id, actorUserId: user, ...rejectEvent({ stageLeft: app.currentStageId, reasonId: reason.id }) });
        archived = true;
      }
    }
    await offerEvent(tx, s, offer.id, 'recruitment-offer.decision-recorded', { companyId: offer.companyId, applicationId: offer.applicationId, decision, moved, archived });
    return { moved, archived };
  });
}

// ── Settings: offer fields, validity, automation and approval flows ──────────────────────────────────────

export type OfferSettings = {
  validDays: number; acceptMovesForward: boolean; declineArchives: boolean;
  fields: (OfferFieldDef & { position: number; seeded: boolean; used: boolean })[];
  offerFlow: { userId: string; name: string | null }[]; requisitionFlow: { userId: string; name: string | null }[];
  users: { id: string; name: string }[];
};
export async function offerSettings(s: SessionContext, companyId: string): Promise<OfferSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await ensureRecruitmentDefaultsTx(tx, s, companyId);
    const settings = await companySettingsTx(tx, companyId);
    const rows = await tx.execute<{ id: string; position: number; seed_key: string | null; used: boolean }>(sql`
      select f.id, f.position, f.seed_key, exists (select 1 from recruitment_offer_value v where v.field_id = f.id) as used
      from recruitment_offer_field f where f.company_id = ${companyId}::uuid`);
    const fields = (await offerFieldsTx(tx, companyId)).map((f) => {
      const r = rows.find((x) => x.id === f.id)!;
      return { ...f, position: r.position, seeded: r.seed_key != null, used: r.used };
    });
    const labels = await userLabelsTx(tx, companyId);
    const named = (ids: string[]) => ids.map((id) => ({ userId: id, name: labels.get(id)?.name ?? null }));
    return {
      validDays: settings.offerValidDays, acceptMovesForward: settings.offerAcceptMovesForward, declineArchives: settings.offerDeclineArchives, fields,
      offerFlow: named(await approvalFlowTx(tx, companyId, 'offer')), requisitionFlow: named(await approvalFlowTx(tx, companyId, 'requisition')),
      users: [...labels.values()].filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/** Offer validity and the optional automation. Turning the decline automation on gives the company its
 *  "Candidate declined the offer" reason (a default reason; it can be hidden, never deleted). */
export async function updateOfferSettings(s: SessionContext, companyId: unknown, input: { validDays?: unknown; acceptMovesForward?: unknown; declineArchives?: unknown }): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const validDays = typeof input.validDays === 'string' && /^\d{1,3}$/.test(input.validDays) ? Number(input.validDays) : typeof input.validDays === 'number' ? input.validDays : NaN;
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) throw new RecruitmentError('invalid_input', ['validDays']);
  const on = (v: unknown) => v === true || v === 'on' || v === 'true';
  const after = { offerValidDays: validDays, offerAcceptMovesForward: on(input.acceptMovesForward), offerDeclineArchives: on(input.declineArchives) };
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    await ensureRecruitmentDefaultsTx(tx, s, companyId);
    await tx.update(recruitmentCompanySetting).set({ ...after, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentCompanySetting.companyId, companyId));
    if (after.offerDeclineArchives) {
      await tx.insert(recruitmentArchiveReason).values({
        tenantId: s.tenantId, companyId, internalReason: OFFER_DECLINED_REASON.internal, externalReason: OFFER_DECLINED_REASON.external, kind: 'default',
        position: 200, seedKey: OFFER_DECLINED_REASON.seedKey, createdByUserId: user, updatedByUserId: user,
      }).onConflictDoNothing();
    }
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId, eventType: 'recruitment-setting.offers-updated', actor: actorOf(s), payload: { companyId, after } });
  });
}

/** Create (no id) or edit an offer field. The type is fixed at creation; a single-choice field needs choices. */
export async function saveOfferField(s: SessionContext, input: {
  id?: unknown; companyId?: unknown; label?: unknown; type?: unknown; choices?: unknown; required?: unknown; needsApproval?: unknown; private?: unknown; enabled?: unknown;
}): Promise<void> {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 120) throw new RecruitmentError('missing_fields', ['label']);
  const on = (v: unknown) => v === true || v === 'on' || v === 'true';
  const choices = (typeof input.choices === 'string' ? input.choices.split('\n') : Array.isArray(input.choices) ? input.choices.map(String) : [])
    .map((c) => c.trim()).filter(Boolean);
  const flags = { required: on(input.required), needsApproval: on(input.needsApproval), private: on(input.private), enabled: on(input.enabled) };
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    if (input.id == null || input.id === '') {
      if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
      await assertCompanyTx(tx, input.companyId);
      if (!(OFFER_FIELD_TYPES as readonly unknown[]).includes(input.type)) throw new RecruitmentError('invalid_input', ['type']);
      const type = input.type as OfferFieldType;
      if ((type === 'single_choice') !== (choices.length > 0) || choices.length > 50 || choices.some((c) => c.length > 200)) throw new RecruitmentError('invalid_input', ['choices']);
      const [row] = await tx.insert(recruitmentOfferField).values({
        tenantId: s.tenantId, companyId: input.companyId, label, fieldType: type, choices, ...flags, createdByUserId: user, updatedByUserId: user,
      }).returning({ id: recruitmentOfferField.id });
      await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-offer-field', aggregateId: row.id, eventType: 'recruitment-offer-field.created', actor: actorOf(s), payload: { companyId: input.companyId, label, type, ...flags } });
      return;
    }
    if (!isUuid(input.id)) throw new RecruitmentError('not_found');
    const [field] = await tx.select().from(recruitmentOfferField).where(and(eq(recruitmentOfferField.id, input.id), eq(recruitmentOfferField.tenantId, s.tenantId)));
    if (!field) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, field.companyId);
    const nextChoices = field.fieldType === 'single_choice' ? choices : [];
    if (field.fieldType === 'single_choice' && (!nextChoices.length || nextChoices.length > 50)) throw new RecruitmentError('invalid_input', ['choices']);
    await tx.update(recruitmentOfferField).set({ label, choices: nextChoices, ...flags, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentOfferField.id, field.id));
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-offer-field', aggregateId: field.id, eventType: 'recruitment-offer-field.updated', actor: actorOf(s),
      payload: { companyId: field.companyId, before: { label: field.label, required: field.required, needsApproval: field.needsApproval, private: field.private, enabled: field.enabled }, after: { label, ...flags } } });
  });
}

/** Replace a company approval flow (offers or requisitions) with an ordered list of distinct approvers. */
export async function saveApprovalFlow(s: SessionContext, companyId: unknown, kind: unknown, approverIds: unknown): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  if (kind !== 'offer' && kind !== 'requisition') throw new RecruitmentError('invalid_input', ['flow']);
  const ids = (Array.isArray(approverIds) ? approverIds : []).filter((v) => v !== '');
  if (ids.length > 20 || !ids.every(isUuid) || new Set(ids).size !== ids.length) throw new RecruitmentError('invalid_input', ['approvers']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const labels = await userLabelsTx(tx, companyId);
    if (!ids.every((id) => labels.get(id as string)?.active)) throw new RecruitmentError('invalid_input', ['approvers']);
    await tx.delete(recruitmentApprovalStep).where(and(eq(recruitmentApprovalStep.companyId, companyId), eq(recruitmentApprovalStep.flowKind, kind)));
    let position = 0;
    for (const id of ids) {
      position += 1;
      await tx.insert(recruitmentApprovalStep).values({ tenantId: s.tenantId, companyId, flowKind: kind, position, approverUserId: id as string, createdByUserId: user });
    }
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId, eventType: 'recruitment-setting.approval-flow-saved', actor: actorOf(s), payload: { companyId, kind, approvers: ids } });
  });
}

// ── My approvals (offers; requisitions are added by ./requisitions) ──────────────────────────────────────

export type PendingOfferApproval = { offerId: string; companyId: string; round: number; position: number; steps: number };
/** Offers whose pending step is the caller's. Names are read separately (offerForApprover), within what the caller may see. */
export async function myPendingOfferApprovalsTx(tx: Tx, s: SessionContext): Promise<PendingOfferApproval[]> {
  const rows = await tx.execute<{ id: string; company_id: string; approval_round: number; pending_position: number; steps: number }>(sql`
    select o.id, o.company_id, o.approval_round, o.pending_position, cardinality(o.approver_user_ids) as steps
    from recruitment_offer o
    where o.tenant_id = ${s.tenantId}::uuid and o.status = 'pending' and o.approver_user_ids[o.pending_position] = app.current_user_id()
    order by o.updated_at`);
  return rows.map((r) => ({ offerId: r.id, companyId: r.company_id, round: r.approval_round, position: r.pending_position, steps: r.steps }));
}

/** The offer an approver is asked to decide, with only the values they may see. */
export async function offerForApprover(s: SessionContext, offerId: unknown): Promise<{ offerId: string; candidateName: string; jobTitle: string; fields: (OfferFieldDef & { value: OfferValue | null; hidden: boolean })[]; canDecide: boolean }> {
  return withRecruitmentTenant(s, async (tx) => {
    if (!isUuid(offerId)) throw new RecruitmentError('not_found');
    const [offer] = await tx.select().from(recruitmentOffer).where(and(eq(recruitmentOffer.id, offerId), eq(recruitmentOffer.tenantId, s.tenantId)));
    if (!offer) throw new RecruitmentError('not_found');
    // An approver who is not on the job's team cannot read the application or candidate rows; the offer's own
    // "Job offered" value is what identifies it to them.
    const [names] = await tx.execute<{ full_name: string | null; title: string | null }>(sql`
      select (select c.full_name from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id where a.id = ${offer.applicationId}::uuid) as full_name,
        (select j.title from recruitment_job_opening j where j.id = ${offer.jobId}::uuid) as title`);
    const fields = (await offerFieldsTx(tx, offer.companyId)).filter((f) => f.enabled);
    const values = await visibleValuesTx(tx, offer.id);
    const seesPrivate = await seesPrivateTx(tx, offer.companyId, offer.jobId, offer.id);
    return {
      offerId: offer.id, candidateName: names?.full_name ?? '', jobTitle: names?.title ?? '',
      fields: fields.map((f) => ({ ...f, value: values.get(f.id) ?? null, hidden: f.private && !seesPrivate })),
      canDecide: offer.status === 'pending' && offer.createdByUserId !== s.userId && offer.approverUserIds[(offer.pendingPosition ?? 0) - 1] === s.userId,
    };
  });
}

// ── Hire hand-off ────────────────────────────────────────────────────────────────────────────────────────

export type HirePrefill = { applicationId: string; companyId: string; companyName: string; fullName: string; email: string; jobTitle: string };
export type ApplicationHire = { eligible: boolean; canStart: boolean; link: null | { draftId: string; employeeCode: string | null; linkedAt: string; linkedBy: string | null } };

async function hireContextTx(tx: Tx, s: SessionContext, applicationId: unknown) {
  const app = await applicationRowTx(tx, s, applicationId);
  const [admin] = await tx.execute<{ ok: boolean }>(sql`select app.is_admin_for(${app.company_id}::uuid) as ok`);
  const [link] = await tx.select().from(recruitmentHireHandoff).where(eq(recruitmentHireHandoff.applicationId, app.id));
  const eligible = hireHandoffEligible({ state: app.state, stageSystemKey: app.stage_system_key });
  // Slice 13: an application that needs an administrator's review is not handed to a new hire (4413 refuses the link too).
  const [review] = await tx.execute<{ marked: boolean }>(sql`select app.recruitment_application_needs_review(${app.id}::uuid) as marked`);
  return { app, isAdmin: admin?.ok === true, link, eligible, needsReview: review?.marked === true };
}

/** The application's hire state: whether "Start new hire" applies (HR administrators, Onboarding or hired, not yet linked). */
export async function applicationHire(s: SessionContext, applicationId: string): Promise<ApplicationHire> {
  return withRecruitmentTenant(s, async (tx) => {
    const { app, isAdmin, link, eligible, needsReview } = await hireContextTx(tx, s, applicationId);
    await assertJobLevelTx(tx, app.company_id, app.job_id, 'review');
    const labels = link ? await userLabelsTx(tx, app.company_id) : null;
    return {
      eligible, canStart: isAdmin && eligible && !link && !needsReview,
      link: link ? { draftId: link.employeeDraftId, employeeCode: link.reservedEmployeeCode ?? null, linkedAt: link.linkedAt.toISOString(), linkedBy: labels?.get(link.linkedByUserId)?.name ?? null } : null,
    };
  });
}

/**
 * The short create form's pre-fill, read ON THE SERVER from the application after re-checking access: the caller
 * must be an HR administrator of the company and the application at Onboarding or hired and not yet linked. The
 * URL only names the application; company, name and email always come from here.
 */
export async function hireHandoffPrefill(s: SessionContext, applicationId: unknown): Promise<HirePrefill> {
  return withRecruitmentTenant(s, async (tx) => {
    const { app, isAdmin, link, eligible, needsReview } = await hireContextTx(tx, s, applicationId);
    if (!isAdmin) throw new RecruitmentError('forbidden');
    if (!eligible) throw new RecruitmentError('hire_not_eligible');
    if (link) throw new RecruitmentError('hire_linked');
    if (needsReview) throw new RecruitmentError('needs_review');
    const [row] = await tx.execute<{ email: string | null; company: string }>(sql`
      select c.email, co.legal_name as company from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id
      join company co on co.id = a.company_id where a.id = ${app.id}::uuid`);
    return { applicationId: app.id, companyId: app.company_id, companyName: row?.company ?? '', fullName: app.candidate_name, email: row?.email ?? '', jobTitle: app.job_title };
  });
}

/**
 * Link the employee draft HR just saved (through the personnel writer) back to the application. Refused unless the
 * caller is an HR administrator of the company, the application is still eligible and unlinked, and the draft is a
 * draft of the same company (4403 guard).
 */
export async function linkHireDraft(s: SessionContext, applicationId: unknown, draftId: unknown, employeeCode?: unknown): Promise<void> {
  if (!isUuid(draftId)) throw new RecruitmentError('invalid_input', ['draft']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const { app, isAdmin, link, eligible, needsReview } = await hireContextTx(tx, s, applicationId);
    if (!isAdmin) throw new RecruitmentError('forbidden');
    if (!eligible) throw new RecruitmentError('hire_not_eligible');
    if (link) throw new RecruitmentError('hire_linked');
    if (needsReview) throw new RecruitmentError('needs_review');
    const code = typeof employeeCode === 'string' && employeeCode.trim() && employeeCode.trim().length <= 60 ? employeeCode.trim() : null;
    await tx.insert(recruitmentHireHandoff).values({
      tenantId: s.tenantId, companyId: app.company_id, jobId: app.job_id, applicationId: app.id, employeeDraftId: draftId, reservedEmployeeCode: code, linkedByUserId: user,
    }).catch(reviewRefusal);
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: app.id, eventType: 'recruitment-application.hire-draft-linked', actor: actorOf(s),
      payload: { companyId: app.company_id, employeeDraftId: draftId } });
  });
}

