'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  BookOpen,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Clock,
  FileBarChart,
  FileUp,
  HandCoins,
  Hash,
  Hourglass,
  Sparkles,
  LayoutDashboard,
  ListChecks,
  MapPin,
  MessageSquareText,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Lock,
  ScrollText,
  Settings2,
  Timer,
  ShieldCheck,
  Smartphone,
  Tags,
  Target,
  SlidersHorizontal,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  NavFlyout,
  NavFlyoutPanel,
  isHrefActive,
  isParentActive,
  type FlyoutChild,
} from '@/components/nav-flyout';

// `labelKey` indexes the `nav` message namespace; labels are resolved at render via useTranslations.
// `tour` (optional) marks the element as an onboarding-tour anchor (ADR-0018).
type Item = { href: string; labelKey: string; icon: LucideIcon; tour?: string };
// A flyout parent node (b3dc0f78, flyout redesign fdc20776): one level of nesting only. Each child
// carries its own visibility flag so filtering is per-child (vs. whole-group gating).
type ChildItem = Item & { adminOnly?: boolean; managerUp?: boolean };
type CollapsibleGroupItem = {
  collapsible: true;
  labelKey: string;
  icon: LucideIcon;
  children: ChildItem[];
};
type Row = ChildItem | CollapsibleGroupItem;
const isCollapsible = (r: Row): r is CollapsibleGroupItem => 'collapsible' in r && r.collapsible;
type Group = { labelKey?: string; adminOnly?: boolean; managerUp?: boolean; items: Row[] };

// Consolidated Attendance node (b3dc0f78). Groups the previously-scattered attendance rows —
// Records (was in the top group), Policy/Allowance/Clocking Location/Time-off-in-lieu (were in
// the admin group), Roster (was in the manage group) and Import — under one parent node
// with per-child role visibility. Holidays moved here from the admin group per 5cb199b3, which
// confirmed the relocation b3dc0f78 had deferred as contested (ticket order: Holidays → Policy
// → Allowance → Locations → TOIL). Reserved (do not create): an "Overtime Configuration" child
// is owned by item e776d17d; when its route lands it inserts itself here after Clocking Location.
// Child order (f60cd403): day-to-day Records first, then the admin-config screens, and the
// administrative bulk-upload Import ALWAYS last — it is used far less than daily attendance ops.
// hrefs / icons / visibility flags are unchanged by that reorder; only row position moved.
const ATTENDANCE_NODE: CollapsibleGroupItem = {
  collapsible: true,
  labelKey: 'attendance',
  icon: Clock,
  children: [
    // Feedback 5249d43f: "Clock in/out" — the employee-facing clocking page — is the PRIMARY day-to-day
    // action, so it sits FIRST, above Records (the node's documented day-to-day-first ordering, f60cd403).
    // Visible to every employee (self-service, like /me).
    { href: '/attendance/clock', labelKey: 'attendanceClock', icon: Clock },
    { href: '/attendance', labelKey: 'attendanceRecords', icon: Clock },
    { href: '/admin/holidays', labelKey: 'holidays', icon: CalendarDays, adminOnly: true },
    // R33 f21d6eee: "Shift settings" (/admin/attendance) is now the shared shift library; the per-company
    // working-hours + overtime-rates config moved to its own "Attendance policy" screen.
    { href: '/admin/attendance', labelKey: 'attendancePolicy', icon: CalendarClock, adminOnly: true },
    { href: '/admin/attendance-policy', labelKey: 'attendancePolicyConfig', icon: SlidersHorizontal, adminOnly: true },
    { href: '/admin/attendance-allowance', labelKey: 'attendanceAllowance', icon: HandCoins, adminOnly: true },
    { href: '/admin/locations', labelKey: 'clockingLocation', icon: MapPin, adminOnly: true },
    // e776d17d reserves the "Overtime Configuration" child slot here (after Clocking Location, before Import).
    { href: '/admin/toil', labelKey: 'toilPolicy', icon: Hourglass, adminOnly: true },
    { href: '/roster', labelKey: 'roster', icon: CalendarRange, managerUp: true },
    // Import stays last: administrative bulk-upload, used less than daily attendance (f60cd403).
    { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, managerUp: true },
  ],
};

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
  ],
};

const GROUPS: Group[] = [
  {
    items: [
      { href: '/', labelKey: 'dashboard', icon: LayoutDashboard },
      { href: '/me', labelKey: 'myWorkspace', icon: UserRound, tour: 'nav-me' },
      { href: '/org', labelKey: 'orgChart', icon: Network },
      // a7cbd895: renamed from "Leave" to "My Absence" — the first-level home for ALL leave self-service
      // after the /me Leave tab merged into /leave. Same href, same icon; label-only change.
      { href: '/leave', labelKey: 'myAbsence', icon: CalendarDays },
      ATTENDANCE_NODE,
      { href: '/claims', labelKey: 'claims', icon: Receipt },
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
      { href: '/approvals', labelKey: 'approvals', icon: ListChecks, tour: 'nav-approvals', managerUp: true },
      { href: '/performance', labelKey: 'performance', icon: Target, managerUp: true },
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
      // 0d147b78: Leave config is now a tabbed surface; the former standalone "Approval chain" entry
      // was absorbed into its Approval Workflow tab (/admin/leave/approval), so it's removed here.
      { href: '/admin/leave', labelKey: 'leaveConfig', icon: SlidersHorizontal },
      // Holidays lives under the Attendance node above (5cb199b3), not in the flat admin list.
      { href: '/admin/claims', labelKey: 'claimsConfig', icon: Receipt },
      { href: '/payroll', labelKey: 'payroll', icon: Wallet },
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
  defaultCollapsed,
}: {
  isAdmin: boolean;
  /** Manager-and-up: shows the Approvals inbox. */
  canApprove?: boolean;
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
  // Per-child visibility for flyout nodes (per-child gating vs. whole-group gating).
  const canSeeChild = (c: ChildItem) =>
    c.adminOnly ? isAdmin : c.managerUp ? isAdmin || canApprove : true;
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
  // The open module's node (permission-filtered children), resolved from the visible groups so a
  // stale openKey (e.g. after a role change) simply renders no panel.
  const openNode = openKey
    ? groups.flatMap((g) => g.items).find((r): r is CollapsibleGroupItem => isCollapsible(r) && r.labelKey === openKey) ?? null
    : null;

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
                const active = isActive(item.href);
                const Icon = item.icon;
                const label = t(item.labelKey);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    data-tour={item.tour}
                    title={collapsed ? label : undefined}
                    aria-label={label}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      rowBase,
                      collapsed ? 'size-11 justify-center' : 'w-full gap-3 px-3 py-2',
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
          items={openNode.children.filter(canSeeChild) as FlyoutChild[]}
          isActive={isActive}
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
