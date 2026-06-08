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

type Item = { href: string; label: string; icon: LucideIcon };
type Group = { adminOnly?: boolean; items: Item[] };

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
    adminOnly: true,
    items: [
      { href: '/admin/organization', label: 'Organization', icon: Building2 },
      { href: '/admin/leave', label: 'Leave config', icon: SlidersHorizontal },
      { href: '/payroll', label: 'Payroll', icon: Wallet },
      { href: '/admin/users', label: 'Users & roles', icon: ShieldCheck },
    ],
  },
];

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

/** Detached, slim icon rail (floats on the canvas). Labels surface on hover via title. */
export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const groups = GROUPS.filter((g) => isAdmin || !g.adminOnly);
  return (
    <aside className="hidden h-full w-[66px] shrink-0 flex-col items-center gap-2 rounded-[1.25rem] border border-border bg-sidebar py-4 shadow-[var(--shadow-card)] sm:flex">
      <Link
        href="/"
        aria-label="AI HR home"
        className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-[13px] font-bold text-primary-foreground shadow-[var(--shadow-sm)] transition duration-150 ease-snappy active:scale-95"
      >
        HR
      </Link>

      <nav className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1">
        {groups.map((group, gi) => (
          <div key={gi} className="flex flex-col items-center gap-1.5">
            {gi > 0 && <span className="my-1 h-px w-7 rounded-full bg-border" aria-hidden />}
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'grid size-11 place-items-center rounded-2xl transition duration-150 ease-snappy active:scale-95',
                    active
                      ? 'bg-accent text-primary'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <Icon className="size-[20px]" strokeWidth={2} />
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
