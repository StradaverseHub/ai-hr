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
 * from ms.json renders the English sentence rather than `MISSING_MESSAGE`. The assertions below check that
 * each locale's OWN day-type strings are the ones on screen — which is the one thing a deep merge cannot
 * fake, and the point of composing the dropdown from the existing `dayKind` keys instead of minting four new
 * English ones (r341's regression: English on a zh screen where Chinese had been).
 *
 * WHAT ELSE IS PINNED HERE, none of it statically assertable:
 *   · ONE table for all four day types — no second section, one "+ Add date", one total;
 *   · the per-row conditional as DISABLED CELLS: an Ordinary Day row takes the claimed window and not the
 *     Days figure, the other three the reverse, on the same row of the same table;
 *   · the roster MISMATCH message naming what the roster holds, and that it BLOCKS the submit button;
 *   · the Ordinary Day option is NOT OFFERED without the company's tier figures (r334's switch, UI half);
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

  it('without the company’s tier figures the Ordinary Day option is not offered at all', () => {
    mount('en', { tiers: null });
    const options = [...dayTypeSelect('en').options].map((o) => o.value);
    expect(options).toEqual(['', 'rest_day', 'off_day', 'holiday']);
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
