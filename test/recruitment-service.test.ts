/**
 * Recruitment slice 1, end to end against Postgres: the service rules (acceptance cases 1–7, 9) and the
 * authorization case 8 — module gate, the database predicate app.can_admin_recruitment_for, and row security
 * on the recruitment tables, with an HR administrator, a company-scoped Recruiting Partner, a partner of a
 * different company and a plain employee. All data is fictional.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, domainEvent, jobGrade, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { ModuleNotEnabledError } from '../core/entitlements';
import { deleteCompany } from '../core/admin';
import {
  addApplication, applicationHistory, candidateBoard, changeJobStatus, createJob, ensureRecruitmentDefaults, listJobs, moveApplication,
  recruitmentCompanies, recruitmentPipelineCounts, recruitmentSettings, rejectApplication, updateJob, updateStage, RecruitmentError,
} from '../packs/recruitment/service';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let partner: SessionContext;
let otherPartner: SessionContext;
let employee: SessionContext;
let otherCompanyId: string;
let gradeId: string;

async function partnerFor(companyId: string): Promise<SessionContext> {
  const [user] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}` }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: user.id, companyId, role: 'recruiting_partner' });
  return { ...admin, userId: user.id, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId }] };
}
const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error instanceof RecruitmentError) return error.code;
  if (error instanceof ModuleNotEnabledError) return 'module';
  return pgSqlState(error) ?? String(error);
};
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional payroll analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', ...over,
});

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
  partner = await partnerFor(base.companyId);
  otherPartner = await partnerFor(otherCompanyId);
  const employeeUser = await createAppUser(base.tenantId, null, 'employee');
  employee = { ...admin, userId: employeeUser, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
});

describe('case 1 — module gate and recruitment administration', () => {
  it('refuses every service call for a tenant without the module', async () => {
    await setModule(base.tenantId, 'recruitment', null);
    const off = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
    expect(await code(recruitmentCompanies(off, [base.companyId]))).toBe('module');
    expect(await code(createJob(off, job()))).toBe('module');
  });
  it('lists only the companies the caller administers recruitment for', async () => {
    const both = [base.companyId, otherCompanyId];
    expect((await recruitmentCompanies(admin, both)).map((c) => c.id).sort()).toEqual([...both].sort());
    expect((await recruitmentCompanies(partner, both)).map((c) => c.id)).toEqual([base.companyId]);
    expect(await recruitmentCompanies(employee, both)).toEqual([]);
  });
  it('gives the AI Centre counts only, scoped to the companies the caller administers', async () => {
    const { id: jobId } = await createJob(partner, job());
    await addApplication(partner, { jobId, fullName: 'PRIVATE_CANDIDATE_SENTINEL', email: 'sentinel@example.test', source: 'Referral' });
    await createJob(admin, job({ companyId: otherCompanyId, title: 'PRIVATE_JOB_TITLE_SENTINEL' }));
    const mine = await recruitmentPipelineCounts(partner);
    expect(mine.truncated).toBe(false);
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ openJobs: 1, onHoldJobs: 0, activeApplications: 1, toScreen: 1, hired: 0, archived: 0 });
    expect(Object.keys(mine.rows[0]).sort()).toEqual(['activeApplications', 'archived', 'company', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen']);
    const text = JSON.stringify(await Promise.all([mine, recruitmentPipelineCounts(otherPartner), recruitmentPipelineCounts(admin)]));
    for (const marker of ['PRIVATE_CANDIDATE_SENTINEL', 'sentinel@example.test', 'PRIVATE_JOB_TITLE_SENTINEL', 'MJ0']) expect(text).not.toContain(marker);
    expect((await recruitmentPipelineCounts(otherPartner)).rows).toEqual([expect.objectContaining({ company: 'Fictional Other Sdn Bhd', openJobs: 1, activeApplications: 0 })]);
    expect((await recruitmentPipelineCounts(admin)).rows.map((r) => r.company)).toContain('Fictional Other Sdn Bhd');
    expect((await recruitmentPipelineCounts(admin)).rows.length).toBeGreaterThanOrEqual(2);
    expect((await recruitmentPipelineCounts(employee)).rows).toEqual([]);
  });
});

describe('case 2 — seeded, editable defaults', () => {
  it('seeds nine ordered stages, one process and seven reasons, once', async () => {
    await ensureRecruitmentDefaults(partner, [base.companyId]);
    await ensureRecruitmentDefaults(admin, [base.companyId]);
    const settings = await recruitmentSettings(admin, base.companyId);
    expect(settings.processes).toHaveLength(1);
    expect(settings.processes[0].name).toBe('Recruitment process');
    expect(settings.processes[0].stages.map((s) => s.name)).toEqual([
      'Application Review', "Recruiter's Screening", 'AI Interview', 'Hiring Manager Review', 'Interview', 'Offer',
      'Medical check-up', 'Background check', 'Onboarding',
    ]);
    expect(settings.stages.filter((s) => s.systemKey).map((s) => s.name)).toEqual(['Application Review', 'Onboarding']);
    expect(settings.reasons.map((r) => r.kind)).toEqual(Array(7).fill('default'));
    // An edited default is never restored by a later seed.
    const screening = settings.stages.find((s) => s.name === "Recruiter's Screening")!;
    await updateStage(admin, screening.id, { name: 'Phone screen', type: 'screening', enabled: true });
    await ensureRecruitmentDefaults(admin, [base.companyId]);
    const again = await recruitmentSettings(admin, base.companyId);
    expect(again.stages.map((s) => s.name)).toContain('Phone screen');
    expect(again.stages.map((s) => s.name)).not.toContain("Recruiter's Screening");
    // System stages stay enabled.
    const review = again.stages.find((s) => s.systemKey === 'application_review')!;
    expect(await code(updateStage(admin, review.id, { name: review.name, type: 'system_default', enabled: false }))).toBe('system_stage');
  });
});

describe('cases 3 and 4 — jobs', () => {
  it('refuses a missing required field in the service and numbers jobs per company', async () => {
    expect(await code(createJob(admin, job({ title: '' })))).toBe('missing_fields');
    expect(await code(createJob(admin, job({ jobGradeIds: [] })))).toBe('missing_fields');
    const first = await createJob(admin, job());
    const second = await createJob(partner, job({ title: 'Fictional HR executive' }));
    const other = await createJob(admin, job({ companyId: otherCompanyId }));
    expect([first.jobNumber, second.jobNumber, other.jobNumber]).toEqual(['MJ000001', 'MJ000002', 'MJ000001']);
    expect(await code(createJob(partner, job({ companyId: otherCompanyId })))).toBe('forbidden');
  });

  it('moves status Open ↔ On hold → Closed, reopens, and lists the tabs accordingly', async () => {
    const { id } = await createJob(admin, job());
    await changeJobStatus(admin, id, 'on_hold');
    expect((await listJobs(admin, [base.companyId])).counts).toEqual({ opening: 1, closed: 0 });
    await changeJobStatus(admin, id, 'closed');
    expect(await code(changeJobStatus(admin, id, 'on_hold'))).toBe('invalid_status_change');
    const closed = await listJobs(admin, [base.companyId], { tab: 'closed' });
    expect(closed.counts).toEqual({ opening: 0, closed: 1 });
    expect(closed.rows.map((r) => r.id)).toEqual([id]);
    expect((await listJobs(admin, [base.companyId])).rows).toEqual([]);
    await changeJobStatus(admin, id, 'open');
    // The database refuses an illegal transition on its own.
    await changeJobStatus(admin, id, 'closed');
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`update recruitment_job_opening set status = 'on_hold' where id = ${id}::uuid`)))).toBe('23514');
  });
});

describe('cases 5, 6, 7 and 9 — the pipeline', () => {
  it('starts at the first stage, moves forward past a disabled stage, rejects with a reason and records history', async () => {
    const { id: jobId } = await createJob(partner, job());
    const { applicationId } = await addApplication(partner, { jobId, fullName: 'Fictional Candidate One', email: 'one@example.test', source: 'Referral' });
    let board = await candidateBoard(partner, [base.companyId], { jobId });
    expect(board.tabs[0]).toMatchObject({ name: 'Application Review', count: 1 });
    expect(board.cards.map((c) => c.id)).toEqual([applicationId]);

    // Case 5: the process is now fixed, refused by the service and audited, and refused by the database.
    const settings = await recruitmentSettings(admin, base.companyId);
    // Recruitment tables FORCE row security, so even the owner connection reads and writes them as an actor.
    const [{ id: altProcess }] = await withTenant(admin, (tx) => tx.execute<{ id: string }>(sql`
      insert into recruitment_process (tenant_id, company_id, name, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional alternate', ${admin.userId}::uuid, ${admin.userId}::uuid) returning id`));
    expect(await code(updateJob(partner, jobId, job({ processId: altProcess })))).toBe('process_locked');
    const refusals = await owner.db.select({ actor: domainEvent.actorId }).from(domainEvent)
      .where(and(eq(domainEvent.aggregateId, jobId), eq(domainEvent.eventType, 'recruitment-job.process-change-refused')));
    expect(refusals).toEqual([{ actor: partner.userId }]);
    expect(await code(withTenant(partner, (tx) => tx.execute(sql`update recruitment_job_opening set process_id = ${altProcess}::uuid where id = ${jobId}::uuid`)))).toBe('23514');

    // Case 6: disable the second stage; Move forward skips it.
    const screening = settings.stages.find((s) => s.name === "Recruiter's Screening")!;
    await updateStage(admin, screening.id, { name: screening.name, type: 'screening', enabled: false });
    expect(await moveApplication(partner, applicationId)).toEqual({ state: 'active', stageId: settings.stages.find((s) => s.name === 'AI Interview')!.id });
    board = await candidateBoard(partner, [base.companyId], { jobId });
    expect(board.tabs.find((t) => t.name === 'Application Review')!.count).toBe(0);
    expect(board.tabs.find((t) => t.name === 'AI Interview')!.count).toBe(1);

    // Case 7: a reason is required; the archived application keeps the stage it left.
    expect(await code(rejectApplication(partner, applicationId, undefined))).toBe('reason_required');
    const reason = (await recruitmentSettings(admin, base.companyId)).reasons.find((r) => r.external === 'No response')!;
    await rejectApplication(partner, applicationId, reason.id);
    const [archived] = await withTenant(admin, (tx) => tx.execute<{ state: string; stage: string; left: string }>(sql`
      select a.state, s.name as stage, l.name as left from recruitment_application a
      join recruitment_stage s on s.id = a.current_stage_id join recruitment_stage l on l.id = a.stage_left_at_archive where a.id = ${applicationId}::uuid`));
    expect(archived).toEqual({ state: 'archived', stage: 'AI Interview', left: 'AI Interview' });
    expect(await code(moveApplication(partner, applicationId))).toBe('application_closed');
    board = await candidateBoard(partner, [base.companyId], { jobId, tab: 'archived' });
    expect(board.tabs.find((t) => t.key === 'archived')!.count).toBe(1);

    // Case 9: every move and the rejection, with actor and time, oldest first.
    const history = await applicationHistory(partner, applicationId);
    expect(history.map((h) => [h.kind, h.fromStage, h.toStage, h.reason])).toEqual([
      ['applied', null, 'Application Review', null],
      ['moved', 'Application Review', 'AI Interview', null],
      ['rejected', 'AI Interview', null, 'No response'],
    ]);
    const actors = await withTenant(admin, (tx) => tx.execute<{ actor_user_id: string; occurred_at: string }>(sql`
      select actor_user_id, occurred_at from recruitment_application_event where application_id = ${applicationId}::uuid order by occurred_at`));
    expect(actors.map((a) => a.actor_user_id)).toEqual([partner.userId, partner.userId, partner.userId]);
    expect(actors.every((a) => a.occurred_at != null)).toBe(true);
    // History is append-only, even for its author.
    expect(await code(withTenant(partner, (tx) => tx.execute(sql`delete from recruitment_application_event where application_id = ${applicationId}::uuid`)))).toBe('42501');
  });

  it('hires from the last enabled stage', async () => {
    const { id: jobId } = await createJob(admin, job());
    const { applicationId } = await addApplication(admin, { jobId, fullName: 'Fictional Candidate Two' });
    let result = await moveApplication(admin, applicationId);
    for (let i = 0; i < 20 && result.state === 'active'; i += 1) result = await moveApplication(admin, applicationId);
    expect(result.state).toBe('hired');
    const history = await applicationHistory(admin, applicationId);
    expect(history.at(-1)).toMatchObject({ kind: 'hired', fromStage: 'Onboarding' });
    expect(history.filter((h) => h.kind === 'moved')).toHaveLength(8);
  });
});

describe('deleting a company (core/company-refs.ts)', () => {
  it('removes seeded recruitment setup with the company, and refuses while a job exists', async () => {
    await ensureRecruitmentDefaults(admin, [otherCompanyId]);
    const { id: jobId } = await createJob(admin, job({ companyId: otherCompanyId }));
    await expect(deleteCompany(admin, { id: otherCompanyId })).rejects.toThrow();
    // A job is retained hiring history; once it is gone (owner, outside the app path) the setup goes with the company.
    await owner.db.execute(sql`delete from recruitment_job_member where job_id = ${jobId}::uuid`);
    await owner.db.execute(sql`delete from recruitment_job_opening where id = ${jobId}::uuid`);
    // The other company's Recruiting Partner grant is itself a link that refuses a company delete; remove it.
    await owner.db.execute(sql`delete from role_assignment where company_id = ${otherCompanyId}::uuid`);
    await deleteCompany(admin, { id: otherCompanyId });
    const [left] = await owner.db.execute<{ n: number }>(sql`select
      (select count(*) from recruitment_stage where company_id = ${otherCompanyId}::uuid)
      + (select count(*) from recruitment_process where company_id = ${otherCompanyId}::uuid)
      + (select count(*) from recruitment_archive_reason where company_id = ${otherCompanyId}::uuid) as n`);
    expect(Number(left.n)).toBe(0);
  });
});

describe('case 8 — users without access cannot read or move applications', () => {
  it('refuses through the service and through row security', async () => {
    const { id: jobId } = await createJob(admin, job());
    const { applicationId } = await addApplication(admin, { jobId, fullName: 'Fictional Candidate Three' });

    for (const outsider of [employee, otherPartner]) {
      expect(await code(moveApplication(outsider, applicationId))).toBe('not_found');
      expect(await code(rejectApplication(outsider, applicationId, randomUUID()))).toBe('not_found');
      expect(await code(applicationHistory(outsider, applicationId))).toBe('not_found');
      if (outsider === otherPartner) expect((await candidateBoard(outsider, [otherCompanyId])).cards).toEqual([]);
      else expect(await code(candidateBoard(outsider, [otherCompanyId]))).toBe('forbidden');
      expect(await code(candidateBoard(outsider, [base.companyId]))).toBe('forbidden');
      for (const table of ['recruitment_application', 'recruitment_candidate', 'recruitment_job_opening', 'recruitment_application_event', 'recruitment_stage', 'recruitment_archive_reason']) {
        const rows = await withTenant(outsider, (tx) => tx.execute(sql`select 1 from ${sql.identifier(table)} where company_id = ${base.companyId}::uuid`));
        expect(rows.length, `${table} visible`).toBe(0);
      }
      expect(await code(withTenant(outsider, (tx) => tx.execute(sql`
        insert into recruitment_candidate (tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional intruder', ${outsider.userId}::uuid, ${outsider.userId}::uuid)`)))).toBe('42501');
    }
    // The company's own Recruiting Partner can read and move it.
    expect((await candidateBoard(partner, [base.companyId])).cards.map((c) => c.id)).toEqual([applicationId]);
    expect((await moveApplication(partner, applicationId)).state).toBe('active');
  });

  it('every recruitment table has forced row security and no grant to PUBLIC', async () => {
    const rows = await owner.db.execute<{ relname: string; rls: boolean; forced: boolean; public_grants: number }>(sql`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from information_schema.role_table_grants g where g.table_name = c.relname and g.grantee = 'PUBLIC') as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by c.relname`);
    // Slices 2–4 (4402–4404) add fourteen tables, slice 5 (4405) seven, slice 7 (4407) one, slice 8 (4408) three and slice 9
    // (4409) one; test/recruitment-slices-service.test.ts, test/recruitment-candidate-privacy.test.ts, test/recruitment-referrals.test.ts,
    // test/recruitment-careers.test.ts and test/recruitment-tasks.test.ts check them in detail.
    expect(rows.map((r) => r.relname)).toEqual([
      'recruitment_application', 'recruitment_application_event', 'recruitment_approval_step', 'recruitment_archive_reason', 'recruitment_candidate',
      'recruitment_candidate_consent', 'recruitment_candidate_entry', 'recruitment_candidate_file', 'recruitment_candidate_restricted', 'recruitment_candidate_tag',
      'recruitment_careers_application', 'recruitment_careers_notice', 'recruitment_careers_site', 'recruitment_company_setting', 'recruitment_evaluation_form', 'recruitment_hire_handoff', 'recruitment_interview', 'recruitment_interview_interviewer',
      'recruitment_job_member', 'recruitment_job_opening', 'recruitment_offer', 'recruitment_offer_approval', 'recruitment_offer_field', 'recruitment_offer_value',
      'recruitment_process', 'recruitment_process_stage', 'recruitment_referral', 'recruitment_requisition', 'recruitment_requisition_approval',
      'recruitment_requisition_job', 'recruitment_scorecard', 'recruitment_stage', 'recruitment_tag', 'recruitment_tag_group', 'recruitment_task_read_marker',
    ]);
    expect(rows.every((r) => r.rls && r.forced && r.public_grants === 0)).toBe(true);
  });
});
