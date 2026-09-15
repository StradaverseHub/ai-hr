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
 * PAGED SINCE 9da61c86, through the shared client pager. Rows are filtered and sorted FIRST and sliced
 * second, so a column header still orders the whole category rather than the twenty-five rows on screen;
 * Save still submits every dirty row in the category and CSV export still writes the whole filtered set,
 * neither of them the page. The per-row ticks are the one thing that is page-scoped — see the note beside
 * the selection reset.
 *
 * All writes go through server actions passed in from the page; scope changes (Global / assign / unassign)
 * fire immediately (a saved row must exist first), while text edits + new rows batch into Save.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Filter,
  Trash2,
  X,
} from 'lucide-react';
import { messageOrToken } from '@/lib/label-error-token';
import { pageOfIndex, paginateRows } from '@/lib/pagination';
import { Button, ErrorBanner, StatusBadge, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from './ui';
import {
  ClientPager,
  useClampPagePastEnd,
  useClientPageNav,
  useClientPageQuery,
  useResetPageOnFilterChange,
} from './client-pager';

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
  // A row error's `code` (f1bbc572) is the translatable TOKEN for a refusal about the ACTOR rather than
  // the cell — "you do not administer that company", "Global is group-admin-only". `message` stays the
  // diagnostic sentence; the banner prefers the token, because that is the half a reader can read.
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
  ) => Promise<{ ok: true; created: number; updated: number; createdIds: { key: string; id: string }[] } | { ok: false; rowErrors: { key: string; field?: string; message: string; code?: string }[]; message?: string }>;
  setGlobal: (kind: GridKind, labelId: string, isGlobal: boolean) => Promise<{ ok: true } | { ok: false; message: string }>;
  assign: (kind: GridKind, labelId: string, companyIds: string[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  unassign: (kind: GridKind, labelId: string, companyIds: string[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  copyToCompanies: (kind: GridKind, labelIds: string[], companyIds: string[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  setCompanyShared: (companyId: string, enabled: boolean) => Promise<{ ok: true } | { ok: false; message: string }>;
};

// 797e3523: the visible category rail. 1001ff61 — Business Unit is RE-EXPOSED here: the Organisation
// Assignment now carries a Business Unit (assignment.business_unit_id), so HR needs the BU catalog's
// maintenance screen back to create/edit/activate the allowed values. The backend `business_unit` kind was
// always present (LABEL_KINDS + full CRUD/scope wiring); this simply renders its tab again. TEXT_COLS +
// buByCompany already handle it.
const KINDS: GridKind[] = ['department', 'position', 'cost_center', 'business_unit'];

// dafd475a — STANDARDIZED System Labels columns. Every kind renders the SAME three text columns in the
// SAME order — Code, Label, Description — so the master-data surface reads consistently regardless of which
// category is selected (the reporter's core ask). `headerKey` drives the i18n header (col.code / col.label /
// col.description) INDEPENDENTLY of the underlying `field`, which is what lets each kind bind "Code" to its
// own existing unique identifier WITHOUT adding a new column or changing uniqueness:
//   - department → Code binds to `name`  (departments key on name; no separate code exists)
//   - position   → Code binds to `title` (positions key on title; no separate code exists)
//   - cost_center / business_unit → Code binds to the real `code`; "Description" binds to the required
//     `name` (a cost centre's full descriptive name — exactly what "Description" means here).
// Business-unit link (department only) + Criteria(scope)/Status/Action are rendered specially (not from
// this list) and follow the three text columns, keeping the standard order intact. Secondary optional
// fields no longer surfaced here (position.jobFamily, cost_center's free-text `description`) are PRESERVED
// on save — the row re-sends its loaded value unchanged — so nothing is lost; they are simply not edited on
// this standardized grid. Uniqueness, scope, active/inactive and the edit/delete actions are UNCHANGED.
type StdCol = { headerKey: 'code' | 'label' | 'description'; field: keyof GridRecord; required?: boolean };
const TEXT_COLS: Record<GridKind, StdCol[]> = {
  department: [{ headerKey: 'code', field: 'name', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'description' }],
  position: [{ headerKey: 'code', field: 'title', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'description' }],
  cost_center: [{ headerKey: 'code', field: 'code', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'name', required: true }],
  business_unit: [{ headerKey: 'code', field: 'code', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'name', required: true }],
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
  writableCompanyIds,
  headByCompany = {},
  isGroupAdmin,
  actions,
  gradesSlot,
  gradesActiveCount = 0,
  gradeGroupsSlot,
  gradeGroupsLabel,
  gradeGroupsCount = 0,
  optionSlots = [],
}: {
  data: Record<GridKind, GridRecord[]>;
  companies: GridCompany[];
  /**
   * f1bbc572 — THE COMPANIES THIS ADMIN MAY WRITE, from `adminCompanies()` (the page's read of
   * `app.is_admin_for(company.id)`, which is the very predicate RLS enforces on these four tables —
   * subtree grants included).
   *
   * It is NOT the same set as `companies`: that is the company-switcher SCOPE, which also contains
   * companies the user merely works at. Since f1bbc572 a Global label is listed for every company
   * whatever company created it, so a company-scoped hr_admin now SEES rows whose origin company they
   * cannot write. Rendering those as ordinary inputs invited an edit the database then refused — and
   * because Save is ATOMIC, one such row took every other edit in that Save down with it. Rows outside
   * this set are therefore read-only, with the Criteria, archive and Duplicate actions withheld too.
   */
  writableCompanyIds: string[];
  /**
   * r285 — HEAD OPTIONS PER COMPANY, for the Head (leave approver) column on the department and
   * business_unit kinds. Keyed by the row's OWN company, because `resolveHeadEmploymentId`
   * (core/admin.ts) refuses a head from another company (ADR-0071 §i same-company guard) — offering a
   * cross-company name here would only produce a refusal on Save.
   *
   * WHY IT IS BACK. 797e3523 dropped this column from the grid and left the value round-tripping
   * silently; since then nothing anywhere in the app could set a head, so `department_head` /
   * `business_unit_head` were selectable approval steps that could NEVER fire — generateApprovalSteps
   * drops a head step whose head is unset (core/leave.ts), so every such step was silently skipped. On
   * the live tenant that was 0 of 25 departments and 0 of 7 business units.
   *
   * NOT filtered to active employments on purpose: a select whose current value is absent from its
   * options renders BLANK, which on this column would state "no head" about a department that has one.
   * The list therefore has to be a superset of whatever is stored. Absent ⇒ the column renders with the
   * None option alone (the shape the DOM tests that do not exercise heads see).
   */
  headByCompany?: Record<string, { id: string; label: string }[]>;
  isGroupAdmin: boolean;
  actions: GridActions;
  /** b1b81a08 — the Grades BODY (components/grade-labels-grid.tsx), rendered in place of the company-scoped
   *  toolbar + table when the rail's Grades entry is selected. job_grade is tenant-global (no company_id,
   *  no is_global, no label_company_assignment row), so it is deliberately NOT a fifth GridKind: forcing it
   *  into this grid would need a synthetic record mapper plus ~ten kind-suppressions and would still render
   *  a meaningless Criteria column. `kind` therefore stays typed GridKind and every existing hook, memo and
   *  derived value (rowsByKind / view / counts / scopeLabel / exportCsv) keeps running unchanged — no hook
   *  becomes conditional. Absent ⇒ the rail shows the four company-scoped categories only. */
  gradesSlot?: ReactNode;
  /** Live count beside the rail's Grades entry (active, i.e. non-archived grades). */
  gradesActiveCount?: number;
  /** 9a65f808 — the Grade Groups BODY (components/leave/grade-group-config.tsx), rendered in place of the
   *  company-scoped toolbar + table when the rail's Grade Groups entry is selected. It sits DIRECTLY after
   *  Grades because a grade group is a named set of job grades and the two are maintained together — that
   *  adjacency is the point of the move, not a layout preference.
   *
   *  Its own rail entry rather than a thirteenth `optionSlot`, for the reason `gradesSlot` is not one
   *  either: the option slots are all the same flat profile_option editor, and folding a different editor
   *  into that list would make their shared prop shape a lie the first time one of them is changed as a
   *  group. Absent ⇒ the rail is exactly what it was. */
  gradeGroupsSlot?: ReactNode;
  /** Translated rail label for Grade Groups — supplied by the page, which owns the namespace the editor
   *  itself reads (`admin.benefitScheme`), so the move mints no new string in six locales. */
  gradeGroupsLabel?: string;
  /** Live count beside the rail's Grade Groups entry. */
  gradeGroupsCount?: number;
  /** c9986927 — the eight organisation categories relocated here from Profile Options (Division, Branch,
   *  Region, Line, Section, Team, Base, Category). Each is a further rail entry whose body is supplied by
   *  the page, exactly as Grades is. They are a SEPARATE mechanism from gradesSlot on purpose: their body
   *  is the flat tenant-wide profile_option editor, so — like job_grade — they cannot be synthetic
   *  GridKinds without a meaningless Criteria column and a fake company scope. Empty ⇒ rail unchanged. */
  optionSlots?: { key: string; label: string; count: number; body: ReactNode }[];
}) {
  const t = useTranslations('admin.systemLabels');
  // r285 — the Head column reuses the org-settings labels (fieldHead / headNone) that shipped with the
  // approval-routing feature and are still translated in all six locales. No new i18n key: the wording
  // "Head (leave approver)" is also what the Approval Workflow footnote now points the admin at, and two
  // sentences naming the same control should not be free to drift apart.
  const to = useTranslations('admin.organization');
  const [kind, setKind] = useState<GridKind>('department');
  // b1b81a08 — which BODY the rail is showing. `kind` keeps its last company-scoped value throughout, so
  // switching to Grades and back restores the category the admin was on.
  const [showGrades, setShowGrades] = useState(false);
  // 9a65f808 — …and whether it is on Grade Groups. c9986927's note below still holds with one more
  // selection in it: the FOUR selections (kind / Grades / Grade Groups / option category) are mutually
  // exclusive, and every rail button clears the other three.
  const [showGradeGroups, setShowGradeGroups] = useState(false);
  // c9986927 — the selected relocated-option category, or null when the rail is on a kind / on Grades.
  const [optionKey, setOptionKey] = useState<string | null>(null);
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
  // Split messaging (house pattern): errors stay persistent and in-page via the shared ErrorBanner until
  // resolved; success confirmations are the transient corner toast (sonner), same as other admin screens.
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newRowCompany, setNewRowCompany] = useState(companies[0]?.id ?? '');
  const [scopePopover, setScopePopover] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [showSharing, setShowSharing] = useState(false);
  const [pending, startTransition] = useTransition();
  const draftSeq = useRef(0);
  // Paging rides in the address (?page=&size=), as it does on the server-paged screens — which is what
  // keeps your place across the save round trip and makes the view a shareable link.
  const pq = useClientPageQuery();
  const goToPage = useClientPageNav();
  // The rail selection is part of the signature, not just the filters: every rail entry is a DIFFERENT
  // list, and arriving on page 5 of a category that has two pages would show an empty table. (The rail's
  // slot bodies — Grades, Grade Groups, the option categories — share this one ?page=, because exactly
  // one body is mounted at a time.)
  useResetPageOnFilterChange(
    `${kind}|${optionKey}|${showGrades}|${showGradeGroups}|${search}|${statusFilter}|${scopeFilter}`,
  );

  const rows = rowsByKind[kind];
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  // f1bbc572 — see the `writableCompanyIds` prop note. A DRAFT is always writable: it is created under
  // `newRowCompany`, and its own INSERT is what decides.
  const writableIds = useMemo(() => new Set(writableCompanyIds), [writableCompanyIds]);
  const canWrite = useCallback(
    (r: { companyId: string; isNew?: boolean }) => !!r.isNew || writableIds.has(r.companyId),
    [writableIds],
  );

  /** f1bbc572 — every server refusal reaches the banner through here: a token (lib/label-error-token.ts)
   *  becomes the sentence for THIS reader's locale, an application error's own message passes through,
   *  and the driver's `Failed query: update "department" set …` never arrives at all. */
  const failureText = useCallback((m: string | undefined) => messageOrToken(m, t, t('saveFailed')), [t]);

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
    // A read-only row can never become dirty: its UPDATE would be refused by RLS, and Save is atomic, so
    // it would roll back every other row's edit with it. The inputs are rendered readOnly; this is the
    // second lock, for the paths that do not go through a keystroke.
    const target = rows.find((r) => r.key === key);
    if (!target || !canWrite(target)) return;
    patchRows(rows.map((r) => (r.key === key ? { ...r, [field]: value, dirty: true } : r)));
  }
  /**
   * Put a new draft in front of the reader (9da61c86).
   *
   * Appended rows land wherever the current sort puts them, which on a paged list is usually a page
   * nobody is looking at — Add Row would read as doing nothing. (An active search hides a still-empty
   * draft, as it always has; findIndex answers -1 and pageOfIndex turns that into page one.)
   */
  function followDraft(next: RowState[], key: string) {
    goToPage(pageOfIndex(applyView(next).findIndex((r) => r.key === key), pq.size));
  }
  function addRow() {
    if (!newRowCompany) return;
    draftSeq.current += 1;
    const draft = emptyDraft(`draft-${draftSeq.current}`, newRowCompany, isGroupAdmin);
    const next = [...rows, draft];
    patchRows(next);
    followDraft(next, draft.key);
  }
  /**
   * f1bbc572 — DUPLICATE MUST NOT OFFER A COPY THE DATABASE WILL REFUSE. The copy is INSERTED under the
   * SOURCE row's own company, so it is offered only where that insert can succeed (RLS checks
   * `is_admin_for` on the new row's company exactly as it does for an update); the button is disabled on
   * a read-only row rather than producing a draft that fails on Save and rolls the whole Save back.
   *
   * And it is never born Global unless the actor may set Global at all: the 0157 `guard_is_global`
   * trigger refuses `is_global = true` from a non-group-admin, which for a copy of a Global row is a
   * refusal of a value the user never chose. `isGroupAdmin` is the same gate `addRow` already applies.
   */
  function duplicateRow(src: RowState) {
    if (!canWrite(src)) return;
    draftSeq.current += 1;
    const copy = { ...emptyDraft(`draft-${draftSeq.current}`, src.companyId, src.isGlobal && isGroupAdmin), code: src.code, name: src.name, title: src.title, jobFamily: src.jobFamily, label: src.label, businessUnitId: src.businessUnitId, headEmploymentId: src.headEmploymentId, description: src.description };
    const next = [...rows, copy];
    patchRows(next);
    followDraft(next, copy.key);
  }
  function removeDraft(key: string) {
    patchRows(rows.filter((r) => r.key !== key));
  }
  function toggleArchive(key: string) {
    // Archiving is an UPDATE (archived_at), so it needs the same write right as a text edit.
    const target = rows.find((r) => r.key === key);
    if (!target || !canWrite(target)) return;
    patchRows(rows.map((r) => (r.key === key ? { ...r, archived: !r.archived, dirty: true } : r)));
  }

  function discard() {
    patchRows(data[kind].map((r) => ({ ...r, key: r.id, isNew: false, dirty: false })));
    setRowErrors({});
    setError(null);
  }

  function save() {
    setError(null);
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
      // r285: the Head column is EDITED on this surface again (797e3523 had removed it, leaving this
      // field a silent round-trip). A draft carries whatever the Head select holds — null for None.
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
      // r285: ALWAYS SENT, never by presence — the service's tri-state reads `undefined` as "untouched",
      // and a field that is always submitted cannot carry "the admin did not open this select". So a
      // text-only edit re-sends the loaded head unchanged (no clear), and choosing None sends null, which
      // the service reads as an explicit CLEAR. Both are the same statement: what the cell now shows.
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
        toast.success(t('saved', { created: res.created, updated: res.updated }));
      } else {
        const map: Record<string, { field?: string; message: string }> = {};
        for (const e of res.rowErrors) map[e.key] = { field: e.field, message: e.message };
        setRowErrors(map);
        // f1bbc572 — SAY WHY, IN THE READER'S LANGUAGE. A refusal about the ACTOR ("you do not
        // administer that company") highlights no cell, so "fix the highlighted rows" would leave the
        // admin staring at a row with nothing wrong in it; its token is promoted to the banner. A
        // field-level refusal keeps the existing banner and speaks through the highlighted cell.
        const rowToken = res.rowErrors.find((e) => e.code)?.code;
        setError(failureText(rowToken ?? res.message));
      }
    });
  }

  // Scope changes fire immediately against the server (row must already exist).
  function runScope(fn: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(failureText(r.message));
      else setError(null);
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
        setError(failureText(res.message));
        return;
      }
      setError(null);
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
        if (!a.ok) return setError(failureText(a.message));
      }
      if (toRemove.length) {
        const u = await actions.unassign(k, r.id, toRemove);
        if (!u.ok) return setError(failureText(u.message));
      }
      setError(null);
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
    if (news.length) {
      const next = [...rows, ...news];
      patchRows(next);
      followDraft(next, news[0].key);
    }
  }

  // ── Derived view: filter + search + sort. A function as well as a memo, because addRow, duplicateRow
  //    and the multi-row paste all need to ask which page their new draft landed on. ──
  const applyView = useCallback((source: RowState[]) => {
    let v = source.filter((r) => {
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
  }, [statusFilter, scopeFilter, search, sortField, sortDir]);

  const view = useMemo(() => applyView(rows), [applyView, rows]);
  // Sort first, page second — the ordering that makes a column header mean the whole category.
  const { rows: pageRows, state: pgState } = paginateRows(view, pq);
  // A page that no longer exists (rows deleted off the end, or a stale bookmark) draws nothing at all —
  // land the reader on the last page that has rows instead.
  useClampPagePastEnd(pgState);

  // Ticks are made by hand on the rows in front of you, so leaving the page clears them: a "Copy to
  // companies" that quietly included rows you can no longer see is the bulk-selection hazard fc776376
  // fixed on the feedback board, in a smaller shape.
  const pagePosition = `${pq.page}|${pq.size}`;
  const lastPagePosition = useRef(pagePosition);
  useEffect(() => {
    if (lastPagePosition.current === pagePosition) return;
    lastPagePosition.current = pagePosition;
    setSelected(new Set());
  }, [pagePosition]);

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

  /** r285 — the Head cell's text on a READ-ONLY row, where the select is stated rather than offered.
   *  Falls back to the None label when no head is set, and to the stored id when the row's company is
   *  outside this admin's employee read (a foreign Global row) — never to an empty cell, which would
   *  read as "no head" about a unit that has one. */
  function headLabel(r: RowState): string {
    if (!r.headEmploymentId) return to('headNone');
    return (headByCompany[r.companyId] ?? []).find((o) => o.id === r.headEmploymentId)?.label ?? r.headEmploymentId;
  }
  /** r285 — the options a row's Head select offers. The row's CURRENT head is always among them, even
   *  when it is missing from the company's option list: a `<select>` whose value matches no option
   *  renders blank, and blank on this column means "no head". The one thing this cell may never do is
   *  say a unit has no head when it has one. */
  function headOptions(r: RowState): { id: string; label: string }[] {
    const opts = headByCompany[r.companyId] ?? [];
    if (!r.headEmploymentId || opts.some((o) => o.id === r.headEmploymentId)) return opts;
    return [{ id: r.headEmploymentId, label: headLabel(r) }, ...opts];
  }
  const kindHasHead = kind === 'department' || kind === 'business_unit';

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

  // House table header (theadCls carries the shared type/colour treatment); sortable columns add the
  // pointer + hover affordance on top of the standard th padding.
  const sortableThCls = `${thCls} cursor-pointer select-none hover:text-foreground`;
  const cellInput = `${inputCls} h-8`;

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Left rail: categories */}
      <nav className="shrink-0 lg:w-52">
        <div className="rounded-xl border border-border bg-card p-2">
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('categories')}</div>
          {/* c9986927 — the rail now carries up to thirteen entries (four kinds + Grades + eight relocated
              organisation categories), so it scrolls in place rather than pushing the page. */}
          <ul className="mt-1 max-h-[60vh] space-y-0.5 overflow-y-auto">
            {KINDS.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => {
                    setShowGrades(false);
                    setShowGradeGroups(false);
                    setOptionKey(null);
                    setKind(k);
                    setSelected(new Set());
                    setRowErrors({});
                    setError(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                    !showGrades && !showGradeGroups && optionKey === null && kind === k
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span>{t(`category.${k}`)}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">{counts[k]}</span>
                </button>
              </li>
            ))}
            {/* b1b81a08 — the fifth rail entry: Grades. Same button, same live count; selecting it swaps
                the BODY for gradesSlot rather than re-pointing `kind` (job_grade is tenant-global). */}
            {gradesSlot !== undefined && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setShowGrades(true);
                    setShowGradeGroups(false);
                    setOptionKey(null);
                    setSelected(new Set());
                    setRowErrors({});
                    setError(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                    showGrades ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span>{t('category.grade')}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">{gradesActiveCount}</span>
                </button>
              </li>
            )}
            {/* 9a65f808 — Grade Groups, DIRECTLY under Grades: a group is a named set of grades, and the
                whole point of moving this editor here is that the two are maintained side by side. Its
                label comes from the page for the reason the option slots' do — the editor keeps its own
                `admin.benefitScheme` strings, so nothing is re-translated for the move. */}
            {gradeGroupsSlot !== undefined && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setShowGrades(false);
                    setShowGradeGroups(true);
                    setOptionKey(null);
                    setSelected(new Set());
                    setRowErrors({});
                    setError(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                    showGradeGroups ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span>{gradeGroupsLabel}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">{gradeGroupsCount}</span>
                </button>
              </li>
            )}
            {/* c9986927 — the relocated organisation categories, same rail treatment and live count. Their
                labels come from the page (they keep their existing admin.profileOptions.category.* strings,
                so nothing is re-translated for the move). */}
            {optionSlots.map((slot) => (
              <li key={slot.key}>
                <button
                  type="button"
                  onClick={() => {
                    setShowGrades(false);
                    setShowGradeGroups(false);
                    setOptionKey(slot.key);
                    setSelected(new Set());
                    setRowErrors({});
                    setError(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                    optionKey === slot.key ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span>{slot.label}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">{slot.count}</span>
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

      {/* Main body. b1b81a08: selecting Grades in the rail swaps THIS panel for gradesSlot — the
          company-scoped toolbar (company select, copy-to-companies, CSV export) and the Criteria column
          have no meaning for tenant-global grade rows, so the grade body is its own component. */}
      {showGrades && gradesSlot !== undefined ? (
        gradesSlot
      ) : showGradeGroups && gradeGroupsSlot !== undefined ? (
        // 9a65f808 — the Grade Groups editor, supplied by the page. Same swap as Grades and for the same
        // reason: a grade group is TENANT-level (it names a band of job grades and carries no company), so
        // the company toolbar and the Criteria column have nothing to say about it.
        gradeGroupsSlot
      ) : optionKey !== null ? (
        // c9986927 — the relocated organisation category's own editor, supplied by the page. Same swap as
        // Grades: the company toolbar and Criteria column have no meaning for a flat tenant-wide catalog.
        optionSlots.find((s) => s.key === optionKey)?.body
      ) : (
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
            <Filter className="size-3.5" aria-hidden />
            {t('filter')}
            {activeFilterCount > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">{activeFilterCount}</span>}
            {showFilters ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select value={newRowCompany} onChange={(e) => setNewRowCompany(e.target.value)} className={`${inputCls} h-8 w-auto`} title={t('addToCompany')}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              {t('addRow')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setCopyOpen((v) => !v)} disabled={selected.size === 0}>
              {t('copyToCompaniesSelected')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
              {t('exportCsv')}
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={!hasChanges || pending}>
              {t('saveAll')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={discard} disabled={!hasChanges || pending}>
              {t('discard')}
            </Button>
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

        {error && <ErrorBanner message={error} />}
        {hasChanges && <p className="text-xs text-amber-600 dark:text-amber-400">{t('unsavedChanges')}</p>}

        {/* 797e3523: responsive full-width grid — no forced min-width so it fits the container without
            excessive horizontal scrolling; long values wrap / tooltip instead. */}
        <div className={tableWrapCls}>
          <table className="w-full text-sm" onPaste={onGridPaste}>
            <thead className={theadCls}>
              <tr>
                <th className="w-8 px-2 py-2"></th>
                {TEXT_COLS[kind].map((c) => (
                  <th key={String(c.field)} className={sortableThCls} onClick={() => toggleSort(c.field)}>
                    {t(`col.${c.headerKey}`)}
                    {c.required ? ' *' : ''}
                    {sortField === c.field &&
                      (sortDir === 'asc' ? (
                        <ArrowUp className="ml-1 inline size-3.5" aria-hidden />
                      ) : (
                        <ArrowDown className="ml-1 inline size-3.5" aria-hidden />
                      ))}
                  </th>
                ))}
                {/* 71bacb95: Business Unit column removed from the Department config — the BU link is now
                    maintained via the employee's organisation assignment, not per-department here. The
                    department.businessUnitId column + its hire-form / payroll cascade are unchanged; the grid
                    simply re-sends each row's loaded value unedited (see save() below). */}
                {/* r285: Head (leave approver) — RESTORED. 797e3523 removed it and nothing replaced it,
                    which left department_head / business_unit_head as approval steps that could never
                    fire. Departments and business units only; the other two kinds head nobody. */}
                {kindHasHead && <th className={thCls}>{to('fieldHead')}</th>}
                <th className={thCls}>{t('col.scope')}</th>
                <th className={sortableThCls} onClick={() => toggleSort('archived')}>{t('col.status')}</th>
                {/* 797e3523: Last-updated column removed — history lives in the Audit Trail. */}
                <th className={`${thCls} text-right`}>{t('col.actions')}</th>
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {view.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t('noRows')}
                  </td>
                </tr>
              )}
              {pageRows.map((r, rowIdx) => {
                const err = rowErrors[r.key];
                // f1bbc572 — a row whose ORIGIN company this admin does not administer is SHOWN (Global
                // means every company sees it) but not editable: RLS refuses the write, and an atomic
                // Save would lose every other edited row with it. Read-only, not hidden — hiding it is
                // the defect this round fixed.
                const readOnly = !canWrite(r);
                return (
                  <tr key={r.key} className={`${r.archived ? 'opacity-50' : ''} ${err ? 'bg-destructive/5' : ''}`}>
                    <td className="px-2 py-1.5 align-middle">
                      {/* Deliberately NOT withheld on a read-only row: the tick feeds "Copy to
                          companies", whose write is a label_company_assignment row gated on the TARGET
                          company (0157), not on this row's origin — sharing a global label INTO a company
                          you do administer is exactly what an admin in this position wants. */}
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
                      <td key={String(c.field)} className="px-3 py-1.5">
                        <input
                          data-cell={`${String(c.field)}:${rowIdx}`}
                          value={String(r[c.field] ?? '')}
                          onChange={(e) => updateCell(r.key, c.field, e.target.value)}
                          onKeyDown={(e) => onCellKey(e, rowIdx, String(c.field))}
                          // `readOnly`, NOT `disabled`: the value stays selectable, copyable and reachable
                          // by keyboard — this is a row the admin is entitled to READ — while every edit
                          // path (typing, paste into the cell) is closed.
                          readOnly={readOnly}
                          aria-readonly={readOnly || undefined}
                          // 797e3523: full value on hover so long text is readable without a wider column.
                          // On a read-only row the tooltip says WHY instead, which is the more useful of
                          // the two when the cell will not take an edit.
                          title={readOnly ? t('readOnlyRow') : String(r[c.field] ?? '')}
                          className={`${cellInput} w-full min-w-0 ${err?.field === c.field ? 'border-destructive' : ''} ${
                            readOnly ? 'cursor-default bg-muted/40 text-muted-foreground' : ''
                          }`}
                        />
                      </td>
                    ))}
                    {/* 71bacb95: Business Unit select removed — see the header note. r.businessUnitId is still
                        carried on the row and re-sent unchanged by save(), so existing links are preserved. */}
                    {/* r285: Head (leave approver) — the employment a `department_head` /
                        `business_unit_head` approval step routes to. The BLANK option is a real value,
                        not a placeholder: the row re-sends `headEmploymentId` on every Save, and the
                        service reads blank ⇒ null ⇒ CLEAR (core/admin.ts resolveHeadEmploymentId), so
                        choosing None removes the head rather than leaving it untouched. Like every other
                        write on this grid it is stated, not offered, on a row whose company this admin
                        does not administer — RLS would refuse the UPDATE and Save is atomic. */}
                    {kindHasHead && (
                      <td className="px-3 py-1.5">
                        {readOnly ? (
                          <span title={t('readOnlyRow')} className="text-xs text-muted-foreground">
                            {headLabel(r)}
                          </span>
                        ) : (
                          <select
                            name="headEmploymentId"
                            aria-label={to('fieldHead')}
                            value={r.headEmploymentId ?? ''}
                            onChange={(e) => updateCell(r.key, 'headEmploymentId', e.target.value || null)}
                            className={`${cellInput} w-full min-w-0 ${err?.field === 'headEmploymentId' ? 'border-destructive' : ''}`}
                          >
                            <option value="">{to('headNone')}</option>
                            {headOptions(r).map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    )}
                    {/* Criteria (scope) */}
                    <td className="relative px-3 py-1.5">
                      {r.isNew ? (
                        <span className="text-xs text-muted-foreground">{t('saveFirst')}</span>
                      ) : readOnly ? (
                        // Criteria is a WRITE (setGlobal / assign / unassign all update RLS-guarded
                        // tables), so on a read-only row it is stated, not offered.
                        <span
                          title={t('readOnlyRow')}
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            r.isGlobal ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {scopeLabel(r)}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setScopePopover(scopePopover === r.key ? null : r.key)}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                            r.isGlobal ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {scopeLabel(r)}
                          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                        </button>
                      )}
                      {scopePopover === r.key && !r.isNew && !readOnly && (
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
                    {/* Status — the standard StatusBadge: `active` keys the emerald style, `archived`
                        falls through to the neutral muted default. */}
                    <td className="px-3 py-1.5">
                      <StatusBadge
                        status={r.archived ? 'archived' : 'active'}
                        label={r.archived ? t('statusArchived') : t('statusActive')}
                      />
                    </td>
                    {/* 797e3523: Last-updated cell removed — change history lives in the Audit Trail. */}
                    {/* Row actions */}
                    <td className="px-3 py-1.5 text-right">
                      <div className="inline-flex gap-1">
                        {/* Duplicate INSERTS under this row's own company, so on a read-only row it is
                            withheld rather than offered and refused — see duplicateRow. */}
                        <RowIconButton
                          title={readOnly ? t('readOnlyRow') : t('duplicateRow')}
                          onClick={() => duplicateRow(r)}
                          disabled={readOnly}
                        >
                          <Copy className="size-3.5" aria-hidden />
                        </RowIconButton>
                        {r.isNew ? (
                          <RowIconButton title={t('deleteRow')} onClick={() => removeDraft(r.key)}>
                            <X className="size-3.5" aria-hidden />
                          </RowIconButton>
                        ) : (
                          <RowIconButton
                            title={readOnly ? t('readOnlyRow') : r.archived ? t('unarchive') : t('archive')}
                            onClick={() => toggleArchive(r.key)}
                            disabled={readOnly || (r.inUse && !r.archived)}
                          >
                            {r.archived ? <ArchiveRestore className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
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
        {/* The rows-per-page choice is remembered per screen, so opening System Labels again keeps it. */}
        <ClientPager state={pgState} rememberAs="system-labels" />
        <p className="text-[11px] text-muted-foreground">{t('pasteHint')}</p>
      </div>
      )}
    </div>
  );
}

// Toolbar buttons use the shared <Button> primitive (variant outline / default, size sm). Row actions keep
// this local size-7 icon button: Button's `size="icon"` is 36px (breaks the h-8 row rhythm) and its
// disabled:pointer-events-none would suppress the explanatory title tooltip on the disabled archive case.
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
