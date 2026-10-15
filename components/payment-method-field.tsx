'use client';

/**
 * Payment Method — the "How This Employee Is Paid" select. A shared field group (r393, item 685d2380
 * step 2): the Personnel record's Payroll tab and the draft employee's Payroll tab render THIS, so the
 * question, its four answers (Not specified / Bank Transfer / Cheque / Cash) and their wording cannot
 * drift between a draft and the record it becomes.
 *
 *   mode: 'form'        → `name="paymentMethod"` + `defaultValue`, read out of FormData by
 *                         setPaymentMethodAction. NO function prop (the r123 RSC-boundary fault), so the
 *                         record's server page can render it. Its markup is the record's markup from before
 *                         the extraction, byte for byte — test/r393-draft-payroll-tab.dom.test.tsx pins it.
 *   mode: 'controlled'  → `value` + `onChange`, bound to the draft's state. No `name`: nothing is posted.
 *
 * The caption is a `<span>`, not a `<label>`, because that is what the record has always rendered beside
 * its own form wrapper; the controlled branch adds an `aria-label` so the select is still named.
 *
 * ONE NAMESPACE (`people.detail`) and every key a literal, except the per-method option label, which is
 * the record's own existing computed key (`paymentMethod_${m}`, all three present in six locales).
 */

import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { personnelControl,personnelFormChoices,personnelFormLabel } from '@/lib/personnel-form-contract';

type Mode =
  | { mode: 'form'; defaultValue: string | null | undefined; disabled?: boolean }
  | { mode: 'controlled'; value: string | null | undefined; onChange: (paymentMethod: string) => void };

export function PaymentMethodField(props: Mode) {
  const t = useTranslations('people.detail');
  const fieldId='payroll.payment_method_and_payroll_policy.paymentmethod';
  const mode=props.mode==='controlled'?'draft':'edit';
  const label=personnelFormLabel(fieldId,(key,fallback)=>key.startsWith('people.detail.')?t(key.slice(14)):fallback);
  return (
    <>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <select
          {...personnelControl(fieldId,mode)}
          {...(props.mode === 'form'
            ? { defaultValue: props.defaultValue ?? '', disabled: !!props.disabled }
            : {
                'aria-label': label,
                value: props.value ?? '',
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => props.onChange(e.target.value),
              })}
          className={inputCls}
        >
          <option value="">{t('paymentMethodNotSet')}</option>
          {personnelFormChoices(fieldId).map(({value:m,labelKey}) => (
            <option key={m} value={m}>
              {t(labelKey.slice(14))}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

