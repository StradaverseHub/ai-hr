'use client';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls, btnPrimary } from '@/components/ui';
import { MAX_IDLE_TIMEOUT_MINUTES, MIN_IDLE_TIMEOUT_MINUTES } from '@/lib/session-policy';
import { saveSessionPolicyAction, type SessionPolicyResult } from './actions';

export function SessionPolicyForm({ idleTimeoutMinutes, revision, canEdit=false }: { idleTimeoutMinutes: number; revision: number; canEdit?:boolean }) {
  const t = useTranslations('sessionTimeout');
  const [state, action, pending] = useActionState(saveSessionPolicyAction, { status: 'idle' } as SessionPolicyResult);
  return <form action={action}>
    <fieldset disabled={!canEdit||pending} className="space-y-6">
    <input type="hidden" name="revision" value={state.revision ?? revision}/>
    <div className="space-y-1">
      <h2 className="text-base font-semibold">{t('settingsTitle')}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{t('settingsDescription')}</p>
    </div>
    <label className="block space-y-2"><span className="text-sm font-medium">{t('minutesLabel')}</span>
      <input name="idleTimeoutMinutes" type="number" inputMode="numeric" required step={1} min={MIN_IDLE_TIMEOUT_MINUTES} max={MAX_IDLE_TIMEOUT_MINUTES}
        defaultValue={idleTimeoutMinutes} aria-describedby="idle-timeout-help" className={`${inputCls} w-32`}/>
    </label>
    <p id="idle-timeout-help" className="text-sm leading-relaxed text-muted-foreground">{t('minutesHelp', { min: MIN_IDLE_TIMEOUT_MINUTES, max: MAX_IDLE_TIMEOUT_MINUTES })}</p>
    <div className="flex flex-wrap items-center gap-4">
      <button type="submit" disabled={pending} className={btnPrimary}>{t(pending ? 'saving' : 'save')}</button>
      {state.status !== 'idle' && <p role={state.status === 'saved' ? 'status' : 'alert'} className={`text-sm ${state.status === 'saved' ? 'text-foreground' : 'text-destructive'}`}>{t(`result.${state.status}`)}</p>}
    </div>
    </fieldset>
  </form>;
}
