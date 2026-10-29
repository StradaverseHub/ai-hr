import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
const calls = vi.hoisted(() => ({
  evaluate: vi.fn(), hypotheses: vi.fn(),
  recurrence: vi.fn(),
  scope: { run: [{ id: 'fixture-tenant', name: 'Fictional tenant' }], skipped: [] },
}));
vi.mock('../db/client', () => ({ createDb: () => ({ db: {
  select: () => ({ from: () => ({ where: async () => [{ id: 'fixture-batch', payPeriod: '2026-10' }] }) }),
  transaction: async (fn: (tx: object) => unknown) => fn({}),
} }) }));
vi.mock('../core/sweep-scope', () => ({ loadSweepScope: async () => calls.scope, describeSkips: () => [] }));
vi.mock('../core/entitlements', () => ({ resolveEntitlementsTx: async () => ({}) }));
vi.mock('../core/payroll-anomaly', () => ({ evaluateBatchAnomalies: calls.evaluate }));
vi.mock('../core/payroll-hypothesis', () => ({ proposeHypotheses: calls.hypotheses }));
vi.mock('../core/recurrence-mining', () => ({ mineClosureRecurrences: calls.recurrence }));
vi.mock('../core/job-run', () => ({ recordJobRun: vi.fn() }));
import { anomalySweep } from '../scripts/anomaly-sweep';

describe('scheduled model steps stay retired without principal admission', () => {
  beforeEach(() => {
    calls.evaluate.mockReset().mockResolvedValue({ total: 3, autoClear: 2, review: 1, block: 0, coverage: 1 });
    calls.recurrence.mockReset().mockResolvedValue({ checked: 0, reversed: 0, held: 0, pending: 0 });
    calls.hypotheses.mockReset();
  });
  it('keeps deterministic payroll checks and recurrence without attempting a model step', async () => {
    const out = await anomalySweep('unused-fixture-url');
    expect(calls.evaluate).toHaveBeenCalledOnce();
    expect(calls.recurrence).toHaveBeenCalledOnce();
    expect(calls.hypotheses).not.toHaveBeenCalled();
    expect(out).toMatchObject({ batches: 1, autoClear: 2, review: 1, block: 0, hypotheses: 0,
      hypothesisCalls: 0, hypothesisPrincipalNotAdmittedBatches: 1, failures: 0 });
  });
  it('does no evaluation, recurrence or retired-step accounting in dry-run mode', async () => {
    const out = await anomalySweep('unused-fixture-url', { dryRun: true });
    expect(calls.evaluate).not.toHaveBeenCalled();
    expect(calls.recurrence).not.toHaveBeenCalled();
    expect(calls.hypotheses).not.toHaveBeenCalled();
    expect(out.hypothesisPrincipalNotAdmittedBatches).toBe(0);
  });
  it('makes legacy feedback cron an explicit no-op without reading even an invalid database URL', () => {
    const log = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/feedback-plan.ts'], {
      encoding: 'utf8', env: { ...process.env, MIGRATION_DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/no_database' },
    });
    expect(log).toContain('scheduled model step retired [principal_not_admitted]; 0 model calls');
  });
});
