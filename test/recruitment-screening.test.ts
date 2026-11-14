/**
 * Recruitment slice 11 against Postgres: acceptance cases 75–80 (docs/recruitment-reconstruction/specification.md "Slice 11
 * acceptance cases") through the service AND directly as the app role. Case 81 is the lead's rendered check. The pure rules
 * are test/recruitment-screening-rules.test.ts.
 *
 * Expected values are computed independently of packs/recruitment/screening.ts: from what each fixture step did (ids kept as
 * the fixture creates them), from plain owner-connection SQL that ignores row security, and — for the assignment status — from
 * a rule written out again in this file over the owner's rows (microsecond times). Every person and value is fictional;
 * S11SENTINEL marks notes and comments that must vanish with a removal and never appear in a to-do or an update.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addCalendarMonths, todayInKualaLumpur } from '../lib/hr-date';
import {
  addApplication, addJobMember, answerScreening, applicationScreening, BELL_TIMEOUT_MS, candidateBoard, createJob, destroyCandidates, moveApplication,
  myScreeningRequests, offerSettings, pendingRecruitmentTasks, reassignScreening, recruitmentPipelineCounts, recruitmentSettings, recruitmentTodos, recruitmentUpdates,
  recruitmentViewer, rejectApplication, removeJobMember, saveApprovalFlow, saveOffer, screeningSendOptions, sendForScreening, submitOffer, withdrawScreening,
  RecruitmentError, type AssignmentStatus,
} from '../packs/recruitment/service';
import { applicationScreeningTx, screeningSendOptionsTx } from '../packs/recruitment/screening';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SENTINEL = 'S11SENTINEL';
/** Timings and plans: printed, and also appended to $SCREENING_TIMING_LOG when set (passing tests' output is not shown). */
const report = (text: string) => {
  console.log(text);
  if (process.env.SCREENING_TIMING_LOG) appendFileSync(process.env.SCREENING_TIMING_LOG, `${text}\n`);
};
const NEW_TABLES = ['recruitment_screening_answer', 'recruitment_screening_request'];
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
const rows = <T = Record<string, unknown>>(ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute<T & Record<string, unknown>>(query));
type Login = SessionContext & { userId: string };
async function login(name: string, companyId = base.companyId): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional data analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', ...over,
});
let seq = 0;
/** A job with a recruiter, an assistant, two hiring managers and an interviewer. */
async function team(title = 'Fictional data analyst', companyId = base.companyId) {
  const n = ++seq;
  const [recruiter, assistant, hm1, hm2, interviewer] = await Promise.all([
    login(`Fictional Recruiter ${n}`, companyId), login(`Fictional Assistant ${n}`, companyId), login(`Fictional Manager A${n}`, companyId),
    login(`Fictional Manager B${n}`, companyId), login(`Fictional Interviewer ${n}`, companyId),
  ]);
  const { id: jobId } = await createJob(admin, job({ title, companyId, recruiterUserId: recruiter.userId }));
  await addJobMember(admin, jobId, 'assistant', assistant.userId);
  await addJobMember(admin, jobId, 'hiring_manager', hm1.userId);
  await addJobMember(admin, jobId, 'hiring_manager', hm2.userId);
  await addJobMember(admin, jobId, 'interviewer', interviewer.userId);
  return { jobId, recruiter, assistant, hm1, hm2, interviewer };
}
type Team = Awaited<ReturnType<typeof team>>;
const apply = async (t: Team, name = `Fictional Candidate ${++seq}`) => addApplication(t.recruiter, { jobId: t.jobId, fullName: name, email: `c${++seq}@example.test` });
/** The enabled stages of a job's process in order (owner connection, plain SQL). */
async function stagesOf(jobId: string): Promise<{ id: string; name: string }[]> {
  return owner.db.execute<{ id: string; name: string }>(sql`select ps.stage_id as id, st.name from recruitment_job_opening j
    join recruitment_process_stage ps on ps.process_id = j.process_id join recruitment_stage st on st.id = ps.stage_id and st.enabled
    where j.id = ${jobId}::uuid order by ps.position`);
}
const stageOfApp = async (applicationId: string) =>
  (await owner.db.execute<{ stage: string; state: string }>(sql`select current_stage_id as stage, state from recruitment_application where id = ${applicationId}::uuid`))[0];
/** Owner-connection request ids of an application, by reviewer. */
async function requestOf(applicationId: string, reviewer: string, open = true): Promise<string> {
  const [r] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_screening_request where application_id = ${applicationId}::uuid
    and reviewer_user_id = ${reviewer}::uuid ${open ? sql`and closed_at is null` : sql``} order by sent_at desc, id limit 1`);
  return r.id;
}
const insertRequest = (who: Login, t: Team, applicationId: string, reviewer: string) => rows(who, sql`
  insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id)
  values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${applicationId}::uuid, ${reviewer}::uuid, ${who.userId}::uuid) returning id`);
/** A direct answer as `who`, naming `by` as the author; the request's keys are read by the owner (the caller may not see it). */
async function insertAnswer(who: SessionContext, requestId: string, by: string, result = 'advance') {
  const [q] = await owner.db.execute<{ job_id: string; application_id: string }>(sql`select job_id, application_id from recruitment_screening_request where id = ${requestId}::uuid`);
  return rows(who, sql`insert into recruitment_screening_answer (tenant_id, company_id, job_id, application_id, request_id, result, answered_by_user_id)
    values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${q.job_id}::uuid, ${q.application_id}::uuid, ${requestId}::uuid, ${result}, ${by}::uuid) returning id`);
}
/** The guard's named rule (RAISE … CONSTRAINT) from a database error or its causes. */
const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  return undefined;
};
const memberRow = async (jobId: string, userId: string) => (await owner.db.execute<{ id: string }>(sql`select id from recruitment_job_member where job_id = ${jobId}::uuid
  and app_user_id = ${userId}::uuid and member_role = 'hiring_manager'`))[0].id;
async function rejectAndAge(applicationId: string) {
  const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
  await rejectApplication(admin, applicationId, reason.id);
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_application set state_changed_at = ${`${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`}::timestamptz where id = ${applicationId}::uuid`;
  });
}

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

describe('case 75 — who sends, to whom, what can be sent, and the move in the same transaction', () => {
  it('operators and administrators send, reassign and withdraw; nobody else can, by the service or the tables', async () => {
    const t = await team();
    const t2 = await team('Fictional other role');
    const bystander = await login('Fictional Bystander');
    const [a1, a2, a3] = [await apply(t), await apply(t), await apply(t)];
    // The reviewer choice: the job's two hiring managers, oldest first, for operators only.
    expect((await screeningSendOptions(t.recruiter, t.jobId)).reviewers?.map((r) => r.id)).toEqual([t.hm1.userId, t.hm2.userId]);
    expect((await screeningSendOptions(admin, t.jobId)).reviewers?.map((r) => r.name)).toEqual([expect.stringContaining('Fictional Manager A'), expect.stringContaining('Fictional Manager B')]);
    for (const who of [t.hm1, t.interviewer, bystander, t2.recruiter]) {
      expect(await code(screeningSendOptions(who, t.jobId))).toMatch(/forbidden|not_found/);
      expect(await code(sendForScreening(who, { applicationIds: [a1.applicationId] }))).toMatch(/forbidden|not_found/);
      expect(await code(reassignScreening(who, { applicationId: a1.applicationId, reviewerUserIds: [t.hm1.userId] }))).toMatch(/forbidden|not_found/);
      // Directly: the insert is refused by row security, and the definer lists no hiring manager to them.
      expect(await code(insertRequest(who, t, a1.applicationId, t.hm1.userId))).toBe('42501');
      expect(await rows(who, sql`select * from app.recruitment_job_hiring_managers(${t.jobId}::uuid)`)).toEqual([]);
    }
    expect(await owner.db.execute(sql`select 1 from recruitment_screening_request`)).toHaveLength(0);
    // The recruiter sends two applications to every hiring manager, moving both to the next enabled stage.
    const stages = await stagesOf(t.jobId);
    expect(stages.length).toBeGreaterThan(2);
    const before = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_application_event where application_id in (${a1.applicationId}::uuid, ${a2.applicationId}::uuid)`);
    expect(await sendForScreening(t.recruiter, { applicationIds: [a1.applicationId, a2.applicationId], note: `${SENTINEL} note`, move: true })).toEqual({ sent: 4, skipped: 0, moved: 2 });
    const sent = await owner.db.execute<{ application_id: string; reviewer_user_id: string; sent_by_user_id: string; note: string; tx: string; closed_at: string | null }>(sql`
      select application_id, reviewer_user_id, sent_by_user_id, note, xmin::text as tx, closed_at from recruitment_screening_request order by application_id, reviewer_user_id`);
    expect(sent.map((r) => `${r.application_id}|${r.reviewer_user_id}`).sort()).toEqual(
      [a1.applicationId, a2.applicationId].flatMap((a) => [t.hm1.userId, t.hm2.userId].map((h) => `${a}|${h}`)).sort());
    expect(new Set(sent.map((r) => r.sent_by_user_id))).toEqual(new Set([t.recruiter.userId]));
    expect(sent.every((r) => r.note === `${SENTINEL} note` && r.closed_at === null)).toBe(true);
    // Both moved to the stage after the first (independently: the second enabled stage), with one history row each, in the
    // SAME transaction as the requests (equal xmin).
    for (const a of [a1, a2]) expect((await stageOfApp(a.applicationId)).stage).toBe(stages[1].id);
    const events = await owner.db.execute<{ application_id: string; kind: string; to_stage_id: string; actor_user_id: string; tx: string }>(sql`
      select application_id, kind, to_stage_id, actor_user_id, xmin::text as tx from recruitment_application_event
      where application_id in (${a1.applicationId}::uuid, ${a2.applicationId}::uuid) and kind = 'moved'`);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.to_stage_id === stages[1].id && e.actor_user_id === t.recruiter.userId)).toBe(true);
    expect(new Set([...events.map((e) => e.tx), ...sent.map((r) => r.tx)]).size).toBe(1);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_application_event where application_id in (${a1.applicationId}::uuid, ${a2.applicationId}::uuid)`))[0].n)
      .toBe(before[0].n + 2);
    // Not asked twice: sending again skips both open requests and moves nothing (no move asked).
    expect(await sendForScreening(t.assistant, { applicationIds: [a1.applicationId] })).toEqual({ sent: 0, skipped: 2, moved: 0 });
    expect(await code(insertRequest(t.recruiter, t, a1.applicationId, t.hm1.userId))).toBe('23505');
    // Withdraw (assistant) and reassign (administrator) to the same reviewer: a new open request; the withdrawn one stays.
    const withdrawn = await requestOf(a1.applicationId, t.hm2.userId);
    for (const who of [t.hm1, t.hm2, t.interviewer, bystander, t2.recruiter]) expect(await code(withdrawScreening(who, withdrawn))).toMatch(/forbidden|not_found/);
    expect(await code(withdrawScreening(t.assistant, withdrawn))).toBe('ok');
    expect(await code(withdrawScreening(t.assistant, withdrawn))).toBe('screening_closed');
    expect(await reassignScreening(admin, { applicationId: a1.applicationId, reviewerUserIds: [t.hm2.userId] })).toEqual({ sent: 1, skipped: 0, moved: 0 });
    const hm2Rows = await owner.db.execute<{ closed_reason: string | null; closed_by_user_id: string | null }>(sql`select closed_reason, closed_by_user_id
      from recruitment_screening_request where application_id = ${a1.applicationId}::uuid and reviewer_user_id = ${t.hm2.userId}::uuid order by sent_at, closed_at nulls last`);
    expect(hm2Rows).toEqual([{ closed_reason: 'withdrawn', closed_by_user_id: t.assistant.userId }, { closed_reason: null, closed_by_user_id: null }]);
    // A reviewer cannot withdraw their own request directly, nor anybody rewrite a request or delete one.
    const open1 = await requestOf(a1.applicationId, t.hm1.userId);
    expect(await code(rows(t.hm1, sql`update recruitment_screening_request set closed_at = now(), closed_reason = 'withdrawn', closed_by_user_id = ${t.hm1.userId}::uuid
      where id = ${open1}::uuid`))).toBe('42501');
    expect(await code(rows(t.hm1, sql`update recruitment_screening_request set closed_at = now(), closed_reason = 'answered', closed_by_user_id = ${t.hm1.userId}::uuid
      where id = ${open1}::uuid`))).toBe('42501');
    expect(await code(rows(t.recruiter, sql`update recruitment_screening_request set note = 'Fictional rewrite' where id = ${open1}::uuid`))).toBe('23514');
    expect(await code(rows(t.recruiter, sql`update recruitment_screening_request set sent_by_user_id = ${t.assistant.userId}::uuid where id = ${open1}::uuid`))).toBe('23514');
    expect(await code(rows(t.recruiter, sql`update recruitment_screening_request set sent_at = now() - interval '1 day' where id = ${open1}::uuid`))).toBe('23514');
    expect(await code(rows(t.recruiter, sql`update recruitment_screening_request set closed_at = now(), closed_reason = 'withdrawn', closed_by_user_id = ${t.assistant.userId}::uuid
      where id = ${open1}::uuid`))).toBe('42501');
    expect(await code(rows(t.recruiter, sql`update recruitment_screening_request set note = null where id = ${withdrawn}::uuid`))).toBe('23514');
    expect(await code(rows(admin, sql`delete from recruitment_screening_request where id = ${open1}::uuid`))).toBe('42501');
    // A direct insert must name the current user as sender and start open.
    expect(await code(rows(t.recruiter, sql`insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${a3.applicationId}::uuid, ${t.hm1.userId}::uuid, ${t.assistant.userId}::uuid)`))).toBe('42501');
    expect(await code(rows(t.recruiter, sql`insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id, closed_at, closed_reason, closed_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${a3.applicationId}::uuid, ${t.hm1.userId}::uuid, ${t.recruiter.userId}::uuid, now(), 'withdrawn', ${t.recruiter.userId}::uuid)`))).toBe('42501');
    expect(await code(rows(t.recruiter, sql`insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t2.jobId}::uuid, ${a3.applicationId}::uuid, ${t.hm1.userId}::uuid, ${t.recruiter.userId}::uuid)`))).toMatch(/42501|23503/);
  });

  it('reviewers must be the job\'s hiring managers; archived and hired applications cannot be sent; one job at a time; all or nothing', async () => {
    const t = await team();
    const t2 = await team('Fictional other role');
    const [a1, a2, archived, hired] = [await apply(t), await apply(t), await apply(t), await apply(t)];
    for (const notReviewer of [t.interviewer.userId, t.recruiter.userId, t2.hm1.userId]) {
      expect(await code(sendForScreening(t.recruiter, { applicationIds: [a1.applicationId], reviewerUserIds: [notReviewer] }))).toBe('not_hiring_manager');
      expect(await code(insertRequest(t.recruiter, t, a1.applicationId, notReviewer))).toBe('23514');
    }
    // A hiring manager removed from the job is no longer a reviewer.
    await removeJobMember(admin, t.jobId, (await owner.db.execute<{ id: string }>(sql`select id from recruitment_job_member where job_id = ${t.jobId}::uuid
      and app_user_id = ${t.hm2.userId}::uuid and member_role = 'hiring_manager'`))[0].id);
    expect(await code(sendForScreening(t.recruiter, { applicationIds: [a1.applicationId], reviewerUserIds: [t.hm2.userId] }))).toBe('not_hiring_manager');
    expect(await code(insertRequest(t.recruiter, t, a1.applicationId, t.hm2.userId))).toBe('23514');
    // A job without hiring managers.
    const lone = await login('Fictional Lone Recruiter');
    const { id: noManagerJob } = await createJob(admin, job({ title: 'Fictional no-manager role', recruiterUserId: lone.userId }));
    const { applicationId: n1 } = await addApplication(lone, { jobId: noManagerJob, fullName: 'Fictional Person N', email: 'n@example.test' });
    expect(await code(sendForScreening(lone, { applicationIds: [n1] }))).toBe('no_hiring_manager');
    // Archived and hired.
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(t.recruiter, archived.applicationId, reason.id);
    const stages = await stagesOf(t.jobId);
    await moveApplication(t.recruiter, hired.applicationId, stages[stages.length - 1].id);
    expect((await moveApplication(t.recruiter, hired.applicationId)).state).toBe('hired');
    for (const closed of [archived.applicationId, hired.applicationId]) {
      expect(await code(sendForScreening(t.recruiter, { applicationIds: [closed] }))).toBe('application_closed');
      expect(await code(insertRequest(t.recruiter, t, closed, t.hm1.userId))).toBe('23514');
    }
    // The guard names which rule refused (the service maps a race on each to its own code, not one for both).
    expect(constraintOf(await insertRequest(t.recruiter, t, archived.applicationId, t.hm1.userId).catch((e: unknown) => e))).toBe('recruitment_screening_request_application_active');
    expect(constraintOf(await insertRequest(t.recruiter, t, a1.applicationId, t.interviewer.userId).catch((e: unknown) => e))).toBe('recruitment_screening_request_reviewer_hiring_manager');
    // One selection, one job.
    const other = await apply(t2);
    expect(await code(sendForScreening(admin, { applicationIds: [a1.applicationId, other.applicationId] }))).toBe('mixed_jobs');
    // All or nothing: a closed application in the selection refuses the whole send — no request, no move for a2.
    const a2Stage = (await stageOfApp(a2.applicationId)).stage;
    expect(await code(sendForScreening(t.recruiter, { applicationIds: [a2.applicationId, archived.applicationId], move: true }))).toBe('application_closed');
    expect(await owner.db.execute(sql`select 1 from recruitment_screening_request where application_id = ${a2.applicationId}::uuid`)).toHaveLength(0);
    expect((await stageOfApp(a2.applicationId)).stage).toBe(a2Stage);
    // From the last stage there is no next stage: the request is sent and the application stays (sending never hires).
    const last = await apply(t);
    await moveApplication(t.recruiter, last.applicationId, stages[stages.length - 1].id);
    expect(await sendForScreening(t.recruiter, { applicationIds: [last.applicationId], move: true })).toEqual({ sent: 1, skipped: 0, moved: 0 });
    expect(await stageOfApp(last.applicationId)).toEqual({ stage: stages[stages.length - 1].id, state: 'active' });
  });

  it('the move applies only to applications that got at least one new request', async () => {
    const t = await team();
    const [asked, fresh] = [await apply(t), await apply(t)];
    const stages = await stagesOf(t.jobId);
    await sendForScreening(t.recruiter, { applicationIds: [asked.applicationId], reviewerUserIds: [t.hm1.userId] });
    // Re-sending to the reviewer already asked creates nothing and moves nothing; the fresh one gets its request and moves.
    expect(await sendForScreening(t.recruiter, { applicationIds: [asked.applicationId, fresh.applicationId], reviewerUserIds: [t.hm1.userId], move: true }))
      .toEqual({ sent: 1, skipped: 1, moved: 1 });
    expect((await stageOfApp(asked.applicationId)).stage).toBe(stages[0].id);
    expect((await stageOfApp(fresh.applicationId)).stage).toBe(stages[1].id);
    // With a reviewer not yet asked, the same application does get a new request and moves.
    expect(await sendForScreening(t.recruiter, { applicationIds: [asked.applicationId], reviewerUserIds: [t.hm1.userId, t.hm2.userId], move: true }))
      .toEqual({ sent: 1, skipped: 1, moved: 1 });
    expect((await stageOfApp(asked.applicationId)).stage).toBe(stages[1].id);
  });
});

describe('case 76 — only the named reviewer answers their open request; Pending then a final answer; withdrawn is closed', () => {
  it('keeps the answer history, refuses everybody else and every closed request, and never moves the application', async () => {
    const t = await team();
    const bystander = await login('Fictional Bystander');
    const [a1, a2] = [await apply(t), await apply(t)];
    await sendForScreening(t.recruiter, { applicationIds: [a1.applicationId, a2.applicationId] });
    const q1 = await requestOf(a1.applicationId, t.hm1.userId);
    const q2 = await requestOf(a1.applicationId, t.hm2.userId);
    const stage = (await stageOfApp(a1.applicationId)).stage;
    // Nobody but hm1 answers q1 — not the recruiter, the administrator, the other hiring manager or anyone else.
    for (const who of [t.recruiter, t.assistant, admin, t.hm2, t.interviewer, bystander]) {
      expect(await code(answerScreening(who, q1, { result: 'advance' }))).toMatch(/not_your_request|not_found/);
      expect(await code(insertAnswer(who, q1, who.userId!))).toBe('42501');
      expect(await code(insertAnswer(who, q1, t.hm1.userId))).toBe('42501');
    }
    // Pending, then Advance: two answers in order; the request closes only with the final one.
    const p = await answerScreening(t.hm1, q1, { result: 'pending', comment: `${SENTINEL} need more` });
    expect(p.closed).toBe(false);
    expect((await owner.db.execute<{ closed_at: string | null }>(sql`select closed_at from recruitment_screening_request where id = ${q1}::uuid`))[0].closed_at).toBeNull();
    const f = await answerScreening(t.hm1, q1, { result: 'advance', comment: `${SENTINEL} strong` });
    expect(f.closed).toBe(true);
    const history = await owner.db.execute<{ id: string; result: string; answered_by_user_id: string }>(sql`
      select id, result, answered_by_user_id from recruitment_screening_answer where request_id = ${q1}::uuid order by answered_at, id`);
    expect(history).toEqual([
      { id: p.answerId, result: 'pending', answered_by_user_id: t.hm1.userId }, { id: f.answerId, result: 'advance', answered_by_user_id: t.hm1.userId },
    ]);
    expect((await owner.db.execute(sql`select closed_reason, closed_by_user_id from recruitment_screening_request where id = ${q1}::uuid`))[0])
      .toEqual({ closed_reason: 'answered', closed_by_user_id: t.hm1.userId });
    // Answered: closed to further answers (service and table).
    expect(await code(answerScreening(t.hm1, q1, { result: 'reject' }))).toBe('screening_closed');
    expect(await code(insertAnswer(t.hm1, q1, t.hm1.userId, 'reject'))).toBe('23514');
    // An answer is kept as given.
    expect(await code(rows(t.hm1, sql`update recruitment_screening_answer set result = 'reject' where id = ${f.answerId}::uuid`))).toBe('42501');
    expect(await code(rows(admin, sql`delete from recruitment_screening_answer where id = ${f.answerId}::uuid`))).toBe('42501');
    // Withdrawn: cannot be answered.
    await withdrawScreening(t.recruiter, q2);
    expect(await code(answerScreening(t.hm2, q2, { result: 'advance' }))).toMatch(/screening_closed|not_found/);
    expect(await code(insertAnswer(t.hm2, q2, t.hm2.userId))).toMatch(/23514|42501/);
    // A request withdrawn after a Pending answer is closed too.
    const q3 = await requestOf(a2.applicationId, t.hm2.userId);
    await answerScreening(t.hm2, q3, { result: 'pending' });
    await withdrawScreening(t.assistant, q3);
    expect(await code(answerScreening(t.hm2, q3, { result: 'advance' }))).toBe('screening_closed');
    // A hiring manager removed from the job can no longer answer.
    const q4 = await requestOf(a2.applicationId, t.hm1.userId);
    await removeJobMember(admin, t.jobId, (await owner.db.execute<{ id: string }>(sql`select id from recruitment_job_member where job_id = ${t.jobId}::uuid
      and app_user_id = ${t.hm1.userId}::uuid and member_role = 'hiring_manager'`))[0].id);
    expect(await code(answerScreening(t.hm1, q4, { result: 'advance' }))).toBe('not_found');
    expect(await code(insertAnswer(t.hm1, q4, t.hm1.userId))).toBe('42501');
    // Answers never move or reject the application.
    expect(await stageOfApp(a1.applicationId)).toEqual({ stage, state: 'active' });
  });

  it('an open request on an application that was archived meanwhile cannot be answered', async () => {
    const t = await team();
    const a = await apply(t);
    await sendForScreening(t.recruiter, { applicationIds: [a.applicationId], reviewerUserIds: [t.hm1.userId] });
    const q = await requestOf(a.applicationId, t.hm1.userId);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(t.recruiter, a.applicationId, reason.id);
    // The archive closed the request by itself (D-042), so the answer finds it closed.
    expect((await owner.db.execute(sql`select closed_reason from recruitment_screening_request where id = ${q}::uuid`))[0]).toEqual({ closed_reason: 'application_closed' });
    expect(await code(answerScreening(t.hm1, q, { result: 'advance' }))).toBe('screening_closed');
    expect(await code(insertAnswer(t.hm1, q, t.hm1.userId))).toBe('23514');
    expect(await myScreeningRequests(t.hm1)).toEqual([]);
  });
});

describe('open requests close by themselves (D-042)', () => {
  it('when the application is archived (by a hiring manager too) or hired, and when the reviewer leaves the job\'s hiring managers', async () => {
    const t = await team();
    const t2 = await team('Fictional other role');
    const [byManager, hired, kept] = [await apply(t), await apply(t), await apply(t)];
    await sendForScreening(t.recruiter, { applicationIds: [byManager.applicationId, hired.applicationId, kept.applicationId] });
    await answerScreening(t.hm2, await requestOf(byManager.applicationId, t.hm2.userId), { result: 'pending' });
    // A hiring manager rejects: every open request on that application closes in the same transaction, theirs and the other
    // reviewer's (which they could not update themselves), recording who archived it.
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(t.hm1, byManager.applicationId, reason.id);
    const closed = await owner.db.execute<{ reviewer_user_id: string; closed_reason: string; closed_by_user_id: string; tx: string }>(sql`
      select reviewer_user_id, closed_reason, closed_by_user_id, xmin::text as tx from recruitment_screening_request where application_id = ${byManager.applicationId}::uuid order by reviewer_user_id`);
    expect(closed.map((r) => [r.reviewer_user_id, r.closed_reason, r.closed_by_user_id]).sort()).toEqual(
      [[t.hm1.userId, 'application_closed', t.hm1.userId], [t.hm2.userId, 'application_closed', t.hm1.userId]].sort());
    const [appTx] = await owner.db.execute<{ tx: string }>(sql`select xmin::text as tx from recruitment_application where id = ${byManager.applicationId}::uuid`);
    expect(new Set(closed.map((r) => r.tx))).toEqual(new Set([appTx.tx]));
    // Hired.
    const stages = await stagesOf(t.jobId);
    await moveApplication(t.recruiter, hired.applicationId, stages[stages.length - 1].id);
    await moveApplication(t.recruiter, hired.applicationId);
    expect((await owner.db.execute<{ r: string }>(sql`select distinct closed_reason as r from recruitment_screening_request where application_id = ${hired.applicationId}::uuid`)).map((x) => x.r)).toEqual(['application_closed']);
    // The kept application's requests are still open; t2's job is untouched by hm2 leaving t's job.
    const other = await apply(t2);
    await addJobMember(admin, t2.jobId, 'hiring_manager', t.hm2.userId);
    await sendForScreening(t2.recruiter, { applicationIds: [other.applicationId], reviewerUserIds: [t.hm2.userId] });
    expect((await myScreeningRequests(t.hm2)).map((r) => r.applicationId).sort()).toEqual([kept.applicationId, other.applicationId].sort());
    await removeJobMember(admin, t.jobId, await memberRow(t.jobId, t.hm2.userId));
    expect((await owner.db.execute(sql`select closed_reason, closed_by_user_id from recruitment_screening_request
      where application_id = ${kept.applicationId}::uuid and reviewer_user_id = ${t.hm2.userId}::uuid`))).toEqual([{ closed_reason: 'reviewer_removed', closed_by_user_id: base.adminUserId }]);
    expect((await owner.db.execute(sql`select closed_at from recruitment_screening_request where application_id = ${kept.applicationId}::uuid
      and reviewer_user_id = ${t.hm1.userId}::uuid`))[0]).toEqual({ closed_at: null });
    expect((await myScreeningRequests(t.hm2)).map((r) => r.applicationId)).toEqual([other.applicationId]);
    expect((await recruitmentTodos(t.hm2, undefined)).filter((i) => i.kind === 'screening').map((i) => i.jobId)).toEqual([t2.jobId]);
    expect((await recruitmentViewer(t.hm2, [base.companyId])).pendingScreening).toBe(1);
    // A role change (owner-level; the app role has no UPDATE on memberships) closes too.
    await owner.db.execute(sql`update recruitment_job_member set member_role = 'interviewer' where id = ${await memberRow(t2.jobId, t.hm2.userId)}::uuid`);
    expect((await owner.db.execute(sql`select closed_reason from recruitment_screening_request where application_id = ${other.applicationId}::uuid`))).toEqual([{ closed_reason: 'reviewer_removed' }]);
    expect(await recruitmentTodos(t.hm2, undefined)).toEqual([]);
    expect((await recruitmentViewer(t.hm2, [base.companyId])).pendingScreening).toBe(0);
    // Nobody can use the automatic reasons directly, setting or no setting.
    const open = await requestOf(kept.applicationId, t.hm1.userId);
    for (const reasonCode of ['application_closed', 'reviewer_removed']) {
      for (const who of [t.recruiter, admin, t.hm1] as SessionContext[]) {
        expect(await code(withTenant(who, async (tx) => {
          await tx.execute(sql`select set_config('app.recruitment_screening_closing', ${reasonCode === 'application_closed' ? `application:${kept.applicationId}` : `reviewer:${t.jobId}:${t.hm1.userId}`}, true)`);
          return tx.execute(sql`update recruitment_screening_request set closed_at = now(), closed_reason = ${reasonCode}, closed_by_user_id = ${who.userId}::uuid where id = ${open}::uuid`);
        }))).toBe('42501');
      }
    }
    expect((await owner.db.execute(sql`select closed_at from recruitment_screening_request where id = ${open}::uuid`))[0]).toEqual({ closed_at: null });
  });
});

describe('the read paths write nothing', () => {
  it('the reviewer choice and the Screening section work inside READ ONLY transactions and take no transaction id', async () => {
    const t = await team();
    const a = await apply(t);
    await sendForScreening(t.recruiter, { applicationIds: [a.applicationId], reviewerUserIds: [t.hm1.userId] });
    for (const readOnly of [true, false]) {
      const out = await withTenant(t.recruiter, async (tx) => {
        if (!readOnly) await tx.execute(sql`set transaction read only`);
        const options = await screeningSendOptionsTx(tx, t.recruiter, t.jobId);
        const section = await applicationScreeningTx(tx, t.recruiter, a.applicationId);
        const direct = await tx.execute<{ app_user_id: string }>(sql`select app_user_id from app.recruitment_job_hiring_managers(${t.jobId}::uuid)`);
        const [xid] = await tx.execute<{ x: string | null }>(sql`select pg_current_xact_id_if_assigned()::text as x`);
        const [mode] = await tx.execute<{ ro: string }>(sql`select current_setting('transaction_read_only') as ro`);
        return { options, section, direct: direct.map((r) => r.app_user_id), xid: xid.x, ro: mode.ro };
      }, readOnly ? { readOnlySnapshot: true } : undefined);
      expect(out.ro).toBe('on');
      expect(out.xid).toBeNull();
      expect(out.options.reviewers?.map((r) => r.id)).toEqual([t.hm1.userId, t.hm2.userId]);
      expect(out.direct).toEqual([t.hm1.userId, t.hm2.userId]);
      expect(out.section.reviewers?.map((r) => [r.id, r.asked])).toEqual([[t.hm1.userId, true], [t.hm2.userId, false]]);
      expect(out.section.requests).toHaveLength(1);
    }
    // The setting the definer uses opens nothing to the app role itself.
    const seen = await withTenant(t.recruiter, async (tx) => {
      await tx.execute(sql`select set_config('app.recruitment_screening_job', ${t.jobId}, true)`);
      return tx.execute<{ app_user_id: string }>(sql`select app_user_id from recruitment_job_member where job_id = ${t.jobId}::uuid`);
    });
    expect(seen.map((r) => r.app_user_id)).toEqual([t.recruiter.userId]);
  });
});

/** The assignment status from the owner's rows, by D-042 written out again (microsecond times as text sort): an open request →
 *  awaiting; else the latest final answer (Advance or Reject) → positive or negative; else not_assigned. */
async function expectedStatuses(applicationIds: string[]): Promise<Record<string, AssignmentStatus>> {
  const req = await owner.db.execute<{ application_id: string; open: boolean }>(sql`select application_id, closed_at is null as open from recruitment_screening_request
    where application_id = any(${`{${applicationIds.join(',')}}`}::uuid[])`);
  const ans = await owner.db.execute<{ application_id: string; result: string; at: string; id: string }>(sql`select application_id, result,
    to_char(answered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as at, id::text from recruitment_screening_answer where application_id = any(${`{${applicationIds.join(',')}}`}::uuid[])`);
  const out: Record<string, AssignmentStatus> = {};
  for (const id of applicationIds) {
    const finals = ans.filter((x) => x.application_id === id && x.result !== 'pending')
      .sort((x, y) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1));
    out[id] = req.some((x) => x.application_id === id && x.open) ? 'awaiting'
      : finals[0] ? (finals[0].result === 'advance' ? 'positive' : 'negative') : 'not_assigned';
  }
  return out;
}

describe('case 77 — assignment status (D-042) and per-stage filter counts, with several reviewers', () => {
  it('match an independent computation for every application and every filter, including withdrawn, reassigned and auto-closed', async () => {
    const t = await team();
    const hm3 = await login('Fictional Manager Three');
    await addJobMember(admin, t.jobId, 'hiring_manager', hm3.userId);
    const KEYS = ['none', 'open', 'pending', 'advance', 'reject', 'advThenRej', 'rejThenPending', 'finalPlusOpen', 'withdrawn', 'pendingThenWithdrawn',
      'reassignedAfterFinal', 'reassignedAnswered', 'autoClosed', 'autoClosedAfterFinal'] as const;
    const s = Object.fromEntries(await Promise.all(KEYS.map(async (k) => [k, (await apply(t, `Fictional ${k}`)).applicationId] as const))) as Record<(typeof KEYS)[number], string>;
    const send = (k: keyof typeof s, reviewers: Login[]) => sendForScreening(t.recruiter, { applicationIds: [s[k]], reviewerUserIds: reviewers.map((r) => r.userId) });
    const ans = async (k: keyof typeof s, hm: Login, result: 'advance' | 'reject' | 'pending') => answerScreening(hm, await requestOf(s[k], hm.userId), { result });
    await send('open', [t.hm1]);
    await send('pending', [t.hm1]); await ans('pending', t.hm1, 'pending');
    await send('advance', [t.hm1]); await ans('advance', t.hm1, 'advance');
    await send('reject', [t.hm2]); await ans('reject', t.hm2, 'reject');
    await send('advThenRej', [t.hm1, t.hm2]); await ans('advThenRej', t.hm1, 'advance'); await ans('advThenRej', t.hm2, 'reject');
    await send('rejThenPending', [t.hm1, t.hm2]); await ans('rejThenPending', t.hm2, 'reject'); await ans('rejThenPending', t.hm1, 'pending');
    await send('finalPlusOpen', [t.hm1, t.hm2]); await ans('finalPlusOpen', t.hm1, 'advance');
    await send('withdrawn', [t.hm1, t.hm2]);
    for (const hm of [t.hm1, t.hm2]) await withdrawScreening(t.recruiter, await requestOf(s.withdrawn, hm.userId));
    await send('pendingThenWithdrawn', [t.hm1]); await ans('pendingThenWithdrawn', t.hm1, 'pending');
    await withdrawScreening(t.assistant, await requestOf(s.pendingThenWithdrawn, t.hm1.userId));
    await send('reassignedAfterFinal', [t.hm1]); await ans('reassignedAfterFinal', t.hm1, 'advance');
    await reassignScreening(t.recruiter, { applicationId: s.reassignedAfterFinal, reviewerUserIds: [t.hm2.userId] });
    await send('reassignedAnswered', [t.hm1]); await ans('reassignedAnswered', t.hm1, 'reject');
    await reassignScreening(t.recruiter, { applicationId: s.reassignedAnswered, reviewerUserIds: [t.hm2.userId] }); await ans('reassignedAnswered', t.hm2, 'advance');
    await send('autoClosed', [hm3]);
    await send('autoClosedAfterFinal', [t.hm1, hm3]); await ans('autoClosedAfterFinal', t.hm1, 'advance');
    // hm3 leaves the job's hiring managers: their open requests close by themselves.
    await removeJobMember(admin, t.jobId, (await owner.db.execute<{ id: string }>(sql`select id from recruitment_job_member where job_id = ${t.jobId}::uuid
      and app_user_id = ${hm3.userId}::uuid and member_role = 'hiring_manager'`))[0].id);
    expect((await owner.db.execute<{ closed_reason: string }>(sql`select closed_reason from recruitment_screening_request where reviewer_user_id = ${hm3.userId}::uuid`))
      .map((r) => r.closed_reason)).toEqual(['reviewer_removed', 'reviewer_removed']);
    // Two more in the NEXT stage, to show the counts belong to the selected stage only.
    const stages = await stagesOf(t.jobId);
    const [m1, m2] = [await apply(t), await apply(t)];
    await sendForScreening(t.recruiter, { applicationIds: [m1.applicationId, m2.applicationId], reviewerUserIds: [t.hm1.userId], move: true });
    await answerScreening(t.hm1, await requestOf(m1.applicationId, t.hm1.userId), { result: 'advance' });

    const ids = Object.values(s);
    const expected = await expectedStatuses(ids);
    expect(expected).toEqual({
      [s.none]: 'not_assigned', [s.open]: 'awaiting', [s.pending]: 'awaiting', [s.advance]: 'positive', [s.reject]: 'negative', [s.advThenRej]: 'negative',
      [s.rejThenPending]: 'awaiting', [s.finalPlusOpen]: 'awaiting', [s.withdrawn]: 'not_assigned', [s.pendingThenWithdrawn]: 'not_assigned',
      [s.reassignedAfterFinal]: 'awaiting', [s.reassignedAnswered]: 'positive', [s.autoClosed]: 'not_assigned', [s.autoClosedAfterFinal]: 'positive',
    });
    const tally = (list: string[], e: Record<string, AssignmentStatus>) => ({ not_assigned: 0, awaiting: 0, positive: 0, negative: 0,
      ...list.reduce<Record<string, number>>((acc, id) => ({ ...acc, [e[id]]: (acc[e[id]] ?? 0) + 1 }), {}) });
    for (const who of [t.recruiter, t.assistant, admin]) {
      const board = await candidateBoard(who, [base.companyId], { jobId: t.jobId, tab: stages[0].id });
      expect(board.cards.map((c) => c.id).sort()).toEqual([...ids].sort());
      expect(Object.fromEntries(board.cards.map((c) => [c.id, c.screeningStatus]))).toEqual(expected);
      expect(board.screening).toEqual({ counts: tally(ids, expected), filter: null, capped: false });
      for (const status of ['not_assigned', 'awaiting', 'positive', 'negative'] as const) {
        const filtered = await candidateBoard(who, [base.companyId], { jobId: t.jobId, tab: stages[0].id, screening: status });
        const want = ids.filter((id) => expected[id] === status).sort();
        expect(want.length, status).toBeGreaterThan(0);
        expect(filtered.cards.map((c) => c.id).sort(), status).toEqual(want);
        expect(filtered.screening?.filter).toBe(status);
      }
      const next = await candidateBoard(who, [base.companyId], { jobId: t.jobId, tab: stages[1].id });
      const nextExpected = await expectedStatuses([m1.applicationId, m2.applicationId]);
      expect(nextExpected).toEqual({ [m1.applicationId]: 'positive', [m2.applicationId]: 'awaiting' });
      expect(next.screening?.counts).toEqual(tally([m1.applicationId, m2.applicationId], nextExpected));
      // Hired and Archived carry no screening status, counts or filter (the filter is ignored there).
      for (const tab of ['hired', 'archived']) {
        const closedTab = await candidateBoard(who, [base.companyId], { jobId: t.jobId, tab, screening: 'positive' });
        expect(closedTab.screening).toBeNull();
        expect(closedTab.cards.every((c) => c.screeningStatus === null)).toBe(true);
      }
    }
    for (const k of ['advThenRej', 'finalPlusOpen', 'reassignedAfterFinal', 'autoClosedAfterFinal'] as const) {
      expect((await applicationScreening(t.recruiter, s[k])).status, k).toBe(expected[s[k]]);
    }
    // A hiring manager sees no status or filter on the board (they do not see every request).
    const hmBoard = await candidateBoard(t.hm1, [base.companyId], { jobId: t.jobId, tab: stages[0].id, screening: 'positive' });
    expect(hmBoard.screening).toBeNull();
    expect(hmBoard.cards.every((c) => c.screeningStatus === null)).toBe(true);
    expect((await applicationScreening(t.hm1, s.advance)).status).toBeNull();
  });

  it('a large stage is counted and filtered over its most recent window only, through indexes', async () => {
    const t = await team();
    const stage = (await stagesOf(t.jobId))[0].id;
    // 3,000 active applications in the first stage (owner, past the guards), every third with an open request, every fifth
    // answered Advance.
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_candidate (id, tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Bulk ' || g,
          ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid from generate_series(1, 3000) g`;
      await tx`insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, applied_at, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid,
          ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${stage}::uuid, now() - (g || ' minutes')::interval, ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid
        from generate_series(1, 3000) g`;
      await tx`insert into recruitment_screening_request (id, tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id)
        select ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid,
          ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, ${t.hm1.userId}::uuid, ${t.recruiter.userId}::uuid from generate_series(3, 3000, 3) g`;
      await tx`update recruitment_screening_request set closed_at = now(), closed_reason = 'answered', closed_by_user_id = ${t.hm1.userId}::uuid
        where id in (select ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid from generate_series(15, 3000, 15) g)`;
      await tx`insert into recruitment_screening_answer (tenant_id, company_id, job_id, application_id, request_id, result, answered_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid,
          ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'advance', ${t.hm1.userId}::uuid from generate_series(15, 3000, 15) g`;
      for (const x of ['recruitment_application', 'recruitment_screening_request', 'recruitment_screening_answer']) await tx.unsafe(`analyze ${x}`);
    });
    // Independently: the window is the 500 most recent (g = 1..500); in it, g % 15 = 0 → positive, other g % 3 = 0 → awaiting.
    const g = Array.from({ length: 500 }, (_, i) => i + 1);
    const want = { not_assigned: g.filter((n) => n % 3 !== 0).length, awaiting: g.filter((n) => n % 3 === 0 && n % 15 !== 0).length,
      positive: g.filter((n) => n % 15 === 0).length, negative: 0 };
    await candidateBoard(t.recruiter, [base.companyId], { jobId: t.jobId, tab: stage });
    const started = performance.now();
    const board = await candidateBoard(t.recruiter, [base.companyId], { jobId: t.jobId, tab: stage });
    const boardMs = performance.now() - started;
    expect(board.screening).toEqual({ counts: want, filter: null, capped: true });
    const f0 = performance.now();
    const positive = await candidateBoard(t.recruiter, [base.companyId], { jobId: t.jobId, tab: stage, screening: 'positive' });
    const filterMs = performance.now() - f0;
    expect(positive.cards.map((c) => c.id).sort()).toEqual(g.filter((n) => n % 15 === 0).map((n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`).sort());
    const plan = await withTenant(t.recruiter, async (tx) => (await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, buffers off, timing off, summary on)
      select a.id, (case when (select 1 from recruitment_screening_request q where q.application_id = a.id and q.closed_at is null limit 1) is not null then 'awaiting'
        else coalesce((select case x.result when 'advance' then 'positive' else 'negative' end from recruitment_screening_answer x
          where x.application_id = a.id and x.result in ('advance', 'reject') order by x.answered_at desc, x.id desc limit 1), 'not_assigned') end) as status
      from recruitment_application a where a.id in (select a2.id from recruitment_application a2 where a2.tenant_id = ${base.tenantId}::uuid
        and a2.company_id = ${base.companyId}::uuid and a2.job_id = ${t.jobId}::uuid and a2.state = 'active' and a2.current_stage_id = ${stage}::uuid
        order by a2.applied_at desc, a2.id limit 500)`)).map((r) => r['QUERY PLAN']).join('\n'));
    // The same stage for its hiring manager (who gets no screening read) shows what the board costs without it.
    await candidateBoard(t.hm1, [base.companyId], { jobId: t.jobId, tab: stage });
    const b0 = performance.now();
    const hmBoard = await candidateBoard(t.hm1, [base.companyId], { jobId: t.jobId, tab: stage });
    const baseMs = performance.now() - b0;
    expect(hmBoard.screening).toBeNull();
    report(`board with a 3,000-application stage: ${boardMs.toFixed(1)} ms; filtered: ${filterMs.toFixed(1)} ms; same stage for its hiring manager (no screening read): ${baseMs.toFixed(1)} ms\n${plan}`);
    // One index probe per application of the window for open requests and for the latest final answer; nothing scans a table.
    expect(plan).toMatch(/Index (Only )?Scan using recruitment_screening_request_(open_uq|application_idx)/);
    expect(plan).toMatch(/Index Scan using recruitment_screening_answer_application_idx/);
    expect(plan).not.toMatch(/Seq Scan on recruitment_screening|Bitmap Heap Scan on recruitment_screening_request/);
  });
});

describe('case 78 — who sees screening', () => {
  it('operators see everything on the job; a reviewer their own requests and the answers; nobody else anything', async () => {
    const t = await team();
    const t2 = await team('Fictional other role');
    const hm3 = await login('Fictional Manager Three');
    await addJobMember(admin, t.jobId, 'hiring_manager', hm3.userId);
    const a = await apply(t);
    const o = await apply(t2);
    await sendForScreening(t.recruiter, { applicationIds: [a.applicationId], reviewerUserIds: [t.hm1.userId, t.hm2.userId], note: `${SENTINEL} visible note` });
    await sendForScreening(t2.recruiter, { applicationIds: [o.applicationId] });
    const q1 = await requestOf(a.applicationId, t.hm1.userId);
    const q2 = await requestOf(a.applicationId, t.hm2.userId);
    const x1 = await answerScreening(t.hm1, q1, { result: 'advance', comment: `${SENTINEL} hm1 comment` });
    const x2 = await answerScreening(t.hm2, q2, { result: 'pending', comment: `${SENTINEL} hm2 comment` });
    // Operators and administrators: every request and answer on the job (service and table).
    for (const who of [t.recruiter, t.assistant, admin]) {
      const view = await applicationScreening(who, a.applicationId);
      expect(view.canOperate).toBe(true);
      expect(view.requests.map((r) => r.id).sort()).toEqual([q1, q2].sort());
      expect(view.requests.flatMap((r) => r.answers.map((x) => x.id)).sort()).toEqual([x1.answerId, x2.answerId].sort());
      expect(view.otherAnswers).toEqual([]);
      expect((await rows(who, sql`select id from recruitment_screening_request where job_id = ${t.jobId}::uuid`)).map((r) => r.id).sort()).toEqual([q1, q2].sort());
      expect((await rows(who, sql`select id from recruitment_screening_answer where job_id = ${t.jobId}::uuid`)).map((r) => r.id).sort()).toEqual([x1.answerId, x2.answerId].sort());
    }
    // hm1: their own request (with its note), and hm2's answer among the others.
    const v1 = await applicationScreening(t.hm1, a.applicationId);
    expect(v1.canOperate).toBe(false);
    expect(v1.requests.map((r) => [r.id, r.note])).toEqual([[q1, `${SENTINEL} visible note`]]);
    expect(v1.otherAnswers.map((x) => x.id)).toEqual([x2.answerId]);
    expect(v1.reviewers).toEqual([]);
    expect((await rows(t.hm1, sql`select id from recruitment_screening_request`)).map((r) => r.id)).toEqual([q1]);
    expect((await rows(t.hm1, sql`select id from recruitment_screening_answer`)).map((r) => r.id).sort()).toEqual([x1.answerId, x2.answerId].sort());
    // hm3 (a hiring manager of the job without a request): no request, the answers like scorecards.
    const v3 = await applicationScreening(hm3, a.applicationId);
    expect(v3.requests).toEqual([]);
    expect(v3.otherAnswers.map((x) => x.id).sort()).toEqual([x1.answerId, x2.answerId].sort());
    expect(await rows(hm3, sql`select id from recruitment_screening_request`)).toEqual([]);
    // Nobody else: the interviewer, an offer approver, the other job's team, another company's administrator, another tenant.
    const approver = await login('Fictional Offer Approver');
    await saveApprovalFlow(admin, base.companyId, 'offer', [approver.userId]);
    const fields = (await offerSettings(admin, base.companyId)).fields;
    const f = (label: string) => fields.find((x) => x.label === label)!.id;
    const stages = await stagesOf(t.jobId);
    const offerApp = await apply(t);
    await moveApplication(t.recruiter, offerApp.applicationId, stages.find((x) => x.name === 'Offer')!.id);
    const { id: offerId } = await saveOffer(t.recruiter, offerApp.applicationId, {
      [f('Job offered')]: { text: 'Fictional analyst' }, [f('Department')]: { text: 'Finance' }, [f('Commencement date')]: { text: '2026-12-01' },
      [f('Basic salary')]: { amount: '1000.00', currency: 'MYR' },
    });
    expect(await submitOffer(t.recruiter, offerId)).toBe('pending');
    await sendForScreening(t.recruiter, { applicationIds: [offerApp.applicationId], reviewerUserIds: [t.hm1.userId] });
    const partner = await login('Fictional Other Partner', otherCompanyId);
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: partner.userId, companyId: otherCompanyId, role: 'recruiting_partner' });
    const otherPartner = { ...partner, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: otherCompanyId }] };
    const otherTenant = await seedBase();
    await setModule(otherTenant.tenantId, 'recruitment', 'active');
    const otherTenantAdmin = { ...(await entitledCtx(otherTenant)), grants: [{ role: 'hr_admin', companyId: null }] };
    const bystander = await login('Fictional Bystander');
    for (const who of [t.interviewer, approver, t2.recruiter, t2.hm1, otherPartner, bystander, otherTenantAdmin] as SessionContext[]) {
      for (const app of [a.applicationId, offerApp.applicationId]) expect(await code(applicationScreening(who, app))).toMatch(/forbidden|not_found/);
      // (t2's hiring manager has their own job's request: none of this job's.)
      expect((await myScreeningRequests(who)).filter((r) => r.jobId === t.jobId)).toEqual([]);
      const seenReq = await rows(who, sql`select id, note from recruitment_screening_request where job_id = ${t.jobId}::uuid`);
      const seenAns = await rows(who, sql`select id, comment from recruitment_screening_answer where job_id = ${t.jobId}::uuid`);
      expect(seenReq, String(who.userId)).toEqual([]);
      expect(seenAns, String(who.userId)).toEqual([]);
    }
    // The other job's team sees its own job's request only.
    expect((await rows(t2.recruiter, sql`select application_id from recruitment_screening_request`)).map((r) => r.application_id)).toEqual(
      [o.applicationId, o.applicationId]);
  });
});

describe('case 79 — the reviewer\'s to-do and the recruiter\'s update', () => {
  it('the to-do follows the open request; the update arrives with the answer; neither carries the note or comment', async () => {
    const t = await team();
    const [a1, a2] = [await apply(t, 'Fictional Todo One'), await apply(t, 'Fictional Todo Two')];
    await sendForScreening(t.recruiter, { applicationIds: [a1.applicationId, a2.applicationId], reviewerUserIds: [t.hm1.userId], note: `${SENTINEL} note` });
    const q1 = await requestOf(a1.applicationId, t.hm1.userId);
    const q2 = await requestOf(a2.applicationId, t.hm1.userId);
    const screening = async (ctx: SessionContext) => (await recruitmentTodos(ctx, undefined)).filter((i) => i.kind === 'screening');
    expect((await screening(t.hm1)).map((i) => [i.id, i.candidateName, i.href]).sort()).toEqual([
      [q1, 'Fictional Todo One', `/recruitment/screening#request-${q1}`], [q2, 'Fictional Todo Two', `/recruitment/screening#request-${q2}`],
    ].sort());
    for (const who of [t.hm2, t.recruiter, t.assistant, admin, t.interviewer]) expect(await screening(who)).toEqual([]);
    const bell = await pendingRecruitmentTasks(t.hm1, undefined);
    expect(bell.filter((b) => b.kind === 'recruitmentScreening').map((b) => b.id).sort()).toEqual([`screening:${q1}`, `screening:${q2}`].sort());
    expect((await myScreeningRequests(t.hm1)).map((r) => r.requestId).sort()).toEqual([q1, q2].sort());
    expect((await recruitmentViewer(t.hm1, [base.companyId])).pendingScreening).toBe(2);
    // Pending keeps it; Advance removes it; the recruiter and assistant get one update per answer, without the comment.
    const p = await answerScreening(t.hm1, q1, { result: 'pending', comment: `${SENTINEL} comment one` });
    expect((await screening(t.hm1)).map((i) => i.id).sort()).toEqual([q1, q2].sort());
    const f = await answerScreening(t.hm1, q1, { result: 'advance', comment: `${SENTINEL} comment two` });
    expect((await screening(t.hm1)).map((i) => i.id)).toEqual([q2]);
    for (const who of [t.recruiter, t.assistant]) {
      const updates = (await recruitmentUpdates(who, { companyIds: [base.companyId], category: 'applications' })).items.filter((u) => u.kind === 'screeningFeedback');
      expect(updates.map((u) => [u.id, u.href, u.candidateName]).sort()).toEqual([
        [p.answerId, `/recruitment/applications/${a1.applicationId}`, 'Fictional Todo One'], [f.answerId, `/recruitment/applications/${a1.applicationId}`, 'Fictional Todo One'],
      ].sort());
      expect(JSON.stringify(updates)).not.toContain(SENTINEL);
    }
    // Not for the hiring managers or an administrator who is not on the job's team.
    for (const who of [t.hm1, t.hm2, admin]) {
      expect((await recruitmentUpdates(who, { companyIds: [base.companyId], category: 'applications' })).items.filter((u) => u.kind === 'screeningFeedback')).toEqual([]);
    }
    // Withdrawn: gone.
    await withdrawScreening(t.recruiter, q2);
    expect(await screening(t.hm1)).toEqual([]);
    expect((await pendingRecruitmentTasks(t.hm1, undefined)).filter((b) => b.kind === 'recruitmentScreening')).toEqual([]);
    expect((await recruitmentViewer(t.hm1, [base.companyId])).pendingScreening).toBe(0);
    // Nothing the to-do path or the bell returned carried a note or a comment.
    expect(JSON.stringify([bell, await recruitmentTodos(t.hm1, undefined)])).not.toContain(SENTINEL);
  });

  it('the bell stays within its budget with many open requests and many closed by themselves (through the reviewer\'s own index)', async () => {
    const t = await team();
    const stage = (await stagesOf(t.jobId))[0].id;
    // Volume through the owner (past the guards): 680 applications; hm1 asked on all of them; 3,000 open requests of 25 other
    // reviewers; then 620 of hm1's applications are archived for real (the 5711 trigger closes their requests).
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_candidate (id, tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Bulk ' || g,
          ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid from generate_series(1, 680) g`;
      await tx`insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid,
          ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${stage}::uuid, ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid from generate_series(1, 680) g`;
      await tx`insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, ${t.hm1.userId}::uuid,
          ${t.recruiter.userId}::uuid from generate_series(1, 680) g`;
      await tx`insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ('00000000-0000-4000-9000-' || lpad((1 + g % 120)::text, 12, '0'))::uuid,
          ('00000000-0000-4000-a000-' || lpad((g / 120)::text, 12, '0'))::uuid, ${t.recruiter.userId}::uuid from generate_series(0, 2999) g`;
    });
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await owner.client.begin(async (tx) => {
      // Not replica: the application guard and the 5711 closing trigger run, as for an archive through the service.
      await tx`update recruitment_application set state = 'archived', archive_reason_id = ${reason.id}::uuid, stage_left_at_archive = current_stage_id
        where id in (select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid from generate_series(61, 680) g)`;
      await tx`analyze recruitment_screening_request`;
      await tx`analyze recruitment_application`;
    });
    expect((await owner.db.execute<{ r: string | null; n: number }>(sql`select closed_reason as r, count(*)::int as n from recruitment_screening_request
      where reviewer_user_id = ${t.hm1.userId}::uuid group by 1 order by 1 nulls first`))).toEqual([{ r: null, n: 60 }, { r: 'application_closed', n: 620 }]);
    expect((await recruitmentViewer(t.hm1, [base.companyId])).pendingScreening).toBe(60);
    expect(await myScreeningRequests(t.hm1)).toHaveLength(60);
    const time = async (ctx: SessionContext) => {
      await pendingRecruitmentTasks(ctx, undefined);
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        await pendingRecruitmentTasks(ctx, undefined);
        runs.push(performance.now() - started);
      }
      return runs.sort((x, y) => x - y)[2];
    };
    const [hmMs, hm2Ms, recruiterMs, adminMs] = [await time(t.hm1), await time(t.hm2), await time(t.recruiter), await time(admin)];
    report(`bell median ms — hiring manager with 60 open and 620 closed-by-archive requests, among 3,680: ${hmMs.toFixed(1)}; hiring manager with none: ${hm2Ms.toFixed(1)}; recruiter: ${recruiterMs.toFixed(1)}; administrator: ${adminMs.toFixed(1)}`);
    expect((await pendingRecruitmentTasks(t.hm1, undefined)).filter((b) => b.kind === 'recruitmentScreening')).toHaveLength(50);
    for (const ms of [hmMs, hm2Ms, recruiterMs, adminMs]) expect(ms).toBeLessThan(BELL_TIMEOUT_MS);
    // The plan starts from the reviewer's own requests (a reviewer index), never from the tenant's or the job's.
    const plan = await withTenant(t.hm1, async (tx) => {
      const out = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain select q.id from recruitment_screening_request q
        where q.tenant_id = ${base.tenantId}::uuid and q.reviewer_user_id = ${t.hm1.userId}::uuid and q.closed_at is null order by q.sent_at desc limit 50`);
      return out.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/Index (Only )?Scan using recruitment_screening_request_reviewer(_open)?_idx/);
    expect(plan).not.toMatch(/Seq Scan on recruitment_screening_request/);
  });
});

describe('case 80 — removal, company deletion, row security and grants, the AI Centre read', () => {
  it('removal clears screening notes and comments and nothing else of screening; no sentinel remains anywhere', async () => {
    const t = await team();
    const a = await apply(t, `${SENTINEL} Person`);
    await sendForScreening(t.recruiter, { applicationIds: [a.applicationId], note: `${SENTINEL} note` });
    const q1 = await requestOf(a.applicationId, t.hm1.userId);
    const q2 = await requestOf(a.applicationId, t.hm2.userId);
    await answerScreening(t.hm1, q1, { result: 'pending', comment: `${SENTINEL} first` });
    await answerScreening(t.hm1, q1, { result: 'advance', comment: `${SENTINEL} second` });
    await answerScreening(t.hm2, q2, { result: 'reject' });
    // Another candidate's screening stays untouched.
    const keep = await apply(t, 'Fictional Kept Person');
    await sendForScreening(t.recruiter, { applicationIds: [keep.applicationId], reviewerUserIds: [t.hm1.userId], note: 'Fictional kept note' });
    await answerScreening(t.hm1, await requestOf(keep.applicationId, t.hm1.userId), { result: 'pending', comment: 'Fictional kept comment' });
    const shape = async (applicationId: string) => ({
      requests: await owner.db.execute(sql`select id, reviewer_user_id, sent_by_user_id, sent_at, closed_at, closed_reason, closed_by_user_id from recruitment_screening_request
        where application_id = ${applicationId}::uuid order by id`),
      answers: await owner.db.execute(sql`select id, request_id, result, answered_at, answered_by_user_id from recruitment_screening_answer where application_id = ${applicationId}::uuid order by id`),
    });
    const before = await shape(a.applicationId);
    expect(before.requests).toHaveLength(2);
    expect(before.answers).toHaveLength(3);
    await rejectAndAge(a.applicationId);
    expect(await destroyCandidates(admin, base.companyId, [a.candidateId], 'on')).toEqual({ removed: 1 });
    expect(await shape(a.applicationId)).toEqual(before);
    expect(await owner.db.execute(sql`select 1 from recruitment_screening_request where application_id = ${a.applicationId}::uuid and note is not null`)).toHaveLength(0);
    expect(await owner.db.execute(sql`select 1 from recruitment_screening_answer where application_id = ${a.applicationId}::uuid and comment is not null`)).toHaveLength(0);
    expect((await owner.db.execute<{ note: string }>(sql`select note from recruitment_screening_request where application_id = ${keep.applicationId}::uuid`))[0].note).toBe('Fictional kept note');
    expect((await owner.db.execute<{ comment: string }>(sql`select comment from recruitment_screening_answer where application_id = ${keep.applicationId}::uuid`))[0].comment).toBe('Fictional kept comment');
    const [event] = await owner.db.execute<{ payload: Record<string, number> }>(sql`
      select payload from domain_event where event_type = 'recruitment-candidate.personal-data-removed' and aggregate_id = ${a.candidateId}::uuid`);
    expect(event.payload).toMatchObject({ screeningNotes: 2, screeningComments: 2 });
    const tables = await owner.db.execute<{ relname: string }>(sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by c.relname`);
    expect(tables.map((x) => x.relname)).toEqual(expect.arrayContaining(NEW_TABLES));
    for (const { relname } of tables) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(relname)} r where to_jsonb(r.*)::text ilike ${`%${SENTINEL}%`}`);
      expect(hit.n, `${relname} still holds personal data`).toBe(0);
    }
    const events = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where payload::text ilike ${`%${SENTINEL}%`}`);
    expect(events[0].n).toBe(0);
    // Outside the removal, nobody can clear a note or comment directly (no update path for an answer; a request's note is fixed).
    expect(await code(rows(admin, sql`update recruitment_screening_answer set comment = null where application_id = ${keep.applicationId}::uuid`))).toBe('42501');
    expect(await code(rows(admin, sql`update recruitment_screening_request set note = null where application_id = ${keep.applicationId}::uuid`))).toBe('23514');
  });

  it('every new table forces row security, grants to the app role only, the definers pin their search path; the AI Centre read is counts only', async () => {
    const meta = await owner.db.execute<{ relname: string; forced: boolean; enabled: boolean; app: string | null; public_grants: number }>(sql`
      select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
        (select string_agg(a.privilege_type, ',' order by a.privilege_type) from aclexplode(c.relacl) a where a.grantee = 'ai_hr_app'::regrole) as app,
        (select count(*)::int from aclexplode(c.relacl) a where a.grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${NEW_TABLES.join(',')}}`}::text[]) order by c.relname`);
    expect(meta).toEqual([
      { relname: 'recruitment_screening_answer', forced: true, enabled: true, app: 'INSERT,SELECT', public_grants: 0 },
      { relname: 'recruitment_screening_request', forced: true, enabled: true, app: 'INSERT,SELECT,UPDATE', public_grants: 0 },
    ]);
    // No private marker table any more (the lookup writes nothing).
    expect(await owner.db.execute(sql`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relname = 'recruitment_screening_context'`)).toHaveLength(0);
    const fns = await owner.db.execute<{ proname: string; secdef: boolean; config: string[] | null; public_exec: boolean; volatility: string }>(sql`
      select p.proname, p.prosecdef as secdef, p.proconfig as config, has_function_privilege('public', p.oid, 'execute') as public_exec, p.provolatile::text as volatility
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname in ('recruitment_job_hiring_managers', 'recruitment_screening_close_for_application', 'recruitment_screening_close_for_reviewer')
      order by p.proname`);
    expect(fns.map((f) => [f.proname, f.volatility])).toEqual([['recruitment_job_hiring_managers', 's'], ['recruitment_screening_close_for_application', 'v'],
      ['recruitment_screening_close_for_reviewer', 'v']]);
    for (const f of fns) {
      expect(f.secdef, f.proname).toBe(true);
      expect(f.public_exec, f.proname).toBe(false);
      expect((f.config ?? []).some((c) => c.startsWith('search_path=pg_catalog')), f.proname).toBe(true);
      // Each restores its transaction-local setting on return (its SET clause).
      expect((f.config ?? []).some((c) => /^app\.recruitment_screening_(job|closing)=$/.test(c)), f.proname).toBe(true);
    }
    // Only the app role may call the lookup; the closing triggers are nobody's to call.
    const exec = await owner.db.execute<{ proname: string; app_exec: boolean }>(sql`select p.proname, has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'recruitment_screening_close_for_%' order by 1`);
    expect(exec).toEqual([{ proname: 'recruitment_screening_close_for_application', app_exec: false }, { proname: 'recruitment_screening_close_for_reviewer', app_exec: false }]);
    // The guards are not callable by anybody.
    const guards = await owner.db.execute<{ proname: string; app_exec: boolean; public_exec: boolean }>(sql`select p.proname,
      has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec, has_function_privilege('public', p.oid, 'execute') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname in ('recruitment_guard_screening_request', 'recruitment_guard_screening_answer', 'recruitment_screening_answered') order by 1`);
    expect(guards).toEqual([
      { proname: 'recruitment_guard_screening_answer', app_exec: false, public_exec: false },
      { proname: 'recruitment_guard_screening_request', app_exec: false, public_exec: false },
      { proname: 'recruitment_screening_answered', app_exec: false, public_exec: false },
    ]);
    // The AI Centre read: per-company counts only, whatever screening data exists.
    const t = await team();
    const a = await apply(t, `${SENTINEL} AI`);
    await sendForScreening(t.recruiter, { applicationIds: [a.applicationId], note: `${SENTINEL} note` });
    await answerScreening(t.hm1, await requestOf(a.applicationId, t.hm1.userId), { result: 'advance', comment: `${SENTINEL} comment` });
    const counts = await recruitmentPipelineCounts(admin);
    expect(counts.rows.length).toBeGreaterThan(0);
    const COUNT_KEYS = ['activeApplications', 'archived', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen'];
    for (const row of counts.rows) {
      expect(Object.keys(row).sort()).toEqual(['company', ...COUNT_KEYS].sort());
      for (const k of COUNT_KEYS) expect(Number.isInteger((row as Record<string, unknown>)[k]), k).toBe(true);
    }
    expect(JSON.stringify(counts)).not.toMatch(new RegExp(`${SENTINEL}|Fictional Manager`));
  });

  it('pins every piece of code that reads job memberships or uses the lookup and closing settings (a new one forces a review)', async () => {
    // The owner-only policy recruitment_job_member_screening_read admits hiring-manager rows of the job named in
    // app.recruitment_screening_job to ANY code running as the table owner. The app role can set that value itself, so the
    // proof that this widens nothing is that no other owner-run code reads recruitment_job_member: the only definer that does
    // is the lookup (which sets the value itself, after its operator check), and the invoker predicates read only the session
    // user's own rows (app_user_id = app.current_user_id()). No policy and no view reads the table.
    const fns = await owner.db.execute<{ f: string; definer: boolean }>(sql`select p.oid::regprocedure::text as f, p.prosecdef as definer
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ~ 'recruitment_job_member'
      order by 1`);
    expect(fns).toEqual([
      { f: 'app.recruitment_has_job_role(uuid,text[])', definer: false },
      { f: 'app.recruitment_job_hiring_managers(uuid)', definer: true },
      { f: 'app.recruitment_operates_in_company(uuid)', definer: false },
      { f: 'app.recruitment_team_in_company(uuid)', definer: false },
    ]);
    const src = await owner.db.execute<{ f: string; src: string }>(sql`select p.oid::regprocedure::text as f, p.prosrc as src from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in ('recruitment_has_job_role', 'recruitment_operates_in_company', 'recruitment_team_in_company')`);
    expect(src).toHaveLength(3);
    for (const x of src) for (const read of x.src.split(/FROM public\.recruitment_job_member/i).slice(1)) expect(read, x.f).toMatch(/app_user_id = app\.current_user_id\(\)/);
    const policies = await owner.db.execute<{ p: string }>(sql`select tablename || '.' || policyname as p from pg_policies
      where (qual ~ 'recruitment_job_member' or with_check ~ 'recruitment_job_member') and tablename <> 'recruitment_job_member'`);
    expect(policies).toEqual([]);
    expect(await owner.db.execute(sql`select 1 from pg_views where definition ~ 'recruitment_job_member'`)).toEqual([]);
    expect((await owner.db.execute<{ p: string }>(sql`select policyname as p from pg_policies where tablename = 'recruitment_job_member' order by 1`)).map((r) => r.p))
      .toEqual(expect.arrayContaining(['recruitment_job_member_screening_read', 'recruitment_job_member_self']));
    // The two settings: who reads or writes them.
    const settings = await owner.db.execute<{ f: string }>(sql`select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosrc ~ 'recruitment_screening_(job|closing)' order by 1`);
    expect(settings.map((r) => r.f)).toEqual(['app.recruitment_guard_screening_request()', 'app.recruitment_job_hiring_managers(uuid)',
      'app.recruitment_screening_close_for_application()', 'app.recruitment_screening_close_for_reviewer()']);
  });

  it('company deletion, removal, sending and closing work under a NOBYPASSRLS owner with row security forced', async () => {
    const [{ id: emptyCompany }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Empty Sdn Bhd' }).returning({ id: company.id });
    const t = await team();
    const [a, fresh] = [await apply(t, `${SENTINEL} Owner`), await apply(t)];
    await sendForScreening(t.recruiter, { applicationIds: [a.applicationId], note: `${SENTINEL} note` });
    await answerScreening(t.hm1, await requestOf(a.applicationId, t.hm1.userId), { result: 'reject', comment: `${SENTINEL} comment` });
    await rejectAndAge(a.applicationId);
    await sendForScreening(t.recruiter, { applicationIds: [fresh.applicationId], reviewerUserIds: [t.hm1.userId] });
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    const ROLLBACK = 'rolled back on purpose';
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment', 'employment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      expect(tables.map((x) => x.name)).toEqual(expect.arrayContaining([...NEW_TABLES.map((x) => `public.${x}`), 'public.recruitment_job_member', 'public.recruitment_application']));
      for (const x of tables) await tx.unsafe(`alter table ${x.name} owner to ai_hr_owner`);
      const fns = await tx<{ sig: string }[]>`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname ~ '^recruitment_'`;
      expect(fns.map((f) => f.sig)).toEqual(expect.arrayContaining(['app.recruitment_delete_company_setup(uuid)', 'app.recruitment_destroy_candidate(uuid)',
        'app.recruitment_job_hiring_managers(uuid)', 'app.recruitment_screening_close_for_application()', 'app.recruitment_screening_close_for_reviewer()']));
      for (const f of fns) await tx.unsafe(`alter function ${f.sig} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      const forced = await tx`select relname from pg_class where relname = any(${[...NEW_TABLES, 'recruitment_job_member', 'recruitment_application']}) and relforcerowsecurity and relrowsecurity`;
      expect(forced).toHaveLength(NEW_TABLES.length + 2);
      const as = async (userId: string, roles: string, grants: unknown) => {
        await tx.unsafe('set local role ai_hr_app');
        await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('app.roles', ${roles}, true),
          set_config('app.grants', ${JSON.stringify(grants)}, true)`;
      };
      // The recruiter (not an administrator): the definer lists the job's hiring managers under the owner, and the send guard
      // admits a hiring manager and refuses anybody else.
      await as(t.recruiter.userId, 'employee', [{ role: 'employee', companyId: null }]);
      expect((await tx`select app_user_id from app.recruitment_job_hiring_managers(${t.jobId}::uuid)`).map((r) => r.app_user_id)).toEqual([t.hm1.userId, t.hm2.userId]);
      // The app role does not see the other members through the owner-only policy.
      expect((await tx`select app_user_id from recruitment_job_member where job_id = ${t.jobId}::uuid`).map((r) => r.app_user_id)).toEqual([t.recruiter.userId]);
      await tx`insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${fresh.applicationId}::uuid, ${t.hm2.userId}::uuid, ${t.recruiter.userId}::uuid)`;
      await tx`savepoint s1`;
      await expect(tx`insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${fresh.applicationId}::uuid, ${t.interviewer.userId}::uuid, ${t.recruiter.userId}::uuid)`)
        .rejects.toMatchObject({ code: '23514' });
      await tx`rollback to savepoint s1`;
      // A hiring manager is not an operator: the definer gives them nothing.
      await tx`reset role`;
      await as(t.hm1.userId, 'employee', [{ role: 'employee', companyId: null }]);
      expect(await tx`select app_user_id from app.recruitment_job_hiring_managers(${t.jobId}::uuid)`).toHaveLength(0);
      await tx`reset role`;
      // The administrator: removal and the company delete, run as the owner under forced row security.
      await as(base.adminUserId, 'hr_admin', [{ role: 'hr_admin', companyId: null }]);
      const [destroyed] = await tx`select app.recruitment_destroy_candidate(${a.candidateId}::uuid) as r`;
      expect(destroyed.r).toMatchObject({ screeningNotes: 2, screeningComments: 1 });
      const [removed] = await tx`select app.recruitment_delete_company_setup(${emptyCompany}::uuid) as n`;
      expect(Number(removed.n)).toBeGreaterThanOrEqual(0);
      // The app role cannot delete screening rows itself, even with the company-delete context value.
      await tx`select set_config('app.recruitment_company_delete', ${base.companyId}, true)`;
      await tx`savepoint s2`;
      await expect(tx`delete from recruitment_screening_answer`).rejects.toMatchObject({ code: '42501' });
      await tx`rollback to savepoint s2`;
      await tx`select set_config('app.recruitment_company_delete', '', true)`;
      // The closing triggers, run as the owner: hm2 leaves the job (their request on `fresh` closes), then `fresh` is archived
      // (hm1's request closes). Nothing else closes.
      await tx`delete from recruitment_job_member where job_id = ${t.jobId}::uuid and app_user_id = ${t.hm2.userId}::uuid and member_role = 'hiring_manager'`;
      await tx`update recruitment_application set state = 'archived', archive_reason_id = ${reason.id}::uuid, stage_left_at_archive = current_stage_id
        where id = ${fresh.applicationId}::uuid`;
      await tx`reset role`;
      expect((await tx`select reviewer_user_id, closed_reason, closed_by_user_id from recruitment_screening_request where application_id = ${fresh.applicationId}::uuid
        order by closed_reason`).map((r) => [r.reviewer_user_id, r.closed_reason, r.closed_by_user_id])).toEqual([
        [t.hm1.userId, 'application_closed', base.adminUserId], [t.hm2.userId, 'reviewer_removed', base.adminUserId]]);
      for (const x of NEW_TABLES) {
        const [n] = await tx.unsafe(`select count(*)::int as n from public.${x} where company_id = '${emptyCompany}'::uuid`);
        expect(n.n, x).toBe(0);
      }
      const [cleared] = await tx`select count(*)::int as n from recruitment_screening_request where application_id = ${a.applicationId}::uuid and note is not null`;
      expect(cleared.n).toBe(0);
      const [clearedAnswers] = await tx`select count(*)::int as n from recruitment_screening_answer where application_id = ${a.applicationId}::uuid and comment is not null`;
      expect(clearedAnswers.n).toBe(0);
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => (e instanceof Error && e.message === ROLLBACK ? 'rolled back' : Promise.reject(e)));
    expect(done).toBe('rolled back');
    // Through the service as well (default owner): the company delete covers the new tables.
    expect(await withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${emptyCompany}::uuid) as n`))).toHaveLength(1);
  });
});
