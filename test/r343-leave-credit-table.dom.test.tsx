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
 *   · ⚠️ r360 — "EXACTLY FOUR day-type options, on a company with extended hours and on one without" WAS THE
 *     SECOND LINE OF THIS LIST. There are no options: the Day Type cell is a READ-ONLY FACT with a caption
 *     saying where it came from. What survives of the claim is that all FOUR kinds the roster can answer are
 *     rendered, in this locale's own words, with the tier figures and without them — the requirement was
 *     never "a control", it was "all four kinds reach the screen";
 *   · the per-row conditional as DISABLED CELLS: an Ordinary Day row takes the claimed window and not the
 *     Days figure, the other three the reverse, on the same row of the same table;
 *   · the roster MISMATCH message naming what the roster holds, and that it BLOCKS the submit button;
 *   · an Ordinary Day row on a company without extended hours SAYS it earns nothing and blocks the submit;
 *   · the derived cells are not inputs — the employee cannot type an eligible-minutes figure or a credit;
 *   · ⚠️ r353 — the Day Type FILLS ITSELF from the roster, the clock-out cell tells "No record" apart from
 *     "this cell does not apply", and a claim past the recorded clock-out shows an amber warning and STILL
 *     CREDITS (the owner's reversal: the check moved to the approver, so the screen's job is to say so rather
 *     than to refuse).
 *
 * ── ⚠️⚠️ r360 cbfa8b0b · THE DAY TYPE STOPPED BEING A CONTROL, AND ABOUT 34 CASES IN THIS SUITE DROVE IT ──
 * Every case below that read `user.selectOptions(dayTypeSelect('en'), 'workday')` now sets the DATE and waits
 * for the cell to fill from the mocked roster instead; where a case needed a different kind, the MOCK's `kind`
 * changed, never the screen. The round trip is recorded in test/r336-leave-credit-modal.dom.test.tsx: r336
 * read-only → r343 an input of four → r360 read-only again, settled not by r336's argument but by the roster
 * check r343 itself added (`leaveCreditRosterKinds` resolves EVERY date, so `adjudicateDayTypes` never skips a
 * row and `submitLeaveCreditRequest` throws on ANY disagreement — the dropdown offered a choice the server
 * would always refuse unless it happened to match).
 *
 * ⚠️ AND ONE CLASS OF CASE WENT STRUCTURALLY UNREACHABLE RATHER THAN WRONG. A row whose day type DISAGREES
 * with the roster cannot be built from this screen any more, because the cell is filled from the roster and
 * cleared when the date moves. Those cases are NOT deleted: each is replaced by the assertion that the
 * mismatch is no longer PRODUCIBLE here, with its old claim quoted — and the server-side refusal they were
 * really about stays pinned, at the layer that can still be handed a tampered post, in
 * test/r343-leave-credit-single-table.test.ts ("a row typed 'Rest Day' on a date the roster calls an OFF day
 * is REFUSED", plus its vacuity control).
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
/** r360 — the fourth kind, which needed no fixture while the employee could pick it from a list. Its caption
 *  is the one that must NOT say "from your roster": a public holiday outranks the roster in `scheduleFor`. */
const HOLIDAY: LeaveCreditDayFacts = { kind: 'holiday', shiftEnd: null, actualClockOut: '17:00:00', measuredExtendedMinutes: 0 };
/** r353 · an ordinary working day with NO attendance row: the clock-out is the absence the screens name. */
const NO_ATTENDANCE: LeaveCreditDayFacts = { kind: 'workday', shiftEnd: '18:00:00', actualClockOut: null, measuredExtendedMinutes: 0 };
/** r353 · clocked out at 20:00 — a claim to 22:00 runs PAST it and must credit anyway, with a warning. */
const CLOCKED_OUT_EARLY: LeaveCreditDayFacts = { kind: 'workday', shiftEnd: '18:00:00', actualClockOut: '20:00:00', measuredExtendedMinutes: 0 };

function mount(
  locale: Locale,
  opts: {
    facts?: LeaveCreditDayFacts | null;
    tiers?: typeof TIERS | null;
    /** r360 — the whole action, for the cases that need it to REJECT (the reported defect) or answer per date. */
    action?: (workedDate: string) => Promise<LeaveCreditDayFacts | null>;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <LeaveCreditRequestTable
        replacementType={{ id: 'lt-1', name: 'Replacement Leave' }}
        submitAction={() => {}}
        today="2026-09-24"
        dayFactsAction={vitestVi.fn(opts.action ?? (async () => (opts.facts === undefined ? REST_DAY : opts.facts)))}
        // r358 — opts.tiers === null used to mean "extended hours off"; it is the SWITCH now, and
        // the ladder is always present because every day type uses it.
        tiers={TIERS}
        ordinaryDayAllowed={opts.tiers !== null}
      />
    </NextIntlClientProvider>,
  );
}

/**
 * ⚠️ r360 — `dayTypeSelect` STOOD HERE: `screen.getAllByLabelText(copy(locale).sectionA.dayType)[0] as
 * HTMLSelectElement`. There is no labelled control to find, so the cell is READ instead of driven. The label
 * is compared EXACTLY rather than with `toContain`, because `Ngày nghỉ` is a prefix of `Ngày nghỉ hằng tuần`
 * and `วันหยุด` of `วันหยุดประจำสัปดาห์` — a substring match would call an off day a rest day in vi and th.
 */
const DAY_KIND_KEY = { rest_day: 'restDay', off_day: 'offDay', holiday: 'holiday', workday: 'workday' } as const;
type Kind = keyof typeof DAY_KIND_KEY;
const KINDS = Object.keys(DAY_KIND_KEY) as Kind[];
const dayKindLabel = (locale: Locale, kind: Kind) => copy(locale).dayKind[DAY_KIND_KEY[kind]] as string;
const dayTypeCell = (n = 0) => screen.getAllByTestId('leave-credit-day-type')[n] as HTMLElement;
/** The cell's first span: the label, or the placeholder / failure sentence while no kind is known. */
const dayTypeText = (n = 0) => dayTypeCell(n).querySelector('span')?.textContent?.trim() ?? '';
const dayTypeSource = (n = 0) => screen.getAllByTestId('leave-credit-day-type-source')[n] as HTMLElement;
/** The replacement for `user.selectOptions(dayTypeSelect(locale), kind)`: the ROSTER fills it, so we WAIT. */
const awaitDayType = (locale: Locale, kind: Kind, n = 0) =>
  waitFor(() => expect(dayTypeText(n)).toBe(dayKindLabel(locale, kind)));
const dateInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).workedDate)[0] as HTMLInputElement;
const startInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).sectionB.extendedStart)[0] as HTMLInputElement;
const endInput = (locale: Locale) => screen.getAllByLabelText(copy(locale).sectionB.extendedEnd)[0] as HTMLInputElement;

describe('r343 · the single table renders in all six locales, with no unresolved key', () => {
  /**
   * ⚠️ REVERSED IN r360. The old claim was the OPTION LIST, in this locale's own words:
   *
   *     const options = [...dayTypeSelect(locale).options].map((o) => o.textContent?.trim());
   *     expect(options).toEqual([c.table.dayTypeChoose, c.dayKind.restDay, c.dayKind.offDay,
   *                              c.dayKind.holiday, c.dayKind.workday]);
   *
   * That read all four labels out of ONE render, which is why it was worth having: a `MISSING_MESSAGE` in any
   * `dayKind.*` key on any locale failed it. A read-only cell shows one kind at a time, so the same coverage
   * now costs four renders per locale — and it is still the coverage, not a weaker version of it. The
   * placeholder is asserted in the same case, where it belongs: the cell before a date is picked.
   */
  it.each(LOCALES)('%s — one table, all four day types read back in that locale, and no MISSING_MESSAGE', async (locale) => {
    const c = copy(locale);
    const first = mount(locale);

    // ONE table. Two would be the two sections coming back under another name.
    expect(first.container.querySelectorAll('table')).toHaveLength(1);
    // Nothing is known before a date is picked, and there is nothing to pick a day type WITH.
    expect(dayTypeText()).toBe(c.table.dayTypeChoose);
    expect(dayTypeCell().querySelector('select'), 'no select in the cell').toBeNull();
    expect(screen.queryAllByTestId('leave-credit-day-type-source'), 'and no provenance for an unknown kind').toHaveLength(0);
    expect(looksUnresolved(first.container.textContent ?? '')).toBe(false);
    expect(screen.getByTestId('leave-credit-helper').textContent).toBe(c.table.help);
    first.unmount();

    // …and each of the four kinds the roster can answer is rendered, in THIS locale's own words.
    for (const kind of KINDS) {
      const user = userEvent.setup();
      const { container, unmount } = mount(locale, { facts: { ...REST_DAY, kind } });
      await user.type(dateInput(locale), '2026-09-16');
      await awaitDayType(locale, kind);
      expect(looksUnresolved(container.textContent ?? ''), `${locale}/${kind}`).toBe(false);
      unmount();
    }
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
  /**
   * What the screen SAYS, read off the DOM with no catalogue involved.
   *
   * ⚠️ r360 — the four day types used to come out of ONE render as `select.options`, and the placeholder as
   * `select.options[0]`. Both are read from the CELL now, which makes this async and costs four renders per
   * locale. r360's two provenance captions joined the set on their way past: they are new translated strings
   * on this surface, so "not the English words" is a claim worth making about them too.
   */
  const spoken = async (locale: Locale) => {
    const dayTypes: string[] = [];
    for (const kind of KINDS) {
      const user = userEvent.setup();
      const { unmount } = mount(locale, { facts: { ...REST_DAY, kind } });
      await user.type(dateInput(locale), '2026-09-16');
      await waitFor(() => expect(dayTypeText()).not.toBe(copy(locale).table.dayTypeChoose));
      dayTypes.push(dayTypeText());
      unmount();
    }
    // The captions, from two renders that differ ONLY in the roster's answer.
    const user = userEvent.setup();
    const roster = mount(locale, { facts: REST_DAY });
    await user.type(dateInput(locale), '2026-09-13');
    await awaitDayType(locale, 'rest_day');
    const fromRoster = dayTypeSource().textContent?.trim() ?? '';
    roster.unmount();
    const holiday = mount(locale, { facts: HOLIDAY });
    await userEvent.setup().type(dateInput(locale), '2026-09-13');
    await awaitDayType(locale, 'holiday');
    const fromHolidays = dayTypeSource().textContent?.trim() ?? '';
    holiday.unmount();

    const shell = mount(locale);
    const out = {
      dayTypes,
      fromRoster,
      fromHolidays,
      submit: screen.getByTestId('leave-credit-submit').textContent?.trim() ?? '',
      totalLabel: screen.getByTestId('leave-credit-total-label').textContent?.trim() ?? '',
      /** Knowingly English on all six screens: the empty cell's own line and the "+ Add date" button. */
      placeholder: dayTypeText(),
      addRow: screen.getByTestId('leave-credit-add-row').textContent?.trim() ?? '',
    };
    shell.unmount();
    return out;
  };

  it.each(LOCALES.filter((l) => l !== 'en'))('%s — the day types, the captions, the submit and the total are NOT the English words', async (locale) => {
    const english = await spoken('en');
    const other = await spoken(locale);
    expect(other.dayTypes).toHaveLength(4);
    other.dayTypes.forEach((word, i) => {
      expect(word, `${locale}: day type ${i} still reads the English "${english.dayTypes[i]}"`).not.toBe(english.dayTypes[i]);
      expect(word.length, `${locale}: day type ${i} is empty`).toBeGreaterThan(0);
    });
    // r360's two captions, compared between renders rather than against the catalogue they were rendered from.
    expect(other.fromRoster, `${locale}: the roster caption still reads English`).not.toBe(english.fromRoster);
    expect(other.fromHolidays, `${locale}: the holiday caption still reads English`).not.toBe(english.fromHolidays);
    expect(other.fromRoster.length, `${locale}: the roster caption is empty`).toBeGreaterThan(0);
    expect(other.fromHolidays.length, `${locale}: the holiday caption is empty`).toBeGreaterThan(0);
    expect(other.submit, `${locale}: the submit button still reads English`).not.toBe(english.submit);
    expect(other.totalLabel, `${locale}: the total label still reads English`).not.toBe(english.totalLabel);
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s — and the two strings this screen ships in English are the same words', async (locale) => {
    // NOT an accident and not hidden: `table.dayTypeChoose` and `addRow` are English in all six catalogues,
    // with the whole English set named in test/r343-leave-credit-single-table.test.ts. Asserting the sameness
    // is what keeps this case honest — it fails if the debt is paid off without the list being updated.
    const english = await spoken('en');
    const other = await spoken(locale);
    expect(other.placeholder).toBe(english.placeholder);
    expect(other.addRow).toBe(english.addRow);
  });
});

describe('r343 · the per-row conditional, as disabled cells on ONE row', () => {
  it('an Ordinary Day row takes the claimed window, and there is no Days figure anywhere', async () => {
    // r358 — the last line read `expect(daysSelect('en').disabled).toBe(true)`. The picker is gone for
    // every type now, so the assertion is its absence rather than its disabled state.
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY });
    await user.type(dateInput('en'), '2026-09-16');
    // r360 — was `await user.selectOptions(dayTypeSelect('en'), 'workday')`. WORKING_DAY's `kind` is what
    // makes this an ordinary-day row now; there is nothing to select.
    await awaitDayType('en', 'workday');
    expect(startInput('en').disabled).toBe(false);
    expect(endInput('en').disabled).toBe(false);
    expect(screen.queryAllByTestId('leave-credit-days')).toHaveLength(0);
  });

  /**
   * ⚠️ REVERSED IN r358 BY THE OWNER. This case read "a Rest Day row takes the Days figure and NOT the
   * claimed window — same row, same table", and asserted `daysSelect.disabled === false` with both time
   * inputs disabled. The owner's answer on 70294f7a is the opposite:
   *
   *     "The Extended Start and Extended End fields must be editable by the employee when submitting a
   *      Leave Credit request. Do not make these fields display-only … The employee should enter the
   *      actual time period being claimed."
   *
   * The Days select is gone entirely, so there is nothing left to assert about it — which is why the
   * case below also pins its ABSENCE rather than only the times being live.
   */
  it('a Rest Day row takes the claimed WINDOW, like every other day type', async () => {
    const user = userEvent.setup();
    mount('en', { facts: REST_DAY });
    await user.type(dateInput('en'), '2026-09-13');
    await awaitDayType('en', 'rest_day'); // r360 — was selectOptions(…, 'rest_day'); REST_DAY's kind is the row.
    expect(startInput('en').disabled, 'the employee types the start').toBe(false);
    expect(endInput('en').disabled, 'and the end').toBe(false);
    expect(screen.queryAllByTestId('leave-credit-days'), 'the 1-or-0.5 picker is gone').toHaveLength(0);
  });

  /**
   * ⚠️ THIS IS THE CASE THE PARK WAS ABOUT, AND NOTHING PINNED IT UNTIL NOW (r358).
   *
   * `extended_hours_enabled` is FALSE on every company — r334 shipped the switch defaulting off and
   * nobody has turned it on. Before this round the table read that as "no tier ladder exists" and
   * blocked every row that claimed a window, so building the owner's rule on the old shape would have
   * made Leave Credit unsubmittable for all of them. Item 70294f7a was parked rather than shipped for
   * exactly this reason.
   *
   * So: switch OFF, rest-day row, and the claim must still work end to end. A render check cannot reach
   * this — the fields are disabled until a day type is chosen, which is one interaction away — which is
   * why it is pinned here rather than left to the dev server.
   */
  it('THE PRODUCTION CASE: with extended hours OFF, a rest-day claim is still live and submittable', async () => {
    const user = userEvent.setup();
    mount('en', { facts: REST_DAY, tiers: null }); // tiers: null ⇒ ordinaryDayAllowed false
    await user.type(dateInput('en'), '2026-09-13');
    await awaitDayType('en', 'rest_day'); // r360 — was selectOptions(…, 'rest_day').
    expect(startInput('en').disabled, 'the switch does not reach a rest day').toBe(false);
    expect(endInput('en').disabled).toBe(false);
    await user.type(startInput('en'), '09:00');
    await user.type(endInput('en'), '17:00');
    await waitFor(() => expect(screen.getAllByTestId('leave-credit-row-credit')[0].textContent).toMatch(/1/));
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('…and an ORDINARY day on that same company still says it earns nothing, and blocks', async () => {
    // The other half, so the case above cannot pass by the switch having stopped doing anything at all.
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY, tiers: null });
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', 'workday'); // r360 — was selectOptions(…, 'workday').
    expect(startInput('en').disabled, 'an ordinary day IS gated by the switch').toBe(true);
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a rest day counts the WHOLE window — there is no scheduled shift end to be after', async () => {
    // The reporter's own worked example, on the day type the item is about: 18:00 to 22:00 is four hours,
    // and four hours is the half-day tier. On an ordinary day the same window would be floored at the
    // scheduled shift end; on a rest day the employee was never scheduled, so there is nothing to floor.
    const user = userEvent.setup();
    mount('en', { facts: REST_DAY });
    await user.type(dateInput('en'), '2026-09-13');
    // r360 — the wait is LOAD-BEARING and not decoration: the two time cells are disabled until a day type is
    // known, and `user.type` into a disabled input silently does nothing, so a missing wait here would read as
    // "the rest day earned no credit" rather than as a broken test.
    await awaitDayType('en', 'rest_day');
    await user.type(startInput('en'), '18:00');
    await user.type(endInput('en'), '22:00');
    expect(screen.getAllByTestId('leave-credit-eligible-minutes')[0].textContent).toContain('240');
    expect(screen.getAllByTestId('leave-credit-row-credit')[0].textContent).toMatch(/0\.5/);
  });

  it('the derived cells are not inputs: the employee cannot type an eligible-minutes figure or a credit', () => {
    mount('en', { facts: WORKING_DAY });
    // r360 — `leave-credit-day-type` JOINED THIS LIST. It was a `<select>` when the list was written, so it
    // was the one cell in the row that had to be excluded; it is now the same kind of thing as the other four.
    for (const id of [
      'leave-credit-day-type',
      'leave-credit-eligible-minutes',
      'leave-credit-row-credit',
      'leave-credit-shift-end',
      'leave-credit-clock-out',
    ]) {
      const cell = screen.getAllByTestId(id)[0];
      expect(within(cell).queryByRole('textbox'), id).toBeNull();
      expect(cell.querySelector('input'), id).toBeNull();
    }
  });

  /**
   * ⚠️⚠️ REVERSED TWICE, AND BOTH OLD CLAIMS ARE KEPT BECAUSE THE SUBJECT IS THE SAME EACH TIME.
   *
   *   r343 (first cut) "without the company's tier figures the Ordinary Day option is not offered at all",
   *        asserting a THREE-option dropdown. That was the defect, not the guard:
   *        `toil_policy.extended_hours_enabled` is `NOT NULL DEFAULT false` (migration 0486), so every
   *        company at release would have shown the reporter three of the four options they asked for.
   *   r343 (fix pass) "EXACTLY FOUR day-type options, with the company's tier figures and without them":
   *        `expect([...dayTypeSelect('en').options].map((o) => o.value)).toEqual(
   *           ['', 'rest_day', 'off_day', 'holiday', 'workday'])`, once per tier setting.
   *   r360 there is no option list. The cell is a read-only fact.
   *
   * WHAT THE REQUIREMENT ACTUALLY WAS is untouched by that: all four kinds the roster can answer must REACH
   * the screen, on a company with the tier figures and on one without — an Ordinary Day is a fact about the
   * date, never a feature flag. So the same eight combinations are still asserted, as a rendered cell rather
   * than as an option, and the four `<option>` elements are asserted GONE in the same breath.
   */
  it('all four day types reach the cell, with the company’s tier figures and without them — and none is a control', async () => {
    for (const tiers of [TIERS, null]) {
      for (const kind of KINDS) {
        const user = userEvent.setup();
        const { unmount } = mount('en', { tiers, facts: { ...REST_DAY, kind } });
        await user.type(dateInput('en'), '2026-09-16');
        await awaitDayType('en', kind);
        const where = `${kind} / extended hours ${tiers ? 'ON' : 'OFF'}`;
        expect(dayTypeCell().querySelector('select'), where).toBeNull();
        expect(dayTypeCell().querySelector('input'), where).toBeNull();
        expect(dayTypeCell().querySelectorAll('option'), where).toHaveLength(0);
        // …and the provenance is always drawn, because a fact with no source is the half the reporter asked for.
        expect(dayTypeSource().textContent?.trim().length, where).toBeGreaterThan(0);
        unmount();
      }
    }
  });

  it('an Ordinary Day row on a company WITHOUT extended hours says it earns nothing, and blocks the submit', async () => {
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY, tiers: null });
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', 'workday'); // r360 — was selectOptions(…, 'workday').
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

describe('r343 · the roster adjudicates — and after r360 the screen cannot be made to disagree with it', () => {
  /**
   * ⚠️⚠️ STRUCTURALLY UNREACHABLE AFTER r360, AND REPLACED RATHER THAN DELETED.
   *
   * THE OLD CLAIM, per locale: `"Rest Day" on a date the roster calls an OFF day names the off day` —
   * `selectOptions(dayTypeSelect(locale), 'rest_day')` on OFF_DAY facts, then
   * `expect(problem.textContent).toContain(c.dayKind.offDay)` on `leave-credit-roster-mismatch`, with the
   * submit disabled. It cannot be driven any more: the cell is FILLED from the roster and CLEARED when the
   * date moves, so the row's day type is the roster's answer or nothing at all.
   *
   * ⚠️ THE SERVER-SIDE REFUSAL IS STILL PINNED, and it is the half that was ever a control: a tampered post
   * does not come from this screen. test/r343-leave-credit-single-table.test.ts holds it — "⚠️ a row typed
   * 'Rest Day' on a date the roster calls an OFF day is REFUSED, naming the off day" against
   * `submitLeaveCreditRequest`, next to the vacuity control that watches the layer BELOW accept the same row.
   *
   * WHAT THE LOCALE DIMENSION WAS FOR SURVIVES HERE. The old case's own comment was "the roster's OWN answer,
   * in this locale, is what the row names — never a bare 'does not match'", and that is still exactly the
   * claim: the roster's own answer, in this locale, is what the DAY TYPE CELL names. It moved from the
   * correction to the fact, which is the whole of what r360 did.
   */
  it.each(LOCALES)('%s — the roster’s OWN answer, in this locale, is what the cell names, and no row disagrees', async (locale) => {
    const user = userEvent.setup();
    mount(locale, { facts: OFF_DAY });
    await user.type(dateInput(locale), '2026-09-12');
    await awaitDayType(locale, 'off_day');
    expect(looksUnresolved(dayTypeCell().textContent ?? '')).toBe(false);
    expect(screen.queryByTestId('leave-credit-roster-mismatch'), 'a filled cell agrees by construction').toBeNull();
  });

  /**
   * ⚠️ THE ONE WAY A DISAGREEMENT COULD STILL BE BUILT FROM THE SCREEN, AND IT WAS REAL.
   *
   * With the control gone, r353's fill condition (`dayType === '' && !touchedDayType`) meant the cell filled
   * ONCE per row. Re-dating a filled row therefore kept the OLD kind: measured on the built component, a row
   * dated 2026-09-13 (rest day) and re-dated to 2026-09-16 (working day) still read "Rest day" under the
   * caption "From your roster", raised the mismatch, and disabled the submit — with no control left to correct
   * it. The follow-up commit clears the day type in the same update as the date. This is the guard for it, and
   * it is what makes "the mismatch is not producible from the screen" a measured claim rather than a reading.
   */
  it('⚠️ RE-DATING a filled row re-asks the roster — it does not keep the first date’s answer', async () => {
    const user = userEvent.setup();
    mount('en', { action: async (d) => (d === '2026-09-16' ? WORKING_DAY : REST_DAY) });
    await user.type(dateInput('en'), '2026-09-13');
    await awaitDayType('en', 'rest_day');
    await user.clear(dateInput('en'));
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', 'workday');
    // The caption is a claim about THIS date, so it may not survive a date change unexamined either.
    expect(dayTypeSource().textContent).toBe(en.replacementRequest.table.dayTypeFromRoster);
    expect(screen.queryByTestId('leave-credit-roster-mismatch'), 'no mismatch survives the re-date').toBeNull();
    // …and the POSTED value followed too, which is the half the service adjudicates.
    expect((document.querySelector('input[name="dayType"]') as HTMLInputElement).value).toBe('workday');
  });

  it('a row that AGREES with the roster shows no mismatch and unblocks the submit', async () => {
    // r358 — the window is what earns the credit on an off day too, so the row has to carry one before
    // the submit can open. Before this round the day type alone was enough, because the 1-or-0.5 picker
    // defaulted to a whole day; that default was the thing the owner replaced.
    const user = userEvent.setup();
    mount('en', { facts: OFF_DAY });
    await user.type(dateInput('en'), '2026-09-12');
    await awaitDayType('en', 'off_day'); // r360 — was selectOptions(…, 'off_day').
    await user.type(startInput('en'), '09:00');
    await user.type(endInput('en'), '17:00');
    await waitFor(() => expect(screen.queryByTestId('leave-credit-roster-mismatch')).toBeNull());
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an Ordinary Day row under the half-day threshold SAYS SO rather than silently showing nothing', async () => {
    const user = userEvent.setup();
    mount('en', { facts: { ...WORKING_DAY, measuredExtendedMinutes: 120 } });
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', 'workday'); // r360 — was selectOptions(…, 'workday').
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
          tiers={TIERS}
          ordinaryDayAllowed
        />
      </NextIntlClientProvider>,
    );
    await user.type(dateInput('en'), '2026-09-13');
    await awaitDayType('en', 'rest_day'); // r360 — was selectOptions(…, 'rest_day').
    // r358 — eight hours on the rest day, which is the full-day tier. It used to inherit 1.00 from the
    // Days picker's default; the credit is derived from the window now, on this day type as on the other
    // three, so the window has to be typed.
    await user.type(startInput('en'), '09:00');
    await user.type(endInput('en'), '17:00');
    await user.click(screen.getByRole('button', { name: en.replacementRequest.addRow }));
    const dates = screen.getAllByLabelText(en.replacementRequest.workedDate);
    await user.type(dates[1], '2026-09-16');
    // r360 — was `selectOptions(getAllByLabelText(sectionA.dayType)[1], 'workday')`. The SECOND row's cell
    // fills from its own date, which is what makes this two day types in one table rather than two of one.
    await awaitDayType('en', 'workday', 1);
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedStart)[1], '18:00');
    await user.type(screen.getAllByLabelText(en.replacementRequest.sectionB.extendedEnd)[1], '02:00');
    // 1 day for eight hours on the rest day + 1 day for eight hours past the shift end on the working
    // day. One ladder, two day types — which is the whole of what r358 changed.
    await waitFor(() => expect(screen.getByTestId('leave-credit-total').textContent).toBe('2.00 day(s)'));
  });
});

/**
 * ⚠️ r353 cbfa8b0b · WHAT THE REVERSAL LOOKS LIKE ON THE EMPLOYEE'S OWN SCREEN.
 *
 * The kernel used to clip a claim to the recorded clock-out and cap it at the measured figure; the owner
 * reversed both, so the two read-only time cells stopped being decoration and became the approver's evidence.
 * Every case here is a RENDER: an amber block and a filled dropdown are exactly the class of thing tsc, the
 * node suite and `next build` all pass over.
 */
describe('r353 · the claimed window is the claim, and the clock-out is drawn as a warning', () => {
  it('a claim that ends AFTER the recorded clock-out warns, names both times, and still credits', async () => {
    const user = userEvent.setup();
    mount('en', { facts: CLOCKED_OUT_EARLY });
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', 'workday'); // r360 — was selectOptions(…, 'workday').
    await user.type(startInput('en'), '18:00');
    await user.type(endInput('en'), '22:00');

    // 240 minutes: the clock-out no longer cuts it to 120.
    await waitFor(() => expect(screen.getByTestId('leave-credit-eligible-minutes')).toHaveTextContent('240'));
    expect(screen.getByTestId('leave-credit-row-credit')).toHaveTextContent('0.5');
    const warn = screen.getByTestId('leave-credit-clock-out-warning');
    // BOTH figures, so the employee can see which two the manager will be comparing.
    expect(warn.textContent).toContain('22:00');
    expect(warn.textContent).toContain('20:00');
    // ⚠️ IT IS A WARNING, NOT A REFUSAL. The submit stays available — that is the loosening the owner chose.
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a claim INSIDE the recorded clock-out says nothing at all — the warning is not decoration', async () => {
    const user = userEvent.setup();
    mount('en', { facts: WORKING_DAY }); // clocked out 02:00, shift end 18:00
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', 'workday'); // r360 — was selectOptions(…, 'workday').
    await user.type(startInput('en'), '18:00');
    await user.type(endInput('en'), '22:00');
    await waitFor(() => expect(screen.getByTestId('leave-credit-eligible-minutes')).toHaveTextContent('240'));
    expect(screen.queryByTestId('leave-credit-clock-out-warning')).toBeNull();
  });

  it('NO attendance row reads "No record" rather than the em dash, warns differently, and still credits', async () => {
    const user = userEvent.setup();
    mount('en', { facts: NO_ATTENDANCE });
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', 'workday'); // r360 — was selectOptions(…, 'workday').
    // The absence is named BEFORE any window is typed: it is a fact about the day, not about the claim.
    await waitFor(() => expect(screen.getByTestId('leave-credit-clock-out')).toHaveTextContent(en.replacementRequest.table.noClockOutRecord));
    expect(screen.getByTestId('leave-credit-clock-out-warning').textContent).toBe(en.replacementRequest.table.clockOutMissing);

    await user.type(startInput('en'), '18:00');
    await user.type(endInput('en'), '23:51'); // the reporter's own window: 351 minutes
    await waitFor(() => expect(screen.getByTestId('leave-credit-eligible-minutes')).toHaveTextContent('351'));
    expect(screen.getByTestId('leave-credit-row-credit')).toHaveTextContent('0.5');
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the em dash still means "this cell does not apply": a Rest Day row prints no "No record"', async () => {
    const user = userEvent.setup();
    mount('en', { facts: REST_DAY }); // has a 17:00 clock-out, but the cell is not applicable
    await user.type(dateInput('en'), '2026-09-13');
    await awaitDayType('en', 'rest_day'); // r360 — was selectOptions(…, 'rest_day').
    await waitFor(() => expect(screen.getByTestId('leave-credit-clock-out').textContent).not.toContain('17:00'));
    expect(screen.getByTestId('leave-credit-clock-out').textContent).not.toContain(en.replacementRequest.table.noClockOutRecord);
    expect(screen.queryByTestId('leave-credit-clock-out-warning')).toBeNull();
  });

  it.each(LOCALES)('%s — the two new warning sentences resolve in this locale', async (locale) => {
    const user = userEvent.setup();
    mount(locale, { facts: NO_ATTENDANCE });
    await user.type(dateInput(locale), '2026-09-16');
    await awaitDayType(locale, 'workday'); // r360 — was selectOptions(…, 'workday').
    const warn = await waitFor(() => screen.getByTestId('leave-credit-clock-out-warning'));
    expect(warn.textContent).toBe(copy(locale).table.clockOutMissing);
    expect(looksUnresolved(warn.textContent ?? '')).toBe(false);
    expect(looksUnresolved(screen.getByTestId('leave-credit-clock-out').textContent ?? '')).toBe(false);
  });
});

/**
 * r353 cbfa8b0b · THE DAY TYPE FILLS ITSELF FROM THE ROSTER — AND AFTER r360 THE FILL IS THE ONLY WRITER.
 *
 * r353's second case was the one that mattered then: "the fill must not be able to undo a deliberate answer,
 * because a row whose chosen type disagrees with the roster is exactly the row the screen is about to warn
 * about, and a fill that 'corrected' it would delete the warning instead of showing it." There are no
 * deliberate answers any more, so that case and its sibling are replaced below rather than deleted, and what
 * this block pins instead is the fill itself, its PROVENANCE, and what happens when the lookup FAILS.
 */
describe('r353 · the Day Type fills in from the roster when the date is picked', () => {
  /**
   * ⚠️ r360 — THE FOURTH KIND AND THE CAPTION ARE NEW, AND THE CAPTION IS HALF THE ROUND.
   *
   * r353 covered three kinds (rest_day, off_day, workday) because the employee could always pick the fourth by
   * hand. `holiday` has to be here now, and it is the kind whose provenance DIFFERS: a public holiday outranks
   * the roster in `scheduleFor`, so "From the public holiday calendar" and "From your roster" are two facts and
   * the caption may not merge them. Asserted per kind, both directions, so a component that printed one string
   * for all four fails on the holiday row and a component that printed the holiday string everywhere fails on
   * the other three.
   */
  it.each([
    ['rest_day', REST_DAY],
    ['off_day', OFF_DAY],
    ['workday', WORKING_DAY],
    ['holiday', HOLIDAY],
  ] as const)('picking a date the roster calls %s fills the cell with it, captioned with WHERE it came from', async (kind, facts) => {
    const user = userEvent.setup();
    mount('en', { facts });
    // r360 — was `expect(dayTypeSelect('en').value).toBe('')`. Nothing is known before a date is picked.
    expect(dayTypeText(), 'nothing is filled before a date is picked').toBe(en.replacementRequest.table.dayTypeChoose);
    await user.type(dateInput('en'), '2026-09-16');
    await awaitDayType('en', kind);
    const caption = dayTypeSource().textContent?.trim();
    if (kind === 'holiday') {
      expect(caption, 'a public holiday does not come from the roster').toBe(en.replacementRequest.table.dayTypeFromHolidays);
      expect(caption).not.toBe(en.replacementRequest.table.dayTypeFromRoster);
    } else {
      expect(caption, `${kind} comes from the roster`).toBe(en.replacementRequest.table.dayTypeFromRoster);
      expect(caption).not.toBe(en.replacementRequest.table.dayTypeFromHolidays);
    }
    // A filled value agrees with the roster by construction, so the row is clean.
    expect(screen.queryByTestId('leave-credit-roster-mismatch')).toBeNull();
    // …and it is POSTED, which is what the service adjudicates whatever this cell renders.
    expect((document.querySelector('input[name="dayType"]') as HTMLInputElement).value).toBe(kind);
  });

  /**
   * ⚠️⚠️ STRUCTURALLY UNREACHABLE AFTER r360, AND REPLACED RATHER THAN DELETED.
   *
   * THE OLD CLAIM: `⚠️ it never overwrites a value the employee chose — the deliberate mismatch survives and
   * still warns`. It chose `rest_day` BEFORE typing a date on OFF_DAY facts, so the fill was racing a value
   * that already existed, then asserted `dayTypeSelect('en').value === 'rest_day'` ("the roster reached in and
   * overwrote the employee") with the mismatch naming the off day.
   *
   * There is no way to choose before the date, or after it: the cell has no control, so the fill is the ONLY
   * writer and there is no value of the employee's for it to overwrite. That is asserted here directly — the
   * cases above already prove the fill lands, so what is left to prove is that nothing else can.
   *
   * ⚠️ THE SERVER-SIDE REFUSAL FOR A DELIBERATE MISMATCH IS STILL PINNED, in
   * test/r343-leave-credit-single-table.test.ts: `submitLeaveCreditRequest` is handed the mismatching row
   * DIRECTLY — the tampered-post path, which no screen change can close — and throws
   * `LeaveCreditDayTypeMismatchError`, with a vacuity control watching the layer below accept the same row.
   */
  it('⚠️ the fill is the ONLY writer: there is no control, so no chosen value can exist to overwrite', async () => {
    const user = userEvent.setup();
    mount('en', { facts: OFF_DAY }); // the roster says off day
    // Everything in the row that the employee CAN reach, named. A day-type control in any shape fails this.
    const row = screen.getByTestId('leave-credit-row');
    expect(row.querySelectorAll('select'), 'no select anywhere in the row').toHaveLength(0);
    expect([...row.querySelectorAll('input')].filter((i) => i.type !== 'hidden').map((i) => i.getAttribute('aria-label'))).toEqual([
      en.replacementRequest.workedDate,
      en.replacementRequest.sectionB.extendedStart,
      en.replacementRequest.sectionB.extendedEnd,
    ]);
    // The old case's own mechanism, attempted and refused by the absence of the control it needed.
    expect(screen.queryAllByLabelText(en.replacementRequest.sectionA.dayType), 'the Day Type label addresses no control').toHaveLength(0);
    await user.type(dateInput('en'), '2026-09-12');
    await awaitDayType('en', 'off_day');
    expect((document.querySelector('input[name="dayType"]') as HTMLInputElement).value).toBe('off_day');
  });

  /**
   * ⚠️⚠️ STRUCTURALLY UNREACHABLE AFTER r360, AND REPLACED RATHER THAN DELETED.
   *
   * THE OLD CLAIM: `and it does not come back after the employee clears the cell` — `selectOptions(…, '')` put
   * the blank placeholder back and the fill had to leave it blank, because "choosing the placeholder back is a
   * choice" and the fill must not treat an empty cell as "never answered".
   *
   * The employee cannot clear the cell; only the DATE can, and when the date goes the day type goes with it
   * (the follow-up commit's `changeWorkedDate`). That is the live half of the old claim and it is asserted
   * here: clearing the date empties the cell rather than leaving a kind attached to no date, which is the
   * shape that used to post a `dayType` with a blank `workedDate` beside it.
   */
  it('clearing the DATE clears the day type with it — no kind is left attached to no date', async () => {
    const user = userEvent.setup();
    mount('en', { facts: REST_DAY });
    await user.type(dateInput('en'), '2026-09-13');
    await awaitDayType('en', 'rest_day');
    await user.clear(dateInput('en'));
    await waitFor(() => expect(dayTypeText()).toBe(en.replacementRequest.table.dayTypeChoose));
    expect(screen.queryAllByTestId('leave-credit-day-type-source'), 'and no provenance for a kind that is gone').toHaveLength(0);
    expect((document.querySelector('input[name="dayType"]') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * ⚠️⚠️ r360 cbfa8b0b · THE REPORTED DEFECT: A FAILED LOOKUP USED TO SAY NOTHING AT ALL.
 *
 * `dayFactsAction` was called as `void dayFactsAction(d).then(...)` with NO `.catch()`. A rejected server
 * action left `facts[d]` at null for ever — `d in facts` is already true, so the date is never re-asked — and
 * the row simply never filled: a blank Day Type, a blank scheduled shift end and a blank clock-out, with
 * nothing on the screen to say why or to try again. That is the row in the reporter's screenshot, and it is
 * indistinguishable on screen from "still loading" and from "the system has no answer" — neither of which it
 * is, because `resolveWorkedDayKindTx` always returns one of the four kinds.
 *
 * So the guard is the whole round trip: REJECT once, the sentence and the retry appear, click the retry, the
 * day type fills. A guard that only checked the sentence would pass against a screen that says "could not look
 * this date up" and then cannot be recovered from without a reload.
 */
describe('r360 · a failed day-facts lookup is SAID, and the retry re-asks', () => {
  it('the failure is named, the retry is offered, and clicking it fills the day type', async () => {
    const user = userEvent.setup();
    let calls = 0;
    mount('en', {
      action: async () => {
        calls += 1;
        if (calls === 1) throw new Error('the server action rejected');
        return REST_DAY;
      },
    });
    await user.type(dateInput('en'), '2026-09-13');

    // (a) THE SENTENCE, in the cell itself rather than somewhere else on the form.
    await waitFor(() => expect(dayTypeText()).toBe(en.replacementRequest.table.dayTypeLookupFailed));
    // …and it is NOT the placeholder: "we have not asked yet" and "we asked and it failed" must differ.
    expect(dayTypeText()).not.toBe(en.replacementRequest.table.dayTypeChoose);
    // …and no provenance is claimed for a kind that was never learnt.
    expect(screen.queryAllByTestId('leave-credit-day-type-source')).toHaveLength(0);
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled, 'nothing is submittable').toBe(true);

    // (b) THE RETRY RE-ASKS. The click must reach the action again — a button that only clears state would
    // leave the cell blank for ever, which is the defect wearing a control.
    const retry = screen.getByTestId('leave-credit-day-type-retry');
    expect(retry.textContent).toBe(en.replacementRequest.table.dayTypeRetry);
    await user.click(retry);

    // (c) AND THE ANSWER LANDS.
    await awaitDayType('en', 'rest_day');
    expect(calls, 'the retry asked the server again rather than re-reading a cached failure').toBeGreaterThan(1);
    expect(dayTypeSource().textContent).toBe(en.replacementRequest.table.dayTypeFromRoster);
    expect(screen.queryByTestId('leave-credit-day-type-retry'), 'the retry goes when there is nothing to retry').toBeNull();
    expect((document.querySelector('input[name="dayType"]') as HTMLInputElement).value).toBe('rest_day');
  });

  it.each(LOCALES)('%s — the failure sentence and the retry resolve in this locale', async (locale) => {
    const user = userEvent.setup();
    mount(locale, { action: async () => { throw new Error('rejected'); } });
    await user.type(dateInput(locale), '2026-09-13');
    await waitFor(() => expect(dayTypeText()).toBe(copy(locale).table.dayTypeLookupFailed));
    expect(screen.getByTestId('leave-credit-day-type-retry').textContent).toBe(copy(locale).table.dayTypeRetry);
    expect(looksUnresolved(dayTypeCell().textContent ?? '')).toBe(false);
  });
});
