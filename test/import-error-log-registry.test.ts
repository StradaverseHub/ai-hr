/**
 * Board d3ba1e9f integration — every Import History kind that offers the Error Log has a source (builder B's
 * employee and section kinds, builder C's bank/statutory, cost allocation and information correction kinds), and the
 * bank source names the job whose complete streamed log the route serves. The sources' own reads are covered by their own tests.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bank: vi.fn(), cost: vi.fn(), info: vi.fn() }));
vi.mock('../core/bank-statutory-error-log', () => ({ bankStatutoryErrorLogFor: h.bank }));
vi.mock('../core/cost-allocation-error-log', () => ({ costAllocationErrorLogFor: h.cost }));
vi.mock('../core/information-correction-error-log', () => ({ informationCorrectionErrorLogFor: h.info }));
vi.mock('../db/client', () => ({ withTenant: vi.fn() }));
vi.mock('../core/import-history', () => ({ getImportAttempt: vi.fn(), getImportRun: vi.fn() }));
vi.mock('../core/employee-import-history', () => ({ employeeImportErrorReportFor: vi.fn() }));
const { IMPORT_ERROR_LOG_SOURCES, importErrorLogSourceFor } = await import('../core/import-error-log-registry');
const { IMPORT_ERROR_LOG_KINDS, hasImportErrorLog } = await import('../lib/import-error-log-kinds');

const t = { problems: (k: string) => k, shared: (k: string) => k };
const ctx = { tenantId: 't', userId: 'u' } as never;
const ID = '7c41e2a9-0000-4000-8000-000000000000';

describe('Import History Error Log registry', () => {
  it('offers the Error Log for every Personnel Management kind except Movement (out of scope this round)', () => {
    expect([...IMPORT_ERROR_LOG_KINDS].sort()).toEqual(['bank_statutory', 'cost_allocations', 'emergency', 'employee_full', 'family', 'information_correction', 'profile', 'qualification']);
    expect(Object.keys(IMPORT_ERROR_LOG_SOURCES).sort()).toEqual([...IMPORT_ERROR_LOG_KINDS].sort());
    expect(hasImportErrorLog('movement')).toBe(false);
    expect(hasImportErrorLog('bank_statutory')).toBe(true);
  });

  it('routes cost allocation and information correction entries to their own sources', async () => {
    const lines = [{ row: 3, problem: 'p', stage: 'check' as const, result: 'refused' as const }];
    h.cost.mockResolvedValue({ lines, total: 1, truncated: false });
    h.info.mockResolvedValue(null);
    expect(await importErrorLogSourceFor({ kind: 'cost_allocations', source: 'attempt' })!(ctx, ID, t)).toEqual({ lines, total: 1, truncated: false });
    expect(h.cost).toHaveBeenCalledWith(ctx, ID, t);
    expect(await importErrorLogSourceFor({ kind: 'information_correction', source: 'attempt' })!(ctx, ID, t)).toBeNull();
  });

  it('bank keeps the first page for the entry pages and names the streamed complete log', async () => {
    const jobId = '0a0a0a0a-0000-4000-8000-000000000000';
    h.bank.mockResolvedValue({ lines: [], total: 900, truncated: true, jobId });
    const log = await IMPORT_ERROR_LOG_SOURCES.bank_statutory(ctx, ID, t);
    expect(log).toEqual({ lines: [], total: 900, truncated: true, bankJobId: jobId });
    h.bank.mockResolvedValue(null);
    expect(await IMPORT_ERROR_LOG_SOURCES.bank_statutory(ctx, ID, t)).toBeNull();
  });
});
