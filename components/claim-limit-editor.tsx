'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from './ui';
import { setClaimPolicyAction } from '@/app/admin/claims/limits/actions';

type RateKind = 'receipt' | 'mileage_flat' | 'fixed_allowance';

/**
 * Claim Limit editor (ccbd0508) — set/update the entitlement rule for one (Job Grade × Claim Type). Saving
 * CLOSE+INSERTs a new effective-dated version (same versioning HR knows from Leave). The Unlimited toggle
 * clears+disables every amount/count input (an all-null row IS "unlimited"). Approval is a fixed "Yes" today.
 * Client island so the interactive toggles never cross the RSC boundary (imports the server action directly).
 */
export function ClaimLimitEditor({
  types,
  grades,
  today,
  defaultGradeId = null,
}: {
  types: { id: string; code: string; name: string }[];
  grades: { id: string; name: string }[];
  today: string;
  /** e7eb5d83 — the grade the page is currently showing (?gradeId=), so "set a limit" defaults to the grade
   *  the admin is looking at instead of silently defaulting to the company-wide row they did not select. */
  defaultGradeId?: string | null;
}) {
  const t = useTranslations('admin.claims');
  const [unlimited, setUnlimited] = useState(false);
  const [rateKind, setRateKind] = useState<RateKind>('receipt');
  const disabled = unlimited;

  return (
    <form action={setClaimPolicyAction} className="grid gap-3 sm:grid-cols-2">
      <Field label={t('gradeLabel')}>
        <select name="gradeId" className={`${inputCls} w-full`} defaultValue={defaultGradeId ?? ''}>
          <option value="">{t('allGrades')}</option>
          {grades.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </Field>
      <Field label={t('claimTypeLabel')}>
        <select name="claimTypeId" required className={`${inputCls} w-full`}>
          {types.map((ct) => (
            <option key={ct.id} value={ct.id}>{ct.name} ({ct.code})</option>
          ))}
        </select>
      </Field>

      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="unlimited" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} className="size-4" />
        {t('unlimitedToggle')}
      </label>

      <Field label={t('perClaimCapLabel')}>
        <input name="perClaimCap" type="number" min="0" step="0.01" disabled={disabled} placeholder={t('noCap')} className={`${inputCls} w-full disabled:opacity-50`} />
      </Field>
      <Field label={t('monthlyLimitLabel')}>
        <input name="monthlyLimit" type="number" min="0" step="0.01" disabled={disabled} placeholder={t('unlimited')} className={`${inputCls} w-full disabled:opacity-50`} />
      </Field>
      <Field label={t('annualBudgetLabel')}>
        <input name="annualBudget" type="number" min="0" step="0.01" disabled={disabled} placeholder={t('unlimited')} className={`${inputCls} w-full disabled:opacity-50`} />
      </Field>
      {/* e7eb5d83 point 3b — Lifetime limit is GONE FROM THE SCREEN, not from the database. Not one
          claim_policy row on production has ever carried a non-null lifetime_limit (re-measured
          2026-08-10, all 5 rows including superseded versions), so nothing is taken away by hiding it.
          claim_policy.lifetime_limit, the 'lifetime' LimitScope, enforceClaimLimits' lifetime branch and
          the approve-time re-check all stay exactly where they are, which is what makes this reversible
          in one commit. Dropping the column is a later cleanup on its own. */}
      <Field label={t('maxClaimsPerYearLabel')}>
        <input name="maxClaimsPerYear" type="number" min="0" step="1" disabled={disabled} placeholder={t('unlimited')} className={`${inputCls} w-full disabled:opacity-50`} />
      </Field>
      <Field label={t('effectiveFromLabel')}>
        <input name="effectiveFrom" type="date" required defaultValue={today} className={`${inputCls} w-full`} />
      </Field>

      <Field label={t('rateKindLabel')}>
        <select name="rateKind" value={rateKind} onChange={(e) => setRateKind(e.target.value as RateKind)} className={`${inputCls} w-full`}>
          <option value="receipt">{t('rateReceipt')}</option>
          <option value="mileage_flat">{t('rateMileageFlat')}</option>
          <option value="fixed_allowance">{t('rateFixed')}</option>
        </select>
      </Field>
      {rateKind === 'mileage_flat' && (
        <Field label={t('ratePerKmLabel')}>
          <input name="ratePerKm" type="number" min="0" step="0.01" className={`${inputCls} w-full`} />
        </Field>
      )}
      {rateKind === 'fixed_allowance' && (
        <Field label={t('fixedAmountLabel')}>
          <input name="fixedAmount" type="number" min="0" step="0.01" className={`${inputCls} w-full`} />
        </Field>
      )}

      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        <span className="text-xs text-muted-foreground">{t('approvalRequiredLabel')}: {t('approvalAlwaysYes')}</span>
        <Button type="submit">{t('saveLimit')}</Button>
      </div>
    </form>
  );
}
