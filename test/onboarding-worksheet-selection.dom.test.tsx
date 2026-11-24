import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {expect, it, vi} from 'vitest';
import * as XLSX from 'xlsx';
import {ImportHires} from '../app/lifecycle/onboarding/import/import-hires';
import messages from '../messages/en.json';

const preview = vi.hoisted(() => vi.fn(async (_state: unknown, _form: FormData) => ({})));
const commit = vi.hoisted(() => vi.fn());
vi.mock('../app/lifecycle/actions', () => ({importPreviewAction: preview, importCommitAction: commit}));

it('validates only the confirmed company worksheets from the original workbook', async () => {
  const user = userEvent.setup();
  render(<NextIntlClientProvider locale="en" messages={messages}><ImportHires companies={[]}/></NextIntlClientProvider>);
  const book = XLSX.utils.book_new();
  for (const [name, rows] of [['North', 1], ['South', 2], ['West', 1], ['Empty', 0]] as const) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name'], ...Array.from({length:rows}, (_, i) => [`Fictional ${i}`])]), name);
  }
  const bytes: ArrayBuffer = XLSX.write(book, {type:'array', bookType:'xlsx'});
  const file = new File([bytes], 'new-hires.xlsx');
  Object.defineProperty(file, 'arrayBuffer', {value:async () => bytes});
  await user.upload(screen.getByLabelText(/Excel file/), file);
  await user.click(await screen.findByRole('checkbox', {name:'South · 2 rows'}));
  await user.click(screen.getByRole('checkbox', {name:'North · 1 row'}));
  expect(screen.getByRole('checkbox', {name:'Empty · 0 rows'})).toBeDisabled();
  expect(screen.getByText('3 data rows')).toBeVisible();
  expect(preview).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', {name:'Use selected worksheets'}));
  await user.click(screen.getByRole('button', {name:messages.lifecycle.import.preview}));
  await waitFor(() => expect(preview).toHaveBeenCalledOnce());
  const [, form] = preview.mock.calls[0];
  expect(form.getAll('worksheet')).toEqual(['North', 'South']);
  expect(form.get('file')).toEqual(file);
  expect(commit).not.toHaveBeenCalled();
});
