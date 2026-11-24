import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {expect, it, vi} from 'vitest';
import * as XLSX from 'xlsx';
import {CandidateImportWizard} from '../app/recruitment/candidates/import/import-ui';
import messages from '../messages/en.json';

const preview = vi.hoisted(() => vi.fn(async (_input: {companyId: string; text: string; fileName: string}) => ({ok: false, fileError: 'import_no_name_column'})));
vi.mock('next/navigation', () => ({useRouter: () => ({push: vi.fn()})}));
vi.mock('../app/recruitment/actions', () => ({previewCandidateImportAction: preview}));

it('reads the confirmed candidate worksheet before calling validation', async () => {
  const user = userEvent.setup();
  const {container} = render(<NextIntlClientProvider locale="en" messages={messages}>
    <CandidateImportWizard companyId="fictional-company" fieldLabels={{}} />
  </NextIntlClientProvider>);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name'], ['Other person']]), 'Other');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name'], ['Selected person'], [' ']]), 'November');
  const bytes: ArrayBuffer = XLSX.write(book, {type: 'array', bookType: 'xlsx'});
  const file = new File([bytes], 'candidates.xlsx');
  Object.defineProperty(file, 'arrayBuffer', {value: async () => bytes});
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Recruitment upload input did not render.');
  await user.upload(input, file);
  await user.selectOptions(await screen.findByRole('combobox', {name: 'Worksheet'}), 'November');
  expect(preview).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', {name: 'Use this worksheet'}));
  await waitFor(() => expect(preview).toHaveBeenCalledWith({companyId: 'fictional-company', text: 'Name\r\nSelected person\r\n', fileName: 'candidates.xlsx'}));
});
