/**
 * r343 · cbfa8b0b — THE RENDER CHECK for the single-table Leave Credit request, in all six locales.
 *
 * WHY A DOM TEST AND NOT A PAGE FETCH. `/leave/credit` returns 200 with the form absent for any viewer whose
 * company has not switched replacement leave on, so a curl proves nothing about the table (it was confirmed
 * rendering only the heading and the empty-requests card on the seeded dev database). And a key is not a
 * screen: the RSC payload carries the whole catalogue, so grepping fetched HTML for a label is not evidence
 * either (CLAUDE.md §8). Only a mounted render sees a `MISSING_MESSAGE`.
 *
 * AND WHY SIX LOCALES EXPLICITLY. `i18n/request.ts` DEEP-MERGES each locale over English, so a key missing
 * from ms.json renders the English sentence rather than `MISSING_MESSAGE`. Mounting each locale is what
 * catches an unresolved key on this screen.
 *
 * ⚠️ WHAT MOUNTING SIX LOCALES DOES **NOT** PROVE, CORRECTED IN r343's FIX PASS. The first cut of this file
 * claimed these assertions caught English text on a non-English screen because each one compared the DOM
 * against "the locale's own string". It cannot: the expectation is read from the very catalogue handed to
 * `NextIntlClientProvider`, so if zh.json said "Rest day" the assertion would expect "Rest day" and pass.
 * The verifier proved it — overwriting zh's `dayKind.restDay` with English left this file green. Two
 * independent checks replace the claim: `the same screen, rendered in two locales, DIFFERS` below (a
 * comparison between two RENDERS, with no catalogue in the expectation), and an exact named set of the keys
 * that ship English in test/r343-leave-credit-single-table.test.ts.
 *
 * WHAT ELSE IS PINNED HERE, none of it statically assertable:
 *   · ONE table for all four day types — no second section, one "+ Add date", one total;
 *   · EXACTLY FOUR day-type options, on a company with extended hours and on one without;
 *   · the per-row conditional as DISABLED CELLS: an Ordinary Day row takes the claimed window and not the
 *     Days figure, the other three the reverse, on the same row of the same table;
 *   · the roster MISMATCH message naming what the roster holds, and that it BLOCKS the submit button;
 *   · an Ordinary Day row on a company without extended hours SAYS it earns nothing and blocks the submit;
 *   · the derived cells are not inputs — the employee cannot type an eligible-minutes figure or a credit.
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

import { LeaveCreditRequestTable, type LeaveCreditDayFacts } from '../components/leave/leave-credit-request-table';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
const copy = (locale: Locale) => (CATALOGUES[locale] as unknown as { replacementRequest: Record<string, any> }).replacementRequest;

/** next-intl paints the key path when a key does not resolve. A bare key in the DOM is the defect. */
const looksUnresolved = (text: string) => /MISSING_MESSAGE/.test(text) || /replacementRequest\./.test(text);

const TIERS = { extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 };

/** A working day with eight hours measured past an 18:00 shift end. */
const WORKING_DAY: LeaveCreditDayFacts = { kind: 'workday', shiftEnd: '18:00:00', actualClockOut: '02:00:00', measuredExtendedMinutes: 480 };
const OFF_DAY: LeaveCreditDayFacts = { kind: 'off_day', shiftEnd: null, actualClockOut: '17:00:00', measuredExtendedMinutes: 0 };
const REST_DAY: LeaveCreditDayFacts = { kind: 'rest_day', shiftEnd: null, actualClockOut: '17:00:00', measuredExtendedMinutes: 0 };

function mount(locale: Locale, opts: { facts?: LeaveCreditDayFacts | null; tiers?: typeof TIERS | null } = {}) {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <LeaveCreditRequestTable
        replacementType={{ id: 'lt-1', name: 'Replacement Leave' }}
        submitAction={() => {}}
        today="2026-09-24"
        dayFactsAction={vitestVi.fn(async () => (opts.facts === undefined ? REST_DAY : opts.facts))}
        extendedHoursTiers={opts.tiers === undefined ? TIERS : opts.tiers}
      />
    </NextIntlClientProvider>,
  );
}

const dayTypeSelect = (locale: Locale) => screen.getAllByLabelText(copy(locale).sectionA.dayType)[0] as HTMLSelectElement;
const daysSelect = (locale: Locale) => screen.getAllByLabelText(copy(locale).days)[0] as HTMLSelectElement;
const dateInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).workedDate)[0] as HTMLInputElement;
const startInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).sectionB.extendedStart)[0] as HTMLInputElement;
const endInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).sectionB.extendedEnd)[0] as HTMLInputElement;

describe('r343 · the single table renders in all six locales, with no unresolved key', () => {
  it.each(LOCALES)('%s — one table, the four day types in that locale, and no MISSING_MESSAGE', async (locale) => {
    const { container } = mount(locale);
    const c = copy(locale);

    // ONE table. Two would be the two sections coming back under another name.
    expect(container.querySelectorAll('table')).toHaveLength(1);

    const select = dayTypeSelect(locale);
    const options = [...select.options].map((o) => o.textContent?.trim());
    // The placeholder plus the reporter's four options, each in THIS locale's own words.
    expect(options).toEqual([c.table.dayTypeChoose, c.dayKind.restDay, c.dayKind.offDay, c.dayKind.holiday, c.dayKind.workday]);

    expect(looksUnresolved(container.textContent ?? '')).toBe(false);
    expect(screen.getByTestId('leave-credit-helper').textContent).toBe(c.table.help);
  });
});

/**
 * THE ONE CHECK IN THIS FILE THAT DOES NOT READ THE CATALOGUE INTO ITS EXPECTATION.
 *
 * Everything above compares the DOM with the same JSON it gave the provider, so it is blind to translation
 * quality by construction (see the header). This compares TWO RENDERS of the same component: whatever zh.json
 * says, the Chinese screen's day-type options, its submit button and its total label must not be the English
 * screen's — and the strings this surface knowingly ships in English must be IDENTICAL across the two, which
 * is the same debt stated from the render side rather than the catalogue side.
 */
describe('r343 · the same screen, rendered in two locales, DIFFERS where it claims to be translated', () => {
  /** What the screen SAYS, read off the DOM with no catalogue involved. */
  const spoken = (locale: Locale) => {
    const { unmount } = mount(locale);
    const select = dayTypeSelect(locale);
    const out = {
      /** The four day types, in order — composed from the `dayKind.*` keys, which are translated. */
      dayTypes: [...select.options].slice(1).map((o) => o.textContent?.trim() ?? ''),
      submit: screen.getByTestId('leave-credit-submit').textContent?.trim() ?? '',
      totalLabel: screen.getByTestId('leave-credit-total-label').textContent?.trim() ?? '',
      /** Knowingly English on all six screens: the placeholder row and the "+ Add date" button. */
      placeholder: select.options[0].textContent?.trim() ?? '',
      addRow: screen.getByTestId('leave-credit-add-row').textContent?.trim() ?? '',
    };
    unmount();
    return out;
  };

  it.each(LOCALES.filter((l) => l !== 'en'))('%s — the day types, the submit and the total are NOT the English words', (locale) => {
    const english = spoken('en');
    const other = spoken(locale);
    expect(other.dayTypes).toHaveLength(4);
    other.dayTypes.forEach((word, i) => {
      expect(word, `${locale}: day type ${i} still reads the English "${english.dayTypes[i]}"`).not.toBe(english.dayTypes[i]);
      expect(word.length, `${locale}: day type ${i} is empty`).toBeGreaterThan(0);
    });
    expect(other.submit, `${locale}: the submit button still reads English`).not.toBe(english.submit);
    expect(other.totalLabel, `${locale}: the total label still reads English`).not.toBe(english.totalLabel);
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s — and the two strings this screen ships in English are the same words', (locale) => {
    // NOT an accident and not hidden: `table.dayTypeChoose` and `addRow` are English in all six catalogues,
    // with the whole English set named in test/r343-leave-credit-single-table.test.ts. Asserting the sameness
    // is what keeps this case honest — it fails if the debt is paid off without the list being updated.
    const english = spoken('en');
    const other = spoken(locale);
    expect(other.placeholder).toBe(english.placeholder);
    expect(other.addRow).toBe(english.addRow);
  });
});

describe('r343 · the per-row conditional, as disabled cells on ONE row', () => {
  it('an Ordinary Day row takes the claimed window and NOT the Days figure', async () => {
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY });
    await user.type(dateInput('en'), '2026-09-16');
    await user.selectOptions(dayTypeSelect('en'), 'workday');
    expect(startInput('en').disabled).toBe(false);
    expect(endInput('en').disabled).toBe(false);
    expect(daysSelect('en').disabled).toBe(true);
  });

  it('a Rest Day row takes the Days figure and NOT the claimed window — same row, same table', async () => {
    const user = userEvent.setup();
    mount('en', { facts: REST_DAY });
    await user.type(dateInput('en'), '2026-09-13');
    await user.selectOptions(dayTypeSelect('en'), 'rest_day');
    expect(daysSelect('en').disabled).toBe(false);
    expect(startInput('en').disabled).toBe(true);
    expect(endInput('en').disabled).toBe(true);
  });

  it('the derived cells are not inputs: the employee cannot type an eligible-minutes figure or a credit', () => {
    mount('en', { facts: WORKING_DAY });
    for (const id of ['leave-credit-eligible-minutes', 'leave-credit-row-credit', 'leave-credit-shift-end', 'leave-credit-clock-out']) {
      const cell = screen.getAllByTestId(id)[0];
      expect(within(cell).queryByRole('textbox'), id).toBeNull();
      expect(cell.querySelector('input'), id).toBeNull();
    }
  });

  /**
   * ⚠️ REVERSED IN r343's FIX PASS, AND THE OLD ASSERTION WAS THE DEFECT IT PINNED.
   *
   * This case used to read "without the company's tier figures the Ordinary Day option is not offered at
   * all" and asserted a THREE-option dropdown. `toil_policy.extended_hours_enabled` is `NOT NULL DEFAULT
   * false` (migration 0486), so that is the state of every company at release — meaning the reporter, who
   * asked for "exactly four options: Rest Day, Off Day, Public Holiday, Ordinary Day", would have opened the
   * screen and counted three. A requirement stated as exactly four is not met by three plus a setting.
   *
   * The option is now always offered and the ROW carries the consequence. This case is the pin for both
   * halves: four options with the tiers, four without.
   */
  it('EXACTLY FOUR day-type options, with the company’s tier figures and without them', () => {
    for (const tiers of [TIERS, null]) {
      const { unmount } = mount('en', { tiers });
      const options = [...dayTypeSelect('en').options].map((o) => o.value);
      expect(options, tiers ? 'extended hours ON' : 'extended hours OFF').toEqual(['', 'rest_day', 'off_day', 'holiday', 'workday']);
      unmount();
    }
  });

  it('an Ordinary Day row on a company WITHOUT extended hours says it earns nothing, and blocks the submit', async () => {
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY, tiers: null });
    await user.type(dateInput('en'), '2026-09-16');
    await user.selectOptions(dayTypeSelect('en'), 'workday');
    const said = await waitFor(() => screen.getByTestId('leave-credit-ordinary-earns-nothing'));
    // A translated key, not a new English string: r336 left this one without a renderer when it moved to
    // sections, and it says precisely what is true of a company that cannot credit an ordinary day.
    expect(said.textContent).toBe(en.replacementRequest.workingDayRefused);
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
    // And the two claimed-window cells are dead rather than merely empty — there is nothing to claim.
    expect(startInput('en').disabled).toBe(true);
    expect(endInput('en').disabled).toBe(true);
  });
});

describe('r343 · the roster adjudicates, on the row, and blocks the submit', () => {
  it.each(LOCALES)('%s — "Rest Day" on a date the roster calls an OFF day names the off day', async (locale) => {
    const user = userEvent.setup();
    mount(locale, { facts: OFF_DAY });
    const c = copy(locale);
    await user.type(dateInput(locale), '2026-09-12');
    await user.selectOptions(dayTypeSelect(locale), 'rest_day');
    const problem = await waitFor(() => screen.getByTestId('leave-credit-roster-mismatch'));
    // The roster's OWN answer, in this locale, is what the row names — never a bare "does not match".
    expect(problem.textContent).toContain(c.dayKind.offDay);
    expect(looksUnresolved(problem.textContent ?? '')).toBe(false);
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a row that AGREES with the roster shows no mismatch and unblocks the submit', async () => {
    const user = userEvent.setup();
    mount('en', { facts: OFF_DAY });
    await user.type(dateInput('en'), '2026-09-12');
    await user.selectOptions(dayTypeSelect('en'), 'off_day');
    await waitFor(() => expect(screen.queryByTestId('leave-credit-roster-mismatch')).toBeNull());
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an Ordinary Day row under the half-day threshold SAYS SO rather than silently showing nothing', async () => {
    const user = userEvent.setup();
    mount('en', { facts: { ...WORKING_DAY, measuredExtendedMinutes: 120 } });
    await user.type(dateInput('en'), '2026-09-16');
    await user.selectOptions(dayTypeSelect('en'), 'workday');
    await user.type(startInput('en'), '18:00');
    await user.type(endInput('en'), '20:00');
    const msg = await waitFor(() => screen.getByTestId('leave-credit-below-threshold'));
    expect(msg.textContent).toBe(en.replacementRequest.sectionB.belowThreshold.replace('{minutes}', '240'));
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ONE total, across a non-working-day row and an ordinary-day row in the same table', async () => {
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <LeaveCreditRequestTable
          replacementType={{ id: 'lt-1', name: 'Replacement Leave' }}
          submitAction={() => {}}
          today="2026-09-24"
          dayFactsAction={vitestVi.fn(async (d: string) => (d === '2026-09-16' ? WORKING_DAY : REST_DAY))}
          extendedHoursTiers={TIERS}
        />
      </NextIntlClientProvider>,
    );
    await user.type(dateInput('en'), '2026-09-13');
    await user.selectOptions(dayTypeSelect('en'), 'rest_day');
    await user.click(screen.getByRole('button', { name: en.replacementRequest.addRow }));
    const dates = screen.getAllByLabelText(en.replacementRequest.workedDate);
    await user.type(dates[1], '2026-09-16');
    await user.selectOptions(screen.getAllByLabelText(en.replacementRequest.sectionA.dayType)[1], 'workday');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedStart)[1], '18:00');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedEnd)[1], '02:00');
    // 1 day for the rest day + 1 day for eight hours past the shift end (the cap, not a proportion).
    await waitFor(() => expect(screen.getByTestId('leave-credit-total').textContent).toBe('2.00 day(s)'));
  });
});
