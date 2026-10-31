/**
 * Probation / contract / internship review — HR-decision progressive-disclosure field map (R4 Build #4).
 *
 * Pure, DB-free module (no imports from the DB client) so it is safe to import from the `'use client'`
 * decide form AND unit-testable in the Node test harness without DOM tooling. It ONLY describes which
 * inputs each decision branch renders — it does NOT change the advisory `decideReview` service contract.
 *
 * Advisory-v1 stays intact: the terminate reason + the extension reason both post as `hrComments`
 * (existing column); `extend` posts `extendToDate` (existing column, already validated in the service).
 * No end-date write-back, no termination — see core/employment-review.ts:5-7 and the approved plan.
 */

export type ReviewDecision = 'confirm' | 'extend' | 'terminate';

/** The three HR decisions, in the order the <select> renders them. */
export const REVIEW_DECISIONS: readonly ReviewDecision[] = ['confirm', 'extend', 'terminate'] as const;

/**
 * Advisory termination-reason classification options for the Terminate branch dropdown. These are the same
 * labels as the `termination_type` enum vocabulary (voluntary | involuntary | retired | contract_end |
 * death | other) but here they are ADVISORY TEXT ONLY — the value posts as `hrComments`, NOT as
 * `employment.termination_type` (this UI never calls the real termination path).
 */
export const TERMINATION_REASONS = [
  'contract_end',
  'involuntary',
  'voluntary',
  'retired',
  'death',
  'other',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/** The optional/required input fields a given decision branch reveals. Confirm reveals none. */
export type DecisionField = 'extendToDate' | 'extensionReason' | 'terminationReason';

/**
 * The single source of truth for progressive disclosure: which fields the given decision reveals.
 * Confirm → none (single-step submit). Extend → New End Date (required) + Extension Reason (optional).
 * Terminate → Termination Reason dropdown (required). Any field NOT listed here must be absent from the
 * DOM for that branch (omit, don't hide) so a stale value never POSTs.
 */
export function fieldsForDecision(decision: ReviewDecision): DecisionField[] {
  switch (decision) {
    case 'confirm':
      return [];
    case 'extend':
      return ['extendToDate', 'extensionReason'];
    case 'terminate':
      return ['terminationReason'];
  }
}

/** Whether a given field is required (client-side `required`) within the branch that reveals it. */
export function isFieldRequired(field: DecisionField): boolean {
  // Extension reason is optional; the New End Date and the Termination Reason are required.
  return field !== 'extensionReason';
}
