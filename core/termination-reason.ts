/**
 * ae9350f2 — "Movement Type: Termination". The BUILT-IN termination reason catalogue.
 *
 * The reporter supplied the master list themselves, split into Voluntary and Involuntary exits. This module
 * is that list, and it is deliberately a TypeScript constant rather than a table:
 *
 *  • `476f23ed` (PLANNED, not approved) makes movement event types configurable and its catalogue will need
 *    Termination as a member. Building a second, termination-only configuration table now would be the thing
 *    that item then has to unpick. So Termination ships as a proper BUILT-IN kind with a built-in reason
 *    list; when 476f23ed lands it references this set rather than replacing it.
 *  • It is NOT a Postgres enum either. A new enum value cannot be used in the same transaction that added it
 *    (a trap this repo has hit), and an exit reason is exactly the kind of list that grows. The column
 *    `employment.termination_reason_code` is plain `text` (migration 0338) with the validity rule enforced
 *    here, in one place, on the write path.
 *
 * ── THE RELATIONSHIP WITH `employment.termination_type` ────────────────────────────────────────────────
 * `termination_type` (the `termination_type` ENUM: voluntary / involuntary / retired / contract_end / death
 * / other) already exists and already powers the Terminations + Turnover analytics (Wave 4A/4B). The
 * reporter's request adds a FINER field beside it, not a replacement — "Redundancy" and "Misconduct" are
 * both `involuntary` for turnover reporting but are very different things for payroll and legal tracking.
 *
 * So the reason is the ONE thing HR picks and the classification is DERIVED from it. That is the whole
 * reason `type` sits on each row below. Two pickers whose values can contradict each other (a Misconduct
 * exit classified `voluntary`) is a data-quality fault waiting to happen, and there is no honest way for a
 * reader to tell which of the two was meant. `death` and `other` are carried as reason codes precisely so
 * that every value the existing enum can express is still reachable through the single control.
 */
import type { TerminationType } from './org';

/** The two groups the reporter asked for, plus `other` for the two codes that belong to neither. */
export const TERMINATION_REASON_CATEGORIES = ['voluntary', 'involuntary', 'other'] as const;
export type TerminationReasonCategory = (typeof TERMINATION_REASON_CATEGORIES)[number];

export type TerminationReasonDef = {
  code: string;
  category: TerminationReasonCategory;
  /** The turnover classification this reason resolves to — written to `employment.termination_type`. */
  type: TerminationType;
};

/**
 * The catalogue, in display order. The eleven codes above `death` are the reporter's list verbatim;
 * `death` and `other` complete the mapping onto the existing enum (see the header).
 */
export const TERMINATION_REASONS: readonly TerminationReasonDef[] = [
  // Voluntary Termination
  { code: 'resignation', category: 'voluntary', type: 'voluntary' },
  { code: 'career_opportunity', category: 'voluntary', type: 'voluntary' },
  { code: 'personal_reason', category: 'voluntary', type: 'voluntary' },
  { code: 'retirement', category: 'voluntary', type: 'retired' },
  { code: 'early_retirement', category: 'voluntary', type: 'retired' },
  // Involuntary Termination
  { code: 'performance_issue', category: 'involuntary', type: 'involuntary' },
  { code: 'misconduct', category: 'involuntary', type: 'involuntary' },
  { code: 'redundancy', category: 'involuntary', type: 'involuntary' },
  { code: 'contract_expiry', category: 'involuntary', type: 'contract_end' },
  { code: 'absconded', category: 'involuntary', type: 'involuntary' },
  { code: 'medical_unfit', category: 'involuntary', type: 'involuntary' },
  // Neither — kept so every value of the termination_type enum stays reachable from the single picker.
  { code: 'death', category: 'other', type: 'death' },
  { code: 'other', category: 'other', type: 'other' },
] as const;

export type TerminationReasonCode = (typeof TERMINATION_REASONS)[number]['code'];

export const TERMINATION_REASON_CODES: readonly string[] = TERMINATION_REASONS.map((r) => r.code);

export function isTerminationReasonCode(v: unknown): v is TerminationReasonCode {
  return typeof v === 'string' && TERMINATION_REASON_CODES.includes(v);
}

export function terminationReasonOf(code: string | null | undefined): TerminationReasonDef | null {
  if (!code) return null;
  return TERMINATION_REASONS.find((r) => r.code === code) ?? null;
}

/**
 * The turnover classification a reason resolves to, or null when the reason is unknown/absent. Callers
 * fall back to whatever `terminationType` was passed explicitly, which is what keeps every pre-ae9350f2
 * caller (the resignation-approval path, imports, seeds, the Wave 4A tests) working unchanged.
 */
export function terminationTypeForReason(code: string | null | undefined): TerminationType | null {
  return terminationReasonOf(code)?.type ?? null;
}

/** The catalogue grouped for a picker with one optgroup per category, in category order. */
export function terminationReasonsByCategory(): { category: TerminationReasonCategory; reasons: TerminationReasonDef[] }[] {
  return TERMINATION_REASON_CATEGORIES.map((category) => ({
    category,
    reasons: TERMINATION_REASONS.filter((r) => r.category === category),
  }));
}
