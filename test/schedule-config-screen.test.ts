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
 *   5. THE "Not configured here" CARD STAYS TRUE. Its four entries each assert an ABSENCE, and an
 *      absence expires silently. The last describe block ties each entry to the absence it claims (r263
 *      verify: the page's "delete an entry when its storage ships" comment was a request, not a guard).
 *
 * Static-over-source for the page, the house idiom for a guarded route (test/attendance-menu-
 * relocation.test.ts says why: requireAdmin() resolves a real session the harness cannot mint). No DB.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { attendancePack } from '../packs/attendance';
import { SCHEDULE_TAB_KEYS } from '../app/admin/attendance/schedule/tabs';
import { DAY_TYPE_INCLUSION_KEYS } from '../core/leave';

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

/**
 * ── THE STALENESS GUARD FOR THE "Not configured here" CARD ─────────────────────────────────────────────
 *
 * The card is a deliverable of this round: the plan promised "where a setting genuinely does not exist yet
 * we will say so rather than draw a box that does nothing", and the four entries are that promise kept.
 * But every entry is a claim about what is stored TODAY, and each one stops being true the moment the
 * storage behind it ships. Nothing would have failed when that happened: the card would have gone on
 * telling the reporter a setting they can now edit does not exist, which is worse than never naming the gap
 * — the page comment "Delete an entry only when its storage actually ships" is a request, not a guard.
 *
 * So each case below re-checks the ABSENCE its entry asserts, in the file where the storage would have to
 * appear, and names the i18n keys to delete in all six locales plus the <dl> row in the page. A failure
 * here is good news: the round that fills the gap has arrived, and the card must shrink with it.
 *
 * These are absence proofs, so they are necessarily approximate about NAMES — a rotation cycle stored as
 * `crew_cycle` would slip past the identifier scan. What they cannot miss is the SHAPE of each claim
 * (a pure predicate becoming a stored one; the cap acquiring a second editor; the inert day types being
 * read), which is what actually makes each sentence false.
 */
describe('1c5602cc — the "Not configured here" card is tied to the absences it claims', () => {
  const PAGE = 'app/admin/attendance/schedule/page.tsx';
  /** Every gap entry the page actually renders: `t('gapRotationTitle')` → `gapRotation`. */
  const renderedGaps = () =>
    [...new Set([...read(PAGE).matchAll(/t\('(gap[A-Z]\w*?)(?:Title|Body)'\)/g)].map((m) => m[1]))].sort();

  /** Source with line and block comments removed — prose about a concept is not storage OF it. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  /** Every SQL identifier db/schema.ts declares: table names and column names alike. */
  const schemaIdentifiers = () => [
    ...new Set([...stripComments(read('db/schema.ts')).matchAll(/\w+\(\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1])),
  ];

  it('the card and this guard cover the SAME four gaps', () => {
    expect(
      renderedGaps(),
      `A gap entry was added to or removed from the "Not configured here" card without its staleness ` +
        `guard moving with it. Every entry on that card is a claim that something is not stored; each one ` +
        `needs a case below that fails when it becomes stored, or the card silently rots into a lie.`,
    ).toEqual(['gapDayTypes', 'gapOtCap', 'gapRoster', 'gapRotation']);
  });

  it('gapRotation — no rotation cycle is stored anywhere', () => {
    // `rotat` only: this repo already stores a payroll cycle and a review cycle, so a bare `cycle`
    // scan is all false alarm. A rotation column would carry the word the reporter used.
    const stored = schemaIdentifiers().filter((n) => /rotat/.test(n));
    const inGenerator = [...stripComments(read('core/roster.ts')).matchAll(/\brotation\b/g)].length;
    expect(
      { stored, inGenerator },
      `admin.scheduleConfig.gapRotationTitle/gapRotationBody say a repeating rotation cycle is "not stored ` +
        `anywhere" and that a control for it "would need storage that does not exist yet". Something ` +
        `rotation-shaped now exists. If rotation storage has shipped, DELETE gapRotationTitle and ` +
        `gapRotationBody from all six messages/*.json and drop their <dl> row from ${PAGE} — then build ` +
        `the control the card was standing in for.`,
    ).toEqual({ stored: [], inGenerator: 0 });
  });

  it('gapRoster — the roster rule is still a pure predicate, not a stored setting', () => {
    const src = read('core/roster.ts');
    const decl = src.match(/export const canWriteRosterDate[\s\S]*?;/);
    expect(
      decl,
      `core/roster.ts no longer exports canWriteRosterDate as a single expression. ` +
        `admin.scheduleConfig.gapRosterBody describes it in words to the reporter ("Only an HR ` +
        `administrator may change a roster date that is today or earlier"); re-point this guard at ` +
        `whatever replaced it, or correct the sentence.`,
    ).not.toBeNull();
    const body = decl![0];
    const settingsShaped = /await|\bdb\b|\.select\(|Setting|Config/.test(body);
    const storedSettings = schemaIdentifiers().filter((n) => /roster/.test(n) && /setting|config|option|rule/.test(n));
    expect(
      { settingsShaped, storedSettings },
      `admin.scheduleConfig.gapRosterTitle/gapRosterBody say the Duty Roster's rules are "Fixed rules, not ` +
        `settings ... Neither can be turned off from a screen". The predicate now consults something, or a ` +
        `roster settings row now exists — either way the sentence is false. DELETE gapRosterTitle, ` +
        `gapRosterBody and rosterLink from all six messages/*.json and drop their <dl> row from ${PAGE}, ` +
        `and put the real control on this tab instead.`,
    ).toEqual({ settingsShaped: false, storedSettings: [] });
  });

  it('gapDayTypes — the five day types are fixed, and two of them are still inert', () => {
    expect(
      [...DAY_TYPE_INCLUSION_KEYS],
      `admin.scheduleConfig.gapDayTypesBody tells the reporter "The five day types are fixed". The ` +
        `allow-list changed. Rewrite gapDayTypesBody in all six messages/*.json to match the new set.`,
    ).toEqual(['offDay', 'restDay', 'publicHoliday', 'companyHoliday', 'shutdownDay']);

    // The counting kernel is where "recorded but not yet acted on" is decided: `dayWeight` weighs a holiday
    // by `inclusion.publicHoliday` alone and collapses restDay/offDay into one bucket (core/leave.ts, the
    // Phase A comments). Phase B is exactly the change that makes it read the other two.
    const kernel = read('core/leave.ts').match(/function dayWeight\([\s\S]*?\n}/);
    expect(kernel, 'core/leave.ts no longer declares dayWeight — re-point this guard at the counting kernel.').not.toBeNull();
    const reads = ['companyHoliday', 'shutdownDay'].filter((k) => kernel![0].includes(`inclusion.${k}`));
    expect(
      reads,
      `admin.scheduleConfig.gapDayTypesBody says company holiday and shutdown day are "recorded but not yet ` +
        `acted on". dayWeight now reads ${reads.join(' and ')}, so Phase B has landed and the sentence is ` +
        `false. Rewrite gapDayTypesBody in all six messages/*.json — and if the day types became editable, ` +
        `delete gapDayTypesTitle/gapDayTypesBody and their <dl> row from ${PAGE} entirely.`,
    ).toEqual([]);
  });

  it('gapOtCap — the monthly overtime cap is still owned and edited by Payroll alone', () => {
    expect(
      read('db/schema.ts').includes('maxHoursPerMonth'),
      `db/schema.ts no longer declares maxHoursPerMonth. admin.scheduleConfig.gapOtCapBody points the ` +
        `reporter at Payroll for it; if the cap moved or went away, that sentence must move with it.`,
    ).toBe(true);

    const walk = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : walk(rel);
        return /\.tsx?$/.test(e.name) ? [rel] : [];
      });
    const editors = walk('app').filter((f) => read(f).includes('maxHoursPerMonth'));
    expect(
      editors.sort(),
      `admin.scheduleConfig.gapOtCapBody tells the reporter the monthly overtime-hour limit is "Stored on ` +
        `the payroll policy, not on the schedule, and edited under Payroll. Shown there so one figure has ` +
        `one owner." A screen outside app/admin/payroll-policy now touches it, so it has two owners or a ` +
        `new one. If it is now edited (or shown) on the schedule, DELETE gapOtCapTitle/gapOtCapBody from ` +
        `all six messages/*.json and render the figure instead — that is the one plan promise this round ` +
        `did not deliver.`,
    ).toEqual(['app/admin/payroll-policy/actions.ts', 'app/admin/payroll-policy/policy-wizard.tsx', PAGE].sort());
  });
});
