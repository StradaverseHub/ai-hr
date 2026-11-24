/**
 * docs/SCALE-AND-RELEASE-RULES.md rules 2 and 3 for the bell's recruitment to-dos (packs/recruitment/tasks.ts
 * pendingRecruitmentTasks, on every authenticated render), on the fictional group fixture of 71 companies and about 1,000
 * employments (test/helpers/ai-centre-scale-fixture.ts) with recruitment work spread over several companies.
 *
 * The bell's cost does not grow with companies: a group administrator under "All companies" (no selection, and all 71
 * companies selected), an administrator granted all 71 companies one by one, and a one-company administrator send the
 * same statements with the same number of parameters (a company selection is one array parameter), and a viewer with no
 * recruitment work stops after its first read. Each answers what the earlier single statement answered
 * (test/helpers/recruitment-personal-todos-original.ts). The statement every viewer pays has a much smaller plan than the
 * earlier one: its plan-node count is asserted (deterministic for the schema); the planning times are printed as evidence
 * only, because a runner's timings are not this assertion's to make.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { client, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  addApplication, addJobMember, assignAgencyContract, createJob, createRequisition, moveApplication, pendingRecruitmentTasks, recordAgencySubmission,
  saveAgency, saveAgencyConsultant, saveAgencyContract, saveApprovalFlow, scheduleInterview, submitRequisition, todoToPackTask,
} from '../packs/recruitment/service';
import { closeCareersPool } from '../packs/recruitment/careers';
import { originalRecruitmentTodos } from './helpers/recruitment-personal-todos-original';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';
import { isIdentityStatement, observeStatements, type Captured } from './helpers/statement-observer';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let b: Base;
let fixture: ScaleFixture;
let employee: SessionContext;
let interviewer: SessionContext;
let approver: SessionContext;
let seq = 0;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function login(name: string, companyId: string): Promise<SessionContext & { userId: string }> {
  const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${randomUUID()}@fixture.test` }).returning({ id: schema.person.id });
  await owner.db.insert(schema.employment).values({ tenantId: b.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...fixture.personas.group, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'recruitment', 'active');
  fixture = await buildScaleFixture(b, { events: 500 });
  const admin = fixture.personas.group;
  const today = todayInKualaLumpur();
  const [{ id: gradeId }] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: schema.jobGrade.id });
  [employee, interviewer, approver] = [await login('Fictional Plain Employee', fixture.singleCompanyId), await login('Fictional Interviewer', fixture.singleCompanyId),
    await login('Fictional Requisition Approver', fixture.singleCompanyId)];
  // Recruitment work in six operating companies (the single administrator's among them): a job with a waiting agency
  // submission (a duplicate of an existing candidate waits for review) and a held interview whose feedback is due.
  const companies = [fixture.singleCompanyId, ...fixture.operatingCompanyIds.filter((c) => c !== fixture.singleCompanyId).slice(0, 5)];
  // The interviewer works in each of these companies (a job's team is the company's active staff).
  const interviewerPerson = (await owner.db.execute<{ id: string }>(sql`select person_id as id from app_user where id = ${interviewer.userId!}::uuid`))[0].id;
  await owner.db.insert(schema.employment).values(companies.filter((c) => c !== fixture.singleCompanyId).map((companyId) => ({ tenantId: b.tenantId, companyId, personId: interviewerPerson, hiredOn: '2024-01-01' })));
  for (const companyId of companies) {
    const recruiter = await login(`Fictional Recruiter ${++seq}`, companyId);
    const { id: jobId } = await createJob(admin, { companyId, title: `Fictional role ${seq}`, jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted',
      employmentType: 'full_time', description: 'Fictional job description.', recruiterUserId: recruiter.userId });
    await addJobMember(admin, jobId, 'interviewer', interviewer.userId!);
    const email = `candidate${seq}@fixture.test`;
    const { applicationId } = await addApplication(recruiter, { jobId, fullName: `Fictional Candidate ${seq}`, email: `interviewed${seq}@fixture.test` });
    // The person the agency submits applied from a job board to another job of the company: the submission waits for review.
    const { id: boardJobId } = await createJob(admin, { companyId, title: `Fictional board role ${seq}`, jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
      recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', recruiterUserId: recruiter.userId });
    await addApplication(recruiter, { jobId: boardJobId, fullName: `Fictional Board Person ${seq}`, email, candidateSource: 'job_board' });
    const stage = (await owner.db.execute<{ id: string }>(sql`select ps.stage_id as id from recruitment_job_opening j join recruitment_process_stage ps on ps.process_id = j.process_id
      join recruitment_stage st on st.id = ps.stage_id where j.id = ${jobId}::uuid and st.stage_type = 'interview' order by ps.position limit 1`))[0].id;
    await moveApplication(recruiter, applicationId, stage);
    await scheduleInterview(recruiter, { applicationId, type: 'video', startsAt: new Date(Date.now() - 3 * 3_600_000), durationMinutes: 60, interviewerIds: [interviewer.userId!] });
    const { id: agencyId } = await saveAgency(admin, { companyId, name: `Fictional Agency ${seq}` });
    const { id: contractId } = await saveAgencyContract(admin, { agencyId, name: 'Fictional contract', contractType: 'headhunter', feeRate: '10',
      startsOn: addDays(today, -40), endsOn: addDays(today, 100), hrContactUserId: b.adminUserId, access: 'public' });
    const { id: consultantId } = await saveAgencyConsultant(admin, { contractId, name: `Fictional Consultant ${seq}`, email: `consultant${seq}@agency.fixture.test` });
    await assignAgencyContract(admin, jobId, contractId);
    expect((await recordAgencySubmission(recruiter, { jobId, contractId, consultantId, fullName: `Fictional Board Person ${seq}`, email })).outcome).toBe('waiting');
  }
  await saveApprovalFlow(admin, fixture.singleCompanyId, 'requisition', [approver.userId]);
  const { id: reqId } = await createRequisition(admin, { companyId: fixture.singleCompanyId, title: 'Fictional analysts', vacancies: '2', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted' });
  expect(await submitRequisition(admin, reqId)).toBe('pending');
}, 300_000);
afterAll(async () => { await closeCareersPool(); await closeAll(); });

const MAIN = /'requisitionApproval'::text as kind/;
/** The plan of one captured statement (and its planning time), replayed as the viewer after its identity statement. */
async function planOf(statements: readonly Captured[], pick: RegExp): Promise<{ nodes: number; planningMs: number[] }> {
  const identity = statements.find((s) => isIdentityStatement(s.sql))!;
  const target = statements.find((s) => pick.test(s.sql))!;
  expect(target, String(pick)).toBeDefined();
  return client.begin('isolation level repeatable read read only', async (tx) => {
    await tx.unsafe(identity.sql, identity.params as never[]);
    const planningMs: number[] = [];
    let nodes = 0;
    for (let i = 0; i < 5; i++) {
      const [row] = await tx.unsafe(`explain (summary on, costs off, format json) ${target.sql}`, target.params as never[]);
      const [plan] = (row as Record<string, unknown>)['QUERY PLAN'] as [{ Plan: { Plans?: unknown[] }; 'Planning Time': number }];
      const count = (n: { Plans?: unknown[] }): number => 1 + (n.Plans ?? []).reduce<number>((sum, child) => sum + count(child as { Plans?: unknown[] }), 0);
      nodes = count(plan.Plan);
      planningMs.push(plan['Planning Time']);
    }
    return { nodes, planningMs: planningMs.sort((x, y) => x - y) };
  }) as Promise<{ nodes: number; planningMs: number[] }>;
}

describe('the bell\'s recruitment to-dos at the shape of a 71-company group', () => {
  it('sends the same few statements whatever the number of companies, and answers as the earlier reader did', async () => {
    const { group, multi, single } = fixture.personas;
    const all = [...fixture.companyIds];
    const cases: [string, SessionContext, string[] | undefined, number][] = [
      ['group, no selection', group, undefined, 6], ['group, all companies', group, all, 6], ['group, one company', group, [fixture.singleCompanyId], 1],
      ['multi, all companies', multi, all, 6],
      ['single, its company', single, [fixture.singleCompanyId], 1], ['interviewer, no selection', interviewer, undefined, 6],
      ['approver, no selection', approver, undefined, 1], ['employee, no selection', employee, undefined, 0],
    ];
    const shapes: Record<string, number[]> = {};
    for (const [label, ctx, scope, items] of cases) {
      const observed = await observeStatements(() => pendingRecruitmentTasks(ctx, scope));
      expect(observed.result, label).toEqual((await originalRecruitmentTodos(ctx, scope)).flatMap((x) => todoToPackTask(x) ?? []));
      expect(observed.result, label).toHaveLength(items);
      expect(observed.transactions, label).toBe(1);
      // The identity, the statement timeout, the viewer's own rows, and the names only when there are rows.
      expect(observed.statements, label).toHaveLength(items ? 4 : 3);
      shapes[label] = observed.statements.map((s) => s.params.length);
    }
    // A selection of 71 companies is the same statements with the same parameters as a selection of one; 71 grants one by one
    // are the same as one.
    expect(shapes['group, all companies']).toEqual(shapes['group, one company']);
    expect(shapes['multi, all companies']).toEqual(shapes['single, its company']);
    expect(shapes['interviewer, no selection'].length).toBe(shapes['group, no selection'].length);
  }, 120_000);

  it('plans the statement every viewer pays far smaller than the earlier single statement', async () => {
    const report: string[] = [];
    const viewers: [string, SessionContext, string[] | undefined][] = [['group, all companies', fixture.personas.group, [...fixture.companyIds]], ['employee', employee, undefined]];
    for (const [label, ctx, scope] of viewers) {
      const now = await observeStatements(() => pendingRecruitmentTasks(ctx, scope));
      const before = await observeStatements(() => originalRecruitmentTodos(ctx, scope));
      const [current, earlier] = [await planOf(now.statements, MAIN), await planOf(before.statements, MAIN)];
      report.push(`${label}: plan nodes ${earlier.nodes} -> ${current.nodes}; planning ms median ${earlier.planningMs[2].toFixed(2)} -> ${current.planningMs[2].toFixed(2)}`);
      expect(current.nodes * 3, label).toBeLessThan(earlier.nodes);
    }
    console.info(`[bell-recruitment-plan] ${report.join(' | ')}`);
  }, 120_000);
});
