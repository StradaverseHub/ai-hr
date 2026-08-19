import Link from 'next/link';
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listPayComponents } from '@/core/pay-components';
import {
  INDIVIDUAL_TXN_STATUS_FILTERS,
  listFixedTransactionsAcross,
  listIndividualTxnCreators,
  listIndividualTxnsAcross,
  listPayslipSourceTxns,
  listProcessedPayslipsAcross,
  listUnattachedTxnSummary,
  type PayslipSourceTxnRow,
} from '@/core/payroll-view';
import { TXN_KINDS } from '@/core/payroll-individual-txn';
import { Badge, Button, Card, EmployeeName, Field, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { CollapsibleEmployeePanel, EmployeeScopePanel, type ScopeEmployee } from '@/components/collapsible-employee-panel';
import { payrollProcessBack } from '../back';
import { packFor } from '@/localization/registry';
import { IndividualTxnTable } from './individual-table';
import { OutstandingTable } from './outstanding-table';
import { HistoryTable } from './history-table';
import { HistoryGrid } from './history-grid';
import { cleanMonths, pivotHistoryGrid, type PayItemSubjectMap } from './history-pivot';
// 6b4ca488 — the Statutory Explanation tab. The DISPLAY is the same component /payroll/statutory-detail
// renders for the Individual Payslip's link, and the derivation takes no SessionContext, so this tab can
// neither grow a second display of one calculation nor recompute from today's configuration.
import { StatutoryDetailView } from '../statutory-detail/statutory-detail-view';
import { explainStatutory } from '@/core/statutory-explain';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Transaction View (feedback a4a05174; relocated to a top-level Payroll tab by feedback 59178702) —
 * the centralized READ-ONLY payroll transaction inquiry. Now a standalone module tab at
 * /payroll/transaction-view, peer to Payroll Process / Transactions / Reports / Settings; the old
 * /payroll/transactions/view path redirects here. Three tabs on one page (?tab= switch, single-pager
 * convention): Fixed (recurring items across every employee, incl. "by pay item → all employees
 * assigned"), Individual (dated one-offs across ALL batches by year/month/employee/company — the
 * keying screen is draft-batch-only), History (processed payslip results by
 * year/month/employee/company/cycle).
 *
 * STRICTLY read-only by design: no server actions, no create/edit/stop/archive controls — the
 * keying screens (fixed/, individual/, tp1/, zakat/) remain the only write surfaces. Filters are
 * plain GET forms, so the whole page stays a server component.
 *
 * i18n note: strings deliberately stay under the `payroll.transactions.view.*` namespace (and reuse
 * `payroll.list` / `payroll.batch` sibling column labels) — the page shares those keys with the
 * keying screens, so the namespace is NOT moved despite the route relocation.
 */

// 'outstanding' (feedback d0d2c9d1) is a 4th SUB-TAB, deliberately not a new top-level nav entry:
// test/payroll-flyout-nav.test.ts pins the six payroll destinations character for character and
// asserts no entry is invented, and a new one would also need packs/payroll/index.ts +
// lib/permissions.ts. A sub-tab needs none of that and inherits this route's scopedAdmin() fence.
// 080de5cf — 'grid' is a 5th SUB-TAB for the same reason 'outstanding' is a 4th: it is a second VIEW of
// the History data (item down the left, month across the top), not a new destination. A sub-tab needs no
// nav entry, no packs/payroll/index.ts change and no lib/permissions.ts column, and it inherits this
// route's scopedAdmin() fence — whereas a new route would need all three and would let the two views of
// one dataset drift apart.
// 6b4ca488 — 'statutory' is a 6th SUB-TAB, for the same reason 'outstanding' and 'grid' are a 4th and a
// 5th: it is another VIEW of the payslips History already lists, not a new destination. It shows the
// working behind EPF, SOCSO, EIS, SKBBK, HRDF and PCB for ONE payslip, rendered by the SAME
// `StatutoryDetailView` component that /payroll/statutory-detail renders for the Individual Payslip's
// link — one display, two doors, the shape 45df860a settled for the PCB working. A sub-tab needs no nav
// entry and no lib/permissions.ts column and inherits this route's scopedAdmin() fence; the standalone
// route DOES carry a column, registered on this same screen key.
const TABS = ['fixed', 'individual', 'history', 'statutory', 'grid', 'outstanding'] as const;

/**
 * 862ed0ad — the most recent N processed payslips the History tab will render.
 *
 * The History read was unbounded: every payslip in scope for all time, each carrying its whole
 * `statutory` jsonb blob, each rendering an expandable breakdown. Making that the tab that OPENS would
 * have meant every visit to Transaction View paid for the entire payroll history, which is precisely
 * why the approved plan made bounding a PRECONDITION of the default-tab change.
 *
 * A cap rather than a pager, deliberately: the rows are ordered newest-period-first, so the cap keeps
 * what someone opening the screen came to check, and the filters above the table (year / month /
 * employee / cycle) are the existing, already-built way to reach anything older. Note the carried debt
 * the plan called out — r75's paginateRows still fetches everything then slices on about ten tables, so
 * routing this through it would not have bounded the QUERY, only the render. A LIMIT does.
 *
 * The page asks for CAP + 1 and says so on screen when the extra row comes back: a truncation the
 * operator cannot see would be a worse failure than the slow page it replaces.
 */
const HISTORY_ROW_CAP = 200;

/** 080de5cf — one cookie per screen, the convention f3ae3245 set for Fixed Transaction. */
const GRID_PANEL_COOKIE = 'txnview_grid_panel';

type Tab = (typeof TABS)[number];

/**
 * bd14b7e2 — the same convention, ONE COOKIE PER TAB.
 *
 * Per TAB and not per screen, deliberately: History is thirteen columns wide and is read with the panel
 * folded away, while Fixed is usually read with it open. A single shared key would make the five tabs
 * overwrite each other's answer, so the first thing every switch did would be to undo the last one.
 * `grid` reuses the key it has always had, so nobody's Transaction Detail choice is reset by this change.
 */
const TAB_PANEL_COOKIES: Record<Tab, string> = {
  fixed: 'txnview_fixed_panel',
  individual: 'txnview_individual_panel',
  history: 'txnview_history_panel',
  statutory: 'txnview_statutory_panel',
  grid: GRID_PANEL_COOKIE,
  outstanding: 'txnview_outstanding_panel',
};
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
// 'unattached' = no run yet (f1564110 Phase 2); 'reprocess' = DERIVED (510f4bd1) — on a processed run but
// not in the payslip that run last produced. Neither is a payroll_batch.status value; core/payroll-view.ts
// handles both before the status predicate is built. This whitelist must stay in step with
// INDIVIDUAL_TXN_STATUS_FILTERS there: an unknown value DROPS the filter (fails open, showing everything)
// rather than erroring, so a missing entry here is silent.
const TXN_STATUSES = INDIVIDUAL_TXN_STATUS_FILTERS;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an optional positive-int query param within [min, max]; anything else ⇒ undefined. */
function intParam(v: string | undefined, min: number, max: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export default async function TransactionViewPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    companyId?: string;
    employmentId?: string;
    componentId?: string;
    status?: string;
    year?: string;
    month?: string;
    /** 080de5cf (Transaction Detail tab only) — repeated params from the month tick boxes, or one
     *  comma-joined value, which is the form the employee panel carries across a switch and the form
     *  the Excel export link carries. `cleanMonths` accepts both, so a hand-written ?months=1,2,3 means
     *  what the tick boxes mean. */
    months?: string | string[];
    cycle?: string;
    /** 6b4ca488 (Statutory Explanation tab only) — which of the runs matching the four filters to
     *  explain. Absent ⇒ the most recent match, the same default Individual Payslip takes. */
    payslipId?: string;
    // Individual-tab History filters (feedback 7b2d4228)
    kind?: string;
    departmentId?: string;
    txnStatus?: string;
    createdBy?: string;
    createdFrom?: string;
    createdTo?: string;
    from?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const tList = await getTranslations('payroll.list');
  // 6b4ca488 — the Statutory Explanation tab's own namespace, SHARED with /payroll/statutory-detail and
  // its export route. One catalogue block for one display, so the tab and the standalone route cannot
  // caption the same figure differently.
  const tStat = await getTranslations('payroll.statutoryDetail');
  const sp = await searchParams;

  // 862ed0ad — History is the tab that OPENS. The reporter's point is that Transaction View is where you
  // check a payroll after it has been calculated, so landing on the recurring-items list meant the first
  // thing you saw was not the thing you came for. Every ?tab= value still resolves exactly as before, so
  // saved links keep working; only the no-tab default moves.
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : 'history';

  const [employees, companies, components, creators, gridComponents] = await Promise.all([
    listEmployees(s, scopeIds),
    listCompanies(s),
    tab === 'fixed' ? listPayComponents(s) : Promise.resolve([]),
    tab === 'individual' ? listIndividualTxnCreators(s, { companyIds: scopeIds }) : Promise.resolve([]),
    // 0253dc7c — the tenant's live Pay Item settings, for the Grid tab's statutory-subject columns.
    // Read HERE, on the server, and handed to the pivot as plain data: the pivot is a pure function
    // that does no I/O, and a function prop crossing the RSC boundary 500s at runtime while tsc, the
    // suite and `next build` all stay green. `includeArchived` on purpose — an archived pay item can
    // still be the code on an old payslip, and a blank column there would be a worse answer than the
    // setting it was archived with.
    // 417d4937 — the SAME read now also serves the History tab, because the read-time label repair for
    // record lines needs the catalogue's descriptions on both tabs. It was `tab === 'grid'` only, which
    // is why the repair would have been silently inert on the tab the reporter actually opened.
    tab === 'grid' || tab === 'history' ? listPayComponents(s, { includeArchived: true }) : Promise.resolve([]),
  ]);
  // Department options for the Individual History filter — distinct current-assignment departments in scope.
  const departmentOptions = (() => {
    const seen = new Map<string, string>();
    for (const e of employees) if (e.departmentId && e.department) seen.set(e.departmentId, e.department);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  })();
  // Narrow the company dropdown to the authorised scope — the filter can only narrow, never widen.
  const scopedCompanies = companies.filter((c) => scopeIds.includes(c.id));

  // SCOPE-GUARD every ?param (mirror fixed/page.tsx): an out-of-scope companyId/employmentId is
  // treated as "no selection", so URL tampering cannot cross the company fence.
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : undefined;
  const companyIds = companyId ? [companyId] : scopeIds;
  const employmentId =
    sp.employmentId && employees.some((e) => e.employmentId === sp.employmentId) ? sp.employmentId : undefined;
  const componentId =
    sp.componentId && components.some((c) => c.id === sp.componentId) ? sp.componentId : undefined;
  const status = sp.status === 'active' || sp.status === 'ended' ? sp.status : undefined;
  const year = intParam(sp.year, 2000, 2100);
  const month = intParam(sp.month, 1, 12);
  const cycle = CYCLES.includes(sp.cycle as (typeof CYCLES)[number]) ? sp.cycle : undefined;

  // 080de5cf (Grid tab) — the grid is twelve columns of ONE calendar year, so unlike the other tabs its
  // year is never "all": an absent/tampered ?year= falls back to this year rather than to an unbounded
  // read across every year the employee has ever been paid.
  const gridYear = year ?? new Date().getFullYear();
  const gridMonths = cleanMonths(sp.months);

  // Individual-tab History filters — each scope-guarded / whitelist-coerced (a tampered value ⇒ ignored).
  const kind = TXN_KINDS.includes(sp.kind as (typeof TXN_KINDS)[number]) ? sp.kind : undefined;
  const departmentId =
    sp.departmentId && departmentOptions.some((d) => d.id === sp.departmentId) ? sp.departmentId : undefined;
  const txnStatus = TXN_STATUSES.includes(sp.txnStatus as (typeof TXN_STATUSES)[number]) ? sp.txnStatus : undefined;
  const createdBy = sp.createdBy && creators.some((c) => c.id === sp.createdBy) ? sp.createdBy : undefined;
  const createdFrom = sp.createdFrom && ISO_DATE.test(sp.createdFrom) ? sp.createdFrom : undefined;
  const createdTo = sp.createdTo && ISO_DATE.test(sp.createdTo) ? sp.createdTo : undefined;

  // Only the active tab's query runs — the others stay empty (single round-trip per view).
  const [fixedRows, individualRows, historyRows, statutoryMatches, gridPayslips, outstandingRows] = await Promise.all([
    tab === 'fixed'
      ? listFixedTransactionsAcross(s, { companyIds, employmentId, componentId, status })
      : Promise.resolve([]),
    tab === 'individual'
      ? listIndividualTxnsAcross(s, {
          companyIds,
          year,
          month,
          employmentId,
          kind,
          departmentId,
          batchStatus: txnStatus,
          createdBy,
          createdFrom,
          createdTo,
        })
      : Promise.resolve([]),
    // 862ed0ad — bounded, because History is now the landing tab. One row more than we mean to show, so
    // truncation can be STATED rather than silently applied. See HISTORY_ROW_CAP.
    tab === 'history'
      ? listProcessedPayslipsAcross(s, { companyIds, year, month, employmentId, cycle, limit: HISTORY_ROW_CAP + 1 })
      : Promise.resolve([]),
    // 6b4ca488 — the Statutory Explanation tab's source. ONE employee's runs inside the chosen window,
    // capped like History's read: the tab explains a SINGLE payslip, and everything past the first
    // handful only ever feeds the "which of these runs?" chips. Reads nothing until an employee is
    // chosen, which is what makes the tab's cost independent of the payroll history's size.
    tab === 'statutory' && employmentId
      ? listProcessedPayslipsAcross(s, { companyIds, year, month, employmentId, cycle, limit: 25 })
      : Promise.resolve([]),
    // 080de5cf — the Grid pivot's source. NO row cap and none needed: one employee × one calendar year is
    // twelve months of runs. It reads nothing until an employee is chosen, which is also what makes the
    // absence of a cap safe — an unscoped variant of this query would be the whole payroll history.
    tab === 'grid' && employmentId
      ? listProcessedPayslipsAcross(s, { companyIds, year: gridYear, employmentId, cycle })
      : Promise.resolve([]),
    // d0d2c9d1 — money entered but never paid, grouped and totalled. Same scope-guarded filters as the
    // other tabs; deliberately NO default run-state filter (see the read's doc comment).
    tab === 'outstanding'
      ? listUnattachedTxnSummary(s, { companyIds, year, month, employmentId })
      : Promise.resolve([]),
  ]);

  // Feedback efece4ce — which companies are actually registered for the HRD Corp levy. The breakdown used
  // to drop its HRDF line whenever the amount was 0, so a company that legitimately pays nothing (no HRDF
  // Contribution Rate set) looked exactly like a levy that failed to compute. Read once per render for the
  // History tab only; `packFor('MY')` follows the Organization page — the levy is Malaysia-specific.
  const hrdfRegisteredCompanyIds =
    tab === 'history' || tab === 'grid'
      ? ((await packFor('MY')?.companyStatutory.list(s)) ?? [])
          .filter((r) => r.hrdfStatus !== 'not_registered')
          .map((r) => r.companyId)
      : [];

  // ── 6b4ca488: WHICH payslip the Statutory Explanation tab explains, and its working ──
  //
  // The chosen run, or the most recent match — the SAME rule Individual Payslip applies, so arriving from
  // either door lands on the same slip. A tampered `?payslipId` simply does not match: `statutoryMatches`
  // is already fenced on the caller's companies and on the chosen employee, so the id is checked against
  // that set rather than being looked up separately (a second read is a second fence to get wrong).
  const statutoryRow = sp.payslipId
    ? (statutoryMatches.find((r) => r.id === sp.payslipId) ?? statutoryMatches[0])
    : statutoryMatches[0];
  // NO SessionContext, by construction. `explainStatutory` reads this payslip's OWN `statutory` blob and
  // nothing else — it cannot reach today's EPF table, today's PERKESO schedule or the employee's current
  // statutory flags, which is what stops this tab from ever disagreeing with the payslip it explains.
  const statutoryExplanation = statutoryRow ? explainStatutory(statutoryRow.statutory, statutoryRow.runType) : null;
  // The already scope-guarded filters, for the run chips. Rebuilt from the GUARDED values rather than
  // from `sp`, so a tampered param cannot ride back out on a link the screen rendered.
  const statutoryLinkParams: Record<string, string> = {
    tab: 'statutory',
    ...(companyId ? { companyId } : {}),
    ...(employmentId ? { employmentId } : {}),
    ...(year != null ? { year: String(year) } : {}),
    ...(month != null ? { month: String(month) } : {}),
    ...(cycle ? { cycle } : {}),
  };

  // 862ed0ad — the CAP + 1 row, if it came back, is the proof there is more; it is dropped from the render
  // and reported instead.
  const historyTruncated = historyRows.length > HISTORY_ROW_CAP;
  const shownHistoryRows = historyTruncated ? historyRows.slice(0, HISTORY_ROW_CAP) : historyRows;

  // 417d4937 (request 10) — the one-off transactions behind each shown payslip's Recorded items, so the
  // screen can answer "where did this line come from?" instead of sending the reader to a report. ONE
  // indexed query for every run on screen, issued only for the History tab and only when there are rows;
  // it is fenced on the same `companyIds` as the payslips themselves.
  const historyBatchIds = [
    ...new Set(shownHistoryRows.map((r) => r.batchId).filter((b): b is string => b != null)),
  ];
  // …and the EMPLOYMENTS on screen. Batch + company alone would return every employee's ledger rows on
  // every shown run and serialise them all into the flight payload for a table that can only look up
  // `${batchId}:${employmentId}` — invisible on screen, and a whole company's ledger on a tab filtered to
  // one person. The read requires this list for that reason.
  const historyEmploymentIds = [...new Set(shownHistoryRows.map((r) => r.employmentId))];
  const sourceTxnRows =
    tab === 'history' && historyBatchIds.length > 0
      ? await listPayslipSourceTxns(s, {
          companyIds,
          batchIds: historyBatchIds,
          employmentIds: historyEmploymentIds,
        })
      : [];
  // Keyed by (run, employee) — the pair a payslip IS. Built here so the client table does no grouping.
  //
  // AND FILTERED TO THE PAIRS ACTUALLY ON SCREEN, which is not what the fence alone gives you. The read is
  // fenced `batchIds × employmentIds` — a CROSS PRODUCT — so 200 shown rows spanning 20 runs and 100
  // employees fence in up to 2,000 pairs. The surplus renders nothing (its `${batchId}:${employmentId}`
  // key never matches a shown row) and would ship in the flight payload anyway, which is exactly the
  // invisible surplus core/payroll-view.ts claims this read does not have. Cheap to close, and closing it
  // keeps that docblock true rather than aspirational.
  const shownKeys = new Set(shownHistoryRows.map((r) => `${r.batchId}:${r.employmentId}`));
  const sourceTxnsByPayslip: Record<string, PayslipSourceTxnRow[]> = {};
  for (const r of sourceTxnRows) {
    const key = `${r.batchId}:${r.employmentId}`;
    if (!shownKeys.has(key)) continue;
    (sourceTxnsByPayslip[key] ??= []).push(r);
  }

  // ── 080de5cf — the Grid tab's pivot + the plain data its client component needs ──
  // The fold happens on the SERVER: the browser gets finished rows, so the two switches over them cost no
  // round-trip. Everything crossing to the client is plain data — a function prop from a server component
  // to a client one returns a 500 on every request while tsc, the suite and `next build` all stay green.
  // 0253dc7c — code → the three statutory settings, built once. Keyed by CODE because that is the only
  // thing a payslip's stored line and a synthetic row have in common with a catalogue row; the id is
  // meaningless to a line written months ago.
  const payItemSubjects: PayItemSubjectMap = Object.fromEntries(
    gridComponents.map((c) => [
      c.code,
      // One `socso` answer drives the SOCSO, EIS and SKBBK columns — there is no per-item SKBBK
      // setting in the schema, and inventing one here would put three independent-looking answers on
      // screen for a single stored field.
      { epf: c.includedInEpf, socso: c.includedInSocsoEis, pcb: c.includedInPcb },
    ]),
  );
  // 417d4937 — code → the pay item's CURRENT description, for the read-time repair of record-line labels
  // on runs that were already calculated. Same read, same key, same plain-data crossing as the map above;
  // see core/payslip-earning-lines.ts `recordLineIdentity` for why this one map is allowed to override
  // what the payslip stored, and only for record lines.
  const payItemNames: Record<string, string> = Object.fromEntries(gridComponents.map((c) => [c.code, c.name]));
  const grid =
    tab === 'grid'
      ? pivotHistoryGrid({
          rows: gridPayslips,
          year: gridYear,
          months: gridMonths,
          hrdfRegisteredCompanyIds,
          payItemSubjects,
          payItemNames,
        })
      : null;
  const locale = await getLocale();
  // Month captions resolved HERE, not in the browser: Node and the browser can carry different ICU data,
  // and a header formatted on both sides is a hydration mismatch waiting for a locale that differs.
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const monthLabels = Array.from({ length: 12 }, (_, i) => monthFmt.format(new Date(Date.UTC(2001, i, 1))));
  // Dynamic lookups resolved by this page so the grid component stays single-namespace for i18n check C.
  const cycleLabels: Record<string, string> = {
    regular: t('individual.cycle.regular'),
    off_cycle: t('individual.cycle.off_cycle'),
    bonus: t('individual.cycle.bonus'),
    adjustment: t('individual.cycle.adjustment'),
  };
  // The searchable employee panel every keying screen already uses (r168a) — the reporter asked for "the
  // same searchable employee selector as the Fixed and Individual Transaction modules", and this is it.
  //
  // 98e69987 rev 2 restored this rail after r179 replaced it with a top-row search box: the reporter saw
  // both live and asked for the list back. It is fed from the SAME scope-fenced read the search box was,
  // `listEmployees(s, scopeIds)` run once at the top of this render, so the access-fenced set is unchanged
  // either way; the id it navigates to is re-guarded above (`employmentId`) before any read uses it, so
  // the list is never what grants access.
  const panelEmployees: ScopeEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    company: e.company,
    companyId: e.companyId,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));
  // Resolved on the SERVER from the cookie so first paint is already correct; absent ⇒ expanded.
  const cookieStore = await cookies();
  const gridPanelDefaultOpen = cookieStore.get(GRID_PANEL_COOKIE)?.value !== '0';
  // bd14b7e2 — the other four tabs, read the SAME way: absent ⇒ expanded, '0' ⇒ collapsed, in every state.
  //
  // THIS IS DELIBERATELY NARROWER THAN THE APPROVED PLAN'S WORDING, which said "expanded when no employee
  // is selected, otherwise whatever the cookie says". The plan's INTENT — a reader who has never touched
  // the control finds the panel open, because it is the one thing this round exists to put in front of
  // them — is already what an ABSENT cookie means, so it costs nothing. What forcing it cost was the
  // control itself: unlike the six single-employee screens, "nobody selected" is not a prompt on these
  // four, it is their DEFAULT and normal view (that is the whole argument for `allowAll`, and History is
  // the landing tab). Ignoring the cookie in that state meant collapsing the panel on History and hitting
  // Apply — a GET submit — put it straight back, as did every tab switch, refresh and back/forward. The
  // fold would have worked only in the one state where the table is already narrowed to one person.
  //
  // That matters more here than anywhere else on the board: the panel-versus-width trade-off on these four
  // tabs has been reversed once in each direction already (r179 removed the rail for width, 98e69987 rev 2
  // restored it, 1372d169/152fea7f then gave every tab pageWideCls). Adding the rail is what was asked
  // for; adding it in a mode where the thirteen-column History table cannot get its ~22rem back would have
  // been the half nobody has been shown. An explicit collapse now sticks, so both states remain reachable
  // and the reporter's own choice decides.
  const tabPanelDefaultOpen = cookieStore.get(TAB_PANEL_COOKIES[tab])?.value !== '0';
  // The panel carries the grid's own filters across an employee switch. `months` rides as ONE comma-joined
  // value because `preserve` is a flat string map — `cleanMonths` accepts that form as well as the
  // checkboxes' repeated params, so both routes into this screen mean the same thing.
  const gridPanelPreserve: Record<string, string> = {
    tab: 'grid',
    year: String(gridYear),
    months: gridMonths.join(','),
    ...(cycle ? { cycle } : {}),
    ...(companyId ? { companyId } : {}),
  };
  const gridExportParams: Record<string, string> = {
    ...(companyId ? { companyId } : {}),
    ...(employmentId ? { employmentId } : {}),
    year: String(gridYear),
    months: gridMonths.join(','),
    ...(cycle ? { cycle } : {}),
  };
  // The chosen person, for whichever tab is showing — the id it is looked up by is the SCOPE-GUARDED one,
  // so this can only ever resolve to somebody the caller is allowed to see.
  const selectedEmployee = employees.find((e) => e.employmentId === employmentId);

  /**
   * bd14b7e2 — what each of the four inquiry tabs carries across an employee switch: its OWN already
   * scope-guarded filters, plus the tab token so the switch lands back where the reader was.
   *
   * Anything not listed here is DROPPED, which is EmployeeScopePanel's contract and not an oversight — a
   * param scoped to the previous employee is wrong for the next one. Every value in these maps has been
   * through this page's guards above, so a tampered one was already discarded before it could ride along.
   */
  const periodPreserve: Record<string, string> = {
    ...(companyId ? { companyId } : {}),
    ...(year != null ? { year: String(year) } : {}),
    ...(month != null ? { month: String(month) } : {}),
  };
  const tabPanelPreserve: Record<string, string> =
    tab === 'fixed'
      ? {
          tab: 'fixed',
          ...(companyId ? { companyId } : {}),
          ...(componentId ? { componentId } : {}),
          ...(status ? { status } : {}),
        }
      : tab === 'individual'
        ? {
            tab: 'individual',
            ...periodPreserve,
            ...(kind ? { kind } : {}),
            ...(departmentId ? { departmentId } : {}),
            ...(txnStatus ? { txnStatus } : {}),
            ...(createdBy ? { createdBy } : {}),
            ...(createdFrom ? { createdFrom } : {}),
            ...(createdTo ? { createdTo } : {}),
          }
        : tab === 'history'
          ? { tab: 'history', ...periodPreserve, ...(cycle ? { cycle } : {}) }
          : tab === 'statutory'
            ? // 6b4ca488 — the same period filters History carries, MINUS `payslipId`: that names a run
              // belonging to the person being navigated away from, and carrying it would ask the next
              // employee's list for someone else's payslip (the rule Individual Payslip's panel follows).
              { tab: 'statutory', ...periodPreserve, ...(cycle ? { cycle } : {}) }
            : // outstanding. `grid` also lands here and never reads it — the Transaction Detail tab has its
            // own `gridPanelPreserve` above, because its `months` ride as one comma-joined value.
            { tab: 'outstanding', ...periodPreserve };

  // 0fcb2557 — the History tab's Export to Excel. The already scope-guarded filters ride on the "this
  // view" link; the route re-guards every one of them anyway, so a hand-edited link can never widen the
  // download past the caller's own companies.
  const historyExportParams: Record<string, string> = {
    ...(companyId ? { companyId } : {}),
    ...(employmentId ? { employmentId } : {}),
    ...(year != null ? { year: String(year) } : {}),
    ...(month != null ? { month: String(month) } : {}),
    ...(cycle ? { cycle } : {}),
  };
  const historyExportChoices: { scope: 'current' | 'all'; label: string; hint: string }[] = [
    { scope: 'current', label: t('view.history.exportCurrent'), hint: t('view.history.exportCurrentHint') },
    { scope: 'all', label: t('view.history.exportAll'), hint: t('view.history.exportAllHint') },
  ];

  const today = todayInKualaLumpur();
  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => nowYear + 1 - i);

  const companySelect = (
    <Field label={t('view.filters.company')}>
      <select name="companyId" defaultValue={companyId ?? ''} className={inputCls}>
        <option value="">{t('view.filters.all')}</option>
        {scopedCompanies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </Field>
  );
  // bd14b7e2 — the long employee <select> that used to sit here is GONE from all four inquiry tabs; the
  // searchable panel on the left replaced it. Keeping both would have put two employee controls that can
  // disagree on one screen, which is the trap the grid tab's filter-bar gate has always existed to avoid.
  const yearMonthSelects = (
    <>
      <Field label={t('view.filters.year')}>
        <select name="year" defaultValue={year != null ? String(year) : ''} className={inputCls}>
          <option value="">{t('view.filters.all')}</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('view.filters.month')}>
        <select name="month" defaultValue={month != null ? String(month).padStart(2, '0') : ''} className={inputCls}>
          <option value="">{t('view.filters.all')}</option>
          {MONTHS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
    </>
  );

  return (
    // 1372d169 — ONE width rule for the whole screen. 080de5cf gave the Transaction Detail tab the full
    // width and left the other four capped at max-w-6xl (1152px); the reporter came back asking for the
    // same on every tab, because History is thirteen columns and Individual is twelve and both wrap the
    // employee and company names at that measure. So the conditional is gone: every tab is pageWideCls.
    //
    // This is NOT the employee-rail question. That rail (98e69987 rev 2, restored 2026-08-11 after r179
    // removed it and the reporter contested) was untouched by the widening and must stay that way:
    // r179 → 98e69987 was one round-trip already, and a REMOVAL would be the third reversal.
    //
    // bd14b7e2 (2026-08-17) moves in the opposite direction and is the reporter's own request: the rail no
    // longer lives only inside the `tab === 'grid'` branch — the Fixed, Individual, History and Outstanding
    // tabs now mount the same control instead of a long employee dropdown, so all five tabs pick a person
    // the same way. ADDING the rail is not the trade-off r179 made; nothing gave up width for it, and every
    // tab is still pageWideCls with the panel folding away to hand its width back to the table.
    <div className={pageWideCls}>
      <PageHeader back={await payrollProcessBack(sp.from)} title={t('view.title')} description={t('view.subtitle')} />

      {/* Sub-tab strip (Fixed | Individual | History | Transaction Detail | Outstanding). Switching tabs
          resets the filters on purpose — each view has its own filter set. The captions come off the
          catalogs by the tab TOKEN, so 98e69987's rename was a value edit in six locales and every saved
          ?tab=grid link still resolves. */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((k) => (
          <Link
            key={k}
            href={`/payroll/transaction-view?tab=${k}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === k
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`view.tabs.${k}`)}
          </Link>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t('view.readOnly')}</p>

      {/* ── The four inquiry tabs, inside the SAME employee panel Transaction Detail already uses
          (bd14b7e2) ──
          One shell for all four rather than four copies: the cookie, the preserve map and the panel's
          default state are per-TAB values resolved above, so each tab gets its own instance of one
          control and the five tabs cannot drift into five slightly different pickers — which is the
          whole of what was asked for. Transaction Detail keeps its own wrapper below because its panel
          sits beside a different workspace (its year / months / cycle form) and because it is the one
          tab where "no employee" is a prompt rather than a view.
          The employee is chosen in the panel and NOWHERE ELSE on the tab: the long dropdown that used to
          sit in the filter row is gone, and the panel navigates by router.push rather than posting, which
          is why it can live outside the filter form without the two ever disagreeing. */}
      {tab !== 'grid' && (
        <CollapsibleEmployeePanel
          defaultOpen={tabPanelDefaultOpen}
          cookieKey={TAB_PANEL_COOKIES[tab]}
          // With nobody chosen the header carries the tab's own caption. On these four tabs that state is
          // a real view — everybody — so it is named rather than begged for.
          title={t(`view.tabs.${tab}`)}
          // PRE-TRANSLATED, because no translator closure may cross from this server component into that
          // client one (see the LABELS note in components/collapsible-employee-panel.tsx). The wording is
          // this screen's own — "Change employee" / "Select employee" — not the shared fallback.
          hideLabel={t('view.panel.change')}
          showLabel={t('view.panel.select')}
          detailHeader={
            selectedEmployee ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
                {/* Employee ID left-of-name (feedback 38668d9b) */}
                <EmployeeName
                  code={selectedEmployee.employeeCode}
                  name={selectedEmployee.name}
                  className="text-sm font-semibold text-foreground"
                />
                <span className="text-xs text-muted-foreground">
                  {selectedEmployee.company}
                  {selectedEmployee.department ? ` · ${selectedEmployee.department}` : ''}
                </span>
              </div>
            ) : undefined
          }
          panel={
            <Card className="p-4">
              <h2 className="text-sm font-semibold">{t('view.panel.heading')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('view.panel.hint')}</p>
              <div className="mt-3">
                <EmployeeScopePanel
                  employees={panelEmployees}
                  selectedId={employmentId ?? null}
                  basePath="/payroll/transaction-view"
                  preserve={tabPanelPreserve}
                  // The ONLY place this prop is switched on. Those four tabs are cross-employee lists that
                  // an employee merely NARROWS, so "All employees" is a real destination — it is the view
                  // each of them opens on today, and dropping it would take that view away. The screens
                  // that require a person keep the default (off).
                  //
                  // 6b4ca488 — AND THE STATUTORY TAB IS ONE OF THOSE, which is why this is now a
                  // condition rather than a bare flag. An explanation is ONE payslip's working; "all
                  // employees" is not a narrower view of it, it is no view at all. Transaction Detail
                  // reached the same conclusion by keeping its own wrapper; this tab shares the shell and
                  // so has to say it here.
                  allowAll={tab !== 'statutory'}
                />
              </div>
            </Card>
          }
        >
          {/* ── Filters (GET form — pure navigation, no mutation) ──
              Every filter each tab already had, unchanged. Only the employee dropdown left the row; the
              chosen employee rides through Apply as a hidden field below, so applying a filter cannot
              silently drop the person the panel picked. */}
          <Card className="p-4">
            <form method="GET" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="tab" value={tab} />
              {/* bd14b7e2 — the panel's choice rides through Apply, exactly as the grid tab's own form has
                  always carried it. Rendered ONLY when somebody is selected, and read on the way back in
                  by VALUE through the scope guard above — never by presence, which is what makes "All
                  employees" expressible at all: no field, no employee. */}
              {employmentId && <input type="hidden" name="employmentId" value={employmentId} />}
              {companySelect}
              {tab === 'fixed' && (
                <>
                  <Field label={t('view.filters.payItem')}>
                    <select name="componentId" defaultValue={componentId ?? ''} className={inputCls}>
                      <option value="">{t('view.filters.all')}</option>
                      {components.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} — {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('view.filters.status')}>
                    <select name="status" defaultValue={status ?? ''} className={inputCls}>
                      <option value="">{t('view.filters.all')}</option>
                      <option value="active">{t('fixed.statusActive')}</option>
                      <option value="ended">{t('fixed.statusEnded')}</option>
                    </select>
                  </Field>
                </>
              )}
              {tab !== 'fixed' && yearMonthSelects}
              {tab === 'individual' && (
                <>
                  <Field label={t('view.filters.payItem')}>
                    <select name="kind" defaultValue={kind ?? ''} className={inputCls}>
                      <option value="">{t('view.filters.all')}</option>
                      {TXN_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t(`individual.kindLabel.${k}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('view.filters.department')}>
                    <select name="departmentId" defaultValue={departmentId ?? ''} className={inputCls}>
                      <option value="">{t('view.filters.all')}</option>
                      {departmentOptions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('view.filters.txnStatus')}>
                    <select name="txnStatus" defaultValue={txnStatus ?? ''} className={inputCls}>
                      <option value="">{t('view.filters.all')}</option>
                      {TXN_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {tList(`status.${st}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('view.filters.createdBy')}>
                    <select name="createdBy" defaultValue={createdBy ?? ''} className={inputCls}>
                      <option value="">{t('view.filters.all')}</option>
                      {creators.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('view.filters.createdFrom')}>
                    <input type="date" name="createdFrom" defaultValue={createdFrom ?? ''} className={inputCls} />
                  </Field>
                  <Field label={t('view.filters.createdTo')}>
                    <input type="date" name="createdTo" defaultValue={createdTo ?? ''} className={inputCls} />
                  </Field>
                </>
              )}
              {/* 6b4ca488 — the cycle filter serves the Statutory tab too: a bonus run and the regular
                  run that month are two different workings, and without this the tab could not be
                  pointed at either one. */}
              {(tab === 'history' || tab === 'statutory') && (
                <Field label={t('view.filters.cycle')}>
                  <select name="cycle" defaultValue={cycle ?? ''} className={inputCls}>
                    <option value="">{t('view.filters.all')}</option>
                    {CYCLES.map((c) => (
                      <option key={c} value={c}>
                        {t(`individual.cycle.${c}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Button type="submit" variant="secondary">
                {t('view.filters.apply')}
              </Button>
            </form>
          </Card>

          {/* ── 1. Fixed Transaction View ── */}
          {tab === 'fixed' && (
            <Card className="overflow-hidden">
              <SectionHeader title={t('view.tabs.fixed')} count={fixedRows.length} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t('fixed.colEmployee')}</th>
                      <th className="px-4 py-2 font-medium">{t('fixed.colCompany')}</th>
                      <th className="px-4 py-2 font-medium">{t('fixed.payrollItem')}</th>
                      <th className="px-4 py-2 text-right font-medium">{t('fixed.amount')}</th>
                      <th className="px-4 py-2 font-medium">{t('fixed.payrollCycle')}</th>
                      <th className="px-4 py-2 font-medium">{t('fixed.startDate')}</th>
                      <th className="px-4 py-2 font-medium">{t('fixed.endDate')}</th>
                      <th className="px-4 py-2 font-medium">{t('fixed.status')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {fixedRows.map((r) => {
                      const ended = r.validTo != null && r.validTo < today;
                      return (
                        <tr key={r.id}>
                          {/* 1372d169 — identity and pay-item cells stay on ONE line now that the page has the
                              full width to give them; the table's own overflow-x-auto wrapper handles a narrow
                              window. Deliberately NOT applied to the <th> captions: TOTAL DEDUCTIONS wants two
                              header lines and nowrap truncates it. */}
                          <td className="whitespace-nowrap px-4 py-2.5 font-medium">
                            {/* Employee ID left-of-name (feedback 38668d9b) */}
                            <EmployeeName code={r.employeeCode} name={r.employeeName} />
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{r.company}</td>
                          <td className="whitespace-nowrap px-4 py-2.5">
                            <span className="font-mono text-xs">{r.code}</span>{' '}
                            <span className="text-muted-foreground">{r.name}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-medium tabular-nums">{Number(r.amount).toFixed(2)}</td>
                          <td className="px-4 py-2.5">
                            {r.runType ? t(`individual.cycle.${r.runType}`) : t('fixed.cycleUnspecified')}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">{r.validFrom}</td>
                          <td className="px-4 py-2.5 tabular-nums">{r.validTo ?? '—'}</td>
                          <td className="px-4 py-2.5">
                            <Badge variant={ended ? 'default' : 'success'}>
                              {ended ? t('fixed.statusEnded') : t('fixed.statusActive')}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                    {fixedRows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                          {t('view.fixed.empty')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* ── 2. Individual Transaction View (all batches, any status) ── */}
          {tab === 'individual' && (
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between gap-3 pr-4">
                <SectionHeader title={t('view.tabs.individual')} count={individualRows.length} />
                {/* CSV export honouring the current (scope-guarded) filters — opens in Excel. */}
                <a
                  href={`/payroll/transaction-view/export?${new URLSearchParams({
                    ...(companyId ? { companyId } : {}),
                    ...(employmentId ? { employmentId } : {}),
                    ...(year != null ? { year: String(year) } : {}),
                    ...(month != null ? { month: String(month) } : {}),
                    ...(kind ? { kind } : {}),
                    ...(departmentId ? { departmentId } : {}),
                    ...(txnStatus ? { txnStatus } : {}),
                    ...(createdBy ? { createdBy } : {}),
                    ...(createdFrom ? { createdFrom } : {}),
                    ...(createdTo ? { createdTo } : {}),
                  }).toString()}`}
                  className="inline-flex shrink-0 items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  {t('view.exportCsv')}
                </a>
              </div>
              {/* Sortable + searchable grid (feedback 7b2d4228): GET filters above narrow the set; this client table
                  adds column sorting over the fetched rows. */}
              <IndividualTxnTable rows={individualRows} />
            </Card>
          )}

          {/* ── 3. Transaction History (processed payslip results) ──
              Each summary row expands to the itemized payslip breakdown (feedback 5f8d8395). The client table
              receives the already-fetched, scope-guarded rows (full statutory blob + aggregates) and renders the
              detail inline with no extra round-trip. */}
          {tab === 'history' && (
            // 0fcb2557 — the clip moved OFF the Card and onto the table below. The Card was `overflow-hidden`
            // purely to round the table's bottom corners; an absolutely-positioned dropdown inside it would be
            // clipped by that same rule, and on an empty result set (short card) the second choice would have
            // been cut off — a control that works only when there is data is worse than no control.
            <Card>
              {/* The header row mirrors the Individual tab's (SectionHeader + a download on the right),
                  because "in the same place the Individual tab already keeps its download" is what the
                  reporter approved. The control is a <details> disclosure rather than a client dropdown so the
                  whole page stays a server component: two plain anchors, no state, no server action. */}
              <div className="flex items-center justify-between gap-3 pr-4">
                <SectionHeader title={t('view.tabs.history')} count={shownHistoryRows.length} />
                <details className="relative shrink-0">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
                    {t('view.history.export')}
                    <span aria-hidden="true" className="text-[10px]">
                      ▼
                    </span>
                  </summary>
                  {/* Opens down and to the LEFT (end-0), so a wide panel never pushes the page sideways. */}
                  <div className="absolute end-0 top-full z-20 mt-1 w-80 rounded-md border border-border bg-background p-1 shadow-lg">
                    {historyExportChoices.map((choice) => (
                      <a
                        key={choice.scope}
                        href={`/payroll/transaction-view/history-export?${new URLSearchParams(
                          // "All processed payroll" carries NO filters — the link says what the file is, so a
                          // saved or shared one cannot quietly turn back into a filtered download.
                          choice.scope === 'all' ? { scope: 'all' } : { ...historyExportParams, scope: 'current' },
                        ).toString()}`}
                        className="block rounded px-3 py-2 transition-colors hover:bg-muted"
                      >
                        <span className="block text-sm font-medium text-foreground">{choice.label}</span>
                        <span className="block text-xs text-muted-foreground">{choice.hint}</span>
                      </a>
                    ))}
                  </div>
                </details>
              </div>
              {historyTruncated && (
                <p className="px-4 pb-2 text-xs text-amber-700 dark:text-amber-400">
                  {t('view.history.capped', { cap: HISTORY_ROW_CAP })}
                </p>
              )}
              {/* The rounding the Card used to do for the whole box, applied to the table alone — matching
                  Card's own `rounded-[1.25rem]` so the bottom corners look exactly as they did. */}
              <div className="overflow-hidden rounded-b-[1.25rem]">
                {/* 6b134681 / 417d4937 — payItemNames drives the read-time record-line label repair;
                    sourceTxnsByPayslip is the ledger panel beside Recorded items. Both are plain data
                    and both are folded on the server. Grafted onto txnsearch's restructured render
                    rather than taking that side of the merge, which would have reverted the search
                    standardization this same round shipped. */}
                <HistoryTable
                  rows={shownHistoryRows}
                  hrdfRegisteredCompanyIds={hrdfRegisteredCompanyIds}
                  payItemNames={payItemNames}
                  sourceTxnsByPayslip={sourceTxnsByPayslip}
                />
              </div>
            </Card>
          )}

          {/* ── 4. STATUTORY EXPLANATION (feedback 6b4ca488) ──
              The working behind EPF, SOCSO, EIS, SKBBK, HRDF and PCB for ONE payslip: the wage each
              agency was charged on, the kind of rule that produced the amount, the working itself, and
              the employee and employer figures.

              IT RENDERS THE SAME COMPONENT /payroll/statutory-detail RENDERS, and that is the point.
              The Individual Payslip links to that route for the slip on screen; this tab lets a reader
              arrive from the other end, by company / employee / year / month / cycle. Two doors, one
              display — the shape 45df860a settled for the PCB working, and the reason it gave: two
              displays of one calculation are free to drift.

              NOTHING IS RECOMPUTED. `explainStatutory` takes the payslip's own `statutory` blob and no
              SessionContext at all, so it cannot consult today's EPF table or today's PERKESO schedule
              even by accident. A payslip that predates the r187 wage-base stamp is FLAGGED as "working
              not recorded" by the component rather than being filled in from gross. */}
          {tab === 'statutory' && (
            <div className="space-y-4">
              {!selectedEmployee ? (
                // An explanation is one person's, so "All employees" is not a view here — it is a prompt.
                // Said in words rather than shown as an empty page, exactly as the Grid tab does.
                <Card className="p-4">
                  <p className="py-8 text-center text-sm text-muted-foreground">{tStat('noEmployee')}</p>
                </Card>
              ) : !statutoryRow || !statutoryExplanation ? (
                <Card className="p-4">
                  <p className="py-8 text-center text-sm text-muted-foreground">{tStat('noPayslip')}</p>
                </Card>
              ) : (
                <>
                  {/* More than one run matches the filters (a bonus run beside the regular one, a
                      re-issue, or the two halves of a mid-month entity transfer): offer them rather than
                      silently explaining the newest. The SAME disambiguation Individual Payslip carries,
                      and gated the same way — it is not a history list. */}
                  {statutoryMatches.length > 1 && (
                    <Card className="p-4">
                      <SectionHeader
                        title={tStat('otherRuns')}
                        count={statutoryMatches.length}
                        subtitle={tStat('otherRunsHint')}
                      />
                      <div className="flex flex-wrap gap-2 pt-2">
                        {statutoryMatches.map((m) => (
                          <Link
                            key={m.id}
                            href={`/payroll/transaction-view?${new URLSearchParams({
                              ...statutoryLinkParams,
                              payslipId: m.id,
                            }).toString()}`}
                            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                              m.id === statutoryRow.id
                                ? 'border-primary font-medium text-primary'
                                : 'border-border hover:bg-muted'
                            }`}
                          >
                            {m.payPeriod} · {t(`individual.cycle.${m.runType}`)}
                            {m.runSeq > 1 ? ` #${m.runSeq}` : ''}
                          </Link>
                        ))}
                      </div>
                    </Card>
                  )}
                  <div className="flex justify-end">
                    <a
                      href={`/payroll/statutory-detail/export?payslipId=${encodeURIComponent(statutoryRow.id)}`}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
                    >
                      {tStat('exportExcel')}
                    </a>
                  </div>
                  <StatutoryDetailView
                    ctx={{
                      payslipId: statutoryRow.id,
                      employeeCode: statutoryRow.employeeCode,
                      employeeName: statutoryRow.employeeName,
                      company: statutoryRow.company,
                      periodLabel: statutoryRow.payPeriod,
                      payPeriod: statutoryRow.payPeriod,
                      runType: statutoryRow.runType,
                      runSeq: statutoryRow.runSeq,
                      currency: statutoryRow.currency ?? null,
                    }}
                    explanation={statutoryExplanation}
                  />
                </>
              )}
            </div>
          )}

          {/* ── 5. Outstanding transactions (feedback d0d2c9d1) ──
              Money entered against an employee and a month that has never reached a payslip. The rows were
              always listable on the Individual tab (?txnStatus=unattached); what was missing — and what let
              RM23,170 accumulate unnoticed — is the per-employee/per-month grouping and the grand total. */}
          {tab === 'outstanding' && (
            <Card className="overflow-hidden">
              <SectionHeader title={t('view.tabs.outstanding')} count={outstandingRows.length} />
              <p className="px-4 pb-2 text-xs text-muted-foreground">{t('view.outstanding.hint')}</p>
              <OutstandingTable rows={outstandingRows} />
            </Card>
          )}
        </CollapsibleEmployeePanel>
      )}

      {/* ── 6. TRANSACTION DETAIL (feedback 080de5cf; renamed by 98e69987) ──
          The same processed payslips as the tab beside it, turned on their side: pay item down the left,
          month across the top, annual total on the right — the shape the reporter reconciles in. The
          payslip-by-payslip view is NOT replaced; it answers a different question.

          The permanent left-hand employee rail is the one r179 removed and 98e69987 rev 2 put back: the
          reporter saw both live and asked for the list, with its Business Unit / Department / Status
          narrowers, to return. It collapses to give the figures the full width, and the choice is
          remembered in GRID_PANEL_COOKIE. The tab's ?tab=grid token is UNCHANGED — the rename is a
          caption, and saved links keep working.

          bd14b7e2 gave the same rail to the four tabs above, which is why this branch is no longer the
          only one that mounts the shell. It keeps its OWN wrapper rather than joining theirs because its
          workspace is different (a year / months / cycle form, not the shared filter row) and because it
          is the one tab where no employee means no figures at all — so it neither offers nor wants the
          "All employees" row. */}
      {tab === 'grid' && (
        <CollapsibleEmployeePanel
          defaultOpen={gridPanelDefaultOpen}
          cookieKey={GRID_PANEL_COOKIE}
          // 009c8a37 — the header row, on the same horizontal line as the Hide/Show control. This tab has
          // no per-employee button of its own (the export lives inside the grid), so the row carries the
          // identity and the control; with nobody picked it carries the tab name and the control.
          title={t('view.tabs.grid')}
          detailHeader={
            selectedEmployee ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
                {/* Employee ID left-of-name (feedback 38668d9b) */}
                <EmployeeName
                  code={selectedEmployee.employeeCode}
                  name={selectedEmployee.name}
                  className="text-sm font-semibold text-foreground"
                />
                <span className="text-xs text-muted-foreground">
                  {selectedEmployee.company} · {gridYear}
                </span>
              </div>
            ) : undefined
          }
          panel={
            <Card className="p-4">
              <h2 className="text-sm font-semibold">{t('view.grid.pickEmployee')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('view.grid.pickEmployeeHint')}</p>
              <div className="mt-3">
                <EmployeeScopePanel
                  employees={panelEmployees}
                  selectedId={employmentId ?? null}
                  basePath="/payroll/transaction-view"
                  preserve={gridPanelPreserve}
                />
              </div>
            </Card>
          }
        >
          <div className="space-y-4">
            {/* Year / months / cycle — a plain GET form, so the whole screen stays a server component and
                the address bar is the state. `tab` and `employmentId` ride as hidden fields: a submit must
                not silently drop the employee the panel chose. */}
            <Card className="p-4">
              <form method="GET" className="flex flex-wrap items-end gap-4">
                <input type="hidden" name="tab" value="grid" />
                {employmentId && <input type="hidden" name="employmentId" value={employmentId} />}
                {companyId && <input type="hidden" name="companyId" value={companyId} />}
                <Field label={t('view.filters.year')}>
                  <select name="year" defaultValue={String(gridYear)} className={inputCls}>
                    {years.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </Field>
                <fieldset className="min-w-0">
                  <legend className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('view.filters.months')}
                  </legend>
                  {/* Twelve checkboxes rather than a native multi-select: they post the same repeated
                      `months` params without ctrl-clicking, and every choice is visible at a glance —
                      which is the point of a filter you change on every reconciliation. */}
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {MONTHS.map((m, i) => (
                      <label key={m} className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          name="months"
                          value={String(i + 1)}
                          defaultChecked={gridMonths.includes(i + 1)}
                          className="h-4 w-4 rounded border-border"
                        />
                        {monthLabels[i]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label={t('view.filters.cycle')}>
                  <select name="cycle" defaultValue={cycle ?? ''} className={inputCls}>
                    <option value="">{t('view.filters.all')}</option>
                    {CYCLES.map((c) => (
                      <option key={c} value={c}>
                        {t(`individual.cycle.${c}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit" variant="secondary">
                  {t('view.filters.apply')}
                </Button>
              </form>
            </Card>

            <Card className="p-4">
              {selectedEmployee ? (
                <>
                  {/* 009c8a37 — the identity line that used to sit here is now the shell's header row. */}
                  <HistoryGrid
                    rows={grid?.rows ?? []}
                    months={grid?.months ?? gridMonths}
                    monthLabels={monthLabels}
                    cycleLabels={cycleLabels}
                    exportParams={gridExportParams}
                    payslipCount={grid?.payslipCount ?? 0}
                    detailNotRecorded={grid?.detailNotRecorded ?? false}
                    basesNotRecorded={grid?.basesNotRecorded ?? false}
                    subjectFromCatalogue={grid?.subjectFromCatalogue ?? false}
                  />
                </>
              ) : (
                // No employee, no figures — and said in words rather than shown as an empty table, because
                // this tab is one person's year by definition and a blank one reads as "no data" instead
                // of "choose someone".
                <p className="py-8 text-center text-sm text-muted-foreground">{t('view.grid.noEmployee')}</p>
              )}
            </Card>
          </div>
        </CollapsibleEmployeePanel>
      )}
    </div>
  );
}
