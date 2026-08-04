/**
 * The Payroll module pack (ADR-0080 D8/D9/D10/D11 — retrofit ladder rung 7, THE FINAL RETROFIT).
 *
 * The money path, the deepest entanglement — it goes last on purpose so it inherits every settled
 * pattern: the `PayrollInputContributor` kernel contract from rung 3, the country calculators from
 * rung 5 (payroll consumes country vocabulary through the registry, NOT via direct localization/my
 * imports — all such imports were removed at 5a), and the golden-test discipline throughout. THE
 * BAR IS BYTE-IDENTICAL PAYROLL OUTPUT: every payslip figure, statutory contribution and net-pay
 * number is unchanged by this rung; any diff is a bug. The retrofit is boundary-only (facade +
 * registry nav + ratchet) — no payroll math moved.
 *
 * This file is the pack's DECLARATION + registry wiring and is deliberately client-safe (the sidebar
 * imports it to mount the nav row): a lucide icon ref and flat data only. The pack's service surface
 * lives in `./service` (the facade over the twenty implementation files); importing it here would
 * drag db/client into the client bundle.
 *
 * ## Pack surface (audited 2026-07-24; physical file moves are OPTIONAL per D11 and not done here)
 *
 * - Services (implementation files, reachable from outside ONLY via `packs/payroll/service`):
 *   `core/payroll.ts` (THE ENGINE — `generatePayslips`, batch draft/process/reprocess/unlock, the
 *   `payroll_input` write surface, statutory folding, EA/CP39 completeness, the leaver advisory),
 *   `core/payroll-cycle.ts` (pay-cycle calendar + batch-window resolution),
 *   `core/payroll-config.ts` (per-company payroll config), `core/payroll-policy.ts` +
 *   `core/payroll-policy-config.ts` (payroll policy CRUD + the pay-frequency/pay-mode vocabulary,
 *   `calendarWindowFor`, `payslipReleaseAt`), `core/payroll-individual-txn.ts` (one-off individual
 *   transactions), `core/payroll-run-group.ts` (multi-company run groups),
 *   `core/payroll-view.ts` (processed-payslip read models + cross-company listings),
 *   `core/payroll-readiness.ts` (pre-run readiness checks), `core/payroll-history-import.ts`
 *   (historical payslip import), `core/payroll-permissions-admin.ts` (payroll permission grants +
 *   step-up), `core/pay-components.ts` (the pay-component catalog + statutory allowlist resolution
 *   via the active country pack — the D6 vocabulary consumer), `core/pay-rule.ts` +
 *   `core/pay-rule-ai.ts` (pay-rule library + AI drafting), `core/cp38.ts` (CP38/CP39 IRB deduction
 *   orders), `core/ea-override.ts` (EA-statement field overrides, consuming `pack.eaFields`),
 *   `core/tax-relief.ts` (TP1 tax-relief declarations), `core/loans.ts` + `core/loans-compute.ts`
 *   (staff loans + repayment schedule, deducted through payroll), and `core/statutory-authority.ts`
 *   (per-company statutory-body registration/payment references).
 * - Routes: `app/payroll/**` (the batch workbench, process wizard, transactions, transaction-view,
 *   reports, EA/CP39/zakat/TP1 surfaces, history-import, guide, the country-admin configuration
 *   screens whose MOUNTING is registry-driven since 5c), `app/admin/pay-components/**`,
 *   `app/admin/payroll-config/**`, `app/admin/payroll-cycle/**`, `app/admin/payroll-policy/**`,
 *   `app/admin/payroll-permissions/**`, `app/admin/loans/**`, `app/api/payroll/**` (the reprocess
 *   job runner), and the employee-self-service payroll screens `app/me/payslip/**` +
 *   `app/me/tax-relief/**` (kept under /me for the employee, like leave's `app/me/leave`).
 * - The boundary is enforced by test/payroll-pack-drift.test.ts (D11 criterion 4, shrink-only
 *   ratchet seeded in test/pack-drift-allowlist.json under "payroll").
 *
 * ## comp.ts is SPINE (kernel), NOT this pack — audited decision (the rung-4/rung-6 analogue)
 *
 * `core/comp.ts` (compensation) is jurisdiction-neutral, effective-dated EMPLOYMENT history (ADR-0008
 * #5): it is set on hire/promote/movement (`core/movement.ts`, `core/org.ts`, `core/import.ts`, the
 * personnel-admin actions), the `compensation` table is read by TEN+ modules (payroll, performance,
 * analytics, reporting, movement, toil, read, import, pay-components, payroll-readiness), and it even
 * houses `nextEmployeeCode` (pure employment-spine). A table that many modules read is shared spine
 * by definition (the same test that made holidays spine at rung 6). Payroll READS comp; it does not
 * own it. So `compensation` is a spine table (no declaring pack), `core/comp.ts` is absent from the
 * facade, and packing it would mint kernel→pack debt on day one (personnel admin, movement, org,
 * import, analytics, reporting all touch it).
 *
 * ## The country statutory surface is NOT this pack (the D5 spine/satellite line)
 *
 * The MY statutory PROFILE + RULE tables (`employee_statutory_my`, `company_statutory_my`) and the
 * ADR-0020/0037 statutory-pack DISTRIBUTION tables (`statutory_ruleset`, `statutory_component_override`,
 * `statutory_pack`, `statutory_signing_key`, `statutory_pack_sync_log`) are the COUNTRY axis, not the
 * payroll MODULE (D5: shared spine keeps `payslip`; per-country satellites hold statutory profiles).
 * They are declared by the `country-<cc>` pack when its module row lands (5d, deferred to the ADR-0077
 * join point). This pack claims only the jurisdiction-neutral payroll PROCESSING tables plus the
 * generic statutory-registration (`company_statutory_authority`, a jurisdiction-neutral payment-
 * reference table managed by `core/statutory-authority.ts`) and report-run (`statutory_report`, a
 * generic report-generation record; jurisdiction is a column, not the table shape) tables its own
 * boundary files own.
 *
 * ## The pay seams (D9) — dispositions this rung, per the one-correct-partial rule
 *
 * Payroll is the CONSUMER of `PayrollInputContributor` (packs/contracts.ts). Three producer seams
 * feed the draft batch; their dispositions:
 *
 * 1. **Claims taxable payout — RESOLVED-INTO-CONTRACT (rung 3, unchanged here).** The batch page's
 *    "queue claims" action resolves `payrollInputContributorById('claims')` and calls `contribute`;
 *    the payroll surface does not import `core/claims`. Byte-identical, proven by the payout goldens.
 * 2. **Leave — LEFT INLINE by shape+risk choice (the rung-6 debt disposition).** Both named
 *    leave→payroll effects produce NO `payroll_input` row, so the contributor contract (which models
 *    payroll_input row PRODUCERS queued onto a draft batch) is the wrong shape for them, and
 *    extracting the money path to invent a new contract kind cannot be proven byte-identical:
 *      - **Unpaid leave reduces pay** — `generatePayslips`'s `unpaidDaysByEmployment` reads
 *        `leave_request` / `leave_type` / `leave_request_date` DIRECTLY (schema-table access, the
 *        single source of truth — no double entry). It is an inline generation-time reduction, not a
 *        queued row; below the ratchet radar (no module import). Stays inline; documented debt.
 *      - **Encashment pays out** — `core/payroll.ts` imports `encashableDaysForEmployment` from
 *        `core/leave-encashment` and uses it INLINE in `leaverAdvisory` (a read-only final-pay
 *        ADVISORY; EA s.60E pay-in-lieu is deliberately never auto-paid, so it queues no
 *        `payroll_input` row). This IS a module import, so `core/payroll.ts` STAYS on the "leave"
 *        ratchet allowlist as encashment-advisory debt. A correct partial beats a risky rewrite of
 *        payroll math (ADR risk note: "any diff in output is a bug by definition").
 *    The consumer side of the contract is thus established (claims) and the leave side remains inline
 *    by risk choice — the honest resolution of the rung-6 seam.
 * 3. **Attendance-derived allowances — LEFT ON THE ATTENDANCE RATCHET (unchanged).** The batch page's
 *    "transfer allowances" action calls `transferAllowancesToBatch` (core/attendance-allowance, the
 *    attendance pack) directly; `app/payroll/actions.ts` is on the ATTENDANCE ratchet allowlist for
 *    it. Its richer return shape ({applied, ineligible, reversed, gated}) and distinct per-policy
 *    action do not fit the flat contributor contract without a UI/behaviour change; it stays a
 *    documented attendance→payroll seam (candidate for the contract when a second such producer with
 *    the same shape appears — resist speculative generality).
 *
 * ## comp-enactment seam (rung-4 debt) — disposition
 *
 * `core/performance.ts`'s `enactCompAction`/`declineCompAction` write a finalized review's
 * recommendation through the KERNEL engines: merit rides `setCompensation` (comp.ts, now confirmed
 * SPINE — a legal pack→spine call, needs no contract), and bonus rides `setPayrollInput` (core/payroll,
 * this pack). Since payroll is now a pack, `core/performance.ts` importing `setPayrollInput` is a
 * cross-pack edge — allowlisted under "payroll" as the comp-enactment bonus seam. It is a genuine
 * `PayrollInputContributor` candidate, but its call site is a per-review server action (not a batch
 * prefill button) with different ergonomics; migrating it is a later rung's work once a second
 * batch-writing consumer justifies generalizing the contract. Left as documented debt.
 *
 * ## Audited kernel-contract debt (D9) — who reads the pack's core directly and why (allowlisted)
 *
 * Every "payroll" allowlist entry is a legitimate cross-module consumer that gets a narrow kernel
 * contract, a client-safe pack entry, or a spine-vocabulary move at a later rung; the list only
 * shrinks. Grouped by kind:
 *
 * - **Cross-PACK edges (D9 — a pack importing payroll; the strict violations):**
 *   - `core/performance.ts` + `app/performance/[cycleId]/page.tsx` (the PERFORMANCE pack) — the
 *     comp-enactment bonus seam above (`setPayrollInput`) + a payroll read on the cycle detail page.
 *   - `core/attendance-allowance.ts` + `app/admin/attendance-allowance/page.tsx` (the ATTENDANCE
 *     pack) — the allowance-transfer seam reads `BatchNotDraftError` (core/payroll) and
 *     `setPayrollBatchComponent`/`UnsupportedBatchComponentError` (core/pay-components).
 *   - `core/claims.ts` (the CLAIMS pack) — reads payroll batch-window VOCABULARY the other way
 *     (`resolveBatchScopeFilter`, `resolveBatchCutOffWindow`, `BatchScope` from core/payroll;
 *     `calendarWindowFor` from core/payroll-policy-config) to scope claims to a batch. The
 *     mirror-image of the claims→payroll payout (which rides the contract); this read is pay-window
 *     vocabulary whose future home is shared batch-window spine.
 * - **Spine vocabulary** (pay date-math / release timing that happens to live in the payroll engine —
 *   the D6 pattern, like attendance's `isoWeekday`): `core/comp.ts` (SPINE) imports `PAYROLL_FREQUENCIES`
 *   from `core/payroll-policy-config`; `core/reporting.ts` + `core/read.ts` import `daysInMonth` from
 *   `core/payroll` (and `core/read.ts` `payslipReleaseAt` from `core/payroll-policy-config`).
 * - **Cross-module spine readers** (reporting / ESS / offboarding / admin — stay kernel per open
 *   decision 6, consume pack contracts/descriptors later): `core/report-registry.ts`
 *   (`listProcessedPayslipsAcross` from payroll-view), `app/me/actions.ts` (TP1),
 *   `app/me/page.tsx` (loans), `app/admin/actions.ts`, `app/admin/organization/page.tsx`.
 * - **Personnel-admin profile surfaces** (payroll config/statutory read on the employment profile):
 *   `app/admin/personnel/{page.tsx,actions.ts}`, `app/admin/personnel/[employmentId]/{page.tsx,actions.ts,cp38-actions.ts}`.
 * - **Client widgets** (cannot use the SERVER facade — it drags db/client into the client bundle;
 *   they import payroll TYPES / client helpers): `components/loan-list.tsx`, `components/loan-new-form.tsx`,
 *   `components/tp1-declaration-form.tsx`. Migrate to a client-safe pack entry (the 5b pattern).
 * - **Provisioning / seed / scripts:** `db/provision.ts`, `db/seed.ts`, `scripts/backfill-basic-components.ts`.
 *
 * ## Entitlement hook (D11 criterion 5 — NOT wired)
 *
 * ADR-0077's `tenant_module` / `isModuleEnabled()` primitives do not exist yet. The hook point is
 * `id: 'payroll'` below matching the future catalog row: when 0077 lands, the gate resolves this pack
 * via `modulePackById('payroll')` and fails closed (D3) — and the country calculators already fail
 * closed on an unresolvable pack (D3, `countryPackInactive`). No entitlement machinery is built here.
 */
import { ArrowLeftRight, Banknote, FileText, Landmark, ReceiptText, Settings2, Table2, Wallet, Workflow } from 'lucide-react';
import { registerPack, type ModulePack, type NavNodeGroupDescriptor } from '../registry';
import { payrollNavRank } from './phases';

/**
 * The payroll sidebar presence. At rung 7 this was a SINGLE flat row (`navLinks`) pointing at the
 * workbench landing, because every payroll sub-screen was reached from the module's own horizontal
 * tab strip (components/payroll-tabs.tsx) instead of the sidebar.
 *
 * 1459e116 retires that tab strip: the reporter's complaint is that the strip crowds as payroll
 * grows and eats screen space, and the fix is to put payroll on the fly-out every other multi-screen
 * module already uses. So the pack now contributes a NODE in the same Administration group — the row
 * is unchanged in placement (still between Claims config and Analytics, still relying on the group's
 * wholesale adminOnly gate), it just opens a panel instead of navigating.
 *
 * The children are the retired tab strip's six destinations, hrefs VERBATIM so existing bookmarks
 * keep working, reordered to the reporter's requested sequence (Workflow Guide before Payroll
 * Process — read the guide, then run the payroll).
 *
 * a1d82340 STEP 3 — the ORDER of those six is no longer written out here. It is derived from
 * `payrollNavRank` (packs/payroll/phases.ts), the single declaration of the payroll sequence that
 * the Workflow Guide and the Process wizard also read, so the menu cannot drift away from the order
 * the guide teaches. The SET of rows, their hrefs, their labelKeys and their icons are unchanged;
 * only the sequence moves — Settings is no longer stranded at the end of a menu whose first real row
 * is the finished-runs workbench. 1459e116's constraint (Workflow Guide first) is preserved: the
 * guide is ranked 0.
 *
 * WHY NO SECOND LEVEL. The reporter's tree nests Fixed/Individual under Transactions and the five
 * config screens under Settings. The sidebar fly-out is deliberately ONE level deep
 * (components/nav-flyout.tsx; NavChildDescriptor has no `children`), and deepening a nav contract
 * shared by six modules is not this item's to make. The second tier is not lost — it already lives
 * on the hub pages these rows lead to (/payroll/transactions renders the Fixed/Individual/TP1/zakat
 * cards, /payroll/setup the config cards, /payroll/transaction-view its own sub-tabs), which is also
 * where future payroll functions slot in without touching the sidebar at all.
 *
 * DELIBERATELY ABSENT: a Payroll Dashboard, Transaction Templates and Year-to-Date row. Those
 * screens do not exist; the approved plan promises no menu entries that lead nowhere.
 */
const PAYROLL_ADMIN_NAV: NavNodeGroupDescriptor = {
  labelKey: 'payroll',
  icon: Wallet,
  group: 'admin',
  children: [
    // Guided end-to-end payroll workflow view (feedback 5db3ae48): signposts Phase 1→6 and surfaces
    // config-level readiness; links OUT to the screens below rather than duplicating them.
    { href: '/payroll/guide', labelKey: 'payrollGuide', icon: Workflow },
    // The batch workbench — the pack's landing route, and what "/payroll" meant as a flat row.
    { href: '/payroll', labelKey: 'payrollProcess', icon: Banknote },
    { href: '/payroll/transactions', labelKey: 'payrollTransactions', icon: ArrowLeftRight },
    { href: '/payroll/transaction-view', labelKey: 'payrollTransactionView', icon: Table2 },
    // 169e3c24 — the admin payslip review screen. The itemised breakdown it renders already existed on
    // Transaction View → History; what was missing was a menu row that says "payslip", which is why the
    // reporter concluded the screen did not exist. Ranked into the same REVIEW phase, beside it.
    { href: '/payroll/individual-payslip', labelKey: 'payrollIndividualPayslip', icon: ReceiptText },
    { href: '/payroll/reports', labelKey: 'payrollReports', icon: FileText },
    // 956cec85 — the reporter asked for "a centralized location" for the statutory forms. The forms
    // themselves already existed on Reports; this row is the home they were missing.
    { href: '/payroll/statutory-forms', labelKey: 'payrollStatutoryForms', icon: Landmark },
    { href: '/payroll/setup', labelKey: 'payrollSettings', icon: Settings2 },
    // Sorted by the canonical sequence, NOT by the literal order above. Written declaratively so a
    // future row is placed by giving it a rank in phases.ts rather than by guessing where to splice
    // it in here. `sort` is stable, so two rows sharing a rank keep their literal order.
  ].sort((a, b) => payrollNavRank(a.href) - payrollNavRank(b.href)),
};

export const payrollPack: ModulePack = {
  id: 'payroll',
  kind: 'module',
  navNodes: [PAYROLL_ADMIN_NAV],
  // Pack-owned satellite tables (D5/D11 criterion 2 — documentation, not DDL). Audited from
  // db/schema.ts 2026-07-24. The jurisdiction-neutral payroll PROCESSING tables + the generic
  // statutory-registration/report-run tables this pack's boundary files own. NOT here (see the
  // header): `compensation` (employment SPINE), the MY statutory profile/rule tables + the ADR-0020
  // statutory-pack distribution tables (the COUNTRY axis, declared by country-<cc> at 5d). The
  // `payroll_input` rows written by the leave/attendance/claims/comp seams are THIS pack's table
  // (the contract write target), not the producing packs' satellites.
  satelliteTables: [
    { table: 'payroll_policy', note: 'per-company payroll policy (frequency, pay modes, proration, release timing)' },
    { table: 'company_payroll_config', note: 'per-company payroll configuration (rounding, run defaults)' },
    { table: 'payroll_cycle', note: 'the pay-cycle calendar: periods, cut-offs, pay dates' },
    { table: 'payroll_batch', note: 'a payroll run: draft → processing → processed/unlocked, per company/period' },
    { table: 'payslip', note: 'the per-employee processed result: earnings, deductions, statutory, net pay' },
    { table: 'payroll_status_history', note: 'batch status-transition audit trail' },
    { table: 'payroll_employee_result_history', note: 'per-employee reprocess/result history within a batch' },
    { table: 'payroll_reprocess_job', note: 'async reprocess job state (app/api/payroll/reprocess-job)' },
    { table: 'payroll_permission_grant', note: 'per-user payroll operation grants (payroll-permissions-admin)' },
    { table: 'payroll_step_up_challenge', note: 'step-up re-auth challenges guarding sensitive payroll ops' },
    { table: 'payroll_input', note: 'draft-batch input rows: OT/bonus/deductions/claim/allowance/zakat — the PayrollInputContributor write target' },
    { table: 'pay_component', note: 'the tenant pay-component catalog (earning/deduction, taxability, statutory flags)' },
    { table: 'employment_pay_component', note: 'per-employment recurring pay-component assignments (fixed txns)' },
    { table: 'payroll_batch_component', note: 'per-batch per-employee resolved component amounts' },
    { table: 'payroll_individual_txn', note: 'one-off individual payroll transactions applied to a batch' },
    { table: 'company_statutory_authority', note: 'per-company statutory-body registration/payment references (jurisdiction-neutral shape; statutory-authority.ts)' },
    { table: 'statutory_report', note: 'generated statutory report-run record (jurisdiction is a column; report generation is payroll output)' },
    { table: 'employee_loan', note: 'staff loans deducted through payroll (principal, schedule, status)' },
    { table: 'loan_repayment', note: 'per-instalment loan repayment rows (loans-compute schedule)' },
  ],
  serviceFacade: 'packs/payroll/service',
};

// Static module-load registration (ADR-0080 D8 wiring convention). Idempotent under dev HMR.
registerPack(payrollPack);
