/**
 * Performance service facade (ADR-0080 D11 criterion 3, rung 4).
 *
 * The ONE module outside-the-pack callers import for performance services. It re-exports the
 * pack's implementation file in place — physical file moves are explicitly optional per D11; the
 * boundary is import discipline, enforced by test/performance-pack-drift.test.ts: any file
 * outside the pack surface importing `core/performance` directly (instead of this facade) fails
 * the ratchet unless it is audited kernel-contract debt (the "performance" allowlist in
 * test/pack-drift-allowlist.json — see packs/performance/index.ts for who and why).
 *
 * Server-only in practice (drags in db/client) — never import from client components; the pack's
 * client-safe declaration is `packs/performance/index.ts`.
 */
export * from '../../core/performance';
