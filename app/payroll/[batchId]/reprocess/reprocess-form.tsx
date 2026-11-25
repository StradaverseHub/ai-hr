'use client';

import Link from 'next/link';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button, EmployeeCode } from '@/components/ui';
import { matchesEmployeeSearch } from '@/lib/employee-search';
import { formatMoney } from '@/lib/money';
import { withPayrollFrom } from '@/lib/return-to';
import type { NothingPayableSkipKind } from '@/core/payroll-view';
import {ClientPager} from '@/components/client-pager';
import {pageCount, type PageState} from '@/lib/pagination';
import {PayrollSelectionSearch} from '../../selection-search';
import { reprocessSelectedAction } from '../../actions';

export type ReprocessCandidate = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  /** `numeric` columns arrive as strings; `formatMoney` takes either and refuses a non-number. */
  gross: string | number;
  net: string | number;
  /**
   * How many times this employee's payslip has already been recalculated on this run — `version - 1`
   * off the stored payslip (1 = as first generated). It is on `batchDetail`'s existing projection, so
   * the "Already reprocessed" column costs no extra read and no join. There is deliberately no
   * Department column here for exactly that reason: it would need one.
   */
  reprocessedTimes: number;
  /**
   * 6aee208b — the run marked this payslip stale (`payroll_batch.recalc_employment_ids` on a processed run).
   * Decides the row's Status and Reason only; what is TICKED comes from the `stale` prop, never from rows.
   */
  stale?: boolean;
};

/** 6aee208b — one person the run marked stale, as `reprocessStaleSelection` names them: identity, no money. */
export type ReprocessStaleRow = { employmentId: string; employeeCode: string | null; name: string };

/** 6aee208b — the review names at most this many people, then "and N more"; every ticked id is still posted. */
const REVIEW_NAME_CAP = 20;

/** 6aee208b / a1a80747 — the two lists, with their (search-filtered) counts and their addresses: Reprocess Required
 * (out-of-date payslips and eligible people with no payslip yet, one list) and Processed / No Change. */
export type ReprocessTabs = {
  current: 'required' | 'unchanged';
  counts: { required: number; unchanged: number };
  hrefs: { required: string; unchanged: string };
};

/**
 * fbcf706d — somebody who is eligible for this month and has NO payslip on this run.
 *
 * Not a variant of the type above: they have no gross, no net and no version, because nothing has been
 * computed for them here. What they have instead is the three things the operator needs in order to
 * decide, which is why the group carries different columns rather than blank money cells — when they
 * joined, whether the run's chosen list covers them, and whether their Personnel record is ready.
 */
export type ReprocessAddCandidate = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  /** Date of hire ('YYYY-MM-DD'). Rendered as-is: a date-only column has no instant to convert. */
  hiredOn: string;
  /** The run is set up for a chosen list and this person is not on it — ticking them widens it. */
  outsideScope: boolean;
  /** Readiness gaps that PREVENT the add (the row cannot be ticked until they are fixed). */
  blockers: string[];
  /** Readiness gaps that do not prevent it (no statutory profile / no bank details). */
  warnings: string[];
  /**
   * c3258a72 — the run has nothing to pay them this month (no monthly basic, no positive money keyed), in
   * the kernel's own reason code. Non-null ⇒ the Nothing payable group: unticked, not in Reprocess Required,
   * still tickable. Worked out from current data on every load (`reprocessRequiredWithSkipPage`), so keying a
   * fee for them moves them back into Reprocess Required. Absent/null ⇒ a New row of Reprocess Required.
   */
  skip?: NothingPayableSkipKind | null;
};

/**
 * a1a80747 — ONE ROW OF THE ONE REPROCESS REQUIRED LIST. `recalculated` ("Changed"): the run marked this payslip out of
 * date. `added` ("New"): eligible for this month with no payslip on this run yet, with its readiness columns. The
 * server lists each employee once, in its own order (`reprocessRequiredWithSkipPage`).
 */
export type ReprocessRequiredRow =
  | ({ kind: 'recalculated' } & ReprocessStaleRow)
  | ({ kind: 'added' } & ReprocessAddCandidate);

/** The gap codes the server sends → the payroll.batch key that names them. Exhaustive by construction:
 *  an unknown code falls back to itself rather than rendering `undefined` at an operator. */
const GAP_LABEL: Record<string, string> = {
  missingCompensation: 'reprocessGapCompensation',
  zeroBasic: 'reprocessGapZeroBasic',
  unpayablePayMode: 'reprocessGapPayMode',
  missingStatutory: 'reprocessGapStatutory',
  missingBank: 'reprocessGapBank',
  // r369 (item eb949191) — a NON-BLOCKER, so it arrives in `warnings` and the row stays tickable.
  nothingPayable: 'reprocessGapNothingPayable',
};

/**
 * r369 (item eb949191) — the warning code for "the salary record names no monthly basic". It is never
 * appended as "Also missing: …": nothing is missing, and the word says the operator forgot something.
 *
 * c3258a72 — it no longer chooses the row's sentence either. Whether the run leaves somebody out is the
 * row's `skip` field (narrowed against keyed money); such rows live in the Skipped group. A row that still
 * carries this warning in New / Pending is somebody the run WILL pay (a fee was keyed) or whose money the
 * run cannot see (outside its chosen list), and "deliberately left out" would be false of them.
 */
const DELIBERATE_SKIP = 'nothingPayable';

/**
 * e440991b — the selection half of the dedicated Reprocess screen. It replaces the panel that used to
 * sit at the BOTTOM of the 1,286-line payroll run screen, below the Recalculation History card, which
 * is the workflow the reporter rejected: the calculation was right and in weekly use, the route to it
 * was not.
 *
 * a1a80747 — ONE LIST, ONE BUTTON. Everyone who needs processing is in Reprocess Required, each once, labelled New
 * (no payslip on this run yet) or Changed (their payslip is out of date). Nobody with nothing to pay is mixed into
 * it: they keep their own Nothing payable group. There is no Check Tax Readiness step any more: the ticked employees
 * are posted as they are, and the job applies the tax readiness rules to each employee as it processes them.
 *
 * The submit enqueues a background job and lands back on this screen with its id; the page then shows the job's
 * progress (./reprocess-progress.tsx) and replaces it with the results panel when the job ends.
 */
export function ReprocessForm({
  batchId,
  employees,
  required,
  stale,
  focusIds,
  jobRunning = false,
  currency,
  from,
  paging,
}: {
  paging?:{existing:PageState;runTotal:number;existingTotal:number;search:string;tabs?:ReprocessTabs};
  batchId: string;
  /** The run's payslips on Processed / No Change (or, with no tabs, every payslip), with their money. */
  employees: ReprocessCandidate[];
  /**
   * a1a80747 — the one Reprocess Required list (this page of it): Changed and New rows in the server's order. A New
   * row arrives ALREADY TICKED when it is ready and inside the run's chosen list, because being on this list is
   * itself the finding (fbcf706d); somebody outside the chosen list (ticking them widens it) or not ready yet (the
   * row cannot be ticked) is stated on the row. A New row with `skip` set goes to the Nothing payable group instead.
   */
  required?: ReprocessRequiredRow[];
  /**
   * 49e7e0a2 / 6aee208b — EVERY employment the run itself says is stale and that has a payslip here
   * (`reprocessStaleSelection`, ordered as the list is), ticked on arrival on every page — not only the ones
   * the first page shows. `withoutPayslip` counts the stale people with no payslip on the run: they are New rows
   * of the same list, and the selection line says so, so its total reconciles with the count on Payroll Process.
   */
  stale?: { rows: ReprocessStaleRow[]; withoutPayslip: number };
  /** 016276b7 — "Process held employees": tick exactly these New employees (the run's employees held for
   * income tax review) and nothing else on arrival. The ticks stay editable. */
  focusIds?: string[];
  jobRunning?: boolean;
  currency: string | null;
  /**
   * b372e923 — the Payroll Process list's filter query, already whitelisted by shape on the server, or
   * null when the operator arrived without one. It rides the SUBMIT rather than only the address bar:
   * the action redirects back here with the finished job's id, and a redirect builds a brand-new URL, so
   * anything not posted is gone by the time the result table renders.
   */
  from?: string | null;
}) {
  const t = useTranslations('payroll.batch');
  const td=useTranslations('derivedOrganisation');
  const requiredRows = required ?? [];
  // The New rows of this page (with their readiness), and among them the people the run has nothing to pay.
  const additions = requiredRows.filter((r): r is Extract<ReprocessRequiredRow,{kind:'added'}> => r.kind === 'added');
  const skippedAdditions = additions.filter((c) => !!c.skip);
  const addable = additions.filter((c) => !c.skip && c.blockers.length === 0);
  /** The one list: every Changed row and every New row that is not Nothing payable, in the server's order. */
  const requiredList = requiredRows.filter((r) => r.kind === 'recalculated' || !r.skip);
  type Selected=ReprocessCandidate|ReprocessAddCandidate|ReprocessStaleRow;
  const staleRows = stale?.rows ?? [];
  /**
   * 6aee208b — THE SELECTION: the ticked employment ids (the keys) plus the last record seen for each, so an
   * off-page tick can still be named in the review and posted as a hidden input. Seeded ONCE PER MOUNT:
   *   - every stale payslip on the run, on every page;
   *   - ready, in-scope New people on the INITIAL page only;
   *   - nobody on Processed / No Change, ever.
   * Page, rows-per-page, search and tab changes are router replaces under the same form key, so they keep
   * this state; a later server render cannot add anyone to it.
   * 016276b7 — "Process held employees" (`focusIds`) instead ticks exactly the run's employees held for income tax
   * review among the ready New people, and nobody else. The ticks stay editable.
   */
  const [selected,setSelected]=useState<Map<string,Selected>>(()=>new Map(focusIds
   ? addable.filter(c=>focusIds.includes(c.employmentId)).map(c=>[c.employmentId,c] as [string,Selected])
   : [
   ...staleRows.map(e=>[e.employmentId,e] as [string,Selected]),
   ...addable.filter(c=>!c.outsideScope).map(c=>[c.employmentId,c] as [string,Selected]),
  ]));
  /**
   * Idempotency token, minted ONCE PER MOUNT and posted with the form, so a double-clicked or retried
   * submit reuses the same `payroll_reprocess_job` row instead of enqueuing a second run. It must NOT be
   * reminted when the review block appears: the review is rendered inside this same form from this same state.
   */
  const [idempotencyKey] = useState(() =>
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${batchId}-${Date.now()}`,
  );
  const total = paging?.runTotal ?? employees.length + additions.length;
  const currentById=new Map<string,Selected>([...employees,...requiredRows].map(e=>[e.employmentId,e]));
  const pickedRows=[...selected.values()].map(e=>currentById.get(e.employmentId)??e);
  const pickedNew=pickedRows.filter((e):e is ReprocessAddCandidate=>'hiredOn' in e);
  // A stale row the operator has not seen yet is still an EXISTING payslip: it is a recalculation, not an add.
  const pickedExisting=pickedRows.filter(e=>!('hiredOn' in e));
  // 6aee208b — the selection line, read against the CURRENT stale set (a fresh render may name more people
  // than the seed did; they are counted here, never silently ticked).
  const staleSelected=staleRows.filter(e=>selected.has(e.employmentId)).length;
  const staleOthers=selected.size-staleSelected;
  const stalePages=pageCount(staleRows.length,paging?.existing.size??'all');
  const staleLeftOut=staleRows.length-staleSelected;
  const picked = [...pickedNew, ...pickedExisting];

  /**
   * 65e2d5de — SEARCH BY EMPLOYEE ID OR NAME, through the ONE SHARED RULE in `lib/employee-search.ts`, which FOLDS
   * the separators an Employee ID carries (so "emp0008" finds EMP-0008). Applied to every list on screen. Under
   * server paging the rows ARE the server's filtered page, so nothing is filtered here.
   */
  const [q, setQ] = useState('');
  // NOT lowercased here — `matchesEmployeeSearch` owns the trimming, casing and separator folding.
  const needle = q.trim();
  const visibleEmployees = useMemo(
    () => (paging || needle === '' ? employees : employees.filter((e) => matchesEmployeeSearch(e, needle))),
    [employees, needle,paging],
  );
  const visibleAdditions = useMemo(
    () => (paging || needle === '' ? additions : additions.filter((e) => matchesEmployeeSearch(e, needle))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `additions` is derived from `required`
    [required, needle,paging],
  );
  const visibleRequired = useMemo(
    () => (paging || needle === '' ? requiredList : requiredList.filter((e) => matchesEmployeeSearch(e, needle))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `requiredList` is derived from `required`
    [required, needle,paging],
  );
  const visibleSkipped = visibleAdditions.filter((c) => !!c.skip);
  // a1a80747 — which lists this view shows. With tabs: Reprocess Required (and its Nothing payable group) or
  // Processed / No Change. Without tabs: the one list when anyone is on it, then every payslip.
  const onTab = paging?.tabs?.current;
  const showRequired = onTab ? onTab === 'required' : requiredList.length > 0 || skippedAdditions.length > 0;
  const showEmployees = onTab ? onTab === 'unchanged' : true;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else {const row=currentById.get(id);if(row)next.set(id,row);}
      return next;
    });
  };

  /**
   * ENTER MUST NOT RUN THE PAYROLL. This is the reason the form carries a keydown handler at all.
   *
   * HTML IMPLICIT SUBMISSION: pressing Enter in a text-type field inside a form CLICKS that form's
   * default (first) submit button. Until 65e2d5de this form had no such field — only hidden inputs,
   * checkboxes and the reason `<textarea>` (where Enter inserts a newline) — so the rule had nothing to
   * fire on. The Search Employee box below is the first blocking field on it, and the default submit
   * button is "Reprocess N employee(s)". Without this guard, typing a name and pressing Enter — the most
   * natural thing anybody does in a search box — would enqueue the recalculation immediately: no review
   * click, no confirmation, on whatever happens to be ticked. And something IS ticked on arrival by
   * design (every stale employment from the `stale` prop, plus every addable in-scope New / Pending
   * candidate), so the button is live on exactly the runs big enough to want a search.
   *
   * Blocked at the FORM, not at the search box, so the next text field added here inherits the guard
   * rather than re-opening the hole. `<textarea>`, `<button>` and the Cancel `<a>` are untouched: Enter
   * in the reason box still makes a newline, and Enter on a focused button still activates it — which
   * keeps the ONLY route to a submit an explicit press of the submit button.
   */
  const blockImplicitSubmit = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter') return;
    const el = e.target as HTMLElement;
    if (el.tagName !== 'INPUT') return;
    // An `<input type="submit">` IS the explicit press; nothing here renders one, but excluding the
    // activation types keeps this guard from ever disabling a button somebody adds later.
    const type = (el as HTMLInputElement).type;
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return;
    e.preventDefault();
  };

  const noMatchRow = (cols: number) => (
    <tr>
      <td colSpan={cols} className="px-4 py-6 text-center text-muted-foreground">
        {t('reprocessNoMatches')}
      </td>
    </tr>
  );
  const gaps = (codes: string[]) => codes.map((g) => g==='organisationGrouping'?td('groupingBlocked'):t(GAP_LABEL[g] ?? g)).join(', ');
  /** The reason sentence of a New row (fbcf706d), and its warning-only gaps. */
  const addReason = (c: ReprocessAddCandidate) => {
    const blocked = c.blockers.length > 0;
    // The no-monthly-basic code is never an "Also missing" gap — see DELIBERATE_SKIP.
    const otherWarnings = c.warnings.filter((w) => w !== DELIBERATE_SKIP);
    return <>
      {c.skip
        ? t(`skipped.reason.${c.skip}`)
        : blocked
          ? t('reprocessReasonNotReady', { gaps: gaps(c.blockers) })
          : c.outsideScope
            ? t('reprocessReasonOutsideScope')
            : t('reprocessReasonNew')}
      {!blocked && otherWarnings.length > 0 && ` ${t('reprocessReasonMissing', { gaps: gaps(otherWarnings) })}`}
    </>;
  };
  /** The tick box and name of one row. A New row that is not ready yet cannot be ticked. */
  const tickCell = (row: {employmentId:string;employeeCode:string|null;name:string}, blocked = false) => {
    const on = selected.has(row.employmentId);
    return (
      <td className="px-3 py-2">
        <label className={`flex items-center gap-2 ${blocked ? 'opacity-60' : ''}`}>
          <input
            type="checkbox"
            value={row.employmentId}
            checked={on}
            disabled={blocked}
            onChange={() => toggle(row.employmentId)}
            className="size-4 rounded"
          />
          <EmployeeCode code={row.employeeCode} />
          <span>{row.name}</span>
        </label>
      </td>
    );
  };
  /** a1a80747 — one row of the one list: its label says whether it is a first payslip or a recalculated one. */
  const requiredRow = (r: ReprocessRequiredRow) => {
    const on = selected.has(r.employmentId);
    const isNew = r.kind === 'added';
    return (
      <tr key={r.employmentId} className={on ? 'bg-primary/5' : undefined}>
        {tickCell(r, isNew && r.blockers.length > 0)}
        <td className="whitespace-nowrap px-3 py-2">
          <span className={isNew
            ? 'rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-500/15 dark:text-sky-300'
            : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground'}>
            {isNew ? t('reprocessLabelNew') : t('reprocessLabelChanged')}
          </span>
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">{isNew ? addReason(r) : t('reprocessReasonRequired')}</td>
      </tr>
    );
  };
  /** The table header's selection controls, shared by both lists. Select this page ADDS the rows on screen. The
   * "n of total selected" count is stated once, on the first list shown. */
  const selectionControls = (onSelectPage: () => void, withSummary = true) => (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{t('colEmployee')}</span>
      {withSummary && <span className="normal-case tracking-normal text-foreground">
        {t('reprocessSummary', { n: selected.size, total })}
      </span>}
      <button type="button" onClick={onSelectPage} className="font-medium normal-case tracking-normal text-primary hover:underline">
        {t('reprocessSelectAll')}
      </button>
      <button type="button" onClick={() => setSelected(new Map())} className="font-medium normal-case tracking-normal text-primary hover:underline">
        {t('reprocessClear')}
      </button>
    </span>
  );

  return (
    <form action={reprocessSelectedAction} onKeyDown={blockImplicitSubmit} onSubmit={event=>{if(!picked.length || jobRunning)event.preventDefault();}} className="space-y-4">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {/* See the `from` prop: the submit is the ordinary way off this screen, and it used to strip the
          operator's filter selection on the way through. */}
      {from ? <input type="hidden" name="from" value={from} /> : null}

      {/* 65e2d5de — Search Employee, at the top of the screen where the request put it. It filters the
          rows only; it never changes the selection — and, per `blockImplicitSubmit` above, Enter in it
          filters and nothing else. It cannot reach the submit button. */}
      {paging?<PayrollSelectionSearch query={paging.search} placeholder={t('reprocessSearchPlaceholder')}/>:<input
        type="search" value={q} onChange={e=>setQ(e.target.value)} placeholder={t('reprocessSearchPlaceholder')}
        className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-1.5 text-sm"/>}
      {paging&&<p className="text-xs text-muted-foreground">{t('reprocessPageDefaultsNote')}</p>}

      {/* One hidden input per ticked employee, independent of paging, filtering, tab or a disabled checkbox. */}
      {picked.map(row=><input key={row.employmentId} type="hidden" name="employmentIds" value={row.employmentId} />)}

      {/* 6aee208b / a1a80747 — TWO LISTS, each with its own count: Reprocess Required (everyone who needs processing,
          New and Changed, once each) and Processed / No Change. Links, not buttons: the tab is the page's own `?tab=`
          (built on the server with the page reset to 1 and the search kept), and the replace keeps this form mounted,
          so the ticks survive. */}
      {paging?.tabs&&(
        <nav aria-label={t('reprocessTabsLabel')}
          className="flex max-w-full flex-wrap gap-1 rounded-[1.25rem] border border-border bg-card p-1.5 shadow-[var(--shadow-card)] sm:w-fit">
          {(['required','unchanged'] as const).map(key=>{
            const active=paging.tabs!.current===key;
            return (
              <Link key={key} href={paging.tabs!.hrefs[key]} replace scroll={false} aria-current={active?'page':undefined}
                className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                  active?'bg-primary text-primary-foreground':'text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
                <span>{key==='required'?t('reprocessTabRequired'):t('reprocessTabUnchanged')}</span>
                <span className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums ${active?'bg-primary-foreground/20':'bg-muted text-foreground'}`}>
                  {paging.tabs!.counts[key].toLocaleString()}
                </span>
              </Link>
            );
          })}
        </nav>
      )}

      {/* 6aee208b — THE SELECTION LINE. How many of the people needing reprocess are ticked, across how many
          pages, with the way back to all of them and the way to none. Stale people with no payslip on this run are
          stated separately (they are New rows of the same list), so the numbers add up to Payroll Process's count. */}
      {(staleRows.length>0 || (stale?.withoutPayslip ?? 0)>0) && (
        <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <p className="min-w-0 flex-1">
            {staleRows.length>0 && (
              <span className="font-medium">
                {staleSelected===staleRows.length
                  ? t('reprocessStaleAllSelected',{n:staleRows.length,pages:stalePages})
                  : t('reprocessStalePartSelected',{x:staleSelected,n:staleRows.length,pages:stalePages})}
              </span>
            )}
            {staleOthers>0 && <> {t('reprocessStaleOthers',{n:staleOthers})}</>}
            {(stale?.withoutPayslip ?? 0)>0 && <> {t('reprocessStaleWithoutPayslipNew',{n:stale!.withoutPayslip})}</>}
          </p>
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {staleSelected<staleRows.length && (
              <button type="button"
                onClick={()=>{setSelected(prev=>new Map([...prev,...staleRows.map(e=>[e.employmentId,prev.get(e.employmentId)??e] as [string,Selected])]));}}
                className="font-medium text-primary hover:underline">
                {t('reprocessStaleSelectAgain',{n:staleRows.length})}
              </button>
            )}
            {selected.size>0 && (
              <button type="button" onClick={()=>{setSelected(new Map());}}
                className="font-medium text-primary hover:underline">
                {t('reprocessClearSelection')}
              </button>
            )}
          </span>
        </div>
      )}

      {paging&&<ClientPager state={paging.existing} note={t('reprocessPagingNote')} rememberAs="payroll-reprocess-existing"/>}

      {/* a1a80747 — THE ONE REPROCESS REQUIRED LIST: New and Changed, each employee once. */}
      {showRequired && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[36rem] text-sm" aria-label={t('reprocessTabRequired')}>
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">
                  {selectionControls(() => {setSelected(prev=>new Map([...prev,...visibleRequired
                    .filter((r) => r.kind === 'recalculated' || r.blockers.length === 0)
                    .map((r) => [r.employmentId,r] as [string,Selected])]));})}
                </th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">{t('reprocessColStatus')}</th>
                <th className="px-3 py-2 font-medium">{t('reprocessColWhy')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleRequired.map((r) => requiredRow(r))}
              {visibleRequired.length === 0 && ((paging ? paging.search.trim() !== '' : needle !== '' && requiredList.length > 0)
                ? noMatchRow(3)
                : <tr><td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">{t('reprocessNoRequired')}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}

      {/* c3258a72 / a1a80747 — THE NOTHING PAYABLE GROUP, never mixed into Reprocess Required. Payroll already
          evaluated these people and had nothing to pay, so this is a completed outcome, not a to-do: neutral colours,
          unticked, with the run page's own reason sentence. Ticking one by hand still tries them again. */}
      {showRequired && skippedAdditions.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="bg-muted px-3 py-2 text-left text-xs font-semibold text-foreground">
              {t('reprocessGroupNothingPayableTitle', { n: skippedAdditions.length })}
            </caption>
            <tbody className="divide-y divide-border">
              {visibleSkipped.map((c) => (
                <tr key={c.employmentId} className={selected.has(c.employmentId) ? 'bg-primary/5' : undefined}>
                  {tickCell(c)}
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">{t('reprocessStatusSkipped')}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{addReason(c)}</td>
                </tr>
              ))}
              {visibleSkipped.length === 0 && noMatchRow(3)}
            </tbody>
          </table>
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{t('reprocessGroupNothingPayableNote')}</p>
        </div>
      )}

      {showEmployees && (
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[42rem] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">
                {/* 65e2d5de / 6aee208b — SELECT THIS PAGE ADDS THE ROWS ON SCREEN TO THE SELECTION. Under a search it
                    adds only what the search shows. Clear empties everything. */}
                {selectionControls(() => {setSelected(prev=>new Map([...prev,...visibleEmployees.map((e) => [e.employmentId,e] as [string,Selected])]));}, !showRequired)}
              </th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">{t('reprocessColStatus')}</th>
              <th className="px-3 py-2 font-medium">{t('reprocessColReason')}</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">{t('reprocessColAlready')}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('colGross')}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('colNet')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibleEmployees.map((e) => {
              const on = selected.has(e.employmentId);
              return (
                <tr key={e.employmentId} className={on ? 'bg-primary/5' : undefined}>
                  {tickCell(e)}
                  {e.stale ? (
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                        {t('reprocessStatusRequired')}
                      </span>
                    </td>
                  ) : (
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-emerald-700 dark:text-emerald-400">
                      {t('reprocessStatusProcessed')}
                    </td>
                  )}
                  <td className="px-3 py-2 text-xs text-muted-foreground">{e.stale ? t('reprocessReasonRequired') : t('reprocessReasonProcessed')}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {e.reprocessedTimes > 0 ? t('reprocessAlreadyCount', { n: e.reprocessedTimes }) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatMoney(e.gross, currency)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatMoney(e.net, currency)}
                  </td>
                </tr>
              );
            })}
            {visibleEmployees.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {/* An empty RUN and an empty SEARCH RESULT are different facts. 6aee208b — under paging the rows ARE
                      the server's filtered page, so the search text, not the row count, says whether this is an empty
                      search; an empty TAB names its own list. */}
                  {(paging ? paging.search.trim() !== '' : employees.length > 0)
                    ? t('reprocessNoMatches')
                    : onTab === 'unchanged' && paging!.existingTotal > 0
                      ? t('reprocessNoUnchanged')
                      : t('reprocessNoEmployees')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      {/* THE REVIEW STEP. Reprocessing is not destructive, but it does move somebody's pay, so what is
          about to happen is restated in names — and, just as importantly, what is NOT about to happen.
          Rendered from the same state as the ticks above, in the same form: see `idempotencyKey`. */}
      {picked.length > 0 && (
        <div className="rounded-xl border border-dashed border-primary/45 bg-primary/5 px-4 py-3">
          <p className="text-sm font-medium">{t('reprocessReviewTitle', { n: picked.length, total })}</p>
          <p className="mt-1 text-sm">
            {/* 6aee208b — capped, so a long selection does not fill the screen: the first names, then "and N
                more". Every ticked id is still posted. */}
            {picked.slice(0, REVIEW_NAME_CAP).map((e) => (
              <span key={e.employmentId} className="mr-3 inline-flex items-baseline gap-1.5">
                <EmployeeCode code={e.employeeCode} />
                <span>{e.name}</span>
              </span>
            ))}
            {picked.length > REVIEW_NAME_CAP && (
              <span className="text-muted-foreground">{t('reprocessReviewMore', { n: picked.length - REVIEW_NAME_CAP })}</span>
            )}
          </p>
          {staleLeftOut > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">{t('reprocessReviewStaleLeftOut', { n: staleLeftOut })}</p>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {/* "The other N payslips are not touched" counts PAYSLIPS, so it is the unpicked people who
                already have one — an addition has no payslip to leave alone. */}
            {t('reprocessReviewNote', { n: Math.max(0, (paging?.existingTotal ?? employees.length) - pickedExisting.length) })}
          </p>
          {pickedNew.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('reprocessReviewAddNote', { n: pickedNew.length })}
            </p>
          )}
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-foreground">{t('reprocessReasonLabel')}</span>
        <textarea
          name="reason"
          rows={2}
          placeholder={t('reprocessReasonPlaceholder')}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-input/30"
        />
      </label>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link
          // r253 — Cancel lands on the run screen, whose own Back is built from `?from=`; without this
          // it arrived bare and the operator's selection was lost one link later.
          href={withPayrollFrom(`/payroll/${batchId}`, from)}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          {t('reprocessCancel')}
        </Link>
        <SubmitButton
          count={jobRunning ? 0 : picked.length}
          label={t('reprocessSubmitN', { n: picked.length })}
          pendingLabel={t('reprocessRunning')}
        />
      </div>
      {/* a1a80747 — there is no separate tax check to press: say where it went. */}
      <p className="text-xs text-muted-foreground">{t('reprocessTaxCheckAutomatic')}</p>
    </form>
  );
}

/**
 * The pending state, and the whole of what this screen can honestly promise about progress. `pending`
 * is true from the submit until the action's redirect lands; the recompute runs inline inside that
 * window, so there is nothing to poll and no fraction to report — see the file header.
 */
function SubmitButton({ count, label, pendingLabel }: { count: number; label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={count === 0 || pending} aria-busy={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}
