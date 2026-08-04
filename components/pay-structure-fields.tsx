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
 * conditional Rate box). The Rate field shows only when the selected pay mode is not monthly, labelled
 * per day / per hour, and is required for daily/hourly (the service enforces the same rule).
 *
 * 35b7af0a GROUP 2 — the Create New Employee wizard now renders this too, instead of its own three
 * fields. It had drifted in wording (its Payment Term said "Fortnightly" where every other screen says
 * "Bi-Weekly") and, more usefully, it had never had the conditional rule at all: it showed a bare "Rate
 * amount" box on every hire, including monthly ones where a rate means nothing.
 *
 * THE MODE PROP EXISTS BECAUSE THE CALLERS COLLECT INPUT DIFFERENTLY, not for decoration. The two
 * Personnel surfaces are server-rendered `<form action={serverAction}>` blocks whose values are read out
 * of FormData, so their inputs must carry `name` and stay uncontrolled. The wizard never submits a form
 * — it holds a draft object in React state — so its inputs must be controlled. `mode` is OPTIONAL and
 * defaults to the form behaviour, so the two existing call sites are unchanged, down to the markup.
 */
export type PayStructureFieldsProps =
  | {
      mode?: 'form';
      defaultPayMode: PayModeOption;
      defaultPaymentTerm: string;
      defaultRateAmount: string | null;
      disabled?: boolean;
    }
  | {
      mode: 'controlled';
      payMode: PayModeOption;
      paymentTerm: string;
      rateAmount: string;
      /** Called with the whole patch, so a caller can clear the rate in the SAME state update that
       *  switches the mode to monthly — see the wizard's note on why that matters there and not here. */
      onChange: (patch: { payMode?: PayModeOption; paymentTerm?: string; rateAmount?: string }) => void;
      disabled?: boolean;
    };

export function PayStructureFields(props: PayStructureFieldsProps) {
  const t = useTranslations('people.detail');
  const controlled = props.mode === 'controlled';
  // The hook runs unconditionally (rules of hooks); in controlled mode its value is simply never read —
  // the parent owns the pay mode there, because the conditional Rate box has to react to it and so does
  // the draft the parent is holding.
  const [localPayMode, setLocalPayMode] = useState<PayModeOption>(
    props.mode === 'controlled' ? props.payMode : props.defaultPayMode,
  );
  const payMode = props.mode === 'controlled' ? props.payMode : localPayMode;
  const rateRequired = payMode === 'daily' || payMode === 'hourly';
  const paymentTerm = props.mode === 'controlled' ? props.paymentTerm : props.defaultPaymentTerm;
  const safePaymentTerm = PAYMENT_TERM_OPTIONS.includes(paymentTerm as PaymentTermOption)
    ? paymentTerm
    : 'monthly';

  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('payMode')}</span>
        <select
          value={payMode}
          onChange={(e) => {
            const next = e.target.value as PayModeOption;
            if (props.mode === 'controlled') props.onChange({ payMode: next });
            else setLocalPayMode(next);
          }}
          disabled={props.disabled}
          className={inputCls}
          {...(controlled ? {} : { name: 'payMode' })}
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
          disabled={props.disabled}
          className={inputCls}
          {...(props.mode === 'controlled'
            ? { value: safePaymentTerm, onChange: (e) => props.onChange({ paymentTerm: e.target.value }) }
            : { name: 'paymentTerm', defaultValue: safePaymentTerm })}
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
            type="number"
            min="0.01"
            step="0.01"
            required={rateRequired}
            disabled={props.disabled}
            className={inputCls}
            {...(props.mode === 'controlled'
              ? { value: props.rateAmount, onChange: (e) => props.onChange({ rateAmount: e.target.value }) }
              : { name: 'rateAmount', defaultValue: props.defaultRateAmount ?? '' })}
          />
        </label>
      )}
    </>
  );
}
