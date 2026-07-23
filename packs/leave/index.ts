/**
 * The Leave module pack (ADR-0080 D8/D9/D10/D11 — retrofit ladder rung 6, the second-largest module).
 *
 * This file is the pack's DECLARATION + registry wiring and is deliberately client-safe (the sidebar
 * imports it to mount the nav rows): lucide icon refs and flat data only. The pack's service surface
 * lives in `./service` (the facade); importing it here would drag db/client into the client bundle.
 *
 * The country seam through leave was already cut at rung 5: `core/leave.ts` resolves the acting
 * company/employee's country pack via `requirePackFor`/`packFor` and calls its statutory leave
 * entitlement hooks (the JURISDICTION axis). THIS rung is the MODULE boundary — leave as a pack —
 * not a redo of that country work.
 *
 * ## Pack surface (audited 2026-07-24; physical file moves are OPTIONAL per D11 and not done here)
 *
 * - Services (implementation files, reachable from outside ONLY via `packs/leave/service`):
 *   `core/leave.ts` (the engine: leave-year cycles, entitlement grant/reproject sweeps, request →
 *   multi-step approval → ledger lifecycle, cancellation, attachments, balances, ESS reads),
 *   `core/leave-approval-policy.ts` (approval-chain resolution + policy CRUD),
 *   `core/leave-approval-template.ts` (reusable approval templates + assignments),
 *   `core/leave-compute.ts` (PURE entitlement/proration/carry math — grade bands, service bands,
 *   `previewEntitlement`; the client-safe engine both the widgets and the grant sweeps reuse),
 *   `core/leave-encashment.ts` (encashable-day computation + resignation-freeze snapshots + policy),
 *   `core/leave-escalation.ts` (overnight approval-escalation sweep),
 *   `core/leave-formula.ts` (the entitlement-formula vocabulary/explanations config),
 *   `core/leave-import.ts` (leave-ledger bulk import validate/commit),
 *   `core/toil.ts` (time-off-in-lieu: accrual on approved OT, replacement-leave consumption, expiry),
 *   and `core/benefit-scheme.ts` — the benefit-scheme / grade-group entitlement CONFIG layer over
 *   `leave-compute` (it owns the grade-group + scheme + per-type entitlement CRUD; the resolution
 *   math stays in leave-compute). It is leave-domain by function though it is not named `leave-*`, so
 *   it is pack-owned (its tables would otherwise be undeclared, i.e. "spine", which they are not).
 * - Routes: `app/leave/**` (the My Absence self-service home: balances, apply, edit/cancel history,
 *   per-date outcomes, export), `app/admin/leave/**` (config: type master, entitlements, application
 *   rules, approval workflow, payroll/encashment, import, audit), `app/admin/leave-approval/**`
 *   (approval templates + workflow matrix), `app/admin/toil/**` (TOIL policy), `app/me/leave/**`
 *   (own-attachment download, kept for the /me?tab=leave deep-link back-compat).
 * - The boundary is enforced by test/leave-pack-drift.test.ts (D11 criterion 4, shrink-only ratchet
 *   seeded in test/pack-drift-allowlist.json under "leave").
 *
 * ## holidays.ts is SPINE (kernel), NOT this pack — audited decision (the rung-4 analogue)
 *
 * `core/holidays.ts` (the editable holiday-calendar system, ADR-0055/0063/0067) is consumed by THREE
 * modules — `core/attendance.ts` (working-day / rest-day math), `core/leave.ts` +
 * `core/leave-escalation.ts` (span counting, working-day proration) and `core/payroll.ts` (rest-day /
 * OT-class day classification + the EA s.60D completeness guard). A calendar three modules read is
 * shared spine by definition (ADR-0080 open decision 3: the editable holiday system is spine; packs
 * contribute only SEED calendars — the MY seed moved behind `CountryPack.seedReferenceData` at rung
 * 5c). The attendance pack already declared holidays NOT its own (nav placement ≠ ownership); this
 * pack agrees. So `holiday` / `holiday_group` / `holiday_group_holiday` are spine tables (no declaring
 * pack), and `core/holidays.ts` is absent from the facade.
 *
 * ## The leave↔payroll seam (D9) — audited: NO new contract this rung, documented as debt for rung 7
 *
 * The ADR names two leave→payroll effects. Both are computed INLINE inside `core/payroll.ts`, not as
 * discrete `payroll_input` prefills like claims — so per the one-seam-per-rung discipline they do NOT
 * migrate onto the `PayrollInputContributor` contract now; they are the Payroll rung's (7) to
 * restructure when the kernel's write surface gets its contract shape.
 *
 * - **Unpaid leave reduces pay** — `generatePayslips`'s `unpaidDaysByEmployment` reads `leave_request`
 *   / `leave_type` / `leave_request_date` rows DIRECTLY (schema-table access, the single source of
 *   truth with the leave module — no double entry). Below the ratchet's radar (no module import);
 *   recorded here for honesty. Debt for rung 7.
 * - **Leave encashment pays out** — `core/payroll.ts` imports `encashableDaysForEmployment` from
 *   `core/leave-encashment` and uses it INLINE in `leaverAdvisory` (a read-only final-pay ADVISORY;
 *   EA s.60E pay-in-lieu is deliberately NOT auto-paid, so this never queues a `payroll_input` row).
 *   This IS a module import, so `core/payroll.ts` is on the "leave" ratchet allowlist as kernel-
 *   contract debt — the encashment-payout seam gets its contract shape at the Payroll rung, not here.
 *
 * ## Audited kernel-contract debt (D9) — who reads the pack's core directly and why (allowlisted)
 *
 * Every "leave" allowlist entry is a legitimate cross-module consumer that gets a narrow kernel
 * contract (or client-safe pack entry, or spine vocabulary move) at a later rung; the list only
 * shrinks. Grouped by kind:
 *
 * - **Cross-PACK edges (D9 — a pack importing leave; the strict violations):**
 *   - `core/attendance.ts` (the ATTENDANCE pack) imports `approvedLeaveDates` from `core/leave` and
 *     `maybeAutoAccrueOnApprovalTx` from `core/toil` — attendance derivation needs approved-leave
 *     spans, and approving OT auto-accrues TOIL. A real cross-module effect that rides a kernel
 *     contract at a later rung (no second consumer yet — resist speculative generality); allowlisted
 *     until then, exactly as the attendance pack's own ratchet holds `core/leave.ts` (isoWeekday) as
 *     the mirror-image vocabulary debt.
 *   - `localization/my/leave.ts` (the COUNTRY pack) imports the `LeaveEligibility` TYPE from
 *     `core/leave` — the extension-point vocabulary a country pack fills. Type coupling is coupling
 *     (the ratchet catches it); it retires when shared leave types move to a spine/contract home.
 * - **The payroll seam:** `core/payroll.ts` — see the seam section above (encashment advisory).
 * - **Cross-module spine readers** (dashboards / analytics / approvals / ESS / offboarding / org /
 *   notifications — stay kernel per open decision 6, consume pack contracts/descriptors later):
 *   `app/page.tsx`, `app/approvals/actions.ts`, `app/me/actions.ts`, `app/delegations/{page,actions}.ts`,
 *   `app/admin/personnel/[employmentId]/{page.tsx,actions.ts,encashment-actions.ts}`,
 *   `core/analytics.ts`, `core/read.ts`, `core/org.ts`, `core/offboarding.ts`, `core/notifications.ts`,
 *   `core/admin.ts`, `core/roster.ts`.
 * - **Shared admin actions:** `app/admin/actions.ts` — the cross-cutting admin server actions file
 *   (imports leave, leave-compute, leave-encashment, leave-formula, toil, benefit-scheme). Splits per
 *   surface when the admin actions are themselves pack-partitioned.
 * - **Client widgets** (cannot use the SERVER facade — it drags db/client into the client bundle):
 *   `components/leave-type-panel.tsx`, `components/benefit-scheme-config.tsx`,
 *   `components/leave-rule-preview.tsx`, `components/earned-accrual-card.tsx`. They consume the pure
 *   client-safe `leave-compute`/`leave-formula` helpers; they migrate to a client-safe pack entry
 *   (the rung-5b `localization/my/client.ts` pattern), not the server facade.
 * - **Overnight sweeps + seed:** `scripts/accrue-earned.ts`, `scripts/expire-aged-leave.ts`,
 *   `scripts/expire-carry.ts`, `scripts/review-sweep.ts`, `db/seed.ts`.
 *
 * ## Entitlement hook (D11 criterion 5 — NOT wired)
 *
 * ADR-0077's `tenant_module` / `isModuleEnabled()` primitives do not exist yet. The hook point is
 * `id: 'leave'` below matching the future catalog row: when 0077 lands, the gate resolves this pack
 * via `modulePackById('leave')` and fails closed (D3). No entitlement machinery is built here.
 */
import { CalendarDays, SlidersHorizontal } from 'lucide-react';
import { registerPack, type ModulePack, type NavLinkDescriptor } from '../registry';

// The leave sidebar presence, moved VERBATIM from components/sidebar.tsx at rung 6 — like claims this
// is two FLAT rows in two different groups (not a collapsible node), so the pack contributes
// `navLinks` (group-tagged standalone rows):
//   - "/leave" sat in the top day-to-day group after /org, before the Attendance node — the "My
//     Absence" self-service home (a7cbd895 renamed it from "Leave"; label-only, same href/icon),
//     visible to every employee (self-service, no per-row gate);
//   - "/admin/leave" sat in the Administration group after System Settings, before Claims config —
//     the leave-config tabbed surface (0d147b78 folded the former "Approval chain" row into its
//     Approval Workflow tab). The group is gated adminOnly wholesale, so the row carries no per-row
//     flag — unchanged.
// hrefs, labelKeys, the CalendarDays / SlidersHorizontal icon refs and (absence of) visibility flags
// are the sidebar's verbatim; only the mounting moved (the sidebar places these rows via the registry).
const LEAVE_NAV_LINKS: NavLinkDescriptor[] = [
  { group: 'main', href: '/leave', labelKey: 'myAbsence', icon: CalendarDays },
  { group: 'admin', href: '/admin/leave', labelKey: 'leaveConfig', icon: SlidersHorizontal },
];

export const leavePack: ModulePack = {
  id: 'leave',
  kind: 'module',
  navLinks: LEAVE_NAV_LINKS,
  // Pack-owned satellite tables (D5/D11 criterion 2 — documentation, not DDL). Audited from
  // db/schema.ts 2026-07-24. holiday / holiday_group / holiday_group_holiday stay OUTSIDE (shared
  // spine, see the header decision). leave_request unpaid-day reads and payroll_input rows written
  // by the encashment/unpaid seams are KERNEL, not satellites of this pack.
  satelliteTables: [
    { table: 'leave_type', note: 'tenant leave-type catalog (paid flag, unit, counting, expiry, visibility)' },
    { table: 'leave_policy', note: 'grade-scoped effective-dated entitlement/accrual/carry policy engine' },
    { table: 'grade_group', note: 'benefit-scheme grade grouping (over job_grade; the spine is job_grade)' },
    { table: 'grade_group_member', note: 'job-grade ↔ grade-group membership' },
    { table: 'benefit_scheme', note: 'friendlier entitlement scheme over leave_policy (per employment-type)' },
    { table: 'scheme_leave_entitlement', note: 'per-scheme per-leave-type service-band entitlement table' },
    { table: 'scheme_leave_combined_limit', note: 'combined caps spanning several leave types in a scheme' },
    { table: 'scheme_leave_combined_limit_member', note: 'leave types belonging to a combined limit' },
    { table: 'leave_ledger', note: 'the balance ledger: accrual / debit / adjustment / in-lieu rows' },
    { table: 'leave_request', note: 'the request lifecycle row: submit → multi-step approve → ledger debit' },
    { table: 'leave_request_attachment', note: 'supporting documents behind a leave request' },
    { table: 'leave_request_date', note: 'per-date breakdown + per-date approval outcome of a request' },
    { table: 'leave_approval_step', note: 'the resolved approval chain + per-step decisions for a request' },
    { table: 'leave_cancellation_request', note: 'post-approval cancellation requests + decisions' },
    { table: 'leave_approval_policy', note: 'per-type/grade approval-chain policy (levels, escalation)' },
    { table: 'leave_approval_template', note: 'reusable approval-workflow templates + assignments' },
    { table: 'toil_policy', note: 'time-off-in-lieu policy: accrual basis, expiry action, eligibility' },
    { table: 'toil_accrual', note: 'per-employment TOIL accruals (active / taken / converted / lapsed)' },
    { table: 'leave_year_config', note: 'per-company leave-year cycle + opening/override rules' },
    { table: 'leave_entitlement_recalc_audit', note: 'audit trail of entitlement reprojections' },
    { table: 'leave_encashment_policy', note: 'encashment ORP divisor + eligibility policy' },
    { table: 'leave_encashment_snapshot', note: 'resignation-approval frozen encashable-day snapshot (ADR-0069)' },
  ],
  serviceFacade: 'packs/leave/service',
};

// Static module-load registration (ADR-0080 D8 wiring convention). Idempotent under dev HMR.
registerPack(leavePack);
