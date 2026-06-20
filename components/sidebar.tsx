'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  Clock,
  Sparkles,
  LayoutDashboard,
  ListChecks,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Coins,
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

// `labelKey` indexes the `nav` message namespace; labels are resolved at render via useTranslations.
// `tour` (optional) marks the element as an onboarding-tour anchor (ADR-0018).
type Item = { href: string; labelKey: string; icon: LucideIcon; tour?: string };
type Group = { labelKey?: string; adminOnly?: boolean; managerUp?: boolean; items: Item[] };

const GROUPS: Group[] = [
  {
    items: [
      { href: '/', labelKey: 'dashboard', icon: LayoutDashboard },
      { href: '/me', labelKey: 'myWorkspace', icon: UserRound, tour: 'nav-me' },
      { href: '/people', labelKey: 'people', icon: Users },
      { href: '/org', labelKey: 'orgChart', icon: Network },
      { href: '/leave', labelKey: 'leave', icon: CalendarDays },
      { href: '/attendance', labelKey: 'attendance', icon: Clock },
      { href: '/claims', labelKey: 'claims', icon: Receipt },
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
      { href: '/admin/leave', labelKey: 'leaveConfig', icon: SlidersHorizontal },
      { href: '/admin/holidays', labelKey: 'holidays', icon: CalendarDays },
      { href: '/admin/claims', labelKey: 'claimsConfig', icon: Receipt },
      { href: '/payroll', labelKey: 'payroll', icon: Wallet },
      { href: '/admin/pay-components', labelKey: 'payComponents', icon: Coins },
      { href: '/analytics', labelKey: 'analytics', icon: BarChart3 },
      { href: '/admin/audit', labelKey: 'auditTrail', icon: ScrollText },
      { href: '/admin/ai', labelKey: 'aiConfig', icon: Sparkles },
      { href: '/admin/users', labelKey: 'usersRoles', icon: ShieldCheck },
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
  const t = useTranslations('nav');
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
