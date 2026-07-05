'use client';

import { cloneElement, isValidElement, useMemo, useState, type ReactElement } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from './ui';

export type OrgListItem = {
  id: string;
  name: string;
  registrationNo: string | null;
  // The already-server-rendered CompanyPanel, which itself renders the <li> row. We clone it to toggle a
  // `hidden` class rather than unmounting, so a mid-edit panel survives typing in the search box.
  node: ReactElement<{ className?: string }>;
};

/**
 * Thin client wrapper over the server-rendered CompanyPanel rows: adds ONLY a search box that filters the
 * list by legal name / registration number (modelled on the People search). No sort, no pagination, no card
 * grid. Every panel stays MOUNTED — non-matches are CSS-hidden via a cloned `hidden` class rather than
 * unmounted, so an in-progress edit survives search typing. It operates strictly over these scoped company
 * rows; it never touches the group-structure tree or the parent-picker options (both rendered by the server
 * page from the full/unscoped company set).
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
        {items.map((it) => {
          const hidden = matchIds ? !matchIds.has(it.id) : false;
          return isValidElement(it.node)
            ? cloneElement(it.node, {
                key: it.id,
                className: hidden ? 'hidden' : it.node.props.className,
              })
            : null;
        })}
        {visibleCount === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noMatches')}</li>
        )}
      </ul>
    </div>
  );
}
