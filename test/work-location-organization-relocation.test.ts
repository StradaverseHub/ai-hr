/**
 * Item 639bf4a5 — the work-site register's HOME, its LISTING and its dedicated screens.
 *
 * ⚠️ THIS FILE WAS WRITTEN IN r336 TO PIN THE OPPOSITE OF WHAT IT NOW PINS, AND THAT IS DELIBERATE.
 * r336 moved the register out of Attendance to Administration › Organization, renamed it "Physical Work
 * Location", and this guard asserted the row was under Organization and NOT under Attendance. It
 * shipped. The reporter contested it and asked for the screen back under ATTENDANCE, renamed
 * **Locations**, with a company-based listing and dedicated Add / View / Edit screens. Under CLAUDE.md
 * §1 that is the owner's decision; under §8 a guard pinning a decision you are reversing is UPDATED with
 * the reason, never deleted. So this file keeps its name (every sibling guard cites it by that name) and
 * every assertion in it now reads the structure r338 built.
 *
 * ── WHAT MOVED, AND WHAT DELIBERATELY DID NOT ─────────────────────────────────────────────────────
 * MOVED: the NAV ROW only — out of components/sidebar.tsx, back into packs/attendance/index.ts's
 * settings node, under `labelKey: 'locations'`.
 * DID NOT MOVE:
 *   • the ROUTE. `/admin/work-locations` is unchanged. The reporter asked to rename the FUNCTION, not
 *     the address; a second move in two days would churn every bookmark again and need the three
 *     `/admin/locations` redirect stubs re-pointed for nothing. Asserted in both directions below.
 *   • `screenKey: 'locations'` — a permission identity stored role configs may name. r336 declined to
 *     rename it and so does r338; it is the one thing about this item that has never changed.
 *   • the i18n namespace `admin.locations`.
 *   • the DRIFT RATCHET. test/attendance-pack-drift.test.ts's allowlist is untouched: the ratchet is
 *     about IMPORTS, not menus, and app/admin/work-locations/** still consumes the clocking service
 *     through the published facade. Asserted below — a re-added entry fails that guard by design.
 *
 * ⚠️ AND THE ROW'S RETURN RE-GATES THE REGISTER, KNOWINGLY. MODULE_OF_HREF is built by flatMap over the
 * attendance pack's nav children and `attendance` is BILLABLE, so the register is entitlement-gated
 * again — the 4509d2b8 Holidays precedent in reverse. The tenant HAS attendance, so no live impact. The
 * plan offered to keep it un-gated and the reporter did not answer; their structure is built as they
 * described it. Asserted positively below so it cannot be read as an accident.
 *
 * ⚠️ THE ADR-0086 HOLIDAY CLAIM STAYS DEAD. r336 found the retired sentence still live in
 * `admin.locations.pageDescription` in all six locales a fortnight after the behaviour was removed,
 * because the old guard matched only `stateNote`'s exact words AND rendered under a `getTranslations`
 * mock that echoes key names. The replacement asserts the retired sentences are absent from EVERY string
 * in `admin.locations`, and it is carried through this rename unchanged.
 *
 * ⚠️ FILE-LEVEL MOCKS (the test/clocking-location-page.test.ts idiom): requireAdmin() returns the
 * module-level ADMIN; redirect() and notFound() throw; getTranslations echoes KEY NAMES, so server
 * strings in the markup below are KEYS where they mean sentences; next/headers gives the scope-cookie
 * reader an empty jar. Anything about the actual WORDS is asserted against the catalogues, never the
 * markup — which is the trap the pageDescription miss was made of.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';
import { isHrefActive, isNavRowActive } from '../components/nav-flyout';
import { attendancePack } from '../packs/attendance';
import { createClockingLocation } from '../core/clocking-location';
import { listCompanies } from '../core/read';
import { archiveLocation, createLocation, listLocations, listUnmappedBranches, resolveLocationForBranch } from '../core/location';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { workLocationsReturnTo } from '../lib/return-to';

let ADMIN: SessionContext;
vi.mock('../lib/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz')>()),
  requireAdmin: async () => ADMIN,
}));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
// r428 (83c0d3c8 contest) — the default export is the REDIRECT STUB now (`WorkLocationsRedirect`); the
// import name is kept because every reference below the "THE OLD ADDRESSES STILL RESOLVE" section is
// about exactly that — the stub's own behaviour, not a page that renders.
import WorkLocationsPage from '../app/admin/work-locations/page';
import ClockingListPage from '../app/admin/work-locations/clocking/page';
import NewLocationPage from '../app/admin/work-locations/new/page';
import ViewLocationPage from '../app/admin/work-locations/[id]/page';
import EditLocationPage from '../app/admin/work-locations/[id]/edit/page';
import LocationsRedirect from '../app/admin/locations/page';
import NewClockingLocationRedirect from '../app/admin/locations/clocking/new/page';
import EditClockingLocationRedirect from '../app/admin/locations/clocking/[id]/page';
import {
  createLocationAction,
  updateLocationAction,
  archiveLocationAction,
  restoreLocationAction,
} from '../app/admin/actions';
import { CLOCKING_LIST, CLOCKING_NEW_PAGE, LOCATIONS_LIST, clockingEditPage } from '../app/admin/work-locations/clocking/form-fields';
import { LOCATION_NEW_PAGE, locationEditPage, locationViewPage } from '../app/admin/work-locations/location-fields';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalog = (loc: string) =>
  JSON.parse(read(`messages/${loc}.json`)) as {
    nav: Record<string, string | undefined>;
    admin: { locations: Record<string, string | undefined> };
  };

const HREF = '/admin/work-locations';
const OLD_HREF = '/admin/locations';
const SIDEBAR = read('components/sidebar.tsx');
const PACK = read('packs/attendance/index.ts');
const LIST_SRC = read('app/admin/work-locations/page.tsx');
/** r428 — the company's "Work locations" section now lives on the clocking list's CompanyView half. */
const CLOCKING_SRC = read('app/admin/work-locations/clocking/page.tsx');
/** Count occurrences of the QUOTED href, so a prose mention in a comment is not a nav row. */
const countQuoted = (haystack: string, href: string) => haystack.split(`'${href}'`).length - 1;

// ───────────────────────── (a) RETIRED FROM THE RAIL, FOLDED INTO THE ROW ABOVE ─────────────────────────

/**
 * ⚠️ r428 (83c0d3c8 contest) — THIS SECTION ASSERTED "A ROW OF ITS OWN" UNTIL NOW, AND THE REVERSAL IS THE
 * REPORTER'S. They contested two things at once: the crowded first-page listing (sections (b)-(h) below,
 * now rewritten around the company-first screens), and "remove Work Locations, keep Locations as the one
 * menu for both kinds". So the row this section used to pin is GONE — not moved a third time, retired. The
 * exhaustive nav-row oracle (EXPECTED/ADDED_SINCE/RETIRED, the exact-set and highlighting guards) lives in
 * test/attendance-pack.test.ts and test/sidebar-attendance-group.test.ts; this section keeps only the
 * claims unique to THIS file's subject — the OLD address's own fate.
 */
describe('r428 (83c0d3c8 contest) (a) — Work Locations is gone from the rail; its old address is a guarded stub the Locations row owns', () => {
  it('no row anywhere names the retired function, under either address', () => {
    // `countQuoted` would also match the SAME quoted HREF inside `ownedSubpaths: […]` on the row above —
    // correct, since that is not a row of its own — so the row-specific shape `href: '…'` is counted.
    expect((SIDEBAR + PACK).split(`href: '${HREF}'`).length - 1, `${HREF} must have no menu row anywhere`).toBe(0);
    expect(countQuoted(SIDEBAR + PACK, OLD_HREF), `${OLD_HREF} must have no menu row anywhere`).toBe(0);
    expect(SIDEBAR, 'and not under the r336 label either').not.toContain("labelKey: 'physicalWorkLocation'");
    expect(PACK, 'nor the retired label key').not.toContain("labelKey: 'workLocations'");
    // The Organization row itself is untouched — a guard that only said "ours is gone" would pass on a
    // sidebar that had lost the neighbour too.
    expect(countQuoted(SIDEBAR, '/admin/organization'), 'Organization keeps its own row').toBe(1);
  });

  it('the Locations row owns the retired address for highlighting, and a bookmark through the stub still lights it', () => {
    const node = attendancePack.navNodes!.find((n) => n.labelKey === 'attendanceSettings')!;
    const row = node.children.find((c) => c.href === CLOCKING_LIST);
    expect(row, 'the Locations row is a child of the Attendance settings node').toBeTruthy();
    expect(row!.ownedSubpaths, 'and it owns the retired address').toEqual([HREF]);
    for (const sub of [HREF, `${HREF}/new`, `${HREF}/abc`, `${HREF}/abc/edit`]) {
      expect(isNavRowActive(sub, '', row!), `${sub} keeps "Locations" lit via ownedSubpaths`).toBe(true);
    }
    // …and the Organization row does not light for it — ownership is the Locations row's alone.
    expect(isNavRowActive(HREF, '', { href: '/admin/organization' }), 'Organization does not light').toBe(false);
  });

  it('the old address is a requireAdmin() redirect stub, guard first, landing on the Locations screen', () => {
    const stub = read('app/admin/work-locations/page.tsx');
    const guard = stub.indexOf('requireAdmin()');
    const fwd = stub.indexOf('redirect(');
    expect(guard, 'guards itself').toBeGreaterThan(-1);
    expect(fwd, 'and forwards').toBeGreaterThan(-1);
    expect(guard, 'guard BEFORE redirect — a non-administrator is refused, never told where it went').toBeLessThan(fwd);
    expect(stub, 'forwards to the clocking list, the screen "Locations" now opens').toContain('CLOCKING_LIST');
  });
});

// ─────────────────── THE PACK-OWNERSHIP HALF (ADR-0080) — THE RATCHET IS UNTOUCHED ───────────────────

describe('639bf4a5 — the menu moved, the import boundary did not', () => {
  it('the drift ratchet still authorises NEITHER address — a re-added entry fails by design', () => {
    const drift = read('test/attendance-pack-drift.test.ts');
    const always = drift.slice(drift.indexOf('const ALWAYS_ALLOWED'), drift.indexOf('describe('));
    expect(countQuoted(always, 'app/admin/locations/'), 'r336 removed the old surface claim').toBe(0);
    expect(
      countQuoted(always, 'app/admin/work-locations/'),
      'and r338 did NOT re-open it at the new address — the ratchet is about imports, not menus',
    ).toBe(0);
  });

  it('every screen in the tree reads clocking through the pack facade, never the implementation', () => {
    for (const rel of [
      'app/admin/work-locations/clocking/page.tsx',
      'app/admin/work-locations/clocking/[id]/page.tsx',
      'app/admin/work-locations/clocking/[id]/edit/page.tsx',
    ]) {
      const src = read(rel);
      expect(src, `${rel} imports the facade`).toContain("from '@/packs/attendance/service'");
      expect(src, `${rel} must not import the pack's implementation directly`).not.toMatch(
        /from '@\/core\/clocking-location'/,
      );
    }
    // r423 — the WORK location screens read no clocking at all any more (they show none).
    for (const rel of ['app/admin/work-locations/page.tsx', 'app/admin/work-locations/[id]/page.tsx', 'app/admin/work-locations/[id]/edit/page.tsx']) {
      const src = read(rel);
      expect(src, `${rel} reads no clocking`).not.toContain('listClockingLocations');
      expect(src).not.toMatch(/from '@\/core\/clocking-location'/);
    }
    // …and the org spine is STILL imported directly, because that half is kernel and always was.
    expect(LIST_SRC).toContain("from '@/core/location'");
  });

  it('the old tree holds nothing but guarded redirect stubs', () => {
    const dir = path.join(ROOT, 'app/admin/locations');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    };
    walk(dir);
    expect(files.sort(), 'only the three stubs and their shared forwarder are left').toEqual([
      'app/admin/locations/clocking/[id]/page.tsx',
      'app/admin/locations/clocking/new/page.tsx',
      'app/admin/locations/page.tsx',
      'app/admin/locations/redirect-stub.ts',
    ]);
    for (const rel of files) {
      expect(read(rel), `${rel} imports nothing from the attendance pack`).not.toMatch(
        /from '(@\/|\.\.?\/)*(packs\/attendance|core\/clocking-location|core\/attendance)/,
      );
    }
  });
});

// ─────────────────────── (e) THREE DEDICATED SCREENS, AND NO FORM ON THE LISTING ───────────────────────

describe('639bf4a5 (e) — Add, View and Edit each have a route of their own, all on the unchanged screen key', () => {
  it('the screen column keeps its key and guard, its href follows "Locations" (r423), and it holds every route', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'locations');
    expect(screen, 'the screen column survives BOTH moves — the screenKey is a permission identity').toBeTruthy();
    // r423 — the column's href is the clocking list now ("Locations"); the work location listing is a
    // second menu row on the SAME column, so no stored grant changes meaning.
    expect(screen!.href).toBe(CLOCKING_LIST);
    expect(screen!.labelKey, 'only the label follows the menu').toBe('nav.locations');
    expect(screen!.guard, 'the guard is unchanged: administrators only').toBe('requireAdmin');
    expect(screen!.routes).toEqual([
      '/admin/work-locations',
      '/admin/work-locations/new',
      '/admin/work-locations/[id]',
      '/admin/work-locations/[id]/edit',
      '/admin/work-locations/clocking',
      '/admin/work-locations/clocking/new',
      '/admin/work-locations/clocking/[id]',
      '/admin/work-locations/clocking/[id]/edit',
      '/admin/locations',
      '/admin/locations/clocking/new',
      '/admin/locations/clocking/[id]',
    ]);
    for (const route of screen!.routes) {
      expect(REGISTERED_ROUTES.has(route), `${route} registered`).toBe(true);
      expect(
        fs.existsSync(path.join(ROOT, 'app', route, 'page.tsx')),
        `${route} has a page at app${route}/page.tsx — a registered route with no page is a screen nobody can grant`,
      ).toBe(true);
      expect(read(path.join('app', route, 'page.tsx')), `${route} guards itself`).toMatch(/requireAdmin\(/);
    }
  });

  it('the company view renders NO location form, and links out to the three screens instead', () => {
    // ⚠️ THE ABSENCE IS THE REQUIREMENT, in the reporter's own words: "No form inline above or below the
    // listing." Asserted on the SOURCE as well as on the markup below, because a form that only renders
    // for one role would be absent from a single render and present in the product.
    //
    // r428 (83c0d3c8 contest) — the OLD address (LIST_SRC) is a redirect stub now and trivially posts
    // nothing; the company listing itself is the "Work locations" section of CLOCKING_SRC's CompanyView.
    expect(LIST_SRC, 'the old address is a stub, nothing to post there at all').not.toContain('<form');
    expect(CLOCKING_SRC, 'the company view posts nothing for a location either').not.toMatch(
      /action=\{(create|update|archive|restore)LocationAction\}/,
    );
    expect(CLOCKING_SRC, 'Add opens its own screen').toContain('LOCATION_NEW_PAGE');
    expect(CLOCKING_SRC, 'View opens its own screen').toContain('locationViewPage(l.id)');
    expect(CLOCKING_SRC, 'Edit opens its own screen').toContain('locationEditPage(l.id)');
  });
});

// ─────────────────────────────── (b)(c)(d)(f)(h) — AGAINST A REAL DATABASE ───────────────────────────────

function toMarkup(tree: unknown): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      timeZone: 'Asia/Kuala_Lumpur',
      messages: JSON.parse(read('messages/en.json')),
      children: tree as never,
    }),
  );
}
/** Strip <script> before counting — a key in the RSC payload is not a screen (CLAUDE.md §8). */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');
/**
 * r428 (83c0d3c8 contest) — THE LISTING MOVED. `WorkLocationsPage` (the old `../page.tsx`) is a redirect
 * stub now and THROWS on render; the company-based work-location listing this file is about is the "Work
 * locations" SECTION of `ClockingListPage`'s step 2, reached with `?company=<id>`. Omitting `company`
 * renders step 1 (the company list) instead — used deliberately by a few cases below, never by accident.
 */
const renderList = async (sp: Record<string, string> = {}) => visible(toMarkup(await ClockingListPage({ searchParams: Promise.resolve(sp) })));
const renderCompany = async (companyId: string, sp: Record<string, string> = {}) => renderList({ company: companyId, ...sp });
const renderNew = async (sp: Record<string, string> = {}) =>
  visible(toMarkup(await NewLocationPage({ searchParams: Promise.resolve(sp) })));
const renderView = async (id: string, sp: Record<string, string> = {}) =>
  visible(toMarkup(await ViewLocationPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) })));
const renderEdit = async (id: string, sp: Record<string, string> = {}) =>
  visible(toMarkup(await EditLocationPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) })));

/** renderToStaticMarkup escapes `&` inside an attribute value as `&amp;`. */
const esc = (s: string) => s.replace(/&/g, '&amp;');

/**
 * Only the WORK LOCATIONS table body: a company's own view has the clocking table's `<tbody>` FIRST (its
 * own SectionCard, index 1) and the work-locations one SECOND (index 2) — `lastIndexOf` reaches past both,
 * never the clocking rows, and a company name printed in the unmapped-branch card below is past both too.
 */
const tbody = (html: string) => {
  const open = html.lastIndexOf('<tbody');
  return html.slice(open, html.indexOf('</tbody>', open));
};
const count = (html: string, needle: string) => html.split(needle).length - 1;

/** Run a server action to its redirect and return where it sent the browser. */
async function runAction(action: (fd: FormData) => Promise<void>, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  LAST_REDIRECT = '';
  await expect(action(fd)).rejects.toThrow('NEXT_REDIRECT');
  return LAST_REDIRECT;
}

let b: Base;
/** A GROUP administrator (hr_admin with company_id NULL), so isGroupAdmin() and RLS agree. */
async function adminFor(companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}
/** A second (and third) company in the same tenant — the listing's whole subject is that they all show. */
async function addCompany(legalName: string): Promise<string> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName })
    .returning({ id: schema.company.id });
  return c.id;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = await adminFor(null);
});

/**
 * r428 (83c0d3c8 contest) REWORKS THIS SECTION'S WHOLE SUBJECT. "Every company appears, whether or not it
 * has a location" was a property of a TENANT-WIDE listing; there is no longer one. The reporter's actual
 * point — a company with nothing is never silently absent, and stays one click from getting its first
 * location — now has two halves, each tested where it lives: STEP 1 (the company list) says "None yet"
 * for an empty company rather than omitting it, and STEP 2 (that company's own view) offers Add Work
 * Location regardless of whether it already has one. STATUS IS NO LONGER DERIVED EITHER: a company-level
 * "Active/Inactive" word made sense when one row spoke for a whole company; inside one company's own view
 * every location has its OWN real status column (`colStatus`), which is why `statusLegend` retired with
 * the company-level reading of the word.
 */
describe('r428 (83c0d3c8 contest) (b) — STEP 1 never omits an empty company; STEP 2 always offers Add', () => {
  it('STEP 1 lists all three companies, "None yet" for the two without a location, matching listCompanies', async () => {
    const second = await addCompany('Beta Sdn Bhd');
    await addCompany('Gamma Sdn Bhd');
    await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });

    const companies = await listCompanies(ADMIN, { adminOnly: true });
    expect(companies.map((c) => c.name).sort(), 'the fixture really has three').toEqual([
      'Acme Sdn Bhd',
      'Beta Sdn Bhd',
      'Gamma Sdn Bhd',
    ]);

    const html = await renderList();
    for (const c of companies) {
      expect(count(html, c.name), `${c.name} is a row, exactly once`).toBe(1);
    }
    // The two with nothing say so, and still carry a View Locations link to get their first one.
    expect(count(html, 'noneYet'), 'two companies have no work location yet').toBeGreaterThanOrEqual(2);
    expect(html).toContain(`href="${CLOCKING_LIST}?company=${second}"`);
  });

  it('STEP 2 of an EMPTY company offers Add Work Location, and says so once one exists', async () => {
    // `withFrom` always carries this view's own `?company=` back through `&from=` — the href is a
    // PREFIX check, never an exact closing quote, for that reason throughout this file now.
    const html = await renderCompany(b.companyId);
    expect(html, 'no work locations yet').toContain('noWorkLocationsYet');
    expect(html).toContain(esc(`href="${LOCATION_NEW_PAGE}?companyId=${b.companyId}&from=`));

    await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const after = await renderCompany(b.companyId);
    expect(after, 'the empty-state is gone once one exists').not.toContain('noWorkLocationsYet');
    expect(after).toContain('Headquarters');
    expect(after, 'Add is still offered — a company with one location must be able to gain a second').toContain(
      esc(`href="${LOCATION_NEW_PAGE}?companyId=${b.companyId}&from=`),
    );
  });

  it('STATUS IS A REAL PER-ROW COLUMN NOW, not a derived company-level word', async () => {
    // `location` has no active/inactive column — the screens have archive / restore. The row reads its
    // OWN archive stamp, not a word inferred across every location the company holds.
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    expect(tbody(await renderCompany(b.companyId)), 'live location ⇒ Active').toContain('statusActive');

    await archiveLocation(ADMIN, { locationId: loc });
    const rows = tbody(await renderCompany(b.companyId));
    expect(rows, 'archived ⇒ Archived, on its own row').toContain('statusArchived');
    expect(rows, 'and NOT Active').not.toContain('statusActive');
    // …and the location itself is still listed: archiving hides nothing.
    expect(rows, 'the archived location still renders — its history stays reachable').toContain('Headquarters');
    // The derived company-level word is retired WITH the tenant-wide listing it described.
    const legend = catalog('en').admin.locations.statusLegend!;
    expect(legend, 'retired, not merely unrendered').toMatch(/^\[retired r428 — /);
  });
});

/**
 * r428 (83c0d3c8 contest) — NO MORE rowSpan. One company is in view now, so the company cell this section
 * used to pin no longer exists at all; what survives is the reporter's real point, restated for a single
 * company's table: every location gets its own line, nothing is summarised as "+1 more", and each line
 * carries its own View/Edit.
 */
describe('r428 (83c0d3c8 contest) (c) — a company with TWO locations: both render as plain rows, View/Edit on each', () => {
  it('two addressable rows, no rowSpan, no "+1 more", Add offered once at the section level', async () => {
    const { id: hq } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id: yard } = await createLocation(ADMIN, { companyId: b.companyId, code: 'YARD', name: 'North Yard' });

    const rows = tbody(await renderCompany(b.companyId));
    expect(rows, 'the first location is a line').toContain('Headquarters');
    expect(rows, 'and so is the second — not a count, not a "+1 more"').toContain('North Yard');
    expect(rows).not.toMatch(/\+\s*\d+\s*more/i);
    expect(rows, 'no rowSpan — nothing is grouped by company any more').not.toContain('rowSpan');
    // ⚠️ THE CLOSING QUOTE IS LOAD-BEARING: locationEditPage(id) is locationViewPage(id) + '/edit', so a
    // prefix match would count the Edit link as a second View and pass on a row that had lost one. Each
    // link carries `?from=` (withFrom — neither bare path has a query of its own), right after the id.
    for (const id of [hq, yard]) {
      expect(count(rows, `href="${locationViewPage(id)}?from=`), `View for ${id}`).toBe(1);
      expect(count(rows, `href="${locationEditPage(id)}?from=`), `Edit for ${id}`).toBe(1);
    }
    expect(count(rows, `id="row-${hq}"`) + count(rows, `id="row-${yard}"`), 'two addressable rows').toBe(2);
    // Add is ONE button for the section now (SectionCard's aside), not a per-row link.
    const full = await renderCompany(b.companyId);
    expect(count(full, esc(`href="${LOCATION_NEW_PAGE}?companyId=${b.companyId}&from=`)), 'one Add for the company').toBe(1);
  });
});

describe('639bf4a5 (d) — the listing is scoped by adminOnly, not by the company switcher', () => {
  it('a company-scoped admin sees THEIR company on step 1, and a foreign ?company= falls back to it rather than disclosing the sister company', async () => {
    /**
     * app/admin/organization/page.tsx: *the filter IS the permission boundary*. Feedback ab77dc1f is the
     * incident — a tenant-wide list disclosed how many companies the organisation has to someone whose
     * access did not otherwise reveal it. r428 — a company-scoped admin's STEP 1 lists only companies they
     * administer (unchanged), and `?company=<foreign id>` is a comparison against that same set: it never
     * reaches the company's locations at all, so there is nothing for it to disclose.
     */
    const other = await addCompany('Sister Sdn Bhd');
    await createLocation(ADMIN, { companyId: other, code: 'SIS', name: 'Sister Site' });

    const group = await renderList();
    expect(group, 'a GROUP admin sees both on step 1').toContain('Sister Sdn Bhd');
    expect(group).toContain('Acme Sdn Bhd');

    ADMIN = await adminFor(b.companyId);
    expect((await listCompanies(ADMIN, { adminOnly: true })).map((c) => c.name)).toEqual(['Acme Sdn Bhd']);
    const scoped = await renderList();
    expect(scoped, 'their own company is listed').toContain('Acme Sdn Bhd');
    expect(scoped, 'the sister company is NOT — neither its name…').not.toContain('Sister Sdn Bhd');

    // r428 — requesting the sister company DIRECTLY falls back to step 1, never a query for its rows.
    const foreign = await renderCompany(other);
    expect(foreign, 'falls back to the company list').toContain('companiesSection');
    expect(foreign, '…its site is never reached').not.toContain('Sister Site');

    // …and the dedicated screens draw the same boundary rather than trusting the link that reached them.
    const sisterLoc = (await listLocations(await adminFor(null), [other], {}))[0];
    await expect(renderView(sisterLoc.id), 'View refuses an out-of-scope location').rejects.toThrow('NEXT_NOT_FOUND');
    await expect(renderEdit(sisterLoc.id), 'Edit refuses it too').rejects.toThrow('NEXT_NOT_FOUND');
    await expect(
      renderNew({ companyId: other }),
      'and Add refuses a companyId this admin does not administer',
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('the listing reads listCompanies with adminOnly and does NOT narrow by the company switcher', () => {
    expect(CLOCKING_SRC).toContain('await listCompanies(s, { adminOnly: true })');
    // 0f1802bf — a master-data screen ignores the switcher, exactly as the Organization listing does.
    // Without this the count on the page would be a cookie's opinion rather than the permission boundary.
    // CODE ONLY — the file header explains WHY the switcher is not consulted and names it to do so.
    const code = CLOCKING_SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(code, 'the switcher is not consulted').not.toContain('getScopeIds');
  });
});

describe('639bf4a5 (f) — Save, Cancel and Back all land on the listing, query preserved', () => {
  // r428 — the realistic shape `withFrom` produces today: the company's own view, not the bare retired
  // address. `workLocationsReturnTo`'s whitelist is a PREFIX check on `/admin/work-locations`, so the
  // bare address still passes it too — exercised separately below ("a FORGED returnTo"). A function, not
  // a constant: `b` (the fixture company) is not assigned until `beforeEach`, after this module evaluates.
  const FROM = () => `${CLOCKING_LIST}?company=${b.companyId}&saved=1&focus=11111111-1111-4111-8111-111111111111`;

  it('Back and Cancel on the Add screen carry the listing’s own query', async () => {
    const html = await renderNew({ companyId: b.companyId, from: FROM() });
    expect(count(html, `href="${esc(FROM())}"`), 'Back and Cancel, both of them').toBe(2);
    expect(html, 'and the form posts the same destination back for the Save').toContain(
      `name="returnTo" value="${esc(FROM())}"`,
    );
  });

  it('Back and Cancel on the View and Edit screens carry it too', async () => {
    const { id } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const view = await renderView(id, { from: FROM() });
    expect(view, 'View’s Back').toContain(`href="${esc(FROM())}"`);
    const edit = await renderEdit(id, { from: FROM() });
    expect(count(edit, `href="${esc(FROM())}"`), 'Edit’s Back and Cancel').toBe(2);
    expect(edit).toContain(`name="returnTo" value="${esc(FROM())}"`);
  });

  it('a SAVE lands on the COMPANY’S OWN VIEW at the row it just wrote, keeping what the operator was filtered on', async () => {
    const created = await runAction(createLocationAction, {
      companyId: b.companyId,
      code: 'HQ',
      name: 'Headquarters',
      country: 'MY',
      branch: '',
      returnTo: FROM(),
    });
    const [row] = await listLocations(ADMIN, [b.companyId], {});
    // The stale `focus` of the page they came from is REPLACED, not appended — a save that carried the
    // previous row along would highlight a row nobody just touched. `company=` survives: it is part of
    // the PATH's own query, never touched by the saved/focus replacement.
    expect(created).toBe(`${CLOCKING_LIST}?company=${b.companyId}&saved=1&focus=${row.id}#row-${row.id}`);

    const edited = await runAction(updateLocationAction, {
      locationId: row.id,
      code: 'HQ',
      name: 'Head Office',
      country: 'MY',
      branch: '',
      returnTo: `${CLOCKING_LIST}?company=${b.companyId}&saved=1&focus=${row.id}`,
    });
    expect(edited).toBe(`${CLOCKING_LIST}?company=${b.companyId}&saved=1&focus=${row.id}#row-${row.id}`);
    // …and the company view really does highlight exactly that row when it lands.
    const html = await renderCompany(b.companyId, { saved: '1', focus: row.id });
    expect(html).toContain(`id="row-${row.id}"`);
    // StackedHead's OWN header styling also carries `bg-muted/50` (the tinted Classic header row), so the
    // needle for a highlighted ROW is the one only StackedRow's conditional class produces.
    expect(count(html, '@max-3xl:py-4 bg-muted/50'), 'exactly one row highlighted').toBe(1);
    expect(html, 'and says so').toContain('locationSaved');
  });

  it('a FORGED returnTo can send the browser nowhere but the listing', async () => {
    // The value arrives in a FormData and on the address bar; it is whitelisted BY SHAPE, never echoed.
    for (const hostile of [
      'https://evil.example/steal',
      '//evil.example/admin/work-locations',
      '/admin/work-locationsevil.example',
      '/admin/users',
      '',
    ]) {
      expect(workLocationsReturnTo(hostile), `${JSON.stringify(hostile)} falls back`).toBe(LOCATIONS_LIST);
      const back = await runAction(archiveLocationAction, { locationId: randomUUID(), returnTo: hostile });
      expect(back.startsWith(LOCATIONS_LIST), `${JSON.stringify(hostile)} landed on ${back}`).toBe(true);
    }
    // A legitimate path under the listing survives intact, minus the reason keys the caller re-appends.
    expect(workLocationsReturnTo(`${LOCATIONS_LIST}?saved=1&focus=abc&error=boom`)).toBe(
      `${LOCATIONS_LIST}?saved=1&focus=abc`,
    );
  });

  it('a REFUSED save stays on the screen the form was on, with the reason and everything typed', async () => {
    await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const back = await runAction(createLocationAction, {
      companyId: b.companyId,
      code: 'HQ', // duplicate — core/location.ts refuses it
      name: 'Second Headquarters',
      country: 'MY',
      branch: '',
      returnTo: LOCATIONS_LIST,
    });
    expect(back.startsWith(`${LOCATION_NEW_PAGE}?companyId=${b.companyId}&`), `refusal landed on ${back}`).toBe(true);
    const params = new URLSearchParams(back.split('?')[1]);
    expect(params.get('error'), 'the reason is a sentence, not drizzle SQL').toContain('codeTaken');
    expect(params.get('typedCode')).toBe('HQ');
    expect(params.get('typedName')).toBe('Second Headquarters');
    expect(back).not.toContain('saved=1');
    // …and the page re-renders what was TYPED rather than a blank form.
    const html = await renderNew(Object.fromEntries(params.entries()) as Record<string, string>);
    expect(html).toContain('value="Second Headquarters"');
    expect(html).toContain('value="HQ"');
  });
});

describe('639bf4a5 (h) — create, edit, archive and restore still work, from the dedicated screens', () => {
  it('all four actions still write, and every one of them lands back inside the Locations screens', () => {
    // The trap: app/admin/actions.ts builds its redirects from one `LOCATIONS` constant, and a move that
    // repointed the pages but not the constant would leave every save bouncing to a redirect stub.
    expect(read('app/admin/actions.ts'), 'the actions read the address from the shared contract').toContain(
      'const LOCATIONS = LOCATIONS_LIST;',
    );
  });

  it('create → edit → archive → restore, each verified in the database and on the rendered screens', async () => {
    const created = await runAction(createLocationAction, {
      companyId: b.companyId,
      code: 'HQ',
      name: 'Headquarters',
      country: 'MY',
      branch: '',
      returnTo: LOCATIONS_LIST,
    });
    expect(created.startsWith(LOCATIONS_LIST), `create landed on ${created}`).toBe(true);
    expect(created, 'a successful create carries no error').not.toContain('error=');
    let rows = await listLocations(ADMIN, [b.companyId], { includeArchived: true });
    expect(rows.map((l) => l.code), 'the site was written').toEqual(['HQ']);
    const locId = rows[0].id;

    // …and it is on the company's own view, and on its own two screens.
    expect(tbody(await renderCompany(b.companyId)), 'the site renders on the company view').toContain('Headquarters');
    expect(await renderView(locId), 'and on its View screen').toContain('Headquarters');
    expect(await renderEdit(locId)).toContain(`name="locationId" value="${locId}"`);

    const edited = await runAction(updateLocationAction, {
      locationId: locId,
      code: 'HQ',
      name: 'Head Office',
      country: 'MY',
      branch: '',
      returnTo: LOCATIONS_LIST,
    });
    expect(edited.startsWith(LOCATIONS_LIST), `edit landed on ${edited}`).toBe(true);
    rows = await listLocations(ADMIN, [b.companyId], { includeArchived: true });
    expect(rows[0].name, 'the edit was written').toBe('Head Office');

    const archived = await runAction(archiveLocationAction, { locationId: locId, returnTo: LOCATIONS_LIST });
    expect(archived.startsWith(LOCATIONS_LIST), `archive landed on ${archived}`).toBe(true);
    let [db] = await owner.db.select().from(schema.location).where(eq(schema.location.id, locId));
    expect(db.archivedAt, 'archived').not.toBeNull();
    // Restore is offered where the archive was pressed — the Edit screen, since the listing has no form.
    expect(await renderEdit(locId), 'Restore replaces Archive on the archived record').toContain('>restore<');

    const restored = await runAction(restoreLocationAction, { locationId: locId, returnTo: LOCATIONS_LIST });
    expect(restored.startsWith(LOCATIONS_LIST), `restore landed on ${restored}`).toBe(true);
    [db] = await owner.db.select().from(schema.location).where(eq(schema.location.id, locId));
    expect(db.archivedAt, 'restored').toBeNull();
    expect(await renderEdit(locId), 'and Archive is back').toContain('>archive<');
  });

  it('branch mapping still proposes, and the listing still reports what is unmapped', async () => {
    /**
     * Seeded through the harness's own admin context rather than the page's: `setEmploymentInfo` gates on
     * `ctx.roles`, which the group-administrator fixture deliberately does not carry (it carries
     * `grants`, which is what isGroupAdmin and RLS read).
     */
    const ctx = adminCtx(b);
    const r = await hireEmployee(ctx, {
      person: { fullName: 'B BUKIT JALIL', primaryEmail: `b_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setEmploymentInfo(ctx, { employmentId: r.employmentId, orgBranch: 'BUKIT JALIL' });

    // BEFORE: nothing claims the branch, so it is reported and nothing can be proposed.
    expect(await listUnmappedBranches(ADMIN, [b.companyId])).toEqual([
      { companyId: b.companyId, branch: 'BUKIT JALIL', headcount: 1 },
    ]);
    expect(await resolveLocationForBranch(ADMIN, b.companyId, 'BUKIT JALIL')).toBeNull();
    expect(await renderCompany(b.companyId), 'the company view says so, beneath the table').toContain('unmappedBranchesHeading');

    // AFTER: the Add screen's form maps a location to it.
    const back = await runAction(createLocationAction, {
      companyId: b.companyId,
      code: 'BJ',
      name: 'Bukit Jalil',
      country: 'MY',
      branch: 'BUKIT JALIL',
      returnTo: LOCATIONS_LIST,
    });
    expect(back.startsWith(LOCATIONS_LIST)).toBe(true);
    const proposed = await resolveLocationForBranch(ADMIN, b.companyId, 'BUKIT JALIL');
    expect(proposed, 'the Personnel Attendance tab can propose a work location again').toBeTruthy();
    expect(proposed!.code).toBe('BJ');
    expect(await listUnmappedBranches(ADMIN, [b.companyId]), 'and the gap is closed').toEqual([]);
    // BOTH DIRECTIONS on the screen: the heading was there, and now it is not — without this the
    // assertion above would pass on a page that simply never renders the block.
    expect(await renderCompany(b.companyId), 'the heading is gone once the branch is mapped').not.toContain('unmappedBranchesHeading');
  });

  /**
   * r423 (83c0d3c8) REVERSES r338's "a location's clocking points move with it onto its own screens". The
   * reporter asked for clocking locations to be set up location-first and opened to companies, so every
   * one is on Attendance › Locations and NONE renders under a work location — linked or not.
   *
   * r428 (83c0d3c8 contest) — "on the listing" now means the DEDICATED work-location screens (View/Edit,
   * checked below) AND the company view's own WORK LOCATIONS SECTION specifically — never its Clocking
   * locations section, which legitimately shows every clocking location open to the company, linked or
   * not. Checking the whole company-view page would be vacuous (the clocking section is SUPPOSED to show
   * "North Gate"); the work-locations section is sliced out first, the same way the column-order case
   * above does, so the absence being asserted is the one this item actually won.
   */
  it('no clocking location renders on a work location’s screens, or in the company view’s WORK LOCATIONS section, linked or not', async () => {
    const { id: hq } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id: gate } = await createClockingLocation(ADMIN, { name: 'North Gate', lat: 3.139, lng: 101.6869, radiusM: 200, locationId: hq, companyIds: [b.companyId] });
    const { id: floating } = await createClockingLocation(ADMIN, { name: 'Floating Point', lat: 3.15, lng: 101.69, radiusM: 200, companyIds: [b.companyId] });
    const companyView = await renderCompany(b.companyId);
    const workSection = companyView.slice(companyView.indexOf("title={t('workLocationsSection')}"));
    for (const html of [await renderView(hq), await renderEdit(hq), workSection]) {
      expect(html).not.toContain(`id="row-${gate}"`);
      expect(html).not.toContain(`id="row-${floating}"`);
      expect(html).not.toContain('North Gate');
      expect(html).not.toContain(clockingEditPage(gate));
      expect(html, 'no "add a clocking point" under a work location').not.toContain(`${CLOCKING_NEW_PAGE}?addPoint=`);
      expect(html).not.toContain('offRegisterLink');
    }
    // …and the Clocking locations section of the SAME page legitimately DOES show both — the property
    // this case must not accidentally also be asserting the absence of.
    expect(companyView, 'the clocking section shows the linked one').toContain(`id="row-${gate}"`);
    expect(companyView, 'and the unlinked one').toContain(`id="row-${floating}"`);
    // r428 — the standalone "Work Locations" H1 is retired with the page; the company view's work-
    // location section carries the new section heading instead.
    expect(companyView, 'the company view has its own Work locations section').toContain('workLocationsSection');
  });

  it('[id] is shape-checked before any query — junk never reaches a uuid column', async () => {
    for (const junk of ['not-a-uuid', "'; drop table location; --", '../../../admin/users']) {
      await expect(renderView(junk), `${junk} never reaches SQL on View`).rejects.toThrow('NEXT_NOT_FOUND');
      await expect(renderEdit(junk), `${junk} never reaches SQL on Edit`).rejects.toThrow('NEXT_NOT_FOUND');
    }
    await expect(renderView('00000000-0000-4000-8000-000000000000')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

// ─────────────────────────────── (g) NO STATE FIELD, IN ANY LOCALE ───────────────────────────────

/**
 * ADR-0086 (item 0fe1ca2e, r332) — THE SCREENS MUST NOT REGROW A HOLIDAY STATE, AND MUST NOT DESCRIBE ONE.
 *
 * `location.state` was the TOP rung of the public-holiday precedence (location.state → holiday group →
 * employment.work_state → company.default_work_state → national). r332 removed the location join from both
 * readers in core/holidays.ts; public holidays come from the EMPLOYEE'S OWN WORK STATE now. A control whose
 * stored value changes nothing is worse than a dead column — an operator would set a State expecting
 * holidays to follow — and a SENTENCE that promises it is worse still.
 *
 * ⚠️ THE GUARD MOVED WITH THE FORM, WHICH IS THE WHOLE POINT OF IT. The controls were on the register's
 * inline strips when r336 wrote this; they are on app/admin/work-locations/location-form.tsx now. A guard
 * left reading the register would be green on a screen that had regrown the control.
 *
 * The retired sentences are quoted in full so a future round cannot restore one by copy-paste. The column
 * itself STAYS (db/schema.ts records why); it simply stops being editable and stops being advertised.
 */
describe('639bf4a5 (g) — ADR-0086: no State control, and no holiday claim in any of the six locales', () => {
  /** What `admin.locations.pageDescription` said until r336 — r332 deleted `stateNote` and missed it. */
  const RETIRED_CLAIM: Record<(typeof LOCALES)[number], string> = {
    en: 'A location can set a state that overrides the public-holiday calendar used by leave and attendance.',
    ms: 'Sesuatu lokasi boleh menetapkan negeri yang mengatasi kalendar cuti umum yang digunakan oleh cuti dan kehadiran.',
    ta: 'ஒரு இடம் விடுப்பு மற்றும் வருகைக்குப் பயன்படுத்தப்படும் பொது விடுமுறை நாட்காட்டியை மேலெழுதும் மாநிலத்தை அமைக்கலாம்.',
    th: 'สถานที่หนึ่งสามารถกำหนดรัฐที่ลบล้างปฏิทินวันหยุดราชการที่ใช้โดยการลาและการเข้างานได้',
    vi: 'Một địa điểm có thể đặt tiểu bang ghi đè lịch ngày lễ công cộng được dùng cho nghỉ phép và chấm công.',
    zh: '地点可设置一个州，用以覆盖请假和考勤所使用的公共假期日历。',
  };

  it('the retired sentence is absent from EVERY string in admin.locations, in all six locales', () => {
    // Asserted across the whole namespace rather than on pageDescription alone: moving the claim to a
    // neighbouring key would otherwise pass while a screen still printed it. This is the assertion r336
    // added after finding the sentence alive for a fortnight behind a guard that checked one key.
    for (const loc of LOCALES) {
      const strings = Object.values(catalog(loc).admin.locations).filter((v): v is string => typeof v === 'string');
      const offenders = strings.filter((v) => v.includes(RETIRED_CLAIM[loc]));
      expect(offenders, `${loc}: the work site no longer overrides any holiday calendar — ADR-0086`).toEqual([]);
    }
  });

  it('the English description makes no claim about states, holidays or overriding anything', () => {
    const desc = catalog('en').admin.locations.pageDescription!;
    expect(typeof desc).toBe('string');
    expect(desc, 'present and non-empty').not.toBe('');
    expect(desc, 'no holiday claim').not.toMatch(/holiday/i);
    expect(desc, 'no state claim').not.toMatch(/\bstate\b/i);
    expect(desc, 'nothing is overridden by a work site any more').not.toMatch(/override/i);
  });

  it('the retired keys stay retired in all six catalogues', () => {
    for (const loc of LOCALES) {
      const ns = catalog(loc).admin.locations;
      for (const gone of ['state', 'stateNational', 'stateNote', 'calendar', 'calendarNone']) {
        expect(ns[gone], `${loc}: admin.locations.${gone} is retired`).toBeUndefined();
      }
    }
  });

  it('the location form offers no state control, and nothing reads the column back at the operator', () => {
    // CODE ONLY — the file's header deliberately QUOTES what it replaced, and a guard that read the
    // comments would refuse the very explanation that keeps the decision legible.
    const strip = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
    for (const rel of [
      'app/admin/work-locations/location-form.tsx',
      'app/admin/work-locations/page.tsx',
      'app/admin/work-locations/[id]/page.tsx',
      'app/admin/work-locations/[id]/edit/page.tsx',
      'app/admin/work-locations/new/page.tsx',
    ]) {
      const src = strip(read(rel));
      expect(src.split('name="state"').length - 1, `${rel}: no state control`).toBe(0);
      expect(src, `${rel}: nothing reads the column back at the operator`).not.toContain('stateLabel(');
    }
    // …and the four fields ADR-0086 KEEPS are the exact set the form posts, so the absence above means
    // something rather than being satisfied by a form that renders nothing.
    const form = strip(read('app/admin/work-locations/location-form.tsx'));
    const posted = [...new Set([...form.matchAll(/\sname="([^"]+)"/g)].map((m) => m[1]))].filter(
      (n) => !['locationId', 'companyId', 'returnTo'].includes(n),
    );
    expect(posted.sort(), 'code · name · country · branch, and nothing else').toEqual(['branch', 'code', 'country', 'name']);
  });

  it('the update action still refuses to post `state` at all — absent means KEEP, null means CLEAR', () => {
    // Not a cosmetic detail: `updateLocation` reads an ABSENT `state` as "keep" and a null one as
    // "clear", so an action that passed `|| null` would wipe the stored value on the first unrelated
    // rename. The form not having the field is only half of it; the action is the other half.
    const actions = read('app/admin/actions.ts');
    const fn = actions.slice(
      actions.indexOf('export async function updateLocationAction'),
      actions.indexOf('export async function archiveLocationAction'),
    );
    expect(fn.replace(/\/\/.*$/gm, ''), 'no state on the update path').not.toContain('state');
  });
});

// ─────────────────────────────── i18n: the label, in six locales ───────────────────────────────

describe('639bf4a5 — the label is "Locations", in all six locales', () => {
  it('nav.locations is present and non-empty everywhere', () => {
    // ⚠️ i18n/request.ts deep-merges each locale over English, so a MISSING key renders the English string
    // rather than MISSING_MESSAGE — a render check cannot see the gap and this assertion is the only thing
    // that can.
    for (const loc of LOCALES) {
      const v = catalog(loc).nav.locations;
      expect(typeof v, `${loc}: nav.locations present`).toBe('string');
      expect(v!.trim().length, `${loc}: nav.locations non-empty`).toBeGreaterThan(0);
    }
  });

  it('it is actually TRANSLATED in the five non-English locales, and so is everything this round minted', () => {
    const en = catalog('en');
    expect(LOCALES.filter((l) => l !== 'en').map((l) => catalog(l).nav.locations === en.nav.locations)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    // The strings r338 added, six locales each, each one distinct from the English.
    const MINTED = [
      'colCompany',
      'colLocation',
      'colStatus',
      'colAction',
      'statusInactive',
      'newLocationTitle',
      'editLocationTitle',
      'viewLocationTitle',
      'locationSaved',
      'sectionSite',
      'branchHint',
      // r423 retired clockingPointsHeading, clockingPointsAfterSave and the three offRegister* keys (no
      // clocking location is shown under a work location now); it minted the one below.
      'archivedNote',
      // r428 (83c0d3c8 contest) — `statusLegend`, `companySummary`, `workLocationsTitle` and
      // `backToWorkLocations` STOOD HERE and are retired WITH the standalone listing they described
      // (bracket-noted, identical across locales by the house convention — asserting them "distinct from
      // English" would fail by design). The company-first screens minted the keys below instead.
      'companyListDescription',
      'findCompanySection',
      'companySearchPlaceholder',
      'companiesSection',
      'companiesCount',
      'colClockingLocations',
      'colWorkLocations',
      'locationsCountLabel',
      'noneYet',
      'inactiveCountNote',
      'archivedCountNote',
      'viewLocationsCta',
      'orphanCompanyName',
      'orphanRowNote',
      'locationsTotalSummary',
      'sharedCountNote',
      'companyListNote',
      'backToAllCompanies',
      'companyViewDescription',
      'clockingLocationsSection',
      'clockingSectionDescription',
      'colSharedWith',
      'notShared',
      'otherCompaniesCount',
      'sharedWithNote',
      'workLocationsSection',
      'workLocationsSectionDescription',
      'addWorkLocationCta',
      'noWorkLocationsYet',
      'workLocationsSummary',
      'restoreArchivedNote',
      'backToCompany',
    ];
    /**
     * ⚠️ ONE DECLARED EXEMPTION, AND IT IS A FACT ABOUT THE LANGUAGE RATHER THAN A MISSING TRANSLATION:
     * "Status" IS the Malay word. Declared as a pair rather than by loosening the loop, so a genuinely
     * untranslated string still fails and a future exemption has to be argued for.
     */
    const SAME_WORD: readonly [string, string][] = [['ms', 'colStatus']];
    for (const key of MINTED) {
      const base = en.admin.locations[key];
      expect(typeof base, `en admin.locations.${key}`).toBe('string');
      for (const loc of LOCALES.filter((l) => l !== 'en')) {
        const v = catalog(loc).admin.locations[key];
        expect(typeof v, `${loc}: admin.locations.${key} present`).toBe('string');
        expect(v!.trim(), `${loc}: admin.locations.${key} non-empty`).not.toBe('');
        if (SAME_WORD.some(([l, k]) => l === loc && k === key)) continue;
        expect(v, `${loc}: admin.locations.${key} is still the English string`).not.toBe(base);
      }
    }
    // …and the exemption is not a hole: the exempted value is asserted to be exactly the word claimed.
    expect(catalog('ms').admin.locations.colStatus, 'ms: "Status" is the Malay word, not an English leftover').toBe('Status');
  });

  it('the page title reads the same as the menu row, in every locale', () => {
    // The screen the reporter clicks and the heading they land on must be the same words. "Locations"
    // heads the company list (step 1) and is the only row left to check this against — r428 retired the
    // second row this case used to check a pair for; `workLocationsSection` is a SECTION heading inside
    // the screen now, not a page title answering to a menu row of its own.
    for (const loc of LOCALES) {
      const c = catalog(loc);
      expect(c.admin.locations.pageTitle, `${loc}: page title equals the nav label`).toBe(c.nav.locations);
    }
  });

  it('the three retired nav keys are gone from all six, and nothing resolves any of them', () => {
    for (const loc of LOCALES) {
      expect(catalog(loc).nav.clockingLocation, `${loc}: dead nav.clockingLocation (r336)`).toBeUndefined();
      expect(catalog(loc).nav.physicalWorkLocation, `${loc}: dead nav.physicalWorkLocation (r338)`).toBeUndefined();
      // r428 (83c0d3c8 contest) — AND NOW `nav.workLocations` TOO, same reason: the row it labelled is
      // retired, its function folded into a section of the row above rather than moved to a new one.
      expect(catalog(loc).nav.workLocations, `${loc}: dead nav.workLocations (r428)`).toBeUndefined();
    }
    expect(SIDEBAR + PACK, 'no nav row still points at any retired key').not.toMatch(
      /labelKey: '(clockingLocation|physicalWorkLocation|workLocations)'/,
    );
    expect(read('lib/permissions.ts'), 'and neither does the access matrix').not.toMatch(
      /'nav\.(clockingLocation|physicalWorkLocation|workLocations)'/,
    );
  });
});

// ─────────────────────────────── THE OLD ADDRESSES STILL RESOLVE ───────────────────────────────

describe('639bf4a5 — the /admin/locations addresses redirect, guard first; they do not 404', () => {
  it('each stub calls the guard BEFORE it redirects', () => {
    for (const rel of [
      'app/admin/locations/page.tsx',
      'app/admin/locations/clocking/new/page.tsx',
      'app/admin/locations/clocking/[id]/page.tsx',
    ]) {
      const src = read(rel);
      const guard = src.indexOf('await requireAdmin()');
      const fwd = src.indexOf('forward(');
      expect(guard, `${rel} calls requireAdmin()`).toBeGreaterThan(-1);
      expect(fwd, `${rel} forwards`).toBeGreaterThan(-1);
      // A redirect that ran first would tell a non-administrator where the setting lives, and would drop
      // the route out of the function-access matrix (which only counts a page.tsx that calls a guard).
      expect(guard, `${rel} guards before it forwards`).toBeLessThan(fwd);
    }
  });

  it('the list stub forwards to the CLOCKING list (r423: the old address meant clocking locations), carrying its query', async () => {
    LAST_REDIRECT = '';
    await expect(LocationsRedirect({ searchParams: Promise.resolve({ saved: '1', focus: 'abc' }) })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(LAST_REDIRECT).toBe(`${CLOCKING_LIST}?saved=1&focus=abc`);
  });

  it('the new-clocking stub forwards, keeping a refused save’s reason and typed values', async () => {
    LAST_REDIRECT = '';
    await expect(
      NewClockingLocationRedirect({ searchParams: Promise.resolve({ error: 'Radius is required', typedName: 'Gate' }) }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toBe(`${CLOCKING_NEW_PAGE}?error=Radius+is+required&typedName=Gate`);
  });

  it('the edit stub forwards a well-formed id and notFound()s junk rather than building a path from it', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    LAST_REDIRECT = '';
    await expect(
      EditClockingLocationRedirect({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toBe(clockingEditPage(id));
    for (const junk of ['not-a-uuid', '../../../admin/users', "'; drop table clocking_location; --"]) {
      await expect(
        EditClockingLocationRedirect({ params: Promise.resolve({ id: junk }), searchParams: Promise.resolve({}) }),
        `${junk} never reaches a redirect target`,
      ).rejects.toThrow('NEXT_NOT_FOUND');
    }
  });
});

// ─────────────────────────── r428: THE OLD /admin/work-locations ADDRESS ───────────────────────────

/**
 * r428 (83c0d3c8 contest) — `/admin/work-locations` is a NEW member of the "old address redirects" family
 * (its own stub rather than one of the three above, because it resolves `?focus=` to a COMPANY, which
 * none of those three do). Executed end to end against a real database, not merely read off the source —
 * the `?focus=` resolution is exactly the kind of claim a source-shape check cannot see going wrong.
 */
describe('r428 — the /admin/work-locations address redirects, guard first, and resolves ?focus= to its company', () => {
  it('no ?focus= at all: forwards to the bare company list (step 1)', async () => {
    LAST_REDIRECT = '';
    await expect(WorkLocationsPage({ searchParams: Promise.resolve({ saved: '1' }) })).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toBe(`${CLOCKING_LIST}?saved=1`);
  });

  it('?focus=<a real work-location id>: resolves its company and forwards there, every other param carried through', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    LAST_REDIRECT = '';
    await expect(
      WorkLocationsPage({ searchParams: Promise.resolve({ saved: '1', focus: loc }) }),
    ).rejects.toThrow('NEXT_REDIRECT');
    // URLSearchParams preserves insertion order: `forward()` walks `sp` first (saved, focus), THEN the
    // resolved `company` is added — so `company` lands LAST, not merged alphabetically or re-ordered.
    expect(LAST_REDIRECT).toBe(`${CLOCKING_LIST}?saved=1&focus=${loc}&company=${b.companyId}`);
  });

  it('?focus= names a location OUTSIDE this admin’s scope: resolves nothing, falls back to step 1 rather than disclosing it', async () => {
    const other = await addCompany('Sister Sdn Bhd');
    const { id: sisterLoc } = await createLocation(ADMIN, { companyId: other, code: 'SIS', name: 'Sister Site' });
    ADMIN = await adminFor(b.companyId);
    LAST_REDIRECT = '';
    await expect(
      WorkLocationsPage({ searchParams: Promise.resolve({ focus: sisterLoc }) }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT, 'no company= — the id never resolved for this admin').toBe(`${CLOCKING_LIST}?focus=${sisterLoc}`);
  });

  it('?focus= is junk or unknown: ignored, never built into a query', async () => {
    for (const junk of ['not-a-uuid', '00000000-0000-4000-8000-000000000000', "'; drop table location; --"]) {
      LAST_REDIRECT = '';
      await expect(WorkLocationsPage({ searchParams: Promise.resolve({ focus: junk }) })).rejects.toThrow('NEXT_REDIRECT');
      // Built the same way the stub itself builds it (URLSearchParams encoding — `+` for a space, not
      // `%20`), so the comparison is about company= being ABSENT, not about matching encodeURIComponent.
      expect(LAST_REDIRECT, `${JSON.stringify(junk)} still forwards, just with nothing resolved`).toBe(
        `${CLOCKING_LIST}?${new URLSearchParams({ focus: junk }).toString()}`,
      );
    }
  });

  it('guards itself before it forwards', () => {
    const src = read('app/admin/work-locations/page.tsx');
    const guard = src.indexOf('await requireAdmin()');
    const fwd = src.indexOf('redirect(');
    expect(guard, 'calls requireAdmin()').toBeGreaterThan(-1);
    expect(fwd, 'and forwards').toBeGreaterThan(-1);
    expect(guard, 'guards before it forwards').toBeLessThan(fwd);
  });
});
