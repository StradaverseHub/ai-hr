/**
 * 18719ded — the Payroll tab's Basic Salary section, PROVED BY RENDERING, and the ONE composition in this
 * change that could pass every other gate and still be broken on screen.
 *
 * THE COMPOSITION. Making Add and Edit pop-ups in all three payroll sections puts a ConfirmSubmit — a
 * Radix AlertDialog whose Confirm calls `closest('form').requestSubmit()` — INSIDE a FamilyFormDialog,
 * a Radix Dialog that portals its body to document.body. A modal over a modal, with the form that has to
 * be found sitting between them. components/leave/earned-accrual-dialog.tsx names this as "the
 * ConfirmSubmit requestSubmit-in-portal caveat" and sidesteps it by having no <form> at all; Basic Salary
 * cannot, because the confirm-before-save on a salary revision is a real guard and stays. Nothing about
 * this fails tsc, the suite or `next build`: if the focus scope or the layer stack swallowed the click,
 * or if `closest('form')` found nothing through the portal, the button would simply do nothing.
 *
 * So the first test drives it end to end: open the outer dialog, open the confirmation inside it, press
 * Confirm, and assert the ENCLOSING FORM actually submitted. It is written on the real components
 * (FamilyFormDialog + ConfirmSubmit), not on a stand-in, because the caveat is about those two.
 *
 * The rest of the file is the Basic Salary history table itself: Edit used to be a row that unfolded
 * under the record — the same disclosure idiom the Documents tab was reported for — and is now the same
 * pop-up as everywhere else, with a View so a HISTORICAL revision is readable at all.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression. Pay Items and CP38 are
 * server-rendered inline in page.tsx and cannot be mounted here; their shape is pinned in
 * test/personnel-tab-shape-consistency.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { FamilyFormDialog } from '../components/family-form-dialog';
import { ConfirmSubmit } from '../components/ui/confirm-submit';
import { SalaryHistoryTable, type SalaryRowView } from '../components/salary-history-table';

// The compensation server actions, stubbed — a 'use server' module that reaches Postgres on import. Their
// behaviour (effective-dated CLOSE+INSERT, the closed-period refusals, the soft delete) is proved against
// a real database in test/basic-salary-history.test.ts.
vi.mock('../app/admin/personnel/[employmentId]/actions', () => ({
  editCompensationAction: vi.fn(),
  supersedeCompensationAction: vi.fn(),
}));

// The address bar, stubbed the same way test/client-pager.dom.test.tsx does it — the salary table reads
// ?page/?size through ClientPager's useSearchParams, which is null outside a Next render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const row = (over: Partial<SalaryRowView> & { id: string }): SalaryRowView => ({
  employmentId: 'emp-1',
  effectiveDate: '2026-01-01',
  currency: 'MYR',
  basic: 2500,
  previous: 2200,
  incrementAmount: 300,
  incrementPct: 13.63,
  status: 'active',
  payMode: 'monthly',
  paymentTerm: 'monthly',
  rateAmount: null,
  remarks: 'Annual review',
  editable: true,
  deletable: true,
  ...over,
});

const ROWS: SalaryRowView[] = [
  row({ id: 's1' }),
  row({
    id: 's2',
    effectiveDate: '2025-01-01',
    basic: 2200,
    previous: null,
    incrementAmount: null,
    incrementPct: null,
    status: 'historical',
    remarks: null,
    editable: false,
    deletable: false,
  }),
];

describe('18719ded — a ConfirmSubmit inside a FamilyFormDialog still submits its form', () => {
  it('Confirm, pressed from a dialog inside a dialog, submits the form between them', async () => {
    const user = userEvent.setup();
    const submitted = vi.fn((e: React.FormEvent<HTMLFormElement>) => e.preventDefault());
    wrap(
      <FamilyFormDialog triggerLabel="Add salary revision" title="Add salary revision">
        <form onSubmit={submitted}>
          <input type="hidden" name="tab" value="payroll" data-tab-tracker="" />
          <ConfirmSubmit
            variant="default"
            title="Confirm salary revision"
            description="This records a new salary revision."
            confirmLabel="Add salary revision"
          >
            Add salary revision
          </ConfirmSubmit>
        </form>
      </FamilyFormDialog>,
    );

    // Layer 1 — the form dialog.
    await user.click(screen.getByRole('button', { name: 'Add salary revision' }));
    const dialog = await screen.findByRole('dialog');
    expect(submitted).not.toHaveBeenCalled();

    // Layer 2 — the confirmation, opened from inside layer 1.
    await user.click(within(dialog).getByRole('button', { name: 'Add salary revision' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Confirm salary revision');
    // Opening the confirmation must not submit anything on its own.
    expect(submitted).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole('button', { name: 'Add salary revision' }));
    // The assertion the whole file exists for: requestSubmit() found the form through the portal.
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes the confirmation without submitting', async () => {
    const user = userEvent.setup();
    const submitted = vi.fn((e: React.FormEvent<HTMLFormElement>) => e.preventDefault());
    wrap(
      <FamilyFormDialog triggerLabel="Add salary revision" title="Add salary revision">
        <form onSubmit={submitted}>
          <ConfirmSubmit variant="default" title="Confirm" confirmLabel="Yes">
            Save
          </ConfirmSubmit>
        </form>
      </FamilyFormDialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Add salary revision' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe('18719ded — Basic Salary history rows use dialogs, not an unfolding row', () => {
  const mount = (rows: SalaryRowView[] = ROWS) => wrap(<SalaryHistoryTable rows={rows} />);

  it('every revision offers View; only the open one offers Edit', () => {
    mount();
    expect(screen.getAllByRole('button', { name: 'View' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
  });

  it('Edit opens a dialog carrying the record, the tab tracker and the confirm step', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    // No edit form is mounted until the dialog is opened — the row no longer unfolds one. (The hidden
    // compensationId IS present regardless: the row's Delete form carries it too.)
    expect(container.querySelector('input[name="effectiveFrom"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit salary revision')).toBeInTheDocument();
    expect((dialog.querySelector('input[name="effectiveFrom"]') as HTMLInputElement).value).toBe('2026-01-01');
    expect((dialog.querySelector('input[name="basicSalary"]') as HTMLInputElement).value).toBe('2500');
    expect((dialog.querySelector('input[name="remarks"]') as HTMLInputElement).value).toBe('Annual review');
    expect((dialog.querySelector('input[name="compensationId"]') as HTMLInputElement).value).toBe('s1');
    // Portalled out of the PersonnelTabs shell, so the tab has to ride along explicitly.
    expect((dialog.querySelector('input[name="tab"]') as HTMLInputElement).value).toBe('payroll');
    expect(within(dialog).getByRole('button', { name: 'Add salary revision' })).toBeInTheDocument();
  });

  it('View shows the same fields, disabled, and cannot post', async () => {
    const user = userEvent.setup();
    mount();
    // The HISTORICAL row: not editable, so View is the only way to read its detail.
    await user.click(screen.getAllByRole('button', { name: 'View' })[1]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('View salary revision')).toBeInTheDocument();
    // No <form> at all, so there is nothing for it to post to.
    expect(dialog.querySelector('form')).toBeNull();
    // The controls are disabled by the enclosing <fieldset disabled>, which is what makes this view
    // impossible to drift from Edit. Asserted on the fieldset, not on input.disabled: the IDL property
    // reflects the element's OWN attribute, so an input made "actually disabled" by an ancestor fieldset
    // still reports disabled === false (per spec, and jsdom follows it).
    const fieldset = dialog.querySelector('fieldset[disabled]');
    expect(fieldset).not.toBeNull();
    const basic = dialog.querySelector('input[name="basicSalary"]') as HTMLInputElement;
    expect(basic.value).toBe('2200');
    expect(fieldset!.contains(basic)).toBe(true);
  });

  it('search, status filter and paging are still on the table (they were never the complaint)', () => {
    mount();
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });
});
