/**
 * dde08629 — Employee Attendance and its two sibling tabs at full width.
 *
 * NOT A NEW DESIGN, and the plan told the reporter so before approval: eight Attendance screens already
 * carried `pageWideCls` and were already pinned by test/attendance-screens-layout.test.ts. These three
 * were simply never added, so a sixteen-column table sat in a 72rem middle column with roughly a third
 * of a wide monitor as empty margin either side.
 *
 * The WIDTH itself is pinned where every other attendance screen's is — in that guard's WIDE_LIST_SCREENS
 * — rather than restated here, because a second list is how two guards come to disagree about which
 * screens are wide. What this file pins is the part that guard does not cover: the sticky identity
 * columns, and the promise that the forms were not swept up with the lists.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WIDENED = ['app/attendance/page.tsx', 'app/attendance/daily/page.tsx', 'app/attendance/individual/page.tsx'];
const DAILY = 'app/attendance/daily/page.tsx';

describe('dde08629 · the three screens are wide, and say so in the shared guard', () => {
  it.each(WIDENED)('%s uses pageWideCls and carries no page-level cap', (f) => {
    const src = codeOnly(read(f));
    expect(src, 'the house full-width idiom').toContain('className={pageWideCls}');
    expect(src, 'no centred cap survives').not.toMatch(/mx-auto\s+max-w-\w+/);
  });

  it.each(WIDENED)('%s is declared in the shared layout guard, not just widened', (f) => {
    // af7a8eb4's header: a screen can gain the layout without gaining the guard, and then lose it again
    // silently. Adding the file to WIDE_LIST_SCREENS is as much the deliverable as the className.
    expect(read('test/attendance-screens-layout.test.ts')).toContain(`'${f}'`);
  });

  /**
   * The other half of that guard, restated as a promise this change did NOT break.
   *
   * ⚠️ THE FORM THAT IS DELIBERATELY NARROW IS THE RULE FORM, NOT THE SHIFT FORM. 6340aecb widened the
   * Shift form on purpose — it stopped being one column of boxes — so it sits in WIDE_FORM_SCREENS.
   * Asserting the wrong one is how a "forms stay narrow" test comes to pass while the form it meant to
   * protect is wide; this file got that wrong on its first pass and its own assertion caught it.
   */
  it('the one-column form stayed narrow — the widening did not sweep it up', () => {
    const rules = codeOnly(read('app/admin/attendance-policy/rules/rule-form.tsx'));
    expect(rules, 'a one-column form keeps a comfortable reading width').not.toContain('pageWideCls');
    expect(read('test/attendance-screens-layout.test.ts')).toContain(
      "'app/admin/attendance-policy/rules/rule-form.tsx'",
    );
  });
});

describe('dde08629 · the identity columns stay put when the table scrolls', () => {
  /**
   * UPDATED BY f728826a (r322), NOT LOOSENED. This used to read
   *
   *   expect(src).toContain("stick('left-0', true)");
   *   expect(src).toContain("stick('left-[7rem]', true)");   … and the two body cells
   *
   * which pinned the OFFSETS as literal Tailwind classes. Those offsets were the fault: neither sticky
   * column had a WIDTH, so `left-[7rem]` was an assumption about how wide the code column happened to
   * render, and when a value was wider the frozen columns painted over one another. The Breakdown screen
   * showed it first; Daily carried the same unbacked arithmetic, masked by its min-width.
   *
   * The property this case protects — BOTH identity columns are frozen, header and body alike — is
   * unchanged and asserted below. What changed is that the offset is now DERIVED from the declared widths
   * (lib/sticky-columns.ts) instead of typed, so there is no literal left-* to assert any more. The
   * nesting-free geometry itself is pinned in test/f728826a-sticky-columns.test.ts.
   */
  it('Daily sticks Employee Code and Employee Name, header and body alike', () => {
    const src = codeOnly(read(DAILY));
    expect(src, 'geometry comes from the shared source').toContain('placeStickyColumns');
    // Two columns declared, in order, each with a width — which is what the old left-* values assumed
    // and nothing established.
    expect(src).toMatch(/\{ key: 'employeeCode', rem: \d+ \}/);
    expect(src).toMatch(/\{ key: 'employeeName', rem: \d+ \}/);
    // Header AND body, both columns: four sticky cells, each taking its geometry from STICKY.
    expect(src).toContain('stick(true)');
    expect(src).toContain('stick(false)');
    expect((src.match(/style=\{STICKY\[\d\]\.style\}/g) ?? []).length, 'two headers + two body cells').toBe(4);
    // And no hand-typed offset may come back.
    expect(src, 'no literal sticky offset').not.toMatch(/left-\[\d/);
  });

  /**
   * ⚠️ THE ONE THAT SILENTLY LOOKS BROKEN. A sticky cell's background is transparent by default, so the
   * scrolled columns slide visibly underneath the frozen ones. The header takes the table head's ground
   * and the body cells the card's — an omission here is invisible in the markup and obvious on screen.
   */
  it('every sticky cell carries an opaque background', () => {
    const src = codeOnly(read(DAILY));
    const helper = src.slice(src.indexOf('const stick ='), src.indexOf('bg-card') + 'bg-card'.length + 4);
    expect(helper, 'the header ground').toContain('bg-muted');
    expect(helper, 'the body ground').toContain('bg-card');
    expect(helper, 'and it is genuinely sticky').toContain('sticky');
    expect(helper, 'above the cells it overlaps').toContain('z-10');
  });

  it('Individual has no identity column to stick, and does not pretend to', () => {
    // One employee's own days — the employee is the page, not a column. A `stick()` here would be
    // freezing the date, which is not what the reporter asked for and not what it would help with.
    const src = codeOnly(read('app/attendance/individual/page.tsx'));
    expect(src).not.toContain('const stick =');
  });

  it('the table still scrolls sideways rather than the page', () => {
    const src = read(DAILY);
    expect(src, 'the scroll container is the table wrapper').toContain('overflow-x-auto');
  });
});
