'use client';

import { Fragment, useState } from 'react';

// 88e94371 — the Overtime section editor for a "Lateness, Early Out & Overtime Settings" rule. A dynamic
// table of OT time-bands (+ Add Row) plus the "Apply to Early Overtime" checkbox. Rows serialize into one
// hidden `otRows` JSON field the server action parses (mirrors the shift break-periods island). All labels
// are passed in already-translated so this island carries no next-intl dependency.

export type OtRoundingMode = 'none' | 'down' | 'up';

export type OtEditorRow = {
  fromH: number;
  fromM: number;
  toH: number;
  toM: number;
  ratePattern: 'flat' | 'variable';
  /** '' ⇒ nothing typed yet. 7c834696 contested: a NEW band starts here rather than at 1.5 — see addRow. */
  rate: string;
  /** 7c834696 — this band's public-holiday multiplier. '' ⇒ none set ⇒ the band uses `rate`. */
  phRate: string;
  /** 7c834696 contested (0439) — replaced the boolean whose only direction was, invisibly, down. */
  roundingMode: OtRoundingMode;
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
  roundingNone: string;
  roundingDown: string;
  roundingUp: string;
  roundToHint: string;
  rateFlatSuffix: string;
  rateUnset: string;
  hour: string;
  min: string;
  applyEarlyOtLabel: string;
  applyEarlyOtHint: string;
  emptyHint: string;
  colPhRate: string;
  phRateNone: string;
  ladderGapWarning: string;
  ladderOpenEndedWarning: string;
};

// 7c834696 — '0' is now offered: that portion of overtime is RECORDED but not paid (request §7).
//
// ADJACENT DEFECT FIXED HERE: these option values are compared by STRING, and the form loaded a saved rate
// as `Number(rate).toFixed(2)` — so a band saved at 1.5 came back as "1.50", matched no option, and the
// select silently displayed the FIRST rate instead. Re-saving the rule then wrote that wrong rate. Both
// sides are now one decimal place, and a stored rate outside this list is offered as its own option rather
// than being quietly rewritten.
const VARIABLE_RATES = ['0.0', '1.0', '1.5', '2.0', '3.0'];
const ratesFor = (current: string): string[] =>
  current !== '' && !VARIABLE_RATES.some((v) => Number(v) === Number(current))
    ? [current, ...VARIABLE_RATES]
    : VARIABLE_RATES;
/**
 * The SAME ladder rule the server enforces (core/attendance-rule.ts validateOtLadder), evaluated live so a
 * broken table announces itself the moment the rule is opened instead of ambushing the admin on Save.
 *
 * This matters because of one real rule on production: its band table predates any validation, so an admin
 * who opens it to change something unrelated would otherwise be refused with an error about rows they never
 * authored. Refusing is still correct — a table with a hole in it now decides which rate column overtime
 * lands in — but being TOLD on open, next to the offending row, turns a blocked save into a visible ten-
 * second repair. Returns a per-row message keyed by row index; rows not at fault get nothing.
 */
const ladderProblems = (rows: OtEditorRow[], labels: OtEditorLabels): Map<number, string> => {
  const out = new Map<number, string>();
  const to = (r: OtEditorRow) => (Number(r.toH) || 0) * 60 + (Number(r.toM) || 0);
  const from = (r: OtEditorRow) => (Number(r.fromH) || 0) * 60 + (Number(r.fromM) || 0);
  const fill = (t: string, v: Record<string, number>) =>
    Object.entries(v).reduce((acc, [k, n]) => acc.split(`{${k}}`).join(String(n)), t);
  for (let i = 0; i < rows.length; i++) {
    if (to(rows[i]) <= from(rows[i]) && i !== rows.length - 1) {
      out.set(i, fill(labels.ladderOpenEndedWarning, { row: i + 1 }));
      continue;
    }
    if (i === 0) continue;
    const prevTo = to(rows[i - 1]);
    if (from(rows[i]) !== prevTo + 1) {
      out.set(i, fill(labels.ladderGapWarning, { row: i + 1, prev: i, expected: prevTo + 1, actual: from(rows[i]) }));
    }
  }
  return out;
};

/** The option string that represents a stored value, so string comparison in the select cannot miss.
 *
 *  '' short-circuits, and that guard is load-bearing rather than defensive: `Number('')` is 0, so without
 *  it an EMPTY rate would match the '0.0' option and a band nobody had filled in would display — and then
 *  save — as "record the hours, pay nothing". Empty became reachable in this release (addRow no longer
 *  seeds 1.5), so the guard arrives with it. */
const rateValue = (current: string): string =>
  current === '' ? '' : (VARIABLE_RATES.find((v) => Number(v) === Number(current)) ?? current);

/** The `From` a new row must start at: one minute past the last row's `To` (0 for the first row). */
const nextFromMinutes = (rows: OtEditorRow[]): number => {
  const last = rows[rows.length - 1];
  if (!last) return 0;
  return (Number(last.toH) || 0) * 60 + (Number(last.toM) || 0) + 1;
};

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
  const problems = ladderProblems(rows, labels);

  const update = (i: number, patch: Partial<OtEditorRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () =>
    setRows((rs) => [
      ...rs,
      // A new row starts where the previous one ended + 1 minute, which is exactly what the ladder
      // validation demands — so "+ Add Row" produces a saveable table instead of one that is rejected.
      {
        fromH: Math.floor(nextFromMinutes(rs) / 60),
        fromM: nextFromMinutes(rs) % 60,
        toH: 0,
        toM: 0,
        ratePattern: 'flat',
        // 7c834696 contested — EMPTY, not '1.5'. The reporter read a new Flat band's pre-filled 1.5 as the
        // system having decided the band was time-and-a-half. The rate is real (core/attendance-calc.ts
        // rateForDay reads it), so it cannot be removed; what it can stop doing is pretending to be an
        // answer. Blank, plus the "× basic rate" label on the cell, plus a save that refuses an empty one.
        rate: '',
        phRate: '',
        roundingMode: 'none',
        roundToMinutes: null,
      },
    ]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));

  const serialized = JSON.stringify(
    rows.map((r) => ({
      fromMinutes: (Number(r.fromH) || 0) * 60 + (Number(r.fromM) || 0),
      toMinutes: (Number(r.toH) || 0) * 60 + (Number(r.toM) || 0),
      ratePattern: r.ratePattern,
      // null, NOT 0 — the server must be able to tell "not filled in" from the deliberate 0× ("record the
      // hours but do not pay them"). It refuses the first and stores the second.
      rate: r.rate === '' || !Number.isFinite(Number(r.rate)) ? null : Number(r.rate),
      phRate: r.phRate === '' ? null : Number(r.phRate) || 0,
      roundingMode: r.roundingMode,
      roundToMinutes: r.roundingMode === 'none' ? null : r.roundToMinutes,
    })),
  );

  const numCls =
    'w-14 rounded border border-border bg-transparent px-1.5 py-1 text-sm tabular-nums text-foreground';
  const selCls = 'rounded border border-border bg-transparent px-1.5 py-1 text-sm text-foreground';

  return (
    <fieldset className="w-full">
      <input type="hidden" name="otRows" value={serialized} />
      {/* 7c834696 contested — "How come I cannot untick Apply to Early Overtime?" They were right, and the
          cause was here. A hidden input is submitted ALWAYS, whatever its value, so an unticked box still
          put `applyToEarlyOt` in the FormData with an empty string — and the reader (rule-actions.ts) asked
          only whether the field was PRESENT. The flag therefore saved as true on every save and could never
          be cleared, on a setting that folds pre-shift minutes into paid overtime.

          Rendered conditionally so it behaves exactly like the real checkboxes on this form: present when
          on, ABSENT when off. The visible control above carries no `name` (it is a controlled React
          checkbox), which is why this hidden field exists at all. rule-actions.ts's reader is hardened in
          the same change, so neither half depends on the other being right. */}
      {applyEarly && <input type="hidden" name="applyToEarlyOt" value="on" />}
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
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">{labels.colFrom}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colTo}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colPattern}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colRate}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colPhRate}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colRounding}</th>
                <th className="py-1.5 pr-2 font-medium">{labels.colRoundTo}</th>
                <th className="py-1.5 font-medium">{labels.colRemove}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Fragment key={i}>
                <tr className={`border-b border-border/60 ${problems.has(i) ? 'bg-amber-50/60 dark:bg-amber-500/10' : ''}`}>
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
                    {/* 7c834696 contested — a band's rate is never guessed for the admin. `required` on both
                        controls is real validation, not decoration: a control with no `name` is still a
                        candidate for HTML constraint validation, so an empty rate blocks the submit in the
                        browser, and core/attendance-rule.ts refuses it again on the server. */}
                    {r.ratePattern === 'variable' ? (
                      <select required value={rateValue(r.rate)} onChange={(e) => update(i, { rate: e.target.value })} className={selCls} aria-label={labels.colRate}>
                        {r.rate === '' && <option value="">{labels.rateUnset}</option>}
                        {ratesFor(r.rate).map((v) => (
                          <option key={v} value={v}>{`${v}×`}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="flex items-center gap-1">
                        <input type="number" required min={0} step="0.01" value={r.rate} onChange={(e) => update(i, { rate: e.target.value })} className={`${numCls} w-20`} aria-label={labels.colRate} />
                        {/* The label the request asked for. "Flat" names the PATTERN (one rate for the whole
                            band, whatever the day); the number is still a multiplier the engine reads, so it
                            is labelled as one rather than hidden. */}
                        <span className="whitespace-nowrap text-xs text-muted-foreground">{labels.rateFlatSuffix}</span>
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {/* Blank = this band has no separate holiday multiplier and falls back to its ordinary
                        rate, which is what every existing band does today. A FLAT band has no rate to pick,
                        so it has no holiday rate to pick either. */}
                    {r.ratePattern === 'variable' ? (
                      <select value={rateValue(r.phRate)} onChange={(e) => update(i, { phRate: e.target.value })} className={selCls} aria-label={labels.colPhRate}>
                        <option value="">{labels.phRateNone}</option>
                        {ratesFor(r.phRate).map((v) => (
                          <option key={v} value={v}>{`${v}×`}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {/* 7c834696 contested — three answers, not two. The old Yes/No could not say WHICH WAY,
                        and the engine's answer (always floor) was invisible on this screen. */}
                    <select
                      value={r.roundingMode}
                      onChange={(e) => {
                        const mode = e.target.value as OtRoundingMode;
                        update(i, { roundingMode: mode, roundToMinutes: mode === 'none' ? null : (r.roundToMinutes ?? 15) });
                      }}
                      className={selCls}
                      aria-label={labels.colRounding}
                    >
                      <option value="none">{labels.roundingNone}</option>
                      <option value="down">{labels.roundingDown}</option>
                      <option value="up">{labels.roundingUp}</option>
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    {/* Was a fixed 15 / 30 / 60 list, so a policy that rounds to 5 or 10 minutes could not be
                        expressed at all. `min={1}` refuses 0 in the browser; core/attendance-rule.ts refuses
                        it again on save, and 0439 refuses it in the database — 0 divides by zero in the pay
                        path, and the old `> 0` guard made it behave as "no rounding" by accident. */}
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        required={r.roundingMode !== 'none'}
                        value={r.roundingMode === 'none' ? '' : (r.roundToMinutes ?? '')}
                        disabled={r.roundingMode === 'none'}
                        onChange={(e) => update(i, { roundToMinutes: e.target.value === '' ? null : Math.trunc(Number(e.target.value)) })}
                        className={`${numCls} disabled:opacity-40`}
                        aria-label={labels.colRoundTo}
                        title={labels.roundToHint}
                      />
                      <span className="text-xs text-muted-foreground">{labels.min}</span>
                    </div>
                  </td>
                  <td className="py-1.5">
                    <button type="button" onClick={() => removeRow(i)} className="rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10" aria-label={labels.colRemove}>
                      ✕
                    </button>
                  </td>
                </tr>
                {problems.has(i) && (
                  <tr className="border-b border-border/60 bg-amber-50/60 dark:bg-amber-500/10">
                    <td colSpan={8} className="px-1 pb-1.5 text-xs text-amber-800 dark:text-amber-200">
                      {problems.get(i)}
                    </td>
                  </tr>
                )}
                </Fragment>
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
