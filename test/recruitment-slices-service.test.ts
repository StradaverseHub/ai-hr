/**
 * Recruitment slices 2–4 against Postgres: acceptance cases 10–18 (docs/recruitment-reconstruction/specification.md
 * "Slices 2–4 acceptance cases") through the service AND under row security, plus the leakage checks — another
 * company's partner, another interviewer and private offer fields. All people and data are fictional.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { ModuleNotEnabledError } from '../core/entitlements';
import { createEmployeeDraftWithReservedCode } from '../core/employee-draft';
import {
  addApplication, addJobMember, addPoolCandidateToJob, applicationInterviews, applicationOffer, associateJob, candidateBoard, changeRequisitionStatus,
  createJob, createRequisition, decideOffer, decideRequisition, getRequisition, getScorecard, hireHandoffPrefill, interviewSchedule, linkHireDraft,
  listRequisitions, markOfferSent, moveApplication, myApprovals, offerForApprover, offerSettings, recordOfferDecision, recruitmentSettings,
  recruitmentTeamPresence, recruitmentViewer, rejectApplication, saveApprovalFlow, saveOffer, scheduleInterview, submitOffer, submitRequisition,
  submitScorecard, talentPool, updateInterviewSettings, updateOfferSettings, updateRequisition, withdrawOffer, RecruitmentError,
} from '../packs/recruitment/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let otherCompanyId: string;
let gradeId: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  if (error instanceof ModuleNotEnabledError) return 'module';
  return pgSqlState(error) ?? String(error);
};
/** A fictional employee of `companyId` with a login (an "employee" grant only): a candidate for any job team. */
async function person_(name: string, companyId = base.companyId): Promise<SessionContext> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
async function partnerFor(companyId: string, name: string): Promise<SessionContext> {
  const ctx = await person_(name, companyId);
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: ctx.userId!, companyId, role: 'recruiting_partner' });
  return { ...ctx, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId }] };
}
const rows = (ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute(query));
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional data analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', ...over,
});
const past = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
const future = (hoursAhead: number) => new Date(Date.now() + hoursAhead * 3_600_000);
async function stageNamed(name: string) {
  return (await recruitmentSettings(admin, base.companyId)).stages.find((s) => s.name === name)!.id;
}
/** Move an application forward until it is in the stage called `name`. */
async function moveTo(ctx: SessionContext, applicationId: string, name: string) {
  const target = await stageNamed(name);
  await moveApplication(ctx, applicationId, target);
}
const ratingsAll = (value: number) => Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5'].map((k) => [k, { rating: String(value), notes: `PRIVATE_NOTE_${k}` }]));

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
});

/** A job with a recruiter, a hiring manager and two interviewers, and two applications on it. */
async function hiringTeam() {
  const [recruiter, manager, interviewerA, interviewerB, bystander] = await Promise.all([
    person_('Fictional Recruiter'), person_('Fictional Manager'), person_('Fictional Interviewer A'), person_('Fictional Interviewer B'), person_('Fictional Bystander'),
  ]);
  const { id: jobId } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
  await addJobMember(admin, jobId, 'hiring_manager', manager.userId);
  await addJobMember(admin, jobId, 'interviewer', interviewerA.userId);
  const { applicationId: appX } = await addApplication(recruiter, { jobId, fullName: 'Fictional Candidate X', email: 'x@example.test' });
  const { applicationId: appY } = await addApplication(recruiter, { jobId, fullName: 'Fictional Candidate Y', email: 'y@example.test' });
  await moveTo(recruiter, appX, 'Interview');
  return { recruiter, manager, interviewerA, interviewerB, bystander, jobId, appX, appY };
}

describe('case 10 — interviewers see only their applications and write only their own scorecard', () => {
  it('scopes reads to the interviewed application, keeps scorecards private between interviewers, and shows them all to the hiring manager', async () => {
    const t = await hiringTeam();
    const { id: interviewId } = await scheduleInterview(t.recruiter, {
      applicationId: t.appX, type: 'video', startsAt: past(3), durationMinutes: 60, interviewerIds: [t.interviewerA.userId, t.interviewerB.userId],
    });
    // Reads: interviewer B (not on the job team) sees application X only — not Y, through the service and row security.
    const boardB = await candidateBoard(t.interviewerB, [base.companyId], { tab: await stageNamed('Interview') });
    expect(boardB.cards.map((c) => c.id)).toEqual([t.appX]);
    expect(boardB.cards[0]).toMatchObject({ canReview: false, canOperate: false });
    const visible = await rows(t.interviewerB, sql`select id from recruitment_application where company_id = ${base.companyId}::uuid`);
    expect(visible.map((r) => r.id)).toEqual([t.appX]);
    expect(await code(applicationInterviews(t.interviewerB, t.appY))).toBe('not_found');
    // Locking the row for a move needs the move (UPDATE) policy, which an interviewer does not pass: the row is not there.
    expect(await code(moveApplication(t.interviewerB, t.appX))).toBe('not_found');

    // Writes: each interviewer writes only their own feedback.
    await submitScorecard(t.interviewerA, interviewId, { ratings: ratingsAll(4), result: 'recommended', overview: 'PRIVATE_OVERVIEW_A' });
    expect(await code(submitScorecard(t.manager, interviewId, { ratings: ratingsAll(2), result: 'not_suitable' }))).toBe('not_interviewer');
    const forged = await code(rows(t.interviewerB, sql`
      insert into recruitment_scorecard (tenant_id, company_id, job_id, application_id, interview_id, interviewer_user_id, evaluation_form_id, ratings, result)
      select tenant_id, company_id, job_id, application_id, id, ${t.interviewerA.userId}::uuid, evaluation_form_id, '{}'::jsonb, 'not_suitable'
      from recruitment_interview where id = ${interviewId}::uuid`));
    expect(forged).toBe('42501');

    // Visibility: B cannot see A's scorecard (service and rows); the hiring manager and recruiter can; totals are sums.
    const [{ id: scorecardA }] = await rows(admin, sql`select id from recruitment_scorecard where interview_id = ${interviewId}::uuid`);
    expect(await code(getScorecard(t.interviewerB, scorecardA))).toBe('not_found');
    expect(await rows(t.interviewerB, sql`select 1 from recruitment_scorecard where interview_id = ${interviewId}::uuid`)).toHaveLength(0);
    const seenByManager = await getScorecard(t.manager, scorecardA);
    expect(seenByManager).toMatchObject({ result: 'recommended', sections: [{ sum: 20, max: 25 }] });
    expect((await getScorecard(t.recruiter, scorecardA)).overview).toBe('PRIVATE_OVERVIEW_A');
    const viewB = await applicationInterviews(t.interviewerB, t.appX);
    expect(JSON.stringify(viewB)).not.toContain('PRIVATE_OVERVIEW_A');
    expect(viewB.interviews[0].canAddFeedback).toBe(true);

    // Shared scorecards (company setting off): B may now read A's.
    await updateInterviewSettings(admin, base.companyId, { scorecardsPrivate: false, feedbackEditLock: 'until_stage_left', resultRequired: true });
    expect((await getScorecard(t.interviewerB, scorecardA)).result).toBe('recommended');
    // A bystander on no team sees nothing of it.
    expect(await code(getScorecard(t.bystander, scorecardA))).toBe('not_found');
  });
});

describe('case 11 — no team, not an administrator: no menu and no rows', () => {
  it('answers false for the menu, lists no companies and returns no rows from any recruitment table', async () => {
    const t = await hiringTeam();
    await scheduleInterview(t.recruiter, { applicationId: t.appX, type: 'onsite', startsAt: future(24), interviewerIds: [t.interviewerA.userId] });
    expect(await recruitmentTeamPresence(t.bystander)).toBe(false);
    expect(await recruitmentViewer(t.bystander, [base.companyId, otherCompanyId])).toEqual({ adminCompanies: [], teamCompanies: [], pendingApprovals: 0 });
    expect(await code(candidateBoard(t.bystander, [base.companyId]))).toBe('forbidden');
    expect(await code(interviewSchedule(t.bystander, [base.companyId]))).toBe('forbidden');
    const tables = await owner.db.execute<{ relname: string }>(sql`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by relname`);
    expect(tables.length).toBe(30); // 9 (slice 1) + 14 (slices 2–4) + 7 (slice 5)
    for (const { relname } of tables) {
      const seen = await rows(t.bystander, sql`select 1 from ${sql.identifier(relname)} where tenant_id = ${base.tenantId}::uuid`);
      expect(seen.length, `${relname} visible to a bystander`).toBe(0);
    }
    // Team members do get the menu: the recruiter, the hiring manager and an interviewer.
    expect(await recruitmentTeamPresence(t.recruiter)).toBe(true);
    expect(await recruitmentTeamPresence(t.manager)).toBe(true);
    expect((await recruitmentViewer(t.interviewerA, [base.companyId])).teamCompanies.map((c) => c.id)).toEqual([base.companyId]);
  });
});

describe('case 12 — interview status is derived (database read)', () => {
  it('shows Scheduled before the start, awaiting feedback after the end, complete when all have submitted', async () => {
    const t = await hiringTeam();
    const { id: later } = await scheduleInterview(t.recruiter, { applicationId: t.appX, type: 'onsite', startsAt: future(48), interviewerIds: [t.interviewerA.userId] });
    const { id: done } = await scheduleInterview(t.recruiter, { applicationId: t.appX, roundNo: '2', type: 'video', startsAt: past(5), interviewerIds: [t.interviewerA.userId, t.interviewerB.userId] });
    let view = await applicationInterviews(t.recruiter, t.appX);
    const status = (id: string) => view.interviews.find((i) => i.id === id)!;
    expect(status(later).status).toBe('scheduled');
    expect(status(done)).toMatchObject({ status: 'awaiting_feedback', submitted: 0, total: 2 });
    await submitScorecard(t.interviewerA, done, { ratings: ratingsAll(3), result: 'keep_in_view' });
    view = await applicationInterviews(t.recruiter, t.appX);
    expect(status(done)).toMatchObject({ status: 'awaiting_feedback', submitted: 1, total: 2 });
    await submitScorecard(t.interviewerB, done, { ratings: ratingsAll(5), result: 'recommended' });
    view = await applicationInterviews(t.recruiter, t.appX);
    expect(status(done)).toMatchObject({ status: 'feedback_complete', submitted: 2, total: 2 });
    const schedule = await interviewSchedule(t.recruiter, [base.companyId]);
    expect(schedule.rows.map((r) => [r.id, r.group])).toEqual(expect.arrayContaining([[later, 'upcoming']]));
    expect(schedule.rows.find((r) => r.id === later)?.recruiterName).toBe('Fictional Recruiter');
  });
});

describe('case 13 — feedback editing follows the company lock setting', () => {
  it('default locks once the application leaves the stage; any stage keeps it open; until archived locks on archive', async () => {
    const t = await hiringTeam();
    const { id } = await scheduleInterview(t.recruiter, { applicationId: t.appX, type: 'phone', startsAt: past(2), interviewerIds: [t.interviewerA.userId] });
    await submitScorecard(t.interviewerA, id, { ratings: ratingsAll(3), result: 'keep_in_view' });
    await submitScorecard(t.interviewerA, id, { ratings: ratingsAll(4), result: 'recommended' }); // same stage: editable
    await moveApplication(t.recruiter, t.appX); // Interview → Offer
    expect(await code(submitScorecard(t.interviewerA, id, { ratings: ratingsAll(5), result: 'recommended' }))).toBe('feedback_locked');
    // The database refuses the same edit on its own.
    expect(await code(rows(t.interviewerA, sql`update recruitment_scorecard set result = 'not_suitable' where interview_id = ${id}::uuid`))).toBe('23514');
    await updateInterviewSettings(admin, base.companyId, { scorecardsPrivate: true, feedbackEditLock: 'any_stage', resultRequired: true });
    await submitScorecard(t.interviewerA, id, { ratings: ratingsAll(5), result: 'recommended' });
    await updateInterviewSettings(admin, base.companyId, { scorecardsPrivate: true, feedbackEditLock: 'until_archived', resultRequired: true });
    await submitScorecard(t.interviewerA, id, { ratings: ratingsAll(2), result: 'not_suitable' });
    const reason = (await recruitmentSettings(admin, base.companyId)).reasons[0];
    await rejectApplication(t.manager, t.appX, reason.id); // the hiring manager may reject
    expect(await code(submitScorecard(t.interviewerA, id, { ratings: ratingsAll(1), result: 'not_suitable' }))).toBe('feedback_locked');
    // Feedback is never deleted, even by its author.
    expect(await code(rows(t.interviewerA, sql`delete from recruitment_scorecard where interview_id = ${id}::uuid`))).toMatch(/42501|23514/);
  });
});

/** Fields of the seeded offer set by label. */
async function offerFields() {
  const fields = (await offerSettings(admin, base.companyId)).fields;
  const f = (label: string) => fields.find((x) => x.label === label)!.id;
  return {
    jobOffered: f('Job offered'), department: f('Department'), start: f('Commencement date'), salary: f('Basic salary'),
    values: (salary: string, dept = 'Finance') => ({
      [f('Job offered')]: { text: 'Fictional data analyst' }, [f('Department')]: { text: dept }, [f('Commencement date')]: { text: '2026-12-01' },
      [f('Basic salary')]: { amount: salary, currency: 'MYR' },
    }),
  };
}

describe('case 14 — offer approval in step order', () => {
  it('approves in order, refuses the creator and out-of-turn approvers, returns a rejection to Draft and re-runs approval on an approval-field change', async () => {
    const t = await hiringTeam();
    const [first, second] = await Promise.all([person_('Fictional Approver One'), person_('Fictional Approver Two')]);
    await saveApprovalFlow(admin, base.companyId, 'offer', [first.userId, second.userId]);
    const f = await offerFields();
    const { id: offerId } = await saveOffer(t.recruiter, t.appX, f.values('5000'));
    expect(await submitOffer(t.recruiter, offerId)).toBe('pending');
    expect(await code(decideOffer(second, offerId, 'approve'))).toBe('not_your_step');
    expect(await code(decideOffer(t.recruiter, offerId, 'approve'))).toBe('not_your_step');
    expect(await decideOffer(first, offerId, 'approve')).toBe('pending');
    expect(await code(decideOffer(first, offerId, 'approve'))).toBe('not_your_step');
    expect(await code(decideOffer(second, offerId, 'reject'))).toBe('missing_fields');
    expect(await decideOffer(second, offerId, 'reject', 'Fictional: check the band')).toBe('rejected');
    let view = await applicationOffer(t.recruiter, t.appX);
    expect(view.offer).toMatchObject({ status: 'draft', lastRejectionComment: 'Fictional: check the band', round: 1 });
    expect(view.steps.map((s) => s.state)).toEqual(['approved', 'rejected']);

    // Round 2 approves in order.
    await submitOffer(t.recruiter, offerId);
    await decideOffer(first, offerId, 'approve');
    expect(await decideOffer(second, offerId, 'approve')).toBe('approved');
    // A non-approval field change keeps it approved; an approval-field change re-runs approval from step 1.
    expect((await saveOffer(t.recruiter, t.appX, f.values('5000', 'Operations'))).reapproval).toBe(false);
    expect((await applicationOffer(t.recruiter, t.appX)).offer?.status).toBe('approved');
    expect((await saveOffer(t.recruiter, t.appX, f.values('5200', 'Operations'))).reapproval).toBe(true);
    view = await applicationOffer(t.recruiter, t.appX);
    expect(view.offer).toMatchObject({ status: 'pending', round: 3 });
    expect(view.steps.map((s) => s.state)).toEqual(['pending', 'waiting']);
    // Withdraw while pending returns it to Draft.
    await withdrawOffer(t.recruiter, offerId);
    expect((await applicationOffer(t.recruiter, t.appX)).offer?.status).toBe('draft');

    // The creator cannot approve their own offer: refused at submission, and by the database guard.
    await saveApprovalFlow(admin, base.companyId, 'offer', [t.recruiter.userId]);
    expect(await code(submitOffer(t.recruiter, offerId))).toBe('self_approval');
    expect(await code(rows(t.recruiter, sql`update recruitment_offer set status = 'pending', approval_round = approval_round + 1,
      approver_user_ids = array[${t.recruiter.userId}::uuid], pending_position = 1 where id = ${offerId}::uuid`))).toBe('42501');
    // An approver cannot log a decision on a step that is not pending for them.
    expect(await code(rows(first, sql`insert into recruitment_offer_approval (tenant_id, company_id, job_id, offer_id, round, position, approver_user_id, decision)
      select tenant_id, company_id, job_id, id, approval_round, 1, ${first.userId}::uuid, 'approved' from recruitment_offer where id = ${offerId}::uuid`))).toMatch(/42501|23514/);

    // Mark as sent and the candidate's decision are recorded by a person; nothing is sent.
    await saveApprovalFlow(admin, base.companyId, 'offer', []);
    expect(await submitOffer(t.recruiter, offerId)).toBe('approved');
    await markOfferSent(t.recruiter, offerId, 'email');
    view = await applicationOffer(t.recruiter, t.appX);
    expect(view.offer).toMatchObject({ label: 'sent', sentChannel: 'email' });
    expect(view.offer?.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await updateOfferSettings(admin, base.companyId, { validDays: '15', acceptMovesForward: true, declineArchives: false });
    expect(await recordOfferDecision(t.recruiter, offerId, 'accepted')).toEqual({ moved: true, archived: false });
    expect(await code(saveOffer(t.recruiter, t.appX, f.values('9999')))).toMatch(/offer_closed|application_closed/);
  });

  it('the decline automation (off by default) archives with "Candidate declined the offer"', async () => {
    const t = await hiringTeam();
    const f = await offerFields();
    const { id: offerId } = await saveOffer(t.recruiter, t.appX, f.values('4800'));
    await submitOffer(t.recruiter, offerId);
    await markOfferSent(t.recruiter, offerId, 'other');
    await updateOfferSettings(admin, base.companyId, { validDays: '10', acceptMovesForward: false, declineArchives: true });
    expect(await recordOfferDecision(t.recruiter, offerId, 'declined')).toEqual({ moved: false, archived: true });
    const pool = await talentPool(admin, [base.companyId]);
    expect(pool.cards.map((c) => [c.applicationId, c.reason, c.stageLeft])).toEqual([[t.appX, 'Candidate declined the offer', 'Interview']]);
  });
});

describe('cases 14 and 17 — the database refuses approval writes that skip the approvers', () => {
  it('refuses an operator approving an offer, rewriting its approvers or advancing its step without a logged decision', async () => {
    const t = await hiringTeam();
    const [first, second] = await Promise.all([person_('Fictional Approver One'), person_('Fictional Approver Two')]);
    await saveApprovalFlow(admin, base.companyId, 'offer', [first.userId, second.userId]);
    const f = await offerFields();
    const { id: offerId } = await saveOffer(t.recruiter, t.appX, f.values('5000'));
    expect(await submitOffer(t.recruiter, offerId)).toBe('pending');
    for (const ctx of [t.recruiter, admin]) {
      expect(await code(rows(ctx, sql`update recruitment_offer set status = 'approved', pending_position = null where id = ${offerId}::uuid`))).toBe('42501');
      expect(await code(rows(ctx, sql`update recruitment_offer set pending_position = 2 where id = ${offerId}::uuid`))).toBe('42501');
      expect(await code(rows(ctx, sql`update recruitment_offer set approver_user_ids = array[${t.manager.userId}::uuid] where id = ${offerId}::uuid`))).toBe('42501');
      // A fresh "round" from a made-up flow is refused too: the approvers must be the company's offer flow.
      expect(await code(rows(ctx, sql`update recruitment_offer set approval_round = approval_round + 1, approver_user_ids = array[${t.manager.userId}::uuid], pending_position = 1 where id = ${offerId}::uuid`))).toBe('42501');
    }
    // The first approver's own step moves only after their logged decision; they cannot jump to approved.
    expect(await code(rows(first, sql`update recruitment_offer set status = 'approved', pending_position = null where id = ${offerId}::uuid`))).toBe('42501');
    expect(await decideOffer(first, offerId, 'approve')).toBe('pending');
    // A withdrawn round cannot be turned into an approval by a direct write either.
    await withdrawOffer(t.recruiter, offerId);
    expect(await code(rows(t.recruiter, sql`update recruitment_offer set status = 'approved' where id = ${offerId}::uuid`))).toBe('42501');
    expect((await applicationOffer(t.recruiter, t.appX)).offer?.status).toBe('draft');
  });

  it('refuses an administrator approving a requisition directly and restarts approval when a required field changes mid-round', async () => {
    const [one, two] = await Promise.all([person_('Fictional Requisition Approver One'), person_('Fictional Requisition Approver Two')]);
    await saveApprovalFlow(admin, base.companyId, 'requisition', [one.userId, two.userId]);
    const { id } = await createRequisition(admin, { companyId: base.companyId, title: 'Fictional analysts', vacancies: '2', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted' });
    expect(await code(rows(admin, sql`update recruitment_requisition set approval_status = 'not_required' where id = ${id}::uuid`))).toBe('42501');
    expect(await submitRequisition(admin, id)).toBe('pending');
    expect(await code(rows(admin, sql`update recruitment_requisition set approval_status = 'approved', pending_position = null where id = ${id}::uuid`))).toBe('42501');
    expect(await code(rows(admin, sql`update recruitment_requisition set approval_status = 'approved', pending_position = null, status = 'not_started' where id = ${id}::uuid`))).toBe('42501');
    expect(await code(rows(admin, sql`update recruitment_requisition set pending_position = 2 where id = ${id}::uuid`))).toBe('42501');
    // Step 1 approves; a required-field change while the round runs starts a new round from step 1.
    expect(await decideRequisition(one, id, 'approve')).toBe('pending');
    expect((await updateRequisition(admin, id, { companyId: base.companyId, title: 'Fictional analysts', vacancies: '50', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted' })).reapproval).toBe(true);
    expect((await getRequisition(admin, id)).requisition).toMatchObject({ status: 'draft', approvalStatus: 'pending', approvalRound: 2 });
    expect(await code(decideRequisition(two, id, 'approve'))).toBe('not_your_step');
    expect(await decideRequisition(one, id, 'approve')).toBe('pending');
    expect(await decideRequisition(two, id, 'approve')).toBe('approved');
    expect((await getRequisition(admin, id)).requisition).toMatchObject({ status: 'not_started', approvalStatus: 'approved' });
  });
});

describe('case 15 — private offer fields are hidden from users without access', () => {
  it('admins, the job recruiter and the creator see the salary; the hiring manager, an approver and other partners do not', async () => {
    const t = await hiringTeam();
    const approver = await person_('Fictional Approver');
    const otherPartner = await partnerFor(otherCompanyId, 'Fictional Other Partner');
    await saveApprovalFlow(admin, base.companyId, 'offer', [approver.userId]);
    const f = await offerFields();
    const { id: offerId } = await saveOffer(t.recruiter, t.appX, f.values('7345.67'));
    await submitOffer(t.recruiter, offerId);
    const salaryOf = async (ctx: SessionContext) => (await applicationOffer(ctx, t.appX)).fields.find((x) => x.id === f.salary)!;
    expect((await salaryOf(admin)).value).toEqual({ kind: 'money', amount: '7345.67', currency: 'MYR' });
    expect((await salaryOf(t.recruiter)).value).toEqual({ kind: 'money', amount: '7345.67', currency: 'MYR' });
    const hidden = await salaryOf(t.manager);
    expect(hidden).toMatchObject({ value: null, hidden: true });
    expect(JSON.stringify(await applicationOffer(t.manager, t.appX))).not.toContain('7345');
    const forApprover = await offerForApprover(approver, offerId);
    expect(forApprover.fields.find((x) => x.id === f.salary)).toMatchObject({ value: null, hidden: true });
    expect(forApprover.fields.find((x) => x.id === f.jobOffered)?.value).toEqual({ kind: 'text', text: 'Fictional data analyst' });
    expect(JSON.stringify(forApprover)).not.toContain('7345');
    // Row security: the same rows straight from the table.
    const valueRows = (ctx: SessionContext) => rows(ctx, sql`select field_id from recruitment_offer_value where offer_id = ${offerId}::uuid`);
    expect((await valueRows(admin)).map((r) => r.field_id)).toContain(f.salary);
    expect((await valueRows(t.manager)).map((r) => r.field_id)).not.toContain(f.salary);
    expect((await valueRows(approver)).map((r) => r.field_id)).not.toContain(f.salary);
    expect(await valueRows(otherPartner)).toHaveLength(0);
    expect(await valueRows(t.interviewerA)).toHaveLength(0);
    expect(await rows(otherPartner, sql`select 1 from recruitment_offer where id = ${offerId}::uuid`)).toHaveLength(0);
    // The approver can still decide on the step (pending for them) without seeing the salary.
    expect(await decideOffer(approver, offerId, 'approve')).toBe('approved');
    expect((await myApprovals(approver)).offers).toEqual([]);
  });
});

describe('case 16 — Start new hire', () => {
  it('is offered only at Onboarding or hired, pre-fills from the server, creates nothing until HR saves, and links the draft back', async () => {
    const t = await hiringTeam();
    const partner = await partnerFor(base.companyId, 'Fictional Partner');
    expect(await code(hireHandoffPrefill(admin, t.appX))).toBe('hire_not_eligible');
    await moveTo(t.recruiter, t.appX, 'Onboarding');
    expect(await code(hireHandoffPrefill(partner, t.appX))).toBe('forbidden'); // only an HR administrator starts the hire
    const before = await owner.db.execute<{ people: number; employments: number; drafts: number }>(sql`select
      (select count(*)::int from person where tenant_id = ${base.tenantId}::uuid) as people,
      (select count(*)::int from employment where tenant_id = ${base.tenantId}::uuid) as employments,
      (select count(*)::int from employee_draft where tenant_id = ${base.tenantId}::uuid) as drafts`);
    const prefill = await hireHandoffPrefill(admin, t.appX);
    expect(prefill).toEqual({ applicationId: t.appX, companyId: base.companyId, companyName: 'Acme Sdn Bhd', fullName: 'Fictional Candidate X', email: 'x@example.test', jobTitle: 'Fictional data analyst' });
    const afterPrefill = await owner.db.execute(sql`select
      (select count(*)::int from person where tenant_id = ${base.tenantId}::uuid) as people,
      (select count(*)::int from employment where tenant_id = ${base.tenantId}::uuid) as employments,
      (select count(*)::int from employee_draft where tenant_id = ${base.tenantId}::uuid) as drafts`);
    expect(afterPrefill).toEqual(before);
    // HR saves through the existing writer; only that creates the draft.
    const draft = await createEmployeeDraftWithReservedCode(admin, { companyId: prefill.companyId, fullName: prefill.fullName, primaryEmail: prefill.email, employeeIdMode: 'manual', employeeCode: 'RC0001' });
    await linkHireDraft(admin, t.appX, draft.id, draft.employeeCode);
    const [link] = await rows(admin, sql`select employee_draft_id, reserved_employee_code, linked_by_user_id from recruitment_hire_handoff where application_id = ${t.appX}::uuid`);
    expect(link).toEqual({ employee_draft_id: draft.id, reserved_employee_code: 'RC0001', linked_by_user_id: admin.userId });
    const [counts] = await owner.db.execute<{ people: number; employments: number; drafts: number }>(sql`select
      (select count(*)::int from person where tenant_id = ${base.tenantId}::uuid) as people,
      (select count(*)::int from employment where tenant_id = ${base.tenantId}::uuid) as employments,
      (select count(*)::int from employee_draft where tenant_id = ${base.tenantId}::uuid) as drafts`);
    expect(counts).toEqual({ ...before[0], drafts: before[0].drafts + 1 });
    expect(await code(hireHandoffPrefill(admin, t.appX))).toBe('hire_linked');
    expect(await code(linkHireDraft(admin, t.appX, draft.id))).toBe('hire_linked');
    // The database refuses a link to a draft of another company, and a link by a non-administrator.
    const otherDraft = await createEmployeeDraftWithReservedCode(admin, { companyId: otherCompanyId, fullName: 'Fictional Other', primaryEmail: 'other@example.test', employeeIdMode: 'manual', employeeCode: 'RC0002' });
    await moveTo(t.recruiter, t.appY, 'Onboarding');
    expect(await code(linkHireDraft(admin, t.appY, otherDraft.id))).toBe('23514');
    expect(await code(rows(t.recruiter, sql`insert into recruitment_hire_handoff (tenant_id, company_id, job_id, application_id, employee_draft_id, linked_by_user_id)
      select tenant_id, company_id, job_id, id, ${draft.id}::uuid, ${t.recruiter.userId}::uuid from recruitment_application where id = ${t.appY}::uuid`))).toMatch(/42501|23514/);
  });
});

describe('case 17 — requisitions: allowed statuses, terminal refusals and vacancy counts', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    companyId: base.companyId, title: 'Fictional analysts', vacancies: '3', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted', ...over,
  });
  it('moves only along the allowed statuses; terminal ones refuse every change', async () => {
    const { id, reqNumber } = await createRequisition(admin, req());
    expect(reqNumber).toBe('HC000001');
    expect((await createRequisition(admin, req())).reqNumber).toBe('HC000002');
    expect(await code(changeRequisitionStatus(admin, id, 'in_progress'))).toBe('invalid_status_change');
    expect(await code(rows(admin, sql`update recruitment_requisition set status = 'in_progress' where id = ${id}::uuid`))).toBe('23514');
    expect(await submitRequisition(admin, id)).toBe('not_required');
    await changeRequisitionStatus(admin, id, 'in_progress');
    await changeRequisitionStatus(admin, id, 'paused');
    expect(await code(changeRequisitionStatus(admin, id, 'not_started'))).toBe('invalid_status_change');
    await changeRequisitionStatus(admin, id, 'completed');
    expect(await code(changeRequisitionStatus(admin, id, 'in_progress'))).toBe('requisition_terminal');
    expect(await code(updateRequisition(admin, id, req({ title: 'Changed' })))).toBe('requisition_terminal');
    expect(await code(rows(admin, sql`update recruitment_requisition set title = 'Changed' where id = ${id}::uuid`))).toBe('23514');
    // Expired is by date only: past its target on-board date it may only be completed or cancelled.
    const { id: late } = await createRequisition(admin, req({ dateOpened: '2026-01-01', targetOnboardDate: '2026-02-01' }));
    expect((await getRequisition(admin, late)).status).toBe('expired');
    expect(await code(submitRequisition(admin, late))).toBe('invalid_status_change');
    await changeRequisitionStatus(admin, late, 'cancelled');
    expect((await getRequisition(admin, late)).status).toBe('cancelled');
  });

  it('runs approval in order, refuses the creator, resets approval when a required field changes outside Draft', async () => {
    const approver = await person_('Fictional Requisition Approver');
    const partner = await partnerFor(base.companyId, 'Fictional Creator Partner');
    await saveApprovalFlow(admin, base.companyId, 'requisition', [approver.userId]);
    const { id } = await createRequisition(partner, req());
    expect(await submitRequisition(partner, id)).toBe('pending');
    expect(await code(decideRequisition(partner, id, 'approve'))).toBe('not_your_step');
    expect((await myApprovals(approver)).requisitions.map((r) => r.id)).toEqual([id]);
    expect(await decideRequisition(approver, id, 'approve')).toBe('approved');
    expect((await getRequisition(partner, id)).requisition).toMatchObject({ status: 'not_started', approvalStatus: 'approved' });
    expect((await updateRequisition(partner, id, req({ benefits: 'Fictional medical cover' }))).reapproval).toBe(false);
    expect((await updateRequisition(partner, id, req({ vacancies: '4' }))).reapproval).toBe(true);
    expect((await getRequisition(partner, id)).requisition).toMatchObject({ approvalStatus: 'pending', approvalRound: 2 });
    expect(await code(changeRequisitionStatus(partner, id, 'in_progress'))).toBe('approval_pending');
    // The creator in the flow is refused.
    await saveApprovalFlow(admin, base.companyId, 'requisition', [partner.userId]);
    const { id: own } = await createRequisition(partner, req());
    expect(await code(submitRequisition(partner, own))).toBe('self_approval');
  });

  it('remaining offers and onboarding capacity equal independent counts, shown as 0 with a warning when over-filled', async () => {
    const t = await hiringTeam();
    const { id } = await createRequisition(admin, req({ vacancies: '3' }));
    await submitRequisition(admin, id);
    await associateJob(admin, id, t.jobId);
    // One hire, and one offer in process.
    let r = { state: 'active' as string };
    for (let i = 0; i < 20 && r.state === 'active'; i += 1) r = await moveApplication(t.recruiter, t.appX);
    const f = await offerFields();
    await saveOffer(t.recruiter, t.appY, f.values('4100'));
    const [independent] = await owner.db.execute<{ hired: number; offers: number }>(sql`select
      (select count(*)::int from recruitment_application a join recruitment_requisition_job rj on rj.job_id = a.job_id where rj.requisition_id = ${id}::uuid and a.state = 'hired') as hired,
      (select count(*)::int from recruitment_offer o join recruitment_application a on a.id = o.application_id join recruitment_requisition_job rj on rj.job_id = a.job_id
        where rj.requisition_id = ${id}::uuid and a.state = 'active' and o.candidate_decision <> 'declined') as offers`);
    expect(independent).toEqual({ hired: 1, offers: 1 });
    const detail = await getRequisition(admin, id);
    expect(detail.vacancy).toMatchObject({ vacancies: 3, onboarded: 1, offersInProcess: 1, remainingOffers: 3 - 1 - 1, remainingOnboarding: 3 - 1, overFilled: false });
    const listed = (await listRequisitions(admin, [base.companyId])).rows.find((x) => x.id === id)!;
    expect([listed.remainingOffers, listed.remainingOnboarding, listed.jobs]).toEqual([1, 2, 1]);
    // Over-filled: one vacancy for one hire and one offer.
    await updateRequisition(admin, id, req({ vacancies: '1' }));
    expect((await getRequisition(admin, id)).vacancy).toMatchObject({ remainingOffers: -1, shownOffers: 0, remainingOnboarding: 0, shownOnboarding: 0, overFilled: true });
  });
});

describe('case 18 — talent pool', () => {
  it('lists the rejected application with its pre-archiving stage and reason; "Add to job" opens a new application and leaves the archived one archived', async () => {
    const t = await hiringTeam();
    const { id: secondJob } = await createJob(admin, job({ title: 'Fictional business analyst' }));
    const reason = (await recruitmentSettings(admin, base.companyId)).reasons.find((x) => x.external === 'Package mismatch')!;
    await rejectApplication(t.recruiter, t.appX, reason.id);
    const pool = await talentPool(admin, [base.companyId]);
    expect(pool.totals).toEqual({ today: 1, total: 1 });
    expect(pool.cards).toHaveLength(1);
    expect(pool.cards[0]).toMatchObject({ applicationId: t.appX, candidateName: 'Fictional Candidate X', stageLeft: 'Interview', reason: 'Package mismatch', jobTitle: 'Fictional data analyst' });
    expect(pool.cards[0].addable.map((j) => j.id)).toEqual([secondJob]);
    const { applicationId } = await addPoolCandidateToJob(admin, t.appX, secondJob);
    const states = await rows(admin, sql`select a.id, a.state, a.job_id, s.name as stage from recruitment_application a join recruitment_stage s on s.id = a.current_stage_id
      where a.candidate_id = (select candidate_id from recruitment_application where id = ${t.appX}::uuid) order by a.applied_at`);
    expect(states).toEqual([
      { id: t.appX, state: 'archived', job_id: t.jobId, stage: 'Interview' },
      { id: applicationId, state: 'active', job_id: secondJob, stage: 'Application Review' },
    ]);
    expect(await code(addPoolCandidateToJob(admin, t.appX, secondJob))).toBe('duplicate_application');
    expect(await code(addPoolCandidateToJob(admin, applicationId, t.jobId))).toBe('not_in_pool');
    // Filters narrow it; another company's partner and a team member see none of it.
    expect((await talentPool(admin, [base.companyId], { reasonId: reason.id })).cards).toHaveLength(1);
    expect((await talentPool(admin, [base.companyId], { since: '2999-01-01' })).cards).toHaveLength(0);
    const otherPartner = await partnerFor(otherCompanyId, 'Fictional Other Partner');
    expect(await code(talentPool(otherPartner, [base.companyId]))).toBe('forbidden');
    expect(await code(talentPool(t.recruiter, [base.companyId]))).toBe('forbidden');
    expect(await code(listRequisitions(otherPartner, [base.companyId]))).toBe('forbidden');
  });
});

describe('every slice 2–4 table has forced row security, grants to the app role and none to PUBLIC', () => {
  it('holds for the fourteen new tables', async () => {
    const tables = ['recruitment_company_setting', 'recruitment_evaluation_form', 'recruitment_interview', 'recruitment_interview_interviewer', 'recruitment_scorecard',
      'recruitment_offer_field', 'recruitment_approval_step', 'recruitment_offer', 'recruitment_offer_value', 'recruitment_offer_approval', 'recruitment_hire_handoff',
      'recruitment_requisition', 'recruitment_requisition_approval', 'recruitment_requisition_job'];
    const found = await owner.db.execute<{ relname: string; rls: boolean; forced: boolean; app: boolean; public_grants: number; policies: number }>(sql`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, has_table_privilege('ai_hr_app', c.oid, 'SELECT') as app,
        (select count(*)::int from information_schema.role_table_grants g where g.table_name = c.relname and g.grantee = 'PUBLIC') as public_grants,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${tables.join(',')}}`}::text[]) order by c.relname`);
    expect(found.map((r) => r.relname)).toEqual([...tables].sort());
    expect(found.every((r) => r.rls && r.forced && r.app && r.public_grants === 0 && r.policies > 0)).toBe(true);
    // History tables: decisions and feedback are never updated or deleted by the app role.
    const [priv] = await owner.db.execute<{ upd: boolean; del: boolean; sdel: boolean }>(sql`select
      has_table_privilege('ai_hr_app', 'public.recruitment_offer_approval', 'UPDATE') or has_table_privilege('ai_hr_app', 'public.recruitment_requisition_approval', 'UPDATE') as upd,
      has_table_privilege('ai_hr_app', 'public.recruitment_offer_approval', 'DELETE') or has_table_privilege('ai_hr_app', 'public.recruitment_requisition_approval', 'DELETE') as del,
      has_table_privilege('ai_hr_app', 'public.recruitment_scorecard', 'DELETE') as sdel`);
    expect(priv).toEqual({ upd: false, del: false, sdel: false });
  });
});
