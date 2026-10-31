/** Client-safe instruction and personal execution contracts. No database, filesystem or authority. */
import { z } from 'zod';

export const TESTING_AREAS = ['personnel', 'payroll', 'attendance', 'leave', 'organization', 'system_settings', 'workflow_approvals', 'statutory_payment'] as const;
export const TESTING_CATEGORIES = ['functional', 'validation', 'workflow', 'permission', 'integration', 'regression', 'negative', 'ui'] as const;
export const TESTING_PRIORITIES = ['high', 'medium', 'low'] as const;
export const EXECUTION_STATUSES = ['not_started', 'in_progress', 'passed', 'failed', 'blocked', 'retest_required', 'not_applicable', 'partial'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const TESTING_LIMITS = { steps: 40, prerequisites: 24, testData: 24, sources: 32, cases: 1000, text: 8000, screenshotBytes: 10 * 1024 * 1024, screenshotsPerExecution: 10, previewSelections: 200, pageSize: 50, instructionBytes: 512 * 1024 } as const;
const text = z.string().trim().min(1).max(TESTING_LIMITS.text);
const short = z.string().trim().min(1).max(240);
export const testingSemanticId = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(160);
export const testingHash = z.string().regex(/^[a-f0-9]{64}$/);
export const testingSourceRef = z.string().regex(/^[a-f0-9]{40}$/);
export const testingUuid = z.string().uuid();
/** Persisted login IDs can predate RFC version/variant UUID generation (including the Demo admin).
 * Accept canonical PostgreSQL hex UUID syntax only at account boundaries; live tenant/login/assignment
 * checks remain authority. Generated Testing record and build IDs continue to use testingUuid. */
export const testingAccountId = z.guid();
/** Relative reviewed repository paths only; never a URL, a supplied filesystem target or a git ref. */
export const testingSourcePath = z.string().max(240).regex(/^(?:app|core|lib|packs|components)\/[A-Za-z0-9_./\[\]()-]+\.(?:ts|tsx|json)$/).refine(p => !p.split('/').some(s => s === '.' || s === '..' || s === ''));
export const instructionStepSchema = z.strictObject({ id: testingSemanticId, action: text, expected: text });
export const instructionDefinitionSchema = z.strictObject({
  format: z.literal(1), title: short, objective: text, functionKey: testingSemanticId,
  area: z.enum(TESTING_AREAS), moduleCode: testingSemanticId,
  category: z.enum(TESTING_CATEGORIES), priority: z.enum(TESTING_PRIORITIES), active: z.boolean(),
  prerequisites: z.array(text).max(TESTING_LIMITS.prerequisites),
  testData: z.array(text).max(TESTING_LIMITS.testData),
  steps: z.array(instructionStepSchema).min(1).max(TESTING_LIMITS.steps),
  expectedBehavior: text, expectedFunction: text,
  /** Human-visible real business authority needed; assignment never confers it. */
  permissions: z.array(short).min(1).max(16),
  /** Null explicitly means no country/configuration-specific assertion in this guide. */
  jurisdiction: short.nullable(), configuration: text.nullable(),
  screenKeys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(100)).min(1).max(24),
}).superRefine((d, ctx) => {
  if (new Set(d.steps.map(s => s.id)).size !== d.steps.length) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Step identifiers must be unique.' });
  if (new Set(d.screenKeys).size !== d.screenKeys.length) ctx.addIssue({ code: 'custom', path: ['screenKeys'], message: 'Screen identifiers must be unique.' });
});
export type InstructionDefinition = z.infer<typeof instructionDefinitionSchema>;
/** Drafts retain unfinished text and empty step/selection lists; publication still uses the full schema. */
export const instructionDraftSchema = instructionDefinitionSchema.safeExtend({
  title: z.string().max(240), objective: z.string().max(TESTING_LIMITS.text), functionKey: z.string().max(160), moduleCode: z.string().max(160),
  prerequisites: z.array(z.string().max(TESTING_LIMITS.text)).max(TESTING_LIMITS.prerequisites),
  testData: z.array(z.string().max(TESTING_LIMITS.text)).max(TESTING_LIMITS.testData),
  steps: z.array(z.strictObject({ id: testingSemanticId, action: z.string().max(TESTING_LIMITS.text), expected: z.string().max(TESTING_LIMITS.text) })).max(TESTING_LIMITS.steps),
  expectedBehavior: z.string().max(TESTING_LIMITS.text), expectedFunction: z.string().max(TESTING_LIMITS.text),
  permissions: z.array(z.string().max(240)).max(16), screenKeys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(100)).max(24),
});
export function parseInstructionDraft(raw: unknown): InstructionDefinition { const parsed=instructionDraftSchema.parse(raw); assertInstructionBytes(parsed); return parsed; }

/** Upgrade records what exists now; it does not assert what an earlier run was shown. */
export const legacyInstructionSchema = z.strictObject({
  format: z.literal(0), history: z.literal('upgrade_baseline'), title: short, moduleCode: short,
  precondition: z.string().max(TESTING_LIMITS.text).nullable(),
  steps: z.array(z.string().max(TESTING_LIMITS.text)).max(1000),
  testType: short, priority: short,
  expectedBehavior: z.string().max(TESTING_LIMITS.text).nullable(),
  expectedFunction: z.string().max(TESTING_LIMITS.text).nullable(),
});
export type PublishedInstruction = InstructionDefinition | z.infer<typeof legacyInstructionSchema>;
function assertInstructionBytes(value: InstructionDefinition) { if(new TextEncoder().encode(JSON.stringify(value)).byteLength>TESTING_LIMITS.instructionBytes)throw new TestingRefusal('limit'); }
export function parseInstruction(raw: unknown): InstructionDefinition { const parsed=instructionDefinitionSchema.parse(raw); assertInstructionBytes(parsed); return parsed; }
export function parsePublishedInstruction(raw: unknown): PublishedInstruction {
  return z.union([instructionDefinitionSchema, legacyInstructionSchema]).parse(raw);
}
export const executionInputSchema = z.strictObject({
  executionId: testingUuid, assignmentId: testingUuid, versionId: testingUuid,
  expectedRevision: z.number().int().min(0).max(2147483646),
  status: z.enum(EXECUTION_STATUSES), actualResult: z.string().max(16000),
  comments: z.string().max(16000), defectNotes: z.string().max(16000), improvementNotes: z.string().max(16000),
}).superRefine((d, ctx) => {
  if (['failed', 'blocked', 'partial', 'not_applicable'].includes(d.status) && !d.actualResult.trim()) ctx.addIssue({ code: 'custom', path: ['actualResult'], message: 'Explain the observed result or why this cannot be tested.' });
});
export type ExecutionInput = z.infer<typeof executionInputSchema>;
/** One compatibility mapping, preserving the original run vocabulary for old readers. */
export function legacyOutcomeFor(status: ExecutionStatus): 'pass' | 'fail' | 'blocked' | 'partial' | 'not_tested' {
  switch (status) {
    case 'passed': return 'pass'; case 'failed': return 'fail'; case 'blocked': return 'blocked';
    case 'partial': return 'partial'; default: return 'not_tested';
  }
}
export type TestingRefusalCode = 'not_assigned' | 'not_found' | 'inactive' | 'stale_execution' | 'stale_instructions' | 'stale_preview' | 'local_conflict' | 'review_required' | 'invalid' | 'limit';
export class TestingRefusal extends Error {
  constructor(readonly code: TestingRefusalCode) { super(code); this.name = 'TestingRefusal'; }
}
export const catalogueEntrySchema = z.strictObject({
  semanticId: testingSemanticId, definition: instructionDefinitionSchema,
  sources: z.array(testingSourcePath).min(1).max(TESTING_LIMITS.sources),
  reviewedSourceHash: testingHash,
  /** Why this reviewed instruction exists; not an automated claim of coverage/pass. */
  reviewNote: text,
});
export const catalogueSchema = z.strictObject({
  format: z.literal(1), revision: testingSemanticId,
  entries: z.array(catalogueEntrySchema).max(TESTING_LIMITS.cases),
}).superRefine((c, ctx) => {
  if (new Set(c.entries.map(e => e.semanticId)).size !== c.entries.length) ctx.addIssue({ code: 'custom', path: ['entries'], message: 'Catalogue semantic identifiers must be unique.' });
  for (const [i, entry] of c.entries.entries()) if (new Set(entry.sources).size !== entry.sources.length) ctx.addIssue({ code: 'custom', path: ['entries', i, 'sources'], message: 'Source paths must be unique.' });
});
export type ReviewedCatalogue = z.infer<typeof catalogueSchema>;
export const buildIdentitySchema = z.strictObject({ sourceRef: testingSourceRef, buildRecordId: testingUuid, catalogueHash: testingHash, contentHash: testingHash });
export type TestingBuildIdentity = z.infer<typeof buildIdentitySchema>;
export type TestingBuildReadiness = { status: 'review_required'; reason: 'missing_identity' | 'catalogue_mismatch' | 'content_mismatch' } | {
  status: 'verified_build_identity'; identity: TestingBuildIdentity;
  /** Compiled identity is not proof of service health, arrival parity or a tester pass. */
  activeServiceVerified: false;
};

export const sourceHashRecordSchema = z.array(z.strictObject({ path: testingSourcePath, sha256: testingHash })).max(32000).superRefine((rows, ctx) => {
  if (new Set(rows.map(r => r.path)).size !== rows.length) ctx.addIssue({ code: 'custom', message: 'Source paths must be unique.' });
});
export type TestingSourceHashRecord = z.infer<typeof sourceHashRecordSchema>;
