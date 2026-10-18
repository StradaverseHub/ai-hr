import type { PayRuleKind } from '../core/pay-rule';

/** One stored pending fact. A missing rule on a ready legacy row still means fixed amount. */
export const PENDING_PAY_INPUT_KINDS = ['qty_rate', 'percent_of', 'per_day', 'per_hour', 'flat_capped', 'formula'] as const;
export type PendingPayInputKind = Exclude<PayRuleKind, 'fixed'>;
export type PayCalculationStatus = 'ready' | 'formula_pending' | 'calculation_pending';
export function payCalculationStatus(pendingInputKind: PendingPayInputKind | null | undefined): PayCalculationStatus {
  return pendingInputKind === 'formula' ? 'formula_pending' : pendingInputKind ? 'calculation_pending' : 'ready';
}
export class PayComponentCalculationPendingError extends Error {
  constructor(public readonly code: string) {
    super(`Complete and save the calculation for pay code "${code}" before assigning it or processing payroll.`);
    this.name = 'PayComponentCalculationPendingError';
  }
}
export function assertPayComponentReady(component: { code: string; pendingInputKind?: PendingPayInputKind | null }) {
  if (component.pendingInputKind != null) throw new PayComponentCalculationPendingError(component.code);
}

/** Preserve existing activated-pattern reference bytes when nullable import/presentation fields land.
 * Pending is an availability refusal, never a new hash shape for a calculation that may execute. */
export function payComponentReferenceStamp<T extends { code: string; description?: string | null; pendingInputKind?: PendingPayInputKind | null }>(component: T) {
  assertPayComponentReady(component);
  const { description: _description, pendingInputKind: _pendingInputKind, ...stamp } = component;
  return stamp;
}

/** Maintenance and generated import defaults. Explicit cells/checkboxes always take precedence. */
export const PAY_COMPONENT_DEFAULTS = {
  kind: 'allowance', archived: false, orpUnpaidLeave: false,
  roundingMethod: 'none', inputKind: 'fixed', prorates: true,
  includedInEpf: true, epfBonus2012: false, includedInPcb: true,
  includedInSocsoEis: true, includedInHrdfBase: false,
} as const;
export const payComponentOvertimeDefault = (kind: string) => kind === 'allowance';
export const payComponentEaDefault = (kind: string) => kind === 'allowance' ? 'EA_B1A' : null;
export type PayComponentIdentityIssue = { field: 'code' | 'label' | 'description'; code: 'required' | 'invalidCode' | 'tooLong' };
/** An unchanged legacy label/code stays editable; a new or changed identity obeys today's contract. */
export function payComponentIdentityIssues(
  input: { code: string; label?: string | null; description?: string | null },
  previous?: { code: string; label: string | null; description: string | null },
): PayComponentIdentityIssue[] {
  const issues: PayComponentIdentityIssue[] = [];
  const code = input.code.trim().toUpperCase(), label = (input.label ?? '').trim();
  if (!previous || code !== previous.code.trim().toUpperCase()) {
    if (!code) issues.push({ field: 'code', code: 'required' });
    else if (code.length > 20 || !/^[A-Z0-9_-]+$/.test(code)) issues.push({ field: 'code', code: 'invalidCode' });
  }
  if (!previous || input.label !== undefined && label !== (previous.label ?? '').trim()) {
    if (!label) issues.push({ field: 'label', code: 'required' });
    else if (Array.from(label).length > 60) issues.push({ field: 'label', code: 'tooLong' });
  }
  if (input.description !== undefined && (!previous || input.description !== previous.description) && Array.from(input.description ?? '').length > 200)
    issues.push({ field: 'description', code: 'tooLong' });
  return issues;
}
