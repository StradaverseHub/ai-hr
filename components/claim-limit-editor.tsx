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
  // e7eb5d83 rev 4 point 3c — Per block is opt-in per rule, so the four inputs stay DISABLED until the
  // tick is on. A disabled input posts nothing, which is what makes "not ticked" arrive at the action as
  // all-four-absent rather than as a half-filled rule the service would have to refuse.
  const [blockOn, setBlockOn] = useState(false);
  const disabled = unlimited;
  const blockDisabled = unlimited || !blockOn;

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

      {/* ── PER BLOCK — "RM2,000 every 2 years", "RM300 every 6 months" (e7eb5d83 rev 4) ──
          Sits BESIDE the per-claim / monthly / annual limits rather than replacing any of them: fill in
          the ones the policy uses and leave the rest empty. "Counting from" is the anchor and it is
          company-wide — every employee is on the same cycle, which is the only version of this that can
          answer "when does my pot refill". Leave it as it comes and the service inherits the anchor
          already on the rule (or 1 January of the effective-from year when there is nothing to inherit),
          so editing an unrelated field cannot restart everybody's two-year window. */}
      <div className="rounded-lg border border-border p-3 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="blockEnabled"
            checked={blockOn}
            disabled={unlimited}
            onChange={(e) => setBlockOn(e.target.checked)}
            className="size-4"
          />
          {t('blockEnableLabel')}
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label={t('blockEveryLabel')}>
            <input
              name="blockLength"
              type="number"
              min="1"
              step="1"
              defaultValue="1"
              disabled={blockDisabled}
              className={`${inputCls} w-full disabled:opacity-50`}
            />
          </Field>
          <Field label={t('blockUnitLabel')}>
            <select name="blockUnit" defaultValue="year" disabled={blockDisabled} className={`${inputCls} w-full disabled:opacity-50`}>
              <option value="month">{t('blockUnit_month')}</option>
              <option value="year">{t('blockUnit_year')}</option>
            </select>
          </Field>
          <Field label={t('blockLimitAmountLabel')}>
            <input
              name="blockLimit"
              type="number"
              min="0"
              step="0.01"
              disabled={blockDisabled}
              placeholder={t('unlimited')}
              className={`${inputCls} w-full disabled:opacity-50`}
            />
          </Field>
          <Field label={t('blockStartLabel')}>
            <input
              name="blockStartOn"
              type="date"
              defaultValue={`${today.slice(0, 4)}-01-01`}
              disabled={blockDisabled}
              className={`${inputCls} w-full disabled:opacity-50`}
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('blockHint')}</p>
      </div>

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
