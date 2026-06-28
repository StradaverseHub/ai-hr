'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from './ui';

/** The four duration types. full_day is always available; the other three are per-type opt-in. */
const ALL_DURATIONS = ['full_day', 'half_day_am', 'half_day_pm', 'hourly'] as const;
type Duration = (typeof ALL_DURATIONS)[number];

export type LeaveTypeOption = { id: string; label: string; durations: string[] | null; code?: string };

/**
 * ADR-0048 client wrapper for the leave apply forms. It owns the Leave Type <select>, the Leave Duration
 * Type <select> (all four options, disabling the ones the selected type does not allow), a conditional
 * Hours input for 'hourly', the Start date, and the End date — which is shown only for full_day; for any
 * half/hourly value the End date is hidden and end is forced equal to start (single-day). The service-layer
 * LeaveDurationNotAllowedError remains the real guard. Field names are passed in so this fits both the
 * /leave and /me forms; extra controls (employee select, reason, document) stay in the parent <form>.
 */
export function LeaveDurationFields({
  types,
  startDefault,
  layout = 'grid',
}: {
  types: LeaveTypeOption[];
  startDefault?: string;
  /** 'grid' = two-up for the /leave page; 'stack' = single-column for the /me sidebar. */
  layout?: 'grid' | 'stack';
}) {
  const t = useTranslations('leave');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [duration, setDuration] = useState<Duration>('full_day');
  const [start, setStart] = useState(startDefault ?? '');

  const selected = types.find((x) => x.id === typeId);
  const allowed = new Set<Duration>(['full_day', ...((selected?.durations ?? []) as Duration[])]);
  // If the selected type does not allow the current duration, fall back to full_day (defensive).
  const effectiveDuration: Duration = allowed.has(duration) ? duration : 'full_day';
  void layout; // layout currently affects only the parent wrapper; the date row is two-up in both.
  // Emergency Leave (Phase-B #12, ADR-0061): when EL is selected, surface the reason-category select (illness
  // routes through paid SICK first) and the unpaid-days acknowledgement. The server is the authoritative gate
  // — it throws UnpaidConsentRequiredError when the cascade would create an UNPAID child without this consent.
  const isEmergency = selected?.code === 'EMERGENCY';

  return (
    <>
      <Field label={t('fieldLeaveType')}>
        <select
          name="leaveTypeId"
          required
          value={typeId}
          onChange={(e) => {
            setTypeId(e.target.value);
            setDuration('full_day');
          }}
          className={inputCls}
        >
          {types.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('fieldDurationType')}>
        <select
          name="durationType"
          value={effectiveDuration}
          onChange={(e) => setDuration(e.target.value as Duration)}
          className={inputCls}
        >
          {ALL_DURATIONS.map((d) => (
            <option key={d} value={d} disabled={!allowed.has(d)}>
              {t(`duration.${d}`)}
            </option>
          ))}
        </select>
      </Field>

      {effectiveDuration === 'hourly' && (
        <Field label={t('fieldHours')}>
          <input
            name="hours"
            type="number"
            min="0.5"
            max="8"
            step="0.5"
            required
            placeholder={t('hoursPlaceholder')}
            className={inputCls}
          />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('fieldStartDate')}>
          <input
            name="startDate"
            type="date"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={inputCls}
          />
        </Field>
        {effectiveDuration === 'full_day' ? (
          <Field label={t('fieldEndDate')}>
            <input name="endDate" type="date" required defaultValue={startDefault} className={inputCls} />
          </Field>
        ) : (
          // Half/hourly is single-day: force end = start, no visible End-date field.
          <input type="hidden" name="endDate" value={start} readOnly />
        )}
      </div>

      {isEmergency && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          <Field label={t('emergency.reasonCategoryLabel')}>
            <select name="reasonCategory" defaultValue="personal" className={inputCls}>
              <option value="illness">{t('emergency.reasonCategory.illness')}</option>
              <option value="personal">{t('emergency.reasonCategory.personal')}</option>
              <option value="other">{t('emergency.reasonCategory.other')}</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{t('emergency.reasonCategoryHint')}</p>
          </Field>
          {/* The computed split (paid days vs unpaid days) is resolved server-side at submit; this notice +
              acknowledgement is required because any AL/SICK shortfall becomes UNPAID (no-work-no-pay). */}
          <p className="text-xs text-muted-foreground">{t('emergency.splitNotice')}</p>
          <label className="flex items-start gap-2 text-xs text-foreground">
            <input type="checkbox" name="unpaidConsent" className="mt-0.5 h-4 w-4 rounded border-border" />
            <span>{t('emergency.unpaidConsentLabel')}</span>
          </label>
        </div>
      )}
    </>
  );
}
