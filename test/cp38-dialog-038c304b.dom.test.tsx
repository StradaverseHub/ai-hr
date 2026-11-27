/**
 * 038c304b / bc6b5490 — the CP38 Deduction page's pop-ups, PROVED BY RENDERING (app/payroll/transactions/cp38/cp38-dialog.tsx,
 * with the shared components/cp38/last-month-field.tsx and components/cp38/history-list.tsx the employee's Payroll tab
 * uses too).
 *
 * What the reporter will check: Edit opens with the record's stored values (Effective to shown as the last month
 * deducted); ticking "Last month amount" reveals "Last month deduction amount (RM)" and un-ticking hides it; a refused
 * save keeps the pop-up open with the typing and the reason; a successful save closes it and opens the list again with
 * its filters (in-app, the frame kept) and says Saved; Delete asks first and names the record; History shows each edit
 * and delete with the values before and after and who made it.
 *
 * 038c304b rev 2: Add and Edit have Cancel beside Save and a Close (X) in the corner, History the X. A form left as it
 * opened closes at once (Cancel, X, Escape); a changed one first asks "Discard your changes?" — Keep editing keeps the
 * typing, Discard closes without saving. The labels read Start Date and End Date (Last Date to Pay).
 *
 * Labels come from the REAL en.json the way page.tsx builds them. The two server actions are stubbed (they reach
 * Postgres on import); their behaviour is proved against a database in test/cp38-corrections-bc6b5490.test.ts and
 * test/cp38-read-budget-038c304b.test.ts. jsdom applies no CSS and computes no layout: rendering and interaction only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import messages from '../messages/en.json';

const { push, save, remove, toastSuccess } = vi.hoisted(() => ({ push: vi.fn(), save: vi.fn(), remove: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/payroll/transactions/cp38',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
vi.mock('../app/payroll/transactions/cp38/actions', () => ({ saveCp38DialogAction: save, deleteCp38DialogAction: remove }));

import { Cp38AddButton, Cp38RowActions, type Cp38DialogLabels } from '../app/payroll/transactions/cp38/cp38-dialog';
import type { Cp38HistoryEntry } from '../components/cp38/history-list';

const c = messages.payroll.transactions.cp38;
/** Built exactly as page.tsx builds them — same keys, same catalogue. */
const LABELS: Cp38DialogLabels = {
  add: c.add, addTitle: c.addTitle, edit: c.edit, editTitle: c.editTitle, save: c.save, saving: c.saving, close: c.close,
  cancel: c.cancel, discard: { title: c.discardTitle, keep: c.keepEditing, discard: c.discard },
  ref: c.ref, refPlaceholder: c.refPlaceholder, amount: c.amount, from: c.from, to: c.to, toHint: c.toHint, remarks: c.remarks,
  remarksPlaceholder: c.remarksPlaceholder, lastMonth: { toggle: c.lastMonthToggle, amount: c.lastMonthAmount, hint: c.lastMonthHint },
  delete: c.delete, deleteTitle: c.deleteTitle, history: c.history.button, historyTitle: c.history.title,
  historyLabels: {
    empty: c.history.empty, edited: c.history.edited, deleted: c.history.deleted, system: c.history.system, administrator: c.history.administrator,
    field: c.history.field, before: c.history.before, after: c.history.after, open: c.open, none: c.history.none,
    fields: { cp38Ref: c.ref, amount: c.amount, lastMonthAmount: c.lastMonthAmount, validFrom: c.from, validTo: c.to, remarks: c.remarks },
  },
};
const RECORD = {
  id: '11111111-1111-4111-8111-111111111111',
  employmentId: '22222222-2222-4222-8222-222222222222',
  cp38Ref: 'CP38/2026/00123',
  amount: '300.00',
  lastMonthAmount: '289.35',
  validFrom: '2026-01-01',
  validTo: '2026-07-01',
  remarks: 'Fictional LHDN letter',
};
const HISTORY: Cp38HistoryEntry[] = [
  {
    id: 'h2', cp38Id: RECORD.id, action: 'edit', actorName: 'Fictional Payroll Admin', byUser: true, at: '2026-11-20T03:00:00.000Z',
    before: { cp38Ref: RECORD.cp38Ref, amount: '250.00', lastMonthAmount: null, validFrom: '2026-01-01', validTo: '2026-06-01', remarks: null },
    after: { cp38Ref: RECORD.cp38Ref, amount: '300.00', lastMonthAmount: '289.35', validFrom: '2026-01-01', validTo: '2026-07-01', remarks: null },
  },
];
const RETURN_TO = '/payroll/transactions/cp38?company=33333333-3333-4333-8333-333333333333';

const wrap = (ui: ReactElement) =>
  render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);

beforeEach(() => {
  push.mockReset();
  save.mockReset();
  remove.mockReset();
  toastSuccess.mockReset();
});

describe('CP38 Deduction pop-ups', () => {
  it('Edit opens with the stored values, Effective to as the last month deducted, and the last-month amount ticked', async () => {
    const user = userEvent.setup();
    wrap(<Cp38RowActions record={RECORD} returnTo={RETURN_TO} labels={LABELS} history={HISTORY} deleteDescription="x" />);
    await user.click(screen.getByRole('button', { name: c.edit }));
    const dialog = await screen.findByRole('dialog', { name: c.editTitle });
    const form = dialog.querySelector('form[data-cp38-form]') as HTMLFormElement;
    expect((form.elements.namedItem('cp38Ref') as HTMLInputElement).value).toBe('CP38/2026/00123');
    expect((form.elements.namedItem('amount') as HTMLInputElement).value).toBe('300.00');
    expect((form.elements.namedItem('validFrom') as HTMLInputElement).value).toBe('2026-01-01');
    expect((form.elements.namedItem('validTo') as HTMLInputElement).value).toBe('2026-07-01');
    const toggle = within(dialog).getByRole('checkbox', { name: c.lastMonthToggle });
    expect(toggle).toBeChecked();
    expect((form.elements.namedItem('lastMonthAmount') as HTMLInputElement).value).toBe('289.35');
    // Un-ticking hides the amount (and posts none, which clears it); ticking shows it again.
    await user.click(toggle);
    expect(form.elements.namedItem('lastMonthAmount')).toBeNull();
    await user.click(toggle);
    expect(within(dialog).getByText(c.lastMonthAmount)).toBeTruthy();
  });

  it('a refused save keeps the pop-up open with the reason; a successful one closes it and opens the list again', async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce({ ok: false, message: c.error.lastMonthNeedsEnd });
    save.mockResolvedValueOnce({ ok: true, navigate: `${RETURN_TO}&toast=${encodeURIComponent(c.saved)}` });
    wrap(<Cp38RowActions record={RECORD} returnTo={RETURN_TO} labels={LABELS} history={HISTORY} deleteDescription="x" />);
    await user.click(screen.getByRole('button', { name: c.edit }));
    const dialog = await screen.findByRole('dialog', { name: c.editTitle });
    const amount = within(dialog).getByDisplayValue('300.00');
    await user.clear(amount);
    await user.type(amount, '310');
    await user.click(within(dialog).getByRole('button', { name: c.save }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(c.error.lastMonthNeedsEnd);
    expect(within(dialog).getByDisplayValue('310')).toBeTruthy();
    const posted = save.mock.calls[0][0] as FormData;
    expect([posted.get('id'), posted.get('employmentId'), posted.get('amount'), posted.get('lastMonthEnabled'), posted.get('returnTo')])
      .toEqual([RECORD.id, RECORD.employmentId, '310', '1', RETURN_TO]);
    await user.click(within(dialog).getByRole('button', { name: c.save }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: c.editTitle })).toBeNull());
    expect(push).toHaveBeenCalledWith(RETURN_TO);
    expect(toastSuccess).toHaveBeenCalledWith(c.saved);
  });

  it('Delete asks first, naming the record, and only then deletes', async () => {
    const user = userEvent.setup();
    remove.mockResolvedValueOnce({ ok: true, navigate: `${RETURN_TO}&toast=${encodeURIComponent(c.deleted)}` });
    const description = 'CP38/2026/00123: RM 300.00 a month, 01-Jan-2026 to 01-Jul-2026.';
    wrap(<Cp38RowActions record={RECORD} returnTo={RETURN_TO} labels={LABELS} history={HISTORY} deleteDescription={description} />);
    await user.click(screen.getByRole('button', { name: c.delete }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(c.deleteTitle);
    expect(confirm).toHaveTextContent(description);
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: c.delete }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect((remove.mock.calls[0][0] as FormData).get('id')).toBe(RECORD.id);
    await waitFor(() => expect(push).toHaveBeenCalledWith(RETURN_TO));
  });

  it('History shows who changed what, before and after', async () => {
    const user = userEvent.setup();
    wrap(<Cp38RowActions record={RECORD} returnTo={RETURN_TO} labels={LABELS} history={HISTORY} deleteDescription="x" />);
    await user.click(screen.getByRole('button', { name: c.history.button }));
    const dialog = await screen.findByRole('dialog', { name: c.history.title });
    expect(dialog).toHaveTextContent(`${c.history.edited} · CP38/2026/00123`);
    expect(dialog).toHaveTextContent('Fictional Payroll Admin');
    const rows = within(dialog).getAllByRole('row').map((r) => r.textContent);
    expect(rows).toContain(`${c.amount}250.00300.00`);
    expect(rows).toContain(`${c.lastMonthAmount}${c.history.none}289.35`);
    // Fields that did not change are not listed.
    expect(rows.some((r) => r?.startsWith(c.ref))).toBe(false);
  });

  it('Add opens an empty form for the chosen employee starting this month', async () => {
    const user = userEvent.setup();
    wrap(<Cp38AddButton employmentId={RECORD.employmentId} returnTo={RETURN_TO} defaultFrom="2026-11-01" labels={LABELS} />);
    await user.click(screen.getByRole('button', { name: c.add }));
    const dialog = await screen.findByRole('dialog', { name: c.addTitle });
    const form = dialog.querySelector('form[data-cp38-form]') as HTMLFormElement;
    expect((form.elements.namedItem('id') as HTMLInputElement | null)).toBeNull();
    expect((form.elements.namedItem('employmentId') as HTMLInputElement).value).toBe(RECORD.employmentId);
    expect((form.elements.namedItem('validFrom') as HTMLInputElement).value).toBe('2026-11-01');
    expect(within(dialog).getByRole('checkbox', { name: c.lastMonthToggle })).not.toBeChecked();
  });
});

describe('038c304b rev 2 — Cancel, Close and "Discard your changes?"', () => {
  it('the labels read Start Date and End Date (Last Date to Pay)', async () => {
    expect([c.from, c.to]).toEqual(['Start Date', 'End Date (Last Date to Pay)']);
    expect([messages.people.detail.cp38From, messages.people.detail.cp38To]).toEqual(['Start Date', 'End Date (Last Date to Pay)']);
    const user = userEvent.setup();
    wrap(<Cp38RowActions record={RECORD} returnTo={RETURN_TO} labels={LABELS} history={HISTORY} deleteDescription="x" />);
    await user.click(screen.getByRole('button', { name: c.edit }));
    const dialog = await screen.findByRole('dialog', { name: c.editTitle });
    expect(within(dialog).getByText('Start Date')).toBeTruthy();
    expect(within(dialog).getByText('End Date (Last Date to Pay)')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/Effective/);
  });

  it('Add: Cancel and X are there; an untouched form closes at once (Cancel, X, Escape) and saves nothing', async () => {
    const user = userEvent.setup();
    wrap(<Cp38AddButton employmentId={RECORD.employmentId} returnTo={RETURN_TO} defaultFrom="2026-11-01" labels={LABELS} />);
    for (const close of ['cancel', 'x', 'escape'] as const) {
      await user.click(screen.getByRole('button', { name: c.add }));
      const dialog = await screen.findByRole('dialog', { name: c.addTitle });
      const cancel = within(dialog).getByRole('button', { name: c.cancel });
      const x = within(dialog).getByRole('button', { name: c.close });
      expect(cancel).toHaveAttribute('type', 'button');
      if (close === 'cancel') await user.click(cancel);
      else if (close === 'x') await user.click(x);
      else await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: c.addTitle })).toBeNull());
      expect(screen.queryByRole('alertdialog')).toBeNull();
    }
    expect(save).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('Edit with changes: Cancel asks first; Keep editing keeps the typing; Discard closes and saves nothing', async () => {
    const user = userEvent.setup();
    wrap(<Cp38RowActions record={RECORD} returnTo={RETURN_TO} labels={LABELS} history={HISTORY} deleteDescription="x" />);
    await user.click(screen.getByRole('button', { name: c.edit }));
    let dialog = await screen.findByRole('dialog', { name: c.editTitle });
    const amount = within(dialog).getByDisplayValue('300.00');
    await user.clear(amount);
    await user.type(amount, '345');

    await user.click(within(dialog).getByRole('button', { name: c.cancel }));
    let ask = await screen.findByRole('alertdialog', { name: c.discardTitle });
    await user.click(within(ask).getByRole('button', { name: c.keepEditing }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    dialog = screen.getByRole('dialog', { name: c.editTitle });
    expect(within(dialog).getByDisplayValue('345')).toBeTruthy();

    // The X and Escape ask too.
    await user.click(within(dialog).getByRole('button', { name: c.close }));
    ask = await screen.findByRole('alertdialog', { name: c.discardTitle });
    await user.click(within(ask).getByRole('button', { name: c.keepEditing }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.keyboard('{Escape}');
    ask = await screen.findByRole('alertdialog', { name: c.discardTitle });
    // The question is modal: the pop-up behind it stays open (hidden from assistive technology while asked).
    expect(screen.getByRole('dialog', { name: c.editTitle, hidden: true })).toBeTruthy();

    await user.click(within(ask).getByRole('button', { name: c.discard }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: c.editTitle })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    // Opening again starts from the stored values: the discarded typing is gone.
    await user.click(screen.getByRole('button', { name: c.edit }));
    dialog = await screen.findByRole('dialog', { name: c.editTitle });
    expect(within(dialog).getByDisplayValue('300.00')).toBeTruthy();
  });

  it('ticking the last-month box counts as a change; undoing every change closes at once again', async () => {
    const user = userEvent.setup();
    wrap(<Cp38AddButton employmentId={RECORD.employmentId} returnTo={RETURN_TO} defaultFrom="2026-11-01" labels={LABELS} />);
    await user.click(screen.getByRole('button', { name: c.add }));
    const dialog = await screen.findByRole('dialog', { name: c.addTitle });
    const toggle = within(dialog).getByRole('checkbox', { name: c.lastMonthToggle });
    await user.click(toggle);
    await user.click(within(dialog).getByRole('button', { name: c.cancel }));
    const ask = await screen.findByRole('alertdialog', { name: c.discardTitle });
    await user.click(within(ask).getByRole('button', { name: c.keepEditing }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.click(toggle);
    await user.click(within(dialog).getByRole('button', { name: c.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: c.addTitle })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Save is unchanged: a changed form saves on Save without asking', async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce({ ok: true, navigate: `${RETURN_TO}&toast=${encodeURIComponent(c.saved)}` });
    wrap(<Cp38RowActions record={RECORD} returnTo={RETURN_TO} labels={LABELS} history={HISTORY} deleteDescription="x" />);
    await user.click(screen.getByRole('button', { name: c.edit }));
    const dialog = await screen.findByRole('dialog', { name: c.editTitle });
    const amount = within(dialog).getByDisplayValue('300.00');
    await user.clear(amount);
    await user.type(amount, '320');
    await user.click(within(dialog).getByRole('button', { name: c.save }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: c.editTitle })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0][0] as FormData).get('amount')).toBe('320');
    expect(push).toHaveBeenCalledWith(RETURN_TO);
  });

  it('History has the X, which closes it', async () => {
    const user = userEvent.setup();
    wrap(<Cp38RowActions record={RECORD} returnTo={RETURN_TO} labels={LABELS} history={HISTORY} deleteDescription="x" />);
    await user.click(screen.getByRole('button', { name: c.history.button }));
    const dialog = await screen.findByRole('dialog', { name: c.history.title });
    await user.click(within(dialog).getByRole('button', { name: c.close }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: c.history.title })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
