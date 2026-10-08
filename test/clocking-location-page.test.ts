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
 * r423 (83c0d3c8) — REWRITTEN AROUND THE NEW SCREENS, property by property. Attendance › Locations is the
 * CLOCKING location list now (app/admin/work-locations/clocking/page.tsx: search, Company and Status
 * filters, the plan's eight columns, View / Edit / Deactivate); View is a read-only page (clocking/[id]) and
 * Edit is the form (clocking/[id]/edit); the form is in the reporter's order (Location Name first — this
 * REVERSES r335's "Name below the coordinates", which the cases below used to pin) with Companies and
 * Status sections; and EVERY way out lands on the clocking list, never on a work location's screen (the
 * r338 "a point goes home to its site" rule is reversed). What did not change and is still pinned: the
 * routes guard themselves on the `locations` column, one form with Save beside a Cancel LINK, the islands
 * take one serialisable prop, the posted id is shape-checked, a refusal echoes everything typed, the
 * hidden work-location link survives a plain Save, and a company-scoped admin gets no write affordance.
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
import NewClockingLocationPage from '../app/admin/work-locations/clocking/new/page';
import EditClockingLocationPage from '../app/admin/work-locations/clocking/[id]/edit/page';
import ViewClockingLocationPage from '../app/admin/work-locations/clocking/[id]/page';
import ClockingListPage from '../app/admin/work-locations/clocking/page';
import EditLocationPage from '../app/admin/work-locations/[id]/edit/page';
import { createClockingLocationAction, updateClockingLocationAction } from '../app/admin/actions';
import {
  CLOCKING_FIELDS,
  CLOCKING_LIST,
  CLOCKING_NEW_PAGE,
  TYPED_COMPANY_IDS,
  clockingEditPage,
  clockingFocusHref,
  clockingViewPage,
  readTypedClockingValues,
  readTypedCompanyIds,
  typedKey,
} from '../app/admin/work-locations/clocking/form-fields';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * r423 — the files this test reads. `LIST` is Attendance › Locations; `REGISTER` and `LOCATION_EDIT` are the
 * WORK location screens, read only to assert that no clocking location is shown under them any more.
 */
const LIST = 'app/admin/work-locations/clocking/page.tsx';
const LOCATION_EDIT = 'app/admin/work-locations/[id]/edit/page.tsx';
const LOCATION_VIEW = 'app/admin/work-locations/[id]/page.tsx';
const REGISTER = 'app/admin/work-locations/page.tsx';
const FORM = 'app/admin/work-locations/clocking/clocking-form.tsx';
const NEW = 'app/admin/work-locations/clocking/new/page.tsx';
const EDIT = 'app/admin/work-locations/clocking/[id]/edit/page.tsx';
const VIEW = 'app/admin/work-locations/clocking/[id]/page.tsx';
const ACTIONS = 'app/admin/actions.ts';
const FIELDS = 'app/admin/work-locations/clocking/form-fields.ts';
const NEW_ROUTE = '/admin/work-locations/clocking/new';
const VIEW_ROUTE = '/admin/work-locations/clocking/[id]';
const EDIT_ROUTE = '/admin/work-locations/clocking/[id]/edit';

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

describe('r423 — the routes exist, guard themselves, and sit on the locations column', () => {
  it('list, new, view and edit exist, call requireAdmin(), and are registered on the EXISTING locations screen key', () => {
    for (const rel of [LIST, NEW, VIEW, EDIT]) {
      expect(fs.existsSync(path.join(root, rel)), `${rel} exists`).toBe(true);
      expect(read(rel), `${rel} guards itself`).toContain('requireAdmin()');
    }
    for (const route of [CLOCKING_LIST, NEW_ROUTE, VIEW_ROUTE, EDIT_ROUTE]) {
      expect(REGISTERED_ROUTES.has(route), `${route} registered`).toBe(true);
    }
    const permissions = read('lib/permissions.ts');
    const start = at(permissions, "screenKey: 'locations'");
    const column = permissions.slice(start, permissions.indexOf('screenKey:', start + 1));
    expect(column.length).toBeGreaterThan(200);
    for (const route of [CLOCKING_LIST, NEW_ROUTE, VIEW_ROUTE, EDIT_ROUTE]) {
      expect(column, `${route} on the SAME column, not a new SCREENS entry`).toContain(`'${route}'`);
    }
    expect(column, 'the column’s href follows the "Locations" function to the clocking list').toContain(
      "href: '/admin/work-locations/clocking',",
    );
    expect(permissions, 'and no second screenKey was minted for Work Locations').not.toContain("screenKey: 'workLocations'");
  });

  /**
   * r423 REVERSES r338's "Locations opens the company listing": the reporter asked for clocking locations to
   * be set up location-first, so "Locations" opens the clocking list and the company listing has a row of
   * its own, "Work Locations". Exactly one row each across the rail's two sources, no `#fragment` on either
   * (the active predicate splits on `?` only), and the clocking row is the more specific href so the flyout's
   * longest-match rule lights the right one.
   */
  it('the menu: "Locations" opens the clocking list, "Work Locations" the company listing, one row each', () => {
    const sidebar = read('components/sidebar.tsx');
    const pack = read('packs/attendance/index.ts');
    expect(pack).toContain("{ href: '/admin/work-locations/clocking', labelKey: 'locations', icon: MapPin, adminOnly: true }");
    expect(pack).toContain("{ href: '/admin/work-locations', labelKey: 'workLocations', icon: Building2, adminOnly: true }");
    expect((sidebar + pack).split("href: '/admin/work-locations/clocking'").length - 1).toBe(1);
    expect((sidebar + pack).split("href: '/admin/work-locations'").length - 1).toBe(1);
    expect(pack, 'no row for the forms — they are reached from the list').not.toContain("'/admin/work-locations/clocking/new'");
    expect(pack, 'the label key it carried before r336 is still retired').not.toContain("labelKey: 'clockingLocation',");
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as { nav: Record<string, string> };
      expect(m.nav.workLocations, `${loc} nav.workLocations`).toBeTruthy();
      expect(m.nav.workLocations, `${loc}: the two rows read differently`).not.toBe(m.nav.locations);
    }
  });
});

describe('r423 — the list: the plan’s columns, filters, and row actions; no inline clocking form anywhere', () => {
  const list = withoutComments(read(LIST));
  const register = withoutComments(read(REGISTER));
  const locationEdit = withoutComments(read(LOCATION_EDIT));
  const locationView = withoutComments(read(LOCATION_VIEW));

  it('the eight columns in the plan’s order', () => {
    const cols = ['locationName', 'address', 'colState', 'gpsCoordinates', 'geofencingRadius', 'colCompanies', 'colStatus', 'colActions'];
    const measured = cols.map((c) => ({ c, at: at(list, `<th className={`) && at(list, `{t('${c}')}</th>`) })).sort((a, b) => a.at - b.at).map((x) => x.c);
    expect(measured, `the header order, as measured: ${measured.join(' → ')}`).toEqual(cols);
  });

  it('a GET filter form: search (name or address), Company, Status All / Active / Inactive', () => {
    expect(list).toContain('<form method="get" action={CLOCKING_LIST}');
    expect(list).toContain('name="q"');
    expect(list).toContain('name="company"');
    expect(list).toContain('name="status"');
    for (const v of ['all', 'active', 'inactive']) expect(list).toContain(`<option value="${v}">`);
    expect(list, '?company= is honoured only when it names a company the caller administers').toContain(
      "companies.some((c) => c.id === one('company')) ? one('company') : ''",
    );
    expect(list).toContain('listClockingLocations(s, { status, q, companyId: companyId || undefined })');
  });

  it('row actions: View for everyone; Edit and Deactivate (asks first, with the count) or Activate for a group admin', () => {
    expect(list).toContain('id={`row-${cl.id}`}');
    expect(list).toContain("cl.id === focus && 'bg-muted/50'");
    const view = at(list, 'href={clockingViewPage(cl.id)}');
    const gate = at(list, '{groupAdmin && (');
    expect(view).toBeLessThan(gate);
    const admin = list.slice(gate);
    expect(admin).toContain('href={clockingEditPage(cl.id)}');
    expect(admin).toContain('action={archiveClockingLocationAction}');
    expect(admin).toContain('action={restoreClockingLocationAction}');
    expect(admin).toContain("description={t('deactivateConfirmDescription', { name: cl.name, count: cl.assignedCount })}");
    expect(admin).toContain("{t('activate')}");
    expect(list, 'the New button is a group admin’s').toMatch(/groupAdmin \? \(\s*<Link href=\{CLOCKING_NEW_PAGE\} className=\{btnPrimary\}>/);
  });

  it('no screen renders a clocking input or posts a clocking create / update except the form itself', () => {
    for (const [name, code] of [['list', list], ['register', register], ['location edit', locationEdit], ['location view', locationView]] as const) {
      expect(code, `${name} posts no clocking create`).not.toContain('action={createClockingLocationAction}');
      expect(code, `${name} posts no clocking update`).not.toContain('action={updateClockingLocationAction}');
      for (const field of ['lat', 'lng', 'radiusM', 'reportLabel', 'companyIds']) {
        expect(code, `${name} has no ${field} box`).not.toContain(`name="${field}"`);
      }
    }
  });

  it('the work location screens show no clocking location at all any more (r423 reverses r338)', () => {
    for (const [name, code] of [['register', register], ['location edit', locationEdit], ['location view', locationView]] as const) {
      expect(code, `${name} reads no clocking register`).not.toContain('listClockingLocations');
      expect(code, `${name} renders no clocking rows`).not.toContain('ClockingPointRows');
      expect(code, `${name} offers no "Add a clocking point"`).not.toContain("t('addPointCta')");
      expect(code, `${name} links to no clocking editor`).not.toContain('clockingEditPage');
    }
    expect(fs.existsSync(path.join(root, 'app/admin/work-locations/clocking-points.tsx')), 'the row component is gone').toBe(false);
    expect(register).toContain("title={t('workLocationsTitle')}");
  });
});

describe('r423 — the form: the reporter’s order, Companies and Status, Back, Save beside a Cancel LINK', () => {
  const form = withoutComments(read(FORM));
  const newPage = withoutComments(read(NEW));
  const editPage = withoutComments(read(EDIT));

  /**
   * r423 REVERSES the r335 order that stood here (search → address → coordinates → radius → Name → …): the
   * reporter asked for the location to be created first, in this order — Location Name; Find an address;
   * Address; State; Latitude and Longitude; the map; Geofencing Radius; Companies; Status — with Report label
   * and Remarks at the bottom as optional. ORDER, not presence: every field but three existed before.
   * (The radius box sits beside Latitude and Longitude and above the map, which reads it, so the picture
   * is never separated from the three numbers it draws.)
   */
  it('the reporter’s order, field by field', () => {
    const order = [
      'name="name"',
      '<ClockingAddressSearch',
      'name="address"',
      'name="state"',
      'name="lat"',
      'name="lng"',
      'name="radiusM"',
      '<ClockingMap',
      'name="companyIds"',
      'name="status" value="active"',
      'name="status" value="inactive"',
      'name="reportLabel"',
      'name="remarks"',
      'name="locationId"',
    ];
    const measured = order.map((needle) => ({ needle, at: at(form, needle) })).sort((a, b) => a.at - b.at).map((x) => x.needle);
    expect(measured, `the source order, as measured: ${measured.join(' → ')}`).toEqual(order);
    expect(form, 'the retired heading is not rendered anywhere').not.toContain("t('sectionInfo')");
    for (const h of ['sectionLocation', 'sectionGps', 'sectionCompanies', 'sectionStatus', 'sectionOptional']) {
      expect(form, h).toContain(`title={t('${h}')}`);
    }
    // Nothing posted sits between the search and the first box it fills.
    expect(form.slice(at(form, '<ClockingAddressSearch'), at(form, 'name="address"'))).not.toMatch(/\sname="/);
    expect(form, 'the radius is posted raw so a blank reaches the service’s sentence').toContain('name="radiusM" type="number" min={1} step={1}');
    expect(form, 'companies are one checkbox each, posting one entry per tick').toContain(
      '<input type="checkbox" name="companyIds" value={c.id} defaultChecked={ticked.has(c.id)}',
    );
    expect(form).toContain("<option value=\"\">{t('stateNone')}</option>");
    expect(form, 'full width — pageWideCls is the pages’, the form fills it').not.toMatch(/max-w-\d*xl/);
    for (const rel of [NEW, EDIT]) expect(read(rel), `${rel} uses pageWideCls`).toContain('pageWideCls');
  });

  it('Save posts one of the two existing actions; Cancel is a LINK; one form; the islands take one plain prop each', () => {
    expect(form).toContain("action={mode === 'edit' ? updateClockingLocationAction : createClockingLocationAction}");
    expect(form).toContain("key={clockingLocationId ?? 'new'}");
    expect(form).toMatch(/<button className=\{btnPrimary\}>\{t\('save'\)\}<\/button>/);
    expect(form).toMatch(/<Link href=\{cancelHref\}[^>]*>\s*\{t\('cancel'\)\}/);
    expect(form.match(/<form/g)?.length, 'ONE form — Cancel is not a second one').toBe(1);
    expect(form.match(/<ErrorBanner /g)?.length, 'one banner').toBe(1);
    expect(at(form, '<ErrorBanner message={error} />'), 'the reason sits above the fields').toBeLessThan(at(form, 'name="name"'));
    expect(form, 'STILL server-rendered — the islands are separate files').not.toContain("'use client'");
    // r272 shipped a 500 passing a FUNCTION to a client component; each island still takes ONE plain prop.
    const islandProps = [...form.matchAll(/<Clocking(?:AddressSearch|Map)\s+([^/>]*)\/>/g)].map((m) => m[1].trim());
    expect(islandProps).toEqual(['provider={mapProvider}', 'provider={mapProvider}']);
    expect(form).toContain('const mapProvider = resolveMapProvider(process.env);');
    expect(form, 'no embed: the framed third-party map is the option that still needs a key').not.toContain('<ifr' + 'ame');
  });

  it('both pages are headed, Back and Cancel go to the clocking list, and only a group admin gets a form', () => {
    expect(newPage).toMatch(/title=\{t\('newClockingTitle'\)\}[\s\S]*?back=\{\{ href: CLOCKING_LIST, label: t\('backToLocations'\) \}\}/);
    expect(newPage).toContain('cancelHref={CLOCKING_LIST}');
    expect(editPage).toMatch(/title=\{t\('editClockingTitle'\)\}[\s\S]*?back=\{\{ href: listHref, label: t\('backToLocations'\) \}\}/);
    expect(editPage).toContain('const listHref = clockingFocusHref(site.id);');
    expect(editPage).toContain('cancelHref={listHref}');
    expect(newPage).toContain('const groupAdmin = isGroupAdmin(s);');
    expect(newPage).toContain("t('sharedManagedByGroupAdmin')");
    expect(editPage, 'a non-group-admin is sent to the read-only View').toContain('if (!isGroupAdmin(s)) redirect(clockingViewPage(site.id));');
    expect(newPage, 'the r338 "add a point under this work location" entry is gone').not.toContain('addPoint');
  });

  it('[id] is shape-checked before any query; echoes are read through the shared readers', () => {
    for (const src of [editPage, withoutComments(read(VIEW))]) {
      expect(src).toContain('if (!UUID_RE.test(rawId)) notFound();');
      expect(at(src, 'UUID_RE.test(rawId)')).toBeLessThan(at(src, 'listClockingLocations(s,'));
    }
    for (const src of [newPage, editPage]) {
      expect(src).toContain('...readTypedClockingValues(sp)');
      expect(src).toContain('readTypedCompanyIds(sp)');
    }
    expect(editPage, 'typed values win over what is on file').toContain('{ ...onFile, ...readTypedClockingValues(sp) }');
    expect(editPage).toContain('readTypedCompanyIds(sp) ?? site.companies.map((c) => c.id)');
  });
});

describe('r423 — the actions land on the clocking list and never leave the Locations screens', () => {
  const code = withoutComments(read(ACTIONS));
  const createAt = at(code, 'export async function createClockingLocationAction');
  const updateAt = at(code, 'export async function updateClockingLocationAction');
  const archiveAt = at(code, 'export async function archiveClockingLocationAction');
  const create = code.slice(createAt, updateAt);
  const update = code.slice(updateAt, archiveAt);
  const helpers = code.slice(at(code, 'function clockingFieldsOf'), createAt);
  const rowActions = code.slice(archiveAt, at(code, 'export async function deleteClockingLocationAction') + 600);

  it('create refuses to the new page, update to the edit page; both succeed to the list at the row', () => {
    expect(create).toContain('await clockingRefused(CLOCKING_NEW_PAGE, typed, companyIds, e);');
    expect(update).toContain('await clockingRefused(clockingEditPage(clockingLocationId), typed, companyIds, e);');
    expect(create).toContain('await clockingSaved(saved!.id, saved!.warning);');
    expect(update).toContain('await clockingSaved(clockingLocationId, saved!.warning);');
    expect(helpers).toContain('redirect(`${CLOCKING_LIST}?${params.toString()}#row-${id}`);');
    expect(helpers).toContain("new URLSearchParams({ saved: '1', focus: id })");
    expect(helpers).toContain('for (const field of CLOCKING_FIELDS) params.set(typedKey(field), typed[field]);');
    expect(helpers).toContain("params.set(TYPED_COMPANY_IDS, companyIds.filter((id) => UUID_RE.test(id)).join(','));");
    for (const src of [create, update]) {
      expect(src).toContain('reportLabel: typed.reportLabel || null');
      expect(src).toContain('companyIds,');
      expect(src).toContain('state: typed.state || null');
    }
    expect(create).toContain("active: typed.status !== 'inactive'");
    expect(helpers, 'the two company refusals in the admin’s words').toContain("t('companyInUse', { count: e.count, companies: e.companyNames.join(', ') })");
    expect(helpers).toContain("t('companiesRequired')");
    for (const verb of ['archive', 'restore', 'delete']) expect(rowActions, verb).toContain('CLOCKING_LIST');
    expect(code, 'the r338 "home is the work location" helper is gone').not.toContain('clockingPointBase');
  });

  it('the posted id is shape-checked BEFORE the service is called, and no redirect target is built from a posted url', () => {
    expect(at(update, 'UUID_RE.test(clockingLocationId)')).toBeLessThan(at(update, 'updateClockingLocation(user, {'));
    expect(update).toContain("fail(CLOCKING_LIST, new Error('Clocking location not found'))");
    for (const src of [create, update, helpers]) {
      expect(src, 'no posted url decides where the browser goes').not.toMatch(/returnTo|fd\.get\('(?:href|url|next|redirect)'\)/);
    }
    expect(read(FIELDS)).toContain(
      "export const CLOCKING_FIELDS = ['name', 'reportLabel', 'address', 'locationId', 'remarks', 'lat', 'lng', 'radiusM', 'state', 'status'] as const;",
    );
  });

  it('the echo readers drop a malformed value and keep a blank one', () => {
    const typed = readTypedClockingValues({
      typedName: 'HQ — North Gate',
      typedReportLabel: 'HQ',
      typedAddress: '',
      typedLocationId: 'not-a-uuid',
      typedRemarks: 'x'.repeat(2000),
      typedLat: 'abc',
      typedLng: '101.6869',
      typedRadiusM: '-5',
      typedState: 'Selangor',
      typedStatus: 'archived',
    });
    expect(typed).toEqual({ name: 'HQ — North Gate', reportLabel: 'HQ', address: '', lng: '101.6869', state: 'Selangor' });
    expect(readTypedClockingValues({ typedLocationId: '', typedRadiusM: '' })).toEqual({ locationId: '', radiusM: '' });
    expect(typedKey('reportLabel')).toBe('typedReportLabel');
    const ok = '00000000-0000-4000-8000-000000000000';
    expect(readTypedCompanyIds({ [TYPED_COMPANY_IDS]: `${ok},junk` })).toEqual([ok]);
    expect(readTypedCompanyIds({ [TYPED_COMPANY_IDS]: '' })).toEqual([]);
    expect(readTypedCompanyIds({})).toBeNull();
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
const renderLocationEdit = async (id: string, sp: Record<string, string> = {}) =>
  toMarkup(await EditLocationPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) }));
const renderList = async (sp: Record<string, string> = {}) => toMarkup(await ClockingListPage({ searchParams: Promise.resolve(sp) }));
const renderView = async (id: string) => toMarkup(await ViewClockingLocationPage({ params: Promise.resolve({ id }) }));
const renderNew = async (sp: Record<string, string> = {}) => toMarkup(await NewClockingLocationPage({ searchParams: Promise.resolve(sp) }));
const renderEdit = async (id: string, sp: Record<string, string> = {}) =>
  toMarkup(await EditClockingLocationPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) }));

/** Run a server action to its redirect and return where it sent the browser. `companyIds` posts one entry each. */
async function runAction(action: (fd: FormData) => Promise<void>, fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  LAST_REDIRECT = '';
  await expect(action(fd)).rejects.toThrow('NEXT_REDIRECT');
  return LAST_REDIRECT;
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** The whole <input …> tag containing `needle` — React's attribute order is not the screen's business. */
const inputTag = (html: string, needle: string) => {
  // Every fragment of `needle` (split on spaces between attributes) must be in ONE <input> tag, in any order.
  const parts = needle.match(/\S+="[^"]*"/g) ?? [needle];
  const tags = html.match(/<input[^>]*>/g) ?? [];
  const hit = tags.filter((tag) => parts.every((p) => tag.includes(p)));
  expect(hit.length, `exactly one <input> carries ${needle}`).toBe(1);
  return hit[0];
};
/** Strip <script> before counting — a key in the RSC payload is not a screen (CLAUDE.md §8). */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');

/**
 * THE ORDER OF THE CONTROLS IN THE MARKUP — r423's order (the reporter's), measured on the rendered page.
 * ORDER, NEVER PRESENCE; the measured sequence goes in the failure message. The search box is anchored on its
 * accessible label read out of en.json (the island resolves its own text through the real catalogue).
 */
const EN_LOCATIONS = (JSON.parse(read('messages/en.json')) as { admin: { locations: Record<string, string> } }).admin.locations;
function assertClockingOrder(html: string): void {
  const marks: [string, string][] = [
    ['Location Name', 'name="name"'],
    ['the address search', `aria-label="${EN_LOCATIONS.addressSearchLabel}"`],
    ['Address', 'name="address"'],
    ['State', 'name="state"'],
    ['Latitude', 'name="lat"'],
    ['Longitude', 'name="lng"'],
    ['Geofencing Radius', 'name="radiusM"'],
    ['Companies', 'name="companyIds"'],
    ['Status', 'name="status"'],
    ['Report label', 'name="reportLabel"'],
    ['Remarks', 'name="remarks"'],
  ];
  const found = marks.map(([label, needle]) => {
    const i = html.indexOf(needle);
    expect(i, `${label} (${needle}) is on the rendered page`).toBeGreaterThan(-1);
    return { label, at: i };
  });
  const measured = [...found].sort((a, b) => a.at - b.at).map((f) => f.label);
  expect(measured, `the rendered order is: ${measured.join(' → ')}`).toEqual(marks.map(([label]) => label));
}

/**
 * 0fe1ca2e rev 6 (r335) — WHAT THE MOVED FORM ACTUALLY POSTS, read off the rendered markup rather than off
 * the source. Re-ordering nine controls by hand is precisely how one gets dropped or duplicated, and
 * neither tsc nor the order guard above would notice: a form that silently stopped posting `remarks`
 * still renders its eight remaining boxes in the right sequence. Asserted as a SET EQUAL to
 * CLOCKING_FIELDS — `clockingLocationId` is the route's own hidden id, not one of the eight, and the
 * search box is deliberately unnamed so it never appears here at all.
 */
function assertPostedFields(html: string, opts: { linked: boolean }): void {
  const open = html.lastIndexOf('<form', html.indexOf('sectionGps'));
  expect(open, 'the form is on the page').toBeGreaterThan(-1);
  const form = html.slice(open, html.indexOf('</form>', open));
  const posted = [...new Set([...form.matchAll(/\sname="([^"]+)"/g)].map((m) => m[1]))].filter((n) => n !== 'clockingLocationId');
  // r423 — the single-valued fields plus the companies; the work-location link is posted only when one exists.
  const expected = [...CLOCKING_FIELDS.filter((f) => opts.linked || f !== 'locationId'), 'companyIds'].sort();
  expect([...posted].sort(), `the form posts: ${posted.join(', ')}`).toEqual(expected);
}

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
let FULL: Record<string, string | string[]>;
const fullFor = (companyId: string) => ({
  name: 'HQ — North Gate',
  reportLabel: 'HQ',
  address: '1 Jalan Test, KL',
  locationId: '',
  remarks: 'main gate',
  lat: String(HQ.lat),
  lng: String(HQ.lng),
  radiusM: '150',
  state: 'Selangor',
  status: 'active',
  companyIds: [companyId],
});
/** r423 — the service now requires the companies; the cases below open sites to the base company. */
const mkSite = (p: Omit<Parameters<typeof createClockingLocation>[1], 'companyIds'> & { companyIds?: string[] }) =>
  createClockingLocation(ADMIN, { companyIds: [b.companyId], ...p });

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
  FULL = fullFor(b.companyId);
});

describe('r423 — Save lands on the clocking list at the row; a refusal keeps the page open with everything typed', () => {
  it('a save from the NEW page creates the location (companies, state, label) and lands on the list, highlighted', async () => {
    const back = await runAction(createClockingLocationAction, FULL);
    const site = (await listClockingLocations(ADMIN)).find((l) => l.name === 'HQ — North Gate');
    expect(site, 'the location was written').toBeTruthy();
    expect(site?.reportLabel).toBe('HQ');
    expect(site?.radiusM).toBe(150);
    expect(site?.state).toBe('Selangor');
    expect(site?.companies.map((c) => c.id)).toEqual([b.companyId]);
    expect(back).toBe(`${CLOCKING_LIST}?saved=1&focus=${site!.id}#row-${site!.id}`);

    const html = visible(await renderList({ saved: '1', focus: site!.id }));
    expect(html).toContain('saved');
    expect(html).toContain(`id="row-${site!.id}"`);
    expect(count(html, 'bg-muted/50'), 'exactly one row highlighted').toBe(1);
  });

  it('a LINKED save ALSO lands on the clocking list — never on the work location’s screen (r423 reverses r338)', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const back = await runAction(createClockingLocationAction, { ...FULL, name: 'Linked Gate', locationId: loc });
    const site = (await listClockingLocations(ADMIN)).find((l) => l.name === 'Linked Gate');
    expect(back).toBe(`${CLOCKING_LIST}?saved=1&focus=${site!.id}#row-${site!.id}`);
    const work = visible(await renderLocationEdit(loc));
    expect(work, 'the work location screen shows no clocking location').not.toContain('Linked Gate');
  });

  it('a save from the EDIT page updates the location and lands on its row; a radius advisory rides along as the toast', async () => {
    const { id } = await mkSite({ name: 'Yard', lat: HQ.lat, lng: HQ.lng, radiusM: 300 });
    const back = await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: id, name: 'Yard 2', radiusM: '5', status: 'inactive' });
    expect(back.startsWith(`${CLOCKING_LIST}?`)).toBe(true);
    expect(back).toContain('saved=1');
    expect(back).toContain('toast=radiusWarningTight');
    expect(back.endsWith(`#row-${id}`)).toBe(true);
    const [row] = await owner.db.select().from(schema.clockingLocation).where(eq(schema.clockingLocation.id, id));
    expect(row.name).toBe('Yard 2');
    expect(row.radiusM).toBe(5);
    expect(row.archivedAt, 'the Status radio deactivated it').not.toBeNull();
  });

  it('a REFUSED save from the NEW page stays on the new page with the reason and every typed value — nothing written', async () => {
    const typed: Record<string, string | string[]> = { ...FULL, name: 'Refused', radiusM: '' };
    const back = await runAction(createClockingLocationAction, typed);
    expect(back.startsWith(`${CLOCKING_NEW_PAGE}?`)).toBe(true);
    const params = new URLSearchParams(back.split('?')[1]);
    expect(params.get('error')).toMatch(/Radius .* is required/);
    for (const field of CLOCKING_FIELDS) expect(params.get(typedKey(field)), `${field} echoed`).toBe(typed[field]);
    expect(params.get(TYPED_COMPANY_IDS)).toBe(b.companyId);
    expect((await listClockingLocations(ADMIN)).some((l) => l.name === 'Refused')).toBe(false);

    const html = visible(await renderNew(Object.fromEntries(params)));
    expect(html).toContain('value="Refused"');
    expect(html).toContain('1 Jalan Test, KL');
    expect(html, 'the blank radius stays blank — nothing was invented').toMatch(/name="radiusM"[^>]*value=""/);
    expect(inputTag(html, `name="companyIds" value="${b.companyId}"`), 'the ticked company stays ticked').toContain('checked=""');
  });

  it('no company ticked is refused in the admin’s words', async () => {
    const back = await runAction(createClockingLocationAction, { ...FULL, name: 'Nobody', companyIds: [] });
    expect(new URLSearchParams(back.split('?')[1]).get('error')).toBe('companiesRequired');
  });

  it('a REFUSED save from the EDIT page stays on that location’s edit page with typed values over what is on file', async () => {
    const { id } = await mkSite({ name: 'On File', lat: HQ.lat, lng: HQ.lng, radiusM: 300, reportLabel: 'OF' });
    const back = await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: id, name: 'Typed Name', reportLabel: 'TN', lat: '999' });
    expect(back.startsWith(`${clockingEditPage(id)}?`)).toBe(true);
    const params = new URLSearchParams(back.split('?')[1]);
    expect(params.get('error')).toMatch(/Latitude/);
    const [row] = await owner.db.select().from(schema.clockingLocation).where(eq(schema.clockingLocation.id, id));
    expect(row.name, 'nothing was written').toBe('On File');
    const html = visible(await renderEdit(id, Object.fromEntries(params)));
    expect(html).toContain('value="Typed Name"');
    expect(html).not.toContain('value="On File"');
    const junk = visible(await renderEdit(id, { typedLat: 'north-ish', typedName: 'Still Typed' }));
    expect(junk).toContain('value="Still Typed"');
    expect(junk).toContain(`value="${HQ.lat}"`);
  });

  it('a forged posted id can send the browser nowhere but the clocking list', async () => {
    for (const junk of ['not-a-uuid', 'https://evil.example/steal', "'; drop table clocking_location; --", '']) {
      const back = await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: junk });
      expect(back, `${JSON.stringify(junk)} lands on the list with the reason`).toBe(`${CLOCKING_LIST}?error=${encodeURIComponent('Clocking location not found')}`);
    }
    const unknown = '00000000-0000-4000-8000-000000000000';
    const back = await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: unknown });
    expect(back.startsWith(clockingEditPage(unknown))).toBe(true);
    expect(back).toContain('error=');
  });
});

/**
 * 0fe1ca2e (r322) — THE LINK SURVIVES A PLAIN SAVE, WHICH IS THE ONLY REASON THE FIELD IS STILL POSTED.
 *
 * The form no longer OFFERS the company-location link: a clocking point is a physical place, and that
 * field was the one thing making the form look company-based. But the column stays, the admin register
 * groups on it, and `updateClockingLocation` writes `locationId` on every save with whatever
 * `resolveLocationLink` returned — and that is NULL for an absent field. So a form that merely deleted
 * the control would have cleared the link on the next unrelated edit, silently, on any tenant using it.
 *
 * Production has no such row today (both points have location_id NULL), which is exactly why this has to
 * be a test rather than an observation: nothing on this deployment would have failed if it were wrong.
 */
describe('0fe1ca2e · removing the control must not unlink anything', () => {
  it('an edit that changes only the name keeps the link', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id } = await mkSite({
      name: 'Gate A', lat: HQ.lat, lng: HQ.lng, radiusM: 200, locationId: loc, reportLabel: 'GA',
    });

    // Exactly what the rendered form posts: every field, with the hidden locationId carrying the link.
    await runAction(updateClockingLocationAction, {
      ...FULL, clockingLocationId: id, name: 'Gate A (renamed)', locationId: loc,
    });

    const [row] = await owner.db
      .select({ name: schema.clockingLocation.name, locationId: schema.clockingLocation.locationId })
      .from(schema.clockingLocation)
      .where(eq(schema.clockingLocation.id, id));
    expect(row.name).toBe('Gate A (renamed)');
    expect(row.locationId, 'the link the operator never saw must still be there').toBe(loc);
  });

  /**
   * THE REGRESSION ARM — what would have happened had the control simply been deleted. Posting WITHOUT
   * the field is the unlink, and it must be reachable only by actually omitting it, never by default.
   */
  it('and omitting the field is what clears it — which is why the form must render it', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ2', name: 'Second' });
    const { id } = await mkSite({
      name: 'Gate B', lat: HQ.lat, lng: HQ.lng, radiusM: 200, locationId: loc, reportLabel: 'GB',
    });

    await runAction(updateClockingLocationAction, { ...FULL, clockingLocationId: id, name: 'Gate B' });

    const [row] = await owner.db
      .select({ locationId: schema.clockingLocation.locationId })
      .from(schema.clockingLocation)
      .where(eq(schema.clockingLocation.id, id));
    expect(row.locationId, 'an absent field resolves to NULL — the silent unlink, reproduced').toBeNull();
  });
});

describe('r423 — the pages render', () => {
  it('the NEW page: the reporter’s order, every company as a tick, Save, Cancel to the list, and the keyless map', async () => {
    const { id: coB } = await (await import('../core/admin')).createCompany(ADMIN, { legalName: 'XYZ Sdn Bhd' });
    const html = visible(await renderNew());
    assertClockingOrder(html);
    assertPostedFields(html, { linked: false });
    for (const id of [b.companyId, coB]) expect(html, 'every company offered as a tick').toContain(`name="companyIds" value="${id}"`);
    for (const id of [b.companyId, coB]) {
      expect(inputTag(html, `name="companyIds" value="${id}"`), 'nothing pre-ticked on a new location').not.toContain('checked=""');
    }
    expect(inputTag(html, 'name="status" value="active"'), 'Active is the default status').toContain('checked=""');
    expect(inputTag(html, 'name="status" value="inactive"')).not.toContain('checked=""');
    expect(html, 'Malaysian states are offered').toContain('<option value="Selangor">Selangor</option>');
    expect(count(html, '>save<')).toBe(1);
    expect(count(html, '>cancel<')).toBe(1);
    expect(count(html, `href="${CLOCKING_LIST}"`), 'Back and Cancel, both to the list').toBe(2);
    expect(html).toContain('>© OpenStreetMap contributors</p>');
    expect(html).toContain('Address search: Nominatim');
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Satellite<\/button>/);
    for (const field of ['lat', 'lng', 'radiusM']) {
      expect(inputTag(html, `name="${field}"`), `${field} is still a plain typed box`).toContain('type="number"');
      expect(inputTag(html, `name="${field}"`), `${field} is still required by the form itself`).toContain('required=""');
    }
    expect(html, 'no work-location link on a new location').not.toContain('name="locationId"');
    expect(html).not.toContain('<iframe');
  });

  it('the EDIT page: what is on file (companies ticked, status), Back and Cancel to the row; junk and unknown ids are notFound()', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const { id } = await mkSite({ name: 'Gate A', lat: HQ.lat, lng: HQ.lng, radiusM: 200, locationId: loc, reportLabel: 'GA', address: 'Lot 1', state: 'Selangor' });
    const html = visible(await renderEdit(id));
    expect(html).toContain('editClockingTitle');
    expect(html).toContain('value="Gate A"');
    expect(html).toContain('value="200"');
    expect(inputTag(html, `name="companyIds" value="${b.companyId}"`)).toContain('checked=""');
    expect(html).toMatch(/<option value="Selangor" selected="">/);
    expect(html).toContain(`<input type="hidden" name="clockingLocationId" value="${id}"`);
    // 0fe1ca2e — the work-location link is READ-ONLY, still on the form and still posted.
    expect(html).toContain(`<input type="hidden" name="locationId" value="${loc}"`);
    expect(html, 'and it says which location').toContain('Headquarters');
    expect(count(html, `href="${clockingFocusHref(id)}"`), 'Back and Cancel land on the row').toBe(2);
    assertClockingOrder(html);
    assertPostedFields(html, { linked: true });
    for (const junk of ['not-a-uuid', "'; drop table clocking_location; --", id.slice(0, -1)]) {
      await expect(renderEdit(junk), `${junk} never reaches SQL`).rejects.toThrow('NEXT_NOT_FOUND');
    }
    await expect(renderEdit('00000000-0000-4000-8000-000000000000')).rejects.toThrow('NEXT_NOT_FOUND');
    await archiveLocation(ADMIN, { locationId: loc });
    const archived = visible(await renderEdit(id));
    expect(archived).toContain(`<input type="hidden" name="locationId" value="${loc}"`);
    expect(archived).toContain('statusArchived');
  });

  /**
   * ADR-0086 (item 0fe1ca2e, r331) — THE SITE REGISTER NO LONGER OFFERS, OR DESCRIBES, A HOLIDAY STATE.
   *
   * This case is here rather than in a source-scan file because it is the one place in the suite that
   * RENDERS this screen against a real database (`renderList`, with `visible()` stripping <script> so the
   * RSC payload cannot fake a pass — CLAUDE.md §8, "a key is not a screen").
   *
   * WHAT WENT, AND WHY IT HAD TO. `location.state` was the TOP rung of the public-holiday state precedence
   * (location.state → holiday group → employment.work_state → company.default_work_state → national). r331
   * removed the `location` join from BOTH readers in core/holidays.ts, so nothing functional reads the
   * column now. The screen nevertheless kept a `<select name="state">` on the edit row AND on the create
   * form, printed the resolved value back on each row, and closed with
   * `admin.locations.stateNote` — "A location's state overrides the employee's work state for
   * public-holiday resolution; leave blank to use the company default." In six locales.
   *
   * That sentence was TRUE when it was written and became FALSE the moment the resolver changed. An
   * operator reading it would set a State expecting public holidays to follow, and nothing would happen —
   * a worse failure than a dead column, because the screen actively teaches the wrong model. The control,
   * the read-back and the note are all removed; `location.state` itself is KEPT (db/schema.ts records
   * why), so the stored value simply stops being editable and stops being advertised.
   *
   * NON-VACUITY IS BUILT IN: the fixture creates a real location, so the edit row renders, and the
   * assertions below check that the controls which SURVIVE are present. Without that, "no name=\"state\""
   * would also pass on a screen that failed to render a form at all.
   */
  it('ADR-0086: the rendered location form offers no State control and makes no claim about holiday resolution', async () => {
    /**
     * 639bf4a5 rev 2 (r338) — RE-POINTED, NOT LOOSENED, AND THE MUTATION TARGET MOVED WITH IT. This
     * rendered the REGISTER, because that is where a location was edited when r331 wrote it: an inline
     * strip on every row and a create strip at the foot of every company card. The register is a company
     * listing now and edits nothing, so the same case renders the LOCATION'S OWN Edit screen — which is
     * where a `<select name="state">` would have to come back to, and is therefore where the absence has
     * to be asserted. Rendering the listing here would have gone vacuous the moment the forms moved.
     */
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const html = visible(await renderLocationEdit(loc));

    // The record really is on screen, so the form really did render.
    expect(html, 'the fixture location renders').toContain('Headquarters');
    expect(html).toContain(`name="locationId" value="${loc}"`);
    // …and the controls ADR-0086 KEEPS are there, which is what makes the absences below mean something.
    for (const kept of ['code', 'name', 'country', 'branch']) {
      expect(count(html, `name="${kept}"`), `the ${kept} control survives`).toBeGreaterThan(0);
    }

    // ⚠️ THE MUTATION TARGET. Put a state control back on app/admin/work-locations/location-form.tsx and
    // the first line fails; restore the retired note and the second does.
    expect(count(html, 'name="state"'), 'no State control on the location form').toBe(0);
    const en = JSON.parse(read('messages/en.json')) as { admin: { locations: Record<string, string> } };
    for (const gone of ['state', 'stateNational', 'stateNote', 'calendar', 'calendarNone']) {
      expect(en.admin.locations[gone], `admin.locations.${gone} is retired from the catalogue`).toBeUndefined();
    }
    // A key that is gone from en.json cannot render in ANY locale (test/i18n-coverage.test.ts check A keeps
    // the other five in step with it), so the false sentence is unreachable rather than merely unrendered.
    expect(html).not.toMatch(/overrides the employee|public-holiday resolution/i);

    // The page must also stop READING the column back at the operator: `stateLabel(l.state)` printed
    // t('stateNational') — "National (default)" — for a site with NO state, which asserted a resolution
    // rule rather than showing nothing.
    expect(html).not.toContain('National (default)');
  });

  it('the LIST as a group admin: the columns, the companies, View / Edit / Deactivate, Activate for an inactive one', async () => {
    const { id: coB } = await (await import('../core/admin')).createCompany(ADMIN, { legalName: 'XYZ Sdn Bhd' });
    const { id: a } = await mkSite({ name: 'Gate A', lat: HQ.lat, lng: HQ.lng, radiusM: 200, reportLabel: 'GA', companyIds: [b.companyId, coB], state: 'Selangor', address: 'Jalan Kota' });
    const { id: c } = await mkSite({ name: 'Old Store', lat: HQ.lat, lng: HQ.lng, radiusM: 100 });
    await owner.db.update(schema.clockingLocation).set({ archivedAt: new Date() }).where(eq(schema.clockingLocation.id, c));
    const html = visible(await renderList());
    expect(html).toContain(`id="row-${a}"`);
    expect(html).toContain(`id="row-${c}"`);
    expect(html).toContain('Jalan Kota');
    expect(html).toContain('>Selangor<');
    expect(html).toContain('>Acme Sdn Bhd<');
    expect(html).toContain('>XYZ Sdn Bhd<');
    expect(count(html, '>view<'), 'View on every row').toBe(2);
    expect(count(html, '>edit<'), 'Edit on every row').toBe(2);
    expect(count(html, `href="${clockingViewPage(a)}"`)).toBe(1);
    expect(count(html, 'deactivate'), 'Deactivate on the active row (button + confirm label)').toBeGreaterThanOrEqual(1);
    expect(count(html, '>activate<'), 'Activate on the inactive one').toBe(1);
    expect(html).toContain(`href="${CLOCKING_NEW_PAGE}"`);
    for (const field of ['lat', 'lng', 'radiusM', 'reportLabel']) expect(html, `no ${field} box on the list`).not.toContain(`name="${field}"`);
    // The filters narrow it.
    const inactive = visible(await renderList({ status: 'inactive' }));
    expect(inactive).toContain(`id="row-${c}"`);
    expect(inactive).not.toContain(`id="row-${a}"`);
    const byCo = visible(await renderList({ company: coB }));
    expect(byCo).toContain(`id="row-${a}"`);
    expect(byCo).not.toContain(`id="row-${c}"`);
    const searched = visible(await renderList({ q: 'kota' }));
    expect(searched).toContain(`id="row-${a}"`);
    expect(searched).not.toContain(`id="row-${c}"`);
  });

  /**
   * Plan point 2 — a company administrator sees, READ-ONLY, only the locations open to companies they
   * administer, and only those company names. r272's property (a reader who may not edit still gets a View)
   * is kept.
   */
  it('the LIST and the pages as a COMPANY-SCOPED admin: only their companies’ locations and names; View, no Edit, no form', async () => {
    const { id: coB } = await (await import('../core/admin')).createCompany(ADMIN, { legalName: 'Hidden Co' });
    const { id: shared } = await mkSite({ name: 'Shared Gate', lat: HQ.lat, lng: HQ.lng, radiusM: 200, reportLabel: 'GB', companyIds: [b.companyId, coB] });
    const { id: other } = await mkSite({ name: 'Other Co Gate', lat: HQ.lat, lng: HQ.lng, radiusM: 200, companyIds: [coB] });
    ADMIN = await adminFor(b.companyId);
    const list = visible(await renderList());
    expect(list).toContain('companyAdminReadOnly');
    expect(list).toContain(`id="row-${shared}"`);
    expect(list, 'a location open only to another company is not listed').not.toContain(`id="row-${other}"`);
    expect(list).toContain('>Acme Sdn Bhd<');
    expect(list, 'and another company’s NAME is never shown').not.toContain('Hidden Co');
    expect(list, 'no Edit control for this role').not.toContain('>edit<');
    expect(list).toContain('>view<');
    expect(list).not.toContain(`href="${CLOCKING_NEW_PAGE}"`);
    const view = visible(await renderView(shared));
    expect(view).toContain('Shared Gate');
    expect(view).not.toContain('Hidden Co');
    expect(view).not.toContain('<form');
    await expect(renderView(other), 'a location not open to their companies is notFound()').rejects.toThrow('NEXT_NOT_FOUND');
    await expect(renderEdit(shared)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toBe(clockingViewPage(shared));
    const newPage = visible(await renderNew());
    expect(newPage).toContain('sharedManagedByGroupAdmin');
    expect(newPage).not.toContain('<form');
  });
});
