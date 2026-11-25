/**
 * Board 66175cd2 (plan r1, commit 1) — THE OPEN FORM STEP'S PAYROLL YEAR AND PAYROLL MONTH, IN THE BROWSER.
 *
 * `PeriodCriterion` draws only the periods `PERIODS_ENDPOINT` lists for the chosen company, re-asks when the
 * Company changes, opens on the newest listed month, and — with nothing listed — says so in one sentence and
 * holds Continue. Mounted with the real `CyclesCriterion` on the same form, because the two talk through the
 * form: a month changed by the period list must re-list the payroll cycles, and the cycle list must never
 * re-enable a Continue the period list is holding. All data is fictional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { PeriodCriterion } from '../app/payroll/statutory-forms/open/period-criterion';
import { CyclesCriterion } from '../app/payroll/statutory-forms/open/cycles-criterion';
import { CYCLES_ENDPOINT, PERIODS_ENDPOINT, choosePeriod, periodMonths, periodYears } from '../app/payroll/statutory-forms/criteria';

const ACME = '11111111-2222-3333-4444-555555555555';
const NEW_CO = '99999999-8888-7777-6666-555555555555';
const OTHER = '22222222-3333-4444-5555-666666666666';
const RUNS = [{ runSeq: 1, runType: 'regular', cycleName: 'Monthly', status: 'processed' }];
const ACME_PERIODS = ['2026-10', '2026-09', '2026-08', '2025-12'];
const PERIODS: Record<string, string[]> = { [ACME]: ACME_PERIODS, [NEW_CO]: [], [OTHER]: ['2026-06'] };

let asked: string[] = [];
beforeEach(() => {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      asked.push(String(url));
      const u = new URL(String(url), 'http://x');
      const body =
        u.pathname === PERIODS_ENDPOINT ? { periods: PERIODS[u.searchParams.get('companyId') ?? ''] ?? [] } : { runs: RUNS };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const sf = en.payroll.statutoryForms;
const MONTH_NAMES = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, '0');
    return [m, new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1)))];
  }),
);

function mount(company: string, periods: string[]) {
  const chosen = choosePeriod(periods);
  return render(
    <NextIntlClientProvider locale="en" messages={en as unknown as Record<string, unknown>}>
      <form method="get" action="/payroll/borang-a/preview">
        <select name="companyId" defaultValue={company}>
          <option value={ACME}>Contoh Teknologi</option>
          <option value={NEW_CO}>Contoh Baru</option>
          <option value={OTHER}>Contoh Lain</option>
        </select>
        <PeriodCriterion
          formId="my.borang-a"
          endpoint={PERIODS_ENDPOINT}
          companyField="companyId"
          yearField="year"
          monthField="month"
          initialCompanyId={company}
          initialPeriods={periods}
          initialYear={chosen?.year ?? ''}
          initialMonth={chosen?.month ?? ''}
          monthNames={MONTH_NAMES}
          selectClassName=""
          strings={{ year: sf.year, month: sf.month, hint: sf.periods_hint, none: sf.periods_none }}
        />
        <CyclesCriterion
          companyField="companyId"
          yearField="year"
          monthField="month"
          initialCompanyId={company}
          initialYear={chosen?.year ?? ''}
          initialMonth={chosen?.month ?? ''}
          endpoint={CYCLES_ENDPOINT}
          strings={{ noRuns: sf.cycles_noRuns, nonePicked: sf.cycles_nonePicked, partialWarning: sf.cycles_partial }}
        />
        <button data-criteria-submit>Continue</button>
      </form>
    </NextIntlClientProvider>,
  );
}

const yearSelect = (c: HTMLElement) => c.querySelector('select[name="year"]') as HTMLSelectElement;
const monthSelect = (c: HTMLElement) => c.querySelector('select[name="month"]') as HTMLSelectElement;
const options = (s: HTMLSelectElement) => [...s.options].map((o) => o.value);
const continueButton = () => screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;

describe('66175cd2 — the period helpers', () => {
  it('derives the years, the months of a year and the default from one newest-first list', () => {
    expect(periodYears(ACME_PERIODS)).toEqual(['2026', '2025']);
    expect(periodMonths(ACME_PERIODS, '2026')).toEqual(['10', '09', '08']);
    expect(periodMonths(ACME_PERIODS, '2025')).toEqual(['12']);
    expect(periodMonths(ACME_PERIODS, '2024')).toEqual([]);
    // The newest by default; a handed-back period wins while it is still listed, and only then.
    expect(choosePeriod(ACME_PERIODS)).toEqual({ year: '2026', month: '10' });
    expect(choosePeriod(ACME_PERIODS, { year: '2025', month: '12' })).toEqual({ year: '2025', month: '12' });
    expect(choosePeriod(ACME_PERIODS, { year: '2026', month: '07' })).toEqual({ year: '2026', month: '10' });
    expect(choosePeriod([])).toBeNull();
    // A malformed entry is never offered.
    expect(periodYears(['2026-13', 'x', '2026-01'])).toEqual(['2026']);
  });
});

describe('66175cd2 — Payroll Year and Payroll Month list only processed EPF months', () => {
  it('offers only the listed years and that year’s months, newest first, with no fetch on arrival', async () => {
    const { container } = mount(ACME, ACME_PERIODS);
    expect(options(yearSelect(container))).toEqual(['2026', '2025']);
    expect(options(monthSelect(container))).toEqual(['10', '09', '08']);
    expect(yearSelect(container).value).toBe('2026');
    expect(monthSelect(container).value).toBe('10');
    expect(screen.getByText(sf.periods_hint)).toBeInTheDocument();
    await screen.findByText('Monthly');
    // The period list arrived from the server: only the payroll-cycle list was fetched.
    expect(asked.filter((u) => u.startsWith(PERIODS_ENDPOINT))).toEqual([]);
    expect(asked).toContain(`${CYCLES_ENDPOINT}?companyId=${ACME}&periodKey=2026-10`);
    expect(continueButton().disabled).toBe(false);
  });

  it('switches the months with the year, opens on that year’s newest, and re-lists the payroll cycles', async () => {
    const { container } = mount(ACME, ACME_PERIODS);
    await screen.findByText('Monthly');
    fireEvent.change(yearSelect(container), { target: { value: '2025' } });
    await waitFor(() => expect(options(monthSelect(container))).toEqual(['12']));
    expect(monthSelect(container).value).toBe('12');
    await waitFor(() => expect(asked).toContain(`${CYCLES_ENDPOINT}?companyId=${ACME}&periodKey=2025-12`));
  });

  it('re-asks for the company chosen, and holds Continue with one sentence when it has no EPF payroll', async () => {
    const { container } = mount(ACME, ACME_PERIODS);
    await screen.findByText('Monthly');
    fireEvent.change(container.querySelector('select[name="companyId"]')!, { target: { value: NEW_CO } });
    await waitFor(() => expect(asked).toContain(`${PERIODS_ENDPOINT}?form=my.borang-a&companyId=${NEW_CO}`));
    await screen.findByText(sf.periods_none);
    expect(options(yearSelect(container))).toEqual([]);
    expect(yearSelect(container).disabled).toBe(true);
    expect(monthSelect(container).disabled).toBe(true);
    await waitFor(() => expect(continueButton().disabled).toBe(true));
    // The payroll-cycle list settling afterwards (every cycle ticked) must NOT re-enable it.
    await new Promise((r) => setTimeout(r, 20));
    expect(continueButton().disabled).toBe(true);
    expect((container.querySelector('form') as HTMLFormElement).dataset.periodsEmpty).toBe('true');

    // Another company with a month: its list, its newest month, and Continue back.
    fireEvent.change(container.querySelector('select[name="companyId"]')!, { target: { value: OTHER } });
    await waitFor(() => expect(options(monthSelect(container))).toEqual(['06']));
    expect(yearSelect(container).value).toBe('2026');
    await waitFor(() => expect(continueButton().disabled).toBe(false));
    await waitFor(() => expect(asked).toContain(`${CYCLES_ENDPOINT}?companyId=${OTHER}&periodKey=2026-06`));
    expect((container.querySelector('form') as HTMLFormElement).dataset.periodsEmpty).toBeUndefined();
  });

  it('arrives with Continue held for a company that has nothing to file yet', async () => {
    const { container } = mount(NEW_CO, []);
    expect(screen.getByText(sf.periods_none)).toBeInTheDocument();
    await waitFor(() => expect(continueButton().disabled).toBe(true));
    expect(options(monthSelect(container))).toEqual([]);
  });
});
