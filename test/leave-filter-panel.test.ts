/**
 * Advanced Search & Filter for Leave Management (feedback 0773bda9) — static-source guard.
 *
 * afd0a87c RE-SCOPED THIS FILE. It guarded the admin /leave surface's global search bar, consolidated
 * filter panel, sortable headers, pager and CSV/Excel export — all of which belonged to the ORG-WIDE
 * REQUEST TABLE, which the reporter has since asked to remove outright. What survives on that page is the
 * Employee Details listing, which has a filter panel of its OWN (employeeFilterFields), and the
 * FilterPanel component both used.
 *
 * So the two halves that still have a subject are kept and re-pointed: the component's multi-select /
 * accessibility contract, and the surviving listing's use of it. The request-table half is inverted into
 * a removal guard — a half-removed table leaves a read running for nobody, which is the expensive half.
 * The export route it fed is deleted, so its describe block goes with it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

describe('leave filter panel: the HR-admin Employee Details surface', () => {
  // REPOINTED BY 388e53c2. The listing this block is about did not change — it MOVED, from /leave to the
  // Team Leave Tracker route, because the sidebar lights a row by path prefix and every /leave/* screen
  // kept "My Leave" lit while an administrator read somebody else's leave record. So the panel assertions
  // follow the panel, and /leave is asserted to have kept none of it.
  const src = read('app/leave/tracker/page.tsx');
  const leavePage = read('app/leave/page.tsx');

  it('still imports FilterPanel + FilterChips — the Employee Details listing uses them', () => {
    expect(src).toMatch(/import\s*\{[^}]*FilterPanel[^}]*\}\s*from\s*'@\/components\/filter-panel'/);
    expect(src).toMatch(/FilterChips/);
    expect(src.includes('fields={employeeFilterFields}')).toBe(true);
  });

  it('THE PANEL POSTS BACK TO ITS OWN PAGE — a form left on /leave silently leaves the screen', () => {
    // The trap in the lift, and the one no type checker sees: the search form, the FilterPanel and the
    // FilterChips row each hardcoded `action="/leave"`. Carried over unchanged, pressing Search or
    // applying a filter would throw an administrator off the screen they are working on.
    expect(src.match(/action="\/leave\/tracker"/g) ?? []).toHaveLength(3);
    expect(src).not.toMatch(/action="\/leave"/);
  });

  it('the org-wide read is gone, and the self-service read is NOT', () => {
    // The expensive half of a half-removal is a read still running for a table nobody renders.
    //
    // UPDATED BY 5f2e20fb (AGENTS rule 18 — the half that is still right is kept, the half that pinned the
    // reversed decision is re-expressed, and the case is NOT deleted). This used to assert that
    // `listLeaveRequestsPage` was absent from /leave altogether, on the reasoning that its presence meant
    // the org-wide register had come back. That reasoning no longer holds: the employee's own My Leave
    // History now filters by date and leave type, and the paginated read is where those filters live. What
    // makes a call org-wide is not its NAME but its SCOPE — so the assertion moved to the scope.
    //
    // Every call on this page must be narrowed to the viewer's own employments. A `companyIds:` or
    // `statuses:` argument here would be the register returning.
    const pageCalls = leavePage.match(/listLeaveRequestsPage\(session, \{[\s\S]*?\n\s*\}\)/g) ?? [];
    expect(pageCalls.length, 'the self-service history reads the paginated, self-narrowed read').toBe(2);
    for (const call of pageCalls) {
      expect(call, 'every /leave history read is narrowed to the viewer').toContain(
        'employmentIds: historyEmploymentIds',
      );
      expect(call).not.toContain('companyIds:');
      expect(call).not.toContain('statuses:');
    }
    // And it is the VIEWER's own employments — not just the current one, or a rehired person loses the
    // records of their earlier employment (the personId test this replaced kept them).
    expect(leavePage).toContain('const myEmploymentIds = (await myEmploymentIdsAll(session)).map(');
    // The flat scope-wide read it replaced must not linger alongside it: two history reads on one page is
    // the same "read running for nobody" this block exists to catch.
    expect(leavePage.includes('listLeaveRequests(session, scopeIds)')).toBe(false);
    // And the listing that replaced it as the admin's landing view survives, at its new address.
    expect(src.includes('listEmployeesPage(s, {')).toBe(true);
    expect(leavePage.includes('listEmployeesPage'), 'the listing must not be left behind too').toBe(false);
  });

  it('5f2e20fb: My Leave History carries the SAME filter control, prefixed so old admin links stay inert', () => {
    // Three fields, one multi + two dates, exactly the shape app/leave/employee-records/page.tsx uses.
    expect(leavePage).toMatch(/import \{ FilterChips, FilterPanel, type FilterField \} from '@\/components\/filter-panel'/);
    expect(leavePage).toContain("kind: 'multi'");
    expect((leavePage.match(/kind: 'date'/g) ?? []).length).toBe(2);
    expect(leavePage).toContain("name: 'hType'");
    expect(leavePage).toContain("name: 'hFrom'");
    expect(leavePage).toContain("name: 'hTo'");
    // The panel and its chips both post back to THIS page, and both carry the page's foreign params so
    // applying a filter cannot reset the as-at date or the holiday banner.
    expect((leavePage.match(/action="\/leave"\n\s+fields=\{historyFilterFields\}/g) ?? []).length).toBe(2);
    expect((leavePage.match(/hidden=\{historyHiddenParams\}/g) ?? []).length).toBe(2);
    // THE PREFIX IS THE POINT: the retired register owned bare from/to/type on this same path, and a saved
    // admin link carrying them must keep arriving unfiltered.
    for (const bare of ['from?: string', 'to?: string', 'type?: string']) {
      expect(leavePage.includes(bare), `${bare} would revive a stale admin link as a filter`).toBe(false);
    }
    // Empty-with-filters says the filters matched nothing — NOT requestsEmpty, which means "no records at all".
    expect(leavePage).toContain("t('filters.emptyFiltered')");
    expect(leavePage).toContain("t('filters.showingOf', { shown: selfHistory.length, total })");
    // LAYOUT TRAP: FilterPanel's popover is absolutely positioned, not a portal, so a clipping ancestor
    // would cut it off. The history Card must not clip.
    expect(leavePage).toContain('<Card className={`flex flex-col ${COLUMN_CAP}`} data-tour="leave-requests">');
  });

  it('ad965821: the ESS apply dropdown is built from the ELIGIBILITY-filtered read', () => {
    // The defect lived in the CONTRACT between this page and core/read.ts (AGENTS rule 17), so it is pinned
    // on both halves: a unit test of either one passes throughout.
    expect(leavePage).toContain('listEligibleLeaveTypesFor(session, me.employmentId, locale)');
    // REV 2 pinned a UNION here — the option list drawn from every subject a line manager could pick,
    // because LeaveDurationFields intersects `types` with the selected subject's set and a viewer-only
    // array made the on-behalf offer eligible(manager) ∩ eligible(report).
    //
    // UPDATED BY 5206539f (AGENTS rule 18). THE UNION IS GONE BECAUSE ITS SUBJECT IS. A line manager has no
    // Employee selector at all now: applying on someone else's behalf is the named permission
    // `leave.apply_on_behalf`, held by HR roles and by nobody else unless a customer grants it, and "does
    // anyone report to you" grants nothing. With one subject on the self-service path — the viewer — the
    // union and the downstream intersection both collapse to the viewer's own eligible set, which is what
    // the dropdown is built from. The PROPERTY this case defends is unchanged and is asserted below: the
    // apply dropdown is drawn from an ELIGIBILITY-FILTERED read, never from the raw catalogue.
    expect(leavePage).toContain('const requestLeaveTypeOptions = eligibleLeaveTypes.map((lt) => ({');
    // …and the per-subject narrowing machinery is DELETED, not merely unused: the extra map read, the
    // filter that dropped a subject with an empty eligible set, and the fallback that put the viewer back.
    for (const gone of [
      'eligibleTypeIdsByEmployment',
      'selectableSubjects',
      'requestLeaveSubjects',
      'offerableTypeIds',
      'offerableLeaveTypes',
      'eligibleLeaveTypeIdsFor',
    ]) {
      expect(leavePage, `${gone} survived the collapse`).not.toContain(gone);
    }
    // …and the Replacement Leave dialog, which has NO employee selector, keeps the viewer's own list. It was
    // already the viewer's own under rev 2 and is unchanged; the two dropdowns now agree by construction.
    expect(leavePage).toContain(
      'const replacementLeaveTypeOptions = eligibleLeaveTypes.map((lt) => ({ id: lt.id, label: lt.name }));',
    );
    expect(leavePage).toContain('types={replacementLeaveTypeOptions}');
    // WHO a permission holder may pick, and in what order: everyone in scope, VIEWER FIRST. That ordering is
    // the one rev-2 rule that survives, and it survives for a stronger reason than before — the dialog
    // defaults its employment selector to the first option, so without it a holder opening Request Leave is
    // pointed at somebody else's balance before touching anything.
    expect(leavePage).toMatch(
      /const requestLeaveEmployeeOptions = \[\s*\n\s*\.\.\.active\.filter\(\(e\) => e\.employmentId === me\.employmentId\),\s*\n\s*\.\.\.active\.filter\(\(e\) => e\.employmentId !== me\.employmentId\),/,
    );
    // Neither employee dialog may render an empty type <select>. The Replacement one carries no `required`
    // at all, so an empty list there posts leaveTypeId='' instead of being refused by the browser.
    expect(leavePage).toContain('{ess && requestLeaveTypeOptions.length > 0 && (');
    expect(leavePage).toContain(
      '{ess && replacementRequest.allowed && replacementLeaveTypeOptions.length > 0 && (',
    );
    // The unfiltered catalogue is STILL read — two consumers need it and would break silently otherwise.
    expect(leavePage).toContain("const unpaidTypeName = leaveTypes.find((lt) => lt.code === 'UNPAID')?.name;");
    expect(leavePage).toContain('eligibleTypeIds.has(lt.id) || lt.id === r.leaveTypeId');
    // NOTHING announces that a row was removed: no caption, no disabled option, no count under the select.
    const fields = read('components/leave-duration-fields.tsx');
    expect(fields).toContain('{visibleTypes.map((x) => (');
    // Sliced to the LEAVE TYPE select, WITH COMMENTS STRIPPED FIRST — both halves learned the hard way.
    // The duration select below legitimately renders `disabled` options (a type allowing no half day greys
    // that row), which is a different control answering a different question; and the comment that EXPLAINS
    // this rule says the words "disabled option", so an un-stripped scan reports its own documentation as
    // the violation. Same trap as test/filter-panel-not-nested.test.ts's stripComments.
    const code = fields.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const typeSelectAt = code.indexOf('name="leaveTypeId"');
    expect(typeSelectAt).toBeGreaterThan(-1);
    const typeSelect = code.slice(typeSelectAt, code.indexOf('</select>', typeSelectAt));
    expect(typeSelect).not.toMatch(/\sdisabled/);
    expect(typeSelect).not.toMatch(/opacity-|text-muted/);
    // …and no new message key was invented for one.
    const en = JSON.parse(read('messages/en.json')) as { leave: Record<string, unknown> };
    for (const invented of ['ineligibleHidden', 'someTypesHidden', 'eligibilityNotice', 'typesFilteredNotice']) {
      expect(en.leave[invented], `leave.${invented} — the reporter asked for NO such line`).toBeUndefined();
    }
  });

  it('the Employee Details panel is still admin-gated and still multi-select', () => {
    // The gate moved from a `{admin && (…)}` block to an EARLY RETURN on the same predicate, which is
    // strictly stronger: it suppresses the READS as well as the markup.
    expect(src.includes('isAdmin(s)')).toBe(true);
    expect(src).toMatch(/if \(admin\) \{/);
    expect(src.includes("kind: 'multi'")).toBe(true);
  });

  it('the retired request table takes its whole query contract with it', () => {
    // INVERTED from "preserves the full searchParams contract". Declaring a param nothing reads advertises
    // a filter that silently does nothing; a saved link carrying one now simply arrives unfiltered, which
    // the approved plan discloses. Asserted on the DECLARATION, so a re-added param without a reader fails.
    for (const param of [
      'q?: string',
      'company?: string',
      'bu?: string',
      'dept?: string',
      'loc?: string',
      'duration?: string',
      'appliedFrom?: string',
      'appliedTo?: string',
      'approvedBy?: string',
      'pendingWith?: string',
      'sort?: string',
      'dir?: string',
    ]) {
      expect(leavePage.includes(param), `${param} should be gone with the request table`).toBe(false);
    }
    // `emp` and the ed* contract SURVIVE — on the page that reads them. Their spelling is unchanged, so
    // every admin link already saved keeps working against the new base path.
    expect(src.includes('emp?: string | string[]')).toBe(true);
    for (const param of ['edQ?: string', 'edPage?: string', 'edCompany?: string | string[]']) {
      expect(src.includes(param), param).toBe(true);
      expect(leavePage.includes(param), `${param} still declared on /leave`).toBe(false);
    }
  });
});

describe('leave filter panel: component supports multi-select additively', () => {
  const src = read('components/filter-panel.tsx');

  it('renders a checkbox group for the multi kind while keeping GET/a11y fundamentals', () => {
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src.includes("kind: 'multi'")).toBe(true);
    expect(src.includes('type="checkbox"')).toBe(true);
    expect(src.includes('method="get"')).toBe(true);
    expect(src).toMatch(/action=\{action\}/);
    // Clear-all links back to the page's own base path. Feedback 650b6eb8 made that base carry the FOREIGN
    // params of a second listing on the same page (`hidden`), so the assertion follows the helper rather
    // than the bare `action` it used to be — clearing one listing must not clear the other.
    expect(src).toMatch(/href=\{baseHref\(action, hidden\)\}/);
    expect(src).toContain('const baseHref = (action: string, hidden: FilterPanelProps[\'hidden\']) => {');
    expect(src.includes('hrefWithout')).toBe(true);
    expect(src.includes('removeAriaLabel')).toBe(true);
    // hrefWithout can drop a single value of a multi field (per-value chip removal).
    expect(src).toMatch(/hrefWithout\s*=\s*\(name: string, value\?/);
  });
});

// afd0a87c — the 'leave export route: admin-gated CSV + Excel' block is gone with app/leave/export/route.ts.
// That route served the retired org-wide register and its only links in the whole application were on the
// section that has been removed; an unreachable admin download is worse than none. The surviving
// per-employee download is app/leave/employee-records/export/route.ts, guarded by its own tests.

describe('leave filter panel: i18n keys exist in en.json', () => {
  it('leave.filters carries the panel + page strings', () => {
    const en = JSON.parse(read('messages/en.json')) as { leave: { filters: Record<string, string> } };
    for (const key of [
      'filter',
      'apply',
      'clearAll',
      'activeCount',
      'removeFilter',
      'search',
      'searchPlaceholder',
      'company',
      'businessUnit',
      'department',
      'location',
      'leaveType',
      'statusLabel',
      'dateFrom',
      'dateTo',
      'appliedFrom',
      'appliedTo',
      'showingOf',
      'emptyFiltered',
      'newer',
      'older',
      'rangeOf',
      'export',
      'exportCsv',
      'exportExcel',
      'sortAria',
      // Approval Information (feedback 0773bda9 gap-close).
      'pendingWith',
      'approvedBy',
      'anyStage',
      'anyApprover',
      'decidedByLine',
      'pendingWithLine',
    ]) {
      expect(en.leave.filters[key], `leave.filters.${key}`).toBeTruthy();
    }
  });

  it('leave.filters.stage carries both approver-kind labels', () => {
    const en = JSON.parse(read('messages/en.json')) as {
      leave: { filters: { stage: Record<string, string> } };
    };
    expect(en.leave.filters.stage.direct_manager).toBeTruthy();
    expect(en.leave.filters.stage.hr_admin).toBeTruthy();
  });
});
