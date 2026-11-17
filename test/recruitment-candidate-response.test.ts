/**
 * Recruitment slice 21b against Postgres — candidate response links (docs/recruitment-reconstruction/specification.md "Slice 21",
 * 21b): the link in an invitation and an offer e-mail, the public link page (GET shows, POST answers), the interview's candidate
 * response, the offer reply HR sees, and the database's refusals. The installation's ability to send is faked by mocking
 * lib/recruitment-candidate-email-ipc; the public origin is a fictional https origin. Every person and value is fictional (QZR).
 */
import { randomUUID } from 'node:crypto';
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
import { isCareersRoute } from '../lib/careers-route';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  addApplication, applicationOffer, cancelInterview, createJob, jobFormOptions, offerEmailPreview, offerSettings, previewInterviewInvitation,
  saveApprovalFlow, saveCandidateEmailSettings, saveOffer, saveOfferField, scheduleInterview, sendOfferByEmail, submitOffer, RecruitmentError,
} from '../packs/recruitment/service';
import { GET as linkGet, POST as linkPost } from '../app/careers/r/[token]/route';
import { closeCareersPool } from '../packs/recruitment/careers';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ORIGIN = 'https://hr.qzr.example.test';
let base: Base;
let admin: SessionContext;
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
type Login = SessionContext & { userId: string };
async function login(name: string): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId: base.companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
async function world() {
  const [recruiter, interviewer] = await Promise.all([login('Fictional QZR Recruiter'), login('Fictional QZR Interviewer')]);
  await jobFormOptions(admin, base.companyId);
  const { id: jobId } = await createJob(admin, { companyId: base.companyId, title: 'QZR Fictional analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
    recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional.', recruiterUserId: recruiter.userId });
  await saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: 'talent.qzr@example.test', senderName: 'QZR Talent', locale: 'en', reminderEnabled: false });
  const app = await addApplication(recruiter, { jobId, fullName: 'Fictional QZR Applicant', email: 'qzr.applicant@example.test' });
  return { recruiter, interviewer, jobId, applicationId: app.applicationId };
}
type World = Awaited<ReturnType<typeof world>>;
const startsAt = (days = 5) => `${todayInKualaLumpur(new Date(Date.now() + days * 86_400_000))}T10:30`;
async function invite(w: World, days = 5) {
  const input = { applicationId: w.applicationId, roundNo: '1', type: 'video', startsAt: startsAt(days), durationMinutes: '45', interviewerIds: [w.interviewer.userId] };
  const p = await previewInterviewInvitation(w.recruiter, input);
  if (p.status !== 'ready') throw new Error(`preview ${p.status}`);
  const r = await scheduleInterview(w.recruiter, input, { send: 'on', subject: p.subject, text: p.text });
  return { preview: p, id: r.id };
}
const emailRow = (kind: string) => owner.db.execute<{ body_text: string; body_html: string; response_url: string | null }>(sql`
  select body_text, body_html, response_url from recruitment_candidate_email where tenant_id = ${base.tenantId}::uuid and kind = ${kind}`);
const tokenOf = (url: string | null) => /\/careers\/r\/([A-Za-z0-9_-]{43})$/.exec(url ?? '')?.[1] ?? null;
const req = (path: string, init: { method?: string; body?: FormData; source?: string } = {}) =>
  new NextRequest('https://careers.qzr.example.test' + path, { method: init.method, body: init.body, headers: { 'x-aihr-request-source': init.source ?? '192.0.2.77' } });
const view = (token: string) => linkGet(req(`/careers/r/${token}`), { params: Promise.resolve({ token }) });
const answer = (token: string, a: string, source?: string) => {
  const f = new FormData(); f.set('answer', a);
  return linkPost(req(`/careers/r/${token}`, { method: 'POST', body: f, source }), { params: Promise.resolve({ token }) });
};

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv('AUTH_PUBLIC_ORIGIN', ORIGIN);
  vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '1');
  relay.available = true;
  await resetDb();
  await owner.db.execute(sql`delete from app.recruitment_response_link`);
  await owner.db.execute(sql`delete from app.recruitment_response_attempt`);
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
});

describe('the public path', () => {
  it('admits exactly /careers/r/<43 base64url characters> for GET, HEAD and POST', () => {
    const t = 'A'.repeat(43);
    for (const m of ['GET', 'HEAD', 'POST']) expect(isCareersRoute(`/careers/r/${t}`, m)).toBe(true);
    for (const p of [`/careers/r/${t.slice(1)}`, `/careers/r/${t}A`, `/careers/r/${t}/`, '/careers/r', `/careers/r/${'A'.repeat(42)}=`]) expect(isCareersRoute(p, 'GET'), p).toBe(false);
    expect(isCareersRoute(`/careers/r/${t}`, 'DELETE')).toBe(false);
  });
});

describe('interview invitations carry a link; opening shows, answering sets the candidate response', () => {
  it('previews a stand-in, freezes the candidate\'s own link, and answers while the interview is open', async () => {
    const w = await world();
    const { preview, id } = await invite(w);
    expect(preview.text).toContain(`${ORIGIN}/careers/r/your-personal-link-appears-here-when-sent--`);
    const [e] = await emailRow('interview_invitation');
    const token = tokenOf(e.response_url)!;
    expect(token).toBeTruthy();
    expect(e.body_text).toContain(`Accept or decline this interview here: ${e.response_url}`);
    expect(e.body_text).not.toContain('your-personal-link');
    expect(e.body_html).toContain(e.response_url!);
    // GET shows and changes nothing.
    const page = await (await view(token)).text();
    expect(page).toContain('Interview for QZR Fictional analyst');
    expect(page).toContain('value="accepted"');
    expect((await owner.db.execute<{ r: string }>(sql`select candidate_response as r from recruitment_interview where id = ${id}::uuid`))[0].r).toBe('pending');
    // POST answers; the answer can change while open.
    expect((await answer(token, 'accepted')).status).toBe(200);
    expect((await owner.db.execute<{ r: string }>(sql`select candidate_response as r from recruitment_interview where id = ${id}::uuid`))[0].r).toBe('accepted');
    expect((await answer(token, 'declined')).status).toBe(200);
    expect((await owner.db.execute<{ r: string }>(sql`select candidate_response as r from recruitment_interview where id = ${id}::uuid`))[0].r).toBe('declined');
    // Cancelled: closed (409) and nothing changes.
    await cancelInterview(w.recruiter, id);
    const closed = await answer(token, 'accepted');
    expect(closed.status).toBe(409);
    expect(await closed.text()).toContain('This link no longer takes answers');
    expect((await owner.db.execute<{ r: string }>(sql`select candidate_response as r from recruitment_interview where id = ${id}::uuid`))[0].r).toBe('declined');
  });
  it('unknown and malformed tokens are Not found; 20 answers an hour per client', async () => {
    const w = await world();
    await invite(w);
    const [e] = await emailRow('interview_invitation');
    const token = tokenOf(e.response_url)!;
    expect((await view('B'.repeat(43))).status).toBe(404);
    expect((await view('short')).status).toBe(404);
    for (let i = 0; i < 20; i++) await answer(token, i % 2 ? 'accepted' : 'declined', '198.51.100.33');
    expect((await answer(token, 'accepted', '198.51.100.33')).status).toBe(429);
  });
  it('without an https origin no link is issued and the e-mail carries none', async () => {
    vi.stubEnv('AUTH_PUBLIC_ORIGIN', '');
    const w = await world();
    const { preview } = await invite(w);
    expect(preview.text).not.toContain('/careers/r/');
    const [e] = await emailRow('interview_invitation');
    expect(e.response_url).toBeNull();
    expect(e.body_text).not.toContain('/careers/r/');
  });
});

describe('offers: the reply is recorded for HR, never as the decision', () => {
  it('carries a link; an answer shows on the Offer tab, the decision stays HR\'s and the application does not move', async () => {
    const w = await world();
    const fields = (await offerSettings(admin, base.companyId)).fields;
    const job = fields.find((f) => f.label === 'Job offered')!;
    await saveOfferField(admin, { id: job.id, label: job.label, required: job.required, needsApproval: job.needsApproval, private: job.private, enabled: true, includeInEmail: 'on' });
    await saveApprovalFlow(admin, base.companyId, 'offer', []);
    const f = (label: string) => fields.find((x) => x.label === label)!.id;
    const { id: offerId } = await saveOffer(w.recruiter, w.applicationId, {
      [f('Job offered')]: { text: 'Fictional data analyst' }, [f('Department')]: { text: 'QZR' }, [f('Commencement date')]: { text: '2026-12-01' },
      [f('Basic salary')]: { amount: '5000.00', currency: 'MYR' },
    });
    await submitOffer(w.recruiter, offerId);
    const p = (await offerEmailPreview(w.recruiter, w.applicationId))!;
    expect(p.text).toContain(`${ORIGIN}/careers/r/your-personal-link-appears-here-when-sent--`);
    await sendOfferByEmail(w.recruiter, offerId, p.fingerprint);
    const [e] = await emailRow('offer');
    const token = tokenOf(e.response_url)!;
    expect(e.body_text).toContain(`Accept or decline this offer here: ${e.response_url}`);
    expect(await (await view(token)).text()).toContain('Your offer for QZR Fictional analyst');
    expect((await answer(token, 'accepted')).status).toBe(200);
    const o = (await applicationOffer(w.recruiter, w.applicationId)).offer!;
    expect(o.decision).toBe('pending');
    expect(o.candidateReply).toMatchObject({ answer: 'accepted' });
    const [{ state }] = await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id = ${w.applicationId}::uuid`);
    expect(state).toBe('active');
  });
});

describe('the database: a frozen link is the one issued with the e-mail', () => {
  it('refuses a link not issued in this transaction for this interview, and any other link in the text', async () => {
    const w = await world();
    const { id } = await invite(w);
    const fake = `${ORIGIN}/careers/r/${'C'.repeat(43)}`;
    expect(await constraintOf(withTenant(w.recruiter, (tx) => tx.execute(sql`select app.recruitment_response_link_issue('interview', ${id}::uuid, ${'d'.repeat(64)})`))))
      .toBe('recruitment_response_link_issue');
    expect(await constraintOf(owner.db.execute(sql`
      insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
        sender_name, reply_to, queued_by_user_id, interview_id, interview_starts_at, response_url)
      select a.tenant_id, a.company_id, a.job_id, a.id, a.candidate_id, 'rejection', 'en', c.email, 'QZR', ${`Here ${fake}`},
        '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p>QZR</p></body></html>', 'QZR Talent', 'talent.qzr@example.test', ${w.recruiter.userId}::uuid,
        null, null, ${fake}
      from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id where a.id = ${w.applicationId}::uuid`)))
      .toBe('recruitment_candidate_email_response_kind_ck');
    // The app role reads no link and calls no answer function inside a session.
    expect(await code(withTenant(w.recruiter, (tx) => tx.execute(sql`select 1 from app.recruitment_response_link`)))).toBe('42501');
    expect(await code(withTenant(w.recruiter, (tx) => tx.execute(sql`select app.recruitment_response_view(${'e'.repeat(64)})`)))).toBe('42501');
  });
});
