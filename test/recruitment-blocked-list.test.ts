/**
 * Recruitment slice 13 against Postgres — the blocked list: acceptance cases 90–93
 * (docs/recruitment-reconstruction/specification.md "Slice 13 acceptance cases"), through the service AND directly as the app
 * role, with every insert channel (manual entry, careers page, employee referral, agency) and a rehearsal under a
 * NOBYPASSRLS table owner with row security forced. Pools (cases 88–89) are test/recruitment-pools.test.ts; case 94 is the
 * lead's rendered check.
 *
 * Expected values are computed independently of packs/recruitment/blocked-list.ts and 5213's matching: which applications
 * match is decided here from the fixture's own identity values by the rule written out again (same ID number, or the same
 * name plus the same e-mail or mobile), and checked against plain owner-connection SQL that ignores row security. Every person
 * is fictional. Reasons carry LETTER sentinels (QZX…: no UUID, timestamp or number can contain them); the mobile is checked as
 * a whole value.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addCalendarMonths, todayInKualaLumpur } from '../lib/hr-date';
import {
  acceptAgencySubmission, addApplication, addCandidateToPool, addJobMember, applicationReview, assignAgencyContract, blockCandidate, blockedList, candidateBoard,
  createJob, deletePool, destroyCandidates, linkHireDraft, moveApplication, poolNav, recordAgencySubmission, recruitmentPipelineCounts, recruitmentSettings,
  rejectApplication, resolveReviewMark, saveAgency, saveAgencyConsultant, saveAgencyContract, saveOffer, savePool, scheduleInterview, setCareersPublished,
  setJobCareersPage, setJobReferralPortal, submitCareersApplication, submitReferral, talentPool, unblockCandidate, updateCareersSettings, RecruitmentError,
  markOfferSent, offerSettings, recordOfferDecision, sendForScreening, submitOffer,
} from '../packs/recruitment/service';
import { applicationReviewTx } from '../packs/recruitment/blocked-list';
import { closeCareersPool } from '../packs/recruitment/careers';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const NEW_TABLES = ['recruitment_application_review_mark', 'recruitment_blocked_entry', 'recruitment_blocked_entry_restricted', 'recruitment_blocked_history',
  'recruitment_talent_pool', 'recruitment_talent_pool_member', 'recruitment_talent_pool_share'];
const REASON = 'QZXREASON fictional conduct note';
const REMOVAL = 'QZXREMOVAL fictional review outcome';
/** The listed person X. The ID number is shared on purpose with Y, the name and mobile with W, the e-mail and mobile with V,
 *  the e-mail alone with Z. */
const X = { fullName: 'Fictional Qzxblocked Person', email: 'qzxblocked@example.test', phone: '+60 12-345 7788', idNumber: 'QZX-998877' };
const MOBILE_DIGITS = '60123457788';
let base: Base;
let admin: SessionContext;
let gradeId: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
const rows = <T = Record<string, unknown>>(ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute<T & Record<string, unknown>>(query));
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
const today = () => todayInKualaLumpur();
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hashOf = (label: string) => createHash('sha256').update(`fictional-blocked-client:${label}`).digest('hex');
const ADDRESS = 'fictional-blocked-careers';
let seq = 0;

/** Job 1 (recruiter r1, hiring manager hm), job 2 (recruiter r2), job 3 (careers page, r1), job 4 (referral portal, r1). */
async function fixture() {
  const [r1, r2, hm, iv, bystander, worker] = await Promise.all([login('Fictional Recruiter One'), login('Fictional Recruiter Two'), login('Fictional Manager'),
    login('Fictional Interviewer'), login('Fictional Bystander'), login('Fictional Referrer')]);
  const job = { companyId: base.companyId, jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time',
    description: 'Fictional description.' };
  const { id: job1 } = await createJob(admin, { ...job, title: 'Fictional analyst', recruiterUserId: r1.userId });
  const { id: job2 } = await createJob(admin, { ...job, title: 'Fictional engineer', recruiterUserId: r2.userId });
  const { id: job3 } = await createJob(admin, { ...job, title: 'Fictional public role', recruiterUserId: r1.userId });
  const { id: job4 } = await createJob(admin, { ...job, title: 'Fictional referral role', recruiterUserId: r1.userId });
  await addJobMember(admin, job1, 'hiring_manager', hm.userId);
  await updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional Careers Sdn Bhd', notice: 'Fictional privacy notice.' });
  await setCareersPublished(admin, base.companyId, true);
  await setJobCareersPage(admin, job3, true);
  await setJobReferralPortal(admin, job4, true);
  return { r1, r2, hm, iv, bystander, worker, job1, job2, job3, job4 };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const manual = (ctx: SessionContext, jobId: string, who: { fullName: string; email?: string; phone?: string; idNumber?: string }, confirm = false) =>
  addApplication(ctx, { jobId, fullName: who.fullName, email: who.email, phone: who.phone, idNumber: who.idNumber, idType: who.idNumber ? 'nric' : undefined,
    confirmSeparate: confirm ? 'on' : undefined });
const careers = (jobId: string, who: { fullName: string; email: string; mobile?: string }) => submitCareersApplication({
  address: ADDRESS, jobId, fullName: who.fullName, email: who.email, mobile: who.mobile ?? '', message: '', consent: 'on', noticeVersion: '1', website: '',
  resume: null, clientHash: () => hashOf(`c${++seq}`), currentNoticeVersion: 1,
});
const openMarks = async () => (await owner.db.execute<{ application_id: string }>(sql`select application_id from recruitment_application_review_mark
  where tenant_id = ${base.tenantId}::uuid and cleared_at is null order by application_id`)).map((r) => r.application_id);
const applicationsOf = async (fullName: string) => (await owner.db.execute<{ id: string }>(sql`select a.id from recruitment_application a
  join recruitment_candidate c on c.id = a.candidate_id where c.tenant_id = ${base.tenantId}::uuid and c.full_name = ${fullName} order by a.applied_at`)).map((r) => r.id);
const markOf = async (applicationId: string) => (await owner.db.execute<{ id: string }>(sql`select id from recruitment_application_review_mark
  where application_id = ${applicationId}::uuid and cleared_at is null`))[0]?.id;
async function stagesOf(jobId: string) {
  return owner.db.execute<{ id: string; system_key: string | null }>(sql`select ps.stage_id as id, st.system_key from recruitment_job_opening j
    join recruitment_process_stage ps on ps.process_id = j.process_id join recruitment_stage st on st.id = ps.stage_id where j.id = ${jobId}::uuid and st.enabled
    order by ps.position`);
}
/** The rule, written out again from the spec (slice 13): the same ID number; the same name plus the same e-mail or mobile; or
 *  the same e-mail and the same mobile. */
const n = (v?: string | null) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase() || null;
const nId = (v?: string | null) => (v ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase() || null;
const nMob = (v?: string | null) => (v ?? '').replace(/[^0-9]/g, '') || null;
const matches = (who: { fullName: string; email?: string; phone?: string; mobile?: string; idNumber?: string }) =>
  (!!nId(who.idNumber) && nId(who.idNumber) === nId(X.idNumber))
  || (n(who.fullName) === n(X.fullName) && ((!!n(who.email) && n(who.email) === n(X.email)) || (!!nMob(who.phone ?? who.mobile) && nMob(who.phone ?? who.mobile) === nMob(X.phone))))
  || (!!n(who.email) && n(who.email) === n(X.email) && !!nMob(who.phone ?? who.mobile) && nMob(who.phone ?? who.mobile) === nMob(X.phone));

/** X on job 1, and the people around them on jobs 1 and 2, before X is listed. */
async function people(f: Fx) {
  const x = await manual(f.r1, f.job1, X);
  const Y = { fullName: 'Fictional Yusof Rahman', email: 'yusof.r@example.test', idNumber: 'qzx 998877' };
  const W = { fullName: '  fictional   QZXBLOCKED person ', email: 'w.other@example.test', phone: '60-12 345 7788' };
  const Z = { fullName: 'Fictional Zara Lim', email: 'QZXBLOCKED@example.test' };
  const V = { fullName: 'Fictional Vincent Tan', email: X.email, phone: X.phone };
  const y = await manual(admin, f.job2, Y, true);
  const w = await manual(admin, f.job1, W, true);
  const z = await manual(f.r1, f.job1, Z);
  const v = await manual(admin, f.job1, V, true);
  return { x, y, w, z, v, who: { Y, W, Z, V } };
}

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
beforeEach(async () => {
  await resetDb();
  await owner.db.execute(sql`delete from app.recruitment_careers_attempt`);
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
});

describe('case 91 — marking on adding an entry and on every channel; one-field matches are not; a marked application is held', () => {
  it('marks the candidate\'s and matching active applications, every channel\'s matching new application, and holds them (service and database)', async () => {
    const f = await fixture();
    const p = await people(f);
    // W is at Onboarding before X is listed (for the hire refusal below).
    const onboarding = (await stagesOf(f.job1)).find((s) => s.system_key === 'onboarding')!.id;
    await moveApplication(f.r1, p.w.applicationId, onboarding);
    expect(await openMarks()).toEqual([]);
    const { entryId, marked } = await blockCandidate(admin, p.x.candidateId, REASON);
    // Independently: X's own application, and of the others exactly those the rule matches (Y by ID; W by name + mobile; V by
    // e-mail + mobile). Z shares the e-mail only.
    expect(Object.entries(p.who).filter(([, who]) => matches(who)).map(([k]) => k).sort()).toEqual(['V', 'W', 'Y']);
    const expected = [p.x.applicationId, p.y.applicationId, p.w.applicationId, p.v.applicationId].sort();
    expect(await openMarks()).toEqual(expected);
    expect(marked).toBe(4);
    expect((await owner.db.execute(sql`select 1 from recruitment_application_review_mark where entry_id = ${entryId}::uuid`)).length).toBe(4);

    // New applications after the entry, one per channel, each with a matching and a one-field (non-matching) person.
    const manualMatch = { fullName: 'FICTIONAL QZXBLOCKED   PERSON', email: 'QzxBlocked@Example.test' };
    const manualOneField = { fullName: 'Fictional Other Person', email: 'other.manual@example.test', phone: X.phone };
    const m1 = await manual(admin, f.job2, manualMatch, true);
    const m2 = await manual(f.r2, f.job2, manualOneField);
    const careersMatch = { fullName: 'fictional qzxblocked person', email: 'QZXBLOCKED@example.test' };
    const careersOneField = { fullName: 'Fictional Careers Other', email: 'careers.other@example.test', mobile: '60123457788' };
    const careersStranger = { fullName: 'Fictional Careers Stranger', email: 'stranger@example.test' };
    const responses = [await careers(f.job3, careersMatch), await careers(f.job3, careersOneField), await careers(f.job3, careersStranger)];
    // The careers page answers a listed person exactly as anyone else.
    expect(responses).toEqual([{ ok: true, outcome: 'received' }, { ok: true, outcome: 'received' }, { ok: true, outcome: 'received' }]);
    const referralMatch = { fullName: 'Fictional QZXBLOCKED Person', mobile: '+60 123457788', email: '' };
    const referralStranger = { fullName: 'Fictional Referral Stranger', email: 'referral.stranger@example.test', mobile: '' };
    const refA = await submitReferral(f.worker, { jobId: f.job4, ...referralMatch, reason: 'Fictional referral reason', confirmed: true });
    const refB = await submitReferral(f.worker, { jobId: f.job4, ...referralStranger, reason: 'Fictional referral reason', confirmed: true });
    // The referrer is answered exactly as for anyone else (the same shape, nothing about the list).
    expect(Object.keys(refA)).toEqual(Object.keys(refB));
    expect(Object.keys(refA)).toEqual(['referralId']);
    // An agency submission of the same person waits for review (slice 10: a Duplicate outside protection); accepted as a new
    // candidate, its application is marked.
    const { id: agencyId } = await saveAgency(admin, { companyId: base.companyId, name: 'Fictional Agency' });
    const { id: contractId } = await saveAgencyContract(admin, { agencyId, name: 'Fictional contract', contractType: 'headhunter', feeRate: '10',
      startsOn: addDays(today(), -10), endsOn: addDays(today(), 100), hrContactUserId: base.adminUserId, access: 'public' });
    const { id: consultantId } = await saveAgencyConsultant(admin, { contractId, name: 'Fictional Consultant', email: 'consultant@agency.example.test' });
    await assignAgencyContract(f.r1, f.job1, contractId);
    const sub = await recordAgencySubmission(f.r1, { jobId: f.job1, contractId, consultantId, fullName: 'Fictional Qzxblocked Person', email: 'qzxblocked@example.test' });
    expect(sub.outcome).toBe('waiting');
    const accepted = await acceptAgencySubmission(admin, sub.submissionId);
    const agencyOneField = await recordAgencySubmission(f.r1, { jobId: f.job1, contractId, consultantId, fullName: 'Fictional Agency Other', email: 'agency.other@example.test',
      mobile: X.phone });
    expect(agencyOneField.outcome).toBe('accepted');

    // Independently computed: every application whose candidate matches the rule (or is X), across all channels.
    const all = await owner.db.execute<{ id: string; candidate_id: string; full_name: string; email: string | null; phone: string | null; id_number: string | null }>(sql`
      select a.id, a.candidate_id, c.full_name, c.email, c.phone, r.id_number from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id
      left join recruitment_candidate_restricted r on r.candidate_id = c.id where a.tenant_id = ${base.tenantId}::uuid and a.state = 'active'`);
    const want = all.filter((a) => a.candidate_id === p.x.candidateId || matches({ fullName: a.full_name, email: a.email ?? undefined, phone: a.phone ?? undefined,
      idNumber: a.id_number ?? undefined })).map((a) => a.id).sort();
    expect(want.length).toBe(8); // X, Y, W, V, manual, careers, referral, agency
    expect(await openMarks()).toEqual(want);
    for (const id of [p.v.applicationId, m1.applicationId, accepted.applicationId, ...(await applicationsOf(careersMatch.fullName)), ...(await applicationsOf(referralMatch.fullName))]) {
      expect(want, id).toContain(id);
    }
    for (const id of [m2.applicationId, p.z.applicationId, agencyOneField.applicationId!, ...(await applicationsOf(careersOneField.fullName)),
      ...(await applicationsOf(careersStranger.fullName)), ...(await applicationsOf(referralStranger.fullName))]) {
      expect(want, id).not.toContain(id);
    }
    // The history: one "added", one "marked" per mark; the channels' marks have no actor.
    const history = await owner.db.execute<{ action: string; actor: string | null }>(sql`select action, actor_user_id as actor from recruitment_blocked_history
      where entry_id = ${entryId}::uuid order by occurred_at, action`);
    expect(history.filter((h) => h.action === 'added')).toHaveLength(1);
    expect(history.filter((h) => h.action === 'marked')).toHaveLength(8);

    // Held: no move (forward or chosen), no offer, no hire — service and database. Rejecting stays possible.
    const stages = await stagesOf(f.job1);
    expect(await code(moveApplication(f.r1, p.x.applicationId))).toBe('needs_review');
    expect(await code(moveApplication(f.hm, p.x.applicationId))).toBe('needs_review');
    expect(await code(moveApplication(f.r1, p.x.applicationId, stages[2].id))).toBe('needs_review');
    expect(await constraintOf(rows(f.r1, sql`update recruitment_application set current_stage_id = ${stages[1].id}::uuid where id = ${p.x.applicationId}::uuid`)))
      .toBe('recruitment_application_needs_review');
    expect(await constraintOf(rows(f.hm, sql`update recruitment_application set current_stage_id = ${stages[1].id}::uuid where id = ${p.x.applicationId}::uuid`)))
      .toBe('recruitment_application_needs_review');
    expect(await code(saveOffer(f.r1, p.x.applicationId, {}))).toBe('needs_review');
    expect(await constraintOf(rows(f.r1, sql`insert into recruitment_offer (tenant_id, company_id, job_id, application_id, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.job1}::uuid, ${p.x.applicationId}::uuid, ${f.r1.userId}::uuid, ${f.r1.userId}::uuid)`)))
      .toBe('recruitment_application_needs_review');
    expect(await code(moveApplication(f.r1, p.w.applicationId))).toBe('needs_review'); // from Onboarding, forward is "hired"
    expect(await constraintOf(rows(f.r1, sql`update recruitment_application set state = 'hired' where id = ${p.w.applicationId}::uuid`))).toBe('recruitment_application_needs_review');
    expect(await code(linkHireDraft(admin, p.w.applicationId, randomUUID()))).toBe('needs_review');
    expect(await owner.db.execute(sql`select 1 from recruitment_offer where application_id = ${p.x.applicationId}::uuid`)).toHaveLength(0);
    expect((await owner.db.execute<{ state: string; current_stage_id: string }>(sql`select state, current_stage_id from recruitment_application where id = ${p.w.applicationId}::uuid`))[0])
      .toEqual({ state: 'active', current_stage_id: onboarding });
    // An unmarked application moves as before; a marked one can still be rejected.
    expect((await moveApplication(f.r1, p.z.applicationId)).state).toBe('active');
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, m1.applicationId, reason.id);
    // The board shows "needs review" to every reader of the card, and offers no move on it.
    const board = await candidateBoard(f.hm, [base.companyId], { jobId: f.job1 });
    expect(board.cards.find((c) => c.id === p.x.applicationId)?.needsReview).toBe(true);
    expect(board.cards.find((c) => c.id === agencyOneField.applicationId)?.needsReview).toBe(false);
  });
});

describe('case 90 — who changes the list, who reads reasons, what each viewer is told', () => {
  it('only administrators add and remove entries and read reasons; operators see the flag; others see only "needs review"', async () => {
    const f = await fixture();
    const p = await people(f);
    await scheduleInterview(f.r1, { applicationId: p.w.applicationId, type: 'onsite', startsAt: new Date(Date.now() + 86_400_000), interviewerIds: [f.iv.userId] });
    // Only administrators add (service and database).
    expect(await code(blockCandidate(f.r1, p.x.candidateId, REASON))).toBe('forbidden');
    expect(await code(rows(f.r1, sql`select app.recruitment_block_candidate(${p.x.candidateId}::uuid, 'Fictional direct')`))).toBe('42501');
    expect(await code(rows(f.r1, sql`insert into recruitment_blocked_entry (tenant_id, company_id, candidate_id, created_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${p.x.candidateId}::uuid, ${f.r1.userId}::uuid)`))).toBe('42501');
    // Not even an administrator writes the tables directly: no grant; the function is the only way.
    expect(await code(rows(admin, sql`insert into recruitment_blocked_entry (tenant_id, company_id, candidate_id, created_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${p.x.candidateId}::uuid, ${base.adminUserId}::uuid)`))).toBe('42501');
    expect(await code(blockCandidate(admin, p.x.candidateId, '  '))).toBe('reason_required');
    expect(await code(blockCandidate(admin, p.x.candidateId, 'x'.repeat(501)))).toBe('invalid_input');
    expect(await constraintOf(rows(admin, sql`select app.recruitment_block_candidate(${p.x.candidateId}::uuid, '')`))).toBe('recruitment_blocked_reason');
    const { entryId } = await blockCandidate(admin, p.x.candidateId, REASON);
    expect(await code(blockCandidate(admin, p.x.candidateId, REASON))).toBe('already_blocked');
    const yMark = (await markOf(p.y.applicationId))!;
    expect(await code(rows(admin, sql`update recruitment_application_review_mark set cleared_at = now() where id = ${yMark}::uuid`))).toBe('42501');
    expect(await code(unblockCandidate(f.r1, entryId, REMOVAL))).toBe('forbidden');
    expect(await code(resolveReviewMark(f.r1, yMark, 'not_same_person'))).toMatch(/^(forbidden|not_found)$/);
    expect(await code(rows(f.r1, sql`select app.recruitment_unblock_candidate(${entryId}::uuid, 'Fictional direct')`))).toBe('42501');
    expect(await code(rows(f.r2, sql`select app.recruitment_resolve_review_mark(${yMark}::uuid, 'not_same_person', null)`))).toBe('42501');
    expect(await markOf(p.y.applicationId)).toBe(yMark);

    // Administrators: the reason and who matched.
    const adminList = await blockedList(admin, [base.companyId]);
    expect(adminList.entries.map((e) => [e.candidateId, e.reason, e.openMarks])).toEqual([[p.x.candidateId, REASON, 4]]);
    const adminY = await applicationReview(admin, p.y.applicationId);
    expect(adminY).toMatchObject({ view: 'admin', needsReview: true });
    expect(adminY.marks).toEqual([expect.objectContaining({ matchedSelf: false, entryId, blockedCandidateId: p.x.candidateId, blockedCandidateName: X.fullName, reason: REASON })]);
    // r1 operates X's job: the flag on X, never the reason.
    const r1List = await blockedList(f.r1, [base.companyId]);
    expect(r1List).toMatchObject({ isAdmin: false, history: null });
    expect(r1List.entries.map((e) => [e.candidateId, e.reason])).toEqual([[p.x.candidateId, null]]);
    const r1X = await applicationReview(f.r1, p.x.applicationId);
    expect(r1X).toMatchObject({ view: 'operator', needsReview: true, candidate: { candidateId: p.x.candidateId, entryId, reason: null, canBlock: false } });
    expect(r1X.marks).toEqual([expect.objectContaining({ matchedSelf: true, entryId: null, blockedCandidateId: null, blockedCandidateName: null, reason: null })]);
    // r2 operates Y's job: Y matches the list; who X is stays hidden.
    expect((await blockedList(f.r2, [base.companyId])).entries).toEqual([]);
    const r2Y = await applicationReview(f.r2, p.y.applicationId);
    expect(r2Y).toMatchObject({ view: 'operator', needsReview: true, candidate: { entryId: null, reason: null } });
    expect(r2Y.marks).toEqual([expect.objectContaining({ matchedSelf: false, blockedCandidateName: null, reason: null })]);
    // The hiring manager and the interviewer: exactly "needs review", nothing more.
    expect(await applicationReview(f.hm, p.x.applicationId)).toEqual({ view: 'reader', needsReview: true, marks: [], candidate: null });
    expect(await applicationReview(f.iv, p.w.applicationId)).toEqual({ view: 'reader', needsReview: true, marks: [], candidate: null });
    expect(await applicationReview(f.hm, p.z.applicationId)).toEqual({ view: 'reader', needsReview: false, marks: [], candidate: null });
    expect(await code(applicationReview(f.bystander, p.x.applicationId))).toMatch(/^(forbidden|not_found)$/);
    expect(await poolNav(f.hm, [base.companyId])).toEqual({ pools: [], blockedCount: 0 });
    // Sentinel: no reason in anything a non-administrator is given.
    const given = JSON.stringify([r1List, r1X, r2Y, await applicationReview(f.hm, p.x.applicationId), await candidateBoard(f.r1, [base.companyId], { jobId: f.job1 }),
      await candidateBoard(f.hm, [base.companyId], { jobId: f.job1 }), await poolNav(f.r1, [base.companyId])]);
    expect(given).not.toMatch(/QZXREASON/i);
    expect(JSON.stringify(r2Y)).not.toMatch(/QZXBLOCKED/i);
    // Directly as the app role.
    const restricted = sql`select reason, id_norm, name_norm, email_norm, mobile_norm from recruitment_blocked_entry_restricted`;
    expect(await rows(admin, restricted)).toHaveLength(1);
    for (const who of [f.r1, f.r2, f.hm, f.iv, f.bystander]) {
      expect(await rows(who, restricted), 'restricted').toHaveLength(0);
      expect(await rows(who, sql`select 1 from recruitment_blocked_history`), 'history').toHaveLength(0);
    }
    expect((await rows<{ candidate_id: string }>(f.r1, sql`select candidate_id from recruitment_blocked_entry`)).map((r) => r.candidate_id)).toEqual([p.x.candidateId]);
    for (const who of [f.r2, f.hm, f.iv, f.bystander]) expect(await rows(who, sql`select 1 from recruitment_blocked_entry`)).toHaveLength(0);
    expect((await rows<{ application_id: string }>(f.r1, sql`select application_id from recruitment_application_review_mark order by 1`)).map((r) => r.application_id))
      .toEqual([p.x.applicationId, p.w.applicationId, p.v.applicationId].sort());
    for (const who of [f.hm, f.iv, f.bystander]) expect(await rows(who, sql`select 1 from recruitment_application_review_mark`)).toHaveLength(0);
    const asks = async (who: SessionContext, id: string) => (await rows<{ r: boolean }>(who, sql`select app.recruitment_application_needs_review(${id}::uuid) as r`))[0].r;
    expect(await asks(f.hm, p.x.applicationId)).toBe(true);
    expect(await asks(f.iv, p.w.applicationId)).toBe(true);
    expect(await asks(f.iv, p.x.applicationId)).toBe(false); // the interviewer does not read X's application
    expect(await asks(f.bystander, p.x.applicationId)).toBe(false);
    expect(await asks(f.r2, p.x.applicationId)).toBe(false);
  });
});

describe('case 92 — resolving marks and removing the entry; history and events carry no reason or identity value', () => {
  it('"Not the same person" clears one mark; removing the entry clears all of its marks; nothing personal is recorded', async () => {
    const f = await fixture();
    const p = await people(f);
    const { entryId } = await blockCandidate(admin, p.x.candidateId, REASON);
    const yMark = (await markOf(p.y.applicationId))!;
    // Y also applies to job 1 (onto the same candidate): marked too (the rule, and Y's open mark carried over).
    const y2 = await addApplication(admin, { jobId: f.job1, fullName: p.who.Y.fullName, existingCandidateId: p.y.candidateId });
    expect(await markOf(y2.applicationId)).toBeTruthy();
    // "Not the same person" applies to the candidate: both of Y's marks for this entry go, and Y is not marked again for it.
    expect(await resolveReviewMark(admin, yMark, 'not_same_person')).toEqual({ cleared: 2 });
    expect(await openMarks()).toEqual([p.x.applicationId, p.w.applicationId, p.v.applicationId].sort());
    const y3 = await addApplication(admin, { jobId: f.job4, fullName: p.who.Y.fullName, existingCandidateId: p.y.candidateId });
    expect(await markOf(y3.applicationId)).toBeUndefined();
    expect(await code(resolveReviewMark(admin, yMark, 'not_same_person'))).toBe('mark_cleared');
    expect((await moveApplication(f.r2, p.y.applicationId)).state).toBe('active');
    // Remove from the list (from X's own mark): a reason is required; every open mark of the entry is cleared. "Not the same
    // person" is refused for X's own mark (service and database).
    const xMark = (await markOf(p.x.applicationId))!;
    expect(await code(resolveReviewMark(admin, xMark, 'not_same_person'))).toBe('own_entry_mark');
    expect(await constraintOf(rows(admin, sql`select app.recruitment_resolve_review_mark(${xMark}::uuid, 'not_same_person', null)`))).toBe('recruitment_review_mark_own_entry');
    expect(await markOf(p.x.applicationId)).toBe(xMark);
    expect(await code(resolveReviewMark(admin, xMark, 'remove_from_list'))).toBe('reason_required');
    expect(await code(resolveReviewMark(admin, xMark, 'something_else'))).toBe('invalid_input');
    const before = (await openMarks()).length;
    expect(before).toBe(3);
    expect(await resolveReviewMark(admin, xMark, 'remove_from_list', REMOVAL)).toEqual({ cleared: before });
    expect(await openMarks()).toEqual([]);
    expect(await code(unblockCandidate(admin, entryId, REMOVAL))).toBe('blocked_entry_removed');
    const [entry] = await owner.db.execute<{ removed: boolean; reason: string; removal_reason: string; ids: number }>(sql`
      select e.removed_at is not null as removed, x.reason, x.removal_reason, num_nonnulls(x.id_norm, x.name_norm, x.email_norm, x.mobile_norm) as ids
      from recruitment_blocked_entry e join recruitment_blocked_entry_restricted x on x.entry_id = e.id where e.id = ${entryId}::uuid`);
    expect(entry).toEqual({ removed: true, reason: REASON, removal_reason: REMOVAL, ids: 0 });
    // Operators no longer read the removed entry or the cleared marks; administrators still do.
    expect(await rows(f.r1, sql`select 1 from recruitment_blocked_entry`)).toHaveLength(0);
    expect(await rows(f.r1, sql`select 1 from recruitment_application_review_mark`)).toHaveLength(0);
    expect(await rows(admin, sql`select 1 from recruitment_blocked_entry`)).toHaveLength(1);
    expect((await rows(admin, sql`select 1 from recruitment_application_review_mark`)).length).toBeGreaterThan(3);
    expect((await moveApplication(f.r1, p.x.applicationId)).state).toBe('active');
    // A new application of X no longer matches anything (the entry is removed).
    await manual(admin, f.job2, { fullName: X.fullName, email: X.email }, true);
    expect(await openMarks()).toEqual([]);
    // Listed again: a new entry, and the history keeps both.
    await blockCandidate(admin, p.x.candidateId, `${REASON} again`);
    const history = await owner.db.execute<{ action: string; detail: string | null }>(sql`select action, detail from recruitment_blocked_history
      where candidate_id = ${p.x.candidateId}::uuid order by occurred_at, action, detail`);
    expect(history.filter((h) => h.action === 'added')).toHaveLength(2);
    expect(history.filter((h) => h.action === 'removed')).toHaveLength(1);
    expect(history.filter((h) => h.action === 'mark_cleared').map((h) => h.detail).sort())
      .toEqual(['entry_removed', 'entry_removed', 'entry_removed', 'not_same_person', 'not_same_person']);
    // The administrator's history view joins the reasons in for display; the stored history holds none.
    const view = (await blockedList(admin, [base.companyId])).history!;
    expect(view.filter((h) => h.action === 'removed').map((h) => h.reason)).toEqual([REMOVAL]);
    const historyText = (await owner.db.execute<{ t: string }>(sql`select string_agg(to_jsonb(h.*)::text, ' ') as t from recruitment_blocked_history h`))[0].t;
    expect(historyText.length).toBeGreaterThan(100);
    const events = (await owner.db.execute<{ t: string | null }>(sql`select string_agg(payload::text, ' ') as t from domain_event
      where tenant_id = ${base.tenantId}::uuid and event_type in ('recruitment-candidate.blocked', 'recruitment-candidate.unblocked', 'recruitment-application.review-resolved')`))[0].t ?? '';
    expect(events).toMatch(/not_same_person/);
    expect(events).toMatch(/remove_from_list/);
    for (const text of [historyText, events]) {
      expect(text).not.toMatch(/QZX/i);
      expect(text).not.toContain(MOBILE_DIGITS);
      expect(text).not.toContain(X.phone);
    }
    // No domain event of the tenant carries a reason.
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where payload::text ilike '%QZXREASON%' or payload::text ilike '%QZXREMOVAL%'`))[0].n).toBe(0);
  });
});

describe('case 93 — removal, company deletion, row security and grants, the AI Centre read, the owner rehearsal', () => {
  async function rejectAndAge(applicationId: string) {
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, applicationId, reason.id);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${`${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`}::timestamptz where id = ${applicationId}::uuid`;
    });
  }

  it('removing a listed candidate deletes their entries, reasons, identity values, history and the marks their entries made', async () => {
    const f = await fixture();
    const P = { fullName: 'Fictional Qzxpname Listed', email: 'qzxpmail@example.test', idNumber: 'QZXPID-1' };
    const listed = await manual(f.r1, f.job1, P);
    const q = await manual(admin, f.job2, { fullName: 'Fictional Quentin Other', email: 'quentin@example.test', idNumber: 'qzxpid 1' }, true);
    const { id: pool } = await savePool(admin, { companyId: base.companyId, name: 'Fictional keep' });
    await addCandidateToPool(admin, pool, listed.candidateId);
    await blockCandidate(admin, listed.candidateId, 'QZXPREASON first');
    expect(await markOf(q.applicationId)).toBeTruthy();
    // An archived application holds nobody up: only another candidate's ACTIVE application refuses the removal (below).
    const [first] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_blocked_entry where candidate_id = ${listed.candidateId}::uuid`);
    await unblockCandidate(admin, first.id, 'QZXPREMOVAL fictional');
    await blockCandidate(admin, listed.candidateId, 'QZXPREASON second');
    expect(await markOf(q.applicationId)).toBeTruthy();
    await rejectAndAge(listed.applicationId);
    // Refused while the entry holds an open review on Q's ACTIVE application (marks on the person's own applications don't count).
    expect(await code(destroyCandidates(admin, base.companyId, [listed.candidateId], 'on'))).toBe('blocked_entry_has_open_marks');
    expect(await code(rows(admin, sql`select app.recruitment_destroy_candidate(${listed.candidateId}::uuid)`))).toBe('23514');
    await resolveReviewMark(admin, (await markOf(q.applicationId))!, 'not_same_person');
    // Independently: every mark either of the listed person's entries made (on their own application and on Q's), cleared or open.
    const [made] = await owner.db.execute<{ n: number; q: number }>(sql`select count(*)::int as n, count(*) filter (where m.application_id = ${q.applicationId}::uuid)::int as q
      from recruitment_application_review_mark m join recruitment_blocked_entry e on e.id = m.entry_id where e.candidate_id = ${listed.candidateId}::uuid`);
    expect(made).toEqual({ n: 4, q: 2 });
    expect(await destroyCandidates(admin, base.companyId, [listed.candidateId], 'on')).toEqual({ removed: 1 });
    const [event] = await owner.db.execute<{ payload: Record<string, number> }>(sql`
      select payload from domain_event where event_type = 'recruitment-candidate.personal-data-removed' and aggregate_id = ${listed.candidateId}::uuid`);
    // Two entries; every mark they made; one pool membership.
    expect(event.payload).toMatchObject({ blockedEntries: 2, blockedMarks: made.n, poolMemberships: 1 });
    for (const t of ['recruitment_blocked_entry', 'recruitment_blocked_entry_restricted', 'recruitment_blocked_history']) {
      expect(await owner.db.execute(sql`select 1 from ${sql.identifier(t)} where candidate_id = ${listed.candidateId}::uuid`), t).toHaveLength(0);
    }
    expect(await owner.db.execute(sql`select 1 from recruitment_application_review_mark where application_id = ${q.applicationId}::uuid`)).toHaveLength(0);
    expect(await owner.db.execute(sql`select 1 from recruitment_talent_pool_member where candidate_id = ${listed.candidateId}::uuid`)).toHaveLength(0);
    expect((await moveApplication(f.r2, q.applicationId)).state).toBe('active');
    // No reason anywhere in any recruitment table or event; the listed person's identity values are gone from the list tables.
    const tables = await owner.db.execute<{ relname: string }>(sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by c.relname`);
    expect(tables.map((x) => x.relname)).toEqual(expect.arrayContaining(NEW_TABLES));
    for (const { relname } of tables) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(relname)} r
        where to_jsonb(r.*)::text ilike '%QZXPREASON%' or to_jsonb(r.*)::text ilike '%QZXPREMOVAL%'`);
      expect(hit.n, relname).toBe(0);
    }
    for (const t of NEW_TABLES) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(t)} r where to_jsonb(r.*)::text ilike '%qzxp%'`);
      expect(hit.n, t).toBe(0);
    }
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where payload::text ilike '%QZXP%'`))[0].n).toBe(0);
    // The pool itself stays (it is company setup).
    expect(await owner.db.execute(sql`select 1 from recruitment_talent_pool where id = ${pool}::uuid`)).toHaveLength(1);
    // Retention never removes anybody by itself, listed or not: the removal above was an administrator's explicit choice.
    expect(await code(blockCandidate(admin, listed.candidateId, 'Fictional again'))).toBe('candidate_removed');
  });

  it('forces row security with exact grants and none to PUBLIC; the AI Centre read is counts only; read paths write nothing', async () => {
    const meta = await owner.db.execute<{ relname: string; forced: boolean; enabled: boolean; app: string | null; public_grants: number }>(sql`
      select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
        (select string_agg(a.privilege_type, ',' order by a.privilege_type) from aclexplode(c.relacl) a where a.grantee = 'ai_hr_app'::regrole) as app,
        (select count(*)::int from aclexplode(c.relacl) a where a.grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${NEW_TABLES.join(',')}}`}::text[]) order by c.relname`);
    expect(meta).toEqual([
      { relname: 'recruitment_application_review_mark', forced: true, enabled: true, app: 'SELECT', public_grants: 0 },
      { relname: 'recruitment_blocked_entry', forced: true, enabled: true, app: 'SELECT', public_grants: 0 },
      { relname: 'recruitment_blocked_entry_restricted', forced: true, enabled: true, app: 'SELECT', public_grants: 0 },
      { relname: 'recruitment_blocked_history', forced: true, enabled: true, app: 'SELECT', public_grants: 0 },
      { relname: 'recruitment_talent_pool', forced: true, enabled: true, app: 'DELETE,INSERT,SELECT,UPDATE', public_grants: 0 },
      { relname: 'recruitment_talent_pool_member', forced: true, enabled: true, app: 'DELETE,INSERT,SELECT', public_grants: 0 },
      { relname: 'recruitment_talent_pool_share', forced: true, enabled: true, app: 'DELETE,INSERT,SELECT', public_grants: 0 },
    ]);
    const [ctx] = await owner.db.execute<{ forced: boolean; acl: string | null }>(sql`select c.relforcerowsecurity as forced, c.relacl::text as acl from pg_class c
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relname = 'recruitment_blocked_context'`);
    expect(ctx.forced).toBe(true);
    expect(ctx.acl ?? '').not.toMatch(/ai_hr_app|(^|[{,])=/);
    // The restricted table's only non-owner policy admits administrators.
    const policies = await owner.db.execute<{ policyname: string; text: string }>(sql`select policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as text
      from pg_policies where tablename = 'recruitment_blocked_entry_restricted' order by 1`);
    expect(policies.length).toBeGreaterThan(4);
    for (const p of policies) {
      expect(/can_admin_recruitment_for|relowner/.test(p.text), p.policyname).toBe(true);
      expect(p.text, p.policyname).not.toMatch(/operate|review|team_in_company/);
    }
    const fns = await owner.db.execute<{ proname: string; app_exec: boolean; public_exec: boolean; secdef: boolean }>(sql`select p.proname,
      has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec, has_function_privilege('public', p.oid, 'execute') as public_exec, p.prosecdef as secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
        and (p.proname like 'recruitment\\_%blocked%' or p.proname like 'recruitment\\_%review\\_mark%' or p.proname like 'recruitment\\_%talent\\_pool%'
          or p.proname in ('recruitment_application_needs_review', 'recruitment_block_candidate', 'recruitment_unblock_candidate')) order by p.proname collate "C"`);
    expect(fns).toEqual([
      { proname: 'recruitment_application_needs_review', app_exec: true, public_exec: false, secdef: true },
      { proname: 'recruitment_block_candidate', app_exec: true, public_exec: false, secdef: true },
      { proname: 'recruitment_blocked_identity_match', app_exec: true, public_exec: false, secdef: false },
      { proname: 'recruitment_blocked_lock_key', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_blocked_mark', app_exec: false, public_exec: false, secdef: true },
      { proname: 'recruitment_blocked_match', app_exec: false, public_exec: false, secdef: true },
      { proname: 'recruitment_blocked_match_application', app_exec: false, public_exec: false, secdef: true },
      { proname: 'recruitment_blocked_matching', app_exec: true, public_exec: false, secdef: true },
      { proname: 'recruitment_guard_blocked', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_review_mark', app_exec: false, public_exec: false, secdef: true },
      { proname: 'recruitment_guard_talent_pool', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_talent_pool_member', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_talent_pool_share', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_resolve_review_mark', app_exec: true, public_exec: false, secdef: true },
      { proname: 'recruitment_talent_pool_sharing_follows', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_unblock_candidate', app_exec: true, public_exec: false, secdef: true },
    ]);
    // The AI Centre read: the same count keys as before, integers only, never blocked status.
    const f = await fixture();
    const p = await people(f);
    await blockCandidate(admin, p.x.candidateId, REASON);
    const counts = await recruitmentPipelineCounts(admin);
    const COUNT_KEYS = ['activeApplications', 'archived', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen'];
    expect(counts.rows.length).toBeGreaterThan(0);
    for (const row of counts.rows) {
      expect(Object.keys(row).sort()).toEqual(['company', ...COUNT_KEYS].sort());
      for (const k of COUNT_KEYS) expect(Number.isInteger((row as Record<string, unknown>)[k]), k).toBe(true);
    }
    expect(JSON.stringify(counts)).not.toMatch(/QZX|blocked|review|FICTIONAL YUSOF/i);
    // The application's review read and the pool list work in a READ ONLY transaction and take no transaction id.
    for (const who of [f.r1, f.hm, admin]) {
      const out = await withTenant(who, async (tx) => {
        const view = await applicationReviewTx(tx, who, p.x.applicationId);
        const [xid] = await tx.execute<{ x: string | null }>(sql`select pg_current_xact_id_if_assigned()::text as x`);
        const [mode] = await tx.execute<{ ro: string }>(sql`select current_setting('transaction_read_only') as ro`);
        return { view, xid: xid.x, ro: mode.ro };
      }, { readOnlySnapshot: true });
      expect(out).toMatchObject({ xid: null, ro: 'on' });
      expect(out.view.needsReview).toBe(true);
    }
    // The public pool card tells an administrator the candidate is listed.
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, p.x.applicationId, reason.id);
    expect((await talentPool(admin, [base.companyId])).cards.find((c) => c.candidateId === p.x.candidateId)?.blocked).toBe(true);
  });

  it('company deletion covers the new tables; listing, matching from a channel without access, resolving and removal work under a NOBYPASSRLS owner', async () => {
    const [{ id: emptyCompany }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Empty Sdn Bhd' }).returning({ id: company.id });
    const { id: top } = await savePool(admin, { companyId: emptyCompany, name: 'Fictional empty pool', sharing: 'listed_users', sharedUserIds: [] });
    await savePool(admin, { companyId: emptyCompany, name: 'Fictional empty sub', parentId: top });
    const f = await fixture();
    // D: listed, archived and due for removal, with a mark on E's active application.
    const D = { fullName: 'Fictional Dee Listed', email: 'dee.listed@example.test' };
    const d = await manual(f.r1, f.job1, D);
    const e = await manual(admin, f.job2, { fullName: D.fullName, email: D.email }, true);
    await blockCandidate(admin, d.candidateId, 'Fictional reason D');
    expect(await markOf(e.applicationId)).toBeTruthy();
    await rejectAndAge(d.applicationId);
    // P: an active candidate to list under the owner.
    const P = { fullName: 'Fictional Pat Owner', email: 'pat.owner@example.test' };
    const pApp = await manual(f.r1, f.job1, P);
    const [firstStage, secondStage] = await stagesOf(f.job1);
    const ROLLBACK = 'rolled back on purpose';
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment', 'employment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      expect(tables.map((x) => x.name)).toEqual(expect.arrayContaining([...NEW_TABLES.map((x) => `public.${x}`), 'app.recruitment_blocked_context']));
      for (const x of tables) await tx.unsafe(`alter table ${x.name} owner to ai_hr_owner`);
      const fns = await tx<{ sig: string }[]>`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname ~ '^recruitment_'`;
      expect(fns.map((x) => x.sig)).toEqual(expect.arrayContaining(['app.recruitment_block_candidate(uuid,text)', 'app.recruitment_blocked_match_application()',
        'app.recruitment_destroy_candidate(uuid)', 'app.recruitment_delete_company_setup(uuid)']));
      for (const x of fns) await tx.unsafe(`alter function ${x.sig} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      const forced = await tx`select relname from pg_class where relname = any(${NEW_TABLES}) and relforcerowsecurity and relrowsecurity`;
      expect(forced).toHaveLength(NEW_TABLES.length);
      const as = async (userId: string, roles: string, grants: unknown) => {
        await tx.unsafe('set local role ai_hr_app');
        await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('app.roles', ${roles}, true),
          set_config('app.grants', ${JSON.stringify(grants)}, true)`;
      };
      const adminGrants = [{ role: 'hr_admin', companyId: null }];
      const employee = [{ role: 'employee', companyId: null }];
      // Outside a blocked-list call the owner sees no candidate through the new policies (no context marker is held).
      await tx.unsafe('set local role ai_hr_owner');
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${f.bystander.userId}, true), set_config('app.roles', 'employee', true),
        set_config('app.grants', ${JSON.stringify(employee)}, true)`;
      expect(await tx`select id from recruitment_candidate`).toEqual([]);
      expect(await tx`select 1 from recruitment_blocked_entry_restricted`).toEqual([]);
      // The administrator lists P: P's active application is marked.
      await as(base.adminUserId, 'hr_admin', adminGrants);
      const [{ id: entry }] = await tx`select app.recruitment_block_candidate(${pApp.candidateId}::uuid, 'Fictional owner reason') as id`;
      expect((await tx`select application_id from recruitment_application_review_mark where entry_id = ${entry}::uuid`).map((r) => r.application_id)).toEqual([pApp.applicationId]);
      // A recruiter writes a matching candidate and application directly; the matching then runs for a caller who can read
      // neither (the channel case: a referrer or a careers visitor), at the deferred trigger's moment.
      await as(f.r1.userId, 'employee', employee);
      // The id is made here: the recruiter cannot read the candidate back until its application exists.
      const cand = { id: randomUUID() };
      await tx`insert into recruitment_candidate (id, tenant_id, company_id, full_name, email, owner_user_id, created_by_user_id, updated_by_user_id)
        values (${cand.id}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'fictional  PAT owner', 'Pat.Owner@example.test', ${f.r1.userId}::uuid, ${f.r1.userId}::uuid,
          ${f.r1.userId}::uuid)`;
      const [app] = await tx`insert into recruitment_application (tenant_id, company_id, job_id, candidate_id, current_stage_id, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.job1}::uuid, ${cand.id}::uuid, ${firstStage.id}::uuid, ${f.r1.userId}::uuid, ${f.r1.userId}::uuid) returning id`;
      await as(f.bystander.userId, 'employee', employee);
      expect(await tx`select 1 from recruitment_candidate where id = ${cand.id}::uuid`).toEqual([]);
      await tx`set constraints all immediate`;
      await tx`reset role`;
      expect((await tx`select entry_id from recruitment_application_review_mark where application_id = ${app.id}::uuid and cleared_at is null`).map((r) => r.entry_id)).toEqual([entry]);
      expect((await tx<{ n: number }[]>`select count(*)::int as n from app.recruitment_blocked_context`)[0].n).toBe(0);
      // The move guard holds it, for the recruiter.
      await as(f.r1.userId, 'employee', employee);
      await tx`savepoint held`;
      await expect(tx`update recruitment_application set current_stage_id = ${secondStage.id}::uuid where id = ${app.id}::uuid`)
        .rejects.toMatchObject({ constraint_name: 'recruitment_application_needs_review' });
      await tx`rollback to savepoint held`;
      // The administrator resolves one mark and removes the entry.
      await as(base.adminUserId, 'hr_admin', adminGrants);
      const [mark] = await tx`select id from recruitment_application_review_mark where application_id = ${app.id}::uuid`;
      expect((await tx`select app.recruitment_resolve_review_mark(${mark.id}::uuid, 'not_same_person', null) as n`)[0].n).toBe(1);
      expect((await tx`select app.recruitment_unblock_candidate(${entry}::uuid, 'Fictional owner removal') as n`)[0].n).toBe(1);
      // Removal of D: refused while D's entry holds E's active application; resolved, then removed — as the owner under forced
      // row security.
      await tx`savepoint refused`;
      await expect(tx`select app.recruitment_destroy_candidate(${d.candidateId}::uuid) as r`).rejects.toMatchObject({ constraint_name: 'recruitment_blocked_entry_has_open_marks' });
      await tx`rollback to savepoint refused`;
      const [eMark] = await tx`select id from recruitment_application_review_mark where application_id = ${e.applicationId}::uuid and cleared_at is null`;
      expect((await tx`select app.recruitment_resolve_review_mark(${eMark.id}::uuid, 'not_same_person', null) as n`)[0].n).toBe(1);
      const [destroyed] = await tx`select app.recruitment_destroy_candidate(${d.candidateId}::uuid) as r`;
      expect(destroyed.r).toMatchObject({ blockedEntries: 1, blockedMarks: 2 }); // D's own application and E's
      const [removed] = await tx`select app.recruitment_delete_company_setup(${emptyCompany}::uuid) as n`;
      expect(Number(removed.n)).toBeGreaterThanOrEqual(2);
      // The app role cannot delete blocked-list rows itself, even with the company-delete context value.
      await tx`select set_config('app.recruitment_company_delete', ${base.companyId}, true)`;
      await tx`savepoint direct`;
      await expect(tx`delete from recruitment_blocked_history`).rejects.toMatchObject({ code: '42501' });
      await tx`rollback to savepoint direct`;
      await tx`reset role`;
      for (const x of NEW_TABLES) {
        const [n] = await tx.unsafe(`select count(*)::int as n from public.${x} where company_id = '${emptyCompany}'::uuid`);
        expect(n.n, x).toBe(0);
      }
      expect(await tx`select 1 from recruitment_application_review_mark where application_id = ${e.applicationId}::uuid`).toEqual([]);
      expect(await tx`select 1 from recruitment_blocked_entry where candidate_id = ${d.candidateId}::uuid`).toEqual([]);
      throw new Error(ROLLBACK);
    }).catch((err: unknown) => (err instanceof Error && err.message === ROLLBACK ? 'rolled back' : Promise.reject(err)));
    expect(done).toBe('rolled back');
    // Through the service as well (default owner): the company delete removes the empty company's pools.
    await withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${emptyCompany}::uuid)`));
    expect(await owner.db.execute(sql`select 1 from recruitment_talent_pool where company_id = ${emptyCompany}::uuid`)).toHaveLength(0);
    // A company with candidates keeps everything (its job opening refuses the delete first).
    expect(await code(withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${base.companyId}::uuid)`)))).toBe('23503');
    expect(await code(deletePool(f.r1, top))).toMatch(/^(forbidden|not_found)$/);
  });
});

/**
 * Wait (bounded, 5 s) until `n` backends of this database wait on a lock of one of `kinds` ('advisory', …). On failure it
 * first releases every held transaction (`release`), so the test fails at once with this message instead of hanging until the
 * test timeout with connections still held.
 */
async function waiters(n: number, kinds: string[], release: (() => void)[] = []) {
  for (let i = 0; i < 100; i++) {
    const [row] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and wait_event = any(${`{${kinds.join(',')}}`}::text[])`);
    if (row.n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const r of release) r();
  expect.fail(`expected ${n} backend(s) waiting on a ${kinds.join('/')} lock within 5 s; none did`);
}
async function ageArchived(applicationId: string) {
  const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
  await rejectApplication(admin, applicationId, reason.id);
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_application set state_changed_at = ${`${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`}::timestamptz where id = ${applicationId}::uuid`;
  });
}
/** A candidate and application written directly by `ctx` in one transaction (the id made here: an operator cannot read the
 *  candidate back before the application exists). */
const directApply = (tx: Parameters<Parameters<typeof withTenant>[1]>[0], ctx: Login, jobId: string, stageId: string, who: { fullName: string; email?: string }) => {
  const cand = randomUUID();
  const app = randomUUID();
  return tx.execute(sql`insert into recruitment_candidate (id, tenant_id, company_id, full_name, email, owner_user_id, created_by_user_id, updated_by_user_id)
      values (${cand}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${who.fullName}, ${who.email ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`)
    .then(() => tx.execute(sql`insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, applied_at, created_by_user_id, updated_by_user_id)
      values (${app}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${jobId}::uuid, ${cand}::uuid, ${stageId}::uuid, '2020-01-01T00:00:00Z', ${ctx.userId}::uuid,
        ${ctx.userId}::uuid)`))
    .then(() => ({ candidateId: cand, applicationId: app }));
};

describe('review follow-ups — races, the creating transaction, declines, screening, read-only removal marker, scale', () => {
  it('removal and matching serialise on the company lock in either order: no 23503, and the removal is refused by name when it must be', async () => {
    const f = await fixture();
    const [firstStage] = await stagesOf(f.job1);
    const x = await manual(f.r1, f.job1, X);
    await blockCandidate(admin, x.candidateId, REASON);
    await ageArchived(x.applicationId);
    // Order 1 — the removal holds the lock; a careers applicant matching X commits meanwhile: it waits, then finds no entry.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let removed!: () => void;
    const removedNow = new Promise<void>((r) => { removed = r; });
    const removal = withTenant(admin, async (tx) => {
      await tx.execute(sql`select app.recruitment_destroy_candidate(${x.candidateId}::uuid)`);
      removed();
      await gate;
    });
    await removedNow;
    const submission = careers(f.job3, { fullName: X.fullName, email: X.email });
    await waiters(1, ['advisory'], [release]);
    release();
    await removal;
    expect(await submission).toEqual({ ok: true, outcome: 'received' });
    const [stored] = await owner.db.execute<{ id: string }>(sql`select a.id from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id
      where a.job_id = ${f.job3}::uuid and lower(c.email) = ${X.email}`);
    expect(stored.id).toBeTruthy();
    expect(await markOf(stored.id)).toBeUndefined();
    expect(await owner.db.execute(sql`select 1 from recruitment_blocked_entry where candidate_id = ${x.candidateId}::uuid`)).toHaveLength(0);

    // Order 2 — a matching application is matched (lock held) before the removal of a second listed person: the removal waits,
    // then sees the new hold on another candidate's active application and is refused by name (not a raw 23503).
    const P = { fullName: 'Fictional Second Listed', email: 'second.listed@example.test' };
    const pApp = await manual(f.r1, f.job1, P);
    await blockCandidate(admin, pApp.candidateId, REASON);
    await ageArchived(pApp.applicationId);
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => { release2 = r; });
    let matched!: () => void;
    const matchedNow = new Promise<void>((r) => { matched = r; });
    const writer = withTenant(f.r1, async (tx) => {
      const created = await directApply(tx, f.r1, f.job1, firstStage.id, { fullName: 'fictional second LISTED', email: 'Second.Listed@example.test' });
      await tx.execute(sql`set constraints all immediate`);
      matched();
      await gate2;
      return created;
    });
    await matchedNow;
    const refused = code(destroyCandidates(admin, base.companyId, [pApp.candidateId], 'on'));
    await waiters(1, ['advisory'], [release2]);
    release2();
    const created = await writer;
    expect(await refused).toBe('blocked_entry_has_open_marks');
    expect(await markOf(created.applicationId)).toBeTruthy();
    expect(await owner.db.execute(sql`select 1 from recruitment_blocked_entry where candidate_id = ${pApp.candidateId}::uuid`)).toHaveLength(1);
    // A vanished entry is refused by name too.
    const [entry] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_blocked_entry where candidate_id = ${pApp.candidateId}::uuid`);
    await resolveReviewMark(admin, (await markOf(created.applicationId))!, 'not_same_person');
    expect(await destroyCandidates(admin, base.companyId, [pApp.candidateId], 'on')).toEqual({ removed: 1 });
    expect(await code(unblockCandidate(admin, entry.id, REMOVAL))).toBe('not_found');
  });

  it('holds an application matched in the transaction that creates it (stage change, hire, offer), and only that one', async () => {
    const f = await fixture();
    const stages = await stagesOf(f.job1);
    const x = await manual(f.r1, f.job1, X);
    await blockCandidate(admin, x.candidateId, REASON);
    // The direct writer even sends an old applied_at: the database stamps its own time, so the guard recognises the new row.
    const attempt = async (then: (tx: Parameters<Parameters<typeof withTenant>[1]>[0], created: { applicationId: string }) => Promise<unknown>, who = { fullName: X.fullName, email: X.email }) =>
      constraintOf(withTenant(f.r1, async (tx) => then(tx, await directApply(tx, f.r1, f.job1, stages[0].id, who))));
    expect(await attempt((tx, c) => tx.execute(sql`update recruitment_application set current_stage_id = ${stages[1].id}::uuid where id = ${c.applicationId}::uuid`)))
      .toBe('recruitment_application_needs_review');
    expect(await attempt((tx, c) => tx.execute(sql`update recruitment_application set state = 'hired' where id = ${c.applicationId}::uuid`)))
      .toBe('recruitment_application_needs_review');
    expect(await attempt((tx, c) => tx.execute(sql`insert into recruitment_offer (tenant_id, company_id, job_id, application_id, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.job1}::uuid, ${c.applicationId}::uuid, ${f.r1.userId}::uuid, ${f.r1.userId}::uuid)`)))
      .toBe('recruitment_application_needs_review');
    // A stranger's new application moves within its creating transaction as before.
    expect(await attempt((tx, c) => tx.execute(sql`update recruitment_application set current_stage_id = ${stages[1].id}::uuid where id = ${c.applicationId}::uuid`),
      { fullName: 'Fictional Stranger', email: 'stranger.tx@example.test' })).toBe('ok');
    // An ordinary move of an older application takes no blocked-list lock and writes no marker: a removal of X holding the
    // company lock does not delay it.
    const old = await manual(f.r1, f.job1, { fullName: 'Fictional Older Person', email: 'older@example.test' });
    const listed = (await owner.db.execute<{ id: string }>(sql`select candidate_id as id from recruitment_application where id = ${x.applicationId}::uuid`))[0].id;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const held = new Promise<void>((r) => { holding = r; });
    // The lock is held from the owner connection (the app role cannot even compute the key).
    const locker = owner.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(app.recruitment_blocked_lock_key(${base.tenantId}::uuid, ${base.companyId}::uuid))`;
      holding();
      await gate;
    }).catch((e: unknown) => { release(); throw e; });
    await held;
    const moved = await Promise.race([moveApplication(f.r1, old.applicationId).then(() => 'moved'),
      new Promise((resolve) => setTimeout(() => resolve('blocked by the lock'), 3000))]);
    release();
    await locker;
    expect(moved).toBe('moved');
    expect(listed).toBe(x.candidateId);
    expect((await owner.db.execute<{ applied: string }>(sql`select applied_at::text as applied from recruitment_application a join recruitment_candidate c
      on c.id = a.candidate_id where c.email = 'stranger.tx@example.test'`))[0].applied).not.toMatch(/^2020/);
  });

  it('records a decline and allows withdrawing while marked; an acceptance, sending and the automatic move stay held', async () => {
    const f = await fixture();
    const offerStage = (await owner.db.execute<{ id: string }>(sql`select ps.stage_id as id from recruitment_job_opening j join recruitment_process_stage ps on ps.process_id = j.process_id
      join recruitment_stage st on st.id = ps.stage_id where j.id = ${f.job1}::uuid and st.stage_type = 'offer' order by ps.position limit 1`))[0].id;
    const fields = (await offerSettings(admin, base.companyId)).fields;
    const fid = (label: string) => fields.find((x) => x.label === label)!.id;
    const values = { [fid('Job offered')]: { text: 'Fictional analyst' }, [fid('Department')]: { text: 'Finance' }, [fid('Commencement date')]: { text: '2026-12-01' },
      [fid('Basic salary')]: { amount: '5000', currency: 'MYR' } };
    const withOffer = async (who: { fullName: string; email: string }, send: boolean) => {
      const a = await manual(f.r1, f.job1, who);
      await moveApplication(f.r1, a.applicationId, offerStage);
      const { id } = await saveOffer(f.r1, a.applicationId, values);
      expect(await submitOffer(f.r1, id)).toBe('approved');
      if (send) await markOfferSent(f.r1, id, 'email');
      return { ...a, offerId: id };
    };
    const sent = await withOffer({ fullName: 'Fictional Decline Person', email: 'decline@example.test' }, true);
    const unsent = await withOffer({ fullName: 'Fictional Unsent Person', email: 'unsent@example.test' }, false);
    await blockCandidate(admin, sent.candidateId, REASON);
    await blockCandidate(admin, unsent.candidateId, REASON);
    expect(await code(markOfferSent(f.r1, unsent.offerId, 'email'))).toBe('needs_review');
    expect(await constraintOf(rows(f.r1, sql`update recruitment_offer set sent_at = now(), sent_channel = 'email', sent_by_user_id = ${f.r1.userId}::uuid, valid_days = 15
      where id = ${unsent.offerId}::uuid`))).toBe('recruitment_application_needs_review');
    expect(await code(recordOfferDecision(f.r1, sent.offerId, 'accepted'))).toBe('needs_review');
    expect(await constraintOf(rows(f.r1, sql`update recruitment_offer set candidate_decision = 'accepted', decided_at = now(), decided_by_user_id = ${f.r1.userId}::uuid
      where id = ${sent.offerId}::uuid`))).toBe('recruitment_application_needs_review');
    expect(await recordOfferDecision(f.r1, sent.offerId, 'declined')).toEqual({ moved: false, archived: false });
    expect((await owner.db.execute<{ d: string }>(sql`select candidate_decision as d from recruitment_offer where id = ${sent.offerId}::uuid`))[0].d).toBe('declined');
    expect((await owner.db.execute<{ stage: string }>(sql`select current_stage_id as stage from recruitment_application where id = ${sent.applicationId}::uuid`))[0].stage).toBe(offerStage);
  });

  it('"Send to hiring manager" with the move sends every selected application and moves only the unmarked ones', async () => {
    const f = await fixture();
    const x = await manual(f.r1, f.job1, X);
    const other = await manual(f.r1, f.job1, { fullName: 'Fictional Free Person', email: 'free@example.test' });
    await blockCandidate(admin, x.candidateId, REASON);
    const [first, second] = await stagesOf(f.job1);
    expect(await sendForScreening(f.r1, { applicationIds: [x.applicationId, other.applicationId], move: true })).toEqual({ sent: 2, skipped: 0, moved: 1, held: 1 });
    const at = async (id: string) => (await owner.db.execute<{ s: string }>(sql`select current_stage_id as s from recruitment_application where id = ${id}::uuid`))[0].s;
    expect(await at(x.applicationId)).toBe(first.id);
    expect(await at(other.applicationId)).toBe(second.id);
    expect((await owner.db.execute(sql`select 1 from recruitment_screening_request where application_id = ${x.applicationId}::uuid`)).length).toBe(1);
  });

  it('the removal marker is read without a transaction id: false and write-free in a READ ONLY transaction', async () => {
    const f = await fixture();
    const x = await manual(f.r1, f.job1, X);
    const out = await withTenant(admin, async (tx) => {
      const [r] = await tx.execute<{ d: boolean; da: boolean }>(sql`select app.recruitment_destroying(${x.candidateId}::uuid) as d,
        app.recruitment_destroying_application(${x.applicationId}::uuid) as da`);
      const [xid] = await tx.execute<{ x: string | null }>(sql`select pg_current_xact_id_if_assigned()::text as x`);
      const [mode] = await tx.execute<{ ro: string }>(sql`select current_setting('transaction_read_only') as ro`);
      return { ...r, xid: xid.x, ro: mode.ro };
    }, { readOnlySnapshot: true });
    expect(out).toEqual({ d: false, da: false, xid: null, ro: 'on' });
    expect((await owner.db.execute<{ src: string }>(sql`select prosrc as src from pg_proc where proname = 'recruitment_destroying'`))[0].src)
      .toMatch(/txid_current_if_assigned\(\)/);
  });

  it('measures a new application with 1,000 active entries: indexed lookups, no slower than a bounded cost', async () => {
    const f = await fixture();
    const timed = async (label: string) => {
      const started = performance.now();
      for (let i = 0; i < 5; i++) await manual(f.r1, f.job1, { fullName: `Fictional Timing ${label} ${i}`, email: `timing.${label}.${i}@example.test` });
      return (performance.now() - started) / 5;
    };
    const none = await timed('none');
    // 1,000 listed people with entries and identity values (fixture, past the guards).
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_candidate (id, tenant_id, company_id, full_name, email, phone, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Listed ' || g,
          'listed' || g || '@example.test', '6011' || lpad(g::text, 7, '0'), ${base.adminUserId}::uuid, ${base.adminUserId}::uuid from generate_series(1, 1000) g`;
      await tx`insert into recruitment_blocked_entry (id, tenant_id, company_id, candidate_id, created_by_user_id)
        select ('00000000-0000-4000-a000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid,
          ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${base.adminUserId}::uuid from generate_series(1, 1000) g`;
      await tx`insert into recruitment_blocked_entry_restricted (entry_id, tenant_id, company_id, candidate_id, reason, name_norm, email_norm, mobile_norm)
        select ('00000000-0000-4000-a000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid,
          ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Fictional bulk reason', 'fictional listed ' || g, 'listed' || g || '@example.test',
          '6011' || lpad(g::text, 7, '0') from generate_series(1, 1000) g`;
      await tx`analyze recruitment_blocked_entry_restricted`;
    });
    const many = await timed('many');
    const hit = await manual(admin, f.job1, { fullName: 'Fictional Listed 500', email: 'listed500@example.test' }, true);
    expect(await markOf(hit.applicationId)).toBeTruthy();
    const plan = (await owner.db.execute<{ 'QUERY PLAN': string }>(sql`explain select entry_id from recruitment_blocked_entry_restricted
      where tenant_id = ${base.tenantId}::uuid and company_id = ${base.companyId}::uuid and name_norm = 'fictional listed 500' and email_norm = 'listed500@example.test'`))
      .map((r) => r['QUERY PLAN']).join('\n');
    // Printed, and appended to $CHECKS_TIMING_LOG when set (passing tests' output is not shown).
    const text = `[slice 13 timing] new application: ${none.toFixed(1)} ms with no entry, ${many.toFixed(1)} ms with 1,000 active entries\n${plan}`;
    console.log(text);
    if (process.env.CHECKS_TIMING_LOG) appendFileSync(process.env.CHECKS_TIMING_LOG, `${text}\n`);
    expect(plan).toMatch(/Index Scan|Bitmap Index Scan/);
    expect(many).toBeLessThan(Math.max(4 * none, none + 250));
  });
});
