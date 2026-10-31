import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { ImportCards } from '../app/(app)/admin/card-assignment/import-cards';
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function open() {
  render(<NextIntlClientProvider locale="en" messages={en}><ImportCards company="company" /></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: en.cardImport.importExcel }));
}
it('canceling a selected workbook makes no confirmation request', () => {
  open();
  fireEvent.change(screen.getByLabelText(en.cardImport.chooseFile, { exact: false }), { target: { files: [new File(['fixture'], 'cards.xlsx')] } });
  fireEvent.click(screen.getByRole('button', { name: en.cardImport.cancel }));
  expect(fetcher).not.toHaveBeenCalled(); expect(screen.queryByRole('heading', { name: en.cardImport.bulkTitle })).toBeNull();
  expect(screen.getByRole('button', { name: en.cardImport.importExcel })).toHaveFocus();
});
it('binds confirmation to the reviewed file, selected rows and explicit replacement acknowledgment', async () => {
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, preview: { receipt: 'review-receipt', fileHash: 'hash', fileName: 'cards.xlsx', rows: [
    { row: 3, employeeCode: '0007', employee: 'Fictional worker', cardId: '0020', previousCard: '0010', nextCard: '0020', operation: 'replace', effect: 'replace', issues: [] },
  ] } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, result: { rows: [], total: 1, imported: 0, updated: 1, unchanged: 0, failed: 0, skipped: 0 } }) });
  open();
  const file = new File(['fixture'], 'cards.xlsx');
  fireEvent.change(screen.getByLabelText(en.cardImport.chooseFile, { exact: false }), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: en.cardImport.check }));
  await screen.findByRole('heading', { name: en.cardImport.preview });
  expect(screen.getByRole('button', { name: en.cardImport.confirm })).toBeDisabled();
  fireEvent.click(screen.getByLabelText(en.cardImport.confirmReplacements));
  fireEvent.click(screen.getByRole('button', { name: en.cardImport.confirm }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const body = fetcher.mock.calls[1][1].body as FormData;
  expect(body.get('receipt')).toBe('review-receipt'); expect(body.get('selection')).toBe('[3]');
  expect(body.get('confirmReplacements')).toBe('true'); expect(body.get('company')).toBe('company');
  expect(body.get('file')).toBe(file);
  await screen.findByRole('heading', { name: en.cardImport.summary });
  fireEvent.click(screen.getByRole('button', { name: en.cardImport.close }));
  expect(screen.getByRole('button', { name: en.cardImport.importExcel })).toHaveFocus();
});
