/**
 * Recruitment slice 12 against Postgres: acceptance cases 82–86 (docs/recruitment-reconstruction/specification.md "Slice 12
 * acceptance cases") through the service AND directly as the app role. Case 87 is the lead's rendered check. The pure rules
 * are test/recruitment-background-checks-rules.test.ts.
 *
 * Expected values are computed independently of packs/recruitment/background-checks.ts: from what each fixture step did, from
 * plain owner-connection SQL that ignores row security, and — for the stage rule and the Kuala Lumpur day boundary — from the
 * rule written out again here. Every person and value is fictional. Restricted values carry the LETTER sentinel QZX (no UUID,
 * timestamp or number can contain it), so its absence is meaningful; file bytes are searched as bytes.
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
  addApplication, addBackgroundCheck, addDefaultBackgroundCheckTypes, addJobMember, applicationBackgroundChecks, backgroundCheckCounts, backgroundCheckTypes,
  BELL_TIMEOUT_MS, cancelBackgroundCheck, candidateBoard, completeBackgroundCheck, createJob, deleteBackgroundCheckType, destroyCandidates, getBackgroundCheckFile,
  moveApplication, pendingRecruitmentTasks, recordBackgroundCheckAuthorisation, recruitmentPipelineCounts, recruitmentSettings, recruitmentTodos, rejectApplication,
  saveBackgroundCheckType, startBackgroundCheck, updateStage, RecruitmentError,
} from '../packs/recruitment/service';
import { applicationBackgroundChecksTx } from '../packs/recruitment/background-checks';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SENTINEL = 'QZX';
/** Timings and plans: printed, and also appended to $CHECKS_TIMING_LOG when set (passing tests' output is not shown). */
const report = (text: string) => {
  console.log(text);
  if (process.env.CHECKS_TIMING_LOG) appendFileSync(process.env.CHECKS_TIMING_LOG, `${text}\n`);
};
const NEW_TABLES = ['recruitment_background_check', 'recruitment_background_check_detail', 'recruitment_background_check_file',
  'recruitment_background_check_type', 'recruitment_background_check_type_link'];
const RESTRICTED = ['recruitment_background_check_detail', 'recruitment_background_check_file'];
const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
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
/** The guard's named rule (RAISE … CONSTRAINT) from a database error or its causes. */
const constraintOf = async (operation: Promise<unknown>) => {
  const e = await operation.then(() => null, (x: unknown) => x);
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  return e === null ? 'ok' : pgSqlState(e) ?? 'unknown';
};
type Login = SessionContext & { userId: string };
async function login(name: string, companyId = base.companyId): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
let seq = 0;
/** A job with a recruiter, an assistant, a hiring manager and an interviewer; plus a bystander and another job's recruiter. */
async function team() {
  const n = ++seq;
  const [recruiter, assistant, hm, interviewer, bystander, otherRecruiter] = await Promise.all([
    login(`Fictional Recruiter ${n}`), login(`Fictional Assistant ${n}`), login(`Fictional Manager ${n}`), login(`Fictional Interviewer ${n}`),
    login(`Fictional Bystander ${n}`), login(`Fictional Other Recruiter ${n}`),
  ]);
  const job = { companyId: base.companyId, jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time' };
  const { id: jobId } = await createJob(admin, { ...job, title: 'Fictional analyst', recruiterUserId: recruiter.userId });
  await addJobMember(admin, jobId, 'assistant', assistant.userId);
  await addJobMember(admin, jobId, 'hiring_manager', hm.userId);
  await addJobMember(admin, jobId, 'interviewer', interviewer.userId);
  await createJob(admin, { ...job, title: 'Fictional other role', recruiterUserId: otherRecruiter.userId });
  return { jobId, recruiter, assistant, hm, interviewer, bystander, otherRecruiter };
}
type Team = Awaited<ReturnType<typeof team>>;
const apply = async (t: Team, name = `Fictional Candidate ${++seq}`) => addApplication(t.recruiter, { jobId: t.jobId, fullName: name, email: `c${++seq}@example.test` });
/** The job's process stages in order with type and name (owner connection, plain SQL). */
async function stagesOf(jobId: string) {
  return owner.db.execute<{ id: string; name: string; type: string; seed: string | null; position: number; enabled: boolean }>(sql`select ps.stage_id as id, st.name,
    st.stage_type as type, st.seed_key as seed, ps.position, st.enabled from recruitment_job_opening j join recruitment_process_stage ps on ps.process_id = j.process_id
    join recruitment_stage st on st.id = ps.stage_id where j.id = ${jobId}::uuid order by ps.position`);
}
async function atOffer(t: Team, name?: string) {
  const a = await apply(t, name);
  const offer = (await stagesOf(t.jobId)).find((x) => x.type === 'offer')!;
  await moveApplication(t.recruiter, a.applicationId, offer.id);
  return a;
}
const typeIds = async () => (await owner.db.execute<{ id: string; name: string }>(sql`select id, name from recruitment_background_check_type
  where company_id = ${base.companyId}::uuid order by name`));
const checkRow = async (id: string) => (await owner.db.execute<{ status: string; outcome: string | null; started_at: string | null; completed_at: string | null; cancelled_at: string | null }>(sql`
  select status, outcome, started_at::text, completed_at::text, cancelled_at::text from recruitment_background_check where id = ${id}::uuid`))[0];
const checkOf = async (applicationId: string) => (await owner.db.execute<{ id: string }>(sql`select id from recruitment_background_check
  where application_id = ${applicationId}::uuid order by created_at desc limit 1`))[0].id;
/** An added check with the authorisation recorded and started, then completed with every restricted value carrying the sentinel. */
async function fullCheck(t: Team, applicationId: string, marker = SENTINEL) {
  const types = await typeIds();
  await addBackgroundCheck(t.recruiter, { applicationId, typeIds: [types[0].id, types[1].id], provider: `Fictional ${marker}PROVIDER Sdn Bhd`, providerReference: `${marker}REF-1` });
  const id = await checkOf(applicationId);
  await recordBackgroundCheckAuthorisation(t.assistant, id, { authorisedOn: todayInKualaLumpur(), method: 'signed_form', start: 'on' },
    { fileName: `${marker.toLowerCase()}auth.pdf`, content: pdf(`${marker}AUTHBYTES`), permissionConfirmed: true });
  await completeBackgroundCheck(t.recruiter, id, { outcome: 'concerns_found', summary: `${marker}SUMMARY of fictional findings` },
    { fileName: `${marker.toLowerCase()}report.pdf`, content: pdf(`${marker}REPORTBYTES`), permissionConfirmed: true });
  return id;
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
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
  await addDefaultBackgroundCheckTypes(admin, base.companyId);
});

describe('case 82 — who manages types, who records and reads checks', () => {
  it('only administrators manage types; defaults are offered once; a type in use is disabled, not deleted', async () => {
    const t = await team();
    // The six defaults, added once (beforeEach), not again.
    expect((await typeIds()).map((x) => x.name)).toEqual(['Credit', 'Criminal record', 'Education', 'Employment history', 'Identity', 'Professional licence']);
    expect(await addDefaultBackgroundCheckTypes(admin, base.companyId)).toEqual({ added: 0 });
    const catalog = await backgroundCheckTypes(admin, base.companyId);
    expect(catalog.defaultsOffered).toBe(false);
    expect(catalog.types).toHaveLength(6);
    for (const who of [t.recruiter, t.assistant, t.hm, t.interviewer, t.bystander]) {
      expect(await code(backgroundCheckTypes(who, base.companyId))).toBe('forbidden');
      expect(await code(saveBackgroundCheckType(who, { companyId: base.companyId, name: 'Fictional type' }))).toBe('forbidden');
      expect(await code(addDefaultBackgroundCheckTypes(who, base.companyId))).toBe('forbidden');
      expect(await code(rows(who, sql`insert into recruitment_background_check_type (tenant_id, company_id, name, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional direct', ${who.userId}::uuid, ${who.userId}::uuid)`))).toBe('42501');
      // A team member reads the names (the catalogue carries no candidate data); nobody outside a team reads anything.
      expect((await rows(who, sql`update recruitment_background_check_type set enabled = false returning id`))).toHaveLength(0);
    }
    expect(await rows(t.bystander, sql`select id from recruitment_background_check_type`)).toHaveLength(0);
    expect(await rows(t.hm, sql`select id from recruitment_background_check_type`)).toHaveLength(6);
    // Administrators: add, rename, disable; a name is unique in the company (any letter case).
    const { id: extra } = await saveBackgroundCheckType(admin, { companyId: base.companyId, name: 'Fictional sanctions list', description: 'Fictional description' });
    expect(await code(saveBackgroundCheckType(admin, { companyId: base.companyId, name: 'CREDIT' }))).toBe('name_taken');
    await saveBackgroundCheckType(admin, { id: extra, name: 'Fictional sanctions', enabled: false });
    expect((await owner.db.execute(sql`select name, enabled, updated_by_user_id from recruitment_background_check_type where id = ${extra}::uuid`))[0])
      .toEqual({ name: 'Fictional sanctions', enabled: false, updated_by_user_id: base.adminUserId });
    // Used: refused by the service and by the foreign key; unused: deleted.
    const a = await atOffer(t);
    const [credit] = await typeIds();
    await addBackgroundCheck(t.recruiter, { applicationId: a.applicationId, typeIds: [credit.id], provider: 'Fictional Screening' });
    expect(await code(deleteBackgroundCheckType(admin, credit.id))).toBe('type_in_use');
    expect(await code(rows(admin, sql`delete from recruitment_background_check_type where id = ${credit.id}::uuid`))).toBe('23503');
    expect(await code(deleteBackgroundCheckType(admin, extra))).toBe('ok');
    expect(await owner.db.execute(sql`select 1 from recruitment_background_check_type where id = ${extra}::uuid`)).toHaveLength(0);
    // A disabled type is not offered and cannot be chosen.
    await saveBackgroundCheckType(admin, { id: credit.id, name: 'Credit', enabled: false });
    expect((await applicationBackgroundChecks(t.recruiter, a.applicationId)).types.map((x) => x.name)).not.toContain('Credit');
    expect(await code(addBackgroundCheck(t.recruiter, { applicationId: a.applicationId, typeIds: [credit.id], provider: 'Fictional Screening' }))).toBe('check_type_unavailable');
  });

  it('operators and administrators record and read everything; hiring managers read type, status and outcome; nobody else anything', async () => {
    const t = await team();
    const a = await atOffer(t);
    const types = await typeIds();
    for (const who of [t.hm, t.interviewer, t.bystander, t.otherRecruiter]) {
      expect(await code(addBackgroundCheck(who, { applicationId: a.applicationId, typeIds: [types[0].id], provider: 'Fictional Screening' }))).toMatch(/^(forbidden|not_found)$/);
      expect(await code(rows(who, sql`insert into recruitment_background_check (tenant_id, company_id, job_id, application_id, created_by_user_id, status_changed_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${a.applicationId}::uuid, ${who.userId}::uuid, ${who.userId}::uuid)`))).toBe('42501');
    }
    expect(await owner.db.execute(sql`select 1 from recruitment_background_check`)).toHaveLength(0);
    // The recruiter, the assistant and an administrator each add one.
    for (const who of [t.recruiter, t.assistant, admin]) {
      expect(await code(addBackgroundCheck(who, { applicationId: a.applicationId, typeIds: [types[1].id], provider: 'Fictional Screening' }))).toBe('ok');
    }
    const added = await owner.db.execute<{ created_by_user_id: string; status: string }>(sql`select created_by_user_id, status from recruitment_background_check order by created_at`);
    expect(added).toEqual([t.recruiter.userId, t.assistant.userId, base.adminUserId].map((u) => ({ created_by_user_id: u, status: 'awaiting_authorisation' })));
    const id = await checkOf(a.applicationId);
    // Changes: operators only, by the service and the tables.
    for (const who of [t.hm, t.interviewer, t.bystander, t.otherRecruiter]) {
      expect(await code(cancelBackgroundCheck(who, id, { reason: 'Fictional' }))).toMatch(/^(forbidden|not_found)$/);
      expect(await code(recordBackgroundCheckAuthorisation(who, id, { authorisedOn: todayInKualaLumpur(), method: 'email' }))).toMatch(/^(forbidden|not_found)$/);
      expect(await rows(who, sql`update recruitment_background_check set status = 'cancelled' where id = ${id}::uuid returning id`)).toHaveLength(0);
      expect(await rows(who, sql`update recruitment_background_check_detail set cancel_reason = 'Fictional' returning check_id`)).toHaveLength(0);
    }
    expect((await checkRow(id)).status).toBe('awaiting_authorisation');
    // Reading: full for operators and administrators; type/status/outcome/dates for the hiring manager; refused for the rest.
    for (const who of [t.recruiter, t.assistant, admin]) {
      const view = await applicationBackgroundChecks(who, a.applicationId);
      expect(view.full).toBe(true);
      expect(view.checks).toHaveLength(3);
      expect(view.checks.every((c) => c.restricted?.provider === 'Fictional Screening')).toBe(true);
    }
    const hmView = await applicationBackgroundChecks(t.hm, a.applicationId);
    expect(hmView.full).toBe(false);
    expect(hmView.types).toEqual([]);
    expect(hmView.checks.map((c) => [c.status, c.types.map((x) => x.name), c.restricted, c.can])).toEqual(Array.from({ length: 3 }, () =>
      ['awaiting_authorisation', [types[1].name], null, { authorise: false, start: false, complete: false, cancel: false }]));
    for (const who of [t.interviewer, t.bystander, t.otherRecruiter]) expect(await code(applicationBackgroundChecks(who, a.applicationId))).toMatch(/^(forbidden|not_found)$/);
    // Directly: the hiring manager reads the check rows and their types, never the restricted tables; the others read nothing.
    expect(await rows(t.hm, sql`select id from recruitment_background_check`)).toHaveLength(3);
    expect(await rows(t.hm, sql`select check_id from recruitment_background_check_type_link`)).toHaveLength(3);
    for (const table of RESTRICTED) expect(await rows(t.hm, sql`select 1 from ${sql.identifier(table)}`), table).toHaveLength(0);
    for (const who of [t.interviewer, t.bystander, t.otherRecruiter]) {
      for (const table of NEW_TABLES.filter((x) => x !== 'recruitment_background_check_type')) expect(await rows(who, sql`select 1 from ${sql.identifier(table)}`), table).toHaveLength(0);
    }
    expect(await rows(t.recruiter, sql`select check_id from recruitment_background_check_detail`)).toHaveLength(3);
  });
});

describe('case 83 — stage rule, authorisation first, outcome to complete, final states', () => {
  it('a check is added only on an active application at or after the first Offer-type stage, or at the seeded Background check stage', async () => {
    const t = await team();
    const [type] = await typeIds();
    const stages = await stagesOf(t.jobId);
    // Names are editable and never decide: an early stage renamed "BACKGROUND pre-screen" is still refused, and the seeded
    // Background check stage renamed "Vetting" is still accepted (by its seed key).
    const early = stages.find((x) => x.type === 'test')!;
    await updateStage(admin, early.id, { name: 'BACKGROUND pre-screen', type: 'test', enabled: 'on' });
    const seeded = stages.find((x) => x.seed === 'background_check')!;
    await updateStage(admin, seeded.id, { name: 'Vetting', type: seeded.type, enabled: 'on' });
    const now = await stagesOf(t.jobId);
    expect(now.find((x) => x.id === early.id)?.name).toBe('BACKGROUND pre-screen');
    expect(now.find((x) => x.id === seeded.id)?.name).toBe('Vetting');
    const offerAt = Math.min(...now.filter((x) => x.type === 'offer').map((x) => x.position));
    // The rule written out again: Offer type, at/after the first Offer-type position, or the seeded Background check stage.
    const expected = (x: (typeof now)[number]) => x.type === 'offer' || x.position >= offerAt || x.seed === 'background_check';
    expect(expected(now.find((x) => x.id === early.id)!)).toBe(false);
    expect(now.filter(expected).length).toBeGreaterThan(2);
    expect(now.filter((x) => !expected(x)).length).toBeGreaterThan(2);
    const a = await apply(t);
    for (const st of now.filter((x) => x.enabled)) {
      const [cur] = await owner.db.execute<{ stage: string }>(sql`select current_stage_id as stage from recruitment_application where id = ${a.applicationId}::uuid`);
      if (cur.stage !== st.id) await moveApplication(admin, a.applicationId, st.id);
      expect((await applicationBackgroundChecks(t.recruiter, a.applicationId)).stageAllowed, st.name).toBe(expected(st));
      expect(await code(addBackgroundCheck(t.recruiter, { applicationId: a.applicationId, typeIds: [type.id], provider: 'Fictional Screening' })), st.name)
        .toBe(expected(st) ? 'ok' : 'check_stage');
      // Directly: the guard names its stage rule.
      if (!expected(st)) {
        expect(await constraintOf(rows(t.recruiter, sql`insert into recruitment_background_check (tenant_id, company_id, job_id, application_id, created_by_user_id, status_changed_by_user_id)
          values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${a.applicationId}::uuid, ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid)`)), st.name)
          .toBe('recruitment_background_check_stage');
      }
    }
    expect((await owner.db.execute(sql`select 1 from recruitment_background_check where application_id = ${a.applicationId}::uuid`)).length)
      .toBe(now.filter((x) => x.enabled && expected(x)).length);
    // The renamed early stage is walked and refused (non-vacuous).
    expect(now.find((x) => x.id === early.id)?.enabled).toBe(true);
    // An archived application takes no new check, by the service and the guard.
    const b = await atOffer(t);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, b.applicationId, reason.id);
    expect(await code(addBackgroundCheck(t.recruiter, { applicationId: b.applicationId, typeIds: [type.id], provider: 'Fictional Screening' }))).toBe('application_closed');
    expect(await constraintOf(rows(t.recruiter, sql`insert into recruitment_background_check (tenant_id, company_id, job_id, application_id, created_by_user_id, status_changed_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${b.applicationId}::uuid, ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid)`)))
      .toBe('recruitment_background_check_application_active');
  });

  it('In progress needs the recorded authorisation; Completed needs an outcome; Completed and Cancelled are final', async () => {
    const t = await team();
    const a = await atOffer(t);
    const [type, type2] = await typeIds();
    await addBackgroundCheck(t.recruiter, { applicationId: a.applicationId, typeIds: [type.id], provider: 'Fictional Screening' });
    const id = await checkOf(a.applicationId);
    // Types are fixed when the check is added.
    expect(await constraintOf(rows(t.recruiter, sql`insert into recruitment_background_check_type_link (check_id, type_id, tenant_id, company_id, job_id, application_id)
      values (${id}::uuid, ${type2.id}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${a.applicationId}::uuid)`)))
      .toBe('recruitment_background_check_types_fixed');
    // A cancellation reason written without cancelling cannot commit (deferred check), and nothing of it stays.
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check_detail set cancel_reason = 'Fictional premature reason' where check_id = ${id}::uuid`)))
      .toBe('recruitment_background_check_cancel_reason_with_cancel');
    expect((await owner.db.execute<{ r: string | null }>(sql`select cancel_reason as r from recruitment_background_check_detail where check_id = ${id}::uuid`))[0].r).toBeNull();
    // A check without its detail row cannot commit either.
    expect(await constraintOf(rows(t.recruiter, sql`insert into recruitment_background_check (tenant_id, company_id, job_id, application_id, created_by_user_id, status_changed_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${a.applicationId}::uuid, ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid)`)))
      .toBe('recruitment_background_check_detail_required');
    expect(await owner.db.execute(sql`select 1 from recruitment_background_check where application_id = ${a.applicationId}::uuid`)).toHaveLength(1);
    // Nobody sets the system cancellation directly.
    expect(await code(rows(t.recruiter, sql`update recruitment_background_check set status = 'cancelled', system_cancel_reason = 'candidate_removed' where id = ${id}::uuid`))).toBe('42501');
    // No authorisation yet: neither the service nor a direct update starts it; nor does a jump to completed.
    expect(await code(startBackgroundCheck(t.recruiter, id))).toBe('authorisation_required');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check set status = 'in_progress' where id = ${id}::uuid`)))
      .toBe('recruitment_background_check_authorisation');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check set status = 'completed', outcome = 'clear' where id = ${id}::uuid`)))
      .toBe('recruitment_background_check_transition');
    expect(await code(completeBackgroundCheck(t.recruiter, id, { outcome: 'clear' }))).toBe('check_state');
    // A report cannot be attached before the check is in progress.
    expect(await constraintOf(rows(t.recruiter, sql`insert into recruitment_background_check_file (tenant_id, company_id, job_id, application_id, check_id, kind, file_name,
      mime_type, size_bytes, content, permission_confirmed, uploaded_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid,
      ${a.applicationId}::uuid, ${id}::uuid, 'report', 'fictional.pdf', 'application/pdf', 4, '\\x25504446'::bytea, true, ${t.recruiter.userId}::uuid)`)))
      .toBe('recruitment_background_check_file_status');
    // The authorisation: not in the future (Kuala Lumpur), a known method, then recorded once.
    const tomorrow = addDays(todayInKualaLumpur(), 1);
    expect(await code(recordBackgroundCheckAuthorisation(t.recruiter, id, { authorisedOn: tomorrow, method: 'email' }))).toBe('invalid_input');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check_detail set authorised_on = ${tomorrow}::date, authorisation_method = 'email',
      authorisation_recorded_by_user_id = ${t.recruiter.userId}::uuid, authorisation_recorded_at = now() where check_id = ${id}::uuid`)))
      .toBe('recruitment_background_check_authorisation_date');
    expect(await code(rows(t.recruiter, sql`update recruitment_background_check_detail set authorised_on = ${todayInKualaLumpur()}::date, authorisation_method = 'email',
      authorisation_recorded_by_user_id = ${t.assistant.userId}::uuid, authorisation_recorded_at = now() where check_id = ${id}::uuid`))).toBe('42501');
    await recordBackgroundCheckAuthorisation(t.recruiter, id, { authorisedOn: todayInKualaLumpur(), method: 'online_form' });
    expect((await checkRow(id)).status).toBe('awaiting_authorisation');
    expect(await code(recordBackgroundCheckAuthorisation(t.recruiter, id, { authorisedOn: todayInKualaLumpur(), method: 'email' }))).toBe('check_state');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check_detail set authorisation_method = 'email' where check_id = ${id}::uuid`)))
      .toBe('recruitment_background_check_authorisation_once');
    await startBackgroundCheck(t.assistant, id);
    const started = await checkRow(id);
    expect(started).toMatchObject({ status: 'in_progress', outcome: null, completed_at: null, cancelled_at: null });
    expect(started.started_at).not.toBeNull();
    // Completing needs an outcome (service, then the guard), and the outcome belongs to Completed only.
    expect(await code(completeBackgroundCheck(t.recruiter, id, { summary: 'Fictional' }))).toBe('missing_fields');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check set status = 'completed' where id = ${id}::uuid`))).toBe('recruitment_background_check_outcome');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check set outcome = 'clear' where id = ${id}::uuid`))).toBe('recruitment_background_check_transition');
    // A forged clock is replaced by the database's own.
    await rows(t.recruiter, sql`update recruitment_background_check set status = 'completed', outcome = 'clear', completed_at = '2001-01-01T00:00:00Z' where id = ${id}::uuid`);
    const done = await checkRow(id);
    expect(done).toMatchObject({ status: 'completed', outcome: 'clear', started_at: started.started_at });
    expect(done.completed_at!.startsWith('2001')).toBe(false);
    // Final: nothing changes any more, by the service or directly.
    expect(await code(cancelBackgroundCheck(t.recruiter, id, { reason: 'Fictional' }))).toBe('check_closed');
    expect(await code(completeBackgroundCheck(t.recruiter, id, { outcome: 'concerns_found' }))).toBe('check_closed');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check set status = 'in_progress', outcome = null where id = ${id}::uuid`)))
      .toBe('recruitment_background_check_final');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check_detail set summary = 'Fictional late summary' where check_id = ${id}::uuid`)))
      .toBe('recruitment_background_check_final');
    expect(await code(rows(admin, sql`delete from recruitment_background_check where id = ${id}::uuid`))).toBe('42501');
    // Cancelled: from Awaiting authorisation, with a reason; final too.
    await addBackgroundCheck(t.recruiter, { applicationId: a.applicationId, typeIds: [type.id], provider: 'Fictional Screening' });
    const second = await checkOf(a.applicationId);
    expect(second).not.toBe(id);
    expect(await code(cancelBackgroundCheck(t.recruiter, second, { reason: ' ' }))).toBe('missing_fields');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check set status = 'cancelled' where id = ${second}::uuid`)))
      .toBe('recruitment_background_check_cancel_reason');
    await cancelBackgroundCheck(t.recruiter, second, { reason: 'Fictional: the candidate withdrew' });
    expect(await checkRow(second)).toMatchObject({ status: 'cancelled', outcome: null, started_at: null, completed_at: null });
    expect(await code(recordBackgroundCheckAuthorisation(t.recruiter, second, { authorisedOn: todayInKualaLumpur(), method: 'email' }))).toBe('check_closed');
    expect(await constraintOf(rows(t.recruiter, sql`update recruitment_background_check set status = 'in_progress' where id = ${second}::uuid`))).toBe('recruitment_background_check_final');
    // Every status change is in the history with ids and status codes only.
    const events = await owner.db.execute<{ event_type: string; payload: Record<string, unknown> }>(sql`select event_type, payload from domain_event
      where aggregate_id = ${a.applicationId}::uuid and event_type like 'recruitment-application.background-check-%' order by occurred_at, id`);
    expect(events.filter((e) => e.event_type.endsWith('status-changed')).map((e) => [e.payload.checkId, e.payload.from, e.payload.to])).toEqual([
      // (The completion above was a direct update, which the history does not see; the service writes the event.)
      [id, 'awaiting_authorisation', 'in_progress'], [second, 'awaiting_authorisation', 'cancelled'],
    ]);
  });
});

describe('case 84 — restricted values never reach hiring managers or anyone else; downloads are audited without names', () => {
  it('sentinel absent from service results, page data and direct reads; downloads audited with ids only', async () => {
    const t = await team();
    const a = await atOffer(t, 'Fictional Candidate Eve');
    const id = await fullCheck(t, a.applicationId);
    const b = await atOffer(t);
    await addBackgroundCheck(t.recruiter, { applicationId: b.applicationId, typeIds: [(await typeIds())[2].id], provider: `Fictional ${SENTINEL}OTHER` });
    await cancelBackgroundCheck(t.recruiter, await checkOf(b.applicationId), { reason: `${SENTINEL}REASON fictional` });
    // A live to-do: the recruiter's check awaiting authorisation, with sentinel values in its restricted details.
    const live = await atOffer(t, 'Fictional Candidate Live');
    await addBackgroundCheck(t.recruiter, { applicationId: live.applicationId, typeIds: [(await typeIds())[3].id], provider: `Fictional ${SENTINEL}LIVE`, providerReference: `${SENTINEL}LIVEREF` });
    const liveId = await checkOf(live.applicationId);
    // The operators see every restricted value (non-vacuous).
    const full = await applicationBackgroundChecks(t.recruiter, a.applicationId);
    const r = full.checks[0].restricted!;
    expect(r).toMatchObject({ provider: `Fictional ${SENTINEL}PROVIDER Sdn Bhd`, providerReference: `${SENTINEL}REF-1`, summary: `${SENTINEL}SUMMARY of fictional findings` });
    expect(r.authorisation).toMatchObject({ on: todayInKualaLumpur(), method: 'signed_form' });
    expect(r.files.map((f) => [f.kind, f.fileName])).toEqual([['authorisation', 'qzxauth.pdf'], ['report', 'qzxreport.pdf']]);
    expect(JSON.stringify(full)).toContain(SENTINEL);
    // The hiring manager's section: type, status, outcome and dates only.
    const hm = await applicationBackgroundChecks(t.hm, a.applicationId);
    expect(hm.checks.map((c) => ({ status: c.status, outcome: c.outcome, types: c.types.length, restricted: c.restricted }))).toEqual([
      { status: 'completed', outcome: 'concerns_found', types: 2, restricted: null },
    ]);
    expect(JSON.stringify(hm).toUpperCase()).not.toContain(SENTINEL);
    // The page data the others reach: the board (markers for operators only), to-dos and the bell.
    const [board] = [await candidateBoard(t.recruiter, [base.companyId], { jobId: t.jobId, tab: (await stagesOf(t.jobId)).find((x) => x.type === 'offer')!.id })];
    expect(board.cards.find((c) => c.id === a.applicationId)?.backgroundCheck).toBe('concerns_found');
    const offerTab = (await stagesOf(t.jobId)).find((x) => x.type === 'offer')!.id;
    const hmBoard = await candidateBoard(t.hm, [base.companyId], { jobId: t.jobId, tab: offerTab });
    expect(hmBoard.cards.map((c) => c.id).sort()).toEqual([a.applicationId, b.applicationId, live.applicationId].sort());
    expect(hmBoard.cards.every((c) => c.backgroundCheck === null)).toBe(true);
    expect(JSON.stringify(hmBoard).toUpperCase()).not.toContain(SENTINEL);
    // The interviewer (on the team, interviewing nobody here) sees the board but no application at all.
    const ivBoard = await candidateBoard(t.interviewer, [base.companyId], { jobId: t.jobId, tab: offerTab });
    expect(ivBoard.cards).toEqual([]);
    expect(JSON.stringify(ivBoard).toUpperCase()).not.toContain(SENTINEL);
    // The live to-do is there for its recorder (non-vacuous), in the list and the bell, without any restricted value.
    expect((await recruitmentTodos(t.recruiter, undefined)).filter((x) => x.kind === 'backgroundCheckAuthorisation').map((x) => x.id)).toEqual([liveId]);
    expect((await pendingRecruitmentTasks(t.recruiter, undefined)).map((x) => x.id)).toContain(`backgroundCheckAuthorisation:${liveId}`);
    for (const who of [t.hm, t.interviewer, t.bystander, t.otherRecruiter, t.recruiter, t.assistant]) {
      const out = [await recruitmentTodos(who, undefined), await pendingRecruitmentTasks(who, undefined)];
      expect(JSON.stringify(out).toUpperCase(), 'to-dos never carry a restricted value').not.toContain(SENTINEL);
    }
    // Direct reads as each of them: no restricted row, no sentinel, no file bytes or names.
    const hexBytes = Buffer.from(`${SENTINEL}AUTHBYTES`).toString('hex');
    for (const who of [t.hm, t.interviewer, t.bystander, t.otherRecruiter]) {
      for (const table of NEW_TABLES) {
        const seen = await rows<{ j: string }>(who, sql`select to_jsonb(x.*)::text as j from ${sql.identifier(table)} x`);
        if (RESTRICTED.includes(table)) expect(seen, `${table} visible`).toHaveLength(0);
        for (const row of seen) {
          expect(row.j.toUpperCase(), table).not.toContain(SENTINEL);
          expect(row.j, table).not.toContain(hexBytes);
        }
      }
      expect(await getBackgroundCheckFile(who, r.files[0].id)).toBeNull();
    }
    // Downloads: operators get the bytes; each download appends one event with ids and the kind — never the name or bytes.
    const before = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where event_type = 'recruitment-application.background-check-file-downloaded'`);
    expect(before[0].n).toBe(0);
    const got = await getBackgroundCheckFile(t.assistant, r.files[0].id);
    expect(got).toMatchObject({ fileName: 'qzxauth.pdf', mimeType: 'application/pdf' });
    expect(got!.content.equals(pdf(`${SENTINEL}AUTHBYTES`))).toBe(true);
    await getBackgroundCheckFile(admin, r.files[1].id);
    const downloads = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event
      where event_type = 'recruitment-application.background-check-file-downloaded' order by occurred_at, id`);
    expect(downloads.map((d) => d.payload)).toEqual([
      { companyId: base.companyId, jobId: t.jobId, checkId: id, fileId: r.files[0].id, kind: 'authorisation' },
      { companyId: base.companyId, jobId: t.jobId, checkId: id, fileId: r.files[1].id, kind: 'report' },
    ]);
    // No background-check event of any kind names a file, a provider, a reference, a summary, an outcome or a reason.
    const all = await owner.db.execute<{ payload: unknown }>(sql`select payload from domain_event where event_type like 'recruitment-application.background-check-%'`);
    expect(all.length).toBeGreaterThan(8);
    for (const e of all) {
      const text = JSON.stringify(e.payload);
      expect(text.toUpperCase()).not.toContain(SENTINEL);
      expect(text).not.toMatch(/concerns_found|clear|could_not_verify|\.pdf/);
    }
  });
});

describe('case 85 — the recorder\'s to-dos (awaiting authorisation; more than 14 Kuala Lumpur days in progress)', () => {
  it('appear for the recorder only, while due, and use Kuala Lumpur day boundaries', async () => {
    const t = await team();
    const a = await atOffer(t, 'Fictional Candidate Todo');
    const [type] = await typeIds();
    const mine = async (who: SessionContext) => (await recruitmentTodos(who, undefined)).filter((x) => x.kind.startsWith('backgroundCheck')).map((x) => [x.kind, x.id]);
    await addBackgroundCheck(t.recruiter, { applicationId: a.applicationId, typeIds: [type.id], provider: 'Fictional Screening' });
    const id = await checkOf(a.applicationId);
    expect(await mine(t.recruiter)).toEqual([['backgroundCheckAuthorisation', id]]);
    const [item] = (await recruitmentTodos(t.recruiter, undefined)).filter((x) => x.id === id);
    expect(item).toMatchObject({ candidateName: 'Fictional Candidate Todo', title: 'Fictional analyst', href: `/recruitment/applications/${a.applicationId}?tab=checks#check-${id}` });
    expect((await pendingRecruitmentTasks(t.recruiter, undefined)).filter((x) => x.kind === 'recruitmentBackgroundCheckAuthorisation').map((x) => x.id)).toEqual([`backgroundCheckAuthorisation:${id}`]);
    for (const who of [t.assistant, t.hm, t.interviewer, admin]) expect(await mine(who)).toEqual([]);
    // Authorised and started today: no to-do (not overdue).
    await recordBackgroundCheckAuthorisation(t.assistant, id, { authorisedOn: todayInKualaLumpur(), method: 'email', start: 'on' });
    expect(await mine(t.recruiter)).toEqual([]);
    // The day boundary, in Kuala Lumpur: started at 00:00 KL on (today − 14) is exactly 14 days → not due; one millisecond earlier
    // is KL day (today − 15) → due, dated from 00:00 KL on (start day + 15) = today.
    const today = todayInKualaLumpur();
    const setStartOf = async (checkId: string, iso: string) => owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_background_check set started_at = ${iso}::timestamptz where id = ${checkId}::uuid`;
    });
    const setStart = (iso: string) => setStartOf(id, iso);
    const boundary = new Date(`${addDays(today, -14)}T00:00:00+08:00`);
    await setStart(boundary.toISOString());
    expect(await mine(t.recruiter)).toEqual([]);
    expect((await applicationBackgroundChecks(t.recruiter, a.applicationId)).checks[0].overdue).toBe(false);
    await setStart(new Date(boundary.getTime() - 1).toISOString());
    expect(await mine(t.recruiter)).toEqual([['backgroundCheckOverdue', id]]);
    const [due] = (await recruitmentTodos(t.recruiter, undefined)).filter((x) => x.id === id);
    expect(due.at).toBe(new Date(`${today}T00:00:00+08:00`).toISOString());
    expect((await applicationBackgroundChecks(t.recruiter, a.applicationId)).checks[0].overdue).toBe(true);
    expect((await pendingRecruitmentTasks(t.recruiter, undefined)).map((x) => x.kind)).toContain('recruitmentBackgroundCheckOverdue');
    for (const who of [t.assistant, t.hm]) expect(await mine(who)).toEqual([]);
    // A recorder who no longer operates the job loses the to-do; completing removes it.
    const [member] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_job_member where job_id = ${t.jobId}::uuid and app_user_id = ${t.recruiter.userId}::uuid`);
    await owner.db.execute(sql`update recruitment_job_member set member_role = 'interviewer' where id = ${member.id}::uuid`);
    expect(await mine(t.recruiter)).toEqual([]);
    await owner.db.execute(sql`update recruitment_job_member set member_role = 'recruiter' where id = ${member.id}::uuid`);
    expect(await mine(t.recruiter)).toEqual([['backgroundCheckOverdue', id]]);
    await completeBackgroundCheck(t.assistant, id, { outcome: 'clear' });
    expect(await mine(t.recruiter)).toEqual([]);
    // A cancelled awaiting check leaves the list.
    const c2 = await atOffer(t);
    await addBackgroundCheck(t.recruiter, { applicationId: c2.applicationId, typeIds: [type.id], provider: 'Fictional Screening' });
    const id2 = await checkOf(c2.applicationId);
    expect(await mine(t.recruiter)).toEqual([['backgroundCheckAuthorisation', id2]]);
    await cancelBackgroundCheck(t.assistant, id2, { reason: 'Fictional: not needed' });
    expect(await mine(t.recruiter)).toEqual([]);
    // A removed candidate's open check leaves the list: the removal cancels it (a system cancellation, shown as Cancelled).
    const c3 = await atOffer(t);
    await addBackgroundCheck(t.recruiter, { applicationId: c3.applicationId, typeIds: [type.id], provider: 'Fictional Screening' });
    const id3 = await checkOf(c3.applicationId);
    await recordBackgroundCheckAuthorisation(t.recruiter, id3, { authorisedOn: todayInKualaLumpur(), method: 'email', start: 'on' });
    await setStartOf(id3, new Date(boundary.getTime() - 1).toISOString());
    expect(await mine(t.recruiter)).toEqual([['backgroundCheckOverdue', id3]]);
    await rejectAndAge(c3.applicationId);
    expect(await mine(t.recruiter)).toEqual([['backgroundCheckOverdue', id3]]); // archived, not yet removed: still the recorder's to finish
    expect(await destroyCandidates(admin, base.companyId, [c3.candidateId], 'on')).toEqual({ removed: 1 });
    expect(await mine(t.recruiter)).toEqual([]);
    expect((await owner.db.execute(sql`select status, system_cancel_reason, outcome, cancelled_at is not null as cancelled from recruitment_background_check where id = ${id3}::uuid`))[0])
      .toEqual({ status: 'cancelled', system_cancel_reason: 'candidate_removed', outcome: null, cancelled: true });
    const view = await applicationBackgroundChecks(t.hm, c3.applicationId);
    expect(view.checks.map((c) => [c.status, c.systemCancelled, c.restricted])).toEqual([['cancelled', true, null]]);
  });

  it('more than 50 removed candidates\' checks and more than 50 on a job the recorder no longer runs never hide real overdue items', async () => {
    const t = await team();
    const stagesA = await stagesOf(t.jobId);
    const offerA = stagesA.find((x) => x.type === 'offer')!.id;
    const [jobB] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_job_opening where title = 'Fictional other role' and tenant_id = ${base.tenantId}::uuid`);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    const old = `${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`;
    // Owner fixture (past the guards): 60 archived, aged applications on the recorder's job with checks In progress for 40 days
    // (their candidates are removed below); 60 active applications on job B (the recorder is not on its team) with the
    // recorder's checks In progress for 45 days; 5 real overdue checks on the recorder's job (20 days). Before the fix the
    // first 50 overdue rows read were the oldest — the removed or out-of-reach ones.
    const cand = (g: number) => `00000000-0000-4000-8000-${String(g).padStart(12, '0')}`;
    const app = (g: number) => `00000000-0000-4000-9000-${String(g).padStart(12, '0')}`;
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_candidate (id, tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Bulk ' || g,
          ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid from generate_series(1, 125) g`;
      await tx`insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, state, archive_reason_id, stage_left_at_archive,
          state_changed_at, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid,
          case when g between 61 and 120 then ${jobB.id}::uuid else ${t.jobId}::uuid end, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${offerA}::uuid,
          case when g <= 60 then 'archived' else 'active' end, case when g <= 60 then ${reason.id}::uuid end, case when g <= 60 then ${offerA}::uuid end,
          case when g <= 60 then ${old}::timestamptz else now() end, ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid from generate_series(1, 125) g`;
      await tx`insert into recruitment_background_check (tenant_id, company_id, job_id, application_id, status, created_by_user_id, created_at, started_at, status_changed_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, case when g between 61 and 120 then ${jobB.id}::uuid else ${t.jobId}::uuid end,
          ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'in_progress', ${t.recruiter.userId}::uuid, now() - interval '50 days',
          now() - (case when g <= 60 then interval '40 days' when g <= 120 then interval '45 days' else interval '20 days' end), ${t.recruiter.userId}::uuid
        from generate_series(1, 125) g`;
      await tx`insert into recruitment_background_check_detail (check_id, tenant_id, company_id, job_id, application_id, provider, summary, updated_by_user_id)
        select b.id, b.tenant_id, b.company_id, b.job_id, b.application_id, 'Fictional QZXBULK', 'QZXBULK summary', ${t.recruiter.userId}::uuid
        from recruitment_background_check b where b.tenant_id = ${base.tenantId}::uuid`;
      await tx`analyze recruitment_background_check`;
    });
    const real = (await owner.db.execute<{ id: string }>(sql`select b.id from recruitment_background_check b where b.application_id = any(${`{${[121, 122, 123, 124, 125].map(app).join(',')}}`}::uuid[])
      order by b.started_at, b.id`)).map((r) => r.id);
    expect(real).toHaveLength(5);
    expect(await destroyCandidates(admin, base.companyId, Array.from({ length: 60 }, (_, i) => cand(i + 1)), 'on')).toEqual({ removed: 60 });
    // The removed candidates' checks are cancelled by the system, keep no details, and leave both to-do indexes.
    expect(await owner.db.execute(sql`select status, system_cancel_reason, count(*)::int as n from recruitment_background_check
      where application_id = any(${`{${Array.from({ length: 60 }, (_, i) => app(i + 1)).join(',')}}`}::uuid[]) group by 1, 2`))
      .toEqual([{ status: 'cancelled', system_cancel_reason: 'candidate_removed', n: 60 }]);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_background_check_detail
      where application_id = any(${`{${Array.from({ length: 60 }, (_, i) => app(i + 1)).join(',')}}`}::uuid[])`))[0].n).toBe(0);
    expect((await backgroundCheckCounts(admin, [base.companyId]))[0].counts).toEqual({ awaiting_authorisation: 0, in_progress: 65, completed: 0, cancelled: 60 });
    // The recorder's overdue to-dos are exactly the five real ones, oldest first; the 60 on job B (no longer theirs) are skipped.
    expect((await recruitmentTodos(t.recruiter, undefined)).filter((x) => x.kind === 'backgroundCheckOverdue').map((x) => x.id)).toEqual(real);
    expect((await pendingRecruitmentTasks(t.recruiter, undefined)).filter((x) => x.kind === 'recruitmentBackgroundCheckOverdue').map((x) => x.id))
      .toEqual(real.map((id) => `backgroundCheckOverdue:${id}`));
    // The board shows no In progress marker for a removed candidate's (now cancelled) check.
    const archivedBoard = await candidateBoard(admin, [base.companyId], { jobId: t.jobId, tab: 'archived' });
    expect(archivedBoard.cards.length).toBeGreaterThan(0);
    expect(archivedBoard.cards.every((c) => c.backgroundCheck === null)).toBe(true);
  });

  it('the bell stays within its budget with many checks, reading from the recorder\'s own indexes', async () => {
    const t = await team();
    const stage = (await stagesOf(t.jobId)).find((x) => x.type === 'offer')!.id;
    // Volume through the owner (past the guards): 700 applications; 300 of the recruiter's checks overdue in progress, 300 awaiting,
    // 100 completed; and 3,000 checks of 30 other recorders.
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_candidate (id, tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Bulk ' || g,
          ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid from generate_series(1, 700) g`;
      await tx`insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, created_by_user_id, updated_by_user_id)
        select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid,
          ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${stage}::uuid, ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid from generate_series(1, 700) g`;
      await tx`insert into recruitment_background_check (tenant_id, company_id, job_id, application_id, status, outcome, created_at, created_by_user_id, started_at,
          completed_at, status_changed_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid,
          case when g <= 300 then 'in_progress' when g <= 600 then 'awaiting_authorisation' else 'completed' end,
          case when g > 600 then 'clear' end, now() - interval '40 days', ${t.recruiter.userId}::uuid,
          case when g <= 300 or g > 600 then now() - interval '30 days' end, case when g > 600 then now() - interval '1 day' end, ${t.recruiter.userId}::uuid
        from generate_series(1, 700) g`;
      await tx`insert into recruitment_background_check (tenant_id, company_id, job_id, application_id, status, created_by_user_id, started_at, status_changed_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ('00000000-0000-4000-9000-' || lpad((1 + g % 700)::text, 12, '0'))::uuid,
          case when g % 2 = 0 then 'in_progress' else 'awaiting_authorisation' end, ${base.adminUserId}::uuid,
          case when g % 2 = 0 then now() - interval '30 days' end, ${base.adminUserId}::uuid from generate_series(0, 2999) g`;
      await tx`analyze recruitment_background_check`;
    });
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
    const [recMs, asstMs, hmMs, adminMs] = [await time(t.recruiter), await time(t.assistant), await time(t.hm), await time(admin)];
    report(`bell median ms — recorder with 300 overdue + 300 awaiting among 3,700 checks: ${recMs.toFixed(1)}; assistant (none): ${asstMs.toFixed(1)}; hiring manager: ${hmMs.toFixed(1)}; administrator recorder of 3,000: ${adminMs.toFixed(1)}`);
    const bell = await pendingRecruitmentTasks(t.recruiter, undefined);
    expect(bell.filter((b) => b.kind === 'recruitmentBackgroundCheckOverdue')).toHaveLength(50);
    expect(bell.filter((b) => b.kind === 'recruitmentBackgroundCheckAuthorisation')).toHaveLength(50);
    for (const ms of [recMs, asstMs, hmMs, adminMs]) expect(ms).toBeLessThan(BELL_TIMEOUT_MS);
    const plan = await withTenant(t.recruiter, async (tx) => {
      const out = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain select b.id from recruitment_background_check b
        where b.tenant_id = ${base.tenantId}::uuid and b.created_by_user_id = ${t.recruiter.userId}::uuid and b.status = 'in_progress'
          and b.started_at < now() - interval '14 days' order by b.started_at limit 50`);
      return out.map((r) => r['QUERY PLAN']).join('\n');
    });
    report(`overdue plan:\n${plan}`);
    const analysed = await withTenant(t.recruiter, async (tx) => {
      const out = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, costs off) select x.id from recruitment_background_check x
        where x.tenant_id = ${base.tenantId}::uuid and x.created_by_user_id = ${t.recruiter.userId}::uuid and x.status = 'awaiting_authorisation'
        order by x.created_at desc limit 50`);
      const branch = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, costs off) select b.id, j.title, c.full_name
        from (select x.id, x.company_id, x.job_id, x.application_id, x.started_at from recruitment_background_check x
          where x.tenant_id = ${base.tenantId}::uuid and x.created_by_user_id = ${t.recruiter.userId}::uuid and x.status = 'in_progress'
            and x.started_at < now() - interval '14 days' order by x.started_at limit 50) b
        left join lateral (select c.full_name, c.destroyed_at from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id
          where a.id = b.application_id limit 1) c on true
        left join recruitment_job_opening j on j.id = b.job_id
        where c.destroyed_at is null and app.can_operate_recruitment_job(b.company_id, b.job_id) order by b.started_at, b.id limit 50`);
      return [...out, ...branch].map((r) => r['QUERY PLAN']).join('\n');
    });
    report(`awaiting plan:\n${analysed}`);
    expect(plan).toMatch(/recruitment_background_check_in_progress_idx/);
    expect(plan).not.toMatch(/Seq Scan on recruitment_background_check/);
  });
});

describe('case 86 — removal, company deletion, row security and grants, counts only', () => {
  it('removal leaves no summary, reference, provider, file name or bytes; types, status, outcome and dates stay', async () => {
    const t = await team();
    const a = await atOffer(t, `Fictional ${SENTINEL}PERSON`);
    await fullCheck(t, a.applicationId);
    await addBackgroundCheck(t.recruiter, { applicationId: a.applicationId, typeIds: [(await typeIds())[3].id], provider: `Fictional ${SENTINEL}SECOND` });
    await cancelBackgroundCheck(t.recruiter, await checkOf(a.applicationId), { reason: `${SENTINEL}CANCEL fictional` });
    // Another candidate's check stays untouched.
    const keep = await atOffer(t, 'Fictional Kept Person');
    const keptId = await fullCheck(t, keep.applicationId, 'KEPT');
    const shape = async (applicationId: string) => ({
      checks: await owner.db.execute(sql`select id, status, outcome, created_at, created_by_user_id, started_at, completed_at, cancelled_at, status_changed_at
        from recruitment_background_check where application_id = ${applicationId}::uuid order by id`),
      types: await owner.db.execute(sql`select check_id, type_id from recruitment_background_check_type_link where application_id = ${applicationId}::uuid order by 1, 2`),
    });
    const before = await shape(a.applicationId);
    expect(before.checks).toHaveLength(2);
    expect(before.types).toHaveLength(3);
    await rejectAndAge(a.applicationId);
    expect(await destroyCandidates(admin, base.companyId, [a.candidateId], 'on')).toEqual({ removed: 1 });
    expect(await shape(a.applicationId)).toEqual(before);
    for (const table of RESTRICTED) {
      expect(await owner.db.execute(sql`select 1 from ${sql.identifier(table)} where application_id = ${a.applicationId}::uuid`), table).toHaveLength(0);
      expect((await owner.db.execute(sql`select 1 from ${sql.identifier(table)} where application_id = ${keep.applicationId}::uuid`)).length, table).toBeGreaterThan(0);
    }
    const [event] = await owner.db.execute<{ payload: Record<string, number> }>(sql`
      select payload from domain_event where event_type = 'recruitment-candidate.personal-data-removed' and aggregate_id = ${a.candidateId}::uuid`);
    expect(event.payload).toMatchObject({ backgroundCheckFiles: 2, backgroundCheckDetails: 2 });
    // The kept check is still whole; nothing of the removed person remains anywhere (rows as text, file bytes as bytes, events).
    expect((await applicationBackgroundChecks(t.recruiter, keep.applicationId)).checks.find((c) => c.id === keptId)?.restricted?.files).toHaveLength(2);
    const tables = await owner.db.execute<{ relname: string }>(sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by c.relname`);
    expect(tables.map((x) => x.relname)).toEqual(expect.arrayContaining(NEW_TABLES));
    for (const { relname } of tables) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(relname)} r where to_jsonb(r.*)::text ilike ${`%${SENTINEL}%`}`);
      expect(hit.n, `${relname} still holds the removed person's data`).toBe(0);
    }
    // Bytes searched as bytes: the removed person's are gone, the kept candidate's are there (non-vacuous).
    const byteHits = async (marker: string) => (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_background_check_file
      where position(convert_to(${marker}, 'UTF8') in content) > 0`))[0].n;
    expect(await byteHits(`${SENTINEL}AUTHBYTES`)).toBe(0);
    expect(await byteHits(`${SENTINEL}REPORTBYTES`)).toBe(0);
    expect(await byteHits('KEPTAUTHBYTES')).toBe(1);
    const events = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where payload::text ilike ${`%${SENTINEL}%`}`);
    expect(events[0].n).toBe(0);
    // The removed person's checks are closed for writing (nothing can be added to them again), and the hiring manager still reads
    // type, status and outcome.
    expect(await code(cancelBackgroundCheck(admin, before.checks[0].id as string, { reason: 'Fictional' }))).toMatch(/^(check_closed|check_state)$/);
    expect((await applicationBackgroundChecks(t.hm, a.applicationId)).checks.map((c) => c.status).sort()).toEqual(['cancelled', 'completed']);
    expect(await code(rows(admin, sql`delete from recruitment_background_check_detail where application_id = ${keep.applicationId}::uuid`))).toBe('42501');
  });

  it('every new table forces row security with exact grants and none to PUBLIC; counts only for reports and the AI Centre; read paths write nothing', async () => {
    const meta = await owner.db.execute<{ relname: string; forced: boolean; enabled: boolean; app: string | null; public_grants: number }>(sql`
      select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
        (select string_agg(a.privilege_type, ',' order by a.privilege_type) from aclexplode(c.relacl) a where a.grantee = 'ai_hr_app'::regrole) as app,
        (select count(*)::int from aclexplode(c.relacl) a where a.grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${NEW_TABLES.join(',')}}`}::text[]) order by c.relname`);
    expect(meta).toEqual([
      { relname: 'recruitment_background_check', forced: true, enabled: true, app: 'INSERT,SELECT,UPDATE', public_grants: 0 },
      { relname: 'recruitment_background_check_detail', forced: true, enabled: true, app: 'INSERT,SELECT,UPDATE', public_grants: 0 },
      { relname: 'recruitment_background_check_file', forced: true, enabled: true, app: 'INSERT,SELECT', public_grants: 0 },
      { relname: 'recruitment_background_check_type', forced: true, enabled: true, app: 'DELETE,INSERT,SELECT,UPDATE', public_grants: 0 },
      { relname: 'recruitment_background_check_type_link', forced: true, enabled: true, app: 'INSERT,SELECT', public_grants: 0 },
    ]);
    // The restricted tables: no policy admits anyone but the job's operators (and the owner-bound maintenance).
    const policies = await owner.db.execute<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(sql`
      select tablename, policyname, qual, with_check from pg_policies where tablename = any(${`{${RESTRICTED.join(',')}}`}::text[]) order by 1, 2`);
    expect(policies.length).toBeGreaterThan(6);
    for (const p of policies) {
      const text = `${p.qual ?? ''} ${p.with_check ?? ''}`;
      expect(/can_operate_recruitment_job|relowner/.test(text), `${p.tablename}.${p.policyname}`).toBe(true);
      expect(text, `${p.tablename}.${p.policyname}`).not.toMatch(/can_review_recruitment_job|team_in_company|hiring_manager/);
    }
    // Guards and the candidate lock helper are not callable by PUBLIC; the guards not by the app role either.
    const fns = await owner.db.execute<{ proname: string; app_exec: boolean; public_exec: boolean; secdef: boolean }>(sql`select p.proname,
      has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec, has_function_privilege('public', p.oid, 'execute') as public_exec, p.prosecdef as secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'recruitment_%background_check%' order by 1`);
    expect(fns).toEqual([
      { proname: 'recruitment_background_check_cancel_reason_settled', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_background_check_candidate_open', app_exec: true, public_exec: false, secdef: false },
      { proname: 'recruitment_background_check_has_detail', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_background_check_stage_ok', app_exec: true, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_background_check', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_background_check_detail', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_background_check_file', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_background_check_type', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_background_check_type_link', app_exec: false, public_exec: false, secdef: false },
    ]);
    // Counts: by status, equal to the owner's own count; the AI Centre read is unchanged and counts only.
    const t = await team();
    const a = await atOffer(t);
    await fullCheck(t, a.applicationId);
    await addBackgroundCheck(t.recruiter, { applicationId: a.applicationId, typeIds: [(await typeIds())[0].id], provider: `Fictional ${SENTINEL}AI` });
    const owned = await owner.db.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from recruitment_background_check group by 1 order by 1`);
    expect(owned).toEqual([{ status: 'awaiting_authorisation', n: 1 }, { status: 'completed', n: 1 }]);
    expect(await backgroundCheckCounts(admin, [base.companyId])).toEqual([{ companyId: base.companyId, counts: { awaiting_authorisation: 1, in_progress: 0, completed: 1, cancelled: 0 } }]);
    for (const who of [t.recruiter, t.hm, t.bystander]) expect(await backgroundCheckCounts(who, [base.companyId])).toEqual([]);
    const counts = await recruitmentPipelineCounts(admin);
    const COUNT_KEYS = ['activeApplications', 'archived', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen'];
    expect(counts.rows.length).toBeGreaterThan(0);
    for (const row of counts.rows) {
      expect(Object.keys(row).sort()).toEqual(['company', ...COUNT_KEYS].sort());
      for (const k of COUNT_KEYS) expect(Number.isInteger((row as Record<string, unknown>)[k]), k).toBe(true);
    }
    expect(JSON.stringify(counts).toUpperCase()).not.toMatch(/QZX|CONCERNS|FICTIONAL CANDIDATE/);
    // The section's read works in a READ ONLY transaction and takes no transaction id, for an operator and a hiring manager.
    for (const who of [t.recruiter, t.hm]) {
      const out = await withTenant(who, async (tx) => {
        const view = await applicationBackgroundChecksTx(tx, who, a.applicationId);
        const [xid] = await tx.execute<{ x: string | null }>(sql`select pg_current_xact_id_if_assigned()::text as x`);
        const [mode] = await tx.execute<{ ro: string }>(sql`select current_setting('transaction_read_only') as ro`);
        return { view, xid: xid.x, ro: mode.ro };
      }, { readOnlySnapshot: true });
      expect(out).toMatchObject({ xid: null, ro: 'on' });
      expect(out.view.checks).toHaveLength(2);
    }
  });

  it('company deletion covers the new tables; removal and adding work under a NOBYPASSRLS owner with row security forced', async () => {
    const [{ id: emptyCompany }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Empty Sdn Bhd' }).returning({ id: company.id });
    expect(await addDefaultBackgroundCheckTypes(admin, emptyCompany)).toEqual({ added: 6 });
    const t = await team();
    const a = await atOffer(t, `Fictional ${SENTINEL}OWNER`);
    await fullCheck(t, a.applicationId);
    await rejectAndAge(a.applicationId);
    const fresh = await atOffer(t);
    const [type] = await typeIds();
    const ROLLBACK = 'rolled back on purpose';
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment', 'employment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      expect(tables.map((x) => x.name)).toEqual(expect.arrayContaining(NEW_TABLES.map((x) => `public.${x}`)));
      for (const x of tables) await tx.unsafe(`alter table ${x.name} owner to ai_hr_owner`);
      const fns = await tx<{ sig: string }[]>`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname ~ '^recruitment_'`;
      expect(fns.map((f) => f.sig)).toEqual(expect.arrayContaining(['app.recruitment_delete_company_setup(uuid)', 'app.recruitment_destroy_candidate(uuid)']));
      for (const f of fns) await tx.unsafe(`alter function ${f.sig} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      const forced = await tx`select relname from pg_class where relname = any(${NEW_TABLES}) and relforcerowsecurity and relrowsecurity`;
      expect(forced).toHaveLength(NEW_TABLES.length);
      const as = async (userId: string, roles: string, grants: unknown) => {
        await tx.unsafe('set local role ai_hr_app');
        await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('app.roles', ${roles}, true),
          set_config('app.grants', ${JSON.stringify(grants)}, true)`;
      };
      // The recruiter adds a check, its type and details directly (the guards run as the caller).
      await as(t.recruiter.userId, 'employee', [{ role: 'employee', companyId: null }]);
      const [c] = await tx`insert into recruitment_background_check (tenant_id, company_id, job_id, application_id, created_by_user_id, status_changed_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${fresh.applicationId}::uuid, ${t.recruiter.userId}::uuid, ${t.recruiter.userId}::uuid) returning id`;
      await tx`insert into recruitment_background_check_type_link (check_id, type_id, tenant_id, company_id, job_id, application_id)
        values (${c.id}::uuid, ${type.id}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${fresh.applicationId}::uuid)`;
      await tx`insert into recruitment_background_check_detail (check_id, tenant_id, company_id, job_id, application_id, provider, updated_by_user_id)
        values (${c.id}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${fresh.applicationId}::uuid, 'Fictional Owner Screening', ${t.recruiter.userId}::uuid)`;
      await tx`reset role`;
      // The administrator: removal and the company delete, run as the owner under forced row security.
      await as(base.adminUserId, 'hr_admin', [{ role: 'hr_admin', companyId: null }]);
      const [destroyed] = await tx`select app.recruitment_destroy_candidate(${a.candidateId}::uuid) as r`;
      expect(destroyed.r).toMatchObject({ backgroundCheckFiles: 2, backgroundCheckDetails: 1 });
      const [removed] = await tx`select app.recruitment_delete_company_setup(${emptyCompany}::uuid) as n`;
      expect(Number(removed.n)).toBeGreaterThanOrEqual(6);
      // The app role cannot delete restricted rows itself, even with the company-delete context value.
      await tx`select set_config('app.recruitment_company_delete', ${base.companyId}, true)`;
      await tx`savepoint s1`;
      await expect(tx`delete from recruitment_background_check_detail`).rejects.toMatchObject({ code: '42501' });
      await tx`rollback to savepoint s1`;
      await tx`reset role`;
      for (const x of NEW_TABLES) {
        const [n] = await tx.unsafe(`select count(*)::int as n from public.${x} where company_id = '${emptyCompany}'::uuid`);
        expect(n.n, x).toBe(0);
      }
      for (const x of RESTRICTED) {
        const [n] = await tx.unsafe(`select count(*)::int as n from public.${x} where application_id = '${a.applicationId}'::uuid`);
        expect(n.n, x).toBe(0);
      }
      const [owned] = await tx`select count(*)::int as n from recruitment_background_check_detail where check_id = ${c.id}::uuid`;
      expect(owned.n).toBe(1);
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => (e instanceof Error && e.message === ROLLBACK ? 'rolled back' : Promise.reject(e)));
    expect(done).toBe('rolled back');
    // Through the service as well (default owner): the company delete removes the empty company's types.
    await withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${emptyCompany}::uuid) as n`));
    expect(await owner.db.execute(sql`select 1 from recruitment_background_check_type where company_id = ${emptyCompany}::uuid`)).toHaveLength(0);
    // A company with an application keeps everything (its job opening refuses the delete first).
    expect(await code(withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${base.companyId}::uuid)`)))).toBe('23503');
  });
});
