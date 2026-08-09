/**
 * d3a9383c — the CP22 coordinate map, checked as DATA.
 *
 * The reporter's review step for this feature was "look at the page and tell us if a box lands badly".
 * These assertions turn the two failures that visual step would catch into things that cannot ship: a rect
 * that has walked off the page (invisible, and silently so — a widget outside the MediaBox simply does not
 * draw) and two rects that overlap (two boxes fighting for the same click, with one of them unreachable).
 *
 * They also pin the COUNT, which is the number the business half of the plan commits to: 33 entry areas,
 * 26 pre-filled, 7 left empty. Counting the form by eye gives 32 — the difference is the employee's
 * telephone, which is two fields flanking a printed dash rather than one field covering it, and there is a
 * test below that says so in those terms so a later "simplification" into one field fails here.
 */
import { describe, expect, it } from 'vitest';
import { CP22_FIELDS, CP22_MEDIA_BOX, CP22_UNFILLABLE_BOXES } from '../lib/cp22-fields';

/** The dash PRINTED between the two telephone cell groups, from the template's own content stream. */
const PRINTED_DASH_X = 100.94;

describe('CP22 field map — the 33 entry areas', () => {
  it('is 33 areas, numbered 1–33 exactly once, with unique field names', () => {
    expect(CP22_FIELDS).toHaveLength(33);
    expect(CP22_FIELDS.map((f) => f.box).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 33 }, (_, i) => i + 1),
    );
    expect(new Set(CP22_FIELDS.map((f) => f.name)).size).toBe(33);
  });

  /**
   * 26 and 7 are the numbers the reporter approved, and the SEVEN are named individually: each is absent
   * from the schema for a reason recorded in lib/cp22-pdf.ts, and a later change that quietly starts
   * filling one of them (spouse tax number from the employee's own row, "previous employer" from the
   * SPOUSE's employer columns) would be inventing an answer on a statutory form.
   */
  it('pre-fills 26 and leaves exactly the seven unanswerable boxes empty', () => {
    expect(CP22_FIELDS.filter((f) => f.prefilled)).toHaveLength(26);
    expect(CP22_UNFILLABLE_BOXES).toEqual([1, 11, 18, 25, 28, 29, 30]);
  });

  it('places every rect inside the page — a widget outside the MediaBox draws nothing at all', () => {
    for (const f of CP22_FIELDS) {
      const { x, y, width, height } = f.rect;
      expect(width, `${f.name} width`).toBeGreaterThan(0);
      expect(height, `${f.name} height`).toBeGreaterThan(0);
      expect(x, `${f.name} left`).toBeGreaterThanOrEqual(0);
      expect(y, `${f.name} bottom`).toBeGreaterThanOrEqual(0);
      expect(x + width, `${f.name} right`).toBeLessThanOrEqual(CP22_MEDIA_BOX.width);
      expect(y + height, `${f.name} top`).toBeLessThanOrEqual(CP22_MEDIA_BOX.height);
    }
  });

  it('never overlaps two boxes — every pair has zero shared area', () => {
    const clashes: string[] = [];
    for (let i = 0; i < CP22_FIELDS.length; i++) {
      for (let j = i + 1; j < CP22_FIELDS.length; j++) {
        const a = CP22_FIELDS[i].rect;
        const b = CP22_FIELDS[j].rect;
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (overlapX > 0 && overlapY > 0) {
          clashes.push(`${CP22_FIELDS[i].name} × ${CP22_FIELDS[j].name}`);
        }
      }
    }
    expect(clashes, clashes.join(', ')).toEqual([]);
  });

  /**
   * THE ENTIRE DIFFERENCE BETWEEN 33 AND 32. The form prints a dash between the two telephone cell groups;
   * one field spanning both would cover it. So there are two, and neither may cross the dash.
   */
  it('splits the employee telephone into two fields that flank the printed dash', () => {
    const prefix = CP22_FIELDS.find((f) => f.name === 'telephonePrefix')!;
    const number = CP22_FIELDS.find((f) => f.name === 'telephoneNumber')!;
    expect(prefix.rect.x + prefix.rect.width).toBeLessThan(PRINTED_DASH_X);
    expect(number.rect.x).toBeGreaterThan(PRINTED_DASH_X);
    expect([prefix.box, number.box]).toEqual([12, 13]);
  });

  it('gives every character-cell row a cell count, and has exactly one tick box', () => {
    for (const f of CP22_FIELDS.filter((x) => x.type === 'comb')) {
      expect(f.maxLen, `${f.name} must declare its printed cell count`).toBeGreaterThan(0);
    }
    expect(CP22_FIELDS.filter((f) => f.type === 'checkbox').map((f) => f.box)).toEqual([11]);
  });

  /**
   * The two tax-number rows print 2 cells, a one-cell GAP, then 11 — 14 comb positions. A map that said 13
   * (counting only the printed cells) would push every digit one cell to the left of where LHDN prints it.
   */
  it('counts the tax-number rows as 14 comb positions, gap included', () => {
    const income = CP22_FIELDS.find((f) => f.name === 'incomeTaxNo')!;
    const spouse = CP22_FIELDS.find((f) => f.name === 'spouseIncomeTaxNo')!;
    expect(income.maxLen).toBe(14);
    expect(spouse.maxLen).toBe(14);
    // …while the IC and passport rows are 12 contiguous cells, and the two dates are 8.
    expect(CP22_FIELDS.find((f) => f.name === 'icNo')!.maxLen).toBe(12);
    expect(CP22_FIELDS.find((f) => f.name === 'commencementDate')!.maxLen).toBe(8);
    expect(CP22_FIELDS.find((f) => f.name === 'dateOfBirth')!.maxLen).toBe(8);
  });
});
