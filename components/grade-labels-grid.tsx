'use client';

/**
 * GradeLabelsGrid — the spreadsheet editor for GRADES on System Settings → System Label → Organisation
 * Labels (feedback b1b81a08). Grades are organisation-level master data (they set the seniority bands leave
 * entitlements, benefit schemes, claim limits and approval routing all read from), so they belong beside
 * Departments / Positions / Cost Centres / Business Units — not five levels deep inside Leave Config.
 *
 * Modelled on components/profile-options-grid.tsx, NOT on components/system-labels-grid.tsx. job_grade is
 * TENANT-GLOBAL: no company_id, no is_global, no label_company_assignment row. The company-scoped grid
 * assumes per-company rows plus a sharing junction throughout (scope cell, scope filter, company select,
 * copy-to-companies, sharing panel, per-row scope duplication…), so hosting grade there needed a synthetic
 * record mapper plus ~ten `kind === 'grade'` suppressions and still rendered a meaningless Criteria column.
 * ProfileOptionsGrid's header already describes job_grade verbatim — "a FLAT tenant-wide catalog with NO
 * company scope, NO sharing, and NO Criteria column" — so the rail swaps the BODY instead. (The Criteria
 * column below is a fixed read-only label, not that grid's editable scope cell; see the note on it.)
 *
 * A SIBLING of ProfileOptionsGrid rather than a reuse of it: Profile Options enforces value immutability
 * (Code is read-only once saved), whereas grade codes became editable in 728a7db6. That is a behavioural
 * divergence, not a cosmetic one, so ProfileOptionsGrid is left untouched.
 *
 * Columns are Code · Label · Description · Rank · Criteria · Status · Actions. Rank sorts NUMERICALLY (the
 * company grid's String(...).localeCompare would order 1, 10, 11, 2, 3).
 *
 * CRITERIA IS BACK, READ-ONLY (e3c733df round 2). The first round dropped it as "meaningless"; the reporter
 * asked for it again, "exactly like other category". On the four company-scoped kinds Criteria is NOT free
 * text — it is the SHARING SCOPE cell (a pill reading Global / Own company / N companies, opening the
 * company-assignment popover). Following it exactly for a tenant-global catalog therefore means rendering
 * that same pill at its one possible value: every grade applies to every company, so it reads "Global" and
 * has no popover to open. That is the honest column, and it needs no `criteria` field — the free-text slot
 * the reporter also asked for is Description, added in round 1 and sitting one column to the left. Two
 * free-text boxes for one idea would be the wrong outcome. NOTE this deliberately stops short of company
 * scope for grades: job_grade still has no company_id, no is_global and no assignment junction, and none of
 * the sharing wiring is imported here.
 *
 * Archive/restore batches into Save and is undoable via Discard, so it carries no confirm
 * dialog of its own; hard Delete keeps one, and is disabled with an explanatory tooltip when the grade is
 * still referenced by an employee, leave policy, approval rule, claim limit or grade group.
 *
 * All writes go through the server actions passed in from the page; each still appends its DomainEvent.
 */

import { useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronUp, Filter, Trash2, X } from 'lucide-react';
import { Button, ErrorBanner, StatusBadge, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from './ui';
import { ConfirmDialog } from './ui/confirm-submit';

/** Exactly the shape core/read.ts `listJobGrades` returns — no synthetic fields, no mapper. */
export type GradeGridRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rank: number;
  archivedAt: Date | null;
  inUse: boolean;
};

type RowState = {
  key: string; // stable client key (id for existing, draft-N for new)
  id: string;
  code: string;
  name: string;
  /** Held as '' rather than null while editing; the server collapses blank back to NULL on save. */
  description: string;
  /** Kept as text while editing so a half-typed / non-numeric rank round-trips to its own row error
   *  instead of being silently coerced to 0 on the way in. */
  rank: string;
  archived: boolean;
  inUse: boolean;
  isNew: boolean;
  dirty: boolean;
};

export type GradeGridActions = {
  save: (payload: {
    creates: { key: string; code: string; name: string; description: string; rank: string }[];
    updates: { key: string; id: string; code: string; name: string; description: string; rank: string; setArchived: boolean | null }[];
  }) => Promise<
    | { ok: true; created: number; updated: number; createdIds: { key: string; id: string }[] }
    | { ok: false; rowErrors: { key: string; field?: string; message: string }[]; message?: string }
  >;
  remove: (id: string) => Promise<{ ok: true } | { ok: false; message: string }>;
};

type SortField = 'code' | 'name' | 'rank' | 'archived';

function toRow(r: GradeGridRecord): RowState {
  return {
    key: r.id,
    id: r.id,
    code: r.code,
    name: r.name,
    // NULL renders as an empty box; the server turns blank back into NULL on save, so a description
    // nobody typed never round-trips as an empty string.
    description: r.description ?? '',
    rank: String(r.rank),
    archived: r.archivedAt != null,
    inUse: r.inUse,
    isNew: false,
    dirty: false,
  };
}

export function GradeLabelsGrid({ data, actions }: { data: GradeGridRecord[]; actions: GradeGridActions }) {
  const t = useTranslations('admin.systemLabels');
  const [rows, setRows] = useState<RowState[]>(() => data.map(toRow));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('active');
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState<SortField | null>('rank');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [rowErrors, setRowErrors] = useState<Record<string, { field?: string; message: string }>>({});
  // Split messaging (house pattern): errors stay persistent and in-page via the shared ErrorBanner until
  // resolved; success confirmations are the transient corner toast (sonner), same as the sibling grids.
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RowState | null>(null);
  const [pending, startTransition] = useTransition();
  const draftSeq = useRef(0);

  const drafts = rows.filter((r) => r.isNew);
  const dirtyExisting = rows.filter((r) => !r.isNew && r.dirty);
  const hasChanges = drafts.length > 0 || dirtyExisting.length > 0;
  const activeFilterCount = (search.trim() ? 1 : 0) + (statusFilter !== 'active' ? 1 : 0);

  function updateCell(key: string, field: 'code' | 'name' | 'description' | 'rank', value: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value, dirty: true } : r)));
  }
  function toggleArchive(key: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, archived: !r.archived, dirty: true } : r)));
  }
  function addRow() {
    draftSeq.current += 1;
    const nextRank = rows.reduce((m, r) => Math.max(m, Number(r.rank) || 0), -1) + 1;
    setRows((prev) => [
      ...prev,
      {
        key: `draft-${draftSeq.current}`,
        id: '',
        code: '',
        name: '',
        description: '',
        rank: String(nextRank),
        archived: false,
        inUse: false,
        isNew: true,
        dirty: true,
      },
    ]);
  }
  function removeDraft(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }
  function discard() {
    setRows(data.map(toRow));
    setRowErrors({});
    setError(null);
  }

  function deleteExisting(row: RowState) {
    setConfirmDelete(null);
    startTransition(async () => {
      const res = await actions.remove(row.id);
      if (res.ok) {
        setRows((prev) => prev.filter((r) => r.key !== row.key));
        setError(null);
      } else {
        setError(res.message);
      }
    });
  }

  function save() {
    setError(null);
    const creates = drafts.map((r) => ({
      key: r.key,
      code: r.code.trim(),
      name: r.name.trim(),
      description: r.description.trim(),
      rank: r.rank,
    }));
    const baseline = new Map(data.map((r) => [r.id, r]));
    const updates = dirtyExisting.map((r) => {
      const orig = baseline.get(r.id);
      const wasArchived = orig ? orig.archivedAt != null : r.archived;
      return {
        key: r.key,
        id: r.id,
        code: r.code.trim(),
        name: r.name.trim(),
        description: r.description.trim(),
        rank: r.rank,
        // Only send an archive flip when the row's status ACTUALLY changed, so a plain rename never emits
        // a spurious job-grade.archived / .unarchived event.
        setArchived: wasArchived !== r.archived ? r.archived : null,
      };
    });
    // No client-side required-field pre-check: cleanName already throws "Grade code is required" /
    // "Grade name is required" per row, the action turns that into a row error on the offending field, and
    // one authoritative message beats a duplicated (and translatable-drift-prone) client copy.
    const updatedKeys = new Set(updates.map((u) => u.key));
    startTransition(async () => {
      const res = await actions.save({ creates, updates });
      if (res.ok) {
        setRowErrors({});
        const idByKey = new Map(res.createdIds.map((c) => [c.key, c.id]));
        setRows((prev) =>
          prev.map((r) => {
            if (r.isNew) {
              const newId = idByKey.get(r.key);
              return newId ? { ...r, id: newId, key: newId, isNew: false, dirty: false } : r;
            }
            return updatedKeys.has(r.key) ? { ...r, dirty: false } : r;
          }),
        );
        toast.success(t('saved', { created: res.created, updated: res.updated }));
      } else {
        // Fan-out save: the GOOD rows already committed in their own transactions. Reconcile them so a
        // repeat Save cannot re-insert a created draft, and leave only the offending rows highlighted.
        const failed = new Set(res.rowErrors.map((e) => e.key));
        const map: Record<string, { field?: string; message: string }> = {};
        for (const e of res.rowErrors) map[e.key] = { field: e.field, message: e.message };
        setRowErrors(map);
        setRows((prev) =>
          prev.map((r) => (!r.isNew && updatedKeys.has(r.key) && !failed.has(r.key) ? { ...r, dirty: false } : r)),
        );
        setError(res.message ?? t('saveFailed'));
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
      if (statusFilter === 'active' && r.archived) return false;
      if (statusFilter === 'archived' && !r.archived) return false;
      if (search) {
        const hay = `${r.code} ${r.name}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
    if (sortField) {
      v = [...v].sort((a, b) => {
        // Rank is the seniority ORDER, so it sorts as a number — 2 before 10. A localeCompare here (what
        // the company-scoped grid does for every column) would order 1, 10, 11, 2, 3.
        if (sortField === 'rank') {
          const an = Number(a.rank);
          const bn = Number(b.rank);
          const av = Number.isFinite(an) ? an : Number.POSITIVE_INFINITY;
          const bv = Number.isFinite(bn) ? bn : Number.POSITIVE_INFINITY;
          return sortDir === 'asc' ? av - bv : bv - av;
        }
        if (sortField === 'archived') {
          return sortDir === 'asc'
            ? Number(a.archived) - Number(b.archived)
            : Number(b.archived) - Number(a.archived);
        }
        const av = String(a[sortField] ?? '').toLowerCase();
        const bv = String(b[sortField] ?? '').toLowerCase();
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return v;
  }, [rows, statusFilter, search, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  const sortableThCls = `${thCls} cursor-pointer select-none hover:text-foreground`;
  const cellInput = `${inputCls} h-8`;
  const sortIcon = (field: SortField) =>
    sortField === field ? (
      sortDir === 'asc' ? (
        <ArrowUp className="ml-1 inline size-3.5" aria-hidden />
      ) : (
        <ArrowDown className="ml-1 inline size-3.5" aria-hidden />
      )
    ) : null;

  return (
    <div className="min-w-0 flex-1 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
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
          <Filter className="size-3.5" aria-hidden />
          {t('filter')}
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">
              {activeFilterCount}
            </span>
          )}
          {showFilters ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            {t('addRow')}
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={!hasChanges || pending}>
            {t('saveAll')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={discard} disabled={!hasChanges || pending}>
            {t('discard')}
          </Button>
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
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className={`${inputCls} h-8 w-auto`}
          >
            <option value="active">{t('filterActive')}</option>
            <option value="archived">{t('filterArchived')}</option>
            <option value="all">{t('filterAllStatus')}</option>
          </select>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setStatusFilter('active');
              }}
              className="inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {t('clearFilters')}
            </button>
          )}
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {hasChanges && <p className="text-xs text-amber-600 dark:text-amber-400">{t('unsavedChanges')}</p>}

      <div className={tableWrapCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}>
            <tr>
              <th className="w-8 px-2 py-2"></th>
              <th className={sortableThCls} onClick={() => toggleSort('code')}>
                {t('col.code')} *{sortIcon('code')}
              </th>
              {/* "Label", not "Grade Name" (e3c733df) — the other System Label categories call the
                  human-readable name Label, and this table is being standardised to match them. The
                  COLUMN is renamed; the stored field stays `name`, which employees, leave policies,
                  approval rules, claim limits and grade groups all reference. */}
              <th className={sortableThCls} onClick={() => toggleSort('name')}>
                {t('col.label')} *{sortIcon('name')}
              </th>
              {/* New optional detail column, mirroring Profile Options. Not sortable: it is free text
                  nobody orders a grade list by, and a sortable header would imply otherwise. */}
              <th className={thCls}>{t('col.description')}</th>
              <th className={`${sortableThCls} w-20`} onClick={() => toggleSort('rank')}>
                {t('col.rank')}
                {sortIcon('rank')}
              </th>
              {/* Criteria, restored beside Rank (e3c733df round 2). Not sortable: it reads the same on
                  every row, so a sort affordance would promise an ordering that does not exist. */}
              <th className={thCls}>{t('col.scope')}</th>
              <th className={sortableThCls} onClick={() => toggleSort('archived')}>
                {t('col.status')}
                {sortIcon('archived')}
              </th>
              <th className={`${thCls} text-right`}>{t('col.actions')}</th>
            </tr>
          </thead>
          <tbody className={tbodyCls}>
            {view.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t('noRows')}
                </td>
              </tr>
            )}
            {view.map((r, rowIdx) => {
              const err = rowErrors[r.key];
              return (
                <tr key={r.key} className={`${r.archived ? 'opacity-60' : ''} ${err ? 'bg-destructive/5' : ''}`}>
                  <td className="px-2 py-1.5"></td>
                  <td className="px-3 py-1.5">
                    {/* 728a7db6 made grade codes editable, so unlike Profile Options the Code cell stays
                        an input after the row is saved. */}
                    <input
                      data-cell={`code:${rowIdx}`}
                      value={r.code}
                      onChange={(e) => updateCell(r.key, 'code', e.target.value)}
                      onKeyDown={(e) => onCellKey(e, rowIdx, 'code')}
                      title={err && err.field === 'code' ? err.message : r.code}
                      className={`${cellInput} w-full min-w-0 font-mono text-xs uppercase ${
                        err?.field === 'code' ? 'border-destructive' : ''
                      }`}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      data-cell={`name:${rowIdx}`}
                      value={r.name}
                      onChange={(e) => updateCell(r.key, 'name', e.target.value)}
                      onKeyDown={(e) => onCellKey(e, rowIdx, 'name')}
                      title={err && err.field === 'name' ? err.message : r.name}
                      className={`${cellInput} w-full min-w-0 ${err?.field === 'name' ? 'border-destructive' : ''}`}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    {/* Optional (e3c733df) — no `*`, and no row error can land on it: it is free text with
                        no format, no uniqueness and no downstream reader. */}
                    <input
                      data-cell={`description:${rowIdx}`}
                      value={r.description}
                      onChange={(e) => updateCell(r.key, 'description', e.target.value)}
                      onKeyDown={(e) => onCellKey(e, rowIdx, 'description')}
                      title={r.description}
                      className={`${cellInput} w-full min-w-0`}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      data-cell={`rank:${rowIdx}`}
                      value={r.rank}
                      onChange={(e) => updateCell(r.key, 'rank', e.target.value)}
                      onKeyDown={(e) => onCellKey(e, rowIdx, 'rank')}
                      aria-label={t('col.rank')}
                      title={err && err.field === 'rank' ? err.message : undefined}
                      className={`${cellInput} w-16 tabular-nums ${err?.field === 'rank' ? 'border-destructive' : ''}`}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    {/* Same pill the company-scoped kinds show for a global row, minus the chevron — there
                        is no per-company assignment to open, so a clickable control would be a dead end.
                        Rendered for drafts too: a grade is tenant-wide the moment it exists, so unlike the
                        company grid there is nothing to "save first" before the scope is known. */}
                    <span
                      title={t('assignmentAll')}
                      className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                    >
                      {t('scopeGlobal')}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <StatusBadge
                      status={r.archived ? 'archived' : 'active'}
                      label={r.archived ? t('statusArchived') : t('statusActive')}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <div className="inline-flex gap-1">
                      {r.isNew ? (
                        <RowIconButton title={t('deleteRow')} onClick={() => removeDraft(r.key)}>
                          <X className="size-3.5" aria-hidden />
                        </RowIconButton>
                      ) : (
                        <>
                          {/* Archive/restore batches into Save (undoable via Discard), so no confirm here. */}
                          <RowIconButton
                            title={r.archived ? t('unarchive') : t('archive')}
                            onClick={() => toggleArchive(r.key)}
                          >
                            {r.archived ? (
                              <ArchiveRestore className="size-3.5" aria-hidden />
                            ) : (
                              <Trash2 className="size-3.5" aria-hidden />
                            )}
                          </RowIconButton>
                          <RowIconButton
                            title={r.inUse ? t('gradeInUseHint') : t('deleteRow')}
                            disabled={r.inUse}
                            onClick={() => setConfirmDelete(r)}
                          >
                            <X className="size-3.5" aria-hidden />
                          </RowIconButton>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={t('deleteGradeTitle')}
          description={t('deleteGradeDescription', { name: confirmDelete.name || confirmDelete.code })}
          confirmLabel={t('deleteRow')}
          onConfirm={() => deleteExisting(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

// Toolbar buttons use the shared <Button> primitive. Row actions keep this local size-7 icon button:
// Button's `size="icon"` is 36px (breaks the h-8 row rhythm) and its disabled:pointer-events-none would
// suppress the explanatory title tooltip on the disabled in-use Delete.
function RowIconButton({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
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
