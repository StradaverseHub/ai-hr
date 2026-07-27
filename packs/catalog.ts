/**
 * The MODULE and SETTING catalogs — the code-side source of truth for what this installation can sell
 * and what can be configured per customer (ADR-0077; slice 1 of the platform program).
 *
 * WHY THIS IS NOT DERIVED FROM `listPacks('module')`
 * --------------------------------------------------
 * The catalog and the pack registry are NOT the same set, and conflating them was the plan's first
 * error. A `ModulePack` is a CODE identity — nav descriptors, satellite tables, a service facade. A
 * catalog row is a COMMERCIAL identity — a thing a customer buys. The two diverge in both directions:
 *
 *   - `toil` is a billable module (ADR-0077 §5) with NO pack: `core/toil.ts` is a service of the Leave
 *     pack and its tables are declared Leave satellites (packs/leave/index.ts:153-154). Same for
 *     `multi_cycle_payroll` and `typed_pay_components`, which are behaviours inside the Payroll pack.
 *   - `leave` HAS a pack but is CORE — never billable, never disableable, or a customer could switch
 *     off Leave and brick ESS.
 *
 * So sub-modules carry `parentModule` (the pack whose service they live in) and `packBacked: false`,
 * while a row that IS a pack carries `packBacked: true` and its `code` equals the `ModulePack.id`.
 * `test/module-catalog-drift.test.ts` pins that correspondence in both directions, so adding a pack
 * without a catalog row — or pointing a row at a pack that does not exist — fails the suite.
 *
 * SEEDING. Never at migrate time: migrations are pure SQL and SQL cannot read this file. One idempotent
 * TypeScript seeder (`scripts/seed-catalogs.ts`) is run by every bootstrap — deploy.sh, the test
 * template build, cleanroom-verify.sh, and db:seed. See that file's header for the four call sites.
 */

/** A thing a customer can be entitled to. `code` is the key `tenant_module.module_code` joins on. */
export type ModuleCatalogEntry = {
  code: string;
  name: string;
  /** Grouping for the platform console + the customer Apps page. */
  category: 'core' | 'hr' | 'payroll' | 'platform';
  description: string;
  /** Codes that must ALSO be active for this one to function (slice 2 ANDs the closure). */
  dependsOn: string[];
  /** False for core modules: they are never sold, never metered, and never disableable. */
  billable: boolean;
  /**
   * Core modules get NO `tenant_module` rows at all — `isModuleEnabled` answers true from this
   * constant without touching the database, and a trigger refuses to insert a row for one. A tenant
   * with zero entitlement rows therefore still has Leave and ESS (slice 1 verification).
   */
  isCore: boolean;
  /** The pack whose service this behaviour lives inside; null when the row IS a pack (or is core). */
  parentModule: string | null;
  /** True when `code` is a registered `ModulePack.id`. Pinned by the drift test in both directions. */
  packBacked: boolean;
  sortOrder: number;
};

/**
 * Who may write a setting's value.
 *
 * This is the distinction that lets EVERY deployment-wide flag move into the database — the product
 * requirement — without making audit integrity customer-controllable. `platform` rows are visible to
 * the customer and writable only by Stradaverse; the rule is enforced by the `tenant_setting` write
 * policy in Postgres, not by application code, so it holds for any path that reaches the table.
 */
export type SettingScope = 'tenant' | 'platform';

export type SettingCatalogEntry = {
  key: string;
  /** The module that owns this setting; null = installation-wide. */
  moduleCode: string | null;
  scope: SettingScope;
  valueType: 'boolean' | 'number' | 'string' | 'json';
  /** Used when a tenant has no row (slice 2's resolver falls back to this — never a silent false). */
  defaultValue: unknown;
  /** Applied as a real row when the owning module is INSTALLED, so a purchase arrives usable. */
  defaultOnInstall: unknown;
  /** False hides it from the customer settings screen entirely (still readable by the platform). */
  customerVisible: boolean;
  description: string;
  sortOrder: number;
};

/**
 * CORE — always on, never billable, no rows. ADR-0077 §5's list.
 *
 * `employees`, `org`, `ess`, `approvals` and `knowledge_base` have no pack today; they are the spine
 * every other module reads. They are catalogued anyway so the platform console can SHOW a customer
 * what they have, and so `dependsOn` can name them.
 */
export const MODULE_CATALOG: ModuleCatalogEntry[] = [
  { code: 'employees', name: 'Employees', category: 'core', description: 'Person and employment records — the spine every module reads.', dependsOn: [], billable: false, isCore: true, parentModule: null, packBacked: false, sortOrder: 10 },
  { code: 'org', name: 'Organization', category: 'core', description: 'Companies, departments, positions, grades and the reporting structure.', dependsOn: [], billable: false, isCore: true, parentModule: null, packBacked: false, sortOrder: 20 },
  { code: 'leave', name: 'Leave', category: 'core', description: 'Leave types, entitlement, applications and balances.', dependsOn: ['employees'], billable: false, isCore: true, parentModule: null, packBacked: true, sortOrder: 30 },
  { code: 'ess', name: 'Employee Self-Service', category: 'core', description: 'The employee-facing workspace.', dependsOn: ['employees'], billable: false, isCore: true, parentModule: null, packBacked: false, sortOrder: 40 },
  { code: 'approvals', name: 'Approvals', category: 'core', description: 'Approval workflows and the pending-decision queue.', dependsOn: [], billable: false, isCore: true, parentModule: null, packBacked: false, sortOrder: 50 },
  { code: 'knowledge_base', name: 'Knowledge Base', category: 'core', description: 'Company handbook and guides.', dependsOn: [], billable: false, isCore: true, parentModule: null, packBacked: false, sortOrder: 60 },

  // ── Billable, pack-backed: code === ModulePack.id ──────────────────────────────────────────────
  { code: 'payroll', name: 'Payroll', category: 'payroll', description: 'Payroll processing, payslips and statutory contributions.', dependsOn: ['employees'], billable: true, isCore: false, parentModule: null, packBacked: true, sortOrder: 100 },
  { code: 'attendance', name: 'Attendance', category: 'hr', description: 'Clock-in, rosters, shifts and attendance records.', dependsOn: ['employees'], billable: true, isCore: false, parentModule: null, packBacked: true, sortOrder: 110 },
  { code: 'claims', name: 'Claims', category: 'hr', description: 'Expense claims, approval and payout.', dependsOn: ['employees'], billable: true, isCore: false, parentModule: null, packBacked: true, sortOrder: 120 },
  { code: 'performance', name: 'Performance', category: 'hr', description: 'Review cycles, goals and compensation recommendations.', dependsOn: ['employees'], billable: true, isCore: false, parentModule: null, packBacked: true, sortOrder: 130 },

  // ── Billable sub-modules: a behaviour inside a parent pack's service, with NO pack of its own ───
  { code: 'toil', name: 'Time Off In Lieu', category: 'hr', description: 'Bank overtime as replacement leave instead of cash.', dependsOn: ['leave', 'attendance'], billable: true, isCore: false, parentModule: 'leave', packBacked: false, sortOrder: 200 },
  { code: 'multi_cycle_payroll', name: 'Multi-Cycle Payroll', category: 'payroll', description: 'More than one payroll cycle per company.', dependsOn: ['payroll'], billable: true, isCore: false, parentModule: 'payroll', packBacked: false, sortOrder: 210 },
  { code: 'typed_pay_components', name: 'Typed Pay Components', category: 'payroll', description: 'Structured, per-type pay components on the payslip.', dependsOn: ['payroll'], billable: true, isCore: false, parentModule: 'payroll', packBacked: false, sortOrder: 220 },
  { code: 'notifications', name: 'Notifications', category: 'platform', description: 'In-app notification centre and task alerts.', dependsOn: [], billable: true, isCore: false, parentModule: null, packBacked: false, sortOrder: 230 },
];

/**
 * SETTINGS — the per-tenant behaviour values.
 *
 * The three `platform`-scoped rows here are the ones that must NOT be customer-writable, and the
 * reasoning is recorded per row rather than in a design doc nobody reads at 2am:
 *   - the two payroll risk switches reopen or wipe a finalised payroll run, and
 *   - `audit_hash_chain` is the tamper-evidence itself.
 * A customer sees each of them; only Stradaverse changes them. `defaultOnInstall: false` on the risk
 * switches is deliberate — a purchased module must never arrive with an escape hatch already open,
 * even though the demo deployment has all three env flags ON today (F4).
 *
 * That last clause is about NEW installs only. An ALREADY-PROVISIONED tenant keeps what it has via
 * `LEGACY_ENABLED_SETTINGS` below, which 0313 backfills — `defaultOnInstall` never fires for a tenant
 * that was provisioned before the setting existed, so the two mechanisms are not interchangeable.
 */
export const SETTING_CATALOG: SettingCatalogEntry[] = [
  { key: 'payroll.reset_enabled', moduleCode: 'payroll', scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Allow reverting a processed payroll run to draft. Weakens payroll controls; enabling is an audited platform action.', sortOrder: 10 },
  { key: 'payroll.unlock_enabled', moduleCode: 'payroll', scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Allow unlocking a closed payroll run back to processed. Reverses the statutory freeze; enabling is an audited platform action.', sortOrder: 20 },
  { key: 'payroll.individual_txn_pay_enabled', moduleCode: 'payroll', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Let the payroll kernel pay and deduct the one-off transaction ledger, instead of keeping it record-only.', sortOrder: 30 },
  { key: 'audit.hash_chain_enabled', moduleCode: null, scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Tamper-evident hash chaining over the audit log. Integrity control — Stradaverse-managed, and one-way once enabled (slice 8).', sortOrder: 100 },
  { key: 'feedback.ai_planning_enabled', moduleCode: null, scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: false, description: 'In-app AI drafting of improvement plans. Operator tooling, not a customer feature.', sortOrder: 110 },
];

/**
 * ── THE PARITY MAPPING ──────────────────────────────────────────────────────────────────────────
 *
 * What this deployment ALREADY HAS ON today, before anything reads an entitlement row. This is the
 * single definition of "what a customer already has", and it is what makes slice 3's flip from env
 * reads to entitlement reads a no-op rather than a silent downgrade.
 *
 * IT IS DERIVED FROM THE FLAGS THE REPOSITORY ACTUALLY SHIPS, not from what looks reasonable. Two
 * TRACKED files decide it, and `test/module-catalog-drift.test.ts` reads BOTH and pins the sets below
 * against them in both directions:
 *   - `.env.example`                 — what a fresh install copies.
 *   - `deploy/enable-demo-flags.sh`  — what the running deployment is actually set to.
 * A flag counts as ON when EITHER file turns it on.
 *
 * That ratchet exists because the first version of this constant excluded `multi_cycle_payroll` and
 * `typed_pay_components` on the stated grounds that "a fresh install does not carry them" — while
 * .env.example:38-39 carries both, uncommented and set true, and enable-demo-flags.sh:29-30 sets both
 * on the server. Since the 0313 backfill is ONE-SHOT and slice 2's resolver is fail-closed, that
 * omission would have switched Multi-Cycle Payroll and Typed Pay Components OFF on the live
 * deployment at slice 3 — the exact regression the parity set exists to prevent — and the suite would
 * have stayed green, because test/env.ts deletes both vars so "no row = off" matches the TEST
 * environment perfectly. Prose cannot be trusted with this mapping; a test reading the env files can.
 */

/**
 * The env var that gates each SELLABLE module TODAY. `null` = no whole-module gate anywhere in the
 * tree (F20), i.e. the module is on for everyone and a parity row is mandatory.
 *
 * Every non-core catalog code must appear here, so a new billable module cannot be added without
 * someone answering "what turns this on today?". The drift test asserts that coverage.
 */
export const LEGACY_MODULE_ENV_GATES: Readonly<Record<string, string | null>> = {
  payroll: null,
  attendance: null,
  claims: null,
  performance: null,
  notifications: 'NOTIFICATIONS_ENABLED',
  multi_cycle_payroll: 'MULTI_CYCLE_PAYROLL_ENABLED',
  typed_pay_components: 'TYPED_PAY_COMPONENTS_ENABLED',
  // TOIL_ENABLED is set in NO tracked env file, so `toil` stays out of the parity set. A missing row
  // is disabled (C7), which is exactly today's behaviour for it.
  toil: 'TOIL_ENABLED',
};

/** The env var that gates each catalogued SETTING today. Same coverage rule, same drift assertion. */
export const LEGACY_SETTING_ENV_GATES: Readonly<Record<string, string>> = {
  'payroll.reset_enabled': 'PAYROLL_RESET_ENABLED',
  'payroll.unlock_enabled': 'PAYROLL_UNLOCK_ENABLED',
  'payroll.individual_txn_pay_enabled': 'INDIVIDUAL_TXN_PAY_ENABLED',
  'audit.hash_chain_enabled': 'AUDIT_HASH_CHAIN_ENABLED',
  'feedback.ai_planning_enabled': 'FEEDBACK_AI_PLANNING_ENABLED',
};

/**
 * Gates slice 3 deliberately did NOT migrate, mapped to the slice that owns removing them.
 *
 * `audit.hash_chain_enabled` is not an oversight and not laziness: it is read inside `withTenant`
 * itself (db/client.ts:83) to arm a per-transaction GUC — that is, it is consulted while BUILDING the
 * very transaction an entitlement snapshot would have to be resolved in. Answering it from that
 * snapshot is circular. ADR-0077 also sequences it behind the ADR-0030 redaction migration and
 * chain-head anchoring, because turning the chain on per-tenant before those land would produce
 * chains nobody can verify. So it stays a deployment-level env read until slice 8.
 *
 * This is NOT an exemption list to grow when a migration gets awkward. An entry means "still env, on
 * purpose, with a named slice that removes it", and it is policed from both sides:
 * test/module-catalog-drift.test.ts asserts every entry here is GENUINELY still read by application
 * code, so migrating one without deleting its entry fails the suite rather than quietly leaving a
 * stale carve-out behind.
 */
export const DEFERRED_ENV_GATES: Readonly<Record<string, string>> = {
  'audit.hash_chain_enabled':
    'slice 8 — read inside withTenant to arm the chain GUC (circular vs. the snapshot), and sequenced behind ADR-0030 redaction + chain-head anchoring',
};

/**
 * The modules a tenant that predates the entitlement substrate must end up entitled to. Three places
 * must agree on it and all three derive from this constant:
 *
 *   1. `db/migrations/0313_module_entitlements.sql` — the one-shot BACKFILL for tenants that already
 *      exist. (SQL cannot import TypeScript, so the codes are repeated there as literals; the test
 *      `the 0313 backfill grants exactly the parity set` reads the file and pins them to this list.)
 *   2. `db/seed.ts` — the demo tenant, which is created after migrations and so misses the backfill.
 *   3. `test/harness.ts` seedBase — every test tenant.
 *
 * (2) and (3) run inside a real process and therefore use `legacyEnabledModulesIn(process.env)`, which
 * narrows this list to what that process's env ACTUALLY has on — see that function's note. Only the
 * migration takes the list whole, because SQL cannot read an env var.
 *
 * CORE modules are never here: they take no row at all (the 0313 trigger refuses one).
 */
export const LEGACY_ENABLED_MODULE_CODES: readonly string[] = [
  'payroll',
  'attendance',
  'claims',
  'performance',
  'notifications',
  'multi_cycle_payroll',
  'typed_pay_components',
];

/**
 * The SETTINGS this deployment runs with today, and their value. The module axis is not the whole
 * parity story: three payroll behaviours are env flags that are ON right now, and every
 * `setting_definition.default_value` is `false`, so a tenant with no row resolves to OFF. Without
 * these rows slice 3 switches payroll reset, payroll unlock and individual-transaction pay off on the
 * live deployment — the same failure as the module axis, one table over.
 *
 * `defaultOnInstall: false` does NOT cover this: it applies when a module is INSTALLED (slice 7),
 * which never happens for an already-provisioned tenant.
 *
 * Backfilled with `source='platform'`: these are deployment decisions that were made by Stradaverse,
 * not values a customer chose. For the tenant-scoped key that provenance is advisory — a customer
 * admin may still overwrite it, which is the point of a tenant-scoped setting.
 *
 * DELIBERATELY ABSENT:
 *   - `audit.hash_chain_enabled` — off in .env.example and set by no deploy script, so parity is OFF.
 *     It would stay out even if a deployment had it on: ADR-0030 §3 says enabling the chain on an
 *     existing database needs a one-time backfill of historical events, so a seeder must never flip it.
 *   - `feedback.ai_planning_enabled` — operator tooling, set in no tracked env file.
 */
export const LEGACY_ENABLED_SETTINGS: Readonly<Record<string, unknown>> = {
  'payroll.reset_enabled': true,
  'payroll.unlock_enabled': true,
  'payroll.individual_txn_pay_enabled': true,
};

/** A `process.env`-shaped bag. Taken as a parameter so this module never touches `process` itself. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The parity set as ONE PROCESS's environment actually sees it.
 *
 * The deployment set and the set a given process runs with are NOT the same, and pretending otherwise
 * is how a "parity" fixture ends up making the suite agree with itself while production diverges —
 * or the reverse. test/env.ts deletes MULTI_CYCLE_PAYROLL_ENABLED and TYPED_PAY_COMPONENTS_ENABLED so
 * the suite exercises the legacy payroll path; seeding an ACTIVE row for them into every test tenant
 * would therefore be the OPPOSITE of parity — it would switch multi-cycle payroll on for 299 test
 * files the moment slice 3 lands. Filtering by the live env is what keeps the row and the flag saying
 * the same thing in every environment, including the ones that opt a flag in per-test.
 */
export function legacyEnabledModulesIn(env: EnvLike): string[] {
  return LEGACY_ENABLED_MODULE_CODES.filter((code) => {
    const gate = LEGACY_MODULE_ENV_GATES[code];
    return gate === null || env[gate] === 'true';
  });
}

/** The setting rows this process's environment says are on. Same argument as the module helper. */
export function legacyEnabledSettingsIn(env: EnvLike): { key: string; value: unknown }[] {
  return Object.entries(LEGACY_ENABLED_SETTINGS)
    .filter(([key]) => env[LEGACY_SETTING_ENV_GATES[key]] === 'true')
    .map(([key, value]) => ({ key, value }));
}

/**
 * The `tenant_setting` rows a NEWLY provisioned tenant should arrive with, given the modules it bought.
 *
 * THE DISTINCTION THIS EXISTS TO KEEP, because slice 3 briefly collapsed it (review r2). There are two
 * different questions and they have two different answers:
 *
 *   - "What does a tenant that ALREADY EXISTS have today?"  → `legacyEnabledSettingsIn(env)`. Parity.
 *     A tenant that has been running on `.env.production` must not lose a behaviour at the flip. That is
 *     0313's backfill for tenants that predate it, and `scripts/reconcile-entitlement-parity.ts` for the
 *     ones created after it ran.
 *   - "What should a tenant created TOMORROW arrive with?"  → `defaultOnInstall`. Product policy.
 *
 * Answering the second question with the first hands every new customer whatever the box happens to be
 * booted with — and on the live deployment that is `payroll.reset_enabled` and `payroll.unlock_enabled`,
 * i.e. every new customer arrives able to revert a processed payroll run and unlock a closed one. The
 * SETTING_CATALOG note above says the opposite in as many words: `defaultOnInstall: false` on the risk
 * switches is deliberate, "a purchased module must never arrive with an escape hatch already open, even
 * though the demo deployment has all three env flags ON today", and it confines the parity argument to
 * an ALREADY-PROVISIONED tenant. Both switches are `scope='platform'`, so 0313's write policy forbids
 * `ai_hr_app` from ever deleting them — the customer could not close a hatch opened this way, and the
 * plane that could is slice 7.
 *
 * Filtered by the picked modules because that is what `defaultOnInstall` means — "applied when the
 * owning module is INSTALLED". An installation-wide setting (`moduleCode: null`) is nobody's purchase
 * and is left to its catalog default.
 */
export function settingsOnInstallFor(moduleCodes: readonly string[]): { key: string; value: unknown }[] {
  const picked = new Set(moduleCodes);
  return SETTING_CATALOG.filter((s) => s.moduleCode !== null && picked.has(s.moduleCode)).map((s) => ({
    key: s.key,
    value: s.defaultOnInstall,
  }));
}

/** Core module codes — the set `isModuleEnabled` answers true for without a query (slice 2). */
export const CORE_MODULE_CODES: readonly string[] = MODULE_CATALOG.filter((m) => m.isCore).map((m) => m.code);

/** Every catalogued code, for validating an operator's picks before a provision request is accepted. */
export const ALL_MODULE_CODES: readonly string[] = MODULE_CATALOG.map((m) => m.code);

/** The codes a customer can actually be sold — everything not core. */
export const SELLABLE_MODULE_CODES: readonly string[] = MODULE_CATALOG.filter((m) => !m.isCore).map((m) => m.code);

/**
 * What the operator console PRE-TICKS on the new-customer form: the sellable modules that no env var
 * gates anywhere in the tree today (F20), i.e. the ones every existing customer already runs.
 *
 * This exists because the console was the ONE entitlement writer with no parity story. The other three
 * (0313's backfill, db/seed.ts, test/harness.ts seedBase) all derive from LEGACY_ENABLED_MODULE_CODES;
 * `provisionTenant` inserts exactly what the operator ticked and nothing else, and the form shipped with
 * every box empty. A customer created between slice 1 and slice 3 on an untouched form would therefore
 * have gained payroll/attendance/claims/performance today (nothing gates them) and LOST all four the
 * moment slice 3's resolver started reading rows — a silent downgrade nobody would attribute.
 *
 * Pre-ticking rather than unioning inside `provisionTenant` is deliberate: an operator who deliberately
 * unticks Payroll must get a customer without Payroll, or the picker is theatre. The default states what
 * today's product includes; the operator still decides.
 *
 * Derived, not listed: `test/module-catalog-drift.test.ts` pins it against the gate map, so a module that
 * gains a gate (or loses one) changes the form default in the same commit.
 */
export const DEFAULT_PROVISION_MODULE_CODES: readonly string[] = SELLABLE_MODULE_CODES.filter(
  (code) => LEGACY_MODULE_ENV_GATES[code] === null,
);

/**
 * What the operator console pre-ticks ON THIS DEPLOYMENT — the constant above UNIONED with the modules
 * this process's env actually has switched on.
 *
 * THE CONSTANT ABOVE WAS ONLY HALF THE PARITY STORY, and the missing half is the same defect it was
 * written to fix. `DEFAULT_PROVISION_MODULE_CODES` covers the four modules NO env var gates, on the
 * reasoning that "every existing customer already runs them". But the live box also runs
 * NOTIFICATIONS_ENABLED, MULTI_CYCLE_PAYROLL_ENABLED and TYPED_PAY_COMPONENTS_ENABLED (see
 * deploy/enable-demo-flags.sh), so a customer provisioned from an untouched form since slice 1 has
 * ALSO been running those three — nothing read a row yet — and loses all three the moment slice 3's
 * resolver starts reading rows. `typed_pay_components` is the one that hurts: core/payroll.ts switches
 * the earnings source on it, so that tenant's next payslip run silently changes numbers.
 *
 * 0313's backfill cannot cover it — a migration runs once, and these tenants are created afterwards.
 *
 * Env-derived rather than listed, for the reason `legacyEnabledModulesIn` states: the deployment set
 * and the set a given process runs with are different, and pre-ticking a module this box does NOT run
 * would sell a capability that then resolves inert. Passed the env by the caller so this module still
 * never touches `process` itself.
 */
export function defaultProvisionModuleCodesIn(env: EnvLike): string[] {
  const set = new Set<string>([...DEFAULT_PROVISION_MODULE_CODES, ...legacyEnabledModulesIn(env)]);
  // Order by the catalog so the form's ticks are stable and the drift test can compare sorted sets.
  return SELLABLE_MODULE_CODES.filter((c) => set.has(c));
}

/**
 * The `dependsOn` codes a pick set fails to satisfy, transitively — empty when the set is coherent.
 *
 * `dependsOn` was declared in the catalog, seeded into `module.depends_on` and read by NOBODY. Slice 2
 * ANDs the closure when it resolves a module, so `multi_cycle_payroll` sold without `payroll`, or `toil`
 * without `attendance`, records a sale and inserts an ACTIVE `tenant_module` row that then resolves
 * DISABLED — a paid entitlement that is silently inert. That is the same failure shape the composite FK
 * on `tenant_module.company_id` exists to prevent (0313 §3), and it deserves the same treatment: refuse
 * at the seam, name the missing codes.
 *
 * CORE codes always count as satisfied — they are on for every tenant and take no row at all, so
 * `toil`'s dependency on `leave` is met by definition.
 */
export function missingModuleDependencies(picked: readonly string[]): string[] {
  const byCode = new Map(MODULE_CATALOG.map((m) => [m.code, m]));
  const satisfied = new Set<string>([...picked, ...CORE_MODULE_CODES]);
  const missing = new Set<string>();
  // Breadth-first over the closure rather than one level: a future grandchild dependency must be
  // checked too, and `seen` keeps a cycle in the catalog from hanging the request.
  const seen = new Set<string>();
  const queue = [...picked];
  while (queue.length > 0) {
    const code = queue.shift()!;
    if (seen.has(code)) continue;
    seen.add(code);
    for (const dep of byCode.get(code)?.dependsOn ?? []) {
      if (!satisfied.has(dep)) missing.add(dep);
      queue.push(dep);
    }
  }
  return [...missing].sort();
}
