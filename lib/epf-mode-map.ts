/** EPF presentation categories map to explicit calculation modes. Manual percentage is distinct
 * from top-up elections. b6dbadc5 — Top-up (existing percentage election) now persists as the ADDITIVE
 * `topup_percentage` mode; an unconverted pre-b6dbadc5 two-rate `voluntary_excess` row is retained
 * unchanged when it is re-posted untouched (see `retainLegacyTotalTopup`). */
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
  | 'voluntary_percentage'
  | 'semi_auto'
  | 'manual_fixed'
  | 'manual_employee_amount'
  | 'manual_employer_amount'
  | 'manual_both_amount'
  | 'none';

/** Offered election categories and captions. Retired manual_fixed remains accepted only by the mapper. */
export const EPF_UI_MODE_OPTIONS = [
  {value:'auto',labelKey:'people.detail.epfModeAuto'},
  {value:'manual_percentage',labelKey:'people.detail.epfModeManualPercentage'},
  {value:'voluntary_percentage',labelKey:'people.detail.epfModeVoluntaryPercentage'},
  {value:'semi_auto',labelKey:'people.detail.epfModeSemiAuto'},
  {value:'manual_employee_amount',labelKey:'people.detail.epfModeManualEmployeeAmount'},
  {value:'manual_employer_amount',labelKey:'people.detail.epfModeManualEmployerAmount'},
  {value:'manual_both_amount',labelKey:'people.detail.epfModeManualBothAmount'},
  {value:'none',labelKey:'people.detail.epfModeExempt'},
] as const satisfies readonly {value:EpfUiMode;labelKey:string}[];

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
  if (v == null || String(v).trim() === '') return null;
  return Number(v) / 100;
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
      return { epfMode: 'manual_percentage', epfEmployeeRate: pct(rawEmployeeRate), epfEmployerRate: pct(rawEmployerRate), ...NO_AMOUNT };
    // b6dbadc5 — the two boxes are per-side INCREMENTS on top of the statutory rate (blank = nothing added),
    // persisted as their own mode. NOT voluntary_excess: Semi-Auto keeps that mode's total-rate meaning, and
    // sharing it would make the two categories indistinguishable on a stored row.
    case 'voluntary_percentage':
      return { epfMode: 'topup_percentage', epfEmployeeRate: pct(rawEmployeeRate), epfEmployerRate: pct(rawEmployerRate), ...NO_AMOUNT };
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

/** Recorded election category; shared unchanged with the Personnel election control. */
export function epfUiModeFrom(
  mode: string | null,
  employeeRate: number | null,
  employerRate: number | null,
  employeeAmount: number | null,
  employerAmount: number | null,
): EpfUiMode {
  if (mode === 'exempt') return 'none';
  if (mode === 'manual_percentage') return 'manual_percentage';
  if (mode === 'topup_percentage') return 'voluntary_percentage';
  if (mode === 'voluntary_excess') {
    // Semi-Auto = employee side elected, employer side left statutory (null).
    return employeeRate != null && employerRate == null ? 'semi_auto' : 'voluntary_percentage';
  }
  if (mode === 'manual_amount') {
    if (employeeAmount != null && employerAmount != null) return 'manual_both_amount';
    if (employeeAmount != null) return 'manual_employee_amount';
    if (employerAmount != null) return 'manual_employer_amount';
  }
  return 'auto';
}

/**
 * b6dbadc5 — a stored pre-additive Top-up: `voluntary_excess` with an employer rate, whose rates are TOTAL
 * rates applied as max(elected, statutory). Employee-only rows are Semi-Auto and are not legacy top-ups.
 * scripts/convert-epf-topup-percentage.ts converts these rows; until it has run they still exist.
 */
export function isLegacyTotalTopup(mode: string | null | undefined, employerRate: string | number | null | undefined): boolean {
  return mode === 'voluntary_excess' && employerRate != null && employerRate !== '';
}

const basisPoints = (v: string | number | null | undefined) => (v == null || v === '' ? null : Math.round(Number(v) * 10000));

/**
 * b6dbadc5 — the full-row writers (Personnel card, Bank & Statutory import, reviewed statutory action) re-post
 * the stored EPF election on every save. An unconverted legacy row reopens under Top-up showing its TOTAL
 * rates, so re-posting those same figures must not silently become an additive top-up of the same size
 * (11% total would turn into 11% on top of 11%). When the posted Top-up figures are exactly the stored
 * legacy figures, the stored election is kept as it is; any other figure is a new additive top-up.
 */
export function retainLegacyTotalTopup(
  mapped: EpfElectionFields,
  current: { epfMode?: string | null; epfEmployeeRate?: string | number | null; epfEmployerRate?: string | number | null } | null | undefined,
): EpfElectionFields {
  if (mapped.epfMode !== 'topup_percentage' || !current || !isLegacyTotalTopup(current.epfMode, current.epfEmployerRate)) return mapped;
  const same = basisPoints(mapped.epfEmployeeRate) === basisPoints(current.epfEmployeeRate)
    && basisPoints(mapped.epfEmployerRate) === basisPoints(current.epfEmployerRate);
  return same ? { ...mapped, epfMode: 'voluntary_excess' } : mapped;
}

/** Stored fractional EPF rate to the percent shown by the existing Personnel election controls. */
export function epfRateToPercent(value:string|number|null|undefined):number|null {
 if(value==null||value==='')return null;
 const amount=Number(value);if(!Number.isFinite(amount))return null;
 // Persisted rates have four decimal places. Project their integer basis points to two-decimal
 // percentage inputs without binary multiplication tails (0.1450 must display as 14.5). Leave
 // unsupported extra precision visible so native/server validation can refuse it, rather than round it.
 const basisPoints=amount*10000,integer=Math.round(basisPoints);
 return Number.isSafeInteger(integer)&&Math.abs(basisPoints-integer)<0.0000001?integer/100:amount*100;
}
