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
 * ⚠️ AND THEN READ THIS — 67268d83 (r367) ROUND ONE PUT THE DAY LIST BACK, so THREE of those four r362
 * inversions are themselves reversed here, each one again quoting what it reverses: the data fence
 * (`myEmployment` + `attendanceForEmploymentRange` are back, and the fence is the employment id again),
 * the shared-derivation reuse (the figures are back, so they must come back THROUGH the shared modules,
 * which is exactly what r362's own comment instructed the next round to re-state), and the retired-key
 * loop (`intro` and `notLinked` have their subjects back; `correctionNote` does not and stays retired).
 * The read-only case is widened rather than inverted: the screen gained a Date From / Date To GET filter,
 * which navigates and writes nothing, so "no form at all" becomes the stronger "no form that writes".
 *
 * The r362 cases that are NOT reversed, and why: the tab trap, every absent administrative affordance, the
 * no-hidden-controls rule, the label collision and the WHERE/WHO of the row are all unchanged by r367 —
 * round one adds a list of the reader's own days and nothing administrative — and the scope note is
 * REWORDED a second time rather than restored, because the r362 sentence is now false in the other
 * direction while the sentence r287 wrote stays forbidden.
 *
 * NEW in r367, and the reason they are here rather than in a file of their own: the two axes (six statuses
 * the kernel can produce, three flags it reports separately) and the bounded date range are properties of
 * THIS page's source, asserted beside the fence they share a file with.
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

  it('THE DATA FENCE, RE-STATED (r367): the one read is keyed on the caller’s own employment', () => {
    /**
     * ⚠️ 2aef3cd8 (r362) — THE CLAIM BEFORE LAST WAS:
     *   expect(src, 'the caller’s own employment is resolved server-side').toContain('myEmployment(s)');
     *   expect(src, 'and the range read is keyed on it')
     *     .toMatch(/attendanceForEmploymentRange\(\s*s,\s*me\.employmentId/);
     * r362 emptied the screen, so it became MOOT rather than wrong and was inverted to "no employment is
     * resolved here any more" / "no attendance range read remains", with the standing instruction that a
     * later round putting content back must walk past that comment and consciously re-state which fence it
     * chooses.
     *
     * ⚠️ 67268d83 (r367) ROUND ONE IS THAT ROUND, AND THIS IS THAT RE-STATEMENT. The fence chosen is the
     * one r287 chose, for the reason r287 gave: the single attendance read is keyed on the EMPLOYMENT ID
     * resolved server-side from the session, so the screen is structurally incapable of showing another
     * person's rows whoever opens it — a stronger fence than a company scope narrowed by a filter. An
     * administrator opening it sees their own record and nobody else's.
     *
     * The idiom `myEmployment(s)` that the r362 comment quotes is a COMMENT idiom (the sibling loop in
     * test/attendance-menu-relocation.test.ts reads it off raw source). This file strips comments, so the
     * CALL is what is matched here — which is the stronger reading anyway: a comment cannot fence data.
     */
    expect(src, 'the caller’s own employment is resolved server-side').toMatch(/myEmployment\(\s*s\s*\)/);
    expect(src, 'and the range read is keyed on it, not on a company scope').toMatch(
      /attendanceForEmploymentRange\(\s*s,\s*me\.employmentId/,
    );
    // The two calls that survived the emptying and must keep surviving, or the route stops being an
    // authenticated page and test/function-access.test.ts's "no stale routes" fails on a registered route.
    expect(src, 'the authentication boundary is still crossed').toContain('await scopedSession()');
    expect(src, 'and the module courtesy redirect is still in place').toContain("requireModule('attendance')");
    // Unchanged from r287 and r362, and the assertion that keeps the fence the EMPLOYMENT and not the
    // company: `scopeIds` here would mean the page had started answering a question about other people.
    expect(src, 'no company scope is resolved here').not.toContain('scopeIds');
  });

  it('it is read-only: no server action, no write, and the only form navigates', () => {
    /**
     * ⚠️ 2aef3cd8 (r362) — THE OLD CLAIM WAS:
     *   expect(src, 'no form posts from this screen').not.toMatch(/<form\b/);
     * Correct for a blank page and WRONG as a rule: 67268d83 round one gives the employee a Date From /
     * Date To / Apply filter, and the house idiom for a filter (app/attendance/individual/page.tsx) is a
     * plain `method="GET"` form that NAVIGATES. Forbidding the element would have pushed the filter into a
     * client island or a server action — more machinery, and a real writer where there was none.
     *
     * So the invariant is stated as what it was always about: this screen creates, deletes and recomputes
     * zero attendance rows. A GET form cannot; a POST form or an `action={…}` binding could.
     */
    expect(src, 'no server action is imported').not.toMatch(/from '\.\/actions'|from '\.\.\/actions'/);
    const forms = [...src.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
    for (const f of forms) {
      expect(f, 'every form on this screen submits by navigating (method="GET")').toContain('method="GET"');
      // `action={…}` is how a server action binds to a form; `action="/path"` would be a POST target.
      expect(f, 'and none of them binds a server action or a post target').not.toMatch(/\saction[=\s]/);
    }
  });
});

describe('f3e6c36e — the employee screen says the same thing the admin screen does', () => {
  it('the figures came back THROUGH the shared modules, and the two round-two ones are still untouched', () => {
    /**
     * ⚠️ 2aef3cd8 (r362) — THE CLAIM BEFORE LAST WAS: "reuses the shared formatters, derivations and
     * explanation island", i.e. the employee screen MUST import '@/components/attendance-format',
     * '@/components/attendance-figure-cells', '@/core/attendance-derive' and '@/core/attendance-explain',
     * so that it and the administrator's screen could not describe one day two different ways. All four
     * imports went with the table in r362, and the case was inverted to "must NOT be imported by a screen
     * that renders no figure" plus "must still EXIST", carrying this standing instruction: the rule is
     * SUSPENDED WITH ITS SUBJECT, and "the moment an attendance figure returns to this screen it must
     * return through those same four modules rather than through a private copy".
     *
     * ⚠️ 67268d83 (r367) — THE FIGURES ARE BACK, so the instruction is discharged, and it splits two ways
     * because the two pairs of modules serve two different screens:
     *
     *   • attendance-format + attendance-derive render the LIST — the hour columns, the status and the
     *     flag. Asserted as REQUIRED again, which is the reversal.
     *   • attendance-figure-cells + attendance-explain render the eight figure cells WITH THEIR STORED
     *     WORKING, which is the day DETAIL screen (app/attendance/individual/[date]/page.tsx is the
     *     specification, and its employee twin is round TWO of this item). 570fd56e took those eight
     *     columns off HR's own list for the same reason they are off this one: six of them hold 0.00 on an
     *     ordinary day. So they stay absent here AND stay existing — the r362 half of the case that is
     *     still true, kept rather than dropped, with the round it is waiting for named.
     *
     * The derive module is reached through the pack facade `@/packs/attendance/service`, which re-exports
     * core/attendance-derive verbatim (packs/attendance/service.ts) — ADR-0080 D11's door for a screen that
     * also needs the DB-backed range read. Either specifier satisfies the anti-duplication rule, because
     * both resolve to the one implementation; a private copy satisfies neither, which is what is checked.
     */
    const src = stripComments(read(EMPLOYEE_PAGE));

    expect(src, 'the shared formatters render the hour columns').toContain('@/components/attendance-format');
    // statusOf and flagOf must be IMPORTED from the shared derivation module (directly or through the pack
    // facade that re-exports it), never redefined. The specifier is pinned so a hand-rolled `statusOf` in a
    // local helper file cannot pass by exporting the same name.
    expect(src, 'statusOf/flagOf come from the shared derivation module').toMatch(
      /import\s*\{[^}]*\bstatusOf\b[^}]*\}\s*from\s*'(?:@\/core\/attendance-derive|@\/packs\/attendance\/service)'/,
    );
    expect(src, 'and so does flagOf').toMatch(
      /import\s*\{[^}]*\bflagOf\b[^}]*\}\s*from\s*'(?:@\/core\/attendance-derive|@\/packs\/attendance\/service)'/,
    );

    for (const roundTwo of ['@/components/attendance-figure-cells', '@/core/attendance-explain']) {
      expect(src, `${roundTwo} renders the day DETAIL figures — round two, not this list`).not.toContain(roundTwo);
      const base = path.join(ROOT, roundTwo.replace('@/', ''));
      expect(
        fs.existsSync(`${base}.ts`) || fs.existsSync(`${base}.tsx`),
        `${roundTwo} must still EXIST — it has other callers and was NOT deleted with the table`,
      ).toBe(true);
    }

    // …and no locally redefined formatter or derivation, which is exactly how the two screens would drift.
    expect(src, 'no private fmtMin copy').not.toMatch(/const\s+fmtMin\s*=/);
    expect(src, 'no private statusOf copy').not.toMatch(/(?:const|function)\s+statusOf\b/);
    expect(src, 'no private flagOf copy').not.toMatch(/(?:const|function)\s+flagOf\b/);
    // r287's private `const dayName = …` (an en-GB weekday, hardcoded) is exactly the drift this forbids:
    // fmtDayName takes the viewer's locale, and the old copy printed an English weekday in a Thai screen.
    expect(src, 'no private weekday formatter').not.toMatch(/const\s+dayName\s*=/);
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
       * ⚠️ 2aef3cd8 (r362) — THE CLAIM BEFORE LAST WAS that `intro`, `notLinked` and `correctionNote` are
       * LIVE strings, asserted beside `title` as non-blank in every locale, because the page rendered all
       * four. r362 rendered only the title, so all three were RETIRED IN PLACE and NOT deleted —
       * i18n/request.ts deep-merges each locale over English, so dropping a key from en.json alone leaves
       * the Malay and Chinese sentences still rendering while the English one vanishes — and the loop
       * asserted that each one starts with the `[retired r362 —` marker.
       *
       * ⚠️ 67268d83 (r367) ROUND ONE SPLITS THE THREE, because their subjects came back separately:
       *
       *   • `intro` — the helper line above the day table. The table is back, so it is REVIVED.
       *   • `notLinked` — the "your login is not linked to an active employment" branch. The page resolves
       *     an employment again, so that branch is back and so is its sentence.
       *   • `correctionNote` — the footer pointing at Attendance Request. NOT revived: the per-row
       *     correction marker is round THREE and needs a date-filtered correction read that does not exist
       *     (myAttendanceCorrections is capped at 100/500 with no date filter — using it over a range is
       *     the capped-list defect f618065d found). Reviving the sentence now would promise a marker the
       *     screen does not draw, so it stays retired and is asserted as retired.
       *
       * Revived keys are checked for the marker's ABSENCE as well as non-blankness: a half-applied revival
       * that changed en.json and left five locales reading "[retired r362 — …" is exactly the failure the
       * deep-merge makes invisible.
       */
      for (const k of ['intro', 'notLinked']) {
        const v = String(m.attendance.myRecords[k]);
        expect(typeof m.attendance.myRecords[k], `${loc}: attendance.myRecords.${k} must exist`).toBe('string');
        expect(v.trim(), `${loc}: ${k} is live again (r367) and must not be blank`).not.toBe('');
        expect(v, `${loc}: ${k} is rendered again — it must not still read as a retirement marker`).not.toContain(
          '[retired',
        );
      }
      {
        const v = String(m.attendance.myRecords.correctionNote);
        expect(typeof m.attendance.myRecords.correctionNote, `${loc}: correctionNote must still EXIST`).toBe('string');
        expect(v, `${loc}: correctionNote stays retired until round three draws the marker`).toMatch(
          /^\[retired r362 —/,
        );
      }
      // The r367 strings, in every locale: the refusal the bounded range needs and the leave-type limit the
      // screen states out loud. A missing one is a MISSING_MESSAGE on a screen a person is reading.
      for (const k of ['rangeTooLong', 'rangeInverted', 'leaveTypeNote']) {
        const v = m.attendance.myRecords[k];
        expect(typeof v, `${loc}: attendance.myRecords.${k} must resolve`).toBe('string');
        expect(String(v).trim(), `${loc}: ${k} must not be blank`).not.toBe('');
      }
      // Both ICU arguments must survive translation, or the refusal prints without the numbers that make it
      // actionable. (scripts/i18n-check.mjs checks placeholder parity globally; this names the two that
      // carry the ceiling, because a refusal that cannot say the limit is not a refusal.)
      for (const arg of ['{days}', '{max}']) {
        expect(String(m.attendance.myRecords.rangeTooLong), `${loc}: rangeTooLong keeps ${arg}`).toContain(arg);
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
 *
 * ⚠️ 67268d83 (r367) — THE SCREEN SHOWS ATTENDANCE AGAIN, SO THE r362 SENTENCE IS NOW THE FALSE ONE, and
 * the note is reworded A SECOND TIME. Both retired sentences are quoted below and both are forbidden,
 * which is the only arrangement that is honest about this key's history:
 *
 *   • r287's sentence is still forbidden. It is not merely stale — "it shows only your own attendance" was
 *     written for a month-at-a-time screen and says nothing about the reader CHOOSING the range, which is
 *     the new thing an administrator reading the grid needs to know. Restoring it by copy-paste is what
 *     r362 built this case to stop, and reversing the screen does not make a copy-paste correct.
 *   • r362's sentence is forbidden from today, for the same reason r362 forbade r287's: it is a FALSE
 *     sentence on the one grid an administrator goes to for what a role can see, and it is false in the
 *     more dangerous direction — it under-promises, so nobody chasing a leak would look here.
 *
 * And the positive half, which is what makes this more than a blacklist: the note must state that the
 * reader's OWN attendance is what the screen shows. A sentence that forgets the fence is the failure this
 * key exists to prevent, and neither forbidden string would catch it.
 */
describe('2aef3cd8 / 67268d83 — both retired scope-note claims are gone from all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

  /** What `admin.users.scope.myAttendanceRecords` said until r362 emptied the screen. */
  const RETIRED_R287: Record<(typeof LOCALES)[number], string> = {
    en: 'Everyone can open this; whoever you are, it shows only your own attendance.',
    ms: 'Semua orang boleh membukanya; sesiapa pun anda, ia hanya memaparkan kehadiran anda sendiri.',
    ta: 'அனைவரும் இதைத் திறக்கலாம்; நீங்கள் யாராக இருந்தாலும், உங்கள் சொந்த வருகையை மட்டுமே இது காட்டுகிறது.',
    th: 'ทุกคนเปิดได้ ไม่ว่าคุณจะเป็นใคร หน้านี้แสดงเฉพาะการเข้างานของคุณเองเท่านั้น',
    vi: 'Mọi người đều có thể mở; dù bạn là ai, màn hình này chỉ hiển thị chấm công của chính bạn.',
    zh: '所有人都可打开；无论你是谁，此页面只显示你自己的考勤。',
  };

  /** What it said between r362 and r367, while the screen was blank below its title. */
  const RETIRED_R362: Record<(typeof LOCALES)[number], string> = {
    en: 'It shows no attendance data at all',
    ms: 'Ia tidak memaparkan apa-apa data kehadiran',
    ta: 'இது எந்த வருகைத் தரவையும் காட்டுவதில்லை',
    th: 'แต่หน้านี้ไม่แสดงข้อมูลการลงเวลาใด ๆ เลย',
    vi: 'Trang này không hiển thị bất kỳ dữ liệu chấm công nào',
    zh: '此页面不显示任何考勤数据',
  };

  /**
   * The word for the reader's OWN attendance, per locale — the fence the sentence must still carry. Kept
   * short on purpose: pinning a whole sentence would forbid the next legitimate rewording, while pinning
   * the one concept that must never drop out does not.
   */
  const OWN: Record<(typeof LOCALES)[number], string> = {
    en: 'own attendance',
    ms: 'kehadiran pembaca itu sendiri',
    ta: 'சொந்த வருகை',
    th: 'การเข้างานของผู้อ่านเอง',
    vi: 'chấm công của chính người đọc',
    zh: '本人',
  };

  it.each(LOCALES)('%s: the note resolves, says whose attendance it is, and repeats neither retired claim', (loc) => {
    const scope = JSON.parse(read(`messages/${loc}.json`)).admin.users.scope as Record<string, unknown>;
    const note = scope.myAttendanceRecords;
    // Still present and non-empty: `hasScopeNote` is true, so an absent note is a blank cell on the grid.
    expect(typeof note, `${loc}: admin.users.scope.myAttendanceRecords must resolve`).toBe('string');
    expect(String(note).trim(), `${loc}: and must not be blank`).not.toBe('');
    // The positive claim (r367): the screen shows the READER'S OWN attendance and nobody else's.
    expect(String(note), `${loc}: the note must still say whose attendance this screen shows`).toContain(OWN[loc]);

    const strings = Object.values(scope).filter((v): v is string => typeof v === 'string');
    expect(
      strings.filter((v) => v.includes(RETIRED_R287[loc])),
      `${loc}: the r287 sentence is retired — the range the reader chooses is now part of the answer`,
    ).toEqual([]);
    expect(
      strings.filter((v) => v.includes(RETIRED_R362[loc])),
      `${loc}: /attendance/my-records shows a day list again since r367 — the grid must not say it shows nothing`,
    ).toEqual([]);
  });
});

/**
 * 67268d83 (r367) ROUND ONE — THE TWO AXES, AND THE RANGE THAT CANNOT TRUNCATE.
 *
 * ── WHY THIS IS A GUARD AND NOT A DETAIL ────────────────────────────────────────────────────────────
 * The reporter listed EIGHT states and called all eight statuses: Present, Absent, Off Day, Rest Day,
 * Public Holiday, Late, Incomplete and Leave. The kernel makes SIX (`statusOf`) and reports the other two
 * on a separate axis (`flagOf` → late · under · odd). Drawing Late as a status would assert a choice the
 * kernel never makes — a late day IS a present day — and would put this screen's account of a day at odds
 * with HR's, which is the one thing the whole item exists to avoid. The plan told the reporter so in as
 * many words, so it is a promise and not a preference.
 *
 * The six are read OFF THE KERNEL rather than typed out here, so a seventh status added to
 * core/attendance-derive.ts fails this case and forces a decision about the screen instead of quietly
 * rendering `undefined` in a cell.
 *
 * ── AND THE HAZARD ──────────────────────────────────────────────────────────────────────────────────
 * `attendanceForEmploymentRange` walks at most `ATTENDANCE_RANGE_MAX_DAYS` days and then STOPS, returning a
 * short array that reads as "you have no attendance after that date". Unreachable while administrators
 * chose ranges; one address-bar edit away now that an employee does. The behavioural half — that the loop
 * really truncates, and that the resolver refuses before it can — is in
 * test/attendance-overview-round1.test.ts against real seeded days. THIS half is the part a later round
 * could undo with every other guard staying green: the page bounding its range against the kernel's own
 * constant, and not issuing the read at all when it refuses.
 */
describe('67268d83 — six statuses, three flags, and a bounded range', () => {
  const src = stripComments(read(EMPLOYEE_PAGE));

  /** The literal members of a `export type X = 'a' | 'b' | null;` union, read off the kernel's source. */
  const unionMembers = (source: string, typeName: string): string[] => {
    const m = source.match(new RegExp(`export type ${typeName} =([^;]+);`));
    expect(m, `core/attendance-derive.ts must declare ${typeName}`).not.toBeNull();
    return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };

  /** The keys of a `const name: … = { a: …, b: … };` object literal in the page source. */
  const literalKeys = (name: string): string[] => {
    const at = src.indexOf(`const ${name}`);
    expect(at, `${EMPLOYEE_PAGE} must declare ${name}`).toBeGreaterThan(-1);
    const open = src.indexOf('{', at);
    const close = src.indexOf('};', open);
    expect(close, `${name} must be a closed object literal`).toBeGreaterThan(open);
    return [...src.slice(open, close).matchAll(/(\w+)\s*:/g)].map((x) => x[1]);
  };

  const derive = read('core/attendance-derive.ts');

  it('the Status column offers EXACTLY the statuses the kernel can produce — no Late, no Incomplete', () => {
    const kernel = unionMembers(derive, 'AttendanceStatus');
    expect(kernel.sort(), 'the kernel’s v1 status set').toEqual(
      ['absent', 'off', 'on_leave', 'ph', 'present', 'rest'].sort(),
    );
    expect(
      literalKeys('statusText').sort(),
      'the screen’s Status labels must be exactly the kernel’s statuses: a seventh is a state the kernel ' +
        'never returns, and a missing one renders undefined in a cell',
    ).toEqual(kernel.sort());
    // Named explicitly, because these two are the ones the reporter asked for AS statuses and the plan
    // promised as notes instead. `late` is flagOf's word; `incomplete` is the reporter's word for `odd`.
    for (const notAStatus of ['late', 'incomplete', 'odd', 'under']) {
      expect(literalKeys('statusText'), `${notAStatus} is not a status the kernel produces`).not.toContain(
        notAStatus,
      );
    }
  });

  it('the three flags are the kernel’s three, in their own Note column', () => {
    const kernelFlags = unionMembers(derive, 'AttendanceFlag');
    expect(kernelFlags.sort(), 'late · under · odd (null is the absence of a flag, not a fourth)').toEqual(
      ['late', 'odd', 'under'].sort(),
    );
    expect(literalKeys('flagText').sort(), 'the screen’s Note labels are exactly those three').toEqual(
      kernelFlags.sort(),
    );
    // `under` is the flag the reporter did not ask for and gets anyway (the plan says so in as many words),
    // so it is named here: dropping it would be a silent walk-back of a stated promise.
    expect(literalKeys('flagText'), 'the short-hours flag is shown, as promised').toContain('under');
  });

  it('status and note are two COLUMNS, not one cell that mixes the axes', () => {
    expect(src, 'the Status header is rendered').toContain("t('colStatus')");
    expect(src, 'and the Note header beside it').toContain("t('colNote')");
    // The failure this is really about: a single cell printing "Present · Late" (or a Late chip where the
    // status belongs) collapses the two axes back into one and re-asserts the choice the kernel refuses.
    const cells = src.split(/<td\b/);
    const mixed = cells.filter((c) => c.includes('statusText[') && c.includes('flagText['));
    expect(mixed.length, 'no single cell renders both a status and a flag').toBe(0);
    expect(cells.filter((c) => c.includes('statusText[')).length, 'exactly one Status cell').toBe(1);
    expect(cells.filter((c) => c.includes('flagText[')).length, 'exactly one Note cell').toBe(1);
  });

  it('the date range is bounded by the KERNEL’s ceiling, and a refused range issues no read', () => {
    // The number is the kernel's, imported — not a second 400 typed here, which is how the screen's limit
    // and the loop's limit would drift apart and the cliff would come back.
    expect(src, 'the kernel’s published ceiling is what bounds the range').toContain('ATTENDANCE_RANGE_MAX_DAYS');
    expect(src, 'and it is what the resolver is given').toMatch(
      /resolveMyAttendanceRange\(\s*sp,\s*\w+,\s*ATTENDANCE_RANGE_MAX_DAYS\s*\)/,
    );
    /**
     * …and no SECOND copy of the number, which is how the screen's limit and the loop's limit would drift
     * apart after somebody raised one of them.
     *
     * Numeric TOKENS, not a `\b400\b` substring sweep: this page's status chips carry Tailwind colour
     * ramps (`dark:text-emerald-400`, `text-rose-400`), and a substring check matched those and failed on a
     * shade of green. A hyphen before the digits is what distinguishes a colour ramp from a day count, so
     * the token scan requires a non-word, non-hyphen character in front — the same reasoning the `hidden`
     * class-token check in this file already uses for `overflow-hidden`.
     */
    const numericTokens = [...src.matchAll(/(?:^|[^\w-])(\d+)(?![\w-])/g)].map((m) => m[1]);
    expect(numericTokens, 'the ceiling is imported, never re-typed as a bare 400').not.toContain('400');
    // THE REFUSAL IS A REFUSAL, NOT A CLAMP. A clamped range would show a record the reader did not ask
    // for while looking exactly like the one they did — the truncation defect moved one step later. So the
    // read must be conditional on there being no refusal.
    expect(src, 'the range read is skipped entirely when the range was refused').toMatch(
      /range\.refusal\s*\?\s*\[\]\s*:\s*await attendanceForEmploymentRange\(/,
    );
    expect(src, 'and the reader is told why, with the limit in the sentence').toContain(
      "t('myRecords.rangeTooLong'",
    );
    expect(src, 'an inverted range says so rather than reading as an empty record').toContain(
      "t('myRecords.rangeInverted')",
    );
  });

  it('the one thing the screen cannot say is said out loud, and only where it applies', () => {
    // approvedLeaveDates returns no leave-type code, so On Leave is all a leave day can be told. The plan
    // committed to stating that rather than letting the reporter discover it; the note renders only when a
    // leave day is on screen, because a caption printed over a month with no leave in it is noise.
    expect(src, 'the leave-type limit is stated').toContain("t('myRecords.leaveTypeNote')");
    expect(src, 'and only when a leave day is actually shown').toMatch(/statusOf\(r\)\s*===\s*'on_leave'/);
    // …and the limit is NOT worked around by inventing a sub-code. AL / ML / EL / RL are the codes
    // core/attendance-derive.ts documents as a follow-up; printing one here would be a fabricated fact.
    for (const invented of ["'AL'", "'ML'", "'EL'", "'RL'"]) {
      expect(src, `${invented} is a leave sub-code the read does not carry`).not.toContain(invented);
    }
  });
});
