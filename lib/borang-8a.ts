/**
 * 8ca344bf — BORANG 8A (PERKESO monthly contribution schedule): the form's own model, its two dating
 * rules, its pagination, and its plain-text rendering. PURE — no DB, no pack, no pdf-lib — so every rule
 * below is unit-testable on its own, which is the whole reason this file exists separately from the read
 * (localization/my/borang-8a.ts) and from the drawing (lib/borang-8a-pdf.ts).
 *
 * ── WHY THIS FORM IS NOT `official`, SAID HERE AS WELL AS ON THE SHELF ──────────────────────────────
 * The specimen we built against (attachment 91ce0f6a, "Socso Borang 8A.pdf", 84,219 bytes, PDF 1.6, one
 * A4 page, producer "Developer Express Inc. DXperience v23.2.5") is a FILLED OUTPUT from another payroll
 * vendor's engine. It is not PERKESO artwork, it carries no form fields, and PERKESO publishes no blank
 * page for this form at all. So there is nothing to print onto: we draw the page ourselves, matching the
 * specimen line for line, and the catalog entry declares `agency-layout` — never `official`, which in
 * this codebase means the government's own published page and belongs to `my.cp22` alone.
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
 * The LAST DAY OF THE CONTRIBUTION MONTH, which is what the specimen shows ("tidak lewat daripada
 * 31/07/2026" on a 07/2026 form). NOT the 15th-of-next-month that KWSP uses and that
 * `ReportSubmission.dueDayOfNextMonth` models for the SOCSO+EIS ASSIST listing — those are two different
 * deadlines on two different filings, and conflating them is the same class of mistake as the offset.
 */

/** One employee's line on the schedule. `contribution` is RM, already taken from the run. */
export type Borang8ARow = {
  /** Not printed — the key a typed STATUS override is addressed by. */
  employmentId: string;
  /** Column (1) Tarikh Mula Kerja, `ddmmyyyy`, blank unless they joined inside the contribution month. */
  startDate: string;
  /** Column (1) Tarikh Berhenti Kerja, `ddmmyyyy`, blank unless they left inside the contribution month. */
  stopDate: string;
  /** Column (2) STATUS — blank for a continuing employee, exactly as the specimen leaves it. */
  status: string;
  /** Column (3) No. K/P. */
  ic: string;
  /** Column (4) Nama Pekerja. */
  name: string;
  /** Column (5) Caruman, in RM. */
  contribution: number;
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
  /** Bayaran tidak lewat daripada — `DD/MM/YYYY`, the last day of the contribution month. */
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

/** Rows per printed sheet. The specimen is a single-employee form, so this is ours: 20 lines leave room
 *  for the repeated header and the payment/signature blocks at the foot of every sheet. */
export const BORANG_8A_ROWS_PER_PAGE = 20;

/** The prefix a typed per-row STATUS override arrives under, e.g. `st_<employmentId>=BARU`. */
export const BORANG_8A_STATUS_PARAM_PREFIX = 'st_';

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
 * The payment deadline: the LAST DAY of the contribution month, as `DD/MM/YYYY`.
 *
 * `Date.UTC(y, m, 0)` is day zero of the NEXT month, i.e. the last day of this one — the only month
 * arithmetic in this file, and it moves a DAY, never the month the form is stamped with.
 */
export function paymentDueDateFor(periodKey: string): string {
  const p = contributionPeriodFor(periodKey);
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(last).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
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
 * Assemble the printable form from what `reportPreview` returned.
 *
 * Deliberately takes PLAIN SHAPES rather than `ReportResult`: importing the pack contract here would put
 * lib → localization/country-pack → localization/my/reports → localization/my/borang-8a → lib in a cycle.
 * The caller passes `{ header: result.meta.formHeader ?? {}, rows: result.rows }`.
 *
 * THROWS on a header the read did not fill. A Borang 8A missing its employer code is not a form with a
 * gap in it — it is a document that cannot be filed, and silently drawing a blank box is how it would
 * reach PERKESO before anybody noticed. `mycoid` is the ONE exception: it is blank in the reporter's own
 * specimen, so an empty value is a legitimate answer for it.
 */
export function borang8AFrom(p: {
  header: Record<string, unknown> | null | undefined;
  rows: readonly Record<string, unknown>[];
  perPage?: number;
}): Borang8AForm {
  const h = p.header ?? {};
  const required = BORANG_8A_HEADER_KEYS.filter((k) => k !== 'mycoid' && k !== 'employerAddress');
  const blank = required.filter((k) => !str(h[k]).trim());
  if (blank.length) throw new Error(`Borang 8A header is incomplete: ${blank.join(', ')}`);

  const rows: Borang8ARow[] = p.rows.map((r) => ({
    employmentId: str(r.employmentId),
    startDate: str(r.startDate),
    stopDate: str(r.stopDate),
    status: str(r.status),
    ic: str(r.ic),
    name: str(r.name),
    contribution: round2(Number(r.contribution) || 0),
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
    const value = (v ?? '').trim().slice(0, 12);
    if (id && value) out.set(id, value);
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
  L.push('BORANG 8A — CARUMAN BULANAN (PERKESO)');
  L.push('');
  L.push('NOT PERKESO ARTWORK. Our own layout, drawn to match the agency form. PERKESO publishes no');
  L.push('blank Borang 8A to print onto. Check every figure before you key or file it.');
  L.push('');
  L.push(`No. Kod Majikan          : ${form.employerCode}`);
  L.push(`MyCoID / No. Pendaftaran : ${form.mycoid || '—'}`);
  L.push(`Nama Majikan             : ${form.employerName}`);
  for (const [i, line] of form.employerAddress.entries()) {
    L.push(`${i === 0 ? 'Alamat Majikan           : ' : '                           '}${line}`);
  }
  L.push(`Caruman Gaji Bulan       : ${form.contributionMonth}`);
  L.push(`Bayaran tidak lewat dari : ${form.paymentDueDate}`);
  L.push(`Amaun Caruman            : RM ${money(form.total)}`);
  L.push(`Bil. Pekerja             : ${form.employees}`);
  L.push('');

  for (const page of form.pages) {
    L.push(`Lembaran ${page.sheet}/${page.of}`);
    L.push(
      pad('MULA', 9) + pad('BERHENTI', 9) + pad('STATUS', 13) + pad('NO. K/P', 15) + pad('NAMA', 42) + padL('CARUMAN', 12),
    );
    L.push('-'.repeat(100));
    for (const r of page.rows) {
      L.push(
        pad(r.startDate, 9) +
          pad(r.stopDate, 9) +
          pad(r.status, 13) +
          pad(r.ic, 15) +
          pad(r.name.slice(0, 41), 42) +
          padL(money(r.contribution), 12),
      );
    }
    if (page.rows.length === 0) L.push('(tiada pekerja / no employees)');
    L.push('-'.repeat(100));
    L.push(pad('Jumlah muka surat ini', 88) + padL(money(page.pageTotal), 12));
    L.push('');
  }

  L.push(pad('JUMLAH KESELURUHAN (Amaun Caruman)', 88) + padL(money(form.total), 12));
  L.push('');
  L.push('Left blank on purpose — these are yours to complete, never payroll-derived:');
  L.push('  Kaedah Pembayaran · No. Cek / Kiriman Wang · Tandatangan · No. Tel & Cop Majikan');
  L.push('  Kegunaan Ejen Pemungut');
  return L.join('\n') + '\n';
}
