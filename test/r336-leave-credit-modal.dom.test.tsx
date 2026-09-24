/**
 * r336 · cbfa8b0b — THE RENDER CHECK for the Leave Credit request modal, in all six locales.
 *
 * WHY A DOM TEST AND NOT A PAGE FETCH. The modal is a `Dialog.Portal`: it MOUNTS ON OPEN, so it is not in
 * the server HTML at all and curling /leave proves nothing about it. r334 hit exactly this. A missing key
 * would paint `MISSING_MESSAGE` in the browser while the route still returned 200, passed tsc, passed the
 * suite and passed `next build` — only an opened render sees it.
 *
 * AND WHY SIX LOCALES EXPLICITLY. `i18n/request.ts` DEEP-MERGES each locale over English, so a key missing
 * from ms.json silently renders the English sentence rather than `MISSING_MESSAGE`. `test/i18n-coverage.ts`
 * catches an absent key, but not one present-and-untranslated — so the assertions below check that each
 * locale's own string is the one on screen, which is the only thing a deep merge cannot fake.
 *
 * WHAT ELSE IS PINNED HERE, none of it statically assertable:
 *   · both sections exist, each with its own "+ Add date" and its own section total;
 *   · Section B is NOT DRAWN AT ALL without the company's tier figures — the switch, in the UI half;
 *   · the derived fields are read-only: no input carries the eligible minutes or the credit;
 *   · the exact refusal sentences, and that they BLOCK the submit button;
 *   · the grand total is the two section totals added, with the arithmetic imported from
 *     lib/extended-hours.ts rather than restated here.
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

import {
  ReplacementLeaveRequestDialog,
  type ExtendedHoursDayView,
} from '../components/leave/replacement-leave-request-dialog';

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
const WORKING_DAY: ExtendedHoursDayView = {
  kind: 'workday',
  shiftEnd: '18:00:00',
  actualClockOut: '02:00:00',
  measuredExtendedMinutes: 480,
};
const REST_DAY_VIEW: ExtendedHoursDayView = {
  kind: 'rest_day',
  shiftEnd: null,
  actualClockOut: '17:00:00',
  measuredExtendedMinutes: 0,
};

function mount(
  locale: Locale,
  opts: {
    dayKind?: 'workday' | 'rest_day' | 'off_day' | 'holiday';
    extended?: ExtendedHoursDayView | null;
    offerSectionB?: boolean;
  } = {},
) {
  const offerB = opts.offerSectionB ?? true;
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <ReplacementLeaveRequestDialog
        replacementType={{ id: 'lt-1', name: 'Replacement Leave' }}
        submitAction={() => {}}
        today="2026-09-24"
        dayKindAction={vitestVi.fn(async () => opts.dayKind ?? 'rest_day')}
        extendedHoursAction={offerB ? vitestVi.fn(async () => opts.extended ?? WORKING_DAY) : undefined}
        extendedHoursTiers={offerB ? TIERS : undefined}
      />
    </NextIntlClientProvider>,
  );
}

const openModal = async (user: ReturnType<typeof userEvent.setup>, locale: Locale) => {
  await user.click(screen.getByRole('button', { name: copy(locale).trigger }));
  await screen.findByTestId('leave-credit-request-dialog');
};

describe('r336 · the modal opens with BOTH sections, in every locale, in that locale', () => {
  for (const locale of LOCALES) {
    it(`${locale}: helper text, both section titles and the grand total are this locale's own strings`, async () => {
      const user = userEvent.setup();
      mount(locale);
      await openModal(user, locale);
      const c = copy(locale);

      // The approved helper sentence, named in the plan, rendered rather than merely present in JSON.
      expect(screen.getByTestId('leave-credit-helper')).toHaveTextContent(c.description);
      // The deep merge over English is what this defeats: each assertion is the LOCALE's own string.
      expect(within(screen.getByTestId('leave-credit-section-a')).getByText(c.sectionA.title)).toBeTruthy();
      expect(within(screen.getByTestId('leave-credit-section-b')).getByText(c.sectionB.title)).toBeTruthy();
      expect(screen.getByText(c.grandTotal)).toBeTruthy();
      // Every read-only column header of Section B, in this locale.
      for (const k of ['shiftEnd', 'actualClockOut', 'extendedStart', 'extendedEnd', 'eligibleMinutes', 'credit'] as const) {
        expect(within(screen.getByTestId('leave-credit-section-b')).getAllByText(c.sectionB[k]).length).toBeGreaterThan(0);
      }
      expect(looksUnresolved(screen.getByTestId('leave-credit-request-dialog').textContent ?? '')).toBe(false);
    });
  }

  it('the six locales are genuinely six DIFFERENT helper sentences, not English six times', () => {
    const sentences = new Set(LOCALES.map((l) => copy(l).description));
    expect(sentences.size).toBe(LOCALES.length);
    const sectionB = new Set(LOCALES.map((l) => copy(l).sectionB.title));
    expect(sectionB.size).toBe(LOCALES.length);
  });
});

describe('r336 · the structure the approved plan asks for', () => {
  it('each section has its OWN "+ Add date" and its OWN total, plus one grand total', async () => {
    const user = userEvent.setup();
    mount('en');
    await openModal(user, 'en');
    // One add button per section — the plan's "each with its own + Add date".
    expect(within(screen.getByTestId('leave-credit-section-a')).getByRole('button', { name: en.replacementRequest.addRow })).toBeTruthy();
    expect(within(screen.getByTestId('leave-credit-section-b')).getByRole('button', { name: en.replacementRequest.addRow })).toBeTruthy();
    expect(screen.getByTestId('leave-credit-total-a')).toBeTruthy();
    expect(screen.getByTestId('leave-credit-total-b')).toBeTruthy();
    expect(screen.getByTestId('leave-credit-grand-total')).toBeTruthy();
  });

  it('the unit is a fixed read-only field, not a select — r333’s precedent', async () => {
    const user = userEvent.setup();
    mount('en');
    await openModal(user, 'en');
    const unit = screen.getByTestId('replacement-request-unit') as HTMLInputElement;
    expect(unit.tagName).toBe('INPUT');
    expect(unit.disabled).toBe(true);
    expect(unit.value).toBe(en.replacementRequest.unitDay);
    // And the form posts it as a constant, so there is no Hour request to make.
    const hidden = screen.getByTestId('leave-credit-request-dialog').querySelector('input[name="unit"]') as HTMLInputElement;
    expect(hidden.value).toBe('day');
  });

  it('Section B is not drawn at all when the company has not switched extended hours on', async () => {
    const user = userEvent.setup();
    mount('en', { offerSectionB: false });
    await openModal(user, 'en');
    expect(screen.getByTestId('leave-credit-section-a')).toBeTruthy();
    expect(screen.queryByTestId('leave-credit-section-b')).toBeNull();
  });
});

describe('r336 · Section B derives its figures and never offers them as inputs', () => {
  it('eligible minutes and credit follow the typed window, and both are read-only', async () => {
    const user = userEvent.setup();
    mount('en', { extended: WORKING_DAY });
    await openModal(user, 'en');
    const section = screen.getByTestId('leave-credit-section-b');
    const dateInput = section.querySelector('input[name="bWorkedDate"]') as HTMLInputElement;
    await user.type(dateInput, '2026-09-16');
    const start = section.querySelector('input[name="bStart"]') as HTMLInputElement;
    const end = section.querySelector('input[name="bEnd"]') as HTMLInputElement;
    await user.type(start, '18:00');
    await user.type(end, '22:00');

    // 18:00 → 22:00 is 240 minutes, inside the measured 480 ⇒ half a day.
    await waitFor(() => expect(screen.getByTestId('leave-credit-eligible-minutes')).toHaveTextContent('240'));
    expect(screen.getByTestId('leave-credit-row-credit')).toHaveTextContent('0.5');
    expect(screen.getByTestId('leave-credit-total-b')).toHaveTextContent('0.5');

    // DERIVED, never typed: neither figure is an input the browser would submit.
    expect(screen.getByTestId('leave-credit-eligible-minutes').tagName).not.toBe('INPUT');
    expect(screen.getByTestId('leave-credit-row-credit').tagName).not.toBe('INPUT');
    expect(section.querySelector('input[name="eligibleMinutes"]')).toBeNull();
    expect(section.querySelector('input[name="bDays"]')).toBeNull();

    // The two read-only facts are shown, trimmed to HH:MM.
    expect(screen.getByTestId('leave-credit-shift-end')).toHaveTextContent('18:00');
    expect(screen.getByTestId('leave-credit-clock-out')).toHaveTextContent('02:00');
  });

  it('under the half-day threshold prints the exact sentence and BLOCKS the submit', async () => {
    const user = userEvent.setup();
    mount('en', { extended: WORKING_DAY });
    await openModal(user, 'en');
    // ⚠️ NON-VACUITY. A VALID Section A row is filled FIRST, so the grand total is above zero and the
    // submit button would be enabled but for the offending Section B row. Without it this assertion passes
    // on an empty form — the button is disabled because nothing is claimed, not because of the refusal.
    await user.type(
      screen.getByTestId('leave-credit-section-a').querySelector('input[name="aWorkedDate"]') as HTMLInputElement,
      '2026-09-20',
    );
    await waitFor(() => expect(screen.getByTestId('leave-credit-grand-total')).toHaveTextContent('1'));
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(false);

    const section = screen.getByTestId('leave-credit-section-b');
    await user.type(section.querySelector('input[name="bWorkedDate"]') as HTMLInputElement, '2026-09-16');
    await user.type(section.querySelector('input[name="bStart"]') as HTMLInputElement, '18:00');
    await user.type(section.querySelector('input[name="bEnd"]') as HTMLInputElement, '21:00'); // 180 min

    await waitFor(() => expect(screen.getByTestId('leave-credit-below-threshold')).toBeTruthy());
    expect(screen.getByTestId('leave-credit-below-threshold')).toHaveTextContent('Under 240 minutes. Not eligible for credit.');
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a NON-working day typed into Section B prints the mirror sentence and blocks the submit', async () => {
    const user = userEvent.setup();
    mount('en', { extended: REST_DAY_VIEW });
    await openModal(user, 'en');
    // ⚠️ NON-VACUITY, as above: a valid Section A row first, so the button is enabled before the bad row.
    await user.type(
      screen.getByTestId('leave-credit-section-a').querySelector('input[name="aWorkedDate"]') as HTMLInputElement,
      '2026-09-19',
    );
    await waitFor(() => expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(false));
    const section = screen.getByTestId('leave-credit-section-b');
    await user.type(section.querySelector('input[name="bWorkedDate"]') as HTMLInputElement, '2026-09-20');
    await waitFor(() => expect(screen.getByTestId('leave-credit-section-b-refusal')).toBeTruthy());
    expect(screen.getByTestId('leave-credit-section-b-refusal')).toHaveTextContent(
      'This date is not a working day. Use Non-working-day work instead.',
    );
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('r336 · Section A refuses a working day, by name, and blocks the submit', () => {
  it('prints the exact sentence the approved plan specifies', async () => {
    const user = userEvent.setup();
    mount('en', { dayKind: 'workday' });
    await openModal(user, 'en');
    const section = screen.getByTestId('leave-credit-section-a');
    await user.type(section.querySelector('input[name="aWorkedDate"]') as HTMLInputElement, '2026-09-16');
    await waitFor(() => expect(screen.getByTestId('leave-credit-section-a-refusal')).toBeTruthy());
    // ⚠️ NON-VACUITY: the row carries a date and a days figure, so the grand total is 1 and the button
    // would be enabled but for the refusal — the assertion below is about the refusal, not about an
    // empty form.
    expect(screen.getByTestId('leave-credit-grand-total')).toHaveTextContent('1');
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('leave-credit-section-a-refusal')).toHaveTextContent(
      'This date is a working day. Use Extended ordinary-day work instead.',
    );
  });

  it('the day type is read-only, resolved from the roster — never an input', async () => {
    const user = userEvent.setup();
    mount('en', { dayKind: 'holiday' });
    await openModal(user, 'en');
    const section = screen.getByTestId('leave-credit-section-a');
    await user.type(section.querySelector('input[name="aWorkedDate"]') as HTMLInputElement, '2026-09-16');
    await waitFor(() => expect(screen.getByTestId('leave-credit-day-kind')).toHaveTextContent(en.replacementRequest.dayKind.holiday));
    expect(screen.getByTestId('leave-credit-day-kind').tagName).not.toBe('INPUT');
    expect(section.querySelector('select[name="aDayType"]')).toBeNull();
  });

  it('Section A offers exactly 1 day and 0.5 day, and nothing else', async () => {
    const user = userEvent.setup();
    mount('en');
    await openModal(user, 'en');
    const select = screen.getByTestId('leave-credit-section-a').querySelector('select[name="aDays"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['1', '0.5']);
  });
});

describe('r336 · the grand total is both sections added', () => {
  it('adds Section A’s declared days to Section B’s derived credit', async () => {
    const user = userEvent.setup();
    mount('en', { dayKind: 'rest_day', extended: WORKING_DAY });
    await openModal(user, 'en');
    await user.type(
      screen.getByTestId('leave-credit-section-a').querySelector('input[name="aWorkedDate"]') as HTMLInputElement,
      '2026-09-20',
    );
    const section = screen.getByTestId('leave-credit-section-b');
    await user.type(section.querySelector('input[name="bWorkedDate"]') as HTMLInputElement, '2026-09-16');
    await user.type(section.querySelector('input[name="bStart"]') as HTMLInputElement, '18:00');
    await user.type(section.querySelector('input[name="bEnd"]') as HTMLInputElement, '22:00');

    await waitFor(() => expect(screen.getByTestId('leave-credit-total-b')).toHaveTextContent('0.5'));
    expect(screen.getByTestId('leave-credit-total-a')).toHaveTextContent('1');
    // 1 + 0.5. Not an independent arithmetic: the same two numbers the employee can read above it.
    expect(screen.getByTestId('leave-credit-grand-total')).toHaveTextContent('1.5');
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(false);
  });
});
