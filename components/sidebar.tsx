'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  BookOpen,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Clock,
  FileUp,
  HandCoins,
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
  ShieldCheck,
  Tags,
  Target,
  SlidersHorizontal,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { NavCollapsibleGroup, type CollapsibleChild } from '@/components/nav-collapsible-group';

// `labelKey` indexes the `nav` message namespace; labels are resolved at render via useTranslations.
// `tour` (optional) marks the element as an onboarding-tour anchor (ADR-0018).
type Item = { href: string; labelKey: string; icon: LucideIcon; tour?: string };
// A collapsible parent node (b3dc0f78): one level of nesting only. Each child carries its own
// visibility flag so filtering is per-child (the new capability vs. today's whole-group gating).
type ChildItem = Item & { adminOnly?: boolean; managerUp?: boolean };
type CollapsibleGroupItem = {
  collapsible: true;
  labelKey: string;
  icon: LucideIcon;
  /** Cookie key that persists this node's open/closed choice (SSR-read in the layout). */
  cookieKey: string;
  children: ChildItem[];
};
type Row = Item | CollapsibleGroupItem;
const isCollapsible = (r: Row): r is CollapsibleGroupItem => 'collapsible' in r && r.collapsible;
type Group = { labelKey?: string; adminOnly?: boolean; managerUp?: boolean; items: Row[] };

// Consolidated Attendance node (b3dc0f78). Groups the previously-scattered attendance rows —
// Records (was in the top group), Policy/Allowance/Clocking Location/Time-off-in-lieu (were in
// the admin group), Roster (was in the manage group) and Import — under one collapsible parent
// with per-child role visibility. Holidays moved here from the admin group per 5cb199b3, which
// confirmed the relocation b3dc0f78 had deferred as contested (ticket order: Holidays → Policy
// → Allowance → Locations → TOIL). Reserved (do not create): an "Overtime Configuration" child
// is owned by item e776d17d; when its route lands it inserts itself here after Clocking Location.
const ATTENDANCE_NODE: CollapsibleGroupItem = {
  collapsible: true,
  labelKey: 'attendance',
  icon: Clock,
  cookieKey: 'nav_attendance_open',
  children: [
    { href: '/attendance', labelKey: 'attendanceRecords', icon: Clock },
    { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, managerUp: true },
    { href: '/roster', labelKey: 'roster', icon: CalendarRange, managerUp: true },
    { href: '/admin/holidays', labelKey: 'holidays', icon: CalendarDays, adminOnly: true },
    { href: '/admin/attendance', labelKey: 'attendancePolicy', icon: CalendarClock, adminOnly: true },
    { href: '/admin/attendance-allowance', labelKey: 'attendanceAllowance', icon: HandCoins, adminOnly: true },
    { href: '/admin/locations', labelKey: 'clockingLocation', icon: MapPin, adminOnly: true },
    // e776d17d reserves the "Overtime Configuration" child slot here.
    { href: '/admin/toil', labelKey: 'toilPolicy', icon: Hourglass, adminOnly: true },
  ],
};

const GROUPS: Group[] = [
  {
    items: [
      { href: '/', labelKey: 'dashboard', icon: LayoutDashboard },
      { href: '/me', labelKey: 'myWorkspace', icon: UserRound, tour: 'nav-me' },
      { href: '/personnel', labelKey: 'people', icon: Users },
      { href: '/org', labelKey: 'orgChart', icon: Network },
      { href: '/leave', labelKey: 'leave', icon: CalendarDays },
      ATTENDANCE_NODE,
      { href: '/claims', labelKey: 'claims', icon: Receipt },
      { href: '/feedback', labelKey: 'feedback', icon: MessageSquareText },
      { href: '/knowledge-base', labelKey: 'knowledgeBase', icon: BookOpen, tour: 'nav-knowledge-base' },
    ],
  },
  {
    labelKey: 'manage',
    managerUp: true,
    items: [
      { href: '/approvals', labelKey: 'approvals', icon: ListChecks, tour: 'nav-approvals' },
      { href: '/performance', labelKey: 'performance', icon: Target },
    ],
  },
  {
    labelKey: 'admin',
    adminOnly: true,
    items: [
      { href: '/admin/organization', labelKey: 'organization', icon: Building2, tour: 'nav-admin' },
      { href: '/admin/personnel', labelKey: 'personnelAdmin', icon: Users },
      { href: '/admin/settings/system-labels', labelKey: 'systemLabels', icon: Tags },
      // 0d147b78: Leave config is now a tabbed surface; the former standalone "Approval chain" entry
      // was absorbed into its Approval Workflow tab (/admin/leave/approval), so it's removed here.
      { href: '/admin/leave', labelKey: 'leaveConfig', icon: SlidersHorizontal },
      // Holidays lives under the Attendance node above (5cb199b3), not in the flat admin list.
      { href: '/admin/claims', labelKey: 'claimsConfig', icon: Receipt },
      { href: '/payroll', labelKey: 'payroll', icon: Wallet },
      { href: '/analytics', labelKey: 'analytics', icon: BarChart3 },
      { href: '/admin/audit', labelKey: 'auditTrail', icon: ScrollText },
      { href: '/admin/privacy', labelKey: 'dataPrivacy', icon: Lock },
      { href: '/admin/ai', labelKey: 'aiConfig', icon: Sparkles },
      { href: '/admin/users', labelKey: 'securityPermission', icon: ShieldCheck },
    ],
  },
];

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

/** Detached rail that floats on the canvas. Collapses to an icon-only strip; expands
 *  to icon + label. The choice persists via the `rail_collapsed` cookie (read SSR-side
 *  in the layout, so there's no flash and no hydration mismatch). Collapsible sub-groups
 *  (b3dc0f78) persist their own open/closed state the same way, via `openGroups`. */
export function Sidebar({
  isAdmin,
  canApprove = false,
  defaultCollapsed,
  openGroups = {},
}: {
  isAdmin: boolean;
  /** Manager-and-up: shows the Approvals inbox. */
  canApprove?: boolean;
  defaultCollapsed: boolean;
  /** SSR-read open state per collapsible-group cookie key (e.g. `nav_attendance_open`). */
  openGroups?: Record<string, boolean>;
}) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // Per-child visibility for collapsible nodes (the new capability vs. whole-group gating).
  const canSeeChild = (c: ChildItem) =>
    c.adminOnly ? isAdmin : c.managerUp ? isAdmin || canApprove : true;
  const groups = GROUPS.filter((g) =>
    g.adminOnly ? isAdmin : g.managerUp ? isAdmin || canApprove : true,
  );

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      document.cookie = `rail_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });

  const rowBase =
    'group flex items-center rounded-2xl transition duration-150 ease-snappy active:scale-[0.98]';

  return (
    <aside
      className={cn(
        'hidden h-full shrink-0 flex-col overflow-hidden rounded-[1.25rem] border border-border bg-sidebar py-4 shadow-[var(--shadow-card)] transition-[width] duration-200 ease-snappy sm:flex',
        collapsed ? 'w-[66px] items-center px-3' : 'w-[232px] px-3',
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

      <nav
        data-tour="nav"
        className="flex w-full flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden py-3"
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
                  <NavCollapsibleGroup
                    key={item.labelKey}
                    labelKey={item.labelKey}
                    icon={item.icon}
                    items={children as CollapsibleChild[]}
                    defaultOpen={openGroups[item.cookieKey] ?? false}
                    collapsed={collapsed}
                    isActive={(href) => isActive(pathname, href)}
                    cookieKey={item.cookieKey}
                    rowBase={rowBase}
                  />
                );
              }
              const active = isActive(pathname, item.href);
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
  );
}
