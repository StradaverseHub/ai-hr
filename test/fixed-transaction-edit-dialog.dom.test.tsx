/**
 * cc8bd87f — Fixed Transaction View / Edit as a POP-UP over the employee's list, PROVED BY RENDERING.
 *
 * What the reporter will check: View / Edit stays on the list and opens a pop-up showing the stored values;
 * there is ONE End Date (Last Date to Pay) field and no Stop box; Cancel and the cross discard the typing; a
 * refused save keeps the pop-up open with the typing and names the problem; a successful save closes it,
 * refreshes the list and says Saved; Save cannot be pressed twice; an old link (`?edit=<id>`) opens it.
 *
 * The labels are resolved from the REAL en.json the way app/payroll/transactions/fixed/page.tsx resolves
 * them, and the refusal is translated by the real catalogue through NextIntlClientProvider, so a key the
 * screen asks for and the catalogue lacks fails here. The two server actions are stubbed (they reach
 * Postgres on import); their behaviour is proved against a database in test/fixed-transaction-popup-edit.test.ts
 * and test/fixed-transaction-action.test.ts.
 *
 * jsdom applies no CSS and computes no layout: this proves rendering and interaction, not the visual.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

const { refresh, save, remove, toastSuccess } = vi.hoisted(() => ({
  refresh: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/payroll/transactions/fixed',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
vi.mock('../app/payroll/transactions/fixed/actions', () => ({
  saveFixedTransactionDialogAction: save,
  removeFixedTransactionDialogAction: remove,
}));

import { FixedTxnList, type FixedTxnRow } from '../app/payroll/transactions/fixed/fixed-list';
import type { EditFixedDialogLabels } from '../app/payroll/transactions/fixed/edit-fixed-dialog';

const f = messages.payroll.transactions.fixed;
/** Built exactly as page.tsx builds them — same keys, same catalogue. */
const LABELS: EditFixedDialogLabels = {
  subtitle: f.detailSubtitle,
  notChangedHere: f.notChangedHere,
  employee: f.colEmployee,
  currentAmount: f.currentAmount,
  status: f.status,
  statusActive: f.statusActive,
  statusEnded: f.statusEnded,
  versioningTitle: f.versioningTitle,
  versioningBody: f.versioningBody,
  amount: f.amount,
  payrollCycle: f.payrollCycle,
  startDate: f.startDate,
  endDate: f.endDate,
  endDateHint: f.endDateHint,
  remarks: f.remarks,
  requiredField: f.requiredField,
  save: f.save,
  saving: f.saving,
  cancel: f.cancel,
  close: f.close,
  remove: f.delete,
  removeTitle: f.deleteTitle,
  removeBody: f.deleteBody,
  saved: f.savedToast,
  removed: f.removedToast,
  openEnded: f.openEnded,
};

const ROW: FixedTxnRow = {
  id: 'row-1',
  code: 'A0027',
  name: 'HANDPHONE ALLOWANCE',
  amount: '150.00',
  currency: 'MYR',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  runType: 'regular',
  cycleName: 'Monthly',
  remarks: 'Company phone plan',
  ended: false,
  payrollCycleId: 'cy-monthly',
  cycleOptions: [
    { id: 'cy-monthly', label: 'Monthly' },
    { id: 'cy-bonus', label: 'Bonus' },
  ],
  cyclePlaceholder: '—',
};
const OPEN_ROW: FixedTxnRow = { ...ROW, id: 'row-2', code: 'A0031', name: 'TRANSPORT', validTo: null, remarks: null };

function mount(p: { initialEditId?: string | null; initialEditError?: string | null } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages as never} onError={(e) => { throw e; }}>
      <FixedTxnList
        rows={[ROW, OPEN_ROW]}
        employmentId="emp-1"
        employee={{ code: 'A0102', name: 'Nur Aisyah binti Ahmad' }}
        cycleLabels={{ regular: 'Regular' }}
        cycleUnspecifiedLabel={f.cycleUnspecified}
        editLabels={LABELS}
        initialEditId={p.initialEditId ?? null}
        initialEditError={p.initialEditError ?? null}
      />
    </NextIntlClientProvider>,
  );
}

const field = <T extends HTMLElement>(dialog: HTMLElement, selector: string): T => {
  const el = dialog.querySelector(selector) as T | null;
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
};

async function openRow(user: ReturnType<typeof userEvent.setup>, index = 0) {
  await user.click(screen.getAllByRole('button', { name: f.viewEdit })[index]);
  return screen.getByRole('dialog');
}

beforeEach(() => {
  refresh.mockReset();
  save.mockReset();
  remove.mockReset();
  toastSuccess.mockReset();
});

describe('cc8bd87f — View / Edit opens a pop-up over the list', () => {
  it('stays on the list and shows the stored values, read-only facts, ONE end-date field and no Stop box', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    // View / Edit is a button now, not a link to another page.
    expect(screen.queryByRole('link', { name: f.viewEdit })).toBeNull();
    const dialog = await openRow(user);

    expect(within(dialog).getByText('A0027 — HANDPHONE ALLOWANCE')).toBeInTheDocument();
    expect(within(dialog).getByText(f.notChangedHere)).toBeInTheDocument();
    expect(within(dialog).getByText('A0102 · Nur Aisyah binti Ahmad')).toBeInTheDocument();
    expect(within(dialog).getByText(f.statusActive)).toBeInTheDocument();
    expect(within(dialog).getByText(f.versioningBody)).toBeInTheDocument();

    expect(field<HTMLInputElement>(dialog, 'input[name="amount"]').value).toBe('150.00');
    expect(field<HTMLSelectElement>(dialog, 'select[name="payrollCycleId"]').value).toBe('cy-monthly');
    expect(field<HTMLInputElement>(dialog, 'input[name="effectiveFrom"]').value).toBe('2026-01-01');
    expect(field<HTMLInputElement>(dialog, 'input[name="effectiveTo"]').value).toBe('2026-12-31');
    expect(field<HTMLInputElement>(dialog, 'input[name="remarks"]').value).toBe('Company phone plan');

    // ONE date field for the last date to pay, under the consolidated label, with its hint. No Stop box.
    expect(dialog.querySelectorAll('input[name="effectiveTo"]')).toHaveLength(1);
    expect(within(dialog).getByText(f.endDate)).toBeInTheDocument();
    expect(f.endDate).toBe('End Date (Last Date to Pay)');
    expect(within(dialog).getByText(f.endDateHint)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Stop from date/i)).toBeNull();
    expect(within(dialog).queryByText(/^Last date to pay$/i)).toBeNull();

    for (const name of [f.save, f.cancel, f.delete]) expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: f.close })).toBeInTheDocument();
  });

  it('an open-ended item shows a BLANK end date — no default to today', async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openRow(user, 1);
    expect(field<HTMLInputElement>(dialog, 'input[name="effectiveTo"]').value).toBe('');
  });

  it('Cancel and the cross discard the typing: reopening shows the stored values, nothing was sent', async () => {
    const user = userEvent.setup();
    mount();
    for (const name of [f.cancel, f.close]) {
      const dialog = await openRow(user);
      // Date inputs take a value, not keystrokes, in jsdom.
      fireEvent.change(field<HTMLInputElement>(dialog, 'input[name="effectiveTo"]'), { target: { value: '2026-06-30' } });
      expect(field<HTMLInputElement>(dialog, 'input[name="effectiveTo"]').value).toBe('2026-06-30');
      await user.click(within(dialog).getByRole('button', { name }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const again = await openRow(user);
      expect(field<HTMLInputElement>(again, 'input[name="effectiveTo"]').value).toBe('2026-12-31');
      await user.click(within(again).getByRole('button', { name: f.cancel }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('cc8bd87f — the save answers the pop-up', () => {
  it('a refused save keeps it open with the typing intact and NAMES the problem (ICU arguments filled)', async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: false, error: 'overlap', args: { code: 'A0027', from: '2027-01-01' } });
    mount();
    const dialog = await openRow(user);
    fireEvent.change(field<HTMLInputElement>(dialog, 'input[name="effectiveTo"]'), { target: { value: '2027-03-31' } });
    await user.clear(field(dialog, 'input[name="remarks"]'));
    await user.type(field(dialog, 'input[name="remarks"]'), 'Extended plan');
    await user.click(within(dialog).getByRole('button', { name: f.save }));

    const expected = f.overlap.replace('{code}', 'A0027').replace('{from}', '2027-01-01').replace('{to}', f.openEnded);
    expect(await within(dialog).findByText(expected)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(field<HTMLInputElement>(dialog, 'input[name="effectiveTo"]').value).toBe('2027-03-31');
    expect(field<HTMLInputElement>(dialog, 'input[name="remarks"]').value).toBe('Extended plan');
    expect(refresh).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();

    // What went to the server: the row, the employee, the typed values, the cycle flag untouched.
    const posted = save.mock.calls[0]![1] as FormData;
    expect(posted.get('id')).toBe('row-1');
    expect(posted.get('employmentId')).toBe('emp-1');
    expect(posted.get('effectiveTo')).toBe('2027-03-31');
    expect(posted.get('remarks')).toBe('Extended plan');
    expect(posted.get('amount')).toBe('150.00');
    expect(posted.get('cycleTouched')).toBe('0');
  });

  it('a successful save closes the pop-up, refreshes the list and says Saved', async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, changed: true });
    mount();
    const dialog = await openRow(user);
    fireEvent.change(field<HTMLInputElement>(dialog, 'input[name="effectiveTo"]'), { target: { value: '' } });
    await user.click(within(dialog).getByRole('button', { name: f.save }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith(f.savedToast);
    // A cleared end date posts empty: "keep paying".
    expect((save.mock.calls[0]![1] as FormData).get('effectiveTo')).toBe('');
  });

  it('saving with nothing changed closes without a refresh or a Saved message', async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, changed: false });
    mount();
    const dialog = await openRow(user);
    await user.click(within(dialog).getByRole('button', { name: f.save }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refresh).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('Save is disabled while the save is working, so it can be pressed only once', async () => {
    const user = userEvent.setup();
    let settle!: (v: unknown) => void;
    save.mockImplementation(() => new Promise((r) => (settle = r)));
    mount();
    const dialog = await openRow(user);
    await user.click(within(dialog).getByRole('button', { name: f.save }));
    const busy = await within(dialog).findByRole('button', { name: f.saving });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(save).toHaveBeenCalledTimes(1);
    settle({ ok: true, changed: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Remove asks the same confirmation question, then removes from inside the pop-up', async () => {
    const user = userEvent.setup();
    remove.mockResolvedValue({ ok: true, changed: true });
    mount();
    const dialog = await openRow(user);
    await user.click(within(dialog).getByRole('button', { name: f.delete }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(f.deleteTitle)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: f.delete }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect((remove.mock.calls[0]![1] as FormData).get('id')).toBe('row-1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith(f.removedToast);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('cc8bd87f — an old link opens the pop-up', () => {
  it('?edit=<id> (passed by the page only for a live row of this employee) opens it, with any carried refusal inside', async () => {
    const carried = 'Pay run 2026-05 is closed.';
    mount({ initialEditId: 'row-2', initialEditError: carried });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('A0031 — TRANSPORT')).toBeInTheDocument();
    expect(within(dialog).getByText(carried)).toBeInTheDocument();
  });

  it('no edit id: nothing opens by itself', () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
