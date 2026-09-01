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

// The form pages, which keep a comfortable reading width on purpose.
const NARROW_FORM_SCREENS = [
  'app/admin/attendance/shift-form.tsx',
  'app/admin/attendance-policy/rules/rule-form.tsx',
  'app/admin/attendance-policy/schedule/page.tsx',
];

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
    expect(capped.length, `${file} is a FORM page and must stay capped, not stretch edge to edge`).toBeGreaterThan(0);
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
  const PAGE = read('app/attendance/request-status/page.tsx');
  const UI = read('app/attendance/request-ui.tsx');

  /** Source with comments removed. These guards read code, and a comment that spells out the very token
   *  being forbidden reads to a plain `includes()` as the thing itself (AGENTS 27). */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('A. renders BOTH faces, and shows exactly one of them at a time', () => {
    // The table keeps the shared wrapper class and gains a visibility rule; the blocks are its inverse.
    // Asserting the PAIR is the point: one without the other is a screen that is blank at one width.
    expect(PAGE, 'the wide face must be the table, hidden below md').toContain('`hidden md:block ${tableWrapCls}`');
    expect(PAGE, 'the narrow face must be the stacked block list, hidden from md up').toContain(
      'className="divide-y divide-border md:hidden"',
    );
    // …and the two faces are the SAME rows: both map the paginated page, neither re-reads or re-filters.
    expect(code(PAGE).match(/reqPage\.rows\.map/g) ?? [], 'both faces map the one paginated row set').toHaveLength(2);
  });

  it('A2. the narrow block leads with date + outcome, and puts the detail underneath', () => {
    // The complaint was that the answer was the column furthest from the date. The Pill sits in the same
    // flex row as the date; askedFor / reason / remark / submitted / approver / attachment follow it.
    const block = PAGE.slice(PAGE.indexOf('md:hidden'));
    expect(block, 'date and status share the first line').toContain('flex items-start justify-between');
    for (const marker of ['askedFor(r, t)', 'r.reason', 'r.remark', "t('maColSubmitted')", "t('otGoesToColumn')", 'maAttachmentOnRequest']) {
      expect(block.includes(marker), `the block face must still carry ${marker}`).toBe(true);
    }
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
    expect(PAGE, 'Cancel is a real button now, not a bare underlined word').toContain(
      '<Button type="submit" size="sm" variant="outline">',
    );
    expect(PAGE.includes('action={myCancelAttendanceRequest}'), 'still the same server-action form').toBe(true);
    // ONE form, ONE rule, drawn by both faces.
    expect(code(PAGE).match(/action=\{myCancelAttendanceRequest\}/g) ?? []).toHaveLength(1);
    expect(code(PAGE).match(/const canCancel = /g) ?? [], 'the cancel rule is defined once').toHaveLength(1);
    expect(code(PAGE).match(/canCancel\(r\)/g) ?? [], 'and both faces ask it rather than restating it').toHaveLength(2);
    expect(
      code(PAGE).includes("r.status === 'pending'") && code(PAGE).match(/r\.status === 'pending'/g)!.length === 1,
      'the pending condition must live only inside canCancel',
    ).toBe(true);
  });
});
