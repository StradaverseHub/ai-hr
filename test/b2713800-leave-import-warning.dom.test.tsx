/**
 * Item b2713800 — THE CANCELLED-ENTITLEMENT WARNING, PROVED BY RENDERING THE IMPORT SCREEN.
 *
 * WHY A DOM TEST AND NOT ONLY THE §8 RENDER CHECK. The preview table is painted from CLIENT state after
 * `validateLeaveImportAction` returns, so a GET of /admin/leave-config/import cannot reach it: at that
 * moment there is no file, no pasted text and no preview. The §8 render check therefore covers the screen's
 * static markup and this file covers the one row of it that matters — that the warning a server decided
 * actually arrives in front of a person, in the Message column, without demoting the row to Error and
 * without disabling Import. A warning the engine returns and the screen drops is the same silence the item
 * is about.
 *
 * Rendered against the REAL messages/en.json: a `t('…')` that is missing, or that carries a placeholder the
 * caller does not supply, throws in the browser and paints the raw key path while tsc, the suite and
 * `next build` all stay green.
 *
 * Scope note (inherited from the other dom tests): jsdom applies no CSS and computes no layout, so this
 * catches rendering and interaction logic, not a visual regression.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { LeaveLedgerImport } from '../app/admin/leave/import/leave-ledger-import';
import type { LeaveImportPreview } from '../lib/leave-import-schema';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const validateMock = vi.fn();
const commitMock = vi.fn();
vi.mock('../app/admin/leave/import/actions', () => ({
  validateLeaveImportAction: (...a: unknown[]) => validateMock(...a),
  commitLeaveImportAction: (...a: unknown[]) => commitMock(...a),
}));

beforeEach(() => {
  validateMock.mockReset();
  commitMock.mockReset();
});

/** The warning `core/leave-import.ts` returns for the damaging row, verbatim. */
const CANCELS =
  'Entitlement for 2026 will NOT be generated for this leave type — Generate Entitlement reads an ' +
  'imported accrual row as the leave year already being opened and grants nothing. Use transaction_type ' +
  '"adjustment" for an opening balance or a carry-forward.';

/** One valid row carrying the warning — what the engine returns for `accrual` in an un-generated year. */
const previewWithWarning: LeaveImportPreview = {
  total: 1,
  validCount: 1,
  rows: [{ rowNum: 1, employeeRef: 'E1001', leaveType: 'ANNUAL', ok: true, errors: [], warnings: [CANCELS] }],
  missingColumns: [],
};

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} onError={(e) => { throw e; }}>
      {ui}
    </NextIntlClientProvider>,
  );

/** Paste a row, press Validate, and let the mocked action resolve into the preview panel. */
async function previewWith(preview: LeaveImportPreview) {
  const userEvent = (await import('@testing-library/user-event')).default;
  const user = userEvent.setup();
  validateMock.mockResolvedValue(preview);
  wrap(<LeaveLedgerImport />);
  await user.type(screen.getByLabelText('Leave data (CSV)'), 'employee_id\n');
  await user.click(screen.getByRole('button', { name: 'Validate' }));
  await screen.findByText(/Preview/);
  return user;
}

describe('b2713800 · the warning reaches the person reading the preview', () => {
  it('prints it in the row’s Message cell, verbatim', async () => {
    await previewWith(previewWithWarning);
    // The sentence itself — not a key, not a truncation.
    expect(screen.getByText(CANCELS)).toBeInTheDocument();
  });

  it('keeps the row Ready and leaves Import enabled — it is a warning, not a refusal', async () => {
    await previewWith(previewWithWarning);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import 1 valid record/ })).toBeEnabled();
    // …and the header still counts it as ready rather than as an error.
    expect(screen.getByText('1 ready')).toBeInTheDocument();
  });

  it('renders it as a warning, in the same amber the other non-blocking flags use', async () => {
    await previewWith(previewWithWarning);
    const cell = screen.getByText(CANCELS);
    expect(cell.className).toMatch(/text-amber-600/);
  });

  it('shows it in the Message column of the row it belongs to', async () => {
    await previewWith(previewWithWarning);
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Row', 'Employee', 'Status', 'Message']);
    // One body row, and the warning is inside it beside the employee it concerns.
    const bodyRow = within(table).getAllByRole('row')[1];
    expect(within(bodyRow).getByText('E1001')).toBeInTheDocument();
    expect(within(bodyRow).getByText(CANCELS)).toBeInTheDocument();
  });

  it('a row with no warnings shows the em-dash instead, so the warning is not always-on', async () => {
    await previewWith({
      ...previewWithWarning,
      rows: [{ rowNum: 1, employeeRef: 'E1001', leaveType: 'ANNUAL', ok: true, errors: [], warnings: [] }],
    });
    expect(screen.queryByText(CANCELS)).toBeNull();
    const bodyRow = within(screen.getByRole('table')).getAllByRole('row')[1];
    expect(within(bodyRow).getByText('—')).toBeInTheDocument();
  });
});
