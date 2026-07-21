'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from './ui';

/** Client-safe mirrors of the service unions (core/comp.ts PAY_MODES / PAYROLL_FREQUENCIES) — no DB import
 *  from a 'use client' module. The service re-validates, so a drift fails loudly server-side. */
export const PAY_MODE_OPTIONS = ['monthly', 'daily', 'hourly', 'custom_period'] as const;
export const PAYMENT_TERM_OPTIONS = ['monthly', 'weekly', 'biweekly'] as const;
export type PayModeOption = (typeof PAY_MODE_OPTIONS)[number];
export type PaymentTermOption = (typeof PAYMENT_TERM_OPTIONS)[number];

/**
 * ADR-0078 (642ecc55) — the employee-specific salary-structure fields (Pay Mode, Payment Term and a
 * conditional Rate box) shared by the add-revision form and the history table's edit flow. The Rate field
 * shows only when the selected pay mode is not monthly, labelled per day / per hour, and is required for
 * daily/hourly (the service enforces the same rule). Uncontrolled except for payMode, whose local state
 * drives the conditional render.
 */
export function PayStructureFields({
  defaultPayMode,
  defaultPaymentTerm,
  defaultRateAmount,
  disabled,
}: {
  defaultPayMode: PayModeOption;
  defaultPaymentTerm: string;
  defaultRateAmount: string | null;
  disabled?: boolean;
}) {
  const t = useTranslations('people.detail');
  const [payMode, setPayMode] = useState<PayModeOption>(defaultPayMode);
  const rateRequired = payMode === 'daily' || payMode === 'hourly';
  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('payMode')}</span>
        <select
          name="payMode"
          value={payMode}
          onChange={(e) => setPayMode(e.target.value as PayModeOption)}
          disabled={disabled}
          className={inputCls}
        >
          {PAY_MODE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {t(`payMode_${m}` as 'payMode_monthly')}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('paymentTerm')}</span>
        <select
          name="paymentTerm"
          defaultValue={PAYMENT_TERM_OPTIONS.includes(defaultPaymentTerm as PaymentTermOption) ? defaultPaymentTerm : 'monthly'}
          disabled={disabled}
          className={inputCls}
        >
          {PAYMENT_TERM_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {t(`paymentTerm_${f}` as 'paymentTerm_monthly')}
            </option>
          ))}
        </select>
      </label>
      {payMode !== 'monthly' && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t('rateAmount')}
            {payMode === 'daily' && <> ({t('rateUnitDaily')})</>}
            {payMode === 'hourly' && <> ({t('rateUnitHourly')})</>}
          </span>
          <input
            name="rateAmount"
            type="number"
            min="0.01"
            step="0.01"
            required={rateRequired}
            defaultValue={defaultRateAmount ?? ''}
            disabled={disabled}
            className={inputCls}
          />
        </label>
      )}
    </>
  );
}
