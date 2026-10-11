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
  { code: 'rewards', name: 'Rewards', category: 'hr', description: 'Salary and bonus budgets, confidential reward review, approvals and payroll handoff.', dependsOn: ['employees'], billable: true, isCore: false, parentModule: null, packBacked: true, sortOrder: 135 },
  { code: 'lifecycle', name: 'Onboarding, Offboarding & IT Assets', category: 'hr', description: 'New-employee onboarding and leaver offboarding checklists, IT requisitions, the asset register and asset requests.', dependsOn: ['employees'], billable: true, isCore: false, parentModule: null, packBacked: true, sortOrder: 140 },

  // ── Billable sub-modules: a behaviour inside a parent pack's service, with NO pack of its own ───
  { code: 'toil', name: 'Time Off In Lieu', category: 'hr', description: 'Bank overtime as replacement leave instead of cash.', dependsOn: ['leave', 'attendance'], billable: true, isCore: false, parentModule: 'leave', packBacked: false, sortOrder: 200 },
  { code: 'multi_cycle_payroll', name: 'Multi-Cycle Payroll', category: 'payroll', description: 'More than one payroll cycle per company.', dependsOn: ['payroll'], billable: true, isCore: false, parentModule: 'payroll', packBacked: false, sortOrder: 210 },
  { code: 'typed_pay_components', name: 'Typed Pay Components', category: 'payroll', description: 'Structured, per-type pay components on the payslip.', dependsOn: ['payroll'], billable: true, isCore: false, parentModule: 'payroll', packBacked: false, sortOrder: 220 },
  /**
   * ADR-0077 slice 6 — COUNTRY IS A MODULE. A tenant's right to operate a jurisdiction is an
   * entitlement, not a column: the MNC path is "platform grants country-sg, then the admin may create
   * an SG statutory company". Shipped INERT — nothing resolves against these rows yet.
   *
   * `packBacked: false` even though `country-my` IS a registered pack id, because the drift test's
   * correspondence is with `listPacks('module')` and a country pack registers under `kind: 'country'`.
   * Marking it true would assert a module pack that does not exist.
   *
   * `billable: false` for now, deliberately. A country pack is plausibly something a customer pays for,
   * but the commercial model is slice 6's to settle — and marking it billable today would make the
   * change runner refuse to grant it without a `subscription_line`, stranding a capability nobody has
   * decided how to sell. Flipping it later is a catalog edit; unpicking a wrong refusal is not.
   */
  { code: 'country-my', name: 'Malaysia', category: 'platform', description: 'Malaysian statutory rules: EPF, SOCSO, EIS, PCB, HRD Corp and the EA form.', dependsOn: [], billable: false, isCore: false, parentModule: null, packBacked: false, sortOrder: 300 },
  { code: 'notifications', name: 'Notifications', category: 'platform', description: 'In-app notification centre and task alerts.', dependsOn: [], billable: true, isCore: false, parentModule: null, packBacked: false, sortOrder: 230 },
  /**
   * System Analysis & Dependency Explorer (deec1691) — the admin-facing record-relationship reference.
   *
   * `packBacked: false` because it is not a pack: it owns no tables, contributes no satellites and has
   * no service of its own beyond `core/schema-explorer.ts`, which READS the schema rather than adding
   * to it. It is a commercial identity only — precisely the case this catalog exists to express.
   *
   * WHY IT IS SELLABLE RATHER THAN CORE, which is the whole point of the entry. The screen describes
   * how the PRODUCT is built (which record type points at which, which module owns each), not what a
   * customer's data says. Today the only tenant is Stradaverse's own, so having it under Admin during
   * setup costs nothing. The moment a second customer exists, that same screen would show them the
   * internal structure of the product they are renting. Making it a module with no entitlement row by
   * default means that decision is a switch at provisioning time, not a code change under pressure.
   */
  { code: 'system_explorer', name: 'System Analysis & Dependency Explorer', category: 'platform', description: 'Admin reference for how the product is built — which record types point at which, and which module owns each.', dependsOn: [], billable: true, isCore: false, parentModule: null, packBacked: false, sortOrder: 240 },
  /**
   * ADR-0082 — the AI assistant. `platform`, not `hr`: it owns no HR process; it answers questions
   * over reads that belong to other modules, which is exactly the cross-cutting shape `notifications`
   * and `system_explorer` occupy.
   *
   * `packBacked: false` — it owns no pack. Its tables (0451) are declared as no pack's satellites, so
   * core/schema-explorer.ts:159-178 will render them as owned by no module in the Dependency Explorer.
   * That is a consequence accepted deliberately, not a bug to fix by registering a pack: registering
   * one forces packBacked:true and the correspondence assertion cuts both ways.
   *
   * `billable: true` — it spends provider money, often the TENANT'S own key under ADR-0023's BYOK.
   * That also means the module-change runner refuses activation without a `subscription_line`
   * (scripts/module-change-runner.ts:105-116), which is correct: the grant must correspond to
   * something sold. It also means a suspended tenant loses it, which is likewise correct.
   *
   * `dependsOn: ['employees']` gates nothing at runtime — `employees` is core and answers TRUE without
   * a snapshot — but it states the truth: with no employment records there is nothing to ask about.
   */
  { code: 'assistant', name: 'AI Assistant', category: 'platform', description: 'In-product AI assistant that answers questions over the employee and HR record the user can already see.', dependsOn: ['employees'], billable: true, isCore: false, parentModule: null, packBacked: false, sortOrder: 250 },
  /**
   * System Testing (e6be5a3b, r330) — the test-case library and its execution record.
   *
   * `platform`, like `system_explorer` and `assistant`: it owns no HR process. It describes how the
   * PRODUCT is supposed to behave and keeps a quality record about the vendor.
   *
   * WHY IT IS SELLABLE RATHER THAN CORE, which is the whole point of the entry and the reporter's own
   * precedent (deec1691). An HR customer does not want a testing tool in their menu, and a module with
   * no `tenant_module` row simply does not exist for them — the rail hides the row, and
   * core/system-testing.ts refuses every call by name. Stradaverse switches it on for itself. Making
   * that a provisioning switch rather than a code change is the decision ADR-0077 exists to enable.
   *
   * `packBacked: false` — it registers no pack. It DOES own tables (test_case, test_run, 0482), which
   * makes it the first non-pack-backed catalogue row to do so, and the consequence is stated rather
   * than papered over: core/schema-explorer.ts derives table ownership from the packs' own
   * `satelliteTables`, so both tables render as owned by NO module in the Dependency Explorer. That is
   * the same accepted consequence ADR-0082 records for the assistant's tables, and the alternative —
   * registering a pack — would force `packBacked: true`, which test/module-catalog-drift.test.ts pins
   * against `listPacks('module')` in BOTH directions.
   *
   * `billable: true` — it is a thing sold separately, which is what the reporter asked for. It also
   * means scripts/module-change-runner.ts refuses activation without a `subscription_line`, which is
   * correct: the grant must correspond to something sold.
   *
   * `dependsOn: []` and NOT the modules a test case can be filed against. The controlled module list is
   * resolved per tenant at read time (core/system-testing.ts listTestableModules); declaring Payroll or
   * Attendance as a dependency would make the testing module itself resolve DISABLED for a tenant that
   * has neither, which is backwards — you test what you own.
   */
  { code: 'system_testing', name: 'System Testing', category: 'platform', description: 'Test-case library and execution record — the written checks a release is run through, and what happened each time.', dependsOn: [], billable: true, isCore: false, parentModule: null, packBacked: false, sortOrder: 260 },
];

/**
 * SETTINGS — the per-tenant behaviour values.
 *
 * The FOUR `platform`-scoped rows here are the ones that must NOT be customer-writable, and the
 * reasoning is recorded per row rather than in a design doc nobody reads at 2am:
 *   - the two payroll risk switches reopen or wipe a finalised payroll run,
 *   - `audit.hash_chain_enabled` is the tamper-evidence itself, and
 *   - `feedback.ai_planning_enabled` is operator tooling, not a customer feature.
 * A customer sees the first three; only Stradaverse changes any of them. `defaultOnInstall: false` on
 * the risk switches is deliberate — a purchased module must never arrive with an escape hatch already
 * open, even though the demo deployment has both env flags ON today (F4).
 *
 * `payroll.individual_txn_pay_enabled` is the odd one out and is `scope: 'tenant'` on purpose: it is
 * not a hatch, it is payslip arithmetic, and it is the ONE entry whose `defaultOnInstall` differs from
 * its default. Its own comment below carries the reasoning.
 *
 * The install-default clause is about NEW installs only. An ALREADY-PROVISIONED tenant keeps what it
 * has via `LEGACY_ENABLED_SETTINGS` below, which 0313 backfills — `defaultOnInstall` never fires for a
 * tenant provisioned before the setting existed, so the two mechanisms are not interchangeable.
 */
export const SETTING_CATALOG: SettingCatalogEntry[] = [
  { key: 'payroll.reset_enabled', moduleCode: 'payroll', scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Allow reverting a processed payroll run to draft. Weakens payroll controls; enabling is an audited platform action.', sortOrder: 10 },
  { key: 'payroll.unlock_enabled', moduleCode: 'payroll', scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Allow unlocking a closed payroll run back to processed. Reverses the statutory freeze; enabling is an audited platform action.', sortOrder: 20 },
  // `defaultOnInstall: true` — the ONLY entry that differs from its bare default, and deliberately so
  // (review r3). This is not a risk switch: it decides whether the one-off transaction ledger is paid or
  // record-only, i.e. ordinary payslip arithmetic (core/payroll.ts reads it inside the payslip
  // computation). Every tenant on this deployment runs it ON via INDIVIDUAL_TXN_PAY_ENABLED, and 0313
  // backfilled a `true` row for every tenant that existed at migrate time — so leaving it `false` at
  // install would have made a customer provisioned TOMORROW the only one whose one-off transactions
  // silently stop reaching the payslip, with no error and no way to notice. That is the same
  // silent-downgrade shape the parity set exists to prevent, and unlike the two switches above it is
  // `scope: 'tenant'`, so 0313's `tenant_setting_write` policy lets `ai_hr_app` change it once slice 7
  // ships a settings screen. The two platform risk switches stay `false`: a purchased module must not
  // arrive able to revert a processed run or unlock a closed one.
  { key: 'payroll.individual_txn_pay_enabled', moduleCode: 'payroll', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: true, customerVisible: true, description: 'Let the payroll kernel pay and deduct the one-off transaction ledger, instead of keeping it record-only.', sortOrder: 30 },
  { key: 'audit.hash_chain_enabled', moduleCode: null, scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Tamper-evident hash chaining over the audit log. Integrity control — Stradaverse-managed, and one-way once enabled (slice 8).', sortOrder: 100 },
  { key: 'feedback.ai_planning_enabled', moduleCode: null, scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: false, description: 'In-app AI drafting of improvement plans. Operator tooling, not a customer feature.', sortOrder: 110 },
  // ADR-0084 §2.5 — the nudge agent's kill switch, and the reason it DEFAULTS OFF. Every other automated
  // surface in this product waits for somebody to press a button; this one messages real employees on a
  // schedule with nobody pressing send, so it must be switched on deliberately per tenant rather than
  // arrive with the module. `scope: 'tenant'` so 0313's tenant_setting_write policy lets an admin change
  // it; `defaultOnInstall: false` so buying notifications never starts a chaser nobody asked for.
  { key: 'notifications.readiness_nudge_enabled', moduleCode: 'notifications', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Let the system chase incomplete employee records on a schedule — the employee for their own bank details, HR for everything only HR can key in.', sortOrder: 120 },
  // ADR-0084 §2.6 — the hypothesis layer's switch, OFF for the same two reasons the nudge agent's is.
  // It spends the tenant's own provider budget (ADR-0023, BYOK) on a nightly schedule nobody triggered,
  // and it puts rows in their exceptions queue that a MODEL chose to put there. Both are opt-in. The
  // severity ceiling is not a setting and never appears here: a hypothesis is `review`, forever.
  { key: 'payroll.anomaly_hypotheses_enabled', moduleCode: 'payroll', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Let the system look for payroll exceptions the fixed checks cannot see, by comparing each person against their colleagues on the same run. Findings are always for review, never blocking.', sortOrder: 130 },
  // ADR-0084 §2.7 — input triage. OFF by default, and this is the switch with the most behind it: it puts
  // a question in front of a real employee about their own money, on a schedule, and it is the first
  // surface in the product that sends employee-authored FREE TEXT to a model. Both are things a customer
  // opts into. Nothing it does can refuse a claim.
  { key: 'claims.input_triage_enabled', moduleCode: 'claims', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: 'Let the system read each new expense claim and ask the person who filed it about anything that does not fit. It can only ever ask a question — it can never refuse or change a claim.', sortOrder: 140 },
  /**
   * r261 stage three (board item 9583deac) — THE TWO EMPLOYEE-SELF-SERVICE SETTINGS THE PLAN PROMISED.
   *
   * `moduleCode: 'ess'` because Employee Self-Service is the module they govern, and `ess` is CORE — so
   * these are not a purchase gate and cannot be lost by a tenant who stops paying for something. They are
   * behaviour values on a module every tenant has, which is precisely what a `tenant` scope is for.
   *
   * ⚠️ `ess.profile_change_fields` DEFAULTS TO THE STRING `'all'`, NOT TO A LIST, and that is a decision
   * rather than a shortcut. A list of the 24 field keys baked in here would be a second copy of
   * lib/profile-requestable-fields.ts inside a catalog that no test compares against it, and it would rot
   * the first time a field was added, renamed or withdrawn. `'all'` means "this tenant has not configured
   * it — the declaration's own default applies", which is exactly stage two's shipped behaviour and is
   * resolved in ONE place (`resolveAllowedRequestKeys`). A CONFIGURED tenant holds a json array of keys;
   * `[]` is a legitimate configured value meaning nothing may be asked about.
   *
   * `ess.profile_change_approver` defaults to `'admin'` — stage two's authority, unchanged, so this round
   * changes nothing for a tenant that never opens the screen. The only other value is `'group_admin'`,
   * which NARROWS the decision to a group administrator, so a bank account or an IC is signed off by
   * whoever holds the whole group rather than by whoever administers one company. It is still ONE
   * decision by ONE person (the plan sold single-level approval and the reporter approved it as
   * written), and it widens nothing about who may SEE another employee's request — that is
   * `profile_change_request_rls`, untouched.
   *
   * ⚠️ THERE IS NO `'manager'` VALUE, AND THAT IS A CONSTRAINT OF THE DATABASE RATHER THAN A PREFERENCE
   * (corrected in the r261 fix pass — this comment and the `description` beneath it both described an
   * abandoned design, and `description` is written into production's `setting_definition` by
   * scripts/seed-catalogs.ts on EVERY deploy, so the wrong sentence was customer-visible prose).
   * Approving WRITES the master record, and `person_rls` (migration 0029) is
   * `WITH CHECK (app.is_admin() OR app.is_self_person(id))`. A manager cannot write their report's person
   * row on ANY path, so a manager approver would not have been a setting — it would have been a widening
   * of master-record write access product-wide, reachable by routes that have nothing to do with this
   * queue. Both values here are therefore administrators, and this setting can only ever NARROW who
   * decides. `docs/me-profile-request-settings.md` says the same thing to the reporter in their words.
   *
   * Both are `defaultOnInstall: null`: there is nothing to write at provisioning time, because the
   * absence of a row IS the default and the default is the shipped behaviour.
   */
  { key: 'ess.profile_change_fields', moduleCode: 'ess', scope: 'tenant', valueType: 'json', defaultValue: 'all', defaultOnInstall: null, customerVisible: true, description: 'Which fields of their own record an employee may ask to change. Not set means every field the product offers; otherwise exactly the fields listed.', sortOrder: 150 },
  { key: 'ess.profile_change_approver', moduleCode: 'ess', scope: 'tenant', valueType: 'string', defaultValue: 'admin', defaultOnInstall: null, customerVisible: true, description: "Who decides an employee's request to change their own record: any HR administrator, or only a group administrator. One approver either way — never two levels, and never somebody deciding their own.", sortOrder: 160 },
];

/*
 * NO IN-PRODUCT WRITER EXISTS FOR A `platform` KEY UNTIL SLICE 7, and `feedback.ai_planning_enabled`
 * is the one where that matters today — so it is written here rather than left to be discovered.
 *
 * `scope: 'platform'` means 0313's `tenant_setting_write` policy refuses `ai_hr_app` outright, and there
 * is no settings screen yet in any case (nothing under app/, core/ or lib/ touches `tenant_setting`).
 *
 * WHAT THAT MEANS FOR THE THREE PAYROLL KEYS, STATED EXACTLY (review r3 — the earlier wording here said
 * they were "fine" because the backfill plus the reconcile script covered them, which is true only up to
 * the moment the reconcile runs):
 *   - `payroll.individual_txn_pay_enabled` is `scope: 'tenant'` and now carries `defaultOnInstall: true`,
 *     so `provisionTenant` writes it for every tenant that buys `payroll`, forever. Covered.
 *   - `payroll.reset_enabled` / `payroll.unlock_enabled` are covered for tenants that EXISTED at 0313
 *     (its backfill) and for tenants created before the flip (the reconcile script, which iterates the
 *     `tenant` table at run time and therefore cannot reach a tenant that does not exist yet). A tenant
 *     created AFTER the reconcile has no row and resolves `false` — deliberately: they are the risk
 *     switches, and `defaultOnInstall: false` is the recorded decision. Switching one on for such a
 *     tenant is an owner-connection INSERT until slice 7, exactly as for the key below.
 *
 * This key is covered by NONE of those — it is absent from the backfill, absent from
 * `LEGACY_ENABLED_SETTINGS` (operator tooling, set
 * in no tracked env file, so `legacyEnabledSettingsIn` can never emit it), and `moduleCode: null` keeps
 * it out of `settingsOnInstallFor`. `ADR-0044` documented `FEEDBACK_AI_PLANNING_ENABLED=true` as the
 * enable knob; slice 3 migrated that knob here, so until slice 7 the ONLY way to switch AI planning on
 * is an owner-connection INSERT. deploy/DEPLOY.md → "Switching a platform-scoped setting on (until
 * slice 7)" carries the statement to run; `scripts/feedback-plan.ts` and the admin "generate plan"
 * button refuse for every tenant until someone runs it. Stated, not silently shipped: a gate with no
 * enable path is worse than a removed feature, because the code still looks live.
 */

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
  /**
   * `system_explorer` is NEW (deec1691), so unlike every other row here it never HAD a legacy gate —
   * and the name below is deliberately one that no tracked env file sets and no application code
   * reads. That is not a fiction to satisfy the coverage assertion; it is the only spelling of "OFF
   * for everyone" this map can express, and it has to be spelled out somewhere or the module drops
   * out of the parity ratchet entirely.
   *
   * `null` WOULD BE WRONG AND IS THE TRAP HERE. `null` means "no whole-module gate anywhere — the
   * module is on for everyone", which forces the code into LEGACY_ENABLED_MODULE_CODES, which the
   * drift test pins against the literal list inside `db/migrations/0313_module_entitlements.sql`.
   * Getting there would need a new migration to widen the backfill AND would grant the module to
   * every existing tenant — the exact opposite of "default OFF". Naming an unset variable keeps it
   * out of the parity set, out of DEFAULT_PROVISION_MODULE_CODES (so the provisioning form does not
   * pre-tick it), and therefore rowless — and a missing `tenant_module` row is disabled (C7).
   *
   * The reintroduction guard in test/module-catalog-drift.test.ts asserts nothing reads this name, so
   * it cannot later become a real deployment flag that outranks what a customer bought.
   */
  system_explorer: 'SYSTEM_EXPLORER_ENABLED',
  /**
   * ADR-0082 — same idiom as `system_explorer` above, and for the same mechanical reason. `assistant`
   * is NEW and never had a legacy gate; `ASSISTANT_ENABLED` is a RESERVED name that no tracked env file
   * sets and no application source reads.
   *
   * `null` WOULD BE WRONG. It means "no whole-module gate anywhere — on for everyone", which forces the
   * code into LEGACY_ENABLED_MODULE_CODES, which the drift test pins character-for-character against the
   * literals inside db/migrations/0313_module_entitlements.sql — a migration that HAS ALREADY RUN on
   * production, so widening it there is a silent skip on the deployed box AND would hand the assistant
   * to every existing tenant. Naming an unset variable is the only way this map spells "OFF for
   * everyone", and it keeps the row out of DEFAULT_PROVISION_MODULE_CODES so the provisioning form does
   * not pre-tick it.
   */
  assistant: 'ASSISTANT_ENABLED',
  /**
   * ADR-0077 slice 6 — same idiom as `system_explorer` directly above, and for the same mechanical
   * reason. `null` would force `country-my` into LEGACY_ENABLED_MODULE_CODES, which the drift test pins
   * against the literal list inside 0313 — a migration that has already run on production. Naming an
   * unset variable keeps it out of that parity set.
   *
   * The difference from system_explorer is what happens NEXT: existing tenants DO need a row, and they
   * get one from `scripts/backfill-country-modules.ts`, which can read the pack registry and therefore
   * knows which countries actually have a pack. SQL cannot, which is why this is not a migration.
   */
  'country-my': 'COUNTRY_MY_ENABLED',
  /**
   * e6be5a3b (r330) — the System Testing module. Same idiom as `system_explorer` above, and for the
   * same mechanical reason: `SYSTEM_TESTING_ENABLED` is a RESERVED name that no tracked env file sets
   * and no application source reads.
   *
   * `null` WOULD BE WRONG AND IS THE TRAP. `null` means "no whole-module gate anywhere — on for
   * everyone", which forces the code into LEGACY_ENABLED_MODULE_CODES, which the drift test pins
   * character-for-character against the literals inside db/migrations/0313_module_entitlements.sql — a
   * migration that HAS ALREADY RUN on production, so widening it there is a silent skip on the deployed
   * box (CLAUDE.md §6) AND would hand a testing tool to every existing customer. Naming an unset
   * variable is the only way this map spells "OFF for everyone"; it keeps the row out of the parity
   * set and out of DEFAULT_PROVISION_MODULE_CODES, so the provisioning form does not pre-tick it, and
   * a missing `tenant_module` row is disabled (C7).
   *
   * The reintroduction guard in test/module-catalog-drift.test.ts asserts nothing reads this name, so
   * it cannot later become a real deployment flag that outranks what a customer bought.
   */
  system_testing: 'SYSTEM_TESTING_ENABLED',
  /**
   * ADR-0095 — the Lifecycle module (onboarding, offboarding, IT requisitions, assets). NEW, so it never
   * had a legacy gate. Same idiom as `system_explorer`: `LIFECYCLE_ENABLED` is a RESERVED name that no
   * tracked env file sets and no application source reads. `null` would be wrong for the reason stated
   * on `system_explorer` (it would force the code into the parity set pinned to migration 0313 and
   * grant the module to every existing tenant). A missing `tenant_module` row is disabled (C7).
   */
  lifecycle: 'LIFECYCLE_ENABLED',
  rewards: 'REWARDS_ENABLED',
};

/** The env var that gates each catalogued SETTING today. Same coverage rule, same drift assertion. */
export const LEGACY_SETTING_ENV_GATES: Readonly<Record<string, string | null>> = {
  'payroll.reset_enabled': 'PAYROLL_RESET_ENABLED',
  'payroll.unlock_enabled': 'PAYROLL_UNLOCK_ENABLED',
  'payroll.individual_txn_pay_enabled': 'INDIVIDUAL_TXN_PAY_ENABLED',
  'audit.hash_chain_enabled': 'AUDIT_HASH_CHAIN_ENABLED',
  'feedback.ai_planning_enabled': 'FEEDBACK_AI_PLANNING_ENABLED',
  // `null` = NO env gate ever, the same meaning it carries in LEGACY_MODULE_ENV_GATES above. This
  // setting is NEW (ADR-0084 §2.5, r237) rather than migrated from a deployment flag, so there is no
  // legacy value to honour — and null keeps it out of `legacyEnabledSettingsIn`, which is the correct
  // outcome: an automated chaser must never arrive switched on by a backfill.
  'notifications.readiness_nudge_enabled': null,
  // `null` for the same reason as the row above: ADR-0084 §2.6 is NEW rather than migrated from a
  // deployment flag, so there is no legacy value to honour — and null keeps it out of
  // `legacyEnabledSettingsIn`, which is the correct outcome. A backfill must never switch on something
  // that spends a customer's provider budget on a schedule.
  'payroll.anomaly_hypotheses_enabled': null,
  // `null` — new in ADR-0084 §2.7 (r240), never a deployment flag, and kept out of
  // `legacyEnabledSettingsIn` so no backfill can start it messaging employees.
  'claims.input_triage_enabled': null,
  // `null` — r261 stage three. Both settings are NEW behaviour values for a screen that ships in the same
  // round; neither was ever a deployment flag, so there is no legacy value to honour and no env file that
  // could turn one on. Keeping them out of `legacyEnabledSettingsIn` is also the right outcome on its own
  // terms: a backfill must never decide, on a customer's behalf, which of their employees' fields are
  // open to change requests or who signs one off.
  'ess.profile_change_fields': null,
  'ess.profile_change_approver': null,
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
    .filter(([key]) => {
      // A null gate means "never came from an env flag" — it can never be legacy-enabled, and indexing
      // `env` with null would be a silent `undefined` lookup rather than a stated decision.
      const gate = LEGACY_SETTING_ENV_GATES[key];
      return gate !== null && gate !== undefined && env[gate] === 'true';
    })
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
 *
 * A ROW IS ONLY EMITTED WHEN IT SAYS SOMETHING THE DEFAULT DOES NOT (slice 3 review), and the reason is
 * that on this table a row is far more than a value:
 *
 *   - `defaultOnInstall === defaultValue` ⇒ NO ROW. The resolver already falls back to `defaultValue`
 *     when a tenant has no row, so the row would be behaviourally identical — and NOT identical in every
 *     other respect. Both payroll risk switches are `scope='platform'`, and 0313's `tenant_setting_write`
 *     policy requires `scope='tenant'`, so `ai_hr_app` can never update or delete what provisioning
 *     writes here; until slice 7 builds the platform plane, an operator's only remaining lever is an
 *     owner-connection statement. `scripts/reconcile-entitlement-parity.ts` also treats an existing row
 *     as "hands off, a decision was recorded", so an identical-to-default row would silently opt a brand
 *     new tenant out of a reconciliation it should have been eligible for. Writing a row that changes
 *     nothing and forecloses everything is pure downside.
 *   - `defaultOnInstall === null` ⇒ NO ROW, per the column's declared contract:
 *     0313:78-80 makes `default_on_install` nullable and documents NULL as "nothing to apply on install".
 *     `tenant_setting.value` is `NOT NULL`, so passing NULL through would abort the whole provisioning
 *     transaction with a 23502 the first time a catalog entry uses the documented form.
 *
 * The install default therefore still fires for exactly the case it exists for: a setting a purchased
 * module should arrive with SWITCHED ON, i.e. one whose install value differs from its bare default.
 *
 * `catalog` IS A TEST SEAM, and it exists because the rule was unobservable against the real catalog
 * when it was written (review r2): no entry had `defaultOnInstall !== defaultValue`, so every call
 * returned [] and a test written against SETTING_CATALOG could only ever compare [] with [] — which is
 * what the test guarding this function did, with an expected side that re-implemented the filter
 * verbatim. Passing a synthetic catalog lets all four branches above be asserted against hand-written
 * literals. The seam is still worth keeping now that the real catalog exercises the emit branch
 * (`payroll.individual_txn_pay_enabled`, review r3): one live entry proves ONE branch, and the pin on
 * the real catalog — which now names that key rather than asserting emptiness — stays the separate
 * tripwire it already was, so a second entry gaining a non-default install value is a deliberate edit.
 */
export function settingsOnInstallFor(
  moduleCodes: readonly string[],
  catalog: readonly SettingCatalogEntry[] = SETTING_CATALOG,
): { key: string; value: unknown }[] {
  const picked = new Set(moduleCodes);
  return catalog.filter(
    (s) =>
      s.moduleCode !== null &&
      picked.has(s.moduleCode) &&
      s.defaultOnInstall !== null &&
      s.defaultOnInstall !== undefined &&
      s.defaultOnInstall !== s.defaultValue,
  ).map((s) => ({ key: s.key, value: s.defaultOnInstall }));
}

/** Core module codes — the set `isModuleEnabled` answers true for without a query (slice 2). */
export const CORE_MODULE_CODES: readonly string[] = MODULE_CATALOG.filter((m) => m.isCore).map((m) => m.code);

/** Every catalogued code, for validating an operator's picks before a provision request is accepted. */
export const ALL_MODULE_CODES: readonly string[] = MODULE_CATALOG.map((m) => m.code);

/** The codes a customer can actually be sold — everything not core. */
export const SELLABLE_MODULE_CODES: readonly string[] = MODULE_CATALOG.filter((m) => !m.isCore).map((m) => m.code);

/**
 * What the operator console PRE-TICKS on the new-customer form: every sellable module this deployment
 * already runs, i.e. `LEGACY_ENABLED_MODULE_CODES` narrowed to the codes a customer can be sold.
 *
 * This exists because the console was the ONE entitlement writer with no parity story. The other three
 * (0313's backfill, db/seed.ts, test/harness.ts seedBase) all derive from LEGACY_ENABLED_MODULE_CODES;
 * `provisionTenant` inserts exactly what the operator ticked and nothing else, and the form shipped with
 * every box empty. A customer created between slice 1 and slice 3 on an untouched form would therefore
 * have gained payroll/attendance/claims/performance today (nothing gates them) and LOST all four the
 * moment slice 3's resolver started reading rows — a silent downgrade nobody would attribute. The same
 * hole existed for `notifications` / `multi_cycle_payroll` / `typed_pay_components`, which the live box
 * also runs (deploy/enable-demo-flags.sh) — and `typed_pay_components` is the one that hurts, because
 * core/payroll.ts switches the earnings source on it, so that tenant's next payslip run changes numbers.
 *
 * Pre-ticking rather than unioning inside `provisionTenant` is deliberate: an operator who deliberately
 * unticks Payroll must get a customer without Payroll, or the picker is theatre. The default states what
 * today's product includes; the operator still decides.
 *
 * DERIVED FROM THE TRACKED PARITY SET, NOT FROM `process.env` (review r3). This used to be a function,
 * `defaultProvisionModuleCodesIn(env)`, that the operator page called as
 * `defaultProvisionModuleCodesIn(process.env)` — a LIVE read of NOTIFICATIONS_ENABLED,
 * MULTI_CYCLE_PAYROLL_ENABLED and TYPED_PAY_COMPONENTS_ENABLED, three of the eight gates this slice
 * migrated, sitting in application source. Two things were wrong with it:
 *
 *   - It broke G1 ("no application source reads a migrated gate from env any more") and did so
 *     INVISIBLY: the drift test's gate checks all need the gate NAME as a literal in the scanned file,
 *     and the page contained none — the lookup happened here, indexing a PARAMETER (`env[gate]`), which
 *     is not even a candidate for COMPUTED_ENV_KEY_OWNERS.
 *   - Retiring those three env vars — the entire point of this slice — would then have silently
 *     degraded the form to the four ungated codes, and every newly provisioned customer would arrive
 *     without notifications, multi-cycle payroll and typed pay components. The runtime value came from
 *     `.env.production`, which `deploy/.env.production.example` does not set and `deploy/deploy.sh`
 *     never writes; the flags exist on the box only because someone once ran `enable-demo-flags.sh` by
 *     hand. A form default whose correctness depends on an untracked file nobody maintains is the
 *     silent-downgrade shape the parity machinery exists to prevent, relocated to provisioning.
 *
 * The env filter was justified on the grounds that "pre-ticking a module this box does NOT run would
 * sell a capability that then resolves inert". After the flip that is no longer true: the ROW is the
 * capability — `isModuleEnabled` reads `tenant_module`, not the env — so the filter bought nothing and
 * cost the guarantee. `LEGACY_ENABLED_MODULE_CODES` is the tracked statement of what this deployment
 * runs, pinned in BOTH directions against `.env.example` and `deploy/enable-demo-flags.sh` by
 * test/module-catalog-drift.test.ts, so retiring a flag now fails a test instead of changing a form.
 *
 * Derived, not listed, for the same reason as before: a module that gains or loses a gate changes the
 * parity set and therefore the form default in the same commit.
 */
export const DEFAULT_PROVISION_MODULE_CODES: readonly string[] = SELLABLE_MODULE_CODES.filter((code) =>
  LEGACY_ENABLED_MODULE_CODES.includes(code),
);

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
