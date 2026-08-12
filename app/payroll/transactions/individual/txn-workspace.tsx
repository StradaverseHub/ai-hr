'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Badge, Button, Card, EmployeeName, Field, inputCls } from '@/components/ui';
import { CollapsibleEmployeePanel } from '@/components/collapsible-employee-panel';
import { formatMoney } from '@/lib/money';
import {
  createIndividualTxnAction,
  createIndividualTxnDayGridAction,
  deleteIndividualTxnAction,
  fetchBatchImpactAction,
  fetchEmployeeTxnPanelAction,
  fetchTxnDetailAction,
  previewTxnAmountAction,
  previewTxnAmountsAction,
  updateIndividualTxnAction,
  type TxnActionResult,
  type TxnBatchImpact,
} from './actions';
import { buildTxnGroups, type TxnPanel, type TxnPanelRow } from './existing-context';
import {
  blankDayLine,
  dayKeyOf,
  dayLineIssue,
  dayLineTotals,
  distinctQuantities,
  duplicateDayLineKeys,
  quantityKey,
  type DayLine,
} from './day-lines';

/**
 * 44129979 — the Individual Transaction screen, as ONE two-panel workspace.
 *
 * WHAT IT REPLACES AND WHY IT IS A REPLACEMENT. The previous screen was a four-step wizard: pick
 * employees, pick a month, fill a grid, review, save. It was already employee-first and it already
 * allowed entry before a payroll run existed — two of the three faults the request listed were fixed
 * before it was written. The one that stood was the SHAPE: a wizard shows you what you are typing and
 * never what is already there, so there was no way to review an employee's existing entries before
 * adding another. A wizard and a two-panel workspace are different state machines; keeping both in one
 * component is how a 985-line file becomes a 1500-line one, so the wizard is gone rather than extended.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *  - No Draft or Cancelled status. The ledger has no status column; what it supports is paid / not yet
 *    paid, and those two are what the rows show. See existing-context.ts.
 *  - No attachment upload. There is no document store behind this ledger to put one in.
 *
 * 2da9937a — THE AMOUNT IS NOT ALWAYS THE OPERATOR'S TO TYPE, AND THIS FILE USED TO SAY THE OPPOSITE.
 * The note here read "no calculated-amount field … the keyed amount is authoritative", and it was the
 * on-screen half of the reported defect: an item configured "RM x per hour" still demanded an Amount,
 * still refused a save without one, and its rule never ran. Now, when the picked pay item carries a rule
 * that works the amount out (per_hour / per_day / qty_rate / formula), the Amount box is READ-ONLY and
 * shows the figure the item produces for the quantity keyed — resolved on the server by the same evaluator
 * the payslip uses, never by arithmetic in this file. `generatePayslips` is unchanged: it still pays the
 * STORED amount of a one-off row, which is why nothing already on file moves. What changed is which of the
 * two boxes the operator fills in before it is stored.
 *
 * MULTI-EMPLOYEE ENTRY IS GONE WITH THE WIZARD, ON PURPOSE. The old grid recorded one set of rows for
 * many selected employees at once. A screen whose whole premise is "select an employee, see THEIR
 * transactions" cannot also be a bulk-entry surface without the right panel meaning two different things.
 * `createIndividualTxnsBulk` still takes many employments and is still the write path used here (with
 * one), so nothing was removed from the service — only from this screen.
 */

/** 'YYYY-MM'. The server re-validates with isPayPeriod; this is the client's own shape check. */
const isPeriod = (v: string) => /^\d{4}-\d{2}$/.test(v);

/** Client-side mirror of TXN_KINDS (core/payroll-individual-txn.ts), kept as a literal so this client
 *  component never imports the DB-touching service module (RSC boundary). */
const KINDS = ['earning', 'deduction', 'overtime', 'unpaid', 'leave'] as const;
type TxnKind = (typeof KINDS)[number];

/** Client-side mirror of TXN_UNITS — the request's "Input Type (Value, Days, Hours, Minutes)". The ledger
 *  has no minutes unit, so the five it does have are offered rather than four it does not. */
const UNITS = ['amount', 'qty', 'hours', 'days', 'units'] as const;

/** Map a Payroll Item Master kind onto one of the ledger kinds. 'allowance' ⇒ earning, 'deduction' ⇒
 *  deduction (the two payable one-off classes). */
const COMPONENT_KIND_TO_TXN: Record<string, TxnKind> = { allowance: 'earning', deduction: 'deduction' };

/** The quantity a calculating pay item needs from the operator, or null when it needs none. Mirrors
 *  core/pay-rule.ts payRuleInputUnit — the SERVER resolves it from the stored rule and hands it down, so
 *  this file never inspects a rule. */
type ItemInputUnit = 'hours' | 'days' | null;

/** A resolved item-picker option: a generic kind (`k:<kind>`) or a master component (`c:<id>`).
 *  `derives` / `inputUnit` (2da9937a) come from the pay item's rule, resolved server-side. */
type ItemOption = {
  value: string;
  label: string;
  kind: TxnKind;
  fromMaster: boolean;
  derives: boolean;
  inputUnit: ItemInputUnit;
};
const componentIdOf = (value: string): string | null => (value.startsWith('c:') ? value.slice(2) : null);

/** Real days-in-month (leap-year correct) — mirrors core/payroll.ts daysInMonth so the date input's max is
 *  the true month-end, matching what the server's assertDateInPeriod enforces. */
function daysInMonth(year: number, month1: number): number {
  if (month1 === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month1 - 1];
}

export type TxnEmployee = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  department: string | null;
  departmentId: string | null;
  businessUnit: string | null;
  businessUnitId: string | null;
  position: string | null;
  company: string;
  companyId: string;
  /** Derived from termination, matching the View page convention — the employment-status filter. */
  status: 'active' | 'ended';
};

export type TxnBatch = {
  id: string;
  companyId: string;
  payPeriod: string;
  runType: 'regular' | 'off_cycle' | 'bonus' | 'adjustment';
  runSeq: number;
  scope: { departmentIds?: string[]; employmentIds?: string[] } | null;
  /** 49e7e0a2 — the two statuses this ledger may be written on. A `closed` run is never handed here. */
  status: 'draft' | 'processed';
  /** 510f4bd1 — the run's own recalculation mark (`payroll_batch.needs_recalc_at`), as an ISO instant so
   *  no Date crosses the server boundary. Null when the run owes nothing. */
  needsRecalcAt: string | null;
  /** The employments that run says are stale (`payroll_batch.recalc_employment_ids`). THE AUTHORITATIVE
   *  employee-level fact: it is what `closeBatch` refuses on and what the Reprocess screen pre-ticks, and
   *  it is the only signal that survives deleting the last transaction on the run (request case 4). */
  recalcEmploymentIds: string[] | null;
};

export type TxnPayItem = {
  id: string;
  code: string;
  name: string;
  kind: string;
  /** 2da9937a — this item works its own amount out from its rule, so the Amount box is not the
   *  operator's to fill. Resolved on the server (payRuleDerivesAmount) from the stored rule. */
  derives: boolean;
  /** Which quantity that rule needs keyed (payRuleInputUnit). null ⇒ none. */
  inputUnit: ItemInputUnit;
};

export type TxnCompany = { id: string; name: string; currency: string | null };

/** True when a batch's scope includes this employment (empty/null scope ⇒ whole company). Mirrors the
 *  server's resolveBatchScopeFilter membership rule; the service re-checks it authoritatively. */
function batchIncludesEmployee(b: TxnBatch, emp: TxnEmployee): boolean {
  const empIds = b.scope?.employmentIds ?? [];
  const deptIds = b.scope?.departmentIds ?? [];
  if (empIds.length === 0 && deptIds.length === 0) return true;
  if (empIds.includes(emp.employmentId)) return true;
  if (emp.departmentId && deptIds.includes(emp.departmentId)) return true;
  return false;
}

/** The create/edit form's own state. `mode` decides which action the Save button calls; `sourceId` is the
 *  row a Duplicate was copied FROM, kept only so the form can warn about an identical copy. */
type FormState = {
  mode: 'create' | 'edit';
  id: string | null;
  sourceId: string | null;
  payPeriod: string;
  batchId: string;
  item: string;
  txnDate: string;
  amount: string;
  quantity: string;
  unit: string;
  notes: string;
};

/**
 * 4e403268 — DAY-BY-DAY entry state.
 *
 * TWO SEPARATE STATES, NOT ONE WIDENED OBJECT, and the invariant is that at most one of `form` and
 * `daily` is ever non-null. That is a discriminated union expressed as a state machine, and it is the
 * shape the approved plan asked for: the two modes are different machines — one row with a date and a
 * quantity, versus a header plus a LIST of dated lines — and folding them into one object with a mode
 * flag means every existing read of `form.txnDate` has to start asking which mode it is in. Keeping them
 * apart costs one extra `useState` and leaves the lump-sum path, which is the one production data and the
 * existing tests depend on, byte-for-byte unchanged.
 *
 * The header (month, run, pay item) is duplicated rather than shared for the same reason: switching modes
 * CONVERTS one into the other, carrying the header across, so there is never a moment where two objects
 * disagree about which month is being keyed.
 *
 * Edit is deliberately lump-sum only. An existing row IS one day; opening five days to edit one of them
 * would be a grid that can delete rows the operator never opened.
 */
type DailyState = {
  payPeriod: string;
  batchId: string;
  item: string;
  lines: DayLine[];
};

const EMPTY_PANEL: TxnPanel = {
  rows: [],
  totals: {
    count: 0,
    total: '0.00',
    pendingCount: 0,
    pendingTotal: '0.00',
    processedCount: 0,
    processedTotal: '0.00',
    reprocessCount: 0,
    reprocessTotal: '0.00',
  },
  stranded: [],
};

const PAGE_SIZE = 20;
const EMPLOYEE_CAP = 50;

type SortKey = 'payPeriod' | 'txnDate' | 'kind' | 'amount' | 'status';

export function TxnWorkspace({
  employees,
  batches,
  companies,
  payItems,
  processHref,
  requireComponent,
  currentPeriod,
  panelDefaultOpen,
  panelCookieKey,
}: {
  employees: TxnEmployee[];
  batches: TxnBatch[];
  companies: TxnCompany[];
  payItems: TxnPayItem[];
  processHref: string;
  /** f1564110 Phase 3 — with the kernel paying these rows, a NEW payable row must name a master item. */
  requireComponent: boolean;
  /** Today's month in the TENANT timezone, resolved on the server. Deriving it in the browser would put
   *  a transaction in the wrong month for anyone whose device clock sits in a different day. */
  currentPeriod: string;
  /** 49e7e0a2 — the employee panel's persisted collapse state, resolved from the cookie on the server. */
  panelDefaultOpen: boolean;
  panelCookieKey: string;
}) {
  const t = useTranslations('payroll.transactions.individual');

  // ── Item picker options (Payroll Item Master + the generic kinds) ──
  const genericKinds = useMemo<readonly TxnKind[]>(
    () => (requireComponent ? KINDS.filter((k) => k !== 'earning' && k !== 'deduction') : [...KINDS]),
    [requireComponent],
  );
  const itemOptions = useMemo<ItemOption[]>(() => {
    // A generic kind names no pay item, so there is no rule to calculate from — its amount is always typed.
    const generic: ItemOption[] = genericKinds.map((k) => ({
      value: `k:${k}`,
      label: t(`kindLabel.${k}`),
      kind: k,
      fromMaster: false,
      derives: false,
      inputUnit: null,
    }));
    const master: ItemOption[] = payItems
      .filter((c) => COMPONENT_KIND_TO_TXN[c.kind] != null)
      .map((c) => ({
        value: `c:${c.id}`,
        label: `${c.code} — ${c.name}`,
        kind: COMPONENT_KIND_TO_TXN[c.kind],
        fromMaster: true,
        derives: c.derives,
        inputUnit: c.inputUnit,
      }));
    return [...generic, ...master];
  }, [payItems, t, genericKinds]);
  const itemByValue = useMemo(() => new Map(itemOptions.map((o) => [o.value, o])), [itemOptions]);
  const masterEarnings = useMemo(() => itemOptions.filter((o) => o.fromMaster && o.kind === 'earning'), [itemOptions]);
  const masterDeductions = useMemo(() => itemOptions.filter((o) => o.fromMaster && o.kind === 'deduction'), [itemOptions]);
  const defaultItemValue = requireComponent ? (masterEarnings[0]?.value ?? itemOptions[0]?.value ?? 'k:overtime') : 'k:earning';

  // ── Left panel: filters + selection ──
  // A single-company admin has their one company chosen for them (an initialiser, not an effect —
  // the effect version rendered an empty dropdown for one frame first).
  const [companyId, setCompanyId] = useState(() => (companies.length === 1 ? companies[0].id : ''));
  const [businessUnitFilter, setBusinessUnitFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [periodFilter, setPeriodFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');

  // ── Right panel: the selected employee's transactions ──
  const [panelState, setPanelState] = useState<{ key: string; panel: TxnPanel }>({ key: '', panel: EMPTY_PANEL });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [rowQuery, setRowQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('payPeriod');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // ── 49e7e0a2 — what a save onto the resolved run would make out of date, and what a save already did ──
  const [impactState, setImpactState] = useState<{ key: string; impact: TxnBatchImpact | null }>({
    key: '',
    impact: null,
  });
  /** The processed run a save has just marked for recalculation. Set from the ACTION's own report, so it
   *  can never claim a mark for a save that did not land. */
  const [recalcBatchId, setRecalcBatchId] = useState<string | null>(null);

  // ── The form ──
  const [form, setForm] = useState<FormState | null>(null);
  /** 4e403268 — the day-by-day grid. Mutually exclusive with `form`; see the DailyState doc. */
  const [daily, setDaily] = useState<DailyState | null>(null);
  const [formBaseline, setFormBaseline] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);
  /** 4e403268 — the listing's shape: the flat line-per-row list, or grouped by month + pay item with the
   *  days one click away. Flat stays the default so nobody's screen changes under them. */
  const [listView, setListView] = useState<'flat' | 'grouped'>('flat');
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const [pendingEmployeeId, setPendingEmployeeId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  /**
   * The dependent filters are cleared IN THE HANDLERS, not in effects. A department belongs to one
   * business unit and a business unit to one company, so a stale narrower pick must not survive a
   * wider change — but doing that in an effect means React renders once with the impossible
   * combination before correcting it, and the lint rule that flags it is right. One handler each,
   * cleared before the render that shows the new options.
   */
  const changeCompany = (id: string) => {
    setCompanyId(id);
    setBusinessUnitFilter('');
    setDeptFilter('');
  };
  const changeBusinessUnit = (id: string) => {
    setBusinessUnitFilter(id);
    setDeptFilter('');
  };

  const byId = useMemo(() => new Map(employees.map((e) => [e.employmentId, e])), [employees]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const currencyOf = useMemo(() => new Map(companies.map((c) => [c.id, c.currency])), [companies]);
  const currency = selected ? (currencyOf.get(selected.companyId) ?? null) : null;
  const rm = useCallback((v: string | number) => formatMoney(v, currency), [currency]);

  /**
   * 510f4bd1 — THE EMPLOYEE-LEVEL FACT, and it is the authoritative one: the processed runs that name this
   * employment in their own `recalc_employment_ids`. Exactly what `closeBatch` refuses on and what the
   * Reprocess screen arrives pre-ticked with, so the three surfaces cannot disagree.
   *
   * Derived from `batches` (already loaded for the entry form) rather than from the rows on screen, and
   * that is the whole point: DELETING the last transaction on a run leaves no row to label, and an
   * attendance-driven recompute never touched a row at all. Both leave the mark, and both survive an
   * employee switch and a page reload — unlike the transient `recalcBatchId` banner below, which reports
   * what THIS session just did.
   */
  const reprocessRuns = useMemo(
    () =>
      selectedId
        ? batches.filter(
            (b) =>
              b.status === 'processed' &&
              b.needsRecalcAt != null &&
              (b.recalcEmploymentIds ?? []).includes(selectedId),
          )
        : [],
    [batches, selectedId],
  );

  const inCompany = useMemo(
    () => (companyId ? employees.filter((e) => e.companyId === companyId) : employees),
    [employees, companyId],
  );
  const businessUnitOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of inCompany) if (e.businessUnitId && e.businessUnit) seen.set(e.businessUnitId, e.businessUnit);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [inCompany]);
  const departmentOptions = useMemo(() => {
    const src = businessUnitFilter ? inCompany.filter((e) => e.businessUnitId === businessUnitFilter) : inCompany;
    const seen = new Map<string, string>();
    for (const e of src) if (e.departmentId && e.department) seen.set(e.departmentId, e.department);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [inCompany, businessUnitFilter]);

  const filteredEmployees = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = companyId ? employees.filter((e) => e.companyId === companyId) : employees;
    if (businessUnitFilter) base = base.filter((e) => e.businessUnitId === businessUnitFilter);
    if (deptFilter) base = base.filter((e) => e.departmentId === deptFilter);
    if (statusFilter) base = base.filter((e) => e.status === statusFilter);
    if (q) base = base.filter((e) => e.name.toLowerCase().includes(q) || (e.employeeCode ?? '').toLowerCase().includes(q));
    return base;
  }, [employees, query, companyId, businessUnitFilter, deptFilter, statusFilter]);
  const visibleEmployees = useMemo(() => filteredEmployees.slice(0, EMPLOYEE_CAP), [filteredEmployees]);
  const capped = filteredEmployees.length > EMPLOYEE_CAP;

  // ── Load the selected employee's transactions ON DEMAND ──
  // The fetched panel is stored WITH the key it answers and "is this current?" is derived rather than
  // tracked in a second state, so a slow response for a previously-selected employee can never paint over
  // the one now on screen. `reloadNonce` is part of the key so a write can force a refetch of the SAME key.
  const panelKey = selected ? `${selected.companyId}|${selected.employmentId}|${periodFilter}|${reloadNonce}` : '';
  useEffect(() => {
    if (!panelKey) return;
    let live = true;
    const [cid, eid, period] = panelKey.split('|');
    fetchEmployeeTxnPanelAction({ companyId: cid!, employmentId: eid!, payPeriod: period })
      .then((panel) => {
        if (live) setPanelState({ key: panelKey, panel });
      })
      .catch(() => {
        // A failed read must never block entry — the panel reports nothing and the form still works.
        if (live) setPanelState({ key: panelKey, panel: EMPTY_PANEL });
      });
    return () => {
      live = false;
    };
  }, [panelKey]);
  const panel = panelState.key === panelKey ? panelState.panel : EMPTY_PANEL;
  const panelLoading = panelKey !== '' && panelState.key !== panelKey;
  const refreshPanel = () => setReloadNonce((n) => n + 1);

  /** Everything about HOW the listing is being viewed — page, search, which row is expanded, a delete
   *  waiting for confirmation — belongs to the employee and month being viewed, so it is cleared by
   *  the two handlers that change them rather than by an effect watching them. An effect would leave a
   *  pending delete confirmation on screen for one render after the row it belongs to is gone. */
  const resetListingView = () => {
    setPage(0);
    setRowQuery('');
    setExpandedId(null);
    setExpandedGroupKey(null);
    setConfirmDeleteId(null);
    setRecalcBatchId(null);
  };
  const changePeriodFilter = (period: string) => {
    setPeriodFilter(period);
    resetListingView();
  };

  const sortedRows = useMemo(() => {
    const q = rowQuery.trim().toLowerCase();
    const matched = q
      ? panel.rows.filter(
          (r) =>
            (r.notes ?? '').toLowerCase().includes(q) ||
            r.kind.toLowerCase().includes(q) ||
            r.txnDate.includes(q) ||
            r.payPeriod.includes(q) ||
            r.amount.includes(q),
        )
      : panel.rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: TxnPanelRow): string | number => {
      switch (sortKey) {
        case 'amount':
          return Number(r.amount);
        case 'kind':
          return r.kind;
        case 'status':
          return r.status;
        case 'txnDate':
          return r.txnDate;
        case 'payPeriod':
        default:
          return r.payPeriod;
      }
    };
    return [...matched].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Within a month the transaction date is the reading order, then id for a deterministic tiebreak.
      if (a.txnDate !== b.txnDate) return a.txnDate < b.txnDate ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [panel.rows, rowQuery, sortKey, sortDir]);

  /**
   * 4e403268 — the same rows, grouped by month + pay item.
   *
   * Built from `sortedRows` rather than from `panel.rows` on purpose: the search box has to narrow the
   * grouped view too, or typing a remark would silently change which days a total is over without changing
   * the total's label. The grouping's own ordering (newest month, then pay item code) then applies —
   * the column sort belongs to the flat list, where a column exists to sort by.
   */
  const groups = useMemo(() => buildTxnGroups(sortedRows), [sortedRows]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => sortedRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [sortedRows, safePage],
  );

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'payPeriod' || key === 'txnDate' ? 'desc' : 'asc');
    }
  };

  // ── Form target resolution: which run (if any) a new/edited row lands on ──
  // 4e403268 — one month for whichever entry machine is open. The two are mutually exclusive, so this
  // reads the open one; everything downstream (eligible runs, the date bounds, the derived figure) is
  // written once and serves both modes rather than being duplicated per mode.
  const formPeriod = form?.payPeriod ?? daily?.payPeriod ?? '';
  const eligibleBatches = useMemo(() => {
    if (!selected || !isPeriod(formPeriod)) return [];
    return batches
      .filter((b) => b.companyId === selected.companyId && b.payPeriod === formPeriod && batchIncludesEmployee(b, selected))
      .sort((a, b) => (a.runType === b.runType ? a.runSeq - b.runSeq : a.runType < b.runType ? -1 : 1));
  }, [batches, selected, formPeriod]);
  const periodKeyed = isPeriod(formPeriod) && eligibleBatches.length === 0;
  const cycleLabel = (b: TxnBatch) => `${t(`cycle.${b.runType}`)}${b.runSeq > 1 ? ` #${b.runSeq}` : ''}`;

  /**
   * The run a save will land on, DERIVED rather than stored: the operator's pick while it is still
   * one of the eligible runs, otherwise the sole eligible run, otherwise none (period-keyed).
   *
   * This was an effect that wrote the resolved id back into form state, and deriving it is not a
   * tidy-up — a stored batchId is a second copy of something the month and the employee already
   * determine, and the window where the two disagree is a window where the row is written against a
   * run that no longer covers this employee. There is no such window if it is never stored.
   */
  const resolvedBatchId = useMemo(() => {
    const picked = form?.batchId ?? daily?.batchId ?? '';
    if (!form && !daily) return '';
    if (picked && eligibleBatches.some((b) => b.id === picked)) return picked;
    return eligibleBatches.length === 1 ? eligibleBatches[0].id : '';
  }, [form, daily, eligibleBatches]);

  /** The run a save would land on, as a batch record (not just its id) — the form needs its status. */
  const targetBatch = useMemo(
    () => (resolvedBatchId ? (eligibleBatches.find((b) => b.id === resolvedBatchId) ?? null) : null),
    [resolvedBatchId, eligibleBatches],
  );
  const targetProcessed = targetBatch?.status === 'processed';

  /**
   * Fetch what the target run has already sent downstream, but ONLY when the target is processed — a
   * draft run has produced no payslip, no bank file and no statutory return, so there is nothing to warn
   * about and no reason to spend a round trip finding that out.
   *
   * Stored WITH the key it answers and "is this current?" DERIVED, exactly as the employee panel above
   * does it, and for the same two reasons: a slow reply for a run the operator has moved off can never
   * paint over the one on screen, and clearing on a key change needs no synchronous setState inside the
   * effect (which is a cascading render, and which the lint rightly refuses).
   */
  const impactKey = targetProcessed && resolvedBatchId ? resolvedBatchId : '';
  useEffect(() => {
    if (!impactKey) return;
    let live = true;
    fetchBatchImpactAction({ batchId: impactKey })
      .then((r) => {
        if (live) setImpactState({ key: impactKey, impact: r?.batchId === impactKey ? r : null });
      })
      .catch(() => {
        // A failed read must never block entry. The "this run is processed" warning below does not depend
        // on it — only the extra detail about the payment file and the statutory returns does.
        if (live) setImpactState({ key: impactKey, impact: null });
      });
    return () => {
      live = false;
    };
  }, [impactKey]);
  const impact = impactState.key === impactKey ? impactState.impact : null;

  const monthBounds = useMemo(() => {
    if (!isPeriod(formPeriod)) return null;
    const [y, m] = formPeriod.split('-').map(Number);
    return { min: `${formPeriod}-01`, max: `${formPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}` };
  }, [formPeriod]);

  // ── 2da9937a — the amount the PAY ITEM works out, when it is not the operator's to type ──
  const pickedItem = form ? (itemByValue.get(form.item) ?? null) : daily ? (itemByValue.get(daily.item) ?? null) : null;
  const derives = pickedItem?.derives === true;
  /** The quantity this item's rule needs keyed, or null when it needs none (qty_rate carries its own). */
  const requiredUnit: ItemInputUnit = derives ? pickedItem!.inputUnit : null;
  /** True once the operator has supplied that quantity — the point at which a figure can be asked for. */
  const quantityReady = requiredUnit == null || (form?.unit === requiredUnit && Number(form?.quantity) > 0);

  /**
   * The derived figure is FETCHED, never computed here. Re-implementing a per_hour multiply in the browser
   * would be a second evaluator, and the moment a rule became a formula reading another pay item the two
   * would part company — with the difference showing up as money on a payslip. The server answers with the
   * same call the save makes, so the number on screen is the number that will be stored.
   *
   * Keyed on every input the answer depends on, stored WITH its key and "is this current?" DERIVED — the
   * same shape as the employee panel and the batch impact above, and for the same reason: a slow reply for
   * a quantity the operator has already changed must never paint over the figure now on screen.
   *
   * The key is EMPTY until the required quantity is present, so an item that calculates from hours does not
   * fire a request (and surface a refusal) while the operator is still on their way to the Hours box.
   */
  // 4e403268 — LUMP-SUM ONLY. In day-by-day mode the grid's own batched preview (below) is the single
  // source of the figures, and leaving this one armed would fire a second, differently-keyed request for
  // a quantity box that is not on screen.
  const derivedKey =
    form != null && derives && pickedItem?.fromMaster && selected && isPeriod(formPeriod) && quantityReady
      ? [
          componentIdOf(pickedItem.value) ?? '',
          selected.employmentId,
          selected.companyId,
          formPeriod,
          form?.quantity.trim() ?? '',
          form?.unit ?? '',
        ].join('|')
      : '';
  const [derivedState, setDerivedState] = useState<{
    key: string;
    amount: string | null;
    zeroDivisor: string | null;
    error: string | null;
  }>({ key: '', amount: null, zeroDivisor: null, error: null });
  useEffect(() => {
    if (!derivedKey) return;
    let live = true;
    const [componentId, employmentId, companyId, payPeriod, quantity, unit] = derivedKey.split('|');
    previewTxnAmountAction({
      componentId: componentId!,
      employmentId: employmentId!,
      companyId: companyId!,
      payPeriod: payPeriod!,
      quantity: quantity === '' ? null : Number(quantity),
      unit: unit === '' ? null : unit!,
    })
      .then((r) => {
        if (!live) return;
        if (!r.ok) setDerivedState({ key: derivedKey, amount: null, zeroDivisor: null, error: r.error });
        else if (!r.derived) setDerivedState({ key: derivedKey, amount: null, zeroDivisor: null, error: null });
        else setDerivedState({ key: derivedKey, amount: r.amount, zeroDivisor: r.zeroDivisor, error: null });
      })
      .catch(() => {
        // A failed read must NOT fall back to the typed amount: on a calculating item there is no typed
        // amount to fall back to, and pretending otherwise would save a zero.
        if (live) setDerivedState({ key: derivedKey, amount: null, zeroDivisor: null, error: 'derivedAmountUnavailable' });
      });
    return () => {
      live = false;
    };
  }, [derivedKey]);
  const derivedCurrent = derivedState.key === derivedKey && derivedKey !== '' ? derivedState : null;
  const derivedAmount = derives ? (derivedCurrent?.amount ?? null) : null;
  const derivedError = derives ? (derivedCurrent?.error ?? null) : null;
  const derivedZeroDivisor = derives ? (derivedCurrent?.zeroDivisor ?? null) : null;
  const derivedPending = derives && derivedKey !== '' && derivedState.key !== derivedKey;

  // ── 4e403268 — the SAME derivation, for a whole day-by-day grid, in ONE request ──
  /**
   * The distinct quantities the grid needs priced. Deduplicated because the figure depends on (item,
   * employment, company, month, quantity, unit) and nothing else: five days of 2.00 hours are five copies
   * of one answer, and asking five times would be five transactions resolving the same employee's month.
   */
  const dailyQuantities = useMemo(() => (daily ? distinctQuantities(daily.lines) : []), [daily]);
  /**
   * Keyed on everything the answer depends on, and the answers are stored WITH the key — the same
   * store-the-key / derive-is-this-current guard the two effects above use, for the same reason: a reply
   * for a quantity set the operator has already changed must never paint over the figures now on screen.
   * The key is empty until there is something to price, so an empty grid fires nothing.
   */
  const dailyDerivedKey =
    daily != null && derives && pickedItem?.fromMaster && selected && isPeriod(formPeriod) && dailyQuantities.length > 0
      ? [
          componentIdOf(pickedItem.value) ?? '',
          selected.employmentId,
          selected.companyId,
          formPeriod,
          requiredUnit ?? '',
          dailyQuantities.join(','),
        ].join('|')
      : '';
  const [dailyDerived, setDailyDerived] = useState<{
    key: string;
    amounts: Record<string, string>;
    zeroDivisor: string | null;
    error: string | null;
  }>({ key: '', amounts: {}, zeroDivisor: null, error: null });
  useEffect(() => {
    if (!dailyDerivedKey) return;
    let live = true;
    const [componentId, employmentId, companyId, payPeriod, unit, quantities] = dailyDerivedKey.split('|');
    previewTxnAmountsAction({
      componentId: componentId!,
      employmentId: employmentId!,
      companyId: companyId!,
      payPeriod: payPeriod!,
      unit: unit === '' ? null : unit!,
      quantities: quantities!.split(',').filter(Boolean),
    })
      .then((r) => {
        if (!live) return;
        if (!r.ok) setDailyDerived({ key: dailyDerivedKey, amounts: {}, zeroDivisor: null, error: r.error });
        else if (!r.derived) setDailyDerived({ key: dailyDerivedKey, amounts: {}, zeroDivisor: null, error: null });
        else {
          const amounts: Record<string, string> = {};
          for (const a of r.amounts) amounts[a.quantity] = a.amount;
          setDailyDerived({ key: dailyDerivedKey, amounts, zeroDivisor: r.zeroDivisor, error: null });
        }
      })
      .catch(() => {
        // Same refusal as the single-value path: never fall back to a typed amount on a calculating item.
        if (live) setDailyDerived({ key: dailyDerivedKey, amounts: {}, zeroDivisor: null, error: 'derivedAmountUnavailable' });
      });
    return () => {
      live = false;
    };
  }, [dailyDerivedKey]);
  const dailyDerivedCurrent = dailyDerived.key === dailyDerivedKey && dailyDerivedKey !== '' ? dailyDerived : null;
  const dailyDerivedPending = derives && dailyDerivedKey !== '' && dailyDerived.key !== dailyDerivedKey;

  /**
   * ONE line's money: the item's own figure when it calculates, the typed figure when it does not.
   *
   * Null means NOT KNOWN YET (a request in flight, or a quantity that could not be priced) — and one
   * unknown line withholds the grid's total rather than showing a partial sum as if it were complete.
   */
  const dailyAmountFor = useCallback(
    (line: DayLine): string | null => {
      if (!derives) return line.amount.trim() === '' ? null : line.amount;
      const k = quantityKey(line.quantity);
      if (k === '') return null;
      return dailyDerivedCurrent?.amounts[k] ?? null;
    },
    [derives, dailyDerivedCurrent],
  );
  const dailyTotals = useMemo(
    () => (daily ? dayLineTotals(daily.lines, dailyAmountFor) : null),
    [daily, dailyAmountFor],
  );
  const dailyDuplicateKeys = useMemo(() => (daily ? duplicateDayLineKeys(daily.lines) : []), [daily]);

  /** What the save will post: the item's own figure when it has one, otherwise the typed amount. */
  const effectiveAmount = derives ? Number(derivedAmount ?? 0) : Number(form?.amount ?? 0);

  // 4e403268 — ONE baseline serves both machines, because only one of them is ever open. An unsaved
  // day-by-day grid is exactly as much unsaved work as an unsaved single entry, and the switch-employee
  // guard below must protect it the same way.
  const dirty =
    (form != null && JSON.stringify(form) !== formBaseline) || (daily != null && JSON.stringify(daily) !== formBaseline);

  const openForm = (next: FormState) => {
    setForm(next);
    setDaily(null);
    setFormBaseline(JSON.stringify(next));
    setFormError(null);
  };
  const patchForm = (patch: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setFormError(null);
  };
  const openDaily = (next: DailyState) => {
    setDaily(next);
    setForm(null);
    setFormBaseline(JSON.stringify(next));
    setFormError(null);
  };
  const patchDaily = (patch: Partial<DailyState>) => {
    setDaily((d) => (d ? { ...d, ...patch } : d));
    setFormError(null);
  };
  const patchDailyLine = (key: string, patch: Partial<DayLine>) => {
    setDaily((d) => (d ? { ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } : d));
    setFormError(null);
  };
  const closeForm = () => {
    setForm(null);
    setDaily(null);
    setFormBaseline('');
    setFormError(null);
  };

  /** 2da9937a — an item that calculates from hours (or days) OWNS the Input Type: the quantity has to land
   *  in the input its rule reads or the figure is meaningless, so it is set rather than offered. Items that
   *  do not calculate keep the operator's own choice (or none), exactly as before. */
  const unitFor = (itemValue: string, current: string): string => itemByValue.get(itemValue)?.inputUnit ?? current;

  const blankForm = (period: string): FormState => ({
    mode: 'create',
    id: null,
    sourceId: null,
    payPeriod: period,
    batchId: '',
    item: defaultItemValue,
    txnDate: '',
    amount: '',
    quantity: '',
    unit: unitFor(defaultItemValue, ''),
    notes: '',
  });

  /** Changing the pay item can change WHICH box is the operator's to fill, so the two that belong to the
   *  old item are reset with it: the Input Type follows the new item's rule, and a typed amount does not
   *  survive onto an item that works its own amount out (nor a derived figure onto one that does not). */
  const changeItem = (value: string) =>
    patchForm({ item: value, unit: unitFor(value, form?.unit ?? ''), amount: '' });

  const startCreate = () => openForm(blankForm(periodFilter && isPeriod(periodFilter) ? periodFilter : currentPeriod));

  // ── 4e403268 — the mode switch ──
  /**
   * Switching modes CONVERTS the open entry rather than discarding it: the month, the run and the pay item
   * are carried across, because they are the same three answers in both machines and re-picking them is the
   * friction the request is about ("you must open the form five times and re-pick the pay item each time").
   *
   * What is NOT carried is the row itself. Going to day-by-day seeds the grid with the single entry as its
   * first line, so a half-typed date and quantity survive the switch; coming back takes the FIRST line, and
   * says so on screen before it does, because there is no honest way to fold five days into one box.
   */
  const changeDailyItem = (value: string) => patchDaily({ item: value });
  const switchToDaily = () => {
    const from = form;
    openDaily({
      payPeriod: from?.payPeriod ?? (periodFilter && isPeriod(periodFilter) ? periodFilter : currentPeriod),
      batchId: from?.batchId ?? '',
      item: from?.item ?? defaultItemValue,
      lines: [
        from
          ? { ...blankDayLine(), txnDate: from.txnDate, quantity: from.quantity, amount: from.amount, notes: from.notes }
          : blankDayLine(),
      ],
    });
  };
  const switchToLump = () => {
    const from = daily;
    const first = from?.lines[0];
    const item = from?.item ?? defaultItemValue;
    openForm({
      ...blankForm(from?.payPeriod ?? currentPeriod),
      batchId: from?.batchId ?? '',
      item,
      unit: unitFor(item, ''),
      txnDate: first?.txnDate ?? '',
      quantity: first?.quantity ?? '',
      amount: first?.amount ?? '',
      notes: first?.notes ?? '',
    });
  };
  const addDailyLine = () => setDaily((d) => (d ? { ...d, lines: [...d.lines, blankDayLine()] } : d));
  const removeDailyLine = (key: string) =>
    setDaily((d) => (d ? { ...d, lines: d.lines.length > 1 ? d.lines.filter((l) => l.key !== key) : d.lines } : d));

  /** Open Edit or Duplicate. Both need the row's stored component, which only the by-id read carries. */
  const openFromRow = (row: TxnPanelRow, mode: 'edit' | 'duplicate') => {
    startTransition(async () => {
      const detail = await fetchTxnDetailAction({ id: row.id });
      if (!detail) {
        setFormError(t('txnNotFound'));
        return;
      }
      const item = detail.componentId ? `c:${detail.componentId}` : `k:${detail.kind}`;
      const resolvedItem = itemByValue.has(item) ? item : `k:${detail.kind}`;
      openForm({
        mode: mode === 'edit' ? 'edit' : 'create',
        id: mode === 'edit' ? detail.id : null,
        sourceId: mode === 'duplicate' ? detail.id : null,
        payPeriod: detail.payPeriod,
        batchId: '',
        // A component that is archived (or hidden by requireComponent) is no longer an offered option;
        // fall back to the generic kind rather than a select stuck on a value that does not exist.
        item: resolvedItem,
        txnDate: detail.txnDate,
        amount: Number(detail.amount).toString(),
        quantity: detail.quantity != null ? Number(detail.quantity).toString() : '',
        // 2da9937a — a row keyed BEFORE its pay item started calculating carries no unit (or the wrong
        // one). The Input Type select is disabled on a calculating item, so leaving the stored value would
        // strand the operator on a form they cannot make valid: the item's required input wins.
        unit: unitFor(resolvedItem, detail.unit ?? ''),
        notes: detail.notes ?? '',
      });
    });
  };

  /** The item as it will be persisted: the picked option's kind + componentId, and (for a named master
   *  item) its label defaulted into the remarks so the specific pay item is readable in the ledger. */
  const resolveItem = (f: FormState) => {
    const opt = itemByValue.get(f.item) ?? itemOptions[0];
    return {
      kind: opt.kind,
      componentId: opt.fromMaster ? componentIdOf(opt.value) : null,
      notes: f.notes.trim() || (opt.fromMaster ? opt.label : ''),
    };
  };

  /** Client-side validity. The server re-validates all of it; this only avoids a round trip. */
  const formInvalid = (f: FormState): string | null => {
    if (!isPeriod(f.payPeriod)) return 'periodInvalid';
    const opt = itemByValue.get(f.item);
    if (!opt) return 'rowIncomplete';
    if (!f.txnDate) return 'rowIncomplete';
    if (monthBounds && (f.txnDate < monthBounds.min || f.txnDate > monthBounds.max)) return 'dateOutOfPeriod';
    if (f.quantity.trim() !== '' && !Number.isFinite(Number(f.quantity))) return 'rowIncomplete';
    // 2da9937a — THE MAGNITUDE RULE IS NARROWED, NOT DELETED. On an item that works its own amount out the
    // operator has no Amount box to be wrong about, so "amount must be greater than zero" would be a
    // refusal about a field they cannot reach; what they can be missing is the QUANTITY the rule reads.
    // The check itself survives — it just moves onto the derived figure, which is what actually gets
    // stored, and which the service asserts again authoritatively.
    if (opt.derives) {
      if (opt.inputUnit && (f.unit !== opt.inputUnit || !(Number(f.quantity) > 0))) {
        return opt.inputUnit === 'hours' ? 'quantityRequiredHours' : 'quantityRequiredDays';
      }
      if (derivedError) return derivedError;
      if (derivedAmount == null) return 'derivedAmountPending';
      if (!(Number(derivedAmount) > 0)) return 'amountNotPositive';
      return null;
    }
    if (!(Number(f.amount) > 0)) return 'amountNotPositive';
    return null;
  };

  /**
   * 4e403268 — the day grid's client-side validity, per line and then for the grid as a whole.
   *
   * `dayLineIssue` (day-lines.ts, pure) is the per-line half and mirrors `formInvalid` above field for
   * field. The service re-validates every one of them inside the write transaction — `assertDateInPeriod`,
   * the derived amount, `AmountNotPositiveError`, `DuplicateTxnRowError` — so this only avoids a round trip
   * and, more usefully, marks WHICH row is at fault instead of failing a grid of twenty at the end.
   */
  const dailyIssueFor = useCallback(
    (line: DayLine): string | null =>
      dayLineIssue(line, {
        bounds: monthBounds,
        requiredUnit,
        derives,
        derivedAmount: dailyAmountFor(line),
      }),
    [monthBounds, requiredUnit, derives, dailyAmountFor],
  );
  const dailyInvalid = (d: DailyState): string | null => {
    if (!isPeriod(d.payPeriod)) return 'periodInvalid';
    if (!itemByValue.get(d.item)) return 'rowIncomplete';
    if (d.lines.length === 0) return 'dayGridEmpty';
    if (dailyDerivedCurrent?.error) return dailyDerivedCurrent.error;
    if (dailyDuplicateKeys.length > 0) return 'duplicateRow';
    for (const l of d.lines) {
      const issue = dailyIssueFor(l);
      if (issue) return issue;
    }
    return null;
  };

  /**
   * A copy the operator has not changed would post a second, byte-identical transaction. That is exactly
   * the double-post `DuplicateTxnRowError` rejects within one grid submission — but across submissions
   * the service does not (and should not) refuse it: two identical claims on one day are occasionally
   * real. So this warns and does not block, which is the honest position for something we cannot know.
   */
  const identicalExisting = useMemo(() => {
    if (!form || form.mode !== 'create') return false;
    const r = resolveItem(form);
    // The figure that will be POSTED, which on a calculating item is the derived one — comparing the empty
    // Amount box against the ledger would report every such copy as identical.
    const amt = effectiveAmount;
    if (!Number.isFinite(amt) || amt === 0) return false;
    return panel.rows.some(
      (x) =>
        x.kind === r.kind &&
        x.txnDate === form.txnDate &&
        Number(x.amount) === amt &&
        (x.notes ?? '').trim().toLowerCase() === r.notes.trim().toLowerCase(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, panel.rows, itemByValue, effectiveAmount]);

  /** The ONE write path for the form, so "Save", "Save & add another" and the save-before-switching
   *  button in the unsaved-changes dialog cannot drift apart. An edit patches the row; anything else —
   *  including the save of a Duplicate — is an ordinary create. */
  const runSave = async (f: FormState): Promise<TxnActionResult> => {
    if (!selected) return { ok: false, error: 'noEmployeesSelected' };
    const r = resolveItem(f);
    const quantity = f.quantity.trim() === '' ? null : Number(f.quantity);
    const unit = f.unit === '' ? null : f.unit;
    const common = {
      kind: r.kind,
      componentId: r.componentId,
      txnDate: f.txnDate,
      // 2da9937a — on a calculating item this is the figure the SERVER already worked out and showed the
      // operator. The server re-derives it on the write and overwrites whatever arrives, so this is what
      // was on screen rather than a value the browser gets to decide.
      amount: effectiveAmount,
      quantity,
      unit,
      notes: r.notes || null,
    };
    return f.mode === 'edit' && f.id
      ? updateIndividualTxnAction({ id: f.id, companyId: selected.companyId, ...common })
      : createIndividualTxnAction({
          employmentId: selected.employmentId,
          companyId: selected.companyId,
          payPeriod: f.payPeriod,
          batchId: resolvedBatchId,
          ...common,
        });
  };

  /**
   * 4e403268 — the day grid's ONE write path. All lines or none.
   *
   * The atomicity is INHERITED, not built here: `createIndividualTxnDayGridAction` hands the whole set to
   * `createIndividualTxnsBulk`, which has done many rows in a single transaction since 1.2.2 with every
   * guard re-checked inside it. A partial save is therefore not something this screen has to prevent — it
   * is something the service cannot produce.
   *
   * The AMOUNT sent per line is the server's own figure where the item calculates. It is re-derived on the
   * write regardless, so this is "what was on screen", not a number the browser gets a vote on.
   */
  const runDailySave = async (d: DailyState): Promise<TxnActionResult & { count?: number }> => {
    if (!selected) return { ok: false, error: 'noEmployeesSelected' };
    const opt = itemByValue.get(d.item) ?? itemOptions[0];
    const componentId = opt.fromMaster ? componentIdOf(opt.value) : null;
    return createIndividualTxnDayGridAction({
      employmentId: selected.employmentId,
      companyId: selected.companyId,
      payPeriod: d.payPeriod,
      batchId: resolvedBatchId,
      kind: opt.kind,
      componentId,
      unit: requiredUnit ?? null,
      lines: d.lines.map((l) => ({
        txnDate: l.txnDate,
        amount: Number(dailyAmountFor(l) ?? 0),
        quantity: l.quantity.trim() === '' ? null : Number(l.quantity),
        // Same default the single form applies: an unlabelled line on a named pay item takes the item's
        // own label, so the ledger reads as the pay item rather than as a blank.
        notes: l.notes.trim() || (opt.fromMaster ? opt.label : null),
      })),
    });
  };

  const submitDaily = () => {
    if (!daily) return;
    const bad = dailyInvalid(daily);
    if (bad) {
      setFormError(t(bad as never));
      return;
    }
    const d = daily;
    startTransition(async () => {
      const res = await runDailySave(d);
      if (!res.ok) {
        setFormError(t(res.error as never));
        return;
      }
      setFormError(null);
      refreshPanel();
      if (res.recalcBatchId) setRecalcBatchId(res.recalcBatchId);
      toast.success(t('dayGridSaved', { count: res.count ?? d.lines.length }));
      // Land the operator on the grouped view, where the days they just keyed are one line with a total —
      // which is the thing they came to see and the reason grouping is part of this item at all.
      setListView('grouped');
      closeForm();
    });
  };

  const submitForm = (addAnother: boolean) => {
    if (!form) return;
    const bad = formInvalid(form);
    if (bad) {
      setFormError(t(bad as never));
      return;
    }
    const f = form;
    startTransition(async () => {
      const res = await runSave(f);
      if (!res.ok) {
        setFormError(t(res.error as never));
        return;
      }
      setFormError(null);
      refreshPanel();
      if (res.recalcBatchId) setRecalcBatchId(res.recalcBatchId);
      toast.success(t(f.mode === 'edit' ? 'updated' : 'created'));
      if (addAnother && f.mode === 'create') openForm(blankForm(f.payPeriod));
      else closeForm();
    });
  };

  const doDelete = (id: string) => {
    startTransition(async () => {
      const res = await deleteIndividualTxnAction({ id });
      setConfirmDeleteId(null);
      if (res.ok) {
        refreshPanel();
        if (res.recalcBatchId) setRecalcBatchId(res.recalcBatchId);
        toast.success(t('deleted'));
        if (form?.id === id) closeForm();
      } else {
        toast.error(t(res.error as never));
      }
    });
  };

  /** Switching employees with an unsaved form asks first — the request's third workflow requirement. */
  const requestSelect = (id: string) => {
    if (id === selectedId) return;
    if (dirty) {
      setPendingEmployeeId(id);
      return;
    }
    closeForm();
    resetListingView();
    setSelectedId(id);
  };
  const completeSwitch = () => {
    const id = pendingEmployeeId;
    setPendingEmployeeId(null);
    if (!id) return;
    closeForm();
    resetListingView();
    setSelectedId(id);
  };
  /** Save first, then switch — and if the save fails, do NOT switch. Navigating away from a failed save
   *  is exactly the loss this dialog exists to prevent. */
  const saveThenSwitch = () => {
    // 4e403268 — the unsaved-changes dialog protects whichever machine is open. A day grid is unsaved work
    // in exactly the same sense, so Save-then-switch has to be able to save one.
    if (daily) {
      const badDaily = dailyInvalid(daily);
      if (badDaily) {
        setPendingEmployeeId(null);
        setFormError(t(badDaily as never));
        return;
      }
      const d = daily;
      startTransition(async () => {
        const res = await runDailySave(d);
        if (res.ok) {
          toast.success(t('dayGridSaved', { count: res.count ?? d.lines.length }));
          completeSwitch();
        } else {
          setPendingEmployeeId(null);
          setFormError(t(res.error as never));
        }
      });
      return;
    }
    if (!form) return;
    const bad = formInvalid(form);
    if (bad) {
      setPendingEmployeeId(null);
      setFormError(t(bad as never));
      return;
    }
    const f = form;
    startTransition(async () => {
      const res = await runSave(f);
      if (res.ok) {
        toast.success(t(f.mode === 'edit' ? 'updated' : 'created'));
        // Deliberately NOT carried across the switch: the banner names a run the operator is leaving, and
        // the run's own page (and its History) is where the mark persists. `completeSwitch` clears it.
        completeSwitch();
      } else {
        setPendingEmployeeId(null);
        setFormError(t(res.error as never));
      }
    });
  };

  // 510f4bd1 — four states ship, and this is all four. `Processing`, `Reprocessed` and `Failed` (three of
  // the six the request listed) are deliberately absent, and NOT because the code has no such states: it
  // does. Reprocessing runs INLINE (reprocessBatchSelective → generatePayslips), so 'running' is only ever
  // returned to a concurrent duplicate submit and 'failed' is written and then RE-THROWN to the caller.
  // Neither is a RESTING state a transaction row can be rendered in, and a failed reprocess correctly
  // leaves the row exactly where it was: Pending reprocessing. `Reprocessed` and `Processed` say the same
  // thing once the line is back in the payslip.
  const statusLabel = (r: TxnPanelRow) =>
    r.status === 'reprocessRequired'
      ? t('statusReprocessRequired')
      : r.status === 'processed'
        ? t('statusProcessed')
        : r.attached
          ? t('statusPending')
          : t('statusAwaitingRun');
  const statusBadge = (r: TxnPanelRow) =>
    r.status === 'reprocessRequired' ? (
      <Badge variant="danger">{statusLabel(r)}</Badge>
    ) : r.status === 'processed' ? (
      <Badge variant="success">{statusLabel(r)}</Badge>
    ) : r.attached ? (
      <Badge variant="info">{statusLabel(r)}</Badge>
    ) : (
      <Badge variant="warning">{statusLabel(r)}</Badge>
    );

  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortTh = (key: SortKey, label: string, extra = '') => (
    <th className={`px-3 py-2 font-medium ${extra}`}>
      <button type="button" onClick={() => toggleSort(key)} className="uppercase tracking-wide hover:text-foreground">
        {label}
        {arrow(key)}
      </button>
    </th>
  );

  return (
    <CollapsibleEmployeePanel
      defaultOpen={panelDefaultOpen}
      cookieKey={panelCookieKey}
      hideLabel={t('hideEmployees')}
      showLabel={t('showEmployees')}
      // 009c8a37 — the header row: who is selected, the ONE button, and the Hide/Show control last, on one
      // horizontal line. Before this the identity sat inside the big Card below while the control had a
      // row of its own in the left column, which is the misalignment the reporter marked in red.
      title={t('title')}
      detailHeader={
        selected ? (
          <>
            <div className="min-w-0 flex-1">
              <EmployeeName
                code={selected.employeeCode}
                name={selected.name}
                className="text-sm font-semibold text-foreground"
              />
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {selected.company} · {selected.department ?? '—'} · {selected.position ?? '—'}
              </p>
              {/* 510f4bd1 — the employee's PAYROLL status, one line, beside their name. It can read
                  Reprocess required while every transaction below reads Processed: this line is about
                  their payslip, the badges are about their transactions. The link goes to the run,
                  where Reprocess arrives with this person already ticked. */}
              {reprocessRuns.length > 0 && (
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <Badge variant="danger">{t('employeeReprocessRequired')}</Badge>
                  {reprocessRuns.map((b) => (
                    <Link
                      key={b.id}
                      href={`/payroll/${b.id}`}
                      className="font-medium text-red-700 underline underline-offset-2 dark:text-red-400"
                    >
                      {t('employeeReprocessLink', { period: b.payPeriod })}
                    </Link>
                  ))}
                </span>
              )}
            </div>
            {/* 4e403268 — also disabled while the day grid is open: Add would silently discard it. */}
            <Button type="button" size="sm" onClick={startCreate} disabled={form?.mode === 'create' || daily != null}>
              {t('addTxn')}
            </Button>
          </>
        ) : undefined
      }
      panel={
        /* ────────────────── LEFT PANEL — employees ────────────────── */
        <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('employeesPanel')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('employeesPanelHint')}</p>
        </div>
        <div className="space-y-3 border-b border-border p-3">
          <Field label={t('company')}>
            <select value={companyId} onChange={(e) => changeCompany(e.target.value)} className={inputCls}>
              {companies.length > 1 && <option value="">—</option>}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('businessUnitFilter')}>
              <select value={businessUnitFilter} onChange={(e) => changeBusinessUnit(e.target.value)} className={inputCls}>
                <option value="">{t('allBusinessUnits')}</option>
                {businessUnitOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('deptFilter')}>
              <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className={inputCls}>
                <option value="">{t('allDepartments')}</option>
                {departmentOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('statusFilter')}>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputCls}>
                <option value="">{t('allStatuses')}</option>
                <option value="active">{t('statusActive')}</option>
                <option value="ended">{t('statusEnded')}</option>
              </select>
            </Field>
            {/* The period narrows the TRANSACTIONS shown on the right, not which employees are listed —
                labelled so it cannot be read as an employee filter. */}
            <Field label={t('periodFilter')}>
              <input type="month" value={periodFilter} onChange={(e) => changePeriodFilter(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label={t('employeeSearch')}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {visibleEmployees.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noEmployees')}</p>
          )}
          {visibleEmployees.map((e) => {
            const active = e.employmentId === selectedId;
            return (
              <button
                key={e.employmentId}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => requestSelect(e.employmentId)}
                className={`flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted ${
                  active ? 'bg-primary/10' : ''
                }`}
              >
                <EmployeeName code={e.employeeCode} name={e.name} className="block font-medium text-foreground" />
                <span className="block truncate text-xs text-muted-foreground">
                  {e.company} · {e.department ?? '—'} · {e.status === 'active' ? t('statusActive') : t('statusEnded')}
                </span>
              </button>
            );
          })}
        </div>
          {capped && (
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              {t('showingCapped', { cap: EMPLOYEE_CAP, total: filteredEmployees.length })}
            </p>
          )}
        </Card>
      }
    >
      {/* ────────────────── RIGHT PANEL — that employee's one-off transactions ────────────────── */}
      <Card className="overflow-hidden">
        {!selected && (
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t('pickEmployeeTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('pickEmployeeBody')}</p>
          </div>
        )}

        {selected && (
          <>
            {/* 009c8a37 — the identity + Add button that used to open this Card are now the shell's header
                row, on the same horizontal line as the Hide/Show control. */}
            {/* Totals of exactly the rows below — never a second read that could disagree with them. */}
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border bg-muted/20 px-4 py-2.5 text-xs">
              <span className="text-muted-foreground">
                {t('totalEntered')}{' '}
                <span className="font-medium tabular-nums text-foreground">
                  {t('nTxns', { count: panel.totals.count })} · {rm(panel.totals.total)}
                </span>
              </span>
              <span className="text-muted-foreground">
                {t('totalPending')}{' '}
                <span className="font-medium tabular-nums text-amber-700 dark:text-amber-400">
                  {t('nTxns', { count: panel.totals.pendingCount })} · {rm(panel.totals.pendingTotal)}
                </span>
              </span>
              <span className="text-muted-foreground">
                {t('totalProcessed')}{' '}
                <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                  {t('nTxns', { count: panel.totals.processedCount })} · {rm(panel.totals.processedTotal)}
                </span>
              </span>
              {/* 510f4bd1 — the FOURTH figure, and a third bucket that is mutually exclusive with the other
                  two: how much of this employee's money is on a processed run but not in their payslip. */}
              <span className="text-muted-foreground">
                {t('totalReprocess')}{' '}
                <span className="font-medium tabular-nums text-red-700 dark:text-red-400">
                  {t('nTxns', { count: panel.totals.reprocessCount })} · {rm(panel.totals.reprocessTotal)}
                </span>
              </span>
              {periodFilter && <span className="text-muted-foreground">{t('periodScope', { period: periodFilter })}</span>}
              {panelLoading && <span className="text-muted-foreground">{t('alreadyLoading')}</span>}
            </div>

            {/* d0d2c9d1's stranded-money read: entries whose month's regular run has already gone. A fault
                alert, deliberately not a fourth status. */}
            {panel.stranded.length > 0 && (
              <div className="border-b border-border bg-red-50/60 px-4 py-2.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
                <p className="font-medium">{t('strandedTitle')}</p>
                <ul className="mt-1 space-y-0.5">
                  {panel.stranded.map((s) => (
                    <li key={s.payPeriod} className="tabular-nums">
                      {t('strandedLine', { period: s.payPeriod, count: s.count, amount: rm(s.total) })}
                    </li>
                  ))}
                </ul>
                <p className="mt-1">
                  {t('strandedHint')}{' '}
                  <Link className="underline underline-offset-2" href="/payroll/transaction-view?tab=outstanding">
                    {t('alreadyOutstanding')}
                  </Link>
                </p>
              </div>
            )}

            {/* 49e7e0a2 — the save landed on a processed run, so that run's payslips, statutory figures
                and totals no longer match the transactions behind them. This is the operator's route to
                putting them right; the mark itself lives on the run and refuses Close until it is
                cleared, so leaving this screen does not lose it. */}
            {recalcBatchId && (
              <div className="border-b border-border bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-300">
                <p className="font-medium">{t('recalcNeededTitle')}</p>
                <p className="mt-1">
                  {t('recalcNeededBody')}{' '}
                  <Link href={`/payroll/${recalcBatchId}`} className="font-medium underline underline-offset-2">
                    {t('recalcNeededLink')}
                  </Link>
                </p>
              </div>
            )}

            {/* ── Create / Edit form ── */}
            {form && (
              <div className="space-y-3 border-b border-border bg-muted/10 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">
                    {form.mode === 'edit' ? t('editTxnTitle') : form.sourceId ? t('duplicateTxnTitle') : t('addTxnTitle')}
                  </h3>
                  {form.sourceId && <span className="text-xs text-muted-foreground">{t('duplicateHint')}</span>}
                </div>

                {/* 4e403268 — the request's Input Method selector. Offered on a NEW entry only: an existing
                    row IS one day, and opening five days to edit one of them would be a grid that can
                    delete lines the operator never opened. One total for the month is the default and is
                    the screen exactly as it was, so nothing anybody already does changes. */}
                {form.mode === 'create' && (
                  <InputMethod mode="lump" onLump={switchToLump} onDaily={switchToDaily} t={t} />
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label={t('monthLabel')}>
                    <input
                      type="month"
                      value={form.payPeriod}
                      disabled={form.mode === 'edit'}
                      onChange={(e) => patchForm({ payPeriod: e.target.value, txnDate: '' })}
                      className={inputCls}
                    />
                  </Field>
                  <Field label={t('cycleLabel')}>
                    {eligibleBatches.length > 1 ? (
                      <select value={resolvedBatchId} onChange={(e) => patchForm({ batchId: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {eligibleBatches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {cycleLabel(b)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="px-1 py-2 text-sm text-muted-foreground">
                        {eligibleBatches.length === 1 ? cycleLabel(eligibleBatches[0]) : t('pendingRun')}
                      </p>
                    )}
                  </Field>
                  <Field label={t('colItem')}>
                    <select value={form.item} onChange={(e) => changeItem(e.target.value)} className={inputCls}>
                      <optgroup label={t('itemGroupGeneral')}>
                        {genericKinds.map((k) => (
                          <option key={k} value={`k:${k}`}>
                            {t(`kindLabel.${k}`)}
                          </option>
                        ))}
                      </optgroup>
                      {masterEarnings.length > 0 && (
                        <optgroup label={t('itemGroupEarnings')}>
                          {masterEarnings.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {masterDeductions.length > 0 && (
                        <optgroup label={t('itemGroupDeductions')}>
                          {masterDeductions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </Field>
                  <Field label={t('colEffectiveDate')}>
                    <input
                      type="date"
                      value={form.txnDate}
                      min={monthBounds?.min}
                      max={monthBounds?.max}
                      onChange={(e) => patchForm({ txnDate: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                  {/* 2da9937a — a calculating item OWNS the Input Type: the quantity has to land in the
                      input its rule reads, so the select is fixed to it rather than left to be got wrong. */}
                  <Field label={t('inputType')}>
                    <select
                      value={form.unit}
                      disabled={requiredUnit != null}
                      onChange={(e) => patchForm({ unit: e.target.value })}
                      className={inputCls}
                    >
                      <option value="">{t('inputTypeNone')}</option>
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          {t(`unitLabel.${u}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={requiredUnit ? t(`quantityLabel.${requiredUnit}` as never) : t('quantity')}>
                    <input
                      type="number"
                      step="0.01"
                      min={requiredUnit ? '0' : undefined}
                      value={form.quantity}
                      onChange={(e) => patchForm({ quantity: e.target.value })}
                      className={`${inputCls} text-right`}
                    />
                  </Field>
                  {/* THE AMOUNT BOX. On an item that works its own amount out it is READ-ONLY and shows the
                      server's figure — the operator is being shown what will be paid, not asked for it. */}
                  <Field label={derives ? t('derivedAmountLabel') : t('colAmount')}>
                    <input
                      type={derives ? 'text' : 'number'}
                      min={derives ? undefined : '0'}
                      step={derives ? undefined : '0.01'}
                      readOnly={derives}
                      aria-readonly={derives || undefined}
                      value={derives ? (derivedPending ? t('derivedAmountPending') : (derivedAmount ?? '—')) : form.amount}
                      onChange={(e) => patchForm({ amount: e.target.value })}
                      className={`${inputCls} text-right${derives ? ' bg-muted/40 text-muted-foreground' : ''}`}
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label={t('colRemarks')}>
                      <input
                        type="text"
                        value={form.notes}
                        placeholder={t('notesPlaceholder')}
                        onChange={(e) => patchForm({ notes: e.target.value })}
                        className={inputCls}
                      />
                    </Field>
                  </div>
                </div>

                {/* Two different statements, and which one is true depends on the item picked: a plain
                    amount item is paid as typed; a calculating item is paid what its own rule produces. */}
                <p className="text-xs text-muted-foreground">
                  {derives ? t(requiredUnit ? `derivedAmountHint.${requiredUnit}` : 'derivedAmountHint.none') : t('amountIsFinalHint')}
                </p>
                {/* The figure is a real 0 because a live divisor was zero for this employee this month —
                    the explanation, in the same words the pay-item screen uses, rather than an unexplained
                    RM 0.00 that the save will then refuse. */}
                {derivedZeroDivisor && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                    {derivedZeroDivisor}
                  </p>
                )}
                {derivedError && <p className="text-xs text-destructive">{t(derivedError as never)}</p>}
                {requireComponent && <p className="text-xs text-muted-foreground">{t('componentRequiredHint')}</p>}
                {periodKeyed && isPeriod(form.payPeriod) && (
                  <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
                    {t('noDraftYetNotice', { period: form.payPeriod })}{' '}
                    <Link href={processHref} className="font-medium underline underline-offset-2">
                      {t('noDraftForSelectionLink')}
                    </Link>
                  </p>
                )}
                {identicalExisting && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                    {t('identicalWarning')}
                  </p>
                )}
                {/* 49e7e0a2 — WHAT THIS SAVE IS ABOUT TO MAKE OUT OF DATE. Shown before Save, not after,
                    because after is too late: by the time a run is Processed the payslips exist, the
                    statutory figures have moved and the bank file and returns are exportable. The first
                    line always appears for a processed run; the two below it appear only when that
                    particular run has actually sent something out, so the warning never overstates. */}
                {targetProcessed && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                    <p className="font-medium">{t('processedEditTitle')}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {impact?.paymentDisbursed && <li>{t('processedEditPaymentExported')}</li>}
                      {impact?.statutoryFiled && (
                        <li>{t('processedEditStatutoryFiled', { count: impact.statutoryReportCount })}</li>
                      )}
                      <li>{t('processedEditMarksRecalc')}</li>
                    </ul>
                  </div>
                )}
                {formError && <p className="text-sm text-destructive">{formError}</p>}

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" onClick={() => submitForm(false)} disabled={isPending}>
                    {isPending ? t('saving') : t('save')}
                  </Button>
                  {form.mode === 'create' && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => submitForm(true)} disabled={isPending}>
                      {t('saveAndAnother')}
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" onClick={closeForm} disabled={isPending}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            )}

            {/* ── 4e403268 — DAY-BY-DAY ENTRY ──
                A sibling block rather than a branch inside the form above, because the two are different
                machines: one row with a date and a quantity, versus a header plus a LIST of dated lines.
                They are mutually exclusive (`openForm` and `openDaily` each clear the other), so only one
                is ever on screen and they look like one panel.

                THE MONTH, THE RUN AND THE PAY ITEM ARE THE HEADER. That is the whole point of the change:
                today five days means opening the form five times and re-picking the pay item each time. */}
            {daily && (
              <div className="space-y-3 border-b border-border bg-muted/10 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">{t('dayGridTitle')}</h3>
                </div>

                <InputMethod mode="daily" onLump={switchToLump} onDaily={switchToDaily} t={t} />

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label={t('monthLabel')}>
                    <input
                      type="month"
                      value={daily.payPeriod}
                      onChange={(e) =>
                        // Every line's date belongs to the month; changing the month invalidates all of
                        // them, so they are cleared rather than left to fail validation one by one.
                        patchDaily({
                          payPeriod: e.target.value,
                          lines: daily.lines.map((l) => ({ ...l, txnDate: '' })),
                        })
                      }
                      className={inputCls}
                    />
                  </Field>
                  <Field label={t('cycleLabel')}>
                    {eligibleBatches.length > 1 ? (
                      <select value={resolvedBatchId} onChange={(e) => patchDaily({ batchId: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {eligibleBatches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {cycleLabel(b)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="px-1 py-2 text-sm text-muted-foreground">
                        {eligibleBatches.length === 1 ? cycleLabel(eligibleBatches[0]) : t('pendingRun')}
                      </p>
                    )}
                  </Field>
                  <Field label={t('colItem')}>
                    <select value={daily.item} onChange={(e) => changeDailyItem(e.target.value)} className={inputCls}>
                      <optgroup label={t('itemGroupGeneral')}>
                        {genericKinds.map((k) => (
                          <option key={k} value={`k:${k}`}>
                            {t(`kindLabel.${k}`)}
                          </option>
                        ))}
                      </optgroup>
                      {masterEarnings.length > 0 && (
                        <optgroup label={t('itemGroupEarnings')}>
                          {masterEarnings.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {masterDeductions.length > 0 && (
                        <optgroup label={t('itemGroupDeductions')}>
                          {masterDeductions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </Field>
                </div>

                {/* THE GRID. `unit` is not a per-line choice — the pay item owns it (2da9937a), and a
                    grid where each line could disagree about whether it holds hours or days is a grid
                    whose total means nothing. It is stated once, in the column heading. */}
                <div className="overflow-x-auto rounded-lg border border-border bg-background">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">{t('colEffectiveDate')}</th>
                        <th className="px-3 py-2 font-medium">{t('dayOfWeek')}</th>
                        <th className="px-3 py-2 text-right font-medium">
                          {requiredUnit ? t(`quantityLabel.${requiredUnit}` as never) : t('quantity')}
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          {derives ? t('derivedAmountLabel') : t('colAmount')}
                        </th>
                        <th className="px-3 py-2 font-medium">{t('colRemarks')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {daily.lines.map((l) => {
                        const dk = dayKeyOf(l.txnDate);
                        const lineAmount = dailyAmountFor(l);
                        const issue = dailyIssueFor(l);
                        const isDupe = dailyDuplicateKeys.includes(l.key);
                        return (
                          <tr key={l.key} className={isDupe ? 'bg-red-50/60 dark:bg-red-500/10' : ''}>
                            <td className="px-3 py-2">
                              <input
                                type="date"
                                aria-label={t('colEffectiveDate')}
                                value={l.txnDate}
                                min={monthBounds?.min}
                                max={monthBounds?.max}
                                onChange={(e) => patchDailyLine(l.key, { txnDate: e.target.value })}
                                className={inputCls}
                              />
                            </td>
                            {/* DERIVED FOR DISPLAY, NEVER STORED, and pinned to UTC midnight so the label
                                is a fact about the calendar day rather than about the operator's timezone
                                (day-lines.ts `dayOfWeekIndex`). */}
                            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                              {dk ? t(`dayShort.${dk}` as never) : '—'}
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                aria-label={requiredUnit ? t(`quantityLabel.${requiredUnit}` as never) : t('quantity')}
                                value={l.quantity}
                                onChange={(e) => patchDailyLine(l.key, { quantity: e.target.value })}
                                className={`${inputCls} text-right`}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type={derives ? 'text' : 'number'}
                                min={derives ? undefined : '0'}
                                step={derives ? undefined : '0.01'}
                                readOnly={derives}
                                aria-readonly={derives || undefined}
                                aria-label={derives ? t('derivedAmountLabel') : t('colAmount')}
                                value={
                                  derives
                                    ? dailyDerivedPending
                                      ? t('derivedAmountPending')
                                      : (lineAmount ?? '—')
                                    : l.amount
                                }
                                onChange={(e) => patchDailyLine(l.key, { amount: e.target.value })}
                                className={`${inputCls} text-right${derives ? ' bg-muted/40 text-muted-foreground' : ''}`}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="text"
                                aria-label={t('colRemarks')}
                                value={l.notes}
                                placeholder={t('notesPlaceholder')}
                                onChange={(e) => patchDailyLine(l.key, { notes: e.target.value })}
                                className={inputCls}
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex flex-col items-end gap-1">
                                <RowAction
                                  label={t('gridDeleteRow')}
                                  tone="danger"
                                  disabled={daily.lines.length <= 1 || isPending}
                                  onClick={() => removeDailyLine(l.key)}
                                />
                                {/* The refusal names the ROW. Failing a grid of twenty at the end and
                                    saying only "amount must be greater than zero" is what makes bulk
                                    entry worse than one-at-a-time, not better. */}
                                {issue && !isDupe && (
                                  <span className="text-[11px] text-destructive">{t(issue as never)}</span>
                                )}
                                {isDupe && <span className="text-[11px] text-destructive">{t('duplicateRow')}</span>}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {/* RUNNING TOTALS — the request's point 7. The money total is withheld (not shown as a
                        partial sum) while any line's figure is still unknown; see dayLineTotals. */}
                    <tfoot className="border-t-2 border-border bg-muted/30 text-sm font-medium">
                      <tr>
                        <td className="px-3 py-2" colSpan={2}>
                          {t('dayGridTotal', { count: dailyTotals?.count ?? 0 })}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {dailyTotals?.quantity ??
                            /* No line carries a quantity — an item that needs none. */ '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {dailyTotals?.amount != null ? rm(dailyTotals.amount) : t('derivedAmountPending')}
                        </td>
                        <td className="px-3 py-2" colSpan={2} />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={addDailyLine} disabled={isPending}>
                    {t('dayGridAddDate')}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  {derives
                    ? t(requiredUnit ? `derivedAmountHint.${requiredUnit}` : 'derivedAmountHint.none')
                    : t('amountIsFinalHint')}
                </p>
                {/* THE ROUNDING NOTE, ON SCREEN RATHER THAN IN THE RELEASE NOTES. Each day is priced and
                    rounded to the cent on its own, so a split can total a cent away from the same
                    quantity keyed as one figure (15.00 hours = RM584.13 in one line, RM584.14 across
                    five). Per-day is the right answer — the amount shown against a date has to be what
                    that date is worth — but it is a surprise unless it is said. */}
                {derives && <p className="text-xs text-muted-foreground">{t('dayGridRoundingHint')}</p>}
                {dailyDerivedCurrent?.zeroDivisor && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                    {dailyDerivedCurrent.zeroDivisor}
                  </p>
                )}
                {dailyDerivedCurrent?.error && (
                  <p className="text-xs text-destructive">{t(dailyDerivedCurrent.error as never)}</p>
                )}
                {/* An item with NO rule at all — ABSENT and UNPAID LEAVE on this tenant today. The grid
                    still records the days; the amount is simply the operator's to key until a formula is
                    set on the item in Payroll Item Master. Said plainly rather than leaving a read-only
                    box showing a dash. */}
                {pickedItem?.fromMaster && !derives && (
                  <p className="text-xs text-muted-foreground">{t('dayGridNoRuleHint')}</p>
                )}
                {requireComponent && <p className="text-xs text-muted-foreground">{t('componentRequiredHint')}</p>}
                {periodKeyed && isPeriod(daily.payPeriod) && (
                  <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
                    {t('noDraftYetNotice', { period: daily.payPeriod })}{' '}
                    <Link href={processHref} className="font-medium underline underline-offset-2">
                      {t('noDraftForSelectionLink')}
                    </Link>
                  </p>
                )}
                {targetProcessed && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                    <p className="font-medium">{t('processedEditTitle')}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {impact?.paymentDisbursed && <li>{t('processedEditPaymentExported')}</li>}
                      {impact?.statutoryFiled && (
                        <li>{t('processedEditStatutoryFiled', { count: impact.statutoryReportCount })}</li>
                      )}
                      <li>{t('processedEditMarksRecalc')}</li>
                    </ul>
                  </div>
                )}
                {formError && <p className="text-sm text-destructive">{formError}</p>}

                <div className="flex flex-wrap items-center gap-2">
                  {/* ONE save for every line. Not "save each row" — the service writes the whole set in one
                      transaction, so a failure on line nine cannot leave lines one to eight behind. */}
                  <Button type="button" size="sm" onClick={submitDaily} disabled={isPending}>
                    {isPending ? t('saving') : t('dayGridSave')}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={closeForm} disabled={isPending}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            )}

            {/* ── Itemised listing ── */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <input
                type="search"
                value={rowQuery}
                onChange={(e) => {
                  setRowQuery(e.target.value);
                  setPage(0);
                }}
                placeholder={t('searchTxnPlaceholder')}
                className={`${inputCls} max-w-xs`}
              />
              <div className="flex flex-wrap items-center gap-3">
                {/* 4e403268 — the request's point 16: the daily records do NOT disappear once payroll is
                    processed, they become the audit trail behind the figure. Flat is still the default, so
                    nobody's screen changes under them; grouped is one click and shows the month + pay item
                    with its totals, with the days one click further. */}
                <div className="flex rounded-md border border-border p-0.5 text-xs">
                  {(['flat', 'grouped'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setListView(v)}
                      aria-pressed={listView === v}
                      className={`rounded px-2 py-1 transition-colors ${
                        listView === v ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {t(v === 'flat' ? 'listViewFlat' : 'listViewGrouped')}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  {listView === 'grouped'
                    ? t('nGroups', { count: groups.length })
                    : t('nShown', { count: sortedRows.length })}
                </span>
              </div>
            </div>

            {/* ── 4e403268 — GROUPED BY MONTH + PAY ITEM ──
                One line per (month, pay item) with the summed quantity and the summed amount, and the days
                behind it one click away. Nothing here is stored: `buildTxnGroups` is a pure derivation over
                the rows already on screen (existing-context.ts), which is why it cannot disagree with the
                flat list beside it.

                THE STATUS IS THE CONSERVATIVE ROLL-UP. A group holding one line that is not in the
                employee's latest payslip is NOT "Processed", and neither is a group holding one unpaid
                line — 510f4bd1 split that verdict three ways precisely so the screen could stop
                overclaiming, and a group must not put it back together. */}
            {listView === 'grouped' && (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="w-8 px-2 py-2" />
                      <th className="px-3 py-2 font-medium">{t('monthLabel')}</th>
                      <th className="px-3 py-2 font-medium">{t('colItem')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('dayGridDays')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('quantity')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('colAmount')}</th>
                      <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {groups.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                          {panelLoading ? t('alreadyLoading') : t('noTxnsYet')}
                        </td>
                      </tr>
                    )}
                    {groups.map((g) => {
                      const open = expandedGroupKey === g.key;
                      return (
                        <Fragment key={g.key}>
                          <tr
                            className={`cursor-pointer transition-colors hover:bg-muted/30 ${open ? 'bg-muted/30' : ''}`}
                            onClick={() => setExpandedGroupKey((k) => (k === g.key ? null : g.key))}
                          >
                            <td className="px-2 py-2 text-center align-middle">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedGroupKey((k) => (k === g.key ? null : g.key));
                                }}
                                aria-expanded={open}
                                aria-label={t('dayGridViewDays')}
                                className="text-muted-foreground transition-colors hover:text-foreground"
                              >
                                <span className={`inline-block text-xs transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
                              </button>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums">{g.payPeriod}</td>
                            <td className="whitespace-nowrap px-3 py-2">
                              {g.componentCode ? (
                                <>
                                  <span className="font-mono text-xs">{g.componentCode}</span>{' '}
                                  <span className="text-muted-foreground">{g.componentName}</span>
                                </>
                              ) : (
                                t(`kindLabel.${g.kind}` as never)
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{g.count}</td>
                            {/* A DASH, NOT A NUMBER, when the group's units disagree or a line carries no
                                quantity: two hours and three days do not add up to five of anything, and a
                                figure there would be contradicted by the rows one click below it. */}
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {g.quantity != null && g.unit
                                ? `${Number(g.quantity)} ${t(`unitLabel.${g.unit}` as never)}`
                                : '—'}
                            </td>
                            <td className="px-3 py-2 text-right font-medium tabular-nums">{rm(g.total)}</td>
                            <td className="px-3 py-2">
                              <Badge
                                variant={
                                  g.status === 'reprocessRequired' ? 'danger' : g.status === 'processed' ? 'success' : 'info'
                                }
                              >
                                {g.status === 'reprocessRequired'
                                  ? t('statusReprocessRequired')
                                  : g.status === 'processed'
                                    ? t('statusProcessed')
                                    : t('statusPending')}
                              </Badge>
                            </td>
                          </tr>
                          {open && (
                            <tr className="bg-muted/20">
                              <td colSpan={7} className="px-3 pb-3 pt-1">
                                <table className="w-full text-xs">
                                  <thead className="text-left uppercase tracking-wide text-muted-foreground">
                                    <tr>
                                      <th className="px-2 py-1 font-medium">{t('colEffectiveDate')}</th>
                                      <th className="px-2 py-1 font-medium">{t('dayOfWeek')}</th>
                                      <th className="px-2 py-1 text-right font-medium">{t('quantity')}</th>
                                      <th className="px-2 py-1 text-right font-medium">{t('colAmount')}</th>
                                      <th className="px-2 py-1 font-medium">{t('sourceLabel')}</th>
                                      <th className="px-2 py-1 font-medium">{t('colRemarks')}</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border/60">
                                    {g.rows.map((r) => {
                                      const dk = dayKeyOf(r.txnDate);
                                      return (
                                        <tr key={r.id}>
                                          <td className="whitespace-nowrap px-2 py-1 tabular-nums">{r.txnDate}</td>
                                          <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                                            {dk ? t(`dayShort.${dk}` as never) : '—'}
                                          </td>
                                          <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                                            {r.quantity != null
                                              ? `${Number(r.quantity)}${r.unit ? ` ${t(`unitLabel.${r.unit}` as never)}` : ''}`
                                              : '—'}
                                          </td>
                                          <td className="px-2 py-1 text-right tabular-nums">{rm(r.amount)}</td>
                                          {/* 'manual' on every row today — nothing writes another source
                                              yet. The column exists so Attendance and Leave can fill it
                                              in without this view being rebuilt. */}
                                          <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                                            {t(`sourceValue.${r.source}` as never)}
                                          </td>
                                          <td className="max-w-[18rem] truncate px-2 py-1 text-muted-foreground">
                                            {r.notes ?? '—'}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                                {/* Editing lives on the flat list, one click away. Duplicating every row
                                    action here would be a second copy of the delete confirmation and the
                                    edit form's open path, and the grouped view's job is to explain a
                                    figure, not to be a second keying surface. */}
                                <p className="mt-2 text-[11px] text-muted-foreground">{t('dayGridEditHint')}</p>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {listView === 'flat' && (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {sortTh('payPeriod', t('monthLabel'))}
                    {sortTh('kind', t('colItem'))}
                    <th className="px-3 py-2 font-medium">{t('colRemarks')}</th>
                    <th className="px-3 py-2 font-medium">{t('quantity')}</th>
                    {sortTh('txnDate', t('colEffectiveDate'))}
                    {sortTh('amount', t('colAmount'), 'text-right')}
                    {sortTh('status', t('colStatus'))}
                    <th className="px-3 py-2 font-medium text-right">{t('actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pageRows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                        {panelLoading ? t('alreadyLoading') : t('noTxnsYet')}
                      </td>
                    </tr>
                  )}
                  {pageRows.map((r) => (
                    // A row can render up to three <tr>s (itself, its expanded detail, its delete
                    // confirmation), so the key belongs on the Fragment, not on the first <tr>.
                    <Fragment key={r.id}>
                      <tr className={expandedId === r.id ? 'bg-muted/30' : ''}>
                        <td className="px-3 py-2 tabular-nums">{r.payPeriod}</td>
                        <td className="px-3 py-2">{t(`kindLabel.${r.kind}` as never)}</td>
                        <td className="max-w-[16rem] truncate px-3 py-2 text-muted-foreground">{r.notes ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {r.quantity != null ? `${Number(r.quantity)}${r.unit ? ` ${t(`unitLabel.${r.unit}` as never)}` : ''}` : '—'}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{r.txnDate}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{rm(r.amount)}</td>
                        <td className="px-3 py-2">{statusBadge(r)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap justify-end gap-1">
                            <RowAction label={t('view')} onClick={() => setExpandedId((id) => (id === r.id ? null : r.id))} />
                            <RowAction label={t('edit')} disabled={!r.editable || isPending} onClick={() => openFromRow(r, 'edit')} />
                            <RowAction label={t('duplicate')} disabled={isPending} onClick={() => openFromRow(r, 'duplicate')} />
                            <RowAction
                              label={t('delete')}
                              disabled={!r.editable || isPending}
                              onClick={() => setConfirmDeleteId(r.id)}
                              tone="danger"
                            />
                          </div>
                        </td>
                      </tr>
                      {expandedId === r.id && (
                        <tr className="bg-muted/30">
                          <td colSpan={8} className="px-3 pb-3 text-xs text-muted-foreground">
                            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
                              <Detail label={t('cycleLabel')} value={r.runType ? `${t(`cycle.${r.runType}` as never)}${(r.runSeq ?? 1) > 1 ? ` #${r.runSeq}` : ''}` : t('pendingRun')} />
                              <Detail label={t('colStatus')} value={statusLabel(r)} />
                              <Detail label={t('createdOn')} value={r.createdOn} />
                              <Detail label={t('createdBy')} value={r.createdBy ?? '—'} />
                              <div className="col-span-2 sm:col-span-4">
                                <Detail label={t('colRemarks')} value={r.notes ?? '—'} />
                              </div>
                            </dl>
                            {/* Two different statements, and they used to be one. `lockedHint` is now the
                                CLOSED case only — genuinely frozen, in the app and by the 0011 triggers.
                                A row on a processed run is still editable, and what the operator needs to
                                know there is the price of editing it, not that they cannot. */}
                            {!r.editable && <p className="mt-2 text-amber-700 dark:text-amber-400">{t('lockedHint')}</p>}
                            {/* 510f4bd1 — a THIRD statement, because `paidEditableHint` ("this has already
                                been paid on a processed run") is simply untrue of a row that is not in the
                                payslip. Saying it there would be the very confusion the request reports. */}
                            {r.editable && r.status === 'reprocessRequired' && (
                              <p className="mt-2 text-red-700 dark:text-red-400">{t('stalePendingHint')}</p>
                            )}
                            {r.editable && r.recalcOnEdit && r.status !== 'reprocessRequired' && (
                              <p className="mt-2 text-amber-700 dark:text-amber-400">{t('paidEditableHint')}</p>
                            )}
                            {/* The employee is waiting to be recalculated for a reason that is not THIS row
                                (attendance recompute, or another line that has since been deleted). Said
                                here rather than in the badge: the badge is about the row, this is not. */}
                            {r.status !== 'reprocessRequired' && r.batchNeedsRecalcForEmployment && (
                              <p className="mt-2 text-amber-700 dark:text-amber-400">{t('employeeReprocessHint')}</p>
                            )}
                          </td>
                        </tr>
                      )}
                      {confirmDeleteId === r.id && (
                        <tr className="bg-red-50/60 dark:bg-red-500/10">
                          <td colSpan={8} className="px-3 py-2.5 text-xs">
                            <div className="flex flex-wrap items-center gap-3">
                              <span className="text-red-700 dark:text-red-400">{t('deleteTxnBody')}</span>
                              <Button type="button" size="sm" variant="destructive" onClick={() => doDelete(r.id)} disabled={isPending}>
                                {t('delete')}
                              </Button>
                              <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>
                                {t('cancel')}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            )}

            {/* The pager belongs to the FLAT list. The grouped view is one line per month + pay item —
                a handful of rows even for an employee with a year of daily overtime — and paging it
                would split a month's groups across two pages for no benefit. */}
            {listView === 'flat' && pageCount > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs">
                <Button type="button" size="sm" variant="outline" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}>
                  {t('prevPage')}
                </Button>
                <span className="text-muted-foreground">{t('pageOf', { page: safePage + 1, total: pageCount })}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                >
                  {t('nextPage')}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Unsaved-changes gate on switching employee. Save is offered only when the form would actually
          save; otherwise the honest choices are discard and stay. */}
      {pendingEmployeeId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-lg">
            <h3 className="text-sm font-semibold text-foreground">{t('unsavedTitle')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('unsavedBody')}</p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setPendingEmployeeId(null)}>
                {t('cancel')}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={completeSwitch}>
                {t('discard')}
              </Button>
              {/* 4e403268 — Save is offered when EITHER machine would actually save. Offering it for an
                  invalid grid would put the operator one click from a refusal they cannot see the cause
                  of, because the failing row is behind a modal. */}
              <Button
                type="button"
                size="sm"
                disabled={
                  isPending ||
                  (form == null && daily == null) ||
                  (form != null && formInvalid(form) != null) ||
                  (daily != null && dailyInvalid(daily) != null)
                }
                onClick={saveThenSwitch}
              >
                {t('save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </CollapsibleEmployeePanel>
  );
}

function RowAction({
  label,
  onClick,
  disabled,
  tone,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border border-border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'danger'
          ? 'text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * 4e403268 — the request's Input Method selector, rendered identically above both machines so switching
 * feels like one control rather than two screens.
 *
 * Radios rather than a segmented button, because that is what the control MEANS: two mutually exclusive
 * ways to record the same thing, one of them currently chosen. A fieldset + legend is what gives a screen
 * reader the same grouping the sighted reader gets from the box.
 */
function InputMethod({
  mode,
  onLump,
  onDaily,
  t,
}: {
  mode: 'lump' | 'daily';
  onLump: () => void;
  onDaily: () => void;
  t: (key: string) => string;
}) {
  return (
    <fieldset className="rounded-md border border-border px-3 py-2">
      <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t('inputMethod')}</legend>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="txn-input-method"
            checked={mode === 'lump'}
            onChange={onLump}
            className="h-3.5 w-3.5 accent-primary"
          />
          <span>{t('inputMethodLump')}</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="txn-input-method"
            checked={mode === 'daily'}
            onChange={onDaily}
            className="h-3.5 w-3.5 accent-primary"
          />
          <span>{t('inputMethodDaily')}</span>
        </label>
      </div>
    </fieldset>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
