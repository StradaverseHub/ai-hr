/**
 * Recruitment slice 20 against Postgres — candidate e-mail about interviews and offers: acceptance cases 133–135
 * (docs/recruitment-reconstruction/specification.md "Slice 20 acceptance cases"), through the service, the sweep with a FAKED transport
 * (no SMTP), and directly as the app role. Case 136 is the lead's rendered check. The pure rules are
 * test/recruitment-candidate-email-hiring-rules.test.ts.
 *
 * The installation's ability to send is faked by mocking lib/recruitment-candidate-email-ipc. Expected wording is computed here by plain
 * string replacement on the messages files and Intl date formatting, never with the module's renderer or its time helpers. Every
 * person, company and address is fictional; names carry the sentinel QZF.
 */
import { randomUUID } from 'node:crypto';
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
import { appUser, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { CandidateEmailSender, CandidateMail } from '../lib/recruitment-candidate-email-ipc';
import {
  addApplication, addJobMember, applicationCandidateEmails, cancelInterview, createJob, deliverCandidateEmails, interviewCancellationPreviews,
  invitationOffer, jobFormOptions, markOfferSent, offerEmailPreview, offerSettings, previewInterviewInvitation, recruitmentSettings, rejectApplication,
  saveApprovalFlow, saveCandidateEmailSettings, saveCandidateEmailTemplate, saveInterviewAddress, saveInterviewRoom, saveOffer, saveOfferField,
  scheduleInterview, sendOfferByEmail, submitOffer, RecruitmentError,
} from '../packs/recruitment/service';
import { closeCareersPool } from '../packs/recruitment/careers';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

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
const rows = <T = Record<string, unknown>>(ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute<T & Record<string, unknown>>(query));
type Login = SessionContext & { userId: string };
async function login(name: string): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId: base.companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
const REPLY_TO = 'talent.qzf@example.test';
const SENDER = 'QZF Talent team';
const MAP = 'https://maps.example.test/qzf-hq?q=1&z=2';
type EmailRow = { id: string; kind: string; status: string; recipient: string | null; subject: string | null; body_text: string | null; body_html: string | null;
  interview_id: string | null; interview_starts_at: string | null; offer_id: string | null; map_url: string | null; next_attempt_at: string; queued_at: string;
  completed_at: string | null; error_code: string | null; queued_by_user_id: string };
const emails = (applicationId?: string) => owner.db.execute<EmailRow>(sql`select * from recruitment_candidate_email
  where tenant_id = ${base.tenantId}::uuid ${applicationId ? sql`and application_id = ${applicationId}::uuid` : sql``} order by queued_at, kind, id`);
const messages = (locale: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8')) as {
  recruitment: { candidateEmail: { defaults: Record<string, { subject: string; body: string }>; interview: { types: Record<string, string>; map: string } } } };
const fill = (s: string, v: Record<string, string>) => Object.entries(v).reduce((acc, [k, x]) => acc.split(`{${k}}`).join(x), s);
const expected = (kind: string, v: Record<string, string>) => {
  const d = messages('en').recruitment.candidateEmail.defaults[kind];
  return { subject: fill(d.subject, v), text: fill(d.body, v) };
};
const companyName = async () => (await owner.db.execute<{ name: string }>(sql`select legal_name as name from company where id = ${base.companyId}::uuid`))[0].name;
/** An interview day five days ahead (Kuala Lumpur), at 10:30 for 45 minutes, and the words the default e-mail states for it (Intl, en). */
function slot(daysAhead = 5) {
  const day = todayInKualaLumpur(new Date(Date.now() + daysAhead * 86_400_000));
  const at = new Date(`${day}T10:30:00+08:00`);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Kuala_Lumpur' }).format(at);
  return { startsAt: `${day}T10:30`, at, interviewDate: `${weekday}, ${day}`, interviewTime: '10:30 to 11:15, Kuala Lumpur time (GMT+8)', interviewDuration: '45 minutes' };
}
const sweepCtx = (): SessionContext => ({ tenantId: base.tenantId, roles: ['hr_admin'], entitlements: admin.entitlements });
function fakeSender() {
  const sent: CandidateMail[] = [];
  const sender: CandidateEmailSender = { revision: 'rev-fixture-1', host: 'hr.example.test', send: async (m) => { sent.push(m); } };
  return { sent, sender };
}
const deliver = (sender: CandidateEmailSender | null) => deliverCandidateEmails(sweepCtx(), owner, async () => sender);
const due = () => owner.db.execute(sql`update recruitment_candidate_email set next_attempt_at = now() - interval '1 second'
  where tenant_id = ${base.tenantId}::uuid and status in ('queued','retry')`);
/** Fixture changes past the triggers (guards, immutable columns): owner connection, replica mode, this transaction only. */
const travel = (query: string, params: string[] = []) => owner.client.begin(async (tx) => {
  await tx`set local session_replication_role = replica`;
  await tx.unsafe(query, params);
});
/** A Kuala Lumpur wall-clock "YYYY-MM-DDTHH:MM" some hours from now (Intl, independent of the module). */
const klLocal = (hoursAhead: number) => {
  const at = new Date(Date.now() + hoursAhead * 3_600_000);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kuala_Lumpur' }).format(at);
  return `${todayInKualaLumpur(at)}T${time}`;
};

async function world(opts: { reminders?: boolean; hours?: number } = {}) {
  const [recruiter, manager, interviewer] = await Promise.all([login('Fictional QZF Recruiter'), login('Fictional QZF Manager'), login('Fictional QZF Interviewer')]);
  await jobFormOptions(admin, base.companyId);
  const { id: jobId } = await createJob(admin, { companyId: base.companyId, title: 'QZF Fictional analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
    recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', recruiterUserId: recruiter.userId });
  await addJobMember(admin, jobId, 'hiring_manager', manager.userId);
  await saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: REPLY_TO, senderName: SENDER, locale: 'en',
    reminderEnabled: opts.reminders ?? true, reminderHours: String(opts.hours ?? 24) });
  const { id: addressId } = await saveInterviewAddress(admin, { companyId: base.companyId, name: 'QZF Head office', address: '1 Fictional Road', region: 'Kuala Lumpur', mapUrl: MAP });
  const { id: roomId } = await saveInterviewRoom(admin, { addressId, name: 'Room QZF', capacity: '6' });
  const reason = (await recruitmentSettings(admin, base.companyId)).reasons.find((r) => r.displayed)!;
  const app = await addApplication(recruiter, { jobId, fullName: 'Fictional QZF Applicant', email: 'qzf.applicant@example.test' });
  return { recruiter, manager, interviewer, jobId, addressId, roomId, reasonId: reason.id, applicationId: app.applicationId };
}
type World = Awaited<ReturnType<typeof world>>;
const form = (w: World, s = slot(), over: Record<string, unknown> = {}) => ({ applicationId: w.applicationId, roundNo: '2', type: 'onsite', startsAt: s.startsAt,
  durationMinutes: '45', roomId: w.roomId, interviewerIds: [w.interviewer.userId], ...over });
/** Schedule as the form does: ask for the preview of what is typed, then post its subject and text. */
async function scheduleWithInvitation(w: World, s = slot(), over: Record<string, unknown> = {}) {
  const input = form(w, s, over);
  const p = await previewInterviewInvitation(w.recruiter, input);
  if (p.status !== 'ready') throw new Error(`preview ${p.status}`);
  return { preview: p, result: await scheduleInterview(w.recruiter, input, { send: 'on', subject: p.subject, text: p.text }) };
}

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
beforeEach(async () => {
  relay.available = true;
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
});

describe('case 133 — the invitation states exactly the interview, queued only when ticked, and the preview is what is sent', () => {
  it('queues nothing unless ticked; ticked, freezes exactly the preview with the time, type, room, address and map link and no interviewer', async () => {
    const w = await world();
    const s = slot();
    const offer = await invitationOffer(w.recruiter, w.applicationId);
    expect(offer).toEqual({ recipient: 'qzf.applicant@example.test', senderName: SENDER, replyTo: REPLY_TO, reminderHours: 24 });
    // Unticked: scheduled, nothing queued.
    const plain = await scheduleInterview(w.recruiter, form(w, slot(9), { roomId: '' }));
    expect(plain.email).toBeNull();
    expect(await emails(w.applicationId)).toHaveLength(0);

    const { preview, result } = await scheduleWithInvitation(w, s);
    expect(result.email).toBe('queued');
    const name = await companyName();
    const place = `Room QZF, QZF Head office, 1 Fictional Road, Kuala Lumpur · ${fill(messages('en').recruitment.candidateEmail.interview.map, { url: MAP })}`;
    const want = expected('interview_invitation', { candidateName: 'Fictional QZF Applicant', jobTitle: 'QZF Fictional analyst', companyName: name, senderName: SENDER,
      interviewRound: 'Round 2', interviewType: messages('en').recruitment.candidateEmail.interview.types.onsite, interviewDate: s.interviewDate,
      interviewTime: s.interviewTime, interviewDuration: s.interviewDuration, interviewPlace: place });
    expect({ subject: preview.subject, text: preview.text }).toEqual(want);
    const [inv, rem] = await emails(w.applicationId);
    expect(inv).toMatchObject({ kind: 'interview_invitation', status: 'queued', recipient: 'qzf.applicant@example.test', subject: want.subject, body_text: want.text,
      interview_id: result.id, map_url: MAP, queued_by_user_id: w.recruiter.userId });
    expect(new Date(inv.interview_starts_at!).getTime()).toBe(s.at.getTime());
    // Nothing about the interviewers: neither their name nor the word.
    expect(inv.body_text).not.toContain('Fictional QZF Interviewer');
    expect(inv.body_html).toContain('https://maps.example.test/qzf-hq?q=1&amp;z=2');
    expect(rem.kind).toBe('interview_reminder');
  });

  it('refuses a stale preview, skips a candidate without an address, and blocks a link-like place other than the map link', async () => {
    const w = await world();
    const p = await previewInterviewInvitation(w.recruiter, form(w));
    if (p.status !== 'ready') throw new Error('preview');
    // The form showed one room; the posted text no longer matches what the saved interview renders to.
    expect(await code(scheduleInterview(w.recruiter, form(w, slot(), { roomId: '', addressId: w.addressId }), { send: 'on', subject: p.subject, text: p.text })))
      .toBe('email_changed');
    expect(await emails()).toHaveLength(0);
    // A free-text site that looks like a link: the invitation is not sent; the interview is still scheduled (the person is told).
    const linky = form(w, slot(6), { roomId: '', type: 'onsite', site: 'Level 3, see fictional.example/lobby' });
    const lp = await previewInterviewInvitation(w.recruiter, linky);
    expect(lp).toMatchObject({ status: 'ready', blocked: 'value_link' });
    expect((await scheduleInterview(w.recruiter, linky, { send: 'on', subject: 'x', text: 'y' })).email).toBe('value_link');
    // No usable address.
    await travel(`update recruitment_candidate set email = null where full_name = 'Fictional QZF Applicant'`);
    expect((await invitationOffer(w.recruiter, w.applicationId))?.recipient).toBeNull();
    expect((await scheduleInterview(w.recruiter, form(w, slot(7), { roomId: '' }), { send: 'on', subject: 'x', text: 'y' })).email).toBe('no_email');
    expect(await emails()).toHaveLength(0);
  });

  it('the database refuses an invitation for an interview not scheduled in this transaction, or with another map link or start', async () => {
    const w = await world();
    const { id } = await scheduleInterview(w.recruiter, form(w));
    // Scheduled in an earlier transaction: refused by the statement check.
    expect(await constraintOf(rows(w.recruiter, sql`
      insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
        sender_name, reply_to, queued_by_user_id, interview_id, interview_starts_at, map_url)
      select a.tenant_id, a.company_id, a.job_id, a.id, a.candidate_id, 'interview_invitation', 'en', c.email, 'QZF subject', 'QZF text',
        '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p>QZF</p></body></html>', ${SENDER}, ${REPLY_TO}, ${w.recruiter.userId}::uuid,
        i.id, i.starts_at, ${MAP}
      from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id join recruitment_interview i on i.id = ${id}::uuid
      where a.id = ${w.applicationId}::uuid`))).toBe('recruitment_candidate_email_interview');
    // A link in the text other than the frozen map link is refused by the row CHECK.
    expect(await constraintOf(owner.db.execute(sql`
      insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
        sender_name, reply_to, queued_by_user_id, interview_id, interview_starts_at, map_url)
      select a.tenant_id, a.company_id, a.job_id, a.id, a.candidate_id, 'interview_invitation', 'en', c.email, 'QZF subject', ${`Map ${MAP} and https://evil.example/x`},
        '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p>QZF</p></body></html>', ${SENDER}, ${REPLY_TO}, ${w.recruiter.userId}::uuid,
        i.id, i.starts_at, ${MAP}
      from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id join recruitment_interview i on i.id = ${id}::uuid
      where a.id = ${w.applicationId}::uuid`))).toBe('recruitment_candidate_email_body_text_check');
    // A map link on a rejection is refused (only invitations and reminders carry one).
    expect(await constraintOf(owner.db.execute(sql`
      insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
        sender_name, reply_to, queued_by_user_id, map_url)
      select a.tenant_id, a.company_id, a.job_id, a.id, a.candidate_id, 'rejection', 'en', c.email, 'QZF subject', 'QZF text',
        '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p>QZF</p></body></html>', ${SENDER}, ${REPLY_TO}, ${w.recruiter.userId}::uuid, ${MAP}
      from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id where a.id = ${w.applicationId}::uuid`))).toBe('recruitment_candidate_email_subject_ck');
  });
});

describe('case 134 — one reminder per invited interview at the company offset, withdrawn by cancellation or the application closing', () => {
  it('queues one reminder at start minus the hours; none when reminders are off or the time has passed; never a second', async () => {
    const w = await world({ hours: 30 });
    const s = slot();
    const { result } = await scheduleWithInvitation(w, s);
    const reminders = (await emails(w.applicationId)).filter((e) => e.kind === 'interview_reminder');
    expect(reminders).toHaveLength(1);
    expect(new Date(reminders[0].next_attempt_at).getTime()).toBe(s.at.getTime() - 30 * 3_600_000);
    expect(reminders[0].body_text).toContain(s.interviewTime);
    // One reminder per interview: a second is refused by the unique key.
    expect(await constraintOf(owner.db.execute(sql`insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale,
      recipient, subject, body_text, body_html, sender_name, reply_to, queued_by_user_id, interview_id, interview_starts_at, next_attempt_at, map_url)
      select tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html, sender_name, reply_to,
        queued_by_user_id, interview_id, interview_starts_at, next_attempt_at, map_url from recruitment_candidate_email where id = ${reminders[0].id}::uuid`)))
      .toBe('recruitment_candidate_email_interview_uq');
    // An interview closer than the offset: invitation only.
    await scheduleWithInvitation(w, { ...slot(1), startsAt: klLocal(3) }, { roomId: '' });
    expect((await emails(w.applicationId)).filter((e) => e.kind === 'interview_reminder')).toHaveLength(1);
    // Reminders off: invitation only.
    await saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: REPLY_TO, senderName: SENDER, locale: 'en', reminderEnabled: false, reminderHours: '24' });
    expect((await invitationOffer(w.recruiter, w.applicationId))?.reminderHours).toBeNull();
    await scheduleWithInvitation(w, slot(8), { roomId: '' });
    const all = await emails(w.applicationId);
    expect(all.filter((e) => e.kind === 'interview_invitation')).toHaveLength(3);
    expect(all.filter((e) => e.kind === 'interview_reminder')).toHaveLength(1);
    expect(reminders[0].interview_id).toBe(result.id);
  });

  it('cancelling the interview withdraws its waiting invitation and reminder; closing the application does too; the sweep never sends them', async () => {
    const w = await world();
    const { result } = await scheduleWithInvitation(w);
    expect((await cancelInterview(w.recruiter, result.id)).email).toBeNull();
    const after = await emails(w.applicationId);
    expect(after.map((e) => [e.kind, e.status])).toEqual([['interview_invitation', 'withdrawn'], ['interview_reminder', 'withdrawn']]);
    expect(after.every((e) => e.completed_at !== null)).toBe(true);
    // Application closing (reject) cancels its future interviews and withdraws their e-mails in the same statement.
    const second = await scheduleWithInvitation(w, slot(6), { roomId: '' });
    await rejectApplication(w.manager, w.applicationId, w.reasonId);
    const closed = (await emails(w.applicationId)).filter((e) => e.interview_id === second.result.id);
    expect(closed.map((e) => e.status)).toEqual(['withdrawn', 'withdrawn']);
    await due();
    const { sent, sender } = fakeSender();
    expect((await deliver(sender)).claimed).toBe(0);
    expect(sent).toHaveLength(0);
    // The page lists them as withdrawn.
    expect((await applicationCandidateEmails(w.recruiter, w.applicationId))!.rows.map((r) => r.state)).toEqual(['withdrawn', 'withdrawn', 'withdrawn', 'withdrawn']);
  });

  it('the sweep does not send an invitation whose interview was cancelled or moved after it was leased or queued', async () => {
    const w = await world({ reminders: false });
    const { result } = await scheduleWithInvitation(w);
    // Move the interview past the guards (fixture time travel): the frozen start no longer matches, so it is not eligible.
    await travel(`update recruitment_interview set starts_at = starts_at + interval '1 hour' where id = $1`, [result.id]);
    const { sent, sender } = fakeSender();
    await deliver(sender);
    expect(sent).toHaveLength(0);
    expect((await emails(w.applicationId))[0]).toMatchObject({ status: 'failed', error_code: 'notEligible' });
  });
});

describe('case 134 (cancellation) — a person cancelling may e-mail the candidate after seeing it', () => {
  it('previews per open interview, queues only when ticked with the fingerprint, and never for an automatic cancel', async () => {
    const w = await world({ reminders: false });
    const s = slot();
    const { id } = await scheduleInterview(w.recruiter, form(w, s));
    const previews = await interviewCancellationPreviews(w.recruiter, w.applicationId);
    const p = previews[id];
    const want = expected('interview_cancelled', { candidateName: 'Fictional QZF Applicant', jobTitle: 'QZF Fictional analyst', companyName: await companyName(),
      senderName: SENDER, interviewRound: 'Round 2', interviewType: messages('en').recruitment.candidateEmail.interview.types.onsite, interviewDate: s.interviewDate,
      interviewTime: s.interviewTime });
    expect({ subject: p.subject, text: p.text }).toEqual(want);
    expect(p.text).not.toContain(MAP);
    // A hiring manager (not an operator) gets no preview.
    expect(await interviewCancellationPreviews(w.manager, w.applicationId)).toEqual({});
    expect(await code(cancelInterview(w.recruiter, id, { send: 'on', fingerprint: 'stale' }))).toBe('email_changed');
    expect((await cancelInterview(w.recruiter, id, { send: 'on', fingerprint: p.fingerprint })).email).toBe('queued');
    const [c] = await emails(w.applicationId);
    expect(c).toMatchObject({ kind: 'interview_cancelled', subject: want.subject, body_text: want.text, map_url: null, interview_id: id });
    // The automatic cancel on close sends nothing.
    await scheduleInterview(w.recruiter, form(w, slot(6), { roomId: '' }));
    await rejectApplication(w.manager, w.applicationId, w.reasonId);
    expect((await emails(w.applicationId)).filter((e) => e.kind === 'interview_cancelled')).toHaveLength(1);
  });
});

describe('case 135 — offer e-mails: a person, an Approved offer, only the fields marked for e-mail, recorded as sent', () => {
  async function approvedOffer(w: World) {
    const fields = (await offerSettings(admin, base.companyId)).fields;
    const f = (label: string) => fields.find((x) => x.label === label)!;
    // Mark the job title and the salary for e-mail (the salary as entered); leave the department out.
    for (const label of ['Job offered', 'Basic salary']) {
      const x = f(label);
      await saveOfferField(admin, { id: x.id, label: x.label, required: x.required, needsApproval: x.needsApproval, private: x.private, enabled: x.enabled, includeInEmail: 'on' });
    }
    await saveApprovalFlow(admin, base.companyId, 'offer', []);
    const { id } = await saveOffer(w.recruiter, w.applicationId, {
      [f('Job offered').id]: { text: 'Fictional data analyst' }, [f('Department').id]: { text: 'QZF Finance' }, [f('Commencement date').id]: { text: '2026-12-01' },
      [f('Basic salary').id]: { amount: '5000.50', currency: 'MYR' },
    });
    return { offerId: id, salary: f('Basic salary') };
  }

  it('is offered only for an Approved offer; states only marked fields as entered; sending records the offer as sent by e-mail', async () => {
    const w = await world();
    const { offerId } = await approvedOffer(w);
    expect(await offerEmailPreview(w.recruiter, w.applicationId)).toBeNull(); // still a draft
    expect(await code(sendOfferByEmail(w.recruiter, offerId, 'x'))).toBe('offer_state');
    expect(await submitOffer(w.recruiter, offerId)).toBe('approved');
    const p = (await offerEmailPreview(w.recruiter, w.applicationId))!;
    expect(p.blocked).toBeNull();
    const want = expected('offer', { candidateName: 'Fictional QZF Applicant', jobTitle: 'QZF Fictional analyst', companyName: await companyName(), senderName: SENDER,
      offerDetails: 'Job offered: Fictional data analyst\nBasic salary: MYR 5000.50' });
    expect({ subject: p.subject, text: p.text }).toEqual(want);
    expect(p.text).not.toContain('QZF Finance');
    // Mark as sent by e-mail is replaced while candidate e-mail is on; other channels stay.
    expect(await code(markOfferSent(w.recruiter, offerId, 'email'))).toBe('email_use_send');
    expect(await code(sendOfferByEmail(w.recruiter, offerId, 'stale'))).toBe('email_changed');
    // A hiring manager (who does not operate the job) cannot send it: the offer is not theirs to lock.
    expect(await code(sendOfferByEmail(w.manager, offerId, p.fingerprint))).toMatch(/^(forbidden|not_found)$/);
    await sendOfferByEmail(w.recruiter, offerId, p.fingerprint);
    const [o] = await owner.db.execute<{ sent_channel: string; sent_by_user_id: string; sent_at: string }>(sql`select sent_channel, sent_by_user_id, sent_at from recruitment_offer where id = ${offerId}::uuid`);
    expect(o).toMatchObject({ sent_channel: 'email', sent_by_user_id: w.recruiter.userId });
    const [e] = await emails(w.applicationId);
    expect(e).toMatchObject({ kind: 'offer', offer_id: offerId, subject: want.subject, body_text: want.text, queued_by_user_id: w.recruiter.userId });
    expect(new Date(e.queued_at).getTime()).toBe(new Date(o.sent_at).getTime());
    expect(e.body_html).toContain('Job offered: Fictional data analyst<br>Basic salary: MYR 5000.50');
    // Sent once: a second send is refused.
    expect(await code(sendOfferByEmail(w.recruiter, offerId, p.fingerprint))).toBe('offer_state');
  });

  it('the database refuses an offer e-mail for an offer not approved or not sent by e-mail in this transaction', async () => {
    const w = await world();
    const { offerId } = await approvedOffer(w);
    const insert = () => rows(w.recruiter, sql`
      insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
        sender_name, reply_to, queued_by_user_id, offer_id)
      select a.tenant_id, a.company_id, a.job_id, a.id, a.candidate_id, 'offer', 'en', c.email, 'QZF subject', 'QZF text',
        '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p>QZF</p></body></html>', ${SENDER}, ${REPLY_TO}, ${w.recruiter.userId}::uuid, ${offerId}::uuid
      from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id where a.id = ${w.applicationId}::uuid`);
    expect(await constraintOf(insert())).toBe('recruitment_candidate_email_offer'); // draft
    await submitOffer(w.recruiter, offerId);
    expect(await constraintOf(insert())).toBe('recruitment_candidate_email_offer'); // approved but not sent in this transaction
  });

  it('a marked private field the sender cannot see blocks the send; an offer re-issued after queueing is not sent', async () => {
    const w = await world();
    const { offerId, salary } = await approvedOffer(w);
    await saveOfferField(admin, { id: salary.id, label: salary.label, required: salary.required, needsApproval: salary.needsApproval, private: 'on', enabled: true, includeInEmail: 'on' });
    await submitOffer(w.recruiter, offerId);
    const assistant = await login('Fictional QZF Assistant');
    await addJobMember(admin, w.jobId, 'assistant', assistant.userId);
    const hidden = (await offerEmailPreview(assistant, w.applicationId))!;
    expect(hidden.blocked).toBe('private_hidden');
    expect(hidden.text).not.toContain('5000.50');
    expect(await code(sendOfferByEmail(assistant, offerId, hidden.fingerprint))).toBe('email_private_field');
    // The recruiter sees it and sends; then the offer is re-issued (a value changes, so it must be sent again): the queued e-mail is not eligible.
    const p = (await offerEmailPreview(w.recruiter, w.applicationId))!;
    expect(p.blocked).toBeNull();
    await sendOfferByEmail(w.recruiter, offerId, p.fingerprint);
    await travel('update recruitment_offer set sent_at = null, sent_channel = null, sent_by_user_id = null, valid_days = null where id = $1', [offerId]);
    const { sent, sender } = fakeSender();
    await deliver(sender);
    expect(sent).toHaveLength(0);
    expect((await emails(w.applicationId))[0]).toMatchObject({ status: 'failed', error_code: 'notEligible' });
  });
});

describe('templates and settings for the new kinds', () => {
  it('allows each kind its own placeholders only, in the service and the database', async () => {
    await saveCandidateEmailSettings(admin, base.companyId, { enabled: false });
    expect(await code(saveCandidateEmailTemplate(admin, { companyId: base.companyId, kind: 'interview_invitation', locale: 'en', subject: 'At {interviewTime}',
      body: 'Dear {candidateName}, {interviewPlace}' }))).toBe('ok');
    expect(await code(saveCandidateEmailTemplate(admin, { companyId: base.companyId, kind: 'interview_cancelled', locale: 'en', subject: 'Cancelled',
      body: 'Was at {interviewPlace}' }))).toBe('email_placeholder');
    expect(await code(saveCandidateEmailTemplate(admin, { companyId: base.companyId, kind: 'rejection', locale: 'en', subject: 'x', body: '{offerDetails}' })))
      .toBe('email_placeholder');
    expect(await constraintOf(rows(admin, sql`insert into recruitment_candidate_email_template (tenant_id, company_id, kind, locale, subject, body, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'offer', 'ms', 'x', '{interviewTime}', app.current_user_id(), app.current_user_id())`)))
      .toBe('recruitment_candidate_email_template_placeholders');
    expect(await code(saveCandidateEmailSettings(admin, base.companyId, { enabled: false, reminderHours: '1' }))).toBe('invalid_input');
    expect(await code(saveCandidateEmailSettings(admin, base.companyId, { enabled: false, reminderHours: '73' }))).toBe('invalid_input');
    expect(await constraintOf(travel('update recruitment_candidate_email_setting set reminder_hours = 1 where company_id = $1', [base.companyId])))
      .toBe('recruitment_candidate_email_setting_reminder_hours_ck');
  });
});
