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
 *   `core/attendance-rule.ts` (lateness/early-out/OT rule library), `core/attendance-calc.ts`
 *   (7c834696 stage 1 — the pure lateness/early-out/OT-band arithmetic), `core/attendance-derive.ts`
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
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  ClipboardList,
  Clock,
  FilePen,
  FileUp,
  HandCoins,
  Hourglass,
  MapPin,
  Plane,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { registerPack, type ModulePack, type NavNodeGroupDescriptor } from '../registry';

// The consolidated Attendance sidebar node (b3dc0f78), moved VERBATIM from components/sidebar.tsx
// at rung 2 — rows, hrefs, icons, ordering and visibility flags are unchanged; only the mounting
// moved (the sidebar now spreads this node via the registry). Provenance carried over:
// Records (was in the top group), Policy/Allowance/Clocking Location/Time-off-in-lieu (were in
// the admin group), Roster (was in the manage group) and Import grouped under one parent node
// with per-child role visibility. Holidays moved here from the admin group per 5cb199b3, which
// confirmed the relocation b3dc0f78 had deferred as contested (ticket order: Holidays → Policy
// → Allowance → Locations → TOIL) — and 4509d2b8 has since moved it BACK OUT, to System Settings
// (components/sidebar.tsx SYSTEM_SETTINGS_NODE). The remaining ticket order among the rows that
// stayed (Policy → Allowance → Locations → TOIL) is unchanged. Reserved (do not create): an
// "Overtime Configuration" child is owned by item e776d17d; when its route lands it inserts itself
// here after Clocking Location.
// Child order (f60cd403): day-to-day rows first, then the admin-config screens, and the
// administrative bulk-upload Import ALWAYS last — it is used far less than daily attendance ops.
// NOTE: /roster and /admin/toil are NAV placement only — the roster and TOIL services stay outside
// this pack (they are not attendance services; nav grouping ≠ ownership). core/holidays.ts is the
// same shape and always was — it is SPINE, read by leave, attendance and payroll alike — which is
// precisely why 4509d2b8 could move its row to System Settings without touching a service: nothing
// in this pack owns it, and nothing here breaks when its row is not here.
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
    // a324a4b3 rev3 — Records comes BACK here. rev2 pulled it up into the merged Attendance node while
    // that node sat in the ungated day-to-day group, which was fine. The reporter has now asked for that
    // node to move into Administration, and the admin group gates at GROUP level — so a Records row left
    // inside it would vanish from every plain employee's rail. It is self-service (no gate), so its home
    // is the self-service node.
    { href: '/attendance', labelKey: 'attendanceRecords', icon: Clock },
    // 0bb0e303 rev2 — the third self-service row the reporter listed. The attendance/overtime/travel
    // request forms existed already, but only as fold-outs on the employee's own My Profile page: you
    // had to know they were there. This row is the whole point of the item — the menu now reads Clock
    // in/out, Records, Attendance Request, and /me links across rather than holding the forms itself.
    // UNGATED, like its two siblings: every one of these is the caller's own request, and a gate here
    // would take the forms away from exactly the staff they exist for.
    // FilePen rather than a third Clock: the collapsed rail renders glyphs only, and a row that shares
    // its neighbours' icon is unreachable there.
    { href: '/attendance/requests', labelKey: 'attendanceRequest', icon: FilePen },
    // 1e9145d4 — Plan OT, the FOURTH self-service row, exactly where the reporter's screenshot puts it:
    // beside Clock in/out, Records and Attendance Request. Overtime MOVED here off the Attendance Request
    // screen, so overtime is filed in one place rather than two that drift apart. (2166ef79 moved it back
    // onto that screen and left this row forwarding into a tab; c6bb5f5a — the reversal declared below —
    // put the list back on this route, which is where it is now.)
    //
    // UNGATED, like its three siblings, and for the same reason: an overtime plan is the caller's OWN
    // request. A gate here would take the form away from precisely the staff it exists for.
    //
    // Hourglass, not a fourth Clock or a second FilePen — the collapsed rail renders glyphs only and a row
    // sharing a sibling's glyph is unreachable there. It is the same lucide ref the ADMIN node uses for
    // Time off in lieu, which is a DIFFERENT fly-out with no row in common, so no collapsed rail ever shows
    // the two side by side. (It is also the right picture: time set aside in advance.)
    { href: '/attendance/plan-ot', labelKey: 'planOvertime', icon: Hourglass },
    /**
     * c6bb5f5a — the FIFTH and SIXTH self-service rows, and a DELIBERATE REVERSAL of what the row above
     * them says. 2166ef79 folded Self Overtime, Travel Request and the request-history list onto ONE
     * screen (/attendance/requests) as tabs and a stack of cards, because that is what the reporter asked
     * for then; /attendance/plan-ot became a redirect into a tab. They have since asked for the opposite,
     * in writing and confirmed: four functions, four rows, four screens. So plan-ot renders its own list
     * again and these two give Travel and the request history the homes they never had — Travel Request
     * has been complete since ADR-0069 with no menu entry at all, and the history sat below four tabs
     * about something else.
     *
     * UNGATED, like their four siblings, and for the same reason: every one of these is the caller's OWN
     * request. A gate here would take the screens away from precisely the staff they exist for.
     *
     * Glyphs, not decoration: the collapsed rail renders icons ONLY, so no row may repeat a sibling's.
     * Plane (travel) and ClipboardList (a list of requests and their outcomes) are unused elsewhere in
     * this node. MapPin was the obvious pick for travel and is deliberately NOT used — it is the Clocking
     * location row in the Attendance settings node, and "off-site work window" and "where you may clock
     * in" are exactly the two things that must not read as one thing.
     *
     * ⚠️ ONE LEVEL ONLY. NavChildDescriptor has no `children` field and components/nav-flyout.tsx renders
     * a single level, so these are six rows side by side — not rows with sub-rows underneath.
     */
    { href: '/attendance/travel', labelKey: 'myTravel', icon: Plane },
    { href: '/attendance/request-status', labelKey: 'myAttendanceRequestStatus', icon: ClipboardList },
  ],
};

/**
 * The ONE Attendance configuration menu — labelled simply "Attendance" since 0bade264 (r209), carrying
 * the reporter's three categories (Shift, Overtime Pattern, Work Schedule), then Schedule Assignment,
 * then the three remaining configuration screens (Attendance allowance, Clocking location, Time off in
 * lieu).
 *
 * 0bade264 (r209) — THE LABEL WENT BACK TO "Attendance", AND THE KEY DID NOT. ad52212d round 1 renamed
 * the key `attendance` → `attendanceSettings` AND its string to "Attendance settings"; this round the
 * same reporter asked for the Administration entry to read plain "Attendance" again. Only the STRING
 * moved back: the key stays `attendanceSettings` because `nav.attendance` is a live, different label
 * (the /attendance Records column in lib/permissions.ts) and two keys cannot share a name.
 *
 * ⚠️ THE KEY THEREFORE NO LONGER CAMEL-CASES ITS OWN LABEL, DELIBERATELY. a324a4b3's rule — a nav key
 * spells the string it resolves to — still holds for every CHILD row here (test/attendance-pack.test.ts
 * enforces it over the adminOnly rows) and is knowingly suspended for this parent, because the
 * alternative is a second key called `attendance`. Do NOT "fix" it by renaming either key.
 *
 * ⚠️ AND THE COLLISION IT WOULD HAVE CREATED IS ALREADY PAID FOR. `nav.attendance` was itself the string
 * "Attendance" until this round; leaving it would have put the same word on two different things (this
 * menu and the operational Records screen's function-access column). It now reads "Attendance Records",
 * which is what that column covers (/attendance + /attendance/daily + /attendance/individual). Reverting
 * either half alone re-creates the duplicate the reporter raised — test/attendance-menu-relocation.ts
 * pins the pair.
 *
 * 4509d2b8 took HOLIDAYS out of this node. It was never an attendance service (core/holidays.ts is
 * spine — leave, attendance and payroll all read the one list), and gating its ROW behind the
 * billable `attendance` module meant a Leave-only tenant had no menu route to the holiday calendar
 * their leave calculations depend on. Its row now lives in components/sidebar.tsx
 * SYSTEM_SETTINGS_NODE; the screen, its URL and its requireAdmin guard are untouched. DO NOT put it
 * back here, and do not add /admin/holidays to MODULE_OF_HREF by hand — the un-gating IS the fix.
 *
 * It began (a324a4b3 rev2) as the reporter's screenshot order — Records, Holidays, Shift settings,
 * Attendance policy, Attendance allowance, Clocking location, Time off in lieu, Roster, Import — and
 * rev3 moved the three non-admin rows out (see below). Round 1 re-grouped what was left.
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
  // ad52212d ROUND 1 minted this key for the reporter's "Attendance > Settings" sub-menu. 0bade264 (r209)
  // changed the STRING it resolves to back to plain "Attendance" — their words — and left the key alone;
  // see the ⚠️ notes in the header above for why the key cannot simply become `attendance` again.
  labelKey: 'attendanceSettings',
  icon: CalendarRange,
  // a324a4b3 rev3 — 'admin', so the menu lands in Administration between Leave config and Claims config,
  // which is exactly what the reporter asked for: "just relocate the Attendance button below My Attendance
  // to admin section between Leave Config and Claim Config".
  //
  // ⚠️ THIS IS WHY THE NODE COULD NOT SIMPLY MOVE WHOLE. The admin group carries adminOnly at GROUP level
  // and the sidebar filters group-first, so a non-admin never reaches the per-row check for anything
  // inside it. Moving the rev2 node unchanged would have silently removed /attendance from every plain
  // employee and /roster + /attendance/import from every non-admin manager — a permissions change nobody
  // asked for, hidden inside a menu tidy-up. Records went back to My Attendance (above) and the two
  // manager rows became flat Manage rows (navLinks below); only the six adminOnly config screens travel.
  group: 'admin',
  children: [
    /**
     * ad52212d ROUND 1 — THE THREE CATEGORIES THE REPORTER NAMED, FIRST: Shift, Overtime Pattern, Work
     * Schedule. Then the remaining configuration screens, in the 5cb199b3 ticket order they have
     * always had among themselves (Attendance allowance → Clocking location → Time off in lieu;
     * Holidays led that tail until 4509d2b8 moved it to System Settings).
     *
     * WHY THIS IS THE WHOLE OF ROUND 1, AND WHY THERE IS NO NEW LANDING PAGE. The sidebar fly-out is
     * deliberately ONE level deep (components/nav-flyout.tsx; NavChildDescriptor has no `children`) — the
     * same constraint payroll hit at 1459e116 — so "Attendance › Settings › Shift" cannot be three tiers of
     * rail. It is expressed as it is here: an Administration node named for the settings it holds, whose
     * first three rows ARE the reporter's categories. No screen moved, no screen was created, and no
     * screen's behaviour changed; only where you find them did.
     *
     * WHAT DID CHANGE BESIDES THE ORDER: three labels. `/admin/attendance` reads "Shift" (was "Shift
     * settings" — the word "settings" is now the node above it), `/admin/attendance-policy` reads "Overtime
     * Pattern" (it IS one in substance: attendance_rule + attendance_rule_ot_row are hour-banded overtime
     * rates), and `/admin/attendance-policy/schedule` gets a row of its OWN as "Work Schedule" — the screen
     * existed but was reachable only from a button on the rule list, which is why the reporter read it as
     * absent. lib/permissions.ts follows the labels (its `labelKey: 'nav.…'` entries) and KEEPS its
     * screenKeys, exactly as a324a4b3 established; the schedule route already rides the
     * `attendancePolicyConfig` column, so no matrix column is created or moved.
     */
    // R33 f21d6eee: "Shift" (/admin/attendance) is the shared shift library; the per-company
    // working-hours + overtime-rates config lives on its own "Work Schedule" screen.
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
    { href: '/admin/attendance', labelKey: 'shift', icon: CalendarClock, adminOnly: true },
    { href: '/admin/attendance-policy', labelKey: 'overtimePattern', icon: SlidersHorizontal, adminOnly: true },
    // ad52212d — the Work Schedule screen (af7a8eb4 gave it this route) finally has a menu row. CalendarCheck
    // rather than a second CalendarRange/CalendarDays: the fly-out panel renders every child's glyph, and a
    // row sharing its parent's or a sibling's icon is indistinguishable there.
    { href: '/admin/attendance-policy/schedule', labelKey: 'workSchedule', icon: CalendarCheck, adminOnly: true },
    // 0bade264 (r209) — SCHEDULE ASSIGNMENT: every employee's current shift arrangement in ONE list, with
    // View / Edit opening the SAME editor as Personnel Management › Employee › Attendance › Shift
    // arrangement (app/admin/personnel/[employmentId] ?tab=attendance#section-default-shift). Deliberately
    // a link into that card and not a second form: the request is that both surfaces act on one record,
    // and a duplicate editor is precisely how the two would drift.
    //
    // It sits FOURTH — after the reporter's three named settings categories, ahead of the 5cb199b3 tail —
    // because it is the screen that USES the shift library the three above configure, not a fourth
    // category of settings. adminOnly like every other row in this node (the parent group gates wholesale,
    // so a row without the flag would be admin-only anyway and silently so).
    //
    // Users, not a fourth calendar glyph: the fly-out panel renders every child's icon and the collapsed
    // rail renders glyphs alone, so a row sharing a sibling's picture is unreachable there. It is also the
    // right picture — this screen is the people side of the schedule, where its neighbours are the shapes.
    { href: '/admin/attendance/schedule-assignment', labelKey: 'scheduleAssignment', icon: Users, adminOnly: true },
    // 4509d2b8 — the Holidays row USED TO SIT HERE, ahead of Attendance allowance. It is now a child of
    // SYSTEM_SETTINGS_NODE in components/sidebar.tsx. Leaving a copy here would both duplicate the row
    // and re-enter it into MODULE_OF_HREF (built by flatMap over these children), which is exactly the
    // entitlement gating the move exists to remove.
    { href: '/admin/attendance-allowance', labelKey: 'attendanceAllowance', icon: HandCoins, adminOnly: true },
    { href: '/admin/locations', labelKey: 'clockingLocation', icon: MapPin, adminOnly: true },
    // e776d17d reserves the "Overtime Configuration" child slot here (after Clocking Location, before Roster).
    { href: '/admin/toil', labelKey: 'timeOffInLieu', icon: Hourglass, adminOnly: true },
  ],
};

/**
 * a324a4b3 rev3 — Roster and Import, as FLAT Manage rows rather than children of the Attendance node.
 *
 * They are managerUp, and the node they used to live in has moved into the admin-gated group. Left there
 * they would disappear for every non-admin manager. A third parent node literally labelled "Attendance"
 * is not the answer either — that duplicated menu is what the reporter objected to in the first place.
 * Flat rows in Manage, beside Approvals and Performance, is where a manager already looks.
 *
 * Import stays after Roster: administrative bulk-upload, used less than daily attendance (f60cd403).
 */
const ATTENDANCE_MANAGE_LINKS = [
  { href: '/roster', labelKey: 'roster', icon: CalendarRange, managerUp: true, group: 'manage' as const },
  { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, managerUp: true, group: 'manage' as const },
];

export const attendancePack: ModulePack = {
  id: 'attendance',
  kind: 'module',
  navNodes: [MY_ATTENDANCE_NAV, ATTENDANCE_NAV],
  navLinks: ATTENDANCE_MANAGE_LINKS,
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
