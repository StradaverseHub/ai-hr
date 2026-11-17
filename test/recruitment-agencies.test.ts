/**
 * Recruitment slice 10 against Postgres: acceptance cases 66–73 (docs/recruitment-reconstruction/specification.md
 * "Slice 10 acceptance cases") through the service AND directly as the app role. Case 74 is the lead's rendered check. The
 * pure rules are test/recruitment-agency-rules.test.ts.
 *
 * Expected values are computed independently of packs/recruitment/agencies.ts: from what each fixture step did (ids kept as
 * the fixture creates them), from plain owner-connection SQL that ignores row security, and from Kuala Lumpur dates taken
 * from lib/hr-date with plain calendar arithmetic. Every person and value is fictional; S10SENTINEL marks personal values
 * that must vanish with a removal, and FEE_SENTINEL / FILE_SENTINEL the terms only administrators may see.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addCalendarMonths, todayInKualaLumpur } from '../lib/hr-date';
import { RECRUITMENT_TASK_KINDS } from '../lib/assigned-work';
import { expectNoLeakedValue } from './helpers/leaf-values';
import {
  acceptAgencySubmission, addAgencyContractUser, addApplication, candidateBoard, addJobMember, agencyContract, agencyContracts, agencyReviewQueue, agencySetup,
  agencySubmissionOptions, agencySubmissionReview, applicationAgency, applicationHistory, assignAgencyContract, createJob, deleteAgencyTag,
  destroyCandidates, getAgencyContractFile, jobAgencyContracts, jobAgencySubmissions, moveApplication, pendingRecruitmentTasks, recordAgencySubmission,
  recruitmentPipelineCounts, recruitmentSettings, recruitmentTodos, recruitmentUpdates, rejectAgencySubmission, rejectApplication, removeAgencyAssignment,
  saveAgency, saveAgencyConsultant, saveAgencyContract, saveAgencyTag, saveOffer, offerSettings, scheduleInterview, cancelInterview, setJobReferralPortal,
  submitReferral, updateReferralSettings, uploadAgencyContractFile, RecruitmentError, BELL_TIMEOUT_MS, agencySubmissionsDue, removeAgencySubmissionData,
} from '../packs/recruitment/service';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SENTINEL = 'S10SENTINEL';
const FEE_SENTINEL = '37.25';
const FILE_SENTINEL = 'S10FILESENTINEL';
let base: Base;
let admin: SessionContext;
let otherCompanyId: string;
let gradeId: string;
let today: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
const rows = <T = Record<string, unknown>>(ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute<T & Record<string, unknown>>(query));
/** A calendar day `n` days from `day` (plain date arithmetic; "today" itself comes from the HR date owner). */
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
/** Kuala Lumpur wall-clock time on `d` as an instant (KL is UTC+8 all year). */
const kl = (d: string, hhmmss = '00:00:00') => `${d}T${hhmmss}+08:00`;
const pdf = (marker = 'fictional') => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`);
type Login = SessionContext & { userId: string };
async function login(name: string, companyId = base.companyId): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
/** A second HR administrator (a person with a login and the hr_admin role), e.g. as a contract's HR contact. */
async function hrAdmin(name: string): Promise<Login> {
  const who = await login(name);
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: who.userId, companyId: null, role: 'hr_admin' });
  return { ...who, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: null }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional data analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', ...over,
});
let seq = 0;
/** An agency with one contract (fee rate FEE_SENTINEL) and one active consultant. */
async function agency(over: Record<string, unknown> = {}, name = `Fictional Agency ${++seq}`) {
  const { id: agencyId } = await saveAgency(admin, { companyId: (over.companyId as string) ?? base.companyId, name });
  const { id: contractId } = await saveAgencyContract(admin, {
    agencyId, name: 'Fictional contract', contractType: 'headhunter', feeRate: FEE_SENTINEL, startsOn: addDays(today, -10), endsOn: addDays(today, 100),
    hrContactUserId: base.adminUserId, access: 'public', ...over,
  });
  const { id: consultantId } = await saveAgencyConsultant(admin, { contractId, name: `Fictional Consultant ${seq}`, email: `consultant${seq}@agency.example.test` });
  return { agencyId, contractId, consultantId };
}
/** A job with a recruiter, an assistant, a hiring manager and an interviewer. */
async function team(title = 'Fictional data analyst', companyId = base.companyId) {
  const [recruiter, assistant, manager, interviewer] = await Promise.all([
    login(`Fictional Recruiter ${++seq}`, companyId), login(`Fictional Assistant ${seq}`, companyId), login(`Fictional Manager ${seq}`, companyId),
    login(`Fictional Interviewer ${seq}`, companyId),
  ]);
  const { id: jobId } = await createJob(admin, job({ title, companyId, recruiterUserId: recruiter.userId }));
  await addJobMember(admin, jobId, 'assistant', assistant.userId);
  await addJobMember(admin, jobId, 'hiring_manager', manager.userId);
  await addJobMember(admin, jobId, 'interviewer', interviewer.userId);
  return { jobId, recruiter, assistant, manager, interviewer };
}
const submit = (ctx: SessionContext, jobId: string, a: { contractId: string; consultantId: string }, over: Record<string, unknown> = {}) =>
  recordAgencySubmission(ctx, { jobId, contractId: a.contractId, consultantId: a.consultantId, fullName: `Fictional Person ${++seq}`, email: `person${seq}@example.test`, ...over });
/** The first enabled stage of a job's process (owner connection, plain SQL). */
async function firstStageOf(jobId: string): Promise<string> {
  const [r] = await owner.db.execute<{ stage_id: string }>(sql`select ps.stage_id from recruitment_job_opening j
    join recruitment_process_stage ps on ps.process_id = j.process_id join recruitment_stage st on st.id = ps.stage_id and st.enabled
    where j.id = ${jobId}::uuid order by ps.position limit 1`);
  return r.stage_id;
}
/** Fixture time travel: an application's date, set by the owner past the guards. */
async function appliedAt(applicationId: string, instant: string) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_application set applied_at = ${instant}::timestamptz where id = ${applicationId}::uuid`;
  });
}
async function waiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`);
    if (row.n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${n} lock waiter(s)`);
}
const count = async (table: string, where = sql`true`) =>
  (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where tenant_id = ${base.tenantId}::uuid and ${where}`))[0].n;
const NEW_TABLES = ['recruitment_agency', 'recruitment_agency_consultant', 'recruitment_agency_contract', 'recruitment_agency_contract_terms',
  'recruitment_agency_contract_user', 'recruitment_agency_submission', 'recruitment_agency_tag', 'recruitment_agency_tag_link', 'recruitment_job_agency_contract'];

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
  today = todayInKualaLumpur();
});

describe('case 66 — only administrators manage agencies; fee rate and contract file are for administrators only', () => {
  it('administrators and the company\'s partner manage; team members, another company\'s partner and bystanders are refused by the service and the tables', async () => {
    const t = await team();
    const { id: tagId } = await saveAgencyTag(admin, { companyId: base.companyId, name: 'Fictional tech specialists' });
    const a = await agency();
    await saveAgency(admin, { id: a.agencyId, name: 'Fictional Agency Renamed', tagIds: [tagId] });
    await uploadAgencyContractFile(admin, a.contractId, { fileName: 'contract.pdf', content: pdf(FILE_SENTINEL) });
    // The company's Recruiting Partner manages; a partner of another company does not.
    const partner = await login('Fictional Partner');
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: partner.userId, companyId: base.companyId, role: 'recruiting_partner' });
    const partnerCtx = { ...partner, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: base.companyId }] };
    const otherPartner = await login('Fictional Other Partner', otherCompanyId);
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: otherPartner.userId, companyId: otherCompanyId, role: 'recruiting_partner' });
    const otherPartnerCtx = { ...otherPartner, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: otherCompanyId }] };
    expect(await code(saveAgencyConsultant(partnerCtx, { contractId: a.contractId, name: 'Fictional Partner Consultant' }))).toBe('ok');
    expect((await agencyContract(partnerCtx, a.contractId)).feeRate).toBe(FEE_SENTINEL);
    const bystander = await login('Fictional Bystander');
    for (const who of [t.recruiter, t.assistant, t.manager, t.interviewer, bystander, otherPartnerCtx]) {
      expect(await code(saveAgency(who, { companyId: base.companyId, name: 'Fictional Rogue Agency' }))).toBe('forbidden');
      expect(await code(saveAgency(who, { id: a.agencyId, name: 'Fictional Rogue Rename' }))).toMatch(/forbidden|not_found/);
      expect(await code(saveAgencyTag(who, { companyId: base.companyId, name: 'Fictional rogue tag' }))).toBe('forbidden');
      expect(await code(deleteAgencyTag(who, tagId))).toMatch(/forbidden|not_found/);
      expect(await code(saveAgencyContract(who, { id: a.contractId, name: 'Fictional rogue', contractType: 'rpo', feeRate: '99', startsOn: today, endsOn: today, hrContactUserId: base.adminUserId }))).toMatch(/forbidden|not_found/);
      expect(await code(saveAgencyConsultant(who, { contractId: a.contractId, name: 'Fictional rogue consultant' }))).toMatch(/forbidden|not_found/);
      expect(await code(uploadAgencyContractFile(who, a.contractId, { fileName: 'x.pdf', content: pdf() }))).toMatch(/forbidden|not_found/);
      expect(await code(agencyContracts(who, base.companyId))).toBe('forbidden');
      expect(await code(agencyContract(who, a.contractId))).toMatch(/forbidden|not_found/);
      expect(await code(agencySetup(who, base.companyId))).toBe('forbidden');
      expect(await getAgencyContractFile(who, a.contractId)).toBeNull();
    }
    // Directly as the app role: no write to the setup, and the terms table is empty to every non-administrator.
    for (const who of [t.recruiter, t.assistant, t.manager, t.interviewer, bystander]) {
      expect(await code(rows(who, sql`insert into recruitment_agency (tenant_id, company_id, name, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional direct agency', ${who.userId}::uuid, ${who.userId}::uuid)`))).toBe('42501');
      expect(await rows(who, sql`update recruitment_agency_contract set status = 'disabled' where id = ${a.contractId}::uuid returning id`)).toHaveLength(0);
      expect(await rows(who, sql`update recruitment_agency_contract_terms set fee_rate = 1 where contract_id = ${a.contractId}::uuid returning contract_id`)).toHaveLength(0);
      expect(await rows(who, sql`select fee_rate, file_content from recruitment_agency_contract_terms`)).toHaveLength(0);
      expect(await code(rows(who, sql`delete from recruitment_agency_contract where id = ${a.contractId}::uuid`))).toBe('42501');
      // Nothing they can read in any agency table carries the fee rate or the file.
      for (const table of NEW_TABLES) {
        const seen = await rows(who, sql`select to_jsonb(x.*)::text as j from ${sql.identifier(table)} x`);
        for (const r of seen) {
          // By whole value: a timestamp column such as "…:37.254" contains the text "37.25".
          expectNoLeakedValue(JSON.parse(String(r.j)), Number(FEE_SENTINEL));
          expectNoLeakedValue(JSON.parse(String(r.j)), FEE_SENTINEL);
          expect(String(r.j)).not.toContain(Buffer.from(FILE_SENTINEL).toString('hex'));
          expect(String(r.j)).not.toContain('fee_rate');
        }
      }
    }
    // The recruiter reads the released contract's name (to record submissions), never its terms.
    expect((await rows(t.recruiter, sql`select name from recruitment_agency_contract where id = ${a.contractId}::uuid`))).toEqual([{ name: 'Fictional contract' }]);
    // The administrator sees both, and the file download is audited without its name.
    expect((await agencyContracts(admin, base.companyId)).find((c) => c.id === a.contractId)).toMatchObject({ feeRate: FEE_SENTINEL, agencyName: 'Fictional Agency Renamed', tags: ['Fictional tech specialists'] });
    const file = await getAgencyContractFile(admin, a.contractId);
    expect(file?.content.toString()).toContain(FILE_SENTINEL);
    const [download] = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event where event_type = 'recruitment-agency-contract.file-downloaded'`);
    expect(JSON.stringify(download.payload)).not.toContain('contract.pdf');
    // A tag in use is kept; an unused one goes. A contract file must be a PDF.
    expect(await code(deleteAgencyTag(admin, tagId))).toBe('tag_in_use');
    const { id: unused } = await saveAgencyTag(admin, { companyId: base.companyId, name: 'Fictional unused tag' });
    expect(await code(deleteAgencyTag(admin, unused))).toBe('ok');
    expect(await code(uploadAgencyContractFile(admin, a.contractId, { fileName: 'contract.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) }))).toBe('file_type');
    // The HR contact administers recruitment for the company (service and database).
    expect(await code(saveAgencyContract(admin, { agencyId: a.agencyId, name: 'Fictional bad contact', contractType: 'rpo', feeRate: '5', startsOn: today, endsOn: today, hrContactUserId: t.recruiter.userId }))).toBe('contact_invalid');
    expect(await code(rows(admin, sql`insert into recruitment_agency_contract (tenant_id, company_id, agency_id, name, contract_type, starts_on, ends_on, hr_contact_user_id,
      created_by_user_id, updated_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${a.agencyId}::uuid, 'Fictional direct', 'rpo', ${today}::date, ${today}::date,
      ${t.recruiter.userId}::uuid, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`))).toBe('23514');
    // Names are unique in the company.
    expect(await code(saveAgency(admin, { companyId: base.companyId, name: 'fictional agency renamed' }))).toBe('name_taken');
    // Hiring managers and interviewers see the source "Agency" and the agency name only, on an application from an agency.
    await assignAgencyContract(admin, t.jobId, a.contractId);
    const s = await submit(t.recruiter, t.jobId, a, { comments: `${SENTINEL} comment` });
    expect(s.outcome).toBe('accepted');
    await scheduleInterview(t.recruiter, { applicationId: s.applicationId!, type: 'video', startsAt: new Date(Date.now() + 86_400_000), durationMinutes: 30, interviewerIds: [t.interviewer.userId] });
    for (const reader of [t.manager, t.interviewer]) {
      expect(await applicationAgency(reader, s.applicationId)).toEqual({ agencyName: 'Fictional Agency Renamed', contractName: null, consultantName: null, submittedOn: null, comments: null });
    }
    for (const operator of [t.recruiter, t.assistant, admin]) {
      expect(await applicationAgency(operator, s.applicationId)).toMatchObject({ agencyName: 'Fictional Agency Renamed', contractName: 'Fictional contract', submittedOn: today, comments: `${SENTINEL} comment` });
    }
    expect(await applicationAgency(bystander, s.applicationId)).toBeNull();
    for (const who of [t.manager, t.interviewer, bystander]) {
      expect(await rows(who, sql`select id from recruitment_agency_submission`)).toHaveLength(0);
      expect(await rows(who, sql`select id from recruitment_agency`)).toHaveLength(0);
      expect(await rows(who, sql`select id from recruitment_agency_contract`)).toHaveLength(0);
    }
    const operatorViews = [await jobAgencyContracts(t.recruiter, t.jobId), await agencySubmissionOptions(t.recruiter, t.jobId), await jobAgencySubmissions(t.recruiter, t.jobId)];
    expectNoLeakedValue(operatorViews, Number(FEE_SENTINEL));
    expectNoLeakedValue(operatorViews, FEE_SENTINEL);
  });
});

describe('case 67 — a contract is offered and used only when Enabled, inside its period on the Kuala Lumpur date, and released to the user', () => {
  it('offers exactly the usable contracts, refuses the others for assignment and submission (service and database)', async () => {
    const t = await team();
    const listed = t.recruiter;
    const other = await team('Fictional second role');
    const active = await agency({}, 'Fictional Active Agency');
    const endsToday = await agency({ startsOn: addDays(today, -30), endsOn: today }, 'Fictional Ends Today Agency');
    const startsToday = await agency({ startsOn: today, endsOn: addDays(today, 30) }, 'Fictional Starts Today Agency');
    const expired = await agency({ startsOn: addDays(today, -30), endsOn: addDays(today, -1) }, 'Fictional Expired Agency');
    const future = await agency({ startsOn: addDays(today, 1), endsOn: addDays(today, 30) }, 'Fictional Future Agency');
    const disabled = await agency({ status: 'disabled' }, 'Fictional Disabled Agency');
    const restricted = await agency({ access: 'restricted' }, 'Fictional Restricted Agency');
    await addAgencyContractUser(admin, restricted.contractId, listed.userId);
    const label = (name: string) => `${name} · Fictional contract`;
    const offered = (await jobAgencyContracts(listed, t.jobId)).available.map((x) => x.label).sort();
    expect(offered).toEqual([label('Fictional Active Agency'), label('Fictional Ends Today Agency'), label('Fictional Restricted Agency'), label('Fictional Starts Today Agency')].sort());
    // Another job's recruiter is not listed on the Restricted contract; the administrator is not listed either (D: listed users only).
    expect((await jobAgencyContracts(other.recruiter, other.jobId)).available.map((x) => x.label).sort())
      .toEqual([label('Fictional Active Agency'), label('Fictional Ends Today Agency'), label('Fictional Starts Today Agency')].sort());
    expect((await jobAgencyContracts(admin, t.jobId)).available.map((x) => x.label)).not.toContain(label('Fictional Restricted Agency'));
    // Assignment: refused for an unusable or unreleased contract, by the service and directly by the database.
    for (const c of [expired, future, disabled]) {
      expect(await code(assignAgencyContract(listed, t.jobId, c.contractId))).toBe('contract_unavailable');
      expect(await code(rows(listed, sql`insert into recruitment_job_agency_contract (tenant_id, company_id, job_id, contract_id, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${c.contractId}::uuid, ${listed.userId}::uuid, ${listed.userId}::uuid)`))).toBe('23514');
    }
    expect(await code(assignAgencyContract(other.recruiter, other.jobId, restricted.contractId))).toBe('contract_unavailable');
    // The job's assistant reads the assignments but cannot assign; neither can the hiring manager (service and database).
    expect(await code(assignAgencyContract(t.assistant, t.jobId, active.contractId))).toBe('forbidden');
    expect(await code(assignAgencyContract(t.manager, t.jobId, active.contractId))).toBe('forbidden');
    expect(await code(rows(t.assistant, sql`insert into recruitment_job_agency_contract (tenant_id, company_id, job_id, contract_id, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${active.contractId}::uuid, ${t.assistant.userId}::uuid, ${t.assistant.userId}::uuid)`))).toBe('42501');
    for (const c of [active, endsToday, startsToday, restricted]) expect(await code(assignAgencyContract(listed, t.jobId, c.contractId, 'Fictional requirements'))).toBe('ok');
    expect((await jobAgencyContracts(t.assistant, t.jobId)).assigned).toHaveLength(4);
    // Submissions: only from an assigned, usable contract; the options list exactly those, each with its active consultants.
    expect((await agencySubmissionOptions(t.assistant, t.jobId)).map((o) => o.label).sort())
      .toEqual([label('Fictional Active Agency'), label('Fictional Ends Today Agency'), label('Fictional Starts Today Agency')].sort());
    expect((await agencySubmissionOptions(listed, t.jobId)).map((o) => o.label)).toContain(label('Fictional Restricted Agency'));
    expect(await code(submit(t.assistant, t.jobId, restricted))).toBe('contract_unavailable');
    expect(await code(submit(listed, t.jobId, expired))).toBe('contract_unavailable');
    expect((await submit(listed, t.jobId, endsToday)).outcome).toBe('accepted');
    // A submission date before the contract start or in the future is refused (service and database).
    expect(await code(submit(listed, t.jobId, startsToday, { submittedOn: addDays(today, -1) }))).toBe('invalid_input');
    expect(await code(submit(listed, t.jobId, active, { submittedOn: addDays(today, 1) }))).toBe('invalid_input');
    // Disabling a contract after assignment stops new submissions (the database refuses the direct write too).
    await saveAgencyContract(admin, { id: active.contractId, name: 'Fictional contract', contractType: 'headhunter', feeRate: FEE_SENTINEL, startsOn: addDays(today, -10),
      endsOn: addDays(today, 100), hrContactUserId: base.adminUserId, access: 'public', status: 'disabled' });
    expect(await code(submit(listed, t.jobId, active))).toBe('contract_unavailable');
    expect(await code(rows(listed, sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
      full_name, email, match_kind, outcome, created_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${active.contractId}::uuid,
      ${active.agencyId}::uuid, ${active.consultantId}::uuid, ${today}::date, 'Fictional Direct', 'direct@example.test', 'duplicate', 'waiting', ${listed.userId}::uuid)`))).toBe('23514');
    // A disabled consultant is not offered and not accepted.
    await saveAgencyConsultant(admin, { id: endsToday.consultantId, name: 'Fictional Consultant', status: 'disabled' });
    expect(await code(submit(listed, t.jobId, endsToday))).toBe('consultant_unavailable');
    // Removing an assignment stops new submissions; the ones recorded stay.
    const assignment = (await jobAgencyContracts(listed, t.jobId)).assigned.find((x) => x.contractId === startsToday.contractId)!;
    await submit(listed, t.jobId, startsToday);
    await removeAgencyAssignment(listed, assignment.id);
    expect(await code(submit(listed, t.jobId, startsToday))).toBe('contract_unavailable');
    expect(await count('recruitment_agency_submission', sql`contract_id = ${startsToday.contractId}::uuid`)).toBe(1);
  });
});

describe('case 68 — a New submission creates the candidate, the application and the submission in one transaction, audited', () => {
  it('accepts at once at the first enabled stage with source "agency"; a failure leaves nothing', async () => {
    const t = await team();
    const a = await agency();
    await assignAgencyContract(t.recruiter, t.jobId, a.contractId);
    const result = await submit(t.recruiter, t.jobId, a, {
      fullName: 'Fictional New Person', email: 'New.Person@Example.test', mobile: '+60 12-345 6789', idType: 'nric', idNumber: '900101-14-5555',
      currentSalaryAmount: '5,000', currentSalaryCurrency: 'myr', expectedSalaryAmount: '6500.5', expectedSalaryCurrency: 'MYR', comments: 'Fictional agency comment',
      resumeName: 'resume.pdf', resumeContent: pdf('fictional resume'), permissionConfirmed: 'on',
    });
    expect(result.outcome).toBe('accepted');
    const [sub] = await owner.db.execute<{ candidate_id: string; application_id: string; outcome: string; match_kind: string; decided_by_user_id: string; resume_content: Buffer | null }>(sql`
      select candidate_id, application_id, outcome, match_kind, decided_by_user_id, resume_content from recruitment_agency_submission where id = ${result.submissionId}::uuid`);
    expect(sub).toMatchObject({ application_id: result.applicationId, outcome: 'accepted', match_kind: 'new', decided_by_user_id: t.recruiter.userId, resume_content: null });
    const [app] = await owner.db.execute<{ candidate_id: string; job_id: string; current_stage_id: string; source: string; state: string }>(sql`
      select candidate_id, job_id, current_stage_id, source, state from recruitment_application where id = ${result.applicationId}::uuid`);
    expect(app).toEqual({ candidate_id: sub.candidate_id, job_id: t.jobId, current_stage_id: await firstStageOf(t.jobId), source: 'agency', state: 'active' });
    const [cand] = await owner.db.execute(sql`select full_name, email, phone, source from recruitment_candidate where id = ${sub.candidate_id}::uuid`);
    expect(cand).toEqual({ full_name: 'Fictional New Person', email: 'new.person@example.test', phone: '+60 12-345 6789', source: 'agency' });
    const [restricted] = await owner.db.execute(sql`select id_type, id_number, current_salary_amount::text as cur, current_salary_currency as cc, expected_salary_amount::text as exp
      from recruitment_candidate_restricted where candidate_id = ${sub.candidate_id}::uuid`);
    expect(restricted).toEqual({ id_type: 'nric', id_number: '900101-14-5555', cur: '5000.00', cc: 'MYR', exp: '6500.50' });
    const [file] = await owner.db.execute<{ kind: string; uploaded_by_user_id: string; permission_confirmed: boolean }>(sql`
      select kind, uploaded_by_user_id, permission_confirmed from recruitment_candidate_file where candidate_id = ${sub.candidate_id}::uuid`);
    expect(file).toEqual({ kind: 'resume', uploaded_by_user_id: t.recruiter.userId, permission_confirmed: true });
    expect((await applicationHistory(t.recruiter, result.applicationId)).map((h) => h.kind)).toEqual(['applied']);
    const events = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event where event_type = 'recruitment-agency.submission-recorded'
      and payload->>'submissionId' = ${result.submissionId}`);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ outcome: 'accepted', matchKind: 'new', applicationId: result.applicationId, resume: true });
    // Text sentinels by substring (letters, or the dashed ID number, which no UUID or timestamp can contain); amounts and the
    // bare ID digits by WHOLE leaf value (test/helpers/leaf-values.ts): a random id may contain "5000".
    expect(JSON.stringify(events[0].payload)).not.toMatch(/Fictional New Person|new\.person|900101-14-5555|resume\.pdf|agency comment/i);
    for (const secret of [5000, 6500.5, '5,000', '900101145555']) expectNoLeakedValue(events[0].payload, secret);
    // The Candidates board shows the source "agency" (the slice 5 choice), and the new candidate counts for slice 5's duplicate check.
    expect((await candidateBoard(t.recruiter, [base.companyId], { jobId: t.jobId })).cards.find((c) => c.id === result.applicationId)?.source).toBe('agency');
    expect(await code(addApplication(t.recruiter, { jobId: t.jobId, fullName: 'Fictional New Person', email: 'new.person@example.test' }))).toBe('possible_duplicate');
    // A resume without the permission confirmation is refused before anything is written.
    expect(await code(submit(t.recruiter, t.jobId, a, { resumeName: 'r.pdf', resumeContent: pdf() }))).toBe('permission_required');
    // One transaction: if the submission row fails, the candidate and application written before it are gone too.
    const before = await Promise.all(['recruitment_candidate', 'recruitment_application', 'recruitment_application_event', 'recruitment_agency_submission'].map((x) => count(x)));
    await owner.db.execute(sql.raw(`create or replace function public.s10_test_fail() returns trigger language plpgsql as $$ begin raise exception 'fictional failure' using errcode = 'P0001'; end $$;
      create trigger s10_test_fail before insert on public.recruitment_agency_submission for each row execute function public.s10_test_fail();`));
    try {
      expect(await code(submit(t.recruiter, t.jobId, a, { fullName: 'Fictional Rolled Back', email: 'rolled.back@example.test' }))).toBe('P0001');
    } finally {
      await owner.db.execute(sql.raw('drop trigger s10_test_fail on public.recruitment_agency_submission; drop function public.s10_test_fail();'));
    }
    expect(await Promise.all(['recruitment_candidate', 'recruitment_application', 'recruitment_application_event', 'recruitment_agency_submission'].map((x) => count(x)))).toEqual(before);
    expect(await count('recruitment_candidate', sql`email = 'rolled.back@example.test'`)).toBe(0);
    // The database computes the outcome again: an operator cannot store a new person as Waiting, or a candidate without the check.
    expect(await code(rows(t.recruiter, sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
      full_name, email, match_kind, outcome, created_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${a.contractId}::uuid,
      ${a.agencyId}::uuid, ${a.consultantId}::uuid, ${today}::date, 'Fictional Unchecked', 'unchecked@example.test', 'duplicate', 'waiting', ${t.recruiter.userId}::uuid)`))).toBe('23514');
  });
});

describe('case 69 — a Duplicate inside another channel\'s protection is refused and kept; outside it waits; Kuala Lumpur day boundaries', () => {
  it('agency 365 days, the contract override, referral 180 days and archived applications, each at its Kuala Lumpur boundary', async () => {
    const t = await team();
    const j2 = await createJob(admin, job({ title: 'Fictional second role', recruiterUserId: t.recruiter.userId }));
    const A = await agency({}, 'Fictional Agency A');
    const B = await agency({ protectionDays: 30 }, 'Fictional Agency B');
    for (const c of [A, B]) {
      await assignAgencyContract(t.recruiter, t.jobId, c.contractId);
      await assignAgencyContract(t.recruiter, j2.id, c.contractId);
    }
    const person = (n: string) => ({ fullName: `Fictional Protected ${n}`, email: `protected.${n}@example.test` });
    const outcomeOf = async (id: string) => (await owner.db.execute<{ outcome: string; refusal_reason: string | null; candidate_id: string | null }>(sql`
      select outcome, refusal_reason, candidate_id from recruitment_agency_submission where id = ${id}::uuid`))[0];

    // Agency A's accepted application protects A's credit for 365 days: Agency B's submission of the same person is refused.
    const first = await submit(t.recruiter, t.jobId, A, person('x'));
    expect(first.outcome).toBe('accepted');
    const candidates = await count('recruitment_candidate');
    const applications = await count('recruitment_application');
    const refused = await submit(t.recruiter, j2.id, B, person('x'));
    expect(refused).toEqual({ submissionId: expect.any(String), outcome: 'refused', applicationId: null });
    expect(await outcomeOf(refused.submissionId)).toEqual({ outcome: 'refused', refusal_reason: 'protected', candidate_id: null });
    expect([await count('recruitment_candidate'), await count('recruitment_application')]).toEqual([candidates, applications]);
    // The recorder sees the reason, never the earlier candidate.
    const listed = (await jobAgencySubmissions(t.recruiter, j2.id)).find((x) => x.id === refused.submissionId)!;
    expect(listed).toMatchObject({ outcome: 'refused', refusalReason: 'protected', applicationId: null });
    // The same agency is not protected against itself: Agency A to the second job waits for review.
    expect((await submit(t.recruiter, j2.id, A, person('x'))).outcome).toBe('waiting');
    // 365-day boundary at Kuala Lumpur midnight: applied on day today-364 protects; one second earlier (day today-365) does not.
    await appliedAt(first.applicationId!, kl(addDays(today, -364)));
    expect((await submit(t.recruiter, j2.id, B, { ...person('x'), mobile: '0123000001' })).outcome).toBe('refused');
    await appliedAt(first.applicationId!, kl(addDays(today, -365), '23:59:59'));
    expect((await submit(t.recruiter, j2.id, B, { ...person('x'), mobile: '0123000002' })).outcome).toBe('waiting');

    // The contract override (Agency B: 30 days) protects B's credit against Agency A for 30 Kuala Lumpur days.
    const y = await submit(t.recruiter, t.jobId, B, person('y'));
    expect(y.outcome).toBe('accepted');
    await appliedAt(y.applicationId!, kl(addDays(today, -29)));
    expect((await submit(t.recruiter, j2.id, A, person('y'))).outcome).toBe('refused');
    // Archived applications protect too until the period ends.
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, y.applicationId!, reason.id);
    expect((await submit(t.recruiter, j2.id, A, { ...person('y'), mobile: '0123000003' })).outcome).toBe('refused');
    await appliedAt(y.applicationId!, kl(addDays(today, -30), '23:59:59'));
    expect((await submit(t.recruiter, j2.id, A, { ...person('y'), mobile: '0123000004' })).outcome).toBe('waiting');

    // An employee referral protects for the company's referral period (180 days by default).
    const referrer = await login('Fictional Referrer');
    const refJob = (await createJob(admin, job({ title: 'Fictional referral role', recruiterUserId: t.recruiter.userId }))).id;
    await setJobReferralPortal(admin, refJob, true);
    await submitReferral(referrer, { jobId: refJob, ...person('z'), mobile: '', reason: 'Fictional reason', confirmed: true });
    const [{ application_id: referred }] = await owner.db.execute<{ application_id: string }>(sql`select application_id from recruitment_referral where job_id = ${refJob}::uuid`);
    await appliedAt(referred, kl(addDays(today, -179)));
    expect((await submit(t.recruiter, t.jobId, A, person('z'))).outcome).toBe('refused');
    await appliedAt(referred, kl(addDays(today, -180), '23:59:59'));
    expect((await submit(t.recruiter, t.jobId, A, { ...person('z'), mobile: '0123000005' })).outcome).toBe('waiting');
    // The company setting moves the referral period (here 400 days: protected again).
    await updateReferralSettings(admin, base.companyId, { protectionDays: '400' });
    expect((await submit(t.recruiter, j2.id, A, { ...person('z'), mobile: '0123000006' })).outcome).toBe('refused');

    // Any other source protects nothing: a job-board application gives a Duplicate that waits.
    await addApplication(t.recruiter, { jobId: refJob, fullName: 'Fictional Protected w', email: 'protected.w@example.test', candidateSource: 'job_board' });
    expect((await submit(t.recruiter, t.jobId, A, person('w'))).outcome).toBe('waiting');
    // The database computes the outcome again: a direct write that stores a protected person as Waiting is refused.
    await appliedAt(first.applicationId!, kl(today, '09:00:00'));
    expect(await code(rows(t.recruiter, sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
      full_name, email, mobile, match_kind, outcome, created_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${B.contractId}::uuid,
      ${B.agencyId}::uuid, ${B.consultantId}::uuid, ${today}::date, ${person('x').fullName}, ${person('x').email}, '0199999999', 'duplicate', 'waiting', ${t.recruiter.userId}::uuid)`)))
      .toBe('23514');
    // …and stores it as Refused when the write says so.
    expect(await code(rows(t.recruiter, sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
      full_name, email, mobile, match_kind, outcome, refusal_reason, created_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${B.contractId}::uuid,
      ${B.agencyId}::uuid, ${B.consultantId}::uuid, ${today}::date, ${person('x').fullName}, ${person('x').email}, '0199999999', 'duplicate', 'refused', 'protected', ${t.recruiter.userId}::uuid)`)))
      .toBe('ok');
  });
});

describe('case 70 — Suspected waits; administrators accept onto a new or existing candidate or reject with a reason; recruiters cannot', () => {
  it('reviews by administrators only, and the recruiter never learns the matched candidate', async () => {
    const t = await team();
    const other = await team('Fictional unrelated role');
    const A = await agency();
    await assignAgencyContract(t.recruiter, t.jobId, A.contractId);
    // An existing candidate on a job the recruiter does not operate.
    const { candidateId: existing } = await addApplication(other.recruiter, { jobId: other.jobId, fullName: 'Fictional Original Name', email: 'shared@example.test', phone: '012-999 8888' });
    const suspected = await submit(t.recruiter, t.jobId, A, { fullName: 'Fictional Different Name', email: 'SHARED@example.test', mobile: '0129998888', resumeName: 'cv.pdf',
      resumeContent: pdf('fictional waiting resume'), permissionConfirmed: true });
    expect(suspected.outcome).toBe('waiting');
    expect((await owner.db.execute(sql`select match_kind, resume_size is not null as has_resume from recruitment_agency_submission where id = ${suspected.submissionId}::uuid`))[0])
      .toEqual({ match_kind: 'suspected', has_resume: true });
    // The definer answers the outcome to the recruiter and the match ids to an administrator only (asked for another agency:
    // for Agency A the same person on this job is already a repeat).
    expect((await rows(t.recruiter, sql`select outcome from app.recruitment_agency_submission_check(${t.jobId}::uuid, ${A.contractId}::uuid, 'Fictional Third Name',
      'shared@example.test', '0129998888', null)`))[0].outcome).toBe('repeat');
    const B = await agency({}, 'Fictional Probe Agency');
    await assignAgencyContract(t.recruiter, t.jobId, B.contractId);
    const probe = sql`select outcome, match_ids from app.recruitment_agency_submission_check(${t.jobId}::uuid, ${B.contractId}::uuid, 'Fictional Third Name',
      'shared@example.test', '0129998888', null)`;
    expect(await rows(t.recruiter, probe)).toEqual([{ outcome: 'suspected', match_ids: null }]);
    expect(await rows(admin, probe)).toEqual([{ outcome: 'suspected', match_ids: [existing] }]);
    expect(await code(rows(other.manager, probe))).toBe('42501');
    expect(await rows(t.recruiter, sql`select id from recruitment_candidate where id = ${existing}::uuid`)).toHaveLength(0);
    expect(JSON.stringify(await jobAgencySubmissions(t.recruiter, t.jobId))).not.toContain('Fictional Original Name');
    // The recruiter (and the assistant) cannot review: service refusal, and the table refuses the update.
    for (const who of [t.recruiter, t.assistant]) {
      expect(await code(agencySubmissionReview(who, suspected.submissionId))).toBe('forbidden');
      expect(await code(acceptAgencySubmission(who, suspected.submissionId))).toBe('forbidden');
      expect(await code(rejectAgencySubmission(who, suspected.submissionId, 'Fictional reason'))).toBe('forbidden');
      expect(await rows(who, sql`update recruitment_agency_submission set outcome = 'rejected', review_reason = 'x' where id = ${suspected.submissionId}::uuid returning id`)).toHaveLength(0);
    }
    expect((await agencyReviewQueue(t.recruiter, [base.companyId]))).toEqual([]);
    // The administrator's list and review show the match.
    expect((await agencyReviewQueue(admin, [base.companyId])).map((r) => r.id)).toEqual([suspected.submissionId]);
    const review = await agencySubmissionReview(admin, suspected.submissionId);
    expect(review.matches.map((m) => m.candidateId)).toEqual([existing]);
    expect(review.matches[0].matchedOn.sort()).toEqual(['email', 'mobile']);
    // Accept as a NEW candidate: the resume moves to the new candidate's files.
    const acceptedNew = await acceptAgencySubmission(admin, suspected.submissionId);
    expect(acceptedNew.candidateId).not.toBe(existing);
    expect((await owner.db.execute(sql`select outcome, candidate_id, resume_content is null as moved, decided_by_user_id from recruitment_agency_submission where id = ${suspected.submissionId}::uuid`))[0])
      .toEqual({ outcome: 'accepted', candidate_id: acceptedNew.candidateId, moved: true, decided_by_user_id: base.adminUserId });
    expect(await count('recruitment_candidate_file', sql`candidate_id = ${acceptedNew.candidateId}::uuid and kind = 'resume'`)).toBe(1);
    expect((await owner.db.execute(sql`select source, job_id from recruitment_application where id = ${acceptedNew.applicationId}::uuid`))[0]).toEqual({ source: 'agency', job_id: t.jobId });
    expect(await code(acceptAgencySubmission(admin, suspected.submissionId))).toBe('submission_decided');
    // A Duplicate (same name and e-mail) outside protection — the existing candidate came with no source — accepted onto the
    // EXISTING candidate: the application is added to them.
    const dup = await submit(t.recruiter, t.jobId, A, { fullName: 'Fictional Original Name', email: 'shared@example.test' });
    expect(dup.outcome).toBe('waiting');
    expect((await agencySubmissionReview(admin, dup.submissionId)).matches.find((m) => m.candidateId === existing)?.matchedOn.sort()).toEqual(['email', 'name']);
    const onto = await acceptAgencySubmission(admin, dup.submissionId, { candidateId: existing });
    expect(onto.candidateId).toBe(existing);
    expect((await owner.db.execute(sql`select candidate_id, source from recruitment_application where id = ${onto.applicationId}::uuid`))[0]).toEqual({ candidate_id: existing, source: 'agency' });
    // Reject with a reason (required): another agency's Suspected submission on the other job.
    const Q = await agency({}, 'Fictional Agency Q');
    await assignAgencyContract(other.recruiter, other.jobId, Q.contractId);
    const waitingAgain = await submit(other.recruiter, other.jobId, Q, { fullName: 'Fictional Someone Else', email: 'shared@example.test', mobile: '0129998888' });
    expect(waitingAgain.outcome).toBe('waiting');
    expect(await code(rejectAgencySubmission(admin, waitingAgain.submissionId, ''))).toBe('missing_fields');
    await rejectAgencySubmission(admin, waitingAgain.submissionId, 'Fictional: not a fit for the role');
    expect((await owner.db.execute(sql`select outcome, review_reason, candidate_id from recruitment_agency_submission where id = ${waitingAgain.submissionId}::uuid`))[0])
      .toEqual({ outcome: 'rejected', review_reason: 'Fictional: not a fit for the role', candidate_id: null });
    expect(await code(acceptAgencySubmission(admin, waitingAgain.submissionId))).toBe('submission_decided');
  });
});

describe('case 71 — repeat submissions by the same agency are refused; two concurrent submissions give one application', () => {
  it('refuses while waiting, accepted and active, or inside the window; serialises concurrent submissions of the same person', async () => {
    const t = await team();
    const A = await agency({}, 'Fictional Agency A');
    const B = await agency({}, 'Fictional Agency B');
    for (const c of [A, B]) await assignAgencyContract(t.recruiter, t.jobId, c.contractId);
    const p = { fullName: 'Fictional Repeat Person', email: 'repeat@example.test' };
    const accepted = await submit(t.recruiter, t.jobId, A, p);
    expect(accepted.outcome).toBe('accepted');
    const stored = await count('recruitment_agency_submission');
    // Accepted and active.
    expect(await code(submit(t.recruiter, t.jobId, A, { ...p, mobile: '0170000001' }))).toBe('repeat_submission');
    expect(await code(submit(t.recruiter, t.jobId, A, { fullName: 'fictional  repeat  person', mobile: '', email: 'REPEAT@example.test' }))).toBe('repeat_submission');
    expect(await count('recruitment_agency_submission')).toBe(stored);
    // Inside the repeated-application window after the application is archived.
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, accepted.applicationId!, reason.id);
    expect(await code(submit(t.recruiter, t.jobId, A, p))).toBe('repeat_submission');
    // The direct write is refused by the database's own re-check.
    expect(await code(rows(t.recruiter, sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
      full_name, email, match_kind, outcome, created_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${A.contractId}::uuid,
      ${A.agencyId}::uuid, ${A.consultantId}::uuid, ${today}::date, ${p.fullName}, ${p.email}, 'duplicate', 'waiting', ${t.recruiter.userId}::uuid)`))).toBe('23505');
    // Past the window (closed four months ago with a three-month window): no longer a repeat; a Duplicate of its own channel waits.
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${kl(addCalendarMonths(today, -4), '09:00:00')}::timestamptz where id = ${accepted.applicationId}::uuid`;
    });
    const again = await submit(t.recruiter, t.jobId, A, p);
    expect(again.outcome).toBe('waiting');
    // While waiting.
    expect(await code(submit(t.recruiter, t.jobId, A, p))).toBe('repeat_submission');
    // Another job by the same agency is not a repeat.
    const j2 = (await createJob(admin, job({ title: 'Fictional second role', recruiterUserId: t.recruiter.userId }))).id;
    await assignAgencyContract(t.recruiter, j2, A.contractId);
    expect((await submit(t.recruiter, j2, A, { ...p, mobile: '0170000002' })).outcome).toBe('waiting');

    // Concurrency: two agencies submit the same new person at the same moment → one application; the other is protected.
    const q = { fullName: 'Fictional Concurrent Person', email: 'concurrent@example.test' };
    const key = `recruitment-referral:${base.tenantId}:${base.companyId}:email:concurrent@example.test`;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holding = new Promise<void>((ready) => {
      void owner.client.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        ready();
        await held;
      });
    });
    await holding;
    const racing = [submit(t.recruiter, t.jobId, A, q), submit(t.assistant, t.jobId, B, q)];
    await waiters(2);
    release();
    const outcomes = (await Promise.all(racing)).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['accepted', 'refused']);
    expect(await count('recruitment_application', sql`candidate_id in (select id from recruitment_candidate where email = 'concurrent@example.test')`)).toBe(1);
    // The same agency twice at once → one application, the other refused as a repeat with nothing stored.
    const r2 = { fullName: 'Fictional Twin Person', email: 'twin@example.test' };
    const results = await Promise.all([code(submit(t.recruiter, t.jobId, A, r2)), code(submit(t.assistant, t.jobId, A, r2))]);
    expect(results.sort()).toEqual(['ok', 'repeat_submission']);
    expect(await count('recruitment_application', sql`candidate_id in (select id from recruitment_candidate where email = 'twin@example.test')`)).toBe(1);
    expect(await count('recruitment_agency_submission', sql`email = 'twin@example.test'`)).toBe(1);
  });
});

describe('case 72 — contract positions counts and the expiry to-do match independently computed values', () => {
  it('counts submitted, accepted, interviewed, offered and hired per job; the HR contact gets the to-do from 30 days before the end to the end', async () => {
    const t = await team();
    const t2 = await team('Fictional second role');
    const t3 = await team('Fictional third role');
    const C = await agency({}, 'Fictional Counting Agency');
    const X = await agency({}, 'Fictional Other Agency');
    await assignAgencyContract(t.recruiter, t.jobId, C.contractId);
    await assignAgencyContract(t2.recruiter, t2.jobId, C.contractId);
    await assignAgencyContract(t3.recruiter, t3.jobId, C.contractId);
    await assignAgencyContract(t.recruiter, t.jobId, X.contractId);
    // Job 1: two accepted, one refused (protected by Agency X). Job 2: one waiting. Job 3: nothing.
    const x = await submit(t.recruiter, t.jobId, X, { fullName: 'Fictional Held Person', email: 'held@example.test' });
    const s1 = await submit(t.recruiter, t.jobId, C, { fullName: 'Fictional Hired Person', email: 'hired@example.test' });
    const s2 = await submit(t.recruiter, t.jobId, C, { fullName: 'Fictional Pending Person', email: 'pending@example.test' });
    const s3 = await submit(t.recruiter, t.jobId, C, { fullName: 'Fictional Held Person', email: 'held@example.test' });
    const { applicationId: other } = await addApplication(t3.recruiter, { jobId: t3.jobId, fullName: 'Fictional Board Person', email: 'board@example.test', candidateSource: 'job_board' });
    const s4 = await submit(t2.recruiter, t2.jobId, C, { fullName: 'Fictional Board Person', email: 'board@example.test' });
    expect([x.outcome, s1.outcome, s2.outcome, s3.outcome, s4.outcome]).toEqual(['accepted', 'accepted', 'accepted', 'refused', 'waiting']);
    expect(other).toBeTruthy();
    // s1: a held interview, an offer and hired. s2: a future interview and a cancelled past one only (not interviewed).
    const interview = (await recruitmentSettings(admin, base.companyId)).stages.find((st) => st.name === 'Interview')!.id;
    await moveApplication(t.recruiter, s1.applicationId!, interview);
    await scheduleInterview(t.recruiter, { applicationId: s1.applicationId!, type: 'video', startsAt: new Date(Date.now() - 3 * 3_600_000), durationMinutes: 60, interviewerIds: [t.interviewer.userId] });
    const fields = (await offerSettings(admin, base.companyId)).fields;
    const values = Object.fromEntries(fields.filter((f) => f.required).map((f) => [f.id, f.type === 'money' ? { amount: '1000', currency: 'MYR' } : f.type === 'date' ? { text: today } : { text: 'Fictional' }]));
    await saveOffer(t.recruiter, s1.applicationId!, values);
    for (let i = 0; i < 10; i++) {
      const [st] = await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id = ${s1.applicationId}::uuid`);
      if (st.state === 'hired') break;
      await moveApplication(admin, s1.applicationId!);
    }
    await moveApplication(t.recruiter, s2.applicationId!, interview);
    await scheduleInterview(t.recruiter, { applicationId: s2.applicationId!, type: 'phone', startsAt: new Date(Date.now() + 86_400_000), durationMinutes: 30, interviewerIds: [t.interviewer.userId] });
    const { id: cancelled } = await scheduleInterview(t.recruiter, { applicationId: s2.applicationId!, type: 'phone', startsAt: new Date(Date.now() - 86_400_000), durationMinutes: 30, interviewerIds: [t.interviewer.userId] });
    await cancelInterview(t.recruiter, cancelled);
    // Job 2's assignment is removed: the job stays in Positions because it has a submission.
    const a2 = (await jobAgencyContracts(t2.recruiter, t2.jobId)).assigned.find((y) => y.contractId === C.contractId)!;
    await removeAgencyAssignment(t2.recruiter, a2.id);
    // Independently: what the fixture did, with the hired state read back from the owner connection.
    const [hired] = await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id = ${s1.applicationId}::uuid`);
    expect(hired.state).toBe('hired');
    const expected = [
      { jobId: t3.jobId, assigned: true, submitted: 0, accepted: 0, interviewed: 0, offered: 0, hired: 0 },
      { jobId: t2.jobId, assigned: false, submitted: 1, accepted: 0, interviewed: 0, offered: 0, hired: 0 },
      { jobId: t.jobId, assigned: true, submitted: 3, accepted: 2, interviewed: 1, offered: 1, hired: 1 },
    ];
    const positions = (await agencyContract(admin, C.contractId)).positions;
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.map(({ jobId, assigned, submitted, accepted, interviewed, offered, hired: h }) => ({ jobId, assigned, submitted, accepted, interviewed, offered, hired: h })))
      .toEqual(expected);

    // Expiry: the HR contact only, from 30 days before the end date to the end date, while Enabled (Kuala Lumpur dates).
    const contact = await hrAdmin('Fictional HR Contact');
    const contactCtx = { ...contact, entitlements: admin.entitlements };
    const otherContact = await hrAdmin('Fictional Other Contact');
    const mk = async (name: string, over: Record<string, unknown>) => (await agency({ hrContactUserId: contact.userId, ...over }, name)).contractId;
    const due30 = await mk('Fictional Due In 30', { startsOn: addDays(today, -100), endsOn: addDays(today, 30) });
    const dueToday = await mk('Fictional Due Today', { startsOn: addDays(today, -100), endsOn: today });
    await mk('Fictional Due In 31', { startsOn: addDays(today, -100), endsOn: addDays(today, 31) });
    await mk('Fictional Ended Yesterday', { startsOn: addDays(today, -100), endsOn: addDays(today, -1) });
    await mk('Fictional Disabled Soon', { startsOn: addDays(today, -100), endsOn: addDays(today, 5), status: 'disabled' });
    await agency({ hrContactUserId: otherContact.userId, startsOn: addDays(today, -100), endsOn: addDays(today, 5) }, 'Fictional Someone Else');
    const expiry = (await recruitmentTodos(contactCtx, undefined)).filter((i) => i.kind === 'contractExpiry');
    expect(expiry.map((i) => i.id).sort()).toEqual([due30, dueToday].sort());
    expect(expiry.find((i) => i.id === dueToday)).toMatchObject({ endsOn: today, title: 'Fictional Due Today · Fictional contract', href: `/recruitment/settings/agencies/contracts/${dueToday}` });
    expect(expiry.find((i) => i.id === due30)!.at).toBe(new Date(kl(addDays(today, 30))).toISOString());
    expect(expiry.find((i) => i.id === dueToday)!.at).toBe(new Date(kl(today)).toISOString());
    expect((await recruitmentTodos(admin, undefined)).filter((i) => i.kind === 'contractExpiry')).toEqual([]);
    expect((await recruitmentTodos(t.recruiter, undefined)).filter((i) => i.kind === 'contractExpiry' || i.kind === 'agencyReview')).toEqual([]);
    // In the bell, with the link to the contract page; review to-dos for every administrator of the company, one per waiting submission.
    const bell = await pendingRecruitmentTasks(contactCtx, undefined);
    expect(bell.filter((i) => i.kind === 'recruitmentContractExpiry').map((i) => i.linkPath).sort())
      .toEqual([`/recruitment/settings/agencies/contracts/${due30}`, `/recruitment/settings/agencies/contracts/${dueToday}`].sort());
    expect(bell.filter((i) => i.kind === 'recruitmentAgencyReview').map((i) => i.id)).toEqual([`agencyReview:${s4.submissionId}`]);
    expect(RECRUITMENT_TASK_KINDS).toContain('recruitmentContractExpiry');
    // Accepted agency submissions are Applications updates for the job's recruiter and assistants (not their own).
    const updates = (await recruitmentUpdates(t.assistant, { companyIds: [base.companyId], category: 'applications' })).items;
    expect(updates.filter((u) => u.kind === 'agencySubmission').map((u) => u.id).sort()).toEqual([x.submissionId, s1.submissionId, s2.submissionId].sort());
    expect((await recruitmentUpdates(t.recruiter, { companyIds: [base.companyId], category: 'applications' })).items.filter((u) => u.kind === 'agencySubmission')).toEqual([]);
    expect((await recruitmentUpdates(t3.recruiter, { companyIds: [base.companyId], category: 'applications' })).items.filter((u) => u.kind === 'agencySubmission')).toEqual([]);
  });
});

describe('case 73 — removal, company deletion, row security and grants, the AI Centre read', () => {
  it('slice 5 removal leaves no personal data in submissions (accepted, refused and waiting ones about the person)', async () => {
    const t = await team();
    const t2 = await team('Fictional second role');
    const A = await agency({}, 'Fictional Agency A');
    const B = await agency({}, 'Fictional Agency B');
    await assignAgencyContract(t.recruiter, t.jobId, A.contractId);
    await assignAgencyContract(t2.recruiter, t2.jobId, B.contractId);
    await assignAgencyContract(t2.recruiter, t2.jobId, A.contractId);
    const who = { fullName: `${SENTINEL} Person`, email: 's10sentinel@example.test', mobile: '0181234567', idType: 'passport', idNumber: `${SENTINEL}ID`,
      currentSalaryAmount: '987654.32', currentSalaryCurrency: 'MYR', comments: `${SENTINEL} comment` };
    const accepted = await submit(t.recruiter, t.jobId, A, { ...who, resumeName: `${SENTINEL}.pdf`, resumeContent: pdf(SENTINEL), permissionConfirmed: 'on' });
    const refused = await submit(t2.recruiter, t2.jobId, B, who);
    expect(refused.outcome).toBe('refused');
    const waiting = await submit(t2.recruiter, t2.jobId, A, { ...who, resumeName: 'w.pdf', resumeContent: pdf(SENTINEL), permissionConfirmed: 'on' });
    expect(waiting.outcome).toBe('waiting');
    const unrelated = await submit(t2.recruiter, t2.jobId, B, { fullName: 'Fictional Unrelated', email: 'unrelated@example.test', comments: 'Fictional kept comment' });
    const [{ candidate_id: candidateId }] = await owner.db.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_agency_submission where id = ${accepted.submissionId}::uuid`);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, accepted.applicationId!, reason.id);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${kl(addCalendarMonths(today, -30), '09:00:00')}::timestamptz where id = ${accepted.applicationId}::uuid`;
    });
    expect(await destroyCandidates(admin, base.companyId, [candidateId], 'on')).toEqual({ removed: 1 });
    const after = await owner.db.execute<{ id: string; outcome: string; removed: boolean; job_id: string }>(sql`
      select id, outcome, personal_data_removed_at is not null as removed, job_id from recruitment_agency_submission order by created_at`);
    expect(after.map((r) => [r.id, r.outcome, r.removed])).toEqual([
      [accepted.submissionId, 'accepted', true], [refused.submissionId, 'refused', true], [waiting.submissionId, 'rejected', true], [unrelated.submissionId, 'accepted', false],
    ]);
    const tables = await owner.db.execute<{ relname: string }>(sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by c.relname`);
    expect(tables.map((x) => x.relname)).toEqual(expect.arrayContaining(NEW_TABLES));
    for (const { relname } of tables) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(relname)} r where to_jsonb(r.*)::text ilike ${`%${SENTINEL}%`}
        or to_jsonb(r.*)::text like '%987654.32%'`);
      expect(hit.n, `${relname} still holds personal data`).toBe(0);
    }
    const [bytes] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_agency_submission where position(${Buffer.from(SENTINEL)}::bytea in coalesce(resume_content, ''::bytea)) > 0`);
    expect(bytes.n).toBe(0);
    const [event] = await owner.db.execute<{ payload: Record<string, number> }>(sql`
      select payload from domain_event where event_type = 'recruitment-candidate.personal-data-removed' and aggregate_id = ${candidateId}::uuid`);
    expect(event.payload).toMatchObject({ agencySubmissions: 1, agencyMatchedSubmissions: 2 });
    // A removed submission can no longer be cleared or rewritten directly.
    expect(await rows(admin, sql`update recruitment_agency_submission set comments = 'x' where id = ${accepted.submissionId}::uuid returning id`).catch((e) => pgSqlState(e))).toBe('23514');
    expect((await jobAgencySubmissions(t.recruiter, t.jobId))[0]).toMatchObject({ fullName: null, removed: true, outcome: 'accepted' });
  });

  it('company deletion removes every agency row under a NOBYPASSRLS owner with row security forced, and removal works under that owner too', async () => {
    const [{ id: emptyCompany }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Empty Sdn Bhd' }).returning({ id: company.id });
    const { id: tagId } = await saveAgencyTag(admin, { companyId: emptyCompany, name: 'Fictional tag' });
    const { agencyId, contractId } = await agency({ companyId: emptyCompany }, 'Fictional Empty Agency');
    await saveAgency(admin, { id: agencyId, name: 'Fictional Empty Agency', tagIds: [tagId] });
    await uploadAgencyContractFile(admin, contractId, { fileName: 'c.pdf', content: pdf() });
    const listed = await login('Fictional Listed', emptyCompany);
    await addAgencyContractUser(admin, contractId, listed.userId);
    // And a removable candidate in the main company, with an accepted agency submission.
    const t = await team();
    const A = await agency({}, 'Fictional Main Agency');
    await assignAgencyContract(t.recruiter, t.jobId, A.contractId);
    const s = await submit(t.recruiter, t.jobId, A, { fullName: `${SENTINEL} Owner`, email: 'owner.rehearsal@example.test' });
    const [{ candidate_id: candidateId }] = await owner.db.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_agency_submission where id = ${s.submissionId}::uuid`);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, s.applicationId!, reason.id);
    const perTable = async (companyId: string) => Object.fromEntries(await Promise.all(NEW_TABLES.filter((x) => x !== 'recruitment_job_agency_contract' && x !== 'recruitment_agency_submission')
      .map(async (x) => [x, (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(x)} where company_id = ${companyId}::uuid`))[0].n])));
    expect(await perTable(emptyCompany)).toEqual({
      recruitment_agency: 1, recruitment_agency_consultant: 1, recruitment_agency_contract: 1, recruitment_agency_contract_terms: 1, recruitment_agency_contract_user: 1,
      recruitment_agency_tag: 1, recruitment_agency_tag_link: 1,
    });
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
      await tx.unsafe('set local role ai_hr_app');
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${base.adminUserId}, true), set_config('app.roles', 'hr_admin', true),
        set_config('app.grants', ${JSON.stringify([{ role: 'hr_admin', companyId: null }])}, true)`;
      // The app role cannot delete the setup itself (no grant), even an administrator with the company-delete context value.
      await tx`select set_config('app.recruitment_company_delete', ${emptyCompany}, true)`;
      await tx`savepoint direct`;
      await expect(tx`delete from recruitment_agency_contract where company_id = ${emptyCompany}::uuid`).rejects.toMatchObject({ code: '42501' });
      await tx`rollback to savepoint direct`;
      await tx`select set_config('app.recruitment_company_delete', '', true)`;
      const [removed] = await tx`select app.recruitment_delete_company_setup(${emptyCompany}::uuid) as n`;
      expect(Number(removed.n)).toBeGreaterThanOrEqual(5);
      const [destroyed] = await tx`select app.recruitment_destroy_candidate(${candidateId}::uuid) as r`;
      expect(destroyed.r).toMatchObject({ agencySubmissions: 1 });
      await tx`reset role`;
      for (const x of NEW_TABLES) {
        const [n] = await tx.unsafe(`select count(*)::int as n from public.${x} where company_id = '${emptyCompany}'::uuid`);
        expect(n.n, x).toBe(0);
      }
      const [cleared] = await tx`select full_name, email, personal_data_removed_at is not null as removed from recruitment_agency_submission where id = ${s.submissionId}::uuid`;
      expect(cleared).toEqual({ full_name: null, email: null, removed: true });
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => (e instanceof Error && e.message === ROLLBACK ? 'rolled back' : Promise.reject(e)));
    expect(done).toBe('rolled back');
    // Through the service as well (default owner): the company delete leaves no agency row behind.
    await withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${emptyCompany}::uuid)`));
    expect(Object.values(await perTable(emptyCompany)).every((n) => n === 0)).toBe(true);
  });

  it('every new table forces row security, grants to the app role and nothing to PUBLIC; the AI Centre read stays counts only', async () => {
    const meta = await owner.db.execute<{ relname: string; forced: boolean; enabled: boolean; app: string | null; public_grants: number }>(sql`
      select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
        (select string_agg(a.privilege_type, ',' order by a.privilege_type) from aclexplode(c.relacl) a where a.grantee = 'ai_hr_app'::regrole) as app,
        (select count(*)::int from aclexplode(c.relacl) a where a.grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${NEW_TABLES.join(',')}}`}::text[]) order by c.relname`);
    expect(meta.map((m) => m.relname)).toEqual([...NEW_TABLES].sort());
    for (const m of meta) {
      expect(m.forced && m.enabled, m.relname).toBe(true);
      expect(m.app, m.relname).toMatch(/SELECT/);
      expect(m.public_grants, m.relname).toBe(0);
    }
    expect(Object.fromEntries(meta.map((m) => [m.relname, m.app]))).toEqual({
      recruitment_agency: 'INSERT,SELECT,UPDATE', recruitment_agency_consultant: 'INSERT,SELECT,UPDATE', recruitment_agency_contract: 'INSERT,SELECT,UPDATE',
      recruitment_agency_contract_terms: 'INSERT,SELECT,UPDATE', recruitment_agency_contract_user: 'DELETE,INSERT,SELECT', recruitment_agency_submission: 'INSERT,SELECT,UPDATE',
      recruitment_agency_tag: 'DELETE,INSERT,SELECT,UPDATE', recruitment_agency_tag_link: 'DELETE,INSERT,SELECT', recruitment_job_agency_contract: 'DELETE,INSERT,SELECT,UPDATE',
    });
    // The definer functions pin their search path and are not executable by PUBLIC.
    const fns = await owner.db.execute<{ proname: string; secdef: boolean; config: string[] | null; public_exec: boolean }>(sql`
      select p.proname, p.prosecdef as secdef, p.proconfig as config, has_function_privilege('public', p.oid, 'execute') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname in ('recruitment_agency_submission_check', 'recruitment_application_agency', 'recruitment_user_administers', 'recruitment_admin_contacts',
        'recruitment_destroying_in') order by p.proname`);
    expect(fns).toHaveLength(5);
    for (const f of fns) {
      expect(f.secdef, f.proname).toBe(true);
      expect((f.config ?? []).some((c) => c.startsWith('search_path=pg_catalog')), f.proname).toBe(true);
    }
    // The AI Centre read: per-company counts only, whatever agency data exists.
    const t = await team();
    const A = await agency();
    await assignAgencyContract(t.recruiter, t.jobId, A.contractId);
    await submit(t.recruiter, t.jobId, A, { fullName: `${SENTINEL} AI`, email: 'ai.read@example.test' });
    const counts = await recruitmentPipelineCounts(admin);
    expect(counts.rows.length).toBeGreaterThan(0);
    const COUNT_KEYS = ['activeApplications', 'archived', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen'];
    for (const row of counts.rows) {
      expect(Object.keys(row).sort()).toEqual(['company', ...COUNT_KEYS].sort());
      for (const k of COUNT_KEYS) expect(Number.isInteger((row as Record<string, unknown>)[k]), k).toBe(true);
    }
    expect(JSON.stringify(counts)).not.toMatch(new RegExp(`${SENTINEL}|Fictional Agency`));
    expectNoLeakedValue(counts, Number(FEE_SENTINEL));
  });
});

describe('the bell provider stays cheap with many agency rows', () => {
  it('reads the review and expiry to-dos through the viewer\'s own indexes, within the bell timeout', async () => {
    const t = await team();
    const A = await agency();
    await assignAgencyContract(t.recruiter, t.jobId, A.contractId);
    const contact = await hrAdmin('Fictional Busy Contact');
    // Volume through the owner (past the guards): 3,000 waiting submissions over two companies and 600 contracts of another contact.
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_agency_contract (tenant_id, company_id, agency_id, name, contract_type, starts_on, ends_on, hr_contact_user_id, created_by_user_id, updated_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${A.agencyId}::uuid, 'Fictional bulk ' || g, 'rpo', ${addDays(today, -10)}::date, ${today}::date + (g % 60),
          ${base.adminUserId}::uuid, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid from generate_series(1, 600) g`;
      await tx`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on, full_name, email, match_kind, outcome, created_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${A.contractId}::uuid, ${A.agencyId}::uuid, ${A.consultantId}::uuid, ${today}::date,
          'Fictional Bulk ' || g, 'bulk' || g || '@example.test', 'suspected', 'waiting', ${t.recruiter.userId}::uuid from generate_series(1, 3000) g`;
      await tx`analyze recruitment_agency_submission`;
      await tx`analyze recruitment_agency_contract`;
    });
    const contactCtx = { ...contact, entitlements: admin.entitlements };
    const time = async (ctx: SessionContext) => {
      await pendingRecruitmentTasks(ctx, undefined);
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        await pendingRecruitmentTasks(ctx, undefined);
        runs.push(performance.now() - started);
      }
      return runs.sort((a, b) => a - b)[2];
    };
    const [adminMs, contactMs, recruiterMs] = [await time(admin), await time(contactCtx), await time(t.recruiter)];
    console.log(`bell median ms — administrator and HR contact of 600 contracts (50 review + 50 expiry items of 3,000 waiting submissions): ${adminMs.toFixed(1)}; HR contact with none due: ${contactMs.toFixed(1)}; recruiter: ${recruiterMs.toFixed(1)}`);
    const adminItems = await pendingRecruitmentTasks(admin, undefined);
    expect(adminItems.filter((i) => i.kind === 'recruitmentAgencyReview')).toHaveLength(50);
    expect(adminItems.filter((i) => i.kind === 'recruitmentContractExpiry').length).toBeGreaterThan(0);
    expect((await pendingRecruitmentTasks(t.recruiter, undefined)).filter((i) => i.kind === 'recruitmentAgencyReview')).toEqual([]);
    for (const ms of [adminMs, contactMs, recruiterMs]) expect(ms).toBeLessThan(BELL_TIMEOUT_MS);
  });
});

// ── Review fixes (independent review of slice 10, 11 November 2026): each scenario failed before its fix ─────────────
describe('review fix 1 — an accepted submission cannot claim an existing (protected) candidate', () => {
  it('refuses a direct accepted insert onto another channel\'s candidate, while the service\'s own new candidate still works', async () => {
    const r1 = await login('Fictional R1');
    const r2 = await login('Fictional R2');
    const { id: jobK } = await createJob(admin, job({ title: 'Fictional K', recruiterUserId: r1.userId }));
    const { id: jobJ } = await createJob(admin, job({ title: 'Fictional J', recruiterUserId: r2.userId }));
    const A = await agency({}, 'Fictional A');
    const B = await agency({}, 'Fictional B');
    await assignAgencyContract(admin, jobK, A.contractId);
    await assignAgencyContract(admin, jobJ, B.contractId);
    const p = { fullName: 'Fictional Protected Person', email: 'pp@example.test' };
    const first = await submit(r1, jobK, A, p);
    expect(first.outcome).toBe('accepted');
    expect((await submit(r2, jobJ, B, p)).outcome).toBe('refused');
    const [{ candidate_id: X }] = await owner.db.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_agency_submission where id = ${first.submissionId}::uuid`);
    const stage = await firstStageOf(jobJ);
    const appId = randomUUID();
    // The operator may add an application for X to their own job (slice 2 rules)…
    expect(await code(rows(r2, sql`insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, source, created_by_user_id, updated_by_user_id)
      values (${appId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${jobJ}::uuid, ${X}::uuid, ${stage}::uuid, 'agency', ${r2.userId}::uuid, ${r2.userId}::uuid)`))).toBe('ok');
    // …but cannot record Agency B's submission as accepted onto X: X was not created in this transaction.
    expect(await code(rows(r2, sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
      full_name, email, match_kind, outcome, candidate_id, application_id, created_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${jobJ}::uuid, ${B.contractId}::uuid,
      ${B.agencyId}::uuid, ${B.consultantId}::uuid, ${today}::date, ${p.fullName}, ${p.email}, 'new', 'accepted', ${X}::uuid, ${appId}::uuid, ${r2.userId}::uuid)`))).toBe('42501');
    // A fresh candidate made in the same transaction with the protected person's identity is still refused by the re-check.
    const refusedFresh = await withTenant(r2, async (tx) => {
      const c = randomUUID(); const a = randomUUID();
      await tx.execute(sql`insert into recruitment_candidate (id, tenant_id, company_id, full_name, email, created_by_user_id, updated_by_user_id)
        values (${c}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${p.fullName}, ${p.email}, ${r2.userId}::uuid, ${r2.userId}::uuid)`);
      await tx.execute(sql`insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, source, created_by_user_id, updated_by_user_id)
        values (${a}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${jobJ}::uuid, ${c}::uuid, ${stage}::uuid, 'agency', ${r2.userId}::uuid, ${r2.userId}::uuid)`);
      return code(tx.execute(sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
        full_name, email, match_kind, outcome, candidate_id, application_id, created_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${jobJ}::uuid, ${B.contractId}::uuid,
        ${B.agencyId}::uuid, ${B.consultantId}::uuid, ${today}::date, ${p.fullName}, ${p.email}, 'new', 'accepted', ${c}::uuid, ${a}::uuid, ${r2.userId}::uuid)`));
    }).catch((e: unknown) => pgSqlState(e));
    expect(refusedFresh).toBe('23514');
    expect(await count('recruitment_agency_submission', sql`outcome = 'accepted' and agency_id = ${B.agencyId}::uuid`)).toBe(0);
  });
});

describe('review fixes 2 and 3 — removal touches only submissions about the removed person, through indexes', () => {
  const removeCandidate = async (applicationId: string, candidateId: string) => {
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, applicationId, reason.id);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${kl(addCalendarMonths(today, -30), '09:00:00')}::timestamptz where id = ${applicationId}::uuid`;
    });
    expect(await destroyCandidates(admin, base.companyId, [candidateId], 'on')).toEqual({ removed: 1 });
  };
  it('leaves another person who shares a desk e-mail and mobile (Suspected), and a submission that matched someone else too', async () => {
    const r1 = await login('Fictional R1');
    const { id: jobK } = await createJob(admin, job({ title: 'Fictional K', recruiterUserId: r1.userId }));
    const { id: jobJ } = await createJob(admin, job({ title: 'Fictional J', recruiterUserId: r1.userId }));
    const A = await agency({}, 'Fictional A');
    const B = await agency({}, 'Fictional B');
    await assignAgencyContract(admin, jobK, A.contractId);
    await assignAgencyContract(admin, jobJ, B.contractId);
    const shared = { email: 'desk@agency-a.example.test', mobile: '0123456789' };
    const one = await submit(r1, jobK, A, { fullName: 'Fictional Person One', ...shared });
    expect(one.outcome).toBe('accepted');
    const two = await submit(r1, jobJ, B, { fullName: 'Fictional Person Two', ...shared, idType: 'nric', idNumber: '880808-08-8888', comments: 'Fictional comments about Person Two' });
    expect(two.outcome).toBe('waiting');
    // A third person matched as a Duplicate of Person One AND of another candidate (Y, same name and a second e-mail).
    const { candidateId: Y } = await addApplication(r1, { jobId: jobJ, fullName: 'Fictional Person One', email: 'second@example.test' });
    const C = await agency({}, 'Fictional C');
    await assignAgencyContract(admin, jobJ, C.contractId);
    // (Refused: Agency A's accepted application of Person One protects it.)
    const both = await submit(r1, jobJ, C, { fullName: 'Fictional Person One', email: 'second@example.test', mobile: '0123456789' });
    expect(both.outcome).toBe('refused');
    const links = async (id: string) => (await owner.db.execute<{ candidate_id: string; duplicate: boolean }>(sql`
      select candidate_id, duplicate from app.recruitment_agency_submission_match where submission_id = ${id}::uuid order by candidate_id`)).map((r) => `${r.candidate_id}:${r.duplicate}`);
    const [{ candidate_id: X }] = await owner.db.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_agency_submission where id = ${one.submissionId}::uuid`);
    expect(await links(two.submissionId)).toEqual([`${X}:false`]);
    expect((await links(both.submissionId)).sort()).toEqual([`${X}:true`, `${Y}:true`].sort());
    await removeCandidate(one.applicationId!, X);
    const [after] = await owner.db.execute(sql`select full_name, id_number, comments, outcome, personal_data_removed_at is not null as removed
      from recruitment_agency_submission where id = ${two.submissionId}::uuid`);
    expect(after).toEqual({ full_name: 'Fictional Person Two', id_number: '880808-08-8888', comments: 'Fictional comments about Person Two', outcome: 'waiting', removed: false });
    const [kept] = await owner.db.execute(sql`select full_name, outcome, personal_data_removed_at is not null as removed from recruitment_agency_submission where id = ${both.submissionId}::uuid`);
    expect(kept).toEqual({ full_name: 'Fictional Person One', outcome: 'refused', removed: false });
    expect(await links(two.submissionId)).toEqual([]);
    expect(await links(both.submissionId)).toEqual([`${Y}:true`]);
    const [mine] = await owner.db.execute(sql`select full_name, removed from (select full_name, personal_data_removed_at is not null as removed from recruitment_agency_submission where id = ${one.submissionId}::uuid) x`);
    expect(mine).toEqual({ full_name: null, removed: true });
  });
  it('uses only indexed lookups (no sequential scan with sequential scans switched off)', async () => {
    const id = randomUUID();
    const plans: string[] = [];
    await owner.client.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      for (const q of [
        `explain update public.recruitment_agency_submission s set full_name = null where s.candidate_id = '${id}' and s.tenant_id = '${base.tenantId}' and s.personal_data_removed_at is null`,
        `explain update public.recruitment_agency_submission s set full_name = null where s.id in (select m.submission_id from app.recruitment_agency_submission_match m
          where m.candidate_id = '${id}' and m.tenant_id = '${base.tenantId}' and m.duplicate and not exists (select 1 from app.recruitment_agency_submission_match o
          where o.submission_id = m.submission_id and o.candidate_id <> '${id}')) and s.candidate_id is null and s.personal_data_removed_at is null`,
        `explain delete from app.recruitment_agency_submission_match where candidate_id = '${id}'`,
      ]) {
        const out = await tx.unsafe(q);
        plans.push(out.map((r) => String((r as Record<string, unknown>)['QUERY PLAN'])).join('\n'));
      }
    });
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      expect(plan.length).toBeGreaterThan(0);
      expect(plan, plan).not.toMatch(/Seq Scan/);
    }
  });
});

describe('review fix 4 — administrators remove a decided submission\'s personal data; the Privacy due list', () => {
  it('clears a refused or rejected submission on confirmation only; lists decided ones older than the company\'s period', async () => {
    const t = await team();
    const A = await agency({}, 'Fictional A');
    const B = await agency({}, 'Fictional B');
    await assignAgencyContract(admin, t.jobId, A.contractId);
    await assignAgencyContract(admin, t.jobId, B.contractId);
    expect((await submit(t.recruiter, t.jobId, A, { fullName: 'Fictional Held', email: 'held@example.test', mobile: '0170000009' })).outcome).toBe('accepted');
    const refused = await submit(t.recruiter, t.jobId, B, { fullName: 'Fictional Held', email: 'held@example.test', comments: `${SENTINEL} refused comment` });
    expect(refused.outcome).toBe('refused');
    const C = await agency({}, 'Fictional C');
    await assignAgencyContract(admin, t.jobId, C.contractId);
    const waiting = await submit(t.recruiter, t.jobId, C, { fullName: 'Fictional Other', email: 'held@example.test', mobile: '0170000009' });
    expect(waiting.outcome).toBe('waiting');
    // Not due yet: decided today. Six months (the default "without consent") and a day ago: due.
    expect(await agencySubmissionsDue(admin, base.companyId)).toEqual([]);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_agency_submission set decided_at = ${kl(addCalendarMonths(today, -6), '09:00:00')}::timestamptz where id = ${refused.submissionId}::uuid`;
    });
    expect((await agencySubmissionsDue(admin, base.companyId)).map((d) => d.id)).toEqual([refused.submissionId]);
    expect(await code(agencySubmissionsDue(t.recruiter, base.companyId))).toBe('forbidden');
    // Recruiters cannot; a waiting one cannot; the confirmation is required; the app role cannot clear directly.
    expect(await code(removeAgencySubmissionData(t.recruiter, refused.submissionId, 'on'))).toBe('forbidden');
    expect(await code(removeAgencySubmissionData(admin, waiting.submissionId, 'on'))).toBe('submission_decided');
    expect(await code(removeAgencySubmissionData(admin, refused.submissionId, ''))).toBe('confirm_required');
    expect(await code(rows(admin, sql`update recruitment_agency_submission set full_name = null, email = null, comments = null, personal_data_removed_at = now()
      where id = ${refused.submissionId}::uuid`))).toBe('42501');
    await removeAgencySubmissionData(admin, refused.submissionId, 'on');
    const [row] = await owner.db.execute(sql`select full_name, email, comments, outcome, job_id, consultant_id, personal_data_removed_at is not null as removed
      from recruitment_agency_submission where id = ${refused.submissionId}::uuid`);
    expect(row).toEqual({ full_name: null, email: null, comments: null, outcome: 'refused', job_id: t.jobId, consultant_id: B.consultantId, removed: true });
    expect(await count('recruitment_agency_submission', sql`comments ilike ${`%${SENTINEL}%`}`)).toBe(0);
    expect((await owner.db.execute(sql`select 1 from app.recruitment_agency_submission_match where submission_id = ${refused.submissionId}::uuid`))).toHaveLength(0);
    expect(await agencySubmissionsDue(admin, base.companyId)).toEqual([]);
    const [ev] = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event where event_type = 'recruitment-agency.submission-data-removed'`);
    expect(JSON.stringify(ev.payload)).not.toMatch(/Fictional|held@/);
  });
});

describe('review fix 5 — accepting onto an existing candidate takes the candidate lock first; lock waits answer "try again"', () => {
  it('waits for a removal holding the candidate, and maps a lock timeout to candidate_busy', async () => {
    const t = await team();
    const other = await team('Fictional other role');
    const A = await agency({}, 'Fictional A');
    await assignAgencyContract(admin, t.jobId, A.contractId);
    const { candidateId: X } = await addApplication(other.recruiter, { jobId: other.jobId, fullName: 'Fictional Existing', email: 'existing@example.test' });
    const waiting = await submit(t.recruiter, t.jobId, A, { fullName: 'Fictional Existing', email: 'existing@example.test', resumeName: 'cv.pdf', resumeContent: pdf('fictional move'), permissionConfirmed: 'on' });
    expect(waiting.outcome).toBe('waiting');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holding = new Promise<void>((ready) => {
      void owner.client.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(app.recruitment_candidate_lock_key(${base.tenantId}::uuid, ${X}::uuid))`;
        ready();
        await held;
      });
    });
    await holding;
    const accepting = acceptAgencySubmission(admin, waiting.submissionId, { candidateId: X });
    await waiters(1);
    // While it waits on the candidate it holds no lock on the submission row.
    const [rowLocked] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation
      where c.relname = 'recruitment_agency_submission' and l.mode = 'RowShareLock'`);
    expect(rowLocked.n).toBe(0);
    release();
    const accepted = await accepting;
    expect(accepted.candidateId).toBe(X);
    // The waiting résumé moved onto the existing candidate.
    expect(await count('recruitment_candidate_file', sql`candidate_id = ${X}::uuid and kind = 'resume' and file_name = 'cv.pdf'`)).toBe(1);
    expect((await owner.db.execute(sql`select resume_content is null as moved from recruitment_agency_submission where id = ${waiting.submissionId}::uuid`))[0]).toEqual({ moved: true });
    // A lock wait that gives up (the check's 5 s lock timeout on an identity held elsewhere) asks the user to try again.
    const key = `recruitment-referral:${base.tenantId}:${base.companyId}:email:busy@example.test`;
    let release2!: () => void;
    const held2 = new Promise<void>((r) => { release2 = r; });
    const holding2 = new Promise<void>((ready) => {
      void owner.client.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        ready();
        await held2;
      });
    });
    await holding2;
    try {
      expect(await code(submit(t.recruiter, t.jobId, A, { fullName: 'Fictional Busy', email: 'busy@example.test' }))).toBe('candidate_busy');
    } finally {
      release2();
    }
  }, 30_000);
});

describe('review fix 6 — the bell with many companies', () => {
  it('skips the review branch without an administration grant, and stays cheap with 200 companies', async () => {
    const t = await team();
    const A = await agency();
    await assignAgencyContract(admin, t.jobId, A.contractId);
    await owner.db.execute(sql`insert into company (tenant_id, legal_name) select ${base.tenantId}::uuid, 'Fictional Company ' || g from generate_series(1, 199) g`);
    const [{ n: companies }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from company where tenant_id = ${base.tenantId}::uuid`);
    expect(companies).toBeGreaterThanOrEqual(200);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on, full_name, email, match_kind, outcome, created_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${A.contractId}::uuid, ${A.agencyId}::uuid, ${A.consultantId}::uuid, ${today}::date,
          'Fictional Bulk ' || g, 'bulk' || g || '@example.test', 'suspected', 'waiting', ${t.recruiter.userId}::uuid from generate_series(1, 500) g`;
      await tx`analyze company`;
      await tx`analyze recruitment_agency_submission`;
    });
    const partner = await login('Fictional Partner');
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: partner.userId, companyId: base.companyId, role: 'recruiting_partner' });
    const partnerCtx = { ...partner, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: base.companyId }] };
    const time = async (ctx: SessionContext) => {
      await pendingRecruitmentTasks(ctx, undefined);
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        await pendingRecruitmentTasks(ctx, undefined);
        runs.push(performance.now() - started);
      }
      return runs.sort((a, b) => a - b)[2];
    };
    const [adminMs, partnerMs, recruiterMs] = [await time(admin), await time(partnerCtx), await time(t.recruiter)];
    console.log(`bell median ms with ${companies} companies — group-wide administrator: ${adminMs.toFixed(1)}; company partner: ${partnerMs.toFixed(1)}; recruiter (no review branch): ${recruiterMs.toFixed(1)}`);
    expect((await pendingRecruitmentTasks(admin, undefined)).filter((i) => i.kind === 'recruitmentAgencyReview')).toHaveLength(50);
    expect((await pendingRecruitmentTasks(partnerCtx, undefined)).filter((i) => i.kind === 'recruitmentAgencyReview')).toHaveLength(50);
    expect((await pendingRecruitmentTasks(t.recruiter, undefined)).filter((i) => i.kind === 'recruitmentAgencyReview')).toEqual([]);
    for (const ms of [adminMs, partnerMs, recruiterMs]) expect(ms).toBeLessThan(BELL_TIMEOUT_MS);
  });
});

describe('review fix 7 — hardening', () => {
  it('the check needs an assigned, usable contract; user_administers answers only administrators; a demoted HR contact loses the contract and the to-do', async () => {
    const t = await team();
    const A = await agency({}, 'Fictional A');
    const unassigned = await agency({}, 'Fictional Unassigned');
    const expiring = await agency({ startsOn: addDays(today, -30), endsOn: addDays(today, 10) }, 'Fictional Expiring');
    await assignAgencyContract(admin, t.jobId, A.contractId);
    await assignAgencyContract(admin, t.jobId, expiring.contractId);
    const probe = (contractId: string) => rows(t.recruiter, sql`select outcome from app.recruitment_agency_submission_check(${t.jobId}::uuid, ${contractId}::uuid,
      'Fictional Probe', 'probe@example.test', null, null)`);
    expect(await probe(A.contractId)).toEqual([{ outcome: 'new' }]);
    expect(await code(probe(unassigned.contractId))).toBe('23514');
    await saveAgencyContract(admin, { id: expiring.contractId, name: 'Fictional contract', contractType: 'headhunter', feeRate: '10', startsOn: addDays(today, -30), endsOn: addDays(today, 10),
      hrContactUserId: base.adminUserId, status: 'disabled' });
    expect(await code(probe(expiring.contractId))).toBe('23514');
    // user_administers: only a caller who administers the company gets an answer.
    const ask = (ctx: SessionContext) => rows(ctx, sql`select app.recruitment_user_administers(${base.companyId}::uuid, ${base.adminUserId}::uuid) as ok`);
    expect(await ask(admin)).toEqual([{ ok: true }]);
    expect(await ask(t.recruiter)).toEqual([{ ok: false }]);
    // A demoted HR contact: with the administration grant they see the to-do and the contract; without it, neither.
    const contact = await hrAdmin('Fictional Contact');
    const c = await agency({ hrContactUserId: contact.userId, startsOn: addDays(today, -30), endsOn: addDays(today, 5) }, 'Fictional Contact Agency');
    const asAdmin = { ...contact, entitlements: admin.entitlements };
    const demoted = { ...contact, entitlements: admin.entitlements, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    expect((await recruitmentTodos(asAdmin, undefined)).filter((i) => i.kind === 'contractExpiry').map((i) => i.id)).toEqual([c.contractId]);
    expect((await recruitmentTodos(demoted, undefined)).filter((i) => i.kind === 'contractExpiry')).toEqual([]);
    expect(await rows(demoted, sql`select id from recruitment_agency_contract where id = ${c.contractId}::uuid`)).toHaveLength(0);
    // The private tables carry no grant to the app role or PUBLIC.
    const priv = await owner.db.execute<{ relname: string; forced: boolean; acl: string | null }>(sql`select c.relname, c.relforcerowsecurity as forced, c.relacl::text as acl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app'
        and c.relname in ('recruitment_agency_submission_match', 'recruitment_agency_attempt', 'recruitment_agency_clear_marker') order by c.relname`);
    expect(priv).toHaveLength(3);
    for (const p of priv) {
      expect(p.forced, p.relname).toBe(true);
      expect(p.acl ?? '', p.relname).not.toMatch(/ai_hr_app|(^|[{,])=/);
    }
  });
});

describe('review fix 8 — at most 50 agency submission attempts per recorder per Kuala Lumpur day', () => {
  it('counts every attempt (repeats included), refuses the 51st, and turns over at Kuala Lumpur midnight', async () => {
    const t = await team();
    const A = await agency();
    await assignAgencyContract(admin, t.jobId, A.contractId);
    const p = { fullName: 'Fictional Repeat', email: 'repeat.cap@example.test' };
    expect((await submit(t.recruiter, t.jobId, A, p)).outcome).toBe('accepted');
    expect(await code(submit(t.recruiter, t.jobId, A, p))).toBe('repeat_submission');
    const attempts = async () => (await owner.db.execute<{ outcome: string }>(sql`select outcome from app.recruitment_agency_attempt
      where tenant_id = ${base.tenantId}::uuid and app_user_id = ${t.recruiter.userId}::uuid order by attempted_at`)).map((r) => r.outcome);
    expect(await attempts()).toEqual(['new', 'repeat']);
    // 48 more today (00:00:00 Kuala Lumpur): the 51st attempt is refused and stores nothing.
    await owner.db.execute(sql`insert into app.recruitment_agency_attempt (tenant_id, app_user_id, attempted_at, outcome)
      select ${base.tenantId}::uuid, ${t.recruiter.userId}::uuid, ${kl(today)}::timestamptz, 'new' from generate_series(1, 48)`);
    const before = await count('recruitment_agency_submission');
    expect(await code(submit(t.recruiter, t.jobId, A, { fullName: 'Fictional Fifty One', email: 'fiftyone@example.test' }))).toBe('agency_daily_limit');
    expect(await count('recruitment_agency_submission')).toBe(before);
    // Another recorder is not affected.
    expect((await submit(t.assistant, t.jobId, A, { fullName: 'Fictional Assistant Pick', email: 'assist@example.test' })).outcome).toBe('accepted');
    // Moved to one second before today's Kuala Lumpur midnight, they no longer count.
    await owner.db.execute(sql`update app.recruitment_agency_attempt set attempted_at = ${kl(addDays(today, -1), '23:59:59')}::timestamptz
      where tenant_id = ${base.tenantId}::uuid and app_user_id = ${t.recruiter.userId}::uuid`);
    expect((await submit(t.recruiter, t.jobId, A, { fullName: 'Fictional Next Day', email: 'nextday@example.test' })).outcome).toBe('accepted');
  });
});

describe('review fix 9 — the check and the application\'s agency under a NOBYPASSRLS owner with row security forced', () => {
  it('answers the same outcomes and the same agency fields as under the test owner', async () => {
    const r1 = await login('Fictional R1');
    const r2 = await login('Fictional R2');
    const hm = await login('Fictional HM');
    const { id: jobK } = await createJob(admin, job({ title: 'Fictional K', recruiterUserId: r1.userId }));
    const { id: jobJ } = await createJob(admin, job({ title: 'Fictional J', recruiterUserId: r2.userId }));
    await addJobMember(admin, jobK, 'hiring_manager', hm.userId);
    const A = await agency({}, 'Fictional A');
    const B = await agency({}, 'Fictional B');
    await assignAgencyContract(admin, jobK, A.contractId);
    await assignAgencyContract(admin, jobJ, B.contractId);
    const first = await submit(r1, jobK, A, { fullName: 'Fictional Owner Person', email: 'op@example.test', mobile: '0111111111', idType: 'nric', idNumber: '770707-07-7777', comments: 'Fictional C' });
    expect(first.outcome).toBe('accepted');
    const probes: [string, string, string, string | null, string | null][] = [
      ['protected', 'Fictional Owner Person', 'op@example.test', null, null],
      ['protected', 'Fictional Other', 'zz@example.test', null, '770707077777'],
      ['suspected', 'Fictional Else', 'op@example.test', '0111111111', null],
      ['new', 'Fictional Nobody', 'nobody@example.test', null, null],
    ];
    const ROLLBACK = 'rolled back on purpose';
    const observed: Record<string, string[]> = {};
    for (const mode of ['test-owner', 'restricted-owner']) {
      const seen: string[] = [];
      await owner.client.begin(async (tx) => {
        if (mode === 'restricted-owner') {
          const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
          expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
          const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment', 'employment'];
          const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
          for (const x of tables) await tx.unsafe(`alter table ${x.name} owner to ai_hr_owner`);
          const fns = await tx<{ sig: string }[]>`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname ~ '^recruitment_'`;
          for (const f of fns) await tx.unsafe(`alter function ${f.sig} owner to ai_hr_owner`);
          await tx`grant usage on schema app, public to ai_hr_owner`;
          await tx`grant execute on all functions in schema app to ai_hr_owner`;
        }
        await tx.unsafe('set local role ai_hr_app');
        const as = async (userId: string, grants: unknown[], roles: string) => {
          await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('app.roles', ${roles}, true),
            set_config('app.grants', ${JSON.stringify(grants)}, true)`;
        };
        await as(r2.userId, [{ role: 'employee', companyId: null }], 'employee');
        for (const [, n, e, m, id] of probes) {
          const [row] = await tx`select outcome, match_ids from app.recruitment_agency_submission_check(${jobJ}::uuid, ${B.contractId}::uuid, ${n}, ${e}, ${m}, ${id})`;
          seen.push(`recruiter:${row.outcome}:${JSON.stringify(row.match_ids)}`);
        }
        await as(base.adminUserId, [{ role: 'hr_admin', companyId: null }], 'hr_admin');
        const [adm] = await tx`select outcome, match_ids from app.recruitment_agency_submission_check(${jobJ}::uuid, ${B.contractId}::uuid, 'Fictional Owner Person', 'op@example.test', null, null)`;
        seen.push(`admin:${adm.outcome}:${(adm.match_ids ?? []).length}`);
        await as(hm.userId, [{ role: 'employee', companyId: null }], 'employee');
        seen.push(`hm:${JSON.stringify(await tx`select agency_name, contract_name, comments from app.recruitment_application_agency(${first.applicationId}::uuid)`)}`);
        await as(r1.userId, [{ role: 'employee', companyId: null }], 'employee');
        seen.push(`recruiter:${JSON.stringify(await tx`select agency_name, contract_name, comments from app.recruitment_application_agency(${first.applicationId}::uuid)`)}`);
        throw new Error(ROLLBACK);
      }).catch((e: unknown) => { if (!(e instanceof Error && e.message === ROLLBACK)) throw e; });
      observed[mode] = seen;
    }
    const expected = [
      'recruiter:protected:null', 'recruiter:protected:null', 'recruiter:suspected:null', 'recruiter:new:null', 'admin:protected:1',
      'hm:[{"agency_name":"Fictional A","contract_name":null,"comments":null}]',
      'recruiter:[{"agency_name":"Fictional A","contract_name":"Fictional contract","comments":"Fictional C"}]',
    ];
    expect(observed['test-owner']).toEqual(expected);
    expect(observed['restricted-owner']).toEqual(expected);
    expect(probes.map((p) => p[0])).toEqual(['protected', 'protected', 'suspected', 'new']);
  });
});

// ── Re-review fixes ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('re-review fix 1 — an UPDATE cannot make an existing candidate look new', () => {
  const forge = (who: Login, jobId: string, a: { agencyId: string; contractId: string; consultantId: string }, candidateId: string, applicationId: string,
    p: { fullName: string; email: string }) => code(withTenant(who, async (tx) => {
    const touched = await tx.execute(sql`update recruitment_candidate set full_name = full_name where id = ${candidateId}::uuid returning id`);
    expect(touched).toHaveLength(1);
    const moved = await tx.execute(sql`update recruitment_application set source = 'agency' where id = ${applicationId}::uuid returning id`);
    expect(moved).toHaveLength(1);
    await tx.execute(sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
      full_name, email, match_kind, outcome, candidate_id, application_id, created_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${jobId}::uuid,
      ${a.contractId}::uuid, ${a.agencyId}::uuid, ${a.consultantId}::uuid, ${today}::date, ${p.fullName}, ${p.email}, 'new', 'accepted', ${candidateId}::uuid,
      ${applicationId}::uuid, ${who.userId}::uuid)`);
  }));
  it('refuses an accepted insert onto the operator\'s own existing candidate after a no-op update (probe 4)', async () => {
    const r1 = await login('Fictional R1');
    const { id: jobK } = await createJob(admin, job({ title: 'Fictional K', recruiterUserId: r1.userId }));
    const B = await agency({}, 'Fictional B');
    await assignAgencyContract(admin, jobK, B.contractId);
    const p = { fullName: 'Fictional Board Person', email: 'board.person@example.test' };
    const { candidateId: X, applicationId: app } = await addApplication(r1, { jobId: jobK, ...p, candidateSource: 'job_board' });
    expect(await forge(r1, jobK, B, X, app, p)).toBe('42501');
    expect(await count('recruitment_agency_submission', sql`job_id = ${jobK}::uuid`)).toBe(0);
    // The honest path for that person is a Duplicate waiting for an administrator.
    expect((await submit(r1, jobK, B, p)).outcome).toBe('waiting');
  });
  it('refuses the same route onto a referred candidate still inside the referral protection period', async () => {
    const r1 = await login('Fictional R1');
    const referrer = await login('Fictional Referrer');
    const { id: jobK } = await createJob(admin, job({ title: 'Fictional K', recruiterUserId: r1.userId }));
    await setJobReferralPortal(admin, jobK, true);
    const B = await agency({}, 'Fictional B');
    await assignAgencyContract(admin, jobK, B.contractId);
    const p = { fullName: 'Fictional Referred Person', email: 'referred.person@example.test' };
    await submitReferral(referrer, { jobId: jobK, ...p, mobile: '', reason: 'Fictional reason', confirmed: true });
    const [{ candidate_id: Z, application_id: app }] = await owner.db.execute<{ candidate_id: string; application_id: string }>(sql`
      select candidate_id, application_id from recruitment_referral where job_id = ${jobK}::uuid`);
    expect(await forge(r1, jobK, B, Z, app, p)).toBe('42501');
    const [kept] = await owner.db.execute(sql`select source from recruitment_application where id = ${app}::uuid`);
    expect(kept).toEqual({ source: 'referral' });
    expect(await count('recruitment_agency_submission', sql`job_id = ${jobK}::uuid`)).toBe(0);
    // Agency B's honest submission is refused: the referral still protects the credit.
    const C = await agency({}, 'Fictional C');
    const { id: jobJ } = await createJob(admin, job({ title: 'Fictional J', recruiterUserId: r1.userId }));
    await assignAgencyContract(admin, jobJ, C.contractId);
    expect((await submit(r1, jobJ, C, p)).outcome).toBe('refused');
  });
});

describe('re-review fix 2 — every direct call of the check counts against the daily cap', () => {
  it('counts direct calls, refuses the 51st, and keeps the uncounted internal variant from the app role', async () => {
    const t = await team();
    const A = await agency();
    await assignAgencyContract(admin, t.jobId, A.contractId);
    const probe = () => rows(t.recruiter, sql`select outcome from app.recruitment_agency_submission_check(${t.jobId}::uuid, ${A.contractId}::uuid,
      'Fictional Probe', 'probe.cap@example.test', null, null)`);
    for (let i = 0; i < 50; i++) expect(await probe()).toEqual([{ outcome: 'new' }]);
    expect(await probe()).toEqual([{ outcome: 'limit' }]);
    const [{ n }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_agency_attempt where app_user_id = ${t.recruiter.userId}::uuid`);
    expect(n).toBe(51);
    expect(await code(rows(t.recruiter, sql`select * from app.recruitment_agency_check(${t.jobId}::uuid, ${A.contractId}::uuid, 'Fictional Probe',
      'probe.cap@example.test', null, null, null, false)`))).toBe('42501');
    expect(await code(submit(t.recruiter, t.jobId, A, { fullName: 'Fictional Over', email: 'over@example.test' }))).toBe('agency_daily_limit');
    // A recording that fails after the check rolls its attempt back with it, and shows an error, never the outcome.
    const before = (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_agency_attempt where app_user_id = ${t.assistant.userId}::uuid`))[0].n;
    await owner.db.execute(sql.raw(`create or replace function public.s10_test_fail() returns trigger language plpgsql as $$ begin raise exception 'fictional failure' using errcode = 'P0001'; end $$;
      create trigger s10_test_fail before insert on public.recruitment_agency_submission for each row execute function public.s10_test_fail();`));
    try {
      expect(await code(submit(t.assistant, t.jobId, A, { fullName: 'Fictional Failing', email: 'failing@example.test' }))).toBe('P0001');
    } finally {
      await owner.db.execute(sql.raw('drop trigger s10_test_fail on public.recruitment_agency_submission; drop function public.s10_test_fail();'));
    }
    const after = (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_agency_attempt where app_user_id = ${t.assistant.userId}::uuid`))[0].n;
    expect(after).toBe(before);
  });
});

describe('re-review fix 3 — removal keeps a look-alike whose ID number differs', () => {
  it('only drops the link when the submission and the removed candidate both carry ID numbers that differ', async () => {
    const r1 = await login('Fictional R1');
    const { id: jobK } = await createJob(admin, job({ title: 'Fictional K', recruiterUserId: r1.userId }));
    const { id: jobJ } = await createJob(admin, job({ title: 'Fictional J', recruiterUserId: r1.userId }));
    const A = await agency({}, 'Fictional A');
    const B = await agency({}, 'Fictional B');
    await assignAgencyContract(admin, jobK, A.contractId);
    await assignAgencyContract(admin, jobJ, B.contractId);
    const desk = { fullName: 'Fictional Common Name', email: 'desk@agency.example.test' };
    const one = await submit(r1, jobK, A, { ...desk, idType: 'nric', idNumber: '900101-01-0001' });
    expect(one.outcome).toBe('accepted');
    const lookAlike = await submit(r1, jobJ, B, { ...desk, idType: 'nric', idNumber: '920202-02-0002', comments: 'Fictional different person' });
    const sameId = await submit(r1, jobJ, B, { fullName: 'Fictional Common Name', mobile: '0190000001', idType: 'nric', idNumber: '900101010001' });
    expect([lookAlike.outcome, sameId.outcome]).toEqual(['refused', 'refused']);
    const [{ candidate_id: X }] = await owner.db.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_agency_submission where id = ${one.submissionId}::uuid`);
    const links = async (id: string) => (await owner.db.execute<{ c: string }>(sql`select candidate_id::text as c from app.recruitment_agency_submission_match
      where submission_id = ${id}::uuid and duplicate`)).map((r) => r.c);
    expect(await links(lookAlike.submissionId)).toEqual([X]);
    expect(await links(sameId.submissionId)).toEqual([X]);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, one.applicationId!, reason.id);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${kl(addCalendarMonths(today, -30), '09:00:00')}::timestamptz where id = ${one.applicationId}::uuid`;
    });
    expect(await destroyCandidates(admin, base.companyId, [X], 'on')).toEqual({ removed: 1 });
    const [other] = await owner.db.execute(sql`select full_name, id_number, comments, outcome, personal_data_removed_at is not null as removed
      from recruitment_agency_submission where id = ${lookAlike.submissionId}::uuid`);
    expect(other).toEqual({ full_name: 'Fictional Common Name', id_number: '920202-02-0002', comments: 'Fictional different person', outcome: 'refused', removed: false });
    expect(await links(lookAlike.submissionId)).toEqual([]);
    const [same] = await owner.db.execute(sql`select full_name, id_number, personal_data_removed_at is not null as removed from recruitment_agency_submission where id = ${sameId.submissionId}::uuid`);
    expect(same).toEqual({ full_name: null, id_number: null, removed: true });
  });
});

describe('hardening — the owner-run submission guard refuses another tenant\'s row before anything else', () => {
  it('refuses an insert carrying another tenant\'s id with 42501, under the app role and under the (superuser) test owner', async () => {
    const t = await team();
    const A = await agency();
    await assignAgencyContract(admin, t.jobId, A.contractId);
    const other = await seedBase();
    const insert = (q: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) => q`insert into recruitment_agency_submission (tenant_id, company_id, job_id,
      contract_id, agency_id, consultant_id, submitted_on, full_name, email, match_kind, outcome, created_by_user_id) values (${other.tenantId}::uuid, ${base.companyId}::uuid,
      ${t.jobId}::uuid, ${A.contractId}::uuid, ${A.agencyId}::uuid, ${A.consultantId}::uuid, ${today}::date, 'Fictional Cross Tenant', 'cross@example.test', 'duplicate', 'waiting',
      ${t.recruiter.userId}::uuid)`;
    // As the app role (row security also applies, but the guard fires first).
    expect(await code(rows(t.recruiter, sql`insert into recruitment_agency_submission (tenant_id, company_id, job_id, contract_id, agency_id, consultant_id, submitted_on,
      full_name, email, match_kind, outcome, created_by_user_id) values (${other.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${A.contractId}::uuid,
      ${A.agencyId}::uuid, ${A.consultantId}::uuid, ${today}::date, 'Fictional Cross Tenant', 'cross@example.test', 'duplicate', 'waiting', ${t.recruiter.userId}::uuid)`))).toBe('42501');
    // As the superuser test owner, which bypasses row security: only the guard stands in the way.
    const [role] = await owner.db.execute<{ rolsuper: boolean }>(sql`select rolsuper from pg_roles where rolname = current_user`);
    expect(role.rolsuper).toBe(true);
    const ROLLBACK = 'rolled back on purpose';
    const seen = await owner.client.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${t.recruiter.userId}, true), set_config('app.roles', 'employee', true),
        set_config('app.grants', ${JSON.stringify([{ role: 'employee', companyId: null }])}, true)`;
      const result = await insert(tx as never).then(() => 'ok', (e: unknown) => (e as { code?: string }).code ?? String(e));
      expect(result).toBe('42501');
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => (e instanceof Error && e.message === ROLLBACK ? 'rolled back' : Promise.reject(e)));
    expect(seen).toBe('rolled back');
    expect(await count('recruitment_agency_submission', sql`email = 'cross@example.test'`)).toBe(0);
    const [{ n }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_agency_submission where tenant_id = ${other.tenantId}::uuid`);
    expect(n).toBe(0);
  });
});
