'use client';

import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { MOVEMENT_FORM_IDS } from '@/lib/movement-form-contract';
import { personnelFormLabel } from '@/lib/personnel-form-contract';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import type { HistoryPayFacts } from '@/lib/movement-history-pay';

export function HistoryMovementPayFields({ pay }: { pay?: HistoryPayFacts }) {
  const t = useTranslations();
  const label = (field: 'basicSalary' | 'paymentMethod') =>
    personnelFormLabel(MOVEMENT_FORM_IDS[field], (key, fallback) => t.has(key) ? t(key) : fallback);
  return (
    <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium">{t('people.detail.tabs.payroll')}</legend>
      {(['before', 'after'] as const).map(side => {
        const caption = side === 'before'
          ? t('people.detail.movement.detail.beforeChanges') : t('people.detail.movement.detail.afterChanges');
        return (
          <div className="space-y-2" key={side}>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{label('basicSalary')} · {caption}</span>
              <input name={`historyPay.${side}.basicSalary`} type="number" min="0" step="0.01"
                defaultValue={pay?.basicSalary?.[side]} className={inputCls} />
            </label>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{label('paymentMethod')} · {caption}</span>
              <select name={`historyPay.${side}.paymentMethod`} defaultValue={pay?.paymentMethod?.[side] ?? ''} className={inputCls}>
                <option value="">{t('people.detail.movement.form.historyUnchanged')}</option>
                {PAYMENT_METHODS.map(method =>
                  <option key={method} value={method}>{t(`people.detail.paymentMethod_${method}`)}</option>)}
              </select>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
