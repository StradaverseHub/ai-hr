'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from './ui';

/** Feedback 31474452 (Step 5): the shape previewLeaveDeduction / the server-action wrappers return. */
export type LeavePreview = {
  days: number;
  balanceAvailable: number;
  balanceAfter: number;
  hasHalfScheduleDate: boolean;
  isEmergencySplit: boolean;
};

/** The four duration types. full_day is always available; the other three are per-type opt-in. */
const ALL_DURATIONS = ['full_day', 'half_day_am', 'half_day_pm', 'hourly'] as const;
type Duration = (typeof ALL_DURATIONS)[number];

export type LeaveTypeOption = {
  id: string;
  label: string;
  durations: string[] | null;
  code?: string;
  /** Feedback 9d8cf621: optional HR-authored custom message shown to the employee when this type is selected
   *  on the apply form. Absent/empty ⇒ no notice. */
  applyNotice?: string | null;
};

/**
 * ADR-0048 client wrapper for the leave apply forms. It owns the Leave Type <select>, the Leave Duration
 * Type <select> (all four options, disabling the ones the selected type does not allow), a conditional
 * Hours input for 'hourly', the Start date, and the End date — which is shown only for full_day; for any
 * half/hourly value the End date is hidden and end is forced equal to start (single-day). The service-layer
 * LeaveDurationNotAllowedError remains the real guard. Field names are passed in so this fits both the
 * /leave and /me forms; extra controls (employee select, reason, document) stay in the parent <form>.
 *
 * Supporting-document config (Leave-Tab standardization): when `showDocumentFields` is set (the /leave
 * form), this component additionally renders the Supporting-document <input type=file> + Employee-remark
 * <textarea> INSIDE itself, so it can hide both when the selected type is EMERGENCY — EL decomposes into
 * child rows that never carry a document/remark, so attaching one would dangle a file on a hidden child.
 * The /me form leaves `showDocumentFields` off and renders its own doc/remark fields (EL is not selectable
 * there), so /me is untouched.
 */
export function LeaveDurationFields({
  types,
  startDefault,
  layout = 'grid',
  showDocumentFields = false,
  employeeOptions,
  action: previewAction,
}: {
  types: LeaveTypeOption[];
  startDefault?: string;
  /** 'grid' = two-up for the /leave page; 'stack' = single-column for the /me sidebar. */
  layout?: 'grid' | 'stack';
  /** Supporting-document config: render the doc/remark fields here (and hide them for EMERGENCY). */
  showDocumentFields?: boolean;
  /** /leave only: renders the "Employee" <select> INSIDE this component (instead of the parent form) so the
   *  preview below can read the currently-selected employmentId reactively. /me omits this — the preview
   *  action there resolves the caller's own employment server-side. */
  employeeOptions?: { id: string; name: string }[];
  /** Feedback 31474452 (Step 5): server action returning a LeavePreview | null for the current
   *  {employmentId, leaveTypeId, startDate, endDate, durationType}. Omit to render no preview line (e.g. an
   *  admin on-behalf form that doesn't want it). Day-based durations only — hourly keeps hourlyTotal below.
   *  Named `action` (not previewAction) so source guards that assert every server action is bound as
   *  `action={...}` — e.g. test/me-tabs.test.ts — see this binding too; internally it stays previewAction. */
  action?: (p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    durationType: Duration;
  }) => Promise<LeavePreview | null>;
}) {
  const t = useTranslations('leave');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [duration, setDuration] = useState<Duration>('full_day');
  const [start, setStart] = useState(startDefault ?? '');
  const [end, setEnd] = useState(startDefault ?? '');
  const [employmentId, setEmploymentId] = useState(employeeOptions?.[0]?.id ?? '');
  // Hourly-leave time window (0129): the two time pickers are controlled so we can show a live "Total: Nh"
  // as the user picks. This client total is DISPLAY-ONLY — the server recomputes hours authoritatively from
  // the same window on submit (the `required` attributes + the service-boundary throw are the real gates).
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [preview, setPreview] = useState<LeavePreview | null>(null);
  const [isPreviewing, startPreviewTransition] = useTransition();

  const selected = types.find((x) => x.id === typeId);
  const allowed = new Set<Duration>(['full_day', ...((selected?.durations ?? []) as Duration[])]);
  // If the selected type does not allow the current duration, fall back to full_day (defensive).
  const effectiveDuration: Duration = allowed.has(duration) ? duration : 'full_day';
  void layout; // layout currently affects only the parent wrapper; the date row is two-up in both.
  // Emergency Leave (Phase-B #12, ADR-0061): when EL is selected, surface the reason-category select (illness
  // routes through paid SICK first) and the unpaid-days acknowledgement. The server is the authoritative gate
  // — it throws UnpaidConsentRequiredError when the cascade would create an UNPAID child without this consent.
  const isEmergency = selected?.code === 'EMERGENCY';
  // Maternity (Phase-B #13, ADR-0062): when MATERNITY is selected, capture the EA s.37 paid-allowance facts —
  // surviving-children count + confinement date. The 98-day leave is always granted; the server computes
  // whether the paid ALLOWANCE is withheld (qualifying-service / 5th-child) and, if so, grants the leave
  // UNPAID. Missing inputs default to paid + a "paid-allowance unconfirmed" warning, so they are optional.
  const isMaternity = selected?.code === 'MATERNITY';

  // Hourly-leave time window (0129): mirror the server's hoursBetween for the live total. Normalize via
  // slice(0, 5) (the seconds hazard) and only show a positive elapsed span. null hides the badge.
  const hourlyTotal = (() => {
    if (effectiveDuration !== 'hourly' || !fromTime || !toTime) return null;
    const mins = (s: string) => {
      const [h, m] = s.slice(0, 5).split(':').map(Number);
      return h * 60 + m;
    };
    const span = mins(toTime) - mins(fromTime);
    if (!(span > 0)) return null;
    return Math.round((span / 60) * 100) / 100;
  })();

  // Feedback 31474452 (Step 5): debounced pre-submission preview — "this will deduct X day(s)" + balance
  // before/after. Day-based durations only (hourly keeps the hourlyTotal display above, no server preview).
  // The server action remains the authoritative gate at submit; this is read-only and best-effort.
  useEffect(() => {
    // employmentId is required only when the caller renders the employee select here (/leave, on-behalf-of);
    // /me has no employeeOptions and resolves the caller's own employment server-side (see
    // app/me/actions.ts myPreviewLeaveDeduction), so an empty employmentId is fine there.
    const employmentReady = !employeeOptions || !!employmentId;
    if (!previewAction || effectiveDuration === 'hourly' || !employmentReady || !typeId || !start) {
      setPreview(null);
      return;
    }
    const endDate = effectiveDuration === 'full_day' ? end || start : start;
    if (effectiveDuration === 'full_day' && endDate < start) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(() => {
      startPreviewTransition(async () => {
        const r = await previewAction({
          employmentId,
          leaveTypeId: typeId,
          startDate: start,
          endDate,
          durationType: effectiveDuration,
        });
        setPreview(r);
      });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewAction, employeeOptions, employmentId, typeId, effectiveDuration, start, end]);

  return (
    <>
      {employeeOptions && (
        // /leave only: rendered here (not the parent form) so the preview effect above can read the current
        // selection reactively. Field name matches the parent form's original <select name="employmentId">.
        <Field label={t('fieldEmployee')}>
          <select
            name="employmentId"
            required
            value={employmentId}
            onChange={(e) => setEmploymentId(e.target.value)}
            className={inputCls}
          >
            {employeeOptions.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
      )}

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

      {/* Feedback 9d8cf621: HR-authored custom message for the selected leave type, shown to the employee on
          the apply form. Rendered only when the selected type carries a non-empty applyNotice. */}
      {selected?.applyNotice && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">
          {selected.applyNotice}
        </div>
      )}

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
        // Hourly-leave time window (0129): pick a From + To time (both required); the server derives the
        // deducted hours from the elapsed span. step="900" constrains the picker to 15-minute granularity so
        // deductions stay sane (the derived `days` is still re-rounded to 2 dp after hours/8). The live total
        // below is display-only — the server recomputes authoritatively on submit.
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('fieldFromTime')}>
              <input
                name="fromTime"
                type="time"
                step="900"
                required
                value={fromTime}
                onChange={(e) => setFromTime(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('fieldToTime')}>
              <input
                name="toTime"
                type="time"
                step="900"
                required
                value={toTime}
                onChange={(e) => setToTime(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
          {hourlyTotal != null && (
            <p className="text-xs font-medium text-muted-foreground">
              {t('hourlyTotal', { hours: hourlyTotal })}
            </p>
          )}
        </>
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
            <input
              name="endDate"
              type="date"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className={inputCls}
            />
          </Field>
        ) : (
          // Half/hourly is single-day: force end = start, no visible End-date field.
          <input type="hidden" name="endDate" value={start} readOnly />
        )}
      </div>

      {/* Feedback 31474452 (Step 5): pre-submission preview line. Shown for day-based durations only when a
          previewAction was supplied and a result has resolved. Best-effort — a null result (RLS-gated, still
          loading, or an invalid range) simply shows nothing, never blocking the form. */}
      {previewAction && effectiveDuration !== 'hourly' && (preview || isPreviewing) && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
          {preview ? (
            <>
              <p className="font-medium text-foreground">
                {preview.isEmergencySplit
                  ? t('preview.willDeductEmergency', { days: preview.days })
                  : t('preview.willDeduct', { days: preview.days })}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t('preview.balanceLine', { before: preview.balanceAvailable, after: preview.balanceAfter })}
              </p>
              {preview.hasHalfScheduleDate && (
                <p className="mt-0.5 text-muted-foreground">{t('preview.halfScheduleDayNote')}</p>
              )}
              {preview.isEmergencySplit && (
                <p className="mt-0.5 text-muted-foreground">{t('preview.emergencySplitNote')}</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">{t('preview.loading')}</p>
          )}
        </div>
      )}

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

      {isMaternity && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">{t('maternity.allowanceNotice')}</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('maternity.confinementDateLabel')}>
              <input name="confinementDate" type="date" className={inputCls} />
            </Field>
            <Field label={t('maternity.survivingChildrenLabel')}>
              <input
                name="survivingChildren"
                type="number"
                min="0"
                step="1"
                placeholder="0"
                className={inputCls}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('maternity.allowanceHint')}</p>
        </div>
      )}

      {/* Supporting-document config (Leave-Tab standardization): the same attach + remark fields the /me form
          offers. Hidden for EMERGENCY — EL auto-decomposes into ANNUAL+UNPAID child rows that never carry a
          document or remark, so attaching one would dangle a file on a hidden child. The /leave action
          backstops this server-side (it ignores any posted file/remark when the type is EMERGENCY). */}
      {showDocumentFields && !isEmergency && (
        <>
          <Field label={t('documentLabel')}>
            <input
              type="file"
              name="document"
              accept="image/jpeg,image/png,application/pdf"
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('documentHint')}</p>
          </Field>
          <Field label={t('employeeRemarkLabel')}>
            <textarea name="employeeRemark" rows={2} className={inputCls} />
            <p className="mt-1 text-xs text-muted-foreground">{t('employeeRemarkRequiredHint')}</p>
          </Field>
        </>
      )}
    </>
  );
}
