/**
 * The HR-admin leave inquiry rebuild — feedback 8ec63139, 20c699f8, 953be4b0 — plus the
 * Carried Forward → Brought Forward rename (37a1141e).
 *
 * The RSC pages cannot render in this suite, so the composition, the gating and the i18n are asserted
 * statically (precedent: test/my-absence-layout-restore.test.ts). The employee-selection rule IS pure, so
 * it is exercised for real. The read-layer filters these screens depend on are proven end-to-end in
 * test/leave-filters.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  inquiryPageWindow,
  pickInquiryEmployee,
  sortInquiryEmployees,
  type InquiryEmployee,
} from '../lib/leave-inquiry';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Record<string, never>;

const leavePage = read('app/leave/page.tsx');
const balancesPage = read('app/leave/employee-balances/page.tsx');
const recordsPage = read('app/leave/employee-records/page.tsx');
const panel = read('components/filter-panel.tsx');
// 388e53c2 — Employee Details moved to the Team Leave Tracker route. The listing is the same code; only
// the file holding it and its forms' base path changed, so the assertions below moved with it rather than
// being dropped. Sliced to the ADMIN branch, because that page also renders the leave calendar.
const trackerPage = read('app/leave/tracker/page.tsx');
const trackerAdminBranch = trackerPage.slice(0, trackerPage.indexOf('  // ── The Leave Calendar'));

describe('8ec63139: the HR-admin leave page drops the ESS blocks', () => {
  it('gates every own-leave surface behind `ess` (= !admin), reads included', () => {
    expect(leavePage).toMatch(/const ess = !admin;/);
    // The two balance reads no longer run for an admin — the item asks for the BACKEND dependency to go,
    // not only the markup.
    expect(leavePage).toContain('const selfBalances = ess && me ? await leaveBalances(session, me.employmentId, locale) : []');
    expect(leavePage).toContain('const selfRequests = ess && me ?');
    // My Balances: the primary cards and the detailed balance card.
    expect(leavePage).toContain('{ess && primaryCards.length > 0 && (');
    expect(leavePage).toMatch(/\{ess && \(\s*\n\s*<Card className="overflow-hidden" data-tour="leave-balance">/);
    // Request Leave.
    expect(leavePage).toMatch(/\{ess && \(\s*\n\s*<RequestLeaveDialog/);
  });

  it('leaves leave application, approval and balance calculation untouched', () => {
    // Same server actions, same on-behalf-of options, same balance derivation helper.
    for (const kept of [
      'submitAction={requestLeaveAction}',
      'previewAction={previewLeaveDeductionAction}',
      'deriveBalanceRow(b, bd ?? null)',
    ]) {
      expect(leavePage.includes(kept), kept).toBe(true);
    }
    // afd0a87c — AdminCancelLeaveDialog went with the request table, and is NOT a loss: cancelling
    // someone else's leave lives on Employee Leave Record and on the dashboard calendar. Asserted at both
    // surviving homes rather than merely dropped, so a later edit cannot quietly leave it homeless.
    expect(leavePage.includes('<AdminCancelLeaveDialog')).toBe(false);
    expect(read('app/leave/employee-records/page.tsx')).toContain('<AdminCancelLeaveDialog');
    expect(read('components/planned-absences-grid.tsx')).toContain('<AdminCancelLeaveDialog');
  });

  it('the every-column filter set is gone with the table it narrowed', () => {
    // INVERTED. 8ec63139 asked for a filter on every column of the org-wide request table, and this
    // asserted all eight existed and reached the read as lists. The table itself has now been removed at
    // the reporter's request, so the filters have nothing to narrow. Their loss is disclosed and accepted
    // in the approved plan; what must NOT happen is filters surviving with no table, or a read still
    // running for a table nobody renders.
    for (const name of ["name: 'bu'", "name: 'loc'", "name: 'duration'", "name: 'status'"]) {
      expect(leavePage.includes(name), name).toBe(false);
    }
    for (const param of ['businessUnitIds:', 'locationIds:', 'durationTypes:']) {
      expect(leavePage.includes(param), param).toBe(false);
    }
    // The Employee Details listing keeps its OWN filters — company, department and employment status —
    // on the page it moved to (388e53c2). Asserted THERE, and asserted absent here, because a listing
    // left behind on /leave is the half-move that relights "My Leave" all over again.
    for (const name of ["name: 'edCompany'", "name: 'edDept'", "name: 'edStatus'"]) {
      expect(trackerAdminBranch.includes(name), name).toBe(true);
      expect(leavePage.includes(name), `${name} still on /leave`).toBe(false);
    }
  });

  it('the panel renders Select all / Deselect all on a multi fieldset when both labels are supplied', () => {
    expect(panel).toContain('const bulk = labels.selectAll && labels.deselectAll;');
    expect(panel).toContain('{labels.selectAll}');
    expect(panel).toContain('{labels.deselectAll}');
    // Uncontrolled: the bulk buttons flip the checkboxes in place, so the no-JS GET form is unchanged.
    expect(panel).toContain("closest('fieldset')");
    expect(panel).toContain('type="checkbox"');
    // Optional, so pages that have not adopted them are not forced to supply two more strings.
    expect(panel).toContain('selectAll?: string;');
  });

  it('ships the bulk labels in every locale', () => {
    for (const loc of LOCALES) {
      const filters = (msgs(loc) as unknown as { leave: { filters: Record<string, string> } }).leave.filters;
      expect(filters.selectAll, `${loc} leave.filters.selectAll`).toBeTruthy();
      expect(filters.deselectAll, `${loc} leave.filters.deselectAll`).toBeTruthy();
    }
  });
});

describe('20c699f8 / 953be4b0: which employee an inquiry screen shows', () => {
  const rows: InquiryEmployee[] = [
    { employmentId: 'e3', name: 'zara', company: 'Beta Sdn Bhd', employeeCode: 'C', terminatedOn: null },
    { employmentId: 'e1', name: 'Mei Ling', company: 'beta sdn bhd', employeeCode: 'A', terminatedOn: null },
    { employmentId: 'e2', name: 'Aaron', company: 'Alpha Holdings', employeeCode: 'B', terminatedOn: null },
  ];

  it('orders by company A→Z then employee name A→Z, case-insensitively', () => {
    expect(sortInquiryEmployees(rows).map((r) => r.employmentId)).toEqual(['e2', 'e1', 'e3']);
  });

  it('with no employee picked, shows the first one', () => {
    expect(pickInquiryEmployee(sortInquiryEmployees(rows))?.employmentId).toBe('e2');
  });

  it('shows the requested employee when they are in the (already access-fenced) list', () => {
    expect(pickInquiryEmployee(sortInquiryEmployees(rows), 'e3')?.employmentId).toBe('e3');
  });

  it('falls back to the first employee for an id outside the list — never leaks one in', () => {
    // A stale bookmark or a hand-edited URL must not error and must not select anything unlisted.
    expect(pickInquiryEmployee(sortInquiryEmployees(rows), 'not-in-scope')?.employmentId).toBe('e2');
    expect(pickInquiryEmployee([], 'e1')).toBeUndefined();
  });
});

describe('20c699f8: Employee Balances', () => {
  const rowsHelper = read('app/leave/employee-balances/rows.ts');

  it('derives from the SAME reads and the SAME helper the employee sees on their own page', () => {
    // 994a5287 added the ADMIN opt-in: a leave type HR has hidden from employee self-service must still be
    // listed on HR's own screen. Same read, same figures — only the visibility gate differs.
    expect(rowsHelper).toContain('leaveBalances(ctx, employmentId, locale, { includeHidden: true })');
    expect(rowsHelper).toContain('leaveEntitlementBreakdown(ctx, employmentId, b.leaveTypeId, asOf, locale)');
    expect(rowsHelper).toContain('deriveBalanceRow(');
    // ESS per-component hiding is a self-service rule; HR sees the figure.
    expect(rowsHelper).toContain('essView: {}');
  });

  it('renders all eleven requested columns', () => {
    for (const col of [
      "tInq('colLeaveCode')",
      "tInq('colEntitlementYear')",
      "tMe('leaveBalanceTable.colYtdEntitled')",
      "tInq('colBroughtForward')",
      "tMe('leaveBalanceTable.colTaken')",
      "tInq('colPendingApproval')",
      "tMe('leaveBalanceTable.colAdjustment')",
      "tMe('leaveBalanceTable.colOverutilized')",
      "tInq('colForfeitedBf')",
      "tMe('leaveBalanceTable.colBalance')",
      "tInq('colDate')",
    ]) {
      expect(balancesPage.includes(col), col).toBe(true);
    }
    expect(balancesPage).toContain('colSpan={11}');
  });

  it('re-runs the breakdown when the as-at date changes (nothing is cached against another date)', () => {
    expect(balancesPage).toContain('name="asOf"');
    expect(balancesPage).toContain('employeeBalanceRows(session, selected.employmentId, asOf, locale');
  });

  it('sorts by leave code A→Z by default and can flip to Z→A', () => {
    expect(rowsHelper).toContain("const mul = filter.dir === 'desc' ? -1 : 1;");
    expect(balancesPage).toContain("const dir: 'asc' | 'desc' = sp.dir === 'desc' ? 'desc' : 'asc';");
  });

  it('carries search, a multi-select filter with bulk controls, and both export formats', () => {
    expect(balancesPage).toContain("tInq('searchPlaceholder')");
    expect(balancesPage).toContain("kind: 'multi'");
    expect(balancesPage).toContain("selectAll: t('filters.selectAll')");
    expect(balancesPage).toContain('/leave/employee-balances/export?');
  });

  it('a leave row opens that type’s records for the same employee', () => {
    expect(balancesPage).toContain('/leave/employee-records?emp=');
  });
});

describe('953be4b0: Employee Leave Record', () => {
  it('reads the existing projection narrowed to (employment, leave type)', () => {
    expect(recordsPage).toContain('listLeaveRequestsPage(session, {');
    expect(recordsPage).toContain('employmentIds: [selected.employmentId]');
    expect(recordsPage).toContain('leaveTypeIds: typeIds.length ? typeIds : undefined');
  });

  it('defaults to newest request first', () => {
    expect(recordsPage).toContain("const sort = sp.sort || 'applied';");
    expect(recordsPage).toContain("const dir: 'asc' | 'desc' = sp.dir === 'asc' ? 'asc' : 'desc';");
  });

  it('renders all ten originally requested columns, plus the three fe3eb141 added', () => {
    for (const col of [
      "t('filters.employeeId')",
      "t('colEmployee')",
      "t('filters.dateFrom')",
      "t('filters.dateTo')",
      "t('colDays')",
      "tInq('colLeaveCode')",
      "tInq('colReason')",
      "tInq('colAttachment')",
      "t('colApplied')",
      "tInq('colFinalApproval')",
      // fe3eb141 — the reference the Requests subsection shows, a Status column (without which
      // "why is there no Cancel button" is unanswerable), and the Action column itself.
      "t('filters.reference')",
      "t('filters.statusLabel')",
      "t('colAction')",
    ]) {
      expect(recordsPage.includes(col), col).toBe(true);
    }
    expect(recordsPage).toContain('colSpan={13}');
  });

  it('reuses the existing per-request attachment route and its authorization', () => {
    expect(recordsPage).toContain('/me/leave/attachment/${r.id}?inline=1');
  });

  it('offers leave code / date range / status filters and both export formats', () => {
    expect(recordsPage).toContain("name: 'type'");
    expect(recordsPage).toContain("name: 'status'");
    expect(recordsPage).toContain("name: 'from'");
    expect(recordsPage).toContain("name: 'to'");
    expect(recordsPage).toContain('/leave/employee-records/export?');
  });

  it('both export routes are admin-gated and event-free', () => {
    for (const rel of ['app/leave/employee-balances/export/route.ts', 'app/leave/employee-records/export/route.ts']) {
      const src = read(rel);
      expect(src.includes('isAdmin(session)'), rel).toBe(true);
      expect(src.includes('403'), rel).toBe(true);
      expect(src.includes('appendEvent'), rel).toBe(false);
    }
  });

  it('ships every inquiry string in every locale', () => {
    const keys = [
      'navLabel', 'employeeDetails', 'employeeBalances', 'employeeLeaveRecord', 'balancesTitle',
      'balancesDescription', 'recordsTitle', 'recordsDescription', 'employee', 'searchPlaceholder',
      'recordsSearchPlaceholder', 'colLeaveCode', 'colEntitlementYear', 'colBroughtForward',
      'colPendingApproval', 'colForfeitedBf', 'colDate', 'colReason', 'colAttachment',
      'colFinalApproval', 'viewAttachment', 'attachmentYes', 'noRows', 'noRecords', 'noEmployees',
    ];
    for (const loc of LOCALES) {
      const inquiry = (msgs(loc) as unknown as { leave: { inquiry: Record<string, string> } }).leave.inquiry;
      for (const k of keys) expect(inquiry?.[k], `${loc} leave.inquiry.${k}`).toBeTruthy();
    }
  });
});

describe('650b6eb8: Employee Details — the tab an HR admin lands on', () => {
  const nav = read('components/leave/leave-inquiry-nav.tsx');

  it('mounts the left-side nav on the admin landing page, opening on Employee Details', () => {
    // REPOINTED BY 388e53c2, not weakened. The landing page is /leave/tracker now — the menu row an HR
    // administrator should have been on all along — and "details" is still the tab it opens on.
    expect(trackerPage).toContain("import { LeaveInquiryNav } from '@/components/leave/leave-inquiry-nav'");
    expect(trackerAdminBranch).toContain('<LeaveInquiryNav active="details" employmentId={inquiryEmploymentId} />');
    expect(nav).toContain("{ key: 'details', href: withEmp('/leave/tracker')");
    // THE OTHER TWO ARE UNCHANGED, and that is a promise made in writing: saved links and the export links
    // already in circulation point at these two addresses.
    expect(nav).toContain("{ key: 'balances', href: withEmp('/leave/employee-balances')");
    expect(nav).toContain("{ key: 'records', href: withEmp('/leave/employee-records')");
    // …and My Absence kept none of it — one Employee Details screen, not two.
    expect(leavePage).not.toContain('LeaveInquiryNav');
  });

  it('renders the six requested columns', () => {
    // `t` was the `leave` namespace on the old host page; on the tracker it is `leaveTracker`, so the
    // leave-namespace calls are spelled `tLeave` there. Same six columns, same two vocabularies.
    for (const col of [
      "tLeave('filters.employeeId')",
      "tInq('colEmployeeName')",
      "tLeave('filters.company')",
      "tLeave('filters.department')",
      "tInq('colPosition')",
      "tPeople('colStatus')",
    ]) {
      expect(trackerAdminBranch.includes(col), col).toBe(true);
    }
    expect(trackerAdminBranch).toContain('colSpan={6}');
  });

  it('reads the access-scoped People page, ten at a time, company A→Z then name A→Z', () => {
    expect(trackerAdminBranch).toContain('listEmployeesPage(s, {');
    expect(trackerPage).toContain('const EMPLOYEE_PAGE = 10;');
    expect(trackerAdminBranch).toContain("sort: 'company',");
    expect(trackerAdminBranch).toContain('limit: EMPLOYEE_PAGE,');
    expect(trackerAdminBranch).toContain('offset: edPage * EMPLOYEE_PAGE,');
    // Scope fence first: the listing shows only the companies this session may see.
    expect(trackerAdminBranch).toContain('companyIds: scopeIds,');
    // Terminated staff are NOT filtered out — their leave position is exactly what HR looks up after
    // someone leaves, and the sibling screen makes the same call.
    expect(trackerAdminBranch, 'terminated staff must stay in the listing').not.toMatch(/terminatedOn/);
  });

  it('shows the DERIVED Employee Status, in the shared vocabulary — never the legacy stored enum', () => {
    expect(trackerAdminBranch).toContain('deriveEmploymentStatus(e, today)');
    expect(trackerAdminBranch).toContain("const tStatus = await getTranslations('people.employeeStatus');");
    expect(trackerAdminBranch).toContain('options: EMPLOYMENT_STATUSES.map((v) => ({ value: v, label: tStatus(v) }))');
    // `status` on the row IS the legacy stored enum (EmployeeListRow keeps it for other callers) — this
    // screen must never read it, or the retired On Leave / Offboarding values come back on a new surface.
    expect(/\be\.status\b/.test(trackerAdminBranch), 'legacy row.status is read').toBe(false);
  });

  it('search + a multi-select Company / Department / Status filter with bulk controls', () => {
    expect(trackerAdminBranch).toContain("tInq('detailsSearchPlaceholder')");
    for (const name of ["name: 'edCompany'", "name: 'edDept'", "name: 'edStatus'"]) {
      expect(trackerAdminBranch.includes(name), name).toBe(true);
    }
    expect(trackerAdminBranch).toContain("selectAll: tLeave('filters.selectAll')");
    expect(trackerAdminBranch).toContain("deselectAll: tLeave('filters.deselectAll')");
  });

  it('clicking an employee opens Employee Balances for that employee', () => {
    expect(trackerAdminBranch).toContain('const employeeHref = (employmentId: string) => `/leave/employee-balances?emp=${employmentId}`;');
  });

  it('one listing remains, and it still carries its own state', () => {
    // INVERTED. Two independently-filtered listings shared this page, so every control of one carried the
    // other's params or filtering employees would silently blank the leave requests. afd0a87c removed the
    // request table, so the invariant it protected no longer has two sides — and requestHiddenParams must
    // be gone, not merely unused, or the next author will wire a control to an empty carrier.
    expect(trackerAdminBranch).toContain('hidden={employeeHiddenParams}');
    expect(trackerPage.includes('requestHiddenParams')).toBe(false);
    expect(panel).toContain('hidden?: readonly (readonly [string, string])[];');
    // The employee listing's params stay prefixed AND keep their exact spelling: 388e53c2 changed the
    // base path they hang off, so renaming them on top of that would break every saved admin link twice.
    for (const param of ['edQ?: string', 'edPage?: string', 'edCompany?: string | string[]']) {
      expect(trackerPage.includes(param), param).toBe(true);
    }
    // …and they are gone from the page they left, or the two screens read each other's query strings.
    for (const param of ['edQ?: string', 'edPage?: string', 'edCompany?: string | string[]']) {
      expect(leavePage.includes(param), `${param} still declared on /leave`).toBe(false);
    }
  });

  it('the org-wide leave-request table is GONE — afd0a87c, and it took its export with it', () => {
    // INVERTED. This asserted the table was still on the page, on the reasoning that dropping it would
    // undo the every-column filter the same reporter asked for in the same round. The reporter has since
    // asked plainly for the removal with no relocation, and said they will redesign Employee Leave Record
    // separately. What is asserted now is that the removal was COMPLETE — a half-removed table leaves the
    // read running for nobody, which is the expensive half.
    expect(leavePage).not.toContain('listLeaveRequestsPage(session, {');
    expect(leavePage).not.toContain("t('requestsTitle')");
    expect(leavePage).not.toContain('/leave/export?');
    // The employee listing that replaced it must survive — at its new address (388e53c2).
    expect(trackerAdminBranch).toContain('listEmployeesPage(s, {');
  });

  it('numbers the pages — 1 2 3 Next >, with the far ends always one click away', () => {
    expect(trackerAdminBranch).toContain('inquiryPageWindow(edPage, employeePageCount)');
    expect(trackerAdminBranch).toContain("tInq('pageNext')");
    // Short list: every page, no gaps.
    expect(inquiryPageWindow(0, 3)).toEqual([0, 1, 2]);
    expect(inquiryPageWindow(0, 1)).toEqual([0]);
    expect(inquiryPageWindow(0, 0)).toEqual([]);
    // Long list: first, a window around the current page, last — gaps marked by null.
    expect(inquiryPageWindow(0, 20)).toEqual([0, 1, 2, null, 19]);
    expect(inquiryPageWindow(10, 20)).toEqual([0, null, 8, 9, 10, 11, 12, null, 19]);
    expect(inquiryPageWindow(19, 20)).toEqual([0, null, 17, 18, 19]);
    // The current page is always offered, and never twice.
    for (const p of [0, 3, 7, 19]) {
      const w = inquiryPageWindow(p, 20);
      expect(w.filter((n) => n === p).length, `page ${p}`).toBe(1);
    }
  });

  it('ships the Employee Details strings in every locale', () => {
    const keys = [
      'detailsSearchPlaceholder', 'colEmployeeName', 'colPosition', 'openBalances',
      'pagePrev', 'pageNext', 'pageAria', 'noEmployeesFiltered',
      // 388e53c2 — the header sentence under "Employee Details" on its new host page.
      'detailsDescription',
    ];
    for (const loc of LOCALES) {
      const inquiry = (msgs(loc) as unknown as { leave: { inquiry: Record<string, string> } }).leave.inquiry;
      for (const k of keys) expect(inquiry?.[k], `${loc} leave.inquiry.${k}`).toBeTruthy();
    }
  });
});

describe('37a1141e: Carried Forward → Brought Forward (English labels only)', () => {
  const en = msgs('en') as unknown as Record<string, Record<string, never>>;
  const at = (dotted: string): string =>
    dotted.split('.').reduce<never>((o, k) => (o as never as Record<string, never>)[k], en as never);

  it('every label naming the BALANCE now says brought forward', () => {
    // 1f6fd6d8 rebuilt the panel around ONE Leave Summary column, so several of the labels this item
    // originally renamed no longer exist as rows (Brought-forward remaining, the standalone expiry row, the
    // seven per-component formula editors). The PROPERTY the item pinned is unchanged and is asserted on the
    // labels that survive: nothing an employee or HR reads calls this figure "carried forward" any more.
    expect(at('leave.breakdown.field.broughtForward')).toBe('Brought forward');
    expect(at('leave.breakdown.field.broughtForwardForfeited')).toBe('Brought forward forfeited');
    expect(at('me.leaveBalanceTable.colCarriedForward')).toBe('Brought Forward');
    expect(at('admin.leave.essView.broughtForward')).toBe('Brought Forward');
    expect(at('admin.leave.essView.forfeited')).toBe('Brought Forward Forfeited');
    expect(at('analytics.carryForwardCarried')).toBe('Brought forward');
    expect(at('analytics.carryForwardTitle')).toBe('Brought-forward & forfeiture');
  });

  it('the panel no longer shows one figure under two names on the same screen', () => {
    // Before 37a1141e the same broughtForward bucket was labelled "Carried forward" in one section and
    // "Brought forward" in another. 1f6fd6d8 removed the duplication at its root — there is now exactly ONE
    // row reading that bucket — which is the strongest possible form of the same guarantee.
    const cfg = read('components/leave/entitlement-panel-config.ts');
    const readers = cfg.split('\n').filter((l) => l.includes('d.breakdown.broughtForward'));
    expect(readers).toHaveLength(1);
    expect(readers[0]).toContain("(d) => d.breakdown.broughtForward");
    const row = cfg.split('\n').find((l) => l.includes("labelKey: 'field.broughtForward'"))!;
    expect(row).toBeTruthy();
    // No label anywhere in the panel's namespace still says "Carried forward".
    const breakdown = JSON.stringify((msgs('en') as unknown as { leave: { breakdown: unknown } }).leave.breakdown);
    expect(breakdown.toLowerCase()).not.toContain('carried forward');
  });

  it('the RULE that produces the balance deliberately keeps its wording', () => {
    // Renaming these would lose the distinction between the forward-looking setting and its result — the
    // very confusion the item is removing.
    expect(at('admin.leave.subStep.carry')).toBe('Carry Forward Policy');
    expect(at('admin.leave.carryEnabledLabel')).toBe('Carry forward rule');
    expect(at('admin.leave.bandColCarryDays')).toBe('Carry-forward days');
    // 7cd914b1 added "(days)" here — a UNIT, not a rename. The reporter asked for it once a percentage
    // field sat beside this one, because "Carry cap: 5" and "Carry forward percentage: 50" are otherwise
    // indistinguishable in kind. 37a1141e's rule still holds: the phrase "Carry cap" is retained, so the
    // forward-looking setting is still worded differently from the "Brought Forward" result it produces.
    expect(at('admin.leave.carryCapLabel')).toBe('Carry cap (days)');
  });

  it('the two unrelated features that share the English phrase are untouched', () => {
    expect(at('payrollPolicy.config.negativeCarryForward')).toBe('Carry the balance forward to the next cycle');
    expect(at('admin.toilPolicy.carryForwardLabel')).toBe('Carry forward unused credit at year-end');
  });

  it('no English leave-balance label still says "carried forward"', () => {
    // The key list follows the surfaces that survive. `leave.breakdown.carriedForward` and
    // `admin.leave.formula.component.carriedForward` were removed outright by 1f6fd6d8 / ed17a4f9 — a label
    // that no longer exists cannot say the wrong thing, and the summary's own row is checked above.
    const stale = [
      'leave.breakdown.field.broughtForward',
      'leave.breakdown.field.broughtForwardForfeited',
      'me.leaveBalanceTable.colCarriedForward',
      'admin.leave.essView.broughtForward',
      'analytics.carryForwardCarried',
    ].filter((k) => /carr(y|ied)[\s-]*forward/i.test(at(k)));
    expect(stale, stale.join(', ')).toEqual([]);
  });

  it('the other five locales say brought forward on the row that survives', () => {
    // The spot-check moves with the label: `leave.breakdown.carriedForward` is gone, and the row that reads
    // the same bucket is now `field.broughtForward`. Each locale must still carry its OWN translation there
    // — an English string in a non-English catalogue is the regression this guards.
    const en = (msgs('en') as unknown as { leave: { breakdown: { field: Record<string, string> } } }).leave.breakdown.field;
    for (const loc of ['ms', 'th', 'vi', 'zh', 'ta'] as const) {
      const field = (msgs(loc) as unknown as { leave: { breakdown: { field: Record<string, string> } } }).leave.breakdown.field;
      expect(field.broughtForward, `${loc} field.broughtForward`).toBeTruthy();
      expect(field.broughtForwardForfeited, `${loc} field.broughtForwardForfeited`).toBeTruthy();
      // Non-Latin catalogues must not be an English passthrough. ms/vi share the Latin alphabet, so only the
      // three non-Latin scripts can be asserted byte-for-byte.
      if (loc === 'th' || loc === 'zh' || loc === 'ta') {
        expect(field.broughtForward, `${loc} is English passthrough`).not.toBe(en.broughtForward);
        expect(field.broughtForwardForfeited, `${loc} is English passthrough`).not.toBe(en.broughtForwardForfeited);
      }
    }
  });
});
