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
// looked like the form. It is now drawn to the C.P.8A (Pin. 2024) arrangement — masthead, No. Siri /
// TIN Majikan E, the "Penyata Gaji Pekerja SWASTA EA" block, the ruled banner, Section A's two-column
// numbering, B to F in the form's own order with the RM column down the right, and the ruled officer box
// at the foot.
//
// WHERE THE ARRANGEMENT CAME FROM, AND WHAT IT IS NOT. `docs/forms/ea-cp8a-pin-2024-specimen.png` is a
// BLANK C.P.8A Pin. 2024 (feedback attachment 9c080805-6b93-40ab-ba99-1d00d961b38b, rasterised at
// 150dpi) and `docs/forms/ea-cp8a-pin-2024-transcription.txt` is every caption on it, transcribed by
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
    children: number;
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
  eisSip: string;
  sectionFExemptAllowances: string;
  disclaimer: string; // already interpolated with {year} + {version} by the caller
  amendedNote: string; // 1.2.6 — printed only when ≥1 EA field was amended by HR
};

const A4: [number, number] = [595.28, 841.89];

/**
 * ── THE FORM'S GEOMETRY, MEASURED OFF THE SPECIMEN RATHER THAN GUESSED ──────────────────────────────
 *
 * `x` is points from the LEFT edge. `t` (and every `…T` field) is points from the TOP edge, because that
 * is how the specimen reads and how a form is described; `at()` inside the renderer turns one into a
 * pdf-lib y. Every number was read off `docs/forms/ea-cp8a-pin-2024-specimen.png` (1240 × 1755 px at
 * 150 dpi ⇒ 1 px = 0.48 pt) by scanning for rules — the banner box at 77.3/90.2, the money column at
 * 504.5 → 572.2, the JUMLAH double rule at 425.8/435.4, the officer box at 640.8 → 730.6 — not by eye.
 *
 * The only deliberate departure is the LEFT margin: the specimen sets its rules 16.8 pt from the paper
 * edge (under 6 mm), which is inside the unprintable margin of most office printers. Everything
 * left-anchored is shifted to 24 pt; the money column, which is what a reader checks against the
 * agency's own page, is untouched.
 *
 * Exported so test/ea-pdf.test.ts can assert against WHAT IS ACTUALLY DRAWN — the r205 Borang A lesson:
 * pdf-lib does not clip, so a caption wider than its slot prints straight through its neighbour and the
 * page still renders, still returns 200 and still downloads.
 */
export const EA_FORM = {
  left: 24,
  right: 571.3,
  /** The RM column: every Section B/C/D6 amount is right-aligned on a rule between these. */
  moneyLeft: 504.5,
  /** Section A's two columns: caption x, then the rule the value is written on. */
  aLeftLabel: 30,
  aLeftRule: [92, 283.2] as const,
  aRightLabel: 314,
  aRightRule: [419.5, 571.3] as const,
  /** Section B/C/D/E item captions, and the sub-items indented under them. */
  itemLabel: 42,
  subLabel: 55,
  /** D5(a)/(b) print their own RM and rule at MID-PAGE; the right-hand column stays empty there. */
  midMoney: [323, 390.7] as const,
  /** The banner, the officer box and the strip of ours below them. */
  bannerT: [77.3, 90.7] as const,
  officerBox: { x0: 158.9, t0: 640.8, t1: 730.6, ruleX: [272, 563] as const },
  /** Where OUR strip starts — the ~110 pt the specimen leaves empty beneath its own foot. */
  footStripT: 742,
  /** The page floor. Nothing may be drawn below it. */
  bottom: 830,
} as const;

/**
 * THE AGENCY'S OWN WORDS, VERBATIM FROM THE TRANSCRIPTION, MALAY IN BOTH LANGUAGES.
 *
 * Copied from `docs/forms/ea-cp8a-pin-2024-transcription.txt`, which was transcribed by hand from the
 * specimen. NOT paraphrased, NOT translated, NOT corrected.
 *
 * ⚠️ `officerName` READS "Name Pegawai" AND THAT IS THE SPECIMEN'S OWN SPELLING. Malay would be "Nama".
 * It is reproduced as the agency's form has it and is NOT silently corrected; this note exists so the
 * next reader knows it was read off the page, not mistyped here. The transcription carries the same
 * warning beside it.
 */
export const EA_FORM_WORDS = {
  formNo: '(C.P.8A - Pin. 2024)',
  serialNo: 'No. Siri',
  employerTin: 'TIN Majikan E',
  masthead1: 'MALAYSIA',
  masthead2: 'CUKAI PENDAPATAN',
  masthead3: 'PENYATA SARAAN DARIPADA PENGGAJIAN',
  masthead4: 'BAGI TAHUN BERAKHIR 31 DISEMBER',
  privateStatement: 'Penyata Gaji Pekerja SWASTA',
  ea: 'EA',
  employeeTin: 'No. Pengenalan Cukai (TIN) Pekerja',
  lhdnState: 'LHDNM Negeri',
  banner: 'BORANG EA INI PERLU DISEDIAKAN UNTUK DISERAHKAN KEPADA PEKERJA BAGI TUJUAN CUKAI PENDAPATAN',
  /** E's second item. The "2." is the form's own numbering, which is structure rather than wording — the
   *  same reason every other item's number rides in its caption. */
  perkeso: '2. PERKESO:',
  rm: 'RM',
  officerName: 'Name Pegawai',
  officerPosition: 'Jawatan',
  employerNameAddress: 'Nama dan Alamat Majikan',
  employerPhone: 'No. Telefon Majikan',
  date: 'Tarikh:',
} as const;

export async function renderEaPdf(d: EaPdfData, t: EaPdfLabels): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} — ${d.year}`);
  doc.setProducer('AI HR');
  const first = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const H = A4[1];
  const { left: L, right: R, moneyLeft: MX } = EA_FORM;
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
   * into `payslip.allowance` before the row is written. Printing those as a derived 0.00 asserted that
   * money does not exist while the same money was printed two lines up under Allowances: a director paid
   * RM 4,000/month of commission got "Fees (incl. director's fees) RM 0.00" on a C.P.8A.
   *
   * On the redrawn form an unset manual box is not an ABSENT LINE — the caption and its rule are printed
   * exactly as the blank form prints them, and the rule is simply empty. That is the blank the agency's
   * own page carries, and it asserts nothing at all.
   */
  const derived = (n: number): string => amt(n);
  const manual = (n: number): string => (Math.round((Number(n) || 0) * 100) !== 0 ? amt(n) : '');

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
  /** The same, right-aligned — which is how every amount on this form sits on its rule. */
  const amountOrRule = (v: string, x0: number, x1: number, tt: number, size = 8) => {
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
    amountOrRule(value, MX, R, tt);
  };
  /** A caption, then the form's own cue word in brackets and an inline dotted rule for a description the
   *  agency asks for and this system does not hold. The rule stays empty — writing a description we do
   *  not have is inventing a fact about somebody's pay. */
  const captionWithInlineRule = (caption: string, cue: string, x: number, tt: number, ruleTo: number, size = 8) => {
    const capEnd = putFit(caption, x, 300, tt, size);
    const cueEnd = putFit(`(${cue}`, capEnd + 4, 140, tt, size);
    dotted(cueEnd + 3, ruleTo, tt + 2.5);
    put(')', ruleTo + 2, tt, size);
  };

  const W = EA_FORM_WORDS;

  // ── THE HEADER BAND — three blocks and the ruled banner under them ──────────────────────────────────
  put(W.formNo, L, 20, 7.5);
  putC(W.masthead1, CX, 22, 9.5);
  putC(W.masthead2, CX, 37, 13.5, bold);
  putC(W.masthead3, CX, 50, 9);
  putC(`${W.masthead4} ${d.year}`, CX, 62, 9);

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
  putR(W.privateStatement, R - eaW - 6, 24, 8.5, bold);
  putR(W.ea, R, 26, 17, bold);
  putR(W.employeeTin, R, 36, 7.5);
  valueOrRule(d.employee.taxNo ?? '', 438, R, 47);
  put(W.lhdnState, 440, 66, 7.5);
  valueOrRule(d.employer.lhdnState ?? '', 495, R, 66);

  box(L, EA_FORM.bannerT[0], R, EA_FORM.bannerT[1]);
  putC(W.banner, CX, 86.5, 8, bold);

  // ── A — BUTIRAN PEKERJA ────────────────────────────────────────────────────────────────────────────
  const A = EA_FORM;
  put(t.sectionAEmployeeParticulars, L, 99.5, 8.5, bold);
  putFit(t.name, L + 6, 165, 114, 7.5);
  valueOrRule(d.employee.name, 197.3, R, 114);

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
  valueOrRule(String(d.employee.children), 135, A.aLeftRule[1], 173.2);

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
  put(t.sectionBEmploymentIncome, L, 197.5, 8.5, bold);
  putFit(t.sectionBExcluding, L + 6, 430, 208, 7.5, bold);
  // The bold RM heading, printed ONCE for the whole form, over the right-hand column.
  putC(W.rm, (MX + R) / 2, 208, 9, bold);

  moneyLine(t.grossSalary, A.itemLabel, 220.8, derived(d.partB.grossSalary));
  // 1(b) and 1(c) are ONE box each on the agency's form over TWO of our figures. The form's own captions
  // say so — "Fi (termasuk fi pengarah), komisen atau bonus" and "Tip kasar, perkuisit, penerimaan sagu
  // hati atau elaun-elaun lain" — so the box carries the sum, and printing only half of it would leave
  // taxable money off the line the agency asks for it on. The finer split stays visible where it is
  // useful: the HTML statement and the amend panel keep a row each.
  moneyLine(t.feesCommissionBonus, A.itemLabel, 234.2, derived(d.partB.bonus + d.partB.directorFee));
  captionWithInlineRule(t.tipsPerquisitesOther, t.paymentDetail, A.itemLabel, 248.2, 481);
  amountOrRule(derived(d.partB.allowances + d.partB.tipsPerquisites), MX, R, 248.2);
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
    amountOrRule(manual(d.partB.gratuity), MX, R, 288.4);
  }
  // Item 2 — the caption, then "Jenis pendapatan (a) …/(b) …" beneath it. The two description rules carry
  // no money; the amount belongs to item 2 and sits on the (b) line, exactly as the specimen sets it.
  putFit(t.arrears, A.itemLabel, MX - A.itemLabel - 14, 301.8, 8);
  putFit(t.incomeType, A.subLabel, 70, 313.2, 8);
  put('(a)', 128, 313.2, 8);
  dotted(146, 291.4, 315.7);
  put('(b)', 128, 326.6, 8);
  dotted(146, 291.4, 329.1);
  amountOrRule(manual(d.partB.arrears), MX, R, 326.6);
  captionWithInlineRule(t.benefitsInKind, t.stateWhat, A.itemLabel, 339.8, 481);
  amountOrRule(manual(d.partB.benefitsInKind), MX, R, 339.8);
  captionWithInlineRule(t.livingAccommodation, t.addressCue, A.itemLabel, 353.2, 481);
  amountOrRule(manual(d.partB.livingAccommodation), MX, R, 353.2);
  moneyLine(t.unapprovedFundRefund, A.itemLabel, 366.6, manual(d.partB.unapprovedFundRefund));
  moneyLine(t.compensation, A.itemLabel, 380, manual(d.partB.compensation));

  // ── C — PENCEN DAN LAIN-LAIN, closed by the form's single JUMLAH ───────────────────────────────────
  put(t.sectionCPensionOther, L, 391.5, 8.5, bold);
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
  put(t.formTotal, A.itemLabel, 433.5, 8.5, bold);
  hRule(MX, R, 425.8, 0.8, ink);
  putR(derived(d.partB.gross + d.partC.total), R - 2, 433.5, 8.5, bold);
  hRule(MX, R, 437.5, 1.4, ink);

  // ── D — JUMLAH POTONGAN ────────────────────────────────────────────────────────────────────────────
  put(t.sectionDTotalDeductions, L, 447.5, 8.5, bold);
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
  moneyLine(t.childRelief, A.itemLabel, 551.4, manual(d.partD.childRelief));

  // ── E — CARUMAN ... KUMPULAN WANG SIMPANAN / PENCEN YANG DILULUSKAN DAN PERKESO ────────────────────
  // The section title is the longest line on the form; it is shrunk to the page width rather than allowed
  // to run off it.
  putFit(t.sectionEContributions, L, R - L, 567.8, 8.5, bold);
  putFit(t.fundName, A.itemLabel, 100, 581.5, 8);
  valueOrRule(d.partE.fundName, 148, R, 581.5, 8);
  const eContribution = (prefix: string, x0: number, tt: number, value: string) => {
    const x = prefix ? putFit(prefix, x0, 70, tt, 8) + 4 : x0;
    putFit(t.contributionAmount, x, MX - x - 24, tt, 8);
    put(W.rm, MX - 20, tt, 8);
    amountOrRule(value, MX, R, tt);
  };
  eContribution('', A.subLabel, 594.5, derived(d.partE.epf));
  eContribution(W.perkeso, A.itemLabel, 608, derived(d.partE.socso));

  // ── F — JUMLAH ELAUN / PERKUISIT / PEMBERIAN / MANFAAT YANG DIKECUALIKAN CUKAI ─────────────────────
  // ONE LINE: the section title IS the item, and "RM" sits just before its rule.
  putFit(t.sectionFExemptAllowances, L, MX - L - 26, 627.5, 8.5, bold);
  put(W.rm, MX - 20, 627.5, 8.5, bold);
  amountOrRule(derived(d.partB.exemptAllowances ?? 0), MX, R, 627.5);

  // ── THE FOOT — the date at the left, the ruled officer box at the right ────────────────────────────
  const O = EA_FORM.officerBox;
  box(O.x0, O.t0, R, O.t1);
  const officerRow = (caption: string, tt: number, value: string) => {
    put(caption, O.x0 + 8, tt, 8);
    valueOrRule(value, O.ruleX[0], O.ruleX[1], tt, 8);
  };
  officerRow(W.officerName, 655, d.employer.officerName ?? '');
  officerRow(W.officerPosition, 672, d.employer.officerPosition ?? '');
  // "Nama dan Alamat Majikan" gets TWO rules, for two address lines. The employer's NAME takes the first;
  // whatever address is on file is folded onto the second, because a third rule is not on the form.
  officerRow(W.employerNameAddress, 689, d.employer.name);
  valueOrRule(d.employer.address.join(', '), O.ruleX[0], O.ruleX[1], 706, 8);
  officerRow(W.employerPhone, 723, d.employer.phone ?? '');
  // Tarikh is the date the employer SIGNS the statement, which is theirs to write and not ours to invent.
  // It prints the blank form's rule.
  put(W.date, L + 6, 723, 8);
  valueOrRule('', 68, 150, 723, 8);

  // ── OUR OWN STRIP, BELOW THE FORM ─────────────────────────────────────────────────────────────────
  // Everything from here down is NOT on the agency's page, and it is kept below the officer box — in the
  // ~110 points the specimen leaves empty — precisely so that nothing on the drawn form claims a box the
  // C.P.8A does not have.
  //
  // EIS / SIP IS THE ONE FIGURE THAT LIVES HERE. da4fc817 established that the official Section E carries
  // exactly two amounts (the approved fund and PERKESO) and that EIS is not one of them, and kept the
  // figure — an employee's own EIS deduction is real and they may need it — printed outside the section.
  // r219 keeps that decision and moves it the rest of the way out: below the form entirely, in our own
  // strip, with the RM spelled out so it cannot be read as one of the form's own boxes.
  let y: number = EA_FORM.footStripT;
  put(t.eisSip, L, y, 7, font, muted);
  putR(rm(d.partE.eis), R, y, 7, font, muted);
  y += 10;

  const discLines = wrapped(t.disclaimer, 7, R - L);
  const noteH = d.overrides && d.overrides.length > 0 ? 11 : 0;
  const bandH = noteH + 12 + discLines.length * 9;
  const newPage = () => {
    page = doc.addPage(A4);
    y = 60;
  };
  if (y + bandH > EA_FORM.bottom) newPage();

  // 1.2.6 — "Amended" marker: a footnote when ≥1 EA field was overwritten by HR (the merge already
  // overlaid the figures above). Disclosure of WHICH figures were amended is a compliance decision flagged
  // in the plan; the default is this neutral marker.
  if (noteH) {
    put(t.amendedNote, L, y, 7.5, bold, ink);
    y += 11;
  }
  hRule(L, R, y - 4, 0.5);
  y += 8;
  for (const line of discLines) {
    // Only a disclaimer taller than a whole strip reaches this — the measurement above has already placed
    // a band that fits. It stays so an absurd string spills onto a second page rather than off this one.
    if (y > EA_FORM.bottom) newPage();
    put(line, L, y, 7, font, muted);
    y += 9;
  }

  return doc.save();
}
