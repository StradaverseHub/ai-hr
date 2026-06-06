'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS: { label?: string; adminOnly?: boolean; items: { href: string; label: string }[] }[] = [
  {
    items: [
      { href: '/', label: 'Dashboard' },
      { href: '/me', label: 'My workspace' },
      { href: '/people', label: 'People' },
      { href: '/org', label: 'Org chart' },
      { href: '/leave', label: 'Leave' },
      { href: '/attendance', label: 'Attendance' },
    ],
  },
  {
    label: 'Admin',
    adminOnly: true,
    items: [
      { href: '/admin/organization', label: 'Organization' },
      { href: '/admin/leave', label: 'Leave config' },
      { href: '/payroll', label: 'Payroll' },
      { href: '/admin/users', label: 'Users & roles' },
    ],
  },
];

export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-card px-3 py-4 sm:flex">
      <div className="flex items-center gap-2 px-3 pb-5">
        <span className="grid size-7 place-items-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
          HR
        </span>
        <span className="text-base font-semibold tracking-tight">AI HR</span>
      </div>
      <nav className="flex flex-col gap-5">
        {GROUPS.filter((group) => isAdmin || !group.adminOnly).map((group, gi) => (
          <div key={gi} className="flex flex-col gap-1">
            {group.label && (
              <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                    active
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
