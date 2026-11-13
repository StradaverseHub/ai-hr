/**
 * Boards c074c6b8 (System Labels import) and d3ba1e9f (Personnel Management imports): ONE description of an
 * import problem, shared by the on-screen problem table and the downloadable Error Log, so the two can never
 * say different things.
 *
 * Client-safe: no database, no React, no server-only imports. Each import owns an adapter that maps its own
 * validation result onto ImportProblemLine; this module owns the shape, the column order, value bounding and
 * masking, and the translation of every cell. Both the table (components/import-problem-table.tsx) and the
 * workbook writer (lib/import-problem-workbook.ts) render through importProblemCells, which is what makes the
 * screen and the file identical: same lines in, same translator in, same strings out.
 *
 * Wording ownership: `problem` and `correction` arrive ALREADY TRANSLATED by the adapter (it knows its own
 * reason codes and message keys). This module translates only the shared vocabulary: column headers, stage,
 * result, the hidden-value marker and the whole-file row marker (namespace importProblems in messages/*.json).
 */

/** Where the problem was found. `file` = a whole-file problem (missing column, wrong template, too large). */
export type ImportProblemStage = 'file' | 'check' | 'save' | 'system';

/** What happened to the row.
 *  refused   – the check refused it; it was not imported.
 *  skipped   – the import went ahead without it (System Labels "skip", e.g. already exists / not selected).
 *  stopped   – refused while saving, and that stopped the whole file (all-or-nothing imports).
 *  cancelled – valid, but not saved because another row stopped the file.
 *  not_saved – generic "not saved, upload the corrected file again" (e.g. a technical failure). */
export type ImportProblemResult = 'refused' | 'skipped' | 'stopped' | 'cancelled' | 'not_saved';

/** A value the Error Log must not repeat (identity, passport, bank, statutory and salary values). */
export const HIDDEN_VALUE = Symbol.for('ai-hr.import-problem.hidden');

export type ImportProblemLine = {
  /** Worksheet the row came from, when the file has several sheets. Display text, not an internal key. */
  sheet?: string;
  /** The row number exactly as Excel numbers it (header row included). null for a whole-file problem. */
  row: number | null;
  /** Category of record, e.g. a System Labels category ("Departments"). Display text. */
  category?: string;
  /** Employee ID, label code or other identifying reference for the row. */
  reference?: string;
  employeeName?: string;
  /** Column / field caption as it appears in the template header. Display text. */
  field?: string;
  /** The entered value; HIDDEN_VALUE when it must not be repeated; undefined when not applicable. */
  value?: string | typeof HIDDEN_VALUE;
  /** What is wrong, already translated. */
  problem: string;
  /** How to fix it, already translated. Optional: "where applicable". */
  correction?: string;
  stage: ImportProblemStage;
  result: ImportProblemResult;
  /** Short reference the technical team can look up, for system failures. */
  errorReference?: string;
};

/** Every column, in display order. A column is shown only when at least one line has a value for it. */
export const IMPORT_PROBLEM_COLUMNS = [
  'sheet', 'row', 'category', 'reference', 'employeeName', 'field', 'value', 'problem', 'correction', 'stage', 'result', 'errorReference',
] as const;
export type ImportProblemColumn = (typeof IMPORT_PROBLEM_COLUMNS)[number];

/** The screen shows at most this many lines (with a "N more in the Error Log" note); the file has them all. */
export const IMPORT_PROBLEM_SCREEN_LIMIT = 200;
/** An entered value is cut to this many characters (an Excel cell holds 32,767; a screen cell far fewer). */
export const IMPORT_PROBLEM_VALUE_MAX = 200;

/** Bound an entered value for display. Keeps whole code points; marks a cut with an ellipsis. */
export function boundProblemValue(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const chars = [...String(value)];
  return chars.length > IMPORT_PROBLEM_VALUE_MAX ? chars.slice(0, IMPORT_PROBLEM_VALUE_MAX - 1).join('') + '…' : chars.join('');
}

/** Order lines: whole-file problems first, then by sheet (first appearance), then Excel row. Stable. */
export function sortProblemLines(lines: readonly ImportProblemLine[]): ImportProblemLine[] {
  const sheetOrder = new Map<string, number>();
  for (const l of lines) if (l.sheet !== undefined && !sheetOrder.has(l.sheet)) sheetOrder.set(l.sheet, sheetOrder.size);
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => {
      const af = a.line.row === null ? 0 : 1, bf = b.line.row === null ? 0 : 1;
      if (af !== bf) return af - bf;
      const as = a.line.sheet === undefined ? -1 : sheetOrder.get(a.line.sheet)!, bs = b.line.sheet === undefined ? -1 : sheetOrder.get(b.line.sheet)!;
      if (as !== bs) return as - bs;
      if ((a.line.row ?? 0) !== (b.line.row ?? 0)) return (a.line.row ?? 0) - (b.line.row ?? 0);
      return a.index - b.index;
    })
    .map(x => x.line);
}

/** The columns that carry information for this set of lines (always row, problem and result). */
export function importProblemColumns(lines: readonly ImportProblemLine[]): ImportProblemColumn[] {
  const always = new Set<ImportProblemColumn>(['row', 'problem', 'result']);
  return IMPORT_PROBLEM_COLUMNS.filter(c => always.has(c) || lines.some(l => {
    const v = l[c as keyof ImportProblemLine];
    return v !== undefined && v !== '';
  }));
}

/**
 * The translator both renderers pass in. On the client: useTranslations('importProblems'). On the server:
 * getTranslations({ locale, namespace: 'importProblems' }). Keys used: headers.<column>, stage.<stage>,
 * result.<result>, hiddenValue, wholeFile.
 */
export type ImportProblemTranslator = (key: string) => string;

/** Header captions for the given columns. */
export function importProblemHeaders(columns: readonly ImportProblemColumn[], t: ImportProblemTranslator): string[] {
  return columns.map(c => t(`headers.${c}`));
}

/** One line's cells for the given columns, as display text. The ONLY place a line becomes text. */
export function importProblemCells(line: ImportProblemLine, columns: readonly ImportProblemColumn[], t: ImportProblemTranslator): string[] {
  return columns.map(c => {
    switch (c) {
      case 'row': return line.row === null ? t('wholeFile') : String(line.row);
      case 'value': return line.value === HIDDEN_VALUE ? t('hiddenValue') : boundProblemValue(line.value) ?? '';
      case 'stage': return t(`stage.${line.stage}`);
      case 'result': return t(`result.${line.result}`);
      default: return (line[c] as string | undefined) ?? '';
    }
  });
}
