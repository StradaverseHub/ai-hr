/**
 * ADR-0077 slice 5 — what stands in the way of turning a module OFF.
 *
 * DEACTIVATION IS TWO PHASE, and the phases exist for a specific reason: switching a module off while
 * work is in flight strands that work somewhere nobody looks again. An open review cycle whose module
 * disappears cannot be closed; a draft payroll batch cannot be processed; banked TOIL a customer earned
 * cannot be re-tuned. So the operator is shown what is in flight and records a DISPOSITION — what should
 * happen to it — and only then does the runner act.
 *
 * WHY ENUMERATE RATHER THAN REFUSE OUTRIGHT. A customer who has stopped paying for a module is entitled
 * to stop paying for it; blocking deactivation forever because one review cycle is open would make the
 * product hold them hostage. The pre-check exists so the decision is INFORMED and RECORDED, not so it is
 * prevented.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not stop obligations already incurred. TOIL's
 * convert-to-pay floors and promised comp enactments keep executing regardless of entitlement state
 * (D4) — `core/toil.ts` already implements exactly that, and its comment at the top of
 * `setToilPolicy` is the reasoning: winding down needs the ledger and the sweeps; it does not need to
 * re-tune FUTURE accrual, which is what the entitlement governs. A blocker here is a thing to decide
 * about, never a thing this module quietly finishes on the customer's behalf.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

/** One kind of in-flight work that deactivating this module would strand. */
export type DeactivationBlocker = {
  /** Stable identifier the operator's disposition is keyed by. */
  kind: 'open_review_cycle' | 'unenacted_recommendation' | 'active_toil_accrual' | 'draft_payroll_batch';
  count: number;
  /** What the operator is actually deciding about, in their terms. */
  detail: string;
};

export type DeactivationScope = {
  tx: Tx;
  tenantId: string;
  moduleCode: string;
  /** Narrow the check to one company when the grant being revoked is company-scoped. */
  companyId: string | null;
};

/**
 * Which blockers are worth checking for a given module. Checking everything for every module would
 * report an open review cycle as a reason to think twice about turning off TOIL, which is noise — and
 * noise in a confirmation screen is how operators learn to click through them.
 */
export async function deactivationBlockers(s: DeactivationScope): Promise<DeactivationBlocker[]> {
  const rows = await s.tx.execute<{ blockers: DeactivationBlocker[] }>(sql`
    select app.module_deactivation_blockers(${s.tenantId}::uuid,${s.moduleCode},${s.companyId}::uuid) as blockers
  `);
  return rows[0]?.blockers ?? [];
}

/** Every blocker the operator has to have answered, given the disposition they recorded. */
export function unansweredBlockers(
  blockers: DeactivationBlocker[],
  disposition: Record<string, string> | null,
): DeactivationBlocker[] {
  if (!disposition) return blockers;
  // A blank answer is not an answer: an empty string is what an unfilled form field sends.
  return blockers.filter((b) => !(disposition[b.kind] ?? '').trim());
}
