/**
 * af7a8eb4 — Attendance module: full-width list screens, and the shift form on its own page.
 *
 * Source-static guard, in the house style of test/leave-config-full-width.test.ts. Nothing pinned either
 * page's markup before this, in EITHER direction: the shift form could silently come back onto the list,
 * and the width cap could silently come back onto any of the five list screens.
 *
 * What is pinned, and why each one:
 *
 *  A. The LIST screens in the Attendance menu use `pageWideCls` and carry no page-level width cap. On a
 *     1920px window the old `mx-auto max-w-4xl` left about 745px — 45 percent of the content area — as
 *     empty margin either side of the table. `/admin/toil` is DELIBERATELY not in the list: it is a short
 *     settings summary with no list and gains nothing from the extra width.
 *
 *     r227 ADDED THE EMPLOYEE'S OWN SCREEN to that list, on the identical complaint from the identical
 *     reporter: /attendance/requests was `mx-auto max-w-6xl` AND then split again into a list column plus
 *     a 22rem correction panel, so the table got about half a wide monitor. It is the first non-admin
 *     screen here — the property is a property of the SCREEN, not of who may open it.
 *
 *  B. The FORM pages are deliberately still capped, so a future "make everything wide" sweep cannot take
 *     them with it. A form spread across a very wide screen is harder to fill in, not easier.
 *
 *     6340aecb RE-POINTED THE SHIFT FORM'S ENTRY rather than deleting it. af7a8eb4's reasoning above is
 *     about a one-column form; the Shift screen stopped being one. The reporter asked for the change in
 *     as many words (request point 3 — "full-width layout to maximize the available screen space"), and
 *     the redesign gave the screen four sections whose rows are 4-up grids: Working Times alone puts
 *     Time in / Time out / Shift Start Time / Shift Time Out on ONE line, which a 48rem reading column
 *     cannot hold. So the property that must not silently change is now the OPPOSITE one, and it is
 *     pinned as such in WIDE_FORM_SCREENS — full width, and no page-level cap creeping back — instead of
 *     the screen simply falling out of coverage. The forms that ARE still one column keep the original
 *     case in NARROW_FORM_SCREENS.
 *
 *  C. /admin/attendance no longer renders the create/edit form, and /admin/attendance-policy no longer
 *     renders the company work-schedule form. Those are the two things the reporter asked to stop seeing
 *     underneath the list they came to read.
 *
 * Limits: a className composed through cn() or a variable escapes a source check like this one — the
 * manual render walk is the backstop for those.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attendanceCorrectionStatusEnum } from '../db/schema';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** All string-literal className values in a source file (double-quoted or template literal). */
function classNameLiterals(source: string): string[] {
  return [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
}

/** A PAGE-level cap: one className string carrying BOTH `mx-auto` AND a `max-w-...xl` token. Requiring the
 *  pair is what keeps legitimate inner caps (a dialog, a single field, a locally capped inline form) out
 *  of scope — they cap their own width without centering the page. */
const capsPage = (cls: string) => /\bmx-auto\b/.test(cls) && /\bmax-w-\d*xl\b/.test(cls);

// The Attendance admin menu's LIST screens (ATTENDANCE_NODES in packs/attendance/index.ts), minus
// /admin/toil — plus /admin/holidays, which 4509d2b8 moved to the System Settings menu. Its MENU moved;
// its screen did not, and af7a8eb4's full-width list layout is a property of the screen. Kept in this
// list deliberately: dropping it because the row changed parents would retire live coverage of a screen
// that still renders exactly the same table.
const WIDE_LIST_SCREENS = [
  'app/admin/attendance/page.tsx',
  'app/admin/attendance-policy/page.tsx',
  'app/admin/holidays/page.tsx',
  'app/admin/attendance-allowance/page.tsx',
  'app/admin/locations/page.tsx',
  // r227 — Attendance Irregularity, the EMPLOYEE's own list. Not an admin screen and deliberately in the
  // same list anyway: it is a list screen that was capped, and the reporter raised it as the same fault.
  'app/attendance/requests/page.tsx',
];

// The form pages that are one column of boxes, and keep a comfortable reading width on purpose.
const NARROW_FORM_SCREENS = [
  'app/admin/attendance-policy/rules/rule-form.tsx',
  'app/admin/attendance-policy/schedule/page.tsx',
];

// 6340aecb — the one form page that is full width ON PURPOSE (see B above). It gets the SAME pair of
// assertions the list screens get, so the reversal is a pinned decision rather than an absence of one:
// putting `mx-auto max-w-3xl` back on this screen must fail here, exactly as taking it off rule-form.tsx
// would fail the case below.
const WIDE_FORM_SCREENS = ['app/admin/attendance/shift-form.tsx'];

describe('af7a8eb4 — Attendance screen layout', () => {
  it.each(WIDE_LIST_SCREENS)('%s uses pageWideCls', (file) => {
    expect(read(file), `${file} must use the named pageWideCls constant, not a hand-written width`).toContain(
      'pageWideCls',
    );
  });

  it.each(WIDE_LIST_SCREENS)('%s has no centered max-width cap', (file) => {
    const offending = classNameLiterals(read(file)).filter(capsPage);
    expect(offending, `${file} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual([]);
  });

  it.each(NARROW_FORM_SCREENS)('%s keeps its reading-width cap', (file) => {
    const capped = classNameLiterals(read(file)).filter(capsPage);
    expect(capped.length, `${file} is a one-column FORM page and must stay capped, not stretch edge to edge`).toBeGreaterThan(0);
  });

  it.each(WIDE_FORM_SCREENS)('%s is full width on purpose (6340aecb, request point 3)', (file) => {
    const src = read(file);
    expect(src, `${file} must use the named pageWideCls constant, not a hand-written width`).toContain('pageWideCls');
    const capped = classNameLiterals(src).filter(capsPage);
    expect(
      capped,
      `${file} re-acquires a page-level width cap: ${capped.join(' | ')}. The reporter asked for this ` +
        `screen edge to edge (request point 3) and its sections are 4-up grids — a reading-width cap here ` +
        `is the regression, not the guard.`,
    ).toEqual([]);
  });

  it('r227 — Attendance Irregularity does not re-acquire the correction column beside its table', () => {
    // Full width alone would not have fixed it: the page ALSO split its own column to make room for the
    // inline Fix panel. The request opens in a pop-up now, so there is nothing to make room for — and a
    // future "put the form back beside the list" is the exact regression the reporter asked us to undo.
    const src = read('app/attendance/requests/page.tsx');
    expect(src, 'the list/panel two-column split must not come back').not.toContain('lg:grid-cols-[minmax(0,1fr)_22rem]');
    // …and Request opens the shared pop-up rather than a second column. (The `?fix=` branch is KEPT for
    // links written before r227 — see test/me-tabs.test.ts, which pins that half.)
    expect(src).toContain('<CorrectionDialog');
  });

  it('/admin/toil is left alone — a short summary gains nothing from full width', () => {
    expect(classNameLiterals(read('app/admin/toil/page.tsx')).some(capsPage)).toBe(true);
  });

  it('the shift list no longer renders the create/edit form', () => {
    const src = read('app/admin/attendance/page.tsx');
    expect(src).not.toContain('id="shift-form"');
    expect(src).not.toContain('createShiftAction');
    expect(src).not.toContain('updateShiftAction');
    // The old in-list edit anchor is gone with it: Edit opens the row's own page.
    expect(src).not.toContain('editShift=');
  });

  it('the shift form lives on its own routes, reached from the list header', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/admin/attendance/new/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app/admin/attendance/[shiftId]/page.tsx'))).toBe(true);
    const list = read('app/admin/attendance/page.tsx');
    expect(list).toContain('/admin/attendance/new');
    // Both new routes are guarded IN THE FILE — test/function-access.test.ts detects the guard by regex
    // over each page.tsx source, so the call has to be literally there.
    expect(read('app/admin/attendance/new/page.tsx')).toContain('requireAdmin()');
    expect(read('app/admin/attendance/[shiftId]/page.tsx')).toContain('requireAdmin()');
  });

  it('the rule list no longer renders the company work schedule', () => {
    const src = read('app/admin/attendance-policy/page.tsx');
    expect(src).not.toContain('setAttendancePolicyAction');
    expect(src).not.toContain('StatutoryComponentForm');
    expect(src).not.toContain('revokeDeviceAction');
    // …and it links to where they went.
    expect(src).toContain('/admin/attendance-policy/schedule');
  });

  it('the relocated schedule page still carries every moved block — moving is not deleting', () => {
    const src = read('app/admin/attendance-policy/schedule/page.tsx');
    expect(src).toContain('requireAdmin()');
    expect(src).toContain('setAttendancePolicyAction'); // per-company work schedule form
    expect(src).toContain('StatutoryComponentForm'); // overtime rates
    expect(src).toContain('revokeDeviceAction'); // registered devices
    expect(src).toContain('employmentsWithoutBackupShift'); // backup-shift coverage card
  });

  it('the write paths return to the screen the operator was on', () => {
    // A validation error on the shift form must land back on the form, not on a list that has forgotten
    // every box they filled in.
    const actions = read('app/admin/attendance/shift-actions.ts');
    expect(actions).toContain('${BASE}/new');
    expect(actions).toContain('${BASE}/${shiftId}');
    // Copy lands on the copy's own edit page.
    expect(actions).toContain('${BASE}/${copied.id}');
    // Saving a company work schedule / revoking a device returns to the schedule page.
    expect(read('app/admin/actions.ts')).toContain("const ATTENDANCE_POLICY = '/admin/attendance-policy/schedule'");
    expect(read('app/admin/attendance-policy/device-actions.ts')).toContain(
      "const LIST = '/admin/attendance-policy/schedule'",
    );
    expect(read('app/admin/attendance-policy/schedule/page.tsx')).toContain(
      "const SELF = '/admin/attendance-policy/schedule'",
    );
  });
});


/**
 * r239 — My Attendance Request Status: two faces of ONE list, and four statuses.
 *
 * The reporter approved a purely presentational change: a narrow screen gets one block per request with
 * the date and the outcome on the same line and the detail underneath, while a wide monitor keeps the
 * seven-column table. Nothing about the read, the filter or the status colours moved.
 *
 * Nothing pinned this screen's arrangement before — the only assertion it had anywhere was
 * test/me-tabs.test.ts's "cancel is on the list", which stays true whatever shape the row takes. So these
 * cases are ADDED rather than rewritten, and each pins a property the plan named out loud:
 *
 *   A. BOTH faces are rendered and CSS picks one. Deleting either half, or letting both show at once, is
 *      invisible to tsc, to the suite and to a 200 — the page renders either way.
 *   B. NO client state. A `useState`/`matchMedia` switch would turn a server-rendered list into an island
 *      that flashes the wrong shape; the plan forbade it in as many words.
 *   C. FOUR statuses, and they are the DATABASE's four. This is the case the plan promised so that a fifth
 *      ("Completed") cannot arrive by accident: the screen's tuple is compared against
 *      `attendance_correction_status` itself, and the filter pills and the URL whitelist are required to
 *      DERIVE from that tuple rather than restate it. A `completed` filter would return an empty list
 *      forever while looking like a real state.
 *   D. Cancel is a button, drawn from ONE rule. The styling is what the reporter asked to change; the
 *      condition `!isOvertime && pending` is a real state rule (an overtime plan is withdrawn from Self
 *      Overtime instead) and must exist exactly once, not once per face.
 *
 * Limits: source-static, like the rest of this file. It cannot see a class that never reaches the browser
 * — the manual render walk at two widths is the backstop.
 */
describe('r239 — My Attendance Request Status: table on a wide screen, blocks on a narrow one', () => {
  // The switch is `lg`, not `md`: the nav rail appears at `sm` and takes 232px, so a 768px viewport gives
  // this list a ~500px content column — narrower than the block face gets at 639px. See page.tsx.
  const PAGE = read('app/attendance/request-status/page.tsx');
  const UI = read('app/attendance/request-ui.tsx');

  /** Source with comments removed. These guards read code, and a comment that spells out the very token
   *  being forbidden reads to a plain `includes()` as the thing itself (AGENTS 27). */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /**
   * The index just past the tag that CLOSES the element beginning at or before `from`.
   *
   * A region guard is only as good as its boundary: the first version of case A2 sliced to end of file
   * and asked whether two markers both appeared, which a verifier defeated by moving the Pill out of the
   * row entirely. Balancing the tags is what makes "inside this element" mean it.
   */
  function closingTagOf(src: string, from: number, tag: string): number {
    const open = new RegExp(`<${tag}\\b`, 'g');
    const close = new RegExp(`</${tag}>`, 'g');
    const start = src.lastIndexOf(`<${tag}`, from);
    let depth = 0;
    let i = start;
    while (i < src.length) {
      open.lastIndex = i;
      close.lastIndex = i;
      const o = open.exec(src);
      const c = close.exec(src);
      if (!c) return -1;
      if (o && o.index < c.index) {
        depth++;
        i = o.index + 1;
      } else {
        depth--;
        i = c.index + 1;
        if (depth === 0) return c.index;
      }
    }
    return -1;
  }

  it('A. renders BOTH faces, and shows exactly one of them at a time', () => {
    // The table keeps the shared wrapper class and gains a visibility rule; the blocks are its inverse.
    // Asserting the PAIR is the point: one without the other is a screen that is blank at one width.
    expect(PAGE, 'the wide face must be the table, hidden below lg').toContain('`hidden lg:block ${tableWrapCls}`');
    expect(PAGE, 'the narrow face must be the stacked block list, hidden from lg up').toContain(
      'className="divide-y divide-border lg:hidden"',
    );
    // …and the two faces are the SAME rows: both map the paginated page, neither re-reads or re-filters.
    expect(code(PAGE).match(/reqPage\.rows\.map/g) ?? [], 'both faces map the one paginated row set').toHaveLength(2);
  });

  it('A2. the narrow block leads with date + outcome ON ONE LINE, and puts the detail underneath', () => {
    // ⚠️ THIS CASE WAS VACUOUS WHEN IT WAS FIRST WRITTEN, AND A VERIFIER PROVED IT: it sliced from
    // `md:hidden` to END OF FILE and only asked whether the flex class and the Pill both APPEARED
    // somewhere in that span. Moving the Pill out of the flex row into its own <div> underneath — the
    // exact shape the reporter complained about — passed all 27 cases. Co-occurrence is not containment,
    // and an unbounded slice is not a region.
    //
    // So: bound the region at the list's own closing tag, and require the Pill to be INSIDE the first
    // line's element rather than merely after it.
    const start = PAGE.indexOf('lg:hidden');
    const end = PAGE.indexOf('</ul>', start);
    expect(start, 'the narrow face must exist').toBeGreaterThan(-1);
    expect(end, 'and it must be a bounded list, not the rest of the file').toBeGreaterThan(start);
    const block = PAGE.slice(start, end);

    const lineStart = block.indexOf('flex items-start justify-between');
    expect(lineStart, 'date and status share a flex row').toBeGreaterThan(-1);
    // The flex row's OWN element, found by balancing its tags. `indexOf('</div>')` is not good enough —
    // it lands on the inner text div's close, which sits BEFORE the Pill, so the region would exclude the
    // very thing this case exists to locate.
    const lineEnd = closingTagOf(block, lineStart, 'div');
    expect(lineEnd, 'the flex row must be a closed element').toBeGreaterThan(lineStart);
    const firstLine = block.slice(lineStart, lineEnd);
    expect(firstLine, 'the DATE is on that line').toContain('r.attendanceDate');
    expect(firstLine, 'and so is the outcome — this is the whole complaint').toContain('<Pill status={r.status}');

    // …and the detail follows it rather than sharing it.
    const rest = block.slice(lineEnd);
    for (const marker of ['askedFor(r, t)', 'r.reason', 'r.remark', "t('maColSubmitted')", 'maAttachmentOnRequest']) {
      expect(rest.includes(marker), `the block face must carry ${marker} BELOW the first line`).toBe(true);
    }
    // The overtime wording rule now has TWO render sites (ADR-free but load-bearing: a cancelled overtime
    // plan reads "Withdrawn", not "Cancelled", and request-ui.tsx's comment says that wording has already
    // survived two relocations). A verifier mutated the block face's third argument to `false` and NOTHING
    // failed. Both sites must pass the real predicate.
    expect(
      code(PAGE).match(/statusLabel\(r\.status, t, isOvertime\(r\)\)/g) ?? [],
      'both faces label the status through isOvertime — otherwise a withdrawn OT plan reads "Cancelled"',
    ).toHaveLength(2);
  });

  it('A3. the approver caption is drawn only where it is still true', () => {
    // `otGoesToColumn` reads "Goes to" (ms "Kepada", th/vi "sent to"). As a column HEADING over names it
    // is neutral; as a running caption beside a red Rejected pill it asserts the request is still with
    // that person — and `approver` is the employee's CURRENT approver, not whoever decided the row. Two
    // independent verifiers found this. AGENTS 28: a confidently wrong caption is worse than none.
    const start = PAGE.indexOf('lg:hidden');
    const block = PAGE.slice(start, PAGE.indexOf('</ul>', start));
    const at = block.indexOf("t('otGoesToColumn')");
    expect(at, 'the block face still names the approver somewhere').toBeGreaterThan(-1);
    expect(
      block.slice(Math.max(0, at - 400), at),
      'and only on a pending request — a decided one must not claim it is still with anybody',
    ).toContain("r.status === 'pending' ?");
  });

  it('B. stays server-rendered — the responsive switch is CSS, not client state', () => {
    const src = code(PAGE);
    expect(src.includes("'use client'"), 'the request list must not become a client island').toBe(false);
    expect(src, 'no viewport measuring, no state — CSS decides which face shows').not.toMatch(
      /\buseState\b|\buseEffect\b|\bmatchMedia\b|\bwindow\./,
    );
  });

  it('C. offers exactly the four statuses the database has — no fifth, no Completed', () => {
    // Parsed off the source rather than imported, because what must not drift is the LITERAL the screen
    // ships. Compared against the enum itself, so adding a filter without a migration fails here, and
    // adding an enum value forces someone to decide what this screen does with it.
    const tuple = UI.match(/export const REQUEST_STATUSES = \[([^\]]*)\] as const;/);
    expect(tuple, 'REQUEST_STATUSES must be a plain literal tuple this guard can read').not.toBeNull();
    const offered = tuple![1]
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(offered).toEqual(['pending', 'approved', 'rejected', 'cancelled']);
    expect(offered, 'the screen offers the stored statuses and only those').toEqual([
      ...attendanceCorrectionStatusEnum.enumValues,
    ]);
    // Both consumers DERIVE from the tuple. A second hand-written list is how the pills and the addresses
    // they link to come to disagree — the filter would look right and return nothing.
    expect(PAGE).toContain('const STATUS_FILTERS = [null, ...REQUEST_STATUSES] as const');
    expect(PAGE, 'the URL whitelist is the same list, not a copy').toContain('REQUEST_STATUSES.includes(');
    expect(code(PAGE).toLowerCase().includes('completed'), 'there is no completed status to render').toBe(false);
    expect(code(UI).toLowerCase().includes('completed'), 'and none in the shared vocabulary either').toBe(false);
    // The colour map is keyed by the tuple's type, so a status added without a colour is a type error
    // rather than a silently grey pill.
    expect(UI).toContain('const REQUEST_STATUS: Record<RequestStatus, string>');
  });

  it('D. Cancel is the module’s button, and its state rule is written exactly once', () => {
    // No trailing `>`: the control also carries an aria-label (every pending row draws an identically
    // worded button, so the accessible name has to say WHICH request it takes back). Pinning the opening
    // attributes keeps the case about the styling change the reporter asked for.
    expect(PAGE, 'Cancel is a real button now, not a bare underlined word').toContain(
      '<Button type="submit" size="sm" variant="outline"',
    );
    expect(PAGE, 'and it says which request it cancels, not just "Cancel"').toContain('aria-label={`${label}');
    expect(PAGE.includes('action={myCancelAttendanceRequest}'), 'still the same server-action form').toBe(true);
    // ONE form, ONE rule, drawn by both faces.
    expect(code(PAGE).match(/action=\{myCancelAttendanceRequest\}/g) ?? []).toHaveLength(1);
    expect(code(PAGE).match(/const canCancel = /g) ?? [], 'the cancel rule is defined once').toHaveLength(1);
    // ⚠️ THE CONTENT, NOT JUST THE SHAPE. A verifier deleted `!isOvertime(r) &&` from the predicate and
    // every case here still passed — the guard pinned that the rule was asked twice and defined once,
    // never what it SAYS. An overtime plan is withdrawn from Self Overtime under its own state rule; a
    // Cancel button on one here offers a withdrawal this screen must not give.
    expect(PAGE, 'the cancel rule is BOTH halves — not overtime, and still pending').toContain(
      "const canCancel = (r: RequestRow) => !isOvertime(r) && r.status === 'pending';",
    );
    expect(code(PAGE).match(/canCancel\(r\)/g) ?? [], 'and both faces ask it rather than restating it').toHaveLength(2);
    // ⚠️ THIS USED TO COUNT `r.status === 'pending'` AND REQUIRE EXACTLY ONE, WHICH PINNED A PROXY RATHER
    // THAN THE PROPERTY. A legitimate SECOND use arrived in the same round — the approver caption is
    // drawn only on a pending request — and the count failed on a change that was entirely correct. What
    // actually matters is narrower: the Cancel control is drawn through `canCancel` and never behind an
    // inline pending test, because an inline one would omit the overtime half of the rule.
    const drawn = [...code(PAGE).matchAll(/<CancelRequest\b/g)].map((m) => m.index!);
    expect(drawn, 'Cancel is drawn once per face').toHaveLength(2);
    for (const at of drawn) {
      const before = code(PAGE).slice(Math.max(0, at - 200), at);
      expect(before, 'every Cancel is drawn through canCancel').toContain('canCancel(r)');
      expect(before, 'and never behind an inline pending test, which would drop the overtime half').not.toContain(
        "r.status === 'pending'",
      );
    }
  });
});
