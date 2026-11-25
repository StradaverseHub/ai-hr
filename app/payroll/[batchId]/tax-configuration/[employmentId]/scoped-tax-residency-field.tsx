'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { CustomPcbOptions, CustomPcbValueField, TaxResidencyOptions } from '@/components/tax-residency-field';

/**
 * ADR 0183 — the payroll tax set-up page's Income Tax Resident control: the same seven choices as the Active card,
 * with the custom number beside it. Holds its own selection so the number box follows the choice.
 */
export function ScopedTaxResidencyField(props: {
  none: boolean;
  defaultScheme: string;
  savedAmount: number | null;
  savedRate: number | null;
}) {
  const t = useTranslations('people.detail');
  const [scheme, setScheme] = useState(props.defaultScheme);
  return (
    <>
      {props.none && <input type="hidden" name="taxResidency" value="none" />}
      <label className="flex flex-col gap-2">
        {t('incomeTaxResident')}
        <select id="income-tax-resident" name={props.none ? undefined : 'taxResidency'} value={props.none ? 'none' : scheme} onChange={(e) => setScheme(e.target.value)} disabled={props.none} required={!props.none} className={inputCls}>
          {props.none && <option value="none">{t('taxCategoryNone')}</option>}
          <option value="" disabled>{t('taxSelectionChoose')}</option>
          <TaxResidencyOptions />
          <CustomPcbOptions />
        </select>
      </label>
      {!props.none && <CustomPcbValueField scheme={scheme} savedAmount={props.savedAmount} savedRate={props.savedRate} />}
    </>
  );
}

