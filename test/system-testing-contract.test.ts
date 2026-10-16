import { describe, expect, it } from 'vitest';
import { executionInputSchema, legacyOutcomeFor, parseInstruction, parsePublishedInstruction, type InstructionDefinition, type ReviewedCatalogue } from '../lib/system-testing/model';
import { testingBuildReadiness } from '../lib/system-testing/build-identity';
import { catalogueDigest, sourceContentDigest, testingDigest } from '../lib/system-testing/hash';
import { previewTestingUpdates, selectedTestingUpdateId, type LibraryCaseSnapshot } from '../lib/system-testing/updates';
const id = 'a74fce27-2c4c-4dbe-93de-40c438852aa0', version = '455e0338-1ce4-4c53-8d05-fb1905c4078c';
const guide: InstructionDefinition = { format: 1, title: 'Save and reopen a fictional employee', objective: 'Confirm the saved value is retained.', functionKey: 'personnel.profile', area: 'personnel', moduleCode: 'employees', category: 'functional', priority: 'high', active: true, prerequisites: ['Use an isolated fictional employee; obtain normal company HR access.'], testData: ['A distinctive fictional preferred name.'], steps: [{ id: 'save', action: 'Save the fictional preferred name.', expected: 'A successful save is shown.' }, { id: 'reopen', action: 'Open the same employee again.', expected: 'The saved preferred name is retained.' }], expectedBehavior: 'The saved value is retained.', expectedFunction: 'Normal Personnel editing and persisted profile reading.', permissions: ['Company-scoped HR access to this fictional employee.'], jurisdiction: null, configuration: null, screenKeys: ['people'] };
const sourceHashRecord = [{ path: 'core/profile.ts', sha256: 'a'.repeat(64) }];
const catalogue: ReviewedCatalogue = { format: 1, revision: 'baseline.1', entries: [{ semanticId: 'personnel.profile.reopen', definition: guide, sources: ['core/profile.ts'], reviewedSourceHash: sourceContentDigest(sourceHashRecord), reviewNote: 'Reviewed canonical save and read journey.' }] };
function identity(record = sourceHashRecord) { return testingBuildReadiness({ sourceRef: 'a'.repeat(40), buildRecordId: id, catalogueHash: catalogueDigest(catalogue), contentHash: sourceContentDigest(record) }, { catalogueHash: catalogueDigest(catalogue), contentHash: sourceContentDigest(record) }); }
function preview(library: LibraryCaseSnapshot[] = []) { return previewTestingUpdates({ catalogue, identity: identity(), library, enabledModuleCodes: ['employees'], sourceHashRecord }); }
describe('immutable testing instruction and personal execution contracts', () => {
  it('requires a result for every ordered step and refuses unknown executable properties', () => {
    expect(parseInstruction(guide)).toEqual(guide);
    expect(() => parseInstruction({ ...guide, steps: [{ id: 'save', action: 'Save' }] })).toThrow();
    expect(() => parseInstruction({ ...guide, automaticallyPass: true })).toThrow();
    expect(() => parseInstruction({ ...guide, steps: [guide.steps[0], guide.steps[0]] })).toThrow();
  });
  it('preserves an honest current upgrade baseline without fabricating earlier step expectations', () => {
    const baseline = { format: 0, history: 'upgrade_baseline', title: 'Old guide', moduleCode: 'employees', precondition: null, steps: ['Old action'], testType: 'functional', priority: 'medium', expectedBehavior: null, expectedFunction: null };
    expect(parsePublishedInstruction(baseline)).toEqual(baseline);
    expect(() => parsePublishedInstruction({ ...baseline, history: 'original_run_instructions' })).toThrow();
  });
  it('requires stale-save pointers and an explanation of a failed or not applicable execution', () => {
    const input = { executionId: id, assignmentId: id, versionId: version, expectedRevision: 0, status: 'failed', actualResult: '', comments: '', defectNotes: '', improvementNotes: '' };
    expect(executionInputSchema.safeParse(input).success).toBe(false);
    expect(executionInputSchema.parse({ ...input, actualResult: 'Saving showed a refusal.' }).status).toBe('failed');
    expect(executionInputSchema.safeParse({ ...input, actualResult: 'Refused', testerUserId: id }).success).toBe(false);
    expect(legacyOutcomeFor('partial')).toBe('partial');
    expect(legacyOutcomeFor('retest_required')).toBe('not_tested');
  });
});
describe('verified build and reviewed update comparison', () => {
  it('fails closed for missing identity, catalogue mismatch and source-content mismatch; never asserts arrival', () => {
    expect(testingBuildReadiness({}, { catalogueHash: '', contentHash: '' }).status).toBe('review_required');
    expect(testingBuildReadiness({ sourceRef: 'a'.repeat(40), buildRecordId: id, catalogueHash: 'b'.repeat(64), contentHash: 'c'.repeat(64) }, { catalogueHash: 'd'.repeat(64), contentHash: 'c'.repeat(64) })).toEqual({ status: 'review_required', reason: 'catalogue_mismatch' });
    expect(identity()).toMatchObject({ status: 'verified_build_identity', activeServiceVerified: false });
  });
  it('has stable hashes for reordered object keys and refuses duplicate or escaping source paths', () => {
    expect(testingDigest({ b: 2, a: 1 })).toBe(testingDigest({ a: 1, b: 2 }));
    expect(() => sourceContentDigest([{ path: 'core/../secrets.ts', sha256: 'a'.repeat(64) }])).toThrow();
    expect(() => sourceContentDigest([{ path: 'core/profile.ts', sha256: 'a'.repeat(64) }, { path: 'core/profile.ts', sha256: 'a'.repeat(64) }])).toThrow();
  });
  it('deduplicates exact semantic content, detects local edits and binds confirmation to exact library snapshot', () => {
    const add = preview(); expect(add.entries[0].action).toBe('add');
    const row: LibraryCaseSnapshot = { caseId: id, caseNo: 17, versionId: version, versionHash: testingDigest(guide), semanticId: catalogue.entries[0].semanticId, origin: 'catalogue', acceptedCatalogueDefinitionHash: testingDigest(guide), acceptedGuideSourceHash: sourceContentDigest(sourceHashRecord), title: guide.title, hasLocalDraft: false, definition: guide };
    expect(preview([row]).entries[0].action).toBe('unchanged');
    const local = { ...guide, objective: 'Locally revised objective.' };
    expect(preview([{ ...row, versionHash: testingDigest(local), definition: local }]).entries[0]).toMatchObject({ action: 'conflict', reason: 'local_override' });
    expect(() => selectedTestingUpdateId(preview([row]), [row.semanticId!])).toThrow();
    expect(selectedTestingUpdateId(add, [catalogue.entries[0].semanticId])).toMatch(/^[a-f0-9]{64}$/);
    expect(add.previewHash).not.toBe(preview([row]).previewHash);
  });
  it('requires source review after code changes and creates retest work for explicitly reviewed source changes', () => {
    const current = preview();
    const row: LibraryCaseSnapshot = { caseId: id, caseNo: 17, versionId: version, versionHash: testingDigest(guide), semanticId: catalogue.entries[0].semanticId, origin: 'catalogue', acceptedCatalogueDefinitionHash: testingDigest(guide), acceptedGuideSourceHash: 'b'.repeat(64), title: guide.title, hasLocalDraft: false, definition: guide };
    expect(preview([row]).entries[0]).toMatchObject({ action: 'revise', reason: 'reviewed_source_changed' });
    const changedRecords = [{ path: 'core/profile.ts', sha256: 'c'.repeat(64) }];
    const changed = previewTestingUpdates({ catalogue, identity: identity(changedRecords), library: [row], enabledModuleCodes: ['employees'], sourceHashRecord: changedRecords });
    expect(changed.entries[0]).toMatchObject({ action: 'review_required', reason: 'unreviewed_source_change' });
    expect(() => selectedTestingUpdateId(changed, [catalogue.entries[0].semanticId])).toThrow();
    expect(preview([{ ...row, acceptedGuideSourceHash: sourceContentDigest(sourceHashRecord), hasLocalDraft: true }]).entries[0]).toMatchObject({ action: 'conflict', reason: 'local_override' });
    expect(current.entries[0].guideSourceHash).toBe(sourceContentDigest(sourceHashRecord));
  });
  it('does not turn missing build evidence into a selectable update or absent catalogue cases into removals', () => {
    const result = previewTestingUpdates({ catalogue, identity: { status: 'review_required', reason: 'missing_identity' }, library: [], enabledModuleCodes: ['employees'], sourceHashRecord });
    expect(result.entries[0].action).toBe('review_required');
    expect(() => selectedTestingUpdateId(result, [catalogue.entries[0].semanticId])).toThrow();
    expect(previewTestingUpdates({ catalogue: { ...catalogue, entries: [] }, identity: identity(), library: [], enabledModuleCodes: [], sourceHashRecord: [] }).entries).toEqual([]);
  });
});
