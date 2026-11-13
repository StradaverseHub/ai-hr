/**
 * Board d3ba1e9f — the Import History Error Log download (history/[attemptId]/error-log): admin-only, 404 for an entry
 * the viewer cannot see or whose kind has no source, an .xlsx in the request locale built from the kind's source
 * lines, and a Summary sheet that says when the entry kept only the first problems. The sources themselves (and their
 * company scoping) are covered by import-error-log-employee.test.ts and the database tests. Fictional data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import ms from '../messages/ms.json';

const h = vi.hoisted(() => ({ admin: vi.fn(), entry: vi.fn(), source: vi.fn(), bank: vi.fn(), locale: 'ms' }));
vi.mock('../app/admin/personnel/import/bank-statutory/jobs/[jobId]/error-log/route', () => ({ GET: h.bank }));
vi.mock('@/lib/authz', () => ({ requireAdmin: h.admin }));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const catalogues = { ms: (await import('../messages/ms.json')).default, en: (await import('../messages/en.json')).default } as Record<string, Record<string, unknown>>;
  return {
    getLocale: async () => h.locale,
    getTranslations: async (o: { locale: string; namespace?: string }) => createTranslator({ locale: o.locale, messages: catalogues[o.locale], namespace: o.namespace as never }),
  };
});
vi.mock('@/core/import-error-log-registry', () => ({
  importErrorLogEntry: h.entry,
  importErrorLogSourceFor: (entry: { kind: string | null; source: string }) => (entry.kind === null && entry.source === 'attempt' ? undefined : h.source),
}));
const { GET } = await import('../app/admin/personnel/import/history/[attemptId]/error-log/route');

const ID = '7c41e2a9-0000-4000-8000-000000000000';
const call = () => GET(new Request(`http://fixture.test/admin/personnel/import/history/${ID}/error-log`), { params: Promise.resolve({ attemptId: ID }) });
beforeEach(() => { vi.resetAllMocks(); h.admin.mockResolvedValue({ tenantId: 't', userId: 'u' }); h.locale = 'ms'; });

describe('Import History Error Log download', () => {
  it('serves a Bank and Statutory entry from its complete streamed log, not a shortened file, with no redirect', async () => {
    h.entry.mockResolvedValue({ kind: 'bank_statutory', source: 'attempt', sourceName: 'bank.xlsx' });
    h.source.mockResolvedValue({ lines: [], total: 5000, truncated: true, bankJobId: '0a0a0a0a-0000-4000-8000-000000000000' });
    h.bank.mockResolvedValue(new Response('streamed', { status: 200 }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('streamed');
    expect(h.bank).toHaveBeenCalledTimes(1);
    expect(await h.bank.mock.calls[0][1].params).toEqual({ jobId: '0a0a0a0a-0000-4000-8000-000000000000' });
  });

  it('answers 404 for an entry the viewer cannot see, a kind without a source, or a source that refuses', async () => {
    h.entry.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    h.entry.mockResolvedValue({ kind: null, source: 'attempt', sourceName: 'm.xlsx' });
    expect((await call()).status).toBe(404);
    h.entry.mockResolvedValue({ kind: 'profile', source: 'run', sourceName: 'p.xlsx' });
    h.source.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
  it('writes the source lines in the request locale with a Summary that names the truncation', async () => {
    h.entry.mockResolvedValue({ kind: 'profile', source: 'run', sourceName: 'profile-nov.xlsx' });
    h.source.mockImplementation(async (_ctx: unknown, id: string, t: { problems: (k: string, v?: Record<string, unknown>) => string; shared: (k: string) => string }) => {
      expect(id).toBe(ID);
      return { lines: [{ row: 4, reference: 'P001', field: 'Emel kerja', value: 'x@fixture.test', problem: '=SUM(A1)', correction: t.problems('importErrorLogEmployee.correction.duplicateInFile'), stage: 'check', result: 'refused' }], total: 250, truncated: true };
    });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="import-error-log-7c41e2a9.xlsx"');
    const wb = XLSX.read(new Uint8Array(await response.arrayBuffer()), { type: 'array' });
    const errors = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Errors, { header: 1, raw: false, defval: '' });
    expect(errors[0]).toContain(ms.importProblems.headers.row);
    expect(errors[1]).toContain(ms.importErrorLogEmployee.correction.duplicateInFile);
    expect(errors[1]).toContain("'=SUM(A1)"); // formula guard
    const summary = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Summary, { header: 1, raw: false, defval: '' });
    expect(summary.map((r) => r[0])).toEqual([ms.importProblems.summary.batch, ms.importProblems.summary.file, ms.people.importHistory.type, ms.importProblems.summary.problems, ms.importProblems.summary.truncated]);
    expect(summary[1][1]).toBe('profile-nov.xlsx');
    expect(summary[2][1]).toBe(ms.people.importHistory.kinds.profile);
    expect(summary[3][1]).toBe('250');
  });
  it('requires an administrator before reading anything', async () => {
    h.admin.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(call()).rejects.toThrow('NEXT_REDIRECT');
    expect(h.entry).not.toHaveBeenCalled();
  });
});
