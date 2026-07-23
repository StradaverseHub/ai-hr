/**
 * The claims pack's PayrollInputContributor (ADR-0080 D9 — the ladder's FIRST kernel contract,
 * established at rung 3).
 *
 * A thin wrapper over the UNCHANGED `prefillClaimsForBatch` (core/claims.ts): approved TAXABLE
 * claims within the batch's claim cut-off window are summed into `payroll_input.claim_allowance`
 * and reserved onto the draft batch (idempotent, draft-only, scope-narrowed — all the
 * implementation's own rules, byte-identical to before this seam existed). The contract moves the
 * SEAM, not the logic: the payroll surface (`app/payroll/actions.ts`) no longer imports
 * `core/claims`; it resolves this contributor by id through the kernel's contract home
 * (`packs/contracts.ts`). The only translation here is vocabulary — the implementation reports
 * `claims` (its domain word for source records); the contract calls that `sourceCount`.
 *
 * Server-only (drags in db/client via core/claims) — the consumer side-effect-imports this file
 * (static module-load registration, the D8 wiring convention; idempotent under dev HMR).
 */
import { registerPayrollInputContributor, type PayrollInputContributor } from '../contracts';
import { prefillClaimsForBatch } from '../../core/claims';

export const claimsPayrollInputContributor: PayrollInputContributor = {
  id: 'claims',
  async contribute(ctx, p) {
    const { applied, claims, total } = await prefillClaimsForBatch(ctx, p);
    return { applied, sourceCount: claims, total };
  },
};

registerPayrollInputContributor(claimsPayrollInputContributor);
