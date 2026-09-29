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
 *   · "a non-working day typed into Section B" / "Section A refuses a working day" → BOTH are now the ROSTER
 *     MISMATCH, which is strictly stronger: it also catches rest day vs off day vs public holiday, which
 *     neither section could ever see (all three were one code path);
 *   · "the day type is read-only, never an input"                      → REVERSED BY THE REPORTER: it is an
 *     input, with exactly four options, and the assertion is now that the four are offered and adjudicated;
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

/** A working day with eight hours measured past an 18:00 shift end. */
const WORKING_DAY: LeaveCreditDayFacts = {
  kind: 'workday',
  shiftEnd: '18:00:00',
  actualClockOut: '02:00:00',
  measuredExtendedMinutes: 480,
};
const REST_DAY_VIEW: LeaveCreditDayFacts = {
  kind: 'rest_day',
  shiftEnd: null,
  actualClockOut: '17:00:00',
  measuredExtendedMinutes: 0,
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
const dayTypeSelect = (locale: Locale) => screen.getAllByLabelText(copy(locale).sectionA.dayType)[0] as HTMLSelectElement;
const daysSelect = (locale: Locale) => screen.getAllByLabelText(copy(locale).days)[0] as HTMLSelectElement;
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

  it('⚠️ REVERSED BY THE REPORTER: the day type is an INPUT of exactly four options, not a read-only chip', async () => {
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY });
    await openModal(user, 'en');
    // r336 asserted `select[name="aDayType"]` was absent and a read-only `leave-credit-day-kind` div present,
    // on the argument that "the kind of day a date is is not the employee's to assert". The contest asks for
    // the opposite, plus adjudication — so the control exists and the ROSTER is what checks it.
    const select = dayTypeSelect('en');
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'rest_day', 'off_day', 'holiday', 'workday']);
    expect(screen.queryAllByTestId('leave-credit-day-kind')).toHaveLength(0);
  });

  it('the four options are offered on a company WITHOUT extended hours too — exactly four, always', async () => {
    const user = userEvent.setup();
    mount('en', { tiers: null });
    await openModal(user, 'en');
    expect([...dayTypeSelect('en').options].map((o) => o.value)).toEqual(['', 'rest_day', 'off_day', 'holiday', 'workday']);
  });

  it('the unit is still derived and still not a choice — and nothing posts it any more', async () => {
    const user = userEvent.setup();
    mount('en');
    await openModal(user, 'en');
    const unit = screen.getByTestId('leave-credit-unit') as HTMLInputElement;
    expect(unit.tagName).toBe('INPUT');
    expect(unit.disabled).toBe(true);
    expect(unit.value).toBe(en.replacementRequest.unitDay);
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
    await user.selectOptions(dayTypeSelect('en'), 'workday');
    await user.type(startInput('en'), '18:00');
    await user.type(endInput('en'), '22:00');

    // 18:00 → 22:00 is 240 minutes, inside the measured 480 ⇒ half a day.
    await waitFor(() => expect(screen.getByTestId('leave-credit-eligible-minutes')).toHaveTextContent('240'));
    expect(screen.getByTestId('leave-credit-row-credit')).toHaveTextContent('0.5');
    expect(screen.getByTestId('leave-credit-total')).toHaveTextContent('0.5');

    // DERIVED, never typed: neither figure is an input the browser would submit.
    expect(screen.getByTestId('leave-credit-eligible-minutes').tagName).not.toBe('INPUT');
    expect(screen.getByTestId('leave-credit-row-credit').tagName).not.toBe('INPUT');
    const dialog = screen.getByTestId('leave-credit-request-dialog');
    expect(dialog.querySelector('input[name="eligibleMinutes"]')).toBeNull();
    expect(dialog.querySelector('input[name="credit"]')).toBeNull();

    // The two read-only facts are shown, trimmed to HH:MM.
    expect(screen.getByTestId('leave-credit-shift-end')).toHaveTextContent('18:00');
    expect(screen.getByTestId('leave-credit-clock-out')).toHaveTextContent('02:00');
    // …and the Days cell is dead on this row, which is what used to be "a different section".
    expect(daysSelect('en').disabled).toBe(true);
  });

  it('under the half-day threshold prints the exact sentence and BLOCKS the submit', async () => {
    const user = userEvent.setup();
    // The roster answers per date, so the valid first row is genuinely a rest day and the offending second
    // row is genuinely an ordinary working day — a single answer for both would make the first row a mismatch
    // and block the submit for the wrong reason, which is what the non-vacuity note below is about.
    mount('en', { factsFor: (d) => (d === '2026-09-16' ? { ...WORKING_DAY, measuredExtendedMinutes: 180 } : REST_DAY_VIEW) });
    await openModal(user, 'en');
    // ⚠️ NON-VACUITY, kept from r336 and adapted: a VALID row is filled FIRST — same table now, second row —
    // so the total is above zero and the button would be enabled but for the offending one. Without it the
    // assertion passes on an empty form, where the button is disabled because nothing is claimed.
    await user.type(dateInput('en'), '2026-09-20');
    await user.selectOptions(dayTypeSelect('en'), 'rest_day');
    await waitFor(() => expect(screen.getByTestId('leave-credit-total')).toHaveTextContent('1'));
    expect(submitButton().disabled).toBe(false);

    await user.click(screen.getByTestId('leave-credit-add-row'));
    const dates = screen.getAllByLabelText(en.replacementRequest.workedDate);
    await user.type(dates[1], '2026-09-16');
    await user.selectOptions(screen.getAllByLabelText(en.replacementRequest.sectionA.dayType)[1], 'workday');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedStart)[1], '18:00');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedEnd)[1], '21:00'); // 180 min

    await waitFor(() => expect(screen.getByTestId('leave-credit-below-threshold')).toBeTruthy());
    expect(screen.getByTestId('leave-credit-below-threshold')).toHaveTextContent('Under 240 minutes. Not eligible for credit.');
    expect(submitButton().disabled).toBe(true);
  });
});

describe('r343 · what the two sections used to refuse, the ROSTER now adjudicates — in both directions', () => {
  it('Ordinary Day chosen on a date the roster calls a REST day is refused, naming the rest day', async () => {
    const user = userEvent.setup();
    mount('en', { facts: REST_DAY_VIEW });
    await openModal(user, 'en');
    // r336's `sectionB.nonWorkingDayRefused` ("This date is not a working day. Use Non-working-day work
    // instead.") pointed at the other SECTION. There is no other section to point at, and the employee does
    // not need one: the row says what the roster holds, which is the correction itself.
    await user.type(dateInput('en'), '2026-09-20');
    await user.selectOptions(dayTypeSelect('en'), 'workday');
    const problem = await waitFor(() => screen.getByTestId('leave-credit-roster-mismatch'));
    expect(problem).toHaveTextContent(en.replacementRequest.dayKind.restDay);
    expect(submitButton().disabled).toBe(true);
  });

  it('Rest Day chosen on a date the roster calls an ORDINARY WORKING day is refused, naming it', async () => {
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY });
    await openModal(user, 'en');
    // The mirror of r336's `sectionA.workingDayRefused`. NOT the same claim any more, and deliberately so:
    // an ordinary working day CAN earn a credit now (for the hours past the shift end), so what is refused
    // is not the date, it is the employee's description of it.
    await user.type(dateInput('en'), '2026-09-16');
    await user.selectOptions(dayTypeSelect('en'), 'rest_day');
    const problem = await waitFor(() => screen.getByTestId('leave-credit-roster-mismatch'));
    expect(problem).toHaveTextContent(en.replacementRequest.dayKind.workday);
    expect(submitButton().disabled).toBe(true);
  });

  it('the Days cell offers exactly 1 day and 0.5 day, and nothing else', async () => {
    const user = userEvent.setup();
    mount('en');
    await openModal(user, 'en');
    expect([...daysSelect('en').options].map((o) => o.value)).toEqual(['1', '0.5']);
  });
});

describe('r343 · ONE total, over rows of different day types in ONE table', () => {
  it('adds a declared rest-day credit to a derived ordinary-day credit', async () => {
    const user = userEvent.setup();
    // Two different roster answers, so the two rows are genuinely different day types in one table.
    mount('en', { factsFor: (d) => (d === '2026-09-16' ? WORKING_DAY : REST_DAY_VIEW) });
    await openModal(user, 'en');

    await user.type(dateInput('en'), '2026-09-20');
    await user.selectOptions(dayTypeSelect('en'), 'rest_day');
    await user.click(screen.getByTestId('leave-credit-add-row'));

    const dates = screen.getAllByLabelText(en.replacementRequest.workedDate);
    await user.type(dates[1], '2026-09-16');
    await user.selectOptions(screen.getAllByLabelText(en.replacementRequest.sectionA.dayType)[1], 'workday');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedStart)[1], '18:00');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedEnd)[1], '22:00');

    // 1 + 0.5. Not an independent arithmetic: the same two figures the employee can read on the rows.
    await waitFor(() => expect(screen.getByTestId('leave-credit-total')).toHaveTextContent('1.5'));
    expect(submitButton().disabled).toBe(false);
  });
});
