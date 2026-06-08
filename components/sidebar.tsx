'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2,
  CalendarDays,
  Clock,
  LayoutDashboard,
  Network,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Child = { href: string; label: string };
type Item = { href: string; label: string; icon: LucideIcon; children?: Child[] };
type Group = { label?: string; adminOnly?: boolean; items: Item[] };

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
    label: 'Admin',
    adminOnly: true,
    items: [
      { href: '/admin/organization', label: 'Organization', icon: Building2 },
      { href: '/admin/leave', label: 'Leave config', icon: SlidersHorizontal },
      {
        href: '/payroll',
        label: 'Payroll',
        icon: Wallet,
        children: [
          { href: '/payroll', label: 'Batches' },
          { href: '/payroll/reports', label: 'Reports' },
        ],
      },
      { href: '/admin/users', label: 'Users & roles', icon: ShieldCheck },
    ],
  },
];

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 sm:flex">
      <Link href="/" className="mb-5 flex items-center gap-2.5 px-2 py-1">
        <span className="grid size-8 place-items-center rounded-xl bg-primary text-[12px] font-bold text-primary-foreground shadow-[var(--shadow-sm)]">
          HR
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-foreground">AI HR</span>
      </Link>

      <nav className="flex flex-1 flex-col gap-6 overflow-y-auto">
        {GROUPS.filter((g) => isAdmin || !g.adminOnly).map((group, gi) => (
          <div key={gi} className="flex flex-col gap-0.5">
            {group.label && (
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              // Pick the most specific matching child as the active one.
              const activeChild =
                item.children
                  ?.filter((c) => isActive(pathname, c.href))
                  .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
              return (
                <div key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition duration-150 ease-snappy',
                      active
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-[18px] shrink-0',
                        active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
                      )}
                      strokeWidth={2}
                    />
                    {item.label}
                  </Link>

                  {item.children && active && (
                    <div className="mt-0.5 flex flex-col gap-0.5 pl-[1.85rem]">
                      {item.children.map((child) => {
                        const childActive = activeChild === child.href;
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            aria-current={childActive ? 'page' : undefined}
                            className={cn(
                              'rounded-lg px-2.5 py-1.5 text-[13px] transition-colors',
                              childActive
                                ? 'font-medium text-accent-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {child.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
