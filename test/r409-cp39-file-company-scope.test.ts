/**
 * r409 verifier (item 79f3f64d) — THE CP39 e-DATA FILE IS COMPANY-SCOPED IN APPLICATION CODE.
 *
 * `/payroll/reports/cp39-file` was gated by bare `isAdmin`, which is true for an hr_admin grant on ANY
 * company in the tenant. Every sibling statutory route (`/payroll/cp39/{pdf,text}` through
 * `loadCp39Form`, `/payroll/statutory-forms/[formId]/export`, the CP22 batch route, the Form E / CP8D
 * preview) uses `scopedAdmin` and refuses a company outside `scopeIds` with the same bare 404 an unknown
 * id gets. RLS (`payroll_batch_rls` → `app.can_admin_payroll_for`) is the backstop, but it still admits a
 * batch carrying a payslip the caller can see for another reason (their own, a direct report's), and the
 * house rule is that the route re-checks rather than leaning on the backstop.
 *
 * EVERY ASSERTION THAT MATTERS IS A REFUSAL: an admin scoped to company A asks for company B's file and
 * must get 404, with the file generator never called and no statutory artefact recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';

/** An hr_admin whose ONLY grant is on company A. `isAdmin` is true for this session. */
const ctx: SessionContext = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: COMPANY_A }],
} as SessionContext;

const scope = { s: ctx, scopeIds: [COMPANY_A] };

vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => ctx) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
const fileForBatch = vi.fn(async () => ({
  content: 'H|SECRET-PCB-ROWS\n',
  filename: 'E1234567890_2026_01.txt',
  totals: { mtdRecords: 1, mtdCents: 10000, cp38Cents: 0 },
  statutoryVersion: 'test',
}));
vi.mock('@/localization/my/cp39-file', () => ({
  cp39FileForBatch: fileForBatch,
  Cp39NotReadyError: class Cp39NotReadyError extends Error {},
}));
const recordFileReport = vi.fn(async () => undefined);
vi.mock('@/core/reporting', () => ({ recordFileReport }));

const { GET } = await import('../app/payroll/reports/cp39-file/route');

const req = (companyId: string, extra = '') =>
  new Request(`http://localhost/payroll/reports/cp39-file?companyId=${companyId}&periodKey=2026-01${extra}`);

beforeEach(() => {
  fileForBatch.mockClear();
  recordFileReport.mockClear();
});

describe('r409 verifier — /payroll/reports/cp39-file refuses a company outside the admin\'s scope', () => {
  it('a company-A admin asking for company B gets 404, and nothing is generated or recorded', async () => {
    const res = await GET(req(COMPANY_B));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SECRET');
    expect(fileForBatch).not.toHaveBeenCalled();
    expect(recordFileReport).not.toHaveBeenCalled();
  });

  it('the same refusal with a payroll-cycle selection on the link', async () => {
    const res = await GET(req(COMPANY_B, '&run=1&run=2'));
    expect(res.status).toBe(404);
    expect(fileForBatch).not.toHaveBeenCalled();
  });

  it('the fence is not "deny everything": the in-scope company still downloads, with its cycles', async () => {
    const res = await GET(req(COMPANY_A, '&run=2'));
    expect(res.status).toBe(200);
    expect(fileForBatch).toHaveBeenCalledTimes(1);
    expect(fileForBatch).toHaveBeenCalledWith(ctx, { companyId: COMPANY_A, periodKey: '2026-01', runSeqs: [2] });
    expect(recordFileReport).toHaveBeenCalledTimes(1);
  });
});
