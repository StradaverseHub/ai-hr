'use client';

import { useState, useTransition } from 'react';
import { previewAdjustmentAction, saveAdjustmentAction } from './actions';

/**
 * 2961a7ae — the adjustment grid and its Review step.
 *
 * TWO STATES, ONE FORM. Edit shows System / Adjustment / Final per line; Review shows only the lines that
 * moved plus the effect on Total Deduction and Net Pay, and is reached by asking the SERVER for the
 * before/after rather than working it out here. That is deliberate: a preview computed in the browser is
 * a second implementation of the kernel's composition and would drift from it. The server answers with
 * `previewStatutoryAdjustment`, the same pure function the engine test pins to a regenerated payslip.
 *
 * BLANK IS NOT ZERO. The inputs are plain text (not `type=number` with a 0 default): an empty box posts
 * '' and stores NULL — "use the system amount" — while a typed 0 posts '0' and stores 0.00. The Final
 * column reflects that distinction live, so the operator can see which of the two they have keyed.
 */

export type AdjustmentLine = {
  line: string;
  label: string;
  system: number;
  current: number | null;
  employer: boolean;
};

type Preview = {
  lines: { line: string; system: number; applied: number; delta: number }[];
  grossBefore: number; grossAfter: number;
  deductionsBefore: number; deductionsAfter: number;
  netBefore: number; netAfter: number;
  employerCostBefore: number; employerCostAfter: number;
  netFloorReached: boolean;
};

const money = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function AdjustmentForm({
  batchId,
  employmentId,
  lines,
  initialReason,
  labels,
}: {
  batchId: string;
  employmentId: string;
  lines: AdjustmentLine[];
  initialReason: string;
  labels: {
    colItem: string; colSystem: string; colAdjustment: string; colFinal: string;
    employeeHeading: string; employerHeading: string;
    reason: string; reasonHint: string;
    review: string; backToEdit: string; confirmApply: string;
    reviewHeading: string; noChanges: string; reasonRequired: string;
    beforeCol: string; afterCol: string;
    rowGross: string; rowDeductions: string; rowNet: string; rowEmployerCost: string;
    netFloorWarning: string;
    blankMeansSystem: string;
  };
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.line, l.current == null ? '' : l.current.toFixed(2)])),
  );
  const [reason, setReason] = useState(initialReason);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const finalOf = (l: AdjustmentLine) => {
    const raw = (values[l.line] ?? '').trim();
    if (raw === '') return l.system;
    const n = Number(raw);
    return Number.isFinite(n) ? n : l.system;
  };
  const overridden = (l: AdjustmentLine) => (values[l.line] ?? '').trim() !== '';
  const anyOverride = lines.some(overridden);

  const onReview = () => {
    setError(null);
    if (!reason.trim()) {
      setError(labels.reasonRequired);
      return;
    }
    if (!anyOverride) {
      setError(labels.noChanges);
      return;
    }
    startTransition(async () => {
      const r = await previewAdjustmentAction({ batchId, employmentId, values });
      if (!r.ok) setError(labels.noChanges);
      else setPreview(r.preview as Preview);
    });
  };

  if (preview) {
    return (
      <form action={saveAdjustmentAction} className="space-y-4">
        <input type="hidden" name="batchId" value={batchId} />
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="reason" value={reason} />
        {lines.map((l) => (
          <input key={l.line} type="hidden" name={l.line} value={values[l.line] ?? ''} />
        ))}

        <h3 className="text-sm font-semibold">{labels.reviewHeading}</h3>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{labels.colItem}</th>
                <th className="px-3 py-2 text-right font-medium">{labels.colSystem}</th>
                <th className="px-3 py-2 text-right font-medium">{labels.colFinal}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.lines.map((m) => (
                <tr key={m.line}>
                  <td className="px-3 py-2">{lines.find((l) => l.line === m.line)?.label ?? m.line}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money(m.system)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{money(m.applied)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium" />
                <th className="px-3 py-2 text-right font-medium">{labels.beforeCol}</th>
                <th className="px-3 py-2 text-right font-medium">{labels.afterCol}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(
                [
                  [labels.rowGross, preview.grossBefore, preview.grossAfter],
                  [labels.rowDeductions, preview.deductionsBefore, preview.deductionsAfter],
                  [labels.rowNet, preview.netBefore, preview.netAfter],
                  [labels.rowEmployerCost, preview.employerCostBefore, preview.employerCostAfter],
                ] as [string, number, number][]
              ).map(([label, before, after]) => (
                <tr key={label}>
                  <td className="px-3 py-2">{label}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money(before)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${before === after ? 'text-muted-foreground' : 'font-medium'}`}>
                    {money(after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {preview.netFloorReached && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
            {labels.netFloorWarning}
          </p>
        )}

        <p className="text-xs text-muted-foreground">{reason}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setPreview(null)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm"
          >
            {labels.backToEdit}
          </button>
          <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
            {labels.confirmApply}
          </button>
        </div>
      </form>
    );
  }

  const group = (employer: boolean) => lines.filter((l) => l.employer === employer);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{labels.colItem}</th>
              <th className="px-3 py-2 text-right font-medium">{labels.colSystem}</th>
              <th className="px-3 py-2 text-right font-medium">{labels.colAdjustment}</th>
              <th className="px-3 py-2 text-right font-medium">{labels.colFinal}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {([false, true] as const).flatMap((employer) => [
              <tr key={`h-${String(employer)}`} className="bg-muted/30">
                <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {employer ? labels.employerHeading : labels.employeeHeading}
                </td>
              </tr>,
              ...group(employer).map((l) => (
                <tr key={l.line}>
                  <td className="px-3 py-2">{l.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money(l.system)}</td>
                  <td className="px-3 py-2 text-right">
                    <input
                      inputMode="decimal"
                      value={values[l.line] ?? ''}
                      onChange={(ev) => setValues((v) => ({ ...v, [l.line]: ev.target.value }))}
                      className="w-28 rounded-md border border-border bg-background px-2 py-1 text-right text-sm tabular-nums"
                      aria-label={l.label}
                    />
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${overridden(l) ? 'font-semibold' : 'text-muted-foreground'}`}>
                    {money(finalOf(l))}
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">{labels.blankMeansSystem}</p>

      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">{labels.reason}</span>
        <textarea
          value={reason}
          onChange={(ev) => setReason(ev.target.value)}
          rows={2}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-xs text-muted-foreground">{labels.reasonHint}</span>
      </label>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onReview}
        disabled={pending}
        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {labels.review}
      </button>
    </div>
  );
}
