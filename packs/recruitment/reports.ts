/**
 * Recruitment slice 6 — the four fixed report dashboards (Overview, Positions, Interviews, Team). Reached from outside
 * the pack ONLY through ./service.
 *
 * Every dashboard:
 *   1. refuses a malformed period, one outside 2000–2100 or one longer than 24 months before any SQL runs (./report-model);
 *   2. passes the Recruitment module gate, then runs as the CALLER (the app role, so row security applies to every
 *      table it reads) inside ONE read-only REPEATABLE READ snapshot with a LOCAL per-statement timeout (5 s) and a
 *      whole-dashboard time budget (20 s) checked before every statement — PostgreSQL 16 has no transaction_timeout, so
 *      the snapshot lives at most budget + one statement. A timeout (SQLSTATE 57014) or an overrun becomes
 *      RecruitmentError('report_too_slow'), which the page shows as a message, never an error page. A slow report holds
 *      no lock a writer waits for;
 *   3. narrows itself further than row security: a company counts only when the caller administers its recruitment
 *      (app.can_admin_recruitment_for) or is a recruiter, assistant or hiring manager on one of its jobs; in a company
 *      the caller does not administer, only those jobs count (app.recruitment_has_job_role, 4402). The job scope is
 *      computed ONCE per dashboard and passed to every later statement as a uuid[] (row security still applies to
 *      each). An interviewer alone, an approver or anyone else gets `forbidden`. Team is for administrators (D-018);
 *   4. is a small fixed number of aggregate statements (no per-job loop): setup 3 (settings + snapshot facts, companies,
 *      job scope), then Overview 4, Positions 2, Interviews 1, Team 2. Per-job and per-recruiter tables stop at 100.
 *
 * AGGREGATES ONLY. No statement here selects a candidate's name, email, phone, profile, file, restricted value, note,
 * scorecard text or offer value: only ids used inside SQL, states, stages, sources, dates and counts leave the
 * database, and job titles/numbers and recruiter names (people on the hiring team, not applicants). Removed candidates
 * (slice 5) keep their application skeleton, so they still count, anonymously. Nothing calls a model.
 *
 * Measures (the period is the application's creation date unless the measure says otherwise):
 *   Overview / Positions — the applications received in the period and what has happened to them since: interviewed
 *     (an interview held: not cancelled and ended), offers created / sent, accepted / declined, hired, rejected
 *     (archived). Days to hire = Kuala Lumpur day of the hire event − day applied. Funnel = applications that ever
 *     entered each stage of the job's process, from recruitment_application_event (applied / moved rows carry the
 *     stage entered), whatever happened later. "Now at Onboarding" and "active by stage" are the present state.
 *     Requisitions = non-draft requisitions opened (date opened, else created) in the period; completion = filled ÷
 *     vacancies, filled = min(hires on the requisition's jobs, vacancies), the slice 4 figures. They are shown only when
 *     every covered company (or the filtered job's company) is one the caller administers; otherwise they are hidden,
 *     never shown as 0.
 *   Interviews — by the interview's start: held = not cancelled and already ended; feedback rate = submitted scorecards
 *     ÷ interviewer places on held interviews; pending = places without a scorecard; upcoming = not cancelled and not
 *     yet started (from now); pass rate = of the interviewed applications (their latest held interview in the period),
 *     those hired or entering a stage after that interview's stage AT OR AFTER its start ÷ those with an outcome
 *     (passed, or archived without passing).
 *   Team — work done in the period, credited to each job's CURRENT recruiter: applications moved out of their first
 *     stage (moves, rejections and hires out of the stage the application started in), interviews scheduled, offers
 *     created, hires. Counts of work, not a rating of people.
 */
import { sql, type SQL } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../../db/client';
import { assertModuleGate } from '../../core/module-gate';
import { HR_LOCAL_TZ, todayInKualaLumpur } from '../../lib/hr-date';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, type RecruitmentErrorCode } from './model';
import { uuidArray } from './data';
import { CANDIDATE_SOURCES, type CandidateSource } from './privacy-model';
import {
  REPORT_BUDGET_MS, REPORT_JOB_LIMIT, REPORT_JOB_OPTION_LIMIT, REPORT_RECRUITER_LIMIT, REPORT_STATEMENT_TIMEOUT_MS, averageDays, fillBuckets,
  granularity, parseReportFilters, periodChange, periodInstants, previousPeriod, rate,
  type Bucket, type Granularity, type ReportFilterInput, type ReportKind, type ReportPeriod,
} from './report-model';

const REPORT_ROLES = sql`array['recruiter','assistant','hiring_manager']::text[]`;

export type ReportScope = {
  kind: ReportKind;
  /** The companies this dashboard may cover for the caller (Team: administered ones only). */
  companies: { id: string; name: string; admin: boolean }[];
  companyId: string | null; jobId: string | null; departmentId: string | null;
  period: ReportPeriod; granularity: Granularity;
  /** Filter choices: the caller's jobs (newest first, at most 500) and their departments. */
  jobs: { id: string; jobNumber: string; title: string; companyId: string }[]; jobsTruncated: boolean;
  departments: { id: string; name: string }[];
  /** Every covered company is one the caller administers (company-wide figures). */
  adminScope: boolean;
  /** Requisition figures are shown (every covered company, or the filtered job's company, is administered). */
  requisitionsVisible: boolean;
  /** The caller administers at least one company here, so the Team dashboard is open to them. */
  teamAvailable: boolean;
  /** With `fallback`: the refusal of a filter that was dropped (the dashboard ran without it). */
  refused: RecruitmentErrorCode | null;
  /** Observed inside the dashboard's own transaction; `statements` counts every statement it ran. */
  snapshot: { readOnly: boolean; isolation: string; statementTimeoutMs: number; statements: number };
};

export type ReportOptions = {
  now?: Date;
  /** The page's mode: a refused filter (period, company or job) is dropped and reported in scope.refused instead of
   *  thrown, so one run serves the page. Service callers and tests default to refusals. */
  fallback?: boolean;
  /** The whole-dashboard budget (tests shrink it to prove the overrun path). */
  budgetMs?: number;
};

/** "This report took too long": carries the dashboard's scope when it was already known, so the page keeps its filters. */
export class ReportTooSlowError extends RecruitmentError {
  constructor(public readonly scope: ReportScope | null) {
    super('report_too_slow');
  }
}
/** A statement timeout (or cancel, SQLSTATE 57014) is the same refusal as a budget overrun; anything else is unchanged. */
export function toReportError(e: unknown, scope: ReportScope | null = null): unknown {
  if (e instanceof RecruitmentError) return e;
  if (pgSqlState(e) === '57014') return new ReportTooSlowError(scope);
  return e;
}

type Ctx = {
  tx: Tx; s: SessionContext; now: Date; scope: ReportScope;
  selected: string;
  /** The caller's report jobs after the job and department filters, computed once. */
  jobIds: string;
  fromTs: string; toTs: string;
  q: <T extends Record<string, unknown>>(query: SQL) => Promise<T[]>;
};

/** The applications received in the period on the report jobs (index: tenant, company, applied_at — 4406). */
const cohort = (c: Ctx) => sql`select a.id, a.job_id, a.state, a.candidate_id, a.applied_at
    from recruitment_application a
    where a.tenant_id = ${c.s.tenantId}::uuid and a.company_id = any(${c.selected}::uuid[]) and a.job_id = any(${c.jobIds}::uuid[])
      and a.applied_at >= ${c.fromTs}::timestamptz and a.applied_at < ${c.toTs}::timestamptz`;
/** An interview that has been held: not cancelled and already over. */
const held = (c: Ctx, i: SQL) => sql`${i}.cancelled_at is null and ${i}.starts_at + make_interval(mins => ${i}.duration_minutes) <= ${c.now.toISOString()}::timestamptz`;

async function runReport<T>(
  s: SessionContext, scopeIds: readonly string[], input: ReportFilterInput, kind: ReportKind, opts: ReportOptions,
  body: (c: Ctx) => Promise<T>,
): Promise<T & { scope: ReportScope }> {
  const now = opts.now ?? new Date();
  const today = todayInKualaLumpur(now);
  let refused: RecruitmentErrorCode | null = null;
  let parsed = parseReportFilters(input, today);
  if (!parsed.ok && opts.fallback) {
    refused = parsed.code;
    parsed = parseReportFilters({ ...input, from: undefined, to: undefined }, today);
  }
  if (!parsed.ok) throw new RecruitmentError(parsed.code);
  const filters = parsed.filters;
  const ids = scopeIds.filter(isUuid);
  if (!s.userId || !ids.length) throw new RecruitmentError('forbidden');
  assertModuleGate(s, 'recruitment');
  const started = Date.now();
  const budget = opts.budgetMs ?? REPORT_BUDGET_MS;
  let statements = 0;
  let known: ReportScope | null = null;
  try {
    return await withTenant(s, async (tx) => {
      // Every statement passes the budget first: none starts once the dashboard has used its time.
      const q = async <R extends Record<string, unknown>>(query: SQL): Promise<R[]> => {
        if (Date.now() - started > budget) throw new ReportTooSlowError(known);
        statements += 1;
        return [...await tx.execute<R>(query)] as R[];
      };
      // 1. The per-statement ceiling (a caller's tighter one is kept; SET LOCAL ends with the transaction) and the facts the
      //    test reads back: read-only, isolation level.
      const [snap] = await q<{ timeout_ms: number; applied: string; read_only: string; isolation: string }>(sql`
        select v.ms as timeout_ms, set_config('statement_timeout', v.ms::text, true) as applied,
          current_setting('transaction_read_only') as read_only, current_setting('transaction_isolation') as isolation
        from (select least(coalesce(nullif(setting::int, 0), ${REPORT_STATEMENT_TIMEOUT_MS}), ${REPORT_STATEMENT_TIMEOUT_MS})::int as ms
          from pg_catalog.pg_settings where name = 'statement_timeout') v`);
      // 2. Companies: administered, or with a job where the caller is recruiter, assistant or hiring manager.
      const companyRows = await q<{ id: string; name: string; admin: boolean; reporter: boolean }>(sql`
        select c.id, c.legal_name as name, app.can_admin_recruitment_for(c.id) as admin,
          exists (select 1 from recruitment_job_member m where m.tenant_id = c.tenant_id and m.company_id = c.id
            and m.app_user_id = app.current_user_id() and m.member_role = any(${REPORT_ROLES})) as reporter
        from company c
        where c.tenant_id = ${s.tenantId}::uuid and c.id = any(${uuidArray(ids)}::uuid[]) and c.archived_at is null
        order by c.legal_name, c.id`);
      const allowed = companyRows.filter((r) => (kind === 'team' ? r.admin : r.admin || r.reporter)).map((r) => ({ id: r.id, name: r.name, admin: r.admin }));
      if (!allowed.length) throw new RecruitmentError('forbidden');
      let companyId = filters.companyId;
      let chosen = companyId ? allowed.filter((c) => c.id === companyId) : allowed;
      if (!chosen.length) {
        if (!opts.fallback) throw new RecruitmentError('forbidden');
        refused = 'forbidden';
        companyId = null;
        chosen = allowed;
      }
      const selected = uuidArray(chosen.map((c) => c.id));
      const adminSelected = uuidArray(chosen.filter((c) => c.admin).map((c) => c.id));
      // 3. The job scope, ONCE: every job of an administered company, else the caller's own jobs; the filtered ids, the
      //    filter choices, and the filtered job's company (null when the job is not the caller's to report on).
      const jobId = filters.jobId;
      const [js] = await q<{
        ids: string[]; any_job_ids: string[] | null; options: { id: string; jobNumber: string; title: string; companyId: string }[] | null;
        departments: { id: string; name: string }[] | null; job_company: string | null;
      }>(sql`
        with sj as materialized (
          select j.id, j.company_id, j.job_number, j.title, j.department_id, j.created_at from recruitment_job_opening j
          where j.tenant_id = ${s.tenantId}::uuid and j.company_id = any(${selected}::uuid[])
            and (j.company_id = any(${adminSelected}::uuid[]) or app.recruitment_has_job_role(j.id, ${REPORT_ROLES})))
        select
          coalesce((select array_agg(sj.id order by sj.id) from sj
            where (${jobId}::uuid is null or sj.id = ${jobId}::uuid) and (${filters.departmentId}::uuid is null or sj.department_id = ${filters.departmentId}::uuid)), '{}') as ids,
          ${jobId && opts.fallback ? sql`(select array_agg(sj.id order by sj.id) from sj where ${filters.departmentId}::uuid is null or sj.department_id = ${filters.departmentId}::uuid)` : sql`null::uuid[]`} as any_job_ids,
          (select json_agg(json_build_object('id', o.id, 'jobNumber', o.job_number, 'title', o.title, 'companyId', o.company_id) order by o.rn)
            from (select sj.*, row_number() over (order by sj.created_at desc, sj.job_number desc) as rn from sj) o where o.rn <= ${REPORT_JOB_OPTION_LIMIT + 1}) as options,
          (select json_agg(json_build_object('id', d.id, 'name', d.name) order by d.name, d.id)
            from (select distinct d.id, d.name from sj join department d on d.id = sj.department_id and d.tenant_id = ${s.tenantId}::uuid) d) as departments,
          (select sj.company_id from sj where sj.id = ${jobId}::uuid) as job_company`);
      let jobIds: string[] = js?.ids ?? [];
      let effectiveJob = jobId;
      if (jobId && !js?.job_company) {
        if (!opts.fallback) throw new RecruitmentError('not_found');
        refused = refused ?? 'not_found';
        effectiveJob = null;
        jobIds = js?.any_job_ids ?? [];
      }
      const options = js?.options ?? [];
      const adminIds = new Set(chosen.filter((c) => c.admin).map((c) => c.id));
      const adminScope = chosen.every((c) => c.admin);
      const scope: ReportScope = {
        kind, companies: allowed, companyId, jobId: effectiveJob, departmentId: filters.departmentId,
        period: filters.period, granularity: granularity(filters.period),
        jobs: options.slice(0, REPORT_JOB_OPTION_LIMIT), jobsTruncated: options.length > REPORT_JOB_OPTION_LIMIT,
        departments: js?.departments ?? [],
        adminScope,
        requisitionsVisible: effectiveJob ? adminIds.has(js!.job_company!) : adminScope,
        teamAvailable: companyRows.some((r) => r.admin),
        refused,
        snapshot: { readOnly: snap?.read_only === 'on', isolation: snap?.isolation ?? '', statementTimeoutMs: Number(snap?.timeout_ms ?? 0), statements: 0 },
      };
      known = scope;
      const { fromTs, toTs } = periodInstants(filters.period);
      const result = await body({ tx, s, now, scope, selected, jobIds: uuidArray(jobIds), fromTs, toTs, q });
      scope.snapshot.statements = statements;
      return { ...result, scope };
    }, { readOnlySnapshot: true });
  } catch (e) {
    throw toReportError(e, known);
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────────────────────────────────

export type OverviewJobRow = { id: string; jobNumber: string; title: string; applications: number; interviewed: number; offers: number; hired: number; vacancies: number | null };
export type OverviewReport = {
  applications: number; offersCreated: number; offersSent: number; hired: number; onboardingNow: number;
  /** Null when hidden: unless every covered company (or the filtered job's company) is administered by the viewer. */
  requisitions: { count: number; vacancies: number; filled: number; completionRate: number | null } | null;
  trend: (Bucket & { count: number })[];
  byStage: { name: string; count: number }[];
  bySource: { source: CandidateSource | 'unknown'; count: number }[];
  jobs: OverviewJobRow[]; jobsTotal: number;
  scope: ReportScope;
};

export async function recruitmentOverviewReport(s: SessionContext, scopeIds: readonly string[], input: ReportFilterInput = {}, opts: ReportOptions = {}): Promise<OverviewReport> {
  return runReport(s, scopeIds, input, 'overview', opts, async (c) => {
    const t = c.s.tenantId;
    const g = c.scope.granularity;
    // One pass over the period's applications: the totals, the trend buckets and the sources, as grouping sets.
    // grouping(bucket, source): 3 = the totals row, 1 = a bucket row, 2 = a source row.
    const sets = await c.q<{ g: number; bucket: string | null; source: string | null; n: number; offers: number; sent: number; hired: number }>(sql`
      with ca as materialized (${cohort(c)}),
      r as (select to_char(date_trunc(${g}::text, ca.applied_at at time zone ${HR_LOCAL_TZ}), 'YYYY-MM-DD') as bucket,
          coalesce(cd.source, 'unknown') as source, ca.state, o.id as offer_id, o.sent_at
        from ca left join recruitment_offer o on o.application_id = ca.id left join recruitment_candidate cd on cd.id = ca.candidate_id)
      select grouping(bucket, source)::int as g, bucket, source, count(*)::int as n, count(offer_id)::int as offers, count(sent_at)::int as sent,
        count(*) filter (where state = 'hired')::int as hired
      from r group by grouping sets ((), (bucket), (source))`);
    // The present state: active applications by stage name, and those at the Onboarding system stage.
    const byStage = await c.q<{ name: string; n: number; onboarding: number }>(sql`
      select st.name, count(*)::int as n, count(*) filter (where st.system_key = 'onboarding')::int as onboarding
      from recruitment_application a join recruitment_job_opening j on j.id = a.job_id join recruitment_stage st on st.id = a.current_stage_id
        left join recruitment_process_stage ps on ps.process_id = j.process_id and ps.stage_id = st.id
      where a.tenant_id = ${t}::uuid and a.company_id = any(${c.selected}::uuid[]) and a.job_id = any(${c.jobIds}::uuid[]) and a.state = 'active'
      group by st.name order by min(ps.position) nulls last, st.name`);
    let requisitions: OverviewReport['requisitions'] = null;
    if (c.scope.requisitionsVisible) {
      const p = c.scope.period;
      const [r] = await c.q<{ n: number; vacancies: number; filled: number }>(sql`
        select count(*)::int as n, coalesce(sum(r.vacancies), 0)::int as vacancies, coalesce(sum(least(f.onboarded, r.vacancies)), 0)::int as filled
        from recruitment_requisition r
        cross join lateral (select count(distinct a.id)::int as onboarded from recruitment_requisition_job rj
          join recruitment_application a on a.job_id = rj.job_id and a.state = 'hired' where rj.requisition_id = r.id) f
        where r.tenant_id = ${t}::uuid and r.company_id = any(${c.selected}::uuid[]) and r.status <> 'draft'
          and coalesce(r.date_opened, (r.created_at at time zone ${HR_LOCAL_TZ})::date) between ${p.from}::date and ${p.to}::date
          and (${c.scope.departmentId}::uuid is null or r.department_id = ${c.scope.departmentId}::uuid)
          and (${c.scope.jobId}::uuid is null or exists (select 1 from recruitment_requisition_job rj where rj.requisition_id = r.id and rj.job_id = ${c.scope.jobId}::uuid))`);
      requisitions = { count: r?.n ?? 0, vacancies: r?.vacancies ?? 0, filled: r?.filled ?? 0, completionRate: rate(r?.filled ?? 0, r?.vacancies ?? 0) };
    }
    // Per job: the 100 with the most applications, and their linked vacancies (row security hides another company's).
    const jobs = await c.q<{ id: string; job_number: string; title: string; applications: number; interviewed: number; offers: number; hired: number; total: number; vacancies: number | null }>(sql`
      with ca as materialized (${cohort(c)}),
      g as (select ca.job_id, count(*)::int as applications,
          count(*) filter (where exists (select 1 from recruitment_interview i where i.application_id = ca.id and ${held(c, sql`i`)}))::int as interviewed,
          count(o.id)::int as offers, count(*) filter (where ca.state = 'hired')::int as hired
        from ca left join recruitment_offer o on o.application_id = ca.id group by ca.job_id),
      top as (select j.id, j.job_number, j.title, g.applications, g.interviewed, g.offers, g.hired, (count(*) over ())::int as total
        from g join recruitment_job_opening j on j.id = g.job_id order by g.applications desc, j.job_number limit ${REPORT_JOB_LIMIT})
      select top.*, (select sum(r.vacancies)::int from recruitment_requisition_job rj join recruitment_requisition r on r.id = rj.requisition_id
          where rj.job_id = top.id and r.status <> 'draft') as vacancies
      from top order by top.applications desc, top.job_number`);
    const totals = sets.find((r) => r.g === 3);
    const sources = new Set<string>(CANDIDATE_SOURCES);
    return {
      applications: totals?.n ?? 0, offersCreated: totals?.offers ?? 0, offersSent: totals?.sent ?? 0, hired: totals?.hired ?? 0,
      onboardingNow: byStage.reduce((n, r) => n + r.onboarding, 0), requisitions,
      trend: fillBuckets(c.scope.period, new Map(sets.filter((r) => r.g === 1).map((r) => [r.bucket!, r.n])), g),
      byStage: byStage.map((r) => ({ name: r.name, count: r.n })),
      bySource: sets.filter((r) => r.g === 2).sort((a, b) => b.n - a.n || a.source!.localeCompare(b.source!))
        .map((r) => ({ source: (sources.has(r.source!) ? r.source : 'unknown') as CandidateSource | 'unknown', count: r.n })),
      jobs: jobs.map((j) => ({ id: j.id, jobNumber: j.job_number, title: j.title, applications: j.applications, interviewed: j.interviewed, offers: j.offers, hired: j.hired, vacancies: j.vacancies ?? null })),
      jobsTotal: jobs[0]?.total ?? 0,
    };
  });
}

// ── Positions ─────────────────────────────────────────────────────────────────────────────────────────────

export type PositionFigures = {
  applications: number; interviewed: number; offersCreated: number; offersSent: number; accepted: number; declined: number; hired: number; rejected: number;
  /** applications ÷ hired; null ("—") with no hire. */
  applicationsPerHire: number | null;
  /** accepted ÷ (accepted + declined); null ("—") with no decided offer. */
  acceptanceRate: number | null;
  /** Mean whole Kuala Lumpur days from application to hire; null ("—") with no hire. */
  averageDaysToHire: number | null;
};
export type FunnelStep = { stageId: string; name: string; count: number };
export type PositionRow = PositionFigures & { id: string; jobNumber: string; title: string; funnel: FunnelStep[] };
export type PositionsReport = { totals: PositionFigures; jobs: PositionRow[]; jobsTotal: number; scope: ReportScope };

type FigureRow = { applications: number; interviewed: number; offersCreated: number; offersSent: number; accepted: number; declined: number; hired: number; rejected: number; hireDaysSum: number; hireDaysN: number };
const figures = (r: FigureRow | undefined): PositionFigures => {
  const v = r ?? { applications: 0, interviewed: 0, offersCreated: 0, offersSent: 0, accepted: 0, declined: 0, hired: 0, rejected: 0, hireDaysSum: 0, hireDaysN: 0 };
  return {
    applications: v.applications, interviewed: v.interviewed, offersCreated: v.offersCreated, offersSent: v.offersSent, accepted: v.accepted,
    declined: v.declined, hired: v.hired, rejected: v.rejected, applicationsPerHire: rate(v.applications, v.hired),
    acceptanceRate: rate(v.accepted, v.accepted + v.declined), averageDaysToHire: averageDays(v.hireDaysSum, v.hireDaysN),
  };
};

export async function recruitmentPositionsReport(s: SessionContext, scopeIds: readonly string[], input: ReportFilterInput = {}, opts: ReportOptions = {}): Promise<PositionsReport> {
  return runReport(s, scopeIds, input, 'positions', opts, async (c) => {
    // One pass: the totals row and every job's row as grouping sets, then the 100 jobs with the most applications.
    const rows = await c.q<FigureRow & { total_row: number; job_id: string | null; job_number: string | null; title: string | null; total: number }>(sql`
      with ca as materialized (${cohort(c)}),
      f as (select ca.job_id, ca.id, ca.state, ca.applied_at, o.id as offer_id, o.sent_at, o.candidate_decision, h.at as hired_at,
          exists (select 1 from recruitment_interview i where i.application_id = ca.id and ${held(c, sql`i`)}) as interviewed
        from ca left join recruitment_offer o on o.application_id = ca.id
        left join lateral (select min(e.occurred_at) as at from recruitment_application_event e where e.application_id = ca.id and e.kind = 'hired') h on true),
      g as (select grouping(f.job_id)::int as total_row, f.job_id, count(*)::int as applications,
          count(*) filter (where f.interviewed)::int as interviewed, count(f.offer_id)::int as "offersCreated", count(f.sent_at)::int as "offersSent",
          count(*) filter (where f.candidate_decision = 'accepted')::int as accepted, count(*) filter (where f.candidate_decision = 'declined')::int as declined,
          count(*) filter (where f.state = 'hired')::int as hired, count(*) filter (where f.state = 'archived')::int as rejected,
          coalesce(sum((f.hired_at at time zone ${HR_LOCAL_TZ})::date - (f.applied_at at time zone ${HR_LOCAL_TZ})::date) filter (where f.state = 'hired' and f.hired_at is not null), 0)::int as "hireDaysSum",
          count(f.hired_at) filter (where f.state = 'hired')::int as "hireDaysN"
        from f group by grouping sets ((), (f.job_id))),
      ranked as (select g.*, j.job_number, j.title,
          row_number() over (partition by g.total_row order by g.applications desc, j.job_number) as rn, (count(*) over (partition by g.total_row))::int as total
        from g left join recruitment_job_opening j on j.id = g.job_id)
      select * from ranked where total_row = 1 or rn <= ${REPORT_JOB_LIMIT} order by total_row desc, rn`);
    const totals = rows.find((r) => r.total_row === 1);
    const jobs = rows.filter((r) => r.total_row === 0);
    // The funnel of the listed jobs: every stage of each job's process with the applications that ever entered it, from
    // the history (applied and moved rows carry the stage entered).
    const funnel = new Map<string, { stageId: string; name: string; enabled: boolean; count: number }[]>();
    if (jobs.length) {
      const steps = await c.q<{ job_id: string; stage_id: string; name: string; enabled: boolean; n: number }>(sql`
        with ca as materialized (${cohort(c)} and a.job_id = any(${uuidArray(jobs.map((j) => j.job_id!))}::uuid[])),
        reached as (select ca.job_id, e.to_stage_id, count(distinct ca.id)::int as n
          from ca join recruitment_application_event e on e.application_id = ca.id and e.to_stage_id is not null group by 1, 2)
        select j.id as job_id, ps.stage_id, st.name, st.enabled, coalesce(r.n, 0)::int as n
        from recruitment_job_opening j join recruitment_process_stage ps on ps.process_id = j.process_id join recruitment_stage st on st.id = ps.stage_id
          left join reached r on r.job_id = j.id and r.to_stage_id = ps.stage_id
        where j.tenant_id = ${c.s.tenantId}::uuid and j.id = any(${uuidArray(jobs.map((j) => j.job_id!))}::uuid[])
        order by j.id, ps.position`);
      for (const r of steps) {
        const list = funnel.get(r.job_id) ?? [];
        list.push({ stageId: r.stage_id, name: r.name, enabled: r.enabled, count: r.n });
        funnel.set(r.job_id, list);
      }
    }
    return {
      totals: figures(totals),
      jobs: jobs.map((j) => ({
        id: j.job_id!, jobNumber: j.job_number ?? '', title: j.title ?? '', ...figures(j),
        // A disabled stage that nobody reached is left out; one that applications did reach still shows.
        funnel: (funnel.get(j.job_id!) ?? []).filter((st) => st.enabled || st.count > 0).map(({ stageId, name, count }) => ({ stageId, name, count })),
      })),
      jobsTotal: jobs[0]?.total ?? 0,
    };
  });
}

// ── Interviews ────────────────────────────────────────────────────────────────────────────────────────────

export type InterviewsReport = {
  held: number; previousHeld: number; change: { delta: number; rate: number | null }; previousPeriod: ReportPeriod;
  places: number; submitted: number; feedbackRate: number | null; pendingFeedback: number; upcoming: number;
  results: { recommended: number; keepInView: number; notSuitable: number; noResult: number };
  interviewedApplications: number; passed: number; withOutcome: number; passRate: number | null;
  scope: ReportScope;
};

export async function recruitmentInterviewsReport(s: SessionContext, scopeIds: readonly string[], input: ReportFilterInput = {}, opts: ReportOptions = {}): Promise<InterviewsReport> {
  return runReport(s, scopeIds, input, 'interviews', opts, async (c) => {
    const t = c.s.tenantId;
    const prev = previousPeriod(c.scope.period);
    const prevFromTs = periodInstants(prev).fromTs;
    // ONE statement: held interviews of this and the previous period, feedback places, results, upcoming and pass rate.
    const [k] = await c.q<{
      held: number; previousHeld: number; places: number; submitted: number; upcoming: number;
      recommended: number; keepInView: number; notSuitable: number; noResult: number; interviewed: number; passed: number; decided: number;
    }>(sql`
      with iv as materialized (select i.id, i.application_id, i.job_id, i.stage_id, i.starts_at from recruitment_interview i
          where i.tenant_id = ${t}::uuid and i.company_id = any(${c.selected}::uuid[]) and i.job_id = any(${c.jobIds}::uuid[])
            and i.starts_at >= ${prevFromTs}::timestamptz and i.starts_at < ${c.toTs}::timestamptz and ${held(c, sql`i`)}),
      cur as (select * from iv where iv.starts_at >= ${c.fromTs}::timestamptz),
      places as (select exists (select 1 from recruitment_scorecard sc where sc.interview_id = v.interview_id and sc.interviewer_user_id = v.app_user_id) as submitted
        from recruitment_interview_interviewer v join cur on cur.id = v.interview_id),
      -- Each interviewed application's LATEST held interview in the period, and that interview's stage position.
      latest as (select distinct on (cur.application_id) cur.application_id, cur.starts_at, ps.position as pos, j.process_id
        from cur join recruitment_job_opening j on j.id = cur.job_id
          left join recruitment_process_stage ps on ps.process_id = j.process_id and ps.stage_id = cur.stage_id
        order by cur.application_id, cur.starts_at desc),
      -- Passed: hired, or entered a later stage of the process, AT OR AFTER that interview's start (a move made before
      -- the interview, even to a later stage, is not a pass).
      x as (select a.state, exists (select 1 from recruitment_application_event e
            left join recruitment_process_stage p2 on p2.process_id = latest.process_id and p2.stage_id = e.to_stage_id
            where e.application_id = latest.application_id and e.occurred_at >= latest.starts_at and (e.kind = 'hired' or p2.position > latest.pos)) as passed
        from latest join recruitment_application a on a.id = latest.application_id)
      select (select count(*) from cur)::int as held, (select count(*) from iv where iv.starts_at < ${c.fromTs}::timestamptz)::int as "previousHeld",
        (select count(*) from places)::int as places, (select count(*) filter (where submitted) from places)::int as submitted,
        (select count(*) from recruitment_interview i where i.tenant_id = ${t}::uuid and i.company_id = any(${c.selected}::uuid[])
          and i.job_id = any(${c.jobIds}::uuid[]) and i.cancelled_at is null and i.starts_at > ${c.now.toISOString()}::timestamptz)::int as upcoming,
        res.recommended, res."keepInView", res."notSuitable", res."noResult", pass.interviewed, pass.passed, pass.decided
      from (select count(*) filter (where sc.result = 'recommended')::int as recommended, count(*) filter (where sc.result = 'keep_in_view')::int as "keepInView",
              count(*) filter (where sc.result = 'not_suitable')::int as "notSuitable", count(*) filter (where sc.result is null)::int as "noResult"
            from recruitment_scorecard sc join cur on cur.id = sc.interview_id) res,
           (select count(*)::int as interviewed, count(*) filter (where passed)::int as passed, count(*) filter (where passed or state = 'archived')::int as decided from x) pass`);
    const heldNow = k?.held ?? 0;
    const previousHeld = k?.previousHeld ?? 0;
    const places = k?.places ?? 0;
    const submitted = k?.submitted ?? 0;
    return {
      held: heldNow, previousHeld, change: periodChange(heldNow, previousHeld), previousPeriod: prev,
      places, submitted, feedbackRate: rate(submitted, places), pendingFeedback: places - submitted, upcoming: k?.upcoming ?? 0,
      results: { recommended: k?.recommended ?? 0, keepInView: k?.keepInView ?? 0, notSuitable: k?.notSuitable ?? 0, noResult: k?.noResult ?? 0 },
      interviewedApplications: k?.interviewed ?? 0, passed: k?.passed ?? 0, withOutcome: k?.decided ?? 0,
      passRate: rate(k?.passed ?? 0, k?.decided ?? 0),
    };
  });
}

// ── Team (administrators only) ────────────────────────────────────────────────────────────────────────────

export type TeamRow = { recruiterUserId: string | null; recruiterName: string | null; jobs: number; movedFromFirstStage: number; interviewsScheduled: number; offersCreated: number; hires: number };
export type TeamReport = { rows: TeamRow[]; rowsTotal: number; scope: ReportScope };

/**
 * Work done in the period, CREDITED TO EACH JOB'S CURRENT RECRUITER (recruitment_job_member, role recruiter, as it is now):
 * if the recruiter changed during the period, all of the job's work is shown under the present one. "Moved past first
 * stage" counts every move, rejection or hire OUT OF the stage the application started in (its 'applied' history row),
 * once per application. Interviews scheduled = interviews created in the period (cancelled later or not); offers created
 * = offers created in the period; hires = hire events in the period. Counts of work, not a rating of people.
 */
export async function recruitmentTeamReport(s: SessionContext, scopeIds: readonly string[], input: ReportFilterInput = {}, opts: ReportOptions = {}): Promise<TeamReport> {
  return runReport(s, scopeIds, input, 'team', opts, async (c) => {
    const t = c.s.tenantId;
    const rows = await c.q<{ recruiter: string | null; jobs: number; moved: number; interviews: number; offers: number; hires: number; total: number }>(sql`
      with jr as (select j.id as job_id, (select m.app_user_id from recruitment_job_member m where m.job_id = j.id and m.member_role = 'recruiter') as recruiter
          from recruitment_job_opening j where j.tenant_id = ${t}::uuid and j.id = any(${c.jobIds}::uuid[])),
      ev as (select a.job_id, a.id as app, e.kind, e.from_stage_id from recruitment_application_event e
          join recruitment_application a on a.id = e.application_id
        where e.tenant_id = ${t}::uuid and e.company_id = any(${c.selected}::uuid[]) and a.job_id = any(${c.jobIds}::uuid[]) and e.kind <> 'applied'
          and e.occurred_at >= ${c.fromTs}::timestamptz and e.occurred_at < ${c.toTs}::timestamptz),
      work as (
        select ev.job_id,
          count(distinct ev.app) filter (where ev.from_stage_id = (select ap.to_stage_id from recruitment_application_event ap
            where ap.application_id = ev.app and ap.kind = 'applied' order by ap.occurred_at limit 1))::int as moved,
          0::int as interviews, 0::int as offers, count(*) filter (where ev.kind = 'hired')::int as hires
        from ev group by ev.job_id
        union all
        select i.job_id, 0, count(*)::int, 0, 0 from recruitment_interview i
        where i.tenant_id = ${t}::uuid and i.company_id = any(${c.selected}::uuid[]) and i.job_id = any(${c.jobIds}::uuid[])
          and i.created_at >= ${c.fromTs}::timestamptz and i.created_at < ${c.toTs}::timestamptz
        group by i.job_id
        union all
        select o.job_id, 0, 0, count(*)::int, 0 from recruitment_offer o
        where o.tenant_id = ${t}::uuid and o.company_id = any(${c.selected}::uuid[]) and o.job_id = any(${c.jobIds}::uuid[])
          and o.created_at >= ${c.fromTs}::timestamptz and o.created_at < ${c.toTs}::timestamptz
        group by o.job_id),
      per_job as (select jr.job_id, jr.recruiter, coalesce(sum(w.moved), 0)::int as moved, coalesce(sum(w.interviews), 0)::int as interviews,
          coalesce(sum(w.offers), 0)::int as offers, coalesce(sum(w.hires), 0)::int as hires
        from jr left join work w on w.job_id = jr.job_id group by jr.job_id, jr.recruiter)
      select recruiter, count(*)::int as jobs, sum(moved)::int as moved, sum(interviews)::int as interviews, sum(offers)::int as offers, sum(hires)::int as hires,
        (count(*) over ())::int as total
      from per_job group by recruiter
      order by sum(moved) + sum(interviews) + sum(offers) + sum(hires) desc, recruiter nulls last limit ${REPORT_RECRUITER_LIMIT}`);
    // Recruiter names: the company's people labels (4402), only for the users listed.
    const userIds = rows.map((r) => r.recruiter).filter((id): id is string => !!id);
    const names = new Map<string, string>();
    if (userIds.length) {
      const labels = await c.q<{ app_user_id: string; full_name: string }>(sql`
        select l.app_user_id, l.full_name from unnest(${c.selected}::uuid[]) as co(id)
        cross join lateral app.recruitment_people_labels(co.id) l where l.app_user_id = any(${uuidArray(userIds)}::uuid[])`);
      for (const l of labels) names.set(l.app_user_id, l.full_name);
    }
    return {
      rows: rows.map((r) => ({
        recruiterUserId: r.recruiter, recruiterName: r.recruiter ? names.get(r.recruiter) ?? null : null, jobs: r.jobs,
        movedFromFirstStage: r.moved, interviewsScheduled: r.interviews, offersCreated: r.offers, hires: r.hires,
      })),
      rowsTotal: rows[0]?.total ?? 0,
    };
  });
}
