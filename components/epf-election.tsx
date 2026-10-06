'use client';

import { useState, type ChangeEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

// Inlined from components/ui (server module) so this stays a clean client island.
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * EPF election (ADR-0035 §4, ADR-0046 #2, ADR-0087) — "EPF Category" on screen. The consultant's named
 * categories are surfaced as UI options, each mapped at the server boundary onto a lawful `epf_mode`:
 *   • Auto                                    → auto             (statutory Third Schedule banding; no rates)
 *   • Manual (By Percentage)                  → voluntary_excess  (employee% + employer% elected, each ≥ statutory)
 *   • Semi-Auto                               → voluntary_excess  (employee% elected; employer stays statutory — null)
 *   • Manual (Employee by Amount)             → manual_amount     (employee RM typed; employer computed)
 *   • Manual (Employer by Amount)             → manual_amount     (employer RM typed; employee computed)
 *   • Manual (Employee and Employer by Amount)→ manual_amount     (both RM typed)
 *   • No Contribution                         → exempt            (zeroes both sides; exempt employees only)
 * The rate inputs show only for the percentage paths and the amount inputs only for the fixed-amount ones;
 * the server (actions.ts → `mapEpfUiMode`) maps the UI value down to the enum and NULLS whatever the chosen
 * category does not use, because the form is a full-row overwrite with every input mounted.
 *
 * ⚠️ THE OLD CLAIM THIS FILE CARRIED, RETIRED RATHER THAN DELETED (item 70b14723). Three sentences here said
 * the fixed-amount election did not exist:
 *
 *     "• Manual (By Fixed Amount) → DEFERRED (no KWSP fixed-amount election; ADR-0046 §'deferred')"
 *     "KWSP has no below-statutory or fixed-amount election."
 *     "manual_fixed (deferred per ADR-0046 — no KWSP fixed-amount election)"
 *
 * The first half of the last sentence still stands: KWSP recognises no below-statutory election, and
 * `voluntary_excess` still cannot go below the Third Schedule. The FIXED-AMOUNT half does not — it described
 * what KWSP's forms offer and was read as a statement about what a lawful contribution can be. The reversal
 * and its evidence are in docs/adr/0087-epf-manual-amount-categories.md; the short version is a member
 * grandfathered on the pre-1998 rates, whose lawful contribution is below today's schedule and which nothing
 * in this system can compute. A fixed amount CAN therefore go below the schedule, deliberately, and it is
 * the only EPF category that can.
 *
 * THREE CATEGORIES, ONE ENUM LABEL, DERIVED ON RENDER. `uiModeFrom` below reads the stored amounts back into
 * the right category name — the same way it already reads a `voluntary_excess` row with a null employer rate
 * back as Semi-Auto. Nothing stores the category, so no row can carry one that disagrees with its figures.
 */
type UiMode =
  | 'auto'
  | 'manual_percentage'
  | 'semi_auto'
  | 'manual_fixed'
  | 'manual_employee_amount'
  | 'manual_employer_amount'
  | 'manual_both_amount'
  | 'none';

/** The three fixed-amount categories, and which side each one asks for. */
const AMOUNT_MODES = {
  manual_employee_amount: { employee: true, employer: false },
  manual_employer_amount: { employee: false, employer: true },
  manual_both_amount: { employee: true, employer: true },
} as const;
const isAmountMode = (m: UiMode): m is keyof typeof AMOUNT_MODES => m in AMOUNT_MODES;

/**
 * ITEM a72610af — A CONTROLLED BRANCH, so the Create New Employee draft asks the same question.
 *
 * ⚠️ RETIRED, NOT DELETED (r393, item 685d2380 step 3b). This used to be `EpfCategoryField`, the CATEGORY
 * SELECT ALONE with FOUR names, and its header said:
 *
 *     "THE TWO ELECTED RATES ARE NOT OFFERED ON A DRAFT, and that is a deliberate narrowing rather than an
 *      omission. `resolveEpfElection` … REFUSES a rate below the statutory floor, and it runs inside
 *      `pack.statutory.set`, which `completeEmployeeDraft` can only reach after `hireEmployee` has
 *      committed … Judging it on the tab instead would need the floors in the browser, and they are derived
 *      from the MY pack's statutory tables, a server module the shared draft schema may not import."
 *
 * and, of the three fixed-amount categories, that offering them without the figure "would either fail an
 * activation that had already created the employee, or force a silent downgrade to Auto". Both were true
 * while the rule had no other home. `resolveEpfElection` now lives in a db-free leaf of the MY pack
 * (localization/my/epf-election.ts): the draft's tab names a refused box through the CLIENT pack's
 * `epfElectionGap`, and `completeEmployeeDraft` asks the SERVER pack's `validateEpfElection` BEFORE
 * `hireEmployee`. So the draft now gets the WHOLE election — all seven categories and the same rate and
 * amount boxes — through `EpfElectionControlled` below, which is this card's own markup bound to the
 * draft's state instead of to a form. The `epfManualDraftHint` message is retired with it (kept, unused).
 */
/**
 * Derive the UI selection from the persisted enum + the figures (the category is NOT stored).
 *
 * 70b14723 — `manual_amount` fans back out into the three named categories by asking which amounts are set,
 * which is the same derivation that has always read a `voluntary_excess` row with a null employer rate back
 * as Semi-Auto. A `manual_amount` row with NO amount cannot be saved (`resolveEpfElection` refuses it), so
 * the final fall-through is defence against a hand-edited row, not a reachable state.
 */
function uiModeFrom(
  mode: string | null,
  employeeRate: number | null,
  employerRate: number | null,
  employeeAmount: number | null,
  employerAmount: number | null,
): UiMode {
  if (mode === 'exempt') return 'none';
  if (mode === 'voluntary_excess') {
    // Semi-Auto = employee side elected, employer side left statutory (null).
    return employeeRate != null && employerRate == null ? 'semi_auto' : 'manual_percentage';
  }
  if (mode === 'manual_amount') {
    if (employeeAmount != null && employerAmount != null) return 'manual_both_amount';
    if (employeeAmount != null) return 'manual_employee_amount';
    if (employerAmount != null) return 'manual_employer_amount';
  }
  return 'auto';
}

export function EpfElection({
  mode,
  employeeRate,
  employerRate,
  employeeAmount,
  employerAmount,
  manualReason,
}: {
  mode: string | null;
  employeeRate: number | null; // already in percent (e.g. 11), or null
  employerRate: number | null;
  /** 70b14723 — the stored monthly figures in RINGGIT (not percent), or null. */
  employeeAmount: number | null;
  employerAmount: number | null;
  manualReason: string | null;
}) {
  const [m, setM] = useState<UiMode>(uiModeFrom(mode, employeeRate, employerRate, employeeAmount, employerAmount));
  return (
    <EpfElectionBody
      m={m}
      onMode={setM}
      bind={(field) => {
        const stored = {
          epfEmployeeRate: employeeRate,
          epfEmployerRate: employerRate,
          epfEmployeeAmount: employeeAmount,
          epfEmployerAmount: employerAmount,
          epfManualReason: manualReason,
        }[field];
        return { name: { name: field }, value: { defaultValue: stored ?? '' } };
      }}
      selectName={{ name: 'epfMode' }}
    />
  );
}

/** The draft's EPF keys — the raw box strings (rates in PERCENT, amounts in RINGGIT), never numbers. */
export type EpfElectionDraftValue = {
  epfMode?: string;
  epfEmployeeRate?: string;
  epfEmployerRate?: string;
  epfEmployeeAmount?: string;
  epfEmployerAmount?: string;
  epfManualReason?: string;
};
type EpfBoxField = Exclude<keyof EpfElectionDraftValue, 'epfMode'>;

/**
 * r393 (685d2380 step 3b) — THE SAME ELECTION, CONTROLLED: the Create New Employee draft's Bank &
 * Statutory tab. Identical markup to `EpfElection` above (one body renders both), but every input is bound
 * to the draft's state and carries NO `name`, so nothing posts by itself. The category is the stored UI
 * value (a draft has no lawful enum to derive it from); an unknown or blank one shows as Auto, which is
 * what `mapEpfUiMode` makes of it at Activate. Values travel as the strings typed: a cleared box is '' and
 * stays '' — the server reads blank as "this side stays statutory", never as 0.
 */
export function EpfElectionControlled({
  value,
  onChange,
}: {
  value: EpfElectionDraftValue;
  onChange: (patch: EpfElectionDraftValue) => void;
}) {
  const m: UiMode = ALL_UI_MODES.includes((value.epfMode ?? '') as UiMode) ? (value.epfMode as UiMode) : 'auto';
  return (
    <EpfElectionBody
      m={m}
      onMode={(next) => onChange({ epfMode: next })}
      bind={(field) => ({
        name: {},
        value: {
          value: value[field] ?? '',
          onChange: (e: ChangeEvent<HTMLInputElement>) => onChange({ [field]: e.target.value }),
        },
      })}
      selectName={{}}
    />
  );
}

/** Every category either branch can show. `manual_fixed` is retired (lib/epf-mode-map.ts) and not offered. */
const ALL_UI_MODES: readonly UiMode[] = [
  'auto',
  'manual_percentage',
  'semi_auto',
  'manual_employee_amount',
  'manual_employer_amount',
  'manual_both_amount',
  'none',
];

/**
 * The one body both branches render. `bind(field)` returns the input's NAME props and its VALUE props
 * separately, spread where `name` and `defaultValue` always sat, so the form branch's markup is the
 * pre-r393 markup attribute for attribute (test/r393-draft-statutory.dom.test.tsx pins it).
 */
function EpfElectionBody({
  m,
  onMode,
  bind,
  selectName,
}: {
  m: UiMode;
  onMode: (m: UiMode) => void;
  bind: (field: EpfBoxField) => {
    name: { name?: string };
    value: { defaultValue?: string | number; value?: string; onChange?: (e: ChangeEvent<HTMLInputElement>) => void };
  };
  selectName: { name?: string };
}) {
  const t = useTranslations('people.detail');
  const showEmployeeRate = m === 'manual_percentage' || m === 'semi_auto';
  const showEmployerRate = m === 'manual_percentage';
  const amounts = isAmountMode(m) ? AMOUNT_MODES[m] : null;
  const er = bind('epfEmployeeRate');
  const rr = bind('epfEmployerRate');
  const ea = bind('epfEmployeeAmount');
  const ra = bind('epfEmployerAmount');
  const mr = bind('epfManualReason');
  return (
    <>
      <Field label={t('epfMode')}>
        <select {...selectName} value={m} onChange={(e) => onMode(e.target.value as UiMode)} className={inputCls}>
          <option value="auto">{t('epfModeAuto')}</option>
          <option value="manual_percentage">{t('epfModeManualPercentage')}</option>
          <option value="semi_auto">{t('epfModeSemiAuto')}</option>
          {/* Item 70b14723 — the three fixed-amount categories, named exactly as the ticket asked. They
              replace the disabled `manual_fixed` "coming soon" option that feedback 127dffba removed; that
              value is retired rather than deleted in `mapEpfUiMode` because a stale tab can still post it. */}
          <option value="manual_employee_amount">{t('epfModeManualEmployeeAmount')}</option>
          <option value="manual_employer_amount">{t('epfModeManualEmployerAmount')}</option>
          <option value="manual_both_amount">{t('epfModeManualBothAmount')}</option>
          <option value="none">{t('epfModeExempt')}</option>
        </select>
      </Field>
      {(showEmployeeRate || showEmployerRate) && (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          {showEmployeeRate && (
            <Field label={t('epfEmployeeRate')}>
              <input {...er.name} type="number" min="11" max="100" step="0.01" {...er.value} placeholder="11" className={inputCls} />
            </Field>
          )}
          {showEmployerRate && (
            <Field label={t('epfEmployerRate')}>
              <input {...rr.name} type="number" min="12" max="100" step="0.01" {...rr.value} placeholder="13" className={inputCls} />
            </Field>
          )}
          {m === 'semi_auto' ? (
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('epfSemiAutoHint')}</p>
          ) : (
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('epfVoluntaryHint')}</p>
          )}
        </div>
      )}
      {/* ── ITEM 70b14723 — THE RINGGIT BOXES, AND ONLY THE ONES THE CATEGORY NAMES ──────────────────────
          Conditional exactly as the rate boxes are, for the same reason: this form is a FULL-ROW OVERWRITE
          with everything mounted, so what is not rendered is not posted and `mapEpfUiMode` nulls the rest.
          `required` on the visible boxes is where a blank side is caught first — the server refuses a manual
          category with NO figure at all, and a one-of-two blank is a lawful election (that side keeps the
          schedule), so the browser is the right place to ask before it happens by accident.
          NO `min` FLOOR BEYOND ZERO, and that is deliberate rather than forgotten: an amount below the Third
          Schedule is allowed, recorded and warned about in words (ADR-0087). `min="0"` refuses a NEGATIVE,
          which is refused again server-side — `lib/kwsp-borang-a-file.ts` only throws on one when the KWSP
          upload file is being written, which is far too late to tell anybody. */}
      {amounts && (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          {amounts.employee && (
            <Field label={t('epfEmployeeAmount')}>
              <input {...ea.name} type="number" min="0" step="0.01" required {...ea.value} placeholder="0.00" className={inputCls} />
            </Field>
          )}
          {amounts.employer && (
            <Field label={t('epfEmployerAmount')}>
              <input {...ra.name} type="number" min="0" step="0.01" required {...ra.value} placeholder="0.00" className={inputCls} />
            </Field>
          )}
          {/* MANDATORY, like the per-run Statutory Adjustment's reason and for the same purpose: a figure that
              overrules a contribution schedule has to carry somebody's words or an auditor is left with an
              unexplained number. It reaches the payslip stamp and the Statutory Detail screen's banner. */}
          <Field label={t('epfManualReason')}>
            <input {...mr.name} type="text" maxLength={500} required {...mr.value} className={inputCls} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('epfManualAmountHint')}</p>
        </div>
      )}
    </>
  );
}
