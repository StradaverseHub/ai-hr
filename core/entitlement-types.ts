/**
 * The entitlement value types — ADR-0077 slice 2. A deliberate LEAF module: it imports nothing.
 *
 * WHY THIS FILE EXISTS. `SessionContext` (db/client.ts) has to carry the snapshot, and the resolver
 * (core/entitlements.ts) has to take a `SessionContext`. Round 1 review caught that the first attempt
 * broke that knot by typing the field `unknown` on SessionContext and narrowing it in the resolver —
 * which inverts the intended guard: `unknown` is not assignable to `EntitlementSnapshot | undefined`,
 * so `isModuleEnabled(getSession()result, …)` was a COMPILE ERROR while a bare object literal (every
 * field optional) type-checked fine. Every slice-3 gate would have needed `as EntitledContext`, and a
 * cast at each gate is precisely what makes the unresolved/exempt discipline unenforceable.
 *
 * A leaf module both sides import has no cycle to break, so the field can be typed concretely and the
 * session's own return type flows into a gate with no cast.
 */

/** One tenant's resolved commercial state. Plain data — safe to attach to a session and serialise. */
export type EntitlementSnapshot = {
  /**
   * WHOSE entitlements these are. Not decoration: a snapshot is a detachable object that gets spread
   * onto a context, and without this field a snapshot attached to the WRONG tenant's context is
   * undetectable — the resolver would answer another tenant's commercial questions with nothing to
   * catch it. Today there is exactly one producer (lib/session.ts's withEntitlements, which spreads
   * the same session it resolved for), so it is not reachable; slice 7's cross-tenant platform plane
   * and any future "act as tenant" path are precisely where a copied context becomes possible.
   * `snapshotOf` refuses a snapshot whose tenantId does not match the context's.
   */
  tenantId: string;
  /** Non-core module codes that resolve ENABLED right now (expiry and status already applied). */
  enabledModules: string[];
  /** Company-scoped grants: module code → the company ids it is scoped to. */
  scopedModules: Record<string, string[]>;
  /** Per-tenant setting values; keys absent here fall back to the catalog default. */
  settings: Record<string, unknown>;
  /** The tenant's standing — see TENANT_STATUS_* below. Slice 9's suspension overlay reads this. */
  tenantStatus: string;
};

/**
 * Is this really a snapshot? A RUNTIME check over the whole shape, elements included.
 *
 * Round 2 added a container-level guard (is `enabledModules` an array? is `scopedModules` an object?)
 * so a snapshot that lost a field across a serialisation boundary failed closed with a typed error
 * instead of a TypeError. Round 3 found that guard left exactly ONE fail-OPEN branch in the whole
 * resolver: it never validated the VALUES of `scopedModules`, and the resolver's company check is
 *
 *     (snap.scopedModules[code] ?? []).includes(companyId)
 *
 * so a STRING value there runs `String.prototype.includes` instead of `Array.prototype.includes` and
 * answers TRUE for any string CONTAINING the company id — or containing a mere substring of it
 * ('2222' matched a full uuid in the reproduction). Every other branch in the resolver can only answer
 * true from data it verified; this one could answer true by coincidence. Hence element-wise validation:
 * every enabled code is a string, every scoped value is an array OF strings.
 *
 * Arrays are rejected where an object-keyed map is expected (`settings`, `scopedModules`): an array is
 * an `object` to `typeof`, so the container check alone admitted one.
 */
export function isEntitlementSnapshot(v: unknown): v is EntitlementSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.tenantId !== 'string' || typeof s.tenantStatus !== 'string') return false;
  if (!Array.isArray(s.enabledModules) || !s.enabledModules.every((m) => typeof m === 'string')) return false;
  if (typeof s.settings !== 'object' || s.settings === null || Array.isArray(s.settings)) return false;
  const scoped = s.scopedModules;
  if (typeof scoped !== 'object' || scoped === null || Array.isArray(scoped)) return false;
  for (const companies of Object.values(scoped as Record<string, unknown>)) {
    if (!Array.isArray(companies) || !companies.every((c) => typeof c === 'string')) return false;
  }
  return true;
}

/**
 * The statuses that mean "this account may use what it bought". Migration 0313 constrains
 * `tenant.status` to ('active', 'trial', 'suspended', 'closed'), and this is deliberately an
 * ALLOW-list rather than a deny-list of the other two: a status added to that CHECK in a later
 * migration then defaults to CLOSED here instead of quietly resolving open.
 */
export const TENANT_STATUS_GOOD_STANDING: ReadonlySet<string> = new Set(['active', 'trial']);

/**
 * The status a snapshot carries when the tenant row could not be READ — as distinct from a row that
 * says 'suspended'.
 *
 * Round 1 review found the original `?? 'active'` was the single fail-OPEN branch in a fail-closed
 * resolver, and — because of the RLS defect fixed alongside it — the branch production always took:
 * an invisible row and a genuinely-active row were indistinguishable, so a SUSPENDED tenant read as
 * active. This sentinel keeps them distinguishable and, not being in TENANT_STATUS_GOOD_STANDING,
 * closes every billable module. It deliberately does NOT throw: this value is produced during
 * `getSession()`, and throwing there would take down authentication itself (including /login) rather
 * than the entitlement-gated features. Core modules still answer true, so the app stays navigable.
 */
export const TENANT_STATUS_UNRESOLVED = 'unresolved';

/**
 * The complete list of paths allowed to skip entitlement resolution, with the reason each is safe AND
 * the files that actually carry the marker. These are the writers F12 identified as never calling
 * `withTenant` with a real session.
 *
 * `owners` IS THE POINT OF THE STRUCTURED SHAPE (round 2). The first version was key → prose, pinned by
 * a test that asserted the five keys existed and that each reason was longer than thirty characters —
 * which passes identically whether or not one line of code consumes a marker. It did not: round 2 found
 * `entitlementsExempt` written nowhere outside this file, db/client.ts, the resolver and its own test,
 * while every path named here built a snapshot-less context by hand. So the list described code that
 * did not exist, and slice 2's "no legitimate path throws today" was true only because slice 2 installs
 * no gates — the first gate slice 3 adds inside a sweep would have taken every nightly cron down.
 *
 * The markers are now applied (see each `owners` entry), and `test/entitlement-resolver.test.ts` READS
 * each named file and asserts it literally contains `entitlementsExempt: '<key>'`. An exemption can no
 * longer name a call site that does not carry it, and deleting the marker from a sweep fails the suite
 * rather than surfacing as a 3am cron failure after slice 3.
 *
 * WHAT A MARKER COSTS, STATED SO SLICE 3 CANNOT WALK INTO IT (round 3). The marker means "entitlements
 * do not apply to me", and that answers the two questions differently:
 *   - `isModuleEnabled` → TRUE (open). A module is a gate, and an exempt caller is not gated.
 *   - `getSetting`      → THE CATALOG DEFAULT, not the tenant's configured value. A setting is a VALUE,
 *     and there is no "open" for a value; the only answer available without a snapshot is the default.
 *     Every catalogued default is `false` today, so a marked caller reads every setting as OFF.
 * That is a trap for exactly one shape of caller: a sweep that ends up BEHIND a setting. The concrete
 * case is `scripts/feedback-plan.ts` and `feedback.ai_planning_enabled` (default false) — the moment
 * slice 3 swaps that env read for `settingEnabled(ctx, …)` the cron silently plans nothing. The fix is
 * NOT to let an exempt context read settings optimistically (that would invent a value no operator set);
 * it is for such a sweep to resolve a REAL snapshot with `resolveEntitlementsTx` and DROP its marker.
 * The resolver refuses a context carrying BOTH, so that swap cannot be left half-done.
 */
export const ENTITLEMENTS_EXEMPT_REASONS = {
  provisioning: {
    why: 'db/provision.ts — creates the tenant; its entitlements do not exist yet by definition.',
    owners: ['db/provision.ts'],
  },
  seeding: {
    why: 'db/seed.ts and scripts/seed-catalogs.ts — bootstrap, owner role, no session.',
    owners: ['db/seed.ts'],
  },
  sweeps: {
    why: 'scripts/*.ts cron sweeps — synthetic contexts; slice 9 gives them the by-tenantId resolver.',
    owners: [
      'scripts/accrue-earned.ts',
      'scripts/expire-aged-leave.ts',
      'scripts/expire-carry.ts',
      'scripts/review-sweep.ts',
      'scripts/feedback-plan.ts',
      'scripts/backfill-basic-components.ts',
      'scripts/correct-hrdf-opt-outs.ts',
    ],
  },
  harness: {
    why: 'test/harness.ts — fixtures build contexts directly.',
    owners: ['test/harness.ts'],
  },
  /**
   * The ONE entry with no owner file yet, and deliberately so: slice 7 builds the platform plane. It is
   * declared here rather than added later because the resolver's membership check has to know the full
   * vocabulary — but the drift test treats an empty `owners` as "not yet wired" and pins THAT, so this
   * cannot quietly become a second unwired exemption.
   */
  platform: {
    why: 'The platform plane (slice 7) — operates ACROSS tenants and is gated by its own role.',
    owners: [] as readonly string[],
  },
} as const;

/** The exemption markers `entitlementsExempt` may carry. Enforced at runtime too, not just in types. */
export type EntitlementsExemptReason = keyof typeof ENTITLEMENTS_EXEMPT_REASONS;

/** Runtime membership test — the types alone cannot stop a hand-built or deserialised context. */
export function isExemptReason(v: string): v is EntitlementsExemptReason {
  return Object.prototype.hasOwnProperty.call(ENTITLEMENTS_EXEMPT_REASONS, v);
}
