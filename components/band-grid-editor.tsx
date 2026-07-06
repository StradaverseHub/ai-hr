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
 * Conventions matched from the original PCB grid:
 *   - The last row is the open-ended top band: its "Wage To" placeholder reads `topBandLabel` and an empty
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
  /** When true, this column is the open-ended "Wage To" ceiling: the last row shows `topBandLabel`. */
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
  /** Do not allow removing below this many rows (default 1). */
  minRows?: number;
}) {
  const lastIndex = rows.length - 1;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
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
