'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button, Field, inputCls } from './ui';
import { MultiSelectPopover } from './ui/multi-select-popover';
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
 * ADR-0066 (re-plan round 5): festive / one-off leave grant, now multi-company. Credits N extra days to
 * everyone in EACH selected company (or group-wide) for a chosen leave type on a chosen date, with a reason
 * (e.g. "CNY 2026"). Each company gets its own per-company audit entry (the event log), exactly as if
 * granted separately. `companies` is already narrowed by the page to only the companies this admin
 * administers (group admins see all) — so Select all here always succeeds.
 */
export function FestiveGrantCard({
  companies,
  canGroupWide,
  leaveTypes,
  recent,
  defaultDate,
}: {
  companies: FestiveCompanyOption[];
  /** Group admins only — shows the "All companies (group-wide)" checkbox, which targets EVERY active
   *  employment with no company filter (including staff of archived companies), same as round-4 semantics. */
  canGroupWide: boolean;
  leaveTypes: FestiveLeaveTypeOption[];
  recent: FestiveGrantRow[];
  /** Today's ISO date for the effective-date default. */
  defaultDate: string;
}) {
  const t = useTranslations('admin.leave');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [groupWide, setGroupWide] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [daysError, setDaysError] = useState<string | null>(null);
  const [days, setDays] = useState('1');

  const validateDays = (v: string): string | null => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return t('festiveDaysIncrementError');
    if (!Number.isInteger(n * 2)) return t('festiveDaysIncrementError');
    if (n > 366) return t('festiveDaysMaxError');
    return null;
  };

  const onDaysChange = (v: string) => {
    setDays(v);
    setDaysError(validateDays(v));
  };

  const onSubmit = (formData: FormData) =>
    start(async () => {
      setError(null);
      const daysCheck = validateDays(days);
      if (daysCheck) {
        setDaysError(daysCheck);
        return;
      }
      if (!groupWide && selected.size === 0) {
        setError(t('festiveCompaniesRequired'));
        return;
      }
      if (groupWide) {
        formData.set('groupWide', '1');
      } else {
        formData.delete('groupWide');
      }
      const res = await grantAdHocLeaveAction(formData);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (groupWide) {
        toast.success(t('festiveGrantedToast', { count: res.granted ?? 0, targeted: res.targeted ?? 0 }));
      } else {
        toast.success(
          t('festiveGrantedMultiToast', {
            count: res.granted ?? 0,
            targeted: res.targeted ?? 0,
            companies: res.companies ?? 0,
          }),
        );
      }
      setSelected(new Set());
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <p className="px-4 pt-3 text-xs text-muted-foreground">{t('festiveHelp')}</p>
      {error && (
        <p className="mx-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}
      <form action={onSubmit} className="flex flex-wrap items-end gap-3 px-4">
        <MultiSelectPopover
          label={t('festiveCompaniesLabel')}
          allLabel={t('festiveCompaniesPlaceholder')}
          options={companies}
          selected={selected}
          onChange={setSelected}
          searchPlaceholder={t('festiveCompanySearchPlaceholder')}
          selectAllLabel={t('festiveSelectAll')}
          clearAllLabel={t('festiveClearAll')}
          selectedCount={(n) => t('festiveSelectedCount', { count: n })}
          name="companyIds"
          disabled={groupWide}
        />
        {canGroupWide && (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={groupWide}
              onChange={(e) => setGroupWide(e.target.checked)}
              className="size-4 accent-[var(--color-primary)]"
            />
            {t('festiveCompanyGroupWide')}
          </label>
        )}
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
          <input
            name="days"
            type="number"
            min="0.5"
            max="366"
            step="0.5"
            required
            value={days}
            onChange={(e) => onDaysChange(e.target.value)}
            className={`${inputCls} w-24`}
          />
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
        <Button type="submit" size="sm" disabled={pending || !!daysError}>
          {pending ? t('festiveGrantingButton') : t('festiveGrantButton')}
        </Button>
      </form>
      {daysError && <p className="mx-4 -mt-2 text-xs text-destructive">{daysError}</p>}

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
