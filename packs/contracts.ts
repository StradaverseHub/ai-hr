/**
 * Kernel contracts (ADR-0080 D9) — the narrow interfaces cross-module effects ride.
 *
 * Packs never import each other. Where module A's data legitimately feeds module B (unpaid leave
 * reduces pay, attendance OT feeds payroll input, claims pay out through payroll), the effect goes
 * through a KERNEL-owned contract: the consuming side resolves implementations from here by id;
 * the producing pack registers its implementation at module load (the same static-wiring
 * convention as `registerPack` in ./registry.ts — idempotent under dev HMR re-evaluation).
 *
 * This file is the contract HOME, owned by the shared spine — deliberately flat and narrow per the
 * ADR's anti-framework warning ("contracts added only when a real consumer exists — resist
 * speculative generality"). One contract exists today:
 *
 * ## PayrollInputContributor (established at rung 3, the Claims retrofit)
 *
 * The audited seam: a module holds approved, payable amounts (taxable claims; later
 * attendance-derived allowances, loan instalments, …) and queues them onto a DRAFT payroll batch
 * as `payroll_input` rows — today via per-module prefill buttons on the batch page
 * (`app/payroll/actions.ts`), each a distinct user action with its own toast. The contract mirrors
 * that exact shape: `contribute(ctx, { batchId })` performs the module's whole prefill
 * (idempotent, draft-only — the implementation's own rules, unchanged) and reports what it queued.
 * The payroll surface resolves a contributor BY ID (per-button consumption, matching today's UI);
 * `listPayrollInputContributors()` exists for the Payroll rung (7) when a combined
 * iterate-all-contributors path becomes real. Do not add lifecycle, priorities, or per-row hooks
 * here without a second real consumer.
 *
 * Registered contributors: 'claims' (packs/claims/payroll.ts, rung 3). Attendance's
 * allowance-transfer path (`transferAllowancesToBatch`) is the next candidate — it stays on its
 * rung-2 ratchet allowlist until it migrates (one seam per rung).
 */
import type { SessionContext } from '../db/client';

/** What a contributor queued onto the batch — the shape today's prefill actions report. */
export type PayrollInputContribution = {
  /** payroll_input rows created or updated (≙ employments/payslips touched). */
  applied: number;
  /** Module-side source records queued (e.g. individual claims reserved to the batch). */
  sourceCount: number;
  /** RM total queued. */
  total: number;
};

/**
 * A module pack's payroll-input production path (ADR-0080 D9). Implementations wrap the pack's
 * existing prefill service unchanged — the contract moves the SEAM, never the logic.
 */
export interface PayrollInputContributor {
  /** The contributing module pack's id (matches its ModulePack.id, e.g. 'claims'). */
  id: string;
  /**
   * Queue this module's approved amounts onto the DRAFT batch as payroll_input rows. Draft-only
   * and idempotent by the implementation's own rules; throws the implementation's own errors
   * (surfaced verbatim by the calling action — error text is user-visible behaviour).
   */
  contribute(ctx: SessionContext, p: { batchId: string }): Promise<PayrollInputContribution>;
}

const PAYROLL_INPUT_CONTRIBUTORS = new Map<string, PayrollInputContributor>();

/** Register a contributor (idempotent by id — static module-load wiring, like registerPack). */
export function registerPayrollInputContributor(c: PayrollInputContributor): void {
  PAYROLL_INPUT_CONTRIBUTORS.set(c.id, c);
}

/** Resolve one contributor by pack id (today's per-module prefill buttons consume this). */
export function payrollInputContributorById(id: string): PayrollInputContributor | undefined {
  return PAYROLL_INPUT_CONTRIBUTORS.get(id);
}

/** All registered contributors — for the Payroll rung's future iterate-all path. */
export function listPayrollInputContributors(): PayrollInputContributor[] {
  return [...PAYROLL_INPUT_CONTRIBUTORS.values()];
}
