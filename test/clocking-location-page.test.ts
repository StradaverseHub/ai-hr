/**
 * f9afd1ce rev 2 (r267) — the clocking-location page of its own, two sections, and the list that opens
 * it. The reporter contested r264 because the SCREEN did not change: a site was still one long row of
 * small boxes on the Locations page, and a new one was typed into a strip at the bottom of the card.
 *
 * TWO HALVES. The SOURCE-SHAPE half pins the promises a later round could quietly undo without any
 * behaviour test noticing (the house style of test/schedule-assignment-detail-page.test.ts): the two
 * routes on the existing `locations` screen column, the two sections in the reporter's order, the back
 * link, Save beside a Cancel LINK, the shape-checked echoes, rows that are read-only with Edit, the Add
 * button, no inline row forms, the menu row's landing. The RENDER half renders the real pages with a real
 * database (a 200 is not a render check, and neither is a source scan) and drives the two real actions
 * to their redirects: Save lands on the list at the highlighted row; a refusal stays on the page with the
 * reason and everything typed; nothing an action does can leave the Locations screens.
 *
 * ⚠️ FILE-LEVEL MOCKS: requireAdmin() is a fake returning the module-level ADMIN; redirect() and
 * notFound() throw; getTranslations echoes KEY NAMES (so server strings below are keys where they mean
 * sentences); next/headers gives the scope cookie reader an empty jar. Client islands (ConfirmSubmit)
 * call useTranslations and get the real en.json through the provider in toMarkup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { createClockingLocation, listClockingLocations } from '../core/clocking-location';
import { archiveLocation, createLocation } from '../core/location';

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
import LocationsPage from '../app/admin/locations/page';
import NewClockingLocationPage from '../app/admin/locations/clocking/new/page';
import EditClockingLocationPage from '../app/admin/locations/clocking/[id]/page';
import { createClockingLocationAction, updateClockingLocationAction } from '../app/admin/actions';
import {
  CLOCKING_FIELDS,
  CLOCKING_NEW_PAGE,
  LOCATIONS_LIST,
  clockingEditPage,
  clockingRowHref,
  readTypedClockingValues,
  typedKey,
} from '../app/admin/locations/clocking/form-fields';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const LIST = 'app/admin/locations/page.tsx';
const FORM = 'app/admin/locations/clocking/clocking-form.tsx';
const NEW = 'app/admin/locations/clocking/new/page.tsx';
const EDIT = 'app/admin/locations/clocking/[id]/page.tsx';
const ACTIONS = 'app/admin/actions.ts';
const FIELDS = 'app/admin/locations/clocking/form-fields.ts';
const NEW_ROUTE = '/admin/locations/clocking/new';
const EDIT_ROUTE = '/admin/locations/clocking/[id]';

/** The index of `needle` in `src`, asserted PRESENT first — `indexOf` gives -1 for an absent needle. */
const at = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `${JSON.stringify(needle)} is in the source`).toBeGreaterThan(-1);
  return i;
};
/** CODE only — the files' headers deliberately QUOTE what they replaced. */
const withoutComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

// ────────────────────────────────── SOURCE SHAPE ──────────────────────────────────

describe('f9afd1ce rev 2 — the two routes exist, guard themselves, and sit on the locations column', () => {
  it('both pages exist, call requireAdmin(), and are registered on the EXISTING locations screen key', () => {
    for (const rel of [NEW, EDIT]) {
      expect(fs.existsSync(path.join(root, rel)), `${rel} exists`).toBe(true);
      expect(read(rel), `${rel} guards itself`).toContain('requireAdmin()');
    }
    expect(REGISTERED_ROUTES.has(NEW_ROUTE), `${NEW_ROUTE} registered`).toBe(true);
    expect(REGISTERED_ROUTES.has(EDIT_ROUTE), `${EDIT_ROUTE} registered`).toBe(true);
    const permissions = read('lib/permissions.ts');
    const column = permissions.slice(at(permissions, "screenKey: 'locations'"), permissions.indexOf('screenKey:', at(permissions, "screenKey: 'locations'") + 1));
    expect(column, 'on the SAME column, not a new SCREENS entry').toContain(`'${NEW_ROUTE}'`);
    expect(column).toContain(`'${EDIT_ROUTE}'`);
    // No nav row: the pages are reached from the list.
    expect(read('packs/attendance/index.ts')).not.toContain('/admin/locations/clocking');
  });

  it('the menu row still opens /admin/locations (no fragment — the active predicate would never match), and the page leads with the clocking register', () => {
    // packs/attendance/index.ts: the row's href is what MODULE_OF_HREF, the active predicate and three
    // exact-set guards key on. "Lands on the clocking list" is delivered by PAGE ORDER instead.
    expect(read('packs/attendance/index.ts')).toContain("{ href: '/admin/locations', labelKey: 'clockingLocation', icon: MapPin, adminOnly: true }");
    const code = withoutComments(read(LIST));
    expect(at(code, "t('clockingHeading')"), 'the clocking register precedes the per-company holiday register').toBeLessThan(at(code, 'visible.map((c) => {'));
    expect(at(code, "t('clockingSharedTitle')")).toBeLessThan(at(code, 'action={createLocationAction}'));
    // …and the holiday register is still HERE, per company, edited inline as before: nothing moved out.
    expect(code).toContain('action={updateLocationAction}');
    expect(code).toContain('action={createLocationAction}');
    expect(code).toContain("t('pageDescription')");
  });
});

describe('f9afd1ce rev 2 — the list is for reading: Edit and Add open the page; no inline clocking form', () => {
  const code = withoutComments(read(LIST));

  it('renders no clocking inputs and posts no create / update for a site', () => {
    expect(code).not.toContain('action={createClockingLocationAction}');
    expect(code).not.toContain('action={updateClockingLocationAction}');
    // `name="name"` is ALSO the holiday register's inline box, and its archive / restore forms post a hidden
    // `locationId`; both stay. The six clocking-only fields are the tell.
    for (const field of CLOCKING_FIELDS.filter((f) => f !== 'name' && f !== 'locationId')) {
      expect(code, `the list has no ${field} box`).not.toContain(`name="${field}"`);
    }
    expect(code, 'the old create strip anchor is gone').not.toContain('clocking-form');
    expect(code, 'the list reads no addPoint any more').not.toContain('addPoint }');
  });

  it('each row is an anchor with Edit, and Archive / Restore / Delete stay on the row', () => {
    expect(code).toContain('id={`row-${cl.id}`}');
    expect(code).toContain('<Link href={clockingEditPage(cl.id)} className={btnGhost}>');
    expect(code).toContain("{t('edit')}");
    expect(code).toContain('action={archiveClockingLocationAction}');
    expect(code).toContain('action={restoreClockingLocationAction}');
    expect(code).toContain('action={deleteClockingLocationAction}');
    // The highlight follows `?focus=`, shape-checked, which is what the page's Save / Cancel / Back carry.
    expect(code).toContain('const focus = rawFocus && UUID_RE.test(rawFocus) ? rawFocus : undefined;');
    expect(code).toContain("cl.id === focus ? 'bg-muted/50'");
    expect(code, 'the saved note reads saved=1 and yields to an error').toContain('{!error && saved ? (');
    expect(code).toContain("{t('saved')}");
    // The report label chip on the row; the row still prints the NAME.
    expect(code).toContain('{cl.reportLabel && (');
    expect(code).toContain("{t('reportLabel')}");
  });

  it('Add clocking location and the empty-group link open the new page (the latter with the link pre-picked)', () => {
    expect(code).toContain('<Link href={CLOCKING_NEW_PAGE} className={btnPrimary}>');
    expect(code).toContain("{t('addClocking')}");
    expect(code).toContain('href={`${CLOCKING_NEW_PAGE}?addPoint=${g.id}`}');
    // Both gated on isGroupAdmin — the list never links a company-scoped admin to a page they cannot save from.
    expect(code).toMatch(/\{groupAdmin && \(\s*<Link href=\{CLOCKING_NEW_PAGE\}/);
  });
});

describe('f9afd1ce rev 2 — the page of its own: two sections in the reporter’s order, Back, Save beside a Cancel LINK', () => {
  const form = withoutComments(read(FORM));
  const newPage = withoutComments(read(NEW));
  const editPage = withoutComments(read(EDIT));

  it('Location information, then GPS and clocking settings — each field in its place', () => {
    expect(at(form, "t('sectionInfo')")).toBeLessThan(at(form, "t('sectionGps')"));
    const info = form.slice(at(form, "t('sectionInfo')"), at(form, "t('sectionGps')"));
    const gps = form.slice(at(form, "t('sectionGps')"));
    for (const field of ['name', 'reportLabel', 'address', 'locationId', 'remarks']) {
      expect(info, `${field} is in Location information`).toContain(`name="${field}"`);
      expect(gps, `${field} is not in GPS`).not.toContain(`name="${field}"`);
    }
    for (const field of ['lat', 'lng', 'radiusM']) {
      expect(gps, `${field} is in GPS and clocking settings`).toContain(`name="${field}"`);
      expect(info, `${field} is not in Location information`).not.toContain(`name="${field}"`);
    }
    // In the reporter's order within each section.
    expect(at(info, 'name="name"')).toBeLessThan(at(info, 'name="reportLabel"'));
    expect(at(info, 'name="reportLabel"')).toBeLessThan(at(info, 'name="address"'));
    expect(at(gps, 'name="lat"')).toBeLessThan(at(gps, 'name="lng"'));
    expect(at(gps, 'name="lng"')).toBeLessThan(at(gps, 'name="radiusM"'));
    expect(form, 'the radius is posted raw so a blank reaches the service’s sentence').toContain('name="radiusM" type="number" min={1} step={1}');
    expect(form, 'the report label hint sits under the section that holds the box').toContain("t('reportLabelHint')");
    expect(form, 'full width — pageWideCls is the pages’, the form fills it').not.toMatch(/max-w-\d*xl/);
    for (const rel of [NEW, EDIT]) expect(read(rel), `${rel} uses pageWideCls`).toContain('pageWideCls');
  });

  it('Save posts one of the two existing actions; Cancel is a LINK; the reason sits at the top of the form; the key is on the id', () => {
    expect(form).toContain("action={mode === 'edit' ? updateClockingLocationAction : createClockingLocationAction}");
    expect(form).toContain("key={clockingLocationId ?? 'new'}");
    expect(form).toMatch(/<button className=\{btnPrimary\}>\{t\('save'\)\}<\/button>/);
    expect(form).toMatch(/<Link href=\{cancelHref\}[^>]*>\s*\{t\('cancel'\)\}/);
    expect(form.match(/<form/g)?.length, 'ONE form — Cancel is not a second one').toBe(1);
    expect(form.match(/<ErrorBanner /g)?.length, 'one banner').toBe(1);
    expect(at(form, '<ErrorBanner message={error} />')).toBeLessThan(at(form, "t('sectionInfo')"));
    /**
     * fa2db8cb rev 2 (r279) — REWRITTEN, NOT DELETED. Until this round the two lines here read:
     *
     *   expect(form, 'no placeholder for the search / map that are not in this item')
     *     .not.toMatch(/leaflet|openstreetmap|<iframe|mapPreview|addressSearch/i);
     *   expect(form, 'no client island').not.toContain("'use client'");
     *
     * They held the owner's decision of 2026-09-11 — recorded in this form's own header and in ADR-0070
     * — that the screen would carry no map and no placeholder until a map provider had been chosen.
     * rev 2 REVERSES that decision: the item was approved three times and blocked twice asking the
     * reporter for a Google key that never came, so the map is built now on free, keyless open map data
     * behind a provider seam (./map-provider.ts) that a paid supplier's configuration later replaces
     * without touching this screen. A guard pinning a decision you are reversing is UPDATED, not removed
     * (CLAUDE.md §8), so the same lines now pin what replaced it — including the half of the old guard
     * that still holds, which is the important one.
     */
    expect(form, 'STILL server-rendered — the islands are separate files, this one has no client island').not.toContain("'use client'");
    expect(form, 'the search is mounted at the top of the form').toContain('<ClockingAddressSearch provider={mapProvider} />');
    expect(form, 'the map is mounted inside GPS and clocking settings').toContain('<ClockingMap provider={mapProvider} />');
    expect(at(form, '<ClockingAddressSearch'), 'the search is in Location information').toBeLessThan(at(form, "t('sectionGps')"));
    expect(at(form, '<ClockingMap'), 'the map is in GPS and clocking settings').toBeGreaterThan(at(form, 'name="radiusM"'));
    expect(form, 'the seam is resolved ONCE, on the server, from the environment').toContain('const mapProvider = resolveMapProvider(process.env);');
    /**
     * ⚠️ THE WHOLE REASON THIS ROUND WAS RISKY. r272 shipped a page that returned 500 because a server
     * component passed a FUNCTION to a client one; tsc, eslint and thirteen source guards were green.
     * Each island takes exactly ONE prop and it is the plain provider descriptor — asserted as the whole
     * prop list, so adding a second prop of any kind has to come back through this line.
     */
    const islandProps = [...form.matchAll(/<Clocking(?:AddressSearch|Map)\s+([^/>]*)\/>/g)].map((m) => m[1].trim());
    expect(islandProps, 'one serialisable prop each — nothing callable crosses the server→client boundary').toEqual([
      'provider={mapProvider}',
      'provider={mapProvider}',
    ]);
    expect(form, 'no embed: an <iframe> map is the option that still needs a key').not.toContain('<iframe');
  });

  it('both pages are headed, carry the way back to Locations, and gate the form on isGroupAdmin', () => {
    expect(newPage).toMatch(/title=\{t\('newClockingTitle'\)\}[\s\S]*?back=\{\{ href: LOCATIONS_LIST, label: t\('backToLocations'\) \}\}/);
    expect(editPage).toMatch(/title=\{t\('editClockingTitle'\)\}[\s\S]*?back=\{\{ href: listHref, label: t\('backToLocations'\) \}\}/);
    expect(editPage).toContain('const listHref = clockingRowHref(site.id);');
    expect(editPage, 'Cancel and Back land on the row').toContain('cancelHref={listHref}');
    expect(newPage).toContain('cancelHref={LOCATIONS_LIST}');
    for (const src of [newPage, editPage]) {
      expect(src).toContain('const groupAdmin = isGroupAdmin(s);');
      expect(src).toContain("t('sharedManagedByGroupAdmin')");
    }
  });

  it('[id] is shape-checked before any query; ?addPoint= is honoured by comparison only; echoes are read through the shared reader', () => {
    expect(editPage).toContain('if (!UUID_RE.test(rawId)) notFound();');
    expect(at(editPage, 'UUID_RE.test(rawId)')).toBeLessThan(at(editPage, 'listClockingLocations(s,'));
    expect(newPage).toContain("linkableLocations.some((l) => l.id === sp.addPoint) ? sp.addPoint : ''");
    for (const src of [newPage, editPage]) expect(src).toContain('...readTypedClockingValues(sp)');
    expect(editPage, 'typed values win over what is on file').toContain('{ ...onFile, ...readTypedClockingValues(sp) }');
  });
});

describe('f9afd1ce rev 2 — the actions land a save on the row and a refusal back on the page, and never leave Locations', () => {
  const code = withoutComments(read(ACTIONS));
  const createAt = at(code, 'export async function createClockingLocationAction');
  const updateAt = at(code, 'export async function updateClockingLocationAction');
  const archiveAt = at(code, 'export async function archiveClockingLocationAction');
  const create = code.slice(createAt, updateAt);
  const update = code.slice(updateAt, archiveAt);
  const helpers = code.slice(at(code, 'function clockingFieldsOf'), createAt);

  it('create refuses to the new page, update to the site’s own page; both succeed to the list at the row', () => {
    expect(create).toContain('await clockingRefused(CLOCKING_NEW_PAGE, typed, e);');
    expect(update).toContain('await clockingRefused(clockingEditPage(clockingLocationId), typed, e);');
    expect(create).toContain('await clockingSaved(saved!.id, saved!.warning);');
    expect(update).toContain('await clockingSaved(clockingLocationId, saved!.warning);');
    expect(helpers).toContain('redirect(`${LOCATIONS}?${params.toString()}#row-${id}`);');
    expect(helpers).toContain("new URLSearchParams({ saved: '1', focus: id })");
    // Every field the form posts is echoed, under the shared contract's keys.
    expect(helpers).toContain('for (const field of CLOCKING_FIELDS) params.set(typedKey(field), typed[field]);');
    expect(create, 'the report label reaches the service').toContain('reportLabel: typed.reportLabel || null');
    expect(update).toContain('reportLabel: typed.reportLabel || null');
  });

  it('the posted id is shape-checked BEFORE the service is called, and no redirect target is built from a posted url', () => {
    expect(at(update, 'UUID_RE.test(clockingLocationId)')).toBeLessThan(at(update, 'updateClockingLocation(user, {'));
    expect(update).toContain("fail(LOCATIONS, new Error('Clocking location not found'))");
    for (const src of [create, update, helpers]) {
      expect(src, 'no posted url decides where the browser goes').not.toMatch(/returnTo|fd\.get\('(?:href|url|next|redirect)'\)/);
    }
    // The contract module is what both sides read.
    expect(read(FIELDS)).toContain("export const CLOCKING_FIELDS = ['name', 'reportLabel', 'address', 'locationId', 'remarks', 'lat', 'lng', 'radiusM'] as const;");
  });

  it('the echo reader drops a malformed value and keeps a blank one', () => {
    const typed = readTypedClockingValues({
      typedName: 'HQ — North Gate',
      typedReportLabel: 'HQ',
      typedAddress: '',
      typedLocationId: 'not-a-uuid',
      typedRemarks: 'x'.repeat(2000),
      typedLat: 'abc',
      typedLng: '101.6869',
      typedRadiusM: '-5',
    });
    expect(typed).toEqual({ name: 'HQ — North Gate', reportLabel: 'HQ', address: '', lng: '101.6869' });
    expect(readTypedClockingValues({ typedLocationId: '', typedRadiusM: '' })).toEqual({ locationId: '', radiusM: '' });
    expect(typedKey('reportLabel')).toBe('typedReportLabel');
  });
});

// ────────────────────────────────── RENDER + ACTIONS ──────────────────────────────────

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
const renderList = async (sp: Record<string, string> = {}) => toMarkup(await LocationsPage({ searchParams: Promise.resolve(sp) }));
const renderNew = async (sp: Record<string, string> = {}) => toMarkup(await NewClockingLocationPage({ searchParams: Promise.resolve(sp) }));
const renderEdit = async (id: string, sp: Record<string, string> = {}) =>
  toMarkup(await EditClockingLocationPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) }));

/** Run a server action to its redirect and return where it sent the browser. */
async function runAction(action: (fd: FormData) => Promise<void>, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  LAST_REDIRECT = '';
  await expect(action(fd)).rejects.toThrow('NEXT_REDIRECT');
  return LAST_REDIRECT;
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** Strip <script> before counting — a key in the RSC payload is not a screen (CLAUDE.md §8). */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');

let b: Base;
/** A GROUP administrator (hr_admin with company_id NULL) carrying the grant, so isGroupAdmin() and RLS agree. */
async function adminFor(companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}
const HQ = { lat: 3.139, lng: 101.6869 };
const FULL = {
  name: 'HQ — North Gate',
  reportLabel: 'HQ',
  address: '1 Jalan Test, KL',
  locationId: '',
  remarks: 'main gate',
  lat: String(HQ.lat),
  lng: String(HQ.lng),
  radiusM: '150',
};

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

describe('f9afd1ce rev 2 — Save lands on the list at the row; a refusal keeps the page open with everything typed', () => {
  it('a save from the NEW page creates the site (label included) and lands on the list, highlighted', async () => {
    const back = await runAction(createClockingLocationAction, FULL);
    const site = (await listClockingLocations(ADMIN)).find((l) => l.name === FULL.name);
    expect(site, 'the site was written').toBeTruthy();
    expect(site?.reportLabel).toBe('HQ');
    expect(site?.radiusM).toBe(150);
    expect(back).toBe(`${LOCATIONS_LIST}?saved=1&focus=${site!.id}#row-${site!.id}`);
    expect(back).toBe(clockingRowHref(site!.id).replace('?focus=', '?saved=1&focus='));

    // The list renders the saved note and highlights THAT row, once.
    const html = visible(await renderList({ saved: '1', focus: site!.id }));
    expect(count(html, 'saved')).toBeGreaterThan(0);
    expect(html).toContain(`id="row-${site!.id}"`);
    expect(count(html, 'bg-muted/50'), 'exactly one row highlighted').toBe(1);
  });

  it('a save from the EDIT page updates the site and lands on its row; a radius advisory rides along as the toast', async () => {
    const { id } = await createClockingLocation(ADMIN, { name: 'Yard', lat: HQ.lat, lng: HQ.lng, radiusM: 300 });
    const back = await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: id, name: 'Yard 2', radiusM: '5' });
    expect(back.startsWith(`${LOCATIONS_LIST}?`)).toBe(true);
    expect(back).toContain('saved=1');
    expect(back).toContain(`focus=${id}`);
    expect(back).toContain('toast=radiusWarningTight');
    expect(back.endsWith(`#row-${id}`)).toBe(true);
    const [row] = await owner.db.select().from(schema.clockingLocation).where(eq(schema.clockingLocation.id, id));
    expect(row.name).toBe('Yard 2');
    expect(row.reportLabel).toBe('HQ');
    expect(row.radiusM).toBe(5);
  });

  it('a REFUSED save from the NEW page stays on the new page with the reason and every typed value — nothing written', async () => {
    const typed = { ...FULL, name: 'Refused', radiusM: '' };
    const back = await runAction(createClockingLocationAction, typed);
    expect(back.startsWith(`${CLOCKING_NEW_PAGE}?`)).toBe(true);
    const params = new URLSearchParams(back.split('?')[1]);
    expect(params.get('error')).toMatch(/Radius .* is required/);
    for (const field of CLOCKING_FIELDS) expect(params.get(typedKey(field)), `${field} echoed`).toBe(typed[field]);
    expect(back).not.toContain('saved=1');
    expect((await listClockingLocations(ADMIN)).some((l) => l.name === 'Refused')).toBe(false);

    // The page re-renders with what was TYPED, and the reason above the fields.
    const html = visible(await renderNew(Object.fromEntries(params)));
    expect(html).toContain('value="Refused"');
    expect(html).toContain('value="HQ"');
    expect(html).toContain('1 Jalan Test, KL');
    expect(html).toContain('value="main gate"');
    expect(html).toContain(`value="${HQ.lat}"`);
    expect(html).toContain('Radius');
    expect(html, 'the blank radius stays blank — nothing was invented').toMatch(/name="radiusM"[^>]*value=""/);
  });

  it('a REFUSED save from the EDIT page stays on that site’s page with typed values over what is on file', async () => {
    const { id } = await createClockingLocation(ADMIN, { name: 'On File', lat: HQ.lat, lng: HQ.lng, radiusM: 300, reportLabel: 'OF' });
    const back = await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: id, name: 'Typed Name', reportLabel: 'TN', lat: '999' });
    expect(back.startsWith(`${clockingEditPage(id)}?`)).toBe(true);
    const params = new URLSearchParams(back.split('?')[1]);
    expect(params.get('error')).toMatch(/Latitude/);
    const [row] = await owner.db.select().from(schema.clockingLocation).where(eq(schema.clockingLocation.id, id));
    expect(row.name, 'nothing was written').toBe('On File');

    const html = visible(await renderEdit(id, Object.fromEntries(params)));
    expect(html).toContain('value="Typed Name"');
    expect(html).toContain('value="TN"');
    expect(html).not.toContain('value="On File"');
    expect(html).not.toContain('value="OF"');
    // A malformed echo (999 is numeric and passes the shape; make one that does not) falls back to on file.
    const junk = visible(await renderEdit(id, { typedLat: 'north-ish', typedName: 'Still Typed' }));
    expect(junk).toContain('value="Still Typed"');
    expect(junk).toContain(`value="${HQ.lat}"`);
  });

  it('a forged posted id can send the browser nowhere but the Locations screens', async () => {
    for (const junk of ['not-a-uuid', 'https://evil.example/steal', "'; drop table clocking_location; --", '']) {
      const back = await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: junk });
      expect(back, `${JSON.stringify(junk)} lands on the list with the reason`).toBe(`${LOCATIONS_LIST}?error=${encodeURIComponent('Clocking location not found')}`);
    }
    const unknown = '00000000-0000-4000-8000-000000000000';
    const back = await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: unknown });
    expect(back.startsWith(clockingEditPage(unknown))).toBe(true);
    expect(back).toContain('error=');
  });
});

describe('f9afd1ce rev 2 — the pages render', () => {
  it('the NEW page: two section headings in order, Save, Cancel to the list, the pre-picked link, and the keyless map', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const html = visible(await renderNew({ addPoint: loc }));
    expect(count(html, 'sectionInfo')).toBe(1);
    expect(count(html, 'sectionGps')).toBe(1);
    expect(html.indexOf('sectionInfo')).toBeLessThan(html.indexOf('sectionGps'));
    expect(count(html, '>save<')).toBe(1);
    expect(html).toContain(`href="${LOCATIONS_LIST}"`);
    expect(count(html, '>cancel<')).toBe(1);
    expect(count(html, 'backToLocations</a>'), 'the way back, once').toBe(1);
    expect(html).toContain('newClockingTitle');
    expect(html).toMatch(new RegExp(`<option value="${loc}"[^>]*selected`));
    expect(html).toContain('name="reportLabel"');
    /**
     * fa2db8cb rev 2 (r279) — REWRITTEN, NOT DELETED. This line used to read
     *
     *   expect(html).not.toMatch(/leaflet|openstreetmap|<iframe/i);
     *
     * and was the RENDERED half of the pair that held the 2026-09-11 "no map here" decision (the source
     * half is in the section-order describe above, where the reasoning is written out). rev 2 reverses
     * that decision, so the same line now pins the three things the reversal actually promised, ON THE
     * PAGE rather than in the source — with NO map key set in this environment, which is the only
     * configuration production has ever had.
     */
    expect(html, 'the free supplier is credited, server-rendered: visible before Leaflet loads and still visible if it never does').toContain(
      '© OpenStreetMap contributors',
    );
    expect(html, 'the Satellite control is RENDERED and visibly DISABLED — never quietly dropped').toMatch(
      /<button type="button" disabled=""[^>]*>Satellite<\/button>/,
    );
    expect(html, '…and it says why, in the page, not only in a tooltip').toContain('Satellite view is off');
    /**
     * The fallback the whole keyless design rests on: the coordinates are still ORDINARY REQUIRED BOXES,
     * so a site can be created when the map is slow, blocked or simply not there. Read as the whole
     * <input> tag rather than as a regex across attributes — React 19 emits `name` and `value` AFTER
     * `class` on an input, so an order-sensitive pattern here pins React's internals, not the screen.
     */
    const inputTag = (field: string) => {
      const i = at(html, `name="${field}"`);
      return html.slice(html.lastIndexOf('<input', i), html.indexOf('>', i) + 1);
    };
    for (const field of ['lat', 'lng', 'radiusM']) {
      expect(inputTag(field), `${field} is still a plain typed box`).toContain('type="number"');
      expect(inputTag(field), `${field} is still required by the form itself`).toContain('required=""');
    }
    expect(html, 'still no embed — an <iframe> map needs the key that does not exist').not.toContain('<iframe');
    // A junk or unknown addPoint pre-picks nothing.
    const plain = visible(await renderNew({ addPoint: 'not-a-uuid' }));
    expect(plain).not.toMatch(/<option value="[0-9a-f-]{36}"[^>]*selected/);
  });

  it('the EDIT page: what is on file, Back and Cancel to the row, hidden id; junk and unknown ids are notFound()', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id } = await createClockingLocation(ADMIN, { name: 'Gate A', lat: HQ.lat, lng: HQ.lng, radiusM: 200, locationId: loc, reportLabel: 'GA', address: 'Lot 1' });
    const html = visible(await renderEdit(id));
    expect(html).toContain('editClockingTitle');
    expect(html).toContain('value="Gate A"');
    expect(html).toContain('value="GA"');
    expect(html).toContain('Lot 1');
    expect(html).toContain('value="200"');
    expect(html).toContain(`<input type="hidden" name="clockingLocationId" value="${id}"`);
    expect(html).toMatch(new RegExp(`<option value="${loc}"[^>]*selected`));
    // Back and Cancel both land on the row (renderToStaticMarkup escapes & in attributes; there is none here).
    expect(count(html, `href="${clockingRowHref(id)}"`)).toBe(2);
    expect(count(html, 'sectionInfo')).toBe(1);
    expect(count(html, 'sectionGps')).toBe(1);

    for (const junk of ['not-a-uuid', "'; drop table clocking_location; --", id.slice(0, -1)]) {
      await expect(renderEdit(junk), `${junk} never reaches SQL`).rejects.toThrow('NEXT_NOT_FOUND');
    }
    await expect(renderEdit('00000000-0000-4000-8000-000000000000')).rejects.toThrow('NEXT_NOT_FOUND');

    // An archived link the picker cannot offer stays selected rather than silently unlinking on Save.
    await archiveLocation(ADMIN, { locationId: loc });
    const archived = visible(await renderEdit(id));
    expect(archived).toMatch(new RegExp(`<option value="${loc}"[^>]*selected`));
    expect(archived).toContain('statusArchived');
  });

  it('the LIST as a group admin: read rows with Edit, the Add button, the label chip, no inline boxes; the clocking register first', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id: a } = await createClockingLocation(ADMIN, { name: 'Gate A', lat: HQ.lat, lng: HQ.lng, radiusM: 200, locationId: loc, reportLabel: 'GA' });
    const { id: c } = await createClockingLocation(ADMIN, { name: 'Gate C', lat: HQ.lat, lng: HQ.lng, radiusM: 200 });
    const { id: empty } = await createLocation(ADMIN, { companyId: b.companyId, code: 'YARD', name: 'Yard' });
    const html = visible(await renderList());
    expect(count(html, `href="${clockingEditPage(a)}"`)).toBe(1);
    expect(count(html, `href="${clockingEditPage(c)}"`)).toBe(1);
    expect(count(html, '>edit<')).toBe(2);
    expect(count(html, `href="${CLOCKING_NEW_PAGE}"`)).toBe(1);
    expect(count(html, 'addClocking')).toBe(1);
    expect(html).toContain(`href="${CLOCKING_NEW_PAGE}?addPoint=${empty}"`);
    expect(html).toContain(`id="row-${a}"`);
    expect(html, 'the label chip on the row').toContain('reportLabel</span> GA<');
    expect(html).toContain('Gate A');
    for (const field of ['lat', 'lng', 'radiusM', 'reportLabel']) expect(html, `no ${field} box on the list`).not.toContain(`name="${field}"`);
    expect(html.indexOf('clockingHeading'), 'the clocking register precedes the company card').toBeLessThan(html.indexOf('name="code"'));
    // Archive / Delete stay on the row — counted INSIDE the clocking register (the holiday register below
    // has Archive buttons of its own).
    const clocking = html.slice(html.indexOf('clockingHeading'), html.indexOf('name="code"'));
    expect(count(clocking, '>archive<')).toBe(2);
    expect(count(clocking, '>edit<')).toBe(2);
    expect(count(clocking, 'delete'), 'Delete (the mocked translator echoes the key) on each row').toBeGreaterThanOrEqual(2);
  });

  it('the LIST and the pages as a COMPANY-SCOPED admin: no Edit, no Add, no form — a View instead', async () => {
    const { id } = await createClockingLocation(ADMIN, { name: 'Gate B', lat: HQ.lat, lng: HQ.lng, radiusM: 200, reportLabel: 'GB' });
    ADMIN = await adminFor(b.companyId);
    const list = visible(await renderList());
    expect(list).toContain('sharedManagedByGroupAdmin');
    /**
     * r272 (0e8cf366) — UPDATED. This asserted the edit page's URL was ABSENT from the list, which was
     * true only because nothing linked to it: a company-scoped admin could see a site on the list and had
     * no way to open it, while `clocking/[id]/page.tsx` has always rendered them a read-only fact list.
     * They now get a View.
     *
     * The subject of this test is unchanged and still asserted: no EDIT control, no Add, and no form at
     * the destination — the loop below proves the last of those directly, which is why linking the URL is
     * safe. What is forbidden is the affordance to change something, not the ability to read it.
     */
    expect(list, 'no Edit control for this role').not.toContain('>edit<');
    expect(list, 'and it is a View that links there').toContain('>view<');
    expect(list).toContain(clockingEditPage(id));
    expect(list).not.toContain(`href="${CLOCKING_NEW_PAGE}"`);
    expect(list).toContain('Gate B');
    expect(list).toContain('reportLabel</span> GB<');
    for (const page of [await renderNew(), await renderEdit(id)]) {
      const html = visible(page);
      expect(html).toContain('sharedManagedByGroupAdmin');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('name="name"');
    }
    expect(visible(await renderEdit(id))).toContain('Gate B');
  });
});
