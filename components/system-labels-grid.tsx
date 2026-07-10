'use client';

/**
 * SystemLabelsGrid — the Excel-style master-data editor for System Labels (feedback 62de487d).
 *
 * Replaces the per-company expandable panels with ONE spreadsheet surface: a left rail of the four label
 * categories (Departments / Positions / Cost Centres / Business Units) and a main editable grid for the
 * selected category. Inline cell editing (no pop-ups), add / duplicate / delete-or-archive rows, multi-row
 * paste from a real spreadsheet, keyboard navigation (Tab / Enter / arrows), client-side search / column
 * sort / status + scope filters, ONE atomic Save (all creates + updates in a single transaction with
 * per-row validation highlighting), a Scope cell (Global / company-specific), a "Copy to companies" bulk
 * action, per-company sharing toggles, and CSV export. Import is deferred (the reporter marked it future).
 *
 * All writes go through server actions passed in from the page; scope changes (Global / assign / unassign)
 * fire immediately (a saved row must exist first), while text edits + new rows batch into Save.
 */

import { useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from './ui';

export type GridKind = 'department' | 'position' | 'cost_center' | 'business_unit';

export type GridCompany = { id: string; name: string; sharedSystemLabels: boolean };

/** A normalized label record — the page maps each kind's rows into this shape. */
export type GridRecord = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  title: string;
  jobFamily: string;
  // 797e3523: optional short code / abbreviation.
  label: string;
  businessUnitId: string | null;
  // 6fadb036: the department / business-unit head an approval `department_head` / `business_unit_head`
  // step routes to (nullable). Only meaningful for the department + business_unit kinds.
  headEmploymentId: string | null;
  description: string;
  isGlobal: boolean;
  archived: boolean;
  inUse: boolean;
  assignedCompanyIds: string[];
  createdAt: string | null;
  lastUpdatedAt: string | null;
  lastUpdatedBy: string | null;
};

type RowState = GridRecord & {
  key: string; // stable client key (id for existing, draft-N for new)
  isNew: boolean;
  dirty: boolean;
};

export type GridActions = {
  save: (
    kind: GridKind,
    payload: {
      creates: {
        key: string;
        companyId: string;
        isGlobal?: boolean;
        code?: string;
        name?: string;
        title?: string;
        jobFamily?: string;
        businessUnitId?: string | null;
        headEmploymentId?: string | null;
        label?: string;
        description?: string;
      }[];
      updates: {
        key: string;
        id: string;
        isGlobal?: boolean;
        archived?: boolean;
        code?: string;
        name?: string;
        title?: string;
        jobFamily?: string;
        businessUnitId?: string | null;
        headEmploymentId?: string | null;
        label?: string;
        description?: string;
      }[];
    },
  ) => Promise<{ ok: true; created: number; updated: number; createdIds: { key: string; id: string }[] } | { ok: false; rowErrors: { key: string; field?: string; message: string }[]; message?: string }>;
  setGlobal: (kind: GridKind, labelId: string, isGlobal: boolean) => Promise<{ ok: true } | { ok: false; message: string }>;
  assign: (kind: GridKind, labelId: string, companyIds: string[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  unassign: (kind: GridKind, labelId: string, companyIds: string[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  copyToCompanies: (kind: GridKind, labelIds: string[], companyIds: string[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  setCompanyShared: (companyId: string, enabled: boolean) => Promise<{ ok: true } | { ok: false; message: string }>;
};

// 797e3523: the visible category rail. Business Unit is intentionally NOT listed — it was removed from the
// System Labels surface per the reporter (existing BU records + department→BU links are untouched in the DB;
// the backend `business_unit` kind still exists and is consumed elsewhere). GridKind keeps 'business_unit'
// for backend/type parity, but no tab renders it here.
const KINDS: GridKind[] = ['department', 'position', 'cost_center'];

// Editable text columns per kind (field key + whether required). Business-unit link + criteria/status
// columns are rendered specially, not from this list. 797e3523: every kind carries an optional `label`
// short-code column.
const TEXT_COLS: Record<GridKind, { field: keyof GridRecord; required?: boolean }[]> = {
  department: [{ field: 'name', required: true }, { field: 'label' }, { field: 'description' }],
  position: [{ field: 'title', required: true }, { field: 'label' }, { field: 'jobFamily' }, { field: 'description' }],
  cost_center: [{ field: 'code', required: true }, { field: 'name', required: true }, { field: 'label' }, { field: 'description' }],
  business_unit: [{ field: 'code', required: true }, { field: 'name', required: true }, { field: 'label' }, { field: 'description' }],
};

function emptyDraft(key: string, companyId: string, isGlobal: boolean): RowState {
  return {
    key,
    id: '',
    companyId,
    code: '',
    name: '',
    title: '',
    jobFamily: '',
    label: '',
    businessUnitId: null,
    headEmploymentId: null,
    description: '',
    isGlobal,
    archived: false,
    inUse: false,
    assignedCompanyIds: [],
    createdAt: null,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
    isNew: true,
    dirty: true,
  };
}

export function SystemLabelsGrid({
  data,
  companies,
  buByCompany,
  isGroupAdmin,
  actions,
}: {
  data: Record<GridKind, GridRecord[]>;
  companies: GridCompany[];
  /** Active business units per company, for the department BU-link select. */
  buByCompany: Record<string, { id: string; label: string }[]>;
  isGroupAdmin: boolean;
  actions: GridActions;
}) {
  const t = useTranslations('admin.systemLabels');
  const [kind, setKind] = useState<GridKind>('department');
  const [rowsByKind, setRowsByKind] = useState<Record<GridKind, RowState[]>>(() => {
    const seed = {} as Record<GridKind, RowState[]>;
    for (const k of KINDS) seed[k] = data[k].map((r) => ({ ...r, key: r.id, isNew: false, dirty: false }));
    return seed;
  });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('active');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'global' | 'company'>('all');
  // 797e3523: filters live behind a collapsible panel, hidden by default for a cleaner surface.
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState<keyof GridRecord | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [rowErrors, setRowErrors] = useState<Record<string, { field?: string; message: string }>>({});
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newRowCompany, setNewRowCompany] = useState(companies[0]?.id ?? '');
  const [scopePopover, setScopePopover] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [showSharing, setShowSharing] = useState(false);
  const [pending, startTransition] = useTransition();
  const draftSeq = useRef(0);

  const rows = rowsByKind[kind];
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);

  const dirtyExisting = rows.filter((r) => !r.isNew && r.dirty);
  const drafts = rows.filter((r) => r.isNew);
  const hasChanges = dirtyExisting.length > 0 || drafts.length > 0;
  // 797e3523: how many filters diverge from their defaults — badges the Filter button so a collapsed
  // panel never silently hides rows.
  const activeFilterCount = (search.trim() ? 1 : 0) + (statusFilter !== 'active' ? 1 : 0) + (scopeFilter !== 'all' ? 1 : 0);

  function patchRows(next: RowState[]) {
    setRowsByKind((prev) => ({ ...prev, [kind]: next }));
  }
  function updateCell(key: string, field: keyof GridRecord, value: string | boolean | null) {
    patchRows(rows.map((r) => (r.key === key ? { ...r, [field]: value, dirty: true } : r)));
  }
  function addRow() {
    if (!newRowCompany) return;
    draftSeq.current += 1;
    patchRows([...rows, emptyDraft(`draft-${draftSeq.current}`, newRowCompany, isGroupAdmin)]);
  }
  function duplicateRow(src: RowState) {
    draftSeq.current += 1;
    patchRows([
      ...rows,
      { ...emptyDraft(`draft-${draftSeq.current}`, src.companyId, src.isGlobal), code: src.code, name: src.name, title: src.title, jobFamily: src.jobFamily, label: src.label, businessUnitId: src.businessUnitId, headEmploymentId: src.headEmploymentId, description: src.description },
    ]);
  }
  function removeDraft(key: string) {
    patchRows(rows.filter((r) => r.key !== key));
  }
  function toggleArchive(key: string) {
    patchRows(rows.map((r) => (r.key === key ? { ...r, archived: !r.archived, dirty: true } : r)));
  }

  function discard() {
    patchRows(data[kind].map((r) => ({ ...r, key: r.id, isNew: false, dirty: false })));
    setRowErrors({});
    setBanner(null);
  }

  function save() {
    setBanner(null);
    const k = kind; // capture: the async result must reconcile the kind that was saved.
    const creates = drafts.map((r) => ({
      key: r.key,
      companyId: r.companyId,
      isGlobal: r.isGlobal,
      code: r.code,
      name: r.name,
      title: r.title,
      jobFamily: r.jobFamily,
      label: r.label,
      businessUnitId: r.businessUnitId,
      // 797e3523: the Head column was removed from this surface, but the loaded value is preserved and
      // re-sent unchanged so a save never clears an approval-routing head that lives on the record.
      headEmploymentId: r.headEmploymentId,
      description: r.description,
    }));
    // NB: scope (isGlobal) is NEVER sent from a text-edit Save — it is owned exclusively by the
    // dedicated scope popover (toggleGlobal / applyCompanies), which persists immediately. Sending
    // the row's (possibly stale) isGlobal here would let a later edit+Save silently revert a label
    // that was made Global via the popover. Only text/BU/archive fields flow through Save.
    const updates = dirtyExisting.map((r) => ({
      key: r.key,
      id: r.id,
      archived: r.archived,
      code: r.code,
      name: r.name,
      title: r.title,
      jobFamily: r.jobFamily,
      label: r.label,
      businessUnitId: r.businessUnitId,
      // 797e3523: Head removed from the UI; re-send the loaded value unchanged so a text edit never
      // clears an approval-routing head stored on the department / business-unit record.
      headEmploymentId: r.headEmploymentId,
      description: r.description,
    }));
    const updatedKeys = new Set(updates.map((u) => u.key));
    startTransition(async () => {
      const res = await actions.save(k, { creates, updates });
      if (res.ok) {
        setRowErrors({});
        // Reconcile local state so a repeat Save can't re-insert the drafts or re-fire updates:
        // convert each saved draft into a persisted (clean) row using the returned server id, and
        // clear the dirty flag on every row that was updated.
        const idByKey = new Map(res.createdIds.map((c) => [c.key, c.id]));
        setRowsByKind((prev) => ({
          ...prev,
          [k]: prev[k].map((r) => {
            if (r.isNew) {
              const newId = idByKey.get(r.key);
              return newId ? { ...r, id: newId, key: newId, isNew: false, dirty: false } : r;
            }
            return updatedKeys.has(r.key) ? { ...r, dirty: false } : r;
          }),
        }));
        setBanner({ kind: 'ok', text: t('saved', { created: res.created, updated: res.updated }) });
      } else {
        const map: Record<string, { field?: string; message: string }> = {};
        for (const e of res.rowErrors) map[e.key] = { field: e.field, message: e.message };
        setRowErrors(map);
        setBanner({ kind: 'err', text: res.message ?? t('saveFailed') });
      }
    });
  }

  // Scope changes fire immediately against the server (row must already exist).
  function runScope(fn: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setBanner({ kind: 'err', text: r.message });
      else setBanner(null);
    });
  }
  // Patch a persisted row's fields WITHOUT marking it dirty — scope edits are already committed on the
  // server, so they must never re-enter the pending Save payload. Keyed by kind so the async result
  // lands on the right category even if `kind` changed meanwhile.
  function patchRowClean(k: GridKind, key: string, fields: Partial<RowState>) {
    setRowsByKind((prev) => ({ ...prev, [k]: prev[k].map((r) => (r.key === key ? { ...r, ...fields } : r)) }));
  }
  function toggleGlobal(r: RowState) {
    const k = kind;
    const next = !r.isGlobal;
    startTransition(async () => {
      const res = await actions.setGlobal(k, r.id, next);
      if (!res.ok) {
        setBanner({ kind: 'err', text: res.message });
        return;
      }
      setBanner(null);
      // Reflect the new scope locally so the Scope pill updates immediately (revalidatePath does not
      // re-seed the grid) and a later text-edit Save reads the correct isGlobal.
      patchRowClean(k, r.key, { isGlobal: next });
    });
  }
  function applyCompanies(r: RowState, nextIds: string[]) {
    const k = kind;
    const cur = new Set(r.assignedCompanyIds);
    const next = new Set(nextIds);
    const toAssign = nextIds.filter((id) => !cur.has(id));
    const toRemove = r.assignedCompanyIds.filter((id) => !next.has(id));
    startTransition(async () => {
      if (toAssign.length) {
        const a = await actions.assign(k, r.id, toAssign);
        if (!a.ok) return setBanner({ kind: 'err', text: a.message });
      }
      if (toRemove.length) {
        const u = await actions.unassign(k, r.id, toRemove);
        if (!u.ok) return setBanner({ kind: 'err', text: u.message });
      }
      setBanner(null);
      setScopePopover(null);
      // Reflect the new company assignments locally so the Scope pill updates without a hard reload.
      patchRowClean(k, r.key, { assignedCompanyIds: nextIds });
    });
  }

  // ── Keyboard navigation: Enter / arrow-up / arrow-down move between same-column inputs. ──
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

  // ── Multi-row paste: a tab/newline clipboard becomes new draft rows (Excel copy-paste). ──
  function onGridPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text/plain');
    if (!text || !/[\t\n]/.test(text.trim())) return; // single value → let the default cell paste happen.
    e.preventDefault();
    const cols = TEXT_COLS[kind];
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
    const news: RowState[] = [];
    for (const line of lines) {
      const cells = line.split('\t');
      draftSeq.current += 1;
      const d = emptyDraft(`draft-${draftSeq.current}`, newRowCompany, isGroupAdmin);
      cols.forEach((c, i) => {
        if (cells[i] != null) (d as unknown as Record<string, unknown>)[c.field] = cells[i].trim();
      });
      news.push(d);
    }
    if (news.length) patchRows([...rows, ...news]);
  }

  // ── Derived view: filter + search + sort. ──
  const view = useMemo(() => {
    let v = rows.filter((r) => {
      if (statusFilter === 'active' && r.archived) return false;
      if (statusFilter === 'archived' && !r.archived) return false;
      if (scopeFilter === 'global' && !r.isGlobal) return false;
      if (scopeFilter === 'company' && r.isGlobal) return false;
      if (search) {
        const hay = `${r.code} ${r.name} ${r.title} ${r.jobFamily} ${r.label} ${r.description}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
    if (sortField) {
      v = [...v].sort((a, b) => {
        const av = String(a[sortField] ?? '').toLowerCase();
        const bv = String(b[sortField] ?? '').toLowerCase();
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return v;
  }, [rows, statusFilter, scopeFilter, search, sortField, sortDir]);

  function toggleSort(field: keyof GridRecord) {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function scopeLabel(r: RowState): string {
    if (r.isGlobal) return t('scopeGlobal');
    const extra = r.assignedCompanyIds.filter((id) => id !== r.companyId);
    if (extra.length === 0) return companyName.get(r.companyId) ?? t('scopeOwn');
    return t('scopeCompaniesN', { n: extra.length + 1 });
  }

  function exportCsv() {
    const cols = TEXT_COLS[kind].map((c) => String(c.field));
    const header = [...cols, 'scope', 'status', 'lastUpdatedBy', 'lastUpdatedAt'];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of view) {
      const cells = cols.map((c) => esc((r as unknown as Record<string, unknown>)[c]));
      cells.push(esc(scopeLabel(r)), esc(r.archived ? t('statusArchived') : t('statusActive')), esc(r.lastUpdatedBy), esc(r.lastUpdatedAt));
      lines.push(cells.join(','));
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `system-labels-${kind}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const counts = useMemo(() => {
    const c = {} as Record<GridKind, number>;
    for (const k of KINDS) c[k] = rowsByKind[k].filter((r) => !r.archived).length;
    return c;
  }, [rowsByKind]);

  const headerCls = 'cursor-pointer select-none px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground';
  const cellInput = `${inputCls} h-8`;

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Left rail: categories */}
      <nav className="shrink-0 lg:w-52">
        <div className="rounded-xl border border-border bg-card p-2">
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('categories')}</div>
          <ul className="mt-1 space-y-0.5">
            {KINDS.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => {
                    setKind(k);
                    setSelected(new Set());
                    setRowErrors({});
                    setBanner(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                    kind === k ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span>{t(`category.${k}`)}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">{counts[k]}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => setShowSharing((v) => !v)}
          className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          {t('sharingSettings')}
        </button>
        {showSharing && (
          <div className="mt-2 rounded-xl border border-border bg-card p-2">
            <p className="px-1 pb-2 text-[11px] leading-snug text-muted-foreground">{t('sharedLabelsToggleHint')}</p>
            <ul className="space-y-1">
              {companies.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 px-1">
                  <span className="truncate text-xs text-foreground">{c.name}</span>
                  <label className="inline-flex cursor-pointer items-center gap-1">
                    <input
                      type="checkbox"
                      defaultChecked={c.sharedSystemLabels}
                      disabled={pending}
                      onChange={(e) => runScope(() => actions.setCompanyShared(c.id, e.target.checked))}
                      className="size-3.5 accent-primary"
                    />
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>

      {/* Main grid */}
      <div className="min-w-0 flex-1 space-y-3">
        {/* Toolbar — 797e3523: filters collapse behind a Filter button (hidden by default). */}
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
            <span aria-hidden>⛃</span>
            {t('filter')}
            {activeFilterCount > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">{activeFilterCount}</span>}
            <span aria-hidden>{showFilters ? '▴' : '▾'}</span>
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select value={newRowCompany} onChange={(e) => setNewRowCompany(e.target.value)} className={`${inputCls} h-8 w-auto`} title={t('addToCompany')}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <ToolbarButton onClick={addRow}>{t('addRow')}</ToolbarButton>
            <ToolbarButton onClick={() => setCopyOpen((v) => !v)} disabled={selected.size === 0}>
              {t('copyToCompaniesSelected')}
            </ToolbarButton>
            <ToolbarButton onClick={exportCsv}>{t('exportCsv')}</ToolbarButton>
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

        {/* 797e3523: collapsible filter panel — search + status + criteria scope. */}
        {showFilters && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 p-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className={`${inputCls} h-8 w-44`}
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className={`${inputCls} h-8 w-auto`}>
              <option value="active">{t('filterActive')}</option>
              <option value="archived">{t('filterArchived')}</option>
              <option value="all">{t('filterAllStatus')}</option>
            </select>
            <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value as typeof scopeFilter)} className={`${inputCls} h-8 w-auto`}>
              <option value="all">{t('filterAllScope')}</option>
              <option value="global">{t('scopeGlobal')}</option>
              <option value="company">{t('scopeCompanySpecific')}</option>
            </select>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setStatusFilter('active');
                  setScopeFilter('all');
                }}
                className="inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {t('clearFilters')}
              </button>
            )}
          </div>
        )}

        {copyOpen && (
          <CopyToCompaniesBar
            companies={companies}
            onCancel={() => setCopyOpen(false)}
            onApply={(ids) => {
              const labelIds = rows.filter((r) => selected.has(r.key) && !r.isNew).map((r) => r.id);
              if (labelIds.length && ids.length) {
                runScope(() => actions.copyToCompanies(kind, labelIds, ids));
              }
              setCopyOpen(false);
              setSelected(new Set());
            }}
            t={t}
          />
        )}

        {banner && (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              banner.kind === 'ok'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'bg-destructive/10 text-destructive'
            }`}
          >
            {banner.text}
          </div>
        )}
        {hasChanges && <p className="text-xs text-amber-600 dark:text-amber-400">{t('unsavedChanges')}</p>}

        {/* 797e3523: responsive full-width grid — no forced min-width so it fits the container without
            excessive horizontal scrolling; long values wrap / tooltip instead. */}
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-sm" onPaste={onGridPaste}>
            <thead className="bg-muted/40">
              <tr>
                <th className="w-8 px-2 py-1.5"></th>
                {TEXT_COLS[kind].map((c) => (
                  <th key={String(c.field)} className={headerCls} onClick={() => toggleSort(c.field)}>
                    {t(`col.${String(c.field)}`)}
                    {c.required ? ' *' : ''}
                    {sortField === c.field ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
                {kind === 'department' && <th className="px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('col.businessUnit')}</th>}
                {/* 797e3523: Head column removed from the System Labels surface. */}
                <th className="px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('col.scope')}</th>
                <th className={headerCls} onClick={() => toggleSort('archived')}>{t('col.status')}</th>
                {/* 797e3523: Last-updated column removed — history lives in the Audit Trail. */}
                <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {view.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t('noRows')}
                  </td>
                </tr>
              )}
              {view.map((r, rowIdx) => {
                const err = rowErrors[r.key];
                return (
                  <tr key={r.key} className={`border-t border-border/60 ${r.archived ? 'opacity-50' : ''} ${err ? 'bg-destructive/5' : ''}`}>
                    <td className="px-2 py-1 align-middle">
                      <input
                        type="checkbox"
                        checked={selected.has(r.key)}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const n = new Set(prev);
                            if (e.target.checked) n.add(r.key);
                            else n.delete(r.key);
                            return n;
                          });
                        }}
                        className="size-3.5 accent-primary"
                      />
                    </td>
                    {TEXT_COLS[kind].map((c) => (
                      <td key={String(c.field)} className="px-1.5 py-1">
                        <input
                          data-cell={`${String(c.field)}:${rowIdx}`}
                          value={String(r[c.field] ?? '')}
                          onChange={(e) => updateCell(r.key, c.field, e.target.value)}
                          onKeyDown={(e) => onCellKey(e, rowIdx, String(c.field))}
                          // 797e3523: full value on hover so long text is readable without a wider column.
                          title={String(r[c.field] ?? '')}
                          className={`${cellInput} w-full min-w-0 ${err?.field === c.field ? 'border-destructive' : ''}`}
                        />
                      </td>
                    ))}
                    {kind === 'department' && (
                      <td className="px-1.5 py-1">
                        <select
                          value={r.businessUnitId ?? ''}
                          onChange={(e) => updateCell(r.key, 'businessUnitId', e.target.value || null)}
                          className={`${cellInput} ${err?.field === 'businessUnitId' ? 'border-destructive' : ''}`}
                        >
                          <option value="">{t('businessUnitNone')}</option>
                          {(buByCompany[r.companyId] ?? []).map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                    {/* 797e3523: Head column removed from the System Labels surface. */}
                    {/* Criteria (scope) */}
                    <td className="relative px-1.5 py-1">
                      {r.isNew ? (
                        <span className="text-xs text-muted-foreground">{t('saveFirst')}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setScopePopover(scopePopover === r.key ? null : r.key)}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                            r.isGlobal ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {scopeLabel(r)}
                          <span aria-hidden>▾</span>
                        </button>
                      )}
                      {scopePopover === r.key && !r.isNew && (
                        <ScopePopover
                          row={r}
                          companies={companies}
                          isGroupAdmin={isGroupAdmin}
                          onToggleGlobal={() => toggleGlobal(r)}
                          onApplyCompanies={(ids) => applyCompanies(r, ids)}
                          onClose={() => setScopePopover(null)}
                          t={t}
                        />
                      )}
                    </td>
                    {/* Status */}
                    <td className="px-1.5 py-1">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.archived ? 'bg-muted text-muted-foreground' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>
                        {r.archived ? t('statusArchived') : t('statusActive')}
                      </span>
                    </td>
                    {/* 797e3523: Last-updated cell removed — change history lives in the Audit Trail. */}
                    {/* Row actions */}
                    <td className="px-1.5 py-1 text-right">
                      <div className="inline-flex gap-1">
                        <RowIconButton title={t('duplicateRow')} onClick={() => duplicateRow(r)}>⧉</RowIconButton>
                        {r.isNew ? (
                          <RowIconButton title={t('deleteRow')} onClick={() => removeDraft(r.key)}>✕</RowIconButton>
                        ) : (
                          <RowIconButton title={r.archived ? t('unarchive') : t('archive')} onClick={() => toggleArchive(r.key)} disabled={r.inUse && !r.archived}>
                            {r.archived ? '↩' : '🗑'}
                          </RowIconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('pasteHint')}</p>
      </div>
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

function ScopePopover({
  row,
  companies,
  isGroupAdmin,
  onToggleGlobal,
  onApplyCompanies,
  onClose,
  t,
}: {
  row: RowState;
  companies: GridCompany[];
  isGroupAdmin: boolean;
  onToggleGlobal: () => void;
  onApplyCompanies: (ids: string[]) => void;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  // The origin company is always implicitly assigned; the popover edits the ADDITIONAL companies.
  const [checked, setChecked] = useState<Set<string>>(new Set(row.assignedCompanyIds));
  return (
    <div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-border bg-popover p-3 shadow-lg">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={row.isGlobal} disabled={!isGroupAdmin} onChange={onToggleGlobal} className="size-3.5 accent-primary" />
        <span className={isGroupAdmin ? '' : 'text-muted-foreground'}>{t('scopeGlobal')}</span>
      </label>
      {!isGroupAdmin && <p className="mt-1 text-[11px] text-muted-foreground">{t('globalGroupAdminOnly')}</p>}
      {!row.isGlobal && (
        <>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t border-border pt-2">
            {companies.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={checked.has(c.id)}
                  disabled={c.id === row.companyId}
                  onChange={(e) => {
                    setChecked((prev) => {
                      const n = new Set(prev);
                      if (e.target.checked) n.add(c.id);
                      else n.delete(c.id);
                      return n;
                    });
                  }}
                  className="size-3.5 accent-primary"
                />
                <span className="truncate">
                  {c.name}
                  {c.id === row.companyId ? ` (${t('origin')})` : ''}
                </span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-input px-2 py-1 text-xs hover:bg-muted">
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => onApplyCompanies(Array.from(checked))}
              className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('apply')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CopyToCompaniesBar({
  companies,
  onApply,
  onCancel,
  t,
}: {
  companies: GridCompany[];
  onApply: (ids: string[]) => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <span className="text-sm font-medium">{t('copyToCompanies')}</span>
      <div className="flex flex-wrap gap-2">
        {companies.map((c) => (
          <label key={c.id} className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={checked.has(c.id)}
              onChange={(e) =>
                setChecked((prev) => {
                  const n = new Set(prev);
                  if (e.target.checked) n.add(c.id);
                  else n.delete(c.id);
                  return n;
                })
              }
              className="size-3.5 accent-primary"
            />
            {c.name}
          </label>
        ))}
      </div>
      <div className="ml-auto flex gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-input px-2 py-1 text-xs hover:bg-muted">
          {t('cancel')}
        </button>
        <button
          type="button"
          onClick={() => onApply(Array.from(checked))}
          disabled={checked.size === 0}
          className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('apply')}
        </button>
      </div>
    </div>
  );
}
