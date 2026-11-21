/**
 * Recruitment slice 16 — the candidate import file, as pure rules (no database). Reached from outside the pack ONLY through ./service.
 *
 * The file is AI HR's own import template (CSV, or an Excel workbook the browser has already turned into the same CSV text with the
 * repository's one workbook decoder, lib/spreadsheet): one header row, then one candidate per row. Fixed columns (full name, e-mail,
 * mobile, ID type and number, source, job number, job title as written, notes) and the company's ENABLED custom candidate fields
 * (slice 14) by their English label. Every row is checked here exactly as the preview and the background job check it: the same
 * function, the same codes. Values are never put into an error: a row's problems are field keys and codes only.
 *
 * Nothing here calls a model, parses a résumé or infers anything about a candidate (D-056).
 */
import { parseCsvWithLineNumbers } from '../../lib/csv';
import { RecruitmentError, validateCandidateInput } from './model';
import { CANDIDATE_SOURCES, ID_TYPES, normEmail, normIdNumber, normMobile, normName, type CandidateSource, type IdType } from './privacy-model';
import {
  CHOICE_TYPES, CUSTOM_FIELD_LOCALES, answerable, validateCustomValues, type CustomFieldType, type CustomLabels, type FieldRule, type RawCustomValues,
} from './custom-field-model';

/** At most this many candidate rows in one file (spec: ≤5,000 rows). */
export const IMPORT_MAX_ROWS = 5000;
/** The picked file (≤10 MB) and the CSV text the server receives (an .xlsx decodes to text of about the same size). */
export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const IMPORT_NOTES_MAX = 2000;
export const IMPORT_JOB_TITLE_MAX = 200;
/** The preview lists at most this many rows with something to say (the counts always cover every row). */
export const IMPORT_PREVIEW_ISSUES_MAX = 1000;
export const CANDIDATE_IMPORT_KIND = 'recruitment_candidate_import';

export const IMPORT_COLUMNS = ['fullName', 'email', 'mobile', 'idType', 'idNumber', 'source', 'jobNumber', 'jobTitle', 'notes'] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
/** The template's header for each fixed column (English: the file is a machine contract, like the employee import's template). */
export const IMPORT_HEADERS: Record<ImportColumn, string> = {
  fullName: 'Full name', email: 'E-mail', mobile: 'Mobile', idType: 'ID type', idNumber: 'ID number', source: 'Source',
  jobNumber: 'Job number', jobTitle: 'Job title as written', notes: 'Notes',
};
/** Words a person may type in the ID type and Source columns (besides the stored value itself). */
const ID_TYPE_WORDS: Record<string, IdType> = { nric: 'nric', 'ic': 'nric', mykad: 'nric', passport: 'passport' };
const SOURCE_WORDS: Record<string, CandidateSource> = {
  referral: 'referral', 'employee referral': 'referral', 'job board': 'job_board', job_board: 'job_board', 'career page': 'career_page', career_page: 'career_page',
  'careers page': 'career_page', agency: 'agency', 'walk-in': 'walk_in', 'walk in': 'walk_in', walk_in: 'walk_in', other: 'other',
};
const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/** A custom candidate field as the import reads it: the definition, its options' labels and whether it is restricted. */
export type ImportField = {
  id: string; type: CustomFieldType; labels: CustomLabels; required: boolean; restricted: boolean;
  numberMin: string | null; numberMax: string | null; numberDecimals: number | null;
  options: { id: string; labels: CustomLabels; enabled: boolean }[];
};
/** One problem in a row: the column (a fixed key, or cf.<field id>) and a code. Never the value. */
export type RowIssue = { field: string; code: ImportIssueCode };
export const IMPORT_ISSUE_CODES = ['required', 'invalid', 'too_long', 'id_type_required', 'custom_field_required', 'custom_value_invalid', 'needs_job', 'control_character'] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];
export type ImportValues = {
  fullName: string; email: string | null; phone: string | null; idType: IdType | null; idNumber: string | null; source: CandidateSource | null;
  jobNumber: string | null; jobTitle: string | null; notes: string | null;
};
export type ImportRow = { rowNum: number; values: ImportValues | null; custom: RawCustomValues; issues: RowIssue[] };
export type ParsedImport = { rows: ImportRow[]; ignoredColumns: string[]; customColumns: string[] };
/** Whole-file refusals: unreadable, no name column, no rows, too many rows, too large. */
export const IMPORT_FILE_ERRORS = ['import_file_invalid', 'import_no_name_column', 'import_empty', 'import_too_many_rows', 'import_too_large', 'import_bad_encoding'] as const;
export type ImportFileError = (typeof IMPORT_FILE_ERRORS)[number];
export class ImportFileRefusal extends Error {
  constructor(readonly code: ImportFileError) { super(`recruitment-import:${code}`); this.name = 'ImportFileRefusal'; }
}

/** Header text as compared: lower case, single spaces, no trailing required marker, and no leading quote (a spreadsheet's formula
 *  guard, so a template whose header was escaped on the way out reads back). */
export const normHeader = (h: string) => h.replace(/^\uFEFF/, '').trim().replace(/^'/, '').trim().replace(/\*+$/, '').trim().replace(/\s+/g, ' ').toLowerCase();
/** Characters no person types into a cell (NUL and the other controls except tab, line feed and carriage return). */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const fixedHeader = new Map<string, ImportColumn>(IMPORT_COLUMNS.flatMap((c) => [
  [normHeader(IMPORT_HEADERS[c]), c], [c.toLowerCase(), c], [c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), c],
] as [string, ImportColumn][]));
fixedHeader.set('email', 'email');
fixedHeader.set('phone', 'mobile');
fixedHeader.set('name', 'fullName');

const cell = (v: string | undefined) => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};
const labelsMatch = (labels: Partial<CustomLabels>, text: string) => {
  const want = normHeader(text);
  return CUSTOM_FIELD_LOCALES.some((l) => labels[l] && normHeader(labels[l]!) === want);
};

/** The CSV header row of the import template for these fields (fixed columns, then the custom fields by English label). */
export function importTemplateHeader(fields: readonly Pick<ImportField, 'labels'>[]): string[] {
  return [...IMPORT_COLUMNS.map((c) => `${IMPORT_HEADERS[c]}${c === 'fullName' ? ' *' : ''}`), ...fields.map((f) => f.labels.en ?? '')];
}

/** A custom value as the file writes it, turned into what slice 14's rules read: option ids for choices, yes or no, dates as typed. */
function rawCustom(f: ImportField, text: string): string | string[] {
  if (CHOICE_TYPES.includes(f.type)) {
    const parts = f.type === 'multiple_choice' ? text.split(/[;\n]/).map((p) => p.trim()).filter(Boolean) : [text];
    // An option is named by its label in any language; an unknown label stays as typed, which slice 14's rules then refuse.
    return parts.map((p) => f.options.find((o) => o.enabled && labelsMatch(o.labels, p))?.id ?? p);
  }
  if (f.type === 'yes_no') {
    const t = text.toLowerCase();
    return YES.has(t) ? 'yes' : NO.has(t) ? 'no' : text;
  }
  return text;
}
const ruleOf = (f: ImportField, required = true): FieldRule => ({
  id: f.id, type: f.type, required: required && f.required, enabled: true, numberMin: f.numberMin, numberMax: f.numberMax, numberDecimals: f.numberDecimals,
  options: f.options.map((o) => ({ id: o.id, enabled: o.enabled })),
});

/**
 * Read and check a whole file. Throws ImportFileRefusal for a file that cannot be imported at all; otherwise returns every row,
 * each with its values (null when the row cannot become a candidate) and its issues. A row whose cells are all empty is skipped.
 */
export function parseCandidateImport(text: string, fields: readonly ImportField[], opts: { required?: boolean } = {}): ParsedImport {
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_TEXT_BYTES) throw new ImportFileRefusal('import_too_large');
  // A replacement character means the file was not UTF-8 (the browser decodes strictly; this refuses the same on the server).
  if (text.includes('\uFFFD')) throw new ImportFileRefusal('import_bad_encoding');
  let lines: { cells: string[]; line: number }[];
  try { lines = parseCsvWithLineNumbers(text, true); } catch { throw new ImportFileRefusal('import_file_invalid'); }
  if (!lines.length) throw new ImportFileRefusal('import_empty');
  const header = lines[0].cells.map(normHeader);
  const columns: (ImportColumn | { field: ImportField } | null)[] = header.map((h) => {
    const fixed = fixedHeader.get(h);
    if (fixed) return fixed;
    const field = fields.find((f) => (f.labels.en && normHeader(f.labels.en) === h) || labelsMatch(f.labels, h));
    return field ? { field } : null;
  });
  if (!columns.includes('fullName')) throw new ImportFileRefusal('import_no_name_column');
  // A column named twice: the first one counts, the later ones are ignored (and listed as such).
  const seen = new Set<string>();
  const used = columns.map((c) => {
    const key = c === null ? null : typeof c === 'string' ? c : `cf.${c.field.id}`;
    if (key === null || seen.has(key)) return null;
    seen.add(key);
    return c;
  });
  const ignoredColumns = lines[0].cells.filter((_, i) => used[i] === null).map((h) => h.trim()).filter(Boolean).slice(0, 50);
  const data = lines.slice(1).filter((l) => l.cells.some((c) => c.trim() !== ''));
  if (!data.length) throw new ImportFileRefusal('import_empty');
  if (data.length > IMPORT_MAX_ROWS) throw new ImportFileRefusal('import_too_many_rows');
  const customFields = used.flatMap((c) => (c && typeof c !== 'string' ? [c.field] : []));
  const rows = data.map(({ cells, line }): ImportRow => {
    const fixed: Partial<Record<ImportColumn, string | null>> = {};
    const custom: RawCustomValues = {};
    const control: RowIssue[] = [];
    used.forEach((c, i) => {
      if (!c) return;
      const v = cell(cells[i]);
      if (v !== null && CONTROL.test(v)) { control.push({ field: typeof c === 'string' ? c : `cf.${c.field.id}`, code: 'control_character' }); return; }
      if (typeof c === 'string') fixed[c] = v;
      else if (v !== null) custom[c.field.id] = rawCustom(c.field, v);
    });
    const row = checkRow(line, fixed, custom, customFields, opts.required !== false);
    return control.length ? { ...row, values: null, issues: [...control, ...row.issues.filter((x) => !control.some((c) => c.field === x.field))] } : row;
  });
  return { rows, ignoredColumns, customColumns: customFields.map((f) => f.id) };
}

function checkRow(rowNum: number, fixed: Partial<Record<ImportColumn, string | null>>, custom: RawCustomValues, fields: readonly ImportField[], required: boolean): ImportRow {
  const issues: RowIssue[] = [];
  const candidate = validateCandidateInput({ fullName: fixed.fullName ?? '', email: fixed.email ?? '', phone: fixed.mobile ?? '' });
  if (!candidate.ok) {
    for (const f of candidate.fields) {
      const field = f === 'phone' ? 'mobile' : f;
      const value = fixed[field as ImportColumn];
      issues.push({ field, code: f === 'fullName' && !value ? 'required' : (value?.length ?? 0) > (f === 'email' ? 254 : f === 'phone' ? 40 : 200) ? 'too_long' : 'invalid' });
    }
  }
  const idNumber = fixed.idNumber ?? null;
  const idTypeText = fixed.idType?.toLowerCase() ?? null;
  const idType: IdType | null | undefined = idTypeText === null ? null : (ID_TYPES as readonly string[]).includes(idTypeText) ? idTypeText as IdType : ID_TYPE_WORDS[idTypeText];
  if (idType === undefined) issues.push({ field: 'idType', code: 'invalid' });
  if (idNumber !== null && idNumber.length > 40) issues.push({ field: 'idNumber', code: 'too_long' });
  else if (idNumber !== null && idType === null) issues.push({ field: 'idType', code: 'id_type_required' });
  const sourceText = fixed.source?.toLowerCase() ?? null;
  const source: CandidateSource | null | undefined = sourceText === null ? null
    : (CANDIDATE_SOURCES as readonly string[]).includes(sourceText) ? sourceText as CandidateSource : SOURCE_WORDS[sourceText];
  if (source === undefined) issues.push({ field: 'source', code: 'invalid' });
  const jobNumber = fixed.jobNumber ? fixed.jobNumber.toUpperCase() : null;
  if (jobNumber !== null && jobNumber.length > 40) issues.push({ field: 'jobNumber', code: 'too_long' });
  const jobTitle = fixed.jobTitle ? fixed.jobTitle.replace(/\s+/g, ' ') : null;
  if (jobTitle !== null && jobTitle.length > IMPORT_JOB_TITLE_MAX) issues.push({ field: 'jobTitle', code: 'too_long' });
  const notes = fixed.notes ? fixed.notes.replace(/\r\n?/g, '\n') : null;
  if (notes !== null && notes.length > IMPORT_NOTES_MAX) issues.push({ field: 'notes', code: 'too_long' });
  // Slice 14's value rules for every custom column present (an absent column leaves its field empty, and required applies).
  const v = validateCustomValues(fields.map((f) => ruleOf(f, required)), custom);
  if (!v.ok) for (const id of v.fields) issues.push({ field: `cf.${id}`, code: v.code });
  const ok = issues.length === 0 && candidate.ok && idType !== undefined && source !== undefined;
  return {
    rowNum, custom, issues,
    values: ok ? {
      fullName: candidate.value.fullName, email: candidate.value.email, phone: candidate.value.phone, idType: idNumber ? idType ?? null : null,
      idNumber, source: source ?? null, jobNumber, jobTitle, notes,
    } : null,
  };
}

/**
 * Restricted values and custom values are written only by administrators and the operators of one of the candidate's jobs (slices
 * 5 and 14). A row that will have no application, imported by someone who does not administer the company, may therefore carry
 * none: its ID number and custom columns are reported as "needs a job".
 */
export function needsJobIssues(values: ImportValues, custom: RawCustomValues): RowIssue[] {
  return [
    ...(values.idNumber ? [{ field: 'idNumber', code: 'needs_job' as const }] : []),
    ...Object.entries(custom).filter(([, v]) => v !== undefined && (!Array.isArray(v) || v.length > 0)).map(([id]) => ({ field: `cf.${id}`, code: 'needs_job' as const })),
  ];
}

/**
 * The required custom fields a row leaves empty (slice 14's rule: a choice field with no usable option is not required). Applied
 * the same way whether or not the row carries other custom values; the import applies it to every row that gets an application,
 * and to every row an administrator imports (a row a recruiter sends to To assign is completed by whoever assigns it).
 */
export function requiredIssues(fields: readonly ImportField[], custom: RawCustomValues): RowIssue[] {
  const empty = (v: RawCustomValues[string]) => v === undefined || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
  return fields.filter((f) => f.required && answerable(ruleOf(f)) && empty(custom[f.id]))
    .map((f) => ({ field: `cf.${f.id}`, code: 'custom_field_required' as const }));
}

/** Rows of the same file that look like the same person (slice 5's rule): each later row is flagged with the first it matches. */
export function fileDuplicates(rows: readonly ImportRow[]): Map<number, number> {
  // One map per way two people match (slice 5: the ID number, or a pair of e-mail, name and mobile), each holding the first row
  // with that key: linear in the file, however many rows share a common name.
  const first = new Map<string, number>();
  const out = new Map<number, number>();
  for (const r of rows) {
    if (!r.values) continue;
    const id = normIdNumber(r.values.idNumber), email = normEmail(r.values.email), name = normName(r.values.fullName), mobile = normMobile(r.values.phone);
    const keys = [id && `i:${id}`, email && name && `en:${email}\u0001${name}`, email && mobile && `em:${email}\u0001${mobile}`,
      name && mobile && `nm:${name}\u0001${mobile}`].filter((k): k is string => !!k);
    const hits = keys.map((k) => first.get(k)).filter((n): n is number => n !== undefined);
    if (hits.length) out.set(r.rowNum, Math.min(...hits));
    for (const k of keys) if (!first.has(k)) first.set(k, r.rowNum);
  }
  return out;
}

/** What happened to a row's job: an Open job of the company the importer may add applications to, or why not. */
export const JOB_RESULTS = ['applied', 'no_job', 'unknown_job', 'job_not_open', 'job_not_allowed'] as const;
export type JobResult = (typeof JOB_RESULTS)[number];
export type JobChoice = { id: string; status: string; operate: boolean };
export function jobResultOf(jobNumber: string | null, job: JobChoice | undefined): Exclude<JobResult, 'applied'> | 'usable' {
  if (!jobNumber) return 'no_job';
  if (!job) return 'unknown_job';
  if (job.status !== 'open') return 'job_not_open';
  if (!job.operate) return 'job_not_allowed';
  return 'usable';
}

/** The permission confirmation (slice 5): the box must be ticked. */
export function permissionConfirmed(value: unknown): boolean {
  return value === true || value === 'on' || value === 'true' || value === '1';
}
export function assertPermission(value: unknown): void {
  if (!permissionConfirmed(value)) throw new RecruitmentError('permission_required');
}
