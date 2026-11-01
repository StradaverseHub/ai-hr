'use client';
import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls, btnPrimary } from '@/components/ui';
import type { PasswordPolicyState } from '@/lib/password-policy';
import { savePasswordPolicyAction, type PasswordPolicyResult } from './password-policy-actions';

export function PasswordPolicyForm({ policy, revision }: PasswordPolicyState) {
  const t = useTranslations('passwordPolicy');
  const [state, action, pending] = useActionState(savePasswordPolicyAction, { status: 'idle' } as PasswordPolicyResult);
  const [enabled, setEnabled] = useState(policy.enabled);
  const [unit, setUnit] = useState(policy.unit);
  return <form action={action} className="space-y-5" aria-labelledby="password-policy-title">
    <div className="space-y-2"><h2 id="password-policy-title" className="text-lg font-semibold">{t('title')}</h2>
      <p id="password-policy-help" className="text-sm leading-relaxed text-muted-foreground">{t('description')}</p></div>
    <input type="hidden" name="revision" value={state.revision ?? revision}/>
    <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
      <input type="checkbox" name="enabled" checked={enabled} onChange={event => setEnabled(event.target.checked)} aria-describedby="password-policy-help"/>{t('enabled')}
    </label>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block space-y-2"><span className="text-sm font-medium">{t('interval')}</span>
        <input name="interval" type="number" required min={1} max={unit === 'months' ? 120 : 3650} step={1} defaultValue={policy.interval} className={`${inputCls} min-h-11 w-full`} aria-describedby="password-policy-limits"/>
      </label>
      <label className="block space-y-2"><span className="text-sm font-medium">{t('unit')}</span>
        <select name="unit" value={unit} onChange={event => setUnit(event.target.value as typeof unit)} className={`${inputCls} min-h-11 w-full`}>
          <option value="days">{t('days')}</option><option value="months">{t('months')}</option>
        </select>
      </label>
    </div>
    <p id="password-policy-limits" className="text-sm text-muted-foreground">{t('limits')}</p>
    <p className="text-sm leading-relaxed text-muted-foreground">{t('reuse')}</p>
    {enabled && <p className="text-sm leading-relaxed text-muted-foreground">{t('effect')}</p>}
    <div className="flex flex-wrap items-center gap-4">
      <button type="submit" disabled={pending} className={`${btnPrimary} min-h-11`}>{t(pending ? 'saving' : 'save')}</button>
      {state.status !== 'idle' && <p role={state.status === 'saved' ? 'status' : 'alert'} className={`text-sm ${state.status === 'saved' ? 'text-foreground' : 'text-destructive'}`}>{t(`result.${state.status}`)}</p>}
    </div>
  </form>;
}
