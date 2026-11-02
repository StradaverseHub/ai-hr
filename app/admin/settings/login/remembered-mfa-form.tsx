'use client';
import { useActionState } from 'react';
import { useLocale } from 'next-intl';
import { inputCls, btnPrimary } from '@/components/ui';
import { rememberedMfaCopy } from '@/lib/remembered-mfa-copy';
import type { RememberedMfaPolicyState } from '@/lib/remembered-mfa-policy';
import { saveRememberedMfaAction, type RememberedMfaResult } from './remembered-mfa-actions';
export function RememberedMfaForm({ policy, revision }: RememberedMfaPolicyState) {
  const copy = rememberedMfaCopy(useLocale());
  const [state, action, pending] = useActionState(saveRememberedMfaAction, { status: 'idle' } as RememberedMfaResult);
  return <form action={action} className="space-y-5" aria-labelledby="remembered-mfa-title">
    <header className="space-y-2"><h2 id="remembered-mfa-title" className="text-lg font-semibold">{copy.title}</h2><p className="text-sm text-muted-foreground">{copy.description}</p></header>
    <input type="hidden" name="revision" value={state.revision ?? revision}/>
    <label className="block space-y-2"><span className="text-sm font-medium">{copy.days}</span><input name="rememberDays" type="number" inputMode="numeric" required min={0} max={90} step={1} defaultValue={policy.rememberDays} className={`${inputCls} min-h-11 w-32`} aria-describedby="remembered-mfa-help"/></label>
    <p id="remembered-mfa-help" className="text-sm text-muted-foreground">{copy.help}</p><p className="text-sm text-muted-foreground">{copy.effect}</p>
    <div className="flex flex-wrap items-center gap-4"><button type="submit" disabled={pending} className={`${btnPrimary} min-h-11`}>{pending ? copy.saving : copy.save}</button>
      {state.status !== 'idle' && <p role={state.status === 'saved' ? 'status' : 'alert'} className="text-sm">{copy[state.status]}</p>}
    </div>
  </form>;
}
