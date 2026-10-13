import type { ReadinessGapId } from '../core/record-readiness';

/** Fields are the existing request engine's keys, never a second set of writable HR fields. */
export const READINESS_CORRECTIONS = {
  no_bank_account: { fields: ['bankName', 'bankAccountNo'], all: true, tab: 'bankStatutory' },
  no_identity: { fields: ['icNumber', 'passportNumber'], all: false, tab: 'profile' },
  no_tax_number: { fields: ['taxNumber'], all: true, tab: 'bankStatutory' },
  no_epf_number: { fields: ['epfNumber'], all: true, tab: 'bankStatutory' },
  no_socso_number: { fields: ['socsoNumber'], all: true, tab: 'bankStatutory' },
  no_compensation: { fields: [], all: true, tab: 'payroll' },
} as const satisfies Record<ReadinessGapId, { fields: readonly string[]; all: boolean; tab: string }>;

export type ReadinessAction = {
  type: 'submit_correction' | 'review_submission' | 'review_record';
  audience: 'employee' | 'hr';
  tab: 'profile' | 'bankStatutory' | 'payroll';
  requestId: string | null;
  approver: 'admin' | 'group_admin';
  mayReview?: boolean;
};

const satisfiesFields = (gap: ReadinessGapId, keys: ReadonlySet<string>) => {
  const rule = READINESS_CORRECTIONS[gap];
  return rule.fields.length > 0 && (rule.all
    ? rule.fields.every(key => keys.has(key))
    : rule.fields.some(key => keys.has(key)));
};

/** Pending means waiting, never completed. Permission to submit never grants permission to approve. */
export function readinessActionFor(gap: ReadinessGapId, facts: {
  hasStatutoryProfile: boolean;
  allowedFields: ReadonlySet<string>;
  pending: readonly { id: string; fields: readonly string[] }[];
  approver: 'admin' | 'group_admin';
}): ReadinessAction {
  const rule = READINESS_CORRECTIONS[gap];
  const pending = facts.pending.find(request => satisfiesFields(gap, new Set(request.fields)));
  if (pending) return { type: 'review_submission', audience: 'hr', tab: rule.tab, requestId: pending.id, approver: facts.approver };
  const maySubmit = facts.hasStatutoryProfile && satisfiesFields(gap, facts.allowedFields);
  return { type: maySubmit ? 'submit_correction' : 'review_record',
    audience: maySubmit ? 'employee' : 'hr', tab: rule.tab, requestId: null, approver: facts.approver };
}
