'use client';

import { useState, useRef, type ChangeEvent, type InvalidEvent, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { PersonnelField } from '@/components/personnel-field';
import { personnelInput, personnelControl, personnelFormChoices } from '@/lib/personnel-form-contract';
import {epfUiModeFrom as uiModeFrom} from '@/lib/epf-mode-map';
import { clientPackFor } from '@/localization/registry.client';
import { EPF_UI_MODE_OPTIONS } from '@/lib/epf-mode-map';

// Inlined from components/ui (server module) so this stays a clean client island.
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

/** Existing elections retain their stored calculation mode. Manual percentage is explicit,
 * requires both rates and does not inherit the legacy top-up floor. b6dbadc5 — Top-up takes per-side
 * INCREMENTS added to the normal EPF rate, under its own "Top-up … Rate %" captions. */
type UiMode =
  | 'auto'
  | 'manual_percentage'
  | 'voluntary_percentage'
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
      legacyPercentage={mode === 'voluntary_excess' && employerRate != null}
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
        return { value: { defaultValue: stored ?? '' } };
      }}
      formMode="edit"
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
        value: {
          value: value[field] ?? '',
          onChange: (e: ChangeEvent<HTMLInputElement>) => onChange({ [field]: e.target.value }),
        },
      })}
      formMode="draft"
    />
  );
}

/** Every category either branch can show. `manual_fixed` is retired (lib/epf-mode-map.ts) and not offered. */
const ALL_UI_MODES: readonly UiMode[] = EPF_UI_MODE_OPTIONS.map(option=>option.value);

/**
 * The one body both branches render. `bind(field)` returns the input's NAME props and its VALUE props
 * separately, spread where `name` and `defaultValue` always sat, so the form branch's markup is the
 * pre-r393 markup attribute for attribute (test/r393-draft-statutory.dom.test.tsx pins it).
 */
function EpfElectionBody({
  m,
  onMode,
  bind,
  formMode,
  legacyPercentage = false,
}: {
  m: UiMode;
  onMode: (m: UiMode) => void;
  bind: (field: EpfBoxField) => {
    value: { defaultValue?: string | number; value?: string; onChange?: (e: ChangeEvent<HTMLInputElement>) => void };
  };
  formMode:'edit'|'draft';
  legacyPercentage?:boolean;
}) {
  const t = useTranslations('people.detail');
  const showEmployeeRate = m === 'manual_percentage' || m === 'voluntary_percentage' || m === 'semi_auto';
  const showEmployerRate = m === 'manual_percentage' || m === 'voluntary_percentage';
  const manualPercentage = m === 'manual_percentage';
  const topup = m === 'voluntary_percentage';
  // b6dbadc5 — an unconverted pre-additive row shows its stored TOTAL rates until something is changed.
  const legacyTotal = topup && legacyPercentage;
  const employeeRef = useRef<HTMLInputElement>(null), employerRef = useRef<HTMLInputElement>(null);
  const bounds = clientPackFor('MY')?.statutory.epfRateInputBounds;
  const [errors, setErrors] = useState<Partial<Record<'employee' | 'employer', string>>>({});
  const invalidRate = (side: 'employee' | 'employer') => (event: InvalidEvent<HTMLInputElement>) => {
    if (!manualPercentage && !(topup && !legacyTotal)) return;
    const message = topup
      ? t('epfTopupRateRange', {max: bounds?.(m, side).max ?? 100})
      : t(event.currentTarget.validity.valueMissing ? (side === 'employee' ? 'epfManualEmployeeRateRequired' : 'epfManualEmployerRateRequired') : 'epfManualRateRange');
    event.currentTarget.setCustomValidity(message);
    setErrors(previous => ({...previous, [side]:message}));
  };
  const clearRate = (side: 'employee' | 'employer') => (event: FormEvent<HTMLInputElement>) => {
    event.currentTarget.setCustomValidity('');
    setErrors(previous => ({...previous, [side]:undefined}));
  };
  const amounts = isAmountMode(m) ? AMOUNT_MODES[m] : null;
  const er = bind('epfEmployeeRate');
  const rr = bind('epfEmployerRate');
  const ea = bind('epfEmployeeAmount');
  const ra = bind('epfEmployerAmount');
  const mr = bind('epfManualReason');
  return (
    <>
      <PersonnelField fieldId="bank_statutory.epf_contribution.epfuimode" mode={formMode}>
        <select {...personnelControl('bank_statutory.epf_contribution.epfuimode',formMode)} value={m} onChange={(e) => { employeeRef.current?.setCustomValidity(''); employerRef.current?.setCustomValidity(''); setErrors({}); onMode(e.target.value as UiMode); }} className={inputCls}>
          {personnelFormChoices('bank_statutory.epf_contribution.epfuimode').map(choice=><option key={choice.value} value={choice.value}>{t(choice.labelKey.slice(14))}</option>)}
        </select>
      </PersonnelField>
      {(showEmployeeRate || showEmployerRate) && (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          {showEmployeeRate && (
            <PersonnelField fieldId="bank_statutory.epf_contribution.epfemployeerate" mode={formMode} context={{epfManualPercentage:manualPercentage}} labelKey={topup ? 'people.detail.epfTopupEmployeeRate' : undefined}>
              <input {...personnelInput('bank_statutory.epf_contribution.epfemployeerate',formMode,{epfManualPercentage:manualPercentage})} {...er.value} ref={employeeRef} {...bounds?.(m, 'employee', legacyTotal)} aria-invalid={!!errors.employee} onInvalid={invalidRate('employee')} onInput={clearRate('employee')} placeholder={topup ? '0' : '11'} className={inputCls} />
              {errors.employee && <span role="alert" className="text-xs text-destructive">{errors.employee}</span>}
            </PersonnelField>
          )}
          {showEmployerRate && (
            <PersonnelField fieldId="bank_statutory.epf_contribution.epfemployerrate" mode={formMode} context={{epfManualPercentage:manualPercentage}} labelKey={topup ? 'people.detail.epfTopupEmployerRate' : undefined}>
              <input {...personnelInput('bank_statutory.epf_contribution.epfemployerrate',formMode,{epfManualPercentage:manualPercentage})} {...rr.value} ref={employerRef} {...bounds?.(m, 'employer', legacyTotal)} aria-invalid={!!errors.employer} onInvalid={invalidRate('employer')} onInput={clearRate('employer')} placeholder={topup ? '0' : '13'} className={inputCls} />
              {errors.employer && <span role="alert" className="text-xs text-destructive">{errors.employer}</span>}
            </PersonnelField>
          )}
          {m === 'semi_auto' ? (
            <p className="col-span-2 text-xs text-muted-foreground">{t('epfSemiAutoHint')}</p>
          ) : (
            <p className="col-span-2 text-xs text-muted-foreground">{t(manualPercentage ? 'epfManualPercentageHint' : legacyTotal ? 'epfTopupLegacyHint' : 'epfVoluntaryHint')}</p>
          )}
        </div>
      )}
      {/* b6dbadc5 — the Manual (by percentage) adoption message and its confirmation tick box were removed at
          the reporter's request (reversing the 5e204d56 clause; ADR-0158, b6dbadc5 addendum): choosing the category, entering
          both rates and saving is the whole decision. */}
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
            <PersonnelField fieldId="bank_statutory.epf_contribution.epfemployeeamount" mode={formMode}>
              <input {...personnelInput('bank_statutory.epf_contribution.epfemployeeamount',formMode)} {...ea.value} placeholder="0.00" className={inputCls} />
            </PersonnelField>
          )}
          {amounts.employer && (
            <PersonnelField fieldId="bank_statutory.epf_contribution.epfemployeramount" mode={formMode}>
              <input {...personnelInput('bank_statutory.epf_contribution.epfemployeramount',formMode)} {...ra.value} placeholder="0.00" className={inputCls} />
            </PersonnelField>
          )}
          {/* MANDATORY, like the per-run Statutory Adjustment's reason and for the same purpose: a figure that
              overrules a contribution schedule has to carry somebody's words or an auditor is left with an
              unexplained number. It reaches the payslip stamp and the Statutory Detail screen's banner. */}
          <PersonnelField fieldId="bank_statutory.epf_contribution.epfmanualreason" mode={formMode}>
            <input {...personnelInput('bank_statutory.epf_contribution.epfmanualreason',formMode)} maxLength={500} {...mr.value} className={inputCls} />
          </PersonnelField>
          <p className="col-span-2 text-xs text-muted-foreground">{t('epfManualAmountHint')}</p>
        </div>
      )}
    </>
  );
}
