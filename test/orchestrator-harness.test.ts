import { describe, expect, it, vi } from 'vitest';
import { readinessTransition, runHarnessStep } from '../core/orchestrator-harness';

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
});
