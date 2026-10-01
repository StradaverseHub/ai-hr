/** r378: legacy admin listing redirects to balances; explicit calendar intent preserves the unchanged calendar. */
/**
 * Team Leave Tracker (feedback a00c4f64) — the Leave Calendar moves off the Dashboard.
 *
 * "Move the existing Leave Calendar out of the Dashboard and create a dedicated Team Leave Tracker menu
 * under the Manage section… This is a relocation of the existing functionality only."
 *
 * A relocation has two failure modes and this file guards both:
 *
 *   1. THE MOVE IS INCOMPLETE — the calendar exists in its new home but something still points at the old
 *      one. There were four such pointers, three of which the plan did not name: the Team Away Today card's
 *      '#planned-absences' anchor (named), the "View Calendar" deep link from a subordinate's Personnel
 *      profile (lib/calendar-focus), the HR-admin cancel dialog's `back="/"` return surface, and — the one
 *      that would have been felt first — PlannedAbsencesPanel's three hardcoded `'/'` URL writes, which
 *      would have thrown a viewer back to the Dashboard the moment they paged to another week.
 *
 *   2. THE MOVE QUIETLY REMOVES ACCESS — the calendar was on EVERY employee's dashboard, so a Manage-group
 *      row with `managerUp` would take it away from plain staff while looking like a pure relocation. The
 *      row is ungated and that is asserted here as well as in test/leave-pack.test.ts, because it is the
 *      one property of this change a reader would not think to check.
 *
 * DB-free source guards (precedent: test/my-absence-nav.test.ts): the RSC pages cannot render in this
 * suite, so the move is asserted statically. The catalogue/layout half of the change — FIXED_ROW_KEYS
 * emptied, the card out of every role catalogue, migration 0404, and saved layouts self-healing — lives in
 * test/dashboard-fixed-row.test.ts.
 *
 * ── REWRITTEN BY 388e53c2, DELIBERATELY ──────────────────────────────────────────────────────────────
 *
 * This file pinned app/leave/tracker/page.tsx by SOURCE — its imports, its thirteen props, its person-id
 * expression — so it could not survive that page gaining a second render branch by preserving behaviour
 * alone. It was rewritten rather than repointed, and the rewrite KEEPS ITS INTENT and sharpens it:
 *
 *   · failure mode 2 above (the move quietly removes access) is now the SAME question asked of a role
 *     branch instead of a nav flag. Every assertion about the calendar is scoped to the NON-ADMIN branch,
 *     so a future edit that lets the admin surface swallow the calendar for staff fails here;
 *   · all thirteen props are still asserted BY NAME, in the branch that renders them;
 *   · the admin branch is asserted as an ADDITION, never as a replacement.
 *
 * The wider relocation — the rail's details href, /leave losing the listing, every inbound pointer still
 * resolving — is guarded in test/leave-inquiry-entry-relocation.test.ts, written for that item.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leavePack } from '../packs/leave';
import { CARD_META } from '../lib/dashboard-cards';
import { buildCalendarFocusHref } from '../lib/calendar-focus';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';
import { countQuoted } from './helpers/sidebar-source';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const trackerPage = read('app/leave/tracker/page.tsx');
const dashboard = read('app/page.tsx');
const sidebar = read('components/sidebar.tsx');

describe('the Manage row is ungated — the access the move must not remove', () => {
  it('the pack contributes ONE manage row at /leave/tracker with no managerUp and no adminOnly', () => {
    const manage = (leavePack.navLinks ?? []).filter((l) => l.group === 'manage');
    expect(manage).toHaveLength(1);
    expect(manage[0].href).toBe('/leave/tracker');
    expect(manage[0].labelKey).toBe('teamLeaveTracker');
    // The load-bearing pair. The Manage group gates PER ROW (canSeeChild), so absent flags = every
    // employee — which is exactly the audience the dashboard card had.
    expect(manage[0].managerUp, 'a managerUp row would silently remove this screen from staff').toBeUndefined();
    expect(manage[0].adminOnly).toBeUndefined();
  });

  it('the sidebar mounts it by reference into the Manage group and hardcodes no href', () => {
    expect(sidebar).toContain('const LEAVE_TRACKER_ROW');
    expect(sidebar).toContain('LEAVE_TRACKER_ROW,');
    // Mounted from the pack, not re-declared: the same property test/leave-pack.test.ts asserts for /leave.
    expect(countQuoted(sidebar, '/leave/tracker')).toBe(0);
  });

  it('is NOT entitlement-gated: leave is a core module, deliberately absent from MODULE_OF_HREF', () => {
    // The map is derived from the attendance/claims/payroll/performance packs' links only. A leave entry
    // creeping in would hide a core self-service screen from a tenant that was never sold a "leave module".
    expect(sidebar).not.toContain("'leave'] as const");
  });

  it('the Security & Permissions matrix carries the screen as scopedSession (every role reaches it)', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'leaveTracker');
    expect(screen, 'no matrix column for the new screen').toBeTruthy();
    expect(screen!.guard).toBe('scopedSession');
    expect(screen!.href).toBe('/leave/tracker');
    expect(REGISTERED_ROUTES.has('/leave/tracker')).toBe(true);
  });

  it('every locale carries nav.teamLeaveTracker and the page title/description', () => {
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as Record<string, Record<string, unknown>>;
      expect(m.nav.teamLeaveTracker, `${loc} nav.teamLeaveTracker`).toBeTruthy();
      const tracker = m.leaveTracker as Record<string, unknown>;
      expect(tracker?.title, `${loc} leaveTracker.title`).toBeTruthy();
      expect(tracker?.description, `${loc} leaveTracker.description`).toBeTruthy();
      // ICU guard: neither string may take arguments, because the page calls t('title')/t('description')
      // with none — a stray {brace} throws FORMATTING_ERROR at render, which no other gate step sees.
      for (const v of [m.nav.teamLeaveTracker, tracker.title, tracker.description]) {
        expect(String(v), `${loc}: no ICU arguments`).not.toMatch(/[{}]/);
      }
      expect((m.admin as never as Record<string, Record<string, Record<string, unknown>>>).users.scope.leaveTracker, `${loc} scope note`).toBeTruthy();
    }
  });
});

/**
 * The page renders ONE of two surfaces. `calendarBranch` is everything after the admin branch's closing
 * `}` — sliced at the `── The Leave Calendar` banner comment, which is the first line of it — so an
 * assertion made here cannot be satisfied by markup that only an administrator ever sees.
 */
const ADMIN_BRANCH_OPENS = '  if (admin && !calendarIntent) {';
const CALENDAR_BANNER = '  // ── The Leave Calendar';
const adminBranch = () => {
  const start = trackerPage.indexOf(ADMIN_BRANCH_OPENS);
  const end = trackerPage.indexOf(CALENDAR_BANNER, start);
  expect(start, 'legacy admin redirect branch exists').toBeGreaterThan(-1);
  expect(end, 'calendar follows the redirect branch').toBeGreaterThan(start);
  return trackerPage.slice(start, end);
};
const calendarBranch = () => {
  const start = trackerPage.indexOf(CALENDAR_BANNER);
  expect(start, 'calendar source slice exists').toBeGreaterThan(-1);
  const calendar = trackerPage.slice(start);
  expect(calendar).toContain('<PlannedAbsences');
  return calendar;
};

describe('the calendar is the SAME screen, not a rebuild', () => {
  it('the page really does have the two branches these assertions are scoped to', () => {
    // If either marker moves, every slice below silently becomes the whole file and the scoping is lost.
    expect(trackerPage.indexOf(ADMIN_BRANCH_OPENS), 'admin branch marker').toBeGreaterThan(-1);
    expect(trackerPage.indexOf(CALENDAR_BANNER), 'calendar branch marker').toBeGreaterThan(
      trackerPage.indexOf(ADMIN_BRANCH_OPENS),
    );
  });

  it('renders the shared component with the same thirteen props the dashboard passed it', () => {
    expect(trackerPage).toContain("import { PlannedAbsences } from '@/components/planned-absences'");
    // SCOPED TO THE NON-ADMIN BRANCH (388e53c2). Everyone who is not an HR administrator keeps this
    // calendar exactly as it was, and "exactly as it was" is these thirteen props by name.
    const calendar = calendarBranch();
    for (const prop of [
      'rows={absences}',
      'todayIso={todayIso}',
      'anchorIso={absParam}',
      'initialCalView={calView}',
      'showViewSwitch={showAbsViewSwitch}',
      'initialView={effectiveAbsView}',
      'viewerPersonId={s.personId}',
      'cancelAction={requestLeaveCancellationAction}',
      'viewerIsAdmin={admin}',
      'adminCancelAction={adminCancelLeaveAction}',
      'selfCancelAction={cancelOwnLeaveAction}',
      'viewerCanApprove={admin || managerRole}',
      'focusPersonId={absFocusPersonId}',
    ]) {
      expect(calendar, `lost prop: ${prop}`).toContain(prop);
    }
  });

  it('posts the UNCHANGED leave actions — the cancel/withdraw paths are not forked', () => {
    expect(trackerPage).toContain(
      "import { requestLeaveCancellationAction, adminCancelLeaveAction, cancelOwnLeaveAction } from '@/app/leave/actions'",
    );
  });

  it('resolves scope and window with the shared helpers, not a second implementation', () => {
    const calendar = calendarBranch();
    for (const call of [
      'reportingLinesFor(',
      'plannedAbsences(',
      'resolveCalendarFetchWindow(',
      'resolveViewPreference(',
      'parseCalendarFocus(',
    ]) {
      expect(calendar, `missing ${call}`).toContain(call);
    }
    // Session + MYT today are resolved ONCE, above the branch, and both surfaces use them.
    for (const call of ['scopedSession()', 'todayInKualaLumpur()']) {
      expect(trackerPage, `missing ${call}`).toContain(call);
    }
    // The person scope is the viewer + direct reports, exactly as the dashboard computed it — never the
    // company. An empty array matches nothing in the read, which is the safe direction.
    expect(calendar).toContain('personIds: teamPersonIds');
    expect(calendar).toContain('const hasDirectReports = (reportingLines?.reports.length ?? 0) > 0;');
    expect(calendar).toContain('const showAbsViewSwitch = hasDirectReports;');
  });

  it('crosses the server/client boundary with serialisable props only (no closures)', () => {
    // The calendar is a server component that hands SERVER ACTIONS to a client island. Actions are
    // serialisable; a locally-defined arrow would not be. test/server-client-boundary.test.ts pins the
    // class repo-wide — this asserts this page does not open a hole in it.
    const jsxStart = trackerPage.indexOf('<PlannedAbsences');
    expect(jsxStart).toBeGreaterThan(-1);
    const jsx = trackerPage.slice(jsxStart);
    expect(jsx).not.toMatch(/=\{\s*\([^)]*\)\s*=>/);
    expect(jsx).not.toMatch(/=\{\s*function\b/);
  });
});

describe('r378 · legacy HR inquiry links redirect while explicit calendar intent retains the calendar', () => {
  it('redirects only an admin without calendar intent, before calendar reads', () => {
    expect(trackerPage).toContain('const admin = isAdmin(s);');
    expect(trackerPage).toContain("const calendarIntent = sp.calendar === '1' || ['abs', 'view', 'cal', 'focus'].some((key) => key in sp);");
    const legacy = adminBranch();
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy).toContain("redirect(`/leave/employee-balances${p.size ? `?${p}` : ''}`)");
    expect(legacy).not.toContain('plannedAbsences(');
    expect(calendarBranch()).not.toContain('listEmployeesPage(');
    expect(trackerPage).not.toContain('<LeaveInquiryNav active="details"');
  });

  it('forwards the selected employee and legacy search/filter meanings into the picker namespace', () => {
    const legacy = adminBranch();
    expect(legacy).toContain('const emp = Array.isArray(sp.emp) ? sp.emp[0] : sp.emp;');
    expect(legacy).toContain("if (emp) p.set('emp', emp);");
    expect(legacy).toContain("const mapping = { edQ: 'pickerQ', edCompany: 'pickerCompany', edDept: 'pickerDepartment', edStatus: 'pickerStatus' } as const;");
    expect(legacy).toContain('for (const [oldKey, key] of Object.entries(mapping))');
    expect(legacy).toContain('for (const one of Array.isArray(value) ? value : value ? [value] : []) p.append(key, one);');
    expect(legacy).not.toContain("p.set('edPage'");
  });

  it('the moved picker stays scoped and navigates to balances instead of posting to the retired listing', () => {
    const balances = read('app/leave/employee-balances/page.tsx');
    expect(balances).toContain('await scopedAdmin()');
    expect(balances).toContain('scopeIds');
    expect(balances).toContain('<EmployeeScopePanel');
    expect(balances).toContain('basePath="/leave/employee-balances"');
    expect(balances).toContain('selectParam="emp"');
    expect(trackerPage).not.toContain('action="/leave/tracker"');
  });

  it('the balances and records routes remain registered at their saved/export addresses', () => {
    for (const href of ['/leave/employee-balances', '/leave/employee-records']) {
      expect(REGISTERED_ROUTES.has(href)).toBe(true);
      expect(fs.existsSync(path.join(root, `app${href}/page.tsx`))).toBe(true);
      expect(read(`app${href}/page.tsx`)).toContain('await scopedAdmin()');
    }
  });

  it('every string it prints is pinned per locale — this file is multi-namespace, so check C skips it', () => {
    // i18n-coverage check C only reads single-namespace files, and the admin branch pulls four namespaces
    // (leave, leave.inquiry, people.list, people.employeeStatus). Without this, a typo'd key ships green
    // and paints its own path on the screen.
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as Record<string, Record<string, unknown>>;
      const inquiry = (m.leave as Record<string, Record<string, string>>).inquiry;
      for (const k of [
        'employeeDetails',
        'detailsDescription',
        'detailsSearchPlaceholder',
        'colEmployeeName',
        'colPosition',
        'openBalances',
        'pagePrev',
        'pageNext',
        'pageAria',
        'noEmployees',
        'noEmployeesFiltered',
      ]) {
        expect(inquiry?.[k], `${loc} leave.inquiry.${k}`).toBeTruthy();
      }
      // The page header calls tInq('detailsDescription') with NO arguments — a {brace} throws
      // FORMATTING_ERROR at render, which tsc, the suite and `next build` all pass.
      expect(String(inquiry.detailsDescription), `${loc}: no ICU arguments`).not.toMatch(/[{}]/);
      const people = m.people as Record<string, Record<string, string>>;
      expect(people.list.colStatus, `${loc} people.list.colStatus`).toBeTruthy();
      const filters = (m.leave as Record<string, Record<string, string>>).filters;
      for (const k of ['employeeId', 'company', 'department', 'search', 'showingOf']) {
        expect(filters?.[k], `${loc} leave.filters.${k}`).toBeTruthy();
      }
    }
  });
});

describe('the Dashboard no longer carries the calendar', () => {
  it('drops the block, the read and every import that fed it', () => {
    for (const gone of [
      'PlannedAbsences',
      'plannedAbsencesBlock',
      'planned-absences',
      'plannedAbsences(',
      'resolveCalendarFetchWindow',
      'resolveViewPreference',
      'parseCalendarFocus',
      'leave-calendar-range',
      'calendar-focus',
    ]) {
      expect(dashboard, `still on the dashboard: ${gone}`).not.toContain(gone);
    }
  });

  it('drops the calendar-only search params and the core/leave import they needed', () => {
    // ?abs / ?view / ?cal / ?focus were the calendar's; the page takes no props at all now (asserted on
    // the signature, not on the word — the comment above it explains the removal and would match).
    // r292 UPDATED THIS RATCHET RATHER THAN LOOSENING IT. a00c4f64's intent was "the four CALENDAR params
    // are gone", and at the time that was expressible as "the page takes no props at all". r292's module
    // gating reinstates searchParams for exactly ONE param — `?moduleUnavailable=<code>`, the destination
    // half of requireModule()'s redirect — so the old spelling now fails while the decision it protects is
    // untouched. Asserting the calendar four are absent AND that nothing else crept in is strictly
    // STRONGER than the signature check it replaces: it names what must not come back, and bounds what may
    // be there. Do not weaken this to "contains searchParams".
    expect(dashboard).toContain('export default async function DashboardPage({');
    const sigMatch = dashboard.match(/searchParams\?:\s*Promise<\{([^}]*)\}>/);
    expect(sigMatch, 'DashboardPage still declares its searchParams shape inline').not.toBeNull();
    const declaredParams = (sigMatch?.[1] ?? '')
      .split(';')
      .map((p) => p.split(':')[0].replace('?', '').trim())
      .filter(Boolean);
    expect(declaredParams).toEqual(['moduleUnavailable']);
    // …which also retires app/page.tsx from the leave pack's drift allowlist (the ratchet only shrinks).
    expect(dashboard).not.toContain("from '@/core/leave'");
    const allowlist = JSON.parse(read('test/pack-drift-allowlist.json')) as Record<string, string[]>;
    expect(allowlist.leave).not.toContain('app/page.tsx');
  });

  it('keeps the Team Away Today COUNT — it never came from the calendar read', () => {
    // The plan assumed this card was fed by the plannedAbsences projection. It is not: eae550e9 replaced
    // that with the narrow indexed awayTodayCount, which is why the figure survives the move untouched.
    expect(dashboard).toContain('awayTodayCount(s, scopeIds, todayIso, s.personId ?? null)');
  });
});

describe('every pointer at the old location follows the calendar', () => {
  it('the Team Away Today card navigates to the tracker instead of an in-page anchor', () => {
    expect(CARD_META.teamAwayToday.href).toBe('/leave/tracker');
    // The dashboard renders that card from a literal, not from CARD_META, so both must move together.
    expect(dashboard).toContain('href="/leave/tracker?calendar=1"');
    expect(dashboard).not.toContain('#planned-absences');
  });

  it('the manager builtin card catalogue carries the same href (fallback vs seed parity)', () => {
    const layout = read('lib/dashboard-layout.ts');
    expect(layout).toContain("{ cardKey: 'teamAwayToday', name: 'Team Away Today', cardType: 'information', href: '/leave/tracker'");
    // …and migration 0404 repoints the seeded rows to match, or a tenant's DB and the fallback disagree.
    expect(read('db/migrations/0404_leave_calendar_off_dashboard.sql')).toContain("SET href = '/leave/tracker'");
  });

  it("the Personnel profile's View Calendar deep link lands on the tracker", () => {
    expect(buildCalendarFocusHref('11111111-2222-3333-4444-555555555555')).toBe(
      '/leave/tracker?view=team&focus=11111111-2222-3333-4444-555555555555',
    );
  });

  it('the HR-admin cancel dialog returns to the calendar, and the action whitelists that surface', () => {
    expect(read('components/planned-absences-grid.tsx')).toContain('back="/leave/tracker"');
    expect(read('app/leave/actions.ts')).toContain("if (backRaw === '/leave/tracker') back = '/leave/tracker?calendar=1';");
    // The cancel paths must also refresh the page they were posted from.
    expect(read('app/leave/actions.ts')).toContain("revalidatePath('/leave/tracker')");
  });

  it('THE PANEL NAVIGATES TO ITS OWN PATH — no hardcoded dashboard URL survives', () => {
    // The one that would have been felt first: three writes (router.push on date navigation, and two
    // history.replaceState calls for the My/Team and Week/Month toggles) all wrote '/'. On /leave/tracker
    // that is a redirect to the Dashboard mid-task.
    const panel = read('components/planned-absences-panel.tsx');
    expect(panel).toContain('usePathname');
    expect(panel).toContain('const selfHref = (qs: string)');
    expect(panel).not.toMatch(/`\/\?\$\{qs\}`/);
    expect(panel.match(/selfHref\(qs\)/g) ?? []).toHaveLength(3);
  });

  it('no user-visible copy still describes the Leave Calendar as the pinned full-width card', () => {
    // The pointers above are all hrefs; these are PROSE, and they are the half a code-only sweep misses.
    // Two of them render UNCONDITIONALLY on Settings → Dashboard → Templates (templateRow2Desc at
    // app/admin/settings/dashboard/page.tsx:464, templateDerivedNote at :479), so after the move an HR
    // admin was being told a card that no longer exists is pinned across the full width. The third
    // (dashboard.pinnedRowHint) sits behind `fixedKeys.length > 0` and is unreachable while
    // FIXED_ROW_KEYS is empty — generalised anyway, because that list is kept for the NEXT full-width
    // card and the hint would have come back naming the wrong one.
    const en = JSON.parse(read('messages/en.json')) as Record<string, Record<string, unknown>>;
    // The Templates explainer reads `dashboardCardConfig.manage` (page.tsx:46), not the `dashboard` namespace.
    const manage = (en.dashboardCardConfig as Record<string, Record<string, string>>).manage;
    for (const [key, text] of [
      ['dashboard.pinnedRowHint', en.dashboard.pinnedRowHint as string],
      ['dashboardCardConfig.manage.templateRow2Desc', manage.templateRow2Desc],
      ['dashboardCardConfig.manage.templateDerivedNote', manage.templateDerivedNote],
    ] as const) {
      expect(text, `${key} is missing`).toBeTruthy();
      expect(text, `${key} still names the Leave Calendar`).not.toMatch(/Leave Calendar/i);
    }
    // All three are called with NO arguments, so a translator reintroducing an ICU placeholder would
    // throw FORMATTING_ERROR at render — which tsc, the suite and `next build` all pass.
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as Record<string, Record<string, unknown>>;
      const c = (m.dashboardCardConfig as Record<string, Record<string, string>>).manage;
      for (const v of [m.dashboard.pinnedRowHint as string, c.templateRow2Desc, c.templateDerivedNote]) {
        expect(v, `${loc}: unexpected ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });
});

describe('migration 0404 is journalled (a .sql file alone silently never runs)', () => {
  it('has a journal entry whose tag matches the file on disk', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const entry = journal.entries.find((e) => e.idx === 404);
    expect(entry, 'no journal entry for 0404').toBeTruthy();
    expect(entry!.tag).toBe('0404_leave_calendar_off_dashboard');
    expect(fs.existsSync(path.join(root, `db/migrations/${entry!.tag}.sql`))).toBe(true);
    // Strictly after its predecessor: an out-of-order `when` is silently skipped past the watermark.
    const prev = journal.entries.find((e) => e.idx === 403)!;
    expect(entry!.when).toBeGreaterThan(prev.when);
  });

  it('is a DATA migration on an already-granted table — no DDL, so no GRANT is owed', () => {
    const sqlText = read('db/migrations/0404_leave_calendar_off_dashboard.sql');
    expect(sqlText).toMatch(/DELETE FROM dashboard_card_config WHERE card_key = 'plannedAbsences'/);
    expect(sqlText).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
  });
});
