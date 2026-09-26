'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button, Field, btnPrimary, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from '../ui';
import { eligibleExtendedMinutes, extendedHoursCreditDays, type ExtendedHoursTiers } from '@/lib/extended-hours';
// 4a1abc4a — every day figure a leave surface prints goes through ONE formatter, so 0.5 and 0.50 cannot
// appear on two screens for the same balance.
import { DAY_DASH, formatDays } from '@/lib/day-format';
// The pure vocabulary and the per-row conditional, from the module BOTH sides read — never from
// packs/leave/service, which is server-only (it drags db/client). lib/extended-hours.ts's precedent.
import { LEAVE_CREDIT_DAY_TYPES, adjudicateDayTypes, claimsTimeWindow, type LeaveCreditDayType } from '@/lib/leave-credit-day-type';

type Action = (fd: FormData) => void | Promise<void>;

/** The tenant's Replacement Leave type, already resolved by the page. Singular for 2a237f5f's reason. */
export type LeaveCreditLeaveTypeView = { id: string; name: string };

/** The read-only facts the roster and Attendance own for one date, as the server action returns them. */
export type LeaveCreditDayFacts = {
  /** What the ROSTER holds. The adjudication compares it with what the employee chose. */
  kind: LeaveCreditDayType;
  shiftEnd: string | null;
  actualClockOut: string | null;
  measuredExtendedMinutes: number;
};

type Row = {
  key: number;
  workedDate: string;
  dayType: LeaveCreditDayType | '';
  days: '1' | '0.5';
  claimStart: string;
  claimEnd: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
/** `18:30:00` → `18:30`. A time column comes back with seconds; nobody claims a shift end to the second. */
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const emptyRow = (key: number): Row => ({ key, workedDate: '', dayType: '', days: '1', claimStart: '', claimEnd: '' });

/**
 * r343 cbfa8b0b · THE LEAVE CREDIT REQUEST, AS ONE TABLE.
 *
 * ── THE LAYOUT REVERSAL IS THE POINT OF THIS COMPONENT ──────────────────────────────────────────────────
 * r336 drew this screen as one modal with TWO SECTIONS — non-working-day work, and extended hours on an
 * ordinary day — each with its own rows, its own "+ Add date" and its own total. The reporter's contest
 * says the opposite in as many words: "Do not create separate sections/screens for these day types. All
 * four types must be submitted from the same screen and displayed in the same request table." So there is
 * ONE table here, one "+ Add date", and one Total Credit.
 *
 * ── THE PER-ROW CONDITIONAL SURVIVES AS DISABLED CELLS, NEVER AS A SECOND SECTION ───────────────────────
 * An Ordinary Day row needs the hours claimed after the scheduled shift end; the other three day types do
 * not, because a rest day, off day or public holiday is claimed as a whole day or half of one. That is a
 * real difference and it does not go away by being asked for differently. It is expressed by DISABLING the
 * cells that mean nothing on the row's chosen day type — the Days cell on an Ordinary Day row, the two
 * claimed-time cells and the four derived cells on the other three — so the employee never has to work out
 * which section they are in, and an approver reads one table.
 *
 * ── DAY TYPE IS AN INPUT NOW. ⚠️ DELIBERATE CHANGE FROM r336, WHICH MADE IT READ-ONLY ───────────────────
 * The dropdown carries exactly the four options the reporter listed, and its LABELS are composed from the
 * `dayKind` keys that already exist in all six locales rather than from new English strings — a new key
 * would have put "Ordinary Day" in English on the five translated screens beside three translated
 * neighbours. The roster then ADJUDICATES: a row whose chosen type is not what the roster holds is marked
 * here, with the roster's own answer named on the row, and refused again by the service
 * (`adjudicateDayTypes`, core/leave-credit-request.ts) because this component is one `curl` away from
 * being irrelevant.
 *
 * ── WHY EVERY POSTED VALUE IS A HIDDEN INPUT, AND THE VISIBLE CONTROLS CARRY NO `name` ──────────────────
 * THIS IS LOAD-BEARING, NOT A STYLE. The action zips the repeated fields BY INDEX, and a browser does not
 * submit a DISABLED input at all — so naming the visible cells would post a `claimStart` list SHORTER than
 * the row list the moment one row was not an Ordinary Day, silently shifting every row after it. The row's
 * state is therefore the single source of what gets posted, through five hidden inputs that are present on
 * every row whatever its day type: each name's array is the same length as the table by construction, and a
 * cell that means nothing posts an empty string rather than nothing at all. The service reads by VALUE.
 *
 * ── EVERY FIGURE HERE IS FOR THE EMPLOYEE TO CHECK, NOT FOR THE SERVER TO TRUST ─────────────────────────
 * The eligible minutes, the per-row credit and the total are recomputed by the service from the posted
 * dates and windows before anything is stored, and again at approval from the live attendance row. The
 * arithmetic is IMPORTED from lib/extended-hours.ts rather than written twice, for the reason that file's
 * header gives: two implementations of "240 minutes is half a day" agree until a company moves a threshold,
 * and then the screen promises a credit the approval refuses.
 */
export function LeaveCreditRequestTable({
  replacementType,
  submitAction,
  today,
  requiresFirstScheduleConsent,
  dayFactsAction,
  extendedHoursTiers,
}: {
  replacementType: LeaveCreditLeaveTypeView;
  submitAction: Action;
  /** Resolves one date's roster kind and its two Attendance times, for the signed-in employee. */
  dayFactsAction: (workedDate: string) => Promise<LeaveCreditDayFacts | null>;
  /**
   * The company's tier figures, so the credit shown as the employee types is the one they will get. NULL
   * when the company has not switched extended hours on — the Ordinary Day option is then not offered,
   * and the service refuses such a row regardless (the hidden option is the courtesy, the refusal is the
   * control).
   */
  extendedHoursTiers: ExtendedHoursTiers | null;
  /** Today in the tenant's zone, resolved on the server — the max selectable worked date. */
  today: string;
  requiresFirstScheduleConsent?: boolean;
}) {
  const t = useTranslations('replacementRequest');
  // The four statuses of the requests table below share the vocabulary every other leave surface prints.
  const [rows, setRows] = useState<Row[]>([emptyRow(1)]);

  const ordinaryOffered = extendedHoursTiers != null;
  const dayTypeOptions = useMemo(
    () => LEAVE_CREDIT_DAY_TYPES.filter((d) => ordinaryOffered || !claimsTimeWindow(d)),
    [ordinaryOffered],
  );

  // One fetch per distinct date, marked as asked (null) at once so a re-render mid-flight does not re-ask.
  const [facts, setFacts] = useState<Record<string, LeaveCreditDayFacts | null>>({});
  const datesKey = rows.map((r) => r.workedDate).join('|');
  useEffect(() => {
    for (const d of new Set(datesKey.split('|').filter(Boolean))) {
      if (d in facts) continue;
      setFacts((prev) => (d in prev ? prev : { ...prev, [d]: null }));
      void dayFactsAction(d).then((v) => setFacts((prev) => ({ ...prev, [d]: v })));
    }
  }, [datesKey, dayFactsAction, facts]);

  const dayTypeLabel = (d: LeaveCreditDayType) =>
    d === 'rest_day'
      ? t('dayKind.restDay')
      : d === 'off_day'
        ? t('dayKind.offDay')
        : d === 'holiday'
          ? t('dayKind.holiday')
          : t('dayKind.workday');

  const addRow = () => setRows((r) => [...r, emptyRow((r[r.length - 1]?.key ?? 0) + 1)]);
  // Never remove the last row: an empty table has no "add" affordance attached to anything and reads as a
  // broken form. The service refuses a request with no rows anyway.
  const removeRow = (key: number) => setRows((r) => (r.length <= 1 ? r : r.filter((x) => x.key !== key)));
  const patch = (key: number, field: keyof Row, value: string) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, [field]: value } : x)));

  /**
   * One row's derived figures and its row-level problem, through the SAME two functions the service runs.
   *
   * `rosterMismatch` is the contest's new validation: the employee chose, the roster holds something else.
   * It is reported for ALL FOUR day types, which is what makes it more than the service's own
   * working/non-working check — a row typed "Public Holiday" on a date the roster calls a rest day is a
   * mismatch the layer below cannot see, because both produce the same claim path.
   */
  const derive = useCallback(
    (r: Row) => {
      const view = r.workedDate ? (facts[r.workedDate] ?? null) : null;
      const wantsWindow = r.dayType !== '' && claimsTimeWindow(r.dayType);
      // THE SAME FUNCTION THE SERVICE RUNS, not a second comparison that happens to agree today. One row in,
      // one row out: `adjudicateDayTypes` is where "chosen is not what the roster holds" is decided, for the
      // screen and for `submitLeaveCreditRequest` alike, so a change to the rule cannot land on one of them.
      const rosterMismatch =
        view != null && r.dayType !== ''
          ? (adjudicateDayTypes([{ workedDate: r.workedDate, dayType: r.dayType }], new Map([[r.workedDate, view.kind]]))[0]?.roster ??
            null)
          : null;
      if (!wantsWindow || !view || !extendedHoursTiers || !r.claimStart || !r.claimEnd)
        return { view, rosterMismatch, minutes: null as number | null, credit: null as number | null };
      const minutes = eligibleExtendedMinutes({
        claimStart: r.claimStart,
        claimEnd: r.claimEnd,
        shiftEnd: view.shiftEnd,
        actualClockOut: view.actualClockOut,
        measuredExtendedMinutes: view.measuredExtendedMinutes,
      });
      const { countedMinutes, days } = extendedHoursCreditDays(minutes, extendedHoursTiers);
      return { view, rosterMismatch, minutes: countedMinutes, credit: days };
    },
    [facts, extendedHoursTiers],
  );

  const derived = useMemo(() => new Map(rows.map((r) => [r.key, derive(r)])), [rows, derive]);

  /** The credit one row contributes to the total — declared for three day types, derived for the fourth. */
  const rowCredit = (r: Row): number | null => {
    if (r.dayType === '' || !r.workedDate) return null;
    if (!claimsTimeWindow(r.dayType)) return Number(r.days);
    return derived.get(r.key)?.credit ?? null;
  };

  const totalCredit = useMemo(
    () => round2(rows.reduce((s, r) => s + (rowCredit(r) ?? 0), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, derived],
  );

  /**
   * WHAT STOPS THE SUBMIT, listed once so the button and the row messages cannot disagree. Every one of
   * these is refused server-side as well; this is the courtesy half.
   */
  const mismatchRows = rows.filter((r) => derived.get(r.key)?.rosterMismatch != null);
  const belowThresholdRows = rows.filter((r) => {
    const d = derived.get(r.key);
    return r.dayType !== '' && claimsTimeWindow(r.dayType) && r.claimStart && r.claimEnd && d?.view != null && d.credit === 0;
  });
  const incompleteRows = rows.filter(
    (r) => r.workedDate !== '' && (r.dayType === '' || (claimsTimeWindow(r.dayType as LeaveCreditDayType) && (!r.claimStart || !r.claimEnd))),
  );
  const blocked =
    totalCredit <= 0 || mismatchRows.length > 0 || belowThresholdRows.length > 0 || incompleteRows.length > 0;

  const belowThresholdText = t('sectionB.belowThreshold', { minutes: extendedHoursTiers?.extendedHalfDayMinutes ?? 240 });
  const disabledCell = `${inputCls} flex items-center bg-muted text-xs text-muted-foreground`;

  return (
    <form action={submitAction} className="space-y-4" data-testid="leave-credit-request-form">
      <p className="text-xs text-muted-foreground" data-testid="leave-credit-helper">
        {t('table.help')}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('leaveType')}>
          {/* 2a237f5f — FIXED ON PURPOSE: a Leave Credit is always Replacement Leave. The visible box is
              disabled, so the BROWSER never submits it — which is why the id travels in its own hidden field. */}
          <input type="hidden" name="leaveTypeId" value={replacementType.id} />
          <input value={replacementType.name} readOnly disabled data-testid="leave-credit-leave-type" className={`${inputCls} bg-muted`} />
        </Field>
        <Field label={t('unit')}>
          {/* Derived, never selectable: every row of this table credits in DAYS. r333's precedent. */}
          <input value={t('unitDay')} readOnly disabled data-testid="leave-credit-unit" className={`${inputCls} bg-muted`} />
        </Field>
      </div>

      <div className={tableWrapCls}>
        <table className="w-full min-w-[60rem] text-sm" data-testid="leave-credit-table">
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>{t('workedDate')}</th>
              <th className={thCls}>{t('sectionA.dayType')}</th>
              <th className={thCls}>{t('days')}</th>
              <th className={thCls}>{t('sectionB.shiftEnd')}</th>
              <th className={thCls}>{t('sectionB.actualClockOut')}</th>
              <th className={thCls}>{t('sectionB.extendedStart')}</th>
              <th className={thCls}>{t('sectionB.extendedEnd')}</th>
              <th className={thCls}>{t('sectionB.eligibleMinutes')}</th>
              <th className={thCls}>{t('sectionB.credit')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody className={tbodyCls}>
            {rows.map((r) => {
              const d = derived.get(r.key);
              const chosen = r.dayType;
              const wantsWindow = chosen !== '' && claimsTimeWindow(chosen);
              // A chosen day type is what decides which cells are live — NOT which section a row sits in.
              const declaresDays = chosen !== '' && !claimsTimeWindow(chosen);
              const mismatch = d?.rosterMismatch ?? null;
              const below = !!(wantsWindow && r.claimStart && r.claimEnd && d?.view != null && d.credit === 0);
              const credit = rowCredit(r);
              return (
                <Fragment key={r.key}>
                  <tr data-testid="leave-credit-row">
                    {/* The five posted values, always present whatever the row's day type. See the header. */}
                    <input type="hidden" name="workedDate" value={r.workedDate} />
                    <input type="hidden" name="dayType" value={r.dayType} />
                    <input type="hidden" name="days" value={declaresDays ? r.days : ''} />
                    <input type="hidden" name="claimStart" value={wantsWindow ? r.claimStart : ''} />
                    <input type="hidden" name="claimEnd" value={wantsWindow ? r.claimEnd : ''} />
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        max={today}
                        value={r.workedDate}
                        onChange={(e) => patch(r.key, 'workedDate', e.target.value)}
                        aria-label={t('workedDate')}
                        className={inputCls}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={r.dayType}
                        onChange={(e) => patch(r.key, 'dayType', e.target.value)}
                        aria-label={t('sectionA.dayType')}
                        data-testid="leave-credit-day-type"
                        className={inputCls}
                      >
                        <option value="">{t('table.dayTypeChoose')}</option>
                        {dayTypeOptions.map((o) => (
                          <option key={o} value={o}>
                            {dayTypeLabel(o)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {/* 1 or 0.5 — the only two answers a non-working day has. DISABLED on an Ordinary Day
                          row, whose credit is derived from the hours, not declared. */}
                      <select
                        value={r.days}
                        onChange={(e) => patch(r.key, 'days', e.target.value)}
                        disabled={!declaresDays}
                        aria-label={t('days')}
                        data-testid="leave-credit-days"
                        className={declaresDays ? inputCls : `${inputCls} bg-muted`}
                      >
                        <option value="1">{t('sectionA.fullDay')}</option>
                        <option value="0.5">{t('sectionA.halfDay')}</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <div className={disabledCell} data-testid="leave-credit-shift-end">
                        {wantsWindow ? (hhmm(d?.view?.shiftEnd ?? null) ?? DAY_DASH) : DAY_DASH}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className={disabledCell} data-testid="leave-credit-clock-out">
                        {wantsWindow ? (hhmm(d?.view?.actualClockOut ?? null) ?? DAY_DASH) : DAY_DASH}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="time"
                        value={r.claimStart}
                        onChange={(e) => patch(r.key, 'claimStart', e.target.value)}
                        disabled={!wantsWindow}
                        title={wantsWindow ? undefined : t('table.windowNotClaimed')}
                        aria-label={t('sectionB.extendedStart')}
                        data-testid="leave-credit-claim-start"
                        className={wantsWindow ? inputCls : `${inputCls} bg-muted`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="time"
                        value={r.claimEnd}
                        onChange={(e) => patch(r.key, 'claimEnd', e.target.value)}
                        disabled={!wantsWindow}
                        title={wantsWindow ? undefined : t('table.windowNotClaimed')}
                        aria-label={t('sectionB.extendedEnd')}
                        data-testid="leave-credit-claim-end"
                        className={wantsWindow ? inputCls : `${inputCls} bg-muted`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className={`${disabledCell} tabular-nums`} data-testid="leave-credit-eligible-minutes">
                        {d?.minutes ?? DAY_DASH}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className={`${disabledCell} tabular-nums`} data-testid="leave-credit-row-credit">
                        {credit != null ? t('totalDays', { days: formatDays(credit) }) : DAY_DASH}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => removeRow(r.key)}
                        disabled={rows.length <= 1}
                        aria-label={t('removeRow')}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                  {(mismatch != null || below) && (
                    <tr>
                      <td colSpan={10} className="px-3 pb-2 text-[11px] font-medium text-destructive">
                        {mismatch != null ? (
                          <span data-testid="leave-credit-roster-mismatch">
                            {t('table.rosterMismatch', { roster: dayTypeLabel(mismatch) })}
                          </span>
                        ) : (
                          <span data-testid="leave-credit-below-threshold">{belowThresholdText}</span>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <Button type="button" size="sm" variant="secondary" onClick={addRow}>
        {t('addRow')}
      </Button>

      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
        <span className="font-medium text-foreground">{t('grandTotal')}</span>
        <span className="font-semibold tabular-nums text-foreground" data-testid="leave-credit-total">
          {t('totalDays', { days: formatDays(totalCredit) })}
        </span>
      </div>

      <Field label={t('reason')}>
        <input name="reason" className={inputCls} />
      </Field>

      {requiresFirstScheduleConsent && (
        <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
          <input type="checkbox" name="firstScheduleConsent" required className="mt-0.5 h-4 w-4" />
          <span className="text-foreground">{t('firstScheduleConsent')}</span>
        </label>
      )}

      <div className="flex justify-end">
        <button className={btnPrimary} disabled={blocked} data-testid="leave-credit-submit">
          {t('submit')}
        </button>
      </div>
    </form>
  );
}
