/**
 * 7b5b1665 — the Import Log shows each row's Input Type in words, the Quantity and Amount as the file gave them, and
 * what the row will pay; a formula Pay Item row says whether its formula is used, and a refused row says why by row
 * and Pay Item. Rendered with the real English catalogue. Fictional data only.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { IndividualImportPage } from '../lib/individual-txn-import-model';

const m = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock('next-intl/server', async () => {
  const { createTranslator: tr } = await import('next-intl'); const messages = (await import('../messages/en.json')).default;
  return { getTranslations: async (namespace?: string) => tr({ locale: 'en', messages, namespace: namespace as never }) };
});
vi.mock('@/lib/scope', () => ({ scopedAdmin: async () => ({ s: { userId: 'viewer' }, scopeIds: ['company-a'] }) }));
vi.mock('@/packs/payroll/service', () => ({ listIndividualImportRows: m.rows }));

import { IndividualImportRows } from '../app/payroll/transactions/individual/imports/[attemptId]/result-rows';

afterEach(cleanup);
const record = (type: string, quantity: string, amount: string) => ({ employee_id: 'C001', __pay_period: '2026-11', __configured_cycle: 'MONTHLY', __input_unit: type, quantity, amount, notes: 'Fictional' });
const base = { employeeId: 'C001', employeeName: 'Fictional Employee', payItemCode: 'ONOR', payItem: 'Fictional normal OT', effectiveFrom: '2026-11-10' };

it('shows Input Type, Quantity, Amount, Will pay and the formula note for each row', async () => {
  const page: IndividualImportPage = { total: 3, page: 0, pages: 1, rows: [
    { rowNum: 2, outcome: 'valid', snapshotUnit: null, record: record('amount', '', '105.40'),
      row: { ...base, rowNum: 2, amount: '105.40', inputType: 'amount', inputValue: 105.4, calculationMethod: 'amount', ok: true, reason: '' } },
    { rowNum: 3, outcome: 'valid', snapshotUnit: null, record: record('hours', '12', ''),
      row: { ...base, rowNum: 3, amount: '281.08', inputType: 'hours', inputValue: 12, calculationMethod: 'formula', ok: true, reason: '' } },
    { rowNum: 4, outcome: 'invalid', snapshotUnit: null, record: record('amount', '4', '80.00'),
      row: { ...base, rowNum: 4, amount: '80.00', ok: false, reason: 'amountAndQuantity', detail: { row: 4, code: 'ONOR' } } },
  ] };
  m.rows.mockResolvedValue(page);
  render(await IndividualImportRows({ attemptId: 'attempt', page: 0, pageHref: (n) => `?page=${n}` }));
  expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
    'Excel row', 'Employee', 'Pay item', 'Payroll month', 'Pay cycle', 'Effective date', 'Input type', 'Quantity', 'Amount', 'Will pay', 'Remark', 'Outcome',
  ]);
  const cells = (n: number) => within(screen.getAllByRole('row')[n]).getAllByRole('cell').map((td) => td.textContent);
  expect(cells(1).slice(6, 10)).toEqual(['Amount', '', '105.40', 'MYR 105.40']);
  expect(cells(1)[11]).toBe('ValidAmount used as typed; the formula is not used');
  expect(cells(2).slice(6, 10)).toEqual(['Hours', '12', '', 'MYR 281.08']);
  expect(cells(2)[11]).toBe('ValidWorked out by the pay item’s formula');
  expect(cells(3).slice(6, 10)).toEqual(['Amount', '4', '80.00', '—']);
  expect(cells(3)[11]).toBe('InvalidRow 4: fill in either Amount or Quantity for ONOR, not both');
});
