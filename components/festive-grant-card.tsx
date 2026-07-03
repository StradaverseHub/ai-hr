'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
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
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [daysError, setDaysError] = useState<string | null>(null);
  const [days, setDays] = useState('1');

  const visibleCompanies = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter((c) => c.name.toLowerCase().includes(q));
  }, [companies, search]);
  const visibleIds = useMemo(() => new Set(visibleCompanies.map((c) => c.id)), [visibleCompanies]);

  const selectAllVisible = () => setSelected((prev) => new Set([...prev, ...visibleIds]));
  const clearAllVisible = () =>
    setSelected((prev) => new Set([...prev].filter((id) => !visibleIds.has(id))));

  const toggleCompany = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const triggerLabel =
    selected.size === 0 ? t('festiveCompaniesPlaceholder') : t('festiveSelectedCount', { count: selected.size });

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
        <Field label={t('festiveCompaniesLabel')}>
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              disabled={groupWide}
              className={cn(
                inputCls,
                'flex w-56 items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <span className="truncate">{triggerLabel}</span>
              <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
            </button>
            {open && !groupWide && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                <div className="absolute left-0 z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('festiveCompanySearchPlaceholder')}
                    className={`${inputCls} mb-2`}
                  />
                  <div className="mb-2 flex items-center gap-3 px-1 text-xs">
                    <button type="button" onClick={selectAllVisible} className="font-medium text-primary hover:underline">
                      {t('festiveSelectAll')}
                    </button>
                    <button type="button" onClick={clearAllVisible} className="font-medium text-muted-foreground hover:underline">
                      {t('festiveClearAll')}
                    </button>
                    <span className="ml-auto text-muted-foreground">{t('festiveSelectedCount', { count: selected.size })}</span>
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {companies.map((c) => (
                      <label
                        key={c.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                          !visibleIds.has(c.id) && 'hidden',
                        )}
                      >
                        <input
                          type="checkbox"
                          name="companyIds"
                          value={c.id}
                          checked={selected.has(c.id)}
                          onChange={() => toggleCompany(c.id)}
                          className="size-4 accent-[var(--color-primary)]"
                        />
                        <span className="truncate">{c.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </Field>
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
