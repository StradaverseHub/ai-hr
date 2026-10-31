'use client';

import Link from './intent-link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useIsMonolith, useUiTheme } from './ui-theme-context';
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  CalendarDays,
  Clock,
  Command,
  FileBarChart,
  Hash,
  ClipboardCheck,
  FlaskConical,
  Gauge,
  TrendingUp,
  Sparkles,
  Wand2,
  LayoutDashboard,
  ListChecks,
  Mail,
  MessageSquareText,
  Megaphone,
  Network,
  Layers,
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
  UserRoundCog,
  UserRoundPlus,
  Users,
  Wallet,
  type LucideIcon,
  ChevronDown,
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
import {LETTER_NAV_ITEMS} from '@/lib/letter-navigation';
import { NAVIGATION_MODULES, NAVIGATION_SECTIONS, placeNavigation, navigationPlacement, navigationRouteOwner, type NavigationWorkspace } from '@/lib/navigation-workspaces';
import { usePublishNavIndex, type NavIndexEntry } from '@/components/nav-index-context';
import {SECURITY_CENTER,SECURITY_PAGES,isSecurityDestination,securityDestinationAllowed} from '@/lib/security-center-navigation';
import { openCommandBar } from '@/lib/command-bar-events';
import { V9_NAVIGATION, V9_SHARED_NAVIGATION, type V9NavigationPermissions } from '@/lib/lifecycle-v9-navigation';
import { NavigationSubmenus } from '@/components/navigation-submenus';

// `labelKey` indexes the `nav` message namespace; labels are resolved at render via useTranslations.
// `tour` (optional) marks the element as an onboarding-tour anchor (ADR-0018).
type Item = { navigationHref?: string; href: string; labelKey: string; icon: LucideIcon; tour?: string };
// A flyout parent node (b3dc0f78, flyout redesign fdc20776): one level of nesting only. Each child
// carries its own visibility flag so filtering is per-child (vs. whole-group gating).
type ChildItem = Item & {
  submenuKey?: string;
  adminOnly?: boolean;
  identityEmailOnly?: boolean;
  loginPresentationOnly?: boolean;
  managerUp?: boolean;
  // 388e53c2 — highlighting only, never a gate. See NavChildDescriptor in packs/registry.ts.
  exactHref?: boolean;
  ownedSubpaths?: string[];
  // A destination the viewer holds but may not open yet (the locked Development plan): rendered as a
  // non-link and never the owner of the current route or a command-bar entry.
  disabled?: boolean;
};
type CollapsibleGroupItem = {
  tour?: string;
  activeMatch?: 'children';
  defaultHref?: string;
  collapsible: true;
  labelKey: string;
  icon: LucideIcon;
  children: ChildItem[];
};
type Row = ChildItem | CollapsibleGroupItem;
const isCollapsible = (r: Row): r is CollapsibleGroupItem => 'collapsible' in r && r.collapsible;
// Control Tower pages and Administration › AI (which forwards into them) all run requireAdmin; a payroll or
// performance partner shares the administration rail but is redirected away from these.
// Provider setup is tenant-wide: its page reads the configuration only for a group-wide administrator.
const AI_PROVIDER_HREF = '/control-tower/agents/provider';
const isAiAdministrationHref = (href: string) => href === '/admin/ai' || href === '/control-tower' || href.startsWith('/control-tower/');
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

// Lifecycle nav rows (ADR-0095): onboarding / offboarding / IT requisitions / assets. Two flat rows like
// Claims: the hub in the top group (every employee — requesting equipment and a new hire's own checklist
// are self-service; the staff screens redirect a requester back to the hub), and Module Config in the
// Administration group (gated adminOnly wholesale by the group).
const LIFECYCLE_LINKS = modulePackById('lifecycle')!.navLinks!;
const LIFECYCLE_ROW: ChildItem = LIFECYCLE_LINKS.find((l) => l.group === 'main')!;
const LIFECYCLE_CONFIG_ROW: ChildItem = LIFECYCLE_LINKS.find((l) => l.group === 'admin')!;
const ONBOARDING_NODE:CollapsibleGroupItem={...modulePackById('lifecycle')!.navNodes![0]!,collapsible:true};
const ONBOARDING_REQUISITIONS_NODE:CollapsibleGroupItem={collapsible:true,labelKey:'onboardingRequisitions',icon:ONBOARDING_NODE.icon,defaultHref:'/lifecycle/requisitions/onboarding',children:[{...LIFECYCLE_LINKS.find(l=>l.href==='/lifecycle/requisitions/onboarding')!,labelKey:'allOnboardingRequisitions',exactHref:true,ownedSubpaths:['/lifecycle/requisitions/onboarding']}]};

// Performance nav rows (ADR-0080 rung 4; D-P1-32 PT-X5, APR-025 D4): EXACTLY TWO entries the performance pack
// contributes (packs/performance/index.ts, PERFORMANCE_NAV_LINKS — provenance comments moved with them).
// Performance & Talent (every employee with the module; the area's tabs sit below it) and Performance admin
// (canAdministerOnehr only, pointed at the admin area's first tab for the latest cycle by `performanceAdminHref`).
// The former My Performance, Performance, Calibration, Talent and Development rows retired into the area's tabs.
const REVIEW_WORKSPACE_PATH = '/performance/workspace';
const PERFORMANCE_TALENT_ROW: ChildItem = modulePackById('performance')!.navLinks!.find((l) => l.group === 'main' && l.labelKey === 'performanceTalent')!;
const PERFORMANCE_ADMIN_ROW: ChildItem = modulePackById('performance')!.navLinks!.find((l) => l.group === 'manage' && l.labelKey === 'performanceAdmin')!;

// Leave nav rows (ADR-0080 rung 6): two flat rows the leave pack contributes (packs/leave/index.ts,
// LEAVE_NAV_LINKS — provenance comments moved with them), placed at their pre-rung-6 positions below:
// the "My Absence" row (/leave) in the top group (every employee), the "Leave configuration" row
// (/admin/leave) in the Administration group (group-gated adminOnly, no per-row flag — unchanged).
// The `group` tag is the pack's placement declaration; position WITHIN the group stays this file's
// concern.
const LEAVE_LINKS = modulePackById('leave')!.navLinks!;
const LEAVE_ABSENCE_ROW: CollapsibleGroupItem = {collapsible:true, ...modulePackById('leave')!.navNodes!.find((n) => n.group === 'main')!};
// a00c4f64 — "Team Leave Tracker", the Leave Calendar's own screen after it left the Dashboard. It goes
// in the Manage group (the reporter asked for it there) and carries NO gate, which is the point: the
// group gates per row, and every employee could see this calendar before the move.
const LEAVE_TRACKER_ROW: ChildItem = LEAVE_LINKS.find((l) => l.labelKey === 'teamLeaveTracker')!;
// A pack may contribute more than one Manage destination; selecting only the first hid My Team.
const MY_TEAM_ROW: ChildItem = LEAVE_LINKS.find((l) => l.labelKey === 'myTeam')!;

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
  ['/admin/settings/notifications','notifications'] as const,
  ...(modulePackById('rewards')!.navLinks ?? []).map((l) => [l.href, 'rewards'] as const),
  ...ATTENDANCE_NODES.flatMap((n) => n.children.map((c) => [c.href, 'attendance'] as const)),
  // a324a4b3 rev3 — /roster and /attendance/import LEFT the nav nodes, so the flatMap above no longer
  // reaches them. Without this line both would fall out of MODULE_OF_HREF and stop being gated by the
  // attendance module's entitlement — a silent un-gating, which is exactly the class of mistake this
  // whole item's rev3 exists to avoid.
  ...(modulePackById('attendance')!.navLinks ?? []).map((l) => [l.href, 'attendance'] as const),
  ...CLAIMS_LINKS.map((l) => [l.href, 'claims'] as const),
  ...LIFECYCLE_LINKS.map((l) => [l.href, 'lifecycle'] as const),
  ...ONBOARDING_NODE.children.map(l=>[l.href,'lifecycle'] as const),
  ...(modulePackById('payroll')!.navNodes ?? []).flatMap((n) => n.children.map((c) => [c.href, 'payroll'] as const)),
  // ADR-0104: Overview and the explainer serve core HR readiness, including tenants without payroll.
  // r235 — payroll-gated for a sharper reason than the two above: the ONLY action type closes payroll
  // exceptions, so without payroll this row is a permanently empty screen. It stops being payroll's when
  // an action type lands whose subject is not a payroll finding.
  ['/control-tower/actions', 'payroll'] as const,
  ['/control-tower/exceptions', 'payroll'] as const,
  // NOT payroll-gated: record completeness is not a payroll question (see CONTROL_DOMAINS). Absent from
  // this map entirely, which is how a row says "always offered".
  ...(modulePackById('payroll')!.navLinks ?? []).map((l) => [l.href, 'payroll'] as const),
  ...(modulePackById('performance')!.navLinks ?? []).map((l) => [l.href, 'performance'] as const),
  // deec1691 — the ONE hand-written entry, and it has to be: `system_explorer` is a catalog module
  // with no pack (it owns no tables and contributes no service of its own), so there is no descriptor
  // to derive it from. The drift risk the comment above warns about is closed a different way here —
  // test/system-explorer.test.ts pins this href against the row in SYSTEM_SETTINGS_NODE and against
  // the route that exists on disk, so the three cannot part company silently.
  ['/admin/system-explorer', 'system_explorer'] as const,
  // e6be5a3b (r330) — System Testing. A hand-written entry for the same reason as the one above: it is a
  // catalog module with `packBacked: false`, so there is no pack descriptor to derive the href from,
  // even though (unlike the explorer) it DOES own tables. The child routes — /new and /[id] — are not
  // listed and do not need to be: MODULE_OF_HREF decides which NAV ROWS the rail offers, and the rail
  // has one row. The routes themselves are gated in-page by requireModule + the service's own refusal.
  // test/system-testing.test.ts pins this href against the row in SYSTEM_SETTINGS_NODE and the route on
  // disk, so the three cannot part company silently.
  ['/admin/system-testing', 'system_testing'] as const,
  ['/system-testing', 'system_testing'] as const,
  ['/me/payslip', 'payroll'] as const,
  ['/me/letters', 'employees'] as const,
  ...LETTER_NAV_ITEMS.map(item=>[item.href,'employees'] as const),
  ['/me/tax-relief', 'payroll'] as const,
  ['/me/ea', 'payroll'] as const,
  ['/me/tp3', 'payroll'] as const,
  ['/admin/claims/reimbursements', 'claims'] as const,
  ['/admin/work-locations', 'attendance'] as const,
  // ADR-0082 — `assistant` is the SECOND hand-written entry and for the same reason as the first: it is
  // a catalog module with `packBacked: false`, so there is no pack descriptor to derive the href from.
  // Without this line the row would advertise a module the tenant has not bought. The per-user
  // assistant_grant is a separate, second gate — this one only decides whether the row is offered.
  ['/assistant', 'assistant'] as const,
  // 3fb1a611 (r299) — Leave Config › Leave Credit is the paid `toil` add-on living inside the CORE leave pack's
  // node. Leave is core and absent from this map, and there is no toil pack, so no whole-pack flatMap can
  // reach it: the one child is picked out of the leave pack's node BY ITS LABEL KEY and mapped to `toil`.
  // Resolved from the descriptor rather than written as an href, so the address has one spelling (the pack's)
  // — test/leave-pack.test.ts refuses a leave href hardcoded here. Without this line the row would advertise
  // a module the tenant has not bought. test/r299-leave-credit-screens.test.ts pins the pair (this entry and
  // `toil` in lib/nav-entitlements.ts MODULE_CODES_WITH_NAV).
  // r389 (bc3e203d) — and My Leave › Leave Credit History, the employee's own Leave Credit requests: the same
  // paid add-on, picked out of the leave pack's self-service node the same way (by label key, so its address
  // keeps the pack's one spelling). Without it a tenant that has not bought Leave Credit would be offered a
  // row whose page only explains that the feature is off.
  ...(modulePackById('leave')!.navNodes ?? []).flatMap((n) =>
    n.children.filter((c) => c.labelKey === 'leaveCredit' || c.labelKey === 'leaveCreditHistory' || c.labelKey === 'leaveCreditDetails').map((c) => [c.href, 'toil'] as const),
  ),
]);

// Reports node (c440b365) — the single "Report" parent that centralises all reporting. Its six children
// map to the reporter's categories; each opens the Reports hub filtered to that category, where the
// predefined reports AND the custom report builder live. Admin-only (every report surface is admin-gated).
// AI management (28 Oct 2026, owner): one place to manage AI, each section its own page under
// /control-tower/agents. A sub-menu in the Control Tower group rather than a tab row inside the page.
// Overview is exact so it is not also current on the other sections. Spending opens only where a spend
// policy exists; elsewhere its page returns to the Overview.
const AI_MANAGEMENT_NODE: CollapsibleGroupItem = {
  collapsible: true,
  labelKey: 'aiManagement',
  icon: Sparkles,
  activeMatch: 'children',
  defaultHref: '/control-tower/agents',
  children: [
    // WP12 (R8): the one AI inventory comes first.
    { href: '/control-tower/agents/inventory', labelKey: 'aiManagementInventory', icon: Layers, adminOnly: true },
    { href: '/control-tower/agents', labelKey: 'aiManagementOverview', icon: Gauge, adminOnly: true, exactHref: true },
    { href: '/control-tower/agents/provider', labelKey: 'aiManagementProvider', icon: Settings2, adminOnly: true },
    { href: '/control-tower/agents/assistant', labelKey: 'aiManagementAssistant', icon: MessageSquareText, adminOnly: true },
    { href: '/control-tower/agents/features', labelKey: 'aiManagementFeatures', icon: ListChecks, adminOnly: true },
    { href: '/control-tower/agents/allowances', labelKey: 'aiManagementAllowances', icon: Users, adminOnly: true },
    { href: '/control-tower/agents/spending', labelKey: 'aiManagementSpending', icon: Wallet, adminOnly: true },
    { href: '/control-tower/agents/orchestrator', labelKey: 'aiManagementOrchestrator', icon: Network, adminOnly: true },
    { href: '/control-tower/agents/runs', labelKey: 'aiManagementRuns', icon: ScrollText, adminOnly: true },
  ],
};
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
// Per-child adminOnly flags keep the other settings hidden from an enrolled installation email
// operator without an HR role. That operator reaches only Email delivery in this node.
const SYSTEM_SETTINGS_NODE: CollapsibleGroupItem = {
  collapsible: true,
  labelKey: 'systemSettings',
  icon: Settings2,
  children: [
    // Employee ID Auto Running Number Setup (feedback 3d0031e6): configurable auto-numbered employee codes.
    { href: '/admin/settings/employee-id', labelKey: 'employeeIdConfig', icon: Hash, adminOnly: true },
    { href: '/admin/settings/people-general', labelKey: 'peopleGeneral', icon: Settings2, adminOnly: true },
    // HR-Admin Dashboard Card Master (feedback 1586d2f5): configurable employee-dashboard card catalog.
    { href: '/admin/settings/dashboard', labelKey: 'dashboardCardConfig', icon: LayoutDashboard, adminOnly: true },
    // fbdeee87: Profile Options was folded into the System Labels surface as a tab, so the two adjacent
    // admin entries collapse into this single "System Labels" entry (profile options now live at
    // /admin/settings/system-labels/profile-options).
    { href: '/admin/settings/system-labels', labelKey: 'systemLabels', icon: Tags, adminOnly: true },
    { href: '/admin/system-settings/approval-delegation', labelKey: 'delegations', icon: ArrowLeftRight, adminOnly: true },
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
    // r261 (board item 9583deac, stage three): Employee Change Requests — the two settings that decide
    // which fields of their own record an employee may ask to change, and who signs one off. It belongs
    // in System Settings for the same reason Hiring Defaults does: it is company-wide setup an
    // administrator configures once, not a daily HR task, and there is nowhere on the Personnel record or
    // on /approvals where a reader would look for a policy about every employee at once. This row is the
    // OTHER HALF of its lib/permissions.ts registration and neither ships without the other.
    //
    // Placed after Holidays and before System Analysis, which stays last (it is a reference screen, not a
    // setup step). UserRoundCog is unused elsewhere in this node, so the collapsed rail has no glyph
    // collision with UserRoundPlus (Hiring Defaults).
    { href: '/admin/settings/profile-requests', labelKey: 'profileRequestSettings', icon: UserRoundCog, adminOnly: true },
    // Admins can inspect SMTP setup; only an enrolled installation identity can change it.
    { href: '/admin/settings/login', labelKey: 'loginPresentation', icon: Settings2, adminOnly: true, loginPresentationOnly: true },
    { href: '/admin/settings/email', labelKey: 'identityEmail', icon: Mail, identityEmailOnly: true },
    { href: '/admin/settings/email-templates', labelKey: 'emailTemplates', icon: Mail, adminOnly: true },
    // 3f44a539 / 4a8a4fff — existing destinations, relocated from the flat Administration menu.
    // Explicit child admin gates preserve their previous group-level audience: the installation email
    // operator can open this node, but may still see only the identityEmailOnly child above.
    { href: '/admin/settings/notifications', labelKey: 'workflowEmail', icon: Bell, adminOnly: true },
    // 0280 — the page still enforces group-admin access (and its RLS) independently of the menu.
    { href: '/admin/scheduled-actions', labelKey: 'scheduledActions', icon: Timer, adminOnly: true },
    { href: '/admin/privacy', labelKey: 'dataPrivacy', icon: Lock, adminOnly: true },
    // deec1691: System Analysis & Dependency Explorer. This reference row is ALSO
    // entitlement-gated (MODULE_OF_HREF above): it is a sellable module that defaults OFF, so a tenant
    // that was not sold it never sees the row — and, unlike the role flags here, that hiding is backed
    // by a service that refuses (core/schema-explorer.ts). Workflow Email Notifications also keeps its
    // existing notification-module gate; Holidays and the remaining company-wide setup rows are ungated.
    // Last in the node because it is a reference screen, not a setup step; the configuration screens
    // keep their ticket order above.
    { href: '/admin/system-explorer', labelKey: 'systemExplorer', icon: Share2, adminOnly: true },
    // e6be5a3b (r330): System Testing. The SECOND row of this node that is entitlement-gated as well as
    // role-gated (MODULE_OF_HREF above) — a sellable module that defaults OFF, so a tenant that was not
    // sold it never sees the row, and that hiding is backed by a service which refuses by name
    // (core/system-testing.ts). Last in the node, after System Analysis: both are vendor-facing
    // reference/quality surfaces rather than setup steps, and the configuration screens keep their
    // ticket order above. FlaskConical is unused elsewhere in the rail, so the collapsed view has no
    // glyph collision.
    { href: '/admin/system-testing', labelKey: 'systemTesting', icon: FlaskConical, adminOnly: true },
  ],
};

// Historical audience inventory: its group/row flags are visibility constraints, not render placement.
// Ops/Strata placement is owned exclusively by lib/navigation-workspaces.ts.
const GROUPS: Group[] = [
  {
    // a6-audit — LABELLED so it can COLLAPSE. It was the one unnamed group, which meant it was always
    // open; at ten rows that alone is half the rail's height and no amount of collapsing the other three
    // could make the menu fit.
    labelKey: 'sectionHome',
    items: [
      { href: '/', labelKey: 'dashboard', icon: LayoutDashboard },
      { href: '/me', labelKey: 'myWorkspace', icon: UserRound, tour: 'nav-me' },
      { href: '/system-testing', labelKey: 'mySystemTesting', icon: FlaskConical },
      { href: '/org', labelKey: 'orgChart', icon: Network },
      // a7cbd895: "My Absence" — the first-level home for ALL leave self-service after the /me Leave
      // tab merged into /leave. Since ADR-0080 rung 6 the row lives on the leave pack and mounts here
      // by const reference (LEAVE_ABSENCE_ROW).
      LEAVE_ABSENCE_ROW,
      // a324a4b3 rev3: My Attendance carries the two self-service rows (Clock in/out, Records). The
      // Attendance CONFIG menu moved into Administration — see the admin group below.
      MY_ATTENDANCE_NODE,
      PERFORMANCE_TALENT_ROW,
      CLAIMS_ROW,
      LIFECYCLE_ROW,
      { href: '/feedback', labelKey: 'feedback', icon: MessageSquareText },
      // ADR-0082 slice 4 — sits beside Knowledge Base because they answer the same shape of question,
      // one from documents and one from the employee's own records. Module-gated via MODULE_OF_HREF
      // above; a user without a grant sees the row and is told who to ask, which is a better dead end
      // than a row that vanishes with no explanation.
      { href: '/assistant', labelKey: 'assistant', icon: Sparkles },
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
      { href: '/tasks', labelKey: 'myTasks', icon: ListChecks },
      { href: '/admin/personnel', labelKey: 'personnelAdmin', icon: Users, adminOnly: true },
      { href: '/admin/job-descriptions', labelKey: 'jobDescriptions', icon: BookOpen, adminOnly: true },
      ONBOARDING_NODE,
      ONBOARDING_REQUISITIONS_NODE,
      ...LIFECYCLE_LINKS.filter(link=>link.group==='manage'&&link.href!=='/lifecycle/requisitions/onboarding'),
      { href: '/personnel', labelKey: 'people', icon: Users },
      LEAVE_TRACKER_ROW,
      MY_TEAM_ROW,
      { href: '/approvals', labelKey: 'approvals', icon: ListChecks, tour: 'nav-approvals', managerUp: true },
      PERFORMANCE_ADMIN_ROW,
      ...modulePackById('rewards')!.navLinks!.filter(l => l.group === 'manage'),
      // a324a4b3 rev3: Roster + Import come back here as FLAT rows. rev2 put them inside the Attendance
      // node, which was safe while that node sat in the ungated group; it is not safe now the node has
      // moved into admin-gated Administration, because the group gate would hide them from every
      // non-admin manager. They mount by const reference from the attendance pack's navLinks.
      ...ATTENDANCE_MANAGE_ROWS,
    ],
  },
  {
    // ADR-0083 r233 — the Control Tower promoted OUT of the Payroll menu into its own section. It was a
    // payroll row while payroll was the only domain it watched; it is a control plane for operational HR
    // of which payroll is the FIRST adapter and not the subject (§2.2), and leaving it under Payroll
    // taught every reader the opposite. Its own group rather than a node inside Administration because
    // burying a control plane under "Administration" is how it came to look like a payroll feature.
    // `adminOnly` mirrors the route guard (requireAdmin on both pages), not a preference.
    labelKey: 'aiControlTower',
    adminOnly: true,
    items: [
      { href: '/control-tower', labelKey: 'controlTowerOverview', icon: Gauge, adminOnly: true, exactHref: true },
      // The explainer is a first-class row rather than a link buried on the overview: "what is switched
      // on, and which parts involve a model" is the question an admin asks BEFORE trusting the queue, so
      // it must be reachable without first reading the thing it explains.
      // ADR-0083 §3 item 2 — the shift-left half. Sits ABOVE the explainer because it is a working screen
      // and the explainer is a reference one.
      { href: '/control-tower/readiness', labelKey: 'controlTowerReadiness', icon: ClipboardCheck, adminOnly: true },
      // ADR-0074 r245 — the cross-run payroll exceptions queue; payroll-gated through MODULE_OF_HREF.
      { href: '/control-tower/exceptions', labelKey: 'controlTowerExceptions', icon: Receipt, adminOnly: true },
      // ADR-0083 §2.5 — the approval queue. The only screen in the product where a person authorises an
      // agent to write, which is why it is a row of its own rather than a panel on another page.
      { href: '/control-tower/actions', labelKey: 'controlTowerActions', icon: Wand2, adminOnly: true },
      // 28 Oct 2026 (owner) — this group IS the Control Tower menu; the in-page tab rows were retired, so the
      // payroll exceptions queue and AI management live here too, in the same order the tabs used.
      AI_MANAGEMENT_NODE,
      // ADR-0131 Phase 1 — where agents could take work off HR, measured from the records. A working
      // screen, so it sits above the reference explainer.
      { href: '/control-tower/opportunities', labelKey: 'controlTowerOpportunities', icon: TrendingUp, adminOnly: true },
      { href: '/control-tower/how-it-works', labelKey: 'controlTowerHow', icon: BookOpen, adminOnly: true },
    ],
  },
  {
    labelKey: 'admin',
    adminOnly: true,
    items: [
      { href: '/admin/organization', labelKey: 'organization', icon: Building2, tour: 'nav-admin' },
      /**
       * 639bf4a5 rev 2 (r338) — THE PHYSICAL WORK LOCATION ROW STOOD HERE and is DELIBERATELY GONE.
       *
       * r336 moved it in from the attendance pack's settings node and renamed it; it shipped, and the
       * reporter contested it. They asked for the screen back under ATTENDANCE, renamed "Locations",
       * with a company-based listing and dedicated Add / View / Edit screens. That is their decision and
       * it is approved, so the row is a child of ATTENDANCE_NAV again (packs/attendance/index.ts,
       * labelKey `locations`). The line is DESCRIBED, never quoted: four exact-set guards grep this file
       * for that literal, and a commented-out row is still a row somebody uncomments.
       *
       * ⚠️ WHAT DID NOT MOVE WITH IT. The ROUTE is still `/admin/work-locations` — the reporter asked to
       * rename the FUNCTION, not the address, and moving it a second time in two days would churn every
       * bookmark again and need the three `/admin/locations` redirect stubs re-pointed for nothing. Nor
       * did `screenKey: 'locations'` (lib/permissions.ts), which is a permission identity stored role
       * configs may name.
       *
       * ⚠️ AND IT IS MODULE-GATED AGAIN, KNOWINGLY. MODULE_OF_HREF above is built by flatMap over the
       * attendance pack's nav children and `attendance` is BILLABLE, so the row's return re-gates this
       * register behind the attendance entitlement — the 4509d2b8 Holidays argument, in reverse. The
       * tenant HAS attendance, so nothing changes for them today; a future Leave-only customer would have
       * no route to the work-site register or its branch mapping. The plan said so and offered to keep it
       * un-gated; the reporter did not answer, so their structure is built as they described it and the
       * un-gating stays a one-line change. See app/(app)/admin/work-locations/page.tsx.
       *
       * MapPin left this file with the row — no sibling here used it, and the pack's own node is where it
       * is drawn now.
       */

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
      LIFECYCLE_CONFIG_ROW,
      ...LIFECYCLE_LINKS.filter(link=>link.group==='admin'&&link.href!==LIFECYCLE_CONFIG_ROW.href),
      // Since ADR-0080 rung 7 the payroll nav lives on the payroll pack and mounts here by const
      // reference (PAYROLL_NODE — a flyout node since 1459e116, a flat row before that).
      PAYROLL_NODE,
      ...modulePackById('rewards')!.navLinks!.filter(l => l.group === 'admin'),
      // 6e122302 — Notice Board. A flat row rather than a node: it is one screen (its detail/new pages are
      // routes on the same screen), and requireAdmin on every page is the enforcement — this row and the
      // group's adminOnly flag are the courtesy. Deliberately NOT in MODULE_OF_HREF: the notice board is
      // not a sellable module, so there is no entitlement to gate it on.
      { href: '/admin/notice-board', labelKey: 'noticeBoard', icon: Megaphone },
      { href: '/analytics', labelKey: 'analytics', icon: BarChart3 },
      REPORTS_NODE,
      { href: '/admin/audit', labelKey: 'auditTrail', icon: ScrollText },
      {href:SECURITY_CENTER,labelKey:'securityCenter',icon:ShieldCheck,exactHref:true},
      ...SECURITY_PAGES.map(page=>({href:page.href,labelKey:page.navKey,icon:ShieldCheck,exactHref:true})),
    ],
  },
];

/** Source contract for inventory/visibility regressions; rendering always places authorized rows. */
export const SIDEBAR_AUDIENCE_INVENTORY: readonly Group[] = GROUPS;

/** Detached rail that floats on the canvas. Collapses to an icon-only strip; expands
 *  to icon + label. The choice persists via the `rail_collapsed` cookie (read SSR-side
 *  in the layout, so there's no flash and no hydration mismatch). Modules with sub-items
 *  (fdc20776) open a flyout panel BESIDE the rail instead of expanding in place, so the
 *  rail keeps a constant height however many sub-items exist. */
export function Sidebar({
  isAdmin,
  canConfigureIdentityEmail = false,
  canConfigureLoginPresentation = false,
  canPreviewIdentityEmail = false,
  canApprove = false,
  hasAssignedAttendanceApproval = false,
  hasAssignedApproval = false,
  canReviewProfileChanges = false,
  canAdministerAi = false,
  canAdministerSecurity = false,
  canConfigureAccess = false,
  canProvisionUsers = false,
  canConfigureAiProvider = false,
  canAccessTeam = false,
  letterDestinations = [],
  canAdministerOnehr = false,
  performanceAdminHref,
  approvalCount = 0,
  taskCount = 0,
  onboardingAccess = false,
  onboardingV9Access = false,
  onboardingV9Navigation,
  onboardingMaster = false,
  onboardingRequisitionsAccess = false,
  onboardingJoinerCount,
  onboardingChecklistCount,
  enabledModules = null,
  assistantAccess = true,
  feedbackAccess = true,
  defaultCollapsed,
  viewerName = null,
  viewerCode = null,
}: {
  isAdmin: boolean;
  canAdministerSecurity?: boolean;
  canConfigureAccess?: boolean;
  canProvisionUsers?: boolean;
  canConfigureIdentityEmail?: boolean;
  canConfigureLoginPresentation?: boolean;
  /** Actual HR administrator access, independent of the broader partner administration rail. */
  canPreviewIdentityEmail?: boolean;
  /** Manager-and-up: shows the Approvals inbox. */
  canApprove?: boolean;
  /** A pending request-bound assignment exposes only the inbox, never manager navigation. */
  hasAssignedAttendanceApproval?: boolean;
  /** Actual canonical inbox assignment. Exposes this destination, never manager navigation. */
  hasAssignedApproval?: boolean;
  /** Actual HR administration, independent of the broader partner administration rail. */
  canReviewProfileChanges?: boolean;
  /** Actual HR administration: the Control Tower and AI configuration run requireAdmin, so the
   * broader partner administration rail must not list them. */
  canAdministerAi?: boolean;
  /** Group-wide administration: a company administrator is sent from Provider back to the AI Overview. */
  canConfigureAiProvider?: boolean;
  /** Actual My Team role authority, independent of the broader partner administration rail. */
  canAccessTeam?: boolean;
  letterDestinations?: readonly string[];
  /**
   * ADR-0142 — OneHR performance administration (admins, perf-comp partners, OneHR performance partners).
   * The ONLY gate of the Performance admin entry (D-P1-32 PT-X5); it never opens the admin rail, approvals or My Team.
   */
  canAdministerOnehr?: boolean;
  /**
   * D-P1-32 PT-X5 — where Performance admin opens: the admin area's first tab for the latest cycle the viewer
   * administers (app/(app)/layout.tsx). Absent means the pack's own address, /performance (no cycle yet).
   */
  performanceAdminHref?: string;
  /**
   * ADR-0077 slice 4 — module codes whose rows may be shown. `null` means "no opinion, show
   * everything", which is NOT the same as `[]` ("show nothing"): a session whose entitlement snapshot
   * failed to resolve passes null on purpose, so an infrastructure blip degrades to the pre-slice-4
   * rail rather than emptying the menu of a paying customer. Hiding is cosmetic either way — every
   * page these rows point at refuses on its own (D3).
   */
  enabledModules?: string[] | null;
  /** 28 Oct 2026 (owner): the Assistant row is offered only to a login that may use the Assistant (module,
   * grant). app/(app)/layout.tsx computes it and passes false on any failure. Own-data controls stay reachable from
   * My workspace, and /assistant itself still refuses and explains on its own. */
  assistantAccess?: boolean;
  /** 0696 — false when an operator has hidden the Feedback menu for this customer. /feedback refuses on its own. */
  feedbackAccess?: boolean;
  /** Pending items awaiting THIS viewer's decision (feedback 836118c4) — badge on the
   *  "Approval Items" row. Computed once in app/(app)/layout.tsx as listPendingTasks(...).length; the rail
   *  never queries. 0 (or a viewer without the row) renders no badge. */
  approvalCount?: number;
  taskCount?: number;
  onboardingAccess?: boolean;
  onboardingV9Access?: boolean;
  onboardingV9Navigation?: V9NavigationPermissions;
  onboardingMaster?: boolean;
  onboardingRequisitionsAccess?: boolean;
  onboardingJoinerCount?:number;
  onboardingChecklistCount?:number;
  defaultCollapsed: boolean;
  /** r398 — the Monolith rail's user line (README §3). Display only; Classic does not render it. */
  viewerName?: string | null;
  viewerCode?: string | null;
}) {
  const pathname = usePathname();
  // Query-aware active matching (fdc20776): usePathname excludes the query string, so the six
  // Reports children (/reports?cat=…) need the search params to light up. Safe without a Suspense
  // boundary here: the root layout awaits cookies()/headers(), so every route is dynamically
  // rendered (see node_modules/next/dist/docs — the boundary is only mandatory on static pages).
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const t = useTranslations('nav');
  const tWorkspace = useTranslations('onehr.workspace');
  // `common`, NOT `nav`: the brand name lives at common.appName. Reading it off `t` would resolve
  // nav.appName, which does not exist — and a MISSING_MESSAGE passes tsc, the suite and `next build`
  // alike, so nothing would have told us until the screen rendered.
  const tCommon = useTranslations('common');
  const [collapsedPref, setCollapsed] = useState(defaultCollapsed);
  // r398 — Monolith's rail is always open on desktop (README §3: "the boards assume the rail is always open
  // on desktop"), so it offers no collapse and ignores the preference. Classic reads it exactly as before;
  // the `rail_collapsed` cookie is neither read differently nor written by Monolith.
  const monolith = useIsMonolith();
  const [workspaceChoice, setWorkspaceChoice] = useState<NavigationWorkspace | null>(null);
  const atelier = useUiTheme() === 'atelier';
  const tBar = useTranslations('commandBar');
  const locale = useLocale();
  // r398 — Monolith shows a module's children INLINE (no flyout panel). An explicit open/close per module
  // overrides "open while you are inside it"; the default is the active module open, every other closed.
  const [railKids, setRailKids] = useState<Readonly<Record<string, boolean>>>({});
  // Single-open flyout state (fdc20776): the labelKey of the open module, or null. Clicking a
  // parent sets it (replacing any other open module); clicking the same parent again closes.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const mobileNavigationTrigger = useRef<HTMLButtonElement | null>(null);
  // D-P1-28 — Classic's phone drawer shows the rail with its labels whatever the desktop collapse preference is
  // (an icon strip is no menu on a phone). Atelier's own phone navigation keeps its rules.
  const collapsed = monolith ? false : collapsedPref && !(mobileNavigationOpen && !atelier);
  /**
   * WHICH SECTIONS ARE EXPANDED — the fix for a rail that did not fit.
   *
   * MEASURED BEFORE THIS EXISTED (production build, 1440x900): the rail's content was 1490px in a 746px
   * column on EVERY screen. 34 entries, 16 reachable without scrolling, 18 below the fold — including
   * Analytics, Audit trail, Data Privacy, Security & permissions and AI, which is where a provider is
   * configured. A menu whose second half is only reachable by scrolling is not a menu people use.
   *
   * Route ownership opens the current section by default. An explicit user choice can still close it;
   * navigating to another route opens that route's section again without changing current-link matching.
   *
   * Session state, deliberately NOT a cookie. `rail_collapsed` is read SSR-side precisely so the icon
   * rail has no flash; a second cookie read on the client after mount would flip sections open after
   * paint, which is the same flash in a new place. Navigating within a section keeps it open, and moving
   * to another section opens that one, so the state a user actually experiences is the useful one.
   */
  const [inlineOpen, setInlineOpen] = useState<Record<string, boolean>>({});
  const [openSections, setOpenSections] = useState<Readonly<Record<string, boolean>>>({});
  // Escape returns focus to the trigger that opened the panel.
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingTriggerFocus = useRef<string | null>(null);
  useEffect(() => {
    if (openKey === null && pendingTriggerFocus.current) {
      triggerRefs.current[pendingTriggerFocus.current]?.focus();
      pendingTriggerFocus.current = null;
    }
  }, [openKey]);
  // Safety net for back/forward navigation only — picking a sub-item closes via its onClick
  // (mandatory: the Reports children share one pathname and differ only in the query, so this
  // effect never fires when switching report categories).
  useEffect(() => {
    setOpenKey(null);
    setMobileNavigationOpen(false);
    setInlineOpen({});
    setRailKids({});
    setWorkspaceChoice(null);
  }, [pathname, search]);
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
  const securityAccess={admin:canAdministerSecurity,configure:canConfigureAccess,provision:canProvisionUsers};
  const canSeeChild = (c: ChildItem) =>
    (!isSecurityDestination(c.href)||securityDestinationAllowed(c.href,securityAccess)) && moduleAllows(c.href) && (c.href !== '/lifecycle/v9'||onboardingV9Access) && (c.href !== '/assistant' || assistantAccess) && (c.href !== '/feedback' || feedbackAccess) && (!c.href.startsWith('/letters/')||letterDestinations.includes(c.href)) && (!c.href.startsWith('/lifecycle/onboarding')||onboardingAccess) && (c.href!=='/lifecycle/requisitions/onboarding'||onboardingRequisitionsAccess) && (c.href!=='/admin/lifecycle/onboarding'||onboardingAccess) && (c.href!=='/admin/lifecycle/onboarding/groups'||onboardingAccess||onboardingMaster) && (c.href!=='/admin/lifecycle/onboarding/access'||onboardingMaster) && (c.loginPresentationOnly ? canConfigureLoginPresentation : c.identityEmailOnly ? canPreviewIdentityEmail || canConfigureIdentityEmail : c.href === MY_TEAM_ROW.href ? canAccessTeam : c.href === PERFORMANCE_ADMIN_ROW.href ? canAdministerOnehr : c.href === '/admin/personnel/profile-changes' ? canReviewProfileChanges : c.href === AI_PROVIDER_HREF ? canConfigureAiProvider : isAiAdministrationHref(c.href) ? canAdministerAi : c.adminOnly ? isAdmin : c.managerUp ? isAdmin || canApprove || c.href === '/approvals' && (hasAssignedAttendanceApproval||hasAssignedApproval) : true);
  // The former audience inventory still supplies its original visibility boundaries.
  // Only authorized rows are handed to the workspace placement owner below.
  const authorizedGroups = GROUPS
    // Group-level flags still supported (the Admin group uses adminOnly).
    .filter((g) => (g.adminOnly ? isAdmin || canConfigureAccess || canConfigureIdentityEmail || onboardingAccess || onboardingMaster : g.managerUp ? isAdmin || canApprove : true))
    // 1b35f17b: filter per-row too, so a group (e.g. Manage) can mix all-employee rows
    // (Personnel) with manager-up rows (Approvals/Performance).
    .map((g) => ({
      ...g,
      items: g.items.filter((r) => (!g.adminOnly || isAdmin || (!isCollapsible(r)&&isSecurityDestination(r.href)&&canSeeChild(r)) || (!isCollapsible(r)&&r.href.startsWith('/admin/lifecycle/onboarding')&&canSeeChild(r)) || (isCollapsible(r) ? r.children.some(c => c.identityEmailOnly && canSeeChild(c)) : r.identityEmailOnly)) && (isCollapsible(r) ? r.children.some(canSeeChild) : canSeeChild(r))),
    }))
    // Drop a group that has become empty for this viewer (no stray divider in the collapsed rail).
    .filter((g) => g.items.length > 0);

  const authorizedRows = authorizedGroups.flatMap(group => group.items.flatMap(row =>
    isCollapsible(row) ? row.children.filter(canSeeChild) : [row],
  )).filter(row => row.href !== '/mobile-preview' || isAdmin)
    // Gated on the pack's address above; only then pointed at the latest cycle's admin area. It keeps owning every
    // other /performance route through its ownedSubpaths, so the cycle pages and admin tabs light it.
    .map(row => row === PERFORMANCE_ADMIN_ROW && performanceAdminHref ? {...row, href: performanceAdminHref} : row);
  const additionalRows: ChildItem[] = [
    ...LETTER_NAV_ITEMS.map(item=>({href:item.href,labelKey:item.labelKey,icon:FileBarChart,ownedSubpaths:[item.href]})),
    {href:'/admin/personnel/profile-changes',labelKey:'profileChanges',icon:ListChecks,adminOnly:true},
    {href:'/me/payslip',labelKey:'myPayslips',icon:Wallet,ownedSubpaths:['/me/payslip']},
    {href:'/me/letters',labelKey:'myLetters',icon:FileBarChart,ownedSubpaths:['/me/letters']},
    {href:'/me/tax-relief',labelKey:'taxRelief',icon:Receipt},
    {href:'/me/tp3',labelKey:'myTp3',icon:Receipt},
    {href:'/me/ea',labelKey:'myEa',icon:Receipt,ownedSubpaths:['/me/ea']},
    {href:'/admin/claims/reimbursements',labelKey:'reimbursementsDue',icon:Receipt,adminOnly:true},
    {href:'/reports',labelKey:'reports',icon:FileBarChart,adminOnly:true,exactHref:true},
  ];
  // The old lifecycle addresses remain valid for existing records and links, but their old
  // hub/self-service/requisition presentation is replaced by the owner's explicit V9 hierarchy.
  const lifecycleNavigation: ChildItem[] = V9_NAVIGATION.filter(item => onboardingV9Access &&
    !!onboardingV9Navigation?.[item.permission]).map(item => ({
      href: item.href, labelKey: item.labelKey, submenuKey: item.submenuKey, icon: ONBOARDING_NODE.icon,
      exactHref: true, ...('ownedSubpaths' in item ? { ownedSubpaths: [...item.ownedSubpaths] } : {}),
    } satisfies ChildItem)).filter(canSeeChild);
  const lifecycleShared: ChildItem[] = V9_SHARED_NAVIGATION.filter(item => onboardingV9Access &&
    (item.view === 'tasks' || !!onboardingV9Navigation?.records)).map(item => ({href:item.href,labelKey:item.labelKey,icon:ONBOARDING_NODE.icon,exactHref:true})).filter(canSeeChild);
  const destinations: ChildItem[] = [...authorizedRows.filter(row => {
    const placement = navigationPlacement(row.href);
    return !placement || !('module' in placement) || placement.module !== 'onboarding';
  }), ...additionalRows.filter(canSeeChild), ...lifecycleNavigation, ...lifecycleShared];
  const navigation = placeNavigation(destinations);
  const availableWorkspaces = (['ops','strata'] as const).filter(workspace =>
    navigation.placed.some(row => row.placement.area === workspace),
  );
  const routeOwner = navigationRouteOwner(pathname, search, destinations.filter(row => !row.disabled));
  const routeWorkspace = routeOwner?.placement.area;
  const selectedWorkspace = workspaceChoice && availableWorkspaces.includes(workspaceChoice) ? workspaceChoice
    : routeWorkspace === 'ops' || routeWorkspace === 'strata' ? routeWorkspace : availableWorkspaces[0];
  const moduleRows: Row[] = NAVIGATION_MODULES.filter(module => module.workspace === selectedWorkspace).flatMap<Row>(module => {
    const children = NAVIGATION_SECTIONS.flatMap(section => navigation.placed.filter(row =>
      'module' in row.placement && row.placement.module === module.id && row.placement.section === section,
    ).map(row => row.destination));
    if (!children.length) return [];
    if (children.length === 1 && module.id !== 'onboarding') return [{...children[0],labelKey:module.labelKey}];
    return [{collapsible:true,activeMatch:'children',labelKey:module.labelKey,icon:children[0].icon,
      children,tour:children.some(child=>child.tour==='nav-admin')?'nav-admin':undefined} satisfies CollapsibleGroupItem];
  });
  const sharedRows = navigation.placed.filter(row=>row.placement.area==='shared').map(row=>row.destination);
  const inboxRows = sharedRows.filter(row=>['/tasks','/approvals','/system-testing',...V9_SHARED_NAVIGATION.map(item=>item.href)].includes(row.href));
  const sharedItems: Row[] = sharedRows.filter(row=>!inboxRows.includes(row));
  if (inboxRows.length) sharedItems.splice(Math.min(2,sharedItems.length),0,{
    collapsible:true,activeMatch:'children',labelKey:'inbox',icon:ListChecks,children:inboxRows,
    tour:inboxRows.some(row=>row.tour==='nav-approvals')?'nav-approvals':undefined,
  });
  const systemRows = navigation.placed.filter(row=>row.placement.area==='system').map(row=>row.destination);
  const securityRows=systemRows.filter(row=>isSecurityDestination(row.href));
  const otherSystemRows=systemRows.filter(row=>!isSecurityDestination(row.href));
  const groups: Group[] = [
    {items:[...sharedItems,...navigation.unplaced]},
    {labelKey:selectedWorkspace==='strata'?'workspaceStrata':'workspaceOps',items:moduleRows},
    ...(systemRows.length ? [{labelKey:'systemConfiguration',items:[
      ...(otherSystemRows.length?[{collapsible:true,activeMatch:'children',labelKey:'systemConfiguration',icon:Settings2,children:otherSystemRows} satisfies CollapsibleGroupItem]:[]),
      ...(securityRows.length?[{collapsible:true,activeMatch:'children',labelKey:'securityCenter',icon:ShieldCheck,defaultHref:SECURITY_CENTER,children:securityRows} satisfies CollapsibleGroupItem]:[]),
    ]}] : []),
  ];
  const isWorkspaceKey = (key?:string) => key==='workspaceOps'||key==='workspaceStrata';
  const compactWorkspace = collapsed && !atelier && !monolith;
  const workspaceSwitch = () => availableWorkspaces.length > 1 ? <div role="group" aria-label={t('workspaceSwitch')}
    className={cn('flex gap-1 rounded-lg border border-border p-1',compactWorkspace&&'flex-col')}>
    {availableWorkspaces.map(workspace=><button key={workspace} type="button" aria-pressed={selectedWorkspace===workspace}
      onClick={()=>{setWorkspaceChoice(workspace);setOpenKey(null);setInlineOpen({});setRailKids({});}}
      className={cn('min-h-11 flex-1 rounded-md font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',compactWorkspace?'px-1 text-xs':'px-2 text-sm',selectedWorkspace===workspace?'bg-accent text-accent-foreground':'text-muted-foreground hover:bg-accent/60')}>
      {t(workspace==='ops'?'workspaceOps':'workspaceStrata')}
    </button>)}
  </div> : null;
  const sectionLabel = (href:string) => {
    const lifecycle = lifecycleNavigation.find(item => item.href === href);
    if (lifecycle) return lifecycle.submenuKey;
    const placement=navigationPlacement(href);
    return placement && 'section' in placement ? `section${placement.section==='hr'?'HR':placement.section==='ai'?'AiManagement':placement.section==='config'?'Configuration':placement.section==='mine'?'Mine':'Team'}` : undefined;
  };

  const childCaption=(child:{href:string;labelKey:string})=>{
    const count=child.href==='/lifecycle/onboarding'||child.href==='/lifecycle/v9'?onboardingJoinerCount:child.href==='/lifecycle/onboarding/checklists'||child.href==='/lifecycle/v9?view=onbChecklists'?onboardingChecklistCount:undefined;
    const pending=child.href==='/tasks'?taskCount:child.href==='/approvals'?approvalCount:0;
    return <>{t(child.labelKey)}{count!==undefined&&<span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{count}</span>}{pending>0&&<><span className="sr-only">{`, ${t('approvalsCount',{count:pending})}`}</span><ApprovalCountBadge count={pending} collapsed={false}/></>}</>;
  };
  const isActive = (href: string) => isHrefActive(pathname, search, href);
  // The shared route owner preserves query intent and explicit owned subpaths across all themes.
  const isRowActive = (r: { href: string; exactHref?: boolean; ownedSubpaths?: string[]; disabled?: boolean }) => {
    if(r.disabled)return false;
    // One owner across shared rows and modules, including query-based and non-descendant routes.
    if(routeOwner)return r.href===routeOwner.destination.href;
    return isNavRowActive(pathname,search,r);
  };
  // 10b59703 — the paths a fly-out child answers for: its own href plus any `ownedSubpaths` the pack
  // declared (packs/registry.ts NavChildDescriptor). Fed to isParentActive so the parent node lights
  // up on an owned tab exactly as it does on the child's own address. Highlighting only, never a gate.
  const childPaths = (c: { href: string; ownedSubpaths?: string[] }) => [c.href, ...(c.ownedSubpaths ?? [])];
  // The open module's node (permission-filtered children), resolved from the visible groups so a
  // stale openKey (e.g. after a role change) simply renders no panel.
  /** The section containing the current page — from the same predicates the rows light up with, so the
   *  open section and the highlighted row can never disagree. */
  const activeSectionKey =
    groups.find((g) =>
      g.items.some((r) =>
        isCollapsible(r)
          ? (r.defaultHref || r.activeMatch === 'children' ? r.children.filter(canSeeChild).some(isRowActive) : isParentActive(pathname, r.children.filter(canSeeChild).flatMap(childPaths)))
          : isRowActive(r),
      ),
    )?.labelKey ?? null;

  // Reset only the destination section's manual override on actual navigation (including report
  // categories sharing a pathname). A same-route rerender must retain an explicit collapse.
  useEffect(() => {
    if (!activeSectionKey) return;
    setOpenSections((prev) => {
      if (!(activeSectionKey in prev)) return prev;
      const next = { ...prev };
      delete next[activeSectionKey];
      return next;
    });
  }, [pathname, search, activeSectionKey]);
  const sectionOpen = (key?: string) =>
    key == null || isWorkspaceKey(key) || (openSections[key] ?? key === activeSectionKey);
  const toggleSection = (key: string) => setOpenSections((prev) => ({
    ...prev, [key]: !(prev[key] ?? key === activeSectionKey),
  }));

  /* Atelier round 1 — publish what this rail shows, for the command bar's "Go to" list and the Atelier
     breadcrumb (components/nav-index-context.tsx). Built from the SAME filtered `groups` and the same
     `canSeeChild` / `isRowActive` the rows render with, in every theme, so the palette can never list a
     destination this viewer's rail hides. Called before any early return: it is a hook. */
  const navEntries: NavIndexEntry[] = [];
  let activeEntry: NavIndexEntry | null = null;
  for (const g of groups) {
    const section = g.labelKey ? t(g.labelKey) : null;
    for (const r of g.items) {
      if (isCollapsible(r)) {
        const kids = r.children.filter(canSeeChild).filter((c) => !c.disabled);
        const parent = t(r.labelKey);
        const parentHref = r.defaultHref ?? (kids[0] ? kids[0].navigationHref ?? kids[0].href : null);
        const activeKid = kids.filter((c) => isRowActive(c))
          .sort((a, b) => b.href.split('?')[0].length - a.href.split('?')[0].length)[0];
        for (const c of kids) {
          const entry = { href: c.navigationHref ?? c.href, label: t(c.labelKey), section, parent, parentHref };
          navEntries.push(entry);
          if (!activeEntry && c === activeKid) activeEntry = entry;
        }
      } else if (!r.disabled) {
        const entry = { href: r.navigationHref ?? r.href, label: t(r.labelKey), section, parent: null, parentHref: null };
        navEntries.push(entry);
        if (!activeEntry && isRowActive(r)) activeEntry = entry;
      }
    }
  }
  usePublishNavIndex(navEntries, activeEntry);

  const openNode = openKey && !monolith
    ? groups.flatMap((g) => g.items).find((r): r is CollapsibleGroupItem => isCollapsible(r) && r.labelKey === openKey && (atelier || !r.defaultHref || collapsed)) ?? null
    : null;
  const openChildren = openNode ? openNode.children.filter(canSeeChild) : [];
  // Inside a panel the LONGEST matching href wins, so exactly one row ever reads as the current page
  // (1459e116 requirement 3). isHrefActive matches a path prefix, which is what makes a parent row a
  // valid nav target at all — but it also means Payroll's "Payroll Process" (/payroll) matches while
  // the viewer is on /payroll/setup, lighting it up next to "Settings". Ranking by path length picks
  // the more specific row; the rail's own parent highlighting (isParentActive) is unaffected.
  const activeChildHref = openChildren
    // 10b59703 — a child that OWNS paths outside its own href (Entitlements owns the Entitlement tables
    // and Configuration record tabs; Leave Adjustments owns Balance record and Import) is active on
    // them too, through the same predicate the flat rows use.
    .filter((c) => isRowActive(c))
    .sort((a, b) => b.href.split('?')[0].length - a.href.split('?')[0].length)[0]?.href;

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      document.cookie = `rail_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });

  const rowBase =
    'group flex items-center rounded-2xl transition duration-150 ease-snappy active:scale-[0.98]';

  /* ── r398 — THE MONOLITH RAIL (README §3, shell.css `.rail`). Rendering only: it walks the SAME `groups`
     (already role- and module-filtered above), the same `canSeeChild`, and lights rows with the same
     isNavRowActive / isParentActive predicates, so which rows exist, in which order, and which one is
     current cannot differ between the themes. What differs is structure the board needs and CSS cannot
     produce: no icons, mono rows, and a module's children INLINE behind a hairline instead of a flyout. */
  const railRow =
    'flex min-h-8 w-full items-center justify-between gap-2 border-l border-transparent py-1 pl-2.5 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-mid no-underline hover:border-hairline hover:text-ink';
  const railKid =
    '-ml-px flex min-h-7 items-center py-1 pl-3 font-mono text-[10px] uppercase tracking-[0.12em] text-mid no-underline hover:text-ink';
  const toggleKids = (key: string, expanded: boolean) => setRailKids((prev) => ({ ...prev, [key]: !expanded }));
  const monolithModule = (item: CollapsibleGroupItem) => {
    const children = item.children.filter(canSeeChild);
    if (children.length === 0) return null;
    const active =
      item.defaultHref || item.activeMatch === 'children'
        ? children.some(isRowActive)
        : isParentActive(pathname, children.flatMap(childPaths));
    const expanded = railKids[item.labelKey] ?? active;
    const label = t(item.labelKey);
    const kidsId = `rail-kids-${item.labelKey}`;
    // Exactly one child reads as the current page: the longest matching href (the flyout's own rule).
    const currentHref = children
      .filter((c) => isRowActive(c))
      .sort((a, b) => b.href.split('?')[0].length - a.href.split('?')[0].length)[0]?.href;
    const mark = (
      <span aria-hidden className="shrink-0 text-faint">
        {expanded ? '−' : '+'}
      </span>
    );
    return (
      <div key={item.labelKey} data-rail-module={item.labelKey} data-tour={item.tour}>
        {item.defaultHref ? (
          <div className={cn(railRow, 'pr-0', (active || expanded) && 'text-ink', active && 'border-ink')}>
            <Link href={item.defaultHref} className="min-w-0 flex-1 text-inherit no-underline">
              {label}
            </Link>
            <button
              type="button"
              aria-label={label}
              aria-expanded={expanded}
              aria-controls={kidsId}
              onClick={() => toggleKids(item.labelKey, expanded)}
              className="inline-flex min-h-7 items-center px-1"
            >
              {mark}
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={kidsId}
            onClick={() => toggleKids(item.labelKey, expanded)}
            className={cn(railRow, (active || expanded) && 'text-ink', active && 'border-ink')}
          >
            <span className="min-w-0">{label}</span>
            {mark}
          </button>
        )}
        {expanded && (
          <nav id={kidsId} aria-label={label} className="mt-0.5 mb-1.5 ml-2.5 flex flex-col border-l border-hairline">
            {(() => { const renderChild = (child: ChildItem, index: number) => {
              const current = child.href === currentHref;
              const heading=sectionLabel(child.href);
              return (
                <Fragment key={child.href}>
                {!child.submenuKey&&heading&&heading!==sectionLabel(children[index-1]?.href??'')&&<p className="mb-0 mt-2 px-3 text-xs text-muted-foreground">{t(heading)}</p>}
                <Link
                  key={child.href}
                  href={child.navigationHref??child.href}
                  data-tour={child.tour==='nav-admin'||child.tour==='nav-approvals'?undefined:child.tour}
                  aria-current={current ? 'page' : undefined}
                  className={cn(railKid, current && 'text-signal-text hover:text-signal-text')}
                >
                  {childCaption(child)}
                </Link>
                </Fragment>
              );
            }; return children.some(child => child.submenuKey)
              ? <NavigationSubmenus items={children} isActive={href => href === currentHref} renderItem={renderChild} triggerClassName={railKid}/>
              : children.map(renderChild); })()}
          </nav>
        )}
      </div>
    );
  };
  const monolithRail = () => (
    <>
      <Link
        href="/"
        aria-label={t('home')}
        className="block shrink-0 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink no-underline"
      >
        {/* The board's brand line. A mark, not copy (like `common.appName`, the same in every locale);
            the link's accessible name is the translated `nav.home`. */}
        AIHR <span className="text-mid">/ SYSTEM 01</span>
      </Link>
      <nav data-tour="nav" className="relative -mr-2 flex w-full flex-1 flex-col gap-[22px] overflow-y-auto overflow-x-hidden pr-2">
        {groups.map((group, gi) => (
          <div key={gi} className={cn('flex w-full flex-col gap-0.5',gi===2&&'mt-auto')}>
            {group.labelKey && !isWorkspaceKey(group.labelKey) && (
              <button
                type="button"
                onClick={() => toggleSection(group.labelKey!)}
                aria-expanded={sectionOpen(group.labelKey)}
                aria-controls={`nav-section-${group.labelKey}`}
                className="mb-1.5 flex w-full items-center justify-between border-b border-hairline pb-1.5 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-mid enabled:hover:text-ink"
              >
                <span>{t(group.labelKey)}</span>
                <span aria-hidden className="text-faint">
                  {sectionOpen(group.labelKey) ? '−' : '+'}
                </span>
              </button>
            )}
            <div id={group.labelKey ? `nav-section-${group.labelKey}` : undefined} className="flex w-full flex-col gap-0.5">
              {sectionOpen(group.labelKey) &&
                group.items.map((item) => {
                  if (isCollapsible(item)) return monolithModule(item);
                  const label = t(item.labelKey);
                  if (item.disabled) return (
                    <span key={item.href} aria-disabled="true" title={tWorkspace('planLocked')} className={cn(railRow, 'cursor-not-allowed hover:border-transparent hover:text-mid')}>
                      <span className="min-w-0">{label}</span>
                      <Lock aria-hidden className="size-3 shrink-0" />
                    </span>
                  );
                  const active = isRowActive(item);
                  const rowCount = item.href === '/tasks' ? taskCount : approvalCount;
                  const showApprovalCount = (item.href === '/approvals' || item.href === '/tasks') && rowCount > 0;
                  return (
                    <Link
                      key={item.href}
                      href={item.navigationHref ?? item.href}
                      data-tour={item.tour}
                      aria-label={showApprovalCount ? `${label}, ${t('approvalsCount', { count: rowCount })}` : label}
                      aria-current={active ? 'page' : undefined}
                      className={cn(railRow, active && 'border-ink text-ink hover:border-ink')}
                    >
                      <span className="min-w-0">{label}</span>
                      {showApprovalCount && (
                        <span aria-hidden className="shrink-0 text-[10px] tabular-nums text-signal-text">
                          {rowCount > 99 ? '99+' : rowCount}
                        </span>
                      )}
                    </Link>
                  );
                })}
            </div>
            {gi===0&&workspaceSwitch()}
          </div>
        ))}
      </nav>
      {viewerName && (
        <p className="mono m-0 shrink-0 text-mid" data-rail-user>
          {viewerName}
          <br />
          {[viewerCode, locale.toUpperCase()].filter(Boolean).join(' · ')}
        </p>
      )}
    </>
  );

  // The review journey owns its 224px navigator and floating route back to the dashboard. Since D-P1-32 PT-X5 the
  // workspace is no longer a nav row of its own (its tab routes sit under Performance & Talent), so its address is
  // named here.
  if (pathname === REVIEW_WORKSPACE_PATH) return null;

  /* ── Atelier round 1 — THE ASSISTANT-FIRST RAIL (brief: .impeccable/surfaces/app-layout-tsx.md). Rendering
     only, like Monolith's: the SAME `groups`, `canSeeChild`, `isRowActive` and section state, so which rows
     exist, in which order, and which one is current cannot differ between themes. What differs: the
     workspace line, a Quick actions button (it opens the one command bar, lib/command-bar-events.ts), 16px
     icons on 30px rows, a separate theme-scoped submenu track, and the viewer at
     the foot. No collapse to an icon rail: like Monolith, the rail is always open on desktop. */
  if (atelier) {
    const atelierCount = (href: string) => {
      const n = href === '/tasks' ? taskCount : href === '/approvals' ? approvalCount : 0;
      return n > 0 ? n : null;
    };
    const atelierModule = (item: CollapsibleGroupItem) => {
      const children = item.children.filter(canSeeChild);
      if (children.length === 0) return null;
      const active = item.defaultHref || item.activeMatch === 'children'
        ? children.some(isRowActive) : isParentActive(pathname, children.flatMap(childPaths));
      const expanded = openNode?.labelKey === item.labelKey;
      const Icon = item.icon;
      const label = t(item.labelKey);
      const kidsId = `atelier-flyout-${item.labelKey}`;
      const flip = () => setOpenKey(expanded ? null : item.labelKey);
      const register = (element: HTMLButtonElement | null) => { triggerRefs.current[item.labelKey] = element; };
      // Collapsed (b953a339), a module is its icon: it opens the floating sub-menu, which lists every page
      // the module has — including a landing page, which is always one of its children.
      return (
        <div key={item.labelKey} data-atelier-module={item.labelKey}>
          {item.defaultHref && !collapsed ? (
            <div className={cn('atelier-row pr-0', active&&'bg-accent font-medium text-foreground')}>
              <Link href={item.defaultHref} onClick={()=>setMobileNavigationOpen(false)} className="flex min-w-0 flex-1 items-center gap-2.5 text-inherit no-underline">
                <Icon aria-hidden /><span className="truncate">{label}</span>
              </Link>
              <button ref={register} type="button" aria-label={label} aria-expanded={expanded} aria-controls={kidsId} onClick={flip}
                className="atelier-row atelier-module-toggle">
                <ChevronDown aria-hidden className="atelier-chevron" />
              </button>
            </div>
          ) : (
            <button ref={register} type="button" aria-expanded={expanded} aria-controls={kidsId} onClick={flip} title={collapsed ? label : undefined} className={cn('atelier-row', (active || expanded) && 'bg-accent font-medium text-foreground')}>
              <Icon aria-hidden /><span className="atelier-label truncate">{label}</span>
              <ChevronDown aria-hidden className="atelier-chevron" />
            </button>
          )}
        </div>
      );
    };
    const initials = (viewerName ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
    return (
      <div className="atelier-navigation-container" onKeyDown={event=>{
        if(event.key==='Escape'&&!openNode&&mobileNavigationOpen){event.preventDefault();setMobileNavigationOpen(false);mobileNavigationTrigger.current?.focus();}
      }}>
      <button ref={mobileNavigationTrigger} type="button" className="atelier-mobile-toggle" aria-expanded={mobileNavigationOpen} aria-controls="atelier-mobile-navigation"
        onClick={()=>{setMobileNavigationOpen(open=>!open);setOpenKey(null);}}>
        <PanelLeftOpen aria-hidden className="size-4"/><span>{t('workspaceSwitch')}</span>
      </button>
      <div id="atelier-mobile-navigation" className={cn('atelier-navigation-shell relative h-full shrink-0 sm:flex', mobileNavigationOpen?'flex':'hidden', openNode && 'atelier-flyout-open z-50', collapsed && 'atelier-collapsed')}>
        <aside data-app-sidebar data-atelier-navigation className="atelier-rail">
          <Link href="/" aria-label={t('home')} className="atelier-workspace">
            <span data-brand-tile aria-hidden>AI</span>
            <span className="atelier-label">{tCommon('appName')}</span>
          </Link>
          <button type="button" className="atelier-quick" onClick={() => openCommandBar('')} title={collapsed ? tBar('quickActions') : undefined}>
            <Command aria-hidden className="size-3.5 shrink-0" />
            <span className="atelier-label">{tBar('quickActions')}</span>
            <kbd aria-hidden>⌘K</kbd>
          </button>
          <nav data-tour="nav" aria-label={tCommon('appName')} className="atelier-nav">
            {groups.map((group, gi) => (
              <div key={gi}>
                {group.labelKey && !isWorkspaceKey(group.labelKey) && (collapsed ? (
                  // Collapsed there is no room for a heading to toggle, so every section shows its icons.
                  <div role="presentation" className="atelier-section atelier-section-static"><span>{t(group.labelKey)}</span></div>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleSection(group.labelKey!)}
                    aria-expanded={sectionOpen(group.labelKey)}
                    aria-controls={`nav-section-${group.labelKey}`}
                    className="atelier-section"
                  >
                    <span>{t(group.labelKey)}</span>
                    <ChevronDown aria-hidden className={cn('size-3.5 shrink-0', !sectionOpen(group.labelKey) && '-rotate-90')} />
                  </button>
                ))}
                <div id={group.labelKey ? `nav-section-${group.labelKey}` : undefined} className="flex flex-col gap-px">
                  {(collapsed || sectionOpen(group.labelKey)) && group.items.map((item) => {
                    if (isCollapsible(item)) return atelierModule(item);
                    const Icon = item.icon;
                    const label = t(item.labelKey);
                    if (item.disabled) return (
                      <span key={item.href} aria-disabled="true" title={collapsed ? `${label} — ${tWorkspace('planLocked')}` : tWorkspace('planLocked')} className="atelier-row cursor-not-allowed text-muted-foreground">
                        <Icon aria-hidden /><span className="atelier-label truncate">{label}</span><Lock aria-hidden className="ml-auto size-3.5 shrink-0" />
                      </span>
                    );
                    const count = atelierCount(item.href);
                    return (
                      <Link key={item.href} href={item.navigationHref ?? item.href} onClick={()=>setMobileNavigationOpen(false)} data-tour={item.tour}
                        aria-label={count ? `${label}, ${t('approvalsCount', { count })}` : label}
                        aria-current={isRowActive(item) ? 'page' : undefined} title={collapsed ? label : undefined} className="atelier-row">
                        <Icon aria-hidden /><span className="atelier-label truncate">{label}</span>
                        {count && <span aria-hidden className="atelier-count">{count > 99 ? '99+' : count}</span>}
                      </Link>
                    );
                  })}
                </div>
                {gi===0&&workspaceSwitch()}
              </div>
            ))}
          </nav>
          {/* b953a339 — Classic's collapse control, in Atelier's styling. Same remembered setting (rail_collapsed). */}
          <button type="button" onClick={toggle} aria-label={collapsed ? t('expand') : t('collapse')} title={collapsed ? t('expand') : t('collapse')}
            aria-pressed={collapsed} data-atelier-collapse className="atelier-row atelier-collapse">
            {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            <span className="atelier-label truncate">{collapsed ? t('expand') : t('collapse')}</span>
          </button>
          {viewerName && (
            <div className="atelier-user" data-rail-user title={collapsed ? viewerName : undefined}>
              <span aria-hidden className="atelier-avatar">{initials || '·'}</span>
              <div className="atelier-label min-w-0">
                <b className="truncate">{viewerName}</b>
                {viewerCode && <span>{viewerCode}</span>}
              </div>
            </div>
          )}
        </aside>
        {openNode && <NavFlyoutPanel key={openNode.labelKey} layout="atelier" labelKey={openNode.labelKey}
          items={openChildren.map(child=>({...child,sectionKey:sectionLabel(child.href),pendingCount:child.href==='/tasks'?taskCount:child.href==='/approvals'?approvalCount:0})) as FlyoutChild[]}
          isActive={href=>href===activeChildHref} rowBase="atelier-row" panelId={`atelier-flyout-${openNode.labelKey}`}
          onClose={()=>{setOpenKey(null);setMobileNavigationOpen(false);}} onEscape={()=>{pendingTriggerFocus.current=openNode.labelKey;setOpenKey(null);}}/>}
      </div>
      </div>
    );
  }

  // D-P1-28 — below 640px Classic and Monolith used to hide the rail with no way to open it. A menu button (the label
  // and icon Atelier's phone toggle uses) opens the same rail as a drawer over the page; Escape, the backdrop or a
  // destination closes it, and focus returns to the button. The rail itself, and every breakpoint above 640px
  // (My Team's 900px included), is unchanged.
  const closeMobileNavigation = () => { setMobileNavigationOpen(false); mobileNavigationTrigger.current?.focus(); };
  return (
    <div className="contents" onKeyDown={event => {
      if (event.key === 'Escape' && !openNode && mobileNavigationOpen) { event.preventDefault(); closeMobileNavigation(); }
    }}>
    <button ref={mobileNavigationTrigger} type="button" data-mobile-navigation-toggle aria-expanded={mobileNavigationOpen} aria-controls="app-mobile-navigation"
      onClick={() => { setMobileNavigationOpen(open => !open); setOpenKey(null); }}
      className={cn('flex min-h-11 shrink-0 items-center gap-2.5 rounded-[1.25rem] border border-border bg-card px-4 text-left text-sm font-medium text-foreground shadow-[var(--shadow-card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring monolith:mx-4 monolith:mt-4 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-hairline monolith:bg-background monolith:px-0 monolith:shadow-none sm:hidden')}>
      <PanelLeftOpen aria-hidden className="size-4 shrink-0" /><span>{t('workspaceSwitch')}</span>
    </button>
    {mobileNavigationOpen && <div aria-hidden="true" data-mobile-navigation-backdrop onClick={closeMobileNavigation}
      className="fixed inset-0 z-40 bg-black/40 sm:hidden" />}
    {/* Wrapper (fdc20776): the aside is overflow-hidden, so the flyout panel cannot live inside it —
        it anchors to this relative wrapper instead, which takes over the aside's responsive/flex-item
        classes (a bare wrapper would stay a visible zero-width flex item below sm and add a phantom
        layout gutter, and the aside's h-full needs the wrapper to have height). While a panel is open
        the wrapper is raised to z-50 so the rail rows stay clickable above the z-40 backdrop (module
        swap in one click); the raise is conditional so onboarding-tour stacking is unaffected otherwise. */}
    <div className={cn('relative hidden h-full shrink-0', pathname === '/manage/my-team' ? 'min-[900px]:block' : 'sm:block', openNode && 'z-50',
      // D-P1-28 — open on a phone: the same wrapper, fixed over the page above the backdrop.
      mobileNavigationOpen && 'max-sm:fixed max-sm:inset-y-0 max-sm:left-0 max-sm:z-50 max-sm:block max-sm:h-auto max-sm:p-3 monolith:max-sm:p-0')}>
    {/* r398 (parent): the Monolith rail follows Classic's breakpoints. The README hides it below 900px, but the app
        has no other way to open navigation at those widths, so hiding it would leave a tablet with no navigation. */}
      <aside
        id="app-mobile-navigation"
        data-app-sidebar
        className={cn(
          'flex h-full flex-col overflow-hidden rounded-[1.25rem] border border-border bg-sidebar py-4 shadow-[var(--shadow-card)] transition-[width] duration-200 ease-snappy',
          collapsed ? 'w-[66px] items-center px-3' : 'w-[232px] px-3',
          // Above the panel's backdrop, so every rail row stays clickable while a panel is open.
          openNode && 'relative z-50',
          // r398 — Monolith (README §3): no floating panel — square, no shadow, one hairline on the right,
          // the board's 22/20/24/24 padding and 22px between blocks. Classic's computed style is untouched.
          'monolith:gap-[22px] monolith:rounded-none monolith:border-0 monolith:border-r monolith:border-hairline monolith:bg-background monolith:pt-[22px] monolith:pr-5 monolith:pb-6 monolith:pl-6 monolith:shadow-none',
        )}
      >
        {monolith ? monolithRail() : (<>
        <Link
          href="/"
          aria-label={t('home')}
          className={cn(
            'flex items-center gap-2.5 rounded-2xl transition duration-150 ease-snappy active:scale-95',
            collapsed ? 'justify-center' : 'px-1 py-0.5',
          )}
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-[13px] font-bold text-primary-foreground shadow-[var(--shadow-sm)]" aria-hidden>
            AI
          </span>
          {!collapsed && (
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight text-foreground">
              {tCommon('appName')}
            </span>
          )}
        </Link>

        {/* `relative` for the same reason as <main> in app/(app)/layout.tsx: absolute descendants
            (sr-only labels) must not escape this scroll container and create viewport overflow. */}
        <nav
          data-tour="nav"
          className="relative flex w-full flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden py-3"
        >
          {groups.map((group, gi) => (
            <div key={gi} className={cn('flex w-full flex-col gap-1', collapsed && 'items-center',gi===2&&'mt-auto')}>
              {gi > 0 && collapsed && (
                <span className="my-1.5 h-px w-7 rounded-full bg-border" aria-hidden />
              )}
              {/* ⚠️ THE SECTION HEADING IS A CONTROL NOW, not a caption. In the icon rail there is no
                  heading to click (labels are hidden), so sections stay open there and the divider above
                  is unchanged — collapsing a nameless strip of icons would hide destinations behind a
                  chevron with nothing to say what is inside. */}
              {!collapsed && group.labelKey && !isWorkspaceKey(group.labelKey) && (
                <button
                  type="button"
                  onClick={() => toggleSection(group.labelKey!)}
                  aria-expanded={sectionOpen(group.labelKey)}
                  aria-controls={`nav-section-${group.labelKey}`}
                  className={cn(
                    'group/sec flex w-full items-center justify-between rounded-md px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80',
                    // The first heading sits directly under the rail's own py-3, so its top padding is
                    // duplicate space. Reclaiming it is what brings the Admin section — the longest, at
                    // 15 rows — inside the viewport instead of one row over.
                    gi === 0 ? 'pt-0.5' : 'pt-2.5',
                    'hover:text-foreground',
                  )}
                >
                  <span>{t(group.labelKey)}</span>
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform',
                      !sectionOpen(group.labelKey) && '-rotate-90',
                    )}
                  />
                </button>
              )}
              {/* The id `aria-controls` on the heading points at. Without a real element to reference,
                  the attribute is a dangling promise to a screen reader. */}
              <div
                id={group.labelKey ? `nav-section-${group.labelKey}` : undefined}
                className={cn('flex w-full flex-col gap-1', collapsed && 'items-center')}
              >
              {(collapsed || sectionOpen(group.labelKey)) &&
              group.items.map((item) => {
                if (isCollapsible(item)) {
                  const children = item.children.filter(canSeeChild);
                  // Hide the whole parent if the viewer can see none of its children.
                  if (children.length === 0) return null;
                  if (item.defaultHref && !collapsed) {
                    const active = children.some(isRowActive);
                    const expanded = inlineOpen[item.labelKey] ?? (active || openKey === item.labelKey);
                    const Icon = item.icon;
                    return <div key={item.labelKey}>
                      <div className={cn(rowBase, 'w-full gap-1 px-3 py-1', active && 'bg-accent')}>
                        <Link href={item.defaultHref} className="flex min-h-11 min-w-0 flex-1 items-center gap-3"><Icon className="size-5 shrink-0" aria-hidden /><span className="text-sm">{t(item.labelKey)}</span></Link>
                        <button type="button" aria-label={t(item.labelKey)} aria-expanded={expanded} aria-controls={`inline-${item.labelKey}`} className="flex size-11 shrink-0 items-center justify-center" onClick={() => setInlineOpen(old=>({...old,[item.labelKey]:!expanded}))}><ChevronDown className={cn('size-4', !expanded && '-rotate-90')} aria-hidden /></button>
                      </div>
                      {expanded && <nav id={`inline-${item.labelKey}`} aria-label={t(item.labelKey)} className="ml-7 flex flex-col gap-1">{children.map((child) => <Link key={child.href} href={child.href} aria-current={isRowActive(child) ? 'page' : undefined} className={cn('flex min-h-11 items-center rounded-xl px-3 text-sm', isRowActive(child) ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent')}>{childCaption(child)}</Link>)}</nav>}
                    </div>;
                  }
                  return (
                    <NavFlyout
                      key={item.labelKey}
                      labelKey={item.labelKey}
                      icon={item.icon}
                      open={openKey === item.labelKey}
                      active={item.defaultHref || item.activeMatch === 'children' ? children.some(isRowActive) : isParentActive(pathname, children.flatMap(childPaths))}
                      collapsed={collapsed}
                      rowBase={rowBase}
                      panelId={`nav-flyout-${item.labelKey}`}
                      onToggle={() =>
                        setOpenKey((k) => (k === item.labelKey ? null : item.labelKey))
                      }
                      triggerRef={(el) => {
                        triggerRefs.current[item.labelKey] = el;
                      }}
                      tour={item.tour}
                    />
                  );
                }
                const Icon = item.icon;
                const label = t(item.labelKey);
                if (item.disabled) return (
                  <span key={item.href} aria-disabled="true" title={tWorkspace('planLocked')}
                    className={cn(rowBase, collapsed ? 'size-11 justify-center' : 'w-full gap-3 px-3 py-2', 'cursor-not-allowed text-muted-foreground')}>
                    <Icon className="size-[20px] shrink-0" strokeWidth={2} aria-hidden />
                    {!collapsed && <span className="truncate text-sm">{label}</span>}
                    {!collapsed && <Lock className="ml-auto size-4 shrink-0" aria-hidden />}
                  </span>
                );
                const active = isRowActive(item);
                // Pending-approval badge (feedback 836118c4). Keyed on the href, like every other
                // row-specific behaviour in this file — no marker field on the Item type. The count
                // arrives pre-computed from the layout; a viewer without the row never reaches here.
                const rowCount = item.href === '/tasks' ? taskCount : approvalCount;
                  const showApprovalCount = (item.href === '/approvals' || item.href === '/tasks') && rowCount > 0;
                return (
                  <Link
                    key={item.href}
                    href={item.navigationHref ?? item.href}
                    data-tour={item.tour}
                    title={collapsed ? label : undefined}
                    // The badge itself is aria-hidden, so the count reaches screen readers here —
                    // otherwise the rail would announce "Approval Items" whether 0 or 12 are waiting.
                    aria-label={showApprovalCount ? `${label}, ${t('approvalsCount', { count: rowCount })}` : label}
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
                      <ApprovalCountBadge count={rowCount} collapsed={collapsed} />
                    )}
                  </Link>
                );
              })}
              </div>
              {gi===0&&workspaceSwitch()}
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
            // The desktop collapse preference does nothing in the phone drawer (D-P1-28).
            mobileNavigationOpen && 'max-sm:hidden',
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
        </>)}
      </aside>

      {openNode && (
        <NavFlyoutPanel
          labelKey={openNode.labelKey}
          items={openChildren.map(child=>({...child,sectionKey:sectionLabel(child.href),tour:child.tour==='nav-admin'||child.tour==='nav-approvals'?undefined:child.tour,navigationHref:child.navigationHref,pendingCount:child.href==='/tasks'?taskCount:child.href==='/approvals'?approvalCount:0})) as FlyoutChild[]}
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
    </div>
  );
}
