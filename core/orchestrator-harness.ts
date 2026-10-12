/** Versioned, provider-independent coordination policy. HR services own every business decision. */
export const HR_HARNESS_VERSION = 'readiness-v1';
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
