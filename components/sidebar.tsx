'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  Building2,
  CalendarDays,
  Clock,
  LayoutDashboard,
  ListChecks,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  ShieldCheck,
  Target,
  SlidersHorizontal,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Item = { href: string; label: string; icon: LucideIcon };
type Group = { label?: string; adminOnly?: boolean; managerUp?: boolean; items: Item[] };

const GROUPS: Group[] = [
  {
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/me', label: 'My workspace', icon: UserRound },
      { href: '/people', label: 'People', icon: Users },
      { href: '/org', label: 'Org chart', icon: Network },
      { href: '/leave', label: 'Leave', icon: CalendarDays },
      { href: '/attendance', label: 'Attendance', icon: Clock },
    ],
  },
  {
    label: 'Manage',
    managerUp: true,
    items: [
      { href: '/approvals', label: 'Approvals', icon: ListChecks },
      { href: '/performance', label: 'Performance', icon: Target },
    ],
  },
  {
    label: 'Admin',
    adminOnly: true,
    items: [
      { href: '/admin/organization', label: 'Organization', icon: Building2 },
      { href: '/admin/leave', label: 'Leave config', icon: SlidersHorizontal },
      { href: '/payroll', label: 'Payroll', icon: Wallet },
      { href: '/admin/audit', label: 'Audit trail', icon: ScrollText },
      { href: '/admin/users', label: 'Users & roles', icon: ShieldCheck },
    ],
  },
];

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

/** Detached rail that floats on the canvas. Collapses to an icon-only strip; expands
 *  to icon + label. The choice persists via the `rail_collapsed` cookie (read SSR-side
 *  in the layout, so there's no flash and no hydration mismatch). */
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
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
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
        aria-label="AI HR home"
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

      <nav className="flex w-full flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden py-3">
        {groups.map((group, gi) => (
          <div key={gi} className={cn('flex w-full flex-col gap-1', collapsed && 'items-center')}>
            {gi > 0 &&
              (collapsed ? (
                <span className="my-1.5 h-px w-7 rounded-full bg-border" aria-hidden />
              ) : (
                group.label && (
                  <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                    {group.label}
                  </div>
                )
              ))}
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-label={item.label}
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
                  {!collapsed && <span className="truncate text-sm">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand' : 'Collapse'}
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
            <span className="truncate text-sm">Collapse</span>
          </>
        )}
      </button>
    </aside>
  );
}
