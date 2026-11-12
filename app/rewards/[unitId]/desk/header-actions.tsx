'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from '@/components/ui';
import { useReviewDesk } from './review-desk';

type Decision = 'submit' | 'approve' | 'return';

/** 37f82412 — "Saving… / All changes saved / Not saved, retry" for the cells edited on this page. */
export function SaveStatus() {
  const { saveState, retry, error } = useReviewDesk();
  const t = useTranslations('rewards.desk.save');
  if (saveState === 'idle') return null;
  if (saveState === 'failed') return <span role="status" className="text-sm text-destructive">{error || t('failed')} <button type="button" onClick={retry} className="font-medium underline">{t('retry')}</button></span>;
  return <span role="status" className="text-sm text-muted-foreground">{t(saveState)}</span>;
}

/** A save refused because the review changed in another session: a banner with Reload, never an error page. */
export function StaleBanner() {
  const { stale } = useReviewDesk();
  const t = useTranslations('rewards.desk.save');
  if (!stale) return null;
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
    <span>{t('stale')}</span><Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>{t('reload')}</Button>
  </div>;
}

export function FlagsButton() {
  const { summary, setFlagsOpen } = useReviewDesk();
  const t = useTranslations('rewards.desk');
  return <Button type="button" size="sm" variant="outline" aria-haspopup="dialog" onClick={() => setFlagsOpen(true)}>
    {summary.blocks > 0 && <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-destructive" />}{t('flagsCount', { count: summary.flags })}
  </Button>;
}

/**
 * 37f82412 — the review's main action, on the right of the header. The server (decideRewardUnit) owns every
 * rule; this only mirrors them so the button explains itself: Submit and Approve are greyed out while any
 * Block is open ("Fix 2 blocking flags first"), and the comment window needs at least 10 characters when
 * warnings are open or when returning. The decision posts the newest revision this page has saved.
 */
export function DecisionActions({ action, decisions, from }: {
  action: (form: FormData) => Promise<void>;
  decisions: { action: Decision; to: string }[]; from: string;
}) {
  const { unitId, revision, summary } = useReviewDesk();
  const t = useTranslations('rewards'); const d = useTranslations('rewards.desk.decide');
  const [chosen, setChosen] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  if (!decisions.length) return null;
  const forward = (a: Decision) => a !== 'return';
  const needsReason = (a: Decision) => a === 'return' || summary.warnings > 0;
  const short = reason.trim().length < 10;
  const current = decisions.find(x => x.action === chosen);
  return <div className="flex flex-col items-end gap-1">
    <div className="flex flex-wrap justify-end gap-2">{decisions.map(({ action: a }) => {
      const blocked = forward(a) && summary.blocks > 0;
      return <Button key={a} type="button" size="sm" variant={a === 'return' ? 'outline' : 'default'} disabled={blocked} aria-describedby={blocked ? `decision-blocked-${a}` : undefined}
        onClick={() => { setChosen(a); setReason(''); }}>{t(a)}</Button>;
    })}</div>
    {summary.blocks > 0 && decisions.some(x => forward(x.action)) && <p id={`decision-blocked-${decisions.find(x => forward(x.action))!.action}`} role="status" className="text-xs text-destructive">{d('fixBlocks', { count: summary.blocks })}</p>}
    <AlertDialog.Root open={!!current} onOpenChange={open => { if (!open) setChosen(null); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        {current && <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <form action={action} className="space-y-3">
            <input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={revision} /><input type="hidden" name="action" value={current.action} />
            <AlertDialog.Title className="text-base font-semibold">{d(`${current.action}Title`)}</AlertDialog.Title>
            <p className="text-sm font-medium">{d('moves', { from, to: current.to })}</p>
            <AlertDialog.Description className="text-sm text-muted-foreground">{d(`${current.action}Help`)}</AlertDialog.Description>
            <label className="block"><span className="mb-1 block text-xs font-medium">{t('decisionReason')}</span>
              <textarea name="reason" rows={3} maxLength={4000} value={reason} onChange={e => setReason(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
            {needsReason(current.action) && short && <p className="text-xs text-muted-foreground">{current.action === 'return' ? d('reasonForReturn') : d('reasonForWarnings', { count: summary.warnings })}</p>}
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild><Button type="button" variant="outline" size="sm">{d('cancel')}</Button></AlertDialog.Cancel>
              <Button type="submit" size="sm" variant={current.action === 'return' ? 'outline' : 'default'} disabled={needsReason(current.action) && short}>{t(current.action)}</Button>
            </div>
          </form>
        </AlertDialog.Content>}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </div>;
}
