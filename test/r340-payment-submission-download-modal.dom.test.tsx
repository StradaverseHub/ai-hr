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
/**
 * A payroll month's runs, as the caller of a `'month-cycle'` format would supply them: one regular run and
 * one bonus run, which is the ADR-0024 case the cycle field exists for — the two have different payment
 * dates, so a file that pays people has to say which of them it pays.
 */
const CYCLES = [
  { value: '1', label: 'Regular' },
  { value: '2', label: 'Bonus' },
];

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

/**
 * The dialog as the page mounts it, with only the format's declaration varying.
 *
 * ⚠️ `cycles` IS SUPPLIED FOR A `'month-cycle'` MOUNT, and that is the realistic fixture rather than a
 * convenience. A `'month-cycle'` format whose runs were NOT supplied is a different case with a different
 * correct behaviour — it must refuse, because a select with no options submits no cycle and the download
 * would quietly become a whole-month file — and it has its own test below. Leaving `cycles` empty here
 * would have asserted the cycle control against a state the control is not allowed to be in.
 */
function mount(p: {
  periodKind: SubmissionFormat['periodKind'];
  locale?: string;
  messages?: unknown;
  cycles?: { value: string; label: string }[];
}) {
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
        cycles={p.cycles ?? (p.periodKind === 'month-cycle' ? CYCLES : undefined)}
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
    // ⚠️ ADDRESSED BY `data-field`, NEVER BY POSITION. `selects[1]` / `selects[2]` would pin the ORDER the
    // pop-up happens to ask its questions in: insert a field above them and the assertion silently re-aims
    // itself at the wrong control instead of failing. The invariant is "the year control" and "the month
    // control", so that is what is named (CLAUDE.md §8: pin invariants, not positions).
    const field = (name: string) => {
      const el = form.querySelector(`select[data-field="${name}"]`) as HTMLSelectElement | null;
      expect(el, `the pop-up must carry a ${name} control`).not.toBeNull();
      return el!;
    };
    fireEvent.change(field('year'), { target: { value: '2025' } });
    fireEvent.change(field('month'), { target: { value: '01' } });
    const periodKey = form.querySelector('input[name="periodKey"]') as HTMLInputElement;
    expect(periodKey.value).toBe('2025-01');
  });

  it('year and month are the JOIN into periodKey, so neither is a named field of its own', () => {
    mount({ periodKind: 'month' });
    openDialog();
    const form = document.querySelector('form')!;
    for (const name of ['year', 'month']) {
      const el = form.querySelector(`select[data-field="${name}"]`) as HTMLSelectElement;
      // A `name` here would put a stray `year=`/`month=` on the download URL beside the periodKey the
      // route actually reads — two spellings of one period, which is what the hidden input removed.
      expect(el.getAttribute('name'), `the ${name} select must not submit a field of its own`).toBeNull();
    }
    // The company select DOES submit, under the name the route reads.
    expect(form.querySelector('select[data-field="company"]')!.getAttribute('name')).toBe('companyId');
  });
});

describe('e78fd03d (B) — the Pay cycle control is driven by the format, and nothing declares it today', () => {
  it('a MONTHLY format is asked for no cycle — a statutory return is one filing per month', () => {
    mount({ periodKind: 'month' });
    openDialog();
    expect(screen.queryByText(words(en).payCycle)).toBeNull();
    expect(document.querySelector('[data-cycle-field]')).toBeNull();
  });

  it('a format that declares the CYCLE kind does get the control, with the month’s runs on it', () => {
    mount({ periodKind: 'month-cycle', cycles: CYCLES });
    openDialog();
    expect(screen.getByText(words(en).payCycle)).toBeInTheDocument();
    const cycle = document.querySelector('select[data-cycle-field]') as HTMLSelectElement | null;
    expect(cycle, 'the control must be a real select, not a notice').not.toBeNull();
    // It must SUBMIT, and it must have something to submit: a select with no options sends no `cycle` at
    // all, which is the silent whole-month download the next test refuses.
    expect(cycle!.getAttribute('name')).toBe('cycle');
    expect([...cycle!.options].map((o) => o.value)).toEqual(['1', '2']);
    expect(cycle!.value, 'a cycle is chosen, so the download carries one').toBe('1');
  });

  it('and with NO runs supplied it REFUSES rather than silently downloading the whole month', () => {
    // The trap this replaces: `cycles` defaults to `[]`, a select with no options submits no `cycle`
    // parameter, and the file an operator believed was one run would have been every run of the month
    // added together. Unreachable today — nothing declares the kind — which is exactly why it is settled
    // before the first salary format inherits it.
    mount({ periodKind: 'month-cycle', cycles: [] });
    openDialog();
    // The label still asks for a cycle; what is missing is said in words where the control would be.
    expect(screen.getByText(words(en).payCycle)).toBeInTheDocument();
    expect(screen.getByText(words(en).payCycleMissing)).toBeInTheDocument();
    expect(document.querySelector('select[data-cycle-field]'), 'no empty select is offered').toBeNull();
    expect(document.querySelector('[data-cycle-missing]')).not.toBeNull();
    // And the download cannot be pressed: the submit is the last Download button on the page.
    const buttons = screen.getAllByRole('button', { name: words(en).download });
    const submit = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(submit.getAttribute('type')).toBe('submit');
    expect(submit.disabled, 'a file that cannot say which run it pays must not be downloadable').toBe(true);
  });

  it('a MONTHLY format is never refused for a cycle it was not asked to supply', () => {
    // The refusal above must be specific to a format that DECLARED it needs a cycle. Every shipped format
    // is monthly and supplies no cycles, so a refusal keyed on `cycles.length` alone would have taken the
    // download away from all three.
    mount({ periodKind: 'month' });
    openDialog();
    expect(screen.queryByText(words(en).payCycleMissing)).toBeNull();
    const buttons = screen.getAllByRole('button', { name: words(en).download });
    const submit = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('and it disappears again when the declaration goes back to monthly', () => {
    const first = mount({ periodKind: 'month-cycle', cycles: CYCLES });
    openDialog();
    expect(document.querySelector('[data-cycle-field]')).not.toBeNull();
    first.unmount();

    mount({ periodKind: 'month' });
    openDialog();
    expect(document.querySelector('[data-cycle-field]')).toBeNull();
  });
});

describe('e78fd03d — the new strings exist in all six catalogues, and are really six strings', () => {
  const NEW_KEYS = ['selectionIntro', 'payCycle', 'cancel', 'payCycleMissing'] as const;

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
      const view = mount({ periodKind: 'month-cycle', locale: loc, messages, cycles: CYCLES });
      openDialog(words(messages).download);
      expect(screen.getByText(words(messages).selectionIntro)).toBeInTheDocument();
      expect(screen.getByText(words(messages).payCycle)).toBeInTheDocument();
      seen.push(words(messages).payCycle);
      view.unmount();
    }
    expect(new Set(seen).size).toBe(LOCALES.length);
  });
});
