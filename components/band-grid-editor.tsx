'use client';

/**
 * BandGridEditor — a reusable, Excel-like editable grid for wage-band statutory tables.
 *
 * Extracted from the PCB band <table> in statutory-config-form.tsx so the EPF (feedback 99e13860) and
 * SOCSO/EIS (sibling feedback ee6e1292) band tables can all be maintained through ONE component with
 * different columns. It renders string-typed cells and hands edits back to the parent's form state; the
 * parent owns conversion (percent↔fraction, band assembly) and validation. The grid is purely presentational
 * over `rows` — it never mutates the underlying ruleset.
 *
 * ONE generic component serves both consumers (R13 wave-2 reconcile):
 *   - EPF (99e13860) drives it with the generic `BandColumn<Row>` spec and `isCeiling` for the open-ended
 *     top band.
 *   - SOCSO/EIS (ee6e1292) additionally wants a derived read-only "From" column (previous row's ceiling
 *     + 0.01). That is an OPTIONAL capability: pass `fromHeader` and the grid renders the derived column;
 *     omit it (EPF/PCB) and the column disappears. The derived value is computed from whichever column is
 *     marked `isCeiling` (the wage-ceiling / upTo column), matching how `ContribBand`/`SocsoBand` model
 *     each band by a single upper bound.
 *
 * Conventions matched from the original PCB grid:
 *   - The last row is the open-ended top band: its ceiling placeholder reads `topBandLabel` and an empty
 *     value means +∞ (the parent maps '' → null when assembling).
 *   - Every column is a numeric <input step="any">; formatting (e.g. percent) is the parent's concern —
 *     the cell just edits the raw string the parent stores.
 */

export type BandColumn<Row> = {
  /** Column header label (already localized by the caller). */
  label: string;
  /** Which key of the row this column edits. */
  key: keyof Row & string;
  /** Optional Tailwind width class for the input (defaults to a medium width). */
  widthCls?: string;
  /** When true, this column is the open-ended "Wage To" ceiling: the last row shows `topBandLabel`,
   *  and — when `fromHeader` is set — the derived read-only "From" column is computed from this column. */
  isCeiling?: boolean;
};

export function BandGridEditor<Row extends Record<string, string>>({
  columns,
  rows,
  onCell,
  onAddRow,
  onRemoveRow,
  inputCls,
  topBandLabel,
  addRowLabel,
  removeRowLabel,
  actionsHeader,
  fromHeader,
  minRows = 1,
}: {
  columns: BandColumn<Row>[];
  rows: Row[];
  /** Edit one cell: (rowIndex, columnKey, newValue). */
  onCell: (rowIndex: number, key: keyof Row & string, value: string) => void;
  /** Append a blank row (inserted just before the open-ended top band when a ceiling column exists). */
  onAddRow: () => void;
  /** Remove the row at rowIndex. */
  onRemoveRow: (rowIndex: number) => void;
  inputCls: string;
  /** Placeholder for the open-ended top band's ceiling cell (e.g. "and above"). */
  topBandLabel: string;
  addRowLabel: string;
  removeRowLabel: string;
  /** Header for the row-actions column (visually hidden text is fine). */
  actionsHeader: string;
  /** When set, render a leading derived read-only "From" column (prev row's ceiling + 0.01). Used by the
   *  SOCSO/EIS RM-amount tables (feedback ee6e1292); omitted by EPF/PCB. Requires a column marked
   *  `isCeiling` to derive the value from. */
  fromHeader?: string;
  /** Do not allow removing below this many rows (default 1). */
  minRows?: number;
}) {
  const lastIndex = rows.length - 1;
  const ceilingKey = columns.find((c) => c.isCeiling)?.key;

  /** Derived, display-only "From" = previous row's ceiling + 0.01 (first row starts at 0.00). Only used
   *  when `fromHeader` is provided AND a ceiling column exists. */
  const fromFor = (i: number): string => {
    if (i === 0) return '0.00';
    if (!ceilingKey) return '—';
    const prev = rows[i - 1]?.[ceilingKey]?.trim();
    if (!prev) return '—';
    const n = parseFloat(prev);
    return Number.isFinite(n) ? (n + 0.01).toFixed(2) : '—';
  };

  const showFrom = fromHeader != null && ceilingKey != null;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {showFrom && <th className="py-1.5 pr-3 font-medium">{fromHeader}</th>}
              {columns.map((c) => (
                <th key={c.key} className="py-1.5 pr-3 font-medium">
                  {c.label}
                </th>
              ))}
              <th className="py-1.5 font-medium">
                <span className="sr-only">{actionsHeader}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isTop = i === lastIndex;
              return (
                <tr key={i} className="border-t border-border">
                  {showFrom && (
                    <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{fromFor(i)}</td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className="py-1.5 pr-3">
                      <input
                        type="number"
                        step="any"
                        value={row[c.key]}
                        placeholder={c.isCeiling && isTop ? topBandLabel : ''}
                        onChange={(e) => onCell(i, c.key, e.target.value)}
                        className={`${inputCls} h-8 ${c.widthCls ?? 'w-28'}`}
                      />
                    </td>
                  ))}
                  <td className="py-1.5">
                    <button
                      type="button"
                      onClick={() => onRemoveRow(i)}
                      disabled={rows.length <= minRows}
                      aria-label={removeRowLabel}
                      title={removeRowLabel}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
                    >
                      <span aria-hidden>&times;</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={onAddRow}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-input px-3 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <span aria-hidden>+</span> {addRowLabel}
      </button>
    </div>
  );
}
