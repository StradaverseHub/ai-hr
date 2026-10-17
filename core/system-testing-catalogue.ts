/** Catalogue updates extend the canonical System Testing case/version owner, never a second library. */
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { testCase, testCaseVersion, testCatalogueUpdate } from '../db/schema';
import { isAdmin } from '../lib/authz';
import { MODULE_CATALOG } from '../packs/catalog';
import { SCREENS } from '../lib/permissions';
import { compiledTestingBuildEvidence } from '../lib/system-testing/build-identity';
import { REVIEWED_SYSTEM_TESTING_CATALOGUE as catalogue } from '../lib/system-testing/catalogue';
import { testingCoverageInventory } from '../lib/system-testing/inventory';
import { parsePublishedInstruction, parseInstructionDraft, testingUuid, TestingRefusal } from '../lib/system-testing/model';
import { previewTestingUpdates, selectedTestingUpdateId, confirmTestingCatalogueSchema, canonicalLegacyMappings, type ConfirmTestingCatalogueInput, type TestingCatalogueAppliedResult, type LegacyCaseMapping, type LibraryCaseSnapshot, type TestingUpdatePreview } from '../lib/system-testing/updates';
import { testingDigest } from '../lib/system-testing/hash';
import { assertModuleEnabled } from './entitlements';
import { isTestableModule, listTestableModules, nextTestCaseNoTx, SYSTEM_TESTING_MODULE } from './system-testing';
import { publishTestInstructionTx } from './system-testing-workspace';
function admin(ctx: SessionContext): string {
  assertModuleEnabled(ctx, SYSTEM_TESTING_MODULE);
  if (!isAdmin(ctx) || !ctx.userId) throw new TestingRefusal('not_assigned');
  return ctx.userId;
}
async function lock(tx: Tx, ctx: SessionContext) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`testing-library:${ctx.tenantId}`},0))`);
}
async function librarySnapshotTx(tx: Tx, ctx: SessionContext): Promise<LibraryCaseSnapshot[]> {
  // Count encoded payload before hydration. TOAST/compressed size does not bound parsed JSON.
  const [bound] = await tx.execute(sql`SELECT count(*)::integer AS n,coalesce(sum(octet_length(to_jsonb(c)::text)+coalesce(octet_length(v.definition::text),0)),0)::text AS bytes FROM public.test_case c LEFT JOIN public.test_case_version v ON v.id=c.current_version_id WHERE c.tenant_id=${ctx.tenantId}::uuid`) as unknown as { n: number; bytes: string }[];
  if (bound.n > 10000 || BigInt(bound.bytes) > BigInt('8388608')) throw new TestingRefusal('limit');
  const rows = await tx.select({ c: testCase, v: testCaseVersion }).from(testCase).leftJoin(testCaseVersion, eq(testCaseVersion.id, testCase.currentVersionId)).where(and(eq(testCase.tenantId, ctx.tenantId),sql`(SELECT coalesce(sum(octet_length(to_jsonb(c2)::text)+coalesce(octet_length(v2.definition::text),0)),0) FROM public.test_case c2 LEFT JOIN public.test_case_version v2 ON v2.id=c2.current_version_id WHERE c2.tenant_id=${ctx.tenantId}::uuid)<=8388608`)).orderBy(testCase.caseNo, testCase.id).limit(10001);
  if (rows.length > 10000 || bound.n > 0 && rows.length === 0) throw new TestingRefusal('limit');
  return rows.map(({ c, v }) => ({ caseId: c.id, caseNo: c.caseNo, versionId: v?.id ?? null, versionHash: v?.contentHash ?? null, semanticId: c.semanticId, origin: c.origin, acceptedCatalogueDefinitionHash: c.acceptedCatalogueDefinitionHash, acceptedGuideSourceHash: v?.guideSourceHash ?? null, title: v ? parsePublishedInstruction(v.definition).title : c.title, hasLocalDraft: c.draftDefinition !== null, draftRevision: c.draftRevision, draftDefinition: c.draftDefinition ? parseInstructionDraft(c.draftDefinition) : null, definition: v ? parsePublishedInstruction(v.definition) : null }));
}
function preview(ctx: SessionContext, library: LibraryCaseSnapshot[], mappings: readonly LegacyCaseMapping[]) {
  const build = compiledTestingBuildEvidence(catalogue);
  return previewTestingUpdates({ catalogue, identity: build.readiness, sourceHashRecord: build.sourceHashRecord, library, enabledModuleCodes: listTestableModules(ctx).map(m => m.code), legacyMappings: mappings });
}
export async function previewTestingCatalogue(ctx: SessionContext, options: { legacyMappings?: LegacyCaseMapping[] } = {}) {
  admin(ctx);
  if ((options.legacyMappings?.length ?? 0) > 200) throw new TestingRefusal('limit');
  const mappings = canonicalLegacyMappings(options.legacyMappings ?? []);
  return withTenant(ctx, async tx => {
    const library = await librarySnapshotTx(tx, ctx);
    const history = await tx.select({ id: testCatalogueUpdate.id, updateHash: testCatalogueUpdate.updateHash, previewHash: testCatalogueUpdate.previewHash, catalogueHash: testCatalogueUpdate.catalogueHash, sourceRef: testCatalogueUpdate.sourceRef, sourceContentHash: testCatalogueUpdate.sourceContentHash, createdAt: testCatalogueUpdate.createdAt, confirmedByUserId: testCatalogueUpdate.confirmedByUserId, appliedCount: sql<number>`jsonb_array_length(${testCatalogueUpdate.result})` }).from(testCatalogueUpdate).where(eq(testCatalogueUpdate.tenantId, ctx.tenantId)).orderBy(testCatalogueUpdate.createdAt, testCatalogueUpdate.id).limit(201);
    return { preview: preview(ctx, library, mappings), library, coverage: testingCoverageInventory(catalogue, SCREENS, MODULE_CATALOG), history: history.slice(0, 200), historyTruncated: history.length > 200 };
  }, { readOnlySnapshot: true });
}
export type { ConfirmTestingCatalogueInput } from '../lib/system-testing/updates';
/** Exact-hash human confirmation. No caller build identity, source URL, author flag or function is accepted. */
export async function confirmTestingCatalogue(ctx: SessionContext, raw: ConfirmTestingCatalogueInput): Promise<{ status: 'applied' | 'unchanged'; updateId: string; results: TestingCatalogueAppliedResult[] }> {
  admin(ctx);
  const p = confirmTestingCatalogueSchema.parse(raw);
  return withTenant(ctx, async tx => {
    await lock(tx, ctx);
    return confirmTx(tx, ctx, p);
  });
}
async function confirmTx(tx: Tx, ctx: SessionContext, p: ConfirmTestingCatalogueInput) {
  const actor = admin(ctx);
  const updateHash = testingDigest({ previewHash: p.expectedPreviewHash, semanticIds: [...p.semanticIds].sort(), replaceLocal: [...p.replaceLocal].sort(), distinctLegacy: [...p.distinctLegacy].sort(), legacyMappings: canonicalLegacyMappings(p.legacyMappings) });
  const [prior] = await tx.select().from(testCatalogueUpdate).where(and(eq(testCatalogueUpdate.updateHash, updateHash),sql`octet_length(${testCatalogueUpdate.result}::text)<=8388608`)).limit(1);
  if (prior) return { status: 'unchanged' as const, updateId: prior.id, results: prior.result };
  const before = preview(ctx, await librarySnapshotTx(tx, ctx), p.legacyMappings);
  if (before.previewHash !== p.expectedPreviewHash) throw new TestingRefusal('stale_preview');
  if (before.identity.status !== 'verified_build_identity') throw new TestingRefusal('review_required');
  // Recomputed owner preview, not caller-provided entries or truth flags, decides every selected change.
  if (selectedTestingUpdateId(before, p.semanticIds, p.replaceLocal, p.distinctLegacy) !== updateHash) throw new TestingRefusal('invalid');
  const results: TestingCatalogueAppliedResult[] = [];
  for (const semanticId of [...p.semanticIds].sort()) {
    const entry = before.entries.find(e => e.semanticId === semanticId);
    if (!entry || !entry.guideSourceHash || !isTestableModule(ctx, entry.after.moduleCode)) throw new TestingRefusal('review_required');
    let caseId = entry.caseId;
    if (!caseId) {
      const caseNo = await nextTestCaseNoTx(tx, ctx.tenantId);
      const [c] = await tx.insert(testCase).values({ tenantId: ctx.tenantId, caseNo, title: entry.after.title, moduleCode: entry.after.moduleCode, semanticId, origin: 'catalogue', createdByUserId: actor, updatedByUserId: actor }).returning({ id: testCase.id });
      caseId = c.id;
    }
    const published = await publishTestInstructionTx(tx, ctx, { caseId, expectedVersionId: entry.expectedVersionId, expectedDraftRevision: entry.expectedDraftRevision, definition: entry.after, provenance: { kind: 'catalogue', semanticId, sourceRef: before.identity.identity.sourceRef, catalogueHash: before.catalogueHash, sourceContentHash: before.identity.identity.contentHash, guideSourceHash: entry.guideSourceHash } });
    results.push({ caseId, versionId: published.versionId, semanticId, beforeVersionId: entry.expectedVersionId, beforeDraft: entry.beforeDraft ? { revision: entry.expectedDraftRevision, definition: entry.beforeDraft } : null, resolution: p.replaceLocal.includes(semanticId) ? 'replace_local' : p.distinctLegacy.includes(semanticId) ? 'distinct_legacy' : p.legacyMappings.some(m => m.semanticId === semanticId) ? 'map_legacy' : 'catalogue', reason: entry.reason });
  }
  if (Buffer.byteLength(JSON.stringify(results),'utf8') > 8388608) throw new TestingRefusal('limit');
  const [record] = await tx.insert(testCatalogueUpdate).values({ tenantId: ctx.tenantId, updateHash, previewHash: before.previewHash, catalogueHash: before.catalogueHash, sourceRef: before.identity.identity.sourceRef, sourceContentHash: before.identity.identity.contentHash, selectedSemanticIds: [...p.semanticIds].sort(), result: results, confirmedByUserId: actor }).returning({ id: testCatalogueUpdate.id });
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'test_catalogue_update', aggregateId: record.id, eventType: 'test_catalogue.confirmed', actor: actorOf(ctx), payload: { updateHash, previewHash: before.previewHash, sourceRef: before.identity.identity.sourceRef, catalogueHash: before.catalogueHash, caseVersionIds: results.map(r => r.versionId) } });
  return { status: 'applied' as const, updateId: record.id, results };
}
/** Approved initial reviewed preload only, with no assignments and no overwrite of legacy/local cases. */
export async function preloadTestingCatalogue(ctx: SessionContext): Promise<{ status: 'initialized' | 'already_initialized' | 'review_required'; added: number }> {
  admin(ctx);
  return withTenant(ctx, async tx => {
    await lock(tx, ctx);
    const [existing] = await tx.select({ id: testCatalogueUpdate.id }).from(testCatalogueUpdate).where(eq(testCatalogueUpdate.tenantId, ctx.tenantId)).limit(1);
    if (existing) return { status: 'already_initialized', added: 0 };
    const compared = preview(ctx, await librarySnapshotTx(tx, ctx), []);
    const selected = compared.entries.filter(e => e.action === 'add' && e.after.active).map(e => e.semanticId);
    if (compared.identity.status !== 'verified_build_identity' || !selected.length) return { status: 'review_required', added: 0 };
    const outcome = await confirmTx(tx, ctx, { expectedPreviewHash: compared.previewHash, semanticIds: selected, replaceLocal: [], distinctLegacy: [], legacyMappings: [] });
    return { status: 'initialized', added: outcome.results.length };
  });
}

/** Immutable update detail is fetched separately, with an encoded-byte bound before hydration. */
export async function getTestingCatalogueUpdate(ctx: SessionContext, updateId: string) {
  admin(ctx);
  testingUuid.parse(updateId);
  return withTenant(ctx, async tx => {
    const [row] = await tx.select().from(testCatalogueUpdate).where(and(eq(testCatalogueUpdate.id,updateId),sql`octet_length(${testCatalogueUpdate.result}::text)<=8388608`)).limit(1);
    if (!row) throw new TestingRefusal('not_found');
    return row;
  }, { readOnlySnapshot: true });
}
