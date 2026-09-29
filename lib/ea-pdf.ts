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
// and Borang A references. So `my.ea.en` / `my.ea.ms` declare `agency-layout` (drawn to the agency's own
// arrangement, on our own paper, with no agency artwork on disk) and may NEVER declare `official`;
// `public/forms/` still holds exactly one genuine artwork, `cp22-pin-1-2021.pdf`. AGENTS 28b: nothing
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
  partE: {
    epf: number;
    socso: number;
    eis: number;
    /** da4fc817 — E1's "Nama Kumpulan Wang": the fund, named before its amount, as the form asks. */
    fundName: string;
  };
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
    partE: { epf: 0, socso: 0, eis: 0, fundName: '' },
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
 * value ("1(a) …", "5(b) …"). That is what makes `my.ea.en` and `my.ea.ms` two readable documents off one
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
 * ── THE FORM'S GEOMETRY, MEASURED OFF THE SPECIMEN RATHER THAN GUESSED ──────────────────────────────
 *
 * `x` is points from the LEFT edge. `t` (and every `…T` field) is points from the TOP edge, because that
 * is how the form reads and how a form is described; `at()` inside the renderer turns one into a pdf-lib y.
 *
 * ⚠️ TWO SOURCES, AND THEY ARE NOT EQUALLY GOOD. Read this before trusting a number here.
 *
 *  · MOST of these were scanned off `docs/forms/ea-cp8a-pin-2024-specimen.png` (1240 × 1755 px at 150 dpi
 *    ⇒ 1 px = 0.48 pt) — the banner box at 77.3/90.2, the JUMLAH double rule at 425.8/435.4, the officer
 *    box at 640.8 → 730.6. That PNG is a rasterisation of ANOTHER PAYROLL VENDOR'S rendering of the form
 *    (item ece6d75d, Producer "Developer Express Inc. DXperience v23.2.5"). It is a tracing, at half-point
 *    resolution, of something that was itself a redrawing.
 *
 *  · The MONEY COLUMN is different: since r346 it is measured off LHDN's OWN vector PDF,
 *    `docs/forms/ea-cp8a-pin-2023-official-en.pdf`, whose table cells give it exactly — 89 cells begin at
 *    482.3, 129 end there, 162 end at 556.6, and a width of 74.3 occurs 87 times.
 *
 * The tracing had that column at 504.5 → 571.3: 22.2 pt too far right, 7.5 pt too narrow, and running to
 * the page frame where the agency's stops 15.3 pt inside it. Anything still on the first list is a
 * candidate for the same treatment, and the agency's file is now on disk to do it with.
 *
 * The one deliberate departure is the LEFT margin: the traced page set its rules 16.8 pt from the paper
 * edge (under 6 mm), which is inside the unprintable margin of most office printers. Everything
 * left-anchored is shifted to 24 pt. This sentence used to end "…the money column, which is what a
 * reader checks against the agency's own page, is untouched" — true of the TRACING it was written about,
 * and false of the agency's page, which is the one it named. r346 moved that column onto the agency's
 * own coordinates; the left-margin shift is now the only departure, and it is a printability one.
 *
 * Exported so test/ea-pdf.test.ts can assert against WHAT IS ACTUALLY DRAWN — the r205 Borang A lesson:
 * pdf-lib does not clip, so a caption wider than its slot prints straight through its neighbour and the
 * page still renders, still returns 200 and still downloads.
 */
export const EA_FORM = {
  left: 24,
  right: 571.3,
  /**
   * The RM column: every Section B/C/D6 amount is right-aligned on a rule between these.
   *
   * ⚠️ MEASURED OFF THE AGENCY'S OWN PDF IN r346, NOT OFF THE TRACING. The C.P.8A is a Word TABLE and
   * its geometry lives in cell rectangles, not in rules: 89 cells start at x=482.3, 129 end there, 162
   * end at 556.6, and a cell width of 74.3 occurs 87 times. That is the money column, unambiguously.
   *
   * It used to be 504.5 → `right` (571.3), i.e. 22.2pt too far right and running all the way to the
   * page frame, because it was traced from another payroll vendor's 150dpi rendering (item ece6d75d)
   * rather than from LHDN's own file. The old comment claimed this column "is untouched" so a reader
   * could check it against the agency's page; that was true only of the tracing.
   */
  moneyLeft: 482.3,
  /**
   * …and its RIGHT edge, which is NOT the page frame. The agency's money cells stop 15.3pt inside the
   * outer rule; ours ran to it. Every amount, every money rule and the JUMLAH pair use this, so the
   * column and the figures in it move together.
   */
  moneyRight: 556.6,
  /** Section A's two columns: caption x, then the rule the value is written on. */
  aLeftLabel: 30,
  aLeftRule: [92, 283.2] as const,
  aRightLabel: 314,
  aRightRule: [419.5, 571.3] as const,
  /** Section B/C/D/E item captions, and the sub-items indented under them. */
  itemLabel: 42,
  subLabel: 55,
  /**
   * r353 (item fda53352, point 4) — WHERE AN INLINE DESCRIPTION RULE STOPS, AND ITS CLOSING BRACKET WITH IT.
   *
   * ⚠️ THIS FIXES AN OVERPRINT THAT WAS LIVE ON EVERY FILLED FORM. B.1(c), B.3 and B.4 each carry the
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
   * r353 (point 2) — SECTION A'S TWO COORDINATES, MEASURED OFF THE AGENCY'S PDF INSTEAD OF GUESSED.
   *
   * Both were BARE LITERALS in the drawing code (the heading at 99.5, the first field at 114) with no
   * constant and no test, and the reporter asked for "breathing room" between them. Run
   * `node --import tsx scripts/measure-ea-official-pdf.ts` — committed this round, because r346's and
   * r349's measuring scripts were not — against `docs/forms/ea-cp8a-pin-2023-official-en.pdf`:
   *
   *   · the banner strip is tt 78.4 → 92.6;
   *   · Section A's heading row (and its black letter square) begins at tt 96.6, i.e. 4.0 pt BELOW the
   *     banner, and its caption's baseline is 105.9;
   *   · item 1's row begins at 109.8 and its baseline is 119.7 — 13.8 pt under the heading's.
   *
   * ⚠️ AND THE MEASUREMENT CONTRADICTED THE COMPLAINT, WHICH IS WHY IT WAS WORTH TAKING. Our gap between
   * the heading and the first field was 14.5 pt where the agency's is 13.8: already the wider of the two,
   * so there was no breathing room to add there. What WAS too tight is the gap the plan noticed in
   * passing: our Section A square began 0.6 pt under the banner where the agency leaves 4.0, and two
   * solid black blocks 0.6 pt apart read as one merged block at any print resolution.
   *
   * The fix is the banner, not Section A: it rises by 3.4 pt into clearance we have and the agency does
   * not (11.3 pt above ours to its last header rule, against the agency's 5.4), which buys the agency's
   * 4.0 pt gap while leaving the heading exactly where it already was — and therefore moves NOTHING else
   * in a section band that is 28.6 pt tighter than the agency's to begin with. r349's own note records
   * that this banner's coordinate is ours and only its treatment is the agency's.
   */
  sectionGapUnderBanner: 4.0,
  /** The agency's own heading-baseline → first-field-baseline pitch in Section A (105.9 → 119.7). */
  sectionAFieldPitch: 13.8,
  /** D5(a)/(b) print their own RM and rule at MID-PAGE; the right-hand column stays empty there. */
  midMoney: [323, 390.7] as const,
  /**
   * The banner, the officer box and the strip of ours below them.
   *
   * ⚠️ r353 — THE BANNER ROSE 3.4 pt (it was [77.3, 90.7]) TO BUY SECTION A THE AGENCY'S OWN CLEARANCE.
   * See `sectionGapUnderBanner` for the measurement and for why the banner moved rather than the section.
   * Its HEIGHT (13.4) and its caption's position inside it are unchanged, so the block itself looks
   * exactly as it did; only where it sits on the page moved. The clearance above it is still 7.9 pt to
   * the "Employer's No. E" / "LHDNM State" rules at 68.5, where the agency leaves 5.4 pt above its own.
   */
  bannerT: [73.9, 87.3] as const,
  /**
   * The officer box at the foot. `ruleX[0]` is where the writing lines START, and it must clear the
   * LONGEST caption in EITHER edition.
   *
   * ⚠️ IT WAS 272 AND THE ENGLISH EDITION OVERRAN IT BY 7.9 pt (item fda53352, r349). "Name and Address
   * of Employer" ends at 279.9 at Helvetica 8, so the caption ran into its own rule — which is the red
   * bar the reporter drew on that box. The Malay caption ("Nama dan Alamat Majikan") ends at 260.7 and
   * fits with 11 pt to spare, which is why it was never seen: the form was only ever read in Malay.
   * A guard now measures both editions instead of trusting this number.
   */
  officerBox: { x0: 158.9, t0: 640.8, t1: 730.6, ruleX: [288, 563] as const },
  /** Where OUR strip starts — the ~110 pt the specimen leaves empty beneath its own foot. */
  footStripT: 742,
  /** The page floor. Nothing may be drawn below it. */
  bottom: 830,
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

export async function renderEaPdf(d: EaPdfData, t: EaPdfLabels, opts: EaRenderOptions = {}): Promise<Uint8Array> {
  /** r220 — see `EaRenderOptions`. Read once, so every suppression below reads off one name. */
  const blank = opts.blank === true;
  const doc = await PDFDocument.create();
  doc.setTitle(d.year ? `${t.title} — ${d.year}` : t.title);
  doc.setProducer('AI HR');
  const first = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const H = A4[1];
  const { left: L, right: R, moneyLeft: MX, moneyRight: MR } = EA_FORM;
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
  const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

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
  const put = (s: string, x: number, tt: number, size: number, f: PDFFont = font, color = ink) =>
    page.drawText(safe(s), { x, y: at(tt), size, font: f, color });
  const putR = (s: string, xr: number, tt: number, size: number, f: PDFFont = font, color = ink) =>
    page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y: at(tt), size, font: f, color });
  const putC = (s: string, cx: number, tt: number, size: number, f: PDFFont = font, color = ink) =>
    page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y: at(tt), size, font: f, color });
  const hRule = (x0: number, x1: number, tt: number, thickness = 0.8, color = rule) =>
    page.drawLine({ start: { x: x0, y: at(tt) }, end: { x: x1, y: at(tt) }, thickness, color });
  const box = (x0: number, t0: number, x1: number, t1: number, thickness = 0.8) =>
    page.drawRectangle({ x: x0, y: at(t1), width: x1 - x0, height: t1 - t0, borderColor: rule, borderWidth: thickness });
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
    page.drawRectangle({ x: x0, y: at(t1), width: x1 - x0, height: t1 - t0, color: ink });
  const white = rgb(1, 1, 1);
  /** The dotted rule the specimen writes every value on. */
  const dotted = (x0: number, x1: number, tt: number) => {
    for (let x = x0; x < x1; x += 3) {
      page.drawLine({ start: { x, y: at(tt) }, end: { x: Math.min(x + 1.4, x1), y: at(tt) }, thickness: 0.5, color: rule });
    }
  };

  /**
   * SHRINK TO FIT, NEVER CLIP AND NEVER OVERPRINT — r205's Borang A lesson, and it is what makes ONE
   * renderer safe for two languages on a fixed-geometry form: an English caption is routinely wider than
   * its Malay original, and pdf-lib does not clip. Truncating instead would be worse, not better — a
   * clean truncation READS AS THE CAPTION. The size comes down, rounded DOWN to 0.1 pt so the drawn
   * string stays inside `maxW`, and is clamped at 1 pt; the clamp is the one case where a string can
   * still exceed its slot, and an overprint gets queried while an invisible caption does not.
   */
  const fitSize = (v: string, maxW: number, size: number, f: PDFFont) => {
    const w = f.widthOfTextAtSize(v, size);
    if (w <= maxW || w <= 0) return size;
    return Math.max(1, Math.floor((size * maxW * 10) / w) / 10);
  };
  /** Returns the x the drawn string ENDS at, so the next run (a cue word, an inline rule) can start from
   *  what was actually drawn rather than from a guess at its width. */
  const putFit = (s: string, x: number, maxW: number, tt: number, size: number, f: PDFFont = font, color = ink) => {
    const v = safe(s);
    const sz = fitSize(v, maxW, size, f);
    page.drawText(v, { x, y: at(tt), size: sz, font: f, color });
    return x + f.widthOfTextAtSize(v, sz);
  };

  /** Greedy word-wrap at `size`, so the footnote strip can be MEASURED before it is placed. */
  const wrapped = (s: string, size: number, maxW: number, f: PDFFont = font) => {
    const out: string[] = [];
    let line = '';
    for (const w of safe(s).split(/\s+/)) {
      const trial = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxW && line) {
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
  const valueOrRule = (v: string, x0: number, x1: number, tt: number, size = 7.5) => {
    dotted(x0, x1, tt + 2.5);
    if (v) putFit(v, x0 + 3, x1 - x0 - 6, tt, size);
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
      page.drawText(s, { x: x1 - 2 - font.widthOfTextAtSize(s, sz), y: at(tt), size: sz, font, color: ink });
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
   * ONE SECTION HEADING: the letter in a filled black square, the title beside it (r349).
   *
   * The label carries its own letter ("A  PARTICULARS OF EMPLOYEE") because the form's numbering is part
   * of its wording — `lib/ea-field-register.ts` matches on it and the six catalogues own it. So the
   * letter is SPLIT OFF here rather than removed from the catalogues, which would have made the register
   * and the page disagree about what the form says.
   *
   * ⚠️ WHICH COORDINATE THIS FOLLOWS, AND WHY. The agency puts its square at x 39.8, its own body column.
   * Ours goes at `L` (24), because EA_FORM.left is already a deliberate departure — the agency's rules
   * start 16.8 pt from the paper edge, inside the unprintable margin of most office printers. The square's
   * SIZE is the agency's (17.3 pt wide, measured off its page); its POSITION is ours. The transcription
   * records both and says a build must choose per block; this is that choice, stated.
   */
  const sectionHeading = (label: string, tt: number) => {
    const m = /^\s*([A-F])\s+(.*)$/.exec(label);
    // A label that does not start with a lone section letter is drawn whole, unboxed — a locale that
    // reorders it must not silently lose its title.
    if (!m) return putFit(label, L, R - L, tt, 8.5, bold);
    const [, letter, title] = m;
    const SQ = 17.3; // the agency's own square width, measured off its page
    const top = tt - 8.2;
    const bot = tt + 2.3;
    fill(L, top, L + SQ, bot);
    putC(letter, L + SQ / 2, tt, 8.5, bold, white);
    return putFit(title, L + SQ + 6, R - (L + SQ + 6), tt, 8.5, bold);
  };

  const W = eaFormWords(opts.locale ?? 'en');

  // ── THE HEADER BAND — three blocks and the ruled banner under them ──────────────────────────────────
  put(W.formNo, L, 20, 7.5);
  putC(W.masthead1, CX, 22, 9.5);
  putC(W.masthead2, CX, 37, 13.5, bold);
  putC(W.masthead3, CX, 50, 9);
  // r220 — `.trim()` is what the BLANK form needs and what a filled one never notices: the year of
  // assessment is completed on the agency's line, so with no year there is nothing to complete and the
  // line is the agency's own caption, exactly as the specimen prints it.
  putC(`${W.masthead4} ${d.year}`.trim(), CX, 62, 9);

  // LEFT: No. Siri has NO source in this system and never will — it is the employer's own running number
  // for the statements it issues — so it prints the blank form's rule, which is what the agency's page
  // carries there.
  put(W.serialNo, L + 6, 52, 7.5);
  // The rules STOP at 200, short of the centred masthead: "PENYATA SARAAN DARIPADA PENGGAJIAN" is 168 pt
  // wide centred on 297.6, so its left edge is 213.6 and a rule run any further collides with it. The
  // specimen's own rules stop even shorter.
  valueOrRule('', 92, 200, 52);
  put(W.employerTin, L + 6, 66, 7.5);
  valueOrRule(d.employer.eNumber ?? '', 92, 200, 66);

  // RIGHT: the "EA" is the largest type on the page, and the employee's own TIN sits under it.
  const eaW = bold.widthOfTextAtSize(W.ea, 17);
  // ⚠️ TWO LINES WHEN THE EDITION NEEDS TWO. The agency's English sets this in a two-line box where the
  // Malay uses one, and the English string is 96pt wider: drawn on a single line it runs left out of its
  // own block and straight through the centred "MALAYSIA". pdf-lib does not clip, so the page still
  // renders and still downloads — the r205 Borang A lesson, and it was live in this round until the
  // blank form was rasterised and looked at. A caption is not proven by a green test.
  // r349 — the agency sets this in a filled black block too (measured: x 398.9, width 133.0, height 20.2
  // for its two English lines). ⚠️ THE BLOCK SIZES TO THE EDITION, never to a constant: English runs two
  // lines and Malay one, so a fixed rectangle leaves the Malay page with a half-empty black box.
  {
    const right = R - eaW - 6;
    const lines = W.privateStatement2 ? [W.privateStatement, W.privateStatement2] : [W.privateStatement];
    const size = lines.length > 1 ? 8 : 8.5;
    const widest = Math.max(...lines.map((l) => bold.widthOfTextAtSize(safe(l), size)));
    const top = lines.length > 1 ? 10.5 : 17.5;
    const bot = lines.length > 1 ? 29.5 : 27;
    fill(right - widest - 5, top, right + 3, bot);
    lines.forEach((l, i) => putR(l, right, (lines.length > 1 ? 17 : 24) + i * 9, size, bold, white));
  }
  putR(W.ea, R, 26, 17, bold);
  putR(W.employeeTin, R, 36, 7.5);
  valueOrRule(d.employee.taxNo ?? '', 438, R, 47);
  put(W.lhdnState, 440, 66, 7.5);
  valueOrRule(d.employer.lhdnState ?? '', 495, R, 66);

  // r349 — SOLID, WHITE-ON-BLACK, as the agency prints it. Measured off its page: top 78.2, height 14.9,
  // spanning its body width (39.8 -> 555.8). We keep OUR margins (L -> R) so the banner stays flush with
  // the rest of our page; what is adopted is the treatment, not the coordinate.
  fill(L, EA_FORM.bannerT[0], R, EA_FORM.bannerT[1]);
  // r353 — the caption's 9.2 pt drop inside the strip is unchanged; it follows the strip instead of
  // repeating its old absolute baseline (86.5), so the two can no longer be moved apart by accident.
  putC(W.banner, CX, EA_FORM.bannerT[0] + 9.2, 8, bold, white);

  // ── A — BUTIRAN PEKERJA ────────────────────────────────────────────────────────────────────────────
  const A = EA_FORM;
  /**
   * r353 (point 2) — DERIVED FROM THE BANNER AND THE AGENCY'S MEASURED GAPS, not typed in.
   *
   * `sectionHeading` hangs its black square from `tt - 8.2`, so putting the square the agency's
   * `sectionGapUnderBanner` below the banner fixes the caption's baseline. `SQUARE_ASCENT` is that same
   * 8.2 named once here rather than being the third copy of a number the heading already owns.
   * With the banner at 87.3 this lands on 99.5 — where the heading already was — so Section A does not
   * move; what changed is that the number is now the agency's arithmetic and not a literal.
   */
  const SQUARE_ASCENT = 8.2;
  const round1 = (n: number) => Math.round(n * 10) / 10; // 87.3 + 4 + 8.2 must be 99.5, not 99.50000000000001
  const aHeading = round1(A.bannerT[1] + A.sectionGapUnderBanner + SQUARE_ASCENT);
  const aFirstField = round1(aHeading + A.sectionAFieldPitch);
  sectionHeading(t.sectionAEmployeeParticulars, aHeading);
  putFit(t.name, L + 6, 165, aFirstField, 7.5);
  valueOrRule(d.employee.name, 197.3, R, aFirstField);

  /** One two-column Section A row: item on the left, item on the right, each with its own rule. */
  const aRow = (tt: number, leftLabel: string, leftValue: string, rightLabel: string, rightValue: string) => {
    putFit(leftLabel, A.aLeftLabel, A.aLeftRule[0] - A.aLeftLabel - 4, tt, 7.5);
    valueOrRule(leftValue, A.aLeftRule[0], A.aLeftRule[1], tt);
    putFit(rightLabel, A.aRightLabel, A.aRightRule[0] - A.aRightLabel - 4, tt, 7.5);
    valueOrRule(rightValue, A.aRightRule[0], A.aRightRule[1], tt);
  };
  aRow(125.7, t.jobTitle, d.employee.jobTitle ?? '', t.employeeNo, d.employee.employeeNo ?? '');
  aRow(137.7, t.icNo, d.employee.ic ?? '', t.passportNo, d.employee.passport ?? '');
  aRow(149.7, t.epfNo, d.employee.epfNo ?? '', t.socsoNo, d.employee.socsoNo ?? '');

  // Item 8's caption wraps to a second line on the form, and its rule sits on that second line.
  const childLines = wrapped(t.childrenTaxRelief, 7.5, 105).slice(0, 2);
  childLines.forEach((line, i) => put(line, A.aLeftLabel + (i ? 6 : 0), 160.8 + i * 9.6, 7.5));
  // r220 — a COUNT, not an amount, so it does not pass through `amountOrRule` and has to say for itself
  // that a blank form carries no number here. `String(0)` is "0", and "0 children qualifying for tax
  // relief" is a claim about a person the blank form does not have.
  //
  // r364 — THE EXPRESSION IS UNCHANGED AND ITS REASON IS NOT. r359 read the `== null` arm as "absent
  // because D.6 is absent — the two boxes are one fact". It now means UNRECORDED: no statutory row, or a
  // null `num_children` in a mode that reads it. Nothing about D.6 reaches this box any more.
  valueOrRule(blank || d.employee.children == null ? '' : String(d.employee.children), 135, A.aLeftRule[1], 173.2);

  /**
   * ⚠️ ITEM 9 IS CONDITIONAL ON THE YEAR, NOT ON A DATE EXISTING — and that distinction is the whole
   * defect this half of the round fixes.
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
  putFit(t.partYearNote, A.aRightLabel, 250, 160.8, 7.5);
  const inYear = (iso: string | null) => (iso && iso.slice(0, 4) === d.year ? formDate(iso) : '');
  putFit(t.startedOn, A.aRightLabel + 14, A.aRightRule[0] - A.aRightLabel - 18, 173.2, 7.5);
  valueOrRule(inYear(d.employee.hiredOn), A.aRightRule[0], A.aRightRule[1], 173.2);
  putFit(t.leftOn, A.aRightLabel + 14, A.aRightRule[0] - A.aRightLabel - 18, 186.6, 7.5);
  valueOrRule(inYear(d.employee.terminatedOn), A.aRightRule[0], A.aRightRule[1], 186.6);

  // ── B — PENDAPATAN PENGGAJIAN, MANFAAT DAN TEMPAT KEDIAMAN ─────────────────────────────────────────
  sectionHeading(t.sectionBEmploymentIncome, 197.5);
  putFit(t.sectionBExcluding, L + 6, 430, 208, 7.5, bold);
  // The bold RM heading, printed ONCE for the whole form, over the right-hand column.
  putC(W.rm, (MX + MR) / 2, 208, 9, bold);

  moneyLine(t.grossSalary, A.itemLabel, 220.8, derived(d.partB.grossSalary));
  // 1(b) and 1(c) are ONE box each on the agency's form over TWO of our figures. The form's own captions
  // say so — "Fi (termasuk fi pengarah), komisen atau bonus" and "Tip kasar, perkuisit, penerimaan sagu
  // hati atau elaun-elaun lain" — so the box carries the sum, and printing only half of it would leave
  // taxable money off the line the agency asks for it on. The finer split stays visible where it is
  // useful: the HTML statement and the amend panel keep a row each.
  moneyLine(t.feesCommissionBonus, A.itemLabel, 234.2, mixed(d.partB.bonus, d.partB.directorFee));
  captionWithInlineRule(t.tipsPerquisitesOther, t.paymentDetail, A.itemLabel, 248.2);
  amountOrRule(mixed(d.partB.allowances, d.partB.tipsPerquisites), MX, MR, 248.2);
  moneyLine(t.taxBorneByEmployer, A.itemLabel, 261.6, manual(d.partB.taxBorneByEmployer));
  moneyLine(t.esos, A.itemLabel, 275, manual(d.partB.esos));
  // 1(f) — "Ganjaran bagi tempoh dari … hingga …". The period is not a fact this system holds, so both
  // rules stay empty; the AMOUNT is a manual box like the rest.
  {
    const cap = putFit(t.gratuity, A.itemLabel, 200, 288.4, 8);
    const from = putFit(t.periodFrom, cap + 4, 40, 288.4, 8);
    dotted(from + 4, from + 92, 290.9);
    const to = putFit(t.periodTo, from + 98, 40, 288.4, 8);
    dotted(to + 4, to + 92, 290.9);
    amountOrRule(manual(d.partB.gratuity), MX, MR, 288.4);
  }
  // Item 2 — the caption, then "Jenis pendapatan (a) …/(b) …" beneath it. The two description rules carry
  // no money; the amount belongs to item 2 and sits on the (b) line, exactly as the specimen sets it.
  putFit(t.arrears, A.itemLabel, MX - A.itemLabel - 14, 301.8, 8);
  putFit(t.incomeType, A.subLabel, 70, 313.2, 8);
  put('(a)', 128, 313.2, 8);
  dotted(146, 291.4, 315.7);
  put('(b)', 128, 326.6, 8);
  dotted(146, 291.4, 329.1);
  amountOrRule(manual(d.partB.arrears), MX, MR, 326.6);
  captionWithInlineRule(t.benefitsInKind, t.stateWhat, A.itemLabel, 339.8);
  amountOrRule(manual(d.partB.benefitsInKind), MX, MR, 339.8);
  captionWithInlineRule(t.livingAccommodation, t.addressCue, A.itemLabel, 353.2);
  amountOrRule(manual(d.partB.livingAccommodation), MX, MR, 353.2);
  moneyLine(t.unapprovedFundRefund, A.itemLabel, 366.6, manual(d.partB.unapprovedFundRefund));
  moneyLine(t.compensation, A.itemLabel, 380, manual(d.partB.compensation));

  // ── C — PENCEN DAN LAIN-LAIN, closed by the form's single JUMLAH ───────────────────────────────────
  sectionHeading(t.sectionCPensionOther, 391.5);
  moneyLine(t.pension, A.itemLabel, 405.6, manual(d.partC.pension));
  moneyLine(t.annuity, A.itemLabel, 418.6, manual(d.partC.annuity));
  /**
   * THE JUMLAH TOTALS B AND C TOGETHER, and it is the ONLY total the form has.
   *
   * The transcription says so and the specimen shows it: one bold JUMLAH at the foot of Section C, closed
   * with a DOUBLE rule rather than a dotted one. Our own layout carried two subtotals — one for Part B
   * and one for Part C — and the agency's page has neither. `partB.gross` is the sum of the printed Part
   * B lines (EA_PART_B_COMPONENTS, recomputed after any override) and `partC.total` is pension + annuity,
   * so this is those two figures added, not a third arithmetic.
   */
  // The specimen's two rules sit at 425.8 and 435.4 with nothing between them, because the blank form has
  // no figure to place there. Ours does, so the amount's baseline is 433.5 — 1.5 pt of clearance under the
  // upper rule for the digits' cap height — and the lower rule moves 2 pt down to clear the commas'
  // descenders. Drawn at the specimen's spacing, the upper rule struck straight through the total.
  putFit(t.formTotal, A.itemLabel, 200, 433.5, 8.5, bold);
  hRule(MX, MR, 425.8, 0.8, ink);
  // r220 — the JUMLAH is the one amount that does NOT go through `amountOrRule`: the form closes it with
  // its own double rule instead of a dotted one, so it is drawn directly. Both rules are still drawn on a
  // blank — they are the agency's page — and only the figure between them is withheld.
  const jumlah = derived(d.partB.gross + d.partC.total);
  if (!blank) putR(jumlah, MR - 2, 433.5, 8.5, bold);
  hRule(MX, MR, 437.5, 1.4, ink);

  // ── D — JUMLAH POTONGAN ────────────────────────────────────────────────────────────────────────────
  sectionHeading(t.sectionDTotalDeductions, 447.5);
  moneyLine(t.monthlyTaxDeduction, A.itemLabel, 461.3, derived(d.partD.mtd));
  moneyLine(t.cp38Deductions, A.itemLabel, 474.7, derived(d.partD.cp38));
  moneyLine(t.zakatViaSalary, A.itemLabel, 487.7, derived(d.partD.zakat));
  moneyLine(t.donations, A.itemLabel, 501.1, manual(d.partD.donations));
  // D5 is a heading over two sub-amounts that print their own RM at MID-PAGE — the right-hand column
  // stays empty on those two lines, which is how the specimen sets them.
  putFit(t.tp1ClaimHeading, A.itemLabel, MX - A.itemLabel - 14, 512.6, 8);
  const midAmount = (label: string, tt: number, value: string) => {
    putFit(label, A.subLabel, EA_FORM.midMoney[0] - A.subLabel - 22, tt, 8);
    put(W.rm, EA_FORM.midMoney[0] - 18, tt, 8);
    amountOrRule(value, EA_FORM.midMoney[0], EA_FORM.midMoney[1], tt);
  };
  midAmount(t.tp1Relief, 524.5, manual(d.partD.tp1Relief));
  midAmount(t.zakatOther, 538, manual(d.partD.zakatOther));
  // r351 — DERIVED, not manual. See localization/my/reports.ts for what reverses da4fc817's decision.
  // `derived` prints even at 0.00 … except that a year whose slips carry no relief snapshot at all
  // (pre-169e3c24, or a flat-rate non-resident) legitimately has nothing to state, and `0.00` on a tax
  // document asserts the money does not exist. So the box takes `manual`'s zero-suppression while taking
  // `derived`'s source: a real RM0.00 relief and an unknown one are indistinguishable here, and the
  // honest output for both is the agency's own empty rule.
  moneyLine(t.childRelief, A.itemLabel, 551.4, manual(d.partD.childRelief));

  // ── E — CARUMAN ... KUMPULAN WANG SIMPANAN / PENCEN YANG DILULUSKAN DAN PERKESO ────────────────────
  sectionHeading(t.sectionEContributions, 567.8);
  putFit(t.fundName, A.itemLabel, 100, 581.5, 8);
  valueOrRule(d.partE.fundName, 148, R, 581.5, 8);
  const eContribution = (prefix: string, x0: number, tt: number, value: string) => {
    const x = prefix ? putFit(prefix, x0, 70, tt, 8) + 4 : x0;
    putFit(t.contributionAmount, x, MX - x - 24, tt, 8);
    put(W.rm, MX - 20, tt, 8);
    amountOrRule(value, MX, MR, tt);
  };
  eContribution('', A.subLabel, 594.5, derived(d.partE.epf));
  eContribution(W.perkeso, A.itemLabel, 608, derived(d.partE.socso));

  // ── F — JUMLAH ELAUN / PERKUISIT / PEMBERIAN / MANFAAT YANG DIKECUALIKAN CUKAI ─────────────────────
  // ONE LINE: the section title IS the item, and "RM" sits just before its rule.
  sectionHeading(t.sectionFExemptAllowances, 627.5);
  put(W.rm, MX - 20, 627.5, 8.5, bold);
  amountOrRule(derived(d.partB.exemptAllowances ?? 0), MX, MR, 627.5);

  // ── THE FOOT — the date at the left, the ruled officer box at the right ────────────────────────────
  const O = EA_FORM.officerBox;
  box(O.x0, O.t0, R, O.t1);
  const officerRow = (caption: string, tt: number, value: string) => {
    put(caption, O.x0 + 8, tt, 8);
    valueOrRule(value, O.ruleX[0], O.ruleX[1], tt, 8);
  };
  officerRow(W.officerName, 655, d.employer.officerName ?? '');
  officerRow(W.officerPosition, 672, d.employer.officerPosition ?? '');
  /**
   * "Nama dan Alamat Majikan" — TWO writing rules, and the name and address FLOW ACROSS BOTH (r353).
   *
   * ⚠️ WHAT THE MEASUREMENT SETTLED, AND IT IS NOT WHAT THE PLAN EXPECTED. The approved plan proposed a
   * THIRD rule here. `node --import tsx scripts/measure-ea-official-pdf.ts --rects` says the agency's own
   * officer box has exactly FIVE rows (tt 739.8 / 753 / 766.2 / 779.4 / 792.6, 13.2 pt each): Name of
   * Officer, Designation, "Name and Address of Employer", ONE unlabelled continuation rule, and
   * Telephone No. Two writing lines for the name and address, which is what this box already has. A
   * third would be our redesign of a box the item exists to stop redesigning.
   *
   * ⚠️ THE DEFECT WAS NEVER THE RULE COUNT — IT WAS THAT THE SECOND RULE WAS WASTED. The employer's name
   * took the whole of rule one and the ENTIRE address was crushed onto rule two through `fitSize`, which
   * shrinks rather than wraps and is floored at 1 pt. A four-part Kuala Lumpur address is about 440 pt of
   * 8 pt Helvetica against a 269 pt rule, so it printed at 4.8 pt — legible-ish on screen, gone on paper,
   * and silent: no overflow, no warning, a 200 and a downloadable file (r205's Borang A lesson again).
   *
   * So the two lines are filled the way a typesetter fills them: greedy-wrap the name and address
   * together at full size across rule one, put the remainder on rule two, and let `valueOrRule`'s
   * shrink-to-fit apply ONLY to a remainder that still will not fit. An address that fits now prints at
   * 8 pt on both lines instead of 8 pt on one and 4.8 pt on the other.
   */
  const employerBlock = [d.employer.name, ...d.employer.address].map((s) => (s ?? '').trim()).filter(Boolean).join(', ');
  const officerRuleW = O.ruleX[1] - O.ruleX[0] - 6; // the width valueOrRule actually writes into
  const employerLines = wrapped(employerBlock, 8, officerRuleW);
  officerRow(W.employerNameAddress, 689, employerLines[0] ?? '');
  valueOrRule(employerLines.slice(1).join(' '), O.ruleX[0], O.ruleX[1], 706, 8);
  officerRow(W.employerPhone, 723, d.employer.phone ?? '');
  // Tarikh is the date the employer SIGNS the statement, which is theirs to write and not ours to invent.
  // It prints the blank form's rule.
  put(W.date, L + 6, 723, 8);
  valueOrRule('', 68, 150, 723, 8);

  // ── BELOW THE FORM ────────────────────────────────────────────────────────────────────────────────
  //
  // ⚠️ r351 — THE STRIP IS GONE, AND THAT REVERSES r349's RECORDED DECISION. r349 wrote: "THE EIS FIGURE
  // STAYS — da4fc817's decision, real money off the employee's pay, their only annual statement. The plan
  // offered to remove it; approval kept it." The reporter has now looked at the shipped page and written,
  // in their own hand on the comparison image (`EA Form Compare V3.png`, stage 'refuted', revision 3),
  // **"Remove this part from the EA Form"**, with a red box around the whole strip: the "Not part of the
  // official C.P.8A" line, the EIS / SIP figure, and the disclaimer paragraph. That is the owner
  // exercising the option r349's own plan offered them, so all three go and the page ends where the
  // agency's page ends — at the officer's box.
  //
  // THE EIS FIGURE IS NOW NOWHERE ON THE PRINTED FORM. That was the cost da4fc817 and r349 were unwilling
  // to pay, and the reporter has now decided to pay it. The figure is still on the HTML statement
  // (app/payroll/reports/ea/[employmentId]/page.tsx), which is why `eisSip` and `disclaimer` stay LIVE
  // message keys rather than being retired — only `notOfficialStrip` had no other reader.
  //
  // THE AMENDED MARKER STAYS. It was not in the reporter's red box and the approved plan named only the
  // three items above. It is also different in kind: it discloses that HR overwrote a figure on a tax
  // document, and an amended statement that looks identical to an unamended one is an audit hole, not a
  // cosmetic difference. Removing it is a decision for the reporter to make explicitly.
  let y: number = EA_FORM.footStripT;
  const noteH = d.overrides && d.overrides.length > 0 ? 11 : 0;
  const newPage = () => {
    page = doc.addPage(A4);
    y = 60;
  };
  if (noteH && y + noteH > EA_FORM.bottom) newPage();

  // 1.2.6 — "Amended" marker: a footnote when ≥1 EA field was overwritten by HR (the merge already
  // overlaid the figures above). Disclosure of WHICH figures were amended is a compliance decision flagged
  // in the plan; the default is this neutral marker.
  if (noteH) {
    put(t.amendedNote, L, y, 7.5, bold, ink);
    y += 11;
  }

  return doc.save();
}
