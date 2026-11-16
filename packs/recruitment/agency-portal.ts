/**
 * Recruitment slice 25 — the agency portal (owner D-063; this reconstruction's details in D-070). Agency consultants (slice 10's
 * contact records) sign in on the company's careers address with a one-time code sent to their recorded e-mail (slice 21a's design:
 * no accounts), see the jobs released to their contracts, submit candidates and follow a coarse status. A portal submission waits
 * in HR's inbox; the job's recruiter, assistants or an administrator records it through slice 10's own path or declines it.
 *
 * Public calls run on the careers pool through the 5727 definers; the database never sees a code or a session token, only keyed
 * hashes. HR calls run as the signed-in user under row security.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { resolveDocumentUpload } from '../../core/employee-documents';
import { careersCodeHash, careersTokenHash, newCareersCode, newCareersToken } from '../../lib/careers-client';
import { candidateEmailAvailable, candidateEmailSender } from '../../lib/recruitment-candidate-email-ipc';
import { messagesForLocale } from '../../i18n/catalogs';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { RecruitmentError, isUuid } from './model';
import { CANDIDATE_FILE_MAX_BYTES, normEmail } from './privacy-model';
import { CANDIDATE_EMAIL_LOCALES, renderCandidateEmail, usableRecipient, type CandidateEmailLocale } from './candidate-email-model';
import { validateSubmissionInput } from './agency-model';
import { careersDb } from './careers';
import { recordAgencySubmission } from './agencies';
import { actorId, assertCompanyTx, jobTx } from './data';
import { recruitmentAgencyPortalSubmission } from './schema';

/** The code's keyed hash is bound to this scope (never a job id), so a careers code never opens the portal and vice versa. */
const codeScope = (address: string) => `agency-portal:${address}`;
export const AGENCY_PORTAL_SESSION_HOURS = 8;
export const AGENCY_PORTAL_DAILY_SUBMISSIONS = 20;
export const AGENCY_PORTAL_DECLINE_REASON_MAX = 500;
export const AGENCY_PORTAL_STATUSES = ['received', 'in_process', 'hired', 'not_progressed'] as const;
export type AgencyPortalStatus = (typeof AGENCY_PORTAL_STATUSES)[number];

// ── Public: sign-in ─────────────────────────────────────────────────────────────────────────────────────────

export type AgencyPortalCodeRequest = 'sent' | 'invalid_email' | 'client_limited' | 'not_found' | 'unavailable';
/**
 * Send a sign-in code to the address typed. 'sent' whatever happened past validation (sent, not a consultant, the address's limit,
 * a relay refusal): the page is the same, so it never reveals who is a consultant or limited.
 */
export async function requestAgencyPortalCode(input: { address: string; email: string; clientHash: () => string }): Promise<AgencyPortalCodeRequest> {
  const email = (input.email ?? '').trim().toLowerCase();
  if (!usableRecipient(email)) return 'invalid_email';
  const context = await portalEmailContext(input.address);
  if (!context) return 'not_found';
  if (!(await candidateEmailAvailable(context.tenantId))) return 'unavailable';
  const code = newCareersCode();
  const [row] = await careersDb().unsafe<{ r: { status: string } }[]>('select app.recruitment_agency_portal_issue_code($1::text, $2::text, $3::text, $4::text) as r',
    [input.address, input.clientHash(), email, careersCodeHash(codeScope(input.address), normEmail(email)!, code)]);
  const status = row?.r?.status;
  if (status === 'client_limited') return 'client_limited';
  if (status === 'not_found') return 'not_found';
  if (status !== 'issued') return 'sent';
  try {
    const sender = await candidateEmailSender(context.tenantId);
    if (!sender || !context.senderName || !context.replyTo) return 'sent';
    const mail = await agencyPortalCodeEmail(context, code);
    await sender.send({ to: email, subject: mail.subject, text: mail.text, html: mail.html, senderName: context.senderName, replyTo: context.replyTo,
      messageId: `<recruitment-agency-portal-code.${newCareersToken().slice(0, 22)}@${sender.host}>` });
  } catch (e) {
    console.error('recruitment agency portal code not sent', e instanceof Error ? e.name : typeof e);
  }
  return 'sent';
}

type PortalEmailContext = { tenantId: string; companyId: string; companyName: string; senderName: string | null; replyTo: string | null; locale: CandidateEmailLocale };
async function portalEmailContext(address: string): Promise<PortalEmailContext | null> {
  const [row] = await careersDb().unsafe<{ r: PortalEmailContext | null }[]>('select app.recruitment_agency_portal_email_context($1::text) as r', [address]);
  const r = row?.r ?? null;
  if (!r) return null;
  return { ...r, locale: (CANDIDATE_EMAIL_LOCALES as readonly string[]).includes(r.locale) ? r.locale : 'en' };
}

/** The code e-mail: code-owned wording (messages agencyPortal.codeEmail) in the company's candidate e-mail language, no link. */
async function agencyPortalCodeEmail(c: PortalEmailContext, code: string) {
  const m = await messagesForLocale(c.locale) as unknown as { agencyPortal: { codeEmail: { subject: string; body: string } } };
  const t = m.agencyPortal.codeEmail;
  const template = { subject: t.subject.split('{code}').join(code), body: t.body.split('{code}').join(code) };
  return renderCandidateEmail('application_received', c.locale, template, { candidateName: '', jobTitle: '', companyName: c.companyName, senderName: c.senderName ?? '' });
}

export type AgencyPortalCodeCheck = { status: 'signed_in'; token: string } | { status: 'wrong' | 'expired' | 'client_limited' | 'not_found' | 'invalid' };
/** Check the code typed. A right code opens a session (8 hours) whose token the caller sets as the portal cookie. */
export async function checkAgencyPortalCode(input: { address: string; email: string; code: string; clientHash: () => string }): Promise<AgencyPortalCodeCheck> {
  const email = (input.email ?? '').trim().toLowerCase();
  const code = (input.code ?? '').replace(/\s+/g, '');
  if (!usableRecipient(email) || !/^\d{6}$/.test(code)) return { status: 'invalid' };
  const token = newCareersToken();
  const [row] = await careersDb().unsafe<{ r: { status: string } }[]>(
    'select app.recruitment_agency_portal_check_code($1::text, $2::text, $3::text, $4::text, $5::text) as r',
    [input.address, input.clientHash(), email, careersCodeHash(codeScope(input.address), normEmail(email)!, code), careersTokenHash(token)!]);
  const status = row?.r?.status;
  if (status === 'signed_in') return { status, token };
  if (status === 'wrong' || status === 'expired' || status === 'client_limited' || status === 'not_found') return { status };
  throw new Error('Agency portal code check returned no outcome');
}

/** Whether a portal exists at this address now (published careers page, portal switch on, candidate e-mail able to send). */
export async function agencyPortalAvailable(address: string): Promise<boolean> {
  const context = await portalEmailContext(address);
  return !!context && (await candidateEmailAvailable(context.tenantId));
}

export async function signOutAgencyPortal(token: string | null): Promise<void> {
  const hash = token ? careersTokenHash(token) : null;
  if (!hash) return;
  await careersDb().unsafe('select app.recruitment_agency_portal_sign_out($1::text)', [hash]);
}

// ── Public: the portal ──────────────────────────────────────────────────────────────────────────────────────

export type AgencyPortalJob = {
  jobId: string; title: string; workLocation: string; employmentType: string; description: string | null; requirements: string | null;
  contractId: string; contractName: string; agencyName: string;
};
export type AgencyPortalView = {
  companyName: string; expiresAt: string;
  contracts: { contractId: string; contractName: string; agencyName: string; consultantName: string }[];
  jobs: AgencyPortalJob[];
  submissions: { receivedAt: string; fullName: string | null; jobTitle: string; status: AgencyPortalStatus }[];
};
/** The signed-in consultant's portal, or null (no live session: the caller clears the cookie and shows the sign-in step). */
export async function agencyPortalView(address: string, token: string | null): Promise<AgencyPortalView | null> {
  const hash = token ? careersTokenHash(token) : null;
  if (!hash) return null;
  const [row] = await careersDb().unsafe<{ r: AgencyPortalView | null }[]>('select app.recruitment_agency_portal_view($1::text, $2::text) as r', [address, hash]);
  return row?.r ?? null;
}

export type AgencyPortalField = 'job' | 'fullName' | 'email' | 'mobile' | 'emailOrMobile' | 'comments' | 'resume' | 'permission';
export type AgencyPortalSubmitResult =
  | { status: 'received' | 'signed_out' | 'not_available' | 'repeat' | 'daily_limit' | 'client_limited' }
  | { status: 'invalid'; fields: AgencyPortalField[] };
export type AgencyPortalSubmission = {
  address: string; token: string | null; clientHash: () => string; jobId: string; contractId: string; fullName: string; email: string; mobile: string;
  comments: string; permission: boolean; resume: { fileName: string; content: Buffer } | null;
};
/** Submit a candidate into HR's inbox. Fields are validated with slice 10's own rules first; the definer decides the rest. */
export async function submitAgencyPortal(input: AgencyPortalSubmission): Promise<AgencyPortalSubmitResult> {
  const hash = input.token ? careersTokenHash(input.token) : null;
  if (!hash) return { status: 'signed_out' };
  const fields: AgencyPortalField[] = [];
  if (!isUuid(input.jobId) || !isUuid(input.contractId)) fields.push('job');
  const v = validateSubmissionInput({ fullName: input.fullName, email: input.email, mobile: input.mobile, comments: input.comments }, todayInKualaLumpur(), null);
  if (!v.ok) for (const f of v.fields ?? []) if (['fullName', 'email', 'mobile', 'emailOrMobile', 'comments'].includes(f)) fields.push(f as AgencyPortalField);
  let resume: { fileName: string; mimeType: string; content: Buffer } | null = null;
  if (input.resume && input.resume.content.byteLength > 0) {
    const fileName = input.resume.fileName.trim().slice(-200);
    if (!input.permission) fields.push('permission');
    if (!fileName || input.resume.content.byteLength > CANDIDATE_FILE_MAX_BYTES) fields.push('resume');
    else {
      try {
        resume = { fileName, mimeType: resolveDocumentUpload(fileName, input.resume.content).mimeType, content: input.resume.content };
      } catch {
        fields.push('resume');
      }
    }
  }
  if (fields.length || !v.ok) return { status: 'invalid', fields: fields.length ? [...new Set(fields)] : ['fullName'] };
  const [row] = await careersDb().unsafe<{ r: { status: string } }[]>(
    'select app.recruitment_agency_portal_submit($1::text, $2::text, $3::text, $4::uuid, $5::uuid, $6::text, $7::text, $8::text, $9::text, $10::text, $11::text, $12::bytea, $13::boolean) as r',
    [input.address, hash, input.clientHash(), input.jobId, input.contractId, v.value.fullName, v.value.email, v.value.mobile, v.value.comments,
      resume?.fileName ?? null, resume?.mimeType ?? null, resume?.content ?? null, !!resume && input.permission]);
  const status = row?.r?.status;
  if (status === 'received' || status === 'signed_out' || status === 'not_available' || status === 'repeat' || status === 'daily_limit' || status === 'client_limited') return { status };
  throw new Error('Agency portal submission returned no outcome');
}

// ── HR: the inbox ───────────────────────────────────────────────────────────────────────────────────────────

export type AgencyPortalInboxRow = {
  id: string; jobId: string; jobTitle: string; agencyName: string; contractName: string; consultantName: string; fullName: string | null;
  email: string | null; mobile: string | null; comments: string | null; resumeName: string | null; receivedAt: string;
  state: 'waiting' | 'recorded' | 'declined'; decidedAt: string | null; submissionId: string | null;
};
/** The company's portal submissions on jobs the caller operates: waiting ones first (oldest first), then the last 50 decided. */
export async function agencyPortalInbox(s: SessionContext, companyId: string): Promise<AgencyPortalInboxRow[]> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{ id: string; job_id: string; job_title: string; agency_name: string; contract_name: string; consultant_name: string;
      full_name: string | null; email: string | null; mobile: string | null; comments: string | null; resume_name: string | null; received_at: string | Date;
      state: AgencyPortalInboxRow['state']; decided_at: string | Date | null; submission_id: string | null }>(sql`
      (select p.id, p.job_id, j.title as job_title, a.name as agency_name, c.name as contract_name, k.name as consultant_name, p.full_name, p.email, p.mobile,
        p.comments, p.resume_name, p.received_at, p.state, p.decided_at, p.submission_id
       from recruitment_agency_portal_submission p
       join recruitment_job_opening j on j.id = p.job_id
       join recruitment_agency_contract c on c.id = p.contract_id
       join recruitment_agency a on a.id = c.agency_id
       join recruitment_agency_consultant k on k.id = p.consultant_id
       where p.company_id = ${companyId}::uuid and p.tenant_id = ${s.tenantId}::uuid and p.state = 'waiting'
       order by p.received_at, p.id limit 200)
      union all
      (select p.id, p.job_id, j.title, a.name, c.name, k.name, p.full_name, p.email, p.mobile, p.comments, p.resume_name, p.received_at, p.state, p.decided_at,
        p.submission_id
       from recruitment_agency_portal_submission p
       join recruitment_job_opening j on j.id = p.job_id
       join recruitment_agency_contract c on c.id = p.contract_id
       join recruitment_agency a on a.id = c.agency_id
       join recruitment_agency_consultant k on k.id = p.consultant_id
       where p.company_id = ${companyId}::uuid and p.tenant_id = ${s.tenantId}::uuid and p.state <> 'waiting'
       order by p.decided_at desc, p.id limit 50)`);
    const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
    return rows.map((r) => ({
      id: r.id, jobId: r.job_id, jobTitle: r.job_title, agencyName: r.agency_name, contractName: r.contract_name, consultantName: r.consultant_name,
      fullName: r.full_name, email: r.email, mobile: r.mobile, comments: r.comments, resumeName: r.resume_name, receivedAt: iso(r.received_at)!,
      state: r.state, decidedAt: iso(r.decided_at), submissionId: r.submission_id,
    }));
  });
}

/** The waiting row as its operator sees it, with the résumé bytes; refuses anything else. */
async function waitingTx(tx: Tx, s: SessionContext, id: string) {
  const [p] = await tx.select().from(recruitmentAgencyPortalSubmission)
    .where(and(eq(recruitmentAgencyPortalSubmission.id, id), eq(recruitmentAgencyPortalSubmission.tenantId, s.tenantId))).for('update');
  if (!p) throw new RecruitmentError('not_found');
  if (p.state !== 'waiting') throw new RecruitmentError('portal_decided');
  await jobTx(tx, s, p.jobId, 'operate');
  return p;
}
const cleared = { email: null, mobile: null, comments: null, resumeName: null, resumeMime: null, resumeSize: null, resumeContent: null } as const;

/**
 * Record a waiting portal submission through slice 10 (the caller is the recorder: the job's recruiter, assistants or an
 * administrator; a contract usable by them today; every slice 10 rule, including duplicates, protection, repeats and the daily cap).
 * The inbox row becomes 'recorded' in the same transaction and keeps no personal data. A slice 10 refusal leaves the row waiting.
 */
export async function recordAgencyPortalSubmission(s: SessionContext, id: unknown): Promise<{ outcome: string; applicationId: string | null }> {
  if (!isUuid(id)) throw new RecruitmentError('not_found');
  const user = actorId(s);
  const p = await withRecruitmentTenant(s, (tx) => waitingTx(tx, s, id));
  const result = await recordAgencySubmission(s, {
    jobId: p.jobId, contractId: p.contractId, consultantId: p.consultantId, fullName: p.fullName, email: p.email ?? '', mobile: p.mobile ?? '',
    comments: p.comments ?? '', submittedOn: todayInKualaLumpur(new Date(p.receivedAt)),
    ...(p.resumeContent ? { resumeName: p.resumeName, resumeContent: Buffer.from(p.resumeContent), permissionConfirmed: p.permissionConfirmed } : {}),
  }, async (tx, submissionId) => {
    const [row] = await tx.update(recruitmentAgencyPortalSubmission)
      .set({ state: 'recorded', decidedAt: sql`now()`, decidedByUserId: user, submissionId, fullName: null, ...cleared })
      .where(and(eq(recruitmentAgencyPortalSubmission.id, id), eq(recruitmentAgencyPortalSubmission.state, 'waiting')))
      .returning({ id: recruitmentAgencyPortalSubmission.id });
    if (!row) throw new RecruitmentError('portal_decided');
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-agency-portal-submission', aggregateId: id,
      eventType: 'recruitment-agency-portal.recorded', actor: actorOf(s), payload: { companyId: p.companyId, jobId: p.jobId, submissionId } });
  });
  return { outcome: result.outcome, applicationId: result.applicationId };
}

/** Decline a waiting portal submission with a reason (kept for HR; the agency sees "not taken forward"). Clears its personal data
 *  except the name, which the agency's list shows until the row is pruned. */
export async function declineAgencyPortalSubmission(s: SessionContext, id: unknown, reason: unknown): Promise<void> {
  if (!isUuid(id)) throw new RecruitmentError('not_found');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why || why.length > AGENCY_PORTAL_DECLINE_REASON_MAX) throw new RecruitmentError('missing_fields', ['reason']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const p = await waitingTx(tx, s, id);
    await tx.update(recruitmentAgencyPortalSubmission)
      .set({ state: 'declined', decidedAt: sql`now()`, decidedByUserId: user, declineReason: why, ...cleared })
      .where(eq(recruitmentAgencyPortalSubmission.id, id));
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-agency-portal-submission', aggregateId: id,
      eventType: 'recruitment-agency-portal.declined', actor: actorOf(s), payload: { companyId: p.companyId, jobId: p.jobId } });
  });
}

/** The résumé of a waiting portal submission, for its job's operators. */
export async function agencyPortalResume(s: SessionContext, id: unknown): Promise<{ fileName: string; mimeType: string; content: Buffer } | null> {
  if (!isUuid(id)) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [p] = await tx.select({ jobId: recruitmentAgencyPortalSubmission.jobId, name: recruitmentAgencyPortalSubmission.resumeName,
      mime: recruitmentAgencyPortalSubmission.resumeMime, content: recruitmentAgencyPortalSubmission.resumeContent })
      .from(recruitmentAgencyPortalSubmission).where(and(eq(recruitmentAgencyPortalSubmission.id, id), eq(recruitmentAgencyPortalSubmission.tenantId, s.tenantId)));
    if (!p?.content || !p.name || !p.mime) return null;
    await jobTx(tx, s, p.jobId, 'operate');
    return { fileName: p.name, mimeType: p.mime, content: Buffer.from(p.content) };
  });
}

// ── Settings › Agencies: the portal switch (administrators) ─────────────────────────────────────────────────

export async function agencyPortalSetting(s: SessionContext, companyId: string): Promise<{ on: boolean; address: string | null }> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const [row] = await tx.execute<{ on: boolean; address: string | null }>(sql`
      select coalesce((select agency_portal_enabled from recruitment_company_setting where company_id = ${companyId}::uuid and tenant_id = ${s.tenantId}::uuid), false) as on,
        (select address from recruitment_careers_site where company_id = ${companyId}::uuid and tenant_id = ${s.tenantId}::uuid and published) as address`);
    return { on: row?.on === true, address: row?.address ?? null };
  });
}

export async function updateAgencyPortalSetting(s: SessionContext, companyId: unknown, enabled: unknown): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const user = actorId(s);
  const on = enabled === true || enabled === 'on' || enabled === 'true';
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const [before] = await tx.execute<{ on: boolean }>(sql`select agency_portal_enabled as on from recruitment_company_setting
      where company_id = ${companyId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    await tx.execute(sql`insert into recruitment_company_setting (company_id, tenant_id, created_by_user_id, updated_by_user_id)
      values (${companyId}::uuid, ${s.tenantId}::uuid, ${user}::uuid, ${user}::uuid) on conflict do nothing`);
    await tx.execute(sql`update recruitment_company_setting set agency_portal_enabled = ${on}, updated_at = now(), updated_by_user_id = ${user}::uuid
      where company_id = ${companyId}::uuid`);
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId,
      eventType: 'recruitment-setting.agency-portal-updated', actor: actorOf(s), payload: { companyId, before: { on: before?.on === true }, after: { on } } });
  });
}
