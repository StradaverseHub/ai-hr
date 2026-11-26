/** Test-only: the bell's personal to-dos reader as it was before the two-step read (packs/recruitment/tasks.ts
 * personalTodosTx at d9db526a2, one eight-branch statement joining each job, application, candidate and agency), kept
 * verbatim so test/recruitment-bell-two-step.test.ts can compare the current reader with it (docs/SCALE-AND-RELEASE-RULES.md
 * rule 3). It runs as the viewer under the viewer's own row security, exactly as the product reader did. Never a product path. */
import { sql, type SQL } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { withRecruitmentTenant } from '../../core/module-gate';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { CONTRACT_EXPIRY_NOTICE_DAYS } from '../../packs/recruitment/agency-model';
import { CHECK_OVERDUE_DAYS } from '../../packs/recruitment/background-check-model';
import { isUuid } from '../../packs/recruitment/model';
import { uuidArray } from '../../packs/recruitment/data';
import { TODO_LIMIT, byNewest, todoHref, type RecruitmentTodo, type TodoKind } from '../../packs/recruitment/tasks-model';

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const me = sql`app.current_user_id()`;

type TodoRow = {
  kind: TodoKind; id: string; company_id: string; job_id: string | null; title: string | null; number: string | null;
  candidate_name: string | null; candidate_removed: boolean; count: number | null; position: number | null; steps: number | null;
  at: string | Date; stage_id: string | null; ends_on?: string | Date | null; application_id?: string | null;
};

const todoOf = (r: TodoRow): RecruitmentTodo => ({
  kind: r.kind, id: r.id, companyId: r.company_id, jobId: r.job_id, title: r.title, number: r.number,
  candidateName: r.candidate_removed ? null : r.candidate_name, candidateRemoved: r.candidate_removed === true,
  count: r.count, step: r.position != null && r.steps != null ? { position: r.position, steps: r.steps } : null,
  at: iso(r.at), href: todoHref(r.kind, { id: r.id, jobId: r.job_id, stageId: r.stage_id, applicationId: r.application_id ?? null }),
  ...(r.ends_on ? { endsOn: (r.ends_on instanceof Date ? r.ends_on.toISOString() : String(r.ends_on)).slice(0, 10) } : {}),
  ...(r.application_id ? { applicationId: r.application_id } : {}),
});
const scopedBy = (scope: readonly string[] | undefined) => (column: SQL) => (scope ? sql`${column} = any(${uuidArray(scope)}::uuid[])` : sql`true`);

/** The viewer's personal to-dos: approval steps (tenant-wide) and interview feedback due. Starts from the viewer's own
 *  rows through indexes (pending-approver expression indexes, the interviewer's user index). */
async function personalTodosTx(tx: Tx, s: SessionContext, scope: readonly string[] | undefined, now: Date): Promise<RecruitmentTodo[]> {
  const scoped = scopedBy(scope);
  const today = todayInKualaLumpur(now);
  // Slice 10: only a session holding a recruitment administration grant can have agency submissions to review. The
  // administered companies come from the session's grants once (group-wide: every company in scope; else the granted
  // companies and their descendants), not from a per-company predicate over the tenant; the database predicate is then
  // applied only to the few rows returned.
  const grants = s.grants ?? (s.roles ?? []).map((role) => ({ role, companyId: null as string | null }));
  const adminGrants = grants.filter((g) => g.role === 'hr_admin' || g.role === 'super_admin' || g.role === 'recruiting_partner');
  const groupWide = adminGrants.some((g) => g.companyId == null);
  const grantedCompanies = [...new Set(adminGrants.map((g) => g.companyId).filter((c): c is string => !!c && isUuid(c)))];
  const adminCompanies = groupWide ? sql`true`
    : grantedCompanies.length ? sql`(co.id = any(${uuidArray(grantedCompanies)}::uuid[])
        or exists (select 1 from unnest(${uuidArray(grantedCompanies)}::uuid[]) g(id) where app.is_company_descendant(co.id, g.id)))` : sql`false`;
  const reviewBranch = adminGrants.length ? sql`
    union all
    -- Slice 10: an agency submission waiting for review, one per submission, for the administrators of its company.
    (select 'agencyReview', w.id, w.company_id, w.job_id, j.title, j.job_number, w.full_name, w.full_name is null, null, null, null, w.created_at, null, null, null
     from (select co.id from company co where co.tenant_id = ${s.tenantId}::uuid and ${scoped(sql`co.id`)} and ${adminCompanies}) ac
     cross join lateral (select x.id, x.company_id, x.job_id, x.full_name, x.created_at from recruitment_agency_submission x
       where x.tenant_id = ${s.tenantId}::uuid and x.company_id = ac.id and x.outcome = 'waiting' order by x.created_at desc limit ${TODO_LIMIT}) w
     left join recruitment_job_opening j on j.id = w.job_id
     where app.can_admin_recruitment_for(w.company_id)
     order by w.created_at desc limit ${TODO_LIMIT})` : sql``;
  const rows = await tx.execute<TodoRow>(sql`
    -- Approval steps are tenant-wide, like the Approvals page and its badge: they do not follow the company switcher.
    (select 'requisitionApproval'::text as kind, r.id, r.company_id, null::uuid as job_id, r.title, r.req_number as number,
       null::text as candidate_name, false as candidate_removed, null::int as count, r.pending_position as position,
       cardinality(r.approver_user_ids) as steps, r.updated_at as at, null::uuid as stage_id, null::date as ends_on, null::uuid as application_id
     from recruitment_requisition r
     where r.tenant_id = ${s.tenantId}::uuid and r.approval_status = 'pending' and r.approver_user_ids[r.pending_position] = ${me}
     order by r.updated_at desc limit ${TODO_LIMIT})
    union all
    -- An approver who is not on the job's team cannot read the job, application or candidate rows: the names stay null,
    -- exactly as on the Approvals page (packs/recruitment/offers.ts offerForApprover).
    (select 'offerApproval', o.id, o.company_id, o.job_id, j.title, j.job_number,
       case when c.destroyed_at is null then c.full_name end, c.destroyed_at is not null, null, o.pending_position,
       cardinality(o.approver_user_ids), o.updated_at, null, null, null
     from recruitment_offer o
     left join recruitment_job_opening j on j.id = o.job_id
     left join recruitment_application a on a.id = o.application_id
     left join recruitment_candidate c on c.id = a.candidate_id
     where o.tenant_id = ${s.tenantId}::uuid and o.status = 'pending' and o.approver_user_ids[o.pending_position] = ${me}
     order by o.updated_at desc limit ${TODO_LIMIT})
    union all
    -- Feedback is due from the interview's start (an instant; Kuala Lumpur wall time is only how it is shown), on an
    -- interview that is not cancelled, that the candidate has not declined, that the viewer interviews and has not given
    -- feedback on.
    (select 'feedback', i.id, i.company_id, i.job_id, j.title, j.job_number,
       case when c.destroyed_at is null then c.full_name end, c.destroyed_at is not null, null, null, null, i.starts_at, null, null, null
     from recruitment_interview_interviewer ii
     join recruitment_interview i on i.id = ii.interview_id and i.tenant_id = ii.tenant_id
     left join recruitment_job_opening j on j.id = i.job_id
     left join recruitment_application a on a.id = i.application_id
     left join recruitment_candidate c on c.id = a.candidate_id
     where ii.tenant_id = ${s.tenantId}::uuid and ii.app_user_id = ${me} and i.cancelled_at is null and i.candidate_response <> 'declined'
       and i.starts_at <= ${now.toISOString()}::timestamptz and ${scoped(sql`ii.company_id`)}
       and not exists (select 1 from recruitment_scorecard sc where sc.interview_id = i.id and sc.interviewer_user_id = ${me})
     order by i.starts_at desc limit ${TODO_LIMIT})
    ${reviewBranch}
    union all
    -- Slice 10: the HR contact's Enabled contracts from 30 days before their end date until the end date (Kuala Lumpur
    -- dates), through the contact's own index; the item's date is the contract's END date (what My tasks and the bell show).
    (select 'contractExpiry', c.id, c.company_id, null, concat_ws(' · ', a.name, c.name), null, null, false, null, null, null,
       (c.ends_on::timestamp at time zone 'Asia/Kuala_Lumpur'), null, c.ends_on, null
     from recruitment_agency_contract c
     left join recruitment_agency a on a.id = c.agency_id
     where c.tenant_id = ${s.tenantId}::uuid and c.hr_contact_user_id = ${me} and c.status = 'enabled'
       and c.ends_on between ${today}::date and ${today}::date + ${CONTRACT_EXPIRY_NOTICE_DAYS}::int and ${scoped(sql`c.company_id`)}
       -- …while the contact still administers the company (a demoted contact gets no to-do and cannot read the contract).
       and app.can_admin_recruitment_for(c.company_id)
     order by c.ends_on, c.id limit ${TODO_LIMIT})
    union all
    -- Slice 11: the viewer's OPEN screening requests, through the reviewer's own index; row security admits them only while the
    -- viewer is a hiring manager of the job. Gone once answered with Advance or Reject, withdrawn, or closed by itself when the
    -- application is archived or hired or the reviewer leaves the job's hiring managers (5861). The note is not read.
    (select 'screening', q.id, q.company_id, q.job_id, j.title, j.job_number,
       case when c.destroyed_at is null then c.full_name end, coalesce(c.destroyed_at is not null, false), null, null, null, q.sent_at, null, null, null
     from recruitment_screening_request q
     left join recruitment_application a on a.id = q.application_id
     left join recruitment_job_opening j on j.id = q.job_id
     left join recruitment_candidate c on c.id = a.candidate_id
     where q.tenant_id = ${s.tenantId}::uuid and q.reviewer_user_id = ${me} and q.closed_at is null and ${scoped(sql`q.company_id`)}
     order by q.sent_at desc limit ${TODO_LIMIT})
    union all
    -- Slice 12: the viewer's OWN background checks (as recorder) waiting for the candidate's authorisation, newest first, dated
    -- when the check was added. The inner read walks the recorder's partial index in order and keeps a row only while the
    -- viewer still operates its job (the predicate is evaluated on each row the walk reaches, inside the LIMIT), so checks on
    -- jobs the recorder no longer runs are skipped and never crowd out real ones; the walk stops at TODO_LIMIT kept rows. A
    -- removed candidate's open checks were cancelled by the removal (5862), so they are not in the index at all. Only those
    -- few rows are then joined (one primary-key probe each). Only the check's own columns are read — never its restricted
    -- details.
    (select 'backgroundCheckAuthorisation', b.id, b.company_id, b.job_id, j.title, j.job_number, c.full_name, false, null, null, null, b.created_at, null, null,
       b.application_id
     from (select x.id, x.company_id, x.job_id, x.application_id, x.created_at from recruitment_background_check x
       where x.tenant_id = ${s.tenantId}::uuid and x.created_by_user_id = ${me} and x.status = 'awaiting_authorisation' and ${scoped(sql`x.company_id`)}
         and app.can_operate_recruitment_job(x.company_id, x.job_id)
       order by x.created_at desc limit ${TODO_LIMIT}) b
     -- One primary-key probe per kept row (LIMIT keeps the planner from joining the job's whole pipeline first).
     left join lateral (select c.full_name, c.destroyed_at from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id
       where a.id = b.application_id limit 1) c on true
     left join recruitment_job_opening j on j.id = b.job_id
     where c.destroyed_at is null
     order by b.created_at desc limit ${TODO_LIMIT})
    union all
    -- …and theirs In progress for MORE than 14 Kuala Lumpur days: started before the start of the Kuala Lumpur day 14 days before
    -- today (started on KL day S, due from KL day S + 15 — background-check-model.ts checkOverdue), oldest first through the
    -- recorder's in-progress index, filtered and bounded the same way; dated from the start of the day it became overdue.
    (select 'backgroundCheckOverdue', b.id, b.company_id, b.job_id, j.title, j.job_number, c.full_name, false, null, null, null,
       (((b.started_at at time zone 'Asia/Kuala_Lumpur')::date + ${CHECK_OVERDUE_DAYS + 1}::int)::timestamp at time zone 'Asia/Kuala_Lumpur'), null, null,
       b.application_id
     from (select x.id, x.company_id, x.job_id, x.application_id, x.started_at from recruitment_background_check x
       where x.tenant_id = ${s.tenantId}::uuid and x.created_by_user_id = ${me} and x.status = 'in_progress'
         and x.started_at < ((${today}::date - ${CHECK_OVERDUE_DAYS}::int)::timestamp at time zone 'Asia/Kuala_Lumpur') and ${scoped(sql`x.company_id`)}
         and app.can_operate_recruitment_job(x.company_id, x.job_id)
       order by x.started_at limit ${TODO_LIMIT}) b
     -- One primary-key probe per kept row (LIMIT keeps the planner from joining the job's whole pipeline first).
     left join lateral (select c.full_name, c.destroyed_at from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id
       where a.id = b.application_id limit 1) c on true
     left join recruitment_job_opening j on j.id = b.job_id
     where c.destroyed_at is null
     order by b.started_at, b.id limit ${TODO_LIMIT})`);
  return rows.map(todoOf).sort(byNewest);
}

/** The earlier recruitmentTodos: one transaction as the viewer (no statement timeout: the comparison must not depend on one). */
export async function originalRecruitmentTodos(s: SessionContext, scopeIds: readonly string[] | undefined, opts: { now?: Date } = {}): Promise<RecruitmentTodo[]> {
  if (!s.userId) return [];
  const scope = scopeIds ? scopeIds.filter(isUuid) : undefined;
  return withRecruitmentTenant(s, (tx) => personalTodosTx(tx, s, scope, opts.now ?? new Date()));
}
