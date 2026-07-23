/**
 * Claims service facade (ADR-0080 D11 criterion 3, rung 3).
 *
 * The ONE module outside-the-pack callers import for claims services. It re-exports the pack's
 * implementation file in place — physical file moves are explicitly optional per D11; the
 * boundary is import discipline, enforced by test/claims-pack-drift.test.ts: any file outside the
 * pack surface importing `core/claims` directly (instead of this facade) fails the ratchet unless
 * it is audited kernel-contract debt (the "claims" allowlist in test/pack-drift-allowlist.json —
 * see packs/claims/index.ts for who and why). The payroll payout path deliberately does NOT use
 * this facade either: it rides the `PayrollInputContributor` kernel contract
 * (packs/contracts.ts + ./payroll — ADR-0080 D9).
 *
 * Server-only in practice (drags in db/client) — never import from client components; the pack's
 * client-safe declaration is `packs/claims/index.ts`.
 */
export * from '../../core/claims';
