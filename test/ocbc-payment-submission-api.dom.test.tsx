import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  scopedAdmin: vi.fn(), permission: true, country: 'MY',
  accounts: vi.fn(), runs: vi.fn(), batches: vi.fn(), preview: vi.fn(), download: vi.fn(),
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: m.scopedAdmin }));
vi.mock('@/db/client', () => ({ withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({
  execute: async () => [{ ok: m.permission }],
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ country: m.country }] }) }) }),
}) }));
vi.mock('@/core/bank-profile', () => ({ listCompanyBankProfiles: m.accounts }));
vi.mock('@/packs/payroll/service', () => ({ listFilableRunsForPeriod: m.runs, listBatches: m.batches }));
vi.mock('@/localization/registry', () => ({ packFor: (country: string) => country === 'MY' ? { bankPaymentFiles: { preview: m.preview, download: m.download } } : undefined }));
vi.mock('../app/(app)/payroll/payment-submission/registry', () => ({ submissionFormat: (id: string) => ({
  'my.ocbc.salary': { available: true, transport: 'bank-post', periodKind: 'month-cycle', testIndicator: false },
  'my.ocbc.kwsp': { available: true, transport: 'bank-post', periodKind: 'month', testIndicator: true },
  'my.ocbc.socso': { available: true, transport: 'bank-post', periodKind: 'month', testIndicator: true },
  'my.ocbc.lhdn': { available: true, transport: 'bank-post', periodKind: 'month', testIndicator: false },
  'my.ocbc.zakat': { available: true, transport: 'bank-post', periodKind: 'month', testIndicator: false },
} as Record<string, unknown>)[id] }));
import { GET, POST } from '../app/(app)/payroll/payment-submission/bank-file/route';
import { GET as governmentDownload } from '../app/(app)/payroll/payment-submission/download/route';
import { BankPaymentFileError } from '../localization/country-pack';
const companyId = '11111111-2222-3333-4444-555555555555';
const bankProfileId = '22222222-2222-3333-4444-555555555555';
const request = { companyId, bankProfileId, formatId: 'my.ocbc.salary', periodKey: '2026-10', paymentDate: '2026-10-30', runSeq: 1, testFile: false, reference: 'OCT PAY' };
const generated = { ...request, expectedDigest: 'a'.repeat(64), requestKey: '33333333-2222-3333-4444-555555555555' };
const url = 'https://app.example/payroll/payment-submission/bank-file';
const get = (p: object) => GET(new Request(url + '?' + new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)]))));
const post = (p: object, origin = 'https://app.example') => POST(new Request(url, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(p) }));
beforeEach(() => {
  vi.clearAllMocks(); m.permission = true; m.country = 'MY';
  m.scopedAdmin.mockResolvedValue({ s: { tenantId: companyId, userId: companyId }, scopeIds: [companyId] });
  m.accounts.mockResolvedValue([{ id: bankProfileId, bank: 'ocbc_bank', currency: 'MYR', accountLabel: 'Operations', debitAccountNo: '123456789012' }, { id: 'other', bank: 'other', currency: 'MYR', debitAccountNo: 'full-secret' }]);
  m.runs.mockResolvedValue([1, 2, 3, 4].map(runSeq => ({ runSeq, runType: 'regular', cycleName: null, status: 'processed' })));
  m.batches.mockResolvedValue([{ runSeq: 1, status: 'processed' }, { runSeq: 2, status: 'closed', historyImportAttemptId: 'import' }, { runSeq: 3, status: 'processed', needsRecalcAt: new Date() }, { runSeq: 4, status: 'draft' }]);
  m.preview.mockResolvedValue({ digest: 'a'.repeat(64), companyName: 'Acme', recordCount: 2, totalCents: 300000, periodKey: request.periodKey, paymentDate: request.paymentDate });
  m.download.mockResolvedValue({ filename: 'OCBC.txt', content: 'BANK\r\n' });
});
describe('OCBC bank file route', () => {
  it('returns only account selection data and ready native payroll runs', async () => {
    const response = await get({ operation: 'options', companyId, formatId: request.formatId, periodKey: request.periodKey });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accounts: [{ id: bankProfileId, label: 'Operations', last4: '9012' }], runs: [{ runSeq: 1, runType: 'regular', cycleName: null, status: 'processed' }] });
    expect(m.preview).not.toHaveBeenCalled(); expect(m.download).not.toHaveBeenCalled();
  });
  it.each(['scope', 'database', 'country'])('denies %s before reading sensitive options', async (gate) => {
    if (gate === 'scope') m.scopedAdmin.mockResolvedValue({ s: {}, scopeIds: [] });
    if (gate === 'database') m.permission = false;
    if (gate === 'country') m.country = 'XX';
    expect((await get({ operation: 'options', companyId, formatId: request.formatId, periodKey: request.periodKey })).status).toBe(404);
    expect(m.accounts).not.toHaveBeenCalled(); expect(m.runs).not.toHaveBeenCalled();
  });
  it('cannot generate a bank file through the government GET download', async () => {
    expect((await governmentDownload(new Request(url + '?format=my.ocbc.salary&companyId=' + companyId))).status).toBe(404);
    expect(m.preview).not.toHaveBeenCalled(); expect(m.download).not.toHaveBeenCalled();
  });
  it('previews exactly one salary run without generating', async () => {
    expect((await get({ operation: 'preview', ...request })).status).toBe(200);
    expect(m.preview).toHaveBeenCalledWith(expect.anything(), request); expect(m.download).not.toHaveBeenCalled();
  });
  it.each([
    { ...request, runSeq: undefined }, { ...request, runSeq: '1,2' }, { ...request, runSeqs: '1,2' },
    { ...request, paymentDate: '2026-02-30' }, { ...request, paymentDate: '0000-01-01' },
    { ...request, testFile: '0' }, { ...request, testFile: true },
    { ...request, reference: 'a'.repeat(17) }, { ...request, reference: '非ASCII' },
    { ...request, formatId: 'my.ocbc.kwsp' }, { ...request, runSeq: '01' },
  ])('rejects invalid selections %#', async (p) => {
    expect((await get({ operation: 'preview', ...p })).status).toBeGreaterThanOrEqual(400);
    expect(m.preview).not.toHaveBeenCalled();
  });
  it('refuses salary with an omitted run rather than paying the whole month', async () => {
    const { runSeq: _run, ...p } = request;
    expect((await get({ operation: 'preview', ...p })).status).toBe(422);
    expect(m.preview).not.toHaveBeenCalled();
  });
  it('accepts whole-month statutory test files without a run', async () => {
    const { runSeq: _run, ...p } = request;
    expect((await get({ operation: 'preview', ...p, formatId: 'my.ocbc.socso', testFile: true })).status).toBe(200);
    expect(m.preview.mock.calls[0][1]).not.toHaveProperty('runSeq');
  });
  it.each(['my.ocbc.lhdn', 'my.ocbc.zakat'])('accepts owner-approved basic %s layout and rejects duplicate fields', async (formatId) => {
    const {runSeq: _run, ...wholeMonth} = request;
    expect((await get({ operation: 'preview', ...wholeMonth, formatId, testFile: false })).status).toBe(200);
    expect((await GET(new Request(url + '?operation=options&companyId=a&companyId=b'))).status).toBe(400);
  });
  it('requires same-origin POST, bounded strict body and preview digest', async () => {
    expect((await post(generated, 'https://evil.example')).status).toBe(403);
    expect((await post({ ...generated, expectedDigest: 'bad' })).status).toBe(400);
    expect((await post({ ...generated, hashTotal: '1234' })).status).toBe(400);
    expect((await post({ ...generated, reference: 'a'.repeat(5000) })).status).toBe(400);
    expect(m.download).not.toHaveBeenCalled();
  });
  it('returns immutable generation bytes and forwards the exact idempotency key on retry', async () => {
    for (let i = 0; i < 2; i++) { const response = await post(generated); expect(response.status).toBe(200); expect(await response.text()).toBe('BANK\r\n'); }
    expect(m.download).toHaveBeenNthCalledWith(1, expect.anything(), generated);
    expect(m.download).toHaveBeenNthCalledWith(2, expect.anything(), generated);
  });
  it('reports stale preview conflicts and hides unknown internal errors', async () => {
    m.download.mockRejectedValueOnce(new BankPaymentFileError('Payroll changed. Preview again.', 409));
    expect((await post(generated)).status).toBe(409);
    m.download.mockRejectedValueOnce(new Error('SQL secret account number'));
    const response = await post(generated); expect(response.status).toBe(500); expect(await response.text()).not.toContain('SQL secret');
  });
});
