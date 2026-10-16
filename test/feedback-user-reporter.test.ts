/** Source-only prepared regressions: real user-only reporter, canonical Feedback, restricted app role. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { addFeedbackAttachment, answerBlockingQuestion, approveFeedbackPlan, blockFeedback, cancelFeedback, getFeedback, getFeedbackAttachment, listFeedback, setFeedbackPlan, submitFeedback } from '../core/feedback';
import { assignTestingCase, beginTestingExecution, publishTestInstruction, raiseTestingExecutionFeedback, saveTestInstructionDraft, saveTestingExecution } from '../core/system-testing';
import { hireEmployee, terminateEmployment } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { pgErrorChain, pgSqlState } from '../lib/db-error';
import type { InstructionDefinition } from '../lib/system-testing/model';
import { markBlockedSql, markUnblockedSql } from '../scripts/improve/remote';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let b: Base, group: SessionContext, one: SessionContext, other: SessionContext, scoped: SessionContext;
beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'system_testing', 'active');
  group = { ...await entitledCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
  async function login(label: string, role: 'employee' | 'hr_admin', companyId: string | null) {
    const [user] = await owner.db.insert(s.appUser).values({ tenantId: b.tenantId, workosUserId: 'fictional-user-only-' + label, personId: null }).returning({ id: s.appUser.id });
    await owner.db.insert(s.roleAssignment).values({ tenantId: b.tenantId, appUserId: user.id, role, companyId });
    return { ...await entitledCtx(b, [role]), userId: user.id, personId: null, grants: [{ role, companyId }] };
  }
  one = await login('one', 'employee', null); other = await login('other', 'employee', null); scoped = await login('scoped', 'hr_admin', b.companyId);
});
async function runScript(text: string): Promise<unknown> {
  const connection = await owner.client.reserve();
  try { return await connection.unsafe(text).simple(); } finally { connection.release(); }
}
const input = { category: 'issue' as const, title: 'Fictional account-only defect', description: 'Fictional reproduction without an employment subject.' };
const guide: InstructionDefinition = { format: 1, title: 'Fictional self navigation', objective: 'Read an authorized fictional screen.', functionKey: 'ess.navigation', area: 'personnel', moduleCode: 'ess', category: 'functional', priority: 'medium', active: true, prerequisites: ['Use the assigned fictional account.'], testData: ['No employee record is needed.'], steps: [{ id: 'open', action: 'Open an authorized fictional screen.', expected: 'It is usable under existing business authority.' }], expectedBehavior: 'The authorized screen is usable.', expectedFunction: 'Ordinary account navigation.', permissions: ['Existing screen access; assignment adds no grant.'], jurisdiction: null, configuration: null, screenKeys: ['dashboard'] };
describe('canonical Feedback user-only reporter graph', () => {
  it('keeps real account reports visible without an employment, scopes cross-user/scoped-admin reads, and permits explicit group administration', async () => {
    const report = await submitFeedback(one, input);
    const own = await getFeedback(one, report.id); expect(own).toMatchObject({ reporterEmploymentId: null, reporterUserId: one.userId });
    expect((await listFeedback(one)).map(r => r.id)).toEqual([report.id]);
    expect(await getFeedback(other, report.id)).toBeNull(); expect(await getFeedback(scoped, report.id)).toBeNull();
    expect(await listFeedback(other)).toEqual([]); expect(await listFeedback(scoped)).toEqual([]);
    expect((await getFeedback(group, report.id))?.id).toBe(report.id);
    const [authority] = await withTenant(scoped, tx => tx.execute(sql`SELECT app.is_group_admin() AS allowed,current_user`)) as unknown as { allowed: boolean; current_user: string }[];
    expect(authority).toEqual({ allowed: false, current_user: 'ai_hr_app' });
    const foreign = await seedBase(); expect(await getFeedback(await entitledCtx(foreign), report.id)).toBeNull();
    await expect(withTenant(group, tx => tx.insert(s.feedbackRequest).values({ tenantId: b.tenantId, reporterEmploymentId: null, reporterUserId: other.userId, ...input }))).rejects.toThrow();
    await expect(withTenant(one, tx => tx.update(s.feedbackRequest).set({ reporterUserId: other.userId }).where(eq(s.feedbackRequest.id, report.id)))).rejects.toThrow();
    const scopedAudit = await withTenant(scoped, tx => tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId, report.id)));
    expect(scopedAudit).toEqual([]);
    const groupAudit = await withTenant(group, tx => tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId, report.id)).orderBy(asc(s.domainEvent.sequence)));
    expect(groupAudit).toHaveLength(1);
    // The ordinary employee gains canonical Feedback history, not a new general raw-audit permission.
    const ownAudit = await withTenant(one, tx => tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId, report.id))); expect(ownAudit).toEqual([]);
    const [ownPredicate] = await withTenant(one, tx => tx.execute(sql`SELECT app.feedback_event_readable(${report.id}::uuid) AS allowed`)) as unknown as { allowed: boolean }[]; expect(ownPredicate.allowed).toBe(true);
    const [recorded] = await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, report.id), eq(s.domainEvent.eventType, 'feedback.submitted'))).orderBy(asc(s.domainEvent.sequence));
    expect(recorded).toMatchObject({ actorType: 'user', actorId: one.userId, subjectEmploymentId: null });
  });
  it('does not change existing employment-backed or unrelated audit visibility while an admin reads their own account report', async () => {
    const hired = await hireEmployee(group, { person: { fullName: 'Fictional Legacy Reporter', primaryEmail: 'legacy@user-only.invalid' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
    const legacy = await submitFeedback(group, { ...input, reporterEmploymentId: hired.employmentId });
    const oldVisible = await withTenant(scoped, tx => tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId, legacy.id)).orderBy(asc(s.domainEvent.sequence)));
    expect(oldVisible).toHaveLength(1); expect(oldVisible[0].subjectEmploymentId).toBe(hired.employmentId);
    const nonFeedback = await withTenant(scoped, tx => tx.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, hired.employmentId),eq(s.domainEvent.eventType,'employment.hired'))).orderBy(asc(s.domainEvent.sequence)));
    expect(nonFeedback).toHaveLength(1);
    const own = await submitFeedback(scoped, input);
    const ownAudit = await withTenant(scoped, tx => tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId, own.id)).orderBy(asc(s.domainEvent.sequence)));
    expect(ownAudit).toHaveLength(1); expect(ownAudit[0]).toMatchObject({ actorId: scoped.userId,subjectEmploymentId:null });
  });
  it('keeps attachments, plan revisions and blocking answers attached to the real login owner', async () => {
    const report = await submitFeedback(one, input);
    const image = await addFeedbackAttachment(one, { feedbackId: report.id, fileName: 'fictional.txt', mimeType: 'text/plain', content: Buffer.from('Fictional evidence') });
    expect((await getFeedbackAttachment(one, image.id))?.content.toString()).toBe('Fictional evidence');
    expect(await getFeedbackAttachment(other, image.id)).toBeNull(); expect(await getFeedbackAttachment(scoped, image.id)).toBeNull();
    await expect(addFeedbackAttachment(other, { feedbackId: report.id, fileName: 'forged.txt', mimeType: 'text/plain', content: Buffer.from('forged') })).rejects.toThrow();
    await setFeedbackPlan(group, { feedbackId: report.id, plan: 'Fictional reviewed plan.' });
    expect((await getFeedback(one, report.id))?.planHistory).toHaveLength(1);
    await expect(approveFeedbackPlan(scoped, { feedbackId: report.id })).rejects.toThrow();
    await approveFeedbackPlan(one, { feedbackId: report.id });
    await blockFeedback(group, { feedbackId: report.id, reason: 'Which fictional screen should be used?' });
    await expect(answerBlockingQuestion(other, { feedbackId: report.id, answer: 'Forged answer' })).rejects.toThrow();
    await answerBlockingQuestion(one, { feedbackId: report.id, answer: 'Use the isolated account screen.' });
    const after = await getFeedback(one, report.id); expect(after?.status).toBe('approved');
    expect(after?.blockHistory.find(e => e.answer === 'Use the isolated account screen.')?.answeredByUserId).toBe(one.userId);
    await cancelFeedback(one, { feedbackId: report.id }); expect((await getFeedback(one, report.id))?.status).toBe('cancelled');
  });
  it('refuses an archived real reporter even with a cached context and never manufactures an employee', async () => {
    const report = await submitFeedback(one, input);
    await owner.db.update(s.appUser).set({ archivedAt: new Date() }).where(eq(s.appUser.id, one.userId!));
    await expect(submitFeedback(one, input)).rejects.toThrow(); expect(await getFeedback(one, report.id)).toBeNull();
    expect((await getFeedback(group, report.id))?.reporterUserId).toBe(one.userId);
    expect(await owner.db.select().from(s.employment).where(eq(s.employment.tenantId, b.tenantId))).toEqual([]);
  });
  it('supports a live account on a future termination date without myEmployment selection', async () => {
    const hired = await hireEmployee(group, { person: { fullName: 'Fictional Future Leaver', primaryEmail: 'future@user-only.invalid' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
    const date = new Date(todayInKualaLumpur() + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + 1);
    await terminateEmployment(group, { employmentId: hired.employmentId, terminationDate: date.toISOString().slice(0,10), terminationType: 'voluntary' });
    await owner.db.update(s.appUser).set({ personId: hired.personId }).where(eq(s.appUser.id, one.userId!));
    const ctx = { ...one, personId: hired.personId };
    const [live] = await withTenant(ctx, tx => tx.execute(sql`SELECT NOT app.login_blocked(app.current_user_id()) AS allowed`)) as unknown as { allowed: boolean }[]; expect(live.allowed).toBe(true);
    const report = await submitFeedback(ctx, input); expect((await getFeedback(ctx, report.id))?.reporterEmploymentId).toBeNull();
  });
  it('raises and retries an assigned employment-less tester defect through the same canonical Feedback transaction', async () => {
    const draft = await saveTestInstructionDraft(group, { caseId: null, expectedRevision: 0, definition: guide });
    const version = await publishTestInstruction(group, { caseId: draft.caseId, expectedDraftRevision: draft.revision, expectedVersionId: null });
    const assignment = await assignTestingCase(group, { caseId: draft.caseId, testerUserId: one.userId!, expectedVersionId: version.versionId, active: true, expectedRevision: null });
    const execution = await beginTestingExecution(one, { assignmentId: assignment.assignmentId, expectedVersionId: version.versionId, newAttempt: false });
    await saveTestingExecution(one, { executionId: execution.executionId, assignmentId: assignment.assignmentId, versionId: version.versionId, expectedRevision: 0, status: 'failed', actualResult: 'Fictional unavailable screen.', comments: '', defectNotes: 'The fictional screen did not open.', improvementNotes: '' });
    const request = { executionId: execution.executionId, expectedRevision: 1, kind: 'defect' as const };
    const [a,z] = await Promise.all([raiseTestingExecutionFeedback(one, request), raiseTestingExecutionFeedback(one, request)]); expect(a.feedbackId).toBe(z.feedbackId);
    expect((await getFeedback(one, a.feedbackId))).toMatchObject({ reporterUserId: one.userId, reporterEmploymentId: null });
    expect(await owner.db.select().from(s.feedbackRequest).where(eq(s.feedbackRequest.reporterUserId, one.userId!))).toHaveLength(1);
  });
  it('allows the existing operator blocking/unblocking course to retain NULL employment and refuse a mismatched subject', async () => {
    const report = await submitFeedback(one, input); await setFeedbackPlan(group, { feedbackId: report.id, plan: 'Fictional reviewed plan.' }); await approveFeedbackPlan(one, { feedbackId: report.id });
    await runScript(markBlockedSql({ id: report.id, tenantId: b.tenantId, reporterEmploymentId: null, reason: 'Fictional question?' }));
    expect((await getFeedback(one, report.id))?.status).toBe('blocked');
    await runScript(markUnblockedSql({ id: report.id, tenantId: b.tenantId, reporterEmploymentId: null, note: 'Fictional answer.' }));
    expect((await getFeedback(one, report.id))?.status).toBe('approved');
    try { await runScript(markBlockedSql({ id: report.id, tenantId: b.tenantId, reporterEmploymentId: b.adminUserId, reason: 'Wrong subject' })); throw new Error('Mismatched reporter binding was accepted.'); } catch (error) { expect(pgErrorChain(error).some(e => e.message === 'Feedback reporter binding changed')).toBe(true); }
    const events = await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, report.id), eq(s.domainEvent.eventType,'feedback.blocked'))).orderBy(asc(s.domainEvent.sequence));
    expect(events).toHaveLength(1); expect(events[0].subjectEmploymentId).toBeNull();
  });
  it('does not inherit ordinary destructive privileges on any retained Feedback table', async () => {
    const report = await submitFeedback(one, input);
    for (const table of ['feedback_request','feedback_attachment','feedback_plan_revision','feedback_block']) {
      const [acl] = await withTenant(group, tx => tx.execute(sql`SELECT has_table_privilege(current_user,${'public.'+table},'TRUNCATE') AS truncate,has_table_privilege(current_user,${'public.'+table},'TRIGGER') AS trigger`)) as unknown as { truncate: boolean; trigger: boolean }[];
      expect(acl).toEqual({ truncate: false, trigger: false });
      try { await withTenant(group, tx => tx.execute(sql.raw('TRUNCATE public.'+table+' CASCADE'))); throw new Error('Ordinary destructive privilege unexpectedly succeeded.'); } catch (error) { expect(pgSqlState(error)).toBe('42501'); }
    }
    expect((await getFeedback(one, report.id))?.id).toBe(report.id);
  });
});
