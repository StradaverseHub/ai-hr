/**
 * Item 4509d2b8 — Holidays moves from Attendance settings to System Settings.
 *
 * NAV PLACEMENT ONLY. No migration, no schema change, no service change, no new screen, no new string,
 * and no change of address: /admin/holidays is still /admin/holidays, so bookmarks keep working.
 *
 * WHY THE MOVE IS MORE THAN TIDYING. There has only ever been ONE holiday list, and core/holidays.ts is
 * SPINE, not the attendance pack: core/leave.ts, core/absence-days.ts, core/attendance.ts, core/payroll.ts
 * and core/leave-escalation.ts all read it through holidayDatesFor / effectiveHolidayState. The ticket's
 * "shared across both modules" requirements were therefore already satisfied — nothing here builds a
 * second store or any sync. What was genuinely broken was the MENU, and it had a real consequence:
 * MODULE_OF_HREF is built by flatMap over the attendance pack's nav children, `attendance` is billable
 * (isCore:false in packs/catalog.ts) and `leave` is core, so a Leave-only tenant lost the Holidays row
 * entirely while their leave calculations kept depending on holidays.
 *
 * The un-gating IS the deliverable, which is why the absence of /admin/holidays from MODULE_OF_HREF is
 * asserted here rather than left as a side effect nobody wrote down. Page ACCESS was never module-gated
 * (core/holidays.ts has no assertModuleEnabled and nav entitlement fails open — lib/nav-entitlements.ts),
 * so this widens visibility, not authority: the screen stays requireAdmin exactly as before.
 *
 * Source-text where the thing under test is a module-private const in a `'use client'` component
 * (components/sidebar.tsx), object-level where a pack descriptor is importable — the house split, using
 * test/helpers/sidebar-source.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countQuoted, nodeBlock } from './helpers/sidebar-source';
import { isHrefActive, isParentActive } from '../components/nav-flyout';
import { attendancePack } from '../packs/attendance';
import { MODULE_CATALOG } from '../packs/catalog';
import { SCREENS } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HREF = '/admin/holidays';
const SIDEBAR = read('components/sidebar.tsx');
const PACK = read('packs/attendance/index.ts');

/** Child hrefs of a module-private rail node, in declaration order. */
const childHrefs = (src: string, constName: string): string[] => {
  const block = nodeBlock(src, constName);
  if (block === null) return [];
  return [...block.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]!);
};

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

describe('4509d2b8 — the Holidays row moved to System Settings', () => {
  it('sits inside SYSTEM_SETTINGS_NODE, carrying its existing key and icon', () => {
    const node = nodeBlock(SIDEBAR, 'SYSTEM_SETTINGS_NODE');
    expect(node, 'SYSTEM_SETTINGS_NODE is declared in components/sidebar.tsx').not.toBeNull();
    const line = node!.split('\n').find((l) => l.includes(`'${HREF}'`));
    expect(line, `${HREF} is a child row of the System Settings node`).toBeDefined();
    expect(line, 'reuses nav.holidays — the move creates no new string').toContain(`labelKey: 'holidays'`);
    // CalendarDays is already imported by sidebar.tsx (REPORTS_NODE's Leave report uses it) and no OTHER
    // child of this node carries it, so the collapsed rail has no glyph collision. Pinned because the
    // fly-out and the collapsed rail render the glyph alone: two siblings sharing one are indistinguishable.
    expect(line, 'keeps the CalendarDays glyph it had under Attendance').toContain('icon: CalendarDays');
    const siblingIcons = node!
      .split('\n')
      .filter((l) => l.includes("href: '/") && !l.includes(`'${HREF}'`))
      .map((l) => /icon:\s*([A-Za-z0-9_]+)/.exec(l)?.[1])
      .filter(Boolean);
    expect(siblingIcons, 'no sibling in this node shares the glyph').not.toContain('CalendarDays');
  });

  it('has LEFT the attendance pack — not copied, and not left behind as a second row', () => {
    const attendanceNav = attendancePack.navNodes!.flatMap((n) => n.children).map((c) => c.href);
    const attendanceLinks = (attendancePack.navLinks ?? []).map((l) => l.href);
    expect(attendanceNav, 'no attendance nav node still carries it').not.toContain(HREF);
    expect(attendanceLinks, 'and it did not reappear as a flat attendance link').not.toContain(HREF);
    // The source half as well as the descriptor half: a commented-out row is still a row somebody will
    // uncomment, and the ATTENDANCE_NAV literal is what a future reader edits.
    const nav = nodeBlock(PACK, 'ATTENDANCE_NAV');
    expect(nav, 'ATTENDANCE_NAV is declared in packs/attendance/index.ts').not.toBeNull();
    expect(nav!.indexOf(`'${HREF}'`), 'ATTENDANCE_NAV no longer lists it').toBe(-1);
  });

  it('appears EXACTLY ONCE across the rail sources (moved, not duplicated)', () => {
    // The likeliest way to get this item wrong is to add the System Settings row without removing the
    // Attendance one: the rail would render Holidays twice AND the surviving attendance copy would put
    // it straight back into MODULE_OF_HREF, undoing the un-gating that is the whole point.
    expect(countQuoted(SIDEBAR + PACK, HREF), `${HREF} across sidebar.tsx + packs/attendance/index.ts`).toBe(1);
    expect(countQuoted(SIDEBAR, HREF), 'the one row lives in sidebar.tsx').toBe(1);
    expect(countQuoted(PACK, HREF), 'and none in the attendance pack').toBe(0);
  });
});

describe('4509d2b8 — a Leave-only tenant keeps the Holidays row', () => {
  it('the premise: attendance is billable, leave is core', () => {
    // Stated as data rather than prose, because the whole justification for the move rests on it. If
    // attendance ever became core this item would still be right (the screen is not attendance config),
    // but the *urgency* — a paying Leave customer with no route to the holiday calendar — would be gone.
    const mod = (code: string) => MODULE_CATALOG.find((m) => m.code === code)!;
    expect(mod('attendance').isCore, 'attendance is a sellable add-on').toBe(false);
    expect(mod('leave').isCore, 'leave is core — every tenant has it').toBe(true);
  });

  it('THE POINT OF THE ITEM: /admin/holidays is owned by NO sellable module', () => {
    // MODULE_OF_HREF (components/sidebar.tsx) has two halves and the row must be absent from BOTH.
    //
    // Derived half — `...ATTENDANCE_NODES.flatMap((n) => n.children.map((c) => [c.href, 'attendance']))`
    // and the equivalents for claims/payroll/performance. Covered by the pack assertion above; repeated
    // here over EVERY pack, because "moved to another pack's node" would gate it just as effectively.
    const packHrefs = [
      ...attendancePack.navNodes!.flatMap((n) => n.children.map((c) => c.href)),
      ...(attendancePack.navLinks ?? []).map((l) => l.href),
    ];
    expect(packHrefs).not.toContain(HREF);

    // Hand-written half — the map ends with literal `['/admin/system-explorer', 'system_explorer']`
    // entries for modules that have no pack. Adding one for Holidays would silently restore the gating
    // this item exists to remove, so the shape is refused outright.
    expect(SIDEBAR, 'no hand-written MODULE_OF_HREF entry for the Holidays row').not.toMatch(
      new RegExp(`\\[\\s*'${HREF}'\\s*,\\s*'[^']+'\\s*\\]`),
    );
  });
});

describe('4509d2b8 — access is UNCHANGED: administrators only, same guard, same routes', () => {
  /**
   * MOVED HERE from test/attendance-menu-relocation.test.ts, which no longer covers this screen because
   * the screen is no longer in the attendance menu. The case itself is unchanged and deliberately kept:
   * that file's whole premise — a screen is protected by its own guard and never by which menu happens to
   * hide its link — is exactly why a menu move must not cost the screen its guard coverage.
   */
  it('the page calls a server-side admin guard in its own body', () => {
    const src = read('app/admin/holidays/page.tsx');
    expect(src, '/admin/holidays must call requireAdmin() or scopedAdmin()').toMatch(
      /requireAdmin\(|scopedAdmin\(/,
    );
  });

  it('the lib/permissions.ts column is untouched — same href, same guard, same four routes', () => {
    // Rule 20 does NOT apply (no new page, no moved route), so this is a no-change assertion: the item is
    // wrong if the matrix moved with the menu. A guarded route missing from here becomes a screen nobody
    // can grant or revoke, and test/function-access.test.ts fails both ways.
    const screen = SCREENS.find((s) => s.screenKey === 'holidays');
    expect(screen, 'the holidays screen column still exists').toBeTruthy();
    expect(screen!.href).toBe(HREF);
    expect(screen!.labelKey).toBe('nav.holidays');
    expect(screen!.guard).toBe('requireAdmin');
    expect(screen!.routes).toEqual([
      '/admin/holidays',
      '/admin/holidays/groups',
      '/admin/holidays/groups/new',
      '/admin/holidays/groups/[id]',
    ]);
  });

  it('the URL is preserved — every registered route still resolves to a page on disk', () => {
    // The plan promised existing bookmarks and shortcuts keep working. Re-addressing the screen to
    // /admin/settings/holidays would have meant redirect stubs plus edits to app/admin/actions.ts,
    // components/holiday-tabs.tsx and components/holiday-group-form.tsx — cost with no user-visible
    // benefit, since the ticket asked for a navigation path, not an address.
    const screen = SCREENS.find((s) => s.screenKey === 'holidays')!;
    for (const route of screen.routes) {
      const file = path.join(ROOT, 'app', route, 'page.tsx');
      expect(fs.existsSync(file), `${route} has a page at app${route}/page.tsx`).toBe(true);
    }
    // …and the screen's own tab bar still points at the same two addresses.
    expect(read('components/holiday-tabs.tsx')).toContain(`href: '${HREF}'`);
  });
});

describe('4509d2b8 — no service moved with the row', () => {
  it('core/holidays.ts stays SPINE: read directly by leave, attendance and payroll alike', () => {
    // The fact that makes System Settings the right menu, and the thing a future "tidy-up" would break by
    // routing this through packs/attendance/service — which would be wrong twice over: holidays is not an
    // attendance service, and a spine module cannot depend on a pack it is read by.
    for (const consumer of [
      'core/leave.ts',
      'core/absence-days.ts',
      'core/attendance.ts',
      'core/payroll.ts',
      'core/leave-escalation.ts',
    ]) {
      expect(read(consumer), `${consumer} reads the one holiday list directly`).toMatch(
        /from '\.\/holidays'/,
      );
    }
    expect(read('core/holidays.ts'), 'and holidays imports no pack').not.toMatch(/from '(\.\.\/)?packs\//);
  });
});

describe('4509d2b8 — i18n: the label moved with the row, in all six locales', () => {
  const nav = Object.fromEntries(
    LOCALES.map((l) => [l, (JSON.parse(read(`messages/${l}.json`)) as { nav: Record<string, string> }).nav]),
  ) as Record<(typeof LOCALES)[number], Record<string, string>>;

  it('nav.holidays is present and non-empty everywhere', () => {
    // No new key: the row keeps the one it always had, which is why this item touches no catalog file.
    // Asserted anyway — a nav row whose key resolves to nothing renders MISSING_MESSAGE, and the six
    // locales are the one thing a source-shape test cannot infer from the row itself.
    for (const l of LOCALES) {
      expect(typeof nav[l].holidays, `${l}: nav.holidays present`).toBe('string');
      expect(nav[l].holidays.trim().length, `${l}: nav.holidays non-empty`).toBeGreaterThan(0);
    }
  });

  it('nav.holidays is actually translated in the five non-English locales', () => {
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      expect(nav[l].holidays, `${l}: nav.holidays differs from the en value`).not.toBe(nav.en.holidays);
    }
  });
});

describe('4509d2b8 — the highlighting moved with the row', () => {
  /**
   * The rest of this file proves the row is DECLARED in the right node. That is not the same thing as
   * proving the rail READS right, and the two predicates that decide it were only ever covered as
   * source-text presence checks (test/payroll-flyout-nav.test.ts:187-194, test/sidebar-flyout.test.ts:59)
   * — nothing drove either one over real hrefs. Moving the row silently moved BOTH:
   *
   *   - `isParentActive` gets each node's child hrefs, so ownership of /admin/holidays transferred from
   *     the Attendance settings parent to the System Settings parent. A copy left behind (the failure
   *     mode the "exactly once" case above guards) would light TWO parents at once.
   *   - the panel's longest-href-wins ranking now resolves /admin/holidays/groups inside a DIFFERENT
   *     node's child set, next to five /admin/settings/* siblings it never sat beside before.
   *
   * Both are pure functions of the pathname and the node's hrefs, so they are checkable here. The real
   * exports are imported rather than reimplemented; the ranking is inline in the `'use client'` sidebar,
   * so its expression is pinned against the source below so this copy cannot drift away from it.
   */
  const SYSTEM_CHILDREN = childHrefs(SIDEBAR, 'SYSTEM_SETTINGS_NODE');
  const ATTENDANCE_CHILDREN = childHrefs(PACK, 'ATTENDANCE_NAV');

  // components/sidebar.tsx `activeChildHref` — inside a panel the LONGEST matching path wins, so exactly
  // one row ever reads as the current page (1459e116 requirement 3).
  const activeChildHref = (hrefs: string[], pathname: string, search = '') =>
    hrefs
      .filter((h) => isHrefActive(pathname, search, h))
      .sort((a, b) => b.split('?')[0].length - a.split('?')[0].length)[0];

  it('reads the two nodes for real (guards the extraction itself)', () => {
    expect(SYSTEM_CHILDREN, 'System Settings children').toContain(HREF);
    expect(ATTENDANCE_CHILDREN.length, 'Attendance settings children').toBeGreaterThan(0);
    expect(ATTENDANCE_CHILDREN, 'Attendance settings no longer carries it').not.toContain(HREF);
    // The ranking above is a copy of an expression that lives inline in a 'use client' component. Pin it.
    expect(SIDEBAR, 'the panel still ranks by longest path').toMatch(
      /\.sort\(\(a, b\) => b\.href\.split\('\?'\)\[0\]\.length - a\.href\.split\('\?'\)\[0\]\.length\)/,
    );
  });

  it.each(['/admin/holidays', '/admin/holidays/groups'])(
    'on %s the System Settings parent lights and Attendance settings does not',
    (pathname) => {
      expect(isParentActive(pathname, SYSTEM_CHILDREN), 'System Settings parent').toBe(true);
      expect(isParentActive(pathname, ATTENDANCE_CHILDREN), 'Attendance settings parent').toBe(false);
    },
  );

  it.each(['/admin/holidays', '/admin/holidays/groups'])(
    'on %s exactly one System Settings row is current, and it is Holidays',
    (pathname) => {
      // The Holiday Group tab is the case worth stating: isHrefActive is a segment-prefix match, so the
      // /admin/holidays row deliberately stays lit on /admin/holidays/groups (there is no row of its own
      // for the tab). What must NOT happen is a second row lighting beside it.
      const lit = SYSTEM_CHILDREN.filter((h) => isHrefActive(pathname, '', h));
      expect(lit, `rows matching ${pathname}`).toEqual([HREF]);
      expect(activeChildHref(SYSTEM_CHILDREN, pathname)).toBe(HREF);
    },
  );

  it('the attendance screens still light their own parent and their own row', () => {
    // The other half of the move: taking a child out of a node must not disturb the six that remain.
    for (const href of ATTENDANCE_CHILDREN) {
      const pathname = href.split('?')[0];
      expect(isParentActive(pathname, ATTENDANCE_CHILDREN), `${pathname}: Attendance parent`).toBe(true);
      expect(isParentActive(pathname, SYSTEM_CHILDREN), `${pathname}: System Settings parent`).toBe(false);
      expect(activeChildHref(ATTENDANCE_CHILDREN, pathname), `${pathname}: current row`).toBe(href);
    }
  });
});
