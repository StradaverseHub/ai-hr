/**
 * 9066bd6c — the Remove Employee Payroll SELECTION SCREEN, proved by rendering and by reading the
 * FormData the browser would actually post.
 *
 * WHY THIS EXISTS ALONGSIDE test/payroll-remove-employee.test.ts. That file proves what the SERVICE does
 * with a list of employment ids — the arithmetic, the unwind, the snapshot, the refusals. It calls
 * `removeEmployeePayroll()` directly, so it is structurally incapable of seeing the defect this file was
 * written for: WHICH ids the screen hands it.
 *
 * THE DEFECT, in the words of the round that found it. The table body renders the SEARCH-FILTERED list,
 * so a ticked row that stops matching the search box is unmounted and its
 * `<input type="checkbox" name="employmentIds">` leaves the DOM — while the count, the button label, the
 * review list and the confirmation body are all computed from the UNFILTERED list and still name that
 * person. `ConfirmSubmit` submits with `requestSubmit()` (components/ui/confirm-submit.tsx), which posts
 * only MOUNTED controls, so the operator was shown three names, told "Remove 3 employee payroll", and
 * one employment id was posted. On payroll money that is the worst kind of bug: it is silent, and the
 * screen keeps agreeing with itself while doing something else.
 *
 * THE ASSERTION IS `new FormData(form)`, deliberately, rather than a spy on the action. FormData over the
 * real `<form>` element is exactly what `requestSubmit()` serialises — the mounted controls and nothing
 * else — so it pins the failure at the layer that actually had it, without pretending a jsdom test can
 * exercise a server action.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { RemoveForm, type RemoveCandidate } from '../app/payroll/[batchId]/remove/remove-form';

// The server action, stubbed. It is a 'use server' module that reaches Postgres on import; this file is
// about the screen in front of it, and the action's own behaviour is proved against a real database in
// test/payroll-remove-employee.test.ts.
vi.mock('../app/payroll/actions', () => ({ removeEmployeePayrollAction: vi.fn() }));

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const emp = (over: Partial<RemoveCandidate> & { employmentId: string }): RemoveCandidate => ({
  employeeCode: 'T100001',
  name: 'Alice Lim',
  department: 'Finance',
  gross: '4100.00',
  net: '3200.00',
  laterPeriods: [],
  ...over,
});

const PEOPLE: RemoveCandidate[] = [
  emp({ employmentId: 'e1', employeeCode: 'T100001', name: 'Alice Lim' }),
  emp({ employmentId: 'e2', employeeCode: 'T100002', name: 'Bala Krishnan', gross: '3780.00', net: '2950.00' }),
  emp({ employmentId: 'e3', employeeCode: 'T100003', name: 'Chan Wei Ming', gross: '6250.00', net: '5014.20' }),
  emp({ employmentId: 'e4', employeeCode: 'T100004', name: 'Devi Nair', gross: '5000.00', net: '4010.00' }),
];

const form = (over: Partial<Parameters<typeof RemoveForm>[0]> = {}) =>
  wrap(<RemoveForm batchId="b1" employees={PEOPLE} currency="MYR" from={null} {...over} />);

/** Exactly what `requestSubmit()` would post: the value of every MOUNTED `employmentIds` control. */
const posted = (container: HTMLElement): string[] =>
  new FormData(container.querySelector('form') as HTMLFormElement).getAll('employmentIds').map(String);

const tick = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(screen.getByRole('checkbox', { name: new RegExp(name) }));

describe('9066bd6c — the submitted set IS the confirmed set', () => {
  it('a ticked employee the search box has since hidden is STILL submitted', async () => {
    // The reported failure, in order: tick three, then search for only one of them.
    const user = userEvent.setup();
    const { container } = form();
    await tick(user, 'Alice Lim');
    await tick(user, 'Bala Krishnan');
    await tick(user, 'Chan Wei Ming');
    expect(posted(container).sort()).toEqual(['e1', 'e2', 'e3']);

    await user.type(screen.getByRole('searchbox'), 'Alice');
    // The table really has filtered — this is the condition that used to drop the other two.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);

    // …and all three ids are still posted, because the two off-screen ones ride hidden inputs.
    expect(posted(container).sort()).toEqual(['e1', 'e2', 'e3']);
    // Not twice: the visible row's checkbox and the hidden inputs are disjoint sets.
    expect(posted(container)).toHaveLength(3);
  });

  it('while it is hidden, the screen keeps SAYING three — count, review list and button all agree', async () => {
    // The other half of the same defect: these four surfaces are computed from the unfiltered list, so
    // if the posted set is ever allowed to shrink behind them, every one of them becomes a false
    // statement about payroll money.
    const user = userEvent.setup();
    const { container } = form();
    await tick(user, 'Alice Lim');
    await tick(user, 'Bala Krishnan');
    await tick(user, 'Chan Wei Ming');
    await user.type(screen.getByRole('searchbox'), 'Alice');

    expect(screen.getByText('3 of 4 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove 3 employee payroll' })).toBeInTheDocument();
    // The review panel names every ticked person REGARDLESS of the search — which is why hiding a row
    // may not drop it, and why the operator can still see what they are about to remove.
    const review = container.querySelector('.border-dashed') as HTMLElement;
    expect(review.textContent).toContain('Bala Krishnan');
    expect(review.textContent).toContain('Chan Wei Ming');
    expect(posted(container)).toHaveLength(3);
  });

  it('un-ticking a row that is back in view removes it from the posted set — the hidden inputs are not sticky', async () => {
    const user = userEvent.setup();
    const { container } = form();
    await tick(user, 'Alice Lim');
    await tick(user, 'Bala Krishnan');
    const search = screen.getByRole('searchbox');
    await user.type(search, 'Alice');
    expect(posted(container).sort()).toEqual(['e1', 'e2']);
    await user.clear(search);
    await tick(user, 'Bala Krishnan'); // off again, now that the row is mounted
    expect(posted(container)).toEqual(['e1']);
    expect(screen.getByRole('button', { name: 'Remove 1 employee payroll' })).toBeInTheDocument();
  });

  it('a search that matches nobody posts the whole selection and still refuses an empty one', async () => {
    const user = userEvent.setup();
    const { container } = form();
    await tick(user, 'Devi Nair');
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1); // the "no matches" row
    expect(container.textContent).toContain('No employee matches your search.');
    expect(posted(container)).toEqual(['e4']);
  });

  it('the whole-run refusal counts the SAME set that would be posted, filtered or not', async () => {
    // Ticking everybody is a Reset. The refusal is decided from the unfiltered list, and the service
    // refuses it again — so the two must be looking at the same four people even mid-search.
    const user = userEvent.setup();
    const { container } = form();
    for (const n of ['Alice Lim', 'Bala Krishnan', 'Chan Wei Ming', 'Devi Nair']) await tick(user, n);
    // A reason first, so the disabled assertion below is about the whole-run refusal and not about the
    // mandatory reason that also shuts the button.
    await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'all of them');
    await user.type(screen.getByRole('searchbox'), 'Devi');
    expect(posted(container)).toHaveLength(4);
    expect(container.textContent).toContain('Clearing a whole run is a Reset');
    // …and the submit is shut while that is true.
    expect(screen.getByRole('button', { name: 'Remove 4 employee payroll' })).toBeDisabled();

    // Untick one — the row has to be in view to be unticked, which is the point of keeping the search
    // non-destructive — and the door opens again with all three survivors still in the posted set once
    // the search is back on.
    await user.clear(screen.getByRole('searchbox'));
    await tick(user, 'Alice Lim');
    await user.type(screen.getByRole('searchbox'), 'Devi');
    expect(posted(container).sort()).toEqual(['e2', 'e3', 'e4']);
    expect(screen.getByRole('button', { name: 'Remove 3 employee payroll' })).toBeEnabled();
  });

  it('nothing ticked posts nothing — the hidden inputs appear only for a real selection', () => {
    const { container } = form();
    expect(posted(container)).toEqual([]);
    expect(container.querySelectorAll('input[type="hidden"][name="employmentIds"]')).toHaveLength(0);
  });
});
