/**
 * r407 (item 4f45f9b0) — THE PAYROLL CYCLE BOX ON THE STATUTORY CRITERIA STEP.
 *
 * The step is a server-rendered GET form; this island lists the month's processed runs through the shared
 * picker and must follow the Company / Year / Month selects of THAT form. Asserted against the FORM's
 * submitted fields, never against how many boxes are ticked — the whole no-change guarantee is that Select
 * All submits no `run` at all.
 *
 * `fetch` is stubbed (it stands in for the eligible-runs route) and nothing else is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { CyclesCriterion } from '../app/payroll/statutory-forms/open/cycles-criterion';

const COMPANY = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const ENDPOINT = '/payroll/payment-submission/runs';
const RUNS = [
  { runSeq: 1, runType: 'regular', cycleName: 'Monthly', status: 'processed' },
  { runSeq: 2, runType: 'bonus', cycleName: 'Bonus', status: 'processed' },
];
let asked: string[] = [];
let answer: unknown[] = RUNS;

beforeEach(() => {
  asked = [];
  answer = RUNS;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      asked.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ runs: answer }) } as Response);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const sf = en.payroll.statutoryForms;

function mount(initialRunSeqs?: number[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en as unknown as Record<string, unknown>}>
      <form method="get" action="/payroll/borang-a/preview">
        <select name="companyId" defaultValue={COMPANY}>
          <option value={COMPANY}>Acme</option>
          <option value={OTHER}>Beta</option>
        </select>
        <select name="year" defaultValue="2026">
          <option value="2026">2026</option>
        </select>
        <select name="month" defaultValue="07">
          <option value="07">July</option>
          <option value="08">August</option>
        </select>
        <CyclesCriterion
          companyField="companyId"
          yearField="year"
          monthField="month"
          initialCompanyId={COMPANY}
          initialYear="2026"
          initialMonth="07"
          endpoint={ENDPOINT}
          initialRunSeqs={initialRunSeqs}
          strings={{ noRuns: sf.cycles_noRuns, nonePicked: sf.cycles_nonePicked, partialWarning: sf.cycles_partial }}
        />
        <button data-criteria-submit>Continue</button>
      </form>
    </NextIntlClientProvider>,
  );
}

const runsOnTheWire = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLInputElement>('input[name="run"]')].map((i) => i.value);
const continueButton = () => screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;

describe('r407 — the criteria step asks which payroll cycles', () => {
  it('lists the chosen company and month, with SELECT ALL ticked and no run on the wire', async () => {
    const { container } = mount();
    await screen.findByText('Monthly');
    expect(asked[0]).toBe(`${ENDPOINT}?companyId=${COMPANY}&periodKey=2026-07`);
    expect(screen.getByText('Bonus')).toBeInTheDocument();
    expect((container.querySelector('[data-run-select-all]') as HTMLInputElement).checked).toBe(true);
    expect(runsOnTheWire(container)).toEqual([]);
    expect(continueButton().disabled).toBe(false);
  });

  it('submits exactly the ticked runs once one is left out', async () => {
    const { container } = mount();
    await screen.findByText('Monthly');
    fireEvent.click(container.querySelector('[data-run-option="1"]')!);
    expect(runsOnTheWire(container)).toEqual(['2']);
    expect(screen.getByText(sf.cycles_partial)).toBeInTheDocument();
  });

  it('disables Continue when nothing is ticked, because an empty selection cannot be written on a URL', async () => {
    const { container } = mount();
    await screen.findByText('Monthly');
    fireEvent.click(container.querySelector('[data-run-clear]')!);
    expect(runsOnTheWire(container)).toEqual([]);
    await waitFor(() => expect(continueButton().disabled).toBe(true));
    expect(screen.getByText(sf.cycles_nonePicked)).toBeInTheDocument();
    fireEvent.click(container.querySelector('[data-run-select-all]')!);
    await waitFor(() => expect(continueButton().disabled).toBe(false));
  });

  it('re-lists when the month on the SAME form changes, and starts from Select All again', async () => {
    const { container } = mount();
    await screen.findByText('Monthly');
    fireEvent.click(container.querySelector('[data-run-option="1"]')!);
    fireEvent.change(container.querySelector('select[name="month"]')!, { target: { value: '08' } });
    await waitFor(() => expect(asked).toContain(`${ENDPOINT}?companyId=${COMPANY}&periodKey=2026-08`));
    await screen.findByText('Monthly');
    expect(runsOnTheWire(container)).toEqual([]);
  });

  it('comes back from a refusal with the cycles the operator had ticked', async () => {
    const { container } = mount([2]);
    await screen.findByText('Monthly');
    expect(runsOnTheWire(container)).toEqual(['2']);
  });

  it('says so when the month has no processed run, and leaves Continue to the server-side gate', async () => {
    answer = [];
    mount();
    await screen.findByText(sf.cycles_noRuns);
    expect(continueButton().disabled).toBe(false);
  });
});
