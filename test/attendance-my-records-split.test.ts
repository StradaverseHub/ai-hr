/**
 * f3e6c36e (r287) — THE SPLIT: My Attendance › My Records vs Administration › Attendance › Employee
 * Attendance. The promises this round made, and the two traps the approved plan named by name.
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
    expect(read(EMPLOYEE_PAGE).split('\n').length, 'it is a real screen, not a redirect stub').toBeGreaterThan(40);
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
    expect(employeeRow, 'My Records is a My Attendance row').toBeDefined();
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

  it('THE DATA FENCE: the only attendance read is keyed on the caller’s own employment', () => {
    // Stronger than a company scope narrowed by a filter, and the reason "and nothing else" in the plan is
    // literally true: an ADMINISTRATOR opening this screen sees their own record and nobody else's.
    expect(src, 'the caller’s own employment is resolved server-side').toContain('myEmployment(s)');
    expect(src, 'and the range read is keyed on it').toMatch(/attendanceForEmploymentRange\(\s*s,\s*me\.employmentId/);
    // No company-scope read at all — `scopeIds` on this page would mean it had started answering a
    // question about other people.
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
  it('reuses the shared formatters, derivations and explanation island', () => {
    // Both screens read the SAME attendance rows through the SAME engine — that was the plan's promise
    // that "nothing is duplicated, nothing is recalculated, and no figure moves". A private copy of any of
    // these is how the employee's screen and the administrator's would start describing one day two
    // different ways, with nothing failing.
    const src = read(EMPLOYEE_PAGE);
    // Imports, so the RAW source is right here — an import inside a comment is not an import.
    for (const shared of [
      '@/components/attendance-format',
      '@/components/attendance-figure-cells',
      '@/core/attendance-derive',
      '@/core/attendance-explain',
    ]) {
      expect(src, `the employee screen must reuse ${shared}`).toContain(shared);
    }
    // …and no locally redefined formatter, which is exactly how the two would drift.
    expect(src, 'no private fmtMin copy').not.toMatch(/const\s+fmtMin\s*=/);
  });

  it('its labels resolve in all six locales', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${loc}.json`));
      expect(typeof m.nav?.myRecords, `${loc}: nav.myRecords`).toBe('string');
      expect(String(m.nav.myRecords).trim(), `${loc}: nav.myRecords is blank`).not.toBe('');
      for (const k of ['title', 'intro', 'notLinked', 'correctionNote']) {
        expect(typeof m.attendance?.myRecords?.[k], `${loc}: attendance.myRecords.${k}`).toBe('string');
        expect(String(m.attendance.myRecords[k]).trim(), `${loc}: attendance.myRecords.${k} is blank`).not.toBe('');
      }
      // The rail must not say the same word for the employee's screen and the administrator's, in ANY
      // locale — translating one half and not the other re-creates the collision in that language alone,
      // which i18n-check.mjs cannot see (it checks a key exists, never that its value is distinct).
      expect(m.nav.myRecords, `${loc}: My Records must not read as Employee Attendance`).not.toBe(
        m.nav.employeeAttendance,
      );
    }
  });
});
