'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ProposalCard } from '@/components/ai-centre/proposal-card';
import { confirmMissedClockOutAction } from '@/app/assistant/loop-clock-out-actions';
import { CLOCK_OUT_OTHER_MAX, CLOCK_OUT_REASONS, type ClockOutReason, type ClockOutRefusal } from '@/lib/today/clock-out-reasons';

/** Coarse pointers get 44px targets (DESIGN.md). */
const TARGET = 'pointer-coarse:min-h-11';
/** The Maker's Mark disc, as the chat cards draw it (components/ai-centre/proposal-card-actions.tsx). */
const MARK = 'atelier-mark size-6 flex-none rounded-full bg-amber-900/10 shadow-[inset_0_0_0_2px_rgb(138_90_46)]';

export type ClockOutCardCopy = Readonly<{
  legend: string; reasons: Readonly<Record<ClockOutReason, string>>; otherLabel: string;
  confirm: string; confirming: string; edit: string; actionsLabel: string; confirmedBy: string; done: string; error: string;
  refused: Readonly<Record<ClockOutRefusal, string>>;
}>;

/** AI v2 W8 — the missed clock-out card in Today's "Needs you". The person picks why the clock-out was missed (or types
 * it under "Other"), then presses Confirm: the server reads the case again, prepares the slice 1 attendance correction
 * with the reason they picked and sends it for the usual approval (core/loops/clock-out-confirm.ts). Nothing is chosen
 * for them and nothing posts until they press Confirm. Edit opens the correction form instead. */
export function ClockOutLoopCard({ caseId, icon, title, meta, awaitingLabel, editHref, copy }: {
  caseId: string; icon: ReactNode; title: string; meta: readonly string[]; awaitingLabel: string; editHref: string; copy: ClockOutCardCopy;
}) {
  const [reason, setReason] = useState<ClockOutReason | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  const name = useId();
  useEffect(() => { if (done) status.current?.focus(); }, [done]);
  useEffect(() => { if (reason === 'other') otherInput.current?.focus(); }, [reason]);
  const ready = reason !== null && (reason !== 'other' || other.trim().length > 0);

  async function confirm() {
    if (busy || !ready) return;
    setBusy(true); setRefusal(null);
    try {
      const result = await confirmMissedClockOutAction({ caseId, reason, ...(reason === 'other' ? { other } : {}), confirm: true });
      if (result.kind === 'submitted') setDone(true); else setRefusal(copy.refused[result.reason] ?? copy.refused.unavailable);
    } catch {
      setRefusal(copy.error);
    } finally {
      setBusy(false);
    }
  }

  const actions = done ? (
    <div ref={status} role="status" tabIndex={-1} data-clock-out-outcome
      className="flex items-start gap-2.5 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span aria-hidden data-makers-mark className={MARK} />
      <p className="min-w-0 pt-0.5"><span className="font-medium">{copy.confirmedBy}</span>{' · '}{copy.done}</p>
    </div>
  ) : (
    <div className="space-y-3">
      <fieldset data-clock-out-reasons disabled={busy} className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">{copy.legend}</legend>
        <div className="flex flex-wrap gap-2">
          {CLOCK_OUT_REASONS.map(option => (
            <label key={option} className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${TARGET} ${reason === option ? 'border-primary bg-primary/5' : 'border-border'}`}>
              <input type="radio" name={name} value={option} checked={reason === option} onChange={() => setReason(option)} className="size-4 flex-none" />
              <span>{copy.reasons[option]}</span>
            </label>
          ))}
        </div>
        {reason === 'other' && (
          <label className="block min-w-0 space-y-1 text-sm">
            <span className="text-muted-foreground">{copy.otherLabel}</span>
            <input ref={otherInput} type="text" value={other} maxLength={CLOCK_OUT_OTHER_MAX} onChange={event => setOther(event.target.value)}
              className={`block h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TARGET}`} />
          </label>
        )}
      </fieldset>
      <div role="group" aria-label={copy.actionsLabel} aria-busy={busy} className="flex flex-wrap items-center gap-2">
        <Button aria-busy={busy} type="button" onClick={confirm} disabled={busy || !ready} className={TARGET}>
          {busy ? copy.confirming : copy.confirm}{' '}<span className="sr-only">· {title}</span>
        </Button>
        <Link href={editHref} aria-disabled={busy || undefined}
          className={`inline-flex min-h-9 items-center justify-center rounded-md border border-input bg-card px-4 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TARGET}`}>
          {copy.edit}{' '}<span className="sr-only">· {title}</span>
        </Link>
      </div>
      {refusal && <p role="alert" data-clock-out-refusal className="text-sm text-destructive">{refusal}</p>}
    </div>
  );

  return <ProposalCard tone="prepared" icon={icon} title={title} meta={meta} awaitingLabel={done ? undefined : awaitingLabel} actions={actions} />;
}
