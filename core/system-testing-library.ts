/** Bounded administration readers and explicit retest requests for the same canonical case owner. */
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { appUser, feedbackRequest, person, testAssignment, testCase, testCaseVersion, testExecution, testRun } from '../db/schema';
import { isAdmin } from '../lib/authz';
import { parseInstructionDraft, parsePublishedInstruction, TestingRefusal, TESTING_LIMITS, testingUuid, TESTING_AREAS, TESTING_CATEGORIES, TESTING_PRIORITIES } from '../lib/system-testing/model';
import { assertModuleEnabled } from './entitlements';
import { SYSTEM_TESTING_MODULE } from './system-testing';
function admin(ctx: SessionContext) {
  assertModuleEnabled(ctx,SYSTEM_TESTING_MODULE);
  if (!isAdmin(ctx) || !ctx.userId) throw new TestingRefusal('not_assigned');
  return ctx.userId;
}
export type TestingLibraryFilter = { search?: string; moduleCode?: string; area?: string; category?: string; priority?: string; active?: 'active'|'inactive'|'draft'; versionOrdinal?: number; page?: number };
export async function listTestingLibrary(ctx: SessionContext,p: TestingLibraryFilter = {}) {
  admin(ctx);
  const page = p.page ?? 1;
  if (!Number.isInteger(page) || page<1 || page>20000 || (p.search?.length ?? 0)>240 || (p.moduleCode?.length ?? 0)>160 || p.area && !TESTING_AREAS.some(v => v===p.area) || p.category && !TESTING_CATEGORIES.some(v => v===p.category) || p.priority && !TESTING_PRIORITIES.some(v => v===p.priority) || p.active && !['active','inactive','draft'].includes(p.active) || p.versionOrdinal!==undefined && (!Number.isInteger(p.versionOrdinal) || p.versionOrdinal<1)) throw new TestingRefusal('invalid');
  return withTenant(ctx,async tx => {
    const where = and(eq(testCase.tenantId,ctx.tenantId),
      p.search ? sql`position(lower(${p.search}) IN lower(${testCase.title}))>0` : undefined,
      p.moduleCode ? eq(testCase.moduleCode,p.moduleCode) : undefined,
      p.area ? sql`${testCaseVersion.definition}->>'area'=${p.area}` : undefined,
      p.category ? eq(testCase.testType,p.category) : undefined,
      p.priority ? eq(testCase.priority,p.priority) : undefined,
      p.active==='draft' ? sql`${testCase.draftDefinition} IS NOT NULL` : p.active ? sql`coalesce(${testCaseVersion.definition}->>'active','true')=${p.active==='active'?'true':'false'}` : undefined,
      p.versionOrdinal===undefined ? undefined : eq(testCaseVersion.ordinal,p.versionOrdinal));
    const join = eq(testCaseVersion.id,testCase.currentVersionId);
    const [count] = await tx.select({ total: sql<number>`count(*)::integer` }).from(testCase).leftJoin(testCaseVersion,join).where(where);
    const rows = await tx.select({ id: testCase.id,caseNo: testCase.caseNo,title: testCase.title,moduleCode: testCase.moduleCode,category: testCase.testType,priority: testCase.priority,origin: testCase.origin,versionId: testCase.currentVersionId,ordinal: testCaseVersion.ordinal,area: sql<string|null>`${testCaseVersion.definition}->>'area'`,active: sql<boolean>`coalesce(${testCaseVersion.definition}->>'active','true')='true'`,hasDraft: sql<boolean>`${testCase.draftDefinition} IS NOT NULL`,draftRevision: testCase.draftRevision }).from(testCase).leftJoin(testCaseVersion,join).where(where).orderBy(testCase.caseNo,testCase.id).limit(TESTING_LIMITS.pageSize).offset((page-1)*TESTING_LIMITS.pageSize);
    return { rows,total: Number(count.total),page };
  },{ readOnlySnapshot: true });
}
export async function getTestingLibraryCase(ctx: SessionContext,caseId: string) {
  admin(ctx); testingUuid.parse(caseId);
  return withTenant(ctx,async tx => {
    const [row] = await tx.select({ c: testCase,v: testCaseVersion }).from(testCase).leftJoin(testCaseVersion,eq(testCaseVersion.id,testCase.currentVersionId)).where(and(eq(testCase.id,caseId),sql`octet_length(coalesce(${testCase.draftDefinition}::text,''))+octet_length(coalesce(${testCaseVersion.definition}::text,''))<=8388608`)).limit(1);
    if (!row) throw new TestingRefusal('not_found');
    const versions = await tx.select({ id: testCaseVersion.id,ordinal: testCaseVersion.ordinal,contentHash: testCaseVersion.contentHash,provenance: testCaseVersion.provenance,publishedAt: testCaseVersion.publishedAt,publishedByUserId: testCaseVersion.publishedByUserId }).from(testCaseVersion).where(eq(testCaseVersion.testCaseId,caseId)).orderBy(desc(testCaseVersion.ordinal)).limit(201);
    const assignments = await tx.select().from(testAssignment).where(eq(testAssignment.testCaseId,caseId)).orderBy(testAssignment.testerUserId,testAssignment.id).limit(501);
    return { testCase: row.c,definition: row.v ? parsePublishedInstruction(row.v.definition) : null,draft: row.c.draftDefinition ? parseInstructionDraft(row.c.draftDefinition) : null,versions: versions.slice(0,200),versionsTruncated: versions.length>200,assignments: assignments.slice(0,500),assignmentsTruncated: assignments.length>500 };
  },{ readOnlySnapshot: true });
}
/** Existing app-user and Person RLS still decides which human names are available; no salary/contact
 * or external identity is fetched, and an unavailable name remains a login ID in the UI. */
export async function listTestingTesterOptions(ctx: SessionContext,p: { page?: number } = {}) {
  admin(ctx); const page=p.page??1; if (!Number.isInteger(page)||page<1||page>20000) throw new TestingRefusal('invalid');
  return withTenant(ctx,async tx => {
    const where = and(eq(appUser.tenantId,ctx.tenantId),sql`${appUser.archivedAt} IS NULL AND NOT app.login_blocked(${appUser.id})`);
    const [count] = await tx.select({ total: sql<number>`count(*)::integer` }).from(appUser).where(where);
    const rows = await tx.select({ userId: appUser.id,name: person.fullName }).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(where).orderBy(appUser.id).limit(TESTING_LIMITS.pageSize).offset((page-1)*TESTING_LIMITS.pageSize);
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
