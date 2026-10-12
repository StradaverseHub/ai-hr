import { describe, expect, it, vi } from 'vitest';
import { drainNotificationProjection, readinessTransition, runHarnessStep } from '../core/orchestrator-harness';

describe('orchestrator harness replay scenarios', () => {
  it.each([
    ['missing', 'employee', 'needs_input'], ['missing', 'hr', 'needs_review'],
    ['complete', 'employee', 'verified'], ['inactive', 'employee', 'inactive'],
    ['unknown', 'employee', null], ['unknown', 'hr', null],
  ] as const)('%s / %s becomes %s', (observation, audience, state) => {
    expect(readinessTransition(observation, audience)).toBe(state);
  });
  it('does not retry an uncertain effect or leak exception details into a trace', async () => {
    const effect = vi.fn().mockRejectedValue(new Error('private employee payload'));
    expect(await runHarnessStep(effect)).toEqual({ status: 'failed' });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await runHarnessStep(async () => 'next')).toEqual({ status: 'succeeded', value: 'next' });
  });
  it('reports its limit instead of claiming an endless notification stream is drained', async () => {
    const dispatch = vi.fn(async (limit: number) => ({ processed: limit, created: 0 }));
    expect(await drainNotificationProjection(dispatch)).toEqual({ processed: 50_000, created: 0, cappedOut: true });
    expect(dispatch).toHaveBeenCalledTimes(50);
  });
  it('stops at an uncertain notification page without retrying it', async () => {
    const dispatch = vi.fn().mockResolvedValueOnce({ processed: 1000, created: 1 })
      .mockRejectedValue(new Error('uncertain page commit'));
    await expect(drainNotificationProjection(dispatch)).rejects.toThrow('uncertain page commit');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
