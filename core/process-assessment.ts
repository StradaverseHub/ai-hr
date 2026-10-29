/**
 * ADR-0131 Phase 1. A deterministic baseline of how HR processes run today, and which of them an agent
 * could take work off. No model call participates: every figure below is computed by SQL from records the
 * engine already owns, and the fit profiles are a reviewed, versioned table in code.
 *
 * SCOPE IS THE CALLER'S. Every query starts from the RLS-scoped source table (leave_request, claim_request,
 * …) and only then joins events by aggregate id. `domain_event` itself is readable tenant-wide by any admin,
 * so starting from it would hand a company administrator another company's volumes.
 *
 * WHAT THIS IS NOT. Elapsed time is not effort, and work done outside the system (email, phone, sheets) is
 * invisible. Staff minutes are recorded nowhere, so no time or headcount figure is produced unless the
 * administrator supplies the minutes themselves — see `estimateLoad`.
 */
import { sql, type SQL } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { isAdmin } from '../lib/authz-model';
import { isModuleEnabled } from './entitlements';

export const ASSESSMENT_VERSION = 'assessment-v1';
export const ASSESSMENT_WINDOWS = [30, 90, 180, 365] as const;
export type AssessmentWindow = typeof ASSESSMENT_WINDOWS[number];
/** Below this many completed cases a percentile describes a handful of events, not a process. */
export const MIN_COMPLETED = 10;
export const AGED_OPEN_DAYS = 7;

export type ProcessId = 'leave' | 'claims' | 'attendance_correction' | 'profile_change' | 'onboarding' | 'offboarding' | 'readiness';
export type AutonomyTier = 'automatic' | 'confirm' | 'approve';
export type DecisionClass = 'routine' | 'judgement' | 'consequential';
export type AgentRole = 'off' | 'measure_first' | 'assist' | 'automate_parts';

type Profile = {
  module: string | null;
  decision: DecisionClass;
  /** Can the engine itself prove the outcome, without trusting a person's or a model's word? */
  verifiable: boolean;
  /** Are handling actions linked to the case in the records? If not, staff actions cannot be counted. */
  actionsLinked: boolean;
  /** Candidate agent work, each at the highest tier ADR-0131 §2 allows for it. Never the decision itself. */
  actions: readonly { id: string; tier: AutonomyTier }[];
};

/**
 * The reviewed fit table. Changing a row changes the assessment's conclusions, so it moves
 * ASSESSMENT_VERSION. A tier here is a ceiling: Phase 2's registry may only lower it.
 */
export const PROCESS_PROFILES: Record<ProcessId, Profile> = {
  leave: { module: 'leave', decision: 'judgement', verifiable: true, actionsLinked: true, actions: [
    { id: 'chase_overdue_approver', tier: 'automatic' }, { id: 'check_completeness', tier: 'automatic' },
    { id: 'submit_on_request', tier: 'confirm' }] },
  // Money: an agent prepares and chases, a person decides (ADR-0131 §2).
  claims: { module: 'claims', decision: 'consequential', verifiable: true, actionsLinked: true, actions: [
    { id: 'request_missing_evidence', tier: 'automatic' }, { id: 'chase_overdue_approver', tier: 'automatic' },
    { id: 'check_completeness', tier: 'automatic' }] },
  attendance_correction: { module: 'attendance', decision: 'judgement', verifiable: true, actionsLinked: true, actions: [
    { id: 'request_missing_information', tier: 'automatic' }, { id: 'chase_overdue_approver', tier: 'automatic' },
    { id: 'submit_on_request', tier: 'confirm' }] },
  // Bank and identity changes redirect pay; consequential even though each request looks clerical.
  profile_change: { module: null, decision: 'consequential', verifiable: true, actionsLinked: true, actions: [
    { id: 'check_completeness', tier: 'automatic' }, { id: 'chase_overdue_approver', tier: 'automatic' },
    { id: 'prepare_for_approval', tier: 'approve' }] },
  onboarding: { module: 'lifecycle', decision: 'routine', verifiable: true, actionsLinked: true, actions: [
    { id: 'chase_step_owner', tier: 'automatic' }, { id: 'tick_system_verified_steps', tier: 'automatic' },
    { id: 'open_case_from_hire', tier: 'confirm' }] },
  // Offboarding removes system access, which stays a human decision.
  offboarding: { module: 'lifecycle', decision: 'consequential', verifiable: true, actionsLinked: true, actions: [
    { id: 'chase_step_owner', tier: 'automatic' }, { id: 'tick_system_verified_steps', tier: 'automatic' },
    { id: 'open_case_from_resignation', tier: 'confirm' }] },
  // Case transitions are observations (an admin's refresh is not handling work), so actions are unlinked.
  readiness: { module: null, decision: 'routine', verifiable: true, actionsLinked: false, actions: [
    { id: 'request_missing_information', tier: 'automatic' }, { id: 'prepare_for_approval', tier: 'approve' }] },
};

export const PROCESS_IDS = Object.keys(PROCESS_PROFILES) as ProcessId[];

/**
 * One row per source record: (case_id, row_id, person_id, created_at, decided_at, is_open, is_rework).
 * A case may span several rows — a leave submission split per date or into paid/unpaid parts shares one
 * parent_group_id and is ONE case of handling work, not several.
 */
const ROWS: Record<ProcessId, SQL> = {
  leave: sql`select coalesce(r.parent_group_id, r.id) as case_id, r.id as row_id, e.person_id, r.created_at, r.decided_at,
      r.status = 'pending' as is_open, r.status in ('rejected','cancelled') as is_rework
    from leave_request r join employment e on e.id = r.employment_id where not r.imported_history
      -- A partial cancellation (decideLeaveCancellation) re-issues the kept dates as NEW rows under a fresh
      -- parent_group_id while copying the ORIGINAL decided_at. Such a row was decided before it existed: it
      -- is a bookkeeping copy of already-handled work, not a new case, and counting it would invent a case
      -- with a negative duration.
      and not (r.decided_at is not null and r.decided_at < r.created_at)`,
  claims: sql`select r.id as case_id, r.id as row_id, e.person_id, r.created_at, r.decided_at,
      r.status = 'pending' as is_open, r.status in ('rejected','cancelled') as is_rework
    from claim_request r join employment e on e.id = r.employment_id where r.status <> 'draft'`,
  attendance_correction: sql`select r.id as case_id, r.id as row_id, e.person_id, coalesce(r.applied_at, r.created_at) as created_at,
      r.decided_at, r.status = 'pending' as is_open, r.status in ('rejected','cancelled') as is_rework
    from attendance_correction r join employment e on e.id = r.employment_id`,
  profile_change: sql`select r.id as case_id, r.id as row_id, r.person_id, r.created_at, r.decided_at,
      r.status = 'pending' as is_open, r.status = 'rejected' as is_rework
    from profile_change_request r`,
  onboarding: sql`select c.id as case_id, c.id as row_id, c.person_id, c.created_at, c.completed_at as decided_at,
      c.status = 'in_progress' as is_open, c.status = 'cancelled' as is_rework
    from lc_case c where c.kind = 'onboarding'`,
  offboarding: sql`select c.id as case_id, c.id as row_id, c.person_id, c.created_at, c.completed_at as decided_at,
      c.status = 'in_progress' as is_open, c.status = 'cancelled' as is_rework
    from lc_case c where c.kind = 'offboarding'`,
  readiness: sql`select c.id as case_id, c.id as row_id, e.person_id, c.opened_at as created_at,
      case when c.state = 'verified' then c.verified_at end as decided_at,
      c.state in ('needs_input','needs_review') as is_open, c.reopen_count > 0 as is_rework
    from hr_orchestration_case c join employment e on e.id = c.employment_id`,
};

/**
 * Who acted on each case: (person_id, actor_type, actor_id), where person_id is the case's employee.
 * Events are fetched by `aggregate_id = any(<the case ids>)` so the lookup uses the aggregate index and the
 * event table's RLS functions run only on matching rows. Joining per case instead made the planner scan
 * every leave event once per case — 500 cases with 1,000 events did not finish in 300 s.
 */
function actions(id: ProcessId): SQL {
  const eventsFor = (aggregate: string) => sql`select i.person_id, ev.actor_type::text as actor_type, ev.actor_id
    from domain_event ev join ids i on i.agg_id = ev.aggregate_id
    where ev.tenant_id = app.current_tenant_id() and ev.aggregate_type = ${aggregate}
      and ev.aggregate_id = any(array(select agg_id from ids))`;
  switch (id) {
    case 'leave': return eventsFor('leave-request');
    case 'claims': return eventsFor('claim-request');
    case 'attendance_correction': return eventsFor('attendance-correction');
    case 'profile_change': return eventsFor('profile-change');
    case 'onboarding': case 'offboarding': return sql`select i.person_id,
        case when h.actor_user_id is null then 'system' else 'user' end as actor_type, h.actor_user_id as actor_id
      from lc_history h join ids i on i.agg_id = h.ref_id
      where h.tenant_id = app.current_tenant_id() and h.ref_type = 'case' and h.ref_id = any(array(select agg_id from ids))`;
    case 'readiness': return sql`select null::uuid as person_id, null::text as actor_type, null::uuid as actor_id where false`;
  }
}

export type ProcessMeasures = {
  started: number; completed: number; open: number; agedOpen: number; rework: number;
  /** Withdrawn or cancelled before any decision: neither completed nor open, so started = completed + open + this. */
  closedUndecided: number;
  medianHours: number | null; p90Hours: number | null;
  staffActions: number; employeeActions: number; automatedActions: number;
};

type Row = { started: number; completed: number; open: number; aged_open: number; rework: number;
  p50: number | string | null; p90: number | string | null; staff: number; employee: number; automated: number };

/** Cases started in [from, to); `to` omitted means up to now. Exported for the ADR-0151 §4.6c before/after. */
export async function measure(tx: Tx, id: ProcessId, from: Date, to?: Date): Promise<ProcessMeasures> {
  const [r] = await tx.execute<Row>(sql`
    with rows as (${ROWS[id]}),
    cases as (
      select case_id, (array_agg(person_id))[1] as person_id, min(created_at) as started_at,
        -- Finished only once nothing in the case is still pending; the last decision closes it.
        case when not bool_or(is_open) then max(decided_at) end as finished_at,
        bool_or(is_open) as is_open, bool_or(is_rework) as is_rework, array_agg(row_id) as row_ids
      from rows group by case_id having min(created_at) >= ${from.toISOString()}::timestamptz
        and (${to?.toISOString() ?? null}::timestamptz is null or min(created_at) < ${to?.toISOString() ?? null}::timestamptz)),
    -- Every id an action may be recorded against: each row, and the case's group id (an emergency
    -- submission is recorded on the group, not on either row).
    ids as (select distinct c.person_id, x.id as agg_id from cases c cross join lateral unnest(c.row_ids || c.case_id) as x(id)),
    acts as (${actions(id)}),
    -- A login belongs to the employee when it is linked to the same person; every other user action is staff.
    act_totals as (
      select count(*) filter (where a.actor_type = 'user' and (a.person_id is null or u.person_id is distinct from a.person_id))::int as staff,
        count(*) filter (where a.actor_type = 'user' and a.person_id is not null and u.person_id = a.person_id)::int as employee,
        count(*) filter (where a.actor_type in ('system','agent'))::int as automated
      from acts a left join app_user u on u.id = a.actor_id),
    case_totals as (
      select count(*)::int as started,
        count(*) filter (where finished_at is not null)::int as completed,
        count(*) filter (where is_open)::int as open,
        count(*) filter (where is_open and started_at < now() - make_interval(days => ${AGED_OPEN_DAYS}::int))::int as aged_open,
        count(*) filter (where is_rework)::int as rework,
        -- Negative durations are excluded rather than clamped: a clamp would show bad data as a fast case.
        percentile_cont(0.5) within group (order by extract(epoch from finished_at - started_at)) filter (where finished_at >= started_at) as p50,
        percentile_cont(0.9) within group (order by extract(epoch from finished_at - started_at)) filter (where finished_at >= started_at) as p90
      from cases)
    select * from case_totals cross join act_totals`);
  const hours = (v: number | string | null) => v == null ? null : Math.round(Number(v) / 36) / 100;
  return { started: r.started, completed: r.completed, open: r.open, agedOpen: r.aged_open, rework: r.rework,
    closedUndecided: r.started - r.completed - r.open,
    medianHours: hours(r.p50), p90Hours: hours(r.p90),
    staffActions: r.staff, employeeActions: r.employee, automatedActions: r.automated };
}

export function recommendRole(profile: Profile, enabled: boolean, m: ProcessMeasures | null): AgentRole {
  if (!enabled || !m) return 'off';
  if (m.completed < MIN_COMPLETED) return 'measure_first';
  if (profile.decision === 'consequential') return 'assist';
  return 'automate_parts';
}

export function parseWindow(value: unknown): AssessmentWindow {
  const n = Number(value);
  return (ASSESSMENT_WINDOWS as readonly number[]).includes(n) ? n as AssessmentWindow : 90;
}

/** Whole number in [min,max], or null for blank/invalid. Invalid input never becomes a default figure. */
export function parseBoundedInt(value: unknown, min: number, max: number): number | null {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/**
 * The only route to a time figure: the administrator's own minutes per staff action and hours per
 * full-time month. Not stored; labelled as an estimate from those inputs wherever it is shown.
 */
export function estimateLoad(staffActionsPer30: number, minutesPerAction: number | null, hoursPerFte: number | null) {
  if (minutesPerAction == null) return null;
  const hours = Math.round(staffActionsPer30 * minutesPerAction / 6) / 10;
  return { hours, fte: hoursPerFte == null ? null : Math.round(hours / hoursPerFte * 100) / 100 };
}

/** Start of the window in Malaysia calendar days, matching every other period in the product. */
export async function windowStart(tx: Tx, window: AssessmentWindow): Promise<Date> {
  const [{ from_ms }] = await tx.execute<{ from_ms: string }>(sql`select (extract(epoch from (date_trunc('day', now() at time zone 'Asia/Kuala_Lumpur')
    - make_interval(days => ${window}::int)) at time zone 'Asia/Kuala_Lumpur') * 1000)::bigint::text as from_ms`);
  return new Date(Number(from_ms));
}

export type ProcessAssessment = {
  id: ProcessId; profile: Profile; enabled: boolean; measures: ProcessMeasures | null;
  role: AgentRole; staffActionsPer30: number | null;
};

export async function assessProcesses(ctx: SessionContext, window: AssessmentWindow = 90) {
  if (!isAdmin(ctx)) throw new Error('Only HR administrators may view the process assessment.');
  return withTenant(ctx, async tx => {
    const fromDate = await windowStart(tx, window);
    const processes: ProcessAssessment[] = [];
    for (const id of PROCESS_IDS) {
      const profile = PROCESS_PROFILES[id];
      const enabled = profile.module == null || isModuleEnabled(ctx, profile.module);
      const measures = enabled ? await measure(tx, id, fromDate) : null;
      const staffActionsPer30 = measures && profile.actionsLinked ? Math.round(measures.staffActions * 30 / window * 10) / 10 : null;
      processes.push({ id, profile, enabled, measures, role: recommendRole(profile, enabled, measures), staffActionsPer30 });
    }
    // Most staff handling first; unmeasurable and switched-off processes last, in catalogue order.
    processes.sort((a, b) => (b.staffActionsPer30 ?? -1) - (a.staffActionsPer30 ?? -1));
    return { version: ASSESSMENT_VERSION, window, from: fromDate, processes };
  });
}
