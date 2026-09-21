/**
 * f728826a — the frozen columns overlapped, and the table squeezed its own cells.
 *
 * TWO SEPARATE FAULTS, both on app/attendance/breakdown/page.tsx, and it matters that they are separate
 * because fixing either alone still leaves the reporter looking at overlapping text.
 *
 *   1. THE SQUEEZE. `<table className="w-full">` inside an overflow-x-auto box, with twenty-nine
 *      `whitespace-nowrap` columns. `w-full` pins the table to the container, so the browser compresses
 *      every cell BELOW the width its contents need; nowrap content cannot reflow, so it paints outside
 *      its own cell and over the next one. This is the overlap in the ordinary columns, and it gets
 *      worse the narrower the window — which is why a render check at one viewport proves nothing.
 *
 *   2. THE UNBACKED OFFSETS. Three identity columns were frozen at `left-0`, `left-[7rem]` and
 *      `left-[19rem]` with NO width set on any of them. `7 + 12 = 19` held only if the first two columns
 *      really were 7rem and 12rem wide, and nothing made them so — each was as wide as its content
 *      happened to be. A long name pushed the real edge past the assumed one and the frozen columns
 *      landed on top of each other. This is the first-three-columns overlap specifically.
 *
 * A COMMENT ASSERTING 7 + 12 = 19 IS WHAT FAILED, so the arithmetic is no longer written down anywhere:
 * the offset IS the running sum of the declared widths. These cases pin that it stays that way, and that
 * neither screen re-acquires a typed offset.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeStickyColumns, stickyWidth } from '../lib/sticky-columns';

const ROOT = join(__dirname, '..');
const src = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const SCREENS = ['app/attendance/breakdown/page.tsx', 'app/attendance/daily/page.tsx'] as const;

describe('f728826a · the offset is derived, never typed', () => {
  it('places each column at the running total of the widths before it', () => {
    const p = placeStickyColumns([
      { key: 'a', rem: 7 },
      { key: 'b', rem: 12 },
      { key: 'c', rem: 8 },
    ]);
    expect(p.map((c) => c.left)).toEqual([0, 7, 19]);
    expect(p.map((c) => c.style.left)).toEqual(['0rem', '7rem', '19rem']);
  });

  /**
   * THE REGRESSION ARM, and the reason this function exists rather than three constants. Widen the FIRST
   * column and every offset after it must move. Under the old hardcoded scheme it did not — that is the
   * whole fault, reproduced here as arithmetic.
   */
  it('widening a column moves everything after it', () => {
    const p = placeStickyColumns([
      { key: 'a', rem: 10 },
      { key: 'b', rem: 12 },
      { key: 'c', rem: 8 },
    ]);
    expect(p.map((c) => c.left), 'the 7→10 change must carry through').toEqual([0, 10, 22]);
  });

  /** Width is pinned three ways: a bare `width` is advisory on an auto-layout table, and a cell that
   *  grows to fit its content is the overlap itself. */
  it('pins each width against a browser growing the cell to fit', () => {
    const [only] = placeStickyColumns([{ key: 'a', rem: 7 }]);
    expect(only.style).toMatchObject({ width: '7rem', minWidth: '7rem', maxWidth: '7rem' });
  });

  it('reports the total frozen width', () => {
    expect(stickyWidth([{ key: 'a', rem: 7 }, { key: 'b', rem: 12 }])).toBe(19);
  });

  it('places nothing for no columns', () => {
    expect(placeStickyColumns([])).toEqual([]);
  });
});

describe('f728826a · neither screen may re-acquire a typed offset', () => {
  for (const p of SCREENS) {
    it(`${p} freezes columns only through the shared source`, () => {
      const s = src(p);
      expect(s, 'must use the shared placement').toContain('placeStickyColumns');
      // THE EXACT SHAPE THAT BROKE: a Tailwind left-* offset on a sticky cell. Note this also refuses
      // `left-0`, which was correct by luck — the first column's offset is still zero, but it is now
      // zero because the sum of the widths before it is zero, not because someone typed it.
      expect(s, 'no hand-typed sticky offset').not.toMatch(/sticky[^`'"]*\bleft-/);
      expect(s, 'no arbitrary rem offset class').not.toMatch(/left-\[\d/);
    });

    it(`${p} never squeezes the table with w-full`, () => {
      const s = src(p);
      const tables = s.match(/<table className="[^"]*"/g) ?? [];
      expect(tables.length, 'one table per screen').toBeGreaterThan(0);
      for (const t of tables) {
        // `w-full` is the squeeze. `w-max` sizes the table to what its columns actually need and
        // `min-w-full` still fills a wide screen, so nothing is ever compressed below content width.
        // NOT /\bw-full\b/: a hyphen is a word boundary, so that also matches inside `min-w-full`,
        // which is the fix. Only a STANDALONE w-full is the squeeze.
        expect(t, 'w-full pins the table to the container and compresses every cell').not.toMatch(
          /(?<![-\w])w-full\b/,
        );
        expect(t, 'must size to content').toMatch(/\bw-max\b/);
        expect(t, 'must still fill a wide screen').toMatch(/\bmin-w-full\b/);
      }
    });

    it(`${p} gives every sticky cell both a width and an offset`, () => {
      const s = src(p);
      // Every sticky cell carries style={STICKY[n].style}, which is the only way to get either.
      const stickyCells = s.match(/<t[hd][^>]*\bstick\w*\(/g) ?? [];
      expect(stickyCells.length, 'sticky cells exist').toBeGreaterThan(0);
      const styled = s.match(/style=\{(?:`?\$?\{?)?STICKY\[\d\]\.style\}/g) ?? [];
      expect(
        styled.length,
        `every sticky cell must take its geometry from STICKY (found ${stickyCells.length} cells, ${styled.length} styled)`,
      ).toBe(stickyCells.length);
    });
  }

  it('the long name is clipped in its own cell, with the full value on hover', () => {
    const s = src('app/attendance/breakdown/page.tsx');
    expect(s, 'clip rather than overrun').toContain('text-ellipsis');
    expect(s, 'and the full name must stay reachable').toContain('title={r.name}');
  });

  /** The numeric columns must KEEP nowrap — clipping is for the name, not for a figure. */
  it('keeps the numeric columns unwrapped', () => {
    expect(src('app/attendance/breakdown/page.tsx')).toMatch(/tdNum|tabular-nums/);
  });
});
