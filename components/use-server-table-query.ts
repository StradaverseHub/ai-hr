'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/** Debounced navigation searches the full server set; paging retains the resolved search and sort. */
export function useServerTableQuery(
  serverQuery: string | undefined,
  names: { query: string; sort: string; dir: string; page: string },
) {
  const router = useRouter();
  const sp = useSearchParams();
  const [query, setQuery] = useState(serverQuery ?? '');
  const previousServerQuery = useRef(serverQuery);
  const draft = useRef(query);
  draft.current = query;
  useEffect(() => {
    // An earlier navigation may finish while the user is typing the next search. Only replace a clean
    // draft (e.g. Back/Forward), or acknowledge the response for the current draft.
    const current = draft.current.trim().slice(0, 200);
    if (current === (previousServerQuery.current ?? '') || current === (serverQuery ?? '')) setQuery(serverQuery ?? '');
    previousServerQuery.current = serverQuery;
  }, [serverQuery]);
  const qs = sp.toString();
  useEffect(() => {
    if (serverQuery === undefined || query.trim() === serverQuery) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(qs);
      if (query.trim()) next.set(names.query, query.trim()); else next.delete(names.query);
      next.delete(names.page);
      router.replace(`?${next.toString()}`, { scroll: false });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, serverQuery, qs, names.query, names.page, router]);
  const sort = (key: string, dir: 'asc' | 'desc') => {
    const next = new URLSearchParams(qs);
    next.set(names.sort, key);
    next.set(names.dir, dir);
    if (query.trim()) next.set(names.query, query.trim()); else next.delete(names.query);
    next.delete(names.page);
    router.replace(`?${next.toString()}`, { scroll: false });
  };
  return { query, setQuery, sort };
}
