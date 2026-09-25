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
import WorkLocationsPage from '../app/admin/work-locations/page';
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
import { CLOCKING_NEW_PAGE, LOCATIONS_LIST, clockingEditPage } from '../app/admin/work-locations/clocking/form-fields';
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
/** Count occurrences of the QUOTED href, so a prose mention in a comment is not a nav row. */
const countQuoted = (haystack: string, href: string) => haystack.split(`'${href}'`).length - 1;

// ───────────────────────── (a) UNDER ATTENDANCE, NOT UNDER ORGANIZATION ─────────────────────────

describe('639bf4a5 (a) — the row is under Attendance and is NOT under Organization', () => {
  it('is a child of the attendance settings node, labelled `locations`, beside Attendance allowance', () => {
    const node = attendancePack.navNodes!.find((n) => n.labelKey === 'attendanceSettings')!;
    const row = node.children.find((c) => c.href === HREF);
    expect(row, 'the Locations row is a child of the Attendance settings node').toBeTruthy();
    expect(row!.labelKey, 'and it is labelled with the key that reads "Locations"').toBe('locations');
    expect(row!.adminOnly, 'administrators only, as it always was').toBe(true);
    // POSITION, not mere presence: 5cb199b3's order put it after Attendance allowance, and a row appended
    // to the end of a long literal would satisfy "it is in the node" while missing the arrangement.
    const hrefs = node.children.map((c) => c.href);
    expect(hrefs.indexOf(HREF), 'it comes after Attendance allowance').toBeGreaterThan(
      hrefs.indexOf('/admin/attendance-allowance'),
    );
    expect(PACK, 'declared in the pack source, not mounted from elsewhere').toContain(
      `{ href: '${HREF}', labelKey: 'locations', icon: MapPin, adminOnly: true }`,
    );
  });

  it('is NOT a row under Organization — not moved-and-copied, and not left behind', () => {
    // ⚠️ BOTH DIRECTIONS. The likeliest way to get this wrong is to add the attendance row without
    // removing the Administration one: the rail would offer the register twice.
    expect(countQuoted(SIDEBAR, HREF), 'no hand-written row in components/sidebar.tsx').toBe(0);
    expect(SIDEBAR, 'and not under the r336 label either').not.toContain("labelKey: 'physicalWorkLocation'");
    // The Organization row itself is untouched and still there — a guard that only said "ours is gone"
    // would pass on a sidebar that had lost the neighbour too.
    expect(countQuoted(SIDEBAR, '/admin/organization'), 'Organization keeps its own row').toBe(1);
    expect(countQuoted(SIDEBAR + PACK, HREF), `${HREF} appears exactly once across the rail sources`).toBe(1);
    expect(countQuoted(SIDEBAR + PACK, OLD_HREF), `${OLD_HREF} must have no row anywhere`).toBe(0);
  });

  it('lights its own row, and the Organization row it used to sit beside does NOT', () => {
    const orgRow = { href: '/admin/organization' };
    const mineRow = { href: HREF };
    expect(isNavRowActive(HREF, '', mineRow), 'its own row lights').toBe(true);
    expect(isNavRowActive(HREF, '', orgRow), 'the Organization row does NOT').toBe(false);
    // …and it stays lit on every one of the dedicated screens, which is the point of keeping them under
    // the same address rather than minting a sibling route for each.
    for (const sub of [`${HREF}/new`, `${HREF}/abc`, `${HREF}/abc/edit`, `${HREF}/clocking/new`]) {
      expect(isNavRowActive(sub, '', mineRow), `${sub} keeps the row lit`).toBe(true);
    }
    // …and an attendance sibling does not claim it.
    const siblings = attendancePack
      .navNodes!.flatMap((n) => n.children)
      .map((c) => c.href)
      .filter((h) => h !== HREF);
    expect(siblings.some((h) => isHrefActive(HREF, '', h)), 'no sibling row claims this address').toBe(false);
  });

  it('is entitlement-gated by `attendance` again — stated, not hidden', () => {
    /**
     * MODULE_OF_HREF (components/sidebar.tsx) is `ATTENDANCE_NODES.flatMap((n) => n.children...)`, so a
     * child of the settings node IS in the map by construction. `attendance` is billable (isCore:false in
     * packs/catalog.ts), which means the register is behind the attendance entitlement — exactly the
     * fault 4509d2b8 moved Holidays out of this node to FIX, accepted here because the reporter asked for
     * this structure and the tenant holds the module. Asserted as a PROPERTY of the descriptor rather
     * than by grepping the map, so it cannot quietly stop being true.
     *
     * ⚠️ UN-GATING IS A ONE-LINE CHANGE if the reporter asks: a hand-written `[HREF, …]` pair would have
     * to be excluded from the map instead. Nothing else about this round depends on the gating.
     */
    const inNodes = attendancePack.navNodes!.flatMap((n) => n.children).some((c) => c.href === HREF);
    expect(inNodes, 'the row is a nav-node child, which is what puts it in MODULE_OF_HREF').toBe(true);
    expect(SIDEBAR, 'MODULE_OF_HREF is still derived from the pack, not hand-written per row').toContain(
      "ATTENDANCE_NODES.flatMap((n) => n.children.map((c) => [c.href, 'attendance'] as const))",
    );
    // …and nobody has quietly added a hand-written exemption for it, which would be the silent un-gating.
    expect(SIDEBAR).not.toMatch(new RegExp(`\\[\\s*'${HREF}'\\s*,\\s*'[^']+'\\s*\\]`));
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
      'app/admin/work-locations/page.tsx',
      'app/admin/work-locations/[id]/page.tsx',
      'app/admin/work-locations/[id]/edit/page.tsx',
      'app/admin/work-locations/clocking/page.tsx',
      'app/admin/work-locations/clocking/[id]/page.tsx',
      'app/admin/work-locations/clocking-points.tsx',
    ]) {
      const src = read(rel);
      expect(src, `${rel} imports the facade`).toContain("from '@/packs/attendance/service'");
      expect(src, `${rel} must not import the pack's implementation directly`).not.toMatch(
        /from '@\/core\/clocking-location'/,
      );
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
  it('the screen column keeps its key, href and guard, and gains the four new routes', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'locations');
    expect(screen, 'the screen column survives BOTH moves — the screenKey is a permission identity').toBeTruthy();
    expect(screen!.href, 'the ADDRESS did not move: the reporter renamed the function, not the URL').toBe(HREF);
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

  it('the listing renders NO form, and links out to the three screens instead', () => {
    // ⚠️ THE ABSENCE IS THE REQUIREMENT, in the reporter's own words: "No form inline above or below the
    // listing." Asserted on the SOURCE as well as on the markup below, because a form that only renders
    // for one role would be absent from a single render and present in the product.
    expect(LIST_SRC, 'the company listing posts nothing').not.toContain('<form');
    expect(LIST_SRC, 'and posts no location action').not.toMatch(/action=\{(create|update|archive|restore)LocationAction\}/);
    expect(LIST_SRC, 'Add opens its own screen').toContain('LOCATION_NEW_PAGE');
    expect(LIST_SRC, 'View opens its own screen').toContain('locationViewPage(l.id)');
    expect(LIST_SRC, 'Edit opens its own screen').toContain('locationEditPage(l.id)');
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
const renderList = async (sp: Record<string, string> = {}) =>
  visible(toMarkup(await WorkLocationsPage({ searchParams: Promise.resolve(sp) })));
const renderNew = async (sp: Record<string, string> = {}) =>
  visible(toMarkup(await NewLocationPage({ searchParams: Promise.resolve(sp) })));
const renderView = async (id: string, sp: Record<string, string> = {}) =>
  visible(toMarkup(await ViewLocationPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) })));
const renderEdit = async (id: string, sp: Record<string, string> = {}) =>
  visible(toMarkup(await EditLocationPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) })));

/** Only the table body: a company name printed in the unmapped-branch card below is not a listing row. */
const tbody = (html: string) => html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
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

describe('639bf4a5 (b) — EVERY company is a row, whether or not it has a location', () => {
  it('the listing shows all three companies, the two without a location included, and the count matches listCompanies', async () => {
    /**
     * ⚠️ THIS IS THE ITEM. The reporter's words: "Every company appears, whether or not it has a
     * location — that is what makes Add useful." Before r338 the page rendered one card per company and
     * a card was only useful if you scrolled to it; the failure this case exists for is a listing built
     * from the LOCATIONS table, which would silently show only the companies that already have one.
     */
    const second = await addCompany('Beta Sdn Bhd');
    await addCompany('Gamma Sdn Bhd');
    await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });

    const companies = await listCompanies(ADMIN, { adminOnly: true });
    expect(companies.map((c) => c.name).sort(), 'the fixture really has three').toEqual([
      'Acme Sdn Bhd',
      'Beta Sdn Bhd',
      'Gamma Sdn Bhd',
    ]);

    const rows = tbody(await renderList());
    for (const c of companies) {
      expect(count(rows, c.name), `${c.name} is a row, exactly once`).toBe(1);
    }
    // The two with nothing say so, and carry the Add that gives them one.
    expect(rows, 'a company with no location still has a row').toContain(`id="company-${second}"`);
    expect(count(rows, 'statusInactive'), 'two companies read Inactive').toBe(2);
    expect(count(rows, 'statusActive'), 'and one reads Active').toBe(1);
    expect(count(rows, `href="${LOCATION_NEW_PAGE}?companyId=${second}"`), 'Add, for the empty one').toBe(1);
    expect(
      count(rows, `href="${LOCATION_NEW_PAGE}?companyId=${b.companyId}"`),
      'and for the one that already has a location — a second location must stay creatable',
    ).toBe(1);
  });

  it('STATUS IS DERIVED, AND THE PAGE SAYS SO: a company whose only location is archived reads Inactive', async () => {
    // `location` has no active/inactive column — the screens have archive / restore. Inventing a status
    // nobody can set would be worse than having none, so the word is defined on screen and derived here.
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    expect(tbody(await renderList()), 'live location ⇒ Active').toContain('statusActive');

    await archiveLocation(ADMIN, { locationId: loc });
    const rows = tbody(await renderList());
    expect(rows, 'its only location archived ⇒ Inactive').toContain('statusInactive');
    expect(rows, 'and NOT Active').not.toContain('statusActive');
    // …and the location itself is still listed, with its own badge: archiving hides nothing.
    expect(rows, 'the archived location still renders — its history stays reachable').toContain('Headquarters');
    expect(rows).toContain('statusArchived');
    // The legend is on the page, outside the table, in the catalogue's own words.
    expect(await renderList(), 'the derived word is defined on screen').toContain('statusLegend');
    const legend = catalog('en').admin.locations.statusLegend!;
    expect(legend, 'and the definition is the one this code implements').toMatch(/at least one location/i);
    expect(legend).toMatch(/archiv/i);
  });
});

describe('639bf4a5 (c) — a company with TWO locations renders BOTH, under one company cell', () => {
  it('two lines, one rowSpan’d company name, one derived status, View/Edit on each and Add on the last', async () => {
    /**
     * ⚠️ THE REPORTER'S EXAMPLE SHOWS ONE LOCATION PER COMPANY; THEIR DATA DOES NOT. Production on
     * 2026-09-25: 13 companies, 6 with a location, 8 locations. So the decision had to be made and said
     * out loud, and it is: EVERY location gets its own line, `rowSpan`ned under one Company cell and one
     * Status cell. Nothing is summarised as "+1 more" and nothing is hidden behind a count — which is the
     * failure this case exists to catch, because a listing that renders `rows[0]` alone would pass every
     * other assertion in this file.
     */
    const { id: hq } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id: yard } = await createLocation(ADMIN, { companyId: b.companyId, code: 'YARD', name: 'North Yard' });

    const rows = tbody(await renderList());
    expect(rows, 'the first location is a line').toContain('Headquarters');
    expect(rows, 'and so is the second — not a count, not a "+1 more"').toContain('North Yard');
    expect(rows).not.toMatch(/\+\s*\d+\s*more/i);
    expect(count(rows, 'Acme Sdn Bhd'), 'the company is named ONCE, across both lines').toBe(1);
    // react-dom/server emits the JSX spelling (`rowSpan="2"`); HTML attribute names are case-insensitive,
    // so the assertion is too rather than pinning React's own casing.
    const spans = rows.match(/row[Ss]pan="2"/g) ?? [];
    expect(spans.length, 'Company and Status both span the two lines; Location and Action do not').toBe(2);
    // Each line carries its OWN way in, and the company's Add sits on the last line of the block.
    for (const id of [hq, yard]) {
      // ⚠️ THE CLOSING QUOTE IS LOAD-BEARING: locationEditPage(id) is locationViewPage(id) + '/edit', so a
      // prefix match would count the Edit link as a second View and pass on a row that had lost one.
      expect(count(rows, `href="${locationViewPage(id)}"`), `View for ${id}`).toBe(1);
      expect(count(rows, `href="${locationEditPage(id)}"`), `Edit for ${id}`).toBe(1);
    }
    expect(count(rows, `href="${LOCATION_NEW_PAGE}?companyId=${b.companyId}"`), 'one Add for the company').toBe(1);
    expect(count(rows, `id="row-${hq}"`) + count(rows, `id="row-${yard}"`), 'two addressable rows').toBe(2);
  });
});

describe('639bf4a5 (d) — the listing is scoped by adminOnly, not by the company switcher', () => {
  it('a company-scoped admin sees THEIR company and not the sister company', async () => {
    /**
     * app/admin/organization/page.tsx: *the filter IS the permission boundary*. Feedback ab77dc1f is the
     * incident — a tenant-wide list disclosed how many companies the organisation has to someone whose
     * access did not otherwise reveal it. A listing that showed every company to an admin scoped to one
     * would repeat it, and would also offer an Add the database refuses.
     */
    const other = await addCompany('Sister Sdn Bhd');
    await createLocation(ADMIN, { companyId: other, code: 'SIS', name: 'Sister Site' });

    const group = tbody(await renderList());
    expect(group, 'a GROUP admin sees both').toContain('Sister Sdn Bhd');
    expect(group).toContain('Acme Sdn Bhd');

    ADMIN = await adminFor(b.companyId);
    expect((await listCompanies(ADMIN, { adminOnly: true })).map((c) => c.name)).toEqual(['Acme Sdn Bhd']);
    const scoped = tbody(await renderList());
    expect(scoped, 'their own company is listed').toContain('Acme Sdn Bhd');
    expect(scoped, 'the sister company is NOT — neither its name…').not.toContain('Sister Sdn Bhd');
    expect(scoped, '…nor its site').not.toContain('Sister Site');
    expect(scoped, '…nor an Add that would be refused').not.toContain(`companyId=${other}`);
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
    expect(LIST_SRC).toContain('await listCompanies(s, { adminOnly: true })');
    // 0f1802bf — a master-data screen ignores the switcher, exactly as the Organization listing does.
    // Without this the count on the page would be a cookie's opinion rather than the permission boundary.
    // CODE ONLY — the file header explains WHY the switcher is not consulted and names it to do so.
    const code = LIST_SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(code, 'the switcher is not consulted').not.toContain('getScopeIds');
  });
});

describe('639bf4a5 (f) — Save, Cancel and Back all land on the listing, query preserved', () => {
  const FROM = `${LOCATIONS_LIST}?saved=1&focus=11111111-1111-4111-8111-111111111111`;
  /** renderToStaticMarkup escapes `&` inside an attribute. */
  const esc = (s: string) => s.replace(/&/g, '&amp;');

  it('Back and Cancel on the Add screen carry the listing’s own query', async () => {
    const html = await renderNew({ companyId: b.companyId, from: FROM });
    expect(count(html, `href="${esc(FROM)}"`), 'Back and Cancel, both of them').toBe(2);
    expect(html, 'and the form posts the same destination back for the Save').toContain(
      `name="returnTo" value="${esc(FROM)}"`,
    );
  });

  it('Back and Cancel on the View and Edit screens carry it too', async () => {
    const { id } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const view = await renderView(id, { from: FROM });
    expect(view, 'View’s Back').toContain(`href="${esc(FROM)}"`);
    const edit = await renderEdit(id, { from: FROM });
    expect(count(edit, `href="${esc(FROM)}"`), 'Edit’s Back and Cancel').toBe(2);
    expect(edit).toContain(`name="returnTo" value="${esc(FROM)}"`);
  });

  it('a SAVE lands on the listing at the row it just wrote, keeping what the operator was filtered on', async () => {
    const created = await runAction(createLocationAction, {
      companyId: b.companyId,
      code: 'HQ',
      name: 'Headquarters',
      country: 'MY',
      branch: '',
      returnTo: FROM,
    });
    const [row] = await listLocations(ADMIN, [b.companyId], {});
    // The stale `focus` of the page they came from is REPLACED, not appended — a save that carried the
    // previous row along would highlight a row nobody just touched.
    expect(created).toBe(`${LOCATIONS_LIST}?saved=1&focus=${row.id}#row-${row.id}`);

    const edited = await runAction(updateLocationAction, {
      locationId: row.id,
      code: 'HQ',
      name: 'Head Office',
      country: 'MY',
      branch: '',
      returnTo: `${LOCATIONS_LIST}?saved=1&focus=${row.id}`,
    });
    expect(edited).toBe(`${LOCATIONS_LIST}?saved=1&focus=${row.id}#row-${row.id}`);
    // …and the listing really does highlight exactly that row when it lands.
    const html = await renderList({ saved: '1', focus: row.id });
    expect(html).toContain(`id="row-${row.id}"`);
    expect(count(html, 'bg-muted/50'), 'exactly one row highlighted').toBe(1);
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

    // …and it is on the listing, and on its own two screens.
    expect(tbody(await renderList()), 'the site renders on the listing').toContain('Headquarters');
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
    expect(await renderList(), 'the listing says so, beneath the table').toContain('unmappedBranchesHeading');

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
    expect(await renderList(), 'the heading is gone once the branch is mapped').not.toContain('unmappedBranchesHeading');
  });

  it('a location’s clocking points move with it onto its own screens — and one linked to nothing is still reachable', async () => {
    /**
     * The reporter's fourth point: "the clocking points a location carries move with it onto that
     * dedicated screen, so a site and its points stay maintained in one place." Two sites are used
     * because a bug that herded every point onto the first site would satisfy a one-site test.
     */
    const { id: hq } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id: yard } = await createLocation(ADMIN, { companyId: b.companyId, code: 'YARD', name: 'North Yard' });
    const { id: gate } = await createClockingLocation(ADMIN, { name: 'North Gate', lat: 3.139, lng: 101.6869, radiusM: 200, locationId: hq });
    const { id: yardGate } = await createClockingLocation(ADMIN, { name: 'Yard Gate', lat: 3.14, lng: 101.687, radiusM: 200, locationId: yard });
    const { id: floating } = await createClockingLocation(ADMIN, { name: 'Floating Point', lat: 3.15, lng: 101.69, radiusM: 200 });

    for (const render of [renderView, renderEdit]) {
      const hqHtml = await render(hq);
      expect(hqHtml, 'North Gate is on the HQ screen').toContain(`id="row-${gate}"`);
      expect(hqHtml, "…and nobody else's point is").not.toContain(`id="row-${yardGate}"`);
      expect(hqHtml, '…including the unlinked one').not.toContain(`id="row-${floating}"`);
      const yardHtml = await render(yard);
      expect(yardHtml, 'Yard Gate is on the YARD screen').toContain(`id="row-${yardGate}"`);
      expect(yardHtml).not.toContain(`id="row-${gate}"`);
    }
    // The point that links to NOTHING is not on either site, and the listing points at where it is.
    const list = await renderList();
    expect(list, 'the listing renders no point row of its own').not.toContain(`id="row-${floating}"`);
    expect(list, 'but it does not pretend the point is gone').toContain('offRegisterLink');
    expect(list).toContain(`href="/admin/work-locations/clocking"`);
    // …and the Edit screen is where a point is added to a site, with the site pre-picked.
    expect(await renderEdit(hq)).toContain(`href="${CLOCKING_NEW_PAGE}?addPoint=${hq}"`);
    expect(await renderEdit(hq), 'and each point still opens its single editor').toContain(`href="${clockingEditPage(gate)}"`);
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
      'statusLegend',
      'companySummary',
      'newLocationTitle',
      'editLocationTitle',
      'viewLocationTitle',
      'locationSaved',
      'sectionSite',
      'branchHint',
      'clockingPointsHeading',
      'clockingPointsAfterSave',
      'offRegisterTitle',
      'offRegisterDescription',
      'offRegisterLink',
      'archivedNote',
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
    // The screen the reporter clicks and the heading they land on must be the same words.
    for (const loc of LOCALES) {
      const c = catalog(loc);
      expect(c.admin.locations.pageTitle, `${loc}: page title equals the nav label`).toBe(c.nav.locations);
    }
  });

  it('the two retired nav keys are gone from all six, and nothing resolves either', () => {
    for (const loc of LOCALES) {
      expect(catalog(loc).nav.clockingLocation, `${loc}: dead nav.clockingLocation (r336)`).toBeUndefined();
      expect(catalog(loc).nav.physicalWorkLocation, `${loc}: dead nav.physicalWorkLocation (r338)`).toBeUndefined();
    }
    expect(SIDEBAR + PACK, 'no nav row still points at either retired key').not.toMatch(
      /labelKey: '(clockingLocation|physicalWorkLocation)'/,
    );
    expect(read('lib/permissions.ts'), 'and neither does the access matrix').not.toMatch(
      /'nav\.(clockingLocation|physicalWorkLocation)'/,
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

  it('the list stub forwards to the register, carrying its query', async () => {
    LAST_REDIRECT = '';
    await expect(LocationsRedirect({ searchParams: Promise.resolve({ saved: '1', focus: 'abc' }) })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(LAST_REDIRECT).toBe(`${LOCATIONS_LIST}?saved=1&focus=abc`);
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
