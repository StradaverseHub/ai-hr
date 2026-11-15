/**
 * Recruitment slice 23 — referral rewards and agency fees. Reached from outside the pack ONLY through ./service.
 *
 *   - A job's reward (recruitment administrators) is frozen on each referral by the database when the referral is made.
 *   - A hired referral's reward is decided once by a recruitment administrator of the job's company, who is neither the
 *     referrer nor the hire; the database re-checks every fact (5725's guard) rather than trusting this service.
 *   - An approved reward is sent once by a payroll administrator of the receiving employment's company: one one-off earning
 *     in payroll's Individual Transactions (the kernel ledger, core/payroll-individual-txn) and the reward marked sent, in
 *     one transaction.
 *   - An agency fee is recorded from the agency's invoice and decided by a second administrator. It never reaches payroll.
 *
 * Events carry references and decisions only, never amounts (ADR-0030 Layer 0, like the payroll ledger's own events).
 * Nothing here calls a model or calculates an amount (D-021, D-063).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import {
  AmountNotPositiveError, ComponentRequiredError, CompanyMismatchError, InvalidTxnComponentError, TxnAfterLeavingDateError,
  createIndividualTxnsBulkTx, individualTxnPayEnabled,
} from '../../core/payroll-individual-txn';
import { pgSqlState } from '../../lib/db-error';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { RecruitmentError, isUuid } from './model';
import {
  REWARD_REASON_MAX, REWARD_TXN_NOTE, cleanText, parseJobReward, rewardPayMonths, rewardSourceRef, rewardState, validateAgencyFee,
  type AgencyFeeInput, type RewardFacts, type RewardPayee, type RewardState,
} from './reward-model';
import { recruitmentAgencyFee, recruitmentJobOpening, recruitmentReferralReward } from './schema';
import { actorId, assertCompanyTx, jobTx } from './data';

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

/** The database's refusals as the service's codes: a forbidden actor (the referrer, the hire, the recorder) is a self
 *  approval; any other check is a stale screen. */
function mapGuard(e: unknown, fallback: 'reward_not_ready' | 'fee_not_eligible'): never {
  const state = pgSqlState(e);
  if (state === '42501') throw new RecruitmentError('reward_self');
  if (state === '23505') throw new RecruitmentError('reward_decided');
  if (state === '23514') throw new RecruitmentError(fallback);
  throw e;
}

// ── The job's reward ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Set or clear a job's referral reward (administrators of the job's company; 5725 refuses anyone else). */
export async function setJobReferralReward(s: SessionContext, jobId: string, value: unknown): Promise<void> {
  const amount = parseJobReward(value);
  if (amount === undefined) throw new RecruitmentError('invalid_input', ['referralReward']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId);
    const before = job.referralReward == null ? null : Number(job.referralReward).toFixed(2);
    if (before === amount) return;
    await tx.update(recruitmentJobOpening).set({ referralReward: amount, updatedAt: sql`now()`, updatedByUserId: user })
      .where(and(eq(recruitmentJobOpening.id, job.id), eq(recruitmentJobOpening.tenantId, s.tenantId)));
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: job.id, eventType: 'recruitment-job.referral-reward-changed',
      actor: actorOf(s), payload: { companyId: job.companyId, from: before === null ? 'none' : 'set', to: amount === null ? 'none' : 'set' },
    });
  });
}

// ── Referral rewards: HR ─────────────────────────────────────────────────────────────────────────────────────────────

export type ReferralRewardRow = {
  referralId: string; applicationId: string; jobId: string; jobTitle: string; jobNumber: string;
  referrerName: string | null; hireName: string | null; amount: string; currency: string; state: RewardState;
  dueOn: string | null; noProbationDate: boolean; payees: RewardPayee[];
  decision: { decidedBy: string | null; decidedAt: string; reason: string | null; payeeEmploymentId: string | null; payPeriod: string | null; sentAt: string | null } | null;
};

type RewardListRow = {
  referral_id: string; application_id: string; job_id: string; job_title: string; job_number: string; referrer_user_id: string;
  hire_name: string | null; reward_amount: string; reward_currency: string; facts: RewardFacts | null;
  decision: 'approved' | 'declined' | null; reason: string | null; decided_by_user_id: string | null; decided_at: string | Date | null;
  payee_employment_id: string | null; pay_period: string | null; sent_at: string | Date | null; txn_id: string | null;
};

const money = (v: string | number) => Number(v).toFixed(2);

/**
 * The company's hired referrals that carry a reward, newest hire first (at most 500), each with its state worked out from
 * the hire's employment and any decision. Administrators of the company only.
 */
export async function referralRewards(s: SessionContext, companyId: string): Promise<ReferralRewardRow[]> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const rows = await tx.execute<RewardListRow>(sql`
      select f.id as referral_id, f.application_id, f.job_id, j.title as job_title, j.job_number, f.referrer_user_id,
        c.full_name as hire_name, f.reward_amount::text as reward_amount, f.reward_currency,
        app.recruitment_reward_facts(f.application_id) as facts,
        w.decision, w.reason, w.decided_by_user_id, w.decided_at, w.payee_employment_id, w.pay_period, w.sent_at, w.txn_id
      from recruitment_referral f
      join recruitment_application a on a.id = f.application_id and a.tenant_id = f.tenant_id
      join recruitment_job_opening j on j.id = f.job_id and j.tenant_id = f.tenant_id
      left join recruitment_candidate c on c.id = f.candidate_id and c.tenant_id = f.tenant_id
      left join recruitment_referral_reward w on w.referral_id = f.id and w.tenant_id = f.tenant_id
      where f.tenant_id = ${s.tenantId}::uuid and f.company_id = ${companyId}::uuid and a.state = 'hired' and f.reward_amount is not null
      order by a.state_changed_at desc, f.id
      limit 500`);
    const labels = await userLabelsTx(tx, companyId);
    return rows.map((r) => {
      const facts = r.facts;
      const decided = r.decision ? { decision: r.decision, txnId: r.txn_id } : null;
      const state = facts ? rewardState(facts, decided) : decided ? rewardState({ hire: null, today: todayInKualaLumpur() }, decided) : 'waiting_record';
      return {
        referralId: r.referral_id, applicationId: r.application_id, jobId: r.job_id, jobTitle: r.job_title, jobNumber: r.job_number,
        referrerName: labels.get(r.referrer_user_id) ?? null, hireName: r.hire_name, amount: money(r.reward_amount), currency: r.reward_currency,
        state, dueOn: facts?.hire?.dueOn ?? null, noProbationDate: facts?.hire?.noProbationDate ?? false, payees: facts?.payees ?? [],
        decision: r.decision ? {
          decidedBy: r.decided_by_user_id ? labels.get(r.decided_by_user_id) ?? null : null, decidedAt: iso(r.decided_at)!, reason: r.reason,
          payeeEmploymentId: r.payee_employment_id, payPeriod: r.pay_period, sentAt: iso(r.sent_at),
        } : null,
      };
    });
  });
}

async function userLabelsTx(tx: Tx, companyId: string): Promise<Map<string, string>> {
  const rows = await tx.execute<{ app_user_id: string; full_name: string }>(sql`select app_user_id, full_name from app.recruitment_user_labels(${companyId}::uuid)`);
  return new Map(rows.map((r) => [r.app_user_id, r.full_name]));
}

export type RewardDecisionInput = { referralId?: unknown; decision?: unknown; payeeEmploymentId?: unknown; reason?: unknown };

/** Approve (to one of the referrer's active employments) or decline (with a reason) a hired referral's reward, once. */
export async function decideReferralReward(s: SessionContext, input: RewardDecisionInput): Promise<{ rewardId: string }> {
  const user = actorId(s);
  if (!isUuid(input.referralId)) throw new RecruitmentError('not_found');
  const decision = input.decision === 'approved' || input.decision === 'declined' ? input.decision : null;
  if (!decision) throw new RecruitmentError('invalid_input', ['decision']);
  const reason = decision === 'declined' ? cleanText(input.reason, REWARD_REASON_MAX) : null;
  if (decision === 'declined' && !reason) throw new RecruitmentError('decline_reason', ['reason']);
  const referralId = input.referralId;
  return withRecruitmentTenant(s, async (tx) => {
    const [ref] = await tx.execute<{ application_id: string; company_id: string }>(sql`
      select application_id, company_id from recruitment_referral where id = ${referralId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!ref) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, ref.company_id);
    const [row] = await tx.execute<{ facts: RewardFacts | null; decided: boolean }>(sql`
      select app.recruitment_reward_facts(${ref.application_id}::uuid) as facts,
        exists (select 1 from recruitment_referral_reward w where w.referral_id = ${referralId}::uuid) as decided`);
    const facts = row?.facts;
    if (!facts || facts.applicationState !== 'hired' || facts.amount == null || !facts.currency) throw new RecruitmentError('not_found');
    if (row.decided) throw new RecruitmentError('reward_decided');
    let payee: RewardPayee | null = null;
    if (decision === 'approved') {
      if (rewardState(facts, null) !== 'ready') throw new RecruitmentError('reward_not_ready');
      const usable = facts.payees.filter((p) => p.currency === facts.currency);
      payee = isUuid(input.payeeEmploymentId) ? usable.find((p) => p.employmentId === input.payeeEmploymentId) ?? null
        : usable.length === 1 && facts.payees.length === 1 ? usable[0] : null;
      if (!payee) throw new RecruitmentError(usable.length ? 'invalid_input' : 'reward_payee_unavailable', usable.length ? ['payeeEmploymentId'] : undefined);
    }
    let id: string;
    try {
      const [inserted] = await tx.transaction(async (sp) => sp.insert(recruitmentReferralReward).values({
        tenantId: s.tenantId, companyId: ref.company_id, referralId, amount: money(facts.amount!), currency: facts.currency!, decision, reason,
        hireEmploymentId: decision === 'approved' ? facts.hire!.employmentId : null,
        payeeEmploymentId: payee?.employmentId ?? null, payeeCompanyId: payee?.companyId ?? null, decidedByUserId: user,
      }).returning({ id: recruitmentReferralReward.id }));
      id = inserted.id;
    } catch (e) {
      mapGuard(e, 'reward_not_ready');
    }
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-referral-reward', aggregateId: id, eventType: 'recruitment-referral-reward.decided',
      actor: actorOf(s), payload: { companyId: ref.company_id, referralId, decision, payeeCompanyId: payee?.companyId ?? null },
    });
    return { rewardId: id };
  });
}

// ── Referral rewards: payroll ────────────────────────────────────────────────────────────────────────────────────────

export type PayrollRewardRow = {
  id: string; amount: string; currency: string; payeeEmploymentId: string; payeeName: string; payeeCode: string | null;
  approvedBy: string | null; approvedAt: string;
};
export type PayrollRewardQueue = {
  companyId: string; rows: PayrollRewardRow[]; months: string[]; components: { id: string; code: string; name: string }[]; ledgerPays: boolean;
};

/** The companies where the caller administers payroll (the pages's company choice for the payroll queue). */
export async function rewardPayrollCompanies(s: SessionContext): Promise<{ id: string; name: string }[]> {
  if (!s.userId) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{ id: string; name: string }>(sql`
      select c.id, c.legal_name::text as name from company c
      where c.tenant_id = ${s.tenantId}::uuid and c.archived_at is null and app.can_admin_payroll_for(c.id)
      order by c.legal_name, c.id limit 200`);
    return rows.map((r) => ({ id: r.id, name: r.name }));
  });
}

/** Approved rewards waiting for payroll in one company, with the pay months and earning components to send them with. */
export async function rewardPayrollQueue(s: SessionContext, companyId: string): Promise<PayrollRewardQueue> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  return withRecruitmentTenant(s, async (tx) => {
    const [access] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_payroll_for(${companyId}::uuid) as ok`);
    if (access?.ok !== true) throw new RecruitmentError('forbidden');
    const rows = await tx.execute<{
      id: string; amount: string; currency: string; payee_employment_id: string; payee_name: string; payee_code: string | null;
      approved_by: string | null; approved_at: string | Date;
    }>(sql`select id, amount::text as amount, currency, payee_employment_id, payee_name, payee_code, approved_by, approved_at
      from app.recruitment_reward_payroll_queue(${companyId}::uuid)`);
    const components = await tx.execute<{ id: string; code: string; name: string }>(sql`
      select p.id, p.code, p.name from pay_component p
      where p.tenant_id = ${s.tenantId}::uuid and p.kind = 'allowance' and p.archived_at is null and p.pending_input_kind is null
        and (p.applied_company_ids is null or ${companyId}::uuid = any (p.applied_company_ids))
      order by p.name, p.id limit 200`);
    return {
      companyId,
      rows: rows.map((r) => ({
        id: r.id, amount: money(r.amount), currency: r.currency, payeeEmploymentId: r.payee_employment_id, payeeName: r.payee_name,
        payeeCode: r.payee_code, approvedBy: r.approved_by, approvedAt: iso(r.approved_at)!,
      })),
      months: rewardPayMonths(todayInKualaLumpur()),
      components: components.map((c) => ({ id: c.id, code: c.code, name: c.name })),
      ledgerPays: individualTxnPayEnabled(s),
    };
  });
}

export type SendRewardInput = { rewardId?: unknown; payPeriod?: unknown; componentId?: unknown };

/**
 * Send an approved reward to payroll: one earning in Individual Transactions for the receiving employment (dated today,
 * the chosen pay month and component, source System, the reward as reference) and the reward marked sent — one transaction.
 */
export async function sendRewardToPayroll(s: SessionContext, input: SendRewardInput): Promise<{ txnId: string }> {
  const user = actorId(s);
  if (!isUuid(input.rewardId)) throw new RecruitmentError('not_found');
  if (!isUuid(input.componentId)) throw new RecruitmentError('invalid_input', ['componentId']);
  const today = todayInKualaLumpur();
  if (typeof input.payPeriod !== 'string' || !rewardPayMonths(today).includes(input.payPeriod)) throw new RecruitmentError('invalid_input', ['payPeriod']);
  if (!individualTxnPayEnabled(s)) throw new RecruitmentError('reward_payroll_off');
  const rewardId = input.rewardId, payPeriod = input.payPeriod, componentId = input.componentId;
  return withRecruitmentTenant(s, async (tx) => {
    const [reward] = await tx.select().from(recruitmentReferralReward)
      .where(and(eq(recruitmentReferralReward.id, rewardId), eq(recruitmentReferralReward.tenantId, s.tenantId), eq(recruitmentReferralReward.decision, 'approved')));
    if (!reward || !reward.payeeEmploymentId || !reward.payeeCompanyId) throw new RecruitmentError('not_found');
    const [access] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_payroll_for(${reward.payeeCompanyId}::uuid) as ok`);
    if (access?.ok !== true) throw new RecruitmentError('forbidden');
    if (reward.txnId) throw new RecruitmentError('reward_decided');
    // Lock it unsent (a sent row no longer passes the send policy, so a concurrent send leaves nothing to lock).
    const [locked] = await tx.execute<{ id: string }>(sql`select id from recruitment_referral_reward where id = ${reward.id}::uuid and txn_id is null for update`);
    if (!locked) throw new RecruitmentError('reward_decided');
    const [closed] = await tx.execute<{ closed: boolean }>(sql`
      select exists (select 1 from payroll_batch b where b.tenant_id = ${s.tenantId}::uuid and b.company_id = ${reward.payeeCompanyId}::uuid
        and b.pay_period = ${payPeriod} and b.run_type = 'regular' and b.status::text not in ('draft', 'processed')) as closed`);
    if (closed?.closed) throw new RecruitmentError('reward_month_closed');
    let txnId: string;
    try {
      const { ids } = await createIndividualTxnsBulkTx(tx, s, {
        companyId: reward.payeeCompanyId, payPeriod, employmentIds: [reward.payeeEmploymentId], refuseAfterLeavingDate: true,
        rows: [{ kind: 'earning', txnDate: today, amount: Number(reward.amount), componentId, notes: REWARD_TXN_NOTE, source: 'system', sourceRef: rewardSourceRef(reward.id) }],
      });
      if (ids.length !== 1) throw new RecruitmentError('reward_not_ready');
      txnId = ids[0];
    } catch (e) {
      if (e instanceof ComponentRequiredError || e instanceof InvalidTxnComponentError) throw new RecruitmentError('invalid_input', ['componentId']);
      if (e instanceof TxnAfterLeavingDateError || e instanceof CompanyMismatchError) throw new RecruitmentError('reward_payee_unavailable');
      if (e instanceof AmountNotPositiveError) throw new RecruitmentError('reward_not_ready');
      if (pgSqlState(e) === '42501') throw new RecruitmentError('forbidden');
      throw e;
    }
    try {
      await tx.transaction(async (sp) => sp.update(recruitmentReferralReward)
        .set({ txnId, payPeriod, sentByUserId: user, sentAt: sql`now()` })
        .where(eq(recruitmentReferralReward.id, reward.id)));
    } catch (e) {
      const state = pgSqlState(e);
      if (state === '42501') throw new RecruitmentError('reward_self');
      if (state === '23514') throw new RecruitmentError('reward_payee_unavailable');
      throw e;
    }
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-referral-reward', aggregateId: reward.id, eventType: 'recruitment-referral-reward.sent',
      actor: actorOf(s), subjectEmploymentId: reward.payeeEmploymentId,
      payload: { companyId: reward.companyId, payeeCompanyId: reward.payeeCompanyId, payPeriod, txnId },
    });
    return { txnId };
  });
}

// ── Agency fees ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type AgencyFeeRow = {
  applicationId: string; submissionId: string; agencyName: string; candidateName: string | null; jobTitle: string; jobNumber: string;
  hiredAt: string; companyCurrency: string;
  fee: {
    id: string; amount: string; currency: string; invoiceRef: string | null; note: string | null; recordedBy: string | null; recordedByMe: boolean;
    recordedAt: string; decision: 'approved' | 'declined' | null; decisionReason: string | null; decidedBy: string | null; decidedAt: string | null;
  } | null;
};

/** The company's hired applications from accepted agency submissions (newest hire first, at most 500), with any fee. */
export async function agencyFees(s: SessionContext, companyId: string): Promise<AgencyFeeRow[]> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const rows = await tx.execute<{
      application_id: string; submission_id: string; agency_name: string; candidate_name: string | null; job_title: string; job_number: string;
      hired_at: string | Date; company_currency: string; fee_id: string | null; amount: string | null; currency: string | null; invoice_ref: string | null;
      note: string | null; recorded_by_user_id: string | null; recorded_at: string | Date | null; decision: 'approved' | 'declined' | null;
      decision_reason: string | null; decided_by_user_id: string | null; decided_at: string | Date | null;
    }>(sql`
      select a.id as application_id, sub.id as submission_id, ag.name as agency_name, c.full_name as candidate_name, j.title as job_title,
        j.job_number, a.state_changed_at as hired_at, co.currency as company_currency, f.id as fee_id, f.amount::text as amount, f.currency,
        f.invoice_ref, f.note, f.recorded_by_user_id, f.recorded_at, f.decision, f.decision_reason, f.decided_by_user_id, f.decided_at
      from recruitment_agency_submission sub
      join recruitment_application a on a.id = sub.application_id and a.tenant_id = sub.tenant_id and a.state = 'hired'
      join recruitment_job_opening j on j.id = a.job_id and j.tenant_id = a.tenant_id
      join recruitment_agency ag on ag.id = sub.agency_id and ag.tenant_id = sub.tenant_id
      join company co on co.id = sub.company_id and co.tenant_id = sub.tenant_id
      left join recruitment_candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
      left join recruitment_agency_fee f on f.application_id = a.id and f.tenant_id = a.tenant_id
      where sub.tenant_id = ${s.tenantId}::uuid and sub.company_id = ${companyId}::uuid and sub.outcome = 'accepted'
      order by a.state_changed_at desc, a.id
      limit 500`);
    const labels = await userLabelsTx(tx, companyId);
    return rows.map((r) => ({
      applicationId: r.application_id, submissionId: r.submission_id, agencyName: r.agency_name, candidateName: r.candidate_name,
      jobTitle: r.job_title, jobNumber: r.job_number, hiredAt: iso(r.hired_at)!, companyCurrency: r.company_currency,
      fee: r.fee_id ? {
        id: r.fee_id, amount: money(r.amount!), currency: r.currency!, invoiceRef: r.invoice_ref, note: r.note,
        recordedBy: r.recorded_by_user_id ? labels.get(r.recorded_by_user_id) ?? null : null, recordedByMe: r.recorded_by_user_id === s.userId,
        recordedAt: iso(r.recorded_at)!, decision: r.decision, decisionReason: r.decision_reason,
        decidedBy: r.decided_by_user_id ? labels.get(r.decided_by_user_id) ?? null : null, decidedAt: iso(r.decided_at),
      } : null,
    }));
  });
}

/** Record, or correct while undecided, the agency fee of a hired agency application (administrators). */
export async function recordAgencyFee(s: SessionContext, application: unknown, input: AgencyFeeInput): Promise<{ feeId: string }> {
  const user = actorId(s);
  if (!isUuid(application)) throw new RecruitmentError('not_found');
  const applicationId: string = application;
  const v = validateAgencyFee(input);
  if (!v.ok) throw new RecruitmentError('invalid_input', v.fields);
  return withRecruitmentTenant(s, async (tx) => {
    const [sub] = await tx.execute<{ id: string; company_id: string }>(sql`
      select sub.id, sub.company_id from recruitment_agency_submission sub
      join recruitment_application a on a.id = sub.application_id and a.tenant_id = sub.tenant_id
      where sub.application_id = ${applicationId}::uuid and sub.tenant_id = ${s.tenantId}::uuid and sub.outcome = 'accepted' and a.state = 'hired'`);
    if (!sub) throw new RecruitmentError('fee_not_eligible');
    await assertCompanyTx(tx, sub.company_id);
    const [existing] = await tx.select({ id: recruitmentAgencyFee.id, decision: recruitmentAgencyFee.decision }).from(recruitmentAgencyFee)
      .where(eq(recruitmentAgencyFee.applicationId, applicationId)).for('update');
    if (existing?.decision) throw new RecruitmentError('fee_decided');
    let id: string;
    try {
      id = await tx.transaction(async (sp) => {
        if (existing) {
          await sp.update(recruitmentAgencyFee).set({ ...v.value, recordedByUserId: user, recordedAt: sql`now()` }).where(eq(recruitmentAgencyFee.id, existing.id));
          return existing.id;
        }
        const [row] = await sp.insert(recruitmentAgencyFee).values({
          tenantId: s.tenantId, companyId: sub.company_id, applicationId, submissionId: sub.id, ...v.value, recordedByUserId: user,
        }).returning({ id: recruitmentAgencyFee.id });
        return row.id;
      });
    } catch (e) {
      mapGuard(e, 'fee_not_eligible');
    }
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-agency-fee', aggregateId: id, eventType: existing ? 'recruitment-agency-fee.corrected' : 'recruitment-agency-fee.recorded',
      actor: actorOf(s), payload: { companyId: sub.company_id, applicationId },
    });
    return { feeId: id };
  });
}

/** Approve or decline (with a reason) an agency fee, once, by an administrator other than its last recorder. */
export async function decideAgencyFee(s: SessionContext, input: { feeId?: unknown; decision?: unknown; reason?: unknown }): Promise<void> {
  const user = actorId(s);
  if (!isUuid(input.feeId)) throw new RecruitmentError('not_found');
  const decision = input.decision === 'approved' || input.decision === 'declined' ? input.decision : null;
  if (!decision) throw new RecruitmentError('invalid_input', ['decision']);
  const reason = decision === 'declined' ? cleanText(input.reason, REWARD_REASON_MAX) : null;
  if (decision === 'declined' && !reason) throw new RecruitmentError('decline_reason', ['reason']);
  const feeId = input.feeId;
  await withRecruitmentTenant(s, async (tx) => {
    const [fee] = await tx.select().from(recruitmentAgencyFee).where(and(eq(recruitmentAgencyFee.id, feeId), eq(recruitmentAgencyFee.tenantId, s.tenantId))).for('update');
    if (!fee) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, fee.companyId);
    if (fee.decision) throw new RecruitmentError('fee_decided');
    if (fee.recordedByUserId === user) throw new RecruitmentError('reward_self');
    try {
      await tx.transaction(async (sp) => sp.update(recruitmentAgencyFee)
        .set({ decision, decisionReason: reason, decidedByUserId: user, decidedAt: sql`now()` }).where(eq(recruitmentAgencyFee.id, fee.id)));
    } catch (e) {
      mapGuard(e, 'fee_not_eligible');
    }
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-agency-fee', aggregateId: fee.id, eventType: 'recruitment-agency-fee.decided',
      actor: actorOf(s), payload: { companyId: fee.companyId, applicationId: fee.applicationId, decision },
    });
  });
}
