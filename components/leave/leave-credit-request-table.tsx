'use client';

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, Trash2 } from 'lucide-react';
import { Button, Field, btnPrimary, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from '../ui';
// r365 cbfa8b0b — ONE anchored panel in this repo, and ONE sheet. Neither is new: the panel is the
// positioning components/attendance-figure-cells.tsx has used since 7c834696, extracted so this row can
// open the same thing; the sheet is components/ui/drawer.tsx, which is FULL SCREEN below `lg` and is the
// product's answer to "a bottom sheet on a phone". No dependency was added for either (the plan says so
// plainly: @radix-ui/react-popover and react-tooltip are not installed and are not being installed).
import { AnchoredPanel, useAnchoredPanel, useBelowLg } from '../ui/anchored-panel';
import { Drawer } from '../ui/drawer';
import { cn } from '@/lib/utils';
// r362 58424c7f — `claimCrossesMidnight` is the ROLL'S OWN CONDITION, exported rather than re-parsed here:
// the note this row prints and the minutes printed beside it come from one comparison, or they disagree the
// first time either moves. See that file's header for why a reversed pair is not refused.
import { assessExtendedClaim, claimCrossesMidnight, extendedHoursCreditDays, type ExtendedHoursTiers } from '@/lib/extended-hours';
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
  /**
   * r365 cbfa8b0b — THE SHIFT **START** AND THE CLOCK-**IN** ARE NEW, AND NEITHER IS AN INPUT TO ANYTHING.
   * They exist for the Attendance panel behind this row's View button, which shows the employee the whole
   * record for the date rather than two figures in two grey cells. What `assessExtendedClaim` is handed is
   * unchanged — `shiftEnd` and `actualClockOut`, and NULL for both on the three non-working day types,
   * which is the money rule (`derive` below, and lib/extended-hours.ts's header).
   */
  shiftStart: string | null;
  shiftEnd: string | null;
  /** NULL when the day has no attendance row or was never clocked in. Display only. */
  actualClockIn: string | null;
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
  /**
   * r365 · THE APPROVED OVERTIME ALREADY ON THIS DATE, or null. It goes in the EMPLOYEE's panel and not the
   * approver's, and the reason is a fact rather than a preference: core/credit-ot-overlap.ts refuses a
   * Leave Credit whose date carries a live overtime claim AND refuses an overtime claim whose date carries
   * a live Leave Credit, so a claim sitting in an approver's queue can never carry one — the case cannot
   * arise there. Here it pre-explains the refusal the employee would otherwise meet at submit.
   */
  approvedOtPlan: { start: string | null; end: string | null; minutes: number } | null;
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

/** The four day-type labels, at module scope so the row AND the panel read one mapping. */
const dayTypeLabelOf = (t: (k: string) => string, d: LeaveCreditDayType) =>
  d === 'rest_day'
    ? t('dayKind.restDay')
    : d === 'off_day'
      ? t('dayKind.offDay')
      : d === 'holiday'
        ? t('dayKind.holiday')
        : t('dayKind.workday');

/**
 * r365 cbfa8b0b · WHAT ATTENDANCE HOLDS FOR ONE DATE, AS A RECORD RATHER THAN AS TWO GREY BOXES.
 *
 * ── WHY THIS EXISTS AT ALL, AND WHY IT IS NOT A THIRD AND FOURTH COLUMN ────────────────────────────────
 * The row used to carry SCHEDULED SHIFT END and ACTUAL CLOCK-OUT as two disabled cells. Two things were
 * wrong with that and the reporter named both.
 *   · They read as fields waiting to be filled in — same grey box, same size, same place in the row as the
 *     boxes that ARE inputs — while nobody can type into either, and on three of the four day types the
 *     shift end is permanently blank by design.
 *   · The row had no space for them. `disabledCell` is `inputCls` + flex, and `inputCls` fixes `h-9`
 *     (36px) with 8px of padding; the filled Day Type cell stacks a `text-xs` line (16px line-height) over
 *     a `text-[11px]` line that INHERITS that same 16px. 16 + 16 + 8 = 40px of content in a 36px box, on
 *     every filled row — which is the "text overlapping" in the reporter's screenshot, arithmetic rather
 *     than taste. Two columns leaving is what gives the row its width back; the box is made tall enough
 *     for its own caption in the same round, below.
 *
 * ── THE DOT IS THE WHOLE WARNING NOW ───────────────────────────────────────────────────────────────────
 * A full-width amber `<tr>` used to appear and disappear under the row as the two times were typed,
 * pushing everything below it up and down. What replaces it is a dot on this button, its one-line reason
 * on hover, and the detail inside the panel. ⚠️ The CONDITION is untouched — it is still
 * `!hasClockOut || exceedsClockOut` off the ONE `assessExtendedClaim` the row and the approvals queue
 * share — and it is truthful only because r364 (c36e1ae6) made `hasClockOut` read the day FACTS instead of
 * the assessment: the assessment is handed `null` on the three non-working day types because that is the
 * money rule, so it used to answer "no clock-out" on every rest day, off day and public holiday. A dot
 * built on the old reading would have been the same wrong answer in a quieter shape.
 *
 * ── IT NEVER BLOCKS THE CLAIM, AND IT NEVER POSTS ANYTHING ─────────────────────────────────────────────
 * ⚠️ THE BUTTON CARRIES NO `name`, AND THAT IS LOAD-BEARING RATHER THAN TIDY: `submitLeaveCreditRequestAction`
 * zips the repeated row fields BY INDEX, a browser does not submit a DISABLED control at all, and this one
 * is disabled on every row that has no date yet. A `name` here would post a list SHORTER than the row list
 * and silently shift every row after the gap. The five hidden inputs remain the only posted row state.
 * Nothing this component renders reaches `blocked` either: an employee with no attendance record for the
 * date reads that plainly and still submits.
 *
 * ── BELOW `lg` IT IS THE PRODUCT'S SHEET, NOT A NEW ONE ────────────────────────────────────────────────
 * The reporter asked for a bottom sheet. components/ui/drawer.tsx is full screen below `lg` and is what
 * every other sheet in this product is; a second sheet style for one button is one more thing to maintain
 * and one more thing to look inconsistent. Said on the item rather than quietly substituted.
 */
function AttendanceViewCell({
  workedDate,
  dayType,
  view,
  /** The one-line dot reason, or null when there is nothing to flag. Its presence IS the dot. */
  alert,
}: {
  workedDate: string;
  dayType: LeaveCreditDayType | '';
  view: LeaveCreditDayFacts | null;
  alert: string | null;
}) {
  const t = useTranslations('replacementRequest');
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { at, anchorTo, release } = useAnchoredPanel({ open, onClose: close });
  const belowLg = useBelowLg();
  const root = useRef<HTMLDivElement>(null);

  // No date ⇒ nothing to look up. The button is off rather than opening an empty panel.
  const enabled = workedDate !== '';

  /**
   * Outside-click dismissal, the idiom components/ui/multi-select-popover.tsx records: a document
   * `mousedown` listener and NO `fixed inset-0` backdrop. A backdrop over a table swallows the click that
   * was meant for the next row's own View button, so every dismissal would cost two clicks.
   * The panel is rendered INSIDE `root` (it escapes visually through `position: fixed`, not through the
   * DOM), so one `contains` check covers both the trigger and the panel.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) {
        release();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, release]);

  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) {
      release();
      setOpen(false);
      return;
    }
    anchorTo(e.currentTarget);
    setOpen(true);
  };

  const body = <AttendanceFacts workedDate={workedDate} dayType={dayType} view={view} alert={alert} />;

  return (
    <div ref={root} className="relative inline-block">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={!enabled}
        onClick={toggle}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        // A native `title` rather than a hand-rolled hover card: it is the one-LINE reason, the detail is
        // inside the panel, and a tooltip primitive would be the dependency this round is not adding.
        title={enabled ? (alert ?? undefined) : t('table.attendanceViewDisabled')}
        data-testid="leave-credit-attendance-view"
      >
        <Eye className="size-4" aria-hidden />
        {t('table.attendanceView')}
        {alert != null && (
          <>
            <span
              aria-hidden
              data-testid="leave-credit-attendance-dot"
              className="ml-0.5 inline-block size-2 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400"
            />
            {/* The dot is a colour, and a colour is not a message. The reason is in the tree for a screen
                reader whether or not the pointer ever rests on the button. */}
            <span className="sr-only">{alert}</span>
          </>
        )}
      </Button>

      {open &&
        (belowLg ? (
          <Drawer
            open={open}
            onOpenChange={(v) => {
              if (!v) {
                release();
                setOpen(false);
              }
            }}
            width="narrow"
            title={t('table.attendanceHeading')}
            description={workedDate}
          >
            {body}
          </Drawer>
        ) : (
          <AnchoredPanel at={at} id={panelId} role="dialog" aria-label={t('table.attendanceHeading')}>
            {body}
          </AnchoredPanel>
        ))}
    </div>
  );
}

/**
 * The panel's CONTENTS, shared by the anchored panel and the sheet so the two can never say different
 * things about one date.
 *
 * ⚠️ "NO SCHEDULED SHIFT" IS DECIDED BY THE SAME PREDICATE THE CREDIT IS, not by whether the roster
 * happens to hold times. `flooredByScheduledShiftEnd` is workday-only, and a roster CAN carry a shift on a
 * rest day (a swap, a correction, a pattern edited after the fact) — `derive` passes `shiftEnd: null` on
 * the three non-working types precisely so that floor cannot eat the first hours of the claim. Printing
 * "18:00" here on a rest day would tell the employee a floor applies that the arithmetic does not apply.
 *
 * ⚠️ AND THE DASH IS "NOT KNOWN YET", NEVER "NOTHING". While the day facts are in flight `view` is null and
 * every value is the dash; the named absences ("No record", "Nothing recorded") are only ever printed
 * against an answer that came back. That distinction is r364's, kept.
 */
function AttendanceFacts({
  workedDate,
  dayType,
  view,
  alert,
}: {
  workedDate: string;
  dayType: LeaveCreditDayType | '';
  view: LeaveCreditDayFacts | null;
  alert: string | null;
}) {
  const t = useTranslations('replacementRequest');
  const noShift = t('table.attendanceNoShift');
  const scheduled = dayType !== '' && flooredByScheduledShiftEnd(dayType);
  const start = hhmm(view?.shiftStart ?? null);
  const end = hhmm(view?.shiftEnd ?? null);
  const clockIn = hhmm(view?.actualClockIn ?? null);
  const clockOut = hhmm(view?.actualClockOut ?? null);
  // Only ever asserted about an answer that came back. `view == null` is "still asking", not "nothing".
  const nothingRecorded = view != null && clockIn == null && clockOut == null;
  const ot = view?.approvedOtPlan ?? null;

  const line = (label: string, value: string, testid: string) => (
    <div className="flex items-baseline justify-between gap-3 py-0.5" data-testid={testid}>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );

  return (
    <div data-testid="leave-credit-attendance-panel">
      <p className="text-sm font-semibold text-foreground">{t('table.attendanceHeading')}</p>
      <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground" data-testid="leave-credit-attendance-date">
        {workedDate || DAY_DASH}
      </p>

      <dl className="mt-3 space-y-0 text-xs">
        {line(t('sectionA.dayType'), dayType === '' ? DAY_DASH : dayTypeLabelOf(t, dayType), 'leave-credit-attendance-day-type')}
        {line(
          t('table.attendanceScheduledShift'),
          view == null ? DAY_DASH : !scheduled || start == null || end == null ? noShift : `${start} - ${end}`,
          'leave-credit-attendance-shift',
        )}
        {line(
          t('sectionB.shiftEnd'),
          view == null ? DAY_DASH : !scheduled || end == null ? noShift : end,
          'leave-credit-attendance-shift-end',
        )}
        {nothingRecorded
          ? line(t('table.attendanceClockInOut'), t('table.attendanceNothingRecorded'), 'leave-credit-attendance-clocking')
          : (
            <>
              {line(
                t('table.attendanceClockIn'),
                view == null ? DAY_DASH : (clockIn ?? t('table.noClockOutRecord')),
                'leave-credit-attendance-clock-in',
              )}
              {line(
                t('sectionB.actualClockOut'),
                view == null ? DAY_DASH : (clockOut ?? t('table.noClockOutRecord')),
                'leave-credit-attendance-clock-out',
              )}
            </>
          )}
        {line(
          t('table.attendanceOtPlan'),
          view == null
            ? DAY_DASH
            : ot == null
              ? t('table.attendanceOtPlanNone')
              : ot.start && ot.end
                ? `${hhmm(ot.start)} - ${hhmm(ot.end)}`
                : t('table.attendanceOtPlanApproved'),
          'leave-credit-attendance-ot-plan',
        )}
      </dl>

      {nothingRecorded && (
        <p
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
          data-testid="leave-credit-attendance-no-record"
        >
          {t('table.attendanceNoRecordNote')}
        </p>
      )}
      {alert != null && (
        <p
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
          data-testid="leave-credit-attendance-alert"
        >
          {alert}
        </p>
      )}

      {/* The reporter's own footnote, and it stays: the panel is a record, never a ceiling. */}
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground" data-testid="leave-credit-attendance-footnote">
        {t('table.attendanceReferenceOnly')}
      </p>
    </div>
  );
}

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
 * six, and so are r362's three (`dayTypeReading`, `dayTypeNotFound`, `crossesMidnight`). Of the eight
 * `table.*` keys this screen introduced at r343, the ones it STILL renders in English in all six catalogues
 * are `rosterMismatch`, `myRequests`, `noRequests`, `statusHeading` and `submittedOn` — like the other
 * English `replacementRequest.*` keys this form already rendered before them (`workedDate`,
 * `addRow`, `reason`, `unit`, `totalDays`, …). ⚠️ THE OTHER THREE OF THE EIGHT LEFT THAT SET RATHER THAN
 * BEING PAID OFF IN PLACE, and the distinction is the point of naming them: `help` and `windowNotClaimed`
 * were rewritten for the owner's new rule at r358 and translated while they were being rewritten;
 * `dayTypeChoose` is RETIRED by r362 — still in all six catalogues, no longer rendered by anything, because
 * a read-only cell may not tell an employee to choose. That is the debt stated, not hidden:
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
 *
 * ── r362 5c72039e · THE CELL SAYS WHICH OF THE FOUR MOMENTS IT IS IN, AND NEVER ASKS FOR A CHOICE ───────
 * r360 left one sentence — `table.dayTypeChoose`, "Choose a day type" — serving three states: no date
 * picked, lookup in flight, lookup answered with nothing. It instructed the employee to do something the
 * read-only cell had stopped permitting, with nothing in the box to click. The three come apart here:
 * BLANK before a date is picked (nothing has been asked, so nothing is claimed), `dayTypeReading` while the
 * roster is being read, `dayTypeNotFound` when it came back with nothing — r360's `dayTypeLookupFailed` and
 * its retry unchanged beside them. The split needed STATE, not copy: see `factsSettled` below.
 *
 * ── r362 58424c7f · A WINDOW THAT CROSSES MIDNIGHT SAYS SO, AND NOTHING ABOUT THE CREDIT CHANGES ────────
 * The reporter asked for an end-earlier-than-start REFUSAL. It was deliberately not built, because that is
 * how a night shift is entered; the deviation is reported on item 58424c7f rather than buried. What lands
 * instead is a MUTED per-row note (`table.crossesMidnight`) driven by `claimCrossesMidnight`, the roll's own
 * condition in lib/extended-hours.ts. Nothing is refused, nothing is coloured, no figure moves.
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
   * employment.
   *
   * ⚠️ r362 5c72039e — AND THAT LAST SENTENCE IS WHY THE CELL NEEDED A THIRD RECORD, not just new copy.
   * The sentence that stood here — "a blank Day Type after a date is picked IS a failed or in-flight lookup
   * and nothing else, which is why the row now says which of the two it is" — was only half true. r360 told
   * FAILED apart; in-flight and "resolved with nothing" were still one value, because `facts[d]` is written
   * `null` BEFORE the call (the line above) and `leaveCreditDayFactsAction` ALSO resolves null for a
   * malformed date or no employment. `factsSettled` below is what separates them: a date is in flight when
   * it is in `facts` and NOT in `factsSettled`. Written in BOTH the `.then` and the `.catch`, never from a
   * timer — a timer would be a guess about the server dressed up as a state.
   */
  const [factError, setFactError] = useState<Record<string, true>>({});
  /**
   * r362 5c72039e · THE DATES THE SERVER HAS ANSWERED FOR, however it answered. NOT "the dates that
   * succeeded": a rejection settles a date too, and the failed row's own sentence is `factError`'s job.
   * Without this, "Reading your roster…" and "Not found" are the same stored value and the cell has to
   * pick one and be wrong half the time — which is what `dayTypeChoose` was doing for all three states.
   */
  const [factsSettled, setFactsSettled] = useState<Record<string, true>>({});
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
        .catch(() => setFactError((prev) => ({ ...prev, [d]: true })))
        // r362 — SETTLED IN BOTH DIRECTIONS, and `.finally` is the only place that can be said once.
        // A resolve that answered `null` and a reject are both "the server has spoken"; which of the two
        // it was is `factError`'s to say. Leaving this out of the reject path would leave a failed date
        // reading "Reading your roster…" for ever behind its own failure sentence.
        .finally(() => setFactsSettled((prev) => (prev[d] ? prev : { ...prev, [d]: true })));
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
    // r362 — AND THE SETTLED MARK GOES WITH IT. A retried date is in flight again; leaving it settled
    // would have the cell read "Not found - pick the date again" while the second request is running,
    // which is the same lie in new words.
    setFactsSettled((prev) => {
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

  // r365 — ONE mapping, at module scope, because the Attendance panel prints the same four labels and two
  // copies of a four-way conditional is how a fifth roster kind reaches one of them and not the other.
  const dayTypeLabel = (d: LeaveCreditDayType) => dayTypeLabelOf(t, d);

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
   * r353 · `exceedsClockOut` comes back from the SAME assessment as the minutes and does NOT block the
   * submit — it is what the owner's reversal left for a human to judge, so it warns on the row here and again
   * on the approvals queue, and the claim still goes through and still credits.
   *
   * ⚠️ r364 c36e1ae6 — THAT SENTENCE USED TO SAY "`exceedsClockOut` / `hasClockOut` come back from the SAME
   * assessment as the minutes", and the second name in it was the defect. `hasClockOut` is read off the day
   * FACTS, in both exits below; see the note on it in the assessed exit for why the assessment cannot answer
   * it here.
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
        /**
         * ⚠️ r364 c36e1ae6 — FROM THE VIEW, NOT FROM THE ASSESSMENT. This one line was the reported defect.
         * `assessed.hasClockOut` is `Number.isFinite(timeToMinutes(actualClockOut))`: it answers about the
         * argument it was HANDED, and three lines up we hand it `null` on the three non-working day types
         * deliberately, because that is the money rule. So it came back false on every rest day, off day and
         * public holiday however many clock-outs were on record, and the amber row fired the moment the
         * employee filled BOTH time boxes — which is why it read as though they had caused it by typing.
         * The early exit above has always read this off the day facts; the two exits disagreed about one fact
         * of one row, and this is the line that made them agree. `lib/extended-hours.ts`'s own doc for
         * `hasClockOut` is correct and unchanged: it describes what that function can assert from ITS inputs.
         */
        hasClockOut: view.actualClockOut != null,
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
  /**
   * ⚠️⚠️ r365 cbfa8b0b · THE REPORTER'S "TEXT OVERLAPPING" IS ARITHMETIC, AND THIS IS THE ARITHMETIC.
   *
   * `disabledCell` is `inputCls` plus flex, and `inputCls` fixes `h-9` — 36px, a HEIGHT and not a
   * `min-height` — with `py-1`, 8px. The FILLED Day Type cell stacks two lines inside it: the label at
   * `text-xs` (line-height 1rem = 16px) and the provenance caption at `text-[11px]`, which sets the FONT
   * SIZE only and inherits that same 16px line-height. 16 + 16 + 8 = 40px of content in a 36px box, so the
   * caption spilled past the bottom edge into the row beneath — on EVERY filled row, worst under the
   * longest caption (`dayTypeFromHolidays`, "From the public holiday calendar").
   *
   * Two changes, both needed: the box grows (`h-auto` with `min-h-9`, so an empty row is unchanged) and the
   * caption stops claiming a full 16px line (`leading-tight`). Built through `cn` rather than a template
   * string BECAUSE `h-9` AND `h-auto` ARE THE SAME CSS PROPERTY AT THE SAME SPECIFICITY: concatenated, which
   * one wins is decided by the order Tailwind happens to emit them in, not by the order written here.
   * tailwind-merge drops the loser.
   */
  const filledDayTypeCell = cn(disabledCell, 'h-auto min-h-9 flex-col !items-start py-1.5');

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
        {/* r365 — EIGHT columns, not nine. Scheduled shift end and Actual clock-out left the row for the
            Attendance panel; `min-w` came down with them, which is the other half of the reporter's
            crowding complaint (a 60rem minimum inside `overflow-x-auto` made a laptop scroll sideways to
            reach the delete button). */}
        <table className="w-full min-w-[52rem] text-sm" data-testid="leave-credit-table">
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>{t('workedDate')}</th>
              <th className={thCls}>{t('sectionA.dayType')}</th>
              <th className={thCls}>{t('sectionB.extendedStart')}</th>
              <th className={thCls}>{t('sectionB.extendedEnd')}</th>
              <th className={thCls}>{t('sectionB.eligibleMinutes')}</th>
              <th className={thCls}>{t('sectionB.credit')}</th>
              <th className={thCls}>{t('table.attendanceColumn')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody className={tbodyCls}>
            {rows.map((r) => {
              const d = derived.get(r.key);
              const chosen = r.dayType;
              const wantsWindow = chosen !== '' && claimsTimeWindow(chosen);
              // ⚠️ r365 — `const floored = chosen !== '' && flooredByScheduledShiftEnd(chosen);` STOOD HERE,
              // and its history is worth keeping because it is the money rule twice re-argued:
              //   r358 "the shift end and the clock-out are an ORDINARY DAY's references. On the other three
              //         the employee was not scheduled, so there is nothing to print and nothing to compare."
              //   r364 SPLIT that: the SHIFT END half stands (nothing was scheduled, so nothing to print and
              //        nothing to floor at), the CLOCK-OUT half was wrong — a clock-out is a fact the system
              //        holds on all four day types — so `floored` governed the shift-end cell and the
              //        assessment ONLY, never the clock-out cell.
              // Neither cell is in the row any more, so the ROW no longer needs the predicate. The two places
              // that do still ask it are unchanged and are the two that matter: `derive` above, which is
              // where it decides the MONEY (`shiftEnd: floored ? view.shiftEnd : null`), and `AttendanceFacts`,
              // which prints "No scheduled shift" off the same question so the panel and the arithmetic
              // cannot say different things about one date.
              // Ordinary Day chosen on a company that cannot credit one: the option was still offered, so
              // the row is where that is explained. Its claimed-window cells are dead, not merely empty.
              const ordinaryUnavailable = chosen === 'workday' && ordinaryEarnsNothing;
              const windowLive = wantsWindow && !ordinaryUnavailable;
              const mismatch = d?.rosterMismatch ?? null;
              const below = !!(wantsWindow && r.claimStart && r.claimEnd && d?.view != null && d.credit === 0);
              const credit = rowCredit(r);
              /**
               * r362 5c72039e — "THE ROSTER ANSWERED, AND IT HAD NOTHING", told apart from "still asking".
               * Settled AND no facts. The second half matters: between the `.then` that lands the facts and
               * the effect that copies the kind into the row there is one committed render where the date is
               * settled and `r.dayType` is still '' — reading `factsSettled` alone would flash "Not found"
               * on a row that found its answer. A settled date WITH facts is a fill in progress, so it keeps
               * reading "Reading your roster…" for that one frame.
               */
              const factsNotFound =
                r.workedDate !== '' && !factError[r.workedDate] && r.workedDate in factsSettled && facts[r.workedDate] == null;
              /**
               * r362 58424c7f — THE NIGHT SHIFT, SAID OUT LOUD. `claimCrossesMidnight` is the condition
               * `assessExtendedClaim` rolls on, imported rather than re-parsed here (see the import). It is
               * NOT a validation: an end before the start is how a shift across midnight is entered, which
               * is exactly the refusal the reporter asked for and did not get (item 58424c7f). The row says
               * how the window was READ so an accidental 14:00→09:00 is visible the moment it is typed.
               */
              const crossesMidnight = windowLive && !!r.claimStart && !!r.claimEnd && claimCrossesMidnight(r.claimStart, r.claimEnd);
              /**
               * ⚠️⚠️ r365 cbfa8b0b · THE FULL-WIDTH AMBER ROW BECAME THIS STRING, AND ITS CONDITION DID NOT
               * MOVE. What stood below the row, in its own `<tr>` spanning the whole table, was:
               *
               *   windowLive && d?.view != null && (!d.hasClockOut || d.exceedsClockOut)
               *     ⇒ an amber paragraph reading `table.clockOutMissing` or `table.clockOutEarlier`
               *
               * r353 put it there ("the warning that replaced a reducer, and it does not block the submit":
               * the claim used to be clipped to the clock-out and capped at the measured figure, the owner
               * reversed both, so all that is left is to SAY so) and r364 c36e1ae6 made it honest by reading
               * `hasClockOut` off the day FACTS rather than off the assessment — which is handed `null` on
               * the three non-working day types BECAUSE THAT IS THE MONEY RULE, and so used to answer "no
               * clock-out" on every rest day, off day and public holiday however many were on record.
               *
               * THE CONDITION HERE IS THAT CONDITION, CHARACTER FOR CHARACTER, and r364's reading is the
               * reason the dot can be trusted at all. What the reporter contested is the SHAPE: a full-width
               * bar that appeared and disappeared as the two time boxes were typed, shoving every row below
               * it up and down. It is now a dot on the View button, this sentence on hover, and the same
               * sentence inside the panel.
               *
               * `table.clockOutMissing` and `table.clockOutEarlier` are RETIRED, NOT DELETED (CLAUDE.md §8):
               * they are two-sentence bar copy and a dot's tooltip wants one line, so `table.dotReasonNoRecord`
               * and `table.dotReasonPastClockOut` replace them here while both stay in all six catalogues.
               * The approvals queue's warnings are SEPARATE keys (`creditWarnNoClockOut` /
               * `creditWarnPastClockOut`) rendered by app/approvals/page.tsx and are untouched by this round.
               */
              const attendanceAlert =
                windowLive && d?.view != null && (!d.hasClockOut || d.exceedsClockOut)
                  ? !d.hasClockOut
                    ? t('table.dotReasonNoRecord')
                    : t('table.dotReasonPastClockOut', { claimEnd: r.claimEnd, clockOut: hhmm(d.view.actualClockOut) ?? '' })
                  : null;
              return (
                <Fragment key={r.key}>
                  <tr data-testid="leave-credit-row">
                    <td className="px-3 py-2">
                      {/* The four posted values, always present whatever the row's day type. See the header.
                          ⚠️ r364 — THEY LIVE INSIDE THIS CELL, NOT DIRECTLY UNDER THE `<tr>`, and that is not
                          a tidying preference. `<input>` is not permitted as a child of `<tr>`: the HTML
                          parser's "in row" insertion mode FOSTER-PARENTS anything that is not a `<td>`/`<th>`,
                          moving it out to just before the `<table>`. So the server's markup and React's tree
                          disagreed on where these four live, which is the hydration error this screen logged
                          on every load.
                          It had not corrupted a submission, because foster-parenting preserves relative order
                          and `submitLeaveCreditRequestAction` zips the four lists BY INDEX — but "the browser
                          silently relocates our inputs and the order happens to survive" is not a contract,
                          and this form has no other one. Inside the cell they are valid, ordered, and the
                          parser leaves them where they were written. */}
                      <input type="hidden" name="workedDate" value={r.workedDate} />
                      <input type="hidden" name="dayType" value={r.dayType} />
                      <input type="hidden" name="claimStart" value={wantsWindow ? r.claimStart : ''} />
                      <input type="hidden" name="claimEnd" value={wantsWindow ? r.claimEnd : ''} />
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
                          {/* ⚠️ r362 5c72039e — FOUR STATES, FOUR SENTENCES. This read
                              `factError[…] ? t('table.dayTypeLookupFailed') : t('table.dayTypeChoose')`,
                              and `table.dayTypeChoose` ("Choose a day type") was therefore the catch-all
                              for THREE of them: no date picked, lookup in flight, lookup answered with
                              nothing. It told the employee to do something this read-only cell has not
                              permitted since r360, and there is nothing in the box to click. The key is
                              RETIRED, not deleted — it stays in all six catalogues, it is simply no longer
                              rendered here.
                              THE BLANK IS DELIBERATE and it is not the dash the shift-end and clock-out
                              cells print. A dash is an answer ("nothing applies here"); before a date is
                              picked nothing has been ASKED, so the cell asserts nothing at all. */}
                          <span>
                            {!r.workedDate
                              ? ''
                              : factError[r.workedDate]
                                ? t('table.dayTypeLookupFailed')
                                : factsNotFound
                                  ? t('table.dayTypeNotFound')
                                  : t('table.dayTypeReading')}
                          </span>
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
                        <div className={filledDayTypeCell} data-testid="leave-credit-day-type">
                          <span className="leading-tight text-foreground">{dayTypeLabel(r.dayType)}</span>
                          {/* WHERE IT CAME FROM, which is the other half of the reporter's ask. A public
                              holiday outranks the roster in `scheduleFor`, so the two provenances are
                              genuinely different facts and the caption may not merge them. */}
                          <span className="text-[11px] leading-tight" data-testid="leave-credit-day-type-source">
                            {r.dayType === 'holiday' ? t('table.dayTypeFromHolidays') : t('table.dayTypeFromRoster')}
                          </span>
                        </div>
                      )}
                    </td>
                    {/* ⚠️⚠️ r365 cbfa8b0b — THE SCHEDULED-SHIFT-END AND ACTUAL-CLOCK-OUT CELLS STOOD HERE, AND
                        BOTH CLAIMS THEY CARRIED ARE KEPT BECAUSE THEY WERE EARNED.
                          r353: "TWO DIFFERENT SILENCES, TOLD APART" — the em dash meant both "this cell does
                            not apply to this day type" and "there is no clock-out on record".
                          r364 (c36e1ae6): the clock-out APPLIES on all four day types, so the cell printed
                            the time on every one of them, the named absence when we looked and held nothing,
                            and the dash ONLY while the facts were in flight; the SHIFT END cell kept its
                            day-type dash because there genuinely was no scheduled shift to print.
                        Neither claim is being reversed — both MOVED, into the Attendance panel, where the
                        shift end reads "No scheduled shift" instead of a dash the employee has to decode and
                        the clock-out keeps its three states exactly. What the reporter contested is that two
                        read-only references sat in the row wearing input boxes, on a row that had 40px of
                        content in a 36px cell. See `AttendanceViewCell` above for the arithmetic. */}
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
                      <AttendanceViewCell workedDate={r.workedDate} dayType={chosen} view={d?.view ?? null} alert={attendanceAlert} />
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
                  {/* ⚠️ r362 58424c7f · MUTED, AND THE COLOUR IS THE DECISION.
                      The reporter asked Leave Credit to REFUSE an end earlier than the start. It is
                      deliberately allowed — lib/extended-hours.ts's header has the argument — because that
                      is the only way a shift across midnight is entered, and refusing it would switch
                      night-shift claims off and take r353's `<`-not-`<=` money fix with them. What the rule
                      was protecting is that nobody could see HOW the window was read, and that is what this
                      note supplies. It is NEITHER the amber above NOR the destructive red below: nothing is
                      wrong here, and an amber note would teach employees that a correctly entered night
                      shift is a problem. Its own <tr> for the same reason as the amber one: a row can be
                      past its clock-out AND cross midnight without one message hiding the other. */}
                  {crossesMidnight && (
                    <tr>
                      <td colSpan={8} className="px-3 pb-2">
                        <p className="text-[11px] text-muted-foreground" data-testid="leave-credit-crosses-midnight">
                          {t('table.crossesMidnight')}
                        </p>
                      </td>
                    </tr>
                  )}
                  {(mismatch != null || ordinaryUnavailable || below) && (
                    <tr>
                      <td colSpan={8} className="px-3 pb-2 text-[11px] font-medium text-destructive">
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
