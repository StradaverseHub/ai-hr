/**
 * The Attendance module pack (ADR-0080 D8/D10/D11 — retrofit ladder rung 2, the pattern-prover).
 *
 * This file is the pack's DECLARATION + registry wiring and is deliberately client-safe (the
 * sidebar imports it to mount the nav node): lucide icon refs and flat data only. The pack's
 * service surface lives in `./service` (the facade — see below); importing it here would drag
 * db/client into the client bundle.
 *
 * ## Pack surface (audited 2026-07-23; physical file moves are OPTIONAL per D11 and not done here)
 *
 * - Services (implementation files, reachable from outside ONLY via `packs/attendance/service`):
 *   `core/attendance.ts` (clock in/out, corrections, summaries, punch import),
 *   `core/attendance-rule.ts` (lateness/early-out/OT rule library), `core/attendance-derive.ts`
 *   (status/flag/OT derivation), `core/attendance-device.ts` (R63–R65 device registration + gate),
 *   `core/attendance-allowance.ts` (attendance-triggered allowances), and
 *   `core/clocking-location.ts` — clocking sites ARE pack-owned: they exist solely for the clock
 *   portal's geofence/device gate and per-employee site assignment, not for the org spine
 *   (`core/location.ts`, the office/worksite spine, stays kernel).
 * - Routes: `app/attendance/**` (records/daily/individual/import/ot-report + the R63–R65 clock
 *   portal), `app/admin/attendance/`, `app/admin/attendance-policy/**`,
 *   `app/admin/attendance-allowance/`, `app/admin/locations/` (clocking-site admin).
 * - The boundary is enforced by test/attendance-pack-drift.test.ts (D11 criterion 4, shrink-only
 *   ratchet seeded in test/pack-drift-allowlist.json under "attendance").
 *
 * ## Audited kernel-contract debt (D9) — who still reads the pack's core directly and why
 *
 * These outside callers are deliberately NOT rerouted through the facade: each is a legitimate
 * cross-module consumer that becomes a narrow KERNEL CONTRACT at a later rung (packs never import
 * each other — cross-module effects ride kernel-owned interfaces). They are allowlisted in the
 * ratchet until that contract exists; the list only shrinks.
 *
 * - `app/payroll/actions.ts` — `transferAllowancesToBatch`: attendance-derived allowances feed
 *   payroll input. Its contract HOME now exists: rung 3 established `PayrollInputContributor`
 *   (packs/contracts.ts) with claims as the first implementor (packs/claims/payroll.ts). This
 *   attendance path deliberately did NOT migrate at rung 3 (one seam per rung) — it stays
 *   allowlisted until a later rung registers an attendance contributor, no later than Payroll (7).
 * - `app/approvals/{page,actions}.ts` + `core/approvals-inbox.ts` — the approvals inbox lists and
 *   decides attendance corrections. Cross-module approvals substrate is KERNEL (ADR-0080 open
 *   decision 6); needs an approvals contract, not the pack facade.
 * - `core/reporting.ts` + `core/read.ts` — reporting/analytics read attendance rows and
 *   `evaluateAllowancesForPeriod`. Cross-module readers stay kernel (open decision 6); they should
 *   consume pack report descriptors/contracts, defined when the reporting seam is cut.
 * - `core/leave.ts` (`isoWeekday`) + `core/roster.ts` (`isoWeekday`, `shiftSpan`) — shared
 *   schedule/day-math vocabulary that happens to live in `core/attendance.ts`. Future kernel
 *   vocabulary (the D6 pattern); resolved no later than the Leave rung (6).
 *
 * ## Entitlement hook (D11 criterion 5 — NOT wired)
 *
 * ADR-0077's `tenant_module` / `isModuleEnabled()` primitives do not exist yet. The hook point is
 * `id: 'attendance'` below matching the future catalog row: when 0077 lands, the gate resolves
 * this pack via `modulePackById('attendance')` and fails closed (D3). No entitlement machinery is
 * built here by design.
 */
import {
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Clock,
  FileUp,
  HandCoins,
  Hourglass,
  MapPin,
  SlidersHorizontal,
} from 'lucide-react';
import { registerPack, type ModulePack, type NavNodeGroupDescriptor } from '../registry';

// The consolidated Attendance sidebar node (b3dc0f78), moved VERBATIM from components/sidebar.tsx
// at rung 2 — rows, hrefs, icons, ordering and visibility flags are unchanged; only the mounting
// moved (the sidebar now spreads this node via the registry). Provenance carried over:
// Records (was in the top group), Policy/Allowance/Clocking Location/Time-off-in-lieu (were in
// the admin group), Roster (was in the manage group) and Import grouped under one parent node
// with per-child role visibility. Holidays moved here from the admin group per 5cb199b3, which
// confirmed the relocation b3dc0f78 had deferred as contested (ticket order: Holidays → Policy
// → Allowance → Locations → TOIL). Reserved (do not create): an "Overtime Configuration" child
// is owned by item e776d17d; when its route lands it inserts itself here after Clocking Location.
// Child order (f60cd403): day-to-day rows first, then the admin-config screens, and the
// administrative bulk-upload Import ALWAYS last — it is used far less than daily attendance ops.
// NOTE: /admin/holidays, /roster and /admin/toil are NAV placement only — the holiday, roster and
// TOIL services stay outside this pack (they are not attendance services; nav grouping ≠ ownership).
/**
 * 0bb0e303 split the single Attendance node into THREE, by who each row is for. a324a4b3 rev2 puts
 * NINE of those ten rows back under ONE parent, because the reporter's screenshot settled it: they
 * want one "Attendance" fly-out, not the same word three times with different things inside each.
 * The rows themselves, their hrefs, icons and gates are unchanged — only which node they hang under.
 *
 * WHY TWO NODES AND NOT ONE. "Clock in/out" stays in its own My Attendance node: the screenshot does
 * NOT list it, and 5249d43f deliberately asked for a self-service node carrying clocking. Folding it
 * into the merged menu would undo that request to satisfy a screenshot that never mentioned it.
 *
 * WHY THE MERGED NODE IS group 'main' AND NOT 'admin'. The sidebar's Administration group is gated
 * adminOnly at the GROUP level, and its Manage group renders per-row. A node in 'admin' would hide
 * Records from every employee and Roster/Import from every non-admin manager — the exact silent
 * access regression 0bb0e303's three-way split existed to avoid. 'main' is ungated at group level,
 * so each child keeps its OWN gate (components/sidebar.tsx canSeeChild) and the parent renders for
 * anyone who can see at least one child: an employee sees Attendance containing just Records, a
 * manager also sees Roster + Import, an admin sees all nine. That also matches the picture, which
 * shows Attendance in the upper section beside My Absence and Claims, above the MANAGE heading.
 *
 * THE FLAGS ARE PER ROW AND MUST STAY THAT WAY. attendanceRecords carries NEITHER flag — carrying it
 * into a node whose other members are adminOnly must not make it, or the node, admin-only.
 */
const MY_ATTENDANCE_NAV: NavNodeGroupDescriptor = {
  labelKey: 'myAttendance',
  icon: Clock,
  group: 'main',
  children: [
    // Feedback 5249d43f: "Clock in/out" — the employee-facing clocking page — is the PRIMARY day-to-day
    // action. Records moved out to the merged Attendance node (a324a4b3 rev2), so this is now the node's
    // only row; it remains visible to every employee (self-service, like /me).
    { href: '/attendance/clock', labelKey: 'attendanceClock', icon: Clock },
  ],
};

/**
 * The ONE Attendance menu (a324a4b3 rev2), in the reporter's screenshot order:
 * Records, Holidays, Shift settings, Attendance policy, Attendance allowance, Clocking location,
 * Time off in lieu, Roster, Import.
 *
 * This merges the former ATTENDANCE_MANAGE_NAV (roster + import, managerUp) and ATTENDANCE_ADMIN_NAV
 * (the six adminOnly config screens) and pulls attendanceRecords up from MY_ATTENDANCE_NAV to the top.
 * All ten labels already resolved exactly as the screenshot before this change (r78 fixed the
 * key-vs-label drift); NO catalog string moved here — this is purely a regrouping.
 *
 * Icon: CalendarRange, carried from the Manage node rather than the Admin node's Clock, so the merged
 * parent does not render the same glyph as My Attendance directly above it in the collapsed rail.
 */
const ATTENDANCE_NAV: NavNodeGroupDescriptor = {
  labelKey: 'attendance',
  icon: CalendarRange,
  group: 'main',
  children: [
    // Every employee's own attendance record — NO gate, deliberately. See the node comment above.
    { href: '/attendance', labelKey: 'attendanceRecords', icon: Clock },
    { href: '/admin/holidays', labelKey: 'holidays', icon: CalendarDays, adminOnly: true },
    // R33 f21d6eee: "Shift settings" (/admin/attendance) is now the shared shift library; the per-company
    // working-hours + overtime-rates config moved to its own "Attendance policy" screen.
    //
    // a324a4b3 — THE LABEL KEYS NAME THEIR SCREENS AGAIN. R33 moved the screens and R17 (c9f7211) moved
    // the STRINGS with them, but the KEYS were left behind: `attendancePolicy` resolved to "Shift
    // settings" and `attendancePolicyConfig` to "Attendance policy". Every rendered row was correct and
    // had been for three weeks; only the keys lied. That is not cosmetic — the item was raised, planned
    // and sized off a reading of these two key names ("the shift library reads Attendance Policy"), and
    // the next reader would have repeated it, or worse, "corrected" the catalog VALUES to match the keys
    // and broken six locales for real. Keys now equal the strings they resolve to.
    //
    // lib/permissions.ts follows the labels (its `labelKey: 'nav.…'` entries) but KEEPS its screenKeys —
    // those may key stored role configs, the same split test/my-absence-nav.test.ts pinned for /leave.
    { href: '/admin/attendance', labelKey: 'shiftSettings', icon: CalendarClock, adminOnly: true },
    { href: '/admin/attendance-policy', labelKey: 'attendancePolicy', icon: SlidersHorizontal, adminOnly: true },
    { href: '/admin/attendance-allowance', labelKey: 'attendanceAllowance', icon: HandCoins, adminOnly: true },
    { href: '/admin/locations', labelKey: 'clockingLocation', icon: MapPin, adminOnly: true },
    // e776d17d reserves the "Overtime Configuration" child slot here (after Clocking Location, before Roster).
    { href: '/admin/toil', labelKey: 'timeOffInLieu', icon: Hourglass, adminOnly: true },
    // The two manager rows, last per the screenshot. managerUp resolves per row here (the node is in
    // the ungated 'main' group), so no manager loses Roster or Import to the merge.
    { href: '/roster', labelKey: 'roster', icon: CalendarRange, managerUp: true },
    // Import stays last: administrative bulk-upload, used less than daily attendance (f60cd403).
    { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, managerUp: true },
  ],
};

export const attendancePack: ModulePack = {
  id: 'attendance',
  kind: 'module',
  navNodes: [MY_ATTENDANCE_NAV, ATTENDANCE_NAV],
  // Pack-owned satellite tables (D5/D11 criterion 2 — documentation, not DDL). Audited from
  // db/schema.ts 2026-07-23. shift/roster_assignment/toil_* stay OUTSIDE (roster + TOIL services
  // are not part of this pack, mirroring the nav note above).
  satelliteTables: [
    { table: 'attendance', note: 'one row per employee-day: check-in/out, worked/OT minutes, status' },
    { table: 'attendance_punch', note: 'multi-punch trail behind each attendance day (R63–R65 clock portal)' },
    { table: 'attendance_correction', note: 'employee-requested corrections + approval decisions' },
    { table: 'attendance_policy', note: 'per-company working hours / grace / OT policy' },
    { table: 'attendance_rule', note: 'lateness / early-out / overtime rule library (88e94371)' },
    { table: 'attendance_rule_ot_row', note: 'per-rule OT rate rows' },
    { table: 'attendance_allowance_policy', note: 'attendance-triggered allowance policies' },
    { table: 'clocking_location', note: 'geofenced clocking sites (clock portal), not the org location spine' },
    { table: 'employee_clocking_location', note: 'employee ↔ clocking-site assignment + geofence flag' },
    { table: 'employee_device', note: 'registered clocking devices + revocation (device gate, R63)' },
  ],
  serviceFacade: 'packs/attendance/service',
};

// Static module-load registration (ADR-0080 D8 wiring convention, same as localization/registry.ts
// for country-my). Idempotent under dev HMR re-evaluation.
registerPack(attendancePack);
