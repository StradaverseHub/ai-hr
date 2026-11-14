/**
 * Recruitment slice 17 — applications left unprocessed (docs/recruitment-reconstruction/specification.md "Slice 17", D-057).
 * Reached from outside the pack ONLY through ./service.
 *
 * Settings › Waiting limits: the company's administrators set, per enabled stage, a reminder after N days and optionally "suggest
 * archiving" after M days, in calendar or working days (5218 row security: administrators write; the company's job teams read). The
 * board, the application page and the Overview read the rules through ./waiting-store; waiting time is computed when read, never
 * stored. The "Suggested to archive" list of a job is for its operators and administrators: they tick applications and archive them
 * with an archive reason in ONE action through the normal reject path (./data archiveApplicationsTx). Nothing is ever archived
 * without that action (D-057). An application under a blocked-list hold ("Needs an administrator's review", slice 13) is never
 * archived from this list: the administrator's review decides it first. Read paths write nothing. Events carry ids and numbers only.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { companyHolidayDatesByCompany } from '../../core/holidays';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, type JobStatus, type RecruitmentStageType } from './model';
import { actorId, archiveApplicationsTx, assertCompanyTx, jobLevelTx, userLabelsTx, uuidArray } from './data';
import { cutoffRelation, stageEnteredDayOf, stageEnteredDaySql, waitingContextTx } from './waiting-store';
import { parseRejectionEmailChoice, queueCandidateEmailsTx, type RejectionEmailChoice } from './candidate-email';
import {
  SUGGESTED_LIST_LIMIT, WAITING_SCAN_LIMIT, validateWaitingRule, waitingDays, waitingLevel, type WaitingDayKind, type WaitingRuleInput,
} from './waiting-model';

const iso = (d: Date | string) => new Date(d).toISOString();
const ruleEvent = (tx: Tx, s: SessionContext, stageId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-stage-waiting-rule', aggregateId: stageId, eventType, actor: actorOf(s), payload });

const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  }
  return undefined;
};
/** A database refusal of a rule write, as the service's code (never SQL or a bound value). */
const asError = (e: unknown): never => {
  const named = constraintOf(e) ?? '';
  const code = pgSqlState(e);
  if (named === 'recruitment_stage_waiting_rule_stage') throw new RecruitmentError('stage_unavailable');
  if (code === '23514' && named.startsWith('recruitment_stage_waiting_rule')) throw new RecruitmentError('invalid_input', ['remindDays', 'archiveDays']);
  if (code === '42501') throw new RecruitmentError('forbidden');
  throw e;
};

/** The company's rule-writer lock (a transaction-scoped advisory lock; reads never take it). */
const rulesLockTx = (tx: Tx, s: SessionContext, companyId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`recruitment-waiting-rules:${s.tenantId}:${companyId}`}, 0))`);

// ── Settings › Waiting limits ────────────────────────────────────────────────────────────────────────────────

export type WaitingRuleRow = {
  stageId: string; stageName: string; stageType: RecruitmentStageType; stageEnabled: boolean;
  rule: { remindDays: number; archiveDays: number | null; dayKind: WaitingDayKind; updatedBy: string | null; updatedAt: string } | null;
};
export type WaitingRuleSettings = {
  companyId: string;
  /** Enabled stages (with or without a rule), then disabled stages that still have one, in process order. */
  stages: WaitingRuleRow[];
  /** The company's public holidays this Kuala Lumpur year from the holiday calendar (0: working days skip weekends only). */
  holidaysThisYear: number;
  year: string;
};

/** Settings › Waiting limits for one company. Administrators only. Read-only. */
export async function waitingRuleSettings(s: SessionContext, companyId: string): Promise<WaitingRuleSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const rows = await tx.execute<{
      id: string; name: string; stage_type: RecruitmentStageType; enabled: boolean; remind_days: number | null; archive_days: number | null;
      day_kind: WaitingDayKind | null; updated_by_user_id: string | null; updated_at: string | Date | null;
    }>(sql`
      select st.id, st.name, st.stage_type, st.enabled, r.remind_days, r.archive_days, r.day_kind, r.updated_by_user_id, r.updated_at
      from recruitment_stage st
      left join recruitment_stage_waiting_rule r on r.stage_id = st.id
      left join lateral (select min(ps.position) as position from recruitment_process_stage ps where ps.stage_id = st.id) p on true
      where st.tenant_id = ${s.tenantId}::uuid and st.company_id = ${companyId}::uuid and (st.enabled or r.id is not null)
      order by p.position nulls last, st.name, st.id`);
    const labels = rows.some((r) => r.updated_by_user_id) ? await userLabelsTx(tx, companyId) : new Map();
    const today = todayInKualaLumpur();
    const year = today.slice(0, 4);
    const holidays = await companyHolidayDatesByCompany(tx, { companyIds: [companyId], startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    return {
      companyId, year, holidaysThisYear: holidays.get(companyId)?.size ?? 0,
      stages: rows.map((r) => ({
        stageId: r.id, stageName: r.name, stageType: r.stage_type, stageEnabled: r.enabled,
        rule: r.remind_days == null ? null : {
          remindDays: r.remind_days, archiveDays: r.archive_days, dayKind: r.day_kind!, updatedBy: r.updated_by_user_id ? labels.get(r.updated_by_user_id)?.name ?? null : null,
          updatedAt: iso(r.updated_at!),
        },
      })),
    };
  });
}

/**
 * Set a stage's waiting limit (create or replace): reminder 1–365 days, optional "suggest archiving" after more days than the
 * reminder and at most 730, calendar or working days. A new rule needs an ENABLED stage of the company. Administrators only (the
 * service asks first; 5218 row security and CHECKs refuse again).
 */
export async function saveWaitingRule(s: SessionContext, input: WaitingRuleInput & { companyId?: unknown; stageId?: unknown }): Promise<void> {
  const user = actorId(s);
  if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
  if (!isUuid(input.stageId)) throw new RecruitmentError('not_found');
  const v = validateWaitingRule(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const { remindDays, archiveDays, dayKind } = v.value;
  const companyId = input.companyId, stageId = input.stageId;
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    // One writer of the company's rules at a time (saves and deletes), so two first saves of one stage do not race to the unique key
    // and a delete never slips between the check below and the write.
    await rulesLockTx(tx, s, companyId);
    const [stage] = await tx.execute<{ enabled: boolean; has_rule: boolean }>(sql`select st.enabled,
      exists (select 1 from recruitment_stage_waiting_rule r where r.stage_id = st.id) as has_rule
      from recruitment_stage st where st.id = ${stageId}::uuid and st.tenant_id = ${s.tenantId}::uuid and st.company_id = ${companyId}::uuid`);
    if (!stage) throw new RecruitmentError('not_found');
    if (!stage.enabled && !stage.has_rule) throw new RecruitmentError('stage_unavailable');
    // An existing rule is updated in place (its stage may since have been disabled); a new one is inserted (5218: enabled stages only).
    // Every write must change exactly one row; anything else is refused rather than reported as saved.
    const written = stage.has_rule
      ? await tx.execute<{ id: string }>(sql`update recruitment_stage_waiting_rule set remind_days = ${remindDays}, archive_days = ${archiveDays}, day_kind = ${dayKind},
          updated_by_user_id = ${user}::uuid where stage_id = ${stageId}::uuid and company_id = ${companyId}::uuid returning id`).catch(asError)
      : await tx.execute<{ id: string }>(sql`insert into recruitment_stage_waiting_rule (tenant_id, company_id, stage_id, remind_days, archive_days, day_kind,
            created_by_user_id, updated_by_user_id)
          values (${s.tenantId}::uuid, ${companyId}::uuid, ${stageId}::uuid, ${remindDays}, ${archiveDays}, ${dayKind}, ${user}::uuid, ${user}::uuid)
          returning id`).catch(asError);
    if (written.length !== 1) throw new RecruitmentError('not_found');
    await ruleEvent(tx, s, stageId, 'recruitment-stage-waiting-rule.saved', { companyId, remindDays, archiveDays, dayKind });
  });
}

/** Remove a stage's waiting limit (its applications stop being reminded or suggested). Administrators only. */
export async function deleteWaitingRule(s: SessionContext, input: { companyId?: unknown; stageId?: unknown }): Promise<void> {
  actorId(s);
  if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
  if (!isUuid(input.stageId)) throw new RecruitmentError('not_found');
  const companyId = input.companyId, stageId = input.stageId;
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    await rulesLockTx(tx, s, companyId);
    const removed = await tx.execute<{ id: string }>(sql`delete from recruitment_stage_waiting_rule
      where stage_id = ${stageId}::uuid and company_id = ${companyId}::uuid and tenant_id = ${s.tenantId}::uuid returning id`).catch(asError);
    if (!removed.length) throw new RecruitmentError('not_found');
    await ruleEvent(tx, s, stageId, 'recruitment-stage-waiting-rule.deleted', { companyId });
  });
}

// ── The application page ─────────────────────────────────────────────────────────────────────────────────────

export type ApplicationWaiting = {
  days: number; stageName: string; dayKind: WaitingDayKind;
  /** Past the suggest-archiving threshold: for the job's operators and administrators only (null for a hiring manager). */
  suggested: boolean | null;
};
/**
 * How long the ACTIVE application has waited in its current stage, once past its stage's reminder; null otherwise (no rule, not yet
 * past it, not active, or the viewer is not a reviewer of the job — an interviewer). Read-only.
 */
export async function applicationWaiting(s: SessionContext, applicationId: unknown): Promise<ApplicationWaiting | null> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => {
    const [a] = await tx.execute<{ company_id: string; job_id: string; state: string; stage_id: string; stage_name: string; entered_on: string }>(sql`
      select a.company_id, a.job_id, a.state, a.current_stage_id as stage_id, st.name as stage_name, to_char(${stageEnteredDaySql}, 'YYYY-MM-DD') as entered_on
      from recruitment_application a join recruitment_stage st on st.id = a.current_stage_id
      where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
    if (!a) throw new RecruitmentError('not_found');
    if (a.state !== 'active') return null;
    const level = await jobLevelTx(tx, a.company_id, a.job_id);
    if (!level.review) return null;
    const today = todayInKualaLumpur();
    const ctx = await waitingContextTx(tx, s.tenantId, [a.company_id], today);
    const rule = ctx.cutoffs.get(a.stage_id);
    if (!rule) return null;
    const days = waitingDays(a.entered_on, today, rule.dayKind, ctx.holidays.get(a.company_id));
    const lvl = waitingLevel(days, rule);
    if (lvl === 'none') return null;
    return { days, stageName: a.stage_name, dayKind: rule.dayKind, suggested: level.operate ? lvl === 'suggested' : null };
  });
}

// ── "Suggested to archive" ───────────────────────────────────────────────────────────────────────────────────

export type SuggestedRow = {
  applicationId: string; candidateName: string | null; candidateRemoved: boolean; stageName: string; enteredOn: string; days: number;
  /** A blocked-list hold: the administrator's review decides it; it cannot be archived from this list. */
  needsReview: boolean;
};
export type SuggestedArchiveList = {
  job: { id: string; title: string; jobNumber: string; status: JobStatus; companyId: string };
  /** Some stage of the company has a suggest-archiving threshold. */
  hasRules: boolean;
  /** Longest waiting first; at most SUGGESTED_LIST_LIMIT, among the job's WAITING_SCAN_LIMIT oldest received active applications in a
   *  stage with a limit (`truncated` when there are more of either). */
  rows: SuggestedRow[]; truncated: boolean;
  reasons: { id: string; internal: string; external: string }[];
};

async function operatedJobTx(tx: Tx, s: SessionContext, jobId: unknown) {
  if (!isUuid(jobId)) throw new RecruitmentError('not_found');
  const [job] = await tx.execute<{ id: string; title: string; job_number: string; status: JobStatus; company_id: string }>(sql`
    select id, title, job_number, status, company_id from recruitment_job_opening where id = ${jobId}::uuid and tenant_id = ${s.tenantId}::uuid`);
  if (!job) throw new RecruitmentError('not_found');
  if (!(await jobLevelTx(tx, job.company_id, job.id)).operate) throw new RecruitmentError('forbidden');
  return job;
}

/** The job's ACTIVE applications past their stage's suggest-archiving threshold. The job's operators and administrators. Read-only. */
export async function suggestedArchiveList(s: SessionContext, jobId: unknown): Promise<SuggestedArchiveList> {
  return withRecruitmentTenant(s, async (tx) => {
    const job = await operatedJobTx(tx, s, jobId);
    const today = todayInKualaLumpur();
    const ctx = await waitingContextTx(tx, s.tenantId, [job.company_id], today);
    const archiving = [...ctx.cutoffs.values()].filter((c) => c.archiveOn !== null).map((c) => c.stageId);
    const rules = cutoffRelation(ctx, 'wr', archiving);
    const reasons = await tx.execute<{ id: string; internal_reason: string; external_reason: string }>(sql`
      select id, internal_reason, external_reason from recruitment_archive_reason
      where tenant_id = ${s.tenantId}::uuid and company_id = ${job.company_id}::uuid and displayed order by position, internal_reason`);
    // Bounded like the board: the job's active applications in a stage with a suggest-archiving limit, least recently updated first
    // (updated_at is only a sort key that front-loads likely matches; whether one is past the limit comes from the history), at most WAITING_SCAN_LIMIT (+1 to know there are more), are looked up in
    // the history; the list is those past the limit, longest first. How many were scanned comes back even when none qualifies.
    type Row = { id: string; full_name: string; destroyed: boolean; stage_id: string; stage_name: string; entered_on: string; marked: boolean };
    const [result] = rules ? await tx.execute<{ scanned: number; rows: Row[] }>(sql`
      with p as materialized (
        select a.id, a.candidate_id, a.current_stage_id, a.applied_at, a.updated_at, wr.archive_on from recruitment_application a join ${rules} on wr.stage_id = a.current_stage_id
        where a.job_id = ${job.id}::uuid and a.tenant_id = ${s.tenantId}::uuid and a.state = 'active'
          and (a.applied_at at time zone 'Asia/Kuala_Lumpur')::date <= wr.archive_on
        order by a.updated_at, a.id limit ${WAITING_SCAN_LIMIT + 1}
      ), x as materialized (
        select k.id, k.candidate_id, k.current_stage_id as stage_id, k.archive_on, ${stageEnteredDayOf('k')} as entered
        from (select * from p order by p.updated_at, p.id limit ${WAITING_SCAN_LIMIT}) k
      )
      select (select count(*)::int from p) as scanned, coalesce((select json_agg(r order by r.entered_on, r.id) from (
        select x.id, c.full_name, c.destroyed_at is not null as destroyed, x.stage_id, st.name as stage_name, to_char(x.entered, 'YYYY-MM-DD') as entered_on,
          app.recruitment_application_needs_review(x.id) as marked
        from x join recruitment_candidate c on c.id = x.candidate_id join recruitment_stage st on st.id = x.stage_id
        where x.entered <= x.archive_on
        order by x.entered, x.id limit ${SUGGESTED_LIST_LIMIT + 1}) r), '[]'::json) as rows`) : [];
    const rows = result?.rows ?? [];
    return {
      job: { id: job.id, title: job.title, jobNumber: job.job_number, status: job.status, companyId: job.company_id },
      hasRules: archiving.length > 0,
      rows: rows.slice(0, SUGGESTED_LIST_LIMIT).map((r) => {
        const rule = ctx.cutoffs.get(r.stage_id)!;
        return {
          applicationId: r.id, candidateName: r.destroyed ? null : r.full_name, candidateRemoved: r.destroyed, stageName: r.stage_name, enteredOn: r.entered_on,
          days: waitingDays(r.entered_on, today, rule.dayKind, ctx.holidays.get(job.company_id)), needsReview: r.marked,
        };
      }),
      truncated: rows.length > SUGGESTED_LIST_LIMIT || (result?.scanned ?? 0) > WAITING_SCAN_LIMIT,
      reasons: reasons.map((r) => ({ id: r.id, internal: r.internal_reason, external: r.external_reason })),
    };
  });
}

/** Why one selected application was not archived. */
export type SuggestedArchiveRefusal = 'not_found' | 'application_closed' | 'needs_review' | 'not_suggested';
export type SuggestedArchiveResult = {
  archived: string[]; refused: { applicationId: string; code: SuggestedArchiveRefusal }[];
  /** Slice 19, when "Send rejection e-mail" was ticked: e-mails queued, and archived applications skipped with their reason (no usable
   *  address; a link-like name or job title; no preview shown for that row). */
  emailQueued?: number; emailNoAddress?: number; emailValueLink?: number; emailNotPreviewed?: number;
};

/**
 * Archive the selected applications of one job with one archive reason, in ONE action (one transaction) through the normal reject
 * path. Each selected application must still be on the job's suggested list when the action runs (active, in the job, past its
 * stage's suggest-archiving threshold) and not under a blocked-list hold; the others are reported per application and left as
 * they are. The job's operators and administrators only; at most SUGGESTED_LIST_LIMIT at once. A reason that is not one of the
 * company's displayed reasons refuses the whole action.
 */
export async function archiveSuggestedApplications(s: SessionContext, input: { jobId?: unknown; applicationIds?: unknown; archiveReasonId?: unknown; email?: RejectionEmailChoice }): Promise<SuggestedArchiveResult> {
  const email = parseRejectionEmailChoice(input.email);
  actorId(s);
  const asked = Array.isArray(input.applicationIds) ? [...new Set(input.applicationIds)] : [];
  if (!asked.length) throw new RecruitmentError('missing_fields', ['applicationIds']);
  if (asked.length > SUGGESTED_LIST_LIMIT || !asked.every(isUuid)) throw new RecruitmentError('invalid_input', ['applicationIds']);
  return withRecruitmentTenant(s, async (tx) => {
    const job = await operatedJobTx(tx, s, input.jobId);
    if (!isUuid(input.archiveReasonId)) throw new RecruitmentError('reason_required');
    const reasonId = input.archiveReasonId;
    const [reason] = await tx.execute<{ id: string }>(sql`select id from recruitment_archive_reason
      where id = ${reasonId}::uuid and company_id = ${job.company_id}::uuid and tenant_id = ${s.tenantId}::uuid and displayed`);
    if (!reason) throw new RecruitmentError('reason_required');
    // Serialise with the blocked list (5213 takes this company lock exclusively to add an entry or resolve a mark), so a hold added
    // while this runs is either seen below or waits for this action. Then lock the selected applications.
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`recruitment-blocked:${s.tenantId}:${job.company_id}`}, 0))`);
    const locked = await tx.execute<{ id: string; job_id: string; state: string; current_stage_id: string }>(sql`
      select a.id, a.job_id, a.state, a.current_stage_id from recruitment_application a
      where a.id = any(${uuidArray(asked)}::uuid[]) and a.tenant_id = ${s.tenantId}::uuid order by a.id for update of a`);
    const today = todayInKualaLumpur();
    const ctx = await waitingContextTx(tx, s.tenantId, [job.company_id], today);
    const mine = locked.filter((a) => a.job_id === job.id && a.state === 'active').map((a) => a.id);
    const facts = mine.length ? await tx.execute<{ id: string; entered_on: string; marked: boolean }>(sql`
      select a.id, to_char(${stageEnteredDaySql}, 'YYYY-MM-DD') as entered_on, app.recruitment_application_needs_review(a.id) as marked
      from recruitment_application a where a.id = any(${uuidArray(mine)}::uuid[])`) : [];
    const refused: SuggestedArchiveResult['refused'] = [];
    const eligible: { id: string; currentStageId: string }[] = [];
    for (const id of asked) {
      const a = locked.find((x) => x.id === id);
      const f = facts.find((x) => x.id === id);
      const rule = a ? ctx.cutoffs.get(a.current_stage_id) : undefined;
      if (!a || a.job_id !== job.id) refused.push({ applicationId: id, code: 'not_found' });
      else if (a.state !== 'active') refused.push({ applicationId: id, code: 'application_closed' });
      else if (f?.marked) refused.push({ applicationId: id, code: 'needs_review' });
      else if (!f || !rule || rule.archiveOn === null || f.entered_on > rule.archiveOn) refused.push({ applicationId: id, code: 'not_suggested' });
      else eligible.push({ id: a.id, currentStageId: a.current_stage_id });
    }
    await archiveApplicationsTx(tx, s, job.company_id, eligible, reason.id);
    // Slice 19: one rejection e-mail per application actually archived, when the person ticked it (set-based, same transaction).
    const mail = email && eligible.length
      ? await queueCandidateEmailsTx(tx, s, { companyId: job.company_id, kind: 'rejection', applicationIds: eligible.map((e) => e.id), ...email })
      : null;
    return { archived: eligible.map((e) => e.id), refused, ...(mail ? { emailQueued: mail.queued.length, emailNoAddress: mail.noEmail.length,
      emailValueLink: mail.valueLink.length, emailNotPreviewed: mail.notPreviewed.length } : {}) };
  });
}
