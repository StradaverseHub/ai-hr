/** Real restricted-role/owner regressions. Source prepared; run only in the coordinated DB window. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { ModuleNotEnabledError } from '../core/entitlements';
import { addTestingScreenshot, assignTestingCase, beginTestingExecution, getTestingExecution, getTestingScreenshot, listTestingAssignments, publishTestInstruction, raiseTestingExecutionFeedback, saveTestInstructionDraft, saveTestingExecution } from '../core/system-testing';
import { TestingRefusal, type InstructionDefinition } from '../lib/system-testing/model';
import { todayInKualaLumpur } from '../lib/hr-date';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let b: Base, admin: SessionContext, one: SessionContext, two: SessionContext;
const guide: InstructionDefinition = { format: 1, title: 'Fictional Personnel save/reopen', objective: 'Check an ordinary saved preferred name.', functionKey: 'personnel.profile', area: 'personnel', moduleCode: 'employees', category: 'functional', priority: 'high', active: true, prerequisites: ['Use the fictional assigned employee and normal company HR authority.'], testData: ['A fictional preferred name.'], steps: [{ id: 'save', action: 'Save the fictional preferred name in Personnel.', expected: 'Save succeeds.' }, { id: 'reopen', action: 'Reopen the same employee.', expected: 'The saved name is retained.' }], expectedBehavior: 'Saved data remains visible.', expectedFunction: 'Canonical Personnel profile write/read.', permissions: ['Company HR access to the fictional employee.'], jurisdiction: null, configuration: null, screenKeys: ['personnelAdmin'] };
beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'system_testing', 'active'); admin = await entitledCtx(b);
  async function tester(name: string, role: 'employee' | 'manager') {
    const hired = await hireEmployee(admin, { person: { fullName: name, primaryEmail: name.replaceAll(' ', '').toLowerCase() + '@system-testing.invalid' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
    const userId = await createAppUser(b.tenantId, hired.personId, role);
    return { ...await entitledCtx(b, [role]), userId, personId: hired.personId, grants: [{ role, companyId: null }] };
  }
  one = await tester('Fictional Tester One', 'employee'); two = await tester('Fictional Tester Two', 'manager');
});
async function setup() {
  const draft = await saveTestInstructionDraft(admin, { caseId: null, expectedRevision: 0, definition: guide });
  const version = await publishTestInstruction(admin, { caseId: draft.caseId, expectedDraftRevision: draft.revision, expectedVersionId: null });
  const a = await assignTestingCase(admin, { caseId: draft.caseId, testerUserId: one.userId!, expectedVersionId: version.versionId, active: true, expectedRevision: null });
  const other = await assignTestingCase(admin, { caseId: draft.caseId, testerUserId: two.userId!, expectedVersionId: version.versionId, active: true, expectedRevision: null });
  const execution = await beginTestingExecution(one, { assignmentId: a.assignmentId, expectedVersionId: version.versionId, newAttempt: false });
  return { draft, version, a, other, execution };
}
function observation(f: Awaited<ReturnType<typeof setup>>, status: 'passed' | 'failed' | 'in_progress' = 'passed') {
  return { executionId: f.execution.executionId, assignmentId: f.a.assignmentId, versionId: f.version.versionId, expectedRevision: 0, status, actualResult: status === 'failed' ? 'The fictional value was not retained.' : 'The fictional value was retained.', comments: 'Fictional observation', defectNotes: 'Fictional save/reopen failed.', improvementNotes: 'Make the fictional save status clearer.' };
}
describe('personal System Testing isolation and immutable instructions', () => {
  it('keeps two independent tester results and case-global run ordinals under actual non-bypass app role', async () => {
    const f = await setup(), e2 = await beginTestingExecution(two, { assignmentId: f.other.assignmentId, expectedVersionId: f.version.versionId, newAttempt: false });
    const [principal] = await withTenant(one, tx => tx.execute(sql`SELECT current_user,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`)) as unknown as { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[];
    expect(principal).toEqual({ current_user: 'ai_hr_app', rolsuper: false, rolbypassrls: false });
    await Promise.all([saveTestingExecution(one, observation(f)), saveTestingExecution(two, { ...observation(f, 'failed'), assignmentId: f.other.assignmentId, executionId: e2.executionId })]);
    expect((await listTestingAssignments(one)).rows.map(r => r.status)).toEqual(['passed']);
    expect((await listTestingAssignments(two)).rows.map(r => r.status)).toEqual(['failed']);
    const team = await listTestingAssignments(admin, { team: true });
    expect(team.rows.map(r => [r.testerUserId, r.status]).sort()).toEqual([[one.userId, 'passed'], [two.userId, 'failed']].sort());
    const rows = await owner.db.select().from(s.testRun).where(eq(s.testRun.testCaseId, f.draft.caseId)).orderBy(asc(s.testRun.runNo));
    expect(rows.map(r => r.runNo)).toEqual([1, 2]);
    const direct = await withTenant(one, tx => tx.select().from(s.testRun).where(eq(s.testRun.testCaseId, f.draft.caseId)));
    expect(direct).toHaveLength(1); expect(direct[0].runByUserId).toBe(one.userId);
    await expect(getTestingExecution(one, e2.executionId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(listTestingAssignments(one, { testerUserId: two.userId })).rejects.toMatchObject({ code: 'not_assigned' });
    await expect(listTestingAssignments(one, { team: true })).rejects.toMatchObject({ code: 'not_assigned' });
  });
  it('rejects forged tester/assignment/version and direct history rewriting, not merely a hidden UI', async () => {
    const f = await setup(); const saved = await saveTestingExecution(one, observation(f));
    await expect(beginTestingExecution(two, { assignmentId: f.a.assignmentId, expectedVersionId: f.version.versionId, newAttempt: false })).rejects.toMatchObject({ code: 'not_assigned' });
    await expect(withTenant(one, tx => tx.update(s.testRun).set({ actualResult: 'Forged replacement' }).where(eq(s.testRun.id, saved.runId)))).rejects.toThrow();
    await expect(withTenant(admin, tx => tx.update(s.testCaseVersion).set({ definition: { ...guide, title: 'Altered published instructions' } }).where(eq(s.testCaseVersion.id, f.version.versionId)))).rejects.toThrow();
    await expect(withTenant(one, tx => tx.insert(s.testExecution).values({ tenantId: b.tenantId, assignmentId: f.other.assignmentId, versionId: f.version.versionId, testerUserId: two.userId!, attemptNo: 1 }))).rejects.toThrow();
    const unseen = await withTenant(two, tx => tx.select().from(s.testExecution).where(eq(s.testExecution.id, f.execution.executionId))); expect(unseen).toEqual([]);
    const another = await seedBase(); const cross = { ...one, tenantId: another.tenantId };
    await expect(getTestingExecution(cross, f.execution.executionId)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('refuses simultaneous stale saves and preserves the successful observation exactly once', async () => {
    const f = await setup(), results = await Promise.allSettled([saveTestingExecution(one, observation(f)), saveTestingExecution(one, observation(f, 'failed'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const refusal = results.find(r => r.status === 'rejected'); expect(refusal?.status === 'rejected' && refusal.reason).toBeInstanceOf(TestingRefusal);
    expect(await owner.db.select().from(s.testRun).where(eq(s.testRun.executionId, f.execution.executionId))).toHaveLength(1);
    expect((await getTestingExecution(one, f.execution.executionId)).execution.revision).toBe(1);
  });
  it('publication requires retest and refuses the old open form without overwriting its earlier pass', async () => {
    const f = await setup(); await saveTestingExecution(one, observation(f));
    const [c] = await owner.db.select().from(s.testCase).where(eq(s.testCase.id, f.draft.caseId));
    const revised = await saveTestInstructionDraft(admin, { caseId: c.id, expectedRevision: c.draftRevision, definition: { ...guide, objective: 'Confirm the revised fictional instruction.' } });
    const v2 = await publishTestInstruction(admin, { caseId: c.id, expectedDraftRevision: revised.revision, expectedVersionId: f.version.versionId });
    expect(v2.ordinal).toBe(2);
    expect((await listTestingAssignments(one)).rows[0]).toMatchObject({ versionId: v2.versionId, status: 'retest_required' });
    await expect(saveTestingExecution(one, { ...observation(f), expectedRevision: 1 })).rejects.toMatchObject({ code: 'stale_instructions' });
    const old = await getTestingExecution(one, f.execution.executionId); expect(old.history[0].executionStatus).toBe('passed'); expect(old.version.id).toBe(f.version.versionId); expect(old.canSave).toBe(false);
    const next = await beginTestingExecution(one, { assignmentId: f.a.assignmentId, expectedVersionId: v2.versionId, newAttempt: false });
    expect(next.executionId).not.toBe(f.execution.executionId); expect(next.revision).toBe(0);
  });
  it('gates assigned testers and admins on a fresh canonical module snapshot without deleting stored history', async () => {
    const f = await setup(); await saveTestingExecution(one, observation(f));
    await setModule(b.tenantId, 'system_testing', 'disabled');
    const fresh = { ...await entitledCtx(b, ['employee']), userId: one.userId, personId: one.personId };
    await expect(listTestingAssignments(fresh)).rejects.toBeInstanceOf(ModuleNotEnabledError);
    await expect(listTestingAssignments(await entitledCtx(b), { team: true })).rejects.toBeInstanceOf(ModuleNotEnabledError);
    expect(await owner.db.select().from(s.testRun).where(eq(s.testRun.executionId, f.execution.executionId))).toHaveLength(1);
  });
});
describe('canonical execution evidence and Feedback transaction', () => {
  it('raises the same canonical defect once across retries and independent concurrent submissions', async () => {
    const f = await setup(); await saveTestingExecution(one, observation(f, 'failed'));
    const request = { executionId: f.execution.executionId, expectedRevision: 1, kind: 'defect' as const };
    const result = await Promise.all([raiseTestingExecutionFeedback(one, request), raiseTestingExecutionFeedback(one, request)]);
    expect(new Set(result.map(r => r.feedbackId)).size).toBe(1);
    const rows = await owner.db.select().from(s.feedbackRequest).where(and(eq(s.feedbackRequest.reporterUserId, one.userId!), eq(s.feedbackRequest.category, 'issue')));
    expect(rows).toHaveLength(1); expect(rows[0].id).toBe(result[0].feedbackId);
    expect(rows[0].description).toContain(f.version.versionId); expect(rows[0].description).toContain(f.execution.executionId);
    await expect(raiseTestingExecutionFeedback(two, request)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rolls canonical Feedback and its event back if the later execution link fails', async () => {
    const f = await setup(); await saveTestingExecution(one, observation(f, 'failed'));
    await owner.db.execute(sql`CREATE FUNCTION public.b16_testing_refuse_link() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.defect_feedback_id IS NOT NULL THEN RAISE EXCEPTION 'Fictional late link failure'; END IF; RETURN NEW; END$$`);
    await owner.db.execute(sql`CREATE TRIGGER b16_testing_refuse_link BEFORE UPDATE ON public.test_execution FOR EACH ROW EXECUTE FUNCTION public.b16_testing_refuse_link()`);
    try { await expect(raiseTestingExecutionFeedback(one, { executionId: f.execution.executionId, expectedRevision: 1, kind: 'defect' })).rejects.toThrow(); }
    finally { await owner.db.execute(sql`DROP TRIGGER b16_testing_refuse_link ON public.test_execution`); await owner.db.execute(sql`DROP FUNCTION public.b16_testing_refuse_link()`); }
    expect(await owner.db.select().from(s.feedbackRequest).where(eq(s.feedbackRequest.reporterUserId, one.userId!))).toEqual([]);
    expect(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId, b.tenantId), eq(s.domainEvent.eventType, 'feedback.submitted')))).toEqual([]);
    expect((await getTestingExecution(one, f.execution.executionId)).execution.defectFeedbackId).toBeNull();
  });
  it('binds a screenshot to its exact own observation and denies another tester download or arbitrary files', async () => {
    const f = await setup(), saved = await saveTestingExecution(one, observation(f));
    const file = { executionId: f.execution.executionId, runId: saved.runId, fileName: 'fictional.png', mimeType: 'image/png', content: Buffer.from([137,80,78,71,13,10,26,10,0]) };
    const image = await addTestingScreenshot(one, file);
    expect((await getTestingScreenshot(one, image.id))?.runId).toBe(saved.runId);
    expect(await getTestingScreenshot(two, image.id)).toBeNull();
    await expect(addTestingScreenshot(two, file)).rejects.toMatchObject({ code: 'not_found' });
    await expect(addTestingScreenshot(one, { ...file, content: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(addTestingScreenshot(one, { ...file, fileName: '../evidence.png' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
