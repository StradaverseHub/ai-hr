/**
 * Recruitment slice 24 — AI match summary SUGGESTIONS (owner D-063; this reconstruction's details in D-069). A reviewer of the
 * job asks for a short summary of how an active application's recorded history meets the job's written requirements. The model
 * never ranks, scores, shortlists or rejects; the reply is shown once to the person who asked and is never stored. Each request
 * records who asked, the outcome and the provider request digest (no content).
 *
 * LOCKED: the provider contract `recruitment_match_summary_v1` has no owner approval record, so the gateway refuses every send
 * (AiPrivacyGateError 'unreviewed') until the repository owner records one; this service also refuses before reading anything.
 * The company switch is off by default and only recruitment administrators change it.
 */
import 'server-only';
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { withAiCentreFunction } from '../../core/ai-centre-control';
import { resolveActiveAiConfig } from '../../core/ai-config';
import { preparePrivateAiTask } from '../../core/ai-governance';
import { generateDraft } from '../../lib/ai';
import { draftInputDigest } from '../../lib/ai/draft-input';
import { AiPrivacyGateError } from '../../lib/ai/provider-privacy-error';
import { providerDataReviewStatus } from '../../lib/ai/provider-data-reviews';
import { todayInKualaLumpur } from '../../lib/hr-date';
import {
  MATCH_DESCRIPTION_MAX, MATCH_HISTORY_MAX, MATCH_SKILLS_MAX, MATCH_TITLE_MAX, RECRUITMENT_MATCH_CONTRACT,
  recruitmentMatchSourceIssues, validatedRecruitmentMatchSummary, type RecruitmentMatchSource, type RecruitmentMatchSummary,
} from '../../lib/ai/recruitment-match-policy';
import { RecruitmentError, isUuid } from './model';
import { actorId, assertCompanyTx } from './data';

export type { RecruitmentMatchSummary } from '../../lib/ai/recruitment-match-policy';

/** Whether the owner has approved the provider data for this purpose (the same owner the gateway asks). */
export const matchSummaryApproved = (): boolean => providerDataReviewStatus(RECRUITMENT_MATCH_CONTRACT) === 'approved';

/** Text cut to `max` characters (whitespace collapsed) or null when empty. Minimisation: only the start of long text is sent. */
export function clip(value: string | null | undefined, max: number): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max).trim() : null;
}

/** Whole months from a start month to an end month (inclusive), or null when the start is unknown or after the end. */
export function monthsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const [fy, fm] = from.split('-').map(Number), [ty, tm] = to.split('-').map(Number);
  const months = (ty * 12 + tm) - (fy * 12 + fm) + 1;
  return Number.isSafeInteger(months) && months >= 1 && months <= 1200 ? months : null;
}

async function switchOnTx(tx: Tx, tenantId: string, companyId: string): Promise<boolean> {
  const [row] = await tx.execute<{ on: boolean }>(sql`select ai_match_summary_enabled as on from recruitment_company_setting
    where company_id = ${companyId}::uuid and tenant_id = ${tenantId}::uuid`);
  return row?.on === true;
}

/**
 * The minimised source for one application, read with the caller's own rights, or a refusal. Run first in the recruitment
 * transaction and again by the gateway's admission replay: anything that changed in between refuses the send.
 */
async function matchSourceTx(tx: Tx, s: SessionContext, applicationId: string): Promise<{ companyId: string; source: RecruitmentMatchSource }> {
  const [a] = await tx.execute<{ company_id: string; job_id: string; candidate_id: string; state: string; review: boolean; destroyed: boolean;
    title: string; description: string | null; current_title: string | null; highest_education: RecruitmentMatchSource['candidate']['highestEducation'] }>(sql`
    select a.company_id, a.job_id, a.candidate_id, a.state, app.can_review_recruitment_job(a.company_id, a.job_id) as review,
      c.destroyed_at is not null as destroyed, j.title, j.description, c.current_title, c.highest_education
    from recruitment_application a
    join recruitment_job_opening j on j.id = a.job_id and j.tenant_id = a.tenant_id
    join recruitment_candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
    where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
  if (!a || !a.review || a.destroyed) throw new RecruitmentError('not_found');
  if (a.state !== 'active') throw new RecruitmentError('ai_not_active');
  if (!(await switchOnTx(tx, s.tenantId, a.company_id))) throw new RecruitmentError('ai_off');
  // The newest requisition the job came from (as this reader may see it): its experience, education and skills text only.
  const [r] = await tx.execute<{ years_experience: number | null; education: string | null; mandatory_skills: string | null; preferred_skills: string | null }>(sql`
    select q.years_experience, q.education, q.mandatory_skills, q.preferred_skills
    from recruitment_requisition_job rj join recruitment_requisition q on q.id = rj.requisition_id and q.tenant_id = rj.tenant_id
    where rj.job_id = ${a.job_id}::uuid and rj.tenant_id = ${s.tenantId}::uuid order by rj.created_at desc, rj.id limit 1`);
  const entries = await tx.execute<{ kind: 'work' | 'education'; title: string | null; from_month: string | null; to_month: string | null; is_current: boolean }>(sql`
    select kind, title, to_char(from_month, 'YYYY-MM') as from_month, to_char(to_month, 'YYYY-MM') as to_month, is_current
    from recruitment_candidate_entry where candidate_id = ${a.candidate_id}::uuid and tenant_id = ${s.tenantId}::uuid
    order by kind desc, from_month desc nulls last, id limit ${MATCH_HISTORY_MAX}`);
  const thisMonth = todayInKualaLumpur().slice(0, 7);
  const years = r?.years_experience;
  const source: RecruitmentMatchSource = {
    version: 1,
    job: {
      title: clip(a.title, MATCH_TITLE_MAX) ?? '-',
      description: clip(a.description, MATCH_DESCRIPTION_MAX),
      yearsExperience: typeof years === 'number' && Number.isSafeInteger(years) && years >= 0 && years <= 60 ? years : null,
      education: clip(r?.education, MATCH_TITLE_MAX),
      mandatorySkills: clip(r?.mandatory_skills, MATCH_SKILLS_MAX),
      preferredSkills: clip(r?.preferred_skills, MATCH_SKILLS_MAX),
    },
    candidate: {
      currentTitle: clip(a.current_title, MATCH_TITLE_MAX),
      highestEducation: a.highest_education ?? null,
      history: entries.map((e) => ({
        kind: e.kind, title: clip(e.title, MATCH_TITLE_MAX), current: e.is_current,
        months: monthsBetween(e.from_month, e.is_current ? thisMonth : e.to_month),
      })),
    },
  };
  const issues = recruitmentMatchSourceIssues(source);
  if (issues.length) throw new RecruitmentError('ai_identifier', issues);
  return { companyId: a.company_id, source };
}

async function recordTx(tx: Tx, s: SessionContext, applicationId: string, companyId: string, payload: Record<string, unknown>): Promise<void> {
  await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: applicationId,
    eventType: 'recruitment-application.ai-match-summary', actor: actorOf(s), payload: { companyId, contractId: RECRUITMENT_MATCH_CONTRACT, ...payload } });
}

async function recordOutcome(s: SessionContext, applicationId: string, companyId: string, payload: Record<string, unknown>): Promise<void> {
  await withRecruitmentTenant(s, (tx) => recordTx(tx, s, applicationId, companyId, payload));
}

/**
 * Ask for a match summary suggestion for one active application. Refused (in this order) while the owner has not approved the
 * provider data (ai_not_approved), for anyone who is not a reviewer of the job (not_found), for a closed application, while
 * the company's switch is off, when sent text holds an identifier (ai_identifier, naming the fields), when no provider is
 * configured or the gateway refuses (ai_unavailable), and when the reply is not exactly the closed shape (ai_invalid).
 */
export async function suggestMatchSummary(s: SessionContext, applicationId: unknown): Promise<RecruitmentMatchSummary> {
  return withAiCentreFunction(s, 'read:operation_recruitment_match_summary', () => suggestMatchSummaryActivity(s, applicationId));
}

async function suggestMatchSummaryActivity(s: SessionContext, applicationId: unknown): Promise<RecruitmentMatchSummary> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  if (!matchSummaryApproved()) throw new RecruitmentError('ai_not_approved');
  const before = await withRecruitmentTenant(s, async (tx) => {
    const read = await matchSourceTx(tx, s, applicationId);
    const configuration = await resolveActiveAiConfig(tx, s, 'report_insight');
    return { ...read, configuration };
  });
  if (!before.configuration) {
    await recordOutcome(s, applicationId, before.companyId, { outcome: 'provider-unavailable' });
    throw new RecruitmentError('ai_unavailable');
  }
  const configuration = before.configuration;
  let task: Awaited<ReturnType<typeof preparePrivateAiTask>> | undefined;
  let summary: RecruitmentMatchSummary | null = null;
  let promptDigest: string | null = null;
  try {
    task = await preparePrivateAiTask(configuration, RECRUITMENT_MATCH_CONTRACT, async (tx) => (await matchSourceTx(tx, s, applicationId)).source);
    if (task.operation !== 'draft') throw new RecruitmentError('ai_unavailable');
    promptDigest = draftInputDigest(task.args);
    summary = validatedRecruitmentMatchSummary(await generateDraft(task.configuration, task.args));
  } catch (error) {
    const outcome = error instanceof AiPrivacyGateError && error.reason === 'unreviewed' ? 'not-approved' : 'refused';
    await recordOutcome(s, applicationId, before.companyId, { outcome, promptDigest });
    if (error instanceof RecruitmentError) throw error;
    throw new RecruitmentError(outcome === 'not-approved' ? 'ai_not_approved' : 'ai_unavailable');
  } finally {
    task?.dispose();
  }
  await recordOutcome(s, applicationId, before.companyId, {
    outcome: summary ? 'shown' : 'invalid-reply', provider: configuration.provider, model: configuration.model, promptDigest,
  });
  if (!summary) throw new RecruitmentError('ai_invalid');
  return summary;
}

// ── Settings › AI match summaries (recruitment administrators) ─────────────────────────────────────────────

export type MatchSummarySetting = { companyId: string; on: boolean; approved: boolean };

/** The company's switch and whether the owner approval exists. Administrators only. */
export async function matchSummarySetting(s: SessionContext, companyId: string): Promise<MatchSummarySetting> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    return { companyId, on: await switchOnTx(tx, s.tenantId, companyId), approved: matchSummaryApproved() };
  });
}

/** Whether a reviewer of this application is offered the button (switch on and approval recorded). Never throws for readers. */
export async function matchSummaryOffered(s: SessionContext, applicationId: string): Promise<boolean> {
  if (!isUuid(applicationId) || !matchSummaryApproved()) return false;
  return withRecruitmentTenant(s, async (tx) => {
    const [a] = await tx.execute<{ on: boolean }>(sql`
      select coalesce(cs.ai_match_summary_enabled, false) and a.state = 'active' and app.can_review_recruitment_job(a.company_id, a.job_id) as on
      from recruitment_application a
      left join recruitment_company_setting cs on cs.company_id = a.company_id and cs.tenant_id = a.tenant_id
      where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
    return a?.on === true;
  });
}

/** Turn AI match summaries on or off for the company (default off). Administrators only; audited. */
export async function updateMatchSummarySetting(s: SessionContext, companyId: unknown, enabled: unknown): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const user = actorId(s);
  const on = enabled === true || enabled === 'on' || enabled === 'true';
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const before = await switchOnTx(tx, s.tenantId, companyId);
    await tx.execute(sql`insert into recruitment_company_setting (company_id, tenant_id, created_by_user_id, updated_by_user_id)
      values (${companyId}::uuid, ${s.tenantId}::uuid, ${user}::uuid, ${user}::uuid) on conflict do nothing`);
    await tx.execute(sql`update recruitment_company_setting set ai_match_summary_enabled = ${on}, updated_at = now(), updated_by_user_id = ${user}::uuid
      where company_id = ${companyId}::uuid`);
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId,
      eventType: 'recruitment-setting.ai-match-summary-updated', actor: actorOf(s), payload: { companyId, before: { on: before }, after: { on } } });
  });
}
