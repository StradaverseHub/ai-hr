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
import LocationsPage from '../app/admin/work-locations/page';
import NewClockingLocationPage from '../app/admin/work-locations/clocking/new/page';
import EditClockingLocationPage from '../app/admin/work-locations/clocking/[id]/page';
import { createClockingLocationAction, updateClockingLocationAction } from '../app/admin/actions';
import {
  CLOCKING_FIELDS,
  CLOCKING_NEW_PAGE,
  LOCATIONS_LIST,
  clockingEditPage,
  clockingRowHref,
  readTypedClockingValues,
  typedKey,
} from '../app/admin/work-locations/clocking/form-fields';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const LIST = 'app/admin/work-locations/page.tsx';
const FORM = 'app/admin/work-locations/clocking/clocking-form.tsx';
const NEW = 'app/admin/work-locations/clocking/new/page.tsx';
const EDIT = 'app/admin/work-locations/clocking/[id]/page.tsx';
const ACTIONS = 'app/admin/actions.ts';
const FIELDS = 'app/admin/work-locations/clocking/form-fields.ts';
const NEW_ROUTE = '/admin/work-locations/clocking/new';
const EDIT_ROUTE = '/admin/work-locations/clocking/[id]';

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
    // No nav row: the pages are reached from the list. Asserted for BOTH the old address and the new
    // one (639bf4a5) — the pack must not regrow a row for either.
    expect(read('packs/attendance/index.ts')).not.toContain('/admin/locations/clocking');
    expect(read('packs/attendance/index.ts')).not.toContain('/admin/work-locations/clocking');
  });

  /**
   * 639bf4a5 (r336) — UPDATED, NOT LOOSENED. Until this round the first assertion read
   *
   *   expect(read('packs/attendance/index.ts')).toContain(
   *     "{ href: <the old /admin/locations address>, labelKey: 'clockingLocation', icon: MapPin, adminOnly: true }");
   *
   * and pinned the menu row INSIDE the attendance pack. That is the decision this item reverses: the
   * register is Administration › Physical Work Location now, a flat row in components/sidebar.tsx beside
   * Organization, and the pack carries no row for it at all. So the same property — "exactly one row,
   * and it opens the register with no fragment" — is asserted at the row's new home, and the pack is
   * asserted EMPTY of it, which is the half that would fail if somebody put the old row back.
   *
   * (The old row is described rather than quoted: this file greps the pack source for that literal, and
   * a quoted copy in a comment would satisfy the very assertion it replaced.)
   *
   * The r267 reasoning is unchanged and still load-bearing: no `#clocking` fragment on the href, because
   * the sidebar's active predicate (components/nav-flyout.tsx isHrefActive) splits on `?` only and a
   * fragment would stop the row ever lighting up. "Lands on the clocking list" is delivered by PAGE
   * ORDER, which is what the rest of this case measures.
   */
  it('the menu row opens /admin/work-locations from the Administration group (no fragment), the pack carries none, and the page leads with the clocking register', () => {
    const sidebar = read('components/sidebar.tsx');
    expect(sidebar).toContain("{ href: '/admin/work-locations', labelKey: 'physicalWorkLocation', icon: MapPin }");
    expect(sidebar.split("'/admin/work-locations'").length - 1, 'exactly one row in the rail').toBe(1);
    expect(read('packs/attendance/index.ts'), 'the attendance pack advertises it no more').not.toContain(
      "labelKey: 'clockingLocation',",
    );
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

describe('f9afd1ce rev 2 — the page of its own: ONE section in the reporter’s order, Back, Save beside a Cancel LINK', () => {
  const form = withoutComments(read(FORM));
  const newPage = withoutComments(read(NEW));
  const editPage = withoutComments(read(EDIT));

  /**
   * 0fe1ca2e rev 6 (r335) — UPDATED, NOT LOOSENED, because it pinned a layout the reporter contested.
   *
   * This case used to read "Location information, then GPS and clocking settings — each field in its
   * place" and asserted the two section slices as disjoint sets: name / reportLabel / address /
   * locationId / remarks in the first, lat / lng / radiusM in the second, each absent from the other.
   * That pinned exactly the card boundary the reporter complained about — the address search sat above
   * Latitude but with a whole card between them — so it is REWRITTEN to pin the single section and the
   * one order they approved, field by field, rather than deleted.
   *
   * The `sectionGps` heading is now the only heading on the form, and it is asserted as the ONLY
   * SectionHeader: a second card creeping back would show up here first.
   */
  it('ONE section, headed GPS and clocking settings — search, address, the coordinates, then what the place is called', () => {
    expect(form, 'the retired heading is not rendered anywhere').not.toContain("t('sectionInfo')");
    expect(form.match(/<SectionHeader /g)?.length, 'ONE section heading on the whole form').toBe(1);
    expect(form).toContain("<SectionHeader title={t('sectionGps')} />");
    expect(form.match(/<Card /g)?.length, 'ONE card — the boundary the reporter contested is gone').toBe(1);

    // ⚠️ ORDER, not presence. Every one of these fields was already on the form before this round, so an
    // assertion that merely found them would have passed on the two-card layout too.
    const order = ['<ClockingAddressSearch', 'name="address"', 'name="lat"', 'name="lng"', 'name="radiusM"', 'name="name"', 'name="reportLabel"', 'name="locationId"', 'name="remarks"'];
    const seen = order.map((needle) => ({ needle, at: at(form, needle) }));
    const measured = [...seen].sort((a, b) => a.at - b.at).map((s) => s.needle);
    expect(measured, `the source order, as measured: ${measured.join(' → ')}`).toEqual(order);

    expect(form, 'the radius is posted raw so a blank reaches the service’s sentence').toContain('name="radiusM" type="number" min={1} step={1}');
    expect(form, 'the report label hint sits under the grid that holds the box').toContain("t('reportLabelHint')");
    expect(at(form, "t('reportLabelHint')"), 'and after it, not stranded above the coordinates').toBeGreaterThan(at(form, 'name="reportLabel"'));
    expect(at(form, "t('radiusNote')"), 'the radius note still follows its own box').toBeGreaterThan(at(form, 'name="radiusM"'));
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
    // 0fe1ca2e rev 6 (r335): keyed on the heading that still exists — `sectionInfo` was retired with the
    // second card. The property is unchanged: the refusal reason is above the fields, not under the header.
    expect(at(form, '<ErrorBanner message={error} />')).toBeLessThan(at(form, "t('sectionGps')"));
    /**
     * fa2db8cb rev 2 (r279) — REWRITTEN, NOT DELETED. Until this round two lines stood here. One
     * asserted the form matched none of five map-related spellings — the two map-library names, the
     * embed element, and the two placeholder identifiers a future round might have reached for. The
     * other asserted the file carried no client directive. (Described rather than quoted on purpose:
     * a comment that spells out a forbidden specifier re-trips the source greps that look for it, and
     * the reworded description costs a reader nothing.)
     *
     * Those lines held the owner's decision of 2026-09-11 — recorded in this form's own header and in
     * ADR-0070 — that the screen would carry no map and no placeholder until a map provider had been
     * chosen. rev 2 REVERSES that decision: the item was approved three times and blocked twice asking
     * the reporter for a Google key that never came, so the map is built now on free, keyless open map
     * data behind a provider seam that a paid supplier's configuration later replaces without touching
     * this screen. A guard pinning a decision you are reversing is UPDATED, not removed (CLAUDE.md §8),
     * so the same lines now pin what replaced it — starting with the half of the old guard that still
     * holds, which is the important one.
     */
    expect(form, 'STILL server-rendered — the islands are separate files, this one has no client island').not.toContain("'use client'");
    /**
     * ⚠️ THE WHOLE REASON THIS ROUND WAS RISKY, and asserted FIRST so it is the line that speaks. r272
     * shipped a page that returned 500 because a server component passed a FUNCTION to a client one;
     * tsc, eslint and thirteen source guards were green and only a dev-server render caught it. Each
     * island takes exactly ONE prop and it is the plain provider descriptor — asserted as the WHOLE
     * prop list of every island on the form, so a second prop of any kind has to come back through here.
     */
    const islandProps = [...form.matchAll(/<Clocking(?:AddressSearch|Map)\s+([^/>]*)\/>/g)].map((m) => m[1].trim());
    expect(islandProps, 'one serialisable prop each — nothing callable crosses the server→client boundary').toEqual([
      'provider={mapProvider}',
      'provider={mapProvider}',
    ]);
    expect(form, 'the search is mounted at the top of the form').toContain('<ClockingAddressSearch provider={mapProvider} />');
    expect(form, 'the map is mounted inside GPS and clocking settings').toContain('<ClockingMap provider={mapProvider} />');
    /**
     * 0fe1ca2e rev 6 (r335) — REVERSED ON PURPOSE, WHICH IS THE ROUND. This read
     *
     *   expect(at(form, '<ClockingAddressSearch'), 'the search is in Location information')
     *     .toBeLessThan(at(form, "t('sectionGps')"));
     *
     * and was the line that pinned the search into the OTHER card. There is one card now, so the search
     * comes AFTER the only heading — and, the thing the reporter actually asked for, immediately before
     * the boxes it writes with nothing between.
     */
    expect(at(form, '<ClockingAddressSearch'), 'the search is inside the one section, under its heading').toBeGreaterThan(at(form, "t('sectionGps')"));
    expect(at(form, '<ClockingAddressSearch'), 'and directly above Address, which it writes').toBeLessThan(at(form, 'name="address"'));
    expect(
      form.slice(at(form, '<ClockingAddressSearch'), at(form, 'name="address"')),
      'nothing posted sits between the search and the first box it fills',
    ).not.toMatch(/\sname="/);
    expect(at(form, '<ClockingMap'), 'the map is still directly under the boxes it draws').toBeGreaterThan(at(form, 'name="radiusM"'));
    expect(at(form, '<ClockingMap'), '…and above the descriptive fields, so it is never separated from them').toBeLessThan(at(form, 'name="name"'));
    expect(form, 'the seam is resolved ONCE, on the server, from the environment').toContain('const mapProvider = resolveMapProvider(process.env);');
    expect(form, 'no embed: the framed third-party map is the option that still needs a key').not.toContain('<ifr' + 'ame');
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

/**
 * 0fe1ca2e rev 6 (r335) — THE ORDER OF THE CONTROLS IN THE MARKUP, which is the whole of what this round
 * changed and the only thing the reporter can see.
 *
 * ⚠️ ORDER, NEVER PRESENCE. Every one of these controls was on the page before this round — in two cards,
 * the search separated from Latitude by the whole of Location information. An assertion that merely found
 * them would pass on the layout that was contested, so each is located by index and the sequence compared,
 * with the MEASURED sequence in the failure message so a regression says what it actually rendered.
 *
 * The search box is anchored on its accessible label, read out of en.json rather than typed here: the
 * island resolves its own text through the real catalogue (the provider in `toMarkup`), so a hardcoded
 * English sentence would pin the translation instead of the layout.
 */
const EN_LOCATIONS = (JSON.parse(read('messages/en.json')) as { admin: { locations: Record<string, string> } }).admin.locations;
function assertClockingOrder(html: string): void {
  const marks: [string, string][] = [
    ['the address search', `aria-label="${EN_LOCATIONS.addressSearchLabel}"`],
    ['Address', 'name="address"'],
    ['Latitude', 'name="lat"'],
    ['Longitude', 'name="lng"'],
    ['Clocking radius', 'name="radiusM"'],
    ['Name', 'name="name"'],
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
function assertPostedFields(html: string): void {
  const open = html.lastIndexOf('<form', html.indexOf('sectionGps'));
  expect(open, 'the form is on the page').toBeGreaterThan(-1);
  const form = html.slice(open, html.indexOf('</form>', open));
  const posted = [...new Set([...form.matchAll(/\sname="([^"]+)"/g)].map((m) => m[1]))].filter((n) => n !== 'clockingLocationId');
  expect([...posted].sort(), `the form posts: ${posted.join(', ')}`).toEqual([...CLOCKING_FIELDS].sort());
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
    const { id } = await createClockingLocation(ADMIN, {
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
    const { id } = await createClockingLocation(ADMIN, {
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

describe('f9afd1ce rev 2 — the pages render', () => {
  it('the NEW page: ONE section heading, Save, Cancel to the list, the pre-picked link, and the keyless map', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const html = visible(await renderNew({ addPoint: loc }));
    /**
     * 0fe1ca2e rev 6 (r335) — UPDATED, NOT LOOSENED. The three lines here used to read
     *
     *   expect(count(html, 'sectionInfo')).toBe(1);
     *   expect(count(html, 'sectionGps')).toBe(1);
     *   expect(html.indexOf('sectionInfo')).toBeLessThan(html.indexOf('sectionGps'));
     *
     * and pinned the two-card layout the reporter contested. ONE card now, and `sectionInfo` is retired
     * from all six locales, so its count is asserted at ZERO — on the markup with <script> stripped, so a
     * key surviving in the RSC payload cannot fake either half (CLAUDE.md §8).
     */
    expect(count(html, 'sectionGps'), 'the one heading, once').toBe(1);
    expect(count(html, 'sectionInfo'), 'and no Location information heading anywhere on the page').toBe(0);
    assertClockingOrder(html);
    assertPostedFields(html);
    expect(count(html, '>save<')).toBe(1);
    expect(html).toContain(`href="${LOCATIONS_LIST}"`);
    expect(count(html, '>cancel<')).toBe(1);
    expect(count(html, 'backToLocations</a>'), 'the way back, once').toBe(1);
    expect(html).toContain('newClockingTitle');
    /**
     * 0fe1ca2e (r322) — UPDATED, NOT DELETED, because it pins a decision that was reversed. This read
     *
     *   expect(html).toMatch(new RegExp(`<option value="${loc}"[^>]*selected`));
     *
     * back when the link was a <select>. That control is gone: a Clocking Location is a physical place
     * and the link was the one field that made the form look company-based. What must NOT change is the
     * property the old line actually protected — that `?addPoint=` still carries its location through —
     * so it is asserted on the hidden field that now carries it, and the control's absence is asserted
     * beside it so the two cannot both drift back.
     */
    expect(html).toContain(`<input type="hidden" name="locationId" value="${loc}"`);
    expect(html, 'the picker itself is gone').not.toContain('<select name="locationId"');
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
    /**
     * ⚠️ TWO CREDITS, PINNED SEPARATELY. Asserting the bare words "© OpenStreetMap contributors" was
     * VACUOUS and was caught by mutation: the address search's own credit line ENDS in the same words,
     * so deleting the map's caption entirely left the assertion green. Each is now pinned to its own
     * element — the map's as a whole text node, the search's by the part only it says.
     */
    expect(html, 'the MAP credits its tile supplier in our own server-rendered markup, not Leaflet’s control').toContain(
      '>© OpenStreetMap contributors</p>',
    );
    expect(html, 'and the SEARCH credits the geocoder separately, as its usage policy asks').toContain('Address search: Nominatim');
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
    // With no link there is no field AT ALL — not an empty one. An empty `locationId` would post as ''
    // and resolve to NULL, which is the same outcome here, but rendering nothing is what makes the form
    // say plainly that a clocking point has no company.
    expect(plain, 'nothing pre-picked').not.toContain('name="locationId"');
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
    // 0fe1ca2e — the link is READ-ONLY now, but it is still on the form and still posted. This is the
    // load-bearing half: `resolveLocationLink` maps an absent field to NULL and the update sets it
    // unconditionally, so a form that merely dropped the control would unlink this row on the next
    // plain Save, with no message and no event.
    expect(html).toContain(`<input type="hidden" name="locationId" value="${loc}"`);
    expect(html, 'no picker').not.toContain('<select name="locationId"');
    expect(html, 'and it says which location, rather than just hiding it').toContain('Headquarters');
    // Back and Cancel both land on the row (renderToStaticMarkup escapes & in attributes; there is none here).
    expect(count(html, `href="${clockingRowHref(id)}"`)).toBe(2);
    // 0fe1ca2e rev 6 (r335): ONE heading, and the retired one absent — the edit page renders the same form.
    expect(count(html, 'sectionGps')).toBe(1);
    expect(count(html, 'sectionInfo')).toBe(0);
    assertClockingOrder(html);
    assertPostedFields(html);

    for (const junk of ['not-a-uuid', "'; drop table clocking_location; --", id.slice(0, -1)]) {
      await expect(renderEdit(junk), `${junk} never reaches SQL`).rejects.toThrow('NEXT_NOT_FOUND');
    }
    await expect(renderEdit('00000000-0000-4000-8000-000000000000')).rejects.toThrow('NEXT_NOT_FOUND');

    // An archived link the picker cannot offer stays selected rather than silently unlinking on Save.
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
  it('ADR-0086: the rendered register offers no State control and makes no claim about holiday resolution', async () => {
    const { id: loc } = await createLocation(ADMIN, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    const html = visible(await renderList());

    // The row really is on screen, so the edit form below it really did render.
    expect(html, 'the fixture location renders').toContain('Headquarters');
    expect(html).toContain(`name="locationId" value="${loc}"`);
    // …and the controls ADR-0086 KEEPS are there, which is what makes the absences below mean something.
    for (const kept of ['code', 'name', 'country', 'branch']) {
      expect(count(html, `name="${kept}"`), `the ${kept} control survives`).toBeGreaterThan(0);
    }

    // ⚠️ THE MUTATION TARGET. Put either <select name="state"> back on app/admin/work-locations/page.tsx and
    // the first line fails; restore the <p>{t('stateNote')}</p> and the second does.
    expect(count(html, 'name="state"'), 'no State control on the edit row or the create form').toBe(0);
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
