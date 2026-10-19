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
import { isModuleEnabledOrFalse } from './entitlements';

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
    from leave_request r join employment e on e.id = r.employment_id where not r.imported_history`,
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

/** Who acted on each case: (case_id, actor_type, actor_id). Lifecycle keeps its own history table. */
function actions(id: ProcessId): SQL {
  const eventsFor = (aggregate: string) => sql`select c.case_id, ev.actor_type::text as actor_type, ev.actor_id
    from cases c cross join lateral unnest(c.row_ids) as rid(id)
    join domain_event ev on ev.tenant_id = app.current_tenant_id() and ev.aggregate_type = ${aggregate} and ev.aggregate_id = rid.id`;
  switch (id) {
    case 'leave': return eventsFor('leave-request');
    case 'claims': return eventsFor('claim-request');
    case 'attendance_correction': return eventsFor('attendance-correction');
    case 'profile_change': return eventsFor('profile-change');
    case 'onboarding': case 'offboarding': return sql`select c.case_id,
        case when h.actor_user_id is null then 'system' else 'user' end as actor_type, h.actor_user_id as actor_id
      from cases c cross join lateral unnest(c.row_ids) as rid(id)
      join lc_history h on h.tenant_id = app.current_tenant_id() and h.ref_type = 'case' and h.ref_id = rid.id`;
    case 'readiness': return sql`select null::uuid as case_id, null::text as actor_type, null::uuid as actor_id where false`;
  }
}

export type ProcessMeasures = {
  started: number; completed: number; open: number; agedOpen: number; rework: number;
  medianHours: number | null; p90Hours: number | null;
  staffActions: number; employeeActions: number; automatedActions: number;
};

type Row = { started: number; completed: number; open: number; aged_open: number; rework: number;
  p50: number | string | null; p90: number | string | null; staff: number; employee: number; automated: number };

async function measure(tx: Tx, id: ProcessId, from: Date): Promise<ProcessMeasures> {
  const [r] = await tx.execute<Row>(sql`
    with rows as (${ROWS[id]}),
    cases as (
      select case_id, (array_agg(person_id))[1] as person_id, min(created_at) as started_at,
        -- Finished only once nothing in the case is still pending; the last decision closes it.
        case when not bool_or(is_open) then max(decided_at) end as finished_at,
        bool_or(is_open) as is_open, bool_or(is_rework) as is_rework, array_agg(row_id) as row_ids
      from rows group by case_id having min(created_at) >= ${from.toISOString()}::timestamptz),
    acts as (${actions(id)}),
    per_case as (
      select c.*,
        (select count(*) from acts a where a.case_id = c.case_id and a.actor_type = 'user'
           and not exists (select 1 from app_user u where u.id = a.actor_id and u.person_id = c.person_id)) as staff,
        (select count(*) from acts a where a.case_id = c.case_id and a.actor_type = 'user'
           and exists (select 1 from app_user u where u.id = a.actor_id and u.person_id = c.person_id)) as employee,
        (select count(*) from acts a where a.case_id = c.case_id and a.actor_type in ('system','agent')) as automated
      from cases c)
    select count(*)::int as started,
      count(*) filter (where finished_at is not null)::int as completed,
      count(*) filter (where is_open)::int as open,
      count(*) filter (where is_open and started_at < now() - make_interval(days => ${AGED_OPEN_DAYS}::int))::int as aged_open,
      count(*) filter (where is_rework)::int as rework,
      percentile_cont(0.5) within group (order by greatest(0, extract(epoch from finished_at - started_at))) filter (where finished_at is not null) as p50,
      percentile_cont(0.9) within group (order by greatest(0, extract(epoch from finished_at - started_at))) filter (where finished_at is not null) as p90,
      coalesce(sum(staff), 0)::int as staff, coalesce(sum(employee), 0)::int as employee, coalesce(sum(automated), 0)::int as automated
    from per_case`);
  const hours = (v: number | string | null) => v == null ? null : Math.round(Number(v) / 36) / 100;
  return { started: r.started, completed: r.completed, open: r.open, agedOpen: r.aged_open, rework: r.rework,
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

export type ProcessAssessment = {
  id: ProcessId; profile: Profile; enabled: boolean; measures: ProcessMeasures | null;
  role: AgentRole; staffActionsPer30: number | null;
};

export async function assessProcesses(ctx: SessionContext, window: AssessmentWindow = 90) {
  if (!isAdmin(ctx)) throw new Error('Only HR administrators may view the process assessment.');
  return withTenant(ctx, async tx => {
    // Malaysia calendar days, matching every other period in the product.
    const [{ from_ms }] = await tx.execute<{ from_ms: string }>(sql`select (extract(epoch from (date_trunc('day', now() at time zone 'Asia/Kuala_Lumpur')
      - make_interval(days => ${window}::int)) at time zone 'Asia/Kuala_Lumpur') * 1000)::bigint::text as from_ms`);
    const fromDate = new Date(Number(from_ms));
    const processes: ProcessAssessment[] = [];
    for (const id of PROCESS_IDS) {
      const profile = PROCESS_PROFILES[id];
      const enabled = profile.module == null || isModuleEnabledOrFalse(ctx, profile.module);
      const measures = enabled ? await measure(tx, id, fromDate) : null;
      const staffActionsPer30 = measures && profile.actionsLinked ? Math.round(measures.staffActions * 30 / window * 10) / 10 : null;
      processes.push({ id, profile, enabled, measures, role: recommendRole(profile, enabled, measures), staffActionsPer30 });
    }
    // Most staff handling first; unmeasurable and switched-off processes last, in catalogue order.
    processes.sort((a, b) => (b.staffActionsPer30 ?? -1) - (a.staffActionsPer30 ?? -1));
    return { version: ASSESSMENT_VERSION, window, from: fromDate, processes };
  });
}
