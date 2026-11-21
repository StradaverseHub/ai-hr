'use client';
/**
 * Boards c074c6b8 / d3ba1e9f: the on-screen list of import problems. Renders the same ImportProblemLine list,
 * through the same importProblemCells translator, as the Error Log workbook — so the screen and the file match.
 * Shows at most IMPORT_PROBLEM_SCREEN_LIMIT lines with a note pointing at the Error Log for the rest.
 */
import { useTranslations } from 'next-intl';
import { tableWrapCls, theadCls, thCls } from '@/components/ui';
import {
  IMPORT_PROBLEM_SCREEN_LIMIT, importProblemCells, importProblemColumns, importProblemHeaders, sortProblemLines,
  type ImportProblemColumn, type ImportProblemLine,
} from '@/lib/import-problem-lines';

export function ImportProblemTable({ lines, total, columns, caption }: {
  lines: readonly ImportProblemLine[];
  /** Total number of problems when `lines` is already a bounded slice (e.g. served from storage). */
  total?: number;
  columns?: readonly ImportProblemColumn[];
  caption?: string;
}) {
  const t = useTranslations('importProblems');
  if (lines.length === 0) return null;
  const sorted = sortProblemLines(lines);
  const shown = sorted.slice(0, IMPORT_PROBLEM_SCREEN_LIMIT);
  const cols = columns ?? importProblemColumns(sorted);
  const more = Math.max(0, (total ?? sorted.length) - shown.length);
  return (
    <div className="space-y-2">
      <div className={tableWrapCls}>
        <table className="w-full text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className={theadCls}><tr>{importProblemHeaders(cols, t).map((h, i) => <th key={cols[i]} scope="col" className={thCls}>{h}</th>)}</tr></thead>
          <tbody>
            {shown.map((line, r) => (
              <tr key={r} className="border-t align-top" data-problem-row={line.row ?? 'file'}>
                {importProblemCells(line, cols, t).map((cell, c) => (
                  <td key={cols[c]} className={'px-3 py-2' + (cols[c] === 'problem' ? ' text-destructive' : '') + (cols[c] === 'row' ? ' whitespace-nowrap tabular-nums' : '')}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 && <p className="text-xs text-muted-foreground">{t('moreInLog', { count: more })}</p>}
    </div>
  );
}
