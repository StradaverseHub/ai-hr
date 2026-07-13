'use client';

import { useState } from 'react';

// 88e94371 — the Overtime section editor for a "Lateness, Early Out & Overtime Settings" rule. A dynamic
// table of OT time-bands (+ Add Row) plus the "Apply to Early Overtime" checkbox. Rows serialize into one
// hidden `otRows` JSON field the server action parses (mirrors the shift break-periods island). All labels
// are passed in already-translated so this island carries no next-intl dependency.

export type OtEditorRow = {
  fromH: number;
  fromM: number;
  toH: number;
  toM: number;
  ratePattern: 'flat' | 'variable';
  rate: string;
  rounding: boolean;
  roundToMinutes: number | null;
};

export type OtEditorLabels = {
  sectionTitle: string;
  addRow: string;
  colFrom: string;
  colTo: string;
  colPattern: string;
  colRate: string;
  colRounding: string;
  colRoundTo: string;
  colRemove: string;
  patternFlat: string;
  patternVariable: string;
  roundingYes: string;
  roundingNo: string;
  hour: string;
  min: string;
  applyEarlyOtLabel: string;
  applyEarlyOtHint: string;
  emptyHint: string;
};

const VARIABLE_RATES = ['1.0', '1.5', '2.0', '3.0'];
const ROUND_TO = [15, 30, 60];

export function AttendanceRuleOtEditor({
  initialRows,
  initialApplyEarlyOt,
  labels,
}: {
  initialRows: OtEditorRow[];
  initialApplyEarlyOt: boolean;
  labels: OtEditorLabels;
}) {
  const [rows, setRows] = useState<OtEditorRow[]>(initialRows);
  const [applyEarly, setApplyEarly] = useState(initialApplyEarlyOt);

  const update = (i: number, patch: Partial<OtEditorRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () =>
    setRows((rs) => [...rs, { fromH: 0, fromM: 0, toH: 0, toM: 0, ratePattern: 'flat', rate: '1.50', rounding: false, roundToMinutes: null }]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));

  const serialized = JSON.stringify(
    rows.map((r) => ({
      fromMinutes: (Number(r.fromH) || 0) * 60 + (Number(r.fromM) || 0),
      toMinutes: (Number(r.toH) || 0) * 60 + (Number(r.toM) || 0),
      ratePattern: r.ratePattern,
      rate: Number(r.rate) || 0,
      rounding: r.rounding,
      roundToMinutes: r.rounding ? r.roundToMinutes : null,
    })),
  );

  const numCls =
    'w-14 rounded border border-border bg-transparent px-1.5 py-1 text-sm tabular-nums text-foreground';
  const selCls = 'rounded border border-border bg-transparent px-1.5 py-1 text-sm text-foreground';

  return (
    <fieldset className="w-full">
      <input type="hidden" name="otRows" value={serialized} />
      <input type="hidden" name="applyToEarlyOt" value={applyEarly ? 'on' : ''} />
      <div className="mb-2 flex items-center justify-between gap-2">
        <legend className="text-sm font-semibold text-foreground">{labels.sectionTitle}</legend>
        <button
          type="button"
          onClick={addRow}
          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          {labels.addRow}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {labels.emptyHint}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">{labels.colFrom}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colTo}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colPattern}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colRate}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colRounding}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colRoundTo}</th>
                <th className="py-1.5 font-medium">{labels.colRemove}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-border/60">
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1">
                      <input type="number" min={0} value={r.fromH} onChange={(e) => update(i, { fromH: Number(e.target.value) })} className={numCls} aria-label={`${labels.colFrom} ${labels.hour}`} />
                      <span className="text-xs text-muted-foreground">{labels.hour}</span>
                      <input type="number" min={0} max={59} value={r.fromM} onChange={(e) => update(i, { fromM: Number(e.target.value) })} className={numCls} aria-label={`${labels.colFrom} ${labels.min}`} />
                      <span className="text-xs text-muted-foreground">{labels.min}</span>
                    </div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1">
                      <input type="number" min={0} value={r.toH} onChange={(e) => update(i, { toH: Number(e.target.value) })} className={numCls} aria-label={`${labels.colTo} ${labels.hour}`} />
                      <span className="text-xs text-muted-foreground">{labels.hour}</span>
                      <input type="number" min={0} max={59} value={r.toM} onChange={(e) => update(i, { toM: Number(e.target.value) })} className={numCls} aria-label={`${labels.colTo} ${labels.min}`} />
                      <span className="text-xs text-muted-foreground">{labels.min}</span>
                    </div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <select value={r.ratePattern} onChange={(e) => update(i, { ratePattern: e.target.value as 'flat' | 'variable' })} className={selCls} aria-label={labels.colPattern}>
                      <option value="flat">{labels.patternFlat}</option>
                      <option value="variable">{labels.patternVariable}</option>
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    {r.ratePattern === 'variable' ? (
                      <select value={r.rate} onChange={(e) => update(i, { rate: e.target.value })} className={selCls} aria-label={labels.colRate}>
                        {VARIABLE_RATES.map((v) => (
                          <option key={v} value={v}>{`${v}×`}</option>
                        ))}
                      </select>
                    ) : (
                      <input type="number" min={0} step="0.01" value={r.rate} onChange={(e) => update(i, { rate: e.target.value })} className={`${numCls} w-20`} aria-label={labels.colRate} />
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <select
                      value={r.rounding ? 'yes' : 'no'}
                      onChange={(e) => update(i, { rounding: e.target.value === 'yes', roundToMinutes: e.target.value === 'yes' ? (r.roundToMinutes ?? 15) : null })}
                      className={selCls}
                      aria-label={labels.colRounding}
                    >
                      <option value="no">{labels.roundingNo}</option>
                      <option value="yes">{labels.roundingYes}</option>
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <select
                      value={r.roundToMinutes ?? ''}
                      disabled={!r.rounding}
                      onChange={(e) => update(i, { roundToMinutes: e.target.value === '' ? null : Number(e.target.value) })}
                      className={`${selCls} disabled:opacity-40`}
                      aria-label={labels.colRoundTo}
                    >
                      <option value="">—</option>
                      {ROUND_TO.map((m) => (
                        <option key={m} value={m}>{`${m} ${labels.min}`}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5">
                    <button type="button" onClick={() => removeRow(i)} className="rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10" aria-label={labels.colRemove}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
        <input type="checkbox" checked={applyEarly} onChange={(e) => setApplyEarly(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-primary" />
        <span>
          <span className="font-medium text-foreground">{labels.applyEarlyOtLabel}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{labels.applyEarlyOtHint}</span>
        </span>
      </label>
    </fieldset>
  );
}
