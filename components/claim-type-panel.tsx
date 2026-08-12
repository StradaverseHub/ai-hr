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

/** One designed field on this claim type's form. Mirrors ClaimFormFieldRowOut, retyped here so a client
 *  island never imports core/claims.ts (which would drag the DB client into the browser bundle). */
export type ClaimTypeFormField = {
  id: string;
  fieldKey: string;
  label: string;
  kind: string;
  required: boolean;
  options: string[];
};

/**
 * One claim type as an expandable row — MASTER DATA ONLY (ccbd0508): rename, description, receipt rules
 * (required + per-type max receipt age), the dependent Claim Items sub-list, and Archive / Delete. All limit
 * and rate configuration moved to the Claim Limits tab (per Job-Grade), so this panel is a clean catalog.
 *
 * e7eb5d83 point 2 — THE CLAIM FORM NOW LIVES HERE TOO. Setting a claim type up used to mean two screens:
 * this panel for the type, and a separate Claim Forms tab for what its form asks. Same claim type, two
 * places, and nothing on either said the other existed. The designer moved into this body and the tab is
 * gone; /admin/claims/forms survives only as a permanent redirect so old bookmarks land somewhere.
 *
 * The four BUILT-IN rows (amount, date, description, receipt) are rendered here exactly as the forms tab
 * rendered them: fixed, with no Remove control. That is presentation. The guarantee is BUILT_IN_FIELD_KEYS
 * in core/claims.ts, which refuses those keys in the service — a forged POST reaches the action, not the
 * screen, so moving the screen moved nothing that was load-bearing.
 */
export function ClaimTypePanel({
  id,
  code,
  name,
  description,
  defaultTaxable,
  requiresReceipt,
  maxReceiptAgeDays,
  isMileage,
  items,
  formFields,
  fieldKinds,
  updateAction,
  archiveAction,
  deleteAction,
  createItemAction,
  updateItemAction,
  archiveItemAction,
  createFieldAction,
  updateFieldAction,
  moveFieldAction,
  archiveFieldAction,
}: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultTaxable: boolean;
  requiresReceipt: boolean;
  maxReceiptAgeDays: number | null;
  /** e7eb5d83 rev 4 — is THIS the tenant's mileage claim type? At most one live type may be. */
  isMileage: boolean;
  items: { id: string; code: string; name: string }[];
  /** The custom fields designed for THIS claim type, in form order. */
  formFields: ClaimTypeFormField[];
  /** CLAIM_FIELD_KINDS, passed down rather than imported — see ClaimTypeFormField. */
  fieldKinds: string[];
  updateAction: Action;
  archiveAction: Action;
  deleteAction: Action;
  createItemAction: Action;
  updateItemAction: Action;
  archiveItemAction: Action;
  createFieldAction: Action;
  updateFieldAction: Action;
  moveFieldAction: Action;
  archiveFieldAction: Action;
}) {
  const t = useTranslations('admin.claims');
  const [expanded, setExpanded] = useState(false);

  // The four that are always on every claim form. Order matches the employee form.
  const builtIns = [
    { key: 'amount', label: t('builtInAmount'), kind: t('fieldKind_money') },
    { key: 'incurredOn', label: t('builtInDate'), kind: t('fieldKind_date') },
    { key: 'description', label: t('builtInDescription'), kind: t('fieldKind_text') },
    { key: 'receipt', label: t('builtInReceipt'), kind: t('fieldKind_file') },
  ];

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
          {isMileage && <span className={badge.amber}>{t('mileageBadge')}</span>}
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
              {/* e7eb5d83 rev 4 point 4 — the reporter's own "one special Claim Type can be designated as
                  Mileage Claim". Ticking it is what gives the employee a distance box and what tells
                  Claims → Mileage Rates which type its bands belong to. Only one live type may hold it;
                  the service refuses a second and names the one that already does. */}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isMileage" defaultChecked={isMileage} className="size-4" />
                {t('isMileageLabel')}
              </label>
              <Button type="submit" size="sm" className="ml-auto">{t('save')}</Button>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('isMileageHint')}</p>
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

          {/* THE CLAIM FORM for this type — what the employee is asked when they file one. */}
          <div className="space-y-3 rounded-lg bg-background p-3">
            <div>
              <p className="text-xs font-semibold text-foreground">{t('formsTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('formsSubtitle')}</p>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground">{t('builtInsTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('builtInsHint')}</p>
              <ul className="mt-1.5 divide-y divide-border/60 rounded-md border border-border/60">
                {builtIns.map((b) => (
                  <li key={b.key} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div>
                      <div className="text-sm font-medium">{b.label}</div>
                      <div className="text-xs text-muted-foreground">{b.kind}</div>
                    </div>
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('builtInBadge')}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t('customFieldsTitle')} <span className="text-muted-foreground">({formFields.length})</span>
              </p>
              {formFields.length === 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">{t('noCustomFields')}</p>
              ) : (
                <ul className="mt-1.5 divide-y divide-border/60">
                  {formFields.map((f, i) => (
                    <li key={f.id} className="space-y-2 py-2">
                      <form action={updateFieldAction} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
                        <input type="hidden" name="id" value={f.id} />
                        <input type="hidden" name="claimTypeId" value={id} />
                        <input name="label" defaultValue={f.label} required className={`${inputCls} w-full`} />
                        <select name="kind" defaultValue={f.kind} className={`${inputCls} w-full`}>
                          {fieldKinds.map((k) => (
                            <option key={k} value={k}>
                              {t(`fieldKind_${k}` as 'fieldKind_text')}
                            </option>
                          ))}
                        </select>
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 text-xs">
                            <input type="checkbox" name="required" defaultChecked={f.required} className="size-4" />
                            {t('fieldRequiredLabel')}
                          </label>
                          <Button type="submit" size="sm" variant="secondary">{t('save')}</Button>
                        </div>
                        {f.kind === 'select' ? (
                          <label className="flex flex-col gap-1 sm:col-span-3">
                            <span className="text-xs font-medium text-muted-foreground">{t('fieldOptionsLabel')}</span>
                            <textarea name="options" rows={2} defaultValue={f.options.join('\n')} className={inputCls} />
                          </label>
                        ) : (
                          <input type="hidden" name="options" value={f.options.join('\n')} />
                        )}
                      </form>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{f.fieldKey}</span>
                        <span className="ml-auto flex gap-1">
                          {i > 0 ? (
                            <form action={moveFieldAction}>
                              <input type="hidden" name="id" value={f.id} />
                              <input type="hidden" name="claimTypeId" value={id} />
                              <input type="hidden" name="direction" value="up" />
                              <Button type="submit" size="sm" variant="ghost" aria-label={t('moveUp')}>↑</Button>
                            </form>
                          ) : null}
                          {i < formFields.length - 1 ? (
                            <form action={moveFieldAction}>
                              <input type="hidden" name="id" value={f.id} />
                              <input type="hidden" name="claimTypeId" value={id} />
                              <input type="hidden" name="direction" value="down" />
                              <Button type="submit" size="sm" variant="ghost" aria-label={t('moveDown')}>↓</Button>
                            </form>
                          ) : null}
                          <form action={archiveFieldAction}>
                            <input type="hidden" name="id" value={f.id} />
                            <input type="hidden" name="claimTypeId" value={id} />
                            <Button type="submit" size="sm" variant="ghost">{t('removeField')}</Button>
                          </form>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <form action={createFieldAction} className="grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
              <input type="hidden" name="claimTypeId" value={id} />
              <Field label={t('fieldLabelLabel')}>
                <input name="label" required placeholder={t('fieldLabelHint')} className={`${inputCls} w-full`} />
              </Field>
              <Field label={t('fieldKindLabel')}>
                <select name="kind" className={`${inputCls} w-full`} defaultValue="text">
                  {fieldKinds.map((k) => (
                    <option key={k} value={k}>
                      {t(`fieldKind_${k}` as 'fieldKind_text')}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-medium text-muted-foreground">{t('fieldOptionsLabel')}</span>
                <textarea name="options" rows={2} placeholder={t('fieldOptionsHint')} className={inputCls} />
              </label>
              <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
                <label className="flex h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="required" className="size-4" />
                  {t('fieldRequiredLabel')}
                </label>
                <Button type="submit" size="sm" className="ml-auto">{t('addField')}</Button>
              </div>
            </form>
            <p className="text-xs text-muted-foreground">{t('formsFooterHint')}</p>
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
