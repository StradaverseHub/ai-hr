'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button, Field, btnPrimary, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from '../ui';
import { assessExtendedClaim, extendedHoursCreditDays, type ExtendedHoursTiers } from '@/lib/extended-hours';
// 4a1abc4a — every day figure a leave surface prints goes through ONE formatter, so 0.5 and 0.50 cannot
// appear on two screens for the same balance.
import { DAY_DASH, formatDays } from '@/lib/day-format';
// The pure vocabulary and the per-row conditional, from the module BOTH sides read — never from
// packs/leave/service, which is server-only (it drags db/client). lib/extended-hours.ts's precedent.
import {
  // r360 — `LEAVE_CREDIT_DAY_TYPES` left this import with the option list it built. See the note below.
  adjudicateDayTypes,
  claimsTimeWindow,
  flooredByScheduledShiftEnd,
  type LeaveCreditDayType,
} from '@/lib/leave-credit-day-type';

type Action = (fd: FormData) => void | Promise<void>;

/** The tenant's Replacement Leave type, already resolved by the page. Singular for 2a237f5f's reason. */
export type LeaveCreditLeaveTypeView = { id: string; name: string };

/** The read-only facts the roster and Attendance own for one date, as the server action returns them. */
export type LeaveCreditDayFacts = {
  /** What the ROSTER holds. Since r353 it FILLS the Day Type cell when the employee picks a date, and since
   *  r360 that is the cell's only writer — the adjudication still compares it with the POSTED value, which is
   *  a form field and so still tamperable however this screen renders it. */
  kind: LeaveCreditDayType;
  shiftEnd: string | null;
  /** NULL when the day has no attendance row or was never clocked out; the two are one absence here. */
  actualClockOut: string | null;
  /**
   * The attendance engine's own measurement past the shift end. ⚠️ r353 cbfa8b0b — NO LONGER AN INPUT TO
   * THE CREDIT. It used to CAP the claimed window; the owner reversed that rule (lib/extended-hours.ts's
   * header records the whole argument), so nothing on this screen or in the kernel reads it any more. Kept
   * because it is the engine's answer to "how long did this person work past their shift end" and a screen
   * may yet want to print it — never as a ceiling.
   */
  measuredExtendedMinutes: number;
};

/**
 * ⚠️ r358 70294f7a — `days: '1' | '0.5'` IS GONE FROM THE ROW. It was the employee's declared credit on a
 * rest day, off day or public holiday. The owner's answer replaced the choice with the arithmetic —
 * "4 hours of eligible work = 0.5 day, 8 hours … 1.0 day … regardless of the Day Type" — so every row is
 * now a window and every credit is derived from it.
 */
type Row = {
  key: number;
  workedDate: string;
  dayType: LeaveCreditDayType | '';
  claimStart: string;
  claimEnd: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
/** `18:30:00` → `18:30`. A time column comes back with seconds; nobody claims a shift end to the second. */
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const emptyRow = (key: number): Row => ({ key, workedDate: '', dayType: '', claimStart: '', claimEnd: '' });

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
 * ── ⚠️⚠️ DAY TYPE: READ-ONLY (r336) → AN INPUT OF FOUR (r343) → READ-ONLY AGAIN (r360 cbfa8b0b) ──────────
 * THE ROUND TRIP IS RECORDED HERE ON PURPOSE, because the third state is not an undo of the second.
 *   r336 drew the cell read-only, arguing "the kind of day a date is is not the employee's to assert".
 *   r343 the reporter contested that and asked for a dropdown of EXACTLY FOUR OPTIONS AND ALWAYS THE SAME
 *        FOUR — Rest Day, Off Day, Public Holiday, Ordinary Day — whatever the company has switched on, PLUS
 *        a roster check. Both were built. (And the fourth option had to be un-filtered in the fix pass: the
 *        first cut dropped Ordinary Day when the company had no extended-hours tiers, a switch that is
 *        `NOT NULL DEFAULT false` on migration 0486, so the reporter would have counted three. A day type is
 *        a fact about the DATE, not a feature flag.)
 *   r360 the reporter asks for read-only again, with a caption saying where the value came from.
 * WHAT SETTLES IT IS THE CHECK r343 ITSELF ADDED. `leaveCreditRosterKinds` resolves EVERY date, so
 * `adjudicateDayTypes` never skips a row and `submitLeaveCreditRequest` throws on ANY disagreement: the
 * dropdown offered a choice the server would refuse unless it happened to match the roster already. Read-only
 * removes no capability that existed — it removes a way to fail. The value is still POSTED and still
 * adjudicated server side, because this component is one `curl` away from being irrelevant.
 *
 * What the extended-hours switch still decides is what an ORDINARY DAY row EARNS, not whether the date can be
 * one: the row says so through `workingDayRefused` ("An ordinary working day cannot earn a credit"), a key
 * translated in all six locales. The submit is blocked while such a row is present, and
 * `submitReplacementLeaveRequest` refuses the same row server-side (`ReplacementRequestDisabledError`).
 *
 * ── WHAT THIS SCREEN'S WORDS COST IN TRANSLATION, SAID PLAINLY RATHER THAN ARGUED AWAY ──────────────────
 * The four day-type LABELS are the existing `dayKind.*` keys, translated in all six locales, so no new string
 * was minted for "Ordinary Day" and none is needed for the refusal above. r360's four new keys
 * (`dayTypeLookupFailed`, `dayTypeRetry`, `dayTypeFromRoster`, `dayTypeFromHolidays`) ARE translated in all
 * six. The eight `table.*` keys this screen introduced at r343 (`help`, `dayTypeChoose`, `rosterMismatch`,
 * `windowNotClaimed`, `myRequests`, `noRequests`, `statusHeading`, `submittedOn`) DO ship English in all six
 * catalogues — like the fourteen
 * other English `replacementRequest.*` keys this form already rendered before them (`workedDate`, `days`,
 * `addRow`, `reason`, `unit`, `totalDays`, …). That is the debt stated, not hidden:
 * test/r343-leave-credit-single-table.test.ts pins the English set EXACTLY, so it cannot grow by accident
 * and a key that is translated today fails the guard the day it turns English.
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
 *
 * ── ⚠️ r353 cbfa8b0b · THE CLAIMED WINDOW IS THE CLAIM, AND THE CLOCK-OUT IS NOW A WARNING ──────────────
 * The owner reversed the rule this screen was built on. Until r353 the eligible minutes were clipped to the
 * actual clock-out and capped at the attendance engine's measured figure, so the reporter's own example —
 * shift ending 18:00, clocked out 18:00, nothing measured, 18:00–23:51 typed — showed ZERO and no credit.
 * The window the employee types is now the claim in full (floored at the scheduled shift end, which is a
 * definition rather than a check). The two read-only time cells did not become decoration: the row prints an
 * AMBER WARNING when the claimed end runs past the recorded clock-out, and says "No record" when there is no
 * clock-out at all, from the SAME `assessExtendedClaim` call that produced the minutes — and the approvals
 * queue renders that same result from that same function, so the employee and their manager cannot be shown
 * two different readings of one row. ⚠️ This loosens a money control: replacement leave blocks overtime pay
 * for the same hours and converts to cash on expiry, so the approver is now the only check.
 *
 * ── r353, REWRITTEN BY r360 · THE DAY TYPE IS A MIRROR OF THE ROSTER, NOT A REMEMBERED CHOICE ───────────
 * r353's rule was "the cell fills itself while it is empty and the employee has not touched it", protected by
 * a `touchedDayType` record so the roster could never reach in and undo a deliberate mismatch. r360 removed
 * the control, and with it the only thing that record existed to protect — so both are gone and the rule is
 * simply: the cell IS `facts[workedDate].kind`. Two lines carry that. The fill still runs when a FACT lands
 * (never on a keystroke), and `changeWorkedDate` clears the day type whenever the DATE moves, because a value
 * filled from one date and captioned "From your roster" under another is a false statement the employee has
 * no control left to correct. The adjudication still runs on every row and is still the control, because the
 * posted value is a form field and a form field can be tampered with whatever this screen renders.
 */
export function LeaveCreditRequestTable({
  replacementType,
  submitAction,
  today,
  requiresFirstScheduleConsent,
  dayFactsAction,
  tiers,
  ordinaryDayAllowed,
  onSubmitted,
}: {
  replacementType: LeaveCreditLeaveTypeView;
  submitAction: Action;
  /** Resolves one date's roster kind and its two Attendance times, for the signed-in employee. */
  dayFactsAction: (workedDate: string) => Promise<LeaveCreditDayFacts | null>;
  /**
   * The company's tier figures, so the credit shown as the employee types is the one they will get. NULL
   * when the company has not switched extended hours on — which is every company at release. The Ordinary
   * Day OPTION IS STILL OFFERED then (see the header: exactly four options, always); what null changes is
   * that an Ordinary Day row says it cannot earn a credit here and blocks the submit, and the service
   * refuses it regardless.
   */
  /**
   * The tier ladder. r358: it applies to EVERY day type, so it is no longer the thing a company switch
   * can withhold — null means only that no policy resolved for this employment at all.
   */
  tiers: ExtendedHoursTiers | null;
  /**
   * Whether an ORDINARY WORKING DAY may earn a credit here — the extended-hours switch, and after r358
   * the whole of what it governs. The Ordinary Day OPTION is still offered when it is false (see the
   * header: exactly four options, always); such a row then says it cannot earn a credit and blocks the
   * submit, and the service refuses it regardless.
   */
  ordinaryDayAllowed: boolean;
  /** Today in the tenant's zone, resolved on the server — the max selectable worked date. */
  today: string;
  requiresFirstScheduleConsent?: boolean;
  /**
   * Called as the form is submitted, so a host that OPENED this table can close itself. Optional: the
   * `/leave/credit` screen has nothing to close, and the dialog on My Absence passes its own setter. It is
   * not a validation hook — the submit is a server action and this runs beside it, not before it.
   */
  onSubmitted?: () => void;
}) {
  const t = useTranslations('replacementRequest');
  // The four statuses of the requests table below share the vocabulary every other leave surface prints.
  const [rows, setRows] = useState<Row[]>([emptyRow(1)]);

  /**
   * ⚠️ r360 — `const dayTypeOptions = LEAVE_CREDIT_DAY_TYPES;` STOOD HERE, and r343 pinned that exact line
   * ("EXACTLY FOUR OPTIONS, ALWAYS — the whole list, unfiltered, with no company switch in front of it"),
   * because the first cut of r343 filtered the list by the extended-hours switch and rendered THREE options
   * to a reporter who had asked for four. There is no option list to filter now: the cell renders the one
   * kind the roster answered. The vocabulary itself is still guarded, at the only place it still decides
   * anything — set-equal to `toil_worked_day_kind` in test/r343-leave-credit-single-table.test.ts, so a fifth
   * roster kind still fails by name rather than arriving as a silent `workday` through `dayTypeLabel`.
   */
  // r358 — was `extendedHoursTiers == null`, which conflated "this company cannot credit an ordinary day"
  // with "there is no tier ladder". Every day type uses the ladder now, so those had to come apart.
  const ordinaryEarnsNothing = !ordinaryDayAllowed;

  // One fetch per distinct date, marked as asked (null) at once so a re-render mid-flight does not re-ask.
  const [facts, setFacts] = useState<Record<string, LeaveCreditDayFacts | null>>({});
  /**
   * ⚠️ r360 cbfa8b0b — THE FAILED LOOKUP USED TO BE SILENT, AND IT IS THE REPORTED FAULT.
   *
   * This read `void dayFactsAction(d).then(...)` with NO `.catch()`. A rejected server action left
   * `facts[d]` at null for ever: `d in facts` is already true by the line above, so the date is never
   * re-asked, and nothing on the screen said anything. The employee saw a Day Type that would not fill
   * in, and — because all three come from this one call — a blank scheduled shift end and a blank
   * clock-out beside it. That is exactly the row in the reporter's screenshot.
   *
   * It could not be read as "the system has no answer", either: `resolveWorkedDayKindTx` always returns
   * one of the four kinds and `leaveCreditDayFactsAction` returns null only for a malformed date or no
   * employment. So a blank Day Type after a date is picked IS a failed or in-flight lookup and nothing
   * else — which is why the row now says which of the two it is.
   */
  const [factError, setFactError] = useState<Record<string, true>>({});
  const [retryTick, setRetryTick] = useState(0);
  const datesKey = rows.map((r) => r.workedDate).join('|');
  useEffect(() => {
    for (const d of new Set(datesKey.split('|').filter(Boolean))) {
      if (d in facts) continue;
      setFacts((prev) => (d in prev ? prev : { ...prev, [d]: null }));
      void dayFactsAction(d)
        .then((v) => {
          setFacts((prev) => ({ ...prev, [d]: v }));
          setFactError((prev) => {
            if (!(d in prev)) return prev;
            const next = { ...prev };
            delete next[d];
            return next;
          });
        })
        // The whole point: a rejection is RECORDED rather than swallowed, so the row can say so and
        // offer the retry. `facts[d]` stays null, which is what keeps the cells reading "not known".
        .catch(() => setFactError((prev) => ({ ...prev, [d]: true })));
    }
  }, [datesKey, dayFactsAction, facts, retryTick]);

  /** Ask again for the dates whose lookup failed. Clearing `facts` is what lets the effect re-fire. */
  const retryFacts = useCallback(() => {
    const failed = Object.keys(factError);
    if (failed.length === 0) return;
    setFacts((prev) => {
      const next = { ...prev };
      for (const d of failed) delete next[d];
      return next;
    });
    setFactError({});
    setRetryTick((n) => n + 1);
  }, [factError]);

  /**
   * r353 · THE DAY TYPE FILLS ITSELF FROM THE ROSTER. The kind arrives with the facts the mismatch check
   * already needed, so the employee does not retype what the system knows. Functional update, and `rows` is
   * deliberately NOT a dependency: the effect must run when a FACT lands, not on every keystroke, and
   * reading `prev` inside the updater is what makes that correct rather than stale.
   *
   * ⚠️ r360 — `touchedDayType[r.key]` WAS A THIRD CONDITION HERE, and a `Record<number, true>` above held it:
   * "the moment the employee chooses anything the row is theirs and the fill never runs on it again". Nothing
   * can choose any more, so the record could never be written and the condition could never be true. It is
   * gone rather than left reading as live protection — and `chooseDayType`, the only writer, with it.
   */
  useEffect(() => {
    setRows((prev) => {
      let changed = false;
      const next = prev.map((r) => {
        if (r.dayType !== '' || !r.workedDate) return r;
        const kind = facts[r.workedDate]?.kind;
        if (!kind) return r;
        changed = true;
        return { ...r, dayType: kind };
      });
      return changed ? next : prev;
    });
  }, [facts]);

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
  // r360 — this used to also drop the removed row's `touchedDayType` flag, because `addRow` reuses the key of
  // the row last removed and a stale flag would have switched the auto-fill off for a brand-new row. There is
  // no flag to drop now (see the fill above), so the reuse is harmless and the line is gone rather than inert.
  const removeRow = (key: number) => setRows((r) => (r.length <= 1 ? r : r.filter((x) => x.key !== key)));
  const patch = (key: number, field: keyof Row, value: string) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, [field]: value } : x)));

  /**
   * ⚠️ r360 — CHANGING THE DATE CLEARS THE DAY TYPE, AND THAT IS LOAD-BEARING NOW RATHER THAN TIDY.
   *
   * While the cell was a dropdown the fill ran once per row and a stale value after a date change was the
   * employee's own to correct. With the control gone there is nothing to correct it with, and the row was a
   * DEAD END: filled "Rest day" from 2026-09-13, re-dated to 2026-09-16, the cell still read "Rest day" under
   * the caption "From your roster" — the PREVIOUS date's roster — `leave-credit-roster-mismatch` said "Your
   * roster has Working day for this date", the submit was disabled, and the only way out was deleting the row.
   * Measured on the built component before this existed, not reasoned about. Clearing here is what makes the
   * cell a mirror of `facts[workedDate]` instead of a memory of the first date the row ever held.
   *
   * `patch(key, 'workedDate', …)` would not do: the date and the day type have to move in ONE update, or the
   * render between them paints the old kind against the new date.
   */
  const changeWorkedDate = (key: number, value: string) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, workedDate: value, dayType: '' } : x)));

  /**
   * One row's derived figures and its row-level problem, through the SAME two functions the service runs.
   *
   * `rosterMismatch` is the contest's new validation: the employee chose, the roster holds something else.
   * It is reported for ALL FOUR day types, which is what makes it more than the service's own
   * working/non-working check — a row typed "Public Holiday" on a date the roster calls a rest day is a
   * mismatch the layer below cannot see, because both produce the same claim path.
   *
   * r353 · `exceedsClockOut` / `hasClockOut` come back from the SAME assessment as the minutes and do NOT
   * block the submit — they are what the owner's reversal left for a human to judge, so they warn on the row
   * here and again on the approvals queue, and the claim still goes through and still credits.
   */
  const derive = useCallback(
    (r: Row) => {
      const view = r.workedDate ? (facts[r.workedDate] ?? null) : null;
      // r358 — true for every chosen day type now. `claimsTimeWindow` is kept rather than inlined as
      // `r.dayType !== ''` so a reader lands on the reversal in lib/leave-credit-day-type.ts.
      const wantsWindow = r.dayType !== '' && claimsTimeWindow(r.dayType);
      // …and this is the one thing the day type still decides. See `flooredByScheduledShiftEnd`.
      const floored = r.dayType !== '' && flooredByScheduledShiftEnd(r.dayType);
      // THE SAME FUNCTION THE SERVICE RUNS, not a second comparison that happens to agree today. One row in,
      // one row out: `adjudicateDayTypes` is where "chosen is not what the roster holds" is decided, for the
      // screen and for `submitLeaveCreditRequest` alike, so a change to the rule cannot land on one of them.
      const rosterMismatch =
        view != null && r.dayType !== ''
          ? (adjudicateDayTypes([{ workedDate: r.workedDate, dayType: r.dayType }], new Map([[r.workedDate, view.kind]]))[0]?.roster ??
            null)
          : null;
      if (!wantsWindow || !view || !tiers || !r.claimStart || !r.claimEnd)
        return {
          view,
          rosterMismatch,
          minutes: null as number | null,
          credit: null as number | null,
          exceedsClockOut: false,
          hasClockOut: view != null && view.actualClockOut != null,
        };
      // ⚠️ r353 — ONE CALL. The minutes the employee reads and the warning their approver reads come out of
      // the same `assessExtendedClaim`, because computing the figure here and the discrepancy somewhere else
      // is how the two screens would start disagreeing about one row.
      const assessed = assessExtendedClaim({
        claimStart: r.claimStart,
        claimEnd: r.claimEnd,
        // r358 — NULL on the three non-working types, and it is the rule rather than missing data: the
        // employee was never scheduled to be there, so the whole entered window is the claim. The service
        // passes the same null for the same reason, so the figure here is the figure that gets banked.
        shiftEnd: floored ? view.shiftEnd : null,
        actualClockOut: floored ? view.actualClockOut : null,
      });
      const { countedMinutes, days } = extendedHoursCreditDays(assessed.minutes, tiers);
      return {
        view,
        rosterMismatch,
        minutes: countedMinutes,
        credit: days,
        exceedsClockOut: assessed.exceedsClockOut,
        hasClockOut: assessed.hasClockOut,
      };
    },
    [facts, tiers],
  );

  const derived = useMemo(() => new Map(rows.map((r) => [r.key, derive(r)])), [rows, derive]);

  /**
   * The credit one row contributes to the total. r358 — DERIVED FOR ALL FOUR TYPES. It used to read
   * `if (!claimsTimeWindow(r.dayType)) return Number(r.days)`, taking the employee's declared 1 or 0.5 on
   * the three non-working types; there is no declared figure any more.
   */
  const rowCredit = (r: Row): number | null => {
    if (r.dayType === '' || !r.workedDate) return null;
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
    (r) =>
      r.workedDate !== '' &&
      (r.dayType === '' ||
        // r358 — a window is wanted on every type, so the only row exempted is an Ordinary Day one on a
        // company that cannot credit it at all (that row is blocked below rather than asked to fill in
        // times it can do nothing with).
        (!(r.dayType === 'workday' && ordinaryEarnsNothing) && (!r.claimStart || !r.claimEnd))),
  );
  // An ORDINARY DAY row on a company without extended hours — and only that. The option is offered (the
  // header says why), the row says it earns nothing, and the submit waits for the row to go; the service
  // refuses it anyway. r358: this used to catch every row that claimed a window, which after the owner's
  // answer is every row there is.
  const ordinaryUnavailableRows = rows.filter((r) => r.dayType === 'workday' && ordinaryEarnsNothing);
  const blocked =
    totalCredit <= 0 ||
    mismatchRows.length > 0 ||
    belowThresholdRows.length > 0 ||
    incompleteRows.length > 0 ||
    ordinaryUnavailableRows.length > 0;

  const belowThresholdText = t('sectionB.belowThreshold', { minutes: tiers?.extendedHalfDayMinutes ?? 240 });
  const disabledCell = `${inputCls} flex items-center bg-muted text-xs text-muted-foreground`;

  return (
    <form action={submitAction} onSubmit={() => onSubmitted?.()} className="space-y-4" data-testid="leave-credit-request-form">
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
              // r358 — the shift end and the clock-out are an ORDINARY DAY's references. On the other three
              // the employee was not scheduled, so there is nothing to print and nothing to compare.
              const floored = chosen !== '' && flooredByScheduledShiftEnd(chosen);
              // Ordinary Day chosen on a company that cannot credit one: the option was still offered, so
              // the row is where that is explained. Its claimed-window cells are dead, not merely empty.
              const ordinaryUnavailable = chosen === 'workday' && ordinaryEarnsNothing;
              const windowLive = wantsWindow && !ordinaryUnavailable;
              const mismatch = d?.rosterMismatch ?? null;
              const below = !!(wantsWindow && r.claimStart && r.claimEnd && d?.view != null && d.credit === 0);
              const credit = rowCredit(r);
              return (
                <Fragment key={r.key}>
                  <tr data-testid="leave-credit-row">
                    {/* The five posted values, always present whatever the row's day type. See the header. */}
                    <input type="hidden" name="workedDate" value={r.workedDate} />
                    <input type="hidden" name="dayType" value={r.dayType} />
                    <input type="hidden" name="claimStart" value={wantsWindow ? r.claimStart : ''} />
                    <input type="hidden" name="claimEnd" value={wantsWindow ? r.claimEnd : ''} />
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        max={today}
                        value={r.workedDate}
                        onChange={(e) => changeWorkedDate(r.key, e.target.value)}
                        aria-label={t('workedDate')}
                        className={inputCls}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {/* ⚠️ r360 cbfa8b0b — THE DROPDOWN WAS A CHOICE THE SERVER ALWAYS REFUSED.
                          `leaveCreditRosterKinds` resolves EVERY date it is given, so `adjudicateDayTypes`
                          never skips a row, and `submitLeaveCreditRequest` throws
                          LeaveCreditDayTypeMismatchError on ANY disagreement. An employee who picked a day
                          type by hand was therefore turned away at submit unless they happened to pick the
                          one the roster already held. Making the cell read-only removes no capability that
                          existed — it removes a way to fail. The reporter asked for exactly this.
                          The value is still POSTED (the hidden input above) and still adjudicated server
                          side: the screen is the courtesy, the refusal is the control. */}
                      {r.dayType === '' ? (
                        <div className={`${disabledCell} gap-2`} data-testid="leave-credit-day-type">
                          <span>{factError[r.workedDate] ? t('table.dayTypeLookupFailed') : t('table.dayTypeChoose')}</span>
                          {factError[r.workedDate] && (
                            <button
                              type="button"
                              onClick={retryFacts}
                              className="underline underline-offset-2 hover:no-underline"
                              data-testid="leave-credit-day-type-retry"
                            >
                              {t('table.dayTypeRetry')}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className={`${disabledCell} flex-col !items-start`} data-testid="leave-credit-day-type">
                          <span className="text-foreground">{dayTypeLabel(r.dayType)}</span>
                          {/* WHERE IT CAME FROM, which is the other half of the reporter's ask. A public
                              holiday outranks the roster in `scheduleFor`, so the two provenances are
                              genuinely different facts and the caption may not merge them. */}
                          <span className="text-[11px]" data-testid="leave-credit-day-type-source">
                            {r.dayType === 'holiday' ? t('table.dayTypeFromHolidays') : t('table.dayTypeFromRoster')}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className={disabledCell} data-testid="leave-credit-shift-end">
                        {floored ? (hhmm(d?.view?.shiftEnd ?? null) ?? DAY_DASH) : DAY_DASH}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {/* r353 · TWO DIFFERENT SILENCES, TOLD APART. The em dash used to mean both "this cell
                          does not apply to this day type" and "there is no clock-out on record", which on an
                          Ordinary Day row is the difference between nothing to say and something an approver
                          has to look at. Still the dash while the facts are in flight: not knowing yet is a
                          third state and must not read as an answer. */}
                      <div className={disabledCell} data-testid="leave-credit-clock-out">
                        {floored
                          ? d?.view == null
                            ? DAY_DASH
                            : (hhmm(d.view.actualClockOut) ?? t('table.noClockOutRecord'))
                          : DAY_DASH}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="time"
                        value={r.claimStart}
                        onChange={(e) => patch(r.key, 'claimStart', e.target.value)}
                        disabled={!windowLive}
                        title={windowLive ? undefined : t('table.windowNotClaimed')}
                        aria-label={t('sectionB.extendedStart')}
                        data-testid="leave-credit-claim-start"
                        className={windowLive ? inputCls : `${inputCls} bg-muted`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="time"
                        value={r.claimEnd}
                        onChange={(e) => patch(r.key, 'claimEnd', e.target.value)}
                        disabled={!windowLive}
                        title={windowLive ? undefined : t('table.windowNotClaimed')}
                        aria-label={t('sectionB.extendedEnd')}
                        data-testid="leave-credit-claim-end"
                        className={windowLive ? inputCls : `${inputCls} bg-muted`}
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
                  {/* ⚠️ r353 · THE WARNING THAT REPLACED A REDUCER, AND IT DOES NOT BLOCK THE SUBMIT.
                      The claim used to be clipped to the clock-out and capped at the measured figure; the
                      owner reversed both, so what is left is to SAY so — amber rather than the destructive
                      red above, because this row is valid and will credit. Its own <tr>, so a row can be
                      both under the threshold and past the clock-out without one message hiding the other. */}
                  {windowLive && d?.view != null && (!d.hasClockOut || d.exceedsClockOut) && (
                    <tr>
                      <td colSpan={10} className="px-3 pb-2">
                        <p
                          className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                          data-testid="leave-credit-clock-out-warning"
                        >
                          {!d.hasClockOut
                            ? t('table.clockOutMissing')
                            : t('table.clockOutEarlier', { claimEnd: r.claimEnd, clockOut: hhmm(d.view.actualClockOut) ?? '' })}
                        </p>
                      </td>
                    </tr>
                  )}
                  {(mismatch != null || ordinaryUnavailable || below) && (
                    <tr>
                      <td colSpan={10} className="px-3 pb-2 text-[11px] font-medium text-destructive">
                        {mismatch != null ? (
                          <span data-testid="leave-credit-roster-mismatch">
                            {t('table.rosterMismatch', { roster: dayTypeLabel(mismatch) })}
                          </span>
                        ) : ordinaryUnavailable ? (
                          /* The fourth option is offered on every company; what it EARNS is the switch.
                             `workingDayRefused` is translated in all six locales and says exactly this. */
                          <span data-testid="leave-credit-ordinary-earns-nothing">{t('workingDayRefused')}</span>
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

      <Button type="button" size="sm" variant="secondary" onClick={addRow} data-testid="leave-credit-add-row">
        {t('addRow')}
      </Button>

      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
        <span className="font-medium text-foreground" data-testid="leave-credit-total-label">
          {t('grandTotal')}
        </span>
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
