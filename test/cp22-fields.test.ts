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
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { CP22_DEFAULT_FONT_SIZE, CP22_FIELDS, CP22_MEDIA_BOX, CP22_UNFILLABLE_BOXES } from '../lib/cp22-fields';
import { cp22FittingLineCount } from '../lib/cp22-pdf';

const MULTILINE = CP22_FIELDS.filter((f) => f.type === 'multiline');
const helvetica = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);

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
   * THE HEADROOM UNDER A MULTI-ROW BLOCK — a verified silent-data-loss bug turned into an assertion.
   *
   * pdf-lib lays a multiline field out downwards from the top of the widget rect and clips the appearance
   * to that rect inset by 1pt. Size the rect "top of row 1 → bottom of row R" and TWO things happen with
   * no error anywhere: the R-th line is sliced at the baseline (every descender on it gone) and an R+1-th
   * line is never drawn at all. Both shipped past tsc, the suite, `next build` and a 200 — a four-line
   * address is the shape LHDN rules this box for, and one of the two PDF renderers even hid it by
   * regenerating the appearance itself.
   *
   * So `rows` and the rect are pinned AGAINST EACH OTHER here, for every block including the ones only the
   * operator types into (1 and 29), which no rendered fixture can reach. Fewer whole lines than `rows`
   * means the block loses a line; more means the rect has grown into the block below.
   */
  it('sizes every multi-row block to hold exactly its declared rows, descenders and all', async () => {
    const font = await helvetica();
    expect(MULTILINE.length).toBe(6);
    for (const f of MULTILINE) {
      expect(f.rows, `${f.name} (box ${f.box}) must declare how many rows the printed block has`)
        .toBeGreaterThan(0);
      expect(
        cp22FittingLineCount(f.rect, f.fontSize ?? CP22_DEFAULT_FONT_SIZE, font),
        `${f.name} (box ${f.box}) rect holds a different number of WHOLE lines than the ${f.rows} rows it ` +
          `declares — too few and the last row is sliced or dropped, too many and it reaches into the ` +
          `block below. Extend the rect DOWNWARDS (see lib/cp22-fields.ts), never upwards.`,
      ).toBe(f.rows);
    }
  });

  /**
   * …and the top edge is what fixes where EVERY baseline lands (baseline_n = top − 1 − n × pitch), so the
   * headroom above had to be added below the last row. These are the edges the row alignment was derived
   * from; a change here moves the text off LHDN's printed rules.
   */
  it('hangs every multi-row block from its original top edge', () => {
    const tops = Object.fromEntries(MULTILINE.map((f) => [f.name, +(f.rect.y + f.rect.height).toFixed(2)]));
    expect(tops).toEqual({
      lhdnBranchAddress: 716.7,
      employerNameAddress: 731.86,
      residentialAddress: 508.25,
      correspondenceAddress: 441.74,
      monthlyAllowances: 216.07,
      previousEmployerInMalaysia: 116.73,
    });
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
