/** Deterministic reviewed-catalogue comparison. It proposes changes; only the owner may confirm them. */
import { z } from 'zod';
import { catalogueSchema, testingSemanticId, instructionDraftSchema, testingHash, testingUuid, type InstructionDefinition, type PublishedInstruction, type ReviewedCatalogue, type TestingBuildReadiness, type TestingSourceHashRecord } from './model';
import { catalogueDigest, sourceContentDigest, testingDigest } from './hash';
export type LibraryCaseSnapshot = {
  caseId: string; caseNo: number; versionId: string | null; versionHash: string | null;
  semanticId: string | null; origin: 'local' | 'catalogue' | 'legacy';
  /** Last accepted catalogue definition. A local revision differs from this exact digest. */
  acceptedCatalogueDefinitionHash: string | null; acceptedGuideSourceHash: string | null;
  title: string; hasLocalDraft: boolean; draftRevision: number; draftDefinition: InstructionDefinition | null; definition: PublishedInstruction | null;
};
export const legacyCaseMappingSchema = z.strictObject({ semanticId: testingSemanticId, caseId: testingUuid, expectedVersionId: testingUuid, expectedVersionHash: testingHash });
export type LegacyCaseMapping = z.infer<typeof legacyCaseMappingSchema>;
const selectedIds = z.array(testingSemanticId).max(200).refine(ids => new Set(ids).size === ids.length);
export const confirmTestingCatalogueSchema = z.strictObject({ expectedPreviewHash: testingHash, semanticIds: selectedIds.min(1), replaceLocal: selectedIds, distinctLegacy: selectedIds, legacyMappings: z.array(legacyCaseMappingSchema).max(200) });
export type ConfirmTestingCatalogueInput = z.infer<typeof confirmTestingCatalogueSchema>;
export type TestingCatalogueAppliedResult = { caseId: string; versionId: string; semanticId: string; beforeVersionId: string | null; beforeDraft: { revision: number; definition: InstructionDefinition } | null; resolution: 'catalogue' | 'replace_local' | 'map_legacy' | 'distinct_legacy'; reason: TestingUpdateEntry['reason'] };
export function canonicalLegacyMappings(mappings: readonly LegacyCaseMapping[]): LegacyCaseMapping[] { return mappings.map(m => legacyCaseMappingSchema.parse(m)).sort((a,b) => a.semanticId.localeCompare(b.semanticId,'en')); }
export type TestingUpdateEntry = {
  semanticId: string; action: 'add' | 'revise' | 'unchanged' | 'conflict' | 'review_required';
  reason: 'new_reviewed_guide' | 'instructions_changed' | 'already_current' | 'local_override' | 'ambiguous_identity' | 'unverified_build' | 'unmapped_legacy' | 'unreviewed_source_change' | 'reviewed_source_changed';
  caseId: string | null; expectedVersionId: string | null; expectedVersionHash: string | null;
  expectedDraftRevision: number; beforeDraft: InstructionDefinition | null;
  before: PublishedInstruction | null; after: InstructionDefinition; afterHash: string; guideSourceHash: string | null;
  possibleLegacyCaseIds: string[];
};
export type TestingUpdatePreview = {
  format: 1; catalogueHash: string; identity: TestingBuildReadiness; libraryHash: string;
  entries: TestingUpdateEntry[]; legacyMappings: LegacyCaseMapping[]; previewHash: string;
};
/** Missing entries do not mean removal. No catalogue comparison can silently archive a local case. */
export function previewTestingUpdates(p: { catalogue: ReviewedCatalogue; identity: TestingBuildReadiness; library: readonly LibraryCaseSnapshot[]; enabledModuleCodes: readonly string[]; sourceHashRecord: TestingSourceHashRecord; legacyMappings?: readonly LegacyCaseMapping[] }): TestingUpdatePreview {
  const catalogue = catalogueSchema.parse(p.catalogue), catalogueHash = catalogueDigest(catalogue);
  if (p.library.length > 10000 || (p.legacyMappings?.length ?? 0) > 1000) throw new Error('Testing library comparison exceeds its supported bound.');
  const caseIds = new Set<string>();
  for (const row of p.library) {
    testingUuid.parse(row.caseId); if (row.versionId !== null) testingUuid.parse(row.versionId); if (row.versionHash !== null) testingHash.parse(row.versionHash);
    if (caseIds.has(row.caseId)) throw new Error('Duplicate library case identity.');
    if (!Number.isInteger(row.draftRevision) || row.draftRevision < 0 || row.hasLocalDraft !== (row.draftDefinition !== null)) throw new Error('Invalid library draft snapshot.');
    if (row.draftDefinition) instructionDraftSchema.parse(row.draftDefinition);
    caseIds.add(row.caseId);
  }
  const mappings = canonicalLegacyMappings(p.legacyMappings ?? []), mappedCases = new Set<string>(), mappedSemantic = new Set<string>();
  for (const mapping of mappings) {
    if (mappedCases.has(mapping.caseId) || mappedSemantic.has(mapping.semanticId)) throw new Error('A legacy mapping must be one-to-one.');
    const row = p.library.find(r => r.caseId === mapping.caseId);
    if (!row || !['legacy','local'].includes(row.origin) || row.semanticId !== null || row.versionId !== mapping.expectedVersionId || row.versionHash !== mapping.expectedVersionHash || !catalogue.entries.some(e => e.semanticId === mapping.semanticId)) throw new Error('Legacy mapping no longer matches the reviewed record.');
    mappedCases.add(mapping.caseId); mappedSemantic.add(mapping.semanticId);
  }
  const library = [...p.library].sort((a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0);
  const libraryHash = testingDigest(library), enabled = new Set(p.enabledModuleCodes);
  const verified = p.identity.status === 'verified_build_identity' && p.identity.identity.catalogueHash === catalogueHash && p.identity.identity.contentHash === sourceContentDigest(p.sourceHashRecord);
  const entries = catalogue.entries.filter(e => enabled.has(e.definition.moduleCode) || e.definition.moduleCode === 'cross_module').map(e => {
    const mapping = mappings.find(m => m.semanticId === e.semanticId);
    const matches = library.filter(r => r.semanticId === e.semanticId || mapping?.caseId === r.caseId);
    const match = matches.length === 1 ? matches[0] : null;
    // Same-module legacy cases require explicit mapping or a distinct-case decision. Titles never establish identity.
    const afterHash = testingDigest(e.definition);
    const possibleLegacyCaseIds = library.filter(r => r.semanticId === null && !mappedCases.has(r.caseId) && (r.origin === 'legacy' && r.definition?.moduleCode === e.definition.moduleCode || r.origin === 'local' && r.versionHash === afterHash)).map(r => r.caseId);
    const sourceRecords = p.sourceHashRecord.filter(r => e.sources.includes(r.path));
    const guideSourceHash = sourceRecords.length === e.sources.length ? sourceContentDigest(sourceRecords) : null;
    let action: TestingUpdateEntry['action'], reason: TestingUpdateEntry['reason'];
    if (!verified) { action = 'review_required'; reason = 'unverified_build'; }
    else if (guideSourceHash !== e.reviewedSourceHash) { action = 'review_required'; reason = 'unreviewed_source_change'; }
    else if (matches.length > 1) { action = 'conflict'; reason = 'ambiguous_identity'; }
    else if (!match && possibleLegacyCaseIds.length) { action = 'review_required'; reason = 'unmapped_legacy'; }
    else if (!match) { action = 'add'; reason = 'new_reviewed_guide'; }
    else if (match.hasLocalDraft) { action = 'conflict'; reason = 'local_override'; }
    else if (match.versionHash === afterHash && match.acceptedGuideSourceHash === guideSourceHash) { action = 'unchanged'; reason = 'already_current'; }
    else if (match.origin === 'local' || match.origin === 'catalogue' && match.acceptedCatalogueDefinitionHash !== match.versionHash) { action = 'conflict'; reason = 'local_override'; }
    else { action = 'revise'; reason = match.versionHash === afterHash ? 'reviewed_source_changed' : 'instructions_changed'; }
    return { semanticId: e.semanticId, action, reason, caseId: match?.caseId ?? null, expectedVersionId: match?.versionId ?? null, expectedVersionHash: match?.versionHash ?? null, expectedDraftRevision: match?.draftRevision ?? 0, beforeDraft: match?.draftDefinition ?? null, before: match?.definition ?? null, after: e.definition, afterHash, guideSourceHash, possibleLegacyCaseIds };
  }).sort((a, b) => a.semanticId < b.semanticId ? -1 : a.semanticId > b.semanticId ? 1 : 0);
  const body = { format: 1 as const, catalogueHash, identity: p.identity, libraryHash, entries, legacyMappings: mappings };
  return { ...body, previewHash: testingDigest(body) };
}
/** Owner regenerates the preview under its library lock and compares this exact hash before any write. */
export function selectedTestingUpdateId(preview: TestingUpdatePreview, semanticIds: readonly string[], replaceLocal: readonly string[] = [], distinctLegacy: readonly string[] = []): string {
  if (!semanticIds.length || semanticIds.length > 200 || new Set(semanticIds).size !== semanticIds.length) throw new Error('Choose a bounded unique set of updates.');
  if (new Set(replaceLocal).size !== replaceLocal.length || replaceLocal.some(key => !semanticIds.includes(key) || !preview.entries.some(e => e.semanticId === key && e.reason === 'local_override'))) throw new Error('Explicit local replacement must be selected once.');
  if (new Set(distinctLegacy).size !== distinctLegacy.length || distinctLegacy.some(key => !semanticIds.includes(key) || !preview.entries.some(e => e.semanticId === key && e.reason === 'unmapped_legacy'))) throw new Error('Explicit distinct-case decisions must match reviewed legacy conflicts.');
  for (const key of semanticIds) if (!preview.entries.some(e => e.semanticId === key && (e.action === 'add' || e.action === 'revise' || e.action === 'conflict' && e.reason === 'local_override' && replaceLocal.includes(key) || e.action === 'review_required' && e.reason === 'unmapped_legacy' && distinctLegacy.includes(key)))) throw new Error('Only verified applicable updates may be confirmed.');
  return testingDigest({ previewHash: preview.previewHash, semanticIds: [...semanticIds].sort(), replaceLocal: [...replaceLocal].sort(), distinctLegacy: [...distinctLegacy].sort(), legacyMappings: preview.legacyMappings });
}
