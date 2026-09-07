'use client';

import Link from 'next/link';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button, EmployeeCode } from '@/components/ui';
import { matchesEmployeeSearch } from '@/lib/employee-search';
import { formatMoney } from '@/lib/money';
import { withPayrollFrom } from '@/lib/return-to';
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
};

/** The gap codes the server sends → the payroll.batch key that names them. Exhaustive by construction:
 *  an unknown code falls back to itself rather than rendering `undefined` at an operator. */
const GAP_LABEL: Record<string, string> = {
  missingCompensation: 'reprocessGapCompensation',
  zeroBasic: 'reprocessGapZeroBasic',
  unpayablePayMode: 'reprocessGapPayMode',
  missingStatutory: 'reprocessGapStatutory',
  missingBank: 'reprocessGapBank',
};

/**
 * e440991b — the selection half of the dedicated Reprocess screen. It replaces the panel that used to
 * sit at the BOTTOM of the 1,286-line payroll run screen, below the Recalculation History card, which
 * is the workflow the reporter rejected: the calculation was right and in weekly use, the route to it
 * was not.
 *
 * WHAT IS NOT HERE, AND WHY. There is no progress bar and no poller over
 * /api/payroll/reprocess-job/<id>. `reprocessSelectedEmployees` enqueues a job AND runs it inline, so
 * the submit is synchronous: the honest states are "running" (this form's pending state) and
 * "complete" (the results panel the page renders afterwards). A percentage bar would be drawing a
 * background worker that does not exist.
 */
export function ReprocessForm({
  batchId,
  employees,
  newCandidates,
  preselectedIds,
  currency,
  from,
}: {
  batchId: string;
  employees: ReprocessCandidate[];
  /**
   * fbcf706d — the New / Pending group, rendered ABOVE the people already paid and arriving ALREADY
   * TICKED, because being on this list is itself the finding: nothing else on the system says that a
   * person eligible for the month is absent from the run that pays it. Two exceptions arrive unticked
   * and are stated on the row rather than hidden — somebody the run's chosen list does not cover
   * (ticking them widens it, which must be a decision, not a default) and somebody whose Personnel
   * record cannot be paid yet (the engine would refuse the whole submit).
   *
   * Absent/empty ⇒ the group is not rendered at all, and this screen is exactly what it was before.
   */
  newCandidates?: ReprocessAddCandidate[];
  /**
   * 49e7e0a2 — the employments the run itself says are stale (payroll_batch.recalcEmploymentIds),
   * ticked on arrival. Editing a one-off transaction on a processed run is what produces this list, and
   * making the operator re-derive by hand which people they just changed is how the wrong subset gets
   * reprocessed. Plain data, resolved on the server; the ticks stay editable.
   */
  preselectedIds?: string[];
  currency: string | null;
  /**
   * r253 — the Payroll Process list's filter selection, already whitelisted by shape on the server
   * (`payrollListReturnTo`). Posted with the submit so `reprocessSelectedAction` returns to THIS screen
   * with the selection still on it, and so Cancel goes back to a run screen whose own Back still
   * restores the list. Undefined when there is nothing to carry, and then nothing is posted at all.
   */
  from?: string;
}) {
  const t = useTranslations('payroll.batch');
  const additions = newCandidates ?? [];
  const addable = additions.filter((c) => c.blockers.length === 0);
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set([
        ...(preselectedIds ?? []),
        // Pre-ticked: everyone eligible whose record is ready and whom the run's chosen list already
        // covers. See the prop's note for why the other two cases deliberately arrive unticked.
        ...addable.filter((c) => !c.outsideScope).map((c) => c.employmentId),
      ]),
  );
  /**
   * Idempotency token, minted ONCE PER MOUNT and posted with the form, so a double-clicked or retried
   * submit reuses the same `payroll_reprocess_job` row instead of enqueuing a second run.
   *
   * It must NOT be reminted when the review block appears: the review is rendered inside this same form
   * from this same state, precisely so that confirming is the same submit as the one being reviewed. A
   * separate confirm step with its own mount would hand the service a fresh key, and a double confirm
   * would then enqueue two jobs — which is the guard this token exists to provide.
   */
  const [idempotencyKey] = useState(() =>
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${batchId}-${Date.now()}`,
  );
  const total = employees.length + additions.length;
  const pickedExisting = employees.filter((e) => selected.has(e.employmentId));
  const pickedNew = additions.filter((e) => selected.has(e.employmentId));
  const picked = [...pickedNew, ...pickedExisting];

  /**
   * 65e2d5de — SEARCH BY EMPLOYEE ID OR NAME, through the ONE SHARED RULE in `lib/employee-search.ts`.
   *
   * The obvious move was to port the predicate out of the sibling Remove Employee Payroll screen
   * (remove-form.tsx), and the first cut of this file did exactly that. It is the wrong copy to spread:
   * that one compares raw strings, so it answers "emp0008" with nobody, while the Personnel switcher, the
   * Payroll Process wizard's Step-2 picker, Transaction Detail and Individual Payslip all find EMP-0008
   * because they go through `matchesEmployeeSearch`, which FOLDS the separators an Employee ID carries.
   * The ask here is literally "search by Employee ID", and an ID typed the way it is spoken has to work.
   * (remove-form.tsx still carries the older, weaker copy — pre-existing, and not this round's to move.)
   *
   * Applied to BOTH groups: filtering the people already paid while leaving the New / Pending list
   * unfiltered would answer "where is Siti?" with silence on one table and a row on the other.
   */
  const [q, setQ] = useState('');
  // NOT lowercased here — `matchesEmployeeSearch` owns the trimming, casing and separator folding, and
  // pre-mangling the query would silently defeat the fold it exists for.
  const needle = q.trim();
  const visibleEmployees = useMemo(
    () => (needle === '' ? employees : employees.filter((e) => matchesEmployeeSearch(e, needle))),
    [employees, needle],
  );
  const visibleAdditions = useMemo(
    () => (needle === '' ? additions : additions.filter((e) => matchesEmployeeSearch(e, needle))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `additions` is derived from `newCandidates`
    [newCandidates, needle],
  );
  /**
   * THE TICKED PEOPLE THE SEARCH IS CURRENTLY HIDING — and the reason the hidden inputs below exist.
   *
   * The table bodies render the VISIBLE rows, so a ticked row that stops matching the search box is
   * UNMOUNTED and its `<input type="checkbox" name="employmentIds">` leaves the DOM with it. Everything
   * else on this screen — the count, the review list, the button label — is computed from `selected` over
   * the UNFILTERED lists, so without this the operator would be told "Reprocess 3 employee(s)", shown
   * three names in the review, and ONE employment id would be posted. The set that is reviewed and the set
   * that is submitted must be the same set. This is the exact defect 9066bd6c found on the Remove screen;
   * it is a contract between the review block and the form, which is why it is pinned by a FormData test.
   *
   * Hidden inputs rather than clearing ticks on search, for the same reason as there: the review block
   * below already NAMES every ticked person regardless of the search, so the full selection is on screen
   * and honoured, whereas dropping ticks as the operator types silently discards work they can see listed.
   */
  const visibleIds = useMemo(
    () => new Set([...visibleEmployees, ...visibleAdditions].map((e) => e.employmentId)),
    [visibleEmployees, visibleAdditions],
  );
  const pickedOffscreen = picked.filter((e) => !visibleIds.has(e.employmentId));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
   * design (the stale employments from `preselectedIds`, plus every addable in-scope New / Pending
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

  return (
    <form action={reprocessSelectedAction} onKeyDown={blockImplicitSubmit} className="space-y-4">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {/* See the `from` prop: the submit is the ordinary way off this screen, and it used to strip the
          operator's filter selection on the way through. */}
      {from ? <input type="hidden" name="from" value={from} /> : null}

      {/* 65e2d5de — Search Employee, at the top of the screen where the request put it. It filters the
          rows only; it never changes the selection — and, per `blockImplicitSubmit` above, Enter in it
          filters and nothing else. It cannot reach the submit button. */}
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('reprocessSearchPlaceholder')}
        className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-input/30"
      />

      {/* See `pickedOffscreen`: the checkbox of a ticked row the search has filtered away is no longer in
          the DOM, so it carries its id here instead. Disjoint from the mounted checkboxes by construction
          (these are exactly the picked ids NOT visible), so nothing is posted twice. */}
      {pickedOffscreen.map((e) => (
        <input key={e.employmentId} type="hidden" name="employmentIds" value={e.employmentId} />
      ))}

      {/* fbcf706d — THE NEW / PENDING GROUP, above the people already paid. Rendered only when there is
          somebody in it, so a run with nobody waiting looks exactly as it did. */}
      {additions.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-amber-300 dark:border-amber-500/40">
          <table className="w-full min-w-[42rem] text-sm">
            <caption className="bg-amber-50 px-3 py-2 text-left text-xs font-semibold text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
              {t('reprocessGroupNewTitle', { n: additions.length })}
            </caption>
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">{t('reprocessColStatus')}</th>
                <th className="px-3 py-2 font-medium">{t('reprocessColReason')}</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">{t('reprocessColJoined')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleAdditions.map((c) => {
                const on = selected.has(c.employmentId);
                const blocked = c.blockers.length > 0;
                const gaps = (codes: string[]) => codes.map((g) => t(GAP_LABEL[g] ?? g)).join(', ');
                return (
                  <tr key={c.employmentId} className={on ? 'bg-primary/5' : undefined}>
                    <td className="px-3 py-2">
                      <label className={`flex items-center gap-2 ${blocked ? 'opacity-60' : ''}`}>
                        <input
                          type="checkbox"
                          name="employmentIds"
                          value={c.employmentId}
                          checked={on}
                          disabled={blocked}
                          onChange={() => toggle(c.employmentId)}
                          className="size-4 rounded"
                        />
                        <EmployeeCode code={c.employeeCode} />
                        <span>{c.name}</span>
                      </label>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-amber-700 dark:text-amber-400">
                      {t('reprocessStatusNew')}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {blocked
                        ? t('reprocessReasonNotReady', { gaps: gaps(c.blockers) })
                        : c.outsideScope
                          ? t('reprocessReasonOutsideScope')
                          : t('reprocessReasonNew')}
                      {!blocked && c.warnings.length > 0 && ` ${t('reprocessReasonMissing', { gaps: gaps(c.warnings) })}`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground tabular-nums">{c.hiredOn}</td>
                  </tr>
                );
              })}
              {visibleAdditions.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                    {t('reprocessNoMatches')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[42rem] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{t('colEmployee')}</span>
                  <span className="normal-case tracking-normal text-foreground">
                    {t('reprocessSummary', { n: selected.size, total })}
                  </span>
                  {/* 65e2d5de — SELECT ALL REPLACES THE SELECTION WITH THE ROWS ON SCREEN, and under a
                      search that is narrower than the word "all" — deliberately, and matching
                      remove-form.tsx. It cannot diverge from what the operator is told: the count, the
                      review list and the button label all move with it, and every id it leaves selected is
                      still submitted (see `pickedOffscreen`). With no search it is exactly what it was. */}
                  <button
                    type="button"
                    onClick={() => setSelected(new Set(visibleEmployees.map((e) => e.employmentId)))}
                    className="font-medium normal-case tracking-normal text-primary hover:underline"
                  >
                    {t('reprocessSelectAll')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="font-medium normal-case tracking-normal text-primary hover:underline"
                  >
                    {t('reprocessClear')}
                  </button>
                </span>
              </th>
              {/* fbcf706d — the same two columns the group above carries, so the two lists read as one
                  screen and the answer to "why is this person here" is in the same place on both. */}
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
                  <td className="px-3 py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="employmentIds"
                        value={e.employmentId}
                        checked={on}
                        onChange={() => toggle(e.employmentId)}
                        className="size-4 rounded"
                      />
                      <EmployeeCode code={e.employeeCode} />
                      <span>{e.name}</span>
                    </label>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-emerald-700 dark:text-emerald-400">
                    {t('reprocessStatusProcessed')}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{t('reprocessReasonProcessed')}</td>
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
                  {/* An empty RUN and an empty SEARCH RESULT are different facts, and saying "No employees
                      on this run" to somebody who has just typed a name is a false statement about the
                      payroll run. Same split as remove-form.tsx. */}
                  {employees.length === 0 ? t('reprocessNoEmployees') : t('reprocessNoMatches')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* THE REVIEW STEP. Reprocessing is not destructive, but it does move somebody's pay, so what is
          about to happen is restated in names — and, just as importantly, what is NOT about to happen.
          Rendered from the same state as the ticks above, in the same form: see `idempotencyKey`. */}
      {picked.length > 0 && (
        <div className="rounded-xl border border-dashed border-primary/45 bg-primary/5 px-4 py-3">
          <p className="text-sm font-medium">{t('reprocessReviewTitle', { n: picked.length, total })}</p>
          <p className="mt-1 text-sm">
            {picked.map((e) => (
              <span key={e.employmentId} className="mr-3 inline-flex items-baseline gap-1.5">
                <EmployeeCode code={e.employeeCode} />
                <span>{e.name}</span>
              </span>
            ))}
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {/* "The other N payslips are not touched" counts PAYSLIPS, so it is the unpicked people who
                already have one — an addition has no payslip to leave alone. */}
            {t('reprocessReviewNote', { n: employees.length - pickedExisting.length })}
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
          count={picked.length}
          label={t('reprocessSubmitN', { n: picked.length })}
          pendingLabel={t('reprocessRunning')}
        />
      </div>
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
