/**
 * Recruitment slice 9 against Postgres: acceptance cases 59–64 (docs/recruitment-reconstruction/specification.md "Slice 9
 * acceptance cases") through the service, the approvals inbox (the bell) and directly as the app role. Case 65 is the
 * lead's rendered check. The pure rules are test/recruitment-tasks-rules.test.ts.
 *
 * Expected sets are computed independently of packs/recruitment/tasks.ts: from what each fixture step did (ids kept as the
 * fixture creates them) and, for the per-job counts, from a plain owner-connection count that ignores row security. Every
 * person and value is fictional; S9SENTINEL marks values that must never appear in a to-do or an update.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addCalendarMonths, timeInKualaLumpur, todayInKualaLumpur } from '../lib/hr-date';
import { readFileSync } from 'node:fs';
import { RECRUITMENT_TASK_KINDS } from '../lib/assigned-work';
import { isModuleEnabled } from '../core/entitlements';
import { listMyTasks, listPendingTasks, withoutRecruitmentTasks } from '../core/approvals-inbox';
import { createNotice, publishNotice } from '../core/notice';
import {
  addApplication, addJobMember, cancelInterview, candidateBoard, changeJobStatus, createJob, setCandidateResponse, UPDATES_PAGE_SIZE, createRequisition, decideOffer, decideRequisition, destroyCandidates,
  markOfferSent, markRecruitmentTasksRead, moveApplication, myApprovals, offerSettings, recordOfferDecision, recruitmentSettings, recruitmentTodos, recruitmentJobTodos,
  recruitmentUnreadCounts, recruitmentUpdates, rejectApplication, removeJobMember, saveApprovalFlow, saveOffer, scheduleInterview, scorecardForm,
  setCareersPublished, setJobCareersPage, setJobReferralPortal, submitCareersApplication, submitOffer, submitReferral, submitRequisition,
  submitScorecard, updateCareersSettings, RecruitmentError, TASK_CATEGORIES, type RecruitmentTodo, type RecruitmentUpdate, type TaskCategory,
} from '../packs/recruitment/service';
import { closeCareersPool } from '../packs/recruitment/careers';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SENTINEL = 'S9SENTINEL';
const SALARY_SENTINEL = '987654.32';
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
const rows = (ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute(query));
type Login = SessionContext & { userId: string };
/** A fictional employee of `companyId` with a login and an "employee" grant only. */
async function login(name: string, companyId = base.companyId, b: Base = base, entitled: SessionContext = admin): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: b.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...entitled, tenantId: b.tenantId, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional data analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', ...over,
});
const past = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
const future = (hoursAhead: number) => new Date(Date.now() + hoursAhead * 3_600_000);
const ratingsAll = (value: number) => Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5'].map((k) => [k, { rating: String(value), notes: `${SENTINEL} note ${k}` }]));
const stageId = async (name: string) => (await recruitmentSettings(admin, base.companyId)).stages.find((s) => s.name === name)!.id;
const memberId = async (jobId: string, userId: string, role: string) => (await owner.db.execute<{ id: string }>(sql`
  select id from recruitment_job_member where job_id = ${jobId}::uuid and app_user_id = ${userId}::uuid and member_role = ${role}`))[0].id;
/** The to-dos as comparable keys: kind, the item id and the count (per-job items). */
const todoKeys = (items: RecruitmentTodo[]) => items.map((i) => `${i.kind}:${i.id}${i.count != null ? `:${i.count}` : ''}`).sort();
const updateKeys = (items: RecruitmentUpdate[]) => items.map((i) => `${i.kind}:${i.id}`).sort();
async function allUpdates(ctx: SessionContext, companyIds = [base.companyId]): Promise<Record<TaskCategory, RecruitmentUpdate[]>> {
  const out = {} as Record<TaskCategory, RecruitmentUpdate[]>;
  for (const category of TASK_CATEGORIES) out[category] = (await recruitmentUpdates(ctx, { companyIds, category })).items;
  return out;
}
const flat = (u: Record<TaskCategory, RecruitmentUpdate[]>) => TASK_CATEGORIES.flatMap((c) => u[c]);
/** Fields of the seeded offer set by label; the salary carries the sentinel amount. */
async function offerValues() {
  const fields = (await offerSettings(admin, base.companyId)).fields;
  const f = (label: string) => fields.find((x) => x.label === label)!.id;
  return {
    [f('Job offered')]: { text: `${SENTINEL} job offered` }, [f('Department')]: { text: 'Finance' }, [f('Commencement date')]: { text: '2026-12-01' },
    [f('Basic salary')]: { amount: SALARY_SENTINEL, currency: 'MYR' },
  };
}
/** Independent count: active applications of the viewer's recruiter/assistant jobs in the first enabled stage, whose only
 *  history row is the arrival (owner connection: no row security, no shared code with the service). */
async function expectedToScreen(userId: string): Promise<Record<string, number>> {
  const out = await owner.db.execute<{ job_id: string; n: number }>(sql`
    select a.job_id, count(*)::int as n from recruitment_application a join recruitment_job_opening j on j.id = a.job_id
    where a.state = 'active'
      and a.current_stage_id = (select ps.stage_id from recruitment_process_stage ps join recruitment_stage st on st.id = ps.stage_id
        where ps.process_id = j.process_id and st.enabled order by ps.position limit 1)
      and (select count(*) from recruitment_application_event e where e.application_id = a.id) = 1
      and exists (select 1 from recruitment_job_member m where m.job_id = a.job_id and m.app_user_id = ${userId}::uuid and m.member_role in ('recruiter', 'assistant'))
    group by a.job_id`);
  return Object.fromEntries(out.map((r) => [r.job_id, r.n]));
}

/** A published notice each of `people` must acknowledge (a non-recruitment task in their bell). */
async function acknowledgementFor(people: Login[]) {
  const employmentIds = (await owner.db.execute<{ id: string }>(sql`select e.id from employment e
    where e.person_id = any(${`{${people.map((p) => p.personId).join(',')}}`}::uuid[]) and e.company_id = ${base.companyId}::uuid`)).map((r) => r.id);
  expect(employmentIds).toHaveLength(people.length);
  const today = todayInKualaLumpur();
  const notice = await createNotice(adminCtx(base), { title: 'Fictional notice to acknowledge', summary: 'Fictional summary.', body: 'Fictional body.', startOn: today,
    endOn: today, targetMode: 'individual', employmentIds, requiresAcknowledgement: true, notifyOnPublish: false });
  await publishNotice(adminCtx(base), notice.id);
}

/** Everything on the Overview's To do tab: the personal to-dos and the per-job counts (which must load here). */
async function allTodos(ctx: SessionContext, scope: readonly string[] | undefined, opts: { now?: Date } = {}): Promise<RecruitmentTodo[]> {
  const jobs = await recruitmentJobTodos(ctx, scope);
  if (jobs.status !== 'ok') throw new Error('job counts unavailable');
  return [...await recruitmentTodos(ctx, scope, opts), ...jobs.items];
}

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
});

/**
 * One job (J1) with a recruiter, an assistant, a hiring manager and an interviewer; applications in known places:
 *   c1 Interview stage, no interview (one cancelled)      → to schedule
 *   c2, c4 first stage, never moved                         → to screen
 *   c5 moved to Interview and back to the first stage       → neither (it moved)
 *   c3 Interview stage, interview 3 hours ago (I1, I2)      → feedback due for I1 until submitted; I2 submitted
 *   c6 Interview stage, interview tomorrow (I1)             → nothing yet
 * and a second company's job (J2) with its own recruiter and an application to screen.
 */
async function world() {
  const [recruiter, assistant, manager, i1, i2, bystander, otherRecruiter, otherInterviewer] = await Promise.all([
    login('Fictional Recruiter'), login('Fictional Assistant'), login('Fictional Hiring Manager'), login('Fictional Interviewer One'),
    login('Fictional Interviewer Two'), login('Fictional Bystander'), login('Fictional Other Recruiter', otherCompanyId), login('Fictional Other Interviewer', otherCompanyId),
  ]);
  const { id: j1 } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
  await addJobMember(admin, j1, 'assistant', assistant.userId);
  await addJobMember(admin, j1, 'hiring_manager', manager.userId);
  await addJobMember(admin, j1, 'interviewer', i1.userId);
  const interview = await stageId('Interview');
  const first = await stageId('Application Review');
  const add = async (n: number) => (await addApplication(recruiter, { jobId: j1, fullName: `Fictional Candidate ${n}`, email: `c${n}@example.test` }));
  const [c1, c2, c3, c4, c5, c6] = [await add(1), await add(2), await add(3), await add(4), await add(5), await add(6)];
  for (const c of [c1, c3, c5, c6]) await moveApplication(recruiter, c.applicationId, interview);
  await moveApplication(recruiter, c5.applicationId, first);
  const { id: cancelled } = await scheduleInterview(recruiter, { applicationId: c1.applicationId, type: 'video', startsAt: past(5), durationMinutes: 30, interviewerIds: [i1.userId] });
  await cancelInterview(recruiter, cancelled);
  const { id: iv3 } = await scheduleInterview(recruiter, { applicationId: c3.applicationId, type: 'video', startsAt: past(3), durationMinutes: 60, interviewerIds: [i1.userId, i2.userId] });
  const { id: iv6 } = await scheduleInterview(recruiter, { applicationId: c6.applicationId, type: 'onsite', startsAt: future(24), durationMinutes: 60, interviewerIds: [i1.userId] });
  await submitScorecard(i2, iv3, { ratings: ratingsAll(4), result: 'recommended', overview: `${SENTINEL} overview` });

  const { id: j2 } = await createJob(admin, job({ companyId: otherCompanyId, title: 'Fictional other-company role', recruiterUserId: otherRecruiter.userId }));
  const { applicationId: o1 } = await addApplication(otherRecruiter, { jobId: j2, fullName: 'Fictional Other Candidate', email: 'other@example.test' });
  await moveApplication(otherRecruiter, o1, (await recruitmentSettings(admin, otherCompanyId)).stages.find((s) => s.name === 'Interview')!.id);
  const { id: ivOther } = await scheduleInterview(otherRecruiter, { applicationId: o1, type: 'phone', startsAt: past(2), durationMinutes: 30, interviewerIds: [otherInterviewer.userId] });
  const { applicationId: o2 } = await addApplication(otherRecruiter, { jobId: j2, fullName: 'Fictional Other Candidate Two', email: 'other2@example.test' });
  return {
    recruiter, assistant, manager, i1, i2, bystander, otherRecruiter, otherInterviewer, j1, j2, c1, c2, c3, c4, c5, c6, iv3, iv6, cancelled, ivOther, o2,
    interview, first,
  };
}

describe('case 59 — the to-do list is exactly the viewer\'s pending work, and follows the action and access', () => {
  it('lists approval steps, due feedback and per-job counts against independent sets; items leave after the action and with the job', async () => {
    const w = await world();
    // Approval flows: offers P1 → P2, requisitions Q1 → Q2.
    const [p1, p2, q1, q2] = await Promise.all([login('Fictional Offer Approver One'), login('Fictional Offer Approver Two'), login('Fictional Req Approver One'), login('Fictional Req Approver Two')]);
    await saveApprovalFlow(admin, base.companyId, 'offer', [p1.userId, p2.userId]);
    await saveApprovalFlow(admin, base.companyId, 'requisition', [q1.userId, q2.userId]);
    const { id: offerId } = await saveOffer(w.recruiter, w.c3.applicationId, await offerValues());
    expect(await submitOffer(w.recruiter, offerId)).toBe('pending');
    const { id: reqId, reqNumber } = await createRequisition(admin, { companyId: base.companyId, title: 'Fictional analysts', vacancies: '2', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted' });
    expect(await submitRequisition(admin, reqId)).toBe('pending');

    // Recruiter and assistant: one schedule item (c1 only) and one screen item (c2, c4) for J1 — nothing else.
    const screen = await expectedToScreen(w.recruiter.userId);
    expect(screen).toEqual({ [w.j1]: 2 });
    for (const who of [w.recruiter, w.assistant]) {
      const todos = await allTodos(who, undefined);
      expect(todos.length).toBeGreaterThan(0);
      expect(todoKeys(todos)).toEqual([`toSchedule:${w.j1}:1`, `toScreen:${w.j1}:${screen[w.j1]}`].sort());
    }
    const recruiterTodos = await allTodos(w.recruiter, [base.companyId]);
    const scheduleItem = recruiterTodos.find((i) => i.kind === 'toSchedule')!;
    expect(scheduleItem).toMatchObject({ title: 'Fictional data analyst', count: 1, href: `/recruitment/candidates?job=${w.j1}&tab=${w.interview}` });
    expect(recruiterTodos.find((i) => i.kind === 'toScreen')!.href).toBe(`/recruitment/candidates?job=${w.j1}&tab=${w.first}`);
    // The link opens exactly the counted applications on the Candidates board.
    const board = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j1, tab: w.first });
    expect(board.cards.map((c) => c.id).sort()).toEqual([w.c2.applicationId, w.c4.applicationId, w.c5.applicationId].sort()); // c5 is there but moved
    // Interviewer One: feedback due on c3 only (the cancelled interview and the future one give nothing); Two submitted.
    expect(todoKeys(await allTodos(w.i1, undefined))).toEqual([`feedback:${w.iv3}`]);
    const due = (await allTodos(w.i1, undefined))[0];
    expect(due).toMatchObject({ candidateName: 'Fictional Candidate 3', title: 'Fictional data analyst', href: `/recruitment/interviews/${w.iv3}/feedback` });
    expect((await scorecardForm(w.i1, w.iv3)).interviewId).toBe(w.iv3);
    expect(await allTodos(w.i2, undefined)).toEqual([]);
    // Approvers: the pending step only. P1 is not on the job team, so the names stay unread (as on the Approvals page).
    expect(todoKeys(await allTodos(p1, undefined))).toEqual([`offerApproval:${offerId}`]);
    expect((await allTodos(p1, undefined))[0]).toMatchObject({ candidateName: null, title: null, step: { position: 1, steps: 2 }, href: '/recruitment/approvals' });
    expect((await myApprovals(p1)).offers.map((o) => o.offerId)).toEqual([offerId]);
    expect(await allTodos(p2, undefined)).toEqual([]);
    expect(todoKeys(await allTodos(q1, undefined))).toEqual([`requisitionApproval:${reqId}`]);
    expect((await allTodos(q1, undefined))[0]).toMatchObject({ title: 'Fictional analysts', number: reqNumber, step: { position: 1, steps: 2 } });
    // No sentinel (offer values, scorecard notes) and no salary in any to-do.
    for (const who of [w.recruiter, w.i1, p1, q1]) {
      const text = JSON.stringify(await allTodos(who, undefined));
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(SALARY_SENTINEL);
    }

    // After the action, the item leaves (and moves to the next step's approver).
    await decideOffer(p1, offerId, 'approve');
    expect(await allTodos(p1, undefined)).toEqual([]);
    expect(todoKeys(await allTodos(p2, undefined))).toEqual([`offerApproval:${offerId}`]);
    await decideRequisition(q1, reqId, 'reject', 'Fictional: not this quarter');
    expect(await allTodos(q1, undefined)).toEqual([]);
    expect(await allTodos(q2, undefined)).toEqual([]);
    await submitScorecard(w.i1, w.iv3, { ratings: ratingsAll(3), result: 'keep_in_view' });
    expect(await allTodos(w.i1, undefined)).toEqual([]);
    await scheduleInterview(w.recruiter, { applicationId: w.c1.applicationId, type: 'phone', startsAt: future(48), durationMinutes: 30, interviewerIds: [w.i1.userId] });
    await moveApplication(w.recruiter, w.c2.applicationId, w.interview);
    expect(await expectedToScreen(w.recruiter.userId)).toEqual({ [w.j1]: 1 });
    expect(todoKeys(await allTodos(w.recruiter, undefined))).toEqual([`toSchedule:${w.j1}:1`, `toScreen:${w.j1}:1`]); // c2 now to schedule, c4 to screen

    // Losing access to the job removes the job's items at once.
    await removeJobMember(admin, w.j1, await memberId(w.j1, w.assistant.userId, 'assistant'));
    expect(await allTodos(w.assistant, undefined)).toEqual([]);

    // Approval steps are tenant-wide (like the Approvals page): another company in the selection still lists them, while
    // the job's counts follow the selection.
    expect(todoKeys(await allTodos(p2, [otherCompanyId]))).toEqual([`offerApproval:${offerId}`]);
    expect(await allTodos(w.recruiter, [otherCompanyId])).toEqual([]);
    // On hold keeps the job's counts; Closed removes them (and nothing else).
    await changeJobStatus(admin, w.j1, 'on_hold');
    expect(todoKeys(await allTodos(w.recruiter, undefined))).toEqual([`toSchedule:${w.j1}:1`, `toScreen:${w.j1}:1`]);
    await changeJobStatus(admin, w.j1, 'closed');
    expect(await allTodos(w.recruiter, undefined)).toEqual([]);
    expect(todoKeys(await allTodos(p2, undefined))).toEqual([`offerApproval:${offerId}`]);
  });
});

describe('case 60 — nothing for a job, requisition, offer or company the viewer cannot read', () => {
  it('a bystander, an interviewer of another job, another company\'s recruiter and another tenant see none of it', async () => {
    const w = await world();
    const p1 = await login('Fictional Offer Approver');
    await saveApprovalFlow(admin, base.companyId, 'offer', [p1.userId]);
    const { id: offerId } = await saveOffer(w.recruiter, w.c3.applicationId, await offerValues());
    await submitOffer(w.recruiter, offerId);
    const worker = await login('Fictional Referrer');
    await setJobReferralPortal(admin, w.j1, true);
    await submitReferral(worker, { jobId: w.j1, fullName: 'Fictional Referred Person', email: 'referred@example.test', mobile: '', reason: `${SENTINEL} reason`, confirmed: true });

    // Another tenant with its own recruiter and job.
    const other = await seedBase();
    await setModule(other.tenantId, 'recruitment', 'active');
    const otherAdmin = { ...(await entitledCtx(other)), grants: [{ role: 'hr_admin', companyId: null }] };
    const [{ id: otherGrade }] = await owner.db.insert(jobGrade).values({ tenantId: other.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
    const tenantRecruiter = await login('Fictional Tenant Recruiter', other.companyId, other, otherAdmin);
    const { id: tenantJob } = await createJob(otherAdmin, job({ companyId: other.companyId, jobGradeIds: [otherGrade], recruiterUserId: tenantRecruiter.userId }));
    await addApplication(tenantRecruiter, { jobId: tenantJob, fullName: 'Fictional Tenant Candidate', email: 'tenant@example.test' });

    // Another job in the SAME company, with its own recruiter and interviewer.
    const [secondRecruiter, secondInterviewer] = [await login('Fictional Second Recruiter'), await login('Fictional Second Interviewer')];
    const { id: j3 } = await createJob(admin, job({ title: 'Fictional second role', recruiterUserId: secondRecruiter.userId }));
    const { applicationId: s1 } = await addApplication(secondRecruiter, { jobId: j3, fullName: 'Fictional Second Candidate', email: 'second@example.test' });
    await moveApplication(secondRecruiter, s1, w.interview);
    const { id: ivJ3 } = await scheduleInterview(secondRecruiter, { applicationId: s1, type: 'phone', startsAt: past(1), durationMinutes: 30, interviewerIds: [secondInterviewer.userId] });

    const j1Items = (items: { id: string; jobId?: string | null }[]) => items.filter((i) => i.jobId === w.j1 || i.id === w.j1 || i.id === offerId || i.id === w.iv3);
    expect(todoKeys(await allTodos(secondInterviewer, undefined))).toEqual([`feedback:${ivJ3}`]);
    expect(flat(await allUpdates(secondInterviewer))).toEqual([]);
    expect(todoKeys(await allTodos(secondRecruiter, undefined))).toEqual([]); // s1 has its interview
    expect(flat(await allUpdates(secondRecruiter)).some((u) => u.jobId === w.j1)).toBe(false);
    for (const who of [w.recruiter, w.assistant, w.i1]) {
      expect((await allTodos(who, undefined)).some((i) => i.id === j3 || i.jobId === j3 || i.id === ivJ3)).toBe(false);
      expect(flat(await allUpdates(who)).some((u) => u.jobId === j3)).toBe(false);
    }
    // Each viewer's own list is non-empty where they have work, and never includes J1's.
    expect(await allTodos(w.bystander, undefined)).toEqual([]);
    expect(flat(await allUpdates(w.bystander))).toEqual([]);
    expect(todoKeys(await allTodos(w.otherInterviewer, undefined))).toEqual([`feedback:${w.ivOther}`]);
    expect(j1Items(await allTodos(w.otherInterviewer, undefined))).toEqual([]);
    expect(flat(await allUpdates(w.otherInterviewer, [otherCompanyId]))).toEqual([]);
    const otherTodos = await allTodos(w.otherRecruiter, undefined);
    expect(todoKeys(otherTodos)).toEqual([`toScreen:${w.j2}:1`]); // o1 has its interview; o2 waits to be screened
    expect(j1Items(otherTodos)).toEqual([]);
    expect(flat(await allUpdates(w.otherRecruiter, [otherCompanyId, base.companyId]))).toEqual([]);
    expect(await code(markRecruitmentTasksRead(w.otherRecruiter, [base.companyId], 'all'))).toBe('forbidden');
    const tenantTodos = await allTodos(tenantRecruiter, undefined);
    expect(todoKeys(tenantTodos)).toEqual([`toScreen:${tenantJob}:1`]);
    // …and the base tenant's people never see the other tenant's job, even when they name its company.
    for (const who of [w.recruiter, w.assistant, admin]) {
      expect((await allTodos(who, undefined)).some((i) => i.id === tenantJob || i.companyId === other.companyId)).toBe(false);
      expect(await allTodos(who, [other.companyId])).toEqual([]);
      expect(flat(await allUpdates(who, [other.companyId]))).toEqual([]);
    }
    // The hiring manager reviews J1 but is neither its recruiter nor an assistant: no counts and no application updates.
    expect(await allTodos(w.manager, undefined)).toEqual([]);
    expect(flat(await allUpdates(w.manager))).toEqual([]);
    // Company selection: the recruiter's J1 items leave when the selection is another company.
    expect(await allTodos(w.recruiter, [otherCompanyId])).toEqual([]);
    expect((await allUpdates(w.recruiter)).applications.map((u) => u.kind)).toEqual(['referral']);
    expect(flat(await allUpdates(w.recruiter, [otherCompanyId]))).toEqual([]);
  });
});

describe('case 61 — feedback is due from the interview\'s start in Kuala Lumpur time', () => {
  it('appears at the start minute and not before; cancelled interviews and submitted feedback give nothing', async () => {
    const w = await world();
    const day = addCalendarMonths(todayInKualaLumpur(), 1);
    const start = new Date(`${day}T09:00:00+08:00`);
    expect(timeInKualaLumpur(start)).toBe('09:00');
    expect(todayInKualaLumpur(start)).toBe(day);
    const { id: iv } = await scheduleInterview(w.recruiter, { applicationId: w.c6.applicationId, type: 'video', startsAt: start, durationMinutes: 45, interviewerIds: [w.i2.userId] });
    const before = new Date(start.getTime() - 1);
    expect(timeInKualaLumpur(before)).toBe('08:59');
    expect(await allTodos(w.i2, undefined, { now: before })).toEqual([]);
    expect(todoKeys(await allTodos(w.i2, undefined, { now: start }))).toEqual([`feedback:${iv}`]);
    expect((await allTodos(w.i2, undefined, { now: start }))[0].at).toBe(start.toISOString());
    // A submitted scorecard and a cancelled interview: nothing, at any time after.
    const later = new Date(start.getTime() + 86_400_000);
    await cancelInterview(w.recruiter, iv);
    expect(await allTodos(w.i2, undefined, { now: later })).toEqual([]);
    expect(todoKeys(await allTodos(w.i1, undefined, { now: later }))).toEqual([`feedback:${w.iv3}`, `feedback:${w.iv6}`].sort());
    await submitScorecard(w.i1, w.iv3, { ratings: ratingsAll(5), result: 'recommended' });
    expect(todoKeys(await allTodos(w.i1, undefined, { now: later }))).toEqual([`feedback:${w.iv6}`]);
    // An interview the candidate declined asks for no feedback; accepted again, it does.
    await setCandidateResponse(w.recruiter, w.iv6, 'declined');
    expect(await allTodos(w.i1, undefined, { now: later })).toEqual([]);
    await setCandidateResponse(w.recruiter, w.iv6, 'accepted');
    expect(todoKeys(await allTodos(w.i1, undefined, { now: later }))).toEqual([`feedback:${w.iv6}`]);
    // The cancelled c1 interview never produced an item for Interviewer One.
    expect((await allTodos(w.i1, undefined, { now: later })).some((i) => i.id === w.cancelled)).toBe(false);
  });
});

describe('case 62 — updates: the specified events to the specified people, nobody\'s own, no private values', () => {
  it('shows requisition, offer, feedback and application events to their audiences, and the neutral label after removal', async () => {
    const w = await world();
    const [p1, p2, q1, q2] = await Promise.all([login('Fictional Offer Approver One'), login('Fictional Offer Approver Two'), login('Fictional Req Approver One'), login('Fictional Req Approver Two')]);
    await saveApprovalFlow(admin, base.companyId, 'offer', [p1.userId, p2.userId]);
    await saveApprovalFlow(admin, base.companyId, 'requisition', [q1.userId, q2.userId]);
    // Requisitions by the administrator: one approved through both steps, one denied at step 1.
    const req = { companyId: base.companyId, title: 'Fictional analysts', vacancies: '2', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted' };
    const { id: reqOk } = await createRequisition(admin, req);
    const { id: reqNo } = await createRequisition(admin, { ...req, title: 'Fictional planners' });
    await submitRequisition(admin, reqOk); await submitRequisition(admin, reqNo);
    await decideRequisition(q1, reqOk, 'approve'); await decideRequisition(q2, reqOk, 'approve');
    await decideRequisition(q1, reqNo, 'reject', `${SENTINEL} comment`);
    // Offers: the recruiter's on c3 approved by both steps then accepted (recorded by the assistant); the assistant's on c6
    // denied at step 1 (with a sentinel comment).
    const { id: offer3 } = await saveOffer(w.recruiter, w.c3.applicationId, await offerValues());
    await submitOffer(w.recruiter, offer3); await decideOffer(p1, offer3, 'approve'); await decideOffer(p2, offer3, 'approve');
    await markOfferSent(w.recruiter, offer3, 'email');
    await recordOfferDecision(w.assistant, offer3, 'accepted');
    const { id: offer6 } = await saveOffer(w.assistant, w.c6.applicationId, await offerValues());
    await submitOffer(w.assistant, offer6); await decideOffer(p1, offer6, 'reject', `${SENTINEL} comment`);
    // Feedback: Interviewer Two already submitted on c3 (world). The recruiter interviews c6 and submits their own.
    const { id: ivR } = await scheduleInterview(w.recruiter, { applicationId: w.c6.applicationId, type: 'phone', startsAt: past(1), durationMinutes: 30, interviewerIds: [w.recruiter.userId] });
    await submitScorecard(w.recruiter, ivR, { ratings: ratingsAll(2), result: 'not_suitable', overview: `${SENTINEL} own overview` });
    // Applications: an employee referral and a careers-page application to J1, both with sentinel text.
    const worker = await login('Fictional Referrer');
    await setJobReferralPortal(admin, w.j1, true);
    const { referralId } = await submitReferral(worker, { jobId: w.j1, fullName: 'Fictional Referred Person', email: 'referred@example.test', mobile: '', reason: `${SENTINEL} reason`, confirmed: true });
    await updateCareersSettings(admin, base.companyId, { address: 'fictional-tasks', displayName: 'Fictional Careers', headline: 'Fictional headline', introduction: 'Fictional introduction.', notice: 'Fictional privacy notice.' });
    await setCareersPublished(admin, base.companyId, true);
    await setJobCareersPage(admin, w.j1, true);
    const careers = await submitCareersApplication({
      address: 'fictional-tasks', jobId: w.j1, fullName: 'Fictional Applicant', email: 'applicant@example.test', mobile: '', message: `${SENTINEL} message`,
      consent: 'on', noticeVersion: '1', website: '', resume: null, clientHash: () => 'f'.repeat(64), currentNoticeVersion: 1,
    });
    expect(careers).toEqual({ ok: true, outcome: 'received' });
    const [{ application_id: careersApp }] = await owner.db.execute<{ application_id: string }>(sql`select application_id from recruitment_careers_application where job_id = ${w.j1}::uuid`);
    const [scR] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_scorecard where interview_id = ${ivR}::uuid`);
    const [scI2] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_scorecard where interview_id = ${w.iv3}::uuid and interviewer_user_id = ${w.i2.userId}::uuid`);
    const decisions = await owner.db.execute<{ id: string; offer_id: string; decision: string; position: number }>(sql`
      select id, offer_id, decision, position from recruitment_offer_approval where offer_id in (${offer3}::uuid, ${offer6}::uuid)`);
    const finalApproval = decisions.find((d) => d.offer_id === offer3 && d.position === 2)!.id;
    const denial = decisions.find((d) => d.offer_id === offer6)!.id;
    const reqDecisions = await owner.db.execute<{ id: string; requisition_id: string; position: number }>(sql`
      select id, requisition_id, position from recruitment_requisition_approval where requisition_id in (${reqOk}::uuid, ${reqNo}::uuid)`);

    // Requester (the administrator): the final approval and the denial; nobody else gets requisition updates.
    const adminUpdates = await allUpdates(admin);
    expect(updateKeys(adminUpdates.requisitions)).toEqual([
      `requisitionApproved:${reqDecisions.find((d) => d.requisition_id === reqOk && d.position === 2)!.id}`,
      `requisitionDenied:${reqDecisions.find((d) => d.requisition_id === reqNo)!.id}`,
    ].sort());
    expect(adminUpdates.requisitions.find((u) => u.kind === 'requisitionDenied')).toMatchObject({ title: 'Fictional planners', href: `/recruitment/requisitions/${reqNo}` });
    for (const who of [w.recruiter, q1, q2]) expect((await allUpdates(who)).requisitions).toEqual([]);
    // Offers: the recruiter (creator of offer3 and the job's recruiter) sees offer3 approved and accepted (the assistant
    // recorded it) and offer6 denied; the assistant (creator of offer6) sees the denial only — the acceptance was their
    // own action and offer3 is not theirs. The hiring manager and the approvers see none.
    const recruiterUpdates = await allUpdates(w.recruiter);
    expect(updateKeys(recruiterUpdates.offers)).toEqual([`offerApproved:${finalApproval}`, `offerAccepted:${offer3}:decision`, `offerDenied:${denial}`].sort());
    expect(recruiterUpdates.offers.find((u) => u.kind === 'offerAccepted')).toMatchObject({ candidateName: 'Fictional Candidate 3', title: 'Fictional data analyst', href: `/recruitment/applications/${w.c3.applicationId}` });
    expect(updateKeys((await allUpdates(w.assistant)).offers)).toEqual([`offerDenied:${denial}`]);
    for (const who of [w.manager, p1, p2]) expect((await allUpdates(who)).offers).toEqual([]);
    // Interviews: the recruiter sees Interviewer Two's feedback, not their own; the assistant sees both; not the manager.
    expect(updateKeys(recruiterUpdates.interviews)).toEqual([`feedbackSubmitted:${scI2.id}`]);
    expect(updateKeys((await allUpdates(w.assistant)).interviews)).toEqual([`feedbackSubmitted:${scI2.id}`, `feedbackSubmitted:${scR.id}`].sort());
    expect((await allUpdates(w.i1)).interviews).toEqual([]);
    // Applications: the referral and the careers application, for the recruiter and the assistant.
    expect(updateKeys(recruiterUpdates.applications)).toEqual([`careersApplication:${careersApp}:careers`, `referral:${referralId}`].sort());
    expect(updateKeys((await allUpdates(w.assistant)).applications)).toEqual(updateKeys(recruiterUpdates.applications));
    // Newest first, and nothing private anywhere in the data.
    const everything = [...flat(recruiterUpdates), ...flat(await allUpdates(w.assistant)), ...flat(adminUpdates)];
    expect(everything.length).toBeGreaterThan(8);
    const text = JSON.stringify(everything);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(SALARY_SENTINEL);
    for (const category of TASK_CATEGORIES) {
      const ats = recruiterUpdates[category].map((u) => u.at);
      expect(ats).toEqual([...ats].sort().reverse());
    }

    // Removal: the referred candidate is removed under slice 5; the update stays with the neutral label and no name.
    const [{ candidate_id: referred, application_id: referredApp }] = await owner.db.execute<{ candidate_id: string; application_id: string }>(sql`
      select candidate_id, application_id from recruitment_referral where id = ${referralId}::uuid`);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, referredApp, reason.id);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${`${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`}::timestamptz where id = ${referredApp}::uuid`;
    });
    expect(await destroyCandidates(admin, base.companyId, [referred], 'on')).toEqual({ removed: 1 });
    const removed = (await allUpdates(w.recruiter)).applications.find((u) => u.kind === 'referral')!;
    expect(removed).toMatchObject({ candidateRemoved: true, candidateName: null, title: 'Fictional data analyst' });
    expect(JSON.stringify(removed)).not.toContain('Fictional Referred Person');
  });
});

describe('case 63 — unread counts follow each category\'s own read-up-to time, and only the viewer moves theirs', () => {
  it('starts at zero, counts new events, marks one category or all, and refuses other users\' markers in the service and the database', async () => {
    const w = await world();
    // First open: markers at now(), so the existing feedback is listed but not unread.
    expect(await recruitmentUnreadCounts(w.recruiter, [base.companyId])).toEqual({ requisitions: 0, offers: 0, interviews: 0, applications: 0 });
    const existing = (await recruitmentUpdates(w.recruiter, { companyIds: [base.companyId], category: 'interviews' })).items;
    expect(existing.map((u) => [u.kind, u.unread])).toEqual([['feedbackSubmitted', false]]);
    const markers = await rows(w.recruiter, sql`select company_id, category from recruitment_task_read_marker order by category`);
    expect(markers.map((m) => m.category)).toEqual(['applications', 'interviews', 'offers', 'requisitions']);

    // New events after the first open.
    await submitScorecard(w.i1, w.iv3, { ratings: ratingsAll(3), result: 'keep_in_view' });
    const worker = await login('Fictional Referrer');
    await setJobReferralPortal(admin, w.j1, true);
    await submitReferral(worker, { jobId: w.j1, fullName: 'Fictional Referred Person', email: 'referred@example.test', mobile: '', reason: 'Fictional reason', confirmed: true });
    await saveApprovalFlow(admin, base.companyId, 'offer', []);
    const { id: offer3 } = await saveOffer(w.assistant, w.c3.applicationId, await offerValues());
    await submitOffer(w.assistant, offer3);
    await markOfferSent(w.assistant, offer3, 'email');
    await recordOfferDecision(w.assistant, offer3, 'declined');
    expect(await recruitmentUnreadCounts(w.recruiter, [base.companyId])).toEqual({ requisitions: 0, offers: 1, interviews: 1, applications: 1 });
    expect((await recruitmentUpdates(w.recruiter, { companyIds: [base.companyId], category: 'interviews' })).items.map((u) => u.unread)).toEqual([true, false]);

    // One category leaves the others; opening an item changes nothing; "all" clears the rest.
    await markRecruitmentTasksRead(w.recruiter, [base.companyId], 'offers');
    expect(await recruitmentUnreadCounts(w.recruiter, [base.companyId])).toEqual({ requisitions: 0, offers: 0, interviews: 1, applications: 1 });
    await recruitmentUpdates(w.recruiter, { companyIds: [base.companyId], category: 'applications' });
    expect((await recruitmentUnreadCounts(w.recruiter, [base.companyId])).applications).toBe(1);
    // The assistant's counts are their own (their first open is now: nothing unread).
    expect(await recruitmentUnreadCounts(w.assistant, [base.companyId])).toEqual({ requisitions: 0, offers: 0, interviews: 0, applications: 0 });
    await markRecruitmentTasksRead(w.recruiter, [base.companyId], 'all');
    expect(await recruitmentUnreadCounts(w.recruiter, [base.companyId])).toEqual({ requisitions: 0, offers: 0, interviews: 0, applications: 0 });
    expect(await code(markRecruitmentTasksRead(w.recruiter, [base.companyId], 'everything'))).toBe('invalid_input');

    // Service: a user can only ever move their own markers, and only for a company they may see.
    expect(await code(markRecruitmentTasksRead(w.bystander, [base.companyId], 'all'))).toBe('forbidden');
    expect(await code(markRecruitmentTasksRead(w.recruiter, [base.companyId, otherCompanyId], 'all'))).toBe('forbidden');
    // Database: another user (and even the administrator) neither reads nor changes the recruiter's markers.
    const before = await owner.db.execute<{ category: string; read_up_to: string }>(sql`
      select category, read_up_to::text from recruitment_task_read_marker where app_user_id = ${w.recruiter.userId}::uuid order by category`);
    expect(before).toHaveLength(4);
    for (const other of [w.assistant, w.bystander, admin]) {
      expect(await rows(other, sql`select 1 from recruitment_task_read_marker where app_user_id = ${w.recruiter.userId}::uuid`)).toHaveLength(0);
      const updated = await rows(other, sql`update recruitment_task_read_marker set read_up_to = now() - interval '200 days'
        where app_user_id = ${w.recruiter.userId}::uuid returning 1`);
      expect(updated).toHaveLength(0);
      expect(await code(rows(other, sql`insert into recruitment_task_read_marker (tenant_id, company_id, app_user_id, category, read_up_to)
        values (${base.tenantId}::uuid, ${otherCompanyId}::uuid, ${w.recruiter.userId}::uuid, 'offers', now())`))).toBe('42501');
      expect(await code(rows(other, sql`delete from recruitment_task_read_marker where app_user_id = ${w.recruiter.userId}::uuid`))).toBe('42501');
    }
    // The bystander cannot even give themselves a marker for a company they cannot see.
    expect(await code(rows(w.bystander, sql`insert into recruitment_task_read_marker (tenant_id, company_id, app_user_id, category, read_up_to)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${w.bystander.userId}::uuid, 'offers', now())`))).toBe('42501');
    // Own rows: never moved back, never past now().
    await rows(w.recruiter, sql`update recruitment_task_read_marker set read_up_to = now() - interval '200 days' where category = 'offers'`);
    await rows(w.recruiter, sql`update recruitment_task_read_marker set read_up_to = now() + interval '30 days' where category = 'interviews'`);
    const [after] = await owner.db.execute<{ offers_kept: boolean; interviews_now: boolean }>(sql`select
      (select read_up_to::text from recruitment_task_read_marker where app_user_id = ${w.recruiter.userId}::uuid and category = 'offers')
        = ${before.find((m) => m.category === 'offers')!.read_up_to} as offers_kept,
      (select read_up_to <= now() from recruitment_task_read_marker where app_user_id = ${w.recruiter.userId}::uuid and category = 'interviews') as interviews_now`);
    expect(after).toEqual({ offers_kept: true, interviews_now: true });
    // Grants: no DELETE for the app role and nothing for PUBLIC; row security forced.
    const [grants] = await owner.db.execute<{ forced: boolean; app: string; public: number }>(sql`select c.relforcerowsecurity as forced,
      (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants g where g.table_name = c.relname and g.grantee = 'ai_hr_app') as app,
      (select count(*)::int from information_schema.role_table_grants g where g.table_name = c.relname and g.grantee = 'PUBLIC') as public
      from pg_class c where c.relname = 'recruitment_task_read_marker'`);
    expect(grants).toEqual({ forced: true, app: 'INSERT,SELECT,UPDATE', public: 0 });
  });
});

describe('case 64 — the bell lists the recruitment to-dos only for Recruitment users while the module is on', () => {
  it('adds working recruitment items for those who asked and leaves every other bell item and count unchanged', async () => {
    const w = await world();
    const p1 = await login('Fictional Offer Approver');
    await saveApprovalFlow(admin, base.companyId, 'offer', [p1.userId]);
    const { id: offerId } = await saveOffer(w.recruiter, w.c3.applicationId, await offerValues());
    await submitOffer(w.recruiter, offerId);
    const plain = { attendance: false, claims: false, performance: false, rewards: false };
    const recruitmentKinds = new Set<string>(RECRUITMENT_TASK_KINDS);
    const bell = (ctx: SessionContext) => listPendingTasks(ctx, undefined, { ...plain, recruitment: isModuleEnabled(ctx, 'recruitment') });
    // A non-recruitment bell task for the recruiter and the interviewer (a notice to acknowledge), so "unchanged" compares
    // real lists.
    await acknowledgementFor([w.recruiter, w.i1]);
    for (const who of [w.recruiter, w.i1]) expect((await listPendingTasks(who, undefined, plain)).map((i) => i.kind)).toEqual(['noticeAcknowledgement']);
    const ofRecruitment = <T extends { kind: string }>(items: T[]) => items.filter((i) => recruitmentKinds.has(i.kind));

    // D-035: the bell carries personal to-dos only. The recruiter's per-job counts are on the Overview, not here.
    const recruiterBell = await bell(w.recruiter);
    expect(ofRecruitment(recruiterBell)).toEqual([]);
    expect(todoKeys((await recruitmentJobTodos(w.recruiter, undefined) as { items: RecruitmentTodo[] }).items)).toEqual([`toSchedule:${w.j1}:1`, `toScreen:${w.j1}:2`]);
    for (const who of [w.recruiter, w.assistant, w.i1, p1]) {
      const kinds = (await bell(who)).map((i) => i.kind as string);
      expect(kinds.some((k) => /schedule|screen/i.test(k))).toBe(false);
      for (const item of ofRecruitment(await bell(who))) expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'kind', 'linkPath', 'subjectName']);
    }
    expect(ofRecruitment(await bell(w.i1)).map((i) => `${i.kind}|${i.subjectName}|${i.linkPath}`)).toEqual([
      `recruitmentFeedback|Fictional Candidate 3 · Fictional data analyst|/recruitment/interviews/${w.iv3}/feedback`,
    ]);
    expect(ofRecruitment(await bell(p1)).map((i) => `${i.kind}|${i.linkPath}`)).toEqual(['recruitmentOfferApproval|/recruitment/approvals']);
    // The links work: each target answers for that viewer.
    expect((await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j1, tab: w.interview })).cards.map((c) => c.id)).toContain(w.c1.applicationId);
    await expect(scorecardForm(w.i1, w.iv3)).resolves.toBeTruthy();
    expect((await myApprovals(p1)).offers).toHaveLength(1);
    expect(JSON.stringify(recruiterBell)).not.toContain(SALARY_SENTINEL);

    // Nobody else gets one, and a surface that did not ask (plain InboxModules, or recruitment false) gets none.
    for (const who of [w.bystander, w.manager, admin]) expect(ofRecruitment(await bell(who))).toEqual([]);
    expect(ofRecruitment(await listPendingTasks(w.recruiter, undefined, plain))).toEqual([]);
    expect(ofRecruitment(await listPendingTasks(w.recruiter, undefined, { ...plain, recruitment: false }))).toEqual([]);
    // Every other bell item is unchanged by asking: the same list with the recruitment items taken out.
    for (const who of [w.recruiter, w.i1, p1, admin]) {
      const asked = await bell(who);
      expect(asked.filter((i) => !recruitmentKinds.has(i.kind))).toEqual(await listPendingTasks(who, undefined, plain));
      expect(withoutRecruitmentTasks(asked)).toEqual(await listPendingTasks(who, undefined, plain));
    }
    expect((await bell(w.recruiter)).map((i) => i.kind)).toEqual(['noticeAcknowledgement']);
    expect((await bell(w.i1)).map((i) => i.kind).sort()).toEqual(['noticeAcknowledgement', 'recruitmentFeedback']);

    // Module off: the layout's flag is false and the bell has no recruitment item; forcing the flag still yields none.
    await setModule(base.tenantId, 'recruitment', 'disabled');
    const fresh = await entitledCtx(base);
    const off = { ...fresh, userId: w.recruiter.userId, personId: w.recruiter.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    expect(isModuleEnabled(off, 'recruitment')).toBe(false);
    expect(ofRecruitment(await bell(off))).toEqual([]);
    expect(ofRecruitment(await listPendingTasks(off, undefined, { ...plain, recruitment: true }))).toEqual([]);
    expect(await listPendingTasks(off, undefined, { ...plain, recruitment: true })).toEqual(await listPendingTasks(off, undefined, plain));
  });
});

describe('case 64 — My tasks lists what its badge counts; Home and the launcher count no recruitment item', () => {
  it('gives My tasks and the bell the same recruitment items for the same selection, and the launcher the list without them', async () => {
    const w = await world();
    await acknowledgementFor([w.recruiter, w.i1]);
    const p1 = await login('Fictional Offer Approver');
    await saveApprovalFlow(admin, base.companyId, 'offer', [p1.userId]);
    const { id: offerId } = await saveOffer(w.recruiter, w.c3.applicationId, await offerValues());
    await submitOffer(w.recruiter, offerId);
    const modules = { attendance: false, claims: false, performance: false, rewards: false, recruitment: true };
    for (const [who, scope] of [w.recruiter, w.i1, p1].flatMap((who) => [[base.companyId], [base.companyId, otherCompanyId], [otherCompanyId]].map((scope) => [who, scope] as const))) {
      // The root layout: the bell list, whose length (plus lifecycle work, none here) is the sidebar's My tasks badge.
      const bellList = await listPendingTasks(who, scope, modules);
      // My tasks: the page's own list (app/tasks/page.tsx → listMyTasks with the same selection).
      const page = await listMyTasks(who, scope, modules);
      expect(page.map((i) => i.kind as string).some((k) => /schedule|screen/i.test(k))).toBe(false);
      const recruitment = (items: { kind: string; id: string }[]) => items.filter((i) => (RECRUITMENT_TASK_KINDS as readonly string[]).includes(i.kind)).map((i) => `${i.kind}:${i.id}`).sort();
      expect(recruitment(page)).toEqual(recruitment(bellList));
      expect(page.length).toBe(bellList.length);
      // The AI Centre launcher (it opens Home) counts the list without the recruitment kinds, as Home lists it.
      expect(withoutRecruitmentTasks(bellList).length).toBe((await listPendingTasks(who, scope, { attendance: false, claims: false, performance: false, rewards: false })).length);
    }
    // Non-empty: feedback for the interviewer (in the selection only), the approval step for the approver (tenant-wide).
    expect((await listMyTasks(w.i1, [base.companyId], modules)).map((i) => i.kind).sort()).toEqual(['noticeAcknowledgement', 'recruitmentFeedback']);
    expect((await listMyTasks(w.i1, [otherCompanyId], modules)).map((i) => i.kind)).toEqual(['noticeAcknowledgement']);
    expect((await listMyTasks(p1, [otherCompanyId], modules)).map((i) => i.kind)).toEqual(['recruitmentOfferApproval']);
    expect((await listMyTasks(w.recruiter, [base.companyId], modules)).map((i) => i.kind)).toEqual(['noticeAcknowledgement']);
    expect((await listMyTasks(w.i1, [base.companyId], { ...modules, recruitment: false })).map((i) => i.kind)).toEqual(['noticeAcknowledgement']);
    // The page and layout wiring this rests on.
    const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain("recruitment: isModuleEnabledOrFalse(session, 'recruitment'),");
    expect(layout).toContain('taskCount={pendingTaskCount}');
    expect(layout).toContain('inboxCount={withoutRecruitmentTasks(approvalTasks).length}');
    const tasksPage = readFileSync(new URL('../app/tasks/page.tsx', import.meta.url), 'utf8');
    expect(tasksPage).toContain("const {s,scopeIds}=await scopedSession()");
    expect(tasksPage).toContain("listMyTasks(s,scopeIds,{");
    expect(tasksPage).toContain("recruitment:isModuleEnabledOrFalse(s,'recruitment')");
  });
});

describe('case 62 — the 90-day window and keyset paging', () => {
  it('pages 20 at a time newest first, ends without an "Older" link, and leaves out what is older than 90 days', async () => {
    const w = await world();
    await updateCareersSettings(admin, base.companyId, { address: 'fictional-paging', displayName: 'Fictional Careers', headline: 'Fictional headline', introduction: 'Fictional introduction.', notice: 'Fictional privacy notice.' });
    await setCareersPublished(admin, base.companyId, true);
    await setJobCareersPage(admin, w.j1, true);
    for (let n = 0; n < 45; n++) {
      expect(await submitCareersApplication({
        address: 'fictional-paging', jobId: w.j1, fullName: `Fictional Applicant ${n}`, email: `paging${n}@example.test`, mobile: '', message: '',
        consent: 'on', noticeVersion: '1', website: '', resume: null, clientHash: () => n.toString(16).padStart(64, 'a'), currentNoticeVersion: 1,
      })).toEqual({ ok: true, outcome: 'received' });
    }
    // Two arrivals moved to the window's edges: 89 days ago (in) and 91 days ago (out).
    const arrivals = await owner.db.execute<{ application_id: string }>(sql`select application_id from recruitment_careers_application where job_id = ${w.j1}::uuid order by application_id limit 2`);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_careers_application set received_at = now() - interval '89 days' where application_id = ${arrivals[0].application_id}::uuid`;
      await tx`update recruitment_careers_application set received_at = now() - interval '91 days' where application_id = ${arrivals[1].application_id}::uuid`;
    });
    // Independent expectation: the job's careers arrivals within 90 days, newest first (owner connection, plain SQL).
    const expected = (await owner.db.execute<{ id: string }>(sql`select application_id::text || ':careers' as id from recruitment_careers_application
      where job_id = ${w.j1}::uuid and received_at >= now() - interval '90 days' order by received_at desc, application_id::text || ':careers' desc`)).map((r) => r.id);
    expect(expected).toHaveLength(44);
    const pages: Awaited<ReturnType<typeof recruitmentUpdates>>[] = [];
    let after: string | undefined;
    for (let page = 1; page <= 4; page++) {
      const got = await recruitmentUpdates(w.recruiter, { companyIds: [base.companyId], category: 'applications', page, after });
      pages.push(got);
      if (!got.hasMore) break;
      after = got.nextCursor!;
    }
    expect(pages.map((p) => [p.page, p.items.length, p.hasMore])).toEqual([[1, UPDATES_PAGE_SIZE, true], [2, UPDATES_PAGE_SIZE, true], [3, 4, false]]);
    expect(pages[2].nextCursor).toBeNull();
    expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(expected);
    expect(pages.flatMap((p) => p.items).some((i) => i.id === `${arrivals[1].application_id}:careers`)).toBe(false);
    expect(await code(recruitmentUpdates(w.recruiter, { companyIds: [base.companyId], category: 'applications', page: 2, after: 'not-a-cursor' }))).toBe('invalid_input');
    // The unread count reads only after the read-up-to time: the first open makes every one of them read.
    expect((await recruitmentUnreadCounts(w.recruiter, [base.companyId])).applications).toBe(0);
  });
});

describe('case 63 — the company delete removes every user\'s markers under a production-like owner', () => {
  it('app.recruitment_delete_company_setup deletes the markers of a company for a NOBYPASSRLS owner, with row security forced', async () => {
    const w = await world();
    const [{ id: emptyCompany }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Empty Sdn Bhd' }).returning({ id: company.id });
    const partner = await login('Fictional Partner', emptyCompany);
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: partner.userId, companyId: emptyCompany, role: 'recruiting_partner' });
    const partnerCtx = { ...partner, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: emptyCompany }] };
    await recruitmentUnreadCounts(admin, [emptyCompany, base.companyId]);
    await recruitmentUnreadCounts(partnerCtx, [emptyCompany]);
    await recruitmentUnreadCounts(w.recruiter, [base.companyId]);
    const markers = async (companyId: string) => (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_task_read_marker where company_id = ${companyId}::uuid`))[0].n;
    expect(await markers(emptyCompany)).toBe(8);
    expect(await markers(base.companyId)).toBe(8);
    const ROLLBACK = 'rolled back on purpose';
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      expect(tables.map((t) => t.name)).toContain('public.recruitment_task_read_marker');
      for (const t of tables) await tx.unsafe(`alter table ${t.name} owner to ai_hr_owner`);
      await tx.unsafe('alter function app.recruitment_delete_company_setup(uuid) owner to ai_hr_owner');
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      const [forced] = await tx`select relforcerowsecurity as forced from pg_class where oid = 'public.recruitment_task_read_marker'::regclass`;
      expect(forced.forced).toBe(true);
      await tx.unsafe('set local role ai_hr_app');
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${base.adminUserId}, true), set_config('app.roles', 'hr_admin', true),
        set_config('app.grants', ${JSON.stringify([{ role: 'hr_admin', companyId: null }])}, true)`;
      // Setting the company-delete context value itself opens nothing to the app role: the policies are owner-bound.
      await tx`select set_config('app.recruitment_company_delete', ${emptyCompany}, true)`;
      expect(await tx`select 1 from recruitment_task_read_marker where app_user_id = ${partner.userId}::uuid`).toHaveLength(0);
      await tx`select set_config('app.recruitment_company_delete', '', true)`;
      // The app role itself cannot delete a marker (no grant), even its own.
      await tx`savepoint direct`;
      await expect(tx`delete from recruitment_task_read_marker where company_id = ${emptyCompany}::uuid`).rejects.toMatchObject({ code: '42501' });
      await tx`rollback to savepoint direct`;
      const [removed] = await tx`select app.recruitment_delete_company_setup(${emptyCompany}::uuid) as n`;
      expect(Number(removed.n)).toBeGreaterThanOrEqual(8);
      await tx`reset role`;
      const [left] = await tx`select count(*)::int as n from recruitment_task_read_marker where company_id = ${emptyCompany}::uuid`;
      const [kept] = await tx`select count(*)::int as n from recruitment_task_read_marker where company_id = ${base.companyId}::uuid`;
      expect([left.n, kept.n]).toEqual([0, 8]);
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => (e instanceof Error && e.message === ROLLBACK ? 'rolled back' : Promise.reject(e)));
    expect(done).toBe('rolled back');
    expect(await markers(emptyCompany)).toBe(8);
  });
});

describe('case 59 — the Overview\'s per-job counts load on their own and fail in place', () => {
  it('answers "unavailable" when its statement timeout fires, while the personal to-dos still answer', async () => {
    const w = await world();
    expect(await recruitmentJobTodos(w.recruiter, undefined)).toMatchObject({ status: 'ok', items: [expect.objectContaining({ kind: 'toSchedule' }), expect.objectContaining({ kind: 'toScreen' })] });
    // Another session holds the application table exclusively: the counts' read waits past its timeout (forced small here).
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const locked = new Promise<void>((ready) => {
      void owner.client.begin(async (tx) => {
        await tx`lock table recruitment_application in access exclusive mode`;
        ready();
        await held;
      });
    });
    await locked;
    try {
      expect(await recruitmentJobTodos(w.recruiter, undefined, { timeoutMs: 300 })).toEqual({ status: 'unavailable' });
    } finally {
      release();
    }
    // Once the lock is gone the counts answer again, and the personal list was never affected.
    expect((await recruitmentJobTodos(w.recruiter, undefined)).status).toBe('ok');
    expect(todoKeys(await recruitmentTodos(w.i1, undefined))).toEqual([`feedback:${w.iv3}`]);
  });
});
