/**
 * Which Employee ID a new employee gets, and who decides — item bd271009.
 *
 * The numbering ENGINE already existed (core/employee-id-config.ts): an Employee ID Auto Running Number
 * Setup per company (or one global one), a hand-keyed code that bypasses it, a tenant-wide uniqueness
 * check, and a counter that only advances inside a successful hire. What did not exist was any way for HR
 * to SEE which of those two things was about to happen. This module is that decision, expressed once.
 *
 * IT IS PURE AND CLIENT-SAFE (no DB imports) for the same reason lib/employee-draft-schema.ts is: the
 * SAME answer has to drive three places that must never drift —
 *   - the radio pair and the required-ness of the Employee ID field, in the browser;
 *   - `missingByStep`, which decides whether the Profile step shows a tick;
 *   - `completeEmployeeDraft`, which is the only one of the three that is trusted.
 *
 * THE RULE IS RESOLVED, NEVER STORED. The user's radio PICK is remembered on the draft
 * (`profile.employeeIdMode`) so a resumed draft reopens where it was left, but the RULE it is judged
 * against is always re-read from the live setup at the moment of the decision. A stored rule would go
 * stale the instant an administrator edited the setup screen between the draft and the create — and the
 * failure would be silent, which is the worst kind.
 */

/** Auto Running Number, or Manual Key In. */
export type EmployeeIdMode = 'auto' | 'manual';

/**
 * The applicable Employee ID Auto Running Number Setup for ONE company, flattened to plain data.
 *
 * Flat and serialisable ON PURPOSE: a server component hands this straight to the client wizard, and
 * React refuses to serialise anything else across that boundary (test/server-client-boundary.test.ts —
 * a function prop is what killed a page in r123). No formatter, no translator, no config row.
 */
export type EmployeeIdRule = {
  /** True when an ACTIVE setup applies to this company (its own, or the tenant-wide global one). */
  hasConfig: boolean;
  /** Which scope answered — for the "this company's own rule" vs "the group rule" wording. */
  scope: 'company' | 'global' | null;
  prefix: string;
  suffix: string;
  numberLength: number;
  /** The number the NEXT successful create would issue. A preview, not a reservation. */
  nextNumber: number;
  /** prefix + zero-padded(nextNumber) + suffix. '' when nothing applies (or the format overflows). */
  sampleCode: string;
  /** The setup screen's "Allow manual override" switch — honoured here for the first time. */
  allowManualOverride: boolean;
};

export type EmployeeIdDecision = {
  /** What will actually happen. */
  mode: EmployeeIdMode;
  /** True when HR may pick; false when the rule took the choice away. */
  choosable: boolean;
  /**
   * Why the choice was taken away, so the caller can say WHICH message:
   *   - 'noConfig'         — no active setup for this company; the ID must be typed.
   *   - 'manualNotAllowed' — a setup exists and forbids hand-keying; the number is issued automatically.
   */
  forcedBecause: 'noConfig' | 'manualNotAllowed' | null;
  /** True when the Employee ID field must be filled in before the employee can be created. */
  codeRequired: boolean;
};

const isMode = (v: unknown): v is EmployeeIdMode => v === 'auto' || v === 'manual';

/**
 * Decide the mode for one company.
 *
 * `chosen` is the user's remembered radio pick and is deliberately ADVISORY — the live rule overrules it
 * in both directions, so a draft saved under one setup and resumed under another cannot smuggle a stale
 * decision past the server. `hasCode` is the tie-breaker for a draft written before this screen existed:
 * an ID already typed reads as Manual Key In, because that is plainly what the person meant.
 */
export function resolveEmployeeIdMode(
  rule: EmployeeIdRule | null | undefined,
  opts: { chosen?: string | null; hasCode?: boolean } = {},
): EmployeeIdDecision {
  // No setup at all. This is the one behaviour the reporter asked to CHANGE: today a blank ID here
  // silently falls through to the legacy house counter (EMP-####), which is where the unrecognised IDs
  // have been coming from. Now the ID is required and said so on screen.
  if (!rule || !rule.hasConfig) {
    return { mode: 'manual', choosable: false, forcedBecause: 'noConfig', codeRequired: true };
  }
  // A setup exists and its "Allow manual override" switch is off — the switch that has been stored and
  // displayed since 0261 and obeyed by nothing until now.
  if (!rule.allowManualOverride) {
    return { mode: 'auto', choosable: false, forcedBecause: 'manualNotAllowed', codeRequired: false };
  }
  const mode: EmployeeIdMode = isMode(opts.chosen) ? opts.chosen : opts.hasCode ? 'manual' : 'auto';
  return { mode, choosable: true, forcedBecause: null, codeRequired: mode === 'manual' };
}
