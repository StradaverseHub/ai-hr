'use client';

import * as React from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useTranslations } from 'next-intl';
import { Button, Card, Input } from '@/components/ui';
import { amendEaFieldAction, clearEaFieldAction } from './actions';

export type AmendField = {
  field: string;
  label: string;
  original: number;
  amended: number | null; // null = no override; else the active amended value
  reason: string | null;
  // #18 — true for a statutory field (mtd/epf/socso/eis) reconciled against the year's filed CP39/agency
  // total. `filedTotal` is that figure; the panel surfaces it and warns when the amended input diverges.
  statutory?: boolean;
  filedTotal?: number | null;
};

const rm = (n: number) =>
  `RM ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * 1.2.6 EA Data Overwrite — the admin-only "Amend EA figures" panel. Per field it shows the derived
 * (original) value, an input for the amended value + a required reason, and an original→amended confirm
 * dialog before committing the server action. Cleared (no override) fields show a "Reset to original"
 * delete form. Rendered ONLY when the server gate (isAdmin / canManagePayroll) passes.
 */
export function EaAmendPanel({
  employmentId,
  year,
  fields,
}: {
  employmentId: string;
  year: string;
  fields: AmendField[];
}) {
  const t = useTranslations('payroll.ea.override');
  return (
    <Card className="space-y-4 p-6 print:hidden">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{t('panelTitle')}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('panelDescription')}</p>
      </div>
      <div className="space-y-3">
        {fields.map((f) => (
          <FieldRow key={f.field} employmentId={employmentId} year={year} f={f} t={t} />
        ))}
      </div>
    </Card>
  );
}

function FieldRow({
  employmentId,
  year,
  f,
  t,
}: {
  employmentId: string;
  year: string;
  f: AmendField;
  t: ReturnType<typeof useTranslations>;
}) {
  const tc = useTranslations('components.confirmSubmit');
  const [amount, setAmount] = React.useState<string>(f.amended != null ? String(f.amended) : String(f.original));
  const [reason, setReason] = React.useState<string>(f.reason ?? '');
  const formRef = React.useRef<HTMLFormElement>(null);
  const amended = f.amended != null;
  const parsed = Number(amount);
  const canSave = reason.trim().length > 0 && Number.isFinite(parsed) && parsed >= 0;
  // #18 — a statutory field is reconciled against the year's filed CP39/agency total (`filedTotal`).
  // Warn (live) when the entered amount diverges from it beyond rounding tolerance.
  const filedTotal = f.statutory ? f.filedTotal ?? f.original : null;
  const diverges =
    filedTotal != null && Number.isFinite(parsed) && Math.abs(parsed - filedTotal) > 0.005;

  return (
    <form ref={formRef} action={amendEaFieldAction} className="rounded-lg border border-border p-3">
      <input type="hidden" name="employmentId" value={employmentId} />
      <input type="hidden" name="year" value={year} />
      <input type="hidden" name="field" value={f.field} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[10rem] flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{f.label}</span>
            {amended && (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                {t('amendedBadge')}
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {t('original')}: <span className="tabular-nums">{rm(f.original)}</span>
          </span>
          {/* #18 — for a statutory field, surface the year's FILED CP39/agency total alongside the derived. */}
          {filedTotal != null && (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t('filedTotal')}: <span className="tabular-nums">{rm(filedTotal)}</span>
            </span>
          )}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('amended')}</span>
          <Input
            type="number"
            step="0.01"
            min="0"
            name="amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t('amendedValuePlaceholder')}
            className="w-36 tabular-nums"
          />
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('reason')}</span>
          <Input
            type="text"
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            required
          />
        </label>
        <div className="flex items-center gap-2">
          <AlertDialog.Root>
            <AlertDialog.Trigger asChild>
              <Button type="button" size="sm" disabled={!canSave}>
                {t('save')}
              </Button>
            </AlertDialog.Trigger>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
              <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
                <AlertDialog.Title className="text-base font-semibold">{t('confirmTitle')}</AlertDialog.Title>
                <AlertDialog.Description className="mt-1.5 text-sm text-muted-foreground">
                  {t('confirmBody')}
                </AlertDialog.Description>
                <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
                  <div className="font-medium">{f.label}</div>
                  <div className="mt-1 flex items-center gap-2 tabular-nums">
                    <span className="text-muted-foreground line-through">{rm(f.original)}</span>
                    <span aria-hidden>→</span>
                    <span className="font-semibold">{Number.isFinite(parsed) ? rm(parsed) : '—'}</span>
                  </div>
                  {reason.trim() && <div className="mt-2 text-xs text-muted-foreground">{t('reasonTooltip', { reason: reason.trim() })}</div>}
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <AlertDialog.Cancel asChild>
                    <Button type="button" variant="outline" size="sm">
                      {tc('cancel')}
                    </Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button type="button" size="sm" onClick={() => formRef.current?.requestSubmit()}>
                      {t('save')}
                    </Button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
          {amended && (
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              formAction={clearEaFieldAction}
              formNoValidate
              title={t('clear')}
            >
              {t('clear')}
            </Button>
          )}
        </div>
      </div>
      {/* #18 — live warning when a statutory amend diverges from the filed CP39/agency total (an LHDN audit
          flag). The structured { filedTotal, delta } is also persisted on the domain event by the service. */}
      {diverges && filedTotal != null && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('cp39DivergenceWarning', { filed: rm(filedTotal), delta: rm(parsed - filedTotal) })}
        </div>
      )}
    </form>
  );
}
