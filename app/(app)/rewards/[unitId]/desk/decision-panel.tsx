'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { Field, inputCls } from '@/components/ui';

type Decision = 'submit' | 'approve' | 'return';
/** 5d34d00d Step 2 — every annual decision asks first and says where the review goes next. The server
 *  (decideRewardUnit) still owns every rule; the panel only mirrors them so the button explains itself:
 *  Submit and Approve stay disabled while any Block is open, and a reason is needed when warnings or
 *  exceptions are open (approve/submit) or when returning (always), at least 10 characters. */
export function DecisionPanel({ action, unitId, revision, decisions, blocks, warnings, from }: {
  action: (f: FormData) => Promise<void>; unitId: string; revision: number;
  /** The decisions this seat may take now, with the stage label each one moves the review to. */
  decisions: { action: Decision; to: string }[];
  blocks: number; warnings: number; from: string;
}) {
  const t = useTranslations('rewards'); const d = useTranslations('rewards.desk.decide');
  const [chosen, setChosen] = useState<Decision>(decisions[0]?.action ?? 'approve');
  const [reason, setReason] = useState('');
  const short = reason.trim().length < 10;
  const needsReason = (a: Decision) => a === 'return' || warnings > 0;
  const forward = (a: Decision) => a !== 'return';
  return <form action={action} className="max-w-3xl space-y-3">
    <input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={revision} /><input type="hidden" name="action" value={chosen} />
    <Field label={t('decisionReason')}><textarea name="reason" rows={3} maxLength={4000} value={reason} onChange={e => setReason(e.target.value)} className={`${inputCls} h-auto py-2`} /></Field>
    {blocks > 0 && <p role="status" className="text-sm text-destructive">{d('blocked', { count: blocks })}</p>}
    {blocks === 0 && warnings > 0 && short && <p className="text-sm text-muted-foreground">{d('reasonForWarnings', { count: warnings })}</p>}
    <div className="flex flex-wrap gap-3">{decisions.map(({ action: a, to }) => {
      const disabled = (forward(a) && blocks > 0) || (needsReason(a) && short);
      return <ConfirmSubmit key={a} variant={a === 'return' ? 'secondary' : 'default'} disabled={disabled} onClick={() => setChosen(a)}
        title={d(`${a}Title`)} subtitle={d('moves', { from, to })} description={d(`${a}Help`)} confirmLabel={t(a)}>{t(a)}</ConfirmSubmit>;
    })}</div>
    {decisions.some(x => x.action === 'return') && short && <p className="text-sm text-muted-foreground">{d('reasonForReturn')}</p>}
  </form>;
}
