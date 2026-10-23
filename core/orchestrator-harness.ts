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

/** No blind retry of an effect with an uncertain result. The next sweep re-reads source state. */
export async function runHarnessStep<T>(execute: () => Promise<T>): Promise<StepResult<T>> {
  try { return { status: 'succeeded', value: await execute() }; }
  catch { return { status: 'failed' }; }
}

/** Only statuses cross the trace boundary; source values and exception text stay with their owners. */
export type OrchestrationPassTrace = {
  harnessVersion: typeof HR_HARNESS_VERSION;
  failed: boolean;
  steps: Record<'observe' | 'readiness' | 'claims' | 'verify', StepResult<unknown>['status']>;
};

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
