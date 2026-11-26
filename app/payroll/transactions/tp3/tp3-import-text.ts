/**
 * 5084d02e — how a Form TP3 import row's COLUMN and REASON read, shared by the check dialog, the import page and the
 * problems CSV, so the three can never word one problem differently. Pure: the caller passes its `payroll.tp3Import`
 * translator (client or server).
 */
import type { Tp3ImportPlanRow, Tp3ImportResultRow } from '@/core/tp3-import-job';

type Translate = ((key: never, values?: never) => string) & { has: (key: never) => boolean };
const say = (t: Translate, key: string, values?: Record<string, string | number>) => t(key as never, values as never);

/** A form box (`C2(i)`, `D2`) reads as itself; the other columns in the reader's language. */
export function tp3ColumnLabel(t: Translate, field: string | undefined): string {
  if (!field) return '—';
  if (/^[CD]\d+(\([a-z]+\))?$/.test(field)) return field;
  const employer = /^employer(\d)(Name|Tin)$/.exec(field);
  if (employer) return say(t, `column.employer${employer[2]}`, { n: Number(employer[1]) });
  return t.has(`column.${field}` as never) ? say(t, `column.${field}`) : field;
}

/** A row's reason, with the values its message needs (a limit, the rows of a duplicate, a year). */
export function tp3RowReason(t: Translate, row: Pick<Tp3ImportPlanRow, 'reason' | 'detail'>): string {
  const reason = row.reason ?? 'unexpected';
  return t.has(`reason.${reason}` as never) ? say(t, `reason.${reason}`, row.detail ?? {}) : say(t, 'reason.unexpected');
}

/** A row's result on the import page and in the CSV. */
export function tp3RowResult(t: Translate, row: Tp3ImportResultRow): string {
  switch (row.state) {
    case 'problem': case 'notSaved': case 'failed': return row.reason ? tp3RowReason(t, row) : say(t, 'outcome.notSaved');
    case 'formOnly': return say(t, 'outcome.formOnly', { year: row.heldBy ?? '' });
    default: return say(t, `outcome.${row.state}`);
  }
}
