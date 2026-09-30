/**
 * r372 (item f022dd70) — THE PAYROLL CYCLE MULTI-SELECT on the Payment Submission download pop-up.
 *
 * "The Payroll Cycle field shall support multi-selection … shall default to Select All … The user shall
 * be able to remove the default selections and select only the required Payroll Cycle(s)." That is the
 * item, and the acceptance criteria that can only be checked against a real DOM are 1-7 and 14.
 *
 * ⚠️ WHY A DOM TEST AND NOT THE §8 RENDER CHECK. The dialog mounts on OPEN and its content lives inside a
 * `Dialog.Portal`, so NONE of it is in the server HTML a curl can fetch — the r334/cbfa8b0b lesson, and
 * the same reason `test/r340-payment-submission-download-modal.dom.test.tsx` exists. Grepping the rendered
 * page for these strings would pass while the control was broken.
 *
 * ── WHAT IS ACTUALLY LOAD-BEARING HERE, AND IT IS NOT THE TICK BOXES ────────────────────────────
 * The one property the whole feature's no-change guarantee rests on is that TICKING EVERYTHING SUBMITS NO
 * `run` PARAMETER AT ALL. The three generators then take their pre-existing whole-month path and the file
 * cannot have moved — by construction, not by a test comparing two code paths. So the assertions below are
 * made against the FORM's submitted fields, never against how many boxes are ticked: a control that looked
 * perfect and emitted `run=1&run=2&run=3` for "All" would be a different request that merely ought to
 * produce the same bytes, and that is exactly the difference this pins.
 *
 * `fetch` IS STUBBED, and that is the whole of the mocking. The picker reads the eligible-runs route
 * because the page it sits on deliberately opens no database; the stub stands in for that route and
 * nothing else here is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { DownloadDialog } from '../app/payroll/payment-submission/download-dialog';

const COMPANY = '11111111-2222-3333-4444-555555555555';
const OTHER_COMPANY = '99999999-8888-7777-6666-555555555555';
const DOWNLOAD_ROUTE = '/payroll/payment-submission/download';
const RUNS_ROUTE = '/payroll/payment-submission/runs';

/**
 * A month with three runs, which is the reporter's own example: Monthly, Bonus, Off-Cycle.
 *
 * `cycleName` IS NULL ON THE THIRD, DELIBERATELY. `payroll_batch.payroll_cycle_id` is nullable and null on
 * every batch opened before migration 0441, so a month whose runs all carry a configured cycle name is the
 * unrepresentative case. The third run has to fall back to its run-type word or the control is untestable
 * against production data.
 */
const RUNS = [
  { runSeq: 1, runType: 'regular', cycleName: 'Monthly', status: 'processed' },
  { runSeq: 2, runType: 'bonus', cycleName: 'Bonus', status: 'processed' },
  { runSeq: 3, runType: 'off_cycle', cycleName: null, status: 'closed' },
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

/** Every URL the picker asked for, in order — so "it re-fetches when the month changes" is a fact. */
let asked: string[] = [];

function stubRuns(runs: unknown, opts: { ok?: boolean } = {}) {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      asked.push(String(url));
      return Promise.resolve({
        ok: opts.ok ?? true,
        json: () => Promise.resolve({ runs }),
      } as Response);
    }),
  );
}

beforeEach(() => stubRuns(RUNS));
afterEach(() => vi.unstubAllGlobals());

function mount(p: { locale?: string; messages?: unknown; defaultCompanyId?: string } = {}) {
  return render(
    <NextIntlClientProvider
      locale={p.locale ?? 'en'}
      messages={(p.messages ?? en) as Record<string, unknown>}
    >
      <DownloadDialog
        formatId="test.format"
        formatLabel="Test format"
        periodKind="month-runs"
        action={DOWNLOAD_ROUTE}
        companies={[
          { value: COMPANY, label: 'Acme Sdn Bhd' },
          { value: OTHER_COMPANY, label: 'Beta Sdn Bhd' },
        ]}
        defaultCompanyId={p.defaultCompanyId ?? COMPANY}
        years={['2026', '2025']}
        defaultYear="2026"
        months={[
          { value: '08', label: 'August' },
          { value: '09', label: 'September' },
        ]}
        defaultMonth="09"
        runsEndpoint={RUNS_ROUTE}
      />
    </NextIntlClientProvider>,
  );
}

const openDialog = () => fireEvent.click(screen.getByRole('button', { name: words(en).download }));

/** The form's own fields, read the way a browser would submit them. Positions are never asserted. */
function submitted(container: HTMLElement): { name: string; value: string }[] {
  const form = container.ownerDocument.querySelector('form');
  if (!form) throw new Error('the dialog rendered no form');
  return [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')].map(
    (el) => ({ name: el.name, value: el.value }),
  );
}
const runsOnTheWire = (container: HTMLElement) =>
  submitted(container)
    .filter((f) => f.name === 'run')
    .map((f) => f.value);

/** Wait for the fetch to land and the list to be drawn. */
const untilLoaded = () => screen.findByText('Monthly');

describe('r372 — the pop-up asks which payroll cycles, and defaults to all of them', () => {
  it('offers one tick box per run of the chosen company and month', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    for (const r of RUNS) {
      expect(baseElement.querySelector(`[data-run-option="${r.runSeq}"]`), `run ${r.runSeq}`).toBeTruthy();
    }
    expect(baseElement.querySelectorAll('[data-run-option]')).toHaveLength(RUNS.length);
  });

  it('asks the eligible-runs route for exactly the company and month the pop-up is showing', async () => {
    mount();
    openDialog();
    await untilLoaded();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(RUNS_ROUTE);
    expect(asked[0]).toContain(`companyId=${COMPANY}`);
    expect(asked[0]).toContain('periodKey=2026-09');
  });

  it('labels a run by its CYCLE NAME, and falls back to the run-type word when it has none', async () => {
    mount();
    openDialog();
    await untilLoaded();
    // The first two named a configured cycle; the third did not and falls back. Not "Off-cycle 3" and
    // not an empty label — the same rule the payslip screen and the payslip PDF already share.
    expect(screen.getByText('Monthly')).toBeTruthy();
    expect(screen.getByText('Bonus')).toBeTruthy();
    expect(screen.getByText(words(en).runTypeOffCycle)).toBeTruthy();
  });

  it('prints WHICH run of the month underneath, so two runs sharing a name stay distinguishable', async () => {
    stubRuns([
      { runSeq: 2, runType: 'off_cycle', cycleName: 'Off-Cycle', status: 'processed' },
      { runSeq: 3, runType: 'off_cycle', cycleName: 'Off-Cycle', status: 'processed' },
    ]);
    const { baseElement } = mount();
    openDialog();
    await waitFor(() => expect(baseElement.querySelectorAll('[data-run-option]')).toHaveLength(2));
    // Two identically named runs, told apart by the line beneath each. A control that showed "Off-Cycle"
    // twice with nothing else on it could not be used at all.
    expect(screen.getByText('Run 2 of the month')).toBeTruthy();
    expect(screen.getByText('Run 3 of the month')).toBeTruthy();
  });

  it('reads "All payroll cycles" when it opens', async () => {
    mount();
    openDialog();
    await untilLoaded();
    expect(screen.getByText(words(en).payCycleAll)).toBeTruthy();
  });
});

describe('r372 — ticking everything submits NO run parameter, which is the no-change guarantee', () => {
  /**
   * ⚠️ THE LOAD-BEARING ASSERTION OF THIS FILE. See the header: "All" must be the ABSENCE of the
   * parameter, not a set of every value, or the ordinary monthly submission stops being the identical
   * request it has always been.
   */
  it('the default selection puts no `run` on the form at all', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    expect(runsOnTheWire(baseElement)).toEqual([]);
    // Not vacuous: the rest of the request is still there.
    expect(submitted(baseElement).map((f) => f.name)).toContain('periodKey');
    expect(submitted(baseElement).map((f) => f.name)).toContain('companyId');
  });

  it('un-ticking one run puts the REMAINING runs on the form, ascending', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    fireEvent.click(baseElement.querySelector('[data-run-option="2"]')!);
    expect(runsOnTheWire(baseElement)).toEqual(['1', '3']);
  });

  it('Select All clears to nothing and restores to every run — and the cleared state sends nothing', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    const selectAll = baseElement.querySelector('[data-run-select-all]')!;
    fireEvent.click(selectAll); // everything -> nothing
    expect(baseElement.querySelector('[data-run-none-picked]')).toBeTruthy();
    // Nothing ticked also sends nothing, which produces the whole month. The screen SAYS so rather than
    // silently doing something else — asserted here so the sentence cannot be dropped in a tidy-up.
    expect(runsOnTheWire(baseElement)).toEqual([]);
    fireEvent.click(selectAll); // nothing -> everything
    expect(runsOnTheWire(baseElement)).toEqual([]);
    expect(screen.getByText(words(en).payCycleAll)).toBeTruthy();
  });

  it('a single cycle can be filed on its own', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    fireEvent.click(baseElement.querySelector('[data-run-select-all]')!);
    fireEvent.click(baseElement.querySelector('[data-run-option="2"]')!);
    expect(runsOnTheWire(baseElement)).toEqual(['2']);
  });
});

describe('r372 — a part-month selection says what it is, and Download is never taken away', () => {
  it('warns as soon as one cycle is left out, and not before', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    expect(baseElement.querySelector('[data-run-partial-warning]')).toBeNull();
    fireEvent.click(baseElement.querySelector('[data-run-option="3"]')!);
    expect(baseElement.querySelector('[data-run-partial-warning]')).toBeTruthy();
    expect(screen.getByText(words(en).payCyclePartialWarning)).toBeTruthy();
  });

  /**
   * ⚠️ THE OPPOSITE OF THE `'month-cycle'` RULE, AND THE DIFFERENCE IS DELIBERATE. An empty list for a
   * money-moving single-cycle format DISABLES Download, because a select with no options submits nothing
   * and would pay a whole month from a button somebody pressed believing they had picked one run. A
   * statutory return has no such hazard: no parameter IS the whole month, which is what this shelf has
   * always produced, and the builder's own 422 is a better refusal than a greyed-out button.
   */
  it('a month with no completed run explains itself and leaves Download pressable', async () => {
    stubRuns([]);
    const { baseElement } = mount();
    openDialog();
    await screen.findByText(words(en).payCycleNoRuns);
    expect(baseElement.querySelector('[data-run-empty]')).toBeTruthy();
    const submit = [...baseElement.querySelectorAll('button')].find((b) => b.type === 'submit')!;
    expect(submit.disabled).toBe(false);
    expect(runsOnTheWire(baseElement)).toEqual([]);
  });

  it('a failed lookup behaves like an empty month rather than blocking the file', async () => {
    stubRuns([], { ok: false });
    const { baseElement } = mount();
    openDialog();
    await screen.findByText(words(en).payCycleNoRuns);
    const submit = [...baseElement.querySelectorAll('button')].find((b) => b.type === 'submit')!;
    expect(submit.disabled).toBe(false);
  });
});

describe('r372 — the list follows the company and the month, and never lags behind them', () => {
  it('re-asks when the payroll month changes', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    fireEvent.change(baseElement.querySelector('[data-field="month"]')!, { target: { value: '08' } });
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toContain('periodKey=2026-08');
  });

  it('re-asks when the company changes', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    fireEvent.change(baseElement.querySelector('[data-field="company"]')!, {
      target: { value: OTHER_COMPANY },
    });
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toContain(`companyId=${OTHER_COMPANY}`);
    // …and the company the form SUBMITS moved with it. An uncontrolled select would have left the picker
    // showing one company's runs under another company's download.
    expect(submitted(baseElement).find((f) => f.name === 'companyId')?.value).toBe(OTHER_COMPANY);
  });

  it('re-asks when the year changes', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    fireEvent.change(baseElement.querySelector('[data-field="year"]')!, { target: { value: '2025' } });
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toContain('periodKey=2025-09');
  });
});

describe('r372 — the search box appears only when a month holds enough runs to need one', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    runSeq: i + 1,
    runType: i === 0 ? 'regular' : 'off_cycle',
    cycleName: i === 0 ? 'Monthly' : `Special ${i}`,
    status: 'processed',
  }));

  it('is absent for an ordinary month', async () => {
    const { baseElement } = mount();
    openDialog();
    await untilLoaded();
    expect(baseElement.querySelector('[data-run-search]')).toBeNull();
  });

  it('appears for a crowded month and narrows the list by NAME', async () => {
    stubRuns(many);
    const { baseElement } = mount();
    openDialog();
    await waitFor(() => expect(baseElement.querySelectorAll('[data-run-option]')).toHaveLength(8));
    const box = baseElement.querySelector('[data-run-search]')!;
    fireEvent.change(box, { target: { value: 'Special 3' } });
    expect(baseElement.querySelectorAll('[data-run-option]')).toHaveLength(1);
    // ⚠️ SEARCHING HIDES ROWS, IT DOES NOT UNTICK THEM. A filter that silently narrowed the SELECTION
    // would file eight runs' worth of contributions minus seven the operator never chose to drop.
    expect(runsOnTheWire(baseElement)).toEqual([]);
  });
});

describe('r372 — every new word exists in all six catalogues, present AND distinct', () => {
  /**
   * `i18n/request.ts` deep-merges each locale over English, so a key MISSING from ms.json renders the
   * English sentence rather than a MISSING_MESSAGE. Presence alone would therefore pass for an untranslated
   * catalogue; distinctness from English is what actually catches one.
   */
  const KEYS = [
    'payCycleAll',
    'payCycleSelectAll',
    'payCycleSearch',
    'payCycleLoading',
    'payCycleNoRuns',
    'payCycleRun',
    'payCyclePartialWarning',
    'payCycleNonePicked',
    'runTypeRegular',
    'runTypeOffCycle',
    'runTypeBonus',
    'runTypeAdjustment',
  ] as const;

  for (const [locale, messages] of LOCALES) {
    it(`${locale} carries every key`, () => {
      for (const k of KEYS) expect(words(messages)[k], `${locale}.${k}`).toBeTruthy();
    });
  }

  it('the non-English catalogues are TRANSLATED, not inherited', () => {
    for (const [locale, messages] of LOCALES) {
      if (locale === 'en') continue;
      // 'Bonus' is a loanword in several of these, so it is exempt by name rather than by a loose rule.
      for (const k of KEYS) {
        if (k === 'runTypeBonus') continue;
        expect(words(messages)[k], `${locale}.${k} is still the English sentence`).not.toBe(words(en)[k]);
      }
    }
  });

  it('renders the pop-up in each locale without falling back to English', async () => {
    for (const [locale, messages] of LOCALES) {
      if (locale === 'en') continue;
      stubRuns(RUNS);
      const view = mount({ locale, messages });
      fireEvent.click(view.getByRole('button', { name: words(messages).download }));
      await waitFor(() =>
        expect(view.baseElement.querySelectorAll('[data-run-option]').length).toBeGreaterThan(0),
      );
      expect(view.getAllByText(words(messages).payCycleAll).length, locale).toBeGreaterThan(0);
      view.unmount();
    }
  });
});
