/**
 * e440991b — the Reprocess selection screen, PROVED BY RENDERING.
 *
 * WHY THIS EXISTS ALONGSIDE test/payroll-reprocess-route-e440991b.test.ts. That file proves what the
 * server decided — who may reprocess, which run, which employees, and what the stored figures say. It
 * cannot prove what a person actually SEES, and this ticket is entirely about that: the reporter's
 * complaint was never the calculation (35 completed jobs on production, the latest this week) but the
 * screen you have to reach it through.
 *
 * IT IS ALSO THE RENDER CHECK THIS SCREEN COULD OTHERWISE ONLY GET FROM A DEV SERVER, for the client
 * half. NextIntlClientProvider is given the REAL en.json and the assertions below are on the RENDERED
 * TEXT, not on the presence of a t() call — so a key this component asks for and the catalog does not
 * hold fails here rather than painting MISSING_MESSAGE at an operator, which is the failure mode that
 * passes tsc, the suite and `next build` and still returns 200 (r134). That covers en and only the
 * strings asserted on; the other five locales are covered structurally by test/i18n-coverage.test.ts
 * check A, and every key the SERVER half reads is resolved per-namespace in
 * test/payroll-reprocess-route-e440991b.test.ts. None of the three replaces reading a dev-server log.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import {
  ReprocessForm,
  type ReprocessAddCandidate,
  type ReprocessCandidate,
} from '../app/payroll/[batchId]/reprocess/reprocess-form';

// The server action, stubbed. It is a 'use server' module that reaches Postgres on import; what this file
// is about is the screen in front of it, and the action's own behaviour is proved against a real database
// in test/payroll-reprocess-route-e440991b.test.ts.
vi.mock('../app/payroll/actions', () => ({ reprocessSelectedAction: vi.fn() }));

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const emp = (over: Partial<ReprocessCandidate> & { employmentId: string }): ReprocessCandidate => ({
  employeeCode: 'T100001',
  name: 'John Tan',
  gross: '4100.00',
  net: '3200.00',
  reprocessedTimes: 0,
  ...over,
});

const PEOPLE: ReprocessCandidate[] = [
  emp({ employmentId: 'e1' }),
  emp({ employmentId: 'e2', employeeCode: 'T100002', name: 'Alice Lim', gross: '3780.00', net: '2950.00' }),
  emp({ employmentId: 'e3', employeeCode: 'T100003', name: 'Raj Kumar', gross: '6250.00', net: '5014.20', reprocessedTimes: 2 }),
];

const form = (over: Partial<Parameters<typeof ReprocessForm>[0]> = {}) =>
  wrap(<ReprocessForm batchId="b1" employees={PEOPLE} currency="MYR" {...over} />);

const boxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[];
const submit = () => screen.getByRole('button', { name: /Reprocess \d+ employee/ });

describe('e440991b — the selection screen renders', () => {
  it('lists every payslip on the run with its gross, net and prior-reprocess count', () => {
    const { container } = form();
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('John Tan')).toBeInTheDocument();
    // Money carries the COMPANY's currency rather than a hard-coded RM — this screen is reached from a
    // list that spans every company in scope, which is exactly where "RM" makes a false statement.
    expect(rows[0]!.textContent).toContain('MYR 4,100.00');
    expect(rows[0]!.textContent).toContain('MYR 3,200.00');
    // "Already reprocessed" is version - 1 off the stored payslip: an em dash at zero, a count above it.
    expect(rows[0]!.textContent).toContain('—');
    expect(rows[2]!.textContent).toContain('2 time(s)');
  });

  it('arrives with the employments the run marked STALE already ticked (49e7e0a2)', () => {
    // Editing a one-off transaction on a processed run is what produces that list. Making the operator
    // re-derive by hand which people they just changed is how the wrong subset gets reprocessed.
    form({ preselectedIds: ['e2'] });
    const [a, b, c] = boxes();
    expect(a.checked).toBe(false);
    expect(b.checked, 'the stale employment arrived unticked').toBe(true);
    expect(c.checked).toBe(false);
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();
  });

  it('nothing ticked ⇒ nothing can be submitted', () => {
    form();
    expect(submit()).toBeDisabled();
    // …and there is no review block claiming an empty selection is about to be reprocessed.
    expect(screen.queryByText(/Before you submit/)).not.toBeInTheDocument();
  });
});

describe('e440991b — the review step restates what will and will not happen', () => {
  it('names exactly the people picked, and how many payslips stay untouched', async () => {
    const user = userEvent.setup();
    form();
    await user.click(boxes()[0]!);
    await user.click(boxes()[2]!);

    const review = screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).toContain('2 of 3 employee(s)');
    expect(within(review).getByText('John Tan')).toBeInTheDocument();
    expect(within(review).getByText('Raj Kumar')).toBeInTheDocument();
    // The promise this screen makes about everyone else. If this ever silently stopped matching the
    // selection, the operator would be reading a reassurance the run is not honouring.
    expect(within(review).queryByText('Alice Lim')).not.toBeInTheDocument();
    expect(review.textContent).toContain('The other 1 payslip(s) are not touched');
    expect(submit()).toBeEnabled();
    expect(submit().textContent).toContain('2');
  });

  it('Select all and Clear move the whole selection, and the review follows', async () => {
    const user = userEvent.setup();
    form();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    expect(screen.getByText(/Before you submit/).closest('div')!.textContent).toContain(
      'The other 0 payslip(s) are not touched',
    );

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(boxes().some((b) => b.checked)).toBe(false);
    expect(submit()).toBeDisabled();
    expect(screen.queryByText(/Before you submit/)).not.toBeInTheDocument();
  });
});

describe('e440991b — what the form posts', () => {
  it('posts the ticked employments, the batch and ONE idempotency token', () => {
    const { container } = form({ preselectedIds: ['e1', 'e3'] });
    const el = container.querySelector('form') as HTMLFormElement;
    const data = new FormData(el);
    expect(data.getAll('employmentIds')).toEqual(['e1', 'e3']);
    expect(data.get('batchId')).toBe('b1');
    // Minted once per mount and posted with the submit, so a double-clicked confirm reuses the same
    // payroll_reprocess_job row instead of enqueuing a second run. The review block lives INSIDE this
    // form, from this same state — a separate confirm step with its own mount would hand the service a
    // fresh token and the guard would be gone.
    const key = data.get('idempotencyKey');
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(data.get('reason'), 'the reason is optional and posts empty by default').toBe('');
  });

  it('the token survives changing the selection — it is per MOUNT, not per submit', async () => {
    const user = userEvent.setup();
    const { container } = form();
    const el = container.querySelector('form') as HTMLFormElement;
    const before = new FormData(el).get('idempotencyKey');
    await user.click(boxes()[0]!);
    await user.click(boxes()[1]!);
    await user.click(boxes()[0]!);
    expect(new FormData(el).get('idempotencyKey')).toBe(before);
  });

  it('an empty run says so instead of offering an empty tick list', () => {
    form({ employees: [] });
    expect(screen.getByText('No employees on this run.')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(submit()).toBeDisabled();
  });
});

/**
 * fbcf706d — THE NEW / PENDING GROUP, proved by rendering for the same reason as everything above it:
 * `MISSING_MESSAGE` passes tsc, the suite and `next build`, and these rows carry the highest density of
 * new copy on the screen. The assertions below are on rendered TEXT resolved from the real en.json.
 */
const add = (over: Partial<ReprocessAddCandidate> & { employmentId: string }): ReprocessAddCandidate => ({
  employeeCode: 'A0001',
  name: 'Siti Aminah',
  hiredOn: '2026-01-06',
  outsideScope: false,
  blockers: [],
  warnings: [],
  ...over,
});

describe('fbcf706d — people eligible for the month with no payslip on the run', () => {
  it('is not rendered at all when nobody is waiting — the screen is exactly what it was', () => {
    const { container } = form({ newCandidates: [] });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(screen.queryByText(/New \/ Pending/)).not.toBeInTheDocument();
  });

  it('lists them above the people already paid, ready-ticked, with the reason on the row', () => {
    const { container } = form({ newCandidates: [add({ employmentId: 'n1' })] });
    const tables = [...container.querySelectorAll('table')];
    // ORDER IS THE POINT: the finding goes above the list you already knew about.
    expect(tables[0]!.textContent).toContain('Siti Aminah');
    expect(tables[1]!.textContent).toContain('John Tan');
    expect(tables[0]!.textContent).toContain('New / Pending');
    expect(tables[0]!.textContent).toContain('Eligible for this month and has no payslip on this run.');
    expect(tables[0]!.textContent).toContain('2026-01-06');
    // Being on this list is itself the finding, so paying them is one press.
    const box = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(box.checked, 'the waiting employee arrived unticked').toBe(true);
    expect(box.value).toBe('n1');
    expect(screen.getByText('1 of 4 selected')).toBeInTheDocument();
  });

  it('somebody the run’s chosen list does not cover arrives UNTICKED, and the row says why', () => {
    form({ newCandidates: [add({ employmentId: 'n1', outsideScope: true })] });
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false);
    expect(
      screen.getByText(/This run was set up for a chosen list of people and this person is not on it/),
    ).toBeInTheDocument();
  });

  it('somebody whose record cannot be paid yet is named and CANNOT be ticked', () => {
    form({ newCandidates: [add({ employmentId: 'n1', blockers: ['missingCompensation'], warnings: ['missingBank'] })] });
    const box = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled, 'a blocked employee could still be submitted').toBe(true);
    expect(screen.getByText(/Cannot be paid yet — no salary record/)).toBeInTheDocument();
  });

  it('a warning-only gap is stated but never prevents the add', () => {
    form({ newCandidates: [add({ employmentId: 'n1', warnings: ['missingStatutory', 'missingBank'] })] });
    const box = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/Also missing: statutory details, bank details/)).toBeInTheDocument();
  });

  it('the review restates the addition separately from the recalculation', async () => {
    const user = userEvent.setup();
    form({ newCandidates: [add({ employmentId: 'n1' })] });
    await user.click(screen.getAllByRole('checkbox')[1]!); // John Tan, already paid
    const review = screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).toContain('2 of 4 employee(s)');
    // "The other N payslips are not touched" counts PAYSLIPS — an addition has none to leave alone.
    expect(review.textContent).toContain('The other 2 payslip(s) are not touched');
    expect(review.textContent).toContain('1 of them are being added to this run for the first time');
  });

  it('posts the additions alongside the recalculations, in one id list', () => {
    const { container } = form({ newCandidates: [add({ employmentId: 'n1' })], preselectedIds: ['e3'] });
    const data = new FormData(container.querySelector('form') as HTMLFormElement);
    expect(data.getAll('employmentIds').sort()).toEqual(['e3', 'n1']);
  });

  it('both groups carry the same Status and Reason columns', () => {
    const { container } = form({ newCandidates: [add({ employmentId: 'n1' })] });
    for (const table of [...container.querySelectorAll('table')]) {
      const head = table.querySelector('thead')!.textContent!;
      expect(head).toContain('Status');
      expect(head).toContain('Reason');
    }
    expect(container.querySelectorAll('table')[1]!.textContent).toContain('Already paid on this run');
  });
});
