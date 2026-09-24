/**
 * 3fb1a611 (r299) · THE LEAVE CREDIT DIALOGS, RENDERED — what HR and the employee actually read before they
 * press the button. A curl of the page cannot see these (Radix portals render on open, client-side), so they
 * are opened here, in every locale, and checked for resolved copy and for the warnings the plan promises:
 *   · + Add Leave Credit tells HR the day kind, refuses an ordinary working day, says overtime on the date
 *     will not also be paid, pre-fills the expiry from the rule, and asks for the First Schedule agreement;
 *   · Reverse asks for a reason and says overtime becomes payable again;
 *   · the employee's Leave Credit request names the kind of each date worked and states the rule.
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
  for (const locale of LOCALES) {
    it(`[${locale}] names the kind of each date worked, flags a working day, and states the rule`, async () => {
      const dayKindAction = vi.fn(async (d: string) => (d === '2026-08-03' ? 'workday' : 'off_day') as 'workday' | 'off_day');
      render(
        <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
          {/* 2a237f5f — ONE resolved type, not a list: the leave-type box is fixed. */}
          <ReplacementLeaveRequestDialog replacementType={{ id: 'rl', name: 'Replacement Leave' }} submitAction={vi.fn()} today="2026-09-17" dayKindAction={dayKindAction} />
        </NextIntlClientProvider>,
      );
      const rr = (CATALOGUES[locale] as unknown as { replacementRequest: Record<string, unknown> }).replacementRequest;
      fireEvent.click(screen.getByText(rr.trigger as string));
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).toContain(rr.title as string);
      /*
       * cbfa8b0b (r336) — THIS ASSERTION FOLLOWED THE SENTENCE, IT WAS NOT DROPPED.
       *
       * r299 pinned `eligibleDaysNote` ("Only a rest day, off day or public holiday can earn a credit"),
       * which was true while the dialog held ONE kind of claim. The approved plan for cbfa8b0b put both
       * kinds in one request, so that sentence became false by omission — extended hours on an ordinary
       * WORKING day now earn a credit too — and the dialog renders `description` instead, which says both
       * halves and keeps r299's "nothing is credited until your manager approves" clause verbatim.
       *
       * `eligibleDaysNote` still exists in all six catalogues with no renderer (cbfa8b0b left it rather
       * than take a six-file deletion risk mid-round), so asserting it here would have gone on passing as
       * a string comparison against a dead key while the screen said something else. Pinning what the
       * dialog ACTUALLY shows is the point of this case.
       */
      expect(dialog.textContent).toContain(rr.description as string);
      /*
       * cbfa8b0b (r336) — `workedDate` became `aWorkedDate` (Section A's own field set).
       *
       * Not cosmetic: the dialog now holds TWO sections, and `app/leave/actions.ts` zips repeated form
       * fields BY INDEX. One shared `workedDate` list across both sections would silently shift every row
       * after the first as soon as both had rows, so the two sets are disjoint by construction. This case
       * is Section A's, which is the claim r299 was written about.
       */
      const date = dialog.querySelector('input[name="aWorkedDate"]') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(date, { target: { value: '2026-08-08' } });
      });
      await waitFor(() => expect(screen.getByTestId('leave-credit-day-kind').textContent).toBe((rr.dayKind as Record<string, string>).offDay));
      await act(async () => {
        fireEvent.change(date, { target: { value: '2026-08-03' } });
      });
      /*
       * cbfa8b0b (r336) — the refusal SEPARATED from the day-kind chip, and this case now pins both.
       *
       * r299 had one message doing two jobs: the chip printed "An ordinary working day cannot earn a
       * credit", which named the day AND refused it. With Section B added that sentence became false —
       * an ordinary working day CAN earn a credit now, for extended hours past the shift end — so the
       * chip states the day kind from the roster and the refusal says where the claim belongs instead,
       * in the reporter's own approved words.
       *
       * Asserting both is stronger than what it replaces: the old single assertion would have passed on
       * a chip that refused without naming the day, or named the day without refusing.
       */
      const dayKindCopy = rr.dayKind as Record<string, string>;
      const sectionACopy = rr.sectionA as Record<string, string>;
      await waitFor(() => expect(screen.getByTestId('leave-credit-day-kind').textContent).toBe(dayKindCopy.workday));
      expect(dialog.textContent, 'a working day in Section A must say where the claim belongs').toContain(
        sectionACopy.workingDayRefused,
      );
      expect(unresolved(dialog.textContent ?? '')).toBe(false);
    });
  }
});
