'use client';

import { startTransition, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { ActionButton } from '@/components/ui/action-button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatabaseErrorText } from '@/components/database-error-text';
import { parseDatabaseErrorRef } from '@/lib/database-error-token';
import { isActionRedirect } from '@/lib/action-feedback-result';
import { formatDmy } from '@/lib/date-display';
import { inclusiveSuperiorEnd } from '@/lib/direct-superior-period';
import { personnelControl, personnelInput, personnelWorkflowInput } from '@/lib/personnel-form-contract';
import type { DirectSuperiorSaveOutcome } from './actions';
import { DIRECT_SUPERIOR_CONFIRM_WITHIN_MS } from './direct-superior-change-form';

export type DirectSuperiorPeriodView = {
  id: string;
  managerEmploymentId: string;
  label: string;
  /** Stored dates: validTo is EXCLUSIVE (the next period's first day), null while current. */
  validFrom: string;
  validTo: string | null;
};

type Outcome = DirectSuperiorSaveOutcome | { status: 'uncertain'; submissionId: string };
type Labels = Record<'title' | 'current' | 'edit' | 'remove' | 'superior' | 'start' | 'end' | 'endCurrent'
  | 'endFixed' | 'reason' | 'cancel' | 'saveCorrection' | 'removePeriod' | 'confirmClear' | 'confirmRemovePrevious'
  | 'confirmRemoveNext' | 'confirmRemoveAlone' | 'joinHint' | 'uncertain' | 'checkHistory' | 'searchPlaceholder'
  | 'noResults' | 'none', string>;

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

/**
 * Board 8f959c7a r2 — every Direct Superior period on the card, newest first, with Edit and Remove for HR who
 * may maintain the employee (Remove and clearing an end date also need the Delete permission Employment History
 * uses). One period is open at a time. The service owns every rule; this card only says, before the save,
 * which period a clear or a removal will take away. Answers follow the card's Save: shown here, entries kept
 * on a refusal, never retried, and "could not confirm" after DIRECT_SUPERIOR_CONFIRM_WITHIN_MS.
 */
export function DirectSuperiorPeriods({ action, employmentId, revision, periods, joinable, options, canEdit,
  canRemove, historyHref, labels, confirmWithinMs = DIRECT_SUPERIOR_CONFIRM_WITHIN_MS }: {
  action: (previous: DirectSuperiorSaveOutcome, data: FormData) => Promise<DirectSuperiorSaveOutcome>;
  employmentId: string;
  revision: string;
  /** Newest first. */
  periods: DirectSuperiorPeriodView[];
  joinable: readonly string[];
  options: ComboboxOption[];
  canEdit: boolean;
  canRemove: boolean;
  historyHref: string;
  labels: Labels;
  confirmWithinMs?: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<{ id: string; mode: 'edit' | 'remove' } | null>(null);
  const [endValue, setEndValue] = useState<string>('');
  const [outcome, setOutcome] = useState<Outcome>({ status: 'idle' });
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setTimedOut(waiting), confirmWithinMs);
    return () => clearTimeout(timer);
  }, [waiting, confirmWithinMs]);
  const busy = waiting !== null && waiting === submitted && timedOut !== submitted;

  const ordered = [...periods].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  const before = (p: DirectSuperiorPeriodView) => ordered.find(o => o.id !== p.id && o.validTo === p.validFrom);
  const after = (p: DirectSuperiorPeriodView) => (p.validTo === null ? undefined : ordered.find(o => o.id !== p.id && o.validFrom === p.validTo));
  const range = (p: DirectSuperiorPeriodView) => `${formatDmy(p.validFrom)} – ${p.validTo ? formatDmy(inclusiveSuperiorEnd(p.validTo)) : labels.current}`;

  const begin = (id: string, mode: 'edit' | 'remove') => {
    const p = periods.find(x => x.id === id);
    setOpen({ id, mode });
    setEndValue(p?.validTo ? inclusiveSuperiorEnd(p.validTo) ?? '' : '');
    setSubmitted(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    // Correlates this click with its answer only; never an idempotency key or a secret.
    const submissionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    data.set('submissionId', submissionId);
    setSubmitted(submissionId);
    setWaiting(submissionId);
    setTimedOut(null);
    void action({ status: 'idle' }, data).then(
      result => result,
      error => isActionRedirect(error) ? null : { status: 'uncertain' as const, submissionId },
    ).then(result => {
      if (!mounted.current || !result) return;
      const settled: Outcome = result.status === 'idle' ? { status: 'uncertain', submissionId } : { ...result, submissionId };
      setWaiting(current => current === submissionId ? null : current);
      setOutcome(settled);
      if (settled.status === 'saved') {
        setOpen(null);
        startTransition(() => router.refresh());
      }
    });
  };

  const answered = outcome.status !== 'idle' && outcome.submissionId === submitted;
  const shown: Outcome | null = answered ? outcome : submitted && timedOut === submitted
    ? { status: 'uncertain', submissionId: submitted } : null;

  const confirmation = (p: DirectSuperiorPeriodView, mode: 'edit' | 'remove'): string | null => {
    if (mode === 'edit') {
      const next = after(p);
      if (!p.validTo || endValue || !next) return null;
      return fill(labels.confirmClear, { removed: `${next.label}, ${range(next)}`, name: p.label, from: formatDmy(p.validFrom) });
    }
    const previous = before(p), next = after(p);
    if (previous) return fill(labels.confirmRemovePrevious, { name: previous.label });
    if (next) return fill(labels.confirmRemoveNext, { name: next.label, from: formatDmy(p.validFrom) });
    return labels.confirmRemoveAlone;
  };

  return (
    <div className="space-y-2" data-direct-superior-periods="">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{labels.title}</div>
      <ul className="space-y-2">
        {periods.map(p => {
          const editing = open?.id === p.id ? open.mode : null;
          const next = after(p);
          const endEditable = !!p.validTo && !!next;
          const notice = editing ? confirmation(p, editing) : null;
          return (
            <li key={p.id} data-superior-period-row={p.id}
              className={`rounded-lg border px-3 py-2 text-sm ${editing ? 'border-primary bg-primary/5' : 'border-border'}`}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <Link href={`/admin/personnel/${p.managerEmploymentId}`} className="text-foreground hover:text-primary">{p.label}</Link>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {formatDmy(p.validFrom)} – {p.validTo ? formatDmy(inclusiveSuperiorEnd(p.validTo)) : <span className="font-medium text-emerald-700 dark:text-emerald-400">{labels.current}</span>}
                </span>
                {canEdit && !editing && <span className="flex gap-3">
                  <button type="button" className="font-medium text-primary hover:underline" disabled={busy} onClick={() => begin(p.id, 'edit')}>{labels.edit}</button>
                  {canRemove && <button type="button" className="font-medium text-primary hover:underline" disabled={busy} onClick={() => begin(p.id, 'remove')}>{labels.remove}</button>}
                </span>}
              </div>
              {joinable.includes(p.id) && <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{labels.joinHint}</p>}
              {editing && (
                <form onSubmit={submit} aria-busy={busy} className="mt-3 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="employmentId" value={employmentId} />
                  <input type="hidden" name="periodRevision" value={revision} />
                  <input type="hidden" name="periodLineId" value={p.id} />
                  <input type="hidden" name="periodOperation" value={editing} />
                  {editing === 'edit' && <>
                    <label className="block text-sm sm:col-span-2">
                      {labels.superior}
                      <Combobox {...personnelControl('employment.direct_superior_and_history.superioremploymentid', 'record')}
                        value={p.managerEmploymentId} options={options} placeholder={labels.none}
                        searchPlaceholder={labels.searchPlaceholder} noResultsLabel={labels.noResults} legacySuffix="" />
                    </label>
                    <label className="block text-sm">
                      {labels.start}
                      <input className={inputCls} {...personnelInput('employment.direct_superior_and_history.validfrom', 'record')} defaultValue={p.validFrom} />
                    </label>
                    <label className="block text-sm">
                      {labels.end}
                      {endEditable
                        ? <input className={inputCls} {...personnelInput('employment.direct_superior_and_history.validto', 'record')}
                            value={endValue} onChange={e => setEndValue(e.target.value)} placeholder={labels.endCurrent} />
                        : <span className="mt-1 block rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground">
                            {p.validTo ? `${formatDmy(inclusiveSuperiorEnd(p.validTo))} · ${labels.endFixed}` : labels.endCurrent}
                          </span>}
                    </label>
                  </>}
                  <label className="block text-sm sm:col-span-2">
                    {labels.reason}
                    <input className={inputCls} {...personnelWorkflowInput('employment_history.event_information.correctionreason', 'movement', 'record')} maxLength={200} />
                  </label>
                  {notice && <p role="note" data-superior-period-confirm="" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 sm:col-span-2 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">{notice}</p>}
                  <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
                    <button type="button" className={btnGhost} disabled={busy} onClick={() => setOpen(null)}>{labels.cancel}</button>
                    <ActionButton type="submit" actionKind="saving" className={btnPrimary} aria-busy={busy}>
                      {editing === 'remove' ? labels.removePeriod : labels.saveCorrection}
                    </ActionButton>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {shown?.status === 'refused' && (
        <p role="alert" data-direct-superior-outcome="refused" className="text-sm font-medium text-destructive">
          {parseDatabaseErrorRef(shown.message) ? <DatabaseErrorText message={shown.message} /> : shown.message}
        </p>
      )}
      {shown?.status === 'uncertain' && (
        <div role="alert" data-direct-superior-outcome="uncertain" className="rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
          <p>{labels.uncertain}</p>
          <Link href={historyHref} className="font-medium underline underline-offset-2">{labels.checkHistory}</Link>
        </div>
      )}
      {shown?.status === 'saved' && (
        <p role="status" data-direct-superior-outcome="saved" className="rounded-md border border-emerald-500/50 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-100">{shown.message}</p>
      )}
    </div>
  );
}
