/**
 * EPF UI-category → lawful-enum mapping (ADR-0046 #2; extended by item 70b14723 / ADR-0087).
 *
 * The statutory card surfaces NAMED CATEGORIES; the `epf_mode` enum has four lawful shapes
 * (`auto | voluntary_excess | exempt | manual_amount`). This maps the UI selection down to the enum value
 * plus the figures to persist, at the server boundary — the client never decides the persisted enum. Rates
 * arrive as percentages (e.g. 11) and are converted to decimals (0.11); amounts arrive as ringgit and stay
 * ringgit. A null rate or a null amount keeps that side statutory.
 *
 * ⚠️ THE OLD CLAIM, RETIRED RATHER THAN DELETED (70b14723). This file used to say:
 *
 *     "Manual (by fixed amount) is DEFERRED (no KWSP fixed-amount election); the UI option is disabled and
 *      any stray submission is coerced defensively to `auto`."
 *
 * That was true of what KWSP's FORMS offer and was read as a statement about what a lawful contribution can
 * be, which it is not. The reversal, its evidence and the two objections it answers are in
 * docs/adr/0087-epf-manual-amount-categories.md; the short version is a member grandfathered on the
 * pre-1998 rates, whose lawful contribution is BELOW today's schedule and which nothing in this system can
 * compute. The deferral was made twice (ADR-0035 §4, ADR-0046) and the option was removed from the dropdown
 * under feedback 127dffba; this ticket was the third time it was asked for.
 *
 * ⚠️ THREE UI CATEGORIES, ONE ENUM LABEL. Manual (Employee by Amount), Manual (Employer by Amount) and
 * Manual (Employee and Employer by Amount) are exactly the three combinations of (employee amount set,
 * employer amount set) and are DERIVED when the screen renders — the same rule that makes a
 * `voluntary_excess` row with a null employer RATE "Semi-Auto" without storing the word. So no row can carry
 * a category that disagrees with its own figures, and `uiModeFrom` in components/epf-election.tsx is the one
 * place the derivation happens.
 *
 * WHY THE FUNCTION NULLS WHAT THE CATEGORY DOES NOT USE. `setStatutoryProfileMY` is a FULL-ROW OVERWRITE and
 * the statutory form mounts EVERY input on every save, so a field the chosen category does not use arrives
 * populated with whatever the previous category left in the box. Nulling here is what makes switching
 * category actually clear the old figures instead of leaving a stale amount for a future payroll run to
 * apply. `resolveEpfElection` (localization/my/epf-election.ts, called by `setStatutoryProfileMY`) then re-asserts the same nulling server-side
 * and is the only place that VALIDATES.
 */
// Rung 5b (ADR-0080 D1/D6): the lawful-enum vocabulary arrives via the contract, not the MY pack.
import type { EpfMode } from '../localization/country-pack';

/**
 * The UI categories. `manual_fixed` is RETIRED, not removed: it was the disabled "coming soon" option and a
 * draft or a stale browser tab can still post it, so it is tolerated and mapped to `auto` (see the switch).
 * The three named replacements are `manual_employee_amount`, `manual_employer_amount`, `manual_both_amount`.
 */
export type EpfUiMode =
  | 'auto'
  | 'manual_percentage'
  | 'semi_auto'
  | 'manual_fixed'
  | 'manual_employee_amount'
  | 'manual_employer_amount'
  | 'manual_both_amount'
  | 'none';

export type EpfElectionFields = {
  epfMode: EpfMode;
  epfEmployeeRate: number | null;
  epfEmployerRate: number | null;
  /** Item 70b14723 — the typed monthly figures in RM. Null on a side ⇒ that side keeps the rule. */
  epfEmployeeAmount: number | null;
  epfEmployerAmount: number | null;
  /** Item 70b14723 — the operator's words. Null for every non-manual category; MANDATORY for a manual one,
   *  which `resolveEpfElection` enforces (this mapper never throws — see the note on `num`). */
  epfManualReason: string | null;
};

/**
 * The three UI categories that REQUIRE a typed figure — item 70b14723.
 *
 * ⚠️ RETIRED CLAIM (r393, item 685d2380 step 3b), kept so the reversal is auditable. This note said the
 * predicate was exported because `completeEmployeeDraft` "runs after `hireEmployee` has committed … A draft
 * cannot carry the figure, so that path maps these to 'auto' BEFORE calling the mapper and says so.
 * `EpfCategoryField` (components/epf-election.tsx) does not offer them for the same reason." The draft now
 * carries the figures and the reason, and the pack's rule (`validateEpfElection`, a wrapper of
 * `resolveEpfElection` in localization/my/epf-election.ts) is asked BEFORE `hireEmployee`; the downgrade
 * and `EpfCategoryField` are gone. The predicate stays a true statement about the categories.
 */
export const EPF_UI_AMOUNT_MODES = ['manual_employee_amount', 'manual_employer_amount', 'manual_both_amount'] as const;

/** Does this UI category need a ringgit figure to be a lawful election at all? */
export function epfUiModeNeedsAmount(uiMode: string | null | undefined): boolean {
  return (EPF_UI_AMOUNT_MODES as readonly string[]).includes(String(uiMode ?? ''));
}

/** Convert a percentage form value (string|null) to a decimal rate, or null when absent/blank. */
function pct(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n / 100;
}

/**
 * A ringgit amount: blank/absent ⇒ null (that side keeps the rule). A NON-BLANK non-number is passed through
 * as `NaN` rather than silently becoming null, because those are different submissions and only one of them
 * is a decision: a blank box means "leave this side alone" and `abc` in the box means the save should be
 * refused. `resolveEpfElection` refuses a non-finite amount by name. This mapper stays TOTAL — it never
 * throws — so it is safe on the draft-activation path, which runs after the employee has been committed.
 */
function amt(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  return Number(v);
}

/** Trim a reason to null when it carries nothing. */
function reasonOf(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/** Map a UI category + raw inputs onto the lawful enum value and the figures to persist. */
export function mapEpfUiMode(
  uiMode: string | null | undefined,
  rawEmployeeRate: string | number | null | undefined,
  rawEmployerRate: string | number | null | undefined,
  rawEmployeeAmount?: string | number | null,
  rawEmployerAmount?: string | number | null,
  rawManualReason?: string | null,
): EpfElectionFields {
  const NO_AMOUNT = { epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null } as const;
  const NO_RATE = { epfEmployeeRate: null, epfEmployerRate: null } as const;
  switch (uiMode) {
    case 'manual_percentage':
      return { epfMode: 'voluntary_excess', epfEmployeeRate: pct(rawEmployeeRate), epfEmployerRate: pct(rawEmployerRate), ...NO_AMOUNT };
    case 'semi_auto':
      // Employee side elected; employer side forced statutory (null) — that's "semi-auto".
      return { epfMode: 'voluntary_excess', epfEmployeeRate: pct(rawEmployeeRate), epfEmployerRate: null, ...NO_AMOUNT };
    // ── Item 70b14723 — the three fixed-amount categories. Each keeps ONLY the sides it names, so a figure
    // left behind in a hidden box by a previous category cannot be persisted or applied.
    case 'manual_employee_amount':
      return { epfMode: 'manual_amount', ...NO_RATE, epfEmployeeAmount: amt(rawEmployeeAmount), epfEmployerAmount: null, epfManualReason: reasonOf(rawManualReason) };
    case 'manual_employer_amount':
      return { epfMode: 'manual_amount', ...NO_RATE, epfEmployeeAmount: null, epfEmployerAmount: amt(rawEmployerAmount), epfManualReason: reasonOf(rawManualReason) };
    case 'manual_both_amount':
      return { epfMode: 'manual_amount', ...NO_RATE, epfEmployeeAmount: amt(rawEmployeeAmount), epfEmployerAmount: amt(rawEmployerAmount), epfManualReason: reasonOf(rawManualReason) };
    case 'none':
      return { epfMode: 'exempt', ...NO_RATE, ...NO_AMOUNT };
    // 'manual_fixed' was the disabled "coming soon" option (ADR-0046, removed from the dropdown under
    // 127dffba). It is RETIRED, not deleted: a stale browser tab or an old draft can still post it, it names
    // no side and carries no figure, so it is coerced to `auto` exactly as it always was. The three named
    // categories above are what replaced it.
    case 'auto':
    case 'manual_fixed':
    default:
      return { epfMode: 'auto', ...NO_RATE, ...NO_AMOUNT };
  }
}
