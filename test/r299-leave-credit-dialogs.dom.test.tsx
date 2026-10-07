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

import { LeaveCreditGrantDialog, type LeaveCreditGrantContextView } from '../components/leave/leave-credit-grant-dialog';
import { LeaveCreditReverseDialog } from '../components/leave/leave-credit-reverse-dialog';
import { ReplacementLeaveRequestDialog } from '../components/leave/replacement-leave-request-dialog';

const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
const unresolved = (text: string) => /MISSING_MESSAGE|admin\.leaveCredit\.|replacementRequest\.|\badd\.[a-z]+[A-Z]?/.test(text);
const lc = (loc: Locale) => (CATALOGUES[loc] as unknown as { admin: { leaveCredit: Record<string, unknown> } }).admin.leaveCredit;
const lcAdd = (loc: Locale) => lc(loc).add as Record<string, string>;

/**
 * ⚠️ r406 952129bb — THE ADD DIALOG THESE CASES DROVE IS GONE, AND WHAT IT PINNED IS RE-PINNED ON ITS
 * REPLACEMENT. components/leave/leave-credit-add-dialog.tsx (one date, typed days, typed expiry) was
 * replaced by components/leave/leave-credit-grant-dialog.tsx: the employee's Leave Credit table in HR mode
 * plus an Employee picker. The r299/r334 claims, and where each went:
 *   · "shows the day kind" — the row's Day Type cell, from the roster, exactly as on the employee's form;
 *   · ⚠️ "the overtime warning, with the hours" — now PER ROW (`leave-credit-row-overtime`), same key;
 *   · "the First Schedule agreement, required" — the table's consent checkbox, with HR's own label;
 *   · "pre-fills the rule's expiry" — RETIRED with the field: the expiry always follows the company rule now
 *     (the approved plan's GOOD TO KNOW), so there is nothing on the form to pre-fill;
 *   · r334 "PINS the credit amount to the tier" — there is no amount field any more: the credit is DERIVED
 *     from the window on every row, by the same function as the employee's request
 *     (test/r406-hr-leave-credit-rows.test.ts pins the parity against the database);
 *   · "a First-Schedule employee whose company does not allow it is blocked, not asked" — kept, below.
 */
const TIERS = { extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 };
const CONTEXT: LeaveCreditGrantContextView = {
  tiers: TIERS,
  ordinaryDayAllowed: true,
  policyEnabled: true,
  firstSchedule: true,
  allowFirstSchedule: true,
  ownRecord: false,
};
const restDayFacts = (overtimeMinutes: number) => async () => ({
  kind: 'rest_day' as const,
  shiftStart: null,
  shiftEnd: null,
  actualClockIn: '08:00:00',
  actualClockOut: '17:00:00',
  measuredExtendedMinutes: 0,
  approvedOtPlan: null,
  overtimeMinutes,
  alreadyCredited: false,
});

function renderGrant(locale: Locale, context: LeaveCreditGrantContextView, overtimeMinutes = 480) {
  const contextAction = vi.fn(async () => context);
  const dayFactsAction = vi.fn(restDayFacts(overtimeMinutes));
  const utils = render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <LeaveCreditGrantDialog
        employees={[{ id: 'emp-1', label: 'EMP-0001 — Aisyah Rahman' }]}
        today="2026-09-17"
        replacementType={{ id: 'rl', name: 'Replacement Leave' }}
        submitAction={vi.fn()}
        contextAction={contextAction}
        dayFactsAction={dayFactsAction}
      />
    </NextIntlClientProvider>,
  );
  return { ...utils, contextAction, dayFactsAction };
}

async function openAndPick(dateInput = '2026-08-09') {
  fireEvent.click(screen.getByTestId('leave-credit-add'));
  const trigger = await waitFor(() => {
    const el = screen.getByRole('dialog').querySelector('button[aria-haspopup="listbox"]');
    if (!el) throw new Error('combobox trigger not rendered');
    return el as HTMLButtonElement;
  });
  fireEvent.click(trigger);
  // The combobox commits on mousedown (so it beats its own outside-click close), not on click.
  fireEvent.mouseDown(await screen.findByRole('option', { name: 'EMP-0001 — Aisyah Rahman' }));
  // The rows open once the employee's context has arrived (the table remounts for the picked employee).
  const date = await waitFor(() => {
    const el = screen.getAllByLabelText(en.replacementRequest.workedDate)[0] as HTMLInputElement;
    if (el.disabled) throw new Error('rows still closed');
    return el;
  });
  await act(async () => {
    fireEvent.change(date, { target: { value: dateInput } });
  });
}

describe('+ Add Leave Credit — the employee’s form, plus an Employee picker', () => {
  it('before an employee is picked the rows are closed and the button says why', () => {
    renderGrant('en', CONTEXT);
    fireEvent.click(screen.getByTestId('leave-credit-add'));
    const dialog = screen.getByRole('dialog');
    expect(screen.getByTestId('leave-credit-employee-picker')).toBeTruthy();
    expect((screen.getAllByLabelText(en.replacementRequest.workedDate)[0] as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('leave-credit-add-row') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.textContent).toContain(en.admin.leaveCredit.add.pickEmployeeFirst);
    // HR's labels, not the employee's: "Add credit", never "Send to manager".
    expect(screen.getByTestId('leave-credit-submit').textContent).toBe(en.admin.leaveCredit.add.submit);
    expect(dialog.textContent).not.toContain(en.replacementRequest.submit);
    expect(dialog.textContent).toContain(en.admin.leaveCredit.add.descriptionRows);
    expect(screen.getByTestId('leave-credit-helper').textContent).toBe(en.admin.leaveCredit.add.help);
  });

  for (const locale of LOCALES) {
    it(`[${locale}] after the pick: the day kind from the roster, the per-row overtime warning, HR's consent label`, async () => {
      const { contextAction, dayFactsAction } = renderGrant(locale, CONTEXT);
      await openAndPick();
      expect(contextAction).toHaveBeenCalledWith('emp-1');
      await waitFor(() => expect(dayFactsAction).toHaveBeenCalledWith('2026-08-09', 'emp-1'));
      const dialog = screen.getByRole('dialog');
      const copy = CATALOGUES[locale] as unknown as { replacementRequest: { dayKind: Record<string, string> } };
      await waitFor(() =>
        expect((screen.getAllByTestId('leave-credit-day-type')[0].querySelector('span')?.textContent ?? '').trim()).toBe(
          copy.replacementRequest.dayKind.restDay,
        ),
      );
      // ⚠️ MONEY: the overtime warning, with the hours, on the row.
      expect(screen.getByTestId('leave-credit-row-overtime').textContent).toBe(lcAdd(locale).overtime.replace('{hours}', '8'));
      expect(dialog.textContent).toContain(lcAdd(locale).firstScheduleConsentLabel);
      expect((dialog.querySelector('input[name="firstScheduleConsent"]') as HTMLInputElement).required).toBe(true);
      // The picked employee is POSTED, once.
      const posted = dialog.querySelectorAll('input[name="employmentId"]');
      expect(posted).toHaveLength(1);
      expect((posted[0] as HTMLInputElement).value).toBe('emp-1');
      // The removed fields are really gone.
      for (const gone of ['days', 'expiresOn', 'remarks']) expect(dialog.querySelector(`[name="${gone}"]`), gone).toBeNull();
      expect(unresolved(dialog.textContent ?? ''), `${locale}: ${(dialog.textContent ?? '').slice(0, 200)}`).toBe(false);
    });
  }

  it('no overtime on the date ⇒ no overtime sentence (the warning is not boilerplate)', async () => {
    renderGrant('en', CONTEXT, 0);
    await openAndPick();
    await waitFor(() => expect(screen.getAllByTestId('leave-credit-day-type-source')).toHaveLength(1));
    expect(screen.queryByTestId('leave-credit-row-overtime')).toBeNull();
  });

  it('a First-Schedule employee whose company does not allow it is blocked, not asked', async () => {
    renderGrant('en', { ...CONTEXT, allowFirstSchedule: false });
    await openAndPick();
    await waitFor(() => expect(screen.getByTestId('leave-credit-grant-refusal').textContent).toBe(en.admin.leaveCredit.add.firstScheduleBlocked));
    expect(document.querySelector('input[name="firstScheduleConsent"]')).toBeNull();
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('HR’s own record is refused on the form, before the save refuses it', async () => {
    renderGrant('en', { ...CONTEXT, firstSchedule: false, ownRecord: true });
    await openAndPick();
    await waitFor(() => expect(screen.getByTestId('leave-credit-grant-refusal').textContent).toBe(en.admin.leaveCredit.add.ownRecord));
    expect((screen.getByTestId('leave-credit-submit') as HTMLButtonElement).disabled).toBe(true);
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
      // r365 cbfa8b0b — `shiftStart`, `actualClockIn` and `approvedOtPlan` joined LeaveCreditDayFacts for
      // the Attendance panel behind the row's View button. None of the three is an input to any figure.
      const dayFactsAction = vi.fn(async (d: string) => ({
        kind: (d === '2026-08-03' ? 'workday' : 'off_day') as 'workday' | 'off_day',
        shiftStart: d === '2026-08-03' ? '09:00:00' : null,
        shiftEnd: d === '2026-08-03' ? '18:00:00' : null,
        actualClockIn: '08:00:00',
        actualClockOut: '19:00:00',
        measuredExtendedMinutes: 0,
        approvedOtPlan: null,
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
      // r406 — THE SAME TABLE, NOT IN HR MODE: no picker, nothing posted as `employmentId` (the action reads
      // the session's own), the employee's own submit label and the facts action asked with the date alone.
      expect(screen.queryByTestId('leave-credit-employee-picker')).toBeNull();
      expect(dialog.querySelector('input[name="employmentId"]')).toBeNull();
      expect(screen.getByTestId('leave-credit-submit').textContent).toBe(rr.submit as string);
      expect(screen.queryByTestId('leave-credit-row-overtime')).toBeNull();
      for (const call of dayFactsAction.mock.calls) expect(call).toHaveLength(1);
    });
  }
});
