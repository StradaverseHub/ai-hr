'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  Clock,
  FileBarChart,
  Hash,
  Sparkles,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  Megaphone,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Lock,
  ScrollText,
  Settings2,
  Share2,
  Timer,
  ShieldCheck,
  Smartphone,
  Tags,
  Target,
  UserRound,
  UserRoundPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApprovalCountBadge } from '@/components/approval-count-badge';
import {
  NavFlyout,
  NavFlyoutPanel,
  isHrefActive,
  isNavRowActive,
  isParentActive,
  type FlyoutChild,
} from '@/components/nav-flyout';
// ADR-0080 rungs 2-7: every module pack's nav mounts from the pack registry, so the packs must be
// REGISTERED before this module's body runs. The five side-effect imports that used to sit here moved
// to packs/register-all.ts — unchanged in effect, but reachable from server code too. They lived in a
// client component, which meant any caller of listPacks('module') outside the client bundle silently
// got an empty array; today that caller is the catalog<->registry drift ratchet (ADR-0077), and slice
// 4's nav filter is next. Each pack index stays client-safe by design, so this import pulls no
// server-only code into the bundle. See that file's header.
import '@/packs/register-all';
import { modulePackById } from '@/packs/registry';

// `labelKey` indexes the `nav` message namespace; labels are resolved at render via useTranslations.
// `tour` (optional) marks the element as an onboarding-tour anchor (ADR-0018).
type Item = { href: string; labelKey: string; icon: LucideIcon; tour?: string };
// A flyout parent node (b3dc0f78, flyout redesign fdc20776): one level of nesting only. Each child
// carries its own visibility flag so filtering is per-child (vs. whole-group gating).
type ChildItem = Item & {
  adminOnly?: boolean;
  managerUp?: boolean;
  // 388e53c2 — highlighting only, never a gate. See NavChildDescriptor in packs/registry.ts.
  exactHref?: boolean;
  ownedSubpaths?: string[];
};
type CollapsibleGroupItem = {
  collapsible: true;
  labelKey: string;
  icon: LucideIcon;
  children: ChildItem[];
};
type Row = ChildItem | CollapsibleGroupItem;
const isCollapsible = (r: Row): r is CollapsibleGroupItem => 'collapsible' in r && r.collapsible;
type Group = { labelKey?: string; adminOnly?: boolean; managerUp?: boolean; items: Row[] };

// Consolidated Attendance node (b3dc0f78 / 5cb199b3 / f60cd403 / 5249d43f). Since ADR-0080 rung 2
// its rows live on the attendance pack (packs/attendance/index.ts, ATTENDANCE_NAV — provenance
// comments moved with them) and mount here through the registry: labels, hrefs, icons, ordering
// and per-child visibility flags are the pack's verbatim; only the mounting moved. The pack is
// registered by the static side-effect import above, so the non-null assertions cannot fire.
// NavChildDescriptor mirrors ChildItem by construction (packs/registry.ts), so the spread
// type-checks against the sidebar's own Row machinery unchanged.
// 0bb0e303 split the one Attendance node into three, by audience; a324a4b3 rev2 merged the manager and
// admin nodes back into ONE "Attendance" fly-out (the reporter's screenshot), leaving My Attendance to
// carry Clock in/out alone. Since 895c80f9 a pack contributes an ARRAY of group-tagged nodes; BOTH
// attendance nodes now declare group 'main', so they resolve by labelKey rather than by group — group
// alone stopped identifying a node the moment two of them shared one, and `.find(n => n.group === …)`
// would silently have returned My Attendance for both. The rows, hrefs, icons and per-child gates are
// the pack's verbatim; only which node they hang under moved.
const ATTENDANCE_NODES = modulePackById('attendance')!.navNodes!;
const node = (labelKey: string): CollapsibleGroupItem => ({
  collapsible: true,
  ...ATTENDANCE_NODES.find((n) => n.labelKey === labelKey)!,
});
const MY_ATTENDANCE_NODE = node('myAttendance');
// a324a4b3 rev3 — Roster + Import, mounted from the pack's navLinks rather than from a nav node.
const ATTENDANCE_MANAGE_ROWS: ChildItem[] = (modulePackById('attendance')!.navLinks ?? []).filter(
  (l) => l.group === 'manage',
);
// The Attendance CONFIG menu, in the Administration group. ad52212d round 1 renamed its label key
// `attendance` → `attendanceSettings` ("Attendance settings"), because it is the reporter's
// Attendance › Settings sub-menu and opens on the three categories they named (Shift, Overtime
// Pattern, Work Schedule).
//
// 0bade264 (r209) — THE SAME REPORTER ASKED FOR THE LABEL BACK: this entry reads plain "Attendance"
// again. Only the STRING moved; the KEY is still `attendanceSettings`, because `nav.attendance` is a
// live label of a different thing (the /attendance Records column in lib/permissions.ts) and two keys
// cannot share a name. That other label was itself the word "Attendance", so renaming this one alone
// would have produced two entries reading the same — it is now "Attendance Records", which is what its
// column covers. Both halves are pinned together by test/attendance-menu-relocation.test.ts; reverting
// either one alone re-creates the duplicate the reporter raised.
//
// The const name is unchanged — its MOUNT POSITION between Leave config and Claims config is pinned by
// test/attendance-menu-relocation.test.ts through this identifier.
const ATTENDANCE_NODE = node('attendanceSettings');

// Claims nav rows (ADR-0080 rung 3): two flat rows the claims pack contributes
// (packs/claims/index.ts, CLAIMS_NAV_LINKS — provenance comments moved with them), placed at
// their pre-rung-3 positions below: "/claims" in the top group (every employee), "/admin/claims"
// in the Administration group (group-gated adminOnly, no per-row flag — unchanged). The `group`
// tag is the pack's placement declaration; position WITHIN the group stays this file's concern.
const CLAIMS_LINKS = modulePackById('claims')!.navLinks!;
const CLAIMS_ROW: ChildItem = CLAIMS_LINKS.find((l) => l.group === 'main')!;
const CLAIMS_CONFIG_ROW: ChildItem = CLAIMS_LINKS.find((l) => l.group === 'admin')!;

// Performance nav row (ADR-0080 rung 4): the single manager-up row the performance pack
// contributes (packs/performance/index.ts, PERFORMANCE_NAV_LINKS — provenance comments moved with
// it), placed at its pre-rung-4 position in the Manage group below, after Approvals. The `group`
// tag is the pack's placement declaration; position WITHIN the group stays this file's concern.
const PERFORMANCE_ROW: ChildItem = modulePackById('performance')!.navLinks!.find((l) => l.group === 'manage')!;

// Leave nav rows (ADR-0080 rung 6): two flat rows the leave pack contributes (packs/leave/index.ts,
// LEAVE_NAV_LINKS — provenance comments moved with them), placed at their pre-rung-6 positions below:
// the "My Absence" row (/leave) in the top group (every employee), the "Leave configuration" row
// (/admin/leave) in the Administration group (group-gated adminOnly, no per-row flag — unchanged).
// The `group` tag is the pack's placement declaration; position WITHIN the group stays this file's
// concern.
const LEAVE_LINKS = modulePackById('leave')!.navLinks!;
const LEAVE_ABSENCE_ROW: ChildItem = LEAVE_LINKS.find((l) => l.group === 'main')!;
// a00c4f64 — "Team Leave Tracker", the Leave Calendar's own screen after it left the Dashboard. It goes
// in the Manage group (the reporter asked for it there) and carries NO gate, which is the point: the
// group gates per row, and every employee could see this calendar before the move.
const LEAVE_TRACKER_ROW: ChildItem = LEAVE_LINKS.find((l) => l.group === 'manage')!;

// 645e67c4 — leave's own horizontal tab strip (components/leave-tabs.tsx) is retired in favour of this
// flyout, so the leave pack's Administration-group contribution went from a flat row (LEAVE_CONFIG_ROW,
// rung 6) to a NODE carrying the strip's eight destinations (packs/leave/index.ts, LEAVE_ADMIN_NAV).
// Placement is unchanged: same Admin group, same position between System Settings and Attendance, same
// reliance on the group's wholesale adminOnly gate. Mirrors PAYROLL_NODE below exactly.
const LEAVE_CONFIG_NODE: CollapsibleGroupItem = {
  collapsible: true,
  ...modulePackById('leave')!.navNodes!.find((n) => n.group === 'admin')!,
};

// Payroll nav node (1459e116): payroll's own horizontal tab strip (components/payroll-tabs.tsx) is
// retired in favour of this flyout, so the payroll pack's Administration-group contribution went from
// a single flat row (rung 7) to a NODE carrying the strip's six destinations
// (packs/payroll/index.ts, PAYROLL_ADMIN_NAV — including why there is no second level and which
// requested entries were left out). Placement is unchanged: same Admin group, same position between
// Claims config and Analytics, same reliance on the group's wholesale adminOnly gate.
const PAYROLL_NODE: CollapsibleGroupItem = {
  collapsible: true,
  ...modulePackById('payroll')!.navNodes!.find((n) => n.group === 'admin')!,
};

/**
 * Which module owns each nav row (ADR-0077 slice 4), built from the pack descriptors already resolved
 * above rather than a hand-written list — a second list would drift the first time a pack adds a row.
 *
 * Only SELLABLE modules appear. leave, employees, org, ess, approvals and knowledge_base are core:
 * a tenant cannot not-have them, so their rows are never candidates for hiding and are absent here.
 */
const MODULE_OF_HREF: ReadonlyMap<string, string> = new Map([
  ...ATTENDANCE_NODES.flatMap((n) => n.children.map((c) => [c.href, 'attendance'] as const)),
  // a324a4b3 rev3 — /roster and /attendance/import LEFT the nav nodes, so the flatMap above no longer
  // reaches them. Without this line both would fall out of MODULE_OF_HREF and stop being gated by the
  // attendance module's entitlement — a silent un-gating, which is exactly the class of mistake this
  // whole item's rev3 exists to avoid.
  ...(modulePackById('attendance')!.navLinks ?? []).map((l) => [l.href, 'attendance'] as const),
  ...CLAIMS_LINKS.map((l) => [l.href, 'claims'] as const),
  ...(modulePackById('payroll')!.navNodes ?? []).flatMap((n) => n.children.map((c) => [c.href, 'payroll'] as const)),
  ...(modulePackById('payroll')!.navLinks ?? []).map((l) => [l.href, 'payroll'] as const),
  ...(modulePackById('performance')!.navLinks ?? []).map((l) => [l.href, 'performance'] as const),
  // deec1691 — the ONE hand-written entry, and it has to be: `system_explorer` is a catalog module
  // with no pack (it owns no tables and contributes no service of its own), so there is no descriptor
  // to derive it from. The drift risk the comment above warns about is closed a different way here —
  // test/system-explorer.test.ts pins this href against the row in SYSTEM_SETTINGS_NODE and against
  // the route that exists on disk, so the three cannot part company silently.
  ['/admin/system-explorer', 'system_explorer'] as const,
]);

// Reports node (c440b365) — the single "Report" parent that centralises all reporting. Its six children
// map to the reporter's categories; each opens the Reports hub filtered to that category, where the
// predefined reports AND the custom report builder live. Admin-only (every report surface is admin-gated).
const REPORTS_NODE: CollapsibleGroupItem = {
  collapsible: true,
  labelKey: 'reports',
  icon: FileBarChart,
  children: [
    { href: '/reports?cat=master', labelKey: 'reportMaster', icon: Users, adminOnly: true },
    { href: '/reports?cat=attendance', labelKey: 'reportAttendance', icon: Clock, adminOnly: true },
    { href: '/reports?cat=leave', labelKey: 'reportLeave', icon: CalendarDays, adminOnly: true },
    { href: '/reports?cat=payroll', labelKey: 'reportPayroll', icon: Wallet, adminOnly: true },
    { href: '/reports?cat=claim', labelKey: 'reportClaim', icon: Receipt, adminOnly: true },
    { href: '/reports?cat=performance', labelKey: 'reportPerformance', icon: Target, adminOnly: true },
  ],
};

// System Settings node (a4e49748) — consolidates the three system-wide setup screens that used to sit
// as loose rows in the flat Administration list, under one parent (same machinery as the
// Attendance and Reports nodes). Nav-only: hrefs, icons and route guards are carried over verbatim.
// Future config screens (numbering rules, notification settings, email templates, …) slot in here
// when they are actually requested; none are built by a4e49748.
// Per-child adminOnly flags are REDUNDANT today (the admin group is gated adminOnly wholesale before
// per-child filtering runs); they are kept purely for consistency with REPORTS_NODE and are deliberately
// not asserted in test/sidebar-system-settings-group.test.ts so a future cleanup can drop them.
const SYSTEM_SETTINGS_NODE: CollapsibleGroupItem = {
  collapsible: true,
  labelKey: 'systemSettings',
  icon: Settings2,
  children: [
    // Employee ID Auto Running Number Setup (feedback 3d0031e6): configurable auto-numbered employee codes.
    { href: '/admin/settings/employee-id', labelKey: 'employeeIdConfig', icon: Hash, adminOnly: true },
    // HR-Admin Dashboard Card Master (feedback 1586d2f5): configurable employee-dashboard card catalog.
    { href: '/admin/settings/dashboard', labelKey: 'dashboardCardConfig', icon: LayoutDashboard, adminOnly: true },
    // fbdeee87: Profile Options was folded into the System Labels surface as a tab, so the two adjacent
    // admin entries collapse into this single "System Labels" entry (profile options now live at
    // /admin/settings/system-labels/profile-options).
    { href: '/admin/settings/system-labels', labelKey: 'systemLabels', icon: Tags, adminOnly: true },
    // 476f23ed: Movement Settings — the configurable catalogue of career event types (rename / switch off /
    // add your own). A system-wide setup screen like its three siblings, so it lands here rather than as a
    // loose row; the types it governs are recorded from Personnel > Employment History > New Event.
    { href: '/admin/settings/movement', labelKey: 'movementSettings', icon: ArrowLeftRight, adminOnly: true },
    // 7b5f18c3: Hiring Defaults — the per-company probation length and review-reminder cadence applied
    // when HR creates an employee. It was a button in the top-right corner of the Personnel list, which
    // is not where anyone looks for a system setup; this row is the OTHER HALF of its lib/permissions.ts
    // registration and neither ships without the other (a row whose route is unregistered is refused by
    // our own access check; a registered route with no row cannot be found).
    { href: '/admin/settings/hiring-defaults', labelKey: 'hiringDefaults', icon: UserRoundPlus, adminOnly: true },
    // 4509d2b8: Holidays. The row MOVED here from the Attendance settings node (packs/attendance/index.ts)
    // — nav placement only. Nothing about the screen changed: same URL (/admin/holidays, so bookmarks keep
    // working), same Holiday / Holiday Group tabs, same requireAdmin guard, same lib/permissions.ts
    // 'holidays' column with its four routes.
    //
    // WHY IT BELONGS HERE AND NOT UNDER ATTENDANCE. There has only ever been ONE holiday list, and
    // core/holidays.ts is SPINE: core/leave.ts, core/absence-days.ts, core/attendance.ts, core/payroll.ts
    // and core/leave-escalation.ts all read it through holidayDatesFor / effectiveHolidayState. Filing it
    // under Attendance made a company-wide setup screen read as an attendance-only one — and had a real
    // cost, not just a cosmetic one: `attendance` is billable (isCore:false in packs/catalog.ts) while
    // `leave` is core, so MODULE_OF_HREF hid the row entirely from a Leave-only tenant whose leave
    // calculations depend on holidays. Sitting here, owned by no sellable module, it shows for everyone.
    //
    // CalendarDays is already imported (REPORTS_NODE's Leave report uses it) and no sibling in THIS node
    // carries it, so the collapsed rail has no glyph collision.
    { href: '/admin/holidays', labelKey: 'holidays', icon: CalendarDays, adminOnly: true },
    // deec1691: System Analysis & Dependency Explorer. Alone among the rows of this node it is ALSO
    // entitlement-gated (MODULE_OF_HREF above): it is a sellable module that defaults OFF, so a tenant
    // that was not sold it never sees the row — and, unlike the role flags here, that hiding is backed
    // by a service that refuses (core/schema-explorer.ts). Every other row here, Holidays included
    // (4509d2b8), is deliberately ungated by module: they are company-wide setup that every tenant has.
    // Last in the node because it is a reference screen, not a setup step; the configuration screens
    // keep their ticket order above.
    { href: '/admin/system-explorer', labelKey: 'systemExplorer', icon: Share2, adminOnly: true },
  ],
};

const GROUPS: Group[] = [
  {
    items: [
      { href: '/', labelKey: 'dashboard', icon: LayoutDashboard },
      { href: '/me', labelKey: 'myWorkspace', icon: UserRound, tour: 'nav-me' },
      { href: '/org', labelKey: 'orgChart', icon: Network },
      // a7cbd895: "My Absence" — the first-level home for ALL leave self-service after the /me Leave
      // tab merged into /leave. Since ADR-0080 rung 6 the row lives on the leave pack and mounts here
      // by const reference (LEAVE_ABSENCE_ROW).
      LEAVE_ABSENCE_ROW,
      // a324a4b3 rev3: My Attendance carries the two self-service rows (Clock in/out, Records). The
      // Attendance CONFIG menu moved into Administration — see the admin group below.
      MY_ATTENDANCE_NODE,
      CLAIMS_ROW,
      { href: '/feedback', labelKey: 'feedback', icon: MessageSquareText },
      { href: '/knowledge-base', labelKey: 'knowledgeBase', icon: BookOpen, tour: 'nav-knowledge-base' },
      // ca2f2fef: standalone design-preview of the future mobile app (visible to all roles).
      { href: '/mobile-preview', labelKey: 'mobilePreview', icon: Smartphone },
    ],
  },
  {
    // 1b35f17b: Personnel relocated out of the top-level menu into Manage. The group used to be
    // gated whole-group (managerUp) — but Personnel is visible to EVERY employee, so gating is now
    // per-row (canSeeChild): all employees see "Manage → Personnel"; managers/admins additionally
    // see Approvals + Performance. Route guards are unchanged (scopedSession on /personnel).
    labelKey: 'manage',
    items: [
      { href: '/personnel', labelKey: 'people', icon: Users },
      LEAVE_TRACKER_ROW,
      { href: '/approvals', labelKey: 'approvals', icon: ListChecks, tour: 'nav-approvals', managerUp: true },
      PERFORMANCE_ROW,
      // a324a4b3 rev3: Roster + Import come back here as FLAT rows. rev2 put them inside the Attendance
      // node, which was safe while that node sat in the ungated group; it is not safe now the node has
      // moved into admin-gated Administration, because the group gate would hide them from every
      // non-admin manager. They mount by const reference from the attendance pack's navLinks.
      ...ATTENDANCE_MANAGE_ROWS,
    ],
  },
  {
    labelKey: 'admin',
    adminOnly: true,
    items: [
      { href: '/admin/organization', labelKey: 'organization', icon: Building2, tour: 'nav-admin' },
      { href: '/admin/personnel', labelKey: 'personnelAdmin', icon: Users },
      // a4e49748: the three system-wide setup rows (Employee ID numbering / Dashboard cards / System
      // Labels) collapsed into the single System Settings node above.
      SYSTEM_SETTINGS_NODE,
      // 0d147b78: Leave config absorbed the former "Approval chain" entry into its Approval Workflow
      // screen. Since ADR-0080 rung 6 it lives on the leave pack and mounts here by const reference;
      // since 645e67c4 it is a flyout NODE rather than a flat row (LEAVE_CONFIG_NODE), which is what
      // both that item and 491c499f's contest asked for.
      LEAVE_CONFIG_NODE,
      // a324a4b3 rev3 — THE REPORTER'S ACTUAL REQUEST: "just relocate the Attendance button below My
      // Attendance to admin section between Leave Config and Claim Config". Here it is, literally between
      // them. The six config screens are its children and each keeps its own adminOnly row flag, which is
      // now redundant behind this group's gate but is left alone — dropping it is a second change nobody
      // asked for. Every one of those pages calls requireAdmin()/scopedAdmin() for itself regardless
      // (test/attendance-menu-relocation.test.ts).
      ATTENDANCE_NODE,
      CLAIMS_CONFIG_ROW,
      // Since ADR-0080 rung 7 the payroll nav lives on the payroll pack and mounts here by const
      // reference (PAYROLL_NODE — a flyout node since 1459e116, a flat row before that).
      PAYROLL_NODE,
      // 6e122302 — Notice Board. A flat row rather than a node: it is one screen (its detail/new pages are
      // routes on the same screen), and requireAdmin on every page is the enforcement — this row and the
      // group's adminOnly flag are the courtesy. Deliberately NOT in MODULE_OF_HREF: the notice board is
      // not a sellable module, so there is no entitlement to gate it on.
      { href: '/admin/notice-board', labelKey: 'noticeBoard', icon: Megaphone },
      { href: '/analytics', labelKey: 'analytics', icon: BarChart3 },
      REPORTS_NODE,
      { href: '/admin/audit', labelKey: 'auditTrail', icon: ScrollText },
      // 0280 — read-only log of the four overnight sweeps. Uses the group's existing adminOnly gate
      // rather than a new groupAdminOnly flag: ChildItem, Group and the two filter expressions below are
      // separate, so such a flag would type-check here and still render for every admin. The page itself
      // redirects a non-group admin (and RLS returns zero rows), which is how the rest of the app gates.
      { href: '/admin/scheduled-actions', labelKey: 'scheduledActions', icon: Timer },
      { href: '/admin/privacy', labelKey: 'dataPrivacy', icon: Lock },
      { href: '/admin/ai', labelKey: 'aiConfig', icon: Sparkles },
      { href: '/admin/users', labelKey: 'securityPermission', icon: ShieldCheck },
    ],
  },
];

/** Detached rail that floats on the canvas. Collapses to an icon-only strip; expands
 *  to icon + label. The choice persists via the `rail_collapsed` cookie (read SSR-side
 *  in the layout, so there's no flash and no hydration mismatch). Modules with sub-items
 *  (fdc20776) open a flyout panel BESIDE the rail instead of expanding in place, so the
 *  rail keeps a constant height however many sub-items exist. */
export function Sidebar({
  isAdmin,
  canApprove = false,
  approvalCount = 0,
  enabledModules = null,
  defaultCollapsed,
}: {
  isAdmin: boolean;
  /** Manager-and-up: shows the Approvals inbox. */
  canApprove?: boolean;
  /**
   * ADR-0077 slice 4 — module codes whose rows may be shown. `null` means "no opinion, show
   * everything", which is NOT the same as `[]` ("show nothing"): a session whose entitlement snapshot
   * failed to resolve passes null on purpose, so an infrastructure blip degrades to the pre-slice-4
   * rail rather than emptying the menu of a paying customer. Hiding is cosmetic either way — every
   * page these rows point at refuses on its own (D3).
   */
  enabledModules?: string[] | null;
  /** Pending items awaiting THIS viewer's decision (feedback 836118c4) — badge on the
   *  "Approval Items" row. Computed once in app/layout.tsx as listPendingTasks(...).length; the rail
   *  never queries. 0 (or a viewer without the row) renders no badge. */
  approvalCount?: number;
  defaultCollapsed: boolean;
}) {
  const pathname = usePathname();
  // Query-aware active matching (fdc20776): usePathname excludes the query string, so the six
  // Reports children (/reports?cat=…) need the search params to light up. Safe without a Suspense
  // boundary here: the root layout awaits cookies()/headers(), so every route is dynamically
  // rendered (see node_modules/next/dist/docs — the boundary is only mandatory on static pages).
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const t = useTranslations('nav');
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // Single-open flyout state (fdc20776): the labelKey of the open module, or null. Clicking a
  // parent sets it (replacing any other open module); clicking the same parent again closes.
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Escape returns focus to the trigger that opened the panel.
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Safety net for back/forward navigation only — picking a sub-item closes via its onClick
  // (mandatory: the Reports children share one pathname and differ only in the query, so this
  // effect never fires when switching report categories).
  useEffect(() => {
    setOpenKey(null);
  }, [pathname]);
  /**
   * Is this row's owning module on the tenant's plan? (ADR-0077 slice 4.)
   *
   * `enabledModules === null` means the session could not resolve a snapshot, so the rail expresses no
   * opinion and shows everything — see lib/nav-entitlements.ts for why nav fails open where services
   * fail closed. A row belonging to no sellable module (core rows, hardcoded rows) is always shown.
   */
  const moduleAllows = (href: string) => {
    if (enabledModules === null) return true;
    const owner = MODULE_OF_HREF.get(href);
    return owner == null || enabledModules.includes(owner);
  };
  // Per-child visibility for flyout nodes (per-child gating vs. whole-group gating). Role gating and
  // module gating are ANDed: a row needs both the role AND the module to appear.
  const canSeeChild = (c: ChildItem) =>
    moduleAllows(c.href) && (c.adminOnly ? isAdmin : c.managerUp ? isAdmin || canApprove : true);
  const groups = GROUPS
    // Group-level flags still supported (the Admin group uses adminOnly).
    .filter((g) => (g.adminOnly ? isAdmin : g.managerUp ? isAdmin || canApprove : true))
    // 1b35f17b: filter per-row too, so a group (e.g. Manage) can mix all-employee rows
    // (Personnel) with manager-up rows (Approvals/Performance).
    .map((g) => ({
      ...g,
      items: g.items.filter((r) => (isCollapsible(r) ? r.children.some(canSeeChild) : canSeeChild(r))),
    }))
    // Drop a group that has become empty for this viewer (no stray divider in the collapsed rail).
    .filter((g) => g.items.length > 0);

  const isActive = (href: string) => isHrefActive(pathname, search, href);
  // 388e53c2 — flat rows go through isNavRowActive so a row can opt out of prefix matching or claim
  // paths outside its own href. Applied ONLY at the flat-row call site below: the flyout child ranking
  // and isParentActive are deliberately untouched, because changing them would move Payroll and
  // Attendance highlighting that nobody asked about.
  const isRowActive = (r: { href: string; exactHref?: boolean; ownedSubpaths?: string[] }) =>
    isNavRowActive(pathname, search, r);
  // The open module's node (permission-filtered children), resolved from the visible groups so a
  // stale openKey (e.g. after a role change) simply renders no panel.
  const openNode = openKey
    ? groups.flatMap((g) => g.items).find((r): r is CollapsibleGroupItem => isCollapsible(r) && r.labelKey === openKey) ?? null
    : null;
  const openChildren = openNode ? openNode.children.filter(canSeeChild) : [];
  // Inside a panel the LONGEST matching href wins, so exactly one row ever reads as the current page
  // (1459e116 requirement 3). isHrefActive matches a path prefix, which is what makes a parent row a
  // valid nav target at all — but it also means Payroll's "Payroll Process" (/payroll) matches while
  // the viewer is on /payroll/setup, lighting it up next to "Settings". Ranking by path length picks
  // the more specific row; the rail's own parent highlighting (isParentActive) is unaffected.
  const activeChildHref = openChildren
    .filter((c) => isActive(c.href))
    .sort((a, b) => b.href.split('?')[0].length - a.href.split('?')[0].length)[0]?.href;

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      document.cookie = `rail_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });

  const rowBase =
    'group flex items-center rounded-2xl transition duration-150 ease-snappy active:scale-[0.98]';

  return (
    // Wrapper (fdc20776): the aside is overflow-hidden, so the flyout panel cannot live inside it —
    // it anchors to this relative wrapper instead, which takes over the aside's responsive/flex-item
    // classes (a bare wrapper would stay a visible zero-width flex item below sm and add a phantom
    // layout gutter, and the aside's h-full needs the wrapper to have height). While a panel is open
    // the wrapper is raised to z-50 so the rail rows stay clickable above the z-40 backdrop (module
    // swap in one click); the raise is conditional so onboarding-tour stacking is unaffected otherwise.
    <div className={cn('relative hidden h-full shrink-0 sm:block', openNode && 'z-50')}>
      <aside
        className={cn(
          'flex h-full flex-col overflow-hidden rounded-[1.25rem] border border-border bg-sidebar py-4 shadow-[var(--shadow-card)] transition-[width] duration-200 ease-snappy',
          collapsed ? 'w-[66px] items-center px-3' : 'w-[232px] px-3',
          // Above the panel's backdrop, so every rail row stays clickable while a panel is open.
          openNode && 'relative z-50',
        )}
      >
        <Link
          href="/"
          aria-label={t('home')}
          className={cn(
            'flex items-center gap-2.5 rounded-2xl transition duration-150 ease-snappy active:scale-95',
            collapsed ? 'justify-center' : 'px-1 py-0.5',
          )}
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-[13px] font-bold text-primary-foreground shadow-[var(--shadow-sm)]">
            HR
          </span>
          {!collapsed && (
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight text-foreground">
              AI HR
            </span>
          )}
        </Link>

        {/* `relative` for the same reason as <main> in app/layout.tsx: absolute descendants
            (sr-only labels) must not escape this scroll container and create viewport overflow. */}
        <nav
          data-tour="nav"
          className="relative flex w-full flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden py-3"
        >
          {groups.map((group, gi) => (
            <div key={gi} className={cn('flex w-full flex-col gap-1', collapsed && 'items-center')}>
              {gi > 0 &&
                (collapsed ? (
                  <span className="my-1.5 h-px w-7 rounded-full bg-border" aria-hidden />
                ) : (
                  group.labelKey && (
                    <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                      {t(group.labelKey)}
                    </div>
                  )
                ))}
              {group.items.map((item) => {
                if (isCollapsible(item)) {
                  const children = item.children.filter(canSeeChild);
                  // Hide the whole parent if the viewer can see none of its children.
                  if (children.length === 0) return null;
                  return (
                    <NavFlyout
                      key={item.labelKey}
                      labelKey={item.labelKey}
                      icon={item.icon}
                      open={openKey === item.labelKey}
                      active={isParentActive(pathname, children.map((c) => c.href))}
                      collapsed={collapsed}
                      rowBase={rowBase}
                      panelId={`nav-flyout-${item.labelKey}`}
                      onToggle={() =>
                        setOpenKey((k) => (k === item.labelKey ? null : item.labelKey))
                      }
                      triggerRef={(el) => {
                        triggerRefs.current[item.labelKey] = el;
                      }}
                    />
                  );
                }
                const active = isRowActive(item);
                const Icon = item.icon;
                const label = t(item.labelKey);
                // Pending-approval badge (feedback 836118c4). Keyed on the href, like every other
                // row-specific behaviour in this file — no marker field on the Item type. The count
                // arrives pre-computed from the layout; a viewer without the row never reaches here.
                const showApprovalCount = item.href === '/approvals' && approvalCount > 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    data-tour={item.tour}
                    title={collapsed ? label : undefined}
                    // The badge itself is aria-hidden, so the count reaches screen readers here —
                    // otherwise the rail would announce "Approval Items" whether 0 or 12 are waiting.
                    aria-label={showApprovalCount ? `${label}, ${t('approvalsCount', { count: approvalCount })}` : label}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      rowBase,
                      collapsed ? 'size-11 justify-center' : 'w-full gap-3 px-3 py-2',
                      // Anchors the collapsed-rail badge bubble over the icon square.
                      showApprovalCount && 'relative',
                      active
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <Icon
                      className={cn('size-[20px] shrink-0', active && 'text-primary')}
                      strokeWidth={2}
                    />
                    {!collapsed && <span className="truncate text-sm">{label}</span>}
                    {showApprovalCount && (
                      <ApprovalCountBadge count={approvalCount} collapsed={collapsed} />
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? t('expand') : t('collapse')}
          title={collapsed ? t('expand') : t('collapse')}
          className={cn(
            rowBase,
            'mt-2 text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            collapsed ? 'size-11 justify-center' : 'w-full gap-3 px-3 py-2',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-[20px] shrink-0" strokeWidth={2} />
          ) : (
            <>
              <PanelLeftClose className="size-[20px] shrink-0" strokeWidth={2} />
              <span className="truncate text-sm">{t('collapse')}</span>
            </>
          )}
        </button>
      </aside>

      {openNode && (
        <NavFlyoutPanel
          labelKey={openNode.labelKey}
          items={openChildren as FlyoutChild[]}
          isActive={(href) => href === activeChildHref}
          rowBase={rowBase}
          panelId={`nav-flyout-${openNode.labelKey}`}
          onClose={() => setOpenKey(null)}
          onEscape={() => {
            setOpenKey(null);
            triggerRefs.current[openNode.labelKey]?.focus();
          }}
        />
      )}
    </div>
  );
}
