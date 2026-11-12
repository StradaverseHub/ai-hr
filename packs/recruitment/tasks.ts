/**
 * Recruitment slice 9 — tasks and updates (docs/recruitment-reconstruction/specification.md "Slice 9"). Reached from
 * outside the pack ONLY through ./service.
 *
 * Everything here is COMPUTED LIVE from the current recruitment records (D-031). Every read runs inside
 * `withRecruitmentTenant` as the viewer, under the viewer's own row security (5201–5208): there is no definer function
 * and no owner read, so a to-do or an update can only name a job, requisition, offer or candidate the viewer could open
 * on the HR pages already, and it disappears the moment the action is done, the viewer loses access or the candidate is
 * removed (the candidate's name is then not read; the page shows the neutral label). The audience filters below
 * (approver of the pending step, interviewer, the job's recruiter or assistant, the offer's creator, the requisition's
 * requester) only NARROW what row security returns; they never widen it.
 *
 * The only stored state is the viewer's own "read up to" time per company and update category
 * (public.recruitment_task_read_marker, 5209, D-032).
 *
 * Cost. The bell provider (`pendingRecruitmentTasks`) runs on every authenticated render (and My tasks): it reads only the
 * viewer's personal to-dos, starting from the viewer's own rows through indexes, under a BELL_TIMEOUT_MS statement
 * timeout. The per-job counts (`recruitmentJobTodos`, Overview only, D-035) read at most TODO_JOB_LIMIT Open or On hold
 * jobs, stop at TODO_COUNT_CAP per job and carry their own JOB_TODOS_TIMEOUT_MS timeout. The updates
 * read each job's events newest first through (job, time) indexes, at most one page per job, and page by keyset
 * (time, id); unread counts start each category's read at the viewer's own read-up-to time.
 *
 * Never selected: a referral reason, an applicant's message, an offer value or salary, a scorecard rating, result or
 * overview, an approval comment, an agency's comments, a submission's contacts, ID number or salaries, or a screening note or
 * comment.
 *
 * Slice 10 adds two personal to-dos (an agency submission waiting for an administrator's review; the HR contact's contract
 * expiry from 30 days before its end date) and accepted agency submissions to the Applications updates. Slice 11 adds the
 * hiring manager's open screening requests as personal to-dos and their answers to the Applications updates. Slice 12 adds the
 * recorder's background checks waiting for authorisation, or In progress for more than 14 Kuala Lumpur days, as personal
 * to-dos (never a summary, provider, reference or outcome).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { withRecruitmentTenant } from '../../core/module-gate';
import { pgSqlState } from '../../lib/db-error';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { CONTRACT_EXPIRY_NOTICE_DAYS } from './agency-model';
import { CHECK_OVERDUE_DAYS } from './background-check-model';
import type { PackTaskItem } from '../../lib/assigned-work';
import { RecruitmentError, isUuid } from './model';
import { uuidArray } from './data';
import {
  BELL_TIMEOUT_MS, JOB_TODOS_TIMEOUT_MS, TASK_CATEGORIES, TODO_COUNT_CAP, TODO_JOB_LIMIT, TODO_LIMIT, UNREAD_CAP, UPDATES_PAGE_SIZE, byNewest, decodeUpdatesCursor,
  encodeUpdatesCursor, isTaskCategory, parseUpdatesPage, readCategories, todoHref, todoToPackTask, updateHref, updatesHasMore, updatesSince,
  type RecruitmentTodo, type RecruitmentUpdate, type TaskCategory, type TodoKind, type UpdateKind,
} from './tasks-model';

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
    -- application is archived or hired or the reviewer leaves the job's hiring managers (5211). The note is not read.
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
    -- removed candidate's open checks were cancelled by the removal (5212), so they are not in the index at all. Only those
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

/** The per-job counts for the viewer's Open or On hold jobs as recruiter or assistant (D-035: Overview only). */
async function jobTodosTx(tx: Tx, s: SessionContext, scope: readonly string[] | undefined): Promise<RecruitmentTodo[]> {
  const scoped = scopedBy(scope);
  const rows = await tx.execute<TodoRow>(sql`
    with my_jobs as materialized (
      -- The viewer's Open or On hold jobs as recruiter or assistant (their own membership rows), the most recently
      -- updated first, bounded: closed jobs give no to-dos.
      select j.id, j.company_id, j.title, j.job_number, j.process_id from recruitment_job_opening j
      where j.id in (select m.job_id from recruitment_job_member m
          where m.tenant_id = ${s.tenantId}::uuid and m.app_user_id = ${me} and m.member_role in ('recruiter', 'assistant'))
        and j.tenant_id = ${s.tenantId}::uuid and j.status in ('open', 'on_hold') and ${scoped(sql`j.company_id`)}
      order by j.updated_at desc, j.id limit ${TODO_JOB_LIMIT}
    )
    -- Applications in an Interview-type stage of the job's process with no interview (upcoming or held, not cancelled)
    -- in that stage: one item per job, the count capped, linked to the first such stage.
    (select 'toSchedule'::text as kind, j.id, j.company_id, j.id as job_id, j.title, j.job_number as number, null::text as candidate_name, false as candidate_removed,
       x.n as count, null::int as position, null::int as steps, x.at, x.stage_id
     from my_jobs j
     cross join lateral (
       select count(*)::int as n, max(y.updated_at) as at, (array_agg(y.current_stage_id order by y.position))[1] as stage_id from (
         select a.updated_at, a.current_stage_id, ps.position
         from recruitment_process_stage ps
         join recruitment_stage st on st.id = ps.stage_id and st.stage_type = 'interview'
         join recruitment_application a on a.job_id = j.id and a.state = 'active' and a.current_stage_id = ps.stage_id
         where ps.process_id = j.process_id
           and not exists (select 1 from recruitment_interview i where i.application_id = a.id and i.stage_id = a.current_stage_id
             and i.cancelled_at is null)
         limit ${TODO_COUNT_CAP}) y) x
     where x.n > 0
     order by x.at desc limit ${TODO_LIMIT})
    union all
    -- Applications still in the job's first enabled stage that have not moved since they arrived (no history after
    -- 'applied'), from any source: one item per job, the count capped.
    (select 'toScreen', j.id, j.company_id, j.id, j.title, j.job_number, null, false, x.n, null, null, x.at, f.stage_id
     from my_jobs j
     cross join lateral (select ps.stage_id from recruitment_process_stage ps join recruitment_stage st on st.id = ps.stage_id and st.enabled
       where ps.process_id = j.process_id order by ps.position limit 1) f
     cross join lateral (
       select count(*)::int as n, max(y.applied_at) as at from (
         select a.applied_at from recruitment_application a
         where a.job_id = j.id and a.state = 'active' and a.current_stage_id = f.stage_id
           and not exists (select 1 from recruitment_application_event e where e.application_id = a.id and e.kind <> 'applied')
         limit ${TODO_COUNT_CAP}) y) x
     where x.n > 0
     order by x.at desc limit ${TODO_LIMIT})
    union all
    -- Slice 16: per company the viewer operates in (administrators included), the candidates with no application still shown on
    -- the To assign list, the count capped (the markers' own row security; an index read per company).
    -- The access check runs once per company, before any marker is read (a materialized set); the count stops at the cap.
    (select 'toAssign', c.id, c.id, null, c.legal_name, null, null, false, x.n, null, null, x.at, null
     from (select oc.id, oc.legal_name from company oc
       where oc.tenant_id = ${s.tenantId}::uuid and oc.archived_at is null and ${scoped(sql`oc.id`)} and app.recruitment_operates_in_company(oc.id)
       offset 0) c
     cross join lateral (
       select count(*)::int as n, max(y.created_at) as at from (
         select t.created_at from recruitment_to_assign t
         where t.tenant_id = ${s.tenantId}::uuid and t.company_id = c.id and t.hidden_at is null
         limit ${TODO_COUNT_CAP}) y) x
     where x.n > 0
     order by x.at desc limit ${TODO_LIMIT})`);
  return rows.map(todoOf).sort(byNewest);
}

/**
 * The viewer's personal to-do list, live (cases 59–61): requisition and offer approval steps at the viewer's current step
 * (tenant-wide) and interview feedback due (from the interview's start, `now` by default). `scopeIds` is the company
 * selection for the feedback (undefined: every company). Nothing for a viewer with no recruitment role. `timeoutMs`
 * bounds every statement of the read (the bell path).
 */
export async function recruitmentTodos(s: SessionContext, scopeIds: readonly string[] | undefined, opts: { now?: Date; timeoutMs?: number } = {}): Promise<RecruitmentTodo[]> {
  if (!s.userId) return [];
  const scope = scopeIds ? scopeIds.filter(isUuid) : undefined;
  return withRecruitmentTenant(s, async (tx) => {
    if (opts.timeoutMs) await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, Math.trunc(opts.timeoutMs)))}, true)`);
    return personalTodosTx(tx, s, scope, opts.now ?? new Date());
  });
}

export type RecruitmentJobTodos = { status: 'ok'; items: RecruitmentTodo[] } | { status: 'unavailable' };
/**
 * The Overview's per-job counts (D-035): for a job's recruiter and assistants, on at most TODO_JOB_LIMIT Open or On hold
 * jobs, applications to schedule and to screen, each count capped. Under its own statement timeout (default
 * JOB_TODOS_TIMEOUT_MS); a timeout or a database failure answers 'unavailable' (logged as the error's name and SQLSTATE)
 * so the page can say so in place instead of failing.
 */
export async function recruitmentJobTodos(s: SessionContext, scopeIds: readonly string[] | undefined, opts: { timeoutMs?: number } = {}): Promise<RecruitmentJobTodos> {
  if (!s.userId) return { status: 'ok', items: [] };
  const scope = scopeIds ? scopeIds.filter(isUuid) : undefined;
  try {
    return await withRecruitmentTenant(s, async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, Math.trunc(opts.timeoutMs ?? JOB_TODOS_TIMEOUT_MS)))}, true)`);
      return { status: 'ok' as const, items: await jobTodosTx(tx, s, scope) };
    });
  } catch (e) {
    if (e instanceof RecruitmentError) throw e;
    console.error('recruitment job counts failed', e instanceof Error ? e.name : typeof e, pgSqlState(e) ?? '');
    return { status: 'unavailable' };
  }
}

/**
 * The recruitment tasks for the bell and My tasks (core/approvals-inbox.ts PACK_TASK_SOURCES; called only while the
 * module is enabled for the caller): the viewer's personal to-dos only (D-035), projected to id, kind, subject, owner
 * time and link, under a BELL_TIMEOUT_MS statement timeout. The root layout renders the bell on every route, so a failure
 * or a timeout here hides the recruitment rows only (logged as the error's name and SQLSTATE; a database message carries
 * bound values) instead of failing or slowing every page.
 */
export async function pendingRecruitmentTasks(s: SessionContext, scopeIds: string[] | undefined): Promise<PackTaskItem[]> {
  try {
    return (await recruitmentTodos(s, scopeIds, { timeoutMs: BELL_TIMEOUT_MS })).flatMap((t) => todoToPackTask(t) ?? []);
  } catch (e) {
    console.error('recruitment tasks failed', e instanceof Error ? e.name : typeof e, pgSqlState(e) ?? '');
    return [];
  }
}

// ── Updates ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Which events a read takes: newer than (or from) `since`, older than the keyset position `before`, at most `perSource`
 *  from each job or source, newest first. */
type UpdateRange = { since: Date; strict: boolean; before: { at: string; id: string } | null; perSource: number };

/** The time filter and keyset bound on one source's (time, id) columns. */
function bounds(at: SQL, id: SQL, r: UpdateRange): SQL {
  const since = sql`${r.since.toISOString()}::timestamptz`;
  const from = r.strict ? sql`${at} > ${since}` : sql`${at} >= ${since}`;
  if (!r.before) return from;
  const until = sql`${r.before.at}::timestamptz`;
  return sql`${from} and ${at} <= ${until} and (${at}, ${id}) < (${until}, ${r.before.id}::text)`;
}

/**
 * One category's events as (id, kind, company, time, requisition, job, application), already narrowed to the viewer's
 * audience and to events caused by someone else, within the range, newest first. Each job (or the viewer's own offers
 * and requisitions touched in the range) contributes at most `perSource` rows, read through its (job, time) index; row
 * security decides what exists at all.
 */
function updateSource(s: SessionContext, category: TaskCategory, companies: readonly string[], r: UpdateRange): SQL {
  const t = sql`${s.tenantId}::uuid`;
  const ids = sql`${uuidArray(companies)}::uuid[]`;
  const touched = sql`${r.since.toISOString()}::timestamptz`;
  const limit = sql`limit ${r.perSource}`;
  const operated = sql`(select distinct m.job_id from recruitment_job_member m
    where m.tenant_id = ${t} and m.app_user_id = ${me} and m.member_role in ('recruiter', 'assistant') and m.company_id = any(${ids}))`;
  switch (category) {
    // The requester (creator) of a requisition: its final approval in the current round, and every denial. Every decision
    // updates the requisition, so only those touched since the start of the range are read.
    case 'requisitions':
      return sql`select * from (select d.id::text as id, case when d.decision = 'rejected' then 'requisitionDenied' else 'requisitionApproved' end as kind,
          r.company_id, d.acted_at as at, r.id as requisition_id, null::uuid as job_id, null::uuid as application_id
        from recruitment_requisition r
        join recruitment_requisition_approval d on d.requisition_id = r.id and d.tenant_id = r.tenant_id
        where r.tenant_id = ${t} and r.created_by_user_id = ${me} and r.updated_at >= ${touched} and r.company_id = any(${ids})
          and ${bounds(sql`d.acted_at`, sql`d.id::text`, r)} and d.approver_user_id <> ${me}
          and (d.decision = 'rejected' or (d.round = r.approval_round and d.position = cardinality(r.approver_user_ids)))
        order by d.acted_at desc, d.id::text desc ${limit}) q`;
    // The offer's creator and the job's recruiter: the final approval of the current round, every denial, and the
    // candidate's decision (recorded by a person, who is not named). Only offers touched since the range start.
    case 'offers': {
      const audience = sql`(select o.id from recruitment_offer o where o.tenant_id = ${t} and o.created_by_user_id = ${me} and o.updated_at >= ${touched}
          union select o.id from recruitment_offer o where o.updated_at >= ${touched} and o.job_id in (select m.job_id from recruitment_job_member m
            where m.tenant_id = ${t} and m.app_user_id = ${me} and m.member_role = 'recruiter'))`;
      return sql`select * from (select d.id::text as id, case when d.decision = 'rejected' then 'offerDenied' else 'offerApproved' end as kind,
          o.company_id, d.acted_at as at, null::uuid as requisition_id, o.job_id, o.application_id
        from recruitment_offer o
        join recruitment_offer_approval d on d.offer_id = o.id and d.tenant_id = o.tenant_id
        where o.id in ${audience} and o.company_id = any(${ids}) and ${bounds(sql`d.acted_at`, sql`d.id::text`, r)} and d.approver_user_id <> ${me}
          and (d.decision = 'rejected' or (d.round = o.approval_round and d.position = cardinality(o.approver_user_ids)))
        order by d.acted_at desc, d.id::text desc ${limit}) q
        union all
        select * from (select o.id::text || ':decision' as id, case when o.candidate_decision = 'accepted' then 'offerAccepted' else 'offerDeclined' end as kind,
          o.company_id, o.decided_at as at, null::uuid as requisition_id, o.job_id, o.application_id
        from recruitment_offer o
        where o.id in ${audience} and o.company_id = any(${ids}) and o.candidate_decision <> 'pending'
          and ${bounds(sql`o.decided_at`, sql`(o.id::text || ':decision')`, r)} and o.decided_by_user_id <> ${me}
        order by o.decided_at desc, o.id::text desc ${limit}) q2`;
    }
    // The job's recruiter and assistants: feedback submitted on an interview of their job (when, not what).
    case 'interviews':
      return sql`select x.* from ${operated} mj cross join lateral (
          select sc.id::text as id, 'feedbackSubmitted'::text as kind, sc.company_id, sc.submitted_at as at,
            null::uuid as requisition_id, sc.job_id, sc.application_id
          from recruitment_scorecard sc
          where sc.job_id = mj.job_id and sc.tenant_id = ${t} and ${bounds(sql`sc.submitted_at`, sql`sc.id::text`, r)} and sc.interviewer_user_id <> ${me}
          order by sc.submitted_at desc, sc.id::text desc ${limit}) x`;
    // The job's recruiter and assistants: a new application from the careers page, an employee referral or an agency.
    case 'applications':
      return sql`select x.* from ${operated} mj cross join lateral (
          select ca.application_id::text || ':careers' as id, 'careersApplication'::text as kind, ca.company_id, ca.received_at as at,
            null::uuid as requisition_id, ca.job_id, ca.application_id
          from recruitment_careers_application ca
          where ca.job_id = mj.job_id and ca.tenant_id = ${t} and ${bounds(sql`ca.received_at`, sql`(ca.application_id::text || ':careers')`, r)}
          order by ca.received_at desc, ca.application_id::text desc ${limit}) x
        union all
        select y.* from ${operated} mj cross join lateral (
          select rf.id::text as id, 'referral'::text as kind, rf.company_id, rf.created_at as at, null::uuid as requisition_id, rf.job_id, rf.application_id
          from recruitment_referral rf
          where rf.job_id = mj.job_id and rf.tenant_id = ${t} and ${bounds(sql`rf.created_at`, sql`rf.id::text`, r)} and rf.referrer_user_id <> ${me}
          order by rf.created_at desc, rf.id::text desc ${limit}) y
        union all
        -- Slice 10: an agency submission accepted onto the job (at once, or by an administrator's review), not by the viewer.
        select z.* from ${operated} mj cross join lateral (
          select sb.id::text as id, 'agencySubmission'::text as kind, sb.company_id, sb.decided_at as at, null::uuid as requisition_id, sb.job_id, sb.application_id
          from recruitment_agency_submission sb
          where sb.job_id = mj.job_id and sb.tenant_id = ${t} and sb.outcome = 'accepted' and ${bounds(sql`sb.decided_at`, sql`sb.id::text`, r)}
            and sb.decided_by_user_id <> ${me}
          order by sb.decided_at desc, sb.id::text desc ${limit}) z
        union all
        -- Slice 11: a hiring manager's screening answer on the job (that one arrived, and its result's kind of event — never
        -- the comment), not the viewer's own, through the job's (job, time) index.
        select w.* from ${operated} mj cross join lateral (
          select x.id::text as id, 'screeningFeedback'::text as kind, x.company_id, x.answered_at as at, null::uuid as requisition_id, x.job_id, x.application_id
          from recruitment_screening_answer x
          where x.job_id = mj.job_id and x.tenant_id = ${t} and ${bounds(sql`x.answered_at`, sql`x.id::text`, r)} and x.answered_by_user_id <> ${me}
          order by x.answered_at desc, x.id::text desc ${limit}) w`;
  }
}

/** The companies of `companyIds` whose recruitment the viewer may see (5202), in the order given. */
async function visibleCompaniesTx(tx: Tx, companyIds: readonly string[]): Promise<string[]> {
  if (!companyIds.length) return [];
  const rows = await tx.execute<{ id: string }>(sql`select c.id from unnest(${uuidArray(companyIds)}::uuid[]) with ordinality c(id, n)
    where app.can_see_recruitment_company(c.id) order by c.n`);
  return rows.map((r) => r.id);
}
const companyList = (companyIds: readonly string[]) => {
  if (!companyIds.every(isUuid)) throw new RecruitmentError('invalid_input');
  return [...new Set(companyIds)];
};

type UpdateRow = {
  id: string; kind: UpdateKind; company_id: string; at: string | Date; requisition_id: string | null; job_id: string | null;
  application_id: string | null; title: string | null; number: string | null; candidate_name: string | null; candidate_removed: boolean; unread: boolean;
};
export type RecruitmentUpdatesPage = { items: RecruitmentUpdate[]; page: number; hasMore: boolean; nextCursor: string | null };

/**
 * One page of one category's updates for the viewer in `companyIds` (case 62): newest first, UPDATES_PAGE_SIZE per page,
 * the last 90 days, the viewer's own actions left out, paged by keyset (`after`: the cursor of the previous page's last
 * update; `page` counts pages for the UPDATES_MAX_PAGE bound). `unread` compares with the viewer's marker for the company.
 */
export async function recruitmentUpdates(s: SessionContext, input: {
  companyIds: readonly string[]; category: unknown; page?: unknown; after?: unknown; now?: Date;
}): Promise<RecruitmentUpdatesPage> {
  if (!isTaskCategory(input.category)) throw new RecruitmentError('invalid_input');
  const category = input.category;
  const before = input.after == null || input.after === '' ? null : decodeUpdatesCursor(input.after);
  if (input.after != null && input.after !== '' && !before) throw new RecruitmentError('invalid_input');
  const page = before ? parseUpdatesPage(input.page) : 1;
  const requested = companyList(input.companyIds);
  const empty = { items: [], page, hasMore: false, nextCursor: null };
  if (!s.userId || !requested.length) return empty;
  return withRecruitmentTenant(s, async (tx) => {
    const companies = await visibleCompaniesTx(tx, requested);
    if (!companies.length) return empty;
    const range: UpdateRange = { since: updatesSince(input.now ?? new Date()), strict: false, before, perSource: UPDATES_PAGE_SIZE + 1 };
    const rows = await tx.execute<UpdateRow>(sql`
      select u.id, u.kind, u.company_id, u.at, u.requisition_id, u.job_id, u.application_id,
        coalesce(j.title, r.title) as title, coalesce(j.job_number, r.req_number) as number,
        case when c.destroyed_at is null then c.full_name end as candidate_name, coalesce(c.destroyed_at is not null, false) as candidate_removed,
        coalesce(u.at > mk.read_up_to, false) as unread
      from (select * from (${updateSource(s, category, companies, range)}) src order by src.at desc, src.id desc limit ${UPDATES_PAGE_SIZE + 1}) u
      left join recruitment_job_opening j on j.id = u.job_id
      left join recruitment_requisition r on r.id = u.requisition_id
      left join recruitment_application a on a.id = u.application_id
      left join recruitment_candidate c on c.id = a.candidate_id
      left join recruitment_task_read_marker mk on mk.tenant_id = ${s.tenantId}::uuid and mk.app_user_id = ${me}
        and mk.company_id = u.company_id and mk.category = ${category}
      order by u.at desc, u.id desc`);
    const items = rows.slice(0, UPDATES_PAGE_SIZE).map((r) => ({
      id: r.id, category, kind: r.kind, companyId: r.company_id, jobId: r.job_id, title: r.title, number: r.number,
      candidateName: r.candidate_removed ? null : r.candidate_name, candidateRemoved: r.candidate_removed === true, at: iso(r.at),
      href: updateHref(r.kind, { requisitionId: r.requisition_id, applicationId: r.application_id }), unread: r.unread === true,
    }));
    const hasMore = updatesHasMore(page, rows.length);
    const last = items[items.length - 1];
    return { items, page, hasMore, nextCursor: hasMore && last ? encodeUpdatesCursor(last.at, last.id) : null };
  });
}

/** Give the viewer a marker at now() for each visible company and category that has none (the first open, D-032). */
async function initialiseMarkersTx(tx: Tx, s: SessionContext, companies: readonly string[]): Promise<void> {
  if (!companies.length) return;
  await tx.execute(sql`insert into recruitment_task_read_marker (tenant_id, company_id, app_user_id, category, read_up_to)
    select ${s.tenantId}::uuid, c.id, ${me}, k.category, now()
    from unnest(${uuidArray(companies)}::uuid[]) c(id) cross join unnest(${`{${TASK_CATEGORIES.join(',')}}`}::text[]) k(category)
    on conflict (tenant_id, app_user_id, company_id, category) do nothing`);
}

/**
 * Unread updates per category in `companyIds` (case 63), each capped at UNREAD_CAP. The first call for a company gives the
 * viewer its markers at now(), so a new viewer starts with nothing unread (D-032). The viewer's markers are read first and
 * each category's events are read only after its read-up-to time (companies sharing a time are read together).
 */
export async function recruitmentUnreadCounts(s: SessionContext, companyIds: readonly string[], opts: { now?: Date } = {}): Promise<Record<TaskCategory, number>> {
  const zero = Object.fromEntries(TASK_CATEGORIES.map((c) => [c, 0])) as Record<TaskCategory, number>;
  const requested = companyList(companyIds);
  if (!s.userId || !requested.length) return zero;
  return withRecruitmentTenant(s, async (tx) => {
    const companies = await visibleCompaniesTx(tx, requested);
    if (!companies.length) return zero;
    await initialiseMarkersTx(tx, s, companies);
    const markers = await tx.execute<{ company_id: string; category: TaskCategory; read_up_to: string | Date }>(sql`
      select company_id, category, read_up_to from recruitment_task_read_marker
      where tenant_id = ${s.tenantId}::uuid and app_user_id = ${me} and company_id = any(${uuidArray(companies)}::uuid[])`);
    const window = updatesSince(opts.now ?? new Date());
    const groups = new Map<string, { category: TaskCategory; since: Date; strict: boolean; companies: string[] }>();
    for (const m of markers) {
      if (!isTaskCategory(m.category)) continue;
      const read = new Date(m.read_up_to);
      const strict = read.getTime() >= window.getTime();
      const since = strict ? read : window;
      const key = `${m.category}|${since.toISOString()}|${strict}`;
      const group = groups.get(key) ?? { category: m.category, since, strict, companies: [] };
      group.companies.push(m.company_id);
      groups.set(key, group);
    }
    if (!groups.size) return zero;
    const parts = [...groups.values()].map((g) => sql`select ${g.category}::text as category, (select count(*)::int from (
        select 1 from (${updateSource(s, g.category, g.companies, { since: g.since, strict: g.strict, before: null, perSource: UNREAD_CAP })}) u
        limit ${UNREAD_CAP}) z) as n`);
    const rows = await tx.execute<{ category: TaskCategory; n: number }>(sql.join(parts, sql` union all `));
    const out = { ...zero };
    for (const r of rows) out[r.category] = Math.min(UNREAD_CAP, out[r.category] + r.n);
    return out;
  });
}

/**
 * "Mark all as read" (case 63): moves the viewer's OWN read marker to now() for one category or for all, in each of
 * `companyIds`. A company whose recruitment the viewer may not see is refused; nobody can move another user's marker
 * (the service only ever writes the viewer's rows, and row security refuses any other).
 */
export async function markRecruitmentTasksRead(s: SessionContext, companyIds: readonly string[], category: unknown): Promise<void> {
  if (category !== 'all' && !isTaskCategory(category)) throw new RecruitmentError('invalid_input');
  const requested = companyList(companyIds);
  if (!s.userId) throw new RecruitmentError('forbidden');
  if (!requested.length) throw new RecruitmentError('invalid_input');
  const categories = readCategories(category);
  await withRecruitmentTenant(s, async (tx) => {
    const companies = await visibleCompaniesTx(tx, requested);
    if (companies.length !== requested.length) throw new RecruitmentError('forbidden');
    await tx.execute(sql`insert into recruitment_task_read_marker (tenant_id, company_id, app_user_id, category, read_up_to)
      select ${s.tenantId}::uuid, c.id, ${me}, k.category, now()
      from unnest(${uuidArray(companies)}::uuid[]) c(id) cross join unnest(${`{${categories.join(',')}}`}::text[]) k(category)
      on conflict (tenant_id, app_user_id, company_id, category) do update set read_up_to = excluded.read_up_to`);
  });
}
