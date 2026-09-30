/**
 * r369 — THE PCB DETAIL MUST NOT PRINT THE WORD "null" ON A TAX DOCUMENT.
 *
 * `PcbTrace.childCount` is `number | null` (core/pcb-explain.ts:94). r364 made it nullable on purpose:
 * `readTrace` refuses to coerce absence to 0 because a payslip generated before r359 genuinely never
 * recorded the count, and printing `RM0.00` there asserts the money does not exist (CLAUDE.md §8).
 *
 * r364 fixed the kernel's vocabulary and left BOTH render sites testing the wrong thing — `trace ? … : na`
 * asks whether the TRACE exists, not whether the FIELD does. The two symptoms differed, which is why
 * neither was noticed:
 *
 *   · the PDF (app/payroll/pcb-detail/shared.ts) did `String(trace.childCount)` and printed the literal
 *     four characters "null" into a downloaded statutory document;
 *   · the screen (app/payroll/pcb-detail/pcb-detail-view.tsx, two rows) passed the null straight to
 *     React, which renders null as NOTHING — a silently empty cell where a figure belongs.
 *
 * WHY THIS IS A SOURCE GUARD AND NOT A RENDERED ASSERTION, STATED PLAINLY. The PDF rows are assembled
 * inside `pcbDetailPdfResponse`, an async route handler that resolves a session and reads a payslip, so
 * pinning the output needs a payslip whose stamp predates r359 — a fixture no seeded database can
 * produce. That is exactly why nothing pinned it. The defect, however, IS a source pattern: the wrong
 * operand in a ternary. So this guard pins the pattern, at the level the defect lives, which is the same
 * choice test/pcb-detail.test.ts already makes when it forbids arithmetic operators in formulas.ts. When
 * the ten-sequence work builds a pre-r359 fixture, this should be joined by a rendered assertion.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING. Twice in one day a source guard in this repo passed because a
 * comment happened to quote the string it was looking for — and this file's whole purpose is to quote the
 * retired pattern. Without stripping, this test would pass on its own header.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** Block comments, line comments and JSX `{/* … *\/}` all go, so only executable source is matched. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const PDF = 'app/payroll/pcb-detail/shared.ts';
const SCREEN = 'app/payroll/pcb-detail/pcb-detail-view.tsx';

describe('PCB detail — a missing child count renders "Not recorded", never "null" and never blank', () => {
  it('the comment stripper actually strips, so this suite cannot pass on its own prose', () => {
    // Guarding the guard: every assertion below is a claim about the ABSENCE of a string, and this file
    // contains all of those strings in its header. If stripping regressed, the tests would still pass
    // while proving nothing — the exact failure mode they exist to prevent.
    expect(codeOnly('const a = 1; // String(trace.childCount)')).not.toContain('String(trace.childCount)');
    expect(codeOnly('/* trace ? trace.childCount : x */ const b = 2;')).not.toContain('trace.childCount');
    expect(codeOnly('{/* trace ? trace.childCount : x */}')).not.toContain('trace.childCount');
    // ...and it must not eat real code, or an absence assertion becomes vacuous for a different reason.
    expect(codeOnly('const u = `https://x/y`;')).toContain('https://x/y');
    expect(codeOnly('const v = trace?.childCount != null;')).toContain('trace?.childCount != null');
  });

  it('the PDF never stringifies the count without checking the FIELD first', () => {
    const src = codeOnly(read(PDF));
    // The retired expression, quoted so a reader knows what regressed if this fails:
    //   figure(t('reliefChildCount'), trace ? String(trace.childCount) : na)
    expect(src, `${PDF} stringifies a possibly-null childCount — that prints "null" on a statutory PDF`).not.toMatch(
      /trace\s*\?\s*String\(\s*trace\.childCount\s*\)/,
    );
    expect(src, `${PDF} must guard the field: trace?.childCount != null`).toContain('trace?.childCount != null');
  });

  it('both screen rows guard the FIELD, so React is never handed a bare null', () => {
    const src = codeOnly(read(SCREEN));
    // The retired expression:  value={trace ? trace.childCount : <NotRecorded />}
    expect(src, `${SCREEN} tests the trace instead of the count — React draws an empty cell`).not.toMatch(
      /trace\s*\?\s*trace\.childCount\s*:/,
    );
    // BOTH sites, counted. The screen prints the count twice (Step 1 [A] and the relief breakdown) and
    // fixing one of them is how this defect survived r364 in the first place.
    const guarded = src.match(/trace\?\.childCount\s*!=\s*null/g) ?? [];
    expect(guarded.length, `${SCREEN} must guard BOTH childCount rows, found ${guarded.length}`).toBe(2);
  });

  it('the kernel still refuses to invent a zero, which is what makes the render guards necessary', () => {
    // If core ever coerced absence to 0 again, these render guards would be dead weight and the product
    // would be back to asserting "no children" about a payslip that simply never recorded the number.
    const core = codeOnly(read('core/pcb-explain.ts'));
    expect(core).toContain('childCount: number | null');
    expect(core, 'readTrace must map an absent count to null, never to 0').toMatch(
      /childCount:\s*t\.childCount === undefined \? null :/,
    );
  });
});
