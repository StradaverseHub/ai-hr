/**
 * 3fb1a611 (r299) · THE LEAVE CREDIT DIALOGS, RENDERED — what HR and the employee actually read before they
 * press the button. A curl of the page cannot see these (Radix portals render on open, client-side), so they
 * are opened here, in every locale, and checked for resolved copy and for the warnings the plan promises:
 *   · + Add Leave Credit tells HR the day kind, refuses an ordinary working day, says overtime on the date
 *     will not also be paid, pre-fills the expiry from the rule, and asks for the First Schedule agreement;
 *   · Reverse asks for a reason and says overtime becomes payable again;
 *   · the employee's Leave Credit request names the kind of each date worked and states the rule (r360: as a
 *     read-only cell with its provenance again, after r343 made it a chosen value the roster corrected).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LeaveCreditAddDialog, type LeaveCreditPreviewView } from '../components/leave/leave-credit-add-dialog';
import { LeaveCreditReverseDialog } from '../components/leave/leave-credit-reverse-dialog';
import { ReplacementLeaveRequestDialog } from '../components/leave/replacement-leave-request-dialog';

const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
const unresolved = (text: string) => /MISSING_MESSAGE|admin\.leaveCredit\.|replacementRequest\.|\badd\.[a-z]+[A-Z]?/.test(text);
const lc = (loc: Locale) => (CATALOGUES[loc] as unknown as { admin: { leaveCredit: Record<string, unknown> } }).admin.leaveCredit;
const lcAdd = (loc: Locale) => lc(loc).add as Record<string, string>;

const PREVIEW: LeaveCreditPreviewView = {
  workedDayKind: 'rest_day',
  eligibleDay: true,
  overtimeMinutes: 480,
  defaultExpiresOn: '2026-12-16',
  policyEnabled: true,
  firstSchedule: true,
  allowFirstSchedule: true,
  alreadyCredited: false,
  // r334 · the extended-hours question does not arise on a rest day, which is what this base fixture is.
  // Left in its OFF shape on purpose so every assertion below still describes the pre-r334 dialog exactly.
  extendedHoursEnabled: false,
  extendedHoursMinutes: null,
  extendedHoursDays: null,
};

function renderAdd(locale: Locale, preview: LeaveCreditPreviewView) {
  const previewAction = vi.fn(async () => preview);
  const utils = render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <LeaveCreditAddDialog
        employees={[{ id: 'emp-1', label: 'EMP-0001 — Aisyah Rahman' }]}
        today="2026-09-17"
        submitAction={vi.fn()}
        previewAction={previewAction}
      />
    </NextIntlClientProvider>,
  );
  return { ...utils, previewAction };
}

async function openAndPick(dateInput = '2026-08-06') {
  fireEvent.click(screen.getByTestId('leave-credit-add'));
  // Pick the employee through the combobox's own list.
  const trigger = await waitFor(() => {
    const el = screen.getByRole('dialog').querySelector('button[aria-haspopup="listbox"]');
    if (!el) throw new Error('combobox trigger not rendered');
    return el as HTMLButtonElement;
  });
  fireEvent.click(trigger);
  // The combobox commits on mousedown (so it beats its own outside-click close), not on click.
  fireEvent.mouseDown(await screen.findByRole('option', { name: 'EMP-0001 — Aisyah Rahman' }));
  const date = document.querySelector('input[name="workedDate"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(date, { target: { value: dateInput } });
  });
}

describe('+ Add Leave Credit', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] shows the day kind, the overtime warning, the First Schedule agreement and the rule's expiry`, async () => {
      const { previewAction } = renderAdd(locale, PREVIEW);
      await openAndPick();
      await waitFor(() => expect(screen.getByTestId('leave-credit-preview')).toBeTruthy());
      expect(previewAction).toHaveBeenCalledWith({ employmentId: 'emp-1', workedDate: '2026-08-06' });
      const dialog = screen.getByRole('dialog');
      const text = dialog.textContent ?? '';
      expect(unresolved(text), `${locale}: ${text.slice(0, 200)}`).toBe(false);
      const copy = lc(locale);
      expect(text).toContain((copy.dayKind as Record<string, string>).restDay);
      // ⚠️ MONEY: the overtime warning, with the hours.
      expect(text).toContain(String((copy.add as Record<string, string>).overtime).replace('{hours}', '8'));
      expect(text).toContain((copy.add as Record<string, string>).firstScheduleConsentLabel);
      expect((dialog.querySelector('input[name="firstScheduleConsent"]') as HTMLInputElement).required).toBe(true);
      expect((dialog.querySelector('input[name="expiresOn"]') as HTMLInputElement).value).toBe('2026-12-16');
      expect((dialog.querySelector('input[name="expiresOn"]') as HTMLInputElement).min).toBe('2026-08-06');
    });
  }

  // ── r334 928f0454 · EXTENDED HOURS ON A WORKING DAY, in every locale ────────────────────────────────
  //
  // THIS IS THE §8 RENDER CHECK FOR THE DIALOG, and it is here rather than on a curled page for a reason
  // that is a property of the component and not a convenience: the dialog body is a Radix `Dialog.Portal`
  // that mounts only on open, so it is not in the server HTML at all — fetching the Leave Credit page and
  // grepping it would prove nothing about these strings. Rendering it per locale and reading the dialog's
  // own textContent is the equivalent check, and `unresolved()` above is what catches a MISSING_MESSAGE or
  // an unformatted ICU placeholder.
  const EXTENDED_EARNED = {
    ...PREVIEW,
    workedDayKind: 'workday' as const,
    eligibleDay: true,
    overtimeMinutes: 240,
    extendedHoursEnabled: true,
    extendedHoursMinutes: 240,
    extendedHoursDays: 0.5,
  };

  for (const locale of LOCALES) {
    it(`[${locale}] r334: names the extended hours, the tier, and PINS the credit amount`, async () => {
      renderAdd(locale, EXTENDED_EARNED);
      await openAndPick();
      await waitFor(() => expect(screen.getByTestId('leave-credit-preview')).toBeTruthy());
      const dialog = screen.getByRole('dialog');
      const text = dialog.textContent ?? '';
      expect(unresolved(text), `${locale}: ${text.slice(0, 200)}`).toBe(false);
      // The ICU message really formatted — an unsubstituted `{minutes}` would survive `unresolved`.
      expect(text).not.toMatch(/\{minutes\}|\{days\}/);
      expect(text).toContain('240');
      // The credit is the measured tier and HR cannot retype it; `readOnly`, never `disabled`, or the
      // field would post nothing and the save would fail its own required-amount check.
      const days = dialog.querySelector('input[name="days"]') as HTMLInputElement;
      expect(days.value).toBe('0.5');
      expect(days.readOnly).toBe(true);
      expect(days.disabled).toBe(false);
      expect((screen.getByRole('button', { name: lcAdd(locale).submit }) as HTMLButtonElement).disabled).toBe(false);
    });
  }

  for (const locale of LOCALES) {
    it(`[${locale}] r334: a working day that fell short says how far, and the save stays disabled`, async () => {
      renderAdd(locale, {
        ...PREVIEW,
        workedDayKind: 'workday',
        eligibleDay: false,
        overtimeMinutes: 180,
        firstSchedule: false,
        extendedHoursEnabled: true,
        extendedHoursMinutes: 180,
        extendedHoursDays: null,
      });
      await openAndPick();
      const dialog = await waitFor(() => screen.getByRole('dialog'));
      await waitFor(() => expect(screen.getByTestId('leave-credit-preview')).toBeTruthy());
      const text = dialog.textContent ?? '';
      expect(unresolved(text), `${locale}: ${text.slice(0, 200)}`).toBe(false);
      expect(text).not.toMatch(/\{minutes\}|\{days\}/);
      expect(text).toContain('180');
      // The "wrong kind of day" sentence must NOT be the one shown: the day is the right kind, it simply
      // did not run long enough, and telling HR to pick a rest day would be wrong advice.
      const lcx = CATALOGUES[locale] as unknown as { admin: { leaveCredit: { add: Record<string, string> } } };
      expect(text).not.toContain(lcx.admin.leaveCredit.add.workingDay);
      expect((screen.getByRole('button', { name: lcAdd(locale).submit }) as HTMLButtonElement).disabled).toBe(true);
    });
  }

  it('r334: with the company switch OFF, an ordinary working day still shows the pre-r334 sentence', async () => {
    renderAdd('en', {
      ...PREVIEW,
      workedDayKind: 'workday',
      eligibleDay: false,
      overtimeMinutes: 0,
      firstSchedule: false,
      extendedHoursEnabled: false,
      extendedHoursMinutes: null,
      extendedHoursDays: null,
    });
    await openAndPick('2026-08-03');
    await waitFor(() => expect(screen.getByText(en.admin.leaveCredit.add.workingDay)).toBeTruthy());
    // And the credit field is HR's again, as it has always been on this form.
    const days = document.querySelector('input[name="days"]') as HTMLInputElement;
    expect(days.readOnly).toBe(false);
  });

  it('refuses an ordinary working day before save — the submit is disabled and the reason is shown', async () => {
    renderAdd('en', { ...PREVIEW, workedDayKind: 'workday', eligibleDay: false, overtimeMinutes: 0, firstSchedule: false });
    await openAndPick('2026-08-03');
    await waitFor(() => expect(screen.getByText(en.admin.leaveCredit.add.workingDay)).toBeTruthy());
    const submit = screen.getByRole('button', { name: en.admin.leaveCredit.add.submit }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // No overtime ⇒ no overtime sentence (the warning is not boilerplate).
    expect(screen.queryByText(/overtime recorded/)).toBeNull();
  });

  it('a First-Schedule employee whose company does not allow it is blocked, not asked', async () => {
    renderAdd('en', { ...PREVIEW, allowFirstSchedule: false });
    await openAndPick();
    await waitFor(() => expect(screen.getByText(en.admin.leaveCredit.add.firstScheduleBlocked)).toBeTruthy());
    expect(document.querySelector('input[name="firstScheduleConsent"]')).toBeNull();
    expect((screen.getByRole('button', { name: en.admin.leaveCredit.add.submit }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Reverse', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] asks for a reason and says the overtime becomes payable again`, () => {
      render(
        <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
          <LeaveCreditReverseDialog accrualId="acc-1" action={vi.fn()} />
        </NextIntlClientProvider>,
      );
      fireEvent.click(screen.getByTestId('leave-credit-reverse'));
      const dialog = screen.getByRole('dialog');
      const text = dialog.textContent ?? '';
      expect(unresolved(text), `${locale}: ${text}`).toBe(false);
      expect(text).toContain((lc(locale).reverse as Record<string, string>).body);
      expect((dialog.querySelector('input[name="reason"]') as HTMLInputElement).required).toBe(true);
      expect((dialog.querySelector('input[name="accrualId"]') as HTMLInputElement).value).toBe('acc-1');
    });
  }
});

describe('The employee’s Leave Credit request', () => {
  /*
   * ⚠️⚠️ UPDATED TWICE — AND r360 PUTS THE CLAIM BACK ALMOST EXACTLY WHERE r299 WROTE IT.
   *
   * r299 pinned that the request NAMES THE KIND OF EACH DATE WORKED, flags a working day and states the
   *      rule — the day kind a READ-ONLY CHIP resolved from the roster (`leave-credit-day-kind`), with a
   *      refusal pointing at the other section.
   * r343 the reporter contested the input side: the employee CHOSE the day type from four options and the
   *      roster ADJUDICATED the choice, so this case asserted the kind through the CORRECTION
   *      (`leave-credit-roster-mismatch`) to a deliberately wrong choice — strictly more than the chip did,
   *      because it also caught rest day vs off day vs public holiday, three kinds the chip and the sections
   *      could not tell apart (all three were one claim path).
   * r360 the reporter asks for read-only again. So the kind is a read-only cell once more
   *      (`leave-credit-day-type`) — with a caption saying whether it came from the roster or from the public
   *      holiday calendar, which the r299 chip never said — and the wrong choice this case used to make can no
   *      longer be made. It is NOT the same design by a round trip: the adjudication r343 added stayed, and it
   *      is what settles the question (`submitLeaveCreditRequest` refuses any posted day type that disagrees
   *      with the roster, so the dropdown offered a choice the server would always refuse).
   *
   * CLAUDE.md §8 — a guard pinning a decision you are reversing is updated, not deleted. Both halves of
   * r299's claim are asserted below, in all six locales: the rule sentence (`description`) and the roster's own
   * answer named on the row, for TWO dates the roster answers differently. The refusal of a disagreeing row is
   * still pinned, against the tampered post that no screen can prevent, in
   * test/r343-leave-credit-single-table.test.ts.
   */
  for (const locale of LOCALES) {
    it(`[${locale}] states the rule, and names what the ROSTER holds for each date worked`, async () => {
      const dayFactsAction = vi.fn(async (d: string) => ({
        kind: (d === '2026-08-03' ? 'workday' : 'off_day') as 'workday' | 'off_day',
        shiftEnd: d === '2026-08-03' ? '18:00:00' : null,
        actualClockOut: '19:00:00',
        measuredExtendedMinutes: 0,
      }));
      render(
        <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
          {/* 2a237f5f — ONE resolved type, not a list: the leave-type box is fixed. */}
          <ReplacementLeaveRequestDialog
            replacementType={{ id: 'rl', name: 'Replacement Leave' }}
            submitAction={vi.fn()}
            today="2026-09-17"
            dayFactsAction={dayFactsAction}
            // r358 — `extendedHoursTiers={null}` used to mean BOTH "no tier ladder" and "an ordinary
            // day earns nothing here". Those are two facts now: the ladder applies to every day type,
            // and the switch governs the ordinary one alone.
            tiers={{ extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 }}
            ordinaryDayAllowed={false}
          />
        </NextIntlClientProvider>,
      );
      const rr = (CATALOGUES[locale] as unknown as { replacementRequest: Record<string, unknown> }).replacementRequest;
      fireEvent.click(screen.getByText(rr.trigger as string));
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).toContain(rr.title as string);
      /*
       * The RULE. r299 pinned `eligibleDaysNote` ("Only a rest day, off day or public holiday can earn a
       * credit"); cbfa8b0b made that false by omission (extended hours on an ordinary working day earn a
       * credit too) and moved the sentence to `description`, which says both halves and keeps r299's
       * "nothing is credited until your manager approves" clause verbatim. Still the dialog's own sentence
       * after r343 — the shell renders it above the table.
       */
      expect(dialog.textContent).toContain(rr.description as string);

      const dayKindCopy = rr.dayKind as Record<string, string>;
      const sectionACopy = rr.sectionA as Record<string, string>;
      const date = screen.getAllByLabelText(rr.workedDate as string)[0] as HTMLInputElement;
      const tableCopy = rr.table as Record<string, string>;
      /** The cell's label span. Read EXACTLY: `Ngày nghỉ` is a prefix of `Ngày nghỉ hằng tuần` in vi. */
      const dayTypeLabel = () =>
        (screen.getAllByTestId('leave-credit-day-type')[0].querySelector('span')?.textContent ?? '').trim();

      // ⚠️ r360 — the day type used to be driven here:
      //     const dayType = screen.getAllByLabelText(sectionACopy.dayType)[0] as HTMLSelectElement;
      //     fireEvent.change(dayType, { target: { value: 'rest_day' } });
      // There is no such control. The COLUMN keeps its heading, and that is all the label addresses now.
      expect(dialog.textContent, 'the Day Type column is still named').toContain(sectionACopy.dayType);
      expect(screen.queryAllByLabelText(sectionACopy.dayType), 'and addresses no control').toHaveLength(0);

      // (a) A date the roster calls an OFF day — the kind the r299 chip could not tell from a rest day.
      await act(async () => {
        fireEvent.change(date, { target: { value: '2026-08-08' } });
      });
      await waitFor(() => expect(dayTypeLabel()).toBe(dayKindCopy.offDay));
      expect(dayTypeLabel(), 'an off day is not a rest day, and r299 could not say so').not.toBe(dayKindCopy.restDay);
      expect(screen.getAllByTestId('leave-credit-day-type-source')[0].textContent).toBe(tableCopy.dayTypeFromRoster);
      expect(screen.queryByTestId('leave-credit-roster-mismatch'), 'nothing for the roster to correct').toBeNull();

      // (b) …and re-dating the row to an ORDINARY WORKING day names that instead. This is where r299's "flags
      // a working day" lives now: the date is not refused — extended hours can earn a credit on it — and with
      // no description for the employee to give, what the row does is REPORT the kind for the date it holds.
      await act(async () => {
        fireEvent.change(date, { target: { value: '2026-08-03' } });
      });
      await waitFor(() => expect(dayTypeLabel()).toBe(dayKindCopy.workday));
      expect(screen.queryByTestId('leave-credit-roster-mismatch'), 'the re-date re-asked; it did not keep (a)').toBeNull();
      // Still not submittable — but for the honest reason: `ordinaryDayAllowed={false}` on this fixture, so an
      // ordinary working day earns nothing here. Not because the row is in an unfixable disagreement.
      expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('leave-credit-ordinary-earns-nothing'), 'and the row says why').toBeTruthy();
      expect(unresolved(dialog.textContent ?? '')).toBe(false);
    });
  }
});
