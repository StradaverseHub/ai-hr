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
 *  D. 6d091cc0 (r301) — /admin/attendance-policy and /admin/attendance-policy/schedule are requireAdmin()
 *     redirect stubs now; their content is three cards on Attendance › Schedule › General. So the width and
 *     "moving is not deleting" pins FOLLOWED the content to the card files rather than being dropped: the
 *     Schedule Group list is still separate from the work-schedule/overtime/devices blocks (each its own card),
 *     every moved block is still rendered, the cards carry no page-level cap of their own on a full-width
 *     screen, and the one-column rule form keeps its reading width.
 *
 * Limits: a className composed through cn() or a variable escapes a source check like this one — the
 * manual render walk is the backstop for those.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attendanceCorrectionStatusEnum } from '../db/schema';
// r363 — the wording cases at the foot of this file RUN the labeller rather than reading its source.
// "Three places on one screen agree" is a relation between three resolved strings; no source check can
// see it, and a source check that pinned the English word would pass on a screen where they had drifted
// apart and somebody had edited the catalogue instead.
import { statusLabel } from '../app/attendance/request-ui';

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
  // 6d091cc0 (r301) — 'app/admin/attendance-policy/page.tsx' STOOD HERE. It is a redirect stub now and renders
  // no width at all; the list it held is the Schedule Group card on the Schedule screen below (which IS in this
  // list), and the card itself is pinned cap-free in WIDE_SCREEN_CARDS.
  'app/admin/holidays/page.tsx',
  'app/admin/attendance-allowance/page.tsx',
  'app/admin/work-locations/page.tsx',
  // 1c5602cc (r263) — the Schedule configuration screen. A list screen by shape (two wide tables of
  // shifts and per-company working weeks, seven and six columns), so it takes the same full-width
  // property its siblings do, pinned in the same place rather than left uncovered.
  'app/admin/attendance/schedule/page.tsx',
  // r227 — Attendance Irregularity, the EMPLOYEE's own list. Not an admin screen and deliberately in the
  // same list anyway: it is a list screen that was capped, and the reporter raised it as the same fault.
  'app/attendance/requests/page.tsx',
  /**
   * f3e6c36e (r287) — the employee's own attendance screen, added on the SAME reasoning r227 gave: the
   * full-width property belongs to the SCREEN, not to who may open it. Listed from the start rather than
   * after somebody complains, so a `mx-auto max-w-*xl` can never quietly arrive on it.
   *
   * ⚠️ 2aef3cd8 (r362) — THE OLD REASON WAS "this one carries the same seventeen-column day table the
   * Individual tab does". IT DOES NOT ANY MORE: the row is "Attendance Overview" and the screen is blank
   * below its title, by the reporter's instruction. The entry STAYS, and that is a decision rather than
   * inertia — this is now the assertion that the blank page keeps `pageWideCls` and acquires no reading-
   * width cap, so whatever content arrives here later starts full width instead of being born capped and
   * re-raised as the same complaint r227 and r319 already cost two rounds.
   */
  'app/attendance/my-records/page.tsx',
  /**
   * dde08629 (r319) — EMPLOYEE ATTENDANCE and its two sibling tabs, added on the same reasoning every
   * entry above carries and on the identical complaint: at `mx-auto max-w-6xl` a sixteen-column table sat
   * in a 72rem middle column while roughly a third of a wide monitor went unused.
   *
   * They are the reporter's "ADMIN › Attendance › Employee Attendance" and the Daily / Individual tabs
   * beside it. Nothing about this was a new design — eight attendance screens already had the property
   * and were already pinned here; these three were simply never added, which is exactly the hole
   * af7a8eb4's header warns about: a screen can gain the layout without gaining the guard, and then lose
   * it again silently.
   */
  'app/attendance/page.tsx',
  'app/attendance/daily/page.tsx',
  'app/attendance/individual/page.tsx',
  /**
   * a57f0584 (r322) — Roster. It has BEEN pageWideCls all along and was never listed, which is exactly the
   * hole af7a8eb4's header names: a screen can hold the property without the guard and lose it again with
   * nobody noticing. Added in the round that widened what the screen SHOWS (every authorised company at
   * once, rather than whichever sorted first), because a month grid spanning twelve companies is the last
   * screen that could afford to acquire a reading-width cap.
   */
  'app/roster/page.tsx',
  /**
   * dae7a10f (r322) — the per-day detail screen. 570fd56e moved the eight calculation columns onto it and
   * left it at `mx-auto max-w-5xl`, so the screen carrying the WIDEST content on this tab was the one
   * narrow screen in the set. It opens from a full-width list and now matches it — and is listed here so
   * it cannot drift back, the same reasoning r319 used for the three screens above.
   */
  'app/attendance/individual/[date]/page.tsx',
  /**
   * f618065d (r362) — SELF OVERTIME, the employee's own overtime list. The reporter raised it as the
   * identical complaint r227 and r319 already cost two rounds each: `mx-auto max-w-6xl`, so roughly a
   * third of a wide monitor was empty margin and Reason — the column most likely to be cut off — was the
   * one that paid for it. It is the eleventh list screen in this menu to take the property, and it is
   * listed here in the round that gives it rather than after somebody complains a fourth time.
   *
   * ⚠️ THE NOT-LINKED BRANCH IS WHY THIS ENTRY NEEDS A NOTE. That branch was `mx-auto max-w-2xl`, which
   * the second case below reads as a page-level cap. It is `mx-auto max-w-md` now — the same choice
   * app/attendance/requests/page.tsx made and for the same stated reason — so the one-sentence notice
   * stays centred and narrow while the SCREEN is full width.
   */
  'app/attendance/plan-ot/page.tsx',
];

// The form pages that are one column of boxes, and keep a comfortable reading width on purpose.
const NARROW_FORM_SCREENS = [
  // 665de026 (r331) — 'app/admin/attendance-policy/rules/rule-form.tsx' STOOD HERE, and its entry is
  // REPOINTED rather than dropped, exactly as 6340aecb repointed the shift form's and r301 repointed the
  // work-schedule page's. The form capped itself while it drew its own page chrome; it is a SECTION of
  // Add Schedule and Edit Schedule now, so the cap moved up to the three pages below — otherwise a 3xl
  // form would sit inside a full-width page beside wider sections, which is the mismatch, not the fix.
  // af7a8eb4's property is unchanged and is asserted on the file that now owns the width. The form's own
  // one-column shape is still pinned, positively, by the case at the foot of this file.
  'app/admin/attendance/schedule/new/page.tsx',
  'app/admin/attendance/schedule/[ruleId]/page.tsx',
  'app/admin/attendance/schedule/[ruleId]/edit/page.tsx',
  // 6d091cc0 (r301) — 'app/admin/attendance-policy/schedule/page.tsx' STOOD HERE. It is a redirect stub; the
  // stack of paired time inputs it capped is the Company Policy Settings Edit panel (a card inside the panel
  // column), and the rest of that page is the Work Schedule & Overtime Rates card.
];

/**
 * 6d091cc0 (r301) — the cards the two retired pages became. They render INSIDE the full-width Schedule screen,
 * so the property that must not drift is that none of them re-introduces a page-level cap of its own (which
 * would re-create, one card at a time, the empty-margin complaint af7a8eb4 fixed).
 */
const WIDE_SCREEN_CARDS = [
  'app/admin/attendance-policy/schedule-group-card.tsx',
  'app/admin/attendance-policy/company-policy-card.tsx',
  'app/admin/attendance-policy/work-schedule-overtime-card.tsx',
];

/** The two retired pages: guarded redirect stubs, each to the General-tab card holding its content. */
const REDIRECT_STUBS: [string, string][] = [
  ['app/admin/attendance-policy/page.tsx', 'SCHEDULE_GROUPS_ANCHOR'],
  ['app/admin/attendance-policy/schedule/page.tsx', 'WORK_SCHEDULE_OVERTIME_ANCHOR'],
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

  it.each(WIDE_SCREEN_CARDS)('%s (r301 card on the full-width Schedule screen) carries no page-level cap', (file) => {
    const offending = classNameLiterals(read(file)).filter(capsPage);
    expect(offending, `${file} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual([]);
  });

  it.each(REDIRECT_STUBS)('%s renders nothing of its own any more — it redirects to its card (r301)', (file, anchor) => {
    const src = read(file);
    expect(src).toContain('await requireAdmin();');
    expect(src).toContain(`redirect(\`\${SCHEDULE}#\${${anchor}}\`)`);
    expect(classNameLiterals(src), 'a redirect stub has no markup, so no width to get wrong').toEqual([]);
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

  // 3fb1a611 (r299) — `/admin/toil is left alone — a short summary gains nothing from full width` STOOD HERE.
  // The page is a redirect stub to Leave Config › Leave Credit now and renders nothing, so there is no width to
  // leave alone; its summary and sweeps are cards on that screen, which follows the Leave Config layout.
  it('/admin/toil renders nothing of its own any more — it redirects to Leave Credit', () => {
    const src = read('app/admin/toil/page.tsx');
    expect(src).toContain("redirect(`/admin/leave-config/leave-credit");
    expect(classNameLiterals(src)).toEqual([]);
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

  /**
   * 665de026 — THE OTHER HALF OF MOVING rule-form.tsx's CAP UP A LEVEL.
   *
   * Taking the `mx-auto max-w-3xl` off the form would be a silent full-width regression if the pages that
   * mount it ever lost their own cap — NARROW_FORM_SCREENS above catches that. This case catches the
   * opposite drift: the form growing a second `PageHeader` again. It drew one until this round, which on
   * r301's panel meant a second `<h1>` inside a page that already had one, and a back link pointing at a
   * redirect stub. The page owns the chrome; the form owns the fields.
   */
  it('the rule form draws no page chrome of its own — the page it is mounted on does (665de026)', () => {
    const form = read('app/admin/attendance-policy/rules/rule-form.tsx');
    expect(form, 'no second <h1> inside a page that already has one').not.toContain('<PageHeader');
    expect(classNameLiterals(form).filter(capsPage), 'and no page-level cap of its own — it lives on the pages now').toEqual([]);
    // Positively: both mounts exist and both are in NARROW_FORM_SCREENS above, so the reading width is
    // still asserted somewhere — this case cannot pass by the form simply not being rendered anywhere.
    for (const mount of ['app/admin/attendance/schedule/new/page.tsx', 'app/admin/attendance/schedule/group-sections.tsx']) {
      expect(read(mount), `${mount} mounts the rule form`).toContain('<RuleForm');
    }
  });

  it('the rule list no longer renders the company work schedule', () => {
    // 6d091cc0 (r301) — the list is the Schedule Group CARD now (its old page is a redirect stub, pinned above).
    // The separation af7a8eb4 made is kept at the new home: the list card does not render the company work
    // schedule, the overtime rates or the devices — those are their own cards beside it.
    const src = read('app/admin/attendance-policy/schedule-group-card.tsx');
    expect(src).not.toContain('setAttendancePolicyAction');
    expect(src).not.toContain('WorkScheduleForm');
    expect(src).not.toContain('StatutoryComponentForm');
    expect(src).not.toContain('revokeDeviceAction');
    // …and the screen it sits on renders where they went, in the approved card order.
    const page = read('app/admin/attendance/schedule/page.tsx');
    const at = ['<ScheduleGroupCard', '<CompanyPolicyCard', '<WorkScheduleOvertimeCard'].map((m) => page.indexOf(m));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('the relocated schedule page still carries every moved block — moving is not deleting', () => {
    /**
     * 6d091cc0 (r301) — MOVED AGAIN, AND THE ASSERTION FOLLOWED IT AGAIN.
     *
     * This case pinned /admin/attendance-policy/schedule/page.tsx. The reporter asked for Work Schedule &
     * Overtime Configuration to be managed on Attendance › Schedule › General, so that page is a redirect stub
     * and its blocks are the Work Schedule & Overtime Rates card and the Company Policy Settings card, both
     * mounted by the Schedule page (which calls requireAdmin() itself). Each block is looked for in the file
     * that now renders it, and the mount is checked too — a card nobody renders is a deletion.
     */
    const page = read('app/admin/attendance/schedule/page.tsx');
    expect(page).toContain('requireAdmin()');
    expect(page, 'the Schedule page mounts the overtime/devices/coverage card').toContain('<WorkScheduleOvertimeCard');
    expect(page, 'and the company policy card').toContain('<CompanyPolicyCard');
    expect(page, 'and the policy editor panel').toContain('<CompanyPolicyEditPanel');
    const card = read('app/admin/attendance-policy/work-schedule-overtime-card.tsx');
    expect(card).toContain('StatutoryComponentForm'); // overtime rates
    expect(card).toContain('revokeDeviceAction'); // registered devices
    expect(card).toContain('employmentsWithoutBackupShift'); // backup-shift coverage card
    /**
     * e4471e3c (r287) — THE WORK-SCHEDULE FORM MOVED INTO A COMPONENT, SO THE ASSERTION FOLLOWED IT.
     * r301 — and it is mounted by the Company Policy Settings Edit panel. Both halves are checked: the panel
     * still renders the editor, and the editor still posts to the same action with the same day-type fields.
     */
    expect(
      read('app/admin/attendance-policy/company-policy-card.tsx'),
      'the Edit panel renders the company work-schedule editor',
    ).toContain('<WorkScheduleForm');
    const form = read('app/admin/attendance-policy/schedule/work-schedule-form.tsx');
    expect(form, 'and that editor is still the setAttendancePolicyAction form').toContain('setAttendancePolicyAction');
    expect(form, 'still posting the per-weekday day-type selects the action decodes').toContain('dayType_');
  });

  it('the write paths return to the screen the operator was on', () => {
    // A validation error on the shift form must land back on the form, not on a list that has forgotten
    // every box they filled in.
    const actions = read('app/admin/attendance/shift-actions.ts');
    expect(actions).toContain('${BASE}/new');
    expect(actions).toContain('${BASE}/${shiftId}');
    // Copy lands on the copy's own edit page.
    expect(actions).toContain('${BASE}/${copied.id}');
    // 6d091cc0 (r301) — saving a company work schedule, revoking a device and publishing the overtime rates all
    // return to the Schedule screen now, as a PLAIN path: every one of those writers appends `?error=` (or
    // `?toast=`) by concatenation, and the statutory action refuses a return path carrying ? or #. The General
    // tab is the default tab, so the plain path is where the card is. (The `?tab=general` this used to carry
    // for the policy save is the defect r301 fixed — it swallowed every refusal.) Behaviour, not just source:
    // test/r301-schedule-general.test.ts runs each of these actions and reads where it redirected.
    expect(read('app/admin/attendance-policy/schedule-panel.ts')).toContain(
      "export const SCHEDULE = '/admin/attendance/schedule';",
    );
    const admin = read('app/admin/actions.ts');
    expect(admin).toContain("const SCHEDULE_TAB = '/admin/attendance/schedule';");
    expect(admin).toContain('const backTo = SCHEDULE_TAB;');
    expect(admin, 'no query string on the policy return path').not.toContain('SCHEDULE_TAB}?tab=');
    expect(read('app/admin/attendance-policy/device-actions.ts')).toContain('const LIST = SCHEDULE;');
    expect(read('app/admin/attendance-policy/work-schedule-overtime-card.tsx')).toContain('returnTo={SCHEDULE}');
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
    // ⚠️ r363 — THIS IS A SHAPE CHECK NOW, NOT A BEHAVIOUR TEST, AND THE COMMENT SAYS SO RATHER THAN
    // LEAVING A RETIRED CLAIM STANDING. It used to read:
    //   "The overtime wording rule now has TWO render sites (ADR-free but load-bearing: a cancelled
    //    overtime plan reads 'Withdrawn', not 'Cancelled', and request-ui.tsx's comment says that wording
    //    has already survived two relocations). A verifier mutated the block face's third argument to
    //    `false` and NOTHING failed. Both sites must pass the real predicate."
    // The split it described is retired: `cancelled` reads "Withdrawn" for BOTH kinds, because only the
    // subject can ever write that status (see request-ui.tsx). So mutating the third argument SHOULD now
    // have no effect, and this count no longer detects the mutation it was written for. It is kept
    // deliberately — the call shape is what the follow-up round would change, and dropping the parameter
    // must be a decision somebody takes rather than a silent drift — but the PROPERTY it was reaching for
    // is pinned by "one word for one state" below, which compares the two kinds' labels to each other.
    expect(
      code(PAGE).match(/statusLabel\(r\.status, t, isOvertime\(r\)\)/g) ?? [],
      'both faces label the status through the same call shape — see "one word for one state" below',
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

  /**
   * 4c8aae68 (r363) — ONE WORD FOR ONE STATE, and it is pinned as a RELATION, not as a word.
   *
   * What the reporter saw: a filter chip reading "Cancelled" a few centimetres above an overtime row
   * reading "Withdrawn". Three places on this one screen render the stored `cancelled` — the chip, an
   * overtime plan's pill and a clock correction's pill — and they disagreed. The premise for unifying
   * rather than splitting harder is that only the SUBJECT can ever write that status: exactly two
   * functions do (cancelPlannedOvertime and cancelOwnAttendanceCorrection, core/attendance.ts) and both
   * refuse anybody else in code, so `cancelled` on this screen means one thing.
   *
   * ⚠️ WHY THE ASSERTIONS COMPARE THE THREE TO EACH OTHER AND NOT TO "Withdrawn". A case pinning the
   * literal would pass on a screen where the three had drifted apart again and somebody had simply
   * retranslated one key — the defect is disagreement, and disagreement is a relation. And ⚠️ WHY IT
   * BUILDS A REAL ROW OF EACH KIND: an equality between two calls that take the same branch is true for
   * free, so the kinds are asserted to be genuinely different before their labels are compared.
   *
   * This is also the case that inherits what A2 above was reaching for. A2 was written because a
   * verifier mutated `isOvertime` at one render site and nothing failed; after this round that argument
   * is read by no branch, so A2 can only pin the call SHAPE. The behaviour lives here.
   */
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const catalogue = (locale: string) => (JSON.parse(read(`messages/${locale}.json`)) as { me: Record<string, unknown> }).me;
  /** One `me` message by dotted key, exactly as next-intl would walk it — or undefined. */
  const msg = (locale: string, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalogue(locale));
  /** A `t` for the `me` namespace. THROWS on a missing key rather than echoing it back: a labeller that
   *  quietly returned "otStatusWithdrawn" would satisfy an equality case while rendering gibberish. */
  const translator = (locale: string) => {
    const me = catalogue(locale);
    const t = (key: string): string => {
      const hit = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], me);
      if (typeof hit !== 'string') throw new Error(`messages/${locale}.json has no me.${key}`);
      return hit;
    };
    return t as unknown as Parameters<typeof statusLabel>[1];
  };

  it('r363 — the chip, a cancelled OVERTIME row and a cancelled CORRECTION row read the SAME word', () => {
    // The kind predicate is re-run here rather than imported (it is the page's own const), so it is
    // pinned verbatim first — otherwise this case could go on asserting a rule the screen had stopped
    // using, which is precisely how case D was once defeated.
    const ISOVERTIME =
      'const isOvertime = (r: RequestRow) => r.proposedCheckIn == null && r.requestedOtMinutes != null;';
    expect(PAGE, 'the kind predicate this case re-runs must still be the one the screen ships').toContain(ISOVERTIME);
    const isOvertime = (r: { proposedCheckIn: string | null; requestedOtMinutes: number | null }) =>
      r.proposedCheckIn == null && r.requestedOtMinutes != null;

    // A real row of each kind, as myAttendanceCorrections returns them: an overtime plan carries minutes
    // and no proposed clock-in; a clock correction is the other way round.
    const plan = { status: 'cancelled', proposedCheckIn: null, requestedOtMinutes: 120 };
    const correction = { status: 'cancelled', proposedCheckIn: '09:00', requestedOtMinutes: null };
    expect(isOvertime(plan), 'the overtime row really is one').toBe(true);
    expect(
      isOvertime(correction),
      'and the correction row really is not — otherwise both halves of the equality take one branch and it is free',
    ).toBe(false);

    // The chip's OWN third argument, read off the screen rather than assumed, so this case compares what
    // the screen would actually render if somebody flipped it.
    const chipCall = code(PAGE).match(/statusLabel\(f, t, (true|false)\)/);
    expect(chipCall, 'the filter chip must resolve through the shared labeller, not a word of its own').not.toBeNull();
    const chipIsOvertime = chipCall![1] === 'true';

    for (const locale of LOCALES) {
      const t = translator(locale);
      const planWord = statusLabel(plan.status, t, isOvertime(plan));
      const correctionWord = statusLabel(correction.status, t, isOvertime(correction));
      const chipWord = statusLabel('cancelled', t, chipIsOvertime);
      expect(planWord.trim(), `${locale}: the label resolves to a real word, not a blank`).not.toBe('');
      expect(
        correctionWord,
        `${locale}: a taken-back correction and a taken-back overtime plan must read the SAME word`,
      ).toBe(planWord);
      expect(chipWord, `${locale}: and the filter chip above them must read that same word`).toBe(planWord);
    }

    // It is Self Overtime's own key that they agree on — which is why nothing had to be written or
    // translated. Asserted through the catalogue rather than against "Withdrawn", so a retranslation of
    // that key moves all of them together.
    for (const locale of LOCALES) {
      expect(
        statusLabel('cancelled', translator(locale), true),
        `${locale}: the shared word is me.otStatusWithdrawn`,
      ).toBe(msg(locale, 'otStatusWithdrawn'));
    }

    // …and me.leaveStatus.cancelled is NOT touched. It lost its literal call site here, but two computed
    // call sites outside attendance still reach it (app/admin/personnel/[employmentId]/page.tsx and
    // app/me/request-change-card.tsx build `leaveStatus.${status}` as a template), and "Cancelled" is the
    // right word there. Deleting or rewording it is the regression this line exists to catch.
    for (const locale of LOCALES) {
      const v = msg(locale, 'leaveStatus.cancelled');
      expect(typeof v === 'string' && v.trim() !== '', `me.leaveStatus.cancelled must stay in ${locale}.json`).toBe(
        true,
      );
    }
    expect(msg('en', 'leaveStatus.cancelled'), 'and it still says Cancelled in English').toBe('Cancelled');
  });

  it('r363 — the take-back control resolves the SAME KEY as Self Overtime’s withdraw control', () => {
    // ⚠️ BY KEY IDENTITY, NOT BY THE ENGLISH STRING. Two screens can both read "Withdraw" in English and
    // disagree in Tamil; what makes them unable to drift is resolving ONE key. So neither key is named
    // as a literal here — the case reads both off their screens and compares them.
    const labels = [...code(PAGE).matchAll(/<CancelRequest\b[^>]*label=\{t\('([^']+)'\)\}/g)].map((m) => m[1]);
    expect(labels, 'both faces of the list draw the control').toHaveLength(2);
    expect(new Set(labels).size, 'and both faces resolve one key, not two').toBe(1);

    const OT = code(read('app/attendance/plan-ot/page.tsx'));
    const at = OT.indexOf('{canWithdraw ?');
    expect(at, 'Self Overtime still draws a withdraw control').toBeGreaterThan(-1);
    const control = OT.slice(at, OT.indexOf(') : null}', at));
    const otKeys = [...new Set([...control.matchAll(/t\('([^']+)'\)/g)].map((m) => m[1]))];
    expect(otKeys, 'Self Overtime’s control names exactly one label key').toHaveLength(1);
    expect(labels[0], 'and this screen’s take-back control must be that same key').toBe(otKeys[0]);

    // RETIRED, NOT DELETED. me.maCancelRequest is no longer rendered anywhere; it stays in all six
    // catalogues, because a key that is removed cannot be put back by anyone reading a translation memory.
    expect(code(PAGE).includes('maCancelRequest'), 'maCancelRequest is no longer rendered on this screen').toBe(false);
    for (const locale of LOCALES) {
      const retired = msg(locale, 'maCancelRequest');
      expect(
        typeof retired === 'string' && retired.trim() !== '',
        `me.maCancelRequest must stay in ${locale}.json — retired, never deleted`,
      ).toBe(true);
      const shared = msg(locale, otKeys[0]);
      expect(
        typeof shared === 'string' && (shared as string).trim() !== '',
        `me.${otKeys[0]} missing or blank in ${locale}.json`,
      ).toBe(true);
    }

    // me.maCancel is a DIFFERENT key — the "never mind, close this" button beside a confirm in the
    // correction dialog on app/attendance/requests/page.tsx. It is not a take-back and is deliberately
    // left saying Cancel; a sweep that took it with this change would be the regression.
    expect(msg('en', 'maCancel'), 'the dialog dismiss button is untouched').toBe('Cancel');
  });
});
