/**
 * 8ca344bf — BORANG 8A (PERKESO monthly contribution schedule): the form's own model, its two dating
 * rules, its pagination, and its plain-text rendering. PURE — no DB, no pack, no pdf-lib — so every rule
 * below is unit-testable on its own, which is the whole reason this file exists separately from the read
 * (localization/my/borang-8a.ts) and from the drawing (lib/borang-8a-pdf.ts).
 *
 * ── WHY THIS FORM IS NOT `official`, SAID HERE AS WELL AS ON THE SHELF ──────────────────────────────
 * The first specimens we built against (attachments 91ce0f6a and 16f2aac1) are FILLED OUTPUT from another
 * payroll vendor's engine (producer "Developer Express Inc. DXperience v23.2.5"), not PERKESO artwork.
 *
 * r408 (item e74af58c) — PERKESO DOES PUBLISH A BLANK BORANG 8A, and this header used to say it did not.
 * The reporter linked it from PERKESO's own website: a two-page A4 PDF (producer "doPDF Ver 7.3", created
 * 1 July 2013). Page 1 is the form; page 2 is "PANDUAN MENGISI BORANG 8A", whose guidance still quotes the
 * 2013 rules (an RM3,000 wage line), and page 1 carries OCR form ids and the logo. So the page is still
 * DRAWN, not printed onto: lib/borang-8a-pdf.ts reproduces page 1's boxes, measured from that file, and
 * deliberately leaves out page 2, the OCR ids and the logo. The catalog entry stays `agency-layout` — the
 * layout is the agency's, the paper is ours — and never `official`, which in this codebase means the
 * government's own page and belongs only to `MY_OFFICIAL_ARTWORK` (CP22, CP22A). The blank is NOT
 * committed to `public/forms/`.
 *
 * ── THE NO-OFFSET RULE, AND WHY IT IS A RULE RATHER THAN A DEFAULT ─────────────────────────────────
 * A Borang 8A's contribution month IS the payroll month. KWSP's Borang A, for the same payroll cycle, is
 * stamped the month AFTER. The reporter's own two attachments prove it: both come off the July 2026
 * payroll, the SOCSO one is stamped 07/2026 and the EPF one 08/2026. The failure this guards against is a
 * copy-paste from the KWSP module — so there is NO month arithmetic anywhere in this file, and
 * `contributionPeriodFor` is the identity on purpose rather than by accident. test/borang-8a.test.ts pins
 * it against a table of cycles (including 2026-12, where a stray `+1` shows up most visibly) and fails if
 * the SOCSO and EPF periods for one cycle ever agree.
 *
 * ── THE DUE DATE ──────────────────────────────────────────────────────────────────────────────────
 * THE 15TH OF THE MONTH AFTER THE CONTRIBUTION MONTH. PERKESO's own 2025 employer booklet ("Perlindungan
 * Keselamatan Sosial | PERKESO", section Caruman → "Tempoh Pembayaran Caruman", printed page 9): "Caruman
 * hendaklah dibayar tidak lewat daripada 15 hari bulan bagi caruman bulan sebelumnya (contoh; caruman bulan
 * Januari 2025 hendaklah dibayar tidak lewat daripada 15 Februari 2025)".
 *
 * ⚠️ r408 (item e74af58c) CORRECTED THIS. From 8ca344bf to r407 it was the LAST DAY of the contribution
 * month, copied from a vendor's filled specimen ("tidak lewat daripada 31/07/2026" on a 07/2026 form). That
 * was PERKESO's temporary COVID relief — Pekeliling Majikan Bil. 4 Tahun 2020, which moved the deadline to
 * the last day of the month for the April to September 2020 contributions ONLY. (The circular is cited from
 * the approved plan; its text is not held in this repository.) It is no rule today.
 *
 * The deadline moves a DAY into the next month; the CONTRIBUTION month the form is stamped with never moves
 * (the no-offset rule above). Those are different facts, and only the first one changed.
 */
/** One employee's line on the schedule. `contribution` is RM, already taken from the run. */
export type Borang8ARow = {
  /** Not printed — the key a typed STATUS override is addressed by. */
  employmentId: string;
  /**
   * Column (1) TARIKH MULA/BERHENTI KERJA (hhbbtttt) — ONE column on the form (16f2aac1), carrying two
   * fixed slots. `ddmmyyyy`, blank unless they joined inside the contribution month.
   */
  startDate: string;
  /** Column (1)'s second slot: berhenti. `ddmmyyyy`, blank unless they left inside the contribution month. */
  stopDate: string;
  /** Column (2) STATUS — blank for a continuing employee, exactly as the specimen leaves it. */
  status: string;
  /** Column (3) NO. KAD PENGENALAN. */
  ic: string;
  /** Column (4) NAMA PEKERJA (MENGIKUT KAD PENGENALAN). */
  name: string;
  /** Column (5) Caruman, in RM. */
  contribution: number;
  /**
   * 18c1d92b — THE FOUR LEGS AND THE WAGE, for the PERKESO ASSIST upload file only. NOT printed on the
   * paper form, which has one combined column and is unchanged by their presence.
   *
   * `contribution` stays the SOCSO pair added together because that is what column (5) is; these are the
   * same figures kept apart. `wage` is `statutory.bases.socsoEis` and is NULL on a payslip written before
   * r187 stamped it — the file refuses such an employee by name rather than substituting gross pay.
   */
  socsoEmployer: number;
  socsoEmployee: number;
  eisEmployer: number;
  eisEmployee: number;
  wage: number | null;
  /**
   * r296 — THE FIFTH LEG, carried for the upload file and printed nowhere.
   *
   * SKBBK / Lindung 24 Jam is an EMPLOYEE-only leg, mandatory since 1 June 2026, and the paper Borang 8A
   * has no column for it — the read already says so in its reconciliation strip ("SKBBK — not on this
   * form"). It rides here because PERKESO's v2.0 upload file DOES have a box for it from 1 October 2026,
   * and the file is built from these rows. Adding it changes nothing about the printed form.
   */
  skbbk: number;
};

/** One printed sheet: its rows, its own "Jumlah muka surat ini", and its Lembaran n/N. */
export type Borang8APage = {
  sheet: number;
  of: number;
  rows: Borang8ARow[];
  /** The sum of THIS sheet's contributions. The sheets' totals sum to `Borang8AForm.total`. */
  pageTotal: number;
};

export type Borang8AHeader = {
  /** No. Kod Majikan — company_statutory_my.socso_employer_code. */
  employerCode: string;
  /** MyCoID / No. Pendaftaran — company_statutory_my.ssm_registration_no (blank in the specimen). */
  mycoid: string;
  /** Nama Majikan. */
  employerName: string;
  /** Alamat Majikan, one line per element. */
  employerAddress: string[];
  /** CARUMAN GAJI BULAN, as `MM / YYYY`. */
  contributionMonth: string;
  /** The `YYYY-MM` behind `contributionMonth` — machine-readable, for the no-offset assertions. */
  contributionPeriodKey: string;
  /** The payroll `YYYY-MM` this was generated from. Equal to `contributionPeriodKey`, by the rule above. */
  payrollPeriodKey: string;
  /** Bayaran tidak lewat daripada — `DD/MM/YYYY`, the 15th of the month after the contribution month. */
  paymentDueDate: string;
};

export type Borang8AForm = Borang8AHeader & {
  pages: Borang8APage[];
  /** Amaun Caruman — the whole form's total. Equals the sum of every page total. */
  total: number;
  /** Bil. Pekerja — the whole form's employee count. */
  employees: number;
};

/**
 * The header fields the READ (localization/my/borang-8a.ts) must put on `ReportResult.meta.formHeader`
 * and this file must find there. Exported so BOTH halves can be pinned against one list: the defect this
 * exists to stop lives in the contract between the two files, where a unit test of either half passes.
 */
export const BORANG_8A_HEADER_KEYS = [
  'employerCode',
  'mycoid',
  'employerName',
  'employerAddress',
  'contributionMonth',
  'contributionPeriodKey',
  'payrollPeriodKey',
  'paymentDueDate',
] as const;

/** Rows per printed sheet: PERKESO's own Borang 8A page 1 rules exactly TWENTY employee lines (r408,
 *  measured from the agency's blank: 20 rows at a 19.4pt pitch between the heading band and "Jumlah muka
 *  surat ini"). A sheet that held more or fewer would not be the agency's sheet. */
export const BORANG_8A_ROWS_PER_PAGE = 20;

/** The prefix a typed per-row STATUS override arrives under, e.g. `st_<employmentId>=BARU`. */
export const BORANG_8A_STATUS_PARAM_PREFIX = 'st_';
/** PERKESO's column (2) codes, from page 2 of the agency's blank Borang 8A. */
export const BORANG_8A_STATUS_CODES: ReadonlySet<string> = new Set(['M', 'B', 'H', 'S', 'T']);

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * THE NO-OFFSET RULE. The contribution month of a Borang 8A is the payroll month, unchanged.
 *
 * The identity, written out as a named function rather than left implicit at each call site, so the rule
 * has somewhere to be asserted and somewhere for a reviewer to see it refused. Do NOT "simplify" this
 * away: the day it is inlined is the day somebody adds the KWSP `+1` at one of the call sites.
 */
export function contributionPeriodFor(payrollPeriodKey: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(payrollPeriodKey)) {
    throw new Error(`Borang 8A: payroll period must be YYYY-MM, got "${payrollPeriodKey}"`);
  }
  return payrollPeriodKey;
}

/** `2026-07` → `07 / 2026`, the specimen's own spacing for CARUMAN GAJI BULAN. */
export function contributionMonthLabel(periodKey: string): string {
  const p = contributionPeriodFor(periodKey);
  return `${p.slice(5, 7)} / ${p.slice(0, 4)}`;
}

/**
 * The payment deadline: the 15th of the month AFTER the contribution month, as `DD/MM/YYYY` (PERKESO 2025
 * booklet; see THE DUE DATE above). 2026-12 is due 15/01/2027 — the year rolls with the month.
 *
 * `Date.UTC(y, m, 15)` with the 1-based contribution month `m` used as a 0-based month index IS the next
 * month: the only month arithmetic in this file, and it dates the DEADLINE, never the month the form is
 * stamped with.
 */
export function paymentDueDateFor(periodKey: string): string {
  const p = contributionPeriodFor(periodKey);
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7));
  const due = new Date(Date.UTC(y, m, 15));
  const dd = String(due.getUTCDate()).padStart(2, '0');
  const mm = String(due.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${due.getUTCFullYear()}`;
}

/**
 * `2026-07-14` → `14072026`. The specimen's own date format, labelled `(hhbbtttt)` on the artwork:
 * ddmmyyyy with NO separators. An absent or malformed date yields '' — the column is blank for anyone who
 * neither joined nor left in the month, and a blank is the specimen's answer too.
 */
export function formDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  return `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
}

/** True when `iso` falls inside the contribution month — the ONLY case the form wants the date filled. */
export function fallsInMonth(iso: string | null | undefined, periodKey: string): boolean {
  return !!iso && /^\d{4}-\d{2}-\d{2}/.test(iso) && iso.slice(0, 7) === periodKey;
}

/** Column (5) is split into RM and SEN cells on the artwork, so the amount is split for printing. */
export function splitRmSen(amount: number): { rm: string; sen: string } {
  const cents = Math.round(round2(Number(amount) || 0) * 100);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const rm = Math.floor(abs / 100);
  const sen = abs % 100;
  return {
    rm: (neg ? '-' : '') + rm.toLocaleString('en-MY'),
    sen: String(sen).padStart(2, '0'),
  };
}

/** RM with two decimals and thousands separators, for the totals lines. */
export function money(amount: number): string {
  return (Number(amount) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Split the schedule into sheets, each with its own "Jumlah muka surat ini".
 *
 * The page totals are summed from the rows ON THAT PAGE and never apportioned from the form total, so
 * `pages.reduce((a, p) => a + p.pageTotal, 0) === form.total` holds at one, two and three pages — which
 * is what a PERKESO counter-clerk reconciles. An empty schedule yields ONE empty sheet rather than zero:
 * "Lembaran 1/0" is not a thing, and a form with no sheet cannot be filed or filed-away.
 */
export function paginateBorang8A(rows: Borang8ARow[], perPage = BORANG_8A_ROWS_PER_PAGE): Borang8APage[] {
  if (perPage < 1) throw new Error('Borang 8A: rows per page must be at least 1');
  const chunks: Borang8ARow[][] = [];
  for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);
  return chunks.map((chunk, i) => ({
    sheet: i + 1,
    of: chunks.length,
    rows: chunk,
    pageTotal: round2(chunk.reduce((a, r) => a + (Number(r.contribution) || 0), 0)),
  }));
}

const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * Which header fields a Borang 8A cannot be FILED without, and does not have.
 *
 * ⚠️ THIS IS A REPORT, NOT A THROW — and it was a throw for one afternoon, which is how the defect it
 * now prevents was found. `borang8AFrom` used to reject an incomplete header, and the review screen calls
 * it on a request path: a company that had simply never filled in its SOCSO employer code got a 500 on a
 * screen whose entire purpose is to tell an operator what is missing. Refusing to PRODUCE the document is
 * right; refusing to RENDER the page that explains why is not. So the gaps are reported here, the loader
 * blocks the two downloads on them, and the screen names them beside the readiness list.
 *
 * `mycoid` and `employerAddress` are excluded: MyCoID is blank in the reporter's own specimen, and the
 * address prints as however many lines exist. Everything else is either operator-owned (employer code,
 * company legal name) or computed and therefore never blank in practice — listed anyway, because "it
 * cannot be blank" is exactly the assumption that stops being true.
 */
export function missingBorang8AHeader(header: Record<string, unknown> | null | undefined): string[] {
  const h = header ?? {};
  return BORANG_8A_HEADER_KEYS.filter((k) => k !== 'mycoid' && k !== 'employerAddress').filter(
    (k) => !str(h[k]).trim(),
  );
}

/**
 * Assemble the printable form from what `reportPreview` returned.
 *
 * Deliberately takes PLAIN SHAPES rather than `ReportResult`: importing the pack contract here would put
 * lib → localization/country-pack → localization/my/reports → localization/my/borang-8a → lib in a cycle.
 * The caller passes `{ header: result.meta.formHeader ?? {}, rows: result.rows }`.
 *
 * TOTAL — it never throws. A gap in the header comes back as an empty string on the form, and the CALLER
 * decides what to do about it (`missingBorang8AHeader` above says what is missing; `loadBorang8A` refuses
 * to hand the document over). That division is deliberate: this function is on a RENDER path.
 */
export function borang8AFrom(p: {
  header: Record<string, unknown> | null | undefined;
  rows: readonly Record<string, unknown>[];
  perPage?: number;
}): Borang8AForm {
  const h = p.header ?? {};

  const rows: Borang8ARow[] = p.rows.map((r) => ({
    employmentId: str(r.employmentId),
    startDate: str(r.startDate),
    stopDate: str(r.stopDate),
    status: str(r.status),
    ic: str(r.ic),
    name: str(r.name),
    contribution: round2(Number(r.contribution) || 0),
    // 18c1d92b — the upload file's four legs and the wage, carried through the same reconstruction the
    // printed form uses. A row that predates them reads 0 for the legs, and `wage` stays NULL rather
    // than becoming 0: null means "no wage was recorded", which the file refuses on, and 0 would mean
    // "they earned nothing", which it would happily file.
    socsoEmployer: round2(Number(r.socsoEmployer) || 0),
    socsoEmployee: round2(Number(r.socsoEmployee) || 0),
    eisEmployer: round2(Number(r.eisEmployer) || 0),
    eisEmployee: round2(Number(r.eisEmployee) || 0),
    wage: r.wage == null ? null : round2(Number(r.wage) || 0),
    // r296 — 0 rather than null for a row that predates SKBBK: a payslip written before 1 June 2026
    // genuinely deducted none, which is not the same situation as `wage`, where an absent base means the
    // figure was never recorded and the file must refuse rather than guess.
    skbbk: round2(Number(r.skbbk) || 0),
  }));
  const pages = paginateBorang8A(rows, p.perPage);
  return {
    employerCode: str(h.employerCode),
    mycoid: str(h.mycoid),
    employerName: str(h.employerName),
    // One string per line. The read joins with '\n' because ReportResult.meta values are scalars.
    employerAddress: str(h.employerAddress)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    contributionMonth: str(h.contributionMonth),
    contributionPeriodKey: str(h.contributionPeriodKey),
    payrollPeriodKey: str(h.payrollPeriodKey),
    paymentDueDate: str(h.paymentDueDate),
    pages,
    total: round2(pages.reduce((a, pg) => a + pg.pageTotal, 0)),
    employees: rows.length,
  };
}

/**
 * The typed per-row STATUS overrides, read off the review screen's query string.
 *
 * READ BY VALUE, NEVER BY PRESENCE. Every row on the review screen submits its status input whether or
 * not anything was typed into it, so `params.has(key)` is true for all 33 people and would stamp a status
 * on every line of the form. Only a non-empty, trimmed value counts. (This is the same trap that shipped
 * an unturnoffable pay setting once already — a field that is always submitted cannot be read by
 * presence.)
 *
 * Capped at 12 characters: it prints into a narrow column, and an over-long value would either overflow
 * the cell or be silently truncated at draw time, which is worse.
 */
export function statusOverridesFrom(params: URLSearchParams): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of params) {
    if (!k.startsWith(BORANG_8A_STATUS_PARAM_PREFIX)) continue;
    const id = k.slice(BORANG_8A_STATUS_PARAM_PREFIX.length);
    // r408 verify D3 — PERKESO's own codes only (page 2 of the agency's 8A): M, B, H, S, T. Anything else is
    // ignored rather than printed, because a statutory box must not carry a code PERKESO does not define.
    const value = (v ?? '').trim().toUpperCase();
    if (id && BORANG_8A_STATUS_CODES.has(value)) out.set(id, value);
  }
  return out;
}

/** Overlay the typed statuses onto the rows. Rows with no override keep whatever the read produced. */
export function applyStatusOverrides<T extends { employmentId: string; status: string }>(
  rows: readonly T[],
  overrides: Map<string, string>,
): T[] {
  return rows.map((r) => (overrides.has(r.employmentId) ? { ...r, status: overrides.get(r.employmentId)! } : { ...r }));
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

/**
 * The same form as plain text, in the order the boxes appear.
 *
 * WHY, WHEN THE PDF EXISTS. A Borang 8A is keyed into PERKESO's own portal; the drawn page is the thing
 * you read while you key, and a paginated A4 rendering is a poor thing to key from. This is the same
 * content, page by page, in a fixed-width layout that can be worked down without hunting — and it is what
 * an operator can keep, search and diff. Both come off the same `Borang8AForm`, so they cannot disagree.
 */
export function borang8ATextExport(form: Borang8AForm): string {
  const L: string[] = [];
  L.push('PERTUBUHAN KESELAMATAN SOSIAL');
  L.push('PERATURAN-PERATURAN (AM) KESELAMATAN SOSIAL PEKERJA 1971 (PER. 44A)');
  L.push(`CARUMAN GAJI BULAN ${form.contributionMonth} — BORANG 8A`);
  L.push('');
  L.push('NOT PERKESO ARTWORK. Our own drawing of PERKESO\'s Borang 8A layout, not the agency\'s file.');
  L.push('Figures are taken from the payroll run, never recalculated. Check every figure before you key or file it.');
  L.push('');
  L.push(`No. Kod Majikan                        : ${form.employerCode}`);
  L.push(`No. MyCoID / No. Pendaftaran Perniagaan: ${form.mycoid || '—'}`);
  L.push(`Nama dan Alamat Majikan                : ${form.employerName}`);
  for (const line of form.employerAddress) L.push(`                                         ${line}`);
  L.push(`Caruman Gaji Bulan                     : ${form.contributionMonth}`);
  L.push(`Amaun Caruman (RM)                     : ${money(form.total)}`);
  L.push(`Bil. Pekerja                           : ${form.employees}`);
  L.push('');
  // The deadline sentence, verbatim as it prints on the form. The DATE is `paymentDueDateFor`'s (the 15th of
  // the month after the contribution month, r408).
  L.push(`Amaun caruman di atas hendaklah dibayar kepada PERKESO/EJEN PEMUNGUT tidak lewat daripada`);
  L.push(`${form.paymentDueDate}`);
  L.push('');

  for (const page of form.pages) {
    L.push(`Lembaran ${page.sheet}/${page.of}`);
    // The drawn form's own columns, in its own words: ONE merged date column (1), then (2)…(5). The two
    // dates share the cell as `mula/berhenti`, which is why the column is 19 wide.
    L.push(
      pad('TARIKH MULA/BERHENTI', 21) +
        pad('STATUS', 9) +
        pad('NO. KAD PENGENALAN', 20) +
        pad('NAMA PEKERJA', 38) +
        padL('CARUMAN', 12),
    );
    L.push(pad('KERJA (hhbbtttt) (1)', 21) + pad('(2)', 9) + pad('(3)', 20) + pad('(MENGIKUT KAD PENGENALAN) (4)', 38) + padL('(5)', 12));
    L.push('-'.repeat(100));
    for (const r of page.rows) {
      const dates = r.startDate && r.stopDate ? `${r.startDate}/${r.stopDate}` : r.startDate || r.stopDate;
      L.push(
        pad(dates, 21) +
          pad(r.status, 9) +
          pad(r.ic, 20) +
          pad(r.name.slice(0, 37), 38) +
          padL(money(r.contribution), 12),
      );
    }
    if (page.rows.length === 0) L.push('(tiada pekerja / no employees)');
    L.push('-'.repeat(100));
    L.push(pad('Jumlah muka surat ini', 88) + padL(money(page.pageTotal), 12));
    L.push('');
  }

  L.push(pad('AMAUN CARUMAN (jumlah keseluruhan)', 88) + padL(money(form.total), 12));
  L.push('');
  L.push('Left blank on purpose — these are yours to complete, never payroll-derived:');
  L.push('  Kaedah Pembayaran (Sila tandakan (x)) — Tunai · Kiriman Wang · Cek · Lain-lain');
  L.push('  No. Cek / Kiriman Wang · Tandatangan · Nama · No. Tel & Cop Majikan');
  L.push('  Kegunaan Ejen Pemungut — Cop · No. Slip Bayaran');
  return L.join('\n') + '\n';
}
