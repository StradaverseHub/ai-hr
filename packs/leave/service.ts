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
// r90 (241817ef) — the approval-rule conversion, exposed here so its operator script consumes it through
// the facade like any other caller. The alternative was a fifth scripts/ entry in the audited debt
// allowlist, which is documented to only ever SHRINK; growing it to silence a guard would be the wrong
// direction. The four scripts already in there are pre-existing debt, not a precedent to extend.
export * from '../../core/leave-approval-consolidation';
export * from '../../core/leave-approval-template';
export * from '../../core/leave-compute';
export * from '../../core/leave-encashment';
export * from '../../core/leave-escalation';
export * from '../../core/leave-formula';
export * from '../../core/leave-import';
// 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT, the RECORD half of a migration (the line above is the
// BALANCE half). Re-exported here, and registered in BOTH BOUNDARIES and ALWAYS_ALLOWED in
// test/leave-pack-drift.test.ts, for the reason the 241817ef note above gives: a new leave-pack module
// that is not a BOUNDARY is simply unguarded, and silencing the guard with a pack-drift-allowlist entry
// would grow a list documented to only ever shrink. No allowlist entry is added — its only outside
// consumer is app/admin/leave-config/, which is already always-allowed.
export * from '../../core/leave-history-import';
// 56910869 — the Override Leave Application rule vocabulary. Re-exported here (and registered in BOTH
// BOUNDARIES and ALWAYS_ALLOWED in test/leave-pack-drift.test.ts) for the reason the 241817ef note above
// gives: a new leave-pack module that is not a BOUNDARY is simply unguarded, and silencing the guard with
// an allowlist entry would grow a list documented to only ever shrink.
export * from '../../core/leave-override';
// 491c499f — the bulk Leave Adjustments writer (batch apply + reversal + the set resolver). Consumed
// through this facade like every other leave service, never by reaching into core/ directly.
export * from '../../core/leave-adjustment';
export * from '../../core/toil';
// 296fc027 — the replacement-leave request eligibility resolver (the as-of `assignment` join that
// core/leave-org-criteria.ts documents as DEFERRED). In BOTH BOUNDARIES and ALWAYS_ALLOWED in
// test/leave-pack-drift.test.ts for the reason the 241817ef note above gives: a new leave-pack module that
// is not a BOUNDARY is simply unguarded, and silencing the guard with a pack-drift-allowlist entry would
// grow a list documented to only ever shrink.
export * from '../../core/replacement-eligibility';
// 296fc027 Step 2 — the employee request path (submit / decide / grant-on-approval). Same reasoning as
// the line above: a BOUNDARY so it is guarded, re-exported here so outside callers reach it through the
// facade rather than adding an entry to the audited debt allowlist.
export * from '../../core/replacement-request';
// r343 cbfa8b0b — the SINGLE-TABLE Leave Credit request: the four-option Day Type, the roster adjudication
// that refuses a row whose chosen type is not what the roster holds, and the submit that composes
// `submitReplacementLeaveRequest` rather than replacing it. Same registration discipline as the line above
// (BOUNDARIES + ALWAYS_ALLOWED in test/leave-pack-drift.test.ts, no allowlist entry).
export * from '../../core/leave-credit-request';
export * from '../../core/benefit-scheme';
// 6e9a126e RELEASE ONE — the entitlement redesign's new layer (named templates + eligibility rules) and
// the read-only record of what the eventual reset clears. Registered in BOTH BOUNDARIES and ALWAYS_ALLOWED
// in test/leave-pack-drift.test.ts for the reason the notes above give: a new leave-pack module that is not
// a BOUNDARY is simply unguarded, and silencing the guard with an allowlist entry would grow a list
// documented to only ever shrink.
export * from '../../core/entitlement-template';
export * from '../../core/entitlement-archive';
// c8052ae3 — the read-only record of the leave_ledger rows the Medical / Hospitalization reset removes.
// Same registration discipline as the two lines above (BOUNDARIES + ALWAYS_ALLOWED in
// test/leave-pack-drift.test.ts, no allowlist entry): the only outside reader is app/admin/leave/, which
// is already always-allowed, and the correction SCRIPT deliberately imports none of this — it talks to
// db/schema and the SQL capture function directly, so an operator one-off never becomes a pack consumer.
export * from '../../core/leave-ledger-archive';
// 93249794 — the Generate Entitlement service. Outside callers reach it HERE, never through core/,
// which is what keeps it inside the pack boundary declared in test/leave-pack-drift.test.ts.
export * from '../../core/leave-generation';
