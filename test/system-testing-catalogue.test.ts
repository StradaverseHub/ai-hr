/** Actual app-role catalogue transactions. Only the compile-bound bundle is a clearly fictional test
 * fixture; this is NOT a Next artifact/current-source review proof. No service/RLS/auth mocking. UNRUN. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { catalogueDigest, sourceContentDigest } from '../lib/system-testing/hash';
import type { InstructionDefinition, ReviewedCatalogue } from '../lib/system-testing/model';
const fixture = vi.hoisted(() => ({ available: true }));
vi.mock('../lib/system-testing/catalogue', async () => {
  const { sourceContentDigest } = await import('../lib/system-testing/hash');
  return { REVIEWED_SYSTEM_TESTING_CATALOGUE: { format: 1,revision: 'fictional.test',entries: [{ semanticId: 'fictional.navigation.open',definition: { format: 1,title: 'Fictional navigation check',objective: 'Read authorized Home.',functionKey: 'ess.navigation',area: 'personnel',moduleCode: 'ess',category: 'functional',priority: 'medium',active: true,prerequisites: ['Use a fictional account.'],testData: ['No personal record required.'],steps: [{ id: 'open',action: 'Open authorized Home.',expected: 'Authorized Home is visible.' }],expectedBehavior: 'Home renders.',expectedFunction: 'Existing navigation.',permissions: ['Ordinary existing Home authority.'],jurisdiction: null,configuration: null,screenKeys: ['dashboard'] },sources: ['app/(app)/page.tsx'],reviewedSourceHash: sourceContentDigest([{ path: 'app/(app)/page.tsx',sha256: 'a'.repeat(64) }]),reviewNote: 'FICTIONAL test bundle; not an actual production source review.' }] } };
});
vi.mock('../lib/system-testing/build-identity', async () => {
  const { catalogueDigest,sourceContentDigest } = await import('../lib/system-testing/hash');
  return { compiledTestingBuildEvidence: (bundle: ReviewedCatalogue) => ({ sourceHashRecord: [{ path: 'app/(app)/page.tsx',sha256: 'a'.repeat(64) }],readiness: fixture.available ? { status: 'verified_build_identity',identity: { sourceRef: 'a'.repeat(40),buildRecordId: '80dec6a2-8dd2-4d7a-8723-79c12994d453',catalogueHash: catalogueDigest(bundle),contentHash: sourceContentDigest([{ path: 'app/(app)/page.tsx',sha256: 'a'.repeat(64) }]) },activeServiceVerified: false } : { status: 'review_required',reason: 'missing_identity' } }) };
});
import { REVIEWED_SYSTEM_TESTING_CATALOGUE as bundle } from '../lib/system-testing/catalogue';
import { confirmTestingCatalogue, getTestingCatalogueUpdate, preloadTestingCatalogue, previewTestingCatalogue, saveTestInstructionDraft } from '../core/system-testing';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let b: Base,admin: SessionContext;
const key = 'fictional.navigation.open';
const definition = () => bundle.entries[0].definition as InstructionDefinition;
beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); await setModule(b.tenantId,'system_testing','active'); admin = await entitledCtx(b); fixture.available = true; });
function confirmation(previewHash: string) { return { expectedPreviewHash: previewHash,semanticIds: [key],replaceLocal: [],distinctLegacy: [],legacyMappings: [] }; }
describe('canonical exact-hash catalogue confirmation', () => {
  it('previews without writing and serializes two confirmations/retry to one case/version/update without assigning anyone', async () => {
    const before = await previewTestingCatalogue(admin); expect(before.preview.entries[0].action).toBe('add');
    expect(await owner.db.select().from(s.testCase).where(eq(s.testCase.tenantId,b.tenantId))).toEqual([]);
    const [a,z] = await Promise.all([confirmTestingCatalogue(admin,confirmation(before.preview.previewHash)),confirmTestingCatalogue(admin,confirmation(before.preview.previewHash))]);
    expect(a.updateId).toBe(z.updateId); expect(new Set([a.status,z.status])).toEqual(new Set(['applied','unchanged']));
    expect(await owner.db.select().from(s.testCase).where(eq(s.testCase.tenantId,b.tenantId))).toHaveLength(1);
    expect(await owner.db.select().from(s.testCaseVersion).where(eq(s.testCaseVersion.tenantId,b.tenantId))).toHaveLength(1);
    expect(await owner.db.select().from(s.testAssignment).where(eq(s.testAssignment.tenantId,b.tenantId))).toEqual([]);
    expect((await confirmTestingCatalogue(admin,confirmation(before.preview.previewHash))).status).toBe('unchanged');
    expect((await previewTestingCatalogue(admin)).preview.entries[0].action).toBe('unchanged');
    const detail = await getTestingCatalogueUpdate(admin,a.updateId); expect(detail.result).toEqual(a.results);
  });
  it('refuses a stale preview and preserves exact replaced unpublished content only after explicit confirmation', async () => {
    const before = await previewTestingCatalogue(admin);
    const first = await confirmTestingCatalogue(admin,confirmation(before.preview.previewHash));
    const caseId = first.results[0].caseId;
    await saveTestInstructionDraft(admin,{ caseId,expectedRevision: 1,definition: { ...definition(),title: 'Unpublished local change',objective: '' } });
    await expect(confirmTestingCatalogue(admin,{ ...confirmation(before.preview.previewHash),replaceLocal: [key] })).rejects.toMatchObject({ code: 'stale_preview' });
    const compared = await previewTestingCatalogue(admin);
    await expect(confirmTestingCatalogue(admin,confirmation(compared.preview.previewHash))).rejects.toThrow();
    const applied = await confirmTestingCatalogue(admin,{ ...confirmation(compared.preview.previewHash),replaceLocal: [key] });
    expect(applied.results[0]).toMatchObject({ beforeVersionId: first.results[0].versionId,resolution: 'replace_local',beforeDraft: { revision: 2,definition: { title: 'Unpublished local change',objective: '' } } });
    const versions = await owner.db.select().from(s.testCaseVersion).where(eq(s.testCaseVersion.testCaseId,caseId)).orderBy(asc(s.testCaseVersion.ordinal)); expect(versions).toHaveLength(2);
    expect((await getTestingCatalogueUpdate(admin,applied.updateId)).result[0].beforeDraft).toEqual(applied.results[0].beforeDraft);
  });
  it('requires canonical build evidence and module access on every catalogue entry point', async () => {
    const before = await previewTestingCatalogue(admin); fixture.available = false;
    await expect(confirmTestingCatalogue(admin,confirmation(before.preview.previewHash))).rejects.toMatchObject({ code: 'stale_preview' });
    expect(await preloadTestingCatalogue(admin)).toEqual({ status: 'review_required',added: 0 });
    expect(await owner.db.select().from(s.testCase)).toEqual([]);
    await setModule(b.tenantId,'system_testing','disabled'); const removed = await entitledCtx(b);
    for (const call of [() => previewTestingCatalogue(removed),() => confirmTestingCatalogue(removed,confirmation(before.preview.previewHash)),() => preloadTestingCatalogue(removed),() => getTestingCatalogueUpdate(removed,b.adminUserId)]) await expect(call()).rejects.toMatchObject({ name: 'ModuleNotEnabledError' });
  });
  it('bounds decoded comparison data before parsing/hydration and refuses caller identity/extra properties', async () => {
    const d = await saveTestInstructionDraft(admin,{ caseId: null,expectedRevision: 0,definition: definition() });
    await withTenant(admin,tx => tx.execute(sql`UPDATE public.test_case SET draft_definition=jsonb_build_object('oversized',repeat('x',8388609)) WHERE id=${d.caseId}::uuid`));
    await expect(previewTestingCatalogue(admin)).rejects.toMatchObject({ code: 'limit' });
    await expect(confirmTestingCatalogue(admin,{ ...confirmation('a'.repeat(64)),sourceRef: 'b'.repeat(40) } as Parameters<typeof confirmTestingCatalogue>[1])).rejects.toThrow();
    expect(await owner.db.select().from(s.testCaseVersion)).toEqual([]);
  });
});
