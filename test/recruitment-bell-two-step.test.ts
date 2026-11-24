/**
 * The bell's personal recruitment to-dos read in two statements (packs/recruitment/tasks.ts personalTodosTx): the viewer's
 * own rows first, then only the names those rows need. docs/SCALE-AND-RELEASE-RULES.md rule 3: the new reader answers
 * exactly what the earlier single statement answered (test/helpers/recruitment-personal-todos-original.ts, kept
 * verbatim) — the same items, fields and order — for every personal to-do kind and every role that can have one, under
 * "All companies", one company, another company, both and an empty selection, and again after the states that change a
 * name or drop an item (a removed candidate, names the viewer cannot read, a demoted HR contact). The 70-company shape is
 * test/recruitment-bell-scale.test.ts. Every person and value is fictional.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  PERSONAL_TODO_KINDS, addApplication, addBackgroundCheck, addDefaultBackgroundCheckTypes, addJobMember, assignAgencyContract, createJob, createRequisition,
  moveApplication, offerSettings, pendingRecruitmentTasks, recordAgencySubmission, recordBackgroundCheckAuthorisation, recruitmentTodos, saveAgency,
  saveAgencyConsultant, saveAgencyContract, saveApprovalFlow, saveOffer, scheduleInterview, sendForScreening, submitOffer, submitRequisition, submitScorecard,
  todoToPackTask, type RecruitmentTodo,
} from '../packs/recruitment/service';
import { closeCareersPool } from '../packs/recruitment/careers';
import { originalRecruitmentTodos } from './helpers/recruitment-personal-todos-original';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let otherCompanyId: string;
let gradeId: string;
let today: string;
let seq = 0;
type Login = SessionContext & { userId: string };

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const past = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
async function login(name: string, companyId = base.companyId): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
async function granted(name: string, role: 'hr_admin' | 'recruiting_partner', companyId: string | null): Promise<Login> {
  const who = await login(name);
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: who.userId, companyId, role });
  return { ...who, roles: [role], grants: [{ role, companyId }] };
}
async function team(companyId: string, title: string) {
  const n = ++seq;
  const [recruiter, assistant, hm, interviewer] = await Promise.all([
    login(`Fictional Recruiter ${n}`, companyId), login(`Fictional Assistant ${n}`, companyId), login(`Fictional Manager ${n}`, companyId), login(`Fictional Interviewer ${n}`, companyId),
  ]);
  const { id: jobId } = await createJob(admin, { companyId, title, jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted',
    employmentType: 'full_time', description: 'Fictional job description.', recruiterUserId: recruiter.userId });
  await addJobMember(admin, jobId, 'assistant', assistant.userId);
  await addJobMember(admin, jobId, 'hiring_manager', hm.userId);
  await addJobMember(admin, jobId, 'interviewer', interviewer.userId);
  return { companyId, jobId, recruiter, assistant, hm, interviewer };
}
type Team = Awaited<ReturnType<typeof team>>;
const apply = (t: Team, name: string, email = `c${++seq}@example.test`) => addApplication(t.recruiter, { jobId: t.jobId, fullName: name, email });
const stageOf = async (jobId: string, type: string) => (await owner.db.execute<{ id: string }>(sql`select ps.stage_id as id from recruitment_job_opening j
  join recruitment_process_stage ps on ps.process_id = j.process_id join recruitment_stage st on st.id = ps.stage_id
  where j.id = ${jobId}::uuid and st.stage_type = ${type} order by ps.position limit 1`))[0].id;
/** Fixture-only changes past the guards (the owner, triggers off): a removed candidate, an old start date. */
const asOwner = (query: ReturnType<typeof sql>) => owner.db.transaction(async (tx) => {
  await tx.execute(sql`set local session_replication_role = replica`);
  await tx.execute(query);
});
async function offerFor(t: Team, applicationId: string) {
  const fields = (await offerSettings(admin, t.companyId)).fields;
  const values = Object.fromEntries(fields.filter((f) => f.required).map((f) => [f.id, f.type === 'money' ? { amount: '1000', currency: 'MYR' } : f.type === 'date' ? { text: today } : { text: 'Fictional' }]));
  const { id } = await saveOffer(t.recruiter, applicationId, values);
  expect(await submitOffer(t.recruiter, id)).toBe('pending');
  return id;
}
async function agencyFor(companyId: string, hrContactUserId: string, endsOn: string) {
  const { id: agencyId } = await saveAgency(admin, { companyId, name: `Fictional Agency ${++seq}` });
  const { id: contractId } = await saveAgencyContract(admin, { agencyId, name: 'Fictional contract', contractType: 'headhunter', feeRate: '10',
    startsOn: addDays(today, -40), endsOn, hrContactUserId, access: 'public' });
  const { id: consultantId } = await saveAgencyConsultant(admin, { contractId, name: `Fictional Consultant ${seq}`, email: `consultant${seq}@agency.example.test` });
  return { agencyId, contractId, consultantId };
}

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  today = todayInKualaLumpur();
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd', parentCompanyId: base.companyId }).returning({ id: company.id });
  await addDefaultBackgroundCheckTypes(admin, base.companyId);
  await addDefaultBackgroundCheckTypes(admin, otherCompanyId);
});
afterAll(async () => { await closeCareersPool(); await closeAll(); });

describe('the two-step personal to-dos read answers exactly what the single statement answered', () => {
  it('for every personal to-do kind and role, every company selection, and after names change or items drop', async () => {
    const t1 = await team(base.companyId, 'Fictional data analyst');
    const t2 = await team(otherCompanyId, 'Fictional other-company role');
    const [q1, p1, bystander] = await Promise.all([login('Fictional Req Approver'), login('Fictional Offer Approver'), login('Fictional Bystander')]);
    const groupAdmin = await granted('Fictional Group Admin', 'hr_admin', null);
    const otherAdmin = await granted('Fictional Other Company Admin', 'hr_admin', otherCompanyId);
    const partner = await granted('Fictional Partner', 'recruiting_partner', base.companyId);
    const contact = await granted('Fictional HR Contact', 'hr_admin', null);

    // Requisition approval (no names joined).
    await saveApprovalFlow(admin, base.companyId, 'requisition', [q1.userId]);
    const { id: reqId } = await createRequisition(admin, { companyId: base.companyId, title: 'Fictional analysts', vacancies: '2', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted' });
    expect(await submitRequisition(admin, reqId)).toBe('pending');
    // Offer approvals: P1 is not on the team (names unreadable); the hiring manager is (names read); one candidate is removed later.
    const interview1 = await stageOf(t1.jobId, 'interview');
    const [c1, c2, c3] = [await apply(t1, 'Fictional Candidate One'), await apply(t1, 'Fictional Candidate Two'), await apply(t1, 'Fictional Candidate Three')];
    for (const c of [c1, c2, c3]) await moveApplication(t1.recruiter, c.applicationId, interview1);
    await saveApprovalFlow(admin, base.companyId, 'offer', [p1.userId]);
    const offerP1 = await offerFor(t1, c1.applicationId);
    await saveApprovalFlow(admin, base.companyId, 'offer', [t1.hm.userId]);
    const offerHm = await offerFor(t1, c2.applicationId);
    const offerRemoved = await offerFor(t1, c3.applicationId);
    // Feedback due (past interview), already given (none), and in another company.
    const { id: iv1 } = await scheduleInterview(t1.recruiter, { applicationId: c1.applicationId, type: 'video', startsAt: past(3), durationMinutes: 60, interviewerIds: [t1.interviewer.userId, t1.hm.userId] });
    await submitScorecard(t1.hm, iv1, { ratings: Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5'].map((k) => [k, { rating: '4', notes: 'Fictional' }])), result: 'recommended' });
    const o1 = await apply(t2, 'Fictional Other Candidate');
    await moveApplication(t2.recruiter, o1.applicationId, await stageOf(t2.jobId, 'interview'));
    const { id: ivOther } = await scheduleInterview(t2.recruiter, { applicationId: o1.applicationId, type: 'phone', startsAt: past(2), durationMinutes: 30, interviewerIds: [t2.interviewer.userId] });
    // Screening requests: the hiring manager of each job.
    const s1 = await apply(t1, 'Fictional Screened One');
    await sendForScreening(t1.recruiter, { applicationIds: [s1.applicationId, c2.applicationId], reviewerUserIds: [t1.hm.userId], note: 'Fictional note' });
    await sendForScreening(t2.recruiter, { applicationIds: [o1.applicationId], reviewerUserIds: [t2.hm.userId], note: 'Fictional note' });
    // Agency submissions waiting for review (a duplicate of an existing candidate waits), in both companies, and contracts expiring.
    const a1 = await agencyFor(base.companyId, contact.userId, addDays(today, 10));
    const a2 = await agencyFor(otherCompanyId, contact.userId, addDays(today, 3));
    await agencyFor(base.companyId, contact.userId, addDays(today, 90)); // not yet due
    await assignAgencyContract(admin, t1.jobId, a1.contractId);
    await assignAgencyContract(admin, t2.jobId, a2.contractId);
    // A person who applied from a job board to another job of the same company: the agency's submission of them waits.
    const boardApplicant = async (t: Team, fullName: string, email: string) => {
      const { id: jobId } = await createJob(admin, { companyId: t.companyId, title: 'Fictional board role', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
        recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', recruiterUserId: t.recruiter.userId });
      await addApplication(t.recruiter, { jobId, fullName, email, candidateSource: 'job_board' });
    };
    await boardApplicant(t1, 'Fictional Agency Person One', 'agency1@example.test');
    await boardApplicant(t2, 'Fictional Agency Person Two', 'agency2@example.test');
    const dup1 = await recordAgencySubmission(t1.recruiter, { jobId: t1.jobId, contractId: a1.contractId, consultantId: a1.consultantId, fullName: 'Fictional Agency Person One', email: 'agency1@example.test' });
    const dup2 = await recordAgencySubmission(t2.recruiter, { jobId: t2.jobId, contractId: a2.contractId, consultantId: a2.consultantId, fullName: 'Fictional Agency Person Two', email: 'agency2@example.test' });
    expect([dup1.outcome, dup2.outcome]).toEqual(['waiting', 'waiting']);
    // Background checks: the recorder's awaiting one, one in progress and overdue, one whose candidate is then removed.
    const offerStage = await stageOf(t1.jobId, 'offer');
    const [b1, b2, b3] = [await apply(t1, 'Fictional Checked One'), await apply(t1, 'Fictional Checked Two'), await apply(t1, 'Fictional Checked Three')];
    for (const b of [b1, b2, b3]) await moveApplication(t1.recruiter, b.applicationId, offerStage);
    const [type] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_background_check_type where company_id = ${base.companyId}::uuid order by name limit 1`);
    const { id: awaiting } = await addBackgroundCheck(t1.recruiter, { applicationId: b1.applicationId, typeIds: [type.id], provider: 'Fictional Screening' });
    const { id: overdue } = await addBackgroundCheck(t1.recruiter, { applicationId: b2.applicationId, typeIds: [type.id], provider: 'Fictional Screening' });
    await recordBackgroundCheckAuthorisation(t1.recruiter, overdue, { authorisedOn: today, method: 'email', start: 'on' });
    await asOwner(sql`update recruitment_background_check set started_at = ${new Date(`${addDays(today, -20)}T09:00:00+08:00`).toISOString()}::timestamptz where id = ${overdue}::uuid`);
    const { id: removedCheck } = await addBackgroundCheck(t1.recruiter, { applicationId: b3.applicationId, typeIds: [type.id], provider: 'Fictional Screening' });

    const viewers: Record<string, SessionContext> = {
      reqApprover: q1, offerApproverOffTeam: p1, recruiter: t1.recruiter, assistant: t1.assistant, hiringManager: t1.hm, interviewer: t1.interviewer,
      otherRecruiter: t2.recruiter, otherHiringManager: t2.hm, otherInterviewer: t2.interviewer, groupAdmin, otherAdmin, partner, contact, bystander, admin,
      demotedContact: { ...contact, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] },
    };
    const scopes: Record<string, string[] | undefined> = { all: undefined, base: [base.companyId], other: [otherCompanyId], both: [base.companyId, otherCompanyId], none: [] };
    const seen: RecruitmentTodo[] = [];
    async function compareAll(label: string) {
      for (const [who, ctx] of Object.entries(viewers)) for (const [scopeName, scope] of Object.entries(scopes)) {
        const now = new Date();
        const [current, earlier] = [await recruitmentTodos(ctx, scope, { now }), await originalRecruitmentTodos(ctx, scope, { now })];
        expect(current, `${label}: ${who} / ${scopeName}`).toEqual(earlier);
        seen.push(...current);
      }
      // The bell is the same list as bell tasks.
      for (const ctx of [t1.hm, groupAdmin, contact, t1.recruiter]) {
        expect(await pendingRecruitmentTasks(ctx, undefined)).toEqual((await originalRecruitmentTodos(ctx, undefined)).flatMap((x) => todoToPackTask(x) ?? []));
      }
    }

    await compareAll('initial');
    // Non-vacuous: every personal kind is there, with read names, unread names and dates.
    expect(new Set(seen.map((x) => x.kind))).toEqual(new Set(PERSONAL_TODO_KINDS));
    const byId = new Map(seen.map((x) => [`${x.kind}:${x.id}`, x]));
    expect(byId.get(`offerApproval:${offerP1}`)).toMatchObject({ title: null, candidateName: null, candidateRemoved: false });
    expect(byId.get(`offerApproval:${offerHm}`)).toMatchObject({ title: 'Fictional data analyst', candidateName: 'Fictional Candidate Two' });
    expect(byId.get(`feedback:${iv1}`)).toMatchObject({ candidateName: 'Fictional Candidate One', title: 'Fictional data analyst' });
    expect(byId.get(`feedback:${ivOther}`)).toMatchObject({ companyId: otherCompanyId, title: 'Fictional other-company role' });
    expect(byId.get(`agencyReview:${dup1.submissionId}`)).toMatchObject({ title: 'Fictional data analyst', candidateName: 'Fictional Agency Person One' });
    expect(byId.get(`contractExpiry:${a1.contractId}`)?.title).toMatch(/^Fictional Agency \d+ · Fictional contract$/);
    expect(byId.get(`backgroundCheckAuthorisation:${awaiting}`)).toMatchObject({ candidateName: 'Fictional Checked One', applicationId: b1.applicationId });
    expect(byId.has(`backgroundCheckAuthorisation:${removedCheck}`)).toBe(true);
    expect(byId.get(`backgroundCheckOverdue:${overdue}`)).toMatchObject({ candidateName: 'Fictional Checked Two' });
    expect(byId.get(`requisitionApproval:${reqId}`)).toMatchObject({ title: 'Fictional analysts', step: { position: 1, steps: 1 } });
    expect(seen.filter((x) => x.kind === 'screening').length).toBeGreaterThan(0);

    // A removed candidate: the offer keeps its item with the neutral label, the background check leaves the list.
    const [c3Candidate, b3Candidate] = await Promise.all([c3, b3].map(async (c) => (await owner.db.execute<{ id: string }>(sql`select candidate_id as id from recruitment_application where id = ${c.applicationId}::uuid`))[0].id));
    await asOwner(sql`update recruitment_candidate set destroyed_at = now(), destroyed_by_user_id = ${base.adminUserId}::uuid where id = any(${`{${c3Candidate},${b3Candidate}}`}::uuid[])`);
    seen.length = 0;
    await compareAll('after removal');
    const after = new Map(seen.map((x) => [`${x.kind}:${x.id}`, x]));
    expect(after.get(`offerApproval:${offerRemoved}`)).toMatchObject({ candidateName: null, candidateRemoved: true });
    expect(after.has(`backgroundCheckAuthorisation:${removedCheck}`)).toBe(false);
    expect(after.has(`backgroundCheckAuthorisation:${awaiting}`)).toBe(true);
  }, 120_000);
});
