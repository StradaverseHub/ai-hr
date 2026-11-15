/**
 * Recruitment slice 21a against Postgres — verified careers applicants and careers receipts: acceptance cases 137–141
 * (docs/recruitment-reconstruction/specification.md "Slice 21"), through the public route handlers, the service, a FAKED mail relay
 * (the code e-mails are captured, nothing is sent) and directly as the app role. Case 142 is the lead's rendered check. Every person
 * and address is fictional; S21SENTINEL marks values that must not be stored raw.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const relay = vi.hoisted(() => ({ available: true, sent: [] as { to: string; subject: string; text: string; html: string; senderName: string; replyTo: string }[] }));
vi.mock('../lib/recruitment-candidate-email-ipc', async (original) => ({
  ...(await original<typeof import('../lib/recruitment-candidate-email-ipc')>()),
  candidateEmailAvailable: async () => relay.available,
  candidateEmailSender: async () => (relay.available ? { revision: 'rev-fixture', host: 'hr.example.test', send: async (m: (typeof relay.sent)[number]) => { relay.sent.push(m); } } : null),
}));
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { jobGrade } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import {
  applicationCandidateEmails, createJob, destroyCandidates, saveCandidateEmailSettings, setCareersPublished, setJobCareersPage, submitCareersApplication,
  updateCareersSettings, RecruitmentError, type CareersSubmission,
} from '../packs/recruitment/service';
import { GET as jobRoute, POST as postRoute } from '../app/careers/[address]/jobs/[jobId]/route';
import { closeCareersPool } from '../packs/recruitment/careers';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ADDRESS = 'fictional-verified';
const ORIGIN = 'https://careers.fixture.test';
let base: Base;
let admin: SessionContext;
let gradeId: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
const count = async (table: string) => (await owner.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))[0].n;
async function site() {
  await updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional Verified Careers', headline: '', introduction: '', notice: 'Fictional notice.' });
  await setCareersPublished(admin, base.companyId, true);
}
async function publicJob(title = 'Fictional verified analyst') {
  const { id } = await createJob(admin, { companyId: base.companyId, title, jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted',
    employmentType: 'full_time', description: 'Fictional description.' });
  await setJobCareersPage(admin, id, true);
  return id;
}
const emailOn = () => saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: 'talent.s21@example.test', senderName: 'S21 Talent', locale: 'en' });
let clientSeq = 0;
/** A distinct verified request source per test unless one is given (the per-client limits are then the test's own). */
const req = (path: string, init: { method?: string; body?: FormData; source?: string } = {}) =>
  new NextRequest(ORIGIN + path, { method: init.method, body: init.body, headers: { 'x-aihr-request-source': init.source ?? `192.0.2.${(clientSeq % 200) + 1}` } });
const path = (jobId: string) => `/careers/${ADDRESS}/jobs/${jobId}`;
const params = (jobId: string) => ({ params: Promise.resolve({ address: ADDRESS, jobId }) });
const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
const post = (jobId: string, values: Record<string, string>, source?: string) => postRoute(req(path(jobId), { method: 'POST', body: form(values), source }), params(jobId));
const lastCode = () => /\b(\d{6})\b/.exec(relay.sent.at(-1)?.text ?? '')?.[1] ?? null;
/** Ask for a code and enter it, as a visitor does; returns the verification token from the form shown. */
async function verify(jobId: string, email: string, source?: string): Promise<string> {
  await post(jobId, { intent: 'code', email }, source);
  const r = await post(jobId, { intent: 'verify', email, code: lastCode()! }, source);
  const html = await r.text();
  const token = /name="verificationToken" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  if (!token) throw new Error(`no token (${r.status})`);
  return token;
}
const submit = (jobId: string, over: Partial<CareersSubmission> = {}) => submitCareersApplication({
  address: ADDRESS, jobId, fullName: 'Fictional S21SENTINEL Applicant', email: 's21.applicant@example.test', mobile: '', message: '', consent: 'on', noticeVersion: '1',
  website: '', resume: null, clientHash: () => createHash('sha256').update(`s21:${randomUUID()}`).digest('hex'), currentNoticeVersion: 1, ...over,
});
const emails = () => owner.db.execute<{ kind: string; recipient: string; subject: string; body_text: string; queued_by_user_id: string | null; candidate_id: string }>(sql`
  select kind, recipient, subject, body_text, queued_by_user_id, candidate_id from recruitment_candidate_email where tenant_id = ${base.tenantId}::uuid`);

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
beforeEach(async () => {
  relay.available = true;
  relay.sent.length = 0;
  clientSeq++;
  await resetDb();
  await owner.db.execute(sql`delete from app.recruitment_careers_attempt`);
  await owner.db.execute(sql`delete from app.recruitment_careers_code`);
  await owner.db.execute(sql`delete from app.recruitment_careers_code_check`);
  await owner.db.execute(sql`delete from app.recruitment_careers_verification`);
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  await site();
});

describe('case 137 — verification applies exactly while the company\'s candidate e-mail is on', () => {
  it('with e-mail off, slice 8\'s form works unchanged and queues nothing', async () => {
    const jobId = await publicJob();
    expect(await (await jobRoute(req(path(jobId)), params(jobId))).text()).toContain('name="fullName"');
    expect(await submit(jobId)).toEqual({ ok: true, outcome: 'received' });
    expect(await count('recruitment_candidate')).toBe(1);
    expect(await emails()).toHaveLength(0);
    expect(relay.sent).toHaveLength(0);
  });
  it('with e-mail on, the page asks for the e-mail first and an application without a verification is refused by the service and the database', async () => {
    const jobId = await publicJob();
    await emailOn();
    const page = await (await jobRoute(req(path(jobId)), params(jobId))).text();
    expect(page).toContain('Send me a code');
    expect(page).not.toContain('name="fullName"');
    expect(await submit(jobId)).toEqual({ ok: true, outcome: 'unverified' });
    expect(await submit(jobId, { verificationToken: 'A'.repeat(43) })).toEqual({ ok: true, outcome: 'unverified' });
    expect(await count('recruitment_candidate')).toBe(0);
    // The app role cannot reach 5708's submission directly any more.
    expect(await code(owner.client.begin(async (tx) => {
      await tx`set local role ai_hr_app`;
      return tx`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, ${'a'.repeat(64)}, 'Fictional', 'a@b.cd', null, null, 1, false)`;
    }))).toBe('42501');
    // Switched on but the installation cannot send: no form at all.
    relay.available = false;
    const closed = await (await jobRoute(req(path(jobId)), params(jobId))).text();
    expect(closed).not.toContain('name="fullName"');
    expect(closed).not.toContain('Send me a code');
  });
});

describe('case 138 — the code', () => {
  it('goes only to the address typed, in the company\'s sender name, with no link; the page reads the same either way', async () => {
    const jobId = await publicJob();
    await emailOn();
    const r = await post(jobId, { intent: 'code', email: 'S21.Visitor@Example.TEST' });
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).toContain('If s21.visitor@example.test can receive email, we have sent a 6-digit code');
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]).toMatchObject({ to: 's21.visitor@example.test', senderName: 'S21 Talent', replyTo: 'talent.s21@example.test' });
    expect(relay.sent[0].subject).toBe(`Your code to apply for Fictional verified analyst: ${lastCode()}`);
    expect(relay.sent[0].text).not.toMatch(/https?:|www\./);
    // A malformed address gets a field message and nothing is sent.
    const bad = await post(jobId, { intent: 'code', email: 'not an address' });
    expect(bad.status).toBe(400);
    expect(relay.sent).toHaveLength(1);
  });
  it('expires after 10 minutes, allows 5 wrong entries, and a new code replaces the old one', async () => {
    const jobId = await publicJob();
    await emailOn();
    await post(jobId, { intent: 'code', email: 's21.a@example.test' });
    const first = lastCode()!;
    const wrong = first === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect(await (await post(jobId, { intent: 'verify', email: 's21.a@example.test', code: wrong })).text()).toContain('That code is not right');
    expect(await (await post(jobId, { intent: 'verify', email: 's21.a@example.test', code: wrong })).text()).toContain('That code is not right');
    // Spent after the fifth wrong entry: even the right code is refused now.
    expect(await (await post(jobId, { intent: 'verify', email: 's21.a@example.test', code: first })).text()).toContain('This code has expired');
    // A new code replaces any earlier one; an expired one is refused.
    await post(jobId, { intent: 'code', email: 's21.a@example.test' });
    const second = lastCode()!;
    await post(jobId, { intent: 'code', email: 's21.a@example.test' });
    const third = lastCode()!;
    if (second !== third) expect(await (await post(jobId, { intent: 'verify', email: 's21.a@example.test', code: second })).text()).toMatch(/not right|expired/);
    await owner.db.execute(sql`update app.recruitment_careers_code set expires_at = now() - interval '1 second' where spent_at is null`);
    expect(await (await post(jobId, { intent: 'verify', email: 's21.a@example.test', code: third })).text()).toContain('This code has expired');
  });
});

describe('case 139 — limits, and nothing raw is stored', () => {
  it('3 codes an hour per address (the same page, nothing sent), 10 per client (429), 30 checks per client (429)', async () => {
    const jobId = await publicJob();
    await emailOn();
    const source = '198.51.100.7';
    for (let i = 0; i < 3; i++) await post(jobId, { intent: 'code', email: 's21.limit@example.test' }, source);
    expect(relay.sent).toHaveLength(3);
    const fourth = await post(jobId, { intent: 'code', email: 's21.limit@example.test' }, source);
    expect(fourth.status).toBe(200);
    expect(await fourth.text()).toContain('If s21.limit@example.test can receive email');
    expect(relay.sent).toHaveLength(3);
    for (let i = 0; i < 7; i++) await post(jobId, { intent: 'code', email: `s21.other${i}@example.test` }, source);
    expect((await post(jobId, { intent: 'code', email: 's21.more@example.test' }, source)).status).toBe(429);
    const checker = '198.51.100.8';
    for (let i = 0; i < 30; i++) await post(jobId, { intent: 'verify', email: 's21.limit@example.test', code: '123456' }, checker);
    expect((await post(jobId, { intent: 'verify', email: 's21.limit@example.test', code: '123456' }, checker)).status).toBe(429);
    for (const t of ['app.recruitment_careers_code', 'app.recruitment_careers_code_check', 'app.recruitment_careers_verification']) {
      const [hit] = await owner.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${t} r where to_jsonb(r.*)::text ~ '@|example\\.test|192\\.0\\.2|198\\.51\\.100'`));
      expect(hit.n, t).toBe(0);
    }
  });
});

describe('case 140 — a verification is for that address and job, 30 minutes, once', () => {
  it('applies once with the verified address; refuses another address, another job, a second use and an expired one', async () => {
    const jobId = await publicJob();
    const otherJob = await publicJob('Fictional second verified job');
    await emailOn();
    const token = await verify(jobId, 's21.applicant@example.test');
    expect(await submit(otherJob, { verificationToken: token })).toEqual({ ok: true, outcome: 'unverified' });
    expect(await submit(jobId, { verificationToken: token, email: 's21.someone.else@example.test' })).toEqual({ ok: true, outcome: 'unverified' });
    expect(await submit(jobId, { verificationToken: token })).toEqual({ ok: true, outcome: 'received' });
    expect(await count('recruitment_candidate')).toBe(1);
    expect(await submit(jobId, { verificationToken: token, email: 's21.applicant@example.test' })).toEqual({ ok: true, outcome: 'unverified' });
    const late = await verify(otherJob, 's21.late@example.test');
    await owner.db.execute(sql`update app.recruitment_careers_verification set expires_at = now() - interval '1 second' where used_at is null`);
    expect(await submit(otherJob, { verificationToken: late, email: 's21.late@example.test' })).toEqual({ ok: true, outcome: 'unverified' });
    expect(await count('recruitment_candidate')).toBe(1);
  });
});

describe('case 141 — careers receipts', () => {
  it('a verified application queues exactly one receipt as by the applicant; a repeat queues none; removal deletes it and the verification', async () => {
    const jobId = await publicJob();
    await emailOn();
    const token = await verify(jobId, 's21.applicant@example.test');
    expect(await submit(jobId, { verificationToken: token })).toEqual({ ok: true, outcome: 'received' });
    const [r] = await emails();
    expect(r).toMatchObject({ kind: 'application_received', recipient: 's21.applicant@example.test', queued_by_user_id: null });
    expect(r.subject).toBe('We received your application for Fictional verified analyst');
    expect(r.body_text).toContain('Dear Fictional S21SENTINEL Applicant,');
    const [{ application_id }] = await owner.db.execute<{ application_id: string }>(sql`select id as application_id from recruitment_application where tenant_id = ${base.tenantId}::uuid`);
    expect((await applicationCandidateEmails(admin, application_id))!.rows[0]).toMatchObject({ kind: 'application_received', byApplicant: true });
    // The same person again (repeated application): the same thank-you, nothing stored or queued.
    const again = await verify(jobId, 's21.applicant@example.test');
    expect(await submit(jobId, { verificationToken: again })).toEqual({ ok: true, outcome: 'received' });
    expect(await emails()).toHaveLength(1);
    // Removal (after closing the application) deletes the receipt and the verifications naming the candidate.
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state = 'archived' where id = ${application_id}::uuid`;
    });
    expect(await destroyCandidates(admin, base.companyId, [r.candidate_id], 'on')).toEqual({ removed: 1 });
    expect(await emails()).toHaveLength(0);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_careers_verification where candidate_id = ${r.candidate_id}::uuid`))[0].n).toBe(0);
  });
  it('the database queues a receipt only for an application made from that verification in the last minutes, never twice', async () => {
    const jobId = await publicJob();
    await emailOn();
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p>S21</p></body></html>';
    const queue = (tokenHash: string, applicationId: string) => owner.client.begin(async (tx) => {
      await tx`set local role ai_hr_app`;
      return (await tx`select app.recruitment_careers_queue_receipt(${tokenHash}, ${applicationId}::uuid, 'S21 subject', 'S21 text', ${html}) as r`)[0].r as { status: string };
    });
    const token = await verify(jobId, 's21.applicant@example.test');
    await submit(jobId, { verificationToken: token });
    const [v] = await owner.db.execute<{ token_hash: string; application_id: string }>(sql`select token_hash, application_id from app.recruitment_careers_verification where application_id is not null`);
    expect(await queue(v.token_hash, v.application_id)).toEqual({ status: 'skipped' }); // already queued (one per application)
    expect(await queue('f'.repeat(64), v.application_id)).toEqual({ status: 'skipped' });
    await owner.db.execute(sql`update app.recruitment_careers_verification set used_at = now() - interval '11 minutes'`);
    await owner.db.execute(sql`delete from recruitment_candidate_email`);
    expect(await queue(v.token_hash, v.application_id)).toEqual({ status: 'skipped' });
    expect(await emails()).toHaveLength(0);
  });
});

