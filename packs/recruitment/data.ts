/**
 * Recruitment service implementation (slice 1). Reached from outside the pack ONLY through ./service.
 *
 * Every entry point:
 *   1. runs inside `withRecruitmentTenant` — the module gate refuses a tenant that has not bought Recruitment
 *      before any SQL runs (ADR-0077 D3);
 *   2. asks the database whether the caller may do this to the company or job it touches: administration
 *      (app.can_admin_recruitment_for: HR administrators and the company-scoped Recruiting Partner) or, since slice 2,
 *      the caller's per-job team role (app.can_operate_recruitment_job / app.can_review_recruitment_job, 5202);
 *   3. applies the pure rules in ./model, and the 5201–5204 guards refuse the same illegal states again.
 * Row security narrows every read to what the caller may see: a team member's rows are their own jobs' and the
 * applications they interview.
 * Nothing here calls a model: every number on these screens is a count query. The AI Centre reads only
 * recruitmentPipelineCounts (per-company counts, never a candidate).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { withCanonicalAiReadTx } from '../../core/ai-read-transaction';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { pgSqlState } from '../../lib/db-error';
import {
  DEFAULT_ARCHIVE_REASONS, DEFAULT_PROCESS, DEFAULT_STAGES, JOB_MEMBER_ROLES, JOB_STATUSES, RECRUITMENT_STAGE_TYPES,
  RecruitmentError, appliedEvent, canChangeJobStatus, firstStage, isUuid, moveEvent, planMoveForward, planMoveTo, planReject,
  processChangeRefused, rejectEvent,
  validateCandidateInput, validateJobInput,
  type ApplicationState, type CandidateInput, type JobInput, type JobMemberRole, type JobStatus, type ProcessStage,
  type RecruitmentStageType, type ValidJob,
} from './model';
import {
  recruitmentApplication, recruitmentApplicationEvent, recruitmentArchiveReason, recruitmentCandidate, recruitmentCompanySetting,
  recruitmentEvaluationForm, recruitmentJobMember, recruitmentJobOpening, recruitmentOfferField, recruitmentProcess, recruitmentProcessStage,
  recruitmentRequisitionJob, recruitmentStage, recruitmentCandidateRestricted,
} from './schema';
import { DEFAULT_EVALUATION_FORM, DEFAULT_OFFER_FIELDS } from './hiring-model';
import { ASSIGNMENT_STATUSES, SCREENING_LIST_LIMIT, SCREENING_STATUS_WINDOW, parseAssignmentFilter, type AssignmentStatus } from './screening-model';
import { checkMarker, type CheckMarker, type CheckOutcome, type CheckStatus } from './background-check-model';
import { poolLabels } from './pool-model';
import {
  customFilterChoicesTx, customFilterSql, newRecordCustomFieldsTx, recordCustomFieldsTx, saveRecordCustomValuesTx, type CustomFieldView, type CustomFilterChoice,
} from './custom-field-store';
import { customFilterKey, type RawCustomValues } from './custom-field-model';
import { cutoffRelation, stageEnteredDayOf, stageEnteredDaySql, waitingContextTx } from './waiting-store';
import { WAITING_BOARD_SCAN_LIMIT, WAITING_SCAN_LIMIT, parseWaitingFilter, waitingDays, waitingLevel, type WaitingFilter } from './waiting-model';
import {
  CANDIDATE_SOURCES, DEFAULT_REPEAT_WINDOW_MONTHS, ID_TYPES, normEmail, normIdNumber, normMobile, normName, repeatApplicationBlocked,
  type CandidateSource, type IdType,
} from './privacy-model';

export const uuidArray = (ids: readonly string[]) => {
  if (!ids.every(isUuid)) throw new RecruitmentError('invalid_input');
  return `{${ids.join(',')}}`;
};
export const actorId = (s: SessionContext): string => {
  if (!s.userId) throw new RecruitmentError('forbidden');
  return s.userId;
};

/** Refuse unless the caller administers recruitment for `companyId` (the database's own predicate). */
export async function assertCompanyTx(tx: Tx, companyId: string): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const [row] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_recruitment_for(${companyId}::uuid) as ok`);
  if (row?.ok !== true) throw new RecruitmentError('forbidden');
}
/** Refuse unless the caller administers recruitment for the company OR is on one of its job teams / interviews (5202). */
export async function assertSeeCompanyTx(tx: Tx, companyId: string): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const [row] = await tx.execute<{ ok: boolean }>(sql`select app.can_see_recruitment_company(${companyId}::uuid) as ok`);
  if (row?.ok !== true) throw new RecruitmentError('forbidden');
}
export type JobLevel = 'read' | 'review' | 'operate';
/** The caller's access to one job, from the database predicates (5202). */
export async function jobLevelTx(tx: Tx, companyId: string, jobId: string, applicationId?: string): Promise<{ admin: boolean; operate: boolean; review: boolean; read: boolean }> {
  const [row] = await tx.execute<{ admin: boolean; operate: boolean; review: boolean; interviews: boolean }>(sql`
    select app.can_admin_recruitment_for(${companyId}::uuid) as admin, app.can_operate_recruitment_job(${companyId}::uuid, ${jobId}::uuid) as operate,
      app.can_review_recruitment_job(${companyId}::uuid, ${jobId}::uuid) as review,
      ${applicationId ? sql`app.recruitment_interviews_application(${applicationId}::uuid)` : sql`false`} as interviews`);
  return { admin: row?.admin === true, operate: row?.operate === true, review: row?.review === true, read: row?.review === true || row?.interviews === true };
}
/** Refuse unless the caller has `level` on the job (operate ⊂ review ⊂ read). */
export async function assertJobLevelTx(tx: Tx, companyId: string, jobId: string, level: JobLevel, applicationId?: string): Promise<void> {
  const access = await jobLevelTx(tx, companyId, jobId, applicationId);
  if (!access[level]) throw new RecruitmentError('forbidden');
}

export type RecruitmentCompany = { id: string; name: string };
export type RecruitmentViewer = {
  /** Companies in scope whose recruitment the caller administers. */
  adminCompanies: RecruitmentCompany[];
  /** Companies in scope where the caller is on a job team or interviews, but does not administer. */
  teamCompanies: RecruitmentCompany[];
  /** The caller has an approval step waiting for them (offer or requisition). */
  pendingApprovals: number;
  /** Slice 6: companies whose Reports the caller may open — those they administer, and those where they are a job's
   *  recruiter, assistant or hiring manager (an interviewer alone gets none). */
  reportCompanies: RecruitmentCompany[];
  /** Slice 11: the caller's open screening requests in the companies they may see here (the To screen list's scope), counted
   *  up to SCREENING_LIST_LIMIT + 1 (more than the list shows reads as "200+"). */
  pendingScreening: number;
  /** Slice 13: companies whose talent pools the caller may open — those they administer, and those where they are a recruiter
   *  or assistant of some job (custom pools shared with them, and the blocked list of candidates they operate). */
  poolCompanies: RecruitmentCompany[];
};

/**
 * Who the caller is to Recruitment within `scopeIds`, answered by the database: the companies they administer, the
 * companies where they only have per-job team access (slice 2), and how many approval steps wait for them.
 */
export async function recruitmentViewer(s: SessionContext, scopeIds: readonly string[]): Promise<RecruitmentViewer> {
  const ids = scopeIds.filter(isUuid);
  return withRecruitmentTenant(s, async (tx) => {
    const rows = ids.length ? await tx.execute<{ id: string; name: string; admin: boolean; team: boolean; reporter: boolean; operates: boolean }>(sql`
      select c.id, c.legal_name as name, app.can_admin_recruitment_for(c.id) as admin, app.recruitment_team_in_company(c.id) as team,
        app.recruitment_operates_in_company(c.id) as operates,
        exists (select 1 from recruitment_job_member m where m.tenant_id = c.tenant_id and m.company_id = c.id
          and m.app_user_id = app.current_user_id() and m.member_role in ('recruiter', 'assistant', 'hiring_manager')) as reporter
      from company c
      where c.tenant_id = ${s.tenantId}::uuid and c.id = any(${uuidArray(ids)}::uuid[]) and c.archived_at is null
      order by c.legal_name, c.id`) : [];
    // A step waits for the caller when the item's pending position names them (5203/5204 keep the round on the row).
    const [pending] = await tx.execute<{ n: number }>(sql`select
      (select count(*)::int from recruitment_offer o where o.tenant_id = ${s.tenantId}::uuid and o.status = 'pending' and o.approver_user_ids[o.pending_position] = app.current_user_id())
      + (select count(*)::int from recruitment_requisition r where r.tenant_id = ${s.tenantId}::uuid and r.approval_status = 'pending' and r.approver_user_ids[r.pending_position] = app.current_user_id()) as n`);
    // Slice 11: the caller's own open screening requests in the companies they may see (administered or on a team) — the To
    // screen list's scope and cap. Requests close by themselves when the application or the reviewer leaves (5211), so no
    // application join is needed; the reviewer's own index bounds the read.
    const seen = rows.filter((r) => r.admin || r.team).map((r) => r.id);
    const [screening] = seen.length ? await tx.execute<{ n: number }>(sql`select count(*)::int as n from (select 1 from recruitment_screening_request q
      where q.tenant_id = ${s.tenantId}::uuid and q.reviewer_user_id = app.current_user_id() and q.closed_at is null
        and q.company_id = any(${uuidArray(seen)}::uuid[]) limit ${SCREENING_LIST_LIMIT + 1}) x`) : [];
    return {
      adminCompanies: rows.filter((r) => r.admin).map((r) => ({ id: r.id, name: r.name })),
      teamCompanies: rows.filter((r) => !r.admin && r.team).map((r) => ({ id: r.id, name: r.name })),
      pendingApprovals: pending?.n ?? 0,
      reportCompanies: rows.filter((r) => r.admin || r.reporter).map((r) => ({ id: r.id, name: r.name })),
      pendingScreening: screening?.n ?? 0,
      poolCompanies: rows.filter((r) => r.admin || r.operates).map((r) => ({ id: r.id, name: r.name })),
    };
  });
}

/**
 * The menu question for a caller who is not a recruitment administrator: are they on any job team, scheduled to
 * interview, or asked to approve? Row security answers it — the caller sees only their own membership rows.
 */
export async function recruitmentTeamPresence(s: SessionContext): Promise<boolean> {
  if (!s.userId) return false;
  return withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.execute<{ any: boolean }>(sql`select
      exists (select 1 from recruitment_job_member m where m.tenant_id = ${s.tenantId}::uuid and m.app_user_id = app.current_user_id())
      or exists (select 1 from recruitment_interview_interviewer i where i.tenant_id = ${s.tenantId}::uuid and i.app_user_id = app.current_user_id())
      or exists (select 1 from recruitment_offer o where o.tenant_id = ${s.tenantId}::uuid and o.status = 'pending' and o.approver_user_ids[o.pending_position] = app.current_user_id())
      or exists (select 1 from recruitment_requisition r where r.tenant_id = ${s.tenantId}::uuid and r.approval_status = 'pending' and r.approver_user_ids[r.pending_position] = app.current_user_id()) as any`);
    return row?.any === true;
  });
}

/** The companies in `scopeIds` whose recruitment the caller administers, by name. */
export async function recruitmentCompanies(s: SessionContext, scopeIds: readonly string[]): Promise<RecruitmentCompany[]> {
  const ids = scopeIds.filter(isUuid);
  if (!ids.length) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{ id: string; name: string }>(sql`
      select c.id, c.legal_name as name from company c
      where c.tenant_id = ${s.tenantId}::uuid and c.id = any(${uuidArray(ids)}::uuid[]) and c.archived_at is null
        and app.can_admin_recruitment_for(c.id)
      order by c.legal_name, c.id`);
    return rows.map((r) => ({ id: r.id, name: r.name }));
  });
}

/**
 * Give a company its editable defaults, once: the stage catalogue, the "Recruitment process" with its nine
 * ordered stages, and the seven default archive reasons. Idempotent and concurrency-safe — every insert is
 * keyed by a per-company seed key and skips on conflict, so a renamed or disabled default is never restored.
 */
export async function ensureRecruitmentDefaultsTx(tx: Tx, s: SessionContext, companyId: string): Promise<void> {
  await assertCompanyTx(tx, companyId);
  const user = actorId(s);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`recruitment-seed:${s.tenantId}:${companyId}`}, 0))`);
  for (const stage of DEFAULT_STAGES) {
    await tx.insert(recruitmentStage).values({
      tenantId: s.tenantId, companyId, name: stage.name, stageType: stage.type, systemKey: stage.systemKey ?? null,
      seedKey: stage.seedKey, createdByUserId: user, updatedByUserId: user,
    }).onConflictDoNothing();
  }
  const [existingProcess] = await tx.select({ id: recruitmentProcess.id }).from(recruitmentProcess)
    .where(and(eq(recruitmentProcess.tenantId, s.tenantId), eq(recruitmentProcess.companyId, companyId), eq(recruitmentProcess.seedKey, DEFAULT_PROCESS.seedKey)));
  if (!existingProcess) {
    const [process] = await tx.insert(recruitmentProcess).values({
      tenantId: s.tenantId, companyId, name: DEFAULT_PROCESS.name, seedKey: DEFAULT_PROCESS.seedKey, createdByUserId: user, updatedByUserId: user,
    }).onConflictDoNothing().returning({ id: recruitmentProcess.id });
    if (process) {
      const stages = await tx.select({ id: recruitmentStage.id, seedKey: recruitmentStage.seedKey }).from(recruitmentStage)
        .where(and(eq(recruitmentStage.tenantId, s.tenantId), eq(recruitmentStage.companyId, companyId)));
      const bySeed = new Map(stages.map((r) => [r.seedKey, r.id]));
      let position = 0;
      for (const stage of DEFAULT_STAGES) {
        const stageId = bySeed.get(stage.seedKey);
        if (!stageId) continue;
        position += 1;
        await tx.insert(recruitmentProcessStage).values({ tenantId: s.tenantId, companyId, processId: process.id, stageId, position });
      }
    }
  }
  let position = 0;
  for (const reason of DEFAULT_ARCHIVE_REASONS) {
    position += 10;
    await tx.insert(recruitmentArchiveReason).values({
      tenantId: s.tenantId, companyId, internalReason: reason.internal, externalReason: reason.external, kind: 'default',
      position, seedKey: reason.seedKey, createdByUserId: user, updatedByUserId: user,
    }).onConflictDoNothing();
  }
  // Slice 2: the settings row (scorecards private, edit lock "until the stage is left", result required) and the
  // generic default evaluation form. Slice 3: the generic offer-field set (offer validity 15 days, automation off).
  await tx.insert(recruitmentCompanySetting).values({ tenantId: s.tenantId, companyId, createdByUserId: user, updatedByUserId: user }).onConflictDoNothing();
  const [hasDefaultForm] = await tx.select({ id: recruitmentEvaluationForm.id }).from(recruitmentEvaluationForm)
    .where(and(eq(recruitmentEvaluationForm.tenantId, s.tenantId), eq(recruitmentEvaluationForm.companyId, companyId), eq(recruitmentEvaluationForm.isDefault, true)));
  await tx.insert(recruitmentEvaluationForm).values({
    tenantId: s.tenantId, companyId, name: DEFAULT_EVALUATION_FORM.name, definition: DEFAULT_EVALUATION_FORM.definition, isDefault: !hasDefaultForm,
    seedKey: DEFAULT_EVALUATION_FORM.seedKey, createdByUserId: user, updatedByUserId: user,
  }).onConflictDoNothing();
  position = 0;
  for (const field of DEFAULT_OFFER_FIELDS) {
    position += 10;
    await tx.insert(recruitmentOfferField).values({
      tenantId: s.tenantId, companyId, label: field.label, fieldType: field.type, choices: [], required: field.required,
      needsApproval: field.needsApproval, private: field.private, position, seedKey: field.seedKey, createdByUserId: user, updatedByUserId: user,
    }).onConflictDoNothing();
  }
}

/** Seed every listed company the caller administers (the pages call this when Recruitment opens). */
export async function ensureRecruitmentDefaults(s: SessionContext, companyIds: readonly string[]): Promise<void> {
  if (!companyIds.length) return;
  await withRecruitmentTenant(s, async (tx) => {
    for (const companyId of companyIds) await ensureRecruitmentDefaultsTx(tx, s, companyId);
  });
}

// ── Reads shared by several screens ─────────────────────────────────────────────────────────────────────

export type UserLabel = { id: string; name: string; active: boolean; employed: boolean };
/** Names of the company's people and recruitment administrators — for administrators and the company's job teams (5202). */
export async function userLabelsTx(tx: Tx, companyId: string): Promise<Map<string, UserLabel>> {
  const rows = await tx.execute<{ app_user_id: string; full_name: string; active: boolean; employed: boolean }>(
    sql`select * from app.recruitment_people_labels(${companyId}::uuid)`);
  return new Map(rows.map((r) => [r.app_user_id, { id: r.app_user_id, name: r.full_name, active: r.active, employed: r.employed }]));
}

export async function processStagesTx(tx: Tx, processId: string): Promise<(ProcessStage & { name: string; type: RecruitmentStageType; systemKey: string | null })[]> {
  const rows = await tx.select({
    stageId: recruitmentProcessStage.stageId, position: recruitmentProcessStage.position, enabled: recruitmentStage.enabled,
    name: recruitmentStage.name, type: recruitmentStage.stageType, systemKey: recruitmentStage.systemKey,
  }).from(recruitmentProcessStage)
    .innerJoin(recruitmentStage, eq(recruitmentStage.id, recruitmentProcessStage.stageId))
    .where(eq(recruitmentProcessStage.processId, processId))
    .orderBy(asc(recruitmentProcessStage.position));
  return rows.map((r) => ({ ...r, systemKey: r.systemKey ?? null }));
}

// ── Overview ──────────────────────────────────────────────────────────────────────────────────────────

export type RecruitmentOverview = {
  applicationsToday: number; toScreen: number; interview: number; offer: number; onboarding: number;
  openJobs: number; activeApplications: number;
  /** Slice 2: interviews starting today (not cancelled); active applications in an Interview-type stage with no
   *  upcoming interview; ended interviews where an interviewer has not submitted feedback. */
  interviewsToday: number; toBeScheduled: number; awaitingFeedback: number;
};

/**
 * Overview tiles, each one count query over the applications the caller administers:
 *   applications today — applied on today's Kuala Lumpur calendar day (lib/hr-date owns "today");
 *   to screen — active, in Application Review or a Screening-type stage;
 *   interview / offer — active, in an Interview- / Offer-type stage;
 *   onboarding — active, in the Onboarding system stage.
 */
export async function recruitmentOverview(s: SessionContext, companyIds: readonly string[]): Promise<RecruitmentOverview> {
  const empty = { applicationsToday: 0, toScreen: 0, interview: 0, offer: 0, onboarding: 0, openJobs: 0, activeApplications: 0, interviewsToday: 0, toBeScheduled: 0, awaitingFeedback: 0 };
  if (!companyIds.length) return empty;
  const now = new Date();
  const today = todayInKualaLumpur(now);
  return withRecruitmentTenant(s, async (tx) => {
    for (const id of companyIds) await assertCompanyTx(tx, id);
    const ids = uuidArray(companyIds);
    const [row] = await tx.execute<Record<keyof RecruitmentOverview, number>>(sql`
      select
        count(*) filter (where (a.applied_at at time zone 'Asia/Kuala_Lumpur')::date = ${today}::date)::int as "applicationsToday",
        count(*) filter (where a.state = 'active' and (st.system_key = 'application_review' or st.stage_type = 'screening'))::int as "toScreen",
        count(*) filter (where a.state = 'active' and st.stage_type = 'interview')::int as "interview",
        count(*) filter (where a.state = 'active' and st.stage_type = 'offer')::int as "offer",
        count(*) filter (where a.state = 'active' and st.system_key = 'onboarding')::int as "onboarding",
        (select count(*)::int from recruitment_job_opening j where j.tenant_id = ${s.tenantId}::uuid and j.company_id = any(${ids}::uuid[]) and j.status = 'open') as "openJobs",
        count(*) filter (where a.state = 'active')::int as "activeApplications",
        count(*) filter (where a.state = 'active' and st.stage_type = 'interview' and not exists (
          select 1 from recruitment_interview i where i.application_id = a.id and i.cancelled_at is null and i.starts_at > ${now.toISOString()}::timestamptz))::int as "toBeScheduled"
      from recruitment_application a
      join recruitment_stage st on st.id = a.current_stage_id
      where a.tenant_id = ${s.tenantId}::uuid and a.company_id = any(${ids}::uuid[])`);
    const [interviews] = await tx.execute<{ interviewsToday: number; awaitingFeedback: number }>(sql`
      select count(*) filter (where (i.starts_at at time zone 'Asia/Kuala_Lumpur')::date = ${today}::date)::int as "interviewsToday",
        count(*) filter (where i.starts_at + make_interval(mins => i.duration_minutes) <= ${now.toISOString()}::timestamptz
          and (select count(*) from recruitment_interview_interviewer v where v.interview_id = i.id)
            > (select count(*) from recruitment_scorecard c where c.interview_id = i.id))::int as "awaitingFeedback"
      from recruitment_interview i
      where i.tenant_id = ${s.tenantId}::uuid and i.company_id = any(${ids}::uuid[]) and i.cancelled_at is null`);
    return row ? { ...empty, ...row, ...(interviews ?? {}) } : empty;
  });
}

// ── AI Centre read (counts only) ──────────────────────────────────────────────────────────────────────

export type RecruitmentPipelineCountRow = {
  company: string; openJobs: number; onHoldJobs: number; activeApplications: number; toScreen: number;
  interview: number; offer: number; onboarding: number; hired: number; archived: number;
};
const PIPELINE_COUNT_LIMIT = 25;

/**
 * The AI Centre's ONLY recruitment read (owner decision 2026-11-10: counts, no candidates). One row per company
 * the caller administers recruitment for, holding the company's name and whole-number counts. It never selects
 * a candidate, application, job title, job number, person, user, reason or note — so nothing a model sees can
 * identify an applicant. The same database predicate as every other entry point (app.can_admin_recruitment_for)
 * picks the companies, and row security on the counted tables applies again.
 *
 * With `existingTx` it joins the Assistant's admitted transaction (withCanonicalAiReadTx re-proves the AI principal
 * and the Recruitment entitlement); without one it opens its own module-gated transaction.
 */
export async function recruitmentPipelineCounts(
  s: SessionContext, existingTx?: Tx,
): Promise<{ rows: RecruitmentPipelineCountRow[]; truncated: boolean }> {
  return withCanonicalAiReadTx(s, existingTx, 'recruitment', withRecruitmentTenant, async (tx) => {
    const rows = await tx.execute<RecruitmentPipelineCountRow>(sql`
      select c.legal_name as company,
        (select count(*)::int from recruitment_job_opening j where j.tenant_id = c.tenant_id and j.company_id = c.id and j.status = 'open') as "openJobs",
        (select count(*)::int from recruitment_job_opening j where j.tenant_id = c.tenant_id and j.company_id = c.id and j.status = 'on_hold') as "onHoldJobs",
        count(a.id) filter (where a.state = 'active')::int as "activeApplications",
        count(a.id) filter (where a.state = 'active' and (st.system_key = 'application_review' or st.stage_type = 'screening'))::int as "toScreen",
        count(a.id) filter (where a.state = 'active' and st.stage_type = 'interview')::int as "interview",
        count(a.id) filter (where a.state = 'active' and st.stage_type = 'offer')::int as "offer",
        count(a.id) filter (where a.state = 'active' and st.system_key = 'onboarding')::int as "onboarding",
        count(a.id) filter (where a.state = 'hired')::int as "hired",
        count(a.id) filter (where a.state = 'archived')::int as "archived"
      from company c
      left join recruitment_application a on a.tenant_id = c.tenant_id and a.company_id = c.id
      left join recruitment_stage st on st.id = a.current_stage_id
      where c.tenant_id = ${s.tenantId}::uuid and c.archived_at is null and app.can_admin_recruitment_for(c.id)
      group by c.id, c.tenant_id, c.legal_name
      order by c.legal_name, c.id
      limit ${PIPELINE_COUNT_LIMIT + 1}`);
    return {
      rows: rows.slice(0, PIPELINE_COUNT_LIMIT).map((r) => ({
        company: r.company, openJobs: r.openJobs, onHoldJobs: r.onHoldJobs, activeApplications: r.activeApplications,
        toScreen: r.toScreen, interview: r.interview, offer: r.offer, onboarding: r.onboarding, hired: r.hired, archived: r.archived,
      })),
      truncated: rows.length > PIPELINE_COUNT_LIMIT,
    };
  });
}

// ── Positions (job openings) ─────────────────────────────────────────────────────────────────────────

export type JobListFilters = {
  tab?: 'opening' | 'closed'; title?: string; jobNumber?: string; departmentId?: string; recruiterUserId?: string;
  /** Slice 14: one custom job field and answer, `<field id>:<option id|yes|no>`. */
  custom?: string;
};
export type JobListRow = {
  id: string; jobNumber: string; title: string; status: JobStatus; companyId: string; companyName: string;
  departmentName: string | null; workLocation: string; recruiterUserId: string | null; recruiterName: string | null;
  candidates: number; hired: number; onboarding: number;
};
export type JobList = {
  rows: JobListRow[]; counts: { opening: number; closed: number };
  /** Filter choices: the departments and recruiters that appear on any job in view. */
  departments: { id: string; name: string }[]; recruiters: { id: string; name: string }[];
  /** Slice 14: the custom job fields the list may filter by (enabled, not restricted, choice or yes/no), and the filter applied. */
  customFilters: CustomFilterChoice[]; customFilter: string | null;
};

export async function listJobs(s: SessionContext, companyIds: readonly string[], filters: JobListFilters = {}): Promise<JobList> {
  if (!companyIds.length) return { rows: [], counts: { opening: 0, closed: 0 }, departments: [], recruiters: [], customFilters: [], customFilter: null };
  return withRecruitmentTenant(s, async (tx) => {
    // Administrators list every job of the company; a team member's row security lists only their own jobs (5202).
    for (const id of companyIds) await assertSeeCompanyTx(tx, id);
    const ids = uuidArray(companyIds);
    const title = filters.title?.trim() ? `%${filters.title.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const number = filters.jobNumber?.trim() ? filters.jobNumber.trim().toUpperCase() : null;
    const department = filters.departmentId && isUuid(filters.departmentId) ? filters.departmentId : null;
    const recruiter = filters.recruiterUserId && isUuid(filters.recruiterUserId) ? filters.recruiterUserId : null;
    const customFilters = await customFilterChoicesTx(tx, s, companyIds, 'job');
    const custom = customFilterSql(customFilters, filters.custom, 'job', sql`j.id`);
    const where = sql`j.tenant_id = ${s.tenantId}::uuid and j.company_id = any(${ids}::uuid[])
      and (${title}::text is null or j.title ilike ${title}::text)
      and (${number}::text is null or j.job_number = ${number}::text)
      and (${department}::uuid is null or j.department_id = ${department}::uuid)
      and (${recruiter}::uuid is null or exists (select 1 from recruitment_job_member m where m.job_id = j.id and m.member_role = 'recruiter' and m.app_user_id = ${recruiter}::uuid))
      ${custom.condition}`;
    const [counts] = await tx.execute<{ opening: number; closed: number }>(sql`
      select count(*) filter (where j.status <> 'closed')::int as opening, count(*) filter (where j.status = 'closed')::int as closed
      from recruitment_job_opening j where ${where}`);
    const tab = filters.tab === 'closed' ? 'closed' : 'opening';
    const rows = await tx.execute<{
      id: string; job_number: string; title: string; status: JobStatus; company_id: string; company_name: string; department_name: string | null;
      work_location: string; recruiter_user_id: string | null; candidates: number; hired: number; onboarding: number;
    }>(sql`
      select j.id, j.job_number, j.title, j.status, j.company_id, c.legal_name as company_name, d.name as department_name, j.work_location,
        (select m.app_user_id from recruitment_job_member m where m.job_id = j.id and m.member_role = 'recruiter') as recruiter_user_id,
        (select count(*)::int from recruitment_application a where a.job_id = j.id) as candidates,
        (select count(*)::int from recruitment_application a where a.job_id = j.id and a.state = 'hired') as hired,
        (select count(*)::int from recruitment_application a join recruitment_stage st on st.id = a.current_stage_id
          where a.job_id = j.id and a.state = 'active' and st.system_key = 'onboarding') as onboarding
      from recruitment_job_opening j
      join company c on c.id = j.company_id
      left join department d on d.id = j.department_id
      where ${where} and ${tab === 'closed' ? sql`j.status = 'closed'` : sql`j.status <> 'closed'`}
      order by j.created_at desc, j.job_number desc`);
    const labels = new Map<string, UserLabel>();
    for (const id of companyIds) for (const [k, v] of await userLabelsTx(tx, id)) labels.set(k, v);
    const departments = await tx.execute<{ id: string; name: string }>(sql`
      select distinct d.id, d.name from recruitment_job_opening j join department d on d.id = j.department_id
      where j.tenant_id = ${s.tenantId}::uuid and j.company_id = any(${ids}::uuid[]) order by d.name`);
    const recruiterIds = await tx.execute<{ id: string }>(sql`
      select distinct m.app_user_id as id from recruitment_job_member m
      where m.tenant_id = ${s.tenantId}::uuid and m.company_id = any(${ids}::uuid[]) and m.member_role = 'recruiter'`);
    return {
      customFilters, customFilter: custom.filter ? customFilterKey(custom.filter) : null,
      departments: [...departments],
      recruiters: recruiterIds.map((r) => ({ id: r.id, name: labels.get(r.id)?.name ?? '' })).sort((a, b) => a.name.localeCompare(b.name)),
      counts: counts ?? { opening: 0, closed: 0 },
      rows: rows.map((r) => ({
        id: r.id, jobNumber: r.job_number, title: r.title, status: r.status, companyId: r.company_id, companyName: r.company_name,
        departmentName: r.department_name, workLocation: r.work_location, recruiterUserId: r.recruiter_user_id,
        recruiterName: r.recruiter_user_id ? labels.get(r.recruiter_user_id)?.name ?? null : null,
        candidates: r.candidates, hired: r.hired, onboarding: r.onboarding,
      })),
    };
  });
}

export type JobFormOptions = {
  companyId: string;
  processes: { id: string; name: string; enabled: boolean }[];
  grades: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  businessUnits: { id: string; name: string }[];
  users: UserLabel[];
  /** Slice 14: the company's enabled custom job fields, in order (no values: a new job). */
  customFields: CustomFieldView[];
  /** Slice 15: the company's evaluation forms (scorecard templates) for an interview plan; disabled ones are offered only where a
   *  plan already holds them. */
  forms: { id: string; name: string; enabled: boolean; isDefault: boolean }[];
};

/** Everything a job form for `companyId` offers. Seeds the company's defaults first. */
export async function jobFormOptions(s: SessionContext, companyId: string): Promise<JobFormOptions> {
  return withRecruitmentTenant(s, async (tx) => {
    await ensureRecruitmentDefaultsTx(tx, s, companyId);
    return jobFormOptionsTx(tx, s, companyId);
  });
}
/** The same, read-only (no seeding): slice 15's template editor and "New position from template". */
export async function jobFormOptionsTx(tx: Tx, s: SessionContext, companyId: string): Promise<JobFormOptions> {
  const processes = await tx.select({ id: recruitmentProcess.id, name: recruitmentProcess.name, enabled: recruitmentProcess.enabled })
    .from(recruitmentProcess).where(and(eq(recruitmentProcess.tenantId, s.tenantId), eq(recruitmentProcess.companyId, companyId)))
    .orderBy(asc(recruitmentProcess.name));
  const grades = await tx.execute<{ id: string; name: string }>(sql`
    select g.id, g.name from job_grade g where g.tenant_id = ${s.tenantId}::uuid and g.archived_at is null
      and (g.scope_company_ids is null or cardinality(g.scope_company_ids) = 0 or ${companyId}::uuid = any(g.scope_company_ids))
    order by g.rank, g.name`);
  const departments = await tx.execute<{ id: string; name: string }>(sql`
    select d.id, d.name from department d where d.tenant_id = ${s.tenantId}::uuid and d.archived_at is null
      and (d.company_id = ${companyId}::uuid or d.is_global) order by d.name`);
  const businessUnits = await tx.execute<{ id: string; name: string }>(sql`
    select b.id, b.name from business_unit b where b.tenant_id = ${s.tenantId}::uuid and b.archived_at is null
      and (b.company_id = ${companyId}::uuid or b.is_global) order by b.name`);
  const users = [...(await userLabelsTx(tx, companyId)).values()].filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name));
  const customFields = await newRecordCustomFieldsTx(tx, s, 'job', companyId);
  const forms = await tx.select({ id: recruitmentEvaluationForm.id, name: recruitmentEvaluationForm.name, enabled: recruitmentEvaluationForm.enabled, isDefault: recruitmentEvaluationForm.isDefault })
    .from(recruitmentEvaluationForm).where(and(eq(recruitmentEvaluationForm.tenantId, s.tenantId), eq(recruitmentEvaluationForm.companyId, companyId)))
    .orderBy(sql`${recruitmentEvaluationForm.isDefault} desc`, asc(recruitmentEvaluationForm.name));
  return { companyId, processes, grades: [...grades], departments: [...departments], businessUnits: [...businessUnits], users, customFields, forms };
}

/**
 * Slice 15: an interview plan's forms that are NEW to it (not in `kept`) must be enabled evaluation forms of the company; a form the
 * plan already held may since have been disabled (5216's job guard allows the same).
 */
async function assertPlanFormsTx(tx: Tx, s: SessionContext, companyId: string, plan: readonly string[], kept: readonly string[] = []): Promise<void> {
  const added = [...new Set(plan.filter((id) => !kept.includes(id)))];
  if (!added.length) return;
  const [row] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_evaluation_form
    where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid and enabled and id = any(${uuidArray(added)}::uuid[])`);
  if ((row?.n ?? 0) !== added.length) throw new RecruitmentError('invalid_input', ['interviewPlan']);
}

/** Grades must be live grades of this tenant offered to the company. */
async function assertGradesTx(tx: Tx, s: SessionContext, companyId: string, gradeIds: readonly string[]): Promise<void> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from job_grade g where g.tenant_id = ${s.tenantId}::uuid and g.archived_at is null
      and g.id = any(${uuidArray(gradeIds)}::uuid[])
      and (g.scope_company_ids is null or cardinality(g.scope_company_ids) = 0 or ${companyId}::uuid = any(g.scope_company_ids))`);
  if ((row?.n ?? 0) !== gradeIds.length) throw new RecruitmentError('invalid_input', ['jobLevel']);
}

async function defaultProcessTx(tx: Tx, s: SessionContext, companyId: string): Promise<string> {
  const [row] = await tx.select({ id: recruitmentProcess.id }).from(recruitmentProcess)
    .where(and(eq(recruitmentProcess.tenantId, s.tenantId), eq(recruitmentProcess.companyId, companyId), eq(recruitmentProcess.enabled, true)))
    .orderBy(sql`(${recruitmentProcess.seedKey} is null)`, asc(recruitmentProcess.createdAt));
  if (!row) throw new RecruitmentError('process_unavailable');
  return row.id;
}

async function assertProcessUsableTx(tx: Tx, s: SessionContext, companyId: string, processId: string): Promise<void> {
  const [row] = await tx.select({ enabled: recruitmentProcess.enabled }).from(recruitmentProcess)
    .where(and(eq(recruitmentProcess.id, processId), eq(recruitmentProcess.tenantId, s.tenantId), eq(recruitmentProcess.companyId, companyId)));
  if (!row?.enabled) throw new RecruitmentError('process_unavailable');
  if (!firstStage(await processStagesTx(tx, processId))) throw new RecruitmentError('process_unavailable');
}

function validJob(input: JobInput): ValidJob {
  const result = validateJobInput(input);
  if (!result.ok) throw new RecruitmentError(result.code, result.fields);
  return result.value;
}

/** Create a job opening. Required fields are refused here whatever the form sent; the number is allocated in SQL. */
export async function createJob(s: SessionContext, input: JobInput & { recruiterUserId?: unknown; requisitionId?: unknown; custom?: RawCustomValues; templateId?: unknown }): Promise<{ id: string; jobNumber: string }> {
  const job = validJob(input);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    await ensureRecruitmentDefaultsTx(tx, s, job.companyId);
    await assertGradesTx(tx, s, job.companyId, job.jobGradeIds);
    const processId = job.processId ?? await defaultProcessTx(tx, s, job.companyId);
    await assertProcessUsableTx(tx, s, job.companyId, processId);
    // Slice 15: the plan's forms, and the template the job starts from (recorded for reporting only; every rule above and below is
    // the normal one). The template must be an ENABLED one of this company while the company's setting is on (5216 refuses too).
    const interviewPlanFormIds = job.interviewPlanFormIds ?? [];
    await assertPlanFormsTx(tx, s, job.companyId, interviewPlanFormIds);
    let templateId: string | null = null;
    if (input.templateId != null && input.templateId !== '') {
      if (!isUuid(input.templateId)) throw new RecruitmentError('template_unavailable');
      const [tpl] = await tx.execute<{ id: string }>(sql`select t.id from recruitment_position_template t
        join recruitment_company_setting cs on cs.company_id = t.company_id and cs.tenant_id = t.tenant_id and cs.position_templates_enabled
        where t.id = ${input.templateId}::uuid and t.tenant_id = ${s.tenantId}::uuid and t.company_id = ${job.companyId}::uuid and t.enabled`);
      if (!tpl) throw new RecruitmentError('template_unavailable');
      templateId = tpl.id;
    }
    const [row] = await tx.insert(recruitmentJobOpening).values({
      tenantId: s.tenantId, companyId: job.companyId, jobNumber: 'MJ000000', title: job.title, description: job.description,
      jobGradeIds: job.jobGradeIds, workLocation: job.workLocation, recruitmentType: job.recruitmentType, employmentType: job.employmentType,
      replacedEmploymentId: job.replacedEmploymentId, businessUnitId: job.businessUnitId, departmentId: job.departmentId,
      positionAttribute: job.positionAttribute, processId, autoArchiveAfterReject: job.autoArchiveAfterReject,
      interviewPlanFormIds, createdFromTemplateId: templateId,
      createdByUserId: user, updatedByUserId: user,
    }).returning({ id: recruitmentJobOpening.id, jobNumber: recruitmentJobOpening.jobNumber });
    if (isUuid(input.recruiterUserId)) await addMemberTx(tx, s, row.id, job.companyId, 'recruiter', input.recruiterUserId);
    // Slice 4 — "Create job" from a requisition associates the new job with it (many jobs to one requisition).
    let requisitionId: string | null = null;
    if (input.requisitionId != null && input.requisitionId !== '') {
      if (!isUuid(input.requisitionId)) throw new RecruitmentError('invalid_input', ['requisition']);
      const [req] = await tx.execute<{ id: string; status: string }>(sql`
        select id, status from recruitment_requisition where id = ${input.requisitionId}::uuid and tenant_id = ${s.tenantId}::uuid and company_id = ${job.companyId}::uuid`);
      if (!req) throw new RecruitmentError('invalid_input', ['requisition']);
      if (req.status === 'completed' || req.status === 'cancelled') throw new RecruitmentError('requisition_terminal');
      await tx.insert(recruitmentRequisitionJob).values({ tenantId: s.tenantId, companyId: job.companyId, requisitionId: req.id, jobId: row.id, createdByUserId: user });
      requisitionId = req.id;
    }
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: row.id, eventType: 'recruitment-job.created', actor: actorOf(s),
      payload: { companyId: job.companyId, jobNumber: row.jobNumber, processId, requisitionId, templateId, interviewRounds: interviewPlanFormIds.length },
    });
    // Slice 14: the custom job fields of the form, checked (type, range, options, required) and saved with the job — all or nothing.
    if (input.custom) await saveRecordCustomValuesTx(tx, s, 'job', { id: row.id, companyId: job.companyId }, input.custom);
    return row;
  });
}

/** The job, if the caller may see it, checked at `level`: 'admin' administers the company; the others are per-job (5202). */
export async function jobTx(tx: Tx, s: SessionContext, jobId: string, level: 'admin' | JobLevel = 'admin') {
  if (!isUuid(jobId)) throw new RecruitmentError('not_found');
  const [job] = await tx.select().from(recruitmentJobOpening)
    .where(and(eq(recruitmentJobOpening.id, jobId), eq(recruitmentJobOpening.tenantId, s.tenantId)));
  if (!job) throw new RecruitmentError('not_found');
  if (level === 'admin') await assertCompanyTx(tx, job.companyId);
  else await assertJobLevelTx(tx, job.companyId, job.id, level);
  return job;
}
async function jobHasApplicationsTx(tx: Tx, jobId: string): Promise<boolean> {
  const [row] = await tx.execute<{ any: boolean }>(sql`select exists (select 1 from recruitment_application a where a.job_id = ${jobId}::uuid) as any`);
  return row?.any === true;
}

export type JobDetail = {
  job: typeof recruitmentJobOpening.$inferSelect;
  companyName: string;
  hasApplications: boolean;
  members: { id: string; role: JobMemberRole; userId: string; name: string | null }[];
  stages: { stageId: string; name: string; enabled: boolean; position: number; active: number }[];
  hired: number; archived: number;
  /** The administrator's edit choices; null for a team member, who sees the job read-only (slice 2). */
  options: JobFormOptions | null;
  manage: boolean;
  /** The requisition this job belongs to (slice 4), if any. */
  requisition: { id: string; reqNumber: string; title: string } | null;
  /** Slice 14: the company's enabled custom job fields, in order, with this job's values (anyone who may read the job). */
  custom: CustomFieldView[];
};

export async function getJob(s: SessionContext, jobId: string): Promise<JobDetail> {
  return withRecruitmentTenant(s, async (tx) => {
    if (!isUuid(jobId)) throw new RecruitmentError('not_found');
    const [visible] = await tx.select({ companyId: recruitmentJobOpening.companyId }).from(recruitmentJobOpening)
      .where(and(eq(recruitmentJobOpening.id, jobId), eq(recruitmentJobOpening.tenantId, s.tenantId)));
    if (!visible) throw new RecruitmentError('not_found');
    const [admin] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_recruitment_for(${visible.companyId}::uuid) as ok`);
    const manage = admin?.ok === true;
    const job = await jobTx(tx, s, jobId, manage ? 'admin' : 'read');
    const [company] = await tx.execute<{ name: string }>(sql`select legal_name as name from company where id = ${job.companyId}::uuid`);
    const options = manage ? await jobFormOptionsTx(tx, s, job.companyId) : null;
    const [requisition] = manage ? await tx.execute<{ id: string; req_number: string; title: string }>(sql`
      select r.id, r.req_number, r.title from recruitment_requisition_job rj join recruitment_requisition r on r.id = rj.requisition_id
      where rj.job_id = ${job.id}::uuid`) : [];
    const labels = await userLabelsTx(tx, job.companyId);
    const members = await tx.select({ id: recruitmentJobMember.id, role: recruitmentJobMember.memberRole, userId: recruitmentJobMember.appUserId })
      .from(recruitmentJobMember).where(eq(recruitmentJobMember.jobId, job.id)).orderBy(asc(recruitmentJobMember.createdAt));
    const counts = await tx.execute<{ stage_id: string; state: ApplicationState; n: number }>(sql`
      select current_stage_id as stage_id, state, count(*)::int as n from recruitment_application where job_id = ${job.id}::uuid group by 1, 2`);
    const stages = (await processStagesTx(tx, job.processId)).map((st) => ({
      stageId: st.stageId, name: st.name, enabled: st.enabled, position: st.position,
      active: counts.filter((c) => c.stage_id === st.stageId && c.state === 'active').reduce((n, c) => n + c.n, 0),
    }));
    const custom = await recordCustomFieldsTx(tx, s, 'job', { id: job.id, companyId: job.companyId }, false);
    return {
      job, companyName: company?.name ?? '', hasApplications: counts.length > 0, options, stages, manage, custom,
      requisition: requisition ? { id: requisition.id, reqNumber: requisition.req_number, title: requisition.title } : null,
      hired: counts.filter((c) => c.state === 'hired').reduce((n, c) => n + c.n, 0),
      archived: counts.filter((c) => c.state === 'archived').reduce((n, c) => n + c.n, 0),
      members: members.map((m) => ({ ...m, name: labels.get(m.userId)?.name ?? null })),
    };
  });
}

/**
 * Edit a job's information and settings. The company and position attribute never change; the process is
 * refused once the job has an application — and that refusal is AUDITED: it is recorded as its own domain
 * event in a committed transaction before the error reaches the caller.
 */
export async function updateJob(s: SessionContext, jobId: string, input: JobInput & { custom?: RawCustomValues }): Promise<void> {
  const user = actorId(s);
  const refused = await withRecruitmentTenant(s, async (tx) => {
    const current = await jobTx(tx, s, jobId);
    const job = validJob({ ...input, companyId: current.companyId, positionAttribute: input.positionAttribute ?? current.positionAttribute });
    if (job.positionAttribute !== current.positionAttribute) throw new RecruitmentError('invalid_input', ['positionAttribute']);
    const processId = job.processId ?? current.processId;
    if (processId !== current.processId) {
      if (processChangeRefused(current.processId, processId, await jobHasApplicationsTx(tx, current.id))) {
        await appendEvent(tx, {
          tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: current.id, eventType: 'recruitment-job.process-change-refused',
          actor: actorOf(s), payload: { companyId: current.companyId, processId: current.processId, requestedProcessId: processId, reason: 'has_applications' },
        });
        return true;
      }
      await assertProcessUsableTx(tx, s, current.companyId, processId);
    }
    await assertGradesTx(tx, s, current.companyId, job.jobGradeIds);
    // Slice 15: the interview plan, when the form carried it (Job settings and New position); otherwise it stays as it is.
    if (job.interviewPlanFormIds) await assertPlanFormsTx(tx, s, current.companyId, job.interviewPlanFormIds, current.interviewPlanFormIds);
    await tx.update(recruitmentJobOpening).set({
      title: job.title, description: job.description, jobGradeIds: job.jobGradeIds, workLocation: job.workLocation,
      recruitmentType: job.recruitmentType, employmentType: job.employmentType, replacedEmploymentId: job.replacedEmploymentId,
      businessUnitId: job.businessUnitId, departmentId: job.departmentId, processId, autoArchiveAfterReject: job.autoArchiveAfterReject,
      ...(job.interviewPlanFormIds ? { interviewPlanFormIds: job.interviewPlanFormIds } : {}),
      updatedAt: sql`now()`, updatedByUserId: user,
    }).where(eq(recruitmentJobOpening.id, current.id));
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: current.id, eventType: 'recruitment-job.updated', actor: actorOf(s),
      payload: { companyId: current.companyId, processId, processChanged: processId !== current.processId },
    });
    // Slice 14: the Job info form carries the custom job fields (the settings form does not, and leaves them as they are).
    if (input.custom) await saveRecordCustomValuesTx(tx, s, 'job', { id: current.id, companyId: current.companyId }, input.custom);
    return false;
  });
  if (refused) throw new RecruitmentError('process_locked');
}

/** Open ↔ On hold, Open / On hold → Closed, Closed → Open. */
export async function changeJobStatus(s: SessionContext, jobId: string, to: unknown): Promise<void> {
  if (typeof to !== 'string' || !(JOB_STATUSES as readonly string[]).includes(to)) throw new RecruitmentError('invalid_status_change');
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId);
    if (!canChangeJobStatus(job.status, to as JobStatus)) throw new RecruitmentError('invalid_status_change');
    await tx.update(recruitmentJobOpening).set({ status: to as JobStatus, updatedAt: sql`now()`, updatedByUserId: user })
      .where(eq(recruitmentJobOpening.id, job.id));
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: job.id, eventType: 'recruitment-job.status-changed', actor: actorOf(s),
      payload: { companyId: job.companyId, from: job.status, to },
    });
  });
}

async function addMemberTx(tx: Tx, s: SessionContext, jobId: string, companyId: string, role: JobMemberRole, userId: string): Promise<void> {
  const labels = await userLabelsTx(tx, companyId);
  if (!labels.get(userId)?.active) throw new RecruitmentError('invalid_input', ['member']);
  if (role === 'recruiter') await tx.delete(recruitmentJobMember).where(and(eq(recruitmentJobMember.jobId, jobId), eq(recruitmentJobMember.memberRole, 'recruiter')));
  await tx.insert(recruitmentJobMember).values({ tenantId: s.tenantId, companyId, jobId, memberRole: role, appUserId: userId, createdByUserId: actorId(s) })
    .onConflictDoNothing();
}

/** Add a team member. A job has one recruiter: naming a new one replaces the previous recruiter. */
export async function addJobMember(s: SessionContext, jobId: string, role: unknown, userId: unknown): Promise<void> {
  if (typeof role !== 'string' || !(JOB_MEMBER_ROLES as readonly string[]).includes(role) || !isUuid(userId)) throw new RecruitmentError('invalid_input', ['member']);
  await withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId);
    await addMemberTx(tx, s, job.id, job.companyId, role as JobMemberRole, userId);
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: job.id, eventType: 'recruitment-job.member-added', actor: actorOf(s),
      payload: { companyId: job.companyId, role, appUserId: userId },
    });
  });
}

export async function removeJobMember(s: SessionContext, jobId: string, memberId: unknown): Promise<void> {
  if (!isUuid(memberId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId);
    const removed = await tx.delete(recruitmentJobMember).where(and(eq(recruitmentJobMember.id, memberId), eq(recruitmentJobMember.jobId, job.id)))
      .returning({ role: recruitmentJobMember.memberRole, userId: recruitmentJobMember.appUserId });
    if (!removed.length) throw new RecruitmentError('not_found');
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: job.id, eventType: 'recruitment-job.member-removed', actor: actorOf(s),
      payload: { companyId: job.companyId, role: removed[0].role, appUserId: removed[0].userId },
    });
  });
}

// ── Candidates and applications ─────────────────────────────────────────────────────────────────────

export type StageTab = { key: string; stageId: string | null; name: string; count: number };
export type ApplicationCard = {
  id: string; candidateName: string; email: string | null; phone: string | null; jobId: string; jobTitle: string; jobNumber: string;
  source: string | null; appliedAt: string; ownerName: string | null; state: ApplicationState; stageId: string; stageName: string;
  archiveReason: string | null; companyId: string;
  /** Slice 2: what the viewer may do on this card's job (database predicates). */
  canReview: boolean; canOperate: boolean;
  /** Slice 5: the candidate's tags the viewer may see (row security: reviewers, not interviewers); a removed candidate. */
  candidateId: string; tags: { id: string; name: string }[]; removed: boolean;
  /** Slice 11: the screening assignment status, for the job's operators and administrators only (null for anyone else). */
  screeningStatus: AssignmentStatus | null;
  /** Slice 12: a background check marker (Concerns found, else In progress), for the job's operators and administrators only. */
  backgroundCheck: CheckMarker | null;
  /** Slice 13: the application needs an administrator's review (a blocked-list mark) — a yes/no for anyone who reads the card;
   *  and the candidate's custom pools the viewer can see (operators and administrators of the card's job; empty otherwise). */
  needsReview: boolean; pools: { id: string; label: string }[];
  /** Slice 17: past its stage's reminder — "Waiting <days> days in <stage>" — for the job's reviewers (hiring managers included) and
   *  administrators; `suggested` (past the suggest-archiving threshold) for its operators and administrators only (null otherwise). */
  waiting: { days: number; stageName: string; suggested: boolean | null } | null;
};
export type CandidateBoard = {
  tabs: StageTab[]; cards: ApplicationCard[];
  /** Slice 5: tags the viewer may filter by (enabled or not: a disabled tag still finds its candidates). */
  tagOptions: { id: string; name: string; groupName: string }[];
  /** Slice 14: the custom candidate fields the board may filter by (enabled, not restricted, choice or yes/no), and the filter
   *  applied (it narrows the tab counts and the cards alike). */
  customFilters: CustomFilterChoice[]; customFilter: string | null;
  /** The jobs in view; `canOperate` marks those the viewer may add applications to (slice 2). */
  jobs: { id: string; title: string; jobNumber: string; status: JobStatus; companyId: string; canOperate: boolean }[];
  reasons: { id: string; internal: string; external: string; companyId: string }[];
  nextStage: Record<string, { stageId: string; name: string } | 'hired'>;
  moveTargets: Record<string, { stageId: string; name: string }[]>;
  /** Slice 11, on a stage tab only: the selected stage's applications by screening assignment status (the jobs in view the
   *  viewer operates only; the SCREENING_STATUS_WINDOW most recent — `capped` when the stage has more), and the status filter
   *  applied (within the same window); null on Hired and Archived, or when the viewer operates none of the jobs in view. */
  screening: { counts: Record<AssignmentStatus, number>; filter: AssignmentStatus | null; capped: boolean } | null;
  /** Slice 17: when a stage in view has a waiting rule and the viewer reviews a job in view — per stage with a rule, how many active
   *  applications are past the reminder (`waiting`) and past the suggest-archiving threshold (`suggested`, over the jobs the viewer
   *  operates; null when they operate none) under the other filters, and the waiting filter applied (it narrows the tab counts and
   *  the cards alike). Each stage's counts and filter cover at most WAITING_SCAN_LIMIT of its active applications (and the board at most
   *  WAITING_BOARD_SCAN_LIMIT in all), least recently updated first (`capped` when there were more: the counts are then lower bounds,
   *  "N+"). Null otherwise. */
  waiting: { counts: Record<string, { waiting: number; suggested: number | null; capped: boolean }>; filter: WaitingFilter | null } | null;
};

/**
 * The assignment status of the application aliased `a` (slice 11, EV-052, D-042), as SQL text: an OPEN request (no answer
 * yet, or its latest answer Pending) → awaiting; otherwise the most recent FINAL answer (Advance or Reject) from any reviewer
 * (answered time, then id) → positive or negative; otherwise (never sent, or every request withdrawn or closed without a final
 * answer) → not_assigned. The same rule as screening-model.ts assignmentStatus. Indexed: requests and answers by application.
 * Read under the viewer's row security, so it is only shown for jobs the viewer operates (who see every request and answer).
 * Written as LIMIT 1 scalar subqueries so each application is one probe of the open-request and answer indexes (an EXISTS
 * here may be planned as a hashed scan of the tenant's open requests, which grows with the tenant, not the window).
 */
export const screeningStatusSql = sql`(case
  when (select 1 from recruitment_screening_request q where q.application_id = a.id and q.closed_at is null limit 1) is not null then 'awaiting'
  else coalesce(
    (select case x.result when 'advance' then 'positive' else 'negative' end
     from recruitment_screening_answer x where x.application_id = a.id and x.result in ('advance', 'reject') order by x.answered_at desc, x.id desc limit 1),
    'not_assigned')
  end)`;

/**
 * The pipeline board. Tabs are the stages of the processes in view (the selected job's process, or every
 * process of the companies in view, ordered by position), each with its live count of ACTIVE applications,
 * followed by the Hired and Archived buckets.
 */
export async function candidateBoard(s: SessionContext, companyIds: readonly string[], filter: { jobId?: string; tab?: string; tagId?: string; screening?: string; custom?: string; waiting?: string } = {}): Promise<CandidateBoard> {
  if (!companyIds.length) return { tabs: [], cards: [], jobs: [], reasons: [], nextStage: {}, moveTargets: {}, tagOptions: [], screening: null, customFilters: [], customFilter: null, waiting: null };
  return withRecruitmentTenant(s, async (tx) => {
    // Administrators see the company's pipeline; a team member's row security narrows it to their jobs' applications
    // and the applications they interview (5202). Every count below runs under the same row security.
    for (const id of companyIds) await assertSeeCompanyTx(tx, id);
    const ids = uuidArray(companyIds);
    const jobs = await tx.execute<{ id: string; title: string; job_number: string; status: JobStatus; company_id: string; process_id: string }>(sql`
      select j.id, j.title, j.job_number, j.status, j.company_id, j.process_id from recruitment_job_opening j
      where j.tenant_id = ${s.tenantId}::uuid and j.company_id = any(${ids}::uuid[]) order by j.status = 'closed', j.title, j.job_number`);
    const job = filter.jobId && isUuid(filter.jobId) ? jobs.find((j) => j.id === filter.jobId) : undefined;
    const processIds = job ? [job.process_id] : [...new Set(jobs.map((j) => j.process_id))];
    const stageRows = processIds.length ? await tx.execute<{ stage_id: string; name: string; position: number }>(sql`
      select ps.stage_id, st.name, min(ps.position)::int as position from recruitment_process_stage ps
      join recruitment_stage st on st.id = ps.stage_id
      where ps.process_id = any(${uuidArray(processIds)}::uuid[]) group by ps.stage_id, st.name order by 3, 2`) : [];
    // Slice 5: the tag filter reads recruitment_candidate_tag under row security, so it finds nothing for a viewer who
    // may not see the candidate's tags (an interviewer).
    const tagId = filter.tagId && isUuid(filter.tagId) ? filter.tagId : null;
    // Slice 14: one custom candidate field and answer; the open values table under the viewer's row security (anyone who reads
    // the candidate reads their open values; restricted fields are not offered).
    const customFilters = await customFilterChoicesTx(tx, s, companyIds, 'candidate');
    const custom = customFilterSql(customFilters, filter.custom, 'candidate', sql`a.candidate_id`);
    const baseFilter = sql`${job ? sql`and a.job_id = ${job.id}::uuid` : sql``} ${tagId ? sql`and exists (select 1 from recruitment_candidate_tag ct
      where ct.candidate_id = a.candidate_id and ct.tag_id = ${tagId}::uuid)` : sql``} ${custom.condition}`;
    const access = new Map<string, { review: boolean; operate: boolean }>();
    for (const j of jobs) access.set(j.id, await jobLevelTx(tx, j.company_id, j.id));
    // Slice 17: waiting limits for the stages in view, on the jobs the viewer reviews (the suggestion: the jobs they operate). The
    // rules and, for working days, the companies' holidays are read once; the cutoffs go to one set-based statement (./waiting-store).
    const reviewed = jobs.filter((j) => access.get(j.id)?.review).map((j) => j.id);
    const operatedJobs = jobs.filter((j) => access.get(j.id)?.operate).map((j) => j.id);
    const today = todayInKualaLumpur();
    const waitCtx = await waitingContextTx(tx, s.tenantId, reviewed.length ? [...new Set(jobs.filter((j) => reviewed.includes(j.id)).map((j) => j.company_id))] : [], today);
    const ruleStages = stageRows.map((r) => r.stage_id).filter((id) => waitCtx.cutoffs.has(id));
    const rules = reviewed.length ? cutoffRelation(waitCtx, 'wr', ruleStages) : null;
    const askedWaiting = rules ? parseWaitingFilter(filter.waiting) : null;
    const waitingFilter = askedWaiting === 'suggested' && !operatedJobs.length ? null : askedWaiting;
    // One bounded statement per board. The active applications of the stages with a limit (jobs the viewer reviews, under the other
    // filters) are read least recently updated first — updated_at is only a sort key (a move sets it, so long-unchanged applications,
    // the likely matches, come first); every count comes from the history, and rows not read are flagged "+" — at most WAITING_SCAN_LIMIT per stage and WAITING_BOARD_SCAN_LIMIT in all (+1 to know there are
    // more); only those kept are looked up in the history. An application can only have waited N days if it was received N days ago,
    // so newer ones are passed over first. The waiting filter is then the ids found here (at most WAITING_BOARD_SCAN_LIMIT), so the
    // tab counts and cards never re-run the history lookup. A stage reads "capped" (counts are lower bounds) when it had more rows
    // than its share, or when the whole scan stopped at its total.
    const scan = rules ? await tx.execute<{ stage_id: string | null; waiting: number; suggested: number; capped: boolean; total: number; waiting_ids: string[]; suggested_ids: string[] }>(sql`
      with p as materialized (
        select a.id, a.current_stage_id, a.applied_at, a.updated_at, a.job_id, wr.remind_on, wr.archive_on
        from recruitment_application a join ${rules} on wr.stage_id = a.current_stage_id
        where a.tenant_id = ${s.tenantId}::uuid and a.company_id = any(${ids}::uuid[]) and a.state = 'active'
          and a.job_id = any(${uuidArray(reviewed)}::uuid[]) and (a.applied_at at time zone 'Asia/Kuala_Lumpur')::date <= wr.remind_on ${baseFilter}
        order by a.updated_at, a.id limit ${WAITING_BOARD_SCAN_LIMIT + 1}
      ), q as materialized (
        select p.*, row_number() over (partition by p.current_stage_id order by p.updated_at, p.id) as rn,
          row_number() over (order by p.updated_at, p.id) as total_rn
        from p
      ), k as materialized (
        select q.current_stage_id as stage_id, q.id, q.remind_on, q.archive_on, q.job_id = any(${uuidArray(operatedJobs)}::uuid[]) as operated,
          ${stageEnteredDayOf('q')} as entered
        from q where q.rn <= ${WAITING_SCAN_LIMIT} and q.total_rn <= ${WAITING_BOARD_SCAN_LIMIT}
      )
      select k.stage_id,
        count(*) filter (where k.entered <= k.remind_on)::int as waiting,
        count(*) filter (where k.operated and k.archive_on is not null and k.entered <= k.archive_on)::int as suggested,
        (select count(*) from q where q.current_stage_id = k.stage_id) > ${WAITING_SCAN_LIMIT} as capped,
        (select count(*)::int from p) as total,
        coalesce(array_agg(k.id::text) filter (where k.entered <= k.remind_on), '{}') as waiting_ids,
        coalesce(array_agg(k.id::text) filter (where k.operated and k.archive_on is not null and k.entered <= k.archive_on), '{}') as suggested_ids
      from k group by k.stage_id
      union all
      select null, 0, 0, false, (select count(*)::int from p), '{}', '{}'`) : [];
    // The scan stopped at its total: every stage may have more.
    const scanCapped = scan.some((r) => r.total > WAITING_BOARD_SCAN_LIMIT);
    const matched = waitingFilter ? scan.flatMap((r) => (waitingFilter === 'suggested' ? r.suggested_ids : r.waiting_ids)) : [];
    const waitingCondition = waitingFilter ? (matched.length ? sql`and a.id = any(${uuidArray(matched)}::uuid[])` : sql`and false`) : sql``;
    const jobFilter = sql`${baseFilter} ${waitingCondition}`;
    const counts = await tx.execute<{ stage_id: string; state: ApplicationState; n: number }>(sql`
      select a.current_stage_id as stage_id, a.state, count(*)::int as n from recruitment_application a
      where a.tenant_id = ${s.tenantId}::uuid and a.company_id = any(${ids}::uuid[]) ${jobFilter} group by 1, 2`);
    const activeIn = (stageId: string) => counts.filter((c) => c.state === 'active' && c.stage_id === stageId).reduce((n, c) => n + c.n, 0);
    const inState = (state: ApplicationState) => counts.filter((c) => c.state === state).reduce((n, c) => n + c.n, 0);
    const tabs: StageTab[] = [
      ...stageRows.map((r) => ({ key: r.stage_id, stageId: r.stage_id, name: r.name, count: activeIn(r.stage_id) })),
      { key: 'hired', stageId: null, name: 'hired', count: inState('hired') },
      { key: 'archived', stageId: null, name: 'archived', count: inState('archived') },
    ];
    const selected = tabs.find((t) => t.key === filter.tab) ?? tabs[0];
    const tabFilter = !selected ? sql`and false`
      : selected.key === 'hired' ? sql`and a.state = 'hired'`
        : selected.key === 'archived' ? sql`and a.state = 'archived'`
          : sql`and a.state = 'active' and a.current_stage_id = ${selected.stageId}::uuid`;
    // Slice 11: screening statuses, counts and the status filter cover only an active STAGE tab (never Hired or Archived) and
    // only the jobs in view the viewer operates (they read every request and answer there). Each is evaluated over at most the
    // SCREENING_STATUS_WINDOW most recent such applications of the stage (one index read), so a large stage costs the same as
    // a small one; `capped` says the stage has more. For any other card the status is not shown.
    const operated = jobs.filter((j) => access.get(j.id)?.operate).map((j) => j.id);
    const screeningOn = operated.length > 0 && !!selected?.stageId;
    const window = screeningOn ? (await tx.execute<{ id: string }>(sql`
      select a.id from recruitment_application a
      where a.tenant_id = ${s.tenantId}::uuid and a.company_id = any(${ids}::uuid[]) ${jobFilter} ${tabFilter} and a.job_id = any(${uuidArray(operated)}::uuid[])
      order by a.applied_at desc, a.id limit ${SCREENING_STATUS_WINDOW + 1}`)).map((r) => r.id) : [];
    const windowIds = window.slice(0, SCREENING_STATUS_WINDOW);
    const statuses = windowIds.length ? await tx.execute<{ id: string; status: AssignmentStatus }>(sql`
      select a.id, ${screeningStatusSql} as status from recruitment_application a where a.id = any(${uuidArray(windowIds)}::uuid[])`) : [];
    const statusOf = new Map(statuses.map((r) => [r.id, r.status]));
    const screeningFilter = screeningOn ? parseAssignmentFilter(filter.screening) : null;
    const filtered = screeningFilter ? statuses.filter((r) => r.status === screeningFilter).map((r) => r.id) : null;
    const statusFilter = filtered ? (filtered.length ? sql`and a.id = any(${uuidArray(filtered)}::uuid[])` : sql`and false`) : sql``;
    const rows = await tx.execute<{
      id: string; full_name: string; email: string | null; phone: string | null; job_id: string; title: string; job_number: string; source: string | null;
      applied_at: string; owner_user_id: string | null; state: ApplicationState; stage_id: string; stage_name: string; reason: string | null; company_id: string;
      candidate_id: string; removed: boolean; entered_on: string | null;
    }>(sql`
      select a.id, a.candidate_id, c.destroyed_at is not null as removed,
        ${ruleStages.length ? sql`case when a.state = 'active' and a.current_stage_id = any(${uuidArray(ruleStages)}::uuid[])
          then to_char(${stageEnteredDaySql}, 'YYYY-MM-DD') end` : sql`null::text`} as entered_on, c.full_name, c.email, c.phone, a.job_id, j.title, j.job_number, a.source, to_char(a.applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as applied_at, c.owner_user_id,
        a.state, a.current_stage_id as stage_id, st.name as stage_name, r.internal_reason as reason, a.company_id
      from recruitment_application a
      join recruitment_candidate c on c.id = a.candidate_id
      join recruitment_job_opening j on j.id = a.job_id
      join recruitment_stage st on st.id = a.current_stage_id
      left join recruitment_archive_reason r on r.id = a.archive_reason_id
      where a.tenant_id = ${s.tenantId}::uuid and a.company_id = any(${ids}::uuid[]) ${jobFilter} ${tabFilter} ${statusFilter}
      order by a.applied_at desc, a.id limit 200`);
    // Cards outside the window (older than its most recent applications) are read without a status; one query for them.
    const outside = rows.filter((r) => screeningOn && operated.includes(r.job_id) && !statusOf.has(r.id)).map((r) => r.id);
    if (outside.length) {
      for (const r of await tx.execute<{ id: string; status: AssignmentStatus }>(sql`
        select a.id, ${screeningStatusSql} as status from recruitment_application a where a.id = any(${uuidArray(outside)}::uuid[])`)) statusOf.set(r.id, r.status);
    }
    const labels = new Map<string, UserLabel>();
    for (const id of companyIds) for (const [k, v] of await userLabelsTx(tx, id)) labels.set(k, v);
    const reasons = await tx.select({ id: recruitmentArchiveReason.id, internal: recruitmentArchiveReason.internalReason, external: recruitmentArchiveReason.externalReason, companyId: recruitmentArchiveReason.companyId })
      .from(recruitmentArchiveReason)
      .where(and(eq(recruitmentArchiveReason.tenantId, s.tenantId), eq(recruitmentArchiveReason.displayed, true), sql`${recruitmentArchiveReason.companyId} = any(${ids}::uuid[])`))
      .orderBy(asc(recruitmentArchiveReason.position), asc(recruitmentArchiveReason.internalReason));
    const nextStage: CandidateBoard['nextStage'] = {};
    const moveTargets: CandidateBoard['moveTargets'] = {};
    const byProcess = new Map<string, Awaited<ReturnType<typeof processStagesTx>>>();
    for (const r of rows) {
      if (!access.has(r.job_id)) access.set(r.job_id, await jobLevelTx(tx, r.company_id, r.job_id));
    }
    // Slice 12: background check markers for the cards whose job the viewer operates — ONE query over the shown cards through
    // the check's application index, reading only status and outcome (never the restricted details).
    const checkCards = rows.filter((r) => access.get(r.job_id)?.operate).map((r) => r.id);
    const checkRows = checkCards.length ? await tx.execute<{ application_id: string; status: CheckStatus; outcome: CheckOutcome | null }>(sql`
      select application_id, status, outcome from recruitment_background_check
      where application_id = any(${uuidArray(checkCards)}::uuid[]) and (status = 'in_progress' or (status = 'completed' and outcome = 'concerns_found'))`) : [];
    const cardTags = rows.length ? await tx.execute<{ candidate_id: string; id: string; name: string }>(sql`
      select ct.candidate_id, t.id, t.name from recruitment_candidate_tag ct join recruitment_tag t on t.id = ct.tag_id
      where ct.candidate_id = any(${uuidArray([...new Set(rows.map((r) => r.candidate_id))])}::uuid[]) order by t.name`) : [];
    // Slice 13: one yes/no per shown card (app.recruitment_application_needs_review answers only for an application the viewer
    // reads), and the operated cards' pool memberships under the viewer's row security (pools they can see) — two queries.
    const review = rows.length ? await tx.execute<{ id: string; r: boolean }>(sql`
      select x.id, app.recruitment_application_needs_review(x.id) as r from unnest(${uuidArray(rows.map((r) => r.id))}::uuid[]) as x(id)`) : [];
    const needsReview = new Set(review.filter((x) => x.r).map((x) => x.id));
    const poolCandidates = [...new Set(rows.filter((r) => access.get(r.job_id)?.operate).map((r) => r.candidate_id))];
    const poolRows = poolCandidates.length ? await tx.execute<{ candidate_id: string; id: string; name: string; parent_name: string | null }>(sql`
      select m.candidate_id, p.id, p.name, pp.name as parent_name from recruitment_talent_pool_member m
      join recruitment_talent_pool p on p.id = m.pool_id left join recruitment_talent_pool pp on pp.id = p.parent_id
      where m.candidate_id = any(${uuidArray(poolCandidates)}::uuid[])`) : [];
    const tagOptions = await tx.execute<{ id: string; name: string; group_name: string }>(sql`
      select t.id, t.name, g.name as group_name from recruitment_tag t join recruitment_tag_group g on g.id = t.group_id
      where t.tenant_id = ${s.tenantId}::uuid and t.company_id = any(${ids}::uuid[])
        and exists (select 1 from recruitment_candidate_tag ct where ct.tag_id = t.id)
      order by g.name, t.name`);
    for (const r of rows) {
      if (r.state !== 'active' || !access.get(r.job_id)?.review) continue;
      const processId = jobs.find((j) => j.id === r.job_id)?.process_id;
      if (!processId) continue;
      if (!byProcess.has(processId)) byProcess.set(processId, await processStagesTx(tx, processId));
      const stages = byProcess.get(processId)!;
      const plan = planMoveForward(stages, r.stage_id);
      nextStage[r.id] = plan.kind === 'hired' ? 'hired' : { stageId: plan.to, name: stages.find((x) => x.stageId === plan.to)!.name };
      moveTargets[r.id] = access.get(r.job_id)?.operate ? stages.filter((x) => x.enabled && x.stageId !== r.stage_id).map((x) => ({ stageId: x.stageId, name: x.name })) : [];
    }
    const waitingOf = (r: (typeof rows)[number]): ApplicationCard['waiting'] => {
      const rule = waitCtx.cutoffs.get(r.stage_id);
      if (r.state !== 'active' || !rule || !r.entered_on || !access.get(r.job_id)?.review) return null;
      const days = waitingDays(r.entered_on, today, rule.dayKind, waitCtx.holidays.get(r.company_id));
      const level = waitingLevel(days, rule);
      return level === 'none' ? null : { days, stageName: r.stage_name, suggested: access.get(r.job_id)?.operate ? level === 'suggested' : null };
    };
    return {
      tabs, nextStage, moveTargets, reasons: [...reasons], customFilters, customFilter: custom.filter ? customFilterKey(custom.filter) : null,
      waiting: rules ? {
        counts: Object.fromEntries(ruleStages.map((id) => {
          const row = scan.find((c) => c.stage_id === id);
          return [id, { waiting: row?.waiting ?? 0, suggested: operatedJobs.length ? row?.suggested ?? 0 : null, capped: scanCapped || (row?.capped ?? false) }];
        })),
        filter: waitingFilter,
      } : null,
      screening: screeningOn ? {
        counts: Object.fromEntries(ASSIGNMENT_STATUSES.map((k) => [k, statuses.filter((c) => c.status === k).length])) as Record<AssignmentStatus, number>,
        filter: screeningFilter, capped: window.length > SCREENING_STATUS_WINDOW,
      } : null,
      tagOptions: tagOptions.map((t) => ({ id: t.id, name: t.name, groupName: t.group_name })),
      jobs: jobs.map((j) => ({ id: j.id, title: j.title, jobNumber: j.job_number, status: j.status, companyId: j.company_id, canOperate: access.get(j.id)?.operate ?? false })),
      cards: rows.map((r) => ({
        id: r.id, candidateName: r.full_name, email: r.email, phone: r.phone, jobId: r.job_id, jobTitle: r.title, jobNumber: r.job_number,
        source: r.source, appliedAt: r.applied_at, ownerName: r.owner_user_id ? labels.get(r.owner_user_id)?.name ?? null : null, state: r.state,
        stageId: r.stage_id, stageName: r.stage_name, archiveReason: r.reason, companyId: r.company_id,
        canReview: access.get(r.job_id)?.review ?? false, canOperate: access.get(r.job_id)?.operate ?? false,
        candidateId: r.candidate_id, removed: r.removed,
        tags: cardTags.filter((x) => x.candidate_id === r.candidate_id).map((x) => ({ id: x.id, name: x.name })),
        screeningStatus: statusOf.get(r.id) ?? null,
        backgroundCheck: access.get(r.job_id)?.operate ? checkMarker(checkRows.filter((x) => x.application_id === r.id)) : null,
        needsReview: needsReview.has(r.id),
        pools: access.get(r.job_id)?.operate ? poolRows.filter((x) => x.candidate_id === r.candidate_id)
          .map((x) => ({ id: x.id, label: poolLabels([{ name: x.name, parentName: x.parent_name }])[0] }))
          .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' })) : [],
        waiting: waitingOf(r),
      })),
    };
  });
}

async function writeEventTx(tx: Tx, s: SessionContext, e: Omit<typeof recruitmentApplicationEvent.$inferInsert, 'tenantId' | 'actorUserId'>): Promise<void> {
  await tx.insert(recruitmentApplicationEvent).values({ ...e, tenantId: s.tenantId, actorUserId: actorId(s) });
}

/** The company's repeated-application window (months; 0 = off). A missing settings row reads as the default. */
export async function repeatWindowTx(tx: Tx, companyId: string): Promise<number> {
  const [row] = await tx.select({ months: recruitmentCompanySetting.repeatWindowMonths }).from(recruitmentCompanySetting)
    .where(eq(recruitmentCompanySetting.companyId, companyId));
  return row?.months ?? DEFAULT_REPEAT_WINDOW_MONTHS;
}

/** The candidate's earlier applications to `jobId`, as the repeated-application rule reads them (Kuala Lumpur days). */
export async function earlierApplicationsTx(tx: Tx, candidateIds: readonly string[], jobIds?: readonly string[]) {
  if (!candidateIds.length) return [];
  const rows = await tx.execute<{ candidate_id: string; job_id: string; state: ApplicationState; closed_on: string | null }>(sql`
    select candidate_id, job_id, state,
      case when state = 'active' then null else to_char((state_changed_at at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') end as closed_on
    from recruitment_application where candidate_id = any(${uuidArray(candidateIds)}::uuid[])
      ${jobIds ? sql`and job_id = any(${uuidArray(jobIds)}::uuid[])` : sql``}`);
  return rows.map((r) => ({ candidateId: r.candidate_id, jobId: r.job_id, state: r.state, closedOn: r.closed_on }));
}

/**
 * Refuse a repeated application (slice 5): the same candidate and job while an earlier application is active
 * (duplicate_application) or closed within the company's window (repeat_application). The 5205 guard refuses the
 * same again. Another job is always allowed.
 */
export async function assertNotRepeatedTx(tx: Tx, companyId: string, candidateId: string, jobId: string): Promise<void> {
  const earlier = await earlierApplicationsTx(tx, [candidateId], [jobId]);
  if (earlier.some((a) => a.state === 'active')) throw new RecruitmentError('duplicate_application');
  if (repeatApplicationBlocked(earlier, jobId, await repeatWindowTx(tx, companyId), todayInKualaLumpur())) throw new RecruitmentError('repeat_application');
}

/**
 * Insert an application, mapping the 5205 repeated-application guard's refusal (SQLSTATE 23505: a concurrent add of the
 * same candidate to the same job got there first) to duplicate_application. Shared with the talent pool's "Add to job".
 */
export async function insertApplicationTx(tx: Tx, values: typeof recruitmentApplication.$inferInsert): Promise<string> {
  try {
    const [row] = await tx.insert(recruitmentApplication).values(values).returning({ id: recruitmentApplication.id });
    return row.id;
  } catch (e) {
    if (pgSqlState(e) === '23505') throw new RecruitmentError('duplicate_application');
    throw e;
  }
}

export type DuplicateMatch = {
  candidateId: string; fullName: string; email: string | null; phone: string | null; matchedOn: ('idNumber' | 'email' | 'name' | 'mobile')[];
  applications: { jobTitle: string; jobNumber: string; state: ApplicationState }[];
};
export type DuplicateCheck = { count: number; matches: DuplicateMatch[] | null };
type Probe = { fullName: string; email: string | null; phone: string | null; idNumber: string | null };

/**
 * Possible duplicates of a new candidate in the company (slice 5): the same ID number, or two of email, name and mobile.
 * The COUNT comes from app.recruitment_candidate_duplicate_count, which never returns a row, so a job operator learns
 * only that a match exists. An administrator also gets the matches, read through ordinary row security.
 */
export async function duplicateCheckTx(tx: Tx, companyId: string, probe: Probe): Promise<DuplicateCheck> {
  const [row] = await tx.execute<{ n: number }>(sql`select app.recruitment_candidate_duplicate_count(${companyId}::uuid, ${probe.fullName}, ${probe.email},
    ${probe.phone}, ${probe.idNumber}, null) as n`);
  const count = row?.n ?? 0;
  const [admin] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_recruitment_for(${companyId}::uuid) as ok`);
  if (!count || admin?.ok !== true) return { count, matches: count ? null : [] };
  // The same indexed equality lookups as the count (one per item, each on its expression index), read under the
  // administrator's own row security; never a company-wide scan.
  const id = normIdNumber(probe.idNumber), email = normEmail(probe.email), name = normName(probe.fullName), mobile = normMobile(probe.phone);
  const rows = await tx.execute<{ id: string; full_name: string; email: string | null; phone: string | null; id_number: string | null }>(sql`
    with hits as (
      select r.candidate_id, 'id'::text as kind from recruitment_candidate_restricted r
       where ${id}::text is not null and r.tenant_id = app.current_tenant_id() and r.company_id = ${companyId}::uuid and r.id_number is not null
        and app.recruitment_norm_id(r.id_number) = ${id}::text
      union all
      select c.id, 'email' from recruitment_candidate c
       where ${email}::text is not null and c.tenant_id = app.current_tenant_id() and c.company_id = ${companyId}::uuid and c.email is not null
        and app.recruitment_norm_email(c.email) = ${email}::text
      union all
      select c.id, 'name' from recruitment_candidate c
       where ${name}::text is not null and c.tenant_id = app.current_tenant_id() and c.company_id = ${companyId}::uuid
        and app.recruitment_norm_name(c.full_name) = ${name}::text
      union all
      select c.id, 'mobile' from recruitment_candidate c
       where ${mobile}::text is not null and c.tenant_id = app.current_tenant_id() and c.company_id = ${companyId}::uuid and c.phone is not null
        and app.recruitment_norm_mobile(c.phone) = ${mobile}::text
    ), matched as (
      select candidate_id from hits group by candidate_id having bool_or(kind = 'id') or count(distinct kind) >= 2
    )
    select c.id, c.full_name, c.email, c.phone, r.id_number from matched m
    join recruitment_candidate c on c.id = m.candidate_id and c.destroyed_at is null
    left join recruitment_candidate_restricted r on r.candidate_id = c.id
    order by c.created_at, c.id limit 20`);
  const apps = rows.length ? await tx.execute<{ candidate_id: string; title: string; job_number: string; state: ApplicationState }>(sql`
    select a.candidate_id, j.title, j.job_number, a.state from recruitment_application a join recruitment_job_opening j on j.id = a.job_id
    where a.candidate_id = any(${uuidArray(rows.map((r) => r.id))}::uuid[]) order by a.applied_at`) : [];
  return {
    count,
    matches: rows.map((r) => ({
      candidateId: r.id, fullName: r.full_name, email: r.email, phone: r.phone,
      matchedOn: [
        ...(normIdNumber(probe.idNumber) && normIdNumber(probe.idNumber) === normIdNumber(r.id_number) ? ['idNumber' as const] : []),
        ...(normEmail(probe.email) && normEmail(probe.email) === normEmail(r.email) ? ['email' as const] : []),
        ...(normName(probe.fullName) === normName(r.full_name) ? ['name' as const] : []),
        ...(normMobile(probe.phone) && normMobile(probe.phone) === normMobile(r.phone) ? ['mobile' as const] : []),
      ],
      applications: apps.filter((a) => a.candidate_id === r.id).map((a) => ({ jobTitle: a.title, jobNumber: a.job_number, state: a.state })),
    })),
  };
}

export type AddApplicationInput = { jobId?: unknown } & CandidateInput & {
  /** Slice 5: the candidate's source (choice), ID type and number (restricted), and how a possible duplicate is resolved. */
  candidateSource?: unknown; idType?: unknown; idNumber?: unknown; existingCandidateId?: unknown; confirmSeparate?: unknown;
};

function addProbe(input: AddApplicationInput) {
  const candidate = validateCandidateInput(input);
  if (!candidate.ok) throw new RecruitmentError(candidate.fields.includes('fullName') ? 'missing_fields' : 'invalid_input', candidate.fields);
  const fields: string[] = [];
  const candidateSource = input.candidateSource == null || input.candidateSource === '' ? null
    : (CANDIDATE_SOURCES as readonly string[]).includes(String(input.candidateSource)) ? input.candidateSource as CandidateSource : undefined;
  if (candidateSource === undefined) fields.push('candidateSource');
  const idNumber = typeof input.idNumber === 'string' && input.idNumber.trim() ? input.idNumber.trim() : null;
  const idType = input.idType == null || input.idType === '' ? null : (ID_TYPES as readonly string[]).includes(String(input.idType)) ? input.idType as IdType : undefined;
  if (idNumber && (idNumber.length > 40 || !idType)) fields.push('idNumber');
  if (idType === undefined) fields.push('idType');
  if (fields.length) throw new RecruitmentError('invalid_input', fields);
  return { ...candidate.value, candidateSource: candidateSource ?? null, idNumber, idType: idNumber ? idType as IdType : null };
}

/**
 * Every possible-duplicate result is audited: who asked, on which job, and how many matched — never what was typed.
 * Repeated probing for whether someone is already a candidate shows up in the log.
 */
async function duplicateFlaggedTx(tx: Tx, s: SessionContext, companyId: string, jobId: string, matches: number, via: 'add' | 'check'): Promise<void> {
  await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: jobId, eventType: 'recruitment-candidate.duplicate-flagged',
    actor: actorOf(s), payload: { companyId, jobId, matches, via } });
}

/**
 * Before adding: does the new candidate look like one the company already has? (slice 5). Same access as adding.
 */
export async function checkDuplicateCandidate(s: SessionContext, input: AddApplicationInput): Promise<DuplicateCheck> {
  const v = addProbe(input);
  if (!isUuid(input.jobId)) throw new RecruitmentError('missing_fields', ['job']);
  return withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, input.jobId as string, 'operate');
    const result = await duplicateCheckTx(tx, job.companyId, { fullName: v.fullName, email: v.email, phone: v.phone, idNumber: v.idNumber });
    if (result.count > 0) await duplicateFlaggedTx(tx, s, job.companyId, job.id, result.count, 'check');
    return result;
  });
}

/**
 * Add an application. Slice 1 creates a NEW candidate with it (a candidate is never a person or an employee). It starts
 * at the first enabled stage of the job's process. A closed job takes no applications (slice 1 implementation decision).
 *
 * Slice 5: a possible duplicate in the company is refused (possible_duplicate) unless an administrator confirms a
 * separate candidate (`confirmSeparate`) or adds the application to the existing candidate (`existingCandidateId`) — a
 * job operator cannot resolve it. A repeated application to the same job follows the company's window.
 */
export async function addApplication(s: SessionContext, input: AddApplicationInput): Promise<{ applicationId: string; candidateId: string }> {
  const v = addProbe(input);
  if (!isUuid(input.jobId)) throw new RecruitmentError('missing_fields', ['job']);
  const user = actorId(s);
  const existing = input.existingCandidateId == null || input.existingCandidateId === '' ? null : input.existingCandidateId;
  if (existing !== null && !isUuid(existing)) throw new RecruitmentError('not_found');
  // A refused possible duplicate commits its audit event (nothing else has been written yet), then the refusal is thrown.
  const outcome = await withRecruitmentTenant(s, async (tx): Promise<{ applicationId: string; candidateId: string } | 'duplicate'> => {
    // The job's recruiter and assistants may add applications to it, as administrators may (slice 2).
    const job = await jobTx(tx, s, input.jobId as string, 'operate');
    if (job.status === 'closed') throw new RecruitmentError('job_closed');
    const start = firstStage(await processStagesTx(tx, job.processId));
    if (!start) throw new RecruitmentError('process_unavailable');
    const [adminRow] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_recruitment_for(${job.companyId}::uuid) as ok`);
    const admin = adminRow?.ok === true;
    let candidateId: string;
    if (existing) {
      // Only an administrator resolves a duplicate onto an existing candidate of the same company.
      if (!admin) throw new RecruitmentError('forbidden');
      const [c] = await tx.select({ id: recruitmentCandidate.id, destroyedAt: recruitmentCandidate.destroyedAt }).from(recruitmentCandidate)
        .where(and(eq(recruitmentCandidate.id, existing), eq(recruitmentCandidate.tenantId, s.tenantId), eq(recruitmentCandidate.companyId, job.companyId)));
      if (!c) throw new RecruitmentError('not_found');
      if (c.destroyedAt) throw new RecruitmentError('candidate_removed');
      await assertNotRepeatedTx(tx, job.companyId, c.id, job.id);
      candidateId = c.id;
    } else {
      const duplicates = await duplicateCheckTx(tx, job.companyId, { fullName: v.fullName, email: v.email, phone: v.phone, idNumber: v.idNumber });
      const confirmed = input.confirmSeparate === true || input.confirmSeparate === 'on' || input.confirmSeparate === 'true' || input.confirmSeparate === '1';
      if (duplicates.count > 0 && !(admin && confirmed)) {
        await duplicateFlaggedTx(tx, s, job.companyId, job.id, duplicates.count, 'add');
        return 'duplicate';
      }
      // The id is made here, not returned: a job team member cannot read a candidate until its application exists.
      candidateId = randomUUID();
      await tx.insert(recruitmentCandidate).values({
        id: candidateId, tenantId: s.tenantId, companyId: job.companyId, fullName: v.fullName, email: v.email, phone: v.phone,
        source: v.candidateSource, ownerUserId: user, createdByUserId: user, updatedByUserId: user,
      });
    }
    const applicationId = await insertApplicationTx(tx, {
      tenantId: s.tenantId, companyId: job.companyId, jobId: job.id, candidateId, currentStageId: start,
      source: v.source ?? v.candidateSource, createdByUserId: user, updatedByUserId: user,
    });
    if (!existing && v.idNumber) {
      await tx.insert(recruitmentCandidateRestricted).values({
        tenantId: s.tenantId, companyId: job.companyId, candidateId, idType: v.idType, idNumber: v.idNumber, updatedByUserId: user,
      });
    }
    await writeEventTx(tx, s, { companyId: job.companyId, applicationId, ...appliedEvent(start) });
    if (existing) {
      await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: applicationId, eventType: 'recruitment-application.added-to-existing-candidate',
        actor: actorOf(s), payload: { companyId: job.companyId, candidateId, jobId: job.id } });
    }
    return { applicationId, candidateId };
  });
  if (outcome === 'duplicate') throw new RecruitmentError('possible_duplicate');
  return outcome;
}

/**
 * Slice 13: refuse while the application has an open blocked-list mark ("Needs an administrator's review"). The yes/no comes
 * from app.recruitment_application_needs_review, which answers only for an application the caller may read; the 5213 guards
 * refuse the same move, offer step or hire for any caller (reviewRefusal maps their refusal).
 */
export async function assertNoReviewMarkTx(tx: Tx, applicationId: string): Promise<void> {
  const [row] = await tx.execute<{ marked: boolean }>(sql`select app.recruitment_application_needs_review(${applicationId}::uuid) as marked`);
  if (row?.marked === true) throw new RecruitmentError('needs_review');
}
/** The 5213 review-mark guard's refusal (RAISE … CONSTRAINT recruitment_application_needs_review) as needs_review. */
export const reviewRefusal = (e: unknown): never => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (cur.constraint_name === 'recruitment_application_needs_review') throw new RecruitmentError('needs_review');
  }
  throw e;
};

/** An ACTIVE application the caller may act on at `level` on its job (review: move forward / reject; operate: the rest). */
export async function applicationTx(tx: Tx, s: SessionContext, applicationId: unknown, level: JobLevel = 'review') {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  const [row] = await tx.select({ app: recruitmentApplication, processId: recruitmentJobOpening.processId })
    .from(recruitmentApplication)
    .innerJoin(recruitmentJobOpening, eq(recruitmentJobOpening.id, recruitmentApplication.jobId))
    .where(and(eq(recruitmentApplication.id, applicationId), eq(recruitmentApplication.tenantId, s.tenantId)))
    .for('update', { of: recruitmentApplication });
  if (!row) throw new RecruitmentError('not_found');
  await assertJobLevelTx(tx, row.app.companyId, row.app.jobId, level, row.app.id);
  if (row.app.state !== 'active') throw new RecruitmentError('application_closed');
  return row;
}

/**
 * Move forward (no target): the next enabled stage of the job's process, or hired from the last one.
 * Move to (target): any other enabled stage of the job's process. Every move writes one history event.
 */
export async function moveApplication(s: SessionContext, applicationId: unknown, targetStageId?: unknown): Promise<{ state: ApplicationState; stageId: string }> {
  return withRecruitmentTenant(s, (tx) => moveApplicationTx(tx, s, applicationId, targetStageId));
}

/**
 * The move itself, inside the caller's transaction (slice 11's "send to hiring manager" moves in the same transaction as it
 * sends): the same access levels, plans, guards and one history event as moveApplication.
 */
export async function moveApplicationTx(tx: Tx, s: SessionContext, applicationId: unknown, targetStageId?: unknown): Promise<{ state: ApplicationState; stageId: string }> {
  const user = actorId(s);
  // Move forward: the job's reviewers (hiring manager included). Move to a chosen stage: its operators.
  const chosen = !(targetStageId == null || targetStageId === '');
  const { app, processId } = await applicationTx(tx, s, applicationId, chosen ? 'operate' : 'review');
  // Slice 13: a blocked-list mark holds the application where it is until an administrator resolves it (5213 refuses too).
  await assertNoReviewMarkTx(tx, app.id);
  const stages = await processStagesTx(tx, processId);
  const plan = targetStageId == null || targetStageId === ''
    ? planMoveForward(stages, app.currentStageId)
    : planMoveTo(stages, app.currentStageId, isUuid(targetStageId) ? targetStageId : '');
  if (plan.kind === 'hired') {
    await tx.update(recruitmentApplication).set({ state: 'hired', updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentApplication.id, app.id))
      .catch(reviewRefusal);
    await writeEventTx(tx, s, { companyId: app.companyId, applicationId: app.id, ...moveEvent(plan) });
    return { state: 'hired', stageId: plan.from };
  }
  await tx.update(recruitmentApplication).set({ currentStageId: plan.to, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentApplication.id, app.id))
    .catch(reviewRefusal);
  await writeEventTx(tx, s, { companyId: app.companyId, applicationId: app.id, ...moveEvent(plan) });
  return { state: 'active', stageId: plan.to };
}

/** Reject: an archive reason of the application's company is mandatory; the application keeps the stage it left. */
export async function rejectApplication(s: SessionContext, applicationId: unknown, archiveReasonId: unknown): Promise<void> {
  await withRecruitmentTenant(s, async (tx) => {
    const { app } = await applicationTx(tx, s, applicationId);
    await archiveApplicationsTx(tx, s, app.companyId, [{ id: app.id, currentStageId: app.currentStageId }], archiveReasonId);
  });
}

/**
 * The reject itself for ACTIVE applications of ONE company the caller has already locked and checked (rejectApplication: one; slice
 * 17's "Suggested to archive": the operator's selection): a displayed archive reason of that company is mandatory, each application
 * keeps the stage it left, and each gets one 'rejected' history event — one UPDATE and one INSERT for the whole set, so every
 * database guard on an application's state runs for each row as before.
 */
export async function archiveApplicationsTx(tx: Tx, s: SessionContext, companyId: string, apps: readonly { id: string; currentStageId: string }[], archiveReasonId: unknown): Promise<void> {
  const user = actorId(s);
  if (!apps.length) return;
  const plans = apps.map((a) => ({ id: a.id, ...planReject(a.currentStageId, archiveReasonId) }));
  const reasonId = plans[0].reasonId;
  const [reason] = await tx.select({ id: recruitmentArchiveReason.id }).from(recruitmentArchiveReason)
    .where(and(eq(recruitmentArchiveReason.id, reasonId), eq(recruitmentArchiveReason.companyId, companyId), eq(recruitmentArchiveReason.displayed, true)));
  if (!reason) throw new RecruitmentError('reason_required');
  const appIds = uuidArray(plans.map((p) => p.id));
  const stages = uuidArray(plans.map((p) => p.stageLeft));
  await tx.execute(sql`update recruitment_application a set state = 'archived', archive_reason_id = ${reason.id}::uuid, stage_left_at_archive = x.stage_left,
      updated_at = now(), updated_by_user_id = ${user}::uuid
    from unnest(${appIds}::uuid[], ${stages}::uuid[]) as x(id, stage_left) where a.id = x.id`);
  const e = rejectEvent({ stageLeft: plans[0].stageLeft, reasonId: reason.id });
  await tx.execute(sql`insert into recruitment_application_event (tenant_id, company_id, application_id, kind, from_stage_id, to_stage_id, from_state, to_state,
      archive_reason_id, actor_user_id)
    select ${s.tenantId}::uuid, ${companyId}::uuid, x.id, ${e.kind}, x.stage_left, null, ${e.fromState}, ${e.toState}, ${reason.id}::uuid, ${user}::uuid
    from unnest(${appIds}::uuid[], ${stages}::uuid[]) as x(id, stage_left)`);
}

export type ApplicationHistoryRow = {
  id: string; kind: 'applied' | 'moved' | 'rejected' | 'hired'; fromStage: string | null; toStage: string | null; reason: string | null;
  actorName: string | null; occurredAt: string;
  /** Slice 8: the "applied" event of an application the applicant sent through the careers page (no signed-in author). */
  byApplicant: boolean;
};
/** The application's history, oldest first, with who did it and when. */
export async function applicationHistory(s: SessionContext, applicationId: unknown): Promise<ApplicationHistoryRow[]> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => {
    const [app] = await tx.select({ companyId: recruitmentApplication.companyId, jobId: recruitmentApplication.jobId }).from(recruitmentApplication)
      .where(and(eq(recruitmentApplication.id, applicationId), eq(recruitmentApplication.tenantId, s.tenantId)));
    if (!app) throw new RecruitmentError('not_found');
    await assertJobLevelTx(tx, app.companyId, app.jobId, 'read', applicationId);
    const labels = await userLabelsTx(tx, app.companyId);
    const rows = await tx.execute<{ id: string; kind: ApplicationHistoryRow['kind']; from_stage: string | null; to_stage: string | null; reason: string | null; actor_user_id: string | null; occurred_at: string }>(sql`
      select e.id, e.kind, f.name as from_stage, t.name as to_stage, r.internal_reason as reason, e.actor_user_id, to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at
      from recruitment_application_event e
      left join recruitment_stage f on f.id = e.from_stage_id
      left join recruitment_stage t on t.id = e.to_stage_id
      left join recruitment_archive_reason r on r.id = e.archive_reason_id
      where e.application_id = ${applicationId}::uuid order by e.occurred_at, e.id`);
    return rows.map((r) => ({ id: r.id, kind: r.kind, fromStage: r.from_stage, toStage: r.to_stage, reason: r.reason, actorName: r.actor_user_id ? labels.get(r.actor_user_id)?.name ?? null : null, occurredAt: r.occurred_at,
      byApplicant: r.actor_user_id === null }));
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────

export type RecruitmentSettings = {
  companyId: string;
  stages: { id: string; name: string; type: RecruitmentStageType; systemKey: string | null; enabled: boolean; updatedAt: string; updatedBy: string | null }[];
  processes: { id: string; name: string; enabled: boolean; updatedAt: string; updatedBy: string | null; stages: { stageId: string; name: string; enabled: boolean }[]; jobs: number }[];
  reasons: { id: string; internal: string; external: string; kind: 'default' | 'custom'; displayed: boolean; updatedAt: string; updatedBy: string | null; used: boolean }[];
};

export async function recruitmentSettings(s: SessionContext, companyId: string): Promise<RecruitmentSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await ensureRecruitmentDefaultsTx(tx, s, companyId);
    const labels = await userLabelsTx(tx, companyId);
    const who = (id: string) => labels.get(id)?.name ?? null;
    const stages = await tx.select().from(recruitmentStage)
      .where(and(eq(recruitmentStage.tenantId, s.tenantId), eq(recruitmentStage.companyId, companyId)));
    const processes = await tx.select().from(recruitmentProcess)
      .where(and(eq(recruitmentProcess.tenantId, s.tenantId), eq(recruitmentProcess.companyId, companyId))).orderBy(asc(recruitmentProcess.name));
    const jobCounts = await tx.execute<{ process_id: string; n: number }>(sql`
      select process_id, count(*)::int as n from recruitment_job_opening where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid group by 1`);
    const processRows = [];
    for (const p of processes) {
      const ordered = await processStagesTx(tx, p.id);
      processRows.push({
        id: p.id, name: p.name, enabled: p.enabled, updatedAt: p.updatedAt.toISOString(), updatedBy: who(p.updatedByUserId),
        stages: ordered.map((st) => ({ stageId: st.stageId, name: st.name, enabled: st.enabled })),
        jobs: jobCounts.find((c) => c.process_id === p.id)?.n ?? 0,
      });
    }
    const order = new Map((processRows[0]?.stages ?? []).map((st, i) => [st.stageId, i]));
    const reasons = await tx.execute<{ id: string; internal_reason: string; external_reason: string; kind: 'default' | 'custom'; displayed: boolean; updated_at: string; updated_by_user_id: string; used: boolean }>(sql`
      select r.id, r.internal_reason, r.external_reason, r.kind, r.displayed, to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at, r.updated_by_user_id,
        exists (select 1 from recruitment_application a where a.archive_reason_id = r.id) as used
      from recruitment_archive_reason r where r.tenant_id = ${s.tenantId}::uuid and r.company_id = ${companyId}::uuid
      order by r.kind, r.position, r.internal_reason`);
    return {
      companyId,
      stages: stages
        .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999) || a.name.localeCompare(b.name))
        .map((st) => ({ id: st.id, name: st.name, type: st.stageType, systemKey: st.systemKey ?? null, enabled: st.enabled, updatedAt: st.updatedAt.toISOString(), updatedBy: who(st.updatedByUserId) })),
      processes: processRows,
      reasons: reasons.map((r) => ({ id: r.id, internal: r.internal_reason, external: r.external_reason, kind: r.kind, displayed: r.displayed, updatedAt: r.updated_at, updatedBy: who(r.updated_by_user_id), used: r.used })),
    };
  });
}

const settingsEvent = (s: SessionContext, tx: Tx, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType, aggregateId, eventType, actor: actorOf(s), payload });

/** Rename, retype or enable/disable a stage. A system stage (Application Review, Onboarding) keeps its type and stays enabled. */
export async function updateStage(s: SessionContext, stageId: unknown, input: { name?: unknown; type?: unknown; enabled?: unknown }): Promise<void> {
  if (!isUuid(stageId)) throw new RecruitmentError('not_found');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw new RecruitmentError('missing_fields', ['name']);
  const type = typeof input.type === 'string' && (RECRUITMENT_STAGE_TYPES as readonly string[]).includes(input.type) ? input.type as RecruitmentStageType : null;
  if (!type) throw new RecruitmentError('invalid_input', ['type']);
  const enabled = input.enabled === true || input.enabled === 'on' || input.enabled === 'true';
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const [stage] = await tx.select().from(recruitmentStage).where(and(eq(recruitmentStage.id, stageId), eq(recruitmentStage.tenantId, s.tenantId)));
    if (!stage) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, stage.companyId);
    if (stage.systemKey && (!enabled || type !== 'system_default')) throw new RecruitmentError('system_stage');
    if (!stage.systemKey && type === 'system_default') throw new RecruitmentError('system_stage');
    await tx.update(recruitmentStage).set({ name, stageType: type, enabled, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentStage.id, stage.id));
    await settingsEvent(s, tx, 'recruitment-stage', stage.id, 'recruitment-stage.updated', { companyId: stage.companyId, before: { name: stage.name, type: stage.stageType, enabled: stage.enabled }, after: { name, type, enabled } });
  });
}

/** Rename or enable/disable a process. A disabled process is not offered to new jobs; jobs already using it keep it. */
export async function updateProcess(s: SessionContext, processId: unknown, input: { name?: unknown; enabled?: unknown }): Promise<void> {
  if (!isUuid(processId)) throw new RecruitmentError('not_found');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw new RecruitmentError('missing_fields', ['name']);
  const enabled = input.enabled === true || input.enabled === 'on' || input.enabled === 'true';
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const [process] = await tx.select().from(recruitmentProcess).where(and(eq(recruitmentProcess.id, processId), eq(recruitmentProcess.tenantId, s.tenantId)));
    if (!process) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, process.companyId);
    await tx.update(recruitmentProcess).set({ name, enabled, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentProcess.id, process.id));
    await settingsEvent(s, tx, 'recruitment-process', process.id, 'recruitment-process.updated', { companyId: process.companyId, before: { name: process.name, enabled: process.enabled }, after: { name, enabled } });
  });
}

/** Create (no id) a custom archive reason, or edit any reason's text and Displayed flag. */
export async function saveArchiveReason(s: SessionContext, input: { id?: unknown; companyId?: unknown; internal?: unknown; external?: unknown; displayed?: unknown }): Promise<void> {
  const internal = typeof input.internal === 'string' ? input.internal.trim() : '';
  const external = typeof input.external === 'string' ? input.external.trim() : '';
  const missing = [...(!internal ? ['internal'] : []), ...(!external ? ['external'] : [])];
  if (missing.length) throw new RecruitmentError('missing_fields', missing);
  if (internal.length > 200 || external.length > 500) throw new RecruitmentError('invalid_input', ['reason']);
  const displayed = input.displayed === true || input.displayed === 'on' || input.displayed === 'true';
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    if (input.id == null || input.id === '') {
      if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
      await assertCompanyTx(tx, input.companyId);
      const [row] = await tx.insert(recruitmentArchiveReason).values({
        tenantId: s.tenantId, companyId: input.companyId, internalReason: internal, externalReason: external, kind: 'custom', displayed,
        createdByUserId: user, updatedByUserId: user,
      }).returning({ id: recruitmentArchiveReason.id });
      await settingsEvent(s, tx, 'recruitment-archive-reason', row.id, 'recruitment-archive-reason.created', { companyId: input.companyId, internal, external, displayed });
      return;
    }
    if (!isUuid(input.id)) throw new RecruitmentError('not_found');
    const [reason] = await tx.select().from(recruitmentArchiveReason).where(and(eq(recruitmentArchiveReason.id, input.id), eq(recruitmentArchiveReason.tenantId, s.tenantId)));
    if (!reason) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, reason.companyId);
    await tx.update(recruitmentArchiveReason).set({ internalReason: internal, externalReason: external, displayed, updatedAt: sql`now()`, updatedByUserId: user })
      .where(eq(recruitmentArchiveReason.id, reason.id));
    await settingsEvent(s, tx, 'recruitment-archive-reason', reason.id, 'recruitment-archive-reason.updated', {
      companyId: reason.companyId, before: { internal: reason.internalReason, external: reason.externalReason, displayed: reason.displayed }, after: { internal, external, displayed },
    });
  });
}

/** Delete a custom reason nothing uses. A default reason can only be hidden. */
export async function deleteArchiveReason(s: SessionContext, reasonId: unknown): Promise<void> {
  if (!isUuid(reasonId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [reason] = await tx.select().from(recruitmentArchiveReason).where(and(eq(recruitmentArchiveReason.id, reasonId), eq(recruitmentArchiveReason.tenantId, s.tenantId)));
    if (!reason) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, reason.companyId);
    if (reason.kind === 'default') throw new RecruitmentError('default_reason');
    const [used] = await tx.execute<{ used: boolean }>(sql`select exists (
      select 1 from recruitment_application a where a.archive_reason_id = ${reason.id}::uuid
      union all select 1 from recruitment_application_event e where e.archive_reason_id = ${reason.id}::uuid) as used`);
    if (used?.used) throw new RecruitmentError('reason_in_use');
    await tx.delete(recruitmentArchiveReason).where(eq(recruitmentArchiveReason.id, reason.id));
    await settingsEvent(s, tx, 'recruitment-archive-reason', reason.id, 'recruitment-archive-reason.deleted', { companyId: reason.companyId, internal: reason.internalReason });
  });
}
