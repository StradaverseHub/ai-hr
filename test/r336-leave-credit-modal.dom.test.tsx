/**
 * r336 · cbfa8b0b — THE RENDER CHECK for the Leave Credit request modal, in all six locales.
 *
 * ⚠️⚠️ UPDATED BY r343's FIX PASS, NOT DELETED, AND WHAT CHANGED IS THE DECISION IT PINNED.
 *
 * This file used to pin r336's approved design: ONE modal with TWO SECTIONS (non-working-day work, and
 * extended hours on an ordinary day), each with its own rows, its own "+ Add date" and its own total, and the
 * day type READ-ONLY beside each date. The reporter's contest on cbfa8b0b reverses that in as many words —
 * "Do not create separate sections/screens for these day types. All four types must be submitted from the
 * same screen and displayed in the same request table" — and makes the day type a four-option INPUT the
 * roster then adjudicates. CLAUDE.md §8: a guard pinning a decision you are reversing is UPDATED, not
 * deleted. So every case below still tests the thing it was written to test, at the surface that now carries
 * it:
 *
 *   · "Section B derives its figures and never offers them as inputs"  → the ORDINARY DAY ROW does;
 *   · "under the half-day threshold prints the sentence and blocks"    → unchanged, on that same row;
 *   · "a non-working day typed into Section B" / "Section A refuses a working day" → became the ROSTER
 *     MISMATCH in r343, which was strictly stronger: it also caught rest day vs off day vs public holiday,
 *     which neither section could ever see (all three were one code path). ⚠️ r360 then removed the input, so
 *     the mismatch is UNPRODUCIBLE from this screen and both directions are pinned here as "the cell reads the
 *     roster's answer for the date"; the refusal itself stays guarded against a tampered post, in
 *     test/r343-leave-credit-single-table.test.ts;
 *   · "the day type is read-only, never an input"                      → reversed by the reporter in r343
 *     to an input of four options with adjudication, and reversed BACK in r360 to a read-only fact with a
 *     provenance caption. The adjudication r343 added is what settled it: the server refuses any day type
 *     that disagrees with the roster, so the dropdown could never be accepted on its own terms;
 *   · "the grand total is both sections added"                         → ONE total over one table's rows.
 *
 * WHY A DOM TEST AND NOT A PAGE FETCH. The modal is a `Dialog.Portal`: it MOUNTS ON OPEN, so it is not in
 * the server HTML at all and curling /leave proves nothing about it. r334 hit exactly this. A missing key
 * would paint `MISSING_MESSAGE` in the browser while the route still returned 200, passed tsc, passed the
 * suite and passed `next build` — only an opened render sees it.
 *
 * WHAT THIS FILE OWNS NOW, and what it does not: it owns THE SHELL AND ITS WIRING — that the trigger the
 * employee knows opens a dialog whose body is the single table, that the two sections are gone from the
 * surface they were mounted on, and that the shell's own two sentences resolve in six locales. The table's
 * own behaviour is pinned in test/r343-leave-credit-table.dom.test.tsx; the cases below exercise it THROUGH
 * the dialog on purpose, because "the reporter opens the button and finds the new form" is a property of the
 * wiring, not of the component.
 *
 * AND WHY SIX LOCALES EXPLICITLY. `i18n/request.ts` DEEP-MERGES each locale over English, so a key missing
 * from ms.json silently renders the English sentence rather than `MISSING_MESSAGE`. Note what that means for
 * the assertions here: comparing the DOM with the same catalogue fed to the provider catches an UNRESOLVED
 * key and nothing else — it cannot tell a translation from English text sitting in zh.json. The independent
 * checks for that live in test/r343-leave-credit-single-table.test.ts (an exact named set of the keys that
 * ship English) and in test/r343-leave-credit-table.dom.test.tsx (two renders compared with each other).
 */
import { describe, expect, it, vi as vitestVi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { ReplacementLeaveRequestDialog } from '../components/leave/replacement-leave-request-dialog';
import type { LeaveCreditDayFacts } from '../components/leave/leave-credit-request-table';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

const copy = (locale: Locale) =>
  (CATALOGUES[locale] as unknown as { replacementRequest: Record<string, any> }).replacementRequest;

/** next-intl paints the key path when a key does not resolve. A bare key in the DOM is the defect. */
const looksUnresolved = (text: string) => /MISSING_MESSAGE/.test(text) || /replacementRequest\./.test(text);

const TIERS = {
  extendedHalfDayMinutes: 240,
  extendedFullDayMinutes: 480,
  extendedBreakMinutes: 0,
  extendedGraceMinutes: 0,
};

// r365 cbfa8b0b — `shiftStart`, `actualClockIn` and `approvedOtPlan` joined LeaveCreditDayFacts for the
// Attendance panel behind the row's View button. None of the three is an input to any figure.
/** A working day with eight hours measured past an 18:00 shift end. */
const WORKING_DAY: LeaveCreditDayFacts = {
  kind: 'workday',
  shiftStart: '09:00:00',
  shiftEnd: '18:00:00',
  actualClockIn: '08:52:00',
  actualClockOut: '02:00:00',
  measuredExtendedMinutes: 480,
  approvedOtPlan: null,
};
const REST_DAY_VIEW: LeaveCreditDayFacts = {
  kind: 'rest_day',
  shiftStart: null,
  shiftEnd: null,
  actualClockIn: '08:00:00',
  actualClockOut: '17:00:00',
  measuredExtendedMinutes: 0,
  approvedOtPlan: null,
};
/** r360 — a public holiday, whose provenance caption is the one that must NOT name the roster. */
const HOLIDAY_VIEW: LeaveCreditDayFacts = {
  kind: 'holiday',
  shiftStart: null,
  shiftEnd: null,
  actualClockIn: '08:00:00',
  actualClockOut: '17:00:00',
  measuredExtendedMinutes: 0,
  approvedOtPlan: null,
};

function mount(
  locale: Locale,
  opts: {
    /** What the ROSTER answers for every date typed. Default: a rest day. */
    facts?: LeaveCreditDayFacts | null;
    /** NULL ⇒ the company has not switched extended hours on. The four options are offered either way. */
    tiers?: typeof TIERS | null;
    /** Per-date roster answers, for the rows-of-different-day-types case. Wins over `facts`. */
    factsFor?: (workedDate: string) => LeaveCreditDayFacts | null;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <ReplacementLeaveRequestDialog
        replacementType={{ id: 'lt-1', name: 'Replacement Leave' }}
        submitAction={() => {}}
        today="2026-09-24"
        dayFactsAction={vitestVi.fn(async (d: string) =>
          opts.factsFor ? opts.factsFor(d) : opts.facts === undefined ? REST_DAY_VIEW : opts.facts,
        )}
        // r358 — opts.tiers === null used to mean "extended hours off"; it is the SWITCH now, and
        // the ladder is always present because every day type uses it.
        tiers={TIERS}
        ordinaryDayAllowed={opts.tiers !== null}
      />
    </NextIntlClientProvider>,
  );
}

const openModal = async (user: ReturnType<typeof userEvent.setup>, locale: Locale) => {
  await user.click(screen.getByRole('button', { name: copy(locale).trigger }));
  await screen.findByTestId('leave-credit-request-dialog');
};

/** The row controls, addressed the way the employee sees them: by their labels. */
const dateInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).workedDate)[0] as HTMLInputElement;
/**
 * ⚠️ r360 — `dayTypeSelect` STOOD HERE (`getAllByLabelText(copy(locale).sectionA.dayType)[0] as
 * HTMLSelectElement`). The cell is read-only, so it is READ rather than driven, and the label is compared
 * EXACTLY: `Ngày nghỉ` is a prefix of `Ngày nghỉ hằng tuần` in vi, so `toContain` would call an off day a
 * rest day.
 */
const DAY_KIND_KEY = { rest_day: 'restDay', off_day: 'offDay', holiday: 'holiday', workday: 'workday' } as const;
type Kind = keyof typeof DAY_KIND_KEY;
const dayKindLabel = (locale: Locale, kind: Kind) => copy(locale).dayKind[DAY_KIND_KEY[kind]] as string;
const dayTypeCell = (n = 0) => screen.getAllByTestId('leave-credit-day-type')[n] as HTMLElement;
const dayTypeText = (n = 0) => dayTypeCell(n).querySelector('span')?.textContent?.trim() ?? '';
const dayTypeSource = (n = 0) => screen.getAllByTestId('leave-credit-day-type-source')[n] as HTMLElement;
/** The replacement for `user.selectOptions(dayTypeSelect(locale), kind)`: the ROSTER fills it, so we WAIT. */
const awaitDayType = (locale: Locale, kind: Kind, n = 0) =>
  waitFor(() => expect(dayTypeText(n)).toBe(dayKindLabel(locale, kind)));
const startInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).sectionB.extendedStart)[0] as HTMLInputElement;
const endInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).sectionB.extendedEnd)[0] as HTMLInputElement;
const submitButton = () => screen.getByTestId('leave-credit-submit') as HTMLButtonElement;

describe('r343 · the modal opens on ONE table, in every locale, with no unresolved key', () => {
  for (const locale of LOCALES) {
    it(`${locale}: the title, the purpose sentence and the total label are this locale's own strings`, async () => {
      const user = userEvent.setup();
      mount(locale);
      await openModal(user, locale);
      const c = copy(locale);
      const dialog = screen.getByTestId('leave-credit-request-dialog');

      expect(within(dialog).getByText(c.title)).toBeTruthy();
      // The shell's own sentence — what a Leave Credit IS. The table draws its own helper line for how the
      // rows work; both are wanted and they say different things.
      expect(screen.getByTestId('leave-credit-dialog-description')).toHaveTextContent(c.description);
      expect(screen.getByTestId('leave-credit-total-label')).toHaveTextContent(c.grandTotal);
      expect(looksUnresolved(dialog.textContent ?? '')).toBe(false);
    });
  }

  it('the six locales are genuinely six DIFFERENT purpose sentences, not English six times', () => {
    const sentences = new Set(LOCALES.map((l) => copy(l).description));
    expect(sentences.size).toBe(LOCALES.length);
    const dayTypes = new Set(LOCALES.map((l) => copy(l).dayKind.workday));
    expect(dayTypes.size).toBe(LOCALES.length);
  });
});

describe('r343 · ⚠️ THE TWO SECTIONS ARE GONE FROM THE SURFACE THE EMPLOYEE OPENS', () => {
  it('the dialog holds ONE table, one "+ Add date" and one total — and neither section container', async () => {
    const user = userEvent.setup();
    mount('en');
    await openModal(user, 'en');
    const dialog = screen.getByTestId('leave-credit-request-dialog');

    expect(dialog.querySelectorAll('table')).toHaveLength(1);
    expect(screen.getAllByTestId('leave-credit-add-row')).toHaveLength(1);
    expect(screen.getAllByTestId('leave-credit-total')).toHaveLength(1);
    // r336's own testids. Any one of them here is the rejected design back on the reporter's screen.
    for (const gone of ['leave-credit-section-a', 'leave-credit-section-b', 'leave-credit-total-a', 'leave-credit-total-b']) {
      expect(screen.queryAllByTestId(gone), gone).toHaveLength(0);
    }
    // …and r336's two sets of posted field names, which the by-index zip depended on.
    for (const name of ['aWorkedDate', 'aDays', 'bWorkedDate', 'bStart', 'bEnd']) {
      expect(dialog.querySelector(`[name="${name}"]`), name).toBeNull();
    }
  });

  /**
   * ⚠️⚠️ REVERSED A SECOND TIME, BACK TO WHERE r336 STARTED — AND THE ROUND TRIP IS THE POINT.
   *
   *   r336 built the day type READ-ONLY, arguing "the kind of day a date is is not the employee's to
   *        assert".
   *   r343 the reporter contested that and asked for an INPUT of four options PLUS a roster check. Both
   *        were built, and this case asserted `select.tagName === 'SELECT'` with the four options.
   *   r360 (cbfa8b0b) the reporter asks for read-only again, with a caption saying where the value came
   *        from.
   *
   * SO WE ARE BACK AT r336's DESIGN, BUT NOT BY r336's ARGUMENT — and that distinction is why this is a
   * reversal rather than an undo. The roster check r343 added is what settles it: `leaveCreditRosterKinds`
   * resolves EVERY date, so `adjudicateDayTypes` never skips a row, and `submitLeaveCreditRequest` throws
   * on ANY disagreement. The dropdown therefore offered a choice the server would always refuse unless it
   * happened to match. Making it read-only removes no capability that existed; it removes a way to fail.
   *
   * Both earlier claims are kept above so a fourth round can see the whole path rather than the last step.
   */
  it('the day type is a READ-ONLY fact with its provenance, not a dropdown', async () => {
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY });
    await openModal(user, 'en');
    await user.type(dateInput('en'), '2026-09-16');
    // No control at all: not a select, not an input, nothing the employee can change.
    await waitFor(() => expect(screen.queryAllByRole('combobox', { name: copy('en').sectionA.dayType })).toHaveLength(0));
    const cell = screen.getAllByTestId('leave-credit-day-type')[0];
    expect(cell.tagName).not.toBe('SELECT');
    expect(cell.querySelector('select'), 'no select survives inside the cell either').toBeNull();
    // …and it says where the value came from, which is the other half of the ask.
    await waitFor(() => expect(screen.getAllByTestId('leave-credit-day-type-source')[0]).toBeTruthy());
  });

  /**
   * ⚠️ REVERSED IN r360. THE OLD CLAIM: `the four options are offered on a company WITHOUT extended hours too
   * — exactly four, always`, asserting `[...dayTypeSelect('en').options].map((o) => o.value)` equalled
   * `['', 'rest_day', 'off_day', 'holiday', 'workday']` with the tier figures absent. It existed because
   * r343's first cut filtered Ordinary Day out on a company with no tiers — which is every company, since
   * `extended_hours_enabled` is `NOT NULL DEFAULT false` (migration 0486).
   *
   * There is no list to count. The requirement underneath it — an Ordinary Day is a fact about the DATE and
   * not a feature flag — is asserted as the thing it now is: on a company with extended hours OFF, a date the
   * roster calls an ordinary working day still READS as one, captioned, with no control anywhere near it.
   * (Four kinds × two switch states is pinned in test/r343-leave-credit-table.dom.test.tsx; this is the same
   * claim reached through the dialog, which is what this file owns.)
   */
  it('a company WITHOUT extended hours still reads an ordinary working day back — and offers no control for it', async () => {
    const user = userEvent.setup();
    mount('en', { tiers: null, facts: WORKING_DAY });
    await openModal(user, 'en');
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', 'workday');
    expect(dayTypeSource().textContent).toBe(en.replacementRequest.table.dayTypeFromRoster);
    const dialog = screen.getByTestId('leave-credit-request-dialog');
    expect(dialog.querySelectorAll('select'), 'no select survives anywhere in the dialog').toHaveLength(0);
    expect(dialog.querySelectorAll('option'), 'and no option either').toHaveLength(0);
    expect(screen.queryAllByLabelText(copy('en').sectionA.dayType), 'the Day Type label addresses no control').toHaveLength(0);
  });

  /**
   * ⚠️ r360 — NEW, AND IT BELONGS HERE RATHER THAN ONLY ON THE COMPONENT: the caption is what the reporter
   * asked for alongside the read-only cell, and this file owns what the employee finds when they open the
   * button they already know. A public holiday outranks the roster in `scheduleFor`, so the two provenances
   * are different facts; a component that printed one string for both would pass every other case in this file.
   */
  it('the provenance names the PUBLIC HOLIDAY CALENDAR for a holiday and the ROSTER for the other kinds', async () => {
    for (const [kind, facts] of [
      ['holiday', HOLIDAY_VIEW],
      ['rest_day', REST_DAY_VIEW],
      ['workday', WORKING_DAY],
    ] as const) {
      const user = userEvent.setup();
      const { unmount } = mount('en', { facts });
      await openModal(user, 'en');
      await user.type(dateInput('en'), '2026-09-16');
      await awaitDayType('en', kind);
      const expected =
        kind === 'holiday' ? en.replacementRequest.table.dayTypeFromHolidays : en.replacementRequest.table.dayTypeFromRoster;
      const other =
        kind === 'holiday' ? en.replacementRequest.table.dayTypeFromRoster : en.replacementRequest.table.dayTypeFromHolidays;
      expect(dayTypeSource().textContent, kind).toBe(expected);
      expect(dayTypeSource().textContent, `${kind}: the two captions must not be merged`).not.toBe(other);
      unmount();
    }
  });

  it('the unit is still derived and still not a choice — and nothing posts it any more', async () => {
    const user = userEvent.setup();
    mount('en');
    await openModal(user, 'en');
    // r378 removes the redundant disabled unit field; totals still state their derived day unit.
    expect(screen.queryByTestId('leave-credit-unit')).toBeNull();
    expect(screen.getByTestId('leave-credit-total')).toHaveTextContent(en.replacementRequest.totalDays.replace('{days}', '0.00'));
    // r336 posted `<input type="hidden" name="unit" value="day">`. `submitLeaveCreditRequest` derives the
    // unit itself (every row of this table credits in days), so the field is gone rather than restated.
    expect(screen.getByTestId('leave-credit-request-dialog').querySelector('input[name="unit"]')).toBeNull();
  });
});

describe('r343 · the ordinary-day row derives its figures and never offers them as inputs', () => {
  it('eligible minutes and credit follow the typed window, and both are read-only', async () => {
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY });
    await openModal(user, 'en');
    await user.type(dateInput('en'), '2026-09-16');
    // r360 — was `await user.selectOptions(dayTypeSelect('en'), 'workday')`. WORKING_DAY's own `kind` makes
    // this the ordinary-day row, and the wait is load-bearing: the two time cells are disabled until the day
    // type is known and `user.type` into a disabled input does nothing at all.
    await awaitDayType('en', 'workday');
    await user.type(startInput('en'), '18:00');
    await user.type(endInput('en'), '22:00');

    // 18:00 → 22:00 is 240 minutes, inside the measured 480 ⇒ half a day.
    await waitFor(() => expect(screen.getByTestId('leave-credit-eligible-minutes')).toHaveTextContent('4h'));
    expect(screen.getByTestId('leave-credit-row-credit')).toHaveTextContent('0.5');
    expect(screen.getByTestId('leave-credit-total')).toHaveTextContent('0.5');

    // DERIVED, never typed: neither figure is an input the browser would submit.
    expect(screen.getByTestId('leave-credit-eligible-minutes').tagName).not.toBe('INPUT');
    expect(screen.getByTestId('leave-credit-row-credit').tagName).not.toBe('INPUT');
    const dialog = screen.getByTestId('leave-credit-request-dialog');
    expect(dialog.querySelector('input[name="eligibleMinutes"]')).toBeNull();
    expect(dialog.querySelector('input[name="credit"]')).toBeNull();

    /**
     * ⚠️ r365 cbfa8b0b — THIS READ, AND THE CLAIM IS KEPT RATHER THAN DROPPED:
     *
     *     // The two read-only facts are shown, trimmed to HH:MM.
     *     expect(screen.getByTestId('leave-credit-shift-end')).toHaveTextContent('18:00');
     *     expect(screen.getByTestId('leave-credit-clock-out')).toHaveTextContent('02:00');
     *
     * The two cells left the row for the panel behind the Attendance › View button, so the facts are still
     * shown and still trimmed to HH:MM — one click away. The dialog's job here is that it renders the SAME
     * component as /leave/credit, so the panel's own contents are asserted once, against that component, in
     * test/r343-leave-credit-table.dom.test.tsx. What this case can still say from inside the dialog is
     * that the control reached it and is live, which is the half a missing column would break.
     */
    const disclosure = screen.getByTestId('leave-credit-details-toggle') as HTMLButtonElement;
    expect(disclosure.disabled).toBe(false);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    await user.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    const facts = screen.getByTestId('leave-credit-attendance-panel');
    expect(facts.closest('td')).not.toBeNull();
    expect(facts).toHaveTextContent('18:00');
    expect(facts).toHaveTextContent('02:00');
    expect(screen.queryAllByTestId('leave-credit-shift-end')).toHaveLength(0);
    expect(screen.queryAllByTestId('leave-credit-clock-out')).toHaveLength(0);
    // r358 — this read `expect(daysSelect('en').disabled).toBe(true)`, "the Days cell is dead on this
    // row, which is what used to be a different section". There is no Days cell on any row now: the
    // owner replaced the declared figure with the claimed window for every day type.
    expect(screen.queryAllByTestId('leave-credit-days')).toHaveLength(0);
  });

  it('under the half-day threshold prints the exact sentence and BLOCKS the submit', async () => {
    const user = userEvent.setup();
    // The roster answers per date, so the valid first row is genuinely a rest day and the offending second
    // row is genuinely an ordinary working day — a single answer for both would make the first row a mismatch
    // and block the submit for the wrong reason, which is what the non-vacuity note below is about.
    mount('en', { factsFor: (d) => (d === '2026-09-16' ? { ...WORKING_DAY, measuredExtendedMinutes: 180 } : REST_DAY_VIEW) });
    await openModal(user, 'en');
    const reason = screen.getByTestId('leave-credit-request-dialog').querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    expect(reason.required).toBe(true);
    await user.type(reason, 'Synthetic requested leave credit');
    // ⚠️ NON-VACUITY, kept from r336 and adapted: a VALID row is filled FIRST — same table now, second row —
    // so the total is above zero and the button would be enabled but for the offending one. Without it the
    // assertion passes on an empty form, where the button is disabled because nothing is claimed.
    await user.type(dateInput('en'), '2026-09-20');
    await awaitDayType('en', 'rest_day'); // r360 — was selectOptions(…, 'rest_day').
    // r358 — the valid first row needs its window now; it used to inherit 1.00 from the Days default.
    await user.type(startInput('en'), '09:00');
    await user.type(endInput('en'), '17:00');
    await waitFor(() => expect(screen.getByTestId('leave-credit-total')).toHaveTextContent('1'));
    expect(submitButton().disabled).toBe(false);

    await user.click(screen.getByTestId('leave-credit-add-row'));
    const dates = screen.getAllByLabelText(en.replacementRequest.workedDate);
    await user.type(dates[1], '2026-09-16');
    // r360 — was `selectOptions(getAllByLabelText(sectionA.dayType)[1], 'workday')`. The SECOND row fills from
    // its own date, which is what keeps this two genuinely different day types in one table.
    await awaitDayType('en', 'workday', 1);
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedStart)[1], '18:00');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedEnd)[1], '21:00'); // 180 min

    await waitFor(() => expect(screen.getByTestId('leave-credit-below-threshold')).toBeTruthy());
    expect(screen.getByTestId('leave-credit-below-threshold')).toHaveTextContent('Under 240 minutes. Not eligible for credit.');
    expect(submitButton().disabled).toBe(true);
  });
});

describe('r343 · what the two sections used to refuse — and why r360 leaves nothing HERE to refuse', () => {
  /**
   * ⚠️⚠️ BOTH DIRECTIONS WENT STRUCTURALLY UNREACHABLE IN r360, AND ARE REPLACED RATHER THAN DELETED.
   *
   * THE TWO OLD CLAIMS, in full, because this is the third design this one requirement has had:
   *
   *   r336 drew two sections and refused across them. `sectionB.nonWorkingDayRefused` said "This date is not a
   *        working day. Use Non-working-day work instead." and `sectionA.workingDayRefused` was its mirror.
   *   r343 replaced both with the ROSTER MISMATCH, and these two cases were:
   *          `Ordinary Day chosen on a date the roster calls a REST day is refused, naming the rest day`
   *            — selectOptions(…, 'workday') on REST_DAY_VIEW, then `leave-credit-roster-mismatch` contains
   *              `dayKind.restDay`, submit disabled;
   *          `Rest Day chosen on a date the roster calls an ORDINARY WORKING day is refused, naming it`
   *            — selectOptions(…, 'rest_day') on WORKING_DAY, then the message contains `dayKind.workday`.
   *        The comment on the second one is worth keeping verbatim, because it is still the reason the
   *        adjudication exists at all: "an ordinary working day CAN earn a credit now (for the hours past the
   *        shift end), so what is refused is not the date, it is the employee's DESCRIPTION of it."
   *   r360 the employee has no description to give. The cell is filled from the roster and cleared when the
   *        date moves, so neither direction can be built on this screen.
   *
   * ⚠️ AND THE REFUSAL IS STILL PINNED WHERE IT IS STILL A CONTROL — not here. A screen cannot close the
   * tampered-post path, and test/r343-leave-credit-single-table.test.ts posts the mismatching row STRAIGHT
   * into `submitLeaveCreditRequest` ("⚠️ a row typed 'Rest Day' on a date the roster calls an OFF day is
   * REFUSED, naming the off day", plus "THE VACUITY CONTROL — the layer below ACCEPTS the very same claim").
   * What is left for this file is the positive half of both directions: the row shows the ROSTER's answer for
   * the date, whichever kind that is, so the two mix-ups have nowhere to start.
   */
  it.each([
    ['a REST day', REST_DAY_VIEW, 'rest_day', '2026-09-20'],
    ['an ORDINARY WORKING day', WORKING_DAY, 'workday', '2026-09-16'],
  ] as const)('a date the roster calls %s reads back as exactly that, and no row disagrees with it', async (_name, facts, kind, date) => {
    const user = userEvent.setup();
    mount('en', { facts });
    await openModal(user, 'en');
    await user.type(dateInput('en'), date);
    await awaitDayType('en', kind);
    // The other three kinds are NOT what the cell says — the assertion that a single hardcoded label would fail.
    for (const other of ['rest_day', 'off_day', 'holiday', 'workday'] as const) {
      if (other === kind) continue;
      expect(dayTypeText(), `${date} must not read as ${other}`).not.toBe(dayKindLabel('en', other));
    }
    expect(screen.queryByTestId('leave-credit-roster-mismatch'), 'nothing to adjudicate: the cell IS the roster').toBeNull();
    // …and the posted value is the roster's, which is what the service re-checks.
    expect(
      (screen.getByTestId('leave-credit-request-dialog').querySelector('input[name="dayType"]') as HTMLInputElement).value,
    ).toBe(kind);
  });

  /**
   * ⚠️ REVERSED IN r358. This read "the Days cell offers exactly 1 day and 0.5 day, and nothing else",
   * asserting `[...daysSelect('en').options].map(o => o.value)` equalled `['1', '0.5']`. The owner's
   * answer removed the choice: "The system should calculate the credit based on the actual eligible
   * hours worked, regardless of the Day Type." What is pinned instead is that the cell is GONE — an
   * assertion the old one could not make, and the one that fails if the dropdown is ever reinstated.
   */
  it('there is no Days cell on any row — the credit is derived, never chosen', async () => {
    const user = userEvent.setup();
    mount('en');
    await openModal(user, 'en');
    expect(screen.queryAllByTestId('leave-credit-days')).toHaveLength(0);
    expect(screen.queryAllByLabelText(copy('en').days)).toHaveLength(0);
  });
});

describe('r343 · ONE total, over rows of different day types in ONE table', () => {
  it('adds a rest-day credit to an ordinary-day credit — both derived, one ladder', async () => {
    const user = userEvent.setup();
    // Two different roster answers, so the two rows are genuinely different day types in one table.
    mount('en', { factsFor: (d) => (d === '2026-09-16' ? WORKING_DAY : REST_DAY_VIEW) });
    await openModal(user, 'en');
    const reason = screen.getByTestId('leave-credit-request-dialog').querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    expect(reason.required).toBe(true);
    await user.type(reason, 'Synthetic requested leave credit');

    await user.type(dateInput('en'), '2026-09-20');
    await awaitDayType('en', 'rest_day'); // r360 — was selectOptions(…, 'rest_day').
    // r358 — eight hours on the rest day earns the full day the picker used to default to.
    await user.type(startInput('en'), '09:00');
    await user.type(endInput('en'), '17:00');
    await user.click(screen.getByTestId('leave-credit-add-row'));

    const dates = screen.getAllByLabelText(en.replacementRequest.workedDate);
    await user.type(dates[1], '2026-09-16');
    await awaitDayType('en', 'workday', 1); // r360 — was selectOptions(…[1], 'workday').
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedStart)[1], '18:00');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedEnd)[1], '22:00');

    // 1 + 0.5, both derived from a window now. Not an independent arithmetic: the same two figures the
    // employee can read on the rows.
    await waitFor(() => expect(screen.getByTestId('leave-credit-total')).toHaveTextContent('1.5'));
    expect(submitButton().disabled).toBe(false);
  });
});
