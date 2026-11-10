'use client';
import { ActionButton } from '@/components/ui/action-button';
import {useActionState} from 'react';
import {useTranslations} from 'next-intl';
import {accountAction,type AccountActionState} from './actions';
import {btnGhost,inputCls} from '@/components/ui';
/** The Edit controls already built (board 07c98c36): reset email, deactivate/reactivate and Account Active Until.
 * Temporary passwords and the authenticator pause live in the row dialogs (account-dialogs.tsx). */
export const editCommands=['reset-email','suspend','reactivate','expiry'] as const;
export type EditCommand=typeof editCommands[number];
export function AccountControls({userId,allowed=editCommands}:{userId:string;allowed?:readonly string[]}){
 const t=useTranslations('accountManagement'),shown=editCommands.filter(type=>allowed.includes(type));
 return <div className="grid gap-4 lg:grid-cols-2">{shown.map(type=><Control key={type} type={type} userId={userId} title={t(type)}/>)}</div>;
}
function Control({type,userId,title}:{type:EditCommand;userId:string;title:string}){
 const t=useTranslations('accountManagement'),[state,action,pending]=useActionState<AccountActionState,FormData>(accountAction,{status:'idle'});
 return <form action={action} className="space-y-3 rounded-lg border border-border bg-background p-5">
  <h2 className="font-medium">{title}</h2><input type="hidden" name="type" value={type}/><input type="hidden" name="userId" value={userId}/>
  {type==='expiry'&&<label className="block text-sm">{t('activeUntil')}<input type="date" name="activeUntil" className={inputCls}/><span className="text-xs text-muted-foreground">{t('expiryHelp')}</span></label>}
  <label className="block text-sm">{t('reason')}<textarea name="reason" minLength={5} maxLength={500} required className={`${inputCls} min-h-20`}/></label>
  <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmed" required className="mt-1"/>{t('confirm')}</label>
  <ActionButton aria-busy={pending} type="submit" disabled={pending} className={`${btnGhost.replace('h-9','min-h-11')} max-w-full whitespace-normal`}>{title}</ActionButton>
  {state.status!=='idle'&&<p role={state.status==='saved'?'status':'alert'} className="text-sm">{t(state.status)}</p>}
  {state.delivery&&<p role={state.delivery==='sent'?'status':'alert'} className="text-sm">{t(`delivery.${state.delivery}`)}</p>}
 </form>;
}
