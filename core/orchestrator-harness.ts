/** Versioned, provider-independent coordination policy. HR services own every business decision. */
export const HR_HARNESS_VERSION = 'readiness-v2';
export type CaseState = 'needs_input' | 'needs_review' | 'verified' | 'inactive';
export type CaseObservation = 'missing' | 'complete' | 'inactive' | 'unknown';

/** Absence from a scoped query is NOT evidence of completion. */
export function readinessTransition(
  observation: CaseObservation,
  audience: 'employee' | 'hr',
): CaseState | null {
  switch (observation) {
    case 'missing': return audience === 'employee' ? 'needs_input' : 'needs_review';
    case 'complete': return 'verified';
    case 'inactive': return 'inactive';
    case 'unknown': return null;
  }
}

export type StepResult<T> = { status: 'succeeded'; value: T } | { status: 'failed' };
export const ORCHESTRATION_STEP_IDS = ['observe', 'readiness', 'claims', 'verify'] as const;
export type OrchestrationStepId = typeof ORCHESTRATION_STEP_IDS[number];

/** No blind retry of an effect with an uncertain result. The next sweep re-reads source state. */
export async function runHarnessStep<T>(execute: () => Promise<T>): Promise<StepResult<T>> {
  try { return { status: 'succeeded', value: await execute() }; }
  catch { return { status: 'failed' }; }
}

/** Only statuses cross the trace boundary; source values and exception text stay with their owners. */
export type OrchestrationPassTrace = {
  harnessVersion: typeof HR_HARNESS_VERSION;
  failed: boolean;
  steps: Record<OrchestrationStepId, StepResult<unknown>['status']>;
};

export type OrchestrationPassSummary = {
  harnessVersion: string | null;
  /** Null means the stored metadata cannot establish completion. */
  failed: boolean | null;
  steps: Record<OrchestrationStepId, StepResult<unknown>['status'] | 'unknown'>;
};

/** A read model of existing receipts, never a second execution ledger or an HR outcome verdict. */
export function summarizeOrchestrationPass(payload: unknown): OrchestrationPassSummary {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const data = record(payload);
  const storedSteps = record(data.steps);
  const status = (id: OrchestrationStepId): OrchestrationPassSummary['steps'][OrchestrationStepId] => {
    const value = storedSteps[id];
    return value === 'succeeded' || value === 'failed' ? value : 'unknown';
  };
  const steps = { observe: status('observe'), readiness: status('readiness'), claims: status('claims'), verify: status('verify') };
  const states = Object.values(steps);
  // Never display arbitrary event text as a version label.
  const harnessVersion = typeof data.harnessVersion === 'string' && /^readiness-v[1-9]\d{0,3}$/.test(data.harnessVersion)
    ? data.harnessVersion : null;
  // A contradictory success flag cannot hide a recorded step failure. A legacy false flag alone
  // cannot establish completion when the step receipts are missing.
  const failed = data.failed === true || states.includes('failed') ? true
    : data.failed === false && harnessVersion !== null && states.every(state => state === 'succeeded') ? false : null;
  return { harnessVersion, failed, steps };
}

/**
 * The production pass and redacted replays use this same sequence. Each step is attempted once,
 * including verification after an uncertain effect. A missing trace receipt also fails the pass.
 * Authorization, scope, switches, allowance admission and effects remain in the supplied services.
 */
export async function runOrchestrationPass<Observation, Readiness, Claims>(services: {
  observe: () => Promise<Observation>;
  readiness: () => Promise<Readiness>;
  claims: () => Promise<Claims>;
  recordTrace: (trace: OrchestrationPassTrace) => Promise<unknown>;
}) {
  const before = await runHarnessStep(services.observe);
  const nudge = await runHarnessStep(services.readiness);
  const triage = await runHarnessStep(services.claims);
  const after = await runHarnessStep(services.observe);
  const failed = [before, nudge, triage, after].some(step => step.status === 'failed');
  const trace = await runHarnessStep(() => services.recordTrace({
    harnessVersion: HR_HARNESS_VERSION, failed,
    steps: { observe: before.status, readiness: nudge.status, claims: triage.status, verify: after.status },
  }));
  return { harnessVersion: HR_HARNESS_VERSION, before, nudge, triage, after,
    failed: failed || trace.status === 'failed' };
}

/** Case-history events share the notification stream. Drain bounded pages so they cannot delay reminders. */
export async function drainNotificationProjection(
  dispatch: (limit: number) => Promise<{ processed: number; created: number }>,
) {
  const pageSize = 1000;
  let processed = 0;
  let created = 0;
  for (let page = 0; page < 50; page++) {
    // Each page commits its own cursor. A thrown/uncertain page is not retried here.
    const batch = await dispatch(pageSize);
    processed += batch.processed;
    created += batch.created;
    if (batch.processed < pageSize) return { processed, created, cappedOut: false };
  }
  return { processed, created, cappedOut: true };
}
