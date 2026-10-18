/** Canonical extension of core/system-testing: immutable instructions, assignments and personal saves. */
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { appUser, feedbackRequest, testAssignment, testCase, testCaseVersion, testExecution, testExecutionAttachment, testRun } from '../db/schema';
import { testingActorNamesTx } from './system-testing-actors';
import { isAdmin } from '../lib/authz';
import { SCREENS } from '../lib/permissions';
import { executionInputSchema, legacyOutcomeFor, parseInstruction, parseInstructionDraft, parsePublishedInstruction, TestingRefusal, TESTING_LIMITS, testingUuid, testingHash, testingSourceRef, testingSemanticId, type ExecutionInput, type ExecutionStatus, type InstructionDefinition } from '../lib/system-testing/model';
import { testingDigest } from '../lib/system-testing/hash';
import { assertModuleEnabled } from './entitlements';
import { submitFeedback } from './feedback';
import { isTestableModule, listTestableModules, nextTestCaseNoTx, SYSTEM_TESTING_MODULE } from './system-testing';

function participant(ctx: SessionContext): string {
  assertModuleEnabled(ctx, SYSTEM_TESTING_MODULE);
  if (!ctx.userId) throw new TestingRefusal('not_found');
  return ctx.userId;
}
function administrator(ctx: SessionContext): string {
  const actor = participant(ctx);
  if (!isAdmin(ctx)) throw new TestingRefusal('not_assigned');
  return actor;
}
async function libraryLock(tx: Tx, ctx: SessionContext) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`testing-library:${ctx.tenantId}`},0))`);
}
async function caseLock(tx: Tx, ctx: SessionContext, caseId: string) {
  const [row] = await tx.select().from(testCase).where(and(eq(testCase.id, caseId), eq(testCase.tenantId, ctx.tenantId))).for('update');
  if (!row) throw new TestingRefusal('not_found');
  return row;
}
async function ownAssignmentLock(tx: Tx, ctx: SessionContext, assignmentId: string) {
  const [visible] = await tx.select().from(testAssignment).where(and(eq(testAssignment.id, assignmentId), eq(testAssignment.tenantId, ctx.tenantId), eq(testAssignment.testerUserId, participant(ctx))));
  if (!visible) throw new TestingRefusal('not_assigned');
  const c = await caseLock(tx, ctx, visible.testCaseId);
  const [a] = await tx.select().from(testAssignment).where(and(eq(testAssignment.id, assignmentId), eq(testAssignment.testerUserId, participant(ctx)))).for('update');
  if (!a || !a.active) throw new TestingRefusal('inactive');
  if (a.targetVersionId !== c.currentVersionId) throw new TestingRefusal('stale_instructions');
  const [version] = await tx.select({ definition: testCaseVersion.definition }).from(testCaseVersion).where(eq(testCaseVersion.id, a.targetVersionId));
  if (!version) throw new TestingRefusal('not_found');
  const definition = parsePublishedInstruction(version.definition);
  if (definition.format === 1 && !definition.active) throw new TestingRefusal('inactive');
  return { a, c };
}
export async function saveTestInstructionDraft(ctx: SessionContext, p: { caseId: string | null; expectedRevision: number; definition: unknown }): Promise<{ caseId: string; caseNo: number; revision: number }> {
  const actor = administrator(ctx), definition = parseInstructionDraft(p.definition);
  if (!Number.isInteger(p.expectedRevision) || p.expectedRevision < 0) throw new TestingRefusal('invalid');
  return withTenant(ctx, async tx => {
    await libraryLock(tx, ctx);
    if (!p.caseId) {
      if (p.expectedRevision !== 0) throw new TestingRefusal('stale_execution');
      const caseNo = await nextTestCaseNoTx(tx, ctx.tenantId);
      const [row] = await tx.insert(testCase).values({ tenantId: ctx.tenantId, caseNo, title: definition.title, moduleCode: definition.moduleCode, origin: 'local', draftDefinition: definition, draftRevision: 1, createdByUserId: actor, updatedByUserId: actor }).returning({ id: testCase.id });
      await event(tx, ctx, row.id, 'test_case.draft_created', { caseNo, draftRevision: 1 });
      return { caseId: row.id, caseNo, revision: 1 };
    }
    testingUuid.parse(p.caseId);
    const c = await caseLock(tx, ctx, p.caseId);
    if (c.draftRevision !== p.expectedRevision) throw new TestingRefusal('stale_execution');
    await tx.update(testCase).set({ draftDefinition: definition, draftRevision: c.draftRevision + 1, updatedByUserId: actor, updatedAt: new Date() }).where(eq(testCase.id, c.id));
    await event(tx, ctx, c.id, 'test_case.draft_saved', { draftRevision: c.draftRevision + 1 });
    return { caseId: c.id, caseNo: c.caseNo, revision: c.draftRevision + 1 };
  });
}
async function event(tx: Tx, ctx: SessionContext, caseId: string, type: string, payload: Record<string, unknown>) {
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'test_case', aggregateId: caseId, eventType: type, actor: actorOf(ctx), payload });
}
/** Shared publication owner used by manual publication and exact-hash catalogue confirmation. */
export async function publishTestInstructionTx(tx: Tx, ctx: SessionContext, p: {
  caseId: string; expectedVersionId: string | null; expectedDraftRevision: number; definition: InstructionDefinition;
  provenance: { kind: 'local' } | { kind: 'catalogue'; semanticId: string; sourceRef: string; catalogueHash: string; sourceContentHash: string; guideSourceHash: string };
}): Promise<{ caseId: string; versionId: string; ordinal: number; draftRevision: number }> {
  const actor = administrator(ctx), definition = parseInstruction(p.definition);
  if (!isTestableModule(ctx, definition.moduleCode) || definition.screenKeys.some(key => !SCREENS.some(screen => screen.screenKey === key))) throw new TestingRefusal('invalid');
  if (p.provenance.kind === 'catalogue') { testingSemanticId.parse(p.provenance.semanticId); testingSourceRef.parse(p.provenance.sourceRef); testingHash.parse(p.provenance.catalogueHash); testingHash.parse(p.provenance.sourceContentHash); testingHash.parse(p.provenance.guideSourceHash); }
  const c = await caseLock(tx, ctx, p.caseId);
  if (c.currentVersionId !== p.expectedVersionId || c.draftRevision !== p.expectedDraftRevision) throw new TestingRefusal('stale_instructions');
  const [count] = await tx.select({ ordinal: sql<number>`coalesce(max(${testCaseVersion.ordinal}),0)` }).from(testCaseVersion).where(eq(testCaseVersion.testCaseId, c.id));
  const ordinal = Number(count.ordinal) + 1, contentHash = testingDigest(definition);
  const [v] = await tx.insert(testCaseVersion).values({ tenantId: ctx.tenantId, testCaseId: c.id, ordinal, definition, contentHash, provenance: p.provenance.kind, publishedByUserId: actor,
    ...(p.provenance.kind === 'catalogue' ? { sourceRef: p.provenance.sourceRef, catalogueHash: p.provenance.catalogueHash, sourceContentHash: p.provenance.sourceContentHash, guideSourceHash: p.provenance.guideSourceHash } : {}) }).returning({ id: testCaseVersion.id });
  await tx.update(testCase).set({ currentVersionId: v.id, origin: p.provenance.kind, title: definition.title, moduleCode: definition.moduleCode, precondition: definition.prerequisites.join('\n'), steps: definition.steps.map(s => s.action), testType: definition.category, priority: definition.priority, expectedBehavior: definition.expectedBehavior, expectedFunction: definition.expectedFunction, draftDefinition: null, draftRevision: c.draftRevision + 1, updatedByUserId: actor, updatedAt: new Date(), ...(p.provenance.kind === 'catalogue' ? { semanticId: p.provenance.semanticId, acceptedCatalogueDefinitionHash: contentHash } : {}) }).where(eq(testCase.id, c.id));
  // The case trigger moves assignment targets/retest markers atomically; old observations are unchanged.
  await event(tx, ctx, c.id, 'test_case.version_published', { versionId: v.id, ordinal, contentHash, provenance: p.provenance.kind });
  return { caseId: c.id, versionId: v.id, ordinal, draftRevision: c.draftRevision + 1 };
}
export async function publishTestInstruction(ctx: SessionContext, p: { caseId: string; expectedDraftRevision: number; expectedVersionId: string | null }): Promise<{ caseId: string; versionId: string; ordinal: number; draftRevision: number }> {
  administrator(ctx); testingUuid.parse(p.caseId);
  return withTenant(ctx, async tx => {
    await libraryLock(tx, ctx);
    const c = await caseLock(tx, ctx, p.caseId);
    if (c.draftRevision !== p.expectedDraftRevision || !c.draftDefinition) throw new TestingRefusal('stale_instructions');
    return publishTestInstructionTx(tx, ctx, { caseId: c.id, expectedVersionId: p.expectedVersionId, expectedDraftRevision: c.draftRevision, definition: parseInstruction(c.draftDefinition), provenance: { kind: 'local' } });
  });
}
export async function assignTestingCase(ctx: SessionContext, p: { caseId: string; testerUserId: string; expectedVersionId: string; active: boolean; expectedRevision: number | null }): Promise<{ assignmentId: string; revision: number }> {
  const actor = administrator(ctx); testingUuid.parse(p.caseId); testingUuid.parse(p.testerUserId); testingUuid.parse(p.expectedVersionId);
  return withTenant(ctx, async tx => {
    await libraryLock(tx, ctx);
    const c = await caseLock(tx, ctx, p.caseId);
    if (c.currentVersionId !== p.expectedVersionId) throw new TestingRefusal('stale_instructions');
    const [user] = await tx.select({ id: appUser.id }).from(appUser).where(and(eq(appUser.id, p.testerUserId), eq(appUser.tenantId, ctx.tenantId), sql`${appUser.archivedAt} is null AND NOT app.login_blocked(${appUser.id})`)).limit(1);
    if (!user && p.active) throw new TestingRefusal('not_found');
    const [a] = await tx.select().from(testAssignment).where(and(eq(testAssignment.testCaseId, c.id), eq(testAssignment.testerUserId, p.testerUserId))).for('update');
    if (!user && !a) throw new TestingRefusal('not_found');
    if (a ? a.revision !== p.expectedRevision : p.expectedRevision !== null) throw new TestingRefusal('stale_execution');
    if (a) {
      await tx.update(testAssignment).set({ active: p.active, revision: a.revision + 1, assignedByUserId: actor, updatedAt: new Date() }).where(eq(testAssignment.id, a.id));
      await event(tx, ctx, c.id, 'test_case.assignment_changed', { assignmentId: a.id, testerUserId: p.testerUserId, active: p.active, revision: a.revision + 1 });
      return { assignmentId: a.id, revision: a.revision + 1 };
    }
    const [row] = await tx.insert(testAssignment).values({ tenantId: ctx.tenantId, testCaseId: c.id, testerUserId: p.testerUserId, targetVersionId: p.expectedVersionId, active: p.active, assignedByUserId: actor }).returning({ id: testAssignment.id });
    await event(tx, ctx, c.id, 'test_case.assigned', { assignmentId: row.id, testerUserId: p.testerUserId });
    return { assignmentId: row.id, revision: 0 };
  });
}
export async function beginTestingExecution(ctx: SessionContext, p: { assignmentId: string; expectedVersionId: string; newAttempt: boolean }): Promise<{ executionId: string; revision: number; versionId: string }> {
  const actor = participant(ctx); testingUuid.parse(p.assignmentId); testingUuid.parse(p.expectedVersionId);
  return withTenant(ctx, async tx => {
    const { a } = await ownAssignmentLock(tx, ctx, p.assignmentId);
    if (a.targetVersionId !== p.expectedVersionId) throw new TestingRefusal('stale_instructions');
    const [existing] = await tx.select().from(testExecution).where(and(eq(testExecution.assignmentId, a.id), eq(testExecution.versionId, a.targetVersionId))).orderBy(desc(testExecution.attemptNo)).limit(1);
    if (existing && !p.newAttempt) return { executionId: existing.id, revision: existing.revision, versionId: existing.versionId };
    const [row] = await tx.insert(testExecution).values({ tenantId: ctx.tenantId, assignmentId: a.id, versionId: a.targetVersionId, testerUserId: actor, attemptNo: (existing?.attemptNo ?? 0) + 1 }).returning({ id: testExecution.id });
    await event(tx, ctx, a.testCaseId, 'test_execution.started', { assignmentId: a.id, executionId: row.id, versionId: a.targetVersionId, testerUserId: actor });
    return { executionId: row.id, revision: 0, versionId: a.targetVersionId };
  });
}
export async function saveTestingExecution(ctx: SessionContext, raw: ExecutionInput): Promise<{ runId: string; revision: number }> {
  const actor = participant(ctx), p = executionInputSchema.parse(raw);
  return withTenant(ctx, async tx => {
    const { a } = await ownAssignmentLock(tx, ctx, p.assignmentId);
    const [e] = await tx.select().from(testExecution).where(and(eq(testExecution.id, p.executionId), eq(testExecution.assignmentId, a.id), eq(testExecution.testerUserId, actor))).for('update');
    if (!e) throw new TestingRefusal('not_found');
    if (e.versionId !== p.versionId || a.targetVersionId !== p.versionId) throw new TestingRefusal('stale_instructions');
    if (e.revision !== p.expectedRevision) throw new TestingRefusal('stale_execution');
    const [later]=await tx.select({id:testExecution.id}).from(testExecution).where(and(eq(testExecution.assignmentId,a.id),eq(testExecution.versionId,e.versionId),sql`${testExecution.attemptNo}>${e.attemptNo}`)).limit(1);
    if(later)throw new TestingRefusal('stale_execution');
    // Shares the existing case run-number owner lock; the immutable run remains the one observation log.
    const [n] = await tx.execute(sql`select app.testing_next_run_no(${a.testCaseId}::uuid) AS next`) as unknown as { next: number }[];
    const [run] = await tx.insert(testRun).values({ tenantId: ctx.tenantId, testCaseId: a.testCaseId, runNo: Number(n.next), outcome: legacyOutcomeFor(p.status), actualResult: p.actualResult.trim() || null, runByUserId: actor, versionId: p.versionId, executionId: e.id, executionRevision: e.revision + 1, executionStatus: p.status, comments: p.comments.trim() || null, defectNotes: p.defectNotes.trim() || null, improvementNotes: p.improvementNotes.trim() || null }).returning({ id: testRun.id });
    await event(tx, ctx, a.testCaseId, 'test_execution.observation_saved', { executionId: e.id, runId: run.id, versionId: e.versionId, revision: e.revision + 1, status: p.status, testerUserId: actor });
    return { runId: run.id, revision: e.revision + 1 };
  });
}
type AssignmentReadFilter = { moduleCode?: string; functionKey?: string; category?: string; priority?: string };
function assignmentRowsSql(ctx: SessionContext,p: AssignmentReadFilter,tester: string|null) {
  return sql`WITH rows AS (SELECT a.id AS assignment_id,c.id AS case_id,c.case_no,v.definition->>'title' AS title,v.definition->>'moduleCode' AS module_code,v.id AS version_id,v.ordinal,v.definition,v.definition->>'functionKey' AS function_key,coalesce(v.definition->>'category',v.definition->>'testType') AS category,v.definition->>'priority' AS priority,a.tester_user_id,p.full_name AS tester_name,a.revision AS assignment_revision,a.active,e.id AS execution_id,e.revision AS execution_revision,
      CASE WHEN a.retest_required AND (r.run_no IS NULL OR r.run_no<=a.retest_after_run_no) THEN 'retest_required' ELSE coalesce(r.execution_status,'not_started') END AS status,CASE WHEN a.retest_required AND (r.run_no IS NULL OR r.run_no<=a.retest_after_run_no) THEN a.updated_at ELSE coalesce(r.run_at,e.created_at,a.created_at) END AS updated_at
      FROM test_assignment a JOIN test_case c ON c.id=a.test_case_id AND c.tenant_id=a.tenant_id JOIN test_case_version v ON v.id=a.target_version_id AND v.tenant_id=a.tenant_id
      LEFT JOIN public.app_user u ON u.id=a.tester_user_id AND u.tenant_id=a.tenant_id LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=a.tenant_id
      LEFT JOIN LATERAL(SELECT x.* FROM test_execution x WHERE x.assignment_id=a.id AND x.version_id=a.target_version_id ORDER BY x.attempt_no DESC LIMIT 1)e ON true
      LEFT JOIN test_run r ON r.id=e.current_run_id AND r.execution_id=e.id
      WHERE a.tenant_id=${ctx.tenantId} AND (${tester}::uuid IS NULL OR a.tester_user_id=${tester}::uuid) AND (${p.moduleCode ?? null}::text IS NULL OR v.definition->>'moduleCode'=${p.moduleCode ?? null}::text) AND (${p.functionKey??null}::text IS NULL OR v.definition->>'functionKey'=${p.functionKey??null}::text) AND (${p.category??null}::text IS NULL OR coalesce(v.definition->>'category',v.definition->>'testType')=${p.category??null}::text) AND (${p.priority??null}::text IS NULL OR v.definition->>'priority'=${p.priority??null}::text))`;
}
export type TestingAssignmentRow = { assignmentId: string; caseId: string; caseNo: number; title: string; moduleCode: string; versionId: string; ordinal: number; testerUserId: string; testerName: string | null; updatedAt: Date; functionKey: string | null; category: string | null; priority: string | null; assignmentRevision: number; active: boolean; executionId: string | null; executionRevision: number | null; status: ExecutionStatus; definition: ReturnType<typeof parsePublishedInstruction> };
export async function listTestingAssignments(ctx: SessionContext, p: { team?: boolean; testerUserId?: string; moduleCode?: string; functionKey?: string; category?: string; priority?: string; status?: ExecutionStatus; page?: number } = {}): Promise<{ rows: TestingAssignmentRow[]; total: number; page: number; summary: {status:ExecutionStatus;n:number}[] }> {
  const actor = participant(ctx);
  if (p.team) administrator(ctx);
  if (!p.team && p.testerUserId && p.testerUserId !== actor) throw new TestingRefusal('not_assigned');
  const page = p.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 20000 || (p.functionKey?.length??0)>160 || (p.category?.length??0)>100 || (p.priority?.length??0)>100) throw new TestingRefusal('invalid');
  const tester = p.team ? p.testerUserId ?? null : actor;
  if (tester) testingUuid.parse(tester);
  return withTenant(ctx, async tx => {
    const base = assignmentRowsSql(ctx,p,tester);
    const filter = sql`WHERE (${p.status ?? null}::text IS NULL OR status=${p.status ?? null}::text)`;
    const summary = await tx.execute(sql`${base} SELECT status,count(*)::integer AS n FROM rows GROUP BY status ORDER BY status`) as unknown as { status: ExecutionStatus; n: number }[];
    const counted = await tx.execute(sql`${base} SELECT count(*)::integer AS total FROM rows ${filter}`) as unknown as { total: number }[];
    const found = await tx.execute(sql`${base} SELECT * FROM rows ${filter} ORDER BY case_no,tester_user_id,assignment_id LIMIT ${TESTING_LIMITS.pageSize} OFFSET ${(page - 1) * TESTING_LIMITS.pageSize}`) as unknown as { assignment_id: string; case_id: string; case_no: number; title: string; module_code: string; version_id: string; ordinal: number; definition: unknown; tester_user_id: string; tester_name: string | null; updated_at: Date|string; function_key: string|null; category: string|null; priority: string|null; assignment_revision: number; active: boolean; execution_id: string | null; execution_revision: number | null; status: ExecutionStatus }[];
    return { total: Number(counted[0].total), page, summary, rows: found.map(r => ({ assignmentId: r.assignment_id, caseId: r.case_id, caseNo: r.case_no, title: r.title, moduleCode: r.module_code, versionId: r.version_id, ordinal: r.ordinal, definition: parsePublishedInstruction(r.definition), testerUserId: r.tester_user_id, testerName: r.tester_name, updatedAt: new Date(r.updated_at), functionKey: r.function_key, category: r.category, priority: r.priority, assignmentRevision: r.assignment_revision, active: r.active, executionId: r.execution_id, executionRevision: r.execution_revision, status: r.status })) };
  }, { readOnlySnapshot: true });
}
export async function getTestingExecution(ctx: SessionContext, executionId: string, options: { team?: boolean; beforeRevision?: number } = {}) {
  const actor = participant(ctx); testingUuid.parse(executionId);
  if (options.team) administrator(ctx);
  if(options.beforeRevision!==undefined&&(!Number.isInteger(options.beforeRevision)||options.beforeRevision<1))throw new TestingRefusal('invalid');
  return withTenant(ctx, async tx => {
    const [e] = await tx.select().from(testExecution).where(and(eq(testExecution.id, executionId), options.team ? undefined : eq(testExecution.testerUserId, actor)));
    if (!e) throw new TestingRefusal('not_found');
    const [a] = await tx.select().from(testAssignment).where(eq(testAssignment.id, e.assignmentId));
    const [v] = await tx.select().from(testCaseVersion).where(eq(testCaseVersion.id, e.versionId));
    if (!a || !v) throw new TestingRefusal('not_found');
    const [caseIdentity] = await tx.select({ id: testCase.id, caseNo: testCase.caseNo }).from(testCase).where(and(eq(testCase.id, a.testCaseId), eq(testCase.tenantId, ctx.tenantId))).limit(1);
    if (!caseIdentity) throw new TestingRefusal('not_found');
    const history = await tx.select().from(testRun).where(and(eq(testRun.executionId, e.id),options.beforeRevision===undefined?undefined:sql`${testRun.executionRevision}<${options.beforeRevision}`)).orderBy(desc(testRun.executionRevision)).limit(201);
    const screenshots = await tx.select({ id: testExecutionAttachment.id, fileName: testExecutionAttachment.fileName, mimeType: testExecutionAttachment.mimeType, runId: testExecutionAttachment.runId }).from(testExecutionAttachment).where(eq(testExecutionAttachment.executionId, e.id)).orderBy(testExecutionAttachment.createdAt, testExecutionAttachment.id);
    const feedbackRows=await tx.select({id:feedbackRequest.id,status:feedbackRequest.status}).from(feedbackRequest).where(sql`${feedbackRequest.id} IN (${e.defectFeedbackId}::uuid,${e.improvementFeedbackId}::uuid)`);
    const feedbackStates={defect:feedbackRows.find(f=>f.id===e.defectFeedbackId)?.status??null,improvement:feedbackRows.find(f=>f.id===e.improvementFeedbackId)?.status??null};
    const [currentObservation]=e.currentRunId?await tx.select().from(testRun).where(and(eq(testRun.id,e.currentRunId),eq(testRun.executionId,e.id))):[];
    if(e.revision>0&&!currentObservation)throw new TestingRefusal('not_found');
    const [assignmentState]=await tx.execute(sql`${assignmentRowsSql(ctx,{},e.testerUserId)} SELECT status,execution_id FROM rows WHERE assignment_id=${a.id}::uuid`) as unknown as {status:ExecutionStatus;execution_id:string|null}[];
    if(!assignmentState)throw new TestingRefusal('not_found');
    const definition = parsePublishedInstruction(v.definition);
    const actorNames = await testingActorNamesTx(tx, ctx, [e.testerUserId, ...history.map(run => run.runByUserId)]);
    return { testCase: caseIdentity, moduleName: listTestableModules(ctx).find(module => module.code === definition.moduleCode)?.name ?? definition.moduleCode, testerName: actorNames.get(e.testerUserId) ?? null, updatedAt: currentObservation?.runAt ?? e.createdAt, currentObservation:currentObservation??null,assignmentState,nextHistoryBeforeRevision:history.length>200?Math.min(...history.slice(0,200).map(r=>r.executionRevision??0)):null,feedbackStates,execution: e, assignment: a, version: { ...v, definition }, history: history.slice(0, 200).map(run => ({ ...run, runByName: run.runByUserId ? actorNames.get(run.runByUserId) ?? null : null })), historyTruncated: history.length > 200, screenshots, canSave: e.testerUserId === actor && assignmentState.execution_id===e.id && a.active && a.targetVersionId === e.versionId && (definition.format === 0 || definition.active) };
  }, { readOnlySnapshot: true });
}
export async function raiseTestingExecutionFeedback(ctx: SessionContext, p: { executionId: string; expectedRevision: number; kind: 'defect' | 'improvement' }): Promise<{ feedbackId: string }> {
  const actor = participant(ctx); testingUuid.parse(p.executionId);
  if (p.kind !== 'defect' && p.kind !== 'improvement') throw new TestingRefusal('invalid');
  return withTenant(ctx, async tx => {
    const [e] = await tx.select().from(testExecution).where(and(eq(testExecution.id, p.executionId), eq(testExecution.testerUserId, actor))).for('update');
    if (!e) throw new TestingRefusal('not_found');
    const prior = p.kind === 'defect' ? e.defectFeedbackId : e.improvementFeedbackId;
    if (prior) return { feedbackId: prior };
    if (e.revision !== p.expectedRevision || !e.currentRunId) throw new TestingRefusal('stale_execution');
    const [r] = await tx.select().from(testRun).where(and(eq(testRun.id, e.currentRunId), eq(testRun.executionId, e.id)));
    const [v] = await tx.select().from(testCaseVersion).where(eq(testCaseVersion.id, e.versionId));
    const [a] = await tx.select().from(testAssignment).where(eq(testAssignment.id, e.assignmentId));
    if (!r || !v || !a) throw new TestingRefusal('not_found');
    const note = p.kind === 'defect' ? r.defectNotes : r.improvementNotes;
    if (!note?.trim() || p.kind === 'defect' && !['failed', 'blocked', 'partial'].includes(r.executionStatus ?? '')) throw new TestingRefusal('invalid');
    const guide = parsePublishedInstruction(v.definition);
    const description = [`Instruction version ${v.ordinal} (${v.id}); content ${v.contentHash}`, `Execution ${e.id}; observation ${r.id}; tester ${actor}`, note, `Observed: ${r.actualResult ?? ''}`, `Comments: ${r.comments ?? ''}`, 'Instructions:', ...(guide.format === 1 ? guide.steps.map((s, i) => `${i + 1}. ${s.action}\nExpected: ${s.expected}`) : guide.steps)].join('\n\n');
    const feedback = await submitFeedback(ctx, { reporterEmploymentId: null, category: p.kind === 'defect' ? 'issue' : 'enhancement', title: `${guide.title}: ${p.kind}`, description, expectedBehavior: guide.expectedBehavior, expectedFunction: guide.expectedFunction }, tx);
    await tx.update(testExecution).set(p.kind === 'defect' ? { defectFeedbackId: feedback.id } : { improvementFeedbackId: feedback.id }).where(eq(testExecution.id, e.id));
    await event(tx, ctx, a.testCaseId, 'test_execution.feedback_linked', { executionId: e.id, runId: r.id, versionId: v.id, feedbackId: feedback.id, kind: p.kind });
    return { feedbackId: feedback.id };
  });
}
function screenshotMime(content: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (content[0] === 255 && content[1] === 216 && content[2] === 255) return 'image/jpeg';
  if (content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export async function addTestingScreenshot(ctx: SessionContext, p: { executionId: string; runId: string; fileName: string; mimeType: string; content: Buffer }): Promise<{ id: string }> {
  const actor = participant(ctx); testingUuid.parse(p.executionId); testingUuid.parse(p.runId);
  if (!p.content.length || p.content.length > TESTING_LIMITS.screenshotBytes || screenshotMime(p.content) !== p.mimeType || !p.fileName || p.fileName.length > 240 || /[\r\n\0/\\]/.test(p.fileName)) throw new TestingRefusal('invalid');
  return withTenant(ctx, async tx => {
    const [e] = await tx.select().from(testExecution).where(and(eq(testExecution.id, p.executionId), eq(testExecution.testerUserId, actor))).for('update');
    if (!e) throw new TestingRefusal('not_found');
    const [r] = await tx.select({ id: testRun.id }).from(testRun).where(and(eq(testRun.id, p.runId), eq(testRun.executionId, e.id), eq(testRun.runByUserId, actor)));
    if (!r) throw new TestingRefusal('not_found');
    const [row] = await tx.insert(testExecutionAttachment).values({ tenantId: ctx.tenantId, executionId: e.id, runId: r.id, uploadedByUserId: actor, fileName: p.fileName, mimeType: p.mimeType, content: p.content }).returning({ id: testExecutionAttachment.id });
    await event(tx, ctx, (await tx.select().from(testAssignment).where(eq(testAssignment.id, e.assignmentId)))[0].testCaseId, 'test_execution.screenshot_attached', { executionId: e.id, runId: r.id, attachmentId: row.id });
    return row;
  });
}
export async function getTestingScreenshot(ctx: SessionContext, attachmentId: string) {
  participant(ctx); testingUuid.parse(attachmentId);
  return withTenant(ctx, async tx => { const [row] = await tx.select().from(testExecutionAttachment).where(eq(testExecutionAttachment.id, attachmentId)); return row ?? null; });
}

/** Shared immutable definition reader; assigned-case RLS applies without access to another tester's runs. */
export async function getTestingInstructionVersion(ctx:SessionContext,p:{caseId:string;versionId:string}) {
  participant(ctx);testingUuid.parse(p.caseId);testingUuid.parse(p.versionId);
  return withTenant(ctx,async tx=>{
    const [row]=await tx.select().from(testCaseVersion).where(and(eq(testCaseVersion.id,p.versionId),eq(testCaseVersion.testCaseId,p.caseId),sql`octet_length(${testCaseVersion.definition}::text)<=8388608`)).limit(1);
    if(!row)throw new TestingRefusal('not_found');
    const actorNames = await testingActorNamesTx(tx, ctx, [row.publishedByUserId]);
    return {...row, publishedByName: row.publishedByUserId ? actorNames.get(row.publishedByUserId) ?? null : null, definition:parsePublishedInstruction(row.definition)};
  },{readOnlySnapshot:true});
}
