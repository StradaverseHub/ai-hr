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
 */
export const SETTING_CATALOG: SettingCatalogEntry[] = [
  { key: 'payroll.reset_enabled', moduleCode: 'payroll', scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Allow reverting a processed payroll run to draft. Weakens payroll controls; enabling is an audited platform action.', sortOrder: 10 },
  { key: 'payroll.unlock_enabled', moduleCode: 'payroll', scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Allow unlocking a closed payroll run back to processed. Reverses the statutory freeze; enabling is an audited platform action.', sortOrder: 20 },
  { key: 'payroll.individual_txn_pay_enabled', moduleCode: 'payroll', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Let the payroll kernel pay and deduct the one-off transaction ledger, instead of keeping it record-only.', sortOrder: 30 },
  { key: 'audit.hash_chain_enabled', moduleCode: null, scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Tamper-evident hash chaining over the audit log. Integrity control — Stradaverse-managed, and one-way once enabled (slice 8).', sortOrder: 100 },
  { key: 'feedback.ai_planning_enabled', moduleCode: null, scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: false, description: 'In-app AI drafting of improvement plans. Operator tooling, not a customer feature.', sortOrder: 110 },
];

/** Core module codes — the set `isModuleEnabled` answers true for without a query (slice 2). */
export const CORE_MODULE_CODES: readonly string[] = MODULE_CATALOG.filter((m) => m.isCore).map((m) => m.code);

/** Every catalogued code, for validating an operator's picks before a provision request is accepted. */
export const ALL_MODULE_CODES: readonly string[] = MODULE_CATALOG.map((m) => m.code);

/** The codes a customer can actually be sold — everything not core. */
export const SELLABLE_MODULE_CODES: readonly string[] = MODULE_CATALOG.filter((m) => !m.isCore).map((m) => m.code);
