'use server';

import { requireAdmin } from '@/lib/authz';
import { previewLeaveGeneration, type LeaveGenerationResult } from '@/packs/leave/service';
import { orgCriteriaFromFields } from '@/core/org-criteria';

/**
 * 93249794 — Step ③'s live matched count and Step ④'s validation, in ONE call.
 *
 * READ-ONLY. It runs `previewLeaveGeneration`, which runs `openLeaveYear` with `dryRun: true`: no ledger
 * row, no domain event, no processing-log row. The `previewLeaveAdjustmentAction` /
 * `countEmployeesInScopeAction` precedent — a server action that answers rather than writes.
 *
 * ⚠️ THE WRITE ACTION IS NOT HERE. Process posts to `openLeaveYearAction` in app/admin/actions.ts, which
 * `test/leave-generate-page.test.ts` guards as the ONE route from a browser to the grant sweep. Adding a
 * second write action here would leave that guard asserting a fiction while the real path went unwatched.
 *
 * Guarded by `requireAdmin` like the write, because the answer is a per-employee entitlement breakdown and
 * that is emphatically not public. The route is registered in lib/permissions.ts, which is what makes the
 * guard checkable by test/function-access.test.ts.
 *
 * The criteria arrive as a loose `Record` from the browser and are normalised through the SAME
 * `orgCriteriaFromFields` the form post goes through, rather than trusted as-is. A preview computed from a
 * differently-parsed criteria object than the one the run will use is worse than no preview at all — and
 * this preview's whole claim is that it cannot differ from the run.
 */
export async function previewLeaveGenerationAction(p: {
  year: number;
  leaveTypeIds: string[];
  targetMode: 'criteria' | 'individual';
  criteria: Record<string, string[] | string>;
  employmentIds: string[];
}): Promise<LeaveGenerationResult> {
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
  return previewLeaveGeneration(s, {
    year: Number(p.year),
    leaveTypeIds: p.leaveTypeIds ?? [],
    targetMode: p.targetMode === 'individual' ? 'individual' : 'criteria',
    criteria,
    employmentIds: p.employmentIds ?? [],
  });
}
