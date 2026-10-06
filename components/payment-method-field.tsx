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
import { PAYMENT_METHODS } from '@/lib/payment-methods';

type Mode =
  | { mode: 'form'; defaultValue: string | null | undefined; disabled?: boolean }
  | { mode: 'controlled'; value: string | null | undefined; onChange: (paymentMethod: string) => void };

export function PaymentMethodField(props: Mode) {
  const t = useTranslations('people.detail');
  return (
    <>
      <span className="text-xs font-medium text-muted-foreground">{t('paymentMethod')}</span>
      <div className="flex gap-2">
        <select
          {...(props.mode === 'form'
            ? { name: 'paymentMethod', defaultValue: props.defaultValue ?? '', disabled: !!props.disabled }
            : {
                'aria-label': t('paymentMethod'),
                value: props.value ?? '',
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => props.onChange(e.target.value),
              })}
          className={inputCls}
        >
          <option value="">{t('paymentMethodNotSet')}</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`paymentMethod_${m}` as 'paymentMethod_bank_transfer')}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

