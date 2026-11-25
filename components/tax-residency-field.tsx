'use client';

/**
 * r393 (item 685d2380 step 3b) — "Income Tax Resident", the select the Active Income Tax (PCB) card has
 * carried inline since the employer-scoped tax selection, now ONE control with two branches so the Create
 * New Employee draft offers the SAME five choices in the SAME words:
 *
 *   mode="form"        the Active card (components/identity-tax-card.tsx). Byte-identical to the inline
 *                      select it replaced: it posts `taxResidency` (or, under "Not subject to income tax",
 *                      nothing — the card's own hidden input posts 'none'), is required, and offers the
 *                      disabled "Choose…" placeholder. The card still owns the value (its state) and the
 *                      `key` that resets it when the employer context changes.
 *   mode="controlled"  the draft. No `name`, no `id`: nothing posts by itself. A draft field is optional,
 *                      so the blank choice is a SELECTABLE "— Not set —" (lands as Resident, which is what an
 *                      untouched draft has always activated as) rather than a disabled placeholder.
 *
 * One literal t() per option — a template key is invisible to test/i18n-coverage.test.ts check C.
 */
import { useTranslations } from 'next-intl';
import {personnelControl,personnelFormLabel,personnelFormChoices} from '@/lib/personnel-form-contract';

const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

export function TaxResidencyOptions() {
  const t = useTranslations('people.detail');
  return (
    <>
      {personnelFormChoices('bank_statutory.income_tax_pcb.taxresidency').map(({value,labelKey})=><option key={value} value={value}>{t(labelKey.slice(14))}</option>)}
    </>
  );
}

/**
 * ADR 0183 (board d8dc0a8c) — the two custom PCB choices. Offered only where the employer-scoped selection is
 * saved with its number (the Active Income Tax card and the payroll tax set-up page), never in the Create New
 * Employee draft or an import, which have nowhere to carry the amount or rate.
 */
export const CUSTOM_PCB_CHOICES = ['custom_fixed', 'custom_rate'] as const;
export const isCustomPcbChoice = (value: string | null | undefined) =>
  value === 'custom_fixed' || value === 'custom_rate';
export function CustomPcbOptions() {
  const t = useTranslations('people.detail');
  return (
    <>
      <option value="custom_fixed">{t('taxResidencyCustomFixed')}</option>
      <option value="custom_rate">{t('taxResidencyCustomRate')}</option>
    </>
  );
}

/**
 * ADR 0183 — the number a custom choice needs, posted as `customPcbValue` (RM for Fixed Tax Amount, % for Tax
 * Rate). Rendered only while a custom choice is selected, so no other save posts it. The saved number prefills
 * the box for its own choice; switching between the two starts empty. The service is the validator; the input's
 * pattern only catches a typo before the round trip.
 */
export function CustomPcbValueField(props: {
  scheme: string;
  savedAmount: number | null;
  savedRate: number | null;
}) {
  const t = useTranslations('people.detail');
  if (!isCustomPcbChoice(props.scheme)) return null;
  const fixed = props.scheme === 'custom_fixed';
  const saved = fixed ? props.savedAmount : props.savedRate;
  return (
    <label className="flex flex-col gap-1.5" data-custom-pcb={props.scheme}>
      <span className="text-xs font-medium text-muted-foreground">{fixed ? t('customPcbAmountLabel') : t('customPcbRateLabel')}</span>
      <span className="flex items-center gap-2">
        {fixed && <span className="text-sm text-muted-foreground">RM</span>}
        <input
          key={props.scheme}
          name="customPcbValue"
          type="text"
          inputMode="decimal"
          required
          pattern={'[0-9]{1,10}([.][0-9]{1,2})?'}
          defaultValue={saved != null ? saved.toFixed(2) : ''}
          placeholder="0.00"
          aria-label={fixed ? t('customPcbAmountLabel') : t('customPcbRateLabel')}
          className={inputCls}
        />
        {!fixed && <span className="text-sm text-muted-foreground">%</span>}
      </span>
      <span className="text-xs text-muted-foreground">{fixed ? t('customPcbAmountHint') : t('customPcbRateHint')}</span>
      <span className="text-xs text-muted-foreground">{t('customPcbTakesEffect')}</span>
    </label>
  );
}

export function TaxResidencySelect(
  props:
    | { mode: 'form'; none: boolean; value: string; onChange: (value: string) => void }
    | { mode: 'controlled'; none: boolean; value: string | undefined; onChange: (value: string) => void; notSetLabel: string },
) {
  const t = useTranslations('people.detail');
  const { none } = props;
  const fieldId='bank_statutory.income_tax_pcb.taxresidency';
  const label=personnelFormLabel(fieldId,(key,fallback)=>key.startsWith('people.detail.')?t(key.slice(14)):fallback);
  if (props.mode === 'form') {
    return (
      <select id="income-tax-resident" aria-label={label} {...personnelControl(fieldId,'edit',{activeTaxSelection:!none})} value={none?'none':props.value} onChange={e=>props.onChange(e.target.value)} disabled={none} className={inputCls}>
        {none&&<option value="none">{t('taxCategoryNone')}</option>}
        <option value="" disabled>{t('taxSelectionChoose')}</option>
        <TaxResidencyOptions />
        <CustomPcbOptions />
      </select>
    );
  }
  return (
    <select {...personnelControl(fieldId,'draft')} aria-label={label} value={none ? 'none' : (props.value ?? '')} onChange={(e) => props.onChange(e.target.value)} disabled={none} className={inputCls}>
      {none && <option value="none">{t('taxCategoryNone')}</option>}
      <option value="">{props.notSetLabel}</option>
      <TaxResidencyOptions />
    </select>
  );
}

/** The draft's labelled field: the record's "Income Tax Resident" label around the controlled select. */
export function IncomeTaxResidentField(props: {
  none: boolean;
  value: string | undefined;
  onChange: (value: string) => void;
  notSetLabel: string;
}) {
  const t = useTranslations('people.detail');
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{t('incomeTaxResident')}</span>
      <TaxResidencySelect mode="controlled" {...props} />
    </label>
  );
}
