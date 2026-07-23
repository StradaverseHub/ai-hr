/**
 * Leave service facade (ADR-0080 D11 criterion 3, rung 6 — the second-largest module).
 *
 * The ONE module outside-the-pack callers import for leave services. It re-exports the pack's
 * implementation files in place — physical file moves are explicitly optional per D11; the boundary
 * is import discipline, enforced by test/leave-pack-drift.test.ts: any file outside the pack surface
 * importing `core/leave` / `core/leave-*` / `core/toil` / `core/benefit-scheme` directly (instead of
 * this facade) fails the ratchet unless it is audited kernel-contract debt (the "leave" allowlist in
 * test/pack-drift-allowlist.json — see packs/leave/index.ts for who and why).
 *
 * The pack's boundary modules (the leave engine, its approval/entitlement/encashment/TOIL/import
 * satellites, and the benefit-scheme entitlement-config layer) import EACH OTHER freely and are
 * always-allowed by the guard; this facade is the sanctioned path for everyone ELSE.
 *
 * NOT re-exported here (audited spine, not leave-pack): `core/holidays.ts`. The editable holiday
 * system is shared spine — consumed by attendance (working-day math), leave (span counting) AND
 * payroll (rest-day/OT classification, s.60D completeness) — so it is kernel, not a leave service
 * (ADR-0080 open decision 3; the country pack contributes only SEED calendars via
 * `seedReferenceData`, landed rung 5c). Same disposition the attendance pack already gave it.
 *
 * Server-only in practice (drags in db/client) — never import from client components; the pack's
 * client-safe declaration is `packs/leave/index.ts`. Client widgets that need the pure entitlement
 * math import the client-safe helpers directly (e.g. `core/leave-compute`'s `previewEntitlement`) —
 * they stay on the ratchet allowlist as debt until a client-safe pack entry is cut, exactly like the
 * country pack's `localization/my/client.ts` split (rung 5b).
 */
export * from '../../core/leave';
export * from '../../core/leave-approval-policy';
export * from '../../core/leave-approval-template';
export * from '../../core/leave-compute';
export * from '../../core/leave-encashment';
export * from '../../core/leave-escalation';
export * from '../../core/leave-formula';
export * from '../../core/leave-import';
export * from '../../core/toil';
export * from '../../core/benefit-scheme';
