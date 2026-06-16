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

/** One claim type as an expandable row: rename + taxable/receipt toggles + effective-dated budget. */
export function ClaimTypePanel({
  id,
  code,
  name,
  defaultTaxable,
  requiresReceipt,
  policy,
  updateAction,
  archiveAction,
  setPolicyAction,
}: {
  id: string;
  code: string;
  name: string;
  defaultTaxable: boolean;
  requiresReceipt: boolean;
  policy: { annualBudget: number | null; perClaimCap: number | null; validFrom: string } | null;
  updateAction: Action;
  archiveAction: Action;
  setPolicyAction: Action;
}) {
  const t = useTranslations('admin.claims');
  const [expanded, setExpanded] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

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

          {/* budget (effective-dated) */}
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
            <Button type="submit" size="sm">{t('setBudget')}</Button>
          </form>

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
