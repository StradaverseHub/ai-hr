/**
 * Recruitment slice 8 — the public careers page and online applications. Reached from outside the pack ONLY through
 * ./service.
 *
 * Two audiences:
 *   - HR (withRecruitmentTenant): the company's careers page settings, its publish switch and privacy notice versions,
 *     and each job's "Show on careers page" switch (recruitment administrators only; 4408 refuses anybody else again);
 *     the careers application (source, message, arrival) on an application page for the job's reviewers.
 *   - The VISITOR (anonymous): the careers page, one job and the application form. No session exists, so these calls
 *     use the app role's plain connection and reach the data ONLY through 4408's three SECURITY DEFINER functions, which
 *     take the address and job id (plus the form) and return only the public fields. Every unavailable page or job is the
 *     same null ("not found"); every well-formed accepted, repeated or honeypot submission is the same "received".
 * Nothing here sends a message (D-029), calls a model or scores a candidate.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { resolveDocumentUpload } from '../../core/employee-documents';
import { pgSqlState } from '../../lib/db-error';
import { careersJobPath } from '../../lib/careers-route';
import { careersApplicationsAccepted } from '../../lib/careers-client';
import { RecruitmentError, isUuid, type JobEmploymentType } from './model';
import { CANDIDATE_FILE_MAX_BYTES, CANDIDATE_FILE_MIME } from './privacy-model';
import {
  CAREERS_PAGE_SIZE, careersFileNameOk, careersPublishMissing, validateCareersApplication, validateCareersSettings, type CareersApplicationInput, type CareersFieldError,
  type CareersFormField, type CareersOutcome, type CareersPublishRequirement, type CareersSettingsInput,
} from './careers-model';
import { recruitmentCareersApplication, recruitmentCareersNotice, recruitmentCareersSite, recruitmentJobOpening } from './schema';
import { actorId, assertCompanyTx, jobTx, userLabelsTx } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();

// ── HR: the careers page settings ──────────────────────────────────────────────────────────────────────────────

export type CareersNoticeVersionView = { version: number; body: string; createdAt: string; createdBy: string | null };
export type CareersSettings = {
  published: boolean; address: string | null; displayName: string | null; headline: string | null; introduction: string | null;
  /** The current notice (the highest version), or null before the first one. */
  notice: CareersNoticeVersionView | null;
  /** Every version, newest first. */
  versions: CareersNoticeVersionView[];
  /** What stops the page from being published (empty when it can be). */
  missing: CareersPublishRequirement[];
  updatedAt: string | null; updatedBy: string | null;
  /** False while this installation does not accept online applications (its web server step for the careers page is not
   *  done): the page and jobs are visible, the form cannot be sent. */
  acceptingApplications: boolean;
};

async function siteTx(tx: Tx, companyId: string) {
  const [site] = await tx.select().from(recruitmentCareersSite).where(eq(recruitmentCareersSite.companyId, companyId));
  return site ?? null;
}
async function currentNoticeTx(tx: Tx, companyId: string) {
  const [notice] = await tx.select().from(recruitmentCareersNotice).where(eq(recruitmentCareersNotice.companyId, companyId))
    .orderBy(desc(recruitmentCareersNotice.version)).limit(1);
  return notice ?? null;
}

/** The company's careers page settings and notice history (recruitment administrators). */
export async function careersSettings(s: SessionContext, companyId: string): Promise<CareersSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const site = await siteTx(tx, companyId);
    const notices = await tx.select().from(recruitmentCareersNotice).where(eq(recruitmentCareersNotice.companyId, companyId))
      .orderBy(desc(recruitmentCareersNotice.version));
    const labels = await userLabelsTx(tx, companyId);
    const who = (id: string | null) => (id ? labels.get(id)?.name ?? null : null);
    const versions = notices.map((n) => ({ version: n.version, body: n.body, createdAt: iso(n.createdAt), createdBy: who(n.createdByUserId) }));
    const value = { address: site?.address ?? null, displayName: site?.displayName ?? null };
    return {
      published: site?.published ?? false, ...value, headline: site?.headline ?? null, introduction: site?.introduction ?? null,
      notice: versions[0] ?? null, versions, missing: careersPublishMissing({ ...value, noticeVersion: versions[0]?.version ?? null }),
      updatedAt: site ? iso(site.updatedAt) : null, updatedBy: site ? who(site.updatedByUserId) : null,
      acceptingApplications: careersApplicationsAccepted(),
    };
  });
}

/**
 * Save the careers page fields. A notice text that differs from the current one becomes the next version (the earlier
 * ones are kept unchanged); a notice, once given, cannot be emptied. The address is unique in the installation.
 */
export async function updateCareersSettings(s: SessionContext, companyId: unknown, input: CareersSettingsInput): Promise<{ noticeVersion: number | null }> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const v = validateCareersSettings(input);
  if (!v.ok) throw new RecruitmentError('invalid_input', v.fields);
  const user = actorId(s);
  try {
    return await withRecruitmentTenant(s, async (tx) => {
      await assertCompanyTx(tx, companyId);
      const before = await siteTx(tx, companyId);
      const current = await currentNoticeTx(tx, companyId);
      if (current && !v.value.notice) throw new RecruitmentError('missing_fields', ['notice']);
      // A published page keeps what it needs to stay published.
      if (before?.published && (!v.value.address || !v.value.displayName)) throw new RecruitmentError('careers_incomplete', careersPublishMissing({
        address: v.value.address, displayName: v.value.displayName, noticeVersion: current?.version ?? null,
      }));
      const fields = { address: v.value.address, displayName: v.value.displayName, headline: v.value.headline, introduction: v.value.introduction };
      if (before) {
        await tx.update(recruitmentCareersSite).set({ ...fields, updatedByUserId: user, updatedAt: sql`now()` }).where(eq(recruitmentCareersSite.companyId, companyId));
      } else {
        await tx.insert(recruitmentCareersSite).values({ companyId, tenantId: s.tenantId, ...fields, createdByUserId: user, updatedByUserId: user });
      }
      let noticeVersion: number | null = null;
      if (v.value.notice && v.value.notice !== current?.body) {
        // The database numbers the version (the value sent is replaced) and keeps every earlier one unchanged.
        const [row] = await tx.insert(recruitmentCareersNotice).values({ tenantId: s.tenantId, companyId, version: 0, body: v.value.notice, createdByUserId: user })
          .returning({ version: recruitmentCareersNotice.version });
        noticeVersion = row.version;
      }
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => (before?.[k] ?? null) !== fields[k]);
      await appendEvent(tx, {
        tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId, eventType: 'recruitment-careers.settings-updated', actor: actorOf(s),
        payload: { companyId, changed, ...(noticeVersion ? { noticeVersion } : {}) },
      });
      return { noticeVersion };
    });
  } catch (e) {
    if (pgSqlState(e) === '23505') throw new RecruitmentError('careers_address_taken', ['address']);
    throw e;
  }
}

/** Publish or withdraw the careers page. Publishing names what is missing; the database refuses the same. */
export async function setCareersPublished(s: SessionContext, companyId: unknown, on: unknown): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const value = on === true || on === 'on' || on === 'true';
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const site = await siteTx(tx, companyId);
    if ((site?.published ?? false) === value) return;
    if (value) {
      const missing = careersPublishMissing({ address: site?.address ?? null, displayName: site?.displayName ?? null, noticeVersion: (await currentNoticeTx(tx, companyId))?.version ?? null });
      if (!site || missing.length) throw new RecruitmentError('careers_incomplete', missing);
    }
    await tx.update(recruitmentCareersSite).set({ published: value, updatedByUserId: user, updatedAt: sql`now()` }).where(eq(recruitmentCareersSite.companyId, companyId));
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId,
      eventType: value ? 'recruitment-careers.published' : 'recruitment-careers.withdrawn', actor: actorOf(s), payload: { companyId },
    });
  });
}

/** A job's "Show on careers page" switch: recruitment administrators of the job's company only (4408 refuses again). */
export async function setJobCareersPage(s: SessionContext, jobId: string, on: unknown): Promise<void> {
  const value = on === true || on === 'on' || on === 'true';
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId);
    if (job.showOnCareersPage === value) return;
    await tx.update(recruitmentJobOpening).set({ showOnCareersPage: value, updatedAt: sql`now()`, updatedByUserId: user })
      .where(and(eq(recruitmentJobOpening.id, job.id), eq(recruitmentJobOpening.tenantId, s.tenantId)));
    await appendEvent(tx, {
      tenantId: s.tenantId, aggregateType: 'recruitment-job', aggregateId: job.id, eventType: 'recruitment-job.careers-page-changed', actor: actorOf(s),
      payload: { companyId: job.companyId, from: job.showOnCareersPage, to: value },
    });
  });
}

export type JobCareersStatus = {
  show: boolean; postedAt: string | null; sitePublished: boolean; jobOpen: boolean;
  /** The public path while the job is public (page published, job Open, switch on); otherwise null. */
  publicPath: string | null;
};
/** The careers page state of one job, for its administrators (the position page). */
export async function jobCareersStatus(s: SessionContext, jobId: string): Promise<JobCareersStatus> {
  return withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId);
    const site = await siteTx(tx, job.companyId);
    const sitePublished = !!site?.published && !!site.address;
    const jobOpen = job.status === 'open';
    return {
      show: job.showOnCareersPage, postedAt: job.careersPostedAt ? iso(job.careersPostedAt) : null, sitePublished, jobOpen,
      publicPath: sitePublished && jobOpen && job.showOnCareersPage ? careersJobPath(site!.address!, job.id) : null,
    };
  });
}

export type ApplicationCareers = { receivedAt: string; message: string | null };
/**
 * The careers page record behind an application, for the job's reviewers and administrators (row security): when it
 * arrived and the applicant's message (none once the candidate was removed). Null when it did not come from the page.
 */
export async function applicationCareers(s: SessionContext, applicationId: unknown): Promise<ApplicationCareers | null> {
  if (!isUuid(applicationId)) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.select({ receivedAt: recruitmentCareersApplication.receivedAt, message: recruitmentCareersApplication.message })
      .from(recruitmentCareersApplication).where(eq(recruitmentCareersApplication.applicationId, applicationId));
    return row ? { receivedAt: iso(row.receivedAt), message: row.message } : null;
  });
}

// ── The visitor (anonymous) ────────────────────────────────────────────────────────────────────────────────────

/**
 * Anonymous careers calls use their OWN small connection pool (the app role, the same database), so public traffic can
 * never take a connection the HR application needs. Every statement on it is bounded: 5 s per statement and 3 s for any
 * lock wait (the definer functions also pin their lock wait); a timeout is answered as "unavailable" by the caller.
 * Per-process admission in the route handlers keeps the queue in front of these connections short.
 */
export const CAREERS_POOL_SIZE = 4;
let careersPool: ReturnType<typeof postgres> | null = null;
function careersDb() {
  careersPool ??= postgres(process.env.DATABASE_URL!, {
    max: CAREERS_POOL_SIZE, idle_timeout: 20, connect_timeout: 5,
    connection: { application_name: 'aihr-careers', statement_timeout: 5000, lock_timeout: 3000, idle_in_transaction_session_timeout: 5000 },
  });
  return careersPool;
}
/** Tests and shutdown only. */
export async function closeCareersPool(): Promise<void> {
  const pool = careersPool;
  careersPool = null;
  await pool?.end({ timeout: 5 });
}

/** 60 page reads a minute per client, on the shared app.consume_request_budget token bucket (as letter verification). */
export const CAREERS_READ_BUDGET = { capacity: 60, windowSeconds: 60 } as const;
const KEY = /^[0-9a-f]{64}$/;
/**
 * A read through the careers pool, charged to the client's read budget first when the client can be told apart. One
 * statement: the read runs only when the budget had room; otherwise 'limited'.
 */
async function budgetedRead(call: string, params: (string | number | null)[], readKey: string | null): Promise<Record<string, unknown> | null | 'limited'> {
  const charged = readKey !== null && KEY.test(readKey);
  const budget = 'app.consume_request_budget($' + (params.length + 1) + '::text, ' + CAREERS_READ_BUDGET.capacity + ', ' + CAREERS_READ_BUDGET.windowSeconds + ')';
  const statement = charged ? 'select case when ' + budget + ' > 0 then \'{"limited":true}\'::jsonb else ' + call + ' end as r' : 'select ' + call + ' as r';
  const [row] = await careersDb().unsafe<{ r: Record<string, unknown> | null }[]>(statement, charged ? [...params, readKey] : params);
  const r = row?.r ?? null;
  return r && r.limited === true ? 'limited' : r;
}

export type CareersPublicJobRow = { id: string; title: string; jobNumber: string; employmentType: JobEmploymentType; workLocation: string; postedAt: string };
export type CareersPublicPage = {
  displayName: string; headline: string | null; introduction: string | null; locations: string[]; employmentTypes: JobEmploymentType[];
  total: number; page: number; pageSize: number; jobs: CareersPublicJobRow[];
};
export type CareersPublicJob = {
  displayName: string;
  job: CareersPublicJobRow & { description: string | null };
  notice: { version: number; body: string };
};
export type CareersPageQuery = { query?: string | null; location?: string | null; employmentType?: string | null; page?: number };

const short = (value: string | null | undefined, max: number) => {
  const v = (value ?? '').trim();
  return v === '' ? null : [...v].slice(0, max).join('');
};
const publicRow = (r: Record<string, unknown>): CareersPublicJobRow => ({
  id: String(r.id), title: String(r.title), jobNumber: String(r.jobNumber), employmentType: r.employmentType as JobEmploymentType,
  workLocation: String(r.workLocation), postedAt: iso(String(r.postedAt)),
});

/**
 * The public careers page for an address, or null when it is not public (unknown, unpublished, a tenant without
 * Recruitment). One read through app.recruitment_careers_page: the company's text, the filter choices, the count and
 * one page of 30 jobs, newest put on the page first. Every filter is a bound parameter.
 */
export async function careersPublicPage(address: string, q: CareersPageQuery = {}, readKey: string | null = null): Promise<CareersPublicPage | null | 'limited'> {
  const r = await budgetedRead('app.recruitment_careers_page($1::text, $2::text, $3::text, $4::text, $5::integer)',
    [address, short(q.query, 100), short(q.location, 200), short(q.employmentType, 40), Math.max(1, Math.min(q.page ?? 1, 10000))], readKey);
  if (r === null || r === 'limited') return r;
  return {
    displayName: String(r.displayName), headline: (r.headline as string | null) ?? null, introduction: (r.introduction as string | null) ?? null,
    locations: (r.locations as string[]) ?? [], employmentTypes: (r.employmentTypes as JobEmploymentType[]) ?? [], total: Number(r.total ?? 0),
    page: Number(r.page ?? 1), pageSize: Number(r.pageSize ?? CAREERS_PAGE_SIZE), jobs: ((r.jobs as Record<string, unknown>[]) ?? []).map(publicRow),
  };
}

/** One public job with the current privacy notice, or null when it is not public for this address ('limited': read budget). */
export async function careersPublicJob(address: string, jobId: string, readKey: string | null = null): Promise<CareersPublicJob | null | 'limited'> {
  if (!isUuid(jobId)) return null;
  const r = await budgetedRead('app.recruitment_careers_job($1::text, $2::uuid)', [address, jobId], readKey);
  if (r === null || r === 'limited') return r;
  const job = r.job as Record<string, unknown>;
  const notice = r.notice as Record<string, unknown>;
  return {
    displayName: String(r.displayName),
    job: { ...publicRow(job), description: (job.description as string | null) ?? null },
    notice: { version: Number(notice.version), body: String(notice.body) },
  };
}

/**
 * Has this client hash already used its hourly submissions? A read-only check on the careers pool that the route makes
 * BEFORE reading a request body, so an over-limit client cannot hold a submission slot while uploading. The submission
 * itself counts again under its lock; this is only the cheap early refusal.
 */
export async function careersClientLimited(clientHash: string): Promise<boolean> {
  if (!KEY.test(clientHash)) return false;
  const [row] = await careersDb().unsafe<{ limited: boolean }[]>('select app.recruitment_careers_client_limited($1::text) as limited', [clientHash]);
  return row?.limited === true;
}

export type CareersSubmission = CareersApplicationInput & {
  address: string; jobId: string;
  /** The keyed hash of the client address (lib/careers-client.ts), asked for only once the form is valid; the address
   *  itself never reaches this module. It may throw (no verified source), which the caller answers as unavailable. */
  clientHash: () => string;
  /** The notice version the job page shows now: consent is accepted only to the current notice. */
  currentNoticeVersion: number;
  resume?: { fileName: string; content: Buffer } | null;
};
export type CareersSubmitResult = { ok: true; outcome: CareersOutcome } | { ok: false; fields: Partial<Record<CareersFormField, CareersFieldError>> };

/** The optional résumé: slice 5's types and 10 MB limit, the type read from the file's own bytes. */
function careersResume(file: CareersSubmission['resume']): { fileName: string; mimeType: string; content: Buffer } | CareersFieldError | null {
  if (!file || file.content.byteLength === 0) return null;
  if (!careersFileNameOk(file.fileName)) return 'file_name';
  const fileName = file.fileName.trim().slice(-200);
  if (file.content.byteLength > CANDIDATE_FILE_MAX_BYTES) return 'file_too_large';
  let mimeType: string;
  try {
    ({ mimeType } = resolveDocumentUpload(fileName, file.content));
  } catch {
    return 'file_type';
  }
  return (CANDIDATE_FILE_MIME as readonly string[]).includes(mimeType) ? { fileName, mimeType, content: file.content } : 'file_type';
}

/**
 * A visitor's application. The form is checked here (field messages depend only on what was typed); everything else —
 * the limits, whether the page and job are public, the honeypot, the repeated-application rule, the lock against an
 * identical concurrent submission and the writes — is decided by app.recruitment_careers_submit in one transaction.
 */
export async function submitCareersApplication(input: CareersSubmission): Promise<CareersSubmitResult> {
  const v = validateCareersApplication(input);
  const resume = careersResume(input.resume);
  const fields = { ...(v.ok ? {} : v.fields), ...(typeof resume === 'string' ? { resume } : {}) };
  if (!v.ok || typeof resume === 'string') return { ok: false, fields };
  // Consent counts only for the notice shown now; an older form is shown again with the current notice.
  if (v.value.noticeVersion !== input.currentNoticeVersion) return { ok: false, fields: { consent: 'notice_changed' } };
  if (!isUuid(input.jobId)) return { ok: true, outcome: 'not_found' };
  const clientHash = input.clientHash();
  if (!/^[0-9a-f]{64}$/.test(clientHash)) throw new Error('Careers client hash unavailable');
  const [row] = await careersDb().unsafe<{ r: { status: CareersOutcome } }[]>(
    'select app.recruitment_careers_submit($1::text, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::integer, $9::boolean, $10::text, $11::text, $12::bytea) as r',
    [input.address, input.jobId, clientHash, v.value.fullName, v.value.email, v.value.mobile, v.value.message, v.value.noticeVersion, v.value.honeypot,
      resume?.fileName ?? null, resume?.mimeType ?? null, resume?.content ?? null]);
  const status = row?.r?.status;
  if (status === 'notice_changed') return { ok: false, fields: { consent: 'notice_changed' } };
  if (status === 'received' || status === 'not_found' || status === 'rate_limited' || status === 'company_limit') return { ok: true, outcome: status };
  throw new Error('Careers submission returned no outcome');
}
