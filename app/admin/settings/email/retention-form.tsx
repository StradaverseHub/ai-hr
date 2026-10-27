'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import type {AccountEmailRetention} from '@/core/account-email-retention';
import {EmailSubmit} from './submit-button';
import {saveEmailRetention} from './actions';

export function EmailRetentionForm({policy}:{policy:AccountEmailRetention}){
 const t=useTranslations('accountEmail'),[mode,setMode]=useState(policy.days===null?'never':'days');
 return <form action={saveEmailRetention} className="space-y-4">
  <input type="hidden" name="retentionRevision" value={policy.revision}/>
  <div className="flex flex-wrap items-end gap-4">
   <label className="block space-y-1 text-sm"><span>{t('retentionPeriod')}</span><select name="retentionMode" value={mode} onChange={event=>setMode(event.target.value)} className={inputCls}><option value="never">{t('retentionNever')}</option><option value="days">{t('retentionCustom')}</option></select></label>
   {mode==='days'&&<label className="block space-y-1 text-sm"><span>{t('retentionDays')}</span><input name="retentionDays" type="number" min={1} max={3650} step={1} required defaultValue={policy.days??90} className={`${inputCls} max-w-36`}/></label>}
  </div>
  <p id="retention-scope" className="max-w-prose text-sm text-muted-foreground">{t('retentionHelp')}</p>
  {mode==='days'&&<label className="flex max-w-prose items-start gap-2 text-sm"><input type="checkbox" name="retentionAcknowledged" value="true" required aria-describedby="retention-scope" className="mt-1"/>{t('retentionAcknowledge')}</label>}
  <EmailSubmit type="submit">{t('retentionSave')}</EmailSubmit>
 </form>;
}
