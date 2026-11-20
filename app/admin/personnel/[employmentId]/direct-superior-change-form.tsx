'use client';

import { useState, type ReactNode } from 'react';
import { btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { ActionButton } from '@/components/ui/action-button';

type ChangeMode = '' | 'amend' | 'movement';

export function DirectSuperiorChangeForm({ action, children, employmentId, currentLineId, labels }: {
  action: (data: FormData) => Promise<void>;
  children: ReactNode;
  employmentId: string;
  currentLineId: string | null;
  labels: Record<'title' | 'amendment' | 'movement' | 'effectiveDate' | 'reason' | 'cancel' | 'save', string>;
}) {
  const [review, setReview] = useState(false);
  const [mode, setMode] = useState<ChangeMode>('');
  return (
    <form action={action} className="grid items-end gap-3 sm:grid-cols-3">
      <input type="hidden" name="employmentId" value={employmentId} />
      <input type="hidden" name="currentLineId" value={currentLineId ?? ''} />
      {children}
      {!review && <div>
        <button type="button" className={btnPrimary} onClick={() => setReview(true)}>{labels.save}</button>
      </div>}
      {review && (
        <fieldset className="space-y-3 rounded-lg border border-border p-4 sm:col-span-3">
          <legend className="px-1 font-semibold">{labels.title}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['amend', 'movement'] as const).map(option => (
              <label key={option} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <input type="radio" name="superiorChangeMode" value={option} required
                  checked={mode === option} onChange={() => setMode(option)} className="mt-0.5" />
                {option === 'amend' ? labels.amendment : labels.movement}
              </label>
            ))}
          </div>
          {mode === 'movement' && <label className="block max-w-48 text-sm">
            {labels.effectiveDate}
            <input className={inputCls} name="superiorEffectiveDate" type="date" required />
          </label>}
          {!!mode && <label className="block text-sm">
            {labels.reason}
            <input className={inputCls} name="superiorChangeReason" required maxLength={200} />
          </label>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => { setMode(''); setReview(false); }}>{labels.cancel}</button>
            <ActionButton actionKind="saving" className={btnPrimary} disabled={!mode}>{labels.save}</ActionButton>
          </div>
        </fieldset>
      )}
    </form>
  );
}
