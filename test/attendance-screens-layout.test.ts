/**
 * af7a8eb4 — Attendance module: full-width list screens, and the shift form on its own page.
 *
 * Source-static guard, in the house style of test/leave-config-full-width.test.ts. Nothing pinned either
 * page's markup before this, in EITHER direction: the shift form could silently come back onto the list,
 * and the width cap could silently come back onto any of the five list screens.
 *
 * What is pinned, and why each one:
 *
 *  A. The five LIST screens in the Attendance admin menu use `pageWideCls` and carry no page-level width
 *     cap. On a 1920px window the old `mx-auto max-w-4xl` left about 745px — 45 percent of the content
 *     area — as empty margin either side of the table. `/admin/toil` is DELIBERATELY not in the list: it
 *     is a short settings summary with no list and gains nothing from the extra width.
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
