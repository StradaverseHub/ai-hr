/**
 * Recruitment slice 16 — list exports, as pure rules (no database). Reached from outside the pack ONLY through ./service.
 *
 * An export is generated on request from what the exporter reads under row security (./export.ts) and is never stored. Here: the
 * columns each kind offers and its default set, the 10,000-row cap, saved column sets, and the file itself — every cell, headers
 * included, goes through lib/csv.ts's formula-injection guard (a cell starting with = + - @ tab or carriage return gets a leading
 * quote), for CSV and Excel alike.
 */
import { csvSafeCell, toCsv } from '../../lib/csv';
import { RecruitmentError, isUuid } from './model';

export const EXPORT_KINDS = ['board', 'talent_pool', 'interview_feedback'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** At most this many rows in one file; a larger result asks to narrow the filters. */
export const EXPORT_MAX_ROWS = 10000;
export const EXPORT_TEMPLATE_NAME_MAX = 80;
export const EXPORT_TEMPLATES_MAX = 50;

/** The fixed columns of each kind, in file order; `true` = in the default set. Custom candidate fields (cf.<id>) follow on lists. */
export const EXPORT_COLUMNS: Record<ExportKind, readonly (readonly [string, boolean])[]> = {
  board: [
    ['candidateName', true], ['email', true], ['mobile', true], ['jobTitle', true], ['jobNumber', true], ['stage', true], ['status', true], ['appliedOn', true],
    ['source', true], ['owner', false], ['tags', false], ['archiveReason', false], ['needsReview', false], ['location', false], ['currentCompany', false],
    ['currentTitle', false], ['highestEducation', false], ['noticePeriod', false], ['idType', false], ['idNumber', false],
  ],
  talent_pool: [
    ['candidateName', true], ['email', true], ['mobile', true], ['jobTitle', true], ['jobNumber', true], ['stageLeft', true], ['archivedOn', true],
    ['archiveReason', true], ['appliedOn', false], ['source', false], ['tags', false], ['pools', false], ['location', false], ['currentCompany', false],
    ['currentTitle', false], ['highestEducation', false], ['idType', false], ['idNumber', false],
  ],
  interview_feedback: [
    ['candidateName', true], ['round', true], ['stage', true], ['interviewDate', true], ['interviewer', true], ['result', true], ['averageScore', true],
    ['scores', true], ['comments', false],
  ],
};
/** Columns holding slice 5's restricted values: filled only where the exporter may read them (row security), else empty. */
export const RESTRICTED_EXPORT_COLUMNS = ['idType', 'idNumber'] as const;
const CUSTOM = /^cf\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isCustomColumn = (key: string) => CUSTOM.test(key);
export const customColumnField = (key: string) => key.slice(3);

export function isExportKind(v: unknown): v is ExportKind {
  return typeof v === 'string' && (EXPORT_KINDS as readonly string[]).includes(v);
}
export function parseExportFormat(v: unknown): ExportFormat {
  return v === 'xlsx' ? 'xlsx' : 'csv';
}
export const defaultExportColumns = (kind: ExportKind) => EXPORT_COLUMNS[kind].filter(([, on]) => on).map(([k]) => k);
const fixedKeys = (kind: ExportKind) => new Set(EXPORT_COLUMNS[kind].map(([k]) => k));

/**
 * The columns asked for, in the kind's order (custom columns after the fixed ones, in the order given), keeping only known keys
 * and custom fields the kind offers (lists only) and present in `customIds` when given. Empty → the default set.
 */
export function chooseExportColumns(kind: ExportKind, asked: readonly unknown[] | null | undefined, customIds?: ReadonlySet<string>): string[] {
  const fixed = fixedKeys(kind);
  const want = new Set((asked ?? []).filter((k): k is string => typeof k === 'string'));
  const chosen = EXPORT_COLUMNS[kind].map(([k]) => k).filter((k) => want.has(k));
  const custom = kind === 'interview_feedback' ? [] : [...want].filter((k) => !fixed.has(k) && isCustomColumn(k) && (!customIds || customIds.has(customColumnField(k))));
  const all = [...chosen, ...custom];
  return all.length ? all : defaultExportColumns(kind);
}

/** A saved column set, checked: a name (≤80), the kind, 1–60 known columns. */
export function validateExportTemplate(input: { name?: unknown; kind?: unknown; columns?: unknown }):
  { ok: true; value: { name: string; kind: ExportKind; columns: string[] } } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  const fields: string[] = [];
  if (!name) return { ok: false, code: 'missing_fields', fields: ['name'] };
  if (name.length > EXPORT_TEMPLATE_NAME_MAX) fields.push('name');
  if (!isExportKind(input.kind)) return { ok: false, code: 'invalid_input', fields: [...fields, 'kind'] };
  const raw = Array.isArray(input.columns) ? input.columns : typeof input.columns === 'string' ? [input.columns] : [];
  const fixed = fixedKeys(input.kind);
  const known = raw.filter((k): k is string => typeof k === 'string' && (fixed.has(k) || (input.kind !== 'interview_feedback' && isCustomColumn(k) && isUuid(customColumnField(k)))));
  if (!known.length) return { ok: false, code: 'missing_fields', fields: [...fields, 'columns'] };
  if (known.length !== raw.length || new Set(known).size !== known.length || known.length > 60) fields.push('columns');
  if (fields.length) return { ok: false, code: 'invalid_input', fields };
  return { ok: true, value: { name, kind: input.kind, columns: chooseExportColumns(input.kind, known) } };
}

export type ExportCell = string | number | null;
/** Refuse an export over the cap (the caller read one row more than allowed to know). */
export function assertExportSize(rows: number): void {
  if (rows > EXPORT_MAX_ROWS) throw new RecruitmentError('export_too_large');
}
/** Every cell (headers too) through the formula-injection guard. */
export function safeRows(headers: readonly string[], rows: readonly (readonly ExportCell[])[]): string[][] {
  return [headers.map((h) => csvSafeCell(h)), ...rows.map((r) => r.map((c) => csvSafeCell(c)))];
}
/** The CSV file (UTF-8 with a byte-order mark so spreadsheets read non-ASCII names correctly). */
export function exportCsv(headers: readonly string[], rows: readonly (readonly ExportCell[])[]): string {
  return `\uFEFF${toCsv([[...headers], ...rows.map((r) => [...r])])}`;
}
/** A file name for the download: kind, date, extension (no personal data). */
export function exportFileName(kind: ExportKind, dayKl: string, format: ExportFormat): string {
  return `${kind.replace('_', '-')}-${dayKl}.${format}`;
}
