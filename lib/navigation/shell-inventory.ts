/** Client-safe declared shell inventory. Pack descriptors remain the owner of pack rows. */
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  CalendarDays,
  Clock,
  FileBarChart,
  Hash,
  FlaskConical,
  Sparkles,
  LayoutDashboard,
  ListChecks,
  Mail,
  MessageSquareText,
  Megaphone,
  Network,
  Receipt,
  Lock,
  LockKeyhole,
  FolderLock,
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
} from 'lucide-react';
import '@/packs/register-all';
import { modulePackById } from '@/packs/registry';
import { LETTER_NAV_ITEMS } from '@/lib/letter-navigation';
import { SECURITY_CENTER, SECURITY_PAGES } from '@/lib/security-center-navigation';

// `labelKey` indexes the `nav` message namespace; labels are resolved at render via useTranslations.
// `tour` (optional) marks the element as an onboarding-tour anchor (ADR-0018).
export type Item = { navigationHref?: string; href: string; labelKey: string; icon: LucideIcon; tour?: string };
// A flyout parent node (b3dc0f78, flyout redesign fdc20776): one level of nesting only. Each child
// carries its own visibility flag so filtering is per-child (vs. whole-group gating).
export type ChildItem = Item & {
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
export type CollapsibleGroupItem = {
  tour?: string;
  activeMatch?: 'children';
  defaultHref?: string;
  collapsible: true;
  labelKey: string;
  icon: LucideIcon;
  children: ChildItem[];
};
export type Row = ChildItem | CollapsibleGroupItem;
export const isCollapsible = (r: Row): r is CollapsibleGroupItem => 'collapsible' in r && r.collapsible;
// Control Tower pages and Administration › AI (which forwards into them) all run requireAdmin; a payroll or
// performance partner shares the administration rail but is redirected away from these.
// Provider setup is tenant-wide: its page reads the configuration only for a group-wide administrator.
export const AI_PROVIDER_HREF = '/control-tower/agents/provider';
export const isAiAdministrationHref = (href: string) => href === '/admin/ai' || href === '/control-tower' || href.startsWith('/control-tower/');
export type Group = { labelKey?: string; adminOnly?: boolean; managerUp?: boolean; items: Row[] };

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
export const ONBOARDING_NODE:CollapsibleGroupItem={...modulePackById('lifecycle')!.navNodes![0]!,collapsible:true};
const ONBOARDING_REQUISITIONS_NODE:CollapsibleGroupItem={collapsible:true,labelKey:'onboardingRequisitions',icon:ONBOARDING_NODE.icon,defaultHref:'/lifecycle/requisitions/onboarding',children:[{...LIFECYCLE_LINKS.find(l=>l.href==='/lifecycle/requisitions/onboarding')!,labelKey:'allOnboardingRequisitions',exactHref:true,ownedSubpaths:['/lifecycle/requisitions/onboarding']}]};

// Performance nav rows (ADR-0080 rung 4; D-P1-32 PT-X5, APR-025 D4): EXACTLY TWO entries the performance pack
// contributes (packs/performance/index.ts, PERFORMANCE_NAV_LINKS — provenance comments moved with them).
// Performance & Talent (every employee with the module; the area's tabs sit below it) and Performance admin
// (canAdministerOnehr only, pointed at the admin area's first tab for the latest cycle by `performanceAdminHref`).
// The former My Performance, Performance, Calibration, Talent and Development rows retired into the area's tabs.
const PERFORMANCE_TALENT_ROW: ChildItem = modulePackById('performance')!.navLinks!.find((l) => l.group === 'main' && l.labelKey === 'performanceTalent')!;
export const PERFORMANCE_ADMIN_ROW: ChildItem = modulePackById('performance')!.navLinks!.find((l) => l.group === 'manage' && l.labelKey === 'performanceAdmin')!;

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
export const MY_TEAM_ROW: ChildItem = LEAVE_LINKS.find((l) => l.labelKey === 'myTeam')!;

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
export const MODULE_OF_HREF: ReadonlyMap<string, string> = new Map([
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
  // Issue 17 (AI Centre › Operations): the former Control Tower rows left the rail, and with them their
  // payroll gates on /control-tower/actions and /control-tower/exceptions. The same gate now hides those two
  // section tabs (lib/ai-centre/centre-nav.ts CENTRE_SECTIONS, `payroll: true`).
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
// Issue 17 (owner: "Merge both entirely"): the AI management pages under /control-tower/agents are AI Centre ›
// Administration, reached through the AI Centre row and its tab rows. Every page keeps its address and its
// requireAdmin guard.
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
    { href: '/admin/settings/entra', labelKey: 'entra', icon: Settings2, adminOnly: true, loginPresentationOnly: true },
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
export const GROUPS: Group[] = [
  {
    // a6-audit — LABELLED so it can COLLAPSE. It was the one unnamed group, which meant it was always
    // open; at ten rows that alone is half the rail's height and no amount of collapsing the other three
    // could make the menu fit.
    labelKey: 'sectionHome',
    items: [
      { href: '/', labelKey: 'dashboard', icon: LayoutDashboard },
      { href: '/me', labelKey: 'myWorkspace', icon: UserRound, tour: 'nav-me' },
      // AI v2 W11 (ADR-0173): a person's own private cases with HR, beside their own workspace; every login sees it
      // (the page shows only their own cases). The handlers' queue follows, for a designated handler (or a group
      // administrator with a case to handle) only: canSeeChild reads privateCaseHandler from app/layout.tsx.
      { href: '/me/cases', labelKey: 'myPrivateCases', icon: LockKeyhole },
      { href: '/cases', labelKey: 'privateCases', icon: FolderLock },
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
      // AI centre: Ask, Inbox, Delegated jobs and How it works are views of /assistant (one row, same gate).
      // Issue 17: Operations and Administration (/control-tower/*) are AI Centre tabs, so this row owns them.
      { href: '/assistant', labelKey: 'aiCentre', icon: Sparkles, ownedSubpaths: ['/control-tower'] },
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
      // a324a4b3 rev3: Roster + Import come back here as FLAT rows. rev2 put them inside the Attendance
      // node, which was safe while that node sat in the ungated group; it is not safe now the node has
      // moved into admin-gated Administration, because the group gate would hide them from every
      // non-admin manager. They mount by const reference from the attendance pack's navLinks.
      ...ATTENDANCE_MANAGE_ROWS,
    ],
  },
  // Issue 17 (owner: "Merge both entirely", 3 November 2026): the Control Tower group stood here. Its pages are
  // AI Centre › Operations and Administration, rendered inside the AI Centre's tab rows; the AI Centre row owns
  // their addresses (ownedSubpaths below), so the rail has one item for both. "How the Control Tower works"
  // answers 308 to AI Centre › How it works. Every page keeps its address and requireAdmin guard.
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
       * un-gating stays a one-line change. See app/admin/work-locations/page.tsx.
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


export const ADDITIONAL_ROWS: ChildItem[] = [
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

/** Shared scoped lifecycle declaration owner. Metadata names existing fact gates, never new grants. */
export type ScopedLifecycleNavigationItem = ChildItem & {
  module: 'probation' | 'contracts';
  access: 'page' | 'configure' | 'configureOrIntake' | 'intake';
};
export const SCOPED_LIFECYCLE_NAVIGATION: readonly ScopedLifecycleNavigationItem[] = [
  {module:'probation',access:'page',href:'/lifecycle/probation',labelKey:'probationTracker',icon:Timer,exactHref:true,ownedSubpaths:['/lifecycle/probation']},
  {module:'contracts',access:'page',href:'/lifecycle/contracts',labelKey:'contractManagement',icon:ScrollText,exactHref:true,ownedSubpaths:['/lifecycle/contracts']},
  {module:'probation',access:'configure',href:'/lifecycle/probation/settings',labelKey:'probationSettings',icon:Timer},
  {module:'probation',access:'configure',href:'/lifecycle/probation/forms',labelKey:'probationForms',icon:Timer},
  {module:'probation',access:'configure',href:'/lifecycle/probation/routes',labelKey:'probationRoutes',icon:Timer},
  {module:'probation',access:'configure',href:'/lifecycle/probation/workflows',labelKey:'probationWorkflows',icon:Timer},
  {module:'probation',access:'configure',href:'/lifecycle/probation/templates',labelKey:'probationTemplates',icon:Timer},
  {module:'probation',access:'configureOrIntake',href:'/lifecycle/probation/intake',labelKey:'probationIntake',icon:Timer},
  {module:'contracts',access:'intake',href:'/lifecycle/contracts/intake',labelKey:'contractIntake',icon:ScrollText},
  {module:'contracts',access:'configure',href:'/lifecycle/contracts/settings',labelKey:'contractSettings',icon:ScrollText},
  {module:'contracts',access:'configure',href:'/lifecycle/contracts/workflows',labelKey:'contractWorkflows',icon:ScrollText},
  {module:'contracts',access:'configure',href:'/lifecycle/contracts/templates',labelKey:'contractTemplates',icon:ScrollText},
];
