'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS: { label?: string; items: { href: string; label: string }[] }[] = [
  {
    items: [
      { href: '/people', label: 'People' },
      { href: '/leave', label: 'Leave' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { href: '/admin/organization', label: 'Organization' },
      { href: '/admin/leave', label: 'Leave config' },
      { href: '/admin/users', label: 'Users & roles' },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200 bg-white px-3 py-4 dark:border-zinc-800 dark:bg-zinc-950 sm:flex">
      <div className="flex items-center gap-2 px-3 pb-5">
        <span className="grid size-7 place-items-center rounded-lg bg-indigo-600 text-xs font-bold text-white">HR</span>
        <span className="text-base font-semibold tracking-tight">AI HR</span>
      </div>
      <nav className="flex flex-col gap-5">
        {GROUPS.map((group, gi) => (
          <div key={gi} className="flex flex-col gap-1">
            {group.label && (
              <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-600">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                    active
                      ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
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
