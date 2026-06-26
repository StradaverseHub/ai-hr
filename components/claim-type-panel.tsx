'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

type Action = (fd: FormData) => void | Promise<void>;

const badge = {
  amber:
    'rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  muted:
    'rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};
const rm = (n: number) => `RM ${n.toLocaleString('en-MY')}`;

type RateConfig =
  | { kind: 'receipt' }
  | { kind: 'mileage_flat'; ratePerKm: number }
  | { kind: 'fixed_allowance'; amount: number };

/** One claim type as an expandable row: rename + taxable/receipt toggles + effective-dated budget + rate
 *  config + the dependent Claim Items sub-list. */
export function ClaimTypePanel({
  id,
  code,
  name,
  defaultTaxable,
  requiresReceipt,
  policy,
  items,
  updateAction,
  archiveAction,
  setPolicyAction,
  createItemAction,
  updateItemAction,
  archiveItemAction,
}: {
  id: string;
  code: string;
  name: string;
  defaultTaxable: boolean;
  requiresReceipt: boolean;
  policy: { annualBudget: number | null; perClaimCap: number | null; rateConfig: RateConfig | null; validFrom: string } | null;
  items: { id: string; code: string; name: string }[];
  updateAction: Action;
  archiveAction: Action;
  setPolicyAction: Action;
  createItemAction: Action;
  updateItemAction: Action;
  archiveItemAction: Action;
}) {
  const t = useTranslations('admin.claims');
  const [expanded, setExpanded] = useState(false);
  const [rateKind, setRateKind] = useState<RateConfig['kind']>(policy?.rateConfig?.kind ?? 'receipt');
  const today = new Date().toISOString().slice(0, 10);
  const ratePerKm = policy?.rateConfig?.kind === 'mileage_flat' ? policy.rateConfig.ratePerKm : '';
  const fixedAmount = policy?.rateConfig?.kind === 'fixed_allowance' ? policy.rateConfig.amount : '';

  return (
    <li>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <svg viewBox="0 0 20 20" className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="font-mono text-xs text-muted-foreground">{code}</span>
          <span className={defaultTaxable ? badge.amber : badge.muted}>{defaultTaxable ? t('taxable') : t('nonTaxable')}</span>
          {requiresReceipt && <span className={badge.muted}>{t('receipt')}</span>}
        </button>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {policy?.annualBudget != null ? `${t('budget')} ${rm(policy.annualBudget)}/yr` : t('noBudget')}
        </span>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3">
          {/* type-level edit */}
          <form action={updateAction} className="flex flex-wrap items-end gap-3 rounded-lg bg-background p-3">
            <input type="hidden" name="id" value={id} />
            <Field label={t('nameLabel')}>
              <input name="name" defaultValue={name} className={`${inputCls} w-52`} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="defaultTaxable" defaultChecked={defaultTaxable} className="size-4" />
              {t('defaultTaxableLabel')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="requiresReceipt" defaultChecked={requiresReceipt} className="size-4" />
              {t('requiresReceiptLabel')}
            </label>
            <Button type="submit" size="sm">{t('save')}</Button>
          </form>

          {/* budget + rate config (effective-dated — one append-only policy version) */}
          <form action={setPolicyAction} className="flex flex-wrap items-end gap-3 rounded-lg bg-background p-3">
            <input type="hidden" name="claimTypeId" value={id} />
            <Field label={t('annualBudgetLabel')}>
              <input name="annualBudget" type="number" min="0" step="0.01" placeholder={t('unlimited')} defaultValue={policy?.annualBudget ?? ''} className={`${inputCls} w-32`} />
            </Field>
            <Field label={t('perClaimCapLabel')}>
              <input name="perClaimCap" type="number" min="0" step="0.01" placeholder={t('noCap')} defaultValue={policy?.perClaimCap ?? ''} className={`${inputCls} w-32`} />
            </Field>
            <Field label={t('effectiveFromLabel')}>
              <input name="effectiveFrom" type="date" required defaultValue={today} className={inputCls} />
            </Field>
            <Field label={t('rateKindLabel')}>
              <select name="rateKind" value={rateKind} onChange={(e) => setRateKind(e.target.value as RateConfig['kind'])} className={`${inputCls} w-44`}>
                <option value="receipt">{t('rateReceipt')}</option>
                <option value="mileage_flat">{t('rateMileageFlat')}</option>
                <option value="fixed_allowance">{t('rateFixed')}</option>
              </select>
            </Field>
            {rateKind === 'mileage_flat' && (
              <Field label={t('ratePerKmLabel')}>
                <input name="ratePerKm" type="number" min="0" step="0.01" defaultValue={ratePerKm} className={`${inputCls} w-28`} />
              </Field>
            )}
            {rateKind === 'fixed_allowance' && (
              <Field label={t('fixedAmountLabel')}>
                <input name="fixedAmount" type="number" min="0" step="0.01" defaultValue={fixedAmount} className={`${inputCls} w-28`} />
              </Field>
            )}
            <Button type="submit" size="sm">{t('setBudget')}</Button>
          </form>

          {/* dependent Claim Items sub-list */}
          <div className="space-y-2 rounded-lg bg-background p-3">
            <p className="text-xs font-semibold text-foreground">{t('itemsTitle')}</p>
            {items.length > 0 && (
              <ul className="divide-y divide-border/60">
                {items.map((it) => (
                  <li key={it.id} className="flex flex-wrap items-end gap-2 py-2">
                    <form action={updateItemAction} className="flex items-end gap-2">
                      <input type="hidden" name="id" value={it.id} />
                      <span className="self-center font-mono text-xs text-muted-foreground">{it.code}</span>
                      <Field label={t('itemNameLabel')}>
                        <input name="name" defaultValue={it.name} className={`${inputCls} w-44`} />
                      </Field>
                      <Button type="submit" size="sm" variant="ghost">{t('save')}</Button>
                    </form>
                    <form action={archiveItemAction}>
                      <input type="hidden" name="id" value={it.id} />
                      <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('itemArchiveConfirmTitle')} description={t('itemArchiveConfirmDescription')} confirmLabel={t('itemArchiveConfirmLabel')}>
                        {t('archive')}
                      </ConfirmSubmit>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <form action={createItemAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="claimTypeId" value={id} />
              <Field label={t('itemCodeLabel')}>
                <input name="code" required placeholder="MILEAGE" className={`${inputCls} w-32 font-mono uppercase`} />
              </Field>
              <Field label={t('itemNameLabel')}>
                <input name="name" required placeholder="Mileage" className={`${inputCls} w-44`} />
              </Field>
              <Button type="submit" size="sm">{t('newItem')}</Button>
            </form>
          </div>

          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t('typeLabel')}</span>
            <form action={archiveAction}>
              <input type="hidden" name="id" value={id} />
              <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('archiveConfirmTitle')} description={t('archiveConfirmDescription')} confirmLabel={t('archiveConfirmLabel')}>
                {t('archive')}
              </ConfirmSubmit>
            </form>
          </div>
        </div>
      )}
    </li>
  );
}
