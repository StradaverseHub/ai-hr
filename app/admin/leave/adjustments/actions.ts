'use server';

import { requireAdmin } from '@/lib/authz';
import type { SessionContext } from '@/db/client';
import {
  applyLeaveAdjustmentBatch,
  previewLeaveAdjustmentBatch,
  reverseLeaveAdjustmentBatch,
  type AdjustmentCriteria,
} from '@/core/leave-adjustment';
import { orgCriteriaFromFields } from '@/core/org-criteria';
import { listEmployeePickOptions } from '@/core/read';
import { mergeEmploymentSelection } from '@/lib/employment-selection';
import { ADJUSTMENTS, fail, okToast } from '@/app/admin/_redirects';

/**
 * 491c499f — the Leave Adjustments screen's writes; 18103ba4 added the read the step flow needs.
 *
 * Every one goes through `requireAdmin()` rather than a bare session: this screen moves days on and off
 * employee balances in bulk, and the route registration in lib/permissions.ts is what makes that guard
 * checkable by test/function-access.test.ts. RLS still scopes which employments the write can reach; the
 * guard is the fail-fast layer in front of it.
 */

/**
 * Read the criteria the form posted through the SHARED reader.
 *
 * 18103ba4 deleted the hand-rolled version that used to live here. It listed the field names itself, so
 * every axis added to `core/org-criteria.ts` had to be remembered in a second place — and the one that got
 * forgotten would post fine, resolve to nothing, and narrow nobody. `orgCriteriaFromFields` is the same
 * reader the Notice Board uses, which is the point: one set of names, one meaning, so "Finance + Executive"
 * selects the same people on both screens.
 */
function criteriaFrom(fd: FormData): AdjustmentCriteria {
  return orgCriteriaFromFields(
    (name) => fd.getAll(name).map(String),
    (name) => {
      const v = fd.get(name);
      return v == null ? null : String(v);
    },
  );
}

/**
 * r288 (8521e160) — TWO WAYS IN, ONE LIST OUT. Step ② now offers a picker (hidden `employmentIds` inputs,
 * the MultiSelectPopover form contract) BESIDE the pasted block, which is KEPT: it is how a bulk
 * adjustment is set up today.
 *
 * `mergeEmploymentSelection` is the SAME function the screen's live matched count calls on the SAME two
 * fields, so the population confirmed on screen cannot differ from the one this batch adjusts. Do not
 * inline either half — that seam is the dangerous part, because two fields parsed two ways leaves both
 * halves' tests green while the screen and the write disagree about who is affected.
 *
 * r289 — THE THIRD ARGUMENT IS THE POPULATION, and it is why this is now async. A pasted `EMP-0008` only
 * becomes an employment id against a list of employments, and it must be the SAME list step ②'s picker was
 * filled from or the screen and the write would read one reference as two different people. The read is
 * `listEmployeePickOptions` — `listCompanies` → `listEmployees`, exactly what the page does. An unresolved
 * token is NOT dropped: it reaches `resolveAdjustmentTargets` as typed and covers nobody, because a typo
 * that silently shrank a bulk adjustment would look exactly like one that worked.
 */
const idsFrom = async (s: SessionContext, fd: FormData): Promise<string[]> =>
  mergeEmploymentSelection(
    fd.getAll('employmentIds').map(String),
    String(fd.get('employmentIdsRaw') ?? ''),
    await listEmployeePickOptions(s),
  );

/**
 * 18103ba4 — the amount and its DIRECTION arrive as two fields and are recomposed into the ONE signed
 * number `applyLeaveAdjustmentBatch` has always taken.
 *
 * The reporter asked Step 1 for "Add Leave / Deduct Leave" and Step 3 for a plain "Adjustment Amount",
 * replacing 491c499f's single signed box whose help text explained that a minus sign meant "take away".
 * The recomposition lives HERE, at the boundary, rather than in the core: the ledger, the batch row, the
 * reversal and `test/leave-adjustment-batch.test.ts` all keep speaking signed days, so nothing about how
 * an adjustment is stored or undone changed with the UI.
 *
 * `Math.abs` because the direction is now the radio's job — a negative amount typed into a box labelled
 * "Add" would otherwise be a second, contradictory way of saying "deduct".
 */
function signedDays(fd: FormData): number {
  const amount = Math.abs(Number(String(fd.get('days') ?? '')));
  return fd.get('adjustmentType') === 'deduct' ? -amount : amount;
}

/**
 * ⚠️ THE SUCCESS REDIRECT SITS OUTSIDE THE try/catch, AND THAT IS THE WHOLE POINT.
 *
 * `redirect()` works by THROWING a `NEXT_REDIRECT` control-flow error. 491c499f called `okToast` from
 * inside the try, so every SUCCESSFUL adjustment threw NEXT_REDIRECT, was caught by the `catch (e)` meant
 * for service errors, and came back through `fail()` — landing the operator on
 * `?error=NEXT_REDIRECT` with a red banner over a batch that had in fact been written perfectly. Found by
 * rendering the flow and pressing the button; it passes tsc, the suite and the route's 200 without a murmur.
 *
 * The rest of this repo already knows the rule and says so at four other action files (the settings
 * actions under app/admin/settings, and app/admin/pay-components/actions.ts): "redirect ALWAYS outside
 * try/catch so NEXT_REDIRECT isn't caught". This screen simply never got the memo.
 */
export async function applyLeaveAdjustmentAction(formData: FormData) {
  const s = await requireAdmin();
  const targetMode = formData.get('targetMode') === 'individual' ? 'individual' : 'criteria';
  let res: Awaited<ReturnType<typeof applyLeaveAdjustmentBatch>>;
  try {
    res = await applyLeaveAdjustmentBatch(s, {
      leaveTypeIds: formData.getAll('leaveTypeIds').map(String).filter(Boolean),
      days: signedDays(formData),
      effectiveOn: String(formData.get('effectiveOn') ?? ''),
      reason: String(formData.get('reason') ?? ''),
      targetMode,
      criteria: targetMode === 'criteria' ? criteriaFrom(formData) : undefined,
      employmentIds: targetMode === 'individual' ? await idsFrom(s, formData) : undefined,
    });
  } catch (e) {
    fail(ADJUSTMENTS, e);
  }
  // The toast carries the two counts, because targeted and written differ whenever a frozen encashment
  // snapshot was skipped — and a silent difference is exactly what makes a bulk write untrustworthy.
  okToast(ADJUSTMENTS, `Adjusted ${res.written} of ${res.targeted}`);
}

/**
 * 18103ba4 — Step 2's live matched count and Step 4's automatic validation, in one call. READ-ONLY: no
 * DomainEvent, no row, nothing written (the `countEmployeesInScopeAction` precedent on the Entitlements
 * page). Guarded by `requireAdmin` like the writes, because the answer is a headcount broken down by
 * criteria and that is not public.
 *
 * The criteria arrive as a loose `Record` from the browser and are normalised through the SAME
 * `orgCriteriaFromFields` the form post goes through, rather than trusted as-is. A count computed from a
 * differently-parsed criteria object than the one the write will use is worse than no count at all.
 */
export async function previewLeaveAdjustmentAction(p: {
  leaveTypeIds: string[];
  effectiveOn: string;
  targetMode: 'criteria' | 'individual';
  criteria: Record<string, string[] | string>;
  employmentIds: string[];
}) {
  const s = await requireAdmin();
  const raw = p.criteria ?? {};
  const criteria = orgCriteriaFromFields(
    (name) => {
      const v = raw[name];
      return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
    },
    (name) => {
      const v = raw[name];
      return Array.isArray(v) ? (v[0] ?? null) : v == null ? null : String(v);
    },
  );
  return previewLeaveAdjustmentBatch(s, {
    leaveTypeIds: p.leaveTypeIds ?? [],
    effectiveOn: p.effectiveOn ?? '',
    targetMode: p.targetMode === 'individual' ? 'individual' : 'criteria',
    criteria,
    employmentIds: p.employmentIds ?? [],
  });
}

/** Same NEXT_REDIRECT discipline as the apply above — it had the identical defect. */
export async function reverseLeaveAdjustmentAction(formData: FormData) {
  const s = await requireAdmin();
  let res: Awaited<ReturnType<typeof reverseLeaveAdjustmentBatch>>;
  try {
    res = await reverseLeaveAdjustmentBatch(s, { batchId: String(formData.get('batchId') ?? '') });
  } catch (e) {
    fail(ADJUSTMENTS, e);
  }
  okToast(ADJUSTMENTS, `Reversed ${res.reversed}`);
}
