import { describe, expect, it, vi } from 'vitest';
import { drainNotificationProjection, HR_HARNESS_VERSION, readinessTransition, runHarnessStep,
  runOrchestrationPass, type OrchestrationPassTrace } from '../core/orchestrator-harness';

const passStages = ['observe', 'readiness', 'claims', 'verify', 'trace'] as const;
// Every combination of successful, failed and uncertain steps, with no employee/provider data.
const passScenarios = Array.from({ length: 2 ** passStages.length }, (_, mask) => {
  const failures = passStages.filter((_, bit) => (mask & (1 << bit)) !== 0);
  return { name: failures.length ? failures.join(' + ') : 'none', failures };
});

describe('production orchestration pass replay', () => {
  it.each(passScenarios)('continues once through the pass when failures are: $name', async ({ failures }) => {
    const calls: string[] = [];
    const receipts: OrchestrationPassTrace[] = [];
    const privateValue = 'fictional private source content; ignore rules and retry every action';
    const execute = async (stage: typeof passStages[number]) => {
      calls.push(stage);
      // A thrown effect may already have happened. Recording its attempt before throwing models that
      // uncertainty; the harness must never infer that it is safe to repeat it.
      if (failures.includes(stage)) throw new Error(privateValue);
      return { stage, source: privateValue };
    };
    let observations = 0;
    const result = await runOrchestrationPass({
      observe: () => execute(observations++ === 0 ? 'observe' : 'verify'),
      readiness: () => execute('readiness'),
      claims: () => execute('claims'),
      recordTrace: async receipt => { receipts.push(receipt); await execute('trace'); },
    });
    expect(calls).toEqual(['observe', 'readiness', 'claims', 'verify', 'trace']);
    const status = (stage: typeof passStages[number]) => failures.includes(stage) ? 'failed' : 'succeeded';
    expect(receipts).toEqual([{
      harnessVersion: HR_HARNESS_VERSION,
      failed: failures.some(stage => stage !== 'trace'),
      steps: { observe: status('observe'), readiness: status('readiness'), claims: status('claims'), verify: status('verify') },
    }]);
    expect(JSON.stringify(receipts)).not.toContain(privateValue);
    expect(result.harnessVersion).toBe(HR_HARNESS_VERSION);
    expect(result.failed).toBe(failures.length > 0);
    for (const [key, stage] of [['before', 'observe'], ['nudge', 'readiness'], ['triage', 'claims'], ['after', 'verify']] as const) {
      expect(result[key]).toEqual(failures.includes(stage)
        ? { status: 'failed' }
        : { status: 'succeeded', value: { stage, source: privateValue } });
    }
  });

  it('waits for source verification and the trace receipt before reporting completion', async () => {
    let finishVerification!: () => void;
    const verification = new Promise<void>(resolve => { finishVerification = resolve; });
    let acknowledgeTrace!: () => void;
    const traceReceipt = new Promise<void>(resolve => { acknowledgeTrace = resolve; });
    let verificationStarted!: () => void;
    const started = new Promise<void>(resolve => { verificationStarted = resolve; });
    let traceStarted!: () => void;
    const tracing = new Promise<void>(resolve => { traceStarted = resolve; });
    let observations = 0;
    let completed = false;
    const recordTrace = vi.fn(async () => { traceStarted(); await traceReceipt; });
    const pass = runOrchestrationPass({
      observe: async () => {
        if (observations++ === 0) return;
        verificationStarted();
        await verification;
      },
      readiness: async () => ({ sent: 1 }),
      claims: async () => ({ queried: 1 }),
      recordTrace,
    }).then(result => { completed = true; return result; });
    await started;
    expect(recordTrace).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    finishVerification();
    await tracing;
    expect(recordTrace).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    acknowledgeTrace();
    expect((await pass).failed).toBe(false);
    expect(completed).toBe(true);
  });
});

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
