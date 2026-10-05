'use client';

// c063eea9 — client half of "Correct hire details" on the Hired row.
//
// Every value, option list and later-record label is resolved and translated by the server page
// (core/hire-correction.ts hireCorrectionView); this island owns only the selections, the reason and the
// confirmation. It posts ONLY the fields HR changed — an untouched select has no `name`, so it cannot
// overwrite a value somebody else corrected after this form was rendered — and the service reads only the
// six allow-listed field names in any case.
import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { correctHireDetailsAction } from './actions';

export type HireCorrectionOption = { id: string; name: string };

export type HireCorrectionFormField = {
  /** The form name — one of core/hire-correction.ts HIRE_CORRECTION_FIELDS. */
  field: string;
  label: string;
  /** Department cannot be cleared (it is NOT NULL on the assignment). */
  required: boolean;
  currentId: string | null;
  currentLabel: string | null;
  originalLabel: string | null;
  options: HireCorrectionOption[];
  /** Later records that carried this field forward, already labelled ("Promotion 2025-01-01"). */
  carriesInto: string[];
  /** The later record that set this field explicitly, already labelled; the correction stops before it. */
  stoppedBy: string | null;
  /** The employee's current record still holds the hire value, so it changes too. */
  reachesCurrent: boolean;
};

export type HireCorrectionReadOnlyRow = {
  key: string;
  label: string;
  value: string;
  pointer: string;
  note?: string | null;
};

const selectCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50';
const btnGhost =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium transition hover:bg-accent';

export function HireCorrectionForm({
  employmentId,
  heading,
  fields,
  readOnly,
  cancelHref,
}: {
  employmentId: string;
  /** "Hired · 2024-03-01" */
  heading: string;
  fields: HireCorrectionFormField[];
  readOnly: HireCorrectionReadOnlyRow[];
  cancelHref: string;
}) {
  const t = useTranslations('people.detail.movement.hireCorrection');
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.field, f.currentId ?? ''])),
  );
  const [reason, setReason] = useState('');

  const changed = useMemo(
    () => fields.filter((f) => (values[f.field] || null) !== f.currentId),
    [fields, values],
  );

  /** Option label for an id, falling back to the field's own current label (an archived / out-of-scope value). */
  const labelOf = (f: HireCorrectionFormField, id: string | null): string => {
    if (!id) return t('noneValue');
    return f.options.find((o) => o.id === id)?.name ?? (id === f.currentId ? (f.currentLabel ?? id) : id);
  };

  /** Later records that take the correction, grouped so one record lists every field it takes. */
  const alsoChanges = useMemo(() => {
    const byRecord = new Map<string, string[]>();
    for (const f of changed) {
      for (const r of f.carriesInto) byRecord.set(r, [...(byRecord.get(r) ?? []), f.label]);
    }
    return [...byRecord.entries()].map(([record, labels]) => t('recordFields', { record, fields: labels.join(', ') }));
  }, [changed, t]);

  const canReview = changed.length > 0 && reason.trim().length > 0;

  return (
    <form ref={formRef} action={correctHireDetailsAction}>
      <input type="hidden" name="employmentId" value={employmentId} />
      <input type="hidden" name="reason" value={reason} />
      {/* ONLY the changed fields are posted. An untouched select carries no name. */}
      {changed.map((f) => (
        <input key={f.field} type="hidden" name={f.field} value={values[f.field] ?? ''} />
      ))}

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <span className="text-sm text-muted-foreground">{heading}</span>
      </div>

      <div className="hidden bg-muted/50 px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4">
        <div className="font-medium">{t('colField')}</div>
        <div className="font-medium">{t('colOriginal')}</div>
        <div className="font-medium">{t('colCorrected')}</div>
      </div>

      <div className="divide-y divide-border">
        {fields.map((f) => {
          const isChanged = changed.includes(f);
          const value = values[f.field] ?? '';
          const known = !value || f.options.some((o) => o.id === value);
          return (
            <div
              key={f.field}
              className={`grid gap-2 px-4 py-3 sm:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-4 ${isChanged ? 'bg-primary/5' : ''}`}
            >
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{f.label}</span>
                {isChanged && (
                  <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                    {t('changed')}
                  </span>
                )}
              </div>
              <div className="text-sm text-foreground">{f.originalLabel ?? '—'}</div>
              <select
                aria-label={f.label}
                value={value}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.field]: e.target.value }))}
                className={selectCls}
              >
                {!f.required && <option value="">{t('none')}</option>}
                {!known && (
                  <option value={value}>{t('unavailable', { name: f.currentLabel ?? value })}</option>
                )}
                {f.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="border-t border-border bg-muted/50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('notCorrectedHere')}
      </div>
      <div className="divide-y divide-border">
        {readOnly.map((r) => (
          <div
            key={r.key}
            className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-start sm:gap-4"
          >
            <div className="text-muted-foreground">{r.label}</div>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <span>{r.value}</span>
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                {t('readOnly')}
              </span>
            </div>
            <div>
              <p className="text-foreground">{r.pointer}</p>
              {r.note ? <p className="mt-0.5 text-xs text-muted-foreground">{r.note}</p> : null}
            </div>
          </div>
        ))}
      </div>

      {changed.length > 0 && (
        <div className="mx-4 mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-semibold">{t('laterTitle')}</p>
          {changed.every((f) => f.carriesInto.length === 0 && !f.stoppedBy) ? (
            <p className="mt-1">{t('laterNone')}</p>
          ) : (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {changed.flatMap((f) => [
                ...f.carriesInto.map((r, i) => (
                  <li key={`${f.field}-c-${i}`}>{t('laterCarries', { record: r, field: f.label })}</li>
                )),
                ...(f.stoppedBy
                  ? [
                      <li key={`${f.field}-s`} className="opacity-80">
                        {t('laterStops', { record: f.stoppedBy, field: f.label })}
                      </li>,
                    ]
                  : []),
              ])}
            </ul>
          )}
        </div>
      )}

      <label className="block px-4 pt-4">
        <span className="mb-1 block text-sm font-medium text-foreground">
          {t('reasonLabel')} <span className="text-destructive">{t('required')}</span>
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-input/30"
        />
      </label>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border p-4">
        <a href={cancelHref} className={btnGhost}>
          {t('cancel')}
        </a>
        <AlertDialog.Root>
          <AlertDialog.Trigger asChild>
            <button type="button" className={btnPrimary} disabled={!canReview}>
              {t('review')}
            </button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
              <AlertDialog.Title className="text-base font-semibold">{t('confirmTitle')}</AlertDialog.Title>
              <p className="mt-1 text-sm font-medium text-foreground">{heading}</p>
              <AlertDialog.Description asChild>
                <div className="mt-4 divide-y divide-border rounded-md border border-border text-sm">
                  {changed.map((f) => (
                    <div key={f.field} className="px-3 py-2">
                      <span className="text-muted-foreground">{f.label}:</span>{' '}
                      <span>{labelOf(f, f.currentId)}</span> <span aria-hidden>→</span>{' '}
                      <span className="font-semibold">{labelOf(f, values[f.field] || null)}</span>
                    </div>
                  ))}
                  <div className="px-3 py-2">
                    <span className="text-muted-foreground">{t('alsoChanges')}</span>{' '}
                    {alsoChanges.length ? alsoChanges.join('; ') : t('alsoChangesNone')}
                  </div>
                  <div className="px-3 py-2">
                    <p className="text-muted-foreground">{t('currentInfo')}</p>
                    <ul className="mt-1 space-y-0.5">
                      {changed.map((f) => (
                        <li key={f.field}>
                          {f.reachesCurrent
                            ? t('currentChanges', { field: f.label })
                            : f.stoppedBy
                              ? t('currentUnchanged', { field: f.label, record: f.stoppedBy })
                              : t('currentUnchangedPlain', { field: f.label })}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </AlertDialog.Description>
              <p className="mt-3 text-sm text-muted-foreground">{t('confirmNote')}</p>
              <div className="mt-5 flex justify-end gap-2">
                <AlertDialog.Cancel asChild>
                  <button type="button" className={btnGhost}>
                    {t('cancel')}
                  </button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <button type="button" className={btnPrimary} onClick={() => formRef.current?.requestSubmit()}>
                    {t('save')}
                  </button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
    </form>
  );
}
