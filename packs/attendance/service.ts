/**
 * Attendance service facade (ADR-0080 D11 criterion 3, rung 2).
 *
 * The ONE module outside-the-pack callers import for attendance services. It re-exports the pack's
 * implementation files in place — physical file moves are explicitly optional per D11; the
 * boundary is import discipline, enforced by test/attendance-pack-drift.test.ts: any file outside
 * the pack surface importing `core/attendance*` / `core/clocking-location` directly (instead of
 * this facade) fails the ratchet unless it is audited kernel-contract debt (the "attendance"
 * allowlist in test/pack-drift-allowlist.json — see packs/attendance/index.ts for who and why).
 *
 * Server-only in practice (drags in db/client) — never import from client components; the pack's
 * client-safe declaration is `packs/attendance/index.ts`.
 */
export * from '../../core/attendance';
export * from '../../core/attendance-allowance';
export * from '../../core/attendance-derive';
export * from '../../core/attendance-device';
export * from '../../core/attendance-rule';
export * from '../../core/clocking-location';
// `DayContext` is exported (as the same literal union) by BOTH core/attendance and
// core/attendance-derive; the ambiguous star export would silently drop the name from the facade,
// so re-export it explicitly (explicit exports take precedence over star ambiguity).
export type { DayContext } from '../../core/attendance';
