'use client';

import { startTransition, useActionState, useMemo, useState, type MouseEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Badge, Button, inputCls, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { Drawer } from '@/components/ui/drawer';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import type { OfflineReviewRow, OfflineReviewStatus } from './offline-data';
import { resolveOfflineClaimAction, type OfflineResolveResult } from './offline-actions';
import { defaultOfflineResolutionTime, offlineResolutionTimes } from './offline-time';

/**
 * Offline punches — HR's review of punches an employee recorded in the mobile app without a connection that the
 * server held for review (draft 0647; owner-approved design 2026-10-28). A row opens the shared side drawer; the
 * decision is posted to resolveOfflineClaimAction, which re-checks everything server-side.
 *
 * THE PHOTO. Its bytes are never in this payload: the thumbnail is an <img> on the audited photo route, rendered only
 * while the drawer is open, so each view of it is one recorded read. A group admin sees no retained photo and gets no
 * Accept while it is kept (owner decision D-B); Reject stays.
 */
const BADGE: Record<OfflineReviewStatus, 'warning' | 'accent' | 'success' | 'default'> = {
  needs_review: 'warning',
  pending: 'accent',
  accepted: 'success',
  rejected: 'default',
  cancelled: 'default',
};

function useFormat() {
  const locale = useLocale();
  return useMemo(() => {
    const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: HR_LOCAL_TZ });
    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: HR_LOCAL_TZ });
    const seconds = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: HR_LOCAL_TZ });
    const minutes = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: HR_LOCAL_TZ });
    return {
      dateTime: (at: number) => dateTime.format(new Date(at)),
      date: (at: number) => date.format(new Date(at)),
      time: (at: number) => seconds.format(new Date(at)),
      option: (at: number, step: 'second' | 'minute', withDate: boolean) =>
        `${withDate ? `${date.format(new Date(at))} ` : ''}${(step === 'second' ? seconds : minutes).format(new Date(at))}`,
    };
  }, [locale]);
}

export function OfflineClaimsReview({ rows, groupAdmin, all }: { rows: readonly OfflineReviewRow[]; groupAdmin: boolean; all: boolean }) {
  const t = useTranslations('offlineClocking');
  const f = useFormat();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((row) => row.id === openId) ?? null;
  const name = (row: OfflineReviewRow) => row.employeeName ?? t('review.unknownEmployee');
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{t(all ? 'review.emptyAll' : 'review.empty')}</p>;
  return (
    <>
      <div className={tableWrapCls}>
        <table className="w-full min-w-[640px] text-sm">
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>{t('review.colEmployee')}</th>
              <th className={thCls}>{t('review.colPunch')}</th>
              <th className={thCls}>{t('review.colWhy')}</th>
              <th className={thCls}>{t('review.colStatus')}</th>
            </tr>
          </thead>
          <tbody className={tbodyCls}>
            {rows.map((row) => (
              <tr key={row.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpenId(row.id)}>
                <td className="px-3 py-2">
                  <button type="button" className="text-left font-medium text-primary hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(row.id); }}>
                    {name(row)}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <p>{t('review.punch', { direction: t(`review.direction.${row.action}`), datetime: f.dateTime(row.decidedAt ?? row.claimedAt) })}</p>
                  <p className="text-xs text-muted-foreground">{t('review.received', { datetime: f.dateTime(row.receivedAt) })}</p>
                </td>
                <td className="px-3 py-2">{t(`reasons.${reasonKey(row.reason)}`)}</td>
                <td className="px-3 py-2"><Badge variant={BADGE[row.status]}>{t(`review.status.${row.status}`)}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <OfflineClaimPanel key={open.id} row={open} groupAdmin={groupAdmin} name={name(open)} onClose={() => setOpenId(null)} />}
    </>
  );
}

/** Every review reason has a label; an unknown stored value (a reason added later) reads as the generic one. */
const REASONS = new Set(['continuity_unknown', 'time_unverifiable', 'outside_context_window', 'policy_changed', 'site_changed', 'attendance_changed', 'corrected_day', 'payroll_locked',
  'location_required', 'poor_accuracy', 'outside_geofence', 'mock_reported', 'simulated_reported', 'accessory_reported', 'photo_required', 'photo_invalid', 'scope_changed',
  'device_required', 'review_required', 'offline_disabled', 'proven_window_too_wide', 'employment_inactive', 'overtime_settled']);
const reasonKey = (reason: string) => (REASONS.has(reason) ? reason : 'review_required');

export function OfflineClaimPanel({ row, groupAdmin, name, onClose }: { row: OfflineReviewRow; groupAdmin: boolean; name: string; onClose: () => void }) {
  const t = useTranslations('offlineClocking');
  const f = useFormat();
  const router = useRouter();
  const [result, dispatch, pending] = useActionState<OfflineResolveResult, FormData>(resolveOfflineClaimAction, null);
  const times = useMemo(() => offlineResolutionTimes(row.effectiveMinimum, row.effectiveMaximum), [row.effectiveMinimum, row.effectiveMaximum]);
  const [at, setAt] = useState<number | null>(() => defaultOfflineResolutionTime(times.values, row.decidedAt ?? row.claimedAt));
  const [reason, setReason] = useState('');

  const photoKept = row.photo?.retained === true;
  const open = row.status === 'needs_review' && !result?.ok;
  const mayAccept = open && times.values.length > 0 && !(groupAdmin && photoKept);
  const spansDays = row.effectiveMinimum !== null && row.effectiveMaximum !== null && f.date(row.effectiveMinimum) !== f.date(row.effectiveMaximum);
  const submit = (decision: 'accepted' | 'rejected') => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const form = event.currentTarget.form;
    if (!form) return;
    const data = new FormData(form);
    data.set('decision', decision);
    if (decision === 'rejected') data.delete('effectiveAt');
    startTransition(() => dispatch(data));
  };

  return (
    <Drawer
      open
      // The list refreshes when the decided panel closes, so the outcome stays readable until then.
      onOpenChange={(next) => { if (next) return; if (result?.ok) router.refresh(); onClose(); }}
      title={t(row.action === 'in' ? 'review.titleIn' : 'review.titleOut', { name })}
      headerExtra={<Badge variant={BADGE[result?.ok ? result.status : row.status]}>{t(`review.status.${result?.ok ? result.status : row.status}`)}</Badge>}
      footer={open ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="submit" form={`offline-claim-${row.id}`} variant="outline" disabled={pending} onClick={submit('rejected')}>{t('review.reject')}</Button>
          {mayAccept && <Button type="submit" form={`offline-claim-${row.id}`} disabled={pending || at === null} onClick={submit('accepted')}>{t('review.accept')}</Button>}
        </div>
      ) : undefined}
    >
      <div className="space-y-4 text-sm">
        <p>
          {row.effectiveMinimum !== null && row.effectiveMaximum !== null
            ? t('review.recorded', { date: f.date(row.effectiveMinimum), min: f.time(row.effectiveMinimum), max: f.time(row.effectiveMaximum), claimed: f.dateTime(row.claimedAt) })
            : t('review.recordedNoRange', { claimed: f.dateTime(row.claimedAt) })}
        </p>
        {photoKept && !groupAdmin && (
          // eslint-disable-next-line @next/next/no-img-element -- an audited, uncached, authenticated read; next/image would cache it
          <img src={`/attendance/offline-claims/${encodeURIComponent(row.id)}/photo`} alt={t('review.photoAlt', { name })} className="h-40 w-auto rounded-md border border-border object-contain" />
        )}
        {photoKept && groupAdmin && <p className="text-muted-foreground">{t('review.groupAdminPhoto')}</p>}
        <p>{t('review.heldBecause', { reason: t(`reasonDetails.${reasonKey(row.reason)}`) })}</p>
        {row.photo && (photoKept
          ? <p className="text-xs text-muted-foreground">{t('review.photoKept', { date: f.date(row.photo.retainedUntil) })}</p>
          : <p className="text-xs text-muted-foreground">{t('review.photoGone')}</p>)}
        {row.resolutionReason && <p>{t('review.decisionReason', { reason: row.resolutionReason })}</p>}
        {result?.ok && <p role="status" className="text-muted-foreground">{t(`review.done.${result.status}`)}</p>}
        {open && (
          <form id={`offline-claim-${row.id}`} className="space-y-3" onSubmit={(e) => e.preventDefault()}>
            <input type="hidden" name="claimId" value={row.id} />
            {mayAccept && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`offline-time-${row.id}`} className="text-xs font-medium text-muted-foreground">{t('review.time')}</label>
                <select id={`offline-time-${row.id}`} name="effectiveAt" value={at ?? ''} onChange={(e) => setAt(Number(e.target.value))} aria-describedby={`offline-time-help-${row.id}`} className={inputCls}>
                  {times.values.map((value) => <option key={value} value={value}>{f.option(value, times.step, spansDays)}</option>)}
                </select>
                <p id={`offline-time-help-${row.id}`} className="text-xs text-muted-foreground">{t(times.step === 'second' ? 'review.timeHelpSeconds' : 'review.timeHelpMinutes')}</p>
              </div>
            )}
            {open && times.values.length === 0 && <p className="text-muted-foreground">{t('review.noRange')}</p>}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`offline-reason-${row.id}`} className="text-xs font-medium text-muted-foreground">{t('review.reason')}</label>
              <textarea id={`offline-reason-${row.id}`} name="reason" required maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
            </div>
            {result && !result.ok && <p role="alert" className="text-destructive">{t(`review.errors.${result.error}`)}</p>}
          </form>
        )}
      </div>
    </Drawer>
  );
}
