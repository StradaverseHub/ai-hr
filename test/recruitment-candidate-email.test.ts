/**
 * Recruitment slice 19 against Postgres — candidate e-mail: acceptance cases 127–131 (docs/recruitment-reconstruction/specification.md
 * "Slice 19 acceptance cases"), through the service, the sweep with a FAKED transport (no SMTP), and directly as the app role and the
 * restricted owner. Case 132 is the lead's rendered check. The pure rules are test/recruitment-candidate-email-rules.test.ts.
 * Careers-page receipts are not in this slice (D-064): a careers application queues nothing.
 *
 * The installation's ability to send is faked by mocking lib/recruitment-candidate-email-ipc (AUTH_PROVIDER=internal with an active relay
 * is not available in tests). Expected content is computed here by plain string replacement on the messages files, never with the
 * module's renderer; stored rows are read back with owner-connection SQL. Every person, company and address is fictional; names and
 * addresses carry the LETTER sentinel QZE.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const relay = vi.hoisted(() => ({ available: true }));
vi.mock('../lib/recruitment-candidate-email-ipc', async (original) => ({
  ...(await original<typeof import('../lib/recruitment-candidate-email-ipc')>()),
  candidateEmailAvailable: async () => relay.available,
  candidateEmailSender: async () => null,
}));
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { validManagedEmailSenderName } from '../lib/managed-email-policy';
import { todayInKualaLumpur } from '../lib/hr-date';
import { CandidateMailNotSent, type CandidateEmailSender, type CandidateMail } from '../lib/recruitment-candidate-email-ipc';
import {
  addApplication, addJobMember, applicationCandidateEmails, archiveSuggestedApplications, candidateEmailComposers, candidateEmailSettings, createJob,
  defaultSenderName, deliverCandidateEmails, jobFormOptions, recruitmentPipelineCounts, recruitmentSettings, rejectApplication, rejectionEmailPreviews,
  resetCandidateEmailTemplate, retryCandidateEmail, saveCandidateEmailSettings, saveCandidateEmailTemplate, saveWaitingRule, scheduleInterview,
  setCareersPublished, setJobCareersPage, submitCareersApplication, updateCareersSettings, RecruitmentError,
} from '../packs/recruitment/service';
import { closeCareersPool } from '../packs/recruitment/careers';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let otherCompanyId: string;
let gradeId: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
const constraintOf = async (operation: Promise<unknown>) => {
  const e = await operation.then(() => null, (x: unknown) => x);
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  return e === null ? 'ok' : pgSqlState(e) ?? 'unknown';
};
const rows = <T = Record<string, unknown>>(ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute<T & Record<string, unknown>>(query));
type Login = SessionContext & { userId: string };
async function login(name: string): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId: base.companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'QZE Fictional analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time',
  description: 'Fictional job description.', ...over,
});
const REPLY_TO = 'talent.qze@example.test';
const SENDER = 'QZE Talent team';
const HTML_OK = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p>QZE &amp; text<br>more</p></body></html>';
async function emailOn(locale = 'en') {
  await saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: REPLY_TO, senderName: SENDER, locale });
}
type EmailRow = { id: string; kind: string; status: string; locale: string; recipient: string | null; subject: string | null; body_text: string | null; body_html: string | null;
  sender_name: string; reply_to: string; queued_by_user_id: string | null; attempts: number; error_code: string | null; next_attempt_at: string; started_at: string | null;
  completed_at: string | null; content_purged_at: string | null; application_id: string; candidate_id: string; delay_seconds: number; lease_seconds: number | null };
const emails = (applicationId?: string) => owner.db.execute<EmailRow>(sql`select *, extract(epoch from next_attempt_at - queued_at)::int as delay_seconds,
  extract(epoch from lease_until - clock_timestamp())::int as lease_seconds
  from recruitment_candidate_email where tenant_id = ${base.tenantId}::uuid ${applicationId ? sql`and application_id = ${applicationId}::uuid` : sql``} order by queued_at, id`);
const messages = (locale: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8')) as { recruitment: { candidateEmail: { defaults: Record<string, { subject: string; body: string }> } } };
/** The expected text of a default, by plain replacement (independent of the renderer). */
const expected = (locale: string, kind: string, v: Record<string, string>) => {
  const d = messages(locale).recruitment.candidateEmail.defaults[kind];
  const fill = (s: string) => Object.entries(v).reduce((acc, [k, x]) => acc.split(`{${k}}`).join(x), s);
  return { subject: fill(d.subject), text: fill(d.body) };
};
const companyName = async () => (await owner.db.execute<{ name: string }>(sql`select legal_name as name from company where id = ${base.companyId}::uuid`))[0].name;

/** One job with a recruiter and a hiring manager; an interviewer; a bystander; the company's displayed reason. */
async function world() {
  const [recruiter, manager, interviewer, bystander] = await Promise.all([login('Fictional QZE Recruiter'), login('Fictional QZE Manager'),
    login('Fictional QZE Interviewer'), login('Fictional QZE Bystander')]);
  await jobFormOptions(admin, base.companyId);
  const { id: jobId } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
  await addJobMember(admin, jobId, 'hiring_manager', manager.userId);
  const reason = (await recruitmentSettings(admin, base.companyId)).reasons.find((r) => r.displayed)!;
  return { recruiter, manager, interviewer, bystander, jobId, reasonId: reason.id };
}
let seq = 0;
const add = async (ctx: SessionContext, jobId: string, over: Record<string, unknown> = {}) => {
  const n = ++seq;
  return addApplication(ctx, { jobId, fullName: `Fictional QZE Applicant ${n}`, email: `qze.applicant${n}@example.test`, ...over });
};
/** Reject one application with its rejection e-mail, as the dialog does: preview first, then submit the preview's fingerprint. */
async function rejectWithEmail(ctx: SessionContext, applicationId: string, reasonId: string, delayDays = '0') {
  const p = (await rejectionEmailPreviews(ctx, [applicationId]))[applicationId];
  return rejectApplication(ctx, applicationId, reasonId, { send: 'on', delayDays, fingerprint: p?.fingerprint || 'none' });
}
const sweepCtx = (): SessionContext => ({ tenantId: base.tenantId, roles: ['hr_admin'], entitlements: admin.entitlements });
function fakeSender(behaviour: (m: CandidateMail) => void | Promise<void> = () => {}) {
  const sent: CandidateMail[] = [];
  const sender: CandidateEmailSender = { revision: 'rev-fixture-1', host: 'hr.example.test', send: async (m) => { sent.push(m); await behaviour(m); } };
  return { sent, sender };
}
const deliver = (sender: CandidateEmailSender | null) => deliverCandidateEmails(sweepCtx(), owner, async () => sender);
/** Make queued or retrying e-mails due now (fixture time travel past the delay or backoff). */
const due = () => owner.db.execute(sql`update recruitment_candidate_email set next_attempt_at = now() - interval '1 second'
  where tenant_id = ${base.tenantId}::uuid and status in ('queued','retry')`);
/** Fixture changes past the triggers (immutable columns, author guards): owner connection, replica mode, this transaction only. */
const travel = (query: string, params: string[] = []) => owner.client.begin(async (tx) => {
  await tx`set local session_replication_role = replica`;
  await tx.unsafe(query, params);
});
const events = (type: string) => owner.db.execute<{ payload: Record<string, unknown>; actor_type: string; actor_id: string | null }>(sql`
  select payload, actor_type, actor_id from domain_event where tenant_id = ${base.tenantId}::uuid and event_type = ${type} order by sequence`);

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
beforeEach(async () => {
  relay.available = true;
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
});

describe('case 127 — administrators set the sender and the wording; placeholders allowlisted; off or no relay queues nothing', () => {
  it('only administrators change settings and templates, in the service and the database', async () => {
    const w = await world();
    expect(await code(saveCandidateEmailSettings(w.recruiter, base.companyId, { enabled: true, replyTo: REPLY_TO }))).toBe('forbidden');
    expect(await code(saveCandidateEmailTemplate(w.manager, { companyId: base.companyId, kind: 'rejection', locale: 'en', subject: 's', body: 'b' }))).toBe('forbidden');
    expect(await code(candidateEmailSettings(w.recruiter, base.companyId))).toBe('forbidden');
    expect(await code(rows(w.recruiter, sql`insert into recruitment_candidate_email_setting (company_id, tenant_id, enabled, reply_to, created_by_user_id, updated_by_user_id)
      values (${base.companyId}::uuid, ${base.tenantId}::uuid, true, ${REPLY_TO}, ${w.recruiter.userId}::uuid, ${w.recruiter.userId}::uuid)`))).toBe('42501');
    await emailOn();
    expect(await rows(w.recruiter, sql`update recruitment_candidate_email_setting set enabled = false returning 1`)).toHaveLength(0);
    expect(await code(rows(w.recruiter, sql`insert into recruitment_candidate_email_template (tenant_id, company_id, kind, locale, subject, body, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'rejection', 'en', 's', 'b', ${w.recruiter.userId}::uuid, ${w.recruiter.userId}::uuid)`))).toBe('42501');
    expect(await rows(w.manager, sql`select 1 from recruitment_candidate_email_setting`)).toHaveLength(1);
    expect(await rows(w.bystander, sql`select 1 from recruitment_candidate_email_setting`)).toHaveLength(0);
    const v = await candidateEmailSettings(admin, base.companyId);
    expect(v).toMatchObject({ available: true, enabled: true, senderName: SENDER, replyTo: REPLY_TO, locale: 'en', defaultSenderName: expect.any(String) });
    expect(v.templates).toHaveLength(12);
    // The reply-to is checked with the transport's own canonical rule.
    expect(await code(saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: 'Talent <talent@example.test>' }))).toBe('invalid_input');
    expect(await code(saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: 'qzé@example.test' }))).toBe('invalid_input');
  });

  it('refuses unknown placeholders, link-like text and too-long wording on save (service and database); a reset returns to the default', async () => {
    await emailOn();
    const save = (subject: string, body: string) => code(saveCandidateEmailTemplate(admin, { companyId: base.companyId, kind: 'rejection', locale: 'en', subject, body }));
    expect(await save('About {salary}', 'Dear {candidateName}')).toBe('email_placeholder');
    expect(await save('About {jobTitle}', 'See https://fictional.example.test')).toBe('email_link');
    expect(await save('About {jobTitle}', 'Write to evil.example/x')).toBe('email_link');
    expect(await save('{candidateName}'.repeat(5) + 'x', 'Dear {candidateName}')).toBe('email_too_long');
    const insert = (subject: string, body: string) => constraintOf(rows(admin, sql`insert into recruitment_candidate_email_template (tenant_id, company_id, kind, locale,
      subject, body, created_by_user_id, updated_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'rejection', 'en', ${subject}, ${body}, ${admin.userId}::uuid, ${admin.userId}::uuid)`));
    expect(await insert('Hi {salary}', 'b')).toBe('recruitment_candidate_email_template_placeholders');
    for (const linky of ['www.fictional.example.test', 'mailto:x', 'evil.example/x', 'www。example', 'xn--fiq228c']) {
      expect(await insert('s', linky), linky).toBe('recruitment_candidate_email_template_no_links_ck');
    }
    expect(await save('QZE about {jobTitle}', 'Dear {candidateName},\n\nQZE custom wording from {senderName}.')).toBe('ok');
    const c = (await candidateEmailComposers(admin, [base.companyId], 'rejection'))[base.companyId];
    expect(c).toMatchObject({ custom: true, template: { subject: 'QZE about {jobTitle}' }, senderName: SENDER, replyTo: REPLY_TO, locale: 'en' });
    await resetCandidateEmailTemplate(admin, { companyId: base.companyId, kind: 'rejection', locale: 'en' });
    const d = (await candidateEmailComposers(admin, [base.companyId], 'rejection'))[base.companyId];
    expect(d.custom).toBe(false);
    expect(d.template).toEqual(messages('en').recruitment.candidateEmail.defaults.rejection);
    expect(d.fingerprint).not.toBe(c.fingerprint);
  });

  it('switch off, or an installation that cannot send, queues nothing; the database refuses a row while the switch is off', async () => {
    const w = await world();
    const a = await add(w.recruiter, w.jobId);
    expect(await rejectionEmailPreviews(w.manager, [a.applicationId])).toEqual({});
    // A tick posted while the company's switch is off refuses the whole reject, with or without a fingerprint.
    expect(await code(rejectApplication(w.manager, a.applicationId, w.reasonId, { send: 'on' }))).toBe('email_off');
    expect(await code(rejectApplication(w.manager, a.applicationId, w.reasonId, { send: 'on', fingerprint: 'stale' }))).toBe('email_off');
    expect((await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id = ${a.applicationId}::uuid`))[0].state).toBe('active');
    relay.available = false;
    expect(await code(saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: REPLY_TO }))).toBe('email_unavailable');
    expect((await candidateEmailSettings(admin, base.companyId)).available).toBe(false);
    relay.available = true;
    await emailOn();
    relay.available = false;
    expect(await rejectionEmailPreviews(admin, [a.applicationId])).toEqual({});
    expect(await code(add(w.recruiter, w.jobId, { sendReceipt: 'on' }))).toBe('email_unavailable');
    relay.available = true;
    await saveCandidateEmailSettings(admin, base.companyId, { enabled: false, replyTo: REPLY_TO, senderName: SENDER });
    // Directly in the archiving transaction (the state is right): the switch is off, so the database refuses.
    const [cand] = await owner.db.execute<{ candidate_id: string; email: string }>(sql`select a.candidate_id, c.email from recruitment_application a
      join recruitment_candidate c on c.id = a.candidate_id where a.id = ${a.applicationId}::uuid`);
    expect(await constraintOf(withTenant(admin, async (tx) => {
      await tx.execute(sql`update recruitment_application set state = 'archived', archive_reason_id = ${w.reasonId}::uuid, stage_left_at_archive = current_stage_id
        where id = ${a.applicationId}::uuid`);
      await tx.execute(sql`insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient,
        subject, body_text, body_html, sender_name, reply_to, queued_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${w.jobId}::uuid, ${a.applicationId}::uuid,
        ${cand.candidate_id}::uuid, 'rejection', 'en', ${cand.email}, 's', 't', ${HTML_OK}, ${SENDER}, ${REPLY_TO}, ${admin.userId}::uuid)`);
    }))).toBe('recruitment_candidate_email_settings');
    expect(await emails()).toHaveLength(0);
  });
});

describe('case 128 — receipts: none for careers applications (D-064); HR-added only when ticked; imports never', () => {
  const ADDRESS = 'fictional-qze-careers';
  const hashOf = (label: string) => createHash('sha256').update(`fictional-client:${label}`).digest('hex');

  it('a careers application queues nothing, even with candidate e-mail on; no careers receipt path exists', async () => {
    await emailOn();
    await updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional QZE Careers', headline: 'h', introduction: 'i', notice: 'Fictional notice.' });
    await setCareersPublished(admin, base.companyId, true);
    await jobFormOptions(admin, base.companyId);
    const { id: jobId } = await createJob(admin, job());
    await setJobCareersPage(admin, jobId, true);
    expect(await submitCareersApplication({ address: ADDRESS, jobId, fullName: 'Fictional QZE Visitor', email: 'qze.visitor@example.test', mobile: '', message: '',
      consent: 'on', noticeVersion: '1', website: '', resume: null, clientHash: () => hashOf('qze'), currentNoticeVersion: 1 })).toEqual({ ok: true, outcome: 'received' });
    expect(await owner.db.execute(sql`select 1 from recruitment_candidate where tenant_id = ${base.tenantId}::uuid and email = 'qze.visitor@example.test'`)).toHaveLength(1);
    expect(await emails()).toHaveLength(0);
    expect(await owner.db.execute(sql`select 1 from pg_proc where proname like 'recruitment_careers_receipt%'`)).toEqual([]);
    expect(await owner.db.execute(sql`select 1 from pg_trigger where tgrelid = 'public.recruitment_careers_application'::regclass and not tgisinternal
      and tgname like '%receipt%'`)).toEqual([]);
  });

  it('HR-added candidates get a receipt only when ticked; none without a usable address; one per application; only with its application', async () => {
    const w = await world();
    await emailOn('ms');
    const plain = await add(w.recruiter, w.jobId);
    expect(plain.receipt).toBeUndefined();
    const ticked = await add(w.recruiter, w.jobId, { sendReceipt: 'on', fullName: 'Fictional QZE Aminah', email: 'qze.aminah@example.test' });
    expect(ticked.receipt).toBe('queued');
    const noMail = await add(w.recruiter, w.jobId, { email: '', sendReceipt: 'on' });
    expect(noMail.receipt).toBe('no_email');
    const got = await emails();
    expect(got.map((e) => [e.application_id, e.kind, e.queued_by_user_id])).toEqual([[ticked.applicationId, 'application_received', w.recruiter.userId]]);
    const want = expected('ms', 'application_received', { candidateName: 'Fictional QZE Aminah', jobTitle: 'QZE Fictional analyst', companyName: await companyName(), senderName: SENDER });
    expect(got[0]).toMatchObject({ locale: 'ms', recipient: 'qze.aminah@example.test', subject: want.subject, body_text: want.text, sender_name: SENDER, reply_to: REPLY_TO });
    // At most one receipt per application.
    expect(await code(owner.db.execute(sql`insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject,
      body_text, body_html, sender_name, reply_to, queued_by_user_id) select tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text,
      body_html, sender_name, reply_to, queued_by_user_id from recruitment_candidate_email where id = ${got[0].id}::uuid`))).toBe('23505');
    // A receipt for an application created earlier (an import's, or anyone's) is refused by the database.
    const [cand] = await owner.db.execute<{ candidate_id: string; email: string }>(sql`select a.candidate_id, c.email from recruitment_application a
      join recruitment_candidate c on c.id = a.candidate_id where a.id = ${plain.applicationId}::uuid`);
    expect(await constraintOf(rows(w.recruiter, sql`insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient,
      subject, body_text, body_html, sender_name, reply_to, queued_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${w.jobId}::uuid, ${plain.applicationId}::uuid,
      ${cand.candidate_id}::uuid, 'application_received', 'ms', ${cand.email}, 's', 't', ${HTML_OK}, ${SENDER}, ${REPLY_TO}, ${w.recruiter.userId}::uuid)`)))
      .toBe('recruitment_candidate_email_state');
  });

  it('imports never send: the import path does not reach the queue', () => {
    const src = readFileSync(fileURLToPath(new URL('../packs/recruitment/import.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/candidate-email|queueCandidateEmails|sendReceipt/);
    expect(src).toMatch(/insertApplicationTx|recruitment_application/);
  });
});

describe('case 129 — rejection e-mails: only when ticked, after a preview identical to what is sent; bulk; delay; removal', () => {
  it('nothing without the tick; the queued content is exactly the preview; the delay is honoured; a changed preview is refused', async () => {
    const w = await world();
    await emailOn();
    const a1 = await add(w.recruiter, w.jobId, { fullName: 'Fictional QZE Bala', email: 'qze.bala@example.test' });
    const a2 = await add(w.recruiter, w.jobId, { fullName: 'Fictional QZE Chen', email: 'qze.chen@example.test' });
    const a3 = await add(w.recruiter, w.jobId, { fullName: 'Fictional QZE Devi', email: '' });
    const a4 = await add(w.recruiter, w.jobId, { fullName: 'Fictional QZE Elan', email: 'qze.elan@example.test' });
    const a5 = await add(w.recruiter, w.jobId, { fullName: 'Fictional QZE Farah', email: 'qze.farah@example.test' });
    expect(await rejectApplication(w.manager, a1.applicationId, w.reasonId)).toEqual({ email: null });
    expect(await emails()).toHaveLength(0);
    // The dialog's preview, then the tick with a two-day delay.
    const p = (await rejectionEmailPreviews(w.manager, [a2.applicationId]))[a2.applicationId];
    const want = expected('en', 'rejection', { candidateName: 'Fictional QZE Chen', jobTitle: 'QZE Fictional analyst', companyName: await companyName(), senderName: SENDER });
    expect({ subject: p.subject, text: p.text, recipient: p.recipient, blocked: p.blocked }).toEqual({ ...want, recipient: 'qze.chen@example.test', blocked: null });
    expect(await rejectApplication(w.manager, a2.applicationId, w.reasonId, { send: 'on', delayDays: '2', fingerprint: p.fingerprint })).toEqual({ email: 'queued' });
    const [row] = await emails(a2.applicationId);
    expect(row).toMatchObject({ kind: 'rejection', recipient: 'qze.chen@example.test', subject: p.subject, body_text: p.text, sender_name: SENDER, reply_to: REPLY_TO,
      queued_by_user_id: w.manager.userId, status: 'queued' });
    expect(row.delay_seconds).toBe(2 * 86400);
    const f = fakeSender();
    expect((await deliver(f.sender)).claimed).toBe(0);
    expect(f.sent).toHaveLength(0);
    // No address: rejected, nothing queued, the person is told.
    expect((await rejectionEmailPreviews(w.manager, [a3.applicationId]))[a3.applicationId]).toMatchObject({ blocked: 'no_address', recipient: null });
    expect(await rejectWithEmail(w.manager, a3.applicationId, w.reasonId)).toEqual({ email: 'no_email' });
    // The preview changed before submit — the wording, or the candidate's name: refused whole, the application stays active.
    const p4 = (await rejectionEmailPreviews(w.manager, [a4.applicationId]))[a4.applicationId];
    await saveCandidateEmailTemplate(admin, { companyId: base.companyId, kind: 'rejection', locale: 'en', subject: 'QZE new {jobTitle}', body: 'Dear {candidateName}' });
    expect(await code(rejectApplication(w.manager, a4.applicationId, w.reasonId, { send: 'on', fingerprint: p4.fingerprint }))).toBe('email_changed');
    const p5 = (await rejectionEmailPreviews(w.manager, [a5.applicationId]))[a5.applicationId];
    await travel(`update recruitment_candidate set full_name = 'Fictional QZE Farah Renamed' where id = $1::uuid`, [a5.candidateId]);
    expect(await code(rejectApplication(w.manager, a5.applicationId, w.reasonId, { send: 'on', fingerprint: p5.fingerprint }))).toBe('email_changed');
    expect((await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id in (${a4.applicationId}::uuid, ${a5.applicationId}::uuid)`))
      .map((r) => r.state)).toEqual(['active', 'active']);
    expect(await code(rejectApplication(w.manager, a4.applicationId, w.reasonId, { send: 'on', delayDays: '7', fingerprint: 'x' }))).toBe('invalid_input');
    // A tick with no preview shown for it: rejected, the e-mail skipped (not previewed), never sent.
    expect(await rejectApplication(w.manager, a5.applicationId, w.reasonId, { send: 'on' })).toEqual({ email: 'not_previewed' });
    expect((await emails()).map((e) => e.application_id)).toEqual([a2.applicationId]);
  });

  it('a non-canonical recorded address is no usable address; a link-like name refuses the send; the database holds frozen content to the renderer', async () => {
    const w = await world();
    await emailOn();
    const odd = await add(w.recruiter, w.jobId, { fullName: 'Fictional QZE Odd' });
    await travel(`update recruitment_candidate set email = 'qzé.odd@example.test' where id = $1::uuid`, [odd.candidateId]);
    expect((await rejectionEmailPreviews(w.manager, [odd.applicationId]))[odd.applicationId]).toMatchObject({ blocked: 'no_address', recipient: null });
    expect(await rejectWithEmail(w.manager, odd.applicationId, w.reasonId)).toEqual({ email: 'no_email' });
    const linky = await add(w.recruiter, w.jobId, { fullName: 'Fictional QZE www.example' });
    const p = (await rejectionEmailPreviews(w.manager, [linky.applicationId]))[linky.applicationId];
    expect(p.blocked).toBe('value_link');
    // Skipped with its reason; the reject itself goes through.
    expect(await rejectApplication(w.manager, linky.applicationId, w.reasonId, { send: 'on', fingerprint: p.fingerprint })).toEqual({ email: 'value_link' });
    expect((await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id = ${linky.applicationId}::uuid`))[0].state).toBe('archived');
    expect(await emails(linky.applicationId)).toEqual([]);
    // Ordinary dotted names and titles are not link-like.
    const dotted = await add(w.recruiter, w.jobId, { fullName: 'S.Kumar Mohd.Ali Dr.Tan Wei' });
    expect((await rejectionEmailPreviews(w.manager, [dotted.applicationId]))[dotted.applicationId].blocked).toBeNull();
    expect(await rejectWithEmail(w.manager, dotted.applicationId, w.reasonId)).toEqual({ email: 'queued' });
    // A queued rejection, then the frozen-content CHECKs, one rejection per application, and "only in the archiving transaction".
    const ok = await add(w.recruiter, w.jobId);
    await rejectWithEmail(w.manager, ok.applicationId, w.reasonId);
    const [row] = await emails(ok.applicationId);
    const copy = (over: { subject?: string; text?: string; html?: string; kind?: string }) => owner.db.execute(sql`insert into recruitment_candidate_email (tenant_id, company_id,
      job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html, sender_name, reply_to, queued_by_user_id)
      select tenant_id, company_id, job_id, application_id, candidate_id, ${over.kind ?? 'application_received'}, locale, recipient, ${over.subject ?? 'QZE'}, ${over.text ?? 'QZE text'},
        ${over.html ?? HTML_OK}, sender_name, reply_to, queued_by_user_id from recruitment_candidate_email where id = ${row.id}::uuid`);
    expect(await constraintOf(copy({ subject: 'Open evil.example/x' }))).toBe('recruitment_candidate_email_subject_check');
    expect(await constraintOf(copy({ text: 'mailto:someone' }))).toBe('recruitment_candidate_email_body_text_check');
    for (const html of ['<p>no wrapper</p>', HTML_OK.replace('<p>', '<p><a href="https://x">'), HTML_OK.replace('&amp;', '&nbsp;'), HTML_OK.replace('<br>', '<img src=x>')]) {
      expect(await constraintOf(copy({ html })), html).toBe('recruitment_candidate_email_body_html_check');
    }
    expect(await code(copy({ kind: 'rejection' }))).toBe('23505');
    const later = await add(w.recruiter, w.jobId);
    await rejectApplication(w.manager, later.applicationId, w.reasonId);
    const [cand] = await owner.db.execute<{ email: string }>(sql`select email from recruitment_candidate where id = ${later.candidateId}::uuid`);
    expect(await constraintOf(rows(w.manager, sql`insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient,
      subject, body_text, body_html, sender_name, reply_to, queued_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${w.jobId}::uuid, ${later.applicationId}::uuid,
      ${later.candidateId}::uuid, 'rejection', 'en', ${cand.email}, 's', 't', ${HTML_OK}, ${SENDER}, ${REPLY_TO}, ${w.manager.userId}::uuid)`)))
      .toBe('recruitment_candidate_email_state');
  });

  it('bulk archive queues one e-mail per application actually archived; candidates without a usable address are skipped and counted', async () => {
    const w = await world();
    await emailOn();
    const stages = (await recruitmentSettings(admin, base.companyId)).stages;
    const first = stages.find((s) => s.name === 'Application Review')!.id;
    await saveWaitingRule(admin, { companyId: base.companyId, stageId: first, remindDays: '1', archiveDays: '2', dayKind: 'calendar' });
    const apps = await Promise.all([add(w.recruiter, w.jobId), add(w.recruiter, w.jobId), add(w.recruiter, w.jobId, { email: '' }), add(w.recruiter, w.jobId),
      add(w.recruiter, w.jobId, { fullName: 'Fictional QZE www.example' }), add(w.recruiter, w.jobId)]);
    const aged = [apps[0], apps[1], apps[2], apps[4], apps[5]];
    const back = (d: number) => { const x = new Date(`${todayInKualaLumpur()}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - d); return x.toISOString().slice(0, 10); };
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const a of aged) {
        await tx`update recruitment_application set applied_at = ${`${back(10)}T09:00:00+08:00`}::timestamptz, updated_at = ${`${back(10)}T09:00:00+08:00`}::timestamptz where id = ${a.applicationId}::uuid`;
        await tx`update recruitment_application_event set occurred_at = ${`${back(10)}T09:00:00+08:00`}::timestamptz where application_id = ${a.applicationId}::uuid`;
      }
    });
    const previews = await rejectionEmailPreviews(w.recruiter, apps.map((a) => a.applicationId));
    expect(Object.keys(previews)).toHaveLength(6);
    expect(previews[apps[4].applicationId].blocked).toBe('value_link');
    // As the page posts them: a fingerprint only for rows that can be e-mailed — and here the last row's preview was not shown.
    const fingerprints = Object.fromEntries(Object.entries(previews).filter(([id, p]) => p.blocked === null && id !== apps[5].applicationId).map(([id, p]) => [id, p.fingerprint]));
    const result = await archiveSuggestedApplications(w.recruiter, { jobId: w.jobId, applicationIds: apps.map((a) => a.applicationId), archiveReasonId: w.reasonId,
      email: { send: 'on', delayDays: '1', fingerprints } });
    expect(result.archived.sort()).toEqual(aged.map((a) => a.applicationId).sort());
    expect(result.refused).toEqual([{ applicationId: apps[3].applicationId, code: 'not_suggested' }]);
    expect(result).toMatchObject({ emailQueued: 2, emailNoAddress: 1, emailValueLink: 1, emailNotPreviewed: 1 });
    const got = await emails();
    expect(got.map((e) => e.application_id).sort()).toEqual([apps[0].applicationId, apps[1].applicationId].sort());
    expect(got.every((e) => e.kind === 'rejection' && e.delay_seconds === 86400 && e.queued_by_user_id === w.recruiter.userId)).toBe(true);
    expect(await events('recruitment-candidate-email.queued')).toHaveLength(2);
    // The set was checked once, by a statement-level trigger.
    const [trig] = await owner.db.execute<{ statement: boolean }>(sql`select (tgtype & 1) = 0 as statement from pg_trigger
      where tgname = 'recruitment_candidate_email_queue_check'`);
    expect(trig.statement).toBe(true);
  });

  it('one bad row refuses the whole multi-row insert (the set is checked once per statement)', async () => {
    const w = await world();
    await emailOn();
    const [early, now] = [await add(w.recruiter, w.jobId), await add(w.recruiter, w.jobId)];
    await rejectApplication(admin, early.applicationId, w.reasonId);
    const outcome = await constraintOf(withTenant(admin, async (tx) => {
      await tx.execute(sql`update recruitment_application set state = 'archived', archive_reason_id = ${w.reasonId}::uuid, stage_left_at_archive = current_stage_id
        where id = ${now.applicationId}::uuid`);
      await tx.execute(sql`insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text,
        body_html, sender_name, reply_to, queued_by_user_id)
        select a.tenant_id, a.company_id, a.job_id, a.id, a.candidate_id, 'rejection', 'en', c.email, 'QZE s', 'QZE t', ${HTML_OK}, ${SENDER}, ${REPLY_TO}, ${admin.userId}::uuid
        from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id where a.id in (${early.applicationId}::uuid, ${now.applicationId}::uuid)`);
    }));
    expect(outcome).toBe('recruitment_candidate_email_state');
    expect(await emails()).toEqual([]);
  });

  it('removing the candidate deletes their e-mails, queued or sent', async () => {
    const w = await world();
    await emailOn();
    const a = await add(w.recruiter, w.jobId, { sendReceipt: 'on' });
    await rejectWithEmail(admin, a.applicationId, w.reasonId, '3');
    expect(await emails(a.applicationId)).toHaveLength(2);
    const [{ counts }] = await withTenant(adminCtx(base), (tx) => tx.execute<{ counts: Record<string, number> }>(sql`select app.recruitment_destroy_candidate(${a.candidateId}::uuid) as counts`));
    expect(counts).toMatchObject({ candidateEmails: 2, applications: 1 });
    expect(await emails(a.applicationId)).toEqual([]);
  });
});

describe('case 130 — the sweep sends the frozen content to the frozen address through a faked transport', () => {
  async function queued(n = 1) {
    const w = await world();
    await emailOn();
    const apps = [];
    for (let i = 0; i < n; i++) apps.push(await add(w.recruiter, w.jobId, { sendReceipt: 'on' }));
    return { w, apps };
  }

  it('sent: exactly the frozen row, a deterministic Message-ID, start before finish; an event without address or content', async () => {
    const { apps } = await queued();
    const [before] = await emails(apps[0].applicationId);
    const f = fakeSender();
    expect(await deliver(f.sender)).toMatchObject({ claimed: 1, sent: 1, failed: 0, uncertain: 0 });
    expect(f.sent).toEqual([{ to: before.recipient, subject: before.subject, text: before.body_text, html: before.body_html, senderName: SENDER, replyTo: REPLY_TO,
      messageId: `<recruitment-candidate-email.${before.id}@hr.example.test>` }]);
    const [after] = await emails(apps[0].applicationId);
    expect(after).toMatchObject({ status: 'sent', attempts: 1, error_code: null });
    expect(new Date(after.started_at!).getTime()).toBeLessThanOrEqual(new Date(after.completed_at!).getTime());
    const sent = await events('recruitment-candidate-email.sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ emailId: before.id, kind: 'application_received' });
    expect(JSON.stringify(await owner.db.execute(sql`select payload from domain_event where tenant_id = ${base.tenantId}::uuid and event_type like 'recruitment-candidate-email.%'`)))
      .not.toMatch(/qze|@example\.test/i);
    expect((await deliver(f.sender)).claimed).toBe(0);
    expect((await candidateEmailSettings(admin, base.companyId)).counts).toEqual({ queued: 0, sending: 0, sent: 1, failed: 0, uncertain: 0 });
  });

  it('4xx retries with backoff up to five attempts, 5xx fails, anything else is uncertain and never replayed; before a connection it fails with its own code', async () => {
    const { apps } = await queued(4);
    const ids = await emails();
    const behaviour = new Map<string, unknown>([[ids[0].recipient!, Object.assign(new Error('busy'), { responseCode: 451 })],
      [ids[1].recipient!, Object.assign(new Error('no such user'), { responseCode: 550 })], [ids[2].recipient!, new Error('socket closed')],
      [ids[3].recipient!, new CandidateMailNotSent('invalidMessage')]]);
    const f = fakeSender((m) => { throw behaviour.get(m.to); });
    expect(await deliver(f.sender)).toMatchObject({ claimed: 4, retry: 1, failed: 2, uncertain: 1 });
    const after = new Map((await emails()).map((e) => [e.application_id, e]));
    expect(after.get(apps[0].applicationId)).toMatchObject({ status: 'retry', attempts: 1, error_code: 'smtpTemporary', started_at: null, completed_at: null });
    expect(after.get(apps[1].applicationId)).toMatchObject({ status: 'failed', error_code: 'smtpRejected' });
    expect(after.get(apps[2].applicationId)).toMatchObject({ status: 'uncertain', error_code: 'uncertain' });
    expect(after.get(apps[3].applicationId)).toMatchObject({ status: 'failed', error_code: 'invalidMessage' });
    const [backoff] = await owner.db.execute<{ s: number }>(sql`select extract(epoch from next_attempt_at - now())::int as s from recruitment_candidate_email
      where application_id = ${apps[0].applicationId}::uuid`);
    expect(backoff.s).toBeGreaterThan(100);
    expect(backoff.s).toBeLessThanOrEqual(120);
    for (let i = 0; i < 4; i++) { await due(); await deliver(f.sender); }
    const sentTo = f.sent.map((m) => m.to);
    expect(sentTo.filter((t) => t === ids[0].recipient)).toHaveLength(5);
    expect(sentTo.filter((t) => t === ids[1].recipient)).toHaveLength(1);
    expect(sentTo.filter((t) => t === ids[2].recipient)).toHaveLength(1);
    expect(sentTo.filter((t) => t === ids[3].recipient)).toHaveLength(1);
    expect((await emails(apps[0].applicationId))[0]).toMatchObject({ status: 'failed', attempts: 5, error_code: 'smtpTemporary' });
  });

  it('the start extends the lease over the send, so an overlapping sweep never turns an in-flight send uncertain', async () => {
    await queued(1);
    const [claim] = await owner.withTenant(sweepCtx(), (tx) => tx.execute<{ email_id: string; token: string }>(sql`select * from app.recruitment_candidate_email_claim(1)`));
    const [leased] = await emails();
    expect(leased.lease_seconds).toBeLessThanOrEqual(180);
    await owner.withTenant(sweepCtx(), (tx) => tx.execute(sql`select app.recruitment_candidate_email_start(${claim.email_id}::uuid, ${claim.token}::uuid, 'rev-fixture-1')`));
    const [started] = await emails();
    expect(started.status).toBe('sending');
    expect(started.lease_seconds).toBeGreaterThanOrEqual(290);
    // Another sweep claims in the meantime (past the claim's own 3-minute lease would have been "expired" without the extension).
    await travel(`update recruitment_candidate_email set lease_until = clock_timestamp() + interval '2 minutes' where id = $1::uuid`, [claim.email_id]);
    expect((await deliver(fakeSender().sender)).claimed).toBe(0);
    expect((await emails())[0].status).toBe('sending');
    expect(await owner.withTenant(sweepCtx(), (tx) => tx.execute(sql`select app.recruitment_candidate_email_finish(${claim.email_id}::uuid, ${claim.token}::uuid, 'sent', null) as r`)))
      .toEqual([{ r: true }]);
  });

  it('an expired started lease becomes uncertain; an unavailable relay holds, then fails after 7 days; a changed address or a switched-off company is not eligible', async () => {
    const { w } = await queued(4);
    const [claim] = await owner.withTenant(sweepCtx(), (tx) => tx.execute<{ email_id: string; token: string }>(sql`select * from app.recruitment_candidate_email_claim(1)`));
    await owner.withTenant(sweepCtx(), (tx) => tx.execute(sql`select app.recruitment_candidate_email_start(${claim.email_id}::uuid, ${claim.token}::uuid, 'rev-fixture-1')`));
    await owner.db.execute(sql`update recruitment_candidate_email set lease_until = now() - interval '1 second' where id = ${claim.email_id}::uuid`);
    expect(await deliver(null)).toMatchObject({ claimed: 3, held: 3 });
    const rowsNow = await emails();
    expect(rowsNow.find((e) => e.id === claim.email_id)).toMatchObject({ status: 'uncertain', error_code: 'uncertain' });
    const held = rowsNow.filter((e) => e.id !== claim.email_id);
    expect(held.every((e) => e.status === 'queued' && e.attempts === 0 && e.error_code === 'relayUnavailable')).toBe(true);
    expect(await events('recruitment-candidate-email.uncertain')).toHaveLength(1);
    // One held for more than 7 days fails as relay unavailable (final, so the purge applies).
    await travel(`update recruitment_candidate_email set queued_at = now() - interval '8 days' where id = $1::uuid`, [held[0].id]);
    await due();
    expect(await deliver(null)).toMatchObject({ claimed: 3 });
    expect((await emails()).find((e) => e.id === held[0].id)).toMatchObject({ status: 'failed', error_code: 'relayUnavailable' });
    // The candidate's address changed after queueing: not sent (not eligible). Then the company switched off: not sent either.
    const changed = held.find((e) => e.id !== held[0].id)!;
    await travel(`update recruitment_candidate set email = 'qze.changed@example.test' where id = $1::uuid`, [changed.candidate_id]);
    await due();
    const f = fakeSender();
    expect(await deliver(f.sender)).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
    expect((await emails()).find((e) => e.id === changed.id)).toMatchObject({ status: 'failed', error_code: 'notEligible' });
    expect(f.sent.map((m) => m.to)).not.toContain('qze.changed@example.test');
    const extra = await add(admin, w.jobId, { sendReceipt: 'on' });
    await saveCandidateEmailSettings(admin, base.companyId, { enabled: false, replyTo: REPLY_TO, senderName: SENDER });
    const g = fakeSender();
    expect(await deliver(g.sender)).toMatchObject({ claimed: 1, failed: 1 });
    expect(g.sent).toHaveLength(0);
    expect((await emails(extra.applicationId))[0]).toMatchObject({ status: 'failed', error_code: 'notEligible' });
  });

  it('an administrator retries a failed or uncertain e-mail only with the possible-duplicate acknowledgement', async () => {
    const { w, apps } = await queued(1);
    await deliver(fakeSender(() => { throw new Error('socket closed'); }).sender);
    const [row] = await emails(apps[0].applicationId);
    expect(row.status).toBe('uncertain');
    expect(await code(retryCandidateEmail(admin, { emailId: row.id }))).toBe('confirm_required');
    expect(await code(retryCandidateEmail(w.recruiter, { emailId: row.id, acknowledged: 'on' }))).toBe('forbidden');
    expect(await rows(w.recruiter, sql`update recruitment_candidate_email set status = 'queued', retried_by_user_id = ${w.recruiter.userId}::uuid where id = ${row.id}::uuid returning 1`)).toHaveLength(0);
    expect(await constraintOf(rows(admin, sql`update recruitment_candidate_email set status = 'sent', retried_by_user_id = ${admin.userId}::uuid where id = ${row.id}::uuid`)))
      .toBe('recruitment_candidate_email_retry');
    expect(await code(rows(admin, sql`update recruitment_candidate_email set recipient = 'qze.other@example.test' where id = ${row.id}::uuid`))).toBe('23514');
    await retryCandidateEmail(admin, { emailId: row.id, acknowledged: 'on' });
    expect((await emails(apps[0].applicationId))[0]).toMatchObject({ status: 'queued', attempts: 0, error_code: null, started_at: null });
    expect(await events('recruitment-candidate-email.retried')).toEqual([expect.objectContaining({ actor_id: admin.userId,
      payload: expect.objectContaining({ emailId: row.id, from: 'uncertain', duplicateAcknowledged: true }) })]);
    const g = fakeSender();
    expect(await deliver(g.sender)).toMatchObject({ sent: 1 });
    expect(g.sent[0].messageId).toBe(`<recruitment-candidate-email.${row.id}@hr.example.test>`);
    expect(await code(retryCandidateEmail(admin, { emailId: row.id, acknowledged: 'on' }))).toBe('email_not_retryable');
  });

  it('concurrent sweeps never send one e-mail twice', async () => {
    await queued(6);
    const f = fakeSender(() => new Promise((r) => setTimeout(r, 15)));
    const [x, y] = await Promise.all([deliver(f.sender), deliver(f.sender)]);
    expect(x.claimed + y.claimed).toBe(6);
    expect(f.sent).toHaveLength(6);
    expect(new Set(f.sent.map((m) => m.messageId)).size).toBe(6);
    expect((await emails()).every((e) => e.status === 'sent' && e.attempts === 1)).toBe(true);
  });

  it('purges the address and content 90 days after the final state and keeps the metadata', async () => {
    const { apps } = await queued(2);
    await deliver(fakeSender().sender);
    const [a, b] = await emails();
    await owner.db.execute(sql`update recruitment_candidate_email set completed_at = now() - interval '91 days' where id = ${a.id}::uuid`);
    expect((await deliver(fakeSender().sender)).purged).toBe(1);
    const after = new Map((await emails()).map((e) => [e.id, e]));
    expect(after.get(a.id)).toMatchObject({ recipient: null, subject: null, body_text: null, body_html: null, status: 'sent', kind: 'application_received' });
    expect(after.get(a.id)!.content_purged_at).not.toBeNull();
    expect(after.get(b.id)).toMatchObject({ content_purged_at: null, recipient: b.recipient });
    const list = await applicationCandidateEmails(admin, apps[0].applicationId);
    expect(list!.rows).toEqual([expect.objectContaining({ purged: true, recipient: null, subject: null, text: null, retryable: false, state: 'sent' })]);
  });
});

describe('case 131 — who reads e-mails; the AI Centre sees counts only; the hourly cap holds', () => {
  it('the job\'s reviewers read the e-mails and their content; interviewers and others read nothing', async () => {
    const w = await world();
    await emailOn();
    const a = await add(w.recruiter, w.jobId, { sendReceipt: 'on' });
    await scheduleInterview(w.recruiter, { applicationId: a.applicationId, type: 'video', startsAt: new Date(Date.now() + 86_400_000), interviewerIds: [w.interviewer.userId] });
    const mine = await applicationCandidateEmails(w.manager, a.applicationId);
    expect(mine).toMatchObject({ canRetry: false, rows: [expect.objectContaining({ kind: 'application_received', state: 'queued', queuedBy: 'Fictional QZE Recruiter',
      recipient: expect.stringMatching(/^qze\.applicant\d+@example\.test$/), subject: expect.any(String), text: expect.any(String) })] });
    expect((await applicationCandidateEmails(admin, a.applicationId))!.canRetry).toBe(true);
    expect(await applicationCandidateEmails(w.interviewer, a.applicationId)).toBeNull();
    expect(await code(applicationCandidateEmails(w.bystander, a.applicationId))).toBe('not_found');
    for (const who of [w.interviewer, w.bystander]) expect(await rows(who, sql`select 1 from recruitment_candidate_email`)).toHaveLength(0);
    expect(await rows(w.manager, sql`select 1 from recruitment_candidate_email`)).toHaveLength(1);
    expect(await rejectionEmailPreviews(w.interviewer, [a.applicationId])).toEqual({});
    const counts = await recruitmentPipelineCounts(admin);
    const COUNT_KEYS = ['activeApplications', 'archived', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen'];
    expect(counts.rows.length).toBeGreaterThan(0);
    for (const row of counts.rows) expect(Object.keys(row).sort()).toEqual(['company', ...COUNT_KEYS].sort());
    expect(JSON.stringify(counts)).not.toMatch(/qze|@example\.test|subject|e-?mail/i);
  });

  it('refuses above 500 queued e-mails per company per hour, race-safely', async () => {
    const w = await world();
    await emailOn();
    const filler = await add(w.recruiter, w.jobId);
    // 498 e-mails of other (fixture) applications in the last hour, written past the triggers.
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_candidate (id, tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional QZE Filler', ${admin.userId!}::uuid, ${admin.userId!}::uuid
        from generate_series(1, 498) g`;
      await tx`insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, a.tenant_id, a.company_id, a.job_id, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
          a.current_stage_id, ${admin.userId!}::uuid, ${admin.userId!}::uuid
        from recruitment_application a, generate_series(1, 498) g where a.id = ${filler.applicationId}::uuid`;
      await tx`insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
        sender_name, reply_to, queued_by_user_id)
        select tenant_id, company_id, job_id, id, candidate_id, 'rejection', 'en', 'qze.filler@example.test', 's', 't', ${HTML_OK}, ${SENDER}, ${REPLY_TO}, ${admin.userId!}::uuid
        from recruitment_application where id::text like '00000000-0000-4000-9000-%'`;
    });
    const [x, y, z] = [await add(w.recruiter, w.jobId), await add(w.recruiter, w.jobId), await add(w.recruiter, w.jobId)];
    await rejectWithEmail(admin, x.applicationId, w.reasonId);
    expect((await emails()).length).toBe(499);
    const previews = await rejectionEmailPreviews(w.manager, [y.applicationId, z.applicationId]);
    const results = await Promise.all([y, z].map((a) => code(rejectApplication(w.manager, a.applicationId, w.reasonId, { send: 'on', fingerprint: previews[a.applicationId].fingerprint }))));
    expect(results.sort()).toEqual(['email_hourly_limit', 'ok']);
    expect((await emails()).length).toBe(500);
    const states = await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id in (${y.applicationId}::uuid, ${z.applicationId}::uuid) order by state`);
    expect(states.map((r) => r.state)).toEqual(['active', 'archived']);
  });
});

describe('5720 — grants, the default sender name, company deletion and the restricted owner', () => {
  const NEW_TABLES = ['recruitment_candidate_email', 'recruitment_candidate_email_setting', 'recruitment_candidate_email_template'];
  it('forces row security with no PUBLIC grant; the sweep functions are owner-only definers; the app role cannot call them', async () => {
    const t = await owner.db.execute<{ relname: string; rls: boolean; forced: boolean; public_grants: number }>(sql`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where x.grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${NEW_TABLES.join(',')}}`}::text[]) order by c.relname`);
    expect(t).toEqual(NEW_TABLES.map((relname) => ({ relname, rls: true, forced: true, public_grants: 0 })));
    const fns = await owner.db.execute<{ proname: string; app_exec: boolean; public_exec: boolean; secdef: boolean; pinned: boolean }>(sql`select p.proname,
      has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec, has_function_privilege('public', p.oid, 'execute') as public_exec, p.prosecdef as secdef,
      coalesce(array_to_string(p.proconfig, ',') like 'search_path=%', false) as pinned
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
        and p.proname like 'recruitment_candidate_email_%' and p.prosecdef order by p.proname collate "C"`);
    expect(fns).toEqual([
      { proname: 'recruitment_candidate_email_claim', app_exec: false, public_exec: false, secdef: true, pinned: true },
      { proname: 'recruitment_candidate_email_finish', app_exec: false, public_exec: false, secdef: true, pinned: true },
      { proname: 'recruitment_candidate_email_hour_count', app_exec: true, public_exec: false, secdef: true, pinned: true },
      { proname: 'recruitment_candidate_email_hour_count_owner', app_exec: false, public_exec: false, secdef: true, pinned: true },
      { proname: 'recruitment_candidate_email_purge', app_exec: false, public_exec: false, secdef: true, pinned: true },
      { proname: 'recruitment_candidate_email_start', app_exec: false, public_exec: false, secdef: true, pinned: true },
      { proname: 'recruitment_candidate_email_target', app_exec: false, public_exec: false, secdef: true, pinned: true },
    ]);
    const [ctx] = await owner.db.execute<{ app_exec: boolean; secdef: boolean }>(sql`select has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec,
      p.prosecdef as secdef from pg_proc p where p.proname = 'recruitment_email_context_open'`);
    expect(ctx).toEqual({ app_exec: true, secdef: true });
    for (const call of [sql`select * from app.recruitment_candidate_email_claim(5)`, sql`select app.recruitment_candidate_email_purge(5)`,
      sql`select app.recruitment_candidate_email_finish(gen_random_uuid(), gen_random_uuid(), 'sent', null)`]) {
      expect(await code(rows(admin, call))).toBe('42501');
    }
  });

  it('no session setting opens the owner-bound reads, and the app role cannot open the context', async () => {
    const w = await world();
    await emailOn();
    await add(w.recruiter, w.jobId, { sendReceipt: 'on' });
    const forged = await owner.client.begin(async (tx) => {
      await tx.unsafe('set local role ai_hr_app');
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${w.bystander.userId}, true), set_config('app.roles', 'employee', true),
        set_config('app.grants', ${JSON.stringify([{ role: 'employee', companyId: null }])}, true),
        set_config('app.recruitment_email_worker', ${base.tenantId}, true), set_config('app.recruitment_email_count', ${base.companyId}, true)`;
      return { candidates: (await tx`select 1 from recruitment_candidate`).length, emails: (await tx`select 1 from recruitment_candidate_email`).length,
        settings: (await tx`select 1 from recruitment_candidate_email_setting`).length };
    });
    expect(forged).toEqual({ candidates: 0, emails: 0, settings: 0 });
    expect(await code(owner.client.begin(async (tx) => {
      await tx.unsafe('set local role ai_hr_app');
      await tx`insert into app.recruitment_candidate_email_context (txid, purpose, scope_id) values (txid_current(), 'worker', ${base.tenantId}::uuid)`;
    }))).toBe('42501');
  });

  it('the default sender name is cut to 80, trimmed of Unicode spaces and made safe for the transport, the same in SQL and TypeScript', async () => {
    for (const name of ['　 Fictional QZE ', `${'Q'.repeat(79)} tail`, `${'Q'.repeat(78)}　　x`, 'Fictional\nQZE', 'Plain QZE Sdn Bhd',
      'Fictional "QZE" Sdn Bhd', 'QZE@Work Sdn Bhd', '<QZE>  Fictional\n\nSdn Bhd', ' "QZE" ', `${'Q'.repeat(79)}"tail`, `${'@'.repeat(40)}${'Q'.repeat(100)}`,
      'QZE\u0001\u007f\u009f x', '\u3000"QZE"\u00a0', '"@<>"']) {
      const [r] = await owner.db.execute<{ n: string }>(sql`select app.recruitment_candidate_email_sender(null, ${name}) as n`);
      expect(r.n, JSON.stringify(name)).toBe(defaultSenderName(name));
      expect(r.n.trim()).toBe(r.n);
      // Whatever is left is a display name the transport accepts (D-064); only a name of nothing but refused characters leaves none.
      if (name !== '"@<>"') expect(validManagedEmailSenderName(r.n), JSON.stringify(name)).toBe(r.n);
    }
    const [none] = await owner.db.execute<{ n: string }>(sql`select app.recruitment_candidate_email_sender(null, '"@<>"') as n`);
    expect(none.n).toBe('');
  });

  it('sender names the transport refuses (@ < > ") are refused on save and by both CHECKs; a company name with them sends made safe', async () => {
    for (const bad of ['QZE@Talent', 'QZE <Talent>', 'QZE Talent >', 'QZE "Talent"']) {
      expect(await code(saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: REPLY_TO, senderName: bad })), bad).toBe('invalid_input');
      // Past the service, as the administrator (row security admits the write; the CHECK refuses it).
      expect(await code(rows(admin, sql`insert into recruitment_candidate_email_setting (company_id, tenant_id, enabled, sender_name, reply_to,
        created_by_user_id, updated_by_user_id) values (${base.companyId}::uuid, ${base.tenantId}::uuid, false, ${bad}, ${REPLY_TO}, ${admin.userId}::uuid,
        ${admin.userId}::uuid)`)), bad).toBe('23514');
    }
    expect(await owner.db.execute(sql`select 1 from recruitment_candidate_email_setting where company_id = ${base.companyId}::uuid`)).toHaveLength(0);
    // The default: the company's legal name with each refused character made a space (D-064), shown on the page and frozen on the e-mail.
    await owner.db.execute(sql`update company set legal_name = 'Fictional "QZE" <Talent>@Sdn Bhd' where id = ${base.companyId}::uuid`);
    const w = await world();
    expect(await code(saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: REPLY_TO }))).toBe('ok');
    expect((await candidateEmailSettings(admin, base.companyId)).defaultSenderName).toBe('Fictional QZE Talent Sdn Bhd');
    await add(w.recruiter, w.jobId, { sendReceipt: 'on' });
    const [row] = await emails();
    expect(row).toMatchObject({ kind: 'application_received', sender_name: 'Fictional QZE Talent Sdn Bhd' });
    expect(validManagedEmailSenderName(row.sender_name)).toBe(row.sender_name);
    // The frozen row's CHECK refuses the same characters, even past the triggers.
    expect(await code(travel('update recruitment_candidate_email set sender_name = $1 where id = $2', ['QZE "Talent"', row.id]))).toBe('23514');
    // A company name with nothing a sender name can use leaves no default: switching on needs the company's own sender name.
    await owner.db.execute(sql`update company set legal_name = '"@<>"' where id = ${otherCompanyId}::uuid`);
    expect(await code(saveCandidateEmailSettings(admin, otherCompanyId, { enabled: true, replyTo: REPLY_TO }))).toBe('missing_fields');
    expect(await owner.db.execute(sql`select 1 from recruitment_candidate_email_setting where company_id = ${otherCompanyId}::uuid`)).toHaveLength(0);
    expect(await code(saveCandidateEmailSettings(admin, otherCompanyId, { enabled: false, replyTo: REPLY_TO }))).toBe('ok');
    expect(await code(saveCandidateEmailSettings(admin, otherCompanyId, { enabled: true, replyTo: REPLY_TO, senderName: 'QZE Talent' }))).toBe('ok');
  });

  it('the company delete removes the settings and templates; candidates refuse it first', async () => {
    await saveCandidateEmailSettings(admin, otherCompanyId, { enabled: true, replyTo: REPLY_TO });
    await saveCandidateEmailTemplate(admin, { companyId: otherCompanyId, kind: 'rejection', locale: 'en', subject: 'QZE {jobTitle}', body: 'Dear {candidateName}' });
    const [removed] = await withTenant(adminCtx(base), (tx) => tx.execute<{ n: number }>(sql`select app.recruitment_delete_company_setup(${otherCompanyId}::uuid) as n`));
    expect(Number(removed.n)).toBe(2);
    for (const t of NEW_TABLES) expect(await owner.db.execute(sql`select 1 from ${sql.identifier(t)} where company_id = ${otherCompanyId}::uuid`), t).toHaveLength(0);
  });

  it('owner rehearsal: under the restricted, NOBYPASSRLS owner the sweep and the removal work, and the owner reads nothing outside them', async () => {
    const w = await world();
    await emailOn();
    const a = await add(w.recruiter, w.jobId, { sendReceipt: 'on' });
    const ROLLBACK = 'rolled back on purpose';
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment', 'employment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      for (const t of tables) await tx.unsafe(`alter table ${t.name} owner to ai_hr_owner`);
      const fns = await tx<{ sig: string }[]>`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname ~ '^recruitment_'`;
      for (const x of fns) await tx.unsafe(`alter function ${x.sig} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      await tx.unsafe('set local role ai_hr_owner');
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', '', true), set_config('app.roles', 'hr_admin', true),
        set_config('app.grants', '[]', true)`;
      expect(await tx`select 1 from public.recruitment_candidate_email`).toEqual([]);
      expect(await tx`select 1 from public.recruitment_candidate`).toEqual([]);
      // Not even with the old session settings: only the context its own functions open admits the owner.
      await tx`select set_config('app.recruitment_email_worker', ${base.tenantId}, true), set_config('app.recruitment_email_count', ${base.companyId}, true)`;
      expect(await tx`select 1 from public.recruitment_candidate_email`).toEqual([]);
      expect(await tx`select 1 from public.recruitment_candidate`).toEqual([]);
      expect(await tx`select 1 from public.recruitment_candidate_email_setting`).toEqual([]);
      const [c] = await tx<{ email_id: string; token: string }[]>`select * from app.recruitment_candidate_email_claim(5)`;
      expect(c).toBeTruthy();
      const [target] = await tx`select app.recruitment_candidate_email_target(${c.email_id}::uuid, ${c.token}::uuid) as r`;
      expect(target.r).toMatchObject({ eligible: true, senderName: SENDER, replyTo: REPLY_TO, recipient: expect.stringMatching(/@example\.test$/) });
      expect((await tx`select app.recruitment_candidate_email_start(${c.email_id}::uuid, ${c.token}::uuid, 'rev-fixture-1') as r`)[0].r).toBe(true);
      expect((await tx`select app.recruitment_candidate_email_finish(${c.email_id}::uuid, ${c.token}::uuid, 'sent', null) as r`)[0].r).toBe(true);
      expect((await tx`select app.recruitment_candidate_email_purge(10) as r`)[0].r).toBe(0);
      await tx.unsafe('reset role');
      await tx.unsafe('set local role ai_hr_app');
      await tx`select set_config('app.user_id', ${admin.userId!}, true), set_config('app.roles', 'hr_admin', true),
        set_config('app.grants', ${JSON.stringify([{ role: 'hr_admin', companyId: null }])}, true)`;
      await tx`update recruitment_application set state = 'archived', archive_reason_id = ${w.reasonId}::uuid, stage_left_at_archive = current_stage_id where id = ${a.applicationId}::uuid`;
      const [destroyed] = await tx`select app.recruitment_destroy_candidate(${a.candidateId}::uuid) as r`;
      expect(destroyed.r).toMatchObject({ candidateEmails: 1 });
      await tx.unsafe('reset role');
      expect(await tx`select status from recruitment_candidate_email where application_id = ${a.applicationId}::uuid`).toEqual([]);
      throw new Error(ROLLBACK);
    }).catch((err: unknown) => (err instanceof Error && err.message === ROLLBACK ? 'rolled back' : Promise.reject(err)));
    expect(done).toBe('rolled back');
  });
});
