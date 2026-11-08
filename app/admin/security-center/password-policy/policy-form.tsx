'use client';
import { ActionButton } from '@/components/ui/action-button';
import {useActionState,useState} from 'react';
import {useTranslations} from 'next-intl';
import {NEW_PASSWORD_REQUIREMENTS,LEGACY_PASSWORD_REQUIREMENTS,type PasswordPolicyState} from '@/lib/password-policy';
import {inputCls,btnPrimary} from '@/components/ui';
import {saveFullPasswordPolicy} from './actions';
import type {PasswordPolicyResult} from '@/app/admin/settings/login/password-policy-actions';
export function PasswordPolicyForm({policy,revision}:PasswordPolicyState){
 const t=useTranslations('passwordPolicy'),initial=policy.requirements??(revision===0?NEW_PASSWORD_REQUIREMENTS:LEGACY_PASSWORD_REQUIREMENTS);
 const [values,setValues]=useState(initial),[expiry,setExpiry]=useState(policy.enabled),[unit,setUnit]=useState(policy.unit);
 const [state,action,pending]=useActionState(saveFullPasswordPolicy,{status:'idle'} as PasswordPolicyResult);
 const numeric=(name:'minLength'|'maxLength'|'historyCount'|'failedAttempts'|'unlockMinutes',min:number,max:number,visible=true)=><label className={visible?'block space-y-2':'hidden'}><span>{t(`full.${name}`)}</span><input className={inputCls} name={name} type="number" required min={min} max={max} step={1} value={values[name]} onChange={event=>setValues({...values,[name]:Number(event.target.value)})}/></label>;
 const toggle=(name:'uppercase'|'lowercase'|'numbers'|'special'|'historyEnabled'|'lockoutEnabled'|'autoUnlock'|'forceFirstChange'|'firstResetVerification')=><label className="flex min-h-11 items-center gap-3"><input type="checkbox" name={name} checked={values[name]} disabled={name==='autoUnlock'&&!values.lockoutEnabled} onChange={event=>setValues({...values,[name]:event.target.checked,...(name==='lockoutEnabled'&&!event.target.checked?{autoUnlock:false}:{})})}/>{t(`full.${name}`)}</label>;
 return <form action={action} className="space-y-6">
  <input type="hidden" name="revision" value={state.revision??revision}/>
  {!policy.requirements&&<p className="text-sm text-muted-foreground">{t('full.legacy')}</p>}
  <fieldset disabled={pending} className="space-y-6"><div className="grid gap-4 sm:grid-cols-2">{numeric('minLength',1,128)}{numeric('maxLength',1,128)}</div>
   <div className="grid gap-6 lg:grid-cols-2"><section className="space-y-2"><h2 className="font-semibold">{t('full.complexity')}</h2>{toggle('uppercase')}{toggle('lowercase')}{toggle('numbers')}{toggle('special')}
    <label className="flex min-h-11 items-center gap-3"><input type="checkbox" name="enabled" checked={expiry} onChange={event=>setExpiry(event.target.checked)}/>{t('full.expiry')}</label>
    <div className={expiry?'grid gap-4 sm:grid-cols-2':'hidden'}><label className="space-y-2"><span>{t('interval')}</span><input className={inputCls} name="interval" type="number" min={1} max={unit==='months'?120:3650} step={1} required defaultValue={policy.interval}/></label><label className="space-y-2"><span>{t('unit')}</span><select className={inputCls} name="unit" value={unit} onChange={event=>setUnit(event.target.value as 'days'|'months')}><option value="days">{t('days')}</option><option value="months">{t('months')}</option></select></label></div>
    {toggle('historyEnabled')}{numeric('historyCount',1,100,values.historyEnabled)}</section>
    <section className="space-y-2"><h2 className="font-semibold">{t('full.account')}</h2>{toggle('lockoutEnabled')}{numeric('failedAttempts',1,100,values.lockoutEnabled)}{toggle('autoUnlock')}{numeric('unlockMinutes',1,10080,values.lockoutEnabled&&values.autoUnlock)}
     {values.lockoutEnabled&&!values.autoUnlock&&<p className="text-sm text-muted-foreground">{t('full.manualUnlock')}</p>}
     <h2 className="pt-4 font-semibold">{t('full.firstLogin')}</h2>{toggle('forceFirstChange')}{toggle('firstResetVerification')}<p className="text-sm leading-relaxed text-muted-foreground">{t('full.mfa')}</p>
    </section></div>
  </fieldset><p className="text-sm text-muted-foreground">{t('full.effect')}</p>
  <ActionButton aria-busy={pending} className={btnPrimary} disabled={pending} type="submit">{t(pending?'saving':'save')}</ActionButton>
  {state.status!=='idle'&&<p role={state.status==='saved'?'status':'alert'} className="text-sm">{t(`result.${state.status}`)}</p>}
 </form>;
}
