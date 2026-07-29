'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from './ui';

export type OrgListItem = {
  id: string;
  name: string;
  registrationNo: string | null;
  /**
   * The server-rendered CompanyPanel for this row, as it arrives ACROSS THE RSC BOUNDARY — which is why
   * this is `ReactNode` and not `ReactElement`, and why nothing here may introspect it.
   *
   * The Flight server serialises one "row" of the payload at a time and keeps a running byte count of the
   * strings it has written (`serializedSize`). The moment that count passes MAX_ROW_SIZE (3200) it stops
   * inlining elements and DEFERS each remaining one into its own row, emitting a `$L<id>` reference in its
   * place. The Flight client turns `$L` into `createLazyChunkWrapper(chunk)` — a React **lazy**
   * (`$$typeof: react.lazy`), not an element. React renders lazies transparently; `isValidElement` returns
   * false for them.
   *
   * This list is exactly the shape that trips it: one panel carries the whole company array, the state
   * catalog and twelve server-action references, so the FIRST row alone blows past 3200 and every row
   * after it arrives as a lazy. Code here used to read `it.node.props` and `cloneElement` it behind an
   * `isValidElement` guard, so rows 2..N silently became `null` — the card counted 8 companies and drew
   * one. Treat this as an opaque node: render it, never inspect it.
   */
  node: ReactNode;
};

/**
 * Thin client wrapper over the server-rendered CompanyPanel rows: adds ONLY a search box that filters the
 * list by legal name / registration number (modelled on the People search). No sort, no pagination, no card
 * grid. Every panel stays MOUNTED — non-matches are CSS-hidden rather than unmounted, so an in-progress
 * edit survives search typing. The `hidden` class goes on the <li> THIS component owns, so the panel node
 * itself is never touched (see OrgListItem.node). It operates strictly over these scoped company rows; it
 * never touches the group-structure tree or the parent-picker options (both rendered by the server page
 * from the full/unscoped company set).
 */
export function OrganizationList({ items }: { items: OrgListItem[] }) {
  const t = useTranslations('admin.organization');
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const matchIds = useMemo(() => {
    if (!q) return null; // null = no filter, everything shows
    return new Set(
      items
        .filter(
          (it) =>
            it.name.toLowerCase().includes(q) ||
            (it.registrationNo ?? '').toLowerCase().includes(q),
        )
        .map((it) => it.id),
    );
  }, [q, items]);

  const visibleCount = matchIds ? matchIds.size : items.length;

  return (
    <div>
      <div className="border-b border-border px-4 py-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchCompanies')}
          aria-label={t('searchCompanies')}
          className={inputCls}
        />
      </div>
      <ul className="divide-y divide-border">
        {items.map((it) => (
          <li key={it.id} className={matchIds && !matchIds.has(it.id) ? 'hidden' : undefined}>
            {it.node}
          </li>
        ))}
        {visibleCount === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noMatches')}</li>
        )}
      </ul>
    </div>
  );
}
