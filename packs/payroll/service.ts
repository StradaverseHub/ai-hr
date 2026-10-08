/**
 * Payroll service facade (ADR-0080 D11 criterion 3, rung 7 — the money path, the final retrofit).
 *
 * The ONE module outside-the-pack callers import for payroll services. It re-exports the pack's
 * twenty implementation files in place — physical file moves are explicitly optional per D11; the
 * boundary is import discipline, enforced by test/payroll-pack-drift.test.ts: any file outside the
 * pack surface importing `core/payroll` / `core/payroll-*` / `core/pay-*` / `core/cp38` /
 * `core/ea-override` / `core/tax-relief` / `core/loans` / `core/loans-compute` /
 * `core/statutory-authority` directly (instead of this facade) fails the ratchet unless it is
 * audited kernel-contract debt (the "payroll" allowlist in test/pack-drift-allowlist.json — see
 * packs/payroll/index.ts for who and why).
 *
 * The pack's boundary modules import EACH OTHER freely and are always-allowed by the guard; this
 * facade is the sanctioned path for everyone ELSE. Cross-module WRITES into payroll ride kernel
 * contracts, not this facade: claims' taxable-payout prefill already rides the
 * `PayrollInputContributor` contract (packs/contracts.ts + packs/claims/payroll.ts, rung 3), which
 * the batch action consumes by id. The leave→payroll effects (unpaid-leave reduction, encashment
 * advisory) stay INLINE in core/payroll.ts by risk choice — see the pack header; they produce no
 * `payroll_input` row so the contributor contract does not model them.
 *
 * NOT re-exported here (audited spine / country, not payroll-module):
 *   - `core/comp.ts` — compensation is jurisdiction-neutral, effective-dated EMPLOYMENT-SPINE (set
 *     on hire/promote/movement; the `compensation` table is read by 10+ modules; it even houses
 *     `nextEmployeeCode`). Payroll READS comp, it does not own it — the rung-4 analogue of the
 *     employment-review / holidays spine calls. Stays kernel; `compensation` is a spine table.
 *   - the country statutory surface (`localization/my/**`, the MY statutory profile/rule tables and
 *     ADR-0020 statutory-pack distribution) — the COUNTRY axis, resolved through the registry.
 *
 * Server-only in practice (drags in db/client) — never import from client components; the pack's
 * client-safe declaration is `packs/payroll/index.ts`. Client widgets that need a payroll type
 * (e.g. `Tp1Row`, `LoanRow`) import the type directly and stay on the ratchet allowlist as debt
 * until a client-safe pack entry is cut, exactly like the country pack's `localization/my/client.ts`
 * split (rung 5b).
 */
export * from '../../core/payroll';
export * from '../../core/payroll-closed-runs';
export * from '../../core/payroll-cycle';
export * from '../../core/payroll-config';
export * from '../../core/payroll-policy';
export * from '../../core/payroll-policy-config';
export * from '../../core/payroll-individual-txn';
export * from '../../core/payroll-run-group';
export * from '../../core/payroll-view';
export * from '../../core/payroll-readiness';
export * from '../../core/payroll-history-import';
export * from '../../core/payroll-permissions-admin';
export * from '../../core/pay-components';
export * from '../../core/pay-rule';
export * from '../../core/pay-rule-ai';
export * from '../../core/cp38';
export * from '../../core/ea-override';
export * from '../../core/tax-relief';
// df35d60d — LHDN TP3, the PREVIOUS-employment record. Beside tax-relief on purpose: its Section D is
// the SAME relief schedule `tax-relief` exposes as TP1_ITEMS, read for a different employer.
export * from '../../core/tp3';
export * from '../../core/loans';
export * from '../../core/loans-compute';
export * from '../../core/statutory-authority';
// 2ef69d1e — Back Pay (Arrears): detection, the read-only difference engine, verify/approve/post/cancel.
export * from '../../core/back-pay';
