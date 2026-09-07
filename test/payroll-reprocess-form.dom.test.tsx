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
// Imported so the Enter cases below can assert the recalculation was never enqueued — the same mock the
// form is rendered against, not a second one.
import { reprocessSelectedAction } from '../app/payroll/actions';

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
    const { container } = form({ newCandidates: [add({ employmentId: 'n1' }), add({ employmentId: 'n2', employeeCode: 'A0002', name: 'Raj Perumal' })] });
    const search = screen.getByRole('searchbox');

    // A name fragment, lower case against a capitalised name — and it reaches the New / Pending group as
    // well as the people already paid. Filtering one table and not the other would answer "where is Raj?"
    // with a row on one list and silence on the other.
    await user.type(search, 'raj');
    const tables = [...container.querySelectorAll('table')];
    expect(tables[0]!.textContent).toContain('Raj Perumal');
    expect(tables[0]!.textContent).not.toContain('Siti Aminah');
    expect(tables[1]!.textContent).toContain('Raj Kumar');
    expect(tables[1]!.textContent).not.toContain('John Tan');

    // …and the employee ID, partially. T100002 is Alice Lim, on the second table (the first is the
    // New / Pending group, which is still rendered — with its own "no matches" row).
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
    const { container } = form({ newCandidates: [add({ employmentId: 'n1' })] });
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
    await user.click(screen.getByRole('button', { name: 'Select all' }));
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

  it('the premise: the search box is inside the reprocess form, whose button is already live', () => {
    // Both halves matter. Outside the form, Enter would be harmless; with an empty selection the button
    // would be disabled and the click would do nothing. Neither is true here — `preselectedIds` are the
    // employments the run itself marked stale, and they arrive ticked.
    const { container } = form({ preselectedIds: ['e1', 'e3'] });
    expect(screen.getByRole('searchbox').closest('form')).toBe(container.querySelector('form'));
    expect(submit()).toBeEnabled();
  });

  it('typing a name and pressing Enter filters the list and submits NOTHING', async () => {
    const user = userEvent.setup();
    vi.mocked(reprocessSelectedAction).mockClear();
    const { container } = form({ preselectedIds: ['e1', 'e3'], newCandidates: [add({ employmentId: 'n1' })] });
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
    const { container } = form({ preselectedIds: ['e1'] });
    const spy = submitSpy(container);
    const box = boxes()[0]!;
    box.focus();
    await user.keyboard('{Enter}');
    expect(spy).not.toHaveBeenCalled();
  });

  it('CONTROL — clicking the submit button still submits, so the cases above are not vacuous', async () => {
    const user = userEvent.setup();
    const { container } = form({ preselectedIds: ['e1'] });
    const spy = submitSpy(container);
    await user.click(submit());
    expect(spy, 'the harness cannot see a submit at all — the guard cases prove nothing').toHaveBeenCalledTimes(1);
  });
});
