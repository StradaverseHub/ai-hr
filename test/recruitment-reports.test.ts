/**
 * Recruitment slice 6 against Postgres: acceptance cases 28–34 (docs/recruitment-reconstruction/specification.md
 * "Slice 6 acceptance cases") — the four report dashboards through the service, as the app role under row security.
 *
 * The fixture is built through the real services (applications, moves, rejections, interviews, scorecards, offers,
 * requisitions, a removal), so the stage history the funnel reads is the history the product writes. Only instants are
 * then moved onto fixed March 2026 Kuala Lumpur days through the owner connection (replica role, past the guards), with
 * deliberate edges at Kuala Lumpur midnight. Every expected figure below is worked out BY HAND from the fixture table in
 * the comments, never by re-running the report SQL; case 29 also checks them against differently written owner counts.
 * Every person and value is fictional (*@example.test); candidate personal values carry S6SENTINEL and are asserted absent
 * from every report result.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { addCalendarMonths, todayInKualaLumpur } from '../lib/hr-date';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import {
  addApplication, addJobMember, associateJob, createJob, createRequisition, destroyCandidates, markOfferSent, moveApplication, offerSettings,
  recordOfferDecision, recruitmentInterviewsReport, recruitmentOverviewReport, recruitmentPositionsReport, recruitmentSettings,
  recruitmentTeamReport, recruitmentViewer, rejectApplication, saveCandidateRestricted, saveOffer, scheduleInterview, cancelInterview, submitOffer,
  submitRequisition, submitScorecard, NO_VALUE, RecruitmentError, formatNumber, formatPercent,
} from '../packs/recruitment/service';
import { ReportTooSlowError, toReportError } from '../packs/recruitment/reports';
import { addDays } from '../packs/recruitment/report-model';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SENTINEL = 'S6SENTINEL';
const P = { from: '2026-03-01', to: '2026-03-31' };
let base: Base;
let admin: SessionContext;
let otherCompanyId: string;
let thirdCompanyId: string;
let gradeId: string;
const ctx: Record<'recruiter' | 'manager' | 'recruiter2' | 'interviewer' | 'interviewer2' | 'bystander' | 'partner' | 'otherPartner' | 'partnerT' | 'interviewerT', SessionContext> = {} as never;
const ids: Record<string, string> = {};

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
async function person_(name: string, companyId = base.companyId): Promise<SessionContext> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
async function partnerFor(companyId: string, name: string): Promise<SessionContext> {
  const c = await person_(name, companyId);
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: c.userId!, companyId, role: 'recruiting_partner' });
  return { ...c, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time', ...over,
});
const kl = (local: string) => `${local}+08:00`;
const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
let stages: Map<string, string>;
const stage = (name: string) => stages.get(name)!;
const ratings = (v: number) => Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5'].map((k) => [k, { rating: String(v), notes: `${SENTINEL} note ${k}` }]));

/** Owner-side time travel past the guards: the application's history rows, in the order written, get these instants. */
async function history(applicationId: string, times: string[]) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const rows = await tx<{ id: string }[]>`select id from recruitment_application_event where application_id = ${applicationId}::uuid order by occurred_at, id`;
    expect(rows.length, `history rows of ${applicationId}`).toBe(times.length);
    for (const [i, row] of rows.entries()) await tx`update recruitment_application_event set occurred_at = ${times[i]}::timestamptz where id = ${row.id}::uuid`;
    await tx`update recruitment_application set applied_at = ${times[0]}::timestamptz, state_changed_at = ${times[times.length - 1]}::timestamptz where id = ${applicationId}::uuid`;
  });
}
async function interviewAt(interviewId: string, startsAt: string, createdAt: string) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_interview set starts_at = ${startsAt}::timestamptz, created_at = ${createdAt}::timestamptz where id = ${interviewId}::uuid`;
  });
}
async function offerAt(offerId: string, createdAt: string, sentAt: string) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_offer set created_at = ${createdAt}::timestamptz, sent_at = ${sentAt}::timestamptz, decided_at = ${sentAt}::timestamptz + interval '1 day' where id = ${offerId}::uuid`;
  });
}

let n = 0;
async function apply(as: SessionContext, jobId: string, source?: string) {
  n += 1;
  return addApplication(as, {
    jobId, fullName: `${SENTINEL} Candidate ${n}`, email: `s6sentinel.c${n}@example.test`, phone: `01${n % 10}-555 ${1000 + n}`,
    ...(source ? { candidateSource: source } : {}), idType: 'nric', idNumber: `${SENTINEL}-ID-${n}`,
  });
}
async function offer(as: SessionContext, applicationId: string, decision: 'accepted' | 'declined') {
  const fields = (await offerSettings(admin, base.companyId)).fields;
  const fid = (label: string) => fields.find((f) => f.label === label)!.id;
  const { id } = await saveOffer(as, applicationId, {
    [fid('Job offered')]: { text: `${SENTINEL} offer text` }, [fid('Department')]: { text: 'Finance' }, [fid('Commencement date')]: { text: '2026-12-01' },
    [fid('Basic salary')]: { amount: '98765.43', currency: 'MYR' },
  });
  expect(await submitOffer(as, id)).toBe('approved');
  await markOfferSent(as, id, 'email');
  await recordOfferDecision(as, id, decision);
  return id;
}

/**
 * THE FIXTURE (period P = 1–31 March 2026, Kuala Lumpur). Process stages: Application Review (1), Recruiter's Screening (2),
 * AI Interview (3), Hiring Manager Review (4), Interview (5), Offer (6), Medical (7), Background (8), Onboarding (9), then Hired.
 *
 * Job A (base company, department A; recruiter R, hiring manager M), interviewer I:
 *   A1 applied 1 Mar 00:00 KL (= 28 Feb 16:00 UTC, IN) referral. AR → Interview (2 Mar) → iv1 held 5 Mar, I: recommended
 *      → Offer (8 Mar); offer created 10 Mar, sent 11 Mar, accepted → Onboarding (15 Mar) → HIRED 20 Mar. 19 days to hire.
 *   A2 applied 2 Mar 09:00, job_board. AR → Interview (3 Mar) → iv2 held 6 Mar, I: not suitable → REJECTED 7 Mar.
 *   A3 applied 15 Mar 12:00 (Sunday), no source. AR → (forward) Recruiter's Screening (16 Mar) → REJECTED 17 Mar.
 *   A4 applied 31 Mar 23:59:59 (IN), referral. Active at AR.
 *   A5 applied 28 Feb 23:59:59 (OUT), agency. AR → Interview (2 Mar) → iv5 held 3 Mar, I: NO scorecard. Active at Interview.
 *   A6 applied 1 Apr 00:00 (OUT). Active at AR.
 *   A7 applied 10 Mar 10:00, walk_in. REJECTED at AR 12 Mar; candidate then REMOVED (slice 5) — source cleared.
 *   A8 applied 10 Jan (OUT). AR → Interview (1 Feb) → ivA8 held 10 Feb (previous period), I → Onboarding (12 Feb). Active.
 * Job B (base company, no department; recruiter R2), interviewer J:
 *   B1 applied 20 Mar 08:00, career_page. AR → Interview (21 Mar) → ivB1 held 25 Mar, J: keep in view → Offer (26 Mar);
 *      offer created 26 Mar, sent 27 Mar, DECLINED; stays active at Offer.
 *   B2 applied 21 Mar 08:00, other. AR → Interview (22 Mar); ivB3 22 Mar CANCELLED; ivB2 in 30 days (upcoming).
 * Job C (other company; no recruiter): C1 applied 5 Mar.
 * Requisitions (base): Q1 opened 2 Mar, 3 vacancies, job A, submitted; Q2 opened 5 Mar, 5 vacancies, DRAFT;
 *   Q3 opened 15 Feb, 2 vacancies, submitted.
 */
async function buildFixture() {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
  [ctx.recruiter, ctx.manager, ctx.recruiter2, ctx.interviewer, ctx.interviewer2, ctx.bystander] = await Promise.all([
    person_('Fictional Recruiter R'), person_('Fictional Manager M'), person_('Fictional Recruiter R2'), person_('Fictional Interviewer I'),
    person_('Fictional Interviewer J'), person_('Fictional Bystander'),
  ]);
  ctx.partner = await partnerFor(base.companyId, 'Fictional Partner');
  ctx.otherPartner = await partnerFor(otherCompanyId, 'Fictional Other Partner');
  ids.jobA = (await createJob(admin, job({ title: 'Fictional job A', departmentId: base.deptA, recruiterUserId: ctx.recruiter.userId }))).id;
  await addJobMember(admin, ids.jobA, 'hiring_manager', ctx.manager.userId);
  ids.jobB = (await createJob(admin, job({ title: 'Fictional job B', recruiterUserId: ctx.recruiter2.userId }))).id;
  ids.jobC = (await createJob(admin, job({ companyId: otherCompanyId, title: 'Fictional job C' }))).id;
  stages = new Map((await recruitmentSettings(admin, base.companyId)).stages.map((s) => [s.name, s.id]));
  const reason = (await recruitmentSettings(admin, base.companyId)).reasons[0].id;
  const R = ctx.recruiter;
  const R2 = ctx.recruiter2;

  // A1 — the full path to hire.
  const a1 = await apply(R, ids.jobA, 'referral');
  await moveApplication(R, a1.applicationId, stage('Interview'));
  const iv1 = await scheduleInterview(R, { applicationId: a1.applicationId, type: 'video', startsAt: recent(180), durationMinutes: 60, interviewerIds: [ctx.interviewer.userId] });
  await submitScorecard(ctx.interviewer, iv1.id, { ratings: ratings(4), result: 'recommended', overview: `${SENTINEL} overview` });
  await moveApplication(R, a1.applicationId, stage('Offer'));
  const o1 = await offer(R, a1.applicationId, 'accepted');
  await moveApplication(R, a1.applicationId, stage('Onboarding'));
  expect((await moveApplication(R, a1.applicationId)).state).toBe('hired');
  await history(a1.applicationId, [kl('2026-03-01T00:00:00'), kl('2026-03-02T10:00:00'), kl('2026-03-08T10:00:00'), kl('2026-03-15T10:00:00'), kl('2026-03-20T09:00:00')]);
  await interviewAt(iv1.id, kl('2026-03-05T10:00:00'), kl('2026-03-02T11:00:00'));
  await offerAt(o1, kl('2026-03-10T10:00:00'), kl('2026-03-11T10:00:00'));
  await saveCandidateRestricted(R, a1.candidateId, { currentSalaryAmount: '98765.43', currentSalaryCurrency: 'MYR', expectedSalaryAmount: '98765.43', expectedSalaryCurrency: 'MYR' });

  // A2 — interviewed, rejected.
  const a2 = await apply(R, ids.jobA, 'job_board');
  await moveApplication(R, a2.applicationId, stage('Interview'));
  const iv2 = await scheduleInterview(R, { applicationId: a2.applicationId, type: 'onsite', startsAt: recent(170), durationMinutes: 45, interviewerIds: [ctx.interviewer.userId] });
  await submitScorecard(ctx.interviewer, iv2.id, { ratings: ratings(2), result: 'not_suitable' });
  await rejectApplication(R, a2.applicationId, reason);
  await history(a2.applicationId, [kl('2026-03-02T09:00:00'), kl('2026-03-03T09:00:00'), kl('2026-03-07T09:00:00')]);
  await interviewAt(iv2.id, kl('2026-03-06T10:00:00'), kl('2026-03-03T10:00:00'));

  // A3 — screened, rejected.
  const a3 = await apply(R, ids.jobA);
  await moveApplication(R, a3.applicationId);
  await rejectApplication(R, a3.applicationId, reason);
  await history(a3.applicationId, [kl('2026-03-15T12:00:00'), kl('2026-03-16T12:00:00'), kl('2026-03-17T12:00:00')]);

  // A4 — the last second of the period.
  const a4 = await apply(R, ids.jobA, 'referral');
  await history(a4.applicationId, [kl('2026-03-31T23:59:59')]);

  // A5 — applied the last second before the period; its interview is in the period with no feedback.
  const a5 = await apply(R, ids.jobA, 'agency');
  await moveApplication(R, a5.applicationId, stage('Interview'));
  const iv5 = await scheduleInterview(R, { applicationId: a5.applicationId, type: 'phone', startsAt: recent(160), durationMinutes: 30, interviewerIds: [ctx.interviewer.userId] });
  await history(a5.applicationId, [kl('2026-02-28T23:59:59'), kl('2026-03-02T11:00:00')]);
  await interviewAt(iv5.id, kl('2026-03-03T10:00:00'), kl('2026-03-02T12:00:00'));

  // A6 — the first second after the period.
  const a6 = await apply(R, ids.jobA);
  await history(a6.applicationId, [kl('2026-04-01T00:00:00')]);

  // A7 — rejected, then the candidate is removed (slice 5): the application stays and counts, anonymously.
  const a7 = await apply(R, ids.jobA, 'walk_in');
  await rejectApplication(R, a7.applicationId, reason);
  await history(a7.applicationId, [kl('2026-03-10T10:00:00'), kl('2026-03-12T10:00:00')]);
  expect(await destroyCandidates(admin, base.companyId, [a7.candidateId], 'on')).toEqual({ removed: 1 });

  // A8 — before the period; interviewed in the previous period; now at Onboarding.
  const a8 = await apply(R, ids.jobA);
  await moveApplication(R, a8.applicationId, stage('Interview'));
  const iv8 = await scheduleInterview(R, { applicationId: a8.applicationId, type: 'video', startsAt: recent(150), durationMinutes: 60, interviewerIds: [ctx.interviewer.userId] });
  await moveApplication(R, a8.applicationId, stage('Onboarding'));
  await history(a8.applicationId, [kl('2026-01-10T09:00:00'), kl('2026-02-01T09:00:00'), kl('2026-02-12T09:00:00')]);
  await interviewAt(iv8.id, kl('2026-02-10T10:00:00'), kl('2026-02-01T10:00:00'));

  // B1 — interviewed, offer declined, still at Offer.
  const b1 = await apply(R2, ids.jobB, 'career_page');
  await moveApplication(R2, b1.applicationId, stage('Interview'));
  const ivB1 = await scheduleInterview(R2, { applicationId: b1.applicationId, type: 'video', startsAt: recent(140), durationMinutes: 60, interviewerIds: [ctx.interviewer2.userId] });
  await submitScorecard(ctx.interviewer2, ivB1.id, { ratings: ratings(3), result: 'keep_in_view' });
  await moveApplication(R2, b1.applicationId, stage('Offer'));
  const oB1 = await offer(R2, b1.applicationId, 'declined');
  await history(b1.applicationId, [kl('2026-03-20T08:00:00'), kl('2026-03-21T08:00:00'), kl('2026-03-26T08:00:00')]);
  await interviewAt(ivB1.id, kl('2026-03-25T10:00:00'), kl('2026-03-21T09:00:00'));
  await offerAt(oB1, kl('2026-03-26T10:00:00'), kl('2026-03-27T10:00:00'));

  // B2 — a cancelled interview in the period and an upcoming one.
  const b2 = await apply(R2, ids.jobB, 'other');
  await moveApplication(R2, b2.applicationId, stage('Interview'));
  const ivB3 = await scheduleInterview(R2, { applicationId: b2.applicationId, type: 'video', startsAt: recent(130), durationMinutes: 60, interviewerIds: [ctx.interviewer2.userId] });
  await cancelInterview(R2, ivB3.id);
  const ivB2 = await scheduleInterview(R2, { applicationId: b2.applicationId, type: 'video', startsAt: new Date(Date.now() + 30 * 86_400_000), durationMinutes: 60, interviewerIds: [ctx.interviewer2.userId] });
  await history(b2.applicationId, [kl('2026-03-21T08:00:00'), kl('2026-03-22T08:00:00')]);
  await interviewAt(ivB3.id, kl('2026-03-22T10:00:00'), kl('2026-03-21T10:00:00'));
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_interview set created_at = ${kl('2026-03-23T10:00:00')}::timestamptz where id = ${ivB2.id}::uuid`;
  });

  // C1 — another company.
  const c1 = await addApplication(admin, { jobId: ids.jobC, fullName: `${SENTINEL} Candidate C`, email: 's6sentinel.cc@example.test' });
  await history(c1.applicationId, [kl('2026-03-05T09:00:00')]);

  // Requisitions.
  const req = (over: Record<string, unknown>) => createRequisition(admin, {
    companyId: base.companyId, title: 'Fictional requisition', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted', ...over,
  });
  const q1 = await req({ vacancies: '3', dateOpened: '2026-03-02' });
  await associateJob(admin, q1.id, ids.jobA);
  expect(await submitRequisition(admin, q1.id)).toBe('not_required');
  await req({ vacancies: '5', dateOpened: '2026-03-05' });
  const q3 = await req({ vacancies: '2', dateOpened: '2026-02-15' });
  expect(await submitRequisition(admin, q3.id)).toBe('not_required');
  // Third company T (fixture for the pass-rate timing and mixed-scope requisition cases), job E, operated by the admin:
  //   E1 applied 3 Mar: AR → Interview (4 Mar) → Offer (5 Mar) → BACK to Interview (6 Mar) → ivE1 held 10 Mar. Still at Interview.
  //      It entered a later stage only BEFORE its interview: not a pass, no outcome.
  //   E2 applied 3 Mar: AR → Interview (4 Mar) → ivE2 held 10 Mar → Offer (12 Mar): a pass.
  // partnerT: employed in T, Recruiting Partner for the BASE company, hiring manager on job E (administers base, team in T).
  [{ id: thirdCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Third Sdn Bhd' }).returning({ id: company.id });
  ctx.interviewerT = await person_('Fictional Interviewer K', thirdCompanyId);
  ctx.partnerT = await person_('Fictional Partner T', thirdCompanyId);
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: ctx.partnerT.userId!, companyId: base.companyId, role: 'recruiting_partner' });
  ctx.partnerT = { ...ctx.partnerT, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: base.companyId }] };
  ids.jobE = (await createJob(admin, job({ companyId: thirdCompanyId, title: 'Fictional job E' }))).id;
  await addJobMember(admin, ids.jobE, 'hiring_manager', ctx.partnerT.userId);
  const stagesT = new Map((await recruitmentSettings(admin, thirdCompanyId)).stages.map((st) => [st.name, st.id]));
  const e1 = await apply(admin, ids.jobE);
  await moveApplication(admin, e1.applicationId, stagesT.get('Interview'));
  await moveApplication(admin, e1.applicationId, stagesT.get('Offer'));
  await moveApplication(admin, e1.applicationId, stagesT.get('Interview'));
  const ivE1 = await scheduleInterview(admin, { applicationId: e1.applicationId, type: 'video', startsAt: recent(120), durationMinutes: 60, interviewerIds: [ctx.interviewerT.userId] });
  await history(e1.applicationId, [kl('2026-03-03T09:00:00'), kl('2026-03-04T09:00:00'), kl('2026-03-05T09:00:00'), kl('2026-03-06T09:00:00')]);
  await interviewAt(ivE1.id, kl('2026-03-10T10:00:00'), kl('2026-03-06T10:00:00'));
  const e2 = await apply(admin, ids.jobE);
  await moveApplication(admin, e2.applicationId, stagesT.get('Interview'));
  const ivE2 = await scheduleInterview(admin, { applicationId: e2.applicationId, type: 'video', startsAt: recent(110), durationMinutes: 60, interviewerIds: [ctx.interviewerT.userId] });
  await moveApplication(admin, e2.applicationId, stagesT.get('Offer'));
  await history(e2.applicationId, [kl('2026-03-03T10:00:00'), kl('2026-03-04T10:00:00'), kl('2026-03-12T10:00:00')]);
  await interviewAt(ivE2.id, kl('2026-03-10T11:00:00'), kl('2026-03-04T11:00:00'));
  Object.assign(ids, { a1: a1.applicationId, a7cand: a7.candidateId });
}

beforeAll(async () => {
  await migrateTestDb();
  await buildFixture();
}, 240_000);
afterAll(closeAll);

/** No candidate value of any kind may appear in a report result. */
function assertNoPersonalData(result: unknown) {
  const text = JSON.stringify(result);
  for (const needle of [SENTINEL, 's6sentinel', 'example.test', '98765', 'Removed candidate']) expect(text, `report leaks ${needle}`).not.toContain(needle);
  expect(text, 'report leaks a phone number').not.toMatch(/01\d-555 1\d{3}/);
}
const base_ = () => [base.companyId, otherCompanyId];
const atBase = { companyId: () => base.companyId };

describe('case 28 — access', () => {
  it('administrators see their companies, a partner only theirs, a recruiter or hiring manager only their jobs; interviewers and bystanders get no tab and a refusal', async () => {
    // Administrator (group-wide): both companies — 7 base applications + C1.
    const all = await recruitmentOverviewReport(admin, base_(), P);
    expect(all.applications).toBe(8);
    expect(all.scope.companies.map((c) => c.id).sort()).toEqual(base_().sort());
    expect(all.scope.adminScope).toBe(true);
    // Base partner: base only (7); the other company is refused, not silently emptied.
    const partner = await recruitmentOverviewReport(ctx.partner, base_(), P);
    expect(partner.applications).toBe(7);
    expect(partner.scope.companies.map((c) => c.id)).toEqual([base.companyId]);
    expect(await code(recruitmentOverviewReport(ctx.partner, base_(), { ...P, companyId: otherCompanyId }))).toBe('forbidden');
    // The other company's partner: job C only.
    expect((await recruitmentOverviewReport(ctx.otherPartner, base_(), P)).applications).toBe(1);
    // Recruiter R and hiring manager M: job A only (A1, A2, A3, A4, A7), no requisition figures, no Team.
    for (const c of [ctx.recruiter, ctx.manager]) {
      const mine = await recruitmentOverviewReport(c, base_(), P);
      expect(mine.applications).toBe(5);
      expect(mine.jobs.map((j) => j.id)).toEqual([ids.jobA]);
      expect(mine.scope.jobs.map((j) => j.id)).toEqual([ids.jobA]);
      expect(mine.scope.adminScope).toBe(false);
      expect(mine.scope.teamAvailable).toBe(false);
      expect(mine.requisitions).toBeNull();
      expect((await recruitmentPositionsReport(c, base_(), P)).totals.applications).toBe(5);
      expect(await code(recruitmentTeamReport(c, base_(), P))).toBe('forbidden');
      // Another job of the same company is not theirs to report on.
      expect(await code(recruitmentOverviewReport(c, base_(), { ...P, jobId: ids.jobB }))).toBe('not_found');
    }
    // Recruiter R2: job B only.
    expect((await recruitmentOverviewReport(ctx.recruiter2, base_(), P)).applications).toBe(2);
    // The viewer's Reports tab: administrators, partners and job reviewers; never an interviewer alone or a bystander.
    expect((await recruitmentViewer(ctx.manager, base_())).reportCompanies.map((c) => c.id)).toEqual([base.companyId]);
    for (const c of [ctx.interviewer, ctx.interviewer2, ctx.bystander]) {
      expect((await recruitmentViewer(c, base_())).reportCompanies).toEqual([]);
      for (const run of [recruitmentOverviewReport, recruitmentPositionsReport, recruitmentInterviewsReport, recruitmentTeamReport]) {
        expect(await code(run(c, base_(), P))).toBe('forbidden');
      }
    }
  });

  it('no candidate name, email, phone or restricted value appears in any report result', async () => {
    for (const c of [admin, ctx.partner, ctx.recruiter, ctx.manager]) {
      for (const run of [recruitmentOverviewReport, recruitmentPositionsReport, recruitmentInterviewsReport]) assertNoPersonalData(await run(c, base_(), P));
    }
    assertNoPersonalData(await recruitmentTeamReport(admin, base_(), P));
  });
});

describe('case 29 — Overview', () => {
  it('matches hand-worked figures, including the Kuala Lumpur midnight edges', async () => {
    const r = await recruitmentOverviewReport(admin, base_(), { ...P, companyId: atBase.companyId() });
    // In: A1 (1 Mar 00:00), A2, A3, A4 (31 Mar 23:59:59), A7, B1, B2. Out: A5 (28 Feb 23:59:59), A6 (1 Apr 00:00), A8.
    expect({ applications: r.applications, offersCreated: r.offersCreated, offersSent: r.offersSent, hired: r.hired, onboardingNow: r.onboardingNow })
      .toEqual({ applications: 7, offersCreated: 2, offersSent: 2, hired: 1, onboardingNow: 1 });
    // Q1 only (Q2 is a draft, Q3 opened before the period): 1 of 3 vacancies filled (A1 hired on job A).
    expect(r.requisitions).toEqual({ count: 1, vacancies: 3, filled: 1, completionRate: 1 / 3 });
    expect(r.byStage).toEqual([
      { name: 'Application Review', count: 2 }, { name: 'Interview', count: 2 }, { name: 'Offer', count: 1 }, { name: 'Onboarding', count: 1 },
    ]);
    expect(r.bySource).toEqual([
      { source: 'referral', count: 2 }, { source: 'unknown', count: 2 }, { source: 'career_page', count: 1 }, { source: 'job_board', count: 1 }, { source: 'other', count: 1 },
    ]);
    expect(r.jobs).toEqual([
      { id: ids.jobA, jobNumber: expect.stringMatching(/^MJ\d{6}$/), title: 'Fictional job A', applications: 5, interviewed: 2, offers: 1, hired: 1, vacancies: 3 },
      { id: ids.jobB, jobNumber: expect.stringMatching(/^MJ\d{6}$/), title: 'Fictional job B', applications: 2, interviewed: 1, offers: 1, hired: 0, vacancies: null },
    ]);
    expect(r.jobsTotal).toBe(2);
    // The department filter narrows to job A.
    expect((await recruitmentOverviewReport(admin, base_(), { ...P, companyId: base.companyId, departmentId: base.deptA })).applications).toBe(5);

    // Independent owner counts, written differently (calendar-day casts instead of instant bounds).
    const [own] = await owner.db.execute<{ apps: number; offers: number; sent: number; hired: number }>(sql`
      select count(*)::int as apps, count(o.id)::int as offers, count(o.sent_at)::int as sent, count(*) filter (where a.state = 'hired')::int as hired
      from recruitment_application a left join recruitment_offer o on o.application_id = a.id
      where a.company_id = ${base.companyId}::uuid and (a.applied_at at time zone 'Asia/Kuala_Lumpur')::date between '2026-03-01' and '2026-03-31'`);
    expect(own).toEqual({ apps: r.applications, offers: r.offersCreated, sent: r.offersSent, hired: r.hired });
    // Moving the period by one day on either side moves exactly the edge applications.
    expect((await recruitmentOverviewReport(admin, base_(), { companyId: base.companyId, from: '2026-02-28', to: '2026-03-30' })).applications).toBe(7); // +A5 −A4
    expect((await recruitmentOverviewReport(admin, base_(), { companyId: base.companyId, from: '2026-03-02', to: '2026-04-01' })).applications).toBe(7); // −A1 +A6
    expect((await recruitmentOverviewReport(admin, base_(), { companyId: base.companyId, from: '2026-03-01', to: '2026-03-01' })).applications).toBe(1); // A1 only
  });
});

describe('case 30 — Positions', () => {
  it('applications per hire, acceptance rate and average days to hire match hand-computed values; zero denominators show "—"', async () => {
    const r = await recruitmentPositionsReport(admin, base_(), { ...P, companyId: base.companyId });
    expect(r.totals).toEqual({
      applications: 7, interviewed: 3, offersCreated: 2, offersSent: 2, accepted: 1, declined: 1, hired: 1, rejected: 3,
      applicationsPerHire: 7, acceptanceRate: 0.5, averageDaysToHire: 19,
    });
    const [a, b] = r.jobs;
    expect(a).toMatchObject({ id: ids.jobA, applications: 5, interviewed: 2, offersCreated: 1, offersSent: 1, accepted: 1, declined: 0, hired: 1, rejected: 3,
      applicationsPerHire: 5, acceptanceRate: 1, averageDaysToHire: 19 });
    expect(b).toMatchObject({ id: ids.jobB, applications: 2, interviewed: 1, offersCreated: 1, offersSent: 1, accepted: 0, declined: 1, hired: 0, rejected: 0,
      applicationsPerHire: null, acceptanceRate: 0, averageDaysToHire: null });
    expect(formatNumber(b.applicationsPerHire, 'en')).toBe(NO_VALUE);
    expect(formatNumber(b.averageDaysToHire, 'en', 0)).toBe(NO_VALUE);
    // Job C (other company) has no offer at all: acceptance has nothing to divide by.
    const c = await recruitmentPositionsReport(ctx.otherPartner, base_(), P);
    expect(c.totals).toMatchObject({ applications: 1, hired: 0, applicationsPerHire: null, acceptanceRate: null, averageDaysToHire: null });
    expect(formatPercent(c.totals.acceptanceRate, 'en')).toBe(NO_VALUE);
    // An empty period: every rate is "—", never 0 or an error.
    const empty = await recruitmentPositionsReport(admin, base_(), { companyId: base.companyId, from: '2025-06-01', to: '2025-06-30' });
    expect(empty.totals).toEqual({ applications: 0, interviewed: 0, offersCreated: 0, offersSent: 0, accepted: 0, declined: 0, hired: 0, rejected: 0,
      applicationsPerHire: null, acceptanceRate: null, averageDaysToHire: null });
    expect(empty.jobs).toEqual([]);
  });
});

describe('case 31 — funnel from the application history', () => {
  it('counts applications that reached each stage even when later archived, and only stages actually entered', async () => {
    const r = await recruitmentPositionsReport(admin, base_(), { ...P, companyId: base.companyId, jobId: ids.jobA });
    expect(r.jobs).toHaveLength(1);
    // A1 AR→Interview→Offer→Onboarding→hired; A2 AR→Interview→rejected; A3 AR→Screening→rejected; A4 AR; A7 AR→rejected.
    // AI Interview, Hiring Manager Review, Medical and Background were skipped by every application.
    expect(r.jobs[0].funnel.map((f) => [f.name, f.count])).toEqual([
      ['Application Review', 5], ["Recruiter's Screening", 1], ['AI Interview', 0], ['Hiring Manager Review', 0], ['Interview', 2], ['Offer', 1],
      ['Medical check-up', 0], ['Background check', 0], ['Onboarding', 1],
    ]);
    expect(r.jobs[0].hired).toBe(1);
  });
});

describe('case 32 — Interviews', () => {
  it('feedback rate, pending feedback, result distribution, pass rate and the previous-period change match; cancelled interviews are excluded', async () => {
    const r = await recruitmentInterviewsReport(admin, base_(), { ...P, companyId: base.companyId });
    // Held in March: iv1, iv2, iv5 (A) and ivB1 (B); ivB3 was cancelled; ivB2 is upcoming. Previous period 29 Jan – 28 Feb: iv8.
    expect(r.previousPeriod).toEqual({ from: '2026-01-29', to: '2026-02-28' });
    expect({ held: r.held, previousHeld: r.previousHeld, change: r.change }).toEqual({ held: 4, previousHeld: 1, change: { delta: 3, rate: 3 } });
    expect({ places: r.places, submitted: r.submitted, feedbackRate: r.feedbackRate, pendingFeedback: r.pendingFeedback, upcoming: r.upcoming })
      .toEqual({ places: 4, submitted: 3, feedbackRate: 0.75, pendingFeedback: 1, upcoming: 1 });
    expect(r.results).toEqual({ recommended: 1, keepInView: 1, notSuitable: 1, noResult: 0 });
    // A1 hired (passed); B1 moved on to Offer (passed); A2 rejected (outcome, not passed); A5 still at Interview (no outcome).
    expect({ interviewed: r.interviewedApplications, passed: r.passed, withOutcome: r.withOutcome, passRate: r.passRate })
      .toEqual({ interviewed: 4, passed: 2, withOutcome: 3, passRate: 2 / 3 });
    // The hiring manager sees job A's interviews only.
    const m = await recruitmentInterviewsReport(ctx.manager, base_(), P);
    expect({ held: m.held, places: m.places, submitted: m.submitted, upcoming: m.upcoming, passed: m.passed, withOutcome: m.withOutcome })
      .toEqual({ held: 3, places: 3, submitted: 2, upcoming: 0, passed: 1, withOutcome: 2 });
    // A previous period with nothing held: the relative change is "—".
    const april = await recruitmentInterviewsReport(admin, base_(), { companyId: base.companyId, from: '2026-04-01', to: '2026-04-30' });
    expect(april).toMatchObject({ held: 0, previousHeld: 4, feedbackRate: null, passRate: null });
    const jan = await recruitmentInterviewsReport(admin, base_(), { companyId: base.companyId, from: '2026-02-01', to: '2026-02-28' });
    expect(jan).toMatchObject({ held: 1, previousHeld: 0, change: { delta: 1, rate: null } });
  });
});

describe('case 33 — Team', () => {
  it('is for administrators only, and per-recruiter counts match', async () => {
    const r = await recruitmentTeamReport(admin, base_(), { ...P, companyId: base.companyId });
    // R (job A): moved out of AR in March — A1, A2, A3 (forward), A5, A7 (rejected) = 5; interviews created in March iv1, iv2, iv5 = 3
    // (iv8 was created in February); offers created 1 (A1); hires 1 (A1). R2 (job B): moved B1, B2 = 2; interviews ivB1, ivB3 (cancelled
    // later, still scheduled), ivB2 = 3; offers 1; hires 0.
    expect(r.rows).toEqual([
      { recruiterUserId: ctx.recruiter.userId, recruiterName: 'Fictional Recruiter R', jobs: 1, movedFromFirstStage: 5, interviewsScheduled: 3, offersCreated: 1, hires: 1 },
      { recruiterUserId: ctx.recruiter2.userId, recruiterName: 'Fictional Recruiter R2', jobs: 1, movedFromFirstStage: 2, interviewsScheduled: 3, offersCreated: 1, hires: 0 },
    ]);
    expect(r.rowsTotal).toBe(2);
    // Both companies: job C has no recruiter and did no work in March.
    const all = await recruitmentTeamReport(admin, base_(), P);
    expect(all.rows.at(-1)).toEqual({ recruiterUserId: null, recruiterName: null, jobs: 1, movedFromFirstStage: 0, interviewsScheduled: 0, offersCreated: 0, hires: 0 });
    // A partner administers the base company, so Team is theirs for it; never for the other company.
    expect((await recruitmentTeamReport(ctx.partner, base_(), P)).rows).toHaveLength(2);
    expect(await code(recruitmentTeamReport(ctx.partner, base_(), { ...P, companyId: otherCompanyId }))).toBe('forbidden');
    for (const c of [ctx.recruiter, ctx.recruiter2, ctx.manager, ctx.interviewer, ctx.bystander]) expect(await code(recruitmentTeamReport(c, base_(), P))).toBe('forbidden');
  });
});

describe('case 34 — periods, buckets, removed candidates and read-only snapshots', () => {
  it('refuses periods over 24 months or reversed; accepts exactly 24 months', async () => {
    expect(await code(recruitmentOverviewReport(admin, base_(), { from: '2024-01-01', to: '2026-01-01' }))).toBe('period_too_long');
    expect(await code(recruitmentOverviewReport(admin, base_(), { from: '2026-03-31', to: '2026-03-01' }))).toBe('period_invalid');
    expect(await code(recruitmentOverviewReport(admin, base_(), { from: '2026-02-30', to: '2026-03-01' }))).toBe('period_invalid');
    expect((await recruitmentOverviewReport(admin, base_(), { companyId: base.companyId, from: '2024-04-01', to: '2026-03-31' })).applications).toBe(9); // all but A6
  });

  it('buckets by Monday-start week up to 13 weeks and by calendar month beyond, across the Kuala Lumpur midnight edges', async () => {
    const weekly = await recruitmentOverviewReport(admin, base_(), { ...P, companyId: base.companyId });
    expect(weekly.scope.granularity).toBe('week');
    // 1 Mar 2026 is a Sunday: its week starts Mon 23 Feb and is clipped to 1 Mar. A3 (Sun 15 Mar) stays in the week of 9 Mar.
    expect(weekly.trend).toEqual([
      { key: '2026-02-23', from: '2026-03-01', to: '2026-03-01', count: 1 },
      { key: '2026-03-02', from: '2026-03-02', to: '2026-03-08', count: 1 },
      { key: '2026-03-09', from: '2026-03-09', to: '2026-03-15', count: 2 },
      { key: '2026-03-16', from: '2026-03-16', to: '2026-03-22', count: 2 },
      { key: '2026-03-23', from: '2026-03-23', to: '2026-03-29', count: 0 },
      { key: '2026-03-30', from: '2026-03-30', to: '2026-03-31', count: 1 },
    ]);
    const monthly = await recruitmentOverviewReport(admin, base_(), { companyId: base.companyId, from: '2026-01-15', to: '2026-06-14' });
    expect(monthly.scope.granularity).toBe('month');
    // A8 (10 Jan) is before the period; A5 (28 Feb 23:59:59) is February; A1 (1 Mar 00:00 KL, still 28 Feb in UTC) is March; A6 (1 Apr 00:00) April.
    expect(monthly.trend).toEqual([
      { key: '2026-01-01', from: '2026-01-15', to: '2026-01-31', count: 0 },
      { key: '2026-02-01', from: '2026-02-01', to: '2026-02-28', count: 1 },
      { key: '2026-03-01', from: '2026-03-01', to: '2026-03-31', count: 7 },
      { key: '2026-04-01', from: '2026-04-01', to: '2026-04-30', count: 1 },
      { key: '2026-05-01', from: '2026-05-01', to: '2026-05-31', count: 0 },
      { key: '2026-06-01', from: '2026-06-01', to: '2026-06-14', count: 0 },
    ]);
  });

  it('counts a removed candidate without any personal data', async () => {
    const [removed] = await owner.db.execute<{ destroyed: boolean; source: string | null }>(sql`
      select destroyed_at is not null as destroyed, source from recruitment_candidate where id = ${ids.a7cand}::uuid`);
    expect(removed).toEqual({ destroyed: true, source: null });
    const r = await recruitmentPositionsReport(admin, base_(), { ...P, companyId: base.companyId, jobId: ids.jobA });
    expect(r.jobs[0]).toMatchObject({ applications: 5, rejected: 3 }); // A7 still counts
    assertNoPersonalData(r);
  });

  it('runs every dashboard in one read-only repeatable-read snapshot with a local statement timeout', async () => {
    for (const run of [recruitmentOverviewReport, recruitmentPositionsReport, recruitmentInterviewsReport, recruitmentTeamReport]) {
      expect((await run(admin, base_(), P)).scope.snapshot).toMatchObject({ readOnly: true, isolation: 'repeatable read', statementTimeoutMs: 5_000 });
    }
    // A fixed handful of statements per dashboard (setup 3: settings, companies, job scope), whatever the data size.
    const counts = await Promise.all([recruitmentOverviewReport, recruitmentPositionsReport, recruitmentInterviewsReport, recruitmentTeamReport]
      .map(async (run) => (await run(admin, base_(), P)).scope.snapshot.statements));
    expect(counts).toEqual([7, 5, 4, 5]);
    // Overview without requisitions (a reviewer): one fewer.
    expect((await recruitmentOverviewReport(ctx.recruiter, base_(), P)).scope.snapshot.statements).toBe(6);
    expect((await recruitmentOverviewReport(ctx.recruiter, base_(), P)).scope.snapshot.readOnly).toBe(true);
  });
});

describe('review fixes — fallback, year bounds, pass-rate timing, mixed scope, time budget', () => {
  it('with fallback, a refused filter is dropped and named in one run instead of thrown', async () => {
    const period = await recruitmentOverviewReport(admin, base_(), { companyId: base.companyId, from: '2024-01-01', to: '2026-12-01' }, { fallback: true });
    expect(period.scope.refused).toBe('period_too_long');
    const today = todayInKualaLumpur();
    expect(period.scope.period).toEqual({ from: addDays(addCalendarMonths(today, -3), 1), to: today });
    expect(period.scope.snapshot.statements).toBe(7);
    const job = await recruitmentOverviewReport(ctx.recruiter, base_(), { ...P, jobId: ids.jobB }, { fallback: true });
    expect({ refused: job.scope.refused, jobId: job.scope.jobId, applications: job.applications }).toEqual({ refused: 'not_found', jobId: null, applications: 5 });
    const companyRefused = await recruitmentOverviewReport(ctx.partner, base_(), { ...P, companyId: otherCompanyId }, { fallback: true });
    expect({ refused: companyRefused.scope.refused, companyId: companyRefused.scope.companyId, applications: companyRefused.applications })
      .toEqual({ refused: 'forbidden', companyId: null, applications: 7 });
    // Without fallback the same filters are refusals, and a clean run has no refusal.
    expect(await code(recruitmentOverviewReport(ctx.recruiter, base_(), { ...P, jobId: ids.jobB }))).toBe('not_found');
    expect((await recruitmentOverviewReport(admin, base_(), P, { fallback: true })).scope.refused).toBeNull();
  });

  it('refuses years outside 2000–2100 and partial dates as period_invalid, never an error page', async () => {
    for (const p of [{ from: '0099-01-01', to: '0099-02-01' }, { from: '9999-01-01', to: '9999-12-31' }, { from: '9998-06', to: '9998-07' },
      { from: '2100-12-01', to: '2101-01-01' }, { from: '1999-12-31', to: '2000-01-31' }]) {
      expect(await code(recruitmentOverviewReport(admin, base_(), p)), JSON.stringify(p)).toBe('period_invalid');
    }
    expect((await recruitmentOverviewReport(admin, base_(), { from: '2000-01-01', to: '2001-12-31' })).applications).toBe(0);
  });

  it('counts a pass only for a later stage entered at or after the interview start', async () => {
    const r = await recruitmentInterviewsReport(admin, [thirdCompanyId], P);
    // E1 entered Offer on 5 Mar, then went back to Interview before its 10 Mar interview: not passed, no outcome.
    // E2 entered Offer on 12 Mar, after its 10 Mar interview: passed.
    expect({ interviewed: r.interviewedApplications, passed: r.passed, withOutcome: r.withOutcome, passRate: r.passRate })
      .toEqual({ interviewed: 2, passed: 1, withOutcome: 1, passRate: 1 });
  });

  it('hides requisition figures unless every covered company (or the filtered job\'s company) is administered', async () => {
    const both = [base.companyId, thirdCompanyId];
    const mixed = await recruitmentOverviewReport(ctx.partnerT, both, P);
    expect(mixed.applications).toBe(9); // base 7 + E1, E2
    expect({ visible: mixed.scope.requisitionsVisible, adminScope: mixed.scope.adminScope, requisitions: mixed.requisitions })
      .toEqual({ visible: false, adminScope: false, requisitions: null });
    // The administered company alone, or a job of it: shown.
    expect((await recruitmentOverviewReport(ctx.partnerT, both, { ...P, companyId: base.companyId })).requisitions)
      .toEqual({ count: 1, vacancies: 3, filled: 1, completionRate: 1 / 3 });
    expect((await recruitmentOverviewReport(ctx.partnerT, both, { ...P, jobId: ids.jobA })).requisitions)
      .toEqual({ count: 1, vacancies: 3, filled: 1, completionRate: 1 / 3 });
    // A job of the company they only review: hidden, not 0 or "—".
    const reviewed = await recruitmentOverviewReport(ctx.partnerT, both, { ...P, jobId: ids.jobE });
    expect({ requisitions: reviewed.requisitions, applications: reviewed.applications, vacancies: reviewed.jobs[0].vacancies })
      .toEqual({ requisitions: null, applications: 2, vacancies: null });
    assertNoPersonalData(mixed);
  });

  it('maps a budget overrun and a statement timeout (SQLSTATE 57014) to report_too_slow', async () => {
    const overrun = await recruitmentOverviewReport(admin, base_(), P, { budgetMs: -1 }).then(() => null, (e: unknown) => e);
    expect(overrun).toBeInstanceOf(ReportTooSlowError);
    expect((overrun as ReportTooSlowError).code).toBe('report_too_slow');
    for (const run of [recruitmentPositionsReport, recruitmentInterviewsReport, recruitmentTeamReport]) {
      expect(await code(run(admin, base_(), P, { budgetMs: -1 }))).toBe('report_too_slow');
    }
    // A real statement timeout, through the same driver and wrapper the reports use.
    const timedOut = await withTenant(admin, async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '50', true)`);
      await tx.execute(sql`select pg_sleep(1)`);
    }).then(() => null, (e: unknown) => e);
    expect(pgSqlState(timedOut)).toBe('57014');
    const mapped = toReportError(timedOut);
    expect(mapped).toBeInstanceOf(ReportTooSlowError);
    expect((mapped as RecruitmentError).code).toBe('report_too_slow');
    const other = new Error('unrelated');
    expect(toReportError(other)).toBe(other);
  });
});
