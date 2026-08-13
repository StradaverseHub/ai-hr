/**
 * 88076362 — the CP22 [Pin.1/2021] coordinate map, checked as DATA.
 *
 * The reporter's review step for this feature was "look at the page and tell us if a box lands badly".
 * These assertions turn the failures that visual step would catch into things that cannot ship: a rect
 * that has walked off the page (invisible, and silently so — a widget outside the MediaBox simply does not
 * draw), two rects fighting for the same click, a block declaring more rows than it has boxes, and a
 * widget landing on the wrong one of the form's two pages.
 *
 * THIS FILE REPLACED THE 2020 EDITION'S TESTS, AND ITS OLD ASSERTIONS ARE NOT "STILL TRUE BUT MOVED".
 * The 2020 page printed CHARACTER CELLS, so the map carried comb counts, a 14-position tax-number row
 * whose third cell was a printed gap, and a telephone split into two fields flanking a printed dash — the
 * whole reason that map had 33 areas rather than 32. CP22 [Pin.1/2021] prints none of those things. The
 * tests that pinned them are DELETED rather than adapted, because there is nothing left for them to be
 * true about; what replaces them is the assertion that no comb exists at all, so a later edit cannot
 * reintroduce one against a page with no cells to align to.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  CP22_FIELDS,
  CP22_MEDIA_BOX,
  CP22_PAGE_COUNT,
  CP22_RULE_BASELINES,
  CP22_SECTIONS,
  CP22_UNFILLABLE,
  cp22Section,
  cp22Widgets,
} from '../lib/cp22-fields';
import { fitSingleLine } from '../lib/cp22-pdf';

const MULTIROW = CP22_FIELDS.filter((f) => f.type === 'multirow');
const helvetica = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);

/** Every widget the map produces, tagged with its page and the field it came from. */
const widgets = CP22_FIELDS.flatMap((f) => cp22Widgets(f).map((rect, i) => ({ f, rect, i })));

describe('CP22 [Pin.1/2021] field map — the 53 entry areas across two pages', () => {
  it('is 53 areas with unique codes and unique field names', () => {
    expect(CP22_FIELDS).toHaveLength(53);
    expect(new Set(CP22_FIELDS.map((f) => f.code)).size).toBe(53);
    expect(new Set(CP22_FIELDS.map((f) => f.name)).size).toBe(53);
  });

  /**
   * THE FIFTEEN ARE NAMED INDIVIDUALLY, not counted. Each is absent from the schema for a reason recorded
   * in lib/cp22-fields.ts, and a later change that quietly starts filling one of them — the spouse's tax
   * number from the EMPLOYEE's own row, section E from the SPOUSE's employer columns, an employer e-mail
   * from the tenant's SaaS billing contact — would be inventing an answer on a statutory form.
   *
   * The 2020 map left seven blank. The count grew because the 2021 form ASKS MORE (six new income lines in
   * section D, two in section E), not because anything regressed.
   */
  it('leaves exactly the fifteen unanswerable areas empty, and pre-fills the other 38', () => {
    expect(CP22_UNFILLABLE).toEqual([
      'A4', 'B5', 'B13X', 'C3',
      'D2', 'D3', 'D5', 'D6', 'D7', 'D8', 'D8ms', 'D8en',
      'E1', 'E2', 'F4',
    ]);
    expect(CP22_FIELDS.filter((f) => f.prefilled)).toHaveLength(38);
  });

  it('puts A/B/C on page 1 and D/E/F on page 2, and nothing on a page that does not exist', () => {
    for (const f of CP22_FIELDS) {
      expect(f.page, `${f.code} page`).toBeGreaterThanOrEqual(0);
      expect(f.page, `${f.code} page`).toBeLessThan(CP22_PAGE_COUNT);
      expect(f.page, `${f.code} is in section ${cp22Section(f)} and must be on the page that prints it`)
        .toBe('ABC'.includes(cp22Section(f)) ? 0 : 1);
    }
    // Every section the form prints has at least one entry area, so a whole section cannot go missing.
    for (const s of CP22_SECTIONS) {
      expect(CP22_FIELDS.filter((f) => cp22Section(f) === s.letter).length, `section ${s.letter}`)
        .toBeGreaterThan(0);
    }
  });

  it('places every widget inside the page — one outside the MediaBox draws nothing at all', () => {
    for (const { f, rect, i } of widgets) {
      const label = `${f.code} row ${i + 1}`;
      expect(rect.width, `${label} width`).toBeGreaterThan(0);
      expect(rect.height, `${label} height`).toBeGreaterThan(0);
      expect(rect.x, `${label} left`).toBeGreaterThanOrEqual(0);
      expect(rect.y, `${label} bottom`).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width, `${label} right`).toBeLessThanOrEqual(CP22_MEDIA_BOX.width);
      expect(rect.y + rect.height, `${label} top`).toBeLessThanOrEqual(CP22_MEDIA_BOX.height);
    }
  });

  /**
   * OVERLAP IS CHECKED PER WIDGET, NOT PER AREA, and per page. A `multirow` block is several widgets, so
   * checking only `f.rect` would have missed a second or third row growing into its neighbour — which is
   * exactly the direction these rects were derived in.
   */
  it('never overlaps two widgets on the same page', () => {
    const clashes: string[] = [];
    for (let i = 0; i < widgets.length; i++) {
      for (let j = i + 1; j < widgets.length; j++) {
        const A = widgets[i];
        const B = widgets[j];
        if (A.f.page !== B.f.page) continue;
        const overlapX = Math.min(A.rect.x + A.rect.width, B.rect.x + B.rect.width) - Math.max(A.rect.x, B.rect.x);
        const overlapY = Math.min(A.rect.y + A.rect.height, B.rect.y + B.rect.height) - Math.max(A.rect.y, B.rect.y);
        if (overlapX > 0.01 && overlapY > 0.01) {
          clashes.push(`${A.f.code}#${A.i + 1} × ${B.f.code}#${B.i + 1}`);
        }
      }
    }
    expect(clashes, clashes.join(', ')).toEqual([]);
  });

  /**
   * `rows` IS A HARD CEILING AND IT MUST MATCH THE GEOMETRY. This is r175a, kept alive through a change of
   * shape: the renderer folds a value's overflow into row `rows`, so a block whose declared `rows` is
   * larger than the number of boxes it actually has would fold into a row that does not exist — the
   * surplus line would be assigned to no widget and vanish with nothing in any log, and the block would
   * still look full. Declared and drawn are pinned against each other so they cannot drift.
   */
  it('gives every multi-row block exactly as many drawn boxes as the rows it declares', () => {
    expect(MULTIROW.length).toBe(9);
    for (const f of MULTIROW) {
      expect(f.rows, `${f.code} must declare how many printed rows the block has`).toBeGreaterThan(1);
      expect(cp22Widgets(f).length, `${f.code} declares ${f.rows} rows but draws a different number of boxes`)
        .toBe(f.rows);
      // Rows run TOP TO BOTTOM and share a column: a block whose rows drifted sideways or reordered would
      // still pass every check above while printing an address out of order.
      const rects = cp22Widgets(f);
      for (let i = 1; i < rects.length; i++) {
        expect(rects[i].y, `${f.code} row ${i + 1} must sit below row ${i}`).toBeLessThan(rects[i - 1].y);
        expect(rects[i].x, `${f.code} row ${i + 1} must share the block's left edge`).toBeCloseTo(rects[0].x, 1);
        expect(rects[i].width, `${f.code} row ${i + 1} must share the block's width`).toBeCloseTo(rects[0].width, 1);
      }
    }
    expect(MULTIROW.map((f) => `${f.code}:${f.rows}`)).toEqual([
      'A1:2', 'A2:3', 'B1:2', 'B12:3', 'B13:3', 'C1:2', 'E1:3', 'E2:3', 'F1:2',
    ]);
  });

  /**
   * NO CHARACTER CELLS ANYWHERE. The whole comb apparatus existed for a page that no longer exists; on the
   * 2021 page a combed field would space one glyph per notional cell across a plain box, which looks like
   * a rendering fault and is not what LHDN prints. The type union no longer has 'comb' — this asserts the
   * map has not grown a lookalike either.
   */
  it('carries no character-cell fields and exactly one tick box', () => {
    expect(CP22_FIELDS.filter((f) => (f as { maxLen?: number }).maxLen !== undefined)).toEqual([]);
    expect(CP22_FIELDS.filter((f) => f.type === 'checkbox').map((f) => f.code)).toEqual(['B13X']);
  });

  /**
   * THE FOUR DOTTED RULES. Their rects are the only ones COMPUTED rather than read off a drawn cell, from
   * pdf-lib's own single-line layout rule — so this checks the computation lands the baseline where the
   * printed dots are, rather than trusting the arithmetic. Off by more than a point and the text either
   * floats above the rule or is struck through by it.
   */
  it('sits every dotted-rule field on its printed dots', async () => {
    const font = await helvetica();
    const rules = CP22_FIELDS.filter((f) => f.type === 'rule');
    expect(rules.map((f) => f.code)).toEqual(['D4ms', 'D4en', 'D8ms', 'D8en']);
    for (const f of rules) {
      const dots = CP22_RULE_BASELINES[f.name as keyof typeof CP22_RULE_BASELINES];
      expect(dots, `${f.code} must have a measured dot run`).toBeTruthy();
      const size = f.fontSize!;
      // pdf-lib: baseline = rect.y + rect.height/2 − ascent(size)/2, with the 1pt inset cancelling.
      const ascent = font.heightAtSize(size, { descender: false });
      const baseline = f.rect.y + f.rect.height / 2 - ascent / 2;
      expect(baseline, `${f.code} baseline must rest just above the printed dots at ${dots.baseline}`)
        .toBeCloseTo(dots.baseline + 1.2, 1);
      expect(f.rect.x).toBeCloseTo(dots.x0, 2);
      expect(f.rect.x + f.rect.width).toBeCloseTo(dots.x1, 2);
    }
  });

  /**
   * EVERY BOX MUST HOLD A REALISTIC VALUE AT A LEGIBLE SIZE. `fitSingleLine` guarantees nothing is ever
   * clipped — it shrinks until the value fits — so the failure this catches is not loss but illegibility:
   * a box mapped far too narrow would "pass" by rendering a name at 4pt. A Malaysian legal name of this
   * length is ordinary, and it must still be readable in the boxes that take one.
   */
  it('holds an ordinary Malaysian legal name at a legible size in every name box', async () => {
    const font = await helvetica();
    const NAME = 'Nurul Aisyah binti Mohd Zulkifli Abdullah';
    for (const code of ['B1', 'C1', 'F1', 'A1']) {
      const f = CP22_FIELDS.find((x) => x.code === code)!;
      const size = fitSingleLine(NAME, f.rect, f.fontSize ?? 9, font);
      expect(size, `${code} shrinks an ordinary legal name to ${size}pt — the box is mapped too narrow`)
        .toBeGreaterThanOrEqual(7);
    }
  });

  /** Every area carries the form's own printed label, which the text export and preview screen both read. */
  it('labels every area with the words LHDN prints beside it', () => {
    for (const f of CP22_FIELDS) {
      expect(f.label, `${f.code} label`).toBeTruthy();
      expect(f.label.length, `${f.code} label`).toBeGreaterThan(3);
    }
    expect(CP22_FIELDS.find((f) => f.code === 'B12S')!.label).toBe('Negeri / State');
    expect(CP22_FIELDS.find((f) => f.code === 'DT')!.label).toBe('JUMLAH / TOTAL');
  });
});
