/**
 * Recruitment slice 24 against Postgres: acceptance cases 156–160 (docs/recruitment-reconstruction/specification.md "Slice 24
 * acceptance cases"). The provider contract has no owner approval in this repository, so the real path must refuse before reading
 * anything; the remaining refusals are exercised with the approval STATUS mocked (the gateway's own refusal is untouched, and no
 * provider is configured in tests, so nothing can leave). Every person and value is fictional.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { appUser, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { setAiCentreReadControl } from '../core/ai-centre-inventory';

const approval = vi.hoisted(() => ({ approved: false }));
vi.mock('../lib/ai/provider-data-reviews', async (original) => {
  const actual = await original<typeof import('../lib/ai/provider-data-reviews')>();
  return { ...actual, providerDataReviewStatus: (id: string) => (id === 'recruitment_match_summary_v1' && approval.approved ? 'approved' : actual.providerDataReviewStatus(id)) };
});

import {
  addApplication, addCandidateEntry, addJobMember, createJob, matchSummaryOffered, matchSummarySetting, recruitmentSettings, rejectApplication,
  suggestMatchSummary, updateMatchSummarySetting, RecruitmentError,
} from '../packs/recruitment/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let gradeId: string;
let seq = 0;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return (error as { reason?: string })?.reason ?? pgSqlState(error) ?? String(error);
};
const detail = async (operation: Promise<unknown>) => operation.then(() => null, (e: unknown) => (e instanceof RecruitmentError ? [...(e.detail ?? [])] : null));
const events = async (eventType: string) => (await owner.db.execute<{ payload: Record<string, unknown> }>(sql`
  select payload from domain_event where tenant_id = ${base.tenantId}::uuid and event_type = ${eventType} order by occurred_at, id`)).map((r) => r.payload);
const modelRuns = async () => Number((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ai_model_run where tenant_id = ${base.tenantId}::uuid`))[0].n);

/** A person with a login and an employment in the base company (employee role only). */
async function login(name: string): Promise<SessionContext & { userId: string }> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId: base.companyId, personId: p.id, hiredOn: '2024-01-01', employeeCode: `S24-${++seq}` });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
async function application(description = 'Fictional S24 job: build reports with SQL and present them.') {
  const { id: jobId } = await createJob(admin, { companyId: base.companyId, title: 'Fictional S24 analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
    recruitmentType: 'budgeted', employmentType: 'full_time', description });
  const { applicationId, candidateId } = await addApplication(admin, { jobId, fullName: `Fictional S24 Candidate ${++seq}`, email: `s24.c${seq}@example.test`, phone: '' });
  await owner.db.execute(sql`update recruitment_candidate set current_title = 'Fictional data analyst', highest_education = 'bachelor' where id = ${candidateId}::uuid`);
  await addCandidateEntry(admin, candidateId, { kind: 'work', organisation: 'Fictional Employer S24 Sdn Bhd', title: 'Reporting analyst', fromMonth: '2022-01', toMonth: '2024-12' });
  return { jobId, applicationId, candidateId };
}

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  approval.approved = false;
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
});

describe('case 156 — locked until the owner approves the provider data', () => {
  it('refuses before reading anything, offers no button and makes no model run, even with the switch on', async () => {
    const { applicationId } = await application();
    await updateMatchSummarySetting(admin, base.companyId, true);
    expect((await matchSummarySetting(admin, base.companyId))).toEqual({ companyId: base.companyId, on: true, approved: false });
    expect(await code(suggestMatchSummary(admin, applicationId))).toBe('ai_not_approved');
    expect(await matchSummaryOffered(admin, applicationId)).toBe(false);
    expect(await events('recruitment-application.ai-match-summary')).toEqual([]);
    expect(await modelRuns()).toBe(0);
  });
});

describe('case 157 — the company switch is off by default and only administrators change it', () => {
  it('defaults off, refuses a non-administrator, and audits each change', async () => {
    const employee = await login('Fictional S24 Employee');
    expect((await matchSummarySetting(admin, base.companyId)).on).toBe(false);
    expect(await code(updateMatchSummarySetting(employee, base.companyId, true))).toBe('forbidden');
    expect(await code(matchSummarySetting(employee, base.companyId))).toBe('forbidden');
    await updateMatchSummarySetting(admin, base.companyId, true);
    await updateMatchSummarySetting(admin, base.companyId, false);
    expect(await events('recruitment-setting.ai-match-summary-updated')).toEqual([
      { companyId: base.companyId, before: { on: false }, after: { on: true } },
      { companyId: base.companyId, before: { on: true }, after: { on: false } },
    ]);
  });
});

describe('case 158 — only the job\'s reviewers, only active applications, only with the switch on', () => {
  it('refuses interviewers and strangers as not found, a closed application, and a switched-off company', async () => {
    approval.approved = true;
    const { jobId, applicationId } = await application();
    const interviewer = await login('Fictional S24 Interviewer');
    const stranger = await login('Fictional S24 Stranger');
    const manager = await login('Fictional S24 Hiring Manager');
    await addJobMember(admin, jobId, 'interviewer', interviewer.userId);
    await addJobMember(admin, jobId, 'hiring_manager', manager.userId);
    expect(await code(suggestMatchSummary(admin, applicationId))).toBe('ai_off');
    expect(await matchSummaryOffered(admin, applicationId)).toBe(false);
    await updateMatchSummarySetting(admin, base.companyId, true);
    expect(await matchSummaryOffered(admin, applicationId)).toBe(true);
    expect(await matchSummaryOffered(manager, applicationId)).toBe(true);
    expect(await matchSummaryOffered(interviewer, applicationId)).toBe(false);
    for (const who of [interviewer, stranger]) expect(await code(suggestMatchSummary(who, applicationId))).toBe('not_found');
    expect(await code(suggestMatchSummary(admin, randomUUID()))).toBe('not_found');
    expect(await code(suggestMatchSummary(admin, 'not-a-uuid'))).toBe('not_found');
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, applicationId, reason.id);
    expect(await code(suggestMatchSummary(admin, applicationId))).toBe('ai_not_active');
    expect(await matchSummaryOffered(admin, applicationId)).toBe(false);
    expect(await modelRuns()).toBe(0);
  });
});

describe('case 159 — text holding an identifier is refused, naming the field', () => {
  it('refuses an e-mail address in the job description and a phone number in a history title', async () => {
    approval.approved = true;
    await updateMatchSummarySetting(admin, base.companyId, true);
    const a = await application('Fictional S24 job. Send questions to hiring.s24@example.test.');
    expect(await code(suggestMatchSummary(admin, a.applicationId))).toBe('ai_identifier');
    expect(await detail(suggestMatchSummary(admin, a.applicationId))).toEqual(['job.description']);
    await owner.db.execute(sql`update recruitment_job_opening set description = 'Fictional S24 job without identifiers.' where id = ${a.jobId}::uuid`);
    await addCandidateEntry(admin, a.candidateId, { kind: 'work', organisation: 'Fictional Org', title: 'Call 012-345 6789', fromMonth: '2020-01', toMonth: '2021-12' });
    expect(await detail(suggestMatchSummary(admin, a.applicationId))).toEqual(['candidate.history.title']);
    expect(await events('recruitment-application.ai-match-summary')).toEqual([]);
    expect(await modelRuns()).toBe(0);
  });
});

describe('case 160 — no provider configured, and the AI Centre control', () => {
  it('records an unavailable provider without content and stops when the AI Centre switch is off', async () => {
    approval.approved = true;
    await updateMatchSummarySetting(admin, base.companyId, true);
    const { applicationId } = await application();
    expect(await code(suggestMatchSummary(admin, applicationId))).toBe('ai_unavailable');
    const recorded = await events('recruitment-application.ai-match-summary');
    expect(recorded).toEqual([{ companyId: base.companyId, contractId: 'recruitment_match_summary_v1', outcome: 'provider-unavailable' }]);
    expect(JSON.stringify(recorded)).not.toMatch(/Fictional|analyst|SQL/);
    await setAiCentreReadControl(admin, 'read:operation_recruitment_match_summary', false);
    expect(await code(suggestMatchSummary(admin, applicationId))).toBe('paused');
    expect(await modelRuns()).toBe(0);
  });
});
