/**
 * Board c074c6b8: the System Labels import's adapter onto the shared problem line (lib/import-problem-lines.ts).
 * The check screen, the import result screen and every Error Log download build their rows here and nowhere else,
 * so a row says the same thing on screen and in the file, in the viewer's language.
 *
 * Client-safe (no xlsx, no database). `t` is a root translator: useTranslations() on the client,
 * getTranslations() on the server. Problem and correction text come from labelsImportWizard.problem.<detail> and
 * labelsImportWizard.fix.<detail>, one per server sentence; in English each problem is that sentence word for word.
 */
import type { ImportProblemLine, ImportProblemTranslator } from './import-problem-lines';
import {
  LABEL_IMPORT_DEFINITIONS, LABEL_LEGACY_HEADERS_WARNING, LABEL_TEMPLATE_DEFINITIONS, ORGANISATION_LABEL_KINDS,
  labelReasonColumn, labelReasonDetail, type LabelImportColumn, type LabelImportPreviewRow, type LabelImportReasonDetail,
} from './system-label-definition';

export type LabelProblemTranslator = (key: string, values?: Record<string, string | number>) => string;
/** The shared table/workbook vocabulary (namespace importProblems) through the same root translator. */
export const labelProblemTranslator = (t: LabelProblemTranslator): ImportProblemTranslator => key => t(`importProblems.${key}`);

/** The category caption the System Labels page uses; a worksheet that is not a category keeps its own name. */
export function labelCategoryCaption(kind: string, t: LabelProblemTranslator): string {
  if (!LABEL_IMPORT_DEFINITIONS.some(definition => definition.kind === kind)) return kind;
  if ((ORGANISATION_LABEL_KINDS as readonly string[]).includes(kind)) return t(`admin.systemLabels.category.${kind}`);
  if (kind === 'grades') return t('admin.systemLabels.category.grade');
  if (kind === 'grade_groups') return t('admin.benefitScheme.groupsTitle');
  return t(`admin.profileOptions.category.${kind}`);
}

/** The column's caption as the upload template heads it (an older export layout uses the internal name). */
export function labelColumnCaption(kind: string, column: LabelImportColumn): string {
  const template = LABEL_TEMPLATE_DEFINITIONS.find(definition => definition.kind === kind);
  const found = (template?.columns as unknown as readonly (readonly string[])[] | undefined)?.find(([, field]) => field === column);
  return found?.[0] ?? column;
}

const reference = (row: Pick<LabelImportPreviewRow, 'values'>) => row.values.Code || row.values.Name || undefined;

/**
 * One line per row the import refuses or skips (outcome error or skip, which includes valid rows not selected), the
 * same rows the Error Log has always listed. Rows the import adds are not problems.
 */
export function labelImportProblemLines(rows: readonly LabelImportPreviewRow[], t: LabelProblemTranslator): ImportProblemLine[] {
  return rows.filter(row => row.outcome === 'error' || row.outcome === 'skip').map(row => {
    let detail: LabelImportReasonDetail = row.reasonDetail ?? labelReasonDetail(row.reason);
    if (detail === 'required' && !row.reasonField) detail = 'invalidRow';
    const column = detail === 'unsupportedCategory' ? undefined
      : row.reasonColumn ?? (row.reason ? labelReasonColumn(row.reason, row.sheet, row.reasonField) : undefined);
    const field = row.reasonField ? t(`labelsImportWizard.fields.${row.reasonField}`) : '';
    const notes = (row.warnings ?? []).filter(warning => warning === LABEL_LEGACY_HEADERS_WARNING).map(() => t('labelsImportWizard.problem.legacyHeaders'));
    const line: ImportProblemLine = {
      row: row.row,
      category: labelCategoryCaption(row.sheet, t),
      problem: [t(`labelsImportWizard.problem.${detail}`, { field }), ...notes].join(' '),
      correction: t(`labelsImportWizard.fix.${detail}`, { field }),
      stage: 'check',
      result: row.outcome === 'error' ? 'refused' : 'skipped',
    };
    const ref = reference(row);
    if (ref !== undefined) line.reference = ref;
    if (column) { line.field = labelColumnCaption(row.sheet, column); line.value = row.values[column] ?? ''; }
    return line;
  });
}

/** A row that stopped a background import while saving (stored on the job's plan when it failed). */
export type SystemLabelImportFailedRow = {
  sheet: string; row: number | null; code: string;
  /** releaseConflict: the code appeared while the import ran; gradeAlreadyGrouped: its owner's refusal; saveRefused: any other refusal. */
  detail: 'releaseConflict' | 'gradeAlreadyGrouped' | 'saveRefused';
  /** The public refusal text; shown only for saveRefused, which has no catalogue sentence. */
  message: string;
};

/** Lines for an import that stopped and saved nothing. A failure that names no row is one whole-file line. */
export function labelImportFailureLines(p: { failed?: readonly SystemLabelImportFailedRow[]; errors?: readonly { rowNum: number; ref: string; message: string }[];
  error?: string | null; jobId: string }, t: LabelProblemTranslator): ImportProblemLine[] {
  if (p.failed?.length) return p.failed.map(row => {
    const line: ImportProblemLine = {
      row: row.row, category: labelCategoryCaption(row.sheet, t),
      problem: row.detail === 'saveRefused' ? row.message : t(`labelsImportWizard.problem.${row.detail}`, { code: row.code }),
      correction: t(`labelsImportWizard.fix.${row.detail}`), stage: 'save', result: 'stopped',
    };
    if (row.code) line.reference = row.code;
    if (row.detail === 'saveRefused') line.errorReference = p.jobId;
    return line;
  });
  // Jobs that stopped before rows were recorded this way still carry the kernel's row errors.
  if (p.errors?.length) return p.errors.map(error => ({ row: error.rowNum || null, ...(error.ref ? { reference: error.ref } : {}), problem: error.message,
    correction: t('labelsImportWizard.fix.saveRefused'), stage: 'save', result: 'stopped', errorReference: p.jobId }));
  return p.error ? [{ row: null, problem: p.error, correction: t('labelsImportWizard.fix.saveRefused'), stage: 'system', result: 'not_saved', errorReference: p.jobId }] : [];
}

/** A finished background import's lines: the rows it refused or skipped, or for a failed one the rows that stopped it. */
export function labelJobProblemLines(source: { id: string; state: string; blocked: readonly LabelImportPreviewRow[]; failed: readonly SystemLabelImportFailedRow[];
  errors: readonly { rowNum: number; ref: string; message: string }[]; error: string | null }, t: LabelProblemTranslator): ImportProblemLine[] {
  return source.state === 'failed'
    ? labelImportFailureLines({ failed: source.failed, errors: source.errors, error: source.error, jobId: source.id }, t)
    : labelImportProblemLines(source.blocked, t);
}
