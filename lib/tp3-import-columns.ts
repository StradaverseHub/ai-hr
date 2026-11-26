/**
 * Board 5084d02e — the Form TP3 Excel import's COLUMN CONTRACT, in one place for the three things that use it: the
 * template and Sample Reference the browser builds (lib/tp3-import-workbook.ts), the file check and the save the
 * import worker runs (core/tp3-import-job.ts), and the tests that pin the columns to the form.
 *
 * GENERATED FROM THE CATALOGUE, NEVER A HAND LIST. The caller passes the form's own definition (the payroll pack's
 * `TP3_SECTION_C`, `TP3_SECTION_D` and `TP3_MAX_EMPLOYERS`, which are `MY_TP3_2026_SECTION_C` and
 * `MY_TP1_2026_ITEMS` for Malaysia), and every Section C and D box becomes exactly one column. A box added to the
 * form adds a column to the template and to the reader together.
 *
 * PURE AND IMPORT-FREE, so the browser can build the template from the plain data the server page hands it and the
 * worker can read the file with the same rules. It decides no business outcome: every figure still goes through
 * `prepareTp3` (core/tp3.ts), the checks `saveTp3` makes by hand.
 *
 * ── HEADINGS ──────────────────────────────────────────────────────────────────────────────────────────────────
 * A heading is a stable TOKEN, then optionally " · " and the reader's own wording: `C2(i) · Travel allowance…`,
 * `Employee ID *`. The token is the form's own numbering for a box (the same label `prepareTp3` names in a refusal),
 * or a fixed English name for the other columns. The reader matches on the token only, so a template downloaded in
 * Malay or Chinese reads back the same, and a heading whose wording was edited still reads.
 */

export const TP3_IMPORT_MAX_ROWS = 2000;
/** The CSV text of the first sheet; the same bound the other payroll imports use for a server action body. */
export const TP3_IMPORT_MAX_CSV_BYTES = 900_000;
export const TP3_IMPORT_TEMPLATE_FILENAME = 'form-tp3-import-template.xlsx';
export const TP3_IMPORT_SAMPLE_FILENAME = 'form-tp3-import-sample.xlsx';
export const TP3_IMPORT_LOG = '/payroll/transactions/tp3/imports';
/** Separates a heading's token from its wording. */
export const TP3_HEADING_SEPARATOR = ' · ';

/** The form's definition as the payroll pack exposes it (structurally; plain data, safe to send to the browser). */
export type Tp3ImportCatalogue = {
  readonly sectionC: readonly { readonly code: string; readonly subItems: readonly { readonly code: string; readonly exemptionLimit?: number | null }[] }[];
  readonly sectionD: readonly {
    readonly code: string;
    readonly limit: number | null;
    readonly perSubLimit?: boolean;
    readonly subItems: readonly { readonly code: string; readonly limit: number | null }[];
  }[];
  readonly maxEmployers: number;
  readonly textLimits: { readonly employerName: number; readonly employerTin: number; readonly remarks: number };
};

export type Tp3ImportColumn =
  | { kind: 'employeeId'; key: 'employeeId'; token: string; required: true }
  | { kind: 'assessmentYear'; key: 'assessmentYear'; token: string; required: true }
  | { kind: 'deductionMonth'; key: 'deductionMonth'; token: string; required: false }
  | { kind: 'employerName' | 'employerTin'; key: string; token: string; required: false; employer: number; max: number }
  | {
      kind: 'amount';
      key: string;
      token: string;
      required: false;
      section: 'C' | 'D';
      /** The catalogue item code ('c1'…) and sub-line code ('i', 'a', …), the persisted JSONB keys. */
      code: string;
      sub: string | null;
      /** A Section D box's own printed limit, or the item's annual limit on a single-line item. */
      limit: number | null;
      /** A Section D sub-line's item annual limit, which caps the item's sub-lines together. */
      groupLimit: number | null;
      /** A Section C2 sub-line's tax-exempt limit: the part above it is taxable, never refused. */
      exemptionLimit: number | null;
    }
  | { kind: 'remarks'; key: 'remarks'; token: string; required: false; max: number };

/**
 * The box label `prepareTp3` (core/tp3.ts `readGroup`) names in a refusal: `C1`, `C2(i)`, `D2`, `D1(a)`. The column
 * token IS that label, so a refusal's `field` names its column without a lookup table that could drift.
 */
export const tp3BoxToken = (section: 'C' | 'D', code: string, sub: string | null) =>
  `${section}${code.replace(/^c/, '').toUpperCase()}${sub ? `(${sub})` : ''}`;

export function tp3ImportColumns(catalogue: Tp3ImportCatalogue): Tp3ImportColumn[] {
  const out: Tp3ImportColumn[] = [
    { kind: 'employeeId', key: 'employeeId', token: 'Employee ID', required: true },
    { kind: 'assessmentYear', key: 'assessmentYear', token: 'Assessment Year', required: true },
    { kind: 'deductionMonth', key: 'deductionMonth', token: 'Deduction Month', required: false },
  ];
  for (let n = 1; n <= catalogue.maxEmployers; n++) {
    out.push({ kind: 'employerName', key: `employer${n}Name`, token: `Employer ${n} Name`, required: false, employer: n, max: catalogue.textLimits.employerName });
    out.push({ kind: 'employerTin', key: `employer${n}Tin`, token: `Employer ${n} Tax No.`, required: false, employer: n, max: catalogue.textLimits.employerTin });
  }
  for (const line of catalogue.sectionC) {
    const subs = line.subItems.length ? line.subItems.map((s) => ({ code: s.code, exemptionLimit: s.exemptionLimit ?? null })) : [null];
    for (const sub of subs) {
      const token = tp3BoxToken('C', line.code, sub?.code ?? null);
      out.push({ kind: 'amount', key: token, token, required: false, section: 'C', code: line.code, sub: sub?.code ?? null,
        limit: null, groupLimit: null, exemptionLimit: sub?.exemptionLimit ?? null });
    }
  }
  for (const item of catalogue.sectionD) {
    if (!item.subItems.length) {
      const token = tp3BoxToken('D', item.code, null);
      out.push({ kind: 'amount', key: token, token, required: false, section: 'D', code: item.code, sub: null,
        limit: item.limit, groupLimit: null, exemptionLimit: null });
      continue;
    }
    for (const sub of item.subItems) {
      const token = tp3BoxToken('D', item.code, sub.code);
      out.push({ kind: 'amount', key: token, token, required: false, section: 'D', code: item.code, sub: sub.code,
        limit: sub.limit, groupLimit: item.perSubLimit ? null : item.limit, exemptionLimit: null });
    }
  }
  out.push({ kind: 'remarks', key: 'remarks', token: 'Remarks', required: false, max: catalogue.textLimits.remarks });
  return out;
}

/** The heading a template prints: the token, `*` when required, then the reader's wording when it adds something. */
export function tp3ImportHeading(column: Tp3ImportColumn, wording: string | null | undefined) {
  const token = column.required ? `${column.token} *` : column.token;
  const words = (wording ?? '').trim();
  return words && words.toLowerCase() !== column.token.toLowerCase() ? `${token}${TP3_HEADING_SEPARATOR}${words}` : token;
}

/** A heading cell reduced to its token: the part before " · ", without `*`, spacing collapsed, lower case. */
export function tp3HeadingToken(cell: string) {
  const at = cell.indexOf(TP3_HEADING_SEPARATOR.trim());
  return (at === -1 ? cell : cell.slice(0, at)).replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export type Tp3ImportFileError = { fileError: string; detail?: Record<string, string | number> };

/**
 * The file's header row against the columns. A heading that is not a template column is REFUSED rather than
 * skipped: a figure under a misspelt heading would otherwise be saved as 0 with nothing said. A template column the
 * file leaves out reads as blank on every row (the row is the complete form, so its boxes are 0), except the two
 * required ones.
 */
export function resolveTp3ImportHeader(header: readonly string[], columns: readonly Tp3ImportColumn[]): { byIndex: (Tp3ImportColumn | null)[] } | Tp3ImportFileError {
  const byToken = new Map(columns.map((c) => [c.token.toLowerCase(), c]));
  const seen = new Set<string>();
  const byIndex: (Tp3ImportColumn | null)[] = [];
  for (const cell of header) {
    const token = tp3HeadingToken(String(cell ?? ''));
    if (!token) { byIndex.push(null); continue; }
    const column = byToken.get(token);
    if (!column) return { fileError: 'unknownColumn', detail: { column: String(cell).trim().slice(0, 120) } };
    if (seen.has(column.key)) return { fileError: 'duplicateColumn', detail: { column: column.token } };
    seen.add(column.key);
    byIndex.push(column);
  }
  for (const column of columns) if (column.required && !seen.has(column.key)) return { fileError: 'missingColumn', detail: { column: column.token } };
  return { byIndex };
}

type RawGroup = Record<string, { amount?: number; subItems?: Record<string, number> }>;
/** One row as `prepareTp3` takes it (without the person, which the worker resolves). */
export type Tp3ImportRowInput = {
  assessmentYear: number;
  deductionMonth: number | null;
  previousEmployers: { name: string; tin: string }[];
  sectionC: RawGroup;
  sectionD: RawGroup;
  remarks: string | null;
};
export type Tp3ImportRowProblem = { reason: string; field?: string; detail?: Record<string, string | number> };
export type Tp3ImportRead = { employeeId: string; year: number | null; input: Tp3ImportRowInput | null; problem: Tp3ImportRowProblem | null };

/**
 * An amount as a spreadsheet holds it: a plain number (`2640`, `2640.5`), or text with thousands separators and an
 * optional `RM` (`RM 24,000.00`). Blank is undefined (the box was left empty, which saves 0). Anything else is
 * refused rather than guessed. Negative and too-large values are passed on for `prepareTp3` to refuse with its own
 * reasons.
 */
export function parseTp3Amount(raw: string): number | undefined | 'invalid' {
  let s = raw.trim();
  if (!s) return undefined;
  s = s.replace(/^RM\s*/i, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 'invalid';
  return Number(s);
}

/**
 * One data row, read cell by cell. Only the FORMAT of each cell is checked here (a year that is a year, a month that
 * is a whole number, an amount that is a number); every rule of the form (limits, employers, totals, lengths) is
 * `prepareTp3`'s, run by the caller on the returned input.
 */
export function readTp3ImportRow(cells: readonly string[], byIndex: readonly (Tp3ImportColumn | null)[], maxEmployers: number): Tp3ImportRead {
  const value = new Map<string, string>();
  byIndex.forEach((column, index) => { if (column) value.set(column.key, String(cells[index] ?? '').trim()); });
  const employeeId = value.get('employeeId') ?? '';
  const yearText = value.get('assessmentYear') ?? '';
  const year = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
  const fail = (problem: Tp3ImportRowProblem): Tp3ImportRead => ({ employeeId, year, input: null, problem });
  if (!employeeId) return fail({ reason: 'employeeIdRequired', field: 'employeeId' });
  if (year == null) return fail({ reason: 'yearInvalid', field: 'assessmentYear' });
  const monthText = value.get('deductionMonth') ?? '';
  if (monthText && !/^\d{1,2}$/.test(monthText)) return fail({ reason: 'monthInvalid', field: 'deductionMonth' });
  const sectionC: RawGroup = {}, sectionD: RawGroup = {};
  for (const column of byIndex) {
    if (column?.kind !== 'amount') continue;
    const parsed = parseTp3Amount(value.get(column.key) ?? '');
    if (parsed === 'invalid') return fail({ reason: 'amountNotNumber', field: column.token });
    if (parsed === undefined) continue;
    const group = column.section === 'C' ? sectionC : sectionD;
    const entry = (group[column.code] ??= {});
    if (column.sub) (entry.subItems ??= {})[column.sub] = parsed;
    else entry.amount = parsed;
  }
  const previousEmployers = Array.from({ length: maxEmployers }, (_, i) => ({
    name: value.get(`employer${i + 1}Name`) ?? '',
    tin: value.get(`employer${i + 1}Tin`) ?? '',
  }));
  const remarks = value.get('remarks') ?? '';
  return {
    employeeId, year, problem: null,
    input: { assessmentYear: year, deductionMonth: monthText ? Number(monthText) : null, previousEmployers, sectionC, sectionD, remarks: remarks || null },
  };
}
