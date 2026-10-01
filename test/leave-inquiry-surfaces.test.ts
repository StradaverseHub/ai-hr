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
    // ec991c2a: the call now carries an explicit `{ includeArchived: false }`, so this is a prefix match
    // rather than the whole line. The decision pinned is untouched — the READ itself, not just the markup,
    // is behind the `ess` gate, so an admin page load pays nothing for balances nobody renders.
    //
    // UPDATED BY r302 (6c9802c9): the balance reads are ONE per-year dashboard read now (core/my-leave.ts), and
    // it is behind the same gate. The flat `leaveRequestsFor` read that sat beside it fed nothing and is gone.
    expect(leavePage).toContain('const dashboard = ess && me ? await myLeaveDashboard(session, me.employmentId,');
    expect(leavePage).toContain('ess && me ? await sharedLeaveGroupBalances(');
    expect(leavePage).not.toContain('leaveRequestsFor(');
    // My Balances → the dashboard card (the primary tiles and the detailed balance card were replaced by it).
    expect(leavePage).toMatch(/\{ess && dashboard && \(\s*\n\s*<Card className="p-5" data-tour="me-leave">/);
    expect(leavePage).toContain('<div className="mt-3" data-tour="leave-balance">');
    // Upcoming Leave is own-leave too.
    expect(leavePage).toMatch(/\{ess && \(\s*\n\s*<Card className="p-5">\s*\n\s*<h2 className="text-sm font-semibold">\{t\('myLeave\.upcomingTitle'\)\}/);
    // Request Leave. UPDATED BY ad965821 (AGENTS rule 18): the `ess` gate is intact and is still what this
    // block is about — a second condition was ADDED beside it, so an employee who qualifies for no leave
    // type at all gets no trigger rather than an empty form. Asserting the old exact shape would have
    // pinned the absence of that courtesy, which is not what 8ec63139 decided.
    expect(leavePage).toMatch(/\{ess && requestLeaveTypeOptions\.length > 0 && \(\s*\n\s*<RequestLeaveDialog/);
  });

  it('leaves leave application, approval and balance calculation untouched', () => {
    // Same server actions, same on-behalf-of options. r302 (6c9802c9): the balance figures are picked off the
    // SAME owners — leaveEntitlementBreakdown per year, and the Apply popup's own leaveTypeApplySummary for
    // "You can apply for" — in core/my-leave.ts; the page no longer derives a row itself.
    for (const kept of ['submitAction={requestLeaveAction}', 'previewAction={previewLeaveDeductionAction}']) {
      expect(leavePage.includes(kept), kept).toBe(true);
    }
    const myLeave = read('core/my-leave.ts');
    expect(myLeave).toContain('leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: b.leaveTypeId })');
    expect(myLeave).toContain('leaveEntitlementBreakdown(ctx, employmentId, storyId, asOf, locale)');
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
      expect(trackerAdminBranch.includes(name), name).toBe(false);
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
    //
    // 3ddae357 UPDATED THIS CASE rather than dropping it. It pinned the call as
    // `{ includeHidden: true }` with NO date, which was precisely the defect: `asOf` reached the breakdown
    // and not the balances, so Taken / Pending / Overutilized / Balance answered for the whole record at
    // every date. `includeHidden` is still required and is still asserted; only the "and nothing else"
    // half was retired. Both reads must now take THE SAME `asOf` — that is the property this case exists
    // to hold, and a screen where the two reads disagree about the date is the bug returning.
    // ec991c2a: `includeArchived: true` joined `includeHidden: true` — an ADMIN read keeps showing the
    // balance standing under a retired leave type. Same two reads, same helper; only the flag list grew.
    // d272834b UPDATED THIS PIN, it did not loosen it: `includeIneligible: true` joined the flag list so
    // HR keeps seeing a balance standing under a leave type the employee is not eligible for (the 55
    // wrongly-granted Maternity balances are read from this screen). Same read, same asOf, same helper.
    expect(rowsHelper).toContain(
      'leaveBalances(ctx, employmentId, locale, { includeHidden: true, includeArchived: true, includeIneligible: true, asOf })',
    );
    // r303 (31492f74) UPDATED THIS PIN, it did not retire it: the SAME read at the SAME asOf and locale, now
    // asking for the per-line working HR's Explain panel prints (`derivation: true`). Still ONE read.
    expect(rowsHelper).toContain('leaveEntitlementBreakdown(ctx, employmentId, b.leaveTypeId, asOf, locale, { derivation: true })');
    expect(rowsHelper).toContain('deriveBalanceRow(');
    // ESS per-component hiding is a self-service rule; HR sees the figure.
    expect(rowsHelper).toContain('essView: {}');
  });

  it('renders all eleven requested columns, plus the twelfth r242 added and the thirteenth r279 added', () => {
    // UPDATED BY r242 AND AGAIN BY r279 (AGENTS rule 18), not rewritten. The eleven the reporter asked for in
    // 20c699f8 are still asserted one by one and none of them moved; what changed is that a TWELFTH column
    // was added on the reporter's approved plan — the Explanation column whose button opens the read-only
    // entitlement side-sheet — and then a THIRTEENTH, Full Entitlement. 39136455 (r306) added a FOURTEENTH
    // and FIFTEENTH, Share and Pending Share, between Adjustment and Balance. Deleting the eleven-column
    // claim to make room for any of them would have retired a promise that is still being kept; the
    // empty-state colSpan is the one figure that HAD to move with them, because a colSpan that no longer
    // spans the header is a visibly broken empty row.
    for (const col of [
      "tInq('colLeaveCode')",
      "tInq('colEntitlementYear')",
      // r279 — the full-year allowance, immediately before the earned-to-date figure it explains.
      "tMe('leaveBalanceTable.colFullEntitlement')",
      // 7da0a4e7 (r340) — UPDATED, not deleted: the column is still asserted, it just takes its NAME from
      // lib/leave-figure-labels.ts now, so the screen and the CSV/Excel export cannot call one figure two
      // things. The eleven-column promise below is untouched.
      'tf(LEAVE_FIGURE_LABEL_KEY.ytdEntitled)',
      "tInq('colBroughtForward')",
      "tMe('leaveBalanceTable.colTaken')",
      "tInq('colPendingApproval')",
      "tMe('leaveBalanceTable.colAdjustment')",
      "tMe('leaveBalanceTable.colOverutilized')",
      "tInq('colForfeitedBf')",
      "tMe('leaveBalanceTable.colBalance')",
      // r355 (4c63b37e) — the SIXTEENTH column, immediately after Balance, named from the shared figure
      // dictionary (7da0a4e7) so the screen and the export cannot call one figure two things. It is a column
      // over a figure the row already carried, not a new read: the pin below on the single `leaveBalances`
      // call is untouched and is what keeps it that way.
      'tf(LEAVE_FIGURE_LABEL_KEY.available)',
      "tInq('colDate')",
      // r242 — the Explanation column, LAST, so no numeric column is pushed around by it.
      "tInq('colExplanation')",
    ]) {
      expect(balancesPage.includes(col), col).toBe(true);
    }
    expect(balancesPage).toContain('colSpan={16}');
  });

  /**
   * r242 — THE EXPLANATION BUTTON, AND THE ONE THING THAT MUST NOT BE TRUE OF IT.
   *
   * The reporter's complaint was that nothing on this screen answers "how was this figure arrived at". The
   * answer already existed — the same read-only side-sheet opens on /me and on the personnel record — so
   * the build is a MOUNT, not a new panel. The expensive way to get that wrong is to fetch the breakdown
   * again for the panel: the screen would then hold two answers derived at two instants, and HR would quote
   * whichever one the page happened to render. `rows.ts`'s own header forbids a third source for exactly
   * that reason; this pins the panel to the same rule.
   */
  it('the Explain panel is fed from the breakdown the ROW already loaded — never a second read', () => {
    // ONE breakdown call in the whole row builder, and it is the one `deriveBalanceRow` is handed.
    expect((rowsHelper.match(/leaveEntitlementBreakdown\(/g) ?? []).length, 'exactly one breakdown read').toBe(1);
    expect(rowsHelper).toContain('const bd = byType.get(balanceStoryTypeId(b)) ?? null;');
    expect(rowsHelper).toContain('const row = deriveBalanceRow({ ...b, essView: {} }, bd);');
    // …and the row CARRIES that same object on to the panel, rather than the screen resolving its own.
    expect(rowsHelper).toContain('breakdown: bd,');
    // The panel's one non-breakdown line is the balance row's own authoritative `available`, and the
    // per-type visual is the balance row's too — both off `b`, neither recomputed here.
    expect(rowsHelper).toContain('available: b.available,');
    expect(rowsHelper).toContain('visual: { color: b.color, icon: b.icon, code: b.code },');

    // The SCREEN reads nothing of its own for the panel: it renders what the row handed it.
    expect(balancesPage).toContain('<EntitlementBreakdown');
    expect(balancesPage).toContain('data={r.breakdown}');
    expect(balancesPage).toContain('summary={{ available: r.available }}');
    expect(balancesPage).toContain('visual={r.visual}');
    // A breakdown read on the page would be the second source. Asserted on the CALL SHAPE, so the
    // explanatory prose in this file and in the page may keep naming the function (AGENTS 27).
    expect(balancesPage, 'the page must not read the breakdown itself').not.toMatch(/leaveEntitlementBreakdown\(/);
    // Same as-at date as every figure in the row: the panel is titled "As at {date}", so a panel opened
    // from a back-dated grid must answer for that date and not for today.
    expect(balancesPage).toMatch(/<EntitlementBreakdown[\s\S]{0,400}?asOf=\{asOf\}/);
  });

  it('THE ESS GATE DIFFERENCE SURVIVES THE PANEL — hiding a figure from self-service is not a rule about HR', () => {
    // `essView: {}` (missing key ⇒ visible) is asserted above for the ROW. The panel has its own switch for
    // the same decision, and it must be left off here for the same reason: /me passes `applyEssConfig` so an
    // employee sees only the lines HR left visible; this screen and /admin/personnel/[id] do not, so HR sees
    // the whole column. Passing it here would hide from HR exactly the lines HR is looking the figure up to
    // explain — the ONE deliberate difference between this screen and the employee's, quietly undone.
    const mount = balancesPage.slice(balancesPage.indexOf('<EntitlementBreakdown'));
    expect(mount.slice(0, mount.indexOf('/>')), 'HR must not be ESS-gated').not.toContain('applyEssConfig');
    expect(read('app/admin/personnel/[employmentId]/page.tsx')).toContain('<EntitlementBreakdown');
  });

  /**
   * r303 (31492f74) — HR'S SENTENCES RIDE ON THE SAME ROW. The Explain panel on this screen now replaces each
   * line's icon with sentences written from this employee's records. The switch (`hrExplanation`) is set by the
   * row builder off the SAME balance row every figure came from (its pool descriptor), and the working behind the
   * sentences is the SAME `bd` (`derivation: true` on the one read) — no second read, no second source. The
   * Personnel record is the other HR mount and passes it too; the employee's My Leave dashboard never does.
   */
  it('r303: both HR mounts switch the sentences on, off the row they already hold; the employee mount does not', () => {
    const mount = balancesPage.slice(balancesPage.indexOf('<EntitlementBreakdown'));
    expect(mount.slice(0, mount.indexOf('/>'))).toContain('hrExplanation={r.hrExplanation}');
    // 2a57a007 (r340) — THE OBJECT GAINED A SECOND FIELD AND THIS LITERAL WAS UPDATED TO MATCH, because the
    // claim it makes is unchanged: the switch is still built off the SAME balance row this screen's figures came
    // from, in the row builder, with no second read. `entitlementFromPool` is the one fact the panel cannot
    // derive for itself — for a borrower the breakdown it is handed IS the pool's, so the borrower's row and the
    // pool's own row are indistinguishable from inside the panel — and without it the panel printed the pool's
    // Entitlement one click from a grid row reading 0.00. Both halves are read off `row`/`fromPool` here, which
    // is what this case exists to protect.
    expect(rowsHelper).toContain('hrExplanation: { sharedBalance: row.sharedBalance, entitlementFromPool: fromPool },');
    expect(rowsHelper, 'and that fact is decided by the ONE shared predicate, not re-derived').toContain(
      'const fromPool = borrower ? (row.sharedBalance?.sourceLeaveTypeName ?? null) : null;',
    );
    expect((rowsHelper.match(/leaveEntitlementBreakdown\(/g) ?? []).length, 'still exactly one breakdown read').toBe(1);
    const personnel = read('app/admin/personnel/[employmentId]/page.tsx');
    // The Personnel record is HR-only for the sentences by the page's OWN admin predicate: the read and the switch
    // go through ./leave-breakdowns.ts, which asks `isAdmin(s)` (driven with real sessions in
    // test/r303-personnel-leave-explain.test.ts).
    expect(personnel).toContain('await personnelLeaveBreakdowns(s, employmentId, balances.map((b) => b.leaveTypeId), breakdownAsOf)');
    const helper = read('app/admin/personnel/[employmentId]/leave-breakdowns.ts');
    expect(helper).toContain('const derivation = isAdmin(s);');
    expect(helper).toContain('return isAdmin(s) ? { sharedBalance: sharedBalance ?? null } : undefined;');
    const pMount = personnel.slice(personnel.indexOf('<EntitlementBreakdown'));
    expect(pMount.slice(0, pMount.indexOf('/>'))).toContain('hrExplanation={personnelHrExplanation(s, b.sharedBalance)}');
    expect(pMount.slice(0, pMount.indexOf('/>')), 'HR must not be ESS-gated').not.toContain('applyEssConfig');
    // The employee side: neither the prop nor the working.
    expect(read('components/leave/my-leave-dashboard.tsx')).not.toContain('hrExplanation');
    expect(read('core/my-leave.ts')).not.toContain('derivation: true');
  });

  it('re-runs BOTH reads when the as-at date changes (nothing is cached against another date)', () => {
    expect(balancesPage).toContain('name="asOf"');
    expect(balancesPage).toContain('employeeBalanceRows(session, selected.employmentId, asOf, locale');
    // 3ddae357 — the title of this case was true of the BREAKDOWN and false of the balances, which is how
    // the defect passed review for four releases. The claim is only worth making if both reads take the
    // date, so the second half is pinned here too. Point-in-time behaviour itself is proven against real
    // ledger rows in test/leave-balance-as-at-date.test.ts; this is the composition half.
    expect(read('core/read.ts')).toContain('lte(leaveLedger.effectiveOn, asOf)');
    expect(read('core/read.ts')).toContain('lte(leaveRequest.startDate, asOf)');
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
      // r242 — the Explanation column heading and its button caption. Both are rendered by a bare
      // tInq(...) with no argument, so a {brace} in any catalogue would throw at render behind a green
      // 200 (AGENTS 6); the ICU check below is the other half of that.
      'colExplanation', 'explainAction',
    ];
    for (const loc of LOCALES) {
      const inquiry = (msgs(loc) as unknown as { leave: { inquiry: Record<string, string> } }).leave.inquiry;
      for (const k of keys) expect(inquiry?.[k], `${loc} leave.inquiry.${k}`).toBeTruthy();
      for (const k of ['colExplanation', 'explainAction']) {
        expect(inquiry[k], `${loc} leave.inquiry.${k} must take no ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });
});

// r378 retires the Employee Details listing; its shape tests are replaced by
// complete-removal and compatibility guards. Balances/records data guards above stay intact.
describe('r378 · the old employee listing is gone, while scoped inquiry selection remains', () => {
  it('tracker contains no listing read, forms, columns or three-tab navigation', () => {
    for (const token of ['listEmployeesPage(', '<LeaveInquiryNav', 'employeeFilterFields', 'colPosition', 'inquiryPageWindow(']) expect(trackerPage).not.toContain(token);
    expect(trackerPage).toContain('if (admin && !calendarIntent)');
    expect(trackerPage).toContain("edQ: 'pickerQ'");
    expect(trackerPage).toContain("edCompany: 'pickerCompany'");
    expect(trackerPage).toContain("edDept: 'pickerDepartment'");
    expect(trackerPage).toContain("edStatus: 'pickerStatus'");
    expect(trackerPage).toContain("p.set('emp', emp)");
  });
  it('both remaining views read the fenced list and validate selection against it', () => {
    for(const name of ['employee-balances','employee-records']) {
      const source=read(`app/leave/${name}/page.tsx`);
      expect(source).toContain('await scopedAdmin()');
      expect(source).toContain('listEmployees(session, scopeIds)');
      expect(source).toContain('selectInquiryEmployee(employees, sp.emp)');
      expect(source).toContain('preservePicker');
    }
  });
  it('numbers the pages — 1 2 3 Next >, with the far ends always one click away', () => {
    expect(trackerAdminBranch).not.toContain('inquiryPageWindow(edPage, employeePageCount)');
    expect(trackerAdminBranch).not.toContain("tInq('pageNext')");
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
