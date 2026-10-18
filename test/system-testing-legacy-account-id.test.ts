import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { withTenant, type SessionContext } from '../db/client';
import { createAdminChain } from '../db/provision';
import * as s from '../db/schema';
import { assignTestingCase, beginTestingExecution, getTestingExecution, listTestingAssignments, publishTestInstruction, saveTestInstructionDraft, saveTestingExecution } from '../core/system-testing';
import { buildIdentitySchema, executionInputSchema, testingUuid, type InstructionDefinition } from '../lib/system-testing/model';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

// The real preserved Demo login ID: PostgreSQL accepts it, but it is not an RFC-variant UUID.
const existingAccountId = '22222222-2222-2222-2222-222222222222';
const definition: InstructionDefinition = {
  format: 1, title: 'Fictional own observation', objective: 'Retain an independently saved observation.',
  functionKey: 'personnel.profile', area: 'personnel', moduleCode: 'employees', category: 'functional',
  priority: 'medium', active: true, prerequisites: [], testData: [],
  steps: [{ id: 'observe', action: 'Inspect the fictional saved value.', expected: 'The value is retained.' }],
  expectedBehavior: 'The saved observation is retained.', expectedFunction: 'Personal Testing save/history.',
  permissions: ['Use only your own assigned test.'], jurisdiction: null, configuration: null, screenKeys: ['personnelAdmin'],
};
let b: Base, admin: SessionContext, existing: SessionContext;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'system_testing', 'active');
  admin = await entitledCtx(b);
  // Reproduce the same canonical Person/login graph as the seeded admin, without employment.
  // The product fix neither creates nor rewrites any identity.
  const chain = await owner.db.transaction(tx => createAdminChain(tx, b.tenantId, {
    email: 'legacy-admin@testing.invalid', fullName: 'Fictional preserved HR Admin',
    appUserId: existingAccountId, withRoleAssignment: true,
  }));
  const grants = await owner.db.select({ role: s.roleAssignment.role, companyId: s.roleAssignment.companyId })
    .from(s.roleAssignment).where(eq(s.roleAssignment.appUserId, chain.appUserId));
  expect(grants).toEqual([{ role: 'hr_admin', companyId: null }]);
  existing = { ...admin, userId: chain.appUserId, personId: chain.personId, grants };
});
async function publishedCase() {
  const draft = await saveTestInstructionDraft(admin, { caseId: null, expectedRevision: 0, definition });
  const version = await publishTestInstruction(admin, { caseId: draft.caseId, expectedDraftRevision: draft.revision, expectedVersionId: null });
  return { caseId: draft.caseId, versionId: version.versionId };
}
describe('preserved account IDs at the System Testing service boundary', () => {
  it('lists the existing HR Admin own workspace under the restricted app role, even without assignments or employment', async () => {
    const [role] = await withTenant(existing, tx => tx.execute(sql`SELECT current_user,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`)) as unknown as { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[];
    expect(role).toEqual({ current_user: 'ai_hr_app', rolsuper: false, rolbypassrls: false });
    expect(await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId, b.tenantId), eq(s.employment.personId, existing.personId!)))).toEqual([]);
    expect(await listTestingAssignments(existing)).toEqual({ rows: [], total: 0, page: 1, summary: [] });
  });
  it('assigns that real login and saves only its own versioned observation without granting another tester access', async () => {
    const c = await publishedCase();
    const own = await assignTestingCase(admin, { ...c, testerUserId: existingAccountId, expectedVersionId: c.versionId, active: true, expectedRevision: null });
    const other = await assignTestingCase(admin, { ...c, testerUserId: admin.userId!, expectedVersionId: c.versionId, active: true, expectedRevision: null });
    const e = await beginTestingExecution(existing, { assignmentId: own.assignmentId, expectedVersionId: c.versionId, newAttempt: false });
    const otherExecution = await beginTestingExecution(admin, { assignmentId: other.assignmentId, expectedVersionId: c.versionId, newAttempt: false });
    const input = { executionId: e.executionId, assignmentId: own.assignmentId, versionId: c.versionId, expectedRevision: 0, status: 'passed' as const, actualResult: 'Fictional value retained.', comments: '', defectNotes: '', improvementNotes: '' };
    const saved = await saveTestingExecution(existing, input);
    expect((await listTestingAssignments(existing)).rows).toMatchObject([{ testerUserId: existingAccountId, executionId: e.executionId, status: 'passed' }]);
    expect((await listTestingAssignments(admin, { team: true, testerUserId: existingAccountId })).rows).toHaveLength(1);
    const detail = await getTestingExecution(existing, e.executionId);
    expect(detail.execution.testerUserId).toBe(existingAccountId);
    expect(detail.history).toMatchObject([{ id: saved.runId, runByUserId: existingAccountId, executionStatus: 'passed' }]);
    await expect(getTestingExecution(existing, otherExecution.executionId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(beginTestingExecution(existing, { assignmentId: other.assignmentId, expectedVersionId: c.versionId, newAttempt: false })).rejects.toMatchObject({ code: 'not_assigned' });
    await expect(saveTestingExecution(admin, input)).rejects.toMatchObject({ code: 'not_assigned' });
    expect(await owner.db.select().from(s.testRun).where(eq(s.testRun.executionId, e.executionId))).toHaveLength(1);
  });
  it('refuses malformed, nonexistent and foreign-tenant assignment targets without inserting assignments', async () => {
    const c = await publishedCase();
    for (const testerUserId of ['not-a-uuid', '22222222222222222222222222222222', ' ' + existingAccountId, existingAccountId + ' ', '{' + existingAccountId + '}']) {
      await expect(assignTestingCase(admin, { ...c, testerUserId, expectedVersionId: c.versionId, active: true, expectedRevision: null })).rejects.toBeInstanceOf(ZodError);
      await expect(listTestingAssignments(admin, { team: true, testerUserId })).rejects.toBeInstanceOf(ZodError);
    }
    const foreign = await seedBase();
    for (const testerUserId of ['33333333-3333-3333-3333-333333333333', foreign.adminUserId]) {
      await expect(assignTestingCase(admin, { ...c, testerUserId, expectedVersionId: c.versionId, active: true, expectedRevision: null })).rejects.toMatchObject({ code: 'not_found' });
      expect((await listTestingAssignments(admin, { team: true, testerUserId })).rows).toEqual([]);
    }
    expect(await owner.db.select().from(s.testAssignment).where(eq(s.testAssignment.testCaseId, c.caseId))).toEqual([]);
  });
  it('keeps generated execution and build-record UUID contracts strict', () => {
    const generated = randomUUID();
    expect(testingUuid.safeParse(generated).success).toBe(true);
    expect(testingUuid.safeParse(existingAccountId).success).toBe(false);
    const input = { executionId: generated, assignmentId: randomUUID(), versionId: randomUUID(), expectedRevision: 0, status: 'in_progress', actualResult: '', comments: '', defectNotes: '', improvementNotes: '' };
    expect(executionInputSchema.safeParse(input).success).toBe(true);
    for (const key of ['executionId', 'assignmentId', 'versionId']) expect(executionInputSchema.safeParse({ ...input, [key]: existingAccountId }).success).toBe(false);
    const identity = { sourceRef: 'a'.repeat(40), buildRecordId: generated, catalogueHash: 'b'.repeat(64), contentHash: 'c'.repeat(64) };
    expect(buildIdentitySchema.safeParse(identity).success).toBe(true);
    expect(buildIdentitySchema.safeParse({ ...identity, buildRecordId: existingAccountId }).success).toBe(false);
  });
});
