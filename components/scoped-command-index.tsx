'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';

export type ScopedCommandEntry = { href: string; label: string; context: string };
const empty: readonly ScopedCommandEntry[] = [];
type Scope = { token: symbol; pathname: string; entries: readonly ScopedCommandEntry[] };
let scope: Scope | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function ScopedCommandIndex({ entries }: { entries: readonly ScopedCommandEntry[] }) {
  const pathname = usePathname() ?? '';
  useEffect(() => {
    const token = Symbol();
    scope = { token, pathname, entries };
    notify();
    return () => {
      if (scope?.token === token) { scope = null; notify(); }
    };
  }, [entries, pathname]);
  return null;
}

export function useScopedCommandEntries() {
  const pathname = usePathname() ?? '';
  return useSyncExternalStore(subscribe, () => scope?.pathname === pathname ? scope.entries : empty, () => empty);
}
