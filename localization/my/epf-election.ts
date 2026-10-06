/**
 * THE EPF ELECTION RULE — a db-free LEAF of the MY pack (r393, item 685d2380 step 3b).
 *
 * `resolveEpfElection` was a private function of ./statutory.ts, which imports db/client and therefore
 * cannot reach a browser. It MOVED here unchanged in what it accepts and refuses (the only addition is the
 * `field` each refusal now carries), so that ONE rule can be asked three ways:
 *   - `setStatutoryProfileMY` (./statutory.ts) still calls it inside the full-row overwrite, exactly as before;
 *   - `validateEpfElection` below is the SERVER pack's pre-flight (`pack.statutory.validateEpfElection`):
 *     `completeEmployeeDraft` calls it BEFORE `hireEmployee`, so an election the setter would refuse is
 *     refused while nothing has been written, instead of failing an activation that already created the
 *     employee;
 *   - `epfElectionGap` below is the CLIENT pack's (`myClientPack.statutory.epfElectionGap`): the draft's
 *     still-needed list names the refused box on the Bank & Statutory tab.
 * Both wrappers call `resolveEpfElection` itself — neither restates a floor, a bound or a requirement.
 *
 * Imports: ./statutory-tables (pure data, no imports of its own), lib/epf-mode-map (pure) and a type.
 * Nothing here may import db, server-only code or anything 'use client' — see ./client.ts.
 */
import { DEFAULT_MY_STATUTORY } from './statutory-tables';
import type { EpfMode } from './payroll';
import { mapEpfUiMode, type EpfElectionFields } from '../../lib/epf-mode-map';

/** The field a refusal names. `epfAmount` = a manual category with no figure on either side. */
export type EpfElectionField =
  | 'epfEmployeeRate'
  | 'epfEmployerRate'
  | 'epfEmployeeAmount'
  | 'epfEmployerAmount'
  | 'epfAmount'
  | 'epfManualReason';

/** An i-Topup election tried to set a rate below the statutory Third Schedule floor, or out of range.
 *  r393 (685d2380 step 3b) — it now also says WHICH BOX: `field` is the draft/record field name of the
 *  value refused, so the Create New Employee draft can name it on the Bank & Statutory tab. `'epfAmount'`
 *  is a manual category with no figure on either side (which box to blame depends on the category, so
 *  `epfElectionGap` below decides). Optional, so a caller constructing one with a message alone still works. */
export class InvalidEpfElectionError extends Error {
  constructor(
    message: string,
    public readonly field?: EpfElectionField,
  ) {
    super(message);
    this.name = 'InvalidEpfElectionError';
  }
}

const EPF_EMPLOYEE_FLOOR = DEFAULT_MY_STATUTORY.epf.employeeRate; // 11%
// Lowest statutory employer rate (12% for wages > RM5,000); the calculator bumps ≤RM5,000 to 13%.
const EPF_EMPLOYER_FLOOR = Math.min(
  DEFAULT_MY_STATUTORY.epf.employerRateLow,
  DEFAULT_MY_STATUTORY.epf.employerRateHigh,
);

/** What `resolveEpfElection` persists: the lawful mode plus the four figures and the reason, every one of
 *  them nulled for a mode that does not use it. The setter is a FULL-ROW OVERWRITE, so "nulled" is the
 *  mechanism that makes changing category actually clear the previous category's figures rather than
 *  leaving them behind for a future reader to apply. */
export type ResolvedEpfElection = {
  epfMode: EpfMode;
  epfEmployeeRate: string | null;
  epfEmployerRate: string | null;
  epfEmployeeAmount: string | null;
  epfEmployerAmount: string | null;
  epfManualReason: string | null;
};

/**
 * Resolve + validate the per-side EPF election (Wave 2B; item 70b14723 adds 'manual_amount').
 *
 * RATES ('voluntary_excess'): i-Topup can only RAISE a rate, never lower it below statutory; rates
 * outside [floor, 1] are rejected. Rates are kept only for 'voluntary_excess'.
 *
 * ══ AMOUNTS ('manual_amount', item 70b14723) — WHAT IS REFUSED, AND THE ONE THING THAT IS NOT ══
 *
 * REFUSED: a manual category with NO amount on either side (it elects nothing — the row would compute
 * exactly as 'auto' while the screen said a person had decided it); a negative; a non-finite figure; and a
 * blank reason. The reason is mandatory for the same purpose it is mandatory on the per-run override
 * (`saveStatutoryAdjustment`): a figure that overrules a contribution schedule has to carry somebody's
 * words or an auditor is left with an unexplained number.
 *
 * ⚠️ NOT REFUSED: AN AMOUNT BELOW THE THIRD SCHEDULE. Decided, with evidence, and it is the one decision
 * in this function worth reading twice:
 *   · the product's own precedent on the IDENTICAL figure — `saveStatutoryAdjustment` (core/payroll.ts)
 *     lets an operator type any EPF employee/employer amount for a run and refuses only a NEGATIVE. A
 *     floor here and none there would be incoherent about the same money;
 *   · a lawful below-schedule case this system cannot compute at all, which its OWN sources document
 *     already flags as unhandled: "pre-1998 legacy (5.5% / 6-6.5%) is NOT auto-applied (rare - flag if any
 *     such grandfathered member exists)" (docs/architecture/STATUTORY-SOURCES.md §2). Those legacy figures
 *     are RATES and the rate election still cannot carry them, because `voluntary_excess` is
 *     max(elected, statutory) and can only RAISE. A typed amount is the only affordance, and a floor here
 *     would close it;
 *   · the ticket asked in so many words that the automatic calculation must not override the amount.
 * The consequence is real and it is the operator's: the KWSP submission file carries the employee's TRUE
 * wage in the Upah column and this amount in the contribution column, and if the two disagree with the
 * schedule the agency is the one who notices. We have not tested KWSP's own validation and do not guess.
 *
 * ⚠️ ONE-OF-TWO IS NOT AN ERROR EITHER, and the reason is the existing model rather than leniency. The
 * ticket's three categories ARE the three combinations of (employee amount set, employer amount set) —
 * nothing stores the category — so an employee amount with a blank employer amount IS "Manual (Employee by
 * Amount)", and the employer side keeping the schedule is exactly what a blank side means. It is the same
 * rule a `voluntary_excess` row with a null employer RATE already follows, and it is why no stored row can
 * carry a category that disagrees with its own figures. The visible amount boxes are `required` in the
 * form, so the browser asks before a side is left blank by accident.
 */
export function resolveEpfElection(p: {
  epfMode?: EpfMode;
  epfEmployeeRate?: number | null;
  epfEmployerRate?: number | null;
  epfEmployeeAmount?: number | null;
  epfEmployerAmount?: number | null;
  epfManualReason?: string | null;
}): ResolvedEpfElection {
  const mode: EpfMode =
    p.epfMode === 'voluntary_excess' || p.epfMode === 'exempt' || p.epfMode === 'manual_amount' ? p.epfMode : 'auto';
  const NO_AMOUNT = { epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null };
  if (mode === 'manual_amount') {
    const amount = (v: number | null | undefined, label: string, field: EpfElectionField): string | null => {
      if (v == null) return null; // null = that side keeps the rule ("a blank side stays statutory")
      const n = Number(v);
      if (!Number.isFinite(n))
        throw new InvalidEpfElectionError(`${label} EPF amount is not a number — enter a figure in ringgit or leave it blank.`, field);
      if (n < 0)
        throw new InvalidEpfElectionError(
          `${label} EPF amount ${n} cannot be negative. A KWSP Borang A upload file has no way to express a negative contribution.`,
          field,
        );
      return n.toFixed(2);
    };
    const employeeAmount = amount(p.epfEmployeeAmount, 'Employee', 'epfEmployeeAmount');
    const employerAmount = amount(p.epfEmployerAmount, 'Employer', 'epfEmployerAmount');
    if (employeeAmount == null && employerAmount == null)
      throw new InvalidEpfElectionError(
        'A manual EPF category needs an employee amount, an employer amount, or both. Enter the figure, or choose Auto to have it calculated.',
        'epfAmount',
      );
    const reason = (p.epfManualReason ?? '').trim();
    if (reason === '')
      throw new InvalidEpfElectionError('A reason is required for a manual EPF amount — say why this employee\'s EPF is a fixed figure.', 'epfManualReason');
    // Rates are nulled: a manual amount and an elected rate are two different elections and a row carrying
    // both would leave the next reader to guess which one payroll honoured.
    return { epfMode: mode, epfEmployeeRate: null, epfEmployerRate: null, epfEmployeeAmount: employeeAmount, epfEmployerAmount: employerAmount, epfManualReason: reason };
  }
  if (mode !== 'voluntary_excess') return { epfMode: mode, epfEmployeeRate: null, epfEmployerRate: null, ...NO_AMOUNT };
  const side = (rate: number | null | undefined, floor: number, label: string, field: EpfElectionField): string | null => {
    if (rate == null || Number.isNaN(Number(rate))) return null; // null = that side stays statutory
    const r = Number(rate);
    if (r < floor || r > 1)
      throw new InvalidEpfElectionError(
        `${label} EPF rate ${(r * 100).toFixed(2)}% must be at or above the statutory ${(floor * 100).toFixed(0)}% and at most 100% (i-Topup can only raise the rate).`,
        field,
      );
    return r.toFixed(4);
  };
  return {
    epfMode: mode,
    epfEmployeeRate: side(p.epfEmployeeRate, EPF_EMPLOYEE_FLOOR, 'Employee', 'epfEmployeeRate'),
    epfEmployerRate: side(p.epfEmployerRate, EPF_EMPLOYER_FLOOR, 'Employer', 'epfEmployerRate'),
    ...NO_AMOUNT,
  };
}

/**
 * r393 (685d2380 step 3b) — THE PRE-FLIGHT: would `setStatutoryProfileMY` accept this election? Returns
 * what it would persist, or throws the SAME `InvalidEpfElectionError` it would throw. It IS
 * `resolveEpfElection`; exported under this name on the server pack so core reaches it through
 * `requirePackFor(...)` rather than importing the MY module.
 */
export function validateEpfElection(p: EpfElectionFields): ResolvedEpfElection {
  return resolveEpfElection(p);
}

/** The draft field a gap is shown under — the Bank & Statutory tab's box names. */
export type EpfElectionGapField = Exclude<EpfElectionField, 'epfAmount'>;

/**
 * r393 (685d2380 step 3b) — THE SAME QUESTION ASKED OF RAW SCREEN VALUES, for the draft's still-needed list.
 *
 * Takes exactly what the Active statutory action hands `mapEpfUiMode` — the UI category and the raw box
 * strings (rates in PERCENT, amounts in RINGGIT, blank = that side statutory) — maps them through that SAME
 * mapper, and asks `resolveEpfElection`. Returns the box to name, or null when the election would be
 * accepted. A manual category with no figure at all names the box the category asks for first (the
 * employer box only for "Manual (Employer by Amount)", which has no employee box).
 */
export function epfElectionGap(
  uiMode: string | null | undefined,
  employeeRate: string | null | undefined,
  employerRate: string | null | undefined,
  employeeAmount: string | null | undefined,
  employerAmount: string | null | undefined,
  manualReason: string | null | undefined,
): EpfElectionGapField | null {
  try {
    resolveEpfElection(mapEpfUiMode(uiMode, employeeRate, employerRate, employeeAmount, employerAmount, manualReason));
    return null;
  } catch (e) {
    if (!(e instanceof InvalidEpfElectionError)) throw e;
    if (e.field === 'epfAmount' || e.field === undefined)
      return uiMode === 'manual_employer_amount' ? 'epfEmployerAmount' : 'epfEmployeeAmount';
    return e.field;
  }
}
