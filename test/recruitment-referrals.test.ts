/**
 * Recruitment slice 7 against Postgres: acceptance cases 35–45 (docs/recruitment-reconstruction/specification.md
 * "Slice 7 acceptance cases") through the service AND directly as the app role: the referral portal, the refer path and
 * its refusals (one generic code to the referrer, the specific reason in HR's audit event), the protection period, the
 * concurrency lock, the daily limit, My referrals, HR's view and the slice 5 removal. Every person and value is fictional;
 * the referral reasons carry the sentinel S7SENTINEL so the page data and the removal can be searched for it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addCalendarMonths, todayInKualaLumpur } from '../lib/hr-date';
import {
  addApplication, addJobMember, applicationReferral, candidateBoard, changeJobStatus, createJob, destroyCandidates, moveApplication, myReferrals,
  recruitmentSettings, referralEligible, referralPortal, referralPortalJob, referralSettings, rejectApplication, scheduleInterview, setJobReferralPortal,
  submitReferral, updateReferralSettings, RecruitmentError,
} from '../packs/recruitment/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SENTINEL = 'S7SENTINEL';
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

/** A person with a login and an employment in each of `companyIds` (no employment for an empty list). */
async function employee(name: string, companyIds: string[] = [base.companyId], employmentOver: Record<string, unknown> = {}, b: Base = base, entitled = admin): Promise<SessionContext> {
  const [p] = await owner.db.insert(person).values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  for (const companyId of companyIds) {
    await owner.db.insert(employment).values({ tenantId: b.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01', ...employmentOver });
  }
  const [u] = await owner.db.insert(appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...entitled, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional data analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', ...over,
});
/** An Open job on the portal. */
async function portalJob(over: Record<string, unknown> = {}, ctx = admin) {
  const { id } = await createJob(ctx, job(over));
  await setJobReferralPortal(ctx, id, true);
  return id;
}
let seq = 0;
const refer = (ctx: SessionContext, jobId: string, over: Record<string, unknown> = {}) => submitReferral(ctx, {
  jobId, fullName: `Fictional Candidate ${++seq}`, email: `candidate${seq}@example.test`, mobile: '', reason: `${SENTINEL} reason ${seq}`, confirmed: true, ...over,
});
const refusals = async () => (await owner.db.execute<{ reason: string }>(sql`
  select payload->>'reason' as reason from domain_event where tenant_id = ${base.tenantId}::uuid and event_type = 'recruitment-referral.refused'
  order by sequence`)).map((r) => r.reason);
const count = async (table: string) => (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where tenant_id = ${base.tenantId}::uuid`))[0].n;
const pdf = (marker = 'fictional resume') => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`);
/** Fixture: change an employment past its guards (void, blacklist, end dates), through the owner connection. */
async function employmentSet(ctx: SessionContext, assignments: string) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx.unsafe(`update employment set ${assignments} where person_id = '${ctx.personId}'::uuid`);
  });
}
/** Wait (bounded) until `n` backends of this database are blocked on a lock of `kind` ('advisory', 'transactionid', 'tuple'). */
async function waiters(n: number, kinds: string[]) {
  for (let i = 0; i < 200; i++) {
    const [row] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and wait_event = any(${`{${kinds.join(',')}}`}::text[])`);
    if (row.n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${n} lock waiter(s)`);
}
/** A calendar day `n` days from `day` (plain date arithmetic; "today" itself comes from the HR date owner). */
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Kuala Lumpur wall-clock time on `day` as an instant (KL is UTC+8 all year). */
const klInstant = (day: string, hhmm: string) => `${day}T${hhmm}:00+08:00`;
/** Fixture time travel: a referral's creation instant, set by the owner past the referral guard. */
async function referredAt(referralId: string, daysAgo: number) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_referral set created_at = now() - make_interval(days => ${daysAgo}::int) where id = ${referralId}::uuid`;
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

describe('case 35 — the portal lists exactly the Open, portal jobs of the companies where the user may refer', () => {
  it('shows Open + portal jobs of employing companies; nothing for a user without an employment; never another company or tenant', async () => {
    const shown = await portalJob({ title: 'Fictional shown job' });
    const hidden = (await createJob(admin, job({ title: 'Fictional hidden job' }))).id;
    const onHold = await portalJob({ title: 'Fictional on-hold job' });
    await changeJobStatus(admin, onHold, 'on_hold');
    const closed = await portalJob({ title: 'Fictional closed job' });
    await changeJobStatus(admin, closed, 'closed');
    const otherCompany = await portalJob({ companyId: otherCompanyId, title: 'Fictional other company job' });
    // Another tenant with its own portal job.
    const base2 = await seedBase();
    await setModule(base2.tenantId, 'recruitment', 'active');
    const admin2: SessionContext = { ...(await entitledCtx(base2)), grants: [{ role: 'hr_admin', companyId: null }] };
    const [{ id: grade2 }] = await owner.db.insert(jobGrade).values({ tenantId: base2.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
    const { id: tenant2Job } = await createJob(admin2, { ...job(), companyId: base2.companyId, jobGradeIds: [grade2] });
    await setJobReferralPortal(admin2, tenant2Job, true);

    const worker = await employee('Fictional Referrer');
    const portal = await referralPortal(worker);
    expect(portal.eligible).toBe(true);
    expect(portal.jobs.map((j) => j.jobId)).toEqual([shown]);
    expect(await referralEligible(worker)).toBe(true);
    // Only the portal fields: never salary, the team or counts.
    expect(Object.keys(portal.jobs[0]).sort()).toEqual(['companyId', 'companyName', 'description', 'employmentType', 'jobId', 'jobLevels', 'jobNumber',
      'recruitmentType', 'title', 'workLocation']);
    expect(portal.jobs[0]).toMatchObject({ title: 'Fictional shown job', companyName: 'Acme Sdn Bhd', workLocation: 'Kuala Lumpur', jobLevels: ['Fictional grade 1'] });
    for (const id of [hidden, onHold, closed, otherCompany, tenant2Job]) expect(await referralPortalJob(worker, id), id).toBeNull();
    // Employed in both companies: both companies' portal jobs; still never the other tenant's.
    const both = await employee('Fictional Two-company Referrer', [base.companyId, otherCompanyId]);
    expect((await referralPortal(both)).jobs.map((j) => j.jobId).sort()).toEqual([shown, otherCompany].sort());

    // No employment, a terminated, voided, blacklisted or resigned one (last working day past), or one that starts in the
    // future: nothing at all. The canonical active rule — the login rule of app.login_blocked_on.
    const today = todayInKualaLumpur();
    const yesterday = addDays(today, -1);
    const outsider = await employee('Fictional Outsider', []);
    const leaver = await employee('Fictional Leaver', [base.companyId], { terminatedOn: addCalendarMonths(today, -1) });
    const joiner = await employee('Fictional Joiner', [base.companyId], { hiredOn: addCalendarMonths(today, 1) });
    const voided = await employee('Fictional Voided');
    await employmentSet(voided, `voided_at = now(), voided_by = '${admin.userId}'::uuid, void_reason = 'Fictional import error', voided_import_attempt_id = gen_random_uuid()`);
    const blacklisted = await employee('Fictional Blacklisted');
    await employmentSet(blacklisted, `blacklisted_at = '${yesterday}'::date`);
    const resigned = await employee('Fictional Resigned');
    await employmentSet(resigned, `resignation_date = '${addCalendarMonths(today, -1)}'::date, last_working_date = '${yesterday}'::date`);
    // Boundary: on the last working day itself the employment still counts (the login works that whole day too); serving
    // notice (an end date in the future) counts.
    const lastDay = await employee('Fictional Last Day');
    await employmentSet(lastDay, `last_working_date = '${today}'::date`);
    const servingNotice = await employee('Fictional Serving Notice');
    await employmentSet(servingNotice, `resignation_date = '${today}'::date, last_working_date = '${addDays(today, 30)}'::date`);
    for (const ctx of [lastDay, servingNotice]) expect((await referralPortal(ctx)).jobs.map((j) => j.jobId), ctx.personId!).toEqual([shown]);
    for (const ctx of [outsider, leaver, joiner, voided, blacklisted, resigned]) {
      expect(await referralPortal(ctx)).toEqual({ eligible: false, jobs: [] });
      expect(await referralEligible(ctx)).toBe(false);
      expect(await referralPortalJob(ctx, shown)).toBeNull();
    }
    // The other tenant's employee never sees this tenant's job, even by id.
    const tenant2Worker = await employee('Fictional Tenant Two Referrer', [base2.companyId], {}, base2, admin2);
    expect((await referralPortal(tenant2Worker)).jobs.map((j) => j.jobId)).toEqual([tenant2Job]);
    expect(await referralPortalJob(tenant2Worker, shown)).toBeNull();
  });
});

describe('case 36 — only a recruitment administrator changes the portal setting', () => {
  it('refuses the job team, an employee and another company\'s partner in the service and in the database', async () => {
    const recruiter = await employee('Fictional Recruiter');
    const worker = await employee('Fictional Employee');
    const { id: jobId } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
    const partnerB = await employee('Fictional Partner B', [otherCompanyId]);
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: partnerB.userId!, companyId: otherCompanyId, role: 'recruiting_partner' });
    const partner: SessionContext = { ...partnerB, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: otherCompanyId }] };

    expect(await code(setJobReferralPortal(recruiter, jobId, true))).toBe('forbidden');
    expect(await code(setJobReferralPortal(worker, jobId, true))).toBe('not_found');
    expect(await code(setJobReferralPortal(partner, jobId, true))).toBe('not_found');
    // Directly as the app role: row security leaves nothing to update.
    for (const ctx of [recruiter, worker, partner]) {
      expect(await rows(ctx, sql`update recruitment_job_opening set show_on_referral_portal = true where id = ${jobId}::uuid returning id`)).toHaveLength(0);
    }
    // And the guard refuses a non-administrator even where row security is not the barrier (the owner connection).
    const guarded = await owner.client.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${recruiter.userId!}, true), set_config('app.tenant_id', ${base.tenantId}, true)`;
      await tx`update recruitment_job_opening set show_on_referral_portal = true where id = ${jobId}::uuid`;
      return 'not refused';
    }).catch((e: unknown) => pgSqlState(e));
    expect(guarded).toBe('42501');
    expect((await owner.db.execute<{ on: boolean }>(sql`select show_on_referral_portal as on from recruitment_job_opening where id = ${jobId}::uuid`))[0].on).toBe(false);

    await setJobReferralPortal(admin, jobId, true);
    expect((await owner.db.execute<{ on: boolean }>(sql`select show_on_referral_portal as on from recruitment_job_opening where id = ${jobId}::uuid`))[0].on).toBe(true);
    const [event] = await owner.db.execute<{ payload: unknown }>(sql`select payload from domain_event where event_type = 'recruitment-job.referral-portal-changed' and aggregate_id = ${jobId}::uuid`);
    expect(event.payload).toEqual({ companyId: base.companyId, from: false, to: true });
  });
});

describe('case 37 — a referral creates the candidate, the application and the referral in one transaction', () => {
  it('starts at the first enabled stage with source referral, is audited, and the referrer reads none of the rows', async () => {
    const jobId = await portalJob();
    const worker = await employee('Fictional Referrer');
    const { referralId } = await submitReferral(worker, {
      jobId, fullName: 'Fictional Referred Person', email: 'Referred.Person@Example.test', mobile: '012-345 6789', reason: `${SENTINEL} strong analyst`, confirmed: 'on',
      file: { fileName: 'cv.pdf', content: pdf() },
    });
    const [ref] = await owner.db.execute<{ application_id: string; candidate_id: string; referrer_person_id: string; referrer_user_id: string; reason: string; confirmed: boolean; job_id: string }>(sql`
      select application_id, candidate_id, referrer_person_id, referrer_user_id, reason, confirmed_at is not null as confirmed, job_id from recruitment_referral where id = ${referralId}::uuid`);
    expect(ref).toMatchObject({ referrer_person_id: worker.personId, referrer_user_id: worker.userId, reason: `${SENTINEL} strong analyst`, confirmed: true, job_id: jobId });
    // The first enabled stage of the job's process, found independently.
    const [first] = await owner.db.execute<{ stage_id: string }>(sql`select ps.stage_id from recruitment_process_stage ps
      join recruitment_job_opening j on j.process_id = ps.process_id join recruitment_stage s on s.id = ps.stage_id
      where j.id = ${jobId}::uuid and s.enabled order by ps.position limit 1`);
    const [app] = await owner.db.execute<{ current_stage_id: string; source: string; state: string; candidate_id: string }>(sql`
      select current_stage_id, source, state, candidate_id from recruitment_application where id = ${ref.application_id}::uuid`);
    expect(app).toEqual({ current_stage_id: first.stage_id, source: 'referral', state: 'active', candidate_id: ref.candidate_id });
    const [cand] = await owner.db.execute<{ full_name: string; email: string; phone: string; source: string }>(sql`
      select full_name, email, phone, source from recruitment_candidate where id = ${ref.candidate_id}::uuid`);
    expect(cand).toEqual({ full_name: 'Fictional Referred Person', email: 'referred.person@example.test', phone: '012-345 6789', source: 'referral' });
    expect((await owner.db.execute(sql`select kind, actor_user_id from recruitment_application_event where application_id = ${ref.application_id}::uuid`)))
      .toEqual([{ kind: 'applied', actor_user_id: worker.userId }]);
    expect((await owner.db.execute(sql`select kind, mime_type, permission_confirmed from recruitment_candidate_file where candidate_id = ${ref.candidate_id}::uuid`)))
      .toEqual([{ kind: 'resume', mime_type: 'application/pdf', permission_confirmed: true }]);
    // The consent status stays "not recorded" until HR records it (slice 5).
    expect(await count('recruitment_candidate_consent')).toBe(0);
    const [event] = await owner.db.execute<{ actor_id: string; payload: Record<string, unknown> }>(sql`
      select actor_id, payload from domain_event where event_type = 'recruitment-referral.submitted' and aggregate_id = ${ref.application_id}::uuid`);
    expect(event).toEqual({ actor_id: worker.userId, payload: { companyId: base.companyId, jobId, referralId, candidateId: ref.candidate_id, resume: true } });
    expect(JSON.stringify(event)).not.toContain(SENTINEL);

    // The referrer cannot read or write any of those rows directly, nor the referral context marker.
    for (const table of ['recruitment_candidate', 'recruitment_application', 'recruitment_application_event', 'recruitment_candidate_file', 'recruitment_referral',
      'recruitment_job_opening', 'recruitment_stage']) {
      expect(await rows(worker, sql`select 1 from ${sql.identifier(table)} where tenant_id = ${base.tenantId}::uuid`), table).toHaveLength(0);
    }
    // The reason is not granted to the app role at all: nobody reads it directly, HR included (only the reviewer path
    // through app.recruitment_application_referral returns it).
    for (const ctx of [worker, admin]) {
      expect(await code(rows(ctx, sql`select reason from recruitment_referral where id = ${referralId}::uuid`))).toBe('42501');
      expect(await code(rows(ctx, sql`select * from recruitment_referral where id = ${referralId}::uuid`))).toBe('42501');
    }
    expect(await rows(admin, sql`select id, referrer_person_id from recruitment_referral where id = ${referralId}::uuid`)).toEqual([{ id: referralId, referrer_person_id: worker.personId }]);
    expect(await code(rows(worker, sql`insert into recruitment_referral (tenant_id, company_id, job_id, application_id, candidate_id, referrer_person_id, referrer_user_id, reason, confirmed_at)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${jobId}::uuid, ${ref.application_id}::uuid, ${ref.candidate_id}::uuid, ${worker.personId}::uuid, ${worker.userId}::uuid, 'x', now())`))).toBe('42501');
    expect(await code(rows(worker, sql`select * from app.recruitment_referral_context`))).toBe('42501');
    expect(await code(rows(worker, sql`insert into app.recruitment_referral_context (txid, company_id, tenant_id) values (txid_current(), ${base.companyId}::uuid, ${base.tenantId}::uuid)`))).toBe('42501');
    expect(await code(rows(worker, sql`select app.recruitment_referrer_companies()`))).toBe('42501');
    // Even an HR administrator cannot rewrite or delete a referral.
    expect(await code(rows(admin, sql`update recruitment_referral set reason = 'changed' where id = ${referralId}::uuid`))).toBe('42501');
    expect(await code(rows(admin, sql`delete from recruitment_referral where id = ${referralId}::uuid`))).toBe('42501');
  });

  it('flags a possible duplicate for HR the way slice 5 does, and still accepts the referral', async () => {
    const jobId = await portalJob();
    const other = (await createJob(admin, job({ title: 'Fictional other job' }))).id;
    await addApplication(admin, { jobId: other, fullName: 'Fictional Same Person', email: 'same.person@example.test' });
    const worker = await employee('Fictional Referrer');
    await submitReferral(worker, { jobId, fullName: 'fictional  same person', email: 'SAME.person@example.test', reason: 'Fictional reason', confirmed: true });
    const [flag] = await owner.db.execute<{ payload: unknown }>(sql`select payload from domain_event where event_type = 'recruitment-candidate.duplicate-flagged' and tenant_id = ${base.tenantId}::uuid`);
    expect(flag.payload).toEqual({ companyId: base.companyId, jobId, matches: 1, via: 'referral' });
  });
});

describe('case 38 — the service refuses a bad form; the database refuses an unavailable job', () => {
  it('refuses missing fields, a long reason, no agreement and a bad file; a closed, on-hold or hidden job is refused by the database', async () => {
    const jobId = await portalJob();
    const worker = await employee('Fictional Referrer');
    expect(await code(refer(worker, jobId, { fullName: ' ' }))).toBe('missing_fields');
    expect(await code(refer(worker, jobId, { email: '', mobile: '' }))).toBe('missing_fields');
    expect(await code(refer(worker, jobId, { reason: '' }))).toBe('missing_fields');
    expect(await code(refer(worker, jobId, { reason: 'x'.repeat(1001) }))).toBe('invalid_input');
    expect(await code(refer(worker, jobId, { confirmed: false }))).toBe('confirm_required');
    expect(await code(refer(worker, jobId, { email: 'not-an-email' }))).toBe('invalid_input');
    expect(await code(refer(worker, jobId, { file: { fileName: 'notes.txt', content: Buffer.from('plain text') } }))).toBe('file_type');
    expect(await code(refer(worker, jobId, { file: { fileName: 'cv.pdf', content: Buffer.from('not really a pdf') } }))).toBe('file_type');
    expect(await code(refer(worker, jobId, { file: { fileName: 'big.pdf', content: Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024)]) } }))).toBe('file_too_large');
    // A reason of exactly 1,000 characters is accepted.
    expect(await code(refer(worker, jobId, { reason: 'y'.repeat(1000) }))).toBe('ok');
    // The database refuses the same malformed input on its own (22023).
    expect(await code(rows(worker, sql`select app.recruitment_submit_referral(${jobId}::uuid, 'Fictional', 'a@example.test', null, ${'z'.repeat(1001)}, true)`))).toBe('22023');
    expect(await code(rows(worker, sql`select app.recruitment_submit_referral(${jobId}::uuid, 'Fictional', 'a@example.test', null, 'reason', false)`))).toBe('22023');
    expect(await code(rows(worker, sql`select app.recruitment_submit_referral(${jobId}::uuid, 'Fictional', null, null, 'reason', true)`))).toBe('22023');

    const onHold = await portalJob();
    await changeJobStatus(admin, onHold, 'on_hold');
    const closed = await portalJob();
    await changeJobStatus(admin, closed, 'closed');
    const hidden = (await createJob(admin, job())).id;
    const before = await count('recruitment_candidate');
    for (const id of [onHold, closed, hidden]) {
      expect(await code(refer(worker, id))).toBe('referral_refused');
      // Straight to the database as the app role, past the service: the function refuses it too.
      const [direct] = await rows(worker, sql`select app.recruitment_submit_referral(${id}::uuid, 'Fictional Direct', 'direct@example.test', null, 'Fictional reason', true) as r`);
      expect((direct as { r: unknown }).r).toEqual({ ok: false, reason: 'job_unavailable' });
    }
    expect(await count('recruitment_candidate')).toBe(before);
    expect(await refusals()).toEqual(Array(6).fill('job_unavailable'));
  });
});

describe('case 39 — an active application for the same job refuses the referral', () => {
  it('refuses with the generic code, names the reason in the audit event, and creates nothing; an archived one does not block', async () => {
    const jobId = await portalJob();
    const { applicationId } = await addApplication(admin, { jobId, fullName: 'Fictional Applicant', email: 'applicant@example.test', phone: '+60 12-777 8888' });
    const worker = await employee('Fictional Referrer');
    const before = { candidates: await count('recruitment_candidate'), applications: await count('recruitment_application'), referrals: await count('recruitment_referral') };
    // Matched on the normalised e-mail, and separately on the normalised mobile.
    expect(await code(refer(worker, jobId, { fullName: 'Fictional Someone', email: ' APPLICANT@example.test ' }))).toBe('referral_refused');
    expect(await code(refer(worker, jobId, { fullName: 'Fictional Someone', email: '', mobile: '60127778888' }))).toBe('referral_refused');
    expect(await refusals()).toEqual(['similar_application', 'similar_application']);
    expect({ candidates: await count('recruitment_candidate'), applications: await count('recruitment_application'), referrals: await count('recruitment_referral') }).toEqual(before);
    // The refusal event names the reason and nothing the referrer typed.
    expect(JSON.stringify(await owner.db.execute(sql`select payload from domain_event where event_type = 'recruitment-referral.refused'`))).not.toMatch(/applicant|Someone|S7SENTINEL/i);

    const [reasonRow] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, applicationId, reasonRow.id);
    expect(await code(refer(worker, jobId, { fullName: 'Fictional Applicant', email: 'applicant@example.test' }))).toBe('ok');
  });
});

describe('case 40 — the protection period', () => {
  it('refuses another employee within the period; accepts after it or with the period off; the same referrer may refer to a second job', async () => {
    const job1 = await portalJob({ title: 'Fictional job one' });
    const job2 = await portalJob({ title: 'Fictional job two' });
    const job3 = await portalJob({ title: 'Fictional job three' });
    const first = await employee('Fictional First Referrer');
    const second = await employee('Fictional Second Referrer');
    expect(await referralSettings(admin, base.companyId)).toEqual({ protectionDays: 180 });

    const { referralId } = await refer(first, job1, { fullName: 'Fictional Protected', email: '', mobile: '012-111 2222' });
    // Another employee, another job of the company, the same mobile written differently (digits only, as slice 5): refused.
    expect(await code(refer(second, job2, { fullName: 'Fictional Protected', email: '', mobile: '(012) 111.2222' }))).toBe('referral_refused');
    expect(await refusals()).toEqual(['already_referred']);
    // The first referrer may refer the same person to another job.
    expect(await code(refer(first, job2, { fullName: 'Fictional Protected', email: '', mobile: '0121112222' }))).toBe('ok');

    // 179 days ago is still inside a 180-day period; 181 days ago is outside it.
    const firstRefs = (await owner.db.execute<{ id: string }>(sql`select id from recruitment_referral where referrer_person_id = ${first.personId}::uuid`)).map((r) => r.id);
    expect(firstRefs).toContain(referralId);
    for (const id of firstRefs) await referredAt(id, 179);
    expect(await code(refer(second, job3, { fullName: 'Fictional Protected', email: '', mobile: '0121112222' }))).toBe('referral_refused');
    for (const id of firstRefs) await referredAt(id, 181);
    expect(await code(refer(second, job3, { fullName: 'Fictional Protected', email: '', mobile: '0121112222' }))).toBe('ok');

    // With the period off (0), another employee's fresh referral of the same person is accepted.
    await updateReferralSettings(admin, base.companyId, { protectionDays: '0' });
    expect(await referralSettings(admin, base.companyId)).toEqual({ protectionDays: 0 });
    await refer(first, job1, { fullName: 'Fictional Unprotected', email: 'unprotected@example.test' });
    expect(await code(refer(second, job2, { fullName: 'Fictional Unprotected', email: 'unprotected@example.test' }))).toBe('ok');
    // The setting is validated and administrator-only.
    expect(await code(updateReferralSettings(admin, base.companyId, { protectionDays: '731' }))).toBe('invalid_input');
    expect(await code(updateReferralSettings(first, base.companyId, { protectionDays: '10' }))).toBe('forbidden');
    expect(await code(rows(admin, sql`update recruitment_company_setting set referral_protection_days = 731 where company_id = ${base.companyId}::uuid`))).toBe('23514');
  });
});

describe('case 41 — two concurrent referrals of the same person', () => {
  it('accepts exactly one', async () => {
    const jobId = await portalJob();
    const a = await employee('Fictional Referrer A');
    const b = await employee('Fictional Referrer B');
    const c = await employee('Fictional Referrer C');
    // A barrier: a separate connection holds the company + e-mail identity lock, so all three submissions are provably
    // in flight together (each blocked on that lock after passing the referrer lock) before any may proceed.
    let inFlight!: Promise<PromiseSettledResult<unknown>[]>;
    await owner.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`recruitment-referral:${base.tenantId}:${base.companyId}:email:contested@example.test`}, 0))`;
      inFlight = Promise.allSettled([a, b, c].map((ctx) => submitReferral(ctx, {
        jobId, fullName: 'Fictional Contested', email: 'Contested@example.test', reason: 'Fictional reason', confirmed: true,
      })));
      await waiters(3, ['advisory']);
    }); // The barrier lock is released here; the three then pass the checks one at a time.
    const results = await inFlight;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => (r.reason as RecruitmentError).code)).toEqual(['referral_refused', 'referral_refused']);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate where email = 'contested@example.test'`))[0].n).toBe(1);
    expect(await count('recruitment_referral')).toBe(1);
  });
});

describe('case 42 — the daily limit', () => {
  it('refuses the 21st attempt on one Kuala Lumpur day, counting by the Kuala Lumpur date, not the UTC one', async () => {
    const jobId = await portalJob();
    const today = todayInKualaLumpur();
    const attempts = async (ctx: SessionContext, at: string) => {
      await owner.db.execute(sql`update app.recruitment_referral_attempt set attempted_at = ${at}::timestamptz where person_id = ${ctx.personId}::uuid`);
    };
    // 20 attempts at 00:30 today in Kuala Lumpur, which is 16:30 YESTERDAY in UTC: they count, so the 21st is refused.
    const worker = await employee('Fictional Busy Referrer');
    for (let i = 0; i < 20; i++) await refer(worker, jobId);
    await attempts(worker, klInstant(today, '00:30'));
    expect(await code(refer(worker, jobId))).toBe('referral_refused');
    expect(await refusals()).toEqual(['daily_limit']);
    expect(await count('recruitment_referral')).toBe(20);
    // 20 attempts at 23:30 YESTERDAY in Kuala Lumpur (15:30 yesterday in UTC): another day, so today's referral is accepted.
    // Together the two halves fail any UTC-date count at every hour of the day.
    const yesterdayWorker = await employee('Fictional Yesterday Referrer');
    for (let i = 0; i < 20; i++) await refer(yesterdayWorker, jobId);
    await attempts(yesterdayWorker, klInstant(addDays(today, -1), '23:30'));
    expect(await code(refer(yesterdayWorker, jobId))).toBe('ok');
    // Another employee is not affected.
    expect(await code(refer(await employee('Fictional Other Referrer'), jobId))).toBe('ok');
  });

  it('counts refused attempts too, so probing whether someone applied is bounded (D-023)', async () => {
    const jobId = await portalJob();
    await addApplication(admin, { jobId, fullName: 'Fictional Applicant', email: 'probed@example.test' });
    const prober = await employee('Fictional Prober');
    for (let i = 0; i < 20; i++) expect(await code(refer(prober, jobId, { email: 'probed@example.test' }))).toBe('referral_refused');
    // The 21st attempt — even a valid referral of someone new — is refused for the day; the same generic code.
    expect(await code(refer(prober, jobId))).toBe('referral_refused');
    expect(await refusals()).toEqual([...Array(20).fill('similar_application'), 'daily_limit']);
    const [log] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_referral_attempt where person_id = ${prober.personId}::uuid`);
    expect(log.n).toBe(21);
    // The attempt log holds no candidate data.
    expect(Object.keys((await owner.db.execute(sql`select * from app.recruitment_referral_attempt limit 1`))[0]).sort())
      .toEqual(['attempted_at', 'id', 'outcome', 'person_id', 'tenant_id']);
  });
});

describe('case 43 — My referrals', () => {
  it('shows only the user\'s own rows with the coarse status and nothing HR-internal', async () => {
    const jobId = await portalJob({ title: 'Fictional analyst role' });
    const mine = await employee('Fictional Referrer');
    const theirs = await employee('Fictional Other Referrer');
    // Candidate names that share no word with a stage name, so the sentinel check below means something.
    await refer(mine, jobId, { fullName: 'Fictional Alpha' });
    const r2 = await refer(mine, jobId, { fullName: 'Fictional Bravo' });
    const r3 = await refer(mine, jobId, { fullName: 'Fictional Charlie' });
    const r4 = await refer(mine, jobId, { fullName: 'Fictional Delta' });
    const r5 = await refer(mine, jobId, { fullName: 'Fictional Echo' });
    await refer(theirs, jobId, { fullName: 'Fictional Not Mine' });
    const appOf = async (referralId: string) => (await owner.db.execute<{ application_id: string }>(sql`select application_id from recruitment_referral where id = ${referralId}::uuid`))[0].application_id;
    const settings = await recruitmentSettings(admin, base.companyId);
    const stage = (name: string) => settings.stages.find((s) => s.name === name)!.id;
    await moveApplication(admin, await appOf(r2.referralId), stage('Interview'));
    await moveApplication(admin, await appOf(r3.referralId), stage('Offer'));
    await moveApplication(admin, await appOf(r4.referralId), stage('Onboarding'));
    await moveApplication(admin, await appOf(r4.referralId));
    await rejectApplication(admin, await appOf(r5.referralId), settings.reasons[0].id);

    const list = await myReferrals(mine);
    expect(list.map((r) => [r.candidateName, r.status]).sort()).toEqual([
      ['Fictional Alpha', 'in_review'], ['Fictional Bravo', 'interviewing'], ['Fictional Charlie', 'offer'], ['Fictional Delta', 'hired'],
      ['Fictional Echo', 'not_progressing'],
    ]);
    expect(list.every((r) => r.jobTitle === 'Fictional analyst role' && r.companyName === 'Acme Sdn Bhd')).toBe(true);
    expect(Object.keys(list[0]).sort()).toEqual(['candidateName', 'companyName', 'id', 'jobNumber', 'jobTitle', 'referredAt', 'status']);
    // Sentinel check over the page data: no reason, stage name, archive reason, interview, score or offer field.
    const data = JSON.stringify(list);
    for (const forbidden of [SENTINEL, ...settings.stages.map((s) => s.name), settings.reasons[0].internal, settings.reasons[0].external, 'startsAt', 'rating', 'offer_value', 'salary']) {
      expect(data, forbidden).not.toContain(forbidden);
    }
    expect((await myReferrals(theirs)).map((r) => r.candidateName)).toEqual(['Fictional Not Mine']);
    expect(await myReferrals(await employee('Fictional Nobody'))).toEqual([]);
  });
});

describe('case 44 — HR sees the referral; a company without Recruitment hides the portal and refuses', () => {
  it('shows "Employee referral" and the referrer to the application\'s readers, the reason to reviewers only', async () => {
    const jobId = await portalJob();
    const worker = await employee('Fictional Named Referrer');
    const { referralId } = await refer(worker, jobId, { fullName: 'Fictional HR View' });
    const [{ application_id: applicationId }] = await owner.db.execute<{ application_id: string }>(sql`select application_id from recruitment_referral where id = ${referralId}::uuid`);
    const seen = await applicationReferral(admin, applicationId);
    expect(seen).toMatchObject({ referrerName: 'Fictional Named Referrer', reason: expect.stringContaining(SENTINEL) });
    expect(new Date(seen!.referredAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const board = await candidateBoard(admin, [base.companyId], { jobId });
    expect(board.cards.find((c) => c.id === applicationId)?.source).toBe('referral');
    // An interviewer of the application sees who referred, not why; a bystander sees nothing.
    const interviewer = await employee('Fictional Interviewer');
    await scheduleInterview(admin, { applicationId, type: 'video', startsAt: new Date(Date.now() + 86_400_000), durationMinutes: 30, interviewerIds: [interviewer.userId] });
    expect(await applicationReferral(interviewer, applicationId)).toMatchObject({ referrerName: 'Fictional Named Referrer', reason: null });
    const manager = await employee('Fictional Hiring Manager');
    await addJobMember(admin, jobId, 'hiring_manager', manager.userId);
    expect((await applicationReferral(manager, applicationId))?.reason).toContain(SENTINEL);
    expect(await applicationReferral(await employee('Fictional Bystander'), applicationId)).toBeNull();
    expect(await rows(worker, sql`select * from app.recruitment_application_referral(${applicationId}::uuid)`)).toHaveLength(0);
  });

  it('a company-only Recruitment grant opens nothing: the portal is hidden and referrals are refused, as every HR screen is', async () => {
    const shown = await portalJob({ title: 'Fictional company A job' });
    // The tenant-wide grant is withdrawn; a grant stays for the first company only — which no HR screen honours either.
    await setModule(base.tenantId, 'recruitment', 'disabled');
    await setModule(base.tenantId, 'recruitment', 'active', base.companyId);
    const scoped = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin' as const, companyId: null }] };
    const worker = await employee('Fictional Company A Referrer', [base.companyId], {}, base, scoped);
    // The service gate refuses before any SQL (the pages show the "not open to you" note; the menu hides the entry).
    expect(await code(referralPortal(worker))).not.toBe('ok');
    expect(await code(referralPortalJob(worker, shown))).not.toBe('ok');
    expect(await code(refer(worker, shown))).not.toBe('ok');
    expect(await referralEligible(worker).catch(() => false)).toBe(false);
    // HR is refused the same way: no HR user could see, switch off or remove a referral here.
    expect(await code(setJobReferralPortal(scoped, shown, false))).not.toBe('ok');
    // And the database refuses on its own, straight from the app role, past the service gate.
    expect(await rows(worker, sql`select app.recruitment_referral_eligible() as ok`)).toEqual([{ ok: false }]);
    expect(await rows(worker, sql`select * from app.recruitment_referral_portal(null)`)).toEqual([]);
    const [direct] = await rows(worker, sql`select app.recruitment_submit_referral(${shown}::uuid, 'Fictional Direct', 'direct@example.test', null, 'Fictional reason', true) as r`);
    expect((direct as { r: unknown }).r).toEqual({ ok: false, reason: 'not_eligible' });
    expect(await refusals()).toEqual(['not_eligible']);
    expect(await count('recruitment_referral')).toBe(0);
  });

  it('refuses, audited and without writing anything, a caller with no employment in the job\'s company — an HR administrator included', async () => {
    const jobId = await portalJob();
    const otherJob = await portalJob({ companyId: otherCompanyId });
    // The seeded HR administrator has no person and no employment at all; this employee works for the first company only.
    const worker = await employee('Fictional Company A Referrer');
    const before = { candidates: await count('recruitment_candidate'), applications: await count('recruitment_application') };
    expect(await code(refer(admin, jobId))).toBe('referral_refused');
    expect(await code(refer(worker, otherJob))).toBe('referral_refused');
    expect(await refusals()).toEqual(['not_eligible', 'not_eligible']);
    expect({ candidates: await count('recruitment_candidate'), applications: await count('recruitment_application') }).toEqual(before);
  });
});

describe('case 45 — removal deletes the referral\'s personal data with the candidate and leaves no orphan', () => {
  it('clears the reason, keeps job and date, shows "Removed" on My referrals, and leaves no referral row without its candidate or application', async () => {
    const jobId = await portalJob();
    const worker = await employee('Fictional Referrer');
    const { referralId } = await refer(worker, jobId, { fullName: `${SENTINEL} Person`, email: 's7sentinel@example.test', file: { fileName: `${SENTINEL}.pdf`, content: pdf(SENTINEL) } });
    const [{ application_id: applicationId, candidate_id: candidateId }] = await owner.db.execute<{ application_id: string; candidate_id: string }>(sql`
      select application_id, candidate_id from recruitment_referral where id = ${referralId}::uuid`);
    const [reasonRow] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, applicationId, reasonRow.id);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${`${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`}::timestamptz where id = ${applicationId}::uuid`;
    });
    expect(await destroyCandidates(admin, base.companyId, [candidateId], 'on')).toEqual({ removed: 1 });

    const [ref] = await owner.db.execute<{ reason: string | null; job_id: string; created: boolean }>(sql`
      select reason, job_id, created_at is not null as created from recruitment_referral where id = ${referralId}::uuid`);
    expect(ref).toEqual({ reason: null, job_id: jobId, created: true });
    const [event] = await owner.db.execute<{ payload: Record<string, number> }>(sql`
      select payload from domain_event where event_type = 'recruitment-candidate.personal-data-removed' and aggregate_id = ${candidateId}::uuid`);
    expect(event.payload).toMatchObject({ referrals: 1, files: 1 });
    // No sentinel left in any recruitment table, in the file bytes, or on My referrals.
    const tables = await owner.db.execute<{ relname: string }>(sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by c.relname`);
    expect(tables.map((t) => t.relname)).toContain('recruitment_referral');
    for (const { relname } of tables) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(relname)} r where to_jsonb(r.*)::text ilike ${`%${SENTINEL}%`}`);
      expect(hit.n, `${relname} still holds personal data`).toBe(0);
    }
    const list = await myReferrals(worker);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'removed', candidateName: null });
    expect(JSON.stringify(list)).not.toContain(SENTINEL);
    expect(await applicationReferral(admin, applicationId)).toMatchObject({ referrerName: 'Fictional Referrer', reason: null });
    // No orphan: every referral still has its candidate, application and job.
    const [orphans] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_referral r
      left join recruitment_candidate c on c.id = r.candidate_id left join recruitment_application a on a.id = r.application_id
      left join recruitment_job_opening j on j.id = r.job_id where c.id is null or a.id is null or j.id is null`);
    expect(orphans.n).toBe(0);
    // A removed candidate can never be referred back through the old record, and a new referral starts a new candidate.
    expect(await code(refer(worker, jobId, { fullName: 'Fictional Returning', email: 's7sentinel@example.test' }))).toBe('ok');
  });
});

describe('the job row is locked during a referral', () => {
  it('a referral racing a close waits for the close and is then refused', async () => {
    const jobId = await portalJob();
    const worker = await employee('Fictional Racing Referrer');
    let pending!: Promise<string>;
    await owner.client.begin(async (tx) => {
      await tx`update recruitment_job_opening set status = 'closed' where id = ${jobId}::uuid`;
      pending = code(refer(worker, jobId));
      // The submission's FOR SHARE on the job row waits for this uncommitted close.
      await waiters(1, ['transactionid', 'tuple']);
    });
    expect(await pending).toBe('referral_refused');
    expect(await refusals()).toEqual(['job_unavailable']);
    expect(await count('recruitment_referral')).toBe(0);
  });
});

describe('the owner-only, marker-bound policies under a production-like owner', () => {
  it('lets the referral functions work for a NOBYPASSRLS owner, and only through those policies', async () => {
    const jobId = await portalJob({ title: 'Fictional owner rehearsal job' });
    const worker = await employee('Fictional Owner Rehearsal Referrer');
    const ROLLBACK = 'rolled back on purpose';
    // In the test cluster the superuser owns every table and bypasses row security, so nothing above proves the
    // marker-bound policies. Here, in ONE transaction that is rolled back, the migration role ai_hr_owner (as in
    // production: not a superuser, no BYPASSRLS) takes over the recruitment tables, the marker and attempt tables, the
    // kernel tables the definers read and the definer functions; then everything runs as the app role.
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'employment', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['public.recruitment_referral', 'app.recruitment_referral_context', 'app.recruitment_referral_attempt']));
      for (const t of tables) await tx.unsafe(`alter table ${t.name} owner to ai_hr_owner`);
      const fns = await tx<{ f: string }[]>`select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname ~ '^recruitment_' and p.prosecdef`;
      expect(fns.map((x) => x.f)).toEqual(expect.arrayContaining(['app.recruitment_submit_referral(uuid,text,text,text,text,boolean,text,text,bytea)']));
      for (const { f } of fns) await tx.unsafe(`alter function ${f} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      const as = async (who: string, userId: string, grants: object[] = []) => {
        await tx.unsafe(`set local role ${who}`);
        await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${userId}, true),
          set_config('app.roles', ${grants.length ? 'hr_admin' : 'employee'}, true), set_config('app.grants', ${JSON.stringify(grants)}, true),
          set_config('app.agent_principal_id', '', true)`;
      };
      const markers = async () => {
        await tx`reset role`;
        return (await tx<{ n: number }[]>`select count(*)::int as n from app.recruitment_referral_context`)[0].n;
      };

      // Outside a referral call the owner sees nothing: FORCE row security binds it, and no marker is held.
      await as('ai_hr_owner', worker.userId!);
      expect(await tx`select id from recruitment_job_opening`).toEqual([]);

      await as('ai_hr_app', worker.userId!);
      expect(await tx`select app.recruitment_referral_eligible() as ok`).toEqual([{ ok: true }]);
      expect((await tx`select job_id from app.recruitment_referral_portal(null)`).map((r) => r.job_id)).toEqual([jobId]);
      const [ok] = await tx`select app.recruitment_submit_referral(${jobId}::uuid, 'Fictional Owner Candidate', 'owner.candidate@example.test', null, 'Fictional reason', true,
        'cv.pdf', 'application/pdf', ${pdf()}::bytea) as r`;
      expect(ok.r).toMatchObject({ ok: true });
      const [similar] = await tx`select app.recruitment_submit_referral(${jobId}::uuid, 'Fictional Owner Candidate', 'OWNER.candidate@example.test', null, 'Fictional reason', true) as r`;
      expect(similar.r).toEqual({ ok: false, reason: 'similar_application' });
      expect((await tx`select candidate_name, removed, state from app.recruitment_my_referrals()`))
        .toEqual([{ candidate_name: 'Fictional Owner Candidate', removed: false, state: 'active' }]);
      // The app role still reads none of it directly.
      expect(await tx`select 1 from recruitment_candidate`).toEqual([]);
      expect(await markers()).toBe(0);
      const [{ application_id: applicationId }] = await tx<{ application_id: string }[]>`select application_id from recruitment_referral`;
      expect((await tx<{ n: number }[]>`select count(*)::int as n from recruitment_candidate_file`)[0].n).toBe(1);

      // HR reads the referral through its own definer (reviewer: the reason too).
      await as('ai_hr_app', admin.userId!, [{ role: 'hr_admin', companyId: null }]);
      expect(await tx`select referrer_name, reason from app.recruitment_application_referral(${applicationId}::uuid)`)
        .toEqual([{ referrer_name: 'Fictional Owner Rehearsal Referrer', reason: 'Fictional reason' }]);
      expect(await markers()).toBe(0);

      // Without the *_referral_* policies the same calls find nothing: this test fails if they are dropped.
      const policies = await tx<{ name: string; tbl: string }[]>`select policyname as name, format('%I.%I', schemaname, tablename) as tbl from pg_policies
        where (policyname ~ '^recruitment_[a-z_]+_referral_(read|insert)$' and policyname <> 'recruitment_referral_read') or policyname = 'recruitment_job_opening_referral_lock'`;
      expect(policies.length).toBe(13);
      for (const p of policies) await tx.unsafe(`drop policy ${p.name} on ${p.tbl}`);
      await as('ai_hr_app', worker.userId!);
      expect(await tx`select job_id from app.recruitment_referral_portal(null)`).toEqual([]);
      const [refused] = await tx`select app.recruitment_submit_referral(${jobId}::uuid, 'Fictional Second', 'second@example.test', null, 'Fictional reason', true) as r`;
      expect(refused.r).toEqual({ ok: false, reason: 'not_eligible' });
      expect(await markers()).toBe(0);
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => (e instanceof Error && e.message === ROLLBACK ? 'rolled back' : Promise.reject(e)));
    expect(done).toBe('rolled back');
    // Nothing of the rehearsal survives.
    expect(await count('recruitment_referral')).toBe(0);
    const [{ owner: tableOwner }] = await owner.db.execute<{ owner: string }>(sql`select tableowner as owner from pg_tables where tablename = 'recruitment_referral'`);
    expect(tableOwner).not.toBe('ai_hr_owner');
  });
});

describe('row security on the referral table', () => {
  it('forces row security, grants the app role every column but the reason, and nothing to PUBLIC', async () => {
    const [t] = await owner.db.execute<{ rls: boolean; forced: boolean }>(sql`select relrowsecurity as rls, relforcerowsecurity as forced from pg_class where oid = 'public.recruitment_referral'::regclass`);
    expect(t).toEqual({ rls: true, forced: true });
    // No table-level grant at all; column SELECT for every column except the reason.
    expect(await owner.db.execute(sql`select grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'recruitment_referral' and grantee in ('ai_hr_app', 'PUBLIC')`)).toEqual([]);
    const columns = await owner.db.execute<{ column_name: string; privilege_type: string }>(sql`select column_name, privilege_type from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'recruitment_referral' and grantee in ('ai_hr_app', 'PUBLIC') order by column_name`);
    expect(columns.every((c) => c.privilege_type === 'SELECT')).toBe(true);
    expect(columns.map((c) => c.column_name)).toEqual(['application_id', 'candidate_id', 'company_id', 'confirmed_at', 'created_at', 'id', 'job_id',
      'referrer_person_id', 'referrer_user_id', 'tenant_id']);
    const marker = await owner.db.execute(sql`select grantee from information_schema.role_table_grants where table_schema = 'app'
      and table_name in ('recruitment_referral_context', 'recruitment_referral_attempt') and grantee in ('ai_hr_app', 'PUBLIC')`);
    expect(marker).toEqual([]);
  });
});
