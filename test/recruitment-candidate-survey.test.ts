/**
 * Recruitment slice 22 against Postgres — the anonymous candidate survey (docs/recruitment-reconstruction/specification.md "Slice 22",
 * cases 143–147): queueing after a hire and after a rejection e-mail, the sweep's fresh link (FAKED transport), the public survey page
 * (GET shows, POST answers once), anonymity of the stored answer, row security, and the administrators' results. Case 148 is the
 * rendered check. The installation's ability to send is faked by mocking lib/recruitment-candidate-email-ipc; the public origin is a
 * fictional https origin. Expected figures are computed here from the answers given. Every person and value is fictional (QZS).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const relay = vi.hoisted(() => ({ available: true }));
vi.mock('../lib/recruitment-candidate-email-ipc', async (original) => ({
  ...(await original<typeof import('../lib/recruitment-candidate-email-ipc')>()),
  candidateEmailAvailable: async () => relay.available,
  candidateEmailSender: async () => null,
}));
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import type { CandidateEmailSender, CandidateMail } from '../lib/recruitment-candidate-email-ipc';
import {
  addApplication, createJob, deliverCandidateEmails, jobFormOptions, moveApplication, recruitmentSettings, recruitmentSurveyReport, rejectApplication,
  rejectionEmailPreviews, saveCandidateEmailSettings, RecruitmentError,
} from '../packs/recruitment/service';
import { GET as surveyGet, POST as surveyPost } from '../app/careers/s/[token]/route';
import { closeCareersPool } from '../packs/recruitment/careers';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ORIGIN = 'https://hr.qzs.example.test';
let base: Base;
let admin: SessionContext;
let gradeId: string;
const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
type Login = SessionContext & { userId: string };
async function login(name: string): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId: base.companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
async function settings(over: Record<string, unknown> = {}) {
  await saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: 'talent.qzs@example.test', senderName: 'QZS Talent', locale: 'en', reminderEnabled: false,
    surveyHired: 'on', surveyRejected: 'on', surveyDelayDays: '3', ...over });
}
async function world() {
  const recruiter = await login('Fictional QZS Recruiter');
  await jobFormOptions(admin, base.companyId);
  const { id: jobId } = await createJob(admin, { companyId: base.companyId, title: 'QZS Fictional analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
    recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional.', recruiterUserId: recruiter.userId });
  const s = await recruitmentSettings(admin, base.companyId);
  return { recruiter, jobId, reasonId: s.reasons.find((r) => r.displayed)!.id, onboarding: s.stages.find((x) => x.name === 'Onboarding')!.id };
}
type World = Awaited<ReturnType<typeof world>>;
let seq = 0;
const add = (w: World, over: Record<string, unknown> = {}) => {
  const n = ++seq;
  return addApplication(w.recruiter, { jobId: w.jobId, fullName: `Fictional QZS Applicant ${n}`, email: `qzs.applicant${n}@example.test`, ...over });
};
async function hire(w: World, applicationId: string) {
  await moveApplication(admin, applicationId, w.onboarding);
  expect((await moveApplication(admin, applicationId)).state).toBe('hired');
}
async function rejectWithEmail(w: World, applicationId: string, delayDays = '0') {
  const p = (await rejectionEmailPreviews(w.recruiter, [applicationId]))[applicationId];
  return rejectApplication(w.recruiter, applicationId, w.reasonId, { send: 'on', delayDays, fingerprint: p?.fingerprint || 'none' });
}
type Row = { id: string; kind: string; status: string; survey_outcome: string | null; subject: string; body_text: string; body_html: string; error_code: string | null;
  queued_at: string; next_attempt_at: string; application_id: string };
const emails = (kind?: string) => owner.db.execute<Row>(sql`select * from recruitment_candidate_email where tenant_id = ${base.tenantId}::uuid
  ${kind ? sql`and kind = ${kind}` : sql``} order by queued_at, id`);
const seconds = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
const sweepCtx = (): SessionContext => ({ tenantId: base.tenantId, roles: ['hr_admin'], entitlements: admin.entitlements });
function fakeSender() {
  const sent: CandidateMail[] = [];
  const sender: CandidateEmailSender = { revision: 'rev-qzs-1', host: 'hr.qzs.example.test', send: async (m) => { sent.push(m); } };
  return { sent, sender };
}
const deliver = (sender: CandidateEmailSender) => deliverCandidateEmails(sweepCtx(), owner, async () => sender);
const dueNow = (kind: string) => owner.db.execute(sql`update recruitment_candidate_email set next_attempt_at = now() - interval '1 second'
  where tenant_id = ${base.tenantId}::uuid and kind = ${kind} and status in ('queued','retry')`);
const digest = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const invitations = () => owner.db.execute<{ token_digest: string; email_id: string; outcome: string }>(sql`select token_digest, email_id, outcome from app.recruitment_survey_invitation`);
const responses = () => owner.db.execute<Record<string, unknown>>(sql`select * from recruitment_candidate_survey_response where tenant_id = ${base.tenantId}::uuid`);
const req = (path: string, init: { method?: string; body?: FormData; source?: string } = {}) =>
  new NextRequest('https://careers.qzs.example.test' + path, { method: init.method, body: init.body, headers: { 'x-aihr-request-source': init.source ?? '192.0.2.88' } });
const open = (token: string) => surveyGet(req(`/careers/s/${token}`), { params: Promise.resolve({ token }) });
const post = (token: string, values: Record<string, string>, source?: string) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return surveyPost(req(`/careers/s/${token}`, { method: 'POST', body: f, source }), { params: Promise.resolve({ token }) });
};
/** Queue a survey after a hire (or a rejection e-mail, sent first) and send it through the sweep: returns the link's token as the
 *  candidate received it. */
async function sentSurvey(w: World, outcome: 'hired' | 'rejected' = 'hired') {
  const a = await add(w);
  if (outcome === 'hired') await hire(w, a.applicationId);
  else {
    await rejectWithEmail(w, a.applicationId);
    await owner.db.execute(sql`update recruitment_candidate_email set next_attempt_at = now() + interval '1 day' where kind = 'survey' and status = 'queued'`);
    expect(await deliver(fakeSender().sender)).toMatchObject({ sent: 1 });
  }
  await dueNow('survey');
  const f = fakeSender();
  expect(await deliver(f.sender)).toMatchObject({ sent: 1 });
  const token = new RegExp(`${ORIGIN.replace(/\./g, '\\.')}/careers/s/([A-Za-z0-9_-]{43})`).exec(f.sent[0].text)?.[1];
  if (!token) throw new Error('no survey link');
  return { a, token, mail: f.sent[0] };
}

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv('AUTH_PUBLIC_ORIGIN', ORIGIN);
  vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '1');
  relay.available = true;
  await resetDb();
  await owner.db.execute(sql`delete from app.recruitment_survey_invitation`);
  await owner.db.execute(sql`delete from app.recruitment_response_attempt`);
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
});

describe('143 — queueing after a hire or a rejection e-mail', () => {
  it('a hire queues one survey due the company\'s days later; with the survey off, none', async () => {
    const w = await world();
    await settings();
    const a = await add(w);
    await hire(w, a.applicationId);
    const [s] = await emails('survey');
    expect(s).toMatchObject({ status: 'queued', survey_outcome: 'hired', application_id: a.applicationId });
    expect(seconds(s.queued_at, s.next_attempt_at)).toBe(3 * 86_400);
    // The frozen content names the placeholder once and holds no link.
    expect(s.body_text.split('{surveyLink}')).toHaveLength(2);
    expect(s.body_html.split('{surveyLink}')).toHaveLength(2);
    expect(`${s.subject}\n${s.body_text}`).not.toMatch(/https?:|careers\/s\//);
    await settings({ surveyHired: '' });
    const b = await add(w);
    await hire(w, b.applicationId);
    expect(await emails('survey')).toHaveLength(1);
  });
  it('a rejection queues a survey only with its rejection e-mail, due the days after that e-mail', async () => {
    const w = await world();
    await settings({ surveyDelayDays: '5' });
    const a = await add(w);
    expect(await rejectWithEmail(w, a.applicationId, '2')).toEqual({ email: 'queued' });
    const [r] = await emails('rejection');
    const [s] = await emails('survey');
    expect(s).toMatchObject({ survey_outcome: 'rejected', application_id: a.applicationId });
    expect(seconds(r.next_attempt_at, s.next_attempt_at)).toBe(5 * 86_400);
    // Rejected without an e-mail: the candidate was not told, so no survey.
    const b = await add(w);
    await rejectApplication(w.recruiter, b.applicationId, w.reasonId);
    expect((await emails('survey')).map((e) => e.application_id)).toEqual([a.applicationId]);
  });
  it('a survey that cannot be queued never undoes the hire', async () => {
    const w = await world();
    await settings();
    const noAddress = await add(w, { email: '' });
    await hire(w, noAddress.applicationId);
    const linky = await add(w, { fullName: 'QZS see www.qzs.example' });
    await hire(w, linky.applicationId);
    relay.available = false;
    const later = await add(w);
    await hire(w, later.applicationId);
    expect(await emails('survey')).toHaveLength(0);
    const states = await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where tenant_id = ${base.tenantId}::uuid`);
    expect(states.map((x) => x.state)).toEqual(['hired', 'hired', 'hired']);
  });
  it('the database refuses a survey outside the hire or rejection that brings it, or with a link frozen in', async () => {
    const w = await world();
    await settings();
    const a = await add(w);
    await hire(w, a.applicationId);
    const [s] = await emails('survey');
    await owner.db.execute(sql`delete from recruitment_candidate_email where id = ${s.id}::uuid`);
    // A later transaction (the hire is not "now") cannot queue it, even with the same content.
    const insert = (over: { text?: string; after?: string } = {}) => withTenant(admin, (tx) => tx.execute(sql`
      insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
        sender_name, reply_to, queued_by_user_id, next_attempt_at, survey_outcome)
      select a.tenant_id, a.company_id, a.job_id, a.id, a.candidate_id, 'survey', 'en', c.email, ${s.subject}, ${over.text ?? s.body_text}, ${s.body_html}, 'QZS Talent',
        'talent.qzs@example.test', ${admin.userId!}::uuid, now() + ${over.after ?? '3 days'}::interval, 'hired'
      from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id where a.id = ${a.applicationId}::uuid`));
    expect(await code(insert())).toBe('23514');
    expect(await code(insert({ after: '20 days' }))).toBe('23514');
  });
});

describe('144 — the sweep sends a fresh link', () => {
  it('puts a new link in the outgoing message only; the row keeps the placeholder and the link is stored as its sha256', async () => {
    const w = await world();
    await settings();
    const { token, mail } = await sentSurvey(w);
    expect(mail.text).toContain(`${ORIGIN}/careers/s/${token}`);
    expect(mail.html).toContain(`${ORIGIN}/careers/s/${token}`);
    expect(mail.text).not.toContain('{surveyLink}');
    const [s] = await emails('survey');
    expect(s.status).toBe('sent');
    expect(s.body_text).toContain('{surveyLink}');
    expect(JSON.stringify(await emails())).not.toContain(token);
    expect(await invitations()).toEqual([{ token_digest: digest(token), email_id: s.id, outcome: 'hired' }]);
  });
  it('after a rejection, sends only once the rejection e-mail was sent', async () => {
    const w = await world();
    await settings();
    const a = await add(w);
    await rejectWithEmail(w, a.applicationId);
    // The survey falls due while the rejection e-mail has not gone: not eligible (failed), never sent.
    await owner.db.execute(sql`update recruitment_candidate_email set next_attempt_at = now() + interval '1 day' where kind = 'rejection'`);
    await dueNow('survey');
    const f = fakeSender();
    expect(await deliver(f.sender)).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(f.sent).toHaveLength(0);
    expect(await emails('survey')).toMatchObject([{ status: 'failed', error_code: 'notEligible' }]);
    expect(await invitations()).toEqual([]);
    // Another candidate's rejection goes first; then their survey is sent.
    const b = await add(w);
    await rejectWithEmail(w, b.applicationId);
    await dueNow('rejection');
    await owner.db.execute(sql`update recruitment_candidate_email set next_attempt_at = now() + interval '1 day' where kind = 'survey'`);
    expect(await deliver(f.sender)).toMatchObject({ sent: 2 });
    await dueNow('survey');
    expect(await deliver(f.sender)).toMatchObject({ sent: 1 });
    expect(f.sent.at(-1)!.text).toMatch(/\/careers\/s\/[A-Za-z0-9_-]{43}/);
  });
  it('is not sent once the company stops the survey for that outcome', async () => {
    const w = await world();
    await settings();
    const a = await add(w);
    await hire(w, a.applicationId);
    await settings({ surveyHired: '' });
    await dueNow('survey');
    const f = fakeSender();
    expect(await deliver(f.sender)).toMatchObject({ sent: 0, failed: 1 });
  });
});

describe('145 — the survey page', () => {
  it('opens without changing anything, answers once, and then answers as closed', async () => {
    const w = await world();
    await settings();
    const { token } = await sentSurvey(w);
    const g = await open(token);
    expect(g.status).toBe(200);
    const html = await g.text();
    const [{ name }] = await owner.db.execute<{ name: string }>(sql`select legal_name as name from company where id = ${base.companyId}::uuid`);
    expect(html).toContain('How was applying?');
    expect(html).toContain(name.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!));
    expect(html).not.toMatch(/QZS Fictional analyst|Applicant/);
    expect(await invitations()).toHaveLength(1);
    // A missing overall rating: shown again, nothing stored.
    const bad = await post(token, { communication: '4' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Choose a rating from 1 to 5.');
    expect(await responses()).toHaveLength(0);
    const ok = await post(token, { overall: '4', communication: '5', recommend: 'yes', comment: 'QZS fine' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Your answers are recorded.');
    const again = await post(token, { overall: '1' });
    expect(again.status).toBe(404);
    expect(await again.text()).toContain('This survey is closed');
    expect((await open(token)).status).toBe(404);
    expect(await responses()).toHaveLength(1);
  });
  it('answers an unknown, expired or removed candidate\'s link with the same closed page', async () => {
    const w = await world();
    await settings();
    const unknown = 'Q'.repeat(43);
    const closedText = async (r: Response) => ({ status: r.status, closed: (await r.text()).includes('This survey link has expired or was already used.') });
    expect(await closedText(await open(unknown))).toEqual({ status: 404, closed: true });
    expect(await closedText(await open('short'))).toEqual({ status: 404, closed: true });
    const first = await sentSurvey(w);
    await owner.db.execute(sql`update app.recruitment_survey_invitation set expires_at = now() - interval '1 second'`);
    expect(await closedText(await open(first.token))).toEqual({ status: 404, closed: true });
    expect(await closedText(await post(first.token, { overall: '3' }))).toEqual({ status: 404, closed: true });
    // Candidate removal deletes the e-mail: the link no longer opens (a rejected candidate: a hired one keeps their record).
    const second = await sentSurvey(w, 'rejected');
    await withTenant(admin, (tx) => tx.execute(sql`select app.recruitment_destroy_candidate(${second.a.candidateId}::uuid)`));
    expect(await closedText(await open(second.token))).toEqual({ status: 404, closed: true });
    expect(await closedText(await post(second.token, { overall: '3' }))).toEqual({ status: 404, closed: true });
    expect(await responses()).toHaveLength(0);
  });
  it('limits answers to 20 an hour per client, shared with response links', async () => {
    await world();
    for (let i = 0; i < 20; i++) expect((await post('Z'.repeat(43), { overall: '3' }, '192.0.2.99')).status).toBe(404);
    const r = await post('Z'.repeat(43), { overall: '3' }, '192.0.2.99');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('3600');
    expect((await post('Z'.repeat(43), { overall: '3' }, '192.0.2.100')).status).toBe(404);
  });
});

describe('146 — anonymity and access', () => {
  it('stores the company, outcome, month and answers only, and forgets the link', async () => {
    const w = await world();
    await settings();
    const { token } = await sentSurvey(w);
    expect((await post(token, { overall: '5', respect: '4', process: '3', recommend: 'unsure', comment: 'QZS comment' })).status).toBe(200);
    const [r] = await responses();
    expect(Object.keys(r).sort()).toEqual(['answered_month', 'comment', 'communication', 'company_id', 'id', 'outcome', 'overall', 'process', 'recommend', 'respect', 'tenant_id']);
    expect(r).toMatchObject({ company_id: base.companyId, outcome: 'hired', overall: 5, communication: null, respect: 4, process: 3, recommend: 'unsure', comment: 'QZS comment' });
    const [{ month }] = await owner.db.execute<{ month: string }>(sql`select to_char(date_trunc('month', now() at time zone 'Asia/Kuala_Lumpur'), 'YYYY-MM-DD') as month`);
    expect(new Date(r.answered_month as string).toISOString().slice(0, 7)).toBe(month.slice(0, 7));
    expect(await invitations()).toEqual([]);
    expect(JSON.stringify(await owner.db.execute(sql`select payload from domain_event where tenant_id = ${base.tenantId}::uuid`))).not.toContain('QZS comment');
  });
  it('lets the company\'s recruitment administrators read answers, nobody else, and nobody in the app write them', async () => {
    const w = await world();
    await owner.db.execute(sql`insert into recruitment_candidate_survey_response (tenant_id, company_id, outcome, answered_month, overall)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'hired', date_trunc('month', now())::date, 4)`);
    const read = (ctx: SessionContext) => withTenant(ctx, (tx) => tx.execute(sql`select id from recruitment_candidate_survey_response`));
    expect(await read(admin)).toHaveLength(1);
    expect(await read(w.recruiter)).toHaveLength(0);
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`insert into recruitment_candidate_survey_response (tenant_id, company_id, outcome, answered_month, overall)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'hired', date_trunc('month', now())::date, 4)`)))).toBe('42501');
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`delete from recruitment_candidate_survey_response`)))).toBe('42501');
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`select * from app.recruitment_survey_invitation`)))).toBe('42501');
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`select app.recruitment_survey_issue(${randomUUID()}::uuid, ${randomUUID()}::uuid, ${'e'.repeat(64)})`)))).toBe('42501');
    // The anonymous view and answer refuse a signed-in caller.
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`select app.recruitment_survey_view(${'e'.repeat(64)})`)))).toBe('42501');
  });
});

describe('147 — results', () => {
  const insert = (rows: { outcome: 'hired' | 'rejected'; overall: number; communication?: number | null; recommend?: string | null; comment?: string | null }[]) =>
    Promise.all(rows.map((r) => owner.db.execute(sql`insert into recruitment_candidate_survey_response (tenant_id, company_id, outcome, answered_month, overall, communication,
      recommend, comment) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${r.outcome}, date_trunc('month', now() at time zone 'Asia/Kuala_Lumpur')::date, ${r.overall},
      ${r.communication ?? null}, ${r.recommend ?? null}, ${r.comment ?? null})`)));
  it('hides everything below 5 answers and the split below 5 a side; figures match the answers', async () => {
    const w = await world();
    await insert([{ outcome: 'hired', overall: 5, comment: 'QZS a' }, { outcome: 'hired', overall: 4 }, { outcome: 'rejected', overall: 2 }, { outcome: 'rejected', overall: 3 }]);
    expect((await recruitmentSurveyReport(admin, [base.companyId])).summary).toEqual({ shown: false, minimum: 5 });
    await insert([{ outcome: 'rejected', overall: 1, communication: 2, recommend: 'no', comment: 'QZS b' }]);
    const five = (await recruitmentSurveyReport(admin, [base.companyId])).summary;
    // overall (5+4+2+3+1)/5 = 3; communication 2; recommend: one answer, "no".
    expect(five).toMatchObject({ shown: true, split: null, all: { responses: 5, averages: { overall: 3, communication: 2, respect: null, process: null },
      overallDistribution: [1, 1, 1, 1, 1], recommend: { answered: 1, yes: 0, no: 1, unsure: 0 } } });
    expect(five.shown && [...five.comments].sort()).toEqual(['QZS a', 'QZS b']);
    await insert([{ outcome: 'hired', overall: 5 }, { outcome: 'hired', overall: 5 }, { outcome: 'hired', overall: 3 }, { outcome: 'rejected', overall: 2 }, { outcome: 'rejected', overall: 2 }]);
    const ten = (await recruitmentSurveyReport(admin, [base.companyId])).summary;
    // hired 5,4,5,5,3 → 4.4; rejected 2,3,1,2,2 → 2.
    expect(ten.shown && ten.split?.hired).toMatchObject({ responses: 5, averages: { overall: 4.4 } });
    expect(ten.shown && ten.split?.rejected).toMatchObject({ responses: 5, averages: { overall: 2 } });
    // Administrators only.
    expect(await code(recruitmentSurveyReport(w.recruiter, [base.companyId]))).toBe('forbidden');
  });
  it('counts only the months the period touches', async () => {
    await world();
    await insert(Array.from({ length: 5 }, () => ({ outcome: 'hired' as const, overall: 4 })));
    await owner.db.execute(sql`update recruitment_candidate_survey_response set answered_month = '2025-01-01'`);
    expect((await recruitmentSurveyReport(admin, [base.companyId])).summary.shown).toBe(false);
    expect((await recruitmentSurveyReport(admin, [base.companyId], { from: '2025-01-15', to: '2025-02-10' })).summary).toMatchObject({ shown: true, all: { responses: 5 } });
  });
});
