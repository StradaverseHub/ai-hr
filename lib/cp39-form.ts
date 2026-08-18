/**
 * e0cd4583 — CP39 PRINTED FORM (LHDN monthly PCB / MTD deduction statement): the form's own model, its
 * dating rule, its pagination and its plain-text rendering. PURE — no DB, no pack, no pdf-lib — so every
 * rule below is unit-testable on its own. Same three-layer split r194 shipped for Borang A: the read is
 * `localization/my/cp39-form.ts`, the drawing is `lib/cp39-form-pdf.ts`, the routes are `app/payroll/cp39/*`.
 *
 * ── THIS IS NOT `localization/my/cp39-file.ts`, AND THE TWO MUST NOT MERGE ────────────────────────
 * That module builds the **e-Data PCB text file** — a fixed-width 57/136-character machine format LHDN's
 * portal ingests. This one builds a page a human reads and signs. They share NOTHING except the figures
 * they are both derived from, and that is deliberate: the file has hard field widths that REFUSE rather
 * than truncate, and the page has none. What they must agree on is arithmetic, and
 * test/cp39-form.test.ts pins that by building both from one row set and comparing the counts and cents.
 *
 * ── THE DEDUCTION MONTH IS THE PAYROLL MONTH ITSELF. NO SHIFT. ────────────────────────────────────
 * A CP39 reports the PCB actually deducted in a payroll month, so its "POTONGAN BAGI BULAN … TAHUN …"
 * is that month, unshifted — which is what `cp39FileForBatch` already does when it splits `periodKey`
 * into year and month (localization/my/cp39-file.ts:223).
 *
 * ⚠️ THE NEIGHBOURING FORM'S RULE IS THE OPPOSITE, AND COPYING IT HERE WOULD BE INVISIBLE. EPF's
 * Borang A files the payroll month PLUS ONE (`epfContributionPeriodFor`, note 6 printed on that form).
 * A CP39 stamped one month forward looks completely normal and is filed against the wrong period. So the
 * identity lives in ONE named exported function, `cp39DeductionPeriodFor`, with somewhere for a reviewer
 * to see it — and test/cp39-form.test.ts imports Borang A's rule to assert the two NEVER agree.
 *
 * ── WHY THIS FORM IS `figures` AND NOT `agency-layout`, LET ALONE `official` ──────────────────────
 * WE HAVE NEVER SEEN THE BORANG CP39 (Pin.2015) ARTWORK. There is no CP39 page in `public/forms/` (the
 * only file there is `cp22-pin-1-2021.pdf`), the ticket's reference PDF is a FILLED SAMPLE from another
 * payroll system, and the two earlier "agency reference" attachments in this repo turned out to be
 * exactly that — DevExpress output from another vendor, not KWSP's or PERKESO's page (HANDOFF, statutory
 * forms). Even those two only earned `agency-layout`. Here there is not even a completed specimen on
 * disk, so every box below is placed from the TICKET'S OWN PROSE list of fields and nothing else.
 *
 * That is the definition of `figures`: every number the form needs, complete, in OUR layout rather than
 * the agency's page. `my.cp39` therefore KEEPS `fidelity: 'figures'` and the drawn page says so on its
 * face. Understating is safe; overstating is the failure the whole fidelity vocabulary exists to stop.
 * Upgrade it the day somebody puts the real artwork in `public/forms/` — not before.
 *
 * ── AND IT IS NOT A SUBMISSION ────────────────────────────────────────────────────────────────────
 * LHDN stopped accepting paper CP39 in September 2019; the filing goes through e-PCB / e-Data PCB /
 * e-CP39. This page is for internal record-keeping and as a payment cover document, which is what the
 * request asks for, and the page and the text export both say it in as many words.
 */

/** One employee's line on the statement — the ticket's own columns, in its own order. */
export type Cp39FormRow = {
  /** Not printed. React keys, and matching a row to the readiness list. */
  employmentId: string;
  /** No. Cukai Pendapatan — `employee_statutory_my.tax_number` (today labelled "Tax number"). */
  tin: string;
  /** Nama Penuh Pekerja. */
  name: string;
  /**
   * No. K/P Lama.
   *
   * ⚠️ ALWAYS EMPTY, AND THAT IS A DATA FACT, NOT AN OVERSIGHT. There is no old-IC column anywhere in
   * the schema — `employee_statutory_my` carries `ic_number` and a passport block and nothing else — and
   * the approved plan says to leave it blank rather than invent one. The e-Data PCB file already leaves
   * the same field blank (`cp39-file.ts`, `oldIc` is never passed). Kept as a FIELD rather than dropped
   * so the printed column has something to render and the reason has somewhere to live.
   */
  oldIc: string;
  /** No. K/P Baru — `employee_statutory_my.ic_number`. */
  newIc: string;
  /** No. Pekerja — `employment.employee_code`. */
  employeeNo: string;
  /** No. Pasport — `employee_statutory_my.passport_number`. */
  passport: string;
  /**
   * Kod Negara.
   *
   * ⚠️ ALWAYS EMPTY, for the same reason and by the same approved decision. We store the passport's
   * ISSUING COUNTRY as free text from an international picker (`passport_issuing_country`), never as the
   * two-letter code this column wants, and there is no name→ISO-2 helper anywhere in the repo. Mapping
   * free text to a statutory country code by guesswork would put a wrong code on a tax document; blank
   * is the honest answer and is what the plan was approved with.
   */
  countryCode: string;
  /** PCB (RM) — `payslip.statutory.pcb`, summed across the month's runs. */
  pcb: number;
  /** CP38 (RM) — `payslip.statutory.cp38`, the LHDN/court instalment, distinct from PCB. */
  cp38: number;
};

/**
 * One printed sheet of the employee table.
 *
 * PAGE SUMS ONLY — there is no carry-forward on this form. Borang A carries cumulative totals from sheet
 * to sheet because its own specimen has boxes for them; the CP39 the ticket describes has a JUMLAH per
 * page and a JUMLAH BESAR on the last, which is a different structure. `pagePcb`/`pageCp38` are computed
 * from the rows ON THIS SHEET and the form total is the sum OF THE PAGES, never apportioned the other
 * way — that is what makes "no page double-counts" assertable at one, two and three sheets.
 */
export type Cp39FormPage = {
  sheet: number;
  of: number;
  rows: Cp39FormRow[];
  /** JUMLAH for this sheet. */
  pagePcb: number;
  pageCp38: number;
  /** PCB + CP38 for this sheet. */
  pageTotal: number;
};

export type Cp39FormHeader = {
  /** No. Majikan — `company_statutory_my.lhdn_employer_no`, the employer "E" number. */
  employerNo: string;
  /** No. Pendaftaran Perniagaan — `company_statutory_my.ssm_registration_no`. */
  registrationNo: string;
  /** Nama Syarikat / Perniagaan — `company.legal_name`. */
  employerName: string;
  /** Alamat Syarikat / Perniagaan, one string per printed line. */
  employerAddress: string[];
  /** The payroll `YYYY-MM` this statement covers. UNSHIFTED — see `cp39DeductionPeriodFor`. */
  deductionPeriodKey: string;
  /** BULAN, in Bahasa Malaysia and upper case: `JANUARI`. */
  deductionMonth: string;
  /** The same month as `MM`, for a compact box. */
  deductionMonthNo: string;
  /** TAHUN — `2026`. */
  deductionYear: string;
  /** Tarikh dicetak — `DD/MM/YYYY`, the generation date in Malaysian time. */
  printedOn: string;
  /** PEGAWAI YANG MENYEDIAKAN MAKLUMAT. Operator-owned; see `missingCp39Preparer`. */
  preparerName: string;
  preparerIc: string;
  preparerPosition: string;
  preparerPhone: string;
};

export type Cp39Form = Cp39FormHeader & {
  /**
   * BUTIR-BUTIR PEMBAYARAN — the payment instrument: `No. Cek / Draf Bank / Wang Pos` and `Cawangan`.
   *
   * NOT PART OF `Cp39FormHeader` AND NOT ON `CP39_FORM_HEADER_KEYS`, deliberately: nothing in the
   * database can produce either of them, so a read that "must set every header key" must not be asked to
   * set these. They are OPERATOR-TYPED on the review screen, arrive through `withPaymentInstrument`, and
   * default to '' — a blank prints the ruled line the request asks for, exactly as before they were
   * typeable. Never persisted: like the preparer overrides they belong to ONE generation of ONE
   * statement, and a cheque number kept on a company record would be wrong the following month.
   */
  paymentRef: string;
  paymentBranch: string;
  pages: Cp39FormPage[];
  /** Jumlah Potongan PCB across the whole statement. */
  totalPcb: number;
  /** Jumlah Potongan CP38 across the whole statement. */
  totalCp38: number;
  /** Amaun — PCB + CP38, the figure the payment is made for. */
  totalAmount: number;
  /**
   * Bilangan Pekerja, SEPARATELY for the two deductions, because the form asks for two numbers and they
   * are usually different: nearly everybody has PCB and almost nobody has a CP38 instalment.
   *
   * COUNTED THE WAY THE e-DATA FILE COUNTS ITS RECORDS — a row counts when its own amount is greater
   * than zero (`cp39-file.ts:105-107`). Reusing that rule rather than inventing a second one is what
   * lets test/cp39-form.test.ts assert the printed statement and the uploaded file report the same two
   * counts for the same month; two rules would drift the first time one of them was "tidied".
   */
  pcbEmployees: number;
  cp38Employees: number;
  /** Everybody the run paid, whether or not they were deducted anything. Not a box on the form. */
  employees: number;
};

/**
 * The header fields the READ must put on `ReportResult.meta.formHeader` and this file must find there.
 *
 * Exported so BOTH halves can be pinned against one list: the defect this exists to stop lives in the
 * contract BETWEEN two files, where a unit test of either half passes throughout (AGENTS rule 17).
 */
export const CP39_FORM_HEADER_KEYS = [
  'employerNo',
  'registrationNo',
  'employerName',
  'employerAddress',
  'deductionPeriodKey',
  'deductionMonth',
  'deductionMonthNo',
  'deductionYear',
  'printedOn',
  'preparerName',
  'preparerIc',
  'preparerPosition',
  'preparerPhone',
] as const;

/**
 * Rows per printed sheet of the employee table. Ours — we have no artwork to count rows off.
 * 26 leaves room for the repeated employer/period strip, the ten column headings and the JUMLAH line.
 */
export const CP39_FORM_ROWS_PER_PAGE = 26;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v: unknown): string => (v == null ? '' : String(v));

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Bahasa Malaysia month names, upper case, as the form's own BULAN box wants them.
 *
 * NOT `Intl.DateTimeFormat(locale)`. The printed form is a Malaysian statutory document and its month is
 * always in Malay whatever language the operator is reading the screen in — running it through the
 * viewer's locale would put `一月` on a CP39 for a Chinese-language user.
 */
const MS_MONTHS = [
  'JANUARI',
  'FEBRUARI',
  'MAC',
  'APRIL',
  'MEI',
  'JUN',
  'JULAI',
  'OGOS',
  'SEPTEMBER',
  'OKTOBER',
  'NOVEMBER',
  'DISEMBER',
] as const;

/**
 * THE DATING RULE: a CP39's deduction month IS the payroll month. Identity, not arithmetic.
 *
 * A function rather than an inline `params.periodKey`, and exported rather than private, for one reason:
 * it gives the rule a name, a place to be asserted, and a place for the next person to read WHY it is
 * not the +1 that the EPF form beside it uses. Do not "simplify" it away — the day it disappears is the
 * day somebody copies `epfContributionPeriodFor` over it and a month's PCB is reported against the wrong
 * period, on a page that looks entirely normal.
 *
 * It still VALIDATES: `2026-13` would otherwise produce a plausible-looking empty statement stamped with
 * nonsense, which is the failure mode `borangAReport` guards the same way.
 */
export function cp39DeductionPeriodFor(payrollPeriodKey: string): string {
  if (!PERIOD_RE.test(payrollPeriodKey)) {
    throw new Error(`CP39: payroll period must be YYYY-MM, got "${payrollPeriodKey}"`);
  }
  return payrollPeriodKey;
}

/** True when `periodKey` is a well-formed `YYYY-MM`. */
export function isCp39PeriodKey(periodKey: string): boolean {
  return PERIOD_RE.test(periodKey);
}

/** `2026-01` → `JANUARI`. Throws on a malformed key rather than printing `undefined` on a tax document. */
export function deductionMonthLabel(periodKey: string): string {
  if (!PERIOD_RE.test(periodKey)) throw new Error(`CP39: deduction period must be YYYY-MM, got "${periodKey}"`);
  return MS_MONTHS[Number(periodKey.slice(5, 7)) - 1];
}

/** `2026-08-12` → `12/08/2026`. */
export function formDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/**
 * RM with two decimals and thousands separators.
 *
 * DUPLICATED FROM `lib/borang-a.ts` ON PURPOSE, exactly as that file duplicates it from `lib/borang-8a.ts`
 * and says so. The three forms have different dating rules and different totals structures, and the
 * failure this pattern guards against is one module quietly acquiring another's rule through a shared
 * helper that grew a parameter. test/cp39-form.test.ts asserts this file imports none of the other two.
 */
export function money(amount: number): string {
  return (Number(amount) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Split the employee table into sheets, each with its own JUMLAH.
 *
 * THE NO-DOUBLE-COUNTING PROPERTY, which is what the request calls out by name: the JUMLAH BESAR is the
 * SUM OF THE PAGE JUMLAHs (`pages.reduce((a, p) => a + p.pagePcb, 0) === form.totalPcb`), every row
 * appears on exactly one sheet, and the sheet numbering is contiguous. All of it holds at one, two and
 * three pages and is pinned in test/cp39-form.test.ts without a PDF in sight.
 *
 * An empty statement yields ONE empty sheet rather than zero: "Muka surat 1/0" is not a thing.
 */
export function paginateCp39(rows: readonly Cp39FormRow[], perPage = CP39_FORM_ROWS_PER_PAGE): Cp39FormPage[] {
  if (perPage < 1) throw new Error('CP39: rows per page must be at least 1');
  const chunks: Cp39FormRow[][] = [];
  for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);
  return chunks.map((chunk, i) => {
    const pagePcb = round2(chunk.reduce((a, r) => a + (Number(r.pcb) || 0), 0));
    const pageCp38 = round2(chunk.reduce((a, r) => a + (Number(r.cp38) || 0), 0));
    return {
      sheet: i + 1,
      of: chunks.length,
      rows: chunk,
      pagePcb,
      pageCp38,
      pageTotal: round2(pagePcb + pageCp38),
    };
  });
}

/**
 * Which header fields a CP39 cannot be PRODUCED without, and does not have.
 *
 * ⚠️ A REPORT, NOT A THROW — the same lesson Borang 8A learned the hard way in r193 and Borang A restates.
 * This is called on a RENDER path: a company that has never filled in its LHDN employer number must get
 * the screen that TELLS it so, not a 500.
 *
 * `registrationNo` and `employerAddress` are DELIBERATELY NOT REQUIRED. The business registration number
 * is a box on the form, not a thing the statement is invalid without, and the address prints however many
 * lines exist. The preparer block is not in here either — see `missingCp39Preparer`.
 */
export function missingCp39FormHeader(header: Record<string, unknown> | null | undefined): string[] {
  const h = header ?? {};
  const required = [
    'employerNo',
    'employerName',
    'deductionPeriodKey',
    'deductionMonth',
    'deductionYear',
    'printedOn',
  ] as const;
  return required.filter((k) => !str(h[k]).trim());
}

/**
 * The preparer block's gaps — REPORTED, NEVER BLOCKING, and that split is the whole point.
 *
 * PEGAWAI YANG MENYEDIAKAN MAKLUMAT (Nama Penuh, No. Pengenalan, Jawatan, No. Telefon) is operator-owned:
 * it defaults from `company_statutory_authority` for authority `lhdn` and is editable on the preview
 * screen. Blocking the download on it would make the feature unusable on day one to enforce a rule
 * nothing enforces — the page is signed by hand anyway, and the request itself says the signature is left
 * blank. So gaps are surfaced as an advisory and the drawn form prints a rule to write on rather than
 * inventing a name.
 */
export function missingCp39Preparer(header: Record<string, unknown> | null | undefined): string[] {
  const h = header ?? {};
  return (['preparerName', 'preparerIc', 'preparerPosition', 'preparerPhone'] as const).filter(
    (k) => !str(h[k]).trim(),
  );
}

/**
 * Assemble the printable statement from what `reportPreview` returned.
 *
 * Takes PLAIN SHAPES rather than `ReportResult`, deliberately: importing the pack contract here would put
 * lib → localization/country-pack → localization/my/reports → localization/my/cp39-form → lib in a cycle.
 * The caller passes `{ header: result.meta.formHeader ?? {}, rows: result.rows }`.
 *
 * TOTAL — it never throws. A gap in the header comes back as an empty string and the CALLER decides what
 * to do about it. This function is on a render path.
 */
export function cp39FormFrom(p: {
  header: Record<string, unknown> | null | undefined;
  rows: readonly Record<string, unknown>[];
  perPage?: number;
}): Cp39Form {
  const h = p.header ?? {};
  const rows: Cp39FormRow[] = p.rows.map((r) => ({
    employmentId: str(r.employmentId),
    tin: str(r.tin ?? r.taxNo),
    name: str(r.name),
    // Read, not hardcoded, so the read stays the single source of the blank and this file has no opinion
    // about WHY it is blank — but see the field docs above: nothing can currently populate either.
    oldIc: str(r.oldIc),
    newIc: str(r.newIc ?? r.ic),
    employeeNo: str(r.employeeNo),
    passport: str(r.passport),
    countryCode: str(r.countryCode),
    pcb: round2(Number(r.pcb) || 0),
    cp38: round2(Number(r.cp38) || 0),
  }));
  const pages = paginateCp39(rows, p.perPage);
  const totalPcb = round2(pages.reduce((a, pg) => a + pg.pagePcb, 0));
  const totalCp38 = round2(pages.reduce((a, pg) => a + pg.pageCp38, 0));
  return {
    employerNo: str(h.employerNo),
    registrationNo: str(h.registrationNo),
    employerName: str(h.employerName),
    // One string per line. The read joins with '\n' because ReportResult.meta values are scalars.
    employerAddress: str(h.employerAddress)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    deductionPeriodKey: str(h.deductionPeriodKey),
    deductionMonth: str(h.deductionMonth),
    deductionMonthNo: str(h.deductionMonthNo),
    deductionYear: str(h.deductionYear),
    printedOn: str(h.printedOn),
    preparerName: str(h.preparerName),
    preparerIc: str(h.preparerIc),
    preparerPosition: str(h.preparerPosition),
    preparerPhone: str(h.preparerPhone),
    // Always blank HERE. The read cannot know a cheque number; `withPaymentInstrument` is where the
    // operator's typed value lands, and a statement nobody typed one into keeps the ruled line.
    paymentRef: '',
    paymentBranch: '',
    pages,
    totalPcb,
    totalCp38,
    totalAmount: round2(totalPcb + totalCp38),
    // The e-Data file's own rule, restated once: a row counts when its own amount is non-zero.
    pcbEmployees: rows.filter((r) => r.pcb > 0).length,
    cp38Employees: rows.filter((r) => r.cp38 > 0).length,
    employees: rows.length,
  };
}

/**
 * Re-stamp a built statement with the operator's preparer block and print date.
 *
 * Applied to the FORM rather than passed into the read, so `ReportParams` stays `{companyId, periodKey}`
 * and the pack never learns about a per-generation input — the same seam `withContributionPeriod` uses on
 * Borang A. A field the operator left alone keeps whatever the read defaulted it to; **an empty string is
 * "leave it as it was", not "clear it"**, because these boxes are pre-filled from the company record and
 * a blank submitted box would otherwise wipe a correct default on every page load.
 *
 * A malformed date is IGNORED rather than thrown: this sits on a render path and a junk query string must
 * not 500 the review screen.
 */
export function withPreparer(
  form: Cp39Form,
  patch: {
    preparerName?: string;
    preparerIc?: string;
    preparerPosition?: string;
    preparerPhone?: string;
    /** ISO `YYYY-MM-DD`; anything else is ignored and the default print date stands. */
    printedOnIso?: string;
  },
): Cp39Form {
  const pick = (next: string | undefined, current: string) => (next && next.trim() ? next.trim() : current);
  const printed = formDate(patch.printedOnIso);
  return {
    ...form,
    preparerName: pick(patch.preparerName, form.preparerName),
    preparerIc: pick(patch.preparerIc, form.preparerIc),
    preparerPosition: pick(patch.preparerPosition, form.preparerPosition),
    preparerPhone: pick(patch.preparerPhone, form.preparerPhone),
    printedOn: printed || form.printedOn,
  };
}

/**
 * Stamp a built statement with the payment instrument the operator typed on the review screen.
 *
 * ── WHY THIS IS A SECOND FUNCTION AND NOT TWO MORE KEYS ON `withPreparer` ─────────────────────────
 * THE BLANK RULE IS THE OPPOSITE ONE. Every preparer box is PRE-FILLED from the company's LHDN
 * authority record, so an empty submitted box there has to mean "keep the default" or a page load would
 * wipe a correct name (AGENTS rule 17). These two have NO default and never can — nothing in the
 * database knows a cheque number — so an empty box here means exactly what it says: leave the ruled
 * line blank and write on it at the counter. Folding them into `withPreparer` would put two opposite
 * readings of "" inside one helper, which is how the wrong one gets applied to the wrong field.
 *
 * TRIMMED, NEVER PERSISTED, AND NEVER DERIVED. The value belongs to one generation of one statement:
 * the PDF, the text twin and the review screen all take it from here, so the three cannot disagree.
 */
export function withPaymentInstrument(
  form: Cp39Form,
  patch: { paymentRef?: string; paymentBranch?: string },
): Cp39Form {
  return {
    ...form,
    paymentRef: (patch.paymentRef ?? '').trim(),
    paymentBranch: (patch.paymentBranch ?? '').trim(),
  };
}

/** Filename for a download: employer number + deduction month, safe for a Content-Disposition. */
export function cp39FormFilename(form: Cp39Form, ext: 'pdf' | 'txt'): string {
  const ref = (form.employerNo || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  const period = form.deductionPeriodKey.replace('-', '');
  return `cp39-${ref}-${period}.${ext}`;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

/**
 * The same statement as plain text, in the order the boxes appear.
 *
 * ⚠️ THIS IS NOT THE e-DATA PCB UPLOAD FILE. That is the fixed-width 57/136-character machine format and
 * it lives in `localization/my/cp39-file.ts` behind `/payroll/reports/cp39-file`. This is the
 * human-readable twin of the drawn page — what an operator reads while keying into e-PCB by hand, and
 * what they can keep, search and diff month to month. Both this and the PDF come off the SAME `Cp39Form`,
 * so they cannot disagree.
 */
export function cp39FormTextExport(form: Cp39Form): string {
  const L: string[] = [];
  L.push('CP39 — PENYATA POTONGAN CUKAI BULANAN (PCB) OLEH MAJIKAN');
  L.push('Seksyen 107, Akta Cukai Pendapatan 1967');
  L.push('');
  L.push('OUR OWN LAYOUT, NOT LHDN ARTWORK. We hold no copy of the Borang CP39 (Pin.2015) page, so the');
  L.push('boxes below are placed from the field list, not from the agency form. FOR INTERNAL RECORDS AND');
  L.push('AS A PAYMENT COVER DOCUMENT ONLY — LHDN does not accept a paper CP39; file through e-PCB /');
  L.push('e-Data PCB / e-CP39. The agency’s own printed A / B / C notes are NOT reproduced here.');
  L.push('');
  L.push('BUTIR-BUTIR MAJIKAN');
  L.push(`  No. Majikan (E)              : ${form.employerNo || '—'}`);
  L.push(`  No. Pendaftaran Perniagaan   : ${form.registrationNo || '—'}`);
  L.push(`  Nama Syarikat / Perniagaan   : ${form.employerName || '—'}`);
  for (const [i, line] of form.employerAddress.entries()) {
    L.push(`${i === 0 ? '  Alamat                       : ' : '                                 '}${line}`);
  }
  L.push('');
  L.push(`POTONGAN BAGI BULAN ${form.deductionMonth} TAHUN ${form.deductionYear}`);
  L.push(`  Tarikh dicetak               : ${form.printedOn}`);
  L.push('');
  L.push('BUTIR-BUTIR PEMBAYARAN');
  L.push(`  Jumlah Potongan PCB          : ${padL(String(form.pcbEmployees), 4)} pekerja   RM ${money(form.totalPcb)}`);
  L.push(`  Jumlah Potongan CP38         : ${padL(String(form.cp38Employees), 4)} pekerja   RM ${money(form.totalCp38)}`);
  L.push(`  AMAUN                        :                  RM ${money(form.totalAmount)}`);
  // Typed on the review screen when the operator has the instrument in front of them, a ruled blank to
  // write on when they do not. The rule is the SAME on the drawn page — one value, two renderings.
  const written = (v: string) => (v ? pad(v, 22) : '______________________');
  L.push(
    `  No. Cek / Draf Bank / Wang Pos : ${written(form.paymentRef)}  Cawangan : ${written(form.paymentBranch)}`,
  );
  L.push('');

  for (const page of form.pages) {
    L.push(`Muka surat ${page.sheet}/${page.of}`);
    L.push(
      pad('BIL', 5) +
        pad('NO. CUKAI', 15) +
        pad('NAMA PENUH PEKERJA', 38) +
        pad('K/P LAMA', 14) +
        pad('K/P BARU', 14) +
        pad('NO. PEKERJA', 13) +
        pad('PASPORT', 13) +
        pad('KOD', 5) +
        padL('PCB (RM)', 12) +
        padL('CP38 (RM)', 12),
    );
    L.push('-'.repeat(141));
    let bil = form.pages.slice(0, page.sheet - 1).reduce((a, p) => a + p.rows.length, 0);
    for (const r of page.rows) {
      bil += 1;
      L.push(
        pad(String(bil), 5) +
          pad(r.tin.slice(0, 14), 15) +
          pad(r.name.slice(0, 37), 38) +
          pad(r.oldIc.slice(0, 13), 14) +
          pad(r.newIc.slice(0, 13), 14) +
          pad(r.employeeNo.slice(0, 12), 13) +
          pad(r.passport.slice(0, 12), 13) +
          pad(r.countryCode.slice(0, 4), 5) +
          padL(money(r.pcb), 12) +
          padL(money(r.cp38), 12),
      );
    }
    if (page.rows.length === 0) L.push('(tiada pekerja / no employees)');
    L.push('-'.repeat(141));
    L.push(
      pad('', 5) +
        pad(`JUMLAH (muka surat ${page.sheet})`, 112) +
        padL(money(page.pagePcb), 12) +
        padL(money(page.pageCp38), 12),
    );
    // JUMLAH BESAR ON THE LAST SHEET ONLY: repeating it is how a multi-page statement gets filed with a
    // page total mistaken for the grand total.
    if (page.sheet === page.of) {
      L.push(pad('', 5) + pad('JUMLAH BESAR', 112) + padL(money(form.totalPcb), 12) + padL(money(form.totalCp38), 12));
    }
    L.push('');
  }

  L.push(`AMAUN (PCB + CP38) : RM ${money(form.totalAmount)}`);
  L.push('');
  L.push('PEGAWAI YANG MENYEDIAKAN MAKLUMAT:');
  L.push(`  Nama Penuh     : ${form.preparerName || '—'}`);
  L.push(`  No. Pengenalan : ${form.preparerIc || '—'}`);
  L.push(`  Jawatan        : ${form.preparerPosition || '—'}`);
  L.push(`  No. Telefon    : ${form.preparerPhone || '—'}`);
  L.push('');
  // NAMES WHAT IS STILL BLANK, not what is blank by category. The payment instrument moved above the
  // line when it was made typeable, so listing it here unconditionally would tell an operator who had
  // just typed a cheque number that it was left out.
  const stillBlank = [
    form.paymentRef ? null : 'No. Cek / Draf Bank / Wang Pos',
    form.paymentBranch ? null : 'Cawangan',
    'Tandatangan',
  ].filter(Boolean);
  L.push('Left blank on purpose — these are yours to complete by hand, never payroll-derived:');
  L.push(`  ${stillBlank.join(' · ')}`);
  L.push('');
  L.push('Columns we cannot fill and do not guess:');
  L.push('  No. K/P Lama — no old-identity-card field exists on the staff record.');
  L.push('  Kod Negara   — the passport’s issuing country is stored as free text, not a 2-letter code.');
  return L.join('\n') + '\n';
}
