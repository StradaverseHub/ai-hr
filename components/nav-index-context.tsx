'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Atelier round 1 — THE NAV INDEX: the destinations the rail is showing THIS viewer, published by
 * components/sidebar.tsx for the two consumers that need them outside the rail: the command bar's "Go to"
 * list (components/command-bar.tsx) and the Atelier breadcrumb (components/shell-top-line.tsx).
 *
 * ONE SOURCE. The rail already resolves which rows exist (role gates, module entitlements, onboarding
 * access) from the layout's props; this context carries that RESULT, never a second filter. So the palette
 * can never offer a destination the rail hides, and every destination still enforces its own route guard.
 * Labels arrive translated, because the rail already holds the `nav` translator.
 */
export type NavIndexEntry = {
  href: string;
  label: string;
  /** The rail section the row sits in (translated), shown beside the result and as the breadcrumb root. */
  section: string | null;
  /** The module a child row belongs to (translated), when it is a module child. */
  parent: string | null;
  /** Where the module crumb leads: the module's own landing page, else its first visible child. */
  parentHref: string | null;
};

type NavIndex = {
  entries: readonly NavIndexEntry[];
  /** The row that reads as the current page in the rail, or null. */
  active: NavIndexEntry | null;
};

const EMPTY: NavIndex = { entries: [], active: null };
const NavIndexContext = createContext<{ index: NavIndex; publish: (next: NavIndex) => void }>({
  index: EMPTY,
  publish: () => {},
});

export function NavIndexProvider({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState<NavIndex>(EMPTY);
  const value = useMemo(() => ({ index, publish: setIndex }), [index]);
  return <NavIndexContext.Provider value={value}>{children}</NavIndexContext.Provider>;
}

export function useNavIndex(): NavIndex {
  return useContext(NavIndexContext).index;
}

/** The rail calls this every render; it republishes only when the visible set or the active row changed. */
export function usePublishNavIndex(entries: readonly NavIndexEntry[], active: NavIndexEntry | null) {
  const { publish } = useContext(NavIndexContext);
  const key = JSON.stringify([entries, active?.href ?? null]);
  useEffect(() => {
    publish({ entries, active });
    // `key` is the identity of the published value; entries/active are fresh arrays every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, publish]);
}
