import { formatDmyTime, formatDmy } from '@/lib/date-display';

/**
 * bc6b5490 — the CP38 correction history (employee_cp38_revision), drawn the same way on the employee's Payroll tab
 * and on the Payroll > Transaction Entry > CP38 Deduction page: one entry per edit or delete, newest first, with who
 * and when, and the fields that changed as before → after (a delete shows the record as it was).
 *
 * A plain component with no hooks and no data import: both pages read the rows (core/cp38.ts listCp38Revisions) and
 * pass them in with pre-translated labels, so it renders in a server tree or inside a client pop-up alike.
 */
export type Cp38HistoryValues = {
  cp38Ref: string;
  amount: string;
  lastMonthAmount: string | null;
  validFrom: string;
  validTo: string | null;
  remarks: string | null;
};
export type Cp38HistoryEntry = {
  id: string;
  /** The record the entry is about, so a screen can show one record's history. */
  cp38Id: string;
  action: 'edit' | 'delete';
  before: Cp38HistoryValues;
  after: Cp38HistoryValues | null;
  actorName: string | null;
  /** A signed-in user made it; false for a system or data step. */
  byUser: boolean;
  /** ISO timestamp (plain data across the client boundary). */
  at: string;
};
export type Cp38HistoryLabels = {
  empty: string;
  edited: string;
  deleted: string;
  system: string;
  /** A user with no person record (a service login). */
  administrator: string;
  field: string;
  before: string;
  after: string;
  open: string;
  none: string;
  fields: Record<keyof Cp38HistoryValues, string>;
};

const FIELDS: (keyof Cp38HistoryValues)[] = ['cp38Ref', 'amount', 'lastMonthAmount', 'validFrom', 'validTo', 'remarks'];

function shown(field: keyof Cp38HistoryValues, v: Cp38HistoryValues | null, labels: Cp38HistoryLabels): string {
  if (!v) return '—';
  const value = v[field];
  if (field === 'validTo' && value == null) return labels.open;
  if (value == null || value === '') return labels.none;
  if (field === 'amount' || field === 'lastMonthAmount') {
    return Number(value).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (field === 'validFrom' || field === 'validTo') return formatDmy(value);
  return String(value);
}

export function Cp38HistoryList({ entries, labels }: { entries: readonly Cp38HistoryEntry[]; labels: Cp38HistoryLabels }) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">{labels.empty}</p>;
  return (
    <ol className="space-y-4" data-cp38-history="">
      {entries.map((entry) => {
        // An edit lists the fields it changed; a delete lists the whole record as it was.
        const fields =
          entry.action === 'delete'
            ? FIELDS
            : FIELDS.filter((f) => shown(f, entry.before, labels) !== shown(f, entry.after, labels));
        return (
          <li key={entry.id} className="rounded-md border border-border p-3" data-cp38-history-action={entry.action}>
            <p className="text-sm font-medium text-foreground">
              {entry.action === 'delete' ? labels.deleted : labels.edited} · {entry.before.cp38Ref}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {entry.actorName ?? (entry.byUser ? labels.administrator : labels.system)} · {formatDmyTime(entry.at)}
            </p>
            <table className="mt-2 w-full text-left text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">{labels.field}</th>
                  <th className="py-1 pr-3 font-medium">{labels.before}</th>
                  {entry.action === 'edit' && <th className="py-1 font-medium">{labels.after}</th>}
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f} className="border-t border-border/60">
                    <td className="py-1 pr-3 text-muted-foreground">{labels.fields[f]}</td>
                    <td className="py-1 pr-3 tabular-nums">{shown(f, entry.before, labels)}</td>
                    {entry.action === 'edit' && <td className="py-1 tabular-nums">{shown(f, entry.after, labels)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        );
      })}
    </ol>
  );
}
