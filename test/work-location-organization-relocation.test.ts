/**
 * Item 639bf4a5 — the work-site register leaves Attendance for Organization, as "Physical Work Location".
 *
 * WHAT MOVED, AND WHY IT IS AN OWNERSHIP MOVE RATHER THAN A RENAME. The screen was Attendance › Clocking
 * Location at `/admin/locations`, and `packs/attendance/index.ts` claimed `app/admin/locations/` as one of
 * the pack's own surfaces ("clocking-site admin") — which is what let the list import
 * `core/clocking-location` directly past test/attendance-pack-drift.test.ts. The reporter asked for the
 * work-site setup to live under Organization. That screen is company-scoped master data: every row is
 * `location.companyId`-scoped with RLS by `app.is_admin_for(company_id)`, it carries the BRANCH MAPPING the
 * Personnel Attendance tab proposes work locations from, and — the reason r332 refused to delete it — it is
 * the ONLY editor of either. So the tree moved to `app/admin/work-locations/`, the pack's surface list
 * SHRANK by one entry rather than gaining a new one, and the register consumes the clocking service
 * through the published facade like any other outside caller.
 *
 * NOTHING WAS MIGRATED, AND NOTHING NEEDED TO BE — `location.companyId` and the RLS policy already made
 * "maintained by Company" true before this round. No schema change, no service change, no new store.
 *
 * ⚠️ THE TICKET'S STATED REASON WAS STALE, AND THE SCREEN STILL CARRIED HALF OF IT. The request said "a
 * location can set a state that overrides the public-holiday calendar used by Leave and Attendance". r332
 * (item 0fe1ca2e, ADR-0086) removed the work site's hold on public holidays entirely: both readers in
 * core/holidays.ts lost the location join, migration 0484 dropped `location.holiday_group_id`, and the
 * State control, its read-back and the `admin.locations.state` / `stateNote` keys were deleted from all six
 * catalogues because the note had become a false statement.
 *
 * ⚠️ BUT `admin.locations.pageDescription` STILL SAID IT, IN ALL SIX LOCALES, AND STILL RENDERED — and no
 * guard saw it. test/clocking-location-page.test.ts's ADR-0086 case asserts the rendered markup matches
 * neither /overrides the employee/ nor /public-holiday resolution/, which were `stateNote`'s exact words;
 * `pageDescription` said "overrides the public-holiday CALENDAR", which matches neither. That case also
 * renders under a translator mocked to echo KEY NAMES, so no English sentence is on its markup at all and
 * the phrase check could not have failed whatever the catalogue said. The sentence is removed here and the
 * six retired strings are quoted below so they cannot come back.
 *
 * WHAT THIS FILE PINS: the row is under Organization and NOT under Attendance (both directions); the old
 * addresses still resolve, guard-first, as redirects; creating / editing / archiving / restoring a site
 * still works from the new route; branch mapping still proposes and still lists unmapped branches; clocking
 * points still group under their site; and the relocated screen has no State control and makes no holiday
 * claim in any locale.
 *
 * ⚠️ FILE-LEVEL MOCKS (the test/clocking-location-page.test.ts idiom): requireAdmin() returns the
 * module-level ADMIN; redirect() and notFound() throw; getTranslations echoes KEY NAMES, so server strings
 * in the markup below are KEYS where they mean sentences; next/headers gives the scope-cookie reader an
 * empty jar. Anything about the actual WORDS is therefore asserted against the catalogues, never the
 * markup — which is the trap the pageDescription miss above was made of.
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
import { archiveLocation, createLocation, listLocations, listUnmappedBranches, resolveLocationForBranch } from '../core/location';
import { hireEmployee, setEmploymentInfo } from '../core/org';

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

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalog = (loc: string) =>
  JSON.parse(read(`messages/${loc}.json`)) as {
    nav: Record<string, string | undefined>;
    admin: { locations: Record<string, string | undefined> };
  };

const NEW_HREF = '/admin/work-locations';
const OLD_HREF = '/admin/locations';
const SIDEBAR = read('components/sidebar.tsx');
const PACK = read('packs/attendance/index.ts');
/** Count occurrences of the QUOTED href, so a prose mention in a comment is not a nav row. */
const countQuoted = (haystack: string, href: string) => haystack.split(`'${href}'`).length - 1;

// ───────────────────────────── (a) UNDER ORGANIZATION, NOT UNDER ATTENDANCE ─────────────────────────────

describe('639bf4a5 (a) — the row is under Organization and is NOT under Attendance', () => {
  it('is a row in the Administration group, directly under Organization, labelled physicalWorkLocation', () => {
    expect(SIDEBAR, 'the row is declared in components/sidebar.tsx').toContain(
      `{ href: '${NEW_HREF}', labelKey: 'physicalWorkLocation', icon: MapPin }`,
    );
    // POSITION, not mere presence: the reporter's picture shows it under Organization, and a row appended
    // to the bottom of Administration would satisfy "it is in the group" while missing the item.
    const org = SIDEBAR.indexOf("{ href: '/admin/organization',");
    const mine = SIDEBAR.indexOf(`{ href: '${NEW_HREF}',`);
    const next = SIDEBAR.indexOf("{ href: '/admin/personnel',");
    expect(org, 'the Organization row exists').toBeGreaterThan(-1);
    expect(mine, 'the Physical Work Location row exists').toBeGreaterThan(-1);
    expect(mine, 'it comes after Organization').toBeGreaterThan(org);
    expect(mine, 'and before the next Administration row, so nothing was inserted between').toBeLessThan(next);
    // The icon is free in this group: the collapsed rail draws glyphs alone, so a shared one is unreadable.
    const adminRows = SIDEBAR.slice(org, SIDEBAR.indexOf('NOTICE', org) === -1 ? SIDEBAR.length : SIDEBAR.length);
    expect(adminRows.split('icon: MapPin').length - 1, 'no sibling row carries the same glyph').toBe(1);
  });

  it('is NOT a row on the attendance pack — not moved-and-copied, and not left behind', () => {
    // The descriptor half: what the rail actually mounts.
    const navHrefs = attendancePack.navNodes!.flatMap((n) => n.children).map((c) => c.href);
    const linkHrefs = (attendancePack.navLinks ?? []).map((l) => l.href);
    for (const href of [OLD_HREF, NEW_HREF]) {
      expect(navHrefs, `no attendance nav node carries ${href}`).not.toContain(href);
      expect(linkHrefs, `and it did not reappear as a flat attendance link: ${href}`).not.toContain(href);
    }
    // The SOURCE half: a commented-out row is still a row somebody uncomments, and ATTENDANCE_NAV is what
    // a future reader edits.
    expect(countQuoted(PACK, OLD_HREF), 'the old href has no quoted row left in the pack').toBe(0);
    expect(countQuoted(PACK, NEW_HREF), 'and the new one was not written into the pack instead').toBe(0);
    expect(PACK, 'the label key it used is gone from the pack too').not.toContain("labelKey: 'clockingLocation'");
  });

  it('appears EXACTLY ONCE across the rail sources (moved, not duplicated)', () => {
    // The likeliest way to get this wrong is to add the Organization row without removing the Attendance
    // one: the rail would offer the register twice AND the surviving attendance copy would put it back
    // into MODULE_OF_HREF, re-gating company master data behind a billable module.
    expect(countQuoted(SIDEBAR + PACK, NEW_HREF), `${NEW_HREF} across sidebar.tsx + packs/attendance/index.ts`).toBe(1);
    expect(countQuoted(SIDEBAR + PACK, OLD_HREF), `${OLD_HREF} must have no row anywhere`).toBe(0);
  });

  it('is owned by NO sellable module — the un-gating half of the move', () => {
    // MODULE_OF_HREF (components/sidebar.tsx) has two halves and the row must be absent from BOTH, exactly
    // as 4509d2b8 required for Holidays. The derived half is covered by the pack assertion above; this is
    // the hand-written half, where a literal pair would silently restore the gating.
    expect(SIDEBAR, 'no hand-written MODULE_OF_HREF entry for the work-location row').not.toMatch(
      new RegExp(`\\[\\s*'${NEW_HREF}'\\s*,\\s*'[^']+'\\s*\\]`),
    );
  });

  it('lights its own row and NOT the Organization row it sits under', () => {
    // /admin/organization deliberately has no exactHref (its own /new and /[companyId] sub-routes must
    // light it), and isNavRowActive is a segment-prefix match — so a route nested UNDER it would light two
    // rows at once. That is why this screen is a sibling address rather than /admin/organization/....
    const orgRow = { href: '/admin/organization' };
    const mineRow = { href: NEW_HREF };
    expect(isNavRowActive(NEW_HREF, '', mineRow), 'its own row lights').toBe(true);
    expect(isNavRowActive(NEW_HREF, '', orgRow), 'the Organization row does NOT').toBe(false);
    expect(isNavRowActive(`${NEW_HREF}/clocking/new`, '', mineRow), 'and it stays lit on its sub-pages').toBe(true);
    // …and the attendance node's own parent must not light here either.
    const attendanceChildren = attendancePack.navNodes!.flatMap((n) => n.children).map((c) => c.href);
    expect(attendanceChildren.some((h) => isHrefActive(NEW_HREF, '', h)), 'no attendance row claims it').toBe(false);
  });
});

// ─────────────────────────────── THE PACK-OWNERSHIP HALF (ADR-0080) ───────────────────────────────

describe('639bf4a5 — the attendance pack lost the SCREEN and kept the SERVICE', () => {
  it('the drift ratchet no longer authorises the moved tree, and was not re-widened at the new address', () => {
    const drift = read('test/attendance-pack-drift.test.ts');
    const always = drift.slice(drift.indexOf('const ALWAYS_ALLOWED'), drift.indexOf('describe('));
    expect(countQuoted(always, 'app/admin/locations/'), 'the old surface claim is gone').toBe(0);
    expect(
      countQuoted(always, 'app/admin/work-locations/'),
      'and the hole was NOT re-opened at the new address — this ratchet only shrinks',
    ).toBe(0);
  });

  it('the relocated screens read clocking through the pack facade, never the implementation', () => {
    for (const rel of [
      'app/admin/work-locations/page.tsx',
      'app/admin/work-locations/clocking/[id]/page.tsx',
    ]) {
      const src = read(rel);
      expect(src, `${rel} imports the facade`).toContain("from '@/packs/attendance/service'");
      expect(src, `${rel} must not import the pack's implementation directly`).not.toMatch(
        /from '@\/core\/clocking-location'/,
      );
    }
    // …and the org spine is STILL imported directly, because that half is kernel and always was.
    expect(read('app/admin/work-locations/page.tsx')).toContain("from '@/core/location'");
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

// ─────────────────────────────── (b) THE OLD ADDRESSES STILL RESOLVE ───────────────────────────────

describe('639bf4a5 (b) — the old addresses redirect, guard first; they do not 404', () => {
  it('all six routes are registered on the unchanged `locations` screen column', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'locations');
    expect(screen, 'the screen column survives the move — the screenKey is a permission identity').toBeTruthy();
    expect(screen!.href, 'the column follows the menu').toBe(NEW_HREF);
    expect(screen!.labelKey).toBe('nav.physicalWorkLocation');
    expect(screen!.guard, 'the guard is unchanged: administrators only').toBe('requireAdmin');
    expect(screen!.routes).toEqual([
      '/admin/work-locations',
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
    }
  });

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
});

// ─────────────────────────────── (f) NO STATE FIELD, IN ANY LOCALE ───────────────────────────────

/**
 * ADR-0086 (item 0fe1ca2e, r332) — THE RELOCATED SCREEN MUST NOT REGROW A HOLIDAY STATE, AND MUST NOT
 * DESCRIBE ONE.
 *
 * `location.state` was the TOP rung of the public-holiday precedence (location.state → holiday group →
 * employment.work_state → company.default_work_state → national). r332 removed the location join from both
 * readers in core/holidays.ts; public holidays come from the EMPLOYEE'S OWN WORK STATE now. A control whose
 * stored value changes nothing is worse than a dead column — an operator would set a State expecting
 * holidays to follow — and a SENTENCE that promises it is worse still.
 *
 * The retired sentences are quoted in full so a future round cannot restore one by copy-paste, and so this
 * guard says what it is refusing rather than describing it. The column itself STAYS (db/schema.ts records
 * why); it simply stops being editable and stops being advertised.
 */
describe('639bf4a5 (f) — ADR-0086: no State control, and no holiday claim in any of the six locales', () => {
  /** What `admin.locations.pageDescription` said until this round — r332 deleted `stateNote` and missed it. */
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
    // neighbouring key would otherwise pass while the screen still prints it.
    for (const loc of LOCALES) {
      const strings = Object.values(catalog(loc).admin.locations).filter((v): v is string => typeof v === 'string');
      const offenders = strings.filter((v) => v.includes(RETIRED_CLAIM[loc]));
      expect(offenders, `${loc}: the work site no longer overrides any holiday calendar — ADR-0086`).toEqual([]);
    }
  });

  it('the English description makes no claim about states, holidays or overriding anything', () => {
    // The one locale this repo can reason about in words. The five translations are pinned by the
    // sentence-level check above, and by test/i18n-coverage.test.ts check A keeping the key sets in step.
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

  it('the relocated source offers no state control on either form', () => {
    // CODE ONLY — the file's header and its ADR-0086 notes deliberately QUOTE what they replaced, and a
    // guard that read the comments would refuse the very explanation that keeps the decision legible.
    const src = read('app/admin/work-locations/page.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(src.split('name="state"').length - 1, 'no state control on the edit row or the create form').toBe(0);
    expect(src, 'and nothing reads the column back at the operator').not.toContain('stateLabel(');
  });
});

// ─────────────────────────────── i18n: the label, in six locales ───────────────────────────────

describe('639bf4a5 — the label is "Physical Work Location", in all six locales', () => {
  it('nav.physicalWorkLocation is present and non-empty everywhere', () => {
    // ⚠️ i18n/request.ts deep-merges each locale over English, so a MISSING key renders the English string
    // rather than MISSING_MESSAGE — a render check cannot see the gap and this assertion is the only thing
    // that can.
    for (const loc of LOCALES) {
      const v = catalog(loc).nav.physicalWorkLocation;
      expect(typeof v, `${loc}: nav.physicalWorkLocation present`).toBe('string');
      expect(v!.trim().length, `${loc}: nav.physicalWorkLocation non-empty`).toBeGreaterThan(0);
    }
  });

  it('it is actually TRANSLATED in the five non-English locales', () => {
    const en = catalog('en').nav.physicalWorkLocation;
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      expect(catalog(loc).nav.physicalWorkLocation, `${loc}: differs from the English value`).not.toBe(en);
    }
  });

  it('the page title reads the same as the menu row, in every locale', () => {
    // The screen the reporter clicks and the heading they land on must be the same words; the two used to
    // disagree ("Clocking location" → a page headed "Locations"), which is how the register came to be
    // scrolled past.
    for (const loc of LOCALES) {
      const c = catalog(loc);
      expect(c.admin.locations.pageTitle, `${loc}: page title equals the nav label`).toBe(c.nav.physicalWorkLocation);
    }
  });

  it('the retired nav key is gone from all six, and nothing resolves it', () => {
    for (const loc of LOCALES) {
      expect(catalog(loc).nav.clockingLocation, `${loc}: dead nav.clockingLocation`).toBeUndefined();
    }
    expect(SIDEBAR + PACK, 'no nav row still points at the retired key').not.toContain("labelKey: 'clockingLocation'");
    expect(read('lib/permissions.ts'), 'and neither does the access matrix').not.toContain("'nav.clockingLocation'");
  });
});

// ─────────────────────────────── (c) (d) (e) — the screen still WORKS from its new route ───────────────────────────────

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

describe('639bf4a5 (c) — create, edit, archive and restore a work site, from the new route', () => {
  it('all four actions still write, and every one of them lands back on the NEW address', () => {
    // The trap this case exists for: app/admin/actions.ts builds its redirects from one `LOCATIONS`
    // constant, and a move that repointed the page but not the constant would leave every save bouncing
    // to a redirect stub — green tests, a user watching the URL flicker.
    expect(read('app/admin/actions.ts'), 'the actions read the address from the shared contract').toContain(
      'const LOCATIONS = LOCATIONS_LIST;',
    );
  });

  it('create → edit → archive → restore, each verified in the database and on the rendered list', async () => {
    const created = await runAction(createLocationAction, {
      companyId: b.companyId,
      code: 'HQ',
      name: 'Headquarters',
      country: 'MY',
      branch: '',
    });
    expect(created.startsWith(LOCATIONS_LIST), `create landed on ${created}`).toBe(true);
    expect(created, 'a successful create carries no error').not.toContain('error=');
    let rows = await listLocations(ADMIN, [b.companyId], { includeArchived: true });
    expect(rows.map((l) => l.code), 'the site was written').toEqual(['HQ']);
    const locId = rows[0].id;

    // …and it is on the screen at its new address, with its inline edit form.
    let html = await renderList();
    expect(html, 'the site renders on the relocated page').toContain('Headquarters');
    expect(html).toContain(`name="locationId" value="${locId}"`);

    const edited = await runAction(updateLocationAction, {
      locationId: locId,
      code: 'HQ',
      name: 'Head Office',
      country: 'MY',
      branch: '',
    });
    expect(edited.startsWith(LOCATIONS_LIST), `edit landed on ${edited}`).toBe(true);
    rows = await listLocations(ADMIN, [b.companyId], { includeArchived: true });
    expect(rows[0].name, 'the edit was written').toBe('Head Office');

    const archived = await runAction(archiveLocationAction, { locationId: locId });
    expect(archived.startsWith(LOCATIONS_LIST), `archive landed on ${archived}`).toBe(true);
    let [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, locId));
    expect(row.archivedAt, 'archived').not.toBeNull();

    const restored = await runAction(restoreLocationAction, { locationId: locId });
    expect(restored.startsWith(LOCATIONS_LIST), `restore landed on ${restored}`).toBe(true);
    [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, locId));
    expect(row.archivedAt, 'restored').toBeNull();

    // The register still renders both buttons, so the round trip above is reachable by a human.
    html = await renderList();
    expect(html, 'Archive is on the row').toContain('>archive<');
    expect(html, 'and the create strip is still on the card').toContain('>add<');
  });
});

describe('639bf4a5 (d) — branch mapping still proposes, and still reports what is unmapped', () => {
  /**
   * Seeded through the harness's own admin context rather than the page's: `setEmploymentInfo` gates on
   * `ctx.roles`, which the group-administrator fixture above deliberately does not carry (it carries
   * `grants`, which is what isGroupAdmin and RLS read). Hiring is not what this case is about — the
   * branch on the employment is — so it uses the context built for that job.
   */
  async function hireWithBranch(branch: string) {
    const ctx = adminCtx(b);
    const r = await hireEmployee(ctx, {
      person: { fullName: `B ${branch}`, primaryEmail: `b_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setEmploymentInfo(ctx, { employmentId: r.employmentId, orgBranch: branch });
    return r.employmentId;
  }

  it('an unmapped branch is reported, and mapping a location to it both proposes and clears the report', async () => {
    await hireWithBranch('BUKIT JALIL');

    // BEFORE: nothing claims the branch, so it is reported and nothing can be proposed.
    expect(await listUnmappedBranches(ADMIN, [b.companyId])).toEqual([
      { companyId: b.companyId, branch: 'BUKIT JALIL', headcount: 1 },
    ]);
    expect(await resolveLocationForBranch(ADMIN, b.companyId, 'BUKIT JALIL')).toBeNull();
    expect(await renderList(), 'the screen says so').toContain('unmappedBranchesHeading');

    // AFTER: the same screen's create form maps a location to it.
    const back = await runAction(createLocationAction, {
      companyId: b.companyId,
      code: 'BJ',
      name: 'Bukit Jalil',
      country: 'MY',
      branch: 'BUKIT JALIL',
    });
    expect(back.startsWith(LOCATIONS_LIST)).toBe(true);
    const proposed = await resolveLocationForBranch(ADMIN, b.companyId, 'BUKIT JALIL');
    expect(proposed, 'the Personnel Attendance tab can propose a work location again').toBeTruthy();
    expect(proposed!.code).toBe('BJ');
    expect(await listUnmappedBranches(ADMIN, [b.companyId]), 'and the gap is closed').toEqual([]);
    // BOTH DIRECTIONS on the screen: the heading was there, and now it is not — without this the assertion
    // above would pass on a page that simply never renders the block.
    expect(await renderList(), 'the heading is gone once the branch is mapped').not.toContain('unmappedBranchesHeading');
  });
});

describe('639bf4a5 (e) — clocking points still group under the work site they belong to', () => {
  it('a linked point renders under its site heading, and an unlinked one under its own', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id: gate } = await createClockingLocation(ADMIN, {
      name: 'North Gate', lat: 3.139, lng: 101.6869, radiusM: 200, locationId: loc,
    });
    await createClockingLocation(ADMIN, { name: 'Floating Point', lat: 3.14, lng: 101.69, radiusM: 200 });

    const html = await renderList();
    // The register comes first on the page (r267), so the group heading and its row are both inside it.
    const registerStart = html.indexOf('clockingHeading');
    const registerEnd = html.indexOf('name="code"');
    expect(registerStart, 'the clocking register renders').toBeGreaterThan(-1);
    expect(registerEnd, 'the per-company site register follows it').toBeGreaterThan(registerStart);
    const register = html.slice(registerStart, registerEnd);

    // GROUPING, not mere presence: the site heading must come before the point that hangs off it, and the
    // point must be inside the register rather than anywhere on the page.
    const heading = register.indexOf('HQ · Headquarters');
    const row = register.indexOf(`id="row-${gate}"`);
    expect(heading, 'the site heading is the group title').toBeGreaterThan(-1);
    expect(row, 'the point is in the register').toBeGreaterThan(-1);
    expect(heading, 'the point sits UNDER its site').toBeLessThan(row);
    expect(register, 'the unlinked point keeps its own group').toContain('unlinkedGroupTitle');
    // The way in and out of a point is the page of its own, at the NEW address.
    expect(register, 'Edit opens the relocated editor').toContain(`href="${clockingEditPage(gate)}"`);
    expect(register, 'and Add opens the relocated new page').toContain(`href="${CLOCKING_NEW_PAGE}"`);
  });
});

describe('639bf4a5 (b) — the stubs really redirect, at runtime', () => {
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

  it('the archived site still renders and can be restored from the relocated screen', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'OLD', name: 'Old Yard' });
    await archiveLocation(ADMIN, { locationId: loc });
    const html = await renderList();
    expect(html, 'an archived site is still listed — its history stays reachable').toContain('Old Yard');
    expect(html, 'with Restore rather than Archive on its row').toContain('>restore<');
  });
});
