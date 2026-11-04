'use client';
import {useActionState,useState} from 'react';
import {useTranslations} from 'next-intl';
import {accountAction,type AccountActionState} from './actions';
import {btnGhost,inputCls} from '@/components/ui';
const commands=['temporary-password','reset-email','recovery-exemption','suspend','reactivate','expiry'] as const;
export function AccountControls({userId}:{userId:string}){
 const t=useTranslations('accountManagement');
 return <div className="grid gap-4 lg:grid-cols-2">{commands.map(type=><Control key={type} type={type} userId={userId} title={t(type)}/>)}</div>;
}
function Control({type,userId,title}:{type:typeof commands[number];userId:string;title:string}){
 const t=useTranslations('accountManagement'),[state,action,pending]=useActionState<AccountActionState,FormData>(accountAction,{status:'idle'}),[hiddenPassword,setHiddenPassword]=useState<string|null>(null);
 return <form action={action} className="space-y-3 rounded-lg border border-border p-5">
  <h2 className="font-medium">{title}</h2><input type="hidden" name="type" value={type}/><input type="hidden" name="userId" value={userId}/>
  {type==='temporary-password'&&<label className="block text-sm">{t('password')}<input name="password" type="password" autoComplete="new-password" maxLength={128} className={inputCls}/></label>}
  {type==='temporary-password'&&<label className="block text-sm">{t('confirmPassword')}<input name="confirmPassword" type="password" autoComplete="new-password" maxLength={128} className={inputCls}/></label>}
  {(type==='temporary-password'||type==='recovery-exemption')&&<label className="block text-sm">{t('minutes')}<input type="number" name="minutes" defaultValue={30} min={5} max={type==='recovery-exemption'?60:1440} required className={inputCls}/></label>}
  {type==='recovery-exemption'&&<p className="text-sm text-muted-foreground">{t('exemptionHelp')}</p>}
  {type==='expiry'&&<label className="block text-sm">{t('activeUntil')}<input type="date" name="activeUntil" className={inputCls}/><span className="text-xs text-muted-foreground">{t('expiryHelp')}</span></label>}
  <label className="block text-sm">{t('reason')}<textarea name="reason" minLength={5} maxLength={500} required className={inputCls}/></label>
  <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmed" required className="mt-1"/>{t('confirm')}</label>
  <button type="submit" disabled={pending} className={btnGhost}>{title}</button>
  {state.status!=='idle'&&<p role={state.status==='saved'?'status':'alert'} className="text-sm">{t(state.status)}</p>}
  {state.delivery&&<p role={state.delivery==='sent'?'status':'alert'} className="text-sm">{t(`delivery.${state.delivery}`)}</p>}
  {state.password&&state.password!==hiddenPassword&&<div className="space-y-2 rounded border border-border bg-muted p-3"><p className="text-sm">{t('shownOnce')}</p><code className="block break-all select-all">{state.password}</code><button type="button" className={btnGhost} onClick={()=>setHiddenPassword(state.password??null)}>{t('hide')}</button></div>}
 </form>;
}
