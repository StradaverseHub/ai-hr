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

/**
 * One claim type as an expandable row — MASTER DATA ONLY (ccbd0508): rename, description, receipt rules
 * (required + per-type max receipt age), the dependent Claim Items sub-list, and Archive / Delete. All limit
 * and rate configuration moved to the Claim Limits tab (per Job-Grade), so this panel is a clean catalog.
 */
export function ClaimTypePanel({
  id,
  code,
  name,
  description,
  defaultTaxable,
  requiresReceipt,
  maxReceiptAgeDays,
  items,
  updateAction,
  archiveAction,
  deleteAction,
  createItemAction,
  updateItemAction,
  archiveItemAction,
}: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultTaxable: boolean;
  requiresReceipt: boolean;
  maxReceiptAgeDays: number | null;
  items: { id: string; code: string; name: string }[];
  updateAction: Action;
  archiveAction: Action;
  deleteAction: Action;
  createItemAction: Action;
  updateItemAction: Action;
  archiveItemAction: Action;
}) {
  const t = useTranslations('admin.claims');
  const [expanded, setExpanded] = useState(false);

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
          {items.length > 0 && <span className={badge.muted}>{t('itemCount', { count: items.length })}</span>}
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3">
          {/* type-level edit — master data only (no limits) */}
          <form action={updateAction} className="grid gap-3 rounded-lg bg-background p-3 sm:grid-cols-2">
            <input type="hidden" name="id" value={id} />
            <Field label={t('nameLabel')}>
              <input name="name" defaultValue={name} className={`${inputCls} w-full`} />
            </Field>
            <Field label={t('maxReceiptAgeLabel')}>
              <input name="maxReceiptAgeDays" type="number" min="1" step="1" placeholder={t('maxReceiptAgeHint')} defaultValue={maxReceiptAgeDays ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">{t('descriptionLabel')}</span>
              <textarea name="description" rows={2} defaultValue={description ?? ''} className={inputCls} />
            </label>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="defaultTaxable" defaultChecked={defaultTaxable} className="size-4" />
                {t('defaultTaxableLabel')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="requiresReceipt" defaultChecked={requiresReceipt} className="size-4" />
                {t('requiresReceiptLabel')}
              </label>
              <Button type="submit" size="sm" className="ml-auto">{t('save')}</Button>
            </div>
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

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t('typeLabel')}</span>
            <form action={archiveAction}>
              <input type="hidden" name="id" value={id} />
              <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('archiveConfirmTitle')} description={t('archiveConfirmDescription')} confirmLabel={t('archiveConfirmLabel')}>
                {t('archive')}
              </ConfirmSubmit>
            </form>
            <form action={deleteAction}>
              <input type="hidden" name="id" value={id} />
              <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('deleteConfirmTitle')} description={t('deleteConfirmDescription')} confirmLabel={t('deleteConfirmLabel')}>
                {t('delete')}
              </ConfirmSubmit>
            </form>
          </div>
        </div>
      )}
    </li>
  );
}
