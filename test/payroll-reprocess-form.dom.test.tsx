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
  type ReprocessRequiredRow,
} from '../app/payroll/[batchId]/reprocess/reprocess-form';

// The server action, stubbed. It is a 'use server' module that reaches Postgres on import; what this file
// is about is the screen in front of it, and the action's own behaviour is proved against a real database
// in test/payroll-reprocess-route-e440991b.test.ts.
vi.mock('../app/payroll/actions', () => ({ reprocessSelectedAction: vi.fn() }));
// Imported so the Enter cases below can assert the recalculation was never enqueued — the same mock the
// form is rendered against, not a second one.
import { reprocessSelectedAction } from '../app/payroll/actions';

// Navigation is tested separately; these tests retain the real selection/review/form state.
vi.mock('../components/client-pager', () => ({ ClientPager: ({rememberAs}:{rememberAs?:string}) => <nav aria-label={rememberAs}/> }));
vi.mock('../app/payroll/selection-search', () => ({ PayrollSelectionSearch: () => null }));
import { pageState, parsePageQuery } from '../lib/pagination';

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

/** 6aee208b — the stale set as `reprocessStaleSelection` returns it: identities, in list order. */
const staleOf = (ids: string[], withoutPayslip = 0) => ({
  rows: ids.map((id) => {
    const p = PEOPLE.find((x) => x.employmentId === id);
    return { employmentId: id, employeeCode: p?.employeeCode ?? null, name: p?.name ?? 'Off-page ' + id };
  }),
  withoutPayslip,
});

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
    form({ stale: staleOf(['e2']) });
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
    // a1a80747 — no tax readiness step in between: the ticked selection is submittable as it is.
    expect(submit()).toBeEnabled();
    expect(submit().textContent).toContain('2');
  });

  it('Select all and Clear move the whole selection, and the review follows', async () => {
    const user = userEvent.setup();
    form();
    await user.click(screen.getByRole('button', { name: 'Select this page' }));
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
    const { container } = form({ stale: staleOf(['e1', 'e3']) });
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

  it('b372e923 — posts the Payroll Process list’s filter query back, so the redirect can re-attach it', () => {
    // The submit is a redirect, and a redirect builds a brand-new URL: anything this form does not post
    // is gone by the time the result table renders. That table draws a Payroll Result link per employee
    // and each one hands `from` on to the result screen, so without this field the whole chain — this
    // screen's Back, and every link on the result — falls back to an unfiltered list. The action's half
    // of the round trip is driven against a real run in
    // test/payroll-reprocess-result-link-b372e923.test.ts.
    const { container } = form({ from: '/payroll?year=2026&m=5&status=processed' });
    const el = container.querySelector('form') as HTMLFormElement;
    expect(new FormData(el).get('from')).toBe('/payroll?year=2026&m=5&status=processed');
  });

  it('b372e923 — and posts no `from` at all when the operator arrived without filters', () => {
    // An unfiltered visit must keep a clean URL rather than pinning a bare list onto every link.
    for (const over of [{}, { from: null }, { from: '' }]) {
      const { container } = form(over);
      const el = container.querySelector('form') as HTMLFormElement;
      expect(new FormData(el).has('from'), `posted a from for ${JSON.stringify(over)}`).toBe(false);
    }
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
/** a1a80747 — the same person as a New row of the one Reprocess Required list. */
const added = (over: Partial<ReprocessAddCandidate> & { employmentId: string }): ReprocessRequiredRow => ({ kind: 'added', ...add(over) });

describe('fbcf706d — people eligible for the month with no payslip on the run', () => {
  it('is not rendered at all when nobody is waiting — the screen is exactly what it was', () => {
    const { container } = form({ required: [] });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(container.querySelectorAll('table'), 'no Reprocess Required list without anyone on it').toHaveLength(1);
  });

  it('lists them above the people already paid, ready-ticked, with the reason on the row', () => {
    const { container } = form({ required: [added({ employmentId: 'n1' })] });
    const tables = [...container.querySelectorAll('table')];
    // ORDER IS THE POINT: the finding goes above the list you already knew about.
    expect(tables[0]!.textContent).toContain('Siti Aminah');
    expect(tables[1]!.textContent).toContain('John Tan');
    // a1a80747 — a New row of the one Reprocess Required list, labelled as such.
    expect(within(tables[0] as HTMLElement).getByText('New')).toBeInTheDocument();
    expect(tables[0]!.textContent).toContain('Eligible for this month and has no payslip on this run.');
    // Being on this list is itself the finding, so paying them is one press.
    const box = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(box.checked, 'the waiting employee arrived unticked').toBe(true);
    expect(box.value).toBe('n1');
    expect(screen.getByText('1 of 4 selected')).toBeInTheDocument();
  });

  it('somebody the run’s chosen list does not cover arrives UNTICKED, and the row says why', () => {
    form({ required: [added({ employmentId: 'n1', outsideScope: true })] });
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false);
    expect(
      screen.getByText(/This run was set up for a chosen list of people and this person is not on it/),
    ).toBeInTheDocument();
  });

  it('somebody whose record cannot be paid yet is named and CANNOT be ticked', () => {
    form({ required: [added({ employmentId: 'n1', blockers: ['missingCompensation'], warnings: ['missingBank'] })] });
    const box = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled, 'a blocked employee could still be submitted').toBe(true);
    expect(screen.getByText(/Cannot be paid yet — no salary record/)).toBeInTheDocument();
  });

  it('a warning-only gap is stated but never prevents the add', () => {
    form({ required: [added({ employmentId: 'n1', warnings: ['missingStatutory', 'missingBank'] })] });
    const box = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/Also missing: statutory details, bank details/)).toBeInTheDocument();
  });

  it('the review restates the addition separately from the recalculation', async () => {
    const user = userEvent.setup();
    form({ required: [added({ employmentId: 'n1' })] });
    await user.click(screen.getAllByRole('checkbox')[1]!); // John Tan, already paid
    const review = screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).toContain('2 of 4 employee(s)');
    // "The other N payslips are not touched" counts PAYSLIPS — an addition has none to leave alone.
    expect(review.textContent).toContain('The other 2 payslip(s) are not touched');
    expect(review.textContent).toContain('1 of them are being added to this run for the first time');
  });

  it('posts the additions alongside the recalculations, in one id list', () => {
    const { container } = form({ required: [added({ employmentId: 'n1' })], stale: staleOf(['e3']) });
    const data = new FormData(container.querySelector('form') as HTMLFormElement);
    expect(data.getAll('employmentIds').sort()).toEqual(['e3', 'n1']);
  });

  it('the one list says Status and Why; the payslip list keeps Status and Reason', () => {
    const { container } = form({ required: [added({ employmentId: 'n1' })] });
    const [one, paid] = [...container.querySelectorAll('table')];
    expect(one!.querySelector('thead')!.textContent).toContain('Status');
    expect(one!.querySelector('thead')!.textContent).toContain('Why');
    expect(paid!.querySelector('thead')!.textContent).toContain('Status');
    expect(paid!.querySelector('thead')!.textContent).toContain('Reason');
    expect(paid!.textContent).toContain('Already paid on this run');
  });
});

/**
 * 65e2d5de — SEARCH EMPLOYEE, and the trap that comes with it.
 *
 * The request is small ("the Reprocess screen currently does not provide an employee search"), but the
 * defect it invites is not, and 9066bd6c already paid for it once on the sibling Remove screen: the table
 * body renders the FILTERED rows, so a ticked row the search hides is unmounted and its
 * `<input type="checkbox" name="employmentIds">` leaves the DOM — while the count, the review list and the
 * button label are all computed from the UNFILTERED lists and keep naming that person. The screen goes on
 * agreeing with itself while submitting a smaller set. On a reprocess that means somebody's pay is not
 * recalculated and nothing says so.
 *
 * So these cases assert `new FormData(form)` — exactly what `requestSubmit()` serialises, the mounted
 * controls and nothing else — rather than spying on the action. It is a contract between the review block
 * and the form, and a unit test of either half alone passes throughout.
 */
const posted = (container: HTMLElement): string[] =>
  new FormData(container.querySelector('form') as HTMLFormElement).getAll('employmentIds').map(String);

describe('65e2d5de — the submitted set IS the reviewed set, filtered or not', () => {
  it('filters BOTH groups on employee ID or name, partially and case-insensitively', async () => {
    const user = userEvent.setup();
    const { container } = form({ required: [added({ employmentId: 'n1' }), added({ employmentId: 'n2', employeeCode: 'A0002', name: 'Raj Perumal' })] });
    const search = screen.getByRole('searchbox');

    // A name fragment, lower case against a capitalised name — and it reaches the Reprocess Required list as
    // well as the people already paid. Filtering one table and not the other would answer "where is Raj?"
    // with a row on one list and silence on the other.
    await user.type(search, 'raj');
    const tables = [...container.querySelectorAll('table')];
    expect(tables[0]!.textContent).toContain('Raj Perumal');
    expect(tables[0]!.textContent).not.toContain('Siti Aminah');
    expect(tables[1]!.textContent).toContain('Raj Kumar');
    expect(tables[1]!.textContent).not.toContain('John Tan');

    // …and the employee ID, partially. T100002 is Alice Lim, on the second table (the first is the
    // Reprocess Required list, which is still rendered — with its own "no matches" row).
    await user.clear(search);
    await user.type(search, '00002');
    const paid = container.querySelectorAll('table')[1]!;
    expect(paid.textContent).toContain('Alice Lim');
    expect(paid.textContent).not.toContain('Raj Kumar');
  });

  it('a ticked employee the search box has since hidden is STILL submitted', async () => {
    const user = userEvent.setup();
    const { container } = form();
    await user.click(boxes()[0]!); // John Tan
    await user.click(boxes()[1]!); // Alice Lim
    await user.click(boxes()[2]!); // Raj Kumar
    expect(posted(container).sort()).toEqual(['e1', 'e2', 'e3']);

    await user.type(screen.getByRole('searchbox'), 'Alice');
    // The table really has filtered — the condition that would otherwise drop the other two.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(posted(container).sort()).toEqual(['e1', 'e2', 'e3']);
    // Not twice: the visible row's checkbox and the hidden inputs are disjoint by construction.
    expect(posted(container)).toHaveLength(3);
  });

  it('an ADDITION hidden by the search is carried too — the hidden inputs span both groups', async () => {
    const user = userEvent.setup();
    const { container } = form({ required: [added({ employmentId: 'n1' })] });
    // n1 arrives ticked (it is the finding), and 'Alice' hides its ROW.
    expect(posted(container)).toEqual(['n1']);
    await user.type(screen.getByRole('searchbox'), 'Alice');
    expect(container.querySelectorAll('table')[0]!.textContent).not.toContain('Siti Aminah');
    // She is still NAMED in the review — which is exactly why hiding her row may not drop her — and her
    // id is still posted, off a hidden input rather than a checkbox that no longer exists.
    expect(screen.getByText(/Before you submit/).closest('div')!.textContent).toContain('Siti Aminah');
    expect(posted(container)).toEqual(['n1']);
  });

  it('while a pick is hidden, the count, the review list and the button all still name it', async () => {
    const user = userEvent.setup();
    const { container } = form();
    await user.click(boxes()[0]!);
    await user.click(boxes()[2]!);
    await user.type(screen.getByRole('searchbox'), 'Alice');

    expect(screen.getByText('2 of 3 selected')).toBeInTheDocument();
    expect(submit().textContent).toContain('2');
    const review = screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).toContain('John Tan');
    expect(review.textContent).toContain('Raj Kumar');
    expect(posted(container)).toHaveLength(2);
  });

  it('un-ticking a row that is back in view removes it — the hidden inputs are not sticky', async () => {
    const user = userEvent.setup();
    const { container } = form();
    await user.click(boxes()[0]!);
    await user.click(boxes()[1]!);
    const search = screen.getByRole('searchbox');
    await user.type(search, 'John');
    expect(posted(container).sort()).toEqual(['e1', 'e2']);
    await user.clear(search);
    await user.click(screen.getByRole('checkbox', { name: /Alice Lim/ }));
    expect(posted(container)).toEqual(['e1']);
  });

  it('a search that matches nobody says so — it does not claim the run is empty', async () => {
    // An empty RUN and an empty SEARCH RESULT are different facts. "No employees on this run" to somebody
    // who has just typed a name is a false statement about the payroll run.
    const user = userEvent.setup();
    const { container } = form();
    await user.click(boxes()[0]!);
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(container.textContent).toContain('No employee matches your search.');
    expect(container.textContent).not.toContain('No employees on this run.');
    // …and the selection made before the search is still on its way to the server.
    expect(posted(container)).toEqual(['e1']);
  });

  it('Select all under a search takes what is ON SCREEN, and every id it leaves ticked is posted', async () => {
    const user = userEvent.setup();
    const { container } = form();
    await user.type(screen.getByRole('searchbox'), 'Lim');
    await user.click(screen.getByRole('button', { name: 'Select this page' }));
    // Narrower than the word "all" — deliberately, and matching the Remove screen. The count and the
    // button move with it, so the operator is never told more than is happening.
    expect(posted(container)).toEqual(['e2']);
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();
    // Clearing the search brings the other rows back UNTICKED, and the posted set does not grow.
    await user.clear(screen.getByRole('searchbox'));
    expect(posted(container)).toEqual(['e2']);
  });

  it('no search and nothing ticked ⇒ no hidden inputs at all', () => {
    const { container } = form();
    expect(posted(container)).toEqual([]);
    expect(container.querySelectorAll('input[type="hidden"][name="employmentIds"]')).toHaveLength(0);
  });

  it('finds an Employee ID typed the way it is SPOKEN — the shared rule folds the separators', async () => {
    // The ask is "search by Employee ID", and nobody says "E, M, P, hyphen, zero…". The shared
    // `matchesEmployeeSearch` folds `[\s._-]` out of both sides, which is why the Personnel switcher, the
    // Payroll Process wizard's Step-2 picker, Transaction Detail and Individual Payslip all answer
    // "emp0008" with EMP-0008. A local `.toLowerCase().includes()` — the predicate the sibling Remove
    // screen still carries — answers it with an empty table, on the screen whose whole request was this.
    const user = userEvent.setup();
    const { container } = form({
      employees: [
        emp({ employmentId: 'e8', employeeCode: 'EMP-0008', name: 'Nurul Huda' }),
        emp({ employmentId: 'e9', employeeCode: 'EMP-0009', name: 'Chan Wei Ming' }),
      ],
    });
    const search = screen.getByRole('searchbox');

    await user.type(search, 'emp0008');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container.textContent).toContain('Nurul Huda');
    expect(container.textContent).not.toContain('Chan Wei Ming');

    // The written form still works, and so does a partial one — the fold widens the rule, it never
    // narrows it.
    await user.clear(search);
    await user.type(search, 'EMP-0009');
    expect(container.textContent).toContain('Chan Wei Ming');
    await user.clear(search);
    await user.type(search, '0008');
    expect(container.textContent).toContain('Nurul Huda');
  });
});

/**
 * 65e2d5de — ENTER IN THE SEARCH BOX MUST NOT RUN THE PAYROLL.
 *
 * This is a keystroke test rather than a shape test because the defect is a keystroke, and no other test
 * on this screen can see it: every case above types into the search box and then reads `new FormData(form)`,
 * which is a snapshot of the DOM, not a submit.
 *
 * The mechanism is plain HTML. Pressing Enter in a text-type field inside a form performs IMPLICIT
 * SUBMISSION — the browser clicks that form's default (first) submit button. Until this round the form had
 * no such field: hidden inputs, checkboxes and one `<textarea>` (where Enter inserts a newline). The Search
 * Employee box is the first blocking field on it, the default submit button is "Reprocess N employee(s)",
 * and the selection is NON-EMPTY on arrival by design — so the button is live, and the fastest way to
 * enqueue a payroll recalculation on the wrong people would have been to type a name and press Enter.
 * There is no confirmation dialog in front of it (the review block is inside this same form, by design).
 *
 * `@testing-library/user-event` implements implicit submission faithfully — its `keypress` behaviour
 * dispatches a click on `button[type="submit"]` — and skips it when the keydown was default-prevented,
 * exactly as a browser does. So these two cases are a real test of the guard, and the last one is the
 * control that proves the harness can see a submit at all.
 */
describe('65e2d5de — Enter cannot submit this form', () => {
  const submitSpy = (container: HTMLElement) => {
    const spy = vi.fn();
    (container.querySelector('form') as HTMLFormElement).addEventListener('submit', spy);
    return spy;
  };

  it('the search box is inside the reprocess form and the submit is live on arrival', async () => {
    // Both halves matter. Outside the form, Enter would be harmless; with an empty selection the button
    // would be disabled and the click would do nothing. Neither is true here — the `stale` rows are the
    // employments the run itself marked stale, and they arrive ticked (a1a80747: with no tax check before it).
    const { container } = form({ stale: staleOf(['e1', 'e3']) });
    expect(screen.getByRole('searchbox').closest('form')).toBe(container.querySelector('form'));
    expect(submit()).toBeEnabled();
  });

  it('typing a name and pressing Enter filters the list and submits NOTHING', async () => {
    const user = userEvent.setup();
    vi.mocked(reprocessSelectedAction).mockClear();
    const { container } = form({ stale: staleOf(['e1', 'e3']), required: [added({ employmentId: 'n1' })] });
    const spy = submitSpy(container);

    await user.type(screen.getByRole('searchbox'), 'Alice{Enter}');

    expect(spy, 'Enter in the search box submitted the reprocess form').not.toHaveBeenCalled();
    expect(reprocessSelectedAction, 'Enter enqueued a payroll recalculation').not.toHaveBeenCalled();
    // …and the search itself still did its job, which is the only thing Enter is allowed to have changed.
    expect(container.querySelectorAll('table')[1]!.textContent).toContain('Alice Lim');
    expect(container.querySelectorAll('table')[1]!.textContent).not.toContain('John Tan');
    // The three people who would have been reprocessed are still merely ticked.
    expect(posted(container).sort()).toEqual(['e1', 'e3', 'n1']);
  });

  it('Enter on a ticked checkbox does not submit either — the guard is on the form, not the box', async () => {
    const user = userEvent.setup();
    const { container } = form({ stale: staleOf(['e1']) });
    const spy = submitSpy(container);
    const box = boxes()[0]!;
    box.focus();
    await user.keyboard('{Enter}');
    expect(spy).not.toHaveBeenCalled();
  });

  it('CONTROL — clicking the submit button still submits, so the cases above are not vacuous', async () => {
    const user = userEvent.setup();
    const { container } = form({ stale: staleOf(['e1']) });
    const spy = submitSpy(container);
    await user.click(submit());
    expect(spy, 'the harness cannot see a submit at all — the guard cases prove nothing').toHaveBeenCalledTimes(1);
  });
});

/**
 * c3258a72 — EMPLOYEES WITH NOTHING TO PAY ARE "SKIPPED", NOT "NEW / PENDING".
 *
 * Before this, a no-monthly-basic employee with nothing payable sat in the amber New / Pending group (now the New
 * rows of the one Reprocess Required list, a1a80747),
 * pre-ticked, so every reprocess tried them again, skipped them again, and left them looking pending. The
 * server now states the run's decision on the row (`skip`); these cases pin what the screen does with it.
 */
describe('c3258a72 / a1a80747 — the Nothing payable group', () => {
  // The one list is named by its label; the Nothing payable group by its caption.
  const tableWith = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll('table')].find((tb) => tb.getAttribute('aria-label') === text
      || tb.querySelector('caption')?.textContent?.includes(text)) as
      | HTMLTableElement
      | undefined;
  const skipRow = added({ employmentId: 's1', employeeCode: 'D0001', name: 'Dato Lim', warnings: ['nothingPayable'], skip: 'NOTHING_PAYABLE_THIS_PERIOD' });
  const pendingRow = added({ employmentId: 'n1' });

  it('a skip row goes to its own Nothing payable group with the reporter’s sentence, not into Reprocess Required', () => {
    const { container } = form({ required: [pendingRow, skipRow] });
    const pending = tableWith(container, 'Reprocess Required')!;
    const skipped = tableWith(container, 'Nothing payable')!;
    expect(pending, 'Reprocess Required list').toBeTruthy();
    expect(skipped, 'Nothing payable group').toBeTruthy();
    expect(pending.textContent).toContain('Siti Aminah');
    expect(pending.textContent).not.toContain('Dato Lim');
    expect(skipped.textContent).toContain('Dato Lim');
    expect(skipped.textContent).toContain('No monthly basic salary and nothing was payable this month.');
    expect(skipped.querySelector('tbody')!.textContent).not.toContain('New');
    // Neither "deliberately left out" nor an "Also missing" gap: nothing is missing.
    expect(container.textContent).not.toContain('Deliberately left out');
    expect(container.textContent).not.toContain('Also missing');
    // Order: pending finding first, then the completed skips, then the people already paid.
    const tables = [...container.querySelectorAll('table')];
    expect(tables.indexOf(pending)).toBeLessThan(tables.indexOf(skipped));
    expect(tables[tables.length - 1]!.textContent).toContain('John Tan');
  });

  it('is NOT mixed into Reprocess Required: the list holds only the pending row, the group counts the skip', () => {
    const { container } = form({ required: [pendingRow, skipRow] });
    expect(tableWith(container, 'Reprocess Required')!.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(tableWith(container, 'Nothing payable')!.querySelector('caption')!.textContent).toContain('Nothing payable — 1 employee(s) on this page');
  });

  it('arrives UNTICKED while the pending row is pre-ticked; the total still spans every group', () => {
    const { container } = form({ required: [pendingRow, skipRow] });
    const data = new FormData(container.querySelector('form') as HTMLFormElement);
    expect(data.getAll('employmentIds')).toEqual(['n1']);
    const box = boxes().find((b) => b.value === 's1')!;
    expect(box.checked).toBe(false);
    expect(box.disabled, 'a skip is never un-tickable').toBe(false);
    expect(screen.getByText('1 of 5 selected')).toBeInTheDocument();
  });

  it('only skipped people waiting ⇒ Reprocess Required says nobody needs it, and nothing is pre-ticked', () => {
    const { container } = form({ required: [skipRow] });
    expect(tableWith(container, 'Reprocess Required')!.textContent).toContain('Nobody on this run needs reprocessing.');
    expect(tableWith(container, 'Nothing payable')).toBeTruthy();
    expect(submit()).toBeDisabled();
  });

  it('can still be ticked by hand, and is then reviewed and posted as an addition', async () => {
    const user = userEvent.setup();
    const { container } = form({ required: [skipRow] });
    await user.click(boxes().find((b) => b.value === 's1')!);
    const review = screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).toContain('Dato Lim');
    expect(review.textContent).toContain('1 of them are being added to this run for the first time');
    expect(submit()).toBeEnabled();
    const data = new FormData(container.querySelector('form') as HTMLFormElement);
    expect(data.getAll('employmentIds')).toEqual(['s1']);
  });

  it('a deduction-only skip carries its own sentence', () => {
    const { container } = form({
      required: [added({ employmentId: 's2', name: 'Loan Lee', warnings: ['nothingPayable'], skip: 'DEDUCTION_ONLY_THIS_PERIOD' })],
    });
    const skipped = tableWith(container, 'Nothing payable')!;
    expect(skipped.textContent).toContain(messages.payroll.batch.skipped.reason.DEDUCTION_ONLY_THIS_PERIOD);
    expect(skipped.textContent).not.toContain('No monthly basic salary and nothing was payable this month.');
  });

  it('a no-basic row the server did NOT skip (money keyed since) is a plain New row, ticked', () => {
    const { container } = form({ required: [added({ employmentId: 'f1', name: 'Fee Fong', warnings: ['nothingPayable'], skip: null })] });
    expect(tableWith(container, 'Nothing payable')).toBeUndefined();
    const pending = tableWith(container, 'Reprocess Required')!;
    expect(pending.textContent).toContain('Eligible for this month and has no payslip on this run.');
    expect(boxes().find((b) => b.value === 'f1')!.checked).toBe(true);
  });

  it('search filters the Nothing payable group too, and says so when it hides every skipped row', async () => {
    const user = userEvent.setup();
    const { container } = form({ required: [pendingRow, skipRow] });
    await user.type(screen.getByPlaceholderText('Search by employee ID or name'), 'D0001');
    expect(tableWith(container, 'Nothing payable')!.textContent).toContain('Dato Lim');
    expect(tableWith(container, 'Reprocess Required')!.textContent).toContain('No employee matches your search.');
    await user.clear(screen.getByPlaceholderText('Search by employee ID or name'));
    await user.type(screen.getByPlaceholderText('Search by employee ID or name'), 'Siti');
    expect(tableWith(container, 'Nothing payable')!.textContent).toContain('No employee matches your search.');
  });
});


/**
 * 6aee208b — "Reprocess Required" selection across pages. The reporter approved: everybody the run marked
 * stale arrives ticked on EVERY page (this settles the 17 November open assumption that only the first page
 * was ticked); ready New rows keep the first-page rule; Processed / No Change rows are never seeded;
 * Select this page ADDS; Clear empties; the ticks survive page, size, search and tab changes (all of which
 * are re-renders of this same mounted form); the review names at most 20 people, then "and N more".
 */
describe('6aee208b — server-paged Reprocess defaults and selection', () => {
  const addition=(id:string):ReprocessAddCandidate=>({employmentId:id,employeeCode:id,name:'New '+id,hiredOn:'2026-01-01',outsideScope:false,blockers:[],warnings:[]});
  /** A fictional run of 30 payslips: the first 27 (s00..s26) are stale, the last 3 (u0..u2) did not change. */
  const STALE=Array.from({length:27},(_,i)=>emp({employmentId:'s'+String(i).padStart(2,'0'),employeeCode:'S'+String(i).padStart(4,'0'),name:'Stale person '+String(i).padStart(2,'0'),stale:true}));
  const UNCHANGED=Array.from({length:3},(_,i)=>emp({employmentId:'u'+i,employeeCode:'U000'+i,name:'Unchanged person '+i}));
  const staleSet={rows:STALE.map(({employmentId,employeeCode,name})=>({employmentId,employeeCode,name})),withoutPayslip:0};
  type View={rows:ReprocessCandidate[];total:number;page:number;size?:string;tab:'required'|'unchanged';search?:string;newCandidates?:ReprocessAddCandidate[];stale?:typeof staleSet};
  /** a1a80747 — the Reprocess Required tab is the one list (its New rows first here, then the Changed ones); the
   * Processed / No Change tab is the payslip list with its money. */
  const requiredOf=(v:View):ReprocessRequiredRow[]=>v.tab!=='required'?[]:[
    ...(v.newCandidates??[]).map(c=>({kind:'added' as const,...c})),
    ...v.rows.map(r=>({kind:'recalculated' as const,employmentId:r.employmentId,employeeCode:r.employeeCode,name:r.name})),
  ];
  const view=(v:View)=>(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReprocessForm key="selection" batchId="b1" employees={v.tab==='unchanged'?v.rows:[]} required={requiredOf(v)} currency="MYR" stale={v.stale??staleSet}
        paging={{existing:pageState(parsePageQuery({page:String(v.page),size:v.size}),v.total,v.rows.length),
          runTotal:30+(v.newCandidates??[]).length,existingTotal:30,search:v.search??'',
          tabs:{current:v.tab,counts:{required:27,unchanged:3},hrefs:{required:'/payroll/b1/reprocess?tab=required',unchanged:'/payroll/b1/reprocess?tab=unchanged'}}}} />
    </NextIntlClientProvider>
  );
  const firstPage:View={rows:STALE.slice(0,25),total:27,page:0,tab:'required'};
  const key=(container:HTMLElement)=>new FormData(container.querySelector('form')!).get('idempotencyKey');

  it('posts every stale employee on arrival — including the two on page 2 — and seeds nobody else', () => {
    const {container}=render(view({...firstPage,newCandidates:[addition('n1'),{...addition('blocked'),blockers:['missingCompensation']},{...addition('skipped'),skip:'NOTHING_PAYABLE_THIS_PERIOD'}]}));
    const ids=posted(container);
    expect(ids).toHaveLength(28);
    expect(new Set(ids).size,'an employee was posted twice').toBe(28);
    expect(ids.sort()).toEqual([...STALE.map(e=>e.employmentId),'n1'].sort());
    // The two stale people beyond the first page are in the submitted set although no row for them is mounted.
    expect(ids).toContain('s25');expect(ids).toContain('s26');
    expect(container.querySelector('input[type="checkbox"][value="s26"]')).toBeNull();
    // Processed / No Change, Skipped and not-ready additions are never ticked for you.
    for(const id of ['u0','u1','u2','blocked','skipped'])expect(ids).not.toContain(id);
    expect(screen.getByRole('status').textContent).toContain('All 27 employee(s) needing reprocess are selected, across 2 page(s).');
    expect(screen.getByRole('status').textContent).toContain('1 other employee(s) are also ticked.');
  });

  it('the tabs carry their own counts and addresses, and the current one is marked', () => {
    render(view(firstPage));
    const tabs=screen.getByRole('navigation',{name:'Employees on this run'});
    const required=within(tabs).getByRole('link',{name:/Reprocess Required/});
    const unchanged=within(tabs).getByRole('link',{name:/Processed \/ No Change/});
    expect(required.textContent).toContain('27');expect(unchanged.textContent).toContain('3');
    expect(required.getAttribute('aria-current')).toBe('page');expect(unchanged.getAttribute('aria-current')).toBeNull();
    expect(unchanged.getAttribute('href')).toBe('/payroll/b1/reprocess?tab=unchanged');
    // Rows on the Reprocess Required tab carry the Changed label and say why.
    const row=document.body.querySelector('tbody tr')!;
    expect(row.textContent).toContain('Changed');
    expect(row.textContent).toContain('changed after the run was processed');
  });

  it('an untick survives page, rows-per-page, tab and search changes; the token never changes', async () => {
    const user=userEvent.setup();
    const {container,rerender}=render(view(firstPage));
    const initialKey=key(container);expect(initialKey).toBeTruthy();
    await user.click(container.querySelector<HTMLInputElement>('input[type="checkbox"][value="s03"]')!);
    expect(posted(container)).not.toContain('s03');
    expect(screen.getByRole('status').textContent).toContain('26 of 27 employee(s) needing reprocess are selected, across 2 page(s).');
    // Page 2 of the same tab.
    rerender(view({rows:STALE.slice(25),total:27,page:1,tab:'required'}));
    expect(posted(container)).toHaveLength(26);expect(posted(container)).not.toContain('s03');
    // 50 rows per page: one page.
    rerender(view({rows:STALE,total:27,page:0,size:'50',tab:'required'}));
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"][value="s03"]')!.checked).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('across 1 page(s)');
    // The other tab: its rows arrive unticked, and the stale ticks are still posted.
    rerender(view({rows:UNCHANGED,total:3,page:0,tab:'unchanged'}));
    expect(boxes().every(b=>!b.checked)).toBe(true);
    expect(posted(container)).toHaveLength(26);
    // A search inside the tab.
    rerender(view({rows:STALE.slice(3,4),total:1,page:0,tab:'required',search:'Stale person 03'}));
    expect(boxes()[0]!.checked).toBe(false);
    expect(posted(container)).toHaveLength(26);
    expect(key(container)).toBe(initialKey);
  });

  it('Select this page ADDS the rows shown; Select all again restores the stale set; Clear empties everything', async () => {
    const user=userEvent.setup();
    const {container,rerender}=render(view(firstPage));
    await user.click(screen.getByRole('button',{name:'Clear selection'}));
    expect(posted(container)).toEqual([]);
    await user.click(screen.getByRole('button',{name:'Select all 27 again'}));
    expect(posted(container)).toHaveLength(27);
    // Untick one, then add the Processed / No Change page by hand: everything already ticked stays.
    await user.click(container.querySelector<HTMLInputElement>('input[type="checkbox"][value="s00"]')!);
    rerender(view({rows:UNCHANGED,total:3,page:0,tab:'unchanged'}));
    await user.click(screen.getByRole('button',{name:'Select this page'}));
    const ids=posted(container);
    expect(ids).toHaveLength(29);
    expect(ids).not.toContain('s00');
    for(const id of ['u0','u1','u2','s01','s25','s26'])expect(ids).toContain(id);
    expect(screen.getByRole('status').textContent).toContain('26 of 27');
    expect(screen.getByRole('status').textContent).toContain('3 other employee(s) are also ticked.');
    await user.click(screen.getByRole('button',{name:'Clear'}));
    expect(posted(container)).toEqual([]);
    expect(screen.queryByRole('button',{name:'Clear selection'})).not.toBeInTheDocument();
  });

  it('the review is capped at 20 names, then "and N more", and names who was left out', async () => {
    const user=userEvent.setup();
    const {container}=render(view(firstPage));
    await user.click(container.querySelector<HTMLInputElement>('input[type="checkbox"][value="s03"]')!);
    const review=screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).toContain('you are about to reprocess 26 of 30 employee(s)');
    expect(within(review).getAllByText(/^Stale person \d\d$/)).toHaveLength(20);
    expect(review.textContent).toContain('and 6 more');
    expect(review.textContent).toContain('The other 4 payslip(s) are not touched');
    expect(review.textContent).toContain('1 employee(s) needing reprocess are not ticked');
    // The submit still covers everyone ticked, not just the names shown.
    expect(posted(container)).toHaveLength(26);
    expect(posted(container)).toEqual(expect.arrayContaining(['s26','s25']));
    expect(submit().textContent).toContain('26');
  });

  it('a stale person with no payslip is stated separately, so the total reconciles with Payroll Process', () => {
    render(view({...firstPage,stale:{...staleSet,withoutPayslip:2}}));
    const line=screen.getByRole('status').textContent!;
    expect(line).toContain('All 27 employee(s) needing reprocess are selected');
    expect(line).toContain('2 more employee(s) needing reprocess have no payslip on this run yet; they are in this list as New.');
  });

  it('a person who becomes stale after arrival is counted, never silently ticked', () => {
    const {container,rerender}=render(view(firstPage));
    const later={employmentId:'late',employeeCode:'L0001',name:'Late change'};
    rerender(view({...firstPage,stale:{rows:[...staleSet.rows,later],withoutPayslip:0}}));
    expect(posted(container)).not.toContain('late');
    expect(screen.getByRole('status').textContent).toContain('27 of 28 employee(s) needing reprocess are selected');
  });

  it('an empty Reprocess Required tab says so instead of claiming the run is empty', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReprocessForm batchId="b1" employees={[]} currency="MYR" stale={{rows:[],withoutPayslip:0}}
          paging={{existing:pageState(parsePageQuery(),0,0),runTotal:3,existingTotal:3,search:'',
            tabs:{current:'required',counts:{required:0,unchanged:3},hrefs:{required:'?tab=required',unchanged:'?tab=unchanged'}}}} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Nobody on this run needs reprocessing.')).toBeInTheDocument();
    expect(screen.queryByText('No employees on this run.')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

/**
 * a1a80747 — ONE LIST, ONE BUTTON. Reprocess Required holds everyone who needs processing, each employee once, as a
 * New or a Changed row; there is no Check Tax Readiness step: the ticked employees are posted as they are, and the job
 * applies the tax readiness rules to each employee as it processes them.
 */
describe('a1a80747 — one Reprocess Required list, no tax readiness step', () => {
  const required: ReprocessRequiredRow[] = [
    { kind: 'recalculated', employmentId: 'c1', employeeCode: 'EMP0001', name: 'Sample A' },
    { kind: 'recalculated', employmentId: 'c2', employeeCode: 'EMP0002', name: 'Sample B' },
    added({ employmentId: 'n3', employeeCode: 'EMP0003', name: 'Sample C' }),
    added({ employmentId: 'n4', employeeCode: 'EMP0004', name: 'Sample D', outsideScope: true }),
    { kind: 'recalculated', employmentId: 'c5', employeeCode: 'EMP0005', name: 'Sample E' },
    added({ employmentId: 'b6', employeeCode: 'EMP0006', name: 'Sample F', blockers: ['missingCompensation'] }),
    added({ employmentId: 's7', employeeCode: 'EMP0007', name: 'Sample G', warnings: ['nothingPayable'], skip: 'NOTHING_PAYABLE_THIS_PERIOD' }),
  ];
  const stale = { rows: required.filter((r) => r.kind === 'recalculated').map(({ employmentId, employeeCode, name }) => ({ employmentId, employeeCode, name })), withoutPayslip: 0 };
  const paged = (tab: 'required' | 'unchanged') => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReprocessForm batchId="b1" employees={tab === 'unchanged' ? PEOPLE : []} required={tab === 'required' ? required : []} currency="MYR" stale={stale}
        paging={{existing:pageState(parsePageQuery(),6,6),runTotal:PEOPLE.length+4,existingTotal:PEOPLE.length,search:'',
          tabs:{current:tab,counts:{required:7,unchanged:3},hrefs:{required:'?tab=required',unchanged:'?tab=unchanged'}}}} />
    </NextIntlClientProvider>
  );

  it('renders every employee who needs processing ONCE, in the server order, labelled New or Changed', () => {
    const { container } = render(paged('required'));
    const list = screen.getByRole('table', { name: 'Reprocess Required' });
    const rows = [...list.querySelectorAll('tbody tr')] as HTMLElement[];
    // Six rows: the nothing-payable employee is not mixed in.
    expect(rows.map((r) => r.querySelector('input[type="checkbox"]')!.getAttribute('value'))).toEqual(['c1', 'c2', 'n3', 'n4', 'c5', 'b6']);
    expect(rows.map((r) => r.querySelectorAll('td')[1]!.textContent)).toEqual(['Changed', 'Changed', 'New', 'New', 'Changed', 'New']);
    expect(rows[0]!.textContent).toContain('Data used by this payslip changed after the run was processed.');
    expect(rows[2]!.textContent).toContain('Eligible for this month and has no payslip on this run.');
    // The New row states (outside the chosen list, not ready yet) are kept: unticked, and a not-ready row cannot be ticked.
    expect(rows[3]!.textContent).toContain('This run was set up for a chosen list of people');
    expect(rows[5]!.textContent).toContain('Cannot be paid yet — no salary record');
    expect((rows[5]!.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    // Each employee once, across the list and the Nothing payable group.
    const values = [...container.querySelectorAll('input[type="checkbox"]')].map((b) => (b as HTMLInputElement).value);
    expect(new Set(values).size).toBe(values.length);
    const nothing = [...container.querySelectorAll('table')].find((tb) => tb.querySelector('caption')?.textContent?.includes('Nothing payable'))!;
    expect(nothing.textContent).toContain('Sample G');
    // The payslip list is the other tab: not on this one.
    expect(container.textContent).not.toContain('Already paid on this run');
    // Ticked on arrival: the three Changed rows and the ready, in-scope New row; nobody else.
    expect(posted(container).sort()).toEqual(['c1', 'c2', 'c5', 'n3']);
  });

  it('has no Check Tax Readiness step: the ticked employees are posted as they are, and one button does the work', async () => {
    const user = userEvent.setup();
    vi.mocked(reprocessSelectedAction).mockClear();
    const { container } = render(paged('required'));
    expect(screen.queryByRole('button', { name: /Check tax readiness/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pending employees/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Tax readiness for this reprocess' })).not.toBeInTheDocument();
    expect(container.textContent).toContain('The tax-readiness check runs automatically when you press Reprocess.');
    const data = new FormData(container.querySelector('form')!);
    expect(data.getAll('employmentIds').sort()).toEqual(['c1', 'c2', 'c5', 'n3']);
    expect(data.has('heldEmploymentIds')).toBe(false);
    expect(data.has('previousReprocessJob')).toBe(false);
    expect(submit()).toBeEnabled();
    expect(submit().textContent).toBe('Reprocess 4 employee(s)');
    const spy = vi.fn();
    container.querySelector('form')!.addEventListener('submit', spy);
    await user.click(submit());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the Processed / No Change tab shows the payslips with their money and no Reprocess Required rows', () => {
    const { container } = render(paged('unchanged'));
    expect(screen.queryByRole('table', { name: 'Reprocess Required' })).not.toBeInTheDocument();
    expect(container.textContent).toContain('MYR 4,100.00');
    // The Changed rows stay ticked from arrival on the other tab.
    expect(posted(container).sort()).toEqual(['c1', 'c2', 'c5']);
  });
});

/**
 * a1a80747 r2 — THE TAB COUNTS AND PRE-TICKS EXACTLY WHO THE RUN OWES. The server marks each row `owed` from the rule
 * Close uses (core/payroll.ts `runOutstandingTx`), which is the number the Payroll Process list prints. Everyone else who
 * is eligible with no payslip here — outside a chosen-list run, removed on purpose, not paid by an additional run — is
 * in their own unticked Not owed on this run group, with the reason, and can still be ticked by hand. Nothing payable
 * stays its own group.
 */
describe('a1a80747 r2 — owed rows are the list; the rest are Not owed on this run', () => {
  const required: ReprocessRequiredRow[] = [
    { kind: 'recalculated', employmentId: 'c1', employeeCode: 'EMP0101', name: 'Owed Changed' },
    added({ employmentId: 'n2', employeeCode: 'EMP0102', name: 'Owed New', owed: true, notOwedReason: null }),
    // Held for income tax review on a chosen-list run, outside that list: still owed, so ticked.
    added({ employmentId: 'h3', employeeCode: 'EMP0103', name: 'Owed Held', owed: true, notOwedReason: null, outsideScope: true }),
    added({ employmentId: 'o4', employeeCode: 'EMP0104', name: 'Outside List', owed: false, notOwedReason: 'outsideScope', outsideScope: true }),
    added({ employmentId: 'r5', employeeCode: 'EMP0105', name: 'Removed One', owed: false, notOwedReason: 'removed' }),
    added({ employmentId: 'p6', employeeCode: 'EMP0106', name: 'Bonus Nonrecipient', owed: false, notOwedReason: 'notPaidByRun' }),
    added({ employmentId: 's7', employeeCode: 'EMP0107', name: 'Nothing Due', owed: false, notOwedReason: 'other', warnings: ['nothingPayable'], skip: 'NOTHING_PAYABLE_THIS_PERIOD' }),
  ];
  const stale = { rows: [{ employmentId: 'c1', employeeCode: 'EMP0101', name: 'Owed Changed' }], withoutPayslip: 0 };
  const paged = () => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReprocessForm batchId="b1" employees={[]} required={required} currency="MYR" stale={stale}
        paging={{existing:pageState(parsePageQuery(),7,7),runTotal:PEOPLE.length+6,existingTotal:PEOPLE.length,search:'',
          tabs:{current:'required',counts:{required:3,unchanged:3},hrefs:{required:'?tab=required',unchanged:'?tab=unchanged'}}}} />
    </NextIntlClientProvider>
  );
  const valuesOf = (table: Element) =>
    [...table.querySelectorAll('tbody tr input[type="checkbox"]')].map((b) => (b as HTMLInputElement).value);

  it('lists only the owed employees under Reprocess Required, with the tab count the server gave', () => {
    const { container } = render(paged());
    expect(valuesOf(screen.getByRole('table', { name: 'Reprocess Required' }))).toEqual(['c1', 'n2', 'h3']);
    const tab = screen.getByRole('link', { name: /Reprocess Required/ });
    expect(tab.textContent).toContain('3');
    // Pre-ticked: exactly the owed set.
    expect(posted(container).sort()).toEqual(['c1', 'h3', 'n2']);
  });

  it('puts everyone else in an unticked Not owed on this run group with the reason, still tickable by hand', async () => {
    const user = userEvent.setup();
    const { container } = render(paged());
    const group = [...container.querySelectorAll('table')].find((tb) => tb.querySelector('caption')?.textContent?.includes('Not owed on this run'))!;
    expect(group, 'the Not owed on this run group is rendered').toBeTruthy();
    expect(group.querySelector('caption')!.textContent).toBe('Not owed on this run — 3 employee(s) on this page');
    expect(valuesOf(group)).toEqual(['o4', 'r5', 'p6']);
    const rows = [...group.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(rows.map((r) => r.querySelectorAll('td')[1]!.textContent)).toEqual(['Not owed', 'Not owed', 'Not owed']);
    expect(rows[0]!.textContent).toContain('This run was set up for a chosen list of people');
    expect(rows[1]!.textContent).toContain('Removed from this run on purpose.');
    expect(rows[2]!.textContent).toContain('This run does not pay them.');
    expect(container.textContent).toContain('Not ticked and not counted in Reprocess Required');
    for (const box of group.querySelectorAll('input[type="checkbox"]')) {
      expect((box as HTMLInputElement).checked).toBe(false);
      expect((box as HTMLInputElement).disabled).toBe(false);
    }
    // The Nothing payable group is unchanged: the skipped employee is there, not in either list above.
    const nothing = [...container.querySelectorAll('table')].find((tb) => tb.querySelector('caption')?.textContent?.includes('Nothing payable'))!;
    expect(valuesOf(nothing)).toEqual(['s7']);
    // Ticking a Not owed row by hand adds exactly that person.
    await user.click(rows[0]!.querySelector('input[type="checkbox"]')!);
    expect(posted(container).sort()).toEqual(['c1', 'h3', 'n2', 'o4']);
  });
});

/**
 * a1a80747 r3 — THE SKIPPED TAB AND SELECT ALL, proved by rendering against the real en.json.
 *   - three tabs, each with its count; the Skipped tab holds employees skipped for income tax (New and Changed alike),
 *     nothing-payable and not-owed people, each with its reason, none ticked for the operator;
 *   - Select all adds the whole tab (server-read identities, off-page people included) ONCE per token: unticking
 *     somebody afterwards sticks across a re-render carrying the same token; a new token adds again;
 *   - more than the server reads at once ticks nobody and says so.
 */
describe('a1a80747 r3 — the Skipped tab and Select all', () => {
  const THREE = (current: 'required' | 'skipped' | 'unchanged') => ({
    current,
    counts: { required: 2, skipped: 4, unchanged: 3 },
    hrefs: { required: '?tab=required', skipped: '?tab=skipped', unchanged: '?tab=unchanged' },
  });
  const skippedRows: ReprocessRequiredRow[] = [
    { kind: 'recalculated', employmentId: 'k1', employeeCode: 'EMP0201', name: 'Changed Taxheld', taxSkipped: true },
    added({ employmentId: 'k2', employeeCode: 'EMP0202', name: 'New Taxheld', owed: true, notOwedReason: null, taxSkipped: true }),
    added({ employmentId: 'k3', employeeCode: 'EMP0203', name: 'Nothing Due', owed: false, notOwedReason: 'other', warnings: ['nothingPayable'], skip: 'NOTHING_PAYABLE_THIS_PERIOD' }),
    added({ employmentId: 'k4', employeeCode: 'EMP0204', name: 'Removed One', owed: false, notOwedReason: 'removed' }),
  ];
  const onSkipped = (over: Partial<Parameters<typeof ReprocessForm>[0]> = {}) => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReprocessForm key="selection" batchId="b1" employees={[]} required={skippedRows} currency="MYR"
        stale={{ rows: [], withoutPayslip: 0 }} taxReviewHref="/payroll/income-tax-recalculation?company=c1" heldHref="?tab=skipped&held=1"
        paging={{ existing: pageState(parsePageQuery(), 4, 4), runTotal: 9, existingTotal: 4, search: '', tabs: THREE('skipped') }} {...over} />
    </NextIntlClientProvider>
  );

  it('shows three tabs with their counts, and the Skipped tab its three groups with reasons, nobody ticked', () => {
    const { container } = render(onSkipped());
    const tabs = screen.getByRole('navigation', { name: 'Employees on this run' });
    const skipped = within(tabs).getByRole('link', { name: /Skipped/ });
    expect(skipped.textContent).toContain('4');
    expect(skipped.getAttribute('aria-current')).toBe('page');
    expect(within(tabs).getByRole('link', { name: /Reprocess Required/ }).textContent).toContain('2');
    const held = [...container.querySelectorAll('table')].find((tb) => tb.querySelector('caption')?.textContent?.includes('Held for income tax review'))!;
    expect(held, 'held group').toBeTruthy();
    expect(held.querySelector('caption')!.textContent).toContain('Held for income tax review — 2 employee(s)');
    expect(held.textContent).toContain('Changed Taxheld');
    expect(held.textContent).toContain('New Taxheld');
    expect(held.textContent).toContain('Skipped — income tax recalculation required.');
    expect(within(held).getAllByRole('link', { name: 'Open Income Tax Recalculation' })[0].getAttribute('href')).toBe('/payroll/income-tax-recalculation?company=c1');
    expect(within(held).getByRole('link', { name: 'Process held employees' }).getAttribute('href')).toBe('?tab=skipped&held=1');
    expect(container.textContent).toContain('Nothing payable');
    expect(container.textContent).toContain('Not owed on this run');
    expect(posted(container)).toEqual([]);
    // 7aaff171 — the Skipped tab carries the same selection bar as Reprocess Required (Select all needs the server's
    // whole-tab link, so it appears only when the page hands one over; see the 7aaff171 block below).
    expect(screen.getByRole('button', { name: 'Select this page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    expect(container.textContent).toContain('0 of 9 selected');
    expect(screen.queryByRole('link', { name: /^Select all/ })).toBeNull();
  });

  it('Process held employees ticks exactly the held people, off-page ones included', () => {
    const { container } = render(onSkipped({ focusIds: ['k1', 'k2', 'k9'], focusRows: [{ employmentId: 'k9', employeeCode: 'EMP0209', name: 'Offpage Taxheld' }] }));
    expect(posted(container).sort()).toEqual(['k1', 'k2', 'k9']);
  });

  it('on Reprocess Required, held people are never there and never ticked; the groups are not under the list', () => {
    const rows: ReprocessRequiredRow[] = [
      { kind: 'recalculated', employmentId: 'c1', employeeCode: 'EMP0101', name: 'Owed Changed' },
      added({ employmentId: 'n2', employeeCode: 'EMP0102', name: 'Owed New', owed: true, notOwedReason: null }),
    ];
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReprocessForm batchId="b1" employees={[]} required={rows} currency="MYR" stale={{ rows: [{ employmentId: 'c1', employeeCode: 'EMP0101', name: 'Owed Changed' }], withoutPayslip: 0 }}
          paging={{ existing: pageState(parsePageQuery(), 2, 2), runTotal: 9, existingTotal: 4, search: '', tabs: THREE('required') }} />
      </NextIntlClientProvider>,
    );
    expect(posted(container).sort()).toEqual(['c1', 'n2']);
    expect(container.textContent).not.toContain('Held for income tax review');
  });

  describe('Select all', () => {
    const ROWS = [
      { kind: 'recalculated' as const, employmentId: 'c1', employeeCode: 'EMP0101', name: 'Page One' },
    ];
    const everyone = Array.from({ length: 60 }, (_, i) => ({ employmentId: 'a' + String(i).padStart(2, '0'), employeeCode: 'A' + String(i).padStart(4, '0'), name: 'Person ' + i }));
    const withSelectAll = (applied: { token: string; rows: typeof everyone; tooMany: boolean; max: number } | null, search = '') => (
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReprocessForm key="selection" batchId="b1" employees={[]} required={ROWS} currency="MYR" stale={{ rows: [], withoutPayslip: 0 }}
          selectAll={{ total: 60, searching: search !== '', href: '?tab=required&selectAll=required.x', applied }}
          paging={{ existing: pageState(parsePageQuery({ size: '25' }), 60, 1), runTotal: 60, existingTotal: 0, search, tabs: THREE('required') }} />
      </NextIntlClientProvider>
    );

    it('offers "Select all 60 employees" (or "matching" under a search) as a link to the whole tab', () => {
      const { unmount } = render(withSelectAll(null));
      expect(screen.getByRole('link', { name: 'Select all 60 employees' }).getAttribute('href')).toBe('?tab=required&selectAll=required.x');
      unmount();
      render(withSelectAll(null, 'person'));
      expect(screen.getByRole('link', { name: 'Select all 60 matching employees' })).toBeTruthy();
    });

    it('adds the whole tab once per token, keeps an untick across a re-render with the same token, and adds again on a new one', async () => {
      const user = userEvent.setup();
      const { container, rerender } = render(withSelectAll({ token: 't1', rows: everyone, tooMany: false, max: 20000 }));
      expect(posted(container)).toHaveLength(60);
      expect(new Set(posted(container)).size).toBe(60);
      expect(container.textContent).toContain('60 of 60 selected');
      await user.click(screen.getByRole('button', { name: 'Clear' }));
      expect(posted(container)).toHaveLength(0);
      rerender(withSelectAll({ token: 't1', rows: everyone, tooMany: false, max: 20000 }));
      expect(posted(container), 'the same token never re-ticks').toHaveLength(0);
      rerender(withSelectAll({ token: 't2', rows: everyone, tooMany: false, max: 20000 }));
      expect(posted(container)).toHaveLength(60);
    });

    it('more than can be read at once ticks nobody and says so', () => {
      const { container } = render(withSelectAll({ token: 't3', rows: [], tooMany: true, max: 20000 }));
      expect(posted(container)).toEqual([]);
      expect(container.textContent).toMatch(/This tab has 60 employees, more than Select all can tick at once \(20,?000\)/);
    });
  });
});

/**
 * 8a3de8ae — AFTER A REPROCESS FINISHES, THE TICKS ARE WORKED OUT AGAIN FROM THE RUN. The page mounts this form under
 * the job's id while the job is queued or running, and under `<job id>:done` once it completes or stops; tab, page and
 * search changes keep the key. A partial job — two reprocessed (one recalculated, one added), one failed, one held for
 * income tax review — must leave exactly the failed one ticked, everywhere the selection is read: the tick boxes, the
 * hidden inputs, the count, the review and the button. The finished employees read Reprocessed on Processed / No Change.
 */
describe('8a3de8ae — the selection after a reprocess job ends', () => {
  const TABS = (current: 'required' | 'skipped' | 'unchanged') => ({
    current,
    counts: { required: 3, skipped: 1, unchanged: 4 },
    hrefs: { required: '?tab=required', skipped: '?tab=skipped', unchanged: '?tab=unchanged' },
  });
  const A = { employmentId: 'ja', employeeCode: 'EMP0301', name: 'Alpha Done' };
  const B = { employmentId: 'jb', employeeCode: 'EMP0302', name: 'Bravo Added' };
  const C = { employmentId: 'jc', employeeCode: 'EMP0303', name: 'Charlie Failed' };
  const D = { employmentId: 'jd', employeeCode: 'EMP0304', name: 'Delta Taxheld' };
  const E = { employmentId: 'je', employeeCode: 'EMP0305', name: 'Echo Paid' };
  const paging = (current: 'required' | 'skipped' | 'unchanged', rows: number) =>
    ({ existing: pageState(parsePageQuery(), rows, rows), runTotal: 6, existingTotal: 5, search: '', tabs: TABS(current) });
  /** While the job runs: A and C are stale (Changed), B is a ready New joiner the run owes; all three were submitted. */
  const running = (current: 'required' | 'unchanged') => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReprocessForm key="J" batchId="b1" currency="MYR" jobRunning
        employees={current === 'unchanged' ? [emp({ ...A, stale: true }), emp({ ...C, stale: true }), emp({ ...D }), emp({ ...E })] : []}
        required={current === 'required' ? [{ kind: 'recalculated', ...A }, { kind: 'recalculated', ...C },
          added({ ...B, owed: true, notOwedReason: null })] : []}
        stale={{ rows: [A, C], withoutPayslip: 0 }} paging={paging(current, current === 'unchanged' ? 4 : 3)} />
    </NextIntlClientProvider>
  );
  /** The run after the job: A recalculated (version 2), B added (version 1, named by the job's outcomes), C failed and
   * still stale, D skipped for income tax by the job's check, E untouched. */
  const finished = (current: 'required' | 'skipped' | 'unchanged', key = 'J:done', reprocessedNow: string[] = [A.employmentId, B.employmentId]) => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReprocessForm key={key} batchId="b1" currency="MYR" reprocessedNow={reprocessedNow}
        employees={current === 'unchanged' ? [emp({ ...A, reprocessedTimes: 1 }), emp({ ...B }), emp({ ...C, stale: true }), emp({ ...E })] : []}
        required={current === 'required' ? [{ kind: 'recalculated', ...C }]
          : current === 'skipped' ? [{ kind: 'recalculated', ...D, taxSkipped: true }] : []}
        stale={{ rows: [C], withoutPayslip: 0 }} paging={paging(current, current === 'unchanged' ? 4 : 1)} />
    </NextIntlClientProvider>
  );
  const statusOf = (container: HTMLElement, id: string) => {
    const row = container.querySelector(`input[type="checkbox"][value="${id}"]`)!.closest('tr') as HTMLElement;
    const cells = row.querySelectorAll('td');
    return { checked: (row.querySelector('input[type="checkbox"]') as HTMLInputElement).checked, status: cells[1]!.textContent, reason: cells[2]!.textContent };
  };

  it('while the job runs the submitted people stay ticked, across a tab change under the same key', () => {
    const { container, rerender } = render(running('required'));
    expect(posted(container).sort()).toEqual(['ja', 'jb', 'jc']);
    expect(submit().textContent).toContain('Reprocess 3 employee(s)');
    rerender(running('unchanged'));
    expect(posted(container).sort(), 'same key ⇒ same mount ⇒ same ticks').toEqual(['ja', 'jb', 'jc']);
  });

  it('when the job ends, only the failed employee is still ticked — boxes, hidden inputs, count, review and button agree', () => {
    const { container, rerender } = render(running('required'));
    rerender(running('unchanged'));
    expect(posted(container).sort()).toEqual(['ja', 'jb', 'jc']);
    rerender(finished('unchanged'));
    expect(posted(container)).toEqual(['jc']);
    expect(statusOf(container, 'ja').checked).toBe(false);
    expect(statusOf(container, 'jb').checked).toBe(false);
    expect(statusOf(container, 'jc').checked).toBe(true);
    expect(statusOf(container, 'je').checked).toBe(false);
    expect(container.textContent).toContain('1 of 6 selected');
    const review = screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).toContain('1 of 6 employee(s)');
    expect(review.textContent).toContain('Charlie Failed');
    expect(review.textContent).not.toContain('Alpha Done');
    expect(review.textContent).not.toContain('Bravo Added');
    expect(submit().textContent).toContain('Reprocess 1 employee(s)');
    expect(submit()).not.toBeDisabled();
  });

  it('Processed / No Change says Reprocessed for finished work, Reprocess Required for the failed one, Processed otherwise', () => {
    const { container } = render(finished('unchanged'));
    expect(statusOf(container, 'ja')).toMatchObject({ status: 'Reprocessed', reason: 'A new payroll result was saved for this employee.' });
    // Added by this job: version 1 on the payslip, named Reprocessed by the job's own outcomes.
    expect(statusOf(container, 'jb')).toMatchObject({ status: 'Reprocessed', reason: 'A new payroll result was saved for this employee.' });
    expect(statusOf(container, 'jc')).toMatchObject({ status: 'Reprocess Required' });
    expect(statusOf(container, 'je').status).toBe('Processed');
    expect(statusOf(container, 'je').reason).toContain('Already paid on this run');
  });

  it('the employee held for income tax review waits on Skipped, unticked; a tab change keeps the fresh ticks', () => {
    const { container, rerender } = render(running('required'));
    rerender(finished('required'));
    expect(posted(container)).toEqual(['jc']);
    rerender(finished('skipped'));
    expect(statusOf(container, 'jd')).toMatchObject({ checked: false, status: 'Skipped' });
    expect(posted(container)).toEqual(['jc']);
    // A late re-render of the finished job (the same key) changes nothing either.
    rerender(finished('skipped'));
    expect(posted(container)).toEqual(['jc']);
  });

  it('a reload after the job (no job outcomes to hand) still reads Reprocessed from the stored payslip and ticks only C', () => {
    const { container } = render(finished('unchanged', 'selection', []));
    expect(posted(container)).toEqual(['jc']);
    expect(statusOf(container, 'ja').status).toBe('Reprocessed');
    // B's payslip is at version 1 and no job is on screen: an ordinary processed payslip again.
    expect(statusOf(container, 'jb').status).toBe('Processed');
  });
});

/**
 * 7aaff171 — THE SKIPPED TAB GETS THE SAME SELECTION BAR AS REPROCESS REQUIRED: "N of M selected", Select this page,
 * Select all N employees and Clear. Select this page adds the rows shown in the three groups except a New row that is
 * not ready (its tick box is disabled); Select all adds the server's whole-tab answer once per token; more than the
 * server reads at once ticks nobody; the review says how many ticked people this run owes nothing.
 */
describe('7aaff171 — Select this page, Select all and Clear on the Skipped tab', () => {
  const TABS = {
    current: 'skipped' as const,
    counts: { required: 2, skipped: 7, unchanged: 4 },
    hrefs: { required: '?tab=required', skipped: '?tab=skipped', unchanged: '?tab=unchanged' },
  };
  const page: ReprocessRequiredRow[] = [
    { kind: 'recalculated', employmentId: 'k1', employeeCode: 'EMP0201', name: 'Changed Taxheld', taxSkipped: true },
    added({ employmentId: 'k2', employeeCode: 'EMP0202', name: 'New Taxheld', owed: true, notOwedReason: null, taxSkipped: true }),
    added({ employmentId: 'k3', employeeCode: 'EMP0203', name: 'Nothing Due', owed: false, notOwedReason: 'other', warnings: ['nothingPayable'], skip: 'NOTHING_PAYABLE_THIS_PERIOD' }),
    added({ employmentId: 'k4', employeeCode: 'EMP0204', name: 'Removed One', owed: false, notOwedReason: 'removed' }),
    // Not ready: their tick boxes are disabled, so neither Select this page nor Select all ticks them.
    added({ employmentId: 'k5', employeeCode: 'EMP0205', name: 'Unready Notowed', owed: false, notOwedReason: 'other', blockers: ['missingCompensation'] }),
    added({ employmentId: 'k6', employeeCode: 'EMP0206', name: 'Unready Taxheld', owed: true, notOwedReason: null, taxSkipped: true, blockers: ['missingCompensation'] }),
  ];
  /** The server's whole-tab answer (`reprocessSelectAll`, tab skipped): the page's tickable rows plus three off-page. */
  const wholeTab = [
    { employmentId: 'k1', employeeCode: 'EMP0201', name: 'Changed Taxheld' },
    { employmentId: 'k2', employeeCode: 'EMP0202', name: 'New Taxheld', added: true },
    { employmentId: 'k3', employeeCode: 'EMP0203', name: 'Nothing Due', added: true, notOwed: true },
    { employmentId: 'k4', employeeCode: 'EMP0204', name: 'Removed One', added: true, notOwed: true },
    { employmentId: 'x1', employeeCode: 'EMP0401', name: 'Offpage Notowed', added: true, notOwed: true },
    { employmentId: 'x2', employeeCode: 'EMP0402', name: 'Offpage Nothing', added: true, notOwed: true },
    { employmentId: 'x3', employeeCode: 'EMP0403', name: 'Offpage Taxheld', added: true },
  ];
  type Applied = { token: string; rows: typeof wholeTab; tooMany: boolean; max: number } | null;
  const skippedTab = (applied: Applied = null, total = 7, search = '') => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReprocessForm key="selection" batchId="b1" employees={[]} required={page} currency="MYR" stale={{ rows: [], withoutPayslip: 0 }}
        heldHref="?tab=skipped&held=1"
        selectAll={{ total, searching: search !== '', href: '?tab=skipped&selectAll=skipped.x', applied }}
        paging={{ existing: pageState(parsePageQuery({ size: '25' }), 7, 6), runTotal: 13, existingTotal: 4, search, tabs: TABS }} />
    </NextIntlClientProvider>
  );

  it('shows the same bar as Reprocess Required: count, Select this page, Select all 7 employees (or matching), Clear', () => {
    const { container, unmount } = render(skippedTab());
    expect(container.textContent).toContain('0 of 13 selected');
    expect(screen.getByRole('button', { name: 'Select this page' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Select all 7 employees' }).getAttribute('href')).toBe('?tab=skipped&selectAll=skipped.x');
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    // Process held employees stays as it was.
    expect(screen.getByRole('link', { name: 'Process held employees' }).getAttribute('href')).toBe('?tab=skipped&held=1');
    unmount();
    render(skippedTab(null, 3, 'removed'));
    expect(screen.getByRole('link', { name: 'Select all 3 matching employees' })).toBeTruthy();
  });

  it('Select this page ticks the rows of all three groups on screen, never a not-ready one; Clear removes every tick', async () => {
    const user = userEvent.setup();
    const { container } = render(skippedTab());
    await user.click(screen.getByRole('button', { name: 'Select this page' }));
    expect(posted(container).sort()).toEqual(['k1', 'k2', 'k3', 'k4']);
    for (const id of ['k5', 'k6']) {
      const box = container.querySelector(`input[type="checkbox"][value="${id}"]`) as HTMLInputElement;
      expect(box.disabled, id).toBe(true);
      expect(box.checked, id).toBe(false);
    }
    expect(container.textContent).toContain('4 of 13 selected');
    expect(submit().textContent).toContain('Reprocess 4 employee(s)');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(posted(container)).toEqual([]);
  });

  it('Select all adds the whole tab, off-page people included, once per token; an untick sticks; a new token adds again', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(skippedTab({ token: 's1', rows: wholeTab, tooMany: false, max: 20000 }));
    expect(posted(container).sort()).toEqual(['k1', 'k2', 'k3', 'k4', 'x1', 'x2', 'x3']);
    expect(new Set(posted(container)).size).toBe(7);
    expect(posted(container)).not.toContain('k5');
    expect(posted(container)).not.toContain('k6');
    expect(container.textContent).toContain('7 of 13 selected');
    await user.click(container.querySelector('input[type="checkbox"][value="k4"]') as HTMLInputElement);
    rerender(skippedTab({ token: 's1', rows: wholeTab, tooMany: false, max: 20000 }));
    expect(posted(container), 'the same token never re-ticks').not.toContain('k4');
    expect(posted(container)).toHaveLength(6);
    rerender(skippedTab({ token: 's2', rows: wholeTab, tooMany: false, max: 20000 }));
    expect(posted(container)).toHaveLength(7);
  });

  it('the review says how many ticked people this run owes nothing, and counts additions for off-page people too', () => {
    render(skippedTab({ token: 's3', rows: wholeTab, tooMany: false, max: 20000 }));
    const review = screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).toContain('7 of 13 employee(s)');
    // k3 and k4 on this page, x1 and x2 off it.
    expect(review.textContent).toContain('4 of them are not owed anything on this run. Reprocessing includes them as if you had ticked them one by one.');
    // Everyone but k1 has no payslip here; k1's is the only one touched of the 4.
    expect(review.textContent).toContain('6 of them are being added to this run for the first time');
    expect(review.textContent).toContain('The other 3 payslip(s) are not touched');
  });

  it('no not-owed line when nobody ticked is not owed', async () => {
    const user = userEvent.setup();
    const { container } = render(skippedTab());
    await user.click(container.querySelector('input[type="checkbox"][value="k1"]') as HTMLInputElement);
    const review = screen.getByText(/Before you submit/).closest('div') as HTMLElement;
    expect(review.textContent).not.toContain('not owed anything');
  });

  it('more than Select all reads at once ticks nobody and says so', () => {
    const { container } = render(skippedTab({ token: 's4', rows: [], tooMany: true, max: 20000 }, 25000));
    expect(posted(container)).toEqual([]);
    expect(container.textContent).toMatch(/This tab has 25,?000 employees, more than Select all can tick at once \(20,?000\)/);
  });
});
