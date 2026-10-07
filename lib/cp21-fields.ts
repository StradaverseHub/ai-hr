/**
 * r415 (item 79f3f64d, step 3) — CP21 [Pin.1/2025]: the coordinate map for LHDN's own two-page form.
 *
 * "BORANG PEMBERITAHUAN OLEH MAJIKAN BAGI PEKERJA YANG HENDAK MENINGGALKAN MALAYSIA [SUBSEKSYEN 83(4) AKTA
 * CUKAI PENDAPATAN 1967]" — the notice an employer sends LHDN at least 30 days before an employee is
 * expected to leave Malaysia. Bilingual (Malay and English); A4, 595.32 × 841.92 pt, on both pages, and that
 * is LHDN's own page size: it is kept, never re-flowed.
 *
 * THE SAME PATTERN AS lib/cp22a-fields.ts, AND THE SAME TYPES. The numbers are DATA read off the artwork
 * (`public/forms/cp21-pin-1-2025.pdf`, sha256-pinned in test/r415-cp21.test.ts), not placed by eye:
 *   - page 1's input boxes and character cells are Word shapes the page paints as stroked rectangles, so
 *     each rect is that shape's bounds as PyMuPDF's `get_drawings()` reports them, in PDF user space;
 *   - where two drawn rows share a border (A1, A13, A14, A15) the upper row keeps its drawn rect and the
 *     lower one is trimmed to stop where the upper begins, so no two widgets overlap;
 *   - the page-2 tables are Word's thin filled rules; each cell is read off the rules that wall it, inset
 *     0.5 pt (the CP22A `cell` rule);
 *   - the dotted leaders (B4, B5, B6 and section D's "RM ……") are placed from the dots' own glyph origins.
 * The derivation script was a throwaway; THIS FILE is the artefact, tested as data.
 *
 * TWO PLACES WHERE A RECT IS A DECISION RATHER THAN A MEASUREMENT, said here so they can be found:
 *   H1 — the employer box is ONE drawn rectangle with no rows in it; six rows are laid in it at even pitch
 *        (the CP22A header does the same with five, in a shorter box).
 *   B11nyatakan — line 11 says "(jika ada, nyatakan)" and prints NO dotted rule to write on. The names of
 *        what line 11 holds go in the empty right-hand part of that line's own label cell.
 *
 * HOW CP21's SECTION B DIFFERS FROM CP22A's, LINE FOR LINE. Lines 1–10 are the same lines in the same order.
 * CP21's line 11 is "Bayaran-bayaran lain" — CP22A's line 12. CP21 has NO share-scheme line (CP22A's 13).
 * core/reporting.ts `cp21Particulars` does the renumbering; this file only knows CP21's own numbers.
 *
 * COORDINATES: PDF user space, origin bottom-left, y up, MediaBox 0 0 595.32 841.92 on both pages.
 */
import {
  cp22aCombCapacity,
  cp22aWidgetName,
  cp22aWidgets,
  type Cp22aCombGroup,
  type Cp22aField,
  type Cp22aRect,
  type Cp22aSource,
} from './cp22a-fields';

/** Both template pages carry this box. Asserted against the real file in test/r415-cp21.test.ts. */
export const CP21_MEDIA_BOX = { width: 595.32, height: 841.92 } as const;

/** Page 1: header and section A. Page 2: sections B to E. */
export const CP21_PAGE_COUNT = 2;

/**
 * A CP21 box has exactly the shape of a CP22A box (text / multirow / rule / comb / mark; record / typed /
 * none), so it IS that type — one vocabulary for LHDN's character-cell forms, not two that can drift.
 */
export type Cp21Field = Cp22aField;
export type Cp21Source = Cp22aSource;

const r = (x: number, y: number, width: number, height: number): Cp22aRect => ({ x, y, width, height });
const g = (x: number, y: number, width: number, height: number, cells: number): Cp22aCombGroup => ({
  rect: r(x, y, width, height),
  cells,
});
/** Three pairs of cells, dd mm yy, at the three printed x positions. Each pair is 2 × 17.55 pt. */
const date = (xs: [number, number, number], y: number, h: number, w = 35.1): Cp22aCombGroup[] =>
  xs.map((x) => g(x, y, w, h, 2));

/** lib/cp22a-fields.ts's dotted-rule placement, the same constants for the same reason. */
const RULE_LIFT = 1.2;
const RULE_HEIGHT = 11;
const HELVETICA_ASCENT = 0.718;
const ruleRect = (x0: number, x1: number, baseline: number, size: number): Cp22aRect => ({
  x: x0,
  y: Math.round((baseline + RULE_LIFT - RULE_HEIGHT / 2 + (HELVETICA_ASCENT * size) / 2) * 100) / 100,
  width: Math.round((x1 - x0) * 100) / 100,
  height: RULE_HEIGHT,
});

/** Section B's "Dari / Hingga / RM" columns, read off the vertical rules at x 316.49 / 403.99 / 503.86 / 579.7. */
const B_COL = {
  dari: { x0: 316.97, x1: 403.99 },
  hingga: { x0: 404.47, x1: 503.86 },
  rm: { x0: 504.34, x1: 579.7 },
} as const;
/** Rows 1–11 of section B: [top of the rule below, bottom of the rule above]. */
const B_ROWS: [number, number][] = [
  [716.14, 734.62],
  [697.3, 715.66],
  [678.34, 696.82],
  [608.26, 677.86],
  [540.07, 607.78],
  [492.79, 539.59],
  [473.83, 492.31],
  [454.99, 473.35],
  [436.03, 454.51],
  [398.71, 435.55],
  [379.87, 398.23],
];
const INSET = 0.5;
const cell = (col: { x0: number; x1: number }, [y0, y1]: [number, number]): Cp22aRect => ({
  x: Math.round((col.x0 + INSET) * 100) / 100,
  y: Math.round((y0 + INSET) * 100) / 100,
  width: Math.round((col.x1 - col.x0 - 2 * INSET) * 100) / 100,
  height: Math.round((y1 - y0 - 2 * INSET) * 100) / 100,
});

/**
 * Section B's own line labels, in LHDN's Malay. A line with no EA figure behind it is `none` on all three
 * boxes; `cp21Particulars` in core/reporting.ts says which EA figure feeds each of the others.
 */
export const CP21_B_LINES = [
  { line: 1, label: 'Gaji, bayaran, upah dan kerja lebih masa', source: 'record' },
  { line: 2, label: 'Gaji cuti', source: 'none' },
  { line: 3, label: 'Komisen dan bonus', source: 'record' },
  { line: 4, label: 'Ganjaran', source: 'record' },
  { line: 5, label: 'Pampasan kerana kehilangan pekerjaan', source: 'record' },
  { line: 6, label: 'Elaun tunai termasuk cukai ditanggung oleh majikan', source: 'record' },
  { line: 7, label: 'Pencen daripada majikan', source: 'record' },
  { line: 8, label: 'Manfaat berupa barangan yang layak dikenakan cukai', source: 'record' },
  { line: 9, label: 'Nilai tempat kediaman yang disediakan majikan', source: 'record' },
  { line: 10, label: 'Elaun-elaun selain daripada wang seperti makanan, pakaian, lojing atau pembantu rumah', source: 'none' },
  { line: 11, label: 'Bayaran-bayaran lain (jika ada, nyatakan)', source: 'record' },
] as const satisfies readonly { line: number; label: string; source: Cp22aSource }[];

const bLineFields: Cp21Field[] = CP21_B_LINES.flatMap(({ line, label, source }) => {
  const row = B_ROWS[line - 1];
  return [
    { code: `B${line}dari`, label: `${line}) ${label} — Tempoh dari`, name: `b${line}From`, type: 'text', page: 1, source, fontSize: 8, rect: cell(B_COL.dari, row) },
    { code: `B${line}hingga`, label: `${line}) ${label} — Tempoh hingga`, name: `b${line}To`, type: 'text', page: 1, source, fontSize: 8, rect: cell(B_COL.hingga, row) },
    { code: `B${line}`, label: `${line}) ${label} — RM`, name: `b${line}Amount`, type: 'text', page: 1, source, fontSize: 8, alignRight: true, rect: cell(B_COL.rm, row) },
  ] satisfies Cp21Field[];
});

/** Section C — "BUTIR-BUTIR PENDAPATAN YANG BELUM DILAPORKAN": three ruled rows, four columns (Bil. is printed). */
const C_COLS = [
  { key: 'type', label: 'Jenis Pendapatan', x0: 64.58, x1: 155.42 },
  { key: 'period', label: 'Tempoh Diperoleh', x0: 155.9, x1: 284.09 },
  { key: 'amount', label: 'Jumlah Pendapatan (RM)', x0: 284.57, x1: 404.59 },
  { key: 'epf', label: 'Caruman KWSP Pekerja (RM)', x0: 405.07, x1: 579.7 },
] as const;
const C_ROWS: { roman: string; y: [number, number] }[] = [
  { roman: 'i', y: [310.97, 323.69] },
  { roman: 'ii', y: [297.65, 310.49] },
  { roman: 'iii', y: [284.45, 297.17] },
];
const cFields: Cp21Field[] = C_ROWS.flatMap(({ roman, y }, i) =>
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
      }) satisfies Cp21Field,
  ),
);

/** Section D's amounts sit on the printed "RM ……" leader, from the first dot to the last. */
const D_RULE = { x0: 470.7, x1: 566.5 };
const dRule = (baseline: number) => ruleRect(D_RULE.x0, D_RULE.x1, baseline, 9);

/** Every entry area, page 1 (left column, then right) then page 2, in the form's reading order. */
export const CP21_FIELDS: Cp21Field[] = [
  // ── HEADER ─────────────────────────────────────────────────────────────────────────────────────────
  // ONE drawn box (28.42, 581.61, 272.1 × 107.7, 1-pt stroke), six rows at even pitch inside its stroke.
  { code: 'H1', label: 'Nama & Alamat Majikan / Employer’s Name & Address', name: 'employerNameAddress', type: 'multirow', page: 0, rows: 6, source: 'record', fontSize: 8,
    rect: r(30.0, 670.86, 268.9, 17.7),
    moreRows: [r(30.0, 653.16, 268.9, 17.7), r(30.0, 635.46, 268.9, 17.7), r(30.0, 617.76, 268.9, 17.7), r(30.0, 600.06, 268.9, 17.7), r(30.0, 582.36, 268.9, 17.7)] },
  // The form PRINTS the "E" in its own cell (x 314.37); the ten cells after the gap hold the number.
  { code: 'H2', label: 'No. Majikan / Employer’s No.', name: 'employerNo', type: 'comb', page: 0, source: 'record',
    rect: r(344.82, 672.71, 180, 17.95), groups: [g(344.82, 672.71, 180, 17.95, 10)] },
  { code: 'H3', label: 'No. Telefon Majikan / Employer’s Telephone No.', name: 'employerPhone', type: 'text', page: 0, source: 'record',
    rect: r(312.37, 636.41, 212.25, 17.0) },
  { code: 'H4a', label: 'Status Pemberitahuan — Baharu / New', name: 'statusNew', type: 'mark', page: 0, source: 'none', choiceOf: 'status',
    rect: r(311.47, 584.67, 18, 15.75) },
  { code: 'H4b', label: 'Status Pemberitahuan — Pindaan / Amendment', name: 'statusAmended', type: 'mark', page: 0, source: 'none', choiceOf: 'status',
    rect: r(385.28, 584.67, 18, 15.75) },
  { code: 'H4c', label: 'Status Pemberitahuan — Tambahan / Additional', name: 'statusAdditional', type: 'mark', page: 0, source: 'none', choiceOf: 'status',
    rect: r(491.93, 584.67, 18, 15.75) },

  // ── A. BUTIR-BUTIR PEKERJA YANG AKAN MENINGGALKAN MALAYSIA — left column ───────────────────────────────
  { code: 'A1', label: '1. Nama penuh / Full name', name: 'employeeName', type: 'multirow', page: 0, rows: 2, source: 'record',
    rect: r(35.53, 507.74, 263.85, 17.35), moreRows: [r(35.53, 490.49, 263.84, 17.25)] },
  { code: 'A2', label: '2. Tarikh mula bekerja / Date of commencement of employment', name: 'commencementDate', type: 'comb', page: 0, source: 'record',
    rect: r(187.57, 466.04, 35.1, 15.75), groups: date([187.57, 227.06, 265.82], 466.04, 15.75) },
  { code: 'A3', label: '3. Tarikh dijangka meninggalkan Malaysia / Expected date to leave Malaysia', name: 'departureDate', type: 'comb', page: 0, source: 'typed',
    rect: r(187.82, 433.65, 35.1, 15.75), groups: date([187.82, 227.31, 266.07], 433.65, 15.75) },
  { code: 'A4a', label: '4. Mastautin dalam tahun meninggalkan Malaysia — Ya / Yes', name: 'residentYes', type: 'mark', page: 0, source: 'record', choiceOf: 'resident',
    rect: r(40.33, 364.88, 17.95, 16.3) },
  { code: 'A4b', label: '4. Mastautin dalam tahun meninggalkan Malaysia — Tidak / No', name: 'residentNo', type: 'mark', page: 0, source: 'record', choiceOf: 'resident',
    rect: r(123.94, 365.25, 17.95, 16.3) },
  { code: 'A5', label: '5. No. Pengenalan (No. Kad Pengenalan / Pasport) / Identification No.', name: 'icNo', type: 'comb', page: 0, source: 'record',
    rect: r(38.28, 311.6, 216, 17.95), groups: [g(38.28, 311.6, 216, 17.95, 12)] },
  { code: 'A6', label: '6. No. Pengenalan Cukai / Tax Identification No.', name: 'taxNo', type: 'comb', page: 0, source: 'record',
    rect: r(36.22, 268.88, 32.61, 17.92), groups: [g(36.22, 268.88, 32.61, 17.92, 2), g(75.97, 268.88, 179.11, 17.92, 11)] },
  { code: 'A7', label: '7. Warganegara / Citizen', name: 'citizen', type: 'text', page: 0, source: 'record',
    rect: r(125.47, 234.46, 175.7, 19.05) },
  { code: 'A8', label: '8. Tarikh lahir / Date of birth', name: 'dateOfBirth', type: 'comb', page: 0, source: 'record',
    rect: r(186.92, 207.06, 35.1, 15.75), groups: date([186.92, 226.41, 265.17], 207.06, 15.75) },
  { code: 'A9', label: '9. Tempat lahir / Place of birth', name: 'placeOfBirth', type: 'text', page: 0, source: 'none',
    rect: r(124.77, 179.16, 175.7, 19.05) },
  { code: 'A10', label: '10. Jenis pekerjaan / Nature of employment', name: 'natureOfEmployment', type: 'text', page: 0, source: 'record',
    rect: r(124.77, 147.27, 175.7, 19.05) },
  { code: 'A11', label: '11. No. telefon pekerja / Employee’s telephone no.', name: 'employeePhone', type: 'text', page: 0, source: 'record',
    rect: r(37.28, 103.97, 181.4, 19.05) },
  { code: 'A12', label: '12. Alamat e-mel / E-mail address', name: 'employeeEmail', type: 'text', page: 0, source: 'record', fontSize: 8,
    rect: r(38.28, 63.72, 235.5, 18.95) },

  // ── A — right column ───────────────────────────────────────────────────────────────────────────────
  { code: 'A13', label: '13. Alamat surat-menyurat pekerja yang terkini / Current address of employee', name: 'correspondenceAddress', type: 'multirow', page: 0, rows: 4, source: 'record',
    rect: r(325.67, 494.56, 235.55, 15.73),
    moreRows: [r(325.67, 478.98, 235.55, 15.58), r(325.67, 463.26, 235.55, 15.72), r(325.67, 447.64, 235.55, 15.62)] },
  { code: 'A13x', label: 'Sila tandakan ‘X’ jika alamat surat-menyurat di atas adalah alamat ejen cukai', name: 'correspondenceIsTaxAgent', type: 'mark', page: 0, source: 'none',
    rect: r(325.87, 424.39, 18, 15.75) },
  { code: 'A14', label: '14. Alasan meninggalkan negara ini / Reason for departure', name: 'departureReason', type: 'multirow', page: 0, rows: 2, source: 'typed',
    rect: r(326.67, 358.95, 235.25, 17.35), moreRows: [r(326.57, 342.2, 235.25, 16.75)] },
  { code: 'A15', label: '15. Alamat surat-menyurat di luar Malaysia / Correspondence address outside Malaysia', name: 'overseasAddress', type: 'multirow', page: 0, rows: 4, source: 'typed',
    rect: r(326.17, 298.52, 235.25, 15.74),
    moreRows: [r(326.17, 282.93, 235.25, 15.59), r(326.17, 267.87, 235.25, 15.06), r(326.17, 252.9, 235.25, 14.97)] },
  // A plain box, not cells: the date is written dd/mm/yyyy.
  { code: 'A16', label: '16. Jika akan kembali ke Malaysia, tarikh dijangka kembali / Expected date of return', name: 'returnDate', type: 'text', page: 0, source: 'typed',
    rect: r(325.52, 199.06, 235.25, 19.05) },
  { code: 'A17a', label: '17. Cukai ditanggung majikan / Tax borne by employer — Ya / Yes', name: 'taxBorneYes', type: 'mark', page: 0, source: 'record', choiceOf: 'taxBorne',
    rect: r(323.97, 147.59, 17.95, 16.3) },
  { code: 'A17b', label: '17. Cukai ditanggung majikan / Tax borne by employer — Tidak / No', name: 'taxBorneNo', type: 'mark', page: 0, source: 'record', choiceOf: 'taxBorne',
    rect: r(407.59, 147.96, 17.95, 16.3) },
  { code: 'A18a', label: '18. Menerima tawaran skim pemberhentian pekerja — Ya / Yes', name: 'schemeYes', type: 'mark', page: 0, source: 'typed', choiceOf: 'scheme',
    rect: r(323.82, 84.99, 17.95, 16.3) },
  { code: 'A18b', label: '18. Menerima tawaran skim pemberhentian pekerja — Tidak / Tidak Berkenaan', name: 'schemeNo', type: 'mark', page: 0, source: 'typed', choiceOf: 'scheme',
    rect: r(407.44, 85.36, 17.95, 16.3) },

  // ── B. BUTIR-BUTIR SARAAN (page 2) ──────────────────────────────────────────────────────────────────
  ...bLineFields,
  // Lines 4 and 5 each print two dotted sub-questions, in Malay and again in English; the widget is on the
  // Malay leader. Line 6 asks for the allowance types. Baselines are the dots' own.
  { code: 'B4tempoh', label: '4) Ganjaran — Tempoh tahun genap perkhidmatan', name: 'b4Years', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(179.78, 299.79, 661.18, 7.5) },
  { code: 'B4kecuali', label: '4) Ganjaran — Ganjaran dikecualikan cukai: RM', name: 'b4Exempt', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(169.94, 267.76, 650.02, 7.5) },
  { code: 'B5tempoh', label: '5) Pampasan — Tempoh tahun genap perkhidmatan', name: 'b5Years', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(186.38, 297.52, 590.02, 7.5) },
  { code: 'B5kecuali', label: '5) Pampasan — Pampasan dikecualikan cukai: RM', name: 'b5Exempt', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(175.34, 273.05, 578.86, 7.5) },
  { code: 'B6jenis', label: '6) Elaun tunai — sebutkan jenis-jenis elaun', name: 'b6Types', type: 'rule', page: 1, source: 'none', fontSize: 7.5,
    rect: ruleRect(147.35, 287.82, 518.83, 7.5) },
  // No printed rule: the free right-hand part of line 11's own label cell (the label ends at x 202.93).
  { code: 'B11nyatakan', label: '11) Bayaran-bayaran lain — nyatakan', name: 'b11Specify', type: 'text', page: 1, source: 'record', fontSize: 7, foldWith: '; ',
    rect: r(205.5, 380.5, 110.0, 17.0) },
  // JUMLAH — inside its own heavier border (the 1.44-pt rules at x 503.38 / 579.22 and y 363.53 / 378.43).
  { code: 'BJ', label: 'JUMLAH / TOTAL', name: 'bTotal', type: 'text', page: 1, source: 'record', fontSize: 8, alignRight: true,
    rect: r(505.3, 365.4, 73.4, 12.6) },

  // ── C. BUTIR-BUTIR PENDAPATAN YANG BELUM DILAPORKAN ─────────────────────────────────────────────────
  ...cFields,

  // ── D. BUTIR-BUTIR LAIN ─────────────────────────────────────────────────────────────────────────────
  { code: 'D1', label: '1) Jumlah wang yang ditahan oleh majikan dan akan dibayar kepada pekerja', name: 'd1Withheld', type: 'rule', page: 1, source: 'none', fontSize: 9, alignRight: true,
    rect: dRule(250.61) },
  { code: 'D2', label: '2) Jumlah Potongan Cukai Bulanan yang dibayar ke LHDNM dalam tahun ini', name: 'd2Pcb', type: 'rule', page: 1, source: 'record', fontSize: 9, alignRight: true,
    rect: dRule(227.33) },
  { code: 'D3', label: '3) Jumlah potongan zakat yang dibayar dalam tahun ini', name: 'd3Zakat', type: 'rule', page: 1, source: 'record', fontSize: 9, alignRight: true,
    rect: dRule(205.61) },
  { code: 'D4', label: '4) Caruman pekerja kepada KWSP atau kumpulan wang yang diluluskan', name: 'd4Epf', type: 'rule', page: 1, source: 'record', fontSize: 9, alignRight: true,
    rect: dRule(183.86) },

  // ── E. AKUAN PEGAWAI YANG DIBERI KUASA — each row's box starts after its printed label ─────────────────
  { code: 'E1', label: 'Nama / Name', name: 'officerName', type: 'text', page: 1, source: 'record', rect: r(98.0, 148.0, 480.0, 13.2) },
  { code: 'E2', label: 'Jawatan / Designation', name: 'officerDesignation', type: 'text', page: 1, source: 'record', rect: r(127.0, 133.3, 451.0, 13.2) },
  { code: 'E3', label: 'Alamat e-mel / E-mail address', name: 'officerEmail', type: 'text', page: 1, source: 'record', rect: r(153.0, 118.7, 425.0, 13.2) },
  { code: 'E4', label: 'Tandatangan / Signature', name: 'officerSignature', type: 'text', page: 1, source: 'none', rect: r(134.0, 98.3, 170.0, 19.0) },
  { code: 'E5', label: 'Tarikh / Date', name: 'declarationDate', type: 'comb', page: 1, source: 'record',
    rect: r(370.4, 99.9, 36, 15.75), groups: [g(370.4, 99.9, 36, 15.75, 2), g(410.9, 99.9, 36, 15.75, 2), g(450.65, 99.9, 36, 15.75, 2)] },
];

/**
 * THE BOXES NOTHING CAN ANSWER — created empty and editable, never given a value. Each reason is the
 * reason; test/r415-cp21.test.ts holds this list against `source: 'none'` both ways, so neither can drift.
 */
export const CP21_UNFILLABLE_REASONS: Record<string, string> = {
  H4a: 'Whether this notice is new, an amendment or an addition is the operator’s to say; nothing records a CP21 as filed.',
  H4b: 'As H4a.',
  H4c: 'As H4a.',
  A9: 'Place of birth: no column in the person record holds it (person has date of birth and nationality, not birthplace).',
  A13x: 'Only the operator knows whether the correspondence address is a tax agent’s.',
  B2dari: 'Leave pay: no EA figure or pay-item mapping separates it.',
  B2hingga: 'As B2dari.',
  B2: 'As B2dari. Blank, never 0.00 — a zero would say there was none.',
  B10dari: 'Allowances in kind (food, clothing, lodging, servants): no EA figure separates them.',
  B10hingga: 'As B10dari.',
  B10: 'As B10dari.',
  B4tempoh: 'Completed years of service for a gratuity: no record of what the gratuity was computed on.',
  B4kecuali: 'Tax-exempt part of a gratuity: an exemption claim the system does not compute.',
  B5tempoh: 'Completed years of service for loss-of-employment compensation: as B4tempoh.',
  B5kecuali: 'Tax-exempt part of the compensation: as B4kecuali.',
  B6jenis: 'The allowance TYPES: the EA engine carries line 6 as one total, not by pay item.',
  C1type: 'Section C, income of preceding years not declared: nothing records what was not declared.',
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
  D1: 'Money the employer is holding back to pay the employee later: not recorded anywhere.',
  E4: 'The signature itself.',
};

export const CP21_UNFILLABLE = CP21_FIELDS.filter((f) => f.source === 'none').map((f) => f.code);

/** The boxes the operator types on the preview screen (A3, A14, A15, A16, A18); never stored. */
export const CP21_TYPED = CP21_FIELDS.filter((f) => f.source === 'typed').map((f) => f.code);

export const CP21_SECTIONS = [
  { letter: 'H', label: 'Majikan (kepala borang)' },
  { letter: 'A', label: 'A. BUTIR-BUTIR PEKERJA YANG AKAN MENINGGALKAN MALAYSIA' },
  { letter: 'B', label: 'B. BUTIR-BUTIR SARAAN' },
  { letter: 'C', label: 'C. BUTIR-BUTIR PENDAPATAN YANG BELUM DILAPORKAN' },
  { letter: 'D', label: 'D. BUTIR-BUTIR LAIN' },
  { letter: 'E', label: 'E. AKUAN PEGAWAI YANG DIBERI KUASA' },
] as const;

/** The CP22A map's pure helpers, which take any box of this shape. */
export const cp21Widgets = cp22aWidgets;
export const cp21CombCapacity = cp22aCombCapacity;
export const cp21WidgetName = cp22aWidgetName;
