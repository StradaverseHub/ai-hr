/**
 * r431 (bdfe4968) — Attendance › Settings. Five setup screens (Shift, File Structure Mapping, Schedule,
 * Attendance Allowance, Locations) left the Attendance menu and became cards on one Settings page, the way
 * Payroll's Settings works. Only the way in moved: every address, guard and permission is unchanged.
 *
 * DB-free: the pack's nav data, the sidebar's own highlight predicate and the page source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attendancePack } from '../packs/attendance';
import { isNavRowActive } from '../components/nav-flyout';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { ATTENDANCE_SETTINGS_CARDS } from '../app/admin/attendance/settings/cards';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** The five hrefs, copied from the rows as they stood on main — the oracle the cards are compared with. */
const OLD_ROW_HREFS = [
  '/admin/attendance', // Shift
  '/admin/attendance/file-mappings', // File Structure Mapping
  '/admin/attendance/schedule', // Schedule
  '/admin/attendance-allowance', // Attendance Allowance
  '/admin/work-locations/clocking', // Locations
] as const;
const SETTINGS = '/admin/attendance/settings';

const node = attendancePack.navNodes!.find((n) => n.labelKey === 'attendanceSettings')!;
const allRows = [...attendancePack.navNodes!.flatMap((n) => n.children), ...(attendancePack.navLinks ?? [])];
const settingsRow = node.children.find((c) => c.href === SETTINGS)!;

/** The sidebar's rule inside a panel (components/sidebar.tsx activeChildHref): the LONGEST matching href wins. */
const litRow = (pathname: string) =>
  node.children
    .filter((c) => isNavRowActive(pathname, '', c))
    .sort((a, b) => b.href.split('?')[0].length - a.href.split('?')[0].length)[0]?.href;

describe('r431: the Settings page cards', () => {
  it('the five card hrefs equal the five old row hrefs, in order, with no extras', () => {
    expect(ATTENDANCE_SETTINGS_CARDS.map((c) => c.href)).toEqual([...OLD_ROW_HREFS]);
  });

  it('every card is a real, registered screen — nothing was renamed, so no redirect is needed', () => {
    for (const c of ATTENDANCE_SETTINGS_CARDS) {
      expect(fs.existsSync(path.join(root, `app${c.href}`, 'page.tsx')), `${c.href} page exists`).toBe(true);
      expect(REGISTERED_ROUTES.has(c.href), `${c.href} stays a registered route`).toBe(true);
    }
  });

  it('the page is requireAdmin-guarded, renders every card, and has a loading boundary', () => {
    const src = read('app/admin/attendance/settings/page.tsx');
    // A guard that greps a slice must prove the slice was found AND is long (CLAUDE.md section 8).
    const start = src.indexOf('export default async function AttendanceSettingsPage');
    expect(start, 'page component found').toBeGreaterThanOrEqual(0);
    const body = src.slice(start);
    expect(body.length, 'the slice is the whole component').toBeGreaterThan(500);
    expect(body).toMatch(/await requireAdmin\(\)/);
    expect(body).toContain('ATTENDANCE_SETTINGS_CARDS.map');
    expect(body).toContain('href={c.href}');
    expect(fs.existsSync(path.join(root, 'app/admin/attendance/settings/loading.tsx'))).toBe(true);
    expect(REGISTERED_ROUTES.has(SETTINGS), 'registered in lib/permissions.ts (function-access)').toBe(true);
  });

  it('a static settings segment sits beside [shiftId], which Next resolves ahead of the dynamic one', () => {
    const dir = path.join(root, 'app/admin/attendance');
    expect(fs.existsSync(path.join(dir, 'settings/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '[shiftId]/page.tsx'))).toBe(true);
    // The module gate: this page lives under the attendance layout, which allowance and work-locations lack.
    expect(read('app/admin/attendance/layout.tsx')).toContain("moduleLayout('attendance')");
  });

  it.each(LOCALES)('locale %s: the nav key and every card string are present and non-empty', (loc) => {
    const cat = JSON.parse(read(`messages/${loc}.json`));
    expect(cat.nav.attendanceSettingsPage, 'nav label').toBeTruthy();
    expect(cat.nav.attendanceSettingsPage).not.toBe(cat.nav.attendanceSettings); // not the plain "Attendance"
    const hub = cat.attendanceSettingsHub;
    expect(hub.title).toBeTruthy();
    expect(hub.subtitle).toBeTruthy();
    expect(hub.footnote).toBeTruthy();
    for (const c of ATTENDANCE_SETTINGS_CARDS) {
      for (const k of ['title', 'desc', 'cta'] as const) expect(hub[c.key]?.[k], `${loc}: ${c.key}.${k}`).toBeTruthy();
    }
  });

  it('English card titles match the labels the rows carried', () => {
    const hub = JSON.parse(read('messages/en.json')).attendanceSettingsHub;
    expect(ATTENDANCE_SETTINGS_CARDS.map((c) => hub[c.key].title)).toEqual([
      'Shift',
      'File Structure Mapping',
      'Schedule',
      'Attendance Allowance',
      'Locations',
    ]);
  });
});

describe('r431: the Attendance menu', () => {
  it('none of the five is a nav row any more, in the node or in Manage', () => {
    for (const href of OLD_ROW_HREFS) {
      expect(allRows.filter((r) => r.href === href), `${href} still has a nav row`).toHaveLength(0);
    }
  });

  it('Settings is ONE adminOnly child of the Attendance node, so attendance-module gating still reaches it', () => {
    expect(node.children.filter((c) => c.href === SETTINGS)).toHaveLength(1);
    expect(settingsRow.adminOnly).toBe(true);
    expect(settingsRow.labelKey).toBe('attendanceSettingsPage');
    expect(settingsRow.labelKey, 'its own key, not Payroll’s').not.toBe('payrollSettings');
    // MODULE_OF_HREF (components/sidebar.tsx) is built by flatMap over these children.
    expect(read('components/sidebar.tsx')).toContain('flatMap');
  });

  it('Card Assignment and Schedule Assignment STAY as rows', () => {
    for (const href of ['/admin/card-assignment', '/admin/attendance/schedule-assignment']) {
      expect(node.children.filter((c) => c.href === href), `${href} stays`).toHaveLength(1);
    }
  });

  it('the day-to-day rows stay', () => {
    const hrefs = allRows.map((r) => r.href);
    for (const h of ['/attendance', '/attendance/breakdown', '/roster', '/attendance/import']) expect(hrefs).toContain(h);
  });

  it('Settings is the lit row on each of the five pages (and their sub-pages), by the sidebar’s own ranking', () => {
    for (const href of OLD_ROW_HREFS) {
      for (const p of [href, `${href}/new`, `${href}/abc`]) {
        // /admin/work-locations/clocking/new etc. and /admin/attendance/new are real sub-pages.
        expect(litRow(p), `${p} lights Settings`).toBe(SETTINGS);
      }
    }
    // The retired Work Locations address still lights it (r428), and the Settings page itself does.
    expect(litRow('/admin/work-locations')).toBe(SETTINGS);
    expect(litRow(SETTINGS)).toBe(SETTINGS);
  });

  it('…and it does NOT steal the highlight from the two rows that stayed (longest href wins)', () => {
    // Under /admin/attendance prefix: Schedule Assignment's pages also match Settings' ownership of
    // /admin/attendance, so this is the case that proves the ranking, not the ownership, decides.
    for (const p of ['/admin/attendance/schedule-assignment', '/admin/attendance/schedule-assignment/bulk', '/admin/attendance/schedule-assignment/e1']) {
      expect(litRow(p), `${p} lights Schedule Assignment`).toBe('/admin/attendance/schedule-assignment');
    }
    expect(litRow('/admin/card-assignment')).toBe('/admin/card-assignment');
  });
});
