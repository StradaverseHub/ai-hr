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
 *   `app/admin/attendance-allowance/`.
 *
 *   639bf4a5 (r336) — `app/admin/locations/` (clocking-site admin) IS NO LONGER ON THIS LIST, and the
 *   matching entry left test/attendance-pack-drift.test.ts's ALWAYS_ALLOWED in the same commit. The
 *   register moved to Organization as "Physical Work Location" (app/admin/work-locations/), taking its
 *   clocking points with it at the reporter's approval. It reads this pack the way every other outside
 *   caller does — through `packs/attendance/service` — and the ratchet SHRANK by one entry rather than
 *   gaining one. The old addresses stay as guarded redirect stubs under app/admin/locations/ and import
 *   nothing from this pack.
 *
 *   ⚠️ 639bf4a5 rev 2 (r338) — THE MENU ROW CAME BACK TO THIS PACK AND THE SURFACE CLAIM DID NOT, which
 *   is not a contradiction: the ratchet is about IMPORTS, not menus. The reporter asked for the screen
 *   back under Attendance as "Locations", so ATTENDANCE_NAV carries the row again (see the note beside
 *   it) — but app/admin/work-locations/** still consumes this pack ONLY through the published facade, so
 *   it needs no claim here and none is added. ADR-0080 allowlists only ever shrink; re-adding the
 *   deleted prefix at the new address would re-open the same hole and fail the guard by design.
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
  CreditCard,
  CalendarClock,
  CalendarCog,
  CalendarRange,
  ClipboardList,
  Clock,
  FilePen,
  FileUp,
  HandCoins,
  Hourglass,
  MapPin,
  Table2,
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
 * THE FLAGS ARE PER ROW AND MUST STAY THAT WAY. The self-service rows carry NEITHER flag — carrying one
 * into a node whose other members are adminOnly must not make it, or the node, admin-only.
 *
 * f3e6c36e (r287) — the `attendanceRecords` row that this paragraph and the one above used to name is
 * gone from here. It pointed at `/attendance`, the screen both audiences shared; it is now `myRecords`
 * pointing at `/attendance/my-records`, and `/attendance` belongs to the Administration row alone. The
 * reasoning is on the row itself. `nav.attendanceRecords` is NOT retired — app/reports/page.tsx still
 * labels its `/attendance` link with it, and that link is the admin screen.
 *
 * 2aef3cd8 (r362) — that row reads "Attendance Overview" now, and the screen behind it is BLANK below its
 * title. The KEY `myRecords` is unchanged (label-only rename, the a324a4b3 pattern); only the six strings
 * moved. Read the note on the row before assuming the route is spare.
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
    /**
     * f3e6c36e (r287) — THE SPLIT. This row used to point at `/attendance`, the same screen the admin
     * "Employee Attendance" row opens. It now points at the employee's OWN screen and the admin screen is
     * left to the administrator alone. Read the history before moving it back:
     *
     *   • a324a4b3 rev2 moved Records into the merged Attendance node; rev3 undid it, because that node
     *     went into Administration and the Administration sidebar group gates `adminOnly` at GROUP level —
     *     a row inside it renders for NOBODY but administrators, whatever its own flag says. So moving
     *     this row does not make the screen admin-only, it makes it invisible to staff.
     *     `test/sidebar-attendance-group.test.ts` exists to stop a third attempt and is still live.
     *   • The reporter then asked a SECOND time, in writing, for the administrative Record function to
     *     leave My Attendance. Under the fight-back rule an instruction reaffirmed after a challenge is
     *     the owner's decision, so r287 takes it — and delivers it by SPLITTING rather than by moving,
     *     which is the one way both things can be true at once. Their own point 7 (employee-facing
     *     attendance functions stay under My Attendance) is what the new screen honours.
     *
     * UNGATED, like every sibling in this node. THE OLD REASON, kept because it is why the gate must not
     * arrive later: `/attendance/my-records` resolved the caller's own employment and could show nobody
     * else's rows, so a gate here would have taken an employee's own record away from them.
     *
     * ⚠️ 2aef3cd8 (r362) — THAT SCREEN IS NOW EMPTY, and the row reads "Attendance Overview". The reporter
     * asked for the rename and for everything under the row to be removed; the approved plan says "Below
     * the title the page is blank." So the sentence above describes a read that no longer happens. The row
     * stays exactly where it is, ungated, and the route stays registered, because the plan's own next
     * sentence is that new content arrives here later.
     *
     * WHAT THE READER MUST NOT DO WITH THAT: this route is not spare, and it is not a candidate for
     * deletion just because it renders nothing. It is the ONLY employee-reachable address under My
     * Attendance that is free to hold an attendance view — the four siblings are clocking, requests,
     * plan-ot and request-status (b833a077 took the fifth, My Travel, out of this node entirely), and
     * everything under ATTENDANCE_NAV is invisible to staff behind the group-level admin gate. Until content returns, an employee has nowhere in the product to look up
     * their own attendance day by day; that consequence was stated at the top of the approved plan, the
     * reporter approved it, and it is recorded on the page and in the r362 round entry.
     *
     * Clock rather than a new glyph: the collapsed rail renders glyphs only, and this is the same row the
     * reporter has always known as Records — it is the address and the audience that changed, not the job.
     * It shares Clock with `/attendance/clock` exactly as it did before the split (that pair predates this
     * round and is unchanged by it).
     */
    { href: '/attendance/my-records', labelKey: 'myRecords', icon: Clock },
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
     * c6bb5f5a — the FIFTH self-service row, and a DELIBERATE REVERSAL of what the row above it says.
     * 2166ef79 folded Self Overtime, Travel Request and the request-history list onto ONE screen
     * (/attendance/requests) as tabs and a stack of cards, because that is what the reporter asked for
     * then; /attendance/plan-ot became a redirect into a tab. They have since asked for the opposite, in
     * writing and confirmed: four functions, four rows, four screens. So plan-ot renders its own list
     * again and this row gives the request history the home it never had — it sat below four tabs about
     * something else.
     *
     * ⚠️ b833a077 (r362) — THERE WERE SIX ROWS HERE AND THERE ARE FIVE. c6bb5f5a added My Travel beside
     * this one, at /attendance/travel, carrying the Plane glyph; the reporter has since asked for My
     * Travel to be removed completely, and the approved plan takes the row, the screen, the form and the
     * approvals section with it. What did NOT go: the travel_request table, its rows, its RLS policy, its
     * grant, migration 0146, the company-change gate that reads the table (core/read.ts
     * employmentCompanyBlockedTx) and the approval-history label for historic travel decisions
     * (lib/approval-history.ts). The records are kept for audit and are simply no longer reachable from
     * any screen. The old address still answers — it is a redirect to /attendance/clock, so a bookmark
     * lands somewhere an employee can use rather than on a 404. DO NOT re-add the row without re-adding
     * the screen: the redirect is not a hidden page waiting to be re-linked.
     *
     * UNGATED, like its four siblings, and for the same reason: every one of these is the caller's OWN
     * request. A gate here would take the screen away from precisely the staff it exists for.
     *
     * Glyphs, not decoration: the collapsed rail renders icons ONLY, so no row may repeat a sibling's.
     * ClipboardList (a list of requests and their outcomes) is unused elsewhere in this node. Plane left
     * with the travel row and is no longer imported. The map-pin glyph is still deliberately NOT used
     * here: it is the Physical Work Location row (Administration, components/sidebar.tsx — 639bf4a5 moved
     * it out of this pack), and "where you may clock in" must not read as anything else.
     *
     * ⚠️ ONE LEVEL ONLY. NavChildDescriptor has no `children` field and components/nav-flyout.tsx renders
     * a single level, so these are five rows side by side — not rows with sub-rows underneath.
     */
    { href: '/attendance/request-status', labelKey: 'myAttendanceRequestStatus', icon: ClipboardList },
    /**
     * 6948727a (r369) — the SIXTH self-service row: the employee's own roster, read only.
     *
     * The reporter's words on the ticket are the whole specification: "New sub menu – My Roster. This is
     * for employee to view only the Roster that assigned by their supervisor." The function is not new —
     * `roster_assignment` has held these rows since migration 0075 — but until now the ONLY screen over
     * them was `/roster`, which is an administrator's grid of everybody and sits in the group-gated
     * Administration section. So from an employee's chair their own roster did not exist, which is
     * exactly the shape of ticket this menu keeps receiving.
     *
     * UNGATED, like its five siblings, and for a reason one step removed from theirs: the others are the
     * caller's OWN REQUESTS, and this is the caller's OWN SCHEDULE. A gate here would take an employee's
     * shift times away from the employee. What keeps it honest is not the menu — `/attendance/my-roster`
     * resolves the caller's employment server-side and takes no employment id at all (see
     * core/roster.ts myRosterWindow) — because a row that is merely absent from a menu is still a URL.
     *
     * ⚠️ THE GLYPH IS CalendarRange, WHICH `/roster` ALSO CARRIES, and that is deliberate rather than an
     * oversight. The collapsed rail renders glyphs only, so no row may repeat a SIBLING's — and `/roster`
     * is not a sibling: it lives in ATTENDANCE_NAV and in the flat Manage links, never in this node, so no
     * collapsed rail ever draws the two side by side. Sharing the picture is the right answer where the
     * two rows genuinely show the same thing to two audiences, exactly as Clock and Attendance Overview
     * share Clock one node up.
     *
     * ⚠️ ONE LEVEL ONLY, as the note above says: this is a sixth row beside the five, not a child of one.
     */
    { href: '/attendance/my-roster', labelKey: 'myRoster', icon: CalendarRange },
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
    /**
     * r274 (2420718d) — EMPLOYEE ATTENDANCE, and it is a SECOND DOOR rather than a move.
     *
     * The reporter asked for "My Attendance > Records" to be relocated here and renamed. Taken literally
     * that removes the screen from every employee: `/attendance` is `guard: 'scopedSession'`
     * (lib/permissions.ts:186) with no admin gate — ONE screen that shows each viewer their own scope, a
     * single row to an employee and all 83 to an administrator — and this group carries `adminOnly` at
     * GROUP level, so a row moved inside it becomes INVISIBLE, not admin-only. a324a4b3 rev2 did exactly
     * that and rev3 undid it; `test/sidebar-attendance-group.test.ts` exists to stop it happening a third
     * time. So Records STAYED in MY_ATTENDANCE_NAV and this row was added beside it.
     *
     * ── f3e6c36e (r287): THE SECOND DOOR IS NOW THE ONLY DOOR, AND THE DISCLOSURE BELOW IS DISCHARGED ──
     *
     * r274 disclosed a known cost: the same href in two nodes, so opening `/attendance` lit BOTH parent
     * rows (`isParentActive`, components/nav-flyout.tsx, matches any child path). It recorded the two ways
     * out and why each was worse — in particular that a distinct route rendering the SAME page breaks the
     * screen's own tab strip (`/attendance`, `/attendance/daily`, `/attendance/individual`), so entering by
     * one door and clicking a tab drops you out of it.
     *
     * The reporter reaffirmed after that challenge, so r287 takes the owner's decision and resolves it the
     * third way r274 did not have: not a second route onto the same page, but a genuinely DIFFERENT
     * employee screen — `/attendance/my-records`, its own reads keyed on the caller's own employment, and
     * NO tab strip at all (that decision and its reasoning are written into the page). `/attendance` is
     * now reached from this row alone.
     *
     * So this row is no longer a duplicate href, it is simply THE Employee Attendance row: the
     * administrative reading of everybody's attendance, admin-gated, in the Administration menu where the
     * reporter asked for it twice. The employee kept their own record next door, which was their point 7 —
     * ⚠️ and since 2aef3cd8 (r362) that next-door screen is blank by their own later instruction, so this
     * row is the ONLY place in the product where an attendance record is read day by day. It is
     * admin-gated, so staff do not reach it.
     */
    { href: '/attendance', labelKey: 'employeeAttendance', icon: Clock, adminOnly: true },
    // 22d67223 — ATTENDANCE BREAKDOWN DETAIL. The audit surface: every figure the engine recorded, day by
    // day, for one employee over a range. Deliberately the opposite of 570fd56e, which took the calculation
    // columns OFF Individual Attendance — one screen to review a month, one to interrogate it.
    { href: '/attendance/breakdown', labelKey: 'attendanceBreakdown', icon: Table2, adminOnly: true },
    /**
     * fe2360f9 + 7c80a168 (r314) — ROSTER and IMPORT, back in this node as ADMIN-ONLY rows, DELIBERATELY
     * DUPLICATING the two managerUp rows in Manage that stay exactly where they are.
     *
     * ⚠️ READ a324a4b3 rev3 BELOW BEFORE TOUCHING THIS. It moved these two OUT of this node precisely
     * because the node sits behind the group-level admin gate, so a managerUp row here is invisible to
     * every non-admin manager — and it rejected "a third parent node labelled Attendance" because the
     * duplicated menu was what the reporter objected to in the first place.
     *
     * NOTHING ABOUT THAT ANALYSIS HAS CHANGED. What changed is that the reporter was shown the trade in
     * writing (7c80a168) and CHOSE the duplication: administrators get every attendance-administration
     * function in one place, managers keep the rows they use today, and the price is that an
     * administrator sees Roster and Import twice. That is the owner's decision on a question that was
     * theirs — taking a function away from their managers was never ours to choose — and it is recorded
     * in the r314 round entry.
     *
     * THE TWO SETS MUST STAY IN STEP. These are adminOnly duplicates of ATTENDANCE_MANAGE_LINKS, not
     * replacements: removing the Manage rows is what the reporter was told would NOT happen, and
     * removing these is what they asked for. They point at the same routes, which is why neither set
     * needs its own guard beyond the exact-set nav tests.
     *
     * Import after Roster, the f60cd403 order: administrative bulk-upload is used less than the roster.
     */
    { href: '/roster', labelKey: 'roster', icon: CalendarRange, adminOnly: true },
    { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, adminOnly: true },
    { href: '/admin/attendance', labelKey: 'shift', icon: CalendarClock, adminOnly: true },
    // 44bc1c33 — CARD ASSIGNMENT. The employee↔Card/Clocking ID mapping a physical terminal needs when its
    // card numbers are not the employee codes. Admin-only and beside Shift because it is device
    // configuration, not a record anybody reads day to day.
    { href: '/admin/card-assignment', labelKey: 'cardAssignment', icon: CreditCard, adminOnly: true },
    /**
     * ⚠️ e4471e3c (r287) — TWO ROWS WERE REMOVED HERE, AND THEIR SCREENS WERE NOT. READ THIS BEFORE
     * ADDING EITHER BACK.
     *
     * `/admin/attendance-policy` ("Schedule Group", 870b79e2 — the attendance_rule library that names the
     * lateness, early-out and overtime rules a set of shifts share) and
     * `/admin/attendance-policy/schedule` ("Work Schedule", ad52212d — the per-company attendance_policy,
     * the fallback for a day with no shift) both left this menu. The reporter asked for exactly that:
     * "Schedule Group and Work Schedule shall be consolidated into the existing Schedule sub-menu ...
     * to provide a single centralised Schedule configuration area".
     *
     * THE ROWS WENT; THE ROUTES STAYED, deliberately, and they are still registered in lib/permissions.ts
     * under `attendancePolicyConfig` — a screenKey is a PERMISSION IDENTITY, and removing or renaming one
     * silently revokes whatever stored role configuration references it. Both pages also still own things
     * this round did not move:
     *
     *   · the deduction switch (`apply_deductions` + `deductions_effective_from`), which stays on the
     *     Schedule Group editor because its start date is stamped by the service and can never be typed;
     *   · the overtime BANDS and RATES, and the group's name / status / allowed shifts;
     *   · the tenant overtime RATES, the registered-device table and backup-shift coverage, none of which
     *     is a schedule setting at all.
     *
     * They are reached from the Schedule screen, which links to both — the General tab to the Work
     * Schedule page, and the Attendance and Overtime tabs to the Schedule Group editor for the group in
     * view. Removing those links would strand the settings above, so they are pinned in
     * test/schedule-config-screen.test.ts.
     */
    // 1c5602cc (r263) — SCHEDULE: the tabbed configuration screen for an employee's working pattern
    // (General built; Holiday / Overtime / Attendance / Request / Notification ship NAMED and EMPTY).
    //
    // IT SAT BESIDE "Work Schedule" FOR FOUR ROUNDS, AND e4471e3c (r287) IS THE CUTOVER. The a6fe37fc
    // playbook: build alongside, prove the old behaviour unchanged, and only then move the menu and
    // retire what it replaces. r263 built alongside and recorded that the reporter had been asked to
    // steer whether Work Schedule is absorbed; they answered by raising e4471e3c, which asks for Schedule
    // Group AND Work Schedule to be consolidated into this row. So both of those rows are gone (the note
    // above this one says where their screens went and why they survive), and THIS is now the single
    // entry point for schedule configuration — the General tab edits the per-company working week, and
    // the Attendance and Overtime tabs edit the Schedule Group's recording and rounding settings.
    //
    // ⚠️ CORRECTION, r263 verify — DO NOT "FIX" A NAME THAT IS ALREADY RIGHT. The 1c5602cc plan told the
    // reporter that the Work Schedule row opens a page headed "Shift settings", and an earlier draft of
    // this comment repeated it. It is FALSE, checked in the rendered DOM: /admin/attendance-policy/schedule
    // renders PageHeader title={tr('scheduleSectionTitle')} = "Company work schedule & overtime rates"
    // (app/admin/attendance-policy/schedule/page.tsx:120-122). "Shift settings" is admin.attendancePolicy.
    // pageTitle, the H1 of /admin/attendance — the row labelled "Shift" two rows up. The namespace was
    // grepped without checking which page rendered it (AGENTS 7). There is no nav/title disagreement here
    // to repair; the cutover is a consolidation of CONTENT.
    //
    // CalendarCog, not a fourth calendar-with-a-tick: the fly-out panel renders every child's glyph and
    // the collapsed rail renders glyphs ALONE, so a row sharing a sibling's picture is unreachable there.
    // It is also the right picture — this is the settings screen for the shapes its neighbours use.
    { href: '/admin/attendance/schedule', labelKey: 'schedule', icon: CalendarCog, adminOnly: true },
    // 0bade264 (r209) — SCHEDULE ASSIGNMENT: every employee's current shift arrangement in ONE list.
    // View / Edit has moved twice since: r209 linked into the personnel card, r263 (a485afa1) opened a
    // panel on the list, and r265 (a485afa1 rev 2) opens the employee's OWN page under this route
    // (app/admin/attendance/schedule-assignment/[employmentId]). It is still one record with the
    // personnel card — the page mounts the card's own control and calls the card's own writer — which
    // is how both surfaces act on one record without a duplicate editor drifting. No nav row for the
    // sub-page: it is reached from the list, exactly as a shift's edit page is reached from the library.
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
    /**
     * 639bf4a5 rev 2 (r338) — LOCATIONS IS BACK IN THIS NODE, AND IT IS THE REPORTER'S DECISION.
     *
     * The row was "Clocking location" here until r336, which moved it to Administration › Physical Work
     * Location on the argument that a place the company operates from is master data rather than an
     * attendance setting. That shipped. The reporter contested it and asked for the screen back under
     * ATTENDANCE, renamed **Locations**, with a company listing and dedicated Add / View / Edit screens.
     * It is their structure to decide; this is that structure, built as they described it.
     *
     * ⚠️ THE ADDRESS DID NOT MOVE BACK. `/admin/work-locations` is unchanged — they asked to rename the
     * FUNCTION, not the URL, and moving it a second time in two days would churn every bookmark again
     * and need the three `/admin/locations` redirect stubs re-pointed for nothing. Nor did
     * `screenKey: 'locations'` (lib/permissions.ts): that is a permission identity stored role configs
     * may name. Only `labelKey` and this PARENT changed. `nav.locations` is the label key — a string
     * that has read "Locations" in all six catalogues since ADR-0054 and had been left unrendered when
     * r336 minted `nav.physicalWorkLocation`; that newer key is deleted, because a live-looking nav key
     * nothing renders is how a retired row comes back.
     *
     * ⚠️ AND THE REGISTER IS ENTITLEMENT-GATED AGAIN, KNOWINGLY. MODULE_OF_HREF (components/sidebar.tsx)
     * is built by flatMap over THESE children and `attendance` is billable (isCore:false in
     * packs/catalog.ts), so this row puts the work-site register — and the branch mapping that hangs off
     * it — behind the attendance entitlement. That is the 4509d2b8 Holidays fault in reverse, and it is
     * a real consequence rather than an oversight: the tenant HAS attendance so nothing changes for them,
     * a future Leave-only customer would have no route to either screen, the plan said so and offered to
     * keep it un-gated, and the reporter did not answer. Their words, their structure. Un-gating it later
     * is one hand-written MODULE_OF_HREF exemption, nothing more.
     *
     * ⚠️ THE PACK'S SURFACE CLAIM DOES NOT COME BACK WITH IT. `app/admin/locations/` left this file's
     * surface list and test/attendance-pack-drift.test.ts's allowlist in r336, and both stay as they are:
     * the ratchet is about IMPORTS, not menus. app/admin/work-locations/** reads the clocking register
     * through `packs/attendance/service` like any other outside consumer, so it needs no claim — and
     * ADR-0080 allowlists only ever shrink.
     *
     * MapPin, as it always was: the fly-out renders every child's glyph and the collapsed rail renders
     * glyphs ALONE, and no sibling in this node carries it.
     */
    { href: '/admin/work-locations', labelKey: 'locations', icon: MapPin, adminOnly: true },
    //
    // e776d17d reserves the "Overtime Configuration" child slot here (after Attendance allowance, before Roster).
    // 3fb1a611 (r299) — the Time off in lieu row (/admin/toil, label key timeOffInLieu) STOOD HERE and is
    // DELIBERATELY GONE. That address
    // is a redirect stub to Leave Config › Leave Credit now, which holds the same ledger summary and the two
    // settlement sweeps beside every credit movement — one screen per fact. A menu row pointing at a redirect
    // is a row that reaches its screen through a wasted hop, under a module (attendance) that is not the one
    // that governs it (toil).

  ],
};

/**
 * a324a4b3 rev3 — Roster and Import, as FLAT Manage rows rather than children of the Attendance node.
 *
 * ⚠️ r314 (fe2360f9 + 7c80a168) — THESE ROWS STAY, and they are no longer the only ones. The reporter
 * asked for both functions under Admin › Attendance; they were shown that moving them there would take
 * both rows away from every manager, and they chose to have them in BOTH places rather than lose them.
 * So the node now carries adminOnly duplicates and this set is untouched. Deleting either set breaks a
 * promise made to the reporter in writing — see the note beside the duplicates in ATTENDANCE_NAV.
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
  /**
   * 1661123d (r317) — IMPORT'S MANAGE ROW IS GONE, and Roster's stays. They are not a pair any more.
   *
   * The row was `managerUp` while app/attendance/import/page.tsx calls `requireAdmin()`, which redirects
   * a non-admin to '/'. So it advertised a screen every manager was bounced out of — found while r314
   * was moving both rows, pre-existing, and put to the reporter rather than fixed on our own judgement:
   * the opposite fix (let managers import) widens who can write other people's attendance, because
   * `importAttendancePunches` writes for every employment the file names and the page guard is not what
   * scopes that. They chose to remove the row.
   *
   * NOBODY LOST A FUNCTION. No manager could import attendance before; the menu simply stopped saying
   * they could. Import remains exactly where r314 put it for administrators, in the Attendance node.
   *
   * ROSTER IS DIFFERENT AND UNTOUCHED: app/roster/page.tsx is `scopedSession`, so it genuinely works for
   * a manager. That asymmetry is why the two rows had to be checked separately rather than as a pair.
   */
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
