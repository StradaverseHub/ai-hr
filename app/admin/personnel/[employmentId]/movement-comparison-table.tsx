export type MovementComparisonRow = {
  key: string;
  label: string;
  before: string | null | undefined;
  after: string | null | undefined;
};

/** One table for ordinary comparisons and retained exit information. It receives
 * authorised display values only; no current-employment state is inferred here. */
export function MovementComparisonTable({rows, hasBefore, labels, exit}: {
  rows: MovementComparisonRow[];
  hasBefore: boolean;
  labels: {field: string; before: string; after: string; firstRecord: string};
  exit?: {title: string; note: string; column: string};
}) {
  return <table className="w-full table-fixed border-t border-border text-sm">
    {exit && <caption className="caption-top border-t border-border px-4 py-3 text-left">
      <span className="block font-medium text-foreground">{exit.title}</span>
      <span className="mt-1 block text-sm text-muted-foreground">{exit.note}</span>
    </caption>}
    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
      <tr>
        <th scope="col" className="break-words px-2 py-2 font-medium sm:px-4">{labels.field}</th>
        <th scope="col" className="break-words px-2 py-2 font-medium sm:px-4">{labels.before}</th>
        <th scope="col" className="break-words px-2 py-2 font-medium sm:px-4">{exit?.column ?? labels.after}</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-border">
      {rows.map(row => {
        const changed = hasBefore && (row.before ?? null) !== (row.after ?? null);
        return <tr key={row.key} className={changed ? 'bg-primary/5' : undefined}>
          <th scope="row" className="break-words px-2 py-2.5 text-left font-normal text-muted-foreground sm:px-4">{row.label}</th>
          <td className="break-words px-2 py-2.5 text-foreground sm:px-4">{hasBefore ? row.before ?? '—' : labels.firstRecord}</td>
          <td className={`break-words px-2 py-2.5 font-medium sm:px-4 ${changed ? 'text-primary' : 'text-foreground'}`}>{row.after ?? '—'}</td>
        </tr>;
      })}
    </tbody>
  </table>;
}
