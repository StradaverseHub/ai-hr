/** Real restricted-role/owner regressions. Source prepared; run only in the coordinated DB window. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { setFeedbackPlan, approveFeedbackPlan, startFeedbackBuild, completeFeedbackBuild } from '../core/feedback';
import { hireEmployee } from '../core/org';
import { ModuleNotEnabledError } from '../core/entitlements';
import { listTestingLibrary, getTestingLibraryCase, getTestingInstructionVersion, listTestingTesterOptions, requestTestingRetest, createTestCase, updateTestCase, recordTestRun, addTestingScreenshot, assignTestingCase, beginTestingExecution, getTestingExecution, getTestingScreenshot, listTestingAssignments, publishTestInstruction, raiseTestingExecutionFeedback, saveTestInstructionDraft, saveTestingExecution } from '../core/system-testing';
import { TestingRefusal, type InstructionDefinition } from '../lib/system-testing/model';
import { pgSqlState } from '../lib/db-error';
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
    const ownDetail = await getTestingExecution(one, f.execution.executionId);
    expect(ownDetail.testCase).toEqual({ id: f.draft.caseId, caseNo: f.draft.caseNo });
    expect(ownDetail.version.definition).toMatchObject({ moduleCode: 'employees', functionKey: 'personnel.profile' });
    expect(ownDetail.testerName).toBe('Fictional Tester One');
    expect(ownDetail.history).toHaveLength(1);
    expect(ownDetail.history[0]).toMatchObject({ runByUserId: one.userId, runByName: 'Fictional Tester One' });
    expect(ownDetail.updatedAt).toEqual(ownDetail.currentObservation?.runAt);
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
  it('refuses legacy writer shapes and raw bypasses without changing published instructions or inventing versionless observations', async () => {
    const f = await setup();
    const [before] = await owner.db.select().from(s.testCase).where(eq(s.testCase.id,f.draft.caseId));
    await expect(createTestCase(admin,{ moduleCode: 'employees',title: 'Old shape' })).rejects.toMatchObject({ code: 'versioned_authoring_required' });
    await expect(updateTestCase(admin,{ caseId: f.draft.caseId,moduleCode: 'employees',title: 'Silent edit',steps: ['Changed silently'] })).rejects.toMatchObject({ code: 'versioned_authoring_required' });
    await expect(recordTestRun(admin,{ caseId: f.draft.caseId,outcome: 'pass' })).rejects.toMatchObject({ code: 'assigned_execution_required' });
    for (const write of [
      (tx: import('../db/client').Tx) => tx.update(s.testCase).set({ title: 'Raw silent edit' }).where(eq(s.testCase.id,f.draft.caseId)),
      (tx: import('../db/client').Tx) => tx.insert(s.testRun).values({ tenantId: b.tenantId,testCaseId: f.draft.caseId,runNo: 1,outcome: 'pass',runByUserId: admin.userId }),
      (tx: import('../db/client').Tx) => tx.insert(s.testRun).values({ tenantId: b.tenantId,testCaseId: f.draft.caseId,runNo: 1,outcome: 'pass',runByUserId: admin.userId,versionId: f.version.versionId }),
    ]) {
      try { await withTenant(admin,async tx => { await write(tx); }); throw new Error('Legacy raw write unexpectedly succeeded.'); } catch (error) { expect(pgSqlState(error)).toBe('23514'); }
    }
    expect(await owner.db.select().from(s.testCase).where(eq(s.testCase.id,f.draft.caseId))).toEqual([before]);
    expect(await owner.db.select().from(s.testRun).where(eq(s.testRun.testCaseId,f.draft.caseId))).toEqual([]);
    await saveTestingExecution(one,observation(f));
    const [recorded] = await owner.db.select().from(s.testRun).where(eq(s.testRun.testCaseId,f.draft.caseId));
    expect(recorded).toMatchObject({ executionId: f.execution.executionId,versionId: f.version.versionId,runByUserId: one.userId,outcome: 'pass' });
  });
  it('retained case/run ACLs refuse TRUNCATE/DELETE/TRIGGER even where ordinary tenant RLS cannot protect them', async () => {
    const f = await setup(); await saveTestingExecution(one, observation(f));
    const rows = await withTenant(admin, tx => tx.execute(sql`SELECT name,has_table_privilege(current_user,name,'SELECT') AS read,has_table_privilege(current_user,name,'INSERT') AS append,has_table_privilege(current_user,name,'UPDATE') AS update,has_table_privilege(current_user,name,'DELETE') AS delete,has_table_privilege(current_user,name,'TRUNCATE') AS truncate,has_table_privilege(current_user,name,'TRIGGER') AS trigger,has_table_privilege(current_user,name,'REFERENCES') AS references FROM unnest(ARRAY['public.test_case','public.test_run']) name ORDER BY name`)) as unknown as { name: string; read: boolean; append: boolean; update: boolean; delete: boolean; truncate: boolean; trigger: boolean; references: boolean }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ read: true, append: true, update: true, delete: false, truncate: false, trigger: false, references: false });
    for (const statement of [sql`TRUNCATE public.test_case CASCADE`, sql`TRUNCATE public.test_run CASCADE`, sql`DELETE FROM public.test_run WHERE execution_id=${f.execution.executionId}::uuid`]) {
      try { await withTenant(admin, tx => tx.execute(statement)); throw new Error('Restricted ordinary destructive privilege unexpectedly succeeded.'); }
      catch (error) { expect(pgSqlState(error)).toBe('42501'); }
    }
    expect((await getTestingExecution(one, f.execution.executionId)).history).toHaveLength(1);
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
  it('refuses an older attempt after a new one starts, while preserving its pass and bounded historical pages', async () => {
    const f=await setup();const oldSave=await saveTestingExecution(one,observation(f));
    const next=await beginTestingExecution(one,{assignmentId:f.a.assignmentId,expectedVersionId:f.version.versionId,newAttempt:true});
    await expect(saveTestingExecution(one,{...observation(f),expectedRevision:1})).rejects.toMatchObject({code:'stale_execution'});
    try { await withTenant(one,tx=>tx.insert(s.testRun).values({tenantId:b.tenantId,testCaseId:f.draft.caseId,runNo:2,outcome:'pass',runByUserId:one.userId,versionId:f.version.versionId,executionId:f.execution.executionId,executionRevision:2,executionStatus:'passed'}));throw new Error('Old-attempt raw observation unexpectedly succeeded.'); } catch(error) {expect(pgSqlState(error)).toBe('40001');}
    const old=await getTestingExecution(one,f.execution.executionId,{beforeRevision:1});expect(old.history).toEqual([]);expect(old.currentObservation?.id).toBe(oldSave.runId);expect(old.canSave).toBe(false);expect(old.assignmentState).toMatchObject({execution_id:next.executionId,status:'not_started'});
    await saveTestingExecution(one,{...observation(f),executionId:next.executionId});
    expect((await listTestingAssignments(one)).rows[0].status).toBe('passed');
    expect((await getTestingExecution(one,f.execution.executionId)).history).toHaveLength(1);
  });
  it('requests retest after a real linked defect is fixed without treating an earlier same-version pass as a new observation', async () => {
    const f = await setup(); await saveTestingExecution(one,observation(f,'failed'));
    const linked = await raiseTestingExecutionFeedback(one,{ executionId: f.execution.executionId,expectedRevision: 1,kind: 'defect' });
    const request = { assignmentId: f.a.assignmentId,expectedRevision: 0,expectedVersionId: f.version.versionId,feedbackId: linked.feedbackId };
    await expect(requestTestingRetest(admin,request)).rejects.toMatchObject({ code: 'review_required' });
    await saveTestingExecution(one,{ ...observation(f),expectedRevision: 1 });
    expect((await listTestingAssignments(one)).rows[0].status).toBe('passed');
    await setFeedbackPlan(admin,{ feedbackId: linked.feedbackId,plan: 'Fictional reviewed repair.' });
    await approveFeedbackPlan(one,{ feedbackId: linked.feedbackId });
    await startFeedbackBuild(admin,{ feedbackId: linked.feedbackId,buildRef: 'fictional-build' });
    await completeFeedbackBuild(admin,{ feedbackId: linked.feedbackId,buildRef: 'fictional-build' });
    await requestTestingRetest(admin,request);
    expect((await listTestingAssignments(one)).rows[0].status).toBe('retest_required');
    const old = await getTestingExecution(one,f.execution.executionId); expect(old.history.find(r => r.executionRevision===2)?.executionStatus).toBe('passed');
    await expect(requestTestingRetest(one,{ ...request,expectedRevision: 1 })).rejects.toMatchObject({ code: 'not_assigned' });
    await saveTestingExecution(one,{ ...observation(f),expectedRevision: 2,status: 'in_progress' });
    expect((await listTestingAssignments(one)).rows[0].status).toBe('in_progress');
    await saveTestingExecution(one,{ ...observation(f),expectedRevision: 3 });
    expect((await listTestingAssignments(one)).rows[0].status).toBe('passed');
    expect((await getTestingExecution(one,f.execution.executionId)).history).toHaveLength(4);
  });
  it('keeps admin library filters/read-only team inspection separate from own assignments and bounded tester options', async () => {
    const f = await setup();
    expect((await listTestingLibrary(admin,{ search: 'save/reopen',moduleCode: 'employees',area: 'personnel',category: 'functional',priority: 'high',active: 'active',versionOrdinal: 1 })).rows.map(r => r.id)).toEqual([f.draft.caseId]);
    expect((await listTestingLibrary(admin,{ area: 'leave' })).total).toBe(0);
    const filtered=await listTestingAssignments(admin,{team:true,testerUserId:one.userId!,functionKey:guide.functionKey,category:guide.category,priority:guide.priority});expect(filtered.total).toBe(1);expect(filtered.summary).toEqual([{status:'not_started',n:1}]);expect(filtered.rows[0].updatedAt).toBeInstanceOf(Date);
    expect((await listTestingAssignments(admin,{team:true,functionKey:'different.function'})).total).toBe(0);
    expect((await getTestingLibraryCase(admin,f.draft.caseId)).versions.map(v => v.id)).toEqual([f.version.versionId]);
    expect((await listTestingTesterOptions(admin)).rows.map(r => r.userId)).toContain(one.userId);
    for (const call of [() => listTestingLibrary(one),() => getTestingLibraryCase(one,f.draft.caseId),() => listTestingTesterOptions(one)]) await expect(call()).rejects.toMatchObject({ code: 'not_assigned' });
    const saved = await saveTestingExecution(one, observation(f, 'in_progress'));
    const team = await getTestingExecution(admin,f.execution.executionId,{ team: true }); expect(team.canSave).toBe(false);
    expect(team.currentObservation?.id).toBe(saved.runId);
    expect(team.testerName).toBe('Fictional Tester One');
    expect(team.history.map(run=>run.runByUserId)).toEqual([one.userId]);
    const library = await getTestingLibraryCase(admin, f.draft.caseId);
    expect(library.currentVersion?.publishedByUserId).toBe(admin.userId);
    expect(library.versions.find(version=>version.id===f.version.versionId)?.publishedByUserId).toBe(admin.userId);
  });
  it('reads immutable assigned instruction versions without exposing another unassigned master case',async()=>{
    const f=await setup();expect((await getTestingInstructionVersion(one,{caseId:f.draft.caseId,versionId:f.version.versionId})).definition).toEqual(guide);
    const otherDraft=await saveTestInstructionDraft(admin,{caseId:null,expectedRevision:0,definition:{...guide,title:'Fictional unassigned guide'}});
    const otherVersion=await publishTestInstruction(admin,{caseId:otherDraft.caseId,expectedDraftRevision:otherDraft.revision,expectedVersionId:null});
    await expect(getTestingInstructionVersion(one,{caseId:otherDraft.caseId,versionId:otherVersion.versionId})).rejects.toMatchObject({code:'not_found'});
    await expect(getTestingInstructionVersion(one,{caseId:f.draft.caseId,versionId:otherVersion.versionId})).rejects.toMatchObject({code:'not_found'});
  });
  it('pages all case assignments without showing an already-assigned account as a new create option',async()=>{
    const f=await setup();const extra=await owner.db.insert(s.appUser).values(Array.from({length:51},(_,i)=>({tenantId:b.tenantId,workosUserId:`fictional-paged-tester-${i}`,personId:null}))).returning({id:s.appUser.id});
    for(const user of extra)await assignTestingCase(admin,{caseId:f.draft.caseId,testerUserId:user.id,expectedVersionId:f.version.versionId,active:true,expectedRevision:null});
    const first=await getTestingLibraryCase(admin,f.draft.caseId),second=await getTestingLibraryCase(admin,f.draft.caseId,{assignmentPage:2});
    expect(first.assignmentTotal).toBe(53);expect(first.assignments).toHaveLength(50);expect(second.assignments).toHaveLength(3);expect(new Set([...first.assignments,...second.assignments].map(a=>a.id)).size).toBe(53);
    const a=await listTestingTesterOptions(admin,{forCaseId:f.draft.caseId}),z=await listTestingTesterOptions(admin,{forCaseId:f.draft.caseId,page:2});
    expect([...a.rows,...z.rows].find(u=>u.userId===one.userId)?.assignmentId).toBe(f.a.assignmentId);
  });
  it('gates assigned testers and admins on a fresh canonical module snapshot without deleting stored history', async () => {
    const f = await setup(); await saveTestingExecution(one, observation(f));
    await setModule(b.tenantId, 'system_testing', 'disabled');
    const fresh = { ...await entitledCtx(b, ['employee']), userId: one.userId, personId: one.personId };
    const denied = [
      () => listTestingLibrary(fresh), () => getTestingLibraryCase(fresh,f.draft.caseId), () => getTestingInstructionVersion(fresh,{caseId:f.draft.caseId,versionId:f.version.versionId}), () => listTestingTesterOptions(fresh),
      () => requestTestingRetest(fresh,{ assignmentId: f.a.assignmentId,expectedRevision: 0,expectedVersionId: f.version.versionId,feedbackId: f.execution.executionId }),
      () => listTestingAssignments(fresh), () => getTestingExecution(fresh, f.execution.executionId),
      () => beginTestingExecution(fresh, { assignmentId: f.a.assignmentId, expectedVersionId: f.version.versionId, newAttempt: false }),
      () => saveTestingExecution(fresh, { ...observation(f), expectedRevision: 1 }),
      () => getTestingScreenshot(fresh, f.execution.executionId),
      () => addTestingScreenshot(fresh, { executionId: f.execution.executionId, runId: f.execution.executionId, fileName: 'invalid.png', mimeType: 'image/png', content: Buffer.from([1]) }),
      () => raiseTestingExecutionFeedback(fresh, { executionId: f.execution.executionId, expectedRevision: 1, kind: 'improvement' }),
      () => saveTestInstructionDraft(fresh, { caseId: null, expectedRevision: 0, definition: guide }),
      () => publishTestInstruction(fresh, { caseId: f.draft.caseId, expectedDraftRevision: 0, expectedVersionId: f.version.versionId }),
      () => assignTestingCase(fresh, { caseId: f.draft.caseId, testerUserId: two.userId!, expectedVersionId: f.version.versionId, active: true, expectedRevision: null }),
    ];
    for (const call of denied) await expect(call()).rejects.toBeInstanceOf(ModuleNotEnabledError);
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
