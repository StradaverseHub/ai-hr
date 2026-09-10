/**
 * Schedule configuration screen (feedback 1c5602cc, r263) — the promises this round made in writing.
 *
 * The screen itself is read-only, so there is no calculation to pin. What CAN silently break — and what
 * every one of these assertions is aimed at — are the four promises the approved plan made to the
 * reporter, each of which a later round could undo without any other test noticing:
 *
 *   1. ALONGSIDE, NOT INSTEAD. The a6fe37fc playbook's whole rule is that the old screen keeps working
 *      until a round is explicitly the cutover. Nothing else pins that the "Work Schedule" row and its
 *      route survived THIS round: delete either and every other guard stays green.
 *   2. REGISTERED IN THE SAME COMMIT. test/function-access.test.ts fails in both directions, so it
 *      already catches a page shipped without a column — but it does so generically. This says which
 *      route, so the failure names the screen instead of a diff of a route set.
 *   3. SIX TABS, THE REPORTER'S ORDER. The order is the reporter's own list and is the thing that makes
 *      the shape recognisable to them.
 *   4. ⚠️ ONLY GENERAL HAS A PANEL. This is the scope fence and the assertion most worth having. The
 *      five remaining tabs ship NAMED AND EMPTY on purpose (AGENTS 28: a control drawn at a value
 *      nothing stores is worse than an absent one), and the tempting "improvement" for a later round is
 *      to fill one in with a plausible-looking box. Adding a panel key here fails, loudly, with the
 *      reason.
 *
 * Static-over-source for the page, the house idiom for a guarded route (test/attendance-menu-
 * relocation.test.ts says why: requireAdmin() resolves a real session the harness cannot mint). No DB.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { attendancePack } from '../packs/attendance';
import { SCHEDULE_TAB_KEYS } from '../app/admin/attendance/schedule/tabs';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const NEW_ROUTE = '/admin/attendance/schedule';
/** The screen this round deliberately did NOT touch. */
const OLD_WORK_SCHEDULE_ROUTE = '/admin/attendance-policy/schedule';

const navHrefs = (attendancePack.navNodes ?? []).flatMap((n) => (n.children ?? []).map((c) => c.href));

describe('1c5602cc — the Schedule screen is added ALONGSIDE Work Schedule', () => {
  it('the new Schedule row is in the Attendance menu', () => {
    expect(navHrefs, `The Schedule nav row (${NEW_ROUTE}) is missing from the attendance pack.`).toContain(NEW_ROUTE);
  });

  it('the existing Work Schedule row is UNTOUCHED — this round is not the cutover', () => {
    expect(
      navHrefs,
      `The "Work Schedule" row (${OLD_WORK_SCHEDULE_ROUTE}) was removed. The a6fe37fc playbook, which the ` +
        `1c5602cc plan adopted in writing, keeps the old screen working until a round is EXPLICITLY the ` +
        `cutover — and the reporter has been asked to steer whether it is absorbed at all. If this is that ` +
        `round, retire the row and this assertion together, deliberately.`,
    ).toContain(OLD_WORK_SCHEDULE_ROUTE);
  });

  it('both routes are registered in the function-access matrix', () => {
    expect(
      REGISTERED_ROUTES.has(NEW_ROUTE),
      `${NEW_ROUTE} is not registered in lib/permissions.ts. The guarded page and its registry entry must ` +
        `land in the SAME commit — test/function-access.test.ts fails in both directions.`,
    ).toBe(true);
    expect(REGISTERED_ROUTES.has(OLD_WORK_SCHEDULE_ROUTE)).toBe(true);
  });

  it('the page guards itself, and does not rely on the menu to hide it', () => {
    expect(read('app/admin/attendance/schedule/page.tsx')).toMatch(/requireAdmin\(\)/);
  });
});

describe('1c5602cc — six named tabs, and ONLY General is built', () => {
  it('the tabs are the reporter\'s six, in the reporter\'s order', () => {
    expect([...SCHEDULE_TAB_KEYS]).toEqual([
      'general',
      'holiday',
      'overtime',
      'attendance',
      'request',
      'notification',
    ]);
  });

  it('the other five tabs render EMPTY — no panel is supplied for them', () => {
    const src = read('app/admin/attendance/schedule/page.tsx');
    // The shell renders `emptyLabel` for any tab whose panel is absent (components/personnel-tabs.tsx),
    // so "named and empty" is exactly "this object has one key".
    const m = src.match(/panels=\{\{([^}]*)\}\}/);
    expect(m, 'The page no longer passes a `panels={{ … }}` object to ClientTabs.').not.toBeNull();
    const supplied = m![1]
      .split(',')
      .map((s) => s.split(':')[0].trim())
      .filter(Boolean)
      .sort();
    expect(
      supplied,
      `Only the General tab is in scope for 1c5602cc. Holiday / Overtime / Attendance / Request / ` +
        `Notification ship NAMED AND EMPTY so the shape is visible and nobody wonders whether they were ` +
        `forgotten — AGENTS 28: an empty named tab is honest, a placeholder implying a setting exists is ` +
        `worse than an absent one. Do not fill one in with a control unless the storage behind it actually ` +
        `ships; when it does, raise that tab as its own item and change this assertion with it.`,
    ).toEqual(['general']);
  });
});

describe('1c5602cc — every string on the screen exists in all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  // The page resolves these through two namespaces; the i18n coverage guard sees the static t('…')
  // calls, but not that BOTH namespaces are present in every locale for this screen specifically.
  const usedKeys = () => {
    const src = read('app/admin/attendance/schedule/page.tsx');
    // Lookbehind excludes the SECOND namespace binding `tp('dayMon')` (admin.attendancePolicy, reused
    // for the weekday names) — those keys are not ours and must not be demanded of this namespace.
    return [...src.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z][\w.]*)'/g)].map((m) => m[1]);
  };

  it('the page really does use the scheduleConfig namespace (guard against a vacuous sweep)', () => {
    const keys = usedKeys();
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toContain('tabGeneral');
    expect(keys).toContain('gapRotationTitle');
  });

  for (const loc of LOCALES) {
    it(`${loc}: admin.scheduleConfig and nav.schedule resolve, with no key left blank`, () => {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const ns = msgs.admin?.scheduleConfig;
      expect(ns, `messages/${loc}.json has no admin.scheduleConfig namespace.`).toBeTruthy();
      expect(msgs.nav?.schedule, `messages/${loc}.json has no nav.schedule label.`).toBeTruthy();
      const missing = usedKeys().filter((k) => !ns[k] || String(ns[k]).trim() === '');
      expect(missing, `[${loc}] missing/blank admin.scheduleConfig keys: ${missing.join(', ')}`).toEqual([]);
    });
  }
});
