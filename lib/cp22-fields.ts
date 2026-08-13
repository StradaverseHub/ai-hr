/**
 * CP22 [Pin.1/2021] — the coordinate map for the 53 entry areas on LHDN's official TWO-PAGE form.
 *
 * THIS FILE REPLACED A MAP OF THE 2020 EDITION, AND NOT ONE NUMBER CARRIED OVER. LHDN superseded
 * CP22 (Pin. 1/2020) with CP22 [Pin.1/2021] — a different document, not a re-issue: two pages instead of
 * one, lettered sections A–F instead of an unlettered run, monthly pay split across eight numbered lines
 * instead of one box, postcode/town/state given their own boxes, and NO CHARACTER-CELL COMBS ANYWHERE.
 * Every rect below was re-derived from the 2021 artwork; nothing was nudged from a 2020 position, because
 * a nudge from an invalidated coordinate is indistinguishable from a fresh mistake.
 *
 * THE NUMBERS HERE ARE DATA, NOT A GUESS. Each rect is the DRAWN CELL the artwork prints, read off the
 * page content streams of `public/forms/cp22-pin-1-2021.pdf`: Word paints every table rule as a thin
 * filled `re`, so the fills were reduced to horizontal and vertical runs, collinear runs merged, the runs
 * a crossing rule breaks in two bridged back together, and the smallest CLOSED cell containing each entry
 * area read off by fixpoint (a rule only walls a cell if it spans the cell's whole width). Every probe was
 * then checked to land in a cell containing NO printed text — a rect that swallowed a label would be a
 * derivation bug, and that check is what catches it. The derivation script was a throwaway; THIS FILE is
 * the artefact, and it is reviewed and tested as data (test/cp22-fields.test.ts).
 *
 * WHAT THE 2021 EDITION DELETED, AND WHY THE TYPES SHRANK WITH IT:
 *   - No character cells. The 2020 page printed combs for the tax number, IC, passports, dates and the
 *     telephone; 2021 prints plain boxes. `Cp22FieldType 'comb'`, `maxLen`, the 14-position tax-number gap
 *     and the two-part telephone split (which existed ONLY because the 2020 page printed a dash between
 *     two cell groups) are all gone rather than left unused — dead code on a statutory form map reads as
 *     an instruction to a later editor.
 *   - No "Kepada / To" block. The branch you file with has NO box on this form. It is kept on the preview
 *     screen and in the text export and is documented there as not printing; it is not mapped here.
 *
 * WHY MULTI-ROW BLOCKS ARE ONE FIELD PER PRINTED ROW, NOT ONE FIELD OVER THE BLOCK. The 2020 address
 * block was four RULED ROWS inside a single drawn box, so it was mapped as one wrapping field whose font
 * size had to be pinned to the row pitch (`rowPitch / 1.11`) to stop lines being struck through by a rule.
 * The 2021 blocks are not that shape: B12, B13, A1, A2, B1, C1, E1, E2 and F's declarant name are each a
 * stack of SEPARATE drawn cells. Mapping them as one wrapping field would force an 18pt face (the row
 * pitch here is ~20.3pt) and re-import pdf-lib's multiline clip-floor failure for nothing. One single-line
 * field per printed cell instead: each line is centred in its own box at a readable size, and the
 * clip-floor class of silent loss cannot occur because there is no multiline layout.
 *
 * THE SILENT-LOSS GUARD MOVED WITH THE SHAPE — IT DID NOT GO AWAY. r175a was a four-line Malaysian
 * address filed to LHDN without its state, because the renderer dropped every line past the third and the
 * box still looked full. Per-row fields turn that into two different silent drops, and BOTH are guarded in
 * lib/cp22-pdf.ts rather than here:
 *   1. MORE VALUE LINES THAN THE BLOCK HAS ROWS — line 4 of a 3-row block would simply never be assigned
 *      to a field. `rows` below is a HARD CEILING and the renderer folds the tail into the last row.
 *   2. A LINE TOO WIDE FOR ITS BOX — pdf-lib's single-line layout neither wraps nor truncates; it draws
 *      the whole line and the appearance's own clip cuts it off mid-word, with nothing in any log. This
 *      one the 2020 renderer never guarded at all: a long legal name in a 195pt box was already being
 *      clipped. The renderer now shrinks any single-line value until it fits, so nothing is ever cut.
 *
 * COORDINATES ARE PDF USER SPACE: origin bottom-left, y increasing upward, MediaBox 0 0 595.44 841.68 on
 * BOTH pages.
 */

/** Both template pages carry this box. Asserted against the real file in test/cp22-pdf.test.ts. */
export const CP22_MEDIA_BOX = { width: 595.44, height: 841.68 } as const;

/** The 2021 form is two pages: A/B/C on page 1, D/E/F on page 2. */
export const CP22_PAGE_COUNT = 2;

export type Cp22FieldType =
  /** One-line box drawn as a rectangle on the form. Shrunk to fit rather than clipped. */
  | 'text'
  /** A stack of `rows` separately-drawn one-line boxes sharing an x and a width. */
  | 'multirow'
  /** A one-line box positioned on a PRINTED DOTTED RULE rather than inside a drawn cell. */
  | 'rule'
  /** The single tick box, on B13's tax-agent question. */
  | 'checkbox';

export type Cp22Rect = { x: number; y: number; width: number; height: number };

export type Cp22Field = {
  /**
   * LHDN's OWN box label — 'A1', 'B12', 'D4', 'F3'. The 2020 map numbered its boxes 1–33 because that
   * page numbers nothing; this one is lettered and numbered by the agency, so the agency's label is the
   * identifier. It is how the form is reviewed, how the preview screen groups, and how the text export
   * is ordered. Suffixed where one label owns several boxes (B12P/B12T/B12S are Poskod/Bandar/Negeri).
   */
  code: string;
  /** AcroForm field name. Stable — it is what an operator's PDF viewer shows and what the tests address. */
  name: string;
  type: Cp22FieldType;
  /** 0-based page index. A/B/C are page 0; D/E/F are page 1. */
  page: number;
  /**
   * The drawn cell, in PDF user space. For `multirow` this is the FIRST (topmost) row; the rest are in
   * `moreRows`. For `rule` it is derived from the printed dots — see `CP22_RULE_BASELINES`.
   */
  rect: Cp22Rect;
  /**
   * REQUIRED for `multirow`: rows 2..N, top to bottom, each a separately drawn cell. Kept as whole rects
   * rather than a pitch because the artwork's rows are NOT evenly spaced (19.80 / 19.92 / 19.94 all occur)
   * and a computed pitch would drift off the printed cell by the third row.
   */
  moreRows?: Cp22Rect[];
  /**
   * REQUIRED for `multirow`, ignored otherwise: how many printed rows the block has, which is
   * `1 + moreRows.length`. Declared rather than derived so test/cp22-fields.test.ts can assert the two
   * against each other — a row added to the geometry without raising the ceiling would silently drop a
   * line, which is precisely r175a.
   */
  rows?: number;
  /**
   * How the overflow past the last row is joined back INTO the last row. Defaults to `', '`, which is how
   * an address folds; a LIST folds correctly only with a semicolon. Overflow is folded, NEVER dropped —
   * this is a legal declaration.
   */
  foldWith?: string;
  /** Point size. Omitted ⇒ CP22_DEFAULT_FONT_SIZE. The renderer may shrink below it, never above. */
  fontSize?: number;
  /** Right-align the value. The D-section amount column and its total; nothing else. */
  alignRight?: boolean;
  /**
   * FALSE for the boxes the system genuinely cannot answer. They are still created, still editable, and
   * never carry an invented value. See `CP22_UNFILLABLE` for the list and the reason for each.
   */
  prefilled: boolean;
};

export const CP22_DEFAULT_FONT_SIZE = 9;

/**
 * The four PRINTED DOTTED RULES on page 2 — D4's and D8's "nyatakan / specify" lines.
 *
 * These are the only entry areas on the form that are NOT drawn cells: LHDN prints a run of '.' glyphs and
 * expects you to write on it. The span below is the extent of that dot run (first dot's left edge to the
 * last dot's right edge, read from the page's own character positions) and `baseline` is the dots' own
 * baseline, since a period sits on it. The renderer positions the widget so pdf-lib's single-line baseline
 * lands `RULE_BASELINE_LIFT` above the dots — writing ON the rule, not through it.
 *
 * EACH QUESTION HAS TWO RULES BECAUSE THE FORM IS BILINGUAL: LHDN asks it once in Malay and once in
 * English, on separate lines, and prints a rule for each. Both are filled with the same answer. Filling
 * only one leaves a printed rule blank, which reads as an unanswered question to whichever reader that
 * line was for; and neither rule is "the real one".
 */
export const CP22_RULE_BASELINES = {
  d4SpecifyMs: { x0: 46.32, x1: 393.17, baseline: 648.82 },
  d4SpecifyEn: { x0: 145.1, x1: 472.01, baseline: 625.54 },
  d8SpecifyMs: { x0: 200.69, x1: 472.05, baseline: 538.51 },
  d8SpecifyEn: { x0: 171.98, x1: 472.07, baseline: 526.27 },
} as const;

/** How far above the printed dots the text baseline sits, so glyphs rest on the rule rather than cross it. */
export const RULE_BASELINE_LIFT = 1.2;
/** Height of a widget over a dotted rule. Enough for the chosen face; the rule has no ceiling of its own. */
export const RULE_FIELD_HEIGHT = 11;
/** Point size on a dotted rule — smaller than a boxed field, because a specify line takes a long list. */
export const RULE_FONT_SIZE = 7.5;

/**
 * pdf-lib centres a single line in its bounds: baseline = rect.y + rect.height/2 − ascent(size)/2, with
 * bounds inset 1pt each side (which cancels). Helvetica's ascent is 0.718 em. Inverting it gives the
 * rect.y that puts the baseline where we want it — this is the ONLY place a rect is computed rather than
 * read off the artwork, and it is computed from pdf-lib's own layout rule, not measured by eye.
 */
const HELVETICA_ASCENT = 0.718;
const ruleRect = (r: { x0: number; x1: number; baseline: number }): Cp22Rect => ({
  x: r.x0,
  y: r.baseline + RULE_BASELINE_LIFT - RULE_FIELD_HEIGHT / 2 + (HELVETICA_ASCENT * RULE_FONT_SIZE) / 2,
  width: r.x1 - r.x0,
  height: RULE_FIELD_HEIGHT,
});

/**
 * The 53 entry areas, in the form's own reading order: A1…A5, B1…B17, C1…C4 on page 1; D1…D8 + total,
 * E1…E2, F on page 2.
 *
 * A rect is `x, y` of the bottom-left corner plus width/height, matching pdf-lib's `addToPage` options.
 */
export const CP22_FIELDS: Cp22Field[] = [
  // ── A. MAKLUMAT MAJIKAN / PARTICULARS OF EMPLOYER ────────────────────────────────────────────────
  { code: 'A1', name: 'employerName', type: 'multirow', page: 0, rows: 2, prefilled: true,
    rect: { x: 41.04, y: 630.82, width: 253.85, height: 19.8 },
    moreRows: [{ x: 41.04, y: 610.42, width: 253.85, height: 19.92 }] },
  { code: 'A2', name: 'employerAddress', type: 'multirow', page: 0, rows: 3, prefilled: true,
    rect: { x: 318.89, y: 630.82, width: 257.45, height: 19.8 },
    moreRows: [
      { x: 318.89, y: 610.42, width: 257.45, height: 19.92 },
      { x: 318.89, y: 589.99, width: 257.45, height: 19.95 },
    ] },
  // The form PRINTS the "E" of the employer number to the left of this box, so the box holds the rest.
  { code: 'A3', name: 'employerNo', type: 'text', page: 0, prefilled: true,
    rect: { x: 163.22, y: 589.99, width: 131.67, height: 19.95 } },
  // NOT PREFILLED — see CP22_UNFILLABLE. There is no employer e-mail column anywhere in the schema.
  { code: 'A4', name: 'employerEmail', type: 'text', page: 0, prefilled: false,
    rect: { x: 99.14, y: 569.71, width: 195.75, height: 19.8 } },
  { code: 'A5', name: 'employerPhone', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 569.71, width: 128.67, height: 19.8 } },

  // ── B. MAKLUMAT PEKERJA BAHARU / PARTICULARS OF NEW EMPLOYEE ─────────────────────────────────────
  { code: 'B1', name: 'employeeName', type: 'multirow', page: 0, rows: 2, prefilled: true,
    rect: { x: 168.38, y: 534.67, width: 407.96, height: 19.92 },
    moreRows: [{ x: 168.38, y: 514.39, width: 407.96, height: 19.8 }] },
  { code: 'B2', name: 'incomeTaxNo', type: 'text', page: 0, prefilled: true,
    rect: { x: 168.38, y: 493.99, width: 126.51, height: 19.92 } },
  { code: 'B3', name: 'icNo', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 493.99, width: 128.67, height: 19.92 } },
  { code: 'B4', name: 'currentPassportNo', type: 'text', page: 0, prefilled: true,
    rect: { x: 168.38, y: 473.23, width: 126.51, height: 20.28 } },
  { code: 'B5', name: 'passportRegisteredWithIrbm', type: 'text', page: 0, prefilled: false,
    rect: { x: 490.06, y: 473.23, width: 86.28, height: 20.28 } },
  { code: 'B6', name: 'citizen', type: 'text', page: 0, prefilled: true,
    rect: { x: 168.38, y: 452.83, width: 126.51, height: 19.92 } },
  { code: 'B7', name: 'gender', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 452.83, width: 128.67, height: 19.92 } },
  { code: 'B8', name: 'dateOfBirth', type: 'text', page: 0, prefilled: true,
    rect: { x: 168.38, y: 432.53, width: 126.51, height: 19.82 } },
  { code: 'B9', name: 'maritalStatus', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 432.53, width: 128.67, height: 19.82 } },
  { code: 'B10', name: 'employeePhone', type: 'text', page: 0, prefilled: true,
    rect: { x: 168.38, y: 412.13, width: 126.51, height: 19.92 } },
  { code: 'B11', name: 'employeeEmail', type: 'text', page: 0, prefilled: true, fontSize: 8,
    rect: { x: 404.11, y: 412.13, width: 172.23, height: 19.92 } },

  // B12/B13 ARE THE r175a SHAPE, RELOCATED. Three free rows for the street, and then Poskod, Bandar and
  // Negeri each get their OWN printed box. Folding postcode/town/state into a tail line — which is what
  // the 2020 map needed and what core/reporting.ts used to do — would put the state in a free row and
  // leave three printed boxes empty. The address is SPLIT at the source instead; see `cp22Particulars`.
  { code: 'B12', name: 'residentialAddress', type: 'multirow', page: 0, rows: 3, prefilled: true,
    rect: { x: 41.04, y: 371.45, width: 253.85, height: 19.92 },
    moreRows: [
      { x: 41.04, y: 351.17, width: 253.85, height: 19.8 },
      { x: 41.04, y: 330.77, width: 253.85, height: 19.92 },
    ] },
  { code: 'B12P', name: 'residentialPostcode', type: 'text', page: 0, prefilled: true,
    rect: { x: 168.38, y: 310.37, width: 126.51, height: 19.92 } },
  { code: 'B12T', name: 'residentialTown', type: 'text', page: 0, prefilled: true,
    rect: { x: 168.38, y: 290.09, width: 126.51, height: 19.8 } },
  { code: 'B12S', name: 'residentialState', type: 'text', page: 0, prefilled: true,
    rect: { x: 168.38, y: 269.54, width: 126.51, height: 20.07 } },
  { code: 'B13', name: 'correspondenceAddress', type: 'multirow', page: 0, rows: 3, prefilled: true,
    rect: { x: 318.89, y: 371.45, width: 257.45, height: 19.92 },
    moreRows: [
      { x: 318.89, y: 351.17, width: 257.45, height: 19.8 },
      { x: 318.89, y: 330.77, width: 257.45, height: 19.92 },
    ] },
  { code: 'B13P', name: 'correspondencePostcode', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 310.37, width: 128.67, height: 19.92 } },
  { code: 'B13T', name: 'correspondenceTown', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 290.09, width: 128.67, height: 19.8 } },
  { code: 'B13S', name: 'correspondenceState', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 269.54, width: 128.67, height: 20.07 } },
  { code: 'B13X', name: 'correspondenceIsTaxAgent', type: 'checkbox', page: 0, prefilled: false,
    rect: { x: 318.89, y: 249.38, width: 21.02, height: 19.68 } },
  { code: 'B14', name: 'commencementDate', type: 'text', page: 0, prefilled: true, fontSize: 8,
    rect: { x: 232.13, y: 228.98, width: 62.76, height: 19.92 } },
  // B15 and B17 are DIFFERENT QUESTIONS and the 2020 form had only one of them. B15 Jawatan is the job
  // title; B17 Jenis pekerjaan is the KIND of employment (permanent / contract / intern). The 2020 map's
  // single `natureOfEmployment` box carried the title, so the title moves to B15 and B17 is genuinely new.
  { code: 'B15', name: 'designation', type: 'text', page: 0, prefilled: true,
    rect: { x: 404.11, y: 228.98, width: 172.23, height: 19.92 } },
  { code: 'B16', name: 'expectedDuration', type: 'text', page: 0, prefilled: true, fontSize: 8,
    rect: { x: 232.13, y: 208.22, width: 62.76, height: 20.28 } },
  { code: 'B17', name: 'natureOfEmployment', type: 'text', page: 0, prefilled: true,
    rect: { x: 404.11, y: 208.22, width: 172.23, height: 20.28 } },

  // ── C. MAKLUMAT SUAMI / ISTERI / PARTICULARS OF HUSBAND / WIFE ───────────────────────────────────
  { code: 'C1', name: 'spouseName', type: 'multirow', page: 0, rows: 2, prefilled: true,
    rect: { x: 41.04, y: 147.38, width: 253.85, height: 19.92 },
    moreRows: [{ x: 41.04, y: 126.98, width: 253.85, height: 19.92 }] },
  { code: 'C2', name: 'spouseIcOrPassport', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 167.78, width: 128.67, height: 20.28 } },
  { code: 'C3', name: 'spouseIncomeTaxNo', type: 'text', page: 0, prefilled: false,
    rect: { x: 447.67, y: 147.38, width: 128.67, height: 19.92 } },
  { code: 'C4', name: 'spousePhone', type: 'text', page: 0, prefilled: true,
    rect: { x: 447.67, y: 126.98, width: 128.67, height: 19.92 } },

  // ── D. MAKLUMAT SARAAN BULANAN / PARTICULARS OF MONTHLY REMUNERATION (page 2) ────────────────────
  // The amount column, right-aligned the way money is read. The form prints "(RM)" in the column head, so
  // no value carries a currency prefix.
  { code: 'D1', name: 'd1SalaryOvertime', type: 'text', page: 1, prefilled: true, alignRight: true,
    rect: { x: 480.82, y: 727.66, width: 95.28, height: 22.68 } },
  { code: 'D2', name: 'd2LeavePay', type: 'text', page: 1, prefilled: false, alignRight: true,
    rect: { x: 480.82, y: 704.5, width: 95.28, height: 22.68 } },
  { code: 'D3', name: 'd3CommissionBonus', type: 'text', page: 1, prefilled: false, alignRight: true,
    rect: { x: 480.82, y: 681.22, width: 95.28, height: 22.8 } },
  { code: 'D4', name: 'd4CashAllowances', type: 'text', page: 1, prefilled: true, alignRight: true,
    rect: { x: 480.82, y: 620.86, width: 95.28, height: 59.88 } },
  { code: 'D4ms', name: 'd4SpecifyMs', type: 'rule', page: 1, prefilled: true, fontSize: RULE_FONT_SIZE,
    foldWith: '; ', rect: ruleRect(CP22_RULE_BASELINES.d4SpecifyMs) },
  { code: 'D4en', name: 'd4SpecifyEn', type: 'rule', page: 1, prefilled: true, fontSize: RULE_FONT_SIZE,
    foldWith: '; ', rect: ruleRect(CP22_RULE_BASELINES.d4SpecifyEn) },
  { code: 'D5', name: 'd5BenefitsInKind', type: 'text', page: 1, prefilled: false, alignRight: true,
    rect: { x: 480.82, y: 597.67, width: 95.28, height: 22.71 } },
  { code: 'D6', name: 'd6LivingAccommodation', type: 'text', page: 1, prefilled: false, alignRight: true,
    rect: { x: 480.82, y: 574.51, width: 95.28, height: 22.68 } },
  { code: 'D7', name: 'd7AllowancesInKind', type: 'text', page: 1, prefilled: false, alignRight: true,
    rect: { x: 480.82, y: 549.55, width: 95.28, height: 24.48 } },
  { code: 'D8', name: 'd8OtherPayments', type: 'text', page: 1, prefilled: false, alignRight: true,
    rect: { x: 480.82, y: 521.71, width: 95.28, height: 27.36 } },
  { code: 'D8ms', name: 'd8SpecifyMs', type: 'rule', page: 1, prefilled: false, fontSize: RULE_FONT_SIZE,
    rect: ruleRect(CP22_RULE_BASELINES.d8SpecifyMs) },
  { code: 'D8en', name: 'd8SpecifyEn', type: 'rule', page: 1, prefilled: false, fontSize: RULE_FONT_SIZE,
    rect: ruleRect(CP22_RULE_BASELINES.d8SpecifyEn) },
  // JUMLAH / TOTAL — its own heavier-ruled box, which is why the derivation had to bridge the rule the
  // crossing vertical breaks in two; without that bridge D8's amount cell and this one read as one 51pt box.
  { code: 'DT', name: 'dTotal', type: 'text', page: 1, prefilled: true, alignRight: true,
    rect: { x: 480.82, y: 497.95, width: 95.28, height: 22.8 } },

  // ── E. MAKLUMAT MAJIKAN TERDAHULU DI MALAYSIA / PREVIOUS EMPLOYER IN MALAYSIA ────────────────────
  // NOT PREFILLED, both of them: no employment_history / previous_employer table exists, and
  // employeeDependent.companyName / employerAddress are the SPOUSE'S employer and are NOT this.
  { code: 'E1', name: 'previousEmployerName', type: 'multirow', page: 1, rows: 3, prefilled: false,
    rect: { x: 41.04, y: 438.67, width: 255.77, height: 19.8 },
    moreRows: [
      { x: 41.04, y: 418.25, width: 255.77, height: 19.94 },
      { x: 41.04, y: 397.97, width: 255.77, height: 19.8 },
    ] },
  { code: 'E2', name: 'previousEmployerAddress', type: 'multirow', page: 1, rows: 3, prefilled: false,
    rect: { x: 319.85, y: 438.67, width: 256.25, height: 19.8 },
    moreRows: [
      { x: 319.85, y: 418.25, width: 256.25, height: 19.94 },
      { x: 319.85, y: 397.97, width: 256.25, height: 19.8 },
    ] },

  // ── F. AKUAN PEGAWAI YANG DIBERI KUASA / DECLARATION BY AUTHORISED OFFICER ───────────────────────
  { code: 'F1', name: 'declarantName', type: 'multirow', page: 1, rows: 2, prefilled: true,
    rect: { x: 69.02, y: 355.49, width: 226.35, height: 20.28 },
    moreRows: [{ x: 69.02, y: 335.21, width: 226.35, height: 19.8 }] },
  { code: 'F2', name: 'declarantIcOrPassport', type: 'text', page: 1, prefilled: true,
    rect: { x: 407.47, y: 355.49, width: 152.67, height: 20.28 } },
  { code: 'F3', name: 'declarantDesignation', type: 'text', page: 1, prefilled: true,
    rect: { x: 105.14, y: 279.77, width: 190.23, height: 19.92 } },
  { code: 'F4', name: 'declarantSignature', type: 'text', page: 1, prefilled: false,
    rect: { x: 388.87, y: 253.94, width: 171.27, height: 45.75 } },
  { code: 'F5', name: 'declarationDate', type: 'text', page: 1, prefilled: true,
    rect: { x: 105.14, y: 253.94, width: 92.31, height: 19.8 } },
];

/**
 * The fifteen areas the system genuinely cannot answer — rendered empty and editable, never invented.
 *
 * The 2020 map had seven. The count grew because the 2021 form ASKS MORE, not because anything regressed:
 * section D alone adds six income lines nothing in payroll holds at hire, and section E adds two.
 *
 *   A4   employer e-Mail        — there is NO company e-mail column in the schema. `company` carries
 *                                 website, phone and fax and no address for e-mail; `tenant`'s
 *                                 primary_contact_email is the SaaS billing contact for a tenant that may
 *                                 own many companies, and is not the employer's registered e-mail.
 *   B5   passport registered with LHDNM — never collected (employeeStatutoryMy.passportRemark is a free
 *                                 remark, not this field, and must not be used for it).
 *   B13X tax-agent tick         — only the operator knows whether the correspondence address is an agent's.
 *   C3   spouse income tax no.  — employeeDependent has no tax column, and employeeStatutoryMy is
 *                                 per-EMPLOYEE.
 *   D2   leave pay              — not held. NOT written as 0.00: a zero asserts "there is none", which we
 *   D3   commission and bonus     do not know. A blank box asks the question; a zero answers it wrongly.
 *   D5   benefits in kind
 *   D6   living accommodation
 *   D7   allowances in kind
 *   D8   other payments (+ both of its specify rules)
 *   E1   previous employer name    — no employment_history / previous_employer table exists.
 *   E2   previous employer address
 *   F4   the signature itself.
 */
export const CP22_UNFILLABLE = CP22_FIELDS.filter((f) => !f.prefilled).map((f) => f.code);

/** Every widget rect on the form, expanded — a `multirow` block contributes one per printed row. */
export function cp22Widgets(f: Cp22Field): Cp22Rect[] {
  return f.type === 'multirow' ? [f.rect, ...(f.moreRows ?? [])] : [f.rect];
}

/** The AcroForm name of row `i` (0-based) of a block. Single-row fields keep the bare name. */
export const cp22RowName = (name: string, i: number): string => (i === 0 ? name : `${name}_${i + 1}`);

export type Cp22FieldName = (typeof CP22_FIELDS)[number]['name'];
