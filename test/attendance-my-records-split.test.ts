/**
 * f3e6c36e (r287) — THE SPLIT: My Attendance › My Records vs Administration › Attendance › Employee
 * Attendance. The promises this round made, and the two traps the approved plan named by name.
 *
 * ⚠️ READ THIS FIRST — 2aef3cd8 (r362) EMPTIED THE EMPLOYEE HALF. The row is "Attendance Overview" now
 * and the screen is blank below its title: the reporter asked for the rename and for everything under the
 * row to be removed, and the approved plan says "Below the title the page is blank." Four cases in this
 * file asserted the opposite and are UPDATED, not deleted, each quoting the claim it reverses — the data
 * fence, the shared-formatter reuse, the "real screen, not a redirect stub" line count, and the six-locale
 * label case. Everything r287 decided about WHERE the row lives and WHO may open it is untouched and still
 * asserted below, because none of it changed: the split is still the reason this route exists, and the
 * consequence of the emptying (no employee-reachable screen shows a person their own attendance day by
 * day until content returns) is recorded on the page itself and in the r362 round entry.
 *
 * ── WHY THE ITEM EXISTS, INCLUDING THE PART THAT WAS REFUSED FIRST ──────────────────────────────────
 * The reporter asked for "My Attendance › Record" to be relocated to Administration › Attendance and
 * renamed Employee Attendance. Revision 1 of the plan REFUSED, and the refusal was correct: `/attendance`
 * is `guard: 'scopedSession'` with no admin gate — ONE screen resolving each viewer's own scope, a single
 * row to an employee and every employee in scope to an administrator — and the Administration sidebar
 * group carries `adminOnly` at GROUP level, so a row moved into it renders for NOBODY but administrators.
 * Moving the row does not make the screen admin-only; it takes an employee's own attendance away from
 * them. a324a4b3 rev2 made exactly that move and rev3 reverted it.
 *
 * The reporter then reaffirmed, in writing, after being told all of that. Under the fight-back rule
 * (CLAUDE.md §1) an instruction reaffirmed after a challenge is the owner's decision, so revision 2 of the
 * plan was approved and delivers it by SPLITTING rather than by moving — the one arrangement under which
 * both of the reporter's own requirements are true at once:
 *
 *   • the administrative Record function leaves My Attendance entirely (their words, twice), and
 *   • employee-facing attendance functions stay under My Attendance (their own point 7).
 *
 * ── WHY THESE ASSERTIONS ARE SOURCE-SHAPED, AND WHY THAT IS NOT LAZINESS ───────────────────────────
 * The house idiom for a guarded route (test/attendance-menu-relocation.test.ts says why): these pages
 * resolve a real session, which the node harness cannot mint, so the properties are read off the source.
 * That is a genuine limitation, not a preference, and it is the reason the round ALSO renders both routes
 * on a dev server as an administrator and as a plain employee — the absence assertions below are the
 * permanent, cheap half of a check whose expensive half ran once at build time.
 *
 * What each case is aimed at is a thing a later round could undo with every other guard staying green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attendancePack } from '../packs/attendance';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Source with block and line comments removed — the house idiom (test/schedule-config-screen.test.ts).
 *
 * IT IS LOAD-BEARING HERE, not tidiness. Every absence assertion below is about what the page RENDERS,
 * and this page's header comment necessarily NAMES the things it must not render: the admin tab strip,
 * the two admin tab routes, the word "hidden" in the sentence explaining that nothing is hidden. Scanning
 * raw source would fail on the explanation of the very rule being enforced, and the obvious "fix" — to
 * stop writing the explanation down — is the worse outcome. So the assertions read the CODE.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const EMPLOYEE_PAGE = 'app/attendance/my-records/page.tsx';
const ADMIN_PAGE = 'app/attendance/page.tsx';
const EMPLOYEE_ROUTE = '/attendance/my-records';
const ADMIN_ROUTE = '/attendance';

const nodes = attendancePack.navNodes ?? [];
const mine = nodes.find((n) => n.labelKey === 'myAttendance')!;
const config = nodes.find((n) => n.labelKey === 'attendanceSettings')!;

describe('f3e6c36e — the two screens are genuinely two screens', () => {
  it('the employee route exists as its own page, not a re-export of the admin one', () => {
    expect(fs.existsSync(path.join(ROOT, EMPLOYEE_PAGE)), `${EMPLOYEE_PAGE} must exist`).toBe(true);
    const src = stripComments(read(EMPLOYEE_PAGE));
    // The failure this forbids is the cheap "split": a one-line file re-exporting the admin page, which
    // would satisfy every nav assertion in the repo while leaving ONE screen behind two addresses — the
    // exact two-nodes-one-screen condition r274 disclosed and this item exists to end.
    expect(src, 'the employee screen does not re-export the admin page').not.toMatch(
      /from\s+'(\.\.\/page|@\/app\/attendance\/page)'/,
    );
    /**
     * ⚠️ 2aef3cd8 (r362) — THE OLD CLAIM WAS:
     *   expect(read(EMPLOYEE_PAGE).split('\n').length, 'it is a real screen, not a redirect stub')
     *     .toBeGreaterThan(40)
     * A line count is the wrong instrument for a screen that is now deliberately blank: this file's header
     * comment alone clears 40 lines, so the assertion would have gone on passing over a one-line redirect
     * stub — worse than failing. Replaced by the positive statement of what the screen IS after the
     * emptying: its own page, rendering its own title, forwarding nowhere.
     */
    expect(src, 'it renders its own title rather than forwarding somewhere else').toContain(
      "<PageHeader title={t('myRecords.title')} />",
    );
    expect(src, 'and it is not a redirect stub').not.toMatch(/\bredirect\(/);
  });

  it('the admin route survives untouched — the split is not a deletion', () => {
    // The reporter's request, read literally, deletes something. It must not: `/attendance` is where the
    // administrator reads everybody's attendance and it is the row they asked to KEEP.
    expect(fs.existsSync(path.join(ROOT, ADMIN_PAGE))).toBe(true);
    const src = read(ADMIN_PAGE);
    expect(src, 'it still resolves the session and its company scope').toContain('await scopedSession()');
    expect(src, 'and the reads are still narrowed to that scope').toMatch(/companyIds:\s*scopeIds/);
    expect(src, 'and it still renders the admin tab strip').toContain('<AttendanceTabs');
  });

  it('one row each, in the right node, with the right gate', () => {
    const employeeRow = mine.children.find((c) => c.href === EMPLOYEE_ROUTE);
    expect(employeeRow, 'the employee’s own row (Attendance Overview since r362) is a My Attendance row').toBeDefined();
    expect(
      { adminOnly: employeeRow!.adminOnly, managerUp: employeeRow!.managerUp },
      'an employee must reach their own record with no gate at all',
    ).toEqual({ adminOnly: undefined, managerUp: undefined });

    const adminRow = config.children.find((c) => c.href === ADMIN_ROUTE);
    expect(adminRow, 'Employee Attendance is an Administration row').toBeDefined();
    expect(adminRow!.adminOnly, 'and it is admin-gated').toBe(true);
    expect(adminRow!.labelKey).toBe('employeeAttendance');

    // The reporter's actual ask, stated as an assertion: the ADMINISTRATIVE address is no longer offered
    // from My Attendance. This is the line that fails if a later round "helpfully" puts it back.
    expect(
      mine.children.map((c) => c.href),
      'the administrative /attendance row has left My Attendance, which is the whole item',
    ).not.toContain(ADMIN_ROUTE);
    // …and its mirror: the employee route must never travel into the group-gated Administration node,
    // where it would render for nobody but administrators. That is the a324a4b3 rev2 regression, reached
    // by the opposite road.
    expect(config.children.map((c) => c.href)).not.toContain(EMPLOYEE_ROUTE);
  });
});

describe('f3e6c36e — THE TAB TRAP: the employee screen does not borrow the admin strip', () => {
  /**
   * The approved plan named this trap explicitly, because r274 had already hit it: `components/
   * attendance-tabs.tsx` links to `/attendance`, `/attendance/daily` and `/attendance/individual`. A
   * distinct route that renders that strip drops the reader out of their own screen on the first click —
   * they enter by one door and leave by another without asking to.
   *
   * THE DECISION TAKEN, AND WHY. The plan offered two acceptable answers: an employee-scoped tab set of
   * its own, or no tabs at all. NO TABS was chosen. The admin strip's three tabs are three ADMIN
   * questions — everybody's month, everybody's day, pick an employee — and for one person reading their
   * own record there is exactly one view. A second strip would have had to invent routes with no distinct
   * job, each carrying its own reads and its own matrix column, which is the duplicate-concepts failure
   * the graph check exists to prevent. One screen, one job.
   *
   * So this is a DELIBERATE ABSENCE, and an absence expires silently — hence the assertion.
   */
  it('renders no tab strip, and does not import the admin one', () => {
    const src = stripComments(read(EMPLOYEE_PAGE));
    expect(src, 'the admin tab strip is not imported').not.toContain('attendance-tabs');
    expect(src, 'and is not rendered').not.toContain('<AttendanceTabs');
  });

  it('and links to none of the admin tab routes', () => {
    const src = stripComments(read(EMPLOYEE_PAGE));
    for (const href of ['/attendance/daily', '/attendance/individual']) {
      expect(src, `${href} is an admin tab route and must not be linked from the employee screen`).not.toContain(
        href,
      );
    }
    // `/attendance` as a bare href would be the same escape hatch by hand. Every link this page writes is
    // to its own route, so the string only ever appears with the `/my-records` suffix.
    const bareAdminLinks = [...src.matchAll(/href=\{?["'`](\/attendance)(?![/\w-])/g)];
    expect(bareAdminLinks.map((m) => m[0]), 'no hand-written link back to the admin screen').toEqual([]);
  });
});

describe('f3e6c36e — the administrative affordances are ABSENT from the employee screen, not hidden', () => {
  /**
   * The plan's words: "not hidden by CSS, absent from the tree". A `hidden` class, a `display:none`, or a
   * role check that still ships the markup would all leave an employee one dev-tools keystroke from an
   * administrative control, and would also mean the split had not really happened.
   *
   * Absence is proved at the SOURCE because that is where it is decidable: a control this file never
   * mentions cannot be rendered by it under any session. The render walk on a dev server (both roles) is
   * what proves the other direction — that the page works at all — and it ran for this round.
   */
  const src = stripComments(read(EMPLOYEE_PAGE));

  it.each([
    ['the employee picker', 'filters.selectEmployee'],
    ['the employee list the picker is built from', 'listEmployees'],
    ['the recompute entry', '/attendance/recompute'],
    ['punch import', '/attendance/import'],
    ['the OT report export island', 'OtReportExport'],
    ['the corrections worklist', 'listAttendanceCorrections'],
    ['the correction decision action', 'decideCorrectionAction'],
  ])('%s is not in the employee screen at all', (_what, needle) => {
    expect(src, `${needle} must not appear in ${EMPLOYEE_PAGE}`).not.toContain(needle);
  });

  it('nothing is merely hidden: the page has no role branch and no hidden class', () => {
    // A role branch is the shape this assertion is really about. The moment the employee screen asks
    // "is the viewer an admin?", it has started being the shared screen again — which is the thing the
    // reporter asked us to stop having.
    expect(src, 'no admin role branch').not.toMatch(/isAdmin|hr_admin|super_admin/);
    // Token-exact, not a substring sweep: `overflow-hidden` on a card is a scroll container and has
    // nothing to do with concealing a control, while a bare `hidden` (or `sm:hidden`) utility IS the
    // failure this case is about. Matching the substring would have forbidden the former and taught the
    // next reader to delete the assertion rather than understand it.
    const classTokens = [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
      .flatMap((m) => (m[1] ?? m[2]).split(/\s+/))
      .filter(Boolean);
    const concealing = classTokens.filter((tok) => /^(?:[a-z-]+:)?hidden$/.test(tok));
    expect(concealing, 'nothing is hidden by class instead of being absent').toEqual([]);
    expect(src, 'and nothing is hidden by inline style either').not.toMatch(/display:\s*['"]?none/);
  });

  it('THE DATA FENCE, INVERTED (r362): the page makes no attendance read at all', () => {
    /**
     * ⚠️ 2aef3cd8 (r362) — THE OLD CLAIM WAS:
     *   expect(src, 'the caller’s own employment is resolved server-side').toContain('myEmployment(s)');
     *   expect(src, 'and the range read is keyed on it')
     *     .toMatch(/attendanceForEmploymentRange\(\s*s,\s*me\.employmentId/);
     * It was TRUE, and it is now MOOT rather than wrong: the reporter asked for everything under this row
     * to be removed, so there is no read left to fence. Rewritten rather than deleted, for two reasons.
     * The replacement invariant is STRICTLY STRONGER — a page that reads nothing cannot show anybody's
     * rows, whoever opens it — and a later round that puts content back has to walk past this comment and
     * consciously re-state which fence it is choosing, instead of finding no assertion here at all.
     */
    expect(src, 'no employment is resolved here any more').not.toContain('myEmployment');
    expect(src, 'and no attendance range read remains').not.toContain('attendanceForEmploymentRange');
    // The two calls that MUST survive the emptying, or the route stops being an authenticated page and
    // test/function-access.test.ts's "no stale routes" fails on a registered route with no guarded file.
    expect(src, 'the authentication boundary is still crossed').toContain('await scopedSession()');
    expect(src, 'and the module courtesy redirect is still in place').toContain("requireModule('attendance')");
    // Unchanged from r287 and still worth stating: `scopeIds` here would mean the page had started
    // answering a question about other people.
    expect(src, 'no company scope is resolved here').not.toContain('scopeIds');
  });

  it('it is read-only: no form, no server action, no write', () => {
    // Zero attendance rows may be created, deleted or recomputed by this round. A screen with no writer
    // cannot do any of the three, so that is what is asserted rather than a count nobody re-runs.
    expect(src, 'no server action is imported').not.toMatch(/from '\.\/actions'|from '\.\.\/actions'/);
    expect(src, 'no form posts from this screen').not.toMatch(/<form\b/);
  });
});

describe('f3e6c36e — the employee screen says the same thing the admin screen does', () => {
  it('imports no figure module it no longer renders — and none of them was deleted (r362)', () => {
    /**
     * ⚠️ 2aef3cd8 (r362) — THE OLD CLAIM WAS: "reuses the shared formatters, derivations and explanation
     * island", i.e. the employee screen MUST import '@/components/attendance-format',
     * '@/components/attendance-figure-cells', '@/core/attendance-derive' and '@/core/attendance-explain',
     * so that it and the administrator's screen could not describe one day two different ways. All four
     * imports went with the table this round.
     *
     * The rule is not withdrawn, it is SUSPENDED WITH ITS SUBJECT: nothing can be duplicated while nothing
     * is rendered, and the moment an attendance figure returns to this screen it must return through those
     * same four modules rather than through a private copy. So the case is inverted AND made to assert the
     * other half of the plan's promise, which is the half a reader is most likely to doubt: "delete the
     * frontend code used only by this page" had no subject, because every import was shared. None of the
     * four files was deleted and zero files were orphaned.
     */
    const src = stripComments(read(EMPLOYEE_PAGE));
    for (const shared of [
      '@/components/attendance-format',
      '@/components/attendance-figure-cells',
      '@/core/attendance-derive',
      '@/core/attendance-explain',
    ]) {
      expect(src, `${shared} must not be imported by a screen that renders no figure`).not.toContain(shared);
      const base = path.join(ROOT, shared.replace('@/', ''));
      expect(
        fs.existsSync(`${base}.ts`) || fs.existsSync(`${base}.tsx`),
        `${shared} must still EXIST — it has other callers and was NOT deleted with the table`,
      ).toBe(true);
    }
    // …and no locally redefined formatter, which is exactly how the two would drift. The only way this can
    // fail now is a hand-rolled formatter arriving with new content, which is precisely the case to catch.
    expect(src, 'no private fmtMin copy').not.toMatch(/const\s+fmtMin\s*=/);
  });

  it('its labels resolve in all six locales, with the three dead strings retired in place', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${loc}.json`));
      expect(typeof m.nav?.myRecords, `${loc}: nav.myRecords`).toBe('string');
      expect(String(m.nav.myRecords).trim(), `${loc}: nav.myRecords is blank`).not.toBe('');
      expect(typeof m.attendance?.myRecords?.title, `${loc}: attendance.myRecords.title`).toBe('string');
      // 2aef3cd8 (r362) — the menu row and the h1 are ONE string, as they were before the rename, so a
      // half-applied rename (the row says Attendance Overview, the page still says My Records) fails here.
      expect(m.attendance.myRecords.title, `${loc}: the row and the page title must read the same`).toBe(
        m.nav.myRecords,
      );
      expect(String(m.nav.myRecords), `${loc}: the live label must not itself be a retired marker`).not.toContain(
        '[retired',
      );
      /**
       * ⚠️ 2aef3cd8 (r362) — THE OLD CLAIM WAS that `intro`, `notLinked` and `correctionNote` are LIVE
       * strings, asserted beside `title` as non-blank in every locale, because the page rendered all four.
       * The page renders only the title now. The keys are RETIRED IN PLACE and NOT deleted: i18n/request.ts
       * deep-merges each locale over English, so dropping a key from en.json alone leaves the Malay and
       * Chinese sentences still rendering while the English one vanishes. The marker is what stops a
       * retired key being read as live copy, and it is the r355 convention
       * (test/76dbcaa1-special-leave.test.ts) applied here rather than a second convention invented.
       */
      for (const k of ['intro', 'notLinked', 'correctionNote']) {
        expect(typeof m.attendance.myRecords[k], `${loc}: attendance.myRecords.${k} must still EXIST`).toBe('string');
        expect(
          String(m.attendance.myRecords[k]),
          `${loc}: ${k} must be marked retired, not left reading as live copy`,
        ).toMatch(/^\[retired r362 —/);
      }
      // The rail must not say the same word for the employee's screen and the administrator's, in ANY
      // locale — translating one half and not the other re-creates the collision in that language alone,
      // which i18n-check.mjs cannot see (it checks a key exists, never that its value is distinct).
      expect(m.nav.myRecords, `${loc}: Attendance Overview must not read as Employee Attendance`).not.toBe(
        m.nav.employeeAttendance,
      );
    }
  });
});

/**
 * 2aef3cd8 (r362) — THE ACCESS-GRID SCOPE NOTE PROMISED SOMETHING THE SCREEN NO LONGER SHOWS.
 *
 * `lib/permissions.ts` sets `hasScopeNote: true` on the `myAttendanceRecords` column, so /admin/users
 * renders `admin.users.scope.myAttendanceRecords` beside it (app/admin/users/page.tsx). In English it read
 * "Everyone can open this; whoever you are, it shows only your own attendance." — true of r287's screen,
 * false the moment the day table was removed. A false sentence on the permissions grid is worse than no
 * sentence: it is the one place an administrator goes to find out what a role can see.
 *
 * The flag stays TRUE and the note is REWORDED rather than the flag being flipped off, because
 * test/function-access.test.ts asserts the note resolves whenever the flag is set — so keeping the flag
 * keeps the sentence under guard for whatever content arrives here later.
 *
 * The retired sentences are quoted in full, in all six locales, so a future round cannot restore one by
 * copy-paste — and the check spans the whole `admin.users.scope` bag rather than this one key, because
 * moving the claim to a neighbouring column's note would otherwise pass while the grid still printed it.
 * The shape is 639bf4a5 (g)'s, in test/work-location-organization-relocation.test.ts.
 */
describe('2aef3cd8 — the retired scope-note claim is gone from all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

  /** What `admin.users.scope.myAttendanceRecords` said until r362 emptied the screen. */
  const RETIRED_CLAIM: Record<(typeof LOCALES)[number], string> = {
    en: 'Everyone can open this; whoever you are, it shows only your own attendance.',
    ms: 'Semua orang boleh membukanya; sesiapa pun anda, ia hanya memaparkan kehadiran anda sendiri.',
    ta: 'அனைவரும் இதைத் திறக்கலாம்; நீங்கள் யாராக இருந்தாலும், உங்கள் சொந்த வருகையை மட்டுமே இது காட்டுகிறது.',
    th: 'ทุกคนเปิดได้ ไม่ว่าคุณจะเป็นใคร หน้านี้แสดงเฉพาะการเข้างานของคุณเองเท่านั้น',
    vi: 'Mọi người đều có thể mở; dù bạn là ai, màn hình này chỉ hiển thị chấm công của chính bạn.',
    zh: '所有人都可打开；无论你是谁，此页面只显示你自己的考勤。',
  };

  it.each(LOCALES)('%s: the note still resolves, and no longer promises an attendance record', (loc) => {
    const scope = JSON.parse(read(`messages/${loc}.json`)).admin.users.scope as Record<string, unknown>;
    const note = scope.myAttendanceRecords;
    // Still present and non-empty: `hasScopeNote` is true, so an absent note is a blank cell on the grid.
    expect(typeof note, `${loc}: admin.users.scope.myAttendanceRecords must resolve`).toBe('string');
    expect(String(note).trim(), `${loc}: and must not be blank`).not.toBe('');
    const strings = Object.values(scope).filter((v): v is string => typeof v === 'string');
    const offenders = strings.filter((v) => v.includes(RETIRED_CLAIM[loc]));
    expect(
      offenders,
      `${loc}: /attendance/my-records shows no attendance at all since r362 — the grid must not say it does`,
    ).toEqual([]);
  });
});
