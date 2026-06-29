'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button, Field, inputCls } from './ui';
import { grantAdHocLeaveAction } from '@/app/admin/actions';

export type FestiveCompanyOption = { id: string; name: string };
export type FestiveLeaveTypeOption = { id: string; name: string };
export type FestiveGrantRow = {
  occurredAt: string;
  companyName: string | null;
  leaveTypeName: string | null;
  days: number | null;
  count: number | null;
  reason: string | null;
  effectiveOn: string | null;
};

/**
 * ADR-0066: festive / one-off leave grant. Credits N extra days to everyone in a chosen company + leave type
 * on a chosen date, with a reason (e.g. "CNY 2026"). The action returns the affected-employee count, shown
 * as a confirmation toast. Recent grants are listed from the `leave.ad-hoc.granted` event log.
 */
export function FestiveGrantCard({
  companies,
  leaveTypes,
  recent,
  defaultDate,
}: {
  companies: FestiveCompanyOption[];
  leaveTypes: FestiveLeaveTypeOption[];
  recent: FestiveGrantRow[];
  /** Today's ISO date for the effective-date default. */
  defaultDate: string;
}) {
  const t = useTranslations('admin.leave');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (formData: FormData) =>
    start(async () => {
      setError(null);
      const res = await grantAdHocLeaveAction(formData);
      if (res.error) {
        setError(res.error);
        return;
      }
      toast.success(t('festiveGrantedToast', { count: res.granted ?? 0, targeted: res.targeted ?? 0 }));
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <p className="px-4 pt-3 text-xs text-muted-foreground">{t('festiveHelp')}</p>
      {error && (
        <p className="mx-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}
      <form action={onSubmit} className="flex flex-wrap items-end gap-3 px-4">
        <Field label={t('festiveCompanyLabel')}>
          <select name="companyId" defaultValue="" className={`${inputCls} w-44`}>
            <option value="">{t('festiveCompanyGroupWide')}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('festiveLeaveTypeLabel')}>
          <select name="leaveTypeId" required defaultValue="" className={`${inputCls} w-44`}>
            <option value="" disabled>
              {t('festiveLeaveTypePlaceholder')}
            </option>
            {leaveTypes.map((lt) => (
              <option key={lt.id} value={lt.id}>
                {lt.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('festiveDaysLabel')}>
          <input name="days" type="number" min="0.5" step="0.5" required defaultValue="1" className={`${inputCls} w-24`} />
        </Field>
        <Field label={t('festiveEffectiveLabel')}>
          <input name="effectiveOn" type="date" required defaultValue={defaultDate} className={inputCls} />
        </Field>
        <Field label={t('festiveReasonLabel')}>
          <input name="reason" required placeholder={t('festiveReasonPlaceholder')} className={`${inputCls} w-48`} />
        </Field>
        <Field label={t('festiveExpiresLabel')}>
          <input name="expiresOn" type="date" className={inputCls} />
        </Field>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t('festiveGrantingButton') : t('festiveGrantButton')}
        </Button>
      </form>

      <div className="space-y-1.5 px-4 pb-4">
        <div className="text-xs font-medium text-muted-foreground">{t('festiveRecentTitle')}</div>
        {recent.length === 0 ? (
          <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">{t('festiveRecentEmpty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg bg-background">
            {recent.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="font-medium text-foreground">{r.reason}</span>
                <span className="text-muted-foreground">
                  {t('festiveRecentSummary', {
                    days: r.days ?? 0,
                    type: r.leaveTypeName ?? '—',
                    scope: r.companyName ?? t('festiveCompanyGroupWide'),
                    count: r.count ?? 0,
                    date: r.effectiveOn ?? '—',
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
