'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button, EmployeeCode } from '@/components/ui';
import { formatMoney } from '@/lib/money';
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

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <form action={reprocessSelectedAction} className="space-y-4">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

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
              {additions.map((c) => {
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
                  <button
                    type="button"
                    onClick={() => setSelected(new Set(employees.map((e) => e.employmentId)))}
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
            {employees.map((e) => {
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
            {employees.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t('reprocessNoEmployees')}
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
          href={`/payroll/${batchId}`}
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
