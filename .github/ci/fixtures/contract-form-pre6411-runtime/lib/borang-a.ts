/**
 * 9c8dad7a — BORANG A (KWSP/EPF monthly contribution form): the form's own model, its +1 dating rule,
 * its carry-forward pagination, and its plain-text rendering. PURE — no DB, no pack, no pdf-lib — so
 * every rule below is unit-testable on its own. That is the same three-way split Borang 8A uses: the
 * read is `localization/my/borang-a.ts`, the drawing is `lib/borang-a-pdf.ts`, and the i-Akaun upload
 * file is `lib/kwsp-borang-a-file.ts`.
 *
 * ── INDEPENDENT OF BORANG 8A, ON PURPOSE ──────────────────────────────────────────────────────────
 * This file shares NOT ONE FUNCTION with `lib/borang-8a.ts`, and the duplication of `money`/`splitRmSen`
 * below is deliberate rather than an oversight. The two forms have OPPOSITE dating rules (see below) and
 * the failure this whole pair guards against is one module quietly acquiring the other's rule through a
 * shared helper that grew a parameter. test/borang-a.test.ts asserts neither file imports the other.
 *
 * ── THE +1 RULE, AND WHY IT IS A RULE RATHER THAN A DEFAULT ───────────────────────────────────────
 * A Borang A's CONTRIBUTION MONTH is the payroll month PLUS ONE — note 6 printed on the form itself
 * ("Bulan caruman bersamaan Bulan Upah + 1"). A Borang 8A for the SAME payroll cycle is stamped the
 * payroll month itself, with no shift. The reporter's own two attachments prove it: both come off the
 * July 2026 payroll, the EPF one is stamped 08/2026 and the SOCSO one 07/2026.
 *
 * The month arithmetic therefore lives in EXACTLY ONE function, `epfContributionPeriodFor`, and December
 * rolls the YEAR — a December 2026 payroll files an 01/2027 Borang A. test/borang-a.test.ts pins that
 * against a table including 2026-12, and test/borang-8a.test.ts now imports this function for the joint
 * assertion that the two forms' periods for one cycle differ by exactly one month and never agree.
 *
 * ── THE PERIOD IS EDITABLE, AND AN OVERRIDE WARNS RATHER THAN BLOCKS ──────────────────────────────
 * Some employers file late or early on purpose. `contributionPeriodOverridden` reports the divergence;
 * nothing here refuses it. What is refused is a MALFORMED period, which would otherwise produce a
 * plausible-looking form stamped with nonsense.
 *
 * ── WHY THIS FORM IS NOT `official` ───────────────────────────────────────────────────────────────
 * The specimen (attachment 2d7d4467, "EPF Borang A.pdf", 93,258 bytes, PDF 1.6, one A4 page, producer
 * "Developer Express Inc. DXperience v23.2.5") is a FILLED OUTPUT from another payroll vendor's engine.
 * It is not KWSP artwork and it carries no form fields, and we hold no KWSP blank to print onto
 * (r411: this used to say KWSP publishes none, which nobody here checked). So there is nothing to
 * overlay: the page is drawn, and the catalog entry declares `agency-layout` —
 * never `official`, which in this codebase means the government's own published page and belongs only to
 * the forms in `MY_OFFICIAL_ARTWORK` (CP22, CP22A, CP21). test/statutory-forms-page.test.ts pins that.
 */

/** One employee's line on the form — the specimen's own columns, in its own order. */
export type BorangARow = {
  /** Not printed. The key readiness and any per-row addressing use. */
  employmentId: string;
  /** No. Ahli — `employee_statutory_my.epf_number`. */
  memberNo: string;
  /**
   * No. Kad Pengenalan — the identity number that APPLIES to the person (r418, item 5c31d379): the IC for a
   * citizen, the MyPR number for a permanent resident, the passport number for a non-citizen. Decided once,
   * in the read, by `statutoryIdentityFor` (localization/my/statutory-identity.ts) — Borang 8A's rule.
   */
  ic: string;
  /** r418 — which document `ic` is: 'ic' | 'mypr' | 'passport', or '' when nothing applicable is on file. */
  idKind: string;
  /**
   * r418 — the IC FIELD as stored, for the KWSP i-Akaun upload file ONLY. Not printed. That file's 02 record
   * has a 12-digit IC field on the only real EPFORMA2 file in this repository and no passport field, so the
   * file keeps carrying what it carried before r418; only the paper form's column changed.
   */
  icNumber: string;
  /** Nama Pekerja. */
  name: string;
  /**
   * Employee/staff number — `employment.employee_code`. NOT on the printed form: it exists because the
   * i-Akaun upload file's 02 record has a 20-character staff-number field, and both outputs are built
   * from this one row so they cannot disagree about who is on the return.
   */
  staffNo: string;
  /** Upah (RM) — the wage EPF was actually CHARGED on. Never gross pay. See `wageRecorded`. */
  wage: number;
  /** Caruman Majikan (RM), taken from the run. */
  employer: number;
  /** Caruman Pekerja (RM), taken from the run. */
  employee: number;
  /**
   * FALSE when the payslip carried no `statutory.bases` stamp (every run before r187), in which case the
   * EPF-liable wage is UNKNOWN — not zero, and emphatically not gross pay.
   *
   * "We do not know what this was charged on" and "it was charged on nothing" are different statements,
   * and a statutory form must not print the second when it means the first. A row with `wageRecorded:
   * false` is named on the review screen and blocks the downloads exactly like a missing member number.
   * MEASURED on production 2026-08-13: 60 of 121 payslips carry the stamp.
   */
  wageRecorded: boolean;
};

/**
 * One printed sheet.
 *
 * CARRY-IN / CARRY-OUT ARE CUMULATIVE RUNNING TOTALS, which is what "Jumlah yang dibawa dari mukasurat
 * terdahulu" / "…ke mukasurat seterusnya" mean on the form: sheet 1 carries in zero, and the LAST
 * sheet's carry-out is the whole form's JUMLAH. `page*` are this sheet's own sums. Both are computed
 * from the rows on the sheet and never apportioned from the form total, which is what makes the
 * no-double-counting property assertable at 1, 2 and 3 pages.
 *
 * The specimen leaves UPAH BLANK on the carry row — only the two contribution columns carry forward —
 * so no carry-in/out wage figure exists here to be printed by mistake.
 *
 * r411 (item 4f45f9b0, the October sample) — ONLY THE CARRY-IN IS PRINTED, and only from sheet 2: there is
 * no carried-forward row on any sheet. `carryOut*` stays because it IS the next sheet's carry-in, and the
 * chain is what the tests assert; it is simply not drawn.
 */
export type BorangAPage = {
  sheet: number;
  of: number;
  rows: BorangARow[];
  /** This sheet's own sums. */
  pageWage: number;
  pageEmployer: number;
  pageEmployee: number;
  /** Cumulative total BEFORE this sheet. Zero on sheet 1. */
  carryInEmployer: number;
  carryInEmployee: number;
  /** Cumulative total AFTER this sheet. Equals the form total on the last sheet. */
  carryOutEmployer: number;
  carryOutEmployee: number;
};

export type BorangAHeader = {
  /** No. Rujukan Majikan — `company_statutory_my.epf_employer_no`. */
  employerRef: string;
  /** Nama Majikan. */
  employerName: string;
  /** Alamat Majikan, one string per printed line. */
  employerAddress: string[];
  /** Bulan Caruman as `MM / YYYY`, for a screen. */
  contributionMonth: string;
  /** Bulan Caruman as `MMYY` — the specimen's own box shows `0826`. */
  contributionMonthCode: string;
  /** The `YYYY-MM` behind the two above. Machine-readable, for the +1 assertions. */
  contributionPeriodKey: string;
  /** The payroll `YYYY-MM` this was generated from. One month BEFORE `contributionPeriodKey`, by rule. */
  payrollPeriodKey: string;
  /** Tarikh DiCetak — `DD/MM/YYYY`, the generation date. */
  printedOn: string;
  /** The authorised representative block at the foot. Operator-owned; see `missingBorangARep`. */
  repName: string;
  repIc: string;
  repPosition: string;
  repPhone: string;
  repEmail: string;
};

export type BorangAForm = BorangAHeader & {
  pages: BorangAPage[];
  /** Jumlah (RM) — Caruman Majikan across the whole form. */
  totalEmployer: number;
  /** Jumlah (RM) — Caruman Pekerja across the whole form. */
  totalEmployee: number;
  /** Amaun Caruman — employer + employee. The specimen's 1,426.00 = 744 + 682. */
  totalContribution: number;
  /** Total Upah. Not a box on the printed form; the upload file's header and trailer both carry it. */
  totalWage: number;
  /** Bil Pekerja. */
  employees: number;
};

/**
 * The header fields the READ must put on `ReportResult.meta.formHeader` and this file must find there.
 *
 * Exported so BOTH halves can be pinned against one list: the defect this exists to stop lives in the
 * contract BETWEEN two files, where a unit test of either half passes throughout.
 */
export const BORANG_A_HEADER_KEYS = [
  'employerRef',
  'employerName',
  'employerAddress',
  'contributionMonth',
  'contributionMonthCode',
  'contributionPeriodKey',
  'payrollPeriodKey',
  'printedOn',
  'repName',
  'repIc',
  'repPosition',
  'repPhone',
  'repEmail',
] as const;

/**
 * Rows per printed sheet. Ours, not the specimen's — the specimen is a ONE-employee form and shows no
 * page break.
 *
 * ⚠️ MEASURED AGAINST THE DRAWN PAGE, NOT CHOSEN. cc9f9420 added the KWSP 6 masthead, the CARA BAYARAN
 * band, the signature/stamp band and the CATATAN block, and every one of them eats vertical space the
 * rows used to have. The renderer publishes its own vertical budget as `BORANG_A_SHEET_GEOMETRY` and
 * `borangASheetRowCapacity()`; test/borang-a.test.ts asserts this number never exceeds it. Raising it
 * past the capacity overprints the CATATAN block — which every static check, `next build` and a 200 all
 * miss, because a PDF that overlaps itself is still a valid PDF.
 *
 * 20 rather than the measured 21: one row of headroom, because the capacity is arithmetic over
 * hand-measured constants and a sheet that overprints its own notes is worse than a sheet that holds one
 * name fewer.
 */
export const BORANG_A_ROWS_PER_PAGE = 20;

/**
 * THE CATATAN BLOCK — the eight numbered notes printed at the foot of the form, in ONE place.
 *
 * ⚠️ PROVENANCE, BECAUSE IT DECIDES WHAT MAY BE CHANGED HERE. These sentences are TRANSCRIBED from the
 * reporter's specimen, which is a filled Borang A produced by another payroll vendor's reporting engine
 * (DevExpress v23.2.5) — not a KWSP page. We hold no KWSP blank (r411: whether KWSP publishes one was
 * never checked, and is no longer claimed), so this is the closest thing to the agency's own wording
 * anybody on this project has been able to obtain, and it is second-hand.
 * The drawn page says exactly that at its foot. If a real KWSP 6 sheet ever arrives, the sentences below
 * are swapped word for word and NOTHING ELSE MOVES — that is why they are an exported array rather than
 * string literals scattered through the renderer.
 *
 * MALAY ONLY, and deliberately so: an English "translation" of a statutory note is our sentence wearing
 * the agency's authority. The English gloss the form does carry is on the PERINGATAN line, where it is
 * labelled as ours.
 *
 * Note 5 is the one the renderer is bound to: the N K column exists to be left empty, and
 * test/borang-a.test.ts asserts the renderer never writes a row value into it.
 */
export const BORANG_A_CATATAN: readonly string[] = [
  'Nombor Majikan mesti ditulis di belakang cek.',
  'Jumlah bayaran mesti sama dengan jumlah di Borang A.',
  'Potong maklumat ahli yang telah berhenti kerja.',
  'Jika ada butir-butir pekerja yang tidak disenaraikan, sila catatkan semua butirnya dan masukkan ' +
    'pekerja baru dalam ruangan kosong (jika ada).',
  'Ruang ketiga (N K) hanya diisi oleh KWSP sahaja.',
  'Bulan caruman bersamaan Bulan Upah + 1.',
  'Upah termasuklah gaji pokok, komisyen, bonus, elaun dan bayaran yang dikenakan caruman KWSP.',
  'Sila rujuk panduan mengisi Borang A di buku Panduan Majikan.',
];

/**
 * The penalty warning under the EPF Act 1991. Malay is the specimen's own sentence; the English line
 * below it is OURS and the form says so, because translating a statutory warning and printing it
 * unattributed is how a plain-language gloss acquires the force of the agency's own words.
 */
export const BORANG_A_PERINGATAN_MS =
  'PERINGATAN : Berdasarkan Akta KWSP 1991, kesilapan membekalkan maklumat ahli boleh menyebabkan tuan ' +
  'dikenakan caj atau tindakan undang-undang.';
export const BORANG_A_PERINGATAN_EN =
  'Our translation, not the agency\'s: under the EPF Act 1991, supplying incorrect member information ' +
  'may render you liable to charges or legal action.';

/**
 * CARA BAYARAN — the payment-method ticks, DRAWN EMPTY on every sheet.
 *
 * r407 (item 4f45f9b0) — TWO TICKS, AS THE KWSP 6 SPECIMEN PRINTS THEM. cc9f9420 split them into five
 * ('Wang Tunai', 'Cek', 'Kiriman Wang', 'Wang Pos', 'Draf Bank') on that item's approved plan. The reporter
 * has since asked, in 4f45f9b0, for the form's "layout, structure, fields, table arrangement, borders,
 * alignment and overall presentation" to follow the sample, and the plan they approved names "the two
 * payment ticks with the cheque / EFT / TT line". The specimen has exactly two: Wang Tunai, and one tick
 * for the instruments (Cek / Kiriman Wang / Wang Pos / Draf Bank) whose number goes on the line under it.
 * That is the agency's grouping, and the latest approved word reverses the earlier one.
 *
 * NEVER PRE-FILLED. Payroll does not know how a filing was paid, and ticking a box here would be inventing
 * a fact about a payment.
 */
export const BORANG_A_PAYMENT_METHODS: readonly string[] = [
  'Wang Tunai',
  'Cek / Kiriman Wang / Wang Pos / Draf Bank',
];

/**
 * The line under the ticks: the cheque / draft / transfer reference, left blank for the operator.
 *
 * It reads as Malay, which the first transcription of it did not: '/Draf Bank*No /EFT /TT. :' printed
 * verbatim on the page, leading slash, inline '*No' and stray full stop included. A Latin-1 round-trip
 * test proves a string survives the font; it cannot tell you the string is gibberish. It is drawn under the
 * second tick (the instruments), where the specimen puts its own reference line.
 */
export const BORANG_A_PAYMENT_REF_LABEL = 'No. Cek / Draf Bank / EFT / TT :';

/** The instruction printed above the ticks, transcribed from the specimen. */
export const BORANG_A_PAYMENT_INSTRUCTION =
  'Jumlah caruman untuk bulan di atas hendaklah dibayar kepada KWSP/Agen Kutipan KWSP sebelum/pada ' +
  '15hb setiap bulan';

/** The regulation citation under the masthead, transcribed from the specimen. */
export const BORANG_A_CITATION = 'PERATURAN-PERATURAN DAN KAEDAH-KAEDAH KWSP 1991 KAEDAH 11(1)';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v: unknown): string => (v == null ? '' : String(v));

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * THE +1 RULE. The contribution month of a Borang A is the payroll month PLUS ONE, rolling the year.
 *
 * The ONLY month arithmetic in this module, written out as a named exported function rather than left
 * inline at each call site, so the rule has somewhere to be asserted and somewhere for a reviewer to see
 * it. Do NOT "simplify" it away: the day it is inlined is the day somebody copies Borang 8A's identity
 * over it and a whole month's contributions are filed against the wrong period.
 */
export function epfContributionPeriodFor(payrollPeriodKey: string): string {
  if (!PERIOD_RE.test(payrollPeriodKey)) {
    throw new Error(`Borang A: payroll period must be YYYY-MM, got "${payrollPeriodKey}"`);
  }
  const y = Number(payrollPeriodKey.slice(0, 4));
  const m = Number(payrollPeriodKey.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** True when `periodKey` is a well-formed `YYYY-MM`. Used to validate an operator's override. */
export function isEpfPeriodKey(periodKey: string): boolean {
  return PERIOD_RE.test(periodKey);
}

/**
 * Did the operator move the contribution month off the rule?
 *
 * A WARNING, NEVER A BLOCK — some employers file late or early on purpose, and the request says so in
 * as many words. The caller shows this; nothing here refuses to produce the form because of it.
 */
export function contributionPeriodOverridden(payrollPeriodKey: string, contributionPeriodKey: string): boolean {
  if (!PERIOD_RE.test(payrollPeriodKey) || !PERIOD_RE.test(contributionPeriodKey)) return false;
  return epfContributionPeriodFor(payrollPeriodKey) !== contributionPeriodKey;
}

/** `2026-08` → `08 / 2026`, for a screen. */
export function contributionMonthLabel(periodKey: string): string {
  if (!PERIOD_RE.test(periodKey)) throw new Error(`Borang A: contribution period must be YYYY-MM, got "${periodKey}"`);
  return `${periodKey.slice(5, 7)} / ${periodKey.slice(0, 4)}`;
}

/** `2026-08` → `0826`. The specimen's own Bulan Caruman box, MMYY with no separator. */
export function contributionMonthCode(periodKey: string): string {
  if (!PERIOD_RE.test(periodKey)) throw new Error(`Borang A: contribution period must be YYYY-MM, got "${periodKey}"`);
  return `${periodKey.slice(5, 7)}${periodKey.slice(2, 4)}`;
}

/** `2026-08-12` → `12/08/2026`. Tarikh DiCetak's own format on the specimen. */
export function formDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** RM with two decimals and thousands separators, for the totals lines. */
export function money(amount: number): string {
  return (Number(amount) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Split the form into sheets, each with its own carry-in, page sums and carry-out.
 *
 * THE NO-DOUBLE-COUNTING PROPERTY, which is what a KWSP counter reconciles and what the request calls
 * out by name: `pages.reduce((a, p) => a + p.pageEmployer, 0) === form.totalEmployer`, the carry chain
 * links (`pages[i].carryIn === pages[i-1].carryOut`), and the LAST sheet's carry-out IS the form total.
 * All three hold at 1, 2 and 3 pages and are pinned in test/borang-a.test.ts.
 *
 * An empty form yields ONE empty sheet rather than zero: "Mukasurat 1/0" is not a thing.
 */
export function paginateBorangA(rows: readonly BorangARow[], perPage = BORANG_A_ROWS_PER_PAGE): BorangAPage[] {
  if (perPage < 1) throw new Error('Borang A: rows per page must be at least 1');
  const chunks: BorangARow[][] = [];
  for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);

  let runEmployer = 0;
  let runEmployee = 0;
  return chunks.map((chunk, i) => {
    const carryInEmployer = runEmployer;
    const carryInEmployee = runEmployee;
    const pageWage = round2(chunk.reduce((a, r) => a + (Number(r.wage) || 0), 0));
    const pageEmployer = round2(chunk.reduce((a, r) => a + (Number(r.employer) || 0), 0));
    const pageEmployee = round2(chunk.reduce((a, r) => a + (Number(r.employee) || 0), 0));
    runEmployer = round2(carryInEmployer + pageEmployer);
    runEmployee = round2(carryInEmployee + pageEmployee);
    return {
      sheet: i + 1,
      of: chunks.length,
      rows: chunk,
      pageWage,
      pageEmployer,
      pageEmployee,
      carryInEmployer,
      carryInEmployee,
      carryOutEmployer: runEmployer,
      carryOutEmployee: runEmployee,
    };
  });
}

/**
 * Which header fields a Borang A cannot be FILED without, and does not have.
 *
 * ⚠️ A REPORT, NOT A THROW — the same lesson Borang 8A learned the hard way in r193. This is called on a
 * RENDER path: a company that has simply never filled in its EPF employer reference must get the screen
 * that TELLS it so, not a 500. Refusing to produce the DOCUMENT is right; refusing to render the page
 * that explains why is not. So gaps are reported here, `loadBorangA` blocks the downloads on them, and
 * the screen names them beside the per-employee readiness list.
 *
 * THE REPRESENTATIVE BLOCK IS NOT IN HERE, deliberately — see `missingBorangARep`.
 * `employerAddress` is excluded too: the form prints however many address lines exist — ALL of them,
 * up to the four `addressLines` can build. The drawn page took the first THREE for one release, which
 * dropped exactly the `postcode city, state` tail, the line a counter clerk reads; both outputs print
 * every line again, and test/borang-a.test.ts renders a four-line address to keep it that way.
 */
export function missingBorangAHeader(header: Record<string, unknown> | null | undefined): string[] {
  const h = header ?? {};
  const required = [
    'employerRef',
    'employerName',
    'contributionMonth',
    'contributionMonthCode',
    'contributionPeriodKey',
    'payrollPeriodKey',
    'printedOn',
  ] as const;
  return required.filter((k) => !str(h[k]).trim());
}

/**
 * The authorised-representative gaps — REPORTED, NEVER BLOCKING, and that split is the whole point.
 *
 * The block at the foot of the form (Nama, No. K/P, Jawatan, No. Tel, E-mel) is operator-owned and lives
 * in `company_statutory_authority` for authority `epf`, with its own admin screen under Organization.
 * MEASURED on production 2026-08-13: ONE row exists across nine companies, and it carries a signatory but
 * no phone and no e-mail.
 *
 * Blocking the download on it would make the feature unusable for eight of nine companies on day one,
 * to enforce a block the agency does not: the specimen leaves the representative's own Tarikh blank, and
 * a Borang A is signed by hand at the counter anyway. So these are surfaced as an advisory beside the
 * blocking list, and the drawn form leaves the box empty rather than inventing a name.
 */
export function missingBorangARep(header: Record<string, unknown> | null | undefined): string[] {
  const h = header ?? {};
  return (['repName', 'repIc', 'repPosition', 'repPhone', 'repEmail'] as const).filter(
    (k) => !str(h[k]).trim(),
  );
}

/**
 * Assemble the printable form from what `reportPreview` returned.
 *
 * Takes PLAIN SHAPES rather than `ReportResult`, deliberately: importing the pack contract here would put
 * lib → localization/country-pack → localization/my/reports → localization/my/borang-a → lib in a cycle.
 * The caller passes `{ header: result.meta.formHeader ?? {}, rows: result.rows }`.
 *
 * TOTAL — it never throws. A gap in the header comes back as an empty string on the form and the CALLER
 * decides what to do about it. This function is on a render path.
 */
export function borangAFrom(p: {
  header: Record<string, unknown> | null | undefined;
  rows: readonly Record<string, unknown>[];
  perPage?: number;
}): BorangAForm {
  const h = p.header ?? {};
  const rows: BorangARow[] = p.rows.map((r) => ({
    employmentId: str(r.employmentId),
    memberNo: str(r.memberNo),
    ic: str(r.ic),
    idKind: str(r.idKind),
    // r418 — ABSENT ⇒ a row shaped before r418, whose `ic` WAS the IC field; the read always sets it (to ''
    // when the person has no IC), so a present-but-empty value never falls back to the printed number.
    icNumber: r.icNumber == null ? str(r.ic) : str(r.icNumber),
    name: str(r.name),
    staffNo: str(r.staffNo),
    wage: round2(Number(r.wage) || 0),
    employer: round2(Number(r.employer) || 0),
    employee: round2(Number(r.employee) || 0),
    // Absent ⇒ NOT recorded. The pessimistic default is deliberate: a row whose provenance was lost in
    // transit must be named on the review screen, not silently printed as if the wage were known.
    wageRecorded: r.wageRecorded === true || r.wageRecorded === 1 || r.wageRecorded === 'yes',
  }));
  const pages = paginateBorangA(rows, p.perPage);
  const totalEmployer = round2(pages.reduce((a, pg) => a + pg.pageEmployer, 0));
  const totalEmployee = round2(pages.reduce((a, pg) => a + pg.pageEmployee, 0));
  return {
    employerRef: str(h.employerRef),
    employerName: str(h.employerName),
    // One string per line. The read joins with '\n' because ReportResult.meta values are scalars.
    employerAddress: str(h.employerAddress)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    contributionMonth: str(h.contributionMonth),
    contributionMonthCode: str(h.contributionMonthCode),
    contributionPeriodKey: str(h.contributionPeriodKey),
    payrollPeriodKey: str(h.payrollPeriodKey),
    printedOn: str(h.printedOn),
    repName: str(h.repName),
    repIc: str(h.repIc),
    repPosition: str(h.repPosition),
    repPhone: str(h.repPhone),
    repEmail: str(h.repEmail),
    pages,
    totalEmployer,
    totalEmployee,
    totalContribution: round2(totalEmployer + totalEmployee),
    totalWage: round2(pages.reduce((a, pg) => a + pg.pageWage, 0)),
    employees: rows.length,
  };
}

/**
 * Re-stamp a built form with a different contribution month — the operator's editable Bulan Caruman.
 *
 * Applied to the FORM rather than passed into the read, so `ReportParams` stays `{companyId, periodKey}`
 * and the pack never learns about a per-generation input. An invalid key is ignored rather than throwing:
 * this sits on a render path, and a junk query string must not 500 the review screen.
 */
export function withContributionPeriod(form: BorangAForm, periodKey: string): BorangAForm {
  if (!PERIOD_RE.test(periodKey) || periodKey === form.contributionPeriodKey) return form;
  return {
    ...form,
    contributionPeriodKey: periodKey,
    contributionMonth: contributionMonthLabel(periodKey),
    contributionMonthCode: contributionMonthCode(periodKey),
  };
}

/** Filename for a download: employer reference + contribution month, safe for a Content-Disposition. */
export function borangAFilename(form: BorangAForm, ext: 'pdf' | 'txt'): string {
  const ref = (form.employerRef || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  const period = form.contributionPeriodKey.replace('-', '');
  return `borang-a-${ref}-${period}.${ext}`;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

/**
 * The same form as plain text, in the order the boxes appear.
 *
 * ⚠️ THIS IS NOT THE i-AKAUN UPLOAD FILE. That is a fixed-width 129-character machine format and lives in
 * `lib/kwsp-borang-a-file.ts` behind its own route. This is the human-readable twin of the drawn page —
 * what an operator reads while keying into i-Akaun by hand, and what they can keep, search and diff month
 * to month. Both this and the PDF come off the SAME `BorangAForm`, so they cannot disagree.
 */
export function borangATextExport(form: BorangAForm): string {
  const L: string[] = [];
  const field = (label: string, value: string) => L.push(`${pad(label, 20)} : ${value}`);

  L.push('BORANG A — CARUMAN BULANAN KWSP (EPF)');
  L.push(`KWSP 6 — ${BORANG_A_CITATION}`);
  L.push('');
  L.push('NOT KWSP ARTWORK. Our own layout, drawn to match the agency form, not the agency\'s own page.');
  L.push('Check every figure before you key or file it.');
  L.push('');
  field('No. Rujukan Majikan', form.employerRef);
  // DRAWN EMPTY ON THE PAGE, AND EMPTY HERE. KWSP issues this reference; payroll cannot know it, and a
  // placeholder that looks like a number is worse than a blank.
  field('No. Rujukan Borang A', '(kosong - untuk diisi oleh tuan)');
  field('Nama Majikan', form.employerName);
  for (const [i, line] of form.employerAddress.entries()) {
    L.push(`${i === 0 ? pad('Alamat', 20) + ' : ' : ' '.repeat(23)}${line}`);
  }
  field('Bulan Caruman', `${form.contributionMonth}  (${form.contributionMonthCode})`);
  field('Bulan Upah', form.payrollPeriodKey);
  field('Tarikh DiCetak', form.printedOn);
  field('Bil Pekerja', String(form.employees));
  field('Amaun Caruman', `RM ${money(form.totalContribution)}`);
  L.push('');

  // CARA BAYARAN — the same ticks the drawn page carries (two since r407, the specimen's own), read off the
  // one array and blank for the same reason.
  L.push('CARA BAYARAN');
  L.push(`  ${BORANG_A_PAYMENT_INSTRUCTION}`);
  for (const m of BORANG_A_PAYMENT_METHODS) L.push(`  [ ] ${m}`);
  L.push(`  ${BORANG_A_PAYMENT_REF_LABEL} ______________________________`);
  L.push('');

  // Bil runs across the WHOLE form. Counted from the sheets themselves rather than multiplied out of
  // BORANG_A_ROWS_PER_PAGE: a caller that passes its own `perPage` would otherwise renumber every sheet
  // but the first, and the drawn page — which counts the same way — would silently disagree with this one.
  let bil = 0;
  for (const page of form.pages) {
    L.push(`Mukasurat ${page.sheet}/${page.of}`);
    L.push(
      pad('BIL', 5) +
        pad('NO. AHLI', 14) +
        // N K — printed and PERMANENTLY EMPTY. Reserved for KWSP (catatan 5). Never populated.
        pad('N K', 4) +
        pad('NO. K/P', 15) +
        pad('NAMA PEKERJA / AHLI', 42) +
        padL('UPAH', 13) +
        padL('MAJIKAN', 13) +
        padL('PEKERJA', 13),
    );
    L.push('-'.repeat(119));
    if (page.sheet > 1) {
      // Contribution columns only — the sample leaves Upah blank on the brought-forward row. Sheet 2 onwards
      // only, as the drawn page (r411).
      L.push(
        pad('', 5) +
          pad('Jumlah yang dibawa dari mukasurat terdahulu (jika ada)', 75) +
          padL('', 13) +
          padL(money(page.carryInEmployer), 13) +
          padL(money(page.carryInEmployee), 13),
      );
    }
    for (const r of page.rows) {
      bil += 1;
      L.push(
        pad(String(bil), 5) +
          pad(r.memberNo, 14) +
          pad('', 4) +
          pad(r.ic, 15) +
          pad(r.name.slice(0, 41), 42) +
          padL(r.wageRecorded ? money(r.wage) : 'NOT RECORDED', 13) +
          padL(money(r.employer), 13) +
          padL(money(r.employee), 13),
      );
    }
    if (page.rows.length === 0) L.push('(tiada pekerja / no employees)');
    L.push('-'.repeat(119));
    // r411 (the October sample) — NO carried-forward line on any sheet, and ONE JUMLAH figure on the last:
    // employer + employee, the header's Amaun Caruman, under the two CARUMAN columns. No wage total.
    if (page.sheet === page.of) {
      L.push(pad('', 5) + pad('', 75) + padL('JUMLAH (RM)', 13) + padL(money(form.totalContribution), 26));
    }
    L.push('');
  }

  L.push(`AMAUN CARUMAN (Majikan + Pekerja) : RM ${money(form.totalContribution)}`);
  L.push('');
  L.push('Tandatangan Wakil Majikan:');
  L.push(`  Nama              : ${form.repName || '—'}`);
  L.push(`  No. Kad Pengenalan: ${form.repIc || '—'}`);
  L.push(`  Jawatan           : ${form.repPosition || '—'}`);
  L.push(`  No. Tel / Bimbit  : ${form.repPhone || '—'}`);
  L.push(`  E-mel             : ${form.repEmail || '—'}`);
  // The representative's own Tarikh is NEVER the print date. It is the date they signed, which has not
  // happened yet when this file is written.
  L.push('  Tarikh            : ____________________');
  L.push('  Tandatangan       : ____________________');
  L.push('');
  L.push('Kotak yang dibiarkan kosong pada borang bercetak / boxes the printed form leaves blank:');
  L.push('  Cop Rasmi Majikan · Cop Agen Kutipan');
  L.push('');
  L.push('CATATAN');
  for (const [i, note] of BORANG_A_CATATAN.entries()) L.push(`  ${i + 1}. ${note}`);
  L.push('');
  L.push(BORANG_A_PERINGATAN_MS);
  L.push(BORANG_A_PERINGATAN_EN);
  L.push('');
  L.push('Nota CATATAN dan PERINGATAN di atas disalin daripada spesimen Borang A yang dijana oleh sistem');
  L.push('penggajian lain, bukan daripada halaman rasmi KWSP. / The CATATAN and PERINGATAN wording above is');
  L.push('transcribed from a Borang A produced by another payroll system, not from a KWSP page.');
  return L.join('\n') + '\n';
}
