/**
 * 7b5f18c3 — Hiring Defaults moves from Personnel (Admin) to System Settings, as a company list plus a
 * page per company.
 *
 * WHAT THIS FILE EXISTS TO STOP, in order of how expensive each has been:
 *
 *  1. HALF A RELOCATION. A nav row whose route is not in lib/permissions.ts is refused by our own access
 *     check and fails test/function-access.test.ts; a registered route with no nav row cannot be found by
 *     anyone. Both halves are asserted in ONE test (the test/leave-generate-page.test.ts idiom) so a later
 *     edit removing either is caught by the test that guards the other.
 *  2. A DEAD BOOKMARK. /admin/personnel/settings was the only address this screen ever had. It must keep
 *     resolving — as an unguarded redirect stub, which is also why it had to LEAVE lib/permissions.ts
 *     (function-access's "no stale routes" check fails on a registered route that is no longer a guarded
 *     page). Stub-and-deregister is one move, not two.
 *  3. A SCREEN IN TWO PLACES. The Personnel top-right button is gone; if it comes back the function is
 *     reachable from two places that will drift.
 *  4. RAW KEYS. The namespace was lifted from `people.hiringDefaults` to a top-level `hiringDefaults`, and
 *     `people.list.hiringDefaults` was deleted with the button. Every key the two pages actually call is
 *     listed here per locale, because a lift like that is exactly how a MISSING_MESSAGE ships green.
 *
 * NO MIGRATION AND NO SERVICE CHANGE. core/hiring-defaults.ts is untouched by this item: same two
 * per-company values, same reads and writes. The last test pins that the new screens go through the
 * service rather than growing their own database access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const INDEX_ROUTE = '/admin/settings/hiring-defaults';
const DETAIL_ROUTE = '/admin/settings/hiring-defaults/[companyId]';
const OLD_ROUTE = '/admin/personnel/settings';

const INDEX_PAGE = 'app/admin/settings/hiring-defaults/page.tsx';
const DETAIL_PAGE = 'app/admin/settings/hiring-defaults/[companyId]/page.tsx';
const ACTIONS = 'app/admin/settings/hiring-defaults/actions.ts';
const OLD_PAGE = 'app/admin/personnel/settings/page.tsx';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Record<string, any>;

describe('7b5f18c3 · Hiring Defaults lives in System Settings', () => {
  it('both routes exist on disk and are admin-guarded', () => {
    expect(exists(INDEX_PAGE), `${INDEX_PAGE} exists`).toBe(true);
    expect(exists(DETAIL_PAGE), `${DETAIL_PAGE} exists`).toBe(true);
    // scopedAdmin() is also what registers these routes with test/function-access.test.ts's GUARD_RE scan.
    expect(read(INDEX_PAGE)).toContain('scopedAdmin()');
    expect(read(DETAIL_PAGE)).toContain('scopedAdmin()');
  });

  it('THE TWO HALVES CANNOT DRIFT: the routes are in lib/permissions.ts AND the row is in SYSTEM_SETTINGS_NODE', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'hiringDefaults');
    expect(screen, 'a hiringDefaults screen column exists').toBeTruthy();
    expect(screen!.routes).toContain(INDEX_ROUTE);
    expect(screen!.routes).toContain(DETAIL_ROUTE);
    expect(screen!.href).toBe(INDEX_ROUTE);
    // The column must state the guard the pages actually call, or the access matrix misreports it.
    expect(screen!.guard).toBe('scopedAdmin');
    // Exactly one column owns each route — two would make the transparency grid ambiguous.
    for (const r of [INDEX_ROUTE, DETAIL_ROUTE]) {
      expect(SCREENS.filter((s) => s.routes.includes(r)), r).toHaveLength(1);
    }

    // …and the navigation half. Without it the screen is registered but unreachable.
    const sidebar = read('components/sidebar.tsx');
    const node = sidebar.slice(sidebar.indexOf('const SYSTEM_SETTINGS_NODE'));
    const end = node.indexOf('\n};');
    expect(end, 'SYSTEM_SETTINGS_NODE is terminated').toBeGreaterThan(-1);
    expect(node.slice(0, end), 'the Hiring Defaults row is a child of the System Settings node').toContain(
      `href: '${INDEX_ROUTE}'`,
    );
    expect(node.slice(0, end)).toContain("labelKey: 'hiringDefaults'");
  });

  it('the old address still resolves — a bare redirect stub, deregistered from the access matrix', () => {
    const stub = read(OLD_PAGE);
    // Assert the redirect CALL, not merely that the file mentions the address somewhere — the first
    // draft of this test passed while a deliberately broken stub pointed at /admin/personnel, because
    // the doc comment above it still named the right route.
    expect(stub, 'the stub forwards to the new index').toMatch(
      /redirect\(`\/admin\/settings\/hiring-defaults\$\{/,
    );
    // A stub is not a guarded screen: no guard call, no data read, therefore no matrix column. Leaving
    // the route registered would fail function-access's "no stale routes" check instead.
    expect(stub).not.toMatch(/requireAdmin|scopedAdmin|scopedSession/);
    expect(REGISTERED_ROUTES.has(OLD_ROUTE), `${OLD_ROUTE} is no longer a registered route`).toBe(false);
    // The action moved with the screen; leaving a second copy behind is how two save paths diverge.
    expect(exists('app/admin/personnel/settings/actions.ts')).toBe(false);
  });

  it('the Personnel screen no longer links it (one entry point, not two)', () => {
    expect(read('app/admin/personnel/page.tsx')).not.toContain(`href="${OLD_ROUTE}"`);
    // The whole app links the CANONICAL route now; the old one survives only as its own stub file.
    const linkers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && rel !== OLD_PAGE && read(rel).includes(`"${OLD_ROUTE}"`)) {
          linkers.push(rel);
        }
      }
    };
    for (const d of ['app', 'components']) walk(d);
    expect(linkers, `these still link the retired address:\n${linkers.join('\n')}`).toEqual([]);
  });

  it('every key the two pages call resolves in all six locales', () => {
    // The namespace was LIFTED (people.hiringDefaults → hiringDefaults). A lift that misses a locale
    // renders a raw key and passes tsc, the build and the route's 200.
    const used = [
      'title', 'description', 'catalogTitle', 'searchPlaceholder',
      'statusActive', 'statusInactive', 'statusAll',
      'colCompany', 'colCode', 'colProbation', 'colReminders', 'colStatus',
      'usingDefault', 'edit', 'empty', 'emptyScope', 'save', 'cancel',
      'probationMonths', 'probationMonthsHint', 'reviewReminderDays', 'reviewReminderDaysHint',
    ];
    for (const loc of LOCALES) {
      const m = msgs(loc);
      expect(typeof m.nav?.hiringDefaults, `${loc}: nav.hiringDefaults`).toBe('string');
      for (const k of used) {
        expect(typeof m.hiringDefaults?.[k], `${loc}: hiringDefaults.${k}`).toBe('string');
      }
      // The old homes are gone in every locale — a half-finished lift leaves both, and the next agent
      // cannot tell which one is live.
      expect(m.people?.hiringDefaults, `${loc}: people.hiringDefaults is retired`).toBeUndefined();
      expect(m.people?.list?.hiringDefaults, `${loc}: the Personnel button label is retired`).toBeUndefined();
    }
  });

  it('the five non-English locales are actually translated, not English pasted six times', () => {
    // test/i18n-coverage.test.ts only fails on MISSING keys, so copying en into all six ships five
    // locales in English with a fully green build — the likeliest failure mode of a new namespace.
    const en = msgs('en');
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const m = msgs(loc);
      expect(m.nav.hiringDefaults, `${loc}: nav.hiringDefaults differs from en`).not.toBe(en.nav.hiringDefaults);
      for (const k of ['title', 'catalogTitle', 'searchPlaceholder', 'usingDefault', 'empty']) {
        expect(m.hiringDefaults[k], `${loc}: hiringDefaults.${k} differs from en`).not.toBe(en.hiringDefaults[k]);
      }
    }
  });

  it('presentation only: the screens go through core/hiring-defaults, and no page touches the database', () => {
    expect(read(INDEX_PAGE)).toContain("from '@/core/hiring-defaults'");
    expect(read(DETAIL_PAGE)).toContain("from '@/core/hiring-defaults'");
    expect(read(ACTIONS)).toContain('setHiringDefaults');
    for (const f of [INDEX_PAGE, DETAIL_PAGE, ACTIONS]) {
      expect(read(f), `${f} must not reach past the service`).not.toContain("from '@/db/schema'");
      expect(read(f), `${f} must not open its own transaction`).not.toContain('withTenant');
    }
  });

  it('both screens are SERVER components using the shared System Settings list idiom', () => {
    for (const f of [INDEX_PAGE, DETAIL_PAGE]) {
      expect(read(f).includes("'use client'"), `${f} is a server component`).toBe(false);
    }
    // The list half is the thing 1b87e8a0 has to reuse — see test/settings-list-idiom.test.ts.
    expect(read(INDEX_PAGE)).toContain("from '@/components/settings-list'");
  });
});
