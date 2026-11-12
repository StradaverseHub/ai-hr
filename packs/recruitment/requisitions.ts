/**
 * Recruitment slice 4 — job requisitions and the talent pool. Reached from outside the pack ONLY through ./service.
 *
 * Requisitions are administered by recruitment administrators (HR administrators and Recruiting Partners). An
 * approver named in the company's requisition flow reads the requisition they are asked to approve and decides
 * only their own pending step, never on a requisition they created. Statuses follow the 5204 guard: Completed and
 * Cancelled are terminal; Expired is a non-terminal requisition past its target on-board date (Kuala Lumpur day).
 * Vacancy figures are deterministic counts: nothing estimates, forecasts or calls a model.
 *
 * The talent pool is the company's archived applications: the latest one per candidate, with the stage it left and
 * the reason. "Add to job" opens a NEW application at the first stage; the archived one stays archived.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { JOB_EMPLOYMENT_TYPES, RECRUITMENT_TYPES, RecruitmentError, appliedEvent, firstStage, isUuid, type JobStatus } from './model';
import {
  REQUISITION_STATUSES, approvalSteps, canMoveRequisition, decideApproval, effectiveRequisitionStatus, requiredRequisitionFieldsChanged, requisitionMoves,
  startApproval, vacancyCounts, validateRequisitionInput, withdrawApproval,
  type ApprovalStepView, type EffectiveRequisitionStatus, type RequisitionApprovalStatus, type RequisitionStatus, type ValidRequisition,
} from './hiring-model';
import {
  recruitmentApplication, recruitmentApplicationEvent, recruitmentRequisition, recruitmentRequisitionApproval, recruitmentRequisitionJob,
} from './schema';
import {
  actorId, assertCompanyTx, assertNotRepeatedTx, earlierApplicationsTx, insertApplicationTx, jobFormOptions, jobTx, processStagesTx, repeatWindowTx, userLabelsTx, uuidArray,
  type JobFormOptions,
} from './data';
import { repeatApplicationBlocked } from './privacy-model';
import { poolLabels } from './pool-model';
import { approvalFlowTx, myPendingOfferApprovalsTx, type PendingOfferApproval } from './offers';

const reqEvent = (tx: Tx, s: SessionContext, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-requisition', aggregateId, eventType, actor: actorOf(s), payload });
const VOCAB = { employmentTypes: JOB_EMPLOYMENT_TYPES, recruitmentTypes: RECRUITMENT_TYPES };
type ReqRow = typeof recruitmentRequisition.$inferSelect;
const roundOf = (r: { approverUserIds: string[]; pendingPosition: number | null }) => ({ approvers: r.approverUserIds, pendingPosition: r.pendingPosition ?? null });

function validRequisition(input: Record<string, unknown>): ValidRequisition {
  const v = validateRequisitionInput(input, VOCAB);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  return v.value;
}
/** People named on a requisition must be people of the company (the team pickers' population). */
async function assertPeopleTx(tx: Tx, companyId: string, v: ValidRequisition): Promise<void> {
  const labels = await userLabelsTx(tx, companyId);
  for (const [key, id] of [['hiringManagerUserId', v.hiringManagerUserId], ['partnerUserId', v.partnerUserId], ['recruiterUserId', v.recruiterUserId]] as const) {
    if (id && !labels.get(id)?.active) throw new RecruitmentError('invalid_input', [key]);
  }
}
const columns = (v: ValidRequisition) => ({
  title: v.title, description: v.description, vacancies: v.vacancies, jobGradeIds: v.jobGradeIds, hiringManagerUserId: v.hiringManagerUserId,
  partnerUserId: v.partnerUserId, recruiterUserId: v.recruiterUserId, workLocation: v.workLocation, employmentType: v.employmentType,
  recruitmentType: v.recruitmentType, replacedEmploymentId: v.replacedEmploymentId, departmentId: v.departmentId, dateOpened: v.dateOpened,
  targetOnboardDate: v.targetOnboardDate, yearsExperience: v.yearsExperience, education: v.education, salaryMin: v.salaryMin, salaryMax: v.salaryMax,
  salaryCurrency: v.salaryCurrency, workingDays: v.workingDays, workingHours: v.workingHours, mandatorySkills: v.mandatorySkills,
  preferredSkills: v.preferredSkills, benefits: v.benefits,
});

async function requisitionTx(tx: Tx, s: SessionContext, id: unknown, forUpdate = false): Promise<ReqRow> {
  if (!isUuid(id)) throw new RecruitmentError('not_found');
  const q = tx.select().from(recruitmentRequisition).where(and(eq(recruitmentRequisition.id, id), eq(recruitmentRequisition.tenantId, s.tenantId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw new RecruitmentError('not_found');
  return row;
}

/**
 * The vacancy table of each requisition, as count queries over its associated jobs:
 *   onboarded        — applications HIRED on those jobs;
 *   offers in process — offers on ACTIVE applications of those jobs whose candidate has not declined.
 */
async function vacancyTx(tx: Tx, ids: readonly string[]): Promise<Map<string, { onboarded: number; offersInProcess: number; jobs: number }>> {
  if (!ids.length) return new Map();
  const rows = await tx.execute<{ requisition_id: string; onboarded: number; offers: number; jobs: number }>(sql`
    select rj.requisition_id,
      count(distinct a.id) filter (where a.state = 'hired')::int as onboarded,
      count(distinct o.id) filter (where a.state = 'active' and o.candidate_decision <> 'declined')::int as offers,
      count(distinct rj.job_id)::int as jobs
    from recruitment_requisition_job rj
    left join recruitment_application a on a.job_id = rj.job_id
    left join recruitment_offer o on o.application_id = a.id
    where rj.requisition_id = any(${uuidArray(ids)}::uuid[])
    group by rj.requisition_id`);
  return new Map(rows.map((r) => [r.requisition_id, { onboarded: r.onboarded, offersInProcess: r.offers, jobs: r.jobs }]));
}

// ── List ─────────────────────────────────────────────────────────────────────────────────────────────────

export type RequisitionFilters = {
  tab?: string; departmentId?: string; hiringManagerUserId?: string; creatorUserId?: string; hasJob?: string; approvalStatus?: string;
};
export type RequisitionRow = {
  id: string; reqNumber: string; title: string; companyId: string; companyName: string; departmentName: string | null; status: EffectiveRequisitionStatus;
  approvalStatus: RequisitionApprovalStatus; vacancies: number; hiringManagerName: string | null; creatorName: string | null; targetOnboardDate: string | null;
  jobs: number; remainingOffers: number; remainingOnboarding: number; overFilled: boolean;
};
export type RequisitionList = {
  rows: RequisitionRow[]; counts: Record<EffectiveRequisitionStatus, number>;
  departments: { id: string; name: string }[]; hiringManagers: { id: string; name: string }[]; creators: { id: string; name: string }[];
};

export async function listRequisitions(s: SessionContext, companyIds: readonly string[], filters: RequisitionFilters = {}): Promise<RequisitionList> {
  const zero = Object.fromEntries(['draft', 'not_started', 'in_progress', 'paused', 'expired', 'completed', 'cancelled'].map((k) => [k, 0])) as Record<EffectiveRequisitionStatus, number>;
  if (!companyIds.length) return { rows: [], counts: zero, departments: [], hiringManagers: [], creators: [] };
  const today = todayInKualaLumpur();
  return withRecruitmentTenant(s, async (tx) => {
    for (const id of companyIds) await assertCompanyTx(tx, id);
    const ids = uuidArray(companyIds);
    const rows = await tx.execute<{
      id: string; req_number: string; title: string; company_id: string; company_name: string; department_id: string | null; department_name: string | null;
      status: RequisitionStatus; approval_status: RequisitionApprovalStatus; vacancies: number; hiring_manager_user_id: string | null; created_by_user_id: string;
      target_onboard_date: string | null; has_job: boolean;
    }>(sql`
      select r.id, r.req_number, r.title, r.company_id, c.legal_name as company_name, r.department_id, d.name as department_name, r.status, r.approval_status,
        r.vacancies, r.hiring_manager_user_id, r.created_by_user_id, to_char(r.target_onboard_date, 'YYYY-MM-DD') as target_onboard_date,
        exists (select 1 from recruitment_requisition_job rj where rj.requisition_id = r.id) as has_job
      from recruitment_requisition r join company c on c.id = r.company_id left join department d on d.id = r.department_id
      where r.tenant_id = ${s.tenantId}::uuid and r.company_id = any(${ids}::uuid[])
      order by r.created_at desc, r.req_number desc`);
    const labels = new Map<string, string>();
    for (const id of companyIds) for (const [k, v] of await userLabelsTx(tx, id)) labels.set(k, v.name);
    const filtered = rows.filter((r) =>
      (!filters.departmentId || r.department_id === filters.departmentId)
      && (!filters.hiringManagerUserId || r.hiring_manager_user_id === filters.hiringManagerUserId)
      && (!filters.creatorUserId || r.created_by_user_id === filters.creatorUserId)
      && (!filters.hasJob || (filters.hasJob === 'yes') === r.has_job)
      && (!filters.approvalStatus || r.approval_status === filters.approvalStatus));
    const effective = filtered.map((r) => ({ r, status: effectiveRequisitionStatus(r.status, r.target_onboard_date, today) }));
    const counts = { ...zero };
    for (const e of effective) counts[e.status] += 1;
    const tab = (['draft', 'not_started', 'in_progress', 'paused', 'expired', 'completed', 'cancelled'] as const).find((t) => t === filters.tab);
    const shown = effective.filter((e) => !tab || e.status === tab);
    const vacancy = await vacancyTx(tx, shown.map((e) => e.r.id));
    const options = (pick: (r: (typeof rows)[number]) => string | null) =>
      [...new Set(rows.map(pick).filter((x): x is string => !!x))].map((id) => ({ id, name: labels.get(id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      counts,
      rows: shown.map(({ r, status }) => {
        const v = vacancy.get(r.id) ?? { onboarded: 0, offersInProcess: 0, jobs: 0 };
        const c = vacancyCounts({ vacancies: r.vacancies, onboarded: v.onboarded, offersInProcess: v.offersInProcess });
        return {
          id: r.id, reqNumber: r.req_number, title: r.title, companyId: r.company_id, companyName: r.company_name, departmentName: r.department_name, status,
          approvalStatus: r.approval_status, vacancies: r.vacancies, hiringManagerName: r.hiring_manager_user_id ? labels.get(r.hiring_manager_user_id) ?? null : null,
          creatorName: labels.get(r.created_by_user_id) ?? null, targetOnboardDate: r.target_onboard_date, jobs: v.jobs,
          remainingOffers: c.shownOffers, remainingOnboarding: c.shownOnboarding, overFilled: c.overFilled,
        };
      }),
      departments: [...new Map(rows.filter((r) => r.department_id).map((r) => [r.department_id!, r.department_name ?? ''])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      hiringManagers: options((r) => r.hiring_manager_user_id),
      creators: options((r) => r.created_by_user_id),
    };
  });
}

// ── Detail ───────────────────────────────────────────────────────────────────────────────────────────────

export type RequisitionDetail = {
  requisition: Omit<ReqRow, 'dateOpened' | 'targetOnboardDate'> & { dateOpened: string | null; targetOnboardDate: string | null };
  companyName: string; status: EffectiveRequisitionStatus; moves: RequisitionStatus[];
  vacancy: { vacancies: number; onboarded: number; offersInProcess: number; remainingOffers: number; remainingOnboarding: number; shownOffers: number; shownOnboarding: number; overFilled: boolean };
  jobs: { id: string; title: string; jobNumber: string; status: JobStatus; candidates: number; hired: number }[];
  linkableJobs: { id: string; title: string; jobNumber: string }[];
  steps: { position: number; approverName: string | null; state: ApprovalStepView['state']; comment: string | null; actedAt: string | null }[];
  names: Record<string, string>;
  manage: boolean; canDecide: boolean; canSubmit: boolean; canWithdraw: boolean;
};

export async function getRequisition(s: SessionContext, id: string): Promise<RequisitionDetail> {
  const today = todayInKualaLumpur();
  return withRecruitmentTenant(s, async (tx) => {
    const r = await requisitionTx(tx, s, id);
    const [admin] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_recruitment_for(${r.companyId}::uuid) as ok`);
    const manage = admin?.ok === true;
    const approver = r.approverUserIds.includes(s.userId ?? '');
    if (!manage && !approver) throw new RecruitmentError('not_found');
    const [company] = await tx.execute<{ name: string }>(sql`select legal_name as name from company where id = ${r.companyId}::uuid`);
    const status = effectiveRequisitionStatus(r.status, r.targetOnboardDate, today);
    const v = (await vacancyTx(tx, [r.id])).get(r.id) ?? { onboarded: 0, offersInProcess: 0, jobs: 0 };
    const jobs = manage ? await tx.execute<{ id: string; title: string; job_number: string; status: JobStatus; candidates: number; hired: number }>(sql`
      select j.id, j.title, j.job_number, j.status,
        (select count(*)::int from recruitment_application a where a.job_id = j.id) as candidates,
        (select count(*)::int from recruitment_application a where a.job_id = j.id and a.state = 'hired') as hired
      from recruitment_requisition_job rj join recruitment_job_opening j on j.id = rj.job_id
      where rj.requisition_id = ${r.id}::uuid order by j.job_number`) : [];
    const linkable = manage ? await tx.execute<{ id: string; title: string; job_number: string }>(sql`
      select j.id, j.title, j.job_number from recruitment_job_opening j
      where j.tenant_id = ${s.tenantId}::uuid and j.company_id = ${r.companyId}::uuid and j.status <> 'closed'
        and not exists (select 1 from recruitment_requisition_job rj where rj.job_id = j.id) order by j.title, j.job_number`) : [];
    const decisions = r.approvalRound > 0 ? await tx.select().from(recruitmentRequisitionApproval)
      .where(and(eq(recruitmentRequisitionApproval.requisitionId, r.id), eq(recruitmentRequisitionApproval.round, r.approvalRound))) : [];
    const labels = await userLabelsTx(tx, r.companyId).catch(() => new Map());
    const names: Record<string, string> = {};
    for (const uid of [r.hiringManagerUserId, r.partnerUserId, r.recruiterUserId, r.createdByUserId]) if (uid && labels.get(uid)) names[uid] = labels.get(uid)!.name;
    const terminal = r.status === 'completed' || r.status === 'cancelled';
    return {
      requisition: { ...r, dateOpened: r.dateOpened ?? null, targetOnboardDate: r.targetOnboardDate ?? null },
      companyName: company?.name ?? '', status, moves: manage && r.approvalStatus !== 'pending' ? requisitionMoves(r.status, r.targetOnboardDate, today) : [],
      vacancy: { vacancies: r.vacancies, ...v, ...vacancyCounts({ vacancies: r.vacancies, onboarded: v.onboarded, offersInProcess: v.offersInProcess }) },
      jobs: jobs.map((j) => ({ id: j.id, title: j.title, jobNumber: j.job_number, status: j.status, candidates: j.candidates, hired: j.hired })),
      linkableJobs: linkable.map((j) => ({ id: j.id, title: j.title, jobNumber: j.job_number })),
      steps: approvalSteps(roundOf(r), decisions).map((st) => {
        const d = decisions.find((x) => x.position === st.position);
        return { position: st.position, approverName: labels.get(st.approverUserId)?.name ?? null, state: st.state, comment: d?.comment ?? null, actedAt: d?.actedAt.toISOString() ?? null };
      }),
      names, manage,
      canDecide: r.approvalStatus === 'pending' && r.createdByUserId !== s.userId && r.approverUserIds[(r.pendingPosition ?? 0) - 1] === s.userId,
      canSubmit: manage && r.status === 'draft' && r.approvalStatus !== 'pending' && status !== 'expired',
      canWithdraw: manage && r.approvalStatus === 'pending' && !terminal,
    };
  });
}

/** The create/edit form's choices for a company (the same lists the job form offers). */
export async function requisitionFormOptions(s: SessionContext, companyId: string): Promise<JobFormOptions> {
  return jobFormOptions(s, companyId);
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────────────

export async function createRequisition(s: SessionContext, input: Record<string, unknown>): Promise<{ id: string; reqNumber: string }> {
  const v = validRequisition(input);
  const user = actorId(s);
  if (!isUuid(input.companyId)) throw new RecruitmentError('missing_fields', ['company']);
  const companyId = input.companyId;
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    await assertPeopleTx(tx, companyId, v);
    const [row] = await tx.insert(recruitmentRequisition).values({
      tenantId: s.tenantId, companyId, reqNumber: 'HC000000', ...columns(v), createdByUserId: user, updatedByUserId: user,
    }).returning({ id: recruitmentRequisition.id, reqNumber: recruitmentRequisition.reqNumber });
    await reqEvent(tx, s, row.id, 'recruitment-requisition.created', { companyId, reqNumber: row.reqNumber, vacancies: v.vacancies });
    return row;
  });
}

/**
 * Edit a requisition. Terminal ones refuse. Outside Draft, a change to a REQUIRED field resets approval: when the
 * company has a requisition flow, a new round starts from step 1.
 */
export async function updateRequisition(s: SessionContext, id: unknown, input: Record<string, unknown>): Promise<{ reapproval: boolean }> {
  const v = validRequisition(input);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const r = await requisitionTx(tx, s, id, true);
    await assertCompanyTx(tx, r.companyId);
    if (r.status === 'completed' || r.status === 'cancelled') throw new RecruitmentError('requisition_terminal');
    await assertPeopleTx(tx, r.companyId, v);
    // Outside Draft, or while a round is running (a requisition under approval is still a Draft): a change to a
    // required field restarts approval, so no approver's decision stands for values they did not see.
    const reset = (r.status !== 'draft' || r.approvalStatus === 'pending') && requiredRequisitionFieldsChanged(r, v);
    await tx.update(recruitmentRequisition).set({ ...columns(v), updatedByUserId: user }).where(eq(recruitmentRequisition.id, r.id));
    let reapproval = false;
    if (reset) {
      const round = startApproval(await approvalFlowTx(tx, r.companyId, 'requisition'), r.createdByUserId);
      if (round.pendingPosition != null) {
        await tx.update(recruitmentRequisition).set({ approvalStatus: 'pending', approvalRound: r.approvalRound + 1, approverUserIds: round.approvers, pendingPosition: 1, updatedByUserId: user })
          .where(eq(recruitmentRequisition.id, r.id));
        reapproval = true;
      }
    }
    await reqEvent(tx, s, r.id, 'recruitment-requisition.updated', { companyId: r.companyId, reapproval });
    return { reapproval };
  });
}

/** Submit a Draft: with a company flow, approval starts at step 1; without one, it moves to Not started at once. */
export async function submitRequisition(s: SessionContext, id: unknown): Promise<RequisitionApprovalStatus> {
  const user = actorId(s);
  const today = todayInKualaLumpur();
  return withRecruitmentTenant(s, async (tx) => {
    const r = await requisitionTx(tx, s, id, true);
    await assertCompanyTx(tx, r.companyId);
    if (r.status !== 'draft' || r.approvalStatus === 'pending') throw new RecruitmentError('invalid_status_change');
    if (effectiveRequisitionStatus(r.status, r.targetOnboardDate, today) === 'expired') throw new RecruitmentError('invalid_status_change');
    const round = startApproval(await approvalFlowTx(tx, r.companyId, 'requisition'), r.createdByUserId);
    if (round.pendingPosition == null) {
      await tx.update(recruitmentRequisition).set({ approvalStatus: 'not_required', approverUserIds: [], pendingPosition: null, updatedByUserId: user }).where(eq(recruitmentRequisition.id, r.id));
      await tx.update(recruitmentRequisition).set({ status: 'not_started', updatedByUserId: user }).where(eq(recruitmentRequisition.id, r.id));
    } else {
      await tx.update(recruitmentRequisition).set({ approvalStatus: 'pending', approvalRound: r.approvalRound + 1, approverUserIds: round.approvers, pendingPosition: 1, updatedByUserId: user })
        .where(eq(recruitmentRequisition.id, r.id));
    }
    const result: RequisitionApprovalStatus = round.pendingPosition == null ? 'not_required' : 'pending';
    await reqEvent(tx, s, r.id, 'recruitment-requisition.submitted', { companyId: r.companyId, approval: result });
    return result;
  });
}

export async function withdrawRequisition(s: SessionContext, id: unknown): Promise<void> {
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const r = await requisitionTx(tx, s, id, true);
    await assertCompanyTx(tx, r.companyId);
    if (r.approvalStatus !== 'pending') throw new RecruitmentError('offer_state');
    withdrawApproval(roundOf(r));
    await tx.update(recruitmentRequisition).set({ approvalStatus: 'not_submitted', pendingPosition: null, updatedByUserId: user }).where(eq(recruitmentRequisition.id, r.id));
    await reqEvent(tx, s, r.id, 'recruitment-requisition.approval-withdrawn', { companyId: r.companyId, round: r.approvalRound });
  });
}

/** An approver's decision on their own pending step. The last approval of a Draft moves it to Not started. */
export async function decideRequisition(s: SessionContext, id: unknown, decision: unknown, comment?: unknown): Promise<'pending' | 'approved' | 'rejected'> {
  if (decision !== 'approve' && decision !== 'reject') throw new RecruitmentError('invalid_input', ['decision']);
  const note = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 2000) : null;
  if (decision === 'reject' && !note) throw new RecruitmentError('missing_fields', ['comment']);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    // Read first so an out-of-turn approver is told so; then lock (only the pending approver or an administrator can).
    const seen = await requisitionTx(tx, s, id);
    if (seen.approvalStatus !== 'pending') throw new RecruitmentError('offer_state');
    decideApproval(roundOf(seen), user, seen.createdByUserId, decision);
    const r = await requisitionTx(tx, s, id, true);
    if (r.approvalStatus !== 'pending') throw new RecruitmentError('offer_state');
    const plan = decideApproval(roundOf(r), user, r.createdByUserId, decision);
    await tx.insert(recruitmentRequisitionApproval).values({
      tenantId: s.tenantId, companyId: r.companyId, requisitionId: r.id, round: r.approvalRound, position: plan.position, approverUserId: user, decision: plan.decision, comment: note,
    });
    await tx.update(recruitmentRequisition).set({
      approvalStatus: plan.outcome, pendingPosition: plan.pendingPosition,
      // The last approval moves a Draft to Not started, unless its target date has passed meanwhile: an expired
      // requisition may only be completed or cancelled, so it stays a Draft with its approval recorded.
      ...(plan.outcome === 'approved' && r.status === 'draft' && effectiveRequisitionStatus(r.status, r.targetOnboardDate, todayInKualaLumpur()) !== 'expired'
        ? { status: 'not_started' as const } : {}), updatedByUserId: user,
    }).where(eq(recruitmentRequisition.id, r.id));
    await reqEvent(tx, s, r.id, decision === 'approve' ? 'recruitment-requisition.step-approved' : 'recruitment-requisition.step-rejected',
      { companyId: r.companyId, round: r.approvalRound, position: plan.position, outcome: plan.outcome });
    return plan.outcome;
  });
}

/** Manual status moves (see ./hiring-model requisitionMoves). Terminal statuses refuse; the database refuses again. */
export async function changeRequisitionStatus(s: SessionContext, id: unknown, to: unknown): Promise<void> {
  if (!(REQUISITION_STATUSES as readonly unknown[]).includes(to)) throw new RecruitmentError('invalid_status_change');
  const user = actorId(s);
  const today = todayInKualaLumpur();
  await withRecruitmentTenant(s, async (tx) => {
    const r = await requisitionTx(tx, s, id, true);
    await assertCompanyTx(tx, r.companyId);
    if (r.status === 'completed' || r.status === 'cancelled') throw new RecruitmentError('requisition_terminal');
    if (r.approvalStatus === 'pending' && to !== 'cancelled') throw new RecruitmentError('approval_pending');
    if (!canMoveRequisition(r.status, to as RequisitionStatus, r.targetOnboardDate, today)) throw new RecruitmentError('invalid_status_change');
    await tx.update(recruitmentRequisition).set({
      status: to as RequisitionStatus, ...(r.approvalStatus === 'pending' ? { approvalStatus: 'not_submitted' as const, pendingPosition: null } : {}), updatedByUserId: user,
    }).where(eq(recruitmentRequisition.id, r.id));
    await reqEvent(tx, s, r.id, 'recruitment-requisition.status-changed', { companyId: r.companyId, from: r.status, to });
  });
}

/** Associate an existing job of the same company (a job belongs to at most one requisition). */
export async function associateJob(s: SessionContext, id: unknown, jobId: unknown): Promise<void> {
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const r = await requisitionTx(tx, s, id);
    await assertCompanyTx(tx, r.companyId);
    if (r.status === 'completed' || r.status === 'cancelled') throw new RecruitmentError('requisition_terminal');
    const job = await jobTx(tx, s, jobId as string);
    if (job.companyId !== r.companyId) throw new RecruitmentError('invalid_input', ['job']);
    const inserted = await tx.insert(recruitmentRequisitionJob).values({ tenantId: s.tenantId, companyId: r.companyId, requisitionId: r.id, jobId: job.id, createdByUserId: user })
      .onConflictDoNothing().returning({ id: recruitmentRequisitionJob.id });
    if (!inserted.length) throw new RecruitmentError('invalid_input', ['job']);
    await reqEvent(tx, s, r.id, 'recruitment-requisition.job-associated', { companyId: r.companyId, jobId: job.id });
  });
}
export async function dissociateJob(s: SessionContext, id: unknown, jobId: unknown): Promise<void> {
  await withRecruitmentTenant(s, async (tx) => {
    const r = await requisitionTx(tx, s, id);
    await assertCompanyTx(tx, r.companyId);
    if (!isUuid(jobId)) throw new RecruitmentError('not_found');
    const removed = await tx.delete(recruitmentRequisitionJob).where(and(eq(recruitmentRequisitionJob.requisitionId, r.id), eq(recruitmentRequisitionJob.jobId, jobId)))
      .returning({ id: recruitmentRequisitionJob.id });
    if (!removed.length) throw new RecruitmentError('not_found');
    await reqEvent(tx, s, r.id, 'recruitment-requisition.job-dissociated', { companyId: r.companyId, jobId });
  });
}

/** "Create job" from a requisition: the new-position form's pre-fill, read on the server. */
export async function requisitionJobPrefill(s: SessionContext, id: unknown) {
  return withRecruitmentTenant(s, async (tx) => {
    const r = await requisitionTx(tx, s, id);
    await assertCompanyTx(tx, r.companyId);
    if (r.status === 'completed' || r.status === 'cancelled') throw new RecruitmentError('requisition_terminal');
    return {
      requisitionId: r.id, reqNumber: r.reqNumber, companyId: r.companyId,
      values: { title: r.title, description: r.description, jobGradeIds: r.jobGradeIds, workLocation: r.workLocation, recruitmentType: r.recruitmentType, employmentType: r.employmentType, departmentId: r.departmentId },
      recruiterUserId: r.recruiterUserId,
    };
  });
}

// ── My approvals ─────────────────────────────────────────────────────────────────────────────────────────

export type MyApprovals = {
  offers: PendingOfferApproval[];
  requisitions: { id: string; reqNumber: string; title: string; companyId: string; vacancies: number; position: number; steps: number }[];
};
export async function myApprovals(s: SessionContext): Promise<MyApprovals> {
  return withRecruitmentTenant(s, async (tx) => {
    const offers = await myPendingOfferApprovalsTx(tx, s);
    const reqs = await tx.execute<{ id: string; req_number: string; title: string; company_id: string; vacancies: number; pending_position: number; steps: number }>(sql`
      select r.id, r.req_number, r.title, r.company_id, r.vacancies, r.pending_position, cardinality(r.approver_user_ids) as steps
      from recruitment_requisition r
      where r.tenant_id = ${s.tenantId}::uuid and r.approval_status = 'pending' and r.approver_user_ids[r.pending_position] = app.current_user_id()
      order by r.updated_at`);
    return { offers, requisitions: reqs.map((r) => ({ id: r.id, reqNumber: r.req_number, title: r.title, companyId: r.company_id, vacancies: r.vacancies, position: r.pending_position, steps: r.steps })) };
  });
}

// ── Talent pool ──────────────────────────────────────────────────────────────────────────────────────────

export type PoolFilters = { jobId?: string; reasonId?: string; since?: string; tagId?: string };
export type PoolCard = {
  applicationId: string; candidateId: string; candidateName: string; email: string | null; phone: string | null; companyId: string;
  /** Slice 5: the candidate's tags, and whether their personal data has been removed (then nothing can be added). */
  tags: { id: string; name: string }[]; removed: boolean;
  appliedAt: string; jobId: string; jobTitle: string; jobNumber: string; archivedAt: string; stageLeft: string; reason: string;
  /** Open jobs of the candidate's company it has not applied to (the "Add to job" choices). */
  addable: { id: string; title: string; jobNumber: string }[];
  /** Slice 13: "Pools: …" (the candidate's custom pools), and whether the candidate is on the blocked list. */
  pools: string[]; blocked: boolean;
};
export type TalentPool = {
  cards: PoolCard[]; totals: { today: number; total: number };
  jobs: { id: string; title: string; jobNumber: string }[]; reasons: { id: string; internal: string }[];
  tags: { id: string; name: string; groupName: string }[];
};

/**
 * The company's public talent pool: the latest ARCHIVED application of each candidate, with the stage it left and
 * the archive reason. Totals: archived today (Kuala Lumpur) and all pool entries, both count queries.
 */
export async function talentPool(s: SessionContext, companyIds: readonly string[], filters: PoolFilters = {}): Promise<TalentPool> {
  if (!companyIds.length) return { cards: [], totals: { today: 0, total: 0 }, jobs: [], reasons: [], tags: [] };
  const today = todayInKualaLumpur();
  return withRecruitmentTenant(s, async (tx) => {
    for (const id of companyIds) await assertCompanyTx(tx, id);
    const ids = uuidArray(companyIds);
    const job = filters.jobId && isUuid(filters.jobId) ? filters.jobId : null;
    const reason = filters.reasonId && isUuid(filters.reasonId) ? filters.reasonId : null;
    const since = filters.since && /^\d{4}-\d{2}-\d{2}$/.test(filters.since) ? filters.since : null;
    const tag = filters.tagId && isUuid(filters.tagId) ? filters.tagId : null;
    const pool = sql`(select distinct on (a.candidate_id) a.* from recruitment_application a
      where a.tenant_id = ${s.tenantId}::uuid and a.company_id = any(${ids}::uuid[]) and a.state = 'archived'
      order by a.candidate_id, a.state_changed_at desc, a.id desc)`;
    const [totals] = await tx.execute<{ today: number; total: number }>(sql`
      select count(*) filter (where (p.state_changed_at at time zone 'Asia/Kuala_Lumpur')::date = ${today}::date)::int as today, count(*)::int as total from ${pool} p`);
    const rows = await tx.execute<{
      id: string; candidate_id: string; full_name: string; email: string | null; phone: string | null; company_id: string; applied_at: string; job_id: string;
      title: string; job_number: string; archived_at: string; stage_left: string; reason: string; removed: boolean;
    }>(sql`
      select p.id, p.candidate_id, c.full_name, c.email, c.phone, p.company_id, c.destroyed_at is not null as removed,
        to_char(p.applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as applied_at, p.job_id, j.title, j.job_number,
        to_char(p.state_changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as archived_at, st.name as stage_left, r.internal_reason as reason
      from ${pool} p
      join recruitment_candidate c on c.id = p.candidate_id
      join recruitment_job_opening j on j.id = p.job_id
      join recruitment_stage st on st.id = p.stage_left_at_archive
      join recruitment_archive_reason r on r.id = p.archive_reason_id
      where (${job}::uuid is null or p.job_id = ${job}::uuid) and (${reason}::uuid is null or p.archive_reason_id = ${reason}::uuid)
        and (${since}::date is null or (p.state_changed_at at time zone 'Asia/Kuala_Lumpur')::date >= ${since}::date)
        and (${tag}::uuid is null or exists (select 1 from recruitment_candidate_tag ct where ct.candidate_id = p.candidate_id and ct.tag_id = ${tag}::uuid))
      order by p.state_changed_at desc, p.id limit 200`);
    const open = await tx.execute<{ id: string; title: string; job_number: string; company_id: string }>(sql`
      select j.id, j.title, j.job_number, j.company_id from recruitment_job_opening j
      where j.tenant_id = ${s.tenantId}::uuid and j.company_id = any(${ids}::uuid[]) and j.status <> 'closed' order by j.title, j.job_number`);
    // "Add to job" offers only the jobs the repeated-application rule allows (slice 5), per company window.
    const earlier = await earlierApplicationsTx(tx, [...new Set(rows.map((r) => r.candidate_id))]);
    const windows = new Map<string, number>();
    for (const id of companyIds) windows.set(id, await repeatWindowTx(tx, id));
    const cardTags = rows.length ? await tx.execute<{ candidate_id: string; id: string; name: string }>(sql`
      select ct.candidate_id, t.id, t.name from recruitment_candidate_tag ct join recruitment_tag t on t.id = ct.tag_id
      where ct.candidate_id = any(${uuidArray([...new Set(rows.map((r) => r.candidate_id))])}::uuid[]) order by t.name`) : [];
    const tags = await tx.execute<{ id: string; name: string; group_name: string }>(sql`
      select t.id, t.name, g.name as group_name from recruitment_tag t join recruitment_tag_group g on g.id = t.group_id
      where t.tenant_id = ${s.tenantId}::uuid and t.company_id = any(${ids}::uuid[]) order by g.name, t.name`);
    // Slice 13: the shown candidates' custom pools and blocked-list entries (two queries over the shown cards).
    const shown = [...new Set(rows.map((r) => r.candidate_id))];
    const cardPools = shown.length ? await tx.execute<{ candidate_id: string; name: string; parent_name: string | null }>(sql`
      select m.candidate_id, p.name, pp.name as parent_name from recruitment_talent_pool_member m join recruitment_talent_pool p on p.id = m.pool_id
      left join recruitment_talent_pool pp on pp.id = p.parent_id where m.candidate_id = any(${uuidArray(shown)}::uuid[])`) : [];
    const blocked = new Set(shown.length ? (await tx.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_blocked_entry
      where candidate_id = any(${uuidArray(shown)}::uuid[]) and removed_at is null`)).map((r) => r.candidate_id) : []);
    const jobs = await tx.execute<{ id: string; title: string; job_number: string }>(sql`
      select distinct j.id, j.title, j.job_number from recruitment_application a join recruitment_job_opening j on j.id = a.job_id
      where a.tenant_id = ${s.tenantId}::uuid and a.company_id = any(${ids}::uuid[]) and a.state = 'archived' order by j.title, j.job_number`);
    const reasons = await tx.execute<{ id: string; internal: string }>(sql`
      select id, internal_reason as internal from recruitment_archive_reason where tenant_id = ${s.tenantId}::uuid and company_id = any(${ids}::uuid[]) order by position, internal_reason`);
    return {
      totals: totals ?? { today: 0, total: 0 },
      cards: rows.map((r) => ({
        applicationId: r.id, candidateId: r.candidate_id, candidateName: r.full_name, email: r.email, phone: r.phone, companyId: r.company_id, appliedAt: r.applied_at,
        jobId: r.job_id, jobTitle: r.title, jobNumber: r.job_number, archivedAt: r.archived_at, stageLeft: r.stage_left, reason: r.reason,
        removed: r.removed, tags: cardTags.filter((x) => x.candidate_id === r.candidate_id).map((x) => ({ id: x.id, name: x.name })),
        pools: poolLabels(cardPools.filter((x) => x.candidate_id === r.candidate_id).map((x) => ({ name: x.name, parentName: x.parent_name }))),
        blocked: blocked.has(r.candidate_id),
        addable: r.removed ? [] : open.filter((j) => j.company_id === r.company_id
          && !repeatApplicationBlocked(earlier.filter((a) => a.candidateId === r.candidate_id), j.id, windows.get(r.company_id) ?? 3, today))
          .map((j) => ({ id: j.id, title: j.title, jobNumber: j.job_number })),
      })),
      jobs: jobs.map((j) => ({ id: j.id, title: j.title, jobNumber: j.job_number })), reasons: [...reasons],
      tags: tags.map((t) => ({ id: t.id, name: t.name, groupName: t.group_name })),
    };
  });
}

/**
 * "Add to job": a NEW application for the pooled candidate on an open job of the same company, at its first stage.
 * The archived application is not touched. The job's operators may do it, as administrators may.
 */
export async function addPoolCandidateToJob(s: SessionContext, archivedApplicationId: unknown, jobId: unknown): Promise<{ applicationId: string }> {
  if (!isUuid(archivedApplicationId)) throw new RecruitmentError('not_found');
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const [archived] = await tx.select().from(recruitmentApplication)
      .where(and(eq(recruitmentApplication.id, archivedApplicationId), eq(recruitmentApplication.tenantId, s.tenantId)));
    if (!archived) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, archived.companyId);
    if (archived.state !== 'archived') throw new RecruitmentError('not_in_pool');
    const job = await jobTx(tx, s, jobId as string, 'operate');
    if (job.companyId !== archived.companyId) throw new RecruitmentError('invalid_input', ['job']);
    if (job.status === 'closed') throw new RecruitmentError('job_closed');
    const start = firstStage(await processStagesTx(tx, job.processId));
    if (!start) throw new RecruitmentError('process_unavailable');
    const [candidate] = await tx.execute<{ removed: boolean }>(sql`select destroyed_at is not null as removed from recruitment_candidate where id = ${archived.candidateId}::uuid`);
    if (candidate?.removed) throw new RecruitmentError('candidate_removed');
    // Slice 5: the repeated-application rule (the same job while active or closed within the window) replaces the
    // one-application-per-job key; the 5205 guard refuses the same again.
    await assertNotRepeatedTx(tx, job.companyId, archived.candidateId, job.id);
    // A concurrent add of the same candidate to the same job (the guard's 23505) maps to duplicate_application.
    const inserted = [{ id: await insertApplicationTx(tx, {
      tenantId: s.tenantId, companyId: job.companyId, jobId: job.id, candidateId: archived.candidateId, currentStageId: start, source: 'Talent pool',
      createdByUserId: user, updatedByUserId: user,
    }) }];
    await tx.insert(recruitmentApplicationEvent).values({ tenantId: s.tenantId, companyId: job.companyId, applicationId: inserted[0].id, actorUserId: user, ...appliedEvent(start) });
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: inserted[0].id, eventType: 'recruitment-application.added-from-pool', actor: actorOf(s),
      payload: { companyId: job.companyId, fromApplicationId: archived.id, jobId: job.id } });
    return { applicationId: inserted[0].id };
  });
}

