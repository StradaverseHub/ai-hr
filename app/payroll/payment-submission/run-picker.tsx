'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { payslipCycleLabel } from '@/core/payslip-cycle-label';
import { RUN_PARAM } from '@/lib/payroll-run-selection';

/**
 * r372 (item f022dd70) — THE PAYROLL CYCLE MULTI-SELECT on the Payment Submission download pop-up.
 *
 * ── TICK EVERYTHING AND THE URL CARRIES NOTHING. THAT IS THE WHOLE NO-CHANGE GUARANTEE ───────────
 * The hidden `run` inputs below are rendered ONLY when the operator has un-ticked at least one cycle.
 * With everything ticked the submitted URL is character-for-character the URL this button produced before
 * this control existed, so the three generators take their existing unfiltered path and the file cannot
 * have moved. That is a property of the FORM, not a test comparing two code paths — and it is why these
 * are hidden inputs driven by React state rather than named checkboxes: a named checkbox would submit
 * `run=1&run=2&run=3` for "all", which is a different request that merely ought to produce the same file.
 *
 * ── THE LIST IS THE MONTH'S RUNS, LABELLED WITH THE COMPANY'S CYCLE NAMES ────────────────────────
 * The reporter asked for Monthly / Bonus / Off-Cycle, which are `payroll_cycle.name` values. But
 * `payroll_batch.payroll_cycle_id` is NULLABLE and null on every batch opened before migration 0441, and
 * the default catalogue maps THREE of its cycles to run_type `off_cycle`, so neither column alone can name
 * a month's runs. The value on the wire is `run_seq` (NOT NULL, unique per pay period) and the label is
 * `payslipCycleLabel` — the cycle's name, falling back to the run-type word — which is the SAME rule the
 * Individual Payslip screen and the payslip PDF already share. Not restated here; imported.
 *
 * The run number is printed underneath, so two runs sharing a cycle name are still distinguishable. That
 * is not decoration: a month may legitimately hold two off-cycle runs, and a control that showed
 * "Off-cycle" twice with nothing to tell them apart would be a control that cannot be used.
 *
 * ── AND IT IS FETCHED, BECAUSE THE PAGE DELIBERATELY READS NO DATABASE ───────────────────────────
 * `test/payment-submission-screen-seam.test.ts` renders the page with no database at all. The company,
 * year and month are also chosen inside this pop-up, after the page rendered, so a server-rendered list
 * would be the wrong month the moment the operator changed a dropdown. It re-fetches on every change and
 * ignores a response that arrives after a newer request — an out-of-order reply would otherwise leave
 * August's runs ticked under a September heading.
 */

/** One run as the eligible-runs route returns it. Mirrors `FilableRunResponse['runs'][number]`. */
export type FilableRun = { runSeq: number; runType: string; cycleName: string | null; status: string };

/** Above this many runs in one month the list gets a search box. Six is the default cycle catalogue. */
const SEARCH_THRESHOLD = 6;

export function RunPicker({
  companyId,
  periodKey,
  endpoint,
}: {
  companyId: string;
  periodKey: string;
  /** The eligible-runs route. Passed in so there is ONE spelling of it, on the server component. */
  endpoint: string;
}) {
  const t = useTranslations('payroll.paymentSubmission');
  const [runs, setRuns] = useState<FilableRun[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [search, setSearch] = useState('');
  // Monotonic request id. A fetch that resolves after a newer one started is DROPPED rather than applied:
  // the slow August reply landing under a September heading is a silent wrong selection.
  const requestId = useRef(0);

  useEffect(() => {
    const mine = ++requestId.current;
    setRuns(null);
    const url = `${endpoint}?companyId=${encodeURIComponent(companyId)}&periodKey=${encodeURIComponent(periodKey)}`;
    let cancelled = false;
    fetch(url, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((body: { runs?: FilableRun[] }) => {
        if (cancelled || mine !== requestId.current) return;
        const list = Array.isArray(body.runs) ? body.runs : [];
        setRuns(list);
        // EVERY CYCLE TICKED WHEN THE LIST ARRIVES — the reporter's point 2, and the state in which no
        // `run` parameter is submitted at all. A remembered narrower selection is deliberately NOT kept
        // between downloads: that is how a month ends up under-filed by somebody who did not look.
        setPicked(new Set(list.map((x) => x.runSeq)));
      })
      .catch(() => {
        if (cancelled || mine !== requestId.current) return;
        // A failed fetch leaves the list EMPTY, never "assume every run". The pop-up then says it found
        // no completed run, and Download still works — sending no `run` parameter, which is the whole
        // month. Refusing to download because a list could not be drawn would take away a file that has
        // always worked without this control.
        setRuns([]);
        setPicked(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, periodKey, endpoint]);

  const all = runs ?? [];
  const allPicked = all.length > 0 && picked.size === all.length;
  const label = (r: FilableRun) =>
    payslipCycleLabel({ cycleName: r.cycleName, runTypeLabel: runTypeWord(t, r.runType) }) ??
    t('payCycleRun', { seq: r.runSeq });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => label(r).toLowerCase().includes(q) || String(r.runSeq) === q);
    // `label` closes over `t`, which is stable for a render pass; the list and the query are what change.
  }, [all, search]);

  const toggle = (seq: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  return (
    <div className="space-y-2" data-run-picker>
      {/*
        THE HIDDEN INPUTS, AND THE CONDITION IS THE FEATURE. Rendered only for a STRICT subset; with every
        cycle ticked the form submits no `run` at all. See the header.
      */}
      {!allPicked &&
        [...picked]
          .sort((a, b) => a - b)
          .map((seq) => <input key={seq} type="hidden" name={RUN_PARAM} value={seq} />)}

      {runs === null ? (
        <p className="text-sm text-muted-foreground">{t('payCycleLoading')}</p>
      ) : all.length === 0 ? (
        // NOT a disabled Download. A `'month-runs'` format without a cycle is an ordinary whole-month
        // file, and the builder's own 422 says in the operator's words why this month has nothing to
        // file. Disabling here would hide that sentence behind a greyed-out button.
        <p className="text-sm text-muted-foreground" data-run-empty>
          {t('payCycleNoRuns')}
        </p>
      ) : (
        <>
          <p className="text-sm font-medium" data-run-summary>
            {allPicked ? t('payCycleAll') : all.filter((r) => picked.has(r.runSeq)).map(label).join(', ')}
          </p>
          {all.length > SEARCH_THRESHOLD && (
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('payCycleSearch')}
              className={inputCls}
              data-run-search
            />
          )}
          <label className="flex items-center gap-2 border-b border-border pb-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={allPicked}
              // INDETERMINATE when some are ticked, so "Select all" never reads as "none are selected"
              // while three of five are. A ref callback because it is a DOM property, not an attribute.
              ref={(el) => {
                if (el) el.indeterminate = picked.size > 0 && !allPicked;
              }}
              onChange={() => setPicked(allPicked ? new Set() : new Set(all.map((r) => r.runSeq)))}
              data-run-select-all
            />
            {t('payCycleSelectAll')}
          </label>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {visible.map((r) => (
              <li key={r.runSeq}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={picked.has(r.runSeq)}
                    onChange={() => toggle(r.runSeq)}
                    data-run-option={r.runSeq}
                  />
                  <span>
                    {label(r)}
                    <span className="block text-xs text-muted-foreground">
                      {t('payCycleRun', { seq: r.runSeq })}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {/*
            THE WARNING, AND IT IS NOT A VALIDATION. Every agency wants ONE filing per month and none of
            the three file layouts has a box that says which run a line came from, so a part-month file
            still reads to the agency as a whole-month submission. The screen says so; it cannot stop
            them, and pretending otherwise would be worse than saying it plainly.
          */}
          {!allPicked && picked.size > 0 && (
            <p
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              data-run-partial-warning
            >
              {t('payCyclePartialWarning')}
            </p>
          )}
          {picked.size === 0 && (
            // Nothing ticked submits no `run` either, which would quietly produce the WHOLE month — the
            // opposite of what an empty selection looks like it means. Said out loud rather than fixed
            // silently, because the operator's next click is Download.
            <p className="text-xs text-muted-foreground" data-run-none-picked>
              {t('payCycleNonePicked')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The run-type word, through an EXPLICIT MAP and never `t(`runType.${x}`)`.
 *
 * A computed key renders MISSING_MESSAGE the first time `payroll_run_type` gains a value — on a statutory
 * screen, beside a download button, behind a 200. The same reason `page.tsx` maps its provenance labels.
 * An unrecognised value yields NULL rather than the raw enum: `payslipCycleLabel` then falls back to the
 * cycle's own name, and only a run with neither loses its label — which is exactly what that shared rule
 * already does for the payslip PDF.
 */
function runTypeWord(t: ReturnType<typeof useTranslations>, runType: string): string | null {
  switch (runType) {
    case 'regular':
      return t('runTypeRegular');
    case 'off_cycle':
      return t('runTypeOffCycle');
    case 'bonus':
      return t('runTypeBonus');
    case 'adjustment':
      return t('runTypeAdjustment');
    default:
      return null;
  }
}
