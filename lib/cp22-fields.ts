/**
 * CP22 (Pin. 1/2020) — the hand-verified coordinate map for the 33 entry areas on LHDN's official page.
 *
 * THE NUMBERS HERE ARE DATA, NOT A GUESS. Every rect was derived from the DRAWN CELL RECTANGLES in the
 * bundled template's page content stream (`public/forms/cp22-pin-1-2020.pdf`), not from where a label
 * happens to sit: the page draws each table border as a thin filled `re`, so the horizontal and vertical
 * runs were reduced to lines and the enclosing cell read off for each entry area. That is what makes the
 * character-cell rows (income tax no., IC no., passports, the two dates) land ON the printed cells instead
 * of near them. The derivation script was a throwaway — this file is the artefact, and it is reviewed and
 * tested as data (test/cp22-fields.test.ts pins every rect inside the MediaBox and pins that no two
 * overlap, which is the visual QA turned into an assertion).
 *
 * THE COUNT IS 33 AND IT IS DELIBERATE. Counting by eye gives 32. The difference is the employee's
 * telephone number, which the form draws as TWO groups of character cells flanking a PRINTED DASH at
 * x≈100.9 — a single field spanning the pair would cover the dash, so it is two fields (boxes 12 and 13).
 * 26 of the 33 pre-fill; the other 7 (boxes 1, 11, 18, 25, 28, 29, 30) are rendered as EMPTY, still
 * editable boxes because the answer is not held anywhere in the system. See lib/cp22-pdf.ts.
 *
 * WHY THE MULTI-ROW BLOCKS CARRY ODD FONT SIZES (11.35, 11.68, 10.49, 12.11, 10.7). An address block on
 * this form is four RULED ROWS, and a wrapping field lays its lines out at pdf-lib's own pitch —
 * 1.2 × the font's height, which is 1.11 × the point size for Helvetica. At 8pt that is 8.9pt against a
 * printed row pitch of 12.6pt, so by the third line the text is struck through by a rule (observed on the
 * first render). The size is therefore chosen per block as `rowPitch / 1.11`, and the block's height is
 * extended just enough that the FIRST line lands inside the FIRST row; every line after it then falls in
 * its own row because the pitches match. The two blocks with no interior rules (2 and, for the operator's
 * own typing, 1) are sized to fit their content instead.
 *
 * COORDINATES ARE PDF USER SPACE: origin bottom-left, y increasing upward, MediaBox 0 0 595.44 841.68.
 */

/** The bundled template's single page box. Asserted against the real file in test/cp22-template.test.ts. */
export const CP22_MEDIA_BOX = { width: 595.44, height: 841.68 } as const;

export type Cp22FieldType =
  /** One-line text box drawn as a plain rectangle on the form. */
  | 'text'
  /** Text box over a block of ruled rows — wraps across them. */
  | 'multiline'
  /** Text box over a row of printed character cells — one glyph per cell (`maxLen` is required). */
  | 'comb'
  /** The single tick box on the correspondence-address block. */
  | 'checkbox';

export type Cp22Field = {
  /** 1–33, the number printed on the mockup the reporter approved. Stable; it is how the form is reviewed. */
  box: number;
  /** AcroForm field name. Stable — it is what an operator's PDF viewer shows and what the tests address. */
  name: string;
  type: Cp22FieldType;
  /** PDF user space, origin bottom-left. */
  rect: { x: number; y: number; width: number; height: number };
  /** Character-cell count. Required for `comb`; ignored otherwise. */
  maxLen?: number;
  /** Point size for the appearance stream. Omitted ⇒ CP22_DEFAULT_FONT_SIZE. */
  fontSize?: number;
  /**
   * FALSE for the seven boxes the system genuinely cannot answer (see lib/cp22-pdf.ts). They are still
   * created, still editable, and never carry an invented value.
   */
  prefilled: boolean;
};

export const CP22_DEFAULT_FONT_SIZE = 9;

/**
 * The 33 entry areas, in the mockup's numbering order (which is reading order down the page).
 *
 * A rect is `x, y` of the bottom-left corner plus width/height, matching pdf-lib's `addToPage` options.
 */
export const CP22_FIELDS: Cp22Field[] = [
  // ── "Kepada / To" block: the LHDN branch you file with. Four printed dotted rules, no drawn cell, so
  //    the rect is the dotted runs' own extent (x 43.2 → 235.9, baselines 704.38 / 692.50 / 680.62 / 668.62).
  { box: 1, name: 'lhdnBranchAddress', type: 'multiline', rect: { x: 43.2, y: 666.6, width: 192.7, height: 50.1 }, fontSize: 10.7, prefilled: false },

  // ── Employer block (top right).
  { box: 2, name: 'employerNameAddress', type: 'multiline', rect: { x: 274.73, y: 689.02, width: 265.37, height: 42.84 }, fontSize: 7, prefilled: true },
  { box: 3, name: 'employerNo', type: 'text', rect: { x: 444.79, y: 670.9, width: 95.19, height: 11.64 }, prefilled: true },
  { box: 4, name: 'employerPhone', type: 'text', rect: { x: 444.79, y: 652.9, width: 95.19, height: 11.52 }, prefilled: true },

  // ── MAKLUMAT PEKERJA BAHARU / Particulars of new employee — left column.
  { box: 5, name: 'employeeFullName', type: 'text', rect: { x: 112.82, y: 598.87, width: 195.15, height: 19.83 }, prefilled: true },
  { box: 6, name: 'natureOfEmployment', type: 'text', rect: { x: 138.74, y: 570.67, width: 169.23, height: 21.72 }, prefilled: true },
  // 8 printed cells, hh/bb/tttt (dd/mm/yyyy) — written as ddmmyyyy with no separators.
  { box: 7, name: 'commencementDate', type: 'comb', rect: { x: 205.01, y: 552.55, width: 102.96, height: 11.64 }, maxLen: 8, prefilled: true },
  { box: 8, name: 'expectedDuration', type: 'text', rect: { x: 205.01, y: 523.99, width: 102.96, height: 17.76 }, prefilled: true },
  // Four ruled rows each; one wrapping field over the block.
  { box: 9, name: 'residentialAddress', type: 'multiline', rect: { x: 52.8, y: 457.15, width: 255.17, height: 51.1 }, fontSize: 11.35, prefilled: true },
  { box: 10, name: 'correspondenceAddress', type: 'multiline', rect: { x: 52.8, y: 388.61, width: 254.57, height: 53.13 }, fontSize: 11.68, prefilled: true },
  { box: 11, name: 'correspondenceIsTaxAgent', type: 'checkbox', rect: { x: 52.8, y: 361.85, width: 13.94, height: 17.4 }, prefilled: false },
  // THE PRINTED DASH AT x≈100.9 IS WHY THESE ARE TWO FIELDS, NOT ONE. 3 cells then 8 cells.
  { box: 12, name: 'telephonePrefix', type: 'comb', rect: { x: 53.04, y: 331.49, width: 42.5, height: 12.12 }, maxLen: 3, prefilled: true },
  { box: 13, name: 'telephoneNumber', type: 'comb', rect: { x: 109.82, y: 331.49, width: 113.55, height: 12.12 }, maxLen: 8, prefilled: true },
  { box: 14, name: 'email', type: 'text', rect: { x: 52.56, y: 301.97, width: 255.65, height: 12.6 }, fontSize: 8, prefilled: true },

  // ── Particulars — right column. The two tax-number rows print 2 cells, a ONE-CELL GAP, then 11 cells:
  //    14 comb positions, of which the third is the gap. lib/cp22-pdf.ts formats the value around it.
  { box: 15, name: 'incomeTaxNo', type: 'comb', rect: { x: 327.9, y: 597.67, width: 165.28, height: 11.67 }, maxLen: 14, prefilled: true },
  { box: 16, name: 'icNo', type: 'comb', rect: { x: 327.9, y: 568.51, width: 141.64, height: 11.52 }, maxLen: 12, prefilled: true },
  { box: 17, name: 'currentPassportNo', type: 'comb', rect: { x: 327.9, y: 539.23, width: 141.64, height: 11.52 }, maxLen: 12, prefilled: true },
  { box: 18, name: 'previousPassportNo', type: 'comb', rect: { x: 327.9, y: 501.91, width: 141.64, height: 11.64 }, maxLen: 12, prefilled: false },
  // The form prints "1 = Lelaki / Male" and "2 = Perempuan / Female" beside a single cell.
  { box: 19, name: 'gender', type: 'comb', rect: { x: 327.9, y: 472.75, width: 11.77, height: 11.52 }, maxLen: 1, prefilled: true },
  { box: 20, name: 'citizen', type: 'text', rect: { x: 434.11, y: 472.75, width: 106.23, height: 11.52 }, fontSize: 8, prefilled: true },
  { box: 21, name: 'dateOfBirth', type: 'comb', rect: { x: 327.9, y: 432.41, width: 94.45, height: 11.54 }, maxLen: 8, prefilled: true },
  { box: 22, name: 'maritalStatus', type: 'text', rect: { x: 434.11, y: 432.41, width: 106.23, height: 11.54 }, fontSize: 8, prefilled: true },

  // ── "Jika berkahwin, nyatakan / If married, state".
  { box: 23, name: 'spouseFullName', type: 'text', rect: { x: 336.67, y: 371.93, width: 203.54, height: 11.52 }, fontSize: 8, prefilled: true },
  { box: 24, name: 'spouseIcOrPassport', type: 'comb', rect: { x: 336.43, y: 331.61, width: 141.63, height: 11.52 }, maxLen: 12, prefilled: true },
  { box: 25, name: 'spouseIncomeTaxNo', type: 'comb', rect: { x: 336.55, y: 291.41, width: 165.27, height: 11.52 }, maxLen: 14, prefilled: false },

  // ── TERMA-TERMA PENGGAJIAN / Terms of employment. "RM" is PRINTED at x≈434.6, so box 26 starts clear of it.
  { box: 26, name: 'monthlyFixedRemuneration', type: 'text', rect: { x: 450, y: 253.46, width: 101.5, height: 11.28 }, prefilled: true },
  { box: 27, name: 'monthlyAllowances', type: 'multiline', rect: { x: 71.18, y: 179.78, width: 482, height: 36.29 }, fontSize: 10.49, prefilled: true },
  { box: 28, name: 'fluctuatingEmoluments', type: 'text', rect: { x: 71.18, y: 145.46, width: 482, height: 11.64 }, fontSize: 9, prefilled: false },
  { box: 29, name: 'previousEmployerInMalaysia', type: 'multiline', rect: { x: 247.13, y: 75, width: 304.85, height: 41.73 }, fontSize: 12.11, prefilled: false },

  // ── Signature block. Four printed dotted rules from x 219.65; the glyphs are one em wide at 8.04pt,
  //    so 18 of them run to x≈364.
  { box: 30, name: 'employerSignature', type: 'text', rect: { x: 220, y: 56.5, width: 144, height: 12 }, fontSize: 8, prefilled: false },
  { box: 31, name: 'signatoryName', type: 'text', rect: { x: 220, y: 44.3, width: 144, height: 11.2 }, fontSize: 8, prefilled: true },
  { box: 32, name: 'signatoryDesignation', type: 'text', rect: { x: 220, y: 32.1, width: 144, height: 11.2 }, fontSize: 8, prefilled: true },
  { box: 33, name: 'signatureDate', type: 'text', rect: { x: 220, y: 19.9, width: 144, height: 11.2 }, fontSize: 8, prefilled: true },
];

/** The seven boxes the system genuinely cannot answer — rendered empty and editable, never invented. */
export const CP22_UNFILLABLE_BOXES = CP22_FIELDS.filter((f) => !f.prefilled).map((f) => f.box);

export type Cp22FieldName = (typeof CP22_FIELDS)[number]['name'];
