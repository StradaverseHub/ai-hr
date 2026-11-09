import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { BankDownloadDialog } from '../app/payroll/payment-submission/bank-download-dialog';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
const words = en.payroll.paymentSubmission;
const companyId = '11111111-2222-3333-4444-555555555555';
const bankProfileId = '22222222-2222-3333-4444-555555555555';
const key = '33333333-2222-3333-4444-555555555555';
const fetchMock = vi.fn();
const summary = { digest: 'a'.repeat(64), companyName: 'Acme', recordCount: 2, totalCents: 300000, periodKey: '2026-10', paymentDate: '2026-10-30' };
const props = { group: 'salary' as const, formats: [
  { id: 'my.ocbc.salary', label: 'OCBC Salary', description: 'One run', verification: 'Field table', testIndicator: false },
  { id: 'my.ocbc.kwsp', label: 'OCBC KWSP', description: 'Monthly contribution', verification: 'Field table', testIndicator: true },
  { id: 'my.ocbc.lhdn', label: 'OCBC LHDN', description: 'Monthly tax', verification: 'Field table', testIndicator: false },
  { id: 'my.ocbc.zakat', label: 'OCBC Zakat', description: 'Monthly Zakat', verification: 'Field table', testIndicator: false },
], endpoint: '/payroll/payment-submission/bank-file', companies: [{ value: companyId, label: 'Acme' }],
months: [{ value: '10', label: 'October' }, { value: '11', label: 'November' }],
defaultPeriodKey: '2026-10', defaultPaymentDate: '2026-10-30' };
const openLabel = (payment: string, template = words.bankDownloadAction) => template.replace('{payment}', payment);
beforeEach(() => {
  vi.restoreAllMocks(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(key);
  URL.createObjectURL = vi.fn(() => 'blob:generated'); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response('BANK', { headers: { 'Content-Disposition': 'attachment; filename="OCBC.txt"' } });
    if (url.includes('operation=options')) {
      const category = new URL(url, 'https://app.example').searchParams.get('category');
      const runs = category === 'salary' ? [{ runSeq: 1, cycleName: 'Regular', runType: 'regular' }, { runSeq: 2, cycleName: 'Bonus', runType: 'bonus' }] : [];
      return Response.json({
        accounts: [{ id: bankProfileId, label: 'Operations', bankName: 'OCBC Bank', accountNumber: '123456789012', formatId: 'my.ocbc.' + category }],
        configuredAccountId: null, accountIssue: null, usesStatutoryAccount: false,
        periods: [{ periodKey: '2026-10', runs }, { periodKey: '2025-11', runs }],
      });
    }
    return Response.json(summary);
  });
});
async function open(category: '' | 'kwsp' | 'lhdn' | 'zakat' = '') {
  render(<NextIntlClientProvider locale="en" messages={en}><BankDownloadDialog {...props} group={category ? 'bankStatutory' : 'salary'} /></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: openLabel(category ? words.bankStatutoryPayment : words.bankSalaryPayment) }));
  expect(fetchMock).not.toHaveBeenCalled();
  if (category) expect(screen.getByLabelText(words.bankPaymentType)).toBeDisabled();
  fireEvent.change(screen.getByLabelText(words.company), { target: { value: companyId } });
  if (category) fireEvent.change(screen.getByLabelText(words.bankPaymentType), { target: { value: category } });
  await screen.findByRole('option', { name: /Operations.*123456789012/ });
  fireEvent.change(screen.getByLabelText(words.bankAccount), { target: { value: bankProfileId } });
  return within(screen.getByRole('dialog'));
}
it('requires one explicit salary run, previews totals, clears approval when any input changes', async () => {
  const dialog = await open();
  expect(dialog.getByRole('button', { name: words.bankPreview })).toBeDisabled();
  expect(dialog.queryByRole('button', { name: words.download })).toBeNull();
  fireEvent.change(screen.getByLabelText(words.payCycle), { target: { value: '2' } });
  fireEvent.click(dialog.getByRole('button', { name: words.bankPreview }));
  await screen.findByText(words.bankPreviewTitle);
  expect(screen.getByText(/2 payment record.*3,000.00/)).toBeVisible();
  expect(dialog.getByRole('button', { name: words.download })).toBeEnabled();
  const previewUrl = fetchMock.mock.calls.find(([url]) => String(url).includes('operation=preview'))![0];
  expect(new URL(previewUrl, 'https://app.example').searchParams.get('runSeq')).toBe('2');
  fireEvent.change(screen.getByLabelText(words.bankReference), { target: { value: 'NEW REF' } });
  expect(screen.queryByText(words.bankPreviewTitle)).toBeNull();
  expect(dialog.queryByRole('button', { name: words.download })).toBeNull();
});
it('generates whole-month statutory files and retains the same key after an uncertain network failure', async () => {
  const dialog = await open('kwsp');
  expect(screen.getByLabelText(words.payCycle)).toHaveValue(words.bankWholeMonth);
  expect(screen.getByLabelText(words.bankFileMode)).toHaveValue('test');
  fireEvent.click(dialog.getByRole('button', { name: words.bankPreview }));
  await screen.findByText(words.bankPreviewTitle);
  let fail = true;
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => { if (init?.method === 'POST' && fail) { fail = false; throw new Error('Network interrupted'); } return original(url, init); });
  fireEvent.click(dialog.getByRole('button', { name: words.download }));
  await screen.findByRole('alert');
  fireEvent.click(dialog.getByRole('button', { name: words.download }));
  await screen.findByText(words.bankGenerated);
  const bodies = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init.body));
  expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({ requestKey: key, expectedDigest: summary.digest, testFile: true });
  expect(bodies[0]).not.toHaveProperty('runSeq'); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:generated');
});
it('requires a fresh preview after a stale payroll conflict', async () => {
  const dialog = await open();
  fireEvent.change(screen.getByLabelText(words.payCycle), { target: { value: '1' } });
  fireEvent.click(dialog.getByRole('button', { name: words.bankPreview })); await screen.findByText(words.bankPreviewTitle);
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'Payroll changed. Preview again.' }, { status: 409 }));
  fireEvent.click(dialog.getByRole('button', { name: words.download })); await screen.findByRole('alert');
  expect(dialog.queryByRole('button', { name: words.download })).toBeNull(); expect(screen.queryByText(words.bankPreviewTitle)).toBeNull();
});
it('blocks input changes during validation and clears preview when reopened', async () => {
  const dialog = await open();
  fireEvent.change(screen.getByLabelText(words.payCycle), { target: { value: '1' } });
  let resolve!: (r: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  fireEvent.click(dialog.getByRole('button', { name: words.bankPreview }));
  // Busy fields and close stay disabled until the in-flight validation settles.
  expect(dialog.getByRole('button', { name: words.cancel })).toBeDisabled();
  resolve(Response.json(summary)); await screen.findByText(words.bankPreviewTitle);
  fireEvent.click(dialog.getByRole('button', { name: words.cancel }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: openLabel(words.bankSalaryPayment) }));
  expect(screen.queryByText(words.bankPreviewTitle)).toBeNull();
});
it.each([['en', en], ['ms', ms], ['zh', zh], ['ta', ta], ['th', th], ['vi', vi_]] as const)('renders translated bank controls and account settings in %s', async (locale, messages) => {
  const local = messages.payroll.paymentSubmission;
  const onError = vi.fn();
  render(<NextIntlClientProvider locale={locale} messages={messages} onError={onError}><BankDownloadDialog {...props} /></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: openLabel(local.bankSalaryPayment, local.bankDownloadAction) }));
  fireEvent.change(screen.getByLabelText(local.company), { target: { value: companyId } });
  expect(screen.getByText(local.bankSelectionIntro)).toBeVisible();
  for (const key of ['ocbcFileSettings', 'ocbcFileSettingsHelp', 'ocbcContactName', 'ocbcContactPhone', 'ocbcStateCode', 'ocbcCheckId'] as const) expect(messages.admin.organization[key]).toBeTruthy();
  await screen.findByRole('option', { name: /Operations/ }); expect(onError).not.toHaveBeenCalled();
});
it.each(['lhdn', 'zakat'] as const)('discloses owner-requested blank hash before %s preview', async category => {
  await open(category);
  expect(screen.getByText(words.ocbcBlankHashNotice)).toBeVisible();
  expect(screen.queryByLabelText(words.bankFileMode)).toBeNull();
});

it('shows only closed periods and their runs, and clears the run on period change', async () => {
  await open();
  const years = within(screen.getByLabelText(words.year));
  expect(years.getAllByRole('option').map(option => option.textContent)).toEqual(['2026', '2025']);
  expect(screen.getByLabelText(words.month)).toHaveValue('2026-10');
  fireEvent.change(screen.getByLabelText(words.payCycle), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText(words.year), { target: { value: '2025' } });
  expect(screen.getByLabelText(words.month)).toHaveValue('2025-11');
  expect(screen.getByLabelText(words.payCycle)).toHaveValue('');
  expect(screen.getByRole('button', { name: words.bankPreview })).toBeDisabled();
});

it('preselects the configured account and clears the number when the company selection is removed', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({
    accounts: [{ id: bankProfileId, bankName: 'OCBC Bank', label: 'Operations', accountNumber: '000012345678', formatId: 'my.ocbc.salary' }],
    configuredAccountId: bankProfileId, accountIssue: null, usesStatutoryAccount: false, periods: [],
  }));
  render(<NextIntlClientProvider locale="en" messages={en}><BankDownloadDialog {...props} /></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: openLabel(words.bankSalaryPayment) }));
  fireEvent.change(screen.getByLabelText(words.company), { target: { value: companyId } });
  await screen.findByRole('option', { name: /000012345678.*Primary/ });
  expect(screen.getByLabelText(words.bankAccount)).toHaveValue(bankProfileId);
  expect(screen.getByText(words.bankNoClosedRuns)).toBeVisible();
  fireEvent.change(screen.getByLabelText(words.company), { target: { value: '' } });
  expect(screen.queryByRole('option', { name: /000012345678/ })).toBeNull();
});

it('explains missing account setup and disables preview', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({
    accounts: [], configuredAccountId: null, accountIssue: 'missing', usesStatutoryAccount: false, periods: [],
  }));
  render(<NextIntlClientProvider locale="en" messages={en}><BankDownloadDialog {...props} /></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: openLabel(words.bankSalaryPayment) }));
  fireEvent.change(screen.getByLabelText(words.company), { target: { value: companyId } });
  expect(await screen.findByText(words.bankAccountsNotSetUp)).toBeVisible();
  expect(screen.getByRole('button', { name: words.bankPreview })).toBeDisabled();
});
