/**
 * r413 (item 79f3f64d, step 2) — CP22A [Pin.1/2023]: the coordinate map for LHDN's own two-page form.
 *
 * "BORANG PEMBERITAHUAN PEMBERHENTIAN KERJA (SWASTA)" — the notice a PRIVATE-SECTOR employer sends LHDN when
 * an employee stops working (resigns, retires or dies). Malay only; US Letter, 612 × 792 pt, on both pages,
 * and that is LHDN's own page size: it is kept, never re-flowed onto A4.
 *
 * SAME PATTERN AS lib/cp22-fields.ts, ONE DIFFERENCE IN KIND. The numbers are DATA read off the artwork
 * (`public/forms/cp22a-pin-1-2023.pdf`), not placed by eye: every input box on page 1 is a Word shape the
 * page paints as one stroked or filled rectangle, so each rect below is that shape's own bounds as PyMuPDF's
 * `get_drawings()` reports them, converted to PDF user space (origin bottom-left). The page-2 table is
 * Word's thin filled rules; those were reduced to horizontal and vertical runs and each cell read off the
 * runs that wall it, inset 0.5 pt so a widget sits inside the rule rather than on it. The dotted
 * "nyatakan" rules are positioned from the dots' own glyph baselines (`rawdict` origins). The derivation
 * script was a throwaway; THIS FILE is the artefact, tested as data in test/r413-cp22a.test.ts (inside the
 * MediaBox, no two widgets overlapping, every comb's cell count matching the printed cells).
 *
 * THE DIFFERENCE: CHARACTER CELLS COME BACK. CP22 [Pin.1/2021] printed no combs, so its map dropped the
 * type. CP22A [Pin.1/2023] prints them for the employer number, every identification number, both TINs and
 * every date — and in GROUPS: a date is three pairs of cells (dd mm yy) with gaps between them, a TIN is
 * two cells for the prefix and eleven for the digits. One combed widget per printed GROUP, so each
 * character lands in its own printed cell and no widget spans a gap the artwork leaves blank.
 *
 * DATES ARE dd mm yy. The cells are three pairs, so the year is two digits. That is LHDN's ruling, not
 * ours; four digits would not fit and would not be what the box asks for.
 *
 * WHOSE ARE A14b AND A14c — READ, NOT ASSUMED, AND RECORDED BECAUSE IT IS THE ONE INTERPRETIVE CALL HERE.
 * The page is two Word columns. The right column opens with "b) No. Pengenalan" and "c) No. Pengenalan
 * Cukai (TIN)" beside item 1 — which reads, at a glance, as the leaver's own IC and TIN. It is not: item 1
 * ("Nama penuh") has no "a)", while item 14 ("Jika berkahwin, lengkapkan maklumat suami / isteri") ends the
 * left column with "a) Nama penuh suami / isteri" and nothing after it. Word flows a two-column section
 * column-major, so b) and c) at the head of the right column are 14 b) and 14 c) — the SPOUSE's — and the
 * leaver's own numbers are items 9 and 10, which ask exactly that and are otherwise left unexplained. Every
 * other lettered list on the page (13, 16, 17) starts at a); this is the reading under which 14 does too.
 * CONFIDENCE: medium-high. If LHDN's guide ever says otherwise, the fix is two `name`s in this file.
 *
 * COORDINATES: PDF user space, origin bottom-left, y up, MediaBox 0 0 612 792 on both pages.
 */

/** Both template pages carry this box. Asserted against the real file in test/r413-cp22a.test.ts. */
export const CP22A_MEDIA_BOX = { width: 612, height: 792 } as const;

/** Page 1: header and section A. Page 2: sections B to E. */
export const CP22A_PAGE_COUNT = 2;

export type Cp22aFieldType =
  /** One-line box. Shrunk to fit rather than clipped (lib/cp22-pdf.ts `fitBlock`). */
  | 'text'
  /** A stack of `rows` one-line boxes sharing an x and a width. */
  | 'multirow'
  /** A one-line box on a PRINTED DOTTED RULE rather than in a drawn cell. */
  | 'rule'
  /** Printed character cells, in one or more GROUPS; one combed widget per group. */
  | 'comb'
  /**
   * One "[ Sila tandakan 'X' ]" box. A TEXT widget holding "X" or nothing — the form asks for an X, and a
   * pdf-lib checkbox draws a tick. Still editable: an operator can clear it or move it.
   */
  | 'mark';

export type Cp22aRect = { x: number; y: number; width: number; height: number };

/** A run of contiguous, evenly pitched printed cells. `rect` spans them edge to edge. */
export type Cp22aCombGroup = { rect: Cp22aRect; cells: number };

/**
 * Where a box's value comes from. Three answers, not a boolean, because CP22A has a class CP22 did not:
 *   'record' — filled from the system's records.
 *   'typed'  — the operator types it on the preview screen; it travels in the query string and is never
 *              stored (lib/cp22a-review.ts). Empty unless typed.
 *   'none'   — nothing can answer it. Created empty and editable, never given a value. `CP22A_UNFILLABLE`.
 */
export type Cp22aSource = 'record' | 'typed' | 'none';

export type Cp22aField = {
  /** The form's own numbering where it has one ('A9', 'B3', 'D2'); `H…` for the unnumbered header. */
  code: string;
  /** The form's own printed label, in its own Malay. Not an i18n key — see lib/cp22-fields.ts `label`. */
  label: string;
  /** AcroForm field name; extra rows / groups are `name_2`, `name_3`. */
  name: string;
  type: Cp22aFieldType;
  /** 0 or 1. */
  page: number;
  /** The drawn box; for `multirow` the first row, for `comb` the first group. */
  rect: Cp22aRect;
  /** `multirow` only: rows 2..N, top to bottom. */
  moreRows?: Cp22aRect[];
  /** `multirow` only: 1 + moreRows.length, declared so the test can hold the two against each other. */
  rows?: number;
  /** `comb` only: every printed cell group, left to right, the first of which is `rect`. */
  groups?: Cp22aCombGroup[];
  foldWith?: string;
  fontSize?: number;
  alignRight?: boolean;
  source: Cp22aSource;
  /**
   * The value is a flat 'X'-or-empty for one choice of several. Declared so the test can prove a choice
   * prints in EXACTLY one of its boxes.
   */
  choiceOf?: string;
};

export const CP22A_DEFAULT_FONT_SIZE = 9;
/** A comb cell is 16–18 pt wide; 10 pt fills it without touching its walls. The ESOS cells are 12.75 pt. */
export const CP22A_COMB_FONT_SIZE = 10;
export const CP22A_MARK_FONT_SIZE = 11;
/** Same lift and height lib/cp22-fields.ts uses for its dotted rules, for the same reason. */
const RULE_LIFT = 1.2;
const RULE_HEIGHT = 11;
const HELVETICA_ASCENT = 0.718;
const ruleRect = (x0: number, x1: number, baseline: number, size: number): Cp22aRect => ({
  x: x0,
  y: Math.round((baseline + RULE_LIFT - RULE_HEIGHT / 2 + (HELVETICA_ASCENT * size) / 2) * 100) / 100,
  width: Math.round((x1 - x0) * 100) / 100,
  height: RULE_HEIGHT,
});

const r = (x: number, y: number, width: number, height: number): Cp22aRect => ({ x, y, width, height });
const g = (x: number, y: number, width: number, height: number, cells: number): Cp22aCombGroup => ({
  rect: r(x, y, width, height),
  cells,
});
/** Three pairs of cells, dd mm yy, at the three printed x positions. */
const date = (xs: [number, number, number], y: number, h: number, w = 35.1): Cp22aCombGroup[] =>
  xs.map((x) => g(x, y, w, h, 2));

/**
 * The page-2 table, as its rules print it. Columns are the "Tempoh dari / hingga" and "RM" columns;
 * each row is the pair of horizontal rules around one numbered line.
 */
const B_COL = {
  dari: { x0: 311.8, x1: 410.6 },
  hingga: { x0: 411.1, x1: 511.4 },
  rm: { x0: 511.9, x1: 582.4 },
} as const;
/** Rows 1–12 of section B: [bottom rule, top rule]. Row 13 (ESOS) is shaped differently and mapped below. */
const B_ROWS: [number, number][] = [
  [680.4, 694.2],
  [666.5, 680.4],
  [652.5, 666.5],
  [617.4, 652.5],
  [581.3, 617.4],
  [556.4, 581.3],
  [542.5, 556.4],
  [528.5, 542.5],
  [514.6, 528.5],
  [492.7, 514.6],
  [478.8, 492.7],
  [455.6, 478.8],
];
const INSET = 0.5;
const cell = (col: { x0: number; x1: number }, [y0, y1]: [number, number]): Cp22aRect => ({
  x: Math.round((col.x0 + INSET) * 100) / 100,
  y: Math.round((y0 + INSET) * 100) / 100,
  width: Math.round((col.x1 - col.x0 - 2 * INSET) * 100) / 100,
  height: Math.round((y1 - y0 - 2 * INSET) * 100) / 100,
});

/**
 * Section B's own line labels, in LHDN's words — the preview lists them, and `sourceOf` in core/reporting.ts
 * says which EA figure feeds each one. A line with no EA figure behind it is `none` on all three boxes.
 */
export const CP22A_B_LINES = [
  { line: 1, label: 'Gaji, bayaran, upah dan kerja lebih masa', source: 'record' },
  { line: 2, label: 'Gaji cuti', source: 'none' },
  { line: 3, label: 'Komisen dan bonus', source: 'record' },
  { line: 4, label: 'Ganjaran', source: 'record' },
  { line: 5, label: 'Pampasan kerana kehilangan pekerjaan', source: 'record' },
  { line: 6, label: 'Elaun tunai termasuk cukai ditanggung oleh majikan', source: 'record' },
  { line: 7, label: 'Pencen daripada majikan', source: 'record' },
  { line: 8, label: 'Manfaat berupa barangan yang layak dikenakan cukai', source: 'record' },
  { line: 9, label: 'Nilai tahunan tempat kediaman yang disediakan majikan', source: 'record' },
  { line: 10, label: 'Elaun-elaun selain daripada wang seperti makanan, pakaian, lojing atau pembantu rumah', source: 'none' },
  { line: 11, label: 'Kereta dan pemandu', source: 'none' },
  { line: 12, label: 'Lain-lain bayaran (jika ada, nyatakan)', source: 'record' },
] as const satisfies readonly { line: number; label: string; source: Cp22aSource }[];

const bLineFields: Cp22aField[] = CP22A_B_LINES.flatMap(({ line, label, source }) => {
  const row = B_ROWS[line - 1];
  return [
    { code: `B${line}dari`, label: `${line}) ${label} — Tempoh dari`, name: `b${line}From`, type: 'text', page: 1, source, fontSize: 8, rect: cell(B_COL.dari, row) },
    { code: `B${line}hingga`, label: `${line}) ${label} — Tempoh hingga`, name: `b${line}To`, type: 'text', page: 1, source, fontSize: 8, rect: cell(B_COL.hingga, row) },
    { code: `B${line}`, label: `${line}) ${label} — RM`, name: `b${line}Amount`, type: 'text', page: 1, source, fontSize: 8, alignRight: true, rect: cell(B_COL.rm, row) },
  ] satisfies Cp22aField[];
});

/** Section C — "BUTIR-BUTIR PENDAPATAN YANG BELUM DILAPORKAN": three ruled rows, four columns. */
const C_COLS = [
  { key: 'type', label: 'Jenis Pendapatan', x0: 70.6, x1: 161.5 },
  { key: 'period', label: 'Tempoh Diperoleh', x0: 162.0, x1: 301.8 },
  { key: 'amount', label: 'Jumlah Pendapatan (RM)', x0: 302.3, x1: 442.0 },
  { key: 'epf', label: 'Caruman KWSP Pekerja (RM)', x0: 442.5, x1: 582.4 },
] as const;
const C_ROWS: { roman: string; y: [number, number] }[] = [
  { roman: 'i', y: [285.4, 300.1] },
  { roman: 'ii', y: [270.8, 285.4] },
  { roman: 'iii', y: [256.1, 270.8] },
];
const cFields: Cp22aField[] = C_ROWS.flatMap(({ roman, y }, i) =>
  C_COLS.map(
    (col) =>
      ({
        code: `C${i + 1}${col.key}`,
        label: `(${roman}) ${col.label}`,
        name: `c${i + 1}${col.key[0].toUpperCase()}${col.key.slice(1)}`,
        type: 'text',
        page: 1,
        source: 'none',
        fontSize: 8,
        alignRight: col.key === 'amount' || col.key === 'epf',
        rect: cell(col, y),
      }) satisfies Cp22aField,
  ),
);

/** Section D's amounts sit on the printed "RM ……" leader, right of the "RM". Baselines from the dots. */
const D_RULE = { x0: 477.5, x1: 572.0 };
const dRule = (baseline: number) => ruleRect(D_RULE.x0, D_RULE.x1, baseline, 9);

/**
 * Every entry area, page 1 then page 2, in the form's reading order (page 1 left column, then right).
 */
export const CP22A_FIELDS: Cp22aField[] = [
  // ── HEADER (unnumbered) ─────────────────────────────────────────────────────────────────────────────
  // ONE drawn box, no ruled rows inside it. Five rows are laid in it at even pitch (the box's inner height
  // over five) — the only rects on this page that are COMPUTED from a drawn box rather than read off one,
  // because the artwork offers no rows to read. Name first, then the address.
  { code: 'H1', label: 'Nama & Alamat Majikan', name: 'employerNameAddress', type: 'multirow', page: 0, rows: 5, source: 'record', fontSize: 8,
    rect: r(40.2, 663.28, 262.45, 13.94),
    moreRows: [r(40.2, 649.34, 262.45, 13.94), r(40.2, 635.4, 262.45, 13.94), r(40.2, 621.46, 262.45, 13.94), r(40.2, 607.52, 262.45, 13.94)] },
  // The form PRINTS the "E" in the first cell; the ten cells after the gap hold the digits.
  { code: 'H2', label: 'No. Majikan', name: 'employerNo', type: 'comb', page: 0, source: 'record',
    rect: r(348.6, 660.87, 180, 17.95), groups: [g(348.6, 660.87, 180, 17.95, 10)] },
  { code: 'H3', label: 'No. Telefon Majikan', name: 'employerPhone', type: 'text', page: 0, source: 'record',
    rect: r(403.6, 640.17, 160.25, 17.0) },
  { code: 'H4a', label: 'Status Pemberitahuan — Baharu', name: 'statusNew', type: 'mark', page: 0, source: 'none', choiceOf: 'status',
    rect: r(318.0, 605.35, 18, 15.72) },
  { code: 'H4b', label: 'Status Pemberitahuan — Pindaan', name: 'statusAmended', type: 'mark', page: 0, source: 'none', choiceOf: 'status',
    rect: r(402.31, 605.35, 18, 15.72) },
  { code: 'H4c', label: 'Status Pemberitahuan — Tambahan', name: 'statusAdditional', type: 'mark', page: 0, source: 'none', choiceOf: 'status',
    rect: r(477.47, 605.35, 18, 15.72) },

  // ── A. BUTIR-BUTIR PEKERJA YANG BERHENTI KERJA / BERSARA / MENINGGAL DUNIA — left column ───────────
  { code: 'A1', label: '1. Nama penuh', name: 'employeeName', type: 'multirow', page: 0, rows: 2, source: 'record',
    rect: r(48.15, 545.24, 256.2, 17.01), moreRows: [r(48.15, 527.95, 256.2, 17.01)] },
  { code: 'A2a', label: '2. Jenis pemberhentian — Berhenti kerja', name: 'cessationResigned', type: 'mark', page: 0, source: 'record', choiceOf: 'cessation',
    rect: r(48.35, 495.64, 18, 15.56) },
  { code: 'A2b', label: '2. Jenis pemberhentian — Bersara', name: 'cessationRetired', type: 'mark', page: 0, source: 'record', choiceOf: 'cessation',
    rect: r(141.51, 495.64, 18, 15.56) },
  { code: 'A2c', label: '2. Jenis pemberhentian — Meninggal dunia', name: 'cessationDeath', type: 'mark', page: 0, source: 'record', choiceOf: 'cessation',
    rect: r(207.82, 495.64, 18, 15.56) },
  { code: 'A3', label: '3. Tarikh mula bekerja', name: 'commencementDate', type: 'comb', page: 0, source: 'record',
    rect: r(189.95, 469.55, 35.1, 15.55), groups: date([189.95, 229.44, 268.2], 469.55, 15.55) },
  { code: 'A4', label: '4. Tarikh berhenti / persaraan / kematian', name: 'cessationDate', type: 'comb', page: 0, source: 'record',
    rect: r(190.2, 446.25, 35.1, 15.75), groups: date([190.2, 229.69, 268.45], 446.25, 15.75) },
  { code: 'A5', label: '5. Tarikh majikan terima pemakluman kematian pekerja [bagi kes kematian pekerja]', name: 'deathNotifiedDate', type: 'comb', page: 0, source: 'typed',
    rect: r(190.75, 420.35, 35.1, 15.75), groups: date([190.75, 230.24, 269.0], 420.35, 15.75) },
  { code: 'A6a', label: '6. Jenis persaraan — Wajib', name: 'retirementCompulsory', type: 'mark', page: 0, source: 'typed', choiceOf: 'retirement',
    rect: r(211.9, 376.01, 17.95, 16.3) },
  { code: 'A6b', label: '6. Jenis persaraan — Pilihan', name: 'retirementOptional', type: 'mark', page: 0, source: 'typed', choiceOf: 'retirement',
    rect: r(286.65, 378.56, 17.95, 16.3) },
  { code: 'A7a', label: '7. Cukai ditanggung majikan — Ya', name: 'taxBorneYes', type: 'mark', page: 0, source: 'record', choiceOf: 'taxBorne',
    rect: r(211.95, 350.96, 17.95, 16.3) },
  { code: 'A7b', label: '7. Cukai ditanggung majikan — Tidak', name: 'taxBorneNo', type: 'mark', page: 0, source: 'record', choiceOf: 'taxBorne',
    rect: r(286.65, 349.41, 17.95, 16.3) },
  { code: 'A8a', label: '8. Menerima tawaran skim pemberhentian pekerja — Ya', name: 'schemeYes', type: 'mark', page: 0, source: 'typed', choiceOf: 'scheme',
    rect: r(50.0, 310.35, 18, 15.56) },
  { code: 'A8b', label: '8. Menerima tawaran skim pemberhentian pekerja — Tidak / Tidak berkenaan', name: 'schemeNo', type: 'mark', page: 0, source: 'typed', choiceOf: 'scheme',
    rect: r(113.16, 310.35, 18, 15.56) },
  { code: 'A9', label: '9. No. Pengenalan (No. Kad Pengenalan / Pasport)', name: 'icNo', type: 'comb', page: 0, source: 'record',
    rect: r(48.85, 272.76, 216, 17.95), groups: [g(48.85, 272.76, 216, 17.95, 12)] },
  { code: 'A10', label: '10. No. Pengenalan Cukai (TIN)', name: 'taxNo', type: 'comb', page: 0, source: 'record',
    rect: r(49.75, 233.12, 32.6, 17.95), groups: [g(49.75, 233.12, 32.6, 17.95, 2), g(89.0, 233.12, 179.1, 17.95, 11)] },
  { code: 'A11', label: '11. Tarikh lahir', name: 'dateOfBirth', type: 'comb', page: 0, source: 'record',
    rect: r(190.2, 207.92, 35.1, 15.75), groups: date([190.2, 229.69, 268.45], 207.92, 15.75) },
  { code: 'A12', label: '12. Taraf perkahwinan', name: 'maritalStatus', type: 'text', page: 0, source: 'record',
    rect: r(126.1, 184.47, 178.55, 17.0) },
  { code: 'A13a', label: '13. Tuntutan potongan cukai bagi anak — a) Bilangan anak', name: 'childrenCount', type: 'comb', page: 0, source: 'record',
    rect: r(126.2, 141.22, 36.15, 16.3), groups: [g(126.2, 141.22, 36.15, 16.3, 2)] },
  { code: 'A13b', label: '13. Tuntutan potongan cukai bagi anak — b) Jumlah RM', name: 'childReliefAmount', type: 'text', page: 0, source: 'none', alignRight: true,
    rect: r(126.3, 118.17, 96.35, 17.0) },
  { code: 'A14a', label: '14. a) Nama penuh suami / isteri', name: 'spouseName', type: 'multirow', page: 0, rows: 2, source: 'record',
    rect: r(50.8, 70.03, 252.25, 17.0), moreRows: [r(50.8, 53.03, 252.25, 17.0)] },

  // ── A — right column (14 b, 14 c continue item 14; see the header) ─────────────────────────────────
  { code: 'A14b', label: '14. b) No. Pengenalan (No. Kad Pengenalan / Pasport) suami / isteri', name: 'spouseIcNo', type: 'comb', page: 0, source: 'record',
    rect: r(328.65, 541.7, 216, 17.95), groups: [g(328.65, 541.7, 216, 17.95, 12)] },
  { code: 'A14c', label: '14. c) No. Pengenalan Cukai (TIN) suami / isteri', name: 'spouseTaxNo', type: 'comb', page: 0, source: 'none',
    rect: r(329.1, 502.6, 32.6, 17.95), groups: [g(329.1, 502.6, 32.6, 17.95, 2), g(367.85, 502.6, 179.1, 17.95, 11)] },
  { code: 'A15', label: '15. No. telefon pekerja yang berhenti kerja / bersara', name: 'employeePhone', type: 'text', page: 0, source: 'record',
    rect: r(330.55, 465.55, 233.9, 15.36) },
  // Five drawn rows whose borders overlap by 1.36 pt; each widget is trimmed to the row's own interior so
  // no two widgets overlap. The LAST row keeps its full height.
  { code: 'A16a', label: '16. a) Alamat surat-menyurat terkini', name: 'correspondenceAddress', type: 'multirow', page: 0, rows: 5, source: 'record',
    rect: r(330.95, 428.91, 235.55, 15.65),
    moreRows: [r(330.95, 413.26, 235.55, 15.65), r(330.95, 398.23, 235.55, 15.03), r(330.95, 383.21, 235.55, 15.02), r(330.95, 366.2, 235.55, 17.01)] },
  { code: 'A16x', label: 'Sila tandakan "X" jika alamat surat-menyurat di atas adalah alamat ejen cukai', name: 'correspondenceIsTaxAgent', type: 'mark', page: 0, source: 'none',
    rect: r(330.95, 339.3, 18, 19.8) },
  { code: 'A16b', label: '16. b) Alamat e-mel', name: 'employeeEmail', type: 'text', page: 0, source: 'record', fontSize: 8,
    rect: r(388.0, 313.61, 178.55, 17.0) },
  { code: 'A17a', label: '17. Maklumat wakil sah [bagi kes meninggal dunia] — a) Nama penuh', name: 'repName', type: 'text', page: 0, source: 'typed',
    rect: r(330.85, 259.61, 235.5, 17.0) },
  { code: 'A17b', label: '17. b) No. Pengenalan (No. Kad Pengenalan / Pasport)', name: 'repIcNo', type: 'comb', page: 0, source: 'typed',
    rect: r(331.25, 217.21, 216, 17.95), groups: [g(331.25, 217.21, 216, 17.95, 12)] },
  { code: 'A17c', label: '17. c) Hubungan', name: 'repRelationship', type: 'text', page: 0, source: 'typed',
    rect: r(330.85, 177.16, 235.5, 17.0) },
  { code: 'A17d', label: '17. d) Alamat surat-menyurat', name: 'repAddress', type: 'multirow', page: 0, rows: 5, source: 'typed', fontSize: 8,
    rect: r(330.7, 139.98, 235.5, 15.58),
    moreRows: [r(330.7, 124.34, 235.5, 15.58), r(330.7, 109.41, 235.5, 14.93), r(330.7, 94.04, 235.5, 15.37), r(330.7, 78.67, 235.5, 15.37)] },
  { code: 'A17e', label: '17. e) No. Telefon', name: 'repPhone', type: 'text', page: 0, source: 'typed',
    rect: r(384.7, 52.12, 181.4, 17.0) },

  // ── B. BUTIR-BUTIR SARAAN (page 2) ──────────────────────────────────────────────────────────────────
  ...bLineFields,
  // Lines 4 and 5 each print two dotted sub-questions; line 6 asks for the allowance types; line 12 asks to
  // name the other payments. Baselines are the dots' own.
  { code: 'B4tempoh', label: '4) Ganjaran — Tempoh tahun genap perkhidmatan', name: 'b4Years', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(183.14, 272.79, 633.7, 7.5) },
  { code: 'B4kecuali', label: '4) Ganjaran — Ganjaran dikecualikan cukai: RM', name: 'b4Exempt', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(171.26, 260.09, 621.46, 7.5) },
  { code: 'B5tempoh', label: '5) Pampasan — Tempoh tahun genap perkhidmatan', name: 'b5Years', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(183.44, 278.99, 598.54, 7.5) },
  { code: 'B5kecuali', label: '5) Pampasan — Pampasan dikecualikan cukai: RM', name: 'b5Exempt', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(177.38, 266.21, 586.42, 7.5) },
  { code: 'B6jenis', label: '6) Elaun tunai — sebutkan jenis-jenis elaun', name: 'b6Types', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(151.92, 292.39, 561.46, 7.5) },
  { code: 'B12nyatakan', label: '12) Lain-lain bayaran — nyatakan', name: 'b12Specify', type: 'rule', page: 1, source: 'record', fontSize: 7.5, foldWith: '; ',
    rect: ruleRect(51.48, 289.96, 459.07, 7.5) },
  // 13) ESOS / ESPP. Three dates in 12.75-pt cells, two dotted counts, and the benefit in the RM column.
  { code: 'B13diberi', label: '13) Skim Pemberian Saham — Tarikh opsyen diberi', name: 'b13Granted', type: 'comb', page: 1, source: 'none', fontSize: 8,
    rect: r(420.1, 435.16, 25.5, 14.3), groups: [g(420.1, 435.16, 25.5, 14.3, 2), g(450.85, 435.16, 25.5, 14.3, 2), g(481.6, 435.16, 25.5, 14.3, 2)] },
  { code: 'B13boleh', label: '13) Skim Pemberian Saham — Tarikh opsyen boleh laksana', name: 'b13Exercisable', type: 'comb', page: 1, source: 'none', fontSize: 8,
    rect: r(420.25, 410.16, 25.5, 14.3), groups: [g(420.25, 410.16, 25.5, 14.3, 2), g(451.0, 410.16, 25.5, 14.3, 2), g(481.75, 410.16, 25.5, 14.3, 2)] },
  { code: 'B13laksana', label: '13) Skim Pemberian Saham — Tarikh opsyen dilaksana', name: 'b13Exercised', type: 'comb', page: 1, source: 'none', fontSize: 8,
    rect: r(420.4, 384.46, 25.5, 14.3), groups: [g(420.4, 384.46, 25.5, 14.3, 2), g(451.15, 384.46, 25.5, 14.3, 2), g(481.9, 384.46, 25.5, 14.3, 2)] },
  { code: 'B13bil', label: '13) i. Bilangan saham layak', name: 'b13Shares', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(142.63, 295.98, 395.59, 7.5) },
  { code: 'B13baki', label: '13) ii. Baki yang belum dilaksanakan', name: 'b13Balance', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(172.35, 294.64, 380.47, 7.5) },
  { code: 'B13', label: '13) Manfaat dari Skim Pemberian Saham — Jumlah manfaat RM', name: 'b13Amount', type: 'text', page: 1, source: 'record', fontSize: 8, alignRight: true,
    rect: cell(B_COL.rm, [356.2, 378.2]) },
  // JUMLAH — inside its own heavier border (the 1.5-pt rules at x 510.9 / 581.9 and y 341.3 / 356.2).
  { code: 'BJ', label: 'JUMLAH', name: 'bTotal', type: 'text', page: 1, source: 'record', fontSize: 8, alignRight: true,
    rect: r(513.9, 342.8, 67.5, 13.0) },

  // ── C. BUTIR-BUTIR PENDAPATAN YANG BELUM DILAPORKAN ─────────────────────────────────────────────────
  ...cFields,

  // ── D. BUTIR-BUTIR LAIN ─────────────────────────────────────────────────────────────────────────────
  { code: 'D1', label: '1) Jumlah wang yang ditahan oleh majikan dan akan dibayar kepada pekerja', name: 'd1Withheld', type: 'rule', page: 1, source: 'none', fontSize: 9, alignRight: true,
    rect: dRule(226.13) },
  { code: 'D2', label: '2) Jumlah Potongan Cukai Bulanan yang dibayar ke LHDNM dalam tahun ini', name: 'd2Pcb', type: 'rule', page: 1, source: 'record', fontSize: 9, alignRight: true,
    rect: dRule(207.14) },
  { code: 'D3', label: '3) Jumlah potongan zakat yang dibayar dalam tahun ini', name: 'd3Zakat', type: 'rule', page: 1, source: 'record', fontSize: 9, alignRight: true,
    rect: dRule(188.18) },
  { code: 'D4', label: '4) Caruman pekerja kepada KWSP atau kumpulan wang yang diluluskan', name: 'd4Epf', type: 'rule', page: 1, source: 'record', fontSize: 9, alignRight: true,
    rect: dRule(169.22) },

  // ── E. AKUAN PEGAWAI YANG DIBERI KUASA ──────────────────────────────────────────────────────────────
  { code: 'E1', label: 'Nama', name: 'officerName', type: 'text', page: 1, source: 'record', rect: r(68.0, 125.7, 512.0, 16.5) },
  { code: 'E2', label: 'Jawatan', name: 'officerDesignation', type: 'text', page: 1, source: 'record', rect: r(76.0, 108.2, 504.0, 16.5) },
  { code: 'E3', label: 'Alamat e-mel', name: 'officerEmail', type: 'text', page: 1, source: 'record', rect: r(93.0, 90.8, 487.0, 16.4) },
  { code: 'E4', label: 'Tandatangan', name: 'officerSignature', type: 'text', page: 1, source: 'none', rect: r(135.85, 57.79, 159.0, 28.3) },
  { code: 'E5', label: 'Tarikh', name: 'declarationDate', type: 'comb', page: 1, source: 'record',
    rect: r(374.7, 63.67, 36, 15.75), groups: [g(374.7, 63.67, 36, 15.75, 2), g(415.2, 63.67, 36, 15.75, 2), g(454.95, 63.67, 36, 15.75, 2)] },
];

/**
 * THE BOXES NOTHING CAN ANSWER — created empty and editable, never given a value. Each reason below is the
 * reason; test/r413-cp22a.test.ts holds this list against `source: 'none'` so neither can drift.
 */
export const CP22A_UNFILLABLE_REASONS: Record<string, string> = {
  H4a: 'Whether this notice is new, an amendment or an addition is the operator’s to say; nothing records a CP22A as filed.',
  H4b: 'As H4a.',
  H4c: 'As H4a.',
  A13b: 'The children’s relief AMOUNT. The monthly (MTD) and annual child reliefs are different schedules, so no figure the system holds is the one this box asks for.',
  A14c: 'The spouse’s TIN: the family register has no tax-number column.',
  A16x: 'Only the operator knows whether the correspondence address is a tax agent’s.',
  B2dari: 'Leave pay: no EA figure or pay-item mapping separates it.',
  B2hingga: 'As B2dari.',
  B2: 'As B2dari. Blank, never 0.00 — a zero would say there was none.',
  B10dari: 'Allowances in kind (food, clothing, lodging, servants): no EA figure separates them.',
  B10hingga: 'As B10dari.',
  B10: 'As B10dari.',
  B11dari: 'Car and driver: no EA figure separates them from benefits in kind.',
  B11hingga: 'As B11dari.',
  B11: 'As B11dari.',
  B4tempoh: 'Completed years of service for a gratuity: no record of what the gratuity was computed on.',
  B4kecuali: 'Tax-exempt part of a gratuity: an exemption claim the system does not compute.',
  B5tempoh: 'Completed years of service for loss-of-employment compensation: as B4tempoh.',
  B5kecuali: 'Tax-exempt part of the compensation: as B4kecuali.',
  B6jenis: 'The allowance TYPES: the EA engine carries line 6 as one total, not by pay item.',
  B13diberi: 'ESOS/ESPP option dates and share counts: no share-scheme record exists.',
  B13boleh: 'As B13diberi.',
  B13laksana: 'As B13diberi.',
  B13bil: 'As B13diberi.',
  B13baki: 'As B13diberi.',
  C1type: 'Section C, income earned but not yet reported (e.g. final pay processed after this notice): nothing can know what has not been paid.',
  C1period: 'As C1type.',
  C1amount: 'As C1type.',
  C1epf: 'As C1type.',
  C2type: 'As C1type.',
  C2period: 'As C1type.',
  C2amount: 'As C1type.',
  C2epf: 'As C1type.',
  C3type: 'As C1type.',
  C3period: 'As C1type.',
  C3amount: 'As C1type.',
  C3epf: 'As C1type.',
  D1: 'Money the employer is holding back to pay the leaver later: not recorded anywhere.',
  E4: 'The signature itself.',
};

export const CP22A_UNFILLABLE = CP22A_FIELDS.filter((f) => f.source === 'none').map((f) => f.code);

/** The boxes the operator types on the preview screen (A5, A6, A8, A17); never stored. */
export const CP22A_TYPED = CP22A_FIELDS.filter((f) => f.source === 'typed').map((f) => f.code);

export const CP22A_SECTIONS = [
  { letter: 'H', label: 'Majikan (kepala borang)' },
  { letter: 'A', label: 'A. BUTIR-BUTIR PEKERJA YANG BERHENTI KERJA / BERSARA / MENINGGAL DUNIA' },
  { letter: 'B', label: 'B. BUTIR-BUTIR SARAAN' },
  { letter: 'C', label: 'C. BUTIR-BUTIR PENDAPATAN YANG BELUM DILAPORKAN' },
  { letter: 'D', label: 'D. BUTIR-BUTIR LAIN' },
  { letter: 'E', label: 'E. AKUAN PEGAWAI YANG DIBERI KUASA' },
] as const;

export const cp22aSection = (f: Cp22aField): string => f.code.charAt(0);

/** Every widget rect: one per row of a `multirow`, one per group of a `comb`, else the rect. */
export function cp22aWidgets(f: Cp22aField): Cp22aRect[] {
  if (f.type === 'multirow') return [f.rect, ...(f.moreRows ?? [])];
  if (f.type === 'comb') return (f.groups ?? []).map((gr) => gr.rect);
  return [f.rect];
}

/** Total printed cells of a comb. */
export const cp22aCombCapacity = (f: Cp22aField): number => (f.groups ?? []).reduce((n, gr) => n + gr.cells, 0);

/** AcroForm name of widget `i`; the first keeps the bare name. */
export const cp22aWidgetName = (name: string, i: number): string => (i === 0 ? name : `${name}_${i + 1}`);
