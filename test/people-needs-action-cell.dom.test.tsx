/**
 * r307 — the cell and its panel, RENDERED.
 *
 * The node tests prove what the reads return and the source guard proves who may see them. This proves
 * the thing the reporter would actually judge: that a row says what is missing and what it stops, that
 * opening it lists every gap with the catalogue's own fix guidance, and that the panel offers exactly
 * one way out — the screen that fixes it.
 *
 * jsdom applies no stylesheet and computes no layout, so this is about text, structure and behaviour;
 * the row-overlap hazard the cell's `relative z-10` exists for is measured in the browser project.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { NeedsActionCell, type NeedsPerson } from '../app/personnel/needs-action-cell';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const L = messages.people.list;
const G = messages.controlTower.readinessScreen.gap;

const labels = {
  needed: L.drawerNeeded,
  blockers: L.drawerBlockers,
  facts: L.drawerFacts,
  completeRecord: L.drawerCompleteRecord,
  close: L.drawerClose,
  colCode: L.colCode,
  colCompany: L.colCompany,
  colDepartment: L.colDepartment,
  colStatus: L.colStatus,
  colHired: L.colHired,
};

/** Two gaps, worst first — the order core/record-readiness.ts returns them in. */
const person: NeedsPerson = {
  employmentId: 'emp-77',
  name: 'Nurul Huda',
  employeeCode: 'EMP-0006',
  company: 'Demo Sdn Bhd',
  department: 'Operations',
  statusLabel: 'Active',
  hiredOn: '2026-06-04',
  moreLabel: '+1 more',
  items: [
    { label: G.no_bank_account, fix: G.no_bank_accountFix, consequence: L.stopsPayment, tone: 'critical' },
    { label: G.no_tax_number, fix: G.no_tax_numberFix, consequence: L.stopsFiling, tone: 'warning' },
  ],
};

const renderCell = (p: NeedsPerson = person) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
      <NeedsActionCell person={p} labels={labels} />
    </NextIntlClientProvider>,
  );

describe('the needs-action cell', () => {
  it('names the first thing missing, what it stops, and how many more there are', () => {
    renderCell();
    expect(screen.getByText(G.no_bank_account)).toBeInTheDocument();
    // The consequence is the reason the row is worth reading, so it is on the row, not only in the panel.
    expect(screen.getByText(new RegExp(L.stopsPayment))).toBeInTheDocument();
    expect(screen.getByText(/\+1 more/)).toBeInTheDocument();
  });

  it('renders nothing at all for a complete record', () => {
    const { container } = renderCell({ ...person, items: [], moreLabel: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a panel listing every gap with its own consequence and fix', async () => {
    renderCell();
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(person.name);
    // Both gaps, both fixes — the fix text is the catalogue's, so the panel teaches the same thing the
    // Record Readiness screen does.
    expect(dialog).toHaveTextContent(G.no_bank_account);
    expect(dialog).toHaveTextContent(G.no_bank_accountFix);
    expect(dialog).toHaveTextContent(G.no_tax_number);
    expect(dialog).toHaveTextContent(G.no_tax_numberFix);
    expect(dialog).toHaveTextContent(L.stopsFiling);
  });

  it('carries the record facts a person is identified by, and no figures', async () => {
    renderCell();
    await userEvent.click(screen.getByRole('button'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('EMP-0006');
    expect(dialog).toHaveTextContent('Operations');
    expect(dialog).toHaveTextContent('Demo Sdn Bhd');
    expect(dialog).toHaveTextContent('2026-06-04');
  });

  it('offers exactly one way out: the screen that fixes it', async () => {
    renderCell();
    await userEvent.click(screen.getByRole('button'));
    const dialog = await screen.findByRole('dialog');
    const link = screen.getByRole('link', { name: new RegExp(L.drawerCompleteRecord) });
    expect(link).toHaveAttribute('href', '/admin/personnel/emp-77');
    // No form, no submit: a record change is an audited edit on the record, not a side effect of a list.
    expect(dialog.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button', { name: /save|approve|fix now/i })).toBeNull();
  });

  it('closes on Escape, leaving the list behind it', async () => {
    renderCell();
    await userEvent.click(screen.getByRole('button'));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The cell is still there to be opened again.
    expect(screen.getByText(G.no_bank_account)).toBeInTheDocument();
  });
});
