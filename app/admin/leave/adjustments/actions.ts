'use server';

import { requireAdmin } from '@/lib/authz';
import {
  applyLeaveAdjustmentBatch,
  reverseLeaveAdjustmentBatch,
  type AdjustmentCriteria,
} from '@/core/leave-adjustment';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { ADJUSTMENTS, fail, okToast } from '@/app/admin/_redirects';

/**
 * 491c499f — the Leave Adjustments screen's two writes.
 *
 * Both go through `requireAdmin()` rather than a bare session: this screen moves days on and off employee
 * balances in bulk, and the route registration in lib/permissions.ts is what makes that guard checkable by
 * test/function-access.test.ts. RLS still scopes which employments the write can reach; the guard is the
 * fail-fast layer in front of it.
 */

/** Read the criteria the form posted, keeping only the keys the resolver understands. */
function criteriaFrom(fd: FormData): AdjustmentCriteria {
  const list = (name: string) => fd.getAll(name).map(String).filter(Boolean);
  const out: AdjustmentCriteria = {
    companyIds: list('companyIds'),
    departmentIds: list('departmentIds'),
    employmentTypes: list('employmentTypes'),
  };
  // The eight org axes, by the same keys the leave-type Condition step posts — one vocabulary, so a
  // criteria set means the same thing on both screens.
  for (const c of ORG_ASSIGNMENT_CRITERIA) {
    const vals = list(c.key);
    if (vals.length) out[c.key] = vals;
  }
  return out;
}

export async function applyLeaveAdjustmentAction(formData: FormData) {
  const s = await requireAdmin();
  const targetMode = formData.get('targetMode') === 'individual' ? 'individual' : 'criteria';
  try {
    const res = await applyLeaveAdjustmentBatch(s, {
      leaveTypeIds: formData.getAll('leaveTypeIds').map(String).filter(Boolean),
      days: Number(String(formData.get('days') ?? '')),
      effectiveOn: String(formData.get('effectiveOn') ?? ''),
      reason: String(formData.get('reason') ?? ''),
      targetMode,
      criteria: targetMode === 'criteria' ? criteriaFrom(formData) : undefined,
      employmentIds:
        targetMode === 'individual' ? formData.getAll('employmentIds').map(String).filter(Boolean) : undefined,
    });
    // The toast carries the two counts, because targeted and written differ whenever a frozen encashment
    // snapshot was skipped — and a silent difference is exactly what makes a bulk write untrustworthy.
    okToast(ADJUSTMENTS, `Adjusted ${res.written} of ${res.targeted}`);
  } catch (e) {
    fail(ADJUSTMENTS, e);
  }
}

export async function reverseLeaveAdjustmentAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    const res = await reverseLeaveAdjustmentBatch(s, { batchId: String(formData.get('batchId') ?? '') });
    okToast(ADJUSTMENTS, `Reversed ${res.reversed}`);
  } catch (e) {
    fail(ADJUSTMENTS, e);
  }
}
