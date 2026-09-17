'use server';

import { requireAdmin } from '@/lib/authz';
import {
  accrueEarnedLeave,
  asOfForLeaveYear,
  type ArchivedLeaveTypeHint,
  type EarnedAccrualEmptyReason,
  type EarnedAccrualGroup,
} from '@/core/leave';
// The scope SHAPE stays where it was declared (feedback 2c7c6385) and is imported, not restated: two
// hand-written copies of the same four fields is how the preview and the commit come to disagree about
// what "all companies" means. Type-only, so nothing is pulled across the server-action boundary at runtime.
import type { EarnedAccrualScope } from '@/app/admin/actions';
import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * feedback cf9dcb98 (r285) — THE PREVIEW FOR THE RUN EARNED ACCRUAL SCREEN, WITH THE REASON ATTACHED.
 *
 * ⚠️ WHY THIS EXISTS BESIDE `previewEarnedAccrualAction` IN `app/admin/actions.ts`. That action returns
 * `{ rows, asOf }` and drops everything else the engine computed on the floor — including, now,
 * `emptyReason`, `archivedHint` and `earnedToDateTotal`. An empty preview is the ONLY interesting thing
 * the old shape could not carry, and it is exactly what the reporter was left staring at: "No
 * earned-accrual entitlement to generate for this scope", on an account where the type holding 163 ledger
 * rows had been archived the same morning and the type they COULD pick is not one this sweep covers.
 *
 * ⚠️ AND WHY THE REASON IS FORWARDED RATHER THAN RE-DERIVED. Every variant is decided inside
 * `accrueEarnedLeave`, at the exit that produced it, out of the values that exit was decided on. This
 * action passes it through untouched and computes nothing of its own; the screen renders it and computes
 * nothing of its own either. A second derivation — here or in the card — would be free to drift from the
 * filter it claims to explain, and would eventually describe a run the engine did not do.
 *
 * ⚠️ NOTHING ABOUT THE FIGURES MOVED. This is still `accrueEarnedLeave(..., { dryRun: true })`: the same
 * engine, the same scope, the same grouped breakdown, writing nothing. RLS still scopes the underlying
 * reads to the session's visible companies, so a group admin cannot preview outside their companies even
 * by hand-crafting a companyId.
 *
 * The COMMIT still posts through `runEarnedAccrualAction` in `app/admin/actions.ts`, unchanged: running
 * gained no new information, only the empty preview did. Both wrappers are four lines over one engine
 * call, and the pair should be collapsed into this file — the only screen that mounts either — by the
 * round that next has `app/admin/actions.ts` to itself. (`previewEarnedAccrualAction` must not simply be
 * deleted: `test/leave-earning-method-simplified.test.ts` slices that module on its export marker.)
 */
export async function previewEarnedAccrualWithReasonAction(scope: EarnedAccrualScope): Promise<{
  rows?: EarnedAccrualGroup[];
  asOf?: string;
  /** Present only when `rows` is empty; `null` where the engine could not name one (see the core type). */
  emptyReason?: EarnedAccrualEmptyReason | null;
  archivedHint?: ArchivedLeaveTypeHint[];
  /** Σ accrued to `asOf`. `rows` non-empty with 0 generated and this > 0 ⇒ already posted (idempotency). */
  earnedToDateTotal?: number;
  error?: string;
}> {
  const s = await requireAdmin();
  try {
    const asOf = asOfForLeaveYear(scope.year, todayInKualaLumpur());
    const { breakdown, emptyReason, archivedHint, earnedToDateTotal } = await accrueEarnedLeave(s, {
      asOf,
      companyIds: scope.companyIds,
      gradeIds: scope.gradeIds,
      leaveTypeIds: scope.leaveTypeIds,
      dryRun: true,
    });
    return { rows: breakdown, asOf, emptyReason, archivedHint, earnedToDateTotal };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
