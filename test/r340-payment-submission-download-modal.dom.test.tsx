/**
 * e78fd03d (r340) — THE DOWNLOAD SELECTION POP-UP.
 *
 * "Instead of displaying the selection fields directly on the main page and requiring the user to click
 * SHOW, the user should click the relevant Download button first." That is the item, and it is two claims
 * that need two different kinds of test:
 *
 *   A. THE FIELDS ARE GONE FROM THE PAGE — asserted as ABSENCE against a server render of the screen, in
 *      `test/r340-payment-submission-selection.test.ts`. It lives in the NODE project because importing
 *      the registry reaches `db/client` through the Borang A loader, and this project deliberately has no
 *      database URL at all (see test/dom-setup.ts).
 *   B. THE POP-UP ASKS, AND WHAT IT ASKS IS DECLARED BY THE FORMAT — this file. A real DOM render: the
 *      trigger opens it, it carries Company / Year / Payroll month, Cancel closes it leaving nothing
 *      behind, and a `'month-cycle'` format — and ONLY a `'month-cycle'` format — also gets a Pay cycle
 *      control. The kind is varied the way `test/payment-submission-screen-seam.test.ts` varies the
 *      registry: with a value the production registry does not use, so the control is proved to follow the
 *      declaration rather than a branch on a group or an id.
 *
 * ⚠️ WHY THIS IS A DOM TEST AND NOT PART OF THE §8 RENDER CHECK. The modal mounts on OPEN and its content
 * is inside a `Dialog.Portal`, so NONE of it is in the server HTML a curl can fetch — the r334/cbfa8b0b
 * lesson. Grepping the rendered page for the new strings would pass while the dialog was broken and fail
 * while it was perfect. They are asserted here instead, against the REAL catalogue for each of the six
 * locales, present AND distinct: `i18n/request.ts` deep-merges each locale over English, so a key missing
 * from ms.json renders the English sentence and never a MISSING_MESSAGE.
 *
 * NOTHING HERE TOUCHES THE DATABASE, and nothing is mocked: the dialog is handed flat props, exactly as
 * the server component hands them to it. The download itself is unchanged — still a GET at the same route —
 * and that it writes nothing stays asserted against a real payroll month in
 * `test/payment-submission-module.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { DownloadDialog } from '../app/payroll/payment-submission/download-dialog';
import type { SubmissionFormat } from '../app/payroll/payment-submission/registry';

const COMPANY = '11111111-2222-3333-4444-555555555555';
const DOWNLOAD_ROUTE = '/payroll/payment-submission/download';

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

const words = (m: (typeof LOCALES)[number][1]) =>
  (m as unknown as { payroll: { paymentSubmission: Record<string, string> } }).payroll.paymentSubmission;

/** The dialog as the page mounts it, with only the format's declaration varying. */
function mount(p: { periodKind: SubmissionFormat['periodKind']; locale?: string; messages?: unknown }) {
  const messages = p.messages ?? en;
  return render(
    <NextIntlClientProvider locale={p.locale ?? 'en'} messages={messages as Record<string, unknown>}>
      <DownloadDialog
        formatId="test.format"
        formatLabel="Test format"
        periodKind={p.periodKind}
        action={DOWNLOAD_ROUTE}
        companies={[{ value: COMPANY, label: 'Acme Sdn Bhd' }]}
        defaultCompanyId={COMPANY}
        years={['2026', '2025']}
        defaultYear="2026"
        months={[
          { value: '01', label: 'January' },
          { value: '08', label: 'August' },
        ]}
        defaultMonth="08"
      />
    </NextIntlClientProvider>,
  );
}

/** Open the pop-up. Before it opens the trigger is the only Download button on the page. */
function openDialog(label = words(en).download) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

// ── B. THE POP-UP ITSELF ─────────────────────────────────────────────────────────────────────────

describe('e78fd03d (B) — clicking Download opens the selection pop-up', () => {
  it('nothing is asked until the pop-up is opened', () => {
    mount({ periodKind: 'month' });
    expect(screen.queryByText(words(en).company)).toBeNull();
    expect(screen.queryByText(words(en).selectionIntro)).toBeNull();
  });

  it('asks for Company, Year and Payroll month — and says which file it is asking about', () => {
    mount({ periodKind: 'month' });
    openDialog();
    expect(screen.getByText('Test format')).toBeInTheDocument();
    expect(screen.getByText(words(en).selectionIntro)).toBeInTheDocument();
    for (const label of [words(en).company, words(en).year, words(en).month]) {
      expect(screen.getByText(label), `the pop-up must ask for ${label}`).toBeInTheDocument();
    }
  });

  it('Cancel closes it and leaves nothing behind', () => {
    mount({ periodKind: 'month' });
    openDialog();
    expect(screen.getByText(words(en).company)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: words(en).cancel }));
    expect(screen.queryByText(words(en).company)).toBeNull();
    expect(screen.queryByText(words(en).selectionIntro)).toBeNull();
    // The trigger is back to being the only Download on the page — the pop-up did not leave a copy.
    expect(screen.getAllByRole('button', { name: words(en).download })).toHaveLength(1);
  });

  it('its Download is a GET at the same route, carrying the format and ONE joined period', () => {
    mount({ periodKind: 'month' });
    openDialog();
    const form = document.querySelector('form');
    expect(form, 'the pop-up submits a form').not.toBeNull();
    // A GET. Turning the download into a POST is what would let it start recording something.
    expect(form!.getAttribute('method')).toBe('get');
    expect(form!.getAttribute('action')).toBe(DOWNLOAD_ROUTE);
    const hidden = (name: string) =>
      (form!.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value;
    expect(hidden('format')).toBe('test.format');
    // Year and month are joined into the one `periodKey` the route takes; the default month is August.
    expect(hidden('periodKey')).toBe('2026-08');
  });

  it('choosing a different month changes the period the download asks for', () => {
    mount({ periodKind: 'month' });
    openDialog();
    const form = document.querySelector('form')!;
    // Company, year, month — the pop-up's three selects, in the order it asks for them.
    const selects = form.querySelectorAll('select');
    expect(selects).toHaveLength(3);
    fireEvent.change(selects[1], { target: { value: '2025' } });
    fireEvent.change(selects[2], { target: { value: '01' } });
    const periodKey = form.querySelector('input[name="periodKey"]') as HTMLInputElement;
    expect(periodKey.value).toBe('2025-01');
  });
});

describe('e78fd03d (B) — the Pay cycle control is driven by the format, and nothing declares it today', () => {
  it('a MONTHLY format is asked for no cycle — a statutory return is one filing per month', () => {
    mount({ periodKind: 'month' });
    openDialog();
    expect(screen.queryByText(words(en).payCycle)).toBeNull();
    expect(document.querySelector('[data-cycle-field]')).toBeNull();
  });

  it('a format that declares the CYCLE kind does get the control', () => {
    mount({ periodKind: 'month-cycle' });
    openDialog();
    expect(screen.getByText(words(en).payCycle)).toBeInTheDocument();
    expect(document.querySelector('[data-cycle-field]')).not.toBeNull();
  });

  it('and it disappears again when the declaration goes back to monthly', () => {
    const first = mount({ periodKind: 'month-cycle' });
    openDialog();
    expect(document.querySelector('[data-cycle-field]')).not.toBeNull();
    first.unmount();

    mount({ periodKind: 'month' });
    openDialog();
    expect(document.querySelector('[data-cycle-field]')).toBeNull();
  });
});

describe('e78fd03d — the new strings exist in all six catalogues, and are really six strings', () => {
  const NEW_KEYS = ['selectionIntro', 'payCycle', 'cancel'] as const;

  it('every new key is present in every locale', () => {
    for (const [loc, messages] of LOCALES) {
      for (const key of NEW_KEYS) {
        expect(words(messages)[key], `payroll.paymentSubmission.${key} is missing from ${loc}.json`).toBeTruthy();
      }
    }
  });

  it('and each one is DISTINCT across the six — a merged English fallback would not be', () => {
    for (const key of NEW_KEYS) {
      const rendered = LOCALES.map(([, m]) => words(m)[key]);
      expect(new Set(rendered).size, `payroll.paymentSubmission.${key} is not translated in every locale`).toBe(
        LOCALES.length,
      );
    }
  });

  it('the pop-up really renders each locale’s own words', () => {
    const seen: string[] = [];
    for (const [loc, messages] of LOCALES) {
      const view = mount({ periodKind: 'month-cycle', locale: loc, messages });
      openDialog(words(messages).download);
      expect(screen.getByText(words(messages).selectionIntro)).toBeInTheDocument();
      expect(screen.getByText(words(messages).payCycle)).toBeInTheDocument();
      seen.push(words(messages).payCycle);
      view.unmount();
    }
    expect(new Set(seen).size).toBe(LOCALES.length);
  });
});
