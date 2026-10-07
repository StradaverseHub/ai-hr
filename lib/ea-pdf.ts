// ADR-0036 (#22 follow-up) — render an annual EA (C.P.8A) Statement of Remuneration as an A4 PDF with
// pdf-lib (pure JS, no WASM/native, so no Next bundler friction). A pure function over the
// employeeEaStatement read + localized labels, so it is unit-testable and reused identically by every
// surface that links the /me EA PDF route. Mirrors lib/payslip-pdf.ts; A4 portrait because the EA is
// denser than the A5 payslip.
//
// 587ee719 / 6036dab7 — ONE RENDERER, AND IT STAYS ONE. English and Bahasa Malaysia are a label bundle
// handed to this function, not a second implementation: two renderers can disagree about one employee's
// income on a tax document, and that is the single outcome this file exists to prevent. Every box the
// customer's field mapping names is drawn HERE, from the ONE eaStatement read, in both languages.
//
// ── r219 (item ece6d75d) — THE PAGE IS NOW THE AGENCY'S ARRANGEMENT, NOT OUR LIST ────────────────────
// Until this round the EA printed as a tidy list of label/value rows: a letterhead, five section headers
// and a right-hand money column of our own devising. Everything on it was correct and nothing on it
// looked like the form. It is now drawn to the C.P.8A (Pin. 2023) arrangement — masthead, No. Siri /
// TIN Majikan E, the "Penyata Gaji Pekerja SWASTA EA" block, the ruled banner, Section A's two-column
// numbering, B to F in the form's own order with the RM column down the right, and the ruled officer box
// at the foot.
//
// WHERE THE ARRANGEMENT CAME FROM, AND WHAT IT IS NOT. `docs/forms/ea-cp8a-pin-2024-specimen.png` is a
// BLANK C.P.8A (feedback attachment 9c080805-6b93-40ab-ba99-1d00d961b38b, rasterised at
// 150dpi) and `docs/forms/ea-cp8a-pin-2023-transcription.txt` is every caption on it, transcribed by
// hand, with the layout notes. Every coordinate in `EA_FORM` below was MEASURED off that PNG by scanning
// it for rules, not eyeballed — the CP39 lesson (lib/cp39-form-pdf.ts), where the eyeballed percentages
// were wrong by up to 20 points of page width.
//
// ⚠️ THE SPECIMEN IS NOT LHDN ARTWORK. Its Producer is "Developer Express Inc. DXperience v23.2.5" —
// another payroll system's rendering of the agency's page, the same provenance as the CP39, Borang 8A
// and Borang A references. So the EA's shelf entry (`my.ea`; `my.ea.en` / `my.ea.ms` before r402) declares `agency-layout` (drawn to the agency's own
// arrangement, on our own paper, with no agency artwork on disk) and may NEVER declare `official`;
// `public/forms/` holds only the agency artwork listed in `MY_OFFICIAL_ARTWORK` (CP22; CP22A since
// r413; CP21 since r415) — no C.P.8A. AGENTS 28b: nothing
// here asserts what LHDN does or does not publish — only what this repository holds, which
// `public/forms/` answers.
//
// ⚠️ ONE PAGE, AND THE GEOMETRY IS WHY. The form's footprint is now CONSTANT: every caption and every
// rule the blank form prints is drawn at a fixed place whether or not we have a figure for it, so the
// page cannot grow with the data. Only the footnote strip below the officer box flows, and it has the
// ~110 points the specimen leaves empty under its own foot. test/ea-pdf.test.ts refuses a second page in
// every locale.
//
// ── r220 (item 61c2e30f) — THE FORM WITH NOTHING IN IT, OFF THE SAME RENDERER ────────────────────────
// The reporter asked to see the EA empty first, so it can be held up against LHDN's own page before any
// filled one is trusted. `renderEaPdf(blankEaPdfData(), labels, { blank: true })` is that document, and it
// is THIS renderer — a second "blank version" code path would be a second form to keep in step with the
// arrangement, which is the duplication the file's opening note exists to prevent (and exactly what
// app/payroll/cp22/blank/route.ts refused to do for the CP22).
//
// WHY A FLAG AND NOT AN EMPTY VALUE. Every partB/partC/partD/partE amount on `EaPdfData` is a REQUIRED
// number, deliberately (see the type's own comments: an optional money field is one a caller can forget,
// and the form then prints an empty rule that reads as "nothing on file" rather than "nobody wired it").
// An "empty" statement is therefore a statement of zeros, and zeros print — a blank C.P.8A with 0.00 down
// the whole money column asserts that none of that money exists, on every line at once, which is AGENTS 28
// at full width. A sentinel amount (NaN, -1) would be worse again: it is a number a real caller can reach
// by accident. So the caller says `{ blank: true }` in as many words, and the renderer suppresses THE
// MONEY COLUMN — `amountOrRule` draws its rule and nothing on it — while every caption, box, heading,
// note, rule and signature area is drawn at exactly the position it occupies on a filled form.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { bestFaceFor, embedPayslipFaces, payslipFaceScripts } from './payslip-pdf-fonts';

/** No partial or unreadable statutory PDF may escape a failed measured plan. */
export class EaLayoutFitError extends Error {
  constructor(public readonly section: string) { super(`EA form cannot fit complete readable information in ${section}. Review the recorded information or request a layout review.`); this.name = 'EaLayoutFitError'; }
}
export const EA_READABLE_FONT_FLOOR = 6;
// Retain the export name for existing consumers; revision 5 supersedes V6's full-width box.
// The reporter's latest screenshot puts the Date outside left beside a right-hand officer box.
export const EA_V6_FOOT = { left:191, top:727.5, bottom:817.9, captionX:196.9, valueX:331.5, right:556.1, size:8, lineHeight:11.2 } as const;

/** Mirrors EaStatement (localization/my/reports.ts). year is a STRING end-to-end (the read filters
 *  payPeriod LIKE '<year>-%'). */
export type EaPdfData = {
  year: string;
  /**
   * The employer, as the form's own boxes ask for it.
   *
   * r219 — the five fields after `eNumber` feed the ruled officer box at the foot (Name Pegawai /
   * Jawatan / Nama dan Alamat Majikan / No. Telefon Majikan) and the header's LHDNM Negeri. REQUIRED,
   * for the same reason Part A's particulars are: an optional employer field is one a caller can forget,
   * and the form then prints an empty rule that reads as "nothing on file" rather than "nobody wired it".
   * Any of them may legitimately be null, and a null prints the blank form's own rule — never 0.00,
   * never a placeholder, never a plausible guess (AGENTS 28).
   */
  employer: {
    name: string;
    eNumber: string | null;
    address: string[];
    phone: string | null;
    lhdnState: string | null;
    officerName: string | null;
    officerPosition: string | null;
  };
  employee: {
    name: string;
    ic: string | null;
    taxNo: string | null;
    epfNo: string | null;
    socsoNo: string | null;
    category: number;
    /**
     * A.8 — "Number of children qualified for tax relief": a COUNT of children, never the s.48-weighted
     * figure (r364, reversing r359). NULL prints an EMPTY rule, which is what the blank form carries and
     * what an employee with no recorded number of children deserves — `String(0)` would assert that no
     * child qualifies.
     *
     * ⚠️ r359's SENTENCE HERE WAS THE PROSE THAT OUTLIVED NOTHING — IT WAS THE KERNEL. It read: "A.8 —
     * C, the number of qualifying children in LHDN's weighted sense (r359). NULL prints an EMPTY rule …
     * a head count printed beside an empty D.6 would be two contradictory answers on one page." Both
     * halves are reversed. C belongs to the MONTHLY tax formula; LHDN's own calculation slip prints a
     * child grid of 2 whole children on page 1 and "C = Number of eligible children 9.00" on page 6, so
     * the agency itself does not use one figure for both. And A.8 no longer depends on D.6's payroll
     * stamp at all: A.8 is a fact about the employee, D.6 is a fact about the year's payroll, and two
     * answers to two different questions are not a contradiction.
     */
    children: number | null;
    hiredOn: string;
    terminatedOn: string | null;
    /** 6036dab7 — Part A's three added particulars. REQUIRED, not optional-and-additive like
     *  `exemptAllowances` below: an optional Part A field is one a caller can forget to pass, and the
     *  form then prints a blank box that looks like "nothing on file" rather than "nobody wired it". */
    employeeNo: string | null;
    jobTitle: string | null;
    passport: string | null;
  };
  /** exemptAllowances (feedback 09b554e9): the year's tax-exempt PCB_* allowance portions — optional +
   *  additive (older callers omit it and the row renders as 0.00).
   *
   *  6036dab7 — the ten fields after it are the customer's mapped Part B boxes, and they are REQUIRED for
   *  the same reason the Part A trio is: a taxable box that silently prints 0.00 because a caller forgot
   *  it is indistinguishable from a taxable box that is genuinely nil. `gross` is their sum. */
  partB: {
    grossSalary: number;
    bonus: number;
    allowances: number;
    gross: number;
    exemptAllowances?: number;
    directorFee: number;
    tipsPerquisites: number;
    taxBorneByEmployer: number;
    esos: number;
    gratuity: number;
    arrears: number;
    benefitsInKind: number;
    livingAccommodation: number;
    unapprovedFundRefund: number;
    compensation: number;
  };
  /** 6036dab7 — Part C (Pencen dan Lain-lain), which this renderer did not draw at all. */
  partC: { pension: number; annuity: number; total: number };
  partD: {
    mtd: number;
    cp38: number;
    zakat: number;
    /** da4fc817 — the official form's D4, D5(a), D5(b) and D6. `tp1Relief` is derived from the year's
     *  approved TP1 declarations; the other three are 0 until HR amends them, and print only when set. */
    tp1Relief: number;
    donations: number;
    zakatOther: number;
    childRelief: number;
  };
  /**
   * ⚠️ r367 (item fda53352, round A) — `socso`, `eis` AND `skbbk` ARE THREE FIGURES FOR **ONE** PRINTED
   * BOX. Section E still carries exactly TWO amounts, as it always did; the second of them is now the sum
   * of all three PERKESO legs, and the renderer adds them (nothing here stores the total).
   *
   * WHY E(2) IS BROADER THAN THE SOCSO LEG — from LHDN's own paper, so the next reader cannot re-narrow it:
   *   • docs/forms/ea-cp8a-pin-2023-official-en.pdf — Section E is headed "CONTRIBUTIONS PAID BY EMPLOYEE
   *     TO APPROVED PROVIDENT / PENSION FUND AND SOCSO"; item 2 is "SOCSO: Amount of compulsory
   *     contribution paid (state the employee's share of contribution only)".
   *   • docs/forms/ea-cp8a-pin-2023-official-bm.xlsx, sharedStrings 82 and 64 — "… DAN PERKESO" and
   *     "PERKESO : Amaun caruman yang wajib dibayar (nyatakan bahagian pekerja sahaja)". The Malay
   *     ORIGINAL names the ORGANISATION, PERKESO; SOCSO is that organisation's English name, not the
   *     name of one of its schemes.
   *   • docs/forms/tp1-2026-form-en.pdf item C14 and docs/forms/tp1-2026-explanatory-notes-en.pdf — LHDN
   *     scopes "Contributions to PERKESO" to the Employees' Social Security Act 1969 [Act 4] and the
   *     Employment Insurance System Act 2017 [Act 800].
   *   • EIS is Act 800; SKBBK is Act 4 as amended (Akta A1788), employee-only, mandatory 1 Jun 2026, on
   *     the same PERKESO schedule. SKBBK postdates Pin. 2023, so the caption's silence about it is a
   *     DATING fact and not an exclusion.
   * Before r367 this box stated the SOCSO leg alone, and `eis` was on no printed EA at all after r351
   * removed our below-form strip.
   */
  partE: {
    epf: number;
    socso: number;
    eis: number;
    /** Lindung 24 Jam / SKBBK — the employee-paid Act 4 leg (eff 1 Jun 2026); no employer share exists.
     *  Printed inside E(2)'s sum, never on a line of its own: the form has no third amount. */
    skbbk: number;
    /** da4fc817 — E1's "Nama Kumpulan Wang": the fund, named before its amount, as the form asks. */
    fundName: string;
  };
  /**
   * ⚠️ r367 (item fda53352, round A) — the foot's "Tarikh" / "Date", ISO `yyyy-mm-dd`, or null for the
   * agency's empty rule (which is what the BLANK form prints, and what r219 printed on a filled one).
   *
   * COMPUTED BY THE CALLER, NEVER HERE. `localization/my/reports.ts` `eaFormDate()` owns the rule —
   * `MIN(today in Kuala Lumpur, 28 February of the year after the EA year)` — because a clock read inside
   * this pure renderer would make every EA test time-dependent. That rule is the REPORTER's business rule
   * and not the agency's: no published LHDN deadline for this box is sourced anywhere in this repo, and it
   * is deliberately not presented as one.
   */
  formDate: string | null;
  statutoryVersion: string;
  /** 1.2.6 EA Data Overwrite — EA-only amendments overlaid by HR; drives the footnote marker. Optional +
   *  defaults to [] so existing callers keep compiling. */
  overrides?: { field: string; original: number; amended: number; reason: string }[];
};

/**
 * r220 (item 61c2e30f) — how the page is drawn, as opposed to WHAT is on it.
 *
 * One member today, and it is deliberately a separate argument rather than a field on `EaPdfData`: the
 * route builds `EaPdfData` by SPREADING the `employeeEaStatement` read, and a rendering mode that can
 * arrive through a spread of somebody's payroll figures is a mode a real statement can be handed by
 * accident. Nothing in the read is named `blank`, so nothing can turn a real employee's C.P.8A into an
 * empty one without a caller typing it here.
 */
export type EaRenderOptions = {
  /**
   * Draw the FORM and nothing else: every caption, box, heading, cue, note, rule and signature area at
   * its fixed position, with the whole money column left as empty rules and no employee or employer
   * detail anywhere on the page. See the r220 block at the top of this file for why this is an explicit
   * flag and never a sentinel amount.
   */
  blank?: boolean;
  /**
   * The DOCUMENT's language, which decides which edition of the form's own furniture is drawn — the
   * masthead, the banner and the officer box (item fda53352, r346). LHDN publishes the C.P.8A in both
   * languages and its English edition has an English masthead, so an English EA drawn with the Malay
   * furniture is a document the agency does not issue.
   *
   * Defaults to English. `app/me/ea/[employmentId]/pdf/route.ts` and the blank route already resolve a
   * document locale for the CAPTIONS; this makes the furniture follow the same one.
   */
  locale?: string;
};

/**
 * r220 — the empty statement the blank form is drawn over.
 *
 * A FACTORY, not a frozen constant and not a literal in the route: `EaPdfData` requires every Part B/C/D/E
 * amount, so the day a box is added to the form tsc fails HERE, in one place, rather than in whichever
 * route happened to hand-write its own empty object. The zeros are never printed — `{ blank: true }`
 * suppresses the money column — they exist because the type requires a number and `blank` is what decides
 * whether a number reaches the page.
 *
 * `year` is EMPTY, not the current year: the blank C.P.8A leaves "BAGI TAHUN BERAKHIR 31 DISEMBER" open
 * for whoever completes it, and stamping this year onto a blank form would be us filling in a box that is
 * not ours to fill.
 */
export function blankEaPdfData(): EaPdfData {
  return {
    year: '',
    employer: {
      name: '',
      eNumber: null,
      address: [],
      phone: null,
      lhdnState: null,
      officerName: null,
      officerPosition: null,
    },
    employee: {
      name: '',
      ic: null,
      taxNo: null,
      epfNo: null,
      socsoNo: null,
      category: 0,
      children: null,
      hiredOn: '',
      terminatedOn: null,
      employeeNo: null,
      jobTitle: null,
      passport: null,
    },
    partB: {
      grossSalary: 0,
      bonus: 0,
      allowances: 0,
      gross: 0,
      exemptAllowances: 0,
      directorFee: 0,
      tipsPerquisites: 0,
      taxBorneByEmployer: 0,
      esos: 0,
      gratuity: 0,
      arrears: 0,
      benefitsInKind: 0,
      livingAccommodation: 0,
      unapprovedFundRefund: 0,
      compensation: 0,
    },
    partC: { pension: 0, annuity: 0, total: 0 },
    partD: { mtd: 0, cp38: 0, zakat: 0, tp1Relief: 0, donations: 0, zakatOther: 0, childRelief: 0 },
    partE: { epf: 0, socso: 0, eis: 0, skbbk: 0, fundName: '' },
    // r367 — the BLANK C.P.8A still prints the agency's empty date rule. There is no statement to date,
    // and a date on a blank form would be a figure the form does not have.
    formDate: null,
    statutoryVersion: '',
    overrides: [],
  };
}

/**
 * Localized labels (resolved from the `payroll.ea` namespace in the route). Mirrors the HTML EA page.
 *
 * ── r219 — WHAT IS A LABEL HERE AND WHAT IS NOT ─────────────────────────────────────────────────────
 * THE AGENCY'S OWN PAGE FURNITURE IS NOT A LABEL. The form number, the MALAYSIA / CUKAI PENDAPATAN
 * masthead, "Penyata Gaji Pekerja SWASTA", the "EA", "No. Siri", "TIN Majikan E", "LHDNM Negeri", the
 * banner sentence and the officer box's captions are drawn from `EA_FORM_WORDS` below, in Malay, in BOTH
 * languages. They are the agency's words on the agency's page: translating a form number or a masthead
 * produces a document that no longer matches the form, and lib/cp39-form-pdf.ts applies exactly this
 * rule to its A / B / C instruction panels ("the viewer's language never changes a Malaysian tax form").
 *
 * THE SECTION TITLES AND THE BOX CAPTIONS ARE labels, and they carry the form's OWN NUMBERING in their
 * value ("1(a) …", "5(b) …"). That is what makes the EA's two Versions (English and Bahasa Malaysia — the
 * `my.ea` entry's `lang`, two entries before r402) two readable documents off one
 * renderer rather than one document twice — the reporter asked for the form in each language, and the
 * approved plan promises the English version keeps working.
 *
 * Keys REMOVED in r219, all of which still exist in `payroll.ea` for the HTML statement — the printed
 * C.P.8A simply has no box for them, and test/ea-form-boxes-contract.test.ts refuses a declared label
 * that nothing prints:
 *   • `mtdCategory` / `category1..3` — the official form has no MTD-category box. Inventing a position
 *     for it is exactly the "add a box and make the form worse" failure AGENTS 28 records.
 *   • `employmentPeriod` / `present` — replaced by the form's own item 9, which is conditional on the
 *     YEAR rather than on a date existing.
 *   • `bonus` / `directorFee` — the form's 1(b) is ONE box, "fees (including directors' fees),
 *     commission or bonus". Both figures print there, summed, under `feesCommissionBonus`.
 *   • `allowancesPerquisites` / `tipsPerquisites` — likewise 1(c), under `tipsPerquisitesOther`.
 *   • `totalGrossRemuneration` / `totalPensionOther` — the form has ONE total, the JUMLAH closed with a
 *     double rule at the end of Section C, and it totals B and C together (`formTotal`).
 *   • `epfKwsp` / `socso` — Section E's captions are "Nama Kumpulan Wang" and "Amaun caruman yang wajib
 *     dibayar (nyatakan bahagian pekerja sahaja)", which is `fundName` + `contributionAmount`.
 *   • `yearEnded` — the masthead's own "BAGI TAHUN BERAKHIR 31 DISEMBER" line carries the year.
 */
export type EaPdfLabels = {
  title: string;
  sectionAEmployeeParticulars: string;
  name: string;
  jobTitle: string;
  employeeNo: string;
  icNo: string;
  passportNo: string;
  epfNo: string;
  socsoNo: string;
  childrenTaxRelief: string;
  /** r219 — Section A item 9 and its two indented sub-items. */
  partYearNote: string;
  startedOn: string;
  leftOn: string;
  sectionBEmploymentIncome: string;
  /** r219 — B's bold "(Tidak Termasuk Elaun / Perkuisit / Pemberian / Manfaat Yang Dikecualikan Cukai)". */
  sectionBExcluding: string;
  grossSalary: string;
  /** r219 — 1(b) and 1(c), each ONE box on the form over TWO of our finer-grained figures. */
  feesCommissionBonus: string;
  tipsPerquisitesOther: string;
  /**
   * r219 — the CUE WORDS the form prints inside a caption, before an inline rule it expects to be
   * written on: 1(c)'s "(Perihal pembayaran: …)", 3's "(Nyatakan: …)" and 4's "(Alamat: …)". Their own
   * keys rather than a tail glued onto the caption, so the caption stays a whole sentence on the HTML
   * statement — a label ending in a dangling open bracket is worse there than a slightly longer key list.
   * The brackets themselves are drawn by the renderer, on either side of the rule.
   */
  paymentDetail: string;
  stateWhat: string;
  addressCue: string;
  taxBorneByEmployer: string;
  esos: string;
  gratuity: string;
  /** r219 — 1(f) is "Ganjaran bagi tempoh dari … hingga …": the two words between its two rules. */
  periodFrom: string;
  periodTo: string;
  /** r219 — item 2's "Jenis pendapatan" sub-line, which carries two description rules and no money. */
  incomeType: string;
  arrears: string;
  benefitsInKind: string;
  livingAccommodation: string;
  unapprovedFundRefund: string;
  compensation: string;
  sectionCPensionOther: string;
  pension: string;
  annuity: string;
  /** r219 — the form's single JUMLAH, closed with a double rule. Totals B and C together. */
  formTotal: string;
  sectionDTotalDeductions: string;
  monthlyTaxDeduction: string;
  cp38Deductions: string;
  zakatViaSalary: string;
  donations: string;
  /** r219 — D5's heading; `tp1Relief` and `zakatOther` are its (a) and (b). */
  tp1ClaimHeading: string;
  tp1Relief: string;
  zakatOther: string;
  childRelief: string;
  sectionEContributions: string;
  fundName: string;
  /** r219 — "Amaun caruman yang wajib dibayar (nyatakan bahagian pekerja sahaja)", used by E1 and E2. */
  contributionAmount: string;
  /** r349 — names the strip below the form as ours, so it cannot be mistaken for an agency box. */
  sectionFExemptAllowances: string;
  amendedNote: string; // 1.2.6 — printed only when ≥1 EA field was amended by HR
};

const A4: [number, number] = [595.28, 841.89];

/**
 * ── THE AGENCY'S OWN GRID, READ OFF LHDN'S FILE IN ONE PASS (r372, item 795c470c) ───────────────────
 *
 * `x` is points from the LEFT edge. `t` (and every `…T` field) is points from the TOP edge, because that
 * is how the form reads and how a form is described; `at()` inside the renderer turns one into a pdf-lib y.
 *
 * EVERY NUMBER BELOW IS MEASURED OFF `docs/forms/ea-cp8a-pin-2023-official-en.pdf`, and re-measurable:
 *
 *     pnpm exec tsx scripts/measure-ea-official-pdf.ts --all     # every text run, top-down
 *     pnpm exec tsx scripts/measure-ea-official-pdf.ts --rects    # every rectangle (the table's cells)
 *     pnpm exec tsx scripts/measure-ea-official-pdf.ts --file <ours.pdf> --all   # …on our own output
 *
 * `test/ea-agency-grid.test.ts` renders this form, parses the bytes back with the SAME module the script
 * uses (`lib/pdf-page-geometry.ts`), and asserts each drawn run against the table here. So a later edit
 * is checked against the agency's document rather than against a previous round's output.
 *
 * ⚠️ UNTIL THIS ROUND THE PAGE HAD TWO PROVENANCES AND THEY DISAGREED. r346 measured the MONEY COLUMN
 * off the agency's own PDF; everything else — the item numbers, the sub-items, the description column,
 * the left margin and every section baseline — was unchanged from r219, which traced
 * `docs/forms/ea-cp8a-pin-2024-specimen.png`: a 150 dpi rasterisation of ANOTHER PAYROLL VENDOR'S
 * rendering (Producer "Developer Express Inc. DXperience v23.2.5", item ece6d75d). The tracing put the
 * item and sub-item columns ~20 pt too far LEFT (42 / 55 against the agency's 62.5 / 80.2) and
 * compressed the page to ~87% of the agency's pitch, so Section F landed ~85 pt high. That is why
 * correcting one section per request never settled: each correction was measured against a page whose
 * grid came from the wrong document.
 *
 * ⚠️ THE "PRINTABILITY DEPARTURE" ON THE LEFT MARGIN IS RETIRED IN r372 — IT WAS BACKWARDS. The
 * paragraph that stood here, quoted so the claim can be recognised if it resurfaces:
 *
 *     "The one deliberate departure is the LEFT margin: the traced page set its rules 16.8 pt from the
 *      paper edge (under 6 mm), which is inside the unprintable margin of most office printers.
 *      Everything left-anchored is shifted to 24 pt."
 *
 * 16.8 pt was the TRACING's left edge, never a number LHDN published. `--rects` counts 150 of the
 * agency's cells beginning at x = 39.8 and NOTHING left of it on its body table (the only rectangles
 * further left are the masthead block at 32.4). The agency's page is WIDER than ours was, so adopting it
 * moves every left-anchored coordinate to the RIGHT and makes clipping LESS likely, not more. There is
 * no departure to keep and none to record.
 *
 * ⚠️ AND THE REMAINING DEPARTURES ARE NAMED, because a grid with unstated exceptions is the state this
 * round exists to end. They are: (1) our banner and section-letter blocks keep the agency's TREATMENT
 * and our own type size, because the caption strings are ours and a 9 pt Malay banner overruns the
 * strip; (2) the officer box grows downwards and then onto a SECOND SHEET for an employer name and
 * address longer than the agency's two writing rules, which the agency's own page has no provision for
 * at all (item 450f443f); (3) the amended-statement marker is ours and has no agency position.
 */
export const EA_FORM = {
  /** The agency's body table's own left edge: 150 of its cells begin here and none begins left of it. */
  left: 39.8,
  /** …and where its outer frame closes. Ours used to run to 571.3, the TRACING's frame. */
  right: 557,
  /**
   * The RM column: every Section B/C/D6 amount is right-aligned on a rule between these.
   *
   * MEASURED OFF THE AGENCY'S OWN PDF IN r346 — the one column that was already the agency's when this
   * round began. 89 cells start at x=482.3, 129 end there, 162 end at 556.6, and a cell width of 74.3
   * occurs 87 times. UNCHANGED by r372: the item promises the money column is left exactly as it is.
   */
  moneyLeft: 482.3,
  moneyRight: 556.6,
  /**
   * Where the agency writes ON that rule (the cell edge + the table's 5.4 pt cell padding).
   *
   * ⚠️ NOT DRAWN ON — our amounts are RIGHT-aligned on `moneyRight`, as money is. It is here because
   * `test/ea-agency-grid.test.ts` re-derives the money column from the agency's own file on every run
   * and this is the run position it finds; a constant nobody draws with is still evidence.
   */
  moneyLeader: 487.7,
  /**
   * ── THE FOUR TEXT COLUMNS THE FORM IS SET IN ──────────────────────────────────────────────────────
   *
   * The agency's C.P.8A is a Word TABLE. Its cells begin at 39.8 / 57.1 / 74.8 and its text sits 5.4 pt
   * inside each, which is the table's own cell padding — so the columns a reader sees are 45.5 / 62.5 /
   * 80.2, and those are what a renderer must draw on. (Section A's letter is at 45.5 against a 39.8 cell
   * edge, 5.7 pt: the letter is centred in its cell rather than padded, and 45.5 is where it lands.)
   */
  /**
   * The section letter, inside its filled block.
   *
   * ⚠️ NOT DRAWN ON either — the letter is CENTRED in the agency's own block, which puts it within a
   * point of this (45.4 for A, 45.9 for F, because the glyphs differ in width). It is the agency's
   * measured position and what the grid guard checks our centring against.
   */
  sectionLetter: 45.5,
  /** The item number — "1.", "2." … — and equally a section's TITLE, which sits in the same column. */
  itemLabel: 62.5,
  /** The sub-item letter — "(a)" … "(f)" — and any item caption that has no sub-letter under it. */
  subLabel: 80.2,
  /** A sub-item's own words, to the right of its letter (Section B and C). */
  subText: 94.3,
  /** …and D5's, which the agency sets 3.9 pt further in than B's. Its own number, not a rounding. */
  subTextD5: 98.2,
  /**
   * The filled block behind a section letter: the agency's own cell, 39.8 → 57.1, 13.2 pt tall, with the
   * caption's baseline 9.3 pt below its top edge and 3.9 pt above its foot.
   */
  letterBlockW: 17.3,
  letterBlockAscent: 9.3,
  letterBlockDescent: 3.9,
  /** Section A's two columns: caption x, the rule the value is written on, then the same on the right. */
  aLeftLabel: 80.2,
  aLeftRule: [143.5, 298.9] as const,
  /** Item 1 spans the whole table width — its cell is 74.8 → 556.6 — so its rule starts much later. */
  aNameRule: [278.7, 556.6] as const,
  /** Item 8's caption wraps, and the agency puts its rule on the SECOND line, starting further in. */
  aChildrenRule: [174.1, 298.9] as const,
  aRightNumber: 304.3,
  aRightLabel: 321.9,
  /** 9(a) / 9(b) are indented under item 9's sentence, in their own cell at 337.2. */
  aRightSubLabel: 342.6,
  aRightRule: [433.5, 556.6] as const,
  /**
   * r353 (item fda53352, point 4) — WHERE AN INLINE DESCRIPTION RULE STOPS, AND ITS CLOSING BRACKET WITH IT.
   *
   * ⚠️ THIS FIXED AN OVERPRINT THAT WAS LIVE ON EVERY FILLED FORM. B.1(c), B.3 and B.4 each carry the
   * agency's cue in brackets with a dotted rule inside the caption, and all three passed `ruleTo = 481`
   * — a magic literal, written when the money column started at 504.5 and never revisited when r346
   * moved it to `moneyLeft` (482.3). `captionWithInlineRule` draws the closing ')' at `ruleTo + 2`, i.e.
   * 483, which is INSIDE the money column, and the glyph runs ~2.7 pt further still. pdf-lib does not
   * clip (the r205 Borang A lesson), so on a form with money on those lines the bracket printed over the
   * first digit of the amount — on three lines, in both editions, and no test could see it.
   *
   * So the rule now ENDS this far short of `moneyLeft`, and the gap is sized for what is drawn after it:
   * 2 pt to the bracket + the bracket's own ~2.7 pt at 8 pt Helvetica + clearance. `test/ea-pdf.test.ts`
   * measures the drawn glyph rather than trusting this arithmetic.
   */
  inlineRuleGap: 8,
  /**
   * D5(a)/(b) print their own RM and rule at MID-PAGE; the right-hand column stays empty there.
   *
   * The agency draws the whole thing as ONE run at 342.6 — "RM " then 55 leader dots — so the rule
   * starts where its "RM " ends (342.6 + 14.7 at 8 pt) and runs the width of those dots. It stops well
   * short of the money column at 482.3, which on these two rows the agency leaves empty; a rule run to
   * `moneyRight` would print through a column that has nothing on it.
   */
  midMoney: [357.3, 478] as const,
  /** …with the agency's "RM" immediately before it. */
  midRm: 342.6,
  /** Sections E and F print an "RM" before the money column rather than relying on B's one heading. */
  rmBeforeRule: 467.1,
  /** The single bold "RM" heading over the money column, on Section B's sub-heading row. */
  rmHeading: 511.7,
  /**
   * ── THE VERTICAL GRID: EVERY BASELINE THE AGENCY SETS, IN ITS OWN ORDER ────────────────────────────
   *
   * ⚠️ THESE REPLACE A UNIFORM ~87% COMPRESSION OF THE AGENCY'S PAGE. Ours ran A 99.5 · B 197.5 ·
   * C 391.5 · D 447.5 · E 567.8 · F 627.5 against the agency's 105.9 · 229.1 · 449.4 · 518.3 · 648.5 ·
   * 712.4 (220.8 / 254.2 = 0.869; 461.3 / 531.7 = 0.868), so the page ended about 85 pt — an inch — short
   * of where the agency's ends, and every section started higher up the page than it should.
   */
  headerT: {
    formNo: 31.4,
    masthead1: 31.4,
    masthead2: 46.2,
    masthead3: 60.2,
    masthead4: 73,
    /** The top-right block: two baselines in English, one in Malay, inside a filled rectangle. */
    privateBlock: [18.3, 37.6] as const,
    privateLine: [26.2, 35.2] as const,
    ea: 38.3,
    employeeTin: 46.9,
    employeeTinRule: 59,
    serialNo: 58.1,
    employerNo: 72.5,
    lhdnState: 72.2,
  },
  /** The header band's own columns. */
  headerX: {
    /** "Serial No." / "Employer's No. E" sit in the body table's own left column. */
    leftLabel: 39.8,
    leftRule: [104.4, 188] as const,
    /** The right-hand block: the employee's TIN caption, its rule, and "LHDNM State". */
    rightLabel: 415.7,
    tinRule: [415.8, 557] as const,
    stateRule: [444.8, 557] as const,
    privateBlock: [399.1, 527] as const,
    privateText: 405.1,
  },
  /** The white-on-black banner: the agency's strip, and its caption's baseline inside it. */
  bannerT: [78.4, 92.6] as const,
  bannerCaptionT: 88.6,
  /** Section headings — the letter's baseline; the filled block is derived from it. */
  sectionT: { a: 105.9, b: 229.1, c: 449.4, d: 518.3, e: 648.5, f: 712.4 },
  /**
   * r353 (item fda53352, point 2) — SECTION A'S TWO MEASURED GAPS, WHICH r372 DID NOT DISTURB.
   *
   * Both were bare literals in the drawing code (the heading at 99.5, the first field at 114) and the
   * reporter asked for "breathing room" between them. The measurement CONTRADICTED the complaint, which
   * is why it was worth taking: the agency's own heading→first-field pitch is 13.8 pt (105.9 → 119.7)
   * where ours was 14.5, already the wider of the two. What WAS too tight was the clearance above: our
   * Section A block began 0.6 pt under the banner where the agency leaves 4.0, and two solid black
   * blocks 0.6 pt apart read as one merged block at any print resolution.
   *
   * ⚠️ r353 BOUGHT THAT 4.0 BY MOVING THE BANNER, BECAUSE THE SECTION COULD NOT MOVE. r372 removes the
   * constraint rather than the fix: the banner and Section A are BOTH on the agency's own coordinates
   * now (strip 78.4 → 92.6, letter block 96.6 → 109.8), and the two gaps below are what those absolute
   * positions already imply. They are kept as named constants because they are the agency's own
   * relationships and the r353 guard checks them, not because anything is derived FROM them any more.
   */
  sectionGapUnderBanner: 4.0,
  /** The agency's own heading-baseline → first-field-baseline pitch in Section A (105.9 → 119.7). */
  sectionAFieldPitch: 13.8,
  /** Section A: item 1, then the two-column rows, then item 8's second line and 9(a) / 9(b). */
  rowsA: {
    name: 119.7,
    row2: 133.3,
    row4: 147.5,
    row6: 161.8,
    children: 175.9,
    childrenLine2: 187.6,
    partYear: 175.9,
    startedOn: 190.1,
    leftOn: 204.4,
  },
  /** Section B: its bold sub-heading and the RM over the column, then the agency's thirteen rows. */
  rowsB: {
    excluding: 240.4,
    grossSalary: 254.2,
    feesCommissionBonus: 268.4,
    tipsPerquisitesOther: 282.5,
    taxBorneByEmployer: 296.8,
    esos: 311,
    gratuity: 325.1,
    arrears: 339.4,
    incomeTypeA: 353.6,
    incomeTypeB: 367.7,
    benefitsInKind: 382,
    livingAccommodation: 396.2,
    unapprovedFundRefund: 410.3,
    compensation: 424.6,
  },
  /** Section C, closed by the form's single JUMLAH between two rules. */
  rowsC: { pension: 463.2, annuity: 477.4, totalRuleAbove: 481.8, total: 492.4, totalRuleBelow: 497 },
  rowsD: {
    mtd: 531.7,
    cp38: 544.9,
    zakat: 558.1,
    donations: 571.3,
    tp1Heading: 584.5,
    tp1Relief: 597.7,
    zakatOther: 610.9,
    childRelief: 624.1,
  },
  /** Section E: the fund's name, then its contribution on the row BELOW it, then PERKESO. */
  rowsE: { fundName: 661.8, epf: 675, perkeso: 688.1 },
  /** B.2's two description rules, which carry no money. */
  incomeTypeX: { letter: 154.3, rule: [172.4, 298.9] as const },
  /** Historical agency footer geometry, retained for comparison tests. V6 drawing uses EA_V6_FOOT. */
  officerBox: {
    x0:191,t0:727.5,t1:817.9,
    ruleX:[331.5,556.1] as const,captionX:196.9,
    rowT0:749.1,rowPitch:13.2,employerRules:2,minSize:6,footPad:15.9,
  },
  /** Separate left signing-date column; the latest reporter screenshot puts it outside the officer box. */
  dateX: 45.2,
  dateRule: [62.2, 185] as const,
  /**
   * ⚠️ `footStripT` IS RETIRED IN r372 AND KEPT SO THE NUMBER CAN BE RECOGNISED. It was 742: "where OUR
   * strip starts — the ~110 pt the specimen leaves empty beneath its own foot". r351 removed the strip
   * at the reporter's written instruction and left the amended marker behind on this coordinate; r372
   * put the officer box on the agency's rows, which end at 817.9 — 75 pt PAST 742 — so the marker would
   * have printed inside the box, over the telephone rule, and pdf-lib does not clip. There is no empty
   * band beneath the agency's foot to put it in. Its new home is `amendedNoteT`, ABOVE the box, decided
   * here rather than discovered on a rendered page.
   */
  footStripT: 742,
  /**
   * The amended-statement marker's baseline: 4 pt above the officer box's top rule, in the 11.1 pt band
   * the agency leaves between Section F's row (which ends at 716.4) and the box (727.5). It is OURS —
   * the agency's page has no such line — so it is a departure, and it is named as one above.
   */
  amendedNoteT: 723.5,
  /** The page floor. Nothing may be drawn below it. */
  bottom: 830,
  /** Historical continuation measurement; V6 never creates a continuation page. */
  overflowT: 60,
} as const;

/**
 * THE AGENCY'S OWN WORDS — ONE SET PER LANGUAGE, BECAUSE LHDN PUBLISHES ONE PER LANGUAGE.
 *
 * ⚠️ THIS USED TO BE MALAY IN BOTH LANGUAGES, ON A RATIONALE THE AGENCY ITSELF CONTRADICTS (r346).
 * The old note argued that "the viewer's language never changes a Malaysian tax form", so the masthead,
 * the banner and the officer box were drawn in Malay even on the English EA. But LHDN publishes the
 * C.P.8A in BOTH languages and its English edition has an ENGLISH masthead — "Serial No.",
 * "Employer's No. E", "LHDNM State", "THIS FORM EA MUST BE PREPARED AND PROVIDED TO THE EMPLOYEE FOR
 * INCOME TAX PURPOSE", "Name of Officer". We were not preserving the agency's page; we were printing
 * the Malay edition's furniture around English captions, which is a document LHDN does not issue.
 * The English below is read off `docs/forms/ea-cp8a-pin-2023-official-en.pdf`; the Malay off
 * `docs/forms/ea-cp8a-pin-2023-official-bm.xlsx` (docProps Company=LHDNM). Neither is translated here.
 *
 * ⚠️ `officerName` USED TO READ "Name Pegawai", AND THAT WAS A TYPO WE INHERITED. It came from the
 * DevExpress tracing (item ece6d75d) and a comment here defended it as "the specimen's own spelling".
 * The agency's own BM file says "Nama Pegawai". Corrected in r346 — and it is a small, exact example of
 * why tracing a rival vendor's rendering is not the same as reading the agency's form.
 */
const EA_FORM_WORDS_MS = {
  formNo: '(C.P.8A - Pin. 2023)',
  serialNo: 'No. Siri',
  employerTin: 'No. Majikan E',
  masthead1: 'MALAYSIA',
  masthead2: 'CUKAI PENDAPATAN',
  masthead3: 'PENYATA SARAAN DARIPADA PENGGAJIAN',
  masthead4: 'BAGI TAHUN BERAKHIR 31 DISEMBER',
  privateStatement: 'Penyata Gaji Pekerja SWASTA',
  /** r346 — a SECOND line, because the English edition needs one and the Malay does not. Empty = one line. */
  privateStatement2: '',
  ea: 'EA',
  employeeTin: 'No. Pengenalan Cukai (TIN) Pekerja',
  lhdnState: 'LHDNM Negeri',
  banner: 'BORANG EA INI PERLU DISEDIAKAN UNTUK DISERAHKAN KEPADA PEKERJA BAGI TUJUAN CUKAI PENDAPATAN',
  /** E's second item. The "2." is the form's own numbering, which is structure rather than wording — the
   *  same reason every other item's number rides in its caption. */
  perkeso: '2. PERKESO :',
  rm: 'RM',
  officerName: 'Nama Pegawai',
  officerPosition: 'Jawatan',
  employerNameAddress: 'Nama dan Alamat Majikan',
  employerPhone: 'No. Telefon Majikan',
  date: 'Tarikh:',
} as const;

/** The SAME furniture as LHDN's English edition prints it. Read off the agency PDF, not translated. */
const EA_FORM_WORDS_EN: Record<keyof typeof EA_FORM_WORDS_MS, string> = {
  formNo: '(C.P.8A - Pin. 2023)',
  serialNo: 'Serial No.',
  employerTin: "Employer's No. E",
  masthead1: 'MALAYSIA',
  masthead2: 'INCOME TAX',
  masthead3: 'STATEMENT OF REMUNERATION FROM EMPLOYMENT',
  masthead4: 'FOR THE YEAR ENDED 31 DECEMBER',
  privateStatement: "PRIVATE SECTOR Employee's",
  privateStatement2: 'Statement of Remuneration',
  ea: 'EA',
  employeeTin: "Employee's Tax Identification No. (TIN)",
  lhdnState: 'LHDNM State',
  banner: 'THIS FORM EA MUST BE PREPARED AND PROVIDED TO THE EMPLOYEE FOR INCOME TAX PURPOSE',
  perkeso: '2. SOCSO:',
  rm: 'RM',
  officerName: 'Name of Officer',
  officerPosition: 'Designation',
  employerNameAddress: 'Name and Address of Employer',
  employerPhone: "Employer's Telephone No.",
  date: 'Date:',
} as const;

/**
 * The form's own furniture for ONE language. `locale` is the DOCUMENT's language (the routes allowlist
 * `en` / `ms`), not the viewer's — an employer may need both in the same year from the same session.
 * Anything not `ms` gets the English edition, which is also what the English-only surfaces expect.
 */
export const eaFormWords = (locale: string) => (locale === 'ms' ? EA_FORM_WORDS_MS : EA_FORM_WORDS_EN);

/** Back-compat for callers that predate the split; the Malay edition is what they were getting. */
export const EA_FORM_WORDS = EA_FORM_WORDS_MS;

/**
 * ── THE FORM'S OWN NUMBERING IS STRUCTURE, NOT WORDING (r372, item 795c470c) ───────────────────────
 *
 * The agency sets every numbered line in THREE columns: the item number at 62.5, the sub-item letter
 * at 80.2 and the words at 94.3. Our catalogues carry the number inside the caption — `payroll.ea`
 * `grossSalary` is "1(a) Gross salary, wages or leave pay (including overtime pay)" — and the renderer
 * drew that one string at one x. That is why the item numbers and sub-items sat ~20 pt too far left:
 * there was only ever one column to put them in. This table is where the numbering lives now.
 *
 * ⚠️ THE NUMBER DRAWN IS ALWAYS THIS TABLE'S, NEVER THE STRING'S. `eaCaptionWords` only ever asks a
 * caption to give up a prefix the renderer already composed — it removes "1(a)" from the front because
 * it is about to draw "1." and "(a)" itself, and removes nothing when the caption does not start with
 * it. So a catalogue that numbers differently, or not at all, cannot put a WRONG number on a tax
 * document; the worst it can do is leave its own number in the words, which `test/ea-agency-grid.test.ts`
 * refuses for the two editions that reach this renderer.
 *
 * ⚠️ AND THE PLAN'S REASON FOR DOING THIS THROUGH NEW MESSAGE KEYS WAS WRONG ON THE FACTS, WHICH IS
 * WHY IT IS DONE HERE INSTEAD. The build note said "Do NOT parse the number off the front of a
 * localized string — six locales, and messages/ms.json numbers differently in places." `ms.json`
 * numbers IDENTICALLY to `en.json` on every caption this renderer draws ("1(a) Gaji kasar…",
 * "3. Manfaat berupa barangan"), and en/ms are the only two editions either route renders. The other
 * four locales belong to the HTML statement, which reads these same keys and PRINTS the number — so
 * retiring the combined keys would have changed a screen the item says must not change ("No caption
 * shall change"), in four languages, to fix a column those languages never reach.
 */
export type EaNumbering = {
  /** The form's item number, e.g. "1" or "5". Drawn unless `itemDrawn` is false. */
  item?: string;
  /** The form's sub-item letter, e.g. "(a)". */
  sub?: string;
  /** False where the agency prints the item number ONCE, against its first sub-item only. */
  itemDrawn?: boolean;
};

/** What the C.P.8A numbers each box, by the label key that carries its words. */
export const EA_FORM_NUMBERING = {
  // Section A
  name: { item: '1' },
  jobTitle: { item: '2' },
  employeeNo: { item: '3' },
  icNo: { item: '4' },
  passportNo: { item: '5' },
  epfNo: { item: '6' },
  socsoNo: { item: '7' },
  childrenTaxRelief: { item: '8' },
  partYearNote: { item: '9' },
  startedOn: { item: '9', sub: '(a)', itemDrawn: false },
  leftOn: { item: '9', sub: '(b)', itemDrawn: false },
  // Section B — the agency prints "1." once, against (a) only.
  grossSalary: { item: '1', sub: '(a)' },
  feesCommissionBonus: { item: '1', sub: '(b)', itemDrawn: false },
  tipsPerquisitesOther: { item: '1', sub: '(c)', itemDrawn: false },
  taxBorneByEmployer: { item: '1', sub: '(d)', itemDrawn: false },
  esos: { item: '1', sub: '(e)', itemDrawn: false },
  gratuity: { item: '1', sub: '(f)', itemDrawn: false },
  arrears: { item: '2' },
  benefitsInKind: { item: '3' },
  livingAccommodation: { item: '4' },
  unapprovedFundRefund: { item: '5' },
  compensation: { item: '6' },
  // Section C
  pension: { item: '1' },
  annuity: { item: '2' },
  // Section D — 5(a) and 5(b) likewise carry the sub-letter only.
  monthlyTaxDeduction: { item: '1' },
  cp38Deductions: { item: '2' },
  zakatViaSalary: { item: '3' },
  donations: { item: '4' },
  tp1ClaimHeading: { item: '5' },
  tp1Relief: { item: '5', sub: '(a)', itemDrawn: false },
  zakatOther: { item: '5', sub: '(b)', itemDrawn: false },
  childRelief: { item: '6' },
  // Section E — item 2's lead-in is agency FURNITURE (`perkeso`), not a catalogue caption.
  fundName: { item: '1' },
  perkeso: { item: '2' },
} as const satisfies Record<string, EaNumbering>;

/** Every prefix the renderer would itself compose for `n`, longest first. */
function drawnPrefixes(n: EaNumbering): string[] {
  const out: string[] = [];
  if (n.item && n.sub) out.push(`${n.item}${n.sub}`, `${n.item}.${n.sub}`, `${n.item} ${n.sub}`, `${n.item}. ${n.sub}`);
  if (n.sub) out.push(n.sub);
  if (n.item) out.push(`${n.item}.`, n.item);
  return out.sort((a, b) => b.length - a.length);
}

/**
 * A caption's WORDS: the localized string with the numbering this renderer draws itself removed from
 * the front, if it is there. Exported because the guards that check a caption reached the page have to
 * look for what was DRAWN, and what is drawn is the words without the number.
 */
export function eaCaptionWords(caption: string, n: EaNumbering | undefined): string {
  const s = (caption ?? '').trimStart();
  if (!n) return s;
  for (const prefix of drawnPrefixes(n)) {
    if (s.startsWith(prefix)) return s.slice(prefix.length).replace(/^[\s.:]+/, '');
  }
  return s;
}

export async function renderEaPdf(d: EaPdfData, t: EaPdfLabels, opts: EaRenderOptions = {}): Promise<Uint8Array> {
  /** r220 — see `EaRenderOptions`. Read once, so every suppression below reads off one name. */
  const blank = opts.blank === true;
  const doc = await PDFDocument.create();
  doc.setTitle(d.year ? `${t.title} — ${d.year}` : t.title);
  doc.setProducer('AI HR');
  const first = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const strings: string[] = [];
  const collect = (v: unknown): void => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  collect(d); collect(t); collect(eaFormWords(opts.locale ?? 'en'));
  const faces = await embedPayslipFaces(doc, payslipFaceScripts(strings));
  const operations: (() => void)[] = [];
  const H = A4[1];
  const { left: L, right: R, moneyLeft: MX, moneyRight: MR } = EA_FORM;
  /** The whole measured grid, under one short name, because nearly every draw below reads from it. */
  const A = EA_FORM;
  /** 749.1 + 5 * 13.2 must be 815.1, not 815.0999999999999 — every baseline here is a tenth of a point. */
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const CX = (L + R) / 2;
  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.47);
  const rule = rgb(0.55, 0.55, 0.6);

  /**
   * Helvetica is WinAnsi (Latin-1). Typography is FOLDED rather than dropped (the em dash and the curly
   * apostrophe are outside Latin-1 and would otherwise print our own footnote as "C.P.8A ? bukan
   * borang"); a NAME still degrades to '?', the documented ADR-0036 limitation this file has always
   * carried, with a Unicode font embed as the deferred follow-up.
   */
  const fold = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...');
  const safe = (s: string) => fold(s).replace(/[\r\n\t]+/g, ' ');
  const face = (s: string, requested: PDFFont): PDFFont => {
    const selected = bestFaceFor(safe(s), faces);
    const actual = selected ? (requested === bold ? selected.bold : selected.regular) : requested;
    const chars = new Set(actual.getCharacterSet());
    if ([...safe(s)].some(ch => !chars.has(ch.codePointAt(0)!))) throw new EaLayoutFitError('unsupported text');
    return actual;
  };
  type TextCell = {left:number;right:number;top:number;bottom:number};
  const rowCell = (x:number,right:number,tt:number):TextCell => ({left:x,right,top:tt-10,bottom:tt+4});
  const drawText = (s: string, x: number, tt: number, size: number, requested: PDFFont, color = ink, cell?:TextCell) => {
    const actual = face(s, requested); const value = safe(s);
    const ascent = actual.heightAtSize(size,{descender:false});
    const descent = actual.heightAtSize(size)-ascent;
    const right = x+actual.widthOfTextAtSize(value,size);
    const bounds = cell ?? {left:0,right:tt>=88?R:A4[0],top:0,bottom:A.bottom};
    if (size < EA_READABLE_FONT_FLOOR || x < bounds.left-0.001 || right > bounds.right+0.001 || tt-ascent < bounds.top-0.001 || tt+descent > bounds.bottom+0.001) throw new EaLayoutFitError('page content');
    operations.push(() => page.drawText(value, {x, y: H-tt, size, font: actual, color}));
  };

  /** A money figure as the form prints it: NO "RM" prefix — the column has one bold RM heading, and
   *  D5/E/F print their own RM immediately before their rule. */
  const amt = (n: number) =>
    (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** …and with it, for the one line that is OURS rather than the form's (see the EIS note below). */
  const rm = (n: number) => `RM ${amt(n)}`;

  /**
   * ⚠️ A BOX THAT PRINTS 0.00 MAKES A CLAIM; AN ABSENT FIGURE MAKES NONE — AGENTS 28, and r209 shipped
   * exactly the opposite defect on THIS form.
   *
   * `derived` is for a figure payroll produces: it prints even at 0.00, because there a zero is a fact
   * we can stand behind ("you were paid no bonus"). `manual` is for a box whose ONLY source is an
   * `ea_override` HR has keyed — nothing in payroll can derive it: `payslip` persists only aggregate
   * scalars (basic_salary / allowance / overtime_pay / bonus / gross_pay + a statutory jsonb), there is
   * no payslip-line table anywhere in db/schema.ts, and core/payroll.ts folds every earning component
   * into `payslip.allowance` before the row is written.
   *
   * ⚠️ THAT ENUMERATION IS ABOUT PAYSLIP **COLUMNS**, AND IT MISSED THE `statutory` JSONB. r351 found the
   * annual child-relief ringgit already stamped there as `pcbMeta.reliefs.children` — the figure the
   * kernel actually netted off P — and D.6 is now sourced from it. A box being absent from the columns
   * is not proof that payroll cannot derive it; look in the snapshot before concluding a box is manual. Printing those as a derived 0.00 asserted that
   * money does not exist while the same money was printed two lines up under Allowances: a director paid
   * RM 4,000/month of commission got "Fees (incl. director's fees) RM 0.00" on a C.P.8A.
   *
   * On the redrawn form an unset manual box is not an ABSENT LINE — the caption and its rule are printed
   * exactly as the blank form prints them, and the rule is simply empty. That is the blank the agency's
   * own page carries, and it asserts nothing at all.
   */
  const derived = (n: number): string => amt(n);
  const manual = (n: number): string => (Math.round((Number(n) || 0) * 100) !== 0 ? amt(n) : '');
  /**
   * ⚠️ A BOX THAT IS ONE AGENCY BOX OVER TWO OF OUR FIGURES, ONE DERIVED AND ONE NOT — 1(b) and 1(c).
   *
   * The form's 1(b) is "Fi (termasuk fi pengarah), komisen atau bonus": our `bonus` is payroll-derived,
   * our `directorFee` has no payroll source at all and only an `ea_override` can supply it. Printing the
   * SUM through `derived` prints 0.00 for an ordinary salary-only employee — which asserts "no fees, no
   * director's fees, no commission", and the second half of that we cannot stand behind. It is r209's
   * defect wearing the agency's own caption, which makes it read MORE authoritative, not less.
   *
   * So a mixed box prints only when it has something to say, exactly like a manual one. A non-zero sum
   * is still printed in full: it is at least the derived half, and it is what HR has recorded.
   */
  const mixed = (derivedPart: number, manualPart: number): string => manual((Number(derivedPart) || 0) + (Number(manualPart) || 0));

  /** 'YYYY-MM-DD' → 'DD/MM/YYYY', which is how a Malaysian form is dated. Anything else passes through. */
  const formDate = (iso: string | null): string =>
    iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';

  // ── Drawing primitives, all in TOP-DOWN coordinates ────────────────────────────────────────────────
  let page = first;
  const at = (tt: number) => H - tt;
  const put = (s: string, x: number, tt: number, size: number, f: PDFFont = font, color = ink) => drawText(s,x,tt,size,f,color);
  const putR = (s: string, xr: number, tt: number, size: number, f: PDFFont = font, color = ink) => drawText(s,xr-face(s,f).widthOfTextAtSize(safe(s),size),tt,size,f,color);
  const putC = (s: string, cx: number, tt: number, size: number, f: PDFFont = font, color = ink) => drawText(s,cx-face(s,f).widthOfTextAtSize(safe(s),size)/2,tt,size,f,color);
  const hRule = (x0: number, x1: number, tt: number, thickness = 0.8, color = rule) =>
    operations.push(() => page.drawLine({ start: { x: x0, y: at(tt) }, end: { x: x1, y: at(tt) }, thickness, color }));
  const box = (x0: number, t0: number, x1: number, t1: number, thickness = 0.8) =>
    operations.push(() => page.drawRectangle({ x: x0, y: at(t1), width: x1 - x0, height: t1 - t0, borderColor: rule, borderWidth: thickness }));
  /**
   * A SOLID BLACK BLOCK — the agency's own device, and the thing that made our page read as a different
   * document (item fda53352, r349). LHDN sets its section letters, its banner and its top-right heading
   * filled black with WHITE lettering; we drew plain text inside an outline, and the reporter's red-boxed
   * comparison marked every one of them.
   *
   * ⚠️ THE FILL IS DRAWN FIRST AND THE TEXT SECOND. Reversed out of order the caption is painted over and
   * the block renders as an empty black rectangle — which still returns 200, still downloads, and is
   * exactly the class of defect that reached the reporter twice already. `test/…-chrome…` asserts a white
   * caption exists for every fill.
   */
  const fill = (x0: number, t0: number, x1: number, t1: number) =>
    operations.push(() => page.drawRectangle({ x: x0, y: at(t1), width: x1 - x0, height: t1 - t0, color: ink }));
  const white = rgb(1, 1, 1);
  /** The dotted rule the specimen writes every value on. */
  const dotted = (x0: number, x1: number, tt: number) => {
    for (let x = x0; x < x1; x += 3) {
      operations.push(() => page.drawLine({ start: { x, y: at(tt) }, end: { x: Math.min(x + 1.4, x1), y: at(tt) }, thickness: 0.5, color: rule }));
    }
  };

  /**
   * SHRINK TO FIT, NEVER CLIP AND NEVER OVERPRINT — r205's Borang A lesson, and it is what makes ONE
   * renderer safe for two languages on a fixed-geometry form: an English caption is routinely wider than
   * its Malay original, and pdf-lib does not clip. Truncating instead would be worse, not better — a
   * clean truncation READS AS THE CAPTION. The size comes down, rounded DOWN to 0.1 pt so the drawn
   * string stays inside `maxW`. The readable floor and actual vertical metrics are checked before drawing.
   */
  const fitSize = (v: string, maxW: number, size: number, f: PDFFont) => {
    const w = face(v,f).widthOfTextAtSize(v, size);
    if (w <= maxW || w <= 0) return size;
    return Math.floor((size * maxW * 10) / w) / 10;
  };
  /** Returns the x the drawn string ENDS at, so the next run (a cue word, an inline rule) can start from
   *  what was actually drawn rather than from a guess at its width. */
  /** Fit only within the readable floor; refuse the complete plan rather than overprint. */
  const putFit = (s: string, x: number, maxW: number, tt: number, size: number, f: PDFFont = font, color = ink, minSize = EA_READABLE_FONT_FLOOR) => {
    const v = safe(s);
    const fitted = fitSize(v, maxW, size, f);
    const actual = face(v,f);
    const ascent = actual.heightAtSize(fitted,{descender:false});
    const descent = actual.heightAtSize(fitted)-ascent;
    const verticalFit = tt>=88 ? Math.min(1,10/ascent,descent>0?4/descent:1) : 1;
    const sz = verticalFit<1 ? Math.floor(fitted*verticalFit*10)/10 : fitted;
    if (sz < minSize) throw new EaLayoutFitError(tt < 88 ? 'header' : tt < 230 ? 'employee details' : tt < 489 ? 'employment income' : tt < 530 ? 'pension and annuity' : tt < 652 ? 'deductions' : tt < 727 ? 'contributions and exemptions' : 'employer and authorised officer');
    drawText(v,x,tt,sz,f,color,tt>=88?rowCell(x,x+maxW,tt):{left:x,right:x+maxW,top:0,bottom:88});
    return x + face(v,f).widthOfTextAtSize(v,sz);
  };

  /** Greedy word-wrap at `size`, so the footnote strip can be MEASURED before it is placed. */
  const wrapped = (s: string, size: number, maxW: number, f: PDFFont = font) => {
    const out: string[] = [];
    let line = '';
    const actual = face(s,f);
    const words = safe(s).split(/\s+/).flatMap(word => { const chunks: string[] = []; let chunk = ''; for(const ch of word) {if(actual.widthOfTextAtSize(chunk+ch,size)>maxW && chunk){chunks.push(chunk);chunk='';}chunk+=ch;} if(chunk)chunks.push(chunk);return chunks; });
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (actual.widthOfTextAtSize(trial, size) > maxW && line) {
        out.push(line);
        line = w;
      } else line = trial;
    }
    if (line) out.push(line);
    return out;
  };

  /**
   * A VALUE, OR THE RULE THE BLANK FORM PRINTS INSTEAD OF ONE (AGENTS 28).
   *
   * Never a placeholder, never "0.00" standing in for "we do not know". A figure the form derives is
   * printed; a box that is the operator's to complete, or one nothing in this system can source, gets
   * the dotted rule and nothing else — an empty rule asserts nothing, while a printed zero asserts that
   * the money does not exist.
   */
  const valueOrRule = (v: string, x0: number, x1: number, tt: number, size = 7.5, minSize = EA_READABLE_FONT_FLOOR) => {
    dotted(x0, x1, tt + 2.5);
    if (v) putFit(v, x0 + 3, x1 - x0 - 6, tt, size, font, ink, minSize);
  };
  /**
   * The same, right-aligned — which is how every amount on this form sits on its rule.
   *
   * ⚠️ r220 — THIS IS THE ONE PLACE THE MONEY COLUMN IS SUPPRESSED ON A BLANK FORM, and it is deliberately
   * the choke point rather than fifty call sites: every amount the C.P.8A prints (B's column, C's, D's,
   * D5's mid-page pair, E's two contributions and F's single line) arrives here. On a blank the rule is
   * still drawn — the agency's page has it — and nothing is written on it. `derived()` and `manual()` are
   * untouched, because what they decide (is this a figure we can stand behind?) is a different question
   * from whether ANY figure belongs on this page at all.
   *
   * The two amounts that do NOT come through here — the JUMLAH and the EIS line in our own strip — are
   * suppressed explicitly at their own sites, each with a note saying so.
   */
  const amountOrRule = (value: string, x0: number, x1: number, tt: number, size = 8) => {
    const v = blank ? '' : value;
    dotted(x0, x1, tt + 2.5);
    if (v) {
      const s = safe(v);
      const sz = fitSize(s, x1 - x0 - 4, size, font);
      if (sz < EA_READABLE_FONT_FLOOR) throw new EaLayoutFitError('amount column');
      putR(s,x1-2,tt,sz);
    }
  };
  /** One numbered money line: the caption at `x`, its amount on the RM column's rule. */
  const moneyLine = (caption: string, x: number, tt: number, value: string, size = 8) => {
    putFit(caption, x, MX - x - 14, tt, size);
    amountOrRule(value, MX, MR, tt);
  };
  /** A caption, then the form's own cue word in brackets and an inline dotted rule for a description the
   *  agency asks for and this system does not hold. The rule stays empty — writing a description we do
   *  not have is inventing a fact about somebody's pay. */
  /**
   * ⚠️ r353 (item fda53352, point 4) — `ruleTo` IS NO LONGER THE CALLER'S TO GET WRONG, AND IT WAS.
   *
   * All three callers (B.1(c), B.3, B.4) passed the literal 481, which predates r346 moving the money
   * column to `EA_FORM.moneyLeft` = 482.3. The closing bracket lands at `ruleTo + 2` = 483 and its glyph
   * runs ~2.7 pt beyond that, so it printed INSIDE the money column, over the first digit of the amount,
   * on three lines of every filled form in both editions. pdf-lib does not clip and the page still
   * rendered, still returned 200 and still downloaded — the r205 Borang A failure mode exactly.
   *
   * The rule now ends `EA_FORM.inlineRuleGap` short of the column by default, so the bracket cannot cross
   * it, and a caller that overrides `ruleTo` is refused rather than trusted: the assertion is cheap, runs
   * on every render and cannot be forgotten the way a comment can. `test/ea-pdf.test.ts` measures the
   * DRAWN bracket against `moneyLeft` as well, because this arithmetic is only as good as its estimate
   * of the glyph.
   */
  const CLOSE_BRACKET_OFFSET = 2;
  const captionWithInlineRule = (
    caption: string,
    cue: string,
    x: number,
    tt: number,
    ruleTo: number = MX - EA_FORM.inlineRuleGap,
    size = 8,
  ) => {
    const bracketEnd = ruleTo + CLOSE_BRACKET_OFFSET + font.widthOfTextAtSize(')', size);
    if (bracketEnd > MX) {
      throw new Error(
        `ea-pdf: an inline description rule ending at ${ruleTo} puts its ')' at ${bracketEnd.toFixed(1)}, ` +
          `inside the money column (moneyLeft ${MX}). Widen EA_FORM.inlineRuleGap instead of moving one caller.`,
      );
    }
    const capEnd = putFit(caption, x, 300, tt, size);
    const cueEnd = putFit(`(${cue}`, capEnd + 4, 140, tt, size);
    dotted(cueEnd + 3, ruleTo, tt + 2.5);
    put(')', ruleTo + CLOSE_BRACKET_OFFSET, tt, size);
  };

  /**
   * ONE SECTION HEADING: the letter in a filled black block, the title beside it (r349).
   *
   * The label carries its own letter ("A  PARTICULARS OF EMPLOYEE") because the form's numbering is part
   * of its wording — `lib/ea-field-register.ts` matches on it and the six catalogues own it. So the
   * letter is SPLIT OFF here rather than removed from the catalogues, which would have made the register
   * and the page disagree about what the form says.
   *
   * ⚠️ r372 — THE BLOCK AND THE TITLE ARE BOTH ON THE AGENCY'S COLUMNS NOW, AND THE REASON RECORDED FOR
   * THE OLD POSITION WAS FALSE. What stood here, quoted so the claim can be recognised if it resurfaces:
   *
   *     "The agency puts its square at x 39.8, its own body column. Ours goes at `L` (24), because
   *      EA_FORM.left is already a deliberate departure — the agency's rules start 16.8 pt from the
   *      paper edge, inside the unprintable margin of most office printers. The square's SIZE is the
   *      agency's (17.3 pt wide, measured off its page); its POSITION is ours."
   *
   * It asserted the agency starts at 16.8 pt three words after correctly recording that it starts at
   * 39.8. 16.8 was the DevExpress TRACING's left edge. The block is now the agency's cell exactly —
   * 39.8 → 57.1, 13.2 pt tall, the caption's baseline 9.3 pt below its top — and the title sits in the
   * agency's own 62.5 column, which is the same column its item numbers sit in.
   */
  const sectionHeading = (label: string, tt: number) => {
    const m = /^\s*([A-F])\s+(.*)$/.exec(label);
    // A label that does not start with a lone section letter is drawn whole, unboxed — a locale that
    // reorders it must not silently lose its title.
    if (!m) return putFit(label, A.itemLabel, R - A.itemLabel, tt, 8.5, bold);
    const [, letter, title] = m;
    fill(A.left, tt - A.letterBlockAscent, A.left + A.letterBlockW, tt + A.letterBlockDescent);
    putC(letter, A.left + A.letterBlockW / 2, tt, 8.5, bold, white);
    return putFit(title, A.itemLabel, R - A.itemLabel, tt, 8.5, bold);
  };

  /**
   * Draw a numbered line's number and sub-letter in the agency's own columns and return the x its WORDS
   * start at — 94.3 under a sub-letter, 80.2 under a bare item number, and the caller's own column where
   * the agency indents differently (D5's sub-items sit at 98.2).
   */
  const N = EA_FORM_NUMBERING;
  const numbering = (n: EaNumbering, tt: number, size = 8, textX?: number): number => {
    if (n.item && n.itemDrawn !== false) put(`${n.item}.`, A.itemLabel, tt, size);
    if (n.sub) put(n.sub, A.subLabel, tt, size);
    return textX ?? (n.sub ? A.subText : A.subLabel);
  };
  // Separate value rows retain the agency's complete name-and-address caption.
  const W = eaFormWords(opts.locale ?? 'en');

  // ── THE HEADER BAND — three blocks and the ruled banner under them ──────────────────────────────────
  //
  // r372 — every baseline AND every size here is the agency's own (`--all`): the form number and
  // MALAYSIA on 31.4 at 8 pt, INCOME TAX on 46.2 at 12, the long masthead line on 60.2 at 8 and the
  // year line on 73 at 8.
  //
  // ⚠️ THE SIZES WERE OURS (9.5 / 13.5 / 9 / 9) AND THAT WAS NOT A HARMLESS DEPARTURE. At 9 pt
  // "STATEMENT OF REMUNERATION FROM EMPLOYMENT" is 235 pt wide centred on the page, so it ended at
  // 415.9 — and the employee's TIN is written from 418.8. On the rasterised page the masthead ran
  // straight into the tax number. pdf-lib does not clip. The agency's own 8 pt clears it by 11 pt, and
  // the only reason the collision was reachable at all is that the header band had never been measured.
  // INCOME TAX keeps its BOLD face, which is ours; its size is the agency's.
  const HT = A.headerT;
  const HX = A.headerX;
  put(W.formNo, L, HT.formNo, 7.5);
  putC(W.masthead1, CX, HT.masthead1, 8);
  putC(W.masthead2, CX, HT.masthead2, 12, bold);
  putC(W.masthead3, CX, HT.masthead3, 8);
  // r220 — `.trim()` is what the BLANK form needs and what a filled one never notices: the year of
  // assessment is completed on the agency's line, so with no year there is nothing to complete and the
  // line is the agency's own caption, exactly as the specimen prints it.
  putC(`${W.masthead4} ${d.year}`.trim(), CX, HT.masthead4, 8);

  // LEFT: No. Siri has NO source in this system and never will — it is the employer's own running number
  // for the statements it issues — so it prints the blank form's rule, which is what the agency's page
  // carries there. Both captions sit in the body table's own left column (39.8), where the agency puts
  // them: r372's fixed parser is what made "Employer's" visible at all — it is set in a subset font as
  // hex inside a TJ array, and the old parser dropped it, so this row read as starting at "No.".
  put(W.serialNo, HX.leftLabel, HT.serialNo, 7.5);
  // The rules STOP at 188, short of the centred masthead: "STATEMENT OF REMUNERATION FROM EMPLOYMENT"
  // is centred on CX one baseline away (191.9 at 8 pt, in the wider of the two editions), and a rule
  // run any further crosses it. The agency's own leaders run to ~275 because its own masthead sits at
  // a different baseline; this end is a CLEARANCE, not a column, which is why it is not the agency's.
  valueOrRule('', HX.leftRule[0], HX.leftRule[1], HT.serialNo);
  put(W.employerTin, HX.leftLabel, HT.employerNo, 7.5);
  valueOrRule(d.employer.eNumber ?? '', HX.leftRule[0], HX.leftRule[1], HT.employerNo);

  // RIGHT: the "EA" is the largest type on the page, and the employee's own TIN sits under it.
  const eaW = bold.widthOfTextAtSize(W.ea, 17);
  // ⚠️ TWO LINES WHEN THE EDITION NEEDS TWO. The agency's English sets this in a two-line box where the
  // Malay uses one, and the English string is 96pt wider: drawn on a single line it runs left out of its
  // own block and straight through the centred "MALAYSIA". pdf-lib does not clip, so the page still
  // renders and still downloads — the r205 Borang A lesson, and it was live in r346 until the blank form
  // was rasterised and looked at. A caption is not proven by a green test.
  // r349 — the agency sets this in a filled black block too; r372 measured it: x 399.1 → 527, tt 18.3 →
  // 37.6, its two English lines LEFT-aligned at 405.1 on baselines 26.2 and 35.2. ⚠️ THE BLOCK SIZES TO
  // THE EDITION, never to a constant: English runs two lines and Malay one, so a fixed rectangle leaves
  // the Malay page with a half-empty black box. It also may never reach the "EA" to its right.
  {
    const lines = W.privateStatement2 ? [W.privateStatement, W.privateStatement2] : [W.privateStatement];
    const two = lines.length > 1;
    const size = two ? 8 : 8.5;
    const widest = Math.max(...lines.map((l) => bold.widthOfTextAtSize(safe(l), size)));
    const x0 = HX.privateBlock[0];
    const pad = HX.privateText - x0;
    const x1 = Math.min(R - eaW - 6, Math.max(HX.privateBlock[1], HX.privateText + widest + pad));
    const [t0, t1] = two ? HT.privateBlock : [HT.privateBlock[0] + 3.7, HT.privateBlock[1] - 2.7];
    fill(x0, t0, x1, t1);
    lines.forEach((l, i) =>
      putFit(l, HX.privateText, x1 - HX.privateText - 2, two ? HT.privateLine[i] : 31.5, size, bold, white),
    );
  }
  putR(W.ea, R, HT.ea, 17, bold);
  // The agency LEFT-aligns the employee's TIN caption in its own column and rules it on the line below.
  putFit(W.employeeTin, HX.rightLabel, R - HX.rightLabel, HT.employeeTin, 7.5);
  valueOrRule(d.employee.taxNo ?? '', HX.tinRule[0], HX.tinRule[1], HT.employeeTinRule);
  put(W.lhdnState, 399.1, HT.lhdnState, 6);
  valueOrRule(d.employer.lhdnState ?? '', HX.stateRule[0], HX.stateRule[1], HT.lhdnState);

  // r349 — SOLID, WHITE-ON-BLACK, as the agency prints it; r372 put it on the agency's own strip
  // (tt 78.4 → 92.6, measured) with its caption's baseline at 88.6 inside it. The agency spans 40.3 →
  // 555.6 and we span L → R, which is the same edge to within half a point now that L is the agency's.
  // The 8 pt caption is ours: the agency sets 9 pt, and the Malay banner is 13 characters longer than
  // the English and would not clear the strip at 9.
  fill(L, A.bannerT[0], R, A.bannerT[1]);
  putC(W.banner, CX, A.bannerCaptionT, 8, bold, white);

  // ── A — BUTIRAN PEKERJA ────────────────────────────────────────────────────────────────────────────
  sectionHeading(t.sectionAEmployeeParticulars, A.sectionT.a);

  /** Item 1 spans the agency's whole table width (its cell is 74.8 → 556.6), so it is not an `aRow`. */
  {
    const n: EaNumbering = N.name;
    const x = numbering(n, A.rowsA.name, 7.5);
    putFit(eaCaptionWords(t.name, n), x, A.aNameRule[0] - x - 4, A.rowsA.name, 7.5);
    valueOrRule(d.employee.name, A.aNameRule[0], A.aNameRule[1], A.rowsA.name);
  }

  /** One two-column Section A row: item on the left, item on the right, each numbered and ruled. */
  const aRow = (
    tt: number,
    left: EaNumbering,
    leftLabel: string,
    leftValue: string,
    right: EaNumbering,
    rightLabel: string,
    rightValue: string,
  ) => {
    put(`${left.item}.`, A.itemLabel, tt, 7.5);
    putFit(eaCaptionWords(leftLabel, left), A.aLeftLabel, A.aLeftRule[0] - A.aLeftLabel - 4, tt, 7.5);
    valueOrRule(leftValue, A.aLeftRule[0], A.aLeftRule[1], tt);
    put(`${right.item}.`, A.aRightNumber, tt, 7.5);
    putFit(eaCaptionWords(rightLabel, right), A.aRightLabel, A.aRightRule[0] - A.aRightLabel - 4, tt, 7.5);
    valueOrRule(rightValue, A.aRightRule[0], A.aRightRule[1], tt);
  };
  aRow(A.rowsA.row2, N.jobTitle, t.jobTitle, d.employee.jobTitle ?? '', N.employeeNo, t.employeeNo, d.employee.employeeNo ?? '');
  aRow(A.rowsA.row4, N.icNo, t.icNo, d.employee.ic ?? '', N.passportNo, t.passportNo, d.employee.passport ?? '');
  aRow(A.rowsA.row6, N.epfNo, t.epfNo, d.employee.epfNo ?? '', N.socsoNo, t.socsoNo, d.employee.socsoNo ?? '');

  // Item 8's caption wraps to a second line on the agency's form, and its rule sits on that second line
  // (measured: caption 80.2 on tt 175.9 and 187.6, rule 174.1 → 298.9 on the second).
  {
    const n: EaNumbering = N.childrenTaxRelief;
    put(`${n.item}.`, A.itemLabel, A.rowsA.children, 7.5);
    const childLines = wrapped(eaCaptionWords(t.childrenTaxRelief, n), 7.5, A.aChildrenRule[0] - A.aLeftLabel - 4);
    if (childLines.length > 2) throw new EaLayoutFitError('employee details');
    childLines.forEach((line, i) => put(line, A.aLeftLabel, i ? A.rowsA.childrenLine2 : A.rowsA.children, 7.5));
    // r220 — a COUNT, not an amount, so it does not pass through `amountOrRule` and has to say for itself
    // that a blank form carries no number here. `String(0)` is "0", and "0 children qualifying for tax
    // relief" is a claim about a person the blank form does not have.
    //
    // r364 — THE EXPRESSION IS UNCHANGED AND ITS REASON IS NOT. r359 read the `== null` arm as "absent
    // because D.6 is absent — the two boxes are one fact". It now means UNRECORDED: no statutory row, or
    // a null `num_children` in a mode that reads it. Nothing about D.6 reaches this box any more.
    valueOrRule(
      blank || d.employee.children == null ? '' : String(d.employee.children),
      A.aChildrenRule[0],
      A.aChildrenRule[1],
      A.rowsA.childrenLine2,
    );
  }

  /**
   * ⚠️ ITEM 9 IS CONDITIONAL ON THE YEAR, NOT ON A DATE EXISTING — and that distinction is the whole
   * defect r219 fixed.
   *
   * The form says "Jika bekerja tidak genap setahun, nyatakan:" — state these ONLY if the employment did
   * not run the whole year. Until r219 the renderer printed `hiredOn → terminatedOn` whenever either was
   * present, so somebody hired in 2019 carried a start date on their 2026 EA, which reads as "this person
   * started work in 2019 during the year of assessment 2026".
   *
   * So each half is printed only when ITS OWN date falls inside the selected tax year, and each half is
   * decided on its own: a leaver hired years ago shows a leaving date and an empty commencement rule.
   * The captions and their rules are printed either way, because the blank form prints them either way —
   * a person who worked the whole year gets two empty rules, which is what the agency's page looks like.
   */
  const inYear = (iso: string | null) => (iso && iso.slice(0, 4) === d.year ? formDate(iso) : '');
  {
    const n: EaNumbering = N.partYearNote;
    put(`${n.item}.`, A.aRightNumber, A.rowsA.partYear, 7.5);
    putFit(eaCaptionWords(t.partYearNote, n), A.aRightLabel, R - A.aRightLabel, A.rowsA.partYear, 7.5);
    const aSub = (sub: string, caption: string, tt: number, value: string) => {
      put(sub, A.aRightLabel, tt, 7.5);
      putFit(
        eaCaptionWords(caption, sub === '(a)' ? N.startedOn : N.leftOn),
        A.aRightSubLabel,
        A.aRightRule[0] - A.aRightSubLabel - 4,
        tt,
        7.5,
      );
      valueOrRule(value, A.aRightRule[0], A.aRightRule[1], tt);
    };
    aSub('(a)', t.startedOn, A.rowsA.startedOn, inYear(d.employee.hiredOn));
    aSub('(b)', t.leftOn, A.rowsA.leftOn, inYear(d.employee.terminatedOn));
  }

  // ── B — PENDAPATAN PENGGAJIAN, MANFAAT DAN TEMPAT KEDIAMAN ─────────────────────────────────────────
  sectionHeading(t.sectionBEmploymentIncome, A.sectionT.b);
  putFit(t.sectionBExcluding, A.itemLabel, A.rmHeading - A.itemLabel - 10, A.rowsB.excluding, 7.5, bold);
  // The bold RM heading, printed ONCE for the whole form, over the right-hand column — at the agency's
  // own 511.7 rather than centred on a column of our choosing.
  put(W.rm, A.rmHeading, A.rowsB.excluding, 9, bold);

  /** One numbered money line, drawn in the agency's three columns with its amount on the RM rule. */
  const itemLine = (n: EaNumbering, caption: string, tt: number, value: string, size = 8) => {
    const x = numbering(n, tt, size);
    putFit(eaCaptionWords(caption, n), x, MX - x - 14, tt, size);
    amountOrRule(value, MX, MR, tt);
  };

  itemLine(N.grossSalary, t.grossSalary, A.rowsB.grossSalary, derived(d.partB.grossSalary));
  // 1(b) and 1(c) are ONE box each on the agency's form over TWO of our figures. The form's own captions
  // say so — "Fi (termasuk fi pengarah), komisen atau bonus" and "Tip kasar, perkuisit, penerimaan sagu
  // hati atau elaun-elaun lain" — so the box carries the sum, and printing only half of it would leave
  // taxable money off the line the agency asks for it on. The finer split stays visible where it is
  // useful: the HTML statement and the amend panel keep a row each.
  //
  // ⚠️ AND THE AGENCY PRINTS "1." ONCE, against (a) only — `itemDrawn: false` is that, not a shortcut.
  itemLine(
    N.feesCommissionBonus,
    t.feesCommissionBonus,
    A.rowsB.feesCommissionBonus,
    mixed(d.partB.bonus, d.partB.directorFee),
  );
  {
    const n: EaNumbering = N.tipsPerquisitesOther;
    const x = numbering(n, A.rowsB.tipsPerquisitesOther);
    captionWithInlineRule(eaCaptionWords(t.tipsPerquisitesOther, n), t.paymentDetail, x, A.rowsB.tipsPerquisitesOther);
    amountOrRule(mixed(d.partB.allowances, d.partB.tipsPerquisites), MX, MR, A.rowsB.tipsPerquisitesOther);
  }
  itemLine(
    N.taxBorneByEmployer,
    t.taxBorneByEmployer,
    A.rowsB.taxBorneByEmployer,
    manual(d.partB.taxBorneByEmployer),
  );
  itemLine(N.esos, t.esos, A.rowsB.esos, manual(d.partB.esos));
  // 1(f) — "Ganjaran bagi tempoh dari … hingga …". The period is not a fact this system holds, so both
  // rules stay empty; the AMOUNT is a manual box like the rest.
  //
  // ⚠️ THE TWO PERIOD RULES FLOW FROM THE CAPTION RATHER THAN SITTING ON A COLUMN, AND THAT IS
  // DELIBERATE. The agency's own leaders start at 192.3 and 307.9, but they follow ITS caption and ITS
  // "to"; ours are a different length in each of two editions, so an absolute start would overprint the
  // words in one of them. They are description rules, not a column — the columns this round measured are
  // the ones the caption itself sits on, and those ARE absolute.
  {
    const n: EaNumbering = N.gratuity;
    const x = numbering(n, A.rowsB.gratuity);
    const cap = putFit(eaCaptionWords(t.gratuity, n), x, 200, A.rowsB.gratuity, 8);
    const from = putFit(t.periodFrom, cap + 4, 40, A.rowsB.gratuity, 8);
    dotted(from + 4, from + 92, A.rowsB.gratuity + 2.5);
    const to = putFit(t.periodTo, from + 98, 40, A.rowsB.gratuity, 8);
    dotted(to + 4, Math.min(to + 92, MX - A.inlineRuleGap), A.rowsB.gratuity + 2.5);
    amountOrRule(manual(d.partB.gratuity), MX, MR, A.rowsB.gratuity);
  }
  // Item 2 — the caption, then "Jenis pendapatan (a) …/(b) …" beneath it. The two description rules carry
  // no money; the amount belongs to item 2 and sits on the (b) line, exactly as the agency sets it
  // (measured: "(a)" and "(b)" at 154.3, their leaders from 172.4, the money on the (b) row).
  // ⚠️ ITS OWN ROW CARRIES NO MONEY RULE. The agency's leader on this row is absent and reappears on
  // the (b) line below — `--all` shows nothing at 487.7 on tt 339.4 and a leader at 487.7 on 367.7.
  {
    const n: EaNumbering = N.arrears;
    const x = numbering(n, A.rowsB.arrears);
    putFit(eaCaptionWords(t.arrears, n), x, MX - x - 14, A.rowsB.arrears, 8);
  }
  putFit(t.incomeType, A.subLabel, A.incomeTypeX.letter - A.subLabel - 4, A.rowsB.incomeTypeA, 8);
  put('(a)', A.incomeTypeX.letter, A.rowsB.incomeTypeA, 8);
  dotted(A.incomeTypeX.rule[0], A.incomeTypeX.rule[1], A.rowsB.incomeTypeA + 2.5);
  put('(b)', A.incomeTypeX.letter, A.rowsB.incomeTypeB, 8);
  dotted(A.incomeTypeX.rule[0], A.incomeTypeX.rule[1], A.rowsB.incomeTypeB + 2.5);
  amountOrRule(manual(d.partB.arrears), MX, MR, A.rowsB.incomeTypeB);
  {
    const n: EaNumbering = N.benefitsInKind;
    const x = numbering(n, A.rowsB.benefitsInKind);
    captionWithInlineRule(eaCaptionWords(t.benefitsInKind, n), t.stateWhat, x, A.rowsB.benefitsInKind);
    amountOrRule(manual(d.partB.benefitsInKind), MX, MR, A.rowsB.benefitsInKind);
  }
  {
    const n: EaNumbering = N.livingAccommodation;
    const x = numbering(n, A.rowsB.livingAccommodation);
    captionWithInlineRule(eaCaptionWords(t.livingAccommodation, n), t.addressCue, x, A.rowsB.livingAccommodation);
    amountOrRule(manual(d.partB.livingAccommodation), MX, MR, A.rowsB.livingAccommodation);
  }
  itemLine(N.unapprovedFundRefund, t.unapprovedFundRefund, A.rowsB.unapprovedFundRefund, manual(d.partB.unapprovedFundRefund));
  itemLine(N.compensation, t.compensation, A.rowsB.compensation, manual(d.partB.compensation));

  // ── C — PENCEN DAN LAIN-LAIN, closed by the form's single JUMLAH ───────────────────────────────────
  sectionHeading(t.sectionCPensionOther, A.sectionT.c);
  itemLine(N.pension, t.pension, A.rowsC.pension, manual(d.partC.pension));
  itemLine(N.annuity, t.annuity, A.rowsC.annuity, manual(d.partC.annuity));
  /**
   * THE JUMLAH TOTALS B AND C TOGETHER, and it is the ONLY total the form has.
   *
   * The transcription says so and the agency's page shows it: one bold JUMLAH at the foot of Section C,
   * closed with a DOUBLE rule rather than a dotted one. Our own layout carried two subtotals — one for
   * Part B and one for Part C — and the agency's page has neither. `partB.gross` is the sum of the
   * printed Part B lines (EA_PART_B_COMPONENTS, recomputed after any override) and `partC.total` is
   * pension + annuity, so this is those two figures added, not a third arithmetic.
   *
   * ⚠️ r372 — IT SITS IN THE SUB-ITEM COLUMN, NOT THE ITEM-NUMBER COLUMN, AND THE ITEM WE RAISED SAID
   * OTHERWISE. The raised text said "In Section C, TOTAL sits in the item-number column, where the
   * agency puts it in the DESCRIPTION column". `--all` puts it at x 80.5 — the SUB-ITEM column (80.2,
   * plus the bold face's own side bearing), not the description column (94.3). Both the complaint and
   * its stated remedy were wrong about which column; the measurement is what this draws on.
   *
   * The agency's two rules sit at 481.8 and 497 with the total's baseline at 492.4 between them, which
   * is what is drawn here. (The agency also rules its own letter column, 40 → 57.1, on both lines; that
   * is not drawn, because "no box shall be added" and our letter column carries nothing to close.)
   */
  putFit(t.formTotal, A.subLabel, 200, A.rowsC.total, 8.5, bold);
  hRule(MX, MR, A.rowsC.totalRuleAbove, 0.8, ink);
  // r220 — the JUMLAH is the one amount that does NOT go through `amountOrRule`: the form closes it with
  // its own double rule instead of a dotted one, so it is drawn directly. Both rules are still drawn on a
  // blank — they are the agency's page — and only the figure between them is withheld.
  const jumlah = derived(d.partB.gross + d.partC.total);
  if (!blank) putR(jumlah, MR - 2, A.rowsC.total, 8.5, bold);
  hRule(MX, MR, A.rowsC.totalRuleBelow, 1.4, ink);

  // ── D — JUMLAH POTONGAN ────────────────────────────────────────────────────────────────────────────
  sectionHeading(t.sectionDTotalDeductions, A.sectionT.d);
  itemLine(N.monthlyTaxDeduction, t.monthlyTaxDeduction, A.rowsD.mtd, derived(d.partD.mtd));
  itemLine(N.cp38Deductions, t.cp38Deductions, A.rowsD.cp38, derived(d.partD.cp38));
  itemLine(N.zakatViaSalary, t.zakatViaSalary, A.rowsD.zakat, derived(d.partD.zakat));
  itemLine(N.donations, t.donations, A.rowsD.donations, manual(d.partD.donations));
  // D5 is a heading over two sub-amounts that print their own RM at MID-PAGE — the right-hand column
  // stays empty on those two lines, which is how the agency sets them (its "RM" is at 342.6). Its two
  // sub-items are indented 3.9 pt further than Section B's, at 98.2, which is the agency's own number.
  {
    const n: EaNumbering = N.tp1ClaimHeading;
    const x = numbering(n, A.rowsD.tp1Heading);
    putFit(eaCaptionWords(t.tp1ClaimHeading, n), x, MX - x - 14, A.rowsD.tp1Heading, 8);
  }
  const midAmount = (sub: string, label: string, tt: number, value: string) => {
    const n: EaNumbering = sub === '(a)' ? N.tp1Relief : N.zakatOther;
    const x = numbering(n, tt, 8, A.subTextD5);
    putFit(eaCaptionWords(label, n), x, A.midRm - x - 6, tt, 8);
    put(W.rm, A.midRm, tt, 8);
    amountOrRule(value, A.midMoney[0], A.midMoney[1], tt);
  };
  midAmount('(a)', t.tp1Relief, A.rowsD.tp1Relief, manual(d.partD.tp1Relief));
  midAmount('(b)', t.zakatOther, A.rowsD.zakatOther, manual(d.partD.zakatOther));
  // r351 — DERIVED, not manual. See localization/my/reports.ts for what reverses da4fc817's decision.
  // `derived` prints even at 0.00 … except that a year whose slips carry no relief snapshot at all
  // (pre-169e3c24, or a flat-rate non-resident) legitimately has nothing to state, and `0.00` on a tax
  // document asserts the money does not exist. So the box takes `manual`'s zero-suppression while taking
  // `derived`'s source: a real RM0.00 relief and an unknown one are indistinguishable here, and the
  // honest output for both is the agency's own empty rule.
  itemLine(N.childRelief, t.childRelief, A.rowsD.childRelief, manual(d.partD.childRelief));

  // ── E — CARUMAN ... KUMPULAN WANG SIMPANAN / PENCEN YANG DILULUSKAN DAN PERKESO ────────────────────
  //
  // ⚠️ E's SHAPE IS THE AGENCY'S AND IT IS NOT THE SHAPE WE HAD. LHDN gives item 1 TWO rows: the fund's
  // name on 661.8, and the contribution caption with its own RM and money rule on 675 BELOW it. We drew
  // the caption inline on one row. Item 2 keeps one row, with "SOCSO" / "PERKESO" in the sub-item column
  // and the shared caption beside it.
  sectionHeading(t.sectionEContributions, A.sectionT.e);
  {
    const n: EaNumbering = N.fundName;
    const x = numbering(n, A.rowsE.fundName);
    const end = putFit(eaCaptionWords(t.fundName, n), x, 120, A.rowsE.fundName, 8);
    valueOrRule(d.partE.fundName, Math.max(171.4, end + 6), MR, A.rowsE.fundName, 8);
  }
  /** E's money row: the shared caption, the agency's own "RM" at 467.1, then the column's rule. */
  const eContribution = (tt: number, x0: number, value: string) => {
    putFit(t.contributionAmount, x0, A.rmBeforeRule - x0 - 6, tt, 8);
    put(W.rm, A.rmBeforeRule, tt, 8);
    amountOrRule(value, MX, MR, tt);
  };
  eContribution(A.rowsE.epf, A.subLabel, derived(d.partE.epf));
  // r367 — ONE box, THREE legs. See `EaPdfData.partE` for the two LHDN documents that settle the caption's
  // scope. `derived` prints even at 0.00, which is right here: a contributing employee's E(2) is a figure
  // the employer withheld and can stand behind.
  {
    const n: EaNumbering = N.perkeso;
    put(`${n.item}.`, A.itemLabel, A.rowsE.perkeso, 8);
    const lead = putFit(eaCaptionWords(W.perkeso, n), A.subLabel, 70, A.rowsE.perkeso, 8) + 4;
    eContribution(A.rowsE.perkeso, lead, derived(d.partE.socso + d.partE.eis + d.partE.skbbk));
  }

  // ── F — JUMLAH ELAUN / PERKUISIT / PEMBERIAN / MANFAAT YANG DIKECUALIKAN CUKAI ─────────────────────
  // ONE LINE: the section title IS the item, and the agency's "RM" sits at 467.1 before its rule.
  sectionHeading(t.sectionFExemptAllowances, A.sectionT.f);
  put(W.rm, A.rmBeforeRule, A.sectionT.f, 8.5, bold);
  amountOrRule(derived(d.partB.exemptAllowances ?? 0), MX, MR, A.sectionT.f);

  // ── THE FOOT — the ruled officer box on the agency's own rows, the date beside it ──────────────────
  // Revision 5 follows the latest screenshot: Date outside left, officer box on the right.
  // A-F retain all geometry; complete officer values wrap only within their own measured cells.
  const V = EA_V6_FOOT;
  const borderInset = 0.4; // box() uses a 0.8pt stroke centred on its boundary.
  const innerRight = V.right-borderInset-0.5;
  const employerAddress = d.employer.address.map(line => line.trim()).filter(Boolean).join(', ');
  const rows = [
    {caption:W.officerName, value:d.employer.officerName ?? ''},
    {caption:W.officerPosition, value:d.employer.officerPosition ?? ''},
    {caption:W.employerNameAddress, value:d.employer.name},
    {caption:'', value:employerAddress},
    {caption:W.employerPhone, value:d.employer.phone ?? ''},
  ].map(row => {
    const actual=face(row.value,font);
    const lineHeight=Math.max(V.lineHeight,actual.heightAtSize(V.size)+1);
    return {...row,lineHeight,lines:wrapped(row.value,V.size,innerRight-V.valueX-6)};
  });
  rows[3].lines = rows[3].lines.length ? rows[3].lines : [''];
  const contentHeight = rows.reduce((sum,row)=>sum+Math.max(1,row.lines.length)*row.lineHeight,0);
  if (contentHeight+10 > V.bottom-V.top) throw new EaLayoutFitError('employer and authorised officer');
  box(V.left,V.top,V.right,V.bottom);
  let baseline = V.top+12;
  let dateBaseline = baseline;
  for(const [index,row] of rows.entries()){
    if(index===rows.length-1) dateBaseline=baseline; // Date and telephone share one measured baseline.
    putFit(row.caption,V.captionX,V.valueX-V.captionX-8,baseline,V.size);
    for(const value of row.lines.length?row.lines:['']){
      const valueCell:TextCell={left:V.valueX+3,right:innerRight-3,top:V.top+borderInset,bottom:V.bottom-borderInset};
      dotted(V.valueX,innerRight,baseline+2.5);
      if(value) drawText(value,V.valueX+3,baseline,V.size,font,ink,valueCell);
      if(baseline+2.5+0.25>V.bottom-borderInset-0.5) throw new EaLayoutFitError('employer and authorised officer');
      baseline+=row.lineHeight;
    }
  }
  const dateCell:TextCell = {left:A.dateX,right:Math.min(A.dateRule[1],V.left-borderInset-0.5),top:V.top+borderInset,bottom:V.bottom-borderInset};
  const dateSize=8;
  if(dateBaseline+2.5+0.25>dateCell.bottom-0.5) throw new EaLayoutFitError('date');
  const captionSize=fitSize(safe(W.date),dateCell.right-dateCell.left,dateSize,font);
  drawText(W.date,dateCell.left,dateBaseline,captionSize,font,ink,dateCell);
  const dateEnd=dateCell.left+face(W.date,font).widthOfTextAtSize(safe(W.date),captionSize);
  const dateRuleStart=Math.max(A.dateRule[0],dateEnd+4);
  dotted(dateRuleStart,dateCell.right,dateBaseline+2.5);
  const dateValue=formDate(d.formDate);
  if(dateValue){
    const valueX=dateRuleStart+3;
    const valueSize=fitSize(dateValue,dateCell.right-valueX-3,dateSize,font);
    drawText(dateValue,valueX,dateBaseline,valueSize,font,ink,{...dateCell,left:valueX,right:dateCell.right-3});
  }

  // ── BELOW THE FORM ────────────────────────────────────────────────────────────────────────────────
  //
  // ⚠️ r351 — THE STRIP IS GONE, AND THAT REVERSED r349's RECORDED DECISION. r349 wrote: "THE EIS FIGURE
  // STAYS — da4fc817's decision, real money off the employee's pay, their only annual statement. The plan
  // offered to remove it; approval kept it." The reporter then looked at the shipped page and wrote, in
  // their own hand on the comparison image (`EA Form Compare V3.png`, stage 'refuted', revision 3),
  // **"Remove this part from the EA Form"**, with a red box around the whole strip. That is the owner
  // exercising the option r349's own plan offered them, so all three went and the page ends where the
  // agency's page ends — at the officer's box.
  //
  // THE AMENDED MARKER STAYS. It was not in the reporter's red box and the approved plan named only the
  // three items above. It is also different in kind: it discloses that HR overwrote a figure on a tax
  // document, and an amended statement that looks identical to an unamended one is an audit hole, not a
  // cosmetic difference. Removing it is a decision for the reporter to make explicitly.
  //
  // ⚠️ r372 — IT HAS A NEW HOME, ABOVE THE BOX, AND THAT IS DECIDED HERE RATHER THAN DISCOVERED ON A
  // RENDERED PAGE. It used to draw at `EA_FORM.footStripT` (742), in the band the TRACED box left empty
  // beneath itself. The agency's box ENDS at 817.9 — 75 pt past 742 — so on the agency's rows the marker
  // would have printed inside the box, over the telephone rule, on every amended form in both editions;
  // pdf-lib does not clip. There is no empty band below the agency's foot to move it into, and putting
  // it on a second sheet would turn every amended statement into two pages. It goes in the 11.1 pt the
  // agency leaves between Section F's row (ending 716.4) and the box's top rule (727.5), at
  // `EA_FORM.amendedNoteT`. `footStripT` is retired in place on `EA_FORM` rather than deleted.
  //
  // 1.2.6 — "Amended" marker: a footnote when ≥1 EA field was overwritten by HR (the merge already
  // overlaid the figures above). Disclosure of WHICH figures were amended is a compliance decision
  // flagged in the plan; the default is this neutral marker.
  if (d.overrides && d.overrides.length > 0) {
    putFit(t.amendedNote, L, R-L, A.amendedNoteT, 7.5, bold, ink);
  }

  for (const operation of operations) operation();
  return doc.save();
}
