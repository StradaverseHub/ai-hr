'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Field, inputCls } from './ui';
// 4a1abc4a: the per-date preview quotes a fraction of a day ("Yes (0.5)"); the ledger row it becomes reads
// "0.50", so the preview says it the same way.
import { DAY_DASH, formatDays } from '@/lib/day-format';

/** Employee apply-popup day-by-day panel: one row per date in the requested span. `status` mirrors
 *  core/leave.ts LeaveApplyDayStatus (rest and off day are ONE bucket, matching dayWeight's Phase-A collapse)
 *  and `days` is the exact weight that date contributes, so the rows always sum to `days` below. Only the
 *  ISO date is carried — the weekday is derived client-side via Intl so it has ONE source. */
export type LeaveApplyDayRow = { date: string; status: string; days: number };

/** Feedback 31474452 (Step 5): the shape previewLeaveDeduction / the server-action wrappers return. */
export type LeavePreview = {
  days: number;
  balanceAvailable: number;
  balanceAfter: number;
  hasHalfScheduleDate: boolean;
  isEmergencySplit: boolean;
  /** Present only when the caller asked for the day-by-day detail (the /leave apply popup does). */
  dayRows?: LeaveApplyDayRow[];
  /** Allow Unpaid Leave (a7fab30b): how many of `days` the balance will not cover. Present only when the
   *  selected type allows unpaid leave AND the request actually overflows — absent means fully paid. */
  unpaidDays?: number;
  /** Override Leave Application (56910869): the rule(s) HR configured that WOULD change this application if
   *  it were submitted now. Absent (never an empty array) when nothing fires, which is every leave type
   *  until HR enables a rule — so no other type gains a line.
   *
   *  Declared structurally rather than imported from core/leave-override: this is a client component and the
   *  leave pack's modules are server-side (the ADR-0080 ratchet). The shape crosses the boundary as plain
   *  serialisable data on the preview action's return value, which is the only thing that may cross it. */
  overrides?: LeaveOverrideNotice[];
};

/** One configured exception the employee must be told about — and, unless it merely refuses, agree to. */
export type LeaveOverrideNotice = {
  trigger: string;
  action: string;
  /** Posted back as `overrideConsent` when the employee ticks Yes. The SERVICE refuses the rule without it. */
  consentToken: string;
  /** false for a `block` rule: there is nothing to agree to, only a refusal to explain up front. */
  needsConsent: boolean;
  fromTypeName: string | null;
  daysInAdvance?: number;
  minAdvanceDays?: number | null;
  /** Advance Notice — calendar days or working days (7daac043): the UNIT both figures above are measured in.
   *  Absent ⇒ calendar days, the reading every leave type had before it shipped. READ IT before wording the
   *  notice: on a working-days type `daysInAdvance` is a working-day count, so printing it under the
   *  calendar-days sentence tells an employee they gave 3 days' notice when their wall calendar says 5 — on
   *  the very dialog they must tick to consent. */
  minAdvanceDayType?: 'calendar_days' | 'working_days';
  paidDays?: number;
  unpaidDays?: number;
};

/** Employee apply-popup entitlement summary. A null figure means HR gated that component out of the employee
 *  self-service view (leave_type.ess_view_config) and it renders as a dash.
 *
 *  Only `pending` and `available` are RENDERED by the popup as of r76 (feedback 082fa566): while applying,
 *  the employee needs what is already spoken for and what is left, not the history or the intermediate.
 *  `taken` and `balance` are still computed and carried unchanged — the shape is deliberately NOT pruned, so
 *  the server action's arithmetic stays byte-identical and the balance screens keep their source of truth. */
export type LeaveApplySummary = {
  pending: number | null;
  /** Computed as before; no longer rendered on the apply popup (it still leads the balance screens). */
  taken: number | null;
  /** Ledger balance, GROSS of pending — the figure Available is derived from. Computed as before; no longer
   *  rendered on the apply popup (feedback 082fa566, r76), still shown on the balance screens. */
  balance: number | null;
  /** balance − pending: what the employee can still apply for, and the figure the submit-time guard uses. */
  available: number | null;
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
  /** Balance Deduction Source (cdf9ca48): true when HR has pointed this type at another type's balance.
   *  Only consulted for EMERGENCY, whose special apply UI (reason category + unpaid-consent tick) belongs to
   *  the hardcoded ANNUAL+UNPAID decomposition — a configured source replaces that decomposition with the
   *  ordinary single-request path, so the special UI would collect answers nothing reads. Absent ⇒ false. */
  borrowsBalance?: boolean;
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
  eligibleTypeIdsByEmployment,
  action: previewAction,
  summaryAction,
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
  /**
   * ad965821 — which leave types each selectable employment actually qualifies for, resolved server-side by
   * the ONE gate in core/read.ts (conditions + employee_can_apply + hidden placement). Present only on the
   * on-behalf-of path, where the subject can change after the form is open; a plain self-service applicant
   * was already handed a list narrowed to them, so there is nothing left to re-draw.
   *
   * WHEN THIS IS PRESENT, `types` IS A SUPERSET AND MUST BE (rev 2). The filter below intersects `types`
   * with the selected subject's set, so whatever arrives in `types` bounds every subject: handing down the
   * VIEWER's own list produced eligible(manager) ∩ eligible(report), which is how a male manager lost the
   * ability to apply for Maternity on behalf of a female report. app/leave/page.tsx therefore passes the
   * UNION of every selectable subject's set, and this prop is what turns it back into one person's list.
   *
   * An ineligible type is ABSENT from the select — not disabled, not greyed, not counted. That is the
   * reporter's explicit ask, and a disabled <option> would still announce that the type exists.
   */
  eligibleTypeIdsByEmployment?: Record<string, string[]>;
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
  /** Employee apply-popup enhancement: the read-only entitlement summary for the selected leave type (of
   *  which the popup renders Pending approval / Available — see LeaveApplySummary), refreshed whenever the
   *  type (or the on-behalf employee) changes. REQUIRED — request-leave-dialog.tsx is
   *  the only consumer, so there is no "future caller" to keep optional. Best-effort: a null result renders
   *  nothing and never blocks the form. */
  summaryAction: (p: { employmentId: string; leaveTypeId: string }) => Promise<LeaveApplySummary | null>;
}) {
  const t = useTranslations('leave');
  // Cross-namespace reuse (already the convention on this page — app/leave/page.tsx holds two translators):
  // the column headers and the "{value} Days" figure format already exist elsewhere.
  const tAtt = useTranslations('attendance');
  const tCommon = useTranslations('common');
  const tMe = useTranslations('me');
  const locale = useLocale();
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
  const [summary, setSummary] = useState<LeaveApplySummary | null>(null);
  const [isSummarizing, startSummaryTransition] = useTransition();
  // Stale-response guards: switching type A → B → A must not let a slower earlier response overwrite the
  // newer one. Each effect stamps a monotonically increasing id and drops any reply that isn't the latest.
  const previewReq = useRef(0);
  const summaryReq = useRef(0);

  // ad965821 — the types on offer for the CURRENTLY selected subject: `types` (a superset when a map is
  // present — see the prop doc) intersected with that subject's own set. No map (the self-service path) or
  // no entry for this employment ⇒ the list is unchanged, so every existing caller behaves exactly as before.
  const visibleTypes = useMemo(() => {
    const allowed = eligibleTypeIdsByEmployment?.[employmentId];
    if (!allowed) return types;
    const set = new Set(allowed);
    return types.filter((x) => set.has(x.id));
  }, [types, eligibleTypeIdsByEmployment, employmentId]);

  // Switching employee must not carry the previous person's choice across: a leave type that does not apply
  // to the newly selected subject is dropped and the selection falls back to the first type that does. It
  // cannot simply be left pointing at the missing id — the summary and preview effects below are KEYED on
  // typeId, so a stale id would keep fetching figures for a type no longer on the list.
  useEffect(() => {
    if (visibleTypes.some((x) => x.id === typeId)) return;
    setTypeId(visibleTypes[0]?.id ?? '');
    setDuration('full_day');
  }, [visibleTypes, typeId]);

  const selected = types.find((x) => x.id === typeId);
  const allowed = new Set<Duration>(['full_day', ...((selected?.durations ?? []) as Duration[])]);
  // If the selected type does not allow the current duration, fall back to full_day (defensive).
  const effectiveDuration: Duration = allowed.has(duration) ? duration : 'full_day';
  void layout; // layout currently affects only the parent wrapper; the date row is two-up in both.
  // Emergency Leave (Phase-B #12, ADR-0061): when EL is selected, surface the reason-category select (illness
  // routes through paid SICK first) and the unpaid-days acknowledgement. The server is the authoritative gate
  // — it throws UnpaidConsentRequiredError when the cascade would create an UNPAID child without this consent.
  // Balance Deduction Source (cdf9ca48): …unless HR has given EL an explicit balance source, in which case
  // the server takes the ordinary single-request path and there is no cascade to consent to — so the special
  // UI comes off and the type renders like any other (balance summary and document fields included).
  const isEmergency = selected?.code === 'EMERGENCY' && !selected?.borrowsBalance;
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
      const req = ++previewReq.current;
      startPreviewTransition(async () => {
        const r = await previewAction({
          employmentId,
          leaveTypeId: typeId,
          startDate: start,
          endDate,
          durationType: effectiveDuration,
        });
        if (req !== previewReq.current) return; // a newer request has since been issued — drop this reply
        setPreview(r);
      });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewAction, employeeOptions, employmentId, typeId, effectiveDuration, start, end]);

  // Employee apply-popup enhancement: the entitlement summary for the selected leave type (rendered as
  // Pending approval / Available since r76; the action's payload is unchanged).
  // Keyed on (employmentId, typeId) ONLY — it is date-independent, so changing the dates must not re-fetch it.
  // Reuses the same employmentReady guard as the preview so the admin on-behalf path never renders the
  // admin's own figures under someone else's name while the selector is still empty.
  useEffect(() => {
    const employmentReady = !employeeOptions || !!employmentId;
    if (!employmentReady || !typeId) {
      setSummary(null);
      return;
    }
    const handle = setTimeout(() => {
      const req = ++summaryReq.current;
      startSummaryTransition(async () => {
        const r = await summaryAction({ employmentId, leaveTypeId: typeId });
        if (req !== summaryReq.current) return; // stale reply — a newer type/employee was picked meanwhile
        setSummary(r);
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [summaryAction, employeeOptions, employmentId, typeId]);

  // "{value} Days" — the same format the balance table uses; a gated (null) figure shows a dash.
  //
  // 4a1abc4a: THIS COMMENT USED TO BE FALSE. It borrowed the balance table's `daysValue` key but formatted
  // the number with `toFixed(1)`, so one balance read "12.5 Days" in this popup and "12.50 Days" in the
  // table it was quoting — the reported drift, between two views of the same figure, with a comment
  // asserting they agreed. Both now call the shared formatter, so the claim is true by construction.
  const daysValue = (v: number | null | undefined) =>
    v == null ? DAY_DASH : tMe('leaveBalanceTable.daysValue', { value: formatDays(v) });
  const fmtDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(
        new Date(`${iso}T00:00:00`),
      );
    } catch {
      return iso;
    }
  };
  const fmtWeekday = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(`${iso}T00:00:00`));
    } catch {
      return '';
    }
  };
  const dayRows = effectiveDuration === 'full_day' ? (preview?.dayRows ?? []) : [];

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
          {/* ad965821 — `visibleTypes`, not `types`. A type the subject does not qualify for is simply not
              here: no disabled option, no greyed row, no caption under the select saying one was left out. */}
          {visibleTypes.map((x) => (
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

      {/* Compact leave summary (Request-Leave popup redesign): the deductible-day Total sits BESIDE the
          Start/End date fields, replacing the old wordy "This will deduct X / Balance A → B" box (the balance
          figure stays in the Pending approval / Available table below, so nothing is lost).
          Layout: the date grid is grid-cols-2 with NO sm prefix (two-up even on a phone) while the dialog form
          is grid-cols-1 sm:grid-cols-2, so this wrapper stacks the badge UNDER the dates on mobile and places
          it to their right from sm up — a plain flex at all breakpoints would squeeze the 2-col date row on a
          narrow screen. sm:col-span-2 because these are direct items of the dialog's 2-column form grid. */}
      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-end sm:gap-3">
        <div className="grid flex-1 grid-cols-2 gap-2">
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
        {/* Day-based durations only — hourly keeps its own live "Total: N hours" line above. The figure is
            preview.days, the SAME fully-ruled deductible count (half-days, rest/off days, public holidays,
            work schedule, eligibility) the day-by-day panel footer totals; reusing applyDetails.total means
            the badge and that footer can never read differently, in any locale. Never recomputed here. */}
        {previewAction && effectiveDuration !== 'hourly' && (preview || isPreviewing) && (
          <div className="shrink-0 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
            {preview ? (
              <span className="font-medium tabular-nums text-foreground">
                {t('applyDetails.total', { days: preview.days })}
              </span>
            ) : (
              <span className="text-muted-foreground">{t('preview.loading')}</span>
            )}
          </div>
        )}
      </div>

      {/* Allow Unpaid Leave (a7fab30b): tell the employee how many days will be UNPAID before they submit —
          the reporter's point is that this must not first appear on a payslip. Rendered only when the split
          is real (the server omits unpaidDays for a fully-covered request, and for every leave type that has
          not opted in), so no other type gains a line. The figures come straight from the same measurement
          the submission will make — nothing is recomputed here, so the notice and the outcome cannot drift. */}
      {preview && (preview.unpaidDays ?? 0) > 0 && (
        <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-foreground sm:col-span-2">
          {t('unpaidSplit.notice', {
            paid: Math.round((preview.days - preview.unpaidDays!) * 100) / 100,
            unpaid: preview.unpaidDays!,
          })}
        </p>
      )}

      {/* ── Override Leave Application (56910869): TELL THE EMPLOYEE, THEN ASK ────────────────────────
          No application is silently turned into something else. When HR has configured an exception that
          would CHANGE this application — submit it as Emergency Leave because the notice period was missed,
          or take part of it unpaid because the balance falls short — the employee sees exactly what will
          happen and must tick Yes before the form will submit. Ticking nothing submits nothing.

          THE TICK IS NOT THE GATE. The service re-evaluates every rule at submission and refuses a
          converting rule whose token is missing (LeaveOverrideConsentRequiredError), so a client that skips
          this block cannot get a converted application through. This is how the employee is ASKED; the
          server is what makes the answer binding.

          A `block` rule renders as an explanation with no tick — there is nothing to agree to, and saying
          so here saves the employee filling in the rest of a form that will be refused. */}
      {(preview?.overrides ?? []).length > 0 && (
        <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40 sm:col-span-2">
          <p className="text-xs font-medium text-foreground">{t('override.title')}</p>
          {preview!.overrides!.map((o) => (
            <div key={o.consentToken} className="space-y-1.5">
              <p className="text-xs text-foreground">
                {o.action === 'convert_to_emergency'
                  ? // Advance Notice — calendar days or working days (7daac043). BOTH numbers in this
                    // sentence are counted in the rule's configured unit, so the sentence has to name that
                    // unit: a working-days rule gets the "working day(s)" wording, everything else keeps the
                    // sentence it has always had, word for word.
                    t(
                      o.minAdvanceDayType === 'working_days'
                        ? 'override.convertNoticeWorking'
                        : 'override.convertNotice',
                      {
                        typeName: o.fromTypeName ?? '',
                        days: o.minAdvanceDays ?? 0,
                        given: o.daysInAdvance ?? 0,
                      },
                    )
                  : o.action === 'split_unpaid'
                    ? t('override.splitNotice', { paid: o.paidDays ?? 0, unpaid: o.unpaidDays ?? 0 })
                    : t('override.blockNotice', { typeName: o.fromTypeName ?? '' })}
              </p>
              {o.needsConsent && (
                <label className="flex items-start gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    name="overrideConsent"
                    value={o.consentToken}
                    // required is the "No submits nothing and returns them to the form" half: the browser
                    // refuses the submission until it is ticked, so an employee who does not agree simply
                    // stays on the form with everything they typed intact.
                    required
                    className="mt-0.5 h-4 w-4 rounded border-border"
                  />
                  <span>
                    {o.action === 'convert_to_emergency'
                      ? t('override.convertConfirm')
                      : t('override.splitConfirm')}
                  </span>
                </label>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Employee apply-popup enhancement: compact Pending approval / Available for the selected leave type,
          refreshed on every type change. Suppressed for EMERGENCY — EL keeps no ledger of its own (it is
          drawn from annual/sick/unpaid at approval), so it would render a row of zeroes directly above a real
          day count.

          r76 (feedback 082fa566, same reporter, follow-up): this table used to carry four columns — Taken /
          Pending approval / Balance / Available — because r74 had put the word Available over the GROSS
          ledger figure (the reporter read 13.5 where their Leave Summary said 8.5), and r75 answered by
          showing the whole subtraction, Balance − Pending approval = Available, so the number was checkable
          rather than taken on trust. With Available now correct, the reporter asked for the derivation to
          come back OFF the apply form: while applying, only what is already spoken for (Pending approval) and
          what can still be applied for (Available) are decisions-relevant; Taken is history and Balance is an
          intermediate. Both remain in full on the leave balance screens (the entitlement side panel still
          renders leave.breakdown.field.taken / .balance — those keys are NOT orphans).

          This is DISPLAY-ONLY. leaveApplySummaryAction and LeaveApplySummary still compute and carry taken
          and balance exactly as before; two cells simply stopped being rendered. In particular `pending` and
          `available` are still PICKED verbatim from the same server action — `available` is
          availableLeaveBalance, the figure the submit-time guard measures against (the r72 cdf9ca48
          invariant), so the popup and the guard still cannot diverge. Nothing is recomputed here. */}
      {!isEmergency && (summary || isSummarizing) && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs sm:col-span-2">
          {summary ? (
            <table className="w-full">
              <thead>
                <tr className="text-muted-foreground">
                  <th scope="col" className="pb-0.5 text-right font-medium">
                    {t('breakdown.field.pendingApproval')}
                  </th>
                  <th scope="col" className="pb-0.5 text-right font-medium">
                    {/* "Available" is the leave type's own Leave Summary figure — balance minus the days this
                        employee has already applied for. r74 put the word here over the GROSS balance, which
                        is what the reporter saw as 13.5 vs 8.5; it reads summary.available, never
                        summary.balance. */}
                    {t('breakdown.field.available')}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="font-medium tabular-nums text-foreground">
                  <td className="text-right">{daysValue(summary.pending)}</td>
                  <td className="text-right">{daysValue(summary.available)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="text-muted-foreground">{tCommon('loading')}</p>
          )}
        </div>
      )}

      {/* Employee apply-popup enhancement: day-by-day breakdown of the requested span. A native
          <details>/<summary> disclosure (the pattern components/leave/leave-date-outcome.tsx and 25+ other
          places already use) — collapsed by default for free, correct aria semantics from the platform, no
          useState. The rows ride along on the preview call above, so expanding costs no network round-trip
          and the "Leave applied" column can never contradict the deducted-days figure. */}
      {dayRows.length > 0 && (
        <details className="sm:col-span-2">
          <summary className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline">
            {t('applyDetails.toggle')}
          </summary>
          {/* Fixed max height + its own scrollbar so a two-month request cannot stretch the popup down the
              screen; the header row stays visible while scrolling. */}
          <div className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border border-border bg-muted/30">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-2 py-1 text-left font-medium">{tAtt('colDate')}</th>
                  <th scope="col" className="px-2 py-1 text-left font-medium">{tAtt('colDay')}</th>
                  <th scope="col" className="px-2 py-1 text-left font-medium">{t('applyDetails.colStatus')}</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">{t('applyDetails.colApplied')}</th>
                </tr>
              </thead>
              <tbody>
                {dayRows.map((r) => (
                  <tr key={r.date} className="border-t border-border">
                    <td className="px-2 py-1 tabular-nums text-foreground">{fmtDate(r.date)}</td>
                    <td className="px-2 py-1 text-muted-foreground">{fmtWeekday(r.date)}</td>
                    <td className="px-2 py-1 text-muted-foreground">{t(`applyDayStatus.${r.status}`)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-foreground">
                      {r.days > 0
                        ? r.days < 1
                          ? `${t('applyDetails.yes')} (${formatDays(r.days)})`
                          : t('applyDetails.yes')
                        : t('applyDetails.no')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview && (
            // Closes the panel with the total, which MUST equal the deduction line above. Note a half working
            // day is a counted row worth 0.5, so counting "yes" rows will NOT equal this total.
            <p className="mt-1 text-right text-xs font-medium tabular-nums text-foreground">
              {t('applyDetails.total', { days: preview.days })}
            </p>
          )}
        </details>
      )}

      {/* The old "This will deduct X day(s) / Balance A → B" preview box lived here. It is replaced by the
          compact Total badge beside the dates above: the balance figure is already in the Pending approval /
          Available table, and the two contextual notes it carried are deliberately not re-hosted — the
          half-day-schedule detail stays visible inside the day-by-day panel (half rows read 0.5) and the
          emergency split reminder is already rendered in full by the isEmergency block below. */}

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
