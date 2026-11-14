/**
 * Recruitment slice 7 — employee referrals. Reached from outside the pack ONLY through ./service.
 *
 * Two audiences:
 *   - the REFERRER (any signed-in person with an active employment in a company with Recruitment): the portal, the refer
 *     form and My referrals. They hold no grant or policy on any recruitment table; every call goes through a 5707
 *     SECURITY DEFINER function (app.recruitment_referral_portal / _submit_referral / _my_referrals / _referral_eligible)
 *     that checks the caller's own employment and returns only what the spec allows. The gate is the HR one
 *     (withRecruitmentTenant, a tenant-wide grant), so a referral only lands where HR can see, switch off and remove it.
 *   - HR (withRecruitmentTenant): the job's "Show on the referral portal" setting and the company's protection period
 *     (recruitment administrators only), and the referral shown on an application to its readers.
 * Every refusal of a referral reaches the referrer as one code (referral_refused, D-023); the database records the
 * specific reason in its audit event. Nothing here calls a model or calculates a reward (D-021).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { SessionContext } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { resolveDocumentUpload } from '../../core/employee-documents';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, type JobEmploymentType, type RecruitmentType } from './model';
import { CANDIDATE_FILE_MAX_BYTES, CANDIDATE_FILE_MIME } from './privacy-model';
import {
  REFERRAL_PROTECTION_DEFAULT_DAYS, referralStatus, validateProtectionDays, validateReferralInput, type ReferralFormInput, type ReferralStatus,
} from './referral-model';
import { recruitmentCompanySetting, recruitmentJobOpening } from './schema';
import { actorId, assertCompanyTx, jobTx } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();

// ── The referrer ─────────────────────────────────────────────────────────────────────────────────────────────

/** Does the caller have a company where they may refer (an active employment there, and Recruitment)? The menu question. */
export async function referralEligible(s: SessionContext): Promise<boolean> {
  if (!s.userId) return false;
  return withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.execute<{ ok: boolean }>(sql`select app.recruitment_referral_eligible() as ok`);
    return row?.ok === true;
  });
}

export type ReferralPortalJob = {
  jobId: string; companyId: string; companyName: string; title: string; jobNumber: string; workLocation: string;
  employmentType: JobEmploymentType; recruitmentType: RecruitmentType; jobLevels: string[]; description: string | null;
};
type PortalRow = {
  job_id: string; company_id: string; company_name: string; title: string; job_number: string; work_location: string; employment_type: JobEmploymentType;
  recruitment_type: RecruitmentType; job_levels: string[] | null; description: string | null;
};
const portalJob = (r: PortalRow): ReferralPortalJob => ({
  jobId: r.job_id, companyId: r.company_id, companyName: r.company_name, title: r.title, jobNumber: r.job_number, workLocation: r.work_location,
  employmentType: r.employment_type, recruitmentType: r.recruitment_type, jobLevels: r.job_levels ?? [], description: r.description,
});

/**
 * The referral portal: the Open jobs a recruitment administrator put on the portal, in the companies where the caller has
 * an active employment and Recruitment is enabled. Only the portal fields — never salary, the hiring team or counts.
 */
export async function referralPortal(s: SessionContext): Promise<{ eligible: boolean; jobs: ReferralPortalJob[] }> {
  if (!s.userId) return { eligible: false, jobs: [] };
  return withRecruitmentTenant(s, async (tx) => {
    const [eligible] = await tx.execute<{ ok: boolean }>(sql`select app.recruitment_referral_eligible() as ok`);
    if (eligible?.ok !== true) return { eligible: false, jobs: [] };
    const rows = await tx.execute<PortalRow>(sql`select * from app.recruitment_referral_portal(null)`);
    return { eligible: true, jobs: rows.map(portalJob) };
  });
}

/** One job of the caller's portal, or null when it is not (or no longer) on it for them. */
export async function referralPortalJob(s: SessionContext, jobId: unknown): Promise<ReferralPortalJob | null> {
  if (!s.userId || !isUuid(jobId)) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.execute<PortalRow>(sql`select * from app.recruitment_referral_portal(${jobId}::uuid)`);
    return row ? portalJob(row) : null;
  });
}

export type ReferralInput = ReferralFormInput & { jobId?: unknown; file?: { fileName?: unknown; content?: unknown } | null };

/** The optional resume: the same type and size rules as slice 5 (the type is read from the file's own bytes). */
function referralResume(file: ReferralInput['file']): { fileName: string; mimeType: string; content: Buffer } | null {
  if (!file || file.content == null) return null;
  const content = Buffer.isBuffer(file.content) ? file.content : null;
  if (!content) throw new RecruitmentError('file_type');
  if (content.byteLength === 0) return null;
  const fileName = typeof file.fileName === 'string' ? file.fileName.trim().slice(-200) : '';
  if (!fileName) throw new RecruitmentError('file_type');
  if (content.byteLength > CANDIDATE_FILE_MAX_BYTES) throw new RecruitmentError('file_too_large');
  let mimeType: string;
  try {
    ({ mimeType } = resolveDocumentUpload(fileName, content));
  } catch {
    throw new RecruitmentError('file_type');
  }
  if (!(CANDIDATE_FILE_MIME as readonly string[]).includes(mimeType)) throw new RecruitmentError('file_type');
  return { fileName, mimeType, content };
}

/**
 * Refer a candidate to a job on the portal. The form is checked here; everything about WHO may refer WHOM to WHICH job
 * is decided by app.recruitment_submit_referral in one transaction (employment, Recruitment, the job, the daily limit,
 * a similar application, the protection period, and the lock against a concurrent referral of the same person). A
 * refusal commits its audit event (naming the reason, for HR) and reaches the caller as referral_refused only.
 */
export async function submitReferral(s: SessionContext, input: ReferralInput): Promise<{ referralId: string }> {
  actorId(s);
  if (!isUuid(input.jobId)) throw new RecruitmentError('not_found');
  const v = validateReferralInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const resume = referralResume(input.file);
  const outcome = await withRecruitmentTenant(s, async (tx) => {
    try {
      const [row] = await tx.execute<{ result: { ok: boolean; referralId?: string; reason?: string } }>(sql`
        select app.recruitment_submit_referral(${input.jobId as string}::uuid, ${v.value.fullName}, ${v.value.email}, ${v.value.mobile}, ${v.value.reason}, true,
          ${resume?.fileName ?? null}, ${resume?.mimeType ?? null}, ${resume?.content ?? null}::bytea) as result`);
      return row.result;
    } catch (e) {
      if (pgSqlState(e) === '22023') throw new RecruitmentError('invalid_input');
      throw e;
    }
  });
  if (!outcome.ok || !outcome.referralId) throw new RecruitmentError('referral_refused');
  return { referralId: outcome.referralId };
}

export type MyReferralRow = {
  id: string; companyName: string; jobTitle: string; jobNumber: string; referredAt: string;
  /** The name as the referrer entered it; null once the candidate's data was removed. */
  candidateName: string | null;
  status: ReferralStatus;
};

/** My referrals: the caller's own referrals only, newest first, with the coarse status (never stage names or HR notes). */
export async function myReferrals(s: SessionContext): Promise<MyReferralRow[]> {
  if (!s.userId) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{
      referral_id: string; company_name: string; job_title: string; job_number: string; referred_at: string | Date; candidate_name: string | null; removed: boolean;
      state: 'active' | 'hired' | 'archived'; stage_type: string | null; stage_position: number | null; interview_position: number | null; offer_position: number | null;
    }>(sql`select * from app.recruitment_my_referrals()`);
    return rows.map((r) => ({
      id: r.referral_id, companyName: r.company_name, jobTitle: r.job_title, jobNumber: r.job_number, referredAt: iso(r.referred_at),
      candidateName: r.removed ? null : r.candidate_name,
      status: referralStatus({
        state: r.state, removed: r.removed, stageType: r.stage_type, stagePosition: r.stage_position, interviewPosition: r.interview_position,
        offerPosition: r.offer_position,
      }),
    }));
  });
}

// ── HR ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A job's "Show on the referral portal" setting: recruitment administrators of the job's company only (5707 refuses again). */
export async function setJobReferralPortal(s: SessionContext, jobId: string, on: unknown): Promise<void> {
  const value = on === true || on === 'on' || on === 'true';
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId);
    if (job.showOnReferralPortal === value) return;
    await tx.update(recruitmentJobOpening).set({ showOnReferralPortal: value, updatedAt: sql`now()`, updatedByUserId: user })
      .where(and(eq(recruitmentJobOpening.id, job.id), eq(recruitmentJobOpening.tenantId, s.tenantId)));
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: job.id, eventType: 'recruitment-job.referral-portal-changed', actor: actorOf(s),
      payload: { companyId: job.companyId, from: job.showOnReferralPortal, to: value },
    });
  });
}

export type ReferralSettings = { protectionDays: number };
/** The company's referral protection period (administrators). A missing settings row reads as the default. */
export async function referralSettings(s: SessionContext, companyId: string): Promise<ReferralSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const [row] = await tx.select({ days: recruitmentCompanySetting.referralProtectionDays }).from(recruitmentCompanySetting)
      .where(eq(recruitmentCompanySetting.companyId, companyId));
    return { protectionDays: row?.days ?? REFERRAL_PROTECTION_DEFAULT_DAYS };
  });
}

export async function updateReferralSettings(s: SessionContext, companyId: unknown, input: { protectionDays?: unknown }): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const days = validateProtectionDays(input.protectionDays);
  if (days === null) throw new RecruitmentError('invalid_input', ['protectionDays']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const [before] = await tx.select({ days: recruitmentCompanySetting.referralProtectionDays }).from(recruitmentCompanySetting)
      .where(eq(recruitmentCompanySetting.companyId, companyId));
    await tx.insert(recruitmentCompanySetting).values({ tenantId: s.tenantId, companyId, createdByUserId: user, updatedByUserId: user }).onConflictDoNothing();
    await tx.update(recruitmentCompanySetting).set({ referralProtectionDays: days, updatedAt: sql`now()`, updatedByUserId: user })
      .where(eq(recruitmentCompanySetting.companyId, companyId));
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId, eventType: 'recruitment-setting.referrals-updated',
      actor: actorOf(s), payload: { companyId, before: { protectionDays: before?.days ?? REFERRAL_PROTECTION_DEFAULT_DAYS }, after: { protectionDays: days } } });
  });
}

export type ApplicationReferral = { referrerName: string | null; referredAt: string; reason: string | null };
/**
 * The referral behind an application, for anyone who may read the application: who referred and when; the reason for
 * the job's reviewers and administrators only (and none once the candidate was removed). Null when not a referral.
 */
export async function applicationReferral(s: SessionContext, applicationId: unknown): Promise<ApplicationReferral | null> {
  if (!isUuid(applicationId)) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.execute<{ referrer_name: string | null; referred_at: string | Date; reason: string | null }>(sql`
      select referrer_name, referred_at, reason from app.recruitment_application_referral(${applicationId}::uuid)`);
    return row ? { referrerName: row.referrer_name, referredAt: iso(row.referred_at), reason: row.reason } : null;
  });
}
