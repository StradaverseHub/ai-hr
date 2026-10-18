/** Bounded administration readers and explicit retest requests for the same canonical case owner. */
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { appUser, feedbackRequest, person, testAssignment, testCase, testCaseVersion, testExecution, testRun } from '../db/schema';
import { testingActorNamesTx } from './system-testing-actors';
import { isAdmin } from '../lib/authz';
import { parseInstructionDraft, parsePublishedInstruction, TestingRefusal, TESTING_LIMITS, testingUuid, TESTING_AREAS, TESTING_CATEGORIES, TESTING_PRIORITIES } from '../lib/system-testing/model';
import { assertModuleEnabled } from './entitlements';
import { SYSTEM_TESTING_MODULE } from './system-testing';
function admin(ctx: SessionContext) {
  assertModuleEnabled(ctx,SYSTEM_TESTING_MODULE);
  if (!isAdmin(ctx) || !ctx.userId) throw new TestingRefusal('not_assigned');
  return ctx.userId;
}
export type TestingLibraryFilter = { search?: string; moduleCode?: string; functionKey?:string; area?: string; category?: string; priority?: string; active?: 'active'|'inactive'|'draft'; versionOrdinal?: number; page?: number };
export async function listTestingLibrary(ctx: SessionContext,p: TestingLibraryFilter = {}) {
  admin(ctx);
  const page = p.page ?? 1;
  if (!Number.isInteger(page) || page<1 || page>20000 || (p.search?.length ?? 0)>240 || (p.moduleCode?.length ?? 0)>160 || (p.functionKey?.length??0)>160 || p.area && !TESTING_AREAS.some(v => v===p.area) || p.category && !TESTING_CATEGORIES.some(v => v===p.category) || p.priority && !TESTING_PRIORITIES.some(v => v===p.priority) || p.active && !['active','inactive','draft'].includes(p.active) || p.versionOrdinal!==undefined && (!Number.isInteger(p.versionOrdinal) || p.versionOrdinal<1)) throw new TestingRefusal('invalid');
  return withTenant(ctx,async tx => {
    const where = and(eq(testCase.tenantId,ctx.tenantId),
      p.search ? sql`position(lower(${p.search}) IN lower(${testCase.title}))>0` : undefined,
      p.moduleCode ? eq(testCase.moduleCode,p.moduleCode) : undefined,
      p.functionKey?sql`${testCaseVersion.definition}->>'functionKey'=${p.functionKey}`:undefined,
      p.area ? sql`${testCaseVersion.definition}->>'area'=${p.area}` : undefined,
      p.category ? eq(testCase.testType,p.category) : undefined,
      p.priority ? eq(testCase.priority,p.priority) : undefined,
      p.active==='draft' ? sql`${testCase.draftDefinition} IS NOT NULL` : p.active ? sql`coalesce(${testCaseVersion.definition}->>'active','true')=${p.active==='active'?'true':'false'}` : undefined,
      p.versionOrdinal===undefined ? undefined : eq(testCaseVersion.ordinal,p.versionOrdinal));
    const join = eq(testCaseVersion.id,testCase.currentVersionId);
    const [count] = await tx.select({ total: sql<number>`count(*)::integer` }).from(testCase).leftJoin(testCaseVersion,join).where(where);
    const rows = await tx.select({ id: testCase.id,caseNo: testCase.caseNo,title: testCase.title,moduleCode: testCase.moduleCode,category: testCase.testType,priority: testCase.priority,origin: testCase.origin,versionId: testCase.currentVersionId,ordinal: testCaseVersion.ordinal,functionKey:sql<string|null>`${testCaseVersion.definition}->>'functionKey'`,area: sql<string|null>`${testCaseVersion.definition}->>'area'`,active: sql<boolean>`coalesce(${testCaseVersion.definition}->>'active','true')='true'`,hasDraft: sql<boolean>`${testCase.draftDefinition} IS NOT NULL`,draftRevision: testCase.draftRevision }).from(testCase).leftJoin(testCaseVersion,join).where(where).orderBy(testCase.caseNo,testCase.id).limit(TESTING_LIMITS.pageSize).offset((page-1)*TESTING_LIMITS.pageSize);
    return { rows,total: Number(count.total),page };
  },{ readOnlySnapshot: true });
}
export async function getTestingLibraryCase(ctx: SessionContext,caseId: string,p: {assignmentPage?:number;beforeVersionOrdinal?:number;beforeLegacyRunNo?:number}={}) {
  admin(ctx); testingUuid.parse(caseId);
  const assignmentPage=p.assignmentPage??1;
  if(!Number.isInteger(assignmentPage)||assignmentPage<1||assignmentPage>20000||[p.beforeVersionOrdinal,p.beforeLegacyRunNo].some(v=>v!==undefined&&(!Number.isInteger(v)||v<1)))throw new TestingRefusal('invalid');
  return withTenant(ctx,async tx => {
    const [row] = await tx.select({ c: testCase,v: testCaseVersion }).from(testCase).leftJoin(testCaseVersion,eq(testCaseVersion.id,testCase.currentVersionId)).where(and(eq(testCase.id,caseId),sql`octet_length(coalesce(${testCase.draftDefinition}::text,''))+octet_length(coalesce(${testCaseVersion.definition}::text,''))<=8388608`)).limit(1);
    if (!row) throw new TestingRefusal('not_found');
    const versions = await tx.select({ id: testCaseVersion.id,ordinal: testCaseVersion.ordinal,contentHash: testCaseVersion.contentHash,provenance: testCaseVersion.provenance,publishedAt: testCaseVersion.publishedAt,publishedByUserId: testCaseVersion.publishedByUserId }).from(testCaseVersion).where(and(eq(testCaseVersion.testCaseId,caseId),p.beforeVersionOrdinal===undefined?undefined:sql`${testCaseVersion.ordinal}<${p.beforeVersionOrdinal}`)).orderBy(desc(testCaseVersion.ordinal)).limit(201);
    const [assignmentCount]=await tx.select({n:sql<number>`count(*)::integer`}).from(testAssignment).where(eq(testAssignment.testCaseId,caseId));
    const assigned=await tx.select({assignment:testAssignment,name:person.fullName}).from(testAssignment).leftJoin(appUser,eq(appUser.id,testAssignment.testerUserId)).leftJoin(person,eq(person.id,appUser.personId)).where(eq(testAssignment.testCaseId,caseId)).orderBy(testAssignment.testerUserId,testAssignment.id).limit(TESTING_LIMITS.pageSize).offset((assignmentPage-1)*TESTING_LIMITS.pageSize);
    const assignments=assigned.map(row=>({...row.assignment,testerName:row.name}));
    const legacyHistory=await tx.select({ id:testRun.id,runNo:testRun.runNo,outcome:testRun.outcome,actualResult:testRun.actualResult,runAt:testRun.runAt,runByUserId:testRun.runByUserId,feedbackId:testRun.feedbackRequestId }).from(testRun).where(and(eq(testRun.testCaseId,caseId),sql`${testRun.executionId} IS NULL`,p.beforeLegacyRunNo===undefined?undefined:sql`${testRun.runNo}<${p.beforeLegacyRunNo}`)).orderBy(desc(testRun.runNo)).limit(201);
    const actorNames = await testingActorNamesTx(tx, ctx, [row.c.updatedByUserId, row.v?.publishedByUserId ?? null, ...versions.map(v => v.publishedByUserId), ...legacyHistory.map(run => run.runByUserId)]);
    return { updatedByName: row.c.updatedByUserId ? actorNames.get(row.c.updatedByUserId) ?? null : null, currentVersion: row.v ? { id: row.v.id, ordinal: row.v.ordinal, publishedAt: row.v.publishedAt, publishedByUserId: row.v.publishedByUserId, publishedByName: row.v.publishedByUserId ? actorNames.get(row.v.publishedByUserId) ?? null : null } : null, assignmentPage,assignmentTotal:Number(assignmentCount.n),nextVersionBeforeOrdinal:versions.length>200?Math.min(...versions.slice(0,200).map(v=>v.ordinal)):null,nextLegacyBeforeRunNo:legacyHistory.length>200?Math.min(...legacyHistory.slice(0,200).map(v=>v.runNo)):null,legacyHistory:legacyHistory.slice(0,200).map(run => ({ ...run, runByName: run.runByUserId ? actorNames.get(run.runByUserId) ?? null : null })),legacyHistoryTruncated:legacyHistory.length>200,testCase: row.c,definition: row.v ? parsePublishedInstruction(row.v.definition) : null,draft: row.c.draftDefinition ? parseInstructionDraft(row.c.draftDefinition) : null,versions: versions.slice(0,200).map(v => ({ ...v, publishedByName: v.publishedByUserId ? actorNames.get(v.publishedByUserId) ?? null : null })),versionsTruncated: versions.length>200,assignments,assignmentsTruncated:assignmentPage*TESTING_LIMITS.pageSize<Number(assignmentCount.n) };
  },{ readOnlySnapshot: true });
}
/** Existing app-user and Person RLS still decides which human names are available; no salary/contact
 * or external identity is fetched, and an unavailable name remains a login ID in the UI. */
export async function listTestingTesterOptions(ctx: SessionContext,p: { page?: number; forCaseId?:string } = {}) {
  admin(ctx); if(p.forCaseId)testingUuid.parse(p.forCaseId); const page=p.page??1; if (!Number.isInteger(page)||page<1||page>20000) throw new TestingRefusal('invalid');
  return withTenant(ctx,async tx => {
    const where = and(eq(appUser.tenantId,ctx.tenantId),sql`${appUser.archivedAt} IS NULL AND NOT app.login_blocked(${appUser.id})`);
    const [count] = await tx.select({ total: sql<number>`count(*)::integer` }).from(appUser).where(where);
    const rows = await tx.select({ userId: appUser.id,name: person.fullName,assignmentId:testAssignment.id }).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).leftJoin(testAssignment,and(eq(testAssignment.testerUserId,appUser.id),p.forCaseId?eq(testAssignment.testCaseId,p.forCaseId):sql`false`)).where(where).orderBy(appUser.id).limit(TESTING_LIMITS.pageSize).offset((page-1)*TESTING_LIMITS.pageSize);
    return { rows,total: Number(count.total),page };
  },{ readOnlySnapshot: true });
}
/** Request another observation after a linked canonical defect is built/deployed, never mark it pass.
 * Same-version old passes are below this immutable case-run cutoff until a real later save exists. */
export async function requestTestingRetest(ctx: SessionContext,p: { assignmentId: string; expectedRevision: number; expectedVersionId: string; feedbackId: string }) {
  const actor=admin(ctx); testingUuid.parse(p.assignmentId); testingUuid.parse(p.expectedVersionId); testingUuid.parse(p.feedbackId);
  if (!Number.isInteger(p.expectedRevision)||p.expectedRevision<0) throw new TestingRefusal('invalid');
  return withTenant(ctx,async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`testing-library:${ctx.tenantId}`},0))`);
    const [found] = await tx.select().from(testAssignment).where(eq(testAssignment.id,p.assignmentId)); if (!found) throw new TestingRefusal('not_found');
    const [c] = await tx.select().from(testCase).where(eq(testCase.id,found.testCaseId)).for('update');
    const [a] = await tx.select().from(testAssignment).where(eq(testAssignment.id,found.id)).for('update');
    if (!c||!a||!a.active) throw new TestingRefusal('inactive');
    if (a.revision!==p.expectedRevision || a.targetVersionId!==p.expectedVersionId || c.currentVersionId!==p.expectedVersionId) throw new TestingRefusal('stale_instructions');
    const [linked] = await tx.select({ id: testExecution.id }).from(testExecution).where(and(eq(testExecution.assignmentId,a.id),eq(testExecution.defectFeedbackId,p.feedbackId))).limit(1);
    const [feedback] = await tx.select({ status: feedbackRequest.status }).from(feedbackRequest).where(eq(feedbackRequest.id,p.feedbackId));
    if (!linked||!feedback||!['done','deployed'].includes(feedback.status)) throw new TestingRefusal('review_required');
    const [cutoff] = await tx.select({ ordinal: sql<number>`coalesce(max(${testRun.runNo}),0)::integer` }).from(testRun).where(eq(testRun.testCaseId,c.id));
    await tx.update(testAssignment).set({ retestRequired: true,retestAfterRunNo: Number(cutoff.ordinal),revision: a.revision+1,assignedByUserId: actor,updatedAt: new Date() }).where(eq(testAssignment.id,a.id));
    await appendEvent(tx,{ tenantId: ctx.tenantId,aggregateType: 'test_case',aggregateId: c.id,eventType: 'test_assignment.retest_requested',actor: actorOf(ctx),payload: { assignmentId: a.id,versionId: a.targetVersionId,feedbackId: p.feedbackId,afterRunNo: Number(cutoff.ordinal) } });
    return { assignmentId: a.id,revision: a.revision+1 };
  });
}
