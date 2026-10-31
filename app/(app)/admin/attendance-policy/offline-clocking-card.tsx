'use client';

import { startTransition, useActionState, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Card, inputCls } from '@/components/ui';
import type { OfflineClockingCompanySettings } from './offline-clocking-data';
import { saveOfflineClockingAction, type OfflineClockingSaveResult } from './offline-clocking-actions';

/**
 * "Offline clocking" — the company setting that lets employees clock in the mobile app without a connection (draft
 * 0647; owner-approved design 2026-10-28). One block per company in the viewer's scope, inside one card beside the
 * Schedule Group card. The badge reads "Not available on this server" until this server's offline deployment is active
 * for the company and its storage is ready; without the settings columns the fields are disabled, because a save
 * would be refused.
 *
 * The form has no `action` prop: onSubmit dispatches the value-returning action inside startTransition, so React does
 * not reset the controlled fields after a refused save (the reason is in app/(app)/admin/holidays/holiday-dialog.tsx).
 */
export function OfflineClockingCard({ companies }: { companies: readonly OfflineClockingCompanySettings[] }) {
  const t = useTranslations('offlineClocking.settings');
  const available = companies.some((c) => c.available);
  return (
    <Card id="offline-clocking" className="scroll-mt-6 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        {!available && <Badge variant="warning">{t('notAvailable')}</Badge>}
      </div>
      {companies.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noCompany')}</p>
      ) : (
        companies.map((company) => (
          <CompanyOfflineClocking key={company.companyId} company={company} showName={companies.length > 1} />
        ))
      )}
    </Card>
  );
}

const minutesOf = (seconds: number) => String(Math.round((seconds / 60) * 100) / 100);

function CompanyOfflineClocking({ company, showName }: { company: OfflineClockingCompanySettings; showName: boolean }) {
  const t = useTranslations('offlineClocking.settings');
  const [enabled, setEnabled] = useState(company.enabled);
  const [minutes, setMinutes] = useState(minutesOf(company.maxProvenWindowSeconds));
  const [result, dispatch, pending] = useActionState<OfflineClockingSaveResult, FormData>(saveOfflineClockingAction, null);
  const disabled = !company.columns || !company.canEdit || pending;
  const fieldId = `offline-window-${company.companyId}`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };
  return (
    <form onSubmit={submit} data-attendance-save-scope="" data-attendance-saved-receipt={result?.ok ? result.savedReceipt ?? undefined : undefined} aria-busy={pending} className="space-y-3 border-b border-border px-4 py-4 last:border-b-0">
      <input type="hidden" name="companyId" value={company.companyId} />
      {showName && <h3 className="text-sm font-semibold text-foreground">{company.companyName}</h3>}
      {showName && !company.available && <Badge variant="warning">{t('notAvailable')}</Badge>}
      <fieldset disabled={disabled} className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" name="enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4" />
          {t('enable')}
        </label>
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            {t.rich('threshold', {
              field: () => (
                <input
                  id={fieldId}
                  name="maxProvenWindowMinutes"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={1440}
                  step="any"
                  required
                  aria-label={t('thresholdLabel')}
                  aria-describedby={`${fieldId}-help`}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  className={`${inputCls} w-24`}
                />
              ),
            })}
          </p>
          <p id={`${fieldId}-help`} className="text-xs text-muted-foreground">{t('help')}</p>
        </div>
      </fieldset>
      {result && !result.ok && <p role="alert" className="text-sm text-destructive">{t(`errors.${result.error}`)}</p>}
      {result?.ok && <p role="status" className="text-sm text-muted-foreground">{t('saved')}</p>}
      {!company.canEdit && company.columns && <p className="text-xs text-muted-foreground">{t('readOnly')}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {[company.phonesOffline === null ? null : t('phonesOffline', { count: company.phonesOffline }),
            company.waiting === null ? null : t('waiting', { count: company.waiting })].filter(Boolean).join(' · ')}
        </p>
        <Button type="submit" disabled={disabled}>{pending ? t('saving') : t('save')}</Button>
      </div>
    </form>
  );
}
