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
 *   (approval templates + workflow matrix), `app/admin/toil/**` (a redirect stub to Leave Config › Leave
 *   Credit since 3fb1a611), `app/me/leave/**`
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
 * - **Overnight sweeps + seed:** `scripts/accrue-earned.ts`, `scripts/expire-carry.ts`,
 *   `scripts/review-sweep.ts`, `db/seed.ts`. (`scripts/expire-aged-leave.ts` was deleted by c459bff9
 *   along with the leave-type expiry feature.)
 *
 * ## Entitlement hook (D11 criterion 5 — NOT wired)
 *
 * ADR-0077's `tenant_module` / `isModuleEnabled()` primitives do not exist yet. The hook point is
 * `id: 'leave'` below matching the future catalog row: when 0077 lands, the gate resolves this pack
 * via `modulePackById('leave')` and fails closed (D3). No entitlement machinery is built here.
 */
import {
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  ClipboardList,
  FileUp,
  GitBranch,
  HeartPulse,
  Play,
  Settings2,
  Repeat2,
  SlidersHorizontal,
  UserSearch,
} from 'lucide-react';
import { registerPack, type ModulePack, type NavLinkDescriptor, type NavNodeGroupDescriptor } from '../registry';

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
//
// a00c4f64 adds the third row: "Team Leave Tracker" in the Manage group — the Leave Calendar's own
// screen, off the Dashboard where it used to be a pinned full-width card.
//
// DELIBERATELY UNGATED (no `managerUp`, no `adminOnly`), and this is the load-bearing decision, not a
// forgotten flag. The Manage group gates PER ROW (components/sidebar.tsx canSeeChild), so a row with no
// flag renders for every employee — which is what preserves today's access: every employee saw this
// calendar on their dashboard. A `managerUp` row here would be a silent permissions REMOVAL for plain
// staff, the same class of regression a324a4b3 hit when the attendance rows moved into a gated group.
// The page itself is scopedSession + RLS: staff see their own leave, managers additionally get the Team
// toggle — exactly the split the dashboard card had.
//
// 388e53c2 MADE THAT FLAG-FREE ROW MATTER MORE, not less. The screen behind it now branches by role: an
// HR administrator lands on the leave-inquiry surface (Employee Details) while everyone else keeps the
// calendar. It is tempting to read "an admin-only surface lives there" as a reason to add `adminOnly`
// here — DO NOT. The row would then disappear for every plain employee and manager, i.e. exactly the
// silent access removal the paragraph above exists to prevent, and the branch inside the page already
// gives each role the right screen. test/leave-pack.test.ts and test/team-leave-tracker.test.ts both
// assert the absence of these two flags for this reason.
const LEAVE_NAV_LINKS: NavLinkDescriptor[] = [
  // 388e53c2 — `exactHref` and `ownedSubpaths` decide HIGHLIGHTING ONLY; neither is a gate, and the
  // absence of adminOnly / managerUp on the tracker row below is load-bearing (see the paragraph above
  // this array). Before this, the prefix match lit "My Leave" on every /leave/* screen, so an
  // administrator reading somebody else's leave record saw their own row highlighted — the reporter's
  // original complaint. The two inquiry screens keep their /leave/* addresses on purpose, so the row
  // they are now reached from has to claim them explicitly.
  { group: 'main', href: '/leave', labelKey: 'myAbsence', icon: CalendarDays, exactHref: true },
  // 5ca446db (r269) — `ownedSubpaths: ['/leave/employee-balances', '/leave/employee-records']` STOOD HERE
  // and is a DELIBERATE TRANSFER, not a lost line. The two inquiry paths now belong to the new
  // "Employee Leave Inquiry" child of LEAVE_ADMIN_NAV below, because the reporter asked (twice) for a
  // Leave Config menu row that opens Employee Balances. Both rows claiming the same two paths would light
  // two rows in two groups at once, and `activeSectionKey` (components/sidebar.tsx) would resolve to
  // Manage because it is the earlier group — so ownership has to move, it cannot be shared.
  //
  // WHAT THIS ROW KEEPS, and it is the load-bearing half: `/leave/tracker` itself, matched on its own href
  // by the plain prefix rule (no `exactHref` here). The tracker is the Leave Calendar for every plain
  // employee AND the Employee Details tab of the inquiry rail, so it stays a Manage row with no gate.
  // DISCLOSED CONSEQUENCE (in the approved plan): stepping across the inquiry rail's three tabs moves the
  // sidebar highlight between Manage (Employee Details) and Leave config (Balances / Leave Record). That is
  // the least-bad option — the alternative is two lit rows, or taking the calendar off /leave/tracker.
  { group: 'manage', href: '/leave/tracker', labelKey: 'teamLeaveTracker', icon: CalendarRange },
];

/**
 * 645e67c4 — Leave config becomes a COLLAPSIBLE GROUP, and the tab strip is retired.
 *
 * The reporter asked for Replacement Leave "under Leave Configuration… the same navigation style as
 * Leave Type / Leave Adjustments / Generate Entitlement", and then contested `491c499f` in the same
 * words: "move this leave adjustment in the Leave Config left-hand menu from a single line into an
 * expandable group, the same way Payroll and Attendance already work." Both items are asking for THIS.
 *
 * Before this, Leave config was a single flat row (`group: 'admin'`, href `/admin/leave`) opening a
 * screen with EIGHT tabs strung across the top — there was nowhere to hang a submenu, which is exactly
 * why the Replacement Leave entry landed as a ninth tab instead of where it was asked for.
 *
 * This copies 1459e116's payroll conversion line for line: the pack declares a NavNodeGroupDescriptor,
 * the sidebar spreads it into a CollapsibleGroupItem, and the strip component is deleted so there is ONE
 * way in rather than two competing ones. Every href is carried over CHARACTER FOR CHARACTER — no screen
 * moves address, so no bookmark breaks.
 *
 * ORDER IS THE STRIP'S ORDER, deliberately: it is the order the work is done in (configure → adjust →
 * generate → route → pay → replace → audit), it is what the reporter's HR team already reads, and
 * re-sorting it here would be a second change nobody asked for.
 *
 * `leaveApprovalWorkflow`, NOT `leaveApproval`. `nav.leaveApproval` ALREADY EXISTS and is live: it is
 * the label `lib/permissions.ts` gives the separate `leaveApproval` SCREEN ("Approval chain", a leftover
 * from the standalone route 0d147b78 absorbed). Reusing that key silently renames that screen to this
 * menu's wording. The product already carries two names for this destination; reconciling them is not
 * this item's job, so the menu takes its own key and the retired tab's exact label.
 *
 * `/admin/leave/import` is registered on the leaveConfig screen but stays OFF the menu — it had no tab
 * either and is reached from inside Entitlements. Adding it is a change nobody asked for.
 *
 * NOT gated per row: leave is a CORE module, deliberately absent from the sidebar's MODULE_OF_HREF (a
 * tenant cannot not-have it), and the Administration group is gated adminOnly wholesale. Every one of
 * these pages calls requireAdmin()/scopedAdmin() for itself regardless.
 */
const LEAVE_ADMIN_NAV: NavNodeGroupDescriptor = {
  labelKey: 'leaveConfig',
  icon: SlidersHorizontal,
  group: 'admin',
  children: [
    // df00b85f — THE "SUMMARY" CHILD IS GONE, and Entitlements is the first entry.
    //
    // `/admin/leave` was a 127-line read-only master listing (code / name / description / paid / status)
    // whose only controls were an Edit link INTO Entitlements and a delete. Entitlements already renders
    // the full per-type panel with the same rename / archive / delete controls, so the row was a second
    // door onto one screen's worth of settings — the duplication complaint 26e76a9f and e4238594 have
    // each answered once already on this same surface.
    //
    // The ROUTE survives as a redirect stub (app/admin/leave/page.tsx → /admin/leave/entitlements) so
    // saved links, the leave-type master actions' ok(LEAVE)/fail(LEAVE) targets in app/admin/actions.ts
    // and the import page's back link all still land somewhere real. A stub is NOT a guarded page, so it
    // also left lib/permissions.ts's leaveConfig `routes` in the same change — test/function-access.test.ts
    // fails on a registered route with no guarded page on disk, which is why that is one move, not two.
    // a6fe37fc ROUND 5 (cutover) — the destination moved to the new module's leave TYPE screen, where the
    // four steps and six sub-steps are five tabs (IA §2). The row, its label key and its position are
    // unchanged: this is still the first thing in the menu and still called the same thing.
    // 10b59703 — the row OWNS its other tab, which lives at its own address (no route moved, so
    // bookmarks keep working) and would otherwise leave the row dark on arrival. Highlighting only; the
    // list must agree with components/leave-config-map.tsx's `entitlements` group, and
    // test/leave-flyout-nav.test.ts pins that it does.
    // 7f69bd71 — `'/admin/leave-config/records/entitlement'` STOOD HERE and is DELIBERATELY GONE: the
    // Configuration record is no longer a tab of this row. It is a sub-tab of the Reset records
    // sub-screen under Leave Adjustments, so that row lights on it (and on this stub's address on the
    // way through — `isNavRowActive` prefix-matches `/admin/leave-config/records`).
    {
      href: '/admin/leave-config/types',
      labelKey: 'leaveEntitlements',
      icon: ClipboardList,
      ownedSubpaths: ['/admin/leave-config/entitlement-tables'],
    },
    // r279 (3fbf7a02) — LEAVE BALANCE HEALTH, THE SECOND ROW, AND ITS POSITION IS THE ANSWER.
    //
    // The listing that says which leave types can produce a balance at all was drawn at page level on
    // the Leave types tab and named NOWHERE in the menu: the screen that explains a missing balance was
    // the one you had to already know about before you could find it. It has its own address now
    // (`app/admin/leave-config/balance-health/page.tsx`) and this is the row that opens it.
    //
    // DIRECTLY AFTER ENTITLEMENTS, not at the bottom, because it answers the question you ask ABOUT
    // entitlements — can this leave type produce a balance at all — and the tab it left is the first
    // row's first tab. A sibling ROW rather than a third tab of Entitlements: it reads every leave type
    // at once, which is the one thing neither of that row's two tabs does.
    //
    // ⚠️ IT **IS** A GROUP IN components/leave-config-map.tsx, AND THIS NOTE USED TO SAY THE OPPOSITE.
    // r279 built the page outside the convention first — a row with no group — and converted it back
    // inside the same round when the carve-outs that choice forced started appearing in
    // test/leave-config-map.test.ts and test/r266-leave-config-rows.test.ts; this comment was left
    // describing the abandoned shape and is corrected here (r281) rather than left to misdirect the next
    // row. The rule is the one the map's own header states: every fly-out row whose destination lives
    // under `app/admin/leave-config/**` IS a group, one for one, in order — including a row that owns a
    // single screen, whose tab strip then draws nothing. A group of one is not furniture: it is what
    // makes `leaveConfigPageHeader` give the page this row's own `nav.leaveBalanceHealth` heading (r266
    // 10b59703) and what keeps the row↔group agreement 1:1 in both directions. The only child of this
    // node that is NOT a group is the one whose destination is not a Leave Config page at all (see the
    // Employee Leave Inquiry row below).
    //
    // NO `ownedSubpaths`: the page has no tabs and no sub-screen, so there is nothing for the row to
    // stay lit on beyond its own href.
    { href: '/admin/leave-config/balance-health', labelKey: 'leaveBalanceHealth', icon: HeartPulse },
    // a6fe37fc ROUND 5 (cutover) — the destination moved, the row did not (see the Generate row below).
    // 10b59703 — same for Leave Adjustments: Import leave data is its other tab.
    // 7f69bd71 — `'/admin/leave-config/records/balances'` (the Balance record tab) STOOD HERE and is
    // replaced by `'/admin/leave-config/records'`: the Reset records SUB-SCREEN, reached from the foot
    // of Adjust balances, holding both records as sub-tabs. The row owns it so it stays lit while the
    // sub-screen is open; the prefix match also covers the two `records/*` redirect stubs on the way
    // through. Highlighting only, never a gate; test/leave-flyout-nav.test.ts pins the list.
    {
      href: '/admin/leave-config/adjustments',
      labelKey: 'leaveAdjustments',
      icon: SlidersHorizontal,
      ownedSubpaths: ['/admin/leave-config/import', '/admin/leave-config/records'],
    },
    // 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT, A ROW OF ITS OWN, DIRECTLY AFTER LEAVE ADJUSTMENTS.
    //
    // The reporter asked for an import function "under the Leave Config menu" and could not find one,
    // because the importer that exists is not a row: it is the second TAB of the row above (its
    // `ownedSubpaths` line, immediately overhead). That was half the answer. The other half is that the
    // hidden tab does a DIFFERENT job — it loads balance movements into leave_ledger — so pointing the
    // reporter at it would have answered a question they did not ask. This row loads the RECORDS.
    //
    // ⚠️ A ROW, NOT A THIRD TAB OF LEAVE ADJUSTMENTS, and the distinction is the whole item. A tab of
    // that row would inherit its heading and its description ("adjust balances"), which is precisely
    // what this tool must never be understood to do: it moves no balance. The two importers sit beside
    // each other as siblings, one row each, and the older one's TAB LABEL is renamed to say "Leave
    // Balance Import" in the same round so the pair reads as a pair rather than as two spellings of one
    // thing. Renaming a label changes no route, no screen id and no stored role config.
    //
    // IMMEDIATELY AFTER the balance importer's row, not at the bottom: a migration loads the balances
    // and then the records, and the order of the menu is the order of the work (this node's header).
    //
    // NO `ownedSubpaths`: one page, no tabs, no sub-screen — nothing for the row to stay lit on beyond
    // its own href. NOT module-gated: leave is core, like every row here except Leave Credit.
    { href: '/admin/leave-config/history-import', labelKey: 'leaveHistoryImport', icon: FileUp },
    // 3fb1a611 (r299) — LEAVE CREDIT, DIRECTLY AFTER LEAVE ADJUSTMENTS, where the approved plan puts it.
    //
    // Every Replacement Leave credit in one list (earned through a request, added by HR, used, reversed,
    // expired), + Add Leave Credit, Reverse, and the Rules tab that took the replacement-leave policy off
    // Company rules. Next to Leave Adjustments because it is the adjustment screen FOR Replacement Leave: Leave
    // Adjustments refuses that type now and points here.
    //
    // ⚠️ THE ONE ROW OF THIS NODE THAT IS MODULE-GATED. Leave is core and its rows are not in the sidebar's
    // MODULE_OF_HREF, but Leave Credit is the paid `toil` add-on: components/sidebar.tsx maps this href to
    // `toil` by hand (there is no toil pack to derive it from) and lib/nav-entitlements.ts lists `toil` so the
    // rail can hide it. The page repeats the check itself — a hidden row is not a gate.
    //
    // `ownedSubpaths` carries the Rules tab (its own address), so the row stays lit on it. Highlighting only;
    // it must agree with components/leave-config-map.tsx's `leaveCredit` group (test/r266-leave-config-rows).
    {
      href: '/admin/leave-config/leave-credit',
      labelKey: 'leaveCredit',
      icon: CalendarClock,
      ownedSubpaths: ['/admin/leave-config/leave-credit/rules'],
    },
    // a6fe37fc ROUND 5 (cutover) — the DESTINATION moved, the row did not. Generate entitlement is
    // `/admin/leave-config/generate` now (the old address is a redirect stub that left lib/permissions.ts
    // in the same commit), so this row must name the new one: test/leave-flyout-nav.test.ts requires every
    // child href to be a registered route with a real page, and a menu row pointing at a stub is a row
    // that reaches its screen through a wasted hop.
    { href: '/admin/leave-config/generate', labelKey: 'leaveGenerate', icon: CalendarPlus },
    // r281 (09386e29) — RUN EARNED ACCRUAL, AND ITS POSITION IS THE ANSWER.
    //
    // It was a card filed underneath the generation wizard on the row above. Generate Entitlement CREATES
    // a leave year's entitlement; this tops up what has already been EARNED and not yet posted, and must
    // never be mistaken for the other. Filing one inside the other put the operator one scroll away from
    // the wrong operation, on a tool they run regularly rather than once a year.
    //
    // DIRECTLY AFTER GENERATE ENTITLEMENT, not at the bottom: the two are neighbours in an operator's day
    // and reading them side by side is what makes the difference between them legible. A row rather than a
    // second tab of Generate Entitlement, because a tab strip would put them back on one screen.
    //
    // NO `ownedSubpaths`: the page has no tabs and no sub-screen, so there is nothing for the row to stay
    // lit on beyond its own href.
    { href: '/admin/leave-config/earned-accrual', labelKey: 'leaveEarnedAccrual', icon: Play },
    // a6fe37fc ROUND 5 (cutover) — the destination moved, the row did not. The label key still says
    // `leaveApprovalWorkflow` rather than `leaveApproval` for the reason stated above: `nav.leaveApproval`
    // labels the SCREEN in lib/permissions.ts, and reusing it here would silently rename that column.
    { href: '/admin/leave-config/approval-chains', labelKey: 'leaveApprovalWorkflow', icon: GitBranch },
    // a6fe37fc ROUND 5 (cutover) — `{ '/admin/leave/payroll', 'leavePayroll' }` STOOD HERE and is
    // DELIBERATELY GONE, not lost. Payroll Related was two settings that were never one subject: the
    // per-leave-type switch is on the Leave types row above (tab 1) and the encashment policy is on the
    // Company rules row below. This list is an exact-set guard, so the only correct way to retire a
    // destination is to delete its line in the commit that does it — and the ROUTE still resolves, as a
    // stub, so no bookmark 404s. `nav.leavePayroll` is pruned in all six catalogues with the row.
    // a6fe37fc ROUND 5 (cutover) — `{ '/admin/leave/replacement', 'leaveReplacement' }` STOOD HERE and is
    // DELIBERATELY GONE, replaced by the destination that absorbed it. Replacement-leave configuration is
    // a COMPANY rule (IA §2.0.3), and it now shares one screen with the half-day deduction, the
    // encashment policy and the shared leave groups. `nav.leaveReplacement` is NOT pruned — it labels the
    // screen name inside components/leave/replacement-availability-notice.tsx, which is a different
    // sentence to an employee about why they cannot request replacement leave.
    { href: '/admin/leave-config/company-rules', labelKey: 'leaveCompanyRules', icon: Repeat2 },
    // f1b994e3 — `{ '/admin/leave/audit', 'leaveAudit' }` STOOD HERE and is DELIBERATELY GONE.
    //
    // "The Audit submenu under Leave Configuration is unnecessary because the system already has a
    // central Audit Trail module." It was right: this page and /admin/audit always read the SAME
    // append-only domain_event ledger through the same predicate and rendered the same table — this one
    // just pre-applied a hardcoded eight-aggregate list that hid 404 real leave rows and listed
    // job-grade rows the central page chips Organization. The central page gained an Area filter plus
    // every filter this page had, so the destination is strictly richer than the row removed.
    //
    // The ROUTE survives as a redirect stub (app/admin/leave/audit/page.tsx → /admin/audit?module=leave)
    // so saved links land somewhere real. A stub is NOT a guarded page, so it also left lib/permissions.ts's
    // leaveConfig `routes` in the same change — test/function-access.test.ts fails on a registered route
    // with no guarded page on disk, which is why that is one move, not two. Same for the export route.
    // 5ca446db (r269) — THE SIXTH ROW, and the only child of this node whose destination is NOT a Leave
    // Config screen. The reporter asked twice ("add a new function under Leave Config: Leave Inquiry", item
    // 1ff969ed; then this item) for a way to look one person's leave up from the menu they configure leave
    // in. The three screens already exist and already sit together as the Leave Inquiry rail
    // (components/leave/leave-inquiry-nav.tsx); what was missing was the door, which was a single underlined
    // link in the Entitlements page header (removed in this same commit — a link on one page is not
    // navigation, and r242's F47 property is served strictly better by a permanent row).
    //
    // THE ROW IS NAMED FOR THE AREA, THE SCREEN KEEPS ITS OWN NAME (the reporter's point 7). The row says
    // "Employee Leave Inquiry"; the destination's own PageHeader still says "Employee Balances"
    // (`leave.inquiry.balancesTitle`), and the permission matrix column still says "Employee Balances"
    // (lib/permissions.ts `leaveEmployeeBalances`). Same two-surfaces-two-names precedent as
    // leaveApprovalWorkflow / leaveApproval (645e67c4, re-affirmed by r266's gate).
    //
    // ⚠️ IT IS NOT IN components/leave-config-map.tsx AND MUST NOT BE. It has no page under
    // app/admin/leave-config/**, so a map group here would make `leaveConfigPageHeader` claim a page it does
    // not own and break test/leave-config-map.test.ts's "every screen here IS a declared route on its screen
    // key". The map's own header carries the same note at the point somebody would add it.
    //
    // ⚠️ ITS ROUTE IS REGISTERED ON A DIFFERENT SCREEN KEY — `leaveEmployeeBalances`, not `leaveConfig`
    // (lib/permissions.ts). test/leave-flyout-nav.test.ts names that exception explicitly rather than
    // relaxing the "every child is a registered route" rule. Knock-on, stated in the approved plan and NOT
    // papered over here, and CORRECTED by the verify pass: there is no per-screen grant to revoke, so the
    // exposure is not "an admin whose leaveEmployeeBalances is revoked". It is that app/layout.tsx passes a
    // wider isAdmin than requireAdmin enforces (it ORs in the payroll and perf-comp partners), so a partner
    // who is not an admin sees every adminOnly row, this one included, and is redirected at each page. It
    // predates this row and is not for this row to fix with a bespoke flag.
    //
    // `ownedSubpaths` carries Employee Leave Record so the row stays lit across the rail's other admin tab
    // — the paths TRANSFERRED off the Team Leave Tracker row above (see its note). Highlighting only.
    {
      href: '/leave/employee-balances',
      labelKey: 'employeeLeaveInquiry',
      icon: UserSearch,
      ownedSubpaths: ['/leave/employee-records'],
    },
    // r281 (a73d1e14) — SPECIAL SETTING, LAST, where the reporter drew it, holding Half Day Deduction.
    //
    // ⚠️ THE REPORTER'S SKETCH HAS THREE LEVELS AND THE RAIL HAS TWO. `NavChildDescriptor` (packs/registry
    // .ts) carries href/labelKey/icon/adminOnly/managerUp and NO `children`, so a row cannot hold a row.
    // Rather than refuse the shape, the row IS Special Setting and Half Day Deduction is the page it
    // opens: same destination, same grouping, one click instead of two. A second special setting later
    // becomes a second item in the map group and the tab strip appears by itself, with this row's name
    // unchanged — which is why the row is named for the CATEGORY and not for the half-day rule.
    //
    // WHY IT IS BELOW THE INQUIRY ROW rather than with the configuration rows it resembles: the reporter
    // drew it there. The map group order still agrees with the row order, because that agreement is
    // asserted over the rows whose destinations live under `app/admin/leave-config/**`, and the inquiry
    // row is not one of them (see its note above).
    //
    // NO `ownedSubpaths`: one screen, no tabs, no sub-screen.
    { href: '/admin/leave-config/special-setting', labelKey: 'leaveSpecialSetting', icon: Settings2 },
  ],
};

export const leavePack: ModulePack = {
  id: 'leave',
  kind: 'module',
  navLinks: LEAVE_NAV_LINKS,
  // 645e67c4 — the Administration-group contribution went from a flat row to a node (see LEAVE_ADMIN_NAV).
  // The 'main' /leave row above is untouched: that is the employee's own My Absence home, not config.
  navNodes: [LEAVE_ADMIN_NAV],
  // Pack-owned satellite tables (D5/D11 criterion 2 — documentation, not DDL). Audited from
  // db/schema.ts 2026-07-24. holiday / holiday_group / holiday_group_holiday stay OUTSIDE (shared
  // spine, see the header decision). leave_request unpaid-day reads and payroll_input rows written
  // by the encashment/unpaid seams are KERNEL, not satellites of this pack.
  satelliteTables: [
    { table: 'leave_type', note: 'tenant leave-type catalog (paid flag, unit, counting, expiry, visibility)' },
    // 6e9a126e RELEASE THREE — `leave_policy`, `benefit_scheme` and `scheme_leave_entitlement` are DROPPED
    // (migration 0405) and their rows are gone, so the pack stops claiming to own them: a satellite
    // declaration for a table that no longer exists makes the schema explorer name a record type nobody can
    // open. Release one added the three rows below beside them and said those three would go while these
    // stayed; this is that step.
    //
    // grade_group / grade_group_member are KEPT PERMANENTLY and were never part of the entitlement cut —
    // leave APPROVAL routing scopes on them (leave_approval_policy.grade_group_id), which is a different
    // feature that happens to have been named after benefit schemes.
    { table: 'grade_group', note: 'grade grouping over job_grade, scoping leave approval policies (the spine is job_grade)' },
    { table: 'grade_group_member', note: 'job-grade ↔ grade-group membership' },
    { table: 'entitlement_template', note: 'named, effective-dated service-band day table for one leave type' },
    { table: 'entitlement_eligibility_rule', note: 'who gets which entitlement template (core/org-criteria criteria, effective-dated)' },
    { table: 'entitlement_reset_archive', note: 'read-only text record of the scheme + policy configuration the reset clears' },
    // r88 1ef1cf95 — a shared group is tenant-level, not per benefit scheme (migration 0339), which is why
    // it outlived the scheme tables that used to own it rather than being dropped with them.
    { table: 'leave_shared_group', note: 'a shared allowance pooled across several leave types' },
    { table: 'leave_shared_group_member', note: 'leave types belonging to a shared group' },
    { table: 'leave_ledger', note: 'the balance ledger: accrual / debit / adjustment / in-lieu rows' },
    { table: 'leave_request', note: 'the request lifecycle row: submit → multi-step approve → ledger debit' },
    { table: 'leave_request_attachment', note: 'supporting documents behind a leave request' },
    { table: 'leave_request_date', note: 'per-date breakdown + per-date approval outcome of a request' },
    { table: 'leave_approval_step', note: 'the resolved approval chain + per-step decisions for a request' },
    { table: 'leave_cancellation_request', note: 'post-approval cancellation requests + decisions' },
    // r301 (83511d3b, migration 0471) — the cancellation's own copy of the original request's approval chain.
    { table: 'leave_cancellation_step', note: 'the approval chain a cancellation of approved leave walks, copied from the original request' },
    { table: 'leave_approval_policy', note: 'per-type/grade approval-chain policy (levels, escalation)' },
    { table: 'leave_approval_template', note: 'reusable approval-workflow templates + assignments' },
    { table: 'toil_policy', note: 'time-off-in-lieu policy: accrual basis, expiry action, eligibility' },
    { table: 'toil_accrual', note: 'per-employment TOIL accruals (active / taken / converted / lapsed)' },
    // 4b0e76ae — the row STAYS (test/leave-pack.test.ts and test/harness.ts both pin the table), but the
    // note was wrong on two counts and is corrected here: the records are TENANT-wide, not per-company, and
    // the leave-year CYCLE override moved onto the leave type (4d6eae7b). The table is now empty (migration
    // 0385) and unreferenced — its screen, dialogs, actions and services were removed — and it is kept only
    // so the redesigned Leave Year module can pick its own shape without a drop/recreate.
    { table: 'leave_year_config', note: 'tenant-wide leave-year records — EMPTY and unreferenced since 4b0e76ae' },
    { table: 'leave_entitlement_recalc_audit', note: 'audit trail of entitlement reprojections' },
    // 93249794 — the Generate Entitlement processing log (0399/0400). Declared here because ADR-0080 D11
    // criterion 2 is about what the pack OWNS, not about what any engine reads: nothing reads these two,
    // and that is stated in their schema comments so nobody later mistakes the run row for a gate on the
    // year-open the way leave_year_config was mistaken for one.
    { table: 'leave_generation_run', note: 'one row per Generate Entitlement run: who, which year/types, which criteria, the counts' },
    { table: 'leave_generation_run_item', note: 'per (employment, leave type) verdict of a generation run — the downloadable log' },
    { table: 'leave_encashment_policy', note: 'encashment ORP divisor + eligibility policy' },
    { table: 'leave_encashment_snapshot', note: 'resignation-approval frozen encashable-day snapshot (ADR-0069)' },
  ],
  serviceFacade: 'packs/leave/service',
};

// Static module-load registration (ADR-0080 D8 wiring convention). Idempotent under dev HMR.
registerPack(leavePack);
