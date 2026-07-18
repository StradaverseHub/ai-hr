'use client';

/**
 * ProfileOptionsGrid — the Excel-style master-data editor for Profile Options (feedback 15277676).
 *
 * Replaces the old stack of one Card+table per category (which grew unbounded and forced heavy scrolling)
 * with ONE spreadsheet surface: a left rail of the option categories (Religion / Race / Nationality / … /
 * the org-assignment lists) and a main editable grid for the selected category. Inline cell editing (no
 * pop-ups), add rows, keyboard navigation (Enter / arrows), client-side search + status filter + column
 * sort, sticky header, per-row activate/deactivate + delete, and ONE atomic Save that batches every create
 * and update.
 *
 * DELIBERATELY simpler than components/system-labels-grid.tsx: Profile Options is a FLAT tenant-wide catalog
 * with NO company scope, NO sharing, and NO Criteria column (see core/profile-options.ts). The value-
 * immutability rule is preserved — Code is editable only on brand-new draft rows and read-only once saved.
 *
 * All writes go through the server actions passed in from the page; each still appends its DomainEvent.
 */

import { useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from './ui';
import { ConfirmDialog } from './ui/confirm-submit';

export type ProfileGridCategory = string;

export type ProfileGridRecord = {
  id: string;
  category: ProfileGridCategory;
  value: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

type RowState = {
  key: string; // stable client key (id for existing, draft-N for new)
  id: string;
  value: string;
  label: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
  isNew: boolean;
  dirty: boolean;
};

export type ProfileGridActions = {
  save: (payload: {
    creates: { key: string; category: string; value: string; label: string; description: string; sortOrder: number }[];
    updates: { key: string; id: string; label: string; description: string; sortOrder: number; setActive: boolean | null }[];
  }) => Promise<
    | { ok: true; created: number; updated: number; createdIds: { key: string; id: string }[] }
    | { ok: false; rowErrors: { key: string; message: string }[]; message?: string }
  >;
  remove: (id: string) => Promise<{ ok: true } | { ok: false; message: string }>;
};

function toRow(r: ProfileGridRecord): RowState {
  return {
    key: r.id,
    id: r.id,
    value: r.value,
    label: r.label,
    description: r.description ?? '',
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    isNew: false,
    dirty: false,
  };
}

export function ProfileOptionsGrid({
  categories,
  data,
  actions,
}: {
  categories: ProfileGridCategory[];
  data: Record<string, ProfileGridRecord[]>;
  actions: ProfileGridActions;
}) {
  const t = useTranslations('admin.profileOptions');
  const [category, setCategory] = useState<ProfileGridCategory>(categories[0]);
  const [rowsByCat, setRowsByCat] = useState<Record<string, RowState[]>>(() => {
    const seed: Record<string, RowState[]> = {};
    for (const c of categories) seed[c] = (data[c] ?? []).map(toRow);
    return seed;
  });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState<'value' | 'label' | 'description' | 'sortOrder' | 'isActive' | null>('sortOrder');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RowState | null>(null);
  const [pending, startTransition] = useTransition();
  const draftSeq = useRef(0);

  const rows = rowsByCat[category] ?? [];

  const drafts = rows.filter((r) => r.isNew);
  const dirtyExisting = rows.filter((r) => !r.isNew && r.dirty);
  const hasChanges = drafts.length > 0 || dirtyExisting.length > 0;
  const activeFilterCount = (search.trim() ? 1 : 0) + (statusFilter !== 'all' ? 1 : 0);

  function patchRows(next: RowState[]) {
    setRowsByCat((prev) => ({ ...prev, [category]: next }));
  }
  function updateCell(key: string, field: 'value' | 'label' | 'description' | 'sortOrder', value: string) {
    patchRows(
      rows.map((r) =>
        r.key === key ? { ...r, [field]: field === 'sortOrder' ? Number(value || 0) : value, dirty: true } : r,
      ),
    );
  }
  function toggleActive(key: string) {
    patchRows(rows.map((r) => (r.key === key ? { ...r, isActive: !r.isActive, dirty: true } : r)));
  }
  function addRow() {
    draftSeq.current += 1;
    const nextSort = rows.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
    patchRows([
      ...rows,
      {
        key: `draft-${draftSeq.current}`,
        id: '',
        value: '',
        label: '',
        description: '',
        sortOrder: nextSort,
        isActive: true,
        isNew: true,
        dirty: true,
      },
    ]);
  }
  function removeDraft(key: string) {
    patchRows(rows.filter((r) => r.key !== key));
  }
  function discard() {
    patchRows((data[category] ?? []).map(toRow));
    setRowErrors({});
    setBanner(null);
  }

  function deleteExisting(row: RowState) {
    setConfirmDelete(null);
    startTransition(async () => {
      const res = await actions.remove(row.id);
      if (res.ok) {
        // Drop it from BOTH the working set and the pristine baseline so a later Discard can't resurrect it.
        setRowsByCat((prev) => ({ ...prev, [category]: (prev[category] ?? []).filter((r) => r.key !== row.key) }));
        setBanner(null);
      } else {
        setBanner({ kind: 'err', text: res.message });
      }
    });
  }

  function save() {
    setBanner(null);
    const cat = category;
    const creates = drafts.map((r) => ({
      key: r.key,
      category: cat,
      value: r.value.trim(),
      label: r.label.trim(),
      description: r.description.trim(),
      sortOrder: r.sortOrder,
    }));
    const baseline = new Map((data[cat] ?? []).map((r) => [r.id, r]));
    const updates = dirtyExisting.map((r) => {
      const orig = baseline.get(r.id);
      return {
        key: r.key,
        id: r.id,
        label: r.label.trim(),
        description: r.description.trim(),
        sortOrder: r.sortOrder,
        setActive: orig && orig.isActive !== r.isActive ? r.isActive : null,
      };
    });
    // Client-side guard so an empty required cell fails fast with a highlight rather than a server round-trip.
    const localErrors: Record<string, string> = {};
    for (const c of creates) if (!c.value) localErrors[c.key] = t('valueRequired');
    for (const u of updates) if (!u.label) localErrors[u.key] = t('labelRequired');
    if (Object.keys(localErrors).length > 0) {
      setRowErrors(localErrors);
      setBanner({ kind: 'err', text: t('saveFailed') });
      return;
    }
    const updatedKeys = new Set(updates.map((u) => u.key));
    startTransition(async () => {
      const res = await actions.save({ creates, updates });
      if (res.ok) {
        setRowErrors({});
        const idByKey = new Map(res.createdIds.map((c) => [c.key, c.id]));
        setRowsByCat((prev) => ({
          ...prev,
          [cat]: (prev[cat] ?? []).map((r) => {
            if (r.isNew) {
              const newId = idByKey.get(r.key);
              return newId ? { ...r, id: newId, key: newId, isNew: false, dirty: false } : r;
            }
            return updatedKeys.has(r.key) ? { ...r, dirty: false } : r;
          }),
        }));
        setBanner({ kind: 'ok', text: t('saved', { created: res.created, updated: res.updated }) });
      } else {
        const map: Record<string, string> = {};
        for (const e of res.rowErrors) map[e.key] = e.message;
        setRowErrors(map);
        setBanner({ kind: 'err', text: res.message ?? t('saveFailed') });
      }
    });
  }

  function onCellKey(e: React.KeyboardEvent<HTMLInputElement>, rowIdx: number, field: string) {
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const target = document.querySelector<HTMLInputElement>(`[data-cell="${field}:${rowIdx + dir}"]`);
      if (target) {
        e.preventDefault();
        target.focus();
        target.select();
      }
    }
  }

  const view = useMemo(() => {
    let v = rows.filter((r) => {
      if (statusFilter === 'active' && !r.isActive) return false;
      if (statusFilter === 'inactive' && r.isActive) return false;
      if (search) {
        const hay = `${r.value} ${r.label} ${r.description}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
    if (sortField) {
      v = [...v].sort((a, b) => {
        if (sortField === 'sortOrder') return sortDir === 'asc' ? a.sortOrder - b.sortOrder : b.sortOrder - a.sortOrder;
        if (sortField === 'isActive') return sortDir === 'asc' ? Number(a.isActive) - Number(b.isActive) : Number(b.isActive) - Number(a.isActive);
        const av = String(a[sortField] ?? '').toLowerCase();
        const bv = String(b[sortField] ?? '').toLowerCase();
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return v;
  }, [rows, statusFilter, search, sortField, sortDir]);

  function toggleSort(field: typeof sortField) {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const k of categories) c[k] = (rowsByCat[k] ?? []).filter((r) => r.isActive).length;
    return c;
  }, [rowsByCat, categories]);

  const headerCls = 'cursor-pointer select-none px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground';
  const cellInput = `${inputCls} h-8`;
  const sortMark = (f: typeof sortField) => (sortField === f ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Left rail: categories */}
      <nav className="shrink-0 lg:w-52">
        <div className="rounded-xl border border-border bg-card p-2">
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('categoriesHeading')}</div>
          <ul className="mt-1 max-h-[60vh] space-y-0.5 overflow-y-auto">
            {categories.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => {
                    setCategory(k);
                    setRowErrors({});
                    setBanner(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                    category === k ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span>{t(`category.${k}`)}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">{counts[k]}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Main grid */}
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t(`category.${category}`)}</h2>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition ${
              showFilters || activeFilterCount > 0
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-input hover:bg-accent hover:text-accent-foreground'
            }`}
          >
            {t('filter')}
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">{activeFilterCount}</span>
            )}
            <span aria-hidden>{showFilters ? '▴' : '▾'}</span>
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ToolbarButton onClick={addRow}>{t('addRow')}</ToolbarButton>
            <button
              type="button"
              onClick={save}
              disabled={!hasChanges || pending}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              {t('saveAll')}
            </button>
            <ToolbarButton onClick={discard} disabled={!hasChanges || pending}>
              {t('discard')}
            </ToolbarButton>
          </div>
        </div>

        {showFilters && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 p-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className={`${inputCls} h-8 w-44`}
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className={`${inputCls} h-8 w-auto`}>
              <option value="all">{t('filterAll')}</option>
              <option value="active">{t('filterActive')}</option>
              <option value="inactive">{t('filterInactive')}</option>
            </select>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setStatusFilter('all');
                }}
                className="inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {t('clearFilters')}
              </button>
            )}
          </div>
        )}

        {banner && (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              banner.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'
            }`}
          >
            {banner.text}
          </div>
        )}
        {hasChanges && <p className="text-xs text-amber-600 dark:text-amber-400">{t('unsavedChanges')}</p>}

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-muted/40 backdrop-blur">
              <tr>
                <th className={headerCls} onClick={() => toggleSort('value')}>
                  {t('col.code')}
                  {sortMark('value')}
                </th>
                <th className={headerCls} onClick={() => toggleSort('label')}>
                  {t('col.label')} *{sortMark('label')}
                </th>
                <th className={headerCls} onClick={() => toggleSort('description')}>
                  {t('col.description')}
                  {sortMark('description')}
                </th>
                <th className={`${headerCls} w-20`} onClick={() => toggleSort('sortOrder')}>
                  {t('sortOrderLabel')}
                  {sortMark('sortOrder')}
                </th>
                <th className={headerCls} onClick={() => toggleSort('isActive')}>
                  {t('col.status')}
                  {sortMark('isActive')}
                </th>
                <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {view.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t('noRows')}
                  </td>
                </tr>
              )}
              {view.map((r, rowIdx) => {
                const err = rowErrors[r.key];
                return (
                  <tr key={r.key} className={`border-t border-border/60 ${r.isActive ? '' : 'opacity-60'} ${err ? 'bg-destructive/5' : ''}`}>
                    {/* Code = immutable value; editable only while the row is a new draft. */}
                    <td className="px-1.5 py-1">
                      {r.isNew ? (
                        <input
                          data-cell={`value:${rowIdx}`}
                          value={r.value}
                          onChange={(e) => updateCell(r.key, 'value', e.target.value)}
                          onKeyDown={(e) => onCellKey(e, rowIdx, 'value')}
                          placeholder={t('valuePlaceholder')}
                          className={`${cellInput} w-full min-w-0 font-mono text-xs ${err ? 'border-destructive' : ''}`}
                        />
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground" title={t('codeImmutableHint')}>
                          {r.value}
                        </span>
                      )}
                    </td>
                    <td className="px-1.5 py-1">
                      <input
                        data-cell={`label:${rowIdx}`}
                        value={r.label}
                        onChange={(e) => updateCell(r.key, 'label', e.target.value)}
                        onKeyDown={(e) => onCellKey(e, rowIdx, 'label')}
                        placeholder={t('labelPlaceholder')}
                        className={`${cellInput} w-full min-w-0 ${err ? 'border-destructive' : ''}`}
                      />
                    </td>
                    <td className="px-1.5 py-1">
                      <input
                        data-cell={`description:${rowIdx}`}
                        value={r.description}
                        onChange={(e) => updateCell(r.key, 'description', e.target.value)}
                        onKeyDown={(e) => onCellKey(e, rowIdx, 'description')}
                        placeholder={t('descriptionPlaceholder')}
                        className={`${cellInput} w-full min-w-0`}
                      />
                    </td>
                    <td className="px-1.5 py-1">
                      <input
                        data-cell={`sortOrder:${rowIdx}`}
                        type="number"
                        step="1"
                        value={r.sortOrder}
                        onChange={(e) => updateCell(r.key, 'sortOrder', e.target.value)}
                        onKeyDown={(e) => onCellKey(e, rowIdx, 'sortOrder')}
                        aria-label={t('sortOrderLabel')}
                        className={`${cellInput} w-16`}
                      />
                    </td>
                    <td className="px-1.5 py-1">
                      <button
                        type="button"
                        onClick={() => toggleActive(r.key)}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          r.isActive
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground'
                        }`}
                        title={r.isActive ? t('deactivate') : t('activate')}
                      >
                        {r.isActive ? t('statusActive') : t('statusInactive')}
                      </button>
                    </td>
                    <td className="px-1.5 py-1 text-right">
                      {r.isNew ? (
                        <RowIconButton title={t('delete')} onClick={() => removeDraft(r.key)}>
                          ✕
                        </RowIconButton>
                      ) : (
                        <RowIconButton title={t('delete')} onClick={() => setConfirmDelete(r)}>
                          🗑
                        </RowIconButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">{t('legacyNote')}</p>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={t('deleteTitle')}
          description={t('deleteDescription', { value: confirmDelete.value })}
          confirmLabel={t('delete')}
          onConfirm={() => deleteExisting(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function ToolbarButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center rounded-md border border-input px-3 text-sm font-medium transition hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function RowIconButton({ children, title, onClick, disabled }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex size-7 items-center justify-center rounded-md border border-input text-xs transition hover:bg-accent disabled:opacity-40"
    >
      {children}
    </button>
  );
}
