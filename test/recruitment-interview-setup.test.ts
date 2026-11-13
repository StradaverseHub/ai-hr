/**
 * Recruitment slice 18 against Postgres — interview set-up: acceptance cases 121–125 (docs/recruitment-reconstruction/
 * specification.md "Slice 18 acceptance cases"), through the service AND directly as the app role (ai_hr_app under row security).
 * The pure rules are test/recruitment-interview-setup-rules.test.ts; case 126 is the lead's rendered check.
 *
 * Expected values are read back with plain owner-connection SQL that ignores row security, or written out here — never computed
 * with packs/recruitment/interview-setup*.ts. Every person and company is fictional; names carry the LETTER sentinel QZW.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import {
  addApplication, addInterviewers, addJobMember, applicationInterviews, archiveSuggestedApplications, cancelInterview, rejectApplication, recruitmentSettings, saveWaitingRule, createJob, deleteInterviewAddress, deleteInterviewQuestion,
  deleteInterviewRoom, deleteInterviewerGroup, getScorecard, interviewFormOptions, interviewPlaceSettings, interviewSettings, interviewerGroupSettings,
  jobFormOptions, questionBankSettings, recruitmentPipelineCounts, saveEvaluationForm, saveInterviewAddress, saveInterviewQuestion, saveInterviewRoom,
  saveInterviewerGroup, scheduleInterview, scorecardForm, setInterviewQuestionRetired, submitScorecard, RecruitmentError,
} from '../packs/recruitment/service';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let otherCompanyId: string;
let gradeId: string;

const SETUP_TABLES = ['recruitment_interview_address', 'recruitment_interview_question', 'recruitment_interview_question_link', 'recruitment_interview_room',
  'recruitment_interviewer_group', 'recruitment_interviewer_group_member'];

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
async function login(name: string, companyId = base.companyId): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'QZW Fictional analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time', ...over,
});
/** Kuala Lumpur wall-clock times on a fixed fictional future day (the form's datetime-local input). */
const at = (hhmm: string) => `2031-03-04T${hhmm}`;
const interviewersOf = async (interviewId: string) => (await owner.db.execute<{ app_user_id: string }>(sql`
  select app_user_id from recruitment_interview_interviewer where interview_id = ${interviewId}::uuid order by app_user_id`)).map((r) => r.app_user_id);
const sorted = (ids: string[]) => [...ids].sort();

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

/** A job J with a recruiter, an interviewer and three applications; a second job J2 with its own recruiter (who cannot read J's
 *  interviews); people P1–P3 of the company; an outsider employed only by the other company; a bystander. */
async function world() {
  const [recruiter, recruiter2, interviewer, p1, p2, p3, bystander] = await Promise.all([
    login('QZW Recruiter'), login('QZW Second Recruiter'), login('QZW Interviewer'), login('QZW Person One'), login('QZW Person Two'), login('QZW Person Three'),
    login('QZW Bystander'),
  ]);
  const outsider = await login('QZW Outsider', otherCompanyId);
  await jobFormOptions(admin, base.companyId);
  const { id: j } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
  const { id: j2 } = await createJob(admin, job({ title: 'QZW Fictional second role', recruiterUserId: recruiter2.userId }));
  await addJobMember(admin, j, 'interviewer', interviewer.userId);
  const add = (n: string, jobId = j, who: SessionContext = recruiter) => addApplication(who, { jobId, fullName: `QZW Candidate ${n}`, email: `qzw-${n}@example.test` });
  const [a1, a2, a3] = [await add('a'), await add('b'), await add('c')];
  const o1 = await add('d', j2, recruiter2);
  const forms = (await interviewSettings(admin, base.companyId)).forms;
  const defaultForm = forms.find((f) => f.isDefault)!;
  await saveEvaluationForm(admin, { companyId: base.companyId, name: 'QZW Second template', source: defaultForm.source, enabled: 'on' });
  const [{ id: secondForm }] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_evaluation_form where company_id = ${base.companyId}::uuid and name = 'QZW Second template'`);
  return { recruiter, recruiter2, interviewer, p1, p2, p3, bystander, outsider, j, j2, a1, a2, a3, o1, defaultForm: defaultForm.id, secondForm };
}
type World = Awaited<ReturnType<typeof world>>;
async function place(w: World, companyId = base.companyId, name = 'QZW Tower') {
  const { id: addressId } = await saveInterviewAddress(admin, { companyId, name, address: '1 Fictional Road', region: 'Kuala Lumpur', mapUrl: 'https://maps.example.test/qzw' });
  const { id: roomId } = await saveInterviewRoom(admin, { addressId, name: 'Room QZW', capacity: '6' });
  return { addressId, roomId };
}

describe('case 121 — only administrators manage groups, questions, addresses and rooms (service and database); members and rooms belong to the company', () => {
  it('the service refuses non-administrators; the database refuses their writes as the app role', async () => {
    const w = await world();
    const { addressId, roomId } = await place(w);
    const { id: groupId } = await saveInterviewerGroup(admin, { companyId: base.companyId, name: 'QZW Panel', memberIds: [w.p1.userId] });
    const { id: questionId } = await saveInterviewQuestion(admin, { companyId: base.companyId, title: 'QZW Question', formIds: [] });
    for (const who of [w.recruiter, w.interviewer, w.bystander]) {
      expect(await code(saveInterviewerGroup(who, { companyId: base.companyId, name: 'QZW Rogue', memberIds: [] }))).toBe('forbidden');
      expect(await code(saveInterviewQuestion(who, { companyId: base.companyId, title: 'QZW Rogue' }))).toBe('forbidden');
      expect(await code(saveInterviewAddress(who, { companyId: base.companyId, name: 'QZW Rogue', address: 'x', region: 'y' }))).toBe('forbidden');
      expect(['forbidden', 'not_found']).toContain(await code(saveInterviewRoom(who, { addressId, name: 'QZW Rogue', capacity: '2' })));
      expect(['forbidden', 'not_found']).toContain(await code(deleteInterviewerGroup(who, groupId)));
      expect(['forbidden', 'not_found']).toContain(await code(deleteInterviewQuestion(who, questionId)));
      expect(['forbidden', 'not_found']).toContain(await code(deleteInterviewRoom(who, roomId)));
      expect(await code(interviewerGroupSettings(who, base.companyId))).toBe('forbidden');
      // Directly as the app role: inserts fail the policy, updates and deletes reach no row.
      const me = who.userId!;
      expect(await code(rows(who, sql`insert into recruitment_interviewer_group (tenant_id, company_id, name, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'QZW Rogue', ${me}::uuid, ${me}::uuid)`))).toBe('42501');
      expect(await code(rows(who, sql`insert into recruitment_interviewer_group_member (tenant_id, company_id, group_id, app_user_id, created_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${groupId}::uuid, ${me}::uuid, ${me}::uuid)`))).toBe('42501');
      expect(await code(rows(who, sql`insert into recruitment_interview_question (tenant_id, company_id, title, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'QZW Rogue', ${me}::uuid, ${me}::uuid)`))).toBe('42501');
      expect(await code(rows(who, sql`insert into recruitment_interview_question_link (tenant_id, company_id, question_id, evaluation_form_id, created_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${questionId}::uuid, ${w.defaultForm}::uuid, ${me}::uuid)`))).toBe('42501');
      expect(await code(rows(who, sql`insert into recruitment_interview_address (tenant_id, company_id, name, address, region, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'QZW Rogue', 'x', 'y', ${me}::uuid, ${me}::uuid)`))).toBe('42501');
      expect(await code(rows(who, sql`insert into recruitment_interview_room (tenant_id, company_id, address_id, name, capacity, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${addressId}::uuid, 'QZW Rogue', 2, ${me}::uuid, ${me}::uuid)`))).toBe('42501');
      expect(await rows(who, sql`update recruitment_interviewer_group set name = 'QZW Changed' where id = ${groupId}::uuid returning id`)).toEqual([]);
      expect(await rows(who, sql`update recruitment_interview_question set title = 'QZW Changed' where id = ${questionId}::uuid returning id`)).toEqual([]);
      expect(await rows(who, sql`update recruitment_interview_address set name = 'QZW Changed' where id = ${addressId}::uuid returning id`)).toEqual([]);
      expect(await rows(who, sql`update recruitment_interview_room set enabled = false where id = ${roomId}::uuid returning id`)).toEqual([]);
      for (const t of SETUP_TABLES) expect(await rows(who, sql`delete from ${sql.identifier(t)} where company_id = ${base.companyId}::uuid returning id`), t).toEqual([]);
    }
    // Nothing changed (owner read).
    const [g] = await owner.db.execute<{ name: string; n: number }>(sql`select g.name, (select count(*)::int from recruitment_interviewer_group_member m where m.group_id = g.id) as n
      from recruitment_interviewer_group g where g.id = ${groupId}::uuid`);
    expect(g).toEqual({ name: 'QZW Panel', n: 1 });
    const counts = await owner.db.execute<{ t: string; n: number }>(sql`select 'group' as t, count(*)::int as n from recruitment_interviewer_group
      union all select 'question', count(*)::int from recruitment_interview_question union all select 'address', count(*)::int from recruitment_interview_address
      union all select 'room', count(*)::int from recruitment_interview_room where enabled order by 1`);
    expect(counts).toEqual([{ t: 'address', n: 1 }, { t: 'group', n: 1 }, { t: 'question', n: 1 }, { t: 'room', n: 1 }]);
  });

  it('reads: operators see groups, job teams see questions and addresses, a bystander sees nothing; a group grants no access', async () => {
    const w = await world();
    await place(w);
    await saveInterviewerGroup(admin, { companyId: base.companyId, name: 'QZW Panel', memberIds: [w.p1.userId] });
    await saveInterviewQuestion(admin, { companyId: base.companyId, title: 'QZW Question', formIds: [w.defaultForm] });
    const count = async (who: SessionContext, t: string) => (await rows<{ n: number }>(who, sql`select count(*)::int as n from ${sql.identifier(t)}`))[0].n;
    expect(await count(w.recruiter, 'recruitment_interviewer_group')).toBe(1);
    expect(await count(w.recruiter, 'recruitment_interviewer_group_member')).toBe(1);
    expect(await count(w.interviewer, 'recruitment_interviewer_group')).toBe(0);
    expect(await count(w.interviewer, 'recruitment_interview_question')).toBe(1);
    expect(await count(w.interviewer, 'recruitment_interview_question_link')).toBe(1);
    expect(await count(w.interviewer, 'recruitment_interview_address')).toBe(1);
    expect(await count(w.interviewer, 'recruitment_interview_room')).toBe(1);
    for (const t of SETUP_TABLES) expect(await count(w.bystander, t), t).toBe(0);
    // P1 is in a group but on no job team and no interview: being a group member gives no read of the job's applications.
    expect(await count(w.p1, 'recruitment_application')).toBe(0);
    expect(await count(w.p1, 'recruitment_interviewer_group')).toBe(0);
  });

  it('a member must have access to the company (service and database); a room must be of the company and its address', async () => {
    const w = await world();
    // Service: the outsider is employed only by the other company.
    expect(await code(saveInterviewerGroup(admin, { companyId: base.companyId, name: 'QZW Panel', memberIds: [w.outsider.userId] }))).toBe('invalid_input');
    const { id: groupId } = await saveInterviewerGroup(admin, { companyId: base.companyId, name: 'QZW Panel', memberIds: [w.p1.userId] });
    // Database: the guard refuses the outsider even for an administrator writing directly.
    expect(await constraintOf(rows(admin, sql`insert into recruitment_interviewer_group_member (tenant_id, company_id, group_id, app_user_id, created_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${groupId}::uuid, ${w.outsider.userId}::uuid, ${base.adminUserId}::uuid)`))).toBe('recruitment_interviewer_group_member_access');
    // …and a member row cannot name another company's group (composite key).
    const { id: otherGroup } = await saveInterviewerGroup(admin, { companyId: otherCompanyId, name: 'QZW Other panel', memberIds: [w.outsider.userId] });
    expect(await code(rows(admin, sql`insert into recruitment_interviewer_group_member (tenant_id, company_id, group_id, app_user_id, created_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${otherGroup}::uuid, ${w.p2.userId}::uuid, ${base.adminUserId}::uuid)`))).toBe('23503');
    // Rooms: a room row naming another company's address is refused by the composite key.
    const other = await place(w, otherCompanyId, 'QZW Other tower');
    expect(await constraintOf(rows(admin, sql`insert into recruitment_interview_room (tenant_id, company_id, address_id, name, capacity, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${other.addressId}::uuid, 'QZW Cross', 2, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`))).toBe('recruitment_interview_room_address_fk');
    // Scheduling with another company's room: the service refuses; the database key refuses it too.
    expect(await code(scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'onsite', startsAt: at('10:00'), interviewerIds: [w.interviewer.userId], roomId: other.roomId })))
      .toBe('room_unavailable');
    const { id: iv } = await scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'onsite', startsAt: at('10:00'), interviewerIds: [w.interviewer.userId] });
    // The recruiter cannot even see the other company's room (the place guard refuses first); an administrator, who can, meets the keys.
    expect(await code(rows(w.recruiter, sql`update recruitment_interview set address_id = ${other.addressId}::uuid, room_id = ${other.roomId}::uuid where id = ${iv}::uuid`))).not.toBe('ok');
    expect(['recruitment_interview_address_fk', 'recruitment_interview_room_fk']).toContain(
      await constraintOf(rows(admin, sql`update recruitment_interview set address_id = ${other.addressId}::uuid, room_id = ${other.roomId}::uuid where id = ${iv}::uuid`)));
    expect(await owner.db.execute(sql`select address_id, room_id from recruitment_interview where id = ${iv}::uuid`)).toEqual([{ address_id: null, room_id: null }]);
    // A room keeps its company and address; a group its company.
    const mine = await place(w, base.companyId, 'QZW Annex');
    expect(await code(rows(admin, sql`update recruitment_interview_room set address_id = ${other.addressId}::uuid where id = ${mine.roomId}::uuid`))).not.toBe('ok');
    expect(await code(rows(admin, sql`update recruitment_interviewer_group set company_id = ${otherCompanyId}::uuid where id = ${groupId}::uuid`))).not.toBe('ok');
    // Names are unique in the company (case-insensitive), not across companies.
    expect(await code(saveInterviewerGroup(admin, { companyId: base.companyId, name: ' qzw PANEL ', memberIds: [] }))).toBe('name_taken');
    expect(await code(saveInterviewerGroup(admin, { companyId: otherCompanyId, name: 'QZW Panel', memberIds: [] }))).toBe('ok');
  });
});

describe('case 122 — adding a group adds its current members as interviewers once; later group edits do not change interviews', () => {
  it('scheduling with a group, then adding the same group again, then editing the group', async () => {
    const w = await world();
    const { id: groupId } = await saveInterviewerGroup(admin, { companyId: base.companyId, name: 'QZW Panel', memberIds: [w.p1.userId, w.p2.userId, w.interviewer.userId] });
    // The recruiter (an operator) sees the group when scheduling.
    expect((await interviewFormOptions(w.recruiter, w.a1.applicationId)).groups).toEqual([{ id: groupId, name: 'QZW Panel', members: 3 }]);
    // Picked interviewer + group containing the same person: each once.
    const { id: iv } = await scheduleInterview(w.recruiter, {
      applicationId: w.a1.applicationId, type: 'video', startsAt: at('10:00'), interviewerIds: [w.interviewer.userId], groupIds: [groupId],
    });
    expect(await interviewersOf(iv)).toEqual(sorted([w.interviewer.userId, w.p1.userId, w.p2.userId]));
    // Adding the same group again adds nobody (idempotent); adding a person who is already there adds nobody.
    expect(await addInterviewers(w.recruiter, iv, { groupIds: [groupId], interviewerIds: [w.p1.userId] })).toEqual({ added: [], skipped: 0 });
    expect(await interviewersOf(iv)).toEqual(sorted([w.interviewer.userId, w.p1.userId, w.p2.userId]));
    // Editing the group (remove P2, add P3) changes no existing interview.
    await saveInterviewerGroup(admin, { id: groupId, name: 'QZW Panel renamed', memberIds: [w.p1.userId, w.p3.userId] });
    expect(await interviewersOf(iv)).toEqual(sorted([w.interviewer.userId, w.p1.userId, w.p2.userId]));
    // Deleting the group changes no interview either.
    const { id: iv2 } = await scheduleInterview(w.recruiter, { applicationId: w.a2.applicationId, type: 'phone', startsAt: at('12:00'), groupIds: [groupId] });
    expect(await interviewersOf(iv2)).toEqual(sorted([w.p1.userId, w.p3.userId]));
    await deleteInterviewerGroup(admin, groupId);
    expect(await interviewersOf(iv2)).toEqual(sorted([w.p1.userId, w.p3.userId]));
    // Nothing on the interview records the group.
    const [cols] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name in ('recruitment_interview', 'recruitment_interview_interviewer') and column_name like '%group%'`);
    expect(cols.n).toBe(0);
  });

  it('a member who lost access is skipped; groups leaving nobody are refused; another company\'s group is refused', async () => {
    const w = await world();
    const { id: groupId } = await saveInterviewerGroup(admin, { companyId: base.companyId, name: 'QZW Panel', memberIds: [w.p1.userId, w.p2.userId] });
    await owner.db.execute(sql`update app_user set archived_at = now() where id = ${w.p2.userId}::uuid`);
    const { id: iv } = await scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'video', startsAt: at('10:00'), groupIds: [groupId] });
    expect(await interviewersOf(iv)).toEqual([w.p1.userId]);
    // The settings still list P2, marked as without access.
    const listed = (await interviewerGroupSettings(admin, base.companyId)).groups[0].members.map((m) => ({ userId: m.userId, hasAccess: m.hasAccess }));
    expect(sorted(listed.map((m) => `${m.userId}:${m.hasAccess}`))).toEqual(sorted([`${w.p1.userId}:true`, `${w.p2.userId}:false`]));
    await owner.db.execute(sql`update app_user set archived_at = now() where id = ${w.p1.userId}::uuid`);
    expect(await code(scheduleInterview(w.recruiter, { applicationId: w.a2.applicationId, type: 'video', startsAt: at('10:00'), groupIds: [groupId] }))).toBe('no_interviewers');
    const { id: otherGroup } = await saveInterviewerGroup(admin, { companyId: otherCompanyId, name: 'QZW Other panel', memberIds: [w.outsider.userId] });
    expect(await code(scheduleInterview(w.recruiter, { applicationId: w.a2.applicationId, type: 'video', startsAt: at('10:00'), interviewerIds: [w.p3.userId], groupIds: [otherGroup] })))
      .toBe('group_unavailable');
    expect(await code(addInterviewers(w.recruiter, iv, { groupIds: [otherGroup] }))).toBe('group_unavailable');
    // Only operators of the job add interviewers.
    expect(['forbidden', 'not_found']).toContain(await code(addInterviewers(w.interviewer, iv, { interviewerIds: [w.p3.userId] })));
    expect(['forbidden', 'not_found']).toContain(await code(addInterviewers(w.recruiter2, iv, { interviewerIds: [w.p3.userId] })));
  });
});

describe('case 123 — linked questions show on that template\'s feedback form only, are never scored, and retired ones are hidden', () => {
  it('guidance per template, retirement, no effect on scores, and no deletion while linked', async () => {
    const w = await world();
    const { id: q1 } = await saveInterviewQuestion(admin, { companyId: base.companyId, title: 'QZW Describe a hard trade-off', guidance: 'Listen for QZW reasoning.', category: 'Judgement', formIds: [w.defaultForm] });
    const { id: q2 } = await saveInterviewQuestion(admin, { companyId: base.companyId, title: 'QZW Second-template question', formIds: [w.secondForm] });
    const { id: q3 } = await saveInterviewQuestion(admin, { companyId: base.companyId, title: 'QZW Unlinked question', formIds: [] });
    const { id: ivDefault } = await scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'video', startsAt: '2024-05-06T10:00', interviewerIds: [w.interviewer.userId] });
    const { id: ivSecond } = await scheduleInterview(w.recruiter, { applicationId: w.a2.applicationId, type: 'video', startsAt: '2024-05-06T12:00', interviewerIds: [w.interviewer.userId], formId: w.secondForm });
    const formA = await scorecardForm(w.interviewer, ivDefault);
    expect(formA.questions).toEqual([{ id: q1, title: 'QZW Describe a hard trade-off', guidance: 'Listen for QZW reasoning.', category: 'Judgement', retired: false }]);
    expect((await scorecardForm(w.interviewer, ivSecond)).questions.map((q) => q.id)).toEqual([q2]);
    // Questions are not criteria: the form's criteria are exactly the template's (owner read of the stored definition).
    const [{ n: criteria }] = await owner.db.execute<{ n: number }>(sql`select sum(jsonb_array_length(s -> 'criteria'))::int as n
      from recruitment_evaluation_form f, jsonb_array_elements(f.definition -> 'sections') s where f.id = ${w.defaultForm}::uuid`);
    expect(formA.definition.sections.reduce((n, s) => n + s.criteria.length, 0)).toBe(criteria);
    expect(JSON.stringify(formA.definition)).not.toContain('QZW');
    // Score: rate every criterion 4; the stored ratings name the criteria only and the totals are 4 × criteria.
    const ratings = Object.fromEntries(formA.definition.sections.flatMap((s) => s.criteria.map((c) => [c.key, { rating: '4', notes: '' }])));
    await submitScorecard(w.interviewer, ivDefault, { ratings, result: 'recommended', overview: '' });
    const [stored] = await owner.db.execute<{ id: string; keys: string[] }>(sql`select id, array(select jsonb_object_keys(ratings) order by 1) as keys
      from recruitment_scorecard where interview_id = ${ivDefault}::uuid`);
    expect(stored.keys).toEqual(Object.keys(ratings).sort());
    expect(stored.keys.some((k) => k === q1 || k.includes('-'))).toBe(false);
    const view = await getScorecard(admin, stored.id);
    expect(view.sections.reduce((n, s) => n + s.sum, 0)).toBe(4 * criteria);
    // Retired: hidden from every feedback form opened afterwards; restored: shown again.
    await setInterviewQuestionRetired(admin, { id: q1, retired: true });
    expect((await scorecardForm(w.interviewer, ivDefault)).questions).toEqual([]);
    expect((await questionBankSettings(admin, base.companyId)).forms.find((f) => f.id === w.defaultForm)!.questions).toBe(0);
    // A retired question gains no link (service and database).
    expect(await code(saveInterviewQuestion(admin, { id: q1, title: 'QZW Describe a hard trade-off', formIds: [w.defaultForm, w.secondForm] }))).toBe('question_retired');
    expect(await constraintOf(rows(admin, sql`insert into recruitment_interview_question_link (tenant_id, company_id, question_id, evaluation_form_id, created_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${q1}::uuid, ${w.secondForm}::uuid, ${base.adminUserId}::uuid)`))).toBe('recruitment_interview_question_link_retired');
    await setInterviewQuestionRetired(admin, { id: q1, retired: false });
    expect((await scorecardForm(w.interviewer, ivDefault)).questions.map((q) => q.id)).toEqual([q1]);
    // Deleting: refused while linked (service and database key), allowed when unlinked.
    expect(await code(deleteInterviewQuestion(admin, q1))).toBe('question_in_use');
    expect(await constraintOf(rows(admin, sql`delete from recruitment_interview_question where id = ${q1}::uuid`))).toBe('recruitment_interview_question_link_question_fk');
    expect(await code(deleteInterviewQuestion(admin, q3))).toBe('ok');
    await saveInterviewQuestion(admin, { id: q2, title: 'QZW Second-template question', formIds: [] });
    expect(await code(deleteInterviewQuestion(admin, q2))).toBe('ok');
    expect((await owner.db.execute(sql`select id from recruitment_interview_question order by id`)).map((r) => r.id)).toEqual([q1]);
    // A link names a template of the question's own company.
    await interviewSettings(admin, otherCompanyId);
    const [{ id: otherForm }] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_evaluation_form where company_id = ${otherCompanyId}::uuid limit 1`);
    expect(await code(saveInterviewQuestion(admin, { id: q1, title: 'QZW Describe a hard trade-off', formIds: [w.defaultForm, otherForm] }))).toBe('invalid_input');
    expect(await code(rows(admin, sql`insert into recruitment_interview_question_link (tenant_id, company_id, question_id, evaluation_form_id, created_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${q1}::uuid, ${otherForm}::uuid, ${base.adminUserId}::uuid)`))).toBe('23503');
  });
});

describe('case 124 — a room is never double-booked (database), cancelling frees it, a map link must be https', () => {
  it('overlapping bookings are refused, touching ones allowed, whatever the caller can read; cancellation frees the room', async () => {
    const w = await world();
    const { addressId, roomId } = await place(w);
    const book = (who: SessionContext, applicationId: string, startsAt: string, durationMinutes: string, extra: Record<string, unknown> = {}) =>
      scheduleInterview(who, { applicationId, type: 'onsite', startsAt, durationMinutes, interviewerIds: [w.interviewer.userId], roomId, ...extra });
    const { id: first } = await book(w.recruiter, w.a1.applicationId, at('10:00'), '60');
    // The room names its address on the interview.
    const [stored] = await owner.db.execute<{ address_id: string; room_id: string }>(sql`select address_id, room_id from recruitment_interview where id = ${first}::uuid`);
    expect(stored).toEqual({ address_id: addressId, room_id: roomId });
    // Overlaps: the same application, another application, and ANOTHER job whose recruiter cannot read the first interview.
    expect(await code(book(w.recruiter, w.a2.applicationId, at('10:30'), '60'))).toBe('room_booked');
    expect(await code(book(w.recruiter, w.a1.applicationId, at('09:30'), '31'))).toBe('room_booked');
    expect(await rows(w.recruiter2, sql`select id from recruitment_interview where id = ${first}::uuid`)).toEqual([]);
    expect(await code(book(w.recruiter2, w.o1.applicationId, at('10:59'), '5'))).toBe('room_booked');
    // Touching: [09:00, 10:00) and [11:00, 11:30) share no instant with [10:00, 11:00).
    const { id: before } = await book(w.recruiter, w.a2.applicationId, at('09:00'), '60');
    const { id: after } = await book(w.recruiter2, w.o1.applicationId, at('11:00'), '30');
    // Directly as the app role: moving an interview onto an overlapping time is refused by the exclusion constraint.
    expect(await constraintOf(rows(w.recruiter, sql`update recruitment_interview set starts_at = starts_at + interval '30 minutes' where id = ${before}::uuid`)))
      .toBe('recruitment_interview_room_no_overlap');
    // Cancelling frees the room: the 10:30 booking now succeeds.
    await cancelInterview(w.recruiter, first);
    const { id: replacement } = await book(w.recruiter, w.a3.applicationId, at('10:00'), '60');
    // Without a room, an overlapping on-site interview at the same address is fine (only rooms are exclusive).
    expect(await code(scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'onsite', startsAt: at('10:00'), interviewerIds: [w.interviewer.userId], addressId })))
      .toBe('ok');
    const booked = await owner.db.execute<{ id: string }>(sql`select id from recruitment_interview where room_id = ${roomId}::uuid and cancelled_at is null order by starts_at`);
    expect(booked.map((r) => r.id)).toEqual([before, replacement, after]);
    // A disabled room cannot be chosen (service and guard); a room is for on-site interviews only (service and CHECK).
    await saveInterviewRoom(admin, { id: roomId, name: 'Room QZW', capacity: '6', enabled: false });
    expect(await code(book(w.recruiter, w.a1.applicationId, at('15:00'), '30'))).toBe('room_unavailable');
    const { id: plain } = await scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'onsite', startsAt: at('16:00'), interviewerIds: [w.interviewer.userId] });
    expect(await constraintOf(rows(w.recruiter, sql`update recruitment_interview set address_id = ${addressId}::uuid, room_id = ${roomId}::uuid where id = ${plain}::uuid`)))
      .toBe('recruitment_interview_room_enabled');
    await saveInterviewRoom(admin, { id: roomId, name: 'Room QZW', capacity: '6', enabled: true });
    expect(await code(book(w.recruiter, w.a1.applicationId, at('15:00'), '30', { type: 'video' }))).toBe('room_unavailable');
    expect(await constraintOf(rows(w.recruiter, sql`update recruitment_interview set interview_type = 'video' where id = ${replacement}::uuid`))).toBe('recruitment_interview_place_ck');
    expect(await constraintOf(rows(w.recruiter, sql`update recruitment_interview set address_id = null where id = ${replacement}::uuid`))).toBe('recruitment_interview_place_ck');
    // In use: the room and the address are kept (service and database keys).
    expect(await code(deleteInterviewRoom(admin, roomId))).toBe('room_in_use');
    expect(await code(deleteInterviewAddress(admin, addressId))).toBe('address_in_use');
    expect(await constraintOf(rows(admin, sql`delete from recruitment_interview_room where id = ${roomId}::uuid`))).toBe('recruitment_interview_room_fk');
    // The interview details show the address to the team, the interviewer included.
    const cards = (await applicationInterviews(w.interviewer, w.a3.applicationId)).interviews;
    expect(cards.map((c) => c.place)).toEqual([{ addressName: 'QZW Tower', address: '1 Fictional Road', region: 'Kuala Lumpur', mapUrl: 'https://maps.example.test/qzw', roomName: 'Room QZW' }]);
    expect((await interviewPlaceSettings(admin, base.companyId)).addresses[0].rooms[0]).toMatchObject({ id: roomId, inUse: true, enabled: true });
  });

  it('a map link must be https (service and database CHECK)', async () => {
    await jobFormOptions(admin, base.companyId);
    for (const mapUrl of ['http://maps.example.test/qzw', 'javascript:alert(1)', 'https://user:pw@maps.example.test', 'ftp://maps.example.test']) {
      expect(await code(saveInterviewAddress(admin, { companyId: base.companyId, name: 'QZW Tower', address: '1 Fictional Road', region: 'Kuala Lumpur', mapUrl })), mapUrl).toBe('map_link_https');
      expect(await constraintOf(rows(admin, sql`insert into recruitment_interview_address (tenant_id, company_id, name, address, region, map_url, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'QZW Tower', 'x', 'y', ${mapUrl}, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`)), mapUrl)
        .toBe('recruitment_interview_address_map_https_ck');
    }
    const { id } = await saveInterviewAddress(admin, { companyId: base.companyId, name: 'QZW Tower', address: '1 Fictional Road', region: 'Kuala Lumpur', mapUrl: 'https://maps.example.test/?q=QZW' });
    expect(await constraintOf(rows(admin, sql`update recruitment_interview_address set map_url = 'http://maps.example.test' where id = ${id}::uuid`))).toBe('recruitment_interview_address_map_https_ck');
    const [row] = await owner.db.execute<{ map_url: string }>(sql`select map_url from recruitment_interview_address where id = ${id}::uuid`);
    expect(row.map_url).toBe('https://maps.example.test/?q=QZW');
    // An unused address goes with its unused rooms.
    await saveInterviewRoom(admin, { addressId: id, name: 'Room QZW', capacity: '4' });
    await deleteInterviewAddress(admin, id);
    expect(await owner.db.execute(sql`select 1 from recruitment_interview_room union all select 1 from recruitment_interview_address`)).toEqual([]);
  });
});

describe('case 125 — company deletion covers the new tables; forced row security and grants, none to PUBLIC', () => {
  it('restates the company delete as 5218 plus one block before the evaluation forms; leaves the candidate removal as it was', () => {
    const read = (file: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${file}`, import.meta.url)), 'utf8');
    const fn = (source: string, name: string) => {
      const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('END $$;', start) + 'END $$;'.length);
    };
    const m19 = read('5219_recruitment_interview_setup.sql');
    const b = fn(read('5218_recruitment_waiting_limits.sql'), 'app.recruitment_delete_company_setup').split('\n');
    const a = fn(m19, 'app.recruitment_delete_company_setup').split('\n');
    let i = 0;
    while (i < b.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    // 5218's lines, byte for byte, around ONE contiguous added block.
    expect(i + j).toBe(b.length);
    expect(b.length).toBeGreaterThan(90);
    const added = a.slice(i, a.length - j);
    expect(added.filter((l) => /DELETE FROM/.test(l)).map((l) => l.trim().split(' ')[2])).toEqual([
      'public.recruitment_interview_question_link', 'public.recruitment_interview_question', 'public.recruitment_interviewer_group_member',
      'public.recruitment_interviewer_group', 'public.recruitment_interview_room', 'public.recruitment_interview_address',
    ]);
    expect(added.every((l) => /^\s*--|DELETE FROM public\.recruitment_interview|GET DIAGNOSTICS n = ROW_COUNT; removed := removed \+ n;$/.test(l)), added.join('\n')).toBe(true);
    // The links go before the evaluation forms they name.
    expect(a.findIndex((l) => l.includes('DELETE FROM public.recruitment_interview_question_link'))).toBeLessThan(a.findIndex((l) => l.includes('DELETE FROM public.recruitment_evaluation_form')));
    expect(m19).not.toContain('recruitment_destroy_candidate(p_candidate');
    // The trailing REVOKE/GRANT are 5218's.
    expect(m19.trimEnd().endsWith('REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;')).toBe(true);
    const journal = JSON.parse(read('meta/_journal.json')) as { entries: { idx: number; when: number; tag: string }[] };
    const k = journal.entries.findIndex((e) => e.tag === '5219_recruitment_interview_setup');
    expect(journal.entries[k]).toMatchObject({ idx: 4619, when: 1793330004919 });
    expect(journal.entries[k - 1]).toMatchObject({ tag: '5218_recruitment_waiting_limits', idx: 4618 });
  });

  it('forced row security, explicit grants to the app role, none to PUBLIC', async () => {
    const meta = await owner.db.execute<{ relname: string; rls: boolean; forced: boolean; public_grants: number; s: boolean; i: boolean; u: boolean; d: boolean }>(sql`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0) as public_grants,
        has_table_privilege('ai_hr_app', c.oid, 'SELECT') as s, has_table_privilege('ai_hr_app', c.oid, 'INSERT') as i,
        has_table_privilege('ai_hr_app', c.oid, 'UPDATE') as u, has_table_privilege('ai_hr_app', c.oid, 'DELETE') as d
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${SETUP_TABLES.join(',')}}`}::text[]) order by c.relname`);
    expect(meta).toEqual([
      { relname: 'recruitment_interview_address', rls: true, forced: true, public_grants: 0, s: true, i: true, u: true, d: true },
      { relname: 'recruitment_interview_question', rls: true, forced: true, public_grants: 0, s: true, i: true, u: true, d: true },
      { relname: 'recruitment_interview_question_link', rls: true, forced: true, public_grants: 0, s: true, i: true, u: false, d: true },
      { relname: 'recruitment_interview_room', rls: true, forced: true, public_grants: 0, s: true, i: true, u: true, d: true },
      { relname: 'recruitment_interviewer_group', rls: true, forced: true, public_grants: 0, s: true, i: true, u: true, d: true },
      { relname: 'recruitment_interviewer_group_member', rls: true, forced: true, public_grants: 0, s: true, i: true, u: false, d: true },
    ]);
    // The exclusion constraint exists on the interviews with its WHERE (rooms only, cancelled interviews excluded).
    const [ex] = await owner.db.execute<{ def: string }>(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'recruitment_interview_room_no_overlap'`);
    expect(ex.def).toMatch(/^EXCLUDE USING gist \(room_id WITH =, app\.recruitment_interview_period\(starts_at, duration_minutes\) WITH &&\) WHERE \(+room_id IS NOT NULL\)? AND \(?cancelled_at IS NULL\)+$/);
    // The period is half-open [start, start + minutes), the same whatever the session time zone (IMMUTABLE).
    const [period] = await owner.db.execute<{ vol: string; starts: boolean; minutes: number; lower_inc: boolean; upper_inc: boolean }>(sql`
      select p.provolatile as vol, lower(r) = '2031-03-04 10:00+08'::timestamptz as starts, (extract(epoch from upper(r) - lower(r)) / 60)::int as minutes,
        lower_inc(r) as lower_inc, upper_inc(r) as upper_inc
      from pg_proc p, app.recruitment_interview_period('2031-03-04 10:00+08'::timestamptz, 90) r where p.proname = 'recruitment_interview_period'`);
    expect(period).toEqual({ vol: 'i', starts: true, minutes: 90, lower_inc: true, upper_inc: false });
  });

  it('deleting a company with only setup removes its groups, questions, links, addresses and rooms (every row counted); a company with jobs refuses', async () => {
    const w = await world();
    await interviewSettings(admin, otherCompanyId);
    const [{ id: otherForm }] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_evaluation_form where company_id = ${otherCompanyId}::uuid and is_default`);
    await saveInterviewerGroup(admin, { companyId: otherCompanyId, name: 'QZW Other panel', memberIds: [w.outsider.userId] });
    await saveInterviewQuestion(admin, { companyId: otherCompanyId, title: 'QZW Other question', formIds: [otherForm] });
    await place(w, otherCompanyId, 'QZW Other tower');
    const setupRows = async (companyId: string) => {
      let n = 0;
      for (const t of SETUP_TABLES) n += (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(t)} where company_id = ${companyId}::uuid`))[0].n;
      return n;
    };
    expect(await setupRows(otherCompanyId)).toBe(6);
    // Independently: every row of the company in every recruitment table with a company_id column, except a process's ordered stages
    // (ON DELETE CASCADE, not counted by the function).
    const tables = await owner.db.execute<{ t: string }>(sql`select c.table_name as t from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'company_id' and c.table_name like 'recruitment\\_%' and c.table_name <> 'recruitment_process_stage' order by 1`);
    expect(tables.map((r) => r.t)).toEqual(expect.arrayContaining(SETUP_TABLES));
    let before = 0;
    for (const { t } of tables) before += (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(t)} where company_id = ${otherCompanyId}::uuid`))[0].n;
    const [removed] = await withTenant(adminCtx(base), (tx) => tx.execute<{ n: number }>(sql`select app.recruitment_delete_company_setup(${otherCompanyId}::uuid) as n`));
    expect(Number(removed.n)).toBe(before);
    expect(await setupRows(otherCompanyId)).toBe(0);
    // The company with jobs still refuses (retained history), and its set-up stays.
    await place(w);
    expect(await code(withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${base.companyId}::uuid)`)))).toBe('23503');
    expect(await setupRows(base.companyId)).toBe(2);
    // The AI Centre's recruitment read stays counts only.
    const counts = await recruitmentPipelineCounts(admin);
    expect(JSON.stringify(counts)).not.toMatch(/QZW|room|address|question/i);
  });
});

describe('slice 18 review — closing an application frees its rooms; interviewers only while active; the migration\'s own guards', () => {
  const reasonOf = async () => (await owner.db.execute<{ id: string }>(sql`select id from recruitment_archive_reason
    where company_id = ${base.companyId}::uuid and displayed order by position limit 1`))[0].id;
  const cancelledBy = async (interviewId: string) => (await owner.db.execute<{ by: string | null }>(sql`
    select cancelled_by_user_id as by from recruitment_interview where id = ${interviewId}::uuid`))[0].by;

  it('rejecting (by the recruiter, and by a hiring manager who does not operate the job) cancels the future interviews only; the slot is free', async () => {
    const w = await world();
    const { roomId } = await place(w);
    const manager = await login('QZW Manager');
    await addJobMember(admin, w.j, 'hiring_manager', manager.userId);
    const book = (applicationId: string, startsAt: string) =>
      scheduleInterview(w.recruiter, { applicationId, type: 'onsite', startsAt, durationMinutes: '60', interviewerIds: [w.interviewer.userId], roomId });
    const { id: futureA } = await book(w.a1.applicationId, at('10:00'));
    const { id: pastA } = await book(w.a1.applicationId, '2024-05-06T10:00');
    const { id: futureC } = await book(w.a3.applicationId, at('14:00'));
    expect(await code(book(w.a2.applicationId, at('10:30')))).toBe('room_booked');
    // A hiring manager cannot change an interview of an ACTIVE application directly (not an operator).
    expect(await code(rows(manager, sql`update recruitment_interview set cancelled_at = now(), cancelled_by_user_id = ${manager.userId}::uuid where id = ${futureC}::uuid`)))
      .toBe('42501');
    const reason = await reasonOf();
    await rejectApplication(w.recruiter, w.a1.applicationId, reason);
    expect(await cancelledBy(futureA)).toBe(w.recruiter.userId);
    expect(await cancelledBy(pastA)).toBeNull(); // a held interview is history
    expect(await code(book(w.a2.applicationId, at('10:30')))).toBe('ok');
    // The hiring manager rejects A3: its future interview is cancelled as the manager, and its slot is free.
    await rejectApplication(manager, w.a3.applicationId, reason);
    expect(await cancelledBy(futureC)).toBe(manager.userId);
    expect(await code(scheduleInterview(w.recruiter2, { applicationId: w.o1.applicationId, type: 'onsite', startsAt: at('14:30'), interviewerIds: [w.interviewer.userId], roomId })))
      .toBe('ok');
    // A future interview left open on a closed application (made here by the owner, past the guards): the manager's direct cancel
    // with a backdated time and someone else as updater gets the database's now() and the manager as updater.
    const { id: open } = await book(w.a2.applicationId, at('16:00'));
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state = 'archived', archive_reason_id = ${reason}::uuid, stage_left_at_archive = current_stage_id where id = ${w.a2.applicationId}::uuid`;
    });
    await rows(manager, sql`update recruitment_interview set cancelled_at = '2020-01-02T03:04:05Z', cancelled_by_user_id = ${manager.userId}::uuid,
      updated_at = '2020-01-02T03:04:05Z', updated_by_user_id = ${w.recruiter.userId}::uuid where id = ${open}::uuid`);
    const [audit] = await owner.db.execute<{ fresh: boolean; same: boolean; by: string; updater: string }>(sql`select cancelled_at > now() - interval '5 minutes' as fresh,
      cancelled_at = updated_at as same, cancelled_by_user_id as by, updated_by_user_id as updater from recruitment_interview where id = ${open}::uuid`);
    expect(audit).toEqual({ fresh: true, same: true, by: manager.userId, updater: manager.userId });
    // The manager's update right is ONLY that cancellation: moving or reopening an interview of a closed application is refused.
    expect(await code(rows(manager, sql`update recruitment_interview set starts_at = starts_at + interval '1 day' where id = ${pastA}::uuid`))).toBe('42501');
    // Events say why.
    const [ev] = await owner.db.execute<{ payload: { reason: string } }>(sql`select payload from domain_event where aggregate_id = ${futureC}::uuid
      and event_type = 'recruitment-interview.cancelled'`);
    expect(ev.payload.reason).toBe('application_closed');
  });

  it('archiving from the "Suggested to archive" list (the bulk path) frees every selected application\'s future rooms', async () => {
    const w = await world();
    const { roomId } = await place(w);
    const first = (await recruitmentSettings(admin, base.companyId)).stages.find((x) => x.name === 'Application Review')!.id;
    await saveWaitingRule(admin, { companyId: base.companyId, stageId: first, remindDays: '1', archiveDays: '2', dayKind: 'calendar' });
    const book = (applicationId: string, startsAt: string) =>
      scheduleInterview(w.recruiter, { applicationId, type: 'onsite', startsAt, durationMinutes: '60', interviewerIds: [w.interviewer.userId], roomId });
    const { id: i1 } = await book(w.a1.applicationId, at('09:00'));
    const { id: i2 } = await book(w.a2.applicationId, at('10:00'));
    // Fixture time travel: both applications entered their stage 20 days ago (owner, past the append-only history guard).
    for (const a of [w.a1.applicationId, w.a2.applicationId]) {
      await owner.client.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update recruitment_application set applied_at = now() - interval '20 days', updated_at = now() - interval '20 days' where id = ${a}::uuid`;
        await tx`update recruitment_application_event set occurred_at = now() - interval '20 days' where application_id = ${a}::uuid`;
      });
    }
    const result = await archiveSuggestedApplications(w.recruiter, { jobId: w.j, applicationIds: [w.a1.applicationId, w.a2.applicationId], archiveReasonId: await reasonOf() });
    expect(sorted(result.archived)).toEqual(sorted([w.a1.applicationId, w.a2.applicationId]));
    expect([await cancelledBy(i1), await cancelledBy(i2)]).toEqual([w.recruiter.userId, w.recruiter.userId]);
    expect(await code(book(w.a3.applicationId, at('09:30')))).toBe('ok');
    // The operator still sees Cancel only where it can matter: nothing is left open on the archived applications.
    expect((await applicationInterviews(w.recruiter, w.a1.applicationId)).interviews.map((c) => c.canCancel)).toEqual([false]);
  });

  it('interviewers are added only while the application is active (service and the restated 5202 guard); Cancel stays for future interviews', async () => {
    const w = await world();
    const { id: past } = await scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'video', startsAt: '2024-05-06T10:00', interviewerIds: [w.interviewer.userId] });
    const { id: future } = await scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'video', startsAt: at('10:00'), interviewerIds: [w.interviewer.userId] });
    const before = await applicationInterviews(w.recruiter, w.a1.applicationId);
    expect(before.interviews.map((c) => c.canCancel)).toEqual([true, true]);
    await rejectApplication(w.recruiter, w.a1.applicationId, await reasonOf());
    expect(await code(addInterviewers(w.recruiter, past, { interviewerIds: [w.p1.userId] }))).toBe('application_closed');
    expect(await constraintOf(rows(w.recruiter, sql`insert into recruitment_interview_interviewer (tenant_id, company_id, job_id, application_id, interview_id, app_user_id, created_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${w.j}::uuid, ${w.a1.applicationId}::uuid, ${past}::uuid, ${w.p1.userId}::uuid, ${w.recruiter.userId}::uuid)`)))
      .toBe('recruitment_interview_interviewer_application_active');
    expect(await interviewersOf(past)).toEqual([w.interviewer.userId]);
    // P1 gained no read of the candidate.
    expect(await rows(w.p1, sql`select 1 from recruitment_application where id = ${w.a1.applicationId}::uuid`)).toEqual([]);
    // After closing: the future interview was cancelled; the held one shows no Cancel.
    const after = await applicationInterviews(w.recruiter, w.a1.applicationId);
    expect(after.interviews.map((c) => [c.id, c.cancelled, c.canCancel])).toEqual([[past, false, false], [future, true, false]]);
    // A future interview left open on a closed application (not possible through the pack; made here by the owner) offers Cancel.
    const { id: later } = await scheduleInterview(w.recruiter, { applicationId: w.a2.applicationId, type: 'video', startsAt: at('11:00'), interviewerIds: [w.interviewer.userId] });
    const reason = await reasonOf();
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state = 'archived', archive_reason_id = ${reason}::uuid, stage_left_at_archive = current_stage_id where id = ${w.a2.applicationId}::uuid`;
    });
    expect((await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id = ${w.a2.applicationId}::uuid`))[0].state).toBe('archived');
    expect((await applicationInterviews(w.recruiter, w.a2.applicationId)).interviews.find((c) => c.id === later)!.canCancel).toBe(true);
    expect((await applicationInterviews(w.interviewer, w.a2.applicationId)).interviews.find((c) => c.id === later)!.canCancel).toBe(false);
    await cancelInterview(w.recruiter, later);
    expect(await cancelledBy(later)).toBe(w.recruiter.userId);
  });

  it('restates 5202\'s interviewer guard byte for byte plus one check, and refuses to apply over existing interviews', async () => {
    const read = (file: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${file}`, import.meta.url)), 'utf8');
    const m19 = read('5219_recruitment_interview_setup.sql');
    const slice = (src: string, head: string) => { const at0 = src.indexOf(head); expect(at0, head).toBeGreaterThan(-1); return src.slice(at0, src.indexOf('END $$;', at0) + 'END $$;'.length); };
    const b = slice(read('5202_recruitment_team_interviews.sql'), 'CREATE FUNCTION app.recruitment_guard_interviewer()').split('\n');
    const a = slice(m19, 'CREATE OR REPLACE FUNCTION app.recruitment_guard_interviewer()').split('\n');
    expect(a[0]).toBe(b[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    let i = 1;
    while (i < b.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    expect(i + j).toBe(b.length);
    expect(b.length).toBeGreaterThan(8);
    const added = a.slice(i, a.length - j);
    expect(added.length).toBe(5);
    expect(added.join('\n')).toMatch(/a\.state = 'active'/);
    expect(added.join('\n')).not.toMatch(/DELETE|UPDATE public\./);
    // The precondition: run 5219's own check against a database that holds an interview (rolled back).
    const w = await world();
    await scheduleInterview(w.recruiter, { applicationId: w.a1.applicationId, type: 'video', startsAt: at('10:00'), interviewerIds: [w.interviewer.userId] });
    const start = m19.indexOf('ALTER TABLE public.recruitment_interview NO FORCE ROW LEVEL SECURITY;');
    const end = m19.indexOf('ALTER TABLE public.recruitment_interview FORCE ROW LEVEL SECURITY;', start) + 'ALTER TABLE public.recruitment_interview FORCE ROW LEVEL SECURITY;'.length;
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(m19.indexOf('CREATE TABLE public.recruitment_interviewer_group'));
    const refused = await owner.client.begin(async (tx) => { await tx.unsafe(m19.slice(start, end)); }).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(refused?.code).toBe('55000');
    expect(refused?.message).toMatch(/needs an empty recruitment_interview table/);
    // …and the installed table still forces row security.
    const [forced] = await owner.db.execute<{ f: boolean }>(sql`select relforcerowsecurity as f from pg_class where relname = 'recruitment_interview'`);
    expect(forced.f).toBe(true);
  });
});
