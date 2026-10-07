'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { payslipCycleLabel } from '@/core/payslip-cycle-label';
import { RUN_PARAM } from '@/lib/payroll-run-selection';

/**
 * r372 (item f022dd70) → r407 (item 4f45f9b0) — THE PAYROLL CYCLE MULTI-SELECT, written once.
 *
 * It started life on the Payment Submission download pop-up (app/payroll/payment-submission/). r407 moved it
 * here, unchanged in behaviour, because the statutory criteria step (app/payroll/statutory-forms/open) now
 * asks the same question for Borang A — and SOCSO Borang 8A and LHDN CP39 will ask it next. Two copies of
 * "tick everything ⇒ submit nothing" is how one of them starts submitting `run=1&run=2&run=3` for All.
 *
 * ── TICK EVERYTHING AND THE URL CARRIES NOTHING. THAT IS THE WHOLE NO-CHANGE GUARANTEE ───────────
 * The hidden `run` inputs below are rendered ONLY when the operator has un-ticked at least one cycle.
 * With everything ticked the submitted URL is character-for-character the URL the form produced before
 * this control existed, so the generators take their existing unfiltered path and the document cannot
 * have moved. That is a property of the FORM, not a test comparing two code paths — and it is why these
 * are hidden inputs driven by React state rather than named checkboxes: a named checkbox would submit
 * `run=1&run=2&run=3` for "all", which is a different request that merely ought to produce the same file.
 *
 * ── THE LIST IS THE MONTH'S RUNS, LABELLED WITH THE COMPANY'S CYCLE NAMES ────────────────────────
 * The value on the wire is `run_seq` (NOT NULL, unique per pay period) and the label is
 * `payslipCycleLabel` — the cycle's name, falling back to the run-type word — which is the SAME rule the
 * Individual Payslip screen and the payslip PDF already share. The run number is printed underneath, so two
 * runs sharing a cycle name are still distinguishable.
 *
 * ── AND IT IS FETCHED ────────────────────────────────────────────────────────────────────────────
 * Company, year and month are chosen on the same screen AFTER it rendered, so a server-rendered list would
 * be the wrong month the moment the operator changed a dropdown. It re-fetches on every change and ignores a
 * response that arrives after a newer request.
 *
 * ── THE WORDS THAT DEPEND ON WHERE IT SITS ARE THE CALLER'S ──────────────────────────────────────
 * The generic words (Select all, the run number, the run-type words) live in `payroll.runPicker`. The three
 * sentences that describe what happens NEXT — "no runs", "nothing ticked", "you left one out" — differ
 * between a download pop-up (which downloads the whole month anyway) and a criteria step (which refuses), so
 * the caller passes them in, already translated. A picker that told an operator on the criteria step that
 * "Download still produces the whole month" would be describing a different screen.
 */

/** One run as the eligible-runs route returns it. Mirrors `FilableRunResponse['runs'][number]`. */
export type FilableRun = { runSeq: number; runType: string; cycleName: string | null; status: string };

/** The three caller-owned sentences. See the header. */
export type RunPickerStrings = {
  noRuns: string;
  nonePicked: string;
  partialWarning: string;
};

/** Above this many runs in one month the list gets a search box. Six is the default cycle catalogue. */
const SEARCH_THRESHOLD = 6;

export function RunPicker({
  companyId,
  periodKey,
  endpoint,
  strings,
  initialRunSeqs,
  showClear = false,
  onPickedChange,
}: {
  companyId: string;
  periodKey: string;
  /** The eligible-runs route. Passed in so there is ONE spelling of it, on the server component. */
  endpoint: string;
  strings: RunPickerStrings;
  /**
   * r407 — the runs to arrive ticked on the FIRST list only, when a screen comes back with a selection it
   * already made (the criteria step after a refusal). Absent ⇒ Select All, which is the default everywhere.
   * Applied once: a later company or month change always starts from Select All again.
   */
  initialRunSeqs?: readonly number[];
  /** r407 — a "Clear" action beside Select all (the criteria step's mockup). */
  showClear?: boolean;
  /** r407 — told how many runs exist and how many are ticked, every time either changes. */
  onPickedChange?: (p: { available: number; picked: number }) => void;
}) {
  const t = useTranslations('payroll.runPicker');
  const [runs, setRuns] = useState<FilableRun[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [search, setSearch] = useState('');
  // Monotonic request id. A fetch that resolves after a newer one started is DROPPED rather than applied:
  // the slow August reply landing under a September heading is a silent wrong selection.
  const requestId = useRef(0);
  // The initial selection is honoured ONCE — the first list that arrives — and never again.
  const initial = useRef<readonly number[] | undefined>(initialRunSeqs);

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
        // EVERY CYCLE TICKED WHEN THE LIST ARRIVES — the state in which no `run` parameter is submitted at
        // all. A remembered narrower selection is deliberately NOT kept between lists: that is how a month
        // ends up under-filed by somebody who did not look. The ONE exception is a selection this screen
        // was handed back (`initialRunSeqs`), and only the runs of it that still exist.
        const want = initial.current;
        initial.current = undefined;
        const kept = want ? list.filter((x) => want.includes(x.runSeq)).map((x) => x.runSeq) : [];
        setPicked(new Set(kept.length > 0 ? kept : list.map((x) => x.runSeq)));
      })
      .catch(() => {
        if (cancelled || mine !== requestId.current) return;
        // A failed fetch leaves the list EMPTY, never "assume every run".
        setRuns([]);
        setPicked(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, periodKey, endpoint]);

  const all = useMemo(() => runs ?? [], [runs]);
  const allPicked = all.length > 0 && picked.size === all.length;

  useEffect(() => {
    onPickedChange?.({ available: runs === null ? -1 : all.length, picked: picked.size });
  }, [onPickedChange, runs, all.length, picked.size]);

  // `useCallback` so the search memo can DECLARE its dependency on the label rather than close over it.
  const label = useCallback(
    (r: FilableRun) =>
      payslipCycleLabel({ cycleName: r.cycleName, runTypeLabel: runTypeWord(t, r.runType) }) ??
      t('run', { seq: r.runSeq }),
    [t],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    // Matched on the LABEL the operator can actually read, plus an exact run number.
    return all.filter((r) => label(r).toLowerCase().includes(q) || String(r.runSeq) === q);
  }, [all, search, label]);

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
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : all.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-run-empty>
          {strings.noRuns}
        </p>
      ) : (
        <>
          <p className="text-sm font-medium" data-run-summary>
            {allPicked ? t('all') : all.filter((r) => picked.has(r.runSeq)).map(label).join(', ')}
          </p>
          {all.length > SEARCH_THRESHOLD && (
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('search')}
              className={inputCls}
              data-run-search
            />
          )}
          <div className="flex items-center justify-between gap-3 border-b border-border pb-2 monolith:border-ink">
            <label className="flex items-center gap-2 text-sm font-medium">
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
              {t('selectAll')}
            </label>
            {showClear && (
              <button
                type="button"
                onClick={() => setPicked(new Set())}
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline monolith:border-b monolith:border-ink monolith:text-ink monolith:no-underline"
                data-run-clear
              >
                {t('clear')}
              </button>
            )}
          </div>
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
                    <span className="block text-xs text-muted-foreground">{t('run', { seq: r.runSeq })}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {/*
            THE WARNING, AND IT IS NOT A VALIDATION. Every agency wants ONE filing per month and none of the
            layouts has a box that says which run a line came from. The screen says so; it cannot stop them.
          */}
          {!allPicked && picked.size > 0 && (
            <p
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              data-run-partial-warning
            >
              {strings.partialWarning}
            </p>
          )}
          {picked.size === 0 && (
            <p className="text-xs text-muted-foreground" data-run-none-picked>
              {strings.nonePicked}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The run-type word, through an EXPLICIT MAP and never `t(`runType.${x}`)`: a computed key renders
 * MISSING_MESSAGE the first time `payroll_run_type` gains a value. An unrecognised value yields NULL, and
 * `payslipCycleLabel` then falls back to the cycle's own name.
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
