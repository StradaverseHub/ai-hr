import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ admin: vi.fn(), resolve: vi.fn(), revalidate: vi.fn() }));
vi.mock('../lib/authz', () => ({ requireAdmin: m.admin }));
vi.mock('../packs/payroll/service', () => ({ resolvePayrollLeaveException: m.resolve }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`REDIRECT ${path}`); } }));
import { resolveLeavePayrollExceptionAction } from '../app/(app)/payroll/[batchId]/leave-followup-actions';
const batchId = '11111111-2222-4333-8444-555555555555';
const actor = { tenantId: 'trusted-tenant', userId: 'trusted-user' };
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({ batchId, exceptionId: 'exception', resolution: 'no_adjustment', explanation: 'Recorded review', userId: 'forged-user' })) data.set(key, value);
  return data;
}
beforeEach(() => { vi.clearAllMocks(); m.admin.mockResolvedValue(actor); m.resolve.mockResolvedValue(undefined); });
afterEach(() => vi.restoreAllMocks());
describe('payroll leave resolution refresh', () => {
  it('refreshes only the saved batch after the trusted operation completes, before returning to its follow-up', async () => {
    await expect(resolveLeavePayrollExceptionAction(form())).rejects.toThrow(`REDIRECT /payroll/${batchId}#leave-followup`);
    expect(m.resolve).toHaveBeenCalledWith(actor, { id: 'exception', batchId, resolution: 'no_adjustment', adjustmentBatchId: null, explanation: 'Recorded review' });
    expect(m.revalidate.mock.calls).toEqual([[`/payroll/${batchId}`]]);
    expect(m.resolve.mock.invocationCallOrder[0]).toBeLessThan(m.revalidate.mock.invocationCallOrder[0]);
  });
  it('keeps the failure outcome and does not invalidate as though a save succeeded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.resolve.mockRejectedValueOnce(new Error('refused'));
    await expect(resolveLeavePayrollExceptionAction(form())).rejects.toThrow(`REDIRECT /payroll/${batchId}?leaveFollowupError=1#leave-followup`);
    expect(m.revalidate).not.toHaveBeenCalled();
  });
  it('refuses authority before any operation or refresh', async () => {
    m.admin.mockRejectedValueOnce(new Error('denied'));
    await expect(resolveLeavePayrollExceptionAction(form())).rejects.toThrow('denied');
    expect(m.resolve).not.toHaveBeenCalled(); expect(m.revalidate).not.toHaveBeenCalled();
  });
  it('rejects a forged route before writing or invalidating another path', async () => {
    const data = form(); data.set('batchId', '../foreign');
    await expect(resolveLeavePayrollExceptionAction(data)).rejects.toThrow('REDIRECT /payroll');
    expect(m.resolve).not.toHaveBeenCalled(); expect(m.revalidate).not.toHaveBeenCalled();
  });
});
